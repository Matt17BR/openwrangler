# Native-R Group By engine-family, precision, overflow, and generated-code contract cases.
# Group sums share the live arithmetic once across a complete mixed plan.
local({
  helper_names <- c("compare_unsigned_decimal", "add_unsigned_decimal", "subtract_unsigned_decimal",
    "add_signed_decimal", "exact_integer_sum_text")
  assert_sum_helpers <- function(code, needed) {
    lines <- strsplit(code, "\n", fixed = TRUE)[[1L]]
    for (name in helper_names) {
      header <- sprintf("  %s <-", name)
      assert_identical(sum(lines == header), as.integer(needed), paste("wrong exact-sum dependency count for", name))
      if (needed) {
        helper <- get(name, environment(openwrangler_r_frame_contract$group_by_at), inherits = FALSE)
        emitted <- paste(c(header, paste0("  ", deparse(helper, width.cutoff = 500L))), collapse = "\n")
        assert_identical(grepl(emitted, code, fixed = TRUE), TRUE, paste("generated Group By changed the live", name))
      }
    }
  }
  sources <- new.env(parent = baseenv())
  sources$sum_frame <- data.frame(group = c("b", "a", "b"), value = c(2147483647L, 3L, -2147483647L),
    coarse = c(1.5e30, 2.5e30, 3.5e30))
  before <- serialize(sources$sum_frame, NULL, version = 3L)
  local_agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, sources)
  on.exit(local_agent$dispose(), add = TRUE)
  session <- "74747474-7474-4474-8474-747474747474"
  opened <- dispatch_with(local_agent, "openSession", list(sessionId = session, variableName = "sum_frame", page = page_window()))
  assert_identical(opened$kind, "page", "the exact-sum session did not open")
  group_step <- function(id, column_id, column_name, operation = "sum") list(id = id, kind = "groupBy", params = list(
    keys = list(list(id = "r:c:0", name = "group")),
    aggregations = list(list(column = list(id = column_id, name = column_name), operation = operation, alias = "total"),
      list(column = list(id = if (identical(column_name, "value")) "r:c:2" else "c:step:sum-first:1", name = "coarse"),
        operation = "sum", alias = "coarse"))))
  counted <- dispatch_with(local_agent, "previewStep", list(sessionId = session, revision = 0L,
    step = group_step("count-only", "r:c:1", "value", "count"), page = page_window()))
  assert_identical(counted$kind, "stepPreview", "the count-only plan did not preview")
  assert_sum_helpers(counted$code, FALSE)
  discarded <- dispatch_with(local_agent, "discardDraft", list(sessionId = session, revision = counted$revision, page = page_window()))
  assert_identical(discarded$code, "", "discarding count-only did not restore the empty plan")
  steps <- list(group_step("sum-first", "r:c:1", "value"),
    list(id = "round-between", kind = "roundNumber", params = list(
      column = list(id = "c:step:sum-first:1", name = "coarse"), decimals = -23L)),
    group_step("sum-again", "c:step:sum-first:0", "total"))
  live <- unserialize(before)
  revision <- discarded$revision
  first_code <- NULL
  for (step in steps) {
    preview <- dispatch_with(local_agent, "previewStep", list(sessionId = session, revision = revision, step = step, page = page_window()))
    assert_identical(preview$kind, "stepPreview", paste(step$id, "did not preview"))
    applied <- dispatch_with(local_agent, "applyDraft", list(sessionId = session, revision = preview$revision, page = page_window()))
    assert_identical(applied$action, "apply", paste(step$id, "did not apply"))
    assert_identical(applied$code, preview$code, "Apply changed exact-sum code")
    assert_identical(applied$page, preview$page, "Apply changed exact-sum results")
    assert_sum_helpers(applied$code, TRUE)
    if (identical(step$kind, "groupBy")) {
      live <- openwrangler_r_frame_contract$group_by_at(live, 1L, "group", c(2L, 3L), names(live)[2:3],
        c("sum", "sum"), c("total", "coarse"))
    } else {
      live <- openwrangler_r_frame_contract$round_number_column_at(live, 3L, "coarse", -23L)
    }
    standalone <- new.env(parent = baseenv())
    standalone$sum_frame <- unserialize(before)
    for (name in c(helper_names, "sum", "sprintf", "as.double", "abort")) {
      standalone[[name]] <- function(...) stop("caller intercepted Group By arithmetic", call. = FALSE)
    }
    assert_no_warning(eval(parse(text = applied$code), envir = standalone), paste("generated", step$id))
    assert_identical(standalone$open_wrangler_result, live, paste(step$id, "changed exact values or types"))
    assert_identical(serialize(standalone$sum_frame, NULL, version = 3L), before, "generated Group By changed the source")
    if (is.null(first_code)) first_code <- applied$code
    revision <- applied$revision
  }
  assert_identical(live$total, c(0L, 3L), "repeated Group By lost integer cancellation or first-seen order")
  assert_identical(serialize(sources$sum_frame, NULL, version = 3L), before, "live Group By changed the source")
  invisible(dispatch_with(local_agent, "closeSession", list(sessionId = session)))

  # Three native batches carry opposite large totals before a small residual.
  values <- c(rep.int(2147483647L, 1000000L), rep.int(-2147483647L, 1000000L), 7L)
  standalone$sum_frame <- data.frame(group = rep.int("g", length(values)), value = values, coarse = 0)
  batch_before <- serialize(standalone$sum_frame, NULL, version = 3L)
  assert_no_warning(eval(parse(text = first_code), envir = standalone), "generated multi-batch sum")
  assert_identical(standalone$open_wrangler_result, data.frame(group = "g", total = 7L, coarse = 0),
    "generated Group By lost the residual between integer batches")
  assert_identical(serialize(standalone$sum_frame, NULL, version = 3L), batch_before, "multi-batch sum changed the source")
})

