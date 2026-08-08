source("r/openwrangler_runtime/frame_contract.R", local = FALSE)
source("r/openwrangler_runtime/kernel_agent.R", local = FALSE)

if (!requireNamespace("nanoparquet", quietly = TRUE)) {
  stop("The R kernel agent test requires nanoparquet", call. = FALSE)
}

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
row_reduction_session_id <- "26262626-2626-4626-8626-262626262626"
row_reduction_tibble_session_id <- "27272727-2727-4727-8727-272727272727"
row_reduction_table_session_id <- "28282828-2828-4828-8828-282828282828"
row_reduction_view_session_id <- "29292929-2929-4929-8929-292929292929"
fill_session_id <- "30303030-3030-4030-8030-303030303030"
mean_fill_session_id <- "60606060-6060-4060-8060-606060606060"
fill_table_session_id <- "31313131-3131-4131-8131-313131313131"
most_fill_session_id <- "32323232-3232-4232-8232-323232323232"
fallback_fill_session_id <- "40404040-4040-4040-8040-404040404040"
directional_fill_session_id <- "45454545-4545-4545-8545-454545454545"
linear_fill_session_id <- "52525252-5252-4252-8252-525252525252"
grouped_fill_session_id <- "46464646-4646-4646-8646-464646464646"
grouped_wide_session_id <- "47474747-4747-4747-8747-474747474747"
grouped_float_session_id <- "51515151-5151-4151-8151-515151515151"
grouped_factor_session_id <- "48484848-4848-4848-8848-484848484848"
grouped_table_session_id <- "49494949-4949-4949-8949-494949494949"
grouped_collapse_session_id <- "50505050-5050-4050-8050-505050505050"
export_session_id <- "41414141-4141-4141-8141-414141414141"
export_id <- "42424242-4242-4242-8242-424242424242"
cleanup_export_id <- "43434343-4343-4343-8343-434343434343"
parquet_export_id <- "53535353-5353-4353-8353-535353535353"
unavailable_export_session_id <- "54545454-5454-4454-8454-545454545454"
text_cleanup_session_id <- "34343434-3434-4434-8434-343434343434"
text_cleanup_table_session_id <- "35353535-3535-4535-8535-353535353535"
text_failure_session_id <- "36363636-3636-4636-8636-363636363636"
numeric_session_id <- "37373737-3737-4737-8737-373737373737"
numeric_table_session_id <- "38383838-3838-4838-8838-383838383838"
numeric_integer64_session_id <- "39393939-3939-4939-8939-393939393939"
group_by_session_id <- "61616161-6161-4161-8161-616161616161"
group_by_overflow_session_id <- "62626262-6262-4262-8262-626262626262"
group_by_precision_session_id <- "63636363-6363-4363-8363-636363636363"
group_by_export_id <- "64646464-6464-4464-8464-646464646464"
group_by_tibble_session_id <- "65656565-6565-4565-8565-656565656565"
group_by_table_session_id <- "67676767-6767-4767-8767-676767676767"

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
group_by_source_materializations <- 0L
instrumented_frame_contract <- openwrangler_r_frame_contract
real_capture_frame <- instrumented_frame_contract$capture_frame
real_isolate_capture <- instrumented_frame_contract$isolate_capture
real_materialize_view_page <- instrumented_frame_contract$materialize_view_page
instrumented_frame_contract$capture_frame <- function(value, ...) {
  full_capture_count <<- full_capture_count + 1L
  real_capture_frame(value, ...)
}
instrumented_frame_contract$isolate_capture <- function(capture) {
  isolated_capture_count <<- isolated_capture_count + 1L
  real_isolate_capture(capture)
}
instrumented_frame_contract$materialize_view_page <- function(capture, ...) {
  schema_names <- vapply(capture$descriptor$schema, `[[`, character(1L), "name", USE.NAMES = FALSE)
  if (identical(schema_names, c("group", "number", "label", "ordered_label", "when", "flag"))) {
    group_by_source_materializations <<- group_by_source_materializations + 1L
  }
  real_materialize_view_page(capture, ...)
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
    list(transportVersion = 9L, requestId = id, kind = kind, payload = payload),
    auto_unbox = TRUE,
    null = "null",
    na = "null"
  )
  jsonlite::fromJSON(target_agent$dispatch_json(as.character(encoded)), simplifyVector = FALSE)
}

dispatch <- function(kind, payload, id = request_id) {
  dispatch_with(agent, kind, payload, id)
}

inspect_step <- function(
  session_id,
  revision,
  step_id,
  page,
  input_row_count = NULL,
  output_row_count = NULL
) {
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
  if (is.null(input_row_count)) input_row_count <- input$page$page$totalRows
  if (is.null(output_row_count)) output_row_count <- output$page$page$totalRows

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
      addedRows = max(0L, output_row_count - input_row_count),
      removedRows = max(0L, input_row_count - output_row_count),
      changedCells = changed_cells,
      truncated = input$page$page$offset != 0L ||
        output$page$page$offset != 0L ||
        input$page$page$totalRows != input_row_count ||
        output$page$page$totalRows != output_row_count ||
        length(input$page$page$rows) != input_row_count ||
        length(output$page$page$rows) != output_row_count
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
assert_identical(opened$exportFormats, list("csv", "parquet"), "the R agent reported the wrong export formats")
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
if (!grepl(".ow_output <- tolower(.ow_utf8)", lower_in_place_apply$code, fixed = TRUE)) {
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

source_environment$text_cleanup_frame <- data.frame(
  text = c("alpha-12", "b\u00e9ta-34", NA_character_),
  category = factor(c("small", NA, "MiXeD"), levels = c("small", "MiXeD")),
  row.names = c("text-a", "text-b", "text-c")
)
text_cleanup_before <- unserialize(serialize(source_environment$text_cleanup_frame, NULL, version = 3L))
text_transform_step <- function(
  kind,
  id,
  column_id,
  column_name,
  new_column = NULL,
  find = NULL,
  replacement = NULL,
  regex = NULL,
  characters = NULL,
  delimiter = NULL,
  index = NULL
) {
  params <- list(column = list(id = column_id, name = column_name))
  if (!is.null(new_column)) params$newColumn <- new_column
  if (identical(kind, "findReplace")) {
    params$find <- find
    params$replacement <- replacement
    params$regex <- regex
  } else if (identical(kind, "stripText") && !is.null(characters)) {
    params$characters <- characters
  } else if (identical(kind, "splitText")) {
    params$delimiter <- delimiter
    params$index <- index
  }
  list(id = id, kind = kind, params = params)
}
text_cleanup_open <- dispatch(
  "openSession",
  list(sessionId = text_cleanup_session_id, variableName = "text_cleanup_frame", page = page_window())
)
assert_identical(text_cleanup_open$kind, "page", "the R text-cleanup session did not open")

text_cleanup_malformed <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-malformed",
      "r:c:0",
      "text",
      find = "alpha",
      replacement = "beta",
      regex = "yes"
    ),
    page = page_window()
  )
)
assert_identical(text_cleanup_malformed$kind, "error", "R Find and Replace accepted a non-logical regex flag")
assert_identical(text_cleanup_malformed$code, "invalid_request", "the malformed R Find and Replace diagnostic changed")

strip_malformed <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 0L,
    step = text_transform_step(
      "stripText",
      "strip-malformed",
      "r:c:0",
      "text",
      characters = ""
    ),
    page = page_window()
  )
)
assert_identical(strip_malformed$kind, "error", "R Strip text accepted an empty character set")
assert_identical(strip_malformed$code, "invalid_request", "the malformed R Strip text diagnostic changed")

split_malformed <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 0L,
    step = text_transform_step(
      "splitText",
      "split-malformed",
      "r:c:0",
      "text",
      new_column = "text",
      delimiter = "-",
      index = 0L
    ),
    page = page_window()
  )
)
assert_identical(split_malformed$kind, "error", "R Split text accepted an in-place output")
assert_identical(split_malformed$code, "invalid_request", "the malformed R Split text diagnostic changed")

upper_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 0L,
    step = text_transform_step(
      "upperText",
      "upper-step",
      "r:c:1",
      "category",
      new_column = "upper category"
    ),
    page = page_window(column_offset = 2L, column_limit = 1L)
  )
)
assert_identical(upper_preview$kind, "stepPreview", "derived R Uppercase did not preview")
assert_identical(
  upper_preview$page$page$columnIds,
  list("c:step:upper-step:0"),
  "derived R Uppercase lost its output identity"
)
assert_identical(upper_preview$page$schema[[3L]]$rawType, "character", "R Uppercase did not convert a factor to character")
assert_identical(upper_preview$diff$addedColumns, list("upper category"), "derived R Uppercase lost its diff")
assert_identical(upper_preview$diff$changedCells, 0L, "derived R Uppercase reported source-cell changes")
upper_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 1L, page = page_window())
)
assert_identical(upper_apply$action, "apply", "derived R Uppercase did not apply")

find_regex_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 2L,
    step = text_transform_step(
      "findReplace",
      "find-regex-step",
      "r:c:0",
      "text",
      find = "^(.+)-([0-9]+)$",
      replacement = "\\2:\\1",
      regex = TRUE
    ),
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(find_regex_preview$kind, "stepPreview", "regex R Find and Replace did not preview")
assert_identical(find_regex_preview$page$page$columnIds, list("r:c:0"), "in-place R Find and Replace changed lineage")
assert_identical(find_regex_preview$diff$addedColumns, list(), "in-place R Find and Replace added a column")
assert_identical(find_regex_preview$diff$changedCells, 2L, "regex R Find and Replace returned an inexact cell count")
assert_identical(
  vapply(find_regex_preview$diff$cells, function(cell) cell$after$raw, character(1L)),
  c("12:alpha", "34:b\u00e9ta"),
  "regex R Find and Replace returned the wrong values"
)
find_regex_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 3L, page = page_window())
)
assert_identical(find_regex_apply$action, "apply", "regex R Find and Replace did not apply")
if (!grepl(".ow_output <- toupper(.ow_utf8)", find_regex_apply$code, fixed = TRUE)) {
  stop("generated R Uppercase lost its native toupper expression", call. = FALSE)
}
if (!grepl("gsub(.ow_text_find, .ow_text_replacement, .ow_utf8, perl = TRUE)", find_regex_apply$code, fixed = TRUE)) {
  stop("generated regex R Find and Replace lost its native gsub expression", call. = FALSE)
}
assign("text_cleanup_frame", source_environment$text_cleanup_frame, envir = .GlobalEnv)
eval(parse(text = find_regex_apply$code), envir = .GlobalEnv)
text_cleanup_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(text_cleanup_generated$text, c("12:alpha", "34:b\u00e9ta", NA_character_), "generated regex R Find and Replace changed values")
assert_identical(text_cleanup_generated$`upper category`, c("SMALL", NA_character_, "MIXED"), "generated R Uppercase changed values")
assert_identical(row.names(text_cleanup_generated), row.names(text_cleanup_before), "generated R text cleanup changed row names")
assert_identical(
  get("text_cleanup_frame", envir = .GlobalEnv, inherits = FALSE),
  text_cleanup_before,
  "generated R text cleanup mutated its source dataframe"
)
rm("text_cleanup_frame", "open_wrangler_result", envir = .GlobalEnv)

find_regex_inspection <- inspect_step(text_cleanup_session_id, 4L, "find-regex-step", page_window())
assert_identical(find_regex_inspection$kind, "stepInspection", "applied R Find and Replace was not inspectable")
assert_identical(find_regex_inspection$diff$changedCells, 2L, "R Find and Replace inspection lost its exact diff")
find_regex_undo <- dispatch(
  "undoStep",
  list(sessionId = text_cleanup_session_id, revision = 4L, page = page_window())
)
assert_identical(find_regex_undo$action, "undo", "R Find and Replace did not undo")
assert_identical(find_regex_undo$page$schema[[3L]]$name, "upper category", "undo removed the earlier R Uppercase step")

find_blank_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 5L,
    step = text_transform_step(
      "findReplace",
      "find-blank-step",
      "c:step:upper-step:0",
      "upper category",
      new_column = "bounded category",
      find = "",
      replacement = "\\1",
      regex = FALSE
    ),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(find_blank_preview$kind, "stepPreview", "blank-literal R Find and Replace did not preview")
assert_identical(
  find_blank_preview$page$page$columnIds,
  list("c:step:find-blank-step:0"),
  "derived blank-literal R Find and Replace lost its output identity"
)
assign("text_cleanup_frame", source_environment$text_cleanup_frame, envir = .GlobalEnv)
eval(parse(text = find_blank_preview$code), envir = .GlobalEnv)
find_blank_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  find_blank_generated$`bounded category`,
  c("\\1S\\1M\\1A\\1L\\1L\\1", NA_character_, "\\1M\\1I\\1X\\1E\\1D\\1"),
  "generated blank-literal R Find and Replace interpreted replacement backreferences"
)
assert_identical(
  get("text_cleanup_frame", envir = .GlobalEnv, inherits = FALSE),
  text_cleanup_before,
  "generated blank-literal R Find and Replace mutated its source dataframe"
)
rm("text_cleanup_frame", "open_wrangler_result", envir = .GlobalEnv)
find_blank_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_cleanup_session_id, revision = 6L, page = page_window())
)
assert_identical(find_blank_discard$action, "discard", "blank-literal R Find and Replace did not discard")

capitalize_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 7L,
    step = text_transform_step(
      "capitalizeText",
      "capitalize-step",
      "r:c:1",
      "category",
      new_column = "capitalized category"
    ),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(capitalize_preview$kind, "stepPreview", "derived R Capitalize did not preview")
assert_identical(
  capitalize_preview$page$page$columnIds,
  list("c:step:capitalize-step:0"),
  "derived R Capitalize lost its output identity"
)
assert_identical(capitalize_preview$page$schema[[4L]]$rawType, "character", "R Capitalize retained factor storage")
capitalize_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 8L, page = page_window())
)
assert_identical(capitalize_apply$action, "apply", "derived R Capitalize did not apply")

strip_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 9L,
    step = text_transform_step(
      "stripText",
      "strip-step",
      "r:c:0",
      "text",
      new_column = "stripped text",
      characters = ".[]-1234"
    ),
    page = page_window(column_offset = 4L, column_limit = 1L)
  )
)
assert_identical(strip_preview$kind, "stepPreview", "derived R Strip text did not preview")
assert_identical(
  vapply(strip_preview$page$page$rows[1:2], function(row) row$values[[1L]]$raw, character(1L)),
  c("alpha", "béta"),
  "R Strip text treated literal metacharacters as a regular expression"
)
assert_identical(strip_preview$page$page$rows[[3L]]$values[[1L]]$isNull, TRUE, "R Strip text lost source NA")
strip_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 10L, page = page_window())
)
assert_identical(strip_apply$action, "apply", "derived R Strip text did not apply")

split_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 11L,
    step = text_transform_step(
      "splitText",
      "split-step",
      "r:c:0",
      "text",
      new_column = "suffix",
      delimiter = "-",
      index = 1L
    ),
    page = page_window(column_offset = 5L, column_limit = 1L)
  )
)
assert_identical(split_preview$kind, "stepPreview", "derived R Split text did not preview")
assert_identical(
  split_preview$page$page$columnIds,
  list("c:step:split-step:0"),
  "derived R Split text lost its output identity"
)
assert_identical(
  vapply(split_preview$page$page$rows[1:2], function(row) row$values[[1L]]$raw, character(1L)),
  c("12", "34"),
  "R Split text changed zero-based literal delimiter behavior"
)
assert_identical(split_preview$page$page$rows[[3L]]$values[[1L]]$isNull, TRUE, "R Split text lost source NA")
split_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 12L, page = page_window())
)
assert_identical(split_apply$action, "apply", "derived R Split text did not apply")
for (native_expression in c(
  "toupper(.ow_characters[[1L]])",
  ".ow_text_strip_characters",
  "gregexpr(.ow_text_delimiter, .ow_utf8, fixed = TRUE)"
)) {
  if (!grepl(native_expression, split_apply$code, fixed = TRUE)) {
    stop(sprintf("generated R text tools lost native expression: %s", native_expression), call. = FALSE)
  }
}
assign("text_cleanup_frame", source_environment$text_cleanup_frame, envir = .GlobalEnv)
eval(parse(text = split_apply$code), envir = .GlobalEnv)
text_tools_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  text_tools_generated$`capitalized category`,
  c("Small", NA_character_, "Mixed"),
  "generated R Capitalize changed values"
)
assert_identical(text_tools_generated$`stripped text`, c("alpha", "béta", NA_character_), "generated R Strip text changed values")
assert_identical(text_tools_generated$suffix, c("12", "34", NA_character_), "generated R Split text changed values")
assert_identical(row.names(text_tools_generated), row.names(text_cleanup_before), "generated R text tools changed row names")
assert_identical(
  get("text_cleanup_frame", envir = .GlobalEnv, inherits = FALSE),
  text_cleanup_before,
  "generated R text tools mutated their source dataframe"
)
rm("text_cleanup_frame", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(source_environment$text_cleanup_frame, text_cleanup_before, "the R text-cleanup lifecycle mutated its source")
text_cleanup_closed <- dispatch("closeSession", list(sessionId = text_cleanup_session_id))
assert_identical(text_cleanup_closed$kind, "closed", "the R text-cleanup session did not close")

source_environment$text_cleanup_table <- data.table::data.table(
  primary_key = c("B", "a"),
  row_marker = c("row-b", "row-a")
)
data.table::setkey(source_environment$text_cleanup_table, primary_key)
text_cleanup_table_before <- data.table::copy(source_environment$text_cleanup_table)
text_cleanup_table_open <- dispatch(
  "openSession",
  list(sessionId = text_cleanup_table_session_id, variableName = "text_cleanup_table", page = page_window())
)
assert_identical(text_cleanup_table_open$kind, "page", "the R data.table text-cleanup session did not open")
text_cleanup_table_key_error <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_table_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-table-key",
      "r:c:0",
      "primary_key",
      find = "B",
      replacement = "b",
      regex = FALSE
    ),
    page = page_window()
  )
)
assert_identical(text_cleanup_table_key_error$kind, "error", "R Find and Replace silently replaced a data.table key")
assert_identical(text_cleanup_table_key_error$code, "invalid_request", "the R Find and Replace key diagnostic changed")
if (!grepl("choose a new output column", text_cleanup_table_key_error$message, fixed = TRUE)) {
  stop("R Find and Replace did not explain how to preserve a data.table key", call. = FALSE)
}
text_cleanup_table_derived <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_table_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-table-derived",
      "r:c:0",
      "primary_key",
      new_column = "normalized key",
      find = "B",
      replacement = "b",
      regex = FALSE
    ),
    page = page_window()
  )
)
assert_identical(text_cleanup_table_derived$kind, "stepPreview", "derived R data.table Find and Replace did not preview")
assert_identical(
  text_cleanup_table_derived$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "derived R Find and Replace lost the data.table key"
)
text_cleanup_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_table_session_id, revision = 1L, page = page_window())
)
assign("text_cleanup_table", source_environment$text_cleanup_table, envir = .GlobalEnv)
eval(parse(text = text_cleanup_table_apply$code), envir = .GlobalEnv)
text_cleanup_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(data.table::key(text_cleanup_table_generated), "primary_key", "generated R Find and Replace lost the data.table key")
assert_identical(text_cleanup_table_generated$row_marker, text_cleanup_table_before$row_marker, "generated R Find and Replace changed row order")
assert_identical(text_cleanup_table_generated$`normalized key`, c("b", "a"), "generated R Find and Replace changed derived values")
assert_identical(
  get("text_cleanup_table", envir = .GlobalEnv, inherits = FALSE),
  text_cleanup_table_before,
  "generated R data.table Find and Replace mutated its source"
)
rm("text_cleanup_table", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(source_environment$text_cleanup_table, text_cleanup_table_before, "the R data.table text-cleanup lifecycle mutated its source")
text_cleanup_table_closed <- dispatch("closeSession", list(sessionId = text_cleanup_table_session_id))
assert_identical(text_cleanup_table_closed$kind, "closed", "the R data.table text-cleanup session did not close")

source_environment$text_failure_frame <- data.frame(
  warning_text = paste0(strrep("a", 100L), "b"),
  codegen_text = NA_character_,
  zero_width_text = strrep("a", 2700L),
  stringsAsFactors = FALSE
)
text_failure_before <- unserialize(serialize(source_environment$text_failure_frame, NULL, version = 3L))
text_failure_open <- dispatch(
  "openSession",
  list(sessionId = text_failure_session_id, variableName = "text_failure_frame", page = page_window())
)
assert_identical(text_failure_open$kind, "page", "the R text-failure session did not open")

text_regex_warning <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-regex-warning",
      "r:c:0",
      "warning_text",
      find = "(*LIMIT_MATCH=1)(a+)+$",
      replacement = "x",
      regex = TRUE
    ),
    page = page_window()
  )
)
assert_identical(text_regex_warning$kind, "error", "an R regex resource warning silently produced a draft")
assert_identical(text_regex_warning$code, "invalid_request", "an R regex resource warning was not an invalid request")
assert_identical(text_regex_warning$recoverable, TRUE, "an R regex resource warning was not recoverable")
assert_identical(
  text_regex_warning$message,
  "Find and Replace could not apply the requested regular expression",
  "the R regex resource warning exposed engine details"
)

