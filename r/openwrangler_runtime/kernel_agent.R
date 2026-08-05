openwrangler_r_kernel_agent <- local({
  transport_version <- 1L
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
    } else if (identical(source_code, "invalid-view-query")) {
      code <- "invalid_request"
      recoverable <- FALSE
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

  exact_record <- function(value, fields, label) {
    if (!is.list(value) || is.object(value) || is.null(names(value))) {
      abort("invalid_request", sprintf("%s must be an object", label))
    }
    field_names <- names(value)
    if (
      anyNA(field_names) ||
        any(field_names == "") ||
        anyDuplicated(field_names) ||
        !setequal(field_names, fields) ||
        length(field_names) != length(fields)
    ) {
      abort("invalid_request", sprintf("%s has invalid fields", label))
    }
    value
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
      column <- exact_record(rule$column, c("id", "name"), sprintf("sort[%d].column", index))
      column_id <- bounded_text(column$id, sprintf("sort[%d].column.id", index), maximum_identifier_bytes)
      column_name <- bounded_text(column$name, sprintf("sort[%d].column.name", index), maximum_variable_name_bytes)
      if (!rule$direction %in% c("asc", "desc") || !rule$nulls %in% c("first", "last")) {
        abort("invalid_request", sprintf("sort[%d] has an unsupported order", index))
      }
      list(
        column = list(id = column_id, name = column_name),
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

  decode_page <- function(value, limits) {
    page <- exact_record(
      value,
      c("rowOffset", "rowLimit", "columnOffset", "columnLimit", "sorts"),
      "request.page"
    )
    list(
      row_offset = whole_number(page$rowOffset, "request.page.rowOffset", limits$rows),
      row_limit = whole_number(page$rowLimit, "request.page.rowLimit", limits$pageRows),
      column_offset = whole_number(page$columnOffset, "request.page.columnOffset", limits$columns),
      column_limit = whole_number(page$columnLimit, "request.page.columnLimit", limits$pageColumns),
      sorts = decode_sort_rules(page$sorts, limits)
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
      reference <- exact_record(value[[index]], c("id", "name"), sprintf("columns[%d]", index))
      list(
        id = bounded_text(reference$id, sprintf("columns[%d].id", index), maximum_identifier_bytes),
        name = bounded_text(reference$name, sprintf("columns[%d].name", index), maximum_variable_name_bytes)
      )
    })
    ids <- vapply(references, `[[`, character(1L), "id", USE.NAMES = FALSE)
    if (anyDuplicated(ids)) {
      abort("invalid_request", "request.payload.columns contains a repeated column identity")
    }
    references
  }

  materialize <- function(frame_contract, capture, page) {
    frame_contract$materialize_view_page(
      capture,
      sort_rules = page$sorts,
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
      "materialize_dataset_stats"
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
        payload <- exact_record(request$payload, c("sessionId", "columns"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        columns <- decode_column_references(payload$columns, frame_contract$limits)
        capture <- get(session_id, envir = sessions, inherits = FALSE)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "summary",
          sessionId = session_id,
          summaries = frame_contract$materialize_summaries(capture, columns)
        ))
      }

      if (identical(kind, "getDatasetStats")) {
        payload <- exact_record(request$payload, c("sessionId"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        capture <- get(session_id, envir = sessions, inherits = FALSE)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "datasetStats",
          sessionId = session_id,
          stats = frame_contract$materialize_dataset_stats(capture)
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
