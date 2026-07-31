arguments <- commandArgs(trailingOnly = FALSE)
file_argument <- arguments[startsWith(arguments, "--file=")]
if (length(file_argument) != 1L) {
  stop("Run this smoke test with Rscript.", call. = FALSE)
}
test_file <- normalizePath(sub("^--file=", "", file_argument), mustWork = TRUE)
repository_root <- normalizePath(file.path(dirname(test_file), "..", ".."), mustWork = TRUE)
source(file.path(repository_root, "r", "openwrangler_runtime", "kernel_agent.R"), local = TRUE)

if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("The R runtime smoke test requires jsonlite.", call. = FALSE)
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
target_env$wide_frame <- as.data.frame(
  matrix(1L, nrow = 1000L, ncol = 101L),
  check.names = FALSE
)
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

closed <- request("close", list(kind = "closeSession", sessionId = "r-session-smoke", revision = 0L))
stopifnot(identical(closed$response$kind, "sessionClosed"))
stopifnot(identical(original_bytes, serialize(target_env$base_frame, NULL, version = 3L)))

if (requireNamespace("tibble", quietly = TRUE)) {
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
}

if (requireNamespace("data.table", quietly = TRUE)) {
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
}

provider$close()
cat("Native R provider smoke passed.\n")
