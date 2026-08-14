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
scale_session_id <- "73737373-7373-4373-8373-737373737373"
scale_table_session_id <- "74747474-7474-4474-8474-747474747474"
scale_tibble_session_id <- "75757575-7575-4575-8575-757575757575"
scale_collapse_frame_session_id <- "76767676-7676-4676-8676-767676767676"
scale_collapse_tibble_session_id <- "78787878-7878-4878-8878-787878787878"
scale_collapse_table_session_id <- "79797979-7979-4979-8979-797979797979"
group_by_session_id <- "61616161-6161-4161-8161-616161616161"
group_by_overflow_session_id <- "62626262-6262-4262-8262-626262626262"
group_by_precision_session_id <- "63636363-6363-4363-8363-636363636363"
group_by_export_id <- "64646464-6464-4464-8464-646464646464"
group_by_tibble_session_id <- "65656565-6565-4565-8565-656565656565"
group_by_table_session_id <- "67676767-6767-4767-8767-676767676767"
profile_scale_session_id <- "68686868-6868-4868-8868-686868686868"
formula_session_id <- "80808080-8080-4080-8080-808080808080"
formula_failure_session_id <- "81818181-8181-4181-8181-818181818181"
formula_integer64_session_id <- "91919191-9191-4191-8191-919191919191"
formula_nullability_session_id <- "92929292-9292-4292-8292-929292929292"
formula_nonfinite_session_id <- "93939393-9393-4393-8393-939393939393"
datetime_session_id <- "82828282-8282-4282-8282-828282828282"
datetime_table_session_id <- "83838383-8383-4383-8383-838383838383"
datetime_output_budget_session_id <- "96969696-9696-4696-8696-969696969696"
datetime_output_oversize_session_id <- "97979797-9797-4797-8797-979797979797"
datetime_replay_session_id <- "98989898-9898-4898-8898-989898989898"
formula_datetime_base_session_id <- "84848484-8484-4484-8484-848484848484"
formula_datetime_tibble_session_id <- "85858585-8585-4585-8585-858585858585"
formula_datetime_table_session_id <- "86868686-8686-4686-8686-868686868686"
formula_datetime_collapse_frame_session_id <- "87878787-8787-4787-8787-878787878787"
formula_datetime_collapse_tibble_session_id <- "89898989-8989-4989-8989-898989898989"
formula_datetime_collapse_table_session_id <- "90909090-9090-4090-8090-909090909090"
formula_datetime_named_session_id <- "94949494-9494-4494-8494-949494949494"
formula_datetime_readr_session_id <- "95959595-9595-4595-8595-959595959595"
one_hot_session_id <- "abababab-abab-4bab-8bab-abababababab"
multi_label_session_id <- "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
categorical_table_session_id <- "dededede-dede-4ede-8ede-dededededede"
categorical_scalar_session_id <- "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc"
categorical_error_session_id <- "efefefef-efef-4fef-8fef-efefefefefef"
categorical_empty_session_id <- "acacacac-acac-4cac-8cac-acacacacacac"
categorical_family_session_ids <- c(
  "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
  "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2",
  "a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3"
)

source_environment <- new.env(parent = emptyenv())
source_environment$frame <- data.frame(
  group = c("b", "a", "a"),
  score = c(1, NA, 2),
  stringsAsFactors = FALSE
)
source_environment$profile_scale <- data.frame(value = rep(FALSE, 1000001L))
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
    list(transportVersion = 12L, requestId = id, kind = kind, payload = payload),
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

scale_opened <- dispatch(
  "openSession",
  list(sessionId = profile_scale_session_id, variableName = "profile_scale", page = page_window(row_limit = 1L))
)
assert_identical(scale_opened$kind, "page", "the R agent refused a frame above the profile sample size")
scale_summary <- dispatch(
  "getSummary",
  list(
    sessionId = profile_scale_session_id,
    columns = I(list(list(id = "r:c:0", name = "value"))),
    view = empty_view()
  )
)
assert_identical(
  scale_summary$summaries[[1L]]$visualization$falseCount,
  1000001L,
  "the R agent sampled a cheap logical count"
)
scale_stats <- dispatch("getDatasetStats", list(sessionId = profile_scale_session_id, view = empty_view()))
assert_identical(
  scale_stats$stats$duplicateRowsSampleSize,
  100000L,
  "the R agent omitted the duplicate-row sample size"
)
assert_identical(scale_stats$stats$duplicateRows, 99999L, "the R agent changed sampled duplicate counts")
scale_values <- dispatch(
  "getColumnValues",
  list(
    sessionId = profile_scale_session_id,
    column = list(id = "r:c:0", name = "value"),
    view = empty_view(),
    search = NULL,
    limit = 100L
  )
)
assert_identical(scale_values$kind, "columnValues", "the R agent refused large initial value discovery")
assert_identical(scale_values$sampleSize, 100000L, "the R agent omitted the value-discovery sample size")
assert_identical(scale_values$hasMore, TRUE, "the R agent claimed sampled values were exhaustive")
assert_identical(scale_values$values[[1L]]$count, 100000L, "the R agent counted values outside its sample")
scale_search <- dispatch(
  "getColumnValues",
  list(
    sessionId = profile_scale_session_id,
    column = list(id = "r:c:0", name = "value"),
    view = empty_view(),
    search = "false",
    limit = 100L
  )
)
assert_identical(scale_search$kind, "columnValues", "the R agent refused a large exact value search")
assert_identical(scale_search$sampleSize, NULL, "the R agent labeled an exact value search as sampled")
assert_identical(scale_search$hasMore, FALSE, "the R agent claimed a complete value search was truncated")
assert_identical(scale_search$values[[1L]]$value, "FALSE", "the R agent changed a large value-search match")
assert_identical(
  scale_search$values[[1L]]$count,
  1000001L,
  "the R agent did not count every row in a large exact value search"
)
scale_closed <- dispatch("closeSession", list(sessionId = profile_scale_session_id))
assert_identical(scale_closed$kind, "closed", "the R agent did not close the large profile session")

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
    step = list(
      id = "unsupported-step",
      kind = "oneHotEncode",
      params = list(
        column = list(id = "r:c:1", name = "duplicate"),
        prefix = "ignored"
      )
    ),
    page = page_window()
  )
)
assert_identical(unsupported_step$kind, "error", "malformed R one-hot parameters were accepted")
assert_identical(unsupported_step$code, "invalid_request", "the malformed one-hot diagnostic changed")
assert_identical(source_environment$rename_frame, rename_source_before, "the R editing lifecycle mutated its source")

source_environment$categorical_frame <- data.frame(
  zeta = factor(c("b", "a", NA, ""), levels = c("a", "b", "", "unused")),
  alpha = c("y", "x", NA_character_, ""),
  value = 1:4,
  check.names = FALSE,
  row.names = paste0("categorical-", 1:4)
)
categorical_source_before <- unserialize(serialize(source_environment$categorical_frame, NULL, version = 3L))
one_hot_step <- list(
  id = "one-hot-step",
  kind = "oneHotEncode",
  params = list(columns = I(list(
    list(id = "r:c:0", name = "zeta"),
    list(id = "r:c:1", name = "alpha")
  )))
)
one_hot_open <- dispatch(
  "openSession",
  list(sessionId = one_hot_session_id, variableName = "categorical_frame", page = page_window())
)
assert_identical(one_hot_open$kind, "page", "the R one-hot session did not open")
one_hot_preview <- dispatch(
  "previewStep",
  list(
    sessionId = one_hot_session_id,
    revision = 0L,
    step = one_hot_step,
    page = page_window()
  )
)
assert_identical(one_hot_preview$kind, "stepPreview", "R one-hot encoding did not preview")
assert_identical(
  vapply(one_hot_preview$page$schema, `[[`, character(1L), "name"),
  c("value", "alpha_x", "alpha_y", "zeta_a", "zeta_b"),
  "R one-hot encoding did not globally order generated UTF-8 names"
)
assert_identical(
  vapply(one_hot_preview$page$schema, `[[`, character(1L), "id"),
  c("r:c:2", paste0("c:step:one-hot-step:", 0:3)),
  "R one-hot encoding assigned unstable generated identities"
)
assert_identical(one_hot_preview$diff$addedColumns, as.list(c("alpha_x", "alpha_y", "zeta_a", "zeta_b")), "R one-hot encoding lost added-column diff names")
assert_identical(one_hot_preview$diff$removedColumns, as.list(c("zeta", "alpha")), "R one-hot encoding lost selected input-order removals")
assert_identical(
  vapply(one_hot_preview$page$schema[-1L], `[[`, logical(1L), "nullable"),
  rep(FALSE, 4L),
  "R one-hot indicators were nullable"
)
one_hot_discard <- dispatch(
  "discardDraft",
  list(sessionId = one_hot_session_id, revision = 1L, page = page_window())
)
assert_identical(one_hot_discard$action, "discard", "the R one-hot draft did not discard")
one_hot_preview <- dispatch(
  "previewStep",
  list(sessionId = one_hot_session_id, revision = 2L, step = one_hot_step, page = page_window())
)
one_hot_apply <- dispatch(
  "applyDraft",
  list(sessionId = one_hot_session_id, revision = 3L, page = page_window())
)
assert_identical(one_hot_apply$action, "apply", "the R one-hot draft did not apply")
one_hot_inspection <- inspect_step(one_hot_session_id, 4L, "one-hot-step", page_window())
assert_identical(one_hot_inspection$kind, "stepInspection", "the applied R one-hot step was not inspectable")
assert_schema_less_inspection(one_hot_inspection, "R one-hot inspection")
assign("categorical_frame", source_environment$categorical_frame, envir = .GlobalEnv)
eval(parse(text = one_hot_apply$code), envir = .GlobalEnv)
one_hot_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  names(one_hot_generated),
  c("value", "alpha_x", "alpha_y", "zeta_a", "zeta_b"),
  "generated R one-hot code returned the wrong schema"
)
assert_identical(one_hot_generated$alpha_x, c(0L, 1L, 0L, 0L), "generated R one-hot code encoded the wrong rows")
assert_identical(one_hot_generated$zeta_b, c(1L, 0L, 0L, 0L), "generated R one-hot code encoded factor levels instead of observed values")
assert_identical(get("categorical_frame", envir = .GlobalEnv), categorical_source_before, "generated R one-hot code mutated its source")
rm("categorical_frame", "open_wrangler_result", envir = .GlobalEnv)
one_hot_undo <- dispatch(
  "undoStep",
  list(sessionId = one_hot_session_id, revision = 4L, page = page_window())
)
assert_identical(one_hot_undo$action, "undo", "the applied R one-hot step did not undo")
assert_identical(one_hot_undo$page$shape$columns, 3L, "undo retained R one-hot outputs")
assert_identical(dispatch("closeSession", list(sessionId = one_hot_session_id))$kind, "closed", "the R one-hot session did not close")

source_environment$categorical_reversed_frame <- data.frame(
  first = c("a", "b"),
  duplicate = c("x", "x"),
  duplicate = c("y", "y"),
  value = 1:2,
  check.names = FALSE
)
categorical_reversed_session_id <- "adadadad-adad-4dad-8dad-adadadadadad"
assert_identical(
  dispatch("openSession", list(sessionId = categorical_reversed_session_id, variableName = "categorical_reversed_frame", page = page_window()))$kind,
  "page",
  "the reversed categorical-reference session did not open"
)
categorical_reversed_preview <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_reversed_session_id,
    revision = 0L,
    step = list(
      id = "categorical-reversed-step",
      kind = "oneHotEncode",
      params = list(columns = I(list(
        list(id = "r:c:2", name = "duplicate"),
        list(id = "r:c:0", name = "first"),
        list(id = "r:c:1", name = "duplicate")
      )))
    ),
    page = page_window()
  )
)
assert_identical(categorical_reversed_preview$kind, "stepPreview", "reversed R one-hot references did not preview")
assert_identical(
  categorical_reversed_preview$diff$removedColumns,
  as.list(c("first", "duplicate", "duplicate")),
  "R one-hot removed-column diffs did not follow source-schema order with duplicate names"
)
assert_identical(
  dispatch("closeSession", list(sessionId = categorical_reversed_session_id))$kind,
  "closed",
  "the reversed categorical-reference session did not close"
)

source_environment$multi_label_frame <- data.frame(
  tags = factor(c(NA, "", "red|β", "red||blue|red"), levels = c("", "red|β", "red||blue|red", "unused")),
  value = 1:4,
  check.names = FALSE
)
multi_label_source_before <- unserialize(serialize(source_environment$multi_label_frame, NULL, version = 3L))
multi_label_step <- list(
  id = "multi-label-step",
  kind = "multiLabelBinarize",
  params = list(
    column = list(id = "r:c:0", name = "tags"),
    delimiter = "|",
    prefix = ""
  )
)
assert_identical(
  dispatch("openSession", list(sessionId = multi_label_session_id, variableName = "multi_label_frame", page = page_window()))$kind,
  "page",
  "the R multi-label session did not open"
)
multi_label_preview <- dispatch(
  "previewStep",
  list(sessionId = multi_label_session_id, revision = 0L, step = multi_label_step, page = page_window())
)
assert_identical(multi_label_preview$kind, "stepPreview", "R multi-label binarization did not preview")
assert_identical(
  vapply(multi_label_preview$page$schema, `[[`, character(1L), "name"),
  c("tags", "value", "blue", "red", "β"),
  "R multi-label binarization trimmed, dropped, or misordered literal tokens"
)
assert_identical(multi_label_preview$diff$removedColumns, list(), "R multi-label default unexpectedly dropped its source")
assert_identical(multi_label_preview$diff$addedColumns, as.list(c("blue", "red", "β")), "R multi-label diff lost generated names")
multi_label_apply <- dispatch(
  "applyDraft",
  list(sessionId = multi_label_session_id, revision = 1L, page = page_window())
)
multi_label_inspection <- inspect_step(multi_label_session_id, 2L, "multi-label-step", page_window())
assert_identical(multi_label_inspection$kind, "stepInspection", "the applied R multi-label step was not inspectable")
assign("multi_label_frame", source_environment$multi_label_frame, envir = .GlobalEnv)
eval(parse(text = multi_label_apply$code), envir = .GlobalEnv)
multi_label_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(names(multi_label_generated), c("tags", "value", "blue", "red", "β"), "generated R multi-label code returned the wrong schema")
assert_identical(multi_label_generated$blue, c(0L, 0L, 0L, 1L), "generated R multi-label code changed literal split semantics")
assert_identical(multi_label_generated$red, c(0L, 0L, 1L, 1L), "generated R multi-label code lost repeated tokens")
assert_identical(get("multi_label_frame", envir = .GlobalEnv), multi_label_source_before, "generated R multi-label code mutated its source")
rm("multi_label_frame", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(dispatch("undoStep", list(sessionId = multi_label_session_id, revision = 2L, page = page_window()))$action, "undo", "the applied R multi-label step did not undo")
assert_identical(dispatch("closeSession", list(sessionId = multi_label_session_id))$kind, "closed", "the R multi-label session did not close")

categorical_indicator_code_position <- regexpr(
  ".ow_generated[[.ow_generated_index]]$values <- as.integer(vapply",
  multi_label_apply$code,
  fixed = TRUE
)[[1L]]
categorical_budget_code_position <- regexpr(
  ".ow_total_output_bytes > .ow_maximum_output_bytes",
  multi_label_apply$code,
  fixed = TRUE
)[[1L]]
assert_identical(
  categorical_budget_code_position > 0L &&
    categorical_indicator_code_position > categorical_budget_code_position,
  TRUE,
  "generated R categorical code did not guard output budgets before indicator construction"
)

categorical_oversized_text <- paste0(rep.int("a|", 4097L), collapse = "")
categorical_oversized_text_frame <- data.frame(
  tags = factor(categorical_oversized_text),
  value = 1L,
  check.names = FALSE
)
categorical_oversized_text_environment <- new.env(parent = baseenv())
assign("multi_label_frame", categorical_oversized_text_frame, envir = categorical_oversized_text_environment)
categorical_oversized_text_error <- tryCatch(
  {
    eval(parse(text = multi_label_apply$code), envir = categorical_oversized_text_environment)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_oversized_text_error, "error"),
  TRUE,
  "generated R multi-label code split an oversized source value"
)
categorical_generated_helper <- get(
  "generated_categorical_encode",
  envir = environment(openwrangler_r_kernel_agent$new_agent),
  inherits = FALSE
)
categorical_generated_helper_environment <- new.env(parent = environment(categorical_generated_helper))
categorical_generated_helper_environment$.ow_storage_length <- base::length
environment(categorical_generated_helper) <- categorical_generated_helper_environment
categorical_helper_oversized_error <- tryCatch(
  {
    categorical_generated_helper(
      categorical_oversized_text_frame,
      "multiLabelBinarize",
      list(list(id = "r:c:0", position = 1L, name = "tags", kind = "factor", storageMode = "integer", classes = "factor", timezone = NULL, units = NULL)),
      NULL,
      "|",
      "",
      FALSE,
      2048L,
      512L,
      8192L,
      16 * 1024 * 1024,
      64 * 1024 * 1024,
      8L,
      1024L,
      512L,
      c("r:c:0", "r:c:1"),
      "test"
    )
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_helper_oversized_error, "error") && grepl("bounded valid UTF-8 text", conditionMessage(categorical_helper_oversized_error), fixed = TRUE),
  TRUE,
  "the generated categorical helper did not reject oversized UTF-8 before token expansion"
)

categorical_metadata_level_lengths <- rep.int(8191L, 2047L)
categorical_metadata_level_lengths[seq_len(1500L)] <- 8192L
categorical_metadata_levels <- vapply(seq_len(2047L), function(index) {
  paste0(sprintf("%04d", index), strrep("x", categorical_metadata_level_lengths[[index]] - 4L))
}, character(1L), USE.NAMES = FALSE)
categorical_metadata_frame <- data.frame(
  retained = factor(NA_integer_, levels = categorical_metadata_levels),
  category = factor("a"),
  check.names = FALSE
)
categorical_metadata_error <- tryCatch(
  {
    categorical_generated_helper(
      categorical_metadata_frame,
      "oneHotEncode",
      list(list(id = "r:c:1", position = 2L, name = "category", kind = "factor", storageMode = "integer", classes = "factor", timezone = NULL, units = NULL)),
      "_",
      NULL,
      NULL,
      FALSE,
      2048L,
      512L,
      8192L,
      16 * 1024 * 1024,
      64 * 1024 * 1024,
      8L,
      1024L,
      512L,
      c("r:c:0", "r:c:1"),
      "metadata"
    )
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_metadata_error, "error") && grepl("metadata is too large", conditionMessage(categorical_metadata_error), fixed = TRUE),
  TRUE,
  "generated R one-hot code ignored full resulting-frame metadata"
)
categorical_identity_levels <- categorical_metadata_levels
categorical_identity_levels[1461:1500] <- substring(
  categorical_identity_levels[1461:1500],
  1L,
  8191L
)
categorical_identity_frame <- data.frame(
  retained = factor(NA_integer_, levels = categorical_identity_levels),
  category = factor("a"),
  check.names = FALSE
)
categorical_identity_error <- tryCatch(
  {
    categorical_generated_helper(
      categorical_identity_frame,
      "oneHotEncode",
      list(list(id = "r:c:1", position = 2L, name = "category", kind = "factor", storageMode = "integer", classes = "factor", timezone = NULL, units = NULL)),
      "_",
      NULL,
      NULL,
      FALSE,
      2048L,
      512L,
      8192L,
      16 * 1024 * 1024,
      64 * 1024 * 1024,
      8L,
      1024L,
      512L,
      c("r:c:0", "r:c:1"),
      "metadata"
    )
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_identity_error, "error") && grepl("metadata is too large", conditionMessage(categorical_identity_error), fixed = TRUE),
  TRUE,
  "generated R one-hot code ignored the global derived-identity metadata delta"
)
categorical_metadata_drop_frame <- categorical_metadata_frame
categorical_metadata_drop_frame$retained <- factor(
  "a",
  levels = c("a", categorical_metadata_levels[-1L])
)
categorical_metadata_drop_generated <- categorical_generated_helper(
  categorical_metadata_drop_frame,
  "oneHotEncode",
  list(list(id = "r:c:0", position = 1L, name = "retained", kind = "factor", storageMode = "integer", classes = "factor", timezone = NULL, units = NULL)),
  "_",
  NULL,
  NULL,
  TRUE,
  2048L,
  512L,
  8192L,
  16 * 1024 * 1024,
  64 * 1024 * 1024,
  8L,
  1024L,
  512L,
  c("r:c:0", "r:c:1"),
  "metadata-drop"
)
categorical_metadata_drop_expected <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
  categorical_metadata_drop_frame,
  1L,
  "retained",
  "_",
  TRUE
)$value
assert_identical(
  categorical_metadata_drop_generated$value,
  categorical_metadata_drop_expected,
  "generated R one-hot metadata accounting did not subtract a dropped near-cap factor"
)
categorical_semantic_metadata_timezone <- strrep("z", 1024L)
categorical_semantic_metadata_frame <- data.frame(
  retained = structure(
    0,
    class = c("POSIXct", "POSIXt"),
    tzone = structure(
      categorical_semantic_metadata_timezone,
      names = "zone",
      class = "AsIs"
    )
  ),
  category = factor("a"),
  check.names = FALSE
)
categorical_semantic_metadata_retain_error <- tryCatch(
  {
    categorical_generated_helper(
      categorical_semantic_metadata_frame,
      "oneHotEncode",
      list(list(
        id = "r:c:1",
        position = 2L,
        name = "category",
        kind = "factor",
        storageMode = "integer",
        classes = "factor",
        timezone = NULL,
        units = NULL
      )),
      "_",
      NULL,
      NULL,
      FALSE,
      2048L,
      1024L,
      8192L,
      3600L,
      64 * 1024 * 1024,
      8L,
      1024L,
      512L,
      c("r:c:0", "r:c:1"),
      "semantic-metadata-retain"
    )
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_semantic_metadata_retain_error, "error") &&
    grepl("metadata is too large", conditionMessage(categorical_semantic_metadata_retain_error), fixed = TRUE),
  TRUE,
  "generated categorical result metadata ignored a retained timezone"
)
categorical_semantic_metadata_drop <- categorical_generated_helper(
  categorical_semantic_metadata_frame,
  "oneHotEncode",
  list(list(
    id = "r:c:0",
    position = 1L,
    name = "retained",
    kind = "datetime",
    storageMode = "double",
    classes = c("POSIXct", "POSIXt"),
    timezone = categorical_semantic_metadata_timezone,
    units = NULL
  )),
  "_",
  NULL,
  NULL,
  TRUE,
  2048L,
  1024L,
  8192L,
  3600L,
  64 * 1024 * 1024,
  8L,
  1024L,
  512L,
  c("r:c:0", "r:c:1"),
  "semantic-metadata-drop"
)
categorical_semantic_metadata_drop_expected <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
  categorical_semantic_metadata_frame,
  1L,
  "retained",
  "_",
  TRUE
)$value
assert_identical(
  categorical_semantic_metadata_drop$value,
  categorical_semantic_metadata_drop_expected,
  "generated categorical result metadata failed to subtract a dropped timezone"
)
categorical_source_metadata_name <- strrep("n", 600L)
source_environment$categorical_source_metadata_frame <- data.frame(
  selected = factor("", levels = ""),
  keep = 1L,
  check.names = FALSE
)
names(source_environment$categorical_source_metadata_frame)[[1L]] <- categorical_source_metadata_name
categorical_source_metadata_session_id <- "afafafaf-afaf-4faf-8faf-afafafafafaf"
assert_identical(
  dispatch("openSession", list(sessionId = categorical_source_metadata_session_id, variableName = "categorical_source_metadata_frame", page = page_window()))$kind,
  "page",
  "the source-metadata categorical session did not open"
)
categorical_source_metadata_step <- list(
  id = "categorical-source-metadata",
  kind = "oneHotEncode",
  params = list(
    columns = I(list(list(id = "r:c:0", name = categorical_source_metadata_name))),
    prefixSeparator = "",
    dropOriginal = TRUE
  )
)
categorical_source_metadata_preview <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_source_metadata_session_id,
    revision = 0L,
    step = categorical_source_metadata_step,
    page = page_window()
  )
)
categorical_source_metadata_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = categorical_source_metadata_session_id,
    revision = categorical_source_metadata_preview$revision,
    page = page_window()
  )
)
categorical_oversized_source <- data.frame(
  selected = factor("", levels = c(categorical_metadata_levels, "")),
  keep = 1L,
  check.names = FALSE
)
names(categorical_oversized_source)[[1L]] <- categorical_source_metadata_name
categorical_oversized_source_before <- serialize(categorical_oversized_source, NULL, version = 3L)
categorical_oversized_live_error <- tryCatch(
  {
    openwrangler_r_frame_contract$capture_frame(categorical_oversized_source)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_oversized_live_error, "error"),
  TRUE,
  "the source-metadata regression fixture did not exceed the live payload budget"
)
categorical_source_metadata_environment <- new.env(parent = baseenv())
assign("categorical_source_metadata_frame", categorical_oversized_source, envir = categorical_source_metadata_environment)
categorical_oversized_generated_error <- tryCatch(
  {
    eval(parse(text = categorical_source_metadata_apply$code), envir = categorical_source_metadata_environment)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_oversized_generated_error, "error"),
  TRUE,
  "generated categorical code erased oversized source metadata before validation"
)
assert_identical(
  serialize(get("categorical_source_metadata_frame", envir = categorical_source_metadata_environment), NULL, version = 3L),
  categorical_oversized_source_before,
  "generated categorical source-metadata validation mutated its source"
)
assert_identical(
  dispatch("closeSession", list(sessionId = categorical_source_metadata_session_id))$kind,
  "closed",
  "the source-metadata categorical session did not close"
)

