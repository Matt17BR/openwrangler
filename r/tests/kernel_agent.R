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
rename_session_id <- "55555555-5555-4555-8555-555555555555"
tibble_rename_session_id <- "66666666-6666-4666-8666-666666666666"
table_rename_session_id <- "77777777-7777-4777-8777-777777777777"
atomic_rename_session_id <- "88888888-8888-4888-8888-888888888888"

source_environment <- new.env(parent = emptyenv())
source_environment$frame <- data.frame(
  group = c("b", "a", "a"),
  score = c(1, NA, 2),
  stringsAsFactors = FALSE
)
source_object <- source_environment$frame
source_before <- unserialize(serialize(source_environment$frame, NULL, version = 3L))

isolated_capture_count <- 0L
full_capture_count <- 0L
instrumented_frame_contract <- openwrangler_r_frame_contract
real_capture_frame <- instrumented_frame_contract$capture_frame
real_isolate_capture <- instrumented_frame_contract$isolate_capture
instrumented_frame_contract$capture_frame <- function(value, ...) {
  full_capture_count <<- full_capture_count + 1L
  real_capture_frame(value, ...)
}
instrumented_frame_contract$isolate_capture <- function(capture) {
  isolated_capture_count <<- isolated_capture_count + 1L
  real_isolate_capture(capture)
}
agent <- openwrangler_r_kernel_agent$new_agent(instrumented_frame_contract, source_environment)

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
assert_identical(isolated_capture_count, 0L, "viewing open created an isolated full-frame snapshot")
assert_identical(full_capture_count, 0L, "viewing open copied the full R dataframe")
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

source_environment$rename_frame <- data.frame(
  duplicate = c(1L, 2L),
  duplicate = c(3L, 4L),
  label = c("a", "b"),
  check.names = FALSE,
  row.names = c("row-a", "row-b")
)
rename_source_before <- unserialize(serialize(source_environment$rename_frame, NULL, version = 3L))
rename_open <- dispatch(
  "openSession",
  list(
    sessionId = rename_session_id,
    variableName = "rename_frame",
    page = page_window(row_limit = 1L, column_offset = 1L, column_limit = 1L)
  )
)
assert_identical(rename_open$kind, "page", "the R rename session did not open")
rename_nullability <- vapply(rename_open$page$schema, `[[`, logical(1L), "nullable")
rename_step <- function(old_name, new_name, kind = "renameColumn") {
  list(
    id = "rename-step",
    kind = kind,
    params = list(column = list(id = "r:c:1", name = old_name), newName = new_name)
  )
}
rename_preview <- dispatch(
  "previewStep",
  list(
    sessionId = rename_session_id,
    revision = 0L,
    step = rename_step("duplicate", "second duplicate"),
    page = page_window(row_limit = 1L, column_offset = 1L, column_limit = 1L)
  )
)
assert_identical(rename_preview$kind, "stepPreview", "the R rename did not preview")
assert_identical(isolated_capture_count, 1L, "the first mutation did not create exactly one isolated snapshot")
assert_identical(full_capture_count, 1L, "the first rename did not capture exactly one draft result")
assert_identical(rename_preview$revision, 1L, "the R preview revision changed")
assert_identical(
  rename_preview$page$page$columnIds,
  list("r:c:1"),
  "the R preview did not preserve its projected column identity"
)
assert_identical(
  rename_preview$page$schema[[2L]]$name,
  "second duplicate",
  "the R preview did not publish the renamed schema"
)
assert_identical(
  vapply(rename_preview$page$schema, `[[`, logical(1L), "nullable"),
  rename_nullability,
  "the R preview narrowed the conservative live-session nullability contract"
)
assert_identical(rename_preview$diff$changedCells, 0L, "renaming reported changed cell values")
assert_identical(rename_preview$diff$cells, list(), "the bounded rename diff returned cell payloads")

