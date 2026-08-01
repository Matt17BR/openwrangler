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
target_env$tibble_frame <- tibble::tibble(value = 1:2)
target_env$data_table_frame <- data.table::data.table(value = 1:2)
target_env$ordinary_value <- 42L
target_env$.hidden_frame <- data.frame(value = 1L)
target_env$custom_frame <- structure(
  data.frame(value = 1L, check.names = FALSE),
  class = c("custom_frame", "data.frame")
)
oversized_discovery_name <- strrep("n", 129L)
assign(oversized_discovery_name, data.frame(value = 1L), envir = target_env)
active_binding_calls <- 0L
makeActiveBinding(
  "active_frame",
  function(value) {
    active_binding_calls <<- active_binding_calls + 1L
    data.frame(value = 1L)
  },
  target_env
)
unforced_promise_calls <- 0L
delayedAssign(
  "unforced_promise_frame",
  {
    unforced_promise_calls <<- unforced_promise_calls + 1L
    data.frame(value = 1L)
  },
  assign.env = target_env
)
forced_promise_calls <- 0L
delayedAssign(
  "forced_promise_frame",
  {
    forced_promise_calls <<- forced_promise_calls + 1L
    data.frame(value = 1L)
  },
  assign.env = target_env
)
invisible(get("forced_promise_frame", envir = target_env, inherits = FALSE))
stopifnot(identical(unforced_promise_calls, 0L), identical(forced_promise_calls, 1L))
original_bytes <- serialize(target_env$base_frame, NULL, version = 3L)
provider <- create_open_wrangler_r_provider(target_env)

request_with <- function(provider_instance, request_id, body) {
  payload <- jsonlite::toJSON(
    list(protocolVersion = 2L, requestId = request_id, request = body),
    auto_unbox = TRUE,
    null = "null",
    na = "null"
  )
  jsonlite::fromJSON(provider_instance$dispatch_json(payload), simplifyVector = FALSE)
}

request <- function(request_id, body) {
  request_with(provider, request_id, body)
}

initialized <- request("initialize", list(kind = "initialize"))
stopifnot(
  identical(initialized$protocolVersion, 2L),
  identical(initialized$requestId, "initialize"),
  identical(initialized$response$kind, "initialized"),
  identical(initialized$response$language, "r"),
  identical(initialized$response$capabilities$variableDiscovery, TRUE),
  identical(initialized$response$capabilities$editing, FALSE)
)

discovered <- request("discover", list(kind = "discoverVariables"))
discovered_names <- vapply(
  discovered$response$variables,
  function(variable) variable$name,
  character(1)
)
discovered_by_name <- setNames(discovered$response$variables, discovered_names)
source_for <- function(name, descriptors = discovered_by_name) {
  descriptor <- descriptors[[name]]
  if (is.null(descriptor)) {
    stop(paste0("No discovery descriptor for ", name, "."), call. = FALSE)
  }
  list(
    kind = "notebookVariable",
    label = name,
    variableName = name,
    discoveryId = descriptor$discoveryId
  )
}
open_body <- function(source, session_id, page_size = 1L, column_limit = 1L) {
  list(
    kind = "openSession",
    source = source,
    requestedSessionId = session_id,
    backend = "r",
    mode = "viewing",
    pageSize = page_size,
    columnOffset = 0L,
    columnLimit = column_limit
  )
}
stopifnot(
  identical(discovered$response$kind, "variablesDiscovered"),
  identical(discovered$response$truncated, TRUE),
  length(discovered_names) == length(unique(discovered_names)),
  length(unique(vapply(
    discovered$response$variables,
    function(variable) variable$discoveryId,
    character(1)
  ))) == length(discovered_names),
  identical(discovered_by_name$base_frame$sourceClass, "data.frame"),
  identical(discovered_by_name$base_frame$shape, list(rows = 3L, columns = 5L)),
  identical(discovered_by_name$tibble_frame$sourceClass, "tbl_df"),
  identical(discovered_by_name$tibble_frame$shape, list(rows = 2L, columns = 1L)),
  identical(discovered_by_name$data_table_frame$sourceClass, "data.table"),
  identical(discovered_by_name$data_table_frame$shape, list(rows = 2L, columns = 1L)),
  identical(discovered_by_name$.hidden_frame$sourceClass, "data.frame"),
  !"ordinary_value" %in% discovered_names,
  !"custom_frame" %in% discovered_names,
  !"oversized_shape_frame" %in% discovered_names,
  !oversized_discovery_name %in% discovered_names,
  !"active_frame" %in% discovered_names,
  !"unforced_promise_frame" %in% discovered_names,
  !"forced_promise_frame" %in% discovered_names,
  identical(active_binding_calls, 0L),
  identical(unforced_promise_calls, 0L),
  identical(forced_promise_calls, 1L)
)

