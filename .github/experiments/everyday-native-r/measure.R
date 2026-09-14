# One-off synthetic runtime observations. Run from the repository root; no editor.
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 1L)
source("r/openwrangler_runtime/frame_contract.R", local = FALSE)
source("r/openwrangler_runtime/kernel_exports.R", local = FALSE)
source("r/openwrangler_runtime/kernel_agent.R", local = FALSE)
stopifnot(requireNamespace("jsonlite", quietly = TRUE))
lock <- jsonlite::fromJSON("r/dependencies/native-r-contract/ubuntu-24.04-x86_64-r-4.5.lock.json")
versions <- setNames(lapply(lock$packages$name, function(name) as.character(utils::packageVersion(name))), lock$packages$name)
stopifnot(identical(unname(unlist(versions)), lock$packages$version))
request_id <- "11111111-1111-4111-8111-111111111111"
session_id <- "22222222-2222-4222-8222-222222222222"
ids <- paste0("r:c:", 0:5)
empty_view <- list(filters = I(list()), sorts = I(list()))
page <- function(view = empty_view, limit = 200L) list(rowOffset = 0L, rowLimit = limit,
  columnOffset = 0L, columnLimit = 6L, view = view)
encode <- function(kind, payload) as.character(jsonlite::toJSON(list(
  transportVersion = openwrangler_r_kernel_agent$transport_version,
  requestId = request_id, kind = kind, payload = payload
), auto_unbox = TRUE, digits = 17L, null = "null", na = "null"))
decode <- function(text, kind) {
  value <- jsonlite::fromJSON(text, simplifyVector = FALSE)
  if (identical(value$kind, "error")) stop(sprintf("Native request failed: %s: %s", value$code, value$message))
  stopifnot(identical(value$kind, kind), identical(value$requestId, request_id),
    identical(value$sessionId, session_id))
  value
}
make_frame <- function(n) {
  i <- seq_len(n) - 1L
  data.frame(id = i,
    amount = ifelse(i %% 10L == 0L, NA_real_, as.double(i %% 1000L)),
    category = ifelse(i %% 17L == 0L, NA_character_, c("Alpha", "Beta", "Gamma")[i %% 3L + 1L]),
    active = ifelse(i %% 19L == 0L, NA, i %% 2L == 0L),
    day = as.Date("2024-01-01") + as.double(i %% 366L),
    event_at = as.POSIXct("2024-01-01", tz = "UTC") + as.double(i %% 86400L),
    stringsAsFactors = FALSE)
}
check_page <- function(result, expected, positions, total) {
  stopifnot(identical(vapply(result$page$schema, `[[`, character(1L), "name"), names(expected)),
    identical(unlist(result$page$page$columnIds, use.names = FALSE), ids),
    result$page$page$totalRows == total, length(result$page$page$rows) == length(positions))
  kinds <- c("integer", "number", "string", "boolean", "date", "datetime")
  for (row in seq_along(positions)) {
    actual <- result$page$page$rows[[row]]
    position <- positions[[row]]
    stopifnot(identical(actual$id, paste0("r:r:", position - 1L)), actual$rowNumber == row - 1L,
      length(actual$values) == 6L)
    for (column in seq_len(6L)) {
      value <- expected[[column]][[position]]
      cell <- actual$values[[column]]
      stopifnot(identical(cell$isNull, is.na(value)), identical(cell$isNaN, FALSE))
      if (is.na(value)) {
        stopifnot(identical(cell$kind, "null"), is.null(cell$raw))
      } else {
        raw <- if (column == 4L) value else if (column == 6L) sprintf("%.0f", as.numeric(value)) else as.character(value)
        stopifnot(identical(cell$kind, kinds[[column]]), identical(cell$raw, raw))
      }
    }
  }
}
check_profile <- function(result, n, filled = FALSE) {
  stopifnot(length(result$summaries) == 1L)
  value <- result$summaries[[1L]]
  stopifnot(identical(value$columnId, ids[[2L]]), value$totalCount == n,
    value$nullCount == if (filled) 0L else n / 10L, value$nanCount == 0L,
    value$numeric$min == if (filled) 0 else 1, value$numeric$max == 999,
    value$numeric$sum == n / 1000 * 450000)
  if (n == 1000000L) stopifnot(is.null(value$distinctCount), is.null(value$numeric$median),
    length(value$topValues) == 0L, isTRUE(value$visualization$sampled))
}
report <- list(startedUtc = format(Sys.time(), tz = "UTC", usetz = TRUE),
  sourceCommit = Sys.getenv("GITHUB_SHA"), rVersion = R.version.string,
  platform = R.version$platform, packages = versions, nativeLibraries = as.list(extSoftVersion()),
  logicalCpus = parallel::detectCores(), dataTableDefaultThreads = data.table::getDTthreads(),
  threadEnvironment = as.list(Sys.getenv(c("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS", "R_DATATABLE_NUM_THREADS", "R_DATATABLE_NUM_PROCS"))),
  method = paste("Existing base data.frame, fresh native agent/session opened with one row per sample; opening and fixture setup excluded.",
    "Pre-encoded requests time dispatch_json including native validation, computation, bounded cells and response JSON.",
    "First completed call is warmup; next three calls yield median/range. No sort cache is shared across samples.",
    "Response decoding, GC, assertions, generated execution and close/dispose are outside timing."),
  limits = paste("Runtime only; no import/startup/mailbox/kernel/editor/UI/RSS or cross-engine ranking.",
    "One base data.frame flavor on one hosted Linux machine. Native profile distribution sampling is unchanged.",
    "Preview plus Apply includes first-edit isolation, diff/code generation and both 200-by-6 response pages."),
  cases = list())
