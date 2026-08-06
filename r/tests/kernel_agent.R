source("r/openwrangler_runtime/frame_contract.R", local = FALSE)
source("r/openwrangler_runtime/kernel_agent.R", local = FALSE)

assert_identical <- function(actual, expected, message) {
  if (!identical(actual, expected)) {
    stop(sprintf("%s\nExpected: %s\nActual: %s", message, deparse(expected), deparse(actual)), call. = FALSE)
  }
}

assert_schema_less_inspection <- function(inspection, label) {
  assert_identical(inspection$inputPage$schema, NULL, sprintf("%s duplicated its input schema", label))
  assert_identical(inspection$outputPage$schema, NULL, sprintf("%s duplicated its output schema", label))
}

request_id <- "11111111-1111-4111-8111-111111111111"
session_id <- "22222222-2222-4222-8222-222222222222"
second_session_id <- "33333333-3333-4333-8333-333333333333"
third_session_id <- "44444444-4444-4444-8444-444444444444"
rename_session_id <- "55555555-5555-4555-8555-555555555555"
tibble_rename_session_id <- "66666666-6666-4666-8666-666666666666"
table_rename_session_id <- "77777777-7777-4777-8777-777777777777"
atomic_rename_session_id <- "88888888-8888-4888-8888-888888888888"
drop_session_id <- "99999999-9999-4999-8999-999999999999"
select_session_id <- "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
select_table_session_id <- "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
clone_session_id <- "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
clone_table_session_id <- "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
text_length_session_id <- "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
text_length_table_session_id <- "ffffffff-ffff-4fff-8fff-ffffffffffff"
invalid_text_length_session_id <- "12121212-1212-4212-8212-121212121212"
lower_session_id <- "13131313-1313-4313-8313-131313131313"
lower_table_session_id <- "14141414-1414-4414-8414-141414141414"
cast_session_id <- "15151515-1515-4515-8515-151515151515"
cast_table_session_id <- "16161616-1616-4616-8616-161616161616"
cast_off_page_session_id <- "17171717-1717-4717-8717-171717171717"
large_factor_session_id <- "18181818-1818-4818-8818-181818181818"
large_cells_session_id <- "19191919-1919-4919-8919-191919191919"
row_session_id <- "20202020-2020-4020-8020-202020202020"
row_tibble_session_id <- "21212121-2121-4121-8121-212121212121"
row_table_session_id <- "23232323-2323-4323-8323-232323232323"
row_active_view_session_id <- "24242424-2424-4424-8424-242424242424"
row_empty_named_session_id <- "25252525-2525-4525-8525-252525252525"

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

