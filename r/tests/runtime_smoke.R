arguments <- commandArgs(trailingOnly = FALSE)
file_argument <- arguments[startsWith(arguments, "--file=")]
if (length(file_argument) != 1L) {
  stop("Run this smoke test with Rscript.", call. = FALSE)
}
test_file <- normalizePath(sub("^--file=", "", file_argument), mustWork = TRUE)
repository_root <- normalizePath(file.path(dirname(test_file), "..", ".."), mustWork = TRUE)
agent_environment <- new.env(parent = baseenv())
agent_source <- source(
  file.path(repository_root, "r", "openwrangler_runtime", "kernel_agent.R"),
  local = agent_environment
)
stopifnot(
  is.function(agent_source$value),
  length(ls(agent_environment, all.names = TRUE)) == 0L
)
create_open_wrangler_r_provider <- agent_source$value

required_packages <- c("jsonlite", "tibble", "data.table")
missing_packages <- required_packages[
  !vapply(required_packages, requireNamespace, logical(1), quietly = TRUE)
]
if (length(missing_packages) > 0L) {
  stop(
    paste0(
      "The required native-R gate is missing: ",
      paste(missing_packages, collapse = ", "),
      "."
    ),
    call. = FALSE
  )
}

target_env <- new.env(parent = emptyenv())
target_env$base_frame <- data.frame(
  integer_value = c(1L, NA_integer_, 3L),
  text_value = c("alpha", "beta", "gamma"),
  boolean_value = c(TRUE, FALSE, NA),
  numeric_value = c(1.5, NaN, Inf),
  date_value = as.Date(c("2026-01-01", "2026-01-02", NA)),
  check.names = FALSE
)
target_env$exact_cell_frame <- as.data.frame(
  matrix(1L, nrow = 1000L, ncol = 100L),
  check.names = FALSE
)
target_env$wide_frame <- as.data.frame(
  matrix(1L, nrow = 1000L, ncol = 101L),
  check.names = FALSE
)
exact_text <- strrep("x", 65536L)
target_env$exact_text_frame <- data.frame(value = exact_text, check.names = FALSE)
target_env$oversized_text_frame <- data.frame(value = paste0(exact_text, "x"), check.names = FALSE)
target_env$exact_name_frame <- setNames(data.frame(value = 1L, check.names = FALSE), exact_text)
target_env$oversized_name_frame <- setNames(
  data.frame(value = 1L, check.names = FALSE),
  paste0(exact_text, "x")
)
target_env$oversized_shape_frame <- structure(
  rep(list(1L), 16385L),
  names = paste0("column_", seq_len(16385L)),
  class = "data.frame",
  row.names = .set_row_names(1L)
)
target_env$oversized_schema_frame <- structure(
  rep(list(1L), 22L),
  names = paste0(strrep("s", 65530L), sprintf("%06d", seq_len(22L))),
  class = "data.frame",
  row.names = .set_row_names(1L)
)
target_env$oversized_page_bytes_frame <- data.frame(
  value = rep(strrep("p", 65536L), 22L),
  check.names = FALSE
)
target_env$zero_frame <- data.frame(value = character(), check.names = FALSE)
target_env$empty_name_frame <- setNames(data.frame(value = 1L, check.names = FALSE), "")
target_env$na_name_frame <- setNames(data.frame(value = 1L, check.names = FALSE), NA_character_)
target_env$invalid_class_frame <- data.frame(value = character(), check.names = FALSE)
class(target_env$invalid_class_frame$value) <- c("bad,class", "character")
target_env$invalid_storage_frame <- data.frame(value = integer(), check.names = FALSE)
class(target_env$invalid_storage_frame$value) <- "Date"
original_bytes <- serialize(target_env$base_frame, NULL, version = 3L)
provider <- create_open_wrangler_r_provider(target_env)

