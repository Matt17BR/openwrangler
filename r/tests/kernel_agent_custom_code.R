# Custom Code kernel-agent contract cases.

custom_environment <- new.env(parent = baseenv())
custom_environment$orders <- data.frame(
  row_id = 1:4,
  score = c(10, 20, 30, 40),
  label = c("one", "two", "three", "four"),
  check.names = FALSE
)
custom_orders_before <- serialize(custom_environment$orders, NULL, version = 3L)
custom_agent <- openwrangler_r_kernel_agent$new_agent(
  openwrangler_r_frame_contract,
  custom_environment
)
custom_dispatch <- function(kind, payload) dispatch_with(custom_agent, kind, payload)
custom_session_id <- "01010101-0101-4101-8101-010101010101"
custom_open <- custom_dispatch(
  "openSession",
  list(sessionId = custom_session_id, variableName = "orders", page = page_window())
)
assert_identical(custom_open$kind, "page", "the Custom Code test session did not open")

custom_step <- function(id, code, params = NULL) list(
  id = id,
  kind = "customCode",
  params = if (is.null(params)) list(code = code) else params
)
custom_preview <- function(session_id, revision, id, code, page = page_window(), replace_step_id = NULL) {
  payload <- list(
    sessionId = session_id,
    revision = revision,
    step = custom_step(id, code),
    page = page
  )
  if (!is.null(replace_step_id)) payload$replaceStepId <- replace_step_id
  custom_dispatch("previewStep", payload)
}
assert_custom_recoverable_error <- function(response, label) {
  assert_identical(response$kind, "error", paste(label, "was accepted"))
  assert_identical(response$code, "invalid_request", paste(label, "used the wrong diagnostic"))
  assert_identical(response$recoverable, TRUE, paste(label, "was not recoverable"))
  assert_identical(
    serialize(custom_environment$orders, NULL, version = 3L),
    custom_orders_before,
    paste(label, "mutated the Custom Code source")
  )
}
custom_assert_true <- function(value, message) {
  if (!isTRUE(value)) stop(message, call. = FALSE)
}

custom_decoder_cases <- list(
  list(label = "blank Custom Code", step = custom_step("blank-custom", "  \n\t")),
  list(label = "comment-only Custom Code", step = custom_step("comment-custom", "# only a comment\n  # still a comment")),
  list(label = "malformed Custom Code", step = custom_step("parse-custom", "result <- (df")),
  list(
    label = "Custom Code with unknown params",
    step = custom_step(
      "fields-custom",
      "result <- df",
      params = list(code = "result <- df", extra = TRUE)
    )
  ),
  list(
    label = "oversized Custom Code",
    step = custom_step("oversized-custom", paste(rep.int("x", 65537L), collapse = ""))
  )
)
for (case in custom_decoder_cases) {
  response <- custom_dispatch(
    "previewStep",
    list(
      sessionId = custom_session_id,
      revision = 0L,
      step = case$step,
      page = page_window()
    )
  )
  assert_custom_recoverable_error(response, case$label)
}

nul_request <- jsonlite::toJSON(
  list(
    transportVersion = 14L,
    requestId = request_id,
    kind = "previewStep",
    payload = list(
      sessionId = custom_session_id,
      revision = 0L,
      step = custom_step("nul-custom", "result <- dfNUL_SENTINEL"),
      page = page_window()
    )
  ),
  auto_unbox = TRUE,
  null = "null"
)
nul_request <- sub("NUL_SENTINEL", "\\u0000", as.character(nul_request), fixed = TRUE)
nul_custom_response <- jsonlite::fromJSON(
  custom_agent$dispatch_json(nul_request),
  simplifyVector = FALSE
)
assert_custom_recoverable_error(nul_custom_response, "Custom Code with U+0000")

custom_output_error_cases <- list(
  list(label = "missing Custom Code result", code = "df[[1L]] <- df[[1L]] + 1L"),
  list(label = "superassigned Custom Code result", code = "result <<- df"),
  list(
    label = "active Custom Code result",
    code = "base::makeActiveBinding(\"result\", function(value) df, base::environment())"
  ),
  list(label = "non-frame Custom Code result", code = "result <- 1:3"),
  list(label = "zero-column Custom Code result", code = "result <- df[, FALSE, drop = FALSE]"),
  list(label = "cross-flavor Custom Code result", code = "result <- tibble::as_tibble(df)"),
  list(
    label = "private-name Custom Code result",
    code = paste(
      "result <- df",
      "base::names(result)[[1L]] <- \"__OPEN_WRANGLER_INTERNAL_ROW_ID_FORBIDDEN\"",
      sep = "\n"
    )
  ),
  list(
    label = "list-column Custom Code result",
    code = paste(
      "result <- df",
      "result[[1L]] <- base::I(base::lapply(base::seq_len(base::nrow(result)), function(index) base::list(index)))",
      sep = "\n"
    )
  ),
  list(
    label = "oversized-cell Custom Code result",
    code = paste(
      "result <- df",
      "result[[1L]] <- base::rep.int(base::paste(base::rep.int(\"x\", 8193L), collapse = \"\"), base::nrow(df))",
      sep = "\n"
    )
  )
)
for (case_index in seq_along(custom_output_error_cases)) {
  case <- custom_output_error_cases[[case_index]]
  response <- custom_preview(
    custom_session_id,
    0L,
    paste0("invalid-output-", case_index),
    case$code
  )
  assert_custom_recoverable_error(response, case$label)
}

