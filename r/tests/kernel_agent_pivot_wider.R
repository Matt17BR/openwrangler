if (!requireNamespace("bit64", quietly = TRUE) ||
    !requireNamespace("data.table", quietly = TRUE) ||
    !requireNamespace("tibble", quietly = TRUE)) {
  stop("Pivot-wider native-R tests require bit64, data.table, and tibble", call. = FALSE)
}

pivot_wider_reference <- function(frame, name) {
  position <- match(name, names(frame))
  if (is.na(position)) stop(sprintf("Pivot-wider fixture has no %s column", name), call. = FALSE)
  list(id = sprintf("r:c:%d", position - 1L), name = name)
}

pivot_wider_key <- function(value) list(
  kind = "typedSelection",
  version = 1L,
  columnType = "string",
  cell = list(kind = "string", raw = value, display = value, isNull = FALSE, isNaN = FALSE)
)

pivot_wider_step <- function(frame, id = "pivot-wider-r") list(
  id = id,
  kind = "pivotWider",
  params = list(
    namesFrom = pivot_wider_reference(frame, "key"),
    valuesFrom = pivot_wider_reference(frame, "reading"),
    outputs = I(list(
      list(key = pivot_wider_key("a"), name = "alpha"),
      list(key = pivot_wider_key("b"), name = "beta"),
      list(key = pivot_wider_key("c"), name = "gamma")
    ))
  )
)

