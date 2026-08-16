source("r/tests/kernel_agent_support.R", local = FALSE)

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
clone_element_names <- c("clone-row-a", "clone-row-b")
data.table::setattr(.subset2(source_environment$clone_frame, 2L), "names", clone_element_names)
assert_identical(
  attr(.subset2(source_environment$clone_frame, 2L), "names", exact = TRUE),
  clone_element_names,
  "the kernel clone fixture lost element names before dispatch"
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
assert_identical(
  attr(.subset2(clone_generated, 4L), "names", exact = TRUE),
  clone_element_names,
  "generated R Clone Column lost copied element names"
)
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
clone_table_element_names <- c("table-row-one", "table-row-two")
data.table::setattr(.subset2(source_environment$clone_table, 2L), "names", clone_table_element_names)
assert_identical(
  attr(.subset2(source_environment$clone_table, 2L), "names", exact = TRUE),
  clone_table_element_names,
  "the kernel data.table clone fixture lost element names before dispatch"
)
clone_table_before <- data.table::copy(source_environment$clone_table)
data.table::setattr(.subset2(clone_table_before, 2L), "names", clone_table_element_names)
clone_table_source_bytes <- serialize(source_environment$clone_table, NULL, version = 3L)
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
clone_table_live <- get("snapshot", envir = latest_full_capture, inherits = FALSE)
assert_identical(
  attr(.subset2(clone_table_live, 2L), "names", exact = TRUE),
  clone_table_element_names,
  "live data.table Clone Column lost original element names"
)
assert_identical(
  attr(.subset2(clone_table_live, 3L), "names", exact = TRUE),
  clone_table_element_names,
  "live data.table Clone Column lost copied element names"
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
  attr(.subset2(clone_table_generated, 2L), "names", exact = TRUE),
  clone_table_element_names,
  "generated data.table Clone Column lost original element names"
)
assert_identical(
  attr(.subset2(clone_table_generated, 3L), "names", exact = TRUE),
  clone_table_element_names,
  "generated data.table Clone Column lost copied element names"
)
assert_identical(
  get("clone_table", envir = .GlobalEnv, inherits = FALSE),
  clone_table_before,
  "generated R data.table clone mutated its source"
)
assert_identical(
  serialize(get("clone_table", envir = .GlobalEnv, inherits = FALSE), NULL, version = 3L),
  clone_table_source_bytes,
  "generated R data.table clone changed source bytes"
)
rm("clone_table", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(source_environment$clone_table, clone_table_before, "the R data.table clone mutated its source")
assert_identical(
  serialize(source_environment$clone_table, NULL, version = 3L),
  clone_table_source_bytes,
  "the live R data.table clone changed source bytes"
)
clone_table_closed <- dispatch("closeSession", list(sessionId = clone_table_session_id))
assert_identical(clone_table_closed$kind, "closed", "the R data.table clone session did not close")

source("r/tests/kernel_agent_text.R", local = FALSE)

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

source("r/tests/kernel_agent_rows.R", local = FALSE)

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
        transportVersion = 14L,
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
  source_environment$clone_names <- data.frame(left = c(1L, 2L), right = c(3L, 4L), check.names = FALSE)
  attr(source_environment$clone_names, "names") <- I(c("left", "right"))
  assert_child(
    identical(attr(source_environment$clone_names, "names", exact = TRUE), I(c("left", "right"))),
    "the caller-S3 clone fixture lost classed frame names before dispatch"
  )
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
  clone_source_bytes <- serialize(source_environment$clone_names, NULL, version = 3L)
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
        transportVersion = 14L,
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
    assert_child(
      identical(opened$kind, "page"),
      sprintf(
        "could not open %s: %s",
        variable_name,
        if (is.null(opened$message)) "no diagnostic" else opened$message
      )
    )
    previewed <- dispatch(
      "previewStep",
      list(sessionId = session_id, revision = 0L, step = step, page = page)
    )
    assert_child(
      identical(previewed$kind, "stepPreview"),
      sprintf(
        "could not preview %s: %s",
        variable_name,
        if (is.null(previewed$message)) "no diagnostic" else previewed$message
      )
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

  method_keys <- c("[[.AsIs", "anyNA.AsIs", "is.na.AsIs", "length.AsIs", "Ops.AsIs", "c.AsIs")
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
    c("Ops", "AsIs", "Ops.AsIs"),
    c("c", "AsIs", "c.AsIs")
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

  clone_code <- compile_case(
    "clone_names",
    "99999999-9999-4999-8999-999999999993",
    list(
      id = "classed-frame-name-clone",
      kind = "cloneColumn",
      params = list(column = list(id = "r:c:1", name = "right"), newName = "right copy")
    )
  )
  assert_no_calls("live Clone Column with classed frame names")
  clone_environment <- new.env(parent = .GlobalEnv)
  assign("clone_names", unserialize(clone_source_bytes), envir = clone_environment)
  eval(parse(text = clone_code), envir = clone_environment)
  clone_generated <- get("open_wrangler_result", envir = clone_environment, inherits = FALSE)
  assert_child(
    identical(attr(clone_generated, "names", exact = TRUE), c("left", "right", "right copy")) &&
      identical(base::.subset2(clone_generated, 3L), c(3L, 4L)),
    "generated Clone Column did not canonicalize classed frame names"
  )
  assert_child(
    identical(
      serialize(get("clone_names", envir = clone_environment, inherits = FALSE), NULL, version = 3L),
      clone_source_bytes
    ) && identical(serialize(source_environment$clone_names, NULL, version = 3L), clone_source_bytes),
    "live or generated Clone Column mutated its classed-name source"
  )
  assert_no_calls("generated Clone Column with classed frame names")
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
        transportVersion = 14L,
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
      transportVersion = 14L,
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

# Native-R Transform by Example: deterministic synthesis, retained public IR,
# lifecycle replay, and standalone generated-code equivalence.
by_example_assert <- function(condition, message) {
  if (!isTRUE(condition)) stop(message, call. = FALSE)
}
by_example_agent_environment <- environment(openwrangler_r_kernel_agent$new_agent)
by_example_scalar_text <- get("by_example_scalar_text", envir = by_example_agent_environment, inherits = FALSE)
by_example_double_text <- get("by_example_double_text", envir = by_example_agent_environment, inherits = FALSE)
by_example_program_key <- get("by_example_program_key", envir = by_example_agent_environment, inherits = FALSE)
by_example_decimal_digit_zeroes <- get(
  "by_example_decimal_digit_zeroes",
  envir = by_example_agent_environment,
  inherits = FALSE
)
by_example_decimal_digit_pattern <- get(
  "by_example_decimal_digit_pattern",
  envir = by_example_agent_environment,
  inherits = FALSE
)
by_example_datetime_parts <- get("by_example_datetime_parts", envir = by_example_agent_environment, inherits = FALSE)
by_example_format_datetime_parts <- get(
  "by_example_format_datetime_parts",
  envir = by_example_agent_environment,
  inherits = FALSE
)
by_example_regex_extract_scalar <- get(
  "by_example_regex_extract_scalar",
  envir = by_example_agent_environment,
  inherits = FALSE
)
by_example_evaluator <- get(
  "generated_by_example_evaluate",
  envir = by_example_agent_environment,
  inherits = FALSE
)
by_example_encoder <- get("encode_response", envir = by_example_agent_environment, inherits = FALSE)
by_example_synthesize <- get(
  "synthesize_by_example_program",
  envir = by_example_agent_environment,
  inherits = FALSE
)
by_example_candidate_literals_are_portable <- get(
  "by_example_candidate_literals_are_portable",
  envir = by_example_agent_environment,
  inherits = FALSE
)
by_example_json_has_negative_zero <- get(
  "json_has_negative_zero_number",
  envir = by_example_agent_environment,
  inherits = FALSE
)

for (raw_number in c("-0", "-0.0", "-0.000e+9", "-0E-999")) {
  by_example_assert(
    by_example_json_has_negative_zero(sprintf('{"value":%s}', raw_number)),
    sprintf("the raw JSON scanner missed negative zero %s", raw_number)
  )
}
for (raw_json in c(
  '{"value":-0.001e+9}',
  '{"value":1e-0}',
  '{"value":1e-01}',
  '{"value":10E-01}',
  '{"value":"-0"}',
  '{"value":"escaped \\\"-0\\\" text"}',
  '{"value":"even \\\\ backslashes -0"}',
  '{"value":"odd \\\\\\\" quote -0"}'
)) {
  by_example_assert(
    !by_example_json_has_negative_zero(raw_json),
    sprintf("the raw JSON scanner overreached into %s", raw_json)
  )
}

by_example_float_cases <- list(
  list(value = 1, expected = "1.0"),
  list(value = -0, expected = "-0.0"),
  list(value = 1e15, expected = "1000000000000000.0"),
  list(value = 1e16, expected = "1e+16"),
  list(value = 1e-4, expected = "0.0001"),
  list(value = 1e-5, expected = "1e-05"),
  list(value = 1e-6, expected = "1e-06"),
  list(value = 1e-7, expected = "1e-07"),
  list(value = 1.2345678901234567, expected = "1.2345678901234567"),
  list(
    value = jsonlite::fromJSON("-3.745100118582918e211", simplifyVector = FALSE),
    expected = "-3.745100118582918e+211"
  )
)
for (case in by_example_float_cases) {
  assert_identical(
    by_example_double_text(as.double(case$value), python = TRUE),
    case$expected,
    sprintf("R by-example finite-double text changed for %s", case$expected)
  )
}
assert_identical(by_example_scalar_text(4000000000), "4000000000", "a safe whole JSON double lost integer text semantics")
assert_identical(by_example_scalar_text(1e-7), "1e-07", "a fractional JSON double lost Python scalar text semantics")

unicode_key_program <- list(kind = "literal", value = paste0(intToUtf8(946L), intToUtf8(0x1f600L)))
assert_identical(
  by_example_program_key(unicode_key_program, ensure_ascii = TRUE, compact = FALSE),
  "{\"kind\": \"literal\", \"value\": \"\\u03b2\\ud83d\\ude00\"}",
  "R by-example ranking no longer matches Python sorted-key ASCII JSON"
)
assert_identical(
  by_example_program_key(unicode_key_program, ensure_ascii = FALSE, compact = TRUE),
  paste0("{\"kind\":\"literal\",\"value\":\"", intToUtf8(946L), intToUtf8(0x1f600L), "\"}"),
  "R by-example candidate de-duplication no longer matches Python compact Unicode JSON"
)

by_example_numeric_roundtrip <- list(
  0.1,
  0.30000000000000004,
  1.2345678901234567,
  1.0000000000000002,
  2147483648,
  1000000000000001,
  9007199254740991,
  .Machine$double.xmin,
  2^-1074
)
for (value in by_example_numeric_roundtrip) {
  encoded <- by_example_encoder(list(value = value))
  decoded <- jsonlite::fromJSON(encoded, simplifyVector = FALSE)$value
  by_example_assert(
    identical(as.double(decoded), as.double(value)),
    sprintf("protocol v14 did not round-trip finite double %s", format(value, digits = 17L))
  )
}
for (warning_count in 0:2) {
  warnings <- I(as.list(sprintf("warning-%d", seq_len(warning_count))))
  decoded <- jsonlite::fromJSON(by_example_encoder(list(warnings = warnings)), simplifyVector = FALSE)
  assert_identical(
    decoded$warnings,
    as.list(sprintf("warning-%d", seq_len(warning_count))),
    sprintf("protocol v14 did not retain a %d-element warnings array", warning_count)
  )
}

portable_ratio <- by_example_synthesize(
  list(list(id = "r:c:0", name = "number")),
  list(
    list(inputs = list(1e-16), output = 1L),
    list(inputs = list(2e-16), output = 2L)
  )
)
assert_identical(portable_ratio$program$kind, "arithmetic", "R safe-literal filtering changed the ratio AST")
assert_identical(portable_ratio$program$operator, "divide", "R retained an unsafe whole multiply literal")
assert_identical(portable_ratio$candidateCount, 1L, "R counted an unsafe whole candidate literal")
assert_identical(portable_ratio$warnings, list(), "R warned about a discarded unsafe candidate literal")
negative_portable_ratio <- by_example_synthesize(
  list(list(id = "r:c:0", name = "number")),
  list(
    list(inputs = list(1e-16), output = -1L),
    list(inputs = list(2e-16), output = -2L)
  )
)
assert_identical(
  negative_portable_ratio$candidateCount,
  1L,
  "R counted a negative unsafe whole candidate literal"
)
by_example_assert(
  by_example_candidate_literals_are_portable(list(kind = "literal", value = 9007199254740991)),
  "R rejected Number.MAX_SAFE_INTEGER as a candidate literal"
)
by_example_assert(
  !by_example_candidate_literals_are_portable(list(kind = "literal", value = 9007199254740992)),
  "R accepted Number.MAX_SAFE_INTEGER + 1 as a candidate literal"
)

decimal_digit_pattern <- by_example_decimal_digit_pattern()
by_example_assert(
  !grepl("\\d", decimal_digit_pattern, fixed = TRUE),
  "R by-example datetime still depends on the host PCRE Unicode property table"
)
decimal_digit_codepoints <- unlist(lapply(
  by_example_decimal_digit_zeroes(),
  function(zero) zero + 0:9
), use.names = FALSE)
assert_identical(
  length(by_example_decimal_digit_zeroes()),
  76L,
  "R by-example's explicit decimal-digit range count changed"
)
assert_identical(
  c(length(decimal_digit_codepoints), length(unique(decimal_digit_codepoints))),
  c(760L, 760L),
  "R by-example's explicit decimal-digit code points are incomplete or repeated"
)
by_example_assert(
  all(vapply(decimal_digit_codepoints, function(codepoint) {
    grepl(paste0("(*UTF)^", decimal_digit_pattern, "\\z"), intToUtf8(codepoint), perl = TRUE)
  }, logical(1L), USE.NAMES = FALSE)),
  "R by-example datetime's explicit decimal-digit class is incomplete"
)
decimal_digit_scalars <- vapply(decimal_digit_codepoints, intToUtf8, character(1L), USE.NAMES = FALSE)
assert_identical(
  vapply(decimal_digit_scalars, function(digit) {
    by_example_regex_extract_scalar(paste0("prefix", digit, "suffix"), "(\\d+)", 1L)
  }, character(1L), USE.NAMES = FALSE),
  decimal_digit_scalars,
  "R by-example canonical regex extraction does not cover all 760 Unicode decimal digits"
)
newest_decimal_year <- paste0(intToUtf8(0x1e5f1L + c(2L, 0L, 2L, 6L)), collapse = "")
by_example_assert(
  grepl(paste0("(*UTF)^", decimal_digit_pattern, "{4}\\z"), newest_decimal_year, perl = TRUE),
  "R by-example datetime delegated the newest supported digit block to host PCRE"
)
newest_decimal_run <- paste0(intToUtf8(0x1e5f1L + c(1L, 2L)), collapse = "")
assert_identical(
  by_example_regex_extract_scalar(paste0("prefix", newest_decimal_run, "suffix"), "(\\d+)", 1L),
  newest_decimal_run,
  "R by-example canonical regex extraction delegated Unicode decimal digits to host PCRE"
)
assert_identical(
  by_example_regex_extract_scalar("alpha-123", "([A-Za-z]+)", 1L),
  "alpha",
  "R by-example changed canonical ASCII alpha extraction semantics"
)
assert_identical(
  by_example_regex_extract_scalar("alpha123-omega", "([A-Za-z0-9]+)", 1L),
  "alpha123",
  "R by-example changed canonical ASCII alphanumeric extraction semantics"
)

datetime_parity_cases <- list(
  list("2   january   2024", "%d %B %Y", "2024-01-02"),
  list("2\tjanuary\t2024", "%d %B %Y", "2024-01-02"),
  list(
    paste0("2", intToUtf8(0x1cL), "January", intToUtf8(0x1cL), "2024"),
    "%d %B %Y",
    "2024-01-02"
  ),
  list("january  2,  2024", "%B %d, %Y", "2024-01-02"),
  list("january\t2,\t2024", "%B %d, %Y", "2024-01-02"),
  list(" 1/2/2024", "%d/%m/%Y", "2024-02-01"),
  list("01/ 2/2024", "%m/%d/%Y", "2024-01-02"),
  list("2024112", "%Y%m%d", "2024-11-02"),
  list("20241 2", "%Y%m%d", "2024-01-02"),
  list("202401 2", "%Y%m%d", "2024-01-02"),
  list("2024202", "%Y%m%d", "2024-02-02"),
  list("2024131", "%Y%m%d", "2024-01-31"),
  list("2024229", "%Y%m%d", "2024-02-29"),
  list("2٢/01/2024", "%d/%m/%Y", "2024-01-22"),
  list("2024012٢", "%Y%m%d", "2024-01-22"),
  list("٢٠٢٤", "%Y", "2024-01-01"),
  list("２０２５", "%Y", "2025-01-01"),
  list(newest_decimal_year, "%Y", "2026-01-01")
)
for (case in datetime_parity_cases) {
  actual <- by_example_format_datetime_parts(by_example_datetime_parts(case[[1L]], case[[2L]]), "%Y-%m-%d")
  assert_identical(actual, case[[3L]], sprintf("R by-example datetime parity changed for %s", case[[1L]]))
}
for (case in list(
  list("1/2/2024\n", "%d/%m/%Y"),
  list(" 02/2/2024", "%d/%m/%Y"),
  list(" 29 January 2024", "%d %B %Y"),
  list(paste0("01/", intToUtf8(0x0662L), "/2024"), "%d/%m/%Y"),
  list(paste0(intToUtf8(0x1e5fbL), "026"), "%Y")
)) {
  rejected <- tryCatch(
    {
      by_example_datetime_parts(case[[1L]], case[[2L]])
      FALSE
    },
    error = function(error) TRUE
  )
  by_example_assert(rejected, sprintf("R by-example datetime overaccepted %s", case[[1L]]))
}

source_environment$by_example_ast <- data.frame(
  identity = c("one", "two"),
  slice = c("aβc", "d😀f"),
  split = c("a--bb", "long--dd"),
  first = c("Ann", "Bo"),
  last = c("Lee", "Li"),
  regex = c("x١٢y", paste0("long", newest_decimal_run, "z")),
  replace = c("aa-old-zz", "bbbb-old-y"),
  case = c("AbC", "DeF"),
  capitalize = c("aLPHA", "bETA"),
  date = c("1/2/2024", "12/31/2025"),
  number = c(1L, 5L),
  decimal = c(1.5, 2.5),
  check.names = FALSE,
  row.names = c("example-a", "example-b")
)
by_example_ast_before <- serialize(source_environment$by_example_ast, NULL, version = 3L)
by_example_ast_session <- "bebebebe-bebe-4ebe-8ebe-bebebebebebe"
by_example_ast_open <- dispatch(
  "openSession",
  list(sessionId = by_example_ast_session, variableName = "by_example_ast", page = page_window())
)
assert_identical(by_example_ast_open$kind, "page", "the R by-example AST session did not open")

by_example_reference <- function(name) {
  position <- match(name, names(source_environment$by_example_ast))
  list(id = sprintf("r:c:%d", position - 1L), name = name)
}
by_example_step <- function(id, source_names, new_name, input_rows, outputs, program = NULL) {
  examples <- lapply(seq_along(outputs), function(index) {
    list(inputs = I(input_rows[[index]]), output = outputs[[index]])
  })
  params <- list(
    sourceColumns = I(lapply(source_names, by_example_reference)),
    newColumn = new_name,
    examples = I(examples)
  )
  if (!is.null(program)) params$program <- program
  list(id = id, kind = "byExample", params = params)
}

# Generated plans must size each by-example step from the frame produced by the
# immediately preceding step, not from the immutable source frame. Exercise all
# native operations that can reduce cardinality and retain the exact live frame
# so generated/live comparison includes dataframe, row-name, and column attrs.
assert_by_example_after_cardinality_change <- function(case) {
  case_environment <- new.env(parent = emptyenv())
  token <- ordered(
    c("beta", "alpha", NA_character_, "beta", "gamma", "alpha"),
    levels = c("alpha", "beta", "gamma")
  )
  source <- data.frame(
    token = token,
    value = c(1L, 2L, NA_integer_, 1L, 3L, 2L),
    row.names = paste0("source-row-", seq_len(6L)),
    check.names = FALSE
  )
  if (identical(case$flavor, "tibble")) {
    row.names(source) <- NULL
    source <- tibble::as_tibble(source, .name_repair = "minimal")
    attr(source[[1L]], "names") <- paste0("element-", seq_len(6L))
    assert_identical(
      attr(source[[1L]], "names", exact = TRUE),
      paste0("element-", seq_len(6L)),
      "the named-factor cardinality fixture lost its element names before dispatch"
    )
  }
  case_environment$cardinality_source <- source
  source_bytes <- serialize(case_environment$cardinality_source, NULL, version = 3L)
  live_result <- NULL
  live_formula_result <- NULL
  case_contract <- openwrangler_r_frame_contract
  case_by_example_column_at <- case_contract$by_example_column_at
  case_formula_column_at <- case_contract$formula_column_at
  case_contract$by_example_column_at <- function(...) {
    result <- case_by_example_column_at(...)
    live_result <<- unserialize(serialize(result, NULL, version = 3L))
    result
  }
  case_contract$formula_column_at <- function(...) {
    result <- case_formula_column_at(...)
    live_formula_result <<- unserialize(serialize(result, NULL, version = 3L))
    result
  }
  case_agent <- openwrangler_r_kernel_agent$new_agent(case_contract, case_environment)
  case_dispatch <- function(kind, payload) dispatch_with(case_agent, kind, payload)

  opened <- case_dispatch(
    "openSession",
    list(sessionId = case$session_id, variableName = "cardinality_source", page = page_window())
  )
  assert_identical(opened$kind, "page", sprintf("the %s composition session did not open", case$label))
  cardinality_preview <- case_dispatch(
    "previewStep",
    list(
      sessionId = case$session_id,
      revision = 0L,
      step = case$step,
      page = page_window()
    )
  )
  assert_identical(
    cardinality_preview$kind,
    "stepPreview",
    sprintf("the %s cardinality step did not preview", case$label)
  )
  cardinality_apply <- case_dispatch(
    "applyDraft",
    list(sessionId = case$session_id, revision = cardinality_preview$revision, page = page_window())
  )
  assert_identical(
    cardinality_apply$action,
    "apply",
    sprintf("the %s cardinality step did not apply", case$label)
  )

  by_example_id <- paste0(case$step$id, "-by-example")
  source_reference <- list(id = "r:c:0", name = "token")
  by_example_preview <- case_dispatch(
    "previewStep",
    list(
      sessionId = case$session_id,
      revision = cardinality_apply$revision,
      step = list(
        id = by_example_id,
        kind = "byExample",
        params = list(
          sourceColumns = I(list(source_reference)),
          newColumn = "token copy",
          examples = I(list(
            list(inputs = I(list("alpha")), output = "alpha"),
            list(inputs = I(list("beta")), output = "beta")
          ))
        )
      ),
      page = page_window()
    )
  )
  assert_identical(
    by_example_preview$kind,
    "stepPreview",
    sprintf("by-example after %s did not preview", case$label)
  )
  assert_identical(
    by_example_preview$retainedStep$params$program$kind,
    "column",
    sprintf("by-example after %s did not synthesize a direct column program", case$label)
  )
  assert_identical(
    by_example_preview$retainedStep$params$sourceColumns[[1L]],
    source_reference,
    sprintf("by-example after %s changed its stable source reference", case$label)
  )
  assert_identical(
    unlist(by_example_preview$page$page$columnIds, use.names = FALSE),
    c(case$result_ids, paste0("c:step:", by_example_id, ":0")),
    sprintf("by-example after %s returned unstable column identities", case$label)
  )
  assert_identical(
    by_example_preview$page$page$totalRows,
    case$row_count,
    sprintf("by-example after %s used the wrong live row count", case$label)
  )
  by_example_apply <- case_dispatch(
    "applyDraft",
    list(sessionId = case$session_id, revision = by_example_preview$revision, page = page_window())
  )
  assert_identical(
    by_example_apply$action,
    "apply",
    sprintf("by-example after %s did not apply", case$label)
  )
  if (is.null(live_result)) {
    stop(sprintf("by-example after %s did not execute against the live frame", case$label), call. = FALSE)
  }
  assert_identical(
    live_result[["token copy"]],
    live_result[["token"]],
    sprintf("live by-example after %s lost factor values, attrs, or names", case$label)
  )
  assert_identical(
    base::attr(live_result[["token copy"]], "names", exact = TRUE),
    case$output_names,
    sprintf("live by-example after %s did not retain the current element names", case$label)
  )

  generated_environment <- new.env(parent = baseenv())
  assign(
    "cardinality_source",
    unserialize(source_bytes),
    envir = generated_environment
  )
  eval(parse(text = by_example_apply$code), envir = generated_environment)
  generated <- get("open_wrangler_result", envir = generated_environment, inherits = FALSE)
  assert_identical(
    serialize(generated, NULL, version = 3L),
    serialize(live_result, NULL, version = 3L),
    sprintf("generated by-example after %s diverged from the exact live frame", case$label)
  )
  assert_identical(
    generated[["token copy"]],
    generated[["token"]],
    sprintf("generated by-example after %s lost factor values, attrs, or names", case$label)
  )
  assert_identical(
    serialize(case_environment$cardinality_source, NULL, version = 3L),
    source_bytes,
    sprintf("live %s/by-example composition mutated its source", case$label)
  )
  assert_identical(
    serialize(get("cardinality_source", envir = generated_environment, inherits = FALSE), NULL, version = 3L),
    source_bytes,
    sprintf("generated %s/by-example composition mutated its source", case$label)
  )

  by_example_undo <- case_dispatch(
    "undoStep",
    list(sessionId = case$session_id, revision = by_example_apply$revision, page = page_window())
  )
  assert_identical(
    by_example_undo$action,
    "undo",
    sprintf("the %s composition could not restore its cardinality-only plan", case$label)
  )
  formula_id <- paste0(case$step$id, "-formula")
  formula_preview <- case_dispatch(
    "previewStep",
    list(
      sessionId = case$session_id,
      revision = by_example_undo$revision,
      step = list(
        id = formula_id,
        kind = "formula",
        params = list(
          leftColumn = case$formula_reference,
          operator = "add",
          newColumn = "value plus one",
          value = 1L
        )
      ),
      page = page_window()
    )
  )
  assert_identical(
    formula_preview$kind,
    "stepPreview",
    sprintf("Formula after %s did not preview", case$label)
  )
  assert_identical(
    unlist(formula_preview$page$page$columnIds, use.names = FALSE),
    c(case$result_ids, paste0("c:step:", formula_id, ":0")),
    sprintf("Formula after %s returned unstable column identities", case$label)
  )
  assert_identical(
    formula_preview$page$page$totalRows,
    case$row_count,
    sprintf("Formula after %s used the wrong live row count", case$label)
  )
  formula_apply <- case_dispatch(
    "applyDraft",
    list(sessionId = case$session_id, revision = formula_preview$revision, page = page_window())
  )
  assert_identical(
    formula_apply$action,
    "apply",
    sprintf("Formula after %s did not apply", case$label)
  )
  if (is.null(live_formula_result)) {
    stop(sprintf("Formula after %s did not execute against the live frame", case$label), call. = FALSE)
  }
  generated_formula_environment <- new.env(parent = baseenv())
  assign(
    "cardinality_source",
    unserialize(source_bytes),
    envir = generated_formula_environment
  )
  eval(parse(text = formula_apply$code), envir = generated_formula_environment)
  generated_formula <- get(
    "open_wrangler_result",
    envir = generated_formula_environment,
    inherits = FALSE
  )
  assert_identical(
    serialize(generated_formula, NULL, version = 3L),
    serialize(live_formula_result, NULL, version = 3L),
    sprintf("generated Formula after %s diverged from the exact live frame", case$label)
  )
  assert_identical(
    serialize(get("cardinality_source", envir = generated_formula_environment, inherits = FALSE), NULL, version = 3L),
    source_bytes,
    sprintf("generated %s/Formula composition mutated its source", case$label)
  )
  assert_identical(
    serialize(case_environment$cardinality_source, NULL, version = 3L),
    source_bytes,
    sprintf("live %s/Formula composition mutated its source", case$label)
  )
  invisible(case_dispatch("closeSession", list(sessionId = case$session_id)))
}

cardinality_composition_cases <- list(
  list(
    label = "Drop Missing Rows",
    session_id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
    flavor = "tibble",
    row_count = 5L,
    output_names = paste0("element-", c(1L, 2L, 4L, 5L, 6L)),
    result_ids = c("r:c:0", "r:c:1"),
    formula_reference = list(id = "r:c:1", name = "value"),
    step = row_reduction_step(
      "dropMissingRows",
      "cardinality-drop-missing",
      columns = list(list(id = "r:c:1", name = "value")),
      mode = "any"
    )
  ),
  list(
    label = "Drop Duplicates",
    session_id = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b",
    flavor = "data.frame",
    row_count = 4L,
    output_names = NULL,
    result_ids = c("r:c:0", "r:c:1"),
    formula_reference = list(id = "r:c:1", name = "value"),
    step = row_reduction_step(
      "dropDuplicates",
      "cardinality-drop-duplicates",
      columns = list(list(id = "r:c:0", name = "token")),
      mode = "first"
    )
  ),
  list(
    label = "Filter Rows",
    session_id = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c",
    flavor = "data.frame",
    row_count = 2L,
    output_names = NULL,
    result_ids = c("r:c:0", "r:c:1"),
    formula_reference = list(id = "r:c:1", name = "value"),
    step = list(
      id = "cardinality-filter-rows",
      kind = "filterRows",
      params = list(filterModel = list(
        logic = "and",
        filters = I(list(list(
          column = list(id = "r:c:0", name = "token"),
          type = "string",
          predicates = I(list()),
          valueFilter = list(
            kind = "values",
            selectedValues = I(list("beta")),
            includeNulls = FALSE,
            includeNaN = FALSE
          )
        ))),
        sort = I(list())
      ))
    )
  ),
  list(
    label = "Group By",
    session_id = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d",
    flavor = "data.frame",
    row_count = 4L,
    output_names = NULL,
    result_ids = c("r:c:0", "c:step:cardinality-group-by:0"),
    formula_reference = list(id = "c:step:cardinality-group-by:0", name = "total"),
    step = list(
      id = "cardinality-group-by",
      kind = "groupBy",
      params = list(
        keys = I(list(list(id = "r:c:0", name = "token"))),
        aggregations = I(list(list(
          column = list(id = "r:c:1", name = "value"),
          operation = "sum",
          alias = "total"
        )))
      )
    )
  )
)
for (cardinality_composition_case in cardinality_composition_cases) {
  assert_by_example_after_cardinality_change(cardinality_composition_case)
}
by_example_ast_cases <- list(
  list("literal", "literal out", "literal", c("identity"), list(list("one"), list("two")), list("fixed", "fixed")),
  list("column", "column out", "column", c("identity"), list(list("one"), list("two")), list("one", "two")),
  list("slice", "slice out", "slice", c("slice"), list(list("aβc"), list("d😀f")), list("β", "😀")),
  list("split", "split out", "split", c("split"), list(list("a--bb"), list("long--dd")), list("bb", "dd")),
  list("concat", "concat out", "concat", c("first", "last"), list(list("Ann", "Lee"), list("Bo", "Li")), list("Ann Lee", "Bo Li")),
  list(
    "regex-extract",
    "regex out",
    "regexExtract",
    c("regex"),
    list(list("x١٢y"), list(paste0("long", newest_decimal_run, "z"))),
    list("١٢", newest_decimal_run)
  ),
  list("regex-replace", "replace out", "regexReplace", c("replace"), list(list("aa-old-zz"), list("bbbb-old-y")), list("aa-new-zz", "bbbb-new-y")),
  list("case", "case out", "case", c("case"), list(list("AbC"), list("DeF")), list("abc", "def")),
  list("capitalize", "capitalize out", "case", c("capitalize"), list(list("aLPHA"), list("bETA")), list("Alpha", "Beta")),
  list("datetime", "date out", "datetimeFormat", c("date"), list(list("1/2/2024"), list("12/31/2025")), list("2024-01-02", "2025-12-31")),
  list("null", "null out", "literal", c("identity"), list(list("one"), list("two")), list(NULL, NULL)),
  list("arithmetic", "arithmetic out", "arithmetic", c("number"), list(list(1L), list(5L)), list(3L, 7L))
)
by_example_revision <- 0L
by_example_last_apply <- NULL
by_example_retained <- list()
for (case in by_example_ast_cases) {
  step <- by_example_step(
    paste0("by-example-", case[[1L]]),
    case[[4L]],
    case[[2L]],
    case[[5L]],
    case[[6L]]
  )
  preview <- dispatch(
    "previewStep",
    list(
      sessionId = by_example_ast_session,
      revision = by_example_revision,
      step = step,
      page = page_window()
    )
  )
  if (identical(preview$kind, "error")) {
    stop(
      sprintf(
        "R by-example %s preview failed with %s: %s",
        case[[3L]],
        preview$code,
        paste0(
          preview$message,
          if (is.null(last_by_example_evaluator_error)) "" else paste0(
            " (evaluator: ",
            conditionMessage(last_by_example_evaluator_error),
            ")"
          )
        )
      ),
      call. = FALSE
    )
  }
  assert_identical(preview$kind, "stepPreview", sprintf("R by-example %s did not preview", case[[3L]]))
  assert_identical(
    preview$retainedStep$params$program$kind,
    case[[3L]],
    sprintf("R by-example synthesis selected the wrong %s AST", case[[3L]])
  )
  assert_identical(
    names(preview$retainedStep),
    c("id", "kind", "params"),
    "R by-example retainedStep leaked a private top-level field"
  )
  retained_wire <- jsonlite::toJSON(preview$retainedStep, auto_unbox = TRUE, null = "null", na = "null")
  by_example_assert(
    !grepl("outputId|_owSource|_owResult|_owLeft|_owRight|position", retained_wire, perl = TRUE),
    "R by-example retainedStep leaked private binding metadata"
  )
  if (identical(case[[1L]], "null")) {
    assert_identical(
      names(preview$retainedStep$params$program),
      c("kind", "value"),
      "R by-example null literal lost its explicit public value field"
    )
    by_example_assert(
      grepl('"program":\\{"kind":"literal","value":null\\}', retained_wire, perl = TRUE),
      "R by-example null literal was not explicit in retained-step JSON"
    )
  }
  by_example_assert(
    is.list(preview$retainedStep$params$warnings) &&
      preview$retainedStep$params$candidateCount >= 1L,
    "R by-example retainedStep omitted warnings or candidateCount"
  )
  if (identical(case[[1L]], "column")) {
    assert_identical(preview$retainedStep$params$candidateCount, 12L, "R direct-column candidate count drifted from Python")
    assert_identical(
      preview$retainedStep$params$warnings,
      list("12 programs match; Open Wrangler selected the simplest deterministic program."),
      "R direct-column deterministic warning drifted from Python"
    )
  }
  if (identical(case[[1L]], "arithmetic")) {
    assert_identical(preview$retainedStep$params$candidateCount, 2L, "R arithmetic candidate count drifted from Python")
    assert_identical(
      preview$retainedStep$params$warnings,
      list("Ambiguous examples: 2 equally simple programs match. Preview the selected result carefully."),
      "R arithmetic ranking warning drifted from Python"
    )
  }
  by_example_retained[[case[[1L]]]] <- preview$retainedStep
  by_example_last_apply <- dispatch(
    "applyDraft",
    list(sessionId = by_example_ast_session, revision = preview$revision, page = page_window())
  )
  assert_identical(by_example_last_apply$action, "apply", sprintf("R by-example %s did not apply", case[[3L]]))
  by_example_revision <- by_example_last_apply$revision
}

by_example_generated_environment <- new.env(parent = baseenv())
assign(
  "by_example_ast",
  unserialize(by_example_ast_before),
  envir = by_example_generated_environment
)
eval(parse(text = by_example_last_apply$code), envir = by_example_generated_environment)
by_example_generated <- get("open_wrangler_result", envir = by_example_generated_environment, inherits = FALSE)
assert_identical(by_example_generated$`literal out`, c("fixed", "fixed"), "generated R literal AST diverged")
assert_identical(by_example_generated$`column out`, c("one", "two"), "generated R column AST diverged")
assert_identical(by_example_generated$`slice out`, c("β", "😀"), "generated R Unicode slice AST diverged")
assert_identical(by_example_generated$`split out`, c("bb", "dd"), "generated R split AST diverged")
assert_identical(by_example_generated$`concat out`, c("Ann Lee", "Bo Li"), "generated R concat AST diverged")
assert_identical(
  by_example_generated$`regex out`,
  c("١٢", newest_decimal_run),
  "generated R Unicode regex AST diverged"
)
assert_identical(by_example_generated$`replace out`, c("aa-new-zz", "bbbb-new-y"), "generated R regex replacement AST diverged")
assert_identical(by_example_generated$`case out`, c("abc", "def"), "generated R ASCII case AST diverged")
assert_identical(by_example_generated$`capitalize out`, c("Alpha", "Beta"), "generated R capitalize AST diverged")
assert_identical(by_example_generated$`date out`, c("2024-01-02", "2025-12-31"), "generated R datetime AST diverged")
assert_identical(by_example_generated$`null out`, c(NA, NA), "generated R null literal AST changed type")
assert_identical(
  get("as.character.integer64", envir = asNamespace("bit64"), inherits = FALSE)(by_example_generated$`arithmetic out`),
  c("3", "7"),
  "generated R exact arithmetic AST diverged"
)
assert_identical(
  serialize(get("by_example_ast", envir = by_example_generated_environment), NULL, version = 3L),
  by_example_ast_before,
  "generated R by-example AST plan mutated its source"
)
assert_identical(
  serialize(source_environment$by_example_ast, NULL, version = 3L),
  by_example_ast_before,
  "live R by-example AST plan mutated its source"
)

by_example_inspection <- inspect_step(
  by_example_ast_session,
  by_example_revision,
  "by-example-arithmetic",
  page_window()
)
assert_schema_less_inspection(by_example_inspection, "R by-example inspection")
assert_identical(
  tail(by_example_inspection$outputPage$page$columnIds, 1L),
  list("c:step:by-example-arithmetic:0"),
  "R by-example inspection lost its stable output identity"
)

edited_arithmetic <- by_example_step(
  "by-example-arithmetic",
  "number",
  "arithmetic edited",
  list(list(1L), list(5L)),
  list(4L, 8L)
)
edited_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_ast_session,
    revision = by_example_revision,
    step = edited_arithmetic,
    replaceStepId = "by-example-arithmetic",
    page = page_window()
  )
)
assert_identical(edited_preview$kind, "stepPreview", "the latest R by-example step could not be edited")
assert_identical(
  tail(edited_preview$page$schema, 1L)[[1L]]$id,
  "c:step:by-example-arithmetic:0",
  "editing R by-example regenerated its stable output identity"
)
edited_apply <- dispatch(
  "applyDraft",
  list(sessionId = by_example_ast_session, revision = edited_preview$revision, page = page_window())
)
assert_identical(edited_apply$action, "apply", "the edited R by-example step did not apply")
by_example_revision <- edited_apply$revision
edited_environment <- new.env(parent = baseenv())
assign("by_example_ast", unserialize(by_example_ast_before), envir = edited_environment)
eval(parse(text = edited_apply$code), envir = edited_environment)
assert_identical(
  get("as.character.integer64", envir = asNamespace("bit64"), inherits = FALSE)(
    get("open_wrangler_result", envir = edited_environment)$`arithmetic edited`
  ),
  c("4", "8"),
  "generated R edited by-example replay diverged"
)
by_example_undo <- dispatch(
  "undoStep",
  list(sessionId = by_example_ast_session, revision = by_example_revision, page = page_window())
)
assert_identical(by_example_undo$action, "undo", "the edited R by-example step did not undo")
by_example_assert(
  !"c:step:by-example-arithmetic:0" %in% unlist(by_example_undo$page$page$columnIds, use.names = FALSE),
  "undo retained the edited R by-example output"
)
by_example_revision <- by_example_undo$revision

float_wire_step <- by_example_step(
  "by-example-float-wire",
  "decimal",
  "float wire out",
  list(list(1.5), list(2.5)),
  list(2.5, 3.5)
)
float_wire_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_ast_session,
    revision = by_example_revision,
    step = float_wire_step,
    page = page_window()
  )
)
assert_identical(float_wire_preview$kind, "stepPreview", "whole float literal synthesis did not preview")
assert_identical(
  float_wire_preview$retainedStep$params$program$right$value,
  1L,
  "whole float literal synthesis did not canonicalize its wire representation"
)
float_wire_discard <- dispatch(
  "discardDraft",
  list(sessionId = by_example_ast_session, revision = float_wire_preview$revision, page = page_window())
)
float_wire_replay <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_ast_session,
    revision = float_wire_discard$revision,
    step = float_wire_preview$retainedStep,
    page = page_window()
  )
)
assert_identical(
  float_wire_replay$kind,
  "stepPreview",
  "a retained whole float literal did not survive preview-to-replay JSON"
)
float_wire_apply <- dispatch(
  "applyDraft",
  list(sessionId = by_example_ast_session, revision = float_wire_replay$revision, page = page_window())
)
float_wire_environment <- new.env(parent = baseenv())
assign("by_example_ast", unserialize(by_example_ast_before), envir = float_wire_environment)
eval(parse(text = float_wire_apply$code), envir = float_wire_environment)
assert_identical(
  get("open_wrangler_result", envir = float_wire_environment)$`float wire out`,
  c(2.5, 3.5),
  "generated R whole-float-literal replay diverged"
)
invisible(dispatch("closeSession", list(sessionId = by_example_ast_session)))

