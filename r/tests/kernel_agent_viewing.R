# Native-R viewing, profiling, and live-source session contract cases.

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

# Keep malformed JSON shapes intact until the native decoder sees them.
local({
  source <- new.env(parent = emptyenv())
  source$view_frame <- data.frame(value = c(1, NA, 3))
  before <- serialize(source$view_frame, NULL)
  boundary_agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, source)
  on.exit(boundary_agent$dispose())
  id <- "92929292-9292-4292-8292-929292929292"
  send <- function(kind, payload) {
    request <- list(transportVersion = 14L, requestId = request_id, kind = kind, payload = payload)
    jsonlite::fromJSON(boundary_agent$dispatch_json(as.character(jsonlite::toJSON(
      request, auto_unbox = TRUE, digits = 17L, null = "null", na = "null"
    ))), simplifyVector = FALSE)
  }
  window <- function(view = '{"filters":[],"sorts":[]}') {
    list(rowOffset = 0L, rowLimit = 3L, columnOffset = 0L, columnLimit = 1L,
         view = jsonlite::fromJSON(view, simplifyVector = FALSE))
  }
  opened <- send("openSession", list(sessionId = id, variableName = "view_frame", page = window()))
  assert_identical(opened$kind, "page", "view-admission source did not open")
  filter_prefix <- '{"column":{"id":"r:c:0","name":"value"},"type":"float",'
  malformed_views <- c(
    '{"filters":{},"sorts":[]}',
    '{"filters":[],"sorts":[],"logic":null}',
    '{"filters":[],"sorts":[],"logic":[]}',
    '{"filters":[],"sorts":[],"logic":{}}',
    paste0('{"filters":[', filter_prefix, '"predicates":{}}],"sorts":[]}'),
    paste0('{"filters":[', filter_prefix, '"predicates":[],"logic":null}],"sorts":[]}'),
    paste0('{"filters":[', filter_prefix, '"predicates":[],"logic":[]}],"sorts":[]}'),
    paste0('{"filters":[', filter_prefix, '"predicates":[],"valueFilter":',
           '{"kind":"values","selectedValues":{},"includeNulls":false,"includeNaN":false}}],"sorts":[]}')
  )
  for (operator in c("null", "[]", "{}", '["gte"]')) {
    malformed_views <- c(malformed_views, paste0('{"filters":[', filter_prefix,
      '"predicates":[{"kind":"predicate","operator":', operator, ',"value":1}]}],"sorts":[]}'))
  }
  for (view in malformed_views) {
    result <- send("getPage", list(sessionId = id, page = window(view)))
    assert_identical(result$kind, "error", "malformed R view was accepted")
    assert_identical(result$code, "invalid_request", "malformed R view escaped structural admission")
    assert_identical(result$requestId, request_id, "malformed R view lost correlation")
  }
  for (view in malformed_views[c(1L, 2L, 5L, 8L)]) {
    model <- window(view)$view
    names(model)[names(model) == "sorts"] <- "sort"
    result <- send("previewStep", list(sessionId = id, revision = 0L,
      step = list(id = "invalid-filter", kind = "filterRows", params = list(filterModel = model)), page = window()))
    assert_identical(result$code, "invalid_request", "malformed FilterRows model published a draft")
  }
  for (search in list(NULL, "")) {
    result <- send("getColumnValues", list(sessionId = id, column = list(id = "r:c:0", name = "value"),
      view = window()$view, search = search, limit = 3L))
    assert_identical(result$kind, "columnValues", "R nullable picker search changed")
  }
  recovered <- send("getPage", list(sessionId = id, page = window()))
  assert_identical(recovered$page, opened$page, "malformed views changed the confirmed R source page")

  valid_view <- paste0('{"filters":[', filter_prefix,
    '"predicates":[{"kind":"predicate","operator":"equals","value":3}]}],"sorts":[]}')
  model <- window(valid_view)$view
  names(model)[names(model) == "sorts"] <- "sort"
  preview <- send("previewStep", list(sessionId = id, revision = 0L,
    step = list(id = "valid-filter", kind = "filterRows", params = list(filterModel = model)), page = window()))
  assert_identical(preview$kind, "stepPreview", "valid FilterRows did not recover after malformed requests")
  assert_identical(preview$revision, 1L, "malformed requests advanced the R revision")
  failed_apply <- send("applyDraft", list(sessionId = id, revision = 1L, page = window(malformed_views[[5L]])))
  assert_identical(failed_apply$code, "invalid_request", "malformed apply page was accepted")
  assert_identical(failed_apply$requestId, request_id, "malformed apply lost correlation")
  applied <- send("applyDraft", list(sessionId = id, revision = 1L, page = window()))
  assert_identical(applied$kind, "planUpdated", "malformed apply consumed the retained draft")
  assert_identical(applied$revision, 2L, "malformed apply advanced the revision")
  assert_identical(applied$page, preview$page, "valid apply changed the retained draft rows or metadata")
  generated <- new.env(parent = globalenv())
  generated$view_frame <- source$view_frame
  eval(parse(text = applied$code), envir = generated)
  assert_identical(generated$open_wrangler_result, source$view_frame[3L, , drop = FALSE],
    "generated FilterRows disagrees after malformed apply recovery")
  assert_identical(serialize(source$view_frame, NULL), before, "view admission changed the R source")
  closed <- send("closeSession", list(sessionId = id))
  assert_identical(closed$kind, "closed", "view-admission session did not close")
})
