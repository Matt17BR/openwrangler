# Text-transform kernel-agent contract cases.

source_environment$text_length_frame <- data.frame(
  duplicate = c("caf\u00e9", "\U0001F642", NA_character_),
  duplicate = factor(c("alpha", NA, "\u03b2eta"), levels = c("alpha", "\u03b2eta")),
  number = c(1L, 2L, 3L),
  check.names = FALSE,
  row.names = c("row-a", "row-b", "row-c")
)
text_length_source_before <- unserialize(serialize(source_environment$text_length_frame, NULL, version = 3L))

text_length_step <- function(
  id = "text-length-step",
  column_id = "r:c:0",
  column_name = "duplicate",
  new_column = "character count"
) {
  list(
    id = id,
    kind = "textLength",
    params = list(column = list(id = column_id, name = column_name), newColumn = new_column)
  )
}
text_length_open <- dispatch(
  "openSession",
  list(sessionId = text_length_session_id, variableName = "text_length_frame", page = page_window())
)
assert_identical(text_length_open$kind, "page", "the R Text Length session did not open")
text_length_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_length_session_id,
    revision = 0L,
    step = text_length_step(),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(text_length_preview$kind, "stepPreview", "the R Text Length step did not preview")
assert_identical(text_length_preview$revision, 1L, "the R Text Length preview revision changed")
assert_identical(
  text_length_preview$page$page$columnIds,
  list("c:step:text-length-step:0"),
  "the R Text Length preview lost its derived identity"
)
assert_identical(text_length_preview$page$schema[[4L]]$rawType, "integer", "R Text Length did not return integers")
assert_identical(text_length_preview$page$schema[[4L]]$type, "integer", "R Text Length published the wrong type")
assert_identical(
  text_length_preview$page$schema[[4L]]$nullable,
  text_length_preview$page$schema[[1L]]$nullable,
  "R Text Length changed source nullability"
)
assert_identical(
  vapply(text_length_preview$page$page$rows, function(row) row$values[[1L]]$kind, character(1L)),
  c("integer", "integer", "null"),
  "R Text Length lost Unicode or NA cell types"
)
assert_identical(
  vapply(text_length_preview$page$page$rows[1:2], function(row) row$values[[1L]]$raw, character(1L)),
  c("4", "1"),
  "R Text Length counted bytes instead of characters"
)
assert_identical(text_length_preview$diff$addedColumns, list("character count"), "R Text Length lost its diff")
assert_identical(text_length_preview$diff$removedColumns, list(), "R Text Length removed a column")
assert_identical(text_length_preview$diff$changedCells, 0L, "R Text Length reported changed source cells")
assert_identical(text_length_preview$diff$cells, list(), "R Text Length returned cell diffs")
text_length_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_length_session_id, revision = 1L, page = page_window())
)
assert_identical(text_length_discard$action, "discard", "the R Text Length draft did not discard")
assert_identical(text_length_discard$page$shape$columns, 3L, "discarding R Text Length kept its output")

text_length_preview <- dispatch(
  "previewStep",
  list(sessionId = text_length_session_id, revision = 2L, step = text_length_step(), page = page_window())
)
text_length_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_length_session_id, revision = 3L, page = page_window())
)
assert_identical(text_length_apply$action, "apply", "the R Text Length draft did not apply")
assert_identical(
  vapply(text_length_apply$page$schema, `[[`, character(1L), "id"),
  c("r:c:0", "r:c:1", "r:c:2", "c:step:text-length-step:0"),
  "applying R Text Length changed stable identities"
)
text_length_inspection <- inspect_step(
  text_length_session_id,
  4L,
  "text-length-step",
  page_window()
)
assert_identical(text_length_inspection$kind, "stepInspection", "the applied R Text Length step was not inspectable")
assert_schema_less_inspection(text_length_inspection, "R Text Length inspection")
assert_identical(
  text_length_inspection$outputPage$shape$columns,
  4L,
  "R Text Length inspection returned the wrong width"
)

text_length_rename <- list(
  id = "rename-text-length",
  kind = "renameColumn",
  params = list(
    column = list(id = "c:step:text-length-step:0", name = "character count"),
    newName = "renamed count"
  )
)
text_length_rename_preview <- dispatch(
  "previewStep",
  list(sessionId = text_length_session_id, revision = 4L, step = text_length_rename, page = page_window())
)
assert_identical(text_length_rename_preview$kind, "stepPreview", "Rename could not target R Text Length output")
text_length_rename_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_length_session_id, revision = 5L, page = page_window())
)
assert_identical(
  text_length_rename_apply$page$schema[[4L]]$id,
  "c:step:text-length-step:0",
  "renaming R Text Length output changed its lineage"
)
assert_identical(text_length_rename_apply$page$schema[[4L]]$name, "renamed count", "R Text Length rename was lost")
if (!grepl("nchar(as.character", text_length_rename_apply$code, fixed = TRUE)) {
  stop("generated R Text Length code lost its native character-count expression", call. = FALSE)
}
assign("text_length_frame", source_environment$text_length_frame, envir = .GlobalEnv)
eval(parse(text = text_length_rename_apply$code), envir = .GlobalEnv)
text_length_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  names(text_length_generated),
  c("duplicate", "duplicate", "number", "renamed count"),
  "generated R Text Length returned the wrong columns"
)
assert_identical(text_length_generated[[4L]], c(4L, 1L, NA_integer_), "generated R Text Length changed its result")
assert_identical(row.names(text_length_generated), row.names(text_length_source_before), "generated R Text Length changed row names")
assert_identical(
  get("text_length_frame", envir = .GlobalEnv, inherits = FALSE),
  text_length_source_before,
  "generated R Text Length mutated its source dataframe"
)
rm("text_length_frame", "open_wrangler_result", envir = .GlobalEnv)