stale_apply <- dispatch(
  "applyDraft",
  list(sessionId = rename_session_id, revision = 0L, page = page_window())
)
assert_identical(stale_apply$kind, "error", "a stale R draft apply was accepted")
assert_identical(stale_apply$code, "stale_revision", "the stale R revision diagnostic changed")
rename_discard <- dispatch(
  "discardDraft",
  list(sessionId = rename_session_id, revision = 1L, page = page_window())
)
assert_identical(rename_discard$action, "discard", "the R draft did not discard")
assert_identical(rename_discard$revision, 2L, "discard did not advance the R session revision")
assert_identical(rename_discard$page$schema[[2L]]$name, "duplicate", "discard kept the draft schema")
assert_identical(
  vapply(rename_discard$page$schema, `[[`, logical(1L), "nullable"),
  rename_nullability,
  "discard changed the live-session nullability contract"
)
assert_identical(rename_discard$code, "", "discarding the first R draft emitted a cleaning program")

rename_preview <- dispatch(
  "previewStep",
  list(
    sessionId = rename_session_id,
    revision = 2L,
    step = rename_step("duplicate", "second duplicate"),
    page = page_window(column_offset = 1L, column_limit = 1L)
  )
)
rename_apply <- dispatch(
  "applyDraft",
  list(sessionId = rename_session_id, revision = 3L, page = page_window(column_offset = 1L, column_limit = 1L))
)
assert_identical(rename_apply$action, "apply", "the R rename draft did not apply")
assert_identical(rename_apply$revision, 4L, "apply did not advance the R session revision")
assert_identical(rename_apply$page$schema[[2L]]$name, "second duplicate", "apply lost the renamed schema")
assert_identical(
  vapply(rename_apply$page$schema, `[[`, logical(1L), "nullable"),
  rename_nullability,
  "apply changed the live-session nullability contract"
)
if (!grepl("data.table::copy", rename_apply$code, fixed = TRUE)) {
  stop("generated R cleaning code did not isolate data.table input", call. = FALSE)
}

rename_inspection <- dispatch(
  "inspectStep",
  list(
    sessionId = rename_session_id,
    revision = 4L,
    stepId = "rename-step",
    page = page_window(row_limit = 1L, column_offset = 1L, column_limit = 1L)
  )
)
assert_identical(rename_inspection$kind, "stepInspection", "the applied R rename could not be inspected")
assert_identical(rename_inspection$revision, 4L, "inspection changed the R session revision")
assert_identical(rename_inspection$stepIndex, 0L, "inspection reported the wrong applied-step index")
assert_identical(
  vapply(rename_inspection$inputSchema, `[[`, logical(1L), "nullable"),
  rename_nullability,
  "inspection changed the input nullability contract"
)
assert_identical(
  vapply(rename_inspection$outputSchema, `[[`, logical(1L), "nullable"),
  rename_nullability,
  "inspection changed the output nullability contract"
)
assert_identical(rename_inspection$inputSchema[[2L]]$name, "duplicate", "inspection lost the input schema")
assert_identical(
  rename_inspection$outputSchema[[2L]]$name,
  "second duplicate",
  "inspection lost the output schema"
)
assert_identical(
  rename_inspection$inputPage$page$columnIds,
  list("r:c:1"),
  "inspection ignored the input projection"
)
assert_identical(rename_inspection$diff$changedCells, 0L, "inspection reported renamed cells as changed")
if (!grepl("second duplicate", rename_inspection$code, fixed = TRUE)) {
  stop("inspection did not return code for the selected R plan prefix", call. = FALSE)
}

assign("rename_frame", source_environment$rename_frame, envir = .GlobalEnv)
eval(parse(text = rename_apply$code), envir = .GlobalEnv)
generated_result <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(names(generated_result)[[2L]], "second duplicate", "generated R code did not execute the rename")
assert_identical(
  get("rename_frame", envir = .GlobalEnv, inherits = FALSE),
  rename_source_before,
  "generated R code mutated its source dataframe"
)
rm("rename_frame", "open_wrangler_result", envir = .GlobalEnv)