assert_group_by_flavor_case <- function(
  case_session_id,
  variable_name,
  source,
  expected_flavor,
  expected_classes,
  expected_source_key_ids,
  expected_groups,
  expected_totals,
  key_columns = "group"
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
          keys = I(lapply(key_columns, function(name) {
            list(id = sprintf("r:c:%d", match(name, names(source)) - 1L), name = name)
          })),
          aggregations = I(list(list(
            column = list(id = sprintf("r:c:%d", match("value", names(source)) - 1L), name = "value"),
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
        function(row) as.integer(row$values[[length(key_columns) + 1L]]$raw),
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
  if (nrow(source) == 0L) {
    assert_identical(nrow(generated), 0L, "empty Group By invented a group")
    assert_identical(names(generated), c(key_columns, "total"), "empty Group By changed output names")
    assert_identical(generated$total, integer(), "empty Group By changed the integer sum type")
    for (name in key_columns) {
      assert_identical(generated[[name]], source[[name]], "empty Group By changed typed key metadata")
    }
  }
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

for (flavor in c("data.frame", "tibble", "data.table")) {
  for (key_count in c(1L, 2L)) {
    empty_source <- data.frame(
      group = character(), value = integer(),
      second = ordered(character(), levels = c("a", "b"))
    )
    if (identical(flavor, "tibble")) empty_source <- tibble::as_tibble(empty_source)
    if (identical(flavor, "data.table")) {
      empty_source <- data.table::as.data.table(empty_source)
      data.table::setkeyv(empty_source, "second")
    }
    assert_group_by_flavor_case(
      group_by_session_id, "group_by_empty", empty_source,
      switch(flavor, data.frame = "r.data.frame", tibble = "r.tibble", data.table = "r.data.table"),
      class(empty_source), if (identical(flavor, "data.table")) list("r:c:2") else list(),
      character(), integer(), c("group", "second")[seq_len(key_count)]
    )
  }
}

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
    options = parquet_export_options
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
assert_no_warning(
  eval(parse(text = group_by_precision_apply$code), envir = .GlobalEnv),
  "generated integer64 Group By"
)
group_by_precision_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
same_sign_midpoint <- assert_exact_warning(
  as.double(bit64::as.integer64("9223372036854775804")),
  c("simpleWarning", "warning", "condition"),
  "integer precision lost while converting to double",
  "the generated integer64 Group By midpoint expectation"
)
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

local({
  tiny <- 2^-1074
  midpoint_cases <- list(
    positive_tie = list(values = c(tiny, 2 * tiny), expected = 2 * tiny),
    negative_tie = list(values = c(-2 * tiny, -tiny), expected = -2 * tiny),
    positive_zero = list(values = c(-tiny, 2 * tiny), expected = 0),
    negative_zero = list(values = c(-2 * tiny, tiny), expected = -0.0),
    normal_boundary = list(
      values = c(.Machine$double.xmin - tiny, .Machine$double.xmin), expected = .Machine$double.xmin
    ),
    equal_negative_zero = list(values = c(-0.0, -0.0), expected = -0.0),
    odd_subnormal = list(values = tiny, expected = tiny),
    equal_subnormal = list(values = c(tiny, tiny), expected = tiny),
    negative_subnormal = list(values = c(-tiny, -tiny), expected = -tiny),
    adjacent = list(values = c(1, 1 + 3 * .Machine$double.eps), expected = 1 + 2 * .Machine$double.eps),
    equal_large = list(values = c(1e308, 1e308), expected = 1e308),
    distinct_large = list(values = c(2^1022, 2^1023), expected = 3 * 2^1021),
    opposite_large = list(values = c(-.Machine$double.xmax, .Machine$double.xmax), expected = 0),
    positive_infinity = list(values = c(Inf, Inf), expected = Inf),
    negative_infinity = list(values = c(-Inf, -Inf), expected = -Inf),
    opposing_infinities = list(values = c(-Inf, Inf), expected = NaN, fill_error = TRUE),
    missing = list(values = c(NA_real_, NaN), expected = NA_real_, fill_error = TRUE),
    mixed_missing = list(values = c(tiny, NA_real_, tiny, NaN), expected = tiny),
    integer_extremes = list(values = c(-2147483647L, 2147483647L), expected = 0),
    integer_odd = list(values = 2147483647L, expected = 2147483647)
  )
  constructors <- list(
    data.frame = identity,
    tibble = function(frame) tibble::as_tibble(frame),
    data.table = function(frame) data.table::as.data.table(frame)
  )
  midpoint_source <- new.env(parent = baseenv())
  midpoint_agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, midpoint_source)
  on.exit(midpoint_agent$dispose(), add = TRUE)
  midpoint_session_id <- "b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4"
  for (flavor in names(constructors)) {
    for (case_name in names(midpoint_cases)) {
      case <- midpoint_cases[[case_name]]
      missing <- if (is.integer(case$values)) NA_integer_ else NA_real_
      values <- c(case$values, missing)
      before <- constructors[[flavor]](data.frame(group = rep("a", length(values)), value = values))
      for (operation in c("groupBy", "fillMissingValues")) {
        label <- sprintf("%s %s %s median", flavor, case_name, operation)
        midpoint_source$midpoint_frame <- if (inherits(before, "data.table")) data.table::copy(before) else before
        opened <- dispatch_with(midpoint_agent, "openSession", list(
          sessionId = midpoint_session_id, variableName = "midpoint_frame", page = page_window()
        ))
        assert_identical(opened$kind, "page", paste(label, "did not open"))
        params <- if (identical(operation, "groupBy")) {
          list(
            keys = I(list(list(id = "r:c:0", name = "group"))),
            aggregations = I(list(list(
              column = list(id = "r:c:1", name = "value"), operation = "median", alias = "median"
            )))
          )
        } else {
          list(column = list(id = "r:c:1", name = "value"), replacement = list(kind = "median"))
        }
        preview <- dispatch_with(midpoint_agent, "previewStep", list(
          sessionId = midpoint_session_id, revision = 0L,
          step = list(id = "midpoint", kind = operation, params = params), page = page_window()
        ))
        if (identical(operation, "fillMissingValues") && isTRUE(case$fill_error)) {
          assert_identical(preview$kind, "error", paste(label, "accepted an unavailable median"))
        } else {
          assert_identical(preview$kind, "stepPreview", paste(label, "did not preview"))
          live <- if (identical(operation, "groupBy")) {
            openwrangler_r_frame_contract$group_by_at(before, 1L, "group", 2L, "value", "median", "median")
          } else {
            openwrangler_r_frame_contract$fill_missing_column_at(before, 2L, "value", list(kind = "median"))
          }
          expected <- if (identical(operation, "groupBy")) case$expected else {
            filled <- values
            filled[is.na(filled)] <- if (is.integer(values)) as.integer(case$expected) else case$expected
            filled
          }
          assert_identical(live[[2L]], expected, paste(label, "changed the live result"))
          assert_identical(sprintf("%a", live[[2L]]), sprintf("%a", expected), paste(label, "changed live result bits"))
          applied <- dispatch_with(midpoint_agent, "applyDraft", list(
            sessionId = midpoint_session_id, revision = 1L, page = page_window()
          ))
          assert_identical(applied$action, "apply", paste(label, "did not apply"))
          assert_identical(applied$page$page, preview$page$page, paste(label, "changed the preview on Apply"))
          assert_identical(applied$code, preview$code, paste(label, "changed code on Apply"))
          standalone <- new.env(parent = baseenv())
          standalone$midpoint_frame <- if (inherits(before, "data.table")) data.table::copy(before) else before
          assert_no_warning(eval(parse(text = applied$code), envir = standalone), paste("generated", label))
          generated <- standalone$open_wrangler_result
          assert_identical(generated[[2L]], expected, paste(label, "changed the generated result"))
          assert_identical(sprintf("%a", generated[[2L]]), sprintf("%a", expected), paste(label, "changed generated result bits"))
          assert_identical(class(generated), class(before), paste(label, "changed the dataframe flavor"))
          assert_identical(standalone$midpoint_frame, before, paste(label, "changed the generated source"))
          undone <- dispatch_with(midpoint_agent, "undoStep", list(
            sessionId = midpoint_session_id, revision = 2L, page = page_window()
          ))
          assert_identical(undone$action, "undo", paste(label, "did not undo"))
          assert_identical(undone$page$page, opened$page$page, paste(label, "did not restore the source page"))
        }
        assert_identical(midpoint_source$midpoint_frame, before, paste(label, "changed the live source"))
        invisible(dispatch_with(midpoint_agent, "closeSession", list(sessionId = midpoint_session_id)))
      }
    }
  }
})

local({
  wide <- bit64::as.integer64(c("9223372036854775807", "9223372036854775806", NA, NA))
  first_last_source <- data.frame(group = c("a", "a", "a", "b"), wide = wide)
  key_source <- data.frame(group = wide[c(1L, 2L, 3L, 1L)], value = c(1L, 2L, NA_integer_, 3L))
  empty_source <- data.frame(
    group = ordered(character(), levels = c("a", "b")), second = as.Date(character()),
    wide = bit64::as.integer64(character()), number = integer(),
    at = as.POSIXct(character(), tz = "UTC"), delta = as.difftime(numeric(), units = "hours"),
    label = factor(character(), levels = c("a", "b")), value = numeric(), flag = logical()
  )
  empty_expected <- empty_source
  empty_expected$flag <- integer()
  names(empty_expected) <- c("group", "second", "first", "total", "at", "delta", "label", "mean", "count")
  cases <- list(
    first_last = list(
      source = first_last_source, keys = "group", columns = c("wide", "wide"),
      operations = c("first", "last"), aliases = c("first", "last"),
      expected = data.frame(group = c("a", "b"), first = wide[c(1L, 3L)], last = wide[c(2L, 3L)]),
      loads_bit64 = TRUE
    ),
    wide_keys = list(
      source = key_source, keys = "group", columns = "value", operations = "count", aliases = "count",
      expected = data.frame(group = wide[1:3], count = c(2L, 1L, 0L)), loads_bit64 = TRUE
    ),
    unrelated_wide = list(
      source = data.frame(group = c("a", "a"), value = c(1L, 2L), unused = wide[1:2]),
      keys = "group", columns = "value", operations = "count", aliases = "count",
      expected = data.frame(group = "a", count = 2L), loads_bit64 = FALSE
    )
  )
  for (flavor in c("data.frame", "tibble", "data.table")) {
    source <- empty_source
    expected <- empty_expected
    if (identical(flavor, "tibble")) {
      source <- tibble::as_tibble(source)
      expected <- tibble::as_tibble(expected)
    }
    if (identical(flavor, "data.table")) {
      source <- data.table::as.data.table(source)
      data.table::setkeyv(source, "second")
      expected <- data.table::as.data.table(expected)
    }
    cases[[paste0("empty_", flavor)]] <- list(
      source = source, keys = c("group", "second"),
      columns = c("wide", "number", "at", "delta", "label", "value", "flag"),
      operations = c("first", "sum", "first", "first", "last", "mean", "count"),
      aliases = names(expected)[-(1:2)], expected = expected, loads_bit64 = TRUE
    )
  }
  sources <- new.env(parent = baseenv())
  local_agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, sources)
  on.exit(local_agent$dispose(), add = TRUE)
  session <- "b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5"
  cold_bundle <- tempfile("group-by-", fileext = ".rds")
  cold_script <- tempfile("group-by-", fileext = ".R")
  cold_log <- tempfile("group-by-", fileext = ".log")
  on.exit(unlink(c(cold_bundle, cold_script, cold_log)), add = TRUE)
  # RDS cannot preserve a data.table selfref across processes; compare all other
  # frame attributes and every typed column exactly. Namespace refusal is injected
  # only in a separate child, whose original base binding is restored on exit.
  writeLines(c(
    "options(warn = 2)",
    "(function() {",
    "bundle <- readRDS(commandArgs(TRUE)[[1L]])",
    "stopifnot(!isNamespaceLoaded('bit64'))",
    "unavailable <- identical(commandArgs(TRUE)[[2L]], 'unavailable')",
    "if (unavailable) {",
    "  original_require <- base::requireNamespace",
    "  on.exit({unlockBinding('requireNamespace', baseenv()); assign('requireNamespace', original_require, baseenv()); lockBinding('requireNamespace', baseenv())}, add = TRUE)",
    "  unlockBinding('requireNamespace', baseenv())",
    "  assign('requireNamespace', function(package, ...) if (identical(package, 'bit64')) FALSE else original_require(package, ...), baseenv())",
    "  lockBinding('requireNamespace', baseenv())",
    "}",
    "scope <- new.env(parent = baseenv())",
    "scope$group_by_cold <- bundle$source",
    "before <- serialize(scope$group_by_cold, NULL, version = 3L)",
    "scope$open_wrangler_result <- 'prior result'",
    "failure <- tryCatch({eval(parse(text = bundle$code), envir = scope); NULL}, error = identity)",
    "if (unavailable) {",
    "  stopifnot(inherits(failure, 'error'), identical(conditionMessage(failure), 'bit64 is required for integer64 Group By'))",
    "  stopifnot(identical(scope$open_wrangler_result, 'prior result'), identical(serialize(scope$group_by_cold, NULL, version = 3L), before))",
    "  return(invisible(NULL))",
    "}",
    "stopifnot(is.null(failure))",
    "result <- scope$open_wrangler_result",
    "if (inherits(result, 'data.table')) {",
    "  actual_attrs <- attributes(result); expected_attrs <- attributes(bundle$expected)",
    "  stopifnot(typeof(actual_attrs$.internal.selfref) == 'externalptr', typeof(expected_attrs$.internal.selfref) == 'externalptr')",
    "  actual_attrs$.internal.selfref <- NULL; expected_attrs$.internal.selfref <- NULL",
    "  stopifnot(identical(actual_attrs, expected_attrs))",
    "  stopifnot(identical(lapply(seq_along(result), function(i) result[[i]]), lapply(seq_along(bundle$expected), function(i) bundle$expected[[i]])))",
    "} else stopifnot(identical(result, bundle$expected))",
    "stopifnot(identical(isNamespaceLoaded('bit64'), bundle$loads_bit64))",
    "stopifnot(identical(serialize(scope$group_by_cold, NULL, version = 3L), before))",
    "scope$group_by_cold <- unserialize(before)",
    "names(scope$group_by_cold)[1L] <- 'stale key'",
    "scope$open_wrangler_result <- 'prior result'",
    "failure <- tryCatch({eval(parse(text = bundle$code), envir = scope); NULL}, error = identity)",
    "stopifnot(inherits(failure, 'error'), grepl('stale', conditionMessage(failure)))",
    "stopifnot(identical(scope$open_wrangler_result, 'prior result'))",
    "})()"
  ), cold_script)
  for (case_name in names(cases)) {
    case <- cases[[case_name]]
    source_bytes <- serialize(case$source, NULL, version = 3L)
    sources$group_by_cold <- unserialize(source_bytes)
    opened <- dispatch_with(local_agent, "openSession", list(
      sessionId = session, variableName = "group_by_cold", page = page_window()
    ))
    assert_identical(opened$kind, "page", paste(case_name, "did not open"))
    reference <- function(name) list(id = sprintf("r:c:%d", match(name, names(case$source)) - 1L), name = name)
    step <- list(id = "cold-group-by", kind = "groupBy", params = list(
      keys = I(lapply(case$keys, reference)),
      aggregations = I(lapply(seq_along(case$columns), function(i) list(
        column = reference(case$columns[[i]]), operation = case$operations[[i]], alias = case$aliases[[i]]
      )))
    ))
    for (field in c("keys", "aggregations")) {
      invalid <- step
      invalid$params[[field]] <- I(list())
      refused <- dispatch_with(local_agent, "previewStep", list(
        sessionId = session, revision = 0L, step = invalid, page = page_window()
      ))
      assert_identical(refused$kind, "error", paste(case_name, "accepted empty", field))
      unchanged <- dispatch_with(local_agent, "getPage", list(sessionId = session, page = page_window()))
      assert_identical(unchanged$page, opened$page, paste(case_name, "changed state on refusal"))
    }
    preview <- dispatch_with(local_agent, "previewStep", list(
      sessionId = session, revision = 0L, step = step, page = page_window()
    ))
    assert_identical(preview$kind, "stepPreview", paste(case_name, "did not preview"))
    live <- openwrangler_r_frame_contract$group_by_at(
      case$source, match(case$keys, names(case$source)), case$keys,
      match(case$columns, names(case$source)), case$columns, case$operations, case$aliases
    )
    assert_identical(live, case$expected, paste(case_name, "changed exact live values or metadata"))
    applied <- dispatch_with(local_agent, "applyDraft", list(
      sessionId = session, revision = preview$revision, page = page_window()
    ))
    assert_identical(applied$action, "apply", paste(case_name, "did not apply"))
    assert_identical(applied$page, preview$page, paste(case_name, "changed the public preview"))
    assert_identical(applied$code, preview$code, paste(case_name, "changed the generated program on Apply"))
    saveRDS(list(code = applied$code, source = case$source, expected = case$expected, loads_bit64 = case$loads_bit64), cold_bundle)
    modes <- if (identical(case_name, "first_last")) c("normal", "unavailable") else "normal"
    for (mode in modes) {
      cold_status <- system2(
        file.path(R.home("bin"), "Rscript"), c("--vanilla", shQuote(cold_script), shQuote(cold_bundle), mode),
        stdout = cold_log, stderr = cold_log
      )
      assert_identical(cold_status, 0L, paste(case_name, mode, "cold Group By failed", paste(readLines(cold_log), collapse = "\n")))
    }
    assert_identical(serialize(sources$group_by_cold, NULL, version = 3L), source_bytes, paste(case_name, "changed source bytes"))
    undone <- dispatch_with(local_agent, "undoStep", list(
      sessionId = session, revision = applied$revision, page = page_window()
    ))
    assert_identical(undone$page, opened$page, paste(case_name, "did not restore source metadata and rows"))
    invisible(dispatch_with(local_agent, "closeSession", list(sessionId = session)))
  }
})

# Ordinary Group By means retain their default reduction under registered caller methods.
local({
  methods <- get(".__S3MethodsTable__.", asNamespace("base"), inherits = FALSE)
  method_names <- c("mean.numeric", "mean.integer")
  had_methods <- vapply(method_names, exists, logical(1L), envir = methods, inherits = FALSE)
  prior_methods <- lapply(method_names, function(name) {
    if (exists(name, methods, inherits = FALSE)) get(name, methods, inherits = FALSE) else NULL
  })
  on.exit(for (i in seq_along(method_names)) {
    if (had_methods[[i]]) assign(method_names[[i]], prior_methods[[i]], methods)
    else if (exists(method_names[[i]], methods, inherits = FALSE)) rm(list = method_names[[i]], envir = methods)
  }, add = TRUE)
  poison <- function(...) stop("caller mean method dispatched", call. = FALSE)
  registerS3method("mean", "numeric", poison, envir = baseenv())
  registerS3method("mean", "integer", poison, envir = baseenv())
  stopifnot(inherits(try(base::mean(c(1, 3, 5)), silent = TRUE), "try-error"))
  sources <- new.env(parent = baseenv())
  sources$method_group <- data.frame(group = c("a", "a", "a", "b"), value = c(1, 3, 5, NA))
  before <- serialize(sources$method_group, NULL, version = 3L)
  local_agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, sources)
  on.exit(local_agent$dispose(), add = TRUE)
  session <- "72727272-7272-4272-8272-727272727272"
  opened <- dispatch_with(local_agent, "openSession", list(
    sessionId = session, variableName = "method_group", page = page_window()
  ))
  preview <- dispatch_with(local_agent, "previewStep", list(
    sessionId = session, revision = 0L, page = page_window(),
    step = list(id = "method-mean", kind = "groupBy", params = list(
      keys = list(list(id = "r:c:0", name = "group")),
      aggregations = list(list(column = list(id = "r:c:1", name = "value"), operation = "mean", alias = "average"))
    ))
  ))
  assert_identical(preview$kind, "stepPreview", "a caller mean method intercepted Group By")
  assert_identical(preview$page$page$rows[[1L]]$values[[2L]]$raw, "3", "Group By used a caller mean result")
  applied <- dispatch_with(local_agent, "applyDraft", list(
    sessionId = session, revision = preview$revision, page = page_window()
  ))
  assert_identical(applied$page, preview$page, "mean Group By changed its preview on Apply")
  copied <- new.env(parent = baseenv())
  copied$method_group <- unserialize(before)
  eval(parse(text = applied$code), envir = copied)
  assert_identical(copied$open_wrangler_result, data.frame(group = c("a", "b"), average = c(3, NA)),
    "generated mean Group By changed values, types or missing groups")
  assert_identical(serialize(copied$method_group, NULL, version = 3L), before, "generated mean Group By mutated source")
  assert_identical(serialize(sources$method_group, NULL, version = 3L), before, "live mean Group By mutated source")
  undone <- dispatch_with(local_agent, "undoStep", list(
    sessionId = session, revision = applied$revision, page = page_window()
  ))
  assert_identical(undone$page, opened$page, "mean Group By did not restore its input page")
  invisible(dispatch_with(local_agent, "closeSession", list(sessionId = session)))
})