inspect_step <- function(session_id, revision, step_id, page) {
  info <- dispatch(
    "inspectStepInfo",
    list(sessionId = session_id, revision = revision, stepId = step_id)
  )
  input <- dispatch(
    "inspectStepPage",
    list(sessionId = session_id, revision = revision, stepId = step_id, side = "input", page = page)
  )
  output <- dispatch(
    "inspectStepPage",
    list(sessionId = session_id, revision = revision, stepId = step_id, side = "output", page = page)
  )
  assert_identical(info$kind, "stepInspectionInfo", "R inspection metadata did not return")
  assert_identical(input$kind, "stepInspectionPage", "R inspection input page did not return")
  assert_identical(output$kind, "stepInspectionPage", "R inspection output page did not return")
  assert_identical(input$side, "input", "R inspection returned the wrong input side")
  assert_identical(output$side, "output", "R inspection returned the wrong output side")
  assert_identical(input$stepIndex, info$stepIndex, "R inspection input step index changed")
  assert_identical(output$stepIndex, info$stepIndex, "R inspection output step index changed")

  input_ids <- unlist(input$page$page$columnIds, use.names = FALSE)
  output_ids <- unlist(output$page$page$columnIds, use.names = FALSE)
  shared_ids <- intersect(input_ids, output_ids)
  changed_cells <- 0L
  if (length(shared_ids) > 0L) {
    input_rows <- input$page$page$rows
    input_row_ids <- vapply(input_rows, `[[`, character(1L), "id", USE.NAMES = FALSE)
    for (output_row in output$page$page$rows) {
      input_index <- match(output_row$id, input_row_ids)
      if (is.na(input_index)) next
      for (column_id in shared_ids) {
        input_position <- match(column_id, input_ids)
        output_position <- match(column_id, output_ids)
        if (!identical(
          input_rows[[input_index]]$values[[input_position]],
          output_row$values[[output_position]]
        )) {
          changed_cells <- changed_cells + 1L
        }
      }
    }
  }
  list(
    kind = "stepInspection",
    revision = info$revision,
    stepId = info$stepId,
    stepIndex = info$stepIndex,
    inputPage = input$page,
    outputPage = output$page,
    diff = list(
      addedRows = max(0L, output$page$page$totalRows - input$page$page$totalRows),
      removedRows = max(0L, input$page$page$totalRows - output$page$page$totalRows),
      changedCells = changed_cells,
      truncated = input$page$page$totalRows > length(input$page$page$rows) ||
        output$page$page$totalRows > length(output$page$page$rows)
    ),
    code = info$code
  )
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
assert_identical(named_rows$page$contractVersion, 5L, "the R kernel agent emitted the wrong frame contract")
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

rename_inspection <- inspect_step(
  rename_session_id,
  4L,
  "rename-step",
  page_window(row_limit = 1L, column_offset = 1L, column_limit = 1L)
)
assert_identical(rename_inspection$kind, "stepInspection", "the applied R rename could not be inspected")
assert_identical(rename_inspection$revision, 4L, "inspection changed the R session revision")
assert_identical(rename_inspection$stepIndex, 0L, "inspection reported the wrong applied-step index")
assert_schema_less_inspection(rename_inspection, "R rename inspection")
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

source_environment$drop_frame <- data.frame(
  duplicate = c(1L, 2L),
  duplicate = c(3L, 4L),
  `non syntactic` = as.Date(c("2026-03-01", "2026-03-02")),
  check.names = FALSE,
  row.names = c("row-a", "row-b")
)
drop_source_before <- unserialize(serialize(source_environment$drop_frame, NULL, version = 3L))
drop_step <- function(id = "drop-step", column_id = "r:c:1", column_name = "duplicate") {
  list(
    id = id,
    kind = "dropColumns",
    params = list(columns = I(list(list(id = column_id, name = column_name))))
  )
}
drop_open <- dispatch(
  "openSession",
  list(sessionId = drop_session_id, variableName = "drop_frame", page = page_window())
)
assert_identical(drop_open$kind, "page", "the R drop session did not open")
drop_nullability <- vapply(drop_open$page$schema, `[[`, logical(1L), "nullable")
drop_preview <- dispatch(
  "previewStep",
  list(
    sessionId = drop_session_id,
    revision = 0L,
    step = drop_step(),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(drop_preview$kind, "stepPreview", "the R drop did not preview")
assert_identical(drop_preview$page$shape$columns, 2L, "the R drop preview kept the old width")
assert_identical(
  vapply(drop_preview$page$schema, `[[`, character(1L), "id"),
  c("r:c:0", "r:c:2"),
  "the R drop preview renumbered retained identities"
)
assert_identical(
  vapply(drop_preview$page$schema, `[[`, integer(1L), "position"),
  0:1,
  "the R drop preview did not reindex output positions"
)
assert_identical(
  vapply(drop_preview$page$schema, `[[`, logical(1L), "nullable"),
  drop_nullability[c(1L, 3L)],
  "the R drop preview changed retained nullability"
)
assert_identical(drop_preview$page$page$columnOffset, 2L, "the R drop did not resolve an obsolete viewport")
assert_identical(drop_preview$page$page$columnIds, list(), "an obsolete viewport returned unrelated R columns")
assert_identical(drop_preview$diff$removedColumns, list("duplicate"), "the R drop diff lost the removed column")
assert_identical(drop_preview$diff$addedColumns, list(), "the R drop diff reported added columns")
assert_identical(drop_preview$diff$changedCells, 0L, "the R drop diff reported changed cells")
drop_discard <- dispatch(
  "discardDraft",
  list(sessionId = drop_session_id, revision = 1L, page = page_window())
)
assert_identical(drop_discard$action, "discard", "the R drop draft did not discard")
assert_identical(drop_discard$page$shape$columns, 3L, "discarding the R drop kept its narrow schema")

drop_preview <- dispatch(
  "previewStep",
  list(sessionId = drop_session_id, revision = 2L, step = drop_step(), page = page_window())
)
drop_apply <- dispatch(
  "applyDraft",
  list(sessionId = drop_session_id, revision = 3L, page = page_window())
)
assert_identical(drop_apply$action, "apply", "the R drop draft did not apply")
assert_identical(
  vapply(drop_apply$page$schema, `[[`, character(1L), "id"),
  c("r:c:0", "r:c:2"),
  "applying the R drop changed retained identities"
)
drop_inspection <- inspect_step(
  drop_session_id,
  4L,
  "drop-step",
  page_window()
)
assert_identical(drop_inspection$kind, "stepInspection", "the applied R drop could not be inspected")
assert_schema_less_inspection(drop_inspection, "R drop inspection")
assert_identical(drop_inspection$outputPage$shape$columns, 2L, "R drop inspection returned the wrong output width")

assign("drop_frame", source_environment$drop_frame, envir = .GlobalEnv)
eval(parse(text = drop_apply$code), envir = .GlobalEnv)
drop_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(names(drop_generated), c("duplicate", "non syntactic"), "generated R code dropped the wrong column")
assert_identical(
  get("drop_frame", envir = .GlobalEnv, inherits = FALSE),
  drop_source_before,
  "generated R drop code mutated its source dataframe"
)
rm("drop_frame", "open_wrangler_result", envir = .GlobalEnv)

drop_edit_preview <- dispatch(
  "previewStep",
  list(
    sessionId = drop_session_id,
    revision = 4L,
    step = drop_step(column_id = "r:c:2", column_name = "non syntactic"),
    replaceStepId = "drop-step",
    page = page_window()
  )
)
assert_identical(
  vapply(drop_edit_preview$page$schema, `[[`, character(1L), "id"),
  c("r:c:0", "r:c:1"),
  "editing the R drop did not replay its original input"
)
drop_edit_apply <- dispatch(
  "applyDraft",
  list(sessionId = drop_session_id, revision = 5L, page = page_window())
)
assert_identical(drop_edit_apply$page$shape$columns, 2L, "the edited R drop did not apply")
drop_undo <- dispatch(
  "undoStep",
  list(sessionId = drop_session_id, revision = 6L, page = page_window())
)
assert_identical(drop_undo$action, "undo", "the R drop did not undo")
assert_identical(drop_undo$page$shape$columns, 3L, "undoing the R drop did not restore the original schema")
assert_identical(source_environment$drop_frame, drop_source_before, "the R drop lifecycle mutated its source")

named_drop_columns <- dispatch(
  "previewStep",
  list(
    sessionId = drop_session_id,
    revision = 7L,
    step = list(
      id = "named-drop-columns",
      kind = "dropColumns",
      params = list(columns = list(named = list(id = "r:c:0", name = "duplicate")))
    ),
    page = page_window()
  )
)
assert_identical(named_drop_columns$kind, "error", "an object-shaped R drop column list was accepted")
assert_identical(named_drop_columns$code, "invalid_request", "the object-shaped R drop diagnostic changed")
drop_retry <- dispatch(
  "previewStep",
  list(sessionId = drop_session_id, revision = 7L, step = drop_step("drop-retry"), page = page_window())
)
assert_identical(drop_retry$kind, "stepPreview", "a malformed R drop request changed the session revision")
drop_retry_discard <- dispatch(
  "discardDraft",
  list(sessionId = drop_session_id, revision = 8L, page = page_window())
)
assert_identical(drop_retry_discard$action, "discard", "the R drop retry could not be discarded")
drop_closed <- dispatch("closeSession", list(sessionId = drop_session_id))
assert_identical(drop_closed$kind, "closed", "the R drop session did not close")

source_environment$select_frame <- data.frame(
  duplicate = c(1L, 2L),
  duplicate = c(3L, 4L),
  `non syntactic` = as.Date(c("2026-04-01", "2026-04-02")),
  remove = c("a", "b"),
  check.names = FALSE,
  row.names = c("row-a", "row-b")
)
select_source_before <- unserialize(serialize(source_environment$select_frame, NULL, version = 3L))
select_step <- function(
  id = "select-step",
  columns = list(
    list(id = "r:c:2", name = "non syntactic"),
    list(id = "r:c:0", name = "duplicate")
  )
) {
  list(id = id, kind = "selectColumns", params = list(columns = I(columns)))
}
select_open <- dispatch(
  "openSession",
  list(sessionId = select_session_id, variableName = "select_frame", page = page_window())
)
assert_identical(select_open$kind, "page", "the R Select Columns session did not open")
select_nullability <- vapply(select_open$page$schema, `[[`, logical(1L), "nullable")
select_preview <- dispatch(
  "previewStep",
  list(
    sessionId = select_session_id,
    revision = 0L,
    step = select_step(),
    page = page_window(column_offset = 2L, column_limit = 1L)
  )
)
assert_identical(select_preview$kind, "stepPreview", "the R Select Columns step did not preview")
assert_identical(
  vapply(select_preview$page$schema, `[[`, character(1L), "id"),
  c("r:c:2", "r:c:0"),
  "the R selection did not retain user order and stable identities"
)
assert_identical(
  vapply(select_preview$page$schema, `[[`, integer(1L), "position"),
  0:1,
  "the R selection did not reindex public positions"
)
assert_identical(
  vapply(select_preview$page$schema, `[[`, logical(1L), "nullable"),
  select_nullability[c(3L, 1L)],
  "the R selection changed retained nullability"
)
assert_identical(select_preview$page$page$columnOffset, 2L, "the R selection did not resolve an obsolete viewport")
assert_identical(select_preview$page$page$columnIds, list(), "an obsolete selection viewport returned columns")
assert_identical(
  select_preview$diff$removedColumns,
  list("duplicate", "remove"),
  "the R selection diff did not report omitted columns in input order"
)
assert_identical(select_preview$diff$addedColumns, list(), "the R selection diff reported added columns")
assert_identical(select_preview$diff$changedCells, 0L, "the R selection diff reported changed cells")
select_discard <- dispatch(
  "discardDraft",
  list(sessionId = select_session_id, revision = 1L, page = page_window())
)
assert_identical(select_discard$action, "discard", "the R selection draft did not discard")
assert_identical(select_discard$page$shape$columns, 4L, "discarding the R selection kept its projection")

select_preview <- dispatch(
  "previewStep",
  list(sessionId = select_session_id, revision = 2L, step = select_step(), page = page_window())
)
select_apply <- dispatch(
  "applyDraft",
  list(sessionId = select_session_id, revision = 3L, page = page_window())
)
assert_identical(select_apply$action, "apply", "the R selection draft did not apply")
assert_identical(
  vapply(select_apply$page$schema, `[[`, character(1L), "id"),
  c("r:c:2", "r:c:0"),
  "applying the R selection changed stable identities"
)
select_inspection <- inspect_step(
  select_session_id,
  4L,
  "select-step",
  page_window()
)
assert_identical(select_inspection$kind, "stepInspection", "the applied R selection could not be inspected")
assert_schema_less_inspection(select_inspection, "R selection inspection")
assert_identical(select_inspection$outputPage$shape$columns, 2L, "R selection inspection returned the wrong width")

select_rename_step <- list(
  id = "select-rename-step",
  kind = "renameColumn",
  params = list(column = list(id = "r:c:0", name = "duplicate"), newName = "retained duplicate")
)
select_rename_preview <- dispatch(
  "previewStep",
  list(
    sessionId = select_session_id,
    revision = 4L,
    step = select_rename_step,
    page = page_window()
  )
)
assert_identical(select_rename_preview$kind, "stepPreview", "a rename could not follow the R selection")
select_rename_apply <- dispatch(
  "applyDraft",
  list(sessionId = select_session_id, revision = 5L, page = page_window())
)
assert_identical(
  vapply(select_rename_apply$page$schema, `[[`, character(1L), "name"),
  c("non syntactic", "retained duplicate"),
  "the mixed R selection/rename plan replayed the wrong schema"
)
select_after_mixed_inspection <- inspect_step(
  select_session_id,
  6L,
  "select-step",
  page_window()
)
assert_identical(
  select_after_mixed_inspection$outputPage$page$columnIds,
  list("r:c:2", "r:c:0"),
  "mixed replay changed the R selection inspection"
)
assign("select_frame", source_environment$select_frame, envir = .GlobalEnv)
eval(parse(text = select_rename_apply$code), envir = .GlobalEnv)
select_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  names(select_generated),
  c("non syntactic", "retained duplicate"),
  "generated R selection/rename code returned the wrong columns"
)
assert_identical(
  get("select_frame", envir = .GlobalEnv, inherits = FALSE),
  select_source_before,
  "generated R selection code mutated its source dataframe"
)
rm("select_frame", "open_wrangler_result", envir = .GlobalEnv)

select_rename_undo <- dispatch(
  "undoStep",
  list(sessionId = select_session_id, revision = 6L, page = page_window())
)
assert_identical(select_rename_undo$action, "undo", "the mixed R rename did not undo")
select_edit_preview <- dispatch(
  "previewStep",
  list(
    sessionId = select_session_id,
    revision = 7L,
    step = select_step(
      columns = list(
        list(id = "r:c:1", name = "duplicate"),
        list(id = "r:c:3", name = "remove")
      )
    ),
    replaceStepId = "select-step",
    page = page_window()
  )
)
assert_identical(
  vapply(select_edit_preview$page$schema, `[[`, character(1L), "id"),
  c("r:c:1", "r:c:3"),
  "editing the R selection did not replay its original input"
)
select_edit_apply <- dispatch(
  "applyDraft",
  list(sessionId = select_session_id, revision = 8L, page = page_window())
)
assert_identical(select_edit_apply$page$shape$columns, 2L, "the edited R selection did not apply")
select_undo <- dispatch(
  "undoStep",
  list(sessionId = select_session_id, revision = 9L, page = page_window())
)
assert_identical(select_undo$action, "undo", "the R selection did not undo")
assert_identical(select_undo$page$shape$columns, 4L, "undoing the R selection did not restore the source schema")

invalid_select_steps <- list(
  list(
    id = "named-select-columns",
    kind = "selectColumns",
    params = list(columns = list(named = list(id = "r:c:0", name = "duplicate")))
  ),
  select_step("empty-select-columns", list()),
  select_step(
    "repeated-select-columns",
    list(list(id = "r:c:0", name = "duplicate"), list(id = "r:c:0", name = "duplicate"))
  )
)
for (invalid_step in invalid_select_steps) {
  invalid_select <- dispatch(
    "previewStep",
    list(
      sessionId = select_session_id,
      revision = 10L,
      step = invalid_step,
      page = page_window()
    )
  )
  assert_identical(invalid_select$kind, "error", "a malformed R selection was accepted")
  assert_identical(invalid_select$code, "invalid_request", "the malformed R selection diagnostic changed")
}
for (stale_step in list(
  select_step("stale-select-columns", list(list(id = "r:c:99", name = "duplicate"))),
  select_step("misnamed-select-columns", list(list(id = "r:c:0", name = "wrong")))
)) {
  stale_select <- dispatch(
    "previewStep",
    list(
      sessionId = select_session_id,
      revision = 10L,
      step = stale_step,
      page = page_window()
    )
  )
  assert_identical(stale_select$kind, "error", "a stale R selection was accepted")
  assert_identical(stale_select$code, "stale_column", "the stale R selection diagnostic changed")
}
source_environment$private_select_frame <- data.frame(
  `__OPEN_WRANGLER_INTERNAL_ROW_ID_user` = 1L,
  public = 2L,
  check.names = FALSE
)
private_select_session_id <- "11111111-1111-4111-8111-111111111119"
private_select_open <- dispatch(
  "openSession",
  list(sessionId = private_select_session_id, variableName = "private_select_frame", page = page_window())
)
assert_identical(private_select_open$kind, "page", "the reserved-name R selection session did not open")
private_select <- dispatch(
  "previewStep",
  list(
    sessionId = private_select_session_id,
    revision = 0L,
    step = select_step(
      "private-select-columns",
      list(list(id = "r:c:0", name = "__OPEN_WRANGLER_INTERNAL_ROW_ID_user"))
    ),
    page = page_window()
  )
)
assert_identical(private_select$kind, "error", "a reserved private R column was selectable")
assert_identical(private_select$code, "invalid_request", "the reserved R selection diagnostic changed")
private_select_closed <- dispatch("closeSession", list(sessionId = private_select_session_id))
assert_identical(private_select_closed$kind, "closed", "the reserved-name R selection session did not close")
assert_identical(source_environment$select_frame, select_source_before, "the R selection lifecycle mutated its source")
select_closed <- dispatch("closeSession", list(sessionId = select_session_id))
assert_identical(select_closed$kind, "closed", "the R Select Columns session did not close")

source_environment$select_table <- data.table::data.table(
  k1 = c(1L, 1L),
  k2 = c(1L, 2L),
  value = c("a", "b"),
  other = 3:4
)
data.table::setkey(source_environment$select_table, k1, k2)
select_table_before <- data.table::copy(source_environment$select_table)
select_table_open <- dispatch(
  "openSession",
  list(sessionId = select_table_session_id, variableName = "select_table", page = page_window())
)
assert_identical(select_table_open$kind, "page", "the R data.table selection session did not open")
select_table_preview <- dispatch(
  "previewStep",
  list(
    sessionId = select_table_session_id,
    revision = 0L,
    step = select_step(
      "select-table-step",
      list(
        list(id = "r:c:3", name = "other"),
        list(id = "r:c:1", name = "k2"),
        list(id = "r:c:0", name = "k1")
      )
    ),
    page = page_window()
  )
)
assert_identical(
  select_table_preview$page$frameSemantics$keyColumnIds,
  list("r:c:0", "r:c:1"),
  "the R data.table selection changed its stable key prefix"
)
select_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = select_table_session_id, revision = 1L, page = page_window())
)
assign("select_table", source_environment$select_table, envir = .GlobalEnv)
eval(parse(text = select_table_apply$code), envir = .GlobalEnv)
select_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(class(select_table_generated), c("data.table", "data.frame"), "generated selection lost data.table class")
assert_identical(names(select_table_generated), c("other", "k2", "k1"), "generated data.table selection lost user order")
assert_identical(data.table::key(select_table_generated), c("k1", "k2"), "generated selection lost data.table key")
assert_identical(
  get("select_table", envir = .GlobalEnv, inherits = FALSE),
  select_table_before,
  "generated R data.table selection mutated its source"
)
rm("select_table", "open_wrangler_result", envir = .GlobalEnv)
select_table_closed <- dispatch("closeSession", list(sessionId = select_table_session_id))
assert_identical(select_table_closed$kind, "closed", "the R data.table selection session did not close")