discovery_unknown_field <- request(
  "discover-extra",
  list(kind = "discoverVariables", extra = TRUE)
)
stopifnot(
  identical(discovery_unknown_field$response$kind, "error"),
  identical(discovery_unknown_field$response$code, "invalid_request")
)

limited_env <- new.env(parent = emptyenv())
for (index in seq_len(257L)) {
  assign(sprintf("frame_%03d", index), data.frame(value = index), envir = limited_env)
}
limited_provider <- create_open_wrangler_r_provider(limited_env)
limited_discovery <- request_with(
  limited_provider,
  "discover-limit",
  list(kind = "discoverVariables")
)
stopifnot(
  identical(limited_discovery$response$kind, "variablesDiscovered"),
  identical(limited_discovery$response$truncated, TRUE),
  length(limited_discovery$response$variables) == 256L,
  length(unique(vapply(
    limited_discovery$response$variables,
    function(variable) variable$name,
    character(1)
  ))) == 256L
)
limited_provider$close()

scan_limited_env <- new.env(parent = emptyenv())
for (index in seq_len(4097L)) {
  assign(sprintf("binding_%04d", index), index, envir = scan_limited_env)
}
scan_limited_env$zzzz_frame_after_scan_limit <- data.frame(value = 1L)
scan_limited_provider <- create_open_wrangler_r_provider(scan_limited_env)
scan_limited_discovery <- request_with(
  scan_limited_provider,
  "discover-scan-limit",
  list(kind = "discoverVariables")
)
stopifnot(
  identical(scan_limited_discovery$response$kind, "variablesDiscovered"),
  identical(scan_limited_discovery$response$truncated, TRUE),
  length(scan_limited_discovery$response$variables) == 0L
)
scan_limited_provider$close()

promise_env <- new.env(parent = emptyenv())
promise_unforced_calls <- 0L
delayedAssign(
  "promise_unforced_frame",
  {
    promise_unforced_calls <<- promise_unforced_calls + 1L
    data.frame(value = 1L)
  },
  assign.env = promise_env
)
promise_forced_calls <- 0L
delayedAssign(
  "promise_forced_frame",
  {
    promise_forced_calls <<- promise_forced_calls + 1L
    data.frame(value = 1L)
  },
  assign.env = promise_env
)
invisible(get("promise_forced_frame", envir = promise_env, inherits = FALSE))
promise_provider <- create_open_wrangler_r_provider(promise_env)
promise_discovery <- request_with(
  promise_provider,
  "discover-promises",
  list(kind = "discoverVariables")
)
stopifnot(
  identical(promise_discovery$response$kind, "variablesDiscovered"),
  identical(promise_discovery$response$truncated, TRUE),
  length(promise_discovery$response$variables) == 0L,
  identical(promise_unforced_calls, 0L),
  identical(promise_forced_calls, 1L)
)
promise_provider$close()

safety_env <- new.env(parent = emptyenv())
safety_provider <- create_open_wrangler_r_provider(safety_env)
discover_safety_variable <- function(request_id) {
  response <- request_with(
    safety_provider,
    request_id,
    list(kind = "discoverVariables")
  )
  stopifnot(
    identical(response$response$kind, "variablesDiscovered"),
    length(response$response$variables) == 1L
  )
  response$response$variables[[1L]]
}
expect_changed_source <- function(request_id, descriptor, session_id) {
  response <- request_with(
    safety_provider,
    request_id,
    open_body(
      source_for("candidate", setNames(list(descriptor), "candidate")),
      session_id
    )
  )
  stopifnot(
    identical(response$response$kind, "error"),
    identical(response$response$code, "source_changed"),
    identical(response$response$recoverable, TRUE)
  )
}

safety_env$candidate <- data.frame(value = 1L, check.names = FALSE)
active_descriptor <- discover_safety_variable("discover-active-replacement")
rm("candidate", envir = safety_env)
open_active_calls <- 0L
makeActiveBinding(
  "candidate",
  function(value) {
    open_active_calls <<- open_active_calls + 1L
    data.frame(value = 1L, check.names = FALSE)
  },
  safety_env
)
expect_changed_source("open-active-replacement", active_descriptor, "r-active-replacement")
stopifnot(identical(open_active_calls, 0L))
rm("candidate", envir = safety_env)

safety_env$candidate <- data.frame(value = 1L, check.names = FALSE)
promise_descriptor <- discover_safety_variable("discover-promise-replacement")
rm("candidate", envir = safety_env)
open_promise_calls <- 0L
delayedAssign(
  "candidate",
  {
    open_promise_calls <<- open_promise_calls + 1L
    data.frame(value = 1L, check.names = FALSE)
  },
  assign.env = safety_env
)
expect_changed_source("open-promise-replacement", promise_descriptor, "r-promise-replacement")
stopifnot(identical(open_promise_calls, 0L))
rm("candidate", envir = safety_env)

