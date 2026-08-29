source("r/openwrangler_runtime/frame_contract.R", local = FALSE)
source("r/openwrangler_runtime/kernel_exports.R", local = FALSE)
source("r/openwrangler_runtime/kernel_agent.R", local = FALSE)

if (!requireNamespace("nanoparquet", quietly = TRUE)) {
  stop("The R kernel agent test requires nanoparquet", call. = FALSE)
}

assert_identical <- function(actual, expected, message) {
  if (!identical(actual, expected)) {
    stop(sprintf("%s\nExpected: %s\nActual: %s", message, deparse(expected), deparse(actual)), call. = FALSE)
  }
}

source("r/tests/warning_contract_assertions.R", local = FALSE)

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
csv_export_options <- list(format = "csv", delimiter = ",", quoteChar = "\"", encoding = "utf-8", header = TRUE)
parquet_export_options <- list(format = "parquet")
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
latest_full_capture <- NULL
group_by_source_materializations <- 0L
instrumented_frame_contract <- openwrangler_r_frame_contract
real_capture_frame <- instrumented_frame_contract$capture_frame
real_capture_pivot_longer_at <- instrumented_frame_contract$capture_pivot_longer_at
real_capture_pivot_wider_at <- instrumented_frame_contract$capture_pivot_wider_at
real_isolate_capture <- instrumented_frame_contract$isolate_capture
real_materialize_view_page <- instrumented_frame_contract$materialize_view_page
real_by_example_column_at <- instrumented_frame_contract$by_example_column_at
last_by_example_evaluator_error <- NULL
instrumented_frame_contract$capture_frame <- function(value, ...) {
  full_capture_count <<- full_capture_count + 1L
  captured <- real_capture_frame(value, ...)
  latest_full_capture <<- captured
  captured
}
instrumented_frame_contract$capture_pivot_longer_at <- function(...) {
  full_capture_count <<- full_capture_count + 1L
  captured <- real_capture_pivot_longer_at(...)
  latest_full_capture <<- captured
  captured
}
instrumented_frame_contract$capture_pivot_wider_at <- function(...) {
  full_capture_count <<- full_capture_count + 1L
  captured <- real_capture_pivot_wider_at(...)
  latest_full_capture <<- captured
  captured
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
instrumented_frame_contract$by_example_column_at <- function(
  value,
  positions,
  expected_names,
  new_name,
  result_kind,
  evaluator
) {
  real_by_example_column_at(
    value,
    positions,
    expected_names,
    new_name,
    result_kind,
    function(columns) {
      tryCatch(
        evaluator(columns),
        error = function(error) {
          last_by_example_evaluator_error <<- error
          stop(error)
        }
      )
    }
  )
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
    list(transportVersion = 14L, requestId = id, kind = kind, payload = payload),
    auto_unbox = TRUE,
    digits = 17L,
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