# Direct leaves preserve portable native attributes across every supported
# editing dataframe family, both live and in standalone generated code.
by_example_flavor_base <- data.frame(
  marker = c("b", "a"),
  category = ordered(c("alpha", "beta"), levels = c("unused", "alpha", "beta")),
  elapsed = as.difftime(c(1, 2), units = "mins"),
  check.names = FALSE,
  row.names = c("flavor-b", "flavor-a")
)
by_example_flavor_table <- data.table::as.data.table(by_example_flavor_base)
data.table::setkey(by_example_flavor_table, marker)
by_example_flavor_qdt <- collapse::qDT(by_example_flavor_base)
data.table::setkey(by_example_flavor_qdt, marker)
by_example_flavors <- list(
  by_example_flavor_base,
  tibble::as_tibble(by_example_flavor_base, .name_repair = "minimal"),
  by_example_flavor_table,
  collapse::qDF(by_example_flavor_base),
  collapse::qTBL(by_example_flavor_base),
  by_example_flavor_qdt
)
by_example_flavor_sessions <- c(
  "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
  "d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2",
  "d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3",
  "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4",
  "d5d5d5d5-d5d5-45d5-85d5-d5d5d5d5d5d5",
  "d6d6d6d6-d6d6-46d6-86d6-d6d6d6d6d6d6"
)
for (flavor_index in seq_along(by_example_flavors)) {
  variable_name <- sprintf("by_example_flavor_%d", flavor_index)
  source <- by_example_flavors[[flavor_index]]
  source_environment[[variable_name]] <- source
  source_before <- if (inherits(source, "data.table")) data.table::copy(source) else unserialize(serialize(source, NULL, version = 3L))
  session <- by_example_flavor_sessions[[flavor_index]]
  opened <- dispatch(
    "openSession",
    list(sessionId = session, variableName = variable_name, page = page_window())
  )
  assert_identical(opened$kind, "page", sprintf("R by-example flavor %d did not open", flavor_index))
  revision <- 0L
  factor_step <- list(
    id = sprintf("by-example-flavor-factor-%d", flavor_index),
    kind = "byExample",
    params = list(
      sourceColumns = I(list(list(id = "r:c:1", name = "category"))),
      newColumn = "category copy",
      examples = I(list(
        list(inputs = I(list("alpha")), output = "alpha"),
        list(inputs = I(list("beta")), output = "beta")
      ))
    )
  )
  factor_preview <- dispatch(
    "previewStep",
    list(sessionId = session, revision = revision, step = factor_step, page = page_window())
  )
  assert_identical(factor_preview$kind, "stepPreview", sprintf("R factor direct flavor %d did not preview", flavor_index))
  assert_identical(
    tail(factor_preview$page$schema, 1L)[[1L]]$rawType,
    "ordered factor",
    sprintf("R factor direct flavor %d lost its raw type", flavor_index)
  )
  factor_apply <- dispatch(
    "applyDraft",
    list(sessionId = session, revision = factor_preview$revision, page = page_window())
  )
  revision <- factor_apply$revision
  difftime_step <- list(
    id = sprintf("by-example-flavor-difftime-%d", flavor_index),
    kind = "byExample",
    params = list(
      sourceColumns = I(list(list(id = "r:c:2", name = "elapsed"))),
      newColumn = "elapsed copy",
      examples = I(list(
        list(inputs = I(list(1L)), output = 1L),
        list(inputs = I(list(2L)), output = 2L)
      ))
    )
  )
  difftime_preview <- dispatch(
    "previewStep",
    list(sessionId = session, revision = revision, step = difftime_step, page = page_window())
  )
  assert_identical(difftime_preview$kind, "stepPreview", sprintf("R difftime direct flavor %d did not preview", flavor_index))
  assert_identical(
    tail(difftime_preview$page$schema, 1L)[[1L]]$rawType,
    "difftime",
    sprintf("R difftime direct flavor %d lost its raw type", flavor_index)
  )
  flavor_apply <- dispatch(
    "applyDraft",
    list(sessionId = session, revision = difftime_preview$revision, page = page_window())
  )
  generated_environment <- new.env(parent = baseenv())
  assign(variable_name, source_before, envir = generated_environment)
  eval(parse(text = flavor_apply$code), envir = generated_environment)
  generated <- get("open_wrangler_result", envir = generated_environment, inherits = FALSE)
  assert_identical(class(generated), class(source_before), sprintf("generated by-example flavor %d changed class", flavor_index))
  assert_identical(
    generated[["category copy"]],
    source_before[["category"]],
    sprintf("generated by-example flavor %d lost ordered-factor attributes", flavor_index)
  )
  assert_identical(
    generated[["elapsed copy"]],
    source_before[["elapsed"]],
    sprintf("generated by-example flavor %d lost difftime units", flavor_index)
  )
  assert_identical(
    attr(generated, "row.names", exact = TRUE),
    attr(source_before, "row.names", exact = TRUE),
    sprintf("generated by-example flavor %d changed row names", flavor_index)
  )
  if (inherits(source_before, "data.table")) {
    assert_identical(
      data.table::key(generated),
      data.table::key(source_before),
      sprintf("generated by-example flavor %d changed its data.table key", flavor_index)
    )
  }
  assert_identical(
    source_environment[[variable_name]],
    source_before,
    sprintf("live by-example flavor %d mutated its source", flavor_index)
  )
  assert_identical(
    get(variable_name, envir = generated_environment, inherits = FALSE),
    source_before,
    sprintf("generated by-example flavor %d mutated its source", flavor_index)
  )
  invisible(dispatch("closeSession", list(sessionId = session)))
}