categorical_timezone_metadata_value <- strrep("z", 1024L)
categorical_timezone_metadata_columns <- setNames(
  lapply(seq_len(2047L), function(index) {
    structure(
      0,
      class = c("POSIXct", "POSIXt"),
      tzone = categorical_timezone_metadata_value
    )
  }),
  sprintf("t%04d", seq_len(2047L))
)
source_environment$categorical_timezone_metadata_frame <- structure(
  c(list(f = factor("a")), categorical_timezone_metadata_columns),
  class = "data.frame",
  row.names = .set_row_names(1L)
)
categorical_timezone_metadata_session_id <- "a5a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5"
assert_identical(
  dispatch(
    "openSession",
    list(
      sessionId = categorical_timezone_metadata_session_id,
      variableName = "categorical_timezone_metadata_frame",
      page = page_window(column_limit = 1L)
    )
  )$kind,
  "page",
  "the timezone-metadata categorical session did not open"
)
categorical_timezone_metadata_preview <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_timezone_metadata_session_id,
    revision = 0L,
    step = list(
      id = "categorical-timezone-metadata",
      kind = "oneHotEncode",
      params = list(
        columns = I(list(list(id = "r:c:1", name = "t0001"))),
        prefixSeparator = "_",
        dropOriginal = TRUE
      )
    ),
    page = page_window(column_limit = 1L)
  )
)
categorical_timezone_metadata_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = categorical_timezone_metadata_session_id,
    revision = categorical_timezone_metadata_preview$revision,
    page = page_window(column_limit = 1L)
  )
)
assert_identical(
  categorical_timezone_metadata_apply$kind,
  "planUpdated",
  "the timezone-metadata categorical plan did not compile"
)
categorical_timezone_metadata_levels <- vapply(seq_len(1657L), function(index) {
  paste0(sprintf("%04d", index), strrep("x", 8186L))
}, character(1L), USE.NAMES = FALSE)
categorical_timezone_metadata_near <- source_environment$categorical_timezone_metadata_frame
categorical_timezone_metadata_near[[1L]] <- factor(
  categorical_timezone_metadata_levels[[1L]],
  levels = categorical_timezone_metadata_levels[seq_len(1656L)]
)
categorical_timezone_metadata_near_before <- serialize(
  categorical_timezone_metadata_near,
  NULL,
  version = 3L
)
categorical_timezone_metadata_near_capture <- openwrangler_r_frame_contract$capture_frame(
  categorical_timezone_metadata_near
)
assert_identical(
  categorical_timezone_metadata_near_capture$metadataBytes,
  16770677,
  "the timezone-metadata boundary fixture no longer sits 6539 bytes below the payload cap"
)
categorical_timezone_metadata_expected <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
  categorical_timezone_metadata_near,
  2L,
  "t0001",
  "_",
  TRUE
)$value
categorical_timezone_metadata_environment <- new.env(parent = baseenv())
assign(
  "categorical_timezone_metadata_frame",
  categorical_timezone_metadata_near,
  envir = categorical_timezone_metadata_environment
)
eval(
  parse(text = categorical_timezone_metadata_apply$code),
  envir = categorical_timezone_metadata_environment
)
categorical_timezone_metadata_generated <- get(
  "open_wrangler_result",
  envir = categorical_timezone_metadata_environment,
  inherits = FALSE
)
assert_identical(
  categorical_timezone_metadata_generated,
  categorical_timezone_metadata_expected,
  "generated categorical code rejected or changed an in-budget timezone-metadata boundary"
)
assert_identical(
  serialize(
    get(
      "categorical_timezone_metadata_frame",
      envir = categorical_timezone_metadata_environment,
      inherits = FALSE
    ),
    NULL,
    version = 3L
  ),
  categorical_timezone_metadata_near_before,
  "generated in-budget timezone-metadata replay mutated its source"
)
categorical_timezone_metadata_oversize <- source_environment$categorical_timezone_metadata_frame
categorical_timezone_metadata_oversize[[1L]] <- factor(
  categorical_timezone_metadata_levels[[1L]],
  levels = categorical_timezone_metadata_levels
)
categorical_timezone_metadata_oversize_before <- serialize(
  categorical_timezone_metadata_oversize,
  NULL,
  version = 3L
)
categorical_timezone_metadata_live_error <- tryCatch(
  {
    openwrangler_r_frame_contract$capture_frame(categorical_timezone_metadata_oversize)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_timezone_metadata_live_error, "error"),
  TRUE,
  "the timezone-metadata oversize fixture remained live-capturable"
)
assign(
  "categorical_timezone_metadata_frame",
  categorical_timezone_metadata_oversize,
  envir = categorical_timezone_metadata_environment
)
categorical_timezone_metadata_generated_error <- tryCatch(
  {
    eval(
      parse(text = categorical_timezone_metadata_apply$code),
      envir = categorical_timezone_metadata_environment
    )
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_timezone_metadata_generated_error, "error"),
  TRUE,
  "generated categorical code ignored oversized timezone metadata"
)
assert_identical(
  serialize(
    get(
      "categorical_timezone_metadata_frame",
      envir = categorical_timezone_metadata_environment,
      inherits = FALSE
    ),
    NULL,
    version = 3L
  ),
  categorical_timezone_metadata_oversize_before,
  "failed generated timezone-metadata validation mutated its source"
)
assert_identical(
  dispatch("closeSession", list(sessionId = categorical_timezone_metadata_session_id))$kind,
  "closed",
  "the timezone-metadata categorical session did not close"
)
rm(list = "categorical_timezone_metadata_frame", envir = source_environment)
rm(
  categorical_metadata_levels,
  categorical_metadata_frame,
  categorical_metadata_drop_frame,
  categorical_identity_levels,
  categorical_identity_frame,
  categorical_oversized_source,
  categorical_oversized_source_before,
  categorical_timezone_metadata_columns,
  categorical_timezone_metadata_environment,
  categorical_timezone_metadata_expected,
  categorical_timezone_metadata_generated,
  categorical_timezone_metadata_levels,
  categorical_timezone_metadata_near,
  categorical_timezone_metadata_near_capture,
  categorical_timezone_metadata_oversize,
  categorical_timezone_metadata_value,
  categorical_semantic_metadata_drop,
  categorical_semantic_metadata_drop_expected,
  categorical_semantic_metadata_frame,
  categorical_semantic_metadata_retain_error,
  categorical_semantic_metadata_timezone,
  categorical_metadata_drop_generated,
  categorical_metadata_drop_expected
)

source_environment$categorical_dynamic_frame <- data.frame(
  cat1 = factor(c("a", "b")),
  cat2 = factor(c("x", "y")),
  keep = 1:2,
  check.names = FALSE
)
categorical_dynamic_session_id <- "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae"
assert_identical(
  dispatch("openSession", list(sessionId = categorical_dynamic_session_id, variableName = "categorical_dynamic_frame", page = page_window()))$kind,
  "page",
  "the dynamic multi-step categorical session did not open"
)
categorical_dynamic_first_step <- list(
  id = "categorical-dynamic-first",
  kind = "oneHotEncode",
  params = list(
    columns = I(list(list(id = "r:c:0", name = "cat1"))),
    dropOriginal = FALSE
  )
)
categorical_dynamic_first_preview <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_dynamic_session_id,
    revision = 0L,
    step = categorical_dynamic_first_step,
    page = page_window()
  )
)
categorical_dynamic_first_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = categorical_dynamic_session_id,
    revision = categorical_dynamic_first_preview$revision,
    page = page_window()
  )
)
categorical_dynamic_second_step <- list(
  id = "categorical-dynamic-second",
  kind = "oneHotEncode",
  params = list(
    columns = I(list(list(id = "r:c:1", name = "cat2"))),
    dropOriginal = FALSE
  )
)
categorical_dynamic_second_preview <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_dynamic_session_id,
    revision = categorical_dynamic_first_apply$revision,
    step = categorical_dynamic_second_step,
    page = page_window()
  )
)
categorical_dynamic_second_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = categorical_dynamic_session_id,
    revision = categorical_dynamic_second_preview$revision,
    page = page_window()
  )
)
categorical_dynamic_changed <- data.frame(
  cat1 = factor(c("a", "b", "c")),
  cat2 = factor(c("x", "y", "z")),
  keep = 1:3,
  check.names = FALSE
)
categorical_dynamic_source_before <- serialize(categorical_dynamic_changed, NULL, version = 3L)
categorical_dynamic_live_first <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
  categorical_dynamic_changed,
  1L,
  "cat1",
  "_",
  FALSE
)$value
categorical_dynamic_live_second <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
  categorical_dynamic_live_first,
  2L,
  "cat2",
  "_",
  FALSE
)$value
categorical_dynamic_environment <- new.env(parent = baseenv())
assign("categorical_dynamic_frame", categorical_dynamic_changed, envir = categorical_dynamic_environment)
eval(parse(text = categorical_dynamic_second_apply$code), envir = categorical_dynamic_environment)
categorical_dynamic_generated <- get("open_wrangler_result", envir = categorical_dynamic_environment, inherits = FALSE)
assert_identical(
  categorical_dynamic_generated,
  categorical_dynamic_live_second,
  "generated multi-step categorical replay did not follow changed dynamic cardinality"
)
assert_identical(
  serialize(get("categorical_dynamic_frame", envir = categorical_dynamic_environment), NULL, version = 3L),
  categorical_dynamic_source_before,
  "generated multi-step categorical replay mutated its changed source"
)
categorical_dynamic_bundle_first <- categorical_generated_helper(
  categorical_dynamic_changed,
  "oneHotEncode",
  list(list(id = "r:c:0", position = 1L, name = "cat1", kind = "factor", storageMode = "integer", classes = "factor", timezone = NULL, units = NULL)),
  "_",
  NULL,
  NULL,
  FALSE,
  2048L,
  512L,
  8192L,
  16 * 1024 * 1024,
  64 * 1024 * 1024,
  8L,
  1024L,
  512L,
  c("r:c:0", "r:c:1", "r:c:2"),
  "categorical-dynamic-first"
)
categorical_dynamic_bundle_second <- categorical_generated_helper(
  categorical_dynamic_bundle_first$value,
  "oneHotEncode",
  list(list(id = "r:c:1", position = 2L, name = "cat2", kind = "factor", storageMode = "integer", classes = "factor", timezone = NULL, units = NULL)),
  "_",
  NULL,
  NULL,
  FALSE,
  2048L,
  512L,
  8192L,
  16 * 1024 * 1024,
  64 * 1024 * 1024,
  8L,
  1024L,
  512L,
  categorical_dynamic_bundle_first$outputIds,
  "categorical-dynamic-second"
)
categorical_dynamic_expected_ids <- c(
  "r:c:0",
  "r:c:1",
  "r:c:2",
  paste0("c:step:categorical-dynamic-first:", 0:2),
  paste0("c:step:categorical-dynamic-second:", 0:2)
)
assert_identical(
  categorical_dynamic_bundle_second$outputIds,
  categorical_dynamic_expected_ids,
  "generated multi-step categorical replay lost dynamically flowing output identities"
)
assert_identical(
  categorical_dynamic_bundle_second$value,
  categorical_dynamic_live_second,
  "generated multi-step categorical helper values diverged from live replay"
)
assert_identical(
  dispatch("closeSession", list(sessionId = categorical_dynamic_session_id))$kind,
  "closed",
  "the dynamic multi-step categorical session did not close"
)

source_environment$categorical_lineage_frame <- data.frame(
  cat = c("a", "b"),
  number = c(10, 20),
  check.names = FALSE
)
categorical_lineage_source_before <- serialize(
  source_environment$categorical_lineage_frame,
  NULL,
  version = 3L
)
categorical_lineage_session_id <- "a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4"
assert_identical(
  dispatch(
    "openSession",
    list(
      sessionId = categorical_lineage_session_id,
      variableName = "categorical_lineage_frame",
      page = page_window()
    )
  )$kind,
  "page",
  "the derived-lineage categorical session did not open"
)
categorical_lineage_first_preview <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_lineage_session_id,
    revision = 0L,
    step = list(
      id = "lineage-category-first",
      kind = "oneHotEncode",
      params = list(
        columns = I(list(list(id = "r:c:0", name = "cat"))),
        prefixSeparator = "_",
        dropOriginal = FALSE
      )
    ),
    page = page_window()
  )
)
categorical_lineage_first_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = categorical_lineage_session_id,
    revision = categorical_lineage_first_preview$revision,
    page = page_window()
  )
)
categorical_lineage_formula_preview <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_lineage_session_id,
    revision = categorical_lineage_first_apply$revision,
    step = list(
      id = "make-calc",
      kind = "formula",
      params = list(
        leftColumn = list(id = "r:c:1", name = "number"),
        operator = "add",
        value = 1,
        newColumn = "calc"
      )
    ),
    page = page_window()
  )
)
categorical_lineage_formula_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = categorical_lineage_session_id,
    revision = categorical_lineage_formula_preview$revision,
    page = page_window()
  )
)
categorical_lineage_final_preview <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_lineage_session_id,
    revision = categorical_lineage_formula_apply$revision,
    step = list(
      id = "lineage-category-final",
      kind = "oneHotEncode",
      params = list(
        columns = I(list(list(id = "c:step:make-calc:0", name = "calc"))),
        prefixSeparator = "_",
        dropOriginal = FALSE
      )
    ),
    page = page_window()
  )
)
categorical_lineage_final_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = categorical_lineage_session_id,
    revision = categorical_lineage_final_preview$revision,
    page = page_window()
  )
)
assert_identical(
  categorical_lineage_final_apply$kind,
  "planUpdated",
  "the derived-lineage categorical plan did not apply"
)
categorical_lineage_changed <- data.frame(
  cat = c("a", "b", "c"),
  number = c(10, 20, 30),
  check.names = FALSE
)
categorical_lineage_changed_before <- serialize(
  categorical_lineage_changed,
  NULL,
  version = 3L
)
categorical_lineage_live_first <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
  categorical_lineage_changed,
  1L,
  "cat",
  "_",
  FALSE
)$value
categorical_lineage_live_formula <- openwrangler_r_frame_contract$formula_column_at(
  categorical_lineage_live_first,
  2L,
  "number",
  "add",
  "calc",
  right_value = 1
)
categorical_lineage_live_final <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
  categorical_lineage_live_formula,
  length(unclass(categorical_lineage_live_formula)),
  "calc",
  "_",
  FALSE
)$value
categorical_lineage_environment <- new.env(parent = baseenv())
assign(
  "categorical_lineage_frame",
  categorical_lineage_changed,
  envir = categorical_lineage_environment
)
eval(
  parse(text = categorical_lineage_final_apply$code),
  envir = categorical_lineage_environment
)
categorical_lineage_generated <- get(
  "open_wrangler_result",
  envir = categorical_lineage_environment,
  inherits = FALSE
)
assert_identical(
  categorical_lineage_generated,
  categorical_lineage_live_final,
  "generated categorical code lost a shifted noncategorical derived-column identity"
)
assert_identical(
  names(categorical_lineage_generated),
  c("cat", "number", "cat_a", "cat_b", "cat_c", "calc", "calc_11", "calc_21", "calc_31"),
  "generated categorical code returned the wrong shifted derived-column schema"
)
assert_identical(
  serialize(
    get("categorical_lineage_frame", envir = categorical_lineage_environment, inherits = FALSE),
    NULL,
    version = 3L
  ),
  categorical_lineage_changed_before,
  "generated shifted-lineage categorical code mutated its source"
)
assert_identical(
  serialize(source_environment$categorical_lineage_frame, NULL, version = 3L),
  categorical_lineage_source_before,
  "the live derived-lineage categorical plan mutated its source"
)
assert_identical(
  dispatch("closeSession", list(sessionId = categorical_lineage_session_id))$kind,
  "closed",
  "the derived-lineage categorical session did not close"
)

categorical_budget_tokens <- sprintf(
  "token-%03d-%s",
  seq_len(100L),
  strrep("x", 55L)
)
categorical_budget_cell <- paste(categorical_budget_tokens, collapse = "|")
categorical_budget_per_row <- 8 +
  sum(nchar(categorical_budget_tokens, type = "bytes") + 8) +
  length(categorical_budget_tokens) * 4
categorical_budget_rows <- floor((64 * 1024 * 1024) / categorical_budget_per_row)
categorical_budget_frame <- data.frame(
  tags = factor(rep.int(categorical_budget_cell, categorical_budget_rows), levels = categorical_budget_cell),
  value = seq_len(categorical_budget_rows),
  check.names = FALSE
)
categorical_budget_environment <- new.env(parent = baseenv())
assign("multi_label_frame", categorical_budget_frame, envir = categorical_budget_environment)
eval(parse(text = multi_label_apply$code), envir = categorical_budget_environment)
categorical_budget_generated <- get("open_wrangler_result", envir = categorical_budget_environment, inherits = FALSE)
assert_identical(
  dim(categorical_budget_generated),
  c(as.integer(categorical_budget_rows), 102L),
  "generated R multi-label code rejected the exact in-budget token boundary"
)
rm("open_wrangler_result", envir = categorical_budget_environment)
categorical_budget_oversize <- categorical_budget_frame[
  rep(seq_len(categorical_budget_rows), length.out = categorical_budget_rows + 1L),
  ,
  drop = FALSE
]
assign("multi_label_frame", categorical_budget_oversize, envir = categorical_budget_environment)
categorical_budget_error <- tryCatch(
  {
    eval(parse(text = multi_label_apply$code), envir = categorical_budget_environment)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_budget_error, "error") && grepl("output is too large", conditionMessage(categorical_budget_error), fixed = TRUE),
  TRUE,
  "generated R multi-label code ignored the combined token/indicator budget"
)

categorical_many_tokens <- vapply(0:2048, function(offset) intToUtf8(256L + offset), character(1L))
categorical_high_cardinality_frame <- data.frame(
  tags = factor(paste(categorical_many_tokens, collapse = "|")),
  value = 1L,
  check.names = FALSE
)
assign("multi_label_frame", categorical_high_cardinality_frame, envir = categorical_budget_environment)
categorical_high_cardinality_error <- tryCatch(
  {
    eval(parse(text = multi_label_apply$code), envir = categorical_budget_environment)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_high_cardinality_error, "error") && grepl("output is too large", conditionMessage(categorical_high_cardinality_error), fixed = TRUE),
  TRUE,
  "generated R multi-label code materialized a changed-schema high-cardinality replay"
)
rm(list = "multi_label_frame", envir = categorical_budget_environment)

