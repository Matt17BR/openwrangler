# Selected-step replacement replays only the selected prefix in the runtime;
# the host owns the atomic full-plan candidate and suffix replay transaction.
earlier_session_id <- "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f"
earlier_step <- function(id, column_id, old_name, new_name) {
  list(
    id = id,
    kind = "renameColumn",
    params = list(column = list(id = column_id, name = old_name), newName = new_name)
  )
}

earlier_open <- dispatch(
  "openSession",
  list(sessionId = earlier_session_id, variableName = "rename_frame", page = page_window())
)
assert_identical(earlier_open$kind, "page", "the earlier-step R session did not open")

first_step <- earlier_step("earlier-first", "r:c:1", "duplicate", "amount")
first_preview <- dispatch(
  "previewStep",
  list(sessionId = earlier_session_id, revision = 0L, step = first_step, page = page_window())
)
assert_identical(first_preview$kind, "stepPreview", "the first R history step did not preview")
first_apply <- dispatch(
  "applyDraft",
  list(sessionId = earlier_session_id, revision = 1L, page = page_window())
)
assert_identical(first_apply$action, "apply", "the first R history step did not apply")

suffix_step <- earlier_step("earlier-suffix", "r:c:2", "label", "category")
suffix_preview <- dispatch(
  "previewStep",
  list(sessionId = earlier_session_id, revision = 2L, step = suffix_step, page = page_window())
)
assert_identical(suffix_preview$kind, "stepPreview", "the R history suffix did not preview")
suffix_apply <- dispatch(
  "applyDraft",
  list(sessionId = earlier_session_id, revision = 3L, page = page_window())
)
assert_identical(suffix_apply$action, "apply", "the R history suffix did not apply")

replacement <- earlier_step("earlier-first", "r:c:1", "duplicate", "updated amount")
replacement_preview <- dispatch(
  "previewStep",
  list(
    sessionId = earlier_session_id,
    revision = 4L,
    step = replacement,
    replaceStepId = "earlier-first",
    page = page_window()
  )
)
assert_identical(replacement_preview$kind, "stepPreview", "the selected earlier R step did not preview")
assert_identical(
  vapply(replacement_preview$page$schema, `[[`, character(1L), "name"),
  c("duplicate", "updated amount", "label"),
  "the earlier R preview did not use the selected step's exact input prefix"
)
if (!grepl("updated amount", replacement_preview$code, fixed = TRUE) ||
  grepl("category", replacement_preview$code, fixed = TRUE)) {
  stop("the earlier R preview code did not stop at the selected replacement", call. = FALSE)
}

direct_apply <- dispatch(
  "applyDraft",
  list(sessionId = earlier_session_id, revision = 5L, page = page_window())
)
assert_identical(direct_apply$kind, "error", "the runtime directly applied an earlier R replacement")
assert_identical(direct_apply$code, "invalid_request", "the earlier R replacement diagnostic changed")

discarded <- dispatch(
  "discardDraft",
  list(sessionId = earlier_session_id, revision = 5L, page = page_window())
)
assert_identical(
  vapply(discarded$page$schema, `[[`, character(1L), "name"),
  c("duplicate", "amount", "category"),
  "discard did not restore the complete confirmed R plan"
)
assert_identical(source_environment$rename_frame, rename_source_before, "earlier-step R editing mutated its source")
closed_earlier <- dispatch("closeSession", list(sessionId = earlier_session_id))
assert_identical(closed_earlier$kind, "closed", "the earlier-step R session did not close")
