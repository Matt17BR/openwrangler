openwrangler_r_frame_contract <- local({
  contract_version <- 5L
  maximum_rows <- .Machine$integer.max
  maximum_columns <- 2048L
  maximum_page_rows <- 1000L
  maximum_page_columns <- 256L
  maximum_page_cells <- 100000L
  maximum_filters <- 64L
  maximum_predicates_per_filter <- 64L
  maximum_selected_values_per_filter <- 10000L
  maximum_sort_rules <- 64L
  maximum_fill_fallback_columns <- 64L
  maximum_fill_directional_gap <- 1000000L
  maximum_profile_columns <- 64L
  maximum_profile_rows <- 1000000L
  maximum_profile_cells <- 5000000L
  maximum_dataset_profile_cells <- 5000000L
  maximum_top_values <- 10L
  maximum_histogram_bins <- 20L
  maximum_cached_sort_columns <- 4L
  maximum_sort_cache_bytes <- 32L * 1024L * 1024L
  maximum_factor_levels <- 100000L
  maximum_text_bytes <- 8192L
  default_strip_characters <- paste0(
    " \t\n\r\v\f",
    "\u001c\u001d\u001e\u001f",
    "\u0085\u00a0\u1680",
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a",
    "\u2028\u2029\u202f\u205f\u3000"
  )
  maximum_name_bytes <- 1024L
  maximum_step_id_bytes <- 1024L
  maximum_column_id_bytes <- 2048L
  maximum_payload_bytes <- 16L * 1024L * 1024L
  private_row_id_prefix <- "__open_wrangler_internal_row_id_"
  metadata_base_bytes <- 1024L
  column_fixed_bytes <- 512L
  page_base_bytes <- 1024L
  row_fixed_bytes <- 96L
  cell_fixed_bytes <- 96L
  summary_fixed_bytes <- 1024L
  minimum_nanoparquet_version <- "0.5.1"

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

  bounded_operation_output <- function(value, operation_name) {
    if (!is.character(value) || length(value) != 1L || is.na(value)) {
      abort("internal-error", sprintf("%s returned an invalid R text result", operation_name))
    }
    encoding <- Encoding(value)
    if (identical(encoding, "bytes")) {
      abort("invalid-view-query", sprintf("%s produced invalid UTF-8 text", operation_name))
    }
    source_encoding <- if (identical(encoding, "latin1")) "latin1" else "UTF-8"
    converted <- iconv(value, from = source_encoding, to = "UTF-8", sub = NA_character_)
    if (is.na(converted)) {
      abort("invalid-view-query", sprintf("%s produced invalid UTF-8 text", operation_name))
    }
    if (nchar(converted, type = "bytes") > maximum_text_bytes) {
      abort(
        "operation-output-too-large",
        sprintf("%s would produce text longer than %d UTF-8 bytes", operation_name, maximum_text_bytes)
      )
    }
    converted
  }

  is_canonical_column_id <- function(value) {
    source_match <- regexec("^r:c:(0|[1-9][0-9]*)$", value, perl = TRUE)
    source_parts <- regmatches(value, source_match)[[1L]]
    if (length(source_parts) != 0L) {
      ordinal <- suppressWarnings(as.double(source_parts[[2L]]))
      return(is.finite(ordinal) && ordinal < maximum_columns)
    }

    derived_match <- regexec(
      "^c:step:([^\\x00]+):(0|[1-9][0-9]*)$",
      value,
      perl = TRUE
    )
    derived_parts <- regmatches(value, derived_match)[[1L]]
    if (length(derived_parts) == 0L) return(FALSE)
    ordinal <- suppressWarnings(as.double(derived_parts[[3L]]))
    nchar(derived_parts[[2L]], type = "bytes") <= maximum_step_id_bytes &&
      is.finite(ordinal) &&
      ordinal < maximum_columns
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

  signed_whole_number <- function(value, label, maximum) {
    if (
      length(value) != 1L ||
        !is.numeric(value) ||
        is.na(value) ||
        !is.finite(value) ||
        abs(value) > maximum ||
        value != floor(value)
    ) {
      abort("invalid-view-query", sprintf("%s is outside its supported range", label))
    }
    as.double(value)
  }

  exact_double <- function(value) {
    sprintf("%.17g", as.double(value))
  }

  canonical_double_key <- function(value) {
    numeric_value <- as.double(value)
    exact_double(if (!is.na(numeric_value) && numeric_value == 0) 0 else numeric_value)
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

  column_semantics <- function(column, label, budget, validate_values = TRUE) {
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
      if (isTRUE(validate_values)) {
        codes <- unclass(column)
        if (any(!is.na(codes) & (codes < 1L | codes > length(levels)))) {
          abort("invalid-factor", sprintf("%s contains an invalid factor code", label))
        }
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
      code <- unclass(value)
      if (!is.na(code) && (code < 1L || code > length(semantics$levels))) {
        abort("invalid-factor", sprintf("%s contains an invalid factor code", label))
      }
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
      column_id <- bounded_utf8(reference$id, paste0(label, "$column$id"), maximum_column_id_bytes)
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

  exact_named_list_optional <- function(value, required, optional, label) {
    if (!is.list(value) || is.object(value)) {
      abort("invalid-view-query", sprintf("%s must be a plain named list", label))
    }
    attribute_names <- names(attributes(value)) %||% character()
    if (!identical(attribute_names, "names")) {
      abort("invalid-view-query", sprintf("%s has unsupported attributes", label))
    }
    field_names <- names(value)
    if (
      anyNA(field_names) ||
        any(field_names == "") ||
        anyDuplicated(field_names) ||
        !all(required %in% field_names) ||
        any(!field_names %in% c(required, optional))
    ) {
      abort("invalid-view-query", sprintf("%s has missing or unknown fields", label))
    }
    value
  }

  resolve_column_reference <- function(reference, descriptor, label) {
    reference <- exact_named_list(reference, c("id", "name"), label)
    column_id <- bounded_utf8(reference$id, paste0(label, "$id"), maximum_column_id_bytes)
    column_name <- bounded_utf8(reference$name, paste0(label, "$name"), maximum_name_bytes)
    schema_ids <- vapply(descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    position <- match(column_id, schema_ids)
    if (is.na(position) || !identical(descriptor$schema[[position]]$name, column_name)) {
      abort("stale-column", sprintf("%s does not match the captured schema", label))
    }
    list(position = position, columnId = column_id, name = column_name)
  }

  is_private_column_name <- function(value) {
    folded <- chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", value)
    startsWith(folded, private_row_id_prefix)
  }

  predicate_operators <- list(
    string = c(
      "contains", "startsWith", "endsWith", "equals", "notEquals", "gt", "gte", "lt", "lte", "between",
      "isNull", "isNotNull"
    ),
    integer = c("equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"),
    float = c(
      "equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull", "isNaN",
      "isNotNaN"
    ),
    boolean = c("equals", "notEquals", "isNull", "isNotNull"),
    datetime = c("equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"),
    date = c("equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"),
    duration = c("equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull")
  )

  normalize_integer_text <- function(value, label) {
    text <- if (is.character(value) && length(value) == 1L && !is.na(value)) {
      value
    } else if (is.numeric(value) && length(value) == 1L && is.finite(value) && value == floor(value)) {
      format(value, scientific = FALSE, trim = TRUE)
    } else {
      abort("invalid-view-value", sprintf("%s must be a decimal integer", label))
    }
    if (!grepl("^[+-]?[0-9]+$", text, perl = TRUE)) {
      abort("invalid-view-value", sprintf("%s must be a decimal integer", label))
    }
    negative <- startsWith(text, "-")
    digits <- sub("^[+-]", "", text)
    digits <- sub("^0+(?=[0-9])", "", digits, perl = TRUE)
    if (identical(digits, "0")) negative <- FALSE
    paste0(if (negative) "-" else "", digits)
  }

  integer_text_compare <- function(left, right) {
    left_negative <- startsWith(left, "-")
    right_negative <- startsWith(right, "-")
    if (left_negative != right_negative) return(if (left_negative) -1L else 1L)
    left_digits <- if (left_negative) substring(left, 2L) else left
    right_digits <- if (right_negative) substring(right, 2L) else right
    magnitude <- if (nchar(left_digits, type = "bytes") != nchar(right_digits, type = "bytes")) {
      if (nchar(left_digits, type = "bytes") < nchar(right_digits, type = "bytes")) -1L else 1L
    } else if (identical(left_digits, right_digits)) {
      0L
    } else if (left_digits < right_digits) {
      -1L
    } else {
      1L
    }
    if (left_negative) -magnitude else magnitude
  }

  validate_integer64_text <- function(text, label) {
    if (
      integer_text_compare(text, "-9223372036854775808") < 0L ||
        integer_text_compare(text, "9223372036854775807") > 0L
    ) {
      abort("invalid-view-value", sprintf("%s is outside the signed 64-bit range", label))
    }
    text
  }

  parse_finite_number <- function(value, label, allow_infinity = FALSE) {
    text <- if (is.character(value) && length(value) == 1L && !is.na(value)) {
      value
    } else if (is.numeric(value) && length(value) == 1L && !is.na(value)) {
      as.character(value)
    } else {
      abort("invalid-view-value", sprintf("%s must be a decimal number", label))
    }
    if (allow_infinity && grepl("^[+-]?Infinity$", text, perl = TRUE)) {
      return(if (startsWith(text, "-")) -Inf else Inf)
    }
    if (!grepl("^[+-]?(?:(?:[0-9]+(?:\\.[0-9]*)?)|(?:\\.[0-9]+))(?:[eE][+-]?[0-9]+)?$", text, perl = TRUE)) {
      abort("invalid-view-value", sprintf("%s must be a decimal number", label))
    }
    number <- suppressWarnings(as.double(text))
    if (!is.finite(number)) abort("invalid-view-value", sprintf("%s is outside the finite numeric range", label))
    number
  }

  parse_boolean <- function(value, label) {
    if (is.logical(value) && length(value) == 1L && !is.na(value)) return(value)
    if (!is.character(value) || length(value) != 1L || is.na(value)) {
      abort("invalid-view-value", sprintf("%s must be true or false", label))
    }
    normalized <- tolower(trimws(value))
    if (!normalized %in% c("true", "false")) {
      abort("invalid-view-value", sprintf("%s must be true or false", label))
    }
    identical(normalized, "true")
  }

  parse_date_key <- function(value, label) {
    text <- bounded_utf8(as.character(value), label)
    if (!grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", text, perl = TRUE)) {
      abort("invalid-view-value", sprintf("%s must use YYYY-MM-DD", label))
    }
    if (identical(substring(text, 1L, 4L), "0000")) {
      abort("invalid-view-value", sprintf("%s is outside the supported date range", label))
    }
    parsed <- suppressWarnings(as.Date(text, format = "%Y-%m-%d"))
    if (is.na(parsed)) abort("invalid-view-value", sprintf("%s is not a valid date", label))
    exact_double(as.double(parsed))
  }

  parse_datetime_key <- function(value, semantics, label) {
    text <- bounded_utf8(as.character(value), label)
    match <- regexec(
      "^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$",
      text,
      perl = TRUE
    )
    parts <- regmatches(text, match)[[1L]]
    if (length(parts) == 0L) {
      abort("invalid-view-value", sprintf("%s must be an ISO datetime", label))
    }
    if (identical(substring(parts[[2L]], 1L, 4L), "0000")) {
      abort("invalid-view-value", sprintf("%s is outside the supported datetime range", label))
    }
    hours <- as.integer(parts[[3L]])
    minutes <- as.integer(parts[[4L]])
    seconds <- if (identical(parts[[5L]], "")) 0L else as.integer(parts[[5L]])
    zone <- parts[[7L]]
    if (hours > 23L || minutes > 59L || seconds > 59L) {
      abort("invalid-view-value", sprintf("%s has invalid time fields", label))
    }
    has_zone <- !identical(zone, "")
    if (has_zone && !identical(zone, "Z")) {
      zone_digits <- gsub(":", "", substring(zone, 2L), fixed = TRUE)
      if (as.integer(substring(zone_digits, 1L, 2L)) > 23L || as.integer(substring(zone_digits, 3L, 4L)) > 59L) {
        abort("invalid-view-value", sprintf("%s has invalid timezone fields", label))
      }
    }
    timezone <- if (has_zone) "UTC" else (semantics$timezone %||% "UTC")
    if (identical(timezone, "")) timezone <- "UTC"
    fraction <- parts[[6L]]
    normalized_zone <- if (!has_zone) "" else if (identical(zone, "Z")) "+0000" else gsub(":", "", zone, fixed = TRUE)
    normalized <- sprintf(
      "%sT%02d:%02d:%02d%s%s",
      parts[[2L]],
      hours,
      minutes,
      seconds,
      fraction,
      normalized_zone
    )
    format <- if (has_zone) "%Y-%m-%dT%H:%M:%OS%z" else "%Y-%m-%dT%H:%M:%OS"
    parsed <- suppressWarnings(as.POSIXct(strptime(normalized, format = format, tz = timezone)))
    if (length(parsed) != 1L || is.na(parsed)) {
      abort("invalid-view-value", sprintf("%s is not a valid datetime", label))
    }
    if (!has_zone) {
      local <- as.POSIXlt(parsed, tz = timezone)
      expected_seconds <- seconds + if (identical(fraction, "")) 0 else as.double(fraction)
      expected_date <- as.integer(strsplit(parts[[2L]], "-", fixed = TRUE)[[1L]])
      if (
        local$year + 1900L != expected_date[[1L]] ||
          local$mon + 1L != expected_date[[2L]] ||
          local$mday != expected_date[[3L]] ||
          local$hour != hours ||
          local$min != minutes ||
          abs(local$sec - expected_seconds) > 1e-6
      ) {
        abort("invalid-view-value", sprintf("%s is not a valid local datetime in %s", label, timezone))
      }
    }
    exact_double(as.double(parsed))
  }

  duration_microseconds_text <- function(text) {
    negative <- startsWith(text, "-")
    unsigned <- sub("^[+-]", "", text)
    parts <- strsplit(unsigned, ".", fixed = TRUE)[[1L]]
    whole <- if (length(parts) == 0L || identical(parts[[1L]], "")) "0" else parts[[1L]]
    fraction <- if (length(parts) < 2L) "" else parts[[2L]]
    fraction <- paste0(fraction, strrep("0", 6L - nchar(fraction, type = "bytes")))
    digits <- paste0(whole, fraction)
    digits <- sub("^0+(?=[0-9])", "", digits, perl = TRUE)
    if (negative && !identical(digits, "0")) paste0("-", digits) else digits
  }

  validate_duration_microseconds <- function(text, label) {
    microseconds <- duration_microseconds_text(text)
    if (
      integer_text_compare(microseconds, "-86399999913600000000") < 0L ||
        integer_text_compare(microseconds, "86399999999999999999") > 0L
    ) {
      abort("invalid-view-value", sprintf("%s is outside the supported duration range", label))
    }
    invisible(NULL)
  }

  parse_duration_seconds <- function(value, label) {
    text <- bounded_utf8(as.character(value), label)
    if (grepl("^[+-]?(?:[0-9]+(?:\\.[0-9]{0,6})?|\\.[0-9]{1,6})$", text, perl = TRUE)) {
      validate_duration_microseconds(text, label)
      return(parse_finite_number(text, label))
    }
    match <- regexec("^(?:(-?[0-9]+) days?, )?([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]{1,6}))?$", text, perl = TRUE)
    parts <- regmatches(text, match)[[1L]]
    if (length(parts) == 0L) abort("invalid-view-value", sprintf("%s is not a valid duration", label))
    hours <- as.integer(parts[[3L]])
    minutes <- as.integer(parts[[4L]])
    seconds <- as.integer(parts[[5L]])
    if (hours > 23L || minutes > 59L || seconds > 59L) {
      abort("invalid-view-value", sprintf("%s has invalid duration fields", label))
    }
    days_text <- if (identical(parts[[2L]], "")) "0" else normalize_integer_text(parts[[2L]], label)
    if (
      integer_text_compare(days_text, "-999999999") < 0L ||
        integer_text_compare(days_text, "999999999") > 0L
    ) {
      abort("invalid-view-value", sprintf("%s is outside the supported duration range", label))
    }
    days <- as.double(days_text)
    fraction <- if (length(parts) < 6L || identical(parts[[6L]], "")) 0 else as.double(paste0("0.", parts[[6L]]))
    days * 86400 + hours * 3600 + minutes * 60 + seconds + fraction
  }

  duration_unit_seconds <- c(secs = 1, mins = 60, hours = 3600, days = 86400, weeks = 604800)

  primitive_view_key <- function(value, descriptor, label) {
    semantics <- descriptor$semantics
    type <- descriptor$type
    if (type == "string") return(bounded_utf8(as.character(value), label))
    if (type == "integer") {
      text <- normalize_integer_text(value, label)
      if (semantics$kind == "integer64") return(validate_integer64_text(text, label))
      number <- suppressWarnings(as.double(text))
      if (!is.finite(number) || number < -2147483647 || number > 2147483647) {
        abort("invalid-view-value", sprintf("%s is outside the R integer range", label))
      }
      return(as.character(as.integer(number)))
    }
    if (type == "float") return(canonical_double_key(parse_finite_number(value, label, allow_infinity = TRUE)))
    if (type == "boolean") return(if (parse_boolean(value, label)) "TRUE" else "FALSE")
    if (type == "date") return(parse_date_key(value, label))
    if (type == "datetime") return(parse_datetime_key(value, semantics, label))
    if (type == "duration") {
      seconds <- parse_duration_seconds(value, label)
      return(exact_double(seconds / duration_unit_seconds[[semantics$units]]))
    }
    abort("invalid-view-value", sprintf("%s targets an unsupported R column type", label))
  }

  typed_selection_key <- function(token, descriptor, label) {
    token <- exact_named_list(token, c("kind", "version", "columnType", "cell"), label)
    if (!identical(token$kind, "typedSelection") || !identical(token$version, 1L)) {
      abort("invalid-view-value", sprintf("%s is not a versioned typed selection", label))
    }
    if (!identical(token$columnType, descriptor$type)) {
      abort("invalid-view-value", sprintf("%s does not match the R column type", label))
    }
    cell <- exact_named_list_optional(
      token$cell,
      c("kind", "raw", "display", "isNull", "isNaN"),
      "sign",
      paste0(label, "$cell")
    )
    if (!identical(cell$isNull, FALSE) || !identical(cell$isNaN, FALSE)) {
      abort("invalid-view-value", sprintf("%s must represent a present scalar", label))
    }
    expected_kind <- switch(
      descriptor$semantics$kind,
      logical = "boolean",
      integer = "integer",
      integer64 = "integer",
      double = c("number", "infinity"),
      character = "string",
      factor = "string",
      date = "date",
      datetime = "datetime",
      difftime = "duration"
    )
    if (!cell$kind %in% expected_kind) abort("invalid-view-value", sprintf("%s has an incompatible cell kind", label))
    if (identical(cell$kind, "infinity")) {
      if (!is.null(cell$raw) || !cell$sign %in% c(-1L, 1L)) {
        abort("invalid-view-value", sprintf("%s has invalid infinity data", label))
      }
      return(if (cell$sign < 0L) "-Inf" else "Inf")
    }
    if (descriptor$semantics$kind == "datetime") {
      return(exact_double(parse_finite_number(cell$raw, label)))
    }
    if (descriptor$semantics$kind == "difftime") {
      return(exact_double(parse_finite_number(cell$raw, label)))
    }
    primitive_view_key(cell$raw, descriptor, label)
  }

  view_value_key <- function(value, descriptor, label) {
    if (is.list(value) && !is.null(names(value))) return(typed_selection_key(value, descriptor, label))
    primitive_view_key(value, descriptor, label)
  }

  resolve_view_query <- function(view_query, descriptor) {
    view_query <- exact_named_list_optional(view_query, c("filters", "sorts"), "logic", "view_query")
    logic <- if ("logic" %in% names(view_query)) {
      scalar_choice(view_query$logic, c("and", "or"), "view_query$logic")
    } else {
      "and"
    }
    if (
      !is.list(view_query$filters) || is.object(view_query$filters) || !is.null(attributes(view_query$filters)) ||
        length(view_query$filters) > maximum_filters
    ) {
      abort("invalid-view-query", sprintf("view_query$filters may contain at most %d filters", maximum_filters))
    }
    filters <- lapply(seq_along(view_query$filters), function(index) {
      label <- sprintf("view_query$filters[[%d]]", index)
      filter <- exact_named_list_optional(
        view_query$filters[[index]],
        c("column", "type", "predicates"),
        c("logic", "valueFilter"),
        label
      )
      resolved <- resolve_column_reference(filter$column, descriptor, paste0(label, "$column"))
      column_descriptor <- descriptor$schema[[resolved$position]]
      if (!identical(filter$type, column_descriptor$type)) {
        abort("invalid-view-query", sprintf("%s$type does not match the captured schema", label))
      }
      filter_logic <- if ("logic" %in% names(filter)) {
        scalar_choice(filter$logic, c("and", "or"), paste0(label, "$logic"))
      } else {
        "and"
      }
      if (
        !is.list(filter$predicates) || is.object(filter$predicates) || !is.null(attributes(filter$predicates)) ||
          length(filter$predicates) > maximum_predicates_per_filter
      ) {
        abort("invalid-view-query", sprintf("%s$predicates is too large", label))
      }
      predicates <- lapply(seq_along(filter$predicates), function(predicate_index) {
        predicate_label <- sprintf("%s$predicates[[%d]]", label, predicate_index)
        predicate <- exact_named_list_optional(
          filter$predicates[[predicate_index]],
          c("kind", "operator"),
          c("value", "secondValue"),
          predicate_label
        )
        if (!identical(predicate$kind, "predicate") || !predicate$operator %in% predicate_operators[[filter$type]]) {
          abort("invalid-view-query", sprintf("%s has an unsupported operator", predicate_label))
        }
        nullary <- predicate$operator %in% c("isNull", "isNotNull", "isNaN", "isNotNaN")
        if (!nullary && !"value" %in% names(predicate)) {
          abort("invalid-view-query", sprintf("%s requires value", predicate_label))
        }
        if (identical(predicate$operator, "between") && !"secondValue" %in% names(predicate)) {
          abort("invalid-view-query", sprintf("%s requires secondValue", predicate_label))
        }
        if ("value" %in% names(predicate)) {
          predicate$valueKey <- view_value_key(predicate$value, column_descriptor, paste0(predicate_label, "$value"))
        }
        if ("secondValue" %in% names(predicate)) {
          predicate$secondValueKey <- view_value_key(
            predicate$secondValue,
            column_descriptor,
            paste0(predicate_label, "$secondValue")
          )
        }
        predicate
      })
      value_filter <- NULL
      if ("valueFilter" %in% names(filter)) {
        value_filter <- exact_named_list_optional(
          filter$valueFilter,
          c("kind", "selectedValues", "includeNulls", "includeNaN"),
          "search",
          paste0(label, "$valueFilter")
        )
        if (!identical(value_filter$kind, "values")) {
          abort("invalid-view-query", sprintf("%s$valueFilter has an invalid kind", label))
        }
        if (
          !is.list(value_filter$selectedValues) || is.object(value_filter$selectedValues) ||
            !is.null(attributes(value_filter$selectedValues)) ||
            length(value_filter$selectedValues) > maximum_selected_values_per_filter ||
            !is.logical(value_filter$includeNulls) || length(value_filter$includeNulls) != 1L ||
            !is.logical(value_filter$includeNaN) || length(value_filter$includeNaN) != 1L
        ) {
          abort("invalid-view-query", sprintf("%s$valueFilter is invalid", label))
        }
        value_filter$selectedKeys <- vapply(
          seq_along(value_filter$selectedValues),
          function(value_index) view_value_key(
            value_filter$selectedValues[[value_index]],
            column_descriptor,
            sprintf("%s$valueFilter$selectedValues[[%d]]", label, value_index)
          ),
          character(1L),
          USE.NAMES = FALSE
        )
      }
      list(
        position = resolved$position,
        columnId = resolved$columnId,
        logic = filter_logic,
        predicates = predicates,
        valueFilter = value_filter
      )
    })
    list(logic = logic, filters = filters, sorts = resolve_sort_rules(view_query$sorts, descriptor))
  }

  ascii_fold <- function(value) {
    chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", value)
  }

  compare_integer_keys <- function(keys, target, operator) {
    comparisons <- vapply(keys, integer_text_compare, integer(1L), right = target, USE.NAMES = FALSE)
    switch(
      operator,
      equals = comparisons == 0L,
      notEquals = comparisons != 0L,
      gt = comparisons > 0L,
      gte = comparisons >= 0L,
      lt = comparisons < 0L,
      lte = comparisons <= 0L
    )
  }

  predicate_mask <- function(column, descriptor, predicate) {
    semantics <- descriptor$semantics
    missing <- profile_missing_masks(column, semantics)
    operator <- predicate$operator
    if (identical(operator, "isNull")) return(missing$null)
    if (identical(operator, "isNotNull")) return(!missing$null)
    if (identical(operator, "isNaN")) return(missing$nan)
    if (identical(operator, "isNotNaN")) return(!missing$nan)

    present <- !missing$null & !missing$nan
    keys <- rep("", length(column))
    present_indices <- which(present)
    keys[present_indices] <- profile_value_keys(column, semantics, present_indices)
    result <- rep(FALSE, length(column))
    if (length(present_indices) == 0L) return(result)
    if (operator %in% c("contains", "startsWith", "endsWith")) {
      values <- if (semantics$kind == "factor") as.character(column[present_indices]) else column[present_indices]
      target <- predicate$valueKey
      result[present_indices] <- if (identical(operator, "contains")) {
        grepl(ascii_fold(target), ascii_fold(values), fixed = TRUE)
      } else if (identical(operator, "startsWith")) {
        startsWith(values, target)
      } else {
        endsWith(values, target)
      }
      return(result)
    }
    compare <- function(target, comparison_operator) {
      if (semantics$kind == "integer64") {
        compare_integer_keys(keys[present_indices], target, comparison_operator)
      } else if (descriptor$type %in% c("integer", "float", "date", "datetime", "duration")) {
        left <- suppressWarnings(as.double(keys[present_indices]))
        right <- suppressWarnings(as.double(target))
        switch(
          comparison_operator,
          equals = left == right,
          notEquals = left != right,
          gt = left > right,
          gte = left >= right,
          lt = left < right,
          lte = left <= right
        )
      } else {
        switch(
          comparison_operator,
          equals = keys[present_indices] == target,
          notEquals = keys[present_indices] != target,
          gt = keys[present_indices] > target,
          gte = keys[present_indices] >= target,
          lt = keys[present_indices] < target,
          lte = keys[present_indices] <= target
        )
      }
    }
    result[present_indices] <- if (identical(operator, "between")) {
      compare(predicate$valueKey, "gte") & compare(predicate$secondValueKey, "lte")
    } else {
      compare(predicate$valueKey, operator)
    }
    result
  }

  filter_row_positions <- function(frame, descriptor, resolved) {
    row_count <- descriptor$shape$rows
    column_masks <- list()
    for (filter in resolved$filters) {
      column <- frame[[filter$position]]
      semantics <- descriptor$schema[[filter$position]]$semantics
      missing <- profile_missing_masks(column, semantics)
      conditions <- list()
      value_filter <- filter$valueFilter
      if (!is.null(value_filter) && (
        length(value_filter$selectedKeys) > 0L || isTRUE(value_filter$includeNulls) || isTRUE(value_filter$includeNaN)
      )) {
        current <- rep(FALSE, row_count)
        present_indices <- which(!missing$null & !missing$nan)
        if (length(value_filter$selectedKeys) > 0L && length(present_indices) > 0L) {
          keys <- profile_value_keys(column, semantics, present_indices)
          current[present_indices] <- keys %in% value_filter$selectedKeys
        }
        if (isTRUE(value_filter$includeNulls)) current <- current | missing$null
        if (isTRUE(value_filter$includeNaN)) current <- current | missing$nan
        conditions[[length(conditions) + 1L]] <- current
      }
      for (predicate in filter$predicates) {
        conditions[[length(conditions) + 1L]] <- predicate_mask(
          column,
          descriptor$schema[[filter$position]],
          predicate
        )
      }
      if (length(conditions) > 0L) {
        combined <- conditions[[1L]]
        if (length(conditions) > 1L) {
          for (index in 2:length(conditions)) {
            combined <- if (identical(filter$logic, "or")) combined | conditions[[index]] else combined & conditions[[index]]
          }
        }
        column_masks[[length(column_masks) + 1L]] <- combined
      }
    }
    if (length(column_masks) == 0L) return(seq_len(row_count))
    combined <- column_masks[[1L]]
    if (length(column_masks) > 1L) {
      for (index in 2:length(column_masks)) {
        combined <- if (identical(resolved$logic, "or")) combined | column_masks[[index]] else combined & column_masks[[index]]
      }
    }
    which(combined)
  }

  resolve_profile_columns <- function(column_references, descriptor) {
    maximum_columns_for_frame <- min(maximum_profile_columns, descriptor$shape$columns)
    if (
      !is.list(column_references) ||
        is.object(column_references) ||
        !is.null(attributes(column_references)) ||
        length(column_references) == 0L ||
        length(column_references) > maximum_columns_for_frame
    ) {
      abort(
        "profile-too-large",
        sprintf("column_references must contain 1 through %d columns", maximum_columns_for_frame)
      )
    }

    schema_ids <- vapply(descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    resolved <- lapply(seq_along(column_references), function(index) {
      label <- sprintf("column_references[[%d]]", index)
      reference <- exact_named_list(column_references[[index]], c("id", "name"), label)
      column_id <- bounded_utf8(reference$id, paste0(label, "$id"), maximum_column_id_bytes)
      column_name <- bounded_utf8(reference$name, paste0(label, "$name"), maximum_name_bytes)
      position <- match(column_id, schema_ids)
      if (is.na(position) || !identical(descriptor$schema[[position]]$name, column_name)) {
        abort("stale-column", sprintf("%s does not match the captured schema", label))
      }
      list(position = position, columnId = column_id)
    })
    column_ids <- vapply(resolved, `[[`, character(1L), "columnId", USE.NAMES = FALSE)
    if (anyDuplicated(column_ids)) {
      abort("invalid-view-query", "column_references may address each column only once")
    }
    resolved
  }

  validate_profile_work <- function(row_count, column_count, cell_limit, label) {
    cell_count <- as.double(row_count) * as.double(column_count)
    if (row_count > maximum_profile_rows || cell_count > cell_limit) {
      abort(
        "profile-too-large",
        sprintf(
          "%s exceeds the native R profiling limit of %d rows and %.0f cells",
          label,
          maximum_profile_rows,
          cell_limit
        )
      )
    }
    invisible(NULL)
  }

  validate_profile_column <- function(column, semantics, label) {
    validated <- column_semantics(column, label, new_payload_budget(), validate_values = TRUE)
    if (!identical(validated, semantics)) source_changed()
    kind <- semantics$kind
    if (kind %in% c("date", "datetime", "difftime")) {
      values <- as.double(column)
      if (any(is.nan(values))) {
        abort("unsupported-cell", sprintf("%s contains a classed NaN", label))
      }
      if (any(!is.na(values) & !is.finite(values))) {
        abort("unsupported-cell", sprintf("%s contains a non-finite classed value", label))
      }
      if (kind == "date" && any(!is.na(values) & values != floor(values))) {
        abort("unsupported-cell", sprintf("%s contains a fractional Date", label))
      }
    }
    invisible(NULL)
  }

  profile_missing_masks <- function(column, semantics) {
    if (identical(semantics$kind, "double")) {
      nan <- is.nan(column)
      return(list(null = is.na(column) & !nan, nan = nan))
    }
    list(null = is.na(column), nan = rep(FALSE, length(column)))
  }

  profile_value_keys <- function(column, semantics, indices) {
    if (length(indices) == 0L) return(character())
    kind <- semantics$kind
    values <- column[indices]
    if (kind == "logical") return(ifelse(values, "TRUE", "FALSE"))
    if (kind %in% c("integer", "integer64")) return(as.character(values))
    if (kind == "double") {
      return(vapply(values, canonical_double_key, character(1L)))
    }
    if (kind == "character") {
      return(vapply(
        seq_along(values),
        function(index) bounded_utf8(values[[index]], sprintf("profile value %d", indices[[index]])),
        character(1L),
        USE.NAMES = FALSE
      ))
    }
    if (kind == "factor") return(as.character(values))
    numeric_values <- if (kind == "difftime") {
      as.double(values, units = semantics$units)
    } else {
      as.double(values)
    }
    vapply(numeric_values, exact_double, character(1L), USE.NAMES = FALSE)
  }

  profile_value_counts <- function(column, semantics, present_indices, budget, label) {
    if (length(present_indices) == 0L) {
      return(list(distinctCount = 0L, topValues = json_array(list()), keys = character()))
    }
    keys <- profile_value_keys(column, semantics, present_indices)
    first <- !duplicated(keys)
    unique_keys <- keys[first]
    first_indices <- present_indices[first]
    counts <- tabulate(match(keys, unique_keys), nbins = length(unique_keys))
    priority <- base::order(-counts, seq_along(counts), method = "radix")
    selected <- utils::head(priority, maximum_top_values)
    top_values <- lapply(seq_along(selected), function(result_index) {
      source_index <- first_indices[[selected[[result_index]]]]
      encoded <- encode_value(
        column,
        semantics,
        source_index,
        sprintf("%s top value %d", label, result_index),
        budget
      )
      list(value = encoded$display, count = as.integer(counts[[selected[[result_index]]]]))
    })
    list(
      distinctCount = as.integer(length(unique_keys)),
      topValues = json_array(top_values),
      keys = keys
    )
  }

  finite_statistic <- function(value) {
    if (length(value) != 1L || is.na(value) || !is.finite(value)) NULL else as.double(value)
  }

  numeric_profile_values <- function(column, semantics, present_indices) {
    values <- column[present_indices]
    if (semantics$kind == "integer64") return(suppressWarnings(as.double(values)))
    if (semantics$kind == "difftime") return(as.double(values, units = semantics$units))
    as.double(values)
  }

  exact_profile_integer_cell <- function(column, semantics, index, budget, label) {
    exact <- as.character(column[index])
    spend_json_string(budget, exact, label)
    digits <- if (startsWith(exact, "-")) substring(exact, 2L) else exact
    safe_limit <- "9007199254740991"
    safely_numeric <- nchar(digits, type = "bytes") < nchar(safe_limit) ||
      (nchar(digits, type = "bytes") == nchar(safe_limit) && digits <= safe_limit)
    raw <- if (safely_numeric) as.double(exact) else exact
    ordinary_cell("integer", raw, exact)
  }

  exact_integer_extrema <- function(column, semantics, present_indices, budget, label) {
    if (length(present_indices) == 0L || !semantics$kind %in% c("integer", "integer64")) return(list())
    if (semantics$kind == "integer64") {
      values <- column[present_indices]
      ascending <- order_integer64(values, FALSE)
      minimum_index <- present_indices[[ascending[[1L]]]]
      maximum_index <- present_indices[[ascending[[length(ascending)]]]]
    } else {
      values <- column[present_indices]
      minimum_index <- present_indices[[which.min(values)]]
      maximum_index <- present_indices[[which.max(values)]]
    }
    list(
      exactMin = exact_profile_integer_cell(column, semantics, minimum_index, budget, paste0(label, " minimum")),
      exactMax = exact_profile_integer_cell(column, semantics, maximum_index, budget, paste0(label, " maximum"))
    )
  }

  numeric_histogram <- function(values, distinct_count) {
    finite_values <- values[is.finite(values)]
    if (length(finite_values) == 0L || distinct_count == 0L) return(NULL)
    minimum <- min(finite_values)
    maximum <- max(finite_values)
    bin_count <- min(maximum_histogram_bins, length(finite_values), distinct_count)
    if (minimum == maximum) {
      return(list(
        kind = "numeric",
        bins = json_array(list(list(min = as.double(minimum), max = as.double(maximum), count = length(finite_values))))
      ))
    }
    fractions <- seq_len(bin_count - 1L) / bin_count
    interior_edges <- vapply(
      fractions,
      function(fraction) minimum * (1 - fraction) + maximum * fraction,
      double(1L)
    )
    edges <- c(minimum, interior_edges, maximum)
    edges <- cummax(pmin(maximum, pmax(minimum, edges)))
    if (any(!is.finite(edges))) return(NULL)
    bin_indices <- findInterval(finite_values, edges, rightmost.closed = TRUE, all.inside = TRUE)
    counts <- tabulate(bin_indices, nbins = bin_count)
    edges[[1L]] <- minimum
    edges[[length(edges)]] <- maximum
    bins <- lapply(seq_len(bin_count), function(index) {
      list(min = as.double(edges[[index]]), max = as.double(edges[[index + 1L]]), count = as.integer(counts[[index]]))
    })
    list(kind = "numeric", bins = json_array(bins))
  }

  numeric_profile <- function(column, semantics, present_indices, value_keys, budget, label) {
    values <- numeric_profile_values(column, semantics, present_indices)
    numeric <- list()
    candidates <- list(
      min = if (length(values) == 0L) NULL else suppressWarnings(min(values)),
      max = if (length(values) == 0L) NULL else suppressWarnings(max(values)),
      mean = if (length(values) == 0L) NULL else suppressWarnings(mean(values)),
      median = if (length(values) == 0L) NULL else suppressWarnings(stats::median(values)),
      std = if (length(values) < 2L) NULL else suppressWarnings(stats::sd(values))
    )
    for (name in names(candidates)) {
      statistic <- finite_statistic(candidates[[name]])
      if (!is.null(statistic)) numeric[[name]] <- statistic
    }
    numeric <- c(numeric, exact_integer_extrema(column, semantics, present_indices, budget, label))

    finite_keys <- value_keys[is.finite(values)]
    visualization <- numeric_histogram(values, length(unique(finite_keys)))
    list(
      numeric = if (length(numeric) == 0L) NULL else numeric,
      visualization = visualization
    )
  }

  text_profile <- function(column, semantics, present_indices) {
    if (length(present_indices) == 0L) return(list(emptyCount = 0L))
    values <- if (semantics$kind == "factor") as.character(column[present_indices]) else column[present_indices]
    values <- vapply(
      seq_along(values),
      function(index) bounded_utf8(values[[index]], sprintf("profile text %d", present_indices[[index]])),
      character(1L),
      USE.NAMES = FALSE
    )
    lengths <- nchar(values, type = "chars", allowNA = FALSE, keepNA = FALSE)
    list(
      emptyCount = as.integer(sum(lengths == 0L)),
      minLength = as.integer(min(lengths)),
      maxLength = as.integer(max(lengths)),
      meanLength = as.double(mean(lengths))
    )
  }

  datetime_profile <- function(column, semantics, present_indices, budget, label) {
    if (length(present_indices) == 0L) return(list(kind = "datetime"))
    values <- as.double(column[present_indices])
    minimum_index <- present_indices[[which.min(values)]]
    maximum_index <- present_indices[[which.max(values)]]
    list(
      kind = "datetime",
      min = encode_value(column, semantics, minimum_index, paste0(label, " minimum"), budget)$display,
      max = encode_value(column, semantics, maximum_index, paste0(label, " maximum"), budget)$display
    )
  }

  column_summary <- function(capture, frame, resolved, budget) {
    position <- resolved$position
    descriptor <- capture$descriptor$schema[[position]]
    column <- frame[[position]]
    semantics <- descriptor$semantics
    label <- sprintf("column %d profile", position)
    validate_profile_column(column, semantics, label)
    spend_payload_budget(budget, summary_fixed_bytes, label)
    spend_json_string(budget, descriptor$id, paste0(label, " ID"))
    spend_json_string(budget, descriptor$name, paste0(label, " name"))
    spend_json_string(budget, descriptor$rawType, paste0(label, " type"))

    missing <- profile_missing_masks(column, semantics)
    present_indices <- which(!missing$null & !missing$nan)
    counts <- profile_value_counts(column, semantics, present_indices, budget, label)
    summary <- list(
      columnId = descriptor$id,
      column = descriptor$name,
      type = descriptor$type,
      rawType = descriptor$rawType,
      totalCount = length(column),
      nullCount = as.integer(sum(missing$null)),
      nanCount = as.integer(sum(missing$nan)),
      distinctCount = counts$distinctCount,
      topValues = counts$topValues
    )

    if (semantics$kind %in% c("integer", "integer64", "double", "difftime")) {
      profile <- numeric_profile(column, semantics, present_indices, counts$keys, budget, label)
      if (!is.null(profile$numeric)) summary$numeric <- profile$numeric
      if (!is.null(profile$visualization)) summary$visualization <- profile$visualization
    } else if (semantics$kind == "logical") {
      values <- column[present_indices]
      summary$visualization <- list(
        kind = "boolean",
        trueCount = as.integer(sum(values)),
        falseCount = as.integer(sum(!values))
      )
    } else if (semantics$kind %in% c("date", "datetime")) {
      summary$visualization <- datetime_profile(column, semantics, present_indices, budget, label)
    } else if (semantics$kind %in% c("character", "factor")) {
      summary$text <- text_profile(column, semantics, present_indices)
      summary$visualization <- list(
        kind = "categorical",
        categories = counts$topValues,
        otherCount = as.integer(length(present_indices) - sum(vapply(counts$topValues, `[[`, integer(1L), "count")))
      )
    }
    summary
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

  new_capture_metrics <- function() {
    metrics <- new.env(parent = emptyenv())
    metrics$nullableScans <- 0
    metrics$sourceReads <- 0
    metrics$directPageSlices <- 0
    metrics$directRowPositions <- 0
    metrics$sortOrderBuilds <- 0
    metrics$sortOrderRows <- 0
    metrics$sortColumnSnapshots <- 0
    metrics$profileColumns <- 0
    metrics$datasetProfiles <- 0
    metrics
  }

  add_metric <- function(metrics, name, amount = 1) {
    metrics[[name]] <- metrics[[name]] + as.double(amount)
  }

  inspect_frame <- function(value, conservative_nullable, validate_values, metrics) {
    if (!is.data.frame(value)) {
      abort("unsupported-frame", "the value is not an R dataframe")
    }
    flavor <- frame_flavor(value)
    assert_frame_attributes(value, flavor)
    row_count <- nrow(value)
    column_count <- ncol(value)
    whole_number(row_count, "row count", maximum_rows)
    whole_number(column_count, "column count", maximum_columns)
    metadata_budget <- new_payload_budget()
    spend_payload_budget(metadata_budget, metadata_base_bytes, "R frame metadata")
    column_names <- names(value)
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
      semantics <- column_semantics(
        value[[index]],
        sprintf("column %d", index),
        metadata_budget,
        validate_values = validate_values
      )
      nullable <- if (isTRUE(conservative_nullable)) {
        TRUE
      } else {
        add_metric(metrics, "nullableScans")
        anyNA(value[[index]])
      }
      list(
        id = sprintf("r:c:%d", index - 1L),
        name = column_names[[index]],
        position = index - 1L,
        rawType = raw_column_type(semantics),
        type = public_column_type(semantics$kind),
        nullable = nullable,
        semantics = semantics
      )
    })

    descriptor <- list(
      contractVersion = contract_version,
      dataframeFlavor = flavor,
      shape = list(rows = row_count, columns = column_count),
      frameSemantics = list(
        classes = bounded_text_array(class(value), "frame classes", maximum_name_bytes, metadata_budget),
        rowNames = if (.row_names_info(value, type = 1L) > 0L) "explicit" else "positional",
        keyColumnIds = key_column_ids(value, flavor, column_names, metadata_budget)
      ),
      schema = json_array(schema)
    )
    list(descriptor = descriptor, metadataBytes = metadata_budget$used, flavor = flavor)
  }

  new_sort_cache <- function() {
    cache <- new.env(parent = emptyenv())
    cache$valid <- FALSE
    cache$rules <- list()
    cache$rowPositions <- integer()
    cache$columns <- list()
    cache$bytes <- 0
    cache
  }

  clear_sort_cache <- function(cache) {
    cache$valid <- FALSE
    cache$rules <- list()
    cache$rowPositions <- integer()
    cache$columns <- list()
    cache$bytes <- 0
    invisible(NULL)
  }

  finish_capture <- function(capture) {
    class(capture) <- "openwrangler_r_frame_capture"
    lockEnvironment(capture, bindings = TRUE)
    capture
  }

  capture_frame <- function(
    value,
    nullability_source = NULL,
    source_positions = NULL,
    source_row_positions = NULL,
    output_ids = NULL,
    text_length_positions = NULL,
    text_transform_positions = NULL,
    numeric_transform_positions = NULL,
    fill_missing_positions = NULL,
    fallback_fill_positions = NULL,
    cast_positions = NULL,
    cast_dtypes = NULL
  ) {
    if (!is.data.frame(value)) {
      abort("unsupported-frame", "the value is not an R dataframe")
    }
    if (!is.null(nullability_source)) validate_capture(nullability_source)
    if (
      is.null(nullability_source) &&
        (
          !is.null(source_positions) ||
            !is.null(source_row_positions) ||
            !is.null(output_ids) ||
            !is.null(text_length_positions) ||
            !is.null(text_transform_positions) ||
            !is.null(numeric_transform_positions) ||
            !is.null(fill_missing_positions) ||
            !is.null(fallback_fill_positions) ||
            !is.null(cast_positions) ||
            !is.null(cast_dtypes)
        )
    ) {
      abort("internal-error", "derived R column mappings require a source R capture")
    }
    if (!is.null(output_ids) && is.null(source_positions)) {
      abort("internal-error", "explicit R output IDs require a source-column mapping")
    }
    if (!is.null(text_length_positions) && (is.null(source_positions) || is.null(output_ids))) {
      abort("internal-error", "R text-length outputs require explicit source mappings and identities")
    }
    if (!is.null(text_transform_positions) && is.null(source_positions)) {
      abort("internal-error", "R text-transform outputs require explicit source mappings")
    }
    if (!is.null(numeric_transform_positions) && is.null(source_positions)) {
      abort("internal-error", "R numeric-transform outputs require explicit source mappings")
    }
    if (!is.null(fill_missing_positions) && is.null(source_positions)) {
      abort("internal-error", "R fill-missing outputs require explicit source mappings")
    }
    if (!is.null(fallback_fill_positions) && is.null(source_positions)) {
      abort("internal-error", "R fallback-fill outputs require explicit source mappings")
    }
    if (xor(is.null(cast_positions), is.null(cast_dtypes))) {
      abort("internal-error", "R cast outputs require positions and target dtypes together")
    }
    if (!is.null(cast_positions) && is.null(source_positions)) {
      abort("internal-error", "R cast outputs require explicit source mappings")
    }
    flavor <- frame_flavor(value)
    assert_frame_attributes(value, flavor)
    snapshot <- isolated_snapshot(value, flavor)
    metrics <- new_capture_metrics()
    inspected <- inspect_frame(
      snapshot,
      conservative_nullable = !is.null(nullability_source),
      validate_values = TRUE,
      metrics = metrics
    )
    row_count <- inspected$descriptor$shape$rows
    if (!is.null(nullability_source) && row_count == 0L) {
      # An empty derived base data.frame has no row.names payload from which R
      # can recover whether the source used automatic or explicit row names.
      # The source capture remains authoritative until rows exist again.
      inspected$descriptor$frameSemantics$rowNames <-
        nullability_source$descriptor$frameSemantics$rowNames
    }
    row_identity_domain <- if (is.null(nullability_source)) {
      row_count
    } else {
      nullability_source$rowIdentityDomain
    }
    row_origins <- if (is.null(nullability_source)) {
      seq_len(row_count)
    } else {
      source_row_count <- nullability_source$descriptor$shape$rows
      if (is.null(source_row_positions)) {
        if (row_count != source_row_count) {
          abort("internal-error", "a derived R frame changed height without a source-row mapping")
        }
        source_row_positions <- seq_len(source_row_count)
      }
      if (
        !is.numeric(source_row_positions) ||
          anyNA(source_row_positions) ||
          any(!is.finite(source_row_positions)) ||
          any(source_row_positions != floor(source_row_positions)) ||
          length(source_row_positions) != row_count ||
          any(source_row_positions < 1L) ||
          any(source_row_positions > source_row_count) ||
          anyDuplicated(source_row_positions)
      ) {
        abort("internal-error", "a derived R frame has an invalid source-row mapping")
      }
      nullability_source$rowOrigins[as.integer(source_row_positions)]
    }
    if (
      !is.numeric(row_origins) ||
        anyNA(row_origins) ||
        any(!is.finite(row_origins)) ||
        any(row_origins != floor(row_origins)) ||
        length(row_origins) != row_count ||
        any(row_origins < 1L) ||
        any(row_origins > row_identity_domain) ||
        anyDuplicated(row_origins)
    ) {
      abort("internal-error", "an R capture has invalid stable row identities")
    }
    if (!is.null(nullability_source)) {
      source_schema <- nullability_source$descriptor$schema
      output_schema <- inspected$descriptor$schema
      if (is.null(source_positions)) {
        if (length(source_schema) != length(output_schema)) {
          abort("internal-error", "a derived R frame changed width without a source-column mapping")
        }
        source_positions <- seq_along(source_schema)
      }
      if (
        !is.numeric(source_positions) ||
          anyNA(source_positions) ||
          any(!is.finite(source_positions)) ||
          any(source_positions != floor(source_positions)) ||
          length(source_positions) != length(output_schema) ||
          any(source_positions < 1L) ||
          any(source_positions > length(source_schema)) ||
          (is.null(output_ids) && anyDuplicated(source_positions))
      ) {
        abort("internal-error", "a derived R frame has an invalid source-column mapping")
      }
      source_positions <- as.integer(source_positions)
      if (is.null(text_length_positions)) {
        text_length_positions <- integer()
      } else {
        if (
          !is.numeric(text_length_positions) ||
            anyNA(text_length_positions) ||
            any(!is.finite(text_length_positions)) ||
            any(text_length_positions != floor(text_length_positions)) ||
            any(text_length_positions < 1L) ||
            any(text_length_positions > length(output_schema)) ||
            anyDuplicated(text_length_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid text-length output positions")
        }
        text_length_positions <- as.integer(text_length_positions)
      }
      if (is.null(text_transform_positions)) {
        text_transform_positions <- integer()
      } else {
        if (
          !is.numeric(text_transform_positions) ||
            anyNA(text_transform_positions) ||
            any(!is.finite(text_transform_positions)) ||
            any(text_transform_positions != floor(text_transform_positions)) ||
            any(text_transform_positions < 1L) ||
            any(text_transform_positions > length(output_schema)) ||
            anyDuplicated(text_transform_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid text-transform output positions")
        }
        text_transform_positions <- as.integer(text_transform_positions)
      }
      if (is.null(numeric_transform_positions)) {
        numeric_transform_positions <- integer()
      } else {
        if (
          !is.numeric(numeric_transform_positions) ||
            anyNA(numeric_transform_positions) ||
            any(!is.finite(numeric_transform_positions)) ||
            any(numeric_transform_positions != floor(numeric_transform_positions)) ||
            any(numeric_transform_positions < 1L) ||
            any(numeric_transform_positions > length(output_schema)) ||
            anyDuplicated(numeric_transform_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid numeric-transform output positions")
        }
        numeric_transform_positions <- as.integer(numeric_transform_positions)
      }
      if (is.null(cast_positions)) {
        cast_positions <- integer()
        cast_dtypes <- character()
      } else {
        if (
          !is.numeric(cast_positions) ||
            anyNA(cast_positions) ||
            any(!is.finite(cast_positions)) ||
            any(cast_positions != floor(cast_positions)) ||
            any(cast_positions < 1L) ||
            any(cast_positions > length(output_schema)) ||
            anyDuplicated(cast_positions) ||
            !is.character(cast_dtypes) ||
            anyNA(cast_dtypes) ||
            length(cast_dtypes) != length(cast_positions) ||
            any(!cast_dtypes %in% c("string", "integer", "float", "boolean", "date", "datetime"))
        ) {
          abort("internal-error", "a derived R frame has invalid cast output metadata")
        }
        cast_positions <- as.integer(cast_positions)
      }
      if (is.null(fill_missing_positions)) {
        fill_missing_positions <- integer()
      } else {
        if (
          !is.numeric(fill_missing_positions) ||
            anyNA(fill_missing_positions) ||
            any(!is.finite(fill_missing_positions)) ||
            any(fill_missing_positions != floor(fill_missing_positions)) ||
            any(fill_missing_positions < 1L) ||
            any(fill_missing_positions > length(output_schema)) ||
            anyDuplicated(fill_missing_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid fill-missing output positions")
        }
        fill_missing_positions <- as.integer(fill_missing_positions)
      }
      if (is.null(fallback_fill_positions)) {
        fallback_fill_positions <- integer()
      } else {
        if (
          !is.numeric(fallback_fill_positions) ||
            anyNA(fallback_fill_positions) ||
            any(!is.finite(fallback_fill_positions)) ||
            any(fallback_fill_positions != floor(fallback_fill_positions)) ||
            any(fallback_fill_positions < 1L) ||
            any(fallback_fill_positions > length(output_schema)) ||
            anyDuplicated(fallback_fill_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid fallback-fill output positions")
        }
        fallback_fill_positions <- as.integer(fallback_fill_positions)
      }
      transformed_positions <- c(
        text_length_positions,
        text_transform_positions,
        numeric_transform_positions,
        fill_missing_positions,
        fallback_fill_positions,
        cast_positions
      )
      if (anyDuplicated(transformed_positions)) {
        abort("internal-error", "an R output cannot have more than one transformed-column mapping")
      }
      source_nullable <- vapply(source_positions, function(position) {
        value <- source_schema[[position]]$nullable
        if (length(value) != 1L || !is.logical(value) || is.na(value)) {
          abort("internal-error", "an R capture retained invalid nullability metadata")
        }
        value
      }, logical(1L), USE.NAMES = FALSE)

      generated_ids <- vapply(output_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
      mapped_source_ids <- vapply(source_positions, function(position) {
        source_schema[[position]]$id
      }, character(1L), USE.NAMES = FALSE)
      if (is.null(output_ids)) {
        output_ids <- mapped_source_ids
      } else {
        if (!is.character(output_ids) || length(output_ids) != length(output_schema) || anyNA(output_ids)) {
          abort("internal-error", "a derived R frame has invalid explicit output identities")
        }
        output_ids <- vapply(seq_along(output_ids), function(index) {
          bounded_utf8(output_ids[[index]], sprintf("output_ids[[%d]]", index), maximum_column_id_bytes)
        }, character(1L), USE.NAMES = FALSE)
        if (
          any(output_ids == "") ||
            anyDuplicated(output_ids) ||
            !all(vapply(output_ids, is_canonical_column_id, logical(1L), USE.NAMES = FALSE))
        ) {
          abort("internal-error", "a derived R frame has invalid explicit output identities")
        }
        source_ids <- vapply(source_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
        for (index in seq_along(output_ids)) {
          existing_position <- match(output_ids[[index]], source_ids)
          if (!is.na(existing_position) && existing_position != source_positions[[index]]) {
            abort("internal-error", "a derived R frame remapped an existing column identity")
          }
        }
        for (index in seq_along(output_ids)) {
          source_position <- source_positions[[index]]
          source_id <- source_ids[[source_position]]
          if (!identical(output_ids[[index]], source_id)) {
            prior_indices <- seq_len(index - 1L)
            if (
              length(prior_indices) == 0L ||
                !any(
                  source_positions[prior_indices] == source_position &
                    output_ids[prior_indices] == source_id
                )
            ) {
              abort("internal-error", "a derived R frame replaced a retained source identity")
            }
          }
        }
      }
      for (index in seq_along(output_schema)) {
        source_column <- source_schema[[source_positions[[index]]]]
        output_column <- output_schema[[index]]
        if (index %in% text_length_positions) {
          if (
            !source_column$semantics$kind %in% c("character", "factor") ||
              !identical(output_column$semantics$kind, "integer") ||
              identical(output_ids[[index]], mapped_source_ids[[index]])
          ) {
            abort("internal-error", "a derived R frame has an invalid text-length output")
          }
        } else if (index %in% text_transform_positions) {
          if (
            !source_column$semantics$kind %in% c("character", "factor") ||
              !identical(output_column$semantics$kind, "character")
          ) {
            abort("internal-error", "a derived R frame has an invalid text-transform output")
          }
        } else if (index %in% numeric_transform_positions) {
          expected_kind <- if (identical(source_column$semantics$kind, "integer64")) {
            "integer64"
          } else {
            "double"
          }
          if (
            !source_column$semantics$kind %in% c("integer", "double", "integer64") ||
              !identical(output_column$semantics$kind, expected_kind)
          ) {
            abort("internal-error", "a derived R frame has an invalid numeric-transform output")
          }
        } else if (index %in% cast_positions) {
          cast_index <- match(index, cast_positions)
          dtype <- cast_dtypes[[cast_index]]
          expected_kind <- switch(
            dtype,
            string = "character",
            integer = if (identical(source_column$semantics$kind, "integer64")) "integer64" else "integer",
            float = "double",
            boolean = "logical",
            date = "date",
            datetime = "datetime"
          )
          if (
            !identical(output_ids[[index]], mapped_source_ids[[index]]) ||
              !identical(output_column$semantics$kind, expected_kind) ||
              (identical(dtype, "datetime") &&
                !identical(output_column$semantics$timezone, "UTC"))
          ) {
            abort("internal-error", "a derived R frame has an invalid cast output")
          }
        } else if (index %in% c(fill_missing_positions, fallback_fill_positions)) {
          source_semantics <- source_column$semantics
          output_semantics <- output_column$semantics
          factor_semantics_match <- FALSE
          if (
            identical(source_semantics$kind, "factor") &&
              identical(output_semantics$kind, "factor")
          ) {
            source_levels <- source_semantics$levels
            output_levels <- output_semantics$levels
            source_without_levels <- source_semantics
            output_without_levels <- output_semantics
            source_without_levels$levels <- NULL
            output_without_levels$levels <- NULL
            factor_semantics_match <-
              identical(source_without_levels, output_without_levels) &&
                length(output_levels) >= length(source_levels) &&
                (
                  index %in% fallback_fill_positions ||
                    length(output_levels) <= length(source_levels) + 1L
                ) &&
                identical(output_levels[seq_along(source_levels)], source_levels)
          }
          if (
            !identical(output_ids[[index]], mapped_source_ids[[index]]) ||
              !identical(output_column$rawType, source_column$rawType) ||
              !identical(output_column$type, source_column$type) ||
              (!identical(output_semantics, source_semantics) && !factor_semantics_match)
          ) {
            abort("internal-error", "a derived R frame has an invalid fill-missing output")
          }
        } else {
          if (
            !identical(output_column$rawType, source_column$rawType) ||
              !identical(output_column$type, source_column$type) ||
              !identical(output_column$semantics, source_column$semantics)
          ) {
            abort("internal-error", "a derived R frame changed retained column type metadata")
          }
        }
        inspected$descriptor$schema[[index]]$id <- output_ids[[index]]
        inspected$descriptor$schema[[index]]$nullable <- if (index %in% fill_missing_positions) {
          FALSE
        } else if (index %in% fallback_fill_positions) {
          anyNA(snapshot[[index]])
        } else if (index %in% cast_positions) {
          isTRUE(source_nullable[[index]]) || anyNA(snapshot[[index]])
        } else if (index %in% text_transform_positions) {
          isTRUE(source_nullable[[index]]) || anyNA(snapshot[[index]])
        } else if (index %in% numeric_transform_positions) {
          isTRUE(source_nullable[[index]]) || anyNA(snapshot[[index]])
        } else {
          source_nullable[[index]]
        }
      }

      old_id_bytes <- sum(vapply(generated_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
      new_id_bytes <- sum(vapply(output_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
      if (new_id_bytes > old_id_bytes) {
        budget <- new_payload_budget(inspected$metadataBytes)
        spend_payload_budget(budget, new_id_bytes - old_id_bytes, "derived R column identities")
        inspected$metadataBytes <- budget$used
      }

      generated_key_ids <- inspected$descriptor$frameSemantics$keyColumnIds
      if (length(generated_key_ids) != 0L) {
        key_positions <- match(generated_key_ids, generated_ids)
        if (anyNA(key_positions)) {
          abort("internal-error", "a derived R frame retained an invalid data.table key")
        }
        retained_key_ids <- output_ids[key_positions]
        old_key_bytes <- sum(vapply(generated_key_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
        new_key_bytes <- sum(vapply(retained_key_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
        if (new_key_bytes > old_key_bytes) {
          budget <- new_payload_budget(inspected$metadataBytes)
          spend_payload_budget(budget, new_key_bytes - old_key_bytes, "derived data.table key metadata")
          inspected$metadataBytes <- budget$used
        }
        inspected$descriptor$frameSemantics$keyColumnIds <- json_array(retained_key_ids)
      }
    }
    capture <- new.env(parent = emptyenv())
    capture$mode <- "isolated"
    capture$snapshot <- snapshot
    capture$sourceReader <- NULL
    capture$descriptor <- inspected$descriptor
    capture$rowOrigins <- row_origins
    capture$rowIdentityDomain <- row_identity_domain
    capture$metadataBytes <- inspected$metadataBytes
    capture$metrics <- metrics
    capture$sortCache <- new_sort_cache()
    finish_capture(capture)
  }

  capture_live_frame <- function(source_reader) {
    if (!is.function(source_reader)) {
      abort("invalid-source-reader", "source_reader must be a function")
    }
    metrics <- new_capture_metrics()
    value <- source_reader()
    add_metric(metrics, "sourceReads")
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = metrics
    )
    capture <- new.env(parent = emptyenv())
    capture$mode <- "live"
    capture$snapshot <- NULL
    capture$sourceReader <- source_reader
    capture$liveState <- new.env(parent = emptyenv())
    capture$liveState$hasInitialFrame <- TRUE
    capture$liveState$initialFrame <- value
    capture$descriptor <- inspected$descriptor
    capture$rowOrigins <- seq_len(inspected$descriptor$shape$rows)
    capture$rowIdentityDomain <- inspected$descriptor$shape$rows
    capture$metadataBytes <- inspected$metadataBytes
    capture$metrics <- metrics
    capture$sortCache <- new_sort_cache()
    finish_capture(capture)
  }

  isolate_capture <- function(capture) {
    capture_frame(read_capture_frame(capture), nullability_source = capture)
  }

  rename_column_at <- function(value, position, old_name, new_name) {
    metrics <- new_capture_metrics()
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = metrics
    )
    position <- whole_number(position, "column position", inspected$descriptor$shape$columns)
    if (position < 1L || position > inspected$descriptor$shape$columns) {
      abort("stale-column", "the rename column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    if (!identical(inspected$descriptor$schema[[position]]$name, old_name)) {
      abort("stale-column", "the rename column name no longer matches the R dataframe")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, "")) {
      abort("invalid-column-name", "new_name must not be empty")
    }
    if (is_private_column_name(old_name) || is_private_column_name(new_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }

    column_names <- names(value)
    collisions <- which(column_names == new_name & seq_along(column_names) != position)
    if (length(collisions) != 0L) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::setnames(result, old = position, new = new_name)
    } else {
      result_names <- names(result)
      result_names[[position]] <- new_name
      names(result) <- result_names
    }

    renamed <- inspect_frame(
      result,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    source_ids <- vapply(inspected$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    renamed_ids <- vapply(renamed$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    if (!identical(source_ids, renamed_ids)) {
      abort("internal-error", "renaming a column changed its stable identity")
    }
    result
  }

  rename_column <- function(value, column_reference, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    rename_column_at(value, resolved$position, resolved$name, new_name)
  }

  clone_column_at <- function(value, position, old_name, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the clone column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    if (!identical(inspected$descriptor$schema[[position]]$name, old_name)) {
      abort("stale-column", "the clone column name no longer matches the R dataframe")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, "")) {
      abort("invalid-column-name", "new_name must not be empty")
    }
    if (is_private_column_name(old_name) || is_private_column_name(new_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (any(names(value) == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (column_count >= maximum_columns) {
      abort("invalid-view-query", "cloneColumn exceeds the supported R column limit")
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = new_name, value = result[[position]])
    } else {
      original_names <- names(result)
      result[[length(result) + 1L]] <- result[[position]]
      names(result) <- c(original_names, new_name)
    }
    result
  }

  clone_column <- function(value, column_reference, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    clone_column_at(value, resolved$position, resolved$name, new_name)
  }

  text_length_column_at <- function(value, position, old_name, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the text length column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    source_column <- inspected$descriptor$schema[[position]]
    if (!identical(source_column$name, old_name)) {
      abort("stale-column", "the text length column name no longer matches the R dataframe")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, "")) {
      abort("invalid-column-name", "new_name must not be empty")
    }
    if (is_private_column_name(old_name) || is_private_column_name(new_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (!source_column$semantics$kind %in% c("character", "factor")) {
      abort("invalid-view-query", "textLength requires a character or factor column")
    }
    if (any(names(value) == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (column_count >= maximum_columns) {
      abort("invalid-view-query", "textLength exceeds the supported R column limit")
    }

    result <- isolated_snapshot(value, inspected$flavor)
    lengths <- nchar(
      as.character(result[[position]]),
      type = "chars",
      allowNA = FALSE,
      keepNA = TRUE
    )
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = new_name, value = lengths)
    } else {
      original_names <- names(result)
      result[[length(result) + 1L]] <- lengths
      names(result) <- c(original_names, new_name)
    }
    result
  }

  text_length_column <- function(value, column_reference, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    text_length_column_at(value, resolved$position, resolved$name, new_name)
  }

  transform_text_column_at <- function(value, position, old_name, new_name, operation, transform) {
    operation_name <- switch(
      operation,
      lowerText = "Lowercase",
      upperText = "Uppercase",
      capitalizeText = "Capitalize",
      stripText = "Strip text",
      splitText = "Split text",
      findReplace = "Find and Replace",
      abort("internal-error", "the R text transform is unsupported")
    )
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", sprintf("the %s column position no longer matches the R dataframe", operation))
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    source_column <- inspected$descriptor$schema[[position]]
    if (!identical(source_column$name, old_name)) {
      abort("stale-column", sprintf("the %s column name no longer matches the R dataframe", operation))
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (!source_column$semantics$kind %in% c("character", "factor")) {
      abort("invalid-view-query", sprintf("%s requires a character or factor column", operation))
    }

    in_place <- is.null(new_name)
    if (!in_place) {
      new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
      if (identical(new_name, "")) {
        abort("invalid-column-name", "new_name must not be empty")
      }
      if (is_private_column_name(new_name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      in_place <- identical(new_name, old_name)
    }
    if (!in_place && any(names(value) == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (!in_place && column_count >= maximum_columns) {
      abort("invalid-view-query", sprintf("%s exceeds the supported R column limit", operation))
    }
    if (
      in_place &&
        identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort(
        "invalid-view-query",
        sprintf("%s cannot replace a data.table key column; choose a new output column", operation)
      )
    }

    result <- isolated_snapshot(value, inspected$flavor)
    source_values <- as.character(result[[position]])
    transformed <- vapply(seq_along(source_values), function(index) {
      if (is.na(source_values[[index]])) return(NA_character_)
      source_value <- bounded_utf8(source_values[[index]], sprintf("%s value %d", operation, index))
      output <- transform(source_value)
      if (
        identical(operation, "splitText") &&
          is.character(output) &&
          length(output) == 1L &&
          is.na(output)
      ) {
        return(NA_character_)
      }
      bounded_operation_output(output, operation_name)
    }, character(1L), USE.NAMES = FALSE)
    if (in_place) {
      if (identical(inspected$flavor, "r.data.table")) {
        data.table::set(result, j = position, value = transformed)
      } else {
        result[[position]] <- transformed
      }
    } else if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = new_name, value = transformed)
    } else {
      original_names <- names(result)
      result[[length(result) + 1L]] <- transformed
      names(result) <- c(original_names, new_name)
    }
    result
  }

  lower_text_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_text_column_at(value, position, old_name, new_name, "lowerText", tolower)
  }

  lower_text_column <- function(value, column_reference, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    lower_text_column_at(value, resolved$position, resolved$name, new_name)
  }

  upper_text_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_text_column_at(value, position, old_name, new_name, "upperText", toupper)
  }

  upper_text_column <- function(value, column_reference, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    upper_text_column_at(value, resolved$position, resolved$name, new_name)
  }

  capitalize_text_value <- function(value) {
    characters <- strsplit(value, "", fixed = TRUE)[[1L]]
    if (length(characters) == 0L) return("")
    paste0(
      toupper(characters[[1L]]),
      if (length(characters) == 1L) "" else tolower(paste0(characters[-1L], collapse = ""))
    )
  }

  capitalize_text_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_text_column_at(value, position, old_name, new_name, "capitalizeText", capitalize_text_value)
  }

  capitalize_text_column <- function(value, column_reference, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    capitalize_text_column_at(value, resolved$position, resolved$name, new_name)
  }

  strip_text_column_at <- function(value, position, old_name, characters = NULL, new_name = NULL) {
    if (is.null(characters)) {
      characters <- default_strip_characters
    } else {
      characters <- bounded_utf8(characters, "characters")
      if (identical(characters, "")) {
        abort("invalid-view-query", "stripText.characters must be a non-empty string or null")
      }
    }
    strip_characters <- unique(strsplit(characters, "", fixed = TRUE)[[1L]])
    strip_value <- function(source) {
      source_characters <- strsplit(source, "", fixed = TRUE)[[1L]]
      retained <- which(!source_characters %in% strip_characters)
      if (length(retained) == 0L) return("")
      paste0(source_characters[seq.int(retained[[1L]], retained[[length(retained)]])], collapse = "")
    }
    transform_text_column_at(value, position, old_name, new_name, "stripText", strip_value)
  }

  strip_text_column <- function(value, column_reference, characters = NULL, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    strip_text_column_at(value, resolved$position, resolved$name, characters, new_name)
  }

  split_text_value <- function(value, delimiter, index) {
    matches <- gregexpr(delimiter, value, fixed = TRUE)[[1L]]
    if (length(matches) == 1L && identical(as.integer(matches[[1L]]), -1L)) {
      return(if (identical(index, 0)) value else NA_character_)
    }
    part_count <- length(matches) + 1L
    if (index >= part_count) return(NA_character_)
    part <- as.integer(index) + 1L
    match_lengths <- attr(matches, "match.length", exact = TRUE)
    start <- if (part == 1L) 1L else matches[[part - 1L]] + match_lengths[[part - 1L]]
    end <- if (part <= length(matches)) matches[[part]] - 1L else nchar(value, type = "chars")
    if (start > end) "" else substr(value, start, end)
  }

  split_text_column_at <- function(value, position, old_name, delimiter, index, new_name) {
    delimiter <- bounded_utf8(delimiter, "delimiter")
    if (identical(delimiter, "")) {
      abort("invalid-view-query", "splitText.delimiter must be a non-empty string")
    }
    index <- whole_number(index, "index", .Machine$integer.max)
    if (is.null(new_name)) {
      abort("invalid-column-name", "splitText requires a new output column")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, old_name)) {
      abort("invalid-column-name", "splitText requires a new output column")
    }
    transform_text_column_at(
      value,
      position,
      old_name,
      new_name,
      "splitText",
      function(source) split_text_value(source, delimiter, index)
    )
  }

  split_text_column <- function(value, column_reference, delimiter, index, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    split_text_column_at(value, resolved$position, resolved$name, delimiter, index, new_name)
  }

  find_replace_column_at <- function(
    value,
    position,
    old_name,
    find,
    replacement,
    regex = FALSE,
    new_name = NULL
  ) {
    find <- bounded_utf8(find, "find")
    replacement <- bounded_utf8(replacement, "replacement")
    if (!is.logical(regex) || length(regex) != 1L || is.na(regex)) {
      abort("invalid-view-query", "findReplace.regex must be TRUE or FALSE")
    }
    operation_name <- "Find and Replace"
    reject_oversized_output <- function() {
      abort(
        "operation-output-too-large",
        sprintf("%s would produce text longer than %d UTF-8 bytes", operation_name, maximum_text_bytes)
      )
    }
    require_bounded_size <- function(bytes) {
      if (!is.finite(bytes) || bytes > maximum_text_bytes) reject_oversized_output()
    }
    checked_regex <- function(expression) {
      tryCatch(
        withCallingHandlers(
          force(expression),
          warning = function(warning) stop("regex evaluation failed", call. = FALSE)
        ),
        error = function(error) {
          abort("invalid-view-query", "Find and Replace could not apply the requested regular expression")
        }
      )
    }
    parse_regex_replacement <- function(value) {
      characters <- strsplit(value, "", fixed = TRUE)[[1L]]
      plain_literal_bytes <- 0
      case_literal_bytes <- 0
      plain_references <- integer(9L)
      case_references <- integer(9L)
      case_conversion <- FALSE
      add_literal <- function(character) {
        bytes <- as.double(nchar(character, type = "bytes"))
        if (case_conversion) {
          case_literal_bytes <<- case_literal_bytes + bytes
        } else {
          plain_literal_bytes <<- plain_literal_bytes + bytes
        }
      }
      index <- 1L
      while (index <= length(characters)) {
        character <- characters[[index]]
        if (!identical(character, "\\")) {
          add_literal(character)
          index <- index + 1L
          next
        }
        if (index == length(characters)) {
          add_literal("\\")
          break
        }
        escaped <- characters[[index + 1L]]
        if (identical(escaped, "\\")) {
          add_literal("\\")
        } else if (escaped %in% as.character(seq_len(9L))) {
          reference <- as.integer(escaped)
          if (case_conversion) {
            case_references[[reference]] <- case_references[[reference]] + 1L
          } else {
            plain_references[[reference]] <- plain_references[[reference]] + 1L
          }
        } else if (escaped %in% c("U", "L")) {
          case_conversion <- TRUE
        } else if (identical(escaped, "E")) {
          case_conversion <- FALSE
        } else {
          add_literal("\\")
          add_literal(escaped)
        }
        index <- index + 2L
      }
      list(
        plainLiteralBytes = plain_literal_bytes,
        caseLiteralBytes = case_literal_bytes,
        plainReferences = plain_references,
        caseReferences = case_references
      )
    }
    capture_bytes <- function(match_vector, capture_index, byte_prefix) {
      starts <- attr(match_vector, "capture.start", exact = TRUE)
      lengths <- attr(match_vector, "capture.length", exact = TRUE)
      if (
        is.null(starts) ||
          is.null(lengths) ||
          !is.matrix(starts) ||
          !is.matrix(lengths) ||
          ncol(starts) < capture_index ||
          ncol(lengths) < capture_index
      ) {
        return(0)
      }
      capture_starts <- starts[, capture_index]
      capture_lengths <- lengths[, capture_index]
      if (isTRUE(attr(match_vector, "useBytes", exact = TRUE))) {
        return(sum(as.double(capture_lengths[capture_starts >= 0L & capture_lengths > 0L])))
      }
      sum(vapply(seq_along(capture_starts), function(index) {
        start <- capture_starts[[index]]
        capture_length <- capture_lengths[[index]]
        if (start < 0L || capture_length <= 0L) return(0)
        end <- start + capture_length
        if (start < 1L || end > length(byte_prefix)) return(as.double(maximum_text_bytes))
        byte_prefix[[end]] - byte_prefix[[start]]
      }, numeric(1L), USE.NAMES = FALSE))
    }
    parsed_regex_replacement <- if (isTRUE(regex)) parse_regex_replacement(replacement) else NULL
    replace_value <- function(value) {
      input_bytes <- as.double(nchar(value, type = "bytes"))
      replacement_bytes <- as.double(nchar(replacement, type = "bytes"))
      if (isTRUE(regex)) {
        matches <- checked_regex(gregexpr(find, value, perl = TRUE))
        positions <- matches[[1L]]
        if (length(positions) == 1L && identical(as.integer(positions[[1L]]), -1L)) return(value)
        matched_values <- regmatches(value, matches)[[1L]]
        matched_bytes <- sum(as.double(nchar(matched_values, type = "bytes")))
        capture_byte_prefix <- if (isTRUE(attr(positions, "useBytes", exact = TRUE))) {
          NULL
        } else {
          c(0, cumsum(as.double(nchar(strsplit(value, "", fixed = TRUE)[[1L]], type = "bytes"))))
        }
        replacement_bound <- length(matched_values) * (
          parsed_regex_replacement$plainLiteralBytes +
            parsed_regex_replacement$caseLiteralBytes * 16
        )
        for (capture_index in seq_len(9L)) {
          capture_size <- capture_bytes(positions, capture_index, capture_byte_prefix)
          replacement_bound <- replacement_bound +
            parsed_regex_replacement$plainReferences[[capture_index]] * capture_size +
            parsed_regex_replacement$caseReferences[[capture_index]] * capture_size * 16
        }
        require_bounded_size(input_bytes - matched_bytes + replacement_bound)
        return(checked_regex(gsub(find, replacement, value, perl = TRUE)))
      }
      if (identical(find, "")) {
        require_bounded_size(input_bytes + (nchar(value, type = "chars") + 1) * replacement_bytes)
        literal_replacement <- gsub("\\", "\\\\", replacement, fixed = TRUE)
        return(gsub("", literal_replacement, value, perl = TRUE))
      }
      matches <- gregexpr(find, value, fixed = TRUE)[[1L]]
      match_count <- if (
        length(matches) == 1L && identical(as.integer(matches[[1L]]), -1L)
      ) 0 else length(matches)
      require_bounded_size(
        input_bytes + match_count * (replacement_bytes - nchar(find, type = "bytes"))
      )
      if (match_count == 0L) return(value)
      gsub(find, replacement, value, fixed = TRUE)
    }
    transform_text_column_at(
      value,
      position,
      old_name,
      new_name,
      "findReplace",
      replace_value
    )
  }

  find_replace_column <- function(
    value,
    column_reference,
    find,
    replacement,
    regex = FALSE,
    new_name = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    find_replace_column_at(
      value,
      resolved$position,
      resolved$name,
      find,
      replacement,
      regex,
      new_name
    )
  }

  round_integer64_values <- function(values, digits) {
    if (!requireNamespace("bit64", quietly = TRUE)) {
      abort("missing-package", "bit64 is required to round an integer64 column")
    }
    if (digits >= 0) return(values)

    places <- -digits
    present <- !is.na(values)
    if (!any(present)) return(values)
    zero <- bit64::as.integer64(0L)
    magnitude <- abs(values[present])
    if (places > 19) {
      rounded <- rep(zero, length(magnitude))
    } else if (places == 19) {
      half <- bit64::as.integer64("5000000000000000000")
      if (any(magnitude > half)) {
        abort("operation-output-too-large", "Round would produce a value outside the integer64 range")
      }
      rounded <- rep(zero, length(magnitude))
    } else {
      unit <- bit64::as.integer64(paste0("1", strrep("0", as.integer(places))))
      quotient <- magnitude %/% unit
      remainder <- magnitude %% unit
      half <- unit %/% bit64::as.integer64(2L)
      round_up <- remainder > half |
        (remainder == half & quotient %% bit64::as.integer64(2L) == bit64::as.integer64(1L))
      maximum_quotient <- bit64::as.integer64("9223372036854775807") %/% unit
      if (any(round_up & quotient >= maximum_quotient)) {
        abort("operation-output-too-large", "Round would produce a value outside the integer64 range")
      }
      quotient[round_up] <- quotient[round_up] + bit64::as.integer64(1L)
      rounded <- quotient * unit
    }
    rounded[values[present] < zero] <- -rounded[values[present] < zero]
    if (anyNA(rounded)) {
      abort("operation-output-too-large", "Round would produce a value outside the integer64 range")
    }
    result <- values
    result[present] <- rounded
    result
  }

  transform_numeric_column_at <- function(
    value,
    position,
    old_name,
    operation,
    digits = 0,
    new_name = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the numeric column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    source_column <- inspected$descriptor$schema[[position]]
    if (!identical(source_column$name, old_name)) {
      abort("stale-column", "the numeric column name no longer matches the R dataframe")
    }
    if (!source_column$semantics$kind %in% c("integer", "double", "integer64")) {
      abort("invalid-view-query", sprintf("%s requires a numeric R column", operation))
    }
    if (!operation %in% c("roundNumber", "floorNumber", "ceilNumber")) {
      abort("internal-error", "the R numeric transform is unsupported")
    }
    digits <- signed_whole_number(digits, "digits", .Machine$integer.max)
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (!is.null(new_name)) {
      new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
      if (identical(new_name, "")) abort("invalid-column-name", "new_name must not be empty")
      if (is_private_column_name(new_name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
    }
    in_place <- is.null(new_name) || identical(new_name, old_name)
    if (!in_place && any(names(value) == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (!in_place && column_count >= maximum_columns) {
      abort("invalid-view-query", sprintf("%s exceeds the supported R column limit", operation))
    }
    source_key <- if (identical(inspected$flavor, "r.data.table")) {
      data.table::key(value) %||% character()
    } else {
      character()
    }
    if (in_place && old_name %in% source_key) {
      abort(
        "invalid-view-query",
        sprintf("%s cannot replace a data.table key column; choose a new output column", operation)
      )
    }

    result <- isolated_snapshot(value, inspected$flavor)
    source_values <- result[[position]]
    transformed <- if (identical(source_column$semantics$kind, "integer64")) {
      if (identical(operation, "roundNumber")) round_integer64_values(source_values, digits) else source_values
    } else {
      switch(
        operation,
        roundNumber = base::round(source_values, digits = digits),
        floorNumber = base::floor(source_values),
        ceilNumber = base::ceiling(source_values)
      )
    }
    if (in_place) {
      if (identical(inspected$flavor, "r.data.table")) {
        data.table::set(result, j = position, value = transformed)
      } else {
        result[[position]] <- transformed
      }
    } else if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = new_name, value = transformed)
    } else {
      original_names <- names(result)
      result[[length(result) + 1L]] <- transformed
      names(result) <- c(original_names, new_name)
    }
    result
  }

  round_number_column_at <- function(value, position, old_name, digits = 0, new_name = NULL) {
    transform_numeric_column_at(value, position, old_name, "roundNumber", digits, new_name)
  }

  floor_number_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_numeric_column_at(value, position, old_name, "floorNumber", 0, new_name)
  }

  ceil_number_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_numeric_column_at(value, position, old_name, "ceilNumber", 0, new_name)
  }

  integer64_fill_value <- function(text, label) {
    if (!requireNamespace("bit64", quietly = TRUE)) {
      abort("missing-package", "bit64 is required to fill an integer64 column")
    }
    parsed <- suppressWarnings(bit64::as.integer64(validate_integer64_text(text, label)))
    if (is.na(parsed)) {
      abort("invalid-view-value", sprintf("%s is not representable by bit64", label))
    }
    parsed
  }

  exact_integer64_median <- function(values) {
    if (!requireNamespace("bit64", quietly = TRUE)) {
      abort("missing-package", "bit64 is required to calculate an integer64 median")
    }
    ordered <- sort(values)
    count <- length(ordered)
    lower <- ordered[[(count + 1L) %/% 2L]]
    upper <- ordered[[(count + 2L) %/% 2L]]
    if (count %% 2L == 1L) return(lower)
    zero <- bit64::as.integer64(0L)
    two <- bit64::as.integer64(2L)
    midpoint <- if ((lower < zero && upper < zero) || (lower >= zero && upper >= zero)) {
      difference <- upper - lower
      if (!identical(as.character(difference %% two), "0")) {
        abort("invalid-view-value", "the integer64 median is not an integer")
      }
      lower + difference %/% two
    } else {
      total <- lower + upper
      if (!identical(as.character(total %% two), "0")) {
        abort("invalid-view-value", "the integer64 median is not an integer")
      }
      total %/% two
    }
    if (is.na(midpoint)) abort("invalid-view-value", "the integer64 median is outside the supported range")
    midpoint
  }

  safe_float_midpoint <- function(lower, upper) {
    if (lower == upper) return(lower)
    if (is.finite(lower) && is.finite(upper)) {
      if ((lower < 0) == (upper < 0)) return(lower + ((upper - lower) / 2))
      return((lower / 2) + (upper / 2))
    }
    (lower + upper) / 2
  }

  fill_missing_value <- function(column, descriptor, replacement) {
    replacement <- exact_named_list_optional(
      replacement,
      "kind",
      "value",
      "replacement"
    )
    kind <- scalar_choice(
      replacement$kind,
      c("mean", "median", "mostFrequent", "string", "integer", "float", "decimal", "boolean", "date", "datetime"),
      "replacement$kind"
    )
    if (kind %in% c("mean", "median", "mostFrequent")) {
      if (!identical(names(replacement), "kind")) {
        abort("invalid-view-query", "a calculated replacement may not contain a value")
      }
    } else if (!setequal(names(replacement), c("kind", "value"))) {
      abort("invalid-view-query", "a typed replacement requires exactly one value")
    }

    semantic_kind <- descriptor$semantics$kind
    compatible <- switch(
      semantic_kind,
      character = kind %in% c("mostFrequent", "string"),
      factor = kind %in% c("mostFrequent", "string"),
      integer = kind %in% c("median", "integer"),
      integer64 = kind %in% c("median", "integer"),
      double = kind %in% c("mean", "median", "integer", "float"),
      logical = kind %in% c("mostFrequent", "boolean"),
      date = identical(kind, "date"),
      datetime = identical(kind, "datetime"),
      FALSE
    )
    if (!compatible) {
      abort("invalid-view-query", "the replacement is incompatible with the selected R column")
    }

    missing <- is.na(column)
    if (kind %in% c("mean", "median", "mostFrequent") && !any(missing)) {
      return(list(column = column, addedFactorLevel = FALSE))
    }
    if (identical(kind, "mean")) {
      present <- column[!missing]
      if (length(present) == 0L) {
        abort("invalid-view-value", "the mean is unavailable because the selected column has no present values")
      }
      has_positive_infinity <- any(is.infinite(present) & present > 0)
      has_negative_infinity <- any(is.infinite(present) & present < 0)
      if (has_positive_infinity && has_negative_infinity) {
        abort("invalid-view-value", "the selected column has no usable numeric mean")
      }
      if (has_positive_infinity) {
        fill <- Inf
      } else if (has_negative_infinity) {
        fill <- -Inf
      } else {
        scale <- max(abs(present))
        fill <- if (scale == 0) {
          0
        } else {
          max(-1, min(1, mean(present / scale))) * scale
        }
      }
      result <- column
      result[missing] <- fill
      return(list(column = result, addedFactorLevel = FALSE))
    }
    if (identical(kind, "median")) {
      present <- column[!missing]
      if (length(present) == 0L) {
        abort("invalid-view-value", "the median is unavailable because the selected column has no present values")
      }
      fill <- if (identical(semantic_kind, "integer64")) {
        exact_integer64_median(present)
      } else {
        ordered <- sort(present)
        count <- length(ordered)
        lower <- ordered[[(count + 1L) %/% 2L]]
        upper <- ordered[[(count + 2L) %/% 2L]]
        midpoint <- lower / 2 + upper / 2
        if (is.nan(midpoint)) {
          abort("invalid-view-value", "the selected column has no usable numeric median")
        }
        if (identical(semantic_kind, "integer")) {
          if (!is.finite(midpoint) || midpoint != floor(midpoint)) {
            abort("invalid-view-value", "the integer median is not an integer")
          }
          midpoint <- as.integer(midpoint)
          if (is.na(midpoint)) abort("invalid-view-value", "the integer median is outside the R integer range")
        }
        midpoint
      }
      result <- column
      result[missing] <- fill
      return(list(column = result, addedFactorLevel = FALSE))
    }
    if (identical(kind, "mostFrequent")) {
      present <- column[!missing]
      if (length(present) == 0L) {
        abort(
          "invalid-view-value",
          "This column has no non-missing values. Choose a specific value."
        )
      }
      candidates <- unique(present)
      counts <- tabulate(match(present, candidates), nbins = length(candidates))
      winners <- which(counts == max(counts))
      if (length(winners) != 1L) {
        abort(
          "invalid-view-value",
          sprintf(
            "This column has no single most common value: %d values are tied. Choose a specific value.",
            length(winners)
          )
        )
      }
      result <- column
      result[missing] <- candidates[[winners[[1L]]]]
      return(list(column = result, addedFactorLevel = FALSE))
    }

    value <- replacement$value
    if (identical(semantic_kind, "character")) {
      fill <- bounded_utf8(value, "replacement$value")
      result <- column
      result[missing] <- fill
      return(list(column = result, addedFactorLevel = FALSE))
    }
    if (identical(semantic_kind, "factor")) {
      fill <- bounded_utf8(value, "replacement$value")
      if (!any(missing)) return(list(column = column, addedFactorLevel = FALSE))
      source_levels <- levels(column)
      added <- !fill %in% source_levels
      target_levels <- if (added) c(source_levels, fill) else source_levels
      result <- factor(as.character(column), levels = target_levels, ordered = is.ordered(column))
      result[missing] <- fill
      return(list(column = result, addedFactorLevel = added))
    }
    if (identical(semantic_kind, "integer")) {
      text <- normalize_integer_text(value, "replacement$value")
      numeric_value <- suppressWarnings(as.double(text))
      if (!is.finite(numeric_value) || numeric_value < -2147483647 || numeric_value > 2147483647) {
        abort("invalid-view-value", "replacement$value is outside the R integer range")
      }
      fill <- as.integer(numeric_value)
    } else if (identical(semantic_kind, "integer64")) {
      text <- normalize_integer_text(value, "replacement$value")
      fill <- integer64_fill_value(text, "replacement$value")
    } else if (identical(semantic_kind, "double")) {
      fill <- parse_finite_number(value, "replacement$value")
    } else if (identical(semantic_kind, "logical")) {
      fill <- parse_boolean(value, "replacement$value")
    } else if (identical(semantic_kind, "date")) {
      fill <- as.Date(as.double(parse_date_key(value, "replacement$value")), origin = "1970-01-01")
    } else if (identical(semantic_kind, "datetime")) {
      fill <- as.double(parse_datetime_key(value, descriptor$semantics, "replacement$value"))
    } else {
      abort("invalid-view-query", "the selected R column cannot be filled")
    }
    result <- column
    result[missing] <- fill
    list(column = result, addedFactorLevel = FALSE)
  }

  fill_missing_column_at <- function(value, position, old_name, replacement) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    descriptor <- inspected$descriptor$schema[[position]]
    if (!identical(descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    filled <- fill_missing_value(value[[position]], descriptor, replacement)
    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = filled$column)
    } else {
      result[[position]] <- filled$column
    }
    result
  }

  fill_missing_column <- function(value, column_reference, replacement) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    fill_missing_column_at(value, resolved$position, resolved$name, replacement)
  }

  fill_missing_from_fallback_columns_at <- function(
    value,
    position,
    old_name,
    fallback_positions,
    fallback_names
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    target_descriptor <- inspected$descriptor$schema[[position]]
    if (!identical(target_descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    if (
      !is.numeric(fallback_positions) ||
        anyNA(fallback_positions) ||
        any(!is.finite(fallback_positions)) ||
        any(fallback_positions != floor(fallback_positions)) ||
        length(fallback_positions) == 0L ||
        length(fallback_positions) > maximum_fill_fallback_columns ||
        any(fallback_positions < 1L) ||
        any(fallback_positions > column_count) ||
        anyDuplicated(fallback_positions) ||
        any(fallback_positions == position) ||
        !is.character(fallback_names) ||
        anyNA(fallback_names) ||
        length(fallback_names) != length(fallback_positions)
    ) {
      abort("invalid-view-query", "the fallback-column selection is invalid")
    }
    fallback_positions <- as.integer(fallback_positions)
    fallback_names <- vapply(seq_along(fallback_names), function(index) {
      name <- bounded_utf8(fallback_names[[index]], sprintf("fallback_names[[%d]]", index), maximum_name_bytes)
      if (is_private_column_name(name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      if (!identical(inspected$descriptor$schema[[fallback_positions[[index]]]]$name, name)) {
        abort("stale-column", "a fallback column name no longer matches the R dataframe")
      }
      name
    }, character(1L), USE.NAMES = FALSE)

    target_kind <- target_descriptor$semantics$kind
    compatible_fallback_kind <- function(fallback_kind) {
      if (target_kind %in% c("character", "factor")) return(fallback_kind %in% c("character", "factor"))
      if (target_kind %in% c("integer", "integer64")) return(fallback_kind %in% c("integer", "integer64"))
      identical(fallback_kind, target_kind) && target_kind %in% c("double", "logical", "date", "datetime")
    }
    fallback_descriptors <- lapply(fallback_positions, function(fallback_position) {
      descriptor <- inspected$descriptor$schema[[fallback_position]]
      if (!compatible_fallback_kind(descriptor$semantics$kind)) {
        abort(
          "invalid-view-query",
          sprintf("fallback column %s is incompatible with the selected R column", descriptor$name)
        )
      }
      descriptor
    })

    result_values <- value[[position]]
    if (identical(target_kind, "factor")) {
      result_text <- as.character(result_values)
      target_levels <- levels(result_values)
      for (index in seq_along(fallback_positions)) {
        fallback_text <- as.character(value[[fallback_positions[[index]]]])
        use <- is.na(result_text) & !is.na(fallback_text)
        if (!any(use)) next
        additions <- unique(fallback_text[use])
        additions <- additions[!additions %in% target_levels]
        if (length(target_levels) + length(additions) > maximum_factor_levels) {
          abort("factor-levels-too-large", sprintf("the filled factor has more than %d levels", maximum_factor_levels))
        }
        target_levels <- c(target_levels, additions)
        result_text[use] <- fallback_text[use]
      }
      result_values <- factor(result_text, levels = target_levels, ordered = is.ordered(result_values))
    } else {
      for (index in seq_along(fallback_positions)) {
        fallback_values <- value[[fallback_positions[[index]]]]
        use <- is.na(result_values) & !is.na(fallback_values)
        if (!any(use)) next
        fallback_kind <- fallback_descriptors[[index]]$semantics$kind
        converted <- if (identical(target_kind, "character")) {
          as.character(fallback_values[use])
        } else if (identical(target_kind, "integer") && identical(fallback_kind, "integer64")) {
          if (!requireNamespace("bit64", quietly = TRUE)) {
            abort("missing-package", "bit64 is required to fill an integer column from integer64")
          }
          selected <- fallback_values[use]
          minimum <- bit64::as.integer64("-2147483647")
          maximum <- bit64::as.integer64("2147483647")
          if (any(selected < minimum | selected > maximum)) {
            abort("invalid-view-value", "a fallback integer64 value is outside the R integer range")
          }
          as.integer(as.character(selected))
        } else if (identical(target_kind, "integer64") && identical(fallback_kind, "integer")) {
          if (!requireNamespace("bit64", quietly = TRUE)) {
            abort("missing-package", "bit64 is required to fill an integer64 column")
          }
          bit64::as.integer64(fallback_values[use])
        } else {
          fallback_values[use]
        }
        result_values[use] <- converted
      }
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = result_values)
    } else {
      result[[position]] <- result_values
    }
    result
  }

  fill_missing_directional_at <- function(
    value,
    position,
    old_name,
    order_positions,
    order_names,
    order_directions,
    order_nulls,
    direction,
    max_gap = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    target_descriptor <- inspected$descriptor$schema[[position]]
    if (!identical(target_descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    if (
      !is.numeric(order_positions) ||
        anyNA(order_positions) ||
        any(!is.finite(order_positions)) ||
        any(order_positions != floor(order_positions)) ||
        length(order_positions) == 0L ||
        length(order_positions) > min(maximum_sort_rules, column_count) ||
        any(order_positions < 1L) ||
        any(order_positions > column_count) ||
        anyDuplicated(order_positions) ||
        any(order_positions == position) ||
        !is.character(order_names) ||
        anyNA(order_names) ||
        length(order_names) != length(order_positions) ||
        !is.character(order_directions) ||
        anyNA(order_directions) ||
        length(order_directions) != length(order_positions) ||
        any(!order_directions %in% c("asc", "desc")) ||
        !is.character(order_nulls) ||
        anyNA(order_nulls) ||
        length(order_nulls) != length(order_positions) ||
        any(!order_nulls %in% c("first", "last"))
    ) {
      abort("invalid-view-query", "the directional ordering selection is invalid")
    }
    order_positions <- as.integer(order_positions)
    order_names <- vapply(seq_along(order_names), function(index) {
      name <- bounded_utf8(order_names[[index]], sprintf("order_names[[%d]]", index), maximum_name_bytes)
      if (!identical(inspected$descriptor$schema[[order_positions[[index]]]]$name, name)) {
        abort("stale-column", "a directional ordering column no longer matches the R dataframe")
      }
      name
    }, character(1L), USE.NAMES = FALSE)
    direction <- scalar_choice(direction, c("forward", "backward"), "direction")
    if (!is.null(max_gap)) {
      max_gap <- whole_number(max_gap, "max_gap", maximum_fill_directional_gap)
      if (max_gap < 1L) abort("invalid-range", "max_gap must be positive")
      max_gap <- as.integer(max_gap)
    }

    row_positions <- seq_len(inspected$descriptor$shape$rows)
    for (rule_index in rev(seq_along(order_positions))) {
      rule_position <- order_positions[[rule_index]]
      column <- value[[rule_position]][row_positions]
      missing <- is.na(column)
      missing_positions <- row_positions[missing]
      present_positions <- which(!missing)
      present_order <- order_present_values(
        column[present_positions],
        inspected$descriptor$schema[[rule_position]]$semantics,
        identical(order_directions[[rule_index]], "desc")
      )
      ordered_present <- row_positions[present_positions[present_order]]
      row_positions <- if (identical(order_nulls[[rule_index]], "first")) {
        c(missing_positions, ordered_present)
      } else {
        c(ordered_present, missing_positions)
      }
    }

    result_values <- value[[position]]
    ordered_missing <- is.na(result_values[row_positions])
    if (length(ordered_missing) > 0L && any(ordered_missing)) {
      runs <- rle(ordered_missing)
      run_ends <- cumsum(runs$lengths)
      run_starts <- run_ends - runs$lengths + 1L
      missing_runs <- which(runs$values)
      for (run_index in missing_runs) {
        run_length <- runs$lengths[[run_index]]
        if (!is.null(max_gap) && run_length > max_gap) next
        start <- run_starts[[run_index]]
        end <- run_ends[[run_index]]
        donor <- if (identical(direction, "forward")) start - 1L else end + 1L
        if (donor < 1L || donor > length(row_positions)) next
        donor_position <- row_positions[[donor]]
        if (is.na(result_values[donor_position])) next
        result_values[row_positions[start:end]] <- result_values[donor_position]
      }
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = result_values)
    } else {
      result[[position]] <- result_values
    }
    result
  }

  fill_missing_linear_interpolation_at <- function(
    value,
    position,
    old_name,
    coordinate_position,
    coordinate_name,
    max_gap = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    coordinate_position <- whole_number(coordinate_position, "coordinate column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    if (coordinate_position < 1L || coordinate_position > column_count) {
      abort("stale-column", "the interpolation coordinate position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    coordinate_position <- as.integer(coordinate_position)
    if (identical(position, coordinate_position)) {
      abort("invalid-view-query", "the fill target cannot also be the interpolation coordinate")
    }
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    coordinate_name <- bounded_utf8(coordinate_name, "coordinate_name", maximum_name_bytes)
    target_descriptor <- inspected$descriptor$schema[[position]]
    coordinate_descriptor <- inspected$descriptor$schema[[coordinate_position]]
    if (!identical(target_descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (!identical(coordinate_descriptor$name, coordinate_name)) {
      abort("stale-column", "the interpolation coordinate name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name) || is_private_column_name(coordinate_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    if (!identical(target_descriptor$semantics$kind, "double")) {
      abort("invalid-view-query", "linear interpolation requires a floating-point R target column")
    }
    coordinate_kind <- coordinate_descriptor$semantics$kind
    if (!coordinate_kind %in% c("integer", "double", "date", "datetime")) {
      abort("invalid-view-query", "linear interpolation requires a numeric, Date, or POSIXct coordinate column")
    }
    if (!is.null(max_gap)) {
      max_gap <- whole_number(max_gap, "max_gap", maximum_fill_directional_gap)
      if (max_gap < 1L) abort("invalid-range", "max_gap must be positive")
      max_gap <- as.integer(max_gap)
    }

    coordinate_values <- as.double(value[[coordinate_position]])
    if (anyNA(coordinate_values) || any(!is.finite(coordinate_values))) {
      abort("invalid-view-value", "every interpolation coordinate must be present and finite")
    }
    if (anyDuplicated(coordinate_values)) {
      abort("invalid-view-value", "interpolation coordinates must be unique")
    }
    row_positions <- order(coordinate_values, method = "radix")
    result_values <- value[[position]]
    ordered_values <- result_values[row_positions]
    ordered_missing <- is.na(ordered_values)
    if (length(ordered_missing) > 0L && any(ordered_missing)) {
      runs <- rle(ordered_missing)
      run_ends <- cumsum(runs$lengths)
      run_starts <- run_ends - runs$lengths + 1L
      for (run_index in which(runs$values)) {
        run_length <- runs$lengths[[run_index]]
        if (!is.null(max_gap) && run_length > max_gap) next
        start <- run_starts[[run_index]]
        end <- run_ends[[run_index]]
        left <- start - 1L
        right <- end + 1L
        if (left < 1L || right > length(row_positions)) next
        left_value <- ordered_values[[left]]
        right_value <- ordered_values[[right]]
        if (!is.finite(left_value) || !is.finite(right_value)) next

        left_coordinate <- coordinate_values[[row_positions[[left]]]]
        right_coordinate <- coordinate_values[[row_positions[[right]]]]
        coordinate_width <- right_coordinate - left_coordinate
        scaled <- !is.finite(coordinate_width)
        if (scaled) {
          coordinate_scale <- max(abs(left_coordinate), abs(right_coordinate))
          scaled_left <- left_coordinate / coordinate_scale
          scaled_right <- right_coordinate / coordinate_scale
          coordinate_width <- scaled_right - scaled_left
        }
        if (!is.finite(coordinate_width) || coordinate_width <= 0) {
          abort("invalid-view-value", "interpolation coordinates cannot be represented safely")
        }
        for (ordered_index in start:end) {
          coordinate <- coordinate_values[[row_positions[[ordered_index]]]]
          weight <- if (scaled) {
            (coordinate / coordinate_scale - scaled_left) / coordinate_width
          } else {
            (coordinate - left_coordinate) / coordinate_width
          }
          if (!is.finite(weight) || weight <= 0 || weight >= 1) {
            abort("invalid-view-value", "interpolation coordinates cannot be represented safely")
          }
          interpolated <- if (sign(left_value) == sign(right_value)) {
            left_value + (right_value - left_value) * weight
          } else {
            left_value * (1 - weight) + right_value * weight
          }
          if (!is.finite(interpolated)) {
            abort("invalid-view-value", "linear interpolation produced a non-finite value")
          }
          result_values[[row_positions[[ordered_index]]]] <- interpolated
        }
      }
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = result_values)
    } else {
      result[[position]] <- result_values
    }
    result
  }

  fill_missing_grouped_statistic_at <- function(
    value,
    position,
    old_name,
    key_positions,
    key_names,
    statistic
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    target_descriptor <- inspected$descriptor$schema[[position]]
    if (!identical(target_descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    if (
      !is.numeric(key_positions) ||
        anyNA(key_positions) ||
        any(!is.finite(key_positions)) ||
        any(key_positions != floor(key_positions)) ||
        length(key_positions) == 0L ||
        length(key_positions) > column_count ||
        any(key_positions < 1L) ||
        any(key_positions > column_count) ||
        anyDuplicated(key_positions) ||
        any(key_positions == position) ||
        !is.character(key_names) ||
        anyNA(key_names) ||
        length(key_names) != length(key_positions)
    ) {
      abort("invalid-view-query", "the grouped-fill key selection is invalid")
    }
    key_positions <- as.integer(key_positions)
    supported_key_kinds <- c(
      "character", "factor", "integer", "integer64", "double", "logical", "date", "datetime", "difftime"
    )
    key_names <- vapply(seq_along(key_names), function(index) {
      name <- bounded_utf8(key_names[[index]], sprintf("key_names[[%d]]", index), maximum_name_bytes)
      if (is_private_column_name(name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      descriptor <- inspected$descriptor$schema[[key_positions[[index]]]]
      if (!identical(descriptor$name, name)) {
        abort("stale-column", "a grouped-fill key no longer matches the R dataframe")
      }
      if (!descriptor$semantics$kind %in% supported_key_kinds) {
        abort("invalid-view-query", sprintf("R %s columns cannot be used as grouped-fill keys", descriptor$semantics$kind))
      }
      name
    }, character(1L), USE.NAMES = FALSE)
    statistic <- scalar_choice(statistic, c("median", "mean", "mostFrequent"), "statistic")
    target_kind <- target_descriptor$semantics$kind
    compatible <- switch(
      statistic,
      mean = identical(target_kind, "double"),
      median = target_kind %in% c("integer", "integer64", "double"),
      mostFrequent = target_kind %in% c("character", "factor", "logical"),
      FALSE
    )
    if (!compatible) {
      abort("invalid-view-query", "the grouped statistic is incompatible with the selected R column")
    }

    row_positions <- seq_len(inspected$descriptor$shape$rows)
    for (key_index in rev(seq_along(key_positions))) {
      key_position <- key_positions[[key_index]]
      key_values <- value[[key_position]][row_positions]
      key_missing <- is.na(key_values)
      present_positions <- which(!key_missing)
      present_order <- order_present_values(
        key_values[present_positions],
        inspected$descriptor$schema[[key_position]]$semantics,
        FALSE
      )
      row_positions <- c(row_positions[key_missing], row_positions[present_positions[present_order]])
    }

    result_values <- value[[position]]
    row_count <- length(row_positions)
    if (row_count > 0L && anyNA(result_values)) {
      same_group <- rep(TRUE, max(0L, row_count - 1L))
      if (row_count > 1L) {
        left_rows <- row_positions[-row_count]
        right_rows <- row_positions[-1L]
        for (key_position in key_positions) {
          left <- value[[key_position]][left_rows]
          right <- value[[key_position]][right_rows]
          left_missing <- is.na(left)
          right_missing <- is.na(right)
          equal <- (left_missing & right_missing) | (!left_missing & !right_missing & left == right)
          equal[is.na(equal)] <- FALSE
          same_group <- same_group & equal
        }
      }
      group_starts <- c(1L, which(!same_group) + 1L)
      group_ends <- c(group_starts[-1L] - 1L, row_count)
      for (group_index in seq_along(group_starts)) {
        group_rows <- row_positions[group_starts[[group_index]]:group_ends[[group_index]]]
        missing_rows <- group_rows[is.na(result_values[group_rows])]
        if (length(missing_rows) == 0L) next
        present <- result_values[group_rows[!is.na(result_values[group_rows])]]
        if (length(present) == 0L) next

        fill <- NULL
        if (identical(statistic, "mean")) {
          has_positive_infinity <- any(is.infinite(present) & present > 0)
          has_negative_infinity <- any(is.infinite(present) & present < 0)
          if (has_positive_infinity && has_negative_infinity) next
          if (has_positive_infinity) {
            fill <- Inf
          } else if (has_negative_infinity) {
            fill <- -Inf
          } else {
            scale <- max(abs(present))
            fill <- if (scale == 0) 0 else max(-1, min(1, mean(present / scale))) * scale
          }
        } else if (identical(statistic, "median")) {
          fill <- if (identical(target_kind, "integer64")) {
            exact_integer64_median(present)
          } else {
            ordered <- sort(present)
            count <- length(ordered)
            lower <- ordered[[(count + 1L) %/% 2L]]
            upper <- ordered[[(count + 2L) %/% 2L]]
            midpoint <- if (count %% 2L == 1L) {
              lower
            } else if (identical(target_kind, "double")) {
              safe_float_midpoint(lower, upper)
            } else {
              lower / 2 + upper / 2
            }
            if (is.nan(midpoint)) next
            if (identical(target_kind, "integer")) {
              if (!is.finite(midpoint) || midpoint != floor(midpoint)) {
                abort("invalid-view-value", "a grouped integer median is not an integer")
              }
              midpoint <- as.integer(midpoint)
              if (is.na(midpoint)) {
                abort("invalid-view-value", "a grouped integer median is outside the R integer range")
              }
            }
            midpoint
          }
        } else {
          candidates <- unique(present)
          counts <- tabulate(match(present, candidates), nbins = length(candidates))
          winners <- which(counts == max(counts))
          if (length(winners) != 1L) next
          fill <- candidates[[winners[[1L]]]]
        }
        result_values[missing_rows] <- fill
      }
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = result_values)
    } else {
      result[[position]] <- result_values
    }
    result
  }

  cast_text_source <- function(column, kind, label) {
    values <- if (identical(kind, "factor")) as.character(column) else column
    if (!is.character(values)) {
      abort("internal-error", sprintf("%s did not resolve to text", label))
    }
    vapply(seq_along(values), function(index) {
      value <- values[[index]]
      if (is.na(value)) return(NA_character_)
      bounded_utf8(value, sprintf("%s value %d", label, index))
    }, character(1L), USE.NAMES = FALSE)
  }

  cast_string_values <- function(column, semantics, label) {
    kind <- semantics$kind
    values <- if (kind %in% c("character", "factor")) {
      cast_text_source(column, kind, label)
    } else if (identical(kind, "logical")) {
      ifelse(is.na(column), NA_character_, ifelse(column, "TRUE", "FALSE"))
    } else if (identical(kind, "integer")) {
      as.character(column)
    } else if (identical(kind, "integer64")) {
      as.character(column)
    } else if (identical(kind, "double")) {
      vapply(seq_along(column), function(index) {
        value <- column[[index]]
        if (is.nan(value)) return("NaN")
        if (is.na(value)) return(NA_character_)
        if (is.infinite(value)) return(if (value < 0) "-Inf" else "Inf")
        exact_double(value)
      }, character(1L), USE.NAMES = FALSE)
    } else if (identical(kind, "date")) {
      format(column, format = "%Y-%m-%d")
    } else if (identical(kind, "datetime")) {
      format(column, tz = "UTC", format = "%Y-%m-%dT%H:%M:%OS6Z", usetz = FALSE)
    } else if (identical(kind, "difftime")) {
      units <- semantics$units
      numeric_values <- as.double(column, units = units)
      vapply(seq_along(numeric_values), function(index) {
        value <- numeric_values[[index]]
        if (is.na(value)) return(NA_character_)
        paste(exact_double(value), units)
      }, character(1L), USE.NAMES = FALSE)
    } else {
      abort("internal-error", "castColumn encountered an unknown R source kind")
    }
    vapply(seq_along(values), function(index) {
      value <- values[[index]]
      if (is.na(value)) return(NA_character_)
      bounded_utf8(value, sprintf("%s result %d", label, index))
    }, character(1L), USE.NAMES = FALSE)
  }

  cast_date_text <- function(values) {
    result <- structure(rep(NA_real_, length(values)), class = "Date")
    valid <- !is.na(values) & grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", values, perl = TRUE)
    if (any(valid)) {
      result[valid] <- suppressWarnings(as.Date(values[valid], format = "%Y-%m-%d"))
    }
    cast_canonical_dates(result)
  }

  cast_canonical_dates <- function(values) {
    result <- values
    present <- !is.na(result)
    if (!any(present)) return(result)
    rendered <- format(result[present], format = "%Y-%m-%d")
    canonical <- grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", rendered, perl = TRUE) &
      !startsWith(rendered, "0000-")
    if (any(canonical)) {
      reparsed <- suppressWarnings(as.Date(rendered[canonical], format = "%Y-%m-%d"))
      canonical[canonical] <- !is.na(reparsed) & reparsed == result[present][canonical]
    }
    result[which(present)[!canonical]] <- as.Date(NA_character_)
    result
  }

  cast_canonical_datetimes <- function(values) {
    result <- values
    present <- !is.na(result)
    if (!any(present)) return(result)
    rendered <- format(result[present], tz = "UTC", format = "%Y-%m-%dT%H:%M:%OS6", usetz = FALSE)
    canonical <- grepl(
      "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}$",
      rendered,
      perl = TRUE
    ) & !startsWith(rendered, "0000-")
    result[which(present)[!canonical]] <- as.POSIXct(NA_real_, origin = "1970-01-01", tz = "UTC")
    result
  }

  cast_datetime_text <- function(values) {
    result <- structure(
      rep(NA_real_, length(values)),
      class = c("POSIXct", "POSIXt"),
      tzone = "UTC"
    )
    date_values <- !is.na(values) & grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", values, perl = TRUE)
    if (any(date_values)) {
      parsed_dates <- suppressWarnings(as.Date(values[date_values], format = "%Y-%m-%d"))
      result[date_values] <- as.POSIXct(parsed_dates, tz = "UTC")
    }
    datetime_values <- !is.na(values) & grepl(
      "^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z?$",
      values,
      perl = TRUE
    )
    if (any(datetime_values)) {
      normalized <- sub(" ", "T", values[datetime_values], fixed = TRUE)
      normalized <- sub("Z$", "", normalized, perl = TRUE)
      parsed <- suppressWarnings(strptime(normalized, format = "%Y-%m-%dT%H:%M:%OS", tz = "UTC"))
      result[datetime_values] <- as.POSIXct(parsed, tz = "UTC")
    }
    cast_canonical_datetimes(result)
  }

  cast_column_values <- function(column, semantics, raw_type, dtype, label) {
    source_kind <- semantics$kind
    supported_sources <- switch(
      dtype,
      string = c("logical", "integer", "double", "character", "factor", "date", "datetime", "difftime", "integer64"),
      integer = c("logical", "integer", "double", "character", "factor", "integer64"),
      float = c("logical", "integer", "double", "character", "factor"),
      boolean = c("logical", "integer", "double", "character", "factor"),
      date = c("character", "factor", "date", "datetime"),
      datetime = c("character", "factor", "date", "datetime")
    )
    if (!source_kind %in% supported_sources) {
      abort(
        "invalid-view-query",
        sprintf("castColumn cannot convert an R %s column to %s", raw_type, dtype)
      )
    }

    if (identical(dtype, "string")) return(cast_string_values(column, semantics, label))
    if (identical(dtype, "integer")) {
      if (identical(source_kind, "integer64") || identical(source_kind, "integer")) return(column)
      if (identical(source_kind, "logical") || identical(source_kind, "double")) {
        return(suppressWarnings(as.integer(column)))
      }
      text <- cast_text_source(column, source_kind, label)
      return(suppressWarnings(as.integer(trimws(text))))
    }
    if (identical(dtype, "float")) {
      if (identical(source_kind, "double")) return(column)
      if (source_kind %in% c("logical", "integer")) return(as.double(column))
      text <- cast_text_source(column, source_kind, label)
      return(suppressWarnings(as.double(trimws(text))))
    }
    if (identical(dtype, "boolean")) {
      if (identical(source_kind, "logical")) return(column)
      if (source_kind %in% c("integer", "double")) return(suppressWarnings(as.logical(column)))
      text <- cast_text_source(column, source_kind, label)
      return(suppressWarnings(as.logical(trimws(text))))
    }
    if (identical(dtype, "date")) {
      if (identical(source_kind, "date")) return(cast_canonical_dates(column))
      if (identical(source_kind, "datetime")) return(cast_canonical_dates(as.Date(column, tz = "UTC")))
      return(cast_date_text(cast_text_source(column, source_kind, label)))
    }
    if (identical(dtype, "datetime")) {
      if (identical(source_kind, "datetime")) {
        return(cast_canonical_datetimes(
          structure(as.double(column), class = c("POSIXct", "POSIXt"), tzone = "UTC")
        ))
      }
      if (identical(source_kind, "date")) {
        return(cast_canonical_datetimes(as.POSIXct(cast_canonical_dates(column), tz = "UTC")))
      }
      return(cast_datetime_text(cast_text_source(column, source_kind, label)))
    }
    abort("internal-error", "castColumn encountered an unknown target dtype")
  }

  cast_column_at <- function(value, position, old_name, dtype) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the cast column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    source_column <- inspected$descriptor$schema[[position]]
    if (!identical(source_column$name, old_name)) {
      abort("stale-column", "the cast column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      !is.character(dtype) ||
        length(dtype) != 1L ||
        is.na(dtype) ||
        !dtype %in% c("string", "integer", "float", "boolean", "date", "datetime")
    ) {
      abort("invalid-view-query", "dtype must be one of: boolean, date, datetime, float, integer, string")
    }
    source_key <- if (identical(inspected$flavor, "r.data.table")) {
      data.table::key(value) %||% character()
    } else {
      character()
    }
    if (old_name %in% source_key) {
      abort(
        "invalid-view-query",
        "castColumn cannot replace a data.table key column; clone the column before casting it"
      )
    }

    result <- isolated_snapshot(value, inspected$flavor)
    converted <- cast_column_values(
      result[[position]],
      source_column$semantics,
      source_column$rawType,
      dtype,
      "castColumn"
    )
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = converted)
      if (!identical(data.table::key(result) %||% character(), source_key)) {
        abort("internal-error", "castColumn changed a retained data.table key")
      }
    } else {
      result[[position]] <- converted
    }
    result
  }

  cast_column <- function(value, column_reference, dtype) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    cast_column_at(value, resolved$position, resolved$name, dtype)
  }

  drop_columns_at <- function(value, positions, expected_names) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    if (
      !is.numeric(positions) ||
        anyNA(positions) ||
        any(!is.finite(positions)) ||
        any(positions != floor(positions)) ||
        length(positions) == 0L ||
        any(positions < 1L) ||
        any(positions > column_count) ||
        anyDuplicated(positions)
    ) {
      abort("stale-column", "the drop column positions no longer match the R dataframe")
    }
    positions <- as.integer(positions)
    if (!is.character(expected_names) || length(expected_names) != length(positions) || anyNA(expected_names)) {
      abort("stale-column", "the drop column names no longer match the R dataframe")
    }
    expected_names <- vapply(seq_along(expected_names), function(index) {
      bounded_utf8(expected_names[[index]], sprintf("expected_names[[%d]]", index), maximum_name_bytes)
    }, character(1L), USE.NAMES = FALSE)
    if (!identical(names(value)[positions], expected_names)) {
      abort("stale-column", "the drop column names no longer match the R dataframe")
    }
    if (any(vapply(expected_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (length(positions) >= column_count) {
      abort("invalid-view-query", "dropColumns must leave at least one visible column")
    }

    keep_positions <- setdiff(seq_len(column_count), positions)
    if (identical(inspected$flavor, "r.data.table")) {
      result <- isolated_snapshot(value, inspected$flavor)[, keep_positions, with = FALSE]
    } else {
      result <- isolated_snapshot(value, inspected$flavor)
      for (position in sort(positions, decreasing = TRUE)) result[[position]] <- NULL
    }
    result
  }

  drop_columns <- function(value, column_references) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    if (
      !is.list(column_references) ||
        is.object(column_references) ||
        !is.null(attributes(column_references)) ||
        length(column_references) == 0L
    ) {
      abort("invalid-view-query", "column_references must be a non-empty unnamed list")
    }
    resolved <- lapply(seq_along(column_references), function(index) {
      resolve_column_reference(
        column_references[[index]],
        inspected$descriptor,
        sprintf("column_references[[%d]]", index)
      )
    })
    column_ids <- vapply(resolved, `[[`, character(1L), "columnId", USE.NAMES = FALSE)
    if (anyDuplicated(column_ids)) {
      abort("invalid-view-query", "column_references may address each column only once")
    }
    positions <- vapply(resolved, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    expected_names <- vapply(resolved, `[[`, character(1L), "name", USE.NAMES = FALSE)
    drop_columns_at(value, positions, expected_names)
  }

  select_columns_at <- function(value, positions, expected_names) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    if (
      !is.numeric(positions) ||
        anyNA(positions) ||
        any(!is.finite(positions)) ||
        any(positions != floor(positions)) ||
        length(positions) == 0L ||
        any(positions < 1L) ||
        any(positions > column_count) ||
        anyDuplicated(positions)
    ) {
      abort("stale-column", "the selected column positions no longer match the R dataframe")
    }
    positions <- as.integer(positions)
    if (!is.character(expected_names) || length(expected_names) != length(positions) || anyNA(expected_names)) {
      abort("stale-column", "the selected column names no longer match the R dataframe")
    }
    expected_names <- vapply(seq_along(expected_names), function(index) {
      bounded_utf8(expected_names[[index]], sprintf("expected_names[[%d]]", index), maximum_name_bytes)
    }, character(1L), USE.NAMES = FALSE)
    if (!identical(names(value)[positions], expected_names)) {
      abort("stale-column", "the selected column names no longer match the R dataframe")
    }
    if (any(vapply(expected_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      result <- result[, positions, with = FALSE]
    } else {
      result <- result[positions]
      names(result) <- expected_names
    }
    result
  }

  select_columns <- function(value, column_references) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    if (
      !is.list(column_references) ||
        is.object(column_references) ||
        !is.null(attributes(column_references)) ||
        length(column_references) == 0L
    ) {
      abort("invalid-view-query", "column_references must be a non-empty unnamed list")
    }
    resolved <- lapply(seq_along(column_references), function(index) {
      resolve_column_reference(
        column_references[[index]],
        inspected$descriptor,
        sprintf("column_references[[%d]]", index)
      )
    })
    column_ids <- vapply(resolved, `[[`, character(1L), "columnId", USE.NAMES = FALSE)
    if (anyDuplicated(column_ids)) {
      abort("invalid-view-query", "column_references may address each column only once")
    }
    positions <- vapply(resolved, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    expected_names <- vapply(resolved, `[[`, character(1L), "name", USE.NAMES = FALSE)
    select_columns_at(value, positions, expected_names)
  }

  compare_unsigned_decimal <- function(left, right) {
    left <- sub("^0+(?=.)", "", left, perl = TRUE)
    right <- sub("^0+(?=.)", "", right, perl = TRUE)
    if (nchar(left, type = "bytes") != nchar(right, type = "bytes")) {
      return(sign(nchar(left, type = "bytes") - nchar(right, type = "bytes")))
    }
    if (identical(left, right)) return(0L)
    if (left < right) -1L else 1L
  }

  add_unsigned_decimal <- function(left, right) {
    left_digits <- rev(utf8ToInt(left) - utf8ToInt("0"))
    right_digits <- rev(utf8ToInt(right) - utf8ToInt("0"))
    width <- max(length(left_digits), length(right_digits))
    length(left_digits) <- width
    length(right_digits) <- width
    left_digits[is.na(left_digits)] <- 0L
    right_digits[is.na(right_digits)] <- 0L
    output <- integer(width + 1L)
    carry <- 0L
    for (index in seq_len(width)) {
      total <- left_digits[[index]] + right_digits[[index]] + carry
      output[[index]] <- total %% 10L
      carry <- total %/% 10L
    }
    output[[width + 1L]] <- carry
    while (length(output) > 1L && output[[length(output)]] == 0L) {
      output <- output[-length(output)]
    }
    intToUtf8(rev(output) + utf8ToInt("0"), multiple = FALSE)
  }

  subtract_unsigned_decimal <- function(left, right) {
    if (compare_unsigned_decimal(left, right) < 0L) {
      abort("internal-error", "unsigned decimal subtraction underflowed")
    }
    left_digits <- rev(utf8ToInt(left) - utf8ToInt("0"))
    right_digits <- rev(utf8ToInt(right) - utf8ToInt("0"))
    length(right_digits) <- length(left_digits)
    right_digits[is.na(right_digits)] <- 0L
    output <- integer(length(left_digits))
    borrow <- 0L
    for (index in seq_along(left_digits)) {
      digit <- left_digits[[index]] - right_digits[[index]] - borrow
      if (digit < 0L) {
        digit <- digit + 10L
        borrow <- 1L
      } else {
        borrow <- 0L
      }
      output[[index]] <- digit
    }
    if (borrow != 0L) abort("internal-error", "unsigned decimal subtraction underflowed")
    while (length(output) > 1L && output[[length(output)]] == 0L) {
      output <- output[-length(output)]
    }
    intToUtf8(rev(output) + utf8ToInt("0"), multiple = FALSE)
  }

  add_signed_decimal <- function(left, right) {
    split_sign <- function(value) {
      negative <- startsWith(value, "-")
      magnitude <- if (negative) substring(value, 2L) else value
      magnitude <- sub("^0+(?=.)", "", magnitude, perl = TRUE)
      list(negative = negative && !identical(magnitude, "0"), magnitude = magnitude)
    }
    left_parts <- split_sign(left)
    right_parts <- split_sign(right)
    if (identical(left_parts$negative, right_parts$negative)) {
      magnitude <- add_unsigned_decimal(left_parts$magnitude, right_parts$magnitude)
      return(if (left_parts$negative && !identical(magnitude, "0")) paste0("-", magnitude) else magnitude)
    }
    comparison <- compare_unsigned_decimal(left_parts$magnitude, right_parts$magnitude)
    if (comparison == 0L) return("0")
    if (comparison > 0L) {
      magnitude <- subtract_unsigned_decimal(left_parts$magnitude, right_parts$magnitude)
      negative <- left_parts$negative
    } else {
      magnitude <- subtract_unsigned_decimal(right_parts$magnitude, left_parts$magnitude)
      negative <- right_parts$negative
    }
    if (negative) paste0("-", magnitude) else magnitude
  }

  exact_integer_sum_text <- function(values, kind) {
    total <- "0"
    if (identical(kind, "integer")) {
      # Each batch stays below 2^53, so its double sum is still an exact
      # integer. Only the small set of batch totals needs decimal folding.
      batch_size <- 1000000L
      starts <- seq.int(1L, length(values), by = batch_size)
      for (start in starts) {
        end <- min(length(values), start + batch_size - 1L)
        batch <- sum(as.double(values[start:end]))
        total <- add_signed_decimal(total, sprintf("%.0f", batch))
      }
      return(total)
    }
    for (value in as.character(values)) total <- add_signed_decimal(total, value)
    total
  }

  signed_decimal_in_range <- function(value, minimum, maximum) {
    if (startsWith(value, "-")) {
      compare_unsigned_decimal(substring(value, 2L), substring(minimum, 2L)) <= 0L
    } else {
      compare_unsigned_decimal(value, maximum) <= 0L
    }
  }

  group_rows <- function(value, key_positions, key_semantics) {
    row_positions <- seq_len(nrow(value))
    if (length(row_positions) == 0L) return(list())
    for (key_index in rev(seq_along(key_positions))) {
      key_position <- key_positions[[key_index]]
      key_values <- value[[key_position]][row_positions]
      missing <- is.na(key_values)
      present_positions <- which(!missing)
      present_order <- order_present_values(
        key_values[present_positions],
        key_semantics[[key_index]],
        FALSE
      )
      row_positions <- c(row_positions[missing], row_positions[present_positions[present_order]])
    }

    same_group <- rep(TRUE, max(0L, length(row_positions) - 1L))
    if (length(row_positions) > 1L) {
      left_rows <- row_positions[-length(row_positions)]
      right_rows <- row_positions[-1L]
      for (key_position in key_positions) {
        left <- value[[key_position]][left_rows]
        right <- value[[key_position]][right_rows]
        left_missing <- is.na(left)
        right_missing <- is.na(right)
        equal <- (left_missing & right_missing) | (!left_missing & !right_missing & left == right)
        equal[is.na(equal)] <- FALSE
        same_group <- same_group & equal
      }
    }
    starts <- c(1L, which(!same_group) + 1L)
    ends <- c(starts[-1L] - 1L, length(row_positions))
    groups <- lapply(seq_along(starts), function(index) {
      sort(row_positions[starts[[index]]:ends[[index]]], method = "radix")
    })
    first_rows <- vapply(groups, `[[`, integer(1L), 1L, USE.NAMES = FALSE)
    groups[order(first_rows, method = "radix")]
  }

  safe_group_mean <- function(values) {
    values <- suppressWarnings(as.double(values))
    positive_infinity <- any(is.infinite(values) & values > 0)
    negative_infinity <- any(is.infinite(values) & values < 0)
    if (positive_infinity && negative_infinity) return(NaN)
    if (positive_infinity) return(Inf)
    if (negative_infinity) return(-Inf)
    scale <- max(abs(values))
    if (scale == 0) return(0)
    max(-1, min(1, mean(values / scale))) * scale
  }

  safe_group_median <- function(values, semantics) {
    if (identical(semantics$kind, "integer64")) {
      ordered <- values[order_integer64(values, FALSE)]
      count <- length(ordered)
      lower <- suppressWarnings(as.double(ordered[[(count + 1L) %/% 2L]]))
      if (count %% 2L == 1L) return(lower)
      upper <- suppressWarnings(as.double(ordered[[(count + 2L) %/% 2L]]))
      return(safe_float_midpoint(lower, upper))
    }
    ordered <- sort(as.double(values), method = "radix")
    count <- length(ordered)
    lower <- ordered[[(count + 1L) %/% 2L]]
    if (count %% 2L == 1L) return(lower)
    safe_float_midpoint(lower, ordered[[(count + 2L) %/% 2L]])
  }

  aggregate_group_column <- function(column, semantics, groups, operation, alias) {
    group_count <- length(groups)
    output <- if (operation %in% c("count", "nUnique")) {
      integer(group_count)
    } else if (operation %in% c("mean", "median")) {
      rep(NA_real_, group_count)
    } else if (operation %in% c("min", "max") && identical(semantics$kind, "factor") && !semantics$ordered) {
      rep(NA_character_, group_count)
    } else if (identical(operation, "sum") && identical(semantics$kind, "integer")) {
      integer(group_count)
    } else if (identical(operation, "sum") && identical(semantics$kind, "integer64")) {
      if (!requireNamespace("bit64", quietly = TRUE)) {
        abort("missing-package", "bit64 is required to sum an integer64 column")
      }
      rep(bit64::as.integer64(0L), group_count)
    } else if (identical(operation, "sum")) {
      numeric(group_count)
    } else {
      column[rep(NA_integer_, group_count)]
    }

    for (group_index in seq_along(groups)) {
      rows <- groups[[group_index]]
      present_rows <- rows[!is.na(column[rows])]
      if (identical(operation, "count")) {
        output[[group_index]] <- as.integer(length(present_rows))
        next
      }
      if (identical(operation, "nUnique")) {
        output[[group_index]] <- as.integer(length(unique(column[present_rows])))
        next
      }
      if (length(present_rows) == 0L) {
        if (identical(operation, "sum")) {
          if (identical(semantics$kind, "integer64")) {
            output[[group_index]] <- bit64::as.integer64(0L)
          } else if (identical(semantics$kind, "integer")) {
            output[[group_index]] <- 0L
          } else {
            output[[group_index]] <- 0
          }
        }
        next
      }
      present <- column[present_rows]
      if (identical(operation, "sum")) {
        if (identical(semantics$kind, "integer")) {
          total <- exact_integer_sum_text(present, semantics$kind)
          if (!signed_decimal_in_range(total, "-2147483647", "2147483647")) {
            abort(
              "operation-output-too-large",
              sprintf("Group By sum for %s is outside R's integer range", alias)
            )
          }
          output[[group_index]] <- as.integer(total)
        } else if (identical(semantics$kind, "integer64")) {
          total <- exact_integer_sum_text(present, semantics$kind)
          if (!signed_decimal_in_range(total, "-9223372036854775807", "9223372036854775807")) {
            abort(
              "operation-output-too-large",
              sprintf("Group By sum for %s is outside the integer64 range", alias)
            )
          }
          output[[group_index]] <- bit64::as.integer64(total)
        } else {
          output[[group_index]] <- sum(present)
        }
      } else if (identical(operation, "mean")) {
        output[[group_index]] <- safe_group_mean(present)
      } else if (identical(operation, "median")) {
        output[[group_index]] <- safe_group_median(present, semantics)
      } else if (operation %in% c("min", "max")) {
        if (identical(semantics$kind, "factor") && !semantics$ordered) {
          reducer <- if (identical(operation, "min")) base::min else base::max
          output[[group_index]] <- reducer(as.character(present))
        } else if (identical(semantics$kind, "logical")) {
          reducer <- if (identical(operation, "min")) base::min else base::max
          output[[group_index]] <- as.logical(reducer(present))
        } else if (identical(semantics$kind, "integer64")) {
          ordered <- present[order_integer64(present, identical(operation, "max"))]
          output[[group_index]] <- ordered[[1L]]
        } else {
          reducer <- if (identical(operation, "min")) base::min else base::max
          output[[group_index]] <- reducer(present)
        }
      } else if (identical(operation, "first")) {
        output[[group_index]] <- present[[1L]]
      } else if (identical(operation, "last")) {
        output[[group_index]] <- present[[length(present)]]
      } else {
        abort("internal-error", "unknown R Group By aggregation")
      }
    }
    output
  }

  group_by_at <- function(
    value,
    key_positions,
    key_names,
    aggregation_positions,
    aggregation_names,
    operations,
    aliases
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    valid_positions <- function(positions, allow_duplicates) {
      is.numeric(positions) &&
        !anyNA(positions) &&
        all(is.finite(positions)) &&
        all(positions == floor(positions)) &&
        length(positions) > 0L &&
        all(positions >= 1L) &&
        all(positions <= column_count) &&
        (allow_duplicates || !anyDuplicated(positions))
    }
    if (!valid_positions(key_positions, FALSE)) {
      abort("stale-column", "the Group By key positions no longer match the R dataframe")
    }
    if (!valid_positions(aggregation_positions, TRUE)) {
      abort("stale-column", "the Group By aggregation positions no longer match the R dataframe")
    }
    key_positions <- as.integer(key_positions)
    aggregation_positions <- as.integer(aggregation_positions)
    validate_names <- function(values, positions, label) {
      if (!is.character(values) || anyNA(values) || length(values) != length(positions)) {
        abort("stale-column", sprintf("the Group By %s names no longer match the R dataframe", label))
      }
      values <- vapply(seq_along(values), function(index) {
        bounded_utf8(values[[index]], sprintf("%s_names[[%d]]", label, index), maximum_name_bytes)
      }, character(1L), USE.NAMES = FALSE)
      if (!identical(names(value)[positions], values)) {
        abort("stale-column", sprintf("the Group By %s names no longer match the R dataframe", label))
      }
      if (any(vapply(values, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      values
    }
    key_names <- validate_names(key_names, key_positions, "key")
    aggregation_names <- validate_names(aggregation_names, aggregation_positions, "aggregation")
    allowed_operations <- c("sum", "mean", "median", "min", "max", "count", "nUnique", "first", "last")
    if (
      !is.character(operations) ||
        anyNA(operations) ||
        length(operations) != length(aggregation_positions) ||
        any(!operations %in% allowed_operations)
    ) {
      abort("invalid-view-query", "the Group By aggregation operations are invalid")
    }
    if (!is.character(aliases) || anyNA(aliases) || length(aliases) != length(aggregation_positions)) {
      abort("invalid-view-query", "the Group By aliases are invalid")
    }
    aliases <- vapply(seq_along(aliases), function(index) {
      alias <- bounded_utf8(aliases[[index]], sprintf("aliases[[%d]]", index), maximum_name_bytes)
      if (identical(alias, "")) abort("invalid-column-name", "Group By aliases must not be empty")
      if (is_private_column_name(alias)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      alias
    }, character(1L), USE.NAMES = FALSE)
    if (anyDuplicated(aliases) || any(aliases %in% key_names)) {
      abort("column-name-collision", "Group By aliases must be unique and must not collide with key columns")
    }
    if (length(key_positions) + length(aggregation_positions) > maximum_columns) {
      abort("operation-output-too-large", sprintf("Group By may produce at most %d columns", maximum_columns))
    }

    supported_kinds <- c("character", "factor", "integer", "integer64", "double", "logical", "date", "datetime", "difftime")
    key_semantics <- lapply(key_positions, function(position) inspected$descriptor$schema[[position]]$semantics)
    if (any(!vapply(key_semantics, function(semantics) semantics$kind %in% supported_kinds, logical(1L)))) {
      abort("invalid-view-query", "an R Group By key uses an unsupported type")
    }
    aggregation_semantics <- lapply(
      aggregation_positions,
      function(position) inspected$descriptor$schema[[position]]$semantics
    )
    for (index in seq_along(aggregation_semantics)) {
      kind <- aggregation_semantics[[index]]$kind
      operation <- operations[[index]]
      compatible <- kind %in% supported_kinds && (
        operation %in% c("count", "nUnique", "first", "last", "min", "max") ||
          (operation %in% c("sum", "mean", "median") && kind %in% c("integer", "integer64", "double"))
      )
      if (!compatible) {
        abort(
          "invalid-view-query",
          sprintf("R %s columns do not support the %s Group By aggregation", kind, operation)
        )
      }
    }

    groups <- group_rows(value, key_positions, key_semantics)
    first_rows <- if (length(groups) == 0L) integer() else {
      vapply(groups, `[[`, integer(1L), 1L, USE.NAMES = FALSE)
    }
    key_columns <- lapply(key_positions, function(position) {
      column <- value[[position]][first_rows]
      if (is.double(column) && !is.object(column)) column[is.na(column)] <- NA_real_
      column
    })
    aggregation_columns <- lapply(seq_along(aggregation_positions), function(index) {
      aggregate_group_column(
        value[[aggregation_positions[[index]]]],
        aggregation_semantics[[index]],
        groups,
        operations[[index]],
        aliases[[index]]
      )
    })
    result_columns <- c(key_columns, aggregation_columns)
    result_names <- c(key_names, aliases)
    names(result_columns) <- result_names
    result <- as.data.frame(result_columns, optional = TRUE, stringsAsFactors = FALSE)
    names(result) <- result_names
    if (identical(inspected$flavor, "r.tibble")) {
      if (!requireNamespace("tibble", quietly = TRUE)) {
        abort("missing-package", "tibble is required to preserve an R tibble")
      }
      result <- tibble::as_tibble(result, .name_repair = "minimal")
    } else if (identical(inspected$flavor, "r.data.table")) {
      if (!requireNamespace("data.table", quietly = TRUE)) {
        abort("missing-package", "data.table is required to preserve an R data.table")
      }
      result <- data.table::as.data.table(result)
      data.table::setkeyv(result, NULL)
    }
    result
  }

  capture_group_result <- function(
    value,
    source_capture,
    key_positions,
    aggregation_positions,
    aggregation_operations,
    output_ids
  ) {
    validate_capture(source_capture)
    source_schema <- source_capture$descriptor$schema
    source_column_count <- length(source_schema)
    validate_positions <- function(positions, allow_duplicates, label) {
      if (
        !is.numeric(positions) ||
          anyNA(positions) ||
          any(!is.finite(positions)) ||
          any(positions != floor(positions)) ||
          length(positions) == 0L ||
          any(positions < 1L) ||
          any(positions > source_column_count) ||
          (!allow_duplicates && anyDuplicated(positions))
      ) {
        abort("internal-error", sprintf("a grouped R frame has invalid %s positions", label))
      }
      as.integer(positions)
    }
    key_positions <- validate_positions(key_positions, FALSE, "key")
    aggregation_positions <- validate_positions(aggregation_positions, TRUE, "aggregation")
    if (
      !is.character(aggregation_operations) ||
        anyNA(aggregation_operations) ||
        length(aggregation_operations) != length(aggregation_positions) ||
        any(!aggregation_operations %in% c("sum", "mean", "median", "min", "max", "count", "nUnique", "first", "last"))
    ) {
      abort("internal-error", "a grouped R frame has invalid aggregation operations")
    }
    expected_columns <- length(key_positions) + length(aggregation_positions)
    if (!is.character(output_ids) || anyNA(output_ids) || length(output_ids) != expected_columns) {
      abort("internal-error", "a grouped R frame has invalid output identities")
    }
    output_ids <- vapply(seq_along(output_ids), function(index) {
      bounded_utf8(output_ids[[index]], sprintf("output_ids[[%d]]", index), maximum_column_id_bytes)
    }, character(1L), USE.NAMES = FALSE)
    if (
      any(output_ids == "") ||
        anyDuplicated(output_ids) ||
        !all(vapply(output_ids, is_canonical_column_id, logical(1L), USE.NAMES = FALSE))
    ) {
      abort("internal-error", "a grouped R frame has invalid output identities")
    }
    expected_key_ids <- vapply(key_positions, function(position) source_schema[[position]]$id, character(1L))
    if (!identical(output_ids[seq_along(key_positions)], expected_key_ids)) {
      abort("internal-error", "a grouped R frame changed a key column identity")
    }
    source_ids <- vapply(source_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    aggregation_ids <- output_ids[length(key_positions) + seq_along(aggregation_positions)]
    if (any(aggregation_ids %in% source_ids)) {
      abort("internal-error", "a grouped R frame reused a source identity for an aggregation")
    }

    captured <- capture_frame(value)
    if (
      !identical(captured$descriptor$dataframeFlavor, source_capture$descriptor$dataframeFlavor) ||
        captured$descriptor$shape$columns != expected_columns
    ) {
      abort("internal-error", "a grouped R frame changed dataframe family or width")
    }
    output_schema <- captured$descriptor$schema
    expected_key_names <- vapply(key_positions, function(position) source_schema[[position]]$name, character(1L))
    if (!identical(vapply(output_schema[seq_along(key_positions)], `[[`, character(1L), "name"), expected_key_names)) {
      abort("internal-error", "a grouped R frame changed a key column name")
    }
    for (index in seq_along(key_positions)) {
      source_column <- source_schema[[key_positions[[index]]]]
      output_column <- output_schema[[index]]
      if (
        !identical(output_column$rawType, source_column$rawType) ||
          !identical(output_column$type, source_column$type) ||
          !identical(output_column$semantics, source_column$semantics)
      ) {
        abort("internal-error", "a grouped R frame changed key column type metadata")
      }
      output_schema[[index]]$nullable <- source_column$nullable
    }
    for (aggregation_index in seq_along(aggregation_positions)) {
      output_index <- length(key_positions) + aggregation_index
      source_column <- source_schema[[aggregation_positions[[aggregation_index]]]]
      output_column <- output_schema[[output_index]]
      operation <- aggregation_operations[[aggregation_index]]
      expected_kind <- if (operation %in% c("count", "nUnique")) {
        "integer"
      } else if (operation %in% c("mean", "median")) {
        "double"
      } else if (
        operation %in% c("min", "max") &&
          identical(source_column$semantics$kind, "factor") &&
          !source_column$semantics$ordered
      ) {
        "character"
      } else {
        source_column$semantics$kind
      }
      if (!identical(output_column$semantics$kind, expected_kind)) {
        abort("internal-error", "a grouped R frame produced an invalid aggregation type")
      }
      if (
        expected_kind == source_column$semantics$kind &&
          !identical(output_column$semantics, source_column$semantics)
      ) {
        abort("internal-error", "a grouped R frame changed aggregation type metadata")
      }
      output_schema[[output_index]]$nullable <- if (operation %in% c("sum", "count", "nUnique")) {
        FALSE
      } else {
        source_column$nullable
      }
    }
    generated_ids <- vapply(output_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    for (index in seq_along(output_schema)) {
      output_schema[[index]]$id <- output_ids[[index]]
      output_schema[[index]]$position <- index - 1L
    }
    descriptor <- captured$descriptor
    descriptor$schema <- json_array(output_schema)
    descriptor$frameSemantics$keyColumnIds <- json_array(character())
    old_id_bytes <- sum(vapply(generated_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
    new_id_bytes <- sum(vapply(output_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
    metadata_bytes <- captured$metadataBytes
    if (new_id_bytes > old_id_bytes) {
      budget <- new_payload_budget(metadata_bytes)
      spend_payload_budget(budget, new_id_bytes - old_id_bytes, "grouped R column identities")
      metadata_bytes <- budget$used
    }

    group_count <- as.double(descriptor$shape$rows)
    source_identity_domain <- as.double(source_capture$rowIdentityDomain)
    row_identity_domain <- source_identity_domain + group_count
    if (!is.finite(row_identity_domain) || row_identity_domain > maximum_rows) {
      abort(
        "operation-output-too-large",
        sprintf("Group By cannot expand the R row-identity domain beyond %s rows", format(maximum_rows))
      )
    }
    row_origins <- if (group_count == 0) {
      numeric()
    } else {
      seq.int(source_identity_domain + 1, length.out = as.integer(group_count))
    }

    result <- new.env(parent = emptyenv())
    result$mode <- "isolated"
    result$snapshot <- captured$snapshot
    result$sourceReader <- NULL
    result$descriptor <- descriptor
    result$rowOrigins <- row_origins
    result$rowIdentityDomain <- row_identity_domain
    result$metadataBytes <- metadata_bytes
    result$metrics <- captured$metrics
    result$sortCache <- new_sort_cache()
    finish_capture(result)
  }

  resolve_row_operation_columns <- function(value, positions, expected_names, operation) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    if (
      !is.numeric(positions) ||
        anyNA(positions) ||
        any(!is.finite(positions)) ||
        any(positions != floor(positions)) ||
        any(positions < 1L) ||
        any(positions > column_count) ||
        anyDuplicated(positions)
    ) {
      abort("stale-column", sprintf("the %s column positions no longer match the R dataframe", operation))
    }
    positions <- as.integer(positions)
    if (!is.character(expected_names) || length(expected_names) != length(positions) || anyNA(expected_names)) {
      abort("stale-column", sprintf("the %s column names no longer match the R dataframe", operation))
    }
    expected_names <- vapply(seq_along(expected_names), function(index) {
      bounded_utf8(expected_names[[index]], sprintf("expected_names[[%d]]", index), maximum_name_bytes)
    }, character(1L), USE.NAMES = FALSE)
    if (!identical(names(value)[positions], expected_names)) {
      abort("stale-column", sprintf("the %s column names no longer match the R dataframe", operation))
    }
    if (any(vapply(expected_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    list(inspected = inspected, positions = positions)
  }

  subset_rows_at <- function(value, inspected, row_positions) {
    row_count <- inspected$descriptor$shape$rows
    if (
      !is.numeric(row_positions) ||
        anyNA(row_positions) ||
        any(!is.finite(row_positions)) ||
        any(row_positions != floor(row_positions)) ||
        any(row_positions < 1L) ||
        any(row_positions > row_count) ||
        anyDuplicated(row_positions)
    ) {
      abort("internal-error", "an R row operation produced invalid source positions")
    }
    row_positions <- as.integer(row_positions)
    snapshot <- isolated_snapshot(value, inspected$flavor)
    result <- if (identical(inspected$flavor, "r.data.table")) {
      snapshot[row_positions]
    } else {
      snapshot[row_positions, , drop = FALSE]
    }
    list(frame = result, sourcePositions = row_positions)
  }

  drop_missing_rows_at <- function(value, positions, expected_names, how = "any") {
    resolved <- resolve_row_operation_columns(value, positions, expected_names, "drop-missing")
    if (!is.character(how) || length(how) != 1L || is.na(how) || !how %in% c("any", "all")) {
      abort("invalid-view-query", "dropMissingRows how must be any or all")
    }
    if (length(resolved$positions) == 0L) {
      return(subset_rows_at(value, resolved$inspected, seq_len(resolved$inspected$descriptor$shape$rows)))
    }
    present <- lapply(resolved$positions, function(position) !is.na(value[[position]]))
    keep <- if (identical(how, "all")) Reduce(`|`, present) else Reduce(`&`, present)
    subset_rows_at(value, resolved$inspected, which(keep))
  }

  drop_duplicate_rows_at <- function(value, positions, expected_names, keep = "first") {
    resolved <- resolve_row_operation_columns(value, positions, expected_names, "drop-duplicates")
    if (!is.character(keep) || length(keep) != 1L || is.na(keep) || !keep %in% c("first", "last", "none")) {
      abort("invalid-view-query", "dropDuplicates keep must be first, last, or none")
    }
    if (length(resolved$positions) == 0L) {
      return(subset_rows_at(value, resolved$inspected, seq_len(resolved$inspected$descriptor$shape$rows)))
    }
    compared <- if (identical(resolved$inspected$flavor, "r.data.table")) {
      value[, resolved$positions, with = FALSE]
    } else {
      value[resolved$positions]
    }
    duplicates <- if (identical(keep, "first")) {
      duplicated(compared)
    } else if (identical(keep, "last")) {
      duplicated(compared, fromLast = TRUE)
    } else {
      duplicated(compared) | duplicated(compared, fromLast = TRUE)
    }
    subset_rows_at(value, resolved$inspected, which(!duplicates))
  }

  validate_capture <- function(capture) {
    if (
      !inherits(capture, "openwrangler_r_frame_capture") ||
        !is.environment(capture) ||
        !environmentIsLocked(capture) ||
        !capture$mode %in% c("isolated", "live") ||
        !is.numeric(capture$rowOrigins) ||
        !is.numeric(capture$rowIdentityDomain) ||
        length(capture$rowIdentityDomain) != 1L ||
        is.na(capture$rowIdentityDomain) ||
        !is.finite(capture$rowIdentityDomain) ||
        capture$rowIdentityDomain < capture$descriptor$shape$rows ||
        capture$rowIdentityDomain != floor(capture$rowIdentityDomain) ||
        length(capture$rowOrigins) != capture$descriptor$shape$rows ||
        anyNA(capture$rowOrigins) ||
        any(!is.finite(capture$rowOrigins)) ||
        any(capture$rowOrigins != floor(capture$rowOrigins)) ||
        any(capture$rowOrigins < 1L) ||
        any(capture$rowOrigins > capture$rowIdentityDomain) ||
        anyDuplicated(capture$rowOrigins)
    ) {
      abort("invalid-capture", "capture must come from capture_frame or capture_live_frame")
    }
  }

  source_changed <- function() {
    abort(
      "source-changed",
      "The selected R dataframe changed shape or schema. Reopen it in Open Wrangler."
    )
  }

  read_capture_frame <- function(capture) {
    validate_capture(capture)
    if (identical(capture$mode, "isolated")) return(capture$snapshot)

    live_state <- capture$liveState
    if (isTRUE(live_state$hasInitialFrame)) {
      value <- live_state$initialFrame
      live_state$initialFrame <- NULL
      live_state$hasInitialFrame <- FALSE
      return(value)
    }

    add_metric(capture$metrics, "sourceReads")
    value <- tryCatch(capture$sourceReader(), error = function(error) source_changed())
    inspected <- tryCatch(
      inspect_frame(
        value,
        conservative_nullable = TRUE,
        validate_values = FALSE,
        metrics = capture$metrics
      ),
      openwrangler_r_frame_error = function(error) {
        if (identical(error$code, "source-changed")) stop(error)
        source_changed()
      }
    )
    if (!identical(inspected$descriptor, capture$descriptor)) source_changed()
    value
  }

  nanoparquet_version_supported <- function(version) {
    if (is.null(version)) return(FALSE)
    parsed <- tryCatch(
      base::package_version(as.character(version)),
      error = function(error) NULL
    )
    !is.null(parsed) && length(parsed) == 1L && !is.na(parsed) &&
      parsed >= base::package_version(minimum_nanoparquet_version)
  }

  parquet_export_available <- function() {
    if (!requireNamespace("nanoparquet", quietly = TRUE)) return(FALSE)
    version <- tryCatch(utils::packageVersion("nanoparquet"), error = function(error) NULL)
    nanoparquet_version_supported(version)
  }

  export_formats <- function() {
    formats <- "csv"
    if (parquet_export_available()) formats <- c(formats, "parquet")
    unname(formats)
  }

  validate_export_target <- function(target_path) {
    target_path <- bounded_utf8(target_path, "target_path", 32768L)
    if (
      identical(target_path, "") ||
        !(
          startsWith(target_path, "/") ||
            startsWith(target_path, "\\\\") ||
            grepl("^[A-Za-z]:[/\\\\]", target_path, perl = TRUE)
        )
    ) {
      abort("invalid-export-target", "target_path must be absolute")
    }
    if (file.exists(target_path)) {
      abort("export-target-changed", "the private R export artifact already exists")
    }
    target_path
  }

  write_csv <- function(capture, target_path) {
    validate_capture(capture)
    if (capture$descriptor$shape$columns == 0L) {
      abort(
        "export-write-failed",
        "CSV export requires at least one column because CSV cannot preserve a zero-column dataframe's row count"
      )
    }
    target_path <- validate_export_target(target_path)

    frame <- read_capture_frame(capture)
    connection <- NULL
    created <- FALSE
    completed <- FALSE
    on.exit({
      if (!is.null(connection)) try(close(connection), silent = TRUE)
      if (created && !completed && file.exists(target_path)) try(unlink(target_path, force = TRUE), silent = TRUE)
    }, add = TRUE)
    tryCatch(
      {
        connection <- file(target_path, open = "wx", encoding = "UTF-8")
        created <- TRUE
        utils::write.table(
          frame,
          file = connection,
          sep = ",",
          eol = "\n",
          na = "",
          dec = ".",
          row.names = FALSE,
          col.names = TRUE,
          quote = TRUE,
          qmethod = "double"
        )
        flush(connection)
        close(connection)
        connection <- NULL
      },
      openwrangler_r_frame_error = function(error) stop(error),
      error = function(error) {
        abort("export-write-failed", "the R dataframe could not be written as CSV")
      }
    )

    invisible(read_capture_frame(capture))
    details <- file.info(target_path)
    if (
      nrow(details) != 1L ||
        is.na(details$size[[1L]]) ||
        !is.finite(details$size[[1L]]) ||
        details$size[[1L]] < 0 ||
        isTRUE(details$isdir[[1L]])
    ) {
      abort("export-target-changed", "the private R export artifact could not be verified")
    }
    completed <- TRUE
    list(
      rows = capture$descriptor$shape$rows,
      columns = capture$descriptor$shape$columns,
      bytes = as.double(details$size[[1L]])
    )
  }

  write_parquet <- function(capture, target_path) {
    validate_capture(capture)
    target_path <- validate_export_target(target_path)
    if (!parquet_export_available()) {
      abort(
        "missing-package",
        sprintf("Parquet export requires nanoparquet %s or newer in the selected R runtime", minimum_nanoparquet_version)
      )
    }

    frame <- read_capture_frame(capture)
    completed <- FALSE
    connection <- NULL
    on.exit({
      if (!is.null(connection)) try(close(connection), silent = TRUE)
      if (!completed && file.exists(target_path)) try(unlink(target_path, force = TRUE), silent = TRUE)
    }, add = TRUE)
    tryCatch(
      nanoparquet::write_parquet(frame, target_path),
      openwrangler_r_frame_error = function(error) stop(error),
      error = function(error) {
        abort("export-write-failed", "the R dataframe could not be written as Parquet")
      }
    )

    invisible(read_capture_frame(capture))
    details <- file.info(target_path)
    if (
      nrow(details) != 1L ||
        is.na(details$size[[1L]]) ||
        !is.finite(details$size[[1L]]) ||
        details$size[[1L]] < 8L ||
        isTRUE(details$isdir[[1L]])
    ) {
      abort("export-target-changed", "the private R Parquet artifact could not be verified")
    }
    connection <- file(target_path, open = "rb")
    prefix <- readBin(connection, what = "raw", n = 4L)
    seek(connection, where = -4L, origin = "end", rw = "read")
    suffix <- readBin(connection, what = "raw", n = 4L)
    close(connection)
    connection <- NULL
    parquet_magic <- charToRaw("PAR1")
    if (!identical(prefix, parquet_magic) || !identical(suffix, parquet_magic)) {
      abort("export-target-changed", "the private R Parquet artifact has invalid file markers")
    }
    completed <- TRUE
    list(
      rows = capture$descriptor$shape$rows,
      columns = capture$descriptor$shape$columns,
      bytes = as.double(details$size[[1L]])
    )
  }

  resolve_page_window <- function(
    descriptor,
    row_offset,
    row_limit,
    column_offset,
    column_limit,
    visible_rows = descriptor$shape$rows
  ) {
    total_rows <- whole_number(visible_rows, "visible row count", descriptor$shape$rows)
    total_columns <- descriptor$shape$columns
    row_offset <- whole_number(row_offset, "row_offset", total_rows)
    row_limit <- whole_number(row_limit, "row_limit", maximum_page_rows)
    column_offset <- min(whole_number(column_offset, "column_offset", maximum_columns), total_columns)
    column_limit <- whole_number(column_limit, "column_limit", maximum_page_columns)
    row_count <- min(row_limit, total_rows - row_offset)
    column_count <- min(column_limit, total_columns - column_offset)
    if (row_count * column_count > maximum_page_cells) {
      abort("page-too-large", sprintf("a page may contain at most %d cells", maximum_page_cells))
    }
    list(
      rowOffset = row_offset,
      rowLimit = row_limit,
      rowCount = as.integer(row_count),
      columnOffset = column_offset,
      columnLimit = column_limit,
      columnCount = as.integer(column_count)
    )
  }

  direct_row_positions <- function(capture, window) {
    add_metric(capture$metrics, "directPageSlices")
    add_metric(capture$metrics, "directRowPositions", window$rowCount)
    if (window$rowCount == 0L) return(integer())
    seq.int(as.integer(window$rowOffset) + 1L, length.out = window$rowCount)
  }

  referenced_sort_columns <- function(frame, resolved) {
    lapply(resolved, function(rule) frame[[rule$position]])
  }

  snapshot_sort_columns <- function(capture, frame, resolved) {
    add_metric(capture$metrics, "sortColumnSnapshots", length(resolved))
    lapply(resolved, function(rule) frame[[rule$position]][])
  }

  estimated_row_order_bytes <- function(row_count) {
    # Integer row positions use four bytes per row. Keep a small allowance for
    # the vector header rather than allocating a probe vector merely to size it.
    64 + as.double(row_count) * 4
  }

  estimated_sort_cache_bytes <- function(capture, frame, resolved) {
    bytes <- estimated_row_order_bytes(capture$descriptor$shape$rows)
    if (!identical(capture$mode, "live")) return(bytes)

    for (rule in resolved) {
      bytes <- bytes + as.double(utils::object.size(frame[[rule$position]]))
      if (!is.finite(bytes) || bytes > maximum_sort_cache_bytes) return(Inf)
    }
    bytes
  }

  cached_sort_values_match <- function(cache, frame, resolved) {
    if (length(cache$columns) != length(resolved)) return(FALSE)
    all(vapply(
      seq_along(resolved),
      function(index) identical(frame[[resolved[[index]]$position]], cache$columns[[index]]),
      logical(1L)
    ))
  }

  build_sorted_row_positions <- function(capture, sort_columns, resolved, row_positions = NULL) {
    descriptor <- capture$descriptor
    if (is.null(row_positions)) row_positions <- seq_len(descriptor$shape$rows)
    add_metric(capture$metrics, "sortOrderBuilds")
    add_metric(capture$metrics, "sortOrderRows", length(row_positions))

    for (rule_index in rev(seq_along(resolved))) {
      rule <- resolved[[rule_index]]
      column <- sort_columns[[rule_index]][row_positions]
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

  cached_sorted_row_positions <- function(capture, frame, resolved) {
    cache <- capture$sortCache
    if (
      isTRUE(cache$valid) &&
        identical(cache$rules, resolved) &&
        (
          identical(capture$mode, "isolated") ||
            cached_sort_values_match(cache, frame, resolved)
        )
    ) {
      return(cache$rowPositions)
    }

    # A small live cache keeps copies of the active sort columns so same-schema
    # notebook mutations, including data.table updates, cannot reuse stale order.
    # Check the original vectors first: an uncacheable sort must not transiently
    # duplicate every key merely to discover that it exceeds the cache budget.
    cache_candidate <-
      length(resolved) <= maximum_cached_sort_columns &&
        estimated_sort_cache_bytes(capture, frame, resolved) <= maximum_sort_cache_bytes
    sort_columns <- if (cache_candidate && identical(capture$mode, "live")) {
      snapshot_sort_columns(capture, frame, resolved)
    } else {
      referenced_sort_columns(frame, resolved)
    }
    row_positions <- build_sorted_row_positions(capture, sort_columns, resolved)
    retained_columns <- if (cache_candidate && identical(capture$mode, "live")) sort_columns else list()
    cache_bytes <- as.double(utils::object.size(row_positions)) + as.double(utils::object.size(retained_columns))
    if (cache_candidate && cache_bytes <= maximum_sort_cache_bytes) {
      cache$rules <- resolved
      cache$rowPositions <- row_positions
      cache$columns <- retained_columns
      cache$bytes <- cache_bytes
      cache$valid <- TRUE
    } else {
      clear_sort_cache(cache)
    }
    row_positions
  }

  view_row_positions <- function(capture, frame, view_query, apply_sorts) {
    resolved <- resolve_view_query(view_query, capture$descriptor)
    if (length(resolved$filters) == 0L && (!isTRUE(apply_sorts) || length(resolved$sorts) == 0L)) {
      if (length(resolved$sorts) == 0L) clear_sort_cache(capture$sortCache)
      return(list(rows = NULL, totalRows = capture$descriptor$shape$rows, resolved = resolved))
    }
    row_positions <- filter_row_positions(frame, capture$descriptor, resolved)
    if (!isTRUE(apply_sorts) || length(resolved$sorts) == 0L || length(row_positions) == 0L) {
      if (length(resolved$sorts) == 0L) clear_sort_cache(capture$sortCache)
      return(list(rows = row_positions, totalRows = length(row_positions), resolved = resolved))
    }
    if (length(resolved$filters) == 0L) {
      row_positions <- cached_sorted_row_positions(capture, frame, resolved$sorts)
    } else {
      clear_sort_cache(capture$sortCache)
      row_positions <- build_sorted_row_positions(
        capture,
        referenced_sort_columns(frame, resolved$sorts),
        resolved$sorts,
        row_positions
      )
    }
    list(rows = row_positions, totalRows = length(row_positions), resolved = resolved)
  }

  transform_rows <- function(capture, view_query) {
    validate_capture(capture)
    frame <- read_capture_frame(capture)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = TRUE)
    source_positions <- if (is.null(view$rows)) seq_len(capture$descriptor$shape$rows) else view$rows
    result <- if (identical(capture$descriptor$dataframeFlavor, "r.data.table")) {
      subset <- frame[source_positions]
      if (length(view$resolved$sorts) != 0L) data.table::setkey(subset, NULL)
      subset
    } else {
      frame[source_positions, , drop = FALSE]
    }
    list(
      frame = result,
      sourcePositions = source_positions,
      resolved = view$resolved
    )
  }

  materialize_rows <- function(
    capture,
    frame,
    row_positions,
    window,
    total_rows = capture$descriptor$shape$rows
  ) {
    validate_capture(capture)
    descriptor <- capture$descriptor
    source_rows <- descriptor$shape$rows
    if (length(row_positions) != window$rowCount) {
      abort("internal-error", "the R page row window is inconsistent")
    }
    column_positions <- if (window$columnCount == 0L) {
      integer()
    } else {
      seq.int(as.integer(window$columnOffset) + 1L, length.out = window$columnCount)
    }
    selected_schema <- descriptor$schema[column_positions]
    column_ids <- vapply(selected_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    page_budget <- new_payload_budget(capture$metadataBytes)
    spend_payload_budget(page_budget, page_base_bytes, "R frame page")
    for (index in seq_along(column_ids)) {
      spend_json_string(page_budget, column_ids[[index]], sprintf("page column ID %d", index))
      spend_payload_budget(page_budget, 1L, "R frame page projection")
    }
    explicit_row_names <- if (identical(descriptor$frameSemantics$rowNames, "explicit")) {
      stored <- attr(frame, "row.names", exact = TRUE)
      if (length(stored) != source_rows) source_changed()
      stored
    } else {
      NULL
    }

    rows <- lapply(seq_along(row_positions), function(row_index) {
      source_row <- row_positions[[row_index]]
      spend_payload_budget(page_budget, row_fixed_bytes, sprintf("row %d", source_row))
      values <- lapply(seq_along(column_positions), function(column_index) {
        source_column <- column_positions[[column_index]]
        encode_value(
          frame[[source_column]],
          descriptor$schema[[source_column]]$semantics,
          source_row,
          sprintf("cell[%d,%d]", source_row, source_column),
          page_budget
        )
      })
      row <- list(
        id = sprintf("r:r:%.0f", capture$rowOrigins[[source_row]] - 1),
        rowNumber = as.integer(window$rowOffset) + row_index - 1L,
        values = json_array(values)
      )
      if (!is.null(explicit_row_names)) {
        row_label <- bounded_utf8(
          as.character(explicit_row_names[[source_row]]),
          sprintf("row label %d", source_row),
          maximum_name_bytes
        )
        spend_json_string(page_budget, row_label, sprintf("row label %d", source_row))
        row$rowLabel <- row_label
      }
      row
    })

    published_descriptor <- descriptor
    published_descriptor$shape$rows <- capture$rowIdentityDomain
    c(
      published_descriptor,
      list(page = list(
        offset = window$rowOffset,
        limit = window$rowLimit,
        totalRows = total_rows,
        columnOffset = window$columnOffset,
        columnLimit = window$columnLimit,
        columnIds = json_array(column_ids),
        rows = json_array(rows)
      ))
    )
  }

  count_missing_at <- function(capture, position, expected_name) {
    validate_capture(capture)
    column_count <- capture$descriptor$shape$columns
    position <- whole_number(position, "missing-count column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the missing-count column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    expected_name <- bounded_utf8(expected_name, "missing-count column name", maximum_name_bytes)
    if (!identical(capture$descriptor$schema[[position]]$name, expected_name)) {
      abort("stale-column", "the missing-count column name no longer matches the R dataframe")
    }
    frame <- read_capture_frame(capture)
    as.integer(sum(is.na(frame[[position]])))
  }

  materialize_summaries <- function(
    capture,
    column_references,
    view_query = list(filters = list(), sorts = list())
  ) {
    validate_capture(capture)
    resolved <- resolve_profile_columns(column_references, capture$descriptor)
    frame <- read_capture_frame(capture)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = FALSE)
    validate_profile_work(
      view$totalRows,
      length(resolved),
      maximum_profile_cells,
      "The requested R column profiles"
    )
    add_metric(capture$metrics, "profileColumns", length(resolved))
    budget <- new_payload_budget(capture$metadataBytes)
    filtered <- if (is.null(view$rows)) frame else frame[view$rows, , drop = FALSE]
    summaries <- lapply(resolved, function(column) column_summary(capture, filtered, column, budget))
    json_array(summaries)
  }

  materialize_dataset_stats <- function(
    capture,
    view_query = list(filters = list(), sorts = list())
  ) {
    validate_capture(capture)
    descriptor <- capture$descriptor
    column_count <- descriptor$shape$columns
    frame <- read_capture_frame(capture)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = FALSE)
    row_count <- view$totalRows
    validate_profile_work(
      row_count,
      column_count,
      maximum_dataset_profile_cells,
      "The requested R dataset profile"
    )
    if (!is.null(view$rows)) frame <- frame[view$rows, , drop = FALSE]
    add_metric(capture$metrics, "datasetProfiles")
    budget <- new_payload_budget(capture$metadataBytes)
    spend_payload_budget(budget, summary_fixed_bytes, "R dataset profile")
    missing_rows <- rep(FALSE, row_count)
    missing_by_column <- lapply(seq_len(column_count), function(position) {
      column <- frame[[position]]
      schema <- descriptor$schema[[position]]
      validate_profile_column(column, schema$semantics, sprintf("column %d dataset profile", position))
      missing <- is.na(column)
      missing_rows <<- missing_rows | missing
      spend_json_string(budget, schema$name, sprintf("column %d missing-value name", position))
      spend_payload_budget(budget, 96L, sprintf("column %d missing-value count", position))
      list(column = schema$name, count = as.integer(sum(missing)))
    })
    duplicate_rows <- if (row_count <= 1L) {
      0L
    } else if (column_count == 0L) {
      as.integer(row_count - 1L)
    } else {
      as.integer(sum(duplicated(frame)))
    }
    list(
      totalRows = as.double(row_count),
      stats = list(
        missingCells = as.double(sum(vapply(missing_by_column, `[[`, integer(1L), "count"))),
        missingRows = as.integer(sum(missing_rows)),
        duplicateRows = duplicate_rows,
        missingValuesByColumn = json_array(missing_by_column)
      )
    )
  }

  materialize_column_values <- function(
    capture,
    column_reference,
    view_query = list(filters = list(), sorts = list()),
    search = NULL,
    limit = 100L
  ) {
    validate_capture(capture)
    descriptor <- capture$descriptor
    resolved_column <- resolve_column_reference(column_reference, descriptor, "column_reference")
    limit <- whole_number(limit, "limit", maximum_selected_values_per_filter)
    if (limit < 1L) abort("invalid-view-query", "limit must be positive")
    if (!is.null(search)) search <- bounded_utf8(search, "search", maximum_text_bytes)
    frame <- read_capture_frame(capture)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = FALSE)
    validate_profile_work(view$totalRows, 1L, maximum_profile_cells, "The requested R column values")
    source_column <- frame[[resolved_column$position]]
    column <- if (is.null(view$rows)) source_column else source_column[view$rows]
    column_descriptor <- descriptor$schema[[resolved_column$position]]
    semantics <- column_descriptor$semantics
    validate_profile_column(column, semantics, "column values")
    missing <- profile_missing_masks(column, semantics)
    present_indices <- which(!missing$null & !missing$nan)
    budget <- new_payload_budget(capture$metadataBytes)
    spend_payload_budget(budget, summary_fixed_bytes, "R column values")
    if (length(present_indices) == 0L) {
      return(list(column = column_descriptor$name, values = json_array(list()), hasMore = FALSE))
    }
    keys <- profile_value_keys(column, semantics, present_indices)
    if (!is.null(search) && !identical(search, "")) {
      displays <- vapply(seq_along(present_indices), function(index) {
        encode_value(column, semantics, present_indices[[index]], "column value search", new_payload_budget())$display
      }, character(1L), USE.NAMES = FALSE)
      keep <- grepl(ascii_fold(search), ascii_fold(displays), fixed = TRUE)
      present_indices <- present_indices[keep]
      keys <- keys[keep]
    }
    if (length(present_indices) == 0L) {
      return(list(column = column_descriptor$name, values = json_array(list()), hasMore = FALSE))
    }
    first <- !duplicated(keys)
    unique_keys <- keys[first]
    first_indices <- present_indices[first]
    counts <- tabulate(match(keys, unique_keys), nbins = length(unique_keys))
    displays <- vapply(seq_along(first_indices), function(index) {
      encode_value(column, semantics, first_indices[[index]], "column value order", new_payload_budget())$display
    }, character(1L), USE.NAMES = FALSE)
    priority <- base::order(-counts, displays, seq_along(counts), method = "radix")
    selected <- utils::head(priority, limit)
    values <- lapply(seq_along(selected), function(result_index) {
      source_index <- first_indices[[selected[[result_index]]]]
      encoded <- encode_value(column, semantics, source_index, sprintf("column value %d", result_index), budget)
      if (identical(semantics$kind, "double") && identical(unique_keys[[selected[[result_index]]]], "0")) {
        encoded <- ordinary_cell("number", "0", "0")
      }
      selection_cell <- encoded
      if (identical(semantics$kind, "double") && identical(encoded$kind, "number")) {
        selection_cell$raw <- as.double(encoded$raw)
      }
      list(
        value = encoded$display,
        count = as.integer(counts[[selected[[result_index]]]]),
        selectionValue = list(
          kind = "typedSelection",
          version = 1L,
          columnType = column_descriptor$type,
          cell = selection_cell
        )
      )
    })
    list(
      column = column_descriptor$name,
      values = json_array(values),
      hasMore = length(priority) > limit
    )
  }

  materialize_page <- function(
    capture,
    row_offset = 0L,
    row_limit = 100L,
    column_offset = 0L,
    column_limit = 100L
  ) {
    validate_capture(capture)
    frame <- read_capture_frame(capture)
    window <- resolve_page_window(
      capture$descriptor,
      row_offset,
      row_limit,
      column_offset,
      column_limit
    )
    materialize_rows(capture, frame, direct_row_positions(capture, window), window)
  }

  materialize_view_page <- function(
    capture,
    view_query = list(filters = list(), sorts = list()),
    row_offset = 0L,
    row_limit = 100L,
    column_offset = 0L,
    column_limit = 100L
  ) {
    validate_capture(capture)
    frame <- read_capture_frame(capture)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = TRUE)
    total_rows <- view$totalRows
    window <- resolve_page_window(
      capture$descriptor,
      row_offset,
      row_limit,
      column_offset,
      column_limit,
      visible_rows = total_rows
    )
    row_positions <- if (window$rowCount == 0L) {
      integer()
    } else if (is.null(view$rows)) {
      direct_row_positions(capture, window)
    } else {
      logical_rows <- seq.int(as.integer(window$rowOffset) + 1L, length.out = window$rowCount)
      view$rows[logical_rows]
    }
    materialize_rows(capture, frame, row_positions, window, total_rows)
  }

  capture_metrics <- function(capture) {
    validate_capture(capture)
    metrics <- capture$metrics
    list(
      nullableScans = metrics$nullableScans,
      sourceReads = metrics$sourceReads,
      directPageSlices = metrics$directPageSlices,
      directRowPositions = metrics$directRowPositions,
      sortOrderBuilds = metrics$sortOrderBuilds,
      sortOrderRows = metrics$sortOrderRows,
      sortColumnSnapshots = metrics$sortColumnSnapshots,
      profileColumns = metrics$profileColumns,
      datasetProfiles = metrics$datasetProfiles,
      cachedSortRows = length(capture$sortCache$rowPositions),
      cachedSortColumns = length(capture$sortCache$columns),
      cachedSortBytes = capture$sortCache$bytes
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
    capture_live_frame = capture_live_frame,
    isolate_capture = isolate_capture,
    rename_column = rename_column,
    rename_column_at = rename_column_at,
    clone_column = clone_column,
    clone_column_at = clone_column_at,
    text_length_column = text_length_column,
    text_length_column_at = text_length_column_at,
    lower_text_column = lower_text_column,
    lower_text_column_at = lower_text_column_at,
    upper_text_column = upper_text_column,
    upper_text_column_at = upper_text_column_at,
    capitalize_text_column = capitalize_text_column,
    capitalize_text_column_at = capitalize_text_column_at,
    strip_text_column = strip_text_column,
    strip_text_column_at = strip_text_column_at,
    split_text_column = split_text_column,
    split_text_column_at = split_text_column_at,
    find_replace_column = find_replace_column,
    find_replace_column_at = find_replace_column_at,
    round_number_column_at = round_number_column_at,
    floor_number_column_at = floor_number_column_at,
    ceil_number_column_at = ceil_number_column_at,
    fill_missing_column = fill_missing_column,
    fill_missing_column_at = fill_missing_column_at,
    fill_missing_from_fallback_columns_at = fill_missing_from_fallback_columns_at,
    fill_missing_directional_at = fill_missing_directional_at,
    fill_missing_linear_interpolation_at = fill_missing_linear_interpolation_at,
    fill_missing_grouped_statistic_at = fill_missing_grouped_statistic_at,
    cast_column = cast_column,
    cast_column_at = cast_column_at,
    drop_columns = drop_columns,
    drop_columns_at = drop_columns_at,
    select_columns = select_columns,
    select_columns_at = select_columns_at,
    group_by_at = group_by_at,
    capture_group_result = capture_group_result,
    drop_missing_rows_at = drop_missing_rows_at,
    drop_duplicate_rows_at = drop_duplicate_rows_at,
    transform_rows = transform_rows,
    nanoparquet_version_supported = nanoparquet_version_supported,
    parquet_export_available = parquet_export_available,
    export_formats = export_formats,
    write_csv = write_csv,
    write_parquet = write_parquet,
    capture_metrics = capture_metrics,
    materialize_page = materialize_page,
    materialize_view_page = materialize_view_page,
    count_missing_at = count_missing_at,
    materialize_summaries = materialize_summaries,
    materialize_dataset_stats = materialize_dataset_stats,
    materialize_column_values = materialize_column_values,
    encode_page = encode_page,
    encode_view_page = encode_view_page,
    limits = list(
      rows = maximum_rows,
      columns = maximum_columns,
      pageRows = maximum_page_rows,
      pageColumns = maximum_page_columns,
      pageCells = maximum_page_cells,
      filters = maximum_filters,
      predicatesPerFilter = maximum_predicates_per_filter,
      selectedValuesPerFilter = maximum_selected_values_per_filter,
      sortRules = maximum_sort_rules,
      fillFallbackColumns = maximum_fill_fallback_columns,
      profileColumns = maximum_profile_columns,
      profileRows = maximum_profile_rows,
      profileCells = maximum_profile_cells,
      datasetProfileCells = maximum_dataset_profile_cells,
      topValues = maximum_top_values,
      histogramBins = maximum_histogram_bins,
      cachedSortColumns = maximum_cached_sort_columns,
      sortCacheBytes = maximum_sort_cache_bytes,
      factorLevels = maximum_factor_levels,
      textBytes = maximum_text_bytes,
      nameBytes = maximum_name_bytes,
      columnIdBytes = maximum_column_id_bytes,
      payloadBytes = maximum_payload_bytes
    )
  )
})
