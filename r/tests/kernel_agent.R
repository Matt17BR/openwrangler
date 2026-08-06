source("r/openwrangler_runtime/frame_contract.R", local = FALSE)
source("r/openwrangler_runtime/kernel_agent.R", local = FALSE)

assert_identical <- function(actual, expected, message) {
  if (!identical(actual, expected)) {
    stop(sprintf("%s\nExpected: %s\nActual: %s", message, deparse(expected), deparse(actual)), call. = FALSE)
  }
}

request_id <- "11111111-1111-4111-8111-111111111111"
session_id <- "22222222-2222-4222-8222-222222222222"
second_session_id <- "33333333-3333-4333-8333-333333333333"
third_session_id <- "44444444-4444-4444-8444-444444444444"

source_environment <- new.env(parent = emptyenv())
source_environment$frame <- data.frame(
  group = c("b", "a", "a"),
  score = c(1, NA, 2),
  stringsAsFactors = FALSE
)
source_object <- source_environment$frame
source_before <- unserialize(serialize(source_environment$frame, NULL, version = 3L))

agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, source_environment)

page_window <- function(
  sorts = list(),
  filters = list(),
  logic = NULL,
  row_offset = 0L,
  row_limit = 100L,
  column_offset = 0L,
  column_limit = 100L
) {
  view <- list(filters = I(filters), sorts = I(sorts))
  if (!is.null(logic)) view$logic <- logic
  list(
    rowOffset = row_offset,
    rowLimit = row_limit,
    columnOffset = column_offset,
    columnLimit = column_limit,
    view = view
  )
}

empty_view <- function() list(filters = I(list()), sorts = I(list()))

dispatch_with <- function(target_agent, kind, payload, id = request_id) {
  encoded <- jsonlite::toJSON(
    list(transportVersion = 2L, requestId = id, kind = kind, payload = payload),
    auto_unbox = TRUE,
    null = "null",
    na = "null"
  )
  jsonlite::fromJSON(target_agent$dispatch_json(as.character(encoded)), simplifyVector = FALSE)
}

dispatch <- function(kind, payload, id = request_id) {
  dispatch_with(agent, kind, payload, id)
}

opened <- dispatch(
  "openSession",
  list(sessionId = session_id, variableName = "frame", page = page_window(row_limit = 2L))
)
assert_identical(opened$kind, "page", "the R agent did not open a page session")
assert_identical(opened$sessionId, session_id, "the R agent changed the candidate session identity")
assert_identical(opened$page$page$columnIds, list("r:c:0", "r:c:1"), "the initial projection changed")
assert_identical(
  vapply(opened$page$page$rows, `[[`, integer(1L), "rowNumber"),
  c(0L, 1L),
  "the initial page row order changed"
)
assert_identical(
  vapply(opened$page$schema, `[[`, logical(1L), "nullable"),
  c(TRUE, TRUE),
  "live R metadata did not conservatively report nullable columns"
)

sorted <- dispatch(
  "getPage",
  list(
    sessionId = session_id,
    page = page_window(list(list(
      column = list(id = "r:c:0", name = "group"),
      direction = "asc",
      nulls = "last"
    )))
  )
)
assert_identical(
  vapply(sorted$page$page$rows, `[[`, integer(1L), "rowNumber"),
  0:2,
  "the R agent did not number the sorted logical view"
)
assert_identical(
  vapply(sorted$page$page$rows, `[[`, character(1L), "id"),
  c("r:r:1", "r:r:2", "r:r:0"),
  "the R agent changed sorted source-row identities"
)

score_filter <- list(
  column = list(id = "r:c:1", name = "score"),
  type = "float",
  predicates = I(list(list(kind = "predicate", operator = "gt", value = 1)))
)
filtered_view <- list(filters = I(list(score_filter)), sorts = I(list()))
filtered <- dispatch(
  "getPage",
  list(sessionId = session_id, page = page_window(filters = list(score_filter)))
)
assert_identical(filtered$page$page$totalRows, 1L, "the R agent did not report the filtered row count")
assert_identical(filtered$page$page$rows[[1L]]$id, "r:r:2", "filtering changed the stable source row identity")
assert_identical(filtered$page$page$rows[[1L]]$rowNumber, 0L, "filtering did not reset logical row numbering")