assign(
  "text_length_frame",
  data.frame(duplicate = 1:3, duplicate = factor(c("a", "b", "c")), number = 1:3, check.names = FALSE),
  envir = .GlobalEnv
)
text_length_generated_type_error <- tryCatch(
  {
    eval(parse(text = text_length_rename_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (
  is.null(text_length_generated_type_error) ||
    !grepl("requires a character or factor column", conditionMessage(text_length_generated_type_error), fixed = TRUE)
) {
  stop("generated R Text Length did not reject an incompatible source type", call. = FALSE)
}
rm("text_length_frame", envir = .GlobalEnv)

invalid_generated_text <- rawToChar(as.raw(0xff))
Encoding(invalid_generated_text) <- "bytes"
invalid_generated_text_length_source <- data.frame(
  duplicate = c(invalid_generated_text, "safe", NA_character_),
  duplicate = factor(c("alpha", NA, "beta")),
  number = 1:3,
  check.names = FALSE
)
invalid_generated_text_length_before <- unserialize(
  serialize(invalid_generated_text_length_source, NULL, version = 3L)
)
assign("text_length_frame", invalid_generated_text_length_source, envir = .GlobalEnv)
invalid_generated_text_length_error <- tryCatch(
  {
    eval(parse(text = text_length_rename_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (is.null(invalid_generated_text_length_error)) {
  stop("generated R Text Length accepted a non-missing bytes-encoded string", call. = FALSE)
}
assert_identical(
  get("text_length_frame", envir = .GlobalEnv, inherits = FALSE),
  invalid_generated_text_length_before,
  "generated R Text Length mutated invalid source text"
)
rm("text_length_frame", envir = .GlobalEnv)

wide_text_length_names <- c("duplicate", "duplicate", "number", sprintf("wide_%04d", 4:2048))
wide_text_length_source <- as.data.frame(
  setNames(replicate(2048L, "x", simplify = FALSE), wide_text_length_names),
  optional = TRUE
)
wide_text_length_before <- unserialize(serialize(wide_text_length_source, NULL, version = 3L))
assign("text_length_frame", wide_text_length_source, envir = .GlobalEnv)
wide_text_length_error <- tryCatch(
  {
    eval(parse(text = text_length_rename_apply$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (is.null(wide_text_length_error) || !grepl("column limit reached", conditionMessage(wide_text_length_error), fixed = TRUE)) {
  stop("generated R Text Length did not enforce the frame width limit", call. = FALSE)
}
assert_identical(
  get("text_length_frame", envir = .GlobalEnv, inherits = FALSE),
  wide_text_length_before,
  "the generated R Text Length width guard mutated its source"
)
rm("text_length_frame", envir = .GlobalEnv)

text_length_rename_undo <- dispatch(
  "undoStep",
  list(sessionId = text_length_session_id, revision = 6L, page = page_window())
)
assert_identical(text_length_rename_undo$action, "undo", "undo did not restore the R Text Length step")
assert_identical(text_length_rename_undo$page$schema[[4L]]$name, "character count", "undo lost R Text Length output")
text_length_edit_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_length_session_id,
    revision = 7L,
    step = text_length_step(
      column_id = "r:c:1",
      column_name = "duplicate",
      new_column = "factor count"
    ),
    replaceStepId = "text-length-step",
    page = page_window()
  )
)
assert_identical(text_length_edit_preview$kind, "stepPreview", "the latest R Text Length step could not be edited")
assert_identical(
  text_length_edit_preview$page$schema[[4L]]$id,
  "c:step:text-length-step:0",
  "editing R Text Length regenerated its output identity"
)
assert_identical(text_length_edit_preview$page$schema[[4L]]$name, "factor count", "editing R Text Length kept its old name")
assert_identical(
  c(
    text_length_edit_preview$page$page$rows[[1L]]$values[[4L]]$raw,
    text_length_edit_preview$page$page$rows[[3L]]$values[[4L]]$raw
  ),
  c("5", "4"),
  "edited R Text Length did not count factor labels"
)
assert_identical(
  text_length_edit_preview$page$page$rows[[2L]]$values[[4L]]$kind,
  "null",
  "edited R Text Length did not preserve factor NA"
)
text_length_edit_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_length_session_id, revision = 8L, page = page_window())
)
assert_identical(text_length_edit_apply$action, "apply", "the edited R Text Length step did not apply")
text_length_undo <- dispatch(
  "undoStep",
  list(sessionId = text_length_session_id, revision = 9L, page = page_window())
)
assert_identical(text_length_undo$action, "undo", "the edited R Text Length step did not undo")
assert_identical(text_length_undo$page$shape$columns, 3L, "undoing R Text Length did not restore the source schema")

for (invalid_step in list(
  text_length_step("text-length-numeric", "r:c:2", "number", "number count"),
  text_length_step("text-length-collision", new_column = "duplicate"),
  text_length_step("text-length-private", new_column = "__OPEN_WRANGLER_INTERNAL_ROW_ID_length")
)) {
  invalid_text_length <- dispatch(
    "previewStep",
    list(sessionId = text_length_session_id, revision = 10L, step = invalid_step, page = page_window())
  )
  assert_identical(invalid_text_length$kind, "error", "an invalid R Text Length step was accepted")
  assert_identical(invalid_text_length$code, "invalid_request", "the invalid R Text Length diagnostic changed")
}
for (stale_step in list(
  text_length_step("text-length-stale", "r:c:99"),
  text_length_step("text-length-misnamed", column_name = "wrong")
)) {
  stale_text_length <- dispatch(
    "previewStep",
    list(sessionId = text_length_session_id, revision = 10L, step = stale_step, page = page_window())
  )
  assert_identical(stale_text_length$kind, "error", "a stale R Text Length step was accepted")
  assert_identical(stale_text_length$code, "stale_column", "the stale R Text Length diagnostic changed")
}
long_text_length_step_id <- paste0("long-", strrep("x", 1019L))
long_text_length_column_id <- paste0("c:step:", long_text_length_step_id, ":0")
long_text_length_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_length_session_id,
    revision = 10L,
    step = text_length_step(long_text_length_step_id, new_column = "long count"),
    page = page_window()
  )
)
assert_identical(long_text_length_preview$kind, "stepPreview", "a bounded long R Text Length identity did not preview")
assert_identical(
  long_text_length_preview$page$schema[[4L]]$id,
  long_text_length_column_id,
  "the bounded long R Text Length identity changed"
)
long_text_length_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_length_session_id, revision = 11L, page = page_window())
)
assert_identical(long_text_length_discard$action, "discard", "the long R Text Length draft did not discard")
assert_identical(source_environment$text_length_frame, text_length_source_before, "the R Text Length lifecycle mutated its source")
text_length_closed <- dispatch("closeSession", list(sessionId = text_length_session_id))
assert_identical(text_length_closed$kind, "closed", "the R Text Length session did not close")

invalid_live_text <- rawToChar(as.raw(0xff))
Encoding(invalid_live_text) <- "bytes"
source_environment$invalid_text_length_frame <- data.frame(
  safe = 1L,
  text = invalid_live_text,
  check.names = FALSE
)
invalid_live_text_before <- unserialize(
  serialize(source_environment$invalid_text_length_frame, NULL, version = 3L)
)
invalid_text_length_open <- dispatch(
  "openSession",
  list(
    sessionId = invalid_text_length_session_id,
    variableName = "invalid_text_length_frame",
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(invalid_text_length_open$kind, "page", "the invalid-text R session did not open safely")
invalid_text_length_preview <- dispatch(
  "previewStep",
  list(
    sessionId = invalid_text_length_session_id,
    revision = 0L,
    step = text_length_step("invalid-bytes-text-length", "r:c:1", "text", "count"),
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(invalid_text_length_preview$kind, "error", "R Text Length accepted non-missing invalid text")
assert_identical(invalid_text_length_preview$code, "runtime_error", "invalid R text was not failed closed")
assert_identical(
  source_environment$invalid_text_length_frame,
  invalid_live_text_before,
  "failed R Text Length mutated invalid source text"
)
invalid_text_length_closed <- dispatch("closeSession", list(sessionId = invalid_text_length_session_id))
assert_identical(invalid_text_length_closed$kind, "closed", "the invalid-text R session did not close")

source_environment$text_length_table <- data.table::data.table(
  primary_key = c(2L, 1L),
  value = c("\U0001F642", NA_character_)
)
data.table::setkey(source_environment$text_length_table, primary_key)
text_length_table_before <- data.table::copy(source_environment$text_length_table)
text_length_table_open <- dispatch(
  "openSession",
  list(sessionId = text_length_table_session_id, variableName = "text_length_table", page = page_window())
)
assert_identical(text_length_table_open$kind, "page", "the R data.table Text Length session did not open")
text_length_table_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_length_table_session_id,
    revision = 0L,
    step = text_length_step("text-length-table", "r:c:1", "value", "value count"),
    page = page_window()
  )
)
assert_identical(
  text_length_table_preview$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "R data.table Text Length changed its key identity"
)
text_length_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_length_table_session_id, revision = 1L, page = page_window())
)
assign("text_length_table", source_environment$text_length_table, envir = .GlobalEnv)
eval(parse(text = text_length_table_apply$code), envir = .GlobalEnv)
text_length_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  class(text_length_table_generated),
  c("data.table", "data.frame"),
  "generated R Text Length lost the data.table class"
)
assert_identical(data.table::key(text_length_table_generated), "primary_key", "generated R Text Length lost the key")
assert_identical(text_length_table_generated[[3L]], c(NA_integer_, 1L), "generated R data.table Text Length changed values")
assert_identical(
  get("text_length_table", envir = .GlobalEnv, inherits = FALSE),
  text_length_table_before,
  "generated R data.table Text Length mutated its source"
)
rm("text_length_table", "open_wrangler_result", envir = .GlobalEnv)
text_length_table_closed <- dispatch("closeSession", list(sessionId = text_length_table_session_id))
assert_identical(text_length_table_closed$kind, "closed", "the R data.table Text Length session did not close")

source_environment$lower_frame <- data.frame(
  text = c("ALPHA", "MiXeD", NA_character_),
  category = factor(c("FIRST", NA, "B\u00c9TA"), levels = c("FIRST", "B\u00c9TA")),
  number = 1:3,
  row.names = c("row-a", "row-b", "row-c")
)
lower_source_before <- unserialize(serialize(source_environment$lower_frame, NULL, version = 3L))
lower_step <- function(
  id = "lower-step",
  column_id = "r:c:0",
  column_name = "text",
  new_column = NULL
) {
  params <- list(column = list(id = column_id, name = column_name))
  if (!is.null(new_column)) params$newColumn <- new_column
  list(id = id, kind = "lowerText", params = params)
}
lower_open <- dispatch(
  "openSession",
  list(sessionId = lower_session_id, variableName = "lower_frame", page = page_window())
)
assert_identical(lower_open$kind, "page", "the R Lowercase session did not open")

lower_derived_preview <- dispatch(
  "previewStep",
  list(
    sessionId = lower_session_id,
    revision = 0L,
    step = lower_step(new_column = "lower copy"),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(lower_derived_preview$kind, "stepPreview", "derived R Lowercase did not preview")
assert_identical(
  lower_derived_preview$page$page$columnIds,
  list("c:step:lower-step:0"),
  "derived R Lowercase lost its output identity"
)
assert_identical(lower_derived_preview$diff$addedColumns, list("lower copy"), "derived R Lowercase lost its diff")
assert_identical(lower_derived_preview$diff$changedCells, 0L, "derived R Lowercase reported source-cell changes")
assert_identical(lower_derived_preview$page$schema[[4L]]$rawType, "character", "derived R Lowercase returned the wrong type")
assert_identical(
  lower_derived_preview$page$schema[[4L]]$nullable,
  lower_derived_preview$page$schema[[1L]]$nullable,
  "derived R Lowercase changed source nullability"
)
lower_derived_discard <- dispatch(
  "discardDraft",
  list(sessionId = lower_session_id, revision = 1L, page = page_window())
)
assert_identical(lower_derived_discard$action, "discard", "derived R Lowercase did not discard")

lower_in_place_preview <- dispatch(
  "previewStep",
  list(
    sessionId = lower_session_id,
    revision = 2L,
    step = lower_step(),
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(lower_in_place_preview$kind, "stepPreview", "in-place R Lowercase did not preview")
assert_identical(lower_in_place_preview$page$page$columnIds, list("r:c:0"), "in-place R Lowercase changed lineage")
assert_identical(lower_in_place_preview$diff$addedColumns, list(), "in-place R Lowercase added a column")
assert_identical(lower_in_place_preview$diff$changedCells, 2L, "in-place R Lowercase returned an inexact cell count")
assert_identical(length(lower_in_place_preview$diff$cells), 2L, "in-place R Lowercase lost bounded cell diffs")
assert_identical(lower_in_place_preview$diff$truncated, FALSE, "a complete R Lowercase diff was marked truncated")
assert_identical(
  vapply(lower_in_place_preview$diff$cells, function(cell) cell$before$raw, character(1L)),
  c("ALPHA", "MiXeD"),
  "R Lowercase diff lost before values"
)
assert_identical(
  vapply(lower_in_place_preview$diff$cells, function(cell) cell$after$raw, character(1L)),
  c("alpha", "mixed"),
  "R Lowercase diff lost after values"
)
lower_in_place_apply <- dispatch(
  "applyDraft",
  list(sessionId = lower_session_id, revision = 3L, page = page_window())
)
assert_identical(lower_in_place_apply$action, "apply", "in-place R Lowercase did not apply")
assert_identical(lower_in_place_apply$page$schema[[1L]]$id, "r:c:0", "applied R Lowercase changed lineage")
if (!grepl(".ow_output <- tolower(.ow_utf8)", lower_in_place_apply$code, fixed = TRUE)) {
  stop("generated R Lowercase code lost its native tolower expression", call. = FALSE)
}
assign("lower_frame", source_environment$lower_frame, envir = .GlobalEnv)
eval(parse(text = lower_in_place_apply$code), envir = .GlobalEnv)
lower_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(lower_generated$text, c("alpha", "mixed", NA_character_), "generated R Lowercase changed values")
assert_identical(row.names(lower_generated), row.names(lower_source_before), "generated R Lowercase changed row names")
assert_identical(
  get("lower_frame", envir = .GlobalEnv, inherits = FALSE),
  lower_source_before,
  "generated R Lowercase mutated its source dataframe"
)
rm("lower_frame", "open_wrangler_result", envir = .GlobalEnv)

lower_inspection <- inspect_step(
  lower_session_id,
  4L,
  "lower-step",
  page_window()
)
assert_identical(lower_inspection$kind, "stepInspection", "applied R Lowercase was not inspectable")
assert_identical(lower_inspection$diff$changedCells, 2L, "R Lowercase inspection lost its exact diff")
lower_undo <- dispatch(
  "undoStep",
  list(sessionId = lower_session_id, revision = 4L, page = page_window())
)
assert_identical(lower_undo$action, "undo", "R Lowercase did not undo")
assert_identical(source_environment$lower_frame, lower_source_before, "the R Lowercase lifecycle mutated its source")
lower_closed <- dispatch("closeSession", list(sessionId = lower_session_id))
assert_identical(lower_closed$kind, "closed", "the R Lowercase session did not close")

source_environment$lower_table <- data.table::data.table(
  primary_key = c("B", "a"),
  payload = c("SECOND", "FIRST"),
  row_marker = c("row-b", "row-a")
)
data.table::setkey(source_environment$lower_table, primary_key)
lower_table_before <- data.table::copy(source_environment$lower_table)
lower_table_open <- dispatch(
  "openSession",
  list(sessionId = lower_table_session_id, variableName = "lower_table", page = page_window())
)
assert_identical(lower_table_open$kind, "page", "the R data.table Lowercase session did not open")
lower_table_non_key <- dispatch(
  "previewStep",
  list(
    sessionId = lower_table_session_id,
    revision = 0L,
    step = lower_step("lower-table-payload", "r:c:1", "payload"),
    page = page_window()
  )
)
assert_identical(lower_table_non_key$kind, "stepPreview", "R Lowercase could not replace a non-key data.table column")
assert_identical(
  lower_table_non_key$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "in-place R Lowercase changed a retained data.table key"
)
lower_table_non_key_code <- lower_table_non_key$code
lower_table_discard <- dispatch(
  "discardDraft",
  list(sessionId = lower_table_session_id, revision = 1L, page = page_window())
)
assert_identical(lower_table_discard$action, "discard", "R data.table Lowercase did not discard")

lower_table_key_error <- dispatch(
  "previewStep",
  list(
    sessionId = lower_table_session_id,
    revision = 2L,
    step = lower_step("lower-table-key", "r:c:0", "primary_key"),
    page = page_window()
  )
)
assert_identical(lower_table_key_error$kind, "error", "R Lowercase silently replaced a data.table key")
assert_identical(lower_table_key_error$code, "invalid_request", "the data.table key diagnostic changed")
if (!grepl("choose a new output column", lower_table_key_error$message, fixed = TRUE)) {
  stop("R Lowercase did not explain how to preserve a data.table key", call. = FALSE)
}

lower_table_derived <- dispatch(
  "previewStep",
  list(
    sessionId = lower_table_session_id,
    revision = 2L,
    step = lower_step("lower-table-derived", "r:c:0", "primary_key", "lower key"),
    page = page_window()
  )
)
assert_identical(lower_table_derived$kind, "stepPreview", "derived R data.table Lowercase did not preview")
assert_identical(lower_table_derived$page$frameSemantics$keyColumnIds, list("r:c:0"), "derived R Lowercase lost the key")
lower_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = lower_table_session_id, revision = 3L, page = page_window())
)
assign("lower_table", source_environment$lower_table, envir = .GlobalEnv)
eval(parse(text = lower_table_apply$code), envir = .GlobalEnv)
lower_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(data.table::key(lower_table_generated), "primary_key", "generated R Lowercase lost the data.table key")
assert_identical(lower_table_generated$row_marker, lower_table_before$row_marker, "generated R Lowercase changed row order")
assert_identical(lower_table_generated$`lower key`, c("b", "a"), "generated R Lowercase changed derived values")
assert_identical(
  get("lower_table", envir = .GlobalEnv, inherits = FALSE),
  lower_table_before,
  "generated R data.table Lowercase mutated its source"
)
rm("lower_table", "open_wrangler_result", envir = .GlobalEnv)

generated_key_source <- data.table::copy(lower_table_before)
data.table::setkey(generated_key_source, payload)
generated_key_before <- data.table::copy(generated_key_source)
assign("lower_table", generated_key_source, envir = .GlobalEnv)
generated_key_error <- tryCatch(
  {
    eval(parse(text = lower_table_non_key_code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (is.null(generated_key_error) || !grepl("choose a new output column", conditionMessage(generated_key_error), fixed = TRUE)) {
  stop("generated R Lowercase silently replaced a data.table key", call. = FALSE)
}
assert_identical(
  get("lower_table", envir = .GlobalEnv, inherits = FALSE),
  generated_key_before,
  "the generated R Lowercase key guard mutated its source"
)
rm("lower_table", envir = .GlobalEnv)
assert_identical(source_environment$lower_table, lower_table_before, "the R data.table Lowercase lifecycle mutated its source")
lower_table_closed <- dispatch("closeSession", list(sessionId = lower_table_session_id))
assert_identical(lower_table_closed$kind, "closed", "the R data.table Lowercase session did not close")

source_environment$text_cleanup_frame <- data.frame(
  text = c("alpha-12", "b\u00e9ta-34", NA_character_),
  category = factor(c("small", NA, "MiXeD"), levels = c("small", "MiXeD")),
  row.names = c("text-a", "text-b", "text-c")
)
text_cleanup_before <- unserialize(serialize(source_environment$text_cleanup_frame, NULL, version = 3L))
text_transform_step <- function(
  kind,
  id,
  column_id,
  column_name,
  new_column = NULL,
  find = NULL,
  replacement = NULL,
  regex = NULL,
  characters = NULL,
  delimiter = NULL,
  index = NULL
) {
  params <- list(column = list(id = column_id, name = column_name))
  if (!is.null(new_column)) params$newColumn <- new_column
  if (identical(kind, "findReplace")) {
    params$find <- find
    params$replacement <- replacement
    params$regex <- regex
  } else if (identical(kind, "stripText") && !is.null(characters)) {
    params$characters <- characters
  } else if (identical(kind, "splitText")) {
    params$delimiter <- delimiter
    params$index <- index
  }
  list(id = id, kind = kind, params = params)
}
text_cleanup_open <- dispatch(
  "openSession",
  list(sessionId = text_cleanup_session_id, variableName = "text_cleanup_frame", page = page_window())
)
assert_identical(text_cleanup_open$kind, "page", "the R text-cleanup session did not open")

text_cleanup_malformed <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-malformed",
      "r:c:0",
      "text",
      find = "alpha",
      replacement = "beta",
      regex = "yes"
    ),
    page = page_window()
  )
)
assert_identical(text_cleanup_malformed$kind, "error", "R Find and Replace accepted a non-logical regex flag")
assert_identical(text_cleanup_malformed$code, "invalid_request", "the malformed R Find and Replace diagnostic changed")

strip_malformed <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 0L,
    step = text_transform_step(
      "stripText",
      "strip-malformed",
      "r:c:0",
      "text",
      characters = ""
    ),
    page = page_window()
  )
)
assert_identical(strip_malformed$kind, "error", "R Strip text accepted an empty character set")
assert_identical(strip_malformed$code, "invalid_request", "the malformed R Strip text diagnostic changed")

split_malformed <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 0L,
    step = text_transform_step(
      "splitText",
      "split-malformed",
      "r:c:0",
      "text",
      new_column = "text",
      delimiter = "-",
      index = 0L
    ),
    page = page_window()
  )
)
assert_identical(split_malformed$kind, "error", "R Split text accepted an in-place output")
assert_identical(split_malformed$code, "invalid_request", "the malformed R Split text diagnostic changed")

upper_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 0L,
    step = text_transform_step(
      "upperText",
      "upper-step",
      "r:c:1",
      "category",
      new_column = "upper category"
    ),
    page = page_window(column_offset = 2L, column_limit = 1L)
  )
)
assert_identical(upper_preview$kind, "stepPreview", "derived R Uppercase did not preview")
assert_identical(
  upper_preview$page$page$columnIds,
  list("c:step:upper-step:0"),
  "derived R Uppercase lost its output identity"
)
assert_identical(upper_preview$page$schema[[3L]]$rawType, "character", "R Uppercase did not convert a factor to character")
assert_identical(upper_preview$diff$addedColumns, list("upper category"), "derived R Uppercase lost its diff")
assert_identical(upper_preview$diff$changedCells, 0L, "derived R Uppercase reported source-cell changes")
upper_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 1L, page = page_window())
)
assert_identical(upper_apply$action, "apply", "derived R Uppercase did not apply")

