# Native-R Group By engine-family, precision, overflow, and generated-code contract cases.
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