filtered_summary <- dispatch(
  "getSummary",
  list(
    sessionId = session_id,
    columns = I(list(list(id = "r:c:1", name = "score"))),
    view = filtered_view
  )
)
assert_identical(filtered_summary$summaries[[1L]]$totalCount, 1L, "R profiles ignored the active filter")
assert_identical(filtered_summary$summaries[[1L]]$numeric$min, 2L, "the filtered R profile minimum changed")

values_response <- dispatch(
  "getColumnValues",
  list(
    sessionId = session_id,
    column = list(id = "r:c:0", name = "group"),
    view = empty_view(),
    search = "A",
    limit = 10L
  )
)
assert_identical(values_response$kind, "columnValues", "the R agent did not return column values")
assert_identical(values_response$values[[1L]]$value, "a", "column-value search did not use ASCII folding")
assert_identical(values_response$values[[1L]]$count, 2L, "column-value counts changed")
assert_identical(
  values_response$values[[1L]]$selectionValue$columnType,
  "string",
  "R column values omitted their typed selection"
)

summary_response <- dispatch(
  "getSummary",
  list(
    sessionId = session_id,
    columns = I(list(
      list(id = "r:c:1", name = "score"),
      list(id = "r:c:0", name = "group")
    )),
    view = empty_view()
  )
)
assert_identical(summary_response$kind, "summary", "the R agent did not return column profiles")
assert_identical(summary_response$requestId, request_id, "the R agent changed profile correlation")
assert_identical(
  vapply(summary_response$summaries, `[[`, character(1L), "columnId"),
  c("r:c:1", "r:c:0"),
  "the R agent changed the requested profile order"
)
assert_identical(summary_response$summaries[[1L]]$nullCount, 1L, "the R agent changed numeric null counts")
assert_identical(summary_response$summaries[[1L]]$numeric$min, 1L, "the R agent changed numeric minima")
assert_identical(summary_response$summaries[[1L]]$numeric$max, 2L, "the R agent changed numeric maxima")
assert_identical(summary_response$summaries[[2L]]$topValues[[1L]]$value, "a", "the R agent changed top values")

stats_response <- dispatch("getDatasetStats", list(sessionId = session_id, view = empty_view()))
assert_identical(stats_response$kind, "datasetStats", "the R agent did not return dataset statistics")
assert_identical(stats_response$requestId, request_id, "the R agent changed dataset-profile correlation")
assert_identical(stats_response$totalRows, 3L, "the R agent omitted the dataset-profile row count")
assert_identical(stats_response$stats$missingCells, 1L, "the R agent changed missing-cell counts")
assert_identical(stats_response$stats$missingRows, 1L, "the R agent changed missing-row counts")
assert_identical(stats_response$stats$duplicateRows, 0L, "the R agent changed duplicate-row counts")

stale_profile <- dispatch(
  "getSummary",
  list(
    sessionId = session_id,
    columns = I(list(list(id = "r:c:1", name = "old_score"))),
    view = empty_view()
  )
)
assert_identical(stale_profile$kind, "error", "a stale R profile column was accepted")
assert_identical(stale_profile$code, "stale_column", "the stale profile diagnostic changed")

repeated_profile <- dispatch(
  "getSummary",
  list(
    sessionId = session_id,
    columns = I(list(list(id = "r:c:0", name = "group"), list(id = "r:c:0", name = "group"))),
    view = empty_view()
  )
)
assert_identical(repeated_profile$kind, "error", "a repeated R profile column was accepted")
assert_identical(repeated_profile$code, "invalid_request", "the repeated-profile diagnostic changed")

oversized_profile <- dispatch(
  "getSummary",
  list(
    sessionId = session_id,
    columns = I(list(
      list(id = "r:c:0", name = "group"),
      list(id = "r:c:1", name = "score"),
      list(id = "r:c:2", name = "missing")
    )),
    view = empty_view()
  )
)
assert_identical(oversized_profile$kind, "error", "an oversized R profile was accepted")
assert_identical(oversized_profile$code, "profile_too_large", "the oversized-profile diagnostic changed")

