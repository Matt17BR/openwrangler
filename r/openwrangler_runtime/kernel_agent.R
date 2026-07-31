# Native R provider proof for Open Wrangler v2.
#
# This file is designed to be sourced into the exact R process that owns a
# dataframe (for example an IRkernel or an explicitly connected R session).
# It deliberately does not use Python or convert data.frame subclasses.
# Sourcing evaluates to one factory function; all implementation symbols remain
# inside its private lexical environment.

(function(direct_execution) {
.ow_r_provider_protocol_version <- 1L
.ow_r_provider_runtime_version <- "0.1.0"
.ow_r_max_page_rows <- 10000L
.ow_r_max_page_columns <- 256L
.ow_r_max_page_cells <- 100000L
.ow_r_max_page_estimated_bytes <- 16777216L
.ow_r_max_schema_estimated_bytes <- 8388608L
.ow_r_max_text_characters <- 65536L
.ow_r_max_request_bytes <- 1048576L

create_open_wrangler_r_provider <- function(target_env = .GlobalEnv) {
  if (!is.environment(target_env)) {
    stop("target_env must be an R environment.", call. = FALSE)
  }
  .ow_require_jsonlite()
  sessions <- new.env(parent = emptyenv())

  dispatch <- function(envelope) {
    .ow_assert_record(envelope, c("protocolVersion", "requestId", "request"))
    if (!identical(envelope$protocolVersion, .ow_r_provider_protocol_version)) {
      stop("Unsupported R provider protocol version.", call. = FALSE)
    }
    .ow_assert_string(envelope$requestId, "requestId", max_characters = 256L)
    .ow_assert_record(envelope$request, "kind", allow_extra = TRUE)
    .ow_assert_string(envelope$request$kind, "request.kind", max_characters = 64L)
    if (!envelope$request$kind %in% c("initialize", "openSession", "getPage", "closeSession")) {
      stop("Unsupported R provider request kind.", call. = FALSE)
    }

    request <- envelope$request
    response <- switch(
      request$kind,
      initialize = .ow_initialize(request),
      openSession = .ow_open_session(request, target_env, sessions),
      getPage = .ow_get_page(request, sessions),
      closeSession = .ow_close_session(request, sessions),
      stop("Unsupported R provider request kind.", call. = FALSE)
    )
    list(
      protocolVersion = .ow_r_provider_protocol_version,
      requestId = envelope$requestId,
      response = response
    )
  }

  dispatch_json <- function(payload) {
    request_id <- "unknown"
    tryCatch(
      {
        if (
          !is.character(payload) ||
            length(payload) != 1L ||
            is.na(payload) ||
            nchar(payload, type = "bytes") > .ow_r_max_request_bytes
        ) {
          stop("R provider payload must be one bounded JSON string.", call. = FALSE)
        }
        envelope <- jsonlite::fromJSON(payload, simplifyVector = FALSE)
        if (
          is.list(envelope) &&
            .ow_is_bounded_string(envelope$requestId, max_characters = 256L)
        ) {
          request_id <- envelope$requestId
        }
        .ow_to_json(dispatch(envelope))
      },
      error = function(error) {
        .ow_to_json(list(
          protocolVersion = .ow_r_provider_protocol_version,
          requestId = request_id,
          response = list(
            kind = "error",
            code = "invalid_request",
            message = conditionMessage(error),
            recoverable = FALSE
          )
        ))
      }
    )
  }

  close <- function() {
    existing <- ls(sessions, all.names = TRUE)
    if (length(existing) > 0L) {
      rm(list = existing, envir = sessions)
    }
    invisible(NULL)
  }

  list(dispatch = dispatch, dispatch_json = dispatch_json, close = close)
}

.ow_initialize <- function(request) {
  .ow_assert_record(request, "kind")
  .ow_assert_kind(request, "initialize")
  list(
    kind = "initialized",
    runtimeVersion = .ow_r_provider_runtime_version,
    language = "r",
    transport = "inProcessR",
    capabilities = list(
      sourceKinds = list("notebookVariable"),
      dataFrameClasses = list("data.frame", "tbl_df", "data.table"),
      paging = TRUE,
      filtering = FALSE,
      sorting = FALSE,
      editing = FALSE
    )
  )
}

.ow_open_session <- function(request, target_env, sessions) {
  .ow_assert_record(
    request,
    c("kind", "source", "requestedSessionId", "pageSize", "columnOffset", "columnLimit"),
    optional = c("backend", "mode")
  )
  .ow_assert_kind(request, "openSession")
  .ow_assert_string(request$requestedSessionId, "requestedSessionId", max_characters = 256L)
  .ow_assert_bounded_integer(request$pageSize, "pageSize", 1L, .ow_r_max_page_rows)
  .ow_assert_bounded_integer(request$columnOffset, "columnOffset", 0L, .Machine$integer.max)
  .ow_assert_bounded_integer(request$columnLimit, "columnLimit", 1L, .ow_r_max_page_columns)
  if (!is.null(request$backend) && !identical(request$backend, "r")) {
    stop("The native R provider accepts only backend 'r'.", call. = FALSE)
  }
  if (!is.null(request$mode) && !identical(request$mode, "viewing")) {
    stop("The native R foundation is read-only.", call. = FALSE)
  }

  source <- request$source
  .ow_assert_record(source, c("kind", "label", "variableName"))
  if (!identical(source$kind, "notebookVariable")) {
    stop("The native R foundation accepts only live notebook variables.", call. = FALSE)
  }
  .ow_assert_string(source$label, "source.label")
  .ow_assert_string(source$variableName, "source.variableName", max_characters = 1024L)
  if (!exists(source$variableName, envir = target_env, inherits = FALSE)) {
    stop("The selected R variable no longer exists in the exact source environment.", call. = FALSE)
  }
  if (exists(request$requestedSessionId, envir = sessions, inherits = FALSE)) {
    stop("The requested R provider session already exists.", call. = FALSE)
  }

  source_value <- get(source$variableName, envir = target_env, inherits = FALSE)
  if (!is.data.frame(source_value)) {
    stop("The selected R variable must inherit from data.frame.", call. = FALSE)
  }
  .ow_validate_supported_dataframe(source_value)
  value <- .ow_snapshot_source(source_value)
  metadata <- .ow_metadata(request$requestedSessionId, source, value)
  page <- .ow_page(value, request$pageSize, 0L, request$columnOffset, request$columnLimit)
  session <- list(value = value, metadata = metadata)
  assign(request$requestedSessionId, session, envir = sessions)

  list(
    kind = "sessionOpened",
    metadata = metadata,
    page = page
  )
}

.ow_get_page <- function(request, sessions) {
  .ow_assert_record(
    request,
    c(
      "kind",
      "sessionId",
      "revision",
      "viewRequestId",
      "offset",
      "limit",
      "columnOffset",
      "columnLimit",
      "filterModel"
    )
  )
  .ow_assert_kind(request, "getPage")
  .ow_assert_string(request$sessionId, "sessionId", max_characters = 256L)
  .ow_assert_string(request$viewRequestId, "viewRequestId", max_characters = 256L)
  .ow_assert_bounded_integer(request$revision, "revision", 0L, 0L)
  .ow_assert_bounded_integer(request$offset, "offset", 0L, .Machine$integer.max)
  .ow_assert_bounded_integer(request$limit, "limit", 1L, .ow_r_max_page_rows)
  .ow_assert_bounded_integer(request$columnOffset, "columnOffset", 0L, .Machine$integer.max)
  .ow_assert_bounded_integer(request$columnLimit, "columnLimit", 1L, .ow_r_max_page_columns)
  .ow_assert_empty_view(request$filterModel)

  session <- .ow_session(sessions, request$sessionId)
  list(
    kind = "page",
    sessionId = request$sessionId,
    revision = 0L,
    viewRequestId = request$viewRequestId,
    page = .ow_page(session$value, request$limit, request$offset, request$columnOffset, request$columnLimit)
  )
}

.ow_close_session <- function(request, sessions) {
  .ow_assert_record(request, c("kind", "sessionId", "revision"))
  .ow_assert_kind(request, "closeSession")
  .ow_assert_string(request$sessionId, "sessionId", max_characters = 256L)
  .ow_assert_bounded_integer(request$revision, "revision", 0L, 0L)
  .ow_session(sessions, request$sessionId)
  rm(list = request$sessionId, envir = sessions)
  list(kind = "sessionClosed", sessionId = request$sessionId)
}

.ow_session <- function(sessions, session_id) {
  if (!exists(session_id, envir = sessions, inherits = FALSE)) {
    stop("Unknown R provider session.", call. = FALSE)
  }
  get(session_id, envir = sessions, inherits = FALSE)
}

.ow_metadata <- function(session_id, source, value) {
  schema <- .ow_schema(value)
  list(
    providerProtocolVersion = .ow_r_provider_protocol_version,
    sessionId = session_id,
    backend = "r",
    mode = "viewing",
    source = source,
    sourceClass = .ow_dataframe_class(value),
    shape = list(rows = nrow(value), columns = ncol(value)),
    schema = schema
  )
}

.ow_schema <- function(value) {
  if (ncol(value) == 0L) {
    return(list())
  }
  schema_cost <- 1024
  unname(lapply(seq_len(ncol(value)), function(index) {
    column <- value[[index]]
    classes <- class(column)
    schema <- list(
      id = paste0("r:c:", index - 1L),
      name = .ow_column_name(value, index),
      position = index - 1L,
      rawType = paste0(typeof(column), "<", paste(classes, collapse = ","), ">"),
      type = .ow_column_type(column),
      nullable = anyNA(column)
    )
    schema_cost <<-
      schema_cost +
      256 +
      6 * (nchar(schema$name, type = "bytes") + nchar(schema$rawType, type = "bytes"))
    if (schema_cost > .ow_r_max_schema_estimated_bytes) {
      stop(
        "The R dataframe schema exceeds the bounded transport budget.",
        call. = FALSE
      )
    }
    schema
  }))
}

.ow_page <- function(value, limit, offset, column_offset, column_limit) {
  total_rows <- nrow(value)
  total_columns <- ncol(value)
  offset <- as.double(offset)
  limit <- as.double(limit)
  column_offset <- as.double(column_offset)
  column_limit <- as.double(column_limit)
  first_row <- min(offset + 1, total_rows + 1)
  final_row <- min(offset + limit, total_rows)
  first_column <- min(column_offset + 1, total_columns + 1)
  final_column <- min(column_offset + column_limit, total_columns)
  row_indices <- if (first_row <= final_row) seq.int(first_row, final_row) else integer()
  column_indices <-
    if (first_column <= final_column) seq.int(first_column, final_column) else integer()
  .ow_assert_page_window(length(row_indices), length(column_indices))
  column_ids <- unname(lapply(column_indices, function(index) paste0("r:c:", index - 1L)))
  page_cost <- 1024 + 64 * length(column_ids)
  rows <- unname(lapply(row_indices, function(row_index) {
    page_cost <<- page_cost + 128
    list(
      id = paste0("r:row:", row_index - 1L),
      rowNumber = row_index - 1L,
      values = unname(lapply(column_indices, function(column_index) {
        cell <- .ow_cell_at(value[[column_index]], row_index)
        page_cost <<- page_cost + .ow_cell_estimated_bytes(cell)
        if (page_cost > .ow_r_max_page_estimated_bytes) {
          stop(
            "The requested R provider page exceeds the bounded transport budget; request a smaller window.",
            call. = FALSE
          )
        }
        cell
      }))
    )
  }))
  list(
    offset = offset,
    limit = limit,
    totalRows = total_rows,
    columnIds = column_ids,
    rows = rows
  )
}

.ow_cell_at <- function(column, row_index) {
  value <- if (is.list(column) && !inherits(column, "POSIXlt")) {
    column[[row_index]]
  } else {
    column[row_index]
  }

  if (is.null(value) || length(value) == 0L) {
    return(.ow_cell("null", NA, "", TRUE, FALSE))
  }
  if (length(value) != 1L) {
    return(.ow_cell("unknown", NA, .ow_unknown_display(value), FALSE, FALSE))
  }
  if (is.numeric(value) && is.nan(value)) {
    return(.ow_cell("nan", NA, "NaN", FALSE, TRUE))
  }
  if (.ow_is_missing_scalar(value)) {
    return(.ow_cell("null", NA, "", TRUE, FALSE))
  }
  if (inherits(value, "POSIXt")) {
    display <- format(value, "%Y-%m-%dT%H:%M:%OS6%z", tz = .ow_timezone(value))
    return(.ow_cell("datetime", display, display, FALSE, FALSE))
  }
  if (inherits(value, "Date")) {
    display <- format(value, "%Y-%m-%d")
    return(.ow_cell("date", display, display, FALSE, FALSE))
  }
  if (inherits(value, "difftime")) {
    seconds <- as.numeric(value, units = "secs")
    display <- format(seconds, scientific = FALSE, trim = TRUE, digits = 15L)
    return(.ow_cell("duration", display, display, FALSE, FALSE))
  }
  if (is.factor(value)) {
    value <- as.character(value)
  }
  if (is.character(value)) {
    text <- .ow_bound_text(value)
    return(.ow_cell("string", text, text, FALSE, FALSE))
  }
  if (is.logical(value)) {
    return(.ow_cell("boolean", value, if (value) "true" else "false", FALSE, FALSE))
  }
  if (is.integer(value)) {
    display <- as.character(value)
    return(.ow_cell("integer", display, display, FALSE, FALSE))
  }
  if (inherits(value, "integer64")) {
    display <- as.character(value)
    return(.ow_cell("integer", display, display, FALSE, FALSE))
  }
  if (is.double(value) && !inherits(value, "integer64")) {
    if (is.infinite(value)) {
      sign <- if (value < 0) -1L else 1L
      return(.ow_cell(
        "infinity",
        NA,
        if (sign < 0L) "-Infinity" else "Infinity",
        FALSE,
        FALSE,
        sign = sign
      ))
    }
    display <- format(value, scientific = FALSE, trim = TRUE, digits = 15L)
    return(.ow_cell("number", value, display, FALSE, FALSE))
  }
  .ow_cell("unknown", NA, .ow_unknown_display(value), FALSE, FALSE)
}

.ow_cell <- function(kind, raw, display, is_null, is_nan, sign = NULL) {
  result <- list(
    kind = kind,
    raw = raw,
    display = display,
    isNull = is_null,
    isNaN = is_nan
  )
  if (!is.null(sign)) {
    result$sign <- sign
  }
  result
}

.ow_cell_estimated_bytes <- function(cell) {
  raw_bytes <- if (is.character(cell$raw) && length(cell$raw) == 1L && !is.na(cell$raw)) {
    nchar(cell$raw, type = "bytes")
  } else {
    0
  }
  128 + 6 * (nchar(cell$display, type = "bytes") + raw_bytes)
}

.ow_column_type <- function(column) {
  if (inherits(column, "POSIXt")) return("datetime")
  if (inherits(column, "Date")) return("date")
  if (inherits(column, "difftime")) return("duration")
  if (is.factor(column) || is.character(column)) return("string")
  if (is.logical(column)) return("boolean")
  if (is.integer(column)) return("integer")
  if (inherits(column, "integer64")) return("integer")
  if (is.double(column) && !inherits(column, "integer64")) return("float")
  "unknown"
}

.ow_dataframe_class <- function(value) {
  if (inherits(value, "data.table")) return("data.table")
  if (inherits(value, "tbl_df")) return("tbl_df")
  "data.frame"
}

.ow_validate_supported_dataframe <- function(value) {
  if (ncol(value) == 0L) {
    return(invisible(NULL))
  }
  for (index in seq_len(ncol(value))) {
    column <- value[[index]]
    if (!is.null(dim(column))) {
      stop(
        paste0(
          "R column ",
          index,
          " is shaped (matrix or array); nested encoding is not implemented yet."
        ),
        call. = FALSE
      )
    }
    if (is.list(column)) {
      stop(
        paste0("R column ", index, " is a list; nested encoding is not implemented yet."),
        call. = FALSE
      )
    }
    if (is.raw(column)) {
      stop(
        paste0("R column ", index, " is raw; binary encoding is not implemented yet."),
        call. = FALSE
      )
    }
    supported <-
      inherits(column, "POSIXt") ||
      inherits(column, "Date") ||
      inherits(column, "difftime") ||
      inherits(column, "integer64") ||
      is.factor(column) ||
      is.character(column) ||
      is.logical(column) ||
      is.integer(column) ||
      is.double(column)
    if (!supported) {
      stop(
        paste0("R column ", index, " has an unsupported native type."),
        call. = FALSE
      )
    }
  }
  invisible(NULL)
}

.ow_snapshot_source <- function(value) {
  if (!inherits(value, "data.table")) {
    return(value)
  }
  if (!requireNamespace("data.table", quietly = TRUE)) {
    stop(
      "A data.table source requires the data.table package for an immutable native snapshot.",
      call. = FALSE
    )
  }
  snapshot <- data.table::copy(value)
  if (!data.table::is.data.table(snapshot)) {
    stop("The native data.table snapshot did not preserve its class.", call. = FALSE)
  }
  snapshot
}

.ow_assert_empty_view <- function(value) {
  .ow_assert_record(value, c("logic", "filters", "sort"))
  if (
    !identical(value$logic, "and") ||
      !.ow_is_empty_array(value$filters) ||
      !.ow_is_empty_array(value$sort)
  ) {
    stop("The native R foundation does not implement viewing filters or sorts yet.", call. = FALSE)
  }
}

.ow_assert_kind <- function(request, expected) {
  .ow_assert_string(request$kind, "request.kind", max_characters = 64L)
  if (!identical(request$kind, expected)) {
    stop(paste0("Expected R provider request kind '", expected, "'."), call. = FALSE)
  }
}

.ow_assert_record <- function(value, required, optional = character(), allow_extra = FALSE) {
  if (!is.list(value) || is.null(names(value)) || any(names(value) == "")) {
    stop("R provider values must be JSON objects.", call. = FALSE)
  }
  actual <- names(value)
  if (anyDuplicated(actual) != 0L) {
    stop("R provider objects must not contain duplicate fields.", call. = FALSE)
  }
  if (!all(required %in% actual)) {
    stop("R provider request is missing a required field.", call. = FALSE)
  }
  if (!allow_extra && !all(actual %in% c(required, optional))) {
    stop("R provider request contains an unknown field.", call. = FALSE)
  }
  invisible(NULL)
}

.ow_assert_string <- function(value, label, max_characters = .ow_r_max_text_characters) {
  if (
    !is.character(value) ||
      length(value) != 1L ||
      is.na(value) ||
      nchar(value, type = "chars") == 0L ||
      nchar(value, type = "chars") > max_characters
  ) {
    stop(paste0(label, " must be one bounded non-empty string."), call. = FALSE)
  }
}

.ow_assert_bounded_integer <- function(value, label, minimum, maximum) {
  if (
    length(value) != 1L ||
      is.na(value) ||
      !is.numeric(value) ||
      !is.finite(value) ||
      value != floor(value) ||
      value < minimum ||
      value > maximum
  ) {
    stop(paste0(label, " must be a bounded integer."), call. = FALSE)
  }
}

.ow_assert_page_window <- function(rows, columns) {
  if (as.double(rows) * as.double(columns) > .ow_r_max_page_cells) {
    stop(
      paste0("An R provider page may contain at most ", .ow_r_max_page_cells, " cells."),
      call. = FALSE
    )
  }
}

.ow_is_bounded_string <- function(value, max_characters) {
  is.character(value) &&
    length(value) == 1L &&
    !is.na(value) &&
    nchar(value, type = "chars") > 0L &&
    nchar(value, type = "chars") <= max_characters
}

.ow_is_empty_array <- function(value) {
  is.list(value) && is.null(names(value)) && length(value) == 0L
}

.ow_is_missing_scalar <- function(value) {
  is.atomic(value) && length(value) == 1L && is.na(value)
}

.ow_unknown_display <- function(value) {
  classes <- class(value)
  .ow_bound_text(paste0("<", if (length(classes) > 0L) classes[[1]] else typeof(value), ">"))
}

.ow_bound_text <- function(value) {
  if (nchar(value, type = "chars") <= .ow_r_max_text_characters) {
    return(value)
  }
  paste0(substr(value, 1L, .ow_r_max_text_characters - 1L), "\u2026")
}

.ow_column_name <- function(value, index) {
  name <- names(value)[[index]]
  if (is.na(name)) "" else .ow_bound_text(name)
}

.ow_timezone <- function(value) {
  timezone <- attr(value, "tzone")
  if (
    is.null(timezone) ||
      length(timezone) == 0L ||
      is.na(timezone[[1]]) ||
      timezone[[1]] == ""
  ) {
    "UTC"
  } else {
    timezone[[1]]
  }
}

.ow_require_jsonlite <- function() {
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop(
      "The native R provider requires the jsonlite package. Open Wrangler must ask before installing it.",
      call. = FALSE
    )
  }
}

.ow_to_json <- function(value) {
  jsonlite::toJSON(
    value,
    auto_unbox = TRUE,
    null = "null",
    na = "null",
    digits = NA,
    POSIXt = "ISO8601",
    force = TRUE
  )
}

if (direct_execution) {
  arguments <- commandArgs(trailingOnly = TRUE)
  if (!identical(arguments, "--probe")) {
    stop("Run this provider directly only with --probe, or source it into an exact R session.", call. = FALSE)
  }
  provider <- create_open_wrangler_r_provider(new.env(parent = emptyenv()))
  cat(provider$dispatch_json(
    '{"protocolVersion":1,"requestId":"probe","request":{"kind":"initialize"}}'
  ))
  cat("\n")
  return(invisible(NULL))
}

create_open_wrangler_r_provider
})(sys.nframe() == 0L)