# Direct-copy output names are rebuilt after semantic attributes. This order is
# observable to later custom code and must match the chunked live helper.
by_example_named_value <- function(storage, semantic_attributes = list()) {
  attributes(storage) <- c(list(names = c("left", "right")), semantic_attributes)
  storage
}
by_example_attribute_order_source <- structure(
  list(
    text = by_example_named_value(c("alpha", "beta")),
    category = by_example_named_value(
      c(1L, 2L),
      list(levels = I(c("first", "second")), class = c("ordered", "factor"))
    ),
    wide = by_example_named_value(
      unclass(bit64::as.integer64(c("1", "2"))),
      list(class = "integer64")
    ),
    day = by_example_named_value(c(19723, 19724), list(class = "Date")),
    instant = by_example_named_value(
      c(1, 2),
      list(class = c("POSIXct", "POSIXt"), tzone = I("UTC"))
    ),
    elapsed = by_example_named_value(
      c(1, 2),
      list(class = "difftime", units = I("mins"))
    )
  ),
  names = c("text", "category", "wide", "day", "instant", "elapsed"),
  class = "data.frame",
  row.names = c(NA_integer_, -2L)
)
by_example_attribute_order_before <- serialize(
  by_example_attribute_order_source,
  NULL,
  version = 3L
)
source_environment$by_example_attribute_order <- by_example_attribute_order_source
by_example_attribute_order_session <- "a6b6c6d6-a6b6-46d6-86b6-a6b6c6d6e6f6"
by_example_attribute_order_open <- dispatch(
  "openSession",
  list(
    sessionId = by_example_attribute_order_session,
    variableName = "by_example_attribute_order",
    page = page_window()
  )
)
assert_identical(
  by_example_attribute_order_open$kind,
  "page",
  "the by-example attribute-order source did not open"
)
by_example_attribute_order_specs <- list(
  list(name = "text", kind = "character", inputs = c("alpha", "beta")),
  list(name = "category", kind = "factor", inputs = c("first", "second")),
  list(name = "wide", kind = "integer64", inputs = list(1L, 2L)),
  list(name = "day", kind = "date", inputs = c("2024-01-01", "2024-01-02")),
  list(
    name = "instant",
    kind = "datetime",
    inputs = c("1970-01-01T00:00:01Z", "1970-01-01T00:00:02Z")
  ),
  list(name = "elapsed", kind = "difftime", inputs = list(1L, 2L))
)
by_example_attribute_order_revision <- 0L
by_example_attribute_order_apply <- NULL
for (attribute_order_index in seq_along(by_example_attribute_order_specs)) {
  attribute_order_spec <- by_example_attribute_order_specs[[attribute_order_index]]
  attribute_order_inputs <- attribute_order_spec$inputs
  attribute_order_step <- list(
    id = sprintf("by-example-attribute-order-%d", attribute_order_index),
    kind = "byExample",
    params = list(
      sourceColumns = I(list(list(
        id = sprintf("r:c:%d", attribute_order_index - 1L),
        name = attribute_order_spec$name
      ))),
      newColumn = paste0(attribute_order_spec$name, " copy"),
      examples = I(lapply(seq_along(attribute_order_inputs), function(row_index) {
        item <- attribute_order_inputs[[row_index]]
        list(inputs = I(list(item)), output = item)
      }))
    )
  )
  attribute_order_preview <- dispatch(
    "previewStep",
    list(
      sessionId = by_example_attribute_order_session,
      revision = by_example_attribute_order_revision,
      step = attribute_order_step,
      page = page_window()
    )
  )
  assert_identical(
    attribute_order_preview$kind,
    "stepPreview",
    sprintf("live direct %s attribute-order preview failed", attribute_order_spec$kind)
  )
  by_example_attribute_order_apply <- dispatch(
    "applyDraft",
    list(
      sessionId = by_example_attribute_order_session,
      revision = attribute_order_preview$revision,
      page = page_window()
    )
  )
  by_example_attribute_order_revision <- by_example_attribute_order_apply$revision
}
restore_by_example_column_attributes <- function(frame, original) {
  for (column_index in seq_len(length(base::unclass(original)))) {
    target <- base::.subset2(frame, column_index)
    target_attribute_names <- names(attributes(target))
    if (!is.null(target_attribute_names)) {
      for (attribute_name in target_attribute_names) {
        data.table::setattr(target, attribute_name, NULL)
      }
    }
    original_attributes <- attributes(base::.subset2(original, column_index))
    if (!is.null(original_attributes)) {
      for (attribute_name in names(original_attributes)) {
        data.table::setattr(
          target,
          attribute_name,
          base::.subset2(original_attributes, attribute_name)
        )
      }
    }
  }
  frame
}
by_example_attribute_order_table <- restore_by_example_column_attributes(
  data.table::as.data.table(unserialize(by_example_attribute_order_before)),
  unserialize(by_example_attribute_order_before)
)
by_example_attribute_order_qdt <- restore_by_example_column_attributes(
  collapse::qDT(unserialize(by_example_attribute_order_before)),
  unserialize(by_example_attribute_order_before)
)
by_example_attribute_order_sources <- list(
  unserialize(by_example_attribute_order_before),
  by_example_attribute_order_table,
  by_example_attribute_order_qdt
)
for (attribute_order_flavor in seq_along(by_example_attribute_order_sources)) {
  attribute_order_source <- by_example_attribute_order_sources[[attribute_order_flavor]]
  attribute_order_source_before <- serialize(attribute_order_source, NULL, version = 3L)
  attribute_order_expected <- attribute_order_source
  for (attribute_order_index in seq_along(by_example_attribute_order_specs)) {
    attribute_order_spec <- by_example_attribute_order_specs[[attribute_order_index]]
    attribute_order_expected <- real_by_example_column_at(
      attribute_order_expected,
      attribute_order_index,
      attribute_order_spec$name,
      paste0(attribute_order_spec$name, " copy"),
      attribute_order_spec$kind,
      function(columns) columns[[1L]]
    )
  }
  attribute_order_environment <- new.env(parent = baseenv())
  assign(
    "by_example_attribute_order",
    attribute_order_source,
    envir = attribute_order_environment
  )
  eval(parse(text = by_example_attribute_order_apply$code), envir = attribute_order_environment)
  attribute_order_generated <- get(
    "open_wrangler_result",
    envir = attribute_order_environment,
    inherits = FALSE
  )
  for (attribute_order_spec in by_example_attribute_order_specs) {
    output_name <- paste0(attribute_order_spec$name, " copy")
    assert_identical(
      names(attributes(attribute_order_generated[[output_name]])),
      names(attributes(attribute_order_expected[[output_name]])),
      sprintf(
        "generated flavor %d changed direct %s attribute order",
        attribute_order_flavor,
        attribute_order_spec$kind
      )
    )
    assert_identical(
      serialize(attribute_order_generated[[output_name]], NULL, version = 3L),
      serialize(attribute_order_expected[[output_name]], NULL, version = 3L),
      sprintf(
        "generated flavor %d diverged from live direct %s serialization",
        attribute_order_flavor,
        attribute_order_spec$kind
      )
    )
  }
  assert_identical(
    serialize(
      get("by_example_attribute_order", envir = attribute_order_environment, inherits = FALSE),
      NULL,
      version = 3L
    ),
    attribute_order_source_before,
    sprintf("generated flavor %d mutated its attribute-order source", attribute_order_flavor)
  )
}
assert_identical(
  serialize(source_environment$by_example_attribute_order, NULL, version = 3L),
  by_example_attribute_order_before,
  "live by-example mutated its attribute-order source"
)
invisible(dispatch("closeSession", list(sessionId = by_example_attribute_order_session)))