source_environment$clone_frame <- data.frame(
  duplicate = c(1L, 2L),
  duplicate = c(3L, NA_integer_),
  `non syntactic` = as.Date(c("2026-05-01", "2026-05-02")),
  check.names = FALSE,
  row.names = c("row-a", "row-b")
)
clone_source_before <- unserialize(serialize(source_environment$clone_frame, NULL, version = 3L))
clone_step <- function(
  id = "clone-step",
  column_id = "r:c:1",
  column_name = "duplicate",
  new_name = "duplicate copy"
) {
  list(
    id = id,
    kind = "cloneColumn",
    params = list(column = list(id = column_id, name = column_name), newName = new_name)
  )
}
clone_open <- dispatch(
  "openSession",
  list(sessionId = clone_session_id, variableName = "clone_frame", page = page_window())
)
assert_identical(clone_open$kind, "page", "the R Clone Column session did not open")
clone_preview <- dispatch(
  "previewStep",
  list(
    sessionId = clone_session_id,
    revision = 0L,
    step = clone_step(),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(clone_preview$kind, "stepPreview", "the R Clone Column step did not preview")
assert_identical(clone_preview$revision, 1L, "the R clone preview revision changed")
assert_identical(clone_preview$page$page$columnIds, list("c:step:clone-step:0"), "the R clone lost its derived identity")
assert_identical(clone_preview$page$schema[[4L]]$position, 3L, "the R clone published the wrong position")
assert_identical(
  clone_preview$page$schema[[4L]]$nullable,
  clone_preview$page$schema[[2L]]$nullable,
  "the R clone changed source nullability"
)
assert_identical(clone_preview$diff$addedColumns, list("duplicate copy"), "the R clone diff lost its output")
assert_identical(clone_preview$diff$removedColumns, list(), "the R clone diff removed a column")
assert_identical(clone_preview$diff$addedRows, 0L, "the R clone diff added rows")
assert_identical(clone_preview$diff$removedRows, 0L, "the R clone diff removed rows")
assert_identical(clone_preview$diff$changedCells, 0L, "the R clone diff changed cell values")
assert_identical(clone_preview$diff$cells, list(), "the R clone diff returned cell payloads")
clone_discard <- dispatch(
  "discardDraft",
  list(sessionId = clone_session_id, revision = 1L, page = page_window())
)
assert_identical(clone_discard$action, "discard", "the R clone draft did not discard")
assert_identical(clone_discard$revision, 2L, "discarding the R clone did not advance the revision")
assert_identical(clone_discard$page$shape$columns, 3L, "discarding the R clone kept its output")

clone_preview <- dispatch(
  "previewStep",
  list(sessionId = clone_session_id, revision = 2L, step = clone_step(), page = page_window())
)
clone_apply <- dispatch(
  "applyDraft",
  list(sessionId = clone_session_id, revision = 3L, page = page_window())
)
assert_identical(clone_apply$action, "apply", "the R clone draft did not apply")
assert_identical(clone_apply$revision, 4L, "applying the R clone did not advance the revision")
assert_identical(
  vapply(clone_apply$page$schema, `[[`, character(1L), "id"),
  c("r:c:0", "r:c:1", "r:c:2", "c:step:clone-step:0"),
  "applying the R clone changed stable identities"
)
assert_identical(
  vapply(clone_apply$page$schema, `[[`, character(1L), "name"),
  c("duplicate", "duplicate", "non syntactic", "duplicate copy"),
  "applying the R clone repaired duplicate names"
)
clone_inspection <- inspect_step(
  clone_session_id,
  4L,
  "clone-step",
  page_window()
)
assert_identical(clone_inspection$kind, "stepInspection", "the applied R clone could not be inspected")
assert_schema_less_inspection(clone_inspection, "R clone inspection")
assert_identical(clone_inspection$outputPage$shape$columns, 4L, "R clone inspection returned the wrong width")

clone_rename_step <- list(
  id = "rename-clone-step",
  kind = "renameColumn",
  params = list(
    column = list(id = "c:step:clone-step:0", name = "duplicate copy"),
    newName = "renamed copy"
  )
)
clone_rename_preview <- dispatch(
  "previewStep",
  list(
    sessionId = clone_session_id,
    revision = 4L,
    step = clone_rename_step,
    page = page_window()
  )
)
assert_identical(clone_rename_preview$kind, "stepPreview", "a rename could not target the R clone output")
clone_rename_apply <- dispatch(
  "applyDraft",
  list(sessionId = clone_session_id, revision = 5L, page = page_window())
)
assert_identical(
  clone_rename_apply$page$schema[[4L]]$id,
  "c:step:clone-step:0",
  "mixed R clone replay changed the derived identity"
)
assert_identical(clone_rename_apply$page$schema[[4L]]$name, "renamed copy", "mixed R clone replay lost the rename")
clone_after_mixed_inspection <- inspect_step(
  clone_session_id,
  6L,
  "clone-step",
  page_window()
)
assert_identical(
  clone_after_mixed_inspection$outputPage$page$columnIds,
  list("r:c:0", "r:c:1", "r:c:2", "c:step:clone-step:0"),
  "mixed replay changed the R clone inspection"
)
if (!grepl(".ow_clone_position", clone_rename_apply$code, fixed = TRUE)) {
  stop("generated R Clone Column code lost its positional binding", call. = FALSE)
}
assign("clone_frame", source_environment$clone_frame, envir = .GlobalEnv)
eval(parse(text = clone_rename_apply$code), envir = .GlobalEnv)
clone_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  names(clone_generated),
  c("duplicate", "duplicate", "non syntactic", "renamed copy"),
  "generated R clone/rename code returned the wrong columns"
)
assert_identical(clone_generated[[4L]], clone_source_before[[2L]], "generated R clone copied the wrong duplicate")
assert_identical(row.names(clone_generated), row.names(clone_source_before), "generated R clone changed row names")
assert_identical(
  get("clone_frame", envir = .GlobalEnv, inherits = FALSE),
  clone_source_before,
  "generated R clone code mutated its source dataframe"
)
rm("clone_frame", "open_wrangler_result", envir = .GlobalEnv)

wide_clone_names <- c("duplicate", "duplicate", sprintf("wide_%04d", 3:2048))
wide_clone_source <- as.data.frame(
  setNames(replicate(2048L, 1L, simplify = FALSE), wide_clone_names),
  optional = TRUE
)
wide_clone_before <- unserialize(serialize(wide_clone_source, NULL, version = 3L))
assign("clone_frame", wide_clone_source, envir = .GlobalEnv)
wide_clone_error <- tryCatch(
  {
    eval(parse(text = clone_rename_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (is.null(wide_clone_error) || !grepl("column limit reached", conditionMessage(wide_clone_error), fixed = TRUE)) {
  stop("generated R Clone Column code did not enforce the frame width limit", call. = FALSE)
}
assert_identical(
  get("clone_frame", envir = .GlobalEnv, inherits = FALSE),
  wide_clone_before,
  "the generated R clone width guard mutated its source"
)
rm("clone_frame", envir = .GlobalEnv)

clone_rename_undo <- dispatch(
  "undoStep",
  list(sessionId = clone_session_id, revision = 6L, page = page_window())
)
assert_identical(clone_rename_undo$action, "undo", "the mixed R clone rename did not undo")
assert_identical(clone_rename_undo$page$schema[[4L]]$name, "duplicate copy", "undo lost the R clone")
clone_edit_preview <- dispatch(
  "previewStep",
  list(
    sessionId = clone_session_id,
    revision = 7L,
    step = clone_step(column_id = "r:c:2", column_name = "non syntactic", new_name = "date copy"),
    replaceStepId = "clone-step",
    page = page_window()
  )
)
assert_identical(clone_edit_preview$kind, "stepPreview", "the latest R clone could not be edited")
assert_identical(
  clone_edit_preview$page$schema[[4L]]$id,
  "c:step:clone-step:0",
  "editing the R clone regenerated its output identity"
)
assert_identical(clone_edit_preview$page$schema[[4L]]$name, "date copy", "editing the R clone kept the old output")
clone_edit_apply <- dispatch(
  "applyDraft",
  list(sessionId = clone_session_id, revision = 8L, page = page_window())
)
assert_identical(clone_edit_apply$action, "apply", "the edited R clone did not apply")
clone_undo <- dispatch(
  "undoStep",
  list(sessionId = clone_session_id, revision = 9L, page = page_window())
)
assert_identical(clone_undo$action, "undo", "the edited R clone did not undo")
assert_identical(clone_undo$revision, 10L, "undoing the R clone did not advance the revision")
assert_identical(clone_undo$page$shape$columns, 3L, "undoing the R clone did not restore the source schema")

invalid_clone_steps <- list(
  clone_step("clone-collision", new_name = "duplicate"),
  clone_step("clone-private", new_name = "__OPEN_WRANGLER_INTERNAL_ROW_ID_clone")
)
for (invalid_step in invalid_clone_steps) {
  invalid_clone <- dispatch(
    "previewStep",
    list(sessionId = clone_session_id, revision = 10L, step = invalid_step, page = page_window())
  )
  assert_identical(invalid_clone$kind, "error", "an invalid R clone was accepted")
  assert_identical(invalid_clone$code, "invalid_request", "the invalid R clone diagnostic changed")
}
for (stale_step in list(
  clone_step("clone-stale", column_id = "r:c:99"),
  clone_step("clone-misnamed", column_name = "wrong")
)) {
  stale_clone <- dispatch(
    "previewStep",
    list(sessionId = clone_session_id, revision = 10L, step = stale_step, page = page_window())
  )
  assert_identical(stale_clone$kind, "error", "a stale R clone was accepted")
  assert_identical(stale_clone$code, "stale_column", "the stale R clone diagnostic changed")
}
long_clone_step_id <- paste0("long-", strrep("x", 1019L))
long_clone_column_id <- paste0("c:step:", long_clone_step_id, ":0")
if (nchar(long_clone_column_id, type = "bytes") <= 1024L) {
  stop("the long derived R identity regression did not cross the legacy name bound", call. = FALSE)
}
long_clone_preview <- dispatch(
  "previewStep",
  list(
    sessionId = clone_session_id,
    revision = 10L,
    step = clone_step(long_clone_step_id, "r:c:0", "duplicate", "long copy"),
    page = page_window()
  )
)
assert_identical(long_clone_preview$kind, "stepPreview", "a bounded long R clone identity did not preview")
assert_identical(
  long_clone_preview$page$schema[[4L]]$id,
  long_clone_column_id,
  "the bounded long R clone identity changed"
)
long_clone_apply <- dispatch(
  "applyDraft",
  list(sessionId = clone_session_id, revision = 11L, page = page_window())
)
assert_identical(long_clone_apply$action, "apply", "the bounded long R clone did not apply")
long_clone_sorted <- dispatch(
  "getPage",
  list(
    sessionId = clone_session_id,
    page = page_window(list(list(
      column = list(id = long_clone_column_id, name = "long copy"),
      direction = "desc",
      nulls = "last"
    )))
  )
)
assert_identical(long_clone_sorted$kind, "page", "a long derived R identity could not be sorted")
long_clone_summary <- dispatch(
  "getSummary",
  list(
    sessionId = clone_session_id,
    columns = I(list(list(id = long_clone_column_id, name = "long copy"))),
    view = empty_view()
  )
)
assert_identical(long_clone_summary$kind, "summary", "a long derived R identity could not be profiled")
assert_identical(
  long_clone_summary$summaries[[1L]]$columnId,
  long_clone_column_id,
  "profiling changed the long derived R identity"
)
long_clone_values <- dispatch(
  "getColumnValues",
  list(
    sessionId = clone_session_id,
    column = list(id = long_clone_column_id, name = "long copy"),
    view = empty_view(),
    search = NULL,
    limit = 10L
  )
)
assert_identical(long_clone_values$kind, "columnValues", "a long derived R identity lost its values")
long_clone_rename <- dispatch(
  "previewStep",
  list(
    sessionId = clone_session_id,
    revision = 12L,
    step = list(
      id = "rename-long-derived",
      kind = "renameColumn",
      params = list(
        column = list(id = long_clone_column_id, name = "long copy"),
        newName = "renamed long copy"
      )
    ),
    page = page_window()
  )
)
assert_identical(long_clone_rename$kind, "stepPreview", "a long derived R identity could not be targeted")
assert_identical(
  long_clone_rename$page$schema[[4L]]$id,
  long_clone_column_id,
  "targeting a long derived R identity changed its lineage"
)
long_clone_rename_discard <- dispatch(
  "discardDraft",
  list(sessionId = clone_session_id, revision = 13L, page = page_window())
)
assert_identical(long_clone_rename_discard$action, "discard", "the long-derived R rename did not discard")
long_clone_undo <- dispatch(
  "undoStep",
  list(sessionId = clone_session_id, revision = 14L, page = page_window())
)
assert_identical(long_clone_undo$action, "undo", "the bounded long R clone did not undo")
assert_identical(long_clone_undo$revision, 15L, "undoing the bounded long R clone changed the revision")
assert_identical(long_clone_undo$page$shape$columns, 3L, "undoing the bounded long R clone kept its output")
assert_identical(source_environment$clone_frame, clone_source_before, "the R clone lifecycle mutated its source")
clone_closed <- dispatch("closeSession", list(sessionId = clone_session_id))
assert_identical(clone_closed$kind, "closed", "the R Clone Column session did not close")

source_environment$clone_table <- data.table::data.table(
  primary_key = c(2L, 1L),
  value = c("b", "a")
)
data.table::setkey(source_environment$clone_table, primary_key)
clone_table_before <- data.table::copy(source_environment$clone_table)
clone_table_open <- dispatch(
  "openSession",
  list(sessionId = clone_table_session_id, variableName = "clone_table", page = page_window())
)
assert_identical(clone_table_open$kind, "page", "the R data.table clone session did not open")
clone_table_preview <- dispatch(
  "previewStep",
  list(
    sessionId = clone_table_session_id,
    revision = 0L,
    step = clone_step("clone-table-step", "r:c:1", "value", "value copy"),
    page = page_window()
  )
)
assert_identical(
  clone_table_preview$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "the R data.table clone changed its key identity"
)
assert_identical(
  clone_table_preview$page$schema[[3L]]$id,
  "c:step:clone-table-step:0",
  "the R data.table clone lost its derived identity"
)
clone_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = clone_table_session_id, revision = 1L, page = page_window())
)
assign("clone_table", source_environment$clone_table, envir = .GlobalEnv)
eval(parse(text = clone_table_apply$code), envir = .GlobalEnv)
clone_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(class(clone_table_generated), c("data.table", "data.frame"), "generated clone lost data.table class")
assert_identical(data.table::key(clone_table_generated), "primary_key", "generated clone lost the data.table key")
assert_identical(clone_table_generated[[3L]], clone_table_before[[2L]], "generated data.table clone copied the wrong column")
assert_identical(
  get("clone_table", envir = .GlobalEnv, inherits = FALSE),
  clone_table_before,
  "generated R data.table clone mutated its source"
)
rm("clone_table", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(source_environment$clone_table, clone_table_before, "the R data.table clone mutated its source")
clone_table_closed <- dispatch("closeSession", list(sessionId = clone_table_session_id))
assert_identical(clone_table_closed$kind, "closed", "the R data.table clone session did not close")

source_environment$text_length_frame <- data.frame(
  duplicate = c("caf\u00e9", "\U0001F642", NA_character_),
  duplicate = factor(c("alpha", NA, "\u03b2eta"), levels = c("alpha", "\u03b2eta")),
  number = c(1L, 2L, 3L),
  check.names = FALSE,
  row.names = c("row-a", "row-b", "row-c")
)
text_length_source_before <- unserialize(serialize(source_environment$text_length_frame, NULL, version = 3L))
text_length_step <- function(
  id = "text-length-step",
  column_id = "r:c:0",
  column_name = "duplicate",
  new_column = "character count"
) {
  list(
    id = id,
    kind = "textLength",
    params = list(column = list(id = column_id, name = column_name), newColumn = new_column)
  )
}
text_length_open <- dispatch(
  "openSession",
  list(sessionId = text_length_session_id, variableName = "text_length_frame", page = page_window())
)
assert_identical(text_length_open$kind, "page", "the R Text Length session did not open")
text_length_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_length_session_id,
    revision = 0L,
    step = text_length_step(),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(text_length_preview$kind, "stepPreview", "the R Text Length step did not preview")
assert_identical(text_length_preview$revision, 1L, "the R Text Length preview revision changed")
assert_identical(
  text_length_preview$page$page$columnIds,
  list("c:step:text-length-step:0"),
  "the R Text Length preview lost its derived identity"
)
assert_identical(text_length_preview$page$schema[[4L]]$rawType, "integer", "R Text Length did not return integers")
assert_identical(text_length_preview$page$schema[[4L]]$type, "integer", "R Text Length published the wrong type")
assert_identical(
  text_length_preview$page$schema[[4L]]$nullable,
  text_length_preview$page$schema[[1L]]$nullable,
  "R Text Length changed source nullability"
)
assert_identical(
  vapply(text_length_preview$page$page$rows, function(row) row$values[[1L]]$kind, character(1L)),
  c("integer", "integer", "null"),
  "R Text Length lost Unicode or NA cell types"
)
assert_identical(
  vapply(text_length_preview$page$page$rows[1:2], function(row) row$values[[1L]]$raw, character(1L)),
  c("4", "1"),
  "R Text Length counted bytes instead of characters"
)
assert_identical(text_length_preview$diff$addedColumns, list("character count"), "R Text Length lost its diff")
assert_identical(text_length_preview$diff$removedColumns, list(), "R Text Length removed a column")
assert_identical(text_length_preview$diff$changedCells, 0L, "R Text Length reported changed source cells")
assert_identical(text_length_preview$diff$cells, list(), "R Text Length returned cell diffs")
text_length_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_length_session_id, revision = 1L, page = page_window())
)
assert_identical(text_length_discard$action, "discard", "the R Text Length draft did not discard")
assert_identical(text_length_discard$page$shape$columns, 3L, "discarding R Text Length kept its output")

text_length_preview <- dispatch(
  "previewStep",
  list(sessionId = text_length_session_id, revision = 2L, step = text_length_step(), page = page_window())
)
text_length_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_length_session_id, revision = 3L, page = page_window())
)
assert_identical(text_length_apply$action, "apply", "the R Text Length draft did not apply")
assert_identical(
  vapply(text_length_apply$page$schema, `[[`, character(1L), "id"),
  c("r:c:0", "r:c:1", "r:c:2", "c:step:text-length-step:0"),
  "applying R Text Length changed stable identities"
)
text_length_inspection <- inspect_step(
  text_length_session_id,
  4L,
  "text-length-step",
  page_window()
)
assert_identical(text_length_inspection$kind, "stepInspection", "the applied R Text Length step was not inspectable")
assert_schema_less_inspection(text_length_inspection, "R Text Length inspection")
assert_identical(
  text_length_inspection$outputPage$shape$columns,
  4L,
  "R Text Length inspection returned the wrong width"
)