edited_preview <- dispatch(
  "previewStep",
  list(
    sessionId = rename_session_id,
    revision = 4L,
    step = rename_step("duplicate", "updated duplicate"),
    replaceStepId = "rename-step",
    page = page_window()
  )
)
assert_identical(edited_preview$revision, 5L, "editing the latest R step did not advance the revision")
assert_identical(
  vapply(edited_preview$page$schema, `[[`, logical(1L), "nullable"),
  rename_nullability,
  "editing the latest R step changed the nullability contract"
)
edited_apply <- dispatch(
  "applyDraft",
  list(sessionId = rename_session_id, revision = 5L, page = page_window())
)
assert_identical(edited_apply$page$schema[[2L]]$name, "updated duplicate", "the edited R step did not apply")
rename_undo <- dispatch(
  "undoStep",
  list(sessionId = rename_session_id, revision = 6L, page = page_window())
)
assert_identical(rename_undo$action, "undo", "the latest R step did not undo")
assert_identical(rename_undo$revision, 7L, "undo did not advance the R session revision")
assert_identical(rename_undo$page$schema[[2L]]$name, "duplicate", "undo did not replay the immutable original")
assert_identical(
  vapply(rename_undo$page$schema, `[[`, logical(1L), "nullable"),
  rename_nullability,
  "undo changed the live-session nullability contract"
)
assert_identical(rename_undo$code, "", "undoing the final R step emitted a cleaning program")

unsupported_step <- dispatch(
  "previewStep",
  list(
    sessionId = rename_session_id,
    revision = 7L,
    step = rename_step("duplicate", "ignored", kind = "formula"),
    page = page_window()
  )
)
assert_identical(unsupported_step$kind, "error", "an unsupported native R operation was accepted")
assert_identical(unsupported_step$code, "unsupported_operation", "the unsupported-operation diagnostic changed")
assert_identical(source_environment$rename_frame, rename_source_before, "the R editing lifecycle mutated its source")

cleanup_preview <- dispatch(
  "previewStep",
  list(
    sessionId = rename_session_id,
    revision = 7L,
    step = rename_step("duplicate", "cleanup draft"),
    page = page_window()
  )
)
assert_identical(cleanup_preview$revision, 8L, "the cleanup draft did not preview")
rename_closed <- dispatch("closeSession", list(sessionId = rename_session_id))
assert_identical(rename_closed$kind, "closed", "a session with an R draft did not close")
closed_rename_page <- dispatch("getPage", list(sessionId = rename_session_id, page = page_window()))
assert_identical(closed_rename_page$code, "unknown_session", "R draft cleanup retained a closed session")

oversized_mutation_response <- FALSE
atomic_contract <- openwrangler_r_frame_contract
real_atomic_materialize <- atomic_contract$materialize_view_page
atomic_contract$materialize_view_page <- function(...) {
  result <- real_atomic_materialize(...)
  if (isTRUE(oversized_mutation_response)) result$oversized <- strrep("x", 18L * 1024L * 1024L)
  result
}
atomic_agent <- openwrangler_r_kernel_agent$new_agent(atomic_contract, source_environment)
atomic_open <- dispatch_with(
  atomic_agent,
  "openSession",
  list(sessionId = atomic_rename_session_id, variableName = "rename_frame", page = page_window())
)
assert_identical(atomic_open$kind, "page", "the atomic-response R session did not open")
oversized_mutation_response <- TRUE
atomic_failed <- dispatch_with(
  atomic_agent,
  "previewStep",
  list(
    sessionId = atomic_rename_session_id,
    revision = 0L,
    step = rename_step("duplicate", "atomic duplicate"),
    page = page_window()
  )
)
assert_identical(atomic_failed$kind, "error", "an oversized R mutation response was published")
assert_identical(atomic_failed$code, "runtime_error", "the oversized R response diagnostic changed")
oversized_mutation_response <- FALSE
atomic_retry <- dispatch_with(
  atomic_agent,
  "previewStep",
  list(
    sessionId = atomic_rename_session_id,
    revision = 0L,
    step = rename_step("duplicate", "atomic duplicate"),
    page = page_window()
  )
)
assert_identical(atomic_retry$kind, "stepPreview", "an encoding failure committed hidden R mutation state")
invisible(dispatch_with(atomic_agent, "closeSession", list(sessionId = atomic_rename_session_id)))