source_environment$categorical_table <- data.table::data.table(
  primary_key = c("b", "a", "b"),
  tags = c("x|y", "x", NA_character_),
  value = 1:3
)
data.table::setkey(source_environment$categorical_table, primary_key)
categorical_table_before <- data.table::copy(source_environment$categorical_table)
assert_identical(
  dispatch("openSession", list(sessionId = categorical_table_session_id, variableName = "categorical_table", page = page_window()))$kind,
  "page",
  "the R categorical data.table session did not open"
)
categorical_table_step <- list(
  id = "categorical-table-step",
  kind = "multiLabelBinarize",
  params = list(column = list(id = "r:c:1", name = "tags"), delimiter = "|", prefix = "")
)
categorical_table_preview <- dispatch(
  "previewStep",
  list(sessionId = categorical_table_session_id, revision = 0L, step = categorical_table_step, page = page_window())
)
assert_identical(categorical_table_preview$page$frameSemantics$keyColumnIds, list("r:c:0"), "R multi-label preview changed a retained data.table key")
categorical_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = categorical_table_session_id, revision = 1L, page = page_window())
)
assign("categorical_table", source_environment$categorical_table, envir = .GlobalEnv)
eval(parse(text = categorical_table_apply$code), envir = .GlobalEnv)
categorical_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(class(categorical_table_generated), c("data.table", "data.frame"), "generated R categorical code changed data.table class")
assert_identical(data.table::key(categorical_table_generated), "primary_key", "generated R categorical code changed a retained data.table key")
assert_identical(source_environment$categorical_table, categorical_table_before, "R categorical data.table execution mutated its source")
assert_identical(get("categorical_table", envir = .GlobalEnv), categorical_table_before, "generated R categorical data.table code mutated its source")
rm("categorical_table", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(dispatch("closeSession", list(sessionId = categorical_table_session_id))$kind, "closed", "the R categorical data.table session did not close")

categorical_family_values <- list(
  tibble::as_tibble(data.frame(category = c("b", "a"), value = 1:2), .name_repair = "minimal"),
  collapse::qDF(data.frame(category = c("b", "a"), value = 1:2)),
  collapse::qTBL(data.frame(category = c("b", "a"), value = 1:2))
)
categorical_family_classes <- lapply(categorical_family_values, class)
for (family_index in seq_along(categorical_family_values)) {
  variable_name <- paste0("categorical_family_", family_index)
  source_environment[[variable_name]] <- categorical_family_values[[family_index]]
  session <- categorical_family_session_ids[[family_index]]
  assert_identical(dispatch("openSession", list(sessionId = session, variableName = variable_name, page = page_window()))$kind, "page", "an R categorical family session did not open")
  family_step <- list(
    id = paste0("categorical-family-step-", family_index),
    kind = "oneHotEncode",
    params = list(columns = I(list(list(id = "r:c:0", name = "category"))), dropOriginal = FALSE)
  )
  family_preview <- dispatch("previewStep", list(sessionId = session, revision = 0L, step = family_step, page = page_window()))
  family_apply <- dispatch("applyDraft", list(sessionId = session, revision = 1L, page = page_window()))
  assign(variable_name, source_environment[[variable_name]], envir = .GlobalEnv)
  eval(parse(text = family_apply$code), envir = .GlobalEnv)
  family_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_identical(class(family_generated), categorical_family_classes[[family_index]], "generated R categorical code changed dataframe family")
  assert_identical(names(family_generated), c("category", "value", "category_a", "category_b"), "generated R categorical code changed a family schema")
  rm(list = c(variable_name, "open_wrangler_result"), envir = .GlobalEnv)
  assert_identical(dispatch("closeSession", list(sessionId = session))$kind, "closed", "an R categorical family session did not close")
}

source_environment$categorical_scalar_frame <- data.frame(
  flag = c(TRUE, FALSE, NA, TRUE, FALSE),
  whole = c(2L, 1L, NA_integer_, -3L, 2L),
  number = c(1.5, NaN, NA_real_, Inf, -Inf),
  text = c("β", "", NA_character_, "alpha", "β"),
  category = factor(c("used", "", NA, "used", "other"), levels = c("unused", "used", "", "other")),
  day = as.Date(c("2024-01-02", "2024-01-03", NA, "2024-01-02", "2024-01-03")),
  instant = as.POSIXct(
    c("2024-01-02 03:04:05", "2024-01-03 04:05:06", NA, "2024-01-02 03:04:05", NA),
    tz = "UTC"
  ),
  elapsed = as.difftime(c(1, NA, 2, 1, 2), units = "hours"),
  wide = bit64::as.integer64(c("9007199254740993", "-2", NA, "9007199254740993", "-2")),
  check.names = FALSE,
  row.names = paste0("categorical-scalar-", 1:5)
)
attr(source_environment$categorical_scalar_frame$instant, "tzone") <- structure(
  "UTC",
  names = "named-tzone",
  comment = "incidental timezone metadata",
  class = "AsIs"
)
attr(source_environment$categorical_scalar_frame$elapsed, "units") <- structure(
  "hours",
  names = "named-units",
  comment = "incidental units metadata",
  class = "AsIs"
)
categorical_scalar_before <- unserialize(serialize(source_environment$categorical_scalar_frame, NULL, version = 3L))
categorical_scalar_expected <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
  source_environment$categorical_scalar_frame,
  seq_len(ncol(source_environment$categorical_scalar_frame)),
  names(source_environment$categorical_scalar_frame),
  prefix_separator = "_",
  drop_original = FALSE
)$value
assert_identical(
  dispatch("openSession", list(sessionId = categorical_scalar_session_id, variableName = "categorical_scalar_frame", page = page_window()))$kind,
  "page",
  "the scalar R one-hot session did not open"
)
categorical_scalar_step <- list(
  id = "categorical-scalar-step",
  kind = "oneHotEncode",
  params = list(
    columns = I(lapply(seq_len(ncol(source_environment$categorical_scalar_frame)), function(index) {
      list(id = paste0("r:c:", index - 1L), name = names(source_environment$categorical_scalar_frame)[[index]])
    })),
    prefixSeparator = "_",
    dropOriginal = FALSE
  )
)
categorical_scalar_preview <- dispatch(
  "previewStep",
  list(sessionId = categorical_scalar_session_id, revision = 0L, step = categorical_scalar_step, page = page_window())
)
assert_identical(categorical_scalar_preview$kind, "stepPreview", "scalar R one-hot encoding did not preview")
assert_identical(
  vapply(categorical_scalar_preview$page$schema, `[[`, character(1L), "name"),
  names(categorical_scalar_expected),
  "scalar R one-hot preview diverged from the frame contract"
)
categorical_scalar_apply <- dispatch(
  "applyDraft",
  list(sessionId = categorical_scalar_session_id, revision = 1L, page = page_window())
)
assign("categorical_scalar_frame", source_environment$categorical_scalar_frame, envir = .GlobalEnv)
eval(parse(text = categorical_scalar_apply$code), envir = .GlobalEnv)
categorical_scalar_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(categorical_scalar_generated, categorical_scalar_expected, "generated R one-hot code diverged across supported scalar kinds")
assert_identical(get("categorical_scalar_frame", envir = .GlobalEnv), categorical_scalar_before, "generated scalar R one-hot code mutated its source")
assert_generated_categorical_type_drift <- function(changed, label) {
  changed_bytes <- serialize(changed, NULL, version = 3L)
  assign("categorical_scalar_frame", changed, envir = .GlobalEnv)
  if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
    rm("open_wrangler_result", envir = .GlobalEnv)
  }
  generated_error <- tryCatch(
    {
      eval(parse(text = categorical_scalar_apply$code), envir = .GlobalEnv)
      NULL
    },
    error = identity
  )
  assert_identical(
    inherits(generated_error, "error") &&
      grepl("type or semantics is stale", conditionMessage(generated_error), fixed = TRUE),
    TRUE,
    sprintf("generated R categorical code accepted %s", label)
  )
  assert_identical(
    serialize(get("categorical_scalar_frame", envir = .GlobalEnv), NULL, version = 3L),
    changed_bytes,
    sprintf("failed generated R categorical %s validation mutated its source", label)
  )
}
categorical_date_to_double <- source_environment$categorical_scalar_frame
categorical_date_to_double$day <- as.double(categorical_date_to_double$day)
assert_generated_categorical_type_drift(categorical_date_to_double, "Date-to-double type drift")
categorical_character_to_factor <- source_environment$categorical_scalar_frame
categorical_character_to_factor$text <- factor(categorical_character_to_factor$text)
assert_generated_categorical_type_drift(categorical_character_to_factor, "character-to-factor type drift")
categorical_factor_to_ordered <- source_environment$categorical_scalar_frame
categorical_factor_to_ordered$category <- ordered(
  categorical_factor_to_ordered$category,
  levels = levels(categorical_factor_to_ordered$category)
)
assert_generated_categorical_type_drift(categorical_factor_to_ordered, "factor-class drift")
categorical_datetime_to_double <- source_environment$categorical_scalar_frame
categorical_datetime_to_double$instant <- as.double(categorical_datetime_to_double$instant)
assert_generated_categorical_type_drift(categorical_datetime_to_double, "POSIXct-to-double type drift")
categorical_timezone_drift <- source_environment$categorical_scalar_frame
attr(categorical_timezone_drift$instant, "tzone") <- "Europe/Berlin"
assert_generated_categorical_type_drift(categorical_timezone_drift, "POSIXct timezone drift")
categorical_units_drift <- source_environment$categorical_scalar_frame
attr(categorical_units_drift$elapsed, "units") <- "mins"
assert_generated_categorical_type_drift(categorical_units_drift, "difftime units drift")
categorical_invalid_date_frame <- source_environment$categorical_scalar_frame
categorical_invalid_date_frame$day <- structure(c(1e15, rep.int(NA_real_, 4L)), class = "Date")
assign("categorical_scalar_frame", categorical_invalid_date_frame, envir = .GlobalEnv)
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}
categorical_invalid_date_error <- tryCatch(
  {
    eval(parse(text = categorical_scalar_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_invalid_date_error, "error") && grepl("supported ISO range", conditionMessage(categorical_invalid_date_error), fixed = TRUE),
  TRUE,
  "generated R one-hot code accepted an out-of-range Date display"
)
categorical_invalid_datetime_frame <- source_environment$categorical_scalar_frame
categorical_invalid_datetime_frame$instant <- structure(
  c(1e20, rep.int(NA_real_, 4L)),
  class = c("POSIXct", "POSIXt"),
  tzone = "UTC"
)
assign("categorical_scalar_frame", categorical_invalid_datetime_frame, envir = .GlobalEnv)
categorical_invalid_datetime_error <- tryCatch(
  {
    eval(parse(text = categorical_scalar_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_invalid_datetime_error, "error") && grepl("supported range", conditionMessage(categorical_invalid_datetime_error), fixed = TRUE),
  TRUE,
  "generated R one-hot code accepted an out-of-range POSIXct display"
)
categorical_oversized_character_frame <- source_environment$categorical_scalar_frame
categorical_oversized_character_frame$text[[1L]] <- strrep("a", 8193L)
assign("categorical_scalar_frame", categorical_oversized_character_frame, envir = .GlobalEnv)
categorical_oversized_character_error <- tryCatch(
  {
    eval(parse(text = categorical_scalar_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(categorical_oversized_character_error, "error"),
  TRUE,
  "generated R one-hot code accepted an oversized character category"
)
rm("categorical_scalar_frame", envir = .GlobalEnv)
assert_identical(dispatch("closeSession", list(sessionId = categorical_scalar_session_id))$kind, "closed", "the scalar R one-hot session did not close")

source_environment$categorical_error_frame <- data.frame(
  group = "a",
  group_a = 7L,
  check.names = FALSE
)
categorical_error_before <- source_environment$categorical_error_frame
assert_identical(
  dispatch("openSession", list(sessionId = categorical_error_session_id, variableName = "categorical_error_frame", page = page_window()))$kind,
  "page",
  "the categorical error-guard session did not open"
)
categorical_collision <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_error_session_id,
    revision = 0L,
    step = list(
      id = "categorical-collision",
      kind = "oneHotEncode",
      params = list(
        columns = I(list(list(id = "r:c:0", name = "group"))),
        dropOriginal = FALSE
      )
    ),
    page = page_window()
  )
)
assert_identical(categorical_collision$kind, "error", "R one-hot encoding accepted a generated-name collision")
assert_identical(categorical_collision$code, "invalid_request", "R one-hot collision returned the wrong diagnostic")
categorical_stale <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_error_session_id,
    revision = 0L,
    step = list(
      id = "categorical-stale",
      kind = "multiLabelBinarize",
      params = list(column = list(id = "r:c:9", name = "group"), delimiter = "|")
    ),
    page = page_window()
  )
)
assert_identical(categorical_stale$kind, "error", "R multi-label binarization accepted a stale column identity")
assert_identical(categorical_stale$code, "stale_column", "R multi-label stale reference returned the wrong diagnostic")
assert_identical(source_environment$categorical_error_frame, categorical_error_before, "failed R categorical previews mutated their source")
assert_identical(dispatch("closeSession", list(sessionId = categorical_error_session_id))$kind, "closed", "the categorical error-guard session did not close")

source_environment$categorical_empty_frame <- data.frame(tags = character(), check.names = FALSE)
assert_identical(
  dispatch("openSession", list(sessionId = categorical_empty_session_id, variableName = "categorical_empty_frame", page = page_window()))$kind,
  "page",
  "the empty categorical guard session did not open"
)
categorical_empty <- dispatch(
  "previewStep",
  list(
    sessionId = categorical_empty_session_id,
    revision = 0L,
    step = list(
      id = "categorical-empty",
      kind = "multiLabelBinarize",
      params = list(
        column = list(id = "r:c:0", name = "tags"),
        delimiter = "|",
        dropOriginal = TRUE
      )
    ),
    page = page_window()
  )
)
assert_identical(categorical_empty$kind, "error", "R multi-label binarization accepted a dynamically empty output schema")
assert_identical(categorical_empty$code, "invalid_request", "the dynamically empty categorical diagnostic changed")
assert_identical(dispatch("closeSession", list(sessionId = categorical_empty_session_id))$kind, "closed", "the empty categorical guard session did not close")

categorical_retained_empty_cases <- list(
  list(
    label = "one-hot positive rows retained originals",
    sessionId = "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
    kind = "oneHotEncode",
    dropOriginal = FALSE,
    source = data.frame(input = c(NA_character_, ""), keep = 1:2, check.names = FALSE)
  ),
  list(
    label = "one-hot positive rows dropped original",
    sessionId = "d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2",
    kind = "oneHotEncode",
    dropOriginal = TRUE,
    source = data.frame(input = c(NA_character_, ""), keep = 1:2, check.names = FALSE)
  ),
  list(
    label = "one-hot zero rows retained originals",
    sessionId = "d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3",
    kind = "oneHotEncode",
    dropOriginal = FALSE,
    source = data.frame(input = character(), keep = integer(), check.names = FALSE)
  ),
  list(
    label = "one-hot zero rows dropped original",
    sessionId = "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4",
    kind = "oneHotEncode",
    dropOriginal = TRUE,
    source = data.frame(input = character(), keep = integer(), check.names = FALSE)
  ),
  list(
    label = "multi-label positive rows retained originals",
    sessionId = "d5d5d5d5-d5d5-45d5-85d5-d5d5d5d5d5d5",
    kind = "multiLabelBinarize",
    dropOriginal = FALSE,
    source = data.frame(input = c(NA_character_, ""), keep = 1:2, check.names = FALSE)
  ),
  list(
    label = "multi-label positive rows dropped original",
    sessionId = "d6d6d6d6-d6d6-46d6-86d6-d6d6d6d6d6d6",
    kind = "multiLabelBinarize",
    dropOriginal = TRUE,
    source = data.frame(input = c(NA_character_, ""), keep = 1:2, check.names = FALSE)
  ),
  list(
    label = "multi-label zero rows retained originals",
    sessionId = "d7d7d7d7-d7d7-47d7-87d7-d7d7d7d7d7d7",
    kind = "multiLabelBinarize",
    dropOriginal = FALSE,
    source = data.frame(input = character(), keep = integer(), check.names = FALSE)
  ),
  list(
    label = "multi-label zero rows dropped original",
    sessionId = "d8d8d8d8-d8d8-48d8-88d8-d8d8d8d8d8d8",
    kind = "multiLabelBinarize",
    dropOriginal = TRUE,
    source = data.frame(input = character(), keep = integer(), check.names = FALSE)
  )
)
categorical_empty_step <- function(kind, id, drop_original) {
  if (identical(kind, "oneHotEncode")) {
    list(
      id = id,
      kind = kind,
      params = list(
        columns = I(list(list(id = "r:c:0", name = "input"))),
        dropOriginal = drop_original
      )
    )
  } else {
    list(
      id = id,
      kind = kind,
      params = list(
        column = list(id = "r:c:0", name = "input"),
        delimiter = "|",
        prefix = "tag_",
        dropOriginal = drop_original
      )
    )
  }
}
for (case_index in seq_along(categorical_retained_empty_cases)) {
  case <- categorical_retained_empty_cases[[case_index]]
  variable_name <- sprintf("categorical_retained_empty_%d", case_index)
  source_environment[[variable_name]] <- case$source
  source_bytes <- serialize(case$source, NULL, version = 3L)
  opened <- dispatch(
    "openSession",
    list(sessionId = case$sessionId, variableName = variable_name, page = page_window())
  )
  assert_identical(opened$kind, "page", sprintf("the %s session did not open", case$label))
  previewed <- dispatch(
    "previewStep",
    list(
      sessionId = case$sessionId,
      revision = 0L,
      step = categorical_empty_step(case$kind, sprintf("categorical-empty-live-%d", case_index), case$dropOriginal),
      page = page_window()
    )
  )
  assert_identical(previewed$kind, "error", sprintf("%s accepted zero generated columns", case$label))
  assert_identical(previewed$code, "invalid_request", sprintf("%s returned the wrong error", case$label))
  assert_identical(
    serialize(source_environment[[variable_name]], NULL, version = 3L),
    source_bytes,
    sprintf("%s mutated its source", case$label)
  )
  assert_identical(
    dispatch("closeSession", list(sessionId = case$sessionId))$kind,
    "closed",
    sprintf("the %s session did not close", case$label)
  )
  rm(list = variable_name, envir = source_environment)
}

categorical_generated_empty_cases <- list(
  list(kind = "oneHotEncode", dropOriginal = FALSE, sessionId = "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1"),
  list(kind = "oneHotEncode", dropOriginal = TRUE, sessionId = "e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2"),
  list(kind = "multiLabelBinarize", dropOriginal = FALSE, sessionId = "e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3"),
  list(kind = "multiLabelBinarize", dropOriginal = TRUE, sessionId = "e4e4e4e4-e4e4-44e4-84e4-e4e4e4e4e4e4")
)
for (case_index in seq_along(categorical_generated_empty_cases)) {
  case <- categorical_generated_empty_cases[[case_index]]
  variable_name <- sprintf("categorical_generated_empty_%d", case_index)
  original <- data.frame(input = c("a", "b"), keep = 1:2, check.names = FALSE)
  source_environment[[variable_name]] <- original
  opened <- dispatch(
    "openSession",
    list(sessionId = case$sessionId, variableName = variable_name, page = page_window())
  )
  assert_identical(opened$kind, "page", "a generated-empty categorical source did not open")
  previewed <- dispatch(
    "previewStep",
    list(
      sessionId = case$sessionId,
      revision = 0L,
      step = categorical_empty_step(case$kind, sprintf("categorical-empty-generated-%d", case_index), case$dropOriginal),
      page = page_window()
    )
  )
  assert_identical(previewed$kind, "stepPreview", "a generated-empty categorical source did not preview")
  applied <- dispatch(
    "applyDraft",
    list(sessionId = case$sessionId, revision = previewed$revision, page = page_window())
  )
  assert_identical(applied$kind, "planUpdated", "a generated-empty categorical source did not compile")
  for (changed in list(
    data.frame(input = c(NA_character_, ""), keep = 1:2, check.names = FALSE),
    data.frame(input = character(), keep = integer(), check.names = FALSE)
  )) {
    changed_bytes <- serialize(changed, NULL, version = 3L)
    evaluation_environment <- new.env(parent = baseenv())
    assign(variable_name, changed, envir = evaluation_environment)
    generated_error <- tryCatch(
      {
        eval(parse(text = applied$code), envir = evaluation_environment)
        NULL
      },
      error = identity
    )
    assert_identical(
      inherits(generated_error, "error") &&
        grepl("generate at least one column", conditionMessage(generated_error), fixed = TRUE),
      TRUE,
      "generated categorical code accepted zero generated columns"
    )
    assert_identical(
      serialize(get(variable_name, envir = evaluation_environment, inherits = FALSE), NULL, version = 3L),
      changed_bytes,
      "failed generated categorical code mutated its source"
    )
  }
  assert_identical(
    dispatch("closeSession", list(sessionId = case$sessionId))$kind,
    "closed",
    "a generated-empty categorical session did not close"
  )
  rm(list = variable_name, envir = source_environment)
}

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
row_active_code_offset <- regexpr("  # Filter rows", row_active_apply$code, fixed = TRUE)[[1L]]
row_active_operation_code <- substring(row_active_apply$code, row_active_code_offset)
row_active_code_end <- regexpr("\n  .ow_result\n", row_active_operation_code, fixed = TRUE)[[1L]]
if (row_active_code_end > 0L) {
  row_active_operation_code <- substring(row_active_operation_code, 1L, row_active_code_end - 1L)
}
row_active_code_lines <- strsplit(sub("\n$", "", row_active_operation_code), "\n", fixed = TRUE)[[1L]]
if (
  row_active_code_offset < 1L ||
    length(row_active_code_lines) > 16L ||
    nchar(row_active_operation_code, type = "bytes") > 1000L
) {
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
row_tibble_code_offset <- regexpr("  # Sort rows", row_tibble_result$applied$code, fixed = TRUE)[[1L]]
row_tibble_operation_code <- substring(row_tibble_result$applied$code, row_tibble_code_offset)
row_tibble_code_end <- regexpr("\n  .ow_result\n", row_tibble_operation_code, fixed = TRUE)[[1L]]
if (row_tibble_code_end > 0L) {
  row_tibble_operation_code <- substring(row_tibble_operation_code, 1L, row_tibble_code_end - 1L)
}
row_tibble_code_lines <- strsplit(sub("\n$", "", row_tibble_operation_code), "\n", fixed = TRUE)[[1L]]
if (
  row_tibble_code_offset < 1L ||
    length(row_tibble_code_lines) > 20L ||
    nchar(row_tibble_operation_code, type = "bytes") > 1250L
) {
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

source_environment$scale_frame <- data.frame(
  value = c(-2, 0, 2, NA_real_, NaN, Inf, -Inf),
  constant = c(5, NA_real_, 5, NaN, Inf, -Inf, 5),
  no_finite = c(NA_real_, NaN, Inf, -Inf, NA_real_, NaN, Inf),
  integer_value = c(-10L, 0L, 10L, NA_integer_, 5L, -5L, 2L),
  wide = bit64::as.integer64(c("0", "5", "10", NA, "2", "8", "1")),
  text = rep("not numeric", 7L),
  marker = letters[seq_len(7L)],
  row.names = paste0("scale-", seq_len(7L)),
  check.names = FALSE
)
scale_before <- unserialize(serialize(source_environment$scale_frame, NULL, version = 3L))
scale_open <- dispatch(
  "openSession",
  list(sessionId = scale_session_id, variableName = "scale_frame", page = page_window())
)
assert_identical(scale_open$kind, "page", "the R Min-max scale session did not open")

scale_extra_parameter <- dispatch(
  "previewStep",
  list(
    sessionId = scale_session_id,
    revision = 0L,
    step = list(
      id = "scale-extra-parameter",
      kind = "minMaxScale",
      params = list(column = list(id = "r:c:0", name = "value"), decimals = 2L)
    ),
    page = page_window()
  )
)
assert_identical(scale_extra_parameter$kind, "error", "R Min-max scale accepted an unknown parameter")
assert_identical(scale_extra_parameter$code, "invalid_request", "the R Min-max parameter diagnostic changed")
scale_legacy_column <- dispatch(
  "previewStep",
  list(
    sessionId = scale_session_id,
    revision = 0L,
    step = list(
      id = "scale-legacy-column",
      kind = "minMaxScale",
      params = list(column = "value")
    ),
    page = page_window()
  )
)
assert_identical(scale_legacy_column$kind, "error", "R Min-max scale accepted a legacy string column")
assert_identical(scale_legacy_column$code, "invalid_request", "the R Min-max column diagnostic changed")
scale_stale_column <- dispatch(
  "previewStep",
  list(
    sessionId = scale_session_id,
    revision = 0L,
    step = list(
      id = "scale-stale-column",
      kind = "minMaxScale",
      params = list(column = list(id = "r:c:1", name = "value"))
    ),
    page = page_window()
  )
)
assert_identical(scale_stale_column$kind, "error", "R Min-max scale accepted an ID/name mismatch")
assert_identical(scale_stale_column$code, "stale_column", "the R Min-max stale-column diagnostic changed")
scale_text_column <- dispatch(
  "previewStep",
  list(
    sessionId = scale_session_id,
    revision = 0L,
    step = numeric_step("scale-text", "minMaxScale", 6L, "text"),
    page = page_window()
  )
)
assert_identical(scale_text_column$kind, "error", "R Min-max scale accepted a text column")
assert_identical(scale_text_column$code, "invalid_request", "the R Min-max type diagnostic changed")

scale_revision <- 0L
preview_and_apply_scale <- function(step, page = page_window()) {
  preview <- dispatch(
    "previewStep",
    list(sessionId = scale_session_id, revision = scale_revision, step = step, page = page)
  )
  assert_identical(preview$kind, "stepPreview", sprintf("%s did not preview", step$id))
  scale_revision <<- preview$revision
  applied <- dispatch(
    "applyDraft",
    list(sessionId = scale_session_id, revision = scale_revision, page = page_window())
  )
  assert_identical(applied$action, "apply", sprintf("%s did not apply", step$id))
  scale_revision <<- applied$revision
  list(preview = preview, applied = applied)
}

scale_value_result <- preview_and_apply_scale(
  numeric_step("scale-values", "minMaxScale", 1L, "value"),
  page_window(column_offset = 0L, column_limit = 1L)
)
assert_identical(scale_value_result$preview$diff$changedCells, 6L, "R Min-max scale returned an inexact diff")
assert_identical(
  scale_value_result$preview$page$schema[[1L]]$rawType,
  "double",
  "in-place R Min-max scale published the wrong type"
)
assert_identical(
  scale_value_result$preview$page$schema[[1L]]$nullable,
  TRUE,
  "R Min-max scale did not publish its nullable output contract"
)
scale_constant_result <- preview_and_apply_scale(
  numeric_step("scale-constant", "minMaxScale", 2L, "constant", new_column = "constant scaled")
)
scale_no_finite_result <- preview_and_apply_scale(
  numeric_step("scale-no-finite", "minMaxScale", 3L, "no_finite", new_column = "no finite scaled")
)
scale_integer_result <- preview_and_apply_scale(
  numeric_step("scale-integer", "minMaxScale", 4L, "integer_value", new_column = "integer scaled")
)
scale_wide_result <- preview_and_apply_scale(
  numeric_step("scale-wide", "minMaxScale", 5L, "wide", new_column = "wide scaled")
)
assert_identical(
  scale_integer_result$applied$page$schema[[10L]]$rawType,
  "double",
  "R Min-max scale did not widen integer input"
)
assert_identical(
  scale_wide_result$applied$page$schema[[11L]]$rawType,
  "double",
  "R Min-max scale did not widen integer64 input"
)
scale_page <- dispatch("getPage", list(sessionId = scale_session_id, page = page_window()))
assert_identical(scale_page$kind, "page", "the applied R Min-max plan could not be paged")
scale_names <- vapply(scale_page$page$schema, `[[`, character(1L), "name", USE.NAMES = FALSE)
scale_column_values <- function(name) {
  position <- match(name, scale_names)
  vapply(scale_page$page$page$rows, function(row) {
    cell <- row$values[[position]]
    if (identical(cell$kind, "null")) NA_real_ else as.double(cell$raw)
  }, double(1L), USE.NAMES = FALSE)
}
assert_identical(
  scale_column_values("value"),
  c(0, 0.5, 1, NA_real_, NA_real_, NA_real_, NA_real_),
  "live R Min-max scale changed ordinary values"
)
assert_identical(
  scale_column_values("constant scaled"),
  c(0, NA_real_, 0, NA_real_, NA_real_, NA_real_, 0),
  "live R Min-max scale changed a constant range"
)
assert_identical(
  scale_column_values("no finite scaled"),
  rep.int(NA_real_, 7L),
  "live R Min-max scale invented values for an all-non-finite column"
)
assert_identical(
  scale_column_values("wide scaled"),
  c(0, 0.5, 1, NA_real_, 0.2, 0.8, 0.1),
  "live R Min-max scale changed integer64 values"
)

scale_inspection <- inspect_step(
  scale_session_id,
  scale_revision,
  "scale-values",
  page_window(column_offset = 0L, column_limit = 1L)
)
assert_identical(scale_inspection$kind, "stepInspection", "R Min-max scale did not retain history")
assert_identical(scale_inspection$diff$changedCells, 6L, "R Min-max history returned the wrong diff")
assert_schema_less_inspection(scale_inspection, "R Min-max inspection")

scale_edited_preview <- dispatch(
  "previewStep",
  list(
    sessionId = scale_session_id,
    revision = scale_revision,
    step = numeric_step(
      "scale-wide",
      "minMaxScale",
      5L,
      "wide",
      new_column = "wide scaled edited"
    ),
    replaceStepId = "scale-wide",
    page = page_window()
  )
)
assert_identical(scale_edited_preview$kind, "stepPreview", "the latest R Min-max step could not be edited")
assert_identical(scale_edited_preview$diff$addedColumns, list("wide scaled edited"), "edited R Min-max diff changed")
scale_revision <- scale_edited_preview$revision
scale_edited_apply <- dispatch(
  "applyDraft",
  list(sessionId = scale_session_id, revision = scale_revision, page = page_window())
)
assert_identical(scale_edited_apply$action, "apply", "the edited R Min-max step did not apply")
scale_revision <- scale_edited_apply$revision
if (
  !grepl(".ow_min_max_scale", scale_edited_apply$code, fixed = TRUE) ||
    !grepl("bit64::as.integer64", scale_edited_apply$code, fixed = TRUE) ||
    grepl("as.double(.ow_numeric_source)", scale_edited_apply$code, fixed = TRUE)
) {
  stop("generated R Min-max code lost its precision-safe finite-range calculation", call. = FALSE)
}
assign("scale_frame", source_environment$scale_frame, envir = .GlobalEnv)
withCallingHandlers(
  eval(parse(text = scale_edited_apply$code), envir = .GlobalEnv),
  warning = function(warning) stop("generated R Min-max scale emitted a warning", call. = FALSE)
)
scale_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  scale_generated$value,
  c(0, 0.5, 1, NA_real_, NA_real_, NA_real_, NA_real_),
  "generated R Min-max scale changed ordinary values"
)
assert_identical(
  scale_generated$`constant scaled`,
  c(0, NA_real_, 0, NA_real_, NA_real_, NA_real_, 0),
  "generated R Min-max scale changed constant values"
)
assert_identical(
  scale_generated$`no finite scaled`,
  rep.int(NA_real_, 7L),
  "generated R Min-max scale changed an all-non-finite column"
)
assert_identical(typeof(scale_generated$`integer scaled`), "double", "generated R Min-max did not widen integer")
assert_identical(
  scale_generated$`wide scaled edited`,
  c(0, 0.5, 1, NA_real_, 0.2, 0.8, 0.1),
  "generated R Min-max scale changed integer64 values"
)
assert_identical(row.names(scale_generated), row.names(scale_before), "generated R Min-max scale changed row names")
assert_identical(get("scale_frame", envir = .GlobalEnv), scale_before, "generated R Min-max code mutated its source")
assert_identical(source_environment$scale_frame, scale_before, "the live R Min-max lifecycle mutated its source")

generated_integer64_cases <- list(
  list(
    label = "adjacent positive integer64 values",
    values = c(
      "9223372036854775805", "9223372036854775806", "9223372036854775807", NA,
      "9223372036854775805", "9223372036854775806", "9223372036854775807"
    ),
    expected = c(0, 0.5, 1, NA_real_, 0, 0.5, 1)
  ),
  list(
    label = "adjacent negative integer64 values",
    values = c(
      "-9223372036854775807", "-9223372036854775806", "-9223372036854775805", NA,
      "-9223372036854775807", "-9223372036854775806", "-9223372036854775805"
    ),
    expected = c(0, 0.5, 1, NA_real_, 0, 0.5, 1)
  ),
  list(
    label = "the full supported signed integer64 range",
    values = c(
      "-9223372036854775807", "0", "9223372036854775807", NA,
      "-9223372036854775807", "0", "9223372036854775807"
    ),
    expected = c(0, 0.5, 1, NA_real_, 0, 0.5, 1)
  )
)
for (generated_case in generated_integer64_cases) {
  generated_source <- scale_before
  generated_source$wide <- bit64::as.integer64(generated_case$values)
  generated_source_before <- unserialize(serialize(generated_source, NULL, version = 3L))
  assign("scale_frame", generated_source, envir = .GlobalEnv)
  eval(parse(text = scale_edited_apply$code), envir = .GlobalEnv)
  generated_result <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  if (!isTRUE(all.equal(
    generated_result$`wide scaled edited`,
    generated_case$expected,
    tolerance = .Machine$double.eps,
    check.attributes = FALSE
  ))) {
    stop(sprintf("generated R Min-max changed %s", generated_case$label), call. = FALSE)
  }
  assert_identical(
    get("scale_frame", envir = .GlobalEnv),
    generated_source_before,
    sprintf("generated R Min-max mutated %s", generated_case$label)
  )
}
monotonic_generated_source <- scale_before
monotonic_generated_source$wide <- bit64::as.integer64(c(
  "0",
  "8999999000001999999",
  "8999999000002000000",
  "9223372036854775807",
  NA,
  "0",
  "9223372036854775807"
))
monotonic_generated_before <- unserialize(serialize(monotonic_generated_source, NULL, version = 3L))
assign("scale_frame", monotonic_generated_source, envir = .GlobalEnv)
eval(parse(text = scale_edited_apply$code), envir = .GlobalEnv)
monotonic_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)$`wide scaled edited`
if (!all(diff(monotonic_generated[seq_len(4L)]) >= 0)) {
  stop("generated R Min-max reversed adjacent integer64 values across an internal limb boundary", call. = FALSE)
}
assert_identical(
  get("scale_frame", envir = .GlobalEnv),
  monotonic_generated_before,
  "generated R Min-max mutated its monotonicity source"
)
assert_identical(source_environment$scale_frame, scale_before, "generated R Min-max cases mutated the live source")
rm("scale_frame", "open_wrangler_result", envir = .GlobalEnv)

scale_undo <- dispatch(
  "undoStep",
  list(sessionId = scale_session_id, revision = scale_revision, page = page_window())
)
assert_identical(scale_undo$action, "undo", "the latest R Min-max step did not undo")
assert_identical(
  any(vapply(scale_undo$page$schema, function(column) identical(column$name, "wide scaled edited"), logical(1L))),
  FALSE,
  "undo retained the edited R Min-max output"
)
invisible(dispatch("closeSession", list(sessionId = scale_session_id)))

source_environment$scale_table <- data.table::data.table(
  primary_key = c(2, 1),
  marker = c("second", "first")
)
data.table::setkey(source_environment$scale_table, primary_key)
scale_table_before <- data.table::copy(source_environment$scale_table)
scale_table_open <- dispatch(
  "openSession",
  list(sessionId = scale_table_session_id, variableName = "scale_table", page = page_window())
)
assert_identical(scale_table_open$kind, "page", "the keyed R Min-max session did not open")
scale_key_error <- dispatch(
  "previewStep",
  list(
    sessionId = scale_table_session_id,
    revision = 0L,
    step = numeric_step("scale-key", "minMaxScale", 1L, "primary_key"),
    page = page_window()
  )
)
assert_identical(scale_key_error$kind, "error", "R Min-max scale silently replaced a data.table key")
assert_identical(scale_key_error$code, "invalid_request", "the R Min-max key diagnostic changed")
scale_key_copy <- dispatch(
  "previewStep",
  list(
    sessionId = scale_table_session_id,
    revision = 0L,
    step = numeric_step("scale-key-copy", "minMaxScale", 1L, "primary_key", new_column = "scaled key"),
    page = page_window()
  )
)
assert_identical(scale_key_copy$kind, "stepPreview", "derived R Min-max could not read a data.table key")
scale_key_apply <- dispatch(
  "applyDraft",
  list(sessionId = scale_table_session_id, revision = 1L, page = page_window())
)
assign("scale_table", source_environment$scale_table, envir = .GlobalEnv)
eval(parse(text = scale_key_apply$code), envir = .GlobalEnv)
scale_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(data.table::key(scale_table_generated), "primary_key", "generated R Min-max lost the data.table key")
assert_identical(scale_table_generated$`scaled key`, c(0, 1), "generated R Min-max changed keyed values")
assert_identical(scale_table_generated$marker, scale_table_before$marker, "generated R Min-max changed keyed row order")
assert_identical(get("scale_table", envir = .GlobalEnv), scale_table_before, "generated R Min-max mutated keyed source")
rm("scale_table", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = scale_table_session_id)))

assert_generated_scale_flavor <- function(session_id, variable_name, source) {
  source_before <- if (inherits(source, "data.table")) {
    data.table::copy(source)
  } else {
    unserialize(serialize(source, NULL, version = 3L))
  }
  assign(variable_name, source, envir = source_environment)
  opened <- dispatch(
    "openSession",
    list(sessionId = session_id, variableName = variable_name, page = page_window())
  )
  assert_identical(opened$kind, "page", sprintf("%s did not open for R Min-max scale", variable_name))
  preview <- dispatch(
    "previewStep",
    list(
      sessionId = session_id,
      revision = 0L,
      step = numeric_step(paste0(variable_name, "-scale"), "minMaxScale", 1L, "value", new_column = "scaled"),
      page = page_window()
    )
  )
  assert_identical(preview$kind, "stepPreview", sprintf("%s did not preview R Min-max scale", variable_name))
  applied <- dispatch(
    "applyDraft",
    list(sessionId = session_id, revision = 1L, page = page_window())
  )
  assign(variable_name, source, envir = .GlobalEnv)
  eval(parse(text = applied$code), envir = .GlobalEnv)
  generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_identical(class(generated), class(source), sprintf("generated %s Min-max changed dataframe flavor", variable_name))
  assert_identical(generated$scaled, c(0, 0.5, 1), sprintf("generated %s Min-max changed values", variable_name))
  assert_identical(generated$marker, source_before$marker, sprintf("generated %s Min-max changed row order", variable_name))
  assert_identical(get(variable_name, envir = .GlobalEnv), source_before, sprintf("generated %s Min-max mutated source", variable_name))
  assert_identical(get(variable_name, envir = source_environment), source_before, sprintf("live %s Min-max mutated source", variable_name))
  rm(list = c(variable_name, "open_wrangler_result"), envir = .GlobalEnv)
  invisible(dispatch("closeSession", list(sessionId = session_id)))
}

scale_flavor_source <- data.frame(value = c(10, 20, 30), marker = c("a", "b", "c"), check.names = FALSE)
assert_generated_scale_flavor(
  scale_tibble_session_id,
  "scale_tibble",
  tibble::as_tibble(scale_flavor_source, .name_repair = "minimal")
)
assert_generated_scale_flavor(
  scale_collapse_frame_session_id,
  "scale_collapse_frame",
  collapse::qDF(scale_flavor_source)
)
assert_generated_scale_flavor(
  scale_collapse_tibble_session_id,
  "scale_collapse_tibble",
  collapse::qTBL(scale_flavor_source)
)
assert_generated_scale_flavor(
  scale_collapse_table_session_id,
  "scale_collapse_table",
  collapse::qDT(scale_flavor_source)
)

formula_step <- function(
  id,
  operator,
  new_column,
  left_position = 1L,
  left_name = "left",
  right_position = NULL,
  right_name = NULL,
  value = NULL
) {
  params <- list(
    leftColumn = list(id = sprintf("r:c:%d", left_position - 1L), name = left_name),
    operator = operator,
    newColumn = new_column
  )
  if (!is.null(right_position)) {
    params$rightColumn <- list(id = sprintf("r:c:%d", right_position - 1L), name = right_name)
  }
  if (!is.null(value)) params$value <- value
  list(id = id, kind = "formula", params = params)
}

datetime_format_step <- function(id, position, name, format, new_column = NULL) {
  params <- list(
    column = list(id = sprintf("r:c:%d", position - 1L), name = name),
    format = format
  )
  if (!is.null(new_column)) params$newColumn <- new_column
  list(id = id, kind = "formatDatetime", params = params)
}

page_column_position <- function(response, name) {
  match(name, vapply(response$page$schema, `[[`, character(1L), "name", USE.NAMES = FALSE))
}

numeric_page_values <- function(response, name) {
  position <- page_column_position(response, name)
  if (is.na(position)) stop(sprintf("page omitted numeric column %s", name), call. = FALSE)
  vapply(response$page$page$rows, function(row) {
    cell <- row$values[[position]]
    if (identical(cell$kind, "null")) NA_real_ else as.double(cell$raw)
  }, double(1L), USE.NAMES = FALSE)
}

text_page_values <- function(response, name) {
  position <- page_column_position(response, name)
  if (is.na(position)) stop(sprintf("page omitted text column %s", name), call. = FALSE)
  vapply(response$page$page$rows, function(row) {
    cell <- row$values[[position]]
    if (identical(cell$kind, "null")) NA_character_ else as.character(cell$raw)
  }, character(1L), USE.NAMES = FALSE)
}

source_environment$formula_frame <- data.frame(
  left = c(8, -8, 9, NA_real_, 2),
  right = c(2, 2, 3, 4, NA_real_),
  whole = c(4L, -4L, 6L, NA_integer_, 2L),
  text = c("a", "b", "c", "d", "e"),
  row.names = paste0("formula-", seq_len(5L)),
  check.names = FALSE
)
formula_before <- unserialize(serialize(source_environment$formula_frame, NULL, version = 3L))
formula_open <- dispatch(
  "openSession",
  list(sessionId = formula_session_id, variableName = "formula_frame", page = page_window())
)
assert_identical(formula_open$kind, "page", "the R Formula session did not open")

formula_extra_step <- formula_step("formula-extra", "add", "extra", right_position = 2L, right_name = "right")
formula_extra_step$params$extra <- TRUE
formula_extra <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = formula_extra_step,
    page = page_window()
  )
)
assert_identical(formula_extra$kind, "error", "R Formula accepted an unknown parameter")
assert_identical(formula_extra$code, "invalid_request", "the R Formula exact-record diagnostic changed")