text_length_rename <- list(
  id = "rename-text-length",
  kind = "renameColumn",
  params = list(
    column = list(id = "c:step:text-length-step:0", name = "character count"),
    newName = "renamed count"
  )
)
text_length_rename_preview <- dispatch(
  "previewStep",
  list(sessionId = text_length_session_id, revision = 4L, step = text_length_rename, page = page_window())
)
assert_identical(text_length_rename_preview$kind, "stepPreview", "Rename could not target R Text Length output")
text_length_rename_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_length_session_id, revision = 5L, page = page_window())
)
assert_identical(
  text_length_rename_apply$page$schema[[4L]]$id,
  "c:step:text-length-step:0",
  "renaming R Text Length output changed its lineage"
)
assert_identical(text_length_rename_apply$page$schema[[4L]]$name, "renamed count", "R Text Length rename was lost")
if (!grepl("nchar(as.character", text_length_rename_apply$code, fixed = TRUE)) {
  stop("generated R Text Length code lost its native character-count expression", call. = FALSE)
}
assign("text_length_frame", source_environment$text_length_frame, envir = .GlobalEnv)
eval(parse(text = text_length_rename_apply$code), envir = .GlobalEnv)
text_length_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  names(text_length_generated),
  c("duplicate", "duplicate", "number", "renamed count"),
  "generated R Text Length returned the wrong columns"
)
assert_identical(text_length_generated[[4L]], c(4L, 1L, NA_integer_), "generated R Text Length changed its result")
assert_identical(row.names(text_length_generated), row.names(text_length_source_before), "generated R Text Length changed row names")
assert_identical(
  get("text_length_frame", envir = .GlobalEnv, inherits = FALSE),
  text_length_source_before,
  "generated R Text Length mutated its source dataframe"
)
rm("text_length_frame", "open_wrangler_result", envir = .GlobalEnv)

