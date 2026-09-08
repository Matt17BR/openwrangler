# Session-local redo uses the saved command against the current confirmed frame.
local({
  src <- new.env(parent = baseenv())
  src$frame <- data.frame(value = c(1L, 2L), label = c("a", "b"), row.names = c("first", "second"))
  source_bytes <- serialize(src$frame, NULL, version = 3L)
  redo_agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, src)
  sid <- "abababab-abab-4bab-8bab-abababababab"
  revision <- 0L
  send <- function(kind, payload) dispatch_with(redo_agent, kind, payload)
  mutate <- function(kind, extra = list(), expected = "planUpdated", page = page_window()) {
    response <- send(kind, c(list(sessionId = sid, revision = revision, page = page), extra))
    assert_identical(response$kind, expected, paste("R redo owner", kind, "returned the wrong result"))
    if (!identical(expected, "error")) {
      assert_identical(response$revision, revision + 1L, "R redo did not publish exactly one revision")
      revision <<- response$revision
    }
    response
  }
  preview <- function(step) mutate("previewStep", list(step = step), "stepPreview")
  apply <- function(step) {
    invisible(preview(step))
    mutate("applyDraft")
  }
  redo <- function(id, expected = "planUpdated", page = page_window()) {
    mutate("redoStep", list(expectedStepId = id), expected, page)
  }
  custom <- function(id, code) list(id = id, kind = "customCode", params = list(code = code))
  clone <- list(id = "copy-value", kind = "cloneColumn", params = list(
    column = list(id = "r:c:0", name = "value"), newName = "copy"
  ))
  old_control <- getOption("openwrangler_redo_test_control")
  tryCatch({
    opened <- send("openSession", list(sessionId = sid, variableName = "frame", page = page_window()))
    assert_identical(opened$kind, "page", "R redo source did not open")
    assert_identical(redo("copy-value", "error")$code, "redo_unavailable", "empty R redo changed diagnostics")
    # A redo must not replay an unrelated prefix with external state.
    prefix <- custom("prefix", "result <- df\nresult$stamp <- stats::runif(1L)")
    invisible(apply(prefix))
    invisible(apply(clone))
    undone <- mutate("undoStep")
    prefix_cells <- undone$page$page$rows[[1L]]$values
    mismatch <- redo("wrong-step", "error")
    assert_identical(mismatch$code, "invalid_request", "mismatched R redo identity was accepted")
    stale <- send("redoStep", list(sessionId = sid, revision = revision - 1L, expectedStepId = clone$id, page = page_window()))
    assert_identical(stale$code, "stale_revision", "stale R redo revision was accepted")
    # Use the existing bounded encoder seam; publication must follow full response preflight.
    encoder_environment <- environment(openwrangler_r_kernel_agent$new_agent)
    response_limit <- get("maximum_response_bytes", encoder_environment, inherits = FALSE)
    encoding_failure <- tryCatch({
      assign("maximum_response_bytes", 512L, encoder_environment)
      redo(clone$id, "error")
    }, finally = assign("maximum_response_bytes", response_limit, encoder_environment))
    assert_identical(encoding_failure$code, "runtime_error", "R redo did not refuse an oversized complete response")
    restored <- redo(clone$id)
    assert_identical(restored$action, "redo", "R redo returned the wrong action")
    assert_identical(restored$page$page$rows[[1L]]$values[seq_along(prefix_cells)], prefix_cells,
      "R redo replayed the already confirmed prefix")
    assert_identical(restored$diff$addedColumns, list("copy"), "R redo omitted its fresh diff")
    # Multiple undos retain command order; a draft/discard and view reads retain it.
    invisible(mutate("undoStep"))
    invisible(mutate("undoStep"))
    assert_identical(redo(clone$id, "error")$code, "invalid_request", "R redo skipped the next saved command")
    invisible(preview(custom("temporary", "result <- df")))
    assert_identical(redo(prefix$id, "error")$code, "invalid_request", "R redo accepted a live draft")
    invisible(mutate("discardDraft"))
    viewed <- send("getPage", list(sessionId = sid, page = page_window(row_limit = 1L)))
    assert_identical(viewed$kind, "page", "R history blocked an ordinary view")
    invisible(redo(prefix$id))
    invisible(redo(clone$id))
    assert_identical(redo(clone$id, "error")$code, "redo_unavailable", "R redo retained a consumed command")
    invisible(mutate("undoStep"))
    invisible(apply(custom("branch", "result <- df")))
    assert_identical(redo(clone$id, "error")$code, "redo_unavailable", "new R Apply retained the old branch")
    invisible(send("closeSession", list(sessionId = sid)))
    revision <- 0L
    invisible(send("openSession", list(sessionId = sid, variableName = "frame", page = page_window())))
    assert_identical(redo(clone$id, "error")$code, "redo_unavailable", "replacement R session retained history")

    # The saved Custom Code can change its own result; failures preserve its slot.
    control <- new.env(parent = baseenv())
    control$rows <- 1L
    control$fail <- FALSE
    control$wide <- FALSE
    options(openwrangler_redo_test_control = control)
    dynamic <- custom("dynamic", paste(
      'control <- getOption("openwrangler_redo_test_control")',
      'if (control$fail) stop("owned redo failure")',
      'result <- df[seq_len(control$rows), , drop = FALSE]',
      'if (control$wide) result$extra <- rep.int("new", nrow(result))', sep = "\n"
    ))
    first <- apply(dynamic)
    invisible(mutate("undoStep"))
    control$fail <- TRUE
    assert_identical(redo(dynamic$id, "error")$code, "invalid_request", "failed R redo changed error classification")
    control$fail <- FALSE
    control$rows <- 2L
    control$wide <- TRUE
    second <- redo(dynamic$id)
    options(openwrangler_redo_test_control = old_control)
    assert_identical(first$page$page$totalRows, 1L, "R initial dynamic command row count changed")
    assert_identical(second$page$page$totalRows, 2L, "R redo reused historical result rows")
    assert_identical(length(second$page$schema), 3L, "R redo reused historical schema")
    assert_identical(second$effectiveView, list(filters = list(), sorts = list()), "R redo omitted its fresh effective view")
    generated <- new.env(parent = baseenv())
    generated$frame <- src$frame
    options(openwrangler_redo_test_control = control)
    eval(parse(text = second$code), envir = generated)
    options(openwrangler_redo_test_control = old_control)
    assert_identical(generated$open_wrangler_result, data.frame(value = c(1L, 2L), label = c("a", "b"), extra = c("new", "new"), row.names = c("first", "second")),
      "R redo generated code diverged from the current command")
    invisible(send("closeSession", list(sessionId = sid)))
    revision <- 0L
    invisible(send("openSession", list(sessionId = sid, variableName = "frame", page = page_window())))
    by_example <- list(id = "retained-example", kind = "byExample", params = list(
      sourceColumns = list(list(id = "r:c:0", name = "value")), newColumn = "derived",
      examples = list(list(inputs = list(1L), output = 1L), list(inputs = list(2L), output = 2L))
    ))
    example_preview <- preview(by_example)
    invisible(mutate("applyDraft"))
    invisible(mutate("undoStep"))
    example_redo <- redo(by_example$id)
    assert_identical(example_redo$retainedStep, example_preview$retainedStep, "R redo resynthesized a retained By Example command")
    assert_identical(example_redo$page, example_preview$page, "R redo changed By Example values or stable IDs")
    assert_identical(example_redo$code, example_preview$code, "R redo changed By Example emitted code")
    generated_example <- new.env(parent = baseenv())
    generated_example$frame <- src$frame
    eval(parse(text = example_redo$code), envir = generated_example)
    assert_identical(generated_example$open_wrangler_result$derived, src$frame$value,
      "R redo emitted By Example values diverged from the retained command")
    invisible(mutate("undoStep"))
    sorted_redo <- redo(by_example$id, page = page_window(sorts = list(list(
      column = list(id = "r:c:0", name = "value"), direction = "desc", nulls = "last"
    ))))
    assert_identical(vapply(sorted_redo$page$page$rows, `[[`, character(1L), "id"), c("r:r:1", "r:r:0"),
      "R redo did not use the current requested viewing order")
    assert_identical(serialize(src$frame, NULL, version = 3L), source_bytes, "R redo changed its source")
  }, finally = {
    options(openwrangler_redo_test_control = old_control)
    redo_agent$dispose()
  })
})