formula_missing_operand <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = list(
      id = "formula-missing-operand",
      kind = "formula",
      params = list(
        leftColumn = list(id = "r:c:0", name = "left"),
        operator = "add",
        newColumn = "missing operand"
      )
    ),
    page = page_window()
  )
)
assert_identical(formula_missing_operand$kind, "error", "R Formula accepted no right operand")
assert_identical(formula_missing_operand$code, "invalid_request", "the missing R Formula operand diagnostic changed")

formula_both_operands_step <- formula_step(
  "formula-both-operands",
  "add",
  "both operands",
  right_position = 2L,
  right_name = "right"
)
formula_both_operands_step$params$value <- 2
formula_both_operands <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = formula_both_operands_step,
    page = page_window()
  )
)
assert_identical(formula_both_operands$kind, "error", "R Formula accepted both right operands")
assert_identical(formula_both_operands$code, "invalid_request", "the ambiguous R Formula operand diagnostic changed")

formula_bad_operator <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = formula_step("formula-bad-operator", "log", "bad operator", value = 2),
    page = page_window()
  )
)
assert_identical(formula_bad_operator$kind, "error", "R Formula accepted an unknown operator")
assert_identical(formula_bad_operator$code, "invalid_request", "the R Formula operator diagnostic changed")

formula_bad_scalar <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = formula_step("formula-bad-scalar", "add", "bad scalar", value = "2"),
    page = page_window()
  )
)
assert_identical(formula_bad_scalar$kind, "error", "R Formula accepted a non-numeric scalar")
assert_identical(formula_bad_scalar$code, "invalid_request", "the R Formula scalar diagnostic changed")

formula_legacy_step <- formula_step("formula-legacy", "add", "legacy", value = 2)
formula_legacy_step$params$leftColumn <- "left"
formula_legacy <- dispatch(
  "previewStep",
  list(sessionId = formula_session_id, revision = 0L, step = formula_legacy_step, page = page_window())
)
assert_identical(formula_legacy$kind, "error", "R Formula accepted a legacy string column")
assert_identical(formula_legacy$code, "invalid_request", "the R Formula legacy-column diagnostic changed")

formula_stale <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = formula_step(
      "formula-stale",
      "add",
      "stale",
      left_position = 2L,
      left_name = "left",
      value = 2
    ),
    page = page_window()
  )
)
assert_identical(formula_stale$kind, "error", "R Formula accepted an ID/name mismatch")
assert_identical(formula_stale$code, "stale_column", "the R Formula stale-column diagnostic changed")

formula_text <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = formula_step(
      "formula-text",
      "add",
      "text result",
      left_position = 4L,
      left_name = "text",
      value = 2
    ),
    page = page_window()
  )
)
assert_identical(formula_text$kind, "error", "R Formula accepted a text operand")
assert_identical(formula_text$code, "invalid_request", "the R Formula type diagnostic changed")

formula_collision <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = formula_step("formula-collision", "add", "right", value = 2),
    page = page_window()
  )
)
assert_identical(formula_collision$kind, "error", "R Formula overwrote an existing column")
assert_identical(formula_collision$code, "invalid_request", "the R Formula collision diagnostic changed")

formula_private <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = formula_step(
      "formula-private",
      "add",
      "__OPEN_WRANGLER_INTERNAL_ROW_ID_public",
      value = 2
    ),
    page = page_window()
  )
)
assert_identical(formula_private$kind, "error", "R Formula exposed the private row-identity namespace")
assert_identical(formula_private$code, "invalid_request", "the R Formula private-name diagnostic changed")

formula_discard_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = 0L,
    step = formula_step("formula-discard", "add", "discarded", value = 0.5),
    page = page_window()
  )
)
assert_identical(formula_discard_preview$kind, "stepPreview", "a scalar R Formula did not preview")
assert_identical(formula_discard_preview$diff$addedColumns, list("discarded"), "the scalar R Formula diff changed")
assert_identical(formula_discard_preview$diff$changedCells, 0L, "an appended R Formula reported changed cells")
discarded_schema <- formula_discard_preview$page$schema[[5L]]
assert_identical(discarded_schema$id, "c:step:formula-discard:0", "the R Formula output identity changed")
assert_identical(discarded_schema$name, "discarded", "the R Formula output name changed")
assert_identical(discarded_schema$rawType, "double", "the scalar R Formula output was not a double")
assert_identical(discarded_schema$type, "float", "the scalar R Formula output type changed")
assert_identical(discarded_schema$nullable, TRUE, "the scalar R Formula output was not conservatively nullable")
assert_identical(
  numeric_page_values(formula_discard_preview, "discarded"),
  c(8.5, -7.5, 9.5, NA_real_, 2.5),
  "live scalar R Formula values changed"
)
formula_discard <- dispatch(
  "discardDraft",
  list(sessionId = formula_session_id, revision = formula_discard_preview$revision, page = page_window())
)
assert_identical(formula_discard$action, "discard", "the scalar R Formula draft did not discard")
assert_identical(formula_discard$code, "", "discarding the only R Formula retained generated code")
assert_identical(
  any(vapply(formula_discard$page$schema, function(column) identical(column$name, "discarded"), logical(1L))),
  FALSE,
  "discarding R Formula retained its output column"
)
assert_identical(source_environment$formula_frame, formula_before, "discarding R Formula mutated its source")

formula_operator_cases <- list(
  list(operator = "add", expected = c(10, -6, 12, NA_real_, NA_real_)),
  list(operator = "subtract", expected = c(6, -10, 6, NA_real_, NA_real_)),
  list(operator = "multiply", expected = c(16, -16, 27, NA_real_, NA_real_)),
  list(operator = "divide", expected = c(4, -4, 3, NA_real_, NA_real_)),
  list(operator = "modulo", expected = c(0, 0, 0, NA_real_, NA_real_)),
  list(operator = "power", expected = c(64, 64, 729, NA_real_, NA_real_))
)
formula_revision <- formula_discard$revision
formula_last_apply <- NULL
for (formula_case in formula_operator_cases) {
  formula_step_id <- paste0("formula-", formula_case$operator)
  formula_output_name <- paste0(formula_case$operator, " result")
  formula_preview <- dispatch(
    "previewStep",
    list(
      sessionId = formula_session_id,
      revision = formula_revision,
      step = formula_step(
        formula_step_id,
        formula_case$operator,
        formula_output_name,
        right_position = 2L,
        right_name = "right"
      ),
      page = page_window()
    )
  )
  assert_identical(
    formula_preview$kind,
    "stepPreview",
    sprintf("R Formula %s did not preview", formula_case$operator)
  )
  assert_identical(
    formula_preview$diff$addedColumns,
    list(formula_output_name),
    sprintf("R Formula %s returned the wrong added-column diff", formula_case$operator)
  )
  formula_output_schema <- formula_preview$page$schema[[length(formula_preview$page$schema)]]
  assert_identical(
    formula_output_schema$id,
    paste0("c:step:", formula_step_id, ":0"),
    sprintf("R Formula %s returned the wrong stable identity", formula_case$operator)
  )
  assert_identical(
    formula_output_schema$rawType,
    "double",
    sprintf("R Formula %s did not publish a double output", formula_case$operator)
  )
  assert_identical(
    formula_output_schema$nullable,
    TRUE,
    sprintf("R Formula %s did not publish nullable output", formula_case$operator)
  )
  assert_identical(
    numeric_page_values(formula_preview, formula_output_name),
    formula_case$expected,
    sprintf("live R Formula %s values changed", formula_case$operator)
  )
  formula_revision <- formula_preview$revision
  formula_last_apply <- dispatch(
    "applyDraft",
    list(sessionId = formula_session_id, revision = formula_revision, page = page_window())
  )
  assert_identical(
    formula_last_apply$action,
    "apply",
    sprintf("R Formula %s did not apply", formula_case$operator)
  )
  formula_revision <- formula_last_apply$revision
}

formula_scalar_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_session_id,
    revision = formula_revision,
    step = formula_step("formula-scalar", "subtract", "scalar result", value = 0.5),
    page = page_window()
  )
)
assert_identical(formula_scalar_preview$kind, "stepPreview", "the applied scalar R Formula did not preview")
formula_revision <- formula_scalar_preview$revision
formula_scalar_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_session_id, revision = formula_revision, page = page_window())
)
assert_identical(formula_scalar_apply$action, "apply", "the scalar R Formula did not apply")
formula_revision <- formula_scalar_apply$revision

formula_inspection <- inspect_step(
  formula_session_id,
  formula_revision,
  "formula-power",
  page_window()
)
assert_identical(formula_inspection$diff$changedCells, 0L, "R Formula history reported changed source cells")
assert_identical(
  setdiff(
    unlist(formula_inspection$outputPage$page$columnIds, use.names = FALSE),
    unlist(formula_inspection$inputPage$page$columnIds, use.names = FALSE)
  ),
  "c:step:formula-power:0",
  "R Formula history lost its stable output identity"
)
assert_schema_less_inspection(formula_inspection, "R Formula inspection")

assign("formula_frame", source_environment$formula_frame, envir = .GlobalEnv)
eval(parse(text = formula_scalar_apply$code), envir = .GlobalEnv)
formula_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
for (formula_case in formula_operator_cases) {
  output_name <- paste0(formula_case$operator, " result")
  assert_identical(
    formula_generated[[output_name]],
    formula_case$expected,
    sprintf("generated R Formula %s values changed", formula_case$operator)
  )
}
assert_identical(
  formula_generated$`scalar result`,
  c(7.5, -8.5, 8.5, NA_real_, 1.5),
  "generated scalar R Formula values changed"
)
assert_identical(row.names(formula_generated), row.names(formula_before), "generated R Formula changed row names")
assert_identical(get("formula_frame", envir = .GlobalEnv), formula_before, "generated R Formula mutated its source")
assert_identical(source_environment$formula_frame, formula_before, "the R Formula lifecycle mutated its source")
rm("formula_frame", "open_wrangler_result", envir = .GlobalEnv)

formula_global_override <- function(...) {
  base::stop("a global generated-code override was evaluated", call. = FALSE)
}
formula_global_override_names <- c(
  "+",
  "get",
  "local",
  "evalq",
  "list2env",
  "environment",
  "baseenv",
  "is.data.frame",
  "class",
  "attributes",
  "names",
  "length",
  "serialize",
  "unserialize",
  "inherits",
  "requireNamespace",
  "format.Date"
)
formula_global_helper_names <- c(
  ".ow_source_environment",
  ".ow_source",
  ".ow_result",
  ".ow_source_column_count",
  ".ow_source_names",
  ".ow_formula_left",
  ".ow_formula_right",
  ".ow_formula_values"
)
base::assign("formula_frame", formula_before, envir = .GlobalEnv)
for (override_name in formula_global_override_names) {
  base::assign(override_name, formula_global_override, envir = .GlobalEnv)
}
for (helper_name in formula_global_helper_names) {
  base::assign(helper_name, "caller helper collision", envir = .GlobalEnv)
}
base::eval(base::parse(text = formula_scalar_apply$code), envir = .GlobalEnv)
formula_hijack_generated <- base::get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
formula_hijack_source <- base::get("formula_frame", envir = .GlobalEnv, inherits = FALSE)
base::rm(
  list = c(
    formula_global_override_names,
    formula_global_helper_names,
    "formula_frame",
    "open_wrangler_result"
  ),
  envir = .GlobalEnv
)
assert_identical(
  formula_hijack_generated$`add result`,
  c(10, -6, 12, NA_real_, NA_real_),
  "generated R Formula used a global + override"
)
assert_identical(
  formula_hijack_generated$`scalar result`,
  c(7.5, -8.5, 8.5, NA_real_, 1.5),
  "generated scalar R Formula used a caller override"
)
assert_identical(formula_hijack_source, formula_before, "caller-isolated generated R Formula mutated its source")

formula_subclass_source <- formula_before
base::class(formula_subclass_source) <- c("evil_frame", "data.frame")
formula_subclass_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_subclass_source, envir = formula_subclass_environment)
formula_subclass_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_subclass_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_subclass_error),
  "Open Wrangler generated R supports only a base data.frame, tibble, or data.table without subclasses",
  "generated R Formula accepted an unsupported dataframe subclass"
)
assert_identical(
  base::exists("open_wrangler_result", envir = formula_subclass_environment, inherits = FALSE),
  FALSE,
  "a rejected dataframe subclass published a generated R result"
)

formula_attribute_source <- formula_before
base::attr(formula_attribute_source, "evil") <- "unsupported"
formula_attribute_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_attribute_source, envir = formula_attribute_environment)
formula_attribute_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_attribute_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_attribute_error),
  "Open Wrangler generated R received unsupported dataframe attributes: evil",
  "generated R Formula accepted unsupported dataframe attributes"
)
assert_identical(
  base::exists("open_wrangler_result", envir = formula_attribute_environment, inherits = FALSE),
  FALSE,
  "rejected dataframe attributes published a generated R result"
)

formula_name_source <- formula_before
base::names(formula_name_source)[[3L]] <- NA_character_
formula_name_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_name_source, envir = formula_name_environment)
formula_name_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_name_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_name_error),
  "Open Wrangler generated R requires non-missing UTF-8 source column names",
  "generated R Formula accepted an invalid source column name"
)
assert_identical(
  base::exists("open_wrangler_result", envir = formula_name_environment, inherits = FALSE),
  FALSE,
  "an invalid source column name published a generated R result"
)

formula_active_environment <- new.env(parent = baseenv())
formula_active_binding_called <- FALSE
makeActiveBinding(
  "formula_frame",
  function(value) {
    formula_active_binding_called <<- TRUE
    formula_before
  },
  formula_active_environment
)
formula_active_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_active_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_active_error),
  "Open Wrangler generated R does not accept an active source binding",
  "generated R Formula evaluated an active source binding"
)
assert_identical(formula_active_binding_called, FALSE, "generated R Formula executed an active source binding")
assert_identical(
  base::exists("open_wrangler_result", envir = formula_active_environment, inherits = FALSE),
  FALSE,
  "an active source binding published a generated R result"
)

formula_active_result_environment <- new.env(parent = baseenv())
formula_active_result_called <- FALSE
base::assign("formula_frame", formula_before, envir = formula_active_result_environment)
makeActiveBinding(
  "open_wrangler_result",
  function(value) {
    if (missing(value)) return(NULL)
    formula_active_result_called <<- TRUE
    base::assign("formula_frame", data.frame(left = 999), envir = formula_active_result_environment)
    invisible(NULL)
  },
  formula_active_result_environment
)
formula_active_result_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_active_result_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_active_result_error),
  "Open Wrangler generated R does not accept an active result binding",
  "generated R Formula evaluated an active result binding"
)
assert_identical(formula_active_result_called, FALSE, "generated R Formula executed an active result binding")
assert_identical(
  base::get("formula_frame", envir = formula_active_result_environment, inherits = FALSE),
  formula_before,
  "an active result binding mutated the generated R source"
)

formula_delayed_result_environment <- new.env(parent = baseenv())
formula_delayed_result_called <- FALSE
formula_delayed_result_stolen <- NULL
base::delayedAssign(
  "formula_frame",
  {
    base::makeActiveBinding(
      "open_wrangler_result",
      function(value) {
        if (missing(value)) return(NULL)
        formula_delayed_result_called <<- TRUE
        formula_delayed_result_stolen <<- value
        invisible(NULL)
      },
      formula_delayed_result_environment
    )
    formula_before
  },
  eval.env = .GlobalEnv,
  assign.env = formula_delayed_result_environment
)
formula_delayed_result_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_delayed_result_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_delayed_result_error),
  "Open Wrangler generated R does not accept an active result binding",
  "a delayed source promise installed an active generated-result binding"
)
assert_identical(formula_delayed_result_called, FALSE, "generated R leaked its result to a delayed active binding")
assert_identical(formula_delayed_result_stolen, NULL, "a delayed active binding captured the generated R result")
assert_identical(
  base::get("formula_frame", envir = formula_delayed_result_environment, inherits = FALSE),
  formula_before,
  "a delayed source promise changed the generated R source"
)
base::rm("open_wrangler_result", envir = formula_delayed_result_environment)

formula_result_name_session_id <- "aaaabbbb-cccc-4ddd-8eee-ffff00001111"
source_environment$open_wrangler_result <- formula_before
formula_result_name_before <- serialize(source_environment$open_wrangler_result, NULL, version = 3L)
formula_result_name_open <- dispatch(
  "openSession",
  list(
    sessionId = formula_result_name_session_id,
    variableName = "open_wrangler_result",
    page = page_window()
  )
)
assert_identical(formula_result_name_open$kind, "page", "the same-name Formula session did not open")
formula_result_name_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_result_name_session_id,
    revision = 0L,
    step = formula_step("formula-result-name", "add", "same-name result", value = 1),
    page = page_window()
  )
)
assert_identical(formula_result_name_preview$kind, "stepPreview", "the same-name Formula did not preview")
formula_result_name_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_result_name_session_id, revision = 1L, page = page_window())
)
assert_identical(formula_result_name_apply$kind, "planUpdated", "the same-name Formula did not apply")
formula_result_name_environment <- new.env(parent = baseenv())
base::assign("open_wrangler_result", formula_before, envir = formula_result_name_environment)
base::eval(base::parse(text = formula_result_name_apply$code), envir = formula_result_name_environment)
assert_identical(
  serialize(base::get("open_wrangler_result", envir = formula_result_name_environment), NULL, version = 3L),
  formula_result_name_before,
  "generated R overwrote a source named open_wrangler_result"
)
assert_identical(
  base::get("open_wrangler_result_2", envir = formula_result_name_environment)$`same-name result`,
  c(9, -7, 10, NA_real_, 3),
  "generated R did not publish the same-name source result separately"
)
if (!grepl('.ow_publication_name <- "open_wrangler_result_2"', formula_result_name_apply$code, fixed = TRUE)) {
  stop("generated R did not declare its alternate same-name result binding", call. = FALSE)
}
formula_result_name_active_environment <- new.env(parent = baseenv())
formula_result_name_active_called <- FALSE
base::assign("open_wrangler_result", formula_before, envir = formula_result_name_active_environment)
base::makeActiveBinding(
  "open_wrangler_result_2",
  function(value) {
    if (missing(value)) return(NULL)
    formula_result_name_active_called <<- TRUE
    invisible(NULL)
  },
  formula_result_name_active_environment
)
formula_result_name_active_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_result_name_apply$code), envir = formula_result_name_active_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_result_name_active_error),
  "Open Wrangler generated R does not accept an active result binding",
  "generated R accepted an active alternate result binding"
)
assert_identical(formula_result_name_active_called, FALSE, "the alternate active result setter was invoked")
assert_identical(
  base::get("open_wrangler_result", envir = formula_result_name_active_environment),
  formula_before,
  "an alternate active result binding changed the same-name source"
)
invisible(dispatch("closeSession", list(sessionId = formula_result_name_session_id)))

formula_column_attribute_source <- formula_before
base::attr(formula_column_attribute_source$text, "evil") <- "unsupported"
formula_column_attribute_before <- serialize(formula_column_attribute_source, NULL, version = 3L)
formula_column_attribute_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_column_attribute_source, envir = formula_column_attribute_environment)
formula_column_attribute_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_column_attribute_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_column_attribute_error),
  "Open Wrangler generated R received unsupported attributes on source column 4: evil",
  "generated R Formula accepted unsupported attributes on an untouched source column"
)
assert_identical(
  serialize(base::get("formula_frame", envir = formula_column_attribute_environment), NULL, version = 3L),
  formula_column_attribute_before,
  "a rejected source-column attribute mutated the generated R source"
)
assert_identical(
  base::exists("open_wrangler_result", envir = formula_column_attribute_environment, inherits = FALSE),
  FALSE,
  "rejected source-column attributes published a generated R result"
)

formula_column_class_source <- formula_before
base::class(formula_column_class_source$text) <- c("evil_character", "character")
formula_column_class_before <- serialize(formula_column_class_source, NULL, version = 3L)
formula_column_class_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_column_class_source, envir = formula_column_class_environment)
formula_column_class_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_column_class_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_column_class_error),
  "Open Wrangler generated R received an unsupported type or class on source column 4",
  "generated R Formula accepted an unsupported class on an untouched source column"
)
assert_identical(
  serialize(base::get("formula_frame", envir = formula_column_class_environment), NULL, version = 3L),
  formula_column_class_before,
  "a rejected source-column class mutated the generated R source"
)

formula_column_type_source <- formula_before
formula_column_type_source$text <- as.list(formula_column_type_source$text)
formula_column_type_before <- serialize(formula_column_type_source, NULL, version = 3L)
formula_column_type_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_column_type_source, envir = formula_column_type_environment)
formula_column_type_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_column_type_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_column_type_error),
  "Open Wrangler generated R received an unsupported type or class on source column 4",
  "generated R Formula accepted an unsupported list source column"
)
assert_identical(
  serialize(base::get("formula_frame", envir = formula_column_type_environment), NULL, version = 3L),
  formula_column_type_before,
  "a rejected source-column type mutated the generated R source"
)

for (formula_bad_row_names in list(
  rep("duplicate", nrow(formula_before)),
  c(paste0("row-", seq_len(nrow(formula_before) - 1L)), NA_character_)
)) {
  formula_row_name_source <- formula_before
  base::attr(formula_row_name_source, "row.names") <- formula_bad_row_names
  formula_row_name_before <- serialize(formula_row_name_source, NULL, version = 3L)
  formula_row_name_environment <- new.env(parent = baseenv())
  base::assign("formula_frame", formula_row_name_source, envir = formula_row_name_environment)
  formula_row_name_error <- tryCatch(
    {
      base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_row_name_environment)
      NULL
    },
    error = identity
  )
  assert_identical(
    conditionMessage(formula_row_name_error),
    "Open Wrangler generated R received malformed row names",
    "generated R Formula accepted malformed row names"
  )
  assert_identical(
    serialize(base::get("formula_frame", envir = formula_row_name_environment), NULL, version = 3L),
    formula_row_name_before,
    "rejected generated R row names mutated their source"
  )
  assert_identical(
    base::exists("open_wrangler_result", envir = formula_row_name_environment, inherits = FALSE),
    FALSE,
    "malformed row names published a generated R result"
  )
}

formula_empty_row_name_source <- formula_before
row.names(formula_empty_row_name_source) <- c("", paste0("explicit-", seq_len(nrow(formula_before) - 1L)))
formula_empty_row_name_before <- serialize(formula_empty_row_name_source, NULL, version = 3L)
formula_empty_row_name_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_empty_row_name_source, envir = formula_empty_row_name_environment)
base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_empty_row_name_environment)
formula_empty_row_name_generated <- base::get(
  "open_wrangler_result",
  envir = formula_empty_row_name_environment,
  inherits = FALSE
)
assert_identical(
  row.names(formula_empty_row_name_generated),
  row.names(formula_empty_row_name_source),
  "generated R Formula rejected or changed a valid explicit empty row name"
)
assert_identical(
  serialize(base::get("formula_frame", envir = formula_empty_row_name_environment), NULL, version = 3L),
  formula_empty_row_name_before,
  "generated R Formula mutated a source with an explicit empty row name"
)

formula_explicit_sequence_source <- formula_before
base::attr(
  formula_explicit_sequence_source,
  "row.names"
) <- c(NA_integer_, nrow(formula_explicit_sequence_source))
formula_explicit_sequence_before <- serialize(formula_explicit_sequence_source, NULL, version = 3L)
formula_explicit_sequence_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_explicit_sequence_source, envir = formula_explicit_sequence_environment)
base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_explicit_sequence_environment)
formula_explicit_sequence_generated <- base::get(
  "open_wrangler_result",
  envir = formula_explicit_sequence_environment,
  inherits = FALSE
)
assert_identical(
  row.names(formula_explicit_sequence_generated),
  row.names(formula_explicit_sequence_source),
  "generated R Formula rejected valid explicit sequential integer row names"
)
assert_identical(
  serialize(base::get("formula_frame", envir = formula_explicit_sequence_environment), NULL, version = 3L),
  formula_explicit_sequence_before,
  "generated R Formula mutated explicit sequential integer row names"
)

formula_attributed_names_source <- formula_before
base::attr(
  formula_attributed_names_source,
  "names"
) <- base::structure(base::names(formula_attributed_names_source), class = "accepted_frame_names")
base::attr(
  formula_attributed_names_source,
  "row.names"
) <- base::structure(base::row.names(formula_attributed_names_source), class = "accepted_row_names")
formula_attributed_names_before <- serialize(formula_attributed_names_source, NULL, version = 3L)
formula_attributed_names_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_attributed_names_source, envir = formula_attributed_names_environment)
base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_attributed_names_environment)
formula_attributed_names_generated <- base::get(
  "open_wrangler_result",
  envir = formula_attributed_names_environment,
  inherits = FALSE
)
assert_identical(
  formula_attributed_names_generated$`scalar result`,
  c(7.5, -8.5, 8.5, NA_real_, 1.5),
  "generated R Formula rejected live-supported attributed frame or row names"
)
assert_identical(
  serialize(base::get("formula_frame", envir = formula_attributed_names_environment), NULL, version = 3L),
  formula_attributed_names_before,
  "generated R Formula mutated a source with attributed frame or row names"
)

formula_factor_payload_budget <- 16L * 1024L * 1024L
formula_factor_level_bytes <- 8190L
formula_factor_boundary_count <- 2047L
formula_factor_levels <- paste0(
  sprintf("%04d", seq_len(formula_factor_boundary_count + 1L)),
  strrep("x", formula_factor_level_bytes - 4L)
)
formula_factor_metadata_base <- 1024L + 5L * 512L
assert_identical(
  formula_factor_metadata_base +
    formula_factor_boundary_count * (formula_factor_level_bytes + 3L) <= formula_factor_payload_budget,
  TRUE,
  "the generated factor-metadata boundary fixture no longer fits the payload budget"
)
assert_identical(
  formula_factor_metadata_base +
    (formula_factor_boundary_count + 1L) * (formula_factor_level_bytes + 3L) > formula_factor_payload_budget,
  TRUE,
  "the oversized generated factor-metadata fixture no longer exceeds the payload budget"
)
formula_factor_boundary_source <- formula_before
formula_factor_boundary_source$factor <- base::structure(
  seq_len(nrow(formula_factor_boundary_source)),
  levels = formula_factor_levels[seq_len(formula_factor_boundary_count)],
  class = "factor"
)
formula_factor_boundary_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_factor_boundary_source, envir = formula_factor_boundary_environment)
base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_factor_boundary_environment)
formula_factor_boundary_generated <- base::get(
  "open_wrangler_result",
  envir = formula_factor_boundary_environment,
  inherits = FALSE
)
assert_identical(
  levels(formula_factor_boundary_generated$factor),
  levels(formula_factor_boundary_source$factor),
  "generated R Formula rejected factor metadata below its aggregate payload budget"
)
assert_identical(
  base::get("formula_frame", envir = formula_factor_boundary_environment, inherits = FALSE),
  formula_factor_boundary_source,
  "generated R Formula mutated factor metadata at the aggregate payload boundary"
)