find_regex_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 2L,
    step = text_transform_step(
      "findReplace",
      "find-regex-step",
      "r:c:0",
      "text",
      find = "^(.+)-([0-9]+)$",
      replacement = "\\2:\\1",
      regex = TRUE
    ),
    page = page_window(column_offset = 0L, column_limit = 1L)
  )
)
assert_identical(find_regex_preview$kind, "stepPreview", "regex R Find and Replace did not preview")
assert_identical(find_regex_preview$page$page$columnIds, list("r:c:0"), "in-place R Find and Replace changed lineage")
assert_identical(find_regex_preview$diff$addedColumns, list(), "in-place R Find and Replace added a column")
assert_identical(find_regex_preview$diff$changedCells, 2L, "regex R Find and Replace returned an inexact cell count")
assert_identical(
  vapply(find_regex_preview$diff$cells, function(cell) cell$after$raw, character(1L)),
  c("12:alpha", "34:b\u00e9ta"),
  "regex R Find and Replace returned the wrong values"
)
find_regex_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 3L, page = page_window())
)
assert_identical(find_regex_apply$action, "apply", "regex R Find and Replace did not apply")
if (!grepl(".ow_output <- toupper(.ow_utf8)", find_regex_apply$code, fixed = TRUE)) {
  stop("generated R Uppercase lost its native toupper expression", call. = FALSE)
}
if (!grepl("gsub(.ow_text_find, .ow_text_replacement, .ow_utf8, perl = TRUE)", find_regex_apply$code, fixed = TRUE)) {
  stop("generated regex R Find and Replace lost its native gsub expression", call. = FALSE)
}
assign("text_cleanup_frame", source_environment$text_cleanup_frame, envir = .GlobalEnv)
eval(parse(text = find_regex_apply$code), envir = .GlobalEnv)
text_cleanup_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(text_cleanup_generated$text, c("12:alpha", "34:b\u00e9ta", NA_character_), "generated regex R Find and Replace changed values")
assert_identical(text_cleanup_generated$`upper category`, c("SMALL", NA_character_, "MIXED"), "generated R Uppercase changed values")
assert_identical(row.names(text_cleanup_generated), row.names(text_cleanup_before), "generated R text cleanup changed row names")
assert_identical(
  get("text_cleanup_frame", envir = .GlobalEnv, inherits = FALSE),
  text_cleanup_before,
  "generated R text cleanup mutated its source dataframe"
)
rm("text_cleanup_frame", "open_wrangler_result", envir = .GlobalEnv)

