openwrangler_r_frame_contract <- local({
  contract_version <- 1L
  maximum_rows <- .Machine$integer.max
  maximum_columns <- 2048L
  maximum_page_rows <- 1000L
  maximum_page_columns <- 256L
  maximum_page_cells <- 100000L
  maximum_sort_rules <- 64L
  maximum_factor_levels <- 100000L
  maximum_text_bytes <- 8192L
  maximum_name_bytes <- 1024L
  maximum_payload_bytes <- 16L * 1024L * 1024L
  metadata_base_bytes <- 1024L
  column_fixed_bytes <- 512L
  page_base_bytes <- 1024L
  row_fixed_bytes <- 96L
  cell_fixed_bytes <- 96L

  abort <- function(code, message) {
    condition <- structure(
      list(message = message, call = NULL, code = code),
      class = c("openwrangler_r_frame_error", "error", "condition")
    )
    stop(condition)
  }

  json_array <- function(value) {
    I(unname(value))
  }

  new_payload_budget <- function(used = 0) {
    budget <- new.env(parent = emptyenv())
    budget$used <- as.double(used)
    budget
  }

  spend_payload_budget <- function(budget, bytes, label) {
    next_used <- budget$used + as.double(bytes)
    if (!is.finite(next_used) || next_used > maximum_payload_bytes) {
      abort("payload-too-large", sprintf("%s exceeds the %d-byte encoded payload budget", label, maximum_payload_bytes))
    }
    budget$used <- next_used
  }

  json_string_bytes <- function(value) {
    bytes <- as.integer(charToRaw(value))
    html_slash <- logical(length(bytes))
    if (length(bytes) > 1L) {
      html_slash[-1L] <- bytes[-1L] == 47L & bytes[-length(bytes)] == 60L
    }
    escaped <- sum(ifelse(
      bytes %in% c(8L, 9L, 10L, 12L, 13L, 34L, 92L) | html_slash,
      2L,
      ifelse(bytes < 32L, 6L, 1L)
    ))
    as.double(escaped + 2L)
  }

  spend_json_string <- function(budget, value, label, copies = 1L) {
    spend_payload_budget(budget, json_string_bytes(value) * copies, label)
  }

  bounded_utf8 <- function(value, label, maximum_bytes = maximum_text_bytes) {
    if (!is.character(value) || length(value) != 1L || is.na(value)) {
      abort("invalid-text", sprintf("%s must be one non-missing string", label))
    }
    encoding <- Encoding(value)
    if (identical(encoding, "bytes")) {
      abort("invalid-text", sprintf("%s uses the bytes encoding", label))
    }
    source_encoding <- if (identical(encoding, "latin1")) "latin1" else "UTF-8"
    converted <- iconv(value, from = source_encoding, to = "UTF-8", sub = NA_character_)
    if (is.na(converted)) {
      abort("invalid-text", sprintf("%s is not valid UTF-8", label))
    }
    if (nchar(converted, type = "bytes") > maximum_bytes) {
      abort("text-too-large", sprintf("%s exceeds %d UTF-8 bytes", label, maximum_bytes))
    }
    converted
  }

  bounded_text_array <- function(values, label, maximum_bytes = maximum_text_bytes, budget = NULL) {
    if (!is.character(values)) {
      abort("invalid-text", sprintf("%s must be a character vector", label))
    }
    converted <- vapply(seq_along(values), function(index) {
      item_label <- sprintf("%s[%d]", label, index)
      item <- bounded_utf8(values[[index]], item_label, maximum_bytes)
      if (!is.null(budget)) {
        spend_json_string(budget, item, item_label)
        spend_payload_budget(budget, 1L, label)
      }
      item
    }, character(1L), USE.NAMES = FALSE)
    json_array(converted)
  }

  assert_attributes <- function(column, allowed, label) {
    attribute_names <- names(attributes(column)) %||% character()
    if (anyNA(attribute_names) || any(attribute_names == "") || anyDuplicated(attribute_names)) {
      abort("unsupported-column-attributes", sprintf("%s has malformed attribute names", label))
    }
    extras <- setdiff(attribute_names, allowed)
    if (length(extras) != 0L) {
      abort(
        "unsupported-column-attributes",
        sprintf("%s has unsupported attributes: %s", label, paste(extras, collapse = ", "))
      )
    }
  }

  `%||%` <- function(value, fallback) {
    if (is.null(value)) fallback else value
  }

  assert_frame_attributes <- function(value, flavor) {
    allowed <- c("names", "row.names", "class")
    if (flavor == "r.data.table") {
      allowed <- c(allowed, ".internal.selfref", "sorted")
    }
    attribute_names <- names(attributes(value)) %||% character()
    if (anyNA(attribute_names) || any(attribute_names == "") || anyDuplicated(attribute_names)) {
      abort("unsupported-frame-attributes", "the dataframe has malformed attribute names")
    }
    extras <- setdiff(attribute_names, allowed)
    if (length(extras) != 0L) {
      abort(
        "unsupported-frame-attributes",
        sprintf("the dataframe has unsupported attributes: %s", paste(extras, collapse = ", "))
      )
    }
    if (flavor == "r.data.table") {
      self_reference <- attr(value, ".internal.selfref", exact = TRUE)
      if (!is.null(self_reference) && typeof(self_reference) != "externalptr") {
        abort("unsupported-frame-attributes", "the data.table has an invalid internal self-reference")
      }
      sorted <- attr(value, "sorted", exact = TRUE)
      if (
        !is.null(sorted) &&
          (!is.character(sorted) || anyNA(sorted) || any(sorted == "") || anyDuplicated(sorted))
      ) {
        abort("unsupported-frame-attributes", "the data.table has invalid key metadata")
      }
    }
  }

  whole_number <- function(value, label, maximum) {
    if (
      length(value) != 1L ||
        !is.numeric(value) ||
        is.na(value) ||
        !is.finite(value) ||
        value < 0 ||
        value > maximum ||
        value != floor(value)
    ) {
      abort("invalid-range", sprintf("%s must be a whole number from 0 through %s", label, format(maximum)))
    }
    as.double(value)
  }

  exact_double <- function(value) {
    sprintf("%.17g", as.double(value))
  }

  display_double <- function(value) {
    format(value, digits = 15L, trim = TRUE, scientific = FALSE, decimal.mark = ".")
  }

  cell_missing <- function() {
    list(kind = "null", raw = NULL, display = "NA", isNull = TRUE, isNaN = FALSE)
  }

  cell_nan <- function() {
    list(kind = "nan", raw = NULL, display = "NaN", isNull = FALSE, isNaN = TRUE)
  }

  cell_infinity <- function(value) {
    list(
      kind = "infinity",
      raw = NULL,
      display = if (value < 0) "-Inf" else "Inf",
      isNull = FALSE,
      isNaN = FALSE,
      sign = if (value < 0) -1L else 1L
    )
  }

  ordinary_cell <- function(kind, raw, display) {
    list(kind = kind, raw = raw, display = display, isNull = FALSE, isNaN = FALSE)
  }

  column_semantics <- function(column, label, budget) {
    if (is.matrix(column) || is.array(column)) {
      abort("unsupported-column", sprintf("%s is a matrix or array column", label))
    }
    if (is.list(column)) {
      abort("unsupported-column", sprintf("%s is a list column", label))
    }
    if (is.raw(column) || is.complex(column)) {
      abort("unsupported-column", sprintf("%s uses an unsupported atomic type", label))
    }

    classes <- class(column)
    common <- function(kind, storage_mode, expected_classes) {
      if (!identical(classes, expected_classes)) {
        abort("unsupported-column-class", sprintf("%s has unsupported classes", label))
      }
      if (!identical(typeof(column), storage_mode)) {
        abort("unsupported-column-storage", sprintf("%s has storage incompatible with its classes", label))
      }
      list(
        kind = kind,
        storageMode = storage_mode,
        classes = bounded_text_array(classes, paste0(label, ".classes"), budget = budget)
      )
    }

    if (inherits(column, "integer64")) {
      assert_attributes(column, "class", label)
      return(common("integer64", "double", "integer64"))
    }
    if (inherits(column, "Date")) {
      assert_attributes(column, "class", label)
      return(common("date", "double", "Date"))
    }
    if (inherits(column, "POSIXct")) {
      assert_attributes(column, c("class", "tzone"), label)
      semantics <- common("datetime", "double", c("POSIXct", "POSIXt"))
      timezone <- attr(column, "tzone", exact = TRUE)
      if (!is.null(timezone)) {
        if (!is.character(timezone) || length(timezone) != 1L || is.na(timezone)) {
          abort("unsupported-timezone", sprintf("%s has an unsupported tzone attribute", label))
        }
        timezone <- bounded_utf8(timezone, paste0(label, ".timezone"), maximum_name_bytes)
      }
      semantics["timezone"] <- list(timezone)
      return(semantics)
    }
    if (inherits(column, "difftime")) {
      assert_attributes(column, c("class", "units"), label)
      semantics <- common("difftime", "double", "difftime")
      units <- attr(column, "units", exact = TRUE)
      allowed_units <- c("secs", "mins", "hours", "days", "weeks")
      if (!is.character(units) || length(units) != 1L || !units %in% allowed_units) {
        abort("unsupported-duration-units", sprintf("%s has unsupported difftime units", label))
      }
      semantics$units <- units
      return(semantics)
    }
    if (is.factor(column)) {
      assert_attributes(column, c("levels", "class"), label)
      ordered <- is.ordered(column)
      expected_classes <- if (ordered) c("ordered", "factor") else "factor"
      semantics <- common("factor", "integer", expected_classes)
      levels <- levels(column)
      if (anyDuplicated(levels)) {
        abort("invalid-factor", sprintf("%s has duplicate factor levels", label))
      }
      if (length(levels) > maximum_factor_levels) {
        abort(
          "factor-levels-too-large",
          sprintf("%s has more than %d factor levels", label, maximum_factor_levels)
        )
      }
      semantics$levels <- bounded_text_array(levels, paste0(label, ".levels"), budget = budget)
      semantics$ordered <- ordered
      codes <- unclass(column)
      if (any(!is.na(codes) & (codes < 1L | codes > length(levels)))) {
        abort("invalid-factor", sprintf("%s contains an invalid factor code", label))
      }
      return(semantics)
    }
    if (is.logical(column)) {
      assert_attributes(column, character(), label)
      return(common("logical", "logical", "logical"))
    }
    if (is.integer(column)) {
      assert_attributes(column, character(), label)
      return(common("integer", "integer", "integer"))
    }
    if (is.double(column)) {
      assert_attributes(column, character(), label)
      return(common("double", "double", "numeric"))
    }
    if (is.character(column)) {
      assert_attributes(column, character(), label)
      return(common("character", "character", "character"))
    }
    abort("unsupported-column", sprintf("%s has an unsupported R type", label))
  }

  public_column_type <- function(kind) {
    switch(
      kind,
      logical = "boolean",
      integer = "integer",
      double = "float",
      character = "string",
      factor = "string",
      date = "date",
      datetime = "datetime",
      difftime = "duration",
      integer64 = "integer",
      abort("internal-error", "unknown R column kind")
    )
  }

  raw_column_type <- function(semantics) {
    switch(
      semantics$kind,
      logical = "logical",
      integer = "integer",
      double = "double",
      character = "character",
      factor = if (semantics$ordered) "ordered factor" else "factor",
      date = "Date",
      datetime = "POSIXct",
      difftime = "difftime",
      integer64 = "integer64",
      abort("internal-error", "unknown R column kind")
    )
  }

  encode_value <- function(column, semantics, index, label, budget) {
    spend_payload_budget(budget, cell_fixed_bytes, label)
    value <- column[index]
    kind <- semantics$kind

    if (kind %in% c("date", "datetime", "difftime")) {
      numeric_value <- as.double(value)
      if (is.nan(numeric_value)) {
        abort("unsupported-cell", sprintf("%s is a classed NaN", label))
      }
      if (is.na(numeric_value)) return(cell_missing())
      if (!is.finite(numeric_value)) {
        abort("unsupported-cell", sprintf("%s is not finite", label))
      }
      if (kind == "date" && numeric_value != floor(numeric_value)) {
        abort("unsupported-cell", sprintf("%s is a fractional Date", label))
      }
    }
    if (kind == "double" && is.nan(value)) return(cell_nan())
    if (is.na(value)) return(cell_missing())
    if (kind == "double" && is.infinite(value)) return(cell_infinity(value))

    if (kind == "logical") {
      return(ordinary_cell("boolean", isTRUE(value), if (isTRUE(value)) "TRUE" else "FALSE"))
    }
    if (kind == "integer") {
      exact <- as.character(value)
      spend_json_string(budget, exact, label, copies = 2L)
      return(ordinary_cell("integer", exact, exact))
    }
    if (kind == "integer64") {
      exact <- as.character(value)
      spend_json_string(budget, exact, label, copies = 2L)
      return(ordinary_cell("integer", exact, exact))
    }
    if (kind == "double") {
      exact <- exact_double(value)
      display <- display_double(value)
      spend_json_string(budget, exact, label)
      spend_json_string(budget, display, label)
      return(ordinary_cell("number", exact, display))
    }
    if (kind == "character") {
      text <- bounded_utf8(value, label)
      spend_json_string(budget, text, label, copies = 2L)
      return(ordinary_cell("string", text, text))
    }
    if (kind == "factor") {
      text <- bounded_utf8(as.character(value), label)
      spend_json_string(budget, text, label, copies = 2L)
      return(ordinary_cell("string", text, text))
    }
    if (kind == "date") {
      text <- format(value, format = "%Y-%m-%d")
      if (!grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", text)) {
        abort("unsupported-cell", sprintf("%s is outside the supported ISO date range", label))
      }
      spend_json_string(budget, text, label, copies = 2L)
      return(ordinary_cell("date", text, text))
    }
    if (kind == "datetime") {
      exact <- exact_double(unclass(value))
      display_timezone <- semantics$timezone
      if (is.null(display_timezone) || identical(display_timezone, "")) display_timezone <- "UTC"
      display <- format(value, tz = display_timezone, format = "%Y-%m-%dT%H:%M:%OS6", usetz = FALSE)
      display <- bounded_utf8(display, label)
      spend_json_string(budget, exact, label)
      spend_json_string(budget, display, label)
      return(ordinary_cell("datetime", exact, display))
    }
    if (kind == "difftime") {
      exact <- exact_double(as.double(value, units = semantics$units))
      display <- paste(exact, semantics$units)
      spend_json_string(budget, exact, label)
      spend_json_string(budget, display, label)
      return(ordinary_cell("duration", exact, display))
    }
    abort("internal-error", "unknown R column kind")
  }

  frame_flavor <- function(value) {
    classes <- class(value)
    if (inherits(value, "grouped_df") || inherits(value, "rowwise_df")) {
      abort("unsupported-frame-class", "grouped and rowwise tibbles are not yet supported")
    }
    if (inherits(value, "data.table")) {
      if (!identical(classes, c("data.table", "data.frame"))) {
        abort("unsupported-frame-class", "the data.table has unsupported subclasses")
      }
      return("r.data.table")
    }
    if (inherits(value, "tbl_df")) {
      if (!identical(classes, c("tbl_df", "tbl", "data.frame"))) {
        abort("unsupported-frame-class", "the tibble has unsupported subclasses")
      }
      return("r.tibble")
    }
    if (identical(classes, "data.frame")) return("r.data.frame")
    abort("unsupported-frame-class", "the value must be a base data.frame, tibble, or data.table")
  }

  isolated_snapshot <- function(value, flavor) {
    if (flavor == "r.data.table") {
      if (!requireNamespace("data.table", quietly = TRUE)) {
        abort("missing-package", "data.table is required to copy a data.table")
      }
      return(data.table::copy(value))
    }
    unserialize(serialize(value, NULL, version = 3L))
  }

  key_column_ids <- function(snapshot, flavor, names, budget) {
    if (flavor != "r.data.table") return(json_array(character()))
    keys <- data.table::key(snapshot) %||% character()
    ids <- vapply(keys, function(key) {
      positions <- which(names == key)
      if (length(positions) != 1L) {
        abort("invalid-data-table-key", "a data.table key does not identify exactly one column")
      }
      sprintf("r:c:%d", positions[[1L]] - 1L)
    }, character(1L), USE.NAMES = FALSE)
    for (index in seq_along(ids)) {
      spend_json_string(budget, ids[[index]], sprintf("key column %d", index))
      spend_payload_budget(budget, 1L, "data.table key metadata")
    }
    json_array(ids)
  }

  exact_named_list <- function(value, fields, label) {
    if (!is.list(value) || is.object(value)) {
      abort("invalid-view-query", sprintf("%s must be a plain named list", label))
    }
    attribute_names <- names(attributes(value)) %||% character()
    if (!identical(attribute_names, "names")) {
      abort("invalid-view-query", sprintf("%s has unsupported attributes", label))
    }
    field_names <- names(value)
    if (
      length(field_names) != length(fields) ||
        anyNA(field_names) ||
        any(field_names == "") ||
        anyDuplicated(field_names) ||
        !setequal(field_names, fields)
    ) {
      abort("invalid-view-query", sprintf("%s has missing or unknown fields", label))
    }
    value
  }

  scalar_choice <- function(value, choices, label) {
    if (!is.character(value) || length(value) != 1L || is.na(value) || !value %in% choices) {
      abort("invalid-view-query", sprintf("%s must be one of: %s", label, paste(choices, collapse = ", ")))
    }
    value
  }

  resolve_sort_rules <- function(sort_rules, descriptor) {
    maximum_rules_for_frame <- min(maximum_sort_rules, descriptor$shape$columns)
    if (
      !is.list(sort_rules) ||
        is.object(sort_rules) ||
        !is.null(attributes(sort_rules)) ||
        length(sort_rules) > maximum_rules_for_frame
    ) {
      abort(
        "invalid-view-query",
        sprintf("sort_rules must be an unnamed list of no more than %d rules", maximum_rules_for_frame)
      )
    }

    resolved <- lapply(seq_along(sort_rules), function(index) {
      label <- sprintf("sort_rules[[%d]]", index)
      rule <- exact_named_list(sort_rules[[index]], c("column", "direction", "nulls"), label)
      reference <- exact_named_list(rule$column, c("id", "name"), paste0(label, "$column"))
      column_id <- bounded_utf8(reference$id, paste0(label, "$column$id"), maximum_name_bytes)
      column_name <- bounded_utf8(reference$name, paste0(label, "$column$name"), maximum_name_bytes)
      schema_ids <- vapply(descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
      position <- match(column_id, schema_ids)
      if (is.na(position) || !identical(descriptor$schema[[position]]$name, column_name)) {
        abort("stale-column", sprintf("%s does not match the captured schema", paste0(label, "$column")))
      }
      list(
        position = position,
        columnId = column_id,
        direction = scalar_choice(rule$direction, c("asc", "desc"), paste0(label, "$direction")),
        nulls = scalar_choice(rule$nulls, c("first", "last"), paste0(label, "$nulls"))
      )
    })
    column_ids <- vapply(resolved, `[[`, character(1L), "columnId", USE.NAMES = FALSE)
    if (anyDuplicated(column_ids)) {
      abort("invalid-view-query", "sort_rules may address each column only once")
    }
    resolved
  }

  order_integer64 <- function(values, decreasing) {
    text <- as.character(values)
    negative <- startsWith(text, "-")
    digits <- ifelse(negative, substring(text, 2L), text)
    negative_positions <- which(negative)
    nonnegative_positions <- which(!negative)

    order_group <- function(positions, reverse_magnitude) {
      if (length(positions) == 0L) return(integer())
      positions[base::order(
        nchar(digits[positions], type = "bytes"),
        digits[positions],
        decreasing = reverse_magnitude,
        method = "radix"
      )]
    }

    if (decreasing) {
      c(order_group(nonnegative_positions, TRUE), order_group(negative_positions, FALSE))
    } else {
      c(order_group(negative_positions, TRUE), order_group(nonnegative_positions, FALSE))
    }
  }

  order_present_values <- function(values, semantics, decreasing) {
    if (semantics$kind == "integer64") return(order_integer64(values, decreasing))
    base::order(values, decreasing = decreasing, method = "radix", na.last = NA)
  }

  sorted_row_positions <- function(capture, sort_rules) {
    descriptor <- capture$descriptor
    resolved <- resolve_sort_rules(sort_rules, descriptor)
    row_positions <- seq_len(descriptor$shape$rows)
    if (length(resolved) == 0L || length(row_positions) == 0L) return(row_positions)

    for (rule_index in rev(seq_along(resolved))) {
      rule <- resolved[[rule_index]]
      column <- capture$snapshot[[rule$position]][row_positions]
      missing <- is.na(column)
      missing_positions <- row_positions[missing]
      present_positions <- which(!missing)
      present_order <- order_present_values(
        column[present_positions],
        descriptor$schema[[rule$position]]$semantics,
        identical(rule$direction, "desc")
      )
      ordered_present <- row_positions[present_positions[present_order]]
      row_positions <- if (identical(rule$nulls, "first")) {
        c(missing_positions, ordered_present)
      } else {
        c(ordered_present, missing_positions)
      }
    }
    row_positions
  }

  capture_frame <- function(value) {
    if (!is.data.frame(value)) {
      abort("unsupported-frame", "the value is not an R dataframe")
    }
    flavor <- frame_flavor(value)
    assert_frame_attributes(value, flavor)
    row_count <- nrow(value)
    column_count <- ncol(value)
    whole_number(row_count, "row count", maximum_rows)
    whole_number(column_count, "column count", maximum_columns)
    snapshot <- isolated_snapshot(value, flavor)
    metadata_budget <- new_payload_budget()
    spend_payload_budget(metadata_budget, metadata_base_bytes, "R frame metadata")
    column_names <- names(snapshot)
    if (!is.character(column_names) || length(column_names) != column_count) {
      abort("invalid-schema", "the dataframe does not have one name per column")
    }
    column_names <- vapply(
      seq_along(column_names),
      function(index) bounded_utf8(column_names[[index]], sprintf("column name %d", index), maximum_name_bytes),
      character(1L),
      USE.NAMES = FALSE
    )
    for (index in seq_along(column_names)) {
      spend_json_string(metadata_budget, column_names[[index]], sprintf("column name %d", index))
    }

    schema <- lapply(seq_len(column_count), function(index) {
      spend_payload_budget(metadata_budget, column_fixed_bytes, sprintf("column %d metadata", index))
      semantics <- column_semantics(snapshot[[index]], sprintf("column %d", index), metadata_budget)
      list(
        id = sprintf("r:c:%d", index - 1L),
        name = column_names[[index]],
        position = index - 1L,
        rawType = raw_column_type(semantics),
        type = public_column_type(semantics$kind),
        nullable = anyNA(snapshot[[index]]),
        semantics = semantics
      )
    })

    descriptor <- list(
      contractVersion = contract_version,
      dataframeFlavor = flavor,
      shape = list(rows = row_count, columns = column_count),
      frameSemantics = list(
        classes = bounded_text_array(class(snapshot), "frame classes", maximum_name_bytes, metadata_budget),
        rowNames = "positional",
        keyColumnIds = key_column_ids(snapshot, flavor, column_names, metadata_budget)
      ),
      schema = json_array(schema)
    )
    capture <- new.env(parent = emptyenv())
    capture$snapshot <- snapshot
    capture$descriptor <- descriptor
    capture$metadataBytes <- metadata_budget$used
    class(capture) <- "openwrangler_r_frame_capture"
    lockEnvironment(capture, bindings = TRUE)
    capture
  }

  materialize_rows <- function(
    capture,
    row_order,
    row_offset = 0L,
    row_limit = 100L,
    column_offset = 0L,
    column_limit = 100L
  ) {
    if (
      !inherits(capture, "openwrangler_r_frame_capture") ||
        !is.environment(capture) ||
        !environmentIsLocked(capture)
    ) {
      abort("invalid-capture", "capture must come from capture_frame")
    }
    snapshot <- capture$snapshot
    descriptor <- capture$descriptor
    total_rows <- descriptor$shape$rows
    total_columns <- descriptor$shape$columns
    row_offset <- whole_number(row_offset, "row_offset", total_rows)
    row_limit <- whole_number(row_limit, "row_limit", maximum_page_rows)
    column_offset <- whole_number(column_offset, "column_offset", total_columns)
    column_limit <- whole_number(column_limit, "column_limit", maximum_page_columns)

    row_count <- min(row_limit, total_rows - row_offset)
    column_count <- min(column_limit, total_columns - column_offset)
    if (row_count * column_count > maximum_page_cells) {
      abort("page-too-large", sprintf("a page may contain at most %d cells", maximum_page_cells))
    }
    logical_rows <- if (row_count == 0L) integer() else seq.int(row_offset + 1L, length.out = row_count)
    row_positions <- row_order[logical_rows]
    column_positions <- if (column_count == 0L) integer() else seq.int(column_offset + 1L, length.out = column_count)
    selected_schema <- descriptor$schema[column_positions]
    column_ids <- vapply(selected_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    page_budget <- new_payload_budget(capture$metadataBytes)
    spend_payload_budget(page_budget, page_base_bytes, "R frame page")
    for (index in seq_along(column_ids)) {
      spend_json_string(page_budget, column_ids[[index]], sprintf("page column ID %d", index))
      spend_payload_budget(page_budget, 1L, "R frame page projection")
    }

    rows <- lapply(seq_along(row_positions), function(row_index) {
      source_row <- row_positions[[row_index]]
      spend_payload_budget(page_budget, row_fixed_bytes, sprintf("row %d", source_row))
      values <- lapply(seq_along(column_positions), function(column_index) {
        source_column <- column_positions[[column_index]]
        encode_value(
          snapshot[[source_column]],
          descriptor$schema[[source_column]]$semantics,
          source_row,
          sprintf("cell[%d,%d]", source_row, source_column),
          page_budget
        )
      })
      list(
        id = sprintf("r:r:%d", source_row - 1L),
        rowNumber = source_row - 1L,
        values = json_array(values)
      )
    })

    c(
      descriptor,
      list(page = list(
        offset = row_offset,
        limit = row_limit,
        totalRows = total_rows,
        columnOffset = column_offset,
        columnLimit = column_limit,
        columnIds = json_array(column_ids),
        rows = json_array(rows)
      ))
    )
  }

  materialize_page <- function(
    capture,
    row_offset = 0L,
    row_limit = 100L,
    column_offset = 0L,
    column_limit = 100L
  ) {
    if (
      !inherits(capture, "openwrangler_r_frame_capture") ||
        !is.environment(capture) ||
        !environmentIsLocked(capture)
    ) {
      abort("invalid-capture", "capture must come from capture_frame")
    }
    materialize_rows(
      capture,
      seq_len(capture$descriptor$shape$rows),
      row_offset,
      row_limit,
      column_offset,
      column_limit
    )
  }

  materialize_view_page <- function(
    capture,
    sort_rules = list(),
    row_offset = 0L,
    row_limit = 100L,
    column_offset = 0L,
    column_limit = 100L
  ) {
    if (
      !inherits(capture, "openwrangler_r_frame_capture") ||
        !is.environment(capture) ||
        !environmentIsLocked(capture)
    ) {
      abort("invalid-capture", "capture must come from capture_frame")
    }
    materialize_rows(
      capture,
      sorted_row_positions(capture, sort_rules),
      row_offset,
      row_limit,
      column_offset,
      column_limit
    )
  }

  encode_contract <- function(value) {
    if (!requireNamespace("jsonlite", quietly = TRUE)) {
      abort("missing-package", "jsonlite is required to encode an R frame page")
    }
    payload <- jsonlite::toJSON(
      value,
      auto_unbox = TRUE,
      digits = NA,
      na = "null",
      null = "null",
      pretty = FALSE
    )
    if (nchar(payload, type = "bytes") > maximum_payload_bytes) {
      abort("payload-too-large", sprintf("the encoded page exceeds %d bytes", maximum_payload_bytes))
    }
    enc2utf8(as.character(payload))
  }

  encode_page <- function(...) {
    encode_contract(materialize_page(...))
  }

  encode_view_page <- function(...) {
    encode_contract(materialize_view_page(...))
  }

  list(
    capture_frame = capture_frame,
    materialize_page = materialize_page,
    materialize_view_page = materialize_view_page,
    encode_page = encode_page,
    encode_view_page = encode_view_page,
    limits = list(
      rows = maximum_rows,
      columns = maximum_columns,
      pageRows = maximum_page_rows,
      pageColumns = maximum_page_columns,
      pageCells = maximum_page_cells,
      sortRules = maximum_sort_rules,
      factorLevels = maximum_factor_levels,
      textBytes = maximum_text_bytes,
      nameBytes = maximum_name_bytes,
      payloadBytes = maximum_payload_bytes
    )
  )
})