safety_env$candidate <- data.frame(value = 1L, check.names = FALSE)
custom_descriptor <- discover_safety_variable("discover-custom-replacement")
safety_env$candidate <- structure(
  data.frame(value = 1L, check.names = FALSE),
  class = c("custom_frame", "data.frame")
)
expect_changed_source("open-custom-replacement", custom_descriptor, "r-custom-replacement")

safety_env$candidate <- data.frame(value = 1L, check.names = FALSE)
replacement_descriptor <- discover_safety_variable("discover-value-replacement")
safety_env$candidate <- data.frame(value = 2L, check.names = FALSE)
expect_changed_source("open-value-replacement", replacement_descriptor, "r-value-replacement")

safety_env$candidate <- data.frame(value = 4L, check.names = FALSE)
equal_value_descriptor <- discover_safety_variable("discover-equal-value-replacement")
safety_env$candidate <- data.frame(value = 4L, check.names = FALSE)
equal_value_open <- request_with(
  safety_provider,
  "open-equal-value-replacement",
  open_body(
    source_for("candidate", setNames(list(equal_value_descriptor), "candidate")),
    "r-equal-value-replacement"
  )
)
stopifnot(identical(equal_value_open$response$kind, "sessionOpened"))

safety_env$candidate <- data.frame(value = 3L, check.names = FALSE)
stale_descriptor <- discover_safety_variable("discover-stale-first")
current_descriptor <- discover_safety_variable("discover-stale-second")
expect_changed_source("open-stale-discovery", stale_descriptor, "r-stale-discovery")
current_open <- request_with(
  safety_provider,
  "open-current-discovery",
  open_body(
    source_for("candidate", setNames(list(current_descriptor), "candidate")),
    "r-current-discovery"
  )
)
stopifnot(identical(current_open$response$kind, "sessionOpened"))
safety_provider$close()
closed_discovery <- request_with(
  safety_provider,
  "open-after-provider-close",
  open_body(
    source_for("candidate", setNames(list(current_descriptor), "candidate")),
    "r-after-provider-close"
  )
)
stopifnot(
  identical(closed_discovery$response$kind, "error"),
  identical(closed_discovery$response$code, "source_changed")
)

opened <- request("open", list(
  kind = "openSession",
  source = source_for("base_frame"),
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
    '{"protocolVersion":2,"requestId":"duplicate","request":{"kind":"initialize","kind":"initialize"}}'
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
      '{"protocolVersion":2,"requestId":"object-filter","request":{',
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
  '{"protocolVersion":2,"requestId":"bounded-request","request":{"kind":"initialize"}}'
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
  source = source_for("exact_cell_frame"),
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
  source = source_for("wide_frame"),
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
  source = source_for("exact_text_frame"),
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
  source = source_for("exact_name_frame"),
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
  source = source_for("zero_frame"),
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
  source = source_for("empty_name_frame"),
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
    source = source_for(case$variable),
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
    variable = "oversized_schema_frame",
    session = "r-oversized-schema-smoke",
    message = "schema exceeds"
  )
)) {
  rejected <- request(paste0(case$variable, "-open"), list(
    kind = "openSession",
    source = source_for(case$variable),
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
  source = source_for("oversized_page_bytes_frame"),
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

tibble_open <- request("tibble-open", list(
  kind = "openSession",
  source = source_for("tibble_frame"),
  requestedSessionId = "r-tibble-smoke",
  pageSize = 2L,
  columnOffset = 0L,
  columnLimit = 1L
))
stopifnot(
  identical(tibble_open$response$metadata$sourceClass, "tbl_df"),
  inherits(target_env$tibble_frame, "tbl_df")
)

data_table_open <- request("data-table-open", list(
  kind = "openSession",
  source = source_for("data_table_frame"),
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
  list_frame = data.frame(unsupported = I(list(1L, 2L)), check.names = FALSE),
  raw_frame = data.frame(unsupported = as.raw(c(1L, 2L))),
  zero_raw_frame = data.frame(unsupported = raw(0L), check.names = FALSE)
)
for (name in names(unsupported_frames)) {
  target_env[[name]] <- unsupported_frames[[name]]
}
unsupported_discovery <- request("discover-unsupported", list(kind = "discoverVariables"))
unsupported_names <- vapply(
  unsupported_discovery$response$variables,
  function(variable) variable$name,
  character(1)
)
unsupported_by_name <- setNames(unsupported_discovery$response$variables, unsupported_names)
for (name in names(unsupported_frames)) {
  session_id <- paste0("r-unsupported-", name)
  rejected <- request(paste0(name, "-open"), list(
    kind = "openSession",
    source = source_for(name, unsupported_by_name),
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