write_report <- function() writeLines(jsonlite::toJSON(report, auto_unbox = TRUE, pretty = TRUE,
  digits = 17L, null = "null", na = "null"), args[[1L]], useBytes = TRUE)

run_case <- function(frame, task) {
  n <- nrow(frame)
  before <- serialize(frame, NULL, version = 3L)
  filled <- frame
  filled$amount[is.na(filled$amount)] <- 0
  positions <- rev(which(!is.na(frame$amount) & frame$amount >= 900))
  filter_view <- list(filters = I(list(list(column = list(id = ids[[2L]], name = "amount"),
    type = "float", logic = "and", predicates = I(list(list(kind = "predicate", operator = "gte", value = 900)))))),
    sorts = I(list(list(column = list(id = ids[[1L]], name = "id"), direction = "desc", nulls = "last"))))
  open_json <- encode("openSession", list(sessionId = session_id, variableName = "frame", page = page(limit = 1L)))
  summary_json <- encode("getSummary", list(sessionId = session_id,
    columns = I(list(list(id = ids[[2L]], name = "amount"))), view = empty_view))
  query <- switch(task,
    first_200 = encode("getPage", list(sessionId = session_id, page = page())),
    filter_sort_first_200 = encode("getPage", list(sessionId = session_id, page = page(filter_view))),
    profile_amount = summary_json,
    fill_zero_preview_apply = encode("previewStep", list(sessionId = session_id, revision = 0L,
      step = list(id = "fill-zero", kind = "fillMissingValues", params = list(
        column = list(id = ids[[2L]], name = "amount"), replacement = list(kind = "float", value = "0"))),
      page = page())))
  apply_json <- encode("applyDraft", list(sessionId = session_id, revision = 1L, page = page()))
  samples <- numeric(4L)
  for (iteration in seq_len(4L)) {
    source_environment <- new.env(parent = emptyenv())
    source_environment$frame <- frame
    temporary_before <- list.files(tempdir(), pattern = "^openwrangler-r-kernel-", full.names = TRUE)
    agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, source_environment)
    owned_root <- setdiff(list.files(tempdir(), pattern = "^openwrangler-r-kernel-", full.names = TRUE), temporary_before)
    opened <- FALSE
    tryCatch({
      opening <- decode(agent$dispatch_json(open_json), "page")
      opened <- TRUE
      check_page(opening, frame, 1L, n)
      gc()
      started <- proc.time()[["elapsed"]]
      first_text <- agent$dispatch_json(query)
      final_text <- if (task == "fill_zero_preview_apply") agent$dispatch_json(apply_json) else first_text
      samples[[iteration]] <- (proc.time()[["elapsed"]] - started) * 1000
      if (task == "profile_amount") {
        check_profile(decode(final_text, "summary"), n)
      } else if (task == "fill_zero_preview_apply") {
        preview <- decode(first_text, "stepPreview")
        result <- decode(final_text, "planUpdated")
        stopifnot(preview$revision == 1L, preview$diff$changedCells == n / 10L,
          result$revision == 2L, identical(result$action, "apply"))
        check_page(preview, filled, seq_len(200L), n)
        check_page(result, filled, seq_len(200L), n)
        check_profile(decode(agent$dispatch_json(summary_json), "summary"), n, TRUE)
        if (iteration == 1L) {
          generated <- new.env(parent = baseenv())
          generated$frame <- frame
          eval(parse(text = result$code), envir = generated)
          stopifnot(identical(generated$open_wrangler_result, filled),
            identical(serialize(generated$frame, NULL, version = 3L), before))
        }
      } else {
        filtered <- task == "filter_sort_first_200"
        check_page(decode(final_text, "page"), frame,
          if (filtered) head(positions, 200L) else seq_len(200L), if (filtered) length(positions) else n)
      }
      stopifnot(identical(serialize(source_environment$frame, NULL, version = 3L), before))
    }, finally = {
      tryCatch({
        if (opened) decode(agent$dispatch_json(encode("closeSession", list(sessionId = session_id))), "closed")
      }, finally = agent$dispose())
    })
    stopifnot(length(owned_root) == 1L, !dir.exists(owned_root))
  }
  stopifnot(identical(serialize(frame, NULL, version = 3L), before))
  list(rows = n, columns = 6L, task = task, firstCallMs = samples[[1L]],
    warmSamplesMs = I(samples[-1L]), warmMedianMs = median(samples[-1L]),
    warmRangeMs = I(range(samples[-1L])), sourceAndOutputChecks = TRUE, cleanupVerified = TRUE)
}
tryCatch({
  for (n in c(100000L, 1000000L)) {
    frame <- make_frame(n)
    for (task in c("first_200", "filter_sort_first_200", "profile_amount", "fill_zero_preview_apply")) {
      record <- run_case(frame, task)
      report$cases[[length(report$cases) + 1L]] <- record
      cat(jsonlite::toJSON(record, auto_unbox = TRUE, digits = 17L), "\n")
      write_report()
    }
  }
  report$completed <- TRUE
}, error = function(error) {
  report$failure <<- conditionMessage(error)
  stop(error)
}, finally = {
  report$finishedUtc <- format(Sys.time(), tz = "UTC", usetz = TRUE)
  write_report()
})