text_oversized_output <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-oversized-output",
      "r:c:0",
      "warning_text",
      find = "",
      replacement = strrep("x", 100L),
      regex = FALSE
    ),
    page = page_window()
  )
)
assert_identical(text_oversized_output$kind, "error", "R Find and Replace accepted an oversized created value")
assert_identical(text_oversized_output$code, "invalid_request", "an oversized created value was treated as an unsupported frame")
assert_identical(text_oversized_output$recoverable, TRUE, "an oversized created value was not recoverable")
assert_identical(
  text_oversized_output$message,
  "Find and Replace would produce text longer than 8192 UTF-8 bytes",
  "the oversized R text diagnostic changed"
)

text_zero_width_output <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-zero-width-output",
      "r:c:2",
      "zero_width_text",
      find = "(?=(a+))",
      replacement = "\\1",
      regex = TRUE
    ),
    page = page_window()
  )
)
assert_identical(text_zero_width_output$kind, "error", "a zero-width captured backreference allocated an oversized R draft")
assert_identical(text_zero_width_output$code, "invalid_request", "a zero-width captured backreference returned the wrong diagnostic")
assert_identical(text_zero_width_output$recoverable, TRUE, "a zero-width captured backreference was not recoverable")
assert_identical(
  text_zero_width_output$message,
  "Find and Replace would produce text longer than 8192 UTF-8 bytes",
  "the zero-width captured-backreference diagnostic changed"
)

generated_regex_warning_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-generated-regex-warning",
      "r:c:0",
      "warning_text",
      find = "(*LIMIT_MATCH=1)(z+)+$",
      replacement = "x",
      regex = TRUE
    ),
    page = page_window()
  )
)
assert_identical(generated_regex_warning_preview$kind, "stepPreview", "the safe generated-regex fixture did not preview")
generated_regex_warning_code <- generated_regex_warning_preview$code
generated_regex_warning_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_failure_session_id, revision = 1L, page = page_window())
)
assert_identical(generated_regex_warning_discard$action, "discard", "the generated-regex fixture did not discard")

generated_blank_oversize_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 2L,
    step = text_transform_step(
      "findReplace",
      "find-generated-blank-oversize",
      "r:c:1",
      "codegen_text",
      find = "",
      replacement = strrep("x", 4096L),
      regex = FALSE
    ),
    page = page_window()
  )
)
assert_identical(generated_blank_oversize_preview$kind, "stepPreview", "the missing generated-oversize fixture did not preview")
generated_blank_oversize_code <- generated_blank_oversize_preview$code
generated_blank_oversize_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_failure_session_id, revision = 3L, page = page_window())
)
assert_identical(generated_blank_oversize_discard$action, "discard", "the generated-oversize fixture did not discard")

escaped_regex_replacements <- c("\\\\1", "\\\\U", "\\\\L")
generated_escaped_regex_codes <- vector("list", length(escaped_regex_replacements))
text_failure_revision <- 4L
for (escaped_index in seq_along(escaped_regex_replacements)) {
  escaped_preview <- dispatch(
    "previewStep",
    list(
      sessionId = text_failure_session_id,
      revision = text_failure_revision,
      step = text_transform_step(
        "findReplace",
        sprintf("find-generated-escaped-%d", escaped_index),
        "r:c:0",
        "warning_text",
        find = "(a)",
        replacement = escaped_regex_replacements[[escaped_index]],
        regex = TRUE
      ),
      page = page_window()
    )
  )
  assert_identical(escaped_preview$kind, "stepPreview", "an escaped literal R regex replacement was rejected")
  generated_escaped_regex_codes[[escaped_index]] <- escaped_preview$code
  escaped_discard <- dispatch(
    "discardDraft",
    list(sessionId = text_failure_session_id, revision = text_failure_revision + 1L, page = page_window())
  )
  assert_identical(escaped_discard$action, "discard", "an escaped literal R regex draft did not discard")
  text_failure_revision <- text_failure_revision + 2L
}

generated_zero_width_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = text_failure_revision,
    step = text_transform_step(
      "findReplace",
      "find-generated-zero-width",
      "r:c:1",
      "codegen_text",
      find = "(?=(a+))",
      replacement = "\\1",
      regex = TRUE
    ),
    page = page_window()
  )
)
assert_identical(generated_zero_width_preview$kind, "stepPreview", "the missing zero-width generated fixture did not preview")
generated_zero_width_code <- generated_zero_width_preview$code
generated_zero_width_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_failure_session_id, revision = text_failure_revision + 1L, page = page_window())
)
assert_identical(generated_zero_width_discard$action, "discard", "the zero-width generated fixture did not discard")
text_failure_closed <- dispatch("closeSession", list(sessionId = text_failure_session_id))
assert_identical(text_failure_closed$kind, "closed", "the R text-failure session did not close")
assert_identical(source_environment$text_failure_frame, text_failure_before, "failed R text transforms mutated their source")

generated_regex_warning_source <- data.frame(
  warning_text = paste0(strrep("z", 100L), "q"),
  codegen_text = NA_character_,
  zero_width_text = "safe",
  stringsAsFactors = FALSE
)
generated_regex_warning_before <- unserialize(serialize(generated_regex_warning_source, NULL, version = 3L))
assign("text_failure_frame", generated_regex_warning_source, envir = .GlobalEnv)
generated_regex_warning_error <- tryCatch(
  withCallingHandlers(
    {
      eval(parse(text = generated_regex_warning_code), envir = .GlobalEnv)
      NULL
    },
    warning = function(warning) stop("a raw generated regex warning escaped", call. = FALSE)
  ),
  error = identity
)
assert_identical(
  conditionMessage(generated_regex_warning_error),
  "Open Wrangler Find and Replace could not apply the requested regular expression",
  "generated R code did not sanitize a regex resource warning"
)
assert_identical(
  get("text_failure_frame", envir = .GlobalEnv, inherits = FALSE),
  generated_regex_warning_before,
  "failed generated regex code mutated its source"
)
rm("text_failure_frame", envir = .GlobalEnv)
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}