custom_filter <- list(
  column = list(id = "r:c:0", name = "row_id"),
  type = "integer",
  predicates = I(list(list(kind = "predicate", operator = "gt", value = 1L)))
)
custom_sort <- list(
  column = list(id = "r:c:1", name = "score"),
  direction = "asc",
  nulls = "last"
)
custom_view_page <- page_window(filters = list(custom_filter), sorts = list(custom_sort))
custom_code <- paste(
  "base::print(\"discarded output\")",
  "base::cat(\"discarded cat output\\n\")",
  "base::message(\"discarded message\")",
  "warning_receipt <- base::new.env(parent = base::emptyenv())",
  "base::withCallingHandlers(base::warning(\"discarded warning\", call. = FALSE), warning = function(condition) { warning_receipt$class <- base::class(condition); warning_receipt$message <- base::conditionMessage(condition) })",
  "if (!base::identical(warning_receipt$class, base::c(\"simpleWarning\", \"warning\", \"condition\"))) base::stop(\"Custom Code warning class changed\", call. = FALSE)",
  "if (!base::identical(warning_receipt$message, \"discarded warning\")) base::stop(\"Custom Code warning message changed\", call. = FALSE)",
  "result <- df",
  "result$row_id <- result$row_id + 10L",
  "result$score <- base::as.character(result$score)",
  "result$score_plus_one <- base::as.numeric(result$score) + 1",
  sep = "\n"
)
custom_first_preview <- custom_preview(
  custom_session_id,
  0L,
  "custom-main",
  custom_code,
  custom_view_page
)
assert_identical(custom_first_preview$kind, "stepPreview", "Custom Code preview did not return")
assert_identical(
  custom_first_preview$effectiveView$sorts,
  list(),
  "Custom Code retained a sort whose column type changed"
)
assert_identical(
  length(custom_first_preview$effectiveView$filters),
  1L,
  "Custom Code pruned a compatible surviving filter"
)
custom_assert_true(
  !"logic" %in% names(custom_first_preview$effectiveView),
  "Custom Code emitted an absent effective-view logic field"
)
assert_identical(
  custom_first_preview$page$page$totalRows,
  4L,
  "Custom Code did not materialize through the reconciled filter"
)
assert_identical(
  vapply(custom_first_preview$page$page$rows, `[[`, character(1L), "id"),
  paste0("r:r:", 4:7),
  "Custom Code did not allocate fresh row identities"
)
assert_identical(custom_first_preview$diff$addedRows, 4L, "Custom Code diff changed added rows")
assert_identical(custom_first_preview$diff$removedRows, 4L, "Custom Code diff changed removed rows")
assert_identical(custom_first_preview$diff$changedCells, 0L, "Custom Code diff reported changed cells")
assert_identical(custom_first_preview$diff$cells, list(), "Custom Code diff reported cell details")
assert_identical(custom_first_preview$diff$truncated, TRUE, "a filtered Custom Code diff claimed completeness")
assert_identical(
  unlist(custom_first_preview$diff$addedColumns, use.names = FALSE),
  "score_plus_one",
  "Custom Code diff changed its added-column order"
)
custom_assert_true(
  grepl(
    paste0(".ow_custom_code <- ", encodeString(custom_code, quote = "\"")),
    custom_first_preview$code,
    fixed = TRUE
  ),
  "generated Custom Code did not retain the exact quoted source"
)
custom_assert_true(
  grepl("base::parse(text = .ow_custom_code", custom_first_preview$code, fixed = TRUE),
  "generated Custom Code did not parse its quoted source"
)

custom_generated_environment <- new.env(parent = baseenv())
custom_generated_environment$orders <- custom_environment$orders
assert_no_warning(
  eval(parse(text = custom_first_preview$code), envir = custom_generated_environment),
  "generated Custom Code warning suppression"
)
custom_expected <- custom_environment$orders
custom_expected$row_id <- custom_expected$row_id + 10L
custom_expected$score <- as.character(custom_expected$score)
custom_expected$score_plus_one <- as.numeric(custom_expected$score) + 1
assert_identical(
  custom_generated_environment$open_wrangler_result,
  custom_expected,
  "generated Custom Code changed live data semantics"
)
assert_identical(
  serialize(custom_generated_environment$orders, NULL, version = 3L),
  custom_orders_before,
  "generated Custom Code mutated its source"
)

custom_discard <- custom_dispatch(
  "discardDraft",
  list(
    sessionId = custom_session_id,
    revision = custom_first_preview$revision,
    page = page_window()
  )
)
assert_identical(custom_discard$action, "discard", "Custom Code draft did not discard")
assert_identical(custom_discard$page$page$totalRows, 4L, "discarding Custom Code changed the source page")

custom_apply_preview <- custom_preview(
  custom_session_id,
  custom_discard$revision,
  "custom-main",
  custom_code
)
custom_apply <- custom_dispatch(
  "applyDraft",
  list(
    sessionId = custom_session_id,
    revision = custom_apply_preview$revision,
    page = page_window()
  )
)
assert_identical(custom_apply$action, "apply", "Custom Code draft did not apply")
assert_identical(custom_apply$page$page$totalRows, 4L, "applied Custom Code changed output height")
assert_identical(custom_apply$page$shape$rows, 8L, "applied Custom Code lost its row identity domain")

custom_inspection_info <- custom_dispatch(
  "inspectStepInfo",
  list(
    sessionId = custom_session_id,
    revision = custom_apply$revision,
    stepId = "custom-main"
  )
)
assert_identical(custom_inspection_info$kind, "stepInspectionInfo", "Custom Code inspection did not open")
custom_inspection_output <- custom_dispatch(
  "inspectStepPage",
  list(
    sessionId = custom_session_id,
    revision = custom_apply$revision,
    stepId = "custom-main",
    side = "output",
    page = page_window()
  )
)
assert_identical(custom_inspection_output$kind, "stepInspectionPage", "Custom Code output inspection failed")
assert_identical(
  custom_inspection_output$page$page$totalRows,
  4L,
  "Custom Code inspection changed physical output height"
)

