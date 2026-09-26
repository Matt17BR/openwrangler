# Native-R viewing, profiling, and live-source session contract cases.

local({
  frame_runtime <- environment(openwrangler_r_frame_contract$materialize_view_page)
  native_filter_rows <- get("filter_row_positions", frame_runtime, inherits = FALSE)
  scans <- 0L
  native_sort_rows <- get("build_sorted_row_positions", frame_runtime, inherits = FALSE)
  sorts <- 0L
  assign("build_sorted_row_positions", function(...) {
    sorts <<- sorts + 1L
    native_sort_rows(...)
  }, frame_runtime)
  on.exit(assign("build_sorted_row_positions", native_sort_rows, frame_runtime), add = TRUE)
  assign("filter_row_positions", function(frame, descriptor, resolved) {
    if (length(resolved$filters) != 0L) scans <<- scans + 1L
    native_filter_rows(frame, descriptor, resolved)
  }, frame_runtime)
  on.exit(assign("filter_row_positions", native_filter_rows, frame_runtime), add = TRUE)
  sources <- new.env(parent = baseenv())
  sources$.ow_csv_source <- data.table::data.table(label = c("alpha", "beta", "none", NA_character_),
    value = c(4L, 1L, 9L, 7L), tied = c(1L, 1L, 2L, 2L))
  source_before <- serialize(sources$.ow_csv_source, NULL)
  path <- tempfile(fileext = ".csv")
  writeLines("label,value\nalpha,4", path)
  on.exit(unlink(path), add = TRUE)
  contract <- openwrangler_r_frame_contract
  native_new_cache <- contract$new_file_filter_cache
  cache <- NULL
  cache_count <- 0L
  contract$new_file_filter_cache <- function() {
    cache_count <<- cache_count + 1L
    cache <<- native_new_cache()
    cache
  }
  file_agent <- openwrangler_r_kernel_agent$new_agent(contract, sources,
    file_source = list(path = path, format = "csv", header = TRUE, delimiter = ",", encoding = "utf-8", quoteChar = "\""))
  on.exit(file_agent$dispose(), add = TRUE)
  send <- function(kind, payload) dispatch_with(file_agent, kind, payload)
  text_filter <- function(value) list(column = list(id = "r:c:0", name = "label"), type = "string",
    predicates = I(list(list(kind = "predicate", operator = "contains", value = value))))
  filtered_window <- function(value = "a", direction = "asc") page_window(
    sorts = list(list(column = list(id = "r:c:1", name = "value"), direction = direction, nulls = "last")),
    filters = list(text_filter(value)), row_limit = 2L)
  opened <- send("openSession", list(sessionId = session_id, variableName = ".ow_csv_source", page = page_window()))
  assert_identical(opened$kind, "page", "managed filter fixture did not open")
  first <- send("getPage", list(sessionId = session_id, page = filtered_window()))
  assert_identical(vapply(first$page$page$rows, `[[`, character(1L), "id"), c("r:r:1", "r:r:0"),
    "filtered sorting changed stable source row identities")
  first_scan_count <- scans
  first_sort_count <- sorts
  later_window <- filtered_window()
  later_window$rowOffset <- 1L
  later_window$columnOffset <- 1L
  later_window$columnLimit <- 1L
  later <- send("getPage", list(sessionId = session_id, page = later_window))
  assert_identical(vapply(later$page$page$rows, `[[`, character(1L), "id"), "r:r:0",
    "a later projected page changed the filtered order")
  assert_identical(sorts, first_sort_count, "a repeated managed page rebuilt the same filtered order")
  repeated <- send("getPage", list(sessionId = session_id, page = filtered_window(direction = "desc")))
  assert_identical(vapply(repeated$page$page$rows, `[[`, character(1L), "id"), c("r:r:0", "r:r:1"),
    "changing sort reused the previous row order")
  assert_identical(scans, first_scan_count, "repeated managed filtering rescanned source values")
  assert_identical(sorts, first_sort_count + 1L, "changed sort rules reused an incompatible order")
  tied_window <- filtered_window()
  tied_window$view$sorts[[1L]]$column <- list(id = "r:c:2", name = "tied")
  send("getPage", list(sessionId = session_id, page = filtered_window()))
  tied <- send("getPage", list(sessionId = session_id, page = tied_window))
  assert_identical(vapply(tied$page$page$rows, `[[`, character(1L), "id"), c("r:r:0", "r:r:1"),
    "sort ties inherited the previous view order instead of capture order")
  send("getPage", list(sessionId = session_id, page = filtered_window()))
  retained_sort_count <- sorts
  reference <- I(list(list(id = "r:c:1", name = "value")))
  view <- filtered_window()$view
  summary <- send("getSummary", list(sessionId = session_id, columns = reference, view = view))
  assert_identical(summary$summaries[[1L]]$totalCount, 2L, "the profile changed cached membership")
  assert_identical(summary$summaries[[1L]]$numeric$min, 1L, "the cached profile minimum changed")
  assert_identical(summary$summaries[[1L]]$numeric$max, 4L, "the cached profile maximum changed")
  assert_identical(vapply(summary$summaries[[1L]]$topValues, `[[`, character(1L), "value"), c("4", "1"),
    "a sorted page changed profile first-occurrence order")
  stats <- send("getDatasetStats", list(sessionId = session_id, view = view))
  assert_identical(stats$totalRows, 2L, "dataset statistics changed cached membership")
  values <- send("getColumnValues", list(sessionId = session_id, column = reference[[1L]], view = view, search = NULL, limit = 10L))
  assert_identical(values$kind, "columnValues", "cached column values failed")
  assert_identical(send("beginSummary", list(sessionId = session_id, summaryId = "01234567-0123-4123-8123-012345678901",
    columns = reference, view = view))$kind, "summaryComplete", "continued summary did not use the filtered view")
  assert_identical(send("beginDatasetStats", list(sessionId = session_id, statsId = "01234567-0123-4123-8123-012345678902",
    view = view))$kind, "datasetStatsComplete", "continued statistics did not use the filtered view")
  assert_identical(scans, first_scan_count, "page and profile owners did not share filtered membership")
  send("getPage", list(sessionId = session_id, page = filtered_window()))
  assert_identical(sorts, retained_sort_count, "sort-ignoring reads discarded reusable page order")

  retained_rows <- cache$rows
  retained_sorts <- cache$sorts
  tracked_sort_rows <- get("build_sorted_row_positions", frame_runtime, inherits = FALSE)
  assign("build_sorted_row_positions", function(...) stop("expected sorting failure"), frame_runtime)
  failed_sort <- send("getPage", list(sessionId = session_id, page = filtered_window(direction = "desc")))
  assign("build_sorted_row_positions", tracked_sort_rows, frame_runtime)
  assert_identical(failed_sort$kind, "error", "the sort failure fixture did not fail")
  assert_identical(cache$rows, retained_rows, "a failed sort replaced cached positions")
  assert_identical(cache$sorts, retained_sorts, "a failed sort replaced cached rules")

  # The sole filtered column's picker requests an empty filter view.
  picker_view <- filtered_window()$view
  picker_view$filters <- I(list())
  before <- scans
  before_sorts <- sorts
  picker <- send("getColumnValues", list(sessionId = session_id, column = list(id = "r:c:0", name = "label"),
    view = picker_view, search = NULL, limit = 10L))
  assert_identical(picker$kind, "columnValues", "the unfiltered picker failed")
  assert_identical(vapply(picker$values, `[[`, character(1L), "value"), c("alpha", "beta", "none"),
    "the unfiltered picker reused the grid's filtered population")
  assert_identical(vapply(picker$values, `[[`, integer(1L), "count"), c(1L, 1L, 1L),
    "the unfiltered picker changed value counts")
  searched <- send("getColumnValues", list(sessionId = session_id, column = list(id = "r:c:0", name = "label"),
    view = picker_view, search = "none", limit = 10L))
  assert_identical(searched$values, picker$values[3L], "the searched picker lost a value outside the grid filter")
  after_picker <- send("getPage", list(sessionId = session_id, page = filtered_window()))
  assert_identical(scans, before, "the auxiliary picker discarded reusable filter membership")
  assert_identical(sorts, before_sorts, "the auxiliary picker discarded reusable page order")
  assert_identical(vapply(after_picker$page$page$rows, `[[`, character(1L), "id"), c("r:r:1", "r:r:0"),
    "the auxiliary picker changed the retained grid order")
  assert_identical(cache$rows, retained_rows, "the auxiliary picker replaced cached positions")
  assert_identical(cache$sorts, retained_sorts, "the auxiliary picker replaced cached rules")

  nonempty_picker <- send("getColumnValues", list(sessionId = session_id, column = list(id = "r:c:0", name = "label"),
    view = filtered_window("none")$view, search = NULL, limit = 10L))
  assert_identical(nonempty_picker$values, searched$values, "a nonempty auxiliary query changed its population")
  assert_identical(cache$rows, 3L, "a nonempty auxiliary query did not replace cached membership")
  empty_summary <- send("getSummary", list(sessionId = session_id, columns = reference, view = picker_view))
  assert_identical(empty_summary$summaries[[1L]]$totalCount, 4L, "an empty profile reused filtered membership")
  assert_identical(is.null(cache$capture) && is.null(cache$sorts), TRUE, "an empty profile retained filtered membership")
  send("getPage", list(sessionId = session_id, page = filtered_window()))

  # A cache hit must still read and validate the current source's structure.
  data.table::setnames(sources$.ow_csv_source, "value", "changed")
  assert_identical(send("getPage", list(sessionId = session_id, page = filtered_window()))$kind,
    "error", "cached membership bypassed source validation")
  data.table::setnames(sources$.ow_csv_source, "changed", "value")
  retained_capture <- cache$capture
  assert_identical(send("openSession", list(sessionId = second_session_id, variableName = ".ow_csv_source", page = page_window()))$kind,
    "page", "the second managed session did not open")
  assert_identical(identical(cache$capture, retained_capture), TRUE, "opening a session replaced the established cache owner")
  before <- scans
  send("getPage", list(sessionId = second_session_id, page = filtered_window()))
  assert_identical(scans, before + 1L, "different capture identities shared cached membership")
  send("getPage", list(sessionId = session_id, page = filtered_window()))
  assert_identical(scans, before + 2L, "the agent retained more than one filter entry")

  before <- scans
  zero <- send("getPage", list(sessionId = session_id, page = filtered_window("absent")))
  assert_identical(zero$page$page$totalRows, 0L, "an empty filter result changed")
  send("getPage", list(sessionId = session_id, page = filtered_window("absent")))
  assert_identical(scans, before + 1L, "empty membership was not cached")
  send("getPage", list(sessionId = session_id, page = page_window()))
  assert_identical(is.null(cache$capture) && is.null(cache$key) && length(cache$rows) == 0L && is.null(cache$sorts), TRUE,
    "an unfiltered read retained the previous filter owner")
  send("getPage", list(sessionId = session_id, page = filtered_window("absent")))
  assert_identical(scans, before + 2L, "an empty query did not release membership")

  # Charge the resolved key as well as indices without allocating a huge fixture.
  send("getPage", list(sessionId = session_id, page = filtered_window()))
  maximum_bytes <- get("maximum_file_filter_cache_bytes", frame_runtime, inherits = FALSE)
  on.exit(assign("maximum_file_filter_cache_bytes", maximum_bytes, frame_runtime), add = TRUE)
  stopifnot(maximum_bytes <= 64 * 1024^2)
  assign("maximum_file_filter_cache_bytes", as.numeric(object.size(cache$rows)), frame_runtime)
  contract$clear_file_filter_cache(cache)
  before <- scans
  for (attempt in seq_len(2L)) {
    bounded <- send("getPage", list(sessionId = session_id, page = filtered_window()))
    assert_identical(bounded$page$page$totalRows, 2L, "uncached fallback changed membership")
    assert_identical(is.null(cache$capture) && is.null(cache$key), TRUE, "over-budget membership retained its owner")
  }
  assert_identical(scans, before + 2L, "over-budget membership incorrectly reused a cache entry")
  assign("maximum_file_filter_cache_bytes", maximum_bytes, frame_runtime)
  send("getPage", list(sessionId = session_id, page = page_window(filters = list(text_filter("a")))))
  membership_rows <- cache$rows
  assign("maximum_file_filter_cache_bytes", as.numeric(object.size(cache$rows)) + as.numeric(object.size(cache$key)), frame_runtime)
  bounded_sort <- send("getPage", list(sessionId = session_id, page = filtered_window()))
  assert_identical(vapply(bounded_sort$page$page$rows, `[[`, character(1L), "id"), c("r:r:1", "r:r:0"),
    "sort-rule budget fallback changed row order")
  assert_identical(cache$rows, membership_rows, "sort-rule metadata displaced admitted membership")
  assert_identical(is.null(cache$sorts), TRUE, "over-budget sort rules were retained")
  assign("maximum_file_filter_cache_bytes", maximum_bytes, frame_runtime)
  assert_identical(serialize(sources$.ow_csv_source, NULL), source_before, "cached viewing changed source storage")

  # Custom Code can call an ambient callback that changes shared values before it fails.
  sources$mutate_source <- function() data.table::set(sources$.ow_csv_source, i = 3L, j = "label", value = "gamma")
  send("getPage", list(sessionId = session_id, page = filtered_window()))
  before <- scans
  failed <- send("previewStep", list(sessionId = second_session_id, revision = 0L,
    step = list(id = "failed-shared-mutation", kind = "customCode",
      params = list(code = "mutate_source(); stop('expected failure after source change'); result <- df")),
    page = page_window()))
  assert_identical(failed$kind, "error", "the source-changing Custom Code fixture did not fail")
  assert_identical(sources$.ow_csv_source$label[[3L]], "gamma", "the failing callback did not change shared values")
  changed <- send("getPage", list(sessionId = session_id, page = filtered_window()))
  assert_identical(changed$page$page$totalRows, 3L, "failed cross-session Custom Code left stale membership")
  assert_identical(scans, before + 1L, "failed cross-session Custom Code did not invalidate before execution")

  # Ordinary live sessions must continue reading same-schema by-reference changes.
  live_sources <- new.env(parent = baseenv())
  live_sources$frame <- data.table::data.table(label = c("alpha", "none"), value = 1:2)
  live <- openwrangler_r_kernel_agent$new_agent(contract, live_sources)
  on.exit(live$dispose(), add = TRUE)
  assert_identical(cache_count, 1L, "an ordinary live session allocated a managed-file cache")
  dispatch_with(live, "openSession", list(sessionId = session_id, variableName = "frame", page = page_window()))
  before <- scans
  assert_identical(dispatch_with(live, "getPage", list(sessionId = session_id, page = filtered_window()))$page$page$totalRows,
    1L, "live filter fixture changed")
  data.table::set(live_sources$frame, i = 2L, j = "label", value = "beta")
  assert_identical(dispatch_with(live, "getPage", list(sessionId = session_id, page = filtered_window()))$page$page$totalRows,
    2L, "live same-schema mutation reused stale membership")
  assert_identical(scans, before + 2L, "live filtering unexpectedly reused managed membership")

  agent_runtime <- environment(openwrangler_r_kernel_agent$new_agent)
  native_preflight <- get("preflight_response", agent_runtime, inherits = FALSE)
  on.exit(assign("preflight_response", native_preflight, agent_runtime), add = TRUE)
  assign("preflight_response", function(response) {
    if (identical(response$kind, "closed")) stop("expected close preflight failure", call. = FALSE)
    native_preflight(response)
  }, agent_runtime)
  assert_identical(send("closeSession", list(sessionId = second_session_id))$kind, "error", "the close preflight fixture did not fail")
  assert_identical(is.null(cache$capture) && is.null(cache$key) && length(cache$rows) == 0L && is.null(cache$sorts), TRUE,
    "failed close preflight retained the agent's filter owner")
  assign("preflight_response", native_preflight, agent_runtime)
  send("closeSession", list(sessionId = second_session_id))
  send("getPage", list(sessionId = session_id, page = filtered_window()))
  agent_environment <- environment(file_agent$dispose)
  exports <- get("export_lifecycle", agent_environment, inherits = FALSE)
  native_dispose <- exports$dispose
  exports$dispose <- function() stop("expected export disposal failure", call. = FALSE)
  assign("export_lifecycle", exports, agent_environment)
  disposal <- tryCatch(file_agent$dispose(), error = identity)
  exports$dispose <- native_dispose
  assign("export_lifecycle", exports, agent_environment)
  assert_identical(inherits(disposal, "error"), TRUE, "the export cleanup fixture did not fail")
  assert_identical(is.null(cache$capture) && is.null(cache$key) && length(cache$rows) == 0L && is.null(cache$sorts), TRUE,
    "failed export cleanup retained the agent's filter owner")

  # In-flight jobs retain their own fixed membership when later pages replace it.
  sources$.ow_csv_source <- data.table::data.table(label = rep(c("a", "b"), length.out = 200001L), value = seq_len(200001L))
  native_summary_advance <- contract$advance_summary
  native_stats_advance <- contract$advance_dataset_stats
  contract$advance_summary <- function(state, ...) native_summary_advance(state, maximum_chunks = 1L)
  contract$advance_dataset_stats <- function(state, ...) native_stats_advance(state, maximum_chunks = 1L)
  pending_agent <- openwrangler_r_kernel_agent$new_agent(contract, sources,
    file_source = list(path = path, format = "csv", header = TRUE, delimiter = ",", encoding = "utf-8", quoteChar = "\""))
  on.exit(pending_agent$dispose(), add = TRUE)
  pending_send <- function(kind, payload) dispatch_with(pending_agent, kind, payload)
  pending_send("openSession", list(sessionId = session_id, variableName = ".ow_csv_source", page = page_window(row_limit = 1L)))
  summary_id <- "01234567-0123-4123-8123-012345678903"
  stats_id <- "01234567-0123-4123-8123-012345678904"
  pending_window <- filtered_window(direction = "desc")
  pending_view <- pending_window$view
  before <- scans
  assert_identical(pending_send("getPage", list(sessionId = session_id, page = pending_window))$page$page$rows[[1L]]$id,
    "r:r:200000", "the pending fixture did not establish descending page order")
  assert_identical(pending_send("beginSummary", list(sessionId = session_id, summaryId = summary_id, columns = reference,
    view = pending_view))$kind, "summaryPending", "the membership fixture did not yield its summary")
  assert_identical(pending_send("beginDatasetStats", list(sessionId = session_id, statsId = stats_id,
    view = pending_view))$kind, "datasetStatsPending", "the membership fixture did not yield its dataset statistics")
  assert_identical(scans, before + 1L, "concurrent profile begins rescanned identical membership")
  pending_owner <- environment(pending_agent$dispose)
  expected_rows <- seq.int(1L, 200001L, by = 2L)
  assert_identical(get(summary_id, get("pending_summaries", pending_owner))$calculation$row_positions,
    expected_rows, "the pending summary retained value-sorted positions")
  assert_identical(get(stats_id, get("pending_stats", pending_owner))$calculation$view$rows,
    expected_rows, "pending statistics retained value-sorted positions")
  assert_identical(cache$rows, rev(expected_rows), "profile setup replaced reusable page order")
  refused <- pending_send("previewStep", list(sessionId = session_id, revision = 0L,
    step = list(id = "blocked-rename", kind = "renameColumn", params = list(column = reference[[1L]], newName = "changed")),
    page = page_window(row_limit = 1L)))
  assert_identical(refused$code, "read_in_progress", "pending profiles allowed a source-reaching request")
  pending_send("getPage", list(sessionId = session_id, page = page_window(filters = list(text_filter("a")), row_limit = 1L)))
  assert_identical(scans, before + 1L, "a refused mutation evicted reusable membership")
  other_membership <- pending_send("getPage", list(sessionId = session_id,
    page = page_window(filters = list(text_filter("b")), row_limit = 1L)))
  assert_identical(other_membership$page$page$rows[[1L]]$id, "r:r:1", "the replacement filter changed source row identity")
  pending_send("getPage", list(sessionId = session_id, page = page_window(row_limit = 1L)))
  assert_identical(is.null(cache$capture) && is.null(cache$sorts), TRUE, "the pending jobs prevented empty-view cache release")
  repeat {
    summary <- pending_send("continueSummary", list(sessionId = session_id, summaryId = summary_id, revision = 0L))
    if (!identical(summary$kind, "summaryPending")) break
  }
  assert_identical(summary$kind, "summaryComplete", "the summary lost its retained membership")
  assert_identical(summary$summaries[[1L]]$totalCount, 100001L, "a later page replaced the summary population")
  assert_identical(summary$summaries[[1L]]$numeric$max, 200001L, "a later page changed the retained summary values")
  repeat {
    stats <- pending_send("continueDatasetStats", list(sessionId = session_id, statsId = stats_id, revision = 0L))
    if (!identical(stats$kind, "datasetStatsPending")) break
  }
  assert_identical(stats$kind, "datasetStatsComplete", "dataset statistics lost retained membership")
  assert_identical(stats$totalRows, 100001L, "a later page replaced the dataset-profile population")
  assert_identical(stats$stats$missingCells, 0L, "retained dataset-profile values changed")
  assert_identical(scans, before + 2L, "continuing retained jobs rescanned a replaced filter")
})