generated_blank_oversize_source <- data.frame(
  warning_text = "safe",
  codegen_text = "a",
  zero_width_text = "safe",
  stringsAsFactors = FALSE
)
generated_blank_oversize_before <- unserialize(serialize(generated_blank_oversize_source, NULL, version = 3L))
assign("text_failure_frame", generated_blank_oversize_source, envir = .GlobalEnv)
generated_blank_oversize_error <- tryCatch(
  {
    eval(parse(text = generated_blank_oversize_code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(generated_blank_oversize_error),
  "Open Wrangler Find and Replace would produce text longer than 8192 UTF-8 bytes",
  "generated R code did not reject blank-find expansion before replacement"
)
assert_identical(
  get("text_failure_frame", envir = .GlobalEnv, inherits = FALSE),
  generated_blank_oversize_before,
  "failed generated blank-find code mutated its source"
)
rm("text_failure_frame", envir = .GlobalEnv)
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}

escaped_regex_outputs <- c("\\1", "\\U", "\\L")
for (escaped_index in seq_along(generated_escaped_regex_codes)) {
  generated_escaped_source <- data.frame(
    warning_text = strrep("a", 4000L),
    codegen_text = NA_character_,
    zero_width_text = "safe",
    stringsAsFactors = FALSE
  )
  generated_escaped_before <- unserialize(serialize(generated_escaped_source, NULL, version = 3L))
  assign("text_failure_frame", generated_escaped_source, envir = .GlobalEnv)
  eval(parse(text = generated_escaped_regex_codes[[escaped_index]]), envir = .GlobalEnv)
  generated_escaped_result <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_identical(
    generated_escaped_result$warning_text,
    strrep(escaped_regex_outputs[[escaped_index]], 4000L),
    "generated R code misclassified an escaped literal backreference or case directive"
  )
  assert_identical(
    as.integer(nchar(generated_escaped_result$warning_text, type = "bytes")),
    8000L,
    "generated R code changed an escaped literal replacement's byte length"
  )
  assert_identical(
    get("text_failure_frame", envir = .GlobalEnv, inherits = FALSE),
    generated_escaped_before,
    "generated escaped-literal R code mutated its source"
  )
  rm("text_failure_frame", "open_wrangler_result", envir = .GlobalEnv)
}

generated_zero_width_source <- data.frame(
  warning_text = "safe",
  codegen_text = strrep("a", 2700L),
  zero_width_text = "safe",
  stringsAsFactors = FALSE
)
generated_zero_width_before <- unserialize(serialize(generated_zero_width_source, NULL, version = 3L))
assign("text_failure_frame", generated_zero_width_source, envir = .GlobalEnv)
generated_zero_width_error <- tryCatch(
  {
    eval(parse(text = generated_zero_width_code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(generated_zero_width_error),
  "Open Wrangler Find and Replace would produce text longer than 8192 UTF-8 bytes",
  "generated R code did not preflight a zero-width captured backreference"
)
assert_identical(
  get("text_failure_frame", envir = .GlobalEnv, inherits = FALSE),
  generated_zero_width_before,
  "failed generated zero-width R code mutated its source"
)
rm("text_failure_frame", envir = .GlobalEnv)
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}

source_environment$fill_frame <- data.frame(
  amount = c(1L, NA_integer_, 3L),
  label = ordered(c("high", NA, "low"), levels = c("low", "high")),
  instant = as.POSIXct(c("2026-03-28 12:00:00", NA, "2026-03-30 12:00:00"), tz = "UTC"),
  row.names = c("fill-a", "fill-b", "fill-c")
)
fill_source_before <- unserialize(serialize(source_environment$fill_frame, NULL, version = 3L))
fill_step <- function(id, column_id, column_name, replacement) {
  list(
    id = id,
    kind = "fillMissingValues",
    params = list(column = list(id = column_id, name = column_name), replacement = replacement)
  )
}
fill_open <- dispatch(
  "openSession",
  list(sessionId = fill_session_id, variableName = "fill_frame", page = page_window())
)
assert_identical(fill_open$kind, "page", "the R Fill Missing Values session did not open")

fill_malformed <- dispatch(
  "previewStep",
  list(
    sessionId = fill_session_id,
    revision = 0L,
    step = fill_step("fill-malformed", "r:c:0", "amount", list(kind = "median", value = "1")),
    page = page_window()
  )
)
assert_identical(fill_malformed$kind, "error", "R Fill Missing Values accepted a malformed replacement")
assert_identical(fill_malformed$code, "invalid_request", "the malformed fill replacement diagnostic changed")

fill_oversized <- dispatch(
  "previewStep",
  list(
    sessionId = fill_session_id,
    revision = 0L,
    step = fill_step("fill-oversized", "r:c:1", "label", list(kind = "string", value = strrep("x", 8193L))),
    page = page_window()
  )
)
assert_identical(fill_oversized$kind, "error", "R Fill Missing Values accepted oversized replacement text")
assert_identical(fill_oversized$code, "invalid_request", "the oversized fill replacement diagnostic changed")

fill_amount_preview <- dispatch(
  "previewStep",
  list(
    sessionId = fill_session_id,
    revision = 0L,
    step = fill_step("fill-amount", "r:c:0", "amount", list(kind = "median")),
    page = page_window()
  )
)
assert_identical(fill_amount_preview$kind, "stepPreview", "R Fill Missing Values did not preview")
assert_identical(fill_amount_preview$page$schema[[1L]]$nullable, FALSE, "R Fill Missing Values kept a filled column nullable")
assert_identical(fill_amount_preview$diff$changedCells, 1L, "R Fill Missing Values returned an inexact numeric diff")
assert_identical(fill_amount_preview$diff$cells[[1L]]$before$kind, "null", "the fill diff lost the missing input")
assert_identical(fill_amount_preview$diff$cells[[1L]]$after$raw, "2", "the fill diff lost the median output")
fill_amount_apply <- dispatch(
  "applyDraft",
  list(sessionId = fill_session_id, revision = 1L, page = page_window())
)
assert_identical(fill_amount_apply$action, "apply", "R Fill Missing Values did not apply")

fill_label_preview <- dispatch(
  "previewStep",
  list(
    sessionId = fill_session_id,
    revision = 2L,
    step = fill_step("fill-label", "r:c:1", "label", list(kind = "string", value = "unknown")),
    page = page_window()
  )
)
assert_identical(fill_label_preview$kind, "stepPreview", "R factor Fill Missing Values did not preview")
assert_identical(fill_label_preview$page$schema[[2L]]$nullable, FALSE, "R factor Fill Missing Values stayed nullable")
assert_identical(fill_label_preview$diff$changedCells, 1L, "R factor Fill Missing Values returned an inexact diff")
fill_label_apply <- dispatch(
  "applyDraft",
  list(sessionId = fill_session_id, revision = 3L, page = page_window())
)
assert_identical(fill_label_apply$action, "apply", "R factor Fill Missing Values did not apply")
if (!grepl(".ow_fill_values", fill_label_apply$code, fixed = TRUE)) {
  stop("generated R Fill Missing Values lost its native helper", call. = FALSE)
}
assign("fill_frame", source_environment$fill_frame, envir = .GlobalEnv)
eval(parse(text = fill_label_apply$code), envir = .GlobalEnv)
fill_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(fill_generated$amount, c(1L, 2L, 3L), "generated R Fill Missing Values changed the numeric result")
assert_identical(
  fill_generated$label,
  ordered(c("high", "unknown", "low"), levels = c("low", "high", "unknown")),
  "generated R Fill Missing Values changed the factor result"
)
assert_identical(row.names(fill_generated), row.names(fill_source_before), "generated R Fill Missing Values changed row names")
assert_identical(
  get("fill_frame", envir = .GlobalEnv, inherits = FALSE),
  fill_source_before,
  "generated R Fill Missing Values mutated its source"
)
rm("fill_frame", "open_wrangler_result", envir = .GlobalEnv)

fill_noop_preview <- dispatch(
  "previewStep",
  list(
    sessionId = fill_session_id,
    revision = 4L,
    step = fill_step("fill-label-noop", "r:c:1", "label", list(kind = "string", value = "unused")),
    page = page_window()
  )
)
assert_identical(fill_noop_preview$kind, "stepPreview", "R factor Fill Missing Values could not preview a no-op")
assert_identical(fill_noop_preview$diff$changedCells, 0L, "R factor no-op reported changed cells")
assert_identical(
  unlist(fill_noop_preview$page$schema[[2L]]$semantics$levels, use.names = FALSE),
  c("low", "high", "unknown"),
  "R factor no-op appended an unused level"
)
assign("fill_frame", source_environment$fill_frame, envir = .GlobalEnv)
eval(parse(text = fill_noop_preview$code), envir = .GlobalEnv)
fill_noop_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  levels(fill_noop_generated$label),
  c("low", "high", "unknown"),
  "generated R factor no-op appended an unused level"
)
rm("fill_frame", "open_wrangler_result", envir = .GlobalEnv)
fill_noop_discard <- dispatch(
  "discardDraft",
  list(sessionId = fill_session_id, revision = 5L, page = page_window())
)
assert_identical(fill_noop_discard$action, "discard", "R factor no-op draft did not discard")

fill_datetime_preview <- dispatch(
  "previewStep",
  list(
    sessionId = fill_session_id,
    revision = 6L,
    step = fill_step(
      "fill-datetime",
      "r:c:2",
      "instant",
      list(kind = "datetime", value = "2026-03-29T02:30:00")
    ),
    page = page_window()
  )
)
assert_identical(fill_datetime_preview$kind, "stepPreview", "R datetime Fill Missing Values did not preview in UTC")
generated_dst_source <- fill_source_before
attr(generated_dst_source$instant, "tzone") <- "Europe/Berlin"
assign("fill_frame", generated_dst_source, envir = .GlobalEnv)
generated_dst_error <- tryCatch(
  {
    eval(parse(text = fill_datetime_preview$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (
  is.null(generated_dst_error) ||
    !grepl("invalid local datetime in Europe/Berlin", conditionMessage(generated_dst_error), fixed = TRUE)
) {
  stop("generated R Fill Missing Values reused a stale timezone or normalized a DST gap", call. = FALSE)
}
assert_identical(
  get("fill_frame", envir = .GlobalEnv, inherits = FALSE),
  generated_dst_source,
  "the generated R datetime guard mutated its source"
)
rm("fill_frame", envir = .GlobalEnv)
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}
fill_datetime_discard <- dispatch(
  "discardDraft",
  list(sessionId = fill_session_id, revision = 7L, page = page_window())
)
assert_identical(fill_datetime_discard$action, "discard", "R datetime fill draft did not discard")

fill_inspection <- inspect_step(fill_session_id, 8L, "fill-label", page_window())
assert_identical(fill_inspection$kind, "stepInspection", "applied R Fill Missing Values was not inspectable")
assert_identical(fill_inspection$diff$changedCells, 1L, "R Fill Missing Values inspection lost its diff")
fill_undo <- dispatch(
  "undoStep",
  list(sessionId = fill_session_id, revision = 8L, page = page_window())
)
assert_identical(fill_undo$action, "undo", "R Fill Missing Values did not undo")
assert_identical(fill_undo$page$schema[[2L]]$nullable, TRUE, "undo did not restore R factor nullability")
assert_identical(source_environment$fill_frame, fill_source_before, "the R Fill Missing Values lifecycle mutated its source")
fill_closed <- dispatch("closeSession", list(sessionId = fill_session_id))
assert_identical(fill_closed$kind, "closed", "the R Fill Missing Values session did not close")

source_environment$mean_fill_frame <- data.frame(
  value = c(1e308, NA_real_, NaN, 1e308),
  row.names = c("mean-a", "mean-b", "mean-c", "mean-d")
)
mean_fill_before <- unserialize(serialize(source_environment$mean_fill_frame, NULL, version = 3L))
mean_fill_open <- dispatch(
  "openSession",
  list(sessionId = mean_fill_session_id, variableName = "mean_fill_frame", page = page_window())
)
assert_identical(mean_fill_open$kind, "page", "the R mean-fill session did not open")
mean_fill_preview <- dispatch(
  "previewStep",
  list(
    sessionId = mean_fill_session_id,
    revision = 0L,
    step = fill_step("fill-mean", "r:c:0", "value", list(kind = "mean")),
    page = page_window()
  )
)
assert_identical(mean_fill_preview$kind, "stepPreview", "R mean fill did not preview")
assert_identical(mean_fill_preview$diff$changedCells, 2L, "R mean fill returned an inexact diff")
assert_identical(mean_fill_preview$page$schema[[1L]]$nullable, FALSE, "R mean fill stayed nullable")
mean_fill_apply <- dispatch(
  "applyDraft",
  list(sessionId = mean_fill_session_id, revision = 1L, page = page_window())
)
assert_identical(mean_fill_apply$action, "apply", "R mean fill did not apply")
if (!grepl("mean(.ow_present / .ow_scale)", mean_fill_apply$code, fixed = TRUE)) {
  stop("generated R mean fill lost its native calculation", call. = FALSE)
}
assign("mean_fill_frame", source_environment$mean_fill_frame, envir = .GlobalEnv)
eval(parse(text = mean_fill_apply$code), envir = .GlobalEnv)
mean_fill_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
if (!all(is.finite(mean_fill_generated$value))) {
  stop("generated R mean fill overflowed a finite mean", call. = FALSE)
}
if (!all(mean_fill_generated$value == 1e308)) {
  stop("generated R mean fill changed the result", call. = FALSE)
}
assert_identical(class(mean_fill_generated), "data.frame", "generated R mean fill changed the frame class")
assert_identical(row.names(mean_fill_generated), row.names(mean_fill_before), "generated R mean fill changed row names")
assert_identical(
  get("mean_fill_frame", envir = .GlobalEnv, inherits = FALSE),
  mean_fill_before,
  "generated R mean fill mutated its source"
)
assert_identical(source_environment$mean_fill_frame, mean_fill_before, "the R mean-fill lifecycle mutated its source")
rm("mean_fill_frame", "open_wrangler_result", envir = .GlobalEnv)
mean_fill_closed <- dispatch("closeSession", list(sessionId = mean_fill_session_id))
assert_identical(mean_fill_closed$kind, "closed", "the R mean-fill session did not close")

source_environment$fallback_fill_frame <- data.frame(
  target_partial = ordered(c(NA, "high", NA, NA), levels = c("low", "high")),
  target_complete = ordered(c(NA, "high", NA, NA), levels = c("low", "high")),
  first = factor(c("medium", "ignored", "low", NA), levels = c("medium", "ignored", "low")),
  second = c("late", "ignored", "unused", "last"),
  row.names = paste0("fallback-", 1:4)
)
fallback_fill_before <- unserialize(serialize(source_environment$fallback_fill_frame, NULL, version = 3L))
fallback_fill_open <- dispatch(
  "openSession",
  list(sessionId = fallback_fill_session_id, variableName = "fallback_fill_frame", page = page_window())
)
assert_identical(fallback_fill_open$kind, "page", "the R fallback-fill session did not open")

fallback_fill_empty <- dispatch(
  "previewStep",
  list(
    sessionId = fallback_fill_session_id,
    revision = 0L,
    step = fill_step(
      "fallback-empty",
      "r:c:0",
      "target_partial",
      list(kind = "fallbackColumns", columns = I(list()))
    ),
    page = page_window()
  )
)
assert_identical(fallback_fill_empty$kind, "error", "R fallback fill accepted an empty fallback list")
assert_identical(fallback_fill_empty$code, "invalid_request", "the empty R fallback diagnostic changed")

fallback_fill_partial <- dispatch(
  "previewStep",
  list(
    sessionId = fallback_fill_session_id,
    revision = 0L,
    step = fill_step(
      "fallback-partial",
      "r:c:0",
      "target_partial",
      list(
        kind = "fallbackColumns",
        columns = I(list(list(id = "r:c:2", name = "first")))
      )
    ),
    page = page_window()
  )
)
assert_identical(fallback_fill_partial$kind, "stepPreview", "R fallback fill did not preview")
assert_identical(
  fallback_fill_partial$remainingMissingCells,
  1L,
  "R fallback fill returned the wrong remaining missing-value count"
)
assert_identical(
  fallback_fill_partial$page$schema[[1L]]$nullable,
  TRUE,
  "an unresolved R fallback fill was published as non-nullable"
)
assert_identical(fallback_fill_partial$diff$changedCells, 2L, "R fallback priority returned an inexact diff")
fallback_fill_partial_discard <- dispatch(
  "discardDraft",
  list(sessionId = fallback_fill_session_id, revision = 1L, page = page_window())
)
assert_identical(fallback_fill_partial_discard$action, "discard", "the partial R fallback draft did not discard")

fallback_fill_complete_step <- fill_step(
  "fallback-complete",
  "r:c:1",
  "target_complete",
  list(
    kind = "fallbackColumns",
    columns = I(list(
      list(id = "r:c:2", name = "first"),
      list(id = "r:c:3", name = "second")
    ))
  )
)
fallback_fill_complete_preview <- dispatch(
  "previewStep",
  list(
    sessionId = fallback_fill_session_id,
    revision = 2L,
    step = fallback_fill_complete_step,
    page = page_window()
  )
)
assert_identical(fallback_fill_complete_preview$kind, "stepPreview", "complete R fallback fill did not preview")
assert_identical(
  fallback_fill_complete_preview$remainingMissingCells,
  0L,
  "complete R fallback fill retained a missing target value"
)
assert_identical(
  fallback_fill_complete_preview$page$schema[[2L]]$nullable,
  FALSE,
  "a complete R fallback fill stayed nullable"
)
assert_identical(
  unlist(fallback_fill_complete_preview$page$schema[[2L]]$semantics$levels, use.names = FALSE),
  c("low", "high", "medium", "last"),
  "R fallback fill changed factor-level order"
)
assert_identical(fallback_fill_complete_preview$diff$changedCells, 3L, "complete R fallback fill returned an inexact diff")
fallback_fill_complete_apply <- dispatch(
  "applyDraft",
  list(sessionId = fallback_fill_session_id, revision = 3L, page = page_window())
)
assert_identical(fallback_fill_complete_apply$action, "apply", "complete R fallback fill did not apply")
if (!grepl(".ow_fill_from_columns", fallback_fill_complete_apply$code, fixed = TRUE)) {
  stop("generated R fallback fill lost its native helper", call. = FALSE)
}
assign("fallback_fill_frame", source_environment$fallback_fill_frame, envir = .GlobalEnv)
eval(parse(text = fallback_fill_complete_apply$code), envir = .GlobalEnv)
fallback_fill_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  fallback_fill_generated$target_complete,
  ordered(c("medium", "high", "low", "last"), levels = c("low", "high", "medium", "last")),
  "generated R fallback fill changed factor values, priority, or levels"
)
assert_identical(
  get("fallback_fill_frame", envir = .GlobalEnv, inherits = FALSE),
  fallback_fill_before,
  "generated R fallback fill mutated its source"
)
rm("open_wrangler_result", envir = .GlobalEnv)
stale_fallback_source <- fallback_fill_before
stale_fallback_source$first <- as.character(stale_fallback_source$first)
assign("fallback_fill_frame", stale_fallback_source, envir = .GlobalEnv)
stale_fallback_error <- tryCatch(
  {
    eval(parse(text = fallback_fill_complete_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
if (is.null(stale_fallback_error) || !grepl("column type is stale", conditionMessage(stale_fallback_error), fixed = TRUE)) {
  stop("generated R fallback fill accepted a stale fallback type", call. = FALSE)
}
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}
rm("fallback_fill_frame", envir = .GlobalEnv)
fallback_fill_inspection <- inspect_step(
  fallback_fill_session_id,
  4L,
  "fallback-complete",
  page_window()
)
assert_identical(fallback_fill_inspection$kind, "stepInspection", "applied R fallback fill was not inspectable")
assert_identical(fallback_fill_inspection$diff$changedCells, 3L, "R fallback inspection lost its diff")
fallback_fill_undo <- dispatch(
  "undoStep",
  list(sessionId = fallback_fill_session_id, revision = 4L, page = page_window())
)
assert_identical(fallback_fill_undo$action, "undo", "R fallback fill did not undo")
assert_identical(
  fallback_fill_undo$page$schema[[2L]]$nullable,
  TRUE,
  "undo did not restore R fallback target nullability"
)
assert_identical(
  source_environment$fallback_fill_frame,
  fallback_fill_before,
  "the R fallback-fill lifecycle mutated its source"
)
fallback_fill_closed <- dispatch("closeSession", list(sessionId = fallback_fill_session_id))
assert_identical(fallback_fill_closed$kind, "closed", "the R fallback-fill session did not close")

source_environment$directional_fill_frame <- data.frame(
  sequence = c(4L, 1L, 3L, 2L, 6L, 5L),
  target = c(NA_character_, "start", NA_character_, NA_character_, NA_character_, "end"),
  row.names = paste0("directional-", 1:6),
  check.names = FALSE
)
directional_fill_before <- unserialize(serialize(source_environment$directional_fill_frame, NULL, version = 3L))
directional_fill_open <- dispatch(
  "openSession",
  list(sessionId = directional_fill_session_id, variableName = "directional_fill_frame", page = page_window())
)
assert_identical(directional_fill_open$kind, "page", "the R directional-fill session did not open")

directional_target_order <- dispatch(
  "previewStep",
  list(
    sessionId = directional_fill_session_id,
    revision = 0L,
    step = fill_step(
      "directional-target-order",
      "r:c:1",
      "target",
      list(
        kind = "directional",
        direction = "forward",
        orderBy = I(list(list(
          column = list(id = "r:c:1", name = "target"),
          direction = "asc",
          nulls = "last"
        )))
      )
    ),
    page = page_window()
  )
)
assert_identical(directional_target_order$kind, "error", "R directional fill accepted its target as ordering input")
assert_identical(directional_target_order$code, "invalid_request", "the directional target-order diagnostic changed")

directional_malformed_orders <- list(
  list(
    label = "object-shaped ordering",
    orderBy = list(notAnArray = list(
      column = list(id = "r:c:0", name = "sequence"),
      direction = "asc",
      nulls = "last"
    ))
  ),
  list(
    label = "array-valued direction",
    orderBy = I(list(list(
      column = list(id = "r:c:0", name = "sequence"),
      direction = I(c("asc", "desc")),
      nulls = "last"
    )))
  ),
  list(
    label = "array-valued null placement",
    orderBy = I(list(list(
      column = list(id = "r:c:0", name = "sequence"),
      direction = "asc",
      nulls = I(c("last", "first"))
    )))
  )
)
for (malformed_index in seq_along(directional_malformed_orders)) {
  malformed <- directional_malformed_orders[[malformed_index]]
  malformed_result <- dispatch(
    "previewStep",
    list(
      sessionId = directional_fill_session_id,
      revision = 0L,
      step = fill_step(
        sprintf("directional-malformed-%d", malformed_index),
        "r:c:1",
        "target",
        list(
          kind = "directional",
          direction = "forward",
          orderBy = malformed$orderBy
        )
      ),
      page = page_window()
    )
  )
  assert_identical(
    malformed_result$kind,
    "error",
    sprintf("R directional fill accepted %s", malformed$label)
  )
  assert_identical(
    malformed_result$code,
    "invalid_request",
    sprintf("the %s diagnostic changed", malformed$label)
  )
}

directional_limited_preview <- dispatch(
  "previewStep",
  list(
    sessionId = directional_fill_session_id,
    revision = 0L,
    step = fill_step(
      "directional-limited",
      "r:c:1",
      "target",
      list(
        kind = "directional",
        direction = "forward",
        orderBy = I(list(list(
          column = list(id = "r:c:0", name = "sequence"),
          direction = "asc",
          nulls = "last"
        ))),
        maxGap = 2L
      )
    ),
    page = page_window()
  )
)
assert_identical(directional_limited_preview$kind, "stepPreview", "R bounded directional fill did not preview")
assert_identical(
  directional_limited_preview$diff$changedCells,
  1L,
  "R maxGap partially filled a run exceeding the whole-run threshold"
)
assert_identical(
  directional_limited_preview$page$schema[[2L]]$nullable,
  TRUE,
  "R directional fill published optimistic nullability"
)
directional_limited_discard <- dispatch(
  "discardDraft",
  list(sessionId = directional_fill_session_id, revision = 1L, page = page_window())
)
assert_identical(directional_limited_discard$action, "discard", "the bounded directional draft did not discard")

directional_complete_preview <- dispatch(
  "previewStep",
  list(
    sessionId = directional_fill_session_id,
    revision = 2L,
    step = fill_step(
      "directional-complete",
      "r:c:1",
      "target",
      list(
        kind = "directional",
        direction = "forward",
        orderBy = I(list(list(
          column = list(id = "r:c:0", name = "sequence"),
          direction = "asc",
          nulls = "last"
        )))
      )
    ),
    page = page_window()
  )
)
assert_identical(directional_complete_preview$kind, "stepPreview", "R directional fill did not preview")
assert_identical(directional_complete_preview$diff$changedCells, 4L, "R directional fill returned an inexact diff")
assert_identical(
  directional_complete_preview$page$schema[[2L]]$nullable,
  TRUE,
  "R directional fill did not retain conservative nullability"
)
directional_complete_apply <- dispatch(
  "applyDraft",
  list(sessionId = directional_fill_session_id, revision = 3L, page = page_window())
)
assert_identical(directional_complete_apply$action, "apply", "R directional fill did not apply")
if (!grepl(".ow_fill_directional", directional_complete_apply$code, fixed = TRUE)) {
  stop("generated R directional fill lost its native helper", call. = FALSE)
}
assign("directional_fill_frame", source_environment$directional_fill_frame, envir = .GlobalEnv)
eval(parse(text = directional_complete_apply$code), envir = .GlobalEnv)
directional_fill_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  directional_fill_generated$target,
  c("start", "start", "start", "start", "end", "end"),
  "generated R directional fill changed explicit ordering or source row order"
)
assert_identical(
  row.names(directional_fill_generated),
  row.names(directional_fill_before),
  "generated R directional fill changed row names"
)
assert_identical(
  get("directional_fill_frame", envir = .GlobalEnv, inherits = FALSE),
  directional_fill_before,
  "generated R directional fill mutated its source"
)
assert_identical(
  source_environment$directional_fill_frame,
  directional_fill_before,
  "the R directional-fill lifecycle mutated its source"
)
rm("directional_fill_frame", "open_wrangler_result", envir = .GlobalEnv)
directional_fill_closed <- dispatch("closeSession", list(sessionId = directional_fill_session_id))
assert_identical(directional_fill_closed$kind, "closed", "the R directional-fill session did not close")

source_environment$linear_fill_frame <- data.frame(
  coordinate = c(12, 0, 5, 20, 8, 30, 3),
  target = c(NA_real_, 0, NaN, Inf, 80, NA_real_, NA_real_),
  row.names = paste0("linear-", 1:7),
  check.names = FALSE
)
linear_fill_before <- unserialize(serialize(source_environment$linear_fill_frame, NULL, version = 3L))
linear_fill_open <- dispatch(
  "openSession",
  list(sessionId = linear_fill_session_id, variableName = "linear_fill_frame", page = page_window())
)
assert_identical(linear_fill_open$kind, "page", "the R linear-interpolation session did not open")

linear_target_coordinate <- dispatch(
  "previewStep",
  list(
    sessionId = linear_fill_session_id,
    revision = 0L,
    step = fill_step(
      "linear-target-coordinate",
      "r:c:1",
      "target",
      list(kind = "linearInterpolation", coordinate = list(id = "r:c:1", name = "target"))
    ),
    page = page_window()
  )
)
assert_identical(linear_target_coordinate$kind, "error", "R linear interpolation accepted its target as coordinate")
assert_identical(linear_target_coordinate$code, "invalid_request", "the linear target-coordinate diagnostic changed")

linear_limited_preview <- dispatch(
  "previewStep",
  list(
    sessionId = linear_fill_session_id,
    revision = 0L,
    step = fill_step(
      "linear-limited",
      "r:c:1",
      "target",
      list(
        kind = "linearInterpolation",
        coordinate = list(id = "r:c:0", name = "coordinate"),
        maxGap = 1L
      )
    ),
    page = page_window()
  )
)
assert_identical(linear_limited_preview$kind, "stepPreview", "bounded R linear interpolation did not preview")
assert_identical(linear_limited_preview$diff$changedCells, 0L, "R maxGap partially interpolated an oversized run")
assert_identical(
  linear_limited_preview$page$schema[[2L]]$nullable,
  TRUE,
  "R linear interpolation published optimistic nullability"
)
linear_limited_discard <- dispatch(
  "discardDraft",
  list(sessionId = linear_fill_session_id, revision = 1L, page = page_window())
)
assert_identical(linear_limited_discard$action, "discard", "the bounded linear interpolation draft did not discard")

linear_complete_preview <- dispatch(
  "previewStep",
  list(
    sessionId = linear_fill_session_id,
    revision = 2L,
    step = fill_step(
      "linear-complete",
      "r:c:1",
      "target",
      list(kind = "linearInterpolation", coordinate = list(id = "r:c:0", name = "coordinate"))
    ),
    page = page_window()
  )
)
assert_identical(linear_complete_preview$kind, "stepPreview", "R linear interpolation did not preview")
assert_identical(linear_complete_preview$diff$changedCells, 2L, "R linear interpolation returned an inexact diff")
linear_complete_apply <- dispatch(
  "applyDraft",
  list(sessionId = linear_fill_session_id, revision = 3L, page = page_window())
)
assert_identical(linear_complete_apply$action, "apply", "R linear interpolation did not apply")
if (!grepl(".ow_fill_linear", linear_complete_apply$code, fixed = TRUE)) {
  stop("generated R linear interpolation lost its native helper", call. = FALSE)
}
linear_generated_flavors <- list(
  data.frame(coordinate = c(12, 0, 5, 20, 8, 30, 3), target = c(NA_real_, 0, NaN, Inf, 80, NA_real_, NA_real_), check.names = FALSE),
  tibble::tibble(coordinate = c(12, 0, 5, 20, 8, 30, 3), target = c(NA_real_, 0, NaN, Inf, 80, NA_real_, NA_real_)),
  data.table::data.table(coordinate = c(12, 0, 5, 20, 8, 30, 3), target = c(NA_real_, 0, NaN, Inf, 80, NA_real_, NA_real_)),
  collapse::qDF(data.frame(coordinate = c(12, 0, 5, 20, 8, 30, 3), target = c(NA_real_, 0, NaN, Inf, 80, NA_real_, NA_real_))),
  collapse::qTBL(data.frame(coordinate = c(12, 0, 5, 20, 8, 30, 3), target = c(NA_real_, 0, NaN, Inf, 80, NA_real_, NA_real_))),
  collapse::qDT(data.frame(coordinate = c(12, 0, 5, 20, 8, 30, 3), target = c(NA_real_, 0, NaN, Inf, 80, NA_real_, NA_real_)))
)
for (linear_source in linear_generated_flavors) {
  if (inherits(linear_source, "data.table")) data.table::setkey(linear_source, coordinate)
  linear_source_before <- if (inherits(linear_source, "data.table")) {
    data.table::copy(linear_source)
  } else {
    unserialize(serialize(linear_source, NULL, version = 3L))
  }
  assign("linear_fill_frame", linear_source, envir = .GlobalEnv)
  eval(parse(text = linear_complete_apply$code), envir = .GlobalEnv)
  linear_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_identical(class(linear_generated), class(linear_source), "generated interpolation changed R dataframe flavor")
  expected_linear_target <- unname(c(
    `0` = 0,
    `3` = 30,
    `5` = 50,
    `8` = 80,
    `12` = NA_real_,
    `20` = Inf,
    `30` = NA_real_
  )[as.character(linear_source$coordinate)])
  assert_identical(
    linear_generated$target,
    expected_linear_target,
    "generated R linear interpolation changed coordinate-distance behavior"
  )
  assert_identical(typeof(linear_generated$target), "double", "generated interpolation changed target storage")
  if (inherits(linear_source, "data.table")) {
    assert_identical(data.table::key(linear_generated), "coordinate", "generated interpolation dropped a data.table key")
  }
  assert_identical(
    get("linear_fill_frame", envir = .GlobalEnv, inherits = FALSE),
    linear_source_before,
    "generated R linear interpolation mutated its source"
  )
  rm("linear_fill_frame", "open_wrangler_result", envir = .GlobalEnv)
}
linear_huge_source <- data.frame(
  coordinate = c(-.Machine$double.xmax, 0, .Machine$double.xmax),
  target = c(.Machine$double.xmax, NA_real_, -.Machine$double.xmax)
)
linear_huge_before <- unserialize(serialize(linear_huge_source, NULL, version = 3L))
assign("linear_fill_frame", linear_huge_source, envir = .GlobalEnv)
eval(parse(text = linear_complete_apply$code), envir = .GlobalEnv)
linear_huge_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  linear_huge_generated$target,
  c(.Machine$double.xmax, 0, -.Machine$double.xmax),
  "generated R interpolation overflowed finite opposite-sign endpoints"
)
assert_identical(typeof(linear_huge_generated$target), "double", "generated interpolation changed target storage")
assert_identical(
  get("linear_fill_frame", envir = .GlobalEnv, inherits = FALSE),
  linear_huge_before,
  "generated extreme interpolation mutated its source"
)
rm("linear_fill_frame", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(
  source_environment$linear_fill_frame,
  linear_fill_before,
  "the R linear-interpolation lifecycle mutated its source"
)
linear_fill_closed <- dispatch("closeSession", list(sessionId = linear_fill_session_id))
assert_identical(linear_fill_closed$kind, "closed", "the R linear-interpolation session did not close")

source_environment$grouped_fill_frame <- data.frame(
  group = c(NA_real_, NaN, 1, 1, 2, 2, 3, 3, 3, 4, 4),
  wide = bit64::as.integer64(c(
    "9007199254740993", "9007199254740993", "9007199254740994", "9007199254740994",
    "9007199254740995", "9007199254740995", "9007199254740996", "9007199254740996", "9007199254740996",
    "9007199254740997", "9007199254740997"
  )),
  day = as.Date(rep("2026-01-01", 11L)),
  target = c(2, NA, 4, NaN, Inf, NA, Inf, -Inf, NA, 2^-1074, NA),
  row.names = paste0("grouped-", 1:11),
  check.names = FALSE
)
grouped_fill_before <- unserialize(serialize(source_environment$grouped_fill_frame, NULL, version = 3L))
grouped_fill_open <- dispatch(
  "openSession",
  list(sessionId = grouped_fill_session_id, variableName = "grouped_fill_frame", page = page_window())
)
assert_identical(grouped_fill_open$kind, "page", "the R grouped-fill session did not open")

grouped_malformed_replacements <- list(
  list(kind = "groupedStatistic", statistic = "mean", keys = list()),
  list(
    kind = "groupedStatistic",
    statistic = "mean",
    keys = list(list(id = "r:c:0", name = "group"), list(id = "r:c:0", name = "group"))
  ),
  list(kind = "groupedStatistic", statistic = "mean", keys = list(list(id = "r:c:3", name = "target"))),
  list(kind = "groupedStatistic", statistic = "sum", keys = list(list(id = "r:c:0", name = "group")))
)
for (malformed_index in seq_along(grouped_malformed_replacements)) {
  grouped_malformed <- dispatch(
    "previewStep",
    list(
      sessionId = grouped_fill_session_id,
      revision = 0L,
      step = fill_step(
        sprintf("grouped-malformed-%d", malformed_index),
        "r:c:3",
        "target",
        grouped_malformed_replacements[[malformed_index]]
      ),
      page = page_window()
    )
  )
  assert_identical(grouped_malformed$kind, "error", "R grouped fill accepted a malformed replacement")
  assert_identical(grouped_malformed$code, "invalid_request", "the malformed grouped-fill diagnostic changed")
}

grouped_fill_preview <- dispatch(
  "previewStep",
  list(
    sessionId = grouped_fill_session_id,
    revision = 0L,
    step = fill_step(
      "grouped-mean",
      "r:c:3",
      "target",
      list(
        kind = "groupedStatistic",
        statistic = "mean",
        keys = list(
          list(id = "r:c:0", name = "group"),
          list(id = "r:c:1", name = "wide"),
          list(id = "r:c:2", name = "day")
        )
      )
    ),
    page = page_window()
  )
)
assert_identical(grouped_fill_preview$kind, "stepPreview", "R grouped fill did not preview")
assert_identical(grouped_fill_preview$diff$changedCells, 4L, "R grouped fill returned an inexact diff")
assert_identical(
  grouped_fill_preview$page$schema[[4L]]$nullable,
  TRUE,
  "R grouped fill published optimistic nullability"
)
grouped_fill_apply <- dispatch(
  "applyDraft",
  list(sessionId = grouped_fill_session_id, revision = 1L, page = page_window())
)
assert_identical(grouped_fill_apply$action, "apply", "R grouped fill did not apply")
if (!grepl(".ow_fill_grouped", grouped_fill_apply$code, fixed = TRUE)) {
  stop("generated R grouped fill lost its native helper", call. = FALSE)
}
assign("grouped_fill_frame", source_environment$grouped_fill_frame, envir = .GlobalEnv)
eval(parse(text = grouped_fill_apply$code), envir = .GlobalEnv)
grouped_fill_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  grouped_fill_generated$target,
  c(2, 2, 4, 4, Inf, Inf, Inf, -Inf, NA, 2^-1074, 2^-1074),
  "generated R grouped fill changed grouped values"
)
assert_identical(row.names(grouped_fill_generated), row.names(grouped_fill_before), "generated grouped fill changed row names")
assert_identical(
  get("grouped_fill_frame", envir = .GlobalEnv, inherits = FALSE),
  grouped_fill_before,
  "generated R grouped fill mutated its source"
)
assert_identical(
  source_environment$grouped_fill_frame,
  grouped_fill_before,
  "the R grouped-fill lifecycle mutated its source"
)
rm("grouped_fill_frame", "open_wrangler_result", envir = .GlobalEnv)
grouped_fill_closed <- dispatch("closeSession", list(sessionId = grouped_fill_session_id))
assert_identical(grouped_fill_closed$kind, "closed", "the R grouped-fill session did not close")

assert_grouped_generated_case <- function(
  case_session_id,
  variable_name,
  source,
  statistic,
  assert_result
) {
  source_environment[[variable_name]] <- source
  before <- if (inherits(source, "data.table")) {
    data.table::copy(source_environment[[variable_name]])
  } else {
    unserialize(serialize(source, NULL, version = 3L))
  }
  opened <- dispatch(
    "openSession",
    list(sessionId = case_session_id, variableName = variable_name, page = page_window())
  )
  assert_identical(opened$kind, "page", sprintf("the %s grouped-fill session did not open", variable_name))
  preview <- dispatch(
    "previewStep",
    list(
      sessionId = case_session_id,
      revision = 0L,
      step = fill_step(
        paste0("grouped-", variable_name),
        "r:c:1",
        "target",
        list(
          kind = "groupedStatistic",
          statistic = statistic,
          keys = list(list(id = "r:c:0", name = "group"))
        )
      ),
      page = page_window()
    )
  )
  assert_identical(preview$kind, "stepPreview", sprintf("the %s grouped fill did not preview", variable_name))
  applied <- dispatch(
    "applyDraft",
    list(sessionId = case_session_id, revision = 1L, page = page_window())
  )
  assert_identical(applied$action, "apply", sprintf("the %s grouped fill did not apply", variable_name))
  if (!grepl(".ow_fill_grouped", applied$code, fixed = TRUE)) {
    stop(sprintf("generated %s grouped fill lost its native helper", variable_name), call. = FALSE)
  }
  assign(variable_name, source_environment[[variable_name]], envir = .GlobalEnv)
  eval(parse(text = applied$code), envir = .GlobalEnv)
  result <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_result(result)
  assert_identical(
    get(variable_name, envir = .GlobalEnv, inherits = FALSE),
    before,
    sprintf("generated %s grouped fill mutated its source", variable_name)
  )
  assert_identical(
    source_environment[[variable_name]],
    before,
    sprintf("the %s grouped-fill lifecycle mutated its source", variable_name)
  )
  rm(list = c(variable_name, "open_wrangler_result"), envir = .GlobalEnv)
  closed <- dispatch("closeSession", list(sessionId = case_session_id))
  assert_identical(closed$kind, "closed", sprintf("the %s grouped-fill session did not close", variable_name))
  rm(list = variable_name, envir = source_environment)
}

if (requireNamespace("bit64", quietly = TRUE)) {
  assert_grouped_generated_case(
    grouped_wide_session_id,
    "grouped_wide_frame",
    data.frame(
      group = c("a", "a", "a"),
      target = bit64::as.integer64(c("9007199254740993", "9007199254740995", NA)),
      check.names = FALSE
    ),
    "median",
    function(result) {
      assert_identical(class(result$target), "integer64", "generated grouped integer64 median changed type")
      assert_identical(
        as.character(result$target),
        c("9007199254740993", "9007199254740995", "9007199254740994"),
        "generated grouped integer64 median lost precision"
      )
    }
  )
}

assert_grouped_generated_case(
  grouped_float_session_id,
  "grouped_float_frame",
  data.frame(
    group = c("odd", "odd", "even", "even", "even", "infinite", "infinite", "infinite"),
    target = c(
      2^-1074,
      NA_real_,
      .Machine$double.xmax / 2,
      .Machine$double.xmax,
      NA_real_,
      -Inf,
      Inf,
      NA_real_
    ),
    check.names = FALSE
  ),
  "median",
  function(result) {
    expected_midpoint <- (.Machine$double.xmax / 2) +
      ((.Machine$double.xmax - (.Machine$double.xmax / 2)) / 2)
    assert_identical(
      result$target,
      c(
        2^-1074,
        2^-1074,
        .Machine$double.xmax / 2,
        .Machine$double.xmax,
        expected_midpoint,
        -Inf,
        Inf,
        NA_real_
      ),
      "generated grouped double median changed an exact, safe, or unresolved result"
    )
  }
)

assert_grouped_generated_case(
  grouped_factor_session_id,
  "grouped_factor_frame",
  data.frame(
    group = c("a", "a", "a", "b", "b", "b"),
    target = factor(c("x", "x", NA, "x", "y", NA), levels = c("x", "y", "unused")),
    check.names = FALSE
  ),
  "mostFrequent",
  function(result) {
    assert_identical(class(result$target), "factor", "generated grouped factor mode changed type")
    assert_identical(
      as.character(result$target),
      c("x", "x", "x", "x", "y", NA_character_),
      "generated grouped factor mode filled a tied group"
    )
    assert_identical(levels(result$target), c("x", "y", "unused"), "generated grouped factor mode changed levels")
  }
)

if (requireNamespace("data.table", quietly = TRUE)) {
  grouped_table_source <- data.table::data.table(group = c("a", "a", "b"), target = c(1, NA, NA))
  data.table::setkey(grouped_table_source, group)
  assert_grouped_generated_case(
    grouped_table_session_id,
    "grouped_table_frame",
    grouped_table_source,
    "mean",
    function(result) {
      assert_identical(class(result), c("data.table", "data.frame"), "generated grouped fill changed data.table flavor")
      assert_identical(data.table::key(result), "group", "generated grouped fill dropped a data.table key")
      assert_identical(result$target, c(1, 1, NA_real_), "generated grouped fill changed data.table values")
    }
  )
}

if (requireNamespace("collapse", quietly = TRUE)) {
  assert_grouped_generated_case(
    grouped_collapse_session_id,
    "grouped_collapse_frame",
    collapse::qTBL(data.frame(group = c("a", "a", "b"), target = c(TRUE, NA, NA))),
    "mostFrequent",
    function(result) {
      assert_identical(
        class(result),
        c("tbl_df", "tbl", "data.frame"),
        "generated grouped fill changed collapse frame flavor"
      )
      assert_identical(result$target, c(TRUE, TRUE, NA), "generated grouped fill changed collapse values")
    }
  )
}

source_environment$most_fill_frame <- data.frame(
  label = ordered(c("high", NA, "high", "low"), levels = c("low", "high")),
  row.names = c("most-a", "most-b", "most-c", "most-d")
)
most_fill_before <- unserialize(serialize(source_environment$most_fill_frame, NULL, version = 3L))
most_fill_open <- dispatch(
  "openSession",
  list(sessionId = most_fill_session_id, variableName = "most_fill_frame", page = page_window())
)
assert_identical(most_fill_open$kind, "page", "the R most-common-value session did not open")
most_fill_malformed <- dispatch(
  "previewStep",
  list(
    sessionId = most_fill_session_id,
    revision = 0L,
    step = fill_step(
      "fill-most-malformed",
      "r:c:0",
      "label",
      list(kind = "mostFrequent", value = "high")
    ),
    page = page_window()
  )
)
assert_identical(most_fill_malformed$kind, "error", "R accepted a most-common-value replacement with a value")
assert_identical(most_fill_malformed$code, "invalid_request", "the malformed most-common-value diagnostic changed")
most_fill_preview <- dispatch(
  "previewStep",
  list(
    sessionId = most_fill_session_id,
    revision = 0L,
    step = fill_step("fill-most", "r:c:0", "label", list(kind = "mostFrequent")),
    page = page_window()
  )
)
assert_identical(
  most_fill_preview$kind,
  "stepPreview",
  sprintf(
    "R most common value did not preview: %s",
    as.character(jsonlite::toJSON(most_fill_preview, auto_unbox = TRUE, null = "null"))
  )
)
assert_identical(most_fill_preview$diff$changedCells, 1L, "R most common value returned an inexact diff")
assert_identical(most_fill_preview$diff$cells[[1L]]$after$raw, "high", "R most common value chose the wrong factor level")
most_fill_apply <- dispatch(
  "applyDraft",
  list(sessionId = most_fill_session_id, revision = 1L, page = page_window())
)
assert_identical(most_fill_apply$action, "apply", "R most common value did not apply")
assign("most_fill_frame", source_environment$most_fill_frame, envir = .GlobalEnv)
eval(parse(text = most_fill_apply$code), envir = .GlobalEnv)
most_fill_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  most_fill_generated$label,
  ordered(c("high", "high", "high", "low"), levels = c("low", "high")),
  "generated R most common value changed the factor result or levels"
)
assert_identical(
  get("most_fill_frame", envir = .GlobalEnv, inherits = FALSE),
  most_fill_before,
  "generated R most common value mutated its source"
)
assert_identical(
  source_environment$most_fill_frame,
  most_fill_before,
  "the R most-common-value lifecycle mutated its source"
)
most_fill_tie <- data.frame(
  label = ordered(c("high", NA, "low"), levels = c("low", "high")),
  row.names = c("tie-a", "tie-b", "tie-c")
)
most_fill_tie_before <- unserialize(serialize(most_fill_tie, NULL, version = 3L))
assign("most_fill_frame", most_fill_tie, envir = .GlobalEnv)
most_fill_tie_error <- tryCatch(
  {
    eval(parse(text = most_fill_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (
  is.null(most_fill_tie_error) ||
    !grepl("2 values are tied", conditionMessage(most_fill_tie_error), fixed = TRUE)
) {
  stop("generated R most common value did not reject an ambiguous winner", call. = FALSE)
}
assert_identical(
  get("most_fill_frame", envir = .GlobalEnv, inherits = FALSE),
  most_fill_tie_before,
  "a failed generated R most-common-value step mutated its source"
)
most_fill_empty <- data.frame(
  label = ordered(c(NA, NA), levels = c("low", "high")),
  row.names = c("empty-a", "empty-b")
)
most_fill_empty_before <- unserialize(serialize(most_fill_empty, NULL, version = 3L))
assign("most_fill_frame", most_fill_empty, envir = .GlobalEnv)
most_fill_empty_error <- tryCatch(
  {
    eval(parse(text = most_fill_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (
  is.null(most_fill_empty_error) ||
    !grepl("no non-missing values", conditionMessage(most_fill_empty_error), fixed = TRUE)
) {
  stop("generated R most common value did not reject an all-missing column", call. = FALSE)
}
assert_identical(
  get("most_fill_frame", envir = .GlobalEnv, inherits = FALSE),
  most_fill_empty_before,
  "an all-missing generated R step mutated its source"
)
rm("most_fill_frame", "open_wrangler_result", envir = .GlobalEnv)
most_fill_closed <- dispatch("closeSession", list(sessionId = most_fill_session_id))
assert_identical(most_fill_closed$kind, "closed", "the R most-common-value session did not close")

source_environment$fill_table <- data.table::data.table(primary_key = c(1L, 2L), payload = c(NA_character_, "ready"))
data.table::setkey(source_environment$fill_table, primary_key)
fill_table_before <- data.table::copy(source_environment$fill_table)
fill_table_open <- dispatch(
  "openSession",
  list(sessionId = fill_table_session_id, variableName = "fill_table", page = page_window())
)
assert_identical(fill_table_open$kind, "page", "the R data.table fill session did not open")
fill_table_key <- dispatch(
  "previewStep",
  list(
    sessionId = fill_table_session_id,
    revision = 0L,
    step = fill_step("fill-table-key", "r:c:0", "primary_key", list(kind = "integer", value = "0")),
    page = page_window()
  )
)
assert_identical(fill_table_key$kind, "error", "R Fill Missing Values silently replaced a data.table key")
assert_identical(fill_table_key$code, "invalid_request", "the R fill key diagnostic changed")
assert_identical(source_environment$fill_table, fill_table_before, "the failed R data.table fill mutated its source")
fill_table_closed <- dispatch("closeSession", list(sessionId = fill_table_session_id))
assert_identical(fill_table_closed$kind, "closed", "the R data.table fill session did not close")

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
row_reduction_step <- function(kind, id, columns, mode = NULL) {
  params <- structure(list(), names = character())
  if (!missing(columns)) params$columns <- I(columns)
  if (!is.null(mode)) {
    params[[if (identical(kind, "dropMissingRows")) "how" else "keep"]] <- mode
  }
  list(id = id, kind = kind, params = params)
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
  TRUE,
  "a narrowed active view was incorrectly treated as the complete row-transform diff"
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

source_environment$row_reduction_frame <- data.frame(
  duplicate = c("a", "a", "b", "b", "c", NA, NA, "z"),
  duplicate = c(1, 1, NA, NA, 3, NA, NaN, Inf),
  `non syntactic` = seq_len(8L),
  row.names = paste0("source-", seq_len(8L)),
  check.names = FALSE,
  stringsAsFactors = FALSE
)
row_reduction_before <- unserialize(serialize(source_environment$row_reduction_frame, NULL, version = 3L))
row_reduction_columns <- list(
  list(id = "r:c:0", name = "duplicate"),
  list(id = "r:c:1", name = "duplicate")
)
row_reduction_open <- dispatch(
  "openSession",
  list(
    sessionId = row_reduction_session_id,
    variableName = "row_reduction_frame",
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(row_reduction_open$kind, "page", "the R row-reduction session did not open")

empty_missing_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 0L,
    step = row_reduction_step(
      "dropMissingRows",
      "row-empty-missing-step",
      columns = list(),
      mode = "any"
    ),
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(empty_missing_preview$kind, "stepPreview", "an explicit empty missing-column set did not preview")
assert_identical(
  vapply(empty_missing_preview$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", c(0L, 1L, 4L, 7L)),
  "an explicit empty missing-column set did not target the active full schema"
)
assert_identical(empty_missing_preview$diff$removedRows, 4L, "an empty missing-column set reported the wrong diff")
empty_missing_discard <- dispatch(
  "discardDraft",
  list(
    sessionId = row_reduction_session_id,
    revision = 1L,
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(empty_missing_discard$action, "discard", "the empty missing-row draft did not discard")

invalid_missing_mode <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 2L,
    step = row_reduction_step(
      "dropMissingRows",
      "row-invalid-missing-step",
      columns = row_reduction_columns,
      mode = "some"
    ),
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(invalid_missing_mode$kind, "error", "an invalid Drop Missing Rows mode was accepted")
assert_identical(invalid_missing_mode$code, "invalid_request", "the invalid missing-mode diagnostic changed")

invalid_duplicate_columns <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 2L,
    step = row_reduction_step(
      "dropDuplicates",
      "row-empty-duplicate-step",
      columns = list(),
      mode = "first"
    ),
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(invalid_duplicate_columns$kind, "error", "an empty Drop Duplicates selection was accepted")
assert_identical(
  invalid_duplicate_columns$code,
  "invalid_request",
  "the empty Drop Duplicates diagnostic changed"
)

repeated_duplicate_columns <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 2L,
    step = row_reduction_step(
      "dropDuplicates",
      "row-repeated-duplicate-step",
      columns = list(row_reduction_columns[[1L]], row_reduction_columns[[1L]]),
      mode = "first"
    ),
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(repeated_duplicate_columns$kind, "error", "a repeated Drop Duplicates identity was accepted")
assert_identical(
  repeated_duplicate_columns$code,
  "invalid_request",
  "the repeated Drop Duplicates identity diagnostic changed"
)

stale_missing_columns <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 2L,
    step = row_reduction_step(
      "dropMissingRows",
      "row-stale-missing-step",
      columns = list(list(id = "r:c:1", name = "stale duplicate")),
      mode = "any"
    ),
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(stale_missing_columns$kind, "error", "a stale Drop Missing Rows reference was accepted")
assert_identical(stale_missing_columns$code, "stale_column", "the stale row-reduction diagnostic changed")

missing_all_step <- row_reduction_step(
  "dropMissingRows",
  "row-missing-all-step",
  columns = row_reduction_columns,
  mode = "all"
)
missing_all_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 2L,
    step = missing_all_step,
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(missing_all_preview$kind, "stepPreview", "Drop Missing Rows all mode did not preview")
assert_identical(
  vapply(missing_all_preview$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", c(0L, 1L, 2L, 3L, 4L, 7L)),
  "Drop Missing Rows all mode changed NA/NaN semantics or stable row identities"
)
assert_identical(missing_all_preview$diff$removedRows, 2L, "Drop Missing Rows reported the wrong diff")
missing_all_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = row_reduction_session_id,
    revision = 3L,
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(missing_all_apply$action, "apply", "Drop Missing Rows did not apply")

duplicates_none_step <- row_reduction_step(
  "dropDuplicates",
  "row-duplicates-none-step",
  columns = row_reduction_columns,
  mode = "none"
)
duplicates_none_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 4L,
    step = duplicates_none_step,
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(duplicates_none_preview$kind, "stepPreview", "Drop Duplicates none mode did not preview")
assert_identical(
  vapply(duplicates_none_preview$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  c("r:r:4", "r:r:7"),
  "Drop Duplicates none mode changed source order or stable row identities"
)
assert_identical(duplicates_none_preview$diff$removedRows, 4L, "Drop Duplicates reported the wrong diff")
duplicates_none_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = row_reduction_session_id,
    revision = 5L,
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(duplicates_none_apply$action, "apply", "Drop Duplicates did not apply")

missing_all_inspection <- inspect_step(
  row_reduction_session_id,
  6L,
  "row-missing-all-step",
  page_window(row_limit = 8L, column_limit = 3L)
)
assert_schema_less_inspection(missing_all_inspection, "Drop Missing Rows inspection")
assert_identical(missing_all_inspection$diff$removedRows, 2L, "Drop Missing Rows inspection changed its diff")
duplicates_none_inspection <- inspect_step(
  row_reduction_session_id,
  6L,
  "row-duplicates-none-step",
  page_window(row_limit = 8L, column_limit = 3L)
)
assert_schema_less_inspection(duplicates_none_inspection, "Drop Duplicates inspection")
assert_identical(duplicates_none_inspection$diff$removedRows, 4L, "Drop Duplicates inspection changed its diff")
assert_identical(
  vapply(duplicates_none_inspection$outputPage$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  c("r:r:4", "r:r:7"),
  "Drop Duplicates inspection regenerated row identities"
)

assign("row_reduction_frame", source_environment$row_reduction_frame, envir = .GlobalEnv)
eval(parse(text = duplicates_none_apply$code), envir = .GlobalEnv)
row_reduction_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  row_reduction_generated[[3L]],
  c(5L, 8L),
  "generated Drop Missing Rows / Drop Duplicates code returned the wrong rows"
)
assert_identical(
  names(row_reduction_generated),
  c("duplicate", "duplicate", "non syntactic"),
  "generated row-reduction code repaired duplicate or non-syntactic names"
)
assert_identical(
  row.names(row_reduction_generated),
  c("source-5", "source-8"),
  "generated row-reduction code changed explicit row names"
)
assert_identical(
  get("row_reduction_frame", envir = .GlobalEnv, inherits = FALSE),
  row_reduction_before,
  "generated row-reduction code mutated its source dataframe"
)
rm("row_reduction_frame", "open_wrangler_result", envir = .GlobalEnv)

duplicates_none_undo <- dispatch(
  "undoStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 6L,
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(duplicates_none_undo$action, "undo", "Drop Duplicates did not undo")
assert_identical(
  vapply(duplicates_none_undo$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", c(0L, 1L, 2L, 3L, 4L, 7L)),
  "undoing Drop Duplicates did not replay Drop Missing Rows"
)
missing_all_undo <- dispatch(
  "undoStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 7L,
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(missing_all_undo$action, "undo", "Drop Missing Rows did not undo")
assert_identical(missing_all_undo$page$page$totalRows, 8L, "undoing row reduction did not restore the source")
assert_identical(
  source_environment$row_reduction_frame,
  row_reduction_before,
  "the row-reduction lifecycle mutated its source dataframe"
)
omitted_missing_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_session_id,
    revision = 8L,
    step = row_reduction_step("dropMissingRows", "row-omitted-missing-step", mode = "any"),
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
)
assert_identical(omitted_missing_preview$kind, "stepPreview", "omitted Drop Missing Rows columns did not preview")
assert_identical(
  vapply(omitted_missing_preview$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", c(0L, 1L, 4L, 7L)),
  "omitted Drop Missing Rows columns did not target the active full schema"
)
invisible(dispatch(
  "discardDraft",
  list(
    sessionId = row_reduction_session_id,
    revision = 9L,
    page = page_window(row_limit = 8L, column_limit = 3L)
  )
))
invisible(dispatch("closeSession", list(sessionId = row_reduction_session_id)))

row_reduction_view_filter <- list(
  column = list(id = "r:c:2", name = "non syntactic"),
  type = "integer",
  predicates = I(list(list(kind = "predicate", operator = "gt", value = 3L)))
)
row_reduction_view_page <- page_window(
  filters = list(row_reduction_view_filter),
  row_limit = 8L,
  column_limit = 3L
)
row_reduction_view_open <- dispatch(
  "openSession",
  list(
    sessionId = row_reduction_view_session_id,
    variableName = "row_reduction_frame",
    page = row_reduction_view_page
  )
)
assert_identical(row_reduction_view_open$kind, "page", "the narrowed row-reduction session did not open")
assert_identical(
  row_reduction_view_open$page$page$totalRows,
  5L,
  "the unrelated active view returned the wrong source rows"
)
row_reduction_view_missing <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_view_session_id,
    revision = 0L,
    step = missing_all_step,
    page = row_reduction_view_page
  )
)
assert_identical(row_reduction_view_missing$kind, "stepPreview", "narrowed Drop Missing Rows did not preview")
assert_identical(row_reduction_view_missing$diff$removedRows, 2L, "narrowed Drop Missing Rows lost its full diff")
assert_identical(
  row_reduction_view_missing$diff$truncated,
  TRUE,
  "an unrelated active view hid Drop Missing Rows diff truncation"
)
assert_identical(
  vapply(row_reduction_view_missing$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  c("r:r:3", "r:r:4", "r:r:7"),
  "the unrelated active view changed Drop Missing Rows source identities"
)
invisible(dispatch(
  "applyDraft",
  list(
    sessionId = row_reduction_view_session_id,
    revision = 1L,
    page = row_reduction_view_page
  )
))
row_reduction_view_missing_inspection <- inspect_step(
  row_reduction_view_session_id,
  2L,
  "row-missing-all-step",
  row_reduction_view_page,
  input_row_count = 8L,
  output_row_count = 6L
)
assert_identical(
  row_reduction_view_missing_inspection$diff$removedRows,
  2L,
  "narrowed Drop Missing Rows inspection lost its full diff"
)
assert_identical(
  row_reduction_view_missing_inspection$diff$truncated,
  TRUE,
  "an unrelated active view hid Drop Missing Rows inspection truncation"
)

row_reduction_view_duplicates <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_view_session_id,
    revision = 2L,
    step = duplicates_none_step,
    page = row_reduction_view_page
  )
)
assert_identical(row_reduction_view_duplicates$kind, "stepPreview", "narrowed Drop Duplicates did not preview")
assert_identical(row_reduction_view_duplicates$diff$removedRows, 4L, "narrowed Drop Duplicates lost its full diff")
assert_identical(
  row_reduction_view_duplicates$diff$truncated,
  TRUE,
  "an unrelated active view hid Drop Duplicates diff truncation"
)
assert_identical(
  vapply(row_reduction_view_duplicates$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  c("r:r:4", "r:r:7"),
  "the unrelated active view changed Drop Duplicates source identities"
)
invisible(dispatch(
  "applyDraft",
  list(
    sessionId = row_reduction_view_session_id,
    revision = 3L,
    page = row_reduction_view_page
  )
))
row_reduction_view_duplicates_inspection <- inspect_step(
  row_reduction_view_session_id,
  4L,
  "row-duplicates-none-step",
  row_reduction_view_page,
  input_row_count = 6L,
  output_row_count = 2L
)
assert_identical(
  row_reduction_view_duplicates_inspection$diff$removedRows,
  4L,
  "narrowed Drop Duplicates inspection lost its full diff"
)
assert_identical(
  row_reduction_view_duplicates_inspection$diff$truncated,
  TRUE,
  "an unrelated active view hid Drop Duplicates inspection truncation"
)
assert_identical(
  source_environment$row_reduction_frame,
  row_reduction_before,
  "narrowed row-reduction inspection mutated its source dataframe"
)
invisible(dispatch("closeSession", list(sessionId = row_reduction_view_session_id)))

source_environment$row_reduction_tibble <- tibble::as_tibble(
  data.frame(
    duplicate = c("a", "a", "b", "b", "c"),
    duplicate = c(1L, 1L, 2L, 2L, 3L),
    check.names = FALSE,
    stringsAsFactors = FALSE
  ),
  .name_repair = "minimal"
)
row_reduction_tibble_before <- unserialize(serialize(source_environment$row_reduction_tibble, NULL, version = 3L))
row_reduction_tibble_open <- dispatch(
  "openSession",
  list(
    sessionId = row_reduction_tibble_session_id,
    variableName = "row_reduction_tibble",
    page = page_window(row_limit = 5L, column_limit = 2L)
  )
)
assert_identical(row_reduction_tibble_open$kind, "page", "the row-reduction tibble did not open")
row_reduction_tibble_preview <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_tibble_session_id,
    revision = 0L,
    step = row_reduction_step(
      "dropDuplicates",
      "row-tibble-duplicates-last",
      columns = row_reduction_columns,
      mode = "last"
    ),
    page = page_window(row_limit = 5L, column_limit = 2L)
  )
)
assert_identical(row_reduction_tibble_preview$kind, "stepPreview", "tibble Drop Duplicates did not preview")
assert_identical(
  vapply(row_reduction_tibble_preview$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", c(1L, 3L, 4L)),
  "tibble Drop Duplicates last mode returned the wrong source rows"
)
row_reduction_tibble_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = row_reduction_tibble_session_id,
    revision = 1L,
    page = page_window(row_limit = 5L, column_limit = 2L)
  )
)
assert_identical(
  row_reduction_tibble_apply$page$frameSemantics$classes,
  list("tbl_df", "tbl", "data.frame"),
  "committed Drop Duplicates changed tibble class"
)
assign("row_reduction_tibble", source_environment$row_reduction_tibble, envir = .GlobalEnv)
eval(parse(text = row_reduction_tibble_apply$code), envir = .GlobalEnv)
row_reduction_tibble_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  class(row_reduction_tibble_generated),
  c("tbl_df", "tbl", "data.frame"),
  "generated Drop Duplicates changed tibble class"
)
assert_identical(
  row_reduction_tibble_generated[[2L]],
  c(1L, 2L, 3L),
  "generated tibble Drop Duplicates last mode returned the wrong rows"
)
assert_identical(
  source_environment$row_reduction_tibble,
  row_reduction_tibble_before,
  "tibble row reduction mutated its source"
)
rm("row_reduction_tibble", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = row_reduction_tibble_session_id)))

source_environment$row_reduction_table <- data.table::data.table(
  primary_key = c(1L, 1L, 2L, 2L, 3L),
  payload = c("a", "a", NA, NA, "z")
)
data.table::setkey(source_environment$row_reduction_table, primary_key)
row_reduction_table_before <- data.table::copy(source_environment$row_reduction_table)
row_reduction_table_open <- dispatch(
  "openSession",
  list(
    sessionId = row_reduction_table_session_id,
    variableName = "row_reduction_table",
    page = page_window(row_limit = 5L, column_limit = 2L)
  )
)
assert_identical(row_reduction_table_open$kind, "page", "the row-reduction data.table did not open")
row_reduction_table_missing <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_table_session_id,
    revision = 0L,
    step = row_reduction_step(
      "dropMissingRows",
      "row-table-missing-any",
      columns = list(list(id = "r:c:1", name = "payload")),
      mode = "any"
    ),
    page = page_window(row_limit = 5L, column_limit = 2L)
  )
)
assert_identical(row_reduction_table_missing$kind, "stepPreview", "data.table Drop Missing Rows did not preview")
assert_identical(
  vapply(row_reduction_table_missing$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  c("r:r:0", "r:r:1", "r:r:4"),
  "data.table Drop Missing Rows returned the wrong rows"
)
row_reduction_table_missing_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = row_reduction_table_session_id,
    revision = 1L,
    page = page_window(row_limit = 5L, column_limit = 2L)
  )
)
assert_identical(
  row_reduction_table_missing_apply$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "Drop Missing Rows discarded a compatible data.table key"
)
row_reduction_table_duplicates <- dispatch(
  "previewStep",
  list(
    sessionId = row_reduction_table_session_id,
    revision = 2L,
    step = row_reduction_step(
      "dropDuplicates",
      "row-table-duplicates-first"
    ),
    page = page_window(row_limit = 5L, column_limit = 2L)
  )
)
assert_identical(row_reduction_table_duplicates$kind, "stepPreview", "data.table Drop Duplicates did not preview")
assert_identical(
  vapply(row_reduction_table_duplicates$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  c("r:r:0", "r:r:4"),
  "omitted Drop Duplicates columns did not target the active full schema"
)
row_reduction_table_duplicates_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = row_reduction_table_session_id,
    revision = 3L,
    page = page_window(row_limit = 5L, column_limit = 2L)
  )
)
assert_identical(
  row_reduction_table_duplicates_apply$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "Drop Duplicates discarded a compatible data.table key"
)
assign("row_reduction_table", source_environment$row_reduction_table, envir = .GlobalEnv)
eval(parse(text = row_reduction_table_duplicates_apply$code), envir = .GlobalEnv)
row_reduction_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  data.table::key(row_reduction_table_generated),
  "primary_key",
  "generated row reduction discarded a compatible data.table key"
)
assert_identical(
  row_reduction_table_generated$primary_key,
  c(1L, 3L),
  "generated data.table Drop Missing Rows / Drop Duplicates returned the wrong rows"
)
assert_identical(
  data.table::key(source_environment$row_reduction_table),
  "primary_key",
  "data.table row reduction changed the source key"
)
assert_identical(
  source_environment$row_reduction_table,
  row_reduction_table_before,
  "data.table row reduction mutated its source"
)
rm("row_reduction_table", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = row_reduction_table_session_id)))

numeric_step <- function(id, kind, position, name, decimals = NULL, new_column = NULL) {
  params <- list(column = list(id = sprintf("r:c:%d", position - 1L), name = name))
  if (!is.null(decimals)) params$decimals <- decimals
  if (!is.null(new_column)) params$newColumn <- new_column
  list(id = id, kind = kind, params = params)
}
source_environment$numeric_frame <- data.frame(
  rounded = c(15, 25, -15, -25, NA_real_, NaN, Inf, -Inf),
  floored = c(1.9, -1.1, NA_real_, NaN, Inf, -Inf, 2, -2),
  ceiled = c(1.1, -1.9, NA_real_, NaN, Inf, -Inf, 2, -2),
  integer_value = c(1L, -2L, NA_integer_, 3L, 4L, 5L, 6L, 7L),
  text = rep("not numeric", 8L),
  row.names = sprintf("numeric-%d", seq_len(8L)),
  check.names = FALSE
)
numeric_before <- unserialize(serialize(source_environment$numeric_frame, NULL, version = 3L))
numeric_open <- dispatch(
  "openSession",
  list(sessionId = numeric_session_id, variableName = "numeric_frame", page = page_window())
)
assert_identical(numeric_open$kind, "page", "the R numeric-transform session did not open")
numeric_fractional_decimals <- dispatch(
  "previewStep",
  list(
    sessionId = numeric_session_id,
    revision = 0L,
    step = numeric_step("fractional-round", "roundNumber", 1L, "rounded", 0.5),
    page = page_window()
  )
)
assert_identical(numeric_fractional_decimals$kind, "error", "R Round accepted fractional decimal places")
assert_identical(numeric_fractional_decimals$code, "invalid_request", "the R Round precision diagnostic changed")
numeric_text_error <- dispatch(
  "previewStep",
  list(
    sessionId = numeric_session_id,
    revision = 0L,
    step = numeric_step("text-round", "roundNumber", 5L, "text", 0L),
    page = page_window()
  )
)
assert_identical(numeric_text_error$kind, "error", "R Round accepted a text column")
assert_identical(numeric_text_error$code, "invalid_request", "the R Round type diagnostic changed")

numeric_round_preview <- dispatch(
  "previewStep",
  list(
    sessionId = numeric_session_id,
    revision = 0L,
    step = numeric_step("round-ties", "roundNumber", 1L, "rounded", -1L),
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(numeric_round_preview$kind, "stepPreview", "R Round did not preview")
assert_identical(numeric_round_preview$page$page$columnIds, list("r:c:0"), "in-place R Round changed lineage")
assert_identical(numeric_round_preview$diff$changedCells, 4L, "R Round returned an inexact cell diff")
assert_identical(
  vapply(numeric_round_preview$diff$cells, function(cell) as.character(cell$after$raw), character(1L)),
  c("20", "20", "-20", "-20"),
  "R Round did not use ties-to-even semantics"
)
numeric_round_apply <- dispatch(
  "applyDraft",
  list(sessionId = numeric_session_id, revision = 1L, page = page_window())
)
assert_identical(numeric_round_apply$action, "apply", "R Round did not apply")

numeric_floor_preview <- dispatch(
  "previewStep",
  list(
    sessionId = numeric_session_id,
    revision = 2L,
    step = numeric_step("floor-copy", "floorNumber", 2L, "floored", new_column = "floor result"),
    page = page_window(column_offset = 5L, column_limit = 1L)
  )
)
assert_identical(numeric_floor_preview$kind, "stepPreview", "derived R Floor did not preview")
assert_identical(
  numeric_floor_preview$page$page$columnIds,
  list("c:step:floor-copy:0"),
  "derived R Floor lost its stable output identity"
)
assert_identical(numeric_floor_preview$diff$addedColumns, list("floor result"), "derived R Floor lost its diff")
numeric_floor_page <- dispatch(
  "getPage",
  list(sessionId = numeric_session_id, page = page_window(column_offset = 5L, column_limit = 1L))
)
assert_identical(numeric_floor_page$kind, "page", "the active R Floor draft could not page its derived column")
assert_identical(
  vapply(
    numeric_floor_page$page$page$rows[seq_len(2L)],
    function(row) as.character(row$values[[1L]]$raw),
    character(1L),
    USE.NAMES = FALSE
  ),
  c("1", "-2"),
  "the active R Floor draft returned the wrong derived values"
)
numeric_floor_apply <- dispatch(
  "applyDraft",
  list(sessionId = numeric_session_id, revision = 3L, page = page_window())
)
assert_identical(numeric_floor_apply$action, "apply", "derived R Floor did not apply")

numeric_ceil_preview <- dispatch(
  "previewStep",
  list(
    sessionId = numeric_session_id,
    revision = 4L,
    step = numeric_step("ceil-in-place", "ceilNumber", 3L, "ceiled"),
    page = page_window(column_offset = 2L, column_limit = 1L)
  )
)
assert_identical(numeric_ceil_preview$kind, "stepPreview", "in-place R Ceiling did not preview")
assert_identical(numeric_ceil_preview$diff$changedCells, 2L, "R Ceiling returned an inexact cell diff")
numeric_ceil_apply <- dispatch(
  "applyDraft",
  list(sessionId = numeric_session_id, revision = 5L, page = page_window())
)
assert_identical(numeric_ceil_apply$action, "apply", "in-place R Ceiling did not apply")

numeric_integer_preview <- dispatch(
  "previewStep",
  list(
    sessionId = numeric_session_id,
    revision = 6L,
    step = numeric_step("floor-integer", "floorNumber", 4L, "integer_value", new_column = "integer floor"),
    page = page_window(column_offset = 6L, column_limit = 1L)
  )
)
assert_identical(numeric_integer_preview$kind, "stepPreview", "R Floor did not accept an integer column")
assert_identical(
  numeric_integer_preview$page$schema[[7L]]$rawType,
  "double",
  "R Floor did not expose the base-R numeric result type"
)
numeric_integer_apply <- dispatch(
  "applyDraft",
  list(sessionId = numeric_session_id, revision = 7L, page = page_window())
)
assert_identical(numeric_integer_apply$action, "apply", "R integer Floor did not apply")
if (
  !grepl("base::round(.ow_numeric_source, digits = -1)", numeric_integer_apply$code, fixed = TRUE) ||
    !grepl("base::floor(.ow_numeric_source)", numeric_integer_apply$code, fixed = TRUE) ||
    !grepl("base::ceiling(.ow_numeric_source)", numeric_integer_apply$code, fixed = TRUE)
) {
  stop("generated R numeric code lost its native rounding expressions", call. = FALSE)
}
assign("numeric_frame", source_environment$numeric_frame, envir = .GlobalEnv)
eval(parse(text = numeric_integer_apply$code), envir = .GlobalEnv)
numeric_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(numeric_generated$rounded, c(20, 20, -20, -20, NA_real_, NaN, Inf, -Inf), "generated R Round changed values")
assert_identical(numeric_generated$`floor result`, c(1, -2, NA_real_, NaN, Inf, -Inf, 2, -2), "generated R Floor changed values")
assert_identical(numeric_generated$ceiled, c(2, -1, NA_real_, NaN, Inf, -Inf, 2, -2), "generated R Ceiling changed values")
assert_identical(
  numeric_generated$`integer floor`,
  c(1, -2, NA_real_, 3, 4, 5, 6, 7),
  "generated R Floor changed integer values"
)
assert_identical(row.names(numeric_generated), row.names(numeric_before), "generated R numeric tools changed row names")
assert_identical(get("numeric_frame", envir = .GlobalEnv), numeric_before, "generated R numeric code mutated its source")
assert_identical(source_environment$numeric_frame, numeric_before, "the R numeric lifecycle mutated its source")
rm("numeric_frame", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = numeric_session_id)))

source_environment$numeric_table <- data.table::data.table(
  primary_key = c(1.5, 2.5),
  payload = c(1.1, -1.1),
  row_marker = c("first", "second")
)
data.table::setkey(source_environment$numeric_table, primary_key)
numeric_table_before <- data.table::copy(source_environment$numeric_table)
numeric_table_open <- dispatch(
  "openSession",
  list(sessionId = numeric_table_session_id, variableName = "numeric_table", page = page_window())
)
assert_identical(numeric_table_open$kind, "page", "the R numeric data.table session did not open")
numeric_key_error <- dispatch(
  "previewStep",
  list(
    sessionId = numeric_table_session_id,
    revision = 0L,
    step = numeric_step("round-key", "roundNumber", 1L, "primary_key", 0L),
    page = page_window()
  )
)
assert_identical(numeric_key_error$kind, "error", "R Round silently replaced a data.table key")
assert_identical(numeric_key_error$code, "invalid_request", "the R numeric key diagnostic changed")
numeric_key_copy <- dispatch(
  "previewStep",
  list(
    sessionId = numeric_table_session_id,
    revision = 0L,
    step = numeric_step("round-key-copy", "roundNumber", 1L, "primary_key", 0L, "rounded key"),
    page = page_window()
  )
)
assert_identical(numeric_key_copy$kind, "stepPreview", "derived R Round could not read a data.table key")
assert_identical(numeric_key_copy$page$frameSemantics$keyColumnIds, list("r:c:0"), "derived R Round lost the key")
numeric_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = numeric_table_session_id, revision = 1L, page = page_window())
)
assign("numeric_table", source_environment$numeric_table, envir = .GlobalEnv)
eval(parse(text = numeric_table_apply$code), envir = .GlobalEnv)
numeric_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(data.table::key(numeric_table_generated), "primary_key", "generated R Round lost the data.table key")
assert_identical(numeric_table_generated$`rounded key`, c(2, 2), "generated R Round changed key-copy values")
assert_identical(numeric_table_generated$row_marker, numeric_table_before$row_marker, "generated R Round changed keyed row order")
assert_identical(get("numeric_table", envir = .GlobalEnv), numeric_table_before, "generated R Round mutated its data.table source")
rm("numeric_table", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = numeric_table_session_id)))

if (requireNamespace("bit64", quietly = TRUE)) {
  source_environment$numeric_integer64 <- data.frame(
    big = bit64::as.integer64(c("9007199254740993", "15", "25", "-15", "-25", NA)),
    extreme = bit64::as.integer64(c("9223372036854775807", "1", "2", "3", "4", NA)),
    check.names = FALSE
  )
  numeric_integer64_before <- unserialize(serialize(source_environment$numeric_integer64, NULL, version = 3L))
  numeric_integer64_open <- dispatch(
    "openSession",
    list(sessionId = numeric_integer64_session_id, variableName = "numeric_integer64", page = page_window())
  )
  assert_identical(numeric_integer64_open$kind, "page", "the R integer64 numeric session did not open")
  numeric_integer64_overflow <- dispatch(
    "previewStep",
    list(
      sessionId = numeric_integer64_session_id,
      revision = 0L,
      step = numeric_step("round-integer64-overflow", "roundNumber", 2L, "extreme", -1L),
      page = page_window()
    )
  )
  assert_identical(numeric_integer64_overflow$kind, "error", "R Round silently overflowed integer64")
  assert_identical(numeric_integer64_overflow$code, "invalid_request", "the R integer64 overflow diagnostic changed")
  numeric_integer64_preview <- dispatch(
    "previewStep",
    list(
      sessionId = numeric_integer64_session_id,
      revision = 0L,
      step = numeric_step("round-integer64", "roundNumber", 1L, "big", -1L),
      page = page_window(column_offset = 0L, column_limit = 1L)
    )
  )
  assert_identical(numeric_integer64_preview$kind, "stepPreview", "R Round did not preview integer64")
  assert_identical(numeric_integer64_preview$page$schema[[1L]]$rawType, "integer64", "R Round narrowed integer64")
  assert_identical(
    vapply(
      numeric_integer64_preview$page$page$rows[seq_len(5L)],
      function(row) as.character(row$values[[1L]]$raw),
      character(1L),
      USE.NAMES = FALSE
    ),
    c("9007199254740990", "20", "20", "-20", "-20"),
    "live R Round lost integer64 precision or ties-to-even semantics"
  )
  assert_identical(
    numeric_integer64_preview$page$page$rows[[6L]]$values[[1L]]$kind,
    "null",
    "live R Round did not preserve integer64 NA"
  )
  numeric_integer64_apply <- dispatch(
    "applyDraft",
    list(sessionId = numeric_integer64_session_id, revision = 1L, page = page_window())
  )
  if (!grepl(".ow_round_integer64", numeric_integer64_apply$code, fixed = TRUE)) {
    stop("generated R Round lost its exact integer64 helper", call. = FALSE)
  }
  assign("numeric_integer64", source_environment$numeric_integer64, envir = .GlobalEnv)
  eval(parse(text = numeric_integer64_apply$code), envir = .GlobalEnv)
  numeric_integer64_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_identical(
    as.character(numeric_integer64_generated$big),
    c("9007199254740990", "20", "20", "-20", "-20", NA_character_),
    "generated R Round lost integer64 precision or ties-to-even semantics"
  )
  assert_identical(get("numeric_integer64", envir = .GlobalEnv), numeric_integer64_before, "generated R Round mutated its integer64 source")
  assert_identical(source_environment$numeric_integer64, numeric_integer64_before, "R Round mutated its integer64 source")
  rm("numeric_integer64", "open_wrangler_result", envir = .GlobalEnv)
  invisible(dispatch("closeSession", list(sessionId = numeric_integer64_session_id)))
}

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
  capture_group_result = function(...) stop("unexpected grouped capture", call. = FALSE),
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
  upper_text_column_at = function(...) stop("unexpected uppercase", call. = FALSE),
  capitalize_text_column_at = function(...) stop("unexpected capitalize", call. = FALSE),
  strip_text_column_at = function(...) stop("unexpected strip", call. = FALSE),
  split_text_column_at = function(...) stop("unexpected split", call. = FALSE),
  find_replace_column_at = function(...) stop("unexpected find and replace", call. = FALSE),
  round_number_column_at = function(...) stop("unexpected round", call. = FALSE),
  floor_number_column_at = function(...) stop("unexpected floor", call. = FALSE),
  ceil_number_column_at = function(...) stop("unexpected ceiling", call. = FALSE),
  fill_missing_column_at = function(...) stop("unexpected fill missing", call. = FALSE),
  fill_missing_from_fallback_columns_at = function(...) stop("unexpected fallback fill", call. = FALSE),
  fill_missing_directional_at = function(...) stop("unexpected directional fill", call. = FALSE),
  fill_missing_linear_interpolation_at = function(...) stop("unexpected linear interpolation", call. = FALSE),
  fill_missing_grouped_statistic_at = function(...) stop("unexpected grouped fill", call. = FALSE),
  cast_column_at = function(...) stop("unexpected cast", call. = FALSE),
  drop_columns_at = function(...) stop("unexpected drop", call. = FALSE),
  select_columns_at = function(...) stop("unexpected select", call. = FALSE),
  drop_missing_rows_at = function(...) stop("unexpected drop missing", call. = FALSE),
  drop_duplicate_rows_at = function(...) stop("unexpected drop duplicates", call. = FALSE),
  group_by_at = function(...) stop("unexpected group by", call. = FALSE),
  transform_rows = function(...) stop("unexpected row transform", call. = FALSE),
  materialize_view_page = function(...) stop("unexpected page materialization", call. = FALSE),
  materialize_summaries = function(...) stop("unexpected summary materialization", call. = FALSE),
  materialize_dataset_stats = function(...) stop("unexpected dataset profile", call. = FALSE),
  materialize_column_values = function(...) stop("unexpected column values", call. = FALSE),
  export_formats = function() "csv",
  write_csv = function(...) stop("unexpected CSV export", call. = FALSE),
  write_parquet = function(...) stop("unexpected Parquet export", call. = FALSE),
  limits = openwrangler_r_frame_contract$limits
)
for (required_group_tool in c("capture_group_result", "group_by_at")) {
  incomplete_group_contract <- missing_package_contract
  incomplete_group_contract[[required_group_tool]] <- NULL
  incomplete_group_error <- tryCatch(
    {
      openwrangler_r_kernel_agent$new_agent(incomplete_group_contract, source_environment)
      NULL
    },
    error = function(error) error
  )
  if (
    is.null(incomplete_group_error) ||
      !identical(conditionMessage(incomplete_group_error), "Open Wrangler received an invalid R frame contract.")
  ) {
    stop(sprintf("the R agent accepted a frame contract without %s", required_group_tool), call. = FALSE)
  }
}
for (required_export_tool in c("export_formats", "write_csv", "write_parquet")) {
  incomplete_export_contract <- missing_package_contract
  incomplete_export_contract[[required_export_tool]] <- NULL
  incomplete_export_error <- tryCatch(
    {
      openwrangler_r_kernel_agent$new_agent(incomplete_export_contract, source_environment)
      NULL
    },
    error = function(error) error
  )
  if (
    is.null(incomplete_export_error) ||
      !identical(conditionMessage(incomplete_export_error), "Open Wrangler received an invalid R frame contract.")
  ) {
    stop(sprintf("the R agent accepted a frame contract without %s support", required_export_tool), call. = FALSE)
  }
}
missing_write_csv_contract <- missing_package_contract
missing_write_csv_contract$write_csv <- NULL
missing_write_csv_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_write_csv_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_write_csv_error) ||
    !identical(conditionMessage(missing_write_csv_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without CSV export support", call. = FALSE)
}
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
missing_upper_contract <- missing_package_contract
missing_upper_contract$upper_text_column_at <- NULL
missing_upper_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_upper_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_upper_error) ||
    !identical(conditionMessage(missing_upper_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without Uppercase support", call. = FALSE)
}
for (required_text_tool in c(
  "capitalize_text_column_at",
  "strip_text_column_at",
  "split_text_column_at"
)) {
  incomplete_contract <- missing_package_contract
  incomplete_contract[[required_text_tool]] <- NULL
  incomplete_error <- tryCatch(
    {
      openwrangler_r_kernel_agent$new_agent(incomplete_contract, source_environment)
      NULL
    },
    error = function(error) error
  )
  if (
    is.null(incomplete_error) ||
      !identical(conditionMessage(incomplete_error), "Open Wrangler received an invalid R frame contract.")
  ) {
    stop(sprintf("the R agent accepted a frame contract without %s support", required_text_tool), call. = FALSE)
  }
}
missing_find_replace_contract <- missing_package_contract
missing_find_replace_contract$find_replace_column_at <- NULL
missing_find_replace_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_find_replace_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_find_replace_error) ||
    !identical(conditionMessage(missing_find_replace_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without Find and Replace support", call. = FALSE)
}
for (required_numeric_tool in c(
  "round_number_column_at",
  "floor_number_column_at",
  "ceil_number_column_at"
)) {
  incomplete_contract <- missing_package_contract
  incomplete_contract[[required_numeric_tool]] <- NULL
  incomplete_error <- tryCatch(
    {
      openwrangler_r_kernel_agent$new_agent(incomplete_contract, source_environment)
      NULL
    },
    error = function(error) error
  )
  if (
    is.null(incomplete_error) ||
      !identical(conditionMessage(incomplete_error), "Open Wrangler received an invalid R frame contract.")
  ) {
    stop(sprintf("the R agent accepted a frame contract without %s support", required_numeric_tool), call. = FALSE)
  }
}
missing_fill_contract <- missing_package_contract
missing_fill_contract$fill_missing_column_at <- NULL
missing_fill_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_fill_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_fill_error) ||
    !identical(conditionMessage(missing_fill_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without Fill Missing Values support", call. = FALSE)
}
missing_fallback_fill_contract <- missing_package_contract
missing_fallback_fill_contract$fill_missing_from_fallback_columns_at <- NULL
missing_fallback_fill_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_fallback_fill_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_fallback_fill_error) ||
    !identical(conditionMessage(missing_fallback_fill_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without fallback-column fill support", call. = FALSE)
}
missing_directional_fill_contract <- missing_package_contract
missing_directional_fill_contract$fill_missing_directional_at <- NULL
missing_directional_fill_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_directional_fill_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_directional_fill_error) ||
    !identical(conditionMessage(missing_directional_fill_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without directional fill support", call. = FALSE)
}
missing_linear_fill_contract <- missing_package_contract
missing_linear_fill_contract$fill_missing_linear_interpolation_at <- NULL
missing_linear_fill_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_linear_fill_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_linear_fill_error) ||
    !identical(conditionMessage(missing_linear_fill_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without linear interpolation support", call. = FALSE)
}
missing_grouped_fill_contract <- missing_package_contract
missing_grouped_fill_contract$fill_missing_grouped_statistic_at <- NULL
missing_grouped_fill_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_grouped_fill_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_grouped_fill_error) ||
    !identical(conditionMessage(missing_grouped_fill_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without grouped fill support", call. = FALSE)
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
missing_drop_missing_contract <- missing_package_contract
missing_drop_missing_contract$drop_missing_rows_at <- NULL
missing_drop_missing_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_drop_missing_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_drop_missing_error) ||
    !identical(conditionMessage(missing_drop_missing_error), "Open Wrangler received an invalid R frame contract.")
) {
  stop("the R agent accepted a frame contract without Drop Missing Rows support", call. = FALSE)
}
missing_drop_duplicates_contract <- missing_package_contract
missing_drop_duplicates_contract$drop_duplicate_rows_at <- NULL
missing_drop_duplicates_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_drop_duplicates_contract, source_environment)
    NULL
  },
  error = function(error) error
)
if (
  is.null(missing_drop_duplicates_error) ||
    !identical(
      conditionMessage(missing_drop_duplicates_error),
      "Open Wrangler received an invalid R frame contract."
    )
) {
  stop("the R agent accepted a frame contract without Drop Duplicates support", call. = FALSE)
}