request <- function(request_id, body) {
  payload <- jsonlite::toJSON(
    list(protocolVersion = 1L, requestId = request_id, request = body),
    auto_unbox = TRUE,
    null = "null",
    na = "null"
  )
  jsonlite::fromJSON(provider$dispatch_json(payload), simplifyVector = FALSE)
}

initialized <- request("initialize", list(kind = "initialize"))
stopifnot(
  identical(initialized$protocolVersion, 1L),
  identical(initialized$requestId, "initialize"),
  identical(initialized$response$kind, "initialized"),
  identical(initialized$response$language, "r"),
  identical(initialized$response$capabilities$editing, FALSE)
)

opened <- request("open", list(
  kind = "openSession",
  source = list(kind = "notebookVariable", label = "base_frame", variableName = "base_frame"),
  requestedSessionId = "r-session-smoke",
  backend = "r",
  mode = "viewing",
  pageSize = 2L,
  columnOffset = 0L,
  columnLimit = 3L
))
stopifnot(
  identical(opened$response$kind, "sessionOpened"),
  identical(opened$response$metadata$backend, "r"),
  identical(opened$response$metadata$sourceClass, "data.frame"),
  identical(opened$response$metadata$shape$rows, 3L),
  identical(opened$response$metadata$shape$columns, 5L),
  identical(opened$response$page$columnIds, list("r:c:0", "r:c:1", "r:c:2")),
  length(opened$response$page$rows) == 2L,
  identical(opened$response$page$rows[[1]]$values[[1]]$kind, "integer"),
  identical(opened$response$page$rows[[1]]$values[[2]]$raw, "alpha")
)

page <- request("page", list(
  kind = "getPage",
  sessionId = "r-session-smoke",
  revision = 0L,
  viewRequestId = "view-2",
  offset = 1L,
  limit = 2L,
  columnOffset = 3L,
  columnLimit = 2L,
  filterModel = list(logic = "and", filters = list(), sort = list())
))
stopifnot(
  identical(page$response$kind, "page"),
  identical(page$response$viewRequestId, "view-2"),
  identical(page$response$page$columnIds, list("r:c:3", "r:c:4")),
  identical(page$response$page$rows[[1]]$values[[1]]$kind, "nan"),
  identical(page$response$page$rows[[2]]$values[[1]]$kind, "infinity")
)

malformed <- request("malformed", list(kind = "getPage"))
stopifnot(
  identical(malformed$response$kind, "error"),
  identical(malformed$response$code, "invalid_request"),
  identical(malformed$response$recoverable, FALSE)
)

numeric_kind <- request("numeric-kind", list(kind = 7L))
stopifnot(
  identical(numeric_kind$response$kind, "error"),
  grepl("request.kind must be", numeric_kind$response$message, fixed = TRUE)
)

duplicate_field <- jsonlite::fromJSON(
  provider$dispatch_json(
    '{"protocolVersion":1,"requestId":"duplicate","request":{"kind":"initialize","kind":"initialize"}}'
  ),
  simplifyVector = FALSE
)
stopifnot(
  identical(duplicate_field$response$kind, "error"),
  identical(duplicate_field$response$code, "invalid_request")
)

object_instead_of_array <- jsonlite::fromJSON(
  provider$dispatch_json(
    paste0(
      '{"protocolVersion":1,"requestId":"object-filter","request":{',
      '"kind":"getPage","sessionId":"r-session-smoke","revision":0,',
      '"viewRequestId":"view-object","offset":0,"limit":1,',
      '"columnOffset":0,"columnLimit":1,',
      '"filterModel":{"logic":"and","filters":{},"sort":[]}}}'
    )
  ),
  simplifyVector = FALSE
)
stopifnot(identical(object_instead_of_array$response$kind, "error"))

bounded_request_payload <-
  '{"protocolVersion":1,"requestId":"bounded-request","request":{"kind":"initialize"}}'