# Standalone direct-copy code mirrors the live helper's nested semantic
# metadata contract: exact AsIs wrappers are retained, arbitrary payloads fail.
by_example_metadata_source <- collapse::qDT(by_example_flavor_base)
data.table::setkey(by_example_metadata_source, marker)
valid_factor_levels <- I(c("unused", "alpha", "beta"))
valid_duration_units <- I("mins")
data.table::setattr(base::.subset2(by_example_metadata_source, 2L), "levels", valid_factor_levels)
data.table::setattr(base::.subset2(by_example_metadata_source, 3L), "units", valid_duration_units)
by_example_assert(
  identical(attr(base::.subset2(by_example_metadata_source, 2L), "levels", exact = TRUE), valid_factor_levels) &&
    identical(attr(base::.subset2(by_example_metadata_source, 3L), "units", exact = TRUE), valid_duration_units),
  "the generated semantic-metadata fixture lost its AsIs wrappers"
)
metadata_source_before <- serialize(by_example_metadata_source, NULL, version = 3L)
metadata_environment <- new.env(parent = baseenv())
assign("by_example_flavor_6", by_example_metadata_source, envir = metadata_environment)
eval(parse(text = flavor_apply$code), envir = metadata_environment)
metadata_generated <- get("open_wrangler_result", envir = metadata_environment, inherits = FALSE)
assert_identical(
  attr(metadata_generated$`category copy`, "levels", exact = TRUE),
  valid_factor_levels,
  "generated direct factor copy lost valid AsIs levels"
)
assert_identical(
  attr(metadata_generated$`elapsed copy`, "units", exact = TRUE),
  valid_duration_units,
  "generated direct difftime copy lost valid AsIs units"
)
assert_identical(
  serialize(get("by_example_flavor_6", envir = metadata_environment), NULL, version = 3L),
  metadata_source_before,
  "generated valid semantic-metadata evaluation mutated its source"
)

invalid_factor_source <- unserialize(metadata_source_before)
invalid_factor_levels <- c("unused", "alpha", "beta")
attr(invalid_factor_levels, "payload") <- as.raw(1L)
data.table::setattr(base::.subset2(invalid_factor_source, 2L), "levels", invalid_factor_levels)
invalid_factor_before <- serialize(invalid_factor_source, NULL, version = 3L)
invalid_factor_environment <- new.env(parent = baseenv())
assign("by_example_flavor_6", invalid_factor_source, envir = invalid_factor_environment)
invalid_factor_error <- tryCatch(
  {
    eval(parse(text = flavor_apply$code), envir = invalid_factor_environment)
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(invalid_factor_error, "error") &&
    grepl("nested attributes", conditionMessage(invalid_factor_error), fixed = TRUE),
  "generated direct factor copy accepted nested level payloads"
)
assert_identical(
  serialize(get("by_example_flavor_6", envir = invalid_factor_environment), NULL, version = 3L),
  invalid_factor_before,
  "failed generated factor-metadata validation mutated its source"
)

invalid_duration_source <- unserialize(metadata_source_before)
invalid_duration_units <- "mins"
attr(invalid_duration_units, "payload") <- as.raw(1L)
data.table::setattr(base::.subset2(invalid_duration_source, 3L), "units", invalid_duration_units)
invalid_duration_before <- serialize(invalid_duration_source, NULL, version = 3L)
invalid_duration_environment <- new.env(parent = baseenv())
assign("by_example_flavor_6", invalid_duration_source, envir = invalid_duration_environment)
invalid_duration_error <- tryCatch(
  {
    eval(parse(text = flavor_apply$code), envir = invalid_duration_environment)
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(invalid_duration_error, "error") &&
    grepl("nested attributes", conditionMessage(invalid_duration_error), fixed = TRUE),
  "generated direct difftime copy accepted nested units payloads"
)
assert_identical(
  serialize(get("by_example_flavor_6", envir = invalid_duration_environment), NULL, version = 3L),
  invalid_duration_before,
  "failed generated duration-metadata validation mutated its source"
)

by_example_posix_lengths <- c(0L, 1L, 2051L)
by_example_posix_sessions <- c(
  "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1",
  "e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2",
  "e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3"
)
for (posix_index in seq_along(by_example_posix_lengths)) {
  row_count <- by_example_posix_lengths[[posix_index]]
  seconds <- if (row_count == 0L) numeric() else as.double(seq_len(row_count))
  instant <- structure(seconds, class = c("POSIXct", "POSIXt"))
  by_example_assert(is.null(attr(instant, "tzone", exact = TRUE)), "the class-only POSIXct fixture gained a timezone")
  variable_name <- sprintf("by_example_posix_%d", posix_index)
  source_environment[[variable_name]] <- data.frame(instant = instant, check.names = FALSE)
  source_before <- unserialize(serialize(source_environment[[variable_name]], NULL, version = 3L))
  session <- by_example_posix_sessions[[posix_index]]
  opened <- dispatch(
    "openSession",
    list(sessionId = session, variableName = variable_name, page = page_window())
  )
  assert_identical(opened$kind, "page", sprintf("class-only POSIXct size %d did not open", row_count))
  step <- list(
    id = sprintf("by-example-posix-%d", posix_index),
    kind = "byExample",
    params = list(
      sourceColumns = I(list(list(id = "r:c:0", name = "instant"))),
      newColumn = "instant copy",
      examples = I(list(
        list(inputs = I(list("2024-01-01T00:00:01Z")), output = "2024-01-01T00:00:01Z"),
        list(inputs = I(list("2024-01-01T00:00:02Z")), output = "2024-01-01T00:00:02Z")
      ))
    )
  )
  preview <- dispatch(
    "previewStep",
    list(sessionId = session, revision = 0L, step = step, page = page_window())
  )
  assert_identical(preview$kind, "stepPreview", sprintf("class-only POSIXct size %d did not preview", row_count))
  assert_identical(
    tail(preview$page$schema, 1L)[[1L]]$rawType,
    "POSIXct",
    sprintf("class-only POSIXct size %d lost its raw type", row_count)
  )
  applied <- dispatch(
    "applyDraft",
    list(sessionId = session, revision = preview$revision, page = page_window())
  )
  generated_environment <- new.env(parent = baseenv())
  assign(variable_name, source_before, envir = generated_environment)
  eval(parse(text = applied$code), envir = generated_environment)
  generated <- get("open_wrangler_result", envir = generated_environment, inherits = FALSE)
  assert_identical(
    generated[["instant copy"]],
    source_before$instant,
    sprintf("generated class-only POSIXct size %d changed values or attributes", row_count)
  )
  by_example_assert(
    is.null(attr(generated[["instant copy"]], "tzone", exact = TRUE)),
    sprintf("generated class-only POSIXct size %d invented a timezone", row_count)
  )
  assert_identical(
    source_environment[[variable_name]],
    source_before,
    sprintf("live class-only POSIXct size %d mutated its source", row_count)
  )
  assert_identical(
    get(variable_name, envir = generated_environment, inherits = FALSE),
    source_before,
    sprintf("generated class-only POSIXct size %d mutated its source", row_count)
  )
  invisible(dispatch("closeSession", list(sessionId = session)))
}

valid_datetime_timezone <- I("UTC")
valid_datetime_source <- structure(
  list(instant = structure(c(1, 2), class = c("POSIXct", "POSIXt"), tzone = valid_datetime_timezone)),
  names = "instant",
  class = "data.frame",
  row.names = c("datetime-a", "datetime-b")
)
valid_datetime_before <- serialize(valid_datetime_source, NULL, version = 3L)
valid_datetime_environment <- new.env(parent = baseenv())
assign("by_example_posix_3", valid_datetime_source, envir = valid_datetime_environment)
eval(parse(text = applied$code), envir = valid_datetime_environment)
valid_datetime_generated <- get("open_wrangler_result", envir = valid_datetime_environment, inherits = FALSE)
assert_identical(
  attr(valid_datetime_generated$`instant copy`, "tzone", exact = TRUE),
  valid_datetime_timezone,
  "generated direct datetime copy lost a valid AsIs timezone"
)
assert_identical(
  serialize(get("by_example_posix_3", envir = valid_datetime_environment), NULL, version = 3L),
  valid_datetime_before,
  "generated valid datetime metadata evaluation mutated its source"
)

invalid_datetime_timezone <- "UTC"
attr(invalid_datetime_timezone, "payload") <- as.raw(1L)
invalid_datetime_source <- structure(
  list(instant = structure(c(1, 2), class = c("POSIXct", "POSIXt"), tzone = invalid_datetime_timezone)),
  names = "instant",
  class = "data.frame",
  row.names = c("datetime-a", "datetime-b")
)
invalid_datetime_before <- serialize(invalid_datetime_source, NULL, version = 3L)
invalid_datetime_environment <- new.env(parent = baseenv())
assign("by_example_posix_3", invalid_datetime_source, envir = invalid_datetime_environment)
invalid_datetime_error <- tryCatch(
  {
    eval(parse(text = applied$code), envir = invalid_datetime_environment)
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(invalid_datetime_error, "error") &&
    grepl("nested attributes", conditionMessage(invalid_datetime_error), fixed = TRUE),
  "generated direct datetime copy accepted nested timezone payloads"
)
assert_identical(
  serialize(get("by_example_posix_3", envir = invalid_datetime_environment), NULL, version = 3L),
  invalid_datetime_before,
  "failed generated datetime-metadata validation mutated its source"
)

# Unseen rows follow the editing-engine execution contract: invalid datetime
# text coerces to missing, while double NaN and infinities remain typed values.
source_environment$by_example_nonfinite <- data.frame(
  date_text = c("1/2/2024", "not-a-date", NA_character_),
  numerator = c(1, Inf, NaN),
  denominator = c(0, 2, 0),
  check.names = FALSE,
  row.names = c("finite-a", "finite-b", "finite-c")
)
by_example_nonfinite_before <- serialize(
  source_environment$by_example_nonfinite,
  NULL,
  version = 3L
)
by_example_nonfinite_session <- "edededed-eded-4ded-8ded-edededededed"
nonfinite_open <- dispatch(
  "openSession",
  list(
    sessionId = by_example_nonfinite_session,
    variableName = "by_example_nonfinite",
    page = page_window()
  )
)
assert_identical(nonfinite_open$kind, "page", "the non-finite by-example session did not open")

nonfinite_date_step <- list(
  id = "by-example-unseen-date",
  kind = "byExample",
  params = list(
    sourceColumns = I(list(list(id = "r:c:0", name = "date_text"))),
    newColumn = "parsed date",
    examples = I(list(
      list(inputs = I(list("1/2/2024")), output = "2024-01-02"),
      list(inputs = I(list("12/31/2025")), output = "2025-12-31")
    ))
  )
)
nonfinite_date_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_nonfinite_session,
    revision = 0L,
    step = nonfinite_date_step,
    page = page_window()
  )
)
assert_identical(nonfinite_date_preview$kind, "stepPreview", "unseen invalid datetime text failed the live preview")
nonfinite_date_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = by_example_nonfinite_session,
    revision = nonfinite_date_preview$revision,
    page = page_window()
  )
)

nonfinite_direct_step <- list(
  id = "by-example-unseen-direct-double",
  kind = "byExample",
  params = list(
    sourceColumns = I(list(list(id = "r:c:1", name = "numerator"))),
    newColumn = "numerator copy",
    examples = I(list(
      list(inputs = I(list(1.25)), output = 1.25),
      list(inputs = I(list(2.5)), output = 2.5)
    ))
  )
)
nonfinite_direct_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_nonfinite_session,
    revision = nonfinite_date_apply$revision,
    step = nonfinite_direct_step,
    page = page_window()
  )
)
assert_identical(nonfinite_direct_preview$kind, "stepPreview", "direct double by-example rejected non-finite source rows")
nonfinite_direct_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = by_example_nonfinite_session,
    revision = nonfinite_direct_preview$revision,
    page = page_window()
  )
)

nonfinite_divide_step <- list(
  id = "by-example-unseen-divide",
  kind = "byExample",
  params = list(
    sourceColumns = I(list(
      list(id = "r:c:1", name = "numerator"),
      list(id = "r:c:2", name = "denominator")
    )),
    newColumn = "quotient",
    examples = I(list(
      list(inputs = I(list(4, 2)), output = 2),
      list(inputs = I(list(9, 2)), output = 4.5)
    ))
  )
)
nonfinite_divide_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_nonfinite_session,
    revision = nonfinite_direct_apply$revision,
    step = nonfinite_divide_step,
    page = page_window()
  )
)
assert_identical(nonfinite_divide_preview$kind, "stepPreview", "double by-example division rejected zero/non-finite unseen rows")
nonfinite_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = by_example_nonfinite_session,
    revision = nonfinite_divide_preview$revision,
    page = page_window()
  )
)

nonfinite_rows <- nonfinite_apply$page$page$rows
assert_identical(nonfinite_rows[[1L]]$values[[4L]]$raw, "2024-01-02", "live datetime formatting changed a valid row")
assert_identical(nonfinite_rows[[2L]]$values[[4L]]$isNull, TRUE, "live datetime formatting did not coerce invalid text")
assert_identical(nonfinite_rows[[3L]]$values[[4L]]$isNull, TRUE, "live datetime formatting did not retain source missingness")
assert_identical(nonfinite_rows[[2L]]$values[[5L]]$kind, "infinity", "a live direct double lost infinity")
assert_identical(nonfinite_rows[[3L]]$values[[5L]]$kind, "nan", "a live direct double lost NaN")
assert_identical(nonfinite_rows[[1L]]$values[[6L]]$kind, "infinity", "live zero-denominator division did not produce infinity")
assert_identical(nonfinite_rows[[2L]]$values[[6L]]$kind, "infinity", "live division lost an infinite input")
assert_identical(nonfinite_rows[[3L]]$values[[6L]]$kind, "nan", "live division lost a NaN input")

nonfinite_environment <- new.env(parent = baseenv())
assign(
  "by_example_nonfinite",
  unserialize(by_example_nonfinite_before),
  envir = nonfinite_environment
)
eval(parse(text = nonfinite_apply$code), envir = nonfinite_environment)
nonfinite_generated <- get("open_wrangler_result", envir = nonfinite_environment, inherits = FALSE)
assert_identical(
  nonfinite_generated$`parsed date`,
  c("2024-01-02", NA_character_, NA_character_),
  "generated datetime formatting diverged on invalid/unseen rows"
)
assert_identical(
  nonfinite_generated$`numerator copy`,
  c(1, Inf, NaN),
  "generated direct double lost NaN or infinity"
)
by_example_assert(
  is.infinite(nonfinite_generated$quotient[[1L]]) &&
    is.infinite(nonfinite_generated$quotient[[2L]]) &&
    is.nan(nonfinite_generated$quotient[[3L]]),
  "generated double division lost zero-denominator or non-finite semantics"
)
assert_identical(
  serialize(source_environment$by_example_nonfinite, NULL, version = 3L),
  by_example_nonfinite_before,
  "live non-finite by-example evaluation mutated its source"
)
assert_identical(
  serialize(get("by_example_nonfinite", envir = nonfinite_environment), NULL, version = 3L),
  by_example_nonfinite_before,
  "generated non-finite by-example evaluation mutated its source"
)
invisible(dispatch("closeSession", list(sessionId = by_example_nonfinite_session)))

