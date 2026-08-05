openwrangler_r_kernel_agent <- local({
  transport_version <- 2L
  maximum_identifier_bytes <- 128L
  maximum_variable_name_bytes <- 1024L
  maximum_error_bytes <- 4096L
  maximum_response_bytes <- 17L * 1024L * 1024L
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
    } else if (source_code %in% c("invalid-view-query", "invalid-view-value")) {
      code <- "invalid_request"
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

  decode_column_reference <- function(value, label) {
    reference <- exact_record(value, c("id", "name"), label)
    list(
      id = bounded_text(reference$id, paste0(label, ".id"), maximum_identifier_bytes),
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

  decode_sort_rules <- function(value, limits) {
    if (!is.list(value) || is.object(value) || length(value) > limits$sortRules) {
      abort("invalid_request", "request.page.sorts must be a bounded array")
    }
    rules <- lapply(seq_along(value), function(index) {
      rule <- exact_record(value[[index]], c("column", "direction", "nulls"), sprintf("sort[%d]", index))
      column <- decode_column_reference(rule$column, sprintf("sort[%d].column", index))
      if (!rule$direction %in% c("asc", "desc") || !rule$nulls %in% c("first", "last")) {
        abort("invalid_request", sprintf("sort[%d] has an unsupported order", index))
      }
      list(
        column = column,
        direction = rule$direction,
        nulls = rule$nulls
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
      filter$column <- decode_column_reference(filter$column, paste0(label, ".column"))
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
      decode_column_reference(value[[index]], sprintf("columns[%d]", index))
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

  new_agent <- function(frame_contract, source_environment = .GlobalEnv) {
    required_functions <- c(
      "capture_live_frame",
      "materialize_view_page",
      "materialize_summaries",
      "materialize_dataset_stats",
      "materialize_column_values"
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

    sessions <- new.env(hash = TRUE, parent = emptyenv())

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
        capture <- frame_contract$capture_live_frame(source_reader)
        result <- materialize(frame_contract, capture, page)
        assign(session_id, capture, envir = sessions)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "page",
          sessionId = session_id,
          page = result
        ))
      }

      if (identical(kind, "getPage")) {
        payload <- exact_record(request$payload, c("sessionId", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        capture <- get(session_id, envir = sessions, inherits = FALSE)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "page",
          sessionId = session_id,
          page = materialize(frame_contract, capture, page)
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
        capture <- get(session_id, envir = sessions, inherits = FALSE)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "summary",
          sessionId = session_id,
          summaries = frame_contract$materialize_summaries(capture, columns, view)
        ))
      }

      if (identical(kind, "getDatasetStats")) {
        payload <- exact_record(request$payload, c("sessionId", "view"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        capture <- get(session_id, envir = sessions, inherits = FALSE)
        view <- decode_view(payload$view, frame_contract$limits)
        result <- validate_dataset_stats_result(
          frame_contract$materialize_dataset_stats(capture, view),
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
        column <- decode_column_reference(payload$column, "request.payload.column")
        view <- decode_view(payload$view, frame_contract$limits)
        search <- if (is.null(payload$search)) {
          NULL
        } else {
          bounded_text(payload$search, "request.payload.search", frame_contract$limits$textBytes)
        }
        limit <- whole_number(payload$limit, "request.payload.limit", 10000L)
        if (limit < 1L) abort("invalid_request", "request.payload.limit must be positive")
        capture <- get(session_id, envir = sessions, inherits = FALSE)
        result <- frame_contract$materialize_column_values(capture, column, view, search, limit)
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

      if (identical(kind, "closeSession")) {
        payload <- exact_record(request$payload, c("sessionId"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is already closed", TRUE)
        }
        rm(list = session_id, envir = sessions)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "closed",
          sessionId = session_id
        ))
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
      encoded <- jsonlite::toJSON(
        response,
        auto_unbox = TRUE,
        digits = NA,
        na = "null",
        null = "null",
        pretty = FALSE
      )
      if (nchar(encoded, type = "bytes") > maximum_response_bytes) {
        stop("Open Wrangler refused an oversized R kernel response.", call. = FALSE)
      }
      enc2utf8(as.character(encoded))
    }

    environment(dispatch_json) <- environment()
    list(dispatch_json = dispatch_json)
  }

  list(new_agent = new_agent, transport_version = transport_version)
})