bounded_request_payload <- paste0(
  bounded_request_payload,
  strrep(" ", 1048576L - nchar(bounded_request_payload, type = "bytes"))
)
stopifnot(nchar(bounded_request_payload, type = "bytes") == 1048576L)
bounded_request <- jsonlite::fromJSON(
  provider$dispatch_json(bounded_request_payload),
  simplifyVector = FALSE
)
stopifnot(identical(bounded_request$response$kind, "initialized"))
oversized_request <- jsonlite::fromJSON(
  provider$dispatch_json(paste0(bounded_request_payload, " ")),
  simplifyVector = FALSE
)
stopifnot(
  identical(oversized_request$response$kind, "error"),
  identical(oversized_request$response$code, "request_too_large"),
  identical(oversized_request$response$recoverable, TRUE)
)

exact_cell_page <- request("exact-cell-open", list(
  kind = "openSession",
  source = list(
    kind = "notebookVariable",
    label = "exact_cell_frame",
    variableName = "exact_cell_frame"
  ),
  requestedSessionId = "r-exact-cell-smoke",
  pageSize = 1000L,
  columnOffset = 0L,
  columnLimit = 100L
))
stopifnot(
  identical(exact_cell_page$response$kind, "sessionOpened"),
  length(exact_cell_page$response$page$rows) == 1000L,
  length(exact_cell_page$response$page$rows[[1000L]]$values) == 100L
)

oversized_page <- request("wide-open", list(
  kind = "openSession",
  source = list(kind = "notebookVariable", label = "wide_frame", variableName = "wide_frame"),
  requestedSessionId = "r-wide-smoke",
  pageSize = 1000L,
  columnOffset = 0L,
  columnLimit = 101L
))
stopifnot(
  identical(oversized_page$response$kind, "error"),
  identical(oversized_page$response$code, "resource_limit"),
  identical(oversized_page$response$recoverable, TRUE),
  grepl("100000 cells", oversized_page$response$message, fixed = TRUE)
)
unretained_failed_open <- request(
  "wide-close",
  list(kind = "closeSession", sessionId = "r-wide-smoke", revision = 0L)
)
stopifnot(
  identical(unretained_failed_open$response$kind, "error"),
  grepl("Unknown R provider session", unretained_failed_open$response$message, fixed = TRUE)
)

exact_text_open <- request("exact-text-open", list(
  kind = "openSession",
  source = list(
    kind = "notebookVariable",
    label = "exact_text_frame",
    variableName = "exact_text_frame"
  ),
  requestedSessionId = "r-exact-text-smoke",
  pageSize = 1L,
  columnOffset = 0L,
  columnLimit = 1L
))
stopifnot(
  identical(exact_text_open$response$kind, "sessionOpened"),
  identical(exact_text_open$response$page$rows[[1L]]$values[[1L]]$raw, exact_text),
  identical(exact_text_open$response$page$rows[[1L]]$values[[1L]]$display, exact_text),
  !grepl("\u2026$", exact_text_open$response$page$rows[[1L]]$values[[1L]]$raw)
)

exact_name_open <- request("exact-name-open", list(
  kind = "openSession",
  source = list(
    kind = "notebookVariable",
    label = "exact_name_frame",
    variableName = "exact_name_frame"
  ),
  requestedSessionId = "r-exact-name-smoke",
  pageSize = 1L,
  columnOffset = 0L,
  columnLimit = 1L
))
stopifnot(
  identical(exact_name_open$response$kind, "sessionOpened"),
  identical(exact_name_open$response$metadata$schema[[1L]]$name, exact_text),
  !grepl("\u2026$", exact_name_open$response$metadata$schema[[1L]]$name)
)

zero_open <- request("zero-open", list(
  kind = "openSession",
  source = list(kind = "notebookVariable", label = "zero_frame", variableName = "zero_frame"),
  requestedSessionId = "r-zero-smoke",
  pageSize = 1L,
  columnOffset = 0L,
  columnLimit = 1L
))
stopifnot(
  identical(zero_open$response$kind, "sessionOpened"),
  identical(zero_open$response$metadata$shape$rows, 0L),
  identical(zero_open$response$metadata$schema[[1L]]$id, "r:c:0"),
  identical(zero_open$response$metadata$schema[[1L]]$type, "string"),
  identical(zero_open$response$metadata$schema[[1L]]$rawType, "character<character>"),
  identical(zero_open$response$page$columnIds, list("r:c:0")),
  length(zero_open$response$page$rows) == 0L
)