find_regex_inspection <- inspect_step(text_cleanup_session_id, 4L, "find-regex-step", page_window())
assert_identical(find_regex_inspection$kind, "stepInspection", "applied R Find and Replace was not inspectable")
assert_identical(find_regex_inspection$diff$changedCells, 2L, "R Find and Replace inspection lost its exact diff")
find_regex_undo <- dispatch(
  "undoStep",
  list(sessionId = text_cleanup_session_id, revision = 4L, page = page_window())
)
assert_identical(find_regex_undo$action, "undo", "R Find and Replace did not undo")
assert_identical(find_regex_undo$page$schema[[3L]]$name, "upper category", "undo removed the earlier R Uppercase step")

find_blank_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 5L,
    step = text_transform_step(
      "findReplace",
      "find-blank-step",
      "c:step:upper-step:0",
      "upper category",
      new_column = "bounded category",
      find = "",
      replacement = "\\1",
      regex = FALSE
    ),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(find_blank_preview$kind, "stepPreview", "blank-literal R Find and Replace did not preview")
assert_identical(
  find_blank_preview$page$page$columnIds,
  list("c:step:find-blank-step:0"),
  "derived blank-literal R Find and Replace lost its output identity"
)
assign("text_cleanup_frame", source_environment$text_cleanup_frame, envir = .GlobalEnv)
eval(parse(text = find_blank_preview$code), envir = .GlobalEnv)
find_blank_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  find_blank_generated$`bounded category`,
  c("\\1S\\1M\\1A\\1L\\1L\\1", NA_character_, "\\1M\\1I\\1X\\1E\\1D\\1"),
  "generated blank-literal R Find and Replace interpreted replacement backreferences"
)
assert_identical(
  get("text_cleanup_frame", envir = .GlobalEnv, inherits = FALSE),
  text_cleanup_before,
  "generated blank-literal R Find and Replace mutated its source dataframe"
)
rm("text_cleanup_frame", "open_wrangler_result", envir = .GlobalEnv)
find_blank_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_cleanup_session_id, revision = 6L, page = page_window())
)
assert_identical(find_blank_discard$action, "discard", "blank-literal R Find and Replace did not discard")