formula_factor_oversized_source <- formula_factor_boundary_source
base::attr(formula_factor_oversized_source$factor, "levels") <- formula_factor_levels
formula_factor_oversized_environment <- new.env(parent = baseenv())
base::assign("formula_frame", formula_factor_oversized_source, envir = formula_factor_oversized_environment)
formula_factor_oversized_error <- tryCatch(
  {
    base::eval(base::parse(text = formula_scalar_apply$code), envir = formula_factor_oversized_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(formula_factor_oversized_error),
  "Open Wrangler generated R received factor metadata above the 16777216-byte payload budget",
  "generated R Formula accepted factor metadata above its aggregate payload budget"
)
assert_identical(
  base::get("formula_frame", envir = formula_factor_oversized_environment, inherits = FALSE),
  formula_factor_oversized_source,
  "rejected oversized factor metadata mutated the generated R source"
)
assert_identical(
  base::exists("open_wrangler_result", envir = formula_factor_oversized_environment, inherits = FALSE),
  FALSE,
  "oversized factor metadata published a generated R result"
)
rm(
  formula_factor_levels,
  formula_factor_boundary_source,
  formula_factor_boundary_environment,
  formula_factor_boundary_generated,
  formula_factor_oversized_source,
  formula_factor_oversized_environment
)

formula_undo <- dispatch(
  "undoStep",
  list(sessionId = formula_session_id, revision = formula_revision, page = page_window())
)
assert_identical(formula_undo$action, "undo", "the scalar R Formula did not undo")
assert_identical(
  any(vapply(formula_undo$page$schema, function(column) identical(column$name, "scalar result"), logical(1L))),
  FALSE,
  "undo retained the scalar R Formula output"
)
assert_identical(
  any(vapply(formula_undo$page$schema, function(column) identical(column$name, "power result"), logical(1L))),
  TRUE,
  "undo removed more than the latest R Formula step"
)
invisible(dispatch("closeSession", list(sessionId = formula_session_id)))

source_environment$formula_integer64_frame <- data.frame(
  wide = bit64::as.integer64(c("9007199254740993", "-9007199254740993", NA)),
  delta = bit64::as.integer64(c("2", "3", "4")),
  check.names = FALSE
)
class(source_environment$formula_integer64_frame) <- NULL
attr(source_environment$formula_integer64_frame$wide, "names") <- c("wide-a", "wide-b", "wide-c")
attr(source_environment$formula_integer64_frame$delta, "names") <- c("wide-a", "wide-b", "wide-c")
class(source_environment$formula_integer64_frame) <- "data.frame"
formula_integer64_before <- unserialize(serialize(
  source_environment$formula_integer64_frame,
  NULL,
  version = 3L
))
formula_integer64_open <- dispatch(
  "openSession",
  list(
    sessionId = formula_integer64_session_id,
    variableName = "formula_integer64_frame",
    page = page_window()
  )
)
assert_identical(formula_integer64_open$kind, "page", "the integer64 R Formula session did not open")
formula_integer64_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_integer64_session_id,
    revision = 0L,
    step = formula_step(
      "formula-integer64-add",
      "add",
      "exact sum",
      left_name = "wide",
      right_position = 2L,
      right_name = "delta"
    ),
    page = page_window()
  )
)
assert_identical(formula_integer64_preview$kind, "stepPreview", "integer64 R Formula did not preview")
assert_identical(
  formula_integer64_preview$diff$addedColumns,
  list("exact sum"),
  "integer64 R Formula returned the wrong diff"
)
formula_integer64_schema <- formula_integer64_preview$page$schema[[3L]]
assert_identical(formula_integer64_schema$id, "c:step:formula-integer64-add:0", "integer64 R Formula changed its output identity")
assert_identical(formula_integer64_schema$rawType, "integer64", "integer64 R Formula narrowed its output")
assert_identical(formula_integer64_schema$nullable, TRUE, "integer64 R Formula lost output nullability")
formula_integer64_preview_values <- vapply(
  formula_integer64_preview$page$page$rows,
  function(row) {
    cell <- row$values[[3L]]
    if (identical(cell$kind, "null")) NA_character_ else as.character(cell$raw)
  },
  character(1L),
  USE.NAMES = FALSE
)
assert_identical(
  formula_integer64_preview_values,
  c("9007199254740995", "-9007199254740990", NA_character_),
  "live integer64 R Formula lost exact values"
)
formula_integer64_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_integer64_session_id, revision = 1L, page = page_window())
)
assert_identical(formula_integer64_apply$action, "apply", "integer64 R Formula did not apply")
assert_identical(
  vapply(
    formula_integer64_apply$page$page$rows,
    function(row) {
      cell <- row$values[[3L]]
      if (identical(cell$kind, "null")) NA_character_ else as.character(cell$raw)
    },
    character(1L),
    USE.NAMES = FALSE
  ),
  formula_integer64_preview_values,
  "applied integer64 R Formula disagreed with its preview"
)
formula_integer64_s3_ops <- c("+", "-", "*", "%%", "/", "^", "[<-")
formula_integer64_s3_methods <- list(
  ops = setNames(lapply(formula_integer64_s3_ops, getS3method, class = "integer64"), formula_integer64_s3_ops),
  as_double = getS3method("as.double", "integer64"),
  is_na = getS3method("is.na", "integer64")
)
on.exit({
  for (generic in formula_integer64_s3_ops) {
    registerS3method(generic, "integer64", formula_integer64_s3_methods$ops[[generic]], envir = .GlobalEnv)
  }
  registerS3method("as.double", "integer64", formula_integer64_s3_methods$as_double, envir = .GlobalEnv)
  registerS3method("is.na", "integer64", formula_integer64_s3_methods$is_na, envir = .GlobalEnv)
}, add = TRUE)
for (generic in formula_integer64_s3_ops) {
  registerS3method(
    generic,
    "integer64",
    function(...) stop("poisoned registered integer64 operation", call. = FALSE),
    envir = .GlobalEnv
  )
}
registerS3method(
  "as.double",
  "integer64",
  function(x, ...) stop("poisoned registered integer64 conversion", call. = FALSE),
  envir = .GlobalEnv
)
registerS3method("is.na", "integer64", function(x) rep.int(FALSE, length(x)), envir = .GlobalEnv)
formula_integer64_safe_character <- get(
  "as.character.integer64",
  envir = asNamespace("bit64"),
  inherits = FALSE
)
formula_integer64_poisoned_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_integer64_session_id,
    revision = 2L,
    step = formula_step(
      "formula-integer64-poisoned-add",
      "add",
      "poison-proof sum",
      left_name = "wide",
      right_position = 2L,
      right_name = "delta"
    ),
    page = page_window()
  )
)
assert_identical(
  formula_integer64_poisoned_preview$kind,
  "stepPreview",
  "live integer64 R Formula used poisoned registered S3 methods"
)
assert_identical(
  vapply(
    formula_integer64_poisoned_preview$page$page$rows,
    function(row) {
      cell <- row$values[[4L]]
      if (identical(cell$kind, "null")) NA_character_ else as.character(cell$raw)
    },
    character(1L),
    USE.NAMES = FALSE
  ),
  formula_integer64_preview_values,
  "live integer64 R Formula changed under registered S3 poisoning"
)
formula_integer64_poisoned_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_integer64_session_id, revision = 3L, page = page_window())
)
assert_identical(
  formula_integer64_poisoned_apply$action,
  "apply",
  "live integer64 R Formula could not apply under registered S3 poisoning"
)
formula_integer64_divide_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_integer64_session_id,
    revision = 4L,
    step = formula_step(
      "formula-integer64-poisoned-divide",
      "divide",
      "poison-proof division",
      left_name = "wide",
      value = 2L
    ),
    page = page_window()
  )
)
assert_identical(
  numeric_page_values(formula_integer64_divide_preview, "poison-proof division"),
  c(4503599627370496, -4503599627370496, NA_real_),
  "live integer64 R Formula used poisoned registered conversion"
)
formula_integer64_divide_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_integer64_session_id, revision = 5L, page = page_window())
)
assert_identical(
  formula_integer64_divide_apply$action,
  "apply",
  "integer64 division could not apply under registered S3 poisoning"
)
formula_integer64_power_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_integer64_session_id,
    revision = 6L,
    step = formula_step(
      "formula-integer64-named-power",
      "power",
      "named power",
      left_position = 2L,
      left_name = "delta",
      value = 2L
    ),
    page = page_window()
  )
)
assert_identical(
  formula_integer64_power_preview$kind,
  "stepPreview",
  "live named integer64 power did not preview"
)
formula_integer64_power_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_integer64_session_id, revision = 7L, page = page_window())
)
assert_identical(formula_integer64_power_apply$action, "apply", "named integer64 power did not apply")
formula_integer64_mixed_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_integer64_session_id,
    revision = 8L,
    step = formula_step(
      "formula-integer64-named-mixed",
      "add",
      "named mixed",
      left_name = "wide",
      value = 0.5
    ),
    page = page_window()
  )
)
assert_identical(
  numeric_page_values(formula_integer64_mixed_preview, "named mixed"),
  c(9007199254740992, -9007199254740992, NA_real_),
  "live named mixed-double Formula changed values"
)
formula_integer64_mixed_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_integer64_session_id, revision = 9L, page = page_window())
)
assert_identical(formula_integer64_mixed_apply$action, "apply", "named mixed-double Formula did not apply")
assign("formula_integer64_frame", source_environment$formula_integer64_frame, envir = .GlobalEnv)
eval(parse(text = formula_integer64_mixed_apply$code), envir = .GlobalEnv)
formula_integer64_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(class(formula_integer64_generated$`exact sum`), "integer64", "generated integer64 R Formula changed type")
assert_identical(
  unname(formula_integer64_safe_character(formula_integer64_generated$`exact sum`)),
  formula_integer64_preview_values,
  "generated integer64 R Formula disagreed with live execution"
)
assert_identical(
  unname(formula_integer64_safe_character(formula_integer64_generated$`exact sum`)),
  formula_integer64_preview_values,
  "generated integer64 R Formula used poisoned registered S3 methods"
)
assert_identical(
  attr(formula_integer64_generated$`exact sum`, "names", exact = TRUE),
  c("wide-a", "wide-b", "wide-c"),
  "generated integer64 R Formula did not preserve aligned names"
)
assert_identical(
  unname(formula_integer64_generated$`poison-proof division`),
  c(4503599627370496, -4503599627370496, NA_real_),
  "generated integer64 R Formula used poisoned registered conversion"
)
assert_identical(attr(formula_integer64_generated$`poison-proof division`, "names", exact = TRUE), c("wide-a", "wide-b", "wide-c"), "generated division lost aligned names")
assert_identical(unname(formula_integer64_generated$`named power`), c(4, 9, 16), "generated integer64 power changed values")
assert_identical(attr(formula_integer64_generated$`named power`, "names", exact = TRUE), c("wide-a", "wide-b", "wide-c"), "generated integer64 power lost aligned names")
assert_identical(unname(formula_integer64_generated$`named mixed`), c(9007199254740992, -9007199254740992, NA_real_), "generated mixed-double Formula changed values")
assert_identical(attr(formula_integer64_generated$`named mixed`, "names", exact = TRUE), c("wide-a", "wide-b", "wide-c"), "generated mixed-double Formula lost aligned names")
formula_integer64_child_bundle <- tempfile(fileext = ".rds")
formula_integer64_child_script <- tempfile(fileext = ".R")
saveRDS(
  list(frame = source_environment$formula_integer64_frame, code = formula_integer64_mixed_apply$code),
  formula_integer64_child_bundle,
  version = 3L
)
writeLines(c(
  "local({",
  "  arguments <- commandArgs(trailingOnly = TRUE)",
  "  if (isNamespaceLoaded(\"bit64\")) stop(\"bit64 was already loaded in the cold generated-Formula child\", call. = FALSE)",
  "  bundle <- readRDS(arguments[[1L]])",
  "  if (isNamespaceLoaded(\"bit64\")) stop(\"readRDS unexpectedly loaded bit64 in the generated-Formula child\", call. = FALSE)",
  "  assign(\"formula_integer64_frame\", bundle$frame, envir = .GlobalEnv)",
  "  eval(parse(text = bundle$code), envir = .GlobalEnv)",
  "  cold <- get(\"open_wrangler_result\", envir = .GlobalEnv, inherits = FALSE)",
  "  safe_character <- get(\"as.character.integer64\", envir = asNamespace(\"bit64\"), inherits = FALSE)",
  "  if (!identical(unname(safe_character(cold$`exact sum`)), c(\"9007199254740995\", \"-9007199254740990\", NA_character_)) || !identical(unname(cold$`poison-proof division`), c(4503599627370496, -4503599627370496, NA_real_)) || !identical(attr(cold$`poison-proof division`, \"names\", exact = TRUE), c(\"wide-a\", \"wide-b\", \"wide-c\")) || !identical(unname(cold$`named power`), c(4, 9, 16)) || !identical(attr(cold$`named power`, \"names\", exact = TRUE), c(\"wide-a\", \"wide-b\", \"wide-c\")) || !identical(unname(cold$`named mixed`), c(9007199254740992, -9007199254740992, NA_real_)) || !identical(attr(cold$`named mixed`, \"names\", exact = TRUE), c(\"wide-a\", \"wide-b\", \"wide-c\"))) stop(\"cold generated integer64 Formula changed values or names\", call. = FALSE)",
  "  rm(\"open_wrangler_result\", envir = .GlobalEnv)",
  "  unloadNamespace(\"bit64\")",
  "  requireNamespace(\"bit64\", quietly = TRUE)",
  "  generics <- c(\"+\", \"-\", \"*\", \"%%\", \"/\", \"^\", \"[<-\")",
  "  methods <- setNames(lapply(generics, getS3method, class = \"integer64\"), generics)",
  "  conversion <- getS3method(\"as.double\", \"integer64\")",
  "  missingness <- getS3method(\"is.na\", \"integer64\")",
  "  on.exit({ for (generic in generics) registerS3method(generic, \"integer64\", methods[[generic]], envir = .GlobalEnv); registerS3method(\"as.double\", \"integer64\", conversion, envir = .GlobalEnv); registerS3method(\"is.na\", \"integer64\", missingness, envir = .GlobalEnv) }, add = TRUE)",
  "  for (generic in generics) registerS3method(generic, \"integer64\", function(...) stop(\"poisoned integer64 S3 method\", call. = FALSE), envir = .GlobalEnv)",
  "  registerS3method(\"as.double\", \"integer64\", function(...) stop(\"poisoned integer64 conversion\", call. = FALSE), envir = .GlobalEnv)",
  "  registerS3method(\"is.na\", \"integer64\", function(x) rep.int(FALSE, length(x)), envir = .GlobalEnv)",
  "  eval(parse(text = bundle$code), envir = .GlobalEnv)",
  "  poisoned <- get(\"open_wrangler_result\", envir = .GlobalEnv, inherits = FALSE)",
  "  safe_character <- get(\"as.character.integer64\", envir = asNamespace(\"bit64\"), inherits = FALSE)",
  "  if (!identical(unname(safe_character(poisoned$`exact sum`)), c(\"9007199254740995\", \"-9007199254740990\", NA_character_)) || !identical(attr(poisoned$`exact sum`, \"names\", exact = TRUE), c(\"wide-a\", \"wide-b\", \"wide-c\")) || !identical(unname(poisoned$`poison-proof division`), c(4503599627370496, -4503599627370496, NA_real_)) || !identical(attr(poisoned$`poison-proof division`, \"names\", exact = TRUE), c(\"wide-a\", \"wide-b\", \"wide-c\")) || !identical(unname(poisoned$`named power`), c(4, 9, 16)) || !identical(attr(poisoned$`named power`, \"names\", exact = TRUE), c(\"wide-a\", \"wide-b\", \"wide-c\")) || !identical(unname(poisoned$`named mixed`), c(9007199254740992, -9007199254740992, NA_real_)) || !identical(attr(poisoned$`named mixed`, \"names\", exact = TRUE), c(\"wide-a\", \"wide-b\", \"wide-c\"))) stop(\"generated integer64 Formula used poisoned S3 methods or lost names\", call. = FALSE)",
  "})"
), formula_integer64_child_script, useBytes = TRUE)
formula_integer64_child_output <- system2(
  file.path(R.home("bin"), "Rscript"),
  c("--vanilla", formula_integer64_child_script, formula_integer64_child_bundle),
  stdout = TRUE,
  stderr = TRUE
)
formula_integer64_child_status <- attr(formula_integer64_child_output, "status", exact = TRUE)
if (!is.null(formula_integer64_child_status) && formula_integer64_child_status != 0L) {
  stop(paste(c("cold or poisoned generated integer64 Formula child failed", formula_integer64_child_output), collapse = "\n"), call. = FALSE)
}
unlink(c(formula_integer64_child_script, formula_integer64_child_bundle))
assert_identical(
  get("formula_integer64_frame", envir = .GlobalEnv),
  formula_integer64_before,
  "generated integer64 R Formula mutated its source"
)
assert_identical(
  source_environment$formula_integer64_frame,
  formula_integer64_before,
  "live integer64 R Formula mutated its source"
)
rm("formula_integer64_frame", "open_wrangler_result", envir = .GlobalEnv)
for (generic in formula_integer64_s3_ops) {
  registerS3method(generic, "integer64", formula_integer64_s3_methods$ops[[generic]], envir = .GlobalEnv)
}
registerS3method("as.double", "integer64", formula_integer64_s3_methods$as_double, envir = .GlobalEnv)
registerS3method("is.na", "integer64", formula_integer64_s3_methods$is_na, envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = formula_integer64_session_id)))

source_environment$formula_nullability_frame <- data.frame(
  left = c(1, NA_real_, 3),
  right = c(10, 20, 30),
  check.names = FALSE
)
formula_nullability_before <- unserialize(serialize(
  source_environment$formula_nullability_frame,
  NULL,
  version = 3L
))
formula_nullability_open <- dispatch(
  "openSession",
  list(
    sessionId = formula_nullability_session_id,
    variableName = "formula_nullability_frame",
    page = page_window()
  )
)
assert_identical(formula_nullability_open$kind, "page", "the chained R Formula session did not open")
assert_identical(
  vapply(formula_nullability_open$page$schema, `[[`, logical(1L), "nullable", USE.NAMES = FALSE),
  c(TRUE, TRUE),
  "the chained R Formula source did not start conservatively nullable"
)
formula_nullability_fill_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_nullability_session_id,
    revision = 0L,
    step = fill_step("formula-nullability-fill", "r:c:0", "left", list(kind = "mean")),
    page = page_window()
  )
)
assert_identical(
  formula_nullability_fill_preview$kind,
  "stepPreview",
  "the chained R Formula fill did not preview"
)
assert_identical(
  vapply(
    formula_nullability_fill_preview$page$schema,
    `[[`,
    logical(1L),
    "nullable",
    USE.NAMES = FALSE
  ),
  c(FALSE, TRUE),
  "Fill Missing did not separate left and right nullability"
)
formula_nullability_fill_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_nullability_session_id, revision = 1L, page = page_window())
)
assert_identical(formula_nullability_fill_apply$action, "apply", "the chained R Formula fill did not apply")
formula_nullability_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_nullability_session_id,
    revision = 2L,
    step = formula_step(
      "formula-nullability-add",
      "add",
      "sum",
      right_position = 2L,
      right_name = "right"
    ),
    page = page_window()
  )
)
assert_identical(formula_nullability_preview$kind, "stepPreview", "the chained R Formula did not preview")
assert_identical(
  formula_nullability_preview$page$schema[[1L]]$nullable,
  FALSE,
  "the chained R Formula changed filled-left nullability"
)
assert_identical(
  formula_nullability_preview$page$schema[[2L]]$nullable,
  TRUE,
  "the chained R Formula changed conservative right nullability"
)
assert_identical(
  formula_nullability_preview$page$schema[[3L]]$nullable,
  TRUE,
  "R Formula ignored conservative right-operand nullability"
)
assert_identical(
  numeric_page_values(formula_nullability_preview, "sum"),
  c(11, 22, 33),
  "the chained live R Formula changed values"
)
formula_nullability_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_nullability_session_id, revision = 3L, page = page_window())
)
assert_identical(formula_nullability_apply$action, "apply", "the chained R Formula did not apply")
assert_identical(
  formula_nullability_apply$page$schema[[3L]]$nullable,
  TRUE,
  "applying R Formula lost conservative right-operand nullability"
)
assign(
  "formula_nullability_frame",
  source_environment$formula_nullability_frame,
  envir = .GlobalEnv
)
eval(parse(text = formula_nullability_apply$code), envir = .GlobalEnv)
formula_nullability_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  formula_nullability_generated$left,
  c(1, 2, 3),
  "generated chained Fill Missing changed values"
)
assert_identical(
  formula_nullability_generated$sum,
  c(11, 22, 33),
  "generated chained R Formula disagreed with live execution"
)
assert_identical(
  get("formula_nullability_frame", envir = .GlobalEnv),
  formula_nullability_before,
  "generated chained R Formula mutated its source"
)
assert_identical(
  source_environment$formula_nullability_frame,
  formula_nullability_before,
  "live chained R Formula mutated its source"
)
rm("formula_nullability_frame", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = formula_nullability_session_id)))

source_environment$formula_nonfinite_frame <- data.frame(
  value = c(NaN, Inf, -Inf, 1),
  check.names = FALSE
)
formula_nonfinite_before <- unserialize(serialize(
  source_environment$formula_nonfinite_frame,
  NULL,
  version = 3L
))
formula_nonfinite_open <- dispatch(
  "openSession",
  list(
    sessionId = formula_nonfinite_session_id,
    variableName = "formula_nonfinite_frame",
    page = page_window()
  )
)
assert_identical(formula_nonfinite_open$kind, "page", "the non-finite R Formula session did not open")
formula_nonfinite_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_nonfinite_session_id,
    revision = 0L,
    step = formula_step("formula-nonfinite", "add", "shifted", value = 1, left_name = "value"),
    page = page_window()
  )
)
assert_identical(
  formula_nonfinite_preview$kind,
  "stepPreview",
  sprintf(
    "R Formula rejected source NaN or infinity: %s",
    if (identical(formula_nonfinite_preview$kind, "error")) {
      paste(formula_nonfinite_preview$error$code, formula_nonfinite_preview$error$message, sep = ": ")
    } else {
      format(formula_nonfinite_preview)
    }
  )
)
assert_identical(
  vapply(
    formula_nonfinite_preview$page$page$rows,
    function(row) row$values[[2L]]$kind,
    character(1L),
    USE.NAMES = FALSE
  ),
  c("nan", "infinity", "infinity", "number"),
  "live R Formula changed typed source non-finite values"
)
formula_nonfinite_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_nonfinite_session_id, revision = 1L, page = page_window())
)
assert_identical(formula_nonfinite_apply$action, "apply", "the non-finite R Formula did not apply")
assign("formula_nonfinite_frame", source_environment$formula_nonfinite_frame, envir = .GlobalEnv)
eval(parse(text = formula_nonfinite_apply$code), envir = .GlobalEnv)
formula_nonfinite_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  formula_nonfinite_generated$shifted,
  c(NaN, Inf, -Inf, 2),
  "generated R Formula changed source NaN or infinity"
)
assert_identical(
  get("formula_nonfinite_frame", envir = .GlobalEnv),
  formula_nonfinite_before,
  "generated non-finite R Formula mutated its source"
)
assert_identical(
  source_environment$formula_nonfinite_frame,
  formula_nonfinite_before,
  "live non-finite R Formula mutated its source"
)
rm("formula_nonfinite_frame", "open_wrangler_result", envir = .GlobalEnv)

formula_missing_power_source <- data.frame(
  left = c(NA_real_, 1, NaN, Inf),
  right = c(0, NA_real_, 0, 0),
  check.names = FALSE
)
source_environment$formula_missing_power_frame <- formula_missing_power_source
formula_missing_power_session_id <- "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1"
formula_missing_power_open <- dispatch(
  "openSession",
  list(
    sessionId = formula_missing_power_session_id,
    variableName = "formula_missing_power_frame",
    page = page_window()
  )
)
assert_identical(formula_missing_power_open$kind, "page", "the missing-power R Formula session did not open")
formula_missing_power_preview <- dispatch(
  "previewStep",
  list(
    sessionId = formula_missing_power_session_id,
    revision = 0L,
    step = formula_step(
      "formula-missing-power",
      "power",
      "missing power",
      left_name = "left",
      right_position = 2L,
      right_name = "right"
    ),
    page = page_window()
  )
)
assert_identical(
  vapply(
    formula_missing_power_preview$page$page$rows,
    function(row) row$values[[3L]]$kind,
    character(1L),
    USE.NAMES = FALSE
  ),
  c("null", "null", "number", "number"),
  "live R Formula changed missing, NaN, or infinity power semantics"
)
formula_missing_power_apply <- dispatch(
  "applyDraft",
  list(sessionId = formula_missing_power_session_id, revision = 1L, page = page_window())
)
assign("formula_missing_power_frame", formula_missing_power_source, envir = .GlobalEnv)
eval(parse(text = formula_missing_power_apply$code), envir = .GlobalEnv)
assert_identical(
  get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)$`missing power`,
  c(NA_real_, NA_real_, 1, 1),
  "generated R Formula changed missing, NaN, or infinity power semantics"
)
rm("formula_missing_power_frame", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = formula_missing_power_session_id)))

formula_s3_frame <- data.frame(value = structure(c(1, 2), class = c("evil", "numeric")), check.names = FALSE)
formula_s3_before <- serialize(formula_s3_frame, NULL, version = 3L)
assign("formula_nonfinite_frame", formula_s3_frame, envir = .GlobalEnv)
assign("+.evil", function(e1, e2) rep.int(999, length(e1)), envir = .GlobalEnv)
formula_s3_error <- tryCatch(
  {
    eval(parse(text = formula_nonfinite_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(formula_s3_error, "error"),
  TRUE,
  "generated R Formula accepted a custom numeric S3 class"
)
assert_identical(
  serialize(get("formula_nonfinite_frame", envir = .GlobalEnv), NULL, version = 3L),
  formula_s3_before,
  "a rejected generated R Formula mutated its custom-class source"
)
rm("formula_nonfinite_frame", "+.evil", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = formula_nonfinite_session_id)))

source_environment$formula_failure_frame <- data.frame(
  unsafe_double = c(1, .Machine$double.xmax),
  zero_or_two = c(0, 2),
  unsafe_integer = c(.Machine$integer.max, 1L),
  check.names = FALSE
)
formula_failure_before <- unserialize(serialize(source_environment$formula_failure_frame, NULL, version = 3L))
formula_failure_open <- dispatch(
  "openSession",
  list(sessionId = formula_failure_session_id, variableName = "formula_failure_frame", page = page_window())
)
assert_identical(formula_failure_open$kind, "page", "the failing R Formula session did not open")
formula_failure_cases <- list(
  formula_step(
    "formula-divide-zero",
    "divide",
    "divide zero",
    left_name = "unsafe_double",
    right_position = 2L,
    right_name = "zero_or_two"
  ),
  formula_step(
    "formula-modulo-zero",
    "modulo",
    "modulo zero",
    left_name = "unsafe_double",
    right_position = 2L,
    right_name = "zero_or_two"
  ),
  formula_step(
    "formula-power-overflow",
    "power",
    "power overflow",
    left_name = "unsafe_double",
    value = 2
  ),
  formula_step(
    "formula-integer-overflow",
    "add",
    "integer overflow",
    left_position = 3L,
    left_name = "unsafe_integer",
    value = 1L
  )
)
for (formula_failure_step in formula_failure_cases) {
  formula_failure <- dispatch(
    "previewStep",
    list(
      sessionId = formula_failure_session_id,
      revision = 0L,
      step = formula_failure_step,
      page = page_window()
    )
  )
  assert_identical(
    formula_failure$kind,
    "error",
    sprintf("%s did not reject non-finite or overflowing output", formula_failure_step$id)
  )
  assert_identical(
    formula_failure$code,
    "invalid_request",
    sprintf("%s returned the wrong failure code", formula_failure_step$id)
  )
}
formula_failure_page <- dispatch(
  "getPage",
  list(sessionId = formula_failure_session_id, page = page_window())
)
assert_identical(formula_failure_page$kind, "page", "a failed R Formula left its session unusable")
assert_identical(formula_failure_page$page$shape$columns, 3L, "a failed R Formula retained a draft column")
assert_identical(
  source_environment$formula_failure_frame,
  formula_failure_before,
  "a failed R Formula mutated its source"
)
invisible(dispatch("closeSession", list(sessionId = formula_failure_session_id)))

source_environment$datetime_frame <- data.frame(
  day = as.Date(c("2024-02-29", "2025-01-02", NA)),
  moment = as.POSIXct(
    c("2024-03-31 00:30:00", "2024-03-31 03:30:00", NA),
    tz = "Europe/Berlin"
  ),
  label = c("leap", "new year", "missing"),
  row.names = c("datetime-a", "datetime-b", "datetime-c"),
  check.names = FALSE
)
datetime_before <- unserialize(serialize(source_environment$datetime_frame, NULL, version = 3L))
datetime_open <- dispatch(
  "openSession",
  list(sessionId = datetime_session_id, variableName = "datetime_frame", page = page_window())
)
assert_identical(datetime_open$kind, "page", "the R Format Datetime session did not open")

datetime_extra_step <- datetime_format_step("datetime-extra", 1L, "day", "%Y")
datetime_extra_step$params$extra <- TRUE
datetime_extra <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_session_id,
    revision = 0L,
    step = datetime_extra_step,
    page = page_window()
  )
)
assert_identical(datetime_extra$kind, "error", "R Format Datetime accepted an unknown parameter")
assert_identical(datetime_extra$code, "invalid_request", "the R Format Datetime exact-record diagnostic changed")