empty_name_open <- request("empty-name-open", list(
  kind = "openSession",
  source = list(
    kind = "notebookVariable",
    label = "empty_name_frame",
    variableName = "empty_name_frame"
  ),
  requestedSessionId = "r-empty-name-smoke",
  pageSize = 1L,
  columnOffset = 0L,
  columnLimit = 1L
))
stopifnot(
  identical(empty_name_open$response$kind, "sessionOpened"),
  identical(empty_name_open$response$metadata$schema[[1L]]$name, "")
)

for (case in list(
  list(variable = "na_name_frame", session = "r-na-name-smoke", message = "NA name"),
  list(
    variable = "invalid_class_frame",
    session = "r-invalid-class-smoke",
    message = "cannot be represented exactly"
  ),
  list(
    variable = "invalid_storage_frame",
    session = "r-invalid-storage-smoke",
    message = "storage and semantic type"
  )
)) {
  rejected <- request(paste0(case$variable, "-open"), list(
    kind = "openSession",
    source = list(
      kind = "notebookVariable",
      label = case$variable,
      variableName = case$variable
    ),
    requestedSessionId = case$session,
    pageSize = 1L,
    columnOffset = 0L,
    columnLimit = 1L
  ))
  stopifnot(
    identical(rejected$response$kind, "error"),
    identical(rejected$response$code, "invalid_schema"),
    identical(rejected$response$recoverable, FALSE),
    grepl(case$message, rejected$response$message, fixed = TRUE)
  )
  rejected_close <- request(
    paste0(case$variable, "-close"),
    list(kind = "closeSession", sessionId = case$session, revision = 0L)
  )
  stopifnot(
    identical(rejected_close$response$kind, "error"),
    grepl("Unknown R provider session", rejected_close$response$message, fixed = TRUE)
  )
}

for (case in list(
  list(
    variable = "oversized_text_frame",
    session = "r-oversized-text-smoke",
    message = "R string cell"
  ),
  list(
    variable = "oversized_name_frame",
    session = "r-oversized-name-smoke",
    message = "R column 1 name"
  ),
  list(
    variable = "oversized_shape_frame",
    session = "r-oversized-shape-smoke",
    message = "dataframe shape"
  ),
  list(
    variable = "oversized_schema_frame",
    session = "r-oversized-schema-smoke",
    message = "schema exceeds"
  )
)) {
  rejected <- request(paste0(case$variable, "-open"), list(
    kind = "openSession",
    source = list(
      kind = "notebookVariable",
      label = case$variable,
      variableName = case$variable
    ),
    requestedSessionId = case$session,
    pageSize = 1L,
    columnOffset = 0L,
    columnLimit = 1L
  ))
  stopifnot(
    identical(rejected$response$kind, "error"),
    identical(rejected$response$code, "resource_limit"),
    identical(rejected$response$recoverable, FALSE),
    grepl(case$message, rejected$response$message, fixed = TRUE),
    !grepl("\u2026", rejected$response$message, fixed = TRUE)
  )
  rejected_close <- request(
    paste0(case$variable, "-close"),
    list(kind = "closeSession", sessionId = case$session, revision = 0L)
  )
  stopifnot(identical(rejected_close$response$kind, "error"))
}