capitalize_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 7L,
    step = text_transform_step(
      "capitalizeText",
      "capitalize-step",
      "r:c:1",
      "category",
      new_column = "capitalized category"
    ),
    page = page_window(column_offset = 3L, column_limit = 1L)
  )
)
assert_identical(capitalize_preview$kind, "stepPreview", "derived R Capitalize did not preview")
assert_identical(
  capitalize_preview$page$page$columnIds,
  list("c:step:capitalize-step:0"),
  "derived R Capitalize lost its output identity"
)
assert_identical(capitalize_preview$page$schema[[4L]]$rawType, "character", "R Capitalize retained factor storage")
capitalize_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 8L, page = page_window())
)
assert_identical(capitalize_apply$action, "apply", "derived R Capitalize did not apply")

strip_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 9L,
    step = text_transform_step(
      "stripText",
      "strip-step",
      "r:c:0",
      "text",
      new_column = "stripped text",
      characters = ".[]-1234"
    ),
    page = page_window(column_offset = 4L, column_limit = 1L)
  )
)
assert_identical(strip_preview$kind, "stepPreview", "derived R Strip text did not preview")
assert_identical(
  vapply(strip_preview$page$page$rows[1:2], function(row) row$values[[1L]]$raw, character(1L)),
  c("alpha", "béta"),
  "R Strip text treated literal metacharacters as a regular expression"
)
assert_identical(strip_preview$page$page$rows[[3L]]$values[[1L]]$isNull, TRUE, "R Strip text lost source NA")
strip_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 10L, page = page_window())
)
assert_identical(strip_apply$action, "apply", "derived R Strip text did not apply")