custom_edit_preview <- custom_preview(
  custom_session_id,
  custom_apply$revision,
  "custom-main",
  "result <- df[base::seq_len(2L), , drop = FALSE]",
  replace_step_id = "custom-main"
)
assert_identical(custom_edit_preview$kind, "stepPreview", "editing latest Custom Code did not replay")
assert_identical(custom_edit_preview$page$page$totalRows, 2L, "edited Custom Code used the prior output as input")
custom_edit_discard <- custom_dispatch(
  "discardDraft",
  list(
    sessionId = custom_session_id,
    revision = custom_edit_preview$revision,
    page = page_window()
  )
)
assert_identical(custom_edit_discard$page$page$totalRows, 4L, "discarding a Custom Code edit lost the applied step")

custom_edit_apply_code <- paste(
  "result <- df[base::seq_len(2L), , drop = FALSE]",
  "result$row_id <- result$row_id + 10L",
  "result$score <- base::as.character(result$score)",
  "result$score_plus_one <- base::as.numeric(result$score) + 1",
  sep = "\n"
)
custom_edit_apply_preview <- custom_preview(
  custom_session_id,
  custom_edit_discard$revision,
  "custom-main",
  custom_edit_apply_code,
  replace_step_id = "custom-main"
)
assert_identical(
  custom_edit_apply_preview$page$schema[[4L]]$id,
  "c:step:custom-main:0",
  "editing Custom Code changed its created-column lineage"
)
custom_edit_apply <- custom_dispatch(
  "applyDraft",
  list(
    sessionId = custom_session_id,
    revision = custom_edit_apply_preview$revision,
    page = page_window()
  )
)
assert_identical(custom_edit_apply$action, "apply", "the edited Custom Code step did not apply")
assert_identical(
  custom_edit_apply$page$schema[[4L]]$id,
  "c:step:custom-main:0",
  "reapplying edited Custom Code changed its created-column lineage"
)
assert_identical(custom_edit_apply$page$page$totalRows, 2L, "the edited Custom Code output changed height")

custom_later_preview <- custom_dispatch(
  "previewStep",
  list(
    sessionId = custom_session_id,
    revision = custom_edit_apply$revision,
    step = list(
      id = "rename-custom-output",
      kind = "renameColumn",
      params = list(
        column = list(id = "c:step:custom-main:0", name = "score_plus_one"),
        newName = "score_plus"
      )
    ),
    page = page_window()
  )
)
assert_identical(custom_later_preview$kind, "stepPreview", "a later step could not bind Custom Code output")
custom_later_apply <- custom_dispatch(
  "applyDraft",
  list(
    sessionId = custom_session_id,
    revision = custom_later_preview$revision,
    page = page_window()
  )
)
custom_later_generated <- new.env(parent = baseenv())
custom_later_generated$orders <- custom_environment$orders
eval(parse(text = custom_later_apply$code), envir = custom_later_generated)
custom_edited_expected <- custom_expected[base::seq_len(2L), , drop = FALSE]
names(custom_edited_expected)[[4L]] <- "score_plus"
assert_identical(
  custom_later_generated$open_wrangler_result,
  custom_edited_expected,
  "generated R could not execute a later step after Custom Code"
)
custom_rename_undo <- custom_dispatch(
  "undoStep",
  list(
    sessionId = custom_session_id,
    revision = custom_later_apply$revision,
    page = page_window()
  )
)
assert_identical(custom_rename_undo$action, "undo", "undo did not retain the applied Custom Code step")
assert_identical(custom_rename_undo$page$schema[[4L]]$name, "score_plus_one", "undo lost Custom Code output")
custom_step_undo <- custom_dispatch(
  "undoStep",
  list(
    sessionId = custom_session_id,
    revision = custom_rename_undo$revision,
    page = page_window()
  )
)
assert_identical(custom_step_undo$action, "undo", "Custom Code step did not undo")
assert_identical(custom_step_undo$page$shape$columns, 3L, "undoing Custom Code retained its schema")

custom_zero_preview <- custom_preview(
  custom_session_id,
  custom_step_undo$revision,
  "custom-zero-rows",
  "result <- df[0L, , drop = FALSE]"
)
assert_identical(custom_zero_preview$kind, "stepPreview", "Custom Code rejected zero output rows")
assert_identical(custom_zero_preview$page$page$totalRows, 0L, "zero-row Custom Code output changed height")
custom_zero_discard <- custom_dispatch(
  "discardDraft",
  list(
    sessionId = custom_session_id,
    revision = custom_zero_preview$revision,
    page = page_window()
  )
)
assert_identical(custom_zero_discard$action, "discard", "zero-row Custom Code draft did not discard")

custom_boundary_rows <- 11116L
custom_boundary_text_bytes <- 6029L
custom_boundary_bytes <-
  1024 + 512 +
  (8 + nchar("aa", type = "bytes")) +
  (8 + nchar("data.frame", type = "bytes")) +
  8 +
  as.double(custom_boundary_rows) * (8 + custom_boundary_text_bytes)