assert_group_by_flavor_case <- function(
  case_session_id,
  variable_name,
  source,
  expected_flavor,
  expected_classes,
  expected_source_key_ids,
  expected_groups,
  expected_totals
) {
  source_environment[[variable_name]] <- source
  before <- if (inherits(source, "data.table")) {
    data.table::copy(source)
  } else {
    unserialize(serialize(source, NULL, version = 3L))
  }
  invisible(dispatch(
    "openSession",
    list(sessionId = case_session_id, variableName = variable_name, page = page_window())
  ))

  step_id <- paste0(variable_name, "-group-by")
  previewed <- dispatch(
    "previewStep",
    list(
      sessionId = case_session_id,
      revision = 0L,
      step = list(
        id = step_id,
        kind = "groupBy",
        params = list(
          keys = I(list(list(id = "r:c:0", name = "group"))),
          aggregations = I(list(list(
            column = list(id = "r:c:1", name = "value"),
            operation = "sum",
            alias = "total"
          )))
        )
      ),
      page = page_window()
    )
  )
  assert_identical(
    list(
      kind = previewed$kind,
      flavor = previewed$page$dataframeFlavor,
      classes = previewed$page$frameSemantics$classes,
      keyColumnIds = previewed$page$frameSemantics$keyColumnIds,
      groups = vapply(
        previewed$page$page$rows,
        function(row) as.character(row$values[[1L]]$raw),
        character(1L),
        USE.NAMES = FALSE
      ),
      totals = vapply(
        previewed$page$page$rows,
        function(row) as.integer(row$values[[2L]]$raw),
        integer(1L),
        USE.NAMES = FALSE
      )
    ),
    list(
      kind = "stepPreview",
      flavor = expected_flavor,
      classes = as.list(expected_classes),
      keyColumnIds = list(),
      groups = expected_groups,
      totals = expected_totals
    ),
    sprintf("the %s Group By preview changed its dataframe family or result", variable_name)
  )

  applied <- dispatch(
    "applyDraft",
    list(sessionId = case_session_id, revision = previewed$revision, page = page_window())
  )
  assert_identical(applied$action, "apply", sprintf("the %s Group By did not apply", variable_name))

  assign(variable_name, source_environment[[variable_name]], envir = .GlobalEnv)
  eval(parse(text = applied$code), envir = .GlobalEnv)
  generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_identical(
    list(
      classes = class(generated),
      groups = as.character(generated$group),
      totals = as.integer(generated$total),
      key = if (inherits(generated, "data.table")) data.table::key(generated) else NULL,
      generatedSource = get(variable_name, envir = .GlobalEnv, inherits = FALSE),
      liveSource = source_environment[[variable_name]]
    ),
    list(
      classes = expected_classes,
      groups = expected_groups,
      totals = expected_totals,
      key = NULL,
      generatedSource = before,
      liveSource = before
    ),
    sprintf("generated %s Group By changed its dataframe family, result, or source", variable_name)
  )
  rm(list = c(variable_name, "open_wrangler_result"), envir = .GlobalEnv)

  undone <- dispatch(
    "undoStep",
    list(sessionId = case_session_id, revision = applied$revision, page = page_window())
  )
  assert_identical(
    list(
      action = undone$action,
      flavor = undone$page$dataframeFlavor,
      classes = undone$page$frameSemantics$classes,
      keyColumnIds = undone$page$frameSemantics$keyColumnIds,
      source = source_environment[[variable_name]]
    ),
    list(
      action = "undo",
      flavor = expected_flavor,
      classes = as.list(expected_classes),
      keyColumnIds = expected_source_key_ids,
      source = before
    ),
    sprintf("undoing the %s Group By did not restore its dataframe family or source", variable_name)
  )

  invisible(dispatch("closeSession", list(sessionId = case_session_id)))
  rm(list = variable_name, envir = source_environment)
}