by_example_bound_column <- function(kind, index = 1L) {
  list(
    kind = "column",
    column = list(id = sprintf("r:c:%d", index - 1L), name = sprintf("source-%d", index)),
    `_owSourceIndex` = as.integer(index),
    `_owSourceKind` = kind,
    `_owResultType` = kind
  )
}
by_example_bound_literal <- function(value, kind) {
  list(kind = "literal", value = value, `_owResultType` = kind)
}
by_example_bound_arithmetic <- function(operator, left, right, result_kind) {
  list(
    kind = "arithmetic",
    left = left,
    operator = operator,
    right = right,
    `_owLeftType` = left$`_owResultType`,
    `_owRightType` = right$`_owResultType`,
    `_owResultType` = result_kind
  )
}
integer64_character <- get("as.character.integer64", envir = asNamespace("bit64"), inherits = FALSE)
integer64_double <- get("as.double.integer64", envir = asNamespace("bit64"), inherits = FALSE)
by_example_checked_integer_text <- get(
  "by_example_checked_integer_text",
  envir = by_example_agent_environment,
  inherits = FALSE
)
by_example_integer64_text <- get(
  "by_example_integer64_text",
  envir = by_example_agent_environment,
  inherits = FALSE
)
maximum_decimal_integer <- paste0(rep.int("9", 38L), collapse = "")
assert_identical(
  by_example_checked_integer_text(maximum_decimal_integer),
  maximum_decimal_integer,
  "R by-example changed the shared 38-digit arithmetic envelope"
)
decimal_overflow <- tryCatch(
  {
    by_example_checked_integer_text(paste0("1", paste0(rep.int("0", 38L), collapse = "")))
    NULL
  },
  error = function(error) error
)
by_example_assert(inherits(decimal_overflow, "error"), "R by-example accepted arithmetic above 10^38 - 1")
native_representation_error <- tryCatch(
  {
    by_example_integer64_text(maximum_decimal_integer)
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(native_representation_error, "error"),
  "R by-example silently coerced an unrepresentable 38-digit integer"
)
integer64_boundary <- bit64::as.integer64(c("9223372036854775807", "-9223372036854775807"))
integer64_column <- by_example_bound_column("integer64")
integer64_zero <- by_example_bound_literal(0L, "integer")
integer64_one <- by_example_bound_literal(1L, "integer")
cancelled <- by_example_evaluator(
  by_example_bound_arithmetic("subtract", integer64_column, integer64_column, "integer64"),
  list(integer64_boundary)
)
assert_identical(integer64_character(cancelled), c("0", "0"), "exact by-example cancellation lost integer64 precision")
zeroed <- by_example_evaluator(
  by_example_bound_arithmetic("multiply", integer64_column, integer64_zero, "integer64"),
  list(integer64_boundary)
)
assert_identical(integer64_character(zeroed), c("0", "0"), "exact by-example zero multiplication overflowed")
division <- by_example_evaluator(
  by_example_bound_arithmetic("divide", integer64_column, integer64_one, "double"),
  list(integer64_boundary)
)
assert_identical(
  division,
  integer64_double(integer64_boundary),
  "integer64 by-example division incorrectly required an exact double round trip"
)
overflow_error <- tryCatch(
  {
    by_example_evaluator(
      by_example_bound_arithmetic("add", integer64_column, integer64_one, "integer64"),
      list(integer64_boundary[1L])
    )
    NULL
  },
  error = function(error) error
)
by_example_assert(inherits(overflow_error, "error"), "exact by-example addition silently overflowed integer64")

slot_preflight_bad_column <- by_example_bound_column("integer", 2L)
slot_preflight_program <- by_example_bound_arithmetic(
  "add",
  slot_preflight_bad_column,
  by_example_bound_literal(1L, "integer"),
  "integer64"
)
slot_preflight_error <- tryCatch(
  {
    by_example_evaluator(slot_preflight_program, list(seq_len(9000000L)))
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(slot_preflight_error, "error") && grepl("aggregate output budget", conditionMessage(slot_preflight_error), fixed = TRUE),
  "standalone by-example evaluation reached its invalid AST before fixed-slot preflight"
)
oversized_case_program <- list(
  kind = "case",
  style = "lower",
  input = by_example_bound_column("character"),
  `_owResultType` = "character"
)
oversized_case_error <- tryCatch(
  {
    by_example_evaluator(oversized_case_program, list(paste0(rep.int("A", 8193L), collapse = "")))
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(oversized_case_error, "error") && grepl("oversized text", conditionMessage(oversized_case_error), fixed = TRUE),
  "by-example case conversion allocated an oversized transformed cell"
)
oversized_split_program <- list(
  kind = "split",
  input = by_example_bound_column("character"),
  delimiter = "--",
  index = 0L,
  `_owResultType` = "character"
)
oversized_split_error <- tryCatch(
  {
    by_example_evaluator(
      oversized_split_program,
      list(paste0(paste0(rep.int("A", 9000L), collapse = ""), "--tail"))
    )
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(oversized_split_error, "error") && grepl("oversized text", conditionMessage(oversized_split_error), fixed = TRUE),
  "by-example split constructed an oversized selected span"
)
oversized_regex_program <- list(
  kind = "regexExtract",
  input = by_example_bound_column("character"),
  pattern = "(.*)",
  group = 1L,
  `_owResultType` = "character"
)
oversized_regex_error <- tryCatch(
  {
    by_example_evaluator(
      oversized_regex_program,
      list(paste0(rep.int("A", 9000L), collapse = ""))
    )
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(oversized_regex_error, "error") && grepl("oversized text", conditionMessage(oversized_regex_error), fixed = TRUE),
  "by-example regex extraction materialized an oversized captured group"
)

latin1_repeated_text <- function(count) {
  value <- iconv(strrep("\u00e9", count), from = "UTF-8", to = "latin1")
  Encoding(value) <- "latin1"
  value
}
latin1_boundary <- latin1_repeated_text(4096L)
latin1_overflow <- latin1_repeated_text(4097L)
assert_identical(nchar(latin1_boundary, type = "bytes"), 4096L, "the Latin-1 boundary fixture changed storage")
assert_identical(nchar(enc2utf8(latin1_boundary), type = "bytes"), 8192L, "the UTF-8 boundary fixture changed size")

latin1_boundary_names <- c(NA_character_, latin1_boundary)
source_environment$by_example_latin1 <- structure(
  list(text = setNames(c(latin1_boundary, "ok"), latin1_boundary_names)),
  names = "text",
  class = "data.frame",
  row.names = c("latin1-boundary", "latin1-ascii")
)
assert_identical(
  attr(base::.subset2(source_environment$by_example_latin1, 1L), "names", exact = TRUE),
  latin1_boundary_names,
  "the Latin-1 output-name boundary fixture lost its names attribute"
)
latin1_source_before <- serialize(source_environment$by_example_latin1, NULL, version = 3L)
latin1_session <- "a1b1c1d1-a1b1-41d1-81b1-a1b1c1d1e1f1"
latin1_open <- dispatch(
  "openSession",
  list(sessionId = latin1_session, variableName = "by_example_latin1", page = page_window())
)
assert_identical(latin1_open$kind, "page", "the Latin-1 boundary source did not open")
latin1_step <- list(
  id = "by-example-latin1-boundary",
  kind = "byExample",
  params = list(
    sourceColumns = I(list(list(id = "r:c:0", name = "text"))),
    newColumn = "text copy",
    examples = I(list(
      list(inputs = I(list("alpha")), output = "alpha"),
      list(inputs = I(list("beta")), output = "beta")
    ))
  )
)
latin1_preview <- dispatch(
  "previewStep",
  list(sessionId = latin1_session, revision = 0L, step = latin1_step, page = page_window())
)
assert_identical(latin1_preview$kind, "stepPreview", "the 8192-byte UTF-8 boundary did not preview")
assert_identical(
  nchar(latin1_preview$page$page$rows[[1L]]$values[[2L]]$raw, type = "bytes"),
  8192L,
  "live by-example counted Latin-1 bytes instead of normalized UTF-8 bytes"
)
latin1_apply <- dispatch(
  "applyDraft",
  list(sessionId = latin1_session, revision = latin1_preview$revision, page = page_window())
)
latin1_base_source <- unserialize(latin1_source_before)
latin1_data_table_source <- data.table::as.data.table(unserialize(latin1_source_before))
data.table::setattr(
  base::.subset2(latin1_data_table_source, 1L),
  "names",
  attr(latin1_base_source$text, "names", exact = TRUE)
)
latin1_qdt_source <- collapse::qDT(unserialize(latin1_source_before))
data.table::setattr(
  base::.subset2(latin1_qdt_source, 1L),
  "names",
  attr(latin1_base_source$text, "names", exact = TRUE)
)
latin1_generated_sources <- list(latin1_base_source, latin1_data_table_source, latin1_qdt_source)
for (latin1_flavor_index in seq_along(latin1_generated_sources)) {
  latin1_generated_source <- latin1_generated_sources[[latin1_flavor_index]]
  latin1_generated_before <- serialize(latin1_generated_source, NULL, version = 3L)
  latin1_environment <- new.env(parent = baseenv())
  assign("by_example_latin1", latin1_generated_source, envir = latin1_environment)
  eval(parse(text = latin1_apply$code), envir = latin1_environment)
  latin1_generated_result <- get("open_wrangler_result", envir = latin1_environment, inherits = FALSE)
  latin1_generated <- latin1_generated_result$`text copy`
  assert_identical(
    unname(latin1_generated),
    c(enc2utf8(latin1_boundary), "ok"),
    sprintf("generated by-example flavor %d did not normalize Latin-1 output", latin1_flavor_index)
  )
  assert_identical(
    attr(latin1_generated, "names", exact = TRUE),
    c(NA_character_, enc2utf8(latin1_boundary)),
    sprintf("generated by-example flavor %d lost or failed to normalize output names", latin1_flavor_index)
  )
  assert_identical(
    Encoding(attr(latin1_generated, "names", exact = TRUE)[[2L]]),
    "UTF-8",
    sprintf("generated by-example flavor %d retained a non-UTF-8 output-name mark", latin1_flavor_index)
  )
  assert_identical(
    attr(latin1_generated_result$text, "names", exact = TRUE),
    attr(latin1_generated_source$text, "names", exact = TRUE),
    sprintf("generated by-example flavor %d stripped retained source names", latin1_flavor_index)
  )
  assert_identical(
    serialize(get("by_example_latin1", envir = latin1_environment), NULL, version = 3L),
    latin1_generated_before,
    sprintf("generated Latin-1 flavor %d mutated its source", latin1_flavor_index)
  )
}
assert_identical(
  serialize(source_environment$by_example_latin1, NULL, version = 3L),
  latin1_source_before,
  "live Latin-1 by-example normalization mutated its source"
)
invisible(dispatch("closeSession", list(sessionId = latin1_session)))

source_environment$by_example_asis_frame_names <- structure(
  list(v = c("a", "b")),
  names = I("v"),
  class = "data.frame",
  row.names = c(NA_integer_, -2L)
)
assert_identical(
  attr(source_environment$by_example_asis_frame_names, "names", exact = TRUE),
  I("v"),
  "the AsIs frame-name fixture lost its class"
)
asis_frame_names_before <- serialize(
  source_environment$by_example_asis_frame_names,
  NULL,
  version = 3L
)
asis_frame_names_session <- "a4b4c4d4-a4b4-44d4-84b4-a4b4c4d4e4f4"
asis_frame_names_open <- dispatch(
  "openSession",
  list(
    sessionId = asis_frame_names_session,
    variableName = "by_example_asis_frame_names",
    page = page_window()
  )
)
assert_identical(asis_frame_names_open$kind, "page", "the AsIs frame-name source did not open")
asis_frame_names_step <- list(
  id = "by-example-asis-frame-names",
  kind = "byExample",
  params = list(
    sourceColumns = I(list(list(id = "r:c:0", name = "v"))),
    newColumn = "copy",
    examples = I(list(
      list(inputs = I(list("a")), output = "a"),
      list(inputs = I(list("b")), output = "b")
    ))
  )
)
asis_frame_names_preview <- dispatch(
  "previewStep",
  list(
    sessionId = asis_frame_names_session,
    revision = 0L,
    step = asis_frame_names_step,
    page = page_window()
  )
)
assert_identical(
  asis_frame_names_preview$kind,
  "stepPreview",
  "live by-example rejected supported AsIs frame names"
)
asis_frame_names_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = asis_frame_names_session,
    revision = asis_frame_names_preview$revision,
    page = page_window()
  )
)
assert_identical(
  vapply(asis_frame_names_apply$page$schema, `[[`, character(1L), "name", USE.NAMES = FALSE),
  c("v", "copy"),
  "live by-example did not normalize AsIs frame names"
)
asis_frame_names_expected <- real_by_example_column_at(
  unserialize(asis_frame_names_before),
  1L,
  "v",
  "copy",
  "character",
  function(columns) columns[[1L]]
)
asis_frame_names_environment <- new.env(parent = baseenv())
assign(
  "by_example_asis_frame_names",
  unserialize(asis_frame_names_before),
  envir = asis_frame_names_environment
)
eval(parse(text = asis_frame_names_apply$code), envir = asis_frame_names_environment)
asis_frame_names_generated <- get(
  "open_wrangler_result",
  envir = asis_frame_names_environment,
  inherits = FALSE
)
assert_identical(
  serialize(asis_frame_names_generated, NULL, version = 3L),
  serialize(asis_frame_names_expected, NULL, version = 3L),
  "generated by-example diverged from live handling of AsIs frame names"
)
assert_identical(
  serialize(
    get("by_example_asis_frame_names", envir = asis_frame_names_environment, inherits = FALSE),
    NULL,
    version = 3L
  ),
  asis_frame_names_before,
  "generated by-example mutated a source with AsIs frame names"
)
assert_identical(
  serialize(source_environment$by_example_asis_frame_names, NULL, version = 3L),
  asis_frame_names_before,
  "live by-example mutated a source with AsIs frame names"
)
invisible(dispatch("closeSession", list(sessionId = asis_frame_names_session)))

latin1_frame_name <- latin1_repeated_text(1L)
utf8_frame_name <- enc2utf8(latin1_frame_name)
source_environment$by_example_latin1_frame_name <- structure(
  list(c("a", "b")),
  names = latin1_frame_name,
  class = "data.frame",
  row.names = c(NA_integer_, -2L)
)
assert_identical(
  Encoding(attr(source_environment$by_example_latin1_frame_name, "names", exact = TRUE)[[1L]]),
  "latin1",
  "the Latin-1 frame-name fixture lost its encoding mark"
)
latin1_frame_name_before <- serialize(
  source_environment$by_example_latin1_frame_name,
  NULL,
  version = 3L
)
latin1_frame_name_session <- "a5b5c5d5-a5b5-45d5-85b5-a5b5c5d5e5f5"
latin1_frame_name_open <- dispatch(
  "openSession",
  list(
    sessionId = latin1_frame_name_session,
    variableName = "by_example_latin1_frame_name",
    page = page_window()
  )
)
assert_identical(latin1_frame_name_open$kind, "page", "the Latin-1 frame-name source did not open")
assert_identical(
  latin1_frame_name_open$page$schema[[1L]]$name,
  utf8_frame_name,
  "live capture did not normalize a Latin-1 frame name"
)
latin1_frame_name_step <- list(
  id = "by-example-latin1-frame-name",
  kind = "byExample",
  params = list(
    sourceColumns = I(list(list(id = "r:c:0", name = utf8_frame_name))),
    newColumn = "copy",
    examples = I(list(
      list(inputs = I(list("a")), output = "a"),
      list(inputs = I(list("b")), output = "b")
    ))
  )
)
latin1_frame_name_preview <- dispatch(
  "previewStep",
  list(
    sessionId = latin1_frame_name_session,
    revision = 0L,
    step = latin1_frame_name_step,
    page = page_window()
  )
)
assert_identical(
  latin1_frame_name_preview$kind,
  "stepPreview",
  "live by-example rejected a normalized Latin-1 frame reference"
)
latin1_frame_name_apply <- dispatch(
  "applyDraft",
  list(
    sessionId = latin1_frame_name_session,
    revision = latin1_frame_name_preview$revision,
    page = page_window()
  )
)
latin1_frame_name_base <- unserialize(latin1_frame_name_before)
latin1_frame_name_table <- data.table::as.data.table(unserialize(latin1_frame_name_before))
data.table::setnames(latin1_frame_name_table, latin1_frame_name)
latin1_frame_name_qdt <- collapse::qDT(unserialize(latin1_frame_name_before))
data.table::setnames(latin1_frame_name_qdt, latin1_frame_name)
latin1_frame_name_sources <- list(
  latin1_frame_name_base,
  latin1_frame_name_table,
  latin1_frame_name_qdt
)
for (latin1_frame_name_flavor in seq_along(latin1_frame_name_sources)) {
  latin1_frame_name_source <- latin1_frame_name_sources[[latin1_frame_name_flavor]]
  latin1_frame_name_source_before <- serialize(latin1_frame_name_source, NULL, version = 3L)
  latin1_frame_name_expected <- real_by_example_column_at(
    latin1_frame_name_source,
    1L,
    utf8_frame_name,
    "copy",
    "character",
    function(columns) columns[[1L]]
  )
  latin1_frame_name_environment <- new.env(parent = baseenv())
  assign(
    "by_example_latin1_frame_name",
    latin1_frame_name_source,
    envir = latin1_frame_name_environment
  )
  eval(parse(text = latin1_frame_name_apply$code), envir = latin1_frame_name_environment)
  latin1_frame_name_generated <- get(
    "open_wrangler_result",
    envir = latin1_frame_name_environment,
    inherits = FALSE
  )
  assert_identical(
    attr(latin1_frame_name_generated, "names", exact = TRUE),
    attr(latin1_frame_name_expected, "names", exact = TRUE),
    sprintf("generated flavor %d diverged from live Latin-1 frame-name semantics", latin1_frame_name_flavor)
  )
  assert_identical(
    Encoding(attr(latin1_frame_name_generated, "names", exact = TRUE)[[1L]]),
    if (latin1_frame_name_flavor == 1L) "UTF-8" else "latin1",
    sprintf("generated flavor %d used the wrong retained frame-name encoding", latin1_frame_name_flavor)
  )
  assert_identical(
    base::.subset2(latin1_frame_name_generated, 2L),
    base::.subset2(latin1_frame_name_expected, 2L),
    sprintf("generated flavor %d changed the Latin-1 frame-name derived values", latin1_frame_name_flavor)
  )
  assert_identical(
    serialize(
      get("by_example_latin1_frame_name", envir = latin1_frame_name_environment, inherits = FALSE),
      NULL,
      version = 3L
    ),
    latin1_frame_name_source_before,
    sprintf("generated flavor %d mutated its Latin-1 frame-name source", latin1_frame_name_flavor)
  )
}
assert_identical(
  serialize(source_environment$by_example_latin1_frame_name, NULL, version = 3L),
  latin1_frame_name_before,
  "live by-example mutated a Latin-1 frame-name source"
)
invisible(dispatch("closeSession", list(sessionId = latin1_frame_name_session)))

source_environment$by_example_latin1_overflow <- data.frame(
  safe = "visible",
  text = latin1_overflow,
  check.names = FALSE,
  row.names = "latin1-overflow"
)
latin1_overflow_before <- serialize(source_environment$by_example_latin1_overflow, NULL, version = 3L)
latin1_overflow_session <- "a2b2c2d2-a2b2-42d2-82b2-a2b2c2d2e2f2"
latin1_overflow_open <- dispatch(
  "openSession",
  list(
    sessionId = latin1_overflow_session,
    variableName = "by_example_latin1_overflow",
    page = page_window(column_limit = 1L)
  )
)
assert_identical(latin1_overflow_open$kind, "page", "the Latin-1 overflow source did not open")
latin1_overflow_step <- latin1_step
latin1_overflow_step$id <- "by-example-latin1-overflow"
latin1_overflow_step$params$sourceColumns <- I(list(list(id = "r:c:1", name = "text")))
latin1_overflow_preview <- dispatch(
  "previewStep",
  list(
    sessionId = latin1_overflow_session,
    revision = 0L,
    step = latin1_overflow_step,
    page = page_window(column_limit = 1L)
  )
)
assert_identical(latin1_overflow_preview$kind, "error", "live by-example accepted 8194 UTF-8 output bytes")
assert_identical(
  serialize(source_environment$by_example_latin1_overflow, NULL, version = 3L),
  latin1_overflow_before,
  "failed live Latin-1 by-example normalization mutated its source"
)
invisible(dispatch("closeSession", list(sessionId = latin1_overflow_session)))

latin1_overflow_environment <- new.env(parent = baseenv())
latin1_generated_overflow_source <- data.frame(
  text = latin1_overflow,
  check.names = FALSE,
  row.names = "latin1-overflow"
)
latin1_generated_overflow_before <- serialize(latin1_generated_overflow_source, NULL, version = 3L)
assign(
  "by_example_latin1",
  latin1_generated_overflow_source,
  envir = latin1_overflow_environment
)
latin1_generated_error <- tryCatch(
  {
    eval(parse(text = latin1_apply$code), envir = latin1_overflow_environment)
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(latin1_generated_error, "error") &&
    grepl("oversized", conditionMessage(latin1_generated_error), fixed = TRUE),
  "generated by-example accepted 8194 UTF-8 output bytes"
)
assert_identical(
  serialize(get("by_example_latin1", envir = latin1_overflow_environment), NULL, version = 3L),
  latin1_generated_overflow_before,
  "failed generated Latin-1 by-example normalization mutated its source"
)

oversized_element_name <- strrep("n", 8193L)
source_environment$by_example_name_overflow <- structure(
  list(safe = "visible", text = setNames("ok", oversized_element_name)),
  names = c("safe", "text"),
  class = "data.frame",
  row.names = "name-overflow"
)
assert_identical(
  attr(base::.subset2(source_environment$by_example_name_overflow, 2L), "names", exact = TRUE),
  oversized_element_name,
  "the output-name overflow fixture lost its names attribute"
)
name_overflow_before <- serialize(source_environment$by_example_name_overflow, NULL, version = 3L)
name_overflow_session <- "a3b3c3d3-a3b3-43d3-83b3-a3b3c3d3e3f3"
name_overflow_open <- dispatch(
  "openSession",
  list(
    sessionId = name_overflow_session,
    variableName = "by_example_name_overflow",
    page = page_window(column_limit = 1L)
  )
)
assert_identical(name_overflow_open$kind, "page", "the output-name overflow source did not open")
name_overflow_step <- latin1_step
name_overflow_step$id <- "by-example-output-name-overflow"
name_overflow_step$params$sourceColumns <- I(list(list(id = "r:c:1", name = "text")))
name_overflow_preview <- dispatch(
  "previewStep",
  list(
    sessionId = name_overflow_session,
    revision = 0L,
    step = name_overflow_step,
    page = page_window(column_limit = 1L)
  )
)
assert_identical(name_overflow_preview$kind, "error", "live by-example accepted an 8193-byte output name")
assert_identical(
  serialize(source_environment$by_example_name_overflow, NULL, version = 3L),
  name_overflow_before,
  "failed live output-name validation mutated its source"
)
invisible(dispatch("closeSession", list(sessionId = name_overflow_session)))

generated_name_overflow_source <- structure(
  list(text = setNames("ok", oversized_element_name)),
  names = "text",
  class = "data.frame",
  row.names = "name-overflow"
)
assert_identical(
  attr(base::.subset2(generated_name_overflow_source, 1L), "names", exact = TRUE),
  oversized_element_name,
  "the generated output-name overflow fixture lost its names attribute"
)
generated_name_overflow_before <- serialize(generated_name_overflow_source, NULL, version = 3L)
generated_name_overflow_environment <- new.env(parent = baseenv())
assign(
  "by_example_latin1",
  generated_name_overflow_source,
  envir = generated_name_overflow_environment
)
generated_name_overflow_error <- tryCatch(
  {
    eval(parse(text = latin1_apply$code), envir = generated_name_overflow_environment)
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(generated_name_overflow_error, "error") &&
    grepl("output names", conditionMessage(generated_name_overflow_error), fixed = TRUE),
  "generated by-example accepted an 8193-byte output name"
)
assert_identical(
  serialize(
    get("by_example_latin1", envir = generated_name_overflow_environment),
    NULL,
    version = 3L
  ),
  generated_name_overflow_before,
  "failed generated output-name validation mutated its source"
)

by_example_utf8_locale_child <- function(frame_contract_path, kernel_agent_path) {
  sys.source(frame_contract_path, envir = .GlobalEnv, keep.source = FALSE)
  sys.source(kernel_agent_path, envir = .GlobalEnv, keep.source = FALSE)
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("the by-example UTF-8 locale child requires jsonlite", call. = FALSE)
  }
  assert_child <- function(condition, message) {
    if (!isTRUE(condition)) stop(message, call. = FALSE)
  }
  unmarked_utf8 <- rawToChar(as.raw(c(0xc3L, 0xa9L, 0x78L)))
  unmarked_regex <- rawToChar(as.raw(c(0x78L, 0xd9L, 0xa1L, 0x79L)))
  assert_child(identical(Encoding(unmarked_utf8), "unknown"), "the UTF-8 locale fixture gained an encoding mark")
  expected_utf8 <- unmarked_utf8
  Encoding(expected_utf8) <- "UTF-8"
  expected_slice <- rawToChar(as.raw(c(0xc3L, 0xa9L)))
  Encoding(expected_slice) <- "UTF-8"
  expected_regex <- rawToChar(as.raw(c(0xd9L, 0xa1L)))
  Encoding(expected_regex) <- "UTF-8"
  source_frame <- structure(
    list(text = setNames(unmarked_utf8, unmarked_utf8), regex = unmarked_regex),
    names = c("text", "regex"),
    class = "data.frame",
    row.names = "utf8-row"
  )
  source_before <- serialize(source_frame, NULL, version = 3L)

  evaluator_environment <- environment(openwrangler_r_kernel_agent$new_agent)
  evaluator <- get("generated_by_example_evaluate", envir = evaluator_environment, inherits = FALSE)
  bound_program <- list(
    kind = "column",
    column = list(id = "r:c:0", name = "text"),
    `_owSourceIndex` = 1L,
    `_owSourceKind` = "character",
    `_owResultType` = "character"
  )
  evaluated <- evaluator(bound_program, list(base::.subset2(source_frame, 1L)))
  assert_child(
    identical(charToRaw(unname(evaluated)), charToRaw(expected_utf8)) &&
      identical(Encoding(unname(evaluated)), "UTF-8"),
    "the C-locale evaluator rejected or changed unmarked UTF-8"
  )
  slice_program <- list(
    kind = "slice",
    input = bound_program,
    start = 0L,
    stop = 1L,
    `_owResultType` = "character"
  )
  sliced <- evaluator(slice_program, list(base::.subset2(source_frame, 1L)))
  assert_child(
    identical(charToRaw(sliced), charToRaw(expected_slice)),
    "the C-locale evaluator sliced unmarked UTF-8 by bytes"
  )
  regex_program <- list(
    kind = "regexExtract",
    input = list(
      kind = "column",
      column = list(id = "r:c:1", name = "regex"),
      `_owSourceIndex` = 1L,
      `_owSourceKind` = "character",
      `_owResultType` = "character"
    ),
    pattern = "(\\d+)",
    group = 1L,
    `_owResultType` = "character"
  )
  extracted <- evaluator(regex_program, list(base::.subset2(source_frame, 2L)))
  assert_child(
    identical(charToRaw(extracted), charToRaw(expected_regex)),
    "the C-locale evaluator regex changed unmarked Unicode text"
  )

  source_environment <- new.env(parent = emptyenv())
  source_environment$by_example_utf8 <- source_frame
  agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, source_environment)
  on.exit(agent$dispose(), add = TRUE)
  page <- list(
    rowOffset = 0L,
    rowLimit = 10L,
    columnOffset = 0L,
    columnLimit = 10L,
    view = list(filters = I(list()), sorts = I(list()))
  )
  dispatch <- function(kind, payload) {
    request <- jsonlite::toJSON(
      list(
        transportVersion = 14L,
        requestId = "acdcacdc-acdc-4cdc-8cdc-acdcacdcacdc",
        kind = kind,
        payload = payload
      ),
      auto_unbox = TRUE,
      null = "null",
      na = "null",
      digits = 17L
    )
    jsonlite::fromJSON(agent$dispatch_json(as.character(request)), simplifyVector = FALSE)
  }
  opened <- dispatch(
    "openSession",
    list(
      sessionId = "abdcabdc-abdc-4bdc-8bdc-abdcabdcabdc",
      variableName = "by_example_utf8",
      page = page
    )
  )
  assert_child(identical(opened$kind, "page"), "the C-locale UTF-8 source did not open")
  preview <- dispatch(
    "previewStep",
    list(
      sessionId = "abdcabdc-abdc-4bdc-8bdc-abdcabdcabdc",
      revision = 0L,
      step = list(
        id = "by-example-unmarked-utf8",
        kind = "byExample",
        params = list(
          sourceColumns = I(list(list(id = "r:c:0", name = "text"))),
          newColumn = "text copy",
          examples = I(list(
            list(inputs = I(list("alpha")), output = "alpha"),
            list(inputs = I(list("beta")), output = "beta")
          ))
        )
      ),
      page = page
    )
  )
  assert_child(identical(preview$kind, "stepPreview"), "the C-locale live UTF-8 copy did not preview")
  applied <- dispatch(
    "applyDraft",
    list(
      sessionId = "abdcabdc-abdc-4bdc-8bdc-abdcabdcabdc",
      revision = preview$revision,
      page = page
    )
  )
  slice_preview <- dispatch(
    "previewStep",
    list(
      sessionId = "abdcabdc-abdc-4bdc-8bdc-abdcabdcabdc",
      revision = applied$revision,
      step = list(
        id = "by-example-unmarked-utf8-slice",
        kind = "byExample",
        params = list(
          sourceColumns = I(list(list(id = "r:c:0", name = "text"))),
          newColumn = "slice copy",
          examples = I(list(
            list(inputs = I(list("ab")), output = "a"),
            list(inputs = I(list("cd")), output = "c")
          ))
        )
      ),
      page = page
    )
  )
  assert_child(identical(slice_preview$kind, "stepPreview"), "the C-locale live UTF-8 slice did not preview")
  slice_applied <- dispatch(
    "applyDraft",
    list(
      sessionId = "abdcabdc-abdc-4bdc-8bdc-abdcabdcabdc",
      revision = slice_preview$revision,
      page = page
    )
  )
  regex_example_one <- paste0("x", expected_regex, "y")
  regex_example_two <- paste0("long", rawToChar(as.raw(c(0xd9L, 0xa2L))), "z")
  Encoding(regex_example_two) <- "UTF-8"
  regex_output_two <- rawToChar(as.raw(c(0xd9L, 0xa2L)))
  Encoding(regex_output_two) <- "UTF-8"
  regex_preview <- dispatch(
    "previewStep",
    list(
      sessionId = "abdcabdc-abdc-4bdc-8bdc-abdcabdcabdc",
      revision = slice_applied$revision,
      step = list(
        id = "by-example-unmarked-utf8-regex",
        kind = "byExample",
        params = list(
          sourceColumns = I(list(list(id = "r:c:1", name = "regex"))),
          newColumn = "regex copy",
          examples = I(list(
            list(inputs = I(list(regex_example_one)), output = expected_regex),
            list(inputs = I(list(regex_example_two)), output = regex_output_two)
          ))
        )
      ),
      page = page
    )
  )
  assert_child(identical(regex_preview$kind, "stepPreview"), "the C-locale live UTF-8 regex did not preview")
  applied <- dispatch(
    "applyDraft",
    list(
      sessionId = "abdcabdc-abdc-4bdc-8bdc-abdcabdcabdc",
      revision = regex_preview$revision,
      page = page
    )
  )
  generated_environment <- new.env(parent = baseenv())
  assign("by_example_utf8", unserialize(source_before), envir = generated_environment)
  eval(parse(text = applied$code), envir = generated_environment)
  generated <- get("open_wrangler_result", envir = generated_environment, inherits = FALSE)
  generated_copy <- base::.subset2(generated, 3L)
  generated_name <- base::.subset2(attr(generated_copy, "names", exact = TRUE), 1L)
  assert_child(
    identical(charToRaw(unname(generated_copy)), charToRaw(expected_utf8)) &&
      identical(Encoding(unname(generated_copy)), "UTF-8"),
    "the C-locale generated UTF-8 value diverged"
  )
  assert_child(
    identical(charToRaw(generated_name), charToRaw(expected_utf8)) &&
      identical(Encoding(generated_name), "UTF-8"),
    "the C-locale generated UTF-8 output name diverged"
  )
  assert_child(
    identical(charToRaw(base::.subset2(generated, 4L)), charToRaw(expected_slice)),
    "the C-locale generated UTF-8 slice diverged"
  )
  assert_child(
    identical(charToRaw(base::.subset2(generated, 5L)), charToRaw(expected_regex)),
    "the C-locale generated UTF-8 regex diverged"
  )
  assert_child(
    identical(serialize(source_environment$by_example_utf8, NULL, version = 3L), source_before) &&
      identical(
        serialize(get("by_example_utf8", envir = generated_environment), NULL, version = 3L),
        source_before
      ),
    "C-locale UTF-8 evaluation mutated its source"
  )
  invisible(dispatch("closeSession", list(sessionId = "abdcabdc-abdc-4bdc-8bdc-abdcabdcabdc")))
}

by_example_utf8_locale_script <- tempfile(fileext = ".R")
writeLines(
  c(
    "by_example_utf8_locale_child <-",
    deparse(by_example_utf8_locale_child, width.cutoff = 500L),
    paste0(
      "by_example_utf8_locale_child(",
      "commandArgs(trailingOnly = TRUE)[[1L]], ",
      "commandArgs(trailingOnly = TRUE)[[2L]])"
    )
  ),
  by_example_utf8_locale_script,
  useBytes = TRUE
)
by_example_utf8_locale_output <- system2(
  file.path(R.home("bin"), "Rscript"),
  c(
    "--vanilla",
    by_example_utf8_locale_script,
    normalizePath("r/openwrangler_runtime/frame_contract.R"),
    normalizePath("r/openwrangler_runtime/kernel_agent.R")
  ),
  stdout = TRUE,
  stderr = TRUE,
  env = c("LC_ALL=C", "LANG=C", "LANGUAGE=C")
)
by_example_utf8_locale_status <- attr(by_example_utf8_locale_output, "status", exact = TRUE)
if (!is.null(by_example_utf8_locale_status) && by_example_utf8_locale_status != 0L) {
  stop(
    paste(c("by-example C-locale UTF-8 child failed", by_example_utf8_locale_output), collapse = "\n"),
    call. = FALSE
  )
}
unlink(by_example_utf8_locale_script)

# Cross every generated-evaluator chunk boundary while caller S3 methods are
# poisoned, then compare standalone attributes and source bytes with live work.
by_example_s3_isolation_child <- function(frame_contract_path, kernel_agent_path) {
  sys.source(frame_contract_path, envir = .GlobalEnv, keep.source = FALSE)
  sys.source(kernel_agent_path, envir = .GlobalEnv, keep.source = FALSE)
  if (!requireNamespace("bit64", quietly = TRUE) || !requireNamespace("jsonlite", quietly = TRUE)) {
    stop("the by-example S3-isolation child requires bit64 and jsonlite", call. = FALSE)
  }
  assert_child <- function(condition, message) {
    if (!isTRUE(condition)) stop(message, call. = FALSE)
  }
  assert_same <- function(actual, expected, message) {
    if (!identical(actual, expected)) stop(message, call. = FALSE)
  }
  safe_integer64_character <- get("as.character.integer64", envir = asNamespace("bit64"), inherits = FALSE)
  source_environment <- new.env(parent = emptyenv())
  row_count <- 2051L
  element_names <- sprintf("s3-%04d", seq_len(row_count))
  element_names[c(1024L, 1025L, 2048L, 2049L)] <- c(
    "chunk-one-last",
    NA_character_,
    "chunk-two-last",
    "chunk-three-first"
  )
  category <- ordered(
    rep(c("aLPHA", "bETA"), length.out = row_count),
    levels = c("unused", "aLPHA", "bETA")
  )
  attr(category, "levels") <- I(attr(category, "levels", exact = TRUE))
  names(category) <- element_names
  wide <- bit64::as.integer64(rep(c("9007199254740993", "-2"), length.out = row_count))
  names(wide) <- element_names
  day <- as.Date("2024-01-01") + ((seq_len(row_count) - 1L) %% 731L)
  names(day) <- element_names
  instant <- as.POSIXct("2024-01-01", tz = "UTC") + seq_len(row_count) - 1L
  names(instant) <- element_names
  elapsed <- as.difftime(seq_len(row_count), units = "mins")
  names(elapsed) <- element_names
  source_environment$by_example_s3 <- structure(
    list(category = category, wide = wide, day = day, instant = instant, elapsed = elapsed),
    names = c("category", "wide", "day", "instant", "elapsed"),
    class = "data.frame",
    row.names = c(NA_integer_, -row_count)
  )
  source_before_bytes <- serialize(source_environment$by_example_s3, NULL, version = 3L)
  source_before <- unserialize(source_before_bytes)
  integer64_input_name_chunks <- list()
  integer64_output_name_chunks <- list()
  instrumented_contract <- openwrangler_r_frame_contract
  real_chunked_by_example <- instrumented_contract$by_example_column_at
  instrumented_contract$by_example_column_at <- function(
    value,
    positions,
    expected_names,
    new_name,
    result_kind,
    evaluator
  ) {
    real_chunked_by_example(
      value,
      positions,
      expected_names,
      new_name,
      result_kind,
      function(columns) {
        output <- evaluator(columns)
        if (identical(new_name, "wide plus two")) {
          integer64_input_name_chunks[[length(integer64_input_name_chunks) + 1L]] <<-
            attr(base::.subset2(columns, 1L), "names", exact = TRUE)
          integer64_output_name_chunks[length(integer64_output_name_chunks) + 1L] <<-
            list(attr(output, "names", exact = TRUE))
        }
        output
      }
    )
  }
  agent <- openwrangler_r_kernel_agent$new_agent(instrumented_contract, source_environment)
  on.exit(agent$dispose(), add = TRUE)
  page <- list(
    rowOffset = 0L,
    rowLimit = 100L,
    columnOffset = 0L,
    columnLimit = 1L,
    view = list(filters = I(list()), sorts = I(list()))
  )
  dispatch <- function(kind, payload) {
    request <- jsonlite::toJSON(
      list(
        transportVersion = 14L,
        requestId = "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1",
        kind = kind,
        payload = payload
      ),
      auto_unbox = TRUE,
      null = "null",
      na = "null",
      digits = 17L
    )
    jsonlite::fromJSON(agent$dispatch_json(as.character(request)), simplifyVector = FALSE)
  }
  opened <- dispatch(
    "openSession",
    list(
      sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
      variableName = "by_example_s3",
      page = page
    )
  )
  assert_same(opened$kind, "page", "the by-example S3-isolation source did not open")

  poison_calls <- 0L
  poison <- function(...) {
    poison_calls <<- poison_calls + 1L
    calls <- tail(vapply(sys.calls(), function(call) paste(deparse(call, width.cutoff = 200L), collapse = " "), character(1L)), 12L)
    stop(paste(c("caller S3 poison ran", calls), collapse = " <- "), call. = FALSE)
  }
  assign("as.integer64", bit64::as.integer64, envir = .GlobalEnv)
  registerS3method("as.character", "factor", poison, envir = .GlobalEnv)
  registerS3method("as.character", "integer64", poison, envir = .GlobalEnv)
  registerS3method("as.double", "integer64", poison, envir = .GlobalEnv)
  registerS3method("as.integer64", "character", poison, envir = .GlobalEnv)
  registerS3method("[", "AsIs", poison, envir = .GlobalEnv)

  factor_preview <- dispatch(
    "previewStep",
    list(
      sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
      revision = 0L,
      step = list(
        id = "by-example-s3-factor",
        kind = "byExample",
        params = list(
          sourceColumns = I(list(list(id = "r:c:0", name = "category"))),
          newColumn = "capitalized",
          examples = I(list(
            list(inputs = I(list("aLPHA")), output = "Alpha"),
            list(inputs = I(list("bETA")), output = "Beta")
          ))
        )
      ),
      page = page
    )
  )
  assert_same(
    factor_preview$kind,
    "stepPreview",
    paste0(
      "poisoned factor by-example did not preview",
      if (identical(factor_preview$kind, "error")) {
        sprintf(": %s: %s", factor_preview$code, factor_preview$message)
      } else {
        ""
      }
    )
  )
  factor_apply <- dispatch(
    "applyDraft",
    list(
      sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
      revision = factor_preview$revision,
      page = page
    )
  )
  integer_preview <- dispatch(
    "previewStep",
    list(
      sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
      revision = factor_apply$revision,
      step = list(
        id = "by-example-s3-integer64",
        kind = "byExample",
        params = list(
          sourceColumns = I(list(list(id = "r:c:1", name = "wide"))),
          newColumn = "wide plus two",
          examples = I(list(
            list(inputs = I(list(1L)), output = 3L),
            list(inputs = I(list(2L)), output = 4L)
          ))
        )
      ),
      page = page
    )
  )
  assert_same(
    integer_preview$kind,
    "stepPreview",
    paste0(
      "poisoned integer64 by-example did not preview",
      if (identical(integer_preview$kind, "error")) {
        sprintf(": %s: %s", integer_preview$code, integer_preview$message)
      } else {
        ""
      }
    )
  )
  assert_same(
    integer_preview$retainedStep$params$program$kind,
    "arithmetic",
    "the chunked integer64 examples selected the wrong program"
  )
  integer_apply <- dispatch(
    "applyDraft",
    list(
      sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
      revision = integer_preview$revision,
      page = page
    )
  )
  date_preview <- dispatch(
    "previewStep",
    list(
      sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
      revision = integer_apply$revision,
      step = list(
        id = "by-example-s3-date",
        kind = "byExample",
        params = list(
          sourceColumns = I(list(list(id = "r:c:2", name = "day"))),
          newColumn = "formatted day",
          examples = I(list(
            list(inputs = I(list("2024-01-02")), output = "02/01/2024"),
            list(inputs = I(list("2025-12-31")), output = "31/12/2025")
          ))
        )
      ),
      page = page
    )
  )
  assert_same(
    date_preview$kind,
    "stepPreview",
    paste0(
      "poisoned Date by-example did not preview",
      if (identical(date_preview$kind, "error")) {
        sprintf(": %s: %s", date_preview$code, date_preview$message)
      } else {
        ""
      }
    )
  )
  assert_same(
    date_preview$retainedStep$params$program$kind,
    "datetimeFormat",
    "the chunked Date examples selected the wrong program"
  )
  date_apply <- dispatch(
    "applyDraft",
    list(
      sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
      revision = date_preview$revision,
      page = page
    )
  )
  direct_specs <- list(
    list(position = 1L, name = "category", kind = "factor", inputs = list("aLPHA", "bETA")),
    list(position = 3L, name = "day", kind = "date", inputs = list("2024-01-01", "2024-01-02")),
    list(
      position = 4L,
      name = "instant",
      kind = "datetime",
      inputs = list("2024-01-01T00:00:00Z", "2024-01-01T00:00:01Z")
    ),
    list(position = 5L, name = "elapsed", kind = "difftime", inputs = list(1L, 2L))
  )
  direct_revision <- date_apply$revision
  applied <- NULL
  for (direct_index in seq_along(direct_specs)) {
    specification <- direct_specs[[direct_index]]
    direct_step <- list(
      id = sprintf("by-example-s3-direct-%d", direct_index),
      kind = "byExample",
      params = list(
        sourceColumns = I(list(list(
          id = sprintf("r:c:%d", specification$position - 1L),
          name = specification$name
        ))),
        newColumn = paste0(specification$name, " copy"),
        examples = I(lapply(specification$inputs, function(input) {
          list(inputs = I(list(input)), output = input)
        }))
      )
    )
    direct_preview <- dispatch(
      "previewStep",
      list(
        sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
        revision = direct_revision,
        step = direct_step,
        page = page
      )
    )
    assert_same(
      direct_preview$kind,
      "stepPreview",
      sprintf("poisoned direct %s by-example did not preview", specification$kind)
    )
    assert_same(
      direct_preview$retainedStep$params$program$kind,
      "column",
      sprintf("the direct %s examples selected the wrong program", specification$kind)
    )
    applied <- dispatch(
      "applyDraft",
      list(
        sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
        revision = direct_preview$revision,
        page = page
      )
    )
    direct_revision <- applied$revision
  }
  assert_child(!is.null(applied), "the chunked by-example plan did not apply")
  expected_name_chunks <- list(
    base::.subset(element_names, seq.int(1L, 1024L)),
    base::.subset(element_names, seq.int(1025L, 2048L)),
    base::.subset(element_names, seq.int(2049L, row_count))
  )
  assert_child(
    length(integer64_input_name_chunks) >= 3L && length(integer64_input_name_chunks) %% 3L == 0L,
    "live chunked integer64 arithmetic did not evaluate complete source windows"
  )
  assert_same(
    tail(integer64_input_name_chunks, 3L),
    expected_name_chunks,
    "live chunked integer64 arithmetic lost source names"
  )
  assert_child(
    length(integer64_output_name_chunks) == length(integer64_input_name_chunks),
    "live chunked integer64 arithmetic did not capture every output-name decision"
  )
  assert_child(
    all(vapply(tail(integer64_output_name_chunks, 3L), is.null, logical(1L), USE.NAMES = FALSE)),
    "live chunked integer64 arithmetic unexpectedly retained input names"
  )
  assert_child(
    !grepl("by_example_shortest_double_components|jsonlite::fromJSON", applied$code, perl = TRUE),
    "generated by-example code retained an unused runtime-only double helper"
  )
  assert_child(
    grepl("source_chunk <- function(source, indexes)", applied$code, fixed = TRUE) &&
      grepl("chunk <- base::.subset(base::unclass(source), indexes)", applied$code, fixed = TRUE) &&
      grepl("source_attributes$names <- base::.subset(source_names, indexes)", applied$code, fixed = TRUE) &&
      grepl(
        "result[present] <- base::.subset(levels, base::.subset(codes, present))",
        applied$code,
        fixed = TRUE
      ) &&
      !grepl("base::.subset(column, indexes)", applied$code, fixed = TRUE),
    "generated by-example code lost its dispatch-free attributed source slicing"
  )
  live_direct_expected <- source_before
  for (specification in direct_specs) {
    live_direct_expected <- openwrangler_r_frame_contract$by_example_column_at(
      live_direct_expected,
      specification$position,
      specification$name,
      paste0(specification$name, " copy"),
      specification$kind,
      function(columns) columns[[1L]]
    )
  }
  generated_environment <- new.env(parent = baseenv())
  assign("by_example_s3", unserialize(source_before_bytes), envir = generated_environment)
  eval(parse(text = applied$code), envir = generated_environment)
  generated <- get("open_wrangler_result", envir = generated_environment, inherits = FALSE)
  assert_same(
    generated[["capitalized"]],
    rep(c("Alpha", "Beta"), length.out = row_count),
    "poisoned chunked generated factor text diverged"
  )
  assert_same(
    generated[["formatted day"]],
    unname(base::format.Date(day, format = "%d/%m/%Y")),
    "chunked generated Date formatting diverged"
  )
  assert_same(
    unname(safe_integer64_character(generated[["wide plus two"]])),
    rep(c("9007199254740995", "0"), length.out = row_count),
    "poisoned chunked generated exact integer64 arithmetic diverged"
  )
  assert_same(
    attr(generated[["wide plus two"]], "names", exact = TRUE),
    NULL,
    "generated chunked integer64 arithmetic diverged from live output-name behavior"
  )
  boundary_positions <- c(1024L, 1025L, 2048L, 2049L, 2051L)
  for (specification in direct_specs) {
    output_name <- paste0(specification$name, " copy")
    assert_same(
      serialize(generated[[output_name]], NULL, version = 3L),
      serialize(live_direct_expected[[output_name]], NULL, version = 3L),
      sprintf("chunked generated direct %s attributes diverged from live", specification$kind)
    )
    assert_same(
      base::.subset(base::attr(generated[[output_name]], "names", exact = TRUE), boundary_positions),
      base::.subset(element_names, boundary_positions),
      sprintf("chunked generated direct %s lost boundary names", specification$kind)
    )
  }
  assert_same(
    base::class(generated[["category copy"]]),
    c("ordered", "factor"),
    "chunked generated direct factor lost its ordered class"
  )
  assert_same(
    base::class(base::attr(generated[["category copy"]], "levels", exact = TRUE)),
    "AsIs",
    "chunked generated direct factor lost its safe nested level metadata"
  )
  assert_same(base::class(generated[["day copy"]]), "Date", "chunked generated direct Date lost its class")
  assert_same(
    base::attr(generated[["instant copy"]], "tzone", exact = TRUE),
    base::attr(instant, "tzone", exact = TRUE),
    "chunked generated direct POSIXct lost its timezone"
  )
  assert_same(
    base::attr(generated[["elapsed copy"]], "units", exact = TRUE),
    base::attr(elapsed, "units", exact = TRUE),
    "chunked generated direct difftime lost its units"
  )
  assert_same(
    serialize(source_environment$by_example_s3, NULL, version = 3L),
    source_before_bytes,
    "poisoned live chunked by-example mutated its source bytes"
  )
  assert_same(
    serialize(get("by_example_s3", envir = generated_environment, inherits = FALSE), NULL, version = 3L),
    source_before_bytes,
    "poisoned generated chunked by-example mutated its source bytes"
  )
  assert_same(poison_calls, 0L, "by-example evaluation dispatched through caller S3 methods")
  invisible(dispatch("closeSession", list(sessionId = "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2")))
}

by_example_s3_script <- tempfile(fileext = ".R")
writeLines(
  c(
    "by_example_s3_isolation_child <-",
    deparse(by_example_s3_isolation_child, width.cutoff = 500L),
    paste0(
      "by_example_s3_isolation_child(",
      "commandArgs(trailingOnly = TRUE)[[1L]], ",
      "commandArgs(trailingOnly = TRUE)[[2L]])"
    )
  ),
  by_example_s3_script,
  useBytes = TRUE
)
by_example_s3_output <- system2(
  file.path(R.home("bin"), "Rscript"),
  c(
    "--vanilla",
    by_example_s3_script,
    normalizePath("r/openwrangler_runtime/frame_contract.R"),
    normalizePath("r/openwrangler_runtime/kernel_agent.R")
  ),
  stdout = TRUE,
  stderr = TRUE
)
by_example_s3_status <- attr(by_example_s3_output, "status", exact = TRUE)
if (!is.null(by_example_s3_status) && by_example_s3_status != 0L) {
  stop(paste(c("by-example S3-isolation child failed", by_example_s3_output), collapse = "\n"), call. = FALSE)
}
unlink(by_example_s3_script)

# Strict decode/binding failures remain atomic and reject every private,
# stale, colliding, malformed, or over-budget public shape.
source_environment$by_example_adversarial <- as.data.frame(
  setNames(
    replicate(17L, c("alpha", "beta"), simplify = FALSE),
    sprintf("source_%02d", seq_len(17L))
  ),
  optional = TRUE,
  stringsAsFactors = FALSE
)
by_example_adversarial_before <- unserialize(serialize(
  source_environment$by_example_adversarial,
  NULL,
  version = 3L
))
by_example_adversarial_session <- "a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7"
adversarial_open <- dispatch(
  "openSession",
  list(
    sessionId = by_example_adversarial_session,
    variableName = "by_example_adversarial",
    page = page_window()
  )
)
assert_identical(adversarial_open$kind, "page", "the adversarial by-example session did not open")
adversarial_reference <- function(position) {
  list(id = sprintf("r:c:%d", position - 1L), name = sprintf("source_%02d", position))
}
adversarial_valid_step <- function(id = "by-example-adversarial-valid", new_column = "valid output") {
  list(
    id = id,
    kind = "byExample",
    params = list(
      sourceColumns = I(list(adversarial_reference(1L))),
      newColumn = new_column,
      examples = I(list(
        list(inputs = I(list("alpha")), output = "fixed"),
        list(inputs = I(list("beta")), output = "fixed")
      ))
    )
  )
}
expect_adversarial_failure <- function(step, label, expected_code = "invalid_request", revision = 0L) {
  response <- dispatch(
    "previewStep",
    list(
      sessionId = by_example_adversarial_session,
      revision = revision,
      step = step,
      page = page_window()
    )
  )
  assert_identical(response$kind, "error", sprintf("R by-example accepted %s", label))
  assert_identical(response$code, expected_code, sprintf("R by-example normalized %s incorrectly", label))
  assert_identical(
    source_environment$by_example_adversarial,
    by_example_adversarial_before,
    sprintf("failed R by-example %s mutated its source", label)
  )
  invisible(response)
}

too_many_sources <- adversarial_valid_step("by-example-too-many-sources", "too many sources")
too_many_sources$params$sourceColumns <- I(lapply(seq_len(17L), adversarial_reference))
too_many_sources$params$examples <- I(list(
  list(inputs = I(as.list(rep.int("alpha", 17L))), output = "fixed"),
  list(inputs = I(as.list(rep.int("beta", 17L))), output = "fixed")
))
expect_adversarial_failure(too_many_sources, "17 source columns")

too_many_examples <- adversarial_valid_step("by-example-too-many-examples", "too many examples")
too_many_examples$params$examples <- I(lapply(seq_len(65L), function(index) {
  list(inputs = I(list(sprintf("input-%d", index))), output = "fixed")
}))
expect_adversarial_failure(too_many_examples, "65 examples")

repeated_source <- adversarial_valid_step("by-example-repeated-source", "repeated source")
repeated_source$params$sourceColumns <- I(list(adversarial_reference(1L), adversarial_reference(1L)))
repeated_source$params$examples <- I(list(
  list(inputs = I(list("alpha", "alpha")), output = "fixed"),
  list(inputs = I(list("beta", "beta")), output = "fixed")
))
expect_adversarial_failure(repeated_source, "a repeated source identity")

named_inputs <- adversarial_valid_step("by-example-named-inputs", "named inputs")
named_inputs$params$examples[[1L]]$inputs <- list(source_01 = "alpha")
expect_adversarial_failure(named_inputs, "name-keyed example inputs")

stale_source <- adversarial_valid_step("by-example-stale", "stale output")
stale_source$params$sourceColumns[[1L]]$name <- "renamed_source"
expect_adversarial_failure(stale_source, "a stale source name", expected_code = "stale_column")

collision_step <- adversarial_valid_step("by-example-collision", "source_01")
expect_adversarial_failure(collision_step, "an output-name collision")
private_name_step <- adversarial_valid_step(
  "by-example-private-name",
  "__OPEN_WRANGLER_INTERNAL_ROW_ID_forbidden"
)
expect_adversarial_failure(private_name_step, "a private output name")

unsafe_example <- adversarial_valid_step("by-example-unsafe-example", "unsafe example")
unsafe_example$params$examples[[1L]]$inputs[[1L]] <- 9007199254740992
expect_adversarial_failure(unsafe_example, "an unsafe whole example input")
unsafe_output <- adversarial_valid_step("by-example-unsafe-output", "unsafe output")
unsafe_output$params$examples[[1L]]$output <- 9007199254740992
expect_adversarial_failure(unsafe_output, "an unsafe whole example output")

private_program <- adversarial_valid_step("by-example-private-program", "private program")
private_program$params$program <- list(
  kind = "column",
  column = adversarial_reference(1L),
  `_owSourceIndex` = 1L
)
expect_adversarial_failure(private_program, "private bound program metadata")
unsafe_program <- adversarial_valid_step("by-example-unsafe-program", "unsafe program")
unsafe_program$params$program <- list(kind = "literal", value = 9007199254740992)
expect_adversarial_failure(unsafe_program, "an unsafe whole program literal")

concat_overflow <- adversarial_valid_step("by-example-concat-overflow", "concat overflow")
concat_overflow$params$program <- list(
  kind = "concat",
  parts = I(replicate(65L, list(kind = "literal", value = "x"), simplify = FALSE))
)
expect_adversarial_failure(concat_overflow, "65 concat parts")

deep_program <- list(kind = "column", column = adversarial_reference(1L))
for (depth in seq_len(65L)) {
  deep_program <- list(kind = "case", style = "lower", input = deep_program)
}
depth_overflow <- adversarial_valid_step("by-example-depth-overflow", "depth overflow")
depth_overflow$params$program <- deep_program
expect_adversarial_failure(depth_overflow, "a depth-65 AST")

node_program <- list(kind = "column", column = adversarial_reference(1L))
for (level in seq_len(8L)) {
  node_program <- list(kind = "concat", parts = I(list(node_program, node_program)))
}
node_overflow <- adversarial_valid_step("by-example-node-overflow", "node overflow")
node_overflow$params$program <- node_program
expect_adversarial_failure(node_overflow, "more than 256 AST nodes")

oversized_string <- adversarial_valid_step("by-example-string-overflow", "string overflow")
oversized_string$params$examples[[1L]]$output <- paste0(rep.int("x", 8193L), collapse = "")
expect_adversarial_failure(oversized_string, "an 8193-byte string")

total_text_overflow <- adversarial_valid_step("by-example-text-overflow", "text overflow")
total_text_overflow$params$examples <- I(lapply(seq_len(9L), function(index) {
  list(
    inputs = I(list(sprintf("input-%d", index))),
    output = paste0(rep.int(as.character(index), 8000L), collapse = "")
  )
}))
expect_adversarial_failure(total_text_overflow, "more than 64 KiB of request text")

too_many_warnings <- adversarial_valid_step("by-example-warning-overflow", "warning overflow")
too_many_warnings$params$warnings <- I(as.list(sprintf("warning-%d", seq_len(65L))))
too_many_warnings$params$candidateCount <- 1L
expect_adversarial_failure(too_many_warnings, "65 warnings")

adversarial_revision <- 0L
valid_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_adversarial_session,
    revision = adversarial_revision,
    step = adversarial_valid_step(),
    page = page_window()
  )
)
assert_identical(valid_preview$kind, "stepPreview", "the valid adversarial control did not preview")
valid_discard <- dispatch(
  "discardDraft",
  list(sessionId = by_example_adversarial_session, revision = valid_preview$revision, page = page_window())
)
adversarial_revision <- valid_discard$revision

large_metadata_step <- valid_preview$retainedStep
large_metadata_step$id <- "by-example-large-metadata"
large_metadata_step$params$newColumn <- "large metadata"
large_metadata_step$params$candidateCount <- 3000000000
large_metadata_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_adversarial_session,
    revision = adversarial_revision,
    step = large_metadata_step,
    page = page_window()
  )
)
assert_identical(large_metadata_preview$kind, "stepPreview", "R rejected positive safe candidateCount metadata")
assert_identical(
  large_metadata_preview$retainedStep$params$candidateCount,
  1L,
  "R did not recompute untrusted candidateCount metadata"
)
large_metadata_discard <- dispatch(
  "discardDraft",
  list(sessionId = by_example_adversarial_session, revision = large_metadata_preview$revision, page = page_window())
)
adversarial_revision <- large_metadata_discard$revision

