openwrangler_r_kernel_agent <- local({
  transport_version <- 7L
  maximum_identifier_bytes <- 128L
  maximum_variable_name_bytes <- 1024L
  maximum_step_id_bytes <- 1024L
  maximum_error_bytes <- 4096L
  maximum_response_bytes <- 17L * 1024L * 1024L
  maximum_generated_code_bytes <- 4L * 1024L * 1024L
  maximum_export_chunk_bytes <- 1L * 1024L * 1024L
  maximum_fill_directional_gap <- 1000000L
  maximum_revision <- .Machine$integer.max
  default_strip_characters <- paste0(
    " \t\n\r\v\f",
    "\u001c\u001d\u001e\u001f",
    "\u0085\u00a0\u1680",
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a",
    "\u2028\u2029\u202f\u205f\u3000"
  )
  identifier_pattern <- "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

  abort <- function(code, message, recoverable = FALSE) {
    condition <- structure(
      list(message = message, call = NULL, code = code, recoverable = recoverable),
      class = c("openwrangler_r_kernel_error", "error", "condition")
    )
    stop(condition)
  }

  diagnostic_message <- function(error, fallback) {
    message <- conditionMessage(error)
    if (!is.character(message) || length(message) != 1L || is.na(message) || Encoding(message) == "bytes") {
      return(fallback)
    }
    converted <- iconv(message, from = "", to = "UTF-8", sub = NA_character_)
    if (is.na(converted) || nchar(converted, type = "bytes") > maximum_error_bytes) fallback else converted
  }

  frame_diagnostic <- function(error) {
    source_code <- error$code
    if (!is.character(source_code) || length(source_code) != 1L || is.na(source_code)) {
      source_code <- ""
    }

    if (identical(source_code, "missing-package")) {
      code <- "missing_package"
      recoverable <- TRUE
    } else if (identical(source_code, "source-changed")) {
      code <- "runtime_error"
      recoverable <- TRUE
    } else if (identical(source_code, "stale-column")) {
      code <- "stale_column"
      recoverable <- TRUE
    } else if (identical(source_code, "profile-too-large")) {
      code <- "profile_too_large"
      recoverable <- TRUE
    } else if (source_code %in% c("page-too-large", "payload-too-large")) {
      code <- "page_too_large"
      recoverable <- TRUE
    } else if (
      startsWith(source_code, "unsupported-") ||
        source_code %in% c(
          "factor-levels-too-large",
          "invalid-data-table-key",
          "invalid-factor",
          "invalid-range",
          "invalid-schema",
          "invalid-text",
          "text-too-large"
        )
    ) {
      code <- "unsupported_frame"
      recoverable <- FALSE
    } else if (
      source_code %in% c(
        "column-name-collision",
        "export-target-changed",
        "invalid-export-target",
        "invalid-column-name",
        "invalid-view-query",
        "invalid-view-value",
        "operation-output-too-large",
        "reserved-column-name"
      )
    ) {
      code <- "invalid_request"
      recoverable <- TRUE
    } else if (identical(source_code, "export-write-failed")) {
      code <- "runtime_error"
      recoverable <- TRUE
    } else {
      code <- "runtime_error"
      recoverable <- FALSE
    }

    list(
      code = code,
      message = diagnostic_message(error, "The R dataframe could not be read"),
      recoverable = recoverable
    )
  }

  exact_record <- function(value, fields, label, optional_fields = character()) {
    if (!is.list(value) || is.object(value) || is.null(names(value))) {
      abort("invalid_request", sprintf("%s must be an object", label))
    }
    field_names <- names(value)
    if (
      anyNA(field_names) ||
        any(field_names == "") ||
        anyDuplicated(field_names) ||
        !all(fields %in% field_names) ||
        any(!field_names %in% c(fields, optional_fields))
    ) {
      abort("invalid_request", sprintf("%s has invalid fields", label))
    }
    value
  }

  decode_column_reference <- function(value, label, maximum_id_bytes) {
    reference <- exact_record(value, c("id", "name"), label)
    list(
      id = bounded_text(reference$id, paste0(label, ".id"), maximum_id_bytes),
      name = bounded_text(reference$name, paste0(label, ".name"), maximum_variable_name_bytes)
    )
  }

  bounded_text <- function(value, label, maximum_bytes) {
    if (!is.character(value) || length(value) != 1L || is.na(value) || Encoding(value) == "bytes") {
      abort("invalid_request", sprintf("%s must be one UTF-8 string", label))
    }
    converted <- iconv(value, from = "", to = "UTF-8", sub = NA_character_)
    if (is.na(converted) || nchar(converted, type = "bytes") > maximum_bytes) {
      abort("invalid_request", sprintf("%s is not a bounded UTF-8 string", label))
    }
    converted
  }

  identifier <- function(value, label) {
    value <- bounded_text(value, label, maximum_identifier_bytes)
    if (!grepl(identifier_pattern, value, perl = TRUE)) {
      abort("invalid_request", sprintf("%s must be a canonical UUID", label))
    }
    value
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
      abort("invalid_request", sprintf("%s is outside its supported range", label))
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
      abort("invalid_request", sprintf("%s is outside its supported range", label))
    }
    as.double(value)
  }

  decode_sort_rules <- function(value, limits) {
    if (
      !is.list(value) ||
        is.object(value) ||
        !is.null(names(value)) ||
        length(value) > limits$sortRules
    ) {
      abort("invalid_request", "request.page.sorts must be a bounded array")
    }
    rules <- lapply(seq_along(value), function(index) {
      rule <- exact_record(value[[index]], c("column", "direction", "nulls"), sprintf("sort[%d]", index))
      column <- decode_column_reference(
        rule$column,
        sprintf("sort[%d].column", index),
        limits$columnIdBytes
      )
      direction <- bounded_text(rule$direction, sprintf("sort[%d].direction", index), 4L)
      nulls <- bounded_text(rule$nulls, sprintf("sort[%d].nulls", index), 5L)
      if (!direction %in% c("asc", "desc") || !nulls %in% c("first", "last")) {
        abort("invalid_request", sprintf("sort[%d] has an unsupported order", index))
      }
      list(
        column = column,
        direction = direction,
        nulls = nulls
      )
    })
    ids <- vapply(rules, function(rule) rule$column$id, character(1L), USE.NAMES = FALSE)
    if (anyDuplicated(ids)) {
      abort("invalid_request", "request.page.sorts contains a repeated column identity")
    }
    rules
  }

  decode_view_value <- function(value, label) {
    if (is.null(value)) return(NULL)
    if (
      length(value) == 1L &&
        ((is.character(value) && !is.na(value)) || is.logical(value) || (is.numeric(value) && is.finite(value)))
    ) {
      if (is.character(value)) return(bounded_text(value, label, 65536L))
      return(value)
    }
    token <- exact_record(value, c("kind", "version", "columnType", "cell"), label)
    if (!identical(token$kind, "typedSelection") || !identical(token$version, 1L)) {
      abort("invalid_request", sprintf("%s is not a versioned typed selection", label))
    }
    token$columnType <- bounded_text(token$columnType, paste0(label, ".columnType"), 32L)
    if (!token$columnType %in% c("string", "integer", "float", "boolean", "datetime", "date", "duration")) {
      abort("invalid_request", sprintf("%s has an unsupported column type", label))
    }
    cell <- exact_record(
      token$cell,
      c("kind", "raw", "display", "isNull", "isNaN"),
      paste0(label, ".cell"),
      optional_fields = "sign"
    )
    cell$kind <- bounded_text(cell$kind, paste0(label, ".cell.kind"), 32L)
    cell$display <- bounded_text(cell$display, paste0(label, ".cell.display"), 8192L)
    if (!is.logical(cell$isNull) || length(cell$isNull) != 1L || !is.logical(cell$isNaN) || length(cell$isNaN) != 1L) {
      abort("invalid_request", sprintf("%s has invalid missing-value flags", label))
    }
    token$cell <- cell
    token
  }

  decode_predicates <- function(value, limits, filter_index) {
    if (!is.list(value) || is.object(value) || length(value) > limits$predicatesPerFilter) {
      abort("invalid_request", sprintf("view.filters[%d].predicates must be a bounded array", filter_index))
    }
    lapply(seq_along(value), function(index) {
      label <- sprintf("view.filters[%d].predicates[%d]", filter_index, index)
      predicate <- exact_record(
        value[[index]],
        c("kind", "operator"),
        label,
        optional_fields = c("value", "secondValue")
      )
      operators <- c(
        "equals", "notEquals", "contains", "startsWith", "endsWith", "gt", "gte", "lt", "lte",
        "between", "isNull", "isNotNull", "isNaN", "isNotNaN"
      )
      if (!identical(predicate$kind, "predicate") || !predicate$operator %in% operators) {
        abort("invalid_request", sprintf("%s has an unsupported operator", label))
      }
      nullary <- predicate$operator %in% c("isNull", "isNotNull", "isNaN", "isNotNaN")
      if (!nullary && !"value" %in% names(predicate)) {
        abort("invalid_request", sprintf("%s requires value", label))
      }
      if (identical(predicate$operator, "between") && !"secondValue" %in% names(predicate)) {
        abort("invalid_request", sprintf("%s requires secondValue", label))
      }
      if ("value" %in% names(predicate)) predicate$value <- decode_view_value(predicate$value, paste0(label, ".value"))
      if ("secondValue" %in% names(predicate)) {
        predicate$secondValue <- decode_view_value(predicate$secondValue, paste0(label, ".secondValue"))
      }
      predicate
    })
  }

  decode_value_filter <- function(value, limits, filter_index) {
    label <- sprintf("view.filters[%d].valueFilter", filter_index)
    filter <- exact_record(
      value,
      c("kind", "selectedValues", "includeNulls", "includeNaN"),
      label,
      optional_fields = "search"
    )
    if (!identical(filter$kind, "values")) abort("invalid_request", sprintf("%s has an invalid kind", label))
    if (
      !is.list(filter$selectedValues) ||
        is.object(filter$selectedValues) ||
        length(filter$selectedValues) > limits$selectedValuesPerFilter
    ) {
      abort("invalid_request", sprintf("%s.selectedValues must be a bounded array", label))
    }
    if (
      !is.logical(filter$includeNulls) || length(filter$includeNulls) != 1L || is.na(filter$includeNulls) ||
        !is.logical(filter$includeNaN) || length(filter$includeNaN) != 1L || is.na(filter$includeNaN)
    ) {
      abort("invalid_request", sprintf("%s has invalid missing-value switches", label))
    }
    filter$selectedValues <- lapply(seq_along(filter$selectedValues), function(index) {
      decode_view_value(filter$selectedValues[[index]], sprintf("%s.selectedValues[%d]", label, index))
    })
    if ("search" %in% names(filter)) {
      filter$search <- bounded_text(filter$search, paste0(label, ".search"), 8192L)
    }
    filter
  }

  decode_view <- function(value, limits) {
    view <- exact_record(value, c("filters", "sorts"), "request.view", optional_fields = "logic")
    if ("logic" %in% names(view) && !view$logic %in% c("and", "or")) {
      abort("invalid_request", "request.view.logic is unsupported")
    }
    if (!is.list(view$filters) || is.object(view$filters) || length(view$filters) > limits$filters) {
      abort("invalid_request", "request.view.filters must be a bounded array")
    }
    filters <- lapply(seq_along(view$filters), function(index) {
      label <- sprintf("view.filters[%d]", index)
      filter <- exact_record(
        view$filters[[index]],
        c("column", "type", "predicates"),
        label,
        optional_fields = c("logic", "valueFilter")
      )
      filter$column <- decode_column_reference(
        filter$column,
        paste0(label, ".column"),
        limits$columnIdBytes
      )
      filter$type <- bounded_text(filter$type, paste0(label, ".type"), 32L)
      if (!filter$type %in% c("string", "integer", "float", "boolean", "datetime", "date", "duration")) {
        abort("invalid_request", sprintf("%s.type is unsupported", label))
      }
      if ("logic" %in% names(filter) && !filter$logic %in% c("and", "or")) {
        abort("invalid_request", sprintf("%s.logic is unsupported", label))
      }
      filter$predicates <- decode_predicates(filter$predicates, limits, index)
      if ("valueFilter" %in% names(filter)) {
        filter$valueFilter <- decode_value_filter(filter$valueFilter, limits, index)
      }
      filter
    })
    list(
      logic = if ("logic" %in% names(view)) view$logic else "and",
      filters = filters,
      sorts = decode_sort_rules(view$sorts, limits)
    )
  }

  decode_page <- function(value, limits) {
    page <- exact_record(
      value,
      c("rowOffset", "rowLimit", "columnOffset", "columnLimit", "view"),
      "request.page"
    )
    list(
      row_offset = whole_number(page$rowOffset, "request.page.rowOffset", limits$rows),
      row_limit = whole_number(page$rowLimit, "request.page.rowLimit", limits$pageRows),
      column_offset = whole_number(page$columnOffset, "request.page.columnOffset", limits$columns),
      column_limit = whole_number(page$columnLimit, "request.page.columnLimit", limits$pageColumns),
      view = decode_view(page$view, limits)
    )
  }

  decode_column_references <- function(value, limits) {
    if (
      !is.list(value) ||
        is.object(value) ||
        length(value) == 0L ||
        length(value) > limits$profileColumns
    ) {
      abort("invalid_request", "request.payload.columns must be a bounded non-empty array")
    }
    references <- lapply(seq_along(value), function(index) {
      decode_column_reference(value[[index]], sprintf("columns[%d]", index), limits$columnIdBytes)
    })
    ids <- vapply(references, `[[`, character(1L), "id", USE.NAMES = FALSE)
    if (anyDuplicated(ids)) {
      abort("invalid_request", "request.payload.columns contains a repeated column identity")
    }
    references
  }

  validate_dataset_stats_result <- function(value, limits) {
    result_whole_number <- function(candidate, label, maximum) {
      if (
        length(candidate) != 1L ||
          !is.numeric(candidate) ||
          is.na(candidate) ||
          !is.finite(candidate) ||
          candidate < 0 ||
          candidate > maximum ||
          candidate != floor(candidate)
      ) {
        abort("runtime_error", sprintf("%s is outside its supported range", label))
      }
      as.double(candidate)
    }
    result <- exact_record(value, c("totalRows", "stats"), "dataset statistics result")
    total_rows <- result_whole_number(result$totalRows, "dataset statistics totalRows", limits$rows)
    stats <- exact_record(
      result$stats,
      c("missingCells", "missingRows", "duplicateRows", "missingValuesByColumn"),
      "dataset statistics"
    )
    missing_rows <- result_whole_number(stats$missingRows, "dataset statistics missingRows", total_rows)
    duplicate_rows <- result_whole_number(
      stats$duplicateRows,
      "dataset statistics duplicateRows",
      max(0, total_rows - 1)
    )
    entries <- stats$missingValuesByColumn
    if (!is.list(entries) || length(entries) > limits$columns) {
      abort("runtime_error", "dataset statistics have an invalid column projection")
    }
    entries <- unclass(entries)
    missing_cells <- 0
    for (index in seq_along(entries)) {
      entry <- exact_record(entries[[index]], c("column", "count"), sprintf("dataset statistics column %d", index))
      bounded_text(entry$column, sprintf("dataset statistics column %d name", index), limits$nameBytes)
      missing_cells <- missing_cells + result_whole_number(
        entry$count,
        sprintf("dataset statistics column %d count", index),
        total_rows
      )
    }
    declared_missing_cells <- result_whole_number(
      stats$missingCells,
      "dataset statistics missingCells",
      total_rows * length(entries)
    )
    if (declared_missing_cells != missing_cells) {
      abort("runtime_error", "dataset statistics have inconsistent missing-value totals")
    }
    result$totalRows <- total_rows
    result$stats$missingCells <- declared_missing_cells
    result$stats$missingRows <- missing_rows
    result$stats$duplicateRows <- duplicate_rows
    result
  }

  materialize <- function(frame_contract, capture, page) {
    frame_contract$materialize_view_page(
      capture,
      view_query = page$view,
      row_offset = page$row_offset,
      row_limit = page$row_limit,
      column_offset = page$column_offset,
      column_limit = page$column_limit
    )
  }

  active_capture <- function(session) {
    if (isTRUE(session$editing)) {
      if (is.null(session$draft)) session$committed else session$draft
    } else {
      session$source
    }
  }

  assert_revision <- function(session, revision) {
    revision <- whole_number(revision, "request.payload.revision", maximum_revision)
    if (!identical(as.double(session$revision), revision)) {
      abort(
        "stale_revision",
        sprintf("The R session revision is %d, not %d", session$revision, as.integer(revision)),
        TRUE
      )
    }
  }

  next_revision <- function(session) {
    if (session$revision >= maximum_revision) {
      abort("runtime_error", "The R session revision limit was reached")
    }
    as.integer(session$revision + 1L)
  }

  decode_fill_missing_replacement <- function(value, limits, target_column) {
    replacement <- exact_record(
      value,
      "kind",
      "request.payload.step.params.replacement",
      optional_fields = c("value", "columns", "direction", "orderBy", "maxGap", "statistic", "keys", "coordinate")
    )
    kind <- bounded_text(
      replacement$kind,
      "request.payload.step.params.replacement.kind",
      24L
    )
    supported <- c(
      "mean",
      "median",
      "mostFrequent",
      "fallbackColumns",
      "directional",
      "groupedStatistic",
      "linearInterpolation",
      "string",
      "integer",
      "float",
      "decimal",
      "boolean",
      "date",
      "datetime"
    )
    if (!kind %in% supported) {
      abort("invalid_request", "request.payload.step.params.replacement.kind is unsupported")
    }
    if (kind %in% c("mean", "median", "mostFrequent")) {
      if (!identical(names(replacement), "kind")) {
        abort("invalid_request", "a calculated replacement may not contain a value or fallback columns")
      }
      return(list(kind = kind))
    }
    if (identical(kind, "fallbackColumns")) {
      if (!setequal(names(replacement), c("kind", "columns"))) {
        abort("invalid_request", "a fallback-column replacement requires exactly kind and columns")
      }
      columns <- replacement$columns
      if (
        !is.list(columns) ||
          is.object(columns) ||
          !is.null(names(columns)) ||
          length(columns) == 0L ||
          length(columns) > limits$fillFallbackColumns
      ) {
        abort("invalid_request", "fallback columns must be a bounded non-empty array")
      }
      columns <- lapply(seq_along(columns), function(index) {
        decode_column_reference(
          columns[[index]],
          sprintf("request.payload.step.params.replacement.columns[%d]", index),
          limits$columnIdBytes
        )
      })
      ids <- vapply(columns, `[[`, character(1L), "id", USE.NAMES = FALSE)
      if (anyDuplicated(ids)) abort("invalid_request", "fallback columns contain a repeated column identity")
      if (target_column$id %in% ids) abort("invalid_request", "the fill target cannot also be a fallback column")
      return(list(kind = kind, columns = columns))
    }
    if (identical(kind, "directional")) {
      required <- c("kind", "direction", "orderBy")
      optional <- "maxGap"
      if (!all(required %in% names(replacement)) || any(!names(replacement) %in% c(required, optional))) {
        abort("invalid_request", "a directional replacement requires kind, direction, and orderBy")
      }
      direction <- bounded_text(
        replacement$direction,
        "request.payload.step.params.replacement.direction",
        16L
      )
      if (!direction %in% c("forward", "backward")) {
        abort("invalid_request", "a directional replacement must specify forward or backward")
      }
      order_by <- decode_sort_rules(replacement$orderBy, limits)
      if (length(order_by) == 0L) {
        abort("invalid_request", "a directional replacement requires at least one ordering column")
      }
      order_ids <- vapply(order_by, function(rule) rule$column$id, character(1L), USE.NAMES = FALSE)
      if (target_column$id %in% order_ids) {
        abort("invalid_request", "the fill target cannot also be a directional ordering column")
      }
      max_gap <- NULL
      if ("maxGap" %in% names(replacement)) {
        max_gap <- whole_number(
          replacement$maxGap,
          "request.payload.step.params.replacement.maxGap",
          maximum_fill_directional_gap
        )
        if (max_gap < 1) {
          abort("invalid_request", "request.payload.step.params.replacement.maxGap must be positive")
        }
        max_gap <- as.integer(max_gap)
      }
      result <- list(kind = kind, direction = direction, orderBy = order_by)
      if (!is.null(max_gap)) result$maxGap <- max_gap
      return(result)
    }
    if (identical(kind, "groupedStatistic")) {
      if (!setequal(names(replacement), c("kind", "statistic", "keys"))) {
        abort("invalid_request", "a grouped-statistic replacement requires exactly kind, statistic, and keys")
      }
      statistic <- bounded_text(
        replacement$statistic,
        "request.payload.step.params.replacement.statistic",
        16L
      )
      if (!statistic %in% c("median", "mean", "mostFrequent")) {
        abort("invalid_request", "a grouped-statistic replacement contains an unsupported statistic")
      }
      keys <- replacement$keys
      if (
        !is.list(keys) ||
          is.object(keys) ||
          !is.null(names(keys)) ||
          length(keys) == 0L ||
          length(keys) > limits$columns
      ) {
        abort("invalid_request", "grouping columns must be a bounded non-empty array")
      }
      keys <- lapply(seq_along(keys), function(index) {
        decode_column_reference(
          keys[[index]],
          sprintf("request.payload.step.params.replacement.keys[%d]", index),
          limits$columnIdBytes
        )
      })
      ids <- vapply(keys, `[[`, character(1L), "id", USE.NAMES = FALSE)
      if (anyDuplicated(ids)) abort("invalid_request", "grouping columns contain a repeated column identity")
      if (target_column$id %in% ids) abort("invalid_request", "the fill target cannot also be a grouping column")
      return(list(kind = kind, statistic = statistic, keys = keys))
    }
    if (identical(kind, "linearInterpolation")) {
      required <- c("kind", "coordinate")
      optional <- "maxGap"
      if (!all(required %in% names(replacement)) || any(!names(replacement) %in% c(required, optional))) {
        abort("invalid_request", "linear interpolation requires kind and one coordinate column")
      }
      coordinate <- decode_column_reference(
        replacement$coordinate,
        "request.payload.step.params.replacement.coordinate",
        limits$columnIdBytes
      )
      if (identical(coordinate$id, target_column$id)) {
        abort("invalid_request", "the fill target cannot also be the interpolation coordinate")
      }
      max_gap <- NULL
      if ("maxGap" %in% names(replacement)) {
        max_gap <- whole_number(
          replacement$maxGap,
          "request.payload.step.params.replacement.maxGap",
          maximum_fill_directional_gap
        )
        if (max_gap < 1) {
          abort("invalid_request", "request.payload.step.params.replacement.maxGap must be positive")
        }
        max_gap <- as.integer(max_gap)
      }
      result <- list(kind = kind, coordinate = coordinate)
      if (!is.null(max_gap)) result$maxGap <- max_gap
      return(result)
    }
    if (!"value" %in% names(replacement)) {
      abort("invalid_request", "a typed replacement requires a value")
    }
    if (!setequal(names(replacement), c("kind", "value"))) {
      abort("invalid_request", "a typed replacement may contain only kind and value")
    }
    if (identical(kind, "boolean")) {
      if (!is.logical(replacement$value) || length(replacement$value) != 1L || is.na(replacement$value)) {
        abort("invalid_request", "a boolean replacement value must be true or false")
      }
      return(list(kind = kind, value = replacement$value))
    }
    maximum <- switch(kind, string = 8192L, integer = 40L, float = 64L, decimal = 128L, date = 10L, datetime = 64L)
    text <- bounded_text(
      replacement$value,
      "request.payload.step.params.replacement.value",
      maximum
    )
    pattern <- switch(
      kind,
      integer = "^-?(?:0|[1-9][0-9]*)$",
      float = "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$",
      decimal = "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$",
      date = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
      NULL
    )
    if (!is.null(pattern) && !grepl(pattern, text, perl = TRUE)) {
      abort("invalid_request", "the replacement value is not canonical")
    }
    if (identical(kind, "datetime") && nchar(text, type = "chars") < 16L) {
      abort("invalid_request", "the datetime replacement value is too short")
    }
    list(kind = kind, value = text)
  }

  decode_transform_step <- function(value, limits) {
    step <- exact_record(value, c("id", "kind", "params"), "request.payload.step")
    step_id <- bounded_text(step$id, "request.payload.step.id", maximum_step_id_bytes)
    if (identical(step_id, "")) abort("invalid_request", "request.payload.step.id may not be empty")
    kind <- bounded_text(step$kind, "request.payload.step.kind", 64L)
    if (identical(kind, "sortRows")) {
      params <- exact_record(step$params, "rules", "request.payload.step.params")
      rules <- decode_sort_rules(params$rules, limits)
      if (length(rules) == 0L) {
        abort("invalid_request", "request.payload.step.params.rules must not be empty")
      }
      return(list(id = step_id, kind = kind, params = list(rules = rules)))
    }
    if (identical(kind, "filterRows")) {
      params <- exact_record(step$params, "filterModel", "request.payload.step.params")
      model <- exact_record(
        params$filterModel,
        c("filters", "sort"),
        "request.payload.step.params.filterModel",
        optional_fields = "logic"
      )
      view <- list(filters = model$filters, sorts = model$sort)
      if ("logic" %in% names(model)) view$logic <- model$logic
      decoded <- decode_view(view, limits)
      filter_ids <- vapply(decoded$filters, function(filter) filter$column$id, character(1L), USE.NAMES = FALSE)
      if (anyDuplicated(filter_ids)) {
        abort("invalid_request", "request.payload.step.params.filterModel.filters repeats a column identity")
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(filterModel = list(
          logic = decoded$logic,
          filters = decoded$filters,
          sort = decoded$sorts
        ))
      ))
    }
    if (kind %in% c("dropMissingRows", "dropDuplicates")) {
      optional_fields <- if (identical(kind, "dropMissingRows")) c("columns", "how") else c("columns", "keep")
      params <- exact_record(
        step$params,
        character(),
        "request.payload.step.params",
        optional_fields = optional_fields
      )
      columns <- if ("columns" %in% names(params)) params$columns else NULL
      allow_empty <- identical(kind, "dropMissingRows")
      if (
        !is.null(columns) && (
          !is.list(columns) ||
            is.object(columns) ||
            !is.null(names(columns)) ||
            (!allow_empty && length(columns) == 0L) ||
            length(columns) > limits$columns
        )
      ) {
        qualifier <- if (allow_empty) "a bounded array" else "a bounded non-empty array when supplied"
        abort("invalid_request", sprintf("request.payload.step.params.columns must be %s", qualifier))
      }
      if (!is.null(columns)) {
        columns <- lapply(seq_along(columns), function(index) {
          decode_column_reference(
            columns[[index]],
            sprintf("request.payload.step.params.columns[%d]", index),
            limits$columnIdBytes
          )
        })
      }
      column_ids <- vapply(columns, `[[`, character(1L), "id", USE.NAMES = FALSE)
      if (length(column_ids) > 0L && anyDuplicated(column_ids)) {
        abort("invalid_request", "request.payload.step.params.columns contains a repeated column identity")
      }
      if (identical(kind, "dropMissingRows")) {
        how <- if ("how" %in% names(params)) bounded_text(params$how, "request.payload.step.params.how", 8L) else "any"
        if (!how %in% c("any", "all")) {
          abort("invalid_request", "request.payload.step.params.how must be any or all")
        }
        return(list(id = step_id, kind = kind, params = list(columns = columns, how = how)))
      }
      keep <- if ("keep" %in% names(params)) bounded_text(params$keep, "request.payload.step.params.keep", 8L) else "first"
      if (!keep %in% c("first", "last", "none")) {
        abort("invalid_request", "request.payload.step.params.keep must be first, last, or none")
      }
      return(list(id = step_id, kind = kind, params = list(columns = columns, keep = keep)))
    }
    if (identical(kind, "fillMissingValues")) {
      params <- exact_record(
        step$params,
        c("column", "replacement"),
        "request.payload.step.params"
      )
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      return(list(
        id = step_id,
        kind = kind,
        params = list(
          column = column,
          replacement = decode_fill_missing_replacement(params$replacement, limits, column)
        )
      ))
    }
    if (kind %in% c("renameColumn", "cloneColumn")) {
      params <- exact_record(step$params, c("column", "newName"), "request.payload.step.params")
      new_name <- bounded_text(params$newName, "request.payload.step.params.newName", maximum_variable_name_bytes)
      if (identical(new_name, "")) {
        abort("invalid_request", "request.payload.step.params.newName may not be empty")
      }
      decoded <- list(
        id = step_id,
        kind = kind,
        params = list(
          column = decode_column_reference(
            params$column,
            "request.payload.step.params.column",
            limits$columnIdBytes
          ),
          newName = new_name
        )
      )
      if (identical(kind, "cloneColumn")) {
        decoded$outputId <- bounded_text(
          paste0("c:step:", step_id, ":0"),
          "the derived R clone column identity",
          limits$columnIdBytes
        )
      }
      return(decoded)
    }
    if (identical(kind, "textLength")) {
      params <- exact_record(step$params, c("column", "newColumn"), "request.payload.step.params")
      new_column <- bounded_text(
        params$newColumn,
        "request.payload.step.params.newColumn",
        maximum_variable_name_bytes
      )
      if (identical(new_column, "")) {
        abort("invalid_request", "request.payload.step.params.newColumn may not be empty")
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(
          column = decode_column_reference(
            params$column,
            "request.payload.step.params.column",
            limits$columnIdBytes
          ),
          newColumn = new_column
        ),
        outputId = bounded_text(
          paste0("c:step:", step_id, ":0"),
          "the derived R text-length column identity",
          limits$columnIdBytes
        )
      ))
    }
    if (kind %in% c("lowerText", "upperText", "capitalizeText")) {
      params <- exact_record(
        step$params,
        "column",
        "request.payload.step.params",
        optional_fields = "newColumn"
      )
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      new_column <- NULL
      if ("newColumn" %in% names(params)) {
        new_column <- bounded_text(
          params$newColumn,
          "request.payload.step.params.newColumn",
          maximum_variable_name_bytes
        )
        if (identical(new_column, "")) {
          abort("invalid_request", "request.payload.step.params.newColumn may not be empty")
        }
      }
      in_place <- is.null(new_column) || identical(new_column, column$name)
      return(list(
        id = step_id,
        kind = kind,
        params = list(column = column, newColumn = new_column),
        outputId = if (in_place) {
          column$id
        } else {
          bounded_text(
            paste0("c:step:", step_id, ":0"),
            sprintf(
              "the derived R %s column identity",
              switch(kind, lowerText = "lowercase", upperText = "uppercase", capitalizeText = "capitalized")
            ),
            limits$columnIdBytes
          )
        }
      ))
    }
    if (identical(kind, "stripText")) {
      params <- exact_record(
        step$params,
        "column",
        "request.payload.step.params",
        optional_fields = c("characters", "newColumn")
      )
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      characters <- NULL
      if ("characters" %in% names(params) && !is.null(params$characters)) {
        characters <- bounded_text(params$characters, "request.payload.step.params.characters", 8192L)
        if (identical(characters, "")) {
          abort("invalid_request", "request.payload.step.params.characters must be a non-empty string or null")
        }
      }
      new_column <- NULL
      if ("newColumn" %in% names(params)) {
        new_column <- bounded_text(
          params$newColumn,
          "request.payload.step.params.newColumn",
          maximum_variable_name_bytes
        )
        if (identical(new_column, "")) {
          abort("invalid_request", "request.payload.step.params.newColumn may not be empty")
        }
      }
      in_place <- is.null(new_column) || identical(new_column, column$name)
      return(list(
        id = step_id,
        kind = kind,
        params = list(column = column, characters = characters, newColumn = new_column),
        outputId = if (in_place) {
          column$id
        } else {
          bounded_text(
            paste0("c:step:", step_id, ":0"),
            "the derived R stripped-text column identity",
            limits$columnIdBytes
          )
        }
      ))
    }
    if (identical(kind, "splitText")) {
      params <- exact_record(
        step$params,
        c("column", "delimiter", "index", "newColumn"),
        "request.payload.step.params"
      )
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      delimiter <- bounded_text(params$delimiter, "request.payload.step.params.delimiter", 8192L)
      if (identical(delimiter, "")) {
        abort("invalid_request", "request.payload.step.params.delimiter must be a non-empty string")
      }
      index <- whole_number(params$index, "request.payload.step.params.index", maximum_revision)
      new_column <- bounded_text(
        params$newColumn,
        "request.payload.step.params.newColumn",
        maximum_variable_name_bytes
      )
      if (identical(new_column, "") || identical(new_column, column$name)) {
        abort("invalid_request", "request.payload.step.params.newColumn must name a new output column")
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(
          column = column,
          delimiter = delimiter,
          index = index,
          newColumn = new_column
        ),
        outputId = bounded_text(
          paste0("c:step:", step_id, ":0"),
          "the derived R split-text column identity",
          limits$columnIdBytes
        )
      ))
    }
    if (identical(kind, "findReplace")) {
      params <- exact_record(
        step$params,
        c("column", "find", "replacement"),
        "request.payload.step.params",
        optional_fields = c("regex", "newColumn")
      )
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      find <- bounded_text(params$find, "request.payload.step.params.find", 8192L)
      replacement <- bounded_text(params$replacement, "request.payload.step.params.replacement", 8192L)
      regex <- if ("regex" %in% names(params)) params$regex else FALSE
      if (!is.logical(regex) || length(regex) != 1L || is.na(regex)) {
        abort("invalid_request", "request.payload.step.params.regex must be true or false")
      }
      new_column <- NULL
      if ("newColumn" %in% names(params)) {
        new_column <- bounded_text(
          params$newColumn,
          "request.payload.step.params.newColumn",
          maximum_variable_name_bytes
        )
        if (identical(new_column, "")) {
          abort("invalid_request", "request.payload.step.params.newColumn may not be empty")
        }
      }
      in_place <- is.null(new_column) || identical(new_column, column$name)
      return(list(
        id = step_id,
        kind = kind,
        params = list(
          column = column,
          find = find,
          replacement = replacement,
          regex = regex,
          newColumn = new_column
        ),
        outputId = if (in_place) {
          column$id
        } else {
          bounded_text(
            paste0("c:step:", step_id, ":0"),
            "the derived R find-and-replace column identity",
            limits$columnIdBytes
          )
        }
      ))
    }
    if (kind %in% c("roundNumber", "floorNumber", "ceilNumber")) {
      optional_fields <- if (identical(kind, "roundNumber")) {
        c("decimals", "newColumn")
      } else {
        "newColumn"
      }
      params <- exact_record(
        step$params,
        "column",
        "request.payload.step.params",
        optional_fields = optional_fields
      )
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      decimals <- if (identical(kind, "roundNumber") && "decimals" %in% names(params)) {
        signed_whole_number(
          params$decimals,
          "request.payload.step.params.decimals",
          maximum_revision
        )
      } else {
        0
      }
      new_column <- NULL
      if ("newColumn" %in% names(params)) {
        new_column <- bounded_text(
          params$newColumn,
          "request.payload.step.params.newColumn",
          maximum_variable_name_bytes
        )
        if (identical(new_column, "")) {
          abort("invalid_request", "request.payload.step.params.newColumn may not be empty")
        }
      }
      in_place <- is.null(new_column) || identical(new_column, column$name)
      return(list(
        id = step_id,
        kind = kind,
        params = list(column = column, decimals = decimals, newColumn = new_column),
        outputId = if (in_place) {
          column$id
        } else {
          bounded_text(
            paste0("c:step:", step_id, ":0"),
            sprintf("the derived R %s column identity", kind),
            limits$columnIdBytes
          )
        }
      ))
    }
    if (identical(kind, "castColumn")) {
      params <- exact_record(step$params, c("column", "dtype"), "request.payload.step.params")
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      dtype <- bounded_text(params$dtype, "request.payload.step.params.dtype", 32L)
      if (!dtype %in% c("string", "integer", "float", "boolean", "date", "datetime")) {
        abort("invalid_request", "request.payload.step.params.dtype is unsupported")
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(column = column, dtype = dtype)
      ))
    }
    if (kind %in% c("dropColumns", "selectColumns")) {
      params <- exact_record(step$params, "columns", "request.payload.step.params")
      columns <- params$columns
      if (
        !is.list(columns) ||
          is.object(columns) ||
          !is.null(names(columns)) ||
          length(columns) == 0L ||
          length(columns) > limits$columns
      ) {
        abort("invalid_request", "request.payload.step.params.columns must be a bounded non-empty array")
      }
      columns <- lapply(seq_along(columns), function(index) {
        decode_column_reference(
          columns[[index]],
          sprintf("request.payload.step.params.columns[%d]", index),
          limits$columnIdBytes
        )
      })
      column_ids <- vapply(columns, `[[`, character(1L), "id", USE.NAMES = FALSE)
      if (anyDuplicated(column_ids)) {
        abort("invalid_request", "request.payload.step.params.columns contains a repeated column identity")
      }
      return(list(id = step_id, kind = kind, params = list(columns = columns)))
    }
    if (!kind %in% c(
      "renameColumn",
      "cloneColumn",
      "dropColumns",
      "selectColumns",
      "textLength",
      "lowerText",
      "upperText",
      "capitalizeText",
      "stripText",
      "splitText",
      "findReplace",
      "roundNumber",
      "floorNumber",
      "ceilNumber",
      "fillMissingValues",
      "castColumn"
    )) {
      abort("unsupported_operation", sprintf("The native R runtime does not support %s", kind))
    }
    abort("unsupported_operation", sprintf("The native R runtime does not support %s", kind))
  }

  bind_rename_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The rename column reference no longer matches the active R dataframe", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = step$params$newName
    )
  }

  bind_clone_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The clone column reference no longer matches the active R dataframe", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = step$params$newName,
      outputId = step$outputId
    )
  }

  bind_text_length_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The text length column reference no longer matches the active R dataframe", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = step$params$newColumn,
      outputId = step$outputId
    )
  }

  bind_text_transform_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The text-transform column reference no longer matches the active R dataframe", TRUE)
    }
    in_place <- is.null(step$params$newColumn) || identical(step$params$newColumn, step$params$column$name)
    bound <- list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = if (in_place) step$params$column$name else step$params$newColumn,
      inPlace = in_place,
      outputId = step$outputId
    )
    if (identical(step$kind, "findReplace")) {
      bound$find <- step$params$find
      bound$replacement <- step$params$replacement
      bound$regex <- step$params$regex
    } else if (identical(step$kind, "stripText")) {
      bound$characters <- step$params$characters
    } else if (identical(step$kind, "splitText")) {
      bound$delimiter <- step$params$delimiter
      bound$index <- step$params$index
    }
    bound
  }

  bind_numeric_transform_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The numeric column reference no longer matches the active R dataframe", TRUE)
    }
    position <- as.integer(matches[[1L]])
    column <- schema[[position]]
    if (!column$semantics$kind %in% c("integer", "double", "integer64")) {
      abort("invalid_request", "The selected R column is not numeric", TRUE)
    }
    in_place <- is.null(step$params$newColumn) || identical(step$params$newColumn, step$params$column$name)
    key_column_ids <- capture$descriptor$frameSemantics$keyColumnIds
    if (is.null(key_column_ids)) key_column_ids <- character()
    if (in_place && column$id %in% key_column_ids) {
      abort(
        "invalid_request",
        sprintf("%s cannot replace a data.table key column; choose a new output column", step$kind),
        TRUE
      )
    }
    list(
      id = step$id,
      kind = step$kind,
      position = position,
      oldName = step$params$column$name,
      newName = if (in_place) step$params$column$name else step$params$newColumn,
      inPlace = in_place,
      outputId = step$outputId,
      semanticKind = column$semantics$kind,
      decimals = step$params$decimals
    )
  }

  bind_fill_missing_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The fill-missing column reference no longer matches the active R dataframe", TRUE)
    }
    position <- as.integer(matches[[1L]])
    column <- schema[[position]]
    semantic_kind <- column$semantics$kind
    replacement_kind <- step$params$replacement$kind
    compatible <- if (identical(replacement_kind, "linearInterpolation")) {
      identical(semantic_kind, "double")
    } else if (identical(replacement_kind, "groupedStatistic")) {
      switch(
        step$params$replacement$statistic,
        mean = identical(semantic_kind, "double"),
        median = semantic_kind %in% c("integer", "integer64", "double"),
        mostFrequent = semantic_kind %in% c("character", "factor", "logical"),
        FALSE
      )
    } else if (identical(replacement_kind, "directional")) {
      semantic_kind %in% c(
        "character", "factor", "integer", "integer64", "double", "logical", "date", "datetime", "difftime"
      )
    } else if (identical(replacement_kind, "fallbackColumns")) {
      semantic_kind %in% c("character", "factor", "integer", "integer64", "double", "logical", "date", "datetime")
    } else {
      switch(
        semantic_kind,
        character = replacement_kind %in% c("mostFrequent", "string"),
        factor = replacement_kind %in% c("mostFrequent", "string"),
        integer = replacement_kind %in% c("median", "integer"),
        integer64 = replacement_kind %in% c("median", "integer"),
        double = replacement_kind %in% c("mean", "median", "integer", "float"),
        logical = replacement_kind %in% c("mostFrequent", "boolean"),
        date = identical(replacement_kind, "date"),
        datetime = identical(replacement_kind, "datetime"),
        FALSE
      )
    }
    if (!compatible) {
      abort("invalid_request", "The replacement is incompatible with the selected R column", TRUE)
    }
    key_column_ids <- capture$descriptor$frameSemantics$keyColumnIds
    if (is.null(key_column_ids)) key_column_ids <- character()
    if (column$id %in% key_column_ids) {
      abort("invalid_request", "Fill Missing Values cannot replace a data.table key column", TRUE)
    }
    fallback_columns <- list()
    if (identical(replacement_kind, "fallbackColumns")) {
      compatible_fallback_kind <- function(fallback_kind) {
        if (semantic_kind %in% c("character", "factor")) return(fallback_kind %in% c("character", "factor"))
        if (semantic_kind %in% c("integer", "integer64")) return(fallback_kind %in% c("integer", "integer64"))
        identical(fallback_kind, semantic_kind)
      }
      fallback_columns <- lapply(seq_along(step$params$replacement$columns), function(index) {
        reference <- step$params$replacement$columns[[index]]
        fallback_matches <- which(vapply(schema, function(candidate) identical(candidate$id, reference$id), logical(1L)))
        if (
          length(fallback_matches) != 1L ||
            !identical(schema[[fallback_matches[[1L]]]]$name, reference$name)
        ) {
          abort("stale_column", "A fallback column reference no longer matches the active R dataframe", TRUE)
        }
        fallback_position <- as.integer(fallback_matches[[1L]])
        fallback <- schema[[fallback_position]]
        if (identical(fallback$id, column$id)) {
          abort("invalid_request", "The fill target cannot also be a fallback column", TRUE)
        }
        if (!compatible_fallback_kind(fallback$semantics$kind)) {
          abort(
            "invalid_request",
            sprintf("Fallback column %s is incompatible with the selected R column", fallback$name),
            TRUE
          )
        }
        list(
          id = fallback$id,
          position = fallback_position,
          oldName = fallback$name,
          semanticKind = fallback$semantics$kind
        )
      })
    }
    order_by <- list()
    if (identical(replacement_kind, "directional")) {
      order_by <- lapply(seq_along(step$params$replacement$orderBy), function(index) {
        rule <- step$params$replacement$orderBy[[index]]
        reference <- rule$column
        order_matches <- which(vapply(schema, function(candidate) identical(candidate$id, reference$id), logical(1L)))
        if (
          length(order_matches) != 1L ||
            !identical(schema[[order_matches[[1L]]]]$name, reference$name)
        ) {
          abort("stale_column", "A directional ordering column no longer matches the active R dataframe", TRUE)
        }
        order_position <- as.integer(order_matches[[1L]])
        order_column <- schema[[order_position]]
        if (identical(order_column$id, column$id)) {
          abort("invalid_request", "The fill target cannot also be a directional ordering column", TRUE)
        }
        list(
          id = order_column$id,
          position = order_position,
          name = order_column$name,
          semanticsKind = order_column$semantics$kind,
          units = order_column$semantics$units,
          direction = rule$direction,
          nulls = rule$nulls
        )
      })
    }
    group_keys <- list()
    if (identical(replacement_kind, "groupedStatistic")) {
      supported_key_kinds <- c(
        "character", "factor", "integer", "integer64", "double", "logical", "date", "datetime", "difftime"
      )
      group_keys <- lapply(seq_along(step$params$replacement$keys), function(index) {
        reference <- step$params$replacement$keys[[index]]
        key_matches <- which(vapply(schema, function(candidate) identical(candidate$id, reference$id), logical(1L)))
        if (
          length(key_matches) != 1L ||
            !identical(schema[[key_matches[[1L]]]]$name, reference$name)
        ) {
          abort("stale_column", "A grouping column no longer matches the active R dataframe", TRUE)
        }
        key_position <- as.integer(key_matches[[1L]])
        key_column <- schema[[key_position]]
        if (identical(key_column$id, column$id)) {
          abort("invalid_request", "The fill target cannot also be a grouping column", TRUE)
        }
        if (!key_column$semantics$kind %in% supported_key_kinds) {
          abort(
            "invalid_request",
            sprintf("R %s columns cannot be used as grouped-fill keys", key_column$semantics$kind),
            TRUE
          )
        }
        list(
          id = key_column$id,
          position = key_position,
          name = key_column$name,
          semanticsKind = key_column$semantics$kind,
          units = key_column$semantics$units,
          direction = "asc",
          nulls = "first"
        )
      })
      key_ids <- vapply(group_keys, `[[`, character(1L), "id", USE.NAMES = FALSE)
      if (length(group_keys) == 0L || anyDuplicated(key_ids)) {
        abort("invalid_request", "Grouped fill requires unique grouping columns", TRUE)
      }
    }
    interpolation_coordinate <- NULL
    if (identical(replacement_kind, "linearInterpolation")) {
      reference <- step$params$replacement$coordinate
      coordinate_matches <- which(vapply(schema, function(candidate) identical(candidate$id, reference$id), logical(1L)))
      if (
        length(coordinate_matches) != 1L ||
          !identical(schema[[coordinate_matches[[1L]]]]$name, reference$name)
      ) {
        abort("stale_column", "The interpolation coordinate no longer matches the active R dataframe", TRUE)
      }
      coordinate_position <- as.integer(coordinate_matches[[1L]])
      coordinate_column <- schema[[coordinate_position]]
      if (identical(coordinate_column$id, column$id)) {
        abort("invalid_request", "The fill target cannot also be the interpolation coordinate", TRUE)
      }
      if (!coordinate_column$semantics$kind %in% c("integer", "double", "date", "datetime")) {
        abort(
          "invalid_request",
          "Linear interpolation requires a numeric, Date, or POSIXct coordinate column",
          TRUE
        )
      }
      interpolation_coordinate <- list(
        id = coordinate_column$id,
        position = coordinate_position,
        name = coordinate_column$name,
        semanticsKind = coordinate_column$semantics$kind
      )
    }
    list(
      id = step$id,
      kind = step$kind,
      position = position,
      oldName = step$params$column$name,
      newName = step$params$column$name,
      inPlace = TRUE,
      outputId = step$params$column$id,
      columnType = column$type,
      semanticKind = semantic_kind,
      ordered = isTRUE(column$semantics$ordered),
      levels = if (is.null(column$semantics$levels)) character() else column$semantics$levels,
      replacement = step$params$replacement,
      fallbackColumns = fallback_columns,
      orderBy = order_by,
      groupKeys = group_keys,
      interpolationCoordinate = interpolation_coordinate
    )
  }

  bind_cast_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The cast column reference no longer matches the active R dataframe", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = step$params$column$name,
      inPlace = TRUE,
      outputId = step$params$column$id,
      dtype = step$params$dtype
    )
  }

  bind_drop_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    schema_ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    columns <- lapply(step$params$columns, function(reference) {
      matches <- which(schema_ids == reference$id)
      if (length(matches) != 1L || !identical(schema[[matches[[1L]]]]$name, reference$name)) {
        abort("stale_column", "A drop column reference no longer matches the active R dataframe", TRUE)
      }
      list(
        id = reference$id,
        position = as.integer(matches[[1L]]),
        name = reference$name
      )
    })
    if (length(columns) >= length(schema)) {
      abort("invalid_request", "dropColumns must leave at least one visible column", TRUE)
    }
    positions <- vapply(columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    columns <- columns[order(positions)]
    list(id = step$id, kind = step$kind, columns = columns)
  }

  bind_select_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    schema_ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    columns <- lapply(step$params$columns, function(reference) {
      matches <- which(schema_ids == reference$id)
      if (length(matches) != 1L || !identical(schema[[matches[[1L]]]]$name, reference$name)) {
        abort("stale_column", "A selected column reference no longer matches the active R dataframe", TRUE)
      }
      list(
        id = reference$id,
        position = as.integer(matches[[1L]]),
        name = reference$name
      )
    })
    selected_positions <- vapply(columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    removed_names <- vapply(
      schema[setdiff(seq_along(schema), selected_positions)],
      `[[`,
      character(1L),
      "name",
      USE.NAMES = FALSE
    )
    list(id = step$id, kind = step$kind, columns = columns, removedNames = removed_names)
  }

  bind_row_reduction_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    schema_ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    references <- step$params$columns
    columns <- if (
      is.null(references) ||
        (identical(step$kind, "dropMissingRows") && length(references) == 0L)
    ) {
      lapply(seq_along(schema), function(position) {
        list(
          id = schema[[position]]$id,
          position = as.integer(position),
          name = schema[[position]]$name
        )
      })
    } else {
      lapply(references, function(reference) {
        matches <- which(schema_ids == reference$id)
        if (length(matches) != 1L || !identical(schema[[matches[[1L]]]]$name, reference$name)) {
          abort("stale_column", "A row-reduction column reference no longer matches the active R dataframe", TRUE)
        }
        list(
          id = reference$id,
          position = as.integer(matches[[1L]]),
          name = reference$name
        )
      })
    }
    list(
      id = step$id,
      kind = step$kind,
      columns = columns,
      mode = if (identical(step$kind, "dropMissingRows")) step$params$how else step$params$keep
    )
  }

  bind_row_sort_rule <- function(capture, rule) {
    column <- capture$descriptor$schema[[rule$position]]
    list(
      position = as.integer(rule$position),
      name = column$name,
      semanticsKind = column$semantics$kind,
      direction = rule$direction,
      nulls = rule$nulls
    )
  }

  bind_row_filter <- function(capture, filter) {
    column <- capture$descriptor$schema[[filter$position]]
    predicates <- lapply(filter$predicates, function(predicate) {
      bound <- list(operator = predicate$operator)
      if ("valueKey" %in% names(predicate)) bound$valueKey <- predicate$valueKey
      if ("secondValueKey" %in% names(predicate)) bound$secondValueKey <- predicate$secondValueKey
      bound
    })
    value_filter <- if (is.null(filter$valueFilter)) {
      NULL
    } else {
      list(
        selectedKeys = unname(filter$valueFilter$selectedKeys),
        includeNulls = isTRUE(filter$valueFilter$includeNulls),
        includeNaN = isTRUE(filter$valueFilter$includeNaN)
      )
    }
    list(
      position = as.integer(filter$position),
      name = column$name,
      type = column$type,
      semanticsKind = column$semantics$kind,
      units = column$semantics$units,
      logic = filter$logic,
      predicates = predicates,
      valueFilter = value_filter
    )
  }

  bind_row_step <- function(capture, step, resolved) {
    rules <- lapply(resolved$sorts, function(rule) bind_row_sort_rule(capture, rule))
    if (identical(step$kind, "sortRows")) {
      return(list(id = step$id, kind = step$kind, rules = rules))
    }
    list(
      id = step$id,
      kind = step$kind,
      filterModel = list(
        logic = resolved$logic,
        filters = lapply(resolved$filters, function(filter) bind_row_filter(capture, filter)),
        sort = rules
      )
    )
  }

  apply_step <- function(frame_contract, capture, step) {
    source <- get("snapshot", envir = capture, inherits = FALSE)
    if (step$kind %in% c("sortRows", "filterRows")) {
      view <- if (identical(step$kind, "sortRows")) {
        list(filters = list(), sorts = step$params$rules)
      } else {
        model <- step$params$filterModel
        list(logic = model$logic, filters = model$filters, sorts = model$sort)
      }
      transformed <- frame_contract$transform_rows(capture, view)
      bound <- bind_row_step(capture, step, transformed$resolved)
      return(list(
        capture = frame_contract$capture_frame(
          transformed$frame,
          nullability_source = capture,
          source_positions = seq_along(capture$descriptor$schema),
          source_row_positions = transformed$sourcePositions
        ),
        bound = bound
      ))
    }
    if (step$kind %in% c("dropMissingRows", "dropDuplicates")) {
      bound <- bind_row_reduction_step(capture, step)
      positions <- vapply(bound$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
      names <- vapply(bound$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
      transformed <- if (identical(step$kind, "dropMissingRows")) {
        frame_contract$drop_missing_rows_at(source, positions, names, bound$mode)
      } else {
        frame_contract$drop_duplicate_rows_at(source, positions, names, bound$mode)
      }
      return(list(
        capture = frame_contract$capture_frame(
          transformed$frame,
          nullability_source = capture,
          source_positions = seq_along(capture$descriptor$schema),
          source_row_positions = transformed$sourcePositions
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "renameColumn")) {
      bound <- bind_rename_step(capture, step)
      result <- frame_contract$rename_column_at(source, bound$position, bound$oldName, bound$newName)
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = seq_along(capture$descriptor$schema)
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "cloneColumn")) {
      bound <- bind_clone_step(capture, step)
      result <- frame_contract$clone_column_at(source, bound$position, bound$oldName, bound$newName)
      source_positions <- c(seq_along(capture$descriptor$schema), bound$position)
      output_ids <- c(
        vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
        bound$outputId
      )
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = source_positions,
          output_ids = output_ids
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "textLength")) {
      bound <- bind_text_length_step(capture, step)
      result <- frame_contract$text_length_column_at(source, bound$position, bound$oldName, bound$newName)
      source_positions <- c(seq_along(capture$descriptor$schema), bound$position)
      output_ids <- c(
        vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
        bound$outputId
      )
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = source_positions,
          output_ids = output_ids,
          text_length_positions = length(output_ids)
        ),
        bound = bound
      ))
    }
    if (step$kind %in% c("lowerText", "upperText", "capitalizeText", "stripText", "splitText", "findReplace")) {
      bound <- bind_text_transform_step(capture, step)
      new_name <- if (isTRUE(bound$inPlace)) NULL else bound$newName
      result <- switch(
        step$kind,
        lowerText = frame_contract$lower_text_column_at(source, bound$position, bound$oldName, new_name),
        upperText = frame_contract$upper_text_column_at(source, bound$position, bound$oldName, new_name),
        capitalizeText = frame_contract$capitalize_text_column_at(source, bound$position, bound$oldName, new_name),
        stripText = frame_contract$strip_text_column_at(
          source,
          bound$position,
          bound$oldName,
          bound$characters,
          new_name
        ),
        splitText = frame_contract$split_text_column_at(
          source,
          bound$position,
          bound$oldName,
          bound$delimiter,
          bound$index,
          new_name
        ),
        findReplace = frame_contract$find_replace_column_at(
          source,
          bound$position,
          bound$oldName,
          bound$find,
          bound$replacement,
          bound$regex,
          new_name
        )
      )
      if (isTRUE(bound$inPlace)) {
        source_positions <- seq_along(capture$descriptor$schema)
        output_ids <- vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
        transform_position <- bound$position
      } else {
        source_positions <- c(seq_along(capture$descriptor$schema), bound$position)
        output_ids <- c(
          vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
          bound$outputId
        )
        transform_position <- length(output_ids)
      }
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = source_positions,
          output_ids = output_ids,
          text_transform_positions = transform_position
        ),
        bound = bound
      ))
    }
    if (step$kind %in% c("roundNumber", "floorNumber", "ceilNumber")) {
      bound <- bind_numeric_transform_step(capture, step)
      new_name <- if (isTRUE(bound$inPlace)) NULL else bound$newName
      result <- switch(
        step$kind,
        roundNumber = frame_contract$round_number_column_at(
          source,
          bound$position,
          bound$oldName,
          bound$decimals,
          new_name
        ),
        floorNumber = frame_contract$floor_number_column_at(
          source,
          bound$position,
          bound$oldName,
          new_name
        ),
        ceilNumber = frame_contract$ceil_number_column_at(
          source,
          bound$position,
          bound$oldName,
          new_name
        )
      )
      if (isTRUE(bound$inPlace)) {
        source_positions <- seq_along(capture$descriptor$schema)
        output_ids <- vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
        transform_position <- bound$position
      } else {
        source_positions <- c(seq_along(capture$descriptor$schema), bound$position)
        output_ids <- c(
          vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
          bound$outputId
        )
        transform_position <- length(output_ids)
      }
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = source_positions,
          output_ids = output_ids,
          numeric_transform_positions = transform_position
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "fillMissingValues")) {
      bound <- bind_fill_missing_step(capture, step)
      fallback_fill <- identical(bound$replacement$kind, "fallbackColumns")
      directional_fill <- identical(bound$replacement$kind, "directional")
      grouped_fill <- identical(bound$replacement$kind, "groupedStatistic")
      interpolation_fill <- identical(bound$replacement$kind, "linearInterpolation")
      result <- if (fallback_fill) {
        frame_contract$fill_missing_from_fallback_columns_at(
          source,
          bound$position,
          bound$oldName,
          vapply(bound$fallbackColumns, `[[`, integer(1L), "position", USE.NAMES = FALSE),
          vapply(bound$fallbackColumns, `[[`, character(1L), "oldName", USE.NAMES = FALSE)
        )
      } else if (directional_fill) {
        frame_contract$fill_missing_directional_at(
          source,
          bound$position,
          bound$oldName,
          vapply(bound$orderBy, `[[`, integer(1L), "position", USE.NAMES = FALSE),
          vapply(bound$orderBy, `[[`, character(1L), "name", USE.NAMES = FALSE),
          vapply(bound$orderBy, `[[`, character(1L), "direction", USE.NAMES = FALSE),
          vapply(bound$orderBy, `[[`, character(1L), "nulls", USE.NAMES = FALSE),
          bound$replacement$direction,
          bound$replacement$maxGap
        )
      } else if (grouped_fill) {
        frame_contract$fill_missing_grouped_statistic_at(
          source,
          bound$position,
          bound$oldName,
          vapply(bound$groupKeys, `[[`, integer(1L), "position", USE.NAMES = FALSE),
          vapply(bound$groupKeys, `[[`, character(1L), "name", USE.NAMES = FALSE),
          bound$replacement$statistic
        )
      } else if (interpolation_fill) {
        frame_contract$fill_missing_linear_interpolation_at(
          source,
          bound$position,
          bound$oldName,
          bound$interpolationCoordinate$position,
          bound$interpolationCoordinate$name,
          bound$replacement$maxGap
        )
      } else {
        frame_contract$fill_missing_column_at(
          source,
          bound$position,
          bound$oldName,
          bound$replacement
        )
      }
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = seq_along(capture$descriptor$schema),
          fill_missing_positions = if (fallback_fill || directional_fill || grouped_fill || interpolation_fill) NULL else bound$position,
          fallback_fill_positions = if (fallback_fill) bound$position else NULL
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "castColumn")) {
      bound <- bind_cast_step(capture, step)
      result <- frame_contract$cast_column_at(source, bound$position, bound$oldName, bound$dtype)
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = seq_along(capture$descriptor$schema),
          cast_positions = bound$position,
          cast_dtypes = bound$dtype
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "dropColumns")) {
      bound <- bind_drop_step(capture, step)
      positions <- vapply(bound$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
      names <- vapply(bound$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
      result <- frame_contract$drop_columns_at(source, positions, names)
      keep_positions <- setdiff(seq_along(capture$descriptor$schema), positions)
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = keep_positions
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "selectColumns")) {
      bound <- bind_select_step(capture, step)
      positions <- vapply(bound$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
      names <- vapply(bound$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
      result <- frame_contract$select_columns_at(source, positions, names)
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = positions
        ),
        bound = bound
      ))
    }
    abort("unsupported_operation", sprintf("The native R runtime does not support %s", step$kind))
  }

  replay_plan <- function(frame_contract, original, plan) {
    capture <- original
    bound_plan <- vector("list", length(plan))
    if (length(plan) != 0L) {
      for (index in seq_along(plan)) {
        applied <- apply_step(frame_contract, capture, plan[[index]])
        capture <- applied$capture
        bound_plan[[index]] <- applied$bound
      }
    }
    list(capture = capture, boundPlan = bound_plan)
  }

  begin_editing <- function(frame_contract, session) {
    if (!is.null(session$original)) return(session)
    original <- frame_contract$isolate_capture(session$source)
    session$original <- original
    session$committed <- original
    session$editing <- TRUE
    session
  }

  r_string <- function(value) {
    encodeString(value, quote = "\"", justify = "none", na.encode = FALSE)
  }

  r_character_vector <- function(values) {
    if (length(values) == 0L) return("character()")
    sprintf(
      "c(%s)",
      paste(vapply(values, r_string, character(1L), USE.NAMES = FALSE), collapse = ", ")
    )
  }

  row_type_guard <- function(variable, specification) {
    condition <- switch(
      specification$semanticsKind,
      factor = sprintf("is.factor(%s)", variable),
      integer64 = sprintf("inherits(%s, \"integer64\")", variable),
      datetime = sprintf("inherits(%s, \"POSIXct\")", variable),
      date = sprintf("inherits(%s, \"Date\")", variable),
      difftime = sprintf("inherits(%s, \"difftime\")", variable),
      logical = sprintf("is.logical(%s)", variable),
      integer = sprintf("is.integer(%s) && !is.factor(%s)", variable, variable),
      double = sprintf(
        "is.double(%s) && !inherits(%s, c(\"integer64\", \"POSIXct\", \"Date\", \"difftime\"))",
        variable,
        variable
      ),
      character = sprintf("is.character(%s)", variable),
      abort("runtime_error", "Generated R code received an unsupported row-column type")
    )
    sprintf(
      "  if (!(%s)) stop(\"Open Wrangler column type is stale\", call. = FALSE)",
      condition
    )
  }

  row_column_lines <- function(specification, variable) {
    lines <- c(
      sprintf(
        "  if (ncol(.ow_result) < %dL || !identical(names(.ow_result)[[%dL]], %s)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
        specification$position,
        specification$position,
        r_string(specification$name)
      ),
      sprintf("  %s <- .ow_result[[%dL]]", variable, specification$position),
      row_type_guard(variable, specification)
    )
    if (identical(specification$semanticsKind, "difftime")) {
      lines <- c(
        lines,
        sprintf(
          "  if (!identical(attr(%s, \"units\", exact = TRUE), %s)) stop(\"Open Wrangler duration units are stale\", call. = FALSE)",
          variable,
          r_string(specification$units)
        )
      )
    }
    lines
  }

  row_comparable <- function(variable, specification) {
    switch(
      specification$semanticsKind,
      logical = variable,
      integer = sprintf("as.double(%s)", variable),
      integer64 = variable,
      double = variable,
      character = variable,
      factor = sprintf("as.character(%s)", variable),
      date = sprintf("as.double(%s)", variable),
      datetime = sprintf("as.double(%s)", variable),
      difftime = sprintf("as.double(%s, units = %s)", variable, r_string(specification$units)),
      abort("runtime_error", "Generated R code received an unsupported row comparison")
    )
  }

  row_target <- function(value_key, specification) {
    switch(
      specification$semanticsKind,
      logical = if (identical(value_key, "TRUE")) "TRUE" else "FALSE",
      integer = sprintf("as.double(%s)", r_string(value_key)),
      integer64 = sprintf("bit64::as.integer64(%s)", r_string(value_key)),
      double = sprintf("as.double(%s)", r_string(value_key)),
      character = r_string(value_key),
      factor = r_string(value_key),
      date = sprintf("as.double(%s)", r_string(value_key)),
      datetime = sprintf("as.double(%s)", r_string(value_key)),
      difftime = sprintf("as.double(%s)", r_string(value_key)),
      abort("runtime_error", "Generated R code received an unsupported row comparison target")
    )
  }

  row_targets <- function(value_keys, specification) {
    if (length(value_keys) == 0L) return("NULL")
    switch(
      specification$semanticsKind,
      logical = sprintf(
        "c(%s)",
        paste(ifelse(value_keys == "TRUE", "TRUE", "FALSE"), collapse = ", ")
      ),
      integer64 = sprintf("bit64::as.integer64(%s)", r_character_vector(value_keys)),
      integer = sprintf("as.double(%s)", r_character_vector(value_keys)),
      double = sprintf("as.double(%s)", r_character_vector(value_keys)),
      date = sprintf("as.double(%s)", r_character_vector(value_keys)),
      datetime = sprintf("as.double(%s)", r_character_vector(value_keys)),
      difftime = sprintf("as.double(%s)", r_character_vector(value_keys)),
      character = r_character_vector(value_keys),
      factor = r_character_vector(value_keys),
      abort("runtime_error", "Generated R code received unsupported selected row values")
    )
  }

  row_predicate_expression <- function(predicate, specification, variable, null_mask, nan_mask) {
    operator <- predicate$operator
    if (identical(operator, "isNull")) return(null_mask)
    if (identical(operator, "isNotNull")) return(sprintf("!%s", null_mask))
    if (identical(operator, "isNaN")) return(nan_mask)
    if (identical(operator, "isNotNaN")) return(sprintf("!%s", nan_mask))
    present <- sprintf("(!%s & !%s)", null_mask, nan_mask)
    values <- row_comparable(variable, specification)
    if (identical(operator, "contains")) {
      folded <- chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", predicate$valueKey)
      return(sprintf(
        "%s & grepl(%s, chartr(\"ABCDEFGHIJKLMNOPQRSTUVWXYZ\", \"abcdefghijklmnopqrstuvwxyz\", as.character(%s)), fixed = TRUE)",
        present,
        r_string(folded),
        variable
      ))
    }
    if (identical(operator, "startsWith")) {
      return(sprintf("%s & startsWith(as.character(%s), %s)", present, variable, r_string(predicate$valueKey)))
    }
    if (identical(operator, "endsWith")) {
      return(sprintf("%s & endsWith(as.character(%s), %s)", present, variable, r_string(predicate$valueKey)))
    }
    comparison <- switch(
      operator,
      equals = "==",
      notEquals = "!=",
      gt = ">",
      gte = ">=",
      lt = "<",
      lte = "<=",
      between = NULL,
      abort("runtime_error", "Generated R code received an unsupported row predicate")
    )
    if (identical(operator, "between")) {
      return(sprintf(
        "%s & %s >= %s & %s <= %s",
        present,
        values,
        row_target(predicate$valueKey, specification),
        values,
        row_target(predicate$secondValueKey, specification)
      ))
    }
    sprintf(
      "%s & %s %s %s",
      present,
      values,
      comparison,
      row_target(predicate$valueKey, specification)
    )
  }

  row_filter_code_lines <- function(model) {
    lines <- "  # Filter rows"
    filter_masks <- character()
    for (filter_index in seq_along(model$filters)) {
      filter <- model$filters[[filter_index]]
      variable <- sprintf(".ow_filter_column_%d", filter_index)
      null_mask <- sprintf(".ow_filter_null_%d", filter_index)
      nan_mask <- sprintf(".ow_filter_nan_%d", filter_index)
      lines <- c(lines, row_column_lines(filter, variable))
      if (identical(filter$semanticsKind, "double")) {
        lines <- c(
          lines,
          sprintf("  %s <- is.nan(%s)", nan_mask, variable),
          sprintf("  %s <- is.na(%s) & !%s", null_mask, variable, nan_mask)
        )
      } else {
        lines <- c(
          lines,
          sprintf("  %s <- is.na(%s)", null_mask, variable),
          sprintf("  %s <- rep(FALSE, length(%s))", nan_mask, variable)
        )
      }
      conditions <- character()
      value_filter <- filter$valueFilter
      if (!is.null(value_filter) && (
        length(value_filter$selectedKeys) > 0L ||
          isTRUE(value_filter$includeNulls) ||
          isTRUE(value_filter$includeNaN)
      )) {
        parts <- character()
        if (length(value_filter$selectedKeys) > 0L) {
          parts <- c(parts, sprintf(
            "((!%s & !%s) & %s %%in%% %s)",
            null_mask,
            nan_mask,
            row_comparable(variable, filter),
            row_targets(value_filter$selectedKeys, filter)
          ))
        }
        if (isTRUE(value_filter$includeNulls)) parts <- c(parts, null_mask)
        if (isTRUE(value_filter$includeNaN)) parts <- c(parts, nan_mask)
        conditions <- c(conditions, sprintf("(%s)", paste(parts, collapse = " | ")))
      }
      for (predicate in filter$predicates) {
        conditions <- c(
          conditions,
          row_predicate_expression(predicate, filter, variable, null_mask, nan_mask)
        )
      }
      if (length(conditions) > 0L) {
        mask <- sprintf(".ow_filter_mask_%d", filter_index)
        join <- if (identical(filter$logic, "or")) " | " else " & "
        lines <- c(lines, sprintf("  %s <- (%s)", mask, paste(conditions, collapse = join)))
        filter_masks <- c(filter_masks, mask)
      }
    }
    if (length(filter_masks) == 0L) {
      return(c(lines, "  .ow_rows <- seq_len(nrow(.ow_result))"))
    }
    join <- if (identical(model$logic, "or")) " | " else " & "
    c(
      lines,
      sprintf("  .ow_keep <- (%s)", paste(filter_masks, collapse = join)),
      "  .ow_rows <- which(.ow_keep)"
    )
  }

  row_sort_code_lines <- function(rules, initialize = TRUE) {
    lines <- if (isTRUE(initialize)) c("  # Sort rows", "  .ow_rows <- seq_len(nrow(.ow_result))") else "  # Sort filtered rows"
    for (rule_index in rev(seq_along(rules))) {
      rule <- rules[[rule_index]]
      lines <- c(
        lines,
        row_column_lines(rule, ".ow_sort_column"),
        "  .ow_sort_values <- .ow_sort_column[.ow_rows]",
        "  .ow_sort_missing <- is.na(.ow_sort_values)",
        "  .ow_sort_present <- which(!.ow_sort_missing)",
        sprintf(
          "  .ow_sort_levels <- sort(unique(.ow_sort_values[.ow_sort_present]), decreasing = %s, na.last = NA, method = \"radix\")",
          if (identical(rule$direction, "desc")) "TRUE" else "FALSE"
        ),
        "  .ow_sort_order <- base::order(match(.ow_sort_values[.ow_sort_present], .ow_sort_levels), method = \"radix\")",
        "  .ow_sorted_rows <- .ow_rows[.ow_sort_present[.ow_sort_order]]",
        sprintf(
          "  .ow_rows <- %s",
          if (identical(rule$nulls, "first")) {
            "c(.ow_rows[.ow_sort_missing], .ow_sorted_rows)"
          } else {
            "c(.ow_sorted_rows, .ow_rows[.ow_sort_missing])"
          }
        )
      )
    }
    lines
  }

  row_step_code_lines <- function(step) {
    if (identical(step$kind, "sortRows")) {
      lines <- row_sort_code_lines(step$rules)
      sorted <- TRUE
    } else {
      lines <- row_filter_code_lines(step$filterModel)
      sorted <- length(step$filterModel$sort) > 0L
      if (sorted) lines <- c(lines, row_sort_code_lines(step$filterModel$sort, initialize = FALSE))
    }
    specifications <- if (identical(step$kind, "sortRows")) {
      step$rules
    } else {
      c(step$filterModel$filters, step$filterModel$sort)
    }
    if (any(vapply(
      specifications,
      function(specification) identical(specification$semanticsKind, "integer64"),
      logical(1L),
      USE.NAMES = FALSE
    ))) {
      lines <- c(
        "  if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required for this row operation\", call. = FALSE)",
        lines
      )
    }
    c(
      lines,
      "  .ow_result <- if (inherits(.ow_result, \"data.table\")) .ow_result[.ow_rows] else .ow_result[.ow_rows, , drop = FALSE]",
      if (sorted) "  if (inherits(.ow_result, \"data.table\")) data.table::setkey(.ow_result, NULL)" else character()
    )
  }

  row_reduction_code_lines <- function(step) {
    positions <- vapply(step$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    names <- vapply(step$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
    position_code <- if (length(positions) == 0L) {
      "integer()"
    } else {
      sprintf("c(%s)", paste(sprintf("%dL", positions), collapse = ", "))
    }
    name_code <- r_character_vector(names)
    lines <- c(
      sprintf("  # %s", if (identical(step$kind, "dropMissingRows")) "Drop missing rows" else "Drop duplicates"),
      sprintf("  .ow_row_columns <- %s", position_code),
      sprintf("  .ow_row_column_names <- %s", name_code),
      "  if (any(.ow_row_columns > ncol(.ow_result)) || !identical(names(.ow_result)[.ow_row_columns], .ow_row_column_names)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)"
    )
    if (length(positions) == 0L) {
      return(c(lines, "  .ow_rows <- seq_len(nrow(.ow_result))"))
    }
    if (identical(step$kind, "dropMissingRows")) {
      reducer <- if (identical(step$mode, "all")) "`|`" else "`&`"
      lines <- c(
        lines,
        "  .ow_present <- lapply(.ow_row_columns, function(.ow_position) !is.na(.ow_result[[.ow_position]]))",
        sprintf("  .ow_keep <- Reduce(%s, .ow_present)", reducer),
        "  .ow_rows <- which(.ow_keep)"
      )
    } else {
      lines <- c(
        lines,
        "  .ow_compared <- if (inherits(.ow_result, \"data.table\")) .ow_result[, .ow_row_columns, with = FALSE] else .ow_result[.ow_row_columns]",
        sprintf(
          "  .ow_duplicate <- %s",
          if (identical(step$mode, "first")) {
            "duplicated(.ow_compared)"
          } else if (identical(step$mode, "last")) {
            "duplicated(.ow_compared, fromLast = TRUE)"
          } else {
            "duplicated(.ow_compared) | duplicated(.ow_compared, fromLast = TRUE)"
          }
        ),
        "  .ow_rows <- which(!.ow_duplicate)"
      )
    }
    c(
      lines,
      "  .ow_result <- if (inherits(.ow_result, \"data.table\")) .ow_result[.ow_rows] else .ow_result[.ow_rows, , drop = FALSE]"
    )
  }

  round_integer64_code_helper_lines <- function() {
    c(
      "  .ow_round_integer64 <- function(.ow_values, .ow_digits) {",
      "    if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required to round an integer64 column\", call. = FALSE)",
      "    if (.ow_digits >= 0) return(.ow_values)",
      "    .ow_places <- -.ow_digits",
      "    .ow_present <- !is.na(.ow_values)",
      "    if (!any(.ow_present)) return(.ow_values)",
      "    .ow_zero <- bit64::as.integer64(0L)",
      "    .ow_magnitude <- abs(.ow_values[.ow_present])",
      "    if (.ow_places > 19) {",
      "      .ow_rounded <- rep(.ow_zero, length(.ow_magnitude))",
      "    } else if (.ow_places == 19) {",
      "      .ow_half <- bit64::as.integer64(\"5000000000000000000\")",
      "      if (any(.ow_magnitude > .ow_half)) stop(\"Open Wrangler Round would produce a value outside the integer64 range\", call. = FALSE)",
      "      .ow_rounded <- rep(.ow_zero, length(.ow_magnitude))",
      "    } else {",
      "      .ow_unit <- bit64::as.integer64(paste0(\"1\", strrep(\"0\", as.integer(.ow_places))))",
      "      .ow_quotient <- .ow_magnitude %/% .ow_unit",
      "      .ow_remainder <- .ow_magnitude %% .ow_unit",
      "      .ow_half <- .ow_unit %/% bit64::as.integer64(2L)",
      "      .ow_round_up <- .ow_remainder > .ow_half | (.ow_remainder == .ow_half & .ow_quotient %% bit64::as.integer64(2L) == bit64::as.integer64(1L))",
      "      .ow_maximum_quotient <- bit64::as.integer64(\"9223372036854775807\") %/% .ow_unit",
      "      if (any(.ow_round_up & .ow_quotient >= .ow_maximum_quotient)) stop(\"Open Wrangler Round would produce a value outside the integer64 range\", call. = FALSE)",
      "      .ow_quotient[.ow_round_up] <- .ow_quotient[.ow_round_up] + bit64::as.integer64(1L)",
      "      .ow_rounded <- .ow_quotient * .ow_unit",
      "    }",
      "    .ow_rounded[.ow_values[.ow_present] < .ow_zero] <- -.ow_rounded[.ow_values[.ow_present] < .ow_zero]",
      "    if (anyNA(.ow_rounded)) stop(\"Open Wrangler Round would produce a value outside the integer64 range\", call. = FALSE)",
      "    .ow_result_values <- .ow_values",
      "    .ow_result_values[.ow_present] <- .ow_rounded",
      "    .ow_result_values",
      "  }"
    )
  }

  cast_code_helper_lines <- function() {
    c(
      "  .ow_cast_kind <- function(.ow_value) {",
      "    if (is.factor(.ow_value)) return(\"factor\")",
      "    if (inherits(.ow_value, \"integer64\")) return(\"integer64\")",
      "    if (inherits(.ow_value, \"POSIXct\")) return(\"POSIXct\")",
      "    if (inherits(.ow_value, \"Date\")) return(\"Date\")",
      "    if (inherits(.ow_value, \"difftime\")) return(\"difftime\")",
      "    if (is.logical(.ow_value)) return(\"logical\")",
      "    if (is.integer(.ow_value)) return(\"integer\")",
      "    if (is.double(.ow_value)) return(\"double\")",
      "    if (is.character(.ow_value)) return(\"character\")",
      "    stop(\"Open Wrangler Cast received an unsupported R column type\", call. = FALSE)",
      "  }",
      "  .ow_cast_raw_type <- function(.ow_value, .ow_kind) {",
      "    if (identical(.ow_kind, \"factor\") && is.ordered(.ow_value)) return(\"ordered factor\")",
      "    .ow_kind",
      "  }",
      "  .ow_cast_utf8 <- function(.ow_value) {",
      "    vapply(seq_along(.ow_value), function(.ow_index) {",
      "      .ow_text <- .ow_value[[.ow_index]]",
      "      if (is.na(.ow_text)) return(NA_character_)",
      "      if (identical(Encoding(.ow_text), \"bytes\")) stop(\"Open Wrangler Cast requires valid UTF-8 text\", call. = FALSE)",
      "      .ow_encoding <- Encoding(.ow_text)",
      "      .ow_from <- if (identical(.ow_encoding, \"latin1\")) \"latin1\" else \"UTF-8\"",
      "      .ow_utf8 <- iconv(.ow_text, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
      "      if (is.na(.ow_utf8) || nchar(.ow_utf8, type = \"bytes\") > 8192L) stop(\"Open Wrangler Cast requires bounded valid UTF-8 text\", call. = FALSE)",
      "      .ow_utf8",
      "    }, character(1L), USE.NAMES = FALSE)",
      "  }",
      "  .ow_cast_double_text <- function(.ow_value) {",
      "    vapply(seq_along(.ow_value), function(.ow_index) {",
      "      .ow_number <- .ow_value[[.ow_index]]",
      "      if (is.na(.ow_number) && !is.nan(.ow_number)) return(NA_character_)",
      "      sprintf(\"%.17g\", .ow_number)",
      "    }, character(1L), USE.NAMES = FALSE)",
      "  }",
      "  .ow_cast_canonical_dates <- function(.ow_value) {",
      "    .ow_result <- .ow_value",
      "    .ow_present <- !is.na(.ow_result)",
      "    if (!any(.ow_present)) return(.ow_result)",
      "    .ow_rendered <- format(.ow_result[.ow_present], format = \"%Y-%m-%d\")",
      "    .ow_canonical <- grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\", .ow_rendered) & !startsWith(.ow_rendered, \"0000-\")",
      "    if (any(.ow_canonical)) {",
      "      .ow_reparsed <- suppressWarnings(as.Date(.ow_rendered[.ow_canonical], format = \"%Y-%m-%d\"))",
      "      .ow_canonical[.ow_canonical] <- !is.na(.ow_reparsed) & .ow_reparsed == .ow_result[.ow_present][.ow_canonical]",
      "    }",
      "    .ow_result[which(.ow_present)[!.ow_canonical]] <- as.Date(NA_character_)",
      "    .ow_result",
      "  }",
      "  .ow_cast_canonical_datetimes <- function(.ow_value) {",
      "    .ow_result <- .ow_value",
      "    .ow_present <- !is.na(.ow_result)",
      "    if (!any(.ow_present)) return(.ow_result)",
      "    .ow_rendered <- format(.ow_result[.ow_present], tz = \"UTC\", format = \"%Y-%m-%dT%H:%M:%OS6\", usetz = FALSE)",
      "    .ow_canonical <- grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\\\.[0-9]{6}$\", .ow_rendered) & !startsWith(.ow_rendered, \"0000-\")",
      "    .ow_result[which(.ow_present)[!.ow_canonical]] <- as.POSIXct(NA_real_, origin = \"1970-01-01\", tz = \"UTC\")",
      "    .ow_result",
      "  }",
      "  .ow_cast_date_text <- function(.ow_value) {",
      "    .ow_output <- as.Date(rep(NA_character_, length(.ow_value)))",
      "    .ow_valid <- !is.na(.ow_value) & grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\", .ow_value)",
      "    .ow_output[.ow_valid] <- suppressWarnings(as.Date(.ow_value[.ow_valid], format = \"%Y-%m-%d\"))",
      "    .ow_cast_canonical_dates(.ow_output)",
      "  }",
      "  .ow_cast_datetime_text <- function(.ow_value) {",
      "    .ow_output <- as.POSIXct(rep(NA_real_, length(.ow_value)), origin = \"1970-01-01\", tz = \"UTC\")",
      "    .ow_date <- !is.na(.ow_value) & grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\", .ow_value)",
      "    .ow_datetime <- !is.na(.ow_value) & grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\\\.[0-9]{1,6})?Z?$\", .ow_value)",
      "    .ow_output[.ow_date] <- suppressWarnings(as.POSIXct(.ow_value[.ow_date], format = \"%Y-%m-%d\", tz = \"UTC\"))",
      "    .ow_normalized <- sub(\"Z$\", \"\", gsub(\" \", \"T\", .ow_value[.ow_datetime], fixed = TRUE))",
      "    .ow_parsed <- suppressWarnings(strptime(.ow_normalized, format = \"%Y-%m-%dT%H:%M:%OS\", tz = \"UTC\"))",
      "    .ow_output[.ow_datetime] <- as.POSIXct(.ow_parsed, tz = \"UTC\")",
      "    .ow_cast_canonical_datetimes(.ow_output)",
      "  }",
      "  .ow_cast_values <- function(.ow_value, .ow_target) {",
      "    .ow_kind <- .ow_cast_kind(.ow_value)",
      "    .ow_allowed <- switch(.ow_target,",
      "      string = c(\"logical\", \"integer\", \"integer64\", \"double\", \"character\", \"factor\", \"Date\", \"POSIXct\", \"difftime\"),",
      "      integer = c(\"logical\", \"integer\", \"integer64\", \"double\", \"character\", \"factor\"),",
      "      float = c(\"logical\", \"integer\", \"double\", \"character\", \"factor\"),",
      "      boolean = c(\"logical\", \"integer\", \"double\", \"character\", \"factor\"),",
      "      date = c(\"character\", \"factor\", \"Date\", \"POSIXct\"),",
      "      datetime = c(\"character\", \"factor\", \"Date\", \"POSIXct\"),",
      "      stop(\"Open Wrangler Cast received an unsupported target type\", call. = FALSE)",
      "    )",
      "    if (!.ow_kind %in% .ow_allowed) stop(sprintf(\"castColumn cannot convert an R %s column to %s\", .ow_cast_raw_type(.ow_value, .ow_kind), .ow_target), call. = FALSE)",
      "    .ow_text <- if (.ow_kind %in% c(\"character\", \"factor\")) .ow_cast_utf8(as.character(.ow_value)) else NULL",
      "    if (identical(.ow_target, \"string\")) {",
      "      if (.ow_kind %in% c(\"character\", \"factor\")) return(.ow_text)",
      "      if (.ow_kind %in% c(\"logical\", \"integer\", \"integer64\")) return(as.character(.ow_value))",
      "      if (identical(.ow_kind, \"double\")) return(.ow_cast_double_text(.ow_value))",
      "      if (identical(.ow_kind, \"Date\")) return(format(.ow_value, \"%Y-%m-%d\"))",
      "      if (identical(.ow_kind, \"POSIXct\")) return(format(.ow_value, \"%Y-%m-%dT%H:%M:%OS6Z\", tz = \"UTC\"))",
      "      .ow_duration <- as.double(.ow_value, units = attr(.ow_value, \"units\"))",
      "      .ow_number <- .ow_cast_double_text(.ow_duration)",
      "      .ow_number[is.nan(.ow_duration)] <- NA_character_",
      "      return(ifelse(is.na(.ow_number), NA_character_, paste(.ow_number, attr(.ow_value, \"units\"))))",
      "    }",
      "    if (identical(.ow_target, \"integer\")) {",
      "      if (identical(.ow_kind, \"integer64\")) return(.ow_value)",
      "      if (identical(.ow_kind, \"integer\")) return(.ow_value)",
      "      if (identical(.ow_kind, \"logical\")) return(as.integer(.ow_value))",
      "      if (.ow_kind %in% c(\"character\", \"factor\")) return(suppressWarnings(as.integer(trimws(.ow_text))))",
      "      return(suppressWarnings(as.integer(.ow_value)))",
      "    }",
      "    if (identical(.ow_target, \"float\")) {",
      "      if (.ow_kind %in% c(\"character\", \"factor\")) return(suppressWarnings(as.double(trimws(.ow_text))))",
      "      return(as.double(.ow_value))",
      "    }",
      "    if (identical(.ow_target, \"boolean\")) {",
      "      if (.ow_kind %in% c(\"character\", \"factor\")) return(suppressWarnings(as.logical(trimws(.ow_text))))",
      "      return(suppressWarnings(as.logical(.ow_value)))",
      "    }",
      "    if (identical(.ow_target, \"date\")) {",
      "      if (identical(.ow_kind, \"Date\")) return(.ow_cast_canonical_dates(.ow_value))",
      "      if (identical(.ow_kind, \"POSIXct\")) return(.ow_cast_canonical_dates(as.Date(.ow_value, tz = \"UTC\")))",
      "      return(.ow_cast_date_text(.ow_text))",
      "    }",
      "    if (identical(.ow_kind, \"POSIXct\")) return(.ow_cast_canonical_datetimes(structure(as.double(.ow_value), class = c(\"POSIXct\", \"POSIXt\"), tzone = \"UTC\")))",
      "    if (identical(.ow_kind, \"Date\")) return(.ow_cast_canonical_datetimes(as.POSIXct(.ow_cast_canonical_dates(.ow_value), tz = \"UTC\")))",
      "    .ow_cast_datetime_text(.ow_text)",
      "  }"
    )
  }

  r_fill_replacement <- function(replacement) {
    if (replacement$kind %in% c("fallbackColumns", "directional", "groupedStatistic", "linearInterpolation")) {
      abort("runtime_error", "Generated R code received a non-scalar replacement through the scalar fill path")
    }
    if (replacement$kind %in% c("mean", "median", "mostFrequent")) {
      return(sprintf("list(kind = %s)", r_string(replacement$kind)))
    }
    value <- if (identical(replacement$kind, "boolean")) {
      if (isTRUE(replacement$value)) "TRUE" else "FALSE"
    } else {
      r_string(replacement$value)
    }
    sprintf("list(kind = %s, value = %s)", r_string(replacement$kind), value)
  }

  fill_missing_code_helper_lines <- function() {
    c(
      "  .ow_fill_directional <- function(.ow_values, .ow_rows, .ow_direction, .ow_max_gap = NULL) {",
      "    if (!.ow_direction %in% c(\"forward\", \"backward\")) stop(\"Open Wrangler received an invalid directional fill\", call. = FALSE)",
      "    if (!is.null(.ow_max_gap) && (length(.ow_max_gap) != 1L || !is.numeric(.ow_max_gap) || is.na(.ow_max_gap) || !is.finite(.ow_max_gap) || .ow_max_gap < 1 || .ow_max_gap > 1000000 || .ow_max_gap != floor(.ow_max_gap))) stop(\"Open Wrangler received an invalid maximum gap\", call. = FALSE)",
      "    .ow_result_values <- .ow_values",
      "    .ow_missing <- is.na(.ow_values[.ow_rows])",
      "    if (length(.ow_missing) == 0L || !any(.ow_missing)) return(.ow_result_values)",
      "    .ow_runs <- rle(.ow_missing)",
      "    .ow_run_ends <- cumsum(.ow_runs$lengths)",
      "    .ow_run_starts <- .ow_run_ends - .ow_runs$lengths + 1L",
      "    for (.ow_run_index in which(.ow_runs$values)) {",
      "      .ow_run_length <- .ow_runs$lengths[[.ow_run_index]]",
      "      if (!is.null(.ow_max_gap) && .ow_run_length > .ow_max_gap) next",
      "      .ow_start <- .ow_run_starts[[.ow_run_index]]; .ow_end <- .ow_run_ends[[.ow_run_index]]",
      "      .ow_donor <- if (.ow_direction == \"forward\") .ow_start - 1L else .ow_end + 1L",
      "      if (.ow_donor < 1L || .ow_donor > length(.ow_rows)) next",
      "      .ow_donor_position <- .ow_rows[[.ow_donor]]",
      "      if (is.na(.ow_result_values[.ow_donor_position])) next",
      "      .ow_result_values[.ow_rows[.ow_start:.ow_end]] <- .ow_result_values[.ow_donor_position]",
      "    }",
      "    .ow_result_values",
      "  }",
      "  .ow_fill_linear <- function(.ow_values, .ow_coordinate, .ow_max_gap = NULL) {",
      "    if (!is.null(.ow_max_gap) && (length(.ow_max_gap) != 1L || !is.numeric(.ow_max_gap) || is.na(.ow_max_gap) || !is.finite(.ow_max_gap) || .ow_max_gap < 1 || .ow_max_gap > 1000000 || .ow_max_gap != floor(.ow_max_gap))) stop(\"Open Wrangler received an invalid maximum gap\", call. = FALSE)",
      "    .ow_coordinate_values <- as.double(.ow_coordinate)",
      "    if (anyNA(.ow_coordinate_values) || any(!is.finite(.ow_coordinate_values))) stop(\"Every interpolation coordinate must be present and finite\", call. = FALSE)",
      "    if (anyDuplicated(.ow_coordinate_values)) stop(\"Interpolation coordinates must be unique\", call. = FALSE)",
      "    .ow_rows <- order(.ow_coordinate_values, method = \"radix\")",
      "    .ow_result_values <- .ow_values",
      "    .ow_ordered_values <- .ow_result_values[.ow_rows]",
      "    .ow_missing <- is.na(.ow_ordered_values)",
      "    if (length(.ow_missing) == 0L || !any(.ow_missing)) return(.ow_result_values)",
      "    .ow_runs <- rle(.ow_missing)",
      "    .ow_run_ends <- cumsum(.ow_runs$lengths)",
      "    .ow_run_starts <- .ow_run_ends - .ow_runs$lengths + 1L",
      "    for (.ow_run_index in which(.ow_runs$values)) {",
      "      .ow_run_length <- .ow_runs$lengths[[.ow_run_index]]",
      "      if (!is.null(.ow_max_gap) && .ow_run_length > .ow_max_gap) next",
      "      .ow_start <- .ow_run_starts[[.ow_run_index]]; .ow_end <- .ow_run_ends[[.ow_run_index]]",
      "      .ow_left <- .ow_start - 1L; .ow_right <- .ow_end + 1L",
      "      if (.ow_left < 1L || .ow_right > length(.ow_rows)) next",
      "      .ow_left_value <- .ow_ordered_values[[.ow_left]]; .ow_right_value <- .ow_ordered_values[[.ow_right]]",
      "      if (!is.finite(.ow_left_value) || !is.finite(.ow_right_value)) next",
      "      .ow_left_coordinate <- .ow_coordinate_values[[.ow_rows[[.ow_left]]]]; .ow_right_coordinate <- .ow_coordinate_values[[.ow_rows[[.ow_right]]]]",
      "      .ow_coordinate_width <- .ow_right_coordinate - .ow_left_coordinate",
      "      .ow_scaled <- !is.finite(.ow_coordinate_width)",
      "      if (.ow_scaled) { .ow_coordinate_scale <- max(abs(.ow_left_coordinate), abs(.ow_right_coordinate)); .ow_scaled_left <- .ow_left_coordinate / .ow_coordinate_scale; .ow_coordinate_width <- .ow_right_coordinate / .ow_coordinate_scale - .ow_scaled_left }",
      "      if (!is.finite(.ow_coordinate_width) || .ow_coordinate_width <= 0) stop(\"Interpolation coordinates cannot be represented safely\", call. = FALSE)",
      "      for (.ow_index in .ow_start:.ow_end) {",
      "        .ow_coordinate_value <- .ow_coordinate_values[[.ow_rows[[.ow_index]]]]",
      "        .ow_weight <- if (.ow_scaled) (.ow_coordinate_value / .ow_coordinate_scale - .ow_scaled_left) / .ow_coordinate_width else (.ow_coordinate_value - .ow_left_coordinate) / .ow_coordinate_width",
      "        if (!is.finite(.ow_weight) || .ow_weight <= 0 || .ow_weight >= 1) stop(\"Interpolation coordinates cannot be represented safely\", call. = FALSE)",
      "        .ow_interpolated <- if (sign(.ow_left_value) == sign(.ow_right_value)) .ow_left_value + (.ow_right_value - .ow_left_value) * .ow_weight else .ow_left_value * (1 - .ow_weight) + .ow_right_value * .ow_weight",
      "        if (!is.finite(.ow_interpolated)) stop(\"Linear interpolation produced a non-finite value\", call. = FALSE)",
      "        .ow_result_values[[.ow_rows[[.ow_index]]]] <- .ow_interpolated",
      "      }",
      "    }",
      "    .ow_result_values",
      "  }",
      "  .ow_fill_grouped <- function(.ow_values, .ow_rows, .ow_keys, .ow_semantic_kind, .ow_statistic) {",
      "    if (!.ow_statistic %in% c(\"mean\", \"median\", \"mostFrequent\")) stop(\"Open Wrangler received an invalid grouped statistic\", call. = FALSE)",
      "    .ow_result_values <- .ow_values",
      "    .ow_count <- length(.ow_rows)",
      "    if (.ow_count == 0L || !anyNA(.ow_result_values)) return(.ow_result_values)",
      "    .ow_same_group <- rep(TRUE, max(0L, .ow_count - 1L))",
      "    if (.ow_count > 1L) {",
      "      .ow_left_rows <- .ow_rows[-.ow_count]; .ow_right_rows <- .ow_rows[-1L]",
      "      for (.ow_key in .ow_keys) {",
      "        .ow_left <- .ow_key[.ow_left_rows]; .ow_right <- .ow_key[.ow_right_rows]",
      "        .ow_left_missing <- is.na(.ow_left); .ow_right_missing <- is.na(.ow_right)",
      "        .ow_equal <- (.ow_left_missing & .ow_right_missing) | (!.ow_left_missing & !.ow_right_missing & .ow_left == .ow_right)",
      "        .ow_equal[is.na(.ow_equal)] <- FALSE",
      "        .ow_same_group <- .ow_same_group & .ow_equal",
      "      }",
      "    }",
      "    .ow_starts <- c(1L, which(!.ow_same_group) + 1L); .ow_ends <- c(.ow_starts[-1L] - 1L, .ow_count)",
      "    for (.ow_group_index in seq_along(.ow_starts)) {",
      "      .ow_group_rows <- .ow_rows[.ow_starts[[.ow_group_index]]:.ow_ends[[.ow_group_index]]]",
      "      .ow_missing_rows <- .ow_group_rows[is.na(.ow_result_values[.ow_group_rows])]",
      "      if (length(.ow_missing_rows) == 0L) next",
      "      .ow_present <- .ow_result_values[.ow_group_rows[!is.na(.ow_result_values[.ow_group_rows])]]",
      "      if (length(.ow_present) == 0L) next",
      "      .ow_fill <- NULL",
      "      if (.ow_statistic == \"mean\") {",
      "        .ow_positive_infinity <- any(is.infinite(.ow_present) & .ow_present > 0); .ow_negative_infinity <- any(is.infinite(.ow_present) & .ow_present < 0)",
      "        if (.ow_positive_infinity && .ow_negative_infinity) next",
      "        if (.ow_positive_infinity) { .ow_fill <- Inf } else if (.ow_negative_infinity) { .ow_fill <- -Inf } else {",
      "          .ow_scale <- max(abs(.ow_present)); .ow_fill <- if (.ow_scale == 0) 0 else max(-1, min(1, mean(.ow_present / .ow_scale))) * .ow_scale",
      "        }",
      "      } else if (.ow_statistic == \"median\") {",
      "        .ow_ordered <- sort(.ow_present); .ow_present_count <- length(.ow_ordered)",
      "        .ow_lower <- .ow_ordered[[(.ow_present_count + 1L) %/% 2L]]; .ow_upper <- .ow_ordered[[(.ow_present_count + 2L) %/% 2L]]",
      "        if (.ow_semantic_kind == \"integer64\") {",
      "          if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required for a grouped integer64 median\", call. = FALSE)",
      "          if (.ow_present_count %% 2L == 1L) { .ow_fill <- .ow_lower } else {",
      "            .ow_zero <- bit64::as.integer64(0L); .ow_two <- bit64::as.integer64(2L)",
      "            if ((.ow_lower < .ow_zero && .ow_upper < .ow_zero) || (.ow_lower >= .ow_zero && .ow_upper >= .ow_zero)) {",
      "              .ow_difference <- .ow_upper - .ow_lower",
      "              if (as.character(.ow_difference %% .ow_two) != \"0\") stop(\"Open Wrangler grouped integer64 median is not an integer\", call. = FALSE)",
      "              .ow_fill <- .ow_lower + .ow_difference %/% .ow_two",
      "            } else {",
      "              .ow_total <- .ow_lower + .ow_upper",
      "              if (as.character(.ow_total %% .ow_two) != \"0\") stop(\"Open Wrangler grouped integer64 median is not an integer\", call. = FALSE)",
      "              .ow_fill <- .ow_total %/% .ow_two",
      "            }",
      "            if (is.na(.ow_fill)) stop(\"Open Wrangler grouped integer64 median is outside the supported range\", call. = FALSE)",
      "          }",
      "        } else {",
      "          .ow_fill <- if (.ow_present_count %% 2L == 1L) {",
      "            .ow_lower",
      "          } else if (.ow_semantic_kind == \"double\") {",
      "            if (.ow_lower == .ow_upper) .ow_lower else if (is.finite(.ow_lower) && is.finite(.ow_upper)) {",
      "              if ((.ow_lower < 0) == (.ow_upper < 0)) .ow_lower + ((.ow_upper - .ow_lower) / 2) else (.ow_lower / 2) + (.ow_upper / 2)",
      "            } else {",
      "              (.ow_lower + .ow_upper) / 2",
      "            }",
      "          } else {",
      "            .ow_lower / 2 + .ow_upper / 2",
      "          }",
      "          if (is.nan(.ow_fill)) next",
      "          if (.ow_semantic_kind == \"integer\") {",
      "            if (!is.finite(.ow_fill) || .ow_fill != floor(.ow_fill)) stop(\"Open Wrangler grouped integer median is not an integer\", call. = FALSE)",
      "            .ow_fill <- as.integer(.ow_fill)",
      "            if (is.na(.ow_fill)) stop(\"Open Wrangler grouped integer median is outside the R integer range\", call. = FALSE)",
      "          }",
      "        }",
      "      } else {",
      "        .ow_candidates <- unique(.ow_present); .ow_counts <- tabulate(match(.ow_present, .ow_candidates), nbins = length(.ow_candidates))",
      "        .ow_winners <- which(.ow_counts == max(.ow_counts))",
      "        if (length(.ow_winners) != 1L) next",
      "        .ow_fill <- .ow_candidates[[.ow_winners[[1L]]]]",
      "      }",
      "      .ow_result_values[.ow_missing_rows] <- .ow_fill",
      "    }",
      "    .ow_result_values",
      "  }",
      "  .ow_fill_datetime <- function(.ow_text, .ow_timezone) {",
      "    .ow_match <- regexec(\"^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\\\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$\", .ow_text, perl = TRUE)",
      "    .ow_parts <- regmatches(.ow_text, .ow_match)[[1L]]",
      "    if (length(.ow_parts) == 0L || substring(.ow_parts[[2L]], 1L, 4L) == \"0000\") stop(\"Open Wrangler expected a valid ISO datetime\", call. = FALSE)",
      "    .ow_hours <- as.integer(.ow_parts[[3L]]); .ow_minutes <- as.integer(.ow_parts[[4L]])",
      "    .ow_seconds <- if (.ow_parts[[5L]] == \"\") 0L else as.integer(.ow_parts[[5L]])",
      "    .ow_zone <- .ow_parts[[7L]]",
      "    if (.ow_hours > 23L || .ow_minutes > 59L || .ow_seconds > 59L) stop(\"Open Wrangler expected a valid ISO datetime\", call. = FALSE)",
      "    .ow_has_zone <- .ow_zone != \"\"",
      "    if (.ow_has_zone && .ow_zone != \"Z\") {",
      "      .ow_zone_digits <- gsub(\":\", \"\", substring(.ow_zone, 2L), fixed = TRUE)",
      "      if (as.integer(substring(.ow_zone_digits, 1L, 2L)) > 23L || as.integer(substring(.ow_zone_digits, 3L, 4L)) > 59L) stop(\"Open Wrangler expected a valid ISO datetime\", call. = FALSE)",
      "    }",
      "    .ow_parse_timezone <- if (.ow_has_zone) \"UTC\" else .ow_timezone",
      "    if (is.null(.ow_parse_timezone) || .ow_parse_timezone == \"\") .ow_parse_timezone <- \"UTC\"",
      "    .ow_fraction <- .ow_parts[[6L]]",
      "    .ow_normalized_zone <- if (!.ow_has_zone) \"\" else if (.ow_zone == \"Z\") \"+0000\" else gsub(\":\", \"\", .ow_zone, fixed = TRUE)",
      "    .ow_normalized <- sprintf(\"%sT%02d:%02d:%02d%s%s\", .ow_parts[[2L]], .ow_hours, .ow_minutes, .ow_seconds, .ow_fraction, .ow_normalized_zone)",
      "    .ow_format <- if (.ow_has_zone) \"%Y-%m-%dT%H:%M:%OS%z\" else \"%Y-%m-%dT%H:%M:%OS\"",
      "    .ow_parsed <- suppressWarnings(as.POSIXct(strptime(.ow_normalized, format = .ow_format, tz = .ow_parse_timezone)))",
      "    if (length(.ow_parsed) != 1L || is.na(.ow_parsed)) stop(\"Open Wrangler expected a valid ISO datetime\", call. = FALSE)",
      "    if (!.ow_has_zone) {",
      "      .ow_local <- as.POSIXlt(.ow_parsed, tz = .ow_parse_timezone)",
      "      .ow_expected_date <- as.integer(strsplit(.ow_parts[[2L]], \"-\", fixed = TRUE)[[1L]])",
      "      .ow_expected_seconds <- .ow_seconds + if (.ow_fraction == \"\") 0 else as.double(.ow_fraction)",
      "      if (.ow_local$year + 1900L != .ow_expected_date[[1L]] || .ow_local$mon + 1L != .ow_expected_date[[2L]] || .ow_local$mday != .ow_expected_date[[3L]] || .ow_local$hour != .ow_hours || .ow_local$min != .ow_minutes || abs(.ow_local$sec - .ow_expected_seconds) > 1e-6) stop(sprintf(\"Open Wrangler received an invalid local datetime in %s\", .ow_parse_timezone), call. = FALSE)",
      "    }",
      "    as.double(.ow_parsed)",
      "  }",
      "  .ow_fill_values <- function(.ow_values, .ow_semantic_kind, .ow_replacement, .ow_timezone) {",
      "    .ow_missing <- is.na(.ow_values)",
      "    .ow_replacement_kind <- .ow_replacement$kind",
      "    if (.ow_replacement_kind == \"mean\") {",
      "      if (!any(.ow_missing)) return(.ow_values)",
      "      .ow_present <- .ow_values[!.ow_missing]",
      "      if (length(.ow_present) == 0L) stop(\"Open Wrangler cannot calculate a mean without present values\", call. = FALSE)",
      "      .ow_positive_infinity <- any(is.infinite(.ow_present) & .ow_present > 0)",
      "      .ow_negative_infinity <- any(is.infinite(.ow_present) & .ow_present < 0)",
      "      if (.ow_positive_infinity && .ow_negative_infinity) stop(\"Open Wrangler could not calculate a usable numeric mean\", call. = FALSE)",
      "      if (.ow_positive_infinity) {",
      "        .ow_fill <- Inf",
      "      } else if (.ow_negative_infinity) {",
      "        .ow_fill <- -Inf",
      "      } else {",
      "        .ow_scale <- max(abs(.ow_present))",
      "        .ow_fill <- if (.ow_scale == 0) 0 else max(-1, min(1, mean(.ow_present / .ow_scale))) * .ow_scale",
      "      }",
      "    } else if (.ow_replacement_kind == \"median\") {",
      "      if (!any(.ow_missing)) return(.ow_values)",
      "      .ow_present <- .ow_values[!.ow_missing]",
      "      if (length(.ow_present) == 0L) stop(\"Open Wrangler cannot calculate a median without present values\", call. = FALSE)",
      "      if (.ow_semantic_kind == \"integer64\") {",
      "        if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required to fill an integer64 column\", call. = FALSE)",
      "        .ow_ordered <- sort(.ow_present); .ow_count <- length(.ow_ordered)",
      "        .ow_lower <- .ow_ordered[[(.ow_count + 1L) %/% 2L]]; .ow_upper <- .ow_ordered[[(.ow_count + 2L) %/% 2L]]",
      "        if (.ow_count %% 2L == 1L) { .ow_fill <- .ow_lower } else {",
      "          .ow_zero <- bit64::as.integer64(0L); .ow_two <- bit64::as.integer64(2L)",
      "          if ((.ow_lower < .ow_zero && .ow_upper < .ow_zero) || (.ow_lower >= .ow_zero && .ow_upper >= .ow_zero)) {",
      "            .ow_difference <- .ow_upper - .ow_lower",
      "            if (as.character(.ow_difference %% .ow_two) != \"0\") stop(\"Open Wrangler integer64 median is not an integer\", call. = FALSE)",
      "            .ow_fill <- .ow_lower + .ow_difference %/% .ow_two",
      "          } else {",
      "            .ow_total <- .ow_lower + .ow_upper",
      "            if (as.character(.ow_total %% .ow_two) != \"0\") stop(\"Open Wrangler integer64 median is not an integer\", call. = FALSE)",
      "            .ow_fill <- .ow_total %/% .ow_two",
      "          }",
      "          if (is.na(.ow_fill)) stop(\"Open Wrangler integer64 median is outside the supported range\", call. = FALSE)",
      "        }",
      "      } else {",
      "        .ow_ordered <- sort(.ow_present); .ow_count <- length(.ow_ordered)",
      "        .ow_lower <- .ow_ordered[[(.ow_count + 1L) %/% 2L]]; .ow_upper <- .ow_ordered[[(.ow_count + 2L) %/% 2L]]",
      "        .ow_fill <- .ow_lower / 2 + .ow_upper / 2",
      "        if (is.nan(.ow_fill)) stop(\"Open Wrangler could not calculate a usable numeric median\", call. = FALSE)",
      "        if (.ow_semantic_kind == \"integer\") {",
      "          if (!is.finite(.ow_fill) || .ow_fill != floor(.ow_fill)) stop(\"Open Wrangler integer median is not an integer\", call. = FALSE)",
      "          .ow_fill <- as.integer(.ow_fill)",
      "          if (is.na(.ow_fill)) stop(\"Open Wrangler integer median is outside the R integer range\", call. = FALSE)",
      "        }",
      "      }",
      "    } else if (.ow_replacement_kind == \"mostFrequent\") {",
      "      if (!any(.ow_missing)) return(.ow_values)",
      "      .ow_present <- .ow_values[!.ow_missing]",
      "      if (length(.ow_present) == 0L) stop(\"This column has no non-missing values. Choose a specific value.\", call. = FALSE)",
      "      .ow_candidates <- unique(.ow_present)",
      "      .ow_counts <- tabulate(match(.ow_present, .ow_candidates), nbins = length(.ow_candidates))",
      "      .ow_winners <- which(.ow_counts == max(.ow_counts))",
      "      if (length(.ow_winners) != 1L) stop(sprintf(\"This column has no single most common value: %d values are tied. Choose a specific value.\", length(.ow_winners)), call. = FALSE)",
      "      .ow_fill <- .ow_candidates[[.ow_winners[[1L]]]]",
      "    } else if (.ow_semantic_kind %in% c(\"character\", \"factor\")) {",
      "      .ow_fill <- .ow_replacement$value",
      "      if (!is.character(.ow_fill) || length(.ow_fill) != 1L || is.na(.ow_fill) || Encoding(.ow_fill) == \"bytes\") stop(\"Open Wrangler expected valid replacement text\", call. = FALSE)",
      "      .ow_from <- if (Encoding(.ow_fill) == \"latin1\") \"latin1\" else \"UTF-8\"",
      "      .ow_fill <- iconv(.ow_fill, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
      "      if (is.na(.ow_fill) || nchar(.ow_fill, type = \"bytes\") > 8192L) stop(\"Open Wrangler replacement text is invalid or too large\", call. = FALSE)",
      "      if (.ow_semantic_kind == \"factor\") {",
      "        if (!any(.ow_missing)) return(.ow_values)",
      "        .ow_levels <- levels(.ow_values); if (!.ow_fill %in% .ow_levels) .ow_levels <- c(.ow_levels, .ow_fill)",
      "        .ow_values <- factor(as.character(.ow_values), levels = .ow_levels, ordered = is.ordered(.ow_values))",
      "      }",
      "    } else if (.ow_semantic_kind == \"integer\") {",
      "      .ow_number <- suppressWarnings(as.double(.ow_replacement$value))",
      "      if (!is.finite(.ow_number) || .ow_number != floor(.ow_number) || .ow_number < -2147483647 || .ow_number > 2147483647) stop(\"Open Wrangler replacement is outside the R integer range\", call. = FALSE)",
      "      .ow_fill <- as.integer(.ow_number)",
      "    } else if (.ow_semantic_kind == \"integer64\") {",
      "      if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required to fill an integer64 column\", call. = FALSE)",
      "      .ow_fill <- suppressWarnings(bit64::as.integer64(.ow_replacement$value))",
      "      if (is.na(.ow_fill)) stop(\"Open Wrangler replacement is outside the integer64 range\", call. = FALSE)",
      "    } else if (.ow_semantic_kind == \"double\") {",
      "      .ow_fill <- suppressWarnings(as.double(.ow_replacement$value))",
      "      if (!is.finite(.ow_fill)) stop(\"Open Wrangler expected a finite numeric replacement\", call. = FALSE)",
      "    } else if (.ow_semantic_kind == \"logical\") {",
      "      .ow_fill <- .ow_replacement$value",
      "      if (!is.logical(.ow_fill) || length(.ow_fill) != 1L || is.na(.ow_fill)) stop(\"Open Wrangler expected a boolean replacement\", call. = FALSE)",
      "    } else if (.ow_semantic_kind == \"date\") {",
      "      .ow_text <- .ow_replacement$value",
      "      if (!grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\", .ow_text, perl = TRUE) || startsWith(.ow_text, \"0000-\")) stop(\"Open Wrangler expected a valid date\", call. = FALSE)",
      "      .ow_fill <- suppressWarnings(as.Date(.ow_text, format = \"%Y-%m-%d\"))",
      "      if (is.na(.ow_fill)) stop(\"Open Wrangler expected a valid date\", call. = FALSE)",
      "    } else if (.ow_semantic_kind == \"datetime\") {",
      "      .ow_fill <- .ow_fill_datetime(.ow_replacement$value, .ow_timezone)",
      "    } else stop(\"Open Wrangler cannot fill this R column type\", call. = FALSE)",
      "    .ow_values[.ow_missing] <- .ow_fill",
      "    .ow_values",
      "  }",
      "  .ow_fill_from_columns <- function(.ow_values, .ow_semantic_kind, .ow_fallbacks, .ow_fallback_kinds, .ow_factor_limit) {",
      "    if (!is.list(.ow_fallbacks) || length(.ow_fallbacks) == 0L || length(.ow_fallbacks) != length(.ow_fallback_kinds)) stop(\"Open Wrangler received invalid fallback columns\", call. = FALSE)",
      "    if (.ow_semantic_kind == \"factor\") {",
      "      .ow_text <- as.character(.ow_values)",
      "      .ow_levels <- levels(.ow_values)",
      "      for (.ow_index in seq_along(.ow_fallbacks)) {",
      "        .ow_fallback_text <- as.character(.ow_fallbacks[[.ow_index]])",
      "        .ow_use <- is.na(.ow_text) & !is.na(.ow_fallback_text)",
      "        if (!any(.ow_use)) next",
      "        .ow_additions <- unique(.ow_fallback_text[.ow_use])",
      "        .ow_additions <- .ow_additions[!.ow_additions %in% .ow_levels]",
      "        if (length(.ow_levels) + length(.ow_additions) > .ow_factor_limit) stop(\"Open Wrangler factor level limit reached\", call. = FALSE)",
      "        .ow_levels <- c(.ow_levels, .ow_additions)",
      "        .ow_text[.ow_use] <- .ow_fallback_text[.ow_use]",
      "      }",
      "      return(factor(.ow_text, levels = .ow_levels, ordered = is.ordered(.ow_values)))",
      "    }",
      "    .ow_result_values <- .ow_values",
      "    for (.ow_index in seq_along(.ow_fallbacks)) {",
      "      .ow_fallback <- .ow_fallbacks[[.ow_index]]",
      "      .ow_fallback_kind <- .ow_fallback_kinds[[.ow_index]]",
      "      .ow_use <- is.na(.ow_result_values) & !is.na(.ow_fallback)",
      "      if (!any(.ow_use)) next",
      "      .ow_converted <- if (.ow_semantic_kind == \"character\") {",
      "        as.character(.ow_fallback[.ow_use])",
      "      } else if (.ow_semantic_kind == \"integer\" && .ow_fallback_kind == \"integer64\") {",
      "        if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required to fill an integer column from integer64\", call. = FALSE)",
      "        .ow_selected <- .ow_fallback[.ow_use]",
      "        .ow_minimum <- bit64::as.integer64(\"-2147483647\"); .ow_maximum <- bit64::as.integer64(\"2147483647\")",
      "        if (any(.ow_selected < .ow_minimum | .ow_selected > .ow_maximum)) stop(\"Open Wrangler fallback value is outside the R integer range\", call. = FALSE)",
      "        as.integer(as.character(.ow_selected))",
      "      } else if (.ow_semantic_kind == \"integer64\" && .ow_fallback_kind == \"integer\") {",
      "        if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required to fill an integer64 column\", call. = FALSE)",
      "        bit64::as.integer64(.ow_fallback[.ow_use])",
      "      } else {",
      "        .ow_fallback[.ow_use]",
      "      }",
      "      .ow_result_values[.ow_use] <- .ow_converted",
      "    }",
      "    .ow_result_values",
      "  }"
    )
  }

  compile_plan <- function(variable_name, bound_plan, maximum_columns, maximum_factor_levels) {
    if (length(bound_plan) == 0L) return("")
    lines <- c(
      "open_wrangler_result <- local({",
      sprintf(
        "  .ow_source <- get(%s, envir = parent.env(environment()), inherits = FALSE)",
        r_string(variable_name)
      ),
      "  if (!is.data.frame(.ow_source)) stop(\"Open Wrangler expected an R dataframe\", call. = FALSE)",
      "  .ow_result <- if (inherits(.ow_source, \"data.table\")) {",
      "    if (!requireNamespace(\"data.table\", quietly = TRUE)) stop(\"data.table is required\", call. = FALSE)",
      "    data.table::copy(.ow_source)",
      "  } else {",
      "    unserialize(serialize(.ow_source, NULL, version = 3L))",
      "  }"
    )
    if (any(vapply(bound_plan, function(step) identical(step$kind, "castColumn"), logical(1L)))) {
      lines <- c(lines, cast_code_helper_lines())
    }
    if (any(vapply(bound_plan, function(step) identical(step$kind, "fillMissingValues"), logical(1L)))) {
      lines <- c(lines, fill_missing_code_helper_lines())
    }
    if (any(vapply(
      bound_plan,
      function(step) identical(step$kind, "roundNumber") && identical(step$semanticKind, "integer64"),
      logical(1L)
    ))) {
      lines <- c(lines, round_integer64_code_helper_lines())
    }
    for (step in bound_plan) {
      if (identical(step$kind, "sortRows")) {
        lines <- c(lines, row_step_code_lines(step))
      } else if (identical(step$kind, "filterRows")) {
        lines <- c(lines, row_step_code_lines(step))
      } else if (step$kind %in% c("dropMissingRows", "dropDuplicates")) {
        lines <- c(lines, row_reduction_code_lines(step))
      } else if (identical(step$kind, "renameColumn")) {
        lines <- c(
          lines,
          sprintf(
            "  if (ncol(.ow_result) < %dL || !identical(names(.ow_result)[[%dL]], %s)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
            step$position,
            step$position,
            r_string(step$oldName)
          ),
          sprintf(
            "  if (any(names(.ow_result)[-%dL] == %s)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
            step$position,
            r_string(step$newName)
          ),
          sprintf(
            "  if (inherits(.ow_result, \"data.table\")) data.table::setnames(.ow_result, old = %dL, new = %s) else names(.ow_result)[[%dL]] <- %s",
            step$position,
            r_string(step$newName),
            step$position,
            r_string(step$newName)
          )
        )
      } else if (identical(step$kind, "cloneColumn")) {
        lines <- c(
          lines,
          sprintf("  .ow_clone_position <- %dL", step$position),
          sprintf("  .ow_clone_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_clone_name <- %s", r_string(step$newName)),
          "  if (ncol(.ow_result) < .ow_clone_position || !identical(names(.ow_result)[[.ow_clone_position]], .ow_clone_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (.ow_clone_name == \"\" || any(names(.ow_result) == .ow_clone_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
          sprintf(
            "  if (ncol(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
            maximum_columns
          ),
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    data.table::set(.ow_result, j = .ow_clone_name, value = .ow_result[[.ow_clone_position]])",
          "  } else {",
          "    .ow_clone_existing_names <- names(.ow_result)",
          "    .ow_result[[ncol(.ow_result) + 1L]] <- .ow_result[[.ow_clone_position]]",
          "    names(.ow_result) <- c(.ow_clone_existing_names, .ow_clone_name)",
          "  }"
        )
      } else if (identical(step$kind, "textLength")) {
        lines <- c(
          lines,
          sprintf("  .ow_text_length_position <- %dL", step$position),
          sprintf("  .ow_text_length_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_text_length_name <- %s", r_string(step$newName)),
          "  if (ncol(.ow_result) < .ow_text_length_position || !identical(names(.ow_result)[[.ow_text_length_position]], .ow_text_length_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (!is.character(.ow_result[[.ow_text_length_position]]) && !is.factor(.ow_result[[.ow_text_length_position]])) stop(\"Open Wrangler Text Length requires a character or factor column\", call. = FALSE)",
          "  if (.ow_text_length_name == \"\" || any(names(.ow_result) == .ow_text_length_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
          sprintf(
            "  if (ncol(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
            maximum_columns
          ),
          "  .ow_text_lengths <- nchar(as.character(.ow_result[[.ow_text_length_position]]), type = \"chars\", allowNA = FALSE, keepNA = TRUE)",
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    data.table::set(.ow_result, j = .ow_text_length_name, value = .ow_text_lengths)",
          "  } else {",
          "    .ow_text_length_existing_names <- names(.ow_result)",
          "    .ow_result[[ncol(.ow_result) + 1L]] <- .ow_text_lengths",
          "    names(.ow_result) <- c(.ow_text_length_existing_names, .ow_text_length_name)",
          "  }"
        )
      } else if (step$kind %in% c(
        "lowerText",
        "upperText",
        "capitalizeText",
        "stripText",
        "splitText",
        "findReplace"
      )) {
        operation_name <- switch(
          step$kind,
          lowerText = "Lowercase",
          upperText = "Uppercase",
          capitalizeText = "Capitalize",
          stripText = "Strip text",
          splitText = "Split text",
          findReplace = "Find and Replace"
        )
        lines <- c(
          lines,
          sprintf("  .ow_text_position <- %dL", step$position),
          sprintf("  .ow_text_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_text_name <- %s", r_string(step$newName)),
          "  if (ncol(.ow_result) < .ow_text_position || !identical(names(.ow_result)[[.ow_text_position]], .ow_text_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          sprintf(
            "  if (!is.character(.ow_result[[.ow_text_position]]) && !is.factor(.ow_result[[.ow_text_position]])) stop(\"Open Wrangler %s requires a character or factor column\", call. = FALSE)",
            operation_name
          ),
          "  .ow_text_source <- as.character(.ow_result[[.ow_text_position]])"
        )
        if (identical(step$kind, "findReplace")) {
          lines <- c(
            lines,
            sprintf("  .ow_text_find <- %s", r_string(step$find)),
            sprintf("  .ow_text_replacement <- %s", r_string(step$replacement)),
            sprintf("  .ow_text_regex <- %s", if (isTRUE(step$regex)) "TRUE" else "FALSE")
          )
          if (isTRUE(step$regex)) {
            lines <- c(
              lines,
              "  .ow_replacement_characters <- strsplit(.ow_text_replacement, \"\", fixed = TRUE)[[1L]]",
              "  .ow_plain_literal_bytes <- 0",
              "  .ow_case_literal_bytes <- 0",
              "  .ow_plain_references <- integer(9L)",
              "  .ow_case_references <- integer(9L)",
              "  .ow_case_conversion <- FALSE",
              "  .ow_add_literal <- function(.ow_character) {",
              "    .ow_bytes <- as.double(nchar(.ow_character, type = \"bytes\"))",
              "    if (.ow_case_conversion) .ow_case_literal_bytes <<- .ow_case_literal_bytes + .ow_bytes else .ow_plain_literal_bytes <<- .ow_plain_literal_bytes + .ow_bytes",
              "  }",
              "  .ow_replacement_index <- 1L",
              "  while (.ow_replacement_index <= length(.ow_replacement_characters)) {",
              "    .ow_character <- .ow_replacement_characters[[.ow_replacement_index]]",
              "    if (!identical(.ow_character, \"\\\\\")) {",
              "      .ow_add_literal(.ow_character)",
              "      .ow_replacement_index <- .ow_replacement_index + 1L",
              "      next",
              "    }",
              "    if (.ow_replacement_index == length(.ow_replacement_characters)) {",
              "      .ow_add_literal(\"\\\\\")",
              "      break",
              "    }",
              "    .ow_escaped <- .ow_replacement_characters[[.ow_replacement_index + 1L]]",
              "    if (identical(.ow_escaped, \"\\\\\")) {",
              "      .ow_add_literal(\"\\\\\")",
              "    } else if (.ow_escaped %in% as.character(seq_len(9L))) {",
              "      .ow_reference <- as.integer(.ow_escaped)",
              "      if (.ow_case_conversion) .ow_case_references[[.ow_reference]] <- .ow_case_references[[.ow_reference]] + 1L else .ow_plain_references[[.ow_reference]] <- .ow_plain_references[[.ow_reference]] + 1L",
              "    } else if (.ow_escaped %in% c(\"U\", \"L\")) {",
              "      .ow_case_conversion <- TRUE",
              "    } else if (identical(.ow_escaped, \"E\")) {",
              "      .ow_case_conversion <- FALSE",
              "    } else {",
              "      .ow_add_literal(\"\\\\\")",
              "      .ow_add_literal(.ow_escaped)",
              "    }",
              "    .ow_replacement_index <- .ow_replacement_index + 2L",
              "  }",
              "  .ow_capture_bytes <- function(.ow_match_vector, .ow_capture_index, .ow_byte_prefix) {",
              "    .ow_capture_starts <- attr(.ow_match_vector, \"capture.start\", exact = TRUE)",
              "    .ow_capture_lengths <- attr(.ow_match_vector, \"capture.length\", exact = TRUE)",
              "    if (is.null(.ow_capture_starts) || is.null(.ow_capture_lengths) || !is.matrix(.ow_capture_starts) || !is.matrix(.ow_capture_lengths) || ncol(.ow_capture_starts) < .ow_capture_index || ncol(.ow_capture_lengths) < .ow_capture_index) return(0)",
              "    .ow_starts <- .ow_capture_starts[, .ow_capture_index]",
              "    .ow_lengths <- .ow_capture_lengths[, .ow_capture_index]",
              "    if (isTRUE(attr(.ow_match_vector, \"useBytes\", exact = TRUE))) return(sum(as.double(.ow_lengths[.ow_starts >= 0L & .ow_lengths > 0L])))",
              "    sum(vapply(seq_along(.ow_starts), function(.ow_capture_ordinal) {",
              "      .ow_start <- .ow_starts[[.ow_capture_ordinal]]",
              "      .ow_length <- .ow_lengths[[.ow_capture_ordinal]]",
              "      if (.ow_start < 0L || .ow_length <= 0L) return(0)",
              "      .ow_end <- .ow_start + .ow_length",
              "      if (.ow_start < 1L || .ow_end > length(.ow_byte_prefix)) return(8192)",
              "      .ow_byte_prefix[[.ow_end]] - .ow_byte_prefix[[.ow_start]]",
              "    }, numeric(1L), USE.NAMES = FALSE))",
              "  }"
            )
          }
        } else if (identical(step$kind, "stripText")) {
          strip_characters <- if (is.null(step$characters)) default_strip_characters else step$characters
          lines <- c(
            lines,
            sprintf("  .ow_text_strip_characters <- strsplit(%s, \"\", fixed = TRUE)[[1L]]", r_string(strip_characters))
          )
        } else if (identical(step$kind, "splitText")) {
          lines <- c(
            lines,
            sprintf("  .ow_text_delimiter <- %s", r_string(step$delimiter)),
            sprintf("  .ow_text_part_index <- %.0f", step$index)
          )
        }
        lines <- c(
          lines,
          "  .ow_text_values <- vapply(seq_along(.ow_text_source), function(.ow_index) {",
          "    .ow_value <- .ow_text_source[[.ow_index]]",
          "    if (is.na(.ow_value)) return(NA_character_)",
          sprintf(
            "    if (identical(Encoding(.ow_value), \"bytes\")) stop(\"Open Wrangler %s requires valid UTF-8 text\", call. = FALSE)",
            operation_name
          ),
          "    .ow_encoding <- Encoding(.ow_value)",
          "    .ow_from <- if (identical(.ow_encoding, \"latin1\")) \"latin1\" else \"UTF-8\"",
          "    .ow_utf8 <- iconv(.ow_value, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
          sprintf(
            "    if (is.na(.ow_utf8) || nchar(.ow_utf8, type = \"bytes\") > 8192L) stop(\"Open Wrangler %s requires bounded valid UTF-8 text\", call. = FALSE)",
            operation_name
          )
        )
        if (identical(step$kind, "lowerText")) {
          lines <- c(lines, "    .ow_output <- tolower(.ow_utf8)")
        } else if (identical(step$kind, "upperText")) {
          lines <- c(lines, "    .ow_output <- toupper(.ow_utf8)")
        } else if (identical(step$kind, "capitalizeText")) {
          lines <- c(
            lines,
            "    .ow_characters <- strsplit(.ow_utf8, \"\", fixed = TRUE)[[1L]]",
            "    .ow_output <- if (length(.ow_characters) == 0L) \"\" else paste0(toupper(.ow_characters[[1L]]), if (length(.ow_characters) == 1L) \"\" else tolower(paste0(.ow_characters[-1L], collapse = \"\")))"
          )
        } else if (identical(step$kind, "stripText")) {
          lines <- c(
            lines,
            "    .ow_characters <- strsplit(.ow_utf8, \"\", fixed = TRUE)[[1L]]",
            "    .ow_retained <- which(!.ow_characters %in% .ow_text_strip_characters)",
            "    .ow_output <- if (length(.ow_retained) == 0L) \"\" else paste0(.ow_characters[seq.int(.ow_retained[[1L]], .ow_retained[[length(.ow_retained)]])], collapse = \"\")"
          )
        } else if (identical(step$kind, "splitText")) {
          lines <- c(
            lines,
            "    .ow_matches <- gregexpr(.ow_text_delimiter, .ow_utf8, fixed = TRUE)[[1L]]",
            "    if (length(.ow_matches) == 1L && identical(as.integer(.ow_matches[[1L]]), -1L)) {",
            "      .ow_output <- if (identical(.ow_text_part_index, 0)) .ow_utf8 else NA_character_",
            "    } else if (.ow_text_part_index >= length(.ow_matches) + 1L) {",
            "      .ow_output <- NA_character_",
            "    } else {",
            "      .ow_part <- as.integer(.ow_text_part_index) + 1L",
            "      .ow_match_lengths <- attr(.ow_matches, \"match.length\", exact = TRUE)",
            "      .ow_start <- if (.ow_part == 1L) 1L else .ow_matches[[.ow_part - 1L]] + .ow_match_lengths[[.ow_part - 1L]]",
            "      .ow_end <- if (.ow_part <= length(.ow_matches)) .ow_matches[[.ow_part]] - 1L else nchar(.ow_utf8, type = \"chars\")",
            "      .ow_output <- if (.ow_start > .ow_end) \"\" else substr(.ow_utf8, .ow_start, .ow_end)",
            "    }"
          )
        } else {
          lines <- c(
            lines,
            "    .ow_input_bytes <- as.double(nchar(.ow_utf8, type = \"bytes\"))",
            "    .ow_replacement_bytes <- as.double(nchar(.ow_text_replacement, type = \"bytes\"))",
            "    if (.ow_text_regex) {",
            "      .ow_matches <- tryCatch(",
            "        withCallingHandlers(",
            "          gregexpr(.ow_text_find, .ow_utf8, perl = TRUE),",
            "          warning = function(.ow_warning) stop(\"regex evaluation failed\", call. = FALSE)",
            "        ),",
            "        error = function(.ow_error) stop(\"Open Wrangler Find and Replace could not apply the requested regular expression\", call. = FALSE)",
            "      )",
            "      .ow_positions <- .ow_matches[[1L]]",
            "      if (length(.ow_positions) == 1L && identical(as.integer(.ow_positions[[1L]]), -1L)) {",
            "        .ow_output <- .ow_utf8",
            "      } else {",
            "        .ow_matched_values <- regmatches(.ow_utf8, .ow_matches)[[1L]]",
            "        .ow_matched_bytes <- sum(as.double(nchar(.ow_matched_values, type = \"bytes\")))",
            "        .ow_capture_byte_prefix <- if (isTRUE(attr(.ow_positions, \"useBytes\", exact = TRUE))) NULL else c(0, cumsum(as.double(nchar(strsplit(.ow_utf8, \"\", fixed = TRUE)[[1L]], type = \"bytes\"))))",
            "        .ow_replacement_bound <- length(.ow_matched_values) * (.ow_plain_literal_bytes + .ow_case_literal_bytes * 16)",
            "        for (.ow_capture_index in seq_len(9L)) {",
            "          .ow_capture_size <- .ow_capture_bytes(.ow_positions, .ow_capture_index, .ow_capture_byte_prefix)",
            "          .ow_replacement_bound <- .ow_replacement_bound + .ow_plain_references[[.ow_capture_index]] * .ow_capture_size + .ow_case_references[[.ow_capture_index]] * .ow_capture_size * 16",
            "        }",
            "        .ow_projected_bytes <- .ow_input_bytes - .ow_matched_bytes + .ow_replacement_bound",
            "        if (!is.finite(.ow_projected_bytes) || .ow_projected_bytes > 8192L) stop(\"Open Wrangler Find and Replace would produce text longer than 8192 UTF-8 bytes\", call. = FALSE)",
            "        .ow_output <- tryCatch(",
            "          withCallingHandlers(",
            "            gsub(.ow_text_find, .ow_text_replacement, .ow_utf8, perl = TRUE),",
            "            warning = function(.ow_warning) stop(\"regex evaluation failed\", call. = FALSE)",
            "          ),",
            "          error = function(.ow_error) stop(\"Open Wrangler Find and Replace could not apply the requested regular expression\", call. = FALSE)",
            "        )",
            "      }",
            "    } else if (identical(.ow_text_find, \"\")) {",
            "      .ow_projected_bytes <- .ow_input_bytes + (nchar(.ow_utf8, type = \"chars\") + 1) * .ow_replacement_bytes",
            "      if (!is.finite(.ow_projected_bytes) || .ow_projected_bytes > 8192L) stop(\"Open Wrangler Find and Replace would produce text longer than 8192 UTF-8 bytes\", call. = FALSE)",
            "      .ow_text_literal_replacement <- gsub(\"\\\\\", \"\\\\\\\\\", .ow_text_replacement, fixed = TRUE)",
            "      .ow_output <- gsub(\"\", .ow_text_literal_replacement, .ow_utf8, perl = TRUE)",
            "    } else {",
            "      .ow_literal_matches <- gregexpr(.ow_text_find, .ow_utf8, fixed = TRUE)[[1L]]",
            "      .ow_match_count <- if (length(.ow_literal_matches) == 1L && identical(as.integer(.ow_literal_matches[[1L]]), -1L)) 0 else length(.ow_literal_matches)",
            "      .ow_projected_bytes <- .ow_input_bytes + .ow_match_count * (.ow_replacement_bytes - nchar(.ow_text_find, type = \"bytes\"))",
            "      if (!is.finite(.ow_projected_bytes) || .ow_projected_bytes > 8192L) stop(\"Open Wrangler Find and Replace would produce text longer than 8192 UTF-8 bytes\", call. = FALSE)",
            "      .ow_output <- if (.ow_match_count == 0L) .ow_utf8 else gsub(.ow_text_find, .ow_text_replacement, .ow_utf8, fixed = TRUE)",
            "    }"
          )
        }
        lines <- c(
          lines,
          if (identical(step$kind, "splitText")) {
            "    if (is.character(.ow_output) && length(.ow_output) == 1L && is.na(.ow_output)) return(NA_character_)"
          } else {
            character()
          },
          "    if (!is.character(.ow_output) || length(.ow_output) != 1L || is.na(.ow_output)) stop(\"Open Wrangler text transform returned an invalid result\", call. = FALSE)",
          sprintf(
            "    if (identical(Encoding(.ow_output), \"bytes\")) stop(\"Open Wrangler %s produced invalid UTF-8 text\", call. = FALSE)",
            operation_name
          ),
          "    .ow_encoding <- Encoding(.ow_output)",
          "    .ow_from <- if (identical(.ow_encoding, \"latin1\")) \"latin1\" else \"UTF-8\"",
          "    .ow_output_utf8 <- iconv(.ow_output, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
          sprintf(
            "    if (is.na(.ow_output_utf8)) stop(\"Open Wrangler %s produced invalid UTF-8 text\", call. = FALSE)",
            operation_name
          ),
          sprintf(
            "    if (nchar(.ow_output_utf8, type = \"bytes\") > 8192L) stop(\"Open Wrangler %s would produce text longer than 8192 UTF-8 bytes\", call. = FALSE)",
            operation_name
          ),
          "    .ow_output_utf8",
          "  }, character(1L), USE.NAMES = FALSE)"
        )
        if (isTRUE(step$inPlace)) {
          lines <- c(
            lines,
            sprintf(
              "  if (inherits(.ow_result, \"data.table\") && !is.null(data.table::key(.ow_result)) && .ow_text_source_name %%in%% data.table::key(.ow_result)) stop(\"Open Wrangler %s cannot replace a data.table key column; choose a new output column\", call. = FALSE)",
              operation_name
            ),
            "  if (inherits(.ow_result, \"data.table\")) data.table::set(.ow_result, j = .ow_text_position, value = .ow_text_values) else .ow_result[[.ow_text_position]] <- .ow_text_values"
          )
        } else {
          lines <- c(
            lines,
            "  if (.ow_text_name == \"\" || any(names(.ow_result) == .ow_text_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
            sprintf(
              "  if (ncol(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
              maximum_columns
            ),
            "  if (inherits(.ow_result, \"data.table\")) {",
            "    data.table::set(.ow_result, j = .ow_text_name, value = .ow_text_values)",
            "  } else {",
            "    .ow_text_existing_names <- names(.ow_result)",
            "    .ow_result[[ncol(.ow_result) + 1L]] <- .ow_text_values",
            "    names(.ow_result) <- c(.ow_text_existing_names, .ow_text_name)",
            "  }"
          )
        }
      } else if (step$kind %in% c("roundNumber", "floorNumber", "ceilNumber")) {
        operation_name <- switch(
          step$kind,
          roundNumber = "Round",
          floorNumber = "Floor",
          ceilNumber = "Ceiling"
        )
        lines <- c(
          lines,
          sprintf("  .ow_numeric_position <- %dL", step$position),
          sprintf("  .ow_numeric_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_numeric_name <- %s", r_string(step$newName)),
          "  if (ncol(.ow_result) < .ow_numeric_position || !identical(names(.ow_result)[[.ow_numeric_position]], .ow_numeric_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  .ow_numeric_source <- .ow_result[[.ow_numeric_position]]",
          row_type_guard(".ow_numeric_source", list(semanticsKind = step$semanticKind))
        )
        numeric_expression <- if (identical(step$semanticKind, "integer64")) {
          if (identical(step$kind, "roundNumber")) {
            sprintf(".ow_round_integer64(.ow_numeric_source, %.0f)", step$decimals)
          } else {
            ".ow_numeric_source"
          }
        } else if (identical(step$kind, "roundNumber")) {
          sprintf("base::round(.ow_numeric_source, digits = %.0f)", step$decimals)
        } else if (identical(step$kind, "floorNumber")) {
          "base::floor(.ow_numeric_source)"
        } else {
          "base::ceiling(.ow_numeric_source)"
        }
        lines <- c(lines, sprintf("  .ow_numeric_values <- %s", numeric_expression))
        if (isTRUE(step$inPlace)) {
          lines <- c(
            lines,
            sprintf(
              "  if (inherits(.ow_result, \"data.table\") && !is.null(data.table::key(.ow_result)) && .ow_numeric_source_name %%in%% data.table::key(.ow_result)) stop(\"Open Wrangler %s cannot replace a data.table key column; choose a new output column\", call. = FALSE)",
              operation_name
            ),
            "  if (inherits(.ow_result, \"data.table\")) data.table::set(.ow_result, j = .ow_numeric_position, value = .ow_numeric_values) else .ow_result[[.ow_numeric_position]] <- .ow_numeric_values"
          )
        } else {
          lines <- c(
            lines,
            "  if (.ow_numeric_name == \"\" || any(names(.ow_result) == .ow_numeric_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
            sprintf(
              "  if (ncol(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
              maximum_columns
            ),
            "  if (inherits(.ow_result, \"data.table\")) {",
            "    data.table::set(.ow_result, j = .ow_numeric_name, value = .ow_numeric_values)",
            "  } else {",
            "    .ow_numeric_existing_names <- names(.ow_result)",
            "    .ow_result[[ncol(.ow_result) + 1L]] <- .ow_numeric_values",
            "    names(.ow_result) <- c(.ow_numeric_existing_names, .ow_numeric_name)",
            "  }"
          )
        }
      } else if (identical(step$kind, "fillMissingValues")) {
        fallback_fill <- identical(step$replacement$kind, "fallbackColumns")
        directional_fill <- identical(step$replacement$kind, "directional")
        grouped_fill <- identical(step$replacement$kind, "groupedStatistic")
        interpolation_fill <- identical(step$replacement$kind, "linearInterpolation")
        lines <- c(
          lines,
          sprintf("  .ow_fill_position <- %dL", step$position),
          sprintf("  .ow_fill_source_name <- %s", r_string(step$oldName)),
          "  if (ncol(.ow_result) < .ow_fill_position || !identical(names(.ow_result)[[.ow_fill_position]], .ow_fill_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  .ow_fill_source <- .ow_result[[.ow_fill_position]]",
          row_type_guard(".ow_fill_source", list(semanticsKind = step$semanticKind)),
          "  if (inherits(.ow_result, \"data.table\") && !is.null(data.table::key(.ow_result)) && .ow_fill_source_name %in% data.table::key(.ow_result)) stop(\"Open Wrangler Fill Missing Values cannot replace a data.table key column\", call. = FALSE)"
        )
        if (interpolation_fill) {
          coordinate <- step$interpolationCoordinate
          lines <- c(
            lines,
            sprintf("  if (ncol(.ow_result) < %dL || !identical(names(.ow_result)[[%dL]], %s)) stop(\"Open Wrangler interpolation coordinate is stale\", call. = FALSE)", coordinate$position, coordinate$position, r_string(coordinate$name)),
            sprintf("  .ow_fill_coordinate <- .ow_result[[%dL]]", coordinate$position),
            row_type_guard(".ow_fill_coordinate", coordinate),
            sprintf(
              "  .ow_fill_result <- .ow_fill_linear(.ow_fill_source, .ow_fill_coordinate, %s)",
              if (is.null(step$replacement$maxGap)) "NULL" else sprintf("%dL", step$replacement$maxGap)
            )
          )
        } else if (fallback_fill) {
          fallback_variables <- character(length(step$fallbackColumns))
          for (fallback_index in seq_along(step$fallbackColumns)) {
            fallback <- step$fallbackColumns[[fallback_index]]
            fallback_variable <- sprintf(".ow_fill_fallback_%d", fallback_index)
            fallback_variables[[fallback_index]] <- fallback_variable
            lines <- c(
              lines,
              sprintf("  if (ncol(.ow_result) < %dL || !identical(names(.ow_result)[[%dL]], %s)) stop(\"Open Wrangler fallback column reference is stale\", call. = FALSE)", fallback$position, fallback$position, r_string(fallback$oldName)),
              sprintf("  %s <- .ow_result[[%dL]]", fallback_variable, fallback$position),
              row_type_guard(fallback_variable, list(semanticsKind = fallback$semanticKind))
            )
          }
          fallback_list <- sprintf("list(%s)", paste(fallback_variables, collapse = ", "))
          fallback_kinds <- r_character_vector(vapply(
            step$fallbackColumns,
            `[[`,
            character(1L),
            "semanticKind",
            USE.NAMES = FALSE
          ))
          lines <- c(
            lines,
            sprintf(
              "  .ow_fill_result <- .ow_fill_from_columns(.ow_fill_source, %s, %s, %s, %dL)",
              r_string(step$semanticKind),
              fallback_list,
              fallback_kinds,
              maximum_factor_levels
            )
          )
        } else if (grouped_fill) {
          if (any(vapply(
            c(list(list(semanticsKind = step$semanticKind)), step$groupKeys),
            function(specification) identical(specification$semanticsKind, "integer64"),
            logical(1L),
            USE.NAMES = FALSE
          ))) {
            lines <- c(
              lines,
              "  if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required for this grouped fill\", call. = FALSE)"
            )
          }
          group_key_values <- sprintf(
            "list(%s)",
            paste(vapply(
              step$groupKeys,
              function(key) sprintf(".ow_result[[%dL]]", key$position),
              character(1L),
              USE.NAMES = FALSE
            ), collapse = ", ")
          )
          lines <- c(
            lines,
            row_sort_code_lines(step$groupKeys),
            sprintf(
              "  .ow_fill_result <- .ow_fill_grouped(.ow_fill_source, .ow_rows, %s, %s, %s)",
              group_key_values,
              r_string(step$semanticKind),
              r_string(step$replacement$statistic)
            )
          )
        } else if (directional_fill) {
          if (any(vapply(
            step$orderBy,
            function(specification) identical(specification$semanticsKind, "integer64"),
            logical(1L),
            USE.NAMES = FALSE
          ))) {
            lines <- c(
              lines,
              "  if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required for this directional fill\", call. = FALSE)"
            )
          }
          lines <- c(
            lines,
            row_sort_code_lines(step$orderBy),
            sprintf(
              "  .ow_fill_result <- .ow_fill_directional(.ow_fill_source, .ow_rows, %s, %s)",
              r_string(step$replacement$direction),
              if (is.null(step$replacement$maxGap)) "NULL" else sprintf("%dL", step$replacement$maxGap)
            )
          )
        } else {
          lines <- c(
            lines,
            "  .ow_fill_timezone <- attr(.ow_fill_source, \"tzone\", exact = TRUE)",
            "  if (is.null(.ow_fill_timezone) || identical(.ow_fill_timezone, \"\")) .ow_fill_timezone <- \"UTC\"",
            "  if (!is.character(.ow_fill_timezone) || length(.ow_fill_timezone) != 1L || is.na(.ow_fill_timezone)) stop(\"Open Wrangler received an unsupported POSIXct timezone\", call. = FALSE)",
            sprintf(
              "  .ow_fill_result <- .ow_fill_values(.ow_fill_source, %s, %s, %s)",
              r_string(step$semanticKind),
              r_fill_replacement(step$replacement),
              ".ow_fill_timezone"
            )
          )
        }
        lines <- c(
          lines,
          "  if (inherits(.ow_result, \"data.table\")) data.table::set(.ow_result, j = .ow_fill_position, value = .ow_fill_result) else .ow_result[[.ow_fill_position]] <- .ow_fill_result"
        )
      } else if (identical(step$kind, "castColumn")) {
        lines <- c(
          lines,
          sprintf("  .ow_cast_position <- %dL", step$position),
          sprintf("  .ow_cast_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_cast_dtype <- %s", r_string(step$dtype)),
          "  if (ncol(.ow_result) < .ow_cast_position || !identical(names(.ow_result)[[.ow_cast_position]], .ow_cast_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (inherits(.ow_result, \"data.table\") && !is.null(data.table::key(.ow_result)) && .ow_cast_source_name %in% data.table::key(.ow_result)) stop(\"castColumn cannot replace a data.table key column; clone the column before casting it\", call. = FALSE)",
          "  .ow_cast_result <- .ow_cast_values(.ow_result[[.ow_cast_position]], .ow_cast_dtype)",
          "  if (inherits(.ow_result, \"data.table\")) data.table::set(.ow_result, j = .ow_cast_position, value = .ow_cast_result) else .ow_result[[.ow_cast_position]] <- .ow_cast_result"
        )
      } else if (identical(step$kind, "dropColumns")) {
        positions <- vapply(step$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
        names <- vapply(step$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
        position_code <- paste(sprintf("%dL", positions), collapse = ", ")
        name_code <- paste(vapply(names, r_string, character(1L), USE.NAMES = FALSE), collapse = ", ")
        lines <- c(
          lines,
          sprintf("  .ow_drop_positions <- c(%s)", position_code),
          sprintf("  .ow_drop_names <- c(%s)", name_code),
          "  if (any(.ow_drop_positions > ncol(.ow_result)) || !identical(names(.ow_result)[.ow_drop_positions], .ow_drop_names)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  .ow_keep_positions <- setdiff(seq_len(ncol(.ow_result)), .ow_drop_positions)",
          "  if (length(.ow_keep_positions) == 0L) stop(\"Open Wrangler must keep at least one column\", call. = FALSE)",
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    .ow_result <- .ow_result[, .ow_keep_positions, with = FALSE]",
          "  } else {",
          "    for (.ow_position in sort(.ow_drop_positions, decreasing = TRUE)) .ow_result[[.ow_position]] <- NULL",
          "  }"
        )
      } else if (identical(step$kind, "selectColumns")) {
        positions <- vapply(step$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
        names <- vapply(step$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
        position_code <- paste(sprintf("%dL", positions), collapse = ", ")
        name_code <- paste(vapply(names, r_string, character(1L), USE.NAMES = FALSE), collapse = ", ")
        lines <- c(
          lines,
          sprintf("  .ow_select_positions <- c(%s)", position_code),
          sprintf("  .ow_select_names <- c(%s)", name_code),
          "  if (length(.ow_select_positions) == 0L || any(.ow_select_positions > ncol(.ow_result)) || !identical(names(.ow_result)[.ow_select_positions], .ow_select_names)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    .ow_result <- .ow_result[, .ow_select_positions, with = FALSE]",
          "  } else {",
          "    .ow_result <- .ow_result[.ow_select_positions]",
          "    names(.ow_result) <- .ow_select_names",
          "  }"
        )
      } else {
        abort("runtime_error", "The R cleaning plan contains an unsupported operation")
      }
    }
    code <- paste(c(lines, "  .ow_result", "})", ""), collapse = "\n")
    if (nchar(code, type = "bytes") > maximum_generated_code_bytes) {
      abort("runtime_error", "The generated R cleaning code is too large")
    }
    code
  }

  step_diff <- function(
    bound,
    frame_contract = NULL,
    before = NULL,
    after = NULL,
    page = NULL,
    before_page = NULL,
    after_page = NULL
  ) {
    added_columns <- if (
      bound$kind %in% c("cloneColumn", "textLength") ||
        (
          bound$kind %in% c(
            "lowerText",
            "upperText",
            "capitalizeText",
            "stripText",
            "splitText",
            "findReplace",
            "roundNumber",
            "floorNumber",
            "ceilNumber"
          ) &&
            !isTRUE(bound$inPlace)
        )
    ) {
      bound$newName
    } else {
      character()
    }
    removed_columns <- if (identical(bound$kind, "dropColumns")) {
      vapply(bound$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
    } else if (identical(bound$kind, "selectColumns")) {
      bound$removedNames
    } else {
      character()
    }
    changed_cells <- 0L
    cells <- list()
    truncated <- FALSE
    added_rows <- 0L
    removed_rows <- 0L
    if (bound$kind %in% c("sortRows", "filterRows", "dropMissingRows", "dropDuplicates")) {
      if (is.null(frame_contract) || is.null(before) || is.null(after) || is.null(page)) {
        abort("runtime_error", "The R row transform diff is missing its bounded page context")
      }
      if (is.null(before_page)) before_page <- materialize(frame_contract, before, page)
      if (is.null(after_page)) after_page <- materialize(frame_contract, after, page)
      before_rows <- before$descriptor$shape$rows
      after_rows <- after$descriptor$shape$rows
      added_rows <- as.integer(max(0, after_rows - before_rows))
      removed_rows <- as.integer(max(0, before_rows - after_rows))
      before_complete <-
        before_page$page$offset == 0 &&
          before_page$page$totalRows == before_rows &&
          length(before_page$page$rows) == before_rows
      after_complete <-
        after_page$page$offset == 0 &&
          after_page$page$totalRows == after_rows &&
          length(after_page$page$rows) == after_rows
      truncated <- !(before_complete && after_complete)
    } else if (
      bound$kind %in% c(
        "lowerText",
        "upperText",
        "capitalizeText",
        "stripText",
        "splitText",
        "findReplace",
        "roundNumber",
        "floorNumber",
        "ceilNumber",
        "fillMissingValues",
        "castColumn"
      ) &&
        isTRUE(bound$inPlace)
    ) {
      if (is.null(frame_contract) || is.null(before) || is.null(after) || is.null(page)) {
        abort("runtime_error", "The R in-place transform diff is missing its bounded page context")
      }
      if (is.null(before_page)) before_page <- materialize(frame_contract, before, page)
      if (is.null(after_page)) after_page <- materialize(frame_contract, after, page)
      before_position <- match(bound$outputId, before_page$page$columnIds)
      after_position <- match(bound$outputId, after_page$page$columnIds)
      if (is.na(before_position) || is.na(after_position)) {
        truncated <- TRUE
      } else {
        before_rows <- before_page$page$rows
        before_row_ids <- vapply(before_rows, `[[`, character(1L), "id", USE.NAMES = FALSE)
        matched_before <- logical(length(before_rows))
        matched_after <- 0L
        for (after_row in after_page$page$rows) {
          before_index <- match(after_row$id, before_row_ids)
          if (is.na(before_index)) next
          matched_before[[before_index]] <- TRUE
          matched_after <- matched_after + 1L
          old <- before_rows[[before_index]]$values[[before_position]]
          new <- after_row$values[[after_position]]
          if (!identical(old, new)) {
            changed_cells <- changed_cells + 1L
            if (length(cells) < 500L) {
              cells[[length(cells) + 1L]] <- list(
                rowNumber = after_row$rowNumber,
                columnId = bound$outputId,
                column = bound$newName,
                before = old,
                after = new
              )
            }
          }
        }
        if (matched_after != length(after_page$page$rows) || sum(matched_before) != length(before_rows)) {
          truncated <- TRUE
        }
      }
      truncated <- truncated ||
        before_page$page$totalRows > length(before_page$page$rows) ||
        after_page$page$totalRows > length(after_page$page$rows) ||
        changed_cells > length(cells)
    }
    list(
      addedRows = added_rows,
      removedRows = removed_rows,
      addedColumns = I(added_columns),
      removedColumns = I(removed_columns),
      changedCells = changed_cells,
      cells = I(cells),
      truncated = truncated
    )
  }

  encode_response <- function(response) {
    encoded <- jsonlite::toJSON(
      response,
      auto_unbox = TRUE,
      digits = NA,
      na = "null",
      null = "null",
      pretty = FALSE
    )
    if (nchar(encoded, type = "bytes") > maximum_response_bytes) {
      abort("runtime_error", "The R kernel response is too large")
    }
    enc2utf8(as.character(encoded))
  }

  preflight_response <- function(response) {
    encode_response(response)
    invisible(NULL)
  }

  canonical_base64 <- function(value) {
    encoded <- jsonlite::base64_enc(value)
    gsub("\r", "", gsub("\n", "", encoded, fixed = TRUE), fixed = TRUE)
  }

  plan_response <- function(request_id, session_id, action, session, page, frame_contract) {
    list(
      transportVersion = transport_version,
      requestId = request_id,
      kind = "planUpdated",
      sessionId = session_id,
      action = action,
      revision = session$revision,
      page = materialize(frame_contract, active_capture(session), page),
      code = compile_plan(
        session$variableName,
        session$boundPlan,
        frame_contract$limits$columns,
        frame_contract$limits$factorLevels
      )
    )
  }

  new_agent <- function(frame_contract, source_environment = .GlobalEnv, export_root = NULL) {
    required_functions <- c(
      "capture_frame",
      "capture_live_frame",
      "isolate_capture",
      "rename_column",
      "rename_column_at",
      "clone_column_at",
      "text_length_column_at",
      "lower_text_column_at",
      "upper_text_column_at",
      "capitalize_text_column_at",
      "strip_text_column_at",
      "split_text_column_at",
      "find_replace_column_at",
      "round_number_column_at",
      "floor_number_column_at",
      "ceil_number_column_at",
      "fill_missing_column_at",
      "fill_missing_from_fallback_columns_at",
      "fill_missing_directional_at",
      "fill_missing_linear_interpolation_at",
      "fill_missing_grouped_statistic_at",
      "cast_column_at",
      "drop_columns_at",
      "select_columns_at",
      "drop_missing_rows_at",
      "drop_duplicate_rows_at",
      "transform_rows",
      "materialize_view_page",
      "materialize_summaries",
      "materialize_dataset_stats",
      "materialize_column_values",
      "write_csv"
    )
    if (
      !is.list(frame_contract) ||
        !all(vapply(required_functions, function(name) is.function(frame_contract[[name]]), logical(1L))) ||
        !is.list(frame_contract$limits)
    ) {
      stop("Open Wrangler received an invalid R frame contract.", call. = FALSE)
    }
    if (!is.environment(source_environment)) {
      stop("Open Wrangler received an invalid R source environment.", call. = FALSE)
    }
    owns_export_root <- is.null(export_root)
    initialized_export_root <- FALSE
    construction_complete <- FALSE
    if (owns_export_root) {
      export_root <- tempfile("openwrangler-r-kernel-", tmpdir = tempdir())
      if (!dir.create(export_root, mode = "0700", showWarnings = FALSE)) {
        stop("Open Wrangler could not create its private R kernel export directory.", call. = FALSE)
      }
      initialized_export_root <- TRUE
    }
    on.exit({
      if (!construction_complete && owns_export_root && initialized_export_root && dir.exists(export_root)) {
        try(unlink(export_root, recursive = TRUE, force = TRUE), silent = TRUE)
      }
    }, add = TRUE)
    if (!is.null(export_root)) {
      export_root <- bounded_text(export_root, "export_root", 32768L)
      if (
        identical(export_root, "") ||
          !(
            startsWith(export_root, "/") ||
              startsWith(export_root, "\\\\") ||
              grepl("^[A-Za-z]:[/\\\\]", export_root, perl = TRUE)
          )
      ) {
        stop("Open Wrangler received an invalid private R export directory.", call. = FALSE)
      }
      export_root <- tryCatch(
        normalizePath(export_root, winslash = "/", mustWork = TRUE),
        error = function(error) ""
      )
      export_info <- if (identical(export_root, "")) NULL else file.info(export_root)
      if (
        identical(export_root, "") ||
          is.null(export_info) ||
          nrow(export_info) != 1L ||
          !isTRUE(export_info$isdir[[1L]])
      ) {
        stop("Open Wrangler received an invalid private R export directory.", call. = FALSE)
      }
    }

    sessions <- new.env(hash = TRUE, parent = emptyenv())
    exports <- new.env(hash = TRUE, parent = emptyenv())

    remove_export <- function(export_id) {
      if (!exists(export_id, envir = exports, inherits = FALSE)) return(invisible(FALSE))
      artifact <- get(export_id, envir = exports, inherits = FALSE)
      if (is.list(artifact) && is.character(artifact$path) && length(artifact$path) == 1L) {
        if (file.exists(artifact$path)) {
          removed <- unlink(artifact$path, force = TRUE)
          if (!identical(removed, 0L) || file.exists(artifact$path)) {
            stop("Open Wrangler could not remove a private R kernel export.", call. = FALSE)
          }
        }
      }
      rm(list = export_id, envir = exports)
      invisible(TRUE)
    }

    remove_session_exports <- function(session_id) {
      for (export_id in ls(envir = exports, all.names = TRUE)) {
        artifact <- get(export_id, envir = exports, inherits = FALSE)
        if (is.list(artifact) && identical(artifact$sessionId, session_id)) remove_export(export_id)
      }
      invisible(NULL)
    }

    dispose <- function() {
      for (export_id in ls(envir = exports, all.names = TRUE)) remove_export(export_id)
      if (owns_export_root && dir.exists(export_root)) {
        removed <- unlink(export_root, recursive = TRUE, force = TRUE)
        if (!identical(removed, 0L) || dir.exists(export_root)) {
          stop("Open Wrangler could not remove its private R kernel export directory.", call. = FALSE)
        }
      }
      initialized_export_root <<- FALSE
      invisible(NULL)
    }

    dispatch <- function(request) {
      request <- exact_record(request, c("transportVersion", "requestId", "kind", "payload"), "request")
      if (!identical(request$transportVersion, transport_version)) {
        abort("invalid_request", "request.transportVersion is unsupported")
      }
      request_id <- identifier(request$requestId, "request.requestId")
      kind <- bounded_text(request$kind, "request.kind", 32L)

      if (identical(kind, "openSession")) {
        payload <- exact_record(request$payload, c("sessionId", "variableName", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        variable_name <- bounded_text(
          payload$variableName,
          "request.payload.variableName",
          maximum_variable_name_bytes
        )
        if (identical(variable_name, "")) {
          abort("invalid_request", "request.payload.variableName may not be empty")
        }
        if (exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("duplicate_session", "The requested R session identity is already in use")
        }
        if (!exists(variable_name, envir = source_environment, inherits = FALSE)) {
          abort("unknown_variable", "The selected R dataframe variable no longer exists", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        source_reader <- local({
          source_name <- variable_name
          source <- source_environment
          function() {
            if (
              !exists(source_name, envir = source, inherits = FALSE) ||
                bindingIsActive(source_name, source)
            ) {
              return(NULL)
            }
            get(source_name, envir = source, inherits = FALSE)
          }
        })
        source_capture <- frame_contract$capture_live_frame(source_reader)
        result <- materialize(frame_contract, source_capture, page)
        session <- list(
          variableName = variable_name,
          source = source_capture,
          original = NULL,
          committed = NULL,
          draft = NULL,
          draftStep = NULL,
          draftBound = NULL,
          replaceStepId = NULL,
          plan = list(),
          boundPlan = list(),
          revision = 0L,
          editing = FALSE
        )
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "page",
          sessionId = session_id,
          page = result
        )
        preflight_response(response)
        assign(session_id, session, envir = sessions)
        return(response)
      }

      if (identical(kind, "getPage")) {
        payload <- exact_record(request$payload, c("sessionId", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        session <- get(session_id, envir = sessions, inherits = FALSE)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "page",
          sessionId = session_id,
          page = materialize(frame_contract, active_capture(session), page)
        ))
      }

      if (identical(kind, "getSummary")) {
        payload <- exact_record(request$payload, c("sessionId", "columns", "view"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        columns <- decode_column_references(payload$columns, frame_contract$limits)
        view <- decode_view(payload$view, frame_contract$limits)
        session <- get(session_id, envir = sessions, inherits = FALSE)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "summary",
          sessionId = session_id,
          summaries = frame_contract$materialize_summaries(active_capture(session), columns, view)
        ))
      }

      if (identical(kind, "getDatasetStats")) {
        payload <- exact_record(request$payload, c("sessionId", "view"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        view <- decode_view(payload$view, frame_contract$limits)
        result <- validate_dataset_stats_result(
          frame_contract$materialize_dataset_stats(active_capture(session), view),
          frame_contract$limits
        )
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "datasetStats",
          sessionId = session_id,
          totalRows = result$totalRows,
          stats = result$stats
        ))
      }

      if (identical(kind, "getColumnValues")) {
        payload <- exact_record(
          request$payload,
          c("sessionId", "column", "view", "search", "limit"),
          "request.payload"
        )
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        column <- decode_column_reference(
          payload$column,
          "request.payload.column",
          frame_contract$limits$columnIdBytes
        )
        view <- decode_view(payload$view, frame_contract$limits)
        search <- if (is.null(payload$search)) {
          NULL
        } else {
          bounded_text(payload$search, "request.payload.search", frame_contract$limits$textBytes)
        }
        limit <- whole_number(payload$limit, "request.payload.limit", 10000L)
        if (limit < 1L) abort("invalid_request", "request.payload.limit must be positive")
        session <- get(session_id, envir = sessions, inherits = FALSE)
        result <- frame_contract$materialize_column_values(active_capture(session), column, view, search, limit)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "columnValues",
          sessionId = session_id,
          column = result$column,
          values = result$values,
          hasMore = result$hasMore
        ))
      }

      if (identical(kind, "previewStep")) {
        payload <- exact_record(
          request$payload,
          c("sessionId", "revision", "step", "page"),
          "request.payload",
          optional_fields = "replaceStepId"
        )
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        if (!is.null(session$draft)) {
          abort("invalid_request", "Apply or discard the current R draft before previewing another step", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        step <- decode_transform_step(payload$step, frame_contract$limits)
        replace_step_id <- if ("replaceStepId" %in% names(payload)) {
          value <- bounded_text(payload$replaceStepId, "request.payload.replaceStepId", maximum_step_id_bytes)
          if (identical(value, "")) abort("invalid_request", "request.payload.replaceStepId may not be empty")
          value
        } else {
          NULL
        }

        session <- begin_editing(frame_contract, session)

        retained_plan <- session$plan
        retained_bound_plan <- session$boundPlan
        base <- session$committed
        if (!is.null(replace_step_id)) {
          if (
            length(session$plan) == 0L ||
              !identical(session$plan[[length(session$plan)]]$id, replace_step_id)
          ) {
            abort("invalid_request", "Only the latest applied R step can be edited", TRUE)
          }
          if (!identical(step$id, replace_step_id)) {
            abort("invalid_request", "An edited R step must retain its applied step ID", TRUE)
          }
          retained_plan <- session$plan[-length(session$plan)]
          replayed <- replay_plan(frame_contract, session$original, retained_plan)
          base <- replayed$capture
          retained_bound_plan <- replayed$boundPlan
        }
        if (length(retained_plan) >= frame_contract$limits$columns) {
          abort("invalid_request", "The R cleaning plan has reached its supported step limit", TRUE)
        }
        if (any(vapply(retained_plan, function(applied) identical(applied$id, step$id), logical(1L)))) {
          abort("invalid_request", "Applied R step IDs must be unique", TRUE)
        }

        applied <- apply_step(frame_contract, base, step)
        candidate <- session
        candidate$draft <- applied$capture
        candidate$draftStep <- step
        candidate$draftBound <- applied$bound
        candidate$replaceStepId <- replace_step_id
        candidate$editing <- TRUE
        candidate$revision <- next_revision(session)
        candidate_bound_plan <- c(retained_bound_plan, list(applied$bound))
        draft_page <- materialize(frame_contract, candidate$draft, page)
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "stepPreview",
          sessionId = session_id,
          revision = candidate$revision,
          page = draft_page,
          diff = step_diff(
            applied$bound,
            frame_contract,
            base,
            applied$capture,
            page,
            after_page = draft_page
          ),
          code = compile_plan(
            candidate$variableName,
            candidate_bound_plan,
            frame_contract$limits$columns,
            frame_contract$limits$factorLevels
          )
        )
        preflight_response(response)
        assign(session_id, candidate, envir = sessions)
        return(response)
      }

      if (kind %in% c("inspectStepInfo", "inspectStepPage")) {
        payload <- if (identical(kind, "inspectStepInfo")) {
          exact_record(request$payload, c("sessionId", "revision", "stepId"), "request.payload")
        } else {
          exact_record(
            request$payload,
            c("sessionId", "revision", "stepId", "side", "page"),
            "request.payload"
          )
        }
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        step_id <- bounded_text(payload$stepId, "request.payload.stepId", maximum_step_id_bytes)
        if (identical(step_id, "")) abort("invalid_request", "request.payload.stepId may not be empty")
        matches <- which(vapply(session$plan, function(step) identical(step$id, step_id), logical(1L)))
        if (length(matches) != 1L) {
          abort("invalid_request", sprintf("Unknown or repeated applied R step: %s", step_id), TRUE)
        }
        step_index <- matches[[1L]]
        if (identical(kind, "inspectStepInfo")) {
          return(list(
            transportVersion = transport_version,
            requestId = request_id,
            kind = "stepInspectionInfo",
            sessionId = session_id,
            revision = session$revision,
            stepId = step_id,
            stepIndex = as.integer(step_index - 1L),
            code = compile_plan(
              session$variableName,
              utils::head(session$boundPlan, step_index),
              frame_contract$limits$columns,
              frame_contract$limits$factorLevels
            )
          ))
        }
        side <- bounded_text(payload$side, "request.payload.side", 6L)
        if (!side %in% c("input", "output")) {
          abort("invalid_request", "request.payload.side must be input or output")
        }
        page <- decode_page(payload$page, frame_contract$limits)
        inspected <- replay_plan(
          frame_contract,
          session$original,
          utils::head(session$plan, step_index - if (identical(side, "input")) 1L else 0L)
        )
        inspection_page <- materialize(
          frame_contract,
          inspected$capture,
          page
        )
        inspection_page$schema <- NULL
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "stepInspectionPage",
          sessionId = session_id,
          revision = session$revision,
          stepId = step_id,
          stepIndex = as.integer(step_index - 1L),
          side = side,
          page = inspection_page
        ))
      }

      if (identical(kind, "applyDraft")) {
        payload <- exact_record(request$payload, c("sessionId", "revision", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        if (is.null(session$draft) || is.null(session$draftStep) || is.null(session$draftBound)) {
          abort("invalid_request", "There is no R draft step to apply", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        candidate <- session
        if (is.null(session$replaceStepId)) {
          candidate$plan <- c(session$plan, list(session$draftStep))
          candidate$boundPlan <- c(session$boundPlan, list(session$draftBound))
        } else {
          candidate$plan[[length(candidate$plan)]] <- session$draftStep
          candidate$boundPlan[[length(candidate$boundPlan)]] <- session$draftBound
        }
        candidate$committed <- session$draft
        candidate$draft <- NULL
        candidate$draftStep <- NULL
        candidate$draftBound <- NULL
        candidate$replaceStepId <- NULL
        candidate$revision <- next_revision(session)
        response <- plan_response(request_id, session_id, "apply", candidate, page, frame_contract)
        preflight_response(response)
        assign(session_id, candidate, envir = sessions)
        return(response)
      }

      if (identical(kind, "discardDraft")) {
        payload <- exact_record(request$payload, c("sessionId", "revision", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        if (is.null(session$draft)) abort("invalid_request", "There is no R draft step to discard", TRUE)
        page <- decode_page(payload$page, frame_contract$limits)
        candidate <- session
        candidate$draft <- NULL
        candidate$draftStep <- NULL
        candidate$draftBound <- NULL
        candidate$replaceStepId <- NULL
        candidate$revision <- next_revision(session)
        response <- plan_response(request_id, session_id, "discard", candidate, page, frame_contract)
        preflight_response(response)
        assign(session_id, candidate, envir = sessions)
        return(response)
      }

      if (identical(kind, "undoStep")) {
        payload <- exact_record(request$payload, c("sessionId", "revision", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        if (!is.null(session$draft)) {
          abort("invalid_request", "Discard the R draft before undoing an applied step", TRUE)
        }
        if (length(session$plan) == 0L) {
          abort("invalid_request", "There is no applied R step to undo", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        retained_plan <- session$plan[-length(session$plan)]
        replayed <- replay_plan(frame_contract, session$original, retained_plan)
        candidate <- session
        candidate$plan <- retained_plan
        candidate$boundPlan <- replayed$boundPlan
        candidate$committed <- replayed$capture
        candidate$editing <- TRUE
        candidate$revision <- next_revision(session)
        response <- plan_response(request_id, session_id, "undo", candidate, page, frame_contract)
        preflight_response(response)
        assign(session_id, candidate, envir = sessions)
        return(response)
      }

      if (identical(kind, "exportData")) {
        payload <- exact_record(
          request$payload,
          c("sessionId", "revision", "exportId", "format"),
          "request.payload"
        )
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        if (!is.null(session$draft)) {
          abort("invalid_request", "Apply or discard the current R draft before exporting data", TRUE)
        }
        export_id <- identifier(payload$exportId, "request.payload.exportId")
        if (exists(export_id, envir = exports, inherits = FALSE)) {
          abort("invalid_request", "The requested R export identity is already in use", TRUE)
        }
        format <- bounded_text(payload$format, "request.payload.format", 16L)
        if (!identical(format, "csv")) {
          abort("invalid_request", "Native R data export currently supports CSV only", TRUE)
        }
        capture <- if (isTRUE(session$editing)) session$committed else session$source
        if (is.null(capture)) {
          abort("runtime_error", "The committed R dataframe is no longer available")
        }
        artifact_path <- file.path(export_root, paste0(export_id, ".csv"))
        completed <- FALSE
        on.exit({
          if (!completed && file.exists(artifact_path)) try(unlink(artifact_path, force = TRUE), silent = TRUE)
        }, add = TRUE)
        exported <- frame_contract$write_csv(capture, artifact_path)
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "dataExported",
          sessionId = session_id,
          revision = session$revision,
          exportId = export_id,
          format = "csv",
          rows = exported$rows,
          columns = exported$columns,
          bytes = exported$bytes
        )
        preflight_response(response)
        if (owns_export_root) {
          assign(
            export_id,
            list(
              sessionId = session_id,
              revision = as.double(session$revision),
              path = artifact_path,
              bytes = exported$bytes
            ),
            envir = exports
          )
        }
        completed <- TRUE
        return(response)
      }

      if (identical(kind, "readDataExport")) {
        payload <- exact_record(
          request$payload,
          c("sessionId", "revision", "exportId", "offset", "limit"),
          "request.payload"
        )
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        export_id <- identifier(payload$exportId, "request.payload.exportId")
        if (!exists(export_id, envir = exports, inherits = FALSE)) {
          abort("invalid_request", "The requested R export is no longer available", TRUE)
        }
        artifact <- get(export_id, envir = exports, inherits = FALSE)
        if (
          !identical(artifact$sessionId, session_id) ||
            !identical(artifact$revision, as.double(session$revision))
        ) {
          abort("invalid_request", "The requested R export belongs to a different session revision", TRUE)
        }
        offset <- whole_number(payload$offset, "request.payload.offset", artifact$bytes)
        limit <- whole_number(payload$limit, "request.payload.limit", maximum_export_chunk_bytes)
        if (limit < 1L) abort("invalid_request", "request.payload.limit must be positive", TRUE)
        details <- file.info(artifact$path)
        if (
          nrow(details) != 1L ||
            is.na(details$size[[1L]]) ||
            !identical(as.double(details$size[[1L]]), as.double(artifact$bytes)) ||
            isTRUE(details$isdir[[1L]])
        ) {
          abort("runtime_error", "The private R export changed before it could be read")
        }
        connection <- NULL
        on.exit({
          if (!is.null(connection)) try(close(connection), silent = TRUE)
        }, add = TRUE)
        chunk <- tryCatch(
          {
            connection <- file(artifact$path, open = "rb")
            seek(connection, where = offset, origin = "start", rw = "read")
            value <- readBin(connection, what = "raw", n = min(limit, artifact$bytes - offset))
            close(connection)
            connection <- NULL
            value
          },
          error = function(error) abort("runtime_error", "The private R export could not be read")
        )
        if (!is.null(connection)) close(connection)
        if (offset < artifact$bytes && length(chunk) == 0L) {
          abort("runtime_error", "The private R export ended before its recorded size")
        }
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "dataExportChunk",
          sessionId = session_id,
          revision = session$revision,
          exportId = export_id,
          offset = offset,
          bytes = length(chunk),
          data = canonical_base64(chunk)
        )
        preflight_response(response)
        return(response)
      }

      if (identical(kind, "closeDataExport")) {
        payload <- exact_record(
          request$payload,
          c("sessionId", "revision", "exportId"),
          "request.payload"
        )
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        revision <- whole_number(payload$revision, "request.payload.revision", maximum_revision)
        export_id <- identifier(payload$exportId, "request.payload.exportId")
        if (exists(export_id, envir = exports, inherits = FALSE)) {
          artifact <- get(export_id, envir = exports, inherits = FALSE)
          if (!identical(artifact$sessionId, session_id) || !identical(artifact$revision, revision)) {
            abort("invalid_request", "The requested R export belongs to a different session revision", TRUE)
          }
          remove_export(export_id)
        }
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "dataExportClosed",
          sessionId = session_id,
          revision = revision,
          exportId = export_id
        ))
      }

      if (identical(kind, "closeSession")) {
        payload <- exact_record(request$payload, c("sessionId"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is already closed", TRUE)
        }
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "closed",
          sessionId = session_id
        )
        preflight_response(response)
        remove_session_exports(session_id)
        rm(list = session_id, envir = sessions)
        return(response)
      }

      abort("invalid_request", "request.kind is unsupported")
    }

    dispatch_json <- function(payload) {
      request_id <- ""
      response <- tryCatch(
        {
          if (!requireNamespace("jsonlite", quietly = TRUE)) {
            abort("missing_package", "The selected R kernel requires the jsonlite package")
          }
          payload <- bounded_text(payload, "request JSON", maximum_response_bytes)
          request <- jsonlite::fromJSON(payload, simplifyVector = FALSE)
          if (is.list(request) && is.character(request$requestId) && length(request$requestId) == 1L) {
            request_id <- request$requestId
          }
          dispatch(request)
        },
        openwrangler_r_kernel_error = function(error) {
          message <- diagnostic_message(error, "The R runtime request failed")
          list(
            transportVersion = transport_version,
            requestId = request_id,
            kind = "error",
            code = error$code,
            message = message,
            recoverable = isTRUE(error$recoverable)
          )
        },
        openwrangler_r_frame_error = function(error) {
          diagnostic <- frame_diagnostic(error)
          list(
            transportVersion = transport_version,
            requestId = request_id,
            kind = "error",
            code = diagnostic$code,
            message = diagnostic$message,
            recoverable = diagnostic$recoverable
          )
        },
        error = function(error) {
          message <- diagnostic_message(error, "The R runtime request failed")
          list(
            transportVersion = transport_version,
            requestId = request_id,
            kind = "error",
            code = "runtime_error",
            message = message,
            recoverable = FALSE
          )
        }
      )
      encode_response(response)
    }

    environment(dispatch_json) <- environment()
    construction_complete <- TRUE
    list(dispatch_json = dispatch_json, dispose = dispose)
  }

  list(new_agent = new_agent, transport_version = transport_version)
})
