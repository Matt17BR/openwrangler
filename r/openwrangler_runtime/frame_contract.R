openwrangler_r_frame_contract <- local({
  contract_version <- 4L
  maximum_rows <- .Machine$integer.max
  maximum_columns <- 2048L
  maximum_page_rows <- 1000L
  maximum_page_columns <- 256L
  maximum_page_cells <- 100000L
  maximum_filters <- 64L
  maximum_predicates_per_filter <- 64L
  maximum_selected_values_per_filter <- 10000L
  maximum_sort_rules <- 64L
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
  maximum_name_bytes <- 1024L
  maximum_payload_bytes <- 16L * 1024L * 1024L
  private_row_id_prefix <- "__open_wrangler_internal_row_id_"
  metadata_base_bytes <- 1024L
  column_fixed_bytes <- 512L
  page_base_bytes <- 1024L
  row_fixed_bytes <- 96L
  cell_fixed_bytes <- 96L
  summary_fixed_bytes <- 1024L

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
    column_id <- bounded_utf8(reference$id, paste0(label, "$id"), maximum_name_bytes)
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
      column_id <- bounded_utf8(reference$id, paste0(label, "$id"), maximum_name_bytes)
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

  capture_frame <- function(value, nullability_source = NULL, source_positions = NULL) {
    if (!is.data.frame(value)) {
      abort("unsupported-frame", "the value is not an R dataframe")
    }
    if (!is.null(nullability_source)) validate_capture(nullability_source)
    if (is.null(nullability_source) && !is.null(source_positions)) {
      abort("internal-error", "source_positions requires a source R capture")
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
          anyDuplicated(source_positions)
      ) {
        abort("internal-error", "a derived R frame has an invalid source-column mapping")
      }
      source_positions <- as.integer(source_positions)
      source_nullable <- vapply(source_positions, function(position) {
        value <- source_schema[[position]]$nullable
        if (length(value) != 1L || !is.logical(value) || is.na(value)) {
          abort("internal-error", "an R capture retained invalid nullability metadata")
        }
        value
      }, logical(1L), USE.NAMES = FALSE)

      generated_ids <- vapply(output_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
      retained_ids <- vapply(source_positions, function(position) {
        source_schema[[position]]$id
      }, character(1L), USE.NAMES = FALSE)
      for (index in seq_along(output_schema)) {
        source_column <- source_schema[[source_positions[[index]]]]
        output_column <- output_schema[[index]]
        if (
          !identical(output_column$rawType, source_column$rawType) ||
            !identical(output_column$type, source_column$type) ||
            !identical(output_column$semantics, source_column$semantics)
        ) {
          abort("internal-error", "a derived R frame changed retained column type metadata")
        }
        inspected$descriptor$schema[[index]]$id <- retained_ids[[index]]
        inspected$descriptor$schema[[index]]$nullable <- source_nullable[[index]]
      }

      generated_key_ids <- inspected$descriptor$frameSemantics$keyColumnIds
      if (length(generated_key_ids) != 0L) {
        key_positions <- match(generated_key_ids, generated_ids)
        if (anyNA(key_positions)) {
          abort("internal-error", "a derived R frame retained an invalid data.table key")
        }
        retained_key_ids <- retained_ids[key_positions]
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

  validate_capture <- function(capture) {
    if (
      !inherits(capture, "openwrangler_r_frame_capture") ||
        !is.environment(capture) ||
        !environmentIsLocked(capture) ||
        !capture$mode %in% c("isolated", "live")
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
        id = sprintf("r:r:%d", source_row - 1L),
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

    c(
      descriptor,
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
    drop_columns = drop_columns,
    drop_columns_at = drop_columns_at,
    select_columns = select_columns,
    select_columns_at = select_columns_at,
    capture_metrics = capture_metrics,
    materialize_page = materialize_page,
    materialize_view_page = materialize_view_page,
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
      payloadBytes = maximum_payload_bytes
    )
  )
})
