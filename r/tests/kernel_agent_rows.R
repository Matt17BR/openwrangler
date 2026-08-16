# Row-operation kernel-agent contract cases.

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