datetime_empty_format <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_session_id,
    revision = 0L,
    step = datetime_format_step("datetime-empty-format", 1L, "day", ""),
    page = page_window()
  )
)
assert_identical(datetime_empty_format$kind, "error", "R Format Datetime accepted an empty format")
assert_identical(datetime_empty_format$code, "invalid_request", "the empty R datetime-format diagnostic changed")

datetime_legacy_step <- datetime_format_step("datetime-legacy", 1L, "day", "%Y")
datetime_legacy_step$params$column <- "day"
datetime_legacy <- dispatch(
  "previewStep",
  list(sessionId = datetime_session_id, revision = 0L, step = datetime_legacy_step, page = page_window())
)
assert_identical(datetime_legacy$kind, "error", "R Format Datetime accepted a legacy string column")
assert_identical(datetime_legacy$code, "invalid_request", "the R Format Datetime legacy-column diagnostic changed")

datetime_stale <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_session_id,
    revision = 0L,
    step = datetime_format_step("datetime-stale", 2L, "day", "%Y"),
    page = page_window()
  )
)
assert_identical(datetime_stale$kind, "error", "R Format Datetime accepted an ID/name mismatch")
assert_identical(datetime_stale$code, "stale_column", "the R Format Datetime stale-column diagnostic changed")

datetime_text <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_session_id,
    revision = 0L,
    step = datetime_format_step("datetime-text", 3L, "label", "%Y"),
    page = page_window()
  )
)
assert_identical(datetime_text$kind, "error", "R Format Datetime accepted a text column")
assert_identical(datetime_text$code, "invalid_request", "the R Format Datetime type diagnostic changed")

datetime_fractional_session_id <- "83838383-8383-4383-8383-838383838383"
source_environment$datetime_fractional_frame <- data.frame(
  day = structure(c(0, 0.5, 1), class = "Date"),
  check.names = FALSE
)
datetime_fractional_open <- dispatch(
  "openSession",
  list(
    sessionId = datetime_fractional_session_id,
    variableName = "datetime_fractional_frame",
    page = page_window(row_offset = 0L, row_limit = 1L)
  )
)
assert_identical(datetime_fractional_open$kind, "page", "the bounded fractional Date session did not open")
datetime_fractional <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_fractional_session_id,
    revision = 0L,
    step = datetime_format_step("datetime-fractional", 1L, "day", "%Y-%m-%d", "formatted day"),
    page = page_window(row_offset = 0L, row_limit = 1L)
  )
)
assert_identical(datetime_fractional$kind, "error", "R Format Datetime laundered an unseen fractional Date")
assert_identical(datetime_fractional$code, "unsupported_frame", "the fractional Date diagnostic changed")
invisible(dispatch("closeSession", list(sessionId = datetime_fractional_session_id)))

datetime_collision <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_session_id,
    revision = 0L,
    step = datetime_format_step("datetime-collision", 1L, "day", "%Y", "label"),
    page = page_window()
  )
)
assert_identical(datetime_collision$kind, "error", "R Format Datetime overwrote another column")
assert_identical(datetime_collision$code, "invalid_request", "the R Format Datetime collision diagnostic changed")

datetime_private <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_session_id,
    revision = 0L,
    step = datetime_format_step(
      "datetime-private",
      1L,
      "day",
      "%Y",
      "__OPEN_WRANGLER_INTERNAL_ROW_ID_public"
    ),
    page = page_window()
  )
)
assert_identical(datetime_private$kind, "error", "R Format Datetime exposed the private row-identity namespace")
assert_identical(datetime_private$code, "invalid_request", "the R Format Datetime private-name diagnostic changed")

datetime_discard_preview <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_session_id,
    revision = 0L,
    step = datetime_format_step("datetime-discard", 1L, "day", "%Y/%m/%d", "discarded day"),
    page = page_window()
  )
)
assert_identical(datetime_discard_preview$kind, "stepPreview", "appended R Format Datetime did not preview")
assert_identical(
  datetime_discard_preview$diff$addedColumns,
  list("discarded day"),
  "the appended R Format Datetime diff changed"
)
assert_identical(datetime_discard_preview$diff$changedCells, 0L, "appended R Format Datetime reported changed cells")
datetime_discard_schema <- datetime_discard_preview$page$schema[[4L]]
assert_identical(
  datetime_discard_schema$id,
  "c:step:datetime-discard:0",
  "the appended R Format Datetime identity changed"
)
assert_identical(datetime_discard_schema$rawType, "character", "R Format Datetime did not publish character output")
assert_identical(datetime_discard_schema$type, "string", "R Format Datetime did not publish string output")
assert_identical(datetime_discard_schema$nullable, TRUE, "R Format Datetime did not retain nullability")
assert_identical(
  text_page_values(datetime_discard_preview, "discarded day"),
  c("2024/02/29", "2025/01/02", NA_character_),
  "live Date formatting values changed"
)
datetime_discard <- dispatch(
  "discardDraft",
  list(sessionId = datetime_session_id, revision = datetime_discard_preview$revision, page = page_window())
)
assert_identical(datetime_discard$action, "discard", "the R Format Datetime draft did not discard")
assert_identical(datetime_discard$code, "", "discarding R Format Datetime retained generated code")
assert_identical(source_environment$datetime_frame, datetime_before, "discarding R Format Datetime mutated its source")

datetime_date_preview <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_session_id,
    revision = datetime_discard$revision,
    step = datetime_format_step("datetime-date", 1L, "day", "%Y-%j", "day of year"),
    page = page_window()
  )
)
assert_identical(datetime_date_preview$kind, "stepPreview", "appended Date formatting did not preview")
assert_identical(
  text_page_values(datetime_date_preview, "day of year"),
  c("2024-060", "2025-002", NA_character_),
  "live Date formatting changed leap-year semantics"
)
datetime_revision <- datetime_date_preview$revision
datetime_date_apply <- dispatch(
  "applyDraft",
  list(sessionId = datetime_session_id, revision = datetime_revision, page = page_window())
)
assert_identical(datetime_date_apply$action, "apply", "appended Date formatting did not apply")
datetime_revision <- datetime_date_apply$revision

datetime_moment_preview <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_session_id,
    revision = datetime_revision,
    step = datetime_format_step("datetime-moment", 2L, "moment", "%Y-%m-%d %H:%M %Z"),
    page = page_window()
  )
)
assert_identical(datetime_moment_preview$kind, "stepPreview", "in-place POSIXct formatting did not preview")
assert_identical(datetime_moment_preview$diff$addedColumns, list(), "in-place R Format Datetime reported an added column")
assert_identical(datetime_moment_preview$diff$changedCells, 2L, "in-place R Format Datetime returned the wrong changed-cell count")
assert_identical(
  text_page_values(datetime_moment_preview, "moment"),
  c("2024-03-31 00:30 CET", "2024-03-31 03:30 CEST", NA_character_),
  "live POSIXct formatting changed source-timezone or DST semantics"
)
datetime_moment_schema <- datetime_moment_preview$page$schema[[2L]]
assert_identical(datetime_moment_schema$id, "r:c:1", "in-place R Format Datetime changed its stable identity")
assert_identical(datetime_moment_schema$rawType, "character", "in-place R Format Datetime did not change raw type")
assert_identical(datetime_moment_schema$type, "string", "in-place R Format Datetime did not change public type")
assert_identical(datetime_moment_schema$nullable, TRUE, "in-place R Format Datetime lost nullability")
datetime_revision <- datetime_moment_preview$revision
datetime_moment_apply <- dispatch(
  "applyDraft",
  list(sessionId = datetime_session_id, revision = datetime_revision, page = page_window())
)
assert_identical(datetime_moment_apply$action, "apply", "in-place POSIXct formatting did not apply")
datetime_revision <- datetime_moment_apply$revision

datetime_inspection <- inspect_step(
  datetime_session_id,
  datetime_revision,
  "datetime-moment",
  page_window()
)
assert_identical(datetime_inspection$diff$changedCells, 2L, "R Format Datetime history returned the wrong diff")
assert_identical(
  unlist(datetime_inspection$inputPage$page$columnIds, use.names = FALSE),
  unlist(datetime_inspection$outputPage$page$columnIds, use.names = FALSE),
  "in-place R Format Datetime history changed column identities"
)
assert_schema_less_inspection(datetime_inspection, "R Format Datetime inspection")

assign("datetime_frame", source_environment$datetime_frame, envir = .GlobalEnv)
eval(parse(text = datetime_moment_apply$code), envir = .GlobalEnv)
datetime_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  datetime_generated$`day of year`,
  c("2024-060", "2025-002", NA_character_),
  "generated Date formatting values changed"
)
assert_identical(
  datetime_generated$moment,
  c("2024-03-31 00:30 CET", "2024-03-31 03:30 CEST", NA_character_),
  "generated POSIXct formatting changed timezone semantics"
)
assert_identical(row.names(datetime_generated), row.names(datetime_before), "generated R Format Datetime changed row names")
assert_identical(get("datetime_frame", envir = .GlobalEnv), datetime_before, "generated R Format Datetime mutated its source")
assert_identical(source_environment$datetime_frame, datetime_before, "the R Format Datetime lifecycle mutated its source")
rm("datetime_frame", "open_wrangler_result", envir = .GlobalEnv)

datetime_utc_replay <- datetime_before
datetime_utc_replay$moment <- as.POSIXct(
  c("2024-03-31 00:30:00", "2024-03-31 03:30:00", NA),
  tz = "UTC"
)
assign("datetime_frame", datetime_utc_replay, envir = .GlobalEnv)
eval(parse(text = datetime_moment_apply$code), envir = .GlobalEnv)
datetime_utc_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  datetime_utc_generated$moment,
  c("2024-03-31 00:30 UTC", "2024-03-31 03:30 UTC", NA_character_),
  "generated POSIXct formatting reused a stale captured timezone"
)
assert_identical(
  get("datetime_frame", envir = .GlobalEnv),
  datetime_utc_replay,
  "generated POSIXct timezone replay mutated its source"
)
rm("datetime_frame", "open_wrangler_result", envir = .GlobalEnv)

datetime_bad_timezone <- datetime_utc_replay
attr(datetime_bad_timezone$moment, "tzone") <- strrep("x", 1025L)
datetime_bad_timezone_before <- serialize(datetime_bad_timezone, NULL, version = 3L)
assign("datetime_frame", datetime_bad_timezone, envir = .GlobalEnv)
datetime_bad_timezone_error <- tryCatch(
  {
    eval(parse(text = datetime_moment_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(datetime_bad_timezone_error, "error"),
  TRUE,
  "generated R Format Datetime accepted an oversized POSIXct timezone"
)
assert_identical(
  serialize(get("datetime_frame", envir = .GlobalEnv), NULL, version = 3L),
  datetime_bad_timezone_before,
  "a rejected generated R Format Datetime mutated its source"
)
rm("datetime_frame", envir = .GlobalEnv)

datetime_undo <- dispatch(
  "undoStep",
  list(sessionId = datetime_session_id, revision = datetime_revision, page = page_window())
)
assert_identical(datetime_undo$action, "undo", "in-place R Format Datetime did not undo")
assert_identical(datetime_undo$page$schema[[2L]]$rawType, "POSIXct", "undo did not restore the POSIXct schema")
assert_identical(datetime_undo$page$schema[[2L]]$id, "r:c:1", "undo changed the restored POSIXct identity")
invisible(dispatch("closeSession", list(sessionId = datetime_session_id)))

source_environment$datetime_replay_frame <- data.frame(
  day = as.Date(c("2024-02-29", "2025-01-02", NA)),
  row.names = c("replay-a", "replay-b", "replay-c"),
  check.names = FALSE
)
datetime_replay_before <- unserialize(serialize(
  source_environment$datetime_replay_frame,
  NULL,
  version = 3L
))
datetime_replay_open <- dispatch(
  "openSession",
  list(
    sessionId = datetime_replay_session_id,
    variableName = "datetime_replay_frame",
    page = page_window()
  )
)
assert_identical(datetime_replay_open$kind, "page", "the generated datetime replay-bound session did not open")
datetime_replay_preview <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_replay_session_id,
    revision = 0L,
    step = datetime_format_step("datetime-replay-in-place", 1L, "day", "%Y%m%d"),
    page = page_window()
  )
)
assert_identical(datetime_replay_preview$kind, "stepPreview", "the generated in-place datetime replay did not preview")
datetime_replay_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = datetime_replay_session_id,
    revision = datetime_replay_preview$revision,
    page = page_window()
  )
)
assert_identical(datetime_replay_apply$action, "apply", "the generated in-place datetime replay did not apply")
datetime_replay_guard_offset <- regexpr(
  ".ow_source_column_count <-",
  datetime_replay_apply$code,
  fixed = TRUE
)[[1L]]
datetime_replay_step_offset <- regexpr(
  ".ow_datetime_position <-",
  datetime_replay_apply$code,
  fixed = TRUE
)[[1L]]
assert_identical(
  datetime_replay_guard_offset > 0L && datetime_replay_guard_offset < datetime_replay_step_offset,
  TRUE,
  "generated R did not validate replay width before its in-place Format Datetime step"
)

datetime_replay_parent <- new.env(parent = baseenv())
base::assign(
  "datetime_replay_frame",
  data.frame(day = as.Date("1900-01-01"), check.names = FALSE),
  envir = datetime_replay_parent
)
datetime_replay_environment <- new.env(parent = datetime_replay_parent)
base::assign("datetime_replay_frame", datetime_replay_before, envir = datetime_replay_environment)
datetime_caller_override <- function(...) {
  base::stop("a caller generated-code override was evaluated", call. = FALSE)
}
datetime_caller_override_names <- c(
  "format.Date",
  "format",
  "get",
  "local",
  "evalq",
  "list2env",
  "environment",
  "baseenv",
  "is.data.frame",
  "class",
  "attributes",
  "names",
  "length",
  "serialize",
  "unserialize",
  "inherits",
  "requireNamespace"
)
for (override_name in datetime_caller_override_names) {
  base::assign(override_name, datetime_caller_override, envir = datetime_replay_environment)
}
for (helper_name in c(
  ".ow_source_environment",
  ".ow_source",
  ".ow_result",
  ".ow_source_column_count",
  ".ow_source_names",
  ".ow_datetime_source",
  ".ow_datetime_values"
)) {
  base::assign(helper_name, "caller helper collision", envir = datetime_replay_environment)
}
base::eval(base::parse(text = datetime_replay_apply$code), envir = datetime_replay_environment)
datetime_replay_generated <- base::get(
  "open_wrangler_result",
  envir = datetime_replay_environment,
  inherits = FALSE
)
assert_identical(
  datetime_replay_generated$day,
  c("20240229", "20250102", NA_character_),
  "generated R Format Datetime used a caller format.Date override"
)
assert_identical(
  base::get("datetime_replay_frame", envir = datetime_replay_environment, inherits = FALSE),
  datetime_replay_before,
  "caller-isolated generated R Format Datetime mutated its exact source"
)

datetime_replay_maximum <- datetime_replay_before[seq_len(2L), , drop = FALSE]
datetime_replay_maximum[paste0("extra_", seq_len(2047L))] <- rep(
  list(c(1L, 2L)),
  2047L
)
datetime_replay_maximum_before <- serialize(datetime_replay_maximum, NULL, version = 3L)
datetime_replay_maximum_environment <- new.env(parent = baseenv())
base::assign(
  "datetime_replay_frame",
  datetime_replay_maximum,
  envir = datetime_replay_maximum_environment
)
base::eval(base::parse(text = datetime_replay_apply$code), envir = datetime_replay_maximum_environment)
datetime_replay_maximum_generated <- base::get(
  "open_wrangler_result",
  envir = datetime_replay_maximum_environment,
  inherits = FALSE
)
assert_identical(
  ncol(datetime_replay_maximum_generated),
  2048L,
  "generated in-place Format Datetime rejected the maximum supported replay width"
)
assert_identical(
  datetime_replay_maximum_generated$day,
  c("20240229", "20250102"),
  "generated in-place Format Datetime changed values at the maximum replay width"
)
assert_identical(
  serialize(
    base::get("datetime_replay_frame", envir = datetime_replay_maximum_environment, inherits = FALSE),
    NULL,
    version = 3L
  ),
  datetime_replay_maximum_before,
  "maximum-width generated in-place Format Datetime mutated its source"
)

datetime_replay_empty_environment <- new.env(parent = baseenv())
base::assign(
  "datetime_replay_frame",
  data.frame(row.names = c("empty-a", "empty-b")),
  envir = datetime_replay_empty_environment
)
datetime_replay_empty_error <- tryCatch(
  {
    base::eval(base::parse(text = datetime_replay_apply$code), envir = datetime_replay_empty_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(datetime_replay_empty_error),
  "Open Wrangler generated R requires between 1 and 2048 source columns",
  "generated in-place Format Datetime accepted a zero-column replay"
)
assert_identical(
  base::exists("open_wrangler_result", envir = datetime_replay_empty_environment, inherits = FALSE),
  FALSE,
  "a zero-column replay published a generated R result"
)

datetime_replay_oversized <- datetime_replay_maximum
datetime_replay_oversized[["extra_2048"]] <- c(1L, 2L)
datetime_replay_oversized_before <- serialize(datetime_replay_oversized, NULL, version = 3L)
datetime_replay_oversized_environment <- new.env(parent = baseenv())
base::assign(
  "datetime_replay_frame",
  datetime_replay_oversized,
  envir = datetime_replay_oversized_environment
)
datetime_replay_oversized_error <- tryCatch(
  {
    base::eval(base::parse(text = datetime_replay_apply$code), envir = datetime_replay_oversized_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(datetime_replay_oversized_error),
  "Open Wrangler generated R requires between 1 and 2048 source columns",
  "generated in-place Format Datetime accepted a 2049-column replay"
)
assert_identical(
  serialize(
    base::get("datetime_replay_frame", envir = datetime_replay_oversized_environment, inherits = FALSE),
    NULL,
    version = 3L
  ),
  datetime_replay_oversized_before,
  "a rejected oversized generated replay mutated its source"
)
assert_identical(
  base::exists("open_wrangler_result", envir = datetime_replay_oversized_environment, inherits = FALSE),
  FALSE,
  "a 2049-column replay published a generated R result"
)

datetime_replay_malformed <- base::structure(
  list(
    day = as.Date(c("2024-02-29", "2025-01-02")),
    short = 1L
  ),
  names = c("day", "short"),
  class = "data.frame",
  row.names = c("malformed-a", "malformed-b")
)
datetime_replay_malformed_before <- serialize(datetime_replay_malformed, NULL, version = 3L)
datetime_replay_malformed_environment <- new.env(parent = baseenv())
base::assign(
  "datetime_replay_frame",
  datetime_replay_malformed,
  envir = datetime_replay_malformed_environment
)
datetime_replay_malformed_error <- tryCatch(
  {
    base::eval(base::parse(text = datetime_replay_apply$code), envir = datetime_replay_malformed_environment)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(datetime_replay_malformed_error),
  "Open Wrangler generated R received a source column whose length does not match its row count: source column 2",
  "generated in-place Format Datetime accepted unequal source-column lengths"
)
assert_identical(
  serialize(
    base::get("datetime_replay_frame", envir = datetime_replay_malformed_environment, inherits = FALSE),
    NULL,
    version = 3L
  ),
  datetime_replay_malformed_before,
  "a rejected unequal-length generated replay mutated its source"
)
assert_identical(
  base::exists("open_wrangler_result", envir = datetime_replay_malformed_environment, inherits = FALSE),
  FALSE,
  "an unequal-length generated replay published a result"
)

datetime_replay_zero <- data.frame(day = as.Date(character()), check.names = FALSE)
datetime_replay_zero_before <- serialize(datetime_replay_zero, NULL, version = 3L)
datetime_replay_zero_environment <- new.env(parent = baseenv())
base::assign("datetime_replay_frame", datetime_replay_zero, envir = datetime_replay_zero_environment)
base::eval(base::parse(text = datetime_replay_apply$code), envir = datetime_replay_zero_environment)
datetime_replay_zero_generated <- base::get(
  "open_wrangler_result",
  envir = datetime_replay_zero_environment,
  inherits = FALSE
)
assert_identical(nrow(datetime_replay_zero_generated), 0L, "generated Format Datetime rejected a zero-row frame")
assert_identical(
  datetime_replay_zero_generated$day,
  character(),
  "generated Format Datetime changed a zero-row Date column incorrectly"
)
assert_identical(
  serialize(base::get("datetime_replay_frame", envir = datetime_replay_zero_environment), NULL, version = 3L),
  datetime_replay_zero_before,
  "generated Format Datetime mutated a zero-row source"
)
invisible(dispatch("closeSession", list(sessionId = datetime_replay_session_id)))
rm("datetime_replay_frame", envir = source_environment)

datetime_output_budget <- 64L * 1024L * 1024L
datetime_output_slot_bytes <- 8L
datetime_output_format <- paste(rep("%Y%m%d", 127L), collapse = "")
datetime_output_text_bytes <- nchar(
  format(as.Date("2026-01-01"), format = datetime_output_format),
  type = "bytes"
)
datetime_output_boundary_rows <- 65536L
assert_identical(
  datetime_output_boundary_rows * (datetime_output_slot_bytes + datetime_output_text_bytes),
  datetime_output_budget,
  "the kernel Format Datetime aggregate-output boundary fixture changed"
)
source_environment$datetime_output_budget_frame <- data.frame(
  day = rep(as.Date("2026-01-01"), datetime_output_boundary_rows),
  check.names = FALSE
)
datetime_output_budget_before <- serialize(
  source_environment$datetime_output_budget_frame,
  NULL,
  version = 3L
)
datetime_output_budget_open <- dispatch(
  "openSession",
  list(
    sessionId = datetime_output_budget_session_id,
    variableName = "datetime_output_budget_frame",
    page = page_window(row_limit = 1L)
  )
)
assert_identical(datetime_output_budget_open$kind, "page", "the exact datetime output-budget session did not open")
datetime_output_budget_preview <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_output_budget_session_id,
    revision = 0L,
    step = datetime_format_step(
      "datetime-output-budget",
      1L,
      "day",
      datetime_output_format,
      "formatted"
    ),
    page = page_window(row_limit = 1L)
  )
)
assert_identical(
  datetime_output_budget_preview$kind,
  "stepPreview",
  "live R Format Datetime rejected the exact 64 MiB aggregate-output boundary"
)
assert_identical(
  nchar(text_page_values(datetime_output_budget_preview, "formatted")[[1L]], type = "bytes"),
  datetime_output_text_bytes,
  "live R Format Datetime truncated output at the aggregate boundary"
)
datetime_output_budget_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = datetime_output_budget_session_id,
    revision = 1L,
    page = page_window(row_limit = 1L)
  )
)
assert_identical(datetime_output_budget_apply$action, "apply", "the exact datetime output-budget draft did not apply")
assert_identical(
  grepl(".ow_datetime_chunk_source", datetime_output_budget_apply$code, fixed = TRUE),
  TRUE,
  "generated R Format Datetime no longer formats bounded source chunks"
)
assign(
  "datetime_output_budget_frame",
  source_environment$datetime_output_budget_frame,
  envir = .GlobalEnv
)
eval(parse(text = datetime_output_budget_apply$code), envir = .GlobalEnv)
datetime_output_budget_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  length(datetime_output_budget_generated$formatted),
  datetime_output_boundary_rows,
  "generated R Format Datetime rejected the exact aggregate-output boundary"
)
assert_identical(
  nchar(datetime_output_budget_generated$formatted[[datetime_output_boundary_rows]], type = "bytes"),
  datetime_output_text_bytes,
  "generated R Format Datetime truncated output at the aggregate boundary"
)
assert_identical(
  serialize(get("datetime_output_budget_frame", envir = .GlobalEnv), NULL, version = 3L),
  datetime_output_budget_before,
  "generated aggregate-boundary formatting mutated its source"
)
assert_identical(
  serialize(source_environment$datetime_output_budget_frame, NULL, version = 3L),
  datetime_output_budget_before,
  "live aggregate-boundary formatting mutated its source"
)
rm("open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = datetime_output_budget_session_id)))

source_environment$datetime_output_oversize_frame <- data.frame(
  day = rep(as.Date("2026-01-01"), datetime_output_boundary_rows + 1L),
  check.names = FALSE
)
datetime_output_oversize_before <- serialize(
  source_environment$datetime_output_oversize_frame,
  NULL,
  version = 3L
)
datetime_output_oversize_open <- dispatch(
  "openSession",
  list(
    sessionId = datetime_output_oversize_session_id,
    variableName = "datetime_output_oversize_frame",
    page = page_window(row_limit = 1L)
  )
)
assert_identical(datetime_output_oversize_open$kind, "page", "the oversized datetime output session did not open")
datetime_output_oversize_preview <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_output_oversize_session_id,
    revision = 0L,
    step = datetime_format_step(
      "datetime-output-oversize",
      1L,
      "day",
      datetime_output_format,
      "formatted"
    ),
    page = page_window(row_limit = 1L)
  )
)
assert_identical(datetime_output_oversize_preview$kind, "error", "live R Format Datetime exceeded 64 MiB")
assert_identical(datetime_output_oversize_preview$code, "invalid_request", "the aggregate-output diagnostic changed")
assert_identical(
  grepl("67108864-byte aggregate output budget", datetime_output_oversize_preview$message, fixed = TRUE),
  TRUE,
  "the live aggregate-output diagnostic lost its exact budget"
)
assert_identical(
  serialize(source_environment$datetime_output_oversize_frame, NULL, version = 3L),
  datetime_output_oversize_before,
  "rejected live aggregate-output formatting mutated its source"
)
invisible(dispatch("closeSession", list(sessionId = datetime_output_oversize_session_id)))