assert_identical(
  custom_boundary_bytes,
  64 * 1024^2,
  "the kernel Custom Code boundary fixture is not exactly 64 MiB"
)
custom_boundary_code <- paste(
  ".ow_boundary_text <- base::paste(base::rep.int(\"x\", 6029L), collapse = \"\")",
  "result <- base::data.frame(aa = base::rep.int(.ow_boundary_text, 11116L), check.names = FALSE)",
  "if (base::exists(\"custom_boundary_plus_one\", inherits = TRUE)) base::names(result) <- \"aaa\"",
  sep = "\n"
)
custom_boundary_preview <- custom_preview(
  custom_session_id,
  custom_zero_discard$revision,
  "exact-operation-boundary",
  custom_boundary_code,
  page = page_window(row_limit = 1L, column_limit = 1L)
)
assert_identical(
  custom_boundary_preview$kind,
  "stepPreview",
  "live Custom Code rejected an output at the exact 64 MiB operation budget"
)
assert_identical(
  custom_boundary_preview$page$page$totalRows,
  custom_boundary_rows,
  "the exact-budget live Custom Code output changed height"
)
custom_boundary_generated_pass <- new.env(parent = baseenv())
custom_boundary_generated_pass$orders <- custom_environment$orders
eval(parse(text = custom_boundary_preview$code), envir = custom_boundary_generated_pass)
assert_identical(
  nrow(custom_boundary_generated_pass$open_wrangler_result),
  custom_boundary_rows,
  "generated Custom Code rejected an output at the exact 64 MiB operation budget"
)
assert_identical(
  names(custom_boundary_generated_pass$open_wrangler_result),
  "aa",
  "generated exact-budget Custom Code changed its output schema"
)
custom_boundary_generated_fail <- new.env(parent = baseenv())
custom_boundary_generated_fail$orders <- custom_environment$orders
custom_boundary_generated_fail$custom_boundary_plus_one <- TRUE
custom_boundary_generated_fail$open_wrangler_result <- "sentinel"
custom_boundary_generated_error <- tryCatch(
  {
    eval(parse(text = custom_boundary_preview$code), envir = custom_boundary_generated_fail)
    NULL
  },
  error = identity
)
custom_assert_true(
  inherits(custom_boundary_generated_error, "error"),
  "generated Custom Code accepted an output one byte over 64 MiB"
)
assert_identical(
  custom_boundary_generated_fail$open_wrangler_result,
  "sentinel",
  "generated over-budget Custom Code replaced the prior publication"
)
custom_boundary_discard <- custom_dispatch(
  "discardDraft",
  list(
    sessionId = custom_session_id,
    revision = custom_boundary_preview$revision,
    page = page_window(row_limit = 1L, column_limit = 1L)
  )
)
custom_environment$custom_boundary_plus_one <- TRUE
custom_boundary_live_error <- custom_preview(
  custom_session_id,
  custom_boundary_discard$revision,
  "over-operation-boundary",
  custom_boundary_code,
  page = page_window(row_limit = 1L, column_limit = 1L)
)
assert_custom_recoverable_error(custom_boundary_live_error, "Custom Code output one byte over 64 MiB")
rm("custom_boundary_plus_one", envir = custom_environment)
rm(custom_boundary_generated_pass, custom_boundary_generated_fail)

generated_oversize_code <- paste(
  "result <- if (base::exists(\"make_oversize\", inherits = TRUE)) {",
  "  base::data.frame(value = base::rep.int(0, 8388608L))",
  "} else df",
  sep = "\n"
)
generated_oversize_preview <- custom_preview(
  custom_session_id,
  custom_boundary_discard$revision,
  "generated-oversize",
  generated_oversize_code
)
assert_identical(
  generated_oversize_preview$kind,
  "stepPreview",
  "the generated-output budget fixture did not preview live"
)
generated_oversize_environment <- new.env(parent = baseenv())
generated_oversize_environment$orders <- custom_environment$orders
generated_oversize_environment$make_oversize <- TRUE
generated_serialize_calls <- 0L
trace(
  "serialize",
  tracer = quote(generated_serialize_calls <<- generated_serialize_calls + 1L),
  where = baseenv(),
  print = FALSE
)
generated_oversize_error <- tryCatch(
  {
    eval(parse(text = generated_oversize_preview$code), envir = generated_oversize_environment)
    NULL
  },
  error = identity
)
untrace("serialize", where = baseenv())
custom_assert_true(inherits(generated_oversize_error, "error"), "generated Custom Code accepted an oversized output")
assert_identical(
  generated_serialize_calls,
  2L,
  "generated Custom Code snapshotted an oversized output before rejecting it"
)
custom_assert_true(
  !exists("open_wrangler_result", envir = generated_oversize_environment, inherits = FALSE),
  "generated oversized Custom Code published a partial result"
)
assert_identical(
  serialize(generated_oversize_environment$orders, NULL, version = 3L),
  custom_orders_before,
  "generated oversized Custom Code mutated its source"
)
generated_oversize_discard <- custom_dispatch(
  "discardDraft",
  list(
    sessionId = custom_session_id,
    revision = generated_oversize_preview$revision,
    page = page_window()
  )
)
assert_identical(generated_oversize_discard$action, "discard", "the generated-output budget draft did not discard")
assert_identical(
  serialize(custom_environment$orders, NULL, version = 3L),
  custom_orders_before,
  "Custom Code lifecycle mutated its source"
)
invisible(custom_dispatch("closeSession", list(sessionId = custom_session_id)))