# Unsorted reads use the current same-schema value. A sorted read compares the
# active sort columns with its cached copy and rebuilds the order when they change.
source_environment$frame <- data.frame(
  group = c("updated-a", "updated-b", "updated-c"),
  score = c(101, 102, 103),
  stringsAsFactors = FALSE
)
live_page <- dispatch(
  "getPage",
  list(sessionId = session_id, page = page_window(row_limit = 1L, column_offset = 1L, column_limit = 1L))
)
assert_identical(
  live_page$page$page$rows[[1L]]$values[[1L]]$raw,
  "101",
  "an unsorted R page did not read the current same-schema value"
)
live_summary <- dispatch(
  "getSummary",
  list(
    sessionId = session_id,
    columns = I(list(list(id = "r:c:1", name = "score"))),
    view = empty_view()
  )
)
assert_identical(live_summary$summaries[[1L]]$numeric$min, 101L, "a live R profile kept stale values")
assert_identical(live_summary$summaries[[1L]]$numeric$max, 103L, "a live R profile missed current values")
refreshed_sorted <- dispatch(
  "getPage",
  list(
    sessionId = session_id,
    page = page_window(list(list(
      column = list(id = "r:c:0", name = "group"),
      direction = "asc",
      nulls = "last"
    )))
  )
)
assert_identical(
  vapply(refreshed_sorted$page$page$rows, `[[`, integer(1L), "rowNumber"),
  0:2,
  "the refreshed sort did not retain logical row numbers"
)
assert_identical(
  vapply(refreshed_sorted$page$page$rows, `[[`, character(1L), "id"),
  c("r:r:0", "r:r:1", "r:r:2"),
  "same-schema value changes did not rebuild the active sort model"
)
assert_identical(source_object, source_before, "R session paging mutated the original notebook object")

source_environment$frame <- data.frame(group = "replacement", score = 999)
source_changed <- dispatch(
  "getPage",
  list(sessionId = session_id, page = page_window())
)
assert_identical(source_changed$kind, "error", "a structurally changed R source was read")
assert_identical(source_changed$code, "runtime_error", "the source-change diagnostic changed")
assert_identical(source_changed$recoverable, TRUE, "a source change was not recoverable")
if (!grepl("changed shape or schema", source_changed$message, fixed = TRUE)) {
  stop("the source-change diagnostic did not tell the user to reopen the dataframe", call. = FALSE)
}
source_environment$frame <- data.frame(
  group = c("updated-a", "updated-b", "updated-c"),
  score = c(101, 102, 103),
  stringsAsFactors = FALSE
)

duplicate <- dispatch(
  "openSession",
  list(sessionId = session_id, variableName = "frame", page = page_window())
)
assert_identical(duplicate$kind, "error", "a duplicate candidate session was accepted")
assert_identical(duplicate$code, "duplicate_session", "the duplicate-session diagnostic changed")

missing <- dispatch(
  "openSession",
  list(sessionId = second_session_id, variableName = "missing", page = page_window())
)
assert_identical(missing$kind, "error", "an unknown variable was accepted")
assert_identical(missing$code, "unknown_variable", "the unknown-variable diagnostic changed")

source_environment$unsupported <- data.frame(value = I(list(1L)))
unsupported <- dispatch(
  "openSession",
  list(sessionId = second_session_id, variableName = "unsupported", page = page_window())
)
assert_identical(unsupported$kind, "error", "an unsupported dataframe was accepted")
assert_identical(unsupported$code, "unsupported_frame", "the unsupported-frame diagnostic was not normalized")
assert_identical(unsupported$recoverable, FALSE, "an unsupported frame was marked recoverable")

source_environment$named_rows <- data.frame(value = 1L, row.names = "named-row")
named_rows <- dispatch(
  "openSession",
  list(sessionId = second_session_id, variableName = "named_rows", page = page_window())
)
assert_identical(named_rows$kind, "page", "a dataframe with explicit row names could not be opened")
assert_identical(named_rows$page$contractVersion, 3L, "the R kernel agent emitted the wrong frame contract")
assert_identical(named_rows$page$frameSemantics$rowNames, "explicit", "explicit R row names were hidden")
assert_identical(named_rows$page$page$rows[[1L]]$rowLabel, "named-row", "the explicit R row label changed")
named_rows_closed <- dispatch("closeSession", list(sessionId = second_session_id))
assert_identical(named_rows_closed$kind, "closed", "the named-row session did not close")

