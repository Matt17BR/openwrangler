if (!requireNamespace("bit64", quietly = TRUE) ||
    !requireNamespace("data.table", quietly = TRUE) ||
    !requireNamespace("tibble", quietly = TRUE)) {
  stop("Pivot-longer native-R tests require bit64, data.table, and tibble", call. = FALSE)
}

pivot_reference <- function(frame, name) {
  position <- match(name, names(frame))
  if (is.na(position)) stop(sprintf("Pivot-longer fixture has no %s column", name), call. = FALSE)
  list(id = sprintf("r:c:%d", position - 1L), name = name)
}

with_poisoned_concat <- function(classes, expression) {
  old <- lapply(classes, function(class_name) getS3method("c", class_name, optional = TRUE))
  on.exit({
    for (index in seq_along(classes)) {
      if (!is.null(old[[index]])) registerS3method("c", classes[[index]], old[[index]])
    }
  }, add = TRUE)
  for (class_name in classes) {
    registerS3method("c", class_name, function(...) {
      stop(sprintf("poisoned c.%s was dispatched", class_name), call. = FALSE)
    })
  }
  force(expression)
}

run_pivot_longer_case <- function(index, label, frame, selected, verify, poison = character()) {
  variable_name <- paste0("pivot_longer_", index)
  current_session <- sprintf("%08x-91a1-491a-891a-%012d", index, index)
  source_before <- serialize(frame, NULL, version = 3L)
  assign(variable_name, frame, envir = source_environment)
  opened <- dispatch("openSession", list(
    sessionId = current_session,
    variableName = variable_name,
    page = page_window(row_limit = 100L, column_limit = 100L)
  ))
  assert_identical(opened$kind, "page", paste(label, "did not open"))
  step <- list(
    id = paste0("pivot-longer-", index),
    kind = "pivotLonger",
    params = list(
      columns = I(lapply(selected, function(name) pivot_reference(frame, name))),
      labelColumn = "measure",
      valueColumn = "reading"
    )
  )
  latest_full_capture <<- NULL
  preview <- with_poisoned_concat(poison, dispatch("previewStep", list(
    sessionId = current_session,
    revision = 0L,
    step = step,
    page = page_window(row_limit = 100L, column_limit = 100L)
  )))
  assert_identical(
    preview$kind,
    "stepPreview",
    paste(label, "did not preview:", if (is.null(preview$message)) "no diagnostic" else preview$message)
  )
  assert_identical(preview$page$frameSemantics$rowNames, "positional", paste(label, "retained explicit row names"))
  assert_identical(preview$page$frameSemantics$keyColumnIds, list(), paste(label, "retained data.table key metadata"))
  assert_identical(
    vapply(preview$page$page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE),
    sprintf("r:r:%d", seq_len(nrow(frame) * length(selected)) - 1L),
    paste(label, "did not create fresh sequential row identities")
  )
  live <- get("snapshot", envir = latest_full_capture, inherits = FALSE)
  verify(live, frame)
  applied <- dispatch("applyDraft", list(
    sessionId = current_session,
    revision = preview$revision,
    page = page_window(row_limit = 100L, column_limit = 100L)
  ))
  assert_identical(applied$action, "apply", paste(label, "did not apply"))
  assert_identical(
    serialize(get(variable_name, envir = source_environment), NULL, version = 3L),
    source_before,
    paste(label, "live pivot mutated its source")
  )

  generated_environment <- new.env(parent = baseenv())
  assign(variable_name, unserialize(source_before), envir = generated_environment)
  with_poisoned_concat(poison, eval(parse(text = applied$code, keep.source = FALSE), envir = generated_environment))
  generated <- get("open_wrangler_result", envir = generated_environment, inherits = FALSE)
  verify(generated, frame)
  assert_identical(
    serialize(get(variable_name, envir = generated_environment), NULL, version = 3L),
    source_before,
    paste(label, "generated pivot mutated its source")
  )
  assert_identical(
    serialize(generated, NULL, version = 3L),
    serialize(live, NULL, version = 3L),
    paste(label, "generated pivot diverged from live")
  )
  assert_identical(dispatch("closeSession", list(sessionId = current_session))$kind, "closed", paste(label, "did not close"))
  remove(list = variable_name, envir = source_environment)
}