split_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_session_id,
    revision = 11L,
    step = text_transform_step(
      "splitText",
      "split-step",
      "r:c:0",
      "text",
      new_column = "suffix",
      delimiter = "-",
      index = 1L
    ),
    page = page_window(column_offset = 5L, column_limit = 1L)
  )
)
assert_identical(split_preview$kind, "stepPreview", "derived R Split text did not preview")
assert_identical(
  split_preview$page$page$columnIds,
  list("c:step:split-step:0"),
  "derived R Split text lost its output identity"
)
assert_identical(
  vapply(split_preview$page$page$rows[1:2], function(row) row$values[[1L]]$raw, character(1L)),
  c("12", "34"),
  "R Split text changed zero-based literal delimiter behavior"
)
assert_identical(split_preview$page$page$rows[[3L]]$values[[1L]]$isNull, TRUE, "R Split text lost source NA")
split_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_session_id, revision = 12L, page = page_window())
)
assert_identical(split_apply$action, "apply", "derived R Split text did not apply")
for (native_expression in c(
  "toupper(.ow_characters[[1L]])",
  ".ow_text_strip_characters",
  "gregexpr(.ow_text_delimiter, .ow_utf8, fixed = TRUE)"
)) {
  if (!grepl(native_expression, split_apply$code, fixed = TRUE)) {
    stop(sprintf("generated R text tools lost native expression: %s", native_expression), call. = FALSE)
  }
}
assign("text_cleanup_frame", source_environment$text_cleanup_frame, envir = .GlobalEnv)
eval(parse(text = split_apply$code), envir = .GlobalEnv)
text_tools_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(
  text_tools_generated$`capitalized category`,
  c("Small", NA_character_, "Mixed"),
  "generated R Capitalize changed values"
)
assert_identical(text_tools_generated$`stripped text`, c("alpha", "béta", NA_character_), "generated R Strip text changed values")
assert_identical(text_tools_generated$suffix, c("12", "34", NA_character_), "generated R Split text changed values")
assert_identical(row.names(text_tools_generated), row.names(text_cleanup_before), "generated R text tools changed row names")
assert_identical(
  get("text_cleanup_frame", envir = .GlobalEnv, inherits = FALSE),
  text_cleanup_before,
  "generated R text tools mutated their source dataframe"
)
rm("text_cleanup_frame", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(source_environment$text_cleanup_frame, text_cleanup_before, "the R text-cleanup lifecycle mutated its source")
text_cleanup_closed <- dispatch("closeSession", list(sessionId = text_cleanup_session_id))
assert_identical(text_cleanup_closed$kind, "closed", "the R text-cleanup session did not close")

source_environment$text_cleanup_table <- data.table::data.table(
  primary_key = c("B", "a"),
  row_marker = c("row-b", "row-a")
)
data.table::setkey(source_environment$text_cleanup_table, primary_key)
text_cleanup_table_before <- data.table::copy(source_environment$text_cleanup_table)
text_cleanup_table_open <- dispatch(
  "openSession",
  list(sessionId = text_cleanup_table_session_id, variableName = "text_cleanup_table", page = page_window())
)
assert_identical(text_cleanup_table_open$kind, "page", "the R data.table text-cleanup session did not open")
text_cleanup_table_key_error <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_table_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-table-key",
      "r:c:0",
      "primary_key",
      find = "B",
      replacement = "b",
      regex = FALSE
    ),
    page = page_window()
  )
)
assert_identical(text_cleanup_table_key_error$kind, "error", "R Find and Replace silently replaced a data.table key")
assert_identical(text_cleanup_table_key_error$code, "invalid_request", "the R Find and Replace key diagnostic changed")
if (!grepl("choose a new output column", text_cleanup_table_key_error$message, fixed = TRUE)) {
  stop("R Find and Replace did not explain how to preserve a data.table key", call. = FALSE)
}
text_cleanup_table_derived <- dispatch(
  "previewStep",
  list(
    sessionId = text_cleanup_table_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-table-derived",
      "r:c:0",
      "primary_key",
      new_column = "normalized key",
      find = "B",
      replacement = "b",
      regex = FALSE
    ),
    page = page_window()
  )
)
assert_identical(text_cleanup_table_derived$kind, "stepPreview", "derived R data.table Find and Replace did not preview")
assert_identical(
  text_cleanup_table_derived$page$frameSemantics$keyColumnIds,
  list("r:c:0"),
  "derived R Find and Replace lost the data.table key"
)
text_cleanup_table_apply <- dispatch(
  "applyDraft",
  list(sessionId = text_cleanup_table_session_id, revision = 1L, page = page_window())
)
assign("text_cleanup_table", source_environment$text_cleanup_table, envir = .GlobalEnv)
eval(parse(text = text_cleanup_table_apply$code), envir = .GlobalEnv)
text_cleanup_table_generated <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
assert_identical(data.table::key(text_cleanup_table_generated), "primary_key", "generated R Find and Replace lost the data.table key")
assert_identical(text_cleanup_table_generated$row_marker, text_cleanup_table_before$row_marker, "generated R Find and Replace changed row order")
assert_identical(text_cleanup_table_generated$`normalized key`, c("b", "a"), "generated R Find and Replace changed derived values")
assert_identical(
  get("text_cleanup_table", envir = .GlobalEnv, inherits = FALSE),
  text_cleanup_table_before,
  "generated R data.table Find and Replace mutated its source"
)
rm("text_cleanup_table", "open_wrangler_result", envir = .GlobalEnv)
assert_identical(source_environment$text_cleanup_table, text_cleanup_table_before, "the R data.table text-cleanup lifecycle mutated its source")
text_cleanup_table_closed <- dispatch("closeSession", list(sessionId = text_cleanup_table_session_id))
assert_identical(text_cleanup_table_closed$kind, "closed", "the R data.table text-cleanup session did not close")