source_environment$wide <- as.data.frame(
  setNames(replicate(256L, seq_len(401L), simplify = FALSE), sprintf("column_%03d", seq_len(256L))),
  optional = TRUE
)
oversized <- dispatch(
  "openSession",
  list(
    sessionId = third_session_id,
    variableName = "wide",
    page = page_window(row_limit = 401L, column_limit = 256L)
  )
)
assert_identical(oversized$kind, "error", "an oversized page was accepted")
assert_identical(oversized$code, "page_too_large", "the oversized-page diagnostic was not normalized")
assert_identical(oversized$recoverable, TRUE, "an oversized page was not marked recoverable")

missing_package_contract <- list(
  capture_live_frame = function(source_reader) {
    stop(structure(
      list(message = "example package is required", call = NULL, code = "missing-package"),
      class = c("openwrangler_r_frame_error", "error", "condition")
    ))
  },
  materialize_view_page = function(...) stop("unexpected page materialization", call. = FALSE),
  materialize_summaries = function(...) stop("unexpected summary materialization", call. = FALSE),
  materialize_dataset_stats = function(...) stop("unexpected dataset profile", call. = FALSE),
  materialize_column_values = function(...) stop("unexpected column values", call. = FALSE),
  limits = openwrangler_r_frame_contract$limits
)
missing_package_agent <- openwrangler_r_kernel_agent$new_agent(missing_package_contract, source_environment)
missing_package <- dispatch_with(
  missing_package_agent,
  "openSession",
  list(sessionId = third_session_id, variableName = "frame", page = page_window())
)
assert_identical(missing_package$kind, "error", "a missing package was flattened")
assert_identical(missing_package$code, "missing_package", "the missing-package diagnostic was not normalized")
assert_identical(missing_package$recoverable, TRUE, "a missing package was not marked recoverable")

closed <- dispatch("closeSession", list(sessionId = session_id))
assert_identical(closed$kind, "closed", "the R agent did not close its session")
assert_identical(closed$sessionId, session_id, "the close response changed session identity")

closed_again <- dispatch("closeSession", list(sessionId = session_id))
assert_identical(closed_again$kind, "error", "a repeated close did not report an absent session")
assert_identical(closed_again$code, "unknown_session", "the repeated-close diagnostic changed")

reopened <- dispatch(
  "openSession",
  list(sessionId = second_session_id, variableName = "frame", page = page_window())
)
assert_identical(reopened$kind, "page", "the replacement frame could not be opened independently")
stale_column <- dispatch(
  "getPage",
  list(
    sessionId = second_session_id,
    page = page_window(list(list(
      column = list(id = "r:c:0", name = "old_group_name"),
      direction = "asc",
      nulls = "last"
    )))
  )
)
assert_identical(stale_column$kind, "error", "a stale column reference was accepted")
assert_identical(stale_column$code, "stale_column", "the stale-column diagnostic was not normalized")
assert_identical(stale_column$recoverable, TRUE, "a stale column was not marked recoverable")
malformed <- dispatch("getPage", list(sessionId = second_session_id, page = c(page_window(), list(extra = TRUE))))
assert_identical(malformed$kind, "error", "a malformed page request was accepted")
assert_identical(malformed$code, "invalid_request", "the malformed-request diagnostic changed")

rm("frame", envir = source_environment)
removed_source <- dispatch(
  "getPage",
  list(sessionId = second_session_id, page = page_window())
)
assert_identical(removed_source$kind, "error", "a removed R source was still read")
assert_identical(removed_source$code, "runtime_error", "the removed-source diagnostic changed")
assert_identical(removed_source$recoverable, TRUE, "a removed source was not recoverable")
removed_closed <- dispatch("closeSession", list(sessionId = second_session_id))
assert_identical(removed_closed$kind, "closed", "a source-changed session did not close")

cat("Native R kernel agent tests passed.\n")