max_safe_step <- adversarial_valid_step("by-example-max-safe", "max safe")
max_safe_step$params$examples <- I(list(
  list(inputs = I(list("alpha")), output = 9007199254740991),
  list(inputs = I(list("beta")), output = 9007199254740991)
))
max_safe_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_adversarial_session,
    revision = adversarial_revision,
    step = max_safe_step,
    page = page_window()
  )
)
assert_identical(max_safe_preview$kind, "stepPreview", "R rejected Number.MAX_SAFE_INTEGER")
assert_identical(
  tail(max_safe_preview$page$schema, 1L)[[1L]]$rawType,
  "integer64",
  "R did not bind Number.MAX_SAFE_INTEGER as integer64"
)
max_safe_discard <- dispatch(
  "discardDraft",
  list(sessionId = by_example_adversarial_session, revision = max_safe_preview$revision, page = page_window())
)
adversarial_revision <- max_safe_discard$revision

precise_step <- adversarial_valid_step("by-example-precise-double", "precise double")
precise_step$params$examples <- I(list(
  list(inputs = I(list("alpha")), output = 1.2345678901234567),
  list(inputs = I(list("beta")), output = 1.2345678901234567)
))
precise_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_adversarial_session,
    revision = adversarial_revision,
    step = precise_step,
    page = page_window()
  )
)
assert_identical(precise_preview$kind, "stepPreview", "the precise-double by-example did not preview")
assert_identical(
  precise_preview$retainedStep$params$examples[[1L]]$output,
  1.2345678901234567,
  "protocol v14 changed a retained by-example double"
)
precise_discard <- dispatch(
  "discardDraft",
  list(sessionId = by_example_adversarial_session, revision = precise_preview$revision, page = page_window())
)
adversarial_revision <- precise_discard$revision