assert_group_by_flavor_case(
  group_by_tibble_session_id,
  "group_by_tibble",
  tibble::tibble(group = c("b", "a", "b"), value = c(1L, 2L, 3L)),
  "r.tibble",
  c("tbl_df", "tbl", "data.frame"),
  list(),
  c("b", "a"),
  c(4L, 2L)
)

group_by_table_source <- data.table::data.table(
  group = c("b", "a", "c", "b"),
  value = c(1L, 2L, 3L, 4L),
  source_order = c(30L, 20L, 10L, 40L)
)
data.table::setkey(group_by_table_source, source_order)
assert_group_by_flavor_case(
  group_by_table_session_id,
  "group_by_table",
  group_by_table_source,
  "r.data.table",
  c("data.table", "data.frame"),
  list("r:c:2"),
  c("c", "a", "b"),
  c(3L, 2L, 5L)
)

source_environment$group_by_frame <- data.frame(
  group = c(2, 1, 2, NA_real_, NaN, 1, 2),
  number = c(1L, 2L, 4L, NA_integer_, NA_integer_, 4L, 10L),
  label = factor(c("z", "b", NA, "c", "a", "a", NA), levels = c("z", "a", "b", "c")),
  ordered_label = ordered(
    c("medium", "low", "high", NA, "medium", "high", NA),
    levels = c("low", "medium", "high")
  ),
  when = as.Date("2026-01-01") + c(0, 1, 2, NA, 4, 5, NA),
  flag = c(TRUE, NA, FALSE, FALSE, NA, TRUE, NA),
  check.names = FALSE,
  row.names = paste0("source-row-", seq_len(7L))
)
group_by_source_before <- unserialize(serialize(source_environment$group_by_frame, NULL, version = 3L))
group_by_open <- dispatch(
  "openSession",
  list(sessionId = group_by_session_id, variableName = "group_by_frame", page = page_window())
)
assert_identical(group_by_open$kind, "page", "the R Group By session did not open")
group_by_aggregations <- list(
  list(column = list(id = "r:c:1", name = "number"), operation = "sum", alias = "number_sum"),
  list(column = list(id = "r:c:1", name = "number"), operation = "mean", alias = "number_mean"),
  list(column = list(id = "r:c:1", name = "number"), operation = "median", alias = "number_median"),
  list(column = list(id = "r:c:1", name = "number"), operation = "min", alias = "number_min"),
  list(column = list(id = "r:c:1", name = "number"), operation = "max", alias = "number_max"),
  list(column = list(id = "r:c:1", name = "number"), operation = "count", alias = "number_count"),
  list(column = list(id = "r:c:1", name = "number"), operation = "nUnique", alias = "number_unique"),
  list(column = list(id = "r:c:1", name = "number"), operation = "first", alias = "number_first"),
  list(column = list(id = "r:c:1", name = "number"), operation = "last", alias = "number_last"),
  list(column = list(id = "r:c:2", name = "label"), operation = "min", alias = "label_min"),
  list(column = list(id = "r:c:2", name = "label"), operation = "max", alias = "label_max"),
  list(column = list(id = "r:c:3", name = "ordered_label"), operation = "min", alias = "ordered_min"),
  list(column = list(id = "r:c:3", name = "ordered_label"), operation = "max", alias = "ordered_max"),
  list(column = list(id = "r:c:4", name = "when"), operation = "min", alias = "date_min"),
  list(column = list(id = "r:c:4", name = "when"), operation = "max", alias = "date_max"),
  list(column = list(id = "r:c:5", name = "flag"), operation = "min", alias = "flag_min"),
  list(column = list(id = "r:c:5", name = "flag"), operation = "max", alias = "flag_max")
)
group_by_step <- list(
  id = "group-by-step",
  kind = "groupBy",
  params = list(
    keys = I(list(list(id = "r:c:0", name = "group"))),
    aggregations = I(group_by_aggregations)
  )
)
group_by_preview <- dispatch(
  "previewStep",
  list(
    sessionId = group_by_session_id,
    revision = 0L,
    step = group_by_step,
    page = page_window()
  )
)
assert_identical(group_by_preview$kind, "stepPreview", "R Group By did not preview")
assert_identical(
  group_by_preview$page$frameSemantics$rowNames,
  "positional",
  "R Group By retained source row-name semantics"
)
assert_identical(
  all(vapply(group_by_preview$page$page$rows, function(row) is.null(row$rowLabel), logical(1L))),
  TRUE,
  "R Group By retained source row labels"
)
assert_identical(group_by_preview$page$shape$rows, 10L, "R Group By returned the wrong row-identity domain")
assert_identical(group_by_preview$page$page$totalRows, 3L, "R Group By returned the wrong group count")
assert_identical(group_by_preview$diff$addedRows, 3L, "R Group By did not report its replacement rows")
assert_identical(group_by_preview$diff$removedRows, 7L, "R Group By did not report all replaced source rows")
assert_identical(
  unlist(group_by_preview$diff$addedColumns, use.names = FALSE),
  vapply(group_by_aggregations, `[[`, character(1L), "alias", USE.NAMES = FALSE),
  "R Group By reported the wrong added columns"
)
assert_identical(
  unlist(group_by_preview$diff$removedColumns, use.names = FALSE),
  c("number", "label", "ordered_label", "when", "flag"),
  "R Group By reported the wrong removed columns"
)
assert_identical(group_by_preview$diff$changedCells, 0L, "R Group By reported cell-level changes")
assert_identical(group_by_preview$diff$truncated, FALSE, "a complete R Group By diff was marked truncated")
assert_identical(
  unlist(group_by_preview$page$page$columnIds, use.names = FALSE),
  c("r:c:0", paste0("c:step:group-by-step:", 0:16)),
  "R Group By returned unstable output identities"
)
assert_identical(
  vapply(group_by_preview$page$schema, `[[`, character(1L), "rawType", USE.NAMES = FALSE),
  c(
    "double", "integer", "double", "double", "integer", "integer", "integer", "integer", "integer",
    "integer", "character", "character", "ordered factor", "ordered factor", "Date", "Date", "logical", "logical"
  ),
  "R Group By returned the wrong output types"
)
group_cells <- lapply(group_by_preview$page$page$rows, function(row) row$values[[1L]])
assert_identical(
  vapply(group_cells[1:2], function(cell) as.double(cell$raw), double(1L)),
  c(2, 1),
  "R Group By did not retain first-seen group order"
)
assert_identical(group_cells[[3L]]$isNull, TRUE, "R Group By did not combine NA and NaN into one missing group")
missing_group_values <- group_by_preview$page$page$rows[[3L]]$values
assert_identical(as.integer(missing_group_values[[2L]]$raw), 0L, "an all-missing integer group did not sum to zero")
assert_identical(missing_group_values[[3L]]$isNull, TRUE, "an all-missing group mean was not missing")
assert_identical(missing_group_values[[4L]]$isNull, TRUE, "an all-missing group median was not missing")
assert_identical(as.integer(missing_group_values[[7L]]$raw), 0L, "an all-missing group count was not zero")
assert_identical(as.integer(missing_group_values[[8L]]$raw), 0L, "an all-missing distinct count was not zero")