pivot_wider_complete_source <- data.frame(
  identifier = c(10, 10, 20, 20),
  key = c("a", "b", "a", "b"),
  reading = c(1L, 2L, 3L, 4L),
  check.names = FALSE
)
pivot_wider_complete_before <- serialize(pivot_wider_complete_source, NULL, version = 3L)
pivot_wider_complete_base <- openwrangler_r_frame_contract$capture_frame(pivot_wider_complete_source)
pivot_wider_complete_source_capture <- openwrangler_r_frame_contract$capture_frame(
  pivot_wider_complete_source,
  nullability_source = pivot_wider_complete_base,
  source_positions = seq_along(pivot_wider_complete_base$descriptor$schema),
  output_ids = vapply(
    pivot_wider_complete_base$descriptor$schema,
    `[[`,
    character(1L),
    "id",
    USE.NAMES = FALSE
  ),
  min_max_scale_positions = 1L
)
assert_identical(
  pivot_wider_complete_source_capture$descriptor$schema[[1L]]$nullable,
  TRUE,
  "Pivot wider nullability fixture did not retain conservative source metadata"
)
pivot_wider_complete_capture <- openwrangler_r_frame_contract$capture_pivot_wider_at(
  pivot_wider_complete_source,
  pivot_wider_complete_source_capture,
  2L,
  "key",
  3L,
  "reading",
  c("a", "b"),
  c("alpha", "beta"),
  c("c:step:pivot-wider-nullability:0", "c:step:pivot-wider-nullability:1")
)
pivot_wider_complete_schema <- pivot_wider_complete_capture$descriptor$schema
assert_identical(
  pivot_wider_complete_schema[[1L]],
  pivot_wider_complete_source_capture$descriptor$schema[[1L]],
  "Pivot wider narrowed or otherwise changed retained source schema metadata"
)
assert_identical(
  vapply(pivot_wider_complete_schema[2:3], `[[`, logical(1L), "nullable", USE.NAMES = FALSE),
  c(TRUE, TRUE),
  "Pivot wider narrowed complete fixed outputs that remain conservatively nullable"
)
assert_identical(
  vapply(pivot_wider_complete_schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
  c("r:c:0", "c:step:pivot-wider-nullability:0", "c:step:pivot-wider-nullability:1"),
  "Pivot wider nullability preservation changed output identities"
)
assert_identical(
  names(pivot_wider_complete_capture$snapshot),
  c("identifier", "alpha", "beta"),
  "Pivot wider nullability preservation changed output names or positions"
)
assert_identical(
  anyNA(pivot_wider_complete_capture$snapshot),
  FALSE,
  "Pivot wider complete-matrix fixture unexpectedly contained a missing value"
)
assert_identical(
  serialize(pivot_wider_complete_source, NULL, version = 3L),
  pivot_wider_complete_before,
  "Pivot wider nullability preservation mutated its source"
)

pivot_wider_session <- "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1"
pivot_wider_variable <- "pivot_wider_source"
pivot_wider_levels <- c("low", "high", "unused")
pivot_wider_source <- data.frame(
  group = c(2L, 1L, 2L, 1L, 3L),
  key = factor(c("b", "a", "a", "b", "a"), levels = c("a", "b", "c")),
  reading = ordered(c("high", "low", "low", "high", "high"), levels = pivot_wider_levels),
  check.names = FALSE,
  row.names = paste0("wide-row-", 1:5)
)
pivot_wider_before <- serialize(pivot_wider_source, NULL, version = 3L)
assign(pivot_wider_variable, pivot_wider_source, envir = source_environment)
pivot_wider_open <- dispatch("openSession", list(
  sessionId = pivot_wider_session,
  variableName = pivot_wider_variable,
  page = page_window(row_limit = 100L, column_limit = 100L)
))
assert_identical(pivot_wider_open$kind, "page", "Pivot wider fixture did not open")

latest_full_capture <<- NULL
pivot_wider_preview <- dispatch("previewStep", list(
  sessionId = pivot_wider_session,
  revision = 0L,
  step = pivot_wider_step(pivot_wider_source),
  page = page_window(row_limit = 100L, column_limit = 100L)
))
assert_identical(
  pivot_wider_preview$kind,
  "stepPreview",
  paste("Pivot wider did not preview:", if (is.null(pivot_wider_preview$message)) "no diagnostic" else pivot_wider_preview$message)
)
pivot_wider_live <- get("snapshot", envir = latest_full_capture, inherits = FALSE)
assert_identical(names(pivot_wider_live), c("group", "alpha", "beta", "gamma"), "Pivot wider schema changed")
assert_identical(pivot_wider_live$group, c(2L, 1L, 3L), "Pivot wider changed first-occurrence group order")
assert_identical(
  as.character(pivot_wider_live$alpha),
  c("low", "low", "high"),
  "Pivot wider mapped the alpha output incorrectly"
)
assert_identical(
  as.character(pivot_wider_live$beta),
  c("high", "high", NA_character_),
  "Pivot wider did not publish typed missing combinations"
)
assert_identical(
  as.character(pivot_wider_live$gamma),
  c(NA_character_, NA_character_, NA_character_),
  "Pivot wider did not publish the declared missing output"
)
assert_identical(levels(pivot_wider_live$alpha), pivot_wider_levels, "Pivot wider changed factor levels")
assert_identical(is.ordered(pivot_wider_live$alpha), TRUE, "Pivot wider changed ordered-factor metadata")
assert_identical(.row_names_info(pivot_wider_live, type = 1L), -3L, "Pivot wider retained source row labels")
assert_identical(pivot_wider_preview$page$frameSemantics$keyColumnIds, list(), "Pivot wider retained R key metadata")
assert_identical(
  vapply(pivot_wider_preview$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
  sprintf("r:r:%d", 0:2),
  "Pivot wider did not publish fresh positional row IDs"
)

pivot_wider_applied <- dispatch("applyDraft", list(
  sessionId = pivot_wider_session,
  revision = pivot_wider_preview$revision,
  page = page_window(row_limit = 100L, column_limit = 100L)
))
assert_identical(pivot_wider_applied$action, "apply", "Pivot wider did not apply")
assert_identical(
  serialize(get(pivot_wider_variable, envir = source_environment), NULL, version = 3L),
  pivot_wider_before,
  "Pivot wider mutated its source"
)
pivot_wider_generated_environment <- new.env(parent = baseenv())
assign(pivot_wider_variable, unserialize(pivot_wider_before), envir = pivot_wider_generated_environment)
eval(parse(text = pivot_wider_applied$code, keep.source = FALSE), envir = pivot_wider_generated_environment)
pivot_wider_generated <- get("open_wrangler_result", envir = pivot_wider_generated_environment, inherits = FALSE)
assert_identical(
  serialize(pivot_wider_generated, NULL, version = 3L),
  serialize(pivot_wider_live, NULL, version = 3L),
  "Generated Pivot wider diverged from live Native R"
)
assert_identical(
  serialize(get(pivot_wider_variable, envir = pivot_wider_generated_environment), NULL, version = 3L),
  pivot_wider_before,
  "Generated Pivot wider mutated its source"
)

pivot_wider_clone_preview <- dispatch("previewStep", list(
  sessionId = pivot_wider_session,
  revision = pivot_wider_applied$revision,
  step = list(
    id = "pivot-wider-clone",
    kind = "cloneColumn",
    params = list(column = list(id = "r:c:0", name = "group"), newName = "group copy")
  ),
  page = page_window(row_limit = 100L, column_limit = 100L)
))
assert_identical(
  pivot_wider_clone_preview$kind,
  "stepPreview",
  paste(
    "Clone Column did not preview after Pivot wider:",
    if (is.null(pivot_wider_clone_preview$message)) "no diagnostic" else pivot_wider_clone_preview$message
  )
)
assert_identical(
  pivot_wider_clone_preview$page$frameSemantics$rowNames,
  "positional",
  "Clone Column changed Pivot-wider positional row-name semantics"
)
pivot_wider_clone_applied <- dispatch("applyDraft", list(
  sessionId = pivot_wider_session,
  revision = pivot_wider_clone_preview$revision,
  page = page_window(row_limit = 100L, column_limit = 100L)
))
assert_identical(pivot_wider_clone_applied$action, "apply", "Clone Column did not apply after Pivot wider")
pivot_wider_clone_generated_environment <- new.env(parent = baseenv())
assign(pivot_wider_variable, unserialize(pivot_wider_before), envir = pivot_wider_clone_generated_environment)
eval(
  parse(text = pivot_wider_clone_applied$code, keep.source = FALSE),
  envir = pivot_wider_clone_generated_environment
)
pivot_wider_clone_generated <- get(
  "open_wrangler_result",
  envir = pivot_wider_clone_generated_environment,
  inherits = FALSE
)
assert_identical(
  .row_names_info(pivot_wider_clone_generated, type = 1L),
  -3L,
  "Generated Clone Column changed Pivot-wider positional row-name semantics"
)
assert_identical(
  names(pivot_wider_clone_generated),
  c("group", "alpha", "beta", "gamma", "group copy"),
  "Generated Clone Column changed the Pivot-wider schema"
)
assert_identical(
  serialize(get(pivot_wider_variable, envir = pivot_wider_clone_generated_environment), NULL, version = 3L),
  pivot_wider_before,
  "Generated Pivot wider plus Clone Column mutated its source"
)
assert_identical(
  serialize(get(pivot_wider_variable, envir = source_environment), NULL, version = 3L),
  pivot_wider_before,
  "Live Pivot wider plus Clone Column mutated its source"
)

pivot_wider_group_key_session <- "f3f3f3f3-f3f3-43f3-83f3-f3f3f3f3f3f3"
pivot_wider_group_key_source <- data.frame(
  missing_id = c(NA_real_, NaN, NA_real_, NaN),
  wide_id = bit64::as.integer64(rep("9007199254740993", 4L)),
  date_id = as.Date(rep("2026-08-19", 4L)),
  text_id = c("Case", "Case", "case", "case"),
  key = c("a", "b", "a", "b"),
  reading = c(1L, 2L, 3L, 4L),
  check.names = FALSE
)
pivot_wider_group_key_before <- serialize(pivot_wider_group_key_source, NULL, version = 3L)
assign("pivot_wider_group_key_source", pivot_wider_group_key_source, envir = source_environment)
assert_identical(dispatch("openSession", list(
  sessionId = pivot_wider_group_key_session,
  variableName = "pivot_wider_group_key_source",
  page = page_window(row_limit = 100L, column_limit = 100L)
))$kind, "page", "Pivot wider portable group-key fixture did not open")
latest_full_capture <<- NULL
pivot_wider_group_key_preview <- dispatch("previewStep", list(
  sessionId = pivot_wider_group_key_session,
  revision = 0L,
  step = pivot_wider_step(pivot_wider_group_key_source, "pivot-wider-group-key"),
  page = page_window(row_limit = 100L, column_limit = 100L)
))
assert_identical(pivot_wider_group_key_preview$kind, "stepPreview", "Pivot wider portable group keys failed")
pivot_wider_group_key_live <- get("snapshot", envir = latest_full_capture, inherits = FALSE)
assert_identical(
  is.na(pivot_wider_group_key_live$missing_id),
  c(TRUE, TRUE),
  "Pivot wider did not normalize NA and NaN to one portable identifier"
)
assert_identical(
  is.nan(pivot_wider_group_key_live$missing_id),
  c(FALSE, FALSE),
  "Pivot wider retained NaN instead of the portable missing identifier"
)
assert_identical(
  as.character(pivot_wider_group_key_live$wide_id),
  rep("9007199254740993", 2L),
  "Pivot wider changed integer64 identifier values"
)
assert_identical(
  pivot_wider_group_key_live$text_id,
  c("Case", "case"),
  "Pivot wider did not keep string identifiers case-sensitive"
)
assert_identical(pivot_wider_group_key_live$alpha, c(1L, 3L), "Pivot wider mapped normalized alpha groups incorrectly")
assert_identical(pivot_wider_group_key_live$beta, c(2L, 4L), "Pivot wider mapped normalized beta groups incorrectly")
pivot_wider_group_key_applied <- dispatch("applyDraft", list(
  sessionId = pivot_wider_group_key_session,
  revision = pivot_wider_group_key_preview$revision,
  page = page_window(row_limit = 100L, column_limit = 100L)
))
pivot_wider_group_key_generated_environment <- new.env(parent = baseenv())
assign(
  "pivot_wider_group_key_source",
  unserialize(pivot_wider_group_key_before),
  envir = pivot_wider_group_key_generated_environment
)
eval(
  parse(text = pivot_wider_group_key_applied$code, keep.source = FALSE),
  envir = pivot_wider_group_key_generated_environment
)
assert_identical(
  serialize(
    get("open_wrangler_result", envir = pivot_wider_group_key_generated_environment, inherits = FALSE),
    NULL,
    version = 3L
  ),
  serialize(pivot_wider_group_key_live, NULL, version = 3L),
  "Generated Pivot wider portable group-key identity diverged from live Native R"
)
assert_identical(
  serialize(get("pivot_wider_group_key_source", envir = source_environment), NULL, version = 3L),
  pivot_wider_group_key_before,
  "Pivot wider portable grouping mutated its source"
)

pivot_wider_duplicate_name_session <- "f4f4f4f4-f4f4-44f4-84f4-f4f4f4f4f4f4"
pivot_wider_duplicate_name_source <- data.table::data.table(
  first_identifier = c(NaN, NaN, 1, 1),
  second_identifier = c(10, 10, 20, 20),
  key_value = c("a", "b", "a", "b"),
  reading = c(1L, 2L, 3L, 4L)
)
data.table::setnames(pivot_wider_duplicate_name_source, c("identifier", "identifier", "key", "reading"))
pivot_wider_duplicate_name_before <- serialize(pivot_wider_duplicate_name_source, NULL, version = 3L)
assign("pivot_wider_duplicate_name_source", pivot_wider_duplicate_name_source, envir = source_environment)
assert_identical(dispatch("openSession", list(
  sessionId = pivot_wider_duplicate_name_session,
  variableName = "pivot_wider_duplicate_name_source",
  page = page_window(row_limit = 100L, column_limit = 100L)
))$kind, "page", "Pivot wider duplicate-name data.table fixture did not open")
latest_full_capture <<- NULL
pivot_wider_duplicate_name_preview <- dispatch("previewStep", list(
  sessionId = pivot_wider_duplicate_name_session,
  revision = 0L,
  step = pivot_wider_step(pivot_wider_duplicate_name_source, "pivot-wider-duplicate-name"),
  page = page_window(row_limit = 100L, column_limit = 100L)
))
assert_identical(
  pivot_wider_duplicate_name_preview$kind,
  "stepPreview",
  "Pivot wider rejected positional duplicate-name data.table identifiers"
)
pivot_wider_duplicate_name_live <- get("snapshot", envir = latest_full_capture, inherits = FALSE)
assert_identical(
  names(pivot_wider_duplicate_name_live),
  c("identifier", "identifier", "alpha", "beta", "gamma"),
  "Pivot wider changed duplicate retained data.table names or output order"
)
assert_identical(
  is.na(pivot_wider_duplicate_name_live[[1L]]),
  c(TRUE, FALSE),
  "Pivot wider overwrote the first duplicate-name data.table identifier"
)
assert_identical(
  pivot_wider_duplicate_name_live[[2L]],
  c(10, 20),
  "Pivot wider overwrote the second duplicate-name data.table identifier"
)
pivot_wider_duplicate_name_applied <- dispatch("applyDraft", list(
  sessionId = pivot_wider_duplicate_name_session,
  revision = pivot_wider_duplicate_name_preview$revision,
  page = page_window(row_limit = 100L, column_limit = 100L)
))
pivot_wider_duplicate_name_generated_environment <- new.env(parent = baseenv())
assign(
  "pivot_wider_duplicate_name_source",
  unserialize(pivot_wider_duplicate_name_before),
  envir = pivot_wider_duplicate_name_generated_environment
)
eval(
  parse(text = pivot_wider_duplicate_name_applied$code, keep.source = FALSE),
  envir = pivot_wider_duplicate_name_generated_environment
)
assert_identical(
  serialize(
    get("open_wrangler_result", envir = pivot_wider_duplicate_name_generated_environment, inherits = FALSE),
    NULL,
    version = 3L
  ),
  serialize(pivot_wider_duplicate_name_live, NULL, version = 3L),
  "Generated Pivot wider corrupted positional duplicate-name data.table identifiers"
)
assert_identical(
  serialize(get("pivot_wider_duplicate_name_source", envir = source_environment), NULL, version = 3L),
  pivot_wider_duplicate_name_before,
  "Pivot wider duplicate-name data.table support mutated its source"
)

pivot_wider_duplicate_session <- "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2"
pivot_wider_duplicate <- data.frame(group = c(1L, 1L), key = c("a", "a"), reading = c(1L, 1L))
assign("pivot_wider_duplicate", pivot_wider_duplicate, envir = source_environment)
assert_identical(dispatch("openSession", list(
  sessionId = pivot_wider_duplicate_session,
  variableName = "pivot_wider_duplicate",
  page = page_window()
))$kind, "page", "Pivot wider duplicate fixture did not open")
for (invalid_version in list(TRUE, "1")) {
  invalid_token_step <- pivot_wider_step(pivot_wider_duplicate, "pivot-wider-invalid-token-version")
  invalid_token_step$params$outputs[[1L]]$key$version <- invalid_version
  invalid_token_response <- dispatch("previewStep", list(
    sessionId = pivot_wider_duplicate_session,
    revision = 0L,
    step = invalid_token_step,
    page = page_window()
  ))
  assert_identical(invalid_token_response$kind, "error", "Pivot wider accepted a coerced typed-key version")
  if (!grepl("canonical present string selection token", invalid_token_response$message, fixed = TRUE)) {
    stop("Pivot wider rejected a coerced typed-key version at the wrong boundary", call. = FALSE)
  }
}
pivot_wider_at_limit_step <- pivot_wider_step(pivot_wider_duplicate, "pivot-wider-key-limit")
pivot_wider_at_limit_key <- strrep("a", 65536L)
pivot_wider_at_limit_step$params$outputs[[1L]]$key$cell$raw <- pivot_wider_at_limit_key
pivot_wider_at_limit_step$params$outputs[[1L]]$key$cell$display <- pivot_wider_at_limit_key
pivot_wider_at_limit_response <- dispatch("previewStep", list(
  sessionId = pivot_wider_duplicate_session,
  revision = 0L,
  step = pivot_wider_at_limit_step,
  page = page_window()
))
assert_identical(pivot_wider_at_limit_response$kind, "error", "Pivot wider limit fixture unexpectedly executed")
if (!grepl("names-from value", pivot_wider_at_limit_response$message, fixed = TRUE)) {
  stop("Pivot wider rejected an exactly 65,536-code-point key at the decoder", call. = FALSE)
}
pivot_wider_over_limit_step <- pivot_wider_step(pivot_wider_duplicate, "pivot-wider-key-over-limit")
pivot_wider_over_limit_key <- strrep("a", 65537L)
pivot_wider_over_limit_step$params$outputs[[1L]]$key$cell$raw <- pivot_wider_over_limit_key
pivot_wider_over_limit_step$params$outputs[[1L]]$key$cell$display <- pivot_wider_over_limit_key
pivot_wider_over_limit_response <- dispatch("previewStep", list(
  sessionId = pivot_wider_duplicate_session,
  revision = 0L,
  step = pivot_wider_over_limit_step,
  page = page_window()
))
assert_identical(pivot_wider_over_limit_response$kind, "error", "Pivot wider accepted an oversized typed key")
if (!grepl("canonical present string selection token", pivot_wider_over_limit_response$message, fixed = TRUE)) {
  stop("Pivot wider rejected an oversized typed key at the wrong boundary", call. = FALSE)
}
pivot_wider_duplicate_response <- dispatch("previewStep", list(
  sessionId = pivot_wider_duplicate_session,
  revision = 0L,
  step = pivot_wider_step(pivot_wider_duplicate, "pivot-wider-duplicate"),
  page = page_window()
))
assert_identical(pivot_wider_duplicate_response$kind, "error", "Pivot wider accepted a duplicate identifier/key pair")
assert_identical(pivot_wider_duplicate_response$recoverable, TRUE, "Pivot wider duplicate failure was not recoverable")

assert_identical(dispatch("closeSession", list(sessionId = pivot_wider_session))$kind, "closed", "Pivot wider did not close")
assert_identical(dispatch("closeSession", list(sessionId = pivot_wider_duplicate_session))$kind, "closed", "Pivot wider duplicate session did not close")
assert_identical(dispatch("closeSession", list(sessionId = pivot_wider_group_key_session))$kind, "closed", "Pivot wider portable group-key session did not close")
assert_identical(dispatch("closeSession", list(sessionId = pivot_wider_duplicate_name_session))$kind, "closed", "Pivot wider duplicate-name data.table session did not close")
remove(
  list = c(
    pivot_wider_variable,
    "pivot_wider_duplicate",
    "pivot_wider_group_key_source",
    "pivot_wider_duplicate_name_source"
  ),
  envir = source_environment
)