oversized_page_bytes <- request("oversized-page-bytes-open", list(
  kind = "openSession",
  source = list(
    kind = "notebookVariable",
    label = "oversized_page_bytes_frame",
    variableName = "oversized_page_bytes_frame"
  ),
  requestedSessionId = "r-oversized-page-bytes-smoke",
  pageSize = 22L,
  columnOffset = 0L,
  columnLimit = 1L
))
stopifnot(
  identical(oversized_page_bytes$response$kind, "error"),
  identical(oversized_page_bytes$response$code, "resource_limit"),
  identical(oversized_page_bytes$response$recoverable, TRUE),
  grepl("request a smaller window", oversized_page_bytes$response$message, fixed = TRUE)
)

closed <- request("close", list(kind = "closeSession", sessionId = "r-session-smoke", revision = 0L))
stopifnot(identical(closed$response$kind, "sessionClosed"))
stopifnot(identical(original_bytes, serialize(target_env$base_frame, NULL, version = 3L)))

target_env$tibble_frame <- tibble::tibble(value = 1:2)
tibble_open <- request("tibble-open", list(
  kind = "openSession",
  source = list(kind = "notebookVariable", label = "tibble_frame", variableName = "tibble_frame"),
  requestedSessionId = "r-tibble-smoke",
  pageSize = 2L,
  columnOffset = 0L,
  columnLimit = 1L
))
stopifnot(
  identical(tibble_open$response$metadata$sourceClass, "tbl_df"),
  inherits(target_env$tibble_frame, "tbl_df")
)

target_env$data_table_frame <- data.table::data.table(value = 1:2)
data_table_open <- request("data-table-open", list(
  kind = "openSession",
  source = list(kind = "notebookVariable", label = "data_table_frame", variableName = "data_table_frame"),
  requestedSessionId = "r-data-table-smoke",
  pageSize = 2L,
  columnOffset = 0L,
  columnLimit = 1L
))
stopifnot(
  identical(data_table_open$response$metadata$sourceClass, "data.table"),
  data.table::is.data.table(target_env$data_table_frame)
)
target_env$data_table_frame[, value := value + 100L]
data_table_page <- request("data-table-page", list(
  kind = "getPage",
  sessionId = "r-data-table-smoke",
  revision = 0L,
  viewRequestId = "data-table-view",
  offset = 0L,
  limit = 2L,
  columnOffset = 0L,
  columnLimit = 1L,
  filterModel = list(logic = "and", filters = list(), sort = list())
))
stopifnot(
  identical(data_table_page$response$page$rows[[1]]$values[[1]]$raw, "1"),
  identical(data_table_page$response$page$rows[[2]]$values[[1]]$raw, "2"),
  identical(target_env$data_table_frame$value, c(101L, 102L)),
  identical(target_env$data_table_frame[1L, value], 101L)
)

unsupported_frames <- list(
  matrix_frame = local({
    value <- data.frame(id = 1:2)
    value$unsupported <- I(matrix(1:4, nrow = 2L))
    value
  }),
  array_frame = local({
    value <- data.frame(id = 1:2)
    value$unsupported <- I(array(1:8, dim = c(2L, 2L, 2L)))
    value
  }),
  list_frame = I(data.frame(unsupported = I(list(1L, 2L)))),
  raw_frame = data.frame(unsupported = as.raw(c(1L, 2L))),
  zero_raw_frame = data.frame(unsupported = raw(0L), check.names = FALSE)
)
for (name in names(unsupported_frames)) {
  target_env[[name]] <- unsupported_frames[[name]]
  session_id <- paste0("r-unsupported-", name)
  rejected <- request(paste0(name, "-open"), list(
    kind = "openSession",
    source = list(kind = "notebookVariable", label = name, variableName = name),
    requestedSessionId = session_id,
    pageSize = 2L,
    columnOffset = 0L,
    columnLimit = 2L
  ))
  stopifnot(
    identical(rejected$response$kind, "error"),
    grepl("not implemented yet", rejected$response$message, fixed = TRUE)
  )
  rejected_close <- request(
    paste0(name, "-close"),
    list(kind = "closeSession", sessionId = session_id, revision = 0L)
  )
  stopifnot(identical(rejected_close$response$kind, "error"))
}

provider$close()
cat("Native R provider smoke passed.\n")