assert_native_rename_isolated <- function(variable_name, isolated_session_id, source_before, old_name, new_name) {
  opened <- dispatch(
    "openSession",
    list(sessionId = isolated_session_id, variableName = variable_name, page = page_window())
  )
  assert_identical(opened$kind, "page", sprintf("%s did not open for native rename", variable_name))
  previewed <- dispatch(
    "previewStep",
    list(
      sessionId = isolated_session_id,
      revision = 0L,
      step = list(
        id = paste0(variable_name, "-rename"),
        kind = "renameColumn",
        params = list(column = list(id = "r:c:0", name = old_name), newName = new_name)
      ),
      page = page_window()
    )
  )
  assert_identical(previewed$kind, "stepPreview", sprintf("%s rename did not preview", variable_name))
  applied <- dispatch(
    "applyDraft",
    list(sessionId = isolated_session_id, revision = 1L, page = page_window())
  )
  assert_identical(applied$page$schema[[1L]]$name, new_name, sprintf("%s rename did not apply", variable_name))
  assert_identical(
    get(variable_name, envir = source_environment, inherits = FALSE),
    source_before,
    sprintf("the %s notebook source was mutated", variable_name)
  )
  assign(variable_name, get(variable_name, envir = source_environment, inherits = FALSE), envir = .GlobalEnv)
  eval(parse(text = applied$code), envir = .GlobalEnv)
  assert_identical(
    names(get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE))[[1L]],
    new_name,
    sprintf("generated %s code did not execute", variable_name)
  )
  assert_identical(
    get(variable_name, envir = .GlobalEnv, inherits = FALSE),
    source_before,
    sprintf("generated %s code mutated its source", variable_name)
  )
  rm(list = c(variable_name, "open_wrangler_result"), envir = .GlobalEnv)
  closed <- dispatch("closeSession", list(sessionId = isolated_session_id))
  assert_identical(closed$kind, "closed", sprintf("the %s rename session did not close", variable_name))
  applied
}

source_environment$rename_tibble <- tibble::tibble(`tibble key` = 1:2, value = c("a", "b"))
rename_tibble_before <- unserialize(serialize(source_environment$rename_tibble, NULL, version = 3L))
tibble_applied <- assert_native_rename_isolated(
  "rename_tibble",
  tibble_rename_session_id,
  rename_tibble_before,
  "tibble key",
  "tibble id"
)
assert_identical(
  tibble_applied$page$frameSemantics$classes,
  list("tbl_df", "tbl", "data.frame"),
  "the native tibble rename changed its class"
)

source_environment$rename_table <- data.table::data.table(`table key` = c(2L, 1L), value = c("b", "a"))
data.table::setkeyv(source_environment$rename_table, "table key")
rename_table_before <- data.table::copy(source_environment$rename_table)
table_applied <- assert_native_rename_isolated(
  "rename_table",
  table_rename_session_id,
  rename_table_before,
  "table key",
  "table id"
)
assert_identical(
  table_applied$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "the native keyed data.table rename changed its key identity"
)
assert_identical(
  data.table::key(source_environment$rename_table),
  "table key",
  "the native data.table rename changed the source key"
)

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
  capture_frame = function(...) stop("unexpected isolated capture", call. = FALSE),
  capture_live_frame = function(source_reader) {
    stop(structure(
      list(message = "example package is required", call = NULL, code = "missing-package"),
      class = c("openwrangler_r_frame_error", "error", "condition")
    ))
  },
  isolate_capture = function(...) stop("unexpected isolated capture", call. = FALSE),
  rename_column = function(...) stop("unexpected rename", call. = FALSE),
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