source_environment$text_failure_frame <- data.frame(
  warning_text = paste0(strrep("a", 100L), "b"),
  codegen_text = NA_character_,
  zero_width_text = strrep("a", 2700L),
  stringsAsFactors = FALSE
)
text_failure_before <- unserialize(serialize(source_environment$text_failure_frame, NULL, version = 3L))
text_failure_open <- dispatch(
  "openSession",
  list(sessionId = text_failure_session_id, variableName = "text_failure_frame", page = page_window())
)
assert_identical(text_failure_open$kind, "page", "the R text-failure session did not open")

text_regex_warning <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-regex-warning",
      "r:c:0",
      "warning_text",
      find = "(*LIMIT_MATCH=1)(a+)+$",
      replacement = "x",
      regex = TRUE
    ),
    page = page_window()
  )
)
assert_identical(text_regex_warning$kind, "error", "an R regex resource warning silently produced a draft")
assert_identical(text_regex_warning$code, "invalid_request", "an R regex resource warning was not an invalid request")
assert_identical(text_regex_warning$recoverable, TRUE, "an R regex resource warning was not recoverable")
assert_identical(
  text_regex_warning$message,
  "Find and Replace could not apply the requested regular expression",
  "the R regex resource warning exposed engine details"
)

text_oversized_output <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-oversized-output",
      "r:c:0",
      "warning_text",
      find = "",
      replacement = strrep("x", 100L),
      regex = FALSE
    ),
    page = page_window()
  )
)
assert_identical(text_oversized_output$kind, "error", "R Find and Replace accepted an oversized created value")
assert_identical(text_oversized_output$code, "invalid_request", "an oversized created value was treated as an unsupported frame")
assert_identical(text_oversized_output$recoverable, TRUE, "an oversized created value was not recoverable")
assert_identical(
  text_oversized_output$message,
  "Find and Replace would produce text longer than 8192 UTF-8 bytes",
  "the oversized R text diagnostic changed"
)

text_zero_width_output <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-zero-width-output",
      "r:c:2",
      "zero_width_text",
      find = "(?=(a+))",
      replacement = "\\1",
      regex = TRUE
    ),
    page = page_window()
  )
)
assert_identical(text_zero_width_output$kind, "error", "a zero-width captured backreference allocated an oversized R draft")
assert_identical(text_zero_width_output$code, "invalid_request", "a zero-width captured backreference returned the wrong diagnostic")
assert_identical(text_zero_width_output$recoverable, TRUE, "a zero-width captured backreference was not recoverable")
assert_identical(
  text_zero_width_output$message,
  "Find and Replace would produce text longer than 8192 UTF-8 bytes",
  "the zero-width captured-backreference diagnostic changed"
)

generated_regex_warning_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 0L,
    step = text_transform_step(
      "findReplace",
      "find-generated-regex-warning",
      "r:c:0",
      "warning_text",
      find = "(*LIMIT_MATCH=1)(z+)+$",
      replacement = "x",
      regex = TRUE
    ),
    page = page_window()
  )
)
assert_identical(generated_regex_warning_preview$kind, "stepPreview", "the safe generated-regex fixture did not preview")
generated_regex_warning_code <- generated_regex_warning_preview$code
generated_regex_warning_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_failure_session_id, revision = 1L, page = page_window())
)
assert_identical(generated_regex_warning_discard$action, "discard", "the generated-regex fixture did not discard")

generated_blank_oversize_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = 2L,
    step = text_transform_step(
      "findReplace",
      "find-generated-blank-oversize",
      "r:c:1",
      "codegen_text",
      find = "",
      replacement = strrep("x", 4096L),
      regex = FALSE
    ),
    page = page_window()
  )
)
assert_identical(generated_blank_oversize_preview$kind, "stepPreview", "the missing generated-oversize fixture did not preview")
generated_blank_oversize_code <- generated_blank_oversize_preview$code
generated_blank_oversize_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_failure_session_id, revision = 3L, page = page_window())
)
assert_identical(generated_blank_oversize_discard$action, "discard", "the generated-oversize fixture did not discard")

escaped_regex_replacements <- c("\\\\1", "\\\\U", "\\\\L")
generated_escaped_regex_codes <- vector("list", length(escaped_regex_replacements))
text_failure_revision <- 4L
for (escaped_index in seq_along(escaped_regex_replacements)) {
  escaped_preview <- dispatch(
    "previewStep",
    list(
      sessionId = text_failure_session_id,
      revision = text_failure_revision,
      step = text_transform_step(
        "findReplace",
        sprintf("find-generated-escaped-%d", escaped_index),
        "r:c:0",
        "warning_text",
        find = "(a)",
        replacement = escaped_regex_replacements[[escaped_index]],
        regex = TRUE
      ),
      page = page_window()
    )
  )
  assert_identical(escaped_preview$kind, "stepPreview", "an escaped literal R regex replacement was rejected")
  generated_escaped_regex_codes[[escaped_index]] <- escaped_preview$code
  escaped_discard <- dispatch(
    "discardDraft",
    list(sessionId = text_failure_session_id, revision = text_failure_revision + 1L, page = page_window())
  )
  assert_identical(escaped_discard$action, "discard", "an escaped literal R regex draft did not discard")
  text_failure_revision <- text_failure_revision + 2L
}