assign(
  "text_length_frame",
  data.frame(duplicate = 1:3, duplicate = factor(c("a", "b", "c")), number = 1:3, check.names = FALSE),
  envir = .GlobalEnv
)
text_length_generated_type_error <- tryCatch(
  {
    eval(parse(text = text_length_rename_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (
  is.null(text_length_generated_type_error) ||
    !grepl("requires a character or factor column", conditionMessage(text_length_generated_type_error), fixed = TRUE)
) {
  stop("generated R Text Length did not reject an incompatible source type", call. = FALSE)
}
rm("text_length_frame", envir = .GlobalEnv)

invalid_generated_text <- rawToChar(as.raw(0xff))
Encoding(invalid_generated_text) <- "bytes"
invalid_generated_text_length_source <- data.frame(
  duplicate = c(invalid_generated_text, "safe", NA_character_),
  duplicate = factor(c("alpha", NA, "beta")),
  number = 1:3,
  check.names = FALSE
)
invalid_generated_text_length_before <- unserialize(
  serialize(invalid_generated_text_length_source, NULL, version = 3L)
)
assign("text_length_frame", invalid_generated_text_length_source, envir = .GlobalEnv)
invalid_generated_text_length_error <- tryCatch(
  {
    eval(parse(text = text_length_rename_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (is.null(invalid_generated_text_length_error)) {
  stop("generated R Text Length accepted a non-missing bytes-encoded string", call. = FALSE)
}
assert_identical(
  get("text_length_frame", envir = .GlobalEnv, inherits = FALSE),
  invalid_generated_text_length_before,
  "generated R Text Length mutated invalid source text"
)
rm("text_length_frame", envir = .GlobalEnv)

wide_text_length_names <- c("duplicate", "duplicate", "number", sprintf("wide_%04d", 4:2048))
wide_text_length_source <- as.data.frame(
  setNames(replicate(2048L, "x", simplify = FALSE), wide_text_length_names),
  optional = TRUE
)
wide_text_length_before <- unserialize(serialize(wide_text_length_source, NULL, version = 3L))
assign("text_length_frame", wide_text_length_source, envir = .GlobalEnv)
wide_text_length_error <- tryCatch(
  {
    eval(parse(text = text_length_rename_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (is.null(wide_text_length_error) || !grepl("column limit reached", conditionMessage(wide_text_length_error), fixed = TRUE)) {
  stop("generated R Text Length did not enforce the frame width limit", call. = FALSE)
}
assert_identical(
  get("text_length_frame", envir = .GlobalEnv, inherits = FALSE),
  wide_text_length_before,
  "the generated R Text Length width guard mutated its source"
)
rm("text_length_frame", envir = .GlobalEnv)

text_length_rename_undo <- dispatch(
  "undoStep",
  list(sessionId = text_length_session_id, revision = 6L, page = page_window())
)
assert_identical(text_length_rename_undo$action, "undo", "undo did not restore the R Text Length step")
assert_identical(text_length_rename_undo$page$schema[[4L]]$name, "character count", "undo lost R Text Length output")
text_length_edit_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_length_session_id,
    revision = 7L,
    step = text_length_step(
      column_id = "r:c:1",
      column_name = "duplicate",
      new_column = "factor count"
    ),
    replaceStepId = "text-length-step",
    page = page_window()
  )
)
assert_identical(text_length_edit_preview$kind, "stepPreview", "the latest R Text Length step could not be edited")
assert_identical(
  text_length_edit_preview$page$schema[[4L]]$id,
  "c:step:text-length-step:0",
  "editing R Text Length regenerated its output identity"
)
assert_identical(text_length_edit_preview$page$schema[[4L]]$name, "factor count", "editing R Text Length kept its old name")
assert_identical(
  c(
    text_length_edit_preview$page$page$rows[[1L]]$values[[4L]]$raw,
    text_length_edit_preview$page$page$rows[[3L]]$values[[4L]]$raw
  ),
  c("5", "4"),
  "edited R Text Length did not count factor labels"
)
assert_identical(
  text_length_edit_preview$page$page$rows[[2L]]$values[[4L]]$kind,
  "null",
  "edited R Text Length did not preserve factor NA"
)
text_length_edit_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_length_session_id, revision = 8L, page = page_window())
)
assert_identical(text_length_edit_apply$action, "apply", "the edited R Text Length step did not apply")
text_length_undo <- dispatch(
  "undoStep",
  list(sessionId = text_length_session_id, revision = 9L, page = page_window())
)
assert_identical(text_length_undo$action, "undo", "the edited R Text Length step did not undo")
assert_identical(text_length_undo$page$shape$columns, 3L, "undoing R Text Length did not restore the source schema")

for (invalid_step in list(
  text_length_step("text-length-numeric", "r:c:2", "number", "number count"),
  text_length_step("text-length-collision", new_column = "duplicate"),
  text_length_step("text-length-private", new_column = "__OPEN_WRANGLER_INTERNAL_ROW_ID_length")
)) {
  invalid_text_length <- dispatch(
    "previewStep",
    list(sessionId = text_length_session_id, revision = 10L, step = invalid_step, page = page_window())
  )
  assert_identical(invalid_text_length$kind, "error", "an invalid R Text Length step was accepted")
  assert_identical(invalid_text_length$code, "invalid_request", "the invalid R Text Length diagnostic changed")
}
for (stale_step in list(
  text_length_step("text-length-stale", "r:c:99"),
  text_length_step("text-length-misnamed", column_name = "wrong")
)) {
  stale_text_length <- dispatch(
    "previewStep",
    list(sessionId = text_length_session_id, revision = 10L, step = stale_step, page = page_window())
  )
  assert_identical(stale_text_length$kind, "error", "a stale R Text Length step was accepted")
  assert_identical(stale_text_length$code, "stale_column", "the stale R Text Length diagnostic changed")
}
long_text_length_step_id <- paste0("long-", strrep("x", 1019L))
long_text_length_column_id <- paste0("c:step:", long_text_length_step_id, ":0")
long_text_length_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_length_session_id,
    revision = 10L,
    step = text_length_step(long_text_length_step_id, new_column = "long count"),
    page = page_window()
  )
)
assert_identical(long_text_length_preview$kind, "stepPreview", "a bounded long R Text Length identity did not preview")
assert_identical(
  long_text_length_preview$page$schema[[4L]]$id,
  long_text_length_column_id,
  "the bounded long R Text Length identity changed"
)
long_text_length_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_length_session_id, revision = 11L, page = page_window())
)
assert_identical(long_text_length_discard$action, "discard", "the long R Text Length draft did not discard")
assert_identical(source_environment$text_length_frame, text_length_source_before, "the R Text Length lifecycle mutated its source")
text_length_closed <- dispatch("closeSession", list(sessionId = text_length_session_id))
assert_identical(text_length_closed$kind, "closed", "the R Text Length session did not close")

invalid_live_text <- rawToChar(as.raw(0xff))
Encoding(invalid_live_text) <- "bytes"
source_environment$invalid_text_length_frame <- data.frame(
  safe = 1L,
  text = invalid_live_text,
  check.names = FALSE
)
invalid_live_text_before <- unserialize(
  serialize(source_environment$invalid_text_length_frame, NULL, version = 3L)
)
invalid_text_length_open <- dispatch(
  "openSession",
  list(
    sessionId = invalid_text_length_session_id,
    variableName = "invalid_text_length_frame",
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(invalid_text_length_open$kind, "page", "the invalid-text R session did not open safely")
invalid_text_length_preview <- dispatch(
  "previewStep",
  list(
    sessionId = invalid_text_length_session_id,
    revision = 0L,
    step = text_length_step("invalid-bytes-text-length", "r:c:1", "text", "count"),
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(invalid_text_length_preview$kind, "error", "R Text Length accepted non-missing invalid text")
assert_identical(invalid_text_length_preview$code, "runtime_error", "invalid R text was not failed closed")
assert_identical(
  source_environment$invalid_text_length_frame,
  invalid_live_text_before,
  "failed R Text Length mutated invalid source text"
)
invalid_text_length_closed <- dispatch("closeSession", list(sessionId = invalid_text_length_session_id))
assert_identical(invalid_text_length_closed$kind, "closed", "the invalid-text R session did not close")

source_environment$text_length_table <- data.table::data.table(
  primary_key = c(2L, 1L),
  value = c("\U0001F642", NA_character_)
)
data.table::setkey(source_environment$text_length_table, primary_key)
text_length_table_before <- data.table::copy(source_environment$text_length_table)
text_length_table_open <- dispatch(
  "openSession",
  list(sessionId = text_length_table_session_id, variableName = "text_length_table", page = page_window())
)
assert_identical(text_length_table_open$kind, "page", "the R data.table Text Length session did not open")
text_length_table_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_length_table_session_id,
    revision = 0L,
    step = text_length_step("text-length-table", "r:c:1", "value", "value count"),
    page = page_window()
  )
)
assert_identical(
  text_length_table_preview$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "R data.table Text Length changed its key identity"
)
text_length_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_length_table_session_id, revision = 1L, page = page_window())
)
assign("text_length_table", source_environment$text_length_table, envir = .GlobalEnv)
eval(parse(text = text_length_table_apply$code), envir = .GlobalEnv)
text_length_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  class(text_length_table_generated),
  c("data.table", "data.frame"),
  "generated R Text Length lost the data.table class"
)
assert_identical(data.table::key(text_length_table_generated), "primary_key", "generated R Text Length lost the key")
assert_identical(text_length_table_generated[[3L]], c(NA_integer_, 1L), "generated R data.table Text Length changed values")
assert_identical(
  get("text_length_table", envir = .GlobalEnv, inherits = FALSE),
  text_length_table_before,
  "generated R data.table Text Length mutated its source"
)
rm("text_length_table", "open_wrangler_result", envir = .GlobalEnv)
text_length_table_closed <- dispatch("closeSession", list(sessionId = text_length_table_session_id))
assert_identical(text_length_table_closed$kind, "closed", "the R data.table Text Length session did not close")

source_environment$lower_frame <- data.frame(
  text = c("ALPHA", "MiXeD", NA_character_),
  category = factor(c("FIRST", NA, "B\u00c9TA"), levels = c("FIRST", "B\u00c9TA")),
  number = 1:3,
  row.names = c("row-a", "row-b", "row-c")
)
lower_source_before <- unserialize(serialize(source_environment$lower_frame, NULL, version = 3L))
lower_step <- function(
  id = "lower-step",
  column_id = "r:c:0",
  column_name = "text",
  new_column = NULL
) {
  params <- list(column = list(id = column_id, name = column_name))
  if (!is.null(new_column)) params$newColumn <- new_column
  list(id = id, kind = "lowerText", params = params)
}
lower_open <- dispatch(
  "openSession",
  list(sessionId = lower_session_id, variableName = "lower_frame", page = page_window())
)
assert_identical(lower_open$kind, "page", "the R Lowercase session did not open")

lower_derived_preview <- dispatch(
  "previewStep",
  list(
    sessionId = lower_session_id,
    revision = 0L,
    step = lower_step(new_column = "lower copy"),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(lower_derived_preview$kind, "stepPreview", "derived R Lowercase did not preview")
assert_identical(
  lower_derived_preview$page$page$columnIds,
  list("c:step:lower-step:0"),
  "derived R Lowercase lost its output identity"
)
assert_identical(lower_derived_preview$diff$addedColumns, list("lower copy"), "derived R Lowercase lost its diff")
assert_identical(lower_derived_preview$diff$changedCells, 0L, "derived R Lowercase reported source-cell changes")
assert_identical(lower_derived_preview$page$schema[[4L]]$rawType, "character", "derived R Lowercase returned the wrong type")
assert_identical(
  lower_derived_preview$page$schema[[4L]]$nullable,
  lower_derived_preview$page$schema[[1L]]$nullable,
  "derived R Lowercase changed source nullability"
)
lower_derived_discard <- dispatch(
  "discardDraft",
  list(sessionId = lower_session_id, revision = 1L, page = page_window())
)
assert_identical(lower_derived_discard$action, "discard", "derived R Lowercase did not discard")

lower_in_place_preview <- dispatch(
  "previewStep",
  list(
    sessionId = lower_session_id,
    revision = 2L,
    step = lower_step(),
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(lower_in_place_preview$kind, "stepPreview", "in-place R Lowercase did not preview")
assert_identical(lower_in_place_preview$page$page$columnIds, list("r:c:0"), "in-place R Lowercase changed lineage")
assert_identical(lower_in_place_preview$diff$addedColumns, list(), "in-place R Lowercase added a column")
assert_identical(lower_in_place_preview$diff$changedCells, 2L, "in-place R Lowercase returned an inexact cell count")
assert_identical(length(lower_in_place_preview$diff$cells), 2L, "in-place R Lowercase lost bounded cell diffs")
assert_identical(lower_in_place_preview$diff$truncated, FALSE, "a complete R Lowercase diff was marked truncated")
assert_identical(
  vapply(lower_in_place_preview$diff$cells, function(cell) cell$before$raw, character(1L)),
  c("ALPHA", "MiXeD"),
  "R Lowercase diff lost before values"
)
assert_identical(
  vapply(lower_in_place_preview$diff$cells, function(cell) cell$after$raw, character(1L)),
  c("alpha", "mixed"),
  "R Lowercase diff lost after values"
)
lower_in_place_apply <- dispatch(
  "applyDraft",
  list(sessionId = lower_session_id, revision = 3L, page = page_window())
)
assert_identical(lower_in_place_apply$action, "apply", "in-place R Lowercase did not apply")
assert_identical(lower_in_place_apply$page$schema[[1L]]$id, "r:c:0", "applied R Lowercase changed lineage")
if (!grepl("tolower(.ow_lower_values)", lower_in_place_apply$code, fixed = TRUE)) {
  stop("generated R Lowercase code lost its native tolower expression", call. = FALSE)
}
assign("lower_frame", source_environment$lower_frame, envir = .GlobalEnv)
eval(parse(text = lower_in_place_apply$code), envir = .GlobalEnv)
lower_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(lower_generated$text, c("alpha", "mixed", NA_character_), "generated R Lowercase changed values")
assert_identical(row.names(lower_generated), row.names(lower_source_before), "generated R Lowercase changed row names")
assert_identical(
  get("lower_frame", envir = .GlobalEnv, inherits = FALSE),
  lower_source_before,
  "generated R Lowercase mutated its source dataframe"
)
rm("lower_frame", "open_wrangler_result", envir = .GlobalEnv)

lower_inspection <- inspect_step(
  lower_session_id,
  4L,
  "lower-step",
  page_window()
)
assert_identical(lower_inspection$kind, "stepInspection", "applied R Lowercase was not inspectable")
assert_identical(lower_inspection$diff$changedCells, 2L, "R Lowercase inspection lost its exact diff")
lower_undo <- dispatch(
  "undoStep",
  list(sessionId = lower_session_id, revision = 4L, page = page_window())
)
assert_identical(lower_undo$action, "undo", "R Lowercase did not undo")
assert_identical(source_environment$lower_frame, lower_source_before, "the R Lowercase lifecycle mutated its source")
lower_closed <- dispatch("closeSession", list(sessionId = lower_session_id))
assert_identical(lower_closed$kind, "closed", "the R Lowercase session did not close")

source_environment$lower_table <- data.table::data.table(
  primary_key = c("B", "a"),
  payload = c("SECOND", "FIRST"),
  row_marker = c("row-b", "row-a")
)
data.table::setkey(source_environment$lower_table, primary_key)
lower_table_before <- data.table::copy(source_environment$lower_table)
lower_table_open <- dispatch(
  "openSession",
  list(sessionId = lower_table_session_id, variableName = "lower_table", page = page_window())
)
assert_identical(lower_table_open$kind, "page", "the R data.table Lowercase session did not open")
lower_table_non_key <- dispatch(
  "previewStep",
  list(
    sessionId = lower_table_session_id,
    revision = 0L,
    step = lower_step("lower-table-payload", "r:c:1", "payload"),
    page = page_window()
  )
)
assert_identical(lower_table_non_key$kind, "stepPreview", "R Lowercase could not replace a non-key data.table column")
assert_identical(
  lower_table_non_key$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "in-place R Lowercase changed a retained data.table key"
)
lower_table_non_key_code <- lower_table_non_key$code
lower_table_discard <- dispatch(
  "discardDraft",
  list(sessionId = lower_table_session_id, revision = 1L, page = page_window())
)
assert_identical(lower_table_discard$action, "discard", "R data.table Lowercase did not discard")

lower_table_key_error <- dispatch(
  "previewStep",
  list(
    sessionId = lower_table_session_id,
    revision = 2L,
    step = lower_step("lower-table-key", "r:c:0", "primary_key"),
    page = page_window()
  )
)
assert_identical(lower_table_key_error$kind, "error", "R Lowercase silently replaced a data.table key")
assert_identical(lower_table_key_error$code, "invalid_request", "the data.table key diagnostic changed")
if (!grepl("choose a new output column", lower_table_key_error$message, fixed = TRUE)) {
  stop("R Lowercase did not explain how to preserve a data.table key", call. = FALSE)
}

lower_table_derived <- dispatch(
  "previewStep",
  list(
    sessionId = lower_table_session_id,
    revision = 2L,
    step = lower_step("lower-table-derived", "r:c:0", "primary_key", "lower key"),
    page = page_window()
  )
)
assert_identical(lower_table_derived$kind, "stepPreview", "derived R data.table Lowercase did not preview")
assert_identical(lower_table_derived$page$frameSemantics$keyColumnIds, list("r:c:0"), "derived R Lowercase lost the key")
lower_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = lower_table_session_id, revision = 3L, page = page_window())
)
assign("lower_table", source_environment$lower_table, envir = .GlobalEnv)
eval(parse(text = lower_table_apply$code), envir = .GlobalEnv)
lower_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(data.table::key(lower_table_generated), "primary_key", "generated R Lowercase lost the data.table key")
assert_identical(lower_table_generated$row_marker, lower_table_before$row_marker, "generated R Lowercase changed row order")
assert_identical(lower_table_generated$`lower key`, c("b", "a"), "generated R Lowercase changed derived values")
assert_identical(
  get("lower_table", envir = .GlobalEnv, inherits = FALSE),
  lower_table_before,
  "generated R data.table Lowercase mutated its source"
)
rm("lower_table", "open_wrangler_result", envir = .GlobalEnv)

generated_key_source <- data.table::copy(lower_table_before)
data.table::setkey(generated_key_source, payload)
generated_key_before <- data.table::copy(generated_key_source)
assign("lower_table", generated_key_source, envir = .GlobalEnv)
generated_key_error <- tryCatch(
  {
    eval(parse(text = lower_table_non_key_code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (is.null(generated_key_error) || !grepl("choose a new output column", conditionMessage(generated_key_error), fixed = TRUE)) {
  stop("generated R Lowercase silently replaced a data.table key", call. = FALSE)
}
assert_identical(
  get("lower_table", envir = .GlobalEnv, inherits = FALSE),
  generated_key_before,
  "the generated R Lowercase key guard mutated its source"
)
rm("lower_table", envir = .GlobalEnv)
assert_identical(source_environment$lower_table, lower_table_before, "the R data.table Lowercase lifecycle mutated its source")
lower_table_closed <- dispatch("closeSession", list(sessionId = lower_table_session_id))
assert_identical(lower_table_closed$kind, "closed", "the R data.table Lowercase session did not close")

source_environment$cast_frame <- data.frame(
  integer_text = c(" 1.9", "bad", NA_character_),
  float_factor = factor(c(" 2.5", "NaN", "bad"), levels = c(" 2.5", "NaN", "bad")),
  boolean_text = c("true", "F", "no"),
  date_text = c("2024-02-29", "2024-2-29", NA_character_),
  datetime_text = c("2024-02-29T12:34:56.123456Z", "2024-02-29", "bad"),
  number = c(pi, NaN, Inf),
  row.names = c("cast-a", "cast-b", "cast-c")
)
cast_source_before <- unserialize(serialize(source_environment$cast_frame, NULL, version = 3L))
cast_step <- function(id, position, name, dtype) {
  list(
    id = id,
    kind = "castColumn",
    params = list(column = list(id = sprintf("r:c:%d", position - 1L), name = name), dtype = dtype)
  )
}
cast_open <- dispatch(
  "openSession",
  list(sessionId = cast_session_id, variableName = "cast_frame", page = page_window())
)
assert_identical(cast_open$kind, "page", "the R Cast session did not open")
cast_bad_dtype <- dispatch(
  "previewStep",
  list(
    sessionId = cast_session_id,
    revision = 0L,
    step = cast_step("bad-cast", 1L, "integer_text", "category"),
    page = page_window()
  )
)
assert_identical(cast_bad_dtype$kind, "error", "R Cast accepted an unknown target type")
assert_identical(cast_bad_dtype$code, "invalid_request", "the R Cast target diagnostic changed")

cast_cases <- list(
  list(id = "cast-integer", position = 1L, name = "integer_text", dtype = "integer"),
  list(id = "cast-float", position = 2L, name = "float_factor", dtype = "float"),
  list(id = "cast-boolean", position = 3L, name = "boolean_text", dtype = "boolean"),
  list(id = "cast-date", position = 4L, name = "date_text", dtype = "date"),
  list(id = "cast-datetime", position = 5L, name = "datetime_text", dtype = "datetime"),
  list(id = "cast-string", position = 6L, name = "number", dtype = "string")
)
cast_revision <- 0L
cast_apply <- NULL
for (case in cast_cases) {
  cast_preview <- dispatch(
    "previewStep",
    list(
      sessionId = cast_session_id,
      revision = cast_revision,
      step = cast_step(case$id, case$position, case$name, case$dtype),
      page = page_window(column_offset = case$position - 1L, column_limit = 1L)
    )
  )
  assert_identical(cast_preview$kind, "stepPreview", sprintf("R Cast did not preview %s", case$dtype))
  assert_identical(
    cast_preview$page$page$columnIds,
    list(sprintf("r:c:%d", case$position - 1L)),
    sprintf("R Cast changed %s lineage", case$dtype)
  )
  assert_identical(cast_preview$diff$addedColumns, list(), "in-place R Cast added a column")
  assert_identical(cast_preview$diff$truncated, FALSE, "a complete R Cast diff was marked truncated")
  if (identical(case$id, "cast-integer")) {
    assert_identical(cast_preview$diff$changedCells, 2L, "R Cast returned an inexact integer diff")
    assert_identical(length(cast_preview$diff$cells), 2L, "R Cast lost its bounded integer cell diffs")
    assert_identical(
      cast_preview$diff$cells[[1L]]$before$raw,
      " 1.9",
      "R Cast lost the integer diff's source value"
    )
    assert_identical(
      cast_preview$diff$cells[[1L]]$after$raw,
      "1",
      "R Cast lost the integer diff's result value"
    )
  }
  cast_revision <- cast_revision + 1L
  cast_apply <- dispatch(
    "applyDraft",
    list(sessionId = cast_session_id, revision = cast_revision, page = page_window())
  )
  assert_identical(cast_apply$action, "apply", sprintf("R Cast did not apply %s", case$dtype))
  cast_revision <- cast_revision + 1L
}

if (!grepl(".ow_cast_values", cast_apply$code, fixed = TRUE)) {
  stop("generated R Cast code lost its deterministic cast helper", call. = FALSE)
}
assign("cast_frame", source_environment$cast_frame, envir = .GlobalEnv)
eval(parse(text = cast_apply$code), envir = .GlobalEnv)
cast_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(cast_generated$integer_text, c(1L, NA_integer_, NA_integer_), "generated R integer Cast changed values")
assert_identical(cast_generated$float_factor, c(2.5, NaN, NA_real_), "generated R float Cast changed factor labels")
assert_identical(cast_generated$boolean_text, c(TRUE, FALSE, NA), "generated R boolean Cast changed values")
assert_identical(
  cast_generated$date_text,
  as.Date(c("2024-02-29", NA, NA)),
  "generated R date Cast accepted non-canonical input"
)
assert_identical(
  cast_generated$datetime_text,
  as.POSIXct(c("2024-02-29 12:34:56.123456", "2024-02-29 00:00:00", NA), tz = "UTC"),
  "generated R datetime Cast changed UTC parsing"
)
assert_identical(
  cast_generated$number,
  c("3.1415926535897931", "NaN", "Inf"),
  "generated R string Cast changed exact numeric formatting"
)
assert_identical(row.names(cast_generated), row.names(cast_source_before), "generated R Cast changed row names")
assert_identical(
  get("cast_frame", envir = .GlobalEnv, inherits = FALSE),
  cast_source_before,
  "generated R Cast mutated its source dataframe"
)
rm("cast_frame", "open_wrangler_result", envir = .GlobalEnv)

cast_inspection <- inspect_step(
  cast_session_id,
  cast_revision,
  "cast-string",
  page_window(column_offset = 5L, column_limit = 1L)
)
assert_identical(cast_inspection$kind, "stepInspection", "applied R Cast was not inspectable")
assert_identical(cast_inspection$diff$changedCells, 3L, "R Cast inspection lost its exact diff")
cast_undo <- dispatch(
  "undoStep",
  list(sessionId = cast_session_id, revision = cast_revision, page = page_window())
)
assert_identical(cast_undo$action, "undo", "R Cast did not undo")
assert_identical(cast_undo$page$schema[[6L]]$rawType, "double", "R Cast undo did not restore the input type")
assert_identical(source_environment$cast_frame, cast_source_before, "the R Cast lifecycle mutated its source")
cast_closed <- dispatch("closeSession", list(sessionId = cast_session_id))
assert_identical(cast_closed$kind, "closed", "the R Cast session did not close")

source_environment$cast_table <- data.table::data.table(primary_key = c("2", "1"), value = c("4", "3"))
data.table::setkey(source_environment$cast_table, primary_key)
cast_table_before <- data.table::copy(source_environment$cast_table)
cast_table_open <- dispatch(
  "openSession",
  list(sessionId = cast_table_session_id, variableName = "cast_table", page = page_window())
)
assert_identical(cast_table_open$kind, "page", "the R data.table Cast session did not open")
cast_key_error <- dispatch(
  "previewStep",
  list(
    sessionId = cast_table_session_id,
    revision = 0L,
    step = cast_step("cast-key", 1L, "primary_key", "integer"),
    page = page_window()
  )
)
assert_identical(cast_key_error$kind, "error", "R Cast silently replaced a data.table key")
assert_identical(cast_key_error$code, "invalid_request", "the data.table Cast key diagnostic changed")
if (!grepl("clone the column before casting it", cast_key_error$message, fixed = TRUE)) {
  stop("R Cast did not explain how to preserve a data.table key", call. = FALSE)
}
assert_identical(source_environment$cast_table, cast_table_before, "R Cast mutated a keyed data.table")
cast_table_closed <- dispatch("closeSession", list(sessionId = cast_table_session_id))
assert_identical(cast_table_closed$kind, "closed", "the R data.table Cast session did not close")

source_environment$cast_off_page <- data.frame(
  elapsed = as.difftime(c(rep(1, 100L), NaN), units = "hours"),
  date_text = c(rep("2024-02-29", 100L), "0001-01-01"),
  check.names = FALSE
)
cast_off_page_before <- unserialize(serialize(source_environment$cast_off_page, NULL, version = 3L))
cast_off_page_open <- dispatch(
  "openSession",
  list(sessionId = cast_off_page_session_id, variableName = "cast_off_page", page = page_window())
)
assert_identical(cast_off_page_open$kind, "page", "the off-page R Cast session did not open")
cast_off_page_duration_preview <- dispatch(
  "previewStep",
  list(
    sessionId = cast_off_page_session_id,
    revision = 0L,
    step = cast_step("cast-off-page-duration", 1L, "elapsed", "string"),
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(cast_off_page_duration_preview$kind, "stepPreview", "the off-page duration Cast did not preview")
cast_off_page_duration_apply <- dispatch(
  "applyDraft",
  list(sessionId = cast_off_page_session_id, revision = 1L, page = page_window())
)
assert_identical(cast_off_page_duration_apply$action, "apply", "the off-page duration Cast did not apply")
cast_off_page_date_preview <- dispatch(
  "previewStep",
  list(
    sessionId = cast_off_page_session_id,
    revision = 2L,
    step = cast_step("cast-off-page-date", 2L, "date_text", "date"),
    page = page_window(column_offset = 1L, column_limit = 1L)
  )
)
assert_identical(cast_off_page_date_preview$kind, "stepPreview", "the off-page date Cast did not preview")
cast_off_page_apply <- dispatch(
  "applyDraft",
  list(sessionId = cast_off_page_session_id, revision = 3L, page = page_window())
)
assert_identical(cast_off_page_apply$action, "apply", "the off-page date Cast did not apply")
cast_off_page_last <- dispatch(
  "getPage",
  list(sessionId = cast_off_page_session_id, page = page_window(row_offset = 100L, row_limit = 1L))
)
assert_identical(
  vapply(cast_off_page_last$page$page$rows[[1L]]$values, `[[`, logical(1L), "isNull"),
  c(TRUE, TRUE),
  "off-page R Cast values did not become displayable typed NA values"
)
assign("cast_off_page", source_environment$cast_off_page, envir = .GlobalEnv)
eval(parse(text = cast_off_page_apply$code), envir = .GlobalEnv)
cast_off_page_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  is.na(cast_off_page_generated$elapsed[[101L]]),
  TRUE,
  "generated R duration Cast disagreed with the live off-page NaN result"
)
assert_identical(
  is.na(cast_off_page_generated$date_text[[101L]]),
  TRUE,
  "generated R date Cast disagreed with the live off-page ancient-date result"
)
assert_identical(
  get("cast_off_page", envir = .GlobalEnv, inherits = FALSE),
  cast_off_page_before,
  "generated off-page R Cast mutated its source dataframe"
)
rm("cast_off_page", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(
  source_environment$cast_off_page,
  cast_off_page_before,
  "the off-page R Cast lifecycle mutated its source dataframe"
)
cast_off_page_closed <- dispatch("closeSession", list(sessionId = cast_off_page_session_id))
assert_identical(cast_off_page_closed$kind, "closed", "the off-page R Cast session did not close")

large_factor_levels <- sprintf("level-%06d-%s", seq_len(100000L), strrep("x", 90L))
source_environment$large_factor <- data.frame(
  value = factor(large_factor_levels[[1L]], levels = large_factor_levels),
  check.names = FALSE
)
large_factor_open <- dispatch(
  "openSession",
  list(sessionId = large_factor_session_id, variableName = "large_factor", page = page_window(row_limit = 1L, column_limit = 1L))
)
assert_identical(large_factor_open$kind, "page", "the near-budget R factor frame did not open")
large_factor_preview <- dispatch(
  "previewStep",
  list(
    sessionId = large_factor_session_id,
    revision = 0L,
    step = list(
      id = "large-factor-rename",
      kind = "renameColumn",
      params = list(column = list(id = "r:c:0", name = "value"), newName = "renamed")
    ),
    page = page_window(row_limit = 1L, column_limit = 1L)
  )
)
assert_identical(
  large_factor_preview$kind,
  "stepPreview",
  "a valid near-budget R factor schema became too large during preview"
)
assert_identical(large_factor_preview$inputSchema, NULL, "R preview duplicated the complete input schema")
large_factor_applied <- dispatch(
  "applyDraft",
  list(
    sessionId = large_factor_session_id,
    revision = 1L,
    page = page_window(row_limit = 1L, column_limit = 1L)
  )
)
assert_identical(large_factor_applied$kind, "planUpdated", "the near-budget R factor rename did not apply")
large_factor_inspected <- inspect_step(
  large_factor_session_id,
  2L,
  "large-factor-rename",
  page_window(row_limit = 1L, column_limit = 1L)
)
assert_identical(
  large_factor_inspected$kind,
  "stepInspection",
  "a valid near-budget R factor schema became too large during inspection"
)
assert_schema_less_inspection(large_factor_inspected, "near-budget R factor inspection")
large_factor_closed <- dispatch("closeSession", list(sessionId = large_factor_session_id))
assert_identical(large_factor_closed$kind, "closed", "the near-budget R factor session did not close")

source_environment$large_cells <- data.frame(
  value = rep(strrep("x", 8192L), 600L),
  check.names = FALSE
)
large_cells_page <- page_window(row_limit = 600L, column_limit = 1L)
large_cells_open <- dispatch(
  "openSession",
  list(sessionId = large_cells_session_id, variableName = "large_cells", page = large_cells_page)
)
assert_identical(large_cells_open$kind, "page", "the large-cell R frame did not open")
large_cells_preview <- dispatch(
  "previewStep",
  list(
    sessionId = large_cells_session_id,
    revision = 0L,
    step = list(
      id = "large-cells-rename",
      kind = "renameColumn",
      params = list(column = list(id = "r:c:0", name = "value"), newName = "renamed")
    ),
    page = large_cells_page
  )
)
assert_identical(large_cells_preview$kind, "stepPreview", "the large-cell R rename did not preview")
large_cells_applied <- dispatch(
  "applyDraft",
  list(sessionId = large_cells_session_id, revision = 1L, page = large_cells_page)
)
assert_identical(large_cells_applied$kind, "planUpdated", "the large-cell R rename did not apply")
large_cells_inspected <- inspect_step(
  large_cells_session_id,
  2L,
  "large-cells-rename",
  large_cells_page
)
assert_identical(
  length(large_cells_inspected$inputPage$page$rows),
  600L,
  "the split R inspection truncated its large input page"
)
assert_identical(
  length(large_cells_inspected$outputPage$page$rows),
  600L,
  "the split R inspection truncated its large output page"
)
large_cells_closed <- dispatch("closeSession", list(sessionId = large_cells_session_id))
assert_identical(large_cells_closed$kind, "closed", "the large-cell R session did not close")

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

row_sort_rule <- function(id, name, direction = "asc", nulls = "last") {
  list(column = list(id = id, name = name), direction = direction, nulls = nulls)
}
row_sort_step <- function(rules, id = "row-sort-step") {
  list(id = id, kind = "sortRows", params = list(rules = I(rules)))
}
row_filter_step <- function(operator = "isNaN", id = "row-filter-step") {
  list(
    id = id,
    kind = "filterRows",
    params = list(filterModel = list(
      logic = "and",
      filters = I(list(
        list(
          column = list(id = "r:c:0", name = "duplicate"),
          type = "string",
          predicates = I(list()),
          valueFilter = list(
            kind = "values",
            selectedValues = I(list("a")),
            includeNulls = FALSE,
            includeNaN = FALSE
          )
        ),
        list(
          column = list(id = "r:c:1", name = "duplicate"),
          type = "float",
          predicates = I(list(list(kind = "predicate", operator = operator)))
        )
      )),
      sort = I(list())
    ))
  )
}

source_environment$row_frame <- data.frame(
  duplicate = c("b", "a", "a", "b", NA, "a", "a"),
  duplicate = c(2, 1, 1, 1, 9, NA, NaN),
  `non syntactic` = seq_len(7L),
  check.names = FALSE,
  row.names = paste0("row-", seq_len(7L)),
  stringsAsFactors = FALSE
)
row_source_before <- unserialize(serialize(source_environment$row_frame, NULL, version = 3L))
row_open <- dispatch(
  "openSession",
  list(sessionId = row_session_id, variableName = "row_frame", page = page_window(row_limit = 7L))
)
assert_identical(row_open$kind, "page", "the R row-operation session did not open")
sort_step <- row_sort_step(list(
  row_sort_rule("r:c:0", "duplicate", "asc", "last"),
  row_sort_rule("r:c:1", "duplicate", "desc", "first")
))
row_sort_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_session_id,
    revision = 0L,
    step = sort_step,
    page = page_window(row_limit = 7L)
  )
)
assert_identical(row_sort_preview$kind, "stepPreview", "committed R multi-sort did not preview")
assert_identical(
  vapply(row_sort_preview$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", c(5L, 6L, 1L, 2L, 0L, 3L, 4L)),
  "committed R multi-sort changed priority, missing placement, stable ties, or row identities"
)
assert_identical(row_sort_preview$diff$removedRows, 0L, "sorting reported removed rows")
assert_identical(row_sort_preview$diff$truncated, FALSE, "a complete sort preview was marked truncated")
row_sort_discard <- dispatch(
  "discardDraft",
  list(sessionId = row_session_id, revision = 1L, page = page_window(row_limit = 7L))
)
assert_identical(row_sort_discard$action, "discard", "the first R sort draft did not discard")
assert_identical(
  vapply(row_sort_discard$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", 0:6),
  "discarding an R sort did not restore original row identities"
)

row_sort_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_session_id,
    revision = 2L,
    step = sort_step,
    page = page_window(row_limit = 7L)
  )
)
row_sort_apply <- dispatch(
  "applyDraft",
  list(sessionId = row_session_id, revision = 3L, page = page_window(row_limit = 7L))
)
assert_identical(row_sort_apply$action, "apply", "the R sort draft did not apply")
row_sort_inspection <- inspect_step(
  row_session_id,
  4L,
  "row-sort-step",
  page_window(row_limit = 7L)
)
assert_identical(row_sort_inspection$diff$removedRows, 0L, "sort inspection reported removed rows")
assert_identical(row_sort_inspection$diff$truncated, FALSE, "complete sort inspection was marked truncated")
assert_identical(
  vapply(row_sort_inspection$outputPage$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", c(5L, 6L, 1L, 2L, 0L, 3L, 4L)),
  "sort inspection lost stable source-row identities"
)

row_filter_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_session_id,
    revision = 4L,
    step = row_filter_step(),
    page = page_window(row_limit = 7L)
  )
)
assert_identical(row_filter_preview$kind, "stepPreview", "committed R filtering did not preview")
assert_identical(row_filter_preview$page$page$totalRows, 1L, "R filtering confused NA and NaN")
assert_identical(row_filter_preview$page$page$rows[[1L]]$id, "r:r:6", "R filtering regenerated row identity")
assert_identical(row_filter_preview$page$page$rows[[1L]]$rowLabel, "row-7", "R filtering lost the source row label")
assert_identical(row_filter_preview$diff$removedRows, 6L, "R filtering reported the wrong removed-row count")
assert_identical(row_filter_preview$diff$truncated, FALSE, "a complete filter preview was marked truncated")
row_filter_apply <- dispatch(
  "applyDraft",
  list(sessionId = row_session_id, revision = 5L, page = page_window(row_limit = 7L))
)
assert_identical(row_filter_apply$action, "apply", "the R filter draft did not apply")
row_filter_inspection <- inspect_step(
  row_session_id,
  6L,
  "row-filter-step",
  page_window(row_limit = 7L)
)
assert_identical(row_filter_inspection$diff$removedRows, 6L, "filter inspection reported the wrong row count")
assert_identical(row_filter_inspection$diff$truncated, FALSE, "complete filter inspection was marked truncated")
assert_identical(
  row_filter_inspection$outputPage$page$rows[[1L]]$id,
  "r:r:6",
  "filter inspection changed the retained row identity"
)
assign("row_frame", source_environment$row_frame, envir = .GlobalEnv)
eval(parse(text = row_filter_apply$code), envir = .GlobalEnv)
row_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(row_generated[[3L]], 7L, "generated R sort/filter code returned the wrong row")
assert_identical(
  names(row_generated),
  c("duplicate", "duplicate", "non syntactic"),
  "generated R row code repaired duplicate or non-syntactic names"
)
assert_identical(
  get("row_frame", envir = .GlobalEnv, inherits = FALSE),
  row_source_before,
  "generated R row code mutated its source dataframe"
)
rm("row_frame", "open_wrangler_result", envir = .GlobalEnv)

edited_row_filter <- dispatch(
  "previewStep",
  list(
    sessionId = row_session_id,
    revision = 6L,
    step = row_filter_step("isNull"),
    replaceStepId = "row-filter-step",
    page = page_window(row_limit = 7L)
  )
)
assert_identical(edited_row_filter$revision, 7L, "editing the R filter did not advance the revision")
assert_identical(edited_row_filter$page$page$rows[[1L]]$id, "r:r:5", "edited R filter confused NA and NaN")
edited_row_discard <- dispatch(
  "discardDraft",
  list(sessionId = row_session_id, revision = 7L, page = page_window(row_limit = 7L))
)
assert_identical(edited_row_discard$action, "discard", "the edited R filter did not discard")
assert_identical(
  edited_row_discard$page$page$rows[[1L]]$id,
  "r:r:6",
  "discarding an edited R filter did not restore the committed result"
)
row_filter_undo <- dispatch(
  "undoStep",
  list(sessionId = row_session_id, revision = 8L, page = page_window(row_limit = 7L))
)
assert_identical(row_filter_undo$action, "undo", "the committed R filter did not undo")
assert_identical(row_filter_undo$page$page$totalRows, 7L, "undoing R filtering did not restore all rows")
assert_identical(
  vapply(row_filter_undo$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", c(5L, 6L, 1L, 2L, 0L, 3L, 4L)),
  "undoing R filtering did not restore the committed sort"
)
row_sort_undo <- dispatch(
  "undoStep",
  list(sessionId = row_session_id, revision = 9L, page = page_window(row_limit = 7L))
)
assert_identical(
  vapply(row_sort_undo$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", 0:6),
  "undoing R sorting did not restore original order"
)
assert_identical(source_environment$row_frame, row_source_before, "the R row lifecycle mutated its source dataframe")
invisible(dispatch("closeSession", list(sessionId = row_session_id)))

source_environment$row_active_view <- data.frame(id = 1:4, keep = c(TRUE, FALSE, TRUE, FALSE))
row_active_view_before <- unserialize(serialize(source_environment$row_active_view, NULL, version = 3L))
row_active_filter <- list(
  column = list(id = "r:c:1", name = "keep"),
  type = "boolean",
  predicates = I(list(list(kind = "predicate", operator = "equals", value = TRUE)))
)
row_active_page <- page_window(filters = list(row_active_filter), row_limit = 2L)
invisible(dispatch(
  "openSession",
  list(
    sessionId = row_active_view_session_id,
    variableName = "row_active_view",
    page = page_window(row_limit = 4L)
  )
))
row_active_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_active_view_session_id,
    revision = 0L,
    step = list(
      id = "row-active-filter-step",
      kind = "filterRows",
      params = list(filterModel = list(
        filters = I(list(row_active_filter)),
        sort = I(list())
      ))
    ),
    page = row_active_page
  )
)
assert_identical(row_active_preview$kind, "stepPreview", "filtering an already narrowed R view did not preview")
assert_identical(row_active_preview$page$page$totalRows, 2L, "the narrowed R draft returned the wrong row count")
assert_identical(
  vapply(row_active_preview$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  c("r:r:0", "r:r:2"),
  "the narrowed R draft changed stable row identities"
)
assert_identical(row_active_preview$diff$removedRows, 2L, "the narrowed R draft lost its cleaning row count")
assert_identical(
  row_active_preview$diff$truncated,
  FALSE,
  "a full current view matching the committed filter was incorrectly marked truncated"
)
assert_identical(
  source_environment$row_active_view,
  row_active_view_before,
  "previewing a filter from an already narrowed view mutated its source"
)
row_active_apply <- dispatch(
  "applyDraft",
  list(sessionId = row_active_view_session_id, revision = 1L, page = row_active_page)
)
row_active_code_lines <- strsplit(sub("\n$", "", row_active_apply$code), "\n", fixed = TRUE)[[1L]]
if (length(row_active_code_lines) > 28L || nchar(row_active_apply$code, type = "bytes") > 1800L) {
  stop("generated R filter code is no longer concise", call. = FALSE)
}
if (
  !grepl("# Filter rows", row_active_apply$code, fixed = TRUE) ||
    !grepl(".ow_keep <-", row_active_apply$code, fixed = TRUE)
) {
  stop("generated R filter code lost its readable native statements", call. = FALSE)
}
assign("row_active_view", source_environment$row_active_view, envir = .GlobalEnv)
eval(parse(text = row_active_apply$code), envir = .GlobalEnv)
row_active_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(row_active_generated$id, c(1L, 3L), "generated R filtering returned the wrong rows")
assert_identical(
  get("row_active_view", envir = .GlobalEnv, inherits = FALSE),
  row_active_view_before,
  "generated R filtering mutated its source dataframe"
)
rm("row_active_view", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = row_active_view_session_id)))

source_environment$row_empty_named <- data.frame(
  value = 1:2,
  row.names = c("named-a", "named-b")
)
row_empty_named_before <- unserialize(serialize(source_environment$row_empty_named, NULL, version = 3L))
row_empty_named_open <- dispatch(
  "openSession",
  list(
    sessionId = row_empty_named_session_id,
    variableName = "row_empty_named",
    page = page_window(row_limit = 2L, column_limit = 1L)
  )
)
assert_identical(
  row_empty_named_open$page$frameSemantics$rowNames,
  "explicit",
  "the empty-filter source did not start with explicit row names"
)
row_empty_named_step <- list(
  id = "row-empty-named-step",
  kind = "filterRows",
  params = list(filterModel = list(
    filters = I(list(list(
      column = list(id = "r:c:0", name = "value"),
      type = "integer",
      predicates = I(list(list(kind = "predicate", operator = "gt", value = 99L)))
    ))),
    sort = I(list())
  ))
)
row_empty_named_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_empty_named_session_id,
    revision = 0L,
    step = row_empty_named_step,
    page = page_window(row_limit = 2L, column_limit = 1L)
  )
)
assert_identical(row_empty_named_preview$kind, "stepPreview", "an empty named-row filter did not preview")
assert_identical(row_empty_named_preview$page$page$totalRows, 0L, "the empty named-row filter retained rows")
assert_identical(
  row_empty_named_preview$page$frameSemantics$rowNames,
  "explicit",
  "an empty named-row filter changed the published row-name contract"
)
row_empty_named_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = row_empty_named_session_id,
    revision = 1L,
    page = page_window(row_limit = 2L, column_limit = 1L)
  )
)
assert_identical(
  row_empty_named_apply$page$frameSemantics$rowNames,
  "explicit",
  "applying an empty named-row filter changed the row-name contract"
)
row_empty_named_inspection <- inspect_step(
  row_empty_named_session_id,
  2L,
  "row-empty-named-step",
  page_window(row_limit = 2L, column_limit = 1L)
)
assert_identical(
  row_empty_named_inspection$outputPage$frameSemantics$rowNames,
  "explicit",
  "inspecting an empty named-row filter changed the row-name contract"
)
assert_identical(
  source_environment$row_empty_named,
  row_empty_named_before,
  "filtering an explicit-row-name frame to zero rows mutated its source"
)
invisible(dispatch("closeSession", list(sessionId = row_empty_named_session_id)))

assert_native_row_sort_isolated <- function(variable_name, isolated_session_id, source_before, column_name) {
  opened <- dispatch(
    "openSession",
    list(sessionId = isolated_session_id, variableName = variable_name, page = page_window())
  )
  assert_identical(opened$kind, "page", sprintf("%s did not open for native row sorting", variable_name))
  previewed <- dispatch(
    "previewStep",
    list(
      sessionId = isolated_session_id,
      revision = 0L,
      step = row_sort_step(list(row_sort_rule("r:c:1", column_name, "desc", "last")), paste0(variable_name, "-sort")),
      page = page_window()
    )
  )
  assert_identical(previewed$kind, "stepPreview", sprintf("%s sort did not preview", variable_name))
  applied <- dispatch(
    "applyDraft",
    list(sessionId = isolated_session_id, revision = 1L, page = page_window())
  )
  assert_identical(
    get(variable_name, envir = source_environment, inherits = FALSE),
    source_before,
    sprintf("the %s row operation mutated its source", variable_name)
  )
  assign(variable_name, get(variable_name, envir = source_environment, inherits = FALSE), envir = .GlobalEnv)
  eval(parse(text = applied$code), envir = .GlobalEnv)
  generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_identical(
    get(variable_name, envir = .GlobalEnv, inherits = FALSE),
    source_before,
    sprintf("generated %s row code mutated its source", variable_name)
  )
  rm(list = c(variable_name, "open_wrangler_result"), envir = .GlobalEnv)
  invisible(dispatch("closeSession", list(sessionId = isolated_session_id)))
  list(applied = applied, generated = generated)
}

source_environment$row_tibble <- tibble::tibble(id = c(3L, 1L, 2L), score = c(1, 3, 2))
row_tibble_before <- unserialize(serialize(source_environment$row_tibble, NULL, version = 3L))
row_tibble_result <- assert_native_row_sort_isolated(
  "row_tibble",
  row_tibble_session_id,
  row_tibble_before,
  "score"
)
row_tibble_code_lines <- strsplit(sub("\n$", "", row_tibble_result$applied$code), "\n", fixed = TRUE)[[1L]]
if (length(row_tibble_code_lines) > 32L || nchar(row_tibble_result$applied$code, type = "bytes") > 2250L) {
  stop("generated R sort code is no longer concise", call. = FALSE)
}
if (
  !grepl("# Sort rows", row_tibble_result$applied$code, fixed = TRUE) ||
    !grepl("base::order", row_tibble_result$applied$code, fixed = TRUE)
) {
  stop("generated R sort code lost its readable native statements", call. = FALSE)
}
assert_identical(
  class(row_tibble_result$generated),
  c("tbl_df", "tbl", "data.frame"),
  "generated R sorting changed the tibble class"
)
assert_identical(row_tibble_result$generated$id, c(1L, 2L, 3L), "generated tibble sorting returned wrong rows")

source_environment$row_table <- data.table::data.table(primary_key = 1:3, score = c(2, 1, 3))
data.table::setkey(source_environment$row_table, primary_key)
row_table_before <- data.table::copy(source_environment$row_table)
row_table_result <- assert_native_row_sort_isolated(
  "row_table",
  row_table_session_id,
  row_table_before,
  "score"
)
assert_identical(
  row_table_result$applied$page$frameSemantics$keyColumnIds,
  list(),
  "committed data.table sorting retained stale key metadata"
)
assert_identical(data.table::key(row_table_result$generated), NULL, "generated data.table sorting retained a stale key")
assert_identical(row_table_result$generated$primary_key, c(3L, 1L, 2L), "generated data.table sorting returned wrong rows")
assert_identical(
  data.table::key(source_environment$row_table),
  "primary_key",
  "R sorting changed the source data.table key"
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
  rename_column_at = function(...) stop("unexpected rename", call. = FALSE),
  clone_column_at = function(...) stop("unexpected clone", call. = FALSE),
  text_length_column_at = function(...) stop("unexpected text length", call. = FALSE),
  lower_text_column_at = function(...) stop("unexpected lowercase", call. = FALSE),
  cast_column_at = function(...) stop("unexpected cast", call. = FALSE),
  drop_columns_at = function(...) stop("unexpected drop", call. = FALSE),
  select_columns_at = function(...) stop("unexpected select", call. = FALSE),
  transform_rows = function(...) stop("unexpected row transform", call. = FALSE),
  materialize_view_page = function(...) stop("unexpected page materialization", call. = FALSE),
  materialize_summaries = function(...) stop("unexpected summary materialization", call. = FALSE),
  materialize_dataset_stats = function(...) stop("unexpected dataset profile", call. = FALSE),
  materialize_column_values = function(...) stop("unexpected column values", call. = FALSE),
  limits = openwrangler_r_frame_contract$limits
)
missing_text_length_contract <- missing_package_contract
missing_text_length_contract$text_length_column_at <- NULL
missing_text_length_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_text_length_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_text_length_error) ||
    !identical(conditionMessage(missing_text_length_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without Text Length support", call. = FALSE)
}
missing_lower_contract <- missing_package_contract
missing_lower_contract$lower_text_column_at <- NULL
missing_lower_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_lower_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_lower_error) ||
    !identical(conditionMessage(missing_lower_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without Lowercase support", call. = FALSE)
}
missing_cast_contract <- missing_package_contract
missing_cast_contract$cast_column_at <- NULL
missing_cast_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_cast_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_cast_error) ||
    !identical(conditionMessage(missing_cast_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without Cast support", call. = FALSE)
}
missing_transform_rows_contract <- missing_package_contract
missing_transform_rows_contract$transform_rows <- NULL
missing_transform_rows_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_transform_rows_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_transform_rows_error) ||
    !identical(conditionMessage(missing_transform_rows_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without row-transform support", call. = FALSE)
}
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