assign(
  "datetime_output_budget_frame",
  source_environment$datetime_output_oversize_frame,
  envir = .GlobalEnv
)
datetime_output_generated_oversize_error <- tryCatch(
  {
    eval(parse(text = datetime_output_budget_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  inherits(datetime_output_generated_oversize_error, "error"),
  TRUE,
  "generated R Format Datetime exceeded its 64 MiB aggregate-output budget"
)
assert_identical(
  grepl(
    "67108864-byte aggregate output budget",
    conditionMessage(datetime_output_generated_oversize_error),
    fixed = TRUE
  ),
  TRUE,
  "the generated aggregate-output diagnostic lost its exact budget"
)
assert_identical(
  serialize(get("datetime_output_budget_frame", envir = .GlobalEnv), NULL, version = 3L),
  datetime_output_oversize_before,
  "rejected generated aggregate-output formatting mutated its source"
)
rm("datetime_output_budget_frame", envir = .GlobalEnv)

source_environment$datetime_table <- data.table::data.table(
  key_time = as.POSIXct(c("2024-01-02 12:00:00", "2024-01-01 12:00:00"), tz = "UTC"),
  marker = c("second", "first")
)
data.table::setkey(source_environment$datetime_table, key_time)
datetime_table_before <- data.table::copy(source_environment$datetime_table)
datetime_table_open <- dispatch(
  "openSession",
  list(sessionId = datetime_table_session_id, variableName = "datetime_table", page = page_window())
)
assert_identical(datetime_table_open$kind, "page", "the keyed R Format Datetime session did not open")
datetime_key_error <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_table_session_id,
    revision = 0L,
    step = datetime_format_step("datetime-key", 1L, "key_time", "%Y-%m-%d"),
    page = page_window()
  )
)
assert_identical(datetime_key_error$kind, "error", "R Format Datetime replaced a data.table key in place")
assert_identical(datetime_key_error$code, "invalid_request", "the R Format Datetime key diagnostic changed")
datetime_key_copy <- dispatch(
  "previewStep",
  list(
    sessionId = datetime_table_session_id,
    revision = 0L,
    step = datetime_format_step("datetime-key-copy", 1L, "key_time", "%Y-%m-%d", "formatted key"),
    page = page_window()
  )
)
assert_identical(datetime_key_copy$kind, "stepPreview", "R Format Datetime could not read a key into a new column")
assert_identical(datetime_key_copy$page$frameSemantics$keyColumnIds, list("r:c:0"), "derived R Format Datetime lost the key identity")
datetime_key_apply <- dispatch(
  "applyDraft",
  list(sessionId = datetime_table_session_id, revision = 1L, page = page_window())
)
assign("datetime_table", source_environment$datetime_table, envir = .GlobalEnv)
eval(parse(text = datetime_key_apply$code), envir = .GlobalEnv)
datetime_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(class(datetime_table_generated), c("data.table", "data.frame"), "generated datetime key copy changed data.table flavor")
assert_identical(data.table::key(datetime_table_generated), "key_time", "generated datetime key copy lost the data.table key")
assert_identical(datetime_table_generated$`formatted key`, c("2024-01-01", "2024-01-02"), "generated datetime key copy changed values")
assert_identical(datetime_table_generated$marker, datetime_table_before$marker, "generated datetime key copy changed keyed row order")
assert_identical(get("datetime_table", envir = .GlobalEnv), datetime_table_before, "generated datetime key copy mutated its source")
assert_identical(source_environment$datetime_table, datetime_table_before, "live datetime key copy mutated its source")
rm("datetime_table", "open_wrangler_result", envir = .GlobalEnv)
invisible(dispatch("closeSession", list(sessionId = datetime_table_session_id)))

assert_generated_formula_datetime_flavor <- function(case_session_id, variable_name, source) {
  source_bytes_before <- serialize(source, NULL, version = 3L)
  before <- if (inherits(source, "data.table")) {
    data.table::copy(source)
  } else {
    unserialize(serialize(source, NULL, version = 3L))
  }
  is_readr_source <- identical(class(source), c("spec_tbl_df", "tbl_df", "tbl", "data.frame"))
  expected_class <- if (is_readr_source) {
    c("tbl_df", "tbl", "data.frame")
  } else {
    class(source)
  }
  assign(variable_name, source, envir = source_environment)
  opened <- dispatch(
    "openSession",
    list(sessionId = case_session_id, variableName = variable_name, page = page_window())
  )
  assert_identical(opened$kind, "page", sprintf("%s did not open for Formula/Datetime", variable_name))
  assert_identical(
    opened$page$frameSemantics$classes,
    as.list(expected_class),
    sprintf("live %s did not publish its canonical dataframe flavor", variable_name)
  )
  formula_preview <- dispatch(
    "previewStep",
    list(
      sessionId = case_session_id,
      revision = 0L,
      step = formula_step(
        paste0(variable_name, "-formula"),
        "multiply",
        "product",
        right_position = 2L,
        right_name = "right"
      ),
      page = page_window()
    )
  )
  assert_identical(formula_preview$kind, "stepPreview", sprintf("%s Formula did not preview", variable_name))
  formula_applied <- dispatch(
    "applyDraft",
    list(sessionId = case_session_id, revision = 1L, page = page_window())
  )
  assert_identical(formula_applied$action, "apply", sprintf("%s Formula did not apply", variable_name))
  datetime_preview <- dispatch(
    "previewStep",
    list(
      sessionId = case_session_id,
      revision = 2L,
      step = datetime_format_step(
        paste0(variable_name, "-datetime"),
        3L,
        "when",
        "%Y%m%d",
        "formatted"
      ),
      page = page_window()
    )
  )
  assert_identical(datetime_preview$kind, "stepPreview", sprintf("%s Format Datetime did not preview", variable_name))
  applied <- dispatch(
    "applyDraft",
    list(sessionId = case_session_id, revision = 3L, page = page_window())
  )
  assert_identical(applied$action, "apply", sprintf("%s Format Datetime did not apply", variable_name))
  assert_identical(
    applied$page$frameSemantics$classes,
    as.list(expected_class),
    sprintf("live %s Formula/Datetime changed dataframe flavor", variable_name)
  )
  assign(variable_name, source, envir = .GlobalEnv)
  eval(parse(text = applied$code), envir = .GlobalEnv)
  generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_identical(class(generated), expected_class, sprintf("generated %s changed dataframe flavor", variable_name))
  if (is_readr_source) {
    assert_identical(attr(generated, "spec", exact = TRUE), NULL, "generated readr Formula/Datetime retained parser spec")
    assert_identical(attr(generated, "problems", exact = TRUE), NULL, "generated readr Formula/Datetime retained parser problems")
  }
  assert_identical(
    unname(generated$product),
    c(10, -6, NA_real_),
    sprintf("generated %s Formula changed values", variable_name)
  )
  if (identical(variable_name, "formula_datetime_named")) {
    assert_identical(
      attr(generated$product, "names", exact = TRUE),
      row.names(source),
      "generated named Formula did not preserve aligned value names"
    )
  }
  assert_identical(generated$formatted, c("20240229", "20250102", NA_character_), sprintf("generated %s Format Datetime changed values", variable_name))
  if (inherits(source, "data.table")) {
    assert_identical(data.table::key(generated), data.table::key(source), sprintf("generated %s lost its key", variable_name))
  }
  if (is_readr_source) {
    assert_identical(
      serialize(get(variable_name, envir = .GlobalEnv), NULL, version = 3L),
      source_bytes_before,
      sprintf("generated %s mutated its readr source", variable_name)
    )
    assert_identical(
      serialize(source_environment[[variable_name]], NULL, version = 3L),
      source_bytes_before,
      sprintf("live %s mutated its readr source", variable_name)
    )
  } else {
    assert_identical(get(variable_name, envir = .GlobalEnv), before, sprintf("generated %s mutated its source", variable_name))
    assert_identical(source_environment[[variable_name]], before, sprintf("live %s mutated its source", variable_name))
  }
  rm(list = c(variable_name, "open_wrangler_result"), envir = .GlobalEnv)
  invisible(dispatch("closeSession", list(sessionId = case_session_id)))
  rm(list = variable_name, envir = source_environment)
}

formula_datetime_flavor_source <- data.frame(
  left = c(5, -2, NA_real_),
  right = c(2, 3, 4),
  when = as.Date(c("2024-02-29", "2025-01-02", NA)),
  marker = c("a", "b", "c"),
  check.names = FALSE
)
assert_generated_formula_datetime_flavor(
  formula_datetime_base_session_id,
  "formula_datetime_base",
  formula_datetime_flavor_source
)
formula_datetime_named_rows <- c("named-a", "named-b", "named-c")
formula_datetime_named_source <- structure(
  list(
    left = structure(c(5, -2, NA_real_), names = formula_datetime_named_rows),
    right = structure(c(2, 3, 4), names = formula_datetime_named_rows),
    when = structure(
      as.Date(c("2024-02-29", "2025-01-02", NA)),
      names = formula_datetime_named_rows
    ),
    marker = c("a", "b", "c")
  ),
  class = "data.frame",
  row.names = formula_datetime_named_rows
)
assert_generated_formula_datetime_flavor(
  formula_datetime_named_session_id,
  "formula_datetime_named",
  formula_datetime_named_source
)
formula_datetime_readr_source <- readr::read_csv(
  I(paste0(
    "left,right,when,marker\n",
    "5,2,2024-02-29,a\n",
    "-2,3,2025-01-02,b\n",
    "NA,4,NA,c\n"
  )),
  col_types = readr::cols(
    left = readr::col_double(),
    right = readr::col_double(),
    when = readr::col_date(),
    marker = readr::col_character()
  ),
  na = "NA",
  show_col_types = FALSE
)
assert_identical(
  class(formula_datetime_readr_source),
  c("spec_tbl_df", "tbl_df", "tbl", "data.frame"),
  "the readr Formula/Datetime fixture lost its parser class"
)
assert_identical(
  is.null(attr(formula_datetime_readr_source, "spec", exact = TRUE)),
  FALSE,
  "the readr Formula/Datetime fixture lost its parser spec"
)
assert_generated_formula_datetime_flavor(
  formula_datetime_readr_session_id,
  "formula_datetime_readr",
  formula_datetime_readr_source
)
assert_generated_formula_datetime_flavor(
  formula_datetime_tibble_session_id,
  "formula_datetime_tibble",
  tibble::as_tibble(formula_datetime_flavor_source, .name_repair = "minimal")
)
formula_datetime_table_source <- data.table::as.data.table(formula_datetime_flavor_source)
data.table::setkey(formula_datetime_table_source, marker)
assert_generated_formula_datetime_flavor(
  formula_datetime_table_session_id,
  "formula_datetime_table",
  formula_datetime_table_source
)
assert_generated_formula_datetime_flavor(
  formula_datetime_collapse_frame_session_id,
  "formula_datetime_collapse_frame",
  collapse::qDF(formula_datetime_flavor_source)
)
assert_generated_formula_datetime_flavor(
  formula_datetime_collapse_tibble_session_id,
  "formula_datetime_collapse_tibble",
  collapse::qTBL(formula_datetime_flavor_source)
)
assert_generated_formula_datetime_flavor(
  formula_datetime_collapse_table_session_id,
  "formula_datetime_collapse_table",
  collapse::qDT(formula_datetime_flavor_source)
)

formula_datetime_s3_isolation_child <- function(frame_contract_path, kernel_agent_path) {
  sys.source(frame_contract_path, envir = .GlobalEnv, keep.source = FALSE)
  sys.source(kernel_agent_path, envir = .GlobalEnv, keep.source = FALSE)
  if (!requireNamespace("data.table", quietly = TRUE) || !requireNamespace("jsonlite", quietly = TRUE)) {
    stop("the Formula/Datetime S3-isolation child requires data.table and jsonlite", call. = FALSE)
  }

  assert_child <- function(condition, message) {
    if (!isTRUE(condition)) stop(message, call. = FALSE)
  }
  source_environment <- new.env(parent = emptyenv())
  source_environment$formula_base <- data.frame(x = c(1, 2), check.names = FALSE, row.names = c("a", "b"))
  source_environment$datetime_base <- data.frame(
    day = as.Date(c("2026-01-01", NA)),
    check.names = FALSE,
    row.names = c("a", "b")
  )
  source_environment$formula_table <- data.table::data.table(x = c(1, 2))
  source_environment$datetime_table <- data.table::data.table(day = as.Date(c("2026-01-01", NA)))
  source_environment$categorical_table <- data.table::data.table(
    primary_key = c("a", "b", "c"),
    tags = c("x", "x|y", NA_character_)
  )
  source_environment$categorical_numeric <- data.frame(
    number = c(1.5, 2),
    category = factor(c("b", "a")),
    instant = as.POSIXct(c("2026-01-01 00:00:00", "2026-01-01 01:00:00"), tz = "UTC"),
    elapsed = as.difftime(c(1, 2), units = "hours"),
    retained = 1:2,
    check.names = FALSE
  )
  source_environment$categorical_dynamic <- data.frame(
    cat1 = factor(c("a", "b")),
    cat2 = factor(c("x", "y")),
    keep = 1:2,
    check.names = FALSE
  )
  source_environment$categorical_drop <- data.frame(
    drop = 1:2,
    category = c("a", "b"),
    keep = 3:4,
    check.names = FALSE
  )
  data.table::setkey(source_environment$categorical_table, primary_key)
  source_bytes <- lapply(
    c("formula_base", "datetime_base", "formula_table", "datetime_table", "categorical_table", "categorical_numeric", "categorical_dynamic", "categorical_drop"),
    function(variable_name) serialize(source_environment[[variable_name]], NULL, version = 3L)
  )
  names(source_bytes) <- c("formula_base", "datetime_base", "formula_table", "datetime_table", "categorical_table", "categorical_numeric", "categorical_dynamic", "categorical_drop")

  agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, source_environment)
  on.exit(agent$dispose(), add = TRUE)
  any_duplicated_method_keys <- c("anyDuplicated.character", "anyDuplicated.integer")
  any_duplicated_calls <- new.env(parent = emptyenv())
  for (method_key in any_duplicated_method_keys) any_duplicated_calls[[method_key]] <- 0L
  poison_any_duplicated <- function(method_key) {
    force(method_key)
    function(...) {
      any_duplicated_calls[[method_key]] <- any_duplicated_calls[[method_key]] + 1L
      stop(sprintf("caller S3 poison dispatched through %s", method_key), call. = FALSE)
    }
  }
  registerS3method(
    "anyDuplicated",
    "character",
    poison_any_duplicated("anyDuplicated.character"),
    envir = .GlobalEnv
  )
  registerS3method(
    "anyDuplicated",
    "integer",
    poison_any_duplicated("anyDuplicated.integer"),
    envir = .GlobalEnv
  )
  assert_no_any_duplicated_calls <- function(label) {
    observed <- vapply(
      any_duplicated_method_keys,
      function(method_key) any_duplicated_calls[[method_key]],
      integer(1L),
      USE.NAMES = TRUE
    )
    if (any(observed != 0L)) {
      dispatched <- observed[observed != 0L]
      stop(
        sprintf(
          "%s dispatched caller anyDuplicated S3 methods: %s",
          label,
          paste(sprintf("%s=%d", names(dispatched), dispatched), collapse = ", ")
        ),
        call. = FALSE
      )
    }
  }
  request_number <- 0L
  page <- list(
    rowOffset = 0L,
    rowLimit = 10L,
    columnOffset = 0L,
    columnLimit = 10L,
    view = list(filters = I(list()), sorts = I(list()))
  )
  dispatch <- function(kind, payload) {
    request_number <<- request_number + 1L
    encoded <- jsonlite::toJSON(
      list(
        transportVersion = 12L,
        requestId = sprintf("11111111-1111-4111-8111-%012d", request_number),
        kind = kind,
        payload = payload
      ),
      auto_unbox = TRUE,
      null = "null",
      na = "null"
    )
    jsonlite::fromJSON(agent$dispatch_json(as.character(encoded)), simplifyVector = FALSE)
  }
  formula_step <- function(id) {
    list(
      id = id,
      kind = "formula",
      params = list(
        leftColumn = list(id = "r:c:0", name = "x"),
        operator = "add",
        value = 2,
        newColumn = "y"
      )
    )
  }
  datetime_step <- function(id) {
    list(
      id = id,
      kind = "formatDatetime",
      params = list(
        column = list(id = "r:c:0", name = "day"),
        format = "%d/%m/%Y",
        newColumn = "formatted"
      )
    )
  }
  categorical_step <- function(id) {
    list(
      id = id,
      kind = "multiLabelBinarize",
      params = list(
        column = list(id = "r:c:1", name = "tags"),
        delimiter = "|",
        prefix = "tag_"
      )
    )
  }
  categorical_numeric_step <- function(id) {
    list(
      id = id,
      kind = "oneHotEncode",
      params = list(
        columns = I(list(
          list(id = "r:c:0", name = "number"),
          list(id = "r:c:1", name = "category"),
          list(id = "r:c:2", name = "instant"),
          list(id = "r:c:3", name = "elapsed")
        )),
        dropOriginal = FALSE
      )
    )
  }
  categorical_dynamic_step <- function(id, column_id, column_name) {
    list(
      id = id,
      kind = "oneHotEncode",
      params = list(
        columns = I(list(list(id = column_id, name = column_name))),
        dropOriginal = FALSE
      )
    )
  }
  prepare_case <- function(variable_name, session_id, step) {
    opened <- dispatch("openSession", list(sessionId = session_id, variableName = variable_name, page = page))
    assert_child(identical(opened$kind, "page"), sprintf("could not open S3-isolation case %s", variable_name))
    previewed <- dispatch(
      "previewStep",
      list(sessionId = session_id, revision = 0L, step = step, page = page)
    )
    assert_child(
      identical(previewed$kind, "stepPreview"),
      sprintf("could not prepare S3-isolation case %s", variable_name)
    )
    applied <- dispatch(
      "applyDraft",
      list(sessionId = session_id, revision = previewed$revision, page = page)
    )
    assert_child(
      identical(applied$kind, "planUpdated"),
      sprintf("could not compile S3-isolation case %s", variable_name)
    )
    undone <- dispatch(
      "undoStep",
      list(sessionId = session_id, revision = applied$revision, page = page)
    )
    assert_child(
      identical(undone$kind, "planUpdated"),
      sprintf("could not reset S3-isolation case %s", variable_name)
    )
    list(
      variableName = variable_name,
      sessionId = session_id,
      revision = undone$revision,
      step = step,
      code = applied$code,
      outputName = switch(step$kind, formula = "y", formatDatetime = "formatted", multiLabelBinarize = "tag_x")
    )
  }
  cases <- list(
    formula_base = prepare_case(
      "formula_base",
      "11111111-1111-4111-8111-111111111111",
      formula_step("formula-base")
    ),
    datetime_base = prepare_case(
      "datetime_base",
      "22222222-2222-4222-8222-222222222222",
      datetime_step("datetime-base")
    ),
    formula_table = prepare_case(
      "formula_table",
      "33333333-3333-4333-8333-333333333333",
      formula_step("formula-table")
    ),
    datetime_table = prepare_case(
      "datetime_table",
      "44444444-4444-4444-8444-444444444444",
      datetime_step("datetime-table")
    ),
    categorical_table = prepare_case(
      "categorical_table",
      "55555555-5555-4555-8555-555555555555",
      categorical_step("categorical-table")
    )
  )
  categorical_numeric_case <- prepare_case(
    "categorical_numeric",
    "66666666-6666-4666-8666-666666666666",
    categorical_numeric_step("categorical-numeric")
  )
  categorical_dynamic_session_id <- "77777777-7777-4777-8777-777777777777"
  categorical_dynamic_opened <- dispatch(
    "openSession",
    list(
      sessionId = categorical_dynamic_session_id,
      variableName = "categorical_dynamic",
      page = page
    )
  )
  assert_child(
    identical(categorical_dynamic_opened$kind, "page"),
    "could not open the dynamic categorical S3-isolation case"
  )
  categorical_dynamic_first_step <- categorical_dynamic_step(
    "categorical-dynamic-first",
    "r:c:0",
    "cat1"
  )
  categorical_dynamic_first_preview <- dispatch(
    "previewStep",
    list(
      sessionId = categorical_dynamic_session_id,
      revision = 0L,
      step = categorical_dynamic_first_step,
      page = page
    )
  )
  categorical_dynamic_first_apply <- dispatch(
    "applyDraft",
    list(
      sessionId = categorical_dynamic_session_id,
      revision = categorical_dynamic_first_preview$revision,
      page = page
    )
  )
  assert_child(
    identical(categorical_dynamic_first_apply$kind, "planUpdated"),
    "could not apply the first dynamic categorical S3-isolation step"
  )
  categorical_dynamic_second_step <- categorical_dynamic_step(
    "categorical-dynamic-second",
    "r:c:1",
    "cat2"
  )
  categorical_dynamic_second_preview <- dispatch(
    "previewStep",
    list(
      sessionId = categorical_dynamic_session_id,
      revision = categorical_dynamic_first_apply$revision,
      step = categorical_dynamic_second_step,
      page = page
    )
  )
  categorical_dynamic_second_apply <- dispatch(
    "applyDraft",
    list(
      sessionId = categorical_dynamic_session_id,
      revision = categorical_dynamic_second_preview$revision,
      page = page
    )
  )
  assert_child(
    identical(categorical_dynamic_second_apply$kind, "planUpdated"),
    "could not apply the second dynamic categorical S3-isolation step"
  )
  categorical_dynamic_code <- categorical_dynamic_second_apply$code
  assert_no_any_duplicated_calls("live categorical preparation")
  categorical_dynamic_changed <- data.frame(
    cat1 = factor(c("a", "b", "c")),
    cat2 = factor(c("x", "y", "z")),
    keep = 1:3,
    check.names = FALSE
  )
  categorical_dynamic_changed_bytes <- serialize(
    categorical_dynamic_changed,
    NULL,
    version = 3L
  )
  categorical_dynamic_expected_first <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
    categorical_dynamic_changed,
    1L,
    "cat1",
    "_",
    FALSE
  )$value
  categorical_dynamic_expected <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
    categorical_dynamic_expected_first,
    2L,
    "cat2",
    "_",
    FALSE
  )$value
  assert_no_any_duplicated_calls("live changed-cardinality categorical replay")
  categorical_drop_session_id <- "88888888-8888-4888-8888-888888888888"
  categorical_drop_opened <- dispatch(
    "openSession",
    list(
      sessionId = categorical_drop_session_id,
      variableName = "categorical_drop",
      page = page
    )
  )
  assert_child(
    identical(categorical_drop_opened$kind, "page"),
    "could not open the drop-before-categorical S3-isolation case"
  )
  categorical_drop_preview <- dispatch(
    "previewStep",
    list(
      sessionId = categorical_drop_session_id,
      revision = 0L,
      step = list(
        id = "categorical-drop-first",
        kind = "dropColumns",
        params = list(columns = I(list(list(id = "r:c:0", name = "drop"))))
      ),
      page = page
    )
  )
  categorical_drop_apply <- dispatch(
    "applyDraft",
    list(
      sessionId = categorical_drop_session_id,
      revision = categorical_drop_preview$revision,
      page = page
    )
  )
  categorical_drop_one_hot_preview <- dispatch(
    "previewStep",
    list(
      sessionId = categorical_drop_session_id,
      revision = categorical_drop_apply$revision,
      step = categorical_dynamic_step(
        "categorical-after-drop",
        "r:c:1",
        "category"
      ),
      page = page
    )
  )
  categorical_drop_one_hot_apply <- dispatch(
    "applyDraft",
    list(
      sessionId = categorical_drop_session_id,
      revision = categorical_drop_one_hot_preview$revision,
      page = page
    )
  )
  assert_child(
    identical(categorical_drop_one_hot_apply$kind, "planUpdated"),
    "could not compile the drop-before-categorical S3-isolation plan"
  )
  categorical_drop_code <- categorical_drop_one_hot_apply$code
  categorical_drop_expected_first <- openwrangler_r_frame_contract$drop_columns_at(
    source_environment$categorical_drop,
    1L,
    "drop"
  )
  categorical_drop_expected <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
    categorical_drop_expected_first,
    1L,
    "category",
    "_",
    FALSE
  )$value
  assert_no_any_duplicated_calls("live drop-before-categorical replay")
  categorical_numeric_expected <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
    source_environment$categorical_numeric,
    c(1L, 2L, 3L, 4L),
    c("number", "category", "instant", "elapsed"),
    "_",
    FALSE
  )$value
  for (variable_name in names(source_bytes)) {
    assert_child(
      identical(serialize(source_environment[[variable_name]], NULL, version = 3L), source_bytes[[variable_name]]),
      sprintf("preparing %s mutated its source", variable_name)
    )
  }

  predecessor_calls <- new.env(parent = emptyenv())
  predecessor_calls$unique.integer <- 0L
  predecessor_calls$sort.integer <- 0L
  poison_predecessor <- function(method_key) {
    force(method_key)
    function(...) {
      predecessor_calls[[method_key]] <- predecessor_calls[[method_key]] + 1L
      stop(sprintf("caller S3 poison dispatched through %s", method_key), call. = FALSE)
    }
  }
  registerS3method(
    "unique",
    "integer",
    poison_predecessor("unique.integer"),
    envir = .GlobalEnv
  )
  registerS3method(
    "sort",
    "integer",
    poison_predecessor("sort.integer"),
    envir = .GlobalEnv
  )
  categorical_drop_environment <- new.env(parent = baseenv())
  assign(
    "categorical_drop",
    unserialize(source_bytes$categorical_drop),
    envir = categorical_drop_environment
  )
  eval(parse(text = categorical_drop_code), envir = categorical_drop_environment)
  categorical_drop_generated <- get(
    "open_wrangler_result",
    envir = categorical_drop_environment,
    inherits = FALSE
  )
  assert_child(
    identical(categorical_drop_generated, categorical_drop_expected),
    "generated drop-before-categorical code changed values under caller S3 poisoning"
  )
  assert_child(
    identical(
      serialize(
        get("categorical_drop", envir = categorical_drop_environment, inherits = FALSE),
        NULL,
        version = 3L
      ),
      source_bytes$categorical_drop
    ),
    "generated drop-before-categorical code mutated its source"
  )
  assert_child(
    identical(predecessor_calls$unique.integer, 0L) &&
      identical(predecessor_calls$sort.integer, 0L),
    "generated drop-before-categorical code dispatched unique.integer or sort.integer"
  )
  assert_no_any_duplicated_calls("generated drop-before-categorical")
  registerS3method(
    "unique",
    "integer",
    function(x, ...) base::unique.default(x, ...),
    envir = .GlobalEnv
  )
  registerS3method(
    "sort",
    "integer",
    function(x, decreasing = FALSE, ...) base::sort.int(x, decreasing = decreasing, ...),
    envir = .GlobalEnv
  )

  method_keys <- c(
    "names.data.frame",
    "names<-.data.frame",
    "length.data.frame",
    "length.Date",
    "is.na.Date",
    "names.data.table",
    "sort.character",
    "names.CallRoutine",
    "[[.CallRoutine",
    "[[.DLLInfo",
    "[[.DLLInfoReference",
    "[[.DLLRegisteredRoutines",
    "[[.NativeRoutineList"
  )
  calls <- new.env(parent = emptyenv())
  for (method_key in method_keys) calls[[method_key]] <- 0L
  poison_method <- function(method_key) {
    force(method_key)
    function(...) {
      calls[[method_key]] <- calls[[method_key]] + 1L
      stop(sprintf("caller S3 poison dispatched through %s", method_key), call. = FALSE)
    }
  }
  registrations <- list(
    c("names", "data.frame", "names.data.frame"),
    c("names<-", "data.frame", "names<-.data.frame"),
    c("length", "data.frame", "length.data.frame"),
    c("length", "Date", "length.Date"),
    c("is.na", "Date", "is.na.Date"),
    c("names", "data.table", "names.data.table"),
    c("names", "CallRoutine", "names.CallRoutine"),
    c("[[", "CallRoutine", "[[.CallRoutine"),
    c("[[", "DLLInfo", "[[.DLLInfo"),
    c("[[", "DLLInfoReference", "[[.DLLInfoReference"),
    c("[[", "DLLRegisteredRoutines", "[[.DLLRegisteredRoutines"),
    c("[[", "NativeRoutineList", "[[.NativeRoutineList")
  )
  for (registration in registrations) {
    registerS3method(
      registration[[1L]],
      registration[[2L]],
      poison_method(registration[[3L]]),
      envir = .GlobalEnv
    )
  }
  reset_calls <- function() {
    for (method_key in method_keys) calls[[method_key]] <- 0L
  }
  assert_no_calls <- function(label) {
    observed <- vapply(method_keys, function(method_key) calls[[method_key]], integer(1L), USE.NAMES = TRUE)
    if (any(observed != 0L)) {
      dispatched <- observed[observed != 0L]
      stop(
        sprintf(
          "%s dispatched caller S3 methods: %s",
          label,
          paste(sprintf("%s=%d", names(dispatched), dispatched), collapse = ", ")
        ),
        call. = FALSE
      )
    }
  }
  live_values <- function(response, output_name, output_kind) {
    position <- match(
      output_name,
      vapply(response$page$schema, function(column) base::.subset2(column, "name"), character(1L))
    )
    assert_child(!is.na(position), sprintf("live S3-isolation page omitted %s", output_name))
    if (identical(output_kind, "formula")) {
      vapply(response$page$page$rows, function(row) {
        cell <- base::.subset2(base::.subset2(row, "values"), position)
        if (identical(base::.subset2(cell, "kind"), "null")) NA_real_ else as.double(base::.subset2(cell, "raw"))
      }, double(1L), USE.NAMES = FALSE)
    } else if (identical(output_kind, "categorical")) {
      vapply(response$page$page$rows, function(row) {
        cell <- base::.subset2(base::.subset2(row, "values"), position)
        if (identical(base::.subset2(cell, "kind"), "null")) NA_integer_ else as.integer(base::.subset2(cell, "raw"))
      }, integer(1L), USE.NAMES = FALSE)
    } else {
      vapply(response$page$page$rows, function(row) {
        cell <- base::.subset2(base::.subset2(row, "values"), position)
        if (identical(base::.subset2(cell, "kind"), "null")) NA_character_ else as.character(base::.subset2(cell, "raw"))
      }, character(1L), USE.NAMES = FALSE)
    }
  }

  reset_calls()
  for (case_name in names(cases)) {
    case <- cases[[case_name]]
    is_formula <- identical(case$step$kind, "formula")
    is_categorical <- identical(case$step$kind, "multiLabelBinarize")
    output_kind <- if (is_formula) "formula" else if (is_categorical) "categorical" else "datetime"
    expected <- if (is_formula) c(3, 4) else if (is_categorical) c(1L, 1L, 0L) else c("01/01/2026", NA_character_)
    if (is_categorical) {
      registerS3method(
        "sort",
        "character",
        poison_method("sort.character"),
        envir = .GlobalEnv
      )
    }
    reset_calls()
    previewed <- dispatch(
      "previewStep",
      list(
        sessionId = case$sessionId,
        revision = case$revision,
        step = case$step,
        page = page
      )
    )
    assert_child(
      identical(previewed$kind, "stepPreview"),
      sprintf("live %s failed under caller S3 poisoning", case_name)
    )
    assert_child(
      identical(live_values(previewed, case$outputName, output_kind), expected),
      sprintf("live %s changed values under caller S3 poisoning", case_name)
    )
    assert_child(
      identical(
        serialize(source_environment[[case$variableName]], NULL, version = 3L),
        source_bytes[[case$variableName]]
      ),
      sprintf("live %s mutated its source under caller S3 poisoning", case_name)
    )
    assert_no_calls(sprintf("live %s", case_name))

    reset_calls()
    evaluation_environment <- new.env(parent = baseenv())
    assign(
      case$variableName,
      unserialize(source_bytes[[case$variableName]]),
      envir = evaluation_environment
    )
    eval(parse(text = case$code), envir = evaluation_environment)
    generated <- get("open_wrangler_result", envir = evaluation_environment, inherits = FALSE)
    assert_child(
      identical(unname(base::.subset2(generated, case$outputName)), expected),
      sprintf("generated %s changed values under caller S3 poisoning", case_name)
    )
    assert_child(
      identical(
        serialize(
          get(case$variableName, envir = evaluation_environment, inherits = FALSE),
          NULL,
          version = 3L
        ),
        source_bytes[[case$variableName]]
      ),
      sprintf("generated %s mutated its source under caller S3 poisoning", case_name)
    )
    if (grepl("table", case_name, fixed = TRUE)) {
      assert_child(
        identical(data.table:::selfrefok(generated), 1L),
        sprintf("generated %s retained an invalid data.table self-reference", case_name)
      )
    }
    assert_no_calls(sprintf("generated %s", case_name))
  }

  categorical_generic_registrations <- list(
    c("format", "numeric"),
    c("unique", "numeric"),
    c("unique", "integer"),
    c("unique", "character"),
    c("duplicated", "character"),
    c("sort", "integer"),
    c("[[", "data.frame"),
    c("[[<-", "data.frame")
  )
  for (registration in categorical_generic_registrations) {
    method_key <- paste(registration, collapse = ".")
    registerS3method(
      registration[[1L]],
      registration[[2L]],
      poison_method(method_key),
      envir = .GlobalEnv
    )
  }
  reset_calls()
  categorical_dynamic_environment <- new.env(parent = baseenv())
  assign(
    "categorical_dynamic",
    unserialize(categorical_dynamic_changed_bytes),
    envir = categorical_dynamic_environment
  )
  eval(parse(text = categorical_dynamic_code), envir = categorical_dynamic_environment)
  categorical_dynamic_generated <- get(
    "open_wrangler_result",
    envir = categorical_dynamic_environment,
    inherits = FALSE
  )
  assert_child(
    identical(categorical_dynamic_generated, categorical_dynamic_expected),
    "generated multi-step categorical code changed values under caller S3 poisoning"
  )
  assert_child(
    identical(
      serialize(
        get("categorical_dynamic", envir = categorical_dynamic_environment, inherits = FALSE),
        NULL,
        version = 3L
      ),
      categorical_dynamic_changed_bytes
    ),
    "generated multi-step categorical code mutated its changed-cardinality source"
  )
  assert_no_calls("generated multi-step categorical")
  assert_no_any_duplicated_calls("generated multi-step categorical")
  reset_calls()
  categorical_numeric_environment <- new.env(parent = baseenv())
  assign(
    "categorical_numeric",
    unserialize(source_bytes$categorical_numeric),
    envir = categorical_numeric_environment
  )
  eval(parse(text = categorical_numeric_case$code), envir = categorical_numeric_environment)
  categorical_numeric_generated <- get(
    "open_wrangler_result",
    envir = categorical_numeric_environment,
    inherits = FALSE
  )
  assert_child(
    identical(categorical_numeric_generated, categorical_numeric_expected),
    "generated categorical code used caller format/unique/duplicated/sort S3 methods"
  )
  assert_child(
    identical(
      serialize(
        get("categorical_numeric", envir = categorical_numeric_environment, inherits = FALSE),
        NULL,
        version = 3L
      ),
      source_bytes$categorical_numeric
    ),
    "generated categorical attributed-level replay mutated its source"
  )
  assert_no_calls("generated categorical attributed factor levels")
  assert_no_any_duplicated_calls("isolated categorical lifecycle")
}