custom_flavor_source <- data.frame(id = 1:3, value = c(10L, 20L, 30L), check.names = FALSE)
custom_flavor_element_names <- c("flavor-left", "flavor-middle", "flavor-right")
custom_flavor_data_table <- data.table::as.data.table(custom_flavor_source)
custom_flavor_qdt <- collapse::qDT(custom_flavor_source)
data.table::setattr(
  .subset2(custom_flavor_data_table, 2L),
  "names",
  custom_flavor_element_names
)
data.table::setattr(
  .subset2(custom_flavor_qdt, 2L),
  "names",
  custom_flavor_element_names
)
custom_flavor_cases <- list(
  list(label = "base data.frame", value = custom_flavor_source, flavor = "r.data.frame"),
  list(label = "tibble", value = tibble::as_tibble(custom_flavor_source), flavor = "r.tibble"),
  list(
    label = "data.table",
    value = custom_flavor_data_table,
    flavor = "r.data.table",
    elementNames = custom_flavor_element_names
  ),
  list(label = "collapse qDF", value = collapse::qDF(custom_flavor_source), flavor = "r.data.frame"),
  list(label = "collapse qTBL", value = collapse::qTBL(custom_flavor_source), flavor = "r.tibble"),
  list(
    label = "collapse qDT",
    value = custom_flavor_qdt,
    flavor = "r.data.table",
    elementNames = custom_flavor_element_names
  )
)
custom_flavor_session_ids <- c(
  "11110001-0001-4001-8001-000100010001",
  "11110002-0002-4002-8002-000200020002",
  "11110003-0003-4003-8003-000300030003",
  "11110004-0004-4004-8004-000400040004",
  "11110005-0005-4005-8005-000500050005",
  "11110006-0006-4006-8006-000600060006"
)
for (case_index in seq_along(custom_flavor_cases)) {
  case <- custom_flavor_cases[[case_index]]
  variable_name <- paste0("custom_flavor_", case_index)
  session_id_value <- custom_flavor_session_ids[[case_index]]
  assign(variable_name, case$value, envir = custom_environment)
  source_before_case <- serialize(case$value, NULL, version = 3L)
  opened_case <- custom_dispatch(
    "openSession",
    list(sessionId = session_id_value, variableName = variable_name, page = page_window())
  )
  assert_identical(opened_case$page$dataframeFlavor, case$flavor, paste(case$label, "opened with wrong flavor"))
  custom_flavor_code <- if (is.null(case$elementNames)) {
    "result <- df\nresult[[2L]] <- result[[2L]] + 1L"
  } else {
    paste(
      ".ow_input_names <- base::names(df[[2L]])",
      "if (!base::identical(.ow_input_names, c(\"flavor-left\", \"flavor-middle\", \"flavor-right\"))) base::stop(\"live Custom Code input lost element names\")",
      "result <- df",
      "result[[2L]] <- result[[2L]] + 1L",
      "data.table::setattr(base::.subset2(result, 2L), \"names\", .ow_input_names)",
      "if (!base::identical(base::names(result[[2L]]), .ow_input_names)) base::stop(\"live Custom Code result lost element names\")",
      sep = "\n"
    )
  }
  preview_case <- custom_preview(
    session_id_value,
    0L,
    paste0("flavor-custom-", case_index),
    custom_flavor_code
  )
  assert_identical(preview_case$kind, "stepPreview", paste(case$label, "Custom Code preview failed"))
  assert_identical(preview_case$page$dataframeFlavor, case$flavor, paste(case$label, "Custom Code changed flavor"))
  if (!is.null(case$elementNames)) {
    custom_flavor_sessions <- get(
      "sessions",
      envir = environment(custom_agent$dispatch_json),
      inherits = FALSE
    )
    custom_flavor_live_session <- get(session_id_value, envir = custom_flavor_sessions, inherits = FALSE)
    custom_flavor_live_result <- get(
      "snapshot",
      envir = custom_flavor_live_session$draft,
      inherits = FALSE
    )
    assert_identical(
      attr(.subset2(custom_flavor_live_result, 2L), "names", exact = TRUE),
      case$elementNames,
      paste(case$label, "live Custom Code capture changed result element names")
    )
  }
  generated_case_environment <- new.env(parent = baseenv())
  assign(variable_name, case$value, envir = generated_case_environment)
  eval(parse(text = preview_case$code), envir = generated_case_environment)
  expected_case <- if (identical(case$flavor, "r.data.table")) {
    data.table::copy(case$value)
  } else {
    unserialize(serialize(case$value, NULL, version = 3L))
  }
  expected_case[[2L]] <- expected_case[[2L]] + 1L
  if (!is.null(case$elementNames)) {
    data.table::setattr(.subset2(expected_case, 2L), "names", case$elementNames)
    assert_identical(
      attr(.subset2(generated_case_environment$open_wrangler_result, 2L), "names", exact = TRUE),
      case$elementNames,
      paste(case$label, "generated Custom Code changed result element names")
    )
  }
  custom_assert_true(
    isTRUE(all.equal(
      generated_case_environment$open_wrangler_result,
      expected_case,
      check.attributes = TRUE
    )),
    paste(case$label, "generated Custom Code changed output")
  )
  assert_identical(
    serialize(get(variable_name, envir = custom_environment), NULL, version = 3L),
    source_before_case,
    paste(case$label, "live Custom Code mutated source")
  )
  assert_identical(
    serialize(get(variable_name, envir = generated_case_environment), NULL, version = 3L),
    source_before_case,
    paste(case$label, "generated Custom Code mutated source")
  )
  discarded_case <- custom_dispatch(
    "discardDraft",
    list(sessionId = session_id_value, revision = preview_case$revision, page = page_window())
  )
  assert_identical(discarded_case$action, "discard", paste(case$label, "Custom Code draft did not discard"))
  invisible(custom_dispatch("closeSession", list(sessionId = session_id_value)))
}

custom_environment$custom_named_rows <- data.frame(
  duplicate = c(10L, 20L, 30L),
  middle = c(1, 2, 3),
  duplicate = c("a", "b", "c"),
  check.names = FALSE,
  row.names = c("named-a", "named-b", "named-c")
)
custom_named_rows_before <- serialize(custom_environment$custom_named_rows, NULL, version = 3L)
custom_named_rows_session <- "22220001-0001-4001-8001-000100010001"
invisible(custom_dispatch(
  "openSession",
  list(sessionId = custom_named_rows_session, variableName = "custom_named_rows", page = page_window())
))
custom_named_rows_code <- paste(
  "result <- df[c(3L, 1L, 2L, 2L)]",
  "base::names(result) <- c(\"duplicate\", \"duplicate\", \"fresh\", \"middle\")",
  "result <- result[c(3L, 1L), , drop = FALSE]",
  sep = "\n"
)
custom_named_rows_preview <- custom_preview(
  custom_named_rows_session,
  0L,
  "duplicate-lineage",
  custom_named_rows_code
)
assert_identical(custom_named_rows_preview$kind, "stepPreview", "duplicate-name Custom Code did not preview")
assert_identical(
  vapply(custom_named_rows_preview$page$schema, `[[`, character(1L), "id"),
  c("r:c:0", "r:c:2", "c:step:duplicate-lineage:0", "r:c:1"),
  "Custom Code did not use FIFO duplicate-name lineage"
)
assert_identical(
  vapply(custom_named_rows_preview$page$page$rows, `[[`, character(1L), "rowLabel"),
  c("named-c", "named-a"),
  "Custom Code did not preserve explicit output row names"
)
custom_named_rows_generated <- new.env(parent = baseenv())
custom_named_rows_generated$custom_named_rows <- custom_environment$custom_named_rows
eval(parse(text = custom_named_rows_preview$code), envir = custom_named_rows_generated)
assert_identical(
  attr(custom_named_rows_generated$open_wrangler_result, "row.names", exact = TRUE),
  c("named-c", "named-a"),
  "generated Custom Code changed explicit row names"
)
assert_identical(
  serialize(custom_named_rows_generated$custom_named_rows, NULL, version = 3L),
  custom_named_rows_before,
  "generated duplicate-name Custom Code mutated its source"
)
invisible(custom_dispatch(
  "discardDraft",
  list(
    sessionId = custom_named_rows_session,
    revision = custom_named_rows_preview$revision,
    page = page_window()
  )
))
invisible(custom_dispatch("closeSession", list(sessionId = custom_named_rows_session)))