group_by_apply <- dispatch(
  "applyDraft",
  list(sessionId = group_by_session_id, revision = 1L, page = page_window())
)
assert_identical(group_by_apply$action, "apply", "the R Group By draft did not apply")
if (!grepl(".ow_group_by", group_by_apply$code, fixed = TRUE)) {
  stop("generated R Group By code omitted its native reducer", call. = FALSE)
}
assign("group_by_frame", source_environment$group_by_frame, envir = .GlobalEnv)
eval(parse(text = group_by_apply$code), envir = .GlobalEnv)
group_by_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(group_by_generated$group[1:2], c(2, 1), "generated R Group By changed group order")
assert_identical(is.na(group_by_generated$group[[3L]]), TRUE, "generated R Group By split the missing group")
assert_identical(group_by_generated$number_sum, c(15L, 6L, 0L), "generated R Group By changed integer sums")
assert_identical(group_by_generated$number_mean, c(5, 3, NA_real_), "generated R Group By changed means")
assert_identical(group_by_generated$number_median, c(4, 3, NA_real_), "generated R Group By changed medians")
assert_identical(group_by_generated$number_min, c(1L, 2L, NA_integer_), "generated R Group By changed minima")
assert_identical(group_by_generated$number_max, c(10L, 4L, NA_integer_), "generated R Group By changed maxima")
assert_identical(group_by_generated$number_count, c(3L, 2L, 0L), "generated R Group By changed counts")
assert_identical(group_by_generated$number_unique, c(3L, 2L, 0L), "generated R Group By changed distinct counts")
assert_identical(group_by_generated$number_first, c(1L, 2L, NA_integer_), "generated R Group By changed first values")
assert_identical(group_by_generated$number_last, c(10L, 4L, NA_integer_), "generated R Group By changed last values")
assert_identical(group_by_generated$label_min, c("z", "a", "a"), "generated R Group By changed factor minima")
assert_identical(group_by_generated$label_max, c("z", "b", "c"), "generated R Group By changed factor maxima")
assert_identical(is.ordered(group_by_generated$ordered_min), TRUE, "generated R Group By lost ordered factors")
assert_identical(inherits(group_by_generated$date_min, "Date"), TRUE, "generated R Group By lost Date extrema")
assert_identical(is.logical(group_by_generated$flag_min), TRUE, "generated R Group By lost logical extrema")
assert_identical(
  .row_names_info(group_by_generated, type = 1L) < 0L,
  TRUE,
  "generated R Group By retained source row-name semantics"
)
assert_identical(
  get("group_by_frame", envir = .GlobalEnv, inherits = FALSE),
  group_by_source_before,
  "generated R Group By mutated its source dataframe"
)
rm("group_by_frame", "open_wrangler_result", envir = .GlobalEnv)