formula_datetime_s3_isolation_script <- tempfile(fileext = ".R")
writeLines(
  c(
    "formula_datetime_s3_isolation_child <-",
    deparse(formula_datetime_s3_isolation_child, width.cutoff = 500L),
    paste0(
      "formula_datetime_s3_isolation_child(",
      "commandArgs(trailingOnly = TRUE)[[1L]], ",
      "commandArgs(trailingOnly = TRUE)[[2L]])"
    )
  ),
  formula_datetime_s3_isolation_script,
  useBytes = TRUE
)
formula_datetime_s3_isolation_output <- system2(
  file.path(R.home("bin"), "Rscript"),
  c(
    "--vanilla",
    formula_datetime_s3_isolation_script,
    normalizePath("r/openwrangler_runtime/frame_contract.R"),
    normalizePath("r/openwrangler_runtime/kernel_agent.R")
  ),
  stdout = TRUE,
  stderr = TRUE
)
formula_datetime_s3_isolation_status <- attr(
  formula_datetime_s3_isolation_output,
  "status",
  exact = TRUE
)
if (!is.null(formula_datetime_s3_isolation_status) && formula_datetime_s3_isolation_status != 0L) {
  stop(
    paste(
      c(
        "Formula/Datetime caller-S3-isolation child failed",
        formula_datetime_s3_isolation_output
      ),
      collapse = "\n"
    ),
    call. = FALSE
  )
}
unlink(formula_datetime_s3_isolation_script)

categorical_attributed_metadata_s3_child <- function(frame_contract_path, kernel_agent_path) {
  sys.source(frame_contract_path, envir = .GlobalEnv, keep.source = FALSE)
  sys.source(kernel_agent_path, envir = .GlobalEnv, keep.source = FALSE)
  if (!requireNamespace("data.table", quietly = TRUE) || !requireNamespace("jsonlite", quietly = TRUE)) {
    stop("the categorical attributed-metadata child requires data.table and jsonlite", call. = FALSE)
  }

  assert_child <- function(condition, message) {
    if (!isTRUE(condition)) stop(message, call. = FALSE)
  }
  source_environment <- new.env(parent = emptyenv())
  source_environment$categorical_metadata <- data.frame(
    category = factor(c("b", "a")),
    instant = as.POSIXct(c("2026-01-01 00:00:00", "2026-01-01 01:00:00"), tz = "UTC"),
    elapsed = as.difftime(c(1, 2), units = "hours"),
    retained = 1:2,
    check.names = FALSE
  )
  attr(source_environment$categorical_metadata$category, "levels") <- structure(
    attr(source_environment$categorical_metadata$category, "levels", exact = TRUE),
    class = "AsIs"
  )
  attr(source_environment$categorical_metadata$instant, "tzone") <- structure(
    "UTC",
    names = "zone",
    comment = "accepted metadata",
    class = "AsIs"
  )
  attr(source_environment$categorical_metadata$elapsed, "units") <- structure(
    "hours",
    names = "units",
    comment = "accepted metadata",
    class = "AsIs"
  )
  source_environment$categorical_key <- data.table::data.table(
    primary_key = c("a", "b", "c"),
    tags = c("x", "x|y", NA_character_)
  )
  data.table::setkey(source_environment$categorical_key, primary_key)
  categorical_key_attr <- attr(source_environment$categorical_key, "sorted", exact = TRUE)
  data.table::setattr(categorical_key_attr, "class", "AsIs")
  metadata_source_bytes <- serialize(
    source_environment$categorical_metadata,
    NULL,
    version = 3L
  )
  key_source_bytes <- serialize(
    source_environment$categorical_key,
    NULL,
    version = 3L
  )
  metadata_expected <- openwrangler_r_frame_contract$one_hot_encode_columns_at(
    source_environment$categorical_metadata,
    c(1L, 2L, 3L),
    c("category", "instant", "elapsed"),
    "_",
    FALSE
  )$value
  key_expected <- openwrangler_r_frame_contract$multi_label_binarize_column_at(
    source_environment$categorical_key,
    2L,
    "tags",
    "|",
    "tag_",
    FALSE
  )$value

  agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, source_environment)
  on.exit(agent$dispose(), add = TRUE)
  request_number <- 0L
  page <- list(
    rowOffset = 0L,
    rowLimit = 10L,
    columnOffset = 0L,
    columnLimit = 20L,
    view = list(filters = I(list()), sorts = I(list()))
  )
  dispatch <- function(kind, payload) {
    request_number <<- request_number + 1L
    request <- jsonlite::toJSON(
      list(
        transportVersion = 12L,
        requestId = sprintf("99999999-9999-4999-8999-%012d", request_number),
        kind = kind,
        payload = payload
      ),
      auto_unbox = TRUE,
      null = "null",
      na = "null"
    )
    jsonlite::fromJSON(agent$dispatch_json(as.character(request)), simplifyVector = FALSE)
  }
  compile_case <- function(variable_name, session_id, step) {
    opened <- dispatch(
      "openSession",
      list(sessionId = session_id, variableName = variable_name, page = page)
    )
    assert_child(identical(opened$kind, "page"), sprintf("could not open %s", variable_name))
    previewed <- dispatch(
      "previewStep",
      list(sessionId = session_id, revision = 0L, step = step, page = page)
    )
    assert_child(
      identical(previewed$kind, "stepPreview"),
      sprintf("could not preview %s", variable_name)
    )
    applied <- dispatch(
      "applyDraft",
      list(sessionId = session_id, revision = previewed$revision, page = page)
    )
    assert_child(
      identical(applied$kind, "planUpdated"),
      sprintf("could not compile %s", variable_name)
    )
    applied$code
  }
  metadata_code <- compile_case(
    "categorical_metadata",
    "99999999-9999-4999-8999-999999999991",
    list(
      id = "attributed-metadata",
      kind = "oneHotEncode",
      params = list(
        columns = I(list(
          list(id = "r:c:0", name = "category"),
          list(id = "r:c:1", name = "instant"),
          list(id = "r:c:2", name = "elapsed")
        )),
        dropOriginal = FALSE
      )
    )
  )
  key_code <- compile_case(
    "categorical_key",
    "99999999-9999-4999-8999-999999999992",
    list(
      id = "attributed-key",
      kind = "multiLabelBinarize",
      params = list(
        column = list(id = "r:c:1", name = "tags"),
        delimiter = "|",
        prefix = "tag_"
      )
    )
  )
  assert_child(
    identical(
      serialize(source_environment$categorical_metadata, NULL, version = 3L),
      metadata_source_bytes
    ) && identical(
      serialize(source_environment$categorical_key, NULL, version = 3L),
      key_source_bytes
    ),
    "preparing attributed categorical cases mutated a source"
  )

  method_keys <- c("[[.AsIs", "anyNA.AsIs", "is.na.AsIs", "length.AsIs", "Ops.AsIs")
  calls <- new.env(parent = emptyenv())
  for (method_key in method_keys) calls[[method_key]] <- 0L
  poison_method <- function(method_key) {
    force(method_key)
    function(...) {
      calls[[method_key]] <- calls[[method_key]] + 1L
      stop(sprintf("caller S3 poison dispatched through %s", method_key), call. = FALSE)
    }
  }
  registrations <- list(
    c("[[", "AsIs", "[[.AsIs"),
    c("anyNA", "AsIs", "anyNA.AsIs"),
    c("is.na", "AsIs", "is.na.AsIs"),
    c("length", "AsIs", "length.AsIs"),
    c("Ops", "AsIs", "Ops.AsIs")
  )
  for (registration in registrations) {
    registerS3method(
      base::.subset2(registration, 1L),
      base::.subset2(registration, 2L),
      poison_method(base::.subset2(registration, 3L)),
      envir = .GlobalEnv
    )
  }
  assert_no_calls <- function(label) {
    observed <- vapply(
      method_keys,
      function(method_key) calls[[method_key]],
      integer(1L),
      USE.NAMES = TRUE
    )
    if (any(observed != 0L)) {
      dispatched <- observed[observed != 0L]
      stop(
        sprintf(
          "%s dispatched caller S3 methods: %s",
          label,
          paste(sprintf("%s=%d", names(dispatched), dispatched), collapse = ", ")
        ),
        call. = FALSE
      )
    }
  }
  assert_frame_columns <- function(actual, expected, label) {
    actual_count <- base::length(base::unclass(actual))
    expected_count <- base::length(base::unclass(expected))
    assert_child(
      identical(attr(actual, "names", exact = TRUE), attr(expected, "names", exact = TRUE)) &&
        identical(actual_count, expected_count) &&
        all(vapply(seq_len(actual_count), function(column_index) {
          identical(base::.subset2(actual, column_index), base::.subset2(expected, column_index))
        }, logical(1L), USE.NAMES = FALSE)),
      label
    )
  }

  encode_response <- get(
    "encode_response",
    envir = environment(openwrangler_r_kernel_agent$new_agent),
    inherits = FALSE
  )
  beta <- intToUtf8(946L)
  encoded_response <- encode_response(list(
    listPayload = I(list(list(name = beta))),
    characterPayload = I(beta)
  ))
  decoded_response <- jsonlite::fromJSON(encoded_response, simplifyVector = FALSE)
  assert_child(
    identical(base::.subset2(base::.subset2(decoded_response$listPayload, 1L), "name"), beta) &&
      identical(base::.subset2(decoded_response$characterPayload, 1L), beta),
    "ASCII response encoding changed AsIs list or character arrays"
  )
  assert_no_calls("ASCII AsIs response encoding")

  metadata_environment <- new.env(parent = baseenv())
  assign(
    "categorical_metadata",
    unserialize(metadata_source_bytes),
    envir = metadata_environment
  )
  eval(parse(text = metadata_code), envir = metadata_environment)
  metadata_generated <- get("open_wrangler_result", envir = metadata_environment, inherits = FALSE)
  assert_frame_columns(
    metadata_generated,
    metadata_expected,
    "generated categorical code changed attributed semantic metadata values or schema"
  )
  assert_child(
    identical(
      serialize(
        get("categorical_metadata", envir = metadata_environment, inherits = FALSE),
        NULL,
        version = 3L
      ),
      metadata_source_bytes
    ),
    "generated categorical attributed-metadata replay mutated its source"
  )
  assert_no_calls("generated categorical attributed semantic metadata")

  key_environment <- new.env(parent = baseenv())
  assign("categorical_key", unserialize(key_source_bytes), envir = key_environment)
  eval(parse(text = key_code), envir = key_environment)
  key_generated <- get("open_wrangler_result", envir = key_environment, inherits = FALSE)
  assert_frame_columns(
    key_generated,
    key_expected,
    "generated categorical code changed attributed-key values or schema"
  )
  assert_child(
    identical(attr(key_generated, "sorted", exact = TRUE), "primary_key"),
    "generated categorical code did not canonicalize its retained key"
  )
  assert_child(
    identical(data.table:::selfrefok(key_generated), 1L),
    "generated attributed-key categorical replay retained an invalid self-reference"
  )
  assert_child(
    identical(
      serialize(
        get("categorical_key", envir = key_environment, inherits = FALSE),
        NULL,
        version = 3L
      ),
      key_source_bytes
    ),
    "generated attributed-key categorical replay mutated its source"
  )
  assert_no_calls("generated categorical attributed data.table key")
}

categorical_attributed_metadata_s3_script <- tempfile(fileext = ".R")
writeLines(
  c(
    "categorical_attributed_metadata_s3_child <-",
    deparse(categorical_attributed_metadata_s3_child, width.cutoff = 500L),
    paste0(
      "categorical_attributed_metadata_s3_child(",
      "commandArgs(trailingOnly = TRUE)[[1L]], ",
      "commandArgs(trailingOnly = TRUE)[[2L]])"
    )
  ),
  categorical_attributed_metadata_s3_script,
  useBytes = TRUE
)
categorical_attributed_metadata_s3_output <- system2(
  file.path(R.home("bin"), "Rscript"),
  c(
    "--vanilla",
    categorical_attributed_metadata_s3_script,
    normalizePath("r/openwrangler_runtime/frame_contract.R"),
    normalizePath("r/openwrangler_runtime/kernel_agent.R")
  ),
  stdout = TRUE,
  stderr = TRUE
)
categorical_attributed_metadata_s3_status <- attr(
  categorical_attributed_metadata_s3_output,
  "status",
  exact = TRUE
)
if (!is.null(categorical_attributed_metadata_s3_status) && categorical_attributed_metadata_s3_status != 0L) {
  stop(
    paste(
      c(
        "categorical attributed-metadata S3-isolation child failed",
        categorical_attributed_metadata_s3_output
      ),
      collapse = "\n"
    ),
    call. = FALSE
  )
}
unlink(categorical_attributed_metadata_s3_script)

categorical_ascii_locale_child <- function(frame_contract_path, kernel_agent_path) {
  sys.source(frame_contract_path, envir = .GlobalEnv, keep.source = FALSE)
  sys.source(kernel_agent_path, envir = .GlobalEnv, keep.source = FALSE)
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("the categorical ASCII transport child requires jsonlite", call. = FALSE)
  }
  assert_child <- function(condition, message) {
    if (!isTRUE(condition)) stop(message, call. = FALSE)
  }
  beta <- intToUtf8(946L)
  astral <- intToUtf8(128578L)
  Encoding(beta) <- "UTF-8"
  Encoding(astral) <- "UTF-8"
  literal <- "<U+03B2>"
  control <- paste0("line\nquote\"slash\\", beta, astral)
  Encoding(control) <- "UTF-8"
  text_name <- paste0("text", beta)
  tags_name <- paste0("tags", beta)
  source_environment <- new.env(parent = emptyenv())
  source_environment$locale_frame <- data.frame(
    text = c(beta, literal, control, astral),
    tags = c(beta, literal, control, astral),
    check.names = FALSE,
    stringsAsFactors = FALSE
  )
  names(source_environment$locale_frame) <- c(text_name, tags_name)
  source_before <- serialize(source_environment$locale_frame, NULL, version = 3L)
  expected <- openwrangler_r_frame_contract$multi_label_binarize_column_at(
    source_environment$locale_frame,
    2L,
    tags_name,
    "|",
    "out_",
    FALSE
  )
  agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, source_environment)
  on.exit(agent$dispose(), add = TRUE)
  request_number <- 0L
  unicode_name_marker <- "OPEN_WRANGLER_UNICODE_COLUMN_NAME"
  page <- list(
    rowOffset = 0L,
    rowLimit = 10L,
    columnOffset = 0L,
    columnLimit = 20L,
    view = list(filters = I(list()), sorts = I(list()))
  )
  dispatch <- function(kind, payload) {
    request_number <<- request_number + 1L
    encoded <- as.character(jsonlite::toJSON(
      list(
        transportVersion = 12L,
        requestId = sprintf("11111111-1111-4111-8111-%012d", request_number),
        kind = kind,
        payload = payload
      ),
      auto_unbox = TRUE,
      null = "null",
      na = "null"
    ))
    encoded <- gsub(unicode_name_marker, "tags\\u03B2", encoded, fixed = TRUE)
    wire <- agent$dispatch_json(encoded)
    assert_child(
      all(as.integer(charToRaw(wire)) <= 127L),
      sprintf("%s emitted non-ASCII JSON under the C locale", kind)
    )
    jsonlite::fromJSON(wire, simplifyVector = FALSE)
  }
  session_id <- "11111111-1111-4111-8111-111111111111"
  opened <- dispatch(
    "openSession",
    list(sessionId = session_id, variableName = "locale_frame", page = page)
  )
  assert_child(identical(opened$kind, "page"), "the C-locale categorical session did not open")
  assert_child(
    identical(vapply(opened$page$schema, `[[`, character(1L), "name"), c(text_name, tags_name)),
    "the C-locale response changed a Unicode schema name"
  )
  text_values <- vapply(opened$page$page$rows, function(row) {
    base::.subset2(base::.subset2(row, "values")[[1L]], "raw")
  }, character(1L), USE.NAMES = FALSE)
  assert_child(
    identical(text_values, c(beta, literal, control, astral)),
    "the C-locale response changed scalar, literal, control, or astral text"
  )
  step <- list(
    id = "locale-categorical-step",
    kind = "multiLabelBinarize",
    params = list(
      column = list(id = "r:c:1", name = unicode_name_marker),
      delimiter = "|",
      prefix = "out_"
    )
  )
  previewed <- dispatch(
    "previewStep",
    list(sessionId = session_id, revision = 0L, step = step, page = page)
  )
  assert_child(identical(previewed$kind, "stepPreview"), "C-locale categorical preview failed")
  assert_child(
    identical(previewed$diff$addedColumns, as.list(expected$generatedNames)),
    "the C-locale categorical diff changed Unicode generated names or array shape"
  )
  assert_child(
    paste0("out_", literal) %in% previewed$diff$addedColumns,
    "literal <U+03B2> text was reinterpreted as a Unicode code point"
  )
  assert_child(
    all(expected$generatedNames %in% vapply(previewed$page$schema, `[[`, character(1L), "name")),
    "the C-locale categorical schema omitted generated Unicode names"
  )
  applied <- dispatch(
    "applyDraft",
    list(sessionId = session_id, revision = previewed$revision, page = page)
  )
  assert_child(identical(applied$kind, "planUpdated"), "C-locale categorical apply failed")
  evaluation_environment <- new.env(parent = baseenv())
  assign("locale_frame", unserialize(source_before), envir = evaluation_environment)
  eval(parse(text = applied$code), envir = evaluation_environment)
  generated <- get("open_wrangler_result", envir = evaluation_environment, inherits = FALSE)
  assert_child(
    identical(generated, expected$value),
    "C-locale live and generated categorical results diverged"
  )
  assert_child(
    identical(serialize(source_environment$locale_frame, NULL, version = 3L), source_before),
    "C-locale categorical lifecycle mutated its live source"
  )
  assert_child(
    identical(serialize(get("locale_frame", envir = evaluation_environment), NULL, version = 3L), source_before),
    "C-locale generated categorical code mutated its source"
  )

  malformed <- rawToChar(as.raw(c(195L, 40L)))
  Encoding(malformed) <- "bytes"
  malformed_contract <- openwrangler_r_frame_contract
  real_materialize <- malformed_contract$materialize_view_page
  malformed_contract$materialize_view_page <- function(...) {
    result <- real_materialize(...)
    result$schema[[1L]]$name <- malformed
    result
  }
  malformed_agent <- openwrangler_r_kernel_agent$new_agent(malformed_contract, source_environment)
  on.exit(malformed_agent$dispose(), add = TRUE)
  malformed_request <- jsonlite::toJSON(
    list(
      transportVersion = 12L,
      requestId = "22222222-2222-4222-8222-222222222222",
      kind = "openSession",
      payload = list(
        sessionId = "22222222-2222-4222-8222-222222222222",
        variableName = "locale_frame",
        page = page
      )
    ),
    auto_unbox = TRUE,
    null = "null",
    na = "null"
  )
  malformed_wire <- malformed_agent$dispatch_json(as.character(malformed_request))
  assert_child(all(as.integer(charToRaw(malformed_wire)) <= 127L), "malformed response text escaped the ASCII transport")
  malformed_response <- jsonlite::fromJSON(malformed_wire, simplifyVector = FALSE)
  assert_child(
    identical(malformed_response$kind, "error") && identical(malformed_response$code, "runtime_error"),
    "malformed response bytes did not fail closed"
  )
}

categorical_ascii_locale_script <- tempfile(fileext = ".R")
writeLines(
  c(
    "categorical_ascii_locale_child <-",
    deparse(categorical_ascii_locale_child, width.cutoff = 500L),
    paste0(
      "categorical_ascii_locale_child(",
      "commandArgs(trailingOnly = TRUE)[[1L]], ",
      "commandArgs(trailingOnly = TRUE)[[2L]])"
    )
  ),
  categorical_ascii_locale_script,
  useBytes = TRUE
)
categorical_ascii_locale_output <- system2(
  file.path(R.home("bin"), "Rscript"),
  c(
    "--vanilla",
    categorical_ascii_locale_script,
    normalizePath("r/openwrangler_runtime/frame_contract.R"),
    normalizePath("r/openwrangler_runtime/kernel_agent.R")
  ),
  stdout = TRUE,
  stderr = TRUE,
  env = c("LC_ALL=C", "LANG=C", "LANGUAGE=C")
)
categorical_ascii_locale_status <- attr(categorical_ascii_locale_output, "status", exact = TRUE)
if (!is.null(categorical_ascii_locale_status) && categorical_ascii_locale_status != 0L) {
  stop(
    paste(c("categorical ASCII C-locale transport child failed", categorical_ascii_locale_output), collapse = "\n"),
    call. = FALSE
  )
}
unlink(categorical_ascii_locale_script)

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
  capture_categorical_result = function(...) stop("unexpected categorical capture", call. = FALSE),
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
  formula_column_at = function(...) stop("unexpected formula", call. = FALSE),
  text_length_column_at = function(...) stop("unexpected text length", call. = FALSE),
  one_hot_encode_columns_at = function(...) stop("unexpected one-hot encoding", call. = FALSE),
  multi_label_binarize_column_at = function(...) stop("unexpected multi-label binarization", call. = FALSE),
  lower_text_column_at = function(...) stop("unexpected lowercase", call. = FALSE),
  upper_text_column_at = function(...) stop("unexpected uppercase", call. = FALSE),
  capitalize_text_column_at = function(...) stop("unexpected capitalize", call. = FALSE),
  strip_text_column_at = function(...) stop("unexpected strip", call. = FALSE),
  split_text_column_at = function(...) stop("unexpected split", call. = FALSE),
  find_replace_column_at = function(...) stop("unexpected find and replace", call. = FALSE),
  round_number_column_at = function(...) stop("unexpected round", call. = FALSE),
  min_max_scale_column_at = function(...) stop("unexpected Min-max scale", call. = FALSE),
  floor_number_column_at = function(...) stop("unexpected floor", call. = FALSE),
  ceil_number_column_at = function(...) stop("unexpected ceiling", call. = FALSE),
  format_datetime_column_at = function(...) stop("unexpected datetime format", call. = FALSE),
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
for (required_categorical_tool in c(
  "capture_categorical_result",
  "one_hot_encode_columns_at",
  "multi_label_binarize_column_at"
)) {
  incomplete_categorical_contract <- missing_package_contract
  incomplete_categorical_contract[[required_categorical_tool]] <- NULL
  incomplete_categorical_error <- tryCatch(
    {
      openwrangler_r_kernel_agent$new_agent(incomplete_categorical_contract, source_environment)
      NULL
    },
    error = function(error) error
  )
  if (
    is.null(incomplete_categorical_error) ||
      !identical(conditionMessage(incomplete_categorical_error), "Open Wrangler received an invalid R frame contract.")
  ) {
    stop(sprintf("the R agent accepted a frame contract without %s", required_categorical_tool), call. = FALSE)
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
  "min_max_scale_column_at",
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
if (!grepl("  .ow_result <- .ow_group_by(.ow_result, list(", group_by_apply$code, fixed = TRUE)) {
  stop("generated R Group By code did not format its call across readable lines", call. = FALSE)
}
if (!grepl('list(alias = "number_sum", operation = "sum"', group_by_apply$code, fixed = TRUE)) {
  stop("generated R Group By code did not keep the output name visible at the start of its aggregation", call. = FALSE)
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