custom_environment$custom_spec_source <- tibble::tibble(value = 1:2)
custom_spec_before <- serialize(custom_environment$custom_spec_source, NULL, version = 3L)
custom_spec_session <- "22220002-0002-4002-8002-000200020002"
invisible(custom_dispatch(
  "openSession",
  list(sessionId = custom_spec_session, variableName = "custom_spec_source", page = page_window())
))
custom_spec_code <- paste(
  "result <- df",
  "base::attr(result, \"spec\") <- base::list(marker = TRUE)",
  "base::attr(result, \"problems\") <- base::list()",
  "base::class(result) <- c(\"spec_tbl_df\", \"tbl_df\", \"tbl\", \"data.frame\")",
  sep = "\n"
)
custom_spec_preview <- custom_preview(
  custom_spec_session,
  0L,
  "spec-result",
  custom_spec_code
)
assert_identical(custom_spec_preview$kind, "stepPreview", "spec_tbl_df Custom Code result did not normalize")
assert_identical(
  custom_spec_preview$page$frameSemantics$classes,
  list("tbl_df", "tbl", "data.frame"),
  "live Custom Code retained readr-only dataframe classes"
)
custom_spec_generated <- new.env(parent = baseenv())
custom_spec_generated$custom_spec_source <- custom_environment$custom_spec_source
eval(parse(text = custom_spec_preview$code), envir = custom_spec_generated)
assert_identical(
  class(custom_spec_generated$open_wrangler_result),
  c("tbl_df", "tbl", "data.frame"),
  "generated Custom Code did not normalize a spec_tbl_df result"
)
assert_identical(
  serialize(custom_spec_generated$custom_spec_source, NULL, version = 3L),
  custom_spec_before,
  "generated spec_tbl_df Custom Code mutated its source"
)
invisible(custom_dispatch(
  "discardDraft",
  list(sessionId = custom_spec_session, revision = custom_spec_preview$revision, page = page_window())
))
invisible(custom_dispatch("closeSession", list(sessionId = custom_spec_session)))

custom_environment$orders_table <- data.table::data.table(id = c(2L, 1L), value = c(20L, 10L))
data.table::setkey(custom_environment$orders_table, id)
data.table::setattr(
  .subset2(custom_environment$orders_table, 2L),
  "names",
  c("value-one", "value-two")
)
custom_table_before <- serialize(custom_environment$orders_table, NULL, version = 3L)
custom_table_session <- "22220003-0003-4003-8003-000300030003"
invisible(custom_dispatch(
  "openSession",
  list(sessionId = custom_table_session, variableName = "orders_table", page = page_window())
))
custom_table_code <- paste(
  "data.table::set(orders_table, j = \"extra\", value = orders_table$value + 1L)",
  "result <- orders_table",
  sep = "\n"
)
custom_table_preview <- custom_preview(
  custom_table_session,
  0L,
  "table-mutation",
  custom_table_code
)
assert_identical(custom_table_preview$kind, "stepPreview", "data.table Custom Code mutation did not preview")
assert_identical(
  custom_table_preview$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "data.table Custom Code did not dynamically retain its key"
)
assert_identical(
  serialize(custom_environment$orders_table, NULL, version = 3L),
  custom_table_before,
  "data.table Custom Code mutated its live source by reference"
)
custom_table_generated <- new.env(parent = baseenv())
custom_table_generated$orders_table <- custom_environment$orders_table
eval(parse(text = custom_table_preview$code), envir = custom_table_generated)
assert_identical(
  attr(custom_table_generated$open_wrangler_result, "sorted", exact = TRUE),
  "id",
  "generated data.table Custom Code changed its key"
)
assert_identical(
  attr(.subset2(custom_table_generated$open_wrangler_result, 2L), "names", exact = TRUE),
  c("value-one", "value-two"),
  "generated data.table Custom Code changed element names"
)
assert_identical(
  serialize(custom_table_generated$orders_table, NULL, version = 3L),
  custom_table_before,
  "generated data.table Custom Code mutated its source"
)
custom_table_discard <- custom_dispatch(
  "discardDraft",
  list(sessionId = custom_table_session, revision = custom_table_preview$revision, page = page_window())
)
custom_table_superassign <- custom_preview(
  custom_table_session,
  custom_table_discard$revision,
  "table-superassign",
  "orders_table <<- df\nresult <- df"
)
assert_identical(custom_table_superassign$kind, "error", "Custom Code escaped the selected-variable superassignment shield")
assert_identical(custom_table_superassign$recoverable, TRUE, "selected-variable superassignment was not recoverable")
assert_identical(
  serialize(custom_environment$orders_table, NULL, version = 3L),
  custom_table_before,
  "selected-variable superassignment changed the data.table source"
)
custom_table_failure <- custom_preview(
  custom_table_session,
  custom_table_discard$revision,
  "table-error-atomicity",
  "data.table::set(df, j = \"failed\", value = 1L)\nbase::stop(\"expected failure\")"
)
assert_identical(custom_table_failure$kind, "error", "failing data.table Custom Code was accepted")
assert_identical(custom_table_failure$recoverable, TRUE, "failing data.table Custom Code was not recoverable")
assert_identical(
  serialize(custom_environment$orders_table, NULL, version = 3L),
  custom_table_before,
  "failing data.table Custom Code mutated its source"
)
custom_table_shield_code <- paste(
  "if (base::exists(\"fail_generated\", inherits = TRUE)) orders_table <<- df",
  "result <- df",
  sep = "\n"
)
custom_table_shield_preview <- custom_preview(
  custom_table_session,
  custom_table_discard$revision,
  "table-generated-shield",
  custom_table_shield_code
)
assert_identical(custom_table_shield_preview$kind, "stepPreview", "the generated shield fixture did not preview")
custom_table_shield_environment <- new.env(parent = baseenv())
custom_table_shield_environment$orders_table <- custom_environment$orders_table
custom_table_shield_environment$fail_generated <- TRUE
custom_table_shield_environment$open_wrangler_result <- "sentinel"
custom_table_shield_error <- tryCatch(
  {
    eval(parse(text = custom_table_shield_preview$code), envir = custom_table_shield_environment)
    NULL
  },
  error = identity
)
custom_assert_true(inherits(custom_table_shield_error, "error"), "generated Custom Code escaped its source shield")
assert_identical(
  custom_table_shield_environment$open_wrangler_result,
  "sentinel",
  "failed generated Custom Code changed the prior publication"
)
assert_identical(
  serialize(custom_table_shield_environment$orders_table, NULL, version = 3L),
  custom_table_before,
  "failed generated Custom Code changed its data.table source"
)
invisible(custom_dispatch(
  "discardDraft",
  list(
    sessionId = custom_table_session,
    revision = custom_table_shield_preview$revision,
    page = page_window()
  )
))
invisible(custom_dispatch("closeSession", list(sessionId = custom_table_session)))