program_null_step <- adversarial_valid_step("by-example-program-null", "program null")
program_null_step$params["program"] <- list(NULL)
assert_identical(
  "program" %in% names(program_null_step$params),
  TRUE,
  "the explicit-null program fixture accidentally omitted its field"
)
program_null_request_id <- "b6b6b6b6-b6b6-46b6-86b6-b6b6b6b6b6b6"
program_null_request <- as.character(jsonlite::toJSON(
  list(
    transportVersion = 14L,
    requestId = program_null_request_id,
    kind = "previewStep",
    payload = list(
      sessionId = by_example_adversarial_session,
      revision = adversarial_revision,
      step = program_null_step,
      page = page_window()
    )
  ),
  auto_unbox = TRUE,
  null = "null",
  na = "null",
  digits = 17L
))
by_example_assert(
  grepl('"program":null', program_null_request, fixed = TRUE),
  "the explicit-null program fixture did not reach the raw R protocol"
)
program_null_response <- jsonlite::fromJSON(
  agent$dispatch_json(program_null_request),
  simplifyVector = FALSE
)
assert_identical(program_null_response$kind, "error", "R accepted params.program: null")
assert_identical(
  program_null_response$code,
  "invalid_request",
  "R normalized params.program: null incorrectly"
)
assert_identical(
  program_null_response$requestId,
  program_null_request_id,
  "R lost request correlation while rejecting params.program: null"
)
assert_identical(
  serialize(source_environment$by_example_adversarial, NULL, version = 3L),
  serialize(by_example_adversarial_before, NULL, version = 3L),
  "rejecting params.program: null mutated the source"
)
program_null_retry_step <- adversarial_valid_step(
  "by-example-program-null-retry",
  "program null retry"
)
program_null_retry <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_adversarial_session,
    revision = adversarial_revision,
    step = program_null_retry_step,
    page = page_window()
  )
)
assert_identical(
  program_null_retry$kind,
  "stepPreview",
  "rejecting params.program: null left a hidden draft"
)
program_null_retry_discard <- dispatch(
  "discardDraft",
  list(
    sessionId = by_example_adversarial_session,
    revision = program_null_retry$revision,
    page = page_window()
  )
)
adversarial_revision <- program_null_retry_discard$revision
assert_identical(
  serialize(source_environment$by_example_adversarial, NULL, version = 3L),
  serialize(by_example_adversarial_before, NULL, version = 3L),
  "the valid retry after params.program: null mutated the source"
)

