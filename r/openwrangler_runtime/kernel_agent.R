openwrangler_r_kernel_agent <- local({
  transport_version <- 14L
  maximum_identifier_bytes <- 128L
  maximum_name_bytes <- 1024L
  maximum_variable_name_bytes <- 1024L
  maximum_step_id_bytes <- 1024L
  maximum_error_bytes <- 4096L
  maximum_response_bytes <- 17L * 1024L * 1024L
  maximum_generated_code_bytes <- 4L * 1024L * 1024L
  maximum_export_chunk_bytes <- 1L * 1024L * 1024L
  maximum_operation_output_bytes <- 64L * 1024L * 1024L
  maximum_operation_output_chunk_rows <- 1024L
  character_vector_slot_bytes <- 8L
  metadata_base_bytes <- 1024L
  column_fixed_bytes <- 512L
  maximum_fill_directional_gap <- 1000000L
  maximum_by_example_sources <- 16L
  maximum_by_example_examples <- 64L
  maximum_by_example_program_nodes <- 256L
  maximum_by_example_program_depth <- 64L
  maximum_by_example_concat_parts <- 64L
  maximum_by_example_warnings <- 64L
  maximum_by_example_string_bytes <- 8L * 1024L
  maximum_by_example_text_bytes <- 64L * 1024L
  maximum_custom_code_bytes <- 64L * 1024L
  maximum_by_example_slice_source_characters <- 128L
  by_example_delimiters <- c(" ", "-", "_", "/", ".", ",", ":")
  by_example_regex_patterns <- c("(\\d+)", "([A-Za-z]+)", "([A-Za-z0-9]+)")
  by_example_date_formats <- c(
    "%Y-%m-%d",
    "%d/%m/%Y",
    "%m/%d/%Y",
    "%Y/%m/%d",
    "%d-%m-%Y",
    "%m-%d-%Y",
    "%Y%m%d",
    "%d %B %Y",
    "%B %d, %Y",
    "%b %d, %Y",
    "%Y",
    "%m/%Y"
  )
  maximum_revision <- .Machine$integer.max
  default_strip_characters <- paste0(
    " \t\n\r\v\f",
    "\u001c\u001d\u001e\u001f",
    "\u0085\u00a0\u1680",
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a",
    "\u2028\u2029\u202f\u205f\u3000"
  )
  identifier_pattern <- "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

  anyDuplicated <- function(value) base::anyDuplicated.default(value)

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
    result <- list(filters = filters, sorts = decode_sort_rules(view$sorts, limits))
    if ("logic" %in% names(view)) result$logic <- view$logic
    result
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
      "dataset statistics",
      optional_fields = "duplicateRowsSampleSize"
    )
    missing_rows <- result_whole_number(stats$missingRows, "dataset statistics missingRows", total_rows)
    duplicate_rows_domain <- if ("duplicateRowsSampleSize" %in% names(stats)) {
      result_whole_number(
        stats$duplicateRowsSampleSize,
        "dataset statistics duplicateRowsSampleSize",
        total_rows
      )
    } else {
      total_rows
    }
    if ("duplicateRowsSampleSize" %in% names(stats) && duplicate_rows_domain < 1) {
      abort("runtime_error", "dataset statistics duplicateRowsSampleSize is outside its supported range")
    }
    duplicate_rows <- result_whole_number(
      stats$duplicateRows,
      "dataset statistics duplicateRows",
      max(0, duplicate_rows_domain - 1)
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

  reconcile_custom_code_view <- function(view, before, after) {
    plain_schema <- function(value) {
      value <- unclass(value)
      attributes(value) <- NULL
      lapply(seq_along(value), function(index) {
        column <- unclass(.subset2(value, index))
        column
      })
    }
    before_schema <- plain_schema(before$descriptor$schema)
    after_schema <- plain_schema(after$descriptor$schema)
    unique_column <- function(schema, reference) {
      matches <- which(vapply(
        schema,
        function(column) identical(.subset2(column, "name"), reference$name),
        logical(1L),
        USE.NAMES = FALSE
      ))
      if (length(matches) != 1L) return(NULL)
      column <- .subset2(schema, .subset2(matches, 1L))
      if (!identical(.subset2(column, "id"), reference$id)) return(NULL)
      column
    }
    filters <- Filter(function(filter) {
      prior <- unique_column(before_schema, filter$column)
      next_column <- unique_column(after_schema, filter$column)
      !is.null(prior) &&
        !is.null(next_column) &&
        identical(.subset2(prior, "type"), filter$type) &&
        identical(.subset2(next_column, "type"), filter$type)
    }, view$filters)
    sorts <- Filter(function(rule) {
      prior <- unique_column(before_schema, rule$column)
      next_column <- unique_column(after_schema, rule$column)
      !is.null(prior) &&
        !is.null(next_column) &&
        identical(.subset2(prior, "type"), .subset2(next_column, "type"))
    }, view$sorts)
    result <- list(filters = unname(filters), sorts = unname(sorts))
    if ("logic" %in% names(view)) result$logic <- view$logic
    result
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

  by_example_json_scalar <- function(value) {
    if (is.null(value)) return(TRUE)
    if (!is.null(attributes(value)) || length(value) != 1L || is.object(value)) return(FALSE)
    if (is.character(value)) {
      if (is.na(value) || identical(Encoding(value), "bytes")) return(FALSE)
      return(!is.na(iconv(value, from = "", to = "UTF-8", sub = NA_character_)))
    }
    if (is.logical(value)) return(!is.na(value))
    if (!is.integer(value) && !is.double(value)) return(FALSE)
    if (is.na(value) || !is.finite(value)) return(FALSE)
    if (is.double(value) && value == 0 && is.infinite(1 / value) && (1 / value) < 0) return(FALSE)
    # A JavaScript integer outside Number.MAX_SAFE_INTEGER loses its lexical
    # and exact integer identity when decoded into an R double. Reject that
    # non-portable public scalar instead of silently reinterpreting it.
    !(is.double(value) && value == floor(value) && abs(value) > 9007199254740991)
  }

  validate_by_example_text_budget <- function(value) {
    budget <- new.env(parent = emptyenv())
    budget$bytes <- 0
    visit <- function(item, depth = 0L) {
      if (depth > 128L) abort("invalid_request", "By-example parameters are nested too deeply")
      if (is.character(item)) {
        values <- unclass(item)
        for (index in seq_len(length(values))) {
          text <- values[[index]]
          if (
            length(text) != 1L || is.na(text) || identical(Encoding(text), "bytes")
          ) {
            abort("invalid_request", "By-example text must contain valid Unicode")
          }
          source_encoding <- if (identical(Encoding(text), "latin1")) "latin1" else "UTF-8"
          converted <- suppressWarnings(iconv(text, from = source_encoding, to = "UTF-8", sub = NA_character_))
          if (is.na(converted)) abort("invalid_request", "By-example text must contain valid Unicode")
          bytes <- nchar(converted, type = "bytes")
          if (bytes > maximum_by_example_string_bytes) {
            abort(
              "invalid_request",
              sprintf(
                "Each by-example text value must be at most %d UTF-8 bytes",
                maximum_by_example_string_bytes
              )
            )
          }
          next_bytes <- budget$bytes + as.double(bytes)
          if (!is.finite(next_bytes) || next_bytes > maximum_by_example_text_bytes) {
            abort(
              "invalid_request",
              sprintf(
                "By-example text must total at most %d UTF-8 bytes",
                maximum_by_example_text_bytes
              )
            )
          }
          budget$bytes <- next_bytes
        }
        return(invisible(NULL))
      }
      if (is.list(item)) {
        for (index in seq_len(length(unclass(item)))) {
          visit(base::.subset2(item, index), depth + 1L)
        }
      }
      invisible(NULL)
    }
    visit(value)
    invisible(NULL)
  }

  decode_by_example_program <- function(value, source_columns, limits) {
    node_budget <- new.env(parent = emptyenv())
    node_budget$remaining <- maximum_by_example_program_nodes
    source_ids <- vapply(source_columns, `[[`, character(1L), "id", USE.NAMES = FALSE)
    source_names <- vapply(source_columns, `[[`, character(1L), "name", USE.NAMES = FALSE)

    by_example_whole_number <- function(value, label, signed = FALSE) {
      if (
        is.double(value) && length(value) == 1L && !is.na(value) &&
          value == 0 && is.infinite(1 / value) && (1 / value) < 0
      ) {
        abort("invalid_request", sprintf("%s must not be negative zero", label))
      }
      if (isTRUE(signed)) {
        signed_whole_number(value, label, maximum_revision)
      } else {
        whole_number(value, label, maximum_revision)
      }
    }

    decode <- function(program, label, depth) {
      node_budget$remaining <- node_budget$remaining - 1L
      if (node_budget$remaining < 0L) {
        abort(
          "invalid_request",
          sprintf("By-example programs may contain at most %d nodes", maximum_by_example_program_nodes)
        )
      }
      if (depth > maximum_by_example_program_depth) {
        abort(
          "invalid_request",
          sprintf("By-example programs may be at most %d levels deep", maximum_by_example_program_depth)
        )
      }
      if (!is.list(program) || is.object(program) || is.null(names(program))) {
        abort("invalid_request", sprintf("%s must be a program object", label))
      }
      if (!"kind" %in% names(program)) abort("invalid_request", sprintf("%s has invalid fields", label))
      kind <- bounded_text(program$kind, paste0(label, ".kind"), 32L)
      child <- function(key) decode(program[[key]], paste0(label, ".", key), depth + 1L)

      if (identical(kind, "column")) {
        node <- exact_record(program, c("kind", "column"), label)
        reference <- decode_column_reference(node$column, paste0(label, ".column"), limits$columnIdBytes)
        matches <- which(source_ids == reference$id)
        if (length(matches) != 1L || !identical(source_names[[matches[[1L]]]], reference$name)) {
          abort("invalid_request", "By-example program references an unavailable or stale source column")
        }
        return(list(kind = kind, column = reference))
      }
      if (identical(kind, "literal")) {
        node <- exact_record(program, c("kind", "value"), label)
        if (!by_example_json_scalar(node$value)) {
          abort("invalid_request", "By-example literal must be a finite JSON scalar")
        }
        return(list(kind = kind, value = by_example_canonical_json_scalar(node$value)))
      }
      if (identical(kind, "slice")) {
        node <- exact_record(program, c("kind", "input", "start"), label, optional_fields = "stop")
        start <- by_example_whole_number(node$start, paste0(label, ".start"))
        stop <- if ("stop" %in% names(node)) node$stop else NULL
        if (!is.null(stop)) {
          stop <- by_example_whole_number(stop, paste0(label, ".stop"))
          if (stop < start) abort("invalid_request", "By-example slice stop must not precede start")
        }
        result <- list(kind = kind, input = child("input"), start = as.integer(start))
        if ("stop" %in% names(node)) result["stop"] <- list(if (is.null(stop)) NULL else as.integer(stop))
        return(result)
      }
      if (identical(kind, "split")) {
        node <- exact_record(program, c("kind", "input", "delimiter", "index"), label)
        delimiter <- bounded_text(node$delimiter, paste0(label, ".delimiter"), maximum_by_example_string_bytes)
        index <- by_example_whole_number(node$index, paste0(label, ".index"))
        return(list(kind = kind, input = child("input"), delimiter = delimiter, index = as.integer(index)))
      }
      if (identical(kind, "concat")) {
        node <- exact_record(program, c("kind", "parts"), label)
        parts <- node$parts
        if (
          !is.list(parts) || is.object(parts) || !is.null(names(parts)) ||
            length(parts) < 1L || length(parts) > maximum_by_example_concat_parts
        ) {
          abort(
            "invalid_request",
            sprintf("By-example concat requires between 1 and %d parts", maximum_by_example_concat_parts)
          )
        }
        return(list(
          kind = kind,
          parts = lapply(seq_along(parts), function(index) {
            decode(parts[[index]], sprintf("%s.parts[%d]", label, index), depth + 1L)
          })
        ))
      }
      if (identical(kind, "regexExtract")) {
        node <- exact_record(program, c("kind", "input", "pattern", "group"), label)
        pattern <- bounded_text(node$pattern, paste0(label, ".pattern"), maximum_by_example_string_bytes)
        group <- by_example_whole_number(node$group, paste0(label, ".group"), signed = TRUE)
        return(list(
          kind = kind,
          input = child("input"),
          pattern = pattern,
          group = as.integer(group)
        ))
      }
      if (identical(kind, "regexReplace")) {
        node <- exact_record(program, c("kind", "input", "pattern", "replacement"), label)
        return(list(
          kind = kind,
          input = child("input"),
          pattern = bounded_text(node$pattern, paste0(label, ".pattern"), maximum_by_example_string_bytes),
          replacement = bounded_text(
            node$replacement,
            paste0(label, ".replacement"),
            maximum_by_example_string_bytes
          )
        ))
      }
      if (identical(kind, "case")) {
        node <- exact_record(program, c("kind", "style", "input"), label)
        style <- bounded_text(node$style, paste0(label, ".style"), 16L)
        if (!style %in% c("lower", "upper", "capitalize")) {
          abort("invalid_request", "Unsupported by-example case style")
        }
        return(list(kind = kind, style = style, input = child("input")))
      }
      if (identical(kind, "datetimeFormat")) {
        node <- exact_record(
          program,
          c("kind", "input", "inputFormat", "outputFormat"),
          label
        )
        return(list(
          kind = kind,
          input = child("input"),
          inputFormat = bounded_text(
            node$inputFormat,
            paste0(label, ".inputFormat"),
            maximum_by_example_string_bytes
          ),
          outputFormat = bounded_text(
            node$outputFormat,
            paste0(label, ".outputFormat"),
            maximum_by_example_string_bytes
          )
        ))
      }
      if (identical(kind, "arithmetic")) {
        node <- exact_record(program, c("kind", "left", "operator", "right"), label)
        operator <- bounded_text(node$operator, paste0(label, ".operator"), 16L)
        if (!operator %in% c("add", "subtract", "multiply", "divide")) {
          abort("invalid_request", "Unsupported by-example arithmetic operator")
        }
        return(list(
          kind = kind,
          left = child("left"),
          operator = operator,
          right = child("right")
        ))
      }
      abort("invalid_request", sprintf("Unsupported by-example program kind: %s", kind))
    }

    decode(value, "request.payload.step.params.program", 0L)
  }

  by_example_shortest_double_components <- function(value) {
    if (!is.double(value) || length(value) != 1L || is.na(value) || !is.finite(value)) {
      stop("Open Wrangler by-example received an invalid finite double", call. = FALSE)
    }
    negative <- value < 0 || (value == 0 && is.infinite(1 / value) && (1 / value) < 0)
    absolute <- abs(value)
    if (absolute == 0) return(list(negative = negative, digits = "0", exponent = 0L))
    shortest <- NULL
    for (precision in seq_len(17L)) {
      candidate <- sprintf(paste0("%.", precision, "g"), absolute)
      candidate <- sub(",", ".", candidate, fixed = TRUE)
      parsed <- tryCatch(
        suppressWarnings(jsonlite::fromJSON(candidate, simplifyVector = FALSE)),
        error = function(error) NULL
      )
      if (
        is.numeric(parsed) && length(parsed) == 1L && !is.na(parsed) &&
          identical(as.double(parsed), absolute)
      ) {
        shortest <- candidate
        break
      }
    }
    if (is.null(shortest)) {
      stop("Open Wrangler could not serialize a finite by-example double", call. = FALSE)
    }
    matched <- regexec(
      "^([0-9]+)(?:\\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$",
      shortest,
      perl = TRUE
    )[[1L]]
    fields <- regmatches(shortest, list(matched))[[1L]]
    if (length(fields) != 4L) {
      stop("Open Wrangler could not normalize a finite by-example double", call. = FALSE)
    }
    integer_part <- fields[[2L]]
    fraction_part <- fields[[3L]]
    explicit_exponent <- if (identical(fields[[4L]], "")) 0L else suppressWarnings(as.integer(fields[[4L]]))
    combined <- paste0(integer_part, fraction_part)
    leading_zeroes <- nchar(sub("^([^1-9]*).*", "\\1", combined, perl = TRUE), type = "chars")
    digits <- substring(combined, leading_zeroes + 1L)
    if (identical(digits, "")) digits <- "0"
    list(
      negative = negative,
      digits = digits,
      exponent = as.integer(nchar(integer_part, type = "chars") + explicit_exponent - leading_zeroes - 1L)
    )
  }

  by_example_double_text <- function(value, python = FALSE) {
    parts <- by_example_shortest_double_components(value)
    if (identical(parts$digits, "0")) {
      if (python) return(if (parts$negative) "-0.0" else "0.0")
      return("0")
    }
    sign <- if (parts$negative) "-" else ""
    exponent <- parts$exponent
    digits <- parts$digits
    fixed_lower <- if (python) -4L else -6L
    fixed_upper <- if (python) 16L else 21L
    if (exponent >= fixed_lower && exponent < fixed_upper) {
      decimal_position <- exponent + 1L
      fixed <- if (decimal_position <= 0L) {
        paste0("0.", paste0(rep.int("0", -decimal_position), collapse = ""), digits)
      } else if (decimal_position >= nchar(digits, type = "chars")) {
        paste0(digits, paste0(rep.int("0", decimal_position - nchar(digits, type = "chars")), collapse = ""))
      } else {
        paste0(
          substring(digits, 1L, decimal_position),
          ".",
          substring(digits, decimal_position + 1L)
        )
      }
      if (python && !grepl("\\.", fixed, fixed = FALSE)) fixed <- paste0(fixed, ".0")
      return(paste0(sign, fixed))
    }
    mantissa <- if (nchar(digits, type = "chars") == 1L) {
      digits
    } else {
      paste0(substring(digits, 1L, 1L), ".", substring(digits, 2L))
    }
    exponent_sign <- if (exponent < 0L) "-" else "+"
    exponent_digits <- as.character(abs(exponent))
    if (python && nchar(exponent_digits, type = "chars") < 2L) {
      exponent_digits <- paste0("0", exponent_digits)
    }
    paste0(sign, mantissa, "e", exponent_sign, exponent_digits)
  }

  by_example_json_integer_text <- function(value) {
    if (is.integer(value) && length(value) == 1L && !is.na(value)) return(as.character(value))
    if (
      !is.double(value) || length(value) != 1L || is.na(value) || !is.finite(value) ||
        value != floor(value) || abs(value) > 9007199254740991
    ) return(NULL)
    sprintf("%.0f", value)
  }

  by_example_canonical_json_scalar <- function(value) {
    if (is.double(value) && value == 0 && is.infinite(1 / value) && (1 / value) < 0) return(value)
    integer_text <- by_example_json_integer_text(value)
    if (
      !is.null(integer_text) && as.double(value) >= -.Machine$integer.max &&
        as.double(value) <= .Machine$integer.max
    ) {
      return(as.integer(value))
    }
    value
  }

  by_example_utf8_scalar <- function(value) {
    if (!base::is.character(value) || base::length(value) != 1L) {
      base::stop("Open Wrangler by-example received invalid text", call. = FALSE)
    }
    if (base::is.na(value)) return(NA_character_)
    if (base::identical(base::Encoding(value), "bytes")) {
      base::stop("Open Wrangler by-example received invalid text", call. = FALSE)
    }
    from <- if (base::identical(base::Encoding(value), "latin1")) "latin1" else "UTF-8"
    normalized <- base::iconv(value, from = from, to = "UTF-8", sub = NA_character_)
    if (base::is.na(normalized)) {
      base::stop("Open Wrangler by-example received invalid text", call. = FALSE)
    }
    normalized
  }

  by_example_scalar_text <- function(value) {
    if (is.null(value)) return("None")
    if (is.logical(value)) return(if (isTRUE(value)) "True" else "False")
    if (is.character(value)) return(by_example_utf8_scalar(value))
    integer_text <- by_example_json_integer_text(value)
    if (!is.null(integer_text)) return(integer_text)
    if (is.double(value)) {
      by_example_double_text(value, python = TRUE)
    } else {
      as.character(value)
    }
  }

  by_example_decimal_digit_zeroes <- function() {
    c(
      0x0030L, 0x0660L, 0x06f0L, 0x07c0L, 0x0966L, 0x09e6L, 0x0a66L, 0x0ae6L,
      0x0b66L, 0x0be6L, 0x0c66L, 0x0ce6L, 0x0d66L, 0x0de6L, 0x0e50L, 0x0ed0L,
      0x0f20L, 0x1040L, 0x1090L, 0x17e0L, 0x1810L, 0x1946L, 0x19d0L, 0x1a80L,
      0x1a90L, 0x1b50L, 0x1bb0L, 0x1c40L, 0x1c50L, 0xa620L, 0xa8d0L, 0xa900L,
      0xa9d0L, 0xa9f0L, 0xaa50L, 0xabf0L, 0xff10L, 0x104a0L, 0x10d30L, 0x10d40L,
      0x11066L,
      0x110f0L, 0x11136L, 0x111d0L, 0x112f0L, 0x11450L, 0x114d0L, 0x11650L, 0x116c0L,
      0x116d0L, 0x116daL, 0x11730L, 0x118e0L, 0x11950L, 0x11bf0L, 0x11c50L, 0x11d50L,
      0x11da0L, 0x11f50L, 0x16130L, 0x16a60L, 0x16ac0L, 0x16b50L, 0x16d70L, 0x1ccf0L,
      0x1d7ceL, 0x1d7d8L, 0x1d7e2L, 0x1d7ecL, 0x1d7f6L, 0x1e140L, 0x1e2f0L,
      0x1e4f0L, 0x1e5f1L, 0x1e950L, 0x1fbf0L
    )
  }

  by_example_decimal_digit_pattern <- function() {
    zeroes <- by_example_decimal_digit_zeroes()
    paste0(
      "[",
      paste0(sprintf("\\x{%x}-\\x{%x}", zeroes, zeroes + 9L), collapse = ""),
      "]"
    )
  }

  by_example_decimal_digit_text <- function(value) {
    zeroes <- by_example_decimal_digit_zeroes()
    codepoints <- utf8ToInt(value)
    digits <- vapply(codepoints, function(codepoint) {
      matches <- zeroes[codepoint >= zeroes & codepoint <= zeroes + 9L]
      if (length(matches) != 1L) {
        stop("By-example datetime year contains unsupported decimal digits", call. = FALSE)
      }
      as.character(codepoint - matches[[1L]])
    }, character(1L), USE.NAMES = FALSE)
    paste0(digits, collapse = "")
  }

  by_example_datetime_parts <- function(value, format) {
    full_months <- c(
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    )
    short_months <- c("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    captures <- function(pattern) {
      matched <- regexec(paste0("(*UTF)(*UCP)", pattern), value, perl = TRUE)[[1L]]
      if (length(matched) == 1L && identical(as.integer(matched[[1L]]), -1L)) return(NULL)
      regmatches(value, list(matched))[[1L]][-1L]
    }
    decimal_digit <- by_example_decimal_digit_pattern()
    year_pattern <- paste0(decimal_digit, "{4}")
    month_pattern <- "(?:1[0-2]|0[1-9]|[1-9])"
    day_pattern <- paste0("(?:3[01]|[12]", decimal_digit, "|0[1-9]|[1-9]| [1-9])")
    whitespace_pattern <- "(?:\\s|[\\x{1c}-\\x{1f}])+"
    fields <- switch(
      format,
      "%Y-%m-%d" = list(parts = captures(paste0("^(", year_pattern, ")-(", month_pattern, ")-(", day_pattern, ")\\z")), order = c(1L, 2L, 3L)),
      "%d/%m/%Y" = list(parts = captures(paste0("^(", day_pattern, ")/(", month_pattern, ")/(", year_pattern, ")\\z")), order = c(3L, 2L, 1L)),
      "%m/%d/%Y" = list(parts = captures(paste0("^(", month_pattern, ")/(", day_pattern, ")/(", year_pattern, ")\\z")), order = c(2L, 3L, 1L)),
      "%Y/%m/%d" = list(parts = captures(paste0("^(", year_pattern, ")/(", month_pattern, ")/(", day_pattern, ")\\z")), order = c(1L, 2L, 3L)),
      "%d-%m-%Y" = list(parts = captures(paste0("^(", day_pattern, ")-(", month_pattern, ")-(", year_pattern, ")\\z")), order = c(3L, 2L, 1L)),
      "%m-%d-%Y" = list(parts = captures(paste0("^(", month_pattern, ")-(", day_pattern, ")-(", year_pattern, ")\\z")), order = c(2L, 3L, 1L)),
      "%Y%m%d" = list(parts = captures(paste0("^(", year_pattern, ")(", month_pattern, ")(", day_pattern, ")\\z")), order = c(1L, 2L, 3L)),
      "%d %B %Y" = {
        parts <- captures(paste0("^(", day_pattern, ")", whitespace_pattern, "([A-Za-z]+)", whitespace_pattern, "(", year_pattern, ")\\z"))
        if (!is.null(parts)) parts[[2L]] <- as.character(match(
          chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", parts[[2L]]),
          chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", full_months)
        ))
        list(parts = parts, order = c(3L, 2L, 1L))
      },
      "%B %d, %Y" = {
        parts <- captures(paste0("^([A-Za-z]+)", whitespace_pattern, "(", day_pattern, "),", whitespace_pattern, "(", year_pattern, ")\\z"))
        if (!is.null(parts)) parts[[1L]] <- as.character(match(
          chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", parts[[1L]]),
          chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", full_months)
        ))
        list(parts = parts, order = c(2L, 3L, 1L))
      },
      "%b %d, %Y" = {
        parts <- captures(paste0("^([A-Za-z]+)", whitespace_pattern, "(", day_pattern, "),", whitespace_pattern, "(", year_pattern, ")\\z"))
        if (!is.null(parts)) parts[[1L]] <- as.character(match(
          chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", parts[[1L]]),
          chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", short_months)
        ))
        list(parts = parts, order = c(2L, 3L, 1L))
      },
      "%Y" = list(parts = captures(paste0("^(", year_pattern, ")\\z")), order = c(1L, 0L, 0L)),
      "%m/%Y" = list(parts = captures(paste0("^(", month_pattern, ")/(", year_pattern, ")\\z")), order = c(2L, 1L, 0L)),
      NULL
    )
    if (is.null(fields) || is.null(fields$parts) || anyNA(fields$parts)) {
      stop("By-example datetime input does not match its format", call. = FALSE)
    }
    components <- c(NA_integer_, 1L, 1L)
    for (index in seq_along(fields$order)) {
      destination <- fields$order[[index]]
      if (destination != 0L) {
        text <- if (destination %in% c(1L, 3L)) {
          by_example_decimal_digit_text(if (destination == 3L) sub("^ ", "", fields$parts[[index]]) else fields$parts[[index]])
        } else {
          fields$parts[[index]]
        }
        components[[destination]] <- suppressWarnings(as.integer(text))
      }
    }
    year <- components[[1L]]
    month <- components[[2L]]
    day <- components[[3L]]
    leap <- year %% 4L == 0L && (year %% 100L != 0L || year %% 400L == 0L)
    month_days <- c(31L, if (leap) 29L else 28L, 31L, 30L, 31L, 30L, 31L, 31L, 30L, 31L, 30L, 31L)
    if (
      anyNA(c(year, month, day)) || year < 1L || year > 9999L ||
        month < 1L || month > 12L || day < 1L || day > month_days[[month]]
    ) {
      stop("By-example datetime input is outside the supported calendar", call. = FALSE)
    }
    list(year = year, month = month, day = day, fullMonths = full_months, shortMonths = short_months)
  }

  by_example_format_datetime_parts <- function(parts, format) {
    switch(
      format,
      "%Y-%m-%d" = sprintf("%04d-%02d-%02d", parts$year, parts$month, parts$day),
      "%d/%m/%Y" = sprintf("%02d/%02d/%04d", parts$day, parts$month, parts$year),
      "%m/%d/%Y" = sprintf("%02d/%02d/%04d", parts$month, parts$day, parts$year),
      "%Y/%m/%d" = sprintf("%04d/%02d/%02d", parts$year, parts$month, parts$day),
      "%d-%m-%Y" = sprintf("%02d-%02d-%04d", parts$day, parts$month, parts$year),
      "%m-%d-%Y" = sprintf("%02d-%02d-%04d", parts$month, parts$day, parts$year),
      "%Y%m%d" = sprintf("%04d%02d%02d", parts$year, parts$month, parts$day),
      "%d %B %Y" = sprintf("%02d %s %04d", parts$day, parts$fullMonths[[parts$month]], parts$year),
      "%B %d, %Y" = sprintf("%s %02d, %04d", parts$fullMonths[[parts$month]], parts$day, parts$year),
      "%b %d, %Y" = sprintf("%s %02d, %04d", parts$shortMonths[[parts$month]], parts$day, parts$year),
      "%Y" = sprintf("%04d", parts$year),
      "%m/%Y" = sprintf("%02d/%04d", parts$month, parts$year),
      stop("Unsupported by-example datetime format", call. = FALSE)
    )
  }

  by_example_normalize_integer_text <- function(value) {
    if (!is.character(value) || length(value) != 1L || is.na(value) || !grepl("^-?[0-9]+$", value, perl = TRUE)) {
      stop("Open Wrangler by-example received invalid exact integer text", call. = FALSE)
    }
    negative <- startsWith(value, "-")
    magnitude <- if (negative) substring(value, 2L) else value
    magnitude <- sub("^0+", "", magnitude, perl = TRUE)
    if (identical(magnitude, "")) magnitude <- "0"
    if (negative && !identical(magnitude, "0")) paste0("-", magnitude) else magnitude
  }

  by_example_abs_integer_compare <- function(left, right) {
    if (nchar(left) != nchar(right)) return(if (nchar(left) < nchar(right)) -1L else 1L)
    if (identical(left, right)) 0L else if (left < right) -1L else 1L
  }

  by_example_abs_integer_add <- function(left, right) {
    left_digits <- rev(utf8ToInt(left) - 48L)
    right_digits <- rev(utf8ToInt(right) - 48L)
    length_out <- max(length(left_digits), length(right_digits))
    length(left_digits) <- length_out
    length(right_digits) <- length_out
    left_digits[is.na(left_digits)] <- 0L
    right_digits[is.na(right_digits)] <- 0L
    output <- integer(length_out + 1L)
    carry <- 0L
    for (index in seq_len(length_out)) {
      total <- left_digits[[index]] + right_digits[[index]] + carry
      output[[index]] <- total %% 10L
      carry <- total %/% 10L
    }
    output[[length_out + 1L]] <- carry
    while (length(output) > 1L && output[[length(output)]] == 0L) output <- output[-length(output)]
    paste0(rev(output), collapse = "")
  }

  by_example_abs_integer_subtract <- function(left, right) {
    left_digits <- rev(utf8ToInt(left) - 48L)
    right_digits <- rev(utf8ToInt(right) - 48L)
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
    while (length(output) > 1L && output[[length(output)]] == 0L) output <- output[-length(output)]
    paste0(rev(output), collapse = "")
  }

  by_example_abs_integer_multiply <- function(left, right) {
    if (identical(left, "0") || identical(right, "0")) return("0")
    left_digits <- rev(utf8ToInt(left) - 48L)
    right_digits <- rev(utf8ToInt(right) - 48L)
    output <- integer(length(left_digits) + length(right_digits) + 1L)
    for (left_index in seq_along(left_digits)) {
      carry <- 0L
      for (right_index in seq_along(right_digits)) {
        output_index <- left_index + right_index - 1L
        total <- output[[output_index]] + left_digits[[left_index]] * right_digits[[right_index]] + carry
        output[[output_index]] <- total %% 10L
        carry <- total %/% 10L
      }
      output_index <- left_index + length(right_digits)
      while (carry > 0L) {
        total <- output[[output_index]] + carry
        output[[output_index]] <- total %% 10L
        carry <- total %/% 10L
        output_index <- output_index + 1L
      }
    }
    while (length(output) > 1L && output[[length(output)]] == 0L) output <- output[-length(output)]
    paste0(rev(output), collapse = "")
  }

  by_example_signed_integer_binary <- function(left, operator, right) {
    left <- by_example_normalize_integer_text(left)
    right <- by_example_normalize_integer_text(right)
    left_negative <- startsWith(left, "-")
    right_negative <- startsWith(right, "-")
    left_abs <- if (left_negative) substring(left, 2L) else left
    right_abs <- if (right_negative) substring(right, 2L) else right
    if (identical(operator, "subtract")) right_negative <- !right_negative && !identical(right_abs, "0")
    if (identical(operator, "multiply")) {
      magnitude <- by_example_abs_integer_multiply(left_abs, right_abs)
      negative <- xor(left_negative, startsWith(right, "-"))
      return(if (negative && !identical(magnitude, "0")) paste0("-", magnitude) else magnitude)
    }
    if (!operator %in% c("add", "subtract")) {
      stop("Open Wrangler exact by-example arithmetic received an invalid operator", call. = FALSE)
    }
    if (identical(left_negative, right_negative)) {
      magnitude <- by_example_abs_integer_add(left_abs, right_abs)
      return(if (left_negative && !identical(magnitude, "0")) paste0("-", magnitude) else magnitude)
    }
    comparison <- by_example_abs_integer_compare(left_abs, right_abs)
    if (comparison == 0L) return("0")
    if (comparison > 0L) {
      magnitude <- by_example_abs_integer_subtract(left_abs, right_abs)
      if (left_negative) paste0("-", magnitude) else magnitude
    } else {
      magnitude <- by_example_abs_integer_subtract(right_abs, left_abs)
      if (right_negative) paste0("-", magnitude) else magnitude
    }
  }

  by_example_checked_integer_text <- function(value) {
    value <- by_example_normalize_integer_text(value)
    magnitude <- if (startsWith(value, "-")) substring(value, 2L) else value
    envelope <- paste0(rep.int("9", 38L), collapse = "")
    if (
      nchar(magnitude) > 38L ||
        (nchar(magnitude) == 38L && magnitude > envelope)
    ) {
      stop("Open Wrangler by-example integer arithmetic exceeds the checked 38-digit envelope", call. = FALSE)
    }
    value
  }

  by_example_integer64_text <- function(value) {
    value <- by_example_checked_integer_text(value)
    negative <- startsWith(value, "-")
    magnitude <- if (negative) substring(value, 2L) else value
    limit <- if (negative) "9223372036854775808" else "9223372036854775807"
    if (
      nchar(magnitude) > nchar(limit) ||
        (nchar(magnitude) == nchar(limit) && magnitude > limit)
    ) {
      stop(
        "Open Wrangler exact by-example arithmetic exceeds R's signed-integer64 representation",
        call. = FALSE
      )
    }
    value
  }

  by_example_safe_integer_literal <- function(value) {
    value <- by_example_normalize_integer_text(value)
    negative <- startsWith(value, "-")
    magnitude <- if (negative) substring(value, 2L) else value
    maximum_safe <- "9007199254740991"
    if (
      nchar(magnitude) > nchar(maximum_safe) ||
        (nchar(magnitude) == nchar(maximum_safe) && magnitude > maximum_safe)
    ) return(NULL)
    numeric <- suppressWarnings(as.double(value))
    if (!is.finite(numeric) || !identical(by_example_json_integer_text(numeric), value)) return(NULL)
    if (numeric >= -.Machine$integer.max && numeric <= .Machine$integer.max) as.integer(numeric) else numeric
  }

  by_example_abs_integer_divmod <- function(numerator, denominator) {
    numerator <- by_example_normalize_integer_text(numerator)
    denominator <- by_example_normalize_integer_text(denominator)
    if (startsWith(numerator, "-") || startsWith(denominator, "-") || identical(denominator, "0")) {
      stop("Open Wrangler exact integer division received invalid magnitudes", call. = FALSE)
    }
    quotient <- character()
    remainder <- "0"
    digits <- strsplit(numerator, "", fixed = TRUE)[[1L]]
    for (digit in digits) {
      remainder <- by_example_normalize_integer_text(paste0(remainder, digit))
      quotient_digit <- 0L
      while (by_example_abs_integer_compare(remainder, denominator) >= 0L) {
        remainder <- by_example_abs_integer_subtract(remainder, denominator)
        quotient_digit <- quotient_digit + 1L
      }
      quotient <- c(quotient, as.character(quotient_digit))
    }
    list(
      quotient = by_example_normalize_integer_text(paste0(quotient, collapse = "")),
      remainder = by_example_normalize_integer_text(remainder)
    )
  }

  by_example_integer_ratio <- function(numerator, denominator) {
    numerator <- by_example_normalize_integer_text(numerator)
    denominator <- by_example_normalize_integer_text(denominator)
    if (identical(denominator, "0")) return(NULL)
    negative <- xor(startsWith(numerator, "-"), startsWith(denominator, "-"))
    numerator_abs <- if (startsWith(numerator, "-")) substring(numerator, 2L) else numerator
    denominator_abs <- if (startsWith(denominator, "-")) substring(denominator, 2L) else denominator
    divided <- by_example_abs_integer_divmod(numerator_abs, denominator_abs)
    if (!identical(divided$remainder, "0")) return(NULL)
    if (negative && !identical(divided$quotient, "0")) paste0("-", divided$quotient) else divided$quotient
  }

  by_example_slice_scalar <- function(value, start, stop = NULL) {
    characters <- strsplit(value, "", fixed = TRUE)[[1L]]
    length_value <- length(characters)
    stop_value <- if (is.null(stop)) length_value else min(stop, length_value)
    if (start >= stop_value || start >= length_value) return("")
    paste0(characters[seq.int(start + 1L, stop_value)], collapse = "")
  }

  by_example_split_part_scalar <- function(value, delimiter, index) {
    if (identical(delimiter, "")) stop("By-example split delimiter may not be empty", call. = FALSE)
    matches <- gregexpr(delimiter, value, fixed = TRUE)[[1L]]
    if (length(matches) == 1L && identical(as.integer(matches[[1L]]), -1L)) {
      if (index != 0L) return(NULL)
      if (nchar(value, type = "bytes") > 8192L) {
        stop("By-example split would produce oversized text", call. = FALSE)
      }
      return(value)
    }
    delimiter_length <- nchar(delimiter, type = "chars")
    starts <- as.integer(matches) - 1L
    if (index > length(starts)) return(NULL)
    start <- if (index == 0L) 0L else starts[[index]] + delimiter_length
    end <- if (index < length(starts)) starts[[index + 1L]] else NULL
    output_characters <- if (is.null(end)) nchar(value, type = "chars") - start else end - start
    if (!is.finite(output_characters) || output_characters > 8192L) {
      stop("By-example split would produce oversized text", call. = FALSE)
    }
    result <- by_example_slice_scalar(value, start, end)
    if (nchar(result, type = "bytes") > 8192L) {
      stop("By-example split would produce oversized text", call. = FALSE)
    }
    result
  }

  by_example_regex_extract_scalar <- function(value, pattern, group) {
    resolved_pattern <- if (identical(pattern, "(\\d+)")) {
      paste0("(*UTF)(*UCP)(", by_example_decimal_digit_pattern(), "+)")
    } else {
      paste0("(*UCP)", pattern)
    }
    matched <- regexec(resolved_pattern, value, perl = TRUE)[[1L]]
    if (length(matched) == 1L && identical(as.integer(matched[[1L]]), -1L)) return(NULL)
    target <- group + 1L
    match_lengths <- attr(matched, "match.length", exact = TRUE)
    if (target < 1L || target > length(matched) || matched[[target]] < 0L) return(NULL)
    if (match_lengths[[target]] > 8192L) {
      stop("By-example regex extraction would produce oversized text", call. = FALSE)
    }
    result <- substring(
      value,
      matched[[target]],
      matched[[target]] + match_lengths[[target]] - 1L
    )
    if (nchar(result, type = "bytes") > 8192L) {
      stop("By-example regex extraction would produce oversized text", call. = FALSE)
    }
    result
  }

  by_example_regex_replace_scalar <- function(value, pattern, replacement) {
    matched <- gregexpr(paste0("(*UCP)", pattern), value, perl = TRUE)[[1L]]
    if (length(matched) == 1L && identical(as.integer(matched[[1L]]), -1L)) return(value)
    matched_values <- regmatches(value, list(matched))[[1L]]
    projected_bytes <-
      as.double(nchar(value, type = "bytes")) -
        sum(as.double(nchar(matched_values, type = "bytes"))) +
        length(matched_values) * as.double(nchar(replacement, type = "bytes"))
    if (!is.finite(projected_bytes) || projected_bytes > 8192L) {
      stop("By-example regex replacement would produce oversized text", call. = FALSE)
    }
    copy <- value
    regmatches(copy, list(matched)) <- list(rep.int(replacement, length(matched)))
    copy
  }

  by_example_evaluate_scalar <- function(program, inputs, source_columns) {
    source_ids <- vapply(source_columns, `[[`, character(1L), "id", USE.NAMES = FALSE)
    evaluate <- function(node) {
      kind <- node$kind
      if (identical(kind, "column")) {
        position <- match(node$column$id, source_ids)
        if (is.na(position) || !identical(source_columns[[position]]$name, node$column$name)) {
          stop("By-example program references an unavailable column", call. = FALSE)
        }
        return(inputs[[position]])
      }
      if (identical(kind, "literal")) return(node$value)
      if (identical(kind, "slice")) {
        value <- evaluate(node$input)
        if (is.null(value)) return(NULL)
        return(by_example_slice_scalar(by_example_scalar_text(value), node$start, node$stop))
      }
      if (identical(kind, "split")) {
        value <- evaluate(node$input)
        if (is.null(value)) return(NULL)
        return(by_example_split_part_scalar(
          by_example_scalar_text(value),
          node$delimiter,
          node$index
        ))
      }
      if (identical(kind, "concat")) {
        values <- lapply(node$parts, evaluate)
        if (any(vapply(values, is.null, logical(1L), USE.NAMES = FALSE))) return(NULL)
        return(paste0(vapply(values, by_example_scalar_text, character(1L), USE.NAMES = FALSE), collapse = ""))
      }
      if (identical(kind, "regexExtract")) {
        value <- evaluate(node$input)
        if (is.null(value)) return(NULL)
        return(by_example_regex_extract_scalar(by_example_scalar_text(value), node$pattern, node$group))
      }
      if (identical(kind, "regexReplace")) {
        value <- evaluate(node$input)
        if (is.null(value)) return(NULL)
        return(by_example_regex_replace_scalar(by_example_scalar_text(value), node$pattern, node$replacement))
      }
      if (identical(kind, "case")) {
        value <- evaluate(node$input)
        if (is.null(value)) return(NULL)
        value <- by_example_scalar_text(value)
        if (identical(node$style, "lower")) {
          return(chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", value))
        }
        if (identical(node$style, "upper")) {
          return(chartr("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", value))
        }
        characters <- strsplit(value, "", fixed = TRUE)[[1L]]
        if (length(characters) == 0L) return("")
        return(paste0(
          chartr("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", characters[[1L]]),
          if (length(characters) == 1L) "" else chartr(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "abcdefghijklmnopqrstuvwxyz",
            paste0(characters[-1L], collapse = "")
          )
        ))
      }
      if (identical(kind, "datetimeFormat")) {
        value <- evaluate(node$input)
        if (is.null(value)) return(NULL)
        parts <- by_example_datetime_parts(by_example_scalar_text(value), node$inputFormat)
        return(by_example_format_datetime_parts(parts, node$outputFormat))
      }
      if (identical(kind, "arithmetic")) {
        left <- evaluate(node$left)
        right <- evaluate(node$right)
        if (
          is.null(left) || is.null(right) || is.logical(left) || is.logical(right) ||
            !is.numeric(left) || !is.numeric(right) || !is.finite(left) || !is.finite(right)
        ) {
          stop("By-example arithmetic inputs must be finite numbers", call. = FALSE)
        }
        left_integer <- by_example_json_integer_text(left)
        right_integer <- by_example_json_integer_text(right)
        if (!is.null(left_integer) && !is.null(right_integer) && !identical(node$operator, "divide")) {
          exact <- by_example_checked_integer_text(by_example_signed_integer_binary(
            left_integer,
            node$operator,
            right_integer
          ))
          return(structure(exact, class = "openwrangler_by_example_integer_text"))
        }
        result <- switch(
          node$operator,
          add = as.double(left) + as.double(right),
          subtract = as.double(left) - as.double(right),
          multiply = as.double(left) * as.double(right),
          divide = {
            if (right == 0) stop("By-example arithmetic cannot divide by zero", call. = FALSE)
            as.double(left) / as.double(right)
          }
        )
        if (!is.numeric(result) || length(result) != 1L || !is.finite(result)) {
          stop("By-example arithmetic overflowed", call. = FALSE)
        }
        return(result)
      }
      stop("Unsupported by-example program", call. = FALSE)
    }
    evaluate(program)
  }

  by_example_equal <- function(left, right) {
    if (inherits(left, "openwrangler_by_example_integer_text")) {
      if (inherits(right, "openwrangler_by_example_integer_text")) return(identical(unclass(left), unclass(right)))
      right_integer <- by_example_json_integer_text(right)
      if (!is.null(right_integer)) return(identical(unclass(left), right_integer))
      return(FALSE)
    }
    if (inherits(right, "openwrangler_by_example_integer_text")) return(by_example_equal(right, left))
    if (is.null(left) || is.null(right)) return(is.null(left) && is.null(right))
    if (is.logical(left) || is.logical(right)) {
      return(is.logical(left) && is.logical(right) && identical(left, right))
    }
    if (is.numeric(left) && is.numeric(right)) {
      if (
        length(left) != 1L || length(right) != 1L || !is.finite(left) || !is.finite(right)
      ) return(FALSE)
      left_integer <- by_example_json_integer_text(left)
      right_integer <- by_example_json_integer_text(right)
      if (!is.null(left_integer) && !is.null(right_integer)) {
        return(identical(left_integer, right_integer))
      }
      if (xor(is.null(left_integer), is.null(right_integer))) {
        integer_value <- if (is.null(left_integer)) as.double(right_integer) else as.double(left_integer)
        float_value <- if (is.null(left_integer)) as.double(left) else as.double(right)
        return(identical(integer_value, float_value))
      }
      return(abs(as.double(left) - as.double(right)) <= 1e-12)
    }
    is.character(left) && is.character(right) && identical(left, right)
  }

  by_example_json_string <- function(value, ensure_ascii) {
    codepoints <- utf8ToInt(enc2utf8(value))
    escaped <- vapply(codepoints, function(codepoint) {
      if (codepoint == 34L) return("\\\"")
      if (codepoint == 92L) return("\\\\")
      if (codepoint == 8L) return("\\b")
      if (codepoint == 9L) return("\\t")
      if (codepoint == 10L) return("\\n")
      if (codepoint == 12L) return("\\f")
      if (codepoint == 13L) return("\\r")
      if (codepoint < 32L || (ensure_ascii && codepoint > 126L)) {
        if (codepoint <= 65535L) return(sprintf("\\u%04x", codepoint))
        scalar <- codepoint - 65536L
        return(paste0(
          sprintf("\\u%04x", 55296L + scalar %/% 1024L),
          sprintf("\\u%04x", 56320L + scalar %% 1024L)
        ))
      }
      intToUtf8(codepoint)
    }, character(1L), USE.NAMES = FALSE)
    paste0("\"", paste0(escaped, collapse = ""), "\"")
  }

  by_example_program_key <- function(program, ensure_ascii = TRUE, compact = FALSE) {
    internalize <- function(value) {
      if (!is.list(value)) return(value)
      if (!is.null(names(value)) && identical(value$kind, "column")) {
        return(list(kind = "column", column = value$column$id))
      }
      result <- lapply(value, internalize)
      names(result) <- names(value)
      result
    }
    serialize <- function(value) {
      if (is.null(value)) return("null")
      if (is.character(value)) return(by_example_json_string(value, ensure_ascii))
      if (is.logical(value)) return(if (isTRUE(value)) "true" else "false")
      if (is.integer(value)) return(as.character(value))
      if (is.double(value)) {
        integer_text <- by_example_json_integer_text(value)
        return(if (is.null(integer_text)) by_example_double_text(value, python = TRUE) else integer_text)
      }
      if (!is.list(value)) stop("Invalid by-example candidate key value", call. = FALSE)
      if (is.null(names(value))) {
        return(paste0("[", paste0(vapply(value, serialize, character(1L)), collapse = if (compact) "," else ", "), "]"))
      }
      ordered <- order(enc2utf8(names(value)), method = "radix")
      separator <- if (compact) ":" else ": "
      fields <- vapply(ordered, function(index) {
        paste0(by_example_json_string(names(value)[[index]], ensure_ascii), separator, serialize(value[[index]]))
      }, character(1L), USE.NAMES = FALSE)
      paste0("{", paste0(fields, collapse = if (compact) "," else ", "), "}")
    }
    enc2utf8(serialize(internalize(program)))
  }

  by_example_program_matches <- function(program, examples, source_columns) {
    tryCatch(
      all(vapply(examples, function(example) {
        by_example_equal(
          by_example_evaluate_scalar(program, example$inputs, source_columns),
          example$output
        )
      }, logical(1L), USE.NAMES = FALSE)),
      error = function(error) FALSE,
      warning = function(warning) FALSE
    )
  }

  by_example_candidate_literals_are_portable <- function(program) {
    if (!is.list(program) || is.null(names(program))) return(FALSE)
    if (identical(program$kind, "literal")) return(by_example_json_scalar(program$value))
    for (key in c("input", "left", "right")) {
      if (!is.null(program[[key]]) && !by_example_candidate_literals_are_portable(program[[key]])) return(FALSE)
    }
    if (!is.null(program$parts)) {
      if (!all(vapply(program$parts, by_example_candidate_literals_are_portable, logical(1L)))) return(FALSE)
    }
    TRUE
  }

  by_example_canonicalize_candidate_literals <- function(program) {
    if (identical(program$kind, "literal")) {
      program["value"] <- list(by_example_canonical_json_scalar(program$value))
      return(program)
    }
    for (key in c("input", "left", "right")) {
      if (!is.null(program[[key]])) {
        program[[key]] <- by_example_canonicalize_candidate_literals(program[[key]])
      }
    }
    if (!is.null(program$parts)) {
      program$parts <- lapply(program$parts, by_example_canonicalize_candidate_literals)
    }
    program
  }

  by_example_python_regex_escape <- function(value) {
    characters <- strsplit(value, "", fixed = TRUE)[[1L]]
    if (length(characters) == 0L) return("")
    specials <- c("\t", "\n", "\v", "\f", "\r", " ", "#", "$", "&", "(", ")", "*", "+", "-", ".", "?", "[", "\\", "]", "^", "{", "|", "}", "~")
    paste0(vapply(characters, function(character) {
      if (character %in% specials) paste0("\\", character) else character
    }, character(1L), USE.NAMES = FALSE), collapse = "")
  }

  by_example_permutations <- function(values, length_out) {
    if (length_out == 1L) return(lapply(values, function(value) value))
    result <- list()
    for (value in values) {
      remaining <- values[values != value]
      tails <- by_example_permutations(remaining, length_out - 1L)
      for (tail in tails) result[[length(result) + 1L]] <- c(value, tail)
    }
    result
  }

  by_example_concat_literals <- function(column_indexes, example) {
    if (is.null(example$output) || any(vapply(example$inputs[column_indexes], is.null, logical(1L)))) return(NULL)
    output <- by_example_scalar_text(example$output)
    cursor <- 0L
    literals <- character()
    for (column_index in column_indexes) {
      token <- by_example_scalar_text(example$inputs[[column_index]])
      suffix <- substring(output, cursor + 1L)
      relative <- regexpr(token, suffix, fixed = TRUE)[[1L]]
      if (relative < 0L) return(NULL)
      position <- cursor + relative - 1L
      literals <- c(literals, by_example_slice_scalar(output, cursor, position))
      cursor <- position + nchar(token, type = "chars")
    }
    c(literals, by_example_slice_scalar(output, cursor, NULL))
  }

  synthesize_by_example_program <- function(source_columns, examples) {
    candidates <- list()
    candidate_indexes <- new.env(hash = TRUE, parent = emptyenv())
    add_candidate <- function(program, cost) {
      program <- by_example_canonicalize_candidate_literals(program)
      if (!by_example_candidate_literals_are_portable(program)) return(invisible(NULL))
      if (!by_example_program_matches(program, examples, source_columns)) return(invisible(NULL))
      key <- by_example_program_key(program, ensure_ascii = FALSE, compact = TRUE)
      rank_key <- by_example_program_key(program, ensure_ascii = TRUE, compact = FALSE)
      if (exists(key, envir = candidate_indexes, inherits = FALSE)) {
        index <- get(key, envir = candidate_indexes, inherits = FALSE)
        if (cost < candidates[[index]]$cost) candidates[[index]]$cost <<- cost
      } else {
        index <- length(candidates) + 1L
        candidates[[index]] <<- list(
          cost = as.integer(cost),
          program = program,
          key = key,
          rankKey = rank_key
        )
        assign(key, index, envir = candidate_indexes)
      }
      invisible(NULL)
    }
    outputs <- lapply(examples, `[[`, "output")
    if (all(vapply(outputs[-1L], function(value) by_example_equal(value, outputs[[1L]]), logical(1L)))) {
      add_candidate(list(kind = "literal", value = outputs[[1L]]), 1L)
    }

    for (column_index in seq_along(source_columns)) {
      reference <- source_columns[[column_index]]
      direct <- list(kind = "column", column = reference)
      add_candidate(direct, 1L)
      for (style in c("lower", "upper", "capitalize")) {
        add_candidate(list(kind = "case", style = style, input = direct), 2L)
      }

      first_input <- examples[[1L]]$inputs[[column_index]]
      if (!is.null(first_input)) {
        value <- by_example_scalar_text(first_input)
        value <- by_example_slice_scalar(value, 0L, min(nchar(value, type = "chars"), maximum_by_example_slice_source_characters))
        output <- by_example_scalar_text(examples[[1L]]$output)
        value_length <- nchar(value, type = "chars")
        for (start in 0:value_length) {
          for (stop in start:value_length) {
            if (identical(by_example_slice_scalar(value, start, stop), output)) {
              add_candidate(
                list(kind = "slice", input = direct, start = as.integer(start), stop = as.integer(stop)),
                2L
              )
            }
          }
        }
      }

      for (delimiter in by_example_delimiters) {
        for (index in 0:3) {
          add_candidate(
            list(kind = "split", input = direct, delimiter = delimiter, index = as.integer(index)),
            2L
          )
        }
      }
      for (pattern in by_example_regex_patterns) {
        add_candidate(list(kind = "regexExtract", input = direct, pattern = pattern, group = 1L), 3L)
      }

      replacements <- lapply(examples, function(example) {
        before_value <- example$inputs[[column_index]]
        after_value <- example$output
        if (is.null(before_value) || is.null(after_value)) return(NULL)
        before <- strsplit(by_example_scalar_text(before_value), "", fixed = TRUE)[[1L]]
        after <- strsplit(by_example_scalar_text(after_value), "", fixed = TRUE)[[1L]]
        prefix <- 0L
        while (prefix < min(length(before), length(after)) && identical(before[[prefix + 1L]], after[[prefix + 1L]])) {
          prefix <- prefix + 1L
        }
        suffix <- 0L
        while (
          suffix < min(length(before) - prefix, length(after) - prefix) &&
            identical(before[[length(before) - suffix]], after[[length(after) - suffix]])
        ) {
          suffix <- suffix + 1L
        }
        before_end <- length(before) - suffix
        after_end <- length(after) - suffix
        find <- if (prefix >= before_end) "" else paste0(before[seq.int(prefix + 1L, before_end)], collapse = "")
        replacement <- if (prefix >= after_end) "" else paste0(after[seq.int(prefix + 1L, after_end)], collapse = "")
        list(find = find, replacement = replacement)
      })
      if (
        length(replacements) > 0L && !any(vapply(replacements, is.null, logical(1L))) &&
          all(vapply(replacements[-1L], identical, logical(1L), replacements[[1L]])) &&
          !identical(replacements[[1L]]$find, "")
      ) {
        add_candidate(list(
          kind = "regexReplace",
          input = direct,
          pattern = by_example_python_regex_escape(replacements[[1L]]$find),
          replacement = replacements[[1L]]$replacement
        ), 3L)
      }

      for (input_format in by_example_date_formats) {
        for (output_format in by_example_date_formats[by_example_date_formats != input_format]) {
          add_candidate(list(
            kind = "datetimeFormat",
            input = direct,
            inputFormat = input_format,
            outputFormat = output_format
          ), 3L)
        }
      }

      first_output <- examples[[1L]]$output
      if (
        !is.null(first_input) && !is.logical(first_input) && is.numeric(first_input) && is.finite(first_input) &&
          !is.null(first_output) && !is.logical(first_output) && is.numeric(first_output) && is.finite(first_output)
      ) {
        literal <- function(value) list(kind = "literal", value = value)
        arithmetic <- function(operator, right) list(kind = "arithmetic", left = direct, operator = operator, right = right)
        numeric_delta <- function(left, right) {
          left_integer <- by_example_json_integer_text(left)
          right_integer <- by_example_json_integer_text(right)
          if (!is.null(left_integer) && !is.null(right_integer)) {
            return(by_example_safe_integer_literal(by_example_signed_integer_binary(
              left_integer,
              "subtract",
              right_integer
            )))
          }
          result <- as.double(left) - as.double(right)
          if (is.finite(result)) result else NULL
        }
        add_delta <- numeric_delta(first_output, first_input)
        subtract_delta <- numeric_delta(first_input, first_output)
        if (!is.null(add_delta)) add_candidate(arithmetic("add", literal(add_delta)), 2L)
        if (!is.null(subtract_delta)) add_candidate(arithmetic("subtract", literal(subtract_delta)), 2L)
        if (first_input != 0) {
          output_integer <- by_example_json_integer_text(first_output)
          input_integer <- by_example_json_integer_text(first_input)
          exact_ratio <- if (!is.null(output_integer) && !is.null(input_integer)) {
            by_example_integer_ratio(output_integer, input_integer)
          } else NULL
          ratio <- if (!is.null(exact_ratio)) {
            by_example_safe_integer_literal(exact_ratio)
          } else {
            as.double(first_output) / as.double(first_input)
          }
          if (!is.null(ratio) && is.numeric(ratio) && is.finite(ratio)) {
            add_candidate(arithmetic("multiply", literal(ratio)), 2L)
          }
        }
        if (first_output != 0) {
          input_integer <- by_example_json_integer_text(first_input)
          output_integer <- by_example_json_integer_text(first_output)
          exact_ratio <- if (!is.null(input_integer) && !is.null(output_integer)) {
            by_example_integer_ratio(input_integer, output_integer)
          } else NULL
          ratio <- if (!is.null(exact_ratio)) {
            by_example_safe_integer_literal(exact_ratio)
          } else {
            as.double(first_input) / as.double(first_output)
          }
          if (!is.null(ratio) && is.numeric(ratio) && is.finite(ratio)) {
            add_candidate(arithmetic("divide", literal(ratio)), 2L)
          }
        }
      }
    }

    if (length(source_columns) >= 2L) {
      for (indexes in by_example_permutations(seq_along(source_columns), 2L)) {
        left <- list(kind = "column", column = source_columns[[indexes[[1L]]]])
        right <- list(kind = "column", column = source_columns[[indexes[[2L]]]])
        for (operator in c("add", "subtract", "multiply", "divide")) {
          add_candidate(list(kind = "arithmetic", left = left, operator = operator, right = right), 2L)
        }
      }
    }

    for (length_out in c(2L, 3L)) {
      if (length(source_columns) < length_out) next
      for (indexes in by_example_permutations(seq_along(source_columns), length_out)) {
        literal_sets <- lapply(examples, function(example) by_example_concat_literals(indexes, example))
        if (
          length(literal_sets) == 0L || is.null(literal_sets[[1L]]) ||
            any(vapply(literal_sets[-1L], function(value) !identical(value, literal_sets[[1L]]), logical(1L)))
        ) next
        literals <- literal_sets[[1L]]
        parts <- list()
        for (index in seq_along(indexes)) {
          if (!identical(literals[[index]], "")) {
            parts[[length(parts) + 1L]] <- list(kind = "literal", value = literals[[index]])
          }
          parts[[length(parts) + 1L]] <- list(kind = "column", column = source_columns[[indexes[[index]]]])
        }
        if (!identical(literals[[length(literals)]], "")) {
          parts[[length(parts) + 1L]] <- list(kind = "literal", value = literals[[length(literals)]])
        }
        add_candidate(list(kind = "concat", parts = parts), 1L + length(parts))
      }
    }

    if (length(candidates) == 0L) {
      abort(
        "invalid_request",
        paste0(
          "No deterministic slicing, splitting, concatenation, literal, regex, casing, datetime, ",
          "or arithmetic program satisfies every example. Add or correct examples."
        )
      )
    }
    costs <- vapply(candidates, `[[`, integer(1L), "cost", USE.NAMES = FALSE)
    keys <- vapply(candidates, `[[`, character(1L), "rankKey", USE.NAMES = FALSE)
    ranked <- order(costs, keys, method = "radix")
    selected <- candidates[[ranked[[1L]]]]
    equally_simple <- sum(costs == selected$cost)
    warnings <- list()
    if (equally_simple > 1L) {
      warnings <- list(sprintf(
        "Ambiguous examples: %d equally simple programs match. Preview the selected result carefully.",
        equally_simple
      ))
    } else if (length(candidates) > 1L) {
      warnings <- list(sprintf(
        "%d programs match; Open Wrangler selected the simplest deterministic program.",
        length(candidates)
      ))
    }
    list(program = selected$program, warnings = warnings, candidateCount = as.integer(length(candidates)))
  }

  decode_by_example_params <- function(value, step_id, limits) {
    params <- exact_record(
      value,
      c("sourceColumns", "newColumn", "examples"),
      "request.payload.step.params",
      optional_fields = c("program", "warnings", "candidateCount")
    )
    source_columns <- params$sourceColumns
    if (
      !is.list(source_columns) || is.object(source_columns) || !is.null(names(source_columns)) ||
        length(source_columns) < 1L || length(source_columns) > maximum_by_example_sources
    ) {
      abort(
        "invalid_request",
        sprintf(
          "request.payload.step.params.sourceColumns must contain between 1 and %d column references",
          maximum_by_example_sources
        )
      )
    }
    source_columns <- lapply(seq_along(source_columns), function(index) {
      decode_column_reference(
        source_columns[[index]],
        sprintf("request.payload.step.params.sourceColumns[%d]", index),
        limits$columnIdBytes
      )
    })
    source_ids <- vapply(source_columns, `[[`, character(1L), "id", USE.NAMES = FALSE)
    if (anyDuplicated(source_ids)) {
      abort("invalid_request", "request.payload.step.params.sourceColumns contains a repeated column identity")
    }
    new_column <- bounded_text(
      params$newColumn,
      "request.payload.step.params.newColumn",
      maximum_variable_name_bytes
    )
    if (identical(new_column, "")) {
      abort("invalid_request", "request.payload.step.params.newColumn may not be empty")
    }

    raw_examples <- params$examples
    if (
      !is.list(raw_examples) || is.object(raw_examples) || !is.null(names(raw_examples)) ||
        length(raw_examples) < 2L || length(raw_examples) > maximum_by_example_examples
    ) {
      abort(
        "invalid_request",
        sprintf(
          "request.payload.step.params.examples must contain between 2 and %d examples",
          maximum_by_example_examples
        )
      )
    }
    examples <- lapply(seq_along(raw_examples), function(index) {
      example <- exact_record(
        raw_examples[[index]],
        c("inputs", "output"),
        sprintf("request.payload.step.params.examples[%d]", index)
      )
      inputs <- example$inputs
      if (
        !is.list(inputs) || is.object(inputs) || !is.null(names(inputs)) ||
          length(inputs) != length(source_columns)
      ) {
        abort(
          "invalid_request",
          sprintf(
            "request.payload.step.params.examples[%d].inputs must align with every source column",
            index
          )
        )
      }
      if (
        any(!vapply(inputs, by_example_json_scalar, logical(1L), USE.NAMES = FALSE)) ||
          !by_example_json_scalar(example$output)
      ) {
        abort("invalid_request", "By-example inputs and outputs must be finite JSON scalar values")
      }
      list(inputs = inputs, output = example$output)
    })

    if ("warnings" %in% names(params)) {
      warnings <- params$warnings
      if (
        !is.list(warnings) || is.object(warnings) || !is.null(names(warnings)) ||
          length(warnings) > maximum_by_example_warnings ||
          any(!vapply(warnings, function(item) {
            is.character(item) && length(item) == 1L && !is.na(item)
          }, logical(1L), USE.NAMES = FALSE))
      ) {
        abort(
          "invalid_request",
          sprintf("request.payload.step.params.warnings must contain at most %d strings", maximum_by_example_warnings)
        )
      }
      warnings <- vapply(seq_along(warnings), function(index) {
        bounded_text(
          warnings[[index]],
          sprintf("request.payload.step.params.warnings[%d]", index),
          maximum_by_example_string_bytes
        )
      }, character(1L), USE.NAMES = FALSE)
    }
    if ("candidateCount" %in% names(params)) {
      candidate_count <- params$candidateCount
      if (
        length(candidate_count) != 1L || !is.numeric(candidate_count) || is.na(candidate_count) ||
          !is.finite(candidate_count) || candidate_count < 1 || candidate_count > 9007199254740991 ||
          candidate_count != floor(candidate_count)
      ) {
        abort("invalid_request", "request.payload.step.params.candidateCount must be positive")
      }
    }

    saved_program <- if ("program" %in% names(params)) {
      decode_by_example_program(params$program, source_columns, limits)
    } else {
      NULL
    }
    validate_by_example_text_budget(params)
    synthesized <- synthesize_by_example_program(source_columns, examples)
    if (!is.null(saved_program) && (
      !identical(saved_program, synthesized$program) ||
        !by_example_program_matches(saved_program, examples, source_columns)
    )) {
      abort(
        "invalid_request",
        "The saved by-example program is not the deterministic program selected for these examples"
      )
    }
    normalized <- list(
      sourceColumns = source_columns,
      newColumn = new_column,
      examples = examples,
      program = synthesized$program,
      warnings = synthesized$warnings,
      candidateCount = synthesized$candidateCount
    )
    validate_by_example_text_budget(normalized)
    list(
      id = step_id,
      kind = "byExample",
      params = normalized,
      outputId = bounded_text(
        paste0("c:step:", step_id, ":0"),
        "the derived R by-example column identity",
        limits$columnIdBytes
      )
    )
  }

  decode_transform_step <- function(value, limits) {
    step <- exact_record(value, c("id", "kind", "params"), "request.payload.step")
    step_id <- bounded_text(step$id, "request.payload.step.id", maximum_step_id_bytes)
    if (identical(step_id, "")) abort("invalid_request", "request.payload.step.id may not be empty")
    kind <- bounded_text(step$kind, "request.payload.step.kind", 64L)
    if (identical(kind, "customCode")) {
      recoverable_decode <- function(expression) tryCatch(
        expression,
        openwrangler_r_kernel_error = function(error) {
          if (!identical(error$code, "invalid_request")) stop(error)
          abort("invalid_request", conditionMessage(error), TRUE)
        }
      )
      params <- recoverable_decode(
        exact_record(step$params, "code", "request.payload.step.params")
      )
      code <- recoverable_decode(bounded_text(
        params$code,
        "request.payload.step.params.code",
        maximum_custom_code_bytes
      ))
      if (any(as.integer(charToRaw(code)) == 0L)) {
        abort("invalid_request", "Native R Custom Code cannot contain U+0000", TRUE)
      }
      parsed <- tryCatch(
        parse(text = code, keep.source = FALSE),
        error = function(error) {
          abort(
            "invalid_request",
            paste0(
              "Native R Custom Code could not be parsed: ",
              diagnostic_message(error, "invalid R syntax")
            ),
            TRUE
          )
        }
      )
      if (length(parsed) == 0L) {
        abort(
          "invalid_request",
          "Native R Custom Code must contain an executable expression, not only whitespace or comments",
          TRUE
        )
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(code = code),
        parsed = parsed
      ))
    }
    if (identical(kind, "byExample")) {
      return(decode_by_example_params(step$params, step_id, limits))
    }
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
          logic = if ("logic" %in% names(decoded)) decoded$logic else "and",
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
    if (identical(kind, "oneHotEncode")) {
      params <- exact_record(
        step$params,
        "columns",
        "request.payload.step.params",
        optional_fields = c("prefixSeparator", "dropOriginal")
      )
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
      prefix_separator <- if ("prefixSeparator" %in% names(params)) {
        bounded_text(
          params$prefixSeparator,
          "request.payload.step.params.prefixSeparator",
          limits$textBytes
        )
      } else {
        "_"
      }
      drop_original <- if ("dropOriginal" %in% names(params)) params$dropOriginal else TRUE
      if (!is.logical(drop_original) || length(drop_original) != 1L || is.na(drop_original)) {
        abort("invalid_request", "request.payload.step.params.dropOriginal must be true or false")
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(
          columns = columns,
          prefixSeparator = prefix_separator,
          dropOriginal = drop_original
        )
      ))
    }
    if (identical(kind, "multiLabelBinarize")) {
      params <- exact_record(
        step$params,
        c("column", "delimiter"),
        "request.payload.step.params",
        optional_fields = c("prefix", "dropOriginal")
      )
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      delimiter <- bounded_text(
        params$delimiter,
        "request.payload.step.params.delimiter",
        limits$textBytes
      )
      if (identical(delimiter, "")) {
        abort("invalid_request", "request.payload.step.params.delimiter must be a non-empty string")
      }
      prefix <- if ("prefix" %in% names(params)) {
        bounded_text(params$prefix, "request.payload.step.params.prefix", limits$textBytes)
      } else {
        paste0(column$name, "_")
      }
      drop_original <- if ("dropOriginal" %in% names(params)) params$dropOriginal else FALSE
      if (!is.logical(drop_original) || length(drop_original) != 1L || is.na(drop_original)) {
        abort("invalid_request", "request.payload.step.params.dropOriginal must be true or false")
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(
          column = column,
          delimiter = delimiter,
          prefix = prefix,
          dropOriginal = drop_original
        )
      ))
    }
    if (identical(kind, "formula")) {
      params <- exact_record(
        step$params,
        c("leftColumn", "operator", "newColumn"),
        "request.payload.step.params",
        optional_fields = c("rightColumn", "value")
      )
      has_right_column <- "rightColumn" %in% names(params)
      has_value <- "value" %in% names(params)
      if (identical(has_right_column, has_value)) {
        abort("invalid_request", "request.payload.step.params requires exactly one rightColumn or value")
      }
      operator <- bounded_text(params$operator, "request.payload.step.params.operator", 16L)
      if (!operator %in% c("add", "subtract", "multiply", "divide", "modulo", "power")) {
        abort("invalid_request", "request.payload.step.params.operator is unsupported")
      }
      new_column <- bounded_text(
        params$newColumn,
        "request.payload.step.params.newColumn",
        maximum_variable_name_bytes
      )
      if (identical(new_column, "")) {
        abort("invalid_request", "request.payload.step.params.newColumn may not be empty")
      }
      value_operand <- NULL
      right_column <- NULL
      if (has_right_column) {
        right_column <- decode_column_reference(
          params$rightColumn,
          "request.payload.step.params.rightColumn",
          limits$columnIdBytes
        )
      } else {
        value_operand <- params$value
        if (
          length(value_operand) != 1L ||
            !is.numeric(value_operand) ||
            is.na(value_operand) ||
            !is.finite(value_operand)
        ) {
          abort("invalid_request", "request.payload.step.params.value must be finite")
        }
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(
          leftColumn = decode_column_reference(
            params$leftColumn,
            "request.payload.step.params.leftColumn",
            limits$columnIdBytes
          ),
          operator = operator,
          newColumn = new_column,
          rightColumn = right_column,
          value = value_operand
        ),
        outputId = bounded_text(
          paste0("c:step:", step_id, ":0"),
          "the derived R formula column identity",
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
    if (kind %in% c("minMaxScale", "roundNumber", "floorNumber", "ceilNumber")) {
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
    if (identical(kind, "formatDatetime")) {
      params <- exact_record(
        step$params,
        c("column", "format"),
        "request.payload.step.params",
        optional_fields = "newColumn"
      )
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      format <- bounded_text(params$format, "request.payload.step.params.format", 8192L)
      if (identical(format, "")) {
        abort("invalid_request", "request.payload.step.params.format may not be empty")
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
        params = list(column = column, format = format, newColumn = new_column),
        outputId = if (in_place) {
          column$id
        } else {
          bounded_text(
            paste0("c:step:", step_id, ":0"),
            "the derived R formatted-datetime column identity",
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
    if (identical(kind, "groupBy")) {
      params <- exact_record(step$params, c("keys", "aggregations"), "request.payload.step.params")
      keys <- params$keys
      if (
        !is.list(keys) ||
          is.object(keys) ||
          !is.null(names(keys)) ||
          length(keys) == 0L ||
          length(keys) > limits$columns
      ) {
        abort("invalid_request", "request.payload.step.params.keys must be a bounded non-empty array")
      }
      keys <- lapply(seq_along(keys), function(index) {
        decode_column_reference(
          keys[[index]],
          sprintf("request.payload.step.params.keys[%d]", index),
          limits$columnIdBytes
        )
      })
      key_ids <- vapply(keys, `[[`, character(1L), "id", USE.NAMES = FALSE)
      if (anyDuplicated(key_ids)) {
        abort("invalid_request", "request.payload.step.params.keys contains a repeated column identity")
      }
      aggregations <- params$aggregations
      if (
        !is.list(aggregations) ||
          is.object(aggregations) ||
          !is.null(names(aggregations)) ||
          length(aggregations) == 0L ||
          length(keys) + length(aggregations) > limits$columns
      ) {
        abort("invalid_request", "request.payload.step.params.aggregations exceeds the output-column limit")
      }
      aggregations <- lapply(seq_along(aggregations), function(index) {
        aggregation <- exact_record(
          aggregations[[index]],
          c("column", "operation", "alias"),
          sprintf("request.payload.step.params.aggregations[%d]", index)
        )
        operation <- bounded_text(
          aggregation$operation,
          sprintf("request.payload.step.params.aggregations[%d].operation", index),
          16L
        )
        if (!operation %in% c("sum", "mean", "min", "max", "median", "count", "nUnique", "first", "last")) {
          abort("invalid_request", "request.payload.step.params.aggregations contains an unsupported operation")
        }
        alias <- bounded_text(
          aggregation$alias,
          sprintf("request.payload.step.params.aggregations[%d].alias", index),
          maximum_variable_name_bytes
        )
        if (identical(alias, "")) {
          abort("invalid_request", "request.payload.step.params.aggregations aliases may not be empty")
        }
        list(
          column = decode_column_reference(
            aggregation$column,
            sprintf("request.payload.step.params.aggregations[%d].column", index),
            limits$columnIdBytes
          ),
          operation = operation,
          alias = alias,
          outputId = bounded_text(
            paste0("c:step:", step_id, ":", index - 1L),
            sprintf("the derived R group aggregation identity %d", index),
            limits$columnIdBytes
          )
        )
      })
      aliases <- vapply(aggregations, `[[`, character(1L), "alias", USE.NAMES = FALSE)
      key_names <- vapply(keys, `[[`, character(1L), "name", USE.NAMES = FALSE)
      if (anyDuplicated(aliases) || any(aliases %in% key_names)) {
        abort("invalid_request", "group aggregation aliases must be unique and cannot duplicate a key name")
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(keys = keys, aggregations = aggregations)
      ))
    }
    if (!kind %in% c(
      "renameColumn",
      "cloneColumn",
      "dropColumns",
      "selectColumns",
      "formula",
      "textLength",
      "oneHotEncode",
      "multiLabelBinarize",
      "lowerText",
      "upperText",
      "capitalizeText",
      "stripText",
      "splitText",
      "findReplace",
      "minMaxScale",
      "roundNumber",
      "floorNumber",
      "ceilNumber",
      "formatDatetime",
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
    schema <- unclass(capture$descriptor$schema)
    attributes(schema) <- NULL
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

  bind_formula_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    resolve_operand <- function(reference, label) {
      matches <- which(vapply(schema, function(column) identical(column$id, reference$id), logical(1L)))
      if (
        length(matches) != 1L ||
          !identical(schema[[matches[[1L]]]]$name, reference$name)
      ) {
        abort("stale_column", sprintf("The %s formula column no longer matches the active R dataframe", label), TRUE)
      }
      position <- as.integer(matches[[1L]])
      column <- schema[[position]]
      if (!column$semantics$kind %in% c("integer", "double", "integer64")) {
        abort("invalid_request", "Formula requires an R integer, double, or integer64 column", TRUE)
      }
      list(position = position, name = column$name, id = column$id, semanticKind = column$semantics$kind)
    }
    left <- resolve_operand(step$params$leftColumn, "left")
    right <- if (is.null(step$params$rightColumn)) NULL else resolve_operand(step$params$rightColumn, "right")
    names <- vapply(schema, `[[`, character(1L), "name", USE.NAMES = FALSE)
    ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    if (step$params$newColumn %in% names || step$outputId %in% ids) {
      abort("invalid_request", "The Formula output column already exists", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      left = left,
      right = right,
      value = step$params$value,
      operator = step$params$operator,
      newName = step$params$newColumn,
      outputId = step$outputId
    )
  }

  bind_datetime_format_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The datetime-format column no longer matches the active R dataframe", TRUE)
    }
    position <- as.integer(matches[[1L]])
    column <- schema[[position]]
    if (!column$semantics$kind %in% c("date", "datetime")) {
      abort("invalid_request", "Format Datetime requires an R Date or POSIXct column", TRUE)
    }
    in_place <- is.null(step$params$newColumn) || identical(step$params$newColumn, column$name)
    key_column_ids <- capture$descriptor$frameSemantics$keyColumnIds
    if (is.null(key_column_ids)) key_column_ids <- character()
    if (in_place && column$id %in% key_column_ids) {
      abort("invalid_request", "Format Datetime cannot replace a data.table key column", TRUE)
    }
    new_name <- if (in_place) column$name else step$params$newColumn
    names <- vapply(schema, `[[`, character(1L), "name", USE.NAMES = FALSE)
    ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    if (!in_place && (new_name %in% names || step$outputId %in% ids)) {
      abort("invalid_request", "The Format Datetime output column already exists", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      position = position,
      oldName = column$name,
      newName = new_name,
      inPlace = in_place,
      outputId = step$outputId,
      semanticKind = column$semantics$kind,
      timezone = column$semantics$timezone,
      format = step$params$format
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

  bind_categorical_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    schema_ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    references <- if (identical(step$kind, "oneHotEncode")) {
      step$params$columns
    } else {
      list(step$params$column)
    }
    columns <- lapply(seq_along(references), function(index) {
      reference <- references[[index]]
      matches <- which(schema_ids == reference$id)
      if (length(matches) != 1L || !identical(schema[[matches[[1L]]]]$name, reference$name)) {
        abort("stale_column", "A categorical column reference no longer matches the active R dataframe", TRUE)
      }
      position <- as.integer(matches[[1L]])
      column <- schema[[position]]
      if (
        identical(step$kind, "multiLabelBinarize") &&
          !column$semantics$kind %in% c("character", "factor")
      ) {
        abort("invalid_request", "Multi-label binarization requires an R character or factor column", TRUE)
      }
      list(
        id = column$id,
        position = position,
        name = column$name,
        semanticsKind = column$semantics$kind,
        storageMode = column$semantics$storageMode,
        classes = column$semantics$classes,
        timezone = column$semantics$timezone,
        units = column$semantics$units
      )
    })
    bound <- list(
      id = step$id,
      kind = step$kind,
      columns = columns,
      dropOriginal = isTRUE(step$params$dropOriginal),
      generatedNames = character(),
      removedNames = if (isTRUE(step$params$dropOriginal)) {
        selected_positions <- vapply(columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
        vapply(columns[base::order(selected_positions)], `[[`, character(1L), "name", USE.NAMES = FALSE)
      } else {
        character()
      }
    )
    if (identical(step$kind, "oneHotEncode")) {
      bound$prefixSeparator <- step$params$prefixSeparator
    } else {
      bound$delimiter <- step$params$delimiter
      bound$prefix <- step$params$prefix
    }
    bound
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

  bind_group_by_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    schema_ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    supported_scalar_kinds <- c(
      "character", "factor", "integer", "integer64", "double", "logical", "date", "datetime", "difftime"
    )
    bind_reference <- function(reference, label) {
      matches <- which(schema_ids == reference$id)
      if (length(matches) != 1L || !identical(schema[[matches[[1L]]]]$name, reference$name)) {
        abort("stale_column", sprintf("The %s reference no longer matches the active R dataframe", label), TRUE)
      }
      position <- as.integer(matches[[1L]])
      column <- schema[[position]]
      if (!column$semantics$kind %in% supported_scalar_kinds) {
        abort(
          "invalid_request",
          sprintf("R %s columns cannot be used by Group By", column$semantics$kind),
          TRUE
        )
      }
      list(
        id = column$id,
        position = position,
        name = column$name,
        semanticsKind = column$semantics$kind,
        ordered = isTRUE(column$semantics$ordered),
        units = column$semantics$units
      )
    }
    keys <- lapply(step$params$keys, bind_reference, label = "group key")
    key_ids <- vapply(keys, `[[`, character(1L), "id", USE.NAMES = FALSE)
    if (length(keys) == 0L || anyDuplicated(key_ids)) {
      abort("invalid_request", "Group By requires unique key columns", TRUE)
    }
    aggregations <- lapply(seq_along(step$params$aggregations), function(index) {
      aggregation <- step$params$aggregations[[index]]
      column <- bind_reference(aggregation$column, "group aggregation")
      if (
        aggregation$operation %in% c("sum", "mean", "median") &&
          !column$semanticsKind %in% c("integer", "integer64", "double")
      ) {
        abort(
          "invalid_request",
          sprintf("R %s columns do not support the %s aggregation", column$semanticsKind, aggregation$operation),
          TRUE
        )
      }
      c(
        column,
        list(
          operation = aggregation$operation,
          alias = aggregation$alias,
          outputId = aggregation$outputId
        )
      )
    })
    aliases <- vapply(aggregations, `[[`, character(1L), "alias", USE.NAMES = FALSE)
    key_names <- vapply(keys, `[[`, character(1L), "name", USE.NAMES = FALSE)
    if (
      length(aggregations) == 0L ||
        anyDuplicated(aliases) ||
        any(aliases %in% key_names)
    ) {
      abort("invalid_request", "Group By output columns must be bounded and uniquely named", TRUE)
    }
    key_positions <- vapply(keys, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    removed_names <- vapply(
      schema[setdiff(seq_along(schema), key_positions)],
      `[[`,
      character(1L),
      "name",
      USE.NAMES = FALSE
    )
    list(
      id = step$id,
      kind = step$kind,
      keys = keys,
      aggregations = aggregations,
      removedNames = removed_names
    )
  }

  bind_by_example_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    schema_ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    source_columns <- lapply(seq_along(step$params$sourceColumns), function(index) {
      reference <- step$params$sourceColumns[[index]]
      matches <- which(schema_ids == reference$id)
      if (length(matches) != 1L || !identical(schema[[matches[[1L]]]]$name, reference$name)) {
        abort("stale_column", "A by-example source column no longer matches the active R dataframe", TRUE)
      }
      position <- as.integer(matches[[1L]])
      semantic_kind <- schema[[position]]$semantics$kind
      if (!semantic_kind %in% c(
        "character",
        "factor",
        "integer",
        "integer64",
        "double",
        "logical",
        "date",
        "datetime",
        "difftime"
      )) {
        abort(
          "invalid_request",
          sprintf("By-example source column %s is not a portable scalar R column", reference$name),
          TRUE
        )
      }
      list(
        id = reference$id,
        name = reference$name,
        position = position,
        semanticKind = semantic_kind,
        resultKind = semantic_kind
      )
    })
    selected_ids <- vapply(source_columns, `[[`, character(1L), "id", USE.NAMES = FALSE)

    bind_expression <- function(program, label) {
      kind <- program$kind
      if (identical(kind, "column")) {
        selected_index <- match(program$column$id, selected_ids)
        if (
          is.na(selected_index) ||
            !identical(source_columns[[selected_index]]$name, program$column$name)
        ) {
          abort("stale_column", "By-example program references a stale or unselected R column", TRUE)
        }
        source <- source_columns[[selected_index]]
        return(list(
          program = list(
            kind = kind,
            column = program$column,
            `_owSourceIndex` = as.integer(selected_index),
            `_owSourceKind` = source$semanticKind,
            `_owResultType` = source$resultKind
          ),
          type = source$resultKind
        ))
      }
      if (identical(kind, "literal")) {
        type <- if (is.null(program$value)) {
          "null"
        } else if (is.character(program$value)) {
          "character"
        } else if (is.logical(program$value)) {
          "logical"
        } else {
          integer_text <- by_example_json_integer_text(program$value)
          if (is.null(integer_text)) {
            "double"
          } else if (
            program$value >= -.Machine$integer.max && program$value <= .Machine$integer.max
          ) {
            "integer"
          } else {
            "integer64"
          }
        }
        return(list(
          program = list(kind = kind, value = program$value, `_owResultType` = type),
          type = type
        ))
      }
      if (kind %in% c("slice", "split", "regexExtract", "regexReplace", "case", "datetimeFormat")) {
        child <- bind_expression(program$input, paste0(label, ".input"))
        if (!child$type %in% c("character", "factor", "integer", "integer64", "date", "null")) {
          abort(
            "invalid_request",
            sprintf("%s cannot apply %s to a non-portable text input", label, kind),
            TRUE
          )
        }
        result <- program
        result$input <- child$program
        result$`_owResultType` <- "character"
        return(list(program = result, type = "character"))
      }
      if (identical(kind, "concat")) {
        parts <- lapply(seq_along(program$parts), function(index) {
          bind_expression(program$parts[[index]], sprintf("%s.parts[%d]", label, index))
        })
        if (any(!vapply(parts, `[[`, character(1L), "type") %in% c("character", "factor", "integer", "integer64", "date"))) {
          abort("invalid_request", "By-example concat accepts only portable non-null text inputs", TRUE)
        }
        result <- program
        result$parts <- lapply(parts, `[[`, "program")
        result$`_owResultType` <- "character"
        return(list(program = result, type = "character"))
      }
      if (identical(kind, "arithmetic")) {
        left <- bind_expression(program$left, paste0(label, ".left"))
        right <- bind_expression(program$right, paste0(label, ".right"))
        if (
          !left$type %in% c("integer", "integer64", "double") ||
            !right$type %in% c("integer", "integer64", "double")
        ) {
          abort("invalid_request", "By-example arithmetic accepts only integer or floating-point inputs", TRUE)
        }
        result_type <- if (
          identical(program$operator, "divide") || "double" %in% c(left$type, right$type)
        ) "double" else "integer64"
        result <- program
        result$left <- left$program
        result$right <- right$program
        result$`_owLeftType` <- left$type
        result$`_owRightType` <- right$type
        result$`_owResultType` <- result_type
        return(list(program = result, type = result_type))
      }
      abort("runtime_error", sprintf("Unsupported bound by-example node at %s", label))
    }

    bound_program <- bind_expression(step$params$program, "byExample.program")
    result_kind <- if (identical(bound_program$type, "null")) "logical" else bound_program$type
    existing_names <- vapply(schema, `[[`, character(1L), "name", USE.NAMES = FALSE)
    if (step$params$newColumn %in% existing_names || step$outputId %in% schema_ids) {
      abort("invalid_request", "The by-example output column already exists", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      sourceColumns = source_columns,
      newName = step$params$newColumn,
      outputId = step$outputId,
      program = bound_program$program,
      resultKind = result_kind
    )
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

  generated_by_example_evaluate <- function(program, columns) {
    storage_length <- function(value) base::length(base::unclass(value))
    if (!base::is.list(columns) || base::length(columns) < 1L || base::length(columns) > 16L) {
      base::stop("Open Wrangler by-example received invalid source columns", call. = FALSE)
    }
    row_count <- storage_length(columns[[1L]])
    if (base::any(base::vapply(columns, storage_length, integer(1L), USE.NAMES = FALSE) != row_count)) {
      base::stop("Open Wrangler by-example source columns have different lengths", call. = FALSE)
    }
    bound_result_kind <- program$`_owResultType`
    result_kind <- if (base::identical(bound_result_kind, "null")) "logical" else bound_result_kind
    if (!base::is.character(result_kind) || base::length(result_kind) != 1L || !result_kind %in% c(
      "character", "factor", "integer", "integer64", "double", "logical", "date", "datetime", "difftime"
    )) {
      base::stop(base::sprintf(
        "Open Wrangler by-example has an invalid bound result kind (%s; value %s; length %d; class %s)",
        base::typeof(result_kind),
        base::paste(base::encodeString(result_kind, quote = "\""), collapse = ","),
        base::length(result_kind),
        base::paste(base::class(result_kind), collapse = ",")
      ), call. = FALSE)
    }
    result_slot_bytes <- if (result_kind %in% c("logical", "integer", "factor")) 4 else 8
    projected_slot_bytes <- base::as.double(row_count) * result_slot_bytes
    if (!base::is.finite(projected_slot_bytes) || projected_slot_bytes > 67108864) {
      base::stop("Open Wrangler by-example exceeds its aggregate output budget", call. = FALSE)
    }

    validate_source <- function(value, kind) {
      valid <- switch(
        kind,
        character = base::is.character(value) && !base::is.object(value),
        factor = base::is.factor(value),
        integer = base::is.integer(value) && !base::is.object(value),
        integer64 = base::identical(base::class(value), "integer64"),
        double = base::is.double(value) && !base::is.object(value),
        logical = base::is.logical(value) && !base::is.object(value),
        date = base::identical(base::class(value), "Date"),
        datetime = base::identical(base::class(value), c("POSIXct", "POSIXt")),
        difftime = base::identical(base::class(value), "difftime"),
        FALSE
      )
      if (!base::isTRUE(valid)) {
        base::stop("Open Wrangler by-example source type changed after binding", call. = FALSE)
      }
      value
    }

    integer64_tools <- base::local({
      cached <- NULL
      function() {
        if (!base::is.null(cached)) return(cached)
        if (!base::requireNamespace("bit64", quietly = TRUE)) {
          base::stop("bit64 is required for integer64 by-example evaluation", call. = FALSE)
        }
        namespace <- base::asNamespace("bit64")
        dlls <- base::getNamespaceInfo(namespace, "DLLs")
        routines <- base::getNamespaceInfo(namespace, "nativeRoutines")
        if (!base::is.list(dlls) || base::length(dlls) != 1L || !base::is.list(routines) || base::length(routines) != 1L) {
          base::stop("bit64 has invalid by-example native registration metadata", call. = FALSE)
        }
        dll <- dlls[[1L]]
        routine_map <- routines[[1L]]
        dll_fields <- base::unclass(dll)
        if (
          !base::inherits(dll, "DLLInfo") ||
            !base::identical(base::.subset2(dll_fields, "name"), "bit64") ||
            !base::identical(base::.subset2(dll_fields, "dynamicLookup"), FALSE) ||
            !base::identical(base::.subset2(dll_fields, "forceSymbols"), TRUE) ||
            !base::is.character(routine_map) || base::is.null(base::names(routine_map))
        ) {
          base::stop("bit64 has invalid by-example native registration metadata", call. = FALSE)
        }
        native <- function(binding_name, native_name) {
          if (
            !base::exists(binding_name, envir = namespace, inherits = FALSE) ||
              base::bindingIsActive(binding_name, namespace) ||
              !base::bindingIsLocked(binding_name, namespace)
          ) {
            base::stop("bit64 has unavailable or mutable by-example primitives", call. = FALSE)
          }
          registered <- base::get(binding_name, envir = namespace, inherits = FALSE)
          canonical <- base::tryCatch(
            base::getNativeSymbolInfo(
              native_name,
              PACKAGE = base::.subset2(dll_fields, "info"),
              withRegistrationInfo = FALSE
            ),
            error = function(error) NULL
          )
          registered_fields <- base::unclass(registered)
          canonical_fields <- if (base::is.null(canonical)) NULL else base::unclass(canonical)
          if (
            !base::identical(base::.subset2(routine_map, binding_name), native_name) ||
              !base::identical(base::class(registered), c("CallRoutine", "NativeSymbolInfo")) ||
              !base::identical(base::.subset2(registered_fields, "name"), native_name) ||
              !base::identical(base::.subset2(registered_fields, "numParameters"), 2L) ||
              !base::identical(base::.subset2(registered_fields, "dll"), dll) ||
              !base::inherits(base::.subset2(registered_fields, "address"), "RegisteredNativeSymbol") ||
              base::is.null(canonical) ||
              !base::identical(base::class(canonical), c("CallRoutine", "NativeSymbolInfo")) ||
              !base::identical(base::.subset2(canonical_fields, "name"), native_name) ||
              !base::identical(base::.subset2(canonical_fields, "numParameters"), 2L) ||
              !base::identical(base::.subset2(canonical_fields, "dll"), dll) ||
              !base::inherits(base::.subset2(canonical_fields, "address"), "NativeSymbol")
          ) {
            base::stop("bit64 has invalid by-example primitives", call. = FALSE)
          }
          canonical
        }
        cached <<- base::list(
          toCharacter = native("C_as_character_integer64", "as_character_integer64"),
          toDouble = native("C_as_double_integer64", "as_double_integer64"),
          fromCharacter = native("C_as_integer64_character", "as_integer64_character"),
          isMissing = native("C_isna_integer64", "isna_integer64")
        )
        cached
      }
    })
    integer64_missing <- function(value) {
      tools <- integer64_tools()
      result <- base::.Call(tools$isMissing, value, base::logical(storage_length(value)))
      if (!base::is.logical(result) || base::length(result) != storage_length(value) || base::anyNA(result)) {
        base::stop("bit64 returned an invalid by-example missing-value mask", call. = FALSE)
      }
      result
    }
    integer64_character <- function(value) {
      tools <- integer64_tools()
      result <- base::.Call(tools$toCharacter, value, base::character(storage_length(value)))
      if (!base::is.character(result) || base::length(result) != storage_length(value)) {
        base::stop("bit64 returned invalid by-example integer text", call. = FALSE)
      }
      result
    }
    integer64_from_character <- function(value) {
      tools <- integer64_tools()
      result <- base::.Call(tools$fromCharacter, value, base::double(base::length(value)))
      base::attributes(result) <- list(class = "integer64")
      if (
        !base::identical(base::class(result), "integer64") ||
          base::length(result) != base::length(value) ||
          !base::identical(integer64_missing(result), base::is.na(value))
      ) {
        base::stop("bit64 could not represent an exact by-example integer", call. = FALSE)
      }
      result
    }
    factor_character <- function(value) {
      levels <- base::unclass(base::attr(value, "levels", exact = TRUE))
      codes <- base::unclass(value)
      result <- base::rep.int(NA_character_, storage_length(value))
      present <- !base::is.na(codes)
      if (base::any(present)) {
        result[present] <- base::.subset(levels, base::.subset(codes, present))
      }
      result
    }
    normalize_text <- function(value) {
      base::vapply(base::seq_len(storage_length(value)), function(index) {
        by_example_utf8_scalar(base::.subset2(value, index))
      }, base::character(1L), USE.NAMES = FALSE)
    }
    as_text <- function(value, kind) {
      if (base::identical(kind, "null")) return(base::rep.int(NA_character_, row_count))
      if (base::identical(kind, "factor")) return(normalize_text(factor_character(value)))
      if (base::identical(kind, "character")) return(normalize_text(value))
      if (base::identical(kind, "integer")) return(base::as.character(value))
      if (base::identical(kind, "integer64")) return(integer64_character(value))
      if (base::identical(kind, "date")) return(base::format.Date(value, format = "%Y-%m-%d"))
      base::stop("Open Wrangler by-example received a non-portable text input", call. = FALSE)
    }
    expand_literal <- function(value, kind) {
      if (base::identical(kind, "null")) return(base::rep.int(NA, row_count))
      if (base::identical(kind, "character")) return(base::rep.int(value, row_count))
      if (base::identical(kind, "logical")) return(base::rep.int(value, row_count))
      if (base::identical(kind, "integer")) return(base::rep.int(base::as.integer(value), row_count))
      if (base::identical(kind, "integer64")) {
        integer_text <- by_example_json_integer_text(value)
        if (base::is.null(integer_text)) {
          base::stop("Open Wrangler by-example integer64 literal is not an exact safe integer", call. = FALSE)
        }
        return(integer64_from_character(base::rep.int(integer_text, row_count)))
      }
      if (base::identical(kind, "double")) return(base::rep.int(base::as.double(value), row_count))
      base::stop("Open Wrangler by-example literal has an invalid type", call. = FALSE)
    }
    map_text <- function(value, transform) {
      base::vapply(base::seq_len(row_count), function(index) {
        item <- value[[index]]
        if (base::is.na(item)) return(NA_character_)
        transformed <- transform(item)
        if (base::is.null(transformed)) NA_character_ else transformed
      }, character(1L), USE.NAMES = FALSE)
    }
    integer64_to_double <- function(value) {
      tools <- integer64_tools()
      missing <- integer64_missing(value)
      result <- base::suppressWarnings(base::.Call(
        tools$toDouble,
        value,
        base::double(storage_length(value))
      ))
      if (base::any(!missing & !base::is.finite(result))) {
        base::stop("Open Wrangler by-example cannot convert integer64 to finite double", call. = FALSE)
      }
      result
    }
    integer_text_operand <- function(value, kind) {
      if (base::identical(kind, "integer")) return(base::as.character(value))
      if (base::identical(kind, "integer64")) return(integer64_character(value))
      base::stop("Open Wrangler exact by-example arithmetic received a non-integer operand", call. = FALSE)
    }
    double_operand <- function(value, kind) {
      if (base::identical(kind, "integer64")) return(integer64_to_double(value))
      if (!kind %in% c("integer", "double")) {
        base::stop("Open Wrangler by-example arithmetic received a non-numeric operand", call. = FALSE)
      }
      base::as.double(value)
    }

    validate_text_result <- function(value) {
      present <- !base::is.na(value)
      if (base::any(present)) {
        converted <- base::vapply(base::which(present), function(index) {
          by_example_utf8_scalar(base::.subset2(value, index))
        }, base::character(1L), USE.NAMES = FALSE)
        value[present] <- converted
        bytes <- base::nchar(converted, type = "bytes")
        if (base::anyNA(bytes) || base::any(bytes > 8192L)) {
          base::stop("Open Wrangler by-example produced oversized or invalid text", call. = FALSE)
        }
        total <- base::sum(base::as.double(bytes)) + base::as.double(base::length(value)) * 8
      } else {
        total <- base::as.double(base::length(value)) * 8
      }
      if (!base::is.finite(total) || total > 67108864) {
        base::stop("Open Wrangler by-example exceeds its aggregate output budget", call. = FALSE)
      }
      base::list(value = value, bytes = total)
    }

    source_chunk <- function(source, indexes) {
      source_attributes <- base::attributes(source)
      source_names <- if (base::is.null(source_attributes)) {
        NULL
      } else {
        base::.subset2(source_attributes, "names")
      }
      chunk <- base::.subset(base::unclass(source), indexes)
      if (!base::is.null(source_attributes)) {
        if (!base::is.null(source_names)) {
          source_attributes$names <- base::.subset(source_names, indexes)
        }
        base::attributes(chunk) <- source_attributes
      }
      chunk
    }

    if (row_count > 1024L && !base::identical(program$kind, "column")) {
      starts <- base::seq.int(1L, row_count, by = 1024L)
      chunks <- base::vector("list", base::length(starts))
      total_text_bytes <- 0
      for (chunk_index in base::seq_along(starts)) {
        start <- starts[[chunk_index]]
        stop <- base::min(row_count, start + 1023L)
        indexes <- base::seq.int(start, stop)
        chunk_columns <- base::lapply(columns, source_chunk, indexes = indexes)
        chunk <- base::Recall(program, chunk_columns)
        if (base::identical(result_kind, "character")) {
          validated_chunk <- validate_text_result(chunk)
          chunk <- validated_chunk$value
          total_text_bytes <- total_text_bytes + validated_chunk$bytes
          if (!base::is.finite(total_text_bytes) || total_text_bytes > 67108864) {
            base::stop("Open Wrangler by-example exceeds its aggregate output budget", call. = FALSE)
          }
        }
        chunks[[chunk_index]] <- chunk
      }
      chunk_names <- base::lapply(chunks, function(chunk) base::attr(chunk, "names", exact = TRUE))
      retain_names <- base::all(base::vapply(
        base::seq_along(chunks),
        function(index) !base::is.null(chunk_names[[index]]) && base::length(chunk_names[[index]]) == storage_length(chunks[[index]]),
        logical(1L),
        USE.NAMES = FALSE
      ))
      combined_names <- if (retain_names) base::unlist(chunk_names, recursive = FALSE, use.names = FALSE) else NULL
      if (base::identical(result_kind, "integer64")) {
        result <- base::unlist(base::lapply(chunks, base::unclass), recursive = FALSE, use.names = FALSE)
        base::attributes(result) <- if (base::is.null(combined_names)) {
          base::list(class = "integer64")
        } else {
          base::list(class = "integer64", names = combined_names)
        }
      } else {
        result <- base::unlist(chunks, recursive = FALSE, use.names = FALSE)
        if (!base::is.null(combined_names)) base::attr(result, "names") <- combined_names
      }
      if (storage_length(result) != row_count) {
        base::stop("Open Wrangler by-example evaluator returned the wrong row count", call. = FALSE)
      }
      return(result)
    }

    evaluate <- function(node) {
      kind <- node$kind
      if (base::identical(kind, "column")) {
        source_index <- node$`_owSourceIndex`
        if (
          !base::is.integer(source_index) || base::length(source_index) != 1L ||
            base::is.na(source_index) || source_index < 1L || source_index > base::length(columns)
        ) {
          base::stop("Open Wrangler by-example bound column index is invalid", call. = FALSE)
        }
        return(validate_source(columns[[source_index]], node$`_owSourceKind`))
      }
      if (base::identical(kind, "literal")) {
        return(expand_literal(node$value, node$`_owResultType`))
      }
      if (base::identical(kind, "slice")) {
        child <- evaluate(node$input)
        text <- as_text(child, node$input$`_owResultType`)
        return(map_text(text, function(value) by_example_slice_scalar(value, node$start, node$stop)))
      }
      if (base::identical(kind, "split")) {
        child <- evaluate(node$input)
        text <- as_text(child, node$input$`_owResultType`)
        return(map_text(text, function(value) {
          by_example_split_part_scalar(value, node$delimiter, node$index)
        }))
      }
      if (base::identical(kind, "concat")) {
        values <- base::lapply(node$parts, function(part) as_text(evaluate(part), part$`_owResultType`))
        return(base::vapply(base::seq_len(row_count), function(index) {
          row <- base::vapply(values, `[[`, character(1L), index, USE.NAMES = FALSE)
          if (base::anyNA(row)) return(NA_character_)
          projected <- base::sum(base::as.double(base::nchar(row, type = "bytes")))
          if (!base::is.finite(projected) || projected > 8192L) {
            base::stop("Open Wrangler by-example concat would produce oversized text", call. = FALSE)
          }
          base::paste0(row, collapse = "")
        }, character(1L), USE.NAMES = FALSE))
      }
      if (base::identical(kind, "regexExtract")) {
        child <- evaluate(node$input)
        text <- as_text(child, node$input$`_owResultType`)
        return(map_text(text, function(value) {
          by_example_regex_extract_scalar(value, node$pattern, node$group)
        }))
      }
      if (base::identical(kind, "regexReplace")) {
        child <- evaluate(node$input)
        text <- as_text(child, node$input$`_owResultType`)
        return(map_text(text, function(value) {
          by_example_regex_replace_scalar(value, node$pattern, node$replacement)
        }))
      }
      if (base::identical(kind, "case")) {
        child <- evaluate(node$input)
        text <- as_text(child, node$input$`_owResultType`)
        return(map_text(text, function(value) {
          if (base::nchar(value, type = "bytes") > 8192L) {
            base::stop("Open Wrangler by-example case conversion would produce oversized text", call. = FALSE)
          }
          if (base::identical(node$style, "lower")) {
            return(base::chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", value))
          }
          if (base::identical(node$style, "upper")) {
            return(base::chartr("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", value))
          }
          characters <- base::strsplit(value, "", fixed = TRUE)[[1L]]
          if (base::length(characters) == 0L) return("")
          base::paste0(
            base::chartr("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", characters[[1L]]),
            if (base::length(characters) == 1L) "" else base::chartr(
              "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
              "abcdefghijklmnopqrstuvwxyz",
              base::paste0(characters[-1L], collapse = "")
            )
          )
        }))
      }
      if (base::identical(kind, "datetimeFormat")) {
        child <- evaluate(node$input)
        text <- as_text(child, node$input$`_owResultType`)
        return(map_text(text, function(value) {
          base::tryCatch(
            {
              parts <- by_example_datetime_parts(value, node$inputFormat)
              by_example_format_datetime_parts(parts, node$outputFormat)
            },
            error = function(error) NULL
          )
        }))
      }
      if (base::identical(kind, "arithmetic")) {
        left <- evaluate(node$left)
        right <- evaluate(node$right)
        left_type <- node$`_owLeftType`
        right_type <- node$`_owRightType`
        if (base::identical(node$`_owResultType`, "integer64")) {
          left_text <- integer_text_operand(left, left_type)
          right_text <- integer_text_operand(right, right_type)
          input_missing <- base::is.na(left_text) | base::is.na(right_text)
          result_text <- base::vapply(base::seq_len(row_count), function(index) {
            if (input_missing[[index]]) return(NA_character_)
            by_example_integer64_text(by_example_signed_integer_binary(
              left_text[[index]],
              node$operator,
              right_text[[index]]
            ))
          }, character(1L), USE.NAMES = FALSE)
          result <- integer64_from_character(result_text)
          if (
            !base::identical(base::class(result), "integer64") || storage_length(result) != row_count ||
              base::any(integer64_missing(result) & !input_missing)
          ) {
            base::stop("Open Wrangler exact by-example arithmetic returned an invalid result", call. = FALSE)
          }
          return(result)
        }
        left <- double_operand(left, left_type)
        right <- double_operand(right, right_type)
        left_missing <- base::is.na(left) & !base::is.nan(left)
        right_missing <- base::is.na(right) & !base::is.nan(right)
        result <- base::suppressWarnings(switch(
          node$operator,
          add = left + right,
          subtract = left - right,
          multiply = left * right,
          divide = left / right,
          base::stop("Open Wrangler by-example arithmetic received an invalid operator", call. = FALSE)
        ))
        input_missing <- left_missing | right_missing
        if (!base::is.double(result) || base::length(result) != row_count) {
          base::stop("Open Wrangler by-example arithmetic returned an invalid result", call. = FALSE)
        }
        result[input_missing] <- NA_real_
        return(result)
      }
      base::stop("Open Wrangler generated R received an unsupported by-example program", call. = FALSE)
    }
    result <- evaluate(program)
    if (storage_length(result) != row_count) {
      base::stop("Open Wrangler by-example evaluator returned the wrong row count", call. = FALSE)
    }
    if (base::identical(result_kind, "character")) result <- validate_text_result(result)$value
    result
  }

  evaluate_custom_code <- function(
    frame_contract,
    capture,
    step,
    source_environment,
    variable_name
  ) {
    input <- frame_contract$isolate_custom_code_input(capture)
    shield_environment <- new.env(parent = source_environment)
    assign(variable_name, input, envir = shield_environment, inherits = FALSE)
    lockBinding(variable_name, shield_environment)
    if (!identical(variable_name, "result")) {
      assign("result", NULL, envir = shield_environment, inherits = FALSE)
      lockBinding("result", shield_environment)
    }
    evaluation_environment <- new.env(parent = shield_environment)
    assign(
      "df",
      input,
      envir = evaluation_environment,
      inherits = FALSE
    )

    discard <- file(nullfile(), open = "wt")
    output_depth <- sink.number(type = "output")
    message_depth <- sink.number(type = "message")
    on.exit({
      while (sink.number(type = "message") > message_depth) sink(type = "message")
      while (sink.number(type = "output") > output_depth) sink(type = "output")
      close(discard)
    }, add = TRUE)
    sink(discard, type = "output")
    sink(discard, type = "message")
    tryCatch(
      withCallingHandlers(
        eval(step$parsed, envir = evaluation_environment),
        warning = function(condition) invokeRestart("muffleWarning"),
        message = function(condition) invokeRestart("muffleMessage")
      ),
      error = function(error) {
        abort(
          "invalid_request",
          paste0(
            "Native R Custom Code failed: ",
            diagnostic_message(error, "the R expression could not be evaluated")
          ),
          TRUE
        )
      }
    )
    if (!exists("result", envir = evaluation_environment, inherits = FALSE) ||
      bindingIsActive("result", evaluation_environment)) {
      abort(
        "invalid_request",
        "Native R Custom Code must assign a non-active local result binding",
        TRUE
      )
    }
    value <- get("result", envir = evaluation_environment, inherits = FALSE)
    result <- tryCatch(
      frame_contract$capture_custom_code_result(value, capture, step$id),
      openwrangler_r_frame_error = function(error) {
        if (identical(error$code, "internal-error") || identical(error$code, "missing-package")) {
          stop(error)
        }
        abort(
          "invalid_request",
          paste0("Native R Custom Code returned invalid output: ", conditionMessage(error)),
          TRUE
        )
      }
    )
    list(
      capture = result,
      bound = list(id = step$id, kind = step$kind, params = list(code = step$params$code))
    )
  }

  apply_step <- function(frame_contract, capture, step, source_environment, variable_name) {
    source <- get("snapshot", envir = capture, inherits = FALSE)
    if (identical(step$kind, "customCode")) {
      return(evaluate_custom_code(
        frame_contract,
        capture,
        step,
        source_environment,
        variable_name
      ))
    }
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
    if (identical(step$kind, "groupBy")) {
      bound <- bind_group_by_step(capture, step)
      key_positions <- vapply(bound$keys, `[[`, integer(1L), "position", USE.NAMES = FALSE)
      aggregation_positions <- vapply(
        bound$aggregations,
        `[[`,
        integer(1L),
        "position",
        USE.NAMES = FALSE
      )
      operations <- vapply(bound$aggregations, `[[`, character(1L), "operation", USE.NAMES = FALSE)
      result <- frame_contract$group_by_at(
        source,
        key_positions,
        vapply(bound$keys, `[[`, character(1L), "name", USE.NAMES = FALSE),
        aggregation_positions,
        vapply(bound$aggregations, `[[`, character(1L), "name", USE.NAMES = FALSE),
        operations,
        vapply(bound$aggregations, `[[`, character(1L), "alias", USE.NAMES = FALSE)
      )
      output_ids <- c(
        vapply(bound$keys, `[[`, character(1L), "id", USE.NAMES = FALSE),
        vapply(bound$aggregations, `[[`, character(1L), "outputId", USE.NAMES = FALSE)
      )
      return(list(
        capture = frame_contract$capture_group_result(
          result,
          capture,
          key_positions,
          aggregation_positions,
          operations,
          output_ids
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
      capture_schema <- unclass(capture$descriptor$schema)
      attributes(capture_schema) <- NULL
      source_positions <- c(seq_along(capture_schema), bound$position)
      output_ids <- c(
        vapply(capture_schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
        bound$outputId
      )
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = source_positions,
          output_ids = output_ids,
          preserve_data_table_element_names = TRUE
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "byExample")) {
      bound <- bind_by_example_step(capture, step)
      positions <- vapply(bound$sourceColumns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
      expected_names <- vapply(bound$sourceColumns, `[[`, character(1L), "name", USE.NAMES = FALSE)
      result <- frame_contract$by_example_column_at(
        source,
        positions,
        expected_names,
        bound$newName,
        bound$resultKind,
        function(columns) generated_by_example_evaluate(bound$program, columns)
      )
      source_positions <- c(seq_along(capture$descriptor$schema), positions[[1L]])
      output_ids <- c(
        vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
        bound$outputId
      )
      output_position <- length(output_ids)
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = source_positions,
          output_ids = output_ids,
          by_example_positions = output_position,
          by_example_kinds = bound$resultKind
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "formula")) {
      bound <- bind_formula_step(capture, step)
      result <- frame_contract$formula_column_at(
        source,
        bound$left$position,
        bound$left$name,
        bound$operator,
        bound$newName,
        if (is.null(bound$right)) NULL else bound$right$position,
        if (is.null(bound$right)) NULL else bound$right$name,
        bound$value
      )
      source_positions <- c(seq_along(capture$descriptor$schema), bound$left$position)
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
          formula_positions = length(output_ids),
          formula_right_source_positions = if (is.null(bound$right)) 0L else bound$right$position
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
    if (step$kind %in% c("oneHotEncode", "multiLabelBinarize")) {
      bound <- bind_categorical_step(capture, step)
      result <- if (identical(step$kind, "oneHotEncode")) {
        frame_contract$one_hot_encode_columns_at(
          source,
          vapply(bound$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE),
          vapply(bound$columns, `[[`, character(1L), "name", USE.NAMES = FALSE),
          bound$prefixSeparator,
          bound$dropOriginal
        )
      } else {
        frame_contract$multi_label_binarize_column_at(
          source,
          bound$columns[[1L]]$position,
          bound$columns[[1L]]$name,
          bound$delimiter,
          bound$prefix,
          bound$dropOriginal
        )
      }
      if (
        !is.environment(result) ||
          !inherits(result, "openwrangler_r_categorical_result") ||
          !is.data.frame(result$value) ||
          length(unclass(result$value)) == 0L ||
          !is.numeric(result$sourcePositions) ||
          anyNA(result$sourcePositions) ||
          any(!is.finite(result$sourcePositions)) ||
          any(result$sourcePositions != floor(result$sourcePositions)) ||
          length(result$sourcePositions) != length(unclass(result$value)) ||
          any(result$sourcePositions < 1L) ||
          any(result$sourcePositions > length(capture$descriptor$schema)) ||
          !is.numeric(result$categoricalPositions) ||
          anyNA(result$categoricalPositions) ||
          any(!is.finite(result$categoricalPositions)) ||
          any(result$categoricalPositions != floor(result$categoricalPositions)) ||
          any(result$categoricalPositions < 1L) ||
          any(result$categoricalPositions > length(result$sourcePositions)) ||
          anyDuplicated(result$categoricalPositions) ||
          !is.character(result$generatedNames) ||
          anyNA(result$generatedNames) ||
          length(result$generatedNames) != length(result$categoricalPositions)
      ) {
        abort("runtime_error", "The R categorical transform returned invalid output metadata")
      }
      if (length(result$categoricalPositions) == 0L || length(result$generatedNames) == 0L) {
        abort("invalid_request", "R categorical encoding must generate at least one column")
      }
      categorical_positions <- as.integer(result$categoricalPositions)
      source_positions <- as.integer(result$sourcePositions)
      generated_names <- vapply(seq_along(result$generatedNames), function(index) {
        bounded_text(
          result$generatedNames[[index]],
          sprintf("the generated R categorical column name %d", index),
          frame_contract$limits$nameBytes
        )
      }, character(1L), USE.NAMES = FALSE)
      if (
        any(generated_names == "") ||
          anyDuplicated(generated_names) ||
          !identical(attr(result$value, "names", exact = TRUE)[categorical_positions], generated_names)
      ) {
        abort("runtime_error", "The R categorical transform returned inconsistent output names")
      }
      source_ids <- vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
      output_ids <- source_ids[source_positions]
      if (length(categorical_positions) > 0L) {
        output_ids[categorical_positions] <- vapply(seq_along(categorical_positions), function(index) {
          bounded_text(
            paste0("c:step:", step$id, ":", index - 1L),
            sprintf("the derived R categorical column identity %d", index),
            frame_contract$limits$columnIdBytes
          )
        }, character(1L), USE.NAMES = FALSE)
      }
      bound$generatedNames <- generated_names
      bound$sourcePositions <- source_positions
      bound$categoricalPositions <- categorical_positions
      bound$outputIds <- output_ids
      return(list(
        capture = frame_contract$capture_categorical_result(result, capture, output_ids),
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
    if (step$kind %in% c("minMaxScale", "roundNumber", "floorNumber", "ceilNumber")) {
      bound <- bind_numeric_transform_step(capture, step)
      new_name <- if (isTRUE(bound$inPlace)) NULL else bound$newName
      result <- switch(
        step$kind,
        minMaxScale = frame_contract$min_max_scale_column_at(
          source,
          bound$position,
          bound$oldName,
          new_name
        ),
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
          numeric_transform_positions = if (identical(step$kind, "minMaxScale")) NULL else transform_position,
          min_max_scale_positions = if (identical(step$kind, "minMaxScale")) transform_position else NULL
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "formatDatetime")) {
      bound <- bind_datetime_format_step(capture, step)
      result <- frame_contract$format_datetime_column_at(
        source,
        bound$position,
        bound$oldName,
        bound$format,
        if (isTRUE(bound$inPlace)) NULL else bound$newName
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
          datetime_format_positions = transform_position
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

  replay_plan <- function(frame_contract, original, plan, source_environment, variable_name) {
    capture <- original
    bound_plan <- vector("list", length(plan))
    if (length(plan) != 0L) {
      for (index in seq_along(plan)) {
        applied <- apply_step(
          frame_contract,
          capture,
          plan[[index]],
          source_environment,
          variable_name
        )
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

  r_number <- function(value) {
    if (is.integer(value)) return(sprintf("%dL", value))
    sprintf(
      "as.double(%s)",
      r_string(format(value, digits = 17L, scientific = TRUE, trim = TRUE, decimal.mark = "."))
    )
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

  exact_formula_datetime_type_guard <- function(variable, specification) {
    semantic_kind <- specification$semanticKind
    if (is.null(semantic_kind)) semantic_kind <- specification$semanticsKind
    expected <- switch(
      semantic_kind,
      integer = list(type = "integer", classes = "integer", attributes = character()),
      double = list(type = "double", classes = "numeric", attributes = character()),
      integer64 = list(type = "double", classes = "integer64", attributes = "class"),
      date = list(type = "double", classes = "Date", attributes = "class"),
      datetime = list(type = "double", classes = c("POSIXct", "POSIXt"), attributes = NULL),
      abort("runtime_error", "Generated R code received an unsupported Formula or Format Datetime type")
    )
    c(
      sprintf(
        "  if (!identical(typeof(%s), %s) || !identical(class(%s), %s)) stop(\"Open Wrangler column type is stale\", call. = FALSE)",
        variable,
        r_string(expected$type),
        variable,
        r_character_vector(expected$classes)
      ),
      sprintf("  .ow_exact_attributes <- attributes(%s)", variable),
      "  .ow_exact_attribute_names <- if (is.null(names(.ow_exact_attributes))) character() else names(.ow_exact_attributes)",
      "  if (anyNA(.ow_exact_attribute_names) || any(.ow_exact_attribute_names == \"\") || base::anyDuplicated.default(.ow_exact_attribute_names)) stop(\"Open Wrangler column attributes are stale\", call. = FALSE)",
      sprintf(
        "  if (\"names\" %%in%% .ow_exact_attribute_names) { .ow_exact_column_names <- attr(%s, \"names\", exact = TRUE); if (!is.character(.ow_exact_column_names) || is.object(.ow_exact_column_names) || !is.null(attributes(.ow_exact_column_names)) || length(.ow_exact_column_names) != .ow_storage_length(%s)) stop(\"Open Wrangler column attributes are stale\", call. = FALSE) }",
        variable,
        variable
      ),
      "  .ow_exact_attribute_names <- base::sort.int(.ow_exact_attribute_names[.ow_exact_attribute_names != \"names\"], method = \"radix\")",
      if (identical(semantic_kind, "datetime")) {
        "  if (!identical(.ow_exact_attribute_names, \"class\") && !identical(.ow_exact_attribute_names, c(\"class\", \"tzone\"))) stop(\"Open Wrangler column attributes are stale\", call. = FALSE)"
      } else {
        sprintf(
          "  if (!identical(.ow_exact_attribute_names, %s)) stop(\"Open Wrangler column attributes are stale\", call. = FALSE)",
          r_character_vector(sort(expected$attributes))
        )
      }
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

  min_max_scale_code_helper_lines <- function() {
    c(
      "  .ow_min_max_scale <- function(.ow_values) {",
      "    if (inherits(.ow_values, \"integer64\")) {",
      "      if (!requireNamespace(\"bit64\", quietly = TRUE)) stop(\"bit64 is required to scale an integer64 column\", call. = FALSE)",
      "      .ow_present <- !is.na(.ow_values)",
      "      .ow_scaled <- rep.int(NA_real_, length(.ow_values))",
      "      if (!any(.ow_present)) return(.ow_scaled)",
      "      .ow_present_values <- .ow_values[.ow_present]",
      "      .ow_minimum <- min(.ow_present_values)",
      "      .ow_maximum <- max(.ow_present_values)",
      "      if (isTRUE(.ow_minimum == .ow_maximum)) {",
      "        .ow_scaled[.ow_present] <- 0",
      "        return(.ow_scaled)",
      "      }",
      "      .ow_limb_base_double <- 4294967296",
      "      .ow_limb_base <- bit64::as.integer64(\"4294967296\")",
      "      .ow_quotients <- .ow_present_values %/% .ow_limb_base",
      "      .ow_remainders <- .ow_present_values %% .ow_limb_base",
      "      .ow_minimum_quotient <- .ow_minimum %/% .ow_limb_base",
      "      .ow_minimum_remainder <- .ow_minimum %% .ow_limb_base",
      "      .ow_maximum_quotient <- .ow_maximum %/% .ow_limb_base",
      "      .ow_maximum_remainder <- .ow_maximum %% .ow_limb_base",
      "      .ow_deltas <- (as.double(.ow_quotients) - as.double(.ow_minimum_quotient)) * .ow_limb_base_double + (as.double(.ow_remainders) - as.double(.ow_minimum_remainder))",
      "      .ow_span <- (as.double(.ow_maximum_quotient) - as.double(.ow_minimum_quotient)) * .ow_limb_base_double + (as.double(.ow_maximum_remainder) - as.double(.ow_minimum_remainder))",
      "      if (!is.finite(.ow_span) || .ow_span <= 0) stop(\"Open Wrangler integer64 min-max scaling produced an invalid range\", call. = FALSE)",
      "      .ow_present_scaled <- pmin(1, pmax(0, .ow_deltas / .ow_span))",
      "      .ow_present_scaled[.ow_present_values == .ow_minimum] <- 0",
      "      .ow_present_scaled[.ow_present_values == .ow_maximum] <- 1",
      "      .ow_scaled[.ow_present] <- .ow_present_scaled",
      "      return(.ow_scaled)",
      "    }",
      "    .ow_numeric_input <- suppressWarnings(as.double(.ow_values))",
      "    .ow_numeric_finite <- is.finite(.ow_numeric_input)",
      "    .ow_scaled <- rep.int(NA_real_, length(.ow_numeric_input))",
      "    if (!any(.ow_numeric_finite)) return(.ow_scaled)",
      "    .ow_numeric_present <- .ow_numeric_input[.ow_numeric_finite]",
      "    .ow_numeric_minimum <- min(.ow_numeric_present)",
      "    .ow_numeric_maximum <- max(.ow_numeric_present)",
      "    if (.ow_numeric_maximum == .ow_numeric_minimum) {",
      "      .ow_scaled[.ow_numeric_finite] <- 0",
      "    } else {",
      "      .ow_scaled[.ow_numeric_finite] <- (.ow_numeric_present - .ow_numeric_minimum) / (.ow_numeric_maximum - .ow_numeric_minimum)",
      "    }",
      "    .ow_scaled[!is.finite(.ow_scaled)] <- NA_real_",
      "    .ow_scaled",
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
      "    if (base::anyDuplicated.default(.ow_coordinate_values)) stop(\"Interpolation coordinates must be unique\", call. = FALSE)",
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

  generated_categorical_encode <- function(
    .ow_frame,
    .ow_kind,
    .ow_specs,
    .ow_prefix_separator,
    .ow_delimiter,
    .ow_prefix,
    .ow_drop_original,
    .ow_maximum_columns,
    .ow_maximum_name_bytes,
    .ow_maximum_text_bytes,
    .ow_maximum_payload_bytes,
    .ow_maximum_output_bytes,
    .ow_character_vector_slot_bytes,
    .ow_metadata_base_bytes,
    .ow_column_fixed_bytes,
    .ow_input_ids,
    .ow_step_id
  ) {
    .ow_utf8_order <- function(.ow_values) {
      if (length(.ow_values) == 0L) return(integer())
      .ow_keys <- vapply(.ow_values, function(.ow_value) {
        paste(sprintf("%02x", as.integer(charToRaw(.ow_value))), collapse = "")
      }, character(1L), USE.NAMES = FALSE)
      order(.ow_keys, seq_along(.ow_keys), method = "radix")
    }
    .ow_utf8 <- function(.ow_values) {
      vapply(seq_len(base::length(base::unclass(.ow_values))), function(.ow_index) {
        .ow_value <- base::.subset2(.ow_values, .ow_index)
        if (is.na(.ow_value)) return(NA_character_)
        if (identical(Encoding(.ow_value), "bytes")) {
          stop("Open Wrangler categorical encoding requires valid UTF-8 text", call. = FALSE)
        }
        .ow_from <- if (identical(Encoding(.ow_value), "latin1")) "latin1" else "UTF-8"
        .ow_converted <- iconv(.ow_value, from = .ow_from, to = "UTF-8", sub = NA_character_)
        if (is.na(.ow_converted) || nchar(.ow_converted, type = "bytes") > .ow_maximum_text_bytes) {
          stop("Open Wrangler categorical encoding requires bounded valid UTF-8 text", call. = FALSE)
        }
        .ow_converted
      }, character(1L), USE.NAMES = FALSE)
    }
    .ow_semantic_scalar <- function(.ow_value) {
      if (base::is.null(.ow_value)) return(NULL)
      if (
        !base::is.character(.ow_value) ||
          base::length(base::unclass(.ow_value)) != 1L
      ) {
        base::stop("Open Wrangler categorical column type or semantics is stale", call. = FALSE)
      }
      .ow_scalar <- base::.subset2(.ow_value, 1L)
      if (base::is.na(.ow_scalar) || base::identical(base::Encoding(.ow_scalar), "bytes")) {
        base::stop("Open Wrangler categorical column type or semantics is stale", call. = FALSE)
      }
      .ow_from <- if (base::identical(base::Encoding(.ow_scalar), "latin1")) "latin1" else "UTF-8"
      .ow_scalar <- base::iconv(.ow_scalar, from = .ow_from, to = "UTF-8", sub = NA_character_)
      if (
        base::is.na(.ow_scalar) ||
          base::nchar(.ow_scalar, type = "bytes") > .ow_maximum_name_bytes
      ) {
        base::stop("Open Wrangler categorical column type or semantics is stale", call. = FALSE)
      }
      .ow_scalar
    }
    .ow_json_string_bytes <- function(.ow_value) {
      .ow_value <- .ow_utf8(.ow_value)
      .ow_bytes <- as.integer(charToRaw(.ow_value))
      .ow_html_slash <- logical(length(.ow_bytes))
      if (length(.ow_bytes) > 1L) {
        .ow_html_slash[-1L] <- .ow_bytes[-1L] == 47L & .ow_bytes[-length(.ow_bytes)] == 60L
      }
      as.double(sum(ifelse(
        .ow_bytes %in% c(8L, 9L, 10L, 12L, 13L, 34L, 92L) | .ow_html_slash,
        2L,
        ifelse(.ow_bytes < 32L, 6L, 1L)
      )) + 2L)
    }
    .ow_guard_result_metadata <- function(.ow_generated_names, .ow_retained_positions) {
      .ow_output_count <- length(.ow_retained_positions) + length(.ow_generated_names)
      if (length(.ow_input_ids) != length(.ow_names)) {
        stop("Open Wrangler categorical encoding received inconsistent input identities", call. = FALSE)
      }
      .ow_retained_output_ids <- .ow_input_ids[.ow_retained_positions]
      .ow_generated_output_ids <- if (length(.ow_generated_names) == 0L) {
        character()
      } else {
        paste0("c:step:", .ow_step_id, ":", seq_along(.ow_generated_names) - 1L)
      }
      .ow_output_ids <- c(.ow_retained_output_ids, .ow_generated_output_ids)
      .ow_output_names <- c(.ow_names[.ow_retained_positions], .ow_generated_names)
      .ow_metadata_bytes <- as.double(.ow_metadata_base_bytes) +
        as.double(.ow_output_count) * .ow_column_fixed_bytes
      .ow_spend_metadata <- function(.ow_bytes) {
        .ow_next <- .ow_metadata_bytes + as.double(.ow_bytes)
        if (!is.finite(.ow_next) || .ow_next > .ow_maximum_payload_bytes) {
          stop("Open Wrangler categorical encoding metadata is too large", call. = FALSE)
        }
        .ow_metadata_bytes <<- .ow_next
        invisible(NULL)
      }
      for (.ow_name in .ow_output_names) .ow_spend_metadata(.ow_json_string_bytes(.ow_name))
      .ow_generated_id_bytes <- 0
      .ow_output_id_bytes <- 0
      for (.ow_output_position in seq_len(.ow_output_count)) {
        .ow_generated_id_bytes <- .ow_generated_id_bytes +
          .ow_json_string_bytes(sprintf("r:c:%d", .ow_output_position - 1L))
        .ow_output_id_bytes <- .ow_output_id_bytes +
          .ow_json_string_bytes(base::.subset2(.ow_output_ids, .ow_output_position))
      }
      if (.ow_output_id_bytes > .ow_generated_id_bytes) {
        .ow_spend_metadata(.ow_output_id_bytes - .ow_generated_id_bytes)
      }
      for (.ow_position in .ow_retained_positions) {
        .ow_column <- base::.subset2(.ow_frame, .ow_position)
        .ow_column_classes <- attr(.ow_column, "class", exact = TRUE)
        if (is.null(.ow_column_classes)) {
          .ow_column_classes <- switch(
            typeof(.ow_column),
            logical = "logical",
            integer = "integer",
            double = "numeric",
            character = "character",
            stop("Open Wrangler categorical encoding received an unsupported retained column", call. = FALSE)
          )
        }
        for (.ow_class in .ow_column_classes) {
          .ow_spend_metadata(.ow_json_string_bytes(.ow_class) + 1L)
        }
        if ("factor" %in% .ow_column_classes) {
          .ow_levels <- attr(.ow_column, "levels", exact = TRUE)
          for (.ow_level in .ow_levels) {
            .ow_spend_metadata(.ow_json_string_bytes(.ow_level) + 1L)
          }
        }
        .ow_timezone <- .ow_semantic_scalar(attr(.ow_column, "tzone", exact = TRUE))
        if (!is.null(.ow_timezone)) {
          .ow_spend_metadata(.ow_json_string_bytes(.ow_timezone))
        }
        .ow_units <- .ow_semantic_scalar(attr(.ow_column, "units", exact = TRUE))
        if (!is.null(.ow_units)) {
          .ow_spend_metadata(.ow_json_string_bytes(.ow_units))
        }
      }
      for (.ow_generated_index in seq_along(.ow_generated_names)) {
        .ow_spend_metadata(.ow_json_string_bytes("integer") + 1L)
      }
      .ow_frame_classes <- attr(.ow_frame, "class", exact = TRUE)
      for (.ow_class in .ow_frame_classes) {
        .ow_spend_metadata(.ow_json_string_bytes(.ow_class) + 1L)
      }
      if (inherits(.ow_frame, "data.table")) {
        .ow_source_key <- attr(.ow_frame, "sorted", exact = TRUE)
        .ow_source_key <- if (is.null(.ow_source_key)) {
          character()
        } else {
          vapply(
            seq_len(base::length(base::unclass(.ow_source_key))),
            function(.ow_key_index) base::.subset2(.ow_source_key, .ow_key_index),
            character(1L),
            USE.NAMES = FALSE
          )
        }
        .ow_retained_names <- .ow_names[.ow_retained_positions]
        .ow_retained_key_count <- 0L
        for (.ow_key_name in .ow_source_key) {
          if (!.ow_key_name %in% .ow_retained_names) break
          .ow_retained_key_count <- .ow_retained_key_count + 1L
        }
        if (.ow_retained_key_count != 0L) {
          .ow_generated_key_bytes <- 0
          .ow_output_key_bytes <- 0
          for (.ow_key_index in seq_len(.ow_retained_key_count)) {
            .ow_key_position <- match(base::.subset2(.ow_source_key, .ow_key_index), .ow_retained_names)
            .ow_generated_key_bytes <- .ow_generated_key_bytes +
              .ow_json_string_bytes(sprintf("r:c:%d", .ow_key_position - 1L))
            .ow_output_key_bytes <- .ow_output_key_bytes +
              .ow_json_string_bytes(base::.subset2(.ow_output_ids, .ow_key_position))
          }
          .ow_spend_metadata(
            .ow_retained_key_count + max(.ow_generated_key_bytes, .ow_output_key_bytes)
          )
        }
      }
      .ow_output_ids
    }
    .ow_text <- function(.ow_column, .ow_spec) {
      if (
        !base::identical(base::typeof(.ow_column), .ow_spec$storageMode) ||
          !base::identical(base::class(.ow_column), .ow_spec$classes) ||
          !base::identical(.ow_semantic_scalar(base::attr(.ow_column, "tzone", exact = TRUE)), .ow_semantic_scalar(.ow_spec$timezone)) ||
          !base::identical(.ow_semantic_scalar(base::attr(.ow_column, "units", exact = TRUE)), .ow_semantic_scalar(.ow_spec$units))
      ) {
        base::stop("Open Wrangler categorical column type or semantics is stale", call. = FALSE)
      }
      .ow_storage <- unclass(.ow_column)
      attributes(.ow_storage) <- NULL
      .ow_missing <- is.na(.ow_storage)
      if (identical(.ow_spec$kind, "integer64")) {
        .ow_missing <- .Call(
          .ow_integer64_is_na,
          .ow_column,
          logical(.ow_storage_length(.ow_column))
        )
        .ow_values <- .Call(
          .ow_integer64_as_character,
          .ow_column,
          rep.int(NA_character_, .ow_storage_length(.ow_column))
        )
        return(list(storage = .ow_values, missing = .ow_missing, labels = .ow_values))
      }
      if (identical(.ow_spec$kind, "factor")) {
        .ow_levels <- .ow_utf8(attr(.ow_column, "levels", exact = TRUE))
        .ow_values <- rep.int(NA_character_, length(.ow_storage))
        .ow_present <- which(!.ow_missing)
        if (length(.ow_present) != 0L) .ow_values[.ow_present] <- .ow_levels[.ow_storage[.ow_present]]
        return(list(storage = .ow_storage, missing = .ow_missing, labels = .ow_values))
      }
      if (.ow_spec$kind %in% c("date", "datetime", "difftime")) {
        if (any(is.nan(.ow_storage)) || any(!.ow_missing & !is.finite(.ow_storage))) {
          stop("Open Wrangler categorical encoding received a non-finite classed scalar", call. = FALSE)
        }
        if (identical(.ow_spec$kind, "date") && any(!.ow_missing & .ow_storage != floor(.ow_storage))) {
          stop("Open Wrangler categorical encoding received a fractional Date", call. = FALSE)
        }
      }
      .ow_labels <- if (identical(.ow_spec$kind, "character")) {
        .ow_utf8(.ow_storage)
      } else if (identical(.ow_spec$kind, "logical")) {
        ifelse(.ow_storage, "TRUE", "FALSE")
      } else if (identical(.ow_spec$kind, "integer")) {
        sprintf("%d", .ow_storage)
      } else if (identical(.ow_spec$kind, "double")) {
        vapply(.ow_storage, function(.ow_value) {
          base::format.default(.ow_value, digits = 15L, trim = TRUE, scientific = FALSE, decimal.mark = ".")
        }, character(1L), USE.NAMES = FALSE)
      } else if (identical(.ow_spec$kind, "date")) {
        .ow_displays <- tryCatch(
          base::format.Date(structure(.ow_storage, class = "Date"), format = "%Y-%m-%d"),
          error = function(.ow_error) NULL
        )
        .ow_invalid <- if (!is.character(.ow_displays) || length(.ow_displays) != length(.ow_storage)) {
          TRUE
        } else {
          any(!.ow_missing & (is.na(.ow_displays) | !grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", .ow_displays)))
        }
        if (.ow_invalid) stop("Open Wrangler categorical encoding received a Date outside the supported ISO range", call. = FALSE)
        .ow_displays
      } else if (identical(.ow_spec$kind, "datetime")) {
        .ow_attributes <- if (is.null(.ow_spec$timezone)) {
          list(class = c("POSIXct", "POSIXt"))
        } else {
          list(class = c("POSIXct", "POSIXt"), tzone = .ow_spec$timezone)
        }
        .ow_values <- .ow_storage
        attributes(.ow_values) <- .ow_attributes
        .ow_timezone <- .ow_spec$timezone
        if (is.null(.ow_timezone) || identical(.ow_timezone, "")) .ow_timezone <- "UTC"
        .ow_displays <- tryCatch(
          base::format.POSIXct(
            .ow_values,
            tz = .ow_timezone,
            format = "%Y-%m-%dT%H:%M:%OS6",
            usetz = FALSE
          ),
          error = function(.ow_error) NULL
        )
        .ow_invalid <- !is.character(.ow_displays) ||
          length(.ow_displays) != length(.ow_storage) ||
          any(!.ow_missing & is.na(.ow_displays))
        if (.ow_invalid) stop("Open Wrangler categorical encoding received a datetime outside the supported range", call. = FALSE)
        .ow_utf8(.ow_displays)
      } else if (identical(.ow_spec$kind, "difftime")) {
        paste(vapply(.ow_storage, function(.ow_value) sprintf("%.17g", as.double(.ow_value)), character(1L)), .ow_spec$units)
      } else {
        stop("Open Wrangler one-hot encoding received an unsupported R scalar kind", call. = FALSE)
      }
      list(storage = .ow_storage, missing = .ow_missing, labels = .ow_labels)
    }
    .ow_names <- attr(.ow_frame, "names", exact = TRUE)
    if (
      length(.ow_input_ids) != length(.ow_names) ||
        anyNA(.ow_input_ids) ||
        base::anyDuplicated.default(.ow_input_ids)
    ) {
      stop("Open Wrangler categorical encoding received inconsistent input identities", call. = FALSE)
    }
    .ow_specs <- lapply(.ow_specs, function(.ow_spec) {
      .ow_matches <- which(.ow_input_ids == .ow_spec$id)
      if (
        length(.ow_matches) != 1L ||
          !identical(base::.subset2(.ow_names, base::.subset2(.ow_matches, 1L)), .ow_spec$name)
      ) {
        stop("Open Wrangler column reference is stale", call. = FALSE)
      }
      .ow_spec$position <- as.integer(base::.subset2(.ow_matches, 1L))
      .ow_column <- base::.subset2(.ow_frame, .ow_spec$position)
      if (
        !base::identical(base::typeof(.ow_column), .ow_spec$storageMode) ||
          !base::identical(base::class(.ow_column), .ow_spec$classes) ||
          !base::identical(.ow_semantic_scalar(base::attr(.ow_column, "tzone", exact = TRUE)), .ow_semantic_scalar(.ow_spec$timezone)) ||
          !base::identical(.ow_semantic_scalar(base::attr(.ow_column, "units", exact = TRUE)), .ow_semantic_scalar(.ow_spec$units))
      ) {
        base::stop("Open Wrangler categorical column type or semantics is stale", call. = FALSE)
      }
      .ow_spec
    })
    .ow_selected_positions <- vapply(.ow_specs, `[[`, integer(1L), "position")
    .ow_retained_positions <- if (.ow_drop_original) {
      .ow_all_positions <- seq_along(.ow_names)
      .ow_all_positions[is.na(match(.ow_all_positions, .ow_selected_positions))]
    } else {
      seq_along(.ow_names)
    }
    .ow_maximum_generated <- .ow_maximum_columns - length(.ow_retained_positions)
    .ow_row_count <- as.double(.ow_storage_length(base::.subset2(.ow_frame, 1L)))
    .ow_guard_generated_count <- function(.ow_count) {
      if (.ow_count > .ow_maximum_generated) {
        stop("Open Wrangler categorical encoding output is too large", call. = FALSE)
      }
      invisible(NULL)
    }
    .ow_generated <- list()
    if (identical(.ow_kind, "oneHotEncode")) {
      for (.ow_spec_index in seq_along(.ow_specs)) {
        .ow_spec <- .ow_specs[[.ow_spec_index]]
        if (length(.ow_names) < .ow_spec$position || !identical(base::.subset2(.ow_names, .ow_spec$position), .ow_spec$name)) {
          stop("Open Wrangler column reference is stale", call. = FALSE)
        }
        .ow_domain <- .ow_text(base::.subset2(.ow_frame, .ow_spec$position), .ow_spec)
        .ow_present <- which(!.ow_domain$missing)
        .ow_categories <- base::unique.default(.ow_domain$storage[.ow_present])
        .ow_labels <- vapply(.ow_categories, function(.ow_category) {
          .ow_match <- base::.subset2(which(!.ow_domain$missing & .ow_domain$storage == .ow_category), 1L)
          base::.subset2(.ow_domain$labels, .ow_match)
        }, character(1L), USE.NAMES = FALSE)
        .ow_keep <- .ow_labels != ""
        .ow_categories <- .ow_categories[.ow_keep]
        .ow_labels <- .ow_labels[.ow_keep]
        for (.ow_category_index in seq_along(.ow_categories)) {
          .ow_guard_generated_count(length(.ow_generated) + 1L)
          .ow_generated[[length(.ow_generated) + 1L]] <- list(
            name = paste0(.ow_spec$name, .ow_prefix_separator, base::.subset2(.ow_labels, .ow_category_index)),
            domain = .ow_domain,
            category = base::.subset2(.ow_categories, .ow_category_index)
          )
        }
      }
    } else {
      .ow_spec <- .ow_specs[[1L]]
      if (length(.ow_names) < .ow_spec$position || !identical(base::.subset2(.ow_names, .ow_spec$position), .ow_spec$name)) {
        stop("Open Wrangler column reference is stale", call. = FALSE)
      }
      if (!.ow_spec$kind %in% c("character", "factor")) {
        stop("Multi-label binarization requires an R character or factor column", call. = FALSE)
      }
      .ow_values <- .ow_text(base::.subset2(.ow_frame, .ow_spec$position), .ow_spec)$labels
      .ow_operation_bytes <- .ow_row_count * .ow_character_vector_slot_bytes
      if (!is.finite(.ow_operation_bytes) || .ow_operation_bytes > .ow_maximum_output_bytes) {
        stop("Open Wrangler categorical encoding output is too large", call. = FALSE)
      }
      .ow_tokens <- vector("list", length(.ow_values))
      .ow_labels <- character()
      for (.ow_row_index in seq_along(.ow_values)) {
        .ow_value <- base::.subset2(.ow_values, .ow_row_index)
        if (is.na(.ow_value) || identical(.ow_value, "")) next
        .ow_parts <- base::.subset2(strsplit(.ow_value, .ow_delimiter, fixed = TRUE, useBytes = FALSE), 1L)
        .ow_parts <- base::unique.default(.ow_parts[.ow_parts != ""])
        if (length(.ow_parts) != 0L) {
          .ow_parts <- .ow_utf8(.ow_parts)
          for (.ow_part in .ow_parts) {
            .ow_next_bytes <- .ow_operation_bytes + nchar(.ow_part, type = "bytes") + .ow_character_vector_slot_bytes
            if (!is.finite(.ow_next_bytes) || .ow_next_bytes > .ow_maximum_output_bytes) {
              stop("Open Wrangler categorical encoding output is too large", call. = FALSE)
            }
            .ow_operation_bytes <- .ow_next_bytes
          }
        }
        .ow_tokens[[.ow_row_index]] <- .ow_parts
        .ow_unseen <- .ow_parts[is.na(match(.ow_parts, .ow_labels))]
        if (length(.ow_unseen) != 0L) .ow_labels <- c(.ow_labels, .ow_unseen)
        .ow_guard_generated_count(length(.ow_labels))
      }
      for (.ow_label in .ow_labels) {
        .ow_generated[[length(.ow_generated) + 1L]] <- list(
          name = paste0(.ow_prefix, .ow_label),
          label = .ow_label
        )
      }
    }
    .ow_generated_names <- vapply(.ow_generated, `[[`, character(1L), "name")
    if (length(.ow_generated) != 0L) {
      .ow_order <- .ow_utf8_order(.ow_generated_names)
      .ow_generated <- .ow_generated[.ow_order]
      .ow_generated_names <- .ow_generated_names[.ow_order]
    }
    if (length(.ow_generated_names) == 0L) {
      stop("Open Wrangler categorical encoding must generate at least one column", call. = FALSE)
    }
    .ow_retained_names <- .ow_names[.ow_retained_positions]
    .ow_folded_names <- chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", .ow_generated_names)
    if (any(startsWith(.ow_folded_names, "__open_wrangler_internal_row_id_"))) {
      stop("Categorical encoding would create Open Wrangler's reserved private row-identity column", call. = FALSE)
    }
    .ow_collisions <- base::unique.default(c(
      .ow_generated_names[base::duplicated.default(.ow_generated_names)],
      .ow_generated_names[.ow_generated_names %in% .ow_retained_names]
    ))
    if (length(.ow_collisions) != 0L) {
      .ow_collisions <- .ow_collisions[.ow_utf8_order(.ow_collisions)]
      stop(sprintf("Categorical encoding would create duplicate column names: %s", paste(.ow_collisions, collapse = ", ")), call. = FALSE)
    }
    if (any(.ow_generated_names == "") || any(nchar(.ow_generated_names, type = "bytes") > .ow_maximum_name_bytes)) {
      stop("Categorical encoding would create an invalid or oversized column name", call. = FALSE)
    }
    .ow_output_count <- length(.ow_retained_positions) + length(.ow_generated)
    if (.ow_output_count == 0L) stop("Open Wrangler categorical encoding must keep or generate at least one column", call. = FALSE)
    if (.ow_output_count > .ow_maximum_columns) stop("Open Wrangler categorical encoding exceeds the column limit", call. = FALSE)
    .ow_result_output_ids <- .ow_guard_result_metadata(.ow_generated_names, .ow_retained_positions)
    .ow_indicator_bytes <- .ow_row_count * length(.ow_generated) * 4
    .ow_total_output_bytes <- if (identical(.ow_kind, "multiLabelBinarize")) {
      .ow_operation_bytes + .ow_indicator_bytes
    } else {
      .ow_indicator_bytes
    }
    if (!is.finite(.ow_total_output_bytes) || .ow_total_output_bytes > .ow_maximum_output_bytes) {
      stop("Open Wrangler categorical encoding output is too large", call. = FALSE)
    }
    if (identical(.ow_kind, "oneHotEncode")) {
      for (.ow_generated_index in seq_along(.ow_generated)) {
        .ow_item <- .ow_generated[[.ow_generated_index]]
        .ow_matches <- !.ow_item$domain$missing & .ow_item$domain$storage == .ow_item$category
        .ow_matches[is.na(.ow_matches)] <- FALSE
        .ow_generated[[.ow_generated_index]]$values <- as.integer(.ow_matches)
      }
    } else {
      for (.ow_generated_index in seq_along(.ow_generated)) {
        .ow_label <- .ow_generated[[.ow_generated_index]]$label
        .ow_generated[[.ow_generated_index]]$values <- as.integer(vapply(.ow_tokens, function(.ow_row_tokens) {
          length(.ow_row_tokens) != 0L && .ow_label %in% .ow_row_tokens
        }, logical(1L), USE.NAMES = FALSE))
      }
    }
    .ow_result <- .ow_frame
    .ow_all_positions <- seq_along(.ow_names)
    .ow_dropped <- .ow_all_positions[is.na(match(.ow_all_positions, .ow_retained_positions))]
    if (inherits(.ow_result, "data.table")) {
      .ow_data_table_classes <- class(.ow_result)
      .ow_source_key <- attr(.ow_result, "sorted", exact = TRUE)
      .ow_source_key <- if (is.null(.ow_source_key)) {
        character()
      } else {
        vapply(
          seq_len(base::length(base::unclass(.ow_source_key))),
          function(.ow_key_index) base::.subset2(.ow_source_key, .ow_key_index),
          character(1L),
          USE.NAMES = FALSE
        )
      }
      class(.ow_result) <- NULL
      for (.ow_position in base::sort.int(.ow_dropped, decreasing = TRUE)) .ow_result[[.ow_position]] <- NULL
      .ow_retained_names <- attr(.ow_result, "names", exact = TRUE)
      for (.ow_item in .ow_generated) {
        .ow_existing_names <- attr(.ow_result, "names", exact = TRUE)
        .ow_result[[.ow_storage_length(.ow_result) + 1L]] <- .ow_item$values
        attr(.ow_result, "names") <- c(.ow_existing_names, .ow_item$name)
      }
      class(.ow_result) <- .ow_data_table_classes
      .ow_retained_key_count <- 0L
      for (.ow_key_name in .ow_source_key) {
        if (!.ow_key_name %in% .ow_retained_names) break
        .ow_retained_key_count <- .ow_retained_key_count + 1L
      }
      if (.ow_retained_key_count == 0L) {
        attr(.ow_result, "sorted") <- NULL
      } else {
        attr(.ow_result, "sorted") <- vapply(
          seq_len(.ow_retained_key_count),
          function(.ow_key_index) base::.subset2(.ow_source_key, .ow_key_index),
          character(1L),
          USE.NAMES = FALSE
        )
      }
      .ow_result <- base::.Call(.ow_data_table_alloccol, .ow_result, 1024L, FALSE)
    } else {
      .ow_result_classes <- class(.ow_result)
      class(.ow_result) <- NULL
      for (.ow_position in base::sort.int(.ow_dropped, decreasing = TRUE)) .ow_result[[.ow_position]] <- NULL
      for (.ow_item in .ow_generated) {
        .ow_existing_names <- attr(.ow_result, "names", exact = TRUE)
        .ow_result[[.ow_storage_length(.ow_result) + 1L]] <- .ow_item$values
        attr(.ow_result, "names") <- c(.ow_existing_names, .ow_item$name)
      }
      class(.ow_result) <- .ow_result_classes
    }
    list(value = .ow_result, outputIds = .ow_result_output_ids)
  }

  categorical_code_helper_lines <- function() {
    c("  .ow_categorical_encode <-", paste0("  ", deparse(generated_categorical_encode, width.cutoff = 500L)))
  }

  generated_group_by <- function(.ow_frame, .ow_key_specs, .ow_aggregation_specs) {
    .ow_normalize_integer <- function(.ow_value) {
      .ow_value <- as.character(.ow_value)
      .ow_negative <- startsWith(.ow_value, "-")
      .ow_digits <- if (.ow_negative) substring(.ow_value, 2L) else .ow_value
      .ow_digits <- sub("^0+", "", .ow_digits)
      if (identical(.ow_digits, "")) return("0")
      if (.ow_negative) paste0("-", .ow_digits) else .ow_digits
    }
    .ow_abs_compare <- function(.ow_left, .ow_right) {
      if (nchar(.ow_left) != nchar(.ow_right)) return(sign(nchar(.ow_left) - nchar(.ow_right)))
      if (identical(.ow_left, .ow_right)) return(0L)
      if (.ow_left > .ow_right) 1L else -1L
    }
    .ow_abs_add <- function(.ow_left, .ow_right) {
      .ow_l <- rev(utf8ToInt(.ow_left) - 48L)
      .ow_r <- rev(utf8ToInt(.ow_right) - 48L)
      .ow_size <- max(length(.ow_l), length(.ow_r))
      length(.ow_l) <- .ow_size
      length(.ow_r) <- .ow_size
      .ow_l[is.na(.ow_l)] <- 0L
      .ow_r[is.na(.ow_r)] <- 0L
      .ow_out <- integer(.ow_size + 1L)
      .ow_carry <- 0L
      for (.ow_index in seq_len(.ow_size)) {
        .ow_total <- .ow_l[[.ow_index]] + .ow_r[[.ow_index]] + .ow_carry
        .ow_out[[.ow_index]] <- .ow_total %% 10L
        .ow_carry <- .ow_total %/% 10L
      }
      .ow_out[[.ow_size + 1L]] <- .ow_carry
      while (length(.ow_out) > 1L && .ow_out[[length(.ow_out)]] == 0L) {
        .ow_out <- .ow_out[-length(.ow_out)]
      }
      paste0(rev(.ow_out), collapse = "")
    }
    .ow_abs_subtract <- function(.ow_left, .ow_right) {
      .ow_l <- rev(utf8ToInt(.ow_left) - 48L)
      .ow_r <- rev(utf8ToInt(.ow_right) - 48L)
      length(.ow_r) <- length(.ow_l)
      .ow_r[is.na(.ow_r)] <- 0L
      .ow_out <- integer(length(.ow_l))
      .ow_borrow <- 0L
      for (.ow_index in seq_along(.ow_l)) {
        .ow_digit <- .ow_l[[.ow_index]] - .ow_r[[.ow_index]] - .ow_borrow
        if (.ow_digit < 0L) {
          .ow_digit <- .ow_digit + 10L
          .ow_borrow <- 1L
        } else {
          .ow_borrow <- 0L
        }
        .ow_out[[.ow_index]] <- .ow_digit
      }
      while (length(.ow_out) > 1L && .ow_out[[length(.ow_out)]] == 0L) {
        .ow_out <- .ow_out[-length(.ow_out)]
      }
      paste0(rev(.ow_out), collapse = "")
    }
    .ow_signed_add <- function(.ow_left, .ow_right) {
      .ow_left <- .ow_normalize_integer(.ow_left)
      .ow_right <- .ow_normalize_integer(.ow_right)
      .ow_left_negative <- startsWith(.ow_left, "-")
      .ow_right_negative <- startsWith(.ow_right, "-")
      .ow_left_abs <- if (.ow_left_negative) substring(.ow_left, 2L) else .ow_left
      .ow_right_abs <- if (.ow_right_negative) substring(.ow_right, 2L) else .ow_right
      if (identical(.ow_left_negative, .ow_right_negative)) {
        .ow_sum <- .ow_abs_add(.ow_left_abs, .ow_right_abs)
        return(if (.ow_left_negative && !identical(.ow_sum, "0")) paste0("-", .ow_sum) else .ow_sum)
      }
      .ow_comparison <- .ow_abs_compare(.ow_left_abs, .ow_right_abs)
      if (.ow_comparison == 0L) return("0")
      if (.ow_comparison > 0L) {
        .ow_difference <- .ow_abs_subtract(.ow_left_abs, .ow_right_abs)
        if (.ow_left_negative) paste0("-", .ow_difference) else .ow_difference
      } else {
        .ow_difference <- .ow_abs_subtract(.ow_right_abs, .ow_left_abs)
        if (.ow_right_negative) paste0("-", .ow_difference) else .ow_difference
      }
    }
    .ow_exact_sum_text <- function(.ow_values) {
      Reduce(.ow_signed_add, as.list(as.character(.ow_values)), init = "0")
    }
    .ow_exact_sum <- function(.ow_values, .ow_kind) {
      .ow_text <- .ow_exact_sum_text(.ow_values)
      .ow_negative <- startsWith(.ow_text, "-")
      .ow_magnitude <- if (.ow_negative) substring(.ow_text, 2L) else .ow_text
      .ow_limit <- if (identical(.ow_kind, "integer")) "2147483647" else "9223372036854775807"
      if (
        nchar(.ow_magnitude) > nchar(.ow_limit) ||
          (nchar(.ow_magnitude) == nchar(.ow_limit) && .ow_magnitude > .ow_limit)
      ) {
        stop(sprintf("Open Wrangler %s group sum is outside the supported range", .ow_kind), call. = FALSE)
      }
      if (identical(.ow_kind, "integer")) return(as.integer(.ow_text))
      if (!requireNamespace("bit64", quietly = TRUE)) stop("bit64 is required for integer64 Group By", call. = FALSE)
      .ow_result <- suppressWarnings(bit64::as.integer64(.ow_text))
      if (is.na(.ow_result)) stop("Open Wrangler integer64 group sum is outside the supported range", call. = FALSE)
      .ow_result
    }
    .ow_key_token <- function(.ow_values, .ow_kind) {
      .ow_missing <- is.na(.ow_values)
      .ow_text <- rep.int("", length(.ow_values))
      .ow_present <- which(!.ow_missing)
      if (length(.ow_present) > 0L) {
        .ow_selected <- .ow_values[.ow_present]
        .ow_text[.ow_present] <- if (.ow_kind %in% c("character", "factor")) {
          enc2utf8(as.character(.ow_selected))
        } else if (.ow_kind %in% c("double", "date", "datetime", "difftime")) {
          .ow_numeric <- if (identical(.ow_kind, "difftime")) as.double(.ow_selected) else as.double(.ow_selected)
          .ow_formatted <- sprintf("%.17g", .ow_numeric)
          .ow_formatted[.ow_numeric == 0] <- "0"
          .ow_formatted
        } else {
          as.character(.ow_selected)
        }
      }
      .ow_token <- rep.int("M", length(.ow_values))
      if (length(.ow_present) > 0L) {
        .ow_token[.ow_present] <- paste0(
          "P",
          nchar(.ow_text[.ow_present], type = "bytes"),
          ":",
          .ow_text[.ow_present]
        )
      }
      .ow_token
    }
    .ow_reduce <- function(.ow_source, .ow_rows, .ow_spec) {
      .ow_present <- .ow_source[.ow_rows]
      .ow_present <- .ow_present[!is.na(.ow_present)]
      .ow_operation <- .ow_spec$operation
      .ow_kind <- .ow_spec$kind
      if (identical(.ow_operation, "count")) return(as.integer(length(.ow_present)))
      if (identical(.ow_operation, "nUnique")) return(as.integer(length(unique(.ow_present))))
      if (length(.ow_present) == 0L) {
        if (identical(.ow_operation, "sum")) {
          if (identical(.ow_kind, "integer")) return(0L)
          if (identical(.ow_kind, "integer64")) {
            if (!requireNamespace("bit64", quietly = TRUE)) stop("bit64 is required for integer64 Group By", call. = FALSE)
            return(bit64::as.integer64("0"))
          }
          return(0)
        }
        if (.ow_operation %in% c("mean", "median")) return(NA_real_)
        if (.ow_operation %in% c("min", "max") && identical(.ow_kind, "factor") && !isTRUE(.ow_spec$ordered)) {
          return(NA_character_)
        }
        return(.ow_source[NA_integer_])
      }
      if (identical(.ow_operation, "first")) return(.ow_present[1L])
      if (identical(.ow_operation, "last")) return(.ow_present[length(.ow_present)])
      if (identical(.ow_operation, "sum")) {
        if (.ow_kind %in% c("integer", "integer64")) return(.ow_exact_sum(.ow_present, .ow_kind))
        return(sum(.ow_present))
      }
      if (identical(.ow_operation, "mean")) {
        if (identical(.ow_kind, "integer64")) {
          return(suppressWarnings(as.double(.ow_exact_sum_text(.ow_present))) / length(.ow_present))
        }
        .ow_numeric <- suppressWarnings(as.double(.ow_present))
        .ow_positive_infinity <- any(is.infinite(.ow_numeric) & .ow_numeric > 0)
        .ow_negative_infinity <- any(is.infinite(.ow_numeric) & .ow_numeric < 0)
        if (.ow_positive_infinity && .ow_negative_infinity) return(NaN)
        if (.ow_positive_infinity) return(Inf)
        if (.ow_negative_infinity) return(-Inf)
        .ow_scale <- max(abs(.ow_numeric))
        return(if (.ow_scale == 0) 0 else max(-1, min(1, mean(.ow_numeric / .ow_scale))) * .ow_scale)
      }
      if (identical(.ow_operation, "median")) {
        .ow_ordered <- sort(.ow_present)
        .ow_count <- length(.ow_ordered)
        .ow_lower <- suppressWarnings(as.double(.ow_ordered[[(.ow_count + 1L) %/% 2L]]))
        if (.ow_count %% 2L == 1L) return(.ow_lower)
        if (identical(.ow_kind, "integer64")) {
          .ow_middle <- .ow_ordered[c((.ow_count + 1L) %/% 2L, (.ow_count + 2L) %/% 2L)]
          return(suppressWarnings(as.double(.ow_exact_sum_text(.ow_middle))) / 2)
        }
        .ow_upper <- suppressWarnings(as.double(.ow_ordered[[(.ow_count + 2L) %/% 2L]]))
        if (is.infinite(.ow_lower) && identical(.ow_lower, .ow_upper)) return(.ow_lower)
        return(.ow_lower / 2 + .ow_upper / 2)
      }
      if (.ow_operation %in% c("min", "max")) {
        if (identical(.ow_kind, "factor") && !isTRUE(.ow_spec$ordered)) {
          return(if (identical(.ow_operation, "min")) min(as.character(.ow_present)) else max(as.character(.ow_present)))
        }
        .ow_result <- if (identical(.ow_operation, "min")) min(.ow_present) else max(.ow_present)
        if (identical(.ow_kind, "logical")) .ow_result <- as.logical(.ow_result)
        return(.ow_result)
      }
      stop("Open Wrangler received an unsupported Group By aggregation", call. = FALSE)
    }
    .ow_rows <- seq_len(nrow(.ow_frame))
    .ow_composite <- rep.int("", length(.ow_rows))
    for (.ow_spec in .ow_key_specs) {
      if (ncol(.ow_frame) < .ow_spec$position || !identical(names(.ow_frame)[[.ow_spec$position]], .ow_spec$name)) {
        stop("Open Wrangler column reference is stale", call. = FALSE)
      }
      .ow_token <- .ow_key_token(.ow_frame[[.ow_spec$position]], .ow_spec$kind)
      .ow_composite <- paste0(.ow_composite, nchar(.ow_token, type = "bytes"), ":", .ow_token)
    }
    .ow_distinct <- unique(.ow_composite)
    .ow_group_ids <- match(.ow_composite, .ow_distinct)
    .ow_groups <- split(.ow_rows, factor(.ow_group_ids, levels = seq_along(.ow_distinct)))
    .ow_representatives <- if (length(.ow_groups) == 0L) integer() else vapply(.ow_groups, `[[`, integer(1L), 1L)
    .ow_output <- lapply(.ow_key_specs, function(.ow_spec) {
      .ow_values <- .ow_frame[[.ow_spec$position]][.ow_representatives]
      if (identical(.ow_spec$kind, "double") && length(.ow_values) > 0L) .ow_values[is.nan(.ow_values)] <- NA_real_
      .ow_values
    })
    for (.ow_spec in .ow_aggregation_specs) {
      if (ncol(.ow_frame) < .ow_spec$position || !identical(names(.ow_frame)[[.ow_spec$position]], .ow_spec$name)) {
        stop("Open Wrangler column reference is stale", call. = FALSE)
      }
      .ow_source <- .ow_frame[[.ow_spec$position]]
      .ow_values <- if (length(.ow_groups) == 0L) {
        if (.ow_spec$operation %in% c("count", "nUnique")) integer()
        else if (.ow_spec$operation %in% c("mean", "median")) numeric()
        else if (.ow_spec$operation %in% c("min", "max") && identical(.ow_spec$kind, "factor") && !isTRUE(.ow_spec$ordered)) character()
        else .ow_source[integer()]
      } else {
        do.call(c, lapply(.ow_groups, function(.ow_group_rows) .ow_reduce(.ow_source, .ow_group_rows, .ow_spec)))
      }
      .ow_output[[length(.ow_output) + 1L]] <- .ow_values
    }
    names(.ow_output) <- c(
      vapply(.ow_key_specs, `[[`, character(1L), "name"),
      vapply(.ow_aggregation_specs, `[[`, character(1L), "alias")
    )
    .ow_base <- as.data.frame(.ow_output, optional = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
    names(.ow_base) <- names(.ow_output)
    row.names(.ow_base) <- NULL
    if (inherits(.ow_frame, "data.table")) {
      if (!requireNamespace("data.table", quietly = TRUE)) stop("data.table is required", call. = FALSE)
      .ow_result <- data.table::as.data.table(.ow_base)
      data.table::setkeyv(.ow_result, NULL)
      return(.ow_result)
    }
    if (inherits(.ow_frame, "tbl_df")) {
      if (!requireNamespace("tibble", quietly = TRUE)) stop("tibble is required", call. = FALSE)
      return(tibble::as_tibble(.ow_base, .name_repair = "minimal"))
    }
    .ow_base
  }

  group_by_code_helper_lines <- function() {
    c("  .ow_group_by <-", paste0("  ", deparse(generated_group_by, width.cutoff = 500L)))
  }

  r_group_spec <- function(specification, aggregation = FALSE) {
    source_fields <- c(
      sprintf("name = %s", r_string(specification$name)),
      sprintf("position = %dL", specification$position),
      sprintf("kind = %s", r_string(specification$semanticsKind)),
      sprintf("ordered = %s", if (isTRUE(specification$ordered)) "TRUE" else "FALSE")
    )
    fields <- if (aggregation) {
      c(
        sprintf("alias = %s", r_string(specification$alias)),
        sprintf("operation = %s", r_string(specification$operation)),
        source_fields
      )
    } else source_fields
    sprintf("list(%s)", paste(fields, collapse = ", "))
  }

  r_categorical_spec <- function(specification) {
    fields <- c(
      sprintf("id = %s", r_string(specification$id)),
      sprintf("name = %s", r_string(specification$name)),
      sprintf("position = %dL", specification$position),
      sprintf("kind = %s", r_string(specification$semanticsKind)),
      sprintf("storageMode = %s", r_string(specification$storageMode)),
      sprintf("classes = %s", r_character_vector(specification$classes))
    )
    if (!is.null(specification$timezone)) {
      fields <- c(fields, sprintf("timezone = %s", r_string(specification$timezone)))
    } else {
      fields <- c(fields, "timezone = NULL")
    }
    if (!is.null(specification$units)) {
      fields <- c(fields, sprintf("units = %s", r_string(specification$units)))
    } else {
      fields <- c(fields, "units = NULL")
    }
    sprintf("list(%s)", paste(fields, collapse = ", "))
  }

  r_by_example_value <- function(value) {
    if (is.null(value)) return("NULL")
    if (is.character(value)) return(r_string(value))
    if (is.logical(value)) return(if (isTRUE(value)) "TRUE" else "FALSE")
    if (is.integer(value)) return(sprintf("%dL", value))
    if (is.double(value) && length(value) == 1L && is.finite(value)) return(r_number(value))
    if (is.list(value)) {
      values <- vapply(value, r_by_example_value, character(1L), USE.NAMES = FALSE)
      body <- paste(values, collapse = ", ")
      if (is.null(names(value))) return(sprintf("base::list(%s)", body))
      return(sprintf(
        "base::structure(base::list(%s), names = %s)",
        body,
        r_character_vector(names(value))
      ))
    }
    abort("runtime_error", "The bound R by-example program cannot be serialized")
  }

  by_example_code_helper_lines <- function() {
    helpers <- list(
      by_example_json_integer_text = by_example_json_integer_text,
      by_example_utf8_scalar = by_example_utf8_scalar,
      by_example_decimal_digit_zeroes = by_example_decimal_digit_zeroes,
      by_example_decimal_digit_pattern = by_example_decimal_digit_pattern,
      by_example_decimal_digit_text = by_example_decimal_digit_text,
      by_example_datetime_parts = by_example_datetime_parts,
      by_example_format_datetime_parts = by_example_format_datetime_parts,
      by_example_slice_scalar = by_example_slice_scalar,
      by_example_split_part_scalar = by_example_split_part_scalar,
      by_example_regex_extract_scalar = by_example_regex_extract_scalar,
      by_example_regex_replace_scalar = by_example_regex_replace_scalar,
      by_example_normalize_integer_text = by_example_normalize_integer_text,
      by_example_abs_integer_compare = by_example_abs_integer_compare,
      by_example_abs_integer_add = by_example_abs_integer_add,
      by_example_abs_integer_subtract = by_example_abs_integer_subtract,
      by_example_abs_integer_multiply = by_example_abs_integer_multiply,
      by_example_signed_integer_binary = by_example_signed_integer_binary,
      by_example_checked_integer_text = by_example_checked_integer_text,
      by_example_integer64_text = by_example_integer64_text,
      .ow_by_example_evaluate = generated_by_example_evaluate
    )
    helper_lines <- unlist(lapply(names(helpers), function(name) {
      c(
        sprintf("  %s <-", name),
        paste0("  ", deparse(helpers[[name]], width.cutoff = 500L))
      )
    }), use.names = FALSE)
    c(
      helper_lines,
      "  .ow_by_example_normalize_frame_names <- function(.ow_frame) {",
      "    .ow_raw_names <- base::attr(.ow_frame, \"names\", exact = TRUE)",
      "    .ow_name_count <- .ow_storage_length(.ow_frame)",
      "    if (!base::is.character(.ow_raw_names) || base::length(base::unclass(.ow_raw_names)) != .ow_name_count) base::stop(\"Open Wrangler generated R received malformed dataframe names\", call. = FALSE)",
      "    .ow_plain_names <- base::unclass(.ow_raw_names)",
      "    base::vapply(base::seq_len(.ow_name_count), function(.ow_name_index) {",
      "      .ow_name <- base::.subset2(.ow_plain_names, .ow_name_index)",
      "      if (base::length(.ow_name) != 1L || base::is.na(.ow_name) || base::identical(base::Encoding(.ow_name), \"bytes\")) base::stop(\"Open Wrangler generated R received malformed dataframe names\", call. = FALSE)",
      "      .ow_name_from <- if (base::identical(base::Encoding(.ow_name), \"latin1\")) \"latin1\" else \"UTF-8\"",
      "      .ow_name_utf8 <- base::iconv(.ow_name, from = .ow_name_from, to = \"UTF-8\", sub = NA_character_)",
      sprintf(
        "      if (base::is.na(.ow_name_utf8) || base::nchar(.ow_name_utf8, type = \"bytes\") > %dL) base::stop(\"Open Wrangler generated R received an invalid or oversized dataframe name\", call. = FALSE)",
        maximum_name_bytes
      ),
      "      .ow_name_utf8",
      "    }, base::character(1L), USE.NAMES = FALSE)",
      "  }"
    )
  }

  custom_code_helper_lines <- function(
    maximum_columns,
    maximum_factor_levels,
    maximum_text_bytes,
    maximum_payload_bytes,
    maximum_name_bytes
  ) {
    c(
      "  .ow_custom_flavor <- function(.ow_value) {",
      "    .ow_classes <- base::class(.ow_value)",
      "    if (base::identical(.ow_classes, \"data.frame\")) return(\"r.data.frame\")",
      "    if (base::identical(.ow_classes, c(\"tbl_df\", \"tbl\", \"data.frame\"))) return(\"r.tibble\")",
      "    if (base::identical(.ow_classes, c(\"data.table\", \"data.frame\"))) return(\"r.data.table\")",
      "    base::stop(\"Open Wrangler Custom Code supports only a base data.frame, tibble, or data.table without subclasses\", call. = FALSE)",
      "  }",
      "  .ow_custom_plain_text <- function(.ow_values, .ow_label, .ow_maximum_bytes, .ow_allow_na = FALSE, .ow_allow_asis = FALSE) {",
      "    .ow_nested <- base::attributes(.ow_values)",
      "    if (!base::is.null(.ow_nested)) {",
      "      if (!base::isTRUE(.ow_allow_asis) || !base::identical(base::names(.ow_nested), \"class\") || !base::identical(base::unclass(base::.subset2(.ow_nested, \"class\")), \"AsIs\") || !base::is.null(base::attributes(base::.subset2(.ow_nested, \"class\")))) base::stop(base::sprintf(\"Open Wrangler Custom Code returned unsupported nested attributes on %s\", .ow_label), call. = FALSE)",
      "    }",
      "    .ow_plain <- base::unclass(.ow_values); base::attributes(.ow_plain) <- NULL",
      "    if (!base::is.character(.ow_plain) || (!base::isTRUE(.ow_allow_na) && base::anyNA(.ow_plain))) base::stop(base::sprintf(\"Open Wrangler Custom Code returned invalid %s\", .ow_label), call. = FALSE)",
      "    base::vapply(base::seq_len(base::length(.ow_plain)), function(.ow_index) {",
      "      .ow_item <- base::.subset2(.ow_plain, .ow_index)",
      "      if (base::is.na(.ow_item) && base::isTRUE(.ow_allow_na)) return(NA_character_)",
      "      if (base::identical(base::Encoding(.ow_item), \"bytes\")) base::stop(base::sprintf(\"Open Wrangler Custom Code returned invalid %s\", .ow_label), call. = FALSE)",
      "      .ow_from <- if (base::identical(base::Encoding(.ow_item), \"latin1\")) \"latin1\" else \"UTF-8\"",
      "      .ow_utf8 <- base::iconv(.ow_item, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
      "      if (base::is.na(.ow_utf8) || base::nchar(.ow_utf8, type = \"bytes\") > .ow_maximum_bytes) base::stop(base::sprintf(\"Open Wrangler Custom Code returned invalid or oversized %s\", .ow_label), call. = FALSE)",
      "      .ow_utf8",
      "    }, base::character(1L), USE.NAMES = FALSE)",
      "  }",
      "  .ow_custom_normalize <- function(.ow_value) {",
      "    if (base::identical(base::class(.ow_value), c(\"spec_tbl_df\", \"tbl_df\", \"tbl\", \"data.frame\"))) { .ow_value <- base::unclass(.ow_value); base::attr(.ow_value, \"spec\") <- NULL; base::attr(.ow_value, \"problems\") <- NULL; base::class(.ow_value) <- c(\"tbl_df\", \"tbl\", \"data.frame\") }",
      "    .ow_value",
      "  }",
      "  .ow_custom_snapshot <- function(.ow_value) {",
      "    .ow_value <- .ow_custom_normalize(.ow_value)",
      "    .ow_flavor <- .ow_custom_flavor(.ow_value)",
      "    .ow_count <- base::length(base::unclass(.ow_value))",
      "    .ow_element_names <- if (base::identical(.ow_flavor, \"r.data.table\")) base::lapply(base::seq_len(.ow_count), function(.ow_position) base::attr(base::.subset2(.ow_value, .ow_position), \"names\", exact = TRUE)) else NULL",
      "    .ow_copy <- if (base::identical(.ow_flavor, \"r.data.table\")) {",
      "      if (!base::requireNamespace(\"data.table\", quietly = TRUE)) base::stop(\"data.table is required for Custom Code\", call. = FALSE)",
      "      data.table::copy(.ow_value)",
      "    } else base::unserialize(base::serialize(.ow_value, NULL, version = 3L))",
      "    if (!base::is.null(.ow_element_names)) for (.ow_position in base::seq_along(.ow_element_names)) if (!base::is.null(base::.subset2(.ow_element_names, .ow_position))) data.table::setattr(base::.subset2(.ow_copy, .ow_position), \"names\", base::.subset2(.ow_element_names, .ow_position))",
      "    .ow_copy",
      "  }",
      "  .ow_custom_validate <- function(.ow_value) {",
      "    .ow_flavor <- .ow_custom_flavor(.ow_value)",
      "    if (!base::identical(.ow_flavor, .ow_source_flavor)) base::stop(\"Open Wrangler Custom Code must return the same R dataframe flavor as its input\", call. = FALSE)",
      "    .ow_attribute_names <- base::names(base::attributes(.ow_value)); if (base::is.null(.ow_attribute_names)) .ow_attribute_names <- base::character()",
      "    if (base::anyNA(.ow_attribute_names) || base::any(.ow_attribute_names == \"\") || base::anyDuplicated.default(.ow_attribute_names)) base::stop(\"Open Wrangler Custom Code returned malformed dataframe attributes\", call. = FALSE)",
      "    .ow_allowed_attributes <- c(\"names\", \"row.names\", \"class\"); if (base::identical(.ow_flavor, \"r.data.table\")) .ow_allowed_attributes <- c(.ow_allowed_attributes, \".internal.selfref\", \"sorted\")",
      "    if (base::any(base::is.na(base::match(.ow_attribute_names, .ow_allowed_attributes)))) base::stop(\"Open Wrangler Custom Code returned unsupported dataframe attributes\", call. = FALSE)",
      "    .ow_column_count <- base::length(base::unclass(.ow_value))",
      sprintf("    if (.ow_column_count < 1L || .ow_column_count > %dL) base::stop(\"Open Wrangler Custom Code must return a bounded non-empty schema\", call. = FALSE)", maximum_columns),
      "    .ow_names_raw <- base::attr(.ow_value, \"names\", exact = TRUE)",
      "    .ow_row_names_raw <- base::attr(.ow_value, \"row.names\", exact = TRUE)",
      "    if ((!base::is.integer(.ow_row_names_raw) && !base::is.character(.ow_row_names_raw)) || !base::is.null(base::attributes(.ow_row_names_raw))) base::stop(\"Open Wrangler Custom Code returned invalid raw row-name metadata\", call. = FALSE)",
      "    .ow_row_names <- base::tryCatch(base::.row_names_info(.ow_value, type = 0L), error = function(.ow_error) .ow_error)",
      "    if (base::inherits(.ow_row_names, \"error\") || (!base::is.integer(.ow_row_names) && !base::is.character(.ow_row_names))) base::stop(\"Open Wrangler Custom Code returned malformed row names\", call. = FALSE)",
      "    if (!base::is.null(base::attributes(.ow_row_names))) base::stop(\"Open Wrangler Custom Code returned nested row-name attributes\", call. = FALSE)",
      "    .ow_compact <- base::is.integer(.ow_row_names) && base::length(.ow_row_names) == 2L && base::is.na(base::.subset2(.ow_row_names, 1L))",
      "    .ow_row_count <- if (.ow_compact) base::abs(base::as.double(base::.subset2(.ow_row_names, 2L))) else base::as.double(base::length(.ow_row_names))",
      "    if ((.ow_compact && (base::is.na(base::.subset2(.ow_row_names, 2L)) || base::.subset2(.ow_row_names, 2L) == 0L)) || !base::is.finite(.ow_row_count) || .ow_row_count != base::floor(.ow_row_count) || .ow_row_count > .Machine$integer.max) base::stop(\"Open Wrangler Custom Code returned malformed row names\", call. = FALSE)",
      "    .ow_columns <- base::unclass(.ow_value); if (!base::is.list(.ow_columns) || base::length(.ow_columns) != .ow_column_count) base::stop(\"Open Wrangler Custom Code returned a malformed dataframe payload\", call. = FALSE)",
      "    .ow_storage_lower_bound <- 1024 + base::as.double(.ow_column_count) * 512",
      sprintf(
        "    .ow_storage_check <- function() { if (!base::is.finite(.ow_storage_lower_bound) || .ow_storage_lower_bound > %dL) base::stop(\"Open Wrangler Custom Code exceeds the operation output budget before value inspection\", call. = FALSE); base::invisible(NULL) }",
        maximum_operation_output_bytes
      ),
      "    .ow_storage_slots <- function(.ow_values, .ow_width = 8) { if (base::is.null(.ow_values)) return(base::invisible(NULL)); .ow_storage_lower_bound <<- .ow_storage_lower_bound + base::as.double(base::length(base::unclass(.ow_values))) * .ow_width; if (!base::is.null(base::attributes(.ow_values))) .ow_storage_lower_bound <<- .ow_storage_lower_bound + 12; .ow_storage_check() }",
      "    .ow_storage_slots(.ow_names_raw); .ow_storage_slots(base::attr(.ow_value, \"class\", exact = TRUE)); .ow_storage_slots(.ow_row_names, if (base::is.character(.ow_row_names)) 8 else 4); .ow_storage_slots(base::attr(.ow_value, \"sorted\", exact = TRUE))",
      "    for (.ow_position in base::seq_len(.ow_column_count)) { .ow_storage_column <- base::.subset2(.ow_columns, .ow_position); .ow_storage_lower_bound <- .ow_storage_lower_bound + .ow_row_count * if (base::typeof(.ow_storage_column) %in% c(\"logical\", \"integer\")) 4 else 8; .ow_storage_check(); .ow_storage_slots(base::attr(.ow_storage_column, \"names\", exact = TRUE)); .ow_storage_slots(base::attr(.ow_storage_column, \"class\", exact = TRUE)); .ow_storage_slots(base::attr(.ow_storage_column, \"levels\", exact = TRUE)); .ow_storage_slots(base::attr(.ow_storage_column, \"tzone\", exact = TRUE)); .ow_storage_slots(base::attr(.ow_storage_column, \"units\", exact = TRUE)) }",
      "    if (!.ow_compact && (base::anyNA(.ow_row_names) || base::anyDuplicated.default(.ow_row_names))) base::stop(\"Open Wrangler Custom Code returned malformed row names\", call. = FALSE)",
      sprintf("    .ow_names <- .ow_custom_plain_text(.ow_names_raw, \"column names\", %dL, FALSE, TRUE)", maximum_name_bytes),
      "    if (base::length(.ow_names) != .ow_column_count || base::any(.ow_names == \"\") || base::any(base::startsWith(base::chartr(\"ABCDEFGHIJKLMNOPQRSTUVWXYZ\", \"abcdefghijklmnopqrstuvwxyz\", .ow_names), \"__open_wrangler_internal_row_id_\"))) base::stop(\"Open Wrangler Custom Code returned empty or reserved column names\", call. = FALSE)",
      "    .ow_metadata_bytes <- 1024 + base::as.double(.ow_column_count) * 512",
      "    .ow_operation_bytes <- 1024 + base::as.double(.ow_column_count) * 512",
      sprintf("    .ow_spend_metadata <- function(.ow_bytes) { .ow_metadata_bytes <<- .ow_metadata_bytes + base::as.double(.ow_bytes); if (!base::is.finite(.ow_metadata_bytes) || .ow_metadata_bytes > %dL) base::stop(\"Open Wrangler Custom Code exceeds the encoded metadata budget\", call. = FALSE) }", maximum_payload_bytes),
      sprintf("    .ow_spend_operation <- function(.ow_bytes) { .ow_operation_bytes <<- .ow_operation_bytes + base::as.double(.ow_bytes); if (!base::is.finite(.ow_operation_bytes) || .ow_operation_bytes > %dL) base::stop(\"Open Wrangler Custom Code exceeds the operation output budget\", call. = FALSE) }", maximum_operation_output_bytes),
      "    .ow_charge_text <- function(.ow_values, .ow_label, .ow_maximum_bytes, .ow_allow_na = FALSE, .ow_allow_asis = FALSE, .ow_slots = TRUE, .ow_metadata_extra = NULL) {",
      "      .ow_nested <- base::attributes(.ow_values)",
      "      .ow_plain <- .ow_custom_plain_text(.ow_values, .ow_label, .ow_maximum_bytes, .ow_allow_na, .ow_allow_asis)",
      "      if (!base::is.null(.ow_nested)) .ow_spend_operation(12)",
      "      if (.ow_slots) .ow_spend_operation(base::as.double(base::length(.ow_plain)) * 8)",
      "      for (.ow_item in .ow_plain[!base::is.na(.ow_plain)]) { .ow_bytes <- base::nchar(.ow_item, type = \"bytes\"); .ow_spend_operation(.ow_bytes); if (!base::is.null(.ow_metadata_extra)) .ow_spend_metadata(.ow_metadata_json_bytes(.ow_item) + .ow_metadata_extra) }",
      "      .ow_plain",
      "    }",
      sprintf("    .ow_charge_text(.ow_names_raw, \"column names\", %dL, FALSE, TRUE, TRUE, 0)", maximum_name_bytes),
      sprintf("    .ow_charge_text(base::class(.ow_value), \"frame classes\", %dL, FALSE, FALSE, TRUE, 1)", maximum_name_bytes),
      "    if (base::is.character(.ow_row_names)) .ow_charge_text(.ow_row_names, \"row names\", 1024L, FALSE, FALSE, TRUE, NULL) else .ow_spend_operation(base::as.double(base::length(.ow_row_names)) * 4)",
      "    if (base::identical(.ow_flavor, \"r.data.table\")) {",
      "      .ow_selfref <- base::attr(.ow_value, \".internal.selfref\", exact = TRUE); if (!base::is.null(.ow_selfref) && !base::identical(base::typeof(.ow_selfref), \"externalptr\")) base::stop(\"Open Wrangler Custom Code returned an invalid data.table self-reference\", call. = FALSE)",
      "      .ow_key_raw <- base::attr(.ow_value, \"sorted\", exact = TRUE); .ow_key <- if (base::is.null(.ow_key_raw)) base::character() else .ow_charge_text(.ow_key_raw, \"data.table key\", 1024L, FALSE, TRUE, TRUE, NULL)",
      "      if (base::any(.ow_key == \"\") || base::anyDuplicated.default(.ow_key) || base::any(base::vapply(.ow_key, function(.ow_name) base::sum(.ow_names == .ow_name) != 1L, logical(1L)))) base::stop(\"Open Wrangler Custom Code returned invalid data.table key metadata\", call. = FALSE)",
      "      for (.ow_key_name in .ow_key) { .ow_key_position <- base::match(.ow_key_name, .ow_names); .ow_spend_metadata(.ow_metadata_json_bytes(base::sprintf(\"r:c:%d\", .ow_key_position - 1L)) + 1) }",
      "    }",
      "    for (.ow_position in base::seq_len(.ow_column_count)) {",
      "      .ow_column <- base::.subset2(.ow_columns, .ow_position); if (base::length(base::unclass(.ow_column)) != .ow_row_count) base::stop(\"Open Wrangler Custom Code returned a column with the wrong row count\", call. = FALSE)",
      "      if (base::is.matrix(.ow_column) || base::is.array(.ow_column) || base::is.list(.ow_column) || base::is.raw(.ow_column) || base::is.complex(.ow_column)) base::stop(\"Open Wrangler Custom Code returned an unsupported column\", call. = FALSE)",
      "      .ow_column_attributes <- base::attributes(.ow_column); .ow_column_attribute_names <- base::names(.ow_column_attributes); if (base::is.null(.ow_column_attribute_names)) .ow_column_attribute_names <- base::character()",
      "      if (base::anyNA(.ow_column_attribute_names) || base::any(.ow_column_attribute_names == \"\") || base::anyDuplicated.default(.ow_column_attribute_names)) base::stop(\"Open Wrangler Custom Code returned malformed column attributes\", call. = FALSE)",
      "      if (\"names\" %in% .ow_column_attribute_names) { .ow_element_names <- base::attr(.ow_column, \"names\", exact = TRUE); if (!base::is.character(.ow_element_names) || base::is.object(.ow_element_names) || !base::is.null(base::attributes(.ow_element_names)) || base::length(.ow_element_names) != .ow_row_count) base::stop(\"Open Wrangler Custom Code returned malformed element names\", call. = FALSE); .ow_charge_text(.ow_element_names, \"element names\", 8192L, TRUE, FALSE, TRUE, NULL); .ow_column_attribute_names <- .ow_column_attribute_names[.ow_column_attribute_names != \"names\"] }",
      "      .ow_type <- base::typeof(.ow_column); .ow_classes <- base::class(.ow_column); .ow_allowed <- base::character(); .ow_kind <- NULL",
      "      if (base::identical(.ow_type, \"logical\") && base::identical(.ow_classes, \"logical\")) .ow_kind <- \"logical\" else if (base::identical(.ow_type, \"integer\") && base::identical(.ow_classes, \"integer\")) .ow_kind <- \"integer\" else if (base::identical(.ow_type, \"double\") && base::identical(.ow_classes, \"numeric\")) .ow_kind <- \"double\" else if (base::identical(.ow_type, \"character\") && base::identical(.ow_classes, \"character\")) .ow_kind <- \"character\" else if (base::identical(.ow_type, \"double\") && base::identical(.ow_classes, \"integer64\")) { .ow_kind <- \"integer64\"; .ow_allowed <- \"class\"; if (!base::requireNamespace(\"bit64\", quietly = TRUE)) base::stop(\"bit64 is required for integer64 Custom Code output\", call. = FALSE) } else if (base::identical(.ow_type, \"double\") && base::identical(.ow_classes, \"Date\")) { .ow_kind <- \"date\"; .ow_allowed <- \"class\" } else if (base::identical(.ow_type, \"double\") && base::identical(.ow_classes, c(\"POSIXct\", \"POSIXt\"))) { .ow_kind <- \"datetime\"; .ow_allowed <- c(\"class\", \"tzone\") } else if (base::identical(.ow_type, \"double\") && base::identical(.ow_classes, \"difftime\")) { .ow_kind <- \"difftime\"; .ow_allowed <- c(\"class\", \"units\") } else if (base::identical(.ow_type, \"integer\") && (base::identical(.ow_classes, \"factor\") || base::identical(.ow_classes, c(\"ordered\", \"factor\")))) { .ow_kind <- \"factor\"; .ow_allowed <- c(\"class\", \"levels\") } else base::stop(\"Open Wrangler Custom Code returned an unsupported column type or class\", call. = FALSE)",
      "      if (base::any(base::is.na(base::match(.ow_column_attribute_names, .ow_allowed)))) base::stop(\"Open Wrangler Custom Code returned unsupported column attributes\", call. = FALSE)",
      sprintf("      if (base::length(.ow_allowed) != 0L) .ow_charge_text(base::attr(.ow_column, \"class\", exact = TRUE), \"column classes\", %dL, FALSE, TRUE, TRUE, 1)", maximum_name_bytes),
      "      .ow_spend_operation(.ow_row_count * if (.ow_kind %in% c(\"logical\", \"integer\", \"factor\")) 4 else 8)",
      sprintf("      if (base::identical(.ow_kind, \"character\")) { .ow_plain_values <- base::unclass(.ow_column); base::attributes(.ow_plain_values) <- NULL; .ow_charge_text(.ow_plain_values, \"character values\", %dL, TRUE, FALSE, FALSE, NULL) }", maximum_text_bytes),
      sprintf("      if (base::identical(.ow_kind, \"factor\")) { .ow_levels <- .ow_charge_text(base::attr(.ow_column, \"levels\", exact = TRUE), \"factor levels\", %dL, FALSE, TRUE, TRUE, 1); if (base::length(.ow_levels) > %dL || base::anyDuplicated.default(.ow_levels)) base::stop(\"Open Wrangler Custom Code returned invalid factor levels\", call. = FALSE); .ow_codes <- base::unclass(.ow_column); if (base::any(!base::is.na(.ow_codes) & (.ow_codes < 1L | .ow_codes > base::length(.ow_levels)))) base::stop(\"Open Wrangler Custom Code returned invalid factor codes\", call. = FALSE) }", maximum_text_bytes, maximum_factor_levels),
      "      if (.ow_kind %in% c(\"date\", \"datetime\", \"difftime\")) { .ow_storage <- base::unclass(.ow_column); if (base::any(base::is.nan(.ow_storage)) || base::any(!base::is.na(.ow_storage) & !base::is.finite(.ow_storage)) || (base::identical(.ow_kind, \"date\") && base::any(!base::is.na(.ow_storage) & .ow_storage != base::floor(.ow_storage)))) base::stop(\"Open Wrangler Custom Code returned invalid temporal values\", call. = FALSE) }",
      sprintf("      if (base::identical(.ow_kind, \"datetime\") && \"tzone\" %%in%% .ow_column_attribute_names) { .ow_tzone <- .ow_charge_text(base::attr(.ow_column, \"tzone\", exact = TRUE), \"datetime timezone\", %dL, FALSE, TRUE, TRUE, 0); if (base::length(.ow_tzone) != 1L) base::stop(\"Open Wrangler Custom Code returned invalid timezone metadata\", call. = FALSE) }", maximum_name_bytes),
      sprintf("      if (base::identical(.ow_kind, \"difftime\")) { .ow_units <- .ow_charge_text(base::attr(.ow_column, \"units\", exact = TRUE), \"duration units\", %dL, FALSE, TRUE, TRUE, 0); if (base::length(.ow_units) != 1L || !base::.subset2(.ow_units, 1L) %%in%% c(\"secs\", \"mins\", \"hours\", \"days\", \"weeks\")) base::stop(\"Open Wrangler Custom Code returned invalid duration metadata\", call. = FALSE) }", maximum_name_bytes),
      "    }",
      "    .ow_metadata_bytes",
      "  }",
      "  .ow_custom_validate_identity_budget <- function(.ow_metadata_bytes, .ow_value, .ow_ids) {",
      "    .ow_default_ids <- base::sprintf(\"r:c:%d\", base::seq_along(.ow_ids) - 1L)",
      "    .ow_old_id_bytes <- base::sum(base::vapply(.ow_default_ids, .ow_metadata_json_bytes, base::double(1L), USE.NAMES = FALSE))",
      "    .ow_new_id_bytes <- base::sum(base::vapply(.ow_ids, .ow_metadata_json_bytes, base::double(1L), USE.NAMES = FALSE))",
      "    .ow_additional <- base::max(0, .ow_new_id_bytes - .ow_old_id_bytes)",
      "    if (base::identical(.ow_custom_flavor(.ow_value), \"r.data.table\")) {",
      "      .ow_key <- base::attr(.ow_value, \"sorted\", exact = TRUE)",
      "      if (!base::is.null(.ow_key)) { .ow_key <- base::unclass(.ow_key); base::attributes(.ow_key) <- NULL; .ow_names <- base::attr(.ow_value, \"names\", exact = TRUE); .ow_names <- base::unclass(.ow_names); base::attributes(.ow_names) <- NULL; .ow_key_positions <- base::match(.ow_key, .ow_names); .ow_old_key_ids <- .ow_default_ids[.ow_key_positions]; .ow_new_key_ids <- .ow_ids[.ow_key_positions]; .ow_old_key_bytes <- base::sum(base::vapply(.ow_old_key_ids, .ow_metadata_json_bytes, base::double(1L), USE.NAMES = FALSE)); .ow_new_key_bytes <- base::sum(base::vapply(.ow_new_key_ids, .ow_metadata_json_bytes, base::double(1L), USE.NAMES = FALSE)); .ow_additional <- .ow_additional + base::max(0, .ow_new_key_bytes - .ow_old_key_bytes) }",
      "    }",
      sprintf("    if (!base::is.finite(.ow_metadata_bytes + .ow_additional) || .ow_metadata_bytes + .ow_additional > %dL) base::stop(\"Open Wrangler Custom Code exceeds the encoded metadata budget after lineage\", call. = FALSE)", maximum_payload_bytes),
      "    base::invisible(NULL)",
      "  }",
      "  .ow_custom_eval <- function(.ow_expressions, .ow_environment) {",
      "    .ow_connection <- base::file(base::nullfile(), open = \"wt\")",
      "    .ow_output_depth <- base::sink.number(type = \"output\"); .ow_message_depth <- base::sink.number(type = \"message\")",
      "    base::on.exit({ while (base::sink.number(type = \"message\") > .ow_message_depth) base::sink(type = \"message\"); while (base::sink.number(type = \"output\") > .ow_output_depth) base::sink(type = \"output\"); base::close(.ow_connection) }, add = TRUE)",
      "    base::sink(.ow_connection, type = \"output\"); base::sink(.ow_connection, type = \"message\")",
      "    base::withCallingHandlers(base::eval(.ow_expressions, envir = .ow_environment), warning = function(.ow_condition) base::invokeRestart(\"muffleWarning\"), message = function(.ow_condition) base::invokeRestart(\"muffleMessage\"))",
      "  }",
      "  .ow_custom_run <- function(.ow_expressions, .ow_input, .ow_parent, .ow_source_name, .ow_publication_name) {",
      "    .ow_local_input <- .ow_custom_snapshot(.ow_input)",
      "    .ow_shield <- base::new.env(parent = .ow_parent); base::assign(.ow_source_name, .ow_local_input, envir = .ow_shield, inherits = FALSE); base::lockBinding(.ow_source_name, .ow_shield)",
      "    if (!base::identical(.ow_source_name, \"result\")) { base::assign(\"result\", NULL, envir = .ow_shield, inherits = FALSE); base::lockBinding(\"result\", .ow_shield) }",
      "    if (!.ow_publication_name %in% c(.ow_source_name, \"result\")) { base::assign(.ow_publication_name, NULL, envir = .ow_shield, inherits = FALSE); base::lockBinding(.ow_publication_name, .ow_shield) }",
      "    .ow_environment <- base::new.env(parent = .ow_shield); base::assign(\"df\", .ow_local_input, envir = .ow_environment, inherits = FALSE)",
      "    .ow_custom_eval(.ow_expressions, .ow_environment)",
      "    if (!base::exists(\"result\", envir = .ow_environment, inherits = FALSE) || base::bindingIsActive(\"result\", .ow_environment)) base::stop(\"Open Wrangler Custom Code must assign a non-active local result binding\", call. = FALSE)",
      "    .ow_raw_output <- .ow_custom_normalize(base::get(\"result\", envir = .ow_environment, inherits = FALSE)); .ow_metadata_bytes <- .ow_custom_validate(.ow_raw_output)",
      "    .ow_output <- .ow_custom_snapshot(.ow_raw_output); .ow_snapshot_metadata_bytes <- .ow_custom_validate(.ow_output)",
      "    if (!base::identical(.ow_snapshot_metadata_bytes, .ow_metadata_bytes)) base::stop(\"Open Wrangler Custom Code output changed while it was captured\", call. = FALSE)",
      "    base::list(value = .ow_output, metadataBytes = .ow_metadata_bytes)",
      "  }"
    )
  }

  compile_plan <- function(
    variable_name,
    bound_plan,
    maximum_columns,
    maximum_factor_levels,
    maximum_text_bytes,
    maximum_payload_bytes,
    maximum_name_bytes
  ) {
    if (length(bound_plan) == 0L) return("")
    result_name <- if (identical(variable_name, "open_wrangler_result")) {
      "open_wrangler_result_2"
    } else {
      "open_wrangler_result"
    }
    lines <- c(
      "base::evalq({",
      sprintf("  .ow_publication_name <- %s", r_string(result_name)),
      "  if (base::exists(.ow_publication_name, envir = .ow_caller_environment, inherits = FALSE) && base::bindingIsActive(.ow_publication_name, .ow_caller_environment)) base::stop(\"Open Wrangler generated R does not accept an active result binding\", call. = FALSE)",
      "  .ow_generated_result <- base::evalq({",
      sprintf(
        "  if (!base::exists(%s, envir = .ow_source_environment, inherits = FALSE)) base::stop(\"Open Wrangler source variable is unavailable\", call. = FALSE)",
        r_string(variable_name)
      ),
      sprintf(
        "  if (base::bindingIsActive(%s, .ow_source_environment)) base::stop(\"Open Wrangler generated R does not accept an active source binding\", call. = FALSE)",
        r_string(variable_name)
      ),
      sprintf(
        "  .ow_source <- base::get(%s, envir = .ow_source_environment, inherits = FALSE)",
        r_string(variable_name)
      ),
      sprintf(
        "  if (base::exists(%1$s, envir = .ow_source_environment, inherits = FALSE) && base::bindingIsActive(%1$s, .ow_source_environment)) base::stop(\"Open Wrangler generated R does not accept an active result binding\", call. = FALSE)",
        r_string(result_name)
      ),
      "  base::rm(.ow_source_environment)",
      "  if (!base::is.data.frame(.ow_source)) base::stop(\"Open Wrangler expected an R dataframe\", call. = FALSE)",
      "  .ow_storage_length <- function(.ow_value) base::length(base::unclass(.ow_value))",
      "  .ow_source_classes <- base::class(.ow_source)",
      "  .ow_source_is_readr <- base::identical(.ow_source_classes, c(\"spec_tbl_df\", \"tbl_df\", \"tbl\", \"data.frame\"))",
      "  .ow_source_flavor <- if (base::identical(.ow_source_classes, \"data.frame\")) {",
      "    \"r.data.frame\"",
      "  } else if (base::identical(.ow_source_classes, c(\"tbl_df\", \"tbl\", \"data.frame\")) || .ow_source_is_readr) {",
      "    \"r.tibble\"",
      "  } else if (base::identical(.ow_source_classes, c(\"data.table\", \"data.frame\"))) {",
      "    \"r.data.table\"",
      "  } else {",
      "    base::stop(\"Open Wrangler generated R supports only a base data.frame, tibble, or data.table without subclasses\", call. = FALSE)",
      "  }",
      sprintf(
        "  .ow_source_column_count <- .ow_storage_length(.ow_source); if (.ow_source_column_count < 1L || .ow_source_column_count > %dL) base::stop(\"Open Wrangler generated R requires between 1 and %d source columns\", call. = FALSE)",
        maximum_columns,
        maximum_columns
      ),
      "  .ow_source_attribute_names <- base::names(base::attributes(.ow_source))",
      "  if (base::is.null(.ow_source_attribute_names)) .ow_source_attribute_names <- base::character()",
      "  if (base::anyNA(.ow_source_attribute_names) || base::any(.ow_source_attribute_names == \"\") || base::anyDuplicated.default(.ow_source_attribute_names)) base::stop(\"Open Wrangler generated R received malformed dataframe attribute names\", call. = FALSE)",
      "  .ow_allowed_source_attributes <- c(\"names\", \"row.names\", \"class\")",
      "  if (.ow_source_is_readr) .ow_allowed_source_attributes <- c(.ow_allowed_source_attributes, \"spec\", \"problems\")",
      "  if (base::identical(.ow_source_flavor, \"r.data.table\")) .ow_allowed_source_attributes <- c(.ow_allowed_source_attributes, \".internal.selfref\", \"sorted\")",
      "  .ow_unsupported_source_attributes <- .ow_source_attribute_names[base::is.na(base::match(.ow_source_attribute_names, .ow_allowed_source_attributes))]",
      "  if (base::length(.ow_unsupported_source_attributes) != 0L) base::stop(base::sprintf(\"Open Wrangler generated R received unsupported dataframe attributes: %s\", base::paste(.ow_unsupported_source_attributes, collapse = \", \")), call. = FALSE)",
      "  .ow_source_names <- base::attr(.ow_source, \"names\", exact = TRUE)",
      "  if (!base::is.character(.ow_source_names) || .ow_storage_length(.ow_source_names) != .ow_source_column_count) base::stop(\"Open Wrangler generated R requires one name per source column\", call. = FALSE)",
      "  .ow_source_names <- base::vapply(base::seq_len(base::length(base::unclass(.ow_source_names))), function(.ow_name_index) base::.subset2(.ow_source_names, .ow_name_index), character(1L), USE.NAMES = FALSE)",
      "  for (.ow_source_name_index in base::seq_along(.ow_source_names)) {",
      "    .ow_source_name <- base::.subset2(.ow_source_names, .ow_source_name_index)",
      "    if (base::length(.ow_source_name) != 1L || base::is.na(.ow_source_name) || base::identical(base::Encoding(.ow_source_name), \"bytes\")) base::stop(\"Open Wrangler generated R requires non-missing UTF-8 source column names\", call. = FALSE)",
      "    .ow_source_name_encoding <- if (base::identical(base::Encoding(.ow_source_name), \"latin1\")) \"latin1\" else \"UTF-8\"",
      "    .ow_source_name_utf8 <- base::iconv(.ow_source_name, from = .ow_source_name_encoding, to = \"UTF-8\", sub = NA_character_)",
      sprintf(
        "    if (base::is.na(.ow_source_name_utf8) || base::nchar(.ow_source_name_utf8, type = \"bytes\") > %dL) base::stop(\"Open Wrangler generated R received an invalid or oversized source column name\", call. = FALSE)",
        maximum_name_bytes
      ),
      "  }",
      "  if (base::identical(.ow_source_flavor, \"r.data.table\")) {",
      "    .ow_source_self_reference <- base::attr(.ow_source, \".internal.selfref\", exact = TRUE)",
      "    if (!base::is.null(.ow_source_self_reference) && !base::identical(base::typeof(.ow_source_self_reference), \"externalptr\")) base::stop(\"Open Wrangler generated R received an invalid data.table self-reference\", call. = FALSE)",
      "    .ow_source_key <- base::attr(.ow_source, \"sorted\", exact = TRUE)",
      "    if (!base::is.null(.ow_source_key)) {",
      "      if (!base::is.character(.ow_source_key)) base::stop(\"Open Wrangler generated R received invalid data.table key metadata\", call. = FALSE)",
      "      .ow_source_key <- base::vapply(base::seq_len(base::length(base::unclass(.ow_source_key))), function(.ow_key_index) base::.subset2(.ow_source_key, .ow_key_index), character(1L), USE.NAMES = FALSE)",
      "      if (base::anyNA(.ow_source_key) || base::any(.ow_source_key == \"\") || base::anyDuplicated.default(.ow_source_key)) base::stop(\"Open Wrangler generated R received invalid data.table key metadata\", call. = FALSE)",
      "    }",
      "    if (base::length(.ow_source_key) != 0L && base::any(base::vapply(.ow_source_key, function(.ow_key_name) base::sum(.ow_source_names == .ow_key_name) != 1L, logical(1L)))) base::stop(\"Open Wrangler generated R received a data.table key that does not identify exactly one column\", call. = FALSE)",
      "  }",
      "  .ow_source_row_names <- base::tryCatch(base::.row_names_info(.ow_source, type = 0L), error = function(.ow_error) .ow_error)",
      "  if (base::inherits(.ow_source_row_names, \"error\") || (!base::is.integer(.ow_source_row_names) && !base::is.character(.ow_source_row_names))) base::stop(\"Open Wrangler generated R received malformed row names\", call. = FALSE)",
      "  .ow_source_row_names <- if (base::is.character(.ow_source_row_names)) base::vapply(base::seq_len(base::length(base::unclass(.ow_source_row_names))), function(.ow_row_name_index) base::.subset2(.ow_source_row_names, .ow_row_name_index), character(1L), USE.NAMES = FALSE) else base::vapply(base::seq_len(base::length(base::unclass(.ow_source_row_names))), function(.ow_row_name_index) base::.subset2(.ow_source_row_names, .ow_row_name_index), integer(1L), USE.NAMES = FALSE)",
      "  .ow_compact_row_names <- base::is.integer(.ow_source_row_names) && base::length(.ow_source_row_names) == 2L && base::is.na(base::.subset2(.ow_source_row_names, 1L))",
      "  if (.ow_compact_row_names) {",
      "    if (base::is.na(base::.subset2(.ow_source_row_names, 2L)) || base::.subset2(.ow_source_row_names, 2L) == 0L) base::stop(\"Open Wrangler generated R received malformed row names\", call. = FALSE)",
      "    .ow_source_row_count <- base::abs(base::as.double(base::.subset2(.ow_source_row_names, 2L)))",
      "    if (!base::is.finite(.ow_source_row_count) || .ow_source_row_count != base::floor(.ow_source_row_count) || .ow_source_row_count > .Machine$integer.max) base::stop(\"Open Wrangler generated R received malformed row names\", call. = FALSE)",
      "  } else {",
      "    .ow_source_row_count <- base::as.double(base::length(.ow_source_row_names))",
      "    if (!base::is.finite(.ow_source_row_count) || .ow_source_row_count > .Machine$integer.max) base::stop(\"Open Wrangler generated R received malformed row names\", call. = FALSE)",
      "    if (base::anyNA(.ow_source_row_names) || base::anyDuplicated.default(.ow_source_row_names)) base::stop(\"Open Wrangler generated R received malformed row names\", call. = FALSE)",
      "  }",
      "  .ow_source_columns <- base::unclass(.ow_source)",
      "  if (!base::is.list(.ow_source_columns) || base::length(.ow_source_columns) != .ow_source_column_count) base::stop(\"Open Wrangler generated R received a malformed dataframe payload\", call. = FALSE)",
      "  .ow_source_metadata_bytes <- 1024 + base::as.double(.ow_source_column_count) * 512",
      "  .ow_metadata_json_bytes <- function(.ow_value) { .ow_from <- if (base::identical(base::Encoding(.ow_value), \"latin1\")) \"latin1\" else \"UTF-8\"; .ow_utf8 <- base::iconv(.ow_value, from = .ow_from, to = \"UTF-8\", sub = NA_character_); if (base::is.na(.ow_utf8)) base::stop(\"Open Wrangler generated R received invalid metadata text\", call. = FALSE); .ow_raw <- base::as.integer(base::charToRaw(.ow_utf8)); .ow_html_slash <- base::logical(base::length(.ow_raw)); if (base::length(.ow_raw) > 1L) .ow_html_slash[-1L] <- .ow_raw[-1L] == 47L & .ow_raw[-base::length(.ow_raw)] == 60L; base::as.double(base::sum(base::ifelse(.ow_raw %in% c(8L, 9L, 10L, 12L, 13L, 34L, 92L) | .ow_html_slash, 2L, base::ifelse(.ow_raw < 32L, 6L, 1L))) + 2L) }",
      sprintf(
        "  .ow_spend_source_metadata <- function(.ow_bytes, .ow_label) { .ow_next <- .ow_source_metadata_bytes + base::as.double(.ow_bytes); if (!base::is.finite(.ow_next) || .ow_next > %dL) base::stop(base::sprintf(\"Open Wrangler generated R received %%s above the %d-byte payload budget\", .ow_label), call. = FALSE); .ow_source_metadata_bytes <<- .ow_next; base::invisible(NULL) }",
        maximum_payload_bytes,
        maximum_payload_bytes
      ),
      "  for (.ow_source_name in .ow_source_names) .ow_spend_source_metadata(.ow_metadata_json_bytes(.ow_source_name), \"source column-name metadata\")",
      "  .ow_validate_source_column <- function(.ow_column, .ow_column_index) {",
      "    .ow_column_label <- base::sprintf(\"source column %d\", .ow_column_index)",
      "    .ow_column_length <- .ow_storage_length(.ow_column)",
      "    if (.ow_column_length != .ow_source_row_count) base::stop(base::sprintf(\"Open Wrangler generated R received a source column whose length does not match its row count: %s\", .ow_column_label), call. = FALSE)",
      "    .ow_column_attributes <- base::attributes(.ow_column)",
      "    .ow_column_attribute_names <- base::names(.ow_column_attributes)",
      "    if (base::is.null(.ow_column_attribute_names)) .ow_column_attribute_names <- base::character()",
      "    if (base::anyNA(.ow_column_attribute_names) || base::any(.ow_column_attribute_names == \"\") || base::anyDuplicated.default(.ow_column_attribute_names)) base::stop(base::sprintf(\"Open Wrangler generated R received malformed attributes on %s\", .ow_column_label), call. = FALSE)",
      "    if (\"names\" %in% .ow_column_attribute_names) {",
      "      .ow_column_names <- base::attr(.ow_column, \"names\", exact = TRUE)",
      "      if (!base::is.character(.ow_column_names) || base::is.object(.ow_column_names) || !base::is.null(base::attributes(.ow_column_names)) || base::length(.ow_column_names) != .ow_column_length) base::stop(base::sprintf(\"Open Wrangler generated R received malformed names on %s\", .ow_column_label), call. = FALSE)",
      "      .ow_column_attribute_names <- .ow_column_attribute_names[.ow_column_attribute_names != \"names\"]",
      "    }",
      "    .ow_column_type <- base::typeof(.ow_column)",
      "    .ow_column_classes <- base::class(.ow_column)",
      "    .ow_allowed_column_attributes <- base::character()",
      "    if (base::identical(.ow_column_type, \"logical\") && base::identical(.ow_column_classes, \"logical\")) {",
      "      .ow_column_kind <- \"logical\"",
      "    } else if (base::identical(.ow_column_type, \"integer\") && base::identical(.ow_column_classes, \"integer\")) {",
      "      .ow_column_kind <- \"integer\"",
      "    } else if (base::identical(.ow_column_type, \"double\") && base::identical(.ow_column_classes, \"numeric\")) {",
      "      .ow_column_kind <- \"double\"",
      "    } else if (base::identical(.ow_column_type, \"character\") && base::identical(.ow_column_classes, \"character\")) {",
      "      .ow_column_kind <- \"character\"",
      "    } else if (base::identical(.ow_column_type, \"double\") && base::identical(.ow_column_classes, \"integer64\")) {",
      "      .ow_column_kind <- \"integer64\"; .ow_allowed_column_attributes <- \"class\"",
      "    } else if (base::identical(.ow_column_type, \"double\") && base::identical(.ow_column_classes, \"Date\")) {",
      "      .ow_column_kind <- \"date\"; .ow_allowed_column_attributes <- \"class\"",
      "    } else if (base::identical(.ow_column_type, \"double\") && base::identical(.ow_column_classes, c(\"POSIXct\", \"POSIXt\"))) {",
      "      .ow_column_kind <- \"datetime\"; .ow_allowed_column_attributes <- c(\"class\", \"tzone\")",
      "    } else if (base::identical(.ow_column_type, \"double\") && base::identical(.ow_column_classes, \"difftime\")) {",
      "      .ow_column_kind <- \"difftime\"; .ow_allowed_column_attributes <- c(\"class\", \"units\")",
      "    } else if (base::identical(.ow_column_type, \"integer\") && (base::identical(.ow_column_classes, \"factor\") || base::identical(.ow_column_classes, c(\"ordered\", \"factor\")))) {",
      "      .ow_column_kind <- \"factor\"; .ow_allowed_column_attributes <- c(\"class\", \"levels\")",
      "    } else {",
      "      base::stop(base::sprintf(\"Open Wrangler generated R received an unsupported type or class on %s\", .ow_column_label), call. = FALSE)",
      "    }",
      "    .ow_unsupported_column_attributes <- .ow_column_attribute_names[base::is.na(base::match(.ow_column_attribute_names, .ow_allowed_column_attributes))]",
      "    if (base::length(.ow_unsupported_column_attributes) != 0L) base::stop(base::sprintf(\"Open Wrangler generated R received unsupported attributes on %s: %s\", .ow_column_label, base::paste(.ow_unsupported_column_attributes, collapse = \", \")), call. = FALSE)",
      "    for (.ow_column_class in .ow_column_classes) .ow_spend_source_metadata(.ow_metadata_json_bytes(.ow_column_class) + 1L, \"source column-class metadata\")",
      "    if (base::identical(.ow_column_kind, \"datetime\") && \"tzone\" %in% .ow_column_attribute_names) {",
      "      .ow_column_timezone <- base::attr(.ow_column, \"tzone\", exact = TRUE)",
      "      if (!base::is.character(.ow_column_timezone) || base::length(base::unclass(.ow_column_timezone)) != 1L) base::stop(base::sprintf(\"Open Wrangler generated R received an unsupported timezone on %s\", .ow_column_label), call. = FALSE)",
      "      .ow_column_timezone_scalar <- base::.subset2(.ow_column_timezone, 1L)",
      "      if (base::is.na(.ow_column_timezone_scalar) || base::identical(base::Encoding(.ow_column_timezone_scalar), \"bytes\")) base::stop(base::sprintf(\"Open Wrangler generated R received an unsupported timezone on %s\", .ow_column_label), call. = FALSE)",
      "      .ow_column_timezone_from <- if (base::identical(base::Encoding(.ow_column_timezone_scalar), \"latin1\")) \"latin1\" else \"UTF-8\"",
      "      .ow_column_timezone_utf8 <- base::iconv(.ow_column_timezone_scalar, from = .ow_column_timezone_from, to = \"UTF-8\", sub = NA_character_)",
      sprintf(
        "      if (base::is.na(.ow_column_timezone_utf8) || base::nchar(.ow_column_timezone_utf8, type = \"bytes\") > %dL) base::stop(base::sprintf(\"Open Wrangler generated R received an unsupported timezone on %%s\", .ow_column_label), call. = FALSE)",
        maximum_name_bytes
      ),
      "      .ow_spend_source_metadata(.ow_metadata_json_bytes(.ow_column_timezone_utf8), \"source timezone metadata\")",
      "    }",
      "    if (base::identical(.ow_column_kind, \"difftime\")) {",
      "      .ow_column_units <- base::attr(.ow_column, \"units\", exact = TRUE)",
      "      if (!base::is.character(.ow_column_units) || base::length(base::unclass(.ow_column_units)) != 1L) base::stop(base::sprintf(\"Open Wrangler generated R received unsupported duration units on %s\", .ow_column_label), call. = FALSE)",
      "      .ow_column_units_scalar <- base::.subset2(.ow_column_units, 1L)",
      "      if (base::is.na(.ow_column_units_scalar) || !.ow_column_units_scalar %in% c(\"secs\", \"mins\", \"hours\", \"days\", \"weeks\")) base::stop(base::sprintf(\"Open Wrangler generated R received unsupported duration units on %s\", .ow_column_label), call. = FALSE)",
      "      .ow_spend_source_metadata(.ow_metadata_json_bytes(.ow_column_units_scalar), \"source duration-units metadata\")",
      "    }",
      "    if (base::identical(.ow_column_kind, \"factor\")) {",
      "      .ow_column_levels <- base::attr(.ow_column, \"levels\", exact = TRUE)",
      sprintf(
        "      if (!base::is.character(.ow_column_levels) || base::length(base::unclass(.ow_column_levels)) > %dL || base::anyDuplicated.default(.ow_column_levels)) base::stop(base::sprintf(\"Open Wrangler generated R received invalid factor levels on %%s\", .ow_column_label), call. = FALSE)",
        maximum_factor_levels
      ),
      "      for (.ow_level_index in base::seq_len(base::length(base::unclass(.ow_column_levels)))) {",
      "        .ow_level <- base::.subset2(.ow_column_levels, .ow_level_index)",
      "        if (base::is.na(.ow_level) || base::identical(base::Encoding(.ow_level), \"bytes\")) base::stop(base::sprintf(\"Open Wrangler generated R received invalid factor levels on %s\", .ow_column_label), call. = FALSE)",
      "        .ow_level_from <- if (base::identical(base::Encoding(.ow_level), \"latin1\")) \"latin1\" else \"UTF-8\"",
      "        .ow_level_utf8 <- base::iconv(.ow_level, from = .ow_level_from, to = \"UTF-8\", sub = NA_character_)",
      sprintf(
        "        if (base::is.na(.ow_level_utf8) || base::nchar(.ow_level_utf8, type = \"bytes\") > %dL) base::stop(base::sprintf(\"Open Wrangler generated R received invalid factor levels on %%s\", .ow_column_label), call. = FALSE)",
        maximum_text_bytes
      ),
      "        .ow_level_raw <- base::as.integer(base::charToRaw(.ow_level_utf8))",
      "        .ow_level_html_slash <- base::logical(base::length(.ow_level_raw))",
      "        if (base::length(.ow_level_raw) > 1L) .ow_level_html_slash[-1L] <- .ow_level_raw[-1L] == 47L & .ow_level_raw[-base::length(.ow_level_raw)] == 60L",
      "        .ow_level_json_bytes <- base::sum(base::ifelse(.ow_level_raw %in% c(8L, 9L, 10L, 12L, 13L, 34L, 92L) | .ow_level_html_slash, 2, base::ifelse(.ow_level_raw < 32L, 6, 1))) + 3",
      "        .ow_next_source_metadata_bytes <- .ow_source_metadata_bytes + base::as.double(.ow_level_json_bytes)",
      sprintf(
        "        if (!base::is.finite(.ow_next_source_metadata_bytes) || .ow_next_source_metadata_bytes > %dL) base::stop(\"Open Wrangler generated R received factor metadata above the %d-byte payload budget\", call. = FALSE)",
        maximum_payload_bytes,
        maximum_payload_bytes
      ),
      "        .ow_source_metadata_bytes <<- .ow_next_source_metadata_bytes",
      "      }",
      "      .ow_factor_codes <- base::unclass(.ow_column)",
      "      if (base::any(!base::is.na(.ow_factor_codes) & (.ow_factor_codes < 1L | .ow_factor_codes > base::length(base::unclass(.ow_column_levels))))) base::stop(base::sprintf(\"Open Wrangler generated R received invalid factor codes on %s\", .ow_column_label), call. = FALSE)",
      "    }",
      "    base::invisible(NULL)",
      "  }",
      "  for (.ow_source_column_index in base::seq_len(.ow_source_column_count)) .ow_validate_source_column(base::.subset2(.ow_source_columns, .ow_source_column_index), .ow_source_column_index)",
      "  .ow_source_element_names <- base::lapply(base::seq_len(.ow_source_column_count), function(.ow_source_column_index) base::attr(base::.subset2(.ow_source_columns, .ow_source_column_index), \"names\", exact = TRUE))",
      "  .ow_source_metadata_classes <- if (.ow_source_is_readr) c(\"tbl_df\", \"tbl\", \"data.frame\") else .ow_source_classes",
      "  for (.ow_source_frame_class in .ow_source_metadata_classes) .ow_spend_source_metadata(.ow_metadata_json_bytes(.ow_source_frame_class) + 1L, \"source dataframe-class metadata\")",
      "  if (base::identical(.ow_source_flavor, \"r.data.table\") && base::length(.ow_source_key) != 0L) { for (.ow_source_key_name in .ow_source_key) { .ow_source_key_position <- base::match(.ow_source_key_name, .ow_source_names); .ow_spend_source_metadata(.ow_metadata_json_bytes(base::sprintf(\"r:c:%d\", .ow_source_key_position - 1L)) + 1L, \"source data.table key metadata\") } }",
      "  .ow_result <- if (inherits(.ow_source, \"data.table\")) {",
      "    if (!requireNamespace(\"data.table\", quietly = TRUE)) stop(\"data.table is required\", call. = FALSE)",
      "    data.table::copy(.ow_source)",
      "  } else {",
      "    unserialize(serialize(.ow_source, NULL, version = 3L))",
      "  }",
      "  if (base::identical(.ow_source_flavor, \"r.data.table\")) { for (.ow_source_column_index in base::seq_len(.ow_source_column_count)) { .ow_source_element_names_value <- base::.subset2(.ow_source_element_names, .ow_source_column_index); if (!base::is.null(.ow_source_element_names_value)) data.table::setattr(base::.subset2(.ow_result, .ow_source_column_index), \"names\", .ow_source_element_names_value) } }",
      "  if (identical(class(.ow_result), c(\"spec_tbl_df\", \"tbl_df\", \"tbl\", \"data.frame\"))) {",
      "    attr(.ow_result, \"spec\") <- NULL",
      "    attr(.ow_result, \"problems\") <- NULL",
      "    class(.ow_result) <- c(\"tbl_df\", \"tbl\", \"data.frame\")",
      "  }",
      "  .ow_result_ids <- base::sprintf(\"r:c:%d\", base::seq_len(.ow_source_column_count) - 1L)"
    )
    if (
      any(vapply(
        bound_plan,
        function(step) {
          identical(step$kind, "formula") ||
            (identical(step$kind, "formatDatetime") && !isTRUE(step$inPlace)) ||
            step$kind %in% c("oneHotEncode", "multiLabelBinarize")
        },
        logical(1L)
      ))
    ) {
      lines <- c(
        lines,
        "  .ow_data_table_alloccol <- NULL",
        "  if (base::identical(.ow_source_flavor, \"r.data.table\")) {",
        "    .ow_data_table_namespace <- base::asNamespace(\"data.table\")",
        "    .ow_data_table_namespace_dlls <- base::getNamespaceInfo(.ow_data_table_namespace, \"DLLs\")",
        "    .ow_data_table_namespace_routines <- base::getNamespaceInfo(.ow_data_table_namespace, \"nativeRoutines\")",
        "    if (!base::is.list(.ow_data_table_namespace_dlls) || base::length(.ow_data_table_namespace_dlls) != 1L || !base::is.list(.ow_data_table_namespace_routines) || base::length(.ow_data_table_namespace_routines) != 1L || !base::exists(\"Calloccolwrapper\", envir = .ow_data_table_namespace, inherits = FALSE) || base::bindingIsActive(\"Calloccolwrapper\", .ow_data_table_namespace) || !base::bindingIsLocked(\"Calloccolwrapper\", .ow_data_table_namespace)) base::stop(\"data.table has unavailable or mutable append primitives\", call. = FALSE)",
        "    .ow_data_table_dll <- .ow_data_table_namespace_dlls[[1L]]",
        "    .ow_data_table_routine_map <- .ow_data_table_namespace_routines[[1L]]",
        "    .ow_data_table_binding <- base::get(\"Calloccolwrapper\", envir = .ow_data_table_namespace, inherits = FALSE)",
        "    .ow_data_table_dll_fields <- base::unclass(.ow_data_table_dll)",
        "    .ow_data_table_alloccol <- base::tryCatch(base::getNativeSymbolInfo(\"Calloccolwrapper\", PACKAGE = base::.subset2(.ow_data_table_dll_fields, \"info\"), withRegistrationInfo = FALSE), error = function(.ow_error) NULL)",
        "    .ow_data_table_binding_fields <- base::unclass(.ow_data_table_binding)",
        "    .ow_data_table_alloccol_fields <- if (base::is.null(.ow_data_table_alloccol)) NULL else base::unclass(.ow_data_table_alloccol)",
        "    if (!base::inherits(.ow_data_table_dll, \"DLLInfo\") || !base::identical(base::.subset2(.ow_data_table_dll_fields, \"name\"), \"data_table\") || !base::identical(base::.subset2(.ow_data_table_dll_fields, \"dynamicLookup\"), FALSE) || !base::is.character(.ow_data_table_routine_map) || !base::identical(base::.subset2(.ow_data_table_routine_map, \"Calloccolwrapper\"), \"Calloccolwrapper\") || !base::identical(base::class(.ow_data_table_binding), c(\"CallRoutine\", \"NativeSymbolInfo\")) || !base::identical(base::attr(.ow_data_table_binding, \"names\", exact = TRUE), c(\"name\", \"address\", \"dll\", \"numParameters\")) || !base::identical(base::.subset2(.ow_data_table_binding_fields, \"name\"), \"Calloccolwrapper\") || !base::identical(base::.subset2(.ow_data_table_binding_fields, \"numParameters\"), -1L) || !base::identical(base::.subset2(.ow_data_table_binding_fields, \"dll\"), .ow_data_table_dll) || !base::inherits(base::.subset2(.ow_data_table_binding_fields, \"address\"), \"RegisteredNativeSymbol\") || base::is.null(.ow_data_table_alloccol) || !base::identical(base::.subset2(.ow_data_table_alloccol_fields, \"name\"), \"Calloccolwrapper\") || !base::identical(base::.subset2(.ow_data_table_alloccol_fields, \"numParameters\"), -1L) || !base::identical(base::.subset2(.ow_data_table_alloccol_fields, \"dll\"), .ow_data_table_dll) || !base::inherits(base::.subset2(.ow_data_table_alloccol_fields, \"address\"), \"NativeSymbol\")) base::stop(\"data.table has invalid append primitives\", call. = FALSE)",
        "  }"
      )
    }
    if (any(vapply(bound_plan, function(step) identical(step$kind, "castColumn"), logical(1L)))) {
      lines <- c(lines, cast_code_helper_lines())
    }
    if (any(vapply(bound_plan, function(step) identical(step$kind, "fillMissingValues"), logical(1L)))) {
      lines <- c(lines, fill_missing_code_helper_lines())
    }
    if (any(vapply(bound_plan, function(step) identical(step$kind, "groupBy"), logical(1L)))) {
      lines <- c(lines, group_by_code_helper_lines())
    }
    if (any(vapply(bound_plan, function(step) identical(step$kind, "byExample"), logical(1L)))) {
      lines <- c(lines, by_example_code_helper_lines())
    }
    if (any(vapply(bound_plan, function(step) identical(step$kind, "customCode"), logical(1L)))) {
      lines <- c(lines, custom_code_helper_lines(
        maximum_columns,
        maximum_factor_levels,
        maximum_text_bytes,
        maximum_payload_bytes,
        maximum_name_bytes
      ))
    }
    if (any(vapply(
      bound_plan,
      function(step) step$kind %in% c("oneHotEncode", "multiLabelBinarize"),
      logical(1L)
    ))) {
      lines <- c(lines, categorical_code_helper_lines())
    }
    if (any(vapply(
      bound_plan,
      function(step) identical(step$kind, "roundNumber") && identical(step$semanticKind, "integer64"),
      logical(1L)
    ))) {
      lines <- c(lines, round_integer64_code_helper_lines())
    }
    if (any(vapply(bound_plan, function(step) identical(step$kind, "minMaxScale"), logical(1L)))) {
      lines <- c(lines, min_max_scale_code_helper_lines())
    }
    if (any(vapply(
      bound_plan,
      function(step) {
        if (step$kind %in% c("oneHotEncode", "multiLabelBinarize")) {
          return(any(vapply(
            step$columns,
            function(column) identical(column$semanticsKind, "integer64"),
            logical(1L)
          )))
        }
        if (!identical(step$kind, "formula")) return(FALSE)
        identical(step$left$semanticKind, "integer64") ||
          (!is.null(step$right) && identical(step$right$semanticKind, "integer64"))
      },
      logical(1L)
    ))) {
      lines <- c(
        lines,
        "  if (!base::requireNamespace(\"bit64\", quietly = TRUE)) base::stop(\"bit64 is required for integer64 Formula\", call. = FALSE)",
        "  .ow_integer64_namespace <- base::asNamespace(\"bit64\")",
        "  .ow_integer64_namespace_dlls <- base::getNamespaceInfo(.ow_integer64_namespace, \"DLLs\")",
        "  .ow_integer64_namespace_routines <- base::getNamespaceInfo(.ow_integer64_namespace, \"nativeRoutines\")",
        "  if (!base::is.list(.ow_integer64_namespace_dlls) || base::length(.ow_integer64_namespace_dlls) != 1L || !base::is.list(.ow_integer64_namespace_routines) || base::length(.ow_integer64_namespace_routines) != 1L) base::stop(\"bit64 has invalid integer64 Formula native registration metadata\", call. = FALSE)",
        "  .ow_integer64_dll <- .ow_integer64_namespace_dlls[[1L]]",
        "  .ow_integer64_routine_map <- .ow_integer64_namespace_routines[[1L]]",
        "  .ow_integer64_dll_fields <- base::unclass(.ow_integer64_dll)",
        "  if (!base::inherits(.ow_integer64_dll, \"DLLInfo\") || !base::identical(base::.subset2(.ow_integer64_dll_fields, \"name\"), \"bit64\") || !base::identical(base::.subset2(.ow_integer64_dll_fields, \"dynamicLookup\"), FALSE) || !base::identical(base::.subset2(.ow_integer64_dll_fields, \"forceSymbols\"), TRUE) || !base::is.character(.ow_integer64_routine_map) || base::is.null(base::names(.ow_integer64_routine_map))) base::stop(\"bit64 has invalid integer64 Formula native registration metadata\", call. = FALSE)",
        "  .ow_integer64_all_binding_names <- base::names(.ow_integer64_routine_map)",
        "  .ow_integer64_binding <- function(.ow_binding_name, .ow_native_name, .ow_parameters) {",
        "    if (!base::exists(.ow_binding_name, envir = .ow_integer64_namespace, inherits = FALSE) || base::bindingIsActive(.ow_binding_name, .ow_integer64_namespace) || !base::bindingIsLocked(.ow_binding_name, .ow_integer64_namespace)) base::stop(\"bit64 has unavailable or mutable integer64 Formula primitives\", call. = FALSE)",
        "    .ow_primitive <- base::get(.ow_binding_name, envir = .ow_integer64_namespace, inherits = FALSE)",
        "    .ow_canonical <- base::tryCatch(base::getNativeSymbolInfo(.ow_native_name, PACKAGE = base::.subset2(.ow_integer64_dll_fields, \"info\"), withRegistrationInfo = FALSE), error = function(.ow_error) NULL)",
        "    .ow_primitive_fields <- base::unclass(.ow_primitive)",
        "    .ow_canonical_fields <- if (base::is.null(.ow_canonical)) NULL else base::unclass(.ow_canonical)",
        "    if (!base::identical(base::.subset2(.ow_integer64_routine_map, .ow_binding_name), .ow_native_name) || !base::identical(base::class(.ow_primitive), c(\"CallRoutine\", \"NativeSymbolInfo\")) || !base::identical(base::attr(.ow_primitive, \"names\", exact = TRUE), c(\"name\", \"address\", \"dll\", \"numParameters\")) || !base::identical(base::.subset2(.ow_primitive_fields, \"name\"), .ow_native_name) || !base::identical(base::.subset2(.ow_primitive_fields, \"numParameters\"), .ow_parameters) || !base::inherits(base::.subset2(.ow_primitive_fields, \"address\"), \"RegisteredNativeSymbol\") || !base::identical(base::.subset2(.ow_primitive_fields, \"dll\"), .ow_integer64_dll) || base::is.null(.ow_canonical) || !base::identical(base::class(.ow_canonical), c(\"CallRoutine\", \"NativeSymbolInfo\")) || !base::identical(base::.subset2(.ow_canonical_fields, \"name\"), .ow_native_name) || !base::identical(base::.subset2(.ow_canonical_fields, \"numParameters\"), .ow_parameters) || !base::identical(base::.subset2(.ow_canonical_fields, \"dll\"), .ow_integer64_dll) || !base::inherits(base::.subset2(.ow_canonical_fields, \"address\"), \"NativeSymbol\")) base::stop(\"bit64 has invalid integer64 Formula primitives\", call. = FALSE)",
        "    for (.ow_other_binding_name in .ow_integer64_all_binding_names) {",
        "      if (base::identical(.ow_other_binding_name, .ow_binding_name) || !base::exists(.ow_other_binding_name, envir = .ow_integer64_namespace, inherits = FALSE) || base::bindingIsActive(.ow_other_binding_name, .ow_integer64_namespace)) next",
        "      .ow_other_primitive <- base::get(.ow_other_binding_name, envir = .ow_integer64_namespace, inherits = FALSE)",
        "      if (base::is.list(.ow_other_primitive)) { .ow_other_fields <- base::unclass(.ow_other_primitive); if (!base::is.null(base::.subset2(.ow_other_fields, \"address\")) && base::identical(base::.subset2(.ow_primitive_fields, \"address\"), base::.subset2(.ow_other_fields, \"address\"))) base::stop(\"bit64 has replaced integer64 Formula primitive addresses\", call. = FALSE) }",
        "    }",
        "    .ow_canonical",
        "  }",
        "  .ow_integer64_as_integer <- .ow_integer64_binding(\"C_as_integer64_integer\", \"as_integer64_integer\", 2L)",
        "  .ow_integer64_as_double <- .ow_integer64_binding(\"C_as_double_integer64\", \"as_double_integer64\", 2L)",
        "  .ow_integer64_as_character <- .ow_integer64_binding(\"C_as_character_integer64\", \"as_character_integer64\", 2L)",
        "  .ow_integer64_is_na <- .ow_integer64_binding(\"C_isna_integer64\", \"isna_integer64\", 2L)",
        "  .ow_integer64_add <- .ow_integer64_binding(\"C_plus_integer64\", \"plus_integer64\", 3L)",
        "  .ow_integer64_subtract <- .ow_integer64_binding(\"C_minus_integer64\", \"minus_integer64\", 3L)",
        "  .ow_integer64_multiply <- .ow_integer64_binding(\"C_times_integer64_integer64\", \"times_integer64_integer64\", 3L)",
        "  .ow_integer64_modulo <- .ow_integer64_binding(\"C_mod_integer64\", \"mod_integer64\", 3L)",
        "  .ow_integer64_from_integer <- function(.ow_values) { .ow_output <- base::.Call(.ow_integer64_as_integer, .ow_values, base::double(.ow_storage_length(.ow_values))); .ow_names <- base::attr(.ow_values, \"names\", exact = TRUE); base::attributes(.ow_output) <- if (base::is.null(.ow_names)) base::list(class = \"integer64\") else base::list(class = \"integer64\", names = .ow_names); .ow_output }",
        "  .ow_integer64_to_double <- function(.ow_values) { .ow_output <- base::.Call(.ow_integer64_as_double, .ow_values, base::double(.ow_storage_length(.ow_values))); .ow_names <- base::attr(.ow_values, \"names\", exact = TRUE); if (!base::is.null(.ow_names)) base::attr(.ow_output, \"names\") <- .ow_names; .ow_output }",
        "  .ow_integer64_missing_mask <- function(.ow_values) base::.Call(.ow_integer64_is_na, .ow_values, base::logical(.ow_storage_length(.ow_values)))",
        "  .ow_integer64_binary <- function(.ow_primitive, .ow_left, .ow_right) { if (!base::inherits(.ow_left, \"integer64\")) .ow_left <- .ow_integer64_from_integer(.ow_left); if (!base::inherits(.ow_right, \"integer64\")) .ow_right <- .ow_integer64_from_integer(.ow_right); .ow_left_length <- .ow_storage_length(.ow_left); .ow_right_length <- .ow_storage_length(.ow_right); .ow_length <- if (.ow_left_length == 0L || .ow_right_length == 0L) 0L else base::max(.ow_left_length, .ow_right_length); .ow_output <- base::.Call(.ow_primitive, .ow_left, .ow_right, base::double(.ow_length)); .ow_names <- if (.ow_left_length == .ow_length && !base::is.null(base::attr(.ow_left, \"names\", exact = TRUE))) base::attr(.ow_left, \"names\", exact = TRUE) else if (.ow_right_length == .ow_length && !base::is.null(base::attr(.ow_right, \"names\", exact = TRUE))) base::attr(.ow_right, \"names\", exact = TRUE) else NULL; base::attributes(.ow_output) <- if (base::is.null(.ow_names)) base::list(class = \"integer64\") else base::list(class = \"integer64\", names = .ow_names); .ow_output }",
        "  .ow_integer64_missing <- .ow_integer64_from_integer(NA_integer_)",
        "  .ow_integer64_force_missing <- function(.ow_values, .ow_missing) { .ow_storage <- base::unclass(.ow_values); .ow_storage[.ow_missing] <- base::unclass(.ow_integer64_missing)[[1L]]; .ow_names <- base::attr(.ow_values, \"names\", exact = TRUE); base::attributes(.ow_storage) <- if (base::is.null(.ow_names)) base::list(class = \"integer64\") else base::list(class = \"integer64\", names = .ow_names); .ow_storage }"
      )
    }
    for (step in bound_plan) {
      if (identical(step$kind, "sortRows")) {
        lines <- c(lines, row_step_code_lines(step))
      } else if (identical(step$kind, "filterRows")) {
        lines <- c(lines, row_step_code_lines(step))
      } else if (step$kind %in% c("dropMissingRows", "dropDuplicates")) {
        lines <- c(lines, row_reduction_code_lines(step))
      } else if (identical(step$kind, "customCode")) {
        lines <- c(
          lines,
          "  .ow_custom_input_names <- base::attr(.ow_result, \"names\", exact = TRUE)",
          "  .ow_custom_input_names <- base::unclass(.ow_custom_input_names); base::attributes(.ow_custom_input_names) <- NULL",
          "  .ow_custom_input_ids <- .ow_result_ids",
          sprintf("  .ow_custom_code <- %s", r_string(step$params$code)),
          "  .ow_custom_expressions <- base::parse(text = .ow_custom_code, keep.source = FALSE)",
          sprintf(
            "  .ow_custom_run_result <- .ow_custom_run(.ow_custom_expressions, .ow_result, .ow_custom_parent_environment, %s, %s)",
            r_string(variable_name),
            r_string(result_name)
          ),
          "  .ow_result <- base::.subset2(.ow_custom_run_result, \"value\"); .ow_custom_metadata_bytes <- base::.subset2(.ow_custom_run_result, \"metadataBytes\")",
          "  .ow_custom_output_names <- base::attr(.ow_result, \"names\", exact = TRUE)",
          "  .ow_custom_output_names <- base::unclass(.ow_custom_output_names); base::attributes(.ow_custom_output_names) <- NULL",
          "  .ow_custom_consumed <- base::logical(base::length(.ow_custom_input_ids)); .ow_custom_created <- 0L",
          sprintf("  .ow_custom_step_id <- %s", r_string(step$id)),
          "  .ow_result_ids <- base::vapply(base::seq_along(.ow_custom_output_names), function(.ow_position) {",
          "    .ow_matches <- base::which(!.ow_custom_consumed & .ow_custom_input_names == base::.subset2(.ow_custom_output_names, .ow_position))",
          "    if (base::length(.ow_matches) != 0L) { .ow_match <- base::.subset2(.ow_matches, 1L); .ow_custom_consumed[[.ow_match]] <<- TRUE; return(base::.subset2(.ow_custom_input_ids, .ow_match)) }",
          "    .ow_id <- base::sprintf(\"c:step:%s:%d\", .ow_custom_step_id, .ow_custom_created); .ow_custom_created <<- .ow_custom_created + 1L; .ow_id",
          "  }, base::character(1L), USE.NAMES = FALSE)",
          "  if (base::anyDuplicated.default(.ow_result_ids)) base::stop(\"Open Wrangler Custom Code produced conflicting output identities\", call. = FALSE)",
          "  .ow_custom_validate_identity_budget(.ow_custom_metadata_bytes, .ow_result, .ow_result_ids)"
        )
      } else if (identical(step$kind, "groupBy")) {
        key_specs <- vapply(step$keys, r_group_spec, character(1L), USE.NAMES = FALSE)
        aggregation_specs <- vapply(
          step$aggregations,
          r_group_spec,
          character(1L),
          aggregation = TRUE,
          USE.NAMES = FALSE
        )
        guard_lines <- character()
        guarded <- c(step$keys, step$aggregations)
        for (guard_index in seq_along(guarded)) {
          guard_lines <- c(
            guard_lines,
            row_column_lines(guarded[[guard_index]], sprintf(".ow_group_source_%d", guard_index))
          )
        }
        lines <- c(
          lines,
          guard_lines,
          sprintf("  .ow_result <- .ow_group_by(.ow_result, list(%s),", paste(key_specs, collapse = ", ")),
          sprintf("    list(%s))", paste(aggregation_specs, collapse = ", ")),
          sprintf(
            "  .ow_result_ids <- c(.ow_result_ids[c(%s)], %s)",
            paste(vapply(step$keys, function(key) sprintf("%dL", key$position), character(1L)), collapse = ", "),
            r_character_vector(vapply(step$aggregations, `[[`, character(1L), "outputId", USE.NAMES = FALSE))
          )
        )
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
          "  .ow_clone_frame_names <- base::unclass(base::attr(.ow_result, \"names\", exact = TRUE)); base::attributes(.ow_clone_frame_names) <- NULL",
          "  if (ncol(.ow_result) < .ow_clone_position || !base::identical(base::.subset2(.ow_clone_frame_names, .ow_clone_position), .ow_clone_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (.ow_clone_name == \"\" || base::any(.ow_clone_frame_names == .ow_clone_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
          sprintf(
            "  if (ncol(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
            maximum_columns
          ),
          "  .ow_clone_element_names <- base::attr(base::.subset2(.ow_result, .ow_clone_position), \"names\", exact = TRUE)",
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    data.table::setattr(.ow_result, \"names\", .ow_clone_frame_names)",
          "    data.table::set(.ow_result, j = .ow_clone_name, value = base::.subset2(.ow_result, .ow_clone_position))",
          "    if (!base::is.null(.ow_clone_element_names)) data.table::setattr(base::.subset2(.ow_result, ncol(.ow_result)), \"names\", .ow_clone_element_names)",
          "  } else {",
          "    .ow_clone_frame_attributes <- base::attributes(.ow_result)",
          "    .ow_clone_columns <- base::unclass(.ow_result)",
          "    .ow_clone_columns[[base::length(.ow_clone_columns) + 1L]] <- base::.subset2(.ow_clone_columns, .ow_clone_position)",
          "    .ow_clone_frame_attributes[[\"names\"]] <- c(.ow_clone_frame_names, .ow_clone_name)",
          "    base::attributes(.ow_clone_columns) <- .ow_clone_frame_attributes",
          "    .ow_result <- .ow_clone_columns",
          "  }",
          sprintf("  .ow_result_ids <- c(.ow_result_ids, %s)", r_string(step$outputId))
        )
      } else if (identical(step$kind, "byExample")) {
        positions <- vapply(step$sourceColumns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
        expected_names <- vapply(step$sourceColumns, `[[`, character(1L), "name", USE.NAMES = FALSE)
        type_guard <- switch(
          step$resultKind,
          character = "base::is.character(.ow_by_example_values) && !base::is.object(.ow_by_example_values)",
          factor = "base::is.factor(.ow_by_example_values)",
          integer = "base::is.integer(.ow_by_example_values) && !base::is.object(.ow_by_example_values)",
          integer64 = "base::identical(base::class(.ow_by_example_values), \"integer64\")",
          double = "base::is.double(.ow_by_example_values) && !base::is.object(.ow_by_example_values)",
          logical = "base::is.logical(.ow_by_example_values) && !base::is.object(.ow_by_example_values)",
          date = "base::identical(base::class(.ow_by_example_values), \"Date\")",
          datetime = "base::identical(base::class(.ow_by_example_values), c(\"POSIXct\", \"POSIXt\"))",
          difftime = "base::identical(base::class(.ow_by_example_values), \"difftime\")",
          abort("runtime_error", "The bound R by-example result kind is unsupported")
        )
        lines <- c(
          lines,
          sprintf("  .ow_by_example_positions <- c(%s)", paste(sprintf("%dL", positions), collapse = ", ")),
          sprintf("  .ow_by_example_names <- %s", r_character_vector(expected_names)),
          sprintf("  .ow_by_example_name <- %s", r_string(step$newName)),
          "  .ow_by_example_frame_names <- .ow_by_example_normalize_frame_names(.ow_result)",
          "  if (base::any(.ow_by_example_positions > .ow_storage_length(.ow_result)) || !base::identical(.ow_by_example_frame_names[.ow_by_example_positions], .ow_by_example_names)) base::stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  .ow_by_example_row_count <- base::as.double(.ow_storage_length(base::.subset2(.ow_result, base::.subset2(.ow_by_example_positions, 1L))))",
          "  if (!base::is.finite(.ow_by_example_row_count) || .ow_by_example_row_count != base::floor(.ow_by_example_row_count) || .ow_by_example_row_count > .Machine$integer.max) base::stop(\"Open Wrangler by-example received an invalid current row count\", call. = FALSE)",
          "  if (.ow_by_example_name == \"\" || base::any(.ow_by_example_frame_names == .ow_by_example_name)) base::stop(\"Open Wrangler column name already exists\", call. = FALSE)",
          "  if (base::startsWith(base::chartr(\"ABCDEFGHIJKLMNOPQRSTUVWXYZ\", \"abcdefghijklmnopqrstuvwxyz\", .ow_by_example_name), \"__open_wrangler_internal_row_id_\")) base::stop(\"Open Wrangler's private row-identity prefix is reserved\", call. = FALSE)",
          sprintf(
            "  if (.ow_storage_length(.ow_result) >= %dL) base::stop(\"Open Wrangler column limit reached\", call. = FALSE)",
            maximum_columns
          ),
          sprintf(
            "  .ow_by_example_values <- .ow_by_example_evaluate(%s, base::lapply(.ow_by_example_positions, function(.ow_position) .ow_result[[.ow_position]]))",
            r_by_example_value(step$program)
          ),
          sprintf(
            "  if (.ow_storage_length(.ow_by_example_values) != .ow_by_example_row_count || !(%s)) base::stop(\"Open Wrangler by-example returned an invalid result type or row count\", call. = FALSE)",
            type_guard
          ),
          "  .ow_by_example_output_bytes <- .ow_by_example_row_count * if (base::is.logical(.ow_by_example_values) || base::is.integer(.ow_by_example_values)) 4 else 8",
          if (identical(step$resultKind, "character")) {
            sprintf(
              paste0(
                "  if (base::any(!base::is.na(.ow_by_example_values) & base::nchar(.ow_by_example_values, type = \"bytes\") > %dL)) ",
                "base::stop(\"Open Wrangler by-example produced oversized text\", call. = FALSE)"
              ),
              maximum_text_bytes
            )
          } else character(),
          if (identical(step$resultKind, "character")) {
            "  .ow_by_example_output_bytes <- .ow_by_example_output_bytes + base::sum(base::as.double(base::nchar(.ow_by_example_values[!base::is.na(.ow_by_example_values)], type = \"bytes\")))"
          } else character(),
          sprintf("  .ow_by_example_result_kind <- %s", r_string(step$resultKind)),
          "  .ow_by_example_attribute_names <- base::names(base::attributes(.ow_by_example_values))",
          "  if (base::is.null(.ow_by_example_attribute_names)) .ow_by_example_attribute_names <- base::character()",
          "  if (base::anyNA(.ow_by_example_attribute_names) || base::any(.ow_by_example_attribute_names == \"\") || base::anyDuplicated.default(.ow_by_example_attribute_names)) base::stop(\"Open Wrangler by-example returned malformed output attributes\", call. = FALSE)",
          "  .ow_by_example_semantic_attribute_names <- .ow_by_example_attribute_names[.ow_by_example_attribute_names != \"names\"]",
          "  .ow_by_example_attributes_valid <- if (.ow_by_example_result_kind == \"factor\") { base::length(.ow_by_example_semantic_attribute_names) == 2L && base::all(.ow_by_example_semantic_attribute_names %in% c(\"levels\", \"class\")) } else if (.ow_by_example_result_kind %in% c(\"integer64\", \"date\")) { base::identical(.ow_by_example_semantic_attribute_names, \"class\") } else if (.ow_by_example_result_kind == \"datetime\") { base::identical(.ow_by_example_semantic_attribute_names, \"class\") || (base::length(.ow_by_example_semantic_attribute_names) == 2L && base::all(.ow_by_example_semantic_attribute_names %in% c(\"class\", \"tzone\"))) } else if (.ow_by_example_result_kind == \"difftime\") { base::length(.ow_by_example_semantic_attribute_names) == 2L && base::all(.ow_by_example_semantic_attribute_names %in% c(\"class\", \"units\")) } else { base::length(.ow_by_example_semantic_attribute_names) == 0L }",
          "  if (!base::isTRUE(.ow_by_example_attributes_valid)) base::stop(\"Open Wrangler by-example returned unsupported output attributes\", call. = FALSE)",
          "  .ow_by_example_metadata_text <- function(.ow_metadata, .ow_label, .ow_maximum_bytes, .ow_allow_asis = FALSE) {",
          "    .ow_metadata_attributes <- base::attributes(.ow_metadata)",
          "    if (!base::is.null(.ow_metadata_attributes)) {",
          "      if (!base::isTRUE(.ow_allow_asis) || !base::identical(base::names(.ow_metadata_attributes), \"class\") || !base::identical(base::.subset2(.ow_metadata_attributes, \"class\"), \"AsIs\") || !base::is.null(base::attributes(base::.subset2(.ow_metadata_attributes, \"class\")))) base::stop(base::sprintf(\"Open Wrangler by-example returned unsupported nested attributes on %s\", .ow_label), call. = FALSE)",
          "      .ow_by_example_output_bytes <<- .ow_by_example_output_bytes + 8 + base::nchar(\"AsIs\", type = \"bytes\")",
          "    }",
          "    .ow_plain <- base::unclass(.ow_metadata)",
          "    if (!base::is.character(.ow_plain) || base::anyNA(.ow_plain)) base::stop(base::sprintf(\"Open Wrangler by-example returned invalid %s\", .ow_label), call. = FALSE)",
          "    .ow_plain <- base::vapply(base::seq_len(base::length(.ow_plain)), function(.ow_metadata_index) {",
          "      .ow_item <- base::.subset2(.ow_plain, .ow_metadata_index)",
          "      if (base::identical(base::Encoding(.ow_item), \"bytes\")) base::stop(base::sprintf(\"Open Wrangler by-example returned invalid %s\", .ow_label), call. = FALSE)",
          "      .ow_from <- if (base::identical(base::Encoding(.ow_item), \"latin1\")) \"latin1\" else \"UTF-8\"",
          "      .ow_utf8 <- base::iconv(.ow_item, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
          "      if (base::is.na(.ow_utf8) || base::nchar(.ow_utf8, type = \"bytes\") > .ow_maximum_bytes) base::stop(base::sprintf(\"Open Wrangler by-example returned oversized or invalid %s\", .ow_label), call. = FALSE)",
          "      .ow_utf8",
          "    }, base::character(1L), USE.NAMES = FALSE)",
          "    .ow_by_example_output_bytes <<- .ow_by_example_output_bytes + base::as.double(base::length(.ow_plain)) * 8 + base::sum(base::as.double(base::nchar(.ow_plain, type = \"bytes\")))",
          "    .ow_plain",
          "  }",
          "  if (.ow_by_example_result_kind %in% c(\"factor\", \"integer64\", \"date\", \"datetime\", \"difftime\")) {",
          sprintf(
            "    .ow_by_example_class <- .ow_by_example_metadata_text(base::attr(.ow_by_example_values, \"class\", exact = TRUE), \"output class\", %dL)",
            maximum_name_bytes
          ),
          "    if (!base::identical(.ow_by_example_class, base::class(.ow_by_example_values))) base::stop(\"Open Wrangler by-example returned invalid output class metadata\", call. = FALSE)",
          "  }",
          "  if (.ow_by_example_result_kind == \"factor\") {",
          sprintf(
            "    .ow_by_example_levels <- .ow_by_example_metadata_text(base::attr(.ow_by_example_values, \"levels\", exact = TRUE), \"factor levels\", %dL, TRUE)",
            maximum_text_bytes
          ),
          sprintf(
            "    if (base::length(.ow_by_example_levels) > %dL || base::anyDuplicated.default(.ow_by_example_levels)) base::stop(\"Open Wrangler by-example returned invalid factor levels\", call. = FALSE)",
            maximum_factor_levels
          ),
          "    .ow_by_example_factor_codes <- base::unclass(.ow_by_example_values)",
          "    if (base::any(!base::is.na(.ow_by_example_factor_codes) & (.ow_by_example_factor_codes < 1L | .ow_by_example_factor_codes > base::length(.ow_by_example_levels)))) base::stop(\"Open Wrangler by-example returned invalid factor codes\", call. = FALSE)",
          "  }",
          "  if (.ow_by_example_result_kind == \"datetime\" && \"tzone\" %in% .ow_by_example_semantic_attribute_names) {",
          sprintf(
            "    .ow_by_example_timezone <- .ow_by_example_metadata_text(base::attr(.ow_by_example_values, \"tzone\", exact = TRUE), \"datetime timezone\", %dL, TRUE)",
            maximum_name_bytes
          ),
          "    if (base::length(.ow_by_example_timezone) != 1L) base::stop(\"Open Wrangler by-example returned invalid datetime timezone metadata\", call. = FALSE)",
          "  }",
          "  if (.ow_by_example_result_kind == \"difftime\") {",
          sprintf(
            "    .ow_by_example_units <- .ow_by_example_metadata_text(base::attr(.ow_by_example_values, \"units\", exact = TRUE), \"duration units\", %dL, TRUE)",
            maximum_name_bytes
          ),
          "    if (base::length(.ow_by_example_units) != 1L || !base::.subset2(.ow_by_example_units, 1L) %in% c(\"secs\", \"mins\", \"hours\", \"days\", \"weeks\")) base::stop(\"Open Wrangler by-example returned invalid duration units\", call. = FALSE)",
          "  }",
          "  .ow_by_example_value_names <- base::attr(.ow_by_example_values, \"names\", exact = TRUE)",
          "  if (!base::is.null(.ow_by_example_value_names)) {",
          "    if (!base::is.character(.ow_by_example_value_names) || base::is.object(.ow_by_example_value_names) || !base::is.null(base::attributes(.ow_by_example_value_names)) || base::length(.ow_by_example_value_names) != .ow_by_example_row_count) base::stop(\"Open Wrangler by-example returned invalid output names\", call. = FALSE)",
          "    .ow_by_example_value_names <- base::vapply(base::seq_len(.ow_by_example_row_count), function(.ow_name_index) {",
          "      .ow_name <- base::.subset2(.ow_by_example_value_names, .ow_name_index)",
          "      if (base::is.na(.ow_name)) return(NA_character_)",
          "      if (base::identical(base::Encoding(.ow_name), \"bytes\")) base::stop(\"Open Wrangler by-example returned invalid output names\", call. = FALSE)",
          "      .ow_name_from <- if (base::identical(base::Encoding(.ow_name), \"latin1\")) \"latin1\" else \"UTF-8\"",
          "      .ow_name_utf8 <- base::iconv(.ow_name, from = .ow_name_from, to = \"UTF-8\", sub = NA_character_)",
          sprintf(
            "      if (base::is.na(.ow_name_utf8) || base::nchar(.ow_name_utf8, type = \"bytes\") > %dL) base::stop(\"Open Wrangler by-example returned oversized or invalid output names\", call. = FALSE)",
            maximum_text_bytes
          ),
          "      .ow_name_utf8",
          "    }, base::character(1L), USE.NAMES = FALSE)",
          "    .ow_by_example_output_bytes <- .ow_by_example_output_bytes + .ow_by_example_row_count * 8 + base::sum(base::as.double(base::nchar(.ow_by_example_value_names[!base::is.na(.ow_by_example_value_names)], type = \"bytes\")))",
          "    base::attr(.ow_by_example_values, \"names\") <- NULL",
          "    base::attr(.ow_by_example_values, \"names\") <- .ow_by_example_value_names",
          "  }",
          sprintf(
            "  if (!base::is.finite(.ow_by_example_output_bytes) || .ow_by_example_output_bytes > %dL) base::stop(\"Open Wrangler by-example exceeds its aggregate output budget\", call. = FALSE)",
            maximum_operation_output_bytes
          ),
          "  if (base::inherits(.ow_result, \"data.table\")) {",
          "    data.table::set(.ow_result, j = .ow_by_example_name, value = .ow_by_example_values)",
          "    if (!base::is.null(.ow_by_example_value_names)) data.table::setattr(base::.subset2(.ow_result, .ow_storage_length(.ow_result)), \"names\", .ow_by_example_value_names)",
          "  } else {",
          "    .ow_by_example_frame_classes <- base::class(.ow_result)",
          "    base::class(.ow_result) <- NULL",
          "    .ow_result[[.ow_storage_length(.ow_result) + 1L]] <- .ow_by_example_values",
          "    base::attr(.ow_result, \"names\") <- c(.ow_by_example_frame_names, .ow_by_example_name)",
          "    if (!base::is.null(.ow_by_example_value_names)) base::attr(.ow_result[[.ow_storage_length(.ow_result)]], \"names\") <- .ow_by_example_value_names",
          "    base::class(.ow_result) <- .ow_by_example_frame_classes",
          "  }",
          sprintf("  .ow_result_ids <- c(.ow_result_ids, %s)", r_string(step$outputId))
        )
      } else if (identical(step$kind, "formula")) {
        symbol <- switch(
          step$operator,
          add = "+",
          subtract = "-",
          multiply = "*",
          divide = "/",
          modulo = "%%",
          power = "^"
        )
        right_kind <- if (is.null(step$right)) {
          if (is.integer(step$value)) "integer" else "double"
        } else {
          step$right$semanticKind
        }
        force_double <-
          step$operator %in% c("divide", "power") ||
            (
              (identical(step$left$semanticKind, "integer64") || identical(right_kind, "integer64")) &&
                (identical(step$left$semanticKind, "double") || identical(right_kind, "double"))
            )
        has_integer64 <-
          identical(step$left$semanticKind, "integer64") || identical(right_kind, "integer64")
        lines <- c(
          lines,
          sprintf("  .ow_formula_left_position <- %dL", step$left$position),
          sprintf("  .ow_formula_left_name <- %s", r_string(step$left$name)),
          sprintf("  .ow_formula_name <- %s", r_string(step$newName)),
          "  .ow_formula_frame_names <- attr(.ow_result, \"names\", exact = TRUE)",
          "  if (.ow_storage_length(.ow_result) < .ow_formula_left_position || !identical(.ow_formula_frame_names[[.ow_formula_left_position]], .ow_formula_left_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  .ow_formula_left <- .ow_result[[.ow_formula_left_position]]",
          row_type_guard(".ow_formula_left", list(semanticsKind = step$left$semanticKind)),
          exact_formula_datetime_type_guard(".ow_formula_left", step$left),
          if (identical(step$left$semanticKind, "integer64")) {
            "  .ow_formula_left_nan <- rep.int(FALSE, .ow_storage_length(.ow_formula_left))"
          } else {
            "  .ow_formula_left_nan <- is.nan(.ow_formula_left)"
          },
          if (identical(step$left$semanticKind, "integer64")) {
            "  .ow_formula_left_infinite <- rep.int(FALSE, .ow_storage_length(.ow_formula_left))"
          } else {
            "  .ow_formula_left_infinite <- is.infinite(.ow_formula_left)"
          },
          if (identical(step$left$semanticKind, "integer64")) {
            "  .ow_formula_left_missing <- .ow_integer64_missing_mask(.ow_formula_left)"
          } else {
            "  .ow_formula_left_missing <- is.na(.ow_formula_left) & !.ow_formula_left_nan"
          }
        )
        if (is.null(step$right)) {
          lines <- c(
            lines,
            sprintf("  .ow_formula_right <- %s", r_number(step$value)),
            "  .ow_formula_right_nan <- rep.int(FALSE, .ow_storage_length(.ow_formula_left))",
            "  .ow_formula_right_infinite <- rep.int(FALSE, .ow_storage_length(.ow_formula_left))",
            "  .ow_formula_right_missing <- rep.int(FALSE, .ow_storage_length(.ow_formula_left))"
          )
        } else {
          lines <- c(
            lines,
            sprintf("  .ow_formula_right_position <- %dL", step$right$position),
            sprintf("  .ow_formula_right_name <- %s", r_string(step$right$name)),
            "  if (.ow_storage_length(.ow_result) < .ow_formula_right_position || !identical(.ow_formula_frame_names[[.ow_formula_right_position]], .ow_formula_right_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
            "  .ow_formula_right <- .ow_result[[.ow_formula_right_position]]",
            row_type_guard(".ow_formula_right", list(semanticsKind = step$right$semanticKind)),
            exact_formula_datetime_type_guard(".ow_formula_right", step$right),
            if (identical(step$right$semanticKind, "integer64")) {
              "  .ow_formula_right_nan <- rep.int(FALSE, .ow_storage_length(.ow_formula_right))"
            } else {
              "  .ow_formula_right_nan <- is.nan(.ow_formula_right)"
            },
            if (identical(step$right$semanticKind, "integer64")) {
              "  .ow_formula_right_infinite <- rep.int(FALSE, .ow_storage_length(.ow_formula_right))"
            } else {
              "  .ow_formula_right_infinite <- is.infinite(.ow_formula_right)"
            },
            if (identical(step$right$semanticKind, "integer64")) {
              "  .ow_formula_right_missing <- .ow_integer64_missing_mask(.ow_formula_right)"
            } else {
              "  .ow_formula_right_missing <- is.na(.ow_formula_right) & !.ow_formula_right_nan"
            }
          )
        }
        if (force_double) {
          if (identical(step$left$semanticKind, "integer64")) {
            lines <- c(lines, "  .ow_formula_left <- suppressWarnings(.ow_integer64_to_double(.ow_formula_left))")
          }
          if (identical(right_kind, "integer64")) {
            lines <- c(lines, "  .ow_formula_right <- suppressWarnings(.ow_integer64_to_double(.ow_formula_right))")
          }
        }
        formula_expression <- if (has_integer64 && !force_double) {
          sprintf(".ow_integer64_binary(.ow_integer64_%s, .ow_formula_left, .ow_formula_right)", step$operator)
        } else {
          sprintf(".ow_formula_left %s .ow_formula_right", symbol)
        }
        lines <- c(
          lines,
          sprintf(
            "  .ow_formula_values <- withCallingHandlers(%s, warning = function(.ow_warning) invokeRestart(\"muffleWarning\"))",
            formula_expression
          ),
          "  .ow_formula_input_missing <- .ow_formula_left_missing | .ow_formula_right_missing",
          "  if (any(.ow_formula_input_missing)) {",
          "    if (inherits(.ow_formula_values, \"integer64\")) .ow_formula_values <- .ow_integer64_force_missing(.ow_formula_values, .ow_formula_input_missing) else if (is.integer(.ow_formula_values)) .ow_formula_values[.ow_formula_input_missing] <- NA_integer_ else .ow_formula_values[.ow_formula_input_missing] <- NA_real_",
          "  }",
          "  if (.ow_storage_length(.ow_formula_values) != .ow_storage_length(.ow_formula_left) || !(is.integer(.ow_formula_values) || is.double(.ow_formula_values) || inherits(.ow_formula_values, \"integer64\"))) stop(\"Open Wrangler Formula returned an invalid numeric result\", call. = FALSE)",
          "  .ow_formula_nan <- if (inherits(.ow_formula_values, \"integer64\")) rep.int(FALSE, .ow_storage_length(.ow_formula_values)) else is.nan(.ow_formula_values)",
          "  .ow_formula_infinite <- if (inherits(.ow_formula_values, \"integer64\")) rep.int(FALSE, .ow_storage_length(.ow_formula_values)) else is.infinite(.ow_formula_values)",
          if (has_integer64 && !force_double) {
            "  .ow_formula_missing <- .ow_integer64_missing_mask(.ow_formula_values)"
          } else {
            "  .ow_formula_missing <- is.na(.ow_formula_values) & !.ow_formula_nan"
          },
          "  if (any(.ow_formula_nan & !(.ow_formula_left_nan | .ow_formula_right_nan)) || any(.ow_formula_infinite & !(.ow_formula_left_infinite | .ow_formula_right_infinite)) || any(.ow_formula_missing & !(.ow_formula_left_missing | .ow_formula_right_missing))) stop(\"Open Wrangler Formula produced a non-finite or overflowing numeric result\", call. = FALSE)",
          "  if (.ow_formula_name == \"\" || any(.ow_formula_frame_names == .ow_formula_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
          sprintf(
            "  if (.ow_storage_length(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
            maximum_columns
          ),
          "  .ow_formula_value_names <- attr(.ow_formula_values, \"names\", exact = TRUE)",
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    .ow_formula_frame_classes <- class(.ow_result)",
          "    class(.ow_result) <- NULL",
          "    .ow_formula_existing_names <- attr(.ow_result, \"names\", exact = TRUE)",
          "    .ow_result[[.ow_storage_length(.ow_result) + 1L]] <- .ow_formula_values",
          "    attr(.ow_result, \"names\") <- c(.ow_formula_existing_names, .ow_formula_name)",
          "    if (!is.null(.ow_formula_value_names)) attr(.ow_result[[.ow_storage_length(.ow_result)]], \"names\") <- .ow_formula_value_names",
          "    class(.ow_result) <- .ow_formula_frame_classes",
          "    .ow_result <- base::.Call(.ow_data_table_alloccol, .ow_result, 1024L, FALSE)",
          "  } else {",
          "    .ow_formula_frame_classes <- class(.ow_result)",
          "    class(.ow_result) <- NULL",
          "    .ow_formula_existing_names <- attr(.ow_result, \"names\", exact = TRUE)",
          "    .ow_result[[.ow_storage_length(.ow_result) + 1L]] <- .ow_formula_values",
          "    attr(.ow_result, \"names\") <- c(.ow_formula_existing_names, .ow_formula_name)",
          "    if (!is.null(.ow_formula_value_names)) attr(.ow_result[[.ow_storage_length(.ow_result)]], \"names\") <- .ow_formula_value_names",
          "    class(.ow_result) <- .ow_formula_frame_classes",
          "  }",
          sprintf("  .ow_result_ids <- c(.ow_result_ids, %s)", r_string(step$outputId))
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
          "  }",
          sprintf("  .ow_result_ids <- c(.ow_result_ids, %s)", r_string(step$outputId))
        )
      } else if (step$kind %in% c("oneHotEncode", "multiLabelBinarize")) {
        specifications <- paste(
          vapply(step$columns, r_categorical_spec, character(1L), USE.NAMES = FALSE),
          collapse = ", "
        )
        lines <- c(
          lines,
          sprintf(
            "  .ow_categorical_result <- .ow_categorical_encode(.ow_result, %s, list(%s), %s, %s, %s, %s, %dL, %dL, %dL, %dL, %s, %dL, %dL, %dL, .ow_result_ids, %s)",
            r_string(step$kind),
            specifications,
            if (identical(step$kind, "oneHotEncode")) r_string(step$prefixSeparator) else "NULL",
            if (identical(step$kind, "multiLabelBinarize")) r_string(step$delimiter) else "NULL",
            if (identical(step$kind, "multiLabelBinarize")) r_string(step$prefix) else "NULL",
            if (isTRUE(step$dropOriginal)) "TRUE" else "FALSE",
            maximum_columns,
            maximum_name_bytes,
            maximum_text_bytes,
            maximum_payload_bytes,
            r_number(maximum_operation_output_bytes),
            character_vector_slot_bytes,
            metadata_base_bytes,
            column_fixed_bytes,
            r_string(step$id)
          ),
          "  .ow_result <- base::.subset2(.ow_categorical_result, \"value\")",
          "  .ow_result_ids <- base::.subset2(.ow_categorical_result, \"outputIds\")",
          "  base::rm(.ow_categorical_result)"
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
          strip_expression <- sprintf(
            "base::intToUtf8(c(%s), multiple = FALSE)",
            paste0(utf8ToInt(strip_characters), "L", collapse = ", ")
          )
          lines <- c(
            lines,
            sprintf("  .ow_text_strip_characters <- strsplit(%s, \"\", fixed = TRUE)[[1L]]", strip_expression)
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
            "  }",
            sprintf("  .ow_result_ids <- c(.ow_result_ids, %s)", r_string(step$outputId))
          )
        }
      } else if (step$kind %in% c("minMaxScale", "roundNumber", "floorNumber", "ceilNumber")) {
        operation_name <- switch(
          step$kind,
          minMaxScale = "Min-max scale",
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
        numeric_expression <- if (identical(step$kind, "minMaxScale")) {
          NULL
        } else if (identical(step$semanticKind, "integer64")) {
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
        lines <- if (identical(step$kind, "minMaxScale")) {
          c(lines, "  .ow_numeric_values <- .ow_min_max_scale(.ow_numeric_source)")
        } else {
          c(lines, sprintf("  .ow_numeric_values <- %s", numeric_expression))
        }
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
            "  }",
            sprintf("  .ow_result_ids <- c(.ow_result_ids, %s)", r_string(step$outputId))
          )
        }
      } else if (identical(step$kind, "formatDatetime")) {
        lines <- c(
          lines,
          sprintf("  .ow_datetime_position <- %dL", step$position),
          sprintf("  .ow_datetime_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_datetime_name <- %s", r_string(step$newName)),
          sprintf("  .ow_datetime_format <- %s", r_string(step$format)),
          "  .ow_datetime_frame_names <- attr(.ow_result, \"names\", exact = TRUE)",
          "  if (.ow_storage_length(.ow_result) < .ow_datetime_position || !identical(.ow_datetime_frame_names[[.ow_datetime_position]], .ow_datetime_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  .ow_datetime_source <- .ow_result[[.ow_datetime_position]]",
          row_type_guard(".ow_datetime_source", list(semanticsKind = step$semanticKind)),
          exact_formula_datetime_type_guard(".ow_datetime_source", step),
          "  .ow_datetime_source_count <- .ow_storage_length(.ow_datetime_source)",
          sprintf(
            "  .ow_datetime_output_bytes <- as.double(.ow_datetime_source_count) * %dL",
            character_vector_slot_bytes
          ),
          sprintf(
            "  if (!is.finite(.ow_datetime_output_bytes) || .ow_datetime_output_bytes > %dL) stop(\"Open Wrangler Format Datetime exceeds the %d-byte aggregate output budget\", call. = FALSE)",
            maximum_operation_output_bytes,
            maximum_operation_output_bytes
          ),
          if (identical(step$semanticKind, "datetime")) {
            c(
              "  .ow_datetime_timezone <- attr(.ow_datetime_source, \"tzone\", exact = TRUE)",
              "  if (is.null(.ow_datetime_timezone) || identical(.ow_datetime_timezone, \"\")) .ow_datetime_timezone <- \"UTC\"",
              "  if (!is.character(.ow_datetime_timezone) || length(.ow_datetime_timezone) != 1L || is.na(.ow_datetime_timezone) || identical(Encoding(.ow_datetime_timezone), \"bytes\")) stop(\"Open Wrangler received an unsupported POSIXct timezone\", call. = FALSE)",
              "  .ow_datetime_timezone_encoding <- Encoding(.ow_datetime_timezone)",
              "  .ow_datetime_timezone_from <- if (identical(.ow_datetime_timezone_encoding, \"latin1\")) \"latin1\" else \"UTF-8\"",
              "  .ow_datetime_timezone <- iconv(.ow_datetime_timezone, from = .ow_datetime_timezone_from, to = \"UTF-8\", sub = NA_character_)",
              sprintf(
                "  if (is.na(.ow_datetime_timezone) || nchar(.ow_datetime_timezone, type = \"bytes\") > %dL) stop(\"Open Wrangler received an unsupported POSIXct timezone\", call. = FALSE)",
                maximum_name_bytes
              )
            )
          } else {
            character()
          },
          "  .ow_datetime_source_storage <- unclass(.ow_datetime_source)",
          "  .ow_datetime_values <- rep.int(NA_character_, .ow_datetime_source_count)",
          "  .ow_datetime_start <- 1L",
          "  while (.ow_datetime_start <= .ow_datetime_source_count) {",
          sprintf(
            "    .ow_datetime_end <- min(.ow_datetime_source_count, .ow_datetime_start + %dL - 1L)",
            maximum_operation_output_chunk_rows
          ),
          "    .ow_datetime_positions <- seq.int(.ow_datetime_start, .ow_datetime_end)",
          "    .ow_datetime_chunk_count <- length(.ow_datetime_positions)",
          "    .ow_datetime_chunk_numeric <- .ow_datetime_source_storage[.ow_datetime_positions]",
          if (identical(step$semanticKind, "date")) {
            "    .ow_datetime_chunk_source <- structure(.ow_datetime_chunk_numeric, class = \"Date\")"
          } else {
            "    .ow_datetime_chunk_source <- structure(.ow_datetime_chunk_numeric, class = c(\"POSIXct\", \"POSIXt\"), tzone = .ow_datetime_timezone)"
          },
          "    if (any(is.nan(.ow_datetime_chunk_numeric)) || any(!is.na(.ow_datetime_chunk_numeric) & !is.finite(.ow_datetime_chunk_numeric))) stop(\"Open Wrangler Format Datetime cannot format a non-finite value\", call. = FALSE)",
          "    .ow_datetime_chunk_present <- !is.na(.ow_datetime_chunk_numeric)",
          if (identical(step$semanticKind, "date")) {
            c(
              "    if (any(.ow_datetime_chunk_present & .ow_datetime_chunk_numeric != floor(.ow_datetime_chunk_numeric))) stop(\"Open Wrangler Format Datetime cannot format a fractional Date\", call. = FALSE)",
              "    .ow_datetime_contract_display <- tryCatch(base::format.Date(.ow_datetime_chunk_source, format = \"%Y-%m-%d\"), error = function(.ow_error) NULL)",
              "    if (!is.character(.ow_datetime_contract_display) || length(.ow_datetime_contract_display) != .ow_datetime_chunk_count || any(.ow_datetime_chunk_present & (is.na(.ow_datetime_contract_display) | !grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\", .ow_datetime_contract_display)))) stop(\"Open Wrangler Format Datetime received a Date outside the supported range\", call. = FALSE)"
            )
          } else {
            c(
              "    .ow_datetime_contract_display <- tryCatch(base::format.POSIXct(.ow_datetime_chunk_source, tz = .ow_datetime_timezone, format = \"%Y-%m-%dT%H:%M:%OS6\", usetz = FALSE), error = function(.ow_error) NULL)",
              "    if (!is.character(.ow_datetime_contract_display) || length(.ow_datetime_contract_display) != .ow_datetime_chunk_count || any(.ow_datetime_chunk_present & is.na(.ow_datetime_contract_display))) stop(\"Open Wrangler Format Datetime received a POSIXct value outside the supported range\", call. = FALSE)"
            )
          },
          if (identical(step$semanticKind, "date")) {
            "    .ow_datetime_chunk_values <- base::format.Date(.ow_datetime_chunk_source, format = .ow_datetime_format)"
          } else {
            "    .ow_datetime_chunk_values <- base::format.POSIXct(.ow_datetime_chunk_source, format = .ow_datetime_format, tz = .ow_datetime_timezone, usetz = FALSE)"
          },
          "    if (!is.character(.ow_datetime_chunk_values) || length(.ow_datetime_chunk_values) != .ow_datetime_chunk_count) stop(\"Open Wrangler Format Datetime returned an invalid text result\", call. = FALSE)",
          "    .ow_datetime_chunk_values <- vapply(seq_along(.ow_datetime_chunk_values), function(.ow_index) {",
          "      if (is.na(.ow_datetime_chunk_numeric[[.ow_index]])) return(NA_character_)",
          "      .ow_value <- .ow_datetime_chunk_values[[.ow_index]]",
          "      if (!is.character(.ow_value) || length(.ow_value) != 1L || is.na(.ow_value) || identical(Encoding(.ow_value), \"bytes\")) stop(\"Open Wrangler Format Datetime returned invalid text\", call. = FALSE)",
          "      .ow_encoding <- Encoding(.ow_value)",
          "      .ow_from <- if (identical(.ow_encoding, \"latin1\")) \"latin1\" else \"UTF-8\"",
          "      .ow_utf8 <- iconv(.ow_value, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
          "      if (is.na(.ow_utf8) || nchar(.ow_utf8, type = \"bytes\") > 8192L) stop(\"Open Wrangler Format Datetime produced invalid or oversized text\", call. = FALSE)",
          "      .ow_utf8",
          "    }, character(1L), USE.NAMES = FALSE)",
          "    .ow_datetime_chunk_bytes <- sum(as.double(nchar(.ow_datetime_chunk_values[!is.na(.ow_datetime_chunk_values)], type = \"bytes\")))",
          "    .ow_datetime_next_output_bytes <- .ow_datetime_output_bytes + .ow_datetime_chunk_bytes",
          sprintf(
            "    if (!is.finite(.ow_datetime_next_output_bytes) || .ow_datetime_next_output_bytes > %dL) stop(\"Open Wrangler Format Datetime exceeds the %d-byte aggregate output budget\", call. = FALSE)",
            maximum_operation_output_bytes,
            maximum_operation_output_bytes
          ),
          "    .ow_datetime_output_bytes <- .ow_datetime_next_output_bytes",
          "    .ow_datetime_values[.ow_datetime_positions] <- .ow_datetime_chunk_values",
          "    .ow_datetime_start <- .ow_datetime_end + 1L",
          "  }"
        )
        if (isTRUE(step$inPlace)) {
          lines <- c(
            lines,
            "  if (inherits(.ow_result, \"data.table\") && !is.null(data.table::key(.ow_result)) && .ow_datetime_source_name %in% data.table::key(.ow_result)) stop(\"Open Wrangler Format Datetime cannot replace a data.table key column; choose a new output column\", call. = FALSE)",
            "  if (inherits(.ow_result, \"data.table\")) data.table::set(.ow_result, j = .ow_datetime_position, value = .ow_datetime_values) else .ow_result[[.ow_datetime_position]] <- .ow_datetime_values"
          )
        } else {
          lines <- c(
            lines,
            "  if (.ow_datetime_name == \"\" || any(.ow_datetime_frame_names == .ow_datetime_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
            sprintf(
              "  if (.ow_storage_length(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
              maximum_columns
            ),
            "  if (inherits(.ow_result, \"data.table\")) {",
            "    .ow_datetime_frame_classes <- class(.ow_result)",
            "    class(.ow_result) <- NULL",
            "    .ow_datetime_existing_names <- attr(.ow_result, \"names\", exact = TRUE)",
            "    .ow_result[[.ow_storage_length(.ow_result) + 1L]] <- .ow_datetime_values",
            "    attr(.ow_result, \"names\") <- c(.ow_datetime_existing_names, .ow_datetime_name)",
            "    class(.ow_result) <- .ow_datetime_frame_classes",
            "    .ow_result <- base::.Call(.ow_data_table_alloccol, .ow_result, 1024L, FALSE)",
            "  } else {",
            "    .ow_datetime_existing_names <- attr(.ow_result, \"names\", exact = TRUE)",
            "    .ow_result[[.ow_storage_length(.ow_result) + 1L]] <- .ow_datetime_values",
            "    attr(.ow_result, \"names\") <- c(.ow_datetime_existing_names, .ow_datetime_name)",
            "  }",
            sprintf("  .ow_result_ids <- c(.ow_result_ids, %s)", r_string(step$outputId))
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
          "  .ow_all_positions <- seq_len(ncol(.ow_result))",
          "  .ow_keep_positions <- .ow_all_positions[is.na(match(.ow_all_positions, .ow_drop_positions))]",
          "  if (length(.ow_keep_positions) == 0L) stop(\"Open Wrangler must keep at least one column\", call. = FALSE)",
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    .ow_result <- .ow_result[, .ow_keep_positions, with = FALSE]",
          "  } else {",
          "    for (.ow_position in base::sort.int(.ow_drop_positions, decreasing = TRUE, method = \"radix\")) .ow_result[[.ow_position]] <- NULL",
          "  }",
          "  .ow_result_ids <- .ow_result_ids[.ow_keep_positions]"
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
          "  }",
          "  .ow_result_ids <- .ow_result_ids[.ow_select_positions]"
        )
      } else {
        abort("runtime_error", "The R cleaning plan contains an unsupported operation")
      }
    }
    code <- paste(c(
      lines,
      "  .ow_result",
      "  }, envir = base::list2env(",
      "    base::list(.ow_source_environment = .ow_caller_environment, .ow_custom_parent_environment = .ow_caller_environment),",
      "    parent = base::baseenv()",
      "  ))",
      "  if (base::exists(.ow_publication_name, envir = .ow_caller_environment, inherits = FALSE) && base::bindingIsActive(.ow_publication_name, .ow_caller_environment)) base::stop(\"Open Wrangler generated R does not accept an active result binding\", call. = FALSE)",
      "  base::assign(.ow_publication_name, .ow_generated_result, envir = .ow_caller_environment, inherits = FALSE)",
      "  if (base::bindingIsActive(.ow_publication_name, .ow_caller_environment) || !base::identical(base::get(.ow_publication_name, envir = .ow_caller_environment, inherits = FALSE), .ow_generated_result)) base::stop(\"Open Wrangler generated R could not verify its result binding\", call. = FALSE)",
      "  base::invisible(.ow_generated_result)",
      "}, envir = base::list2env(",
      "  base::list(.ow_caller_environment = base::environment()),",
      "  parent = base::baseenv()",
      "))",
      ""
    ), collapse = "\n")
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
    custom_schema <- function(value) {
      schema <- unclass(value$descriptor$schema)
      attributes(schema) <- NULL
      lapply(seq_along(schema), function(index) {
        column <- unclass(.subset2(schema, index))
        column
      })
    }
    custom_ids <- function(schema) vapply(
      schema,
      function(column) .subset2(column, "id"),
      character(1L),
      USE.NAMES = FALSE
    )
    custom_difference_names <- function(schema, retained_ids) {
      retained <- vapply(
        schema,
        function(column) !.subset2(column, "id") %in% retained_ids,
        logical(1L),
        USE.NAMES = FALSE
      )
      selected <- schema[retained]
      vapply(
        selected,
        function(column) .subset2(column, "name"),
        character(1L),
        USE.NAMES = FALSE
      )
    }
    added_columns <- if (identical(bound$kind, "customCode")) {
      if (is.null(before) || is.null(after)) {
        abort("runtime_error", "The R Custom Code diff is missing its schema context")
      }
      before_schema <- custom_schema(before)
      after_schema <- custom_schema(after)
      custom_difference_names(after_schema, custom_ids(before_schema))
    } else if (identical(bound$kind, "groupBy")) {
      vapply(bound$aggregations, `[[`, character(1L), "alias", USE.NAMES = FALSE)
    } else if (bound$kind %in% c("oneHotEncode", "multiLabelBinarize")) {
      bound$generatedNames
    } else if (
      bound$kind %in% c("cloneColumn", "formula", "textLength", "byExample") ||
        (
          bound$kind %in% c(
            "lowerText",
            "upperText",
            "capitalizeText",
            "stripText",
            "splitText",
            "findReplace",
            "minMaxScale",
            "roundNumber",
            "floorNumber",
            "ceilNumber",
            "formatDatetime"
          ) &&
            !isTRUE(bound$inPlace)
        )
    ) {
      bound$newName
    } else {
      character()
    }
    removed_columns <- if (identical(bound$kind, "customCode")) {
      if (is.null(before) || is.null(after)) {
        abort("runtime_error", "The R Custom Code diff is missing its schema context")
      }
      before_schema <- custom_schema(before)
      after_schema <- custom_schema(after)
      custom_difference_names(before_schema, custom_ids(after_schema))
    } else if (identical(bound$kind, "groupBy")) {
      bound$removedNames
    } else if (bound$kind %in% c("oneHotEncode", "multiLabelBinarize")) {
      bound$removedNames
    } else if (identical(bound$kind, "dropColumns")) {
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
    if (identical(bound$kind, "customCode")) {
      if (is.null(frame_contract) || is.null(before) || is.null(after) || is.null(page)) {
        abort("runtime_error", "The R Custom Code diff is missing its bounded page context")
      }
      if (is.null(after_page)) after_page <- materialize(frame_contract, after, page)
      before_rows <- before$descriptor$shape$rows
      after_rows <- after$descriptor$shape$rows
      added_rows <- as.integer(after_rows)
      removed_rows <- as.integer(before_rows)
      before_complete <-
        page$row_offset == 0 &&
          page$row_limit >= before_rows &&
          length(page$view$filters) == 0L
      after_complete <-
        after_page$page$offset == 0 &&
          after_page$page$totalRows == after_rows &&
          length(after_page$page$rows) == after_rows
      truncated <- !(before_complete && after_complete)
    } else if (identical(bound$kind, "groupBy")) {
      if (is.null(frame_contract) || is.null(before) || is.null(after) || is.null(page)) {
        abort("runtime_error", "The R Group By diff is missing its bounded page context")
      }
      if (is.null(after_page)) after_page <- materialize(frame_contract, after, page)
      before_rows <- before$descriptor$shape$rows
      after_rows <- after$descriptor$shape$rows
      added_rows <- as.integer(after_rows)
      removed_rows <- as.integer(before_rows)
      before_complete <-
        page$row_offset == 0 &&
          page$row_limit >= before_rows
      after_complete <-
        after_page$page$offset == 0 &&
          after_page$page$totalRows == after_rows &&
          length(after_page$page$rows) == after_rows
      truncated <- !(before_complete && after_complete)
    } else if (bound$kind %in% c("sortRows", "filterRows", "dropMissingRows", "dropDuplicates")) {
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
        "minMaxScale",
        "roundNumber",
        "floorNumber",
        "ceilNumber",
        "formatDatetime",
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

  ascii_json_scalar <- function(value) {
    if (is.na(value)) return("null")
    if (identical(Encoding(value), "bytes")) {
      abort("runtime_error", "The R kernel response contains invalid text")
    }
    source_encoding <- if (identical(Encoding(value), "latin1")) "latin1" else "UTF-8"
    converted <- suppressWarnings(iconv(value, from = source_encoding, to = "UTF-8", sub = NA_character_))
    if (length(converted) != 1L || is.na(converted)) {
      abort("runtime_error", "The R kernel response contains invalid text")
    }
    bytes <- as.integer(charToRaw(converted))
    if (
      length(bytes) == 0L ||
        all(bytes >= 32L & bytes <= 126L & bytes != 34L & bytes != 92L)
    ) {
      return(paste0("\"", converted, "\""))
    }
    codepoints <- utf8ToInt(converted)
    if (anyNA(codepoints) || any(codepoints < 0L) || any(codepoints > 1114111L)) {
      abort("runtime_error", "The R kernel response contains invalid text")
    }
    escaped <- vapply(codepoints, function(codepoint) {
      if (codepoint == 34L) return("\\\"")
      if (codepoint == 92L) return("\\\\")
      if (codepoint == 8L) return("\\b")
      if (codepoint == 9L) return("\\t")
      if (codepoint == 10L) return("\\n")
      if (codepoint == 12L) return("\\f")
      if (codepoint == 13L) return("\\r")
      if (codepoint >= 32L && codepoint <= 126L) return(intToUtf8(codepoint))
      if (codepoint <= 65535L) return(sprintf("\\u%04X", codepoint))
      scalar <- codepoint - 65536L
      paste0(
        sprintf("\\u%04X", 55296L + scalar %/% 1024L),
        sprintf("\\u%04X", 56320L + scalar %% 1024L)
      )
    }, character(1L), USE.NAMES = FALSE)
    paste0("\"", paste0(escaped, collapse = ""), "\"")
  }

  ascii_json_character <- function(value) {
    fragments <- vapply(seq_len(base::length(base::unclass(value))), function(index) {
      ascii_json_scalar(base::.subset2(value, index))
    }, character(1L), USE.NAMES = FALSE)
    fragment <- if (base::length(base::unclass(value)) == 1L && !inherits(value, "AsIs")) {
      base::.subset2(fragments, 1L)
    } else {
      paste0("[", paste0(fragments, collapse = ","), "]")
    }
    structure(fragment, class = "json")
  }

  ascii_json_response <- function(value) {
    if (is.character(value)) return(ascii_json_character(value))
    if (!is.list(value)) return(value)
    value_attributes <- attributes(value)
    result <- lapply(seq_len(base::length(base::unclass(value))), function(index) {
      ascii_json_response(base::.subset2(value, index))
    })
    attributes(result) <- value_attributes
    result
  }

  encode_response <- function(response) {
    encoded <- jsonlite::toJSON(
      ascii_json_response(response),
      auto_unbox = TRUE,
      digits = 17L,
      na = "null",
      null = "null",
      pretty = FALSE,
      json_verbatim = TRUE
    )
    if (nchar(encoded, type = "bytes") > maximum_response_bytes) {
      abort("runtime_error", "The R kernel response is too large")
    }
    encoded <- as.character(encoded)
    if (any(as.integer(charToRaw(encoded)) > 127L)) {
      abort("runtime_error", "The R kernel response could not be encoded as ASCII JSON")
    }
    encoded
  }

  preflight_response <- function(response) {
    encode_response(response)
    invisible(NULL)
  }

  canonical_base64 <- function(value) {
    encoded <- jsonlite::base64_enc(value)
    gsub("\r", "", gsub("\n", "", encoded, fixed = TRUE), fixed = TRUE)
  }

  reject_json_nul_escape <- function(payload) {
    bytes <- as.integer(charToRaw(enc2utf8(payload)))
    if (length(bytes) < 6L) return(invisible(NULL))
    candidates <- which(bytes %in% c(85L, 117L))
    candidates <- candidates[candidates > 1L & candidates + 4L <= length(bytes)]
    candidates <- candidates[bytes[candidates - 1L] == 92L]
    for (position in candidates) {
      if (!all(bytes[seq.int(position + 1L, position + 4L)] == 48L)) next
      slash_count <- 0L
      cursor <- position - 1L
      while (cursor >= 1L && bytes[[cursor]] == 92L) {
        slash_count <- slash_count + 1L
        cursor <- cursor - 1L
      }
      if (slash_count %% 2L == 1L) {
        abort("invalid_request", "R runtime requests cannot contain U+0000 text", TRUE)
      }
    }
    invisible(NULL)
  }

  json_has_negative_zero_number <- function(payload) {
    bytes <- as.integer(charToRaw(enc2utf8(payload)))
    count <- length(bytes)
    in_string <- FALSE
    escaped <- FALSE
    position <- 1L
    while (position <= count) {
      byte <- bytes[[position]]
      if (in_string) {
        if (escaped) {
          escaped <- FALSE
        } else if (byte == 92L) {
          escaped <- TRUE
        } else if (byte == 34L) {
          in_string <- FALSE
        }
        position <- position + 1L
        next
      }
      if (byte == 34L) {
        in_string <- TRUE
        position <- position + 1L
        next
      }
      if (
        byte != 45L || position == count || bytes[[position + 1L]] != 48L ||
          (position > 1L && bytes[[position - 1L]] %in% c(69L, 101L))
      ) {
        position <- position + 1L
        next
      }

      cursor <- position + 2L
      all_zero <- TRUE
      if (cursor <= count && bytes[[cursor]] == 46L) {
        cursor <- cursor + 1L
        while (cursor <= count && bytes[[cursor]] >= 48L && bytes[[cursor]] <= 57L) {
          if (bytes[[cursor]] != 48L) all_zero <- FALSE
          cursor <- cursor + 1L
        }
      }
      if (cursor <= count && bytes[[cursor]] %in% c(69L, 101L)) {
        cursor <- cursor + 1L
        if (cursor <= count && bytes[[cursor]] %in% c(43L, 45L)) cursor <- cursor + 1L
        while (cursor <= count && bytes[[cursor]] >= 48L && bytes[[cursor]] <= 57L) {
          cursor <- cursor + 1L
        }
      }
      if (all_zero) return(TRUE)
      position <- cursor
    }
    FALSE
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
        frame_contract$limits$factorLevels,
        frame_contract$limits$textBytes,
        frame_contract$limits$payloadBytes,
        frame_contract$limits$nameBytes
      )
    )
  }

  new_agent <- function(frame_contract, source_environment = .GlobalEnv, export_root = NULL) {
    required_functions <- c(
      "capture_frame",
      "capture_categorical_result",
      "capture_custom_code_result",
      "capture_group_result",
      "capture_live_frame",
      "isolate_capture",
      "isolate_custom_code_input",
      "rename_column",
      "rename_column_at",
      "clone_column_at",
      "by_example_column_at",
      "formula_column_at",
      "text_length_column_at",
      "one_hot_encode_columns_at",
      "multi_label_binarize_column_at",
      "lower_text_column_at",
      "upper_text_column_at",
      "capitalize_text_column_at",
      "strip_text_column_at",
      "split_text_column_at",
      "find_replace_column_at",
      "min_max_scale_column_at",
      "round_number_column_at",
      "floor_number_column_at",
      "ceil_number_column_at",
      "format_datetime_column_at",
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
      "group_by_at",
      "transform_rows",
      "materialize_view_page",
      "materialize_summaries",
      "materialize_dataset_stats",
      "materialize_column_values",
      "export_formats",
      "normalize_export_options",
      "write_csv",
      "write_parquet"
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

    supported_export_formats <- function() {
      formats <- frame_contract$export_formats()
      if (
        !is.character(formats) ||
          length(formats) < 1L ||
          length(formats) > 2L ||
          anyNA(formats) ||
          anyDuplicated(formats) ||
          !identical(formats[[1L]], "csv") ||
          any(!formats %in% c("csv", "parquet"))
      ) {
        abort("runtime_error", "The R frame contract returned invalid export capabilities")
      }
      unname(formats)
    }

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
        payload <- exact_record(
          request$payload,
          c("sessionId", "variableName", "page"),
          "request.payload",
          optional_fields = c("cloneFromSessionId", "cloneFromRevision")
        )
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
        page <- decode_page(payload$page, frame_contract$limits)
        has_clone_session <- "cloneFromSessionId" %in% names(payload)
        has_clone_revision <- "cloneFromRevision" %in% names(payload)
        if (!identical(has_clone_session, has_clone_revision)) {
          abort("invalid_request", "R clone source fields must be provided together")
        }
        source_capture <- if (has_clone_session) {
          clone_session_id <- identifier(payload$cloneFromSessionId, "request.payload.cloneFromSessionId")
          clone_revision <- whole_number(
            payload$cloneFromRevision,
            "request.payload.cloneFromRevision",
            .Machine$integer.max
          )
          if (!exists(clone_session_id, envir = sessions, inherits = FALSE)) {
            abort("unknown_session", "The confirmed R clone source is no longer available", TRUE)
          }
          clone_session <- get(clone_session_id, envir = sessions, inherits = FALSE)
          if (!identical(clone_session$revision, as.integer(clone_revision))) {
            abort("stale_revision", "The confirmed R clone source revision changed", TRUE)
          }
          if (!identical(clone_session$variableName, variable_name)) {
            abort("invalid_request", "The confirmed R clone source variable changed", TRUE)
          }
          confirmed_capture <- if (is.null(clone_session$original)) clone_session$source else clone_session$original
          frame_contract$isolate_capture(confirmed_capture)
        } else {
          if (!exists(variable_name, envir = source_environment, inherits = FALSE)) {
            abort("unknown_variable", "The selected R dataframe variable no longer exists", TRUE)
          }
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
          frame_contract$capture_live_frame(source_reader)
        }
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
          exportFormats = I(supported_export_formats()),
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
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "columnValues",
          sessionId = session_id,
          column = result$column,
          values = result$values,
          hasMore = result$hasMore
        )
        if (!is.null(result$sampleSize)) response$sampleSize <- result$sampleSize
        return(response)
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
        view_schema_base <- session$committed

        retained_plan <- session$plan
        retained_bound_plan <- session$boundPlan
        base <- session$committed
        diff_before <- session$committed
        if (!is.null(replace_step_id)) {
          replace_indexes <- which(vapply(
            session$plan,
            function(applied) identical(applied$id, replace_step_id),
            logical(1L)
          ))
          if (length(replace_indexes) == 0L) {
            abort("invalid_request", "The selected applied R step no longer exists", TRUE)
          }
          if (length(replace_indexes) != 1L) {
            abort("invalid_request", "Applied R step IDs must be unique", TRUE)
          }
          if (!identical(step$id, replace_step_id)) {
            abort("invalid_request", "An edited R step must retain its applied step ID", TRUE)
          }
          replace_index <- replace_indexes[[1L]]
          retained_plan <- if (replace_index > 1L) session$plan[seq_len(replace_index - 1L)] else list()
          replayed <- replay_plan(
            frame_contract,
            session$original,
            retained_plan,
            source_environment,
            session$variableName
          )
          base <- replayed$capture
          retained_bound_plan <- replayed$boundPlan
          original_selected <- apply_step(
            frame_contract,
            base,
            session$plan[[replace_index]],
            source_environment,
            session$variableName
          )
          diff_before <- original_selected$capture
        }
        if (length(retained_plan) >= frame_contract$limits$columns) {
          abort("invalid_request", "The R cleaning plan has reached its supported step limit", TRUE)
        }
        if (any(vapply(retained_plan, function(applied) identical(applied$id, step$id), logical(1L)))) {
          abort("invalid_request", "Applied R step IDs must be unique", TRUE)
        }

        preflight_custom_code <- if (identical(step$kind, "customCode")) {
          compile_plan(
            session$variableName,
            c(retained_bound_plan, list(list(
              id = step$id,
              kind = step$kind,
              params = list(code = step$params$code)
            ))),
            frame_contract$limits$columns,
            frame_contract$limits$factorLevels,
            frame_contract$limits$textBytes,
            frame_contract$limits$payloadBytes,
            frame_contract$limits$nameBytes
          )
        } else {
          NULL
        }

        applied <- apply_step(
          frame_contract,
          base,
          step,
          source_environment,
          session$variableName
        )
        candidate <- session
        candidate$draft <- applied$capture
        candidate$draftStep <- step
        candidate$draftBound <- applied$bound
        candidate$replaceStepId <- replace_step_id
        candidate$editing <- TRUE
        candidate$revision <- next_revision(session)
        candidate_bound_plan <- c(retained_bound_plan, list(applied$bound))
        effective_view <- if (identical(applied$bound$kind, "customCode")) {
          reconcile_custom_code_view(page$view, view_schema_base, candidate$draft)
        } else {
          NULL
        }
        effective_page <- page
        if (!is.null(effective_view)) effective_page$view <- effective_view
        draft_page <- materialize(frame_contract, candidate$draft, effective_page)
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
            diff_before,
            applied$capture,
            effective_page,
            after_page = draft_page
          ),
          code = if (!is.null(preflight_custom_code)) preflight_custom_code else compile_plan(
            candidate$variableName,
            candidate_bound_plan,
            frame_contract$limits$columns,
            frame_contract$limits$factorLevels,
            frame_contract$limits$textBytes,
            frame_contract$limits$payloadBytes,
            frame_contract$limits$nameBytes
          )
        )
        if (!is.null(effective_view)) response$effectiveView <- effective_view
        if (identical(applied$bound$kind, "fillMissingValues")) {
          response$remainingMissingCells <- frame_contract$count_missing_at(
            candidate$draft,
            applied$bound$position,
            applied$bound$oldName
          )
        }
        if (identical(applied$bound$kind, "byExample")) {
          retained_step <- list(id = step$id, kind = step$kind, params = step$params)
          retained_step$params$warnings <- I(step$params$warnings)
          response$retainedStep <- retained_step
        }
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
              frame_contract$limits$factorLevels,
              frame_contract$limits$textBytes,
              frame_contract$limits$payloadBytes,
              frame_contract$limits$nameBytes
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
          utils::head(session$plan, step_index - if (identical(side, "input")) 1L else 0L),
          source_environment,
          session$variableName
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
        if (
          !is.null(session$replaceStepId) &&
            (length(session$plan) == 0L ||
              !identical(session$plan[[length(session$plan)]]$id, session$replaceStepId))
        ) {
          abort(
            "invalid_request",
            "An earlier R step must be applied through the host plan-rewrite transaction",
            TRUE
          )
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
        replayed <- replay_plan(
          frame_contract,
          session$original,
          retained_plan,
          source_environment,
          session$variableName
        )
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
          c("sessionId", "revision", "exportId", "options"),
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
        export_options <- tryCatch(
          frame_contract$normalize_export_options(payload$options),
          openwrangler_r_frame_error = function(error) {
            abort("invalid_request", conditionMessage(error), TRUE)
          },
          error = function(error) {
            abort("invalid_request", "Native R data export options are invalid", TRUE)
          }
        )
        format <- export_options$format
        if (!format %in% supported_export_formats()) {
          abort(
            "missing_package",
            "Parquet export requires nanoparquet 0.5.1 or newer in the selected R runtime",
            TRUE
          )
        }
        capture <- if (isTRUE(session$editing)) session$committed else session$source
        if (is.null(capture)) {
          abort("runtime_error", "The committed R dataframe is no longer available")
        }
        artifact_path <- file.path(export_root, paste0(export_id, if (identical(format, "csv")) ".csv" else ".parquet"))
        completed <- FALSE
        on.exit({
          if (!completed && file.exists(artifact_path)) try(unlink(artifact_path, force = TRUE), silent = TRUE)
        }, add = TRUE)
        exported <- if (identical(format, "csv")) {
          frame_contract$write_csv(capture, artifact_path, export_options)
        } else {
          frame_contract$write_parquet(capture, artifact_path, export_options)
        }
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "dataExported",
          sessionId = session_id,
          revision = session$revision,
          exportId = export_id,
          format = format,
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
          raw_request_id <- regexec(
            "\"requestId\"[[:space:]]*:[[:space:]]*\"([0-9a-f-]{36})\"",
            payload,
            perl = TRUE
          )[[1L]]
          if (!(length(raw_request_id) == 1L && identical(as.integer(raw_request_id[[1L]]), -1L))) {
            raw_fields <- regmatches(payload, list(raw_request_id))[[1L]]
            if (length(raw_fields) == 2L && grepl(identifier_pattern, raw_fields[[2L]], perl = TRUE)) {
              request_id <- raw_fields[[2L]]
            }
          }
          request <- jsonlite::fromJSON(payload, simplifyVector = FALSE)
          if (
            is.list(request) && is.character(request$requestId) &&
              length(request$requestId) == 1L && !is.na(request$requestId) &&
              grepl(identifier_pattern, request$requestId, perl = TRUE)
          ) {
            request_id <- request$requestId
          }
          reject_json_nul_escape(payload)
          if (
            is.list(request) && identical(request$kind, "previewStep") &&
              is.list(request$payload) && is.list(request$payload$step) &&
              identical(request$payload$step$kind, "byExample") &&
              json_has_negative_zero_number(payload)
          ) {
            abort("invalid_request", "R by-example requests cannot contain negative zero")
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