custom_shield_names <- c("df", "result")
custom_shield_session_ids <- c(
  "22220005-0005-4005-8005-000500050005",
  "22220006-0006-4006-8006-000600060006"
)
for (shield_index in seq_along(custom_shield_names)) {
  shield_name <- custom_shield_names[[shield_index]]
  shield_session <- custom_shield_session_ids[[shield_index]]
  shield_source <- data.frame(value = 1:2)
  shield_before <- serialize(shield_source, NULL, version = 3L)
  assign(shield_name, shield_source, envir = custom_environment)
  invisible(custom_dispatch(
    "openSession",
    list(sessionId = shield_session, variableName = shield_name, page = page_window())
  ))
  shield_error_code <- if (identical(shield_name, "df")) {
    "df <<- base::data.frame(value = 9L)\nresult <- df"
  } else {
    "result <<- df"
  }
  shield_error <- custom_preview(
    shield_session,
    0L,
    paste0("shield-error-", shield_name),
    shield_error_code
  )
  assert_identical(shield_error$kind, "error", paste("Custom Code escaped the", shield_name, "source shield"))
  assert_identical(shield_error$recoverable, TRUE, paste(shield_name, "source shield error was not recoverable"))
  assert_identical(
    serialize(get(shield_name, envir = custom_environment), NULL, version = 3L),
    shield_before,
    paste(shield_name, "source shield error mutated the source")
  )
  shield_retry <- custom_preview(
    shield_session,
    0L,
    paste0("shield-retry-", shield_name),
    "result <- df"
  )
  assert_identical(shield_retry$kind, "stepPreview", paste(shield_name, "source shield left a hidden draft"))
  invisible(custom_dispatch(
    "discardDraft",
    list(sessionId = shield_session, revision = shield_retry$revision, page = page_window())
  ))
  invisible(custom_dispatch("closeSession", list(sessionId = shield_session)))
}

custom_environment$custom_metadata_source <- data.frame(
  category = factor(c("a", NA), levels = c("unused", "a")),
  day = as.Date(c("2026-01-01", NA)),
  instant = as.POSIXct(c("2026-01-01 12:00:00", NA), tz = "UTC"),
  elapsed = as.difftime(c(1, NA), units = "hours"),
  wide = bit64::as.integer64(c("9223372036854775806", NA)),
  check.names = FALSE
)
attr(
  custom_environment$custom_metadata_source$category,
  "levels"
) <- structure(c("unused", "a"), class = "AsIs")
attr(
  custom_environment$custom_metadata_source$instant,
  "tzone"
) <- structure("UTC", class = "AsIs")
attr(
  custom_environment$custom_metadata_source$elapsed,
  "units"
) <- structure("hours", class = "AsIs")
custom_metadata_before <- serialize(custom_environment$custom_metadata_source, NULL, version = 3L)
custom_metadata_session <- "22220007-0007-4007-8007-000700070007"
invisible(custom_dispatch(
  "openSession",
  list(sessionId = custom_metadata_session, variableName = "custom_metadata_source", page = page_window())
))
custom_metadata_preview <- custom_preview(
  custom_metadata_session,
  0L,
  "metadata-pass-through",
  "result <- df"
)
assert_identical(custom_metadata_preview$kind, "stepPreview", "Custom Code rejected supported attributed columns")
custom_metadata_generated <- new.env(parent = baseenv())
custom_metadata_generated$custom_metadata_source <- custom_environment$custom_metadata_source
eval(parse(text = custom_metadata_preview$code), envir = custom_metadata_generated)
assert_identical(
  custom_metadata_generated$open_wrangler_result,
  custom_environment$custom_metadata_source,
  "generated Custom Code changed supported attributed columns"
)
assert_identical(
  serialize(custom_metadata_generated$custom_metadata_source, NULL, version = 3L),
  custom_metadata_before,
  "generated attributed Custom Code mutated its source"
)
invisible(custom_dispatch(
  "discardDraft",
  list(
    sessionId = custom_metadata_session,
    revision = custom_metadata_preview$revision,
    page = page_window()
  )
))
invisible(custom_dispatch("closeSession", list(sessionId = custom_metadata_session)))