for (invalid_library in list(NULL, "pandas", 1L, list(), "")) {
  payload <- list(sessionId = session_id, variableName = "frame", page = page_window(), library = invalid_library)
  request <- list(transportVersion = 18L, requestId = request_id, kind = "openSession", payload = payload)
  invalid <- jsonlite::fromJSON(agent$dispatch_json(as.character(jsonlite::toJSON(
    request, auto_unbox = TRUE, null = "null", na = "null"
  ))), simplifyVector = FALSE)
  assert_identical(invalid$code, "invalid_request", "an invalid native library choice was accepted")
}
missing_library_request <- list(transportVersion = 18L, requestId = request_id, kind = "openSession",
  payload = list(sessionId = session_id, variableName = "frame", page = page_window()))
missing_library <- jsonlite::fromJSON(agent$dispatch_json(as.character(jsonlite::toJSON(
  missing_library_request, auto_unbox = TRUE, null = "null", na = "null"
))), simplifyVector = FALSE)
assert_identical(missing_library$code, "invalid_request", "the native boundary inferred a missing library")

opened <- dispatch(
  "openSession",
  list(sessionId = session_id, variableName = "frame", page = page_window(row_limit = 2L))
)
assert_identical(opened$kind, "page", "the R agent did not open a page session")
assert_identical(opened$library, "base", "the native open did not confirm its requested library")
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
assert_identical(scale_opened$kind, "page", "the R agent refused a frame above one million rows")
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
  "the R agent changed a large logical count"
)
scale_stats <- dispatch("getDatasetStats", list(sessionId = profile_scale_session_id, view = empty_view()))
assert_identical(scale_stats$stats$duplicateRows, 1000000L, "the R agent did not count every duplicate row")
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
assert_identical(scale_values$hasMore, FALSE, "the R agent claimed a complete value list was truncated")
assert_identical(scale_values$values[[1L]]$count, 1000001L, "the R agent did not count every value")
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

source_environment$unsupported <- data.frame(value = I(list(list(1L))))
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
assert_identical(named_rows$page$contractVersion, 7L, "the R kernel agent emitted the wrong frame contract")
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
    if (identical(kind, "openSession") && !"library" %in% names(payload)) payload$library <- "base"
    request <- list(transportVersion = 18L, requestId = request_id, kind = kind, payload = payload)
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