group_by_filter_view <- page_window(
  filters = list(list(
    column = list(id = "c:step:group-by-step:1", name = "number_mean"),
    type = "float",
    predicates = I(list(list(kind = "predicate", operator = "gt", value = 3L)))
  ))
)
group_by_filtered_step <- unserialize(serialize(group_by_step, NULL, version = 3L))
group_by_filtered_step$params$aggregations[[2L]]$operation <- "median"
source_materializations_before_edit <- group_by_source_materializations
group_by_filter_edit_preview <- dispatch(
  "previewStep",
  list(
    sessionId = group_by_session_id,
    revision = group_by_apply$revision,
    step = group_by_filtered_step,
    replaceStepId = "group-by-step",
    page = group_by_filter_view
  )
)
assert_identical(
  group_by_filter_edit_preview$kind,
  "stepPreview",
  "editing R Group By applied an aggregation-output filter to its source input"
)
assert_identical(
  group_by_source_materializations,
  source_materializations_before_edit,
  "editing R Group By materialized the source just to determine diff truncation"
)
assert_identical(
  group_by_filter_edit_preview$page$page$totalRows,
  1L,
  "the edited R Group By lost its aggregation-output filter"
)
assert_identical(
  as.double(group_by_filter_edit_preview$page$page$rows[[1L]]$values[[3L]]$raw),
  4,
  "the edited R Group By did not execute the replacement median"
)
assert_identical(
  group_by_filter_edit_preview$diff$truncated,
  TRUE,
  "a filtered R Group By replacement diff was complete"
)
assign("group_by_frame", source_environment$group_by_frame, envir = .GlobalEnv)
eval(parse(text = group_by_filter_edit_preview$code), envir = .GlobalEnv)
group_by_filtered_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  group_by_filtered_generated$number_mean,
  c(4, 3, NA_real_),
  "generated R Group By did not match the filtered live replacement"
)
rm("group_by_frame", "open_wrangler_result", envir = .GlobalEnv)
group_by_filter_edit_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = group_by_session_id,
    revision = group_by_filter_edit_preview$revision,
    page = group_by_filter_view
  )
)
assert_identical(group_by_filter_edit_apply$action, "apply", "the filtered R Group By replacement did not apply")

group_by_sort_view <- page_window(
  sorts = list(list(
    column = list(id = "c:step:group-by-step:1", name = "number_mean"),
    direction = "desc",
    nulls = "last"
  ))
)
group_by_sorted_step <- unserialize(serialize(group_by_filtered_step, NULL, version = 3L))
group_by_sorted_step$params$aggregations[[2L]]$operation <- "mean"
source_materializations_before_edit <- group_by_source_materializations
group_by_sort_edit_preview <- dispatch(
  "previewStep",
  list(
    sessionId = group_by_session_id,
    revision = group_by_filter_edit_apply$revision,
    step = group_by_sorted_step,
    replaceStepId = "group-by-step",
    page = group_by_sort_view
  )
)
assert_identical(group_by_sort_edit_preview$kind, "stepPreview", "editing R Group By lost its output sort")
assert_identical(
  group_by_source_materializations,
  source_materializations_before_edit,
  "sorting an edited R Group By materialized its source for the replacement diff"
)
assert_identical(group_by_sort_edit_preview$diff$truncated, FALSE, "a complete sorted replacement diff was truncated")
assert_identical(
  vapply(
    group_by_sort_edit_preview$page$page$rows[1:2],
    function(row) as.double(row$values[[1L]]$raw),
    double(1L)
  ),
  c(2, 1),
  "the edited R Group By did not sort its aggregation output"
)
assign("group_by_frame", source_environment$group_by_frame, envir = .GlobalEnv)
eval(parse(text = group_by_sort_edit_preview$code), envir = .GlobalEnv)
group_by_sorted_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  group_by_sorted_generated$number_mean,
  c(5, 3, NA_real_),
  "generated R Group By did not match the sorted live replacement"
)
rm("group_by_frame", "open_wrangler_result", envir = .GlobalEnv)
group_by_edit_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = group_by_session_id,
    revision = group_by_sort_edit_preview$revision,
    page = group_by_sort_view
  )
)
assert_identical(group_by_edit_apply$action, "apply", "the sorted R Group By replacement did not apply")