negative_zero_step <- adversarial_valid_step("by-example-negative-zero", "negative zero")
negative_zero_step$params$examples[[1L]]$output <- 0L
negative_zero_step$params$examples[[2L]]$output <- 0L
negative_zero_request <- jsonlite::toJSON(
  list(
    transportVersion = 14L,
    requestId = "b8b8b8b8-b8b8-48b8-88b8-b8b8b8b8b8b8",
    kind = "previewStep",
    payload = list(
      sessionId = by_example_adversarial_session,
      revision = adversarial_revision,
      step = negative_zero_step,
      page = page_window()
    )
  ),
  auto_unbox = TRUE,
  null = "null",
  na = "null",
  digits = 17L
)
negative_zero_request <- as.character(negative_zero_request)
for (negative_zero_token in c("-0", "-0.0", "-0e0", "-0.000e+9")) {
  raw_negative_zero_request <- sub(
    '"output":0',
    paste0('"output":', negative_zero_token),
    negative_zero_request,
    fixed = TRUE
  )
  negative_zero_response <- jsonlite::fromJSON(
    agent$dispatch_json(raw_negative_zero_request),
    simplifyVector = FALSE
  )
  assert_identical(
    negative_zero_response$kind,
    "error",
    sprintf("R accepted a non-portable %s example", negative_zero_token)
  )
  assert_identical(
    negative_zero_response$code,
    "invalid_request",
    sprintf("R normalized a non-portable %s example incorrectly", negative_zero_token)
  )
}
escaped_negative_zero_request <- sub(
  '"output":0',
  '"output":-0',
  negative_zero_request,
  fixed = TRUE
)
escaped_negative_zero_request <- sub(
  '"requestId":"b',
  '"requestId":"\\u0062',
  escaped_negative_zero_request,
  fixed = TRUE
)
escaped_negative_zero_response <- jsonlite::fromJSON(
  agent$dispatch_json(escaped_negative_zero_request),
  simplifyVector = FALSE
)
assert_identical(
  escaped_negative_zero_response$requestId,
  "b8b8b8b8-b8b8-48b8-88b8-b8b8b8b8b8b8",
  "R lost an escaped request ID while rejecting raw negative zero"
)

negative_exponent_request <- gsub(
  '"output":0',
  '"output":1e-0',
  negative_zero_request,
  fixed = TRUE
)
negative_exponent_response <- jsonlite::fromJSON(
  agent$dispatch_json(negative_exponent_request),
  simplifyVector = FALSE
)
assert_identical(
  negative_exponent_response$kind,
  "stepPreview",
  "the raw negative-zero scanner rejected an exponent minus sign"
)
negative_exponent_discard <- dispatch(
  "discardDraft",
  list(
    sessionId = by_example_adversarial_session,
    revision = negative_exponent_response$revision,
    page = page_window()
  )
)
adversarial_revision <- negative_exponent_discard$revision

negative_zero_string_step <- adversarial_valid_step(
  "by-example-negative-zero-string",
  "literal -0 string"
)
negative_zero_string_step$params$examples[[1L]]$output <- "escaped \"-0\" text"
negative_zero_string_step$params$examples[[2L]]$output <- "escaped \"-0\" text"
negative_zero_string_preview <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_adversarial_session,
    revision = adversarial_revision,
    step = negative_zero_string_step,
    page = page_window()
  )
)
assert_identical(
  negative_zero_string_preview$kind,
  "stepPreview",
  "the raw negative-zero scanner inspected JSON string contents"
)
negative_zero_string_discard <- dispatch(
  "discardDraft",
  list(
    sessionId = by_example_adversarial_session,
    revision = negative_zero_string_preview$revision,
    page = page_window()
  )
)
adversarial_revision <- negative_zero_string_discard$revision

structural_negative_zero_cases <- list(
  list(
    request_id = "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1",
    field = "start",
    label = "slice start",
    program = list(
      kind = "slice",
      input = list(kind = "column", column = adversarial_reference(1L)),
      start = 0L,
      stop = 1L
    )
  ),
  list(
    request_id = "c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2",
    field = "stop",
    label = "slice stop",
    program = list(
      kind = "slice",
      input = list(kind = "column", column = adversarial_reference(1L)),
      start = 0L,
      stop = 0L
    )
  ),
  list(
    request_id = "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3",
    field = "index",
    label = "split index",
    program = list(
      kind = "split",
      input = list(kind = "column", column = adversarial_reference(1L)),
      delimiter = "p",
      index = 0L
    )
  ),
  list(
    request_id = "c4c4c4c4-c4c4-44c4-84c4-c4c4c4c4c4c4",
    field = "group",
    label = "regex-extract group",
    program = list(
      kind = "regexExtract",
      input = list(kind = "column", column = adversarial_reference(1L)),
      pattern = "(.*)",
      group = 0L
    )
  )
)
for (case in structural_negative_zero_cases) {
  step <- adversarial_valid_step(
    paste0("by-example-negative-zero-", case$field),
    paste0("negative zero ", case$field)
  )
  step$params$program <- case$program
  request <- as.character(jsonlite::toJSON(
    list(
      transportVersion = 14L,
      requestId = case$request_id,
      kind = "previewStep",
      payload = list(
        sessionId = by_example_adversarial_session,
        revision = adversarial_revision,
        step = step,
        page = page_window()
      )
    ),
    auto_unbox = TRUE,
    null = "null",
    na = "null",
    digits = 17L
  ))
  marker <- sprintf('"%s":0', case$field)
  by_example_assert(
    grepl(marker, request, fixed = TRUE),
    sprintf("the raw %s negative-zero fixture lost its field", case$label)
  )
  request <- sub(marker, sprintf('"%s":-0.0', case$field), request, fixed = TRUE)
  response <- jsonlite::fromJSON(agent$dispatch_json(request), simplifyVector = FALSE)
  assert_identical(response$kind, "error", sprintf("R accepted negative zero for %s", case$label))
  assert_identical(
    response$code,
    "invalid_request",
    sprintf("R normalized negative zero for %s incorrectly", case$label)
  )
  assert_identical(
    source_environment$by_example_adversarial,
    by_example_adversarial_before,
    sprintf("negative zero for %s mutated the source", case$label)
  )
}

nul_step <- adversarial_valid_step("by-example-nul", "nul-safe")
nul_request <- jsonlite::toJSON(
  list(
    transportVersion = 14L,
    requestId = "b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7",
    kind = "previewStep",
    payload = list(
      sessionId = by_example_adversarial_session,
      revision = adversarial_revision,
      step = nul_step,
      page = page_window()
    )
  ),
  auto_unbox = TRUE,
  null = "null",
  na = "null",
  digits = 17L
)
nul_request <- sub(
  '"newColumn":"nul-safe"',
  paste0('"newColumn":"nul', "\\u0000", 'unsafe"'),
  as.character(nul_request),
  fixed = TRUE
)
nul_request <- sub(
  '"requestId":"b',
  '"requestId":"\\u0062',
  nul_request,
  fixed = TRUE
)
nul_response <- jsonlite::fromJSON(agent$dispatch_json(nul_request), simplifyVector = FALSE)
assert_identical(nul_response$kind, "error", "R accepted a raw JSON U+0000 escape")
assert_identical(nul_response$code, "invalid_request", "R normalized a raw JSON U+0000 escape incorrectly")
assert_identical(
  nul_response$requestId,
  "b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7",
  "R lost request correlation while rejecting raw JSON U+0000"
)
nul_retry <- dispatch(
  "previewStep",
  list(
    sessionId = by_example_adversarial_session,
    revision = adversarial_revision,
    step = nul_step,
    page = page_window()
  )
)
assert_identical(nul_retry$kind, "stepPreview", "raw JSON U+0000 rejection left a hidden R draft")
invisible(dispatch(
  "discardDraft",
  list(sessionId = by_example_adversarial_session, revision = nul_retry$revision, page = page_window())
))
assert_identical(
  source_environment$by_example_adversarial,
  by_example_adversarial_before,
  "adversarial R by-example validation mutated its source"
)
invisible(dispatch("closeSession", list(sessionId = by_example_adversarial_session)))

source_environment$by_example_overflow_safe <- data.frame(
  wide = bit64::as.integer64(c("1", "2")),
  check.names = FALSE
)
overflow_safe_before <- unserialize(serialize(source_environment$by_example_overflow_safe, NULL, version = 3L))
overflow_safe_session <- "c7c7c7c7-c7c7-47c7-87c7-c7c7c7c7c7c7"
assert_identical(
  dispatch(
    "openSession",
    list(sessionId = overflow_safe_session, variableName = "by_example_overflow_safe", page = page_window())
  )$kind,
  "page",
  "the exact-overflow control session did not open"
)
overflow_safe_step <- list(
  id = "by-example-overflow-step",
  kind = "byExample",
  params = list(
    sourceColumns = I(list(list(id = "r:c:0", name = "wide"))),
    newColumn = "wide plus one",
    examples = I(list(
      list(inputs = I(list(1L)), output = 2L),
      list(inputs = I(list(2L)), output = 3L)
    ))
  )
)
overflow_safe_preview <- dispatch(
  "previewStep",
  list(sessionId = overflow_safe_session, revision = 0L, step = overflow_safe_step, page = page_window())
)
assert_identical(overflow_safe_preview$kind, "stepPreview", "the exact-overflow control did not preview")
overflow_safe_apply <- dispatch(
  "applyDraft",
  list(sessionId = overflow_safe_session, revision = overflow_safe_preview$revision, page = page_window())
)
overflow_safe_environment <- new.env(parent = baseenv())
assign("by_example_overflow_safe", overflow_safe_before, envir = overflow_safe_environment)
eval(parse(text = overflow_safe_apply$code), envir = overflow_safe_environment)
assert_identical(
  integer64_character(get("open_wrangler_result", envir = overflow_safe_environment)$`wide plus one`),
  c("2", "3"),
  "generated exact-overflow control arithmetic diverged"
)
invisible(dispatch("closeSession", list(sessionId = overflow_safe_session)))

overflow_source <- data.frame(
  wide = bit64::as.integer64("9223372036854775807"),
  check.names = FALSE
)
source_environment$by_example_overflow_live <- overflow_source
overflow_source_before <- unserialize(serialize(overflow_source, NULL, version = 3L))
overflow_live_session <- "c8c8c8c8-c8c8-48c8-88c8-c8c8c8c8c8c8"
assert_identical(
  dispatch(
    "openSession",
    list(sessionId = overflow_live_session, variableName = "by_example_overflow_live", page = page_window())
  )$kind,
  "page",
  "the live exact-overflow session did not open"
)
overflow_live_step <- overflow_safe_preview$retainedStep
overflow_live_response <- dispatch(
  "previewStep",
  list(sessionId = overflow_live_session, revision = 0L, step = overflow_live_step, page = page_window())
)
assert_identical(overflow_live_response$kind, "error", "live exact by-example arithmetic silently overflowed")
assert_identical(
  source_environment$by_example_overflow_live,
  overflow_source_before,
  "failed live exact by-example arithmetic mutated its source"
)
overflow_live_retry <- dispatch(
  "previewStep",
  list(
    sessionId = overflow_live_session,
    revision = 0L,
    step = list(
      id = "by-example-overflow-retry",
      kind = "byExample",
      params = list(
        sourceColumns = I(list(list(id = "r:c:0", name = "wide"))),
        newColumn = "safe literal",
        examples = I(list(
          list(inputs = I(list(1L)), output = "ok"),
          list(inputs = I(list(2L)), output = "ok")
        ))
      )
    ),
    page = page_window()
  )
)
assert_identical(overflow_live_retry$kind, "stepPreview", "live exact overflow left a hidden draft")
invisible(dispatch(
  "discardDraft",
  list(sessionId = overflow_live_session, revision = overflow_live_retry$revision, page = page_window())
))
invisible(dispatch("closeSession", list(sessionId = overflow_live_session)))

overflow_generated_environment <- new.env(parent = baseenv())
assign("by_example_overflow_safe", overflow_source_before, envir = overflow_generated_environment)
generated_overflow_error <- tryCatch(
  {
    eval(parse(text = overflow_safe_apply$code), envir = overflow_generated_environment)
    NULL
  },
  error = function(error) error
)
by_example_assert(inherits(generated_overflow_error, "error"), "generated exact by-example arithmetic silently overflowed")
by_example_assert(
  !exists("open_wrangler_result", envir = overflow_generated_environment, inherits = FALSE),
  "generated exact by-example overflow published a partial result"
)
assert_identical(
  get("by_example_overflow_safe", envir = overflow_generated_environment, inherits = FALSE),
  overflow_source_before,
  "generated exact by-example overflow mutated its source"
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
  capture_categorical_result = function(...) stop("unexpected categorical capture", call. = FALSE),
  capture_custom_code_result = function(...) stop("unexpected custom-code capture", call. = FALSE),
  capture_group_result = function(...) stop("unexpected grouped capture", call. = FALSE),
  capture_live_frame = function(source_reader) {
    stop(structure(
      list(message = "example package is required", call = NULL, code = "missing-package"),
      class = c("openwrangler_r_frame_error", "error", "condition")
    ))
  },
  isolate_capture = function(...) stop("unexpected isolated capture", call. = FALSE),
  isolate_custom_code_input = function(...) stop("unexpected custom-code isolation", call. = FALSE),
  rename_column = function(...) stop("unexpected rename", call. = FALSE),
  rename_column_at = function(...) stop("unexpected rename", call. = FALSE),
  clone_column_at = function(...) stop("unexpected clone", call. = FALSE),
  by_example_column_at = function(...) stop("unexpected by-example transform", call. = FALSE),
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
missing_by_example_contract <- missing_package_contract
missing_by_example_contract$by_example_column_at <- NULL
missing_by_example_error <- tryCatch(
  {
    openwrangler_r_kernel_agent$new_agent(missing_by_example_contract, source_environment)
    NULL
  },
  error = function(error) error
)
by_example_assert(
  inherits(missing_by_example_error, "error"),
  "the R agent accepted a contract without by_example_column_at"
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

source("r/tests/kernel_agent_custom_code.R", local = FALSE)

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