factor_levels <- c("low", "high", "unused")
factor_frame <- data.frame(
  id = c(3L, 1L, 2L),
  first = ordered(c("high", "low", NA_character_), levels = factor_levels),
  second = ordered(c("low", "high", "high"), levels = factor_levels),
  check.names = FALSE,
  row.names = c("factor-three", "factor-one", "factor-two")
)
run_pivot_longer_case(1L, "factor data.frame", factor_frame, c("first", "second"), function(output, input) {
  assert_identical(output$measure, rep(c("first", "second"), each = nrow(input)), "factor pivot changed order")
  assert_identical(output$reading, ordered(c(as.character(input$first), as.character(input$second)), levels = factor_levels), "factor pivot changed values or metadata")
  assert_identical(.row_names_info(output, type = 1L), -nrow(output), "factor pivot row names are not positional")
}, poison = "factor")

wide_frame <- data.frame(
  id = 1:3,
  first = bit64::as.integer64(c("9007199254740993", "2", NA)),
  second = bit64::as.integer64(c("4", "9007199254740995", "6")),
  check.names = FALSE,
  row.names = c("wide-one", "wide-two", "wide-three")
)
run_pivot_longer_case(2L, "integer64 data.frame", wide_frame, c("first", "second"), function(output, input) {
  assert_identical(as.character(output$reading), c(as.character(input$first), as.character(input$second)), "integer64 pivot changed values")
  assert_identical(class(output$reading), "integer64", "integer64 pivot changed class metadata")
}, poison = "integer64")

time_frame <- data.frame(
  id = 1:2,
  first = as.POSIXct(c("2026-01-01 00:00:00", "2026-01-02 00:00:00"), tz = "Pacific/Auckland"),
  second = as.POSIXct(c("2026-01-03 00:00:00", "2026-01-04 00:00:00"), tz = "Pacific/Auckland"),
  check.names = FALSE
)
run_pivot_longer_case(3L, "POSIXct data.frame", time_frame, c("first", "second"), function(output, input) {
  assert_identical(as.numeric(output$reading), c(as.numeric(input$first), as.numeric(input$second)), "POSIXct pivot changed instants")
  assert_identical(attr(output$reading, "tzone", exact = TRUE), "Pacific/Auckland", "POSIXct pivot changed timezone")
}, poison = "POSIXct")

duration_frame <- tibble::tibble(
  id = 1:2,
  first = as.difftime(c(1, 2), units = "hours"),
  second = as.difftime(c(3, 4), units = "hours")
)
run_pivot_longer_case(4L, "difftime tibble", duration_frame, c("first", "second"), function(output, input) {
  assert_identical(as.numeric(output$reading), c(1, 2, 3, 4), "difftime pivot changed values")
  assert_identical(attr(output$reading, "units", exact = TRUE), "hours", "difftime pivot changed units")
  assert_identical(class(output), class(input), "difftime pivot changed tibble flavor")
}, poison = "difftime")

table_frame <- data.table::data.table(id = c(2L, 1L, 3L), first = c(20L, 10L, 30L), second = c(200L, 100L, 300L))
data.table::setkeyv(table_frame, c("id", "first"))
run_pivot_longer_case(5L, "keyed data.table", table_frame, c("first", "second"), function(output, input) {
  assert_identical(output$id, rep(input$id, times = 2L), "keyed pivot changed source-within-column order")
  assert_identical(output$measure, rep(c("first", "second"), each = nrow(input)), "keyed pivot changed selected-column order")
  assert_identical(output$reading, c(input$first, input$second), "keyed pivot changed values")
  assert_identical(data.table::key(output), NULL, "keyed pivot retained a key that could reorder rows")
  assert_identical(data.table::key(input), c("id", "first"), "keyed pivot mutated the source key")
}, poison = character())