group_by_parquet_ready <- dispatch(
  "exportData",
  list(
    sessionId = group_by_session_id,
    revision = group_by_edit_apply$revision,
    exportId = group_by_export_id,
    format = "parquet"
  )
)
assert_identical(group_by_parquet_ready$kind, "dataExported", "the grouped R result did not export to Parquet")
assert_identical(group_by_parquet_ready$rows, 3L, "the retained view changed the grouped Parquet export")
group_by_parquet_bytes <- raw()
group_by_parquet_offset <- 0L
while (group_by_parquet_offset < group_by_parquet_ready$bytes) {
  group_by_parquet_chunk <- dispatch(
    "readDataExport",
    list(
      sessionId = group_by_session_id,
      revision = group_by_edit_apply$revision,
      exportId = group_by_export_id,
      offset = group_by_parquet_offset,
      limit = 1024L
    )
  )
  group_by_parquet_decoded <- jsonlite::base64_dec(group_by_parquet_chunk$data)
  group_by_parquet_bytes <- c(group_by_parquet_bytes, group_by_parquet_decoded)
  group_by_parquet_offset <- group_by_parquet_offset + group_by_parquet_chunk$bytes
}
group_by_parquet_target <- tempfile(fileext = ".parquet")
writeBin(group_by_parquet_bytes, group_by_parquet_target)
group_by_parquet_frame <- nanoparquet::read_parquet(
  group_by_parquet_target,
  options = nanoparquet::parquet_options(class = "data.frame")
)
unlink(group_by_parquet_target)
assert_identical(
  names(group_by_parquet_frame),
  c("group", vapply(group_by_aggregations, `[[`, character(1L), "alias")),
  "grouped Parquet export changed aliases"
)
assert_identical(group_by_parquet_frame$number_mean, c(5, 3, NA_real_), "grouped Parquet export changed means")
assert_identical(source_environment$group_by_frame, group_by_source_before, "grouped Parquet export mutated its source")
invisible(dispatch(
  "closeDataExport",
  list(
    sessionId = group_by_session_id,
    revision = group_by_edit_apply$revision,
    exportId = group_by_export_id
  )
))

group_by_inspection <- inspect_step(
  group_by_session_id,
  group_by_edit_apply$revision,
  "group-by-step",
  page_window(),
  input_row_count = 7L,
  output_row_count = 3L
)
assert_schema_less_inspection(group_by_inspection, "R Group By inspection")
assert_identical(group_by_inspection$outputPage$page$totalRows, 3L, "R Group By inspection lost its output groups")
group_by_undo <- dispatch(
  "undoStep",
  list(sessionId = group_by_session_id, revision = group_by_edit_apply$revision, page = page_window())
)
assert_identical(group_by_undo$action, "undo", "R Group By did not undo")
assert_identical(group_by_undo$page$shape$rows, 7L, "undoing R Group By did not restore the source rows")
assert_identical(
  group_by_undo$page$frameSemantics$rowNames,
  "explicit",
  "undoing R Group By did not restore explicit row-name semantics"
)
assert_identical(group_by_undo$code, "", "undoing the final R Group By step retained generated code")
assert_identical(source_environment$group_by_frame, group_by_source_before, "R Group By mutated its live source")
group_by_closed <- dispatch("closeSession", list(sessionId = group_by_session_id))
assert_identical(group_by_closed$kind, "closed", "the R Group By session did not close")

source_environment$group_by_precision <- data.frame(
  case = c("cancel", "cancel", "odd", "odd", "odd", "same", "same"),
  value = bit64::as.integer64(c(
    "9223372036854775806", "-9223372036854775805",
    "-9223372036854775805", "2", "9223372036854775806",
    "9223372036854775802", "9223372036854775806"
  )),
  stringsAsFactors = FALSE
)
group_by_precision_before <- unserialize(serialize(source_environment$group_by_precision, NULL, version = 3L))
group_by_precision_open <- dispatch(
  "openSession",
  list(sessionId = group_by_precision_session_id, variableName = "group_by_precision", page = page_window())
)
assert_identical(group_by_precision_open$kind, "page", "the integer64 Group By session did not open")
group_by_precision_step <- list(
  id = "group-by-precision",
  kind = "groupBy",
  params = list(
    keys = I(list(list(id = "r:c:0", name = "case"))),
    aggregations = I(list(
      list(column = list(id = "r:c:1", name = "value"), operation = "mean", alias = "value_mean"),
      list(column = list(id = "r:c:1", name = "value"), operation = "median", alias = "value_median")
    ))
  )
)
group_by_precision_preview <- dispatch(
  "previewStep",
  list(
    sessionId = group_by_precision_session_id,
    revision = 0L,
    step = group_by_precision_step,
    page = page_window()
  )
)
assert_identical(group_by_precision_preview$kind, "stepPreview", "integer64 Group By did not preview")
group_by_precision_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = group_by_precision_session_id,
    revision = group_by_precision_preview$revision,
    page = page_window()
  )
)
assign("group_by_precision", source_environment$group_by_precision, envir = .GlobalEnv)
eval(parse(text = group_by_precision_apply$code), envir = .GlobalEnv)
group_by_precision_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
same_sign_midpoint <- suppressWarnings(as.double(bit64::as.integer64("9223372036854775804")))
assert_identical(
  group_by_precision_generated$value_mean,
  c(0.5, 1, same_sign_midpoint),
  "generated integer64 Group By mean lost cancellation, odd-count, or same-sign precision"
)
assert_identical(
  group_by_precision_generated$value_median,
  c(0.5, 2, same_sign_midpoint),
  "generated integer64 Group By median lost cancellation, odd-count, or same-sign precision"
)
preview_precision_values <- lapply(group_by_precision_preview$page$page$rows, function(row) {
  vapply(row$values[2:3], function(cell) as.double(cell$raw), double(1L))
})
assert_identical(
  preview_precision_values,
  list(c(0.5, 0.5), c(1, 2), c(same_sign_midpoint, same_sign_midpoint)),
  "live integer64 Group By disagreed with generated cancellation, odd-count, or same-sign results"
)
assert_identical(
  source_environment$group_by_precision,
  group_by_precision_before,
  "integer64 Group By mutated its source dataframe"
)
rm("group_by_precision", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = group_by_precision_session_id)))

source_environment$group_by_overflow <- data.frame(group = c("a", "a"), value = c(2147483647L, 1L))
group_by_overflow_open <- dispatch(
  "openSession",
  list(sessionId = group_by_overflow_session_id, variableName = "group_by_overflow", page = page_window())
)
assert_identical(group_by_overflow_open$kind, "page", "the R Group By overflow session did not open")
group_by_overflow <- dispatch(
  "previewStep",
  list(
    sessionId = group_by_overflow_session_id,
    revision = 0L,
    step = list(
      id = "group-overflow",
      kind = "groupBy",
      params = list(
        keys = I(list(list(id = "r:c:0", name = "group"))),
        aggregations = I(list(list(
          column = list(id = "r:c:1", name = "value"),
          operation = "sum",
          alias = "total"
        )))
      )
    ),
    page = page_window()
  )
)
assert_identical(group_by_overflow$kind, "error", "R Group By accepted an overflowing integer sum")
assert_identical(group_by_overflow$code, "invalid_request", "R Group By normalized overflow incorrectly")
assert_identical(
  source_environment$group_by_overflow,
  data.frame(group = c("a", "a"), value = c(2147483647L, 1L)),
  "a failed R Group By mutated its source"
)
group_by_overflow_closed <- dispatch("closeSession", list(sessionId = group_by_overflow_session_id))
assert_identical(group_by_overflow_closed$kind, "closed", "the failed R Group By session did not close")

source_environment$export_frame <- data.frame(
  "order id" = c(3L, 1L, 2L),
  duplicate = factor(c("gamma", "alpha", "beta")),
  duplicate = c("third", "first", "second"),
  when = as.Date(c("2026-01-03", "2026-01-01", "2026-01-02")),
  at = as.POSIXct(c("2026-01-03 12:00:00", "2026-01-01 10:00:00", "2026-01-02 11:00:00"), tz = "UTC"),
  value = c(NA_real_, NaN, Inf),
  check.names = FALSE
)
export_source_before <- unserialize(serialize(source_environment$export_frame, NULL, version = 3L))
export_open <- dispatch(
  "openSession",
  list(sessionId = export_session_id, variableName = "export_frame", page = page_window())
)
assert_identical(export_open$kind, "page", "the R export session did not open")
export_preview <- dispatch(
  "previewStep",
  list(
    sessionId = export_session_id,
    revision = 0L,
    step = list(
      id = "export-rename",
      kind = "renameColumn",
      params = list(column = list(id = "r:c:0", name = "order id"), newName = "order_id")
    ),
    page = page_window()
  )
)
export_apply <- dispatch(
  "applyDraft",
  list(sessionId = export_session_id, revision = export_preview$revision, page = page_window())
)
export_pending <- dispatch(
  "previewStep",
  list(
    sessionId = export_session_id,
    revision = export_apply$revision,
    step = list(
      id = "pending-export-rename",
      kind = "renameColumn",
      params = list(column = list(id = "r:c:1", name = "duplicate"), newName = "pending")
    ),
    page = page_window()
  )
)
blocked_export <- dispatch(
  "exportData",
  list(sessionId = export_session_id, revision = export_pending$revision, exportId = export_id, format = "csv")
)
assert_identical(blocked_export$kind, "error", "the R agent exported a pending draft")
export_discard <- dispatch(
  "discardDraft",
  list(sessionId = export_session_id, revision = export_pending$revision, page = page_window())
)
stale_export <- dispatch(
  "exportData",
  list(sessionId = export_session_id, revision = export_pending$revision, exportId = export_id, format = "csv")
)
assert_identical(stale_export$kind, "error", "the R agent accepted a stale export revision")
assert_identical(stale_export$code, "stale_revision", "the stale export diagnostic changed")

invisible(dispatch(
  "getPage",
  list(
    sessionId = export_session_id,
    page = page_window(
      filters = list(list(
        column = list(id = "r:c:0", name = "order_id"),
        type = "integer",
        predicates = I(list(list(kind = "predicate", operator = "gt", value = 2L)))
      )),
      sorts = list(list(
        column = list(id = "r:c:0", name = "order_id"),
        direction = "asc",
        nulls = "last"
      ))
    )
  )
))
export_ready <- dispatch(
  "exportData",
  list(sessionId = export_session_id, revision = export_discard$revision, exportId = export_id, format = "csv")
)
assert_identical(export_ready$kind, "dataExported", "the R agent did not prepare a CSV export")
assert_identical(export_ready$rows, 3L, "viewing state changed the exported row count")
assert_identical(export_ready$columns, 6L, "the R export returned the wrong width")

first_chunk <- dispatch(
  "readDataExport",
  list(sessionId = export_session_id, revision = export_discard$revision, exportId = export_id, offset = 0L, limit = 11L)
)
repeated_first_chunk <- dispatch(
  "readDataExport",
  list(sessionId = export_session_id, revision = export_discard$revision, exportId = export_id, offset = 0L, limit = 11L)
)
assert_identical(first_chunk$data, repeated_first_chunk$data, "an offset-addressed export chunk was not idempotent")
canonical_chunk <- dispatch(
  "readDataExport",
  list(
    sessionId = export_session_id,
    revision = export_discard$revision,
    exportId = export_id,
    offset = 0L,
    limit = min(1024L, as.integer(export_ready$bytes))
  )
)
decoded_canonical_chunk <- jsonlite::base64_dec(canonical_chunk$data)
expected_canonical_chunk <- gsub(
  "\r",
  "",
  gsub("\n", "", jsonlite::base64_enc(decoded_canonical_chunk), fixed = TRUE),
  fixed = TRUE
)
assert_identical(grepl("[\r\n]", canonical_chunk$data), FALSE, "an R export chunk contained wrapped base64")
assert_identical(nchar(canonical_chunk$data) %% 4L, 0L, "an R export chunk had an invalid base64 length")
assert_identical(canonical_chunk$data, expected_canonical_chunk, "an R export chunk was not canonical base64")
assert_identical(length(decoded_canonical_chunk), canonical_chunk$bytes, "the canonical R export chunk changed length")
csv_bytes <- raw()
offset <- 0L
while (offset < export_ready$bytes) {
  chunk <- dispatch(
    "readDataExport",
    list(
      sessionId = export_session_id,
      revision = export_discard$revision,
      exportId = export_id,
      offset = offset,
      limit = 11L
    )
  )
  assert_identical(chunk$offset, offset, "the R export chunk changed its requested offset")
  decoded <- jsonlite::base64_dec(chunk$data)
  assert_identical(length(decoded), chunk$bytes, "the R export chunk byte count changed")
  csv_bytes <- c(csv_bytes, decoded)
  offset <- offset + chunk$bytes
}
assert_identical(length(csv_bytes), export_ready$bytes, "the R export stream was truncated")
csv_frame <- utils::read.csv(
  text = rawToChar(csv_bytes),
  check.names = FALSE,
  stringsAsFactors = FALSE,
  na.strings = ""
)
assert_identical(names(csv_frame), c("order_id", "duplicate", "duplicate", "when", "at", "value"), "CSV export changed column names")
assert_identical(csv_frame[[1L]], c(3L, 1L, 2L), "viewing filters or sorts changed the committed CSV")
assert_identical(csv_frame[[2L]], c("gamma", "alpha", "beta"), "CSV export changed factor labels")
assert_identical(source_environment$export_frame, export_source_before, "CSV export mutated its R source")
export_closed <- dispatch(
  "closeDataExport",
  list(sessionId = export_session_id, revision = export_discard$revision, exportId = export_id)
)
assert_identical(export_closed$kind, "dataExportClosed", "the R export artifact did not close")
export_closed_again <- dispatch(
  "closeDataExport",
  list(sessionId = export_session_id, revision = export_discard$revision, exportId = export_id)
)
assert_identical(export_closed_again$kind, "dataExportClosed", "closing an R export was not idempotent")

parquet_ready <- dispatch(
  "exportData",
  list(
    sessionId = export_session_id,
    revision = export_discard$revision,
    exportId = parquet_export_id,
    format = "parquet"
  )
)
assert_identical(parquet_ready$kind, "dataExported", "the R agent did not prepare a Parquet export")
assert_identical(parquet_ready$format, "parquet", "the R agent changed the Parquet export format")
assert_identical(parquet_ready$rows, 3L, "viewing state changed the Parquet export row count")
assert_identical(parquet_ready$columns, 6L, "the Parquet export returned the wrong width")
parquet_bytes <- raw()
offset <- 0L
while (offset < parquet_ready$bytes) {
  chunk <- dispatch(
    "readDataExport",
    list(
      sessionId = export_session_id,
      revision = export_discard$revision,
      exportId = parquet_export_id,
      offset = offset,
      limit = 13L
    )
  )
  decoded <- jsonlite::base64_dec(chunk$data)
  assert_identical(length(decoded), chunk$bytes, "the R Parquet export chunk byte count changed")
  parquet_bytes <- c(parquet_bytes, decoded)
  offset <- offset + chunk$bytes
}
assert_identical(length(parquet_bytes), parquet_ready$bytes, "the R Parquet export stream was truncated")
assert_identical(parquet_bytes[seq_len(4L)], charToRaw("PAR1"), "the R Parquet export has an invalid header")
assert_identical(tail(parquet_bytes, 4L), charToRaw("PAR1"), "the R Parquet export has an invalid footer")
parquet_target <- tempfile(fileext = ".parquet")
writeBin(parquet_bytes, parquet_target)
parquet_frame <- nanoparquet::read_parquet(
  parquet_target,
  options = nanoparquet::parquet_options(class = "data.frame")
)
unlink(parquet_target)
assert_identical(
  names(parquet_frame),
  c("order_id", "duplicate", "duplicate", "when", "at", "value"),
  "Parquet export changed duplicate or renamed columns"
)
assert_identical(parquet_frame[[1L]], c(3L, 1L, 2L), "viewing filters or sorts changed the committed Parquet data")
assert_identical(as.character(parquet_frame[[2L]]), c("gamma", "alpha", "beta"), "Parquet export changed factor labels")
assert_identical(
  as.numeric(parquet_frame[[4L]]),
  as.numeric(source_environment$export_frame[[4L]]),
  "Parquet export changed Date values"
)
assert_identical(
  as.numeric(parquet_frame[[5L]]),
  as.numeric(source_environment$export_frame[[5L]]),
  "Parquet export changed POSIXct instants"
)
assert_identical(source_environment$export_frame, export_source_before, "Parquet export mutated its R source")
parquet_closed <- dispatch(
  "closeDataExport",
  list(sessionId = export_session_id, revision = export_discard$revision, exportId = parquet_export_id)
)
assert_identical(parquet_closed$kind, "dataExportClosed", "the R Parquet export artifact did not close")

cleanup_ready <- dispatch(
  "exportData",
  list(sessionId = export_session_id, revision = export_discard$revision, exportId = cleanup_export_id, format = "csv")
)
assert_identical(cleanup_ready$kind, "dataExported", "the cleanup export was not prepared")
export_session_closed <- dispatch("closeSession", list(sessionId = export_session_id))
assert_identical(export_session_closed$kind, "closed", "closing the R session with an export failed")
cleanup_read <- dispatch(
  "readDataExport",
  list(sessionId = export_session_id, revision = export_discard$revision, exportId = cleanup_export_id, offset = 0L, limit = 1L)
)
assert_identical(cleanup_read$kind, "error", "closing the R session retained its export artifact")

unavailable_write_count <- 0L
unavailable_parquet_contract <- openwrangler_r_frame_contract
unavailable_parquet_contract$export_formats <- function() "csv"
unavailable_parquet_contract$write_parquet <- function(...) {
  unavailable_write_count <<- unavailable_write_count + 1L
  stop("unexpected unavailable Parquet writer", call. = FALSE)
}
unavailable_parquet_agent <- openwrangler_r_kernel_agent$new_agent(
  unavailable_parquet_contract,
  source_environment
)
unavailable_open <- dispatch_with(
  unavailable_parquet_agent,
  "openSession",
  list(sessionId = unavailable_export_session_id, variableName = "export_frame", page = page_window())
)
assert_identical(unavailable_open$kind, "page", "the CSV-only R export session did not open")
assert_identical(unavailable_open$exportFormats, list("csv"), "the CSV-only R session advertised Parquet")
unavailable_parquet <- dispatch_with(
  unavailable_parquet_agent,
  "exportData",
  list(
    sessionId = unavailable_export_session_id,
    revision = 0L,
    exportId = parquet_export_id,
    format = "parquet"
  )
)
assert_identical(unavailable_parquet$kind, "error", "the R agent accepted unavailable Parquet export")
assert_identical(unavailable_parquet$code, "missing_package", "the unavailable Parquet diagnostic changed")
assert_identical(unavailable_parquet$recoverable, TRUE, "the unavailable Parquet diagnostic was not recoverable")
assert_identical(unavailable_write_count, 0L, "the R agent called an unavailable Parquet writer")
invisible(dispatch_with(
  unavailable_parquet_agent,
  "closeSession",
  list(sessionId = unavailable_export_session_id)
))
unavailable_parquet_agent$dispose()

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

agent$dispose()
missing_package_agent$dispose()

cat("Native R kernel agent tests passed.\n")