generated_zero_width_preview <- dispatch(
  "previewStep",
  list(
    sessionId = text_failure_session_id,
    revision = text_failure_revision,
    step = text_transform_step(
      "findReplace",
      "find-generated-zero-width",
      "r:c:1",
      "codegen_text",
      find = "(?=(a+))",
      replacement = "\\1",
      regex = TRUE
    ),
    page = page_window()
  )
)
assert_identical(generated_zero_width_preview$kind, "stepPreview", "the missing zero-width generated fixture did not preview")
generated_zero_width_code <- generated_zero_width_preview$code
generated_zero_width_discard <- dispatch(
  "discardDraft",
  list(sessionId = text_failure_session_id, revision = text_failure_revision + 1L, page = page_window())
)
assert_identical(generated_zero_width_discard$action, "discard", "the zero-width generated fixture did not discard")
text_failure_closed <- dispatch("closeSession", list(sessionId = text_failure_session_id))
assert_identical(text_failure_closed$kind, "closed", "the R text-failure session did not close")
assert_identical(source_environment$text_failure_frame, text_failure_before, "failed R text transforms mutated their source")

generated_regex_warning_source <- data.frame(
  warning_text = paste0(strrep("z", 100L), "q"),
  codegen_text = NA_character_,
  zero_width_text = "safe",
  stringsAsFactors = FALSE
)
generated_regex_warning_before <- unserialize(serialize(generated_regex_warning_source, NULL, version = 3L))
assign("text_failure_frame", generated_regex_warning_source, envir = .GlobalEnv)
generated_regex_warning_error <- tryCatch(
  withCallingHandlers(
    {
      eval(parse(text = generated_regex_warning_code), envir = .GlobalEnv)
      NULL
    },
    warning = function(warning) stop("a raw generated regex warning escaped", call. = FALSE)
  ),
  error = identity
)
assert_identical(
  conditionMessage(generated_regex_warning_error),
  "Open Wrangler Find and Replace could not apply the requested regular expression",
  "generated R code did not sanitize a regex resource warning"
)
assert_identical(
  get("text_failure_frame", envir = .GlobalEnv, inherits = FALSE),
  generated_regex_warning_before,
  "failed generated regex code mutated its source"
)
rm("text_failure_frame", envir = .GlobalEnv)
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}

generated_blank_oversize_source <- data.frame(
  warning_text = "safe",
  codegen_text = "a",
  zero_width_text = "safe",
  stringsAsFactors = FALSE
)
generated_blank_oversize_before <- unserialize(serialize(generated_blank_oversize_source, NULL, version = 3L))
assign("text_failure_frame", generated_blank_oversize_source, envir = .GlobalEnv)
generated_blank_oversize_error <- tryCatch(
  {
    eval(parse(text = generated_blank_oversize_code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(generated_blank_oversize_error),
  "Open Wrangler Find and Replace would produce text longer than 8192 UTF-8 bytes",
  "generated R code did not reject blank-find expansion before replacement"
)
assert_identical(
  get("text_failure_frame", envir = .GlobalEnv, inherits = FALSE),
  generated_blank_oversize_before,
  "failed generated blank-find code mutated its source"
)
rm("text_failure_frame", envir = .GlobalEnv)
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}

escaped_regex_outputs <- c("\\1", "\\U", "\\L")
for (escaped_index in seq_along(generated_escaped_regex_codes)) {
  generated_escaped_source <- data.frame(
    warning_text = strrep("a", 4000L),
    codegen_text = NA_character_,
    zero_width_text = "safe",
    stringsAsFactors = FALSE
  )
  generated_escaped_before <- unserialize(serialize(generated_escaped_source, NULL, version = 3L))
  assign("text_failure_frame", generated_escaped_source, envir = .GlobalEnv)
  eval(parse(text = generated_escaped_regex_codes[[escaped_index]]), envir = .GlobalEnv)
  generated_escaped_result <- get("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)
  assert_identical(
    generated_escaped_result$warning_text,
    strrep(escaped_regex_outputs[[escaped_index]], 4000L),
    "generated R code misclassified an escaped literal backreference or case directive"
  )
  assert_identical(
    as.integer(nchar(generated_escaped_result$warning_text, type = "bytes")),
    8000L,
    "generated R code changed an escaped literal replacement's byte length"
  )
  assert_identical(
    get("text_failure_frame", envir = .GlobalEnv, inherits = FALSE),
    generated_escaped_before,
    "generated escaped-literal R code mutated its source"
  )
  rm("text_failure_frame", "open_wrangler_result", envir = .GlobalEnv)
}

generated_zero_width_source <- data.frame(
  warning_text = "safe",
  codegen_text = strrep("a", 2700L),
  zero_width_text = "safe",
  stringsAsFactors = FALSE
)
generated_zero_width_before <- unserialize(serialize(generated_zero_width_source, NULL, version = 3L))
assign("text_failure_frame", generated_zero_width_source, envir = .GlobalEnv)
generated_zero_width_error <- tryCatch(
  {
    eval(parse(text = generated_zero_width_code), envir = .GlobalEnv)
    NULL
  },
  error = identity
)
assert_identical(
  conditionMessage(generated_zero_width_error),
  "Open Wrangler Find and Replace would produce text longer than 8192 UTF-8 bytes",
  "generated R code did not preflight a zero-width captured backreference"
)
assert_identical(
  get("text_failure_frame", envir = .GlobalEnv, inherits = FALSE),
  generated_zero_width_before,
  "failed generated zero-width R code mutated its source"
)
rm("text_failure_frame", envir = .GlobalEnv)
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}

source_environment$fill_frame <- data.frame(
  amount = c(1L, NA_integer_, 3L),
  label = ordered(c("high", NA, "low"), levels = c("low", "high")),
  instant = as.POSIXct(c("2026-03-28 12:00:00", NA, "2026-03-30 12:00:00"), tz = "UTC"),
  row.names = c("fill-a", "fill-b", "fill-c")
)
fill_source_before <- unserialize(serialize(source_environment$fill_frame, NULL, version = 3L))