custom_environment$preflight_source <- data.frame(value = 1L)
custom_environment$preflight_marker <- FALSE
custom_preflight_before <- serialize(custom_environment$preflight_source, NULL, version = 3L)
custom_preflight_session <- "22220004-0004-4004-8004-000400040004"
invisible(custom_dispatch(
  "openSession",
  list(sessionId = custom_preflight_session, variableName = "preflight_source", page = page_window())
))
custom_agent_environment <- environment(custom_agent$dispatch_json)
custom_sessions <- get("sessions", envir = custom_agent_environment, inherits = FALSE)
synthetic_session <- get(custom_preflight_session, envir = custom_sessions, inherits = FALSE)
synthetic_code <- paste0("result <- df\n#", paste(rep.int("x", 65300L), collapse = ""))
synthetic_bound_plan <- lapply(seq_len(65L), function(index) list(
  id = paste0("synthetic-custom-", index),
  kind = "customCode",
  params = list(code = synthetic_code)
))
synthetic_session$boundPlan <- synthetic_bound_plan
synthetic_session$plan <- synthetic_bound_plan
assign(custom_preflight_session, synthetic_session, envir = custom_sessions)
custom_preflight_response <- custom_preview(
  custom_preflight_session,
  0L,
  "overflow-candidate",
  "preflight_marker <<- TRUE\nresult <- df"
)
assert_identical(custom_preflight_response$kind, "error", "an oversized generated plan was accepted")
assert_identical(custom_preflight_response$code, "runtime_error", "the generated-plan cap diagnostic changed")
assert_identical(custom_environment$preflight_marker, FALSE, "Custom Code evaluated before generated-plan preflight")
assert_identical(
  serialize(custom_environment$preflight_source, NULL, version = 3L),
  custom_preflight_before,
  "generated-plan preflight changed the source"
)
invisible(custom_dispatch("closeSession", list(sessionId = custom_preflight_session)))

custom_agent$dispose()

custom_s3_script <- tempfile(fileext = ".R")
writeLines(c(
  "arguments <- commandArgs(trailingOnly = TRUE)",
  "source(arguments[[1L]], local = FALSE)",
  "source(arguments[[2L]], local = FALSE)",
  "source(arguments[[3L]], local = FALSE)",
  "dispatch_count <- 0L",
  "poison <- function(...) { dispatch_count <<- dispatch_count + 1L; stop('caller S3 poison dispatched', call. = FALSE) }",
  "registerS3method('[[', 'AsIs', poison, envir = .GlobalEnv)",
  "registerS3method('[[', 'data.frame', poison, envir = .GlobalEnv)",
  "source_environment <- new.env(parent = baseenv())",
  "source_frame <- data.frame(value = c('a', 'b'), check.names = FALSE)",
  "attr(source_frame, 'names') <- structure('value', class = 'AsIs')",
  "source_before <- serialize(source_frame, NULL, version = 3L)",
  "source_environment$source_frame <- source_frame",
  "agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, source_environment)",
  "page <- list(rowOffset = 0L, rowLimit = 100L, columnOffset = 0L, columnLimit = 100L, view = list(filters = I(list()), sorts = I(list())))",
  "dispatch <- function(kind, payload) { request <- jsonlite::toJSON(list(transportVersion = 14L, requestId = '11111111-1111-4111-8111-111111111111', kind = kind, payload = payload), auto_unbox = TRUE, null = 'null'); jsonlite::fromJSON(agent$dispatch_json(as.character(request)), simplifyVector = FALSE) }",
  "session_id <- '22222222-2222-4222-8222-222222222222'",
  "opened <- dispatch('openSession', list(sessionId = session_id, variableName = 'source_frame', page = page))",
  "if (!identical(opened$kind, 'page')) stop('S3-poison source did not open', call. = FALSE)",
  "preview <- dispatch('previewStep', list(sessionId = session_id, revision = 0L, step = list(id = 's3-custom', kind = 'customCode', params = list(code = 'result <- df')), page = page))",
  "if (!identical(preview$kind, 'stepPreview')) stop('S3-poison Custom Code preview failed', call. = FALSE)",
  "generated_environment <- new.env(parent = baseenv())",
  "generated_environment$source_frame <- source_frame",
  "eval(parse(text = preview$code), envir = generated_environment)",
  "if (!identical(generated_environment$open_wrangler_result, source_frame)) stop('S3-poison generated output changed', call. = FALSE)",
  "if (!identical(serialize(source_frame, NULL, version = 3L), source_before)) stop('S3-poison Custom Code mutated source', call. = FALSE)",
  "if (!identical(dispatch_count, 0L)) stop('caller S3 poison was dispatched', call. = FALSE)",
  "agent$dispose()"
), custom_s3_script, useBytes = TRUE)
custom_s3_output <- system2(
  file.path(R.home("bin"), "Rscript"),
  c(
    "--vanilla",
    custom_s3_script,
    normalizePath("r/openwrangler_runtime/frame_contract.R"),
    normalizePath("r/openwrangler_runtime/kernel_exports.R"),
    normalizePath("r/openwrangler_runtime/kernel_agent.R")
  ),
  stdout = TRUE,
  stderr = TRUE
)
custom_s3_status <- attr(custom_s3_output, "status", exact = TRUE)
if (!is.null(custom_s3_status) && custom_s3_status != 0L) {
  stop(paste(c("Custom Code S3-isolation child failed", custom_s3_output), collapse = "\n"), call. = FALSE)
}
unlink(custom_s3_script)
