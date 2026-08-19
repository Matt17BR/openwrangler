source("r/openwrangler_runtime/frame_contract.R", local = FALSE)
source("r/openwrangler_runtime/kernel_agent.R", local = FALSE)

for (package in c("bit64", "collapse", "data.table", "jsonlite", "tibble")) {
  if (!requireNamespace(package, quietly = TRUE)) {
    stop(sprintf("The complete native-R catalog contract requires %s", package), call. = FALSE)
  }
}

assert_identical <- function(actual, expected, message) {
  if (!identical(actual, expected)) {
    stop(
      sprintf("%s\nExpected: %s\nActual: %s", message, deparse(expected), deparse(actual)),
      call. = FALSE
    )
  }
}

assert_true <- function(condition, message) {
  if (!isTRUE(condition)) stop(message, call. = FALSE)
}

page_window <- function(
  row_offset = 0L,
  row_limit = 100L,
  column_offset = 0L,
  column_limit = 100L,
  filters = list(),
  sorts = list(),
  logic = NULL
) {
  view <- list(filters = I(filters), sorts = I(sorts))
  if (!is.null(logic)) view$logic <- logic
  list(
    rowOffset = row_offset,
    rowLimit = row_limit,
    columnOffset = column_offset,
    columnLimit = column_limit,
    view = view
  )
}

request_id <- "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0"
source_environment <- new.env(parent = baseenv())
latest_capture <- NULL

# The agent accepts a frame-contract implementation. Record each immutable
# operation result so this owner compares the real live dataframe with the
# standalone generated result, including attributes omitted from grid cells.
record_capture <- function(capture) {
  if (!is.environment(capture) || !inherits(capture, "openwrangler_r_frame_capture")) {
    stop("the complete catalog recorder received an invalid capture", call. = FALSE)
  }
  latest_capture <<- capture
  capture
}

recording_contract <- openwrangler_r_frame_contract
real_capture_frame <- recording_contract$capture_frame
real_capture_categorical_result <- recording_contract$capture_categorical_result
real_capture_group_result <- recording_contract$capture_group_result
real_capture_custom_code_result <- recording_contract$capture_custom_code_result
recording_contract$capture_frame <- function(...) record_capture(real_capture_frame(...))
recording_contract$capture_categorical_result <- function(...) {
  record_capture(real_capture_categorical_result(...))
}
recording_contract$capture_group_result <- function(...) record_capture(real_capture_group_result(...))
recording_contract$capture_custom_code_result <- function(...) {
  record_capture(real_capture_custom_code_result(...))
}
real_capture_pivot_longer_at <- recording_contract$capture_pivot_longer_at
recording_contract$capture_pivot_longer_at <- function(...) {
  record_capture(real_capture_pivot_longer_at(...))
}

agent <- openwrangler_r_kernel_agent$new_agent(recording_contract, source_environment)

dispatch <- function(kind, payload) {
  encoded <- jsonlite::toJSON(
    list(transportVersion = 14L, requestId = request_id, kind = kind, payload = payload),
    auto_unbox = TRUE,
    digits = 17L,
    null = "null",
    na = "null"
  )
  jsonlite::fromJSON(agent$dispatch_json(as.character(encoded)), simplifyVector = FALSE)
}

session_id <- function(index, replay = FALSE) {
  suffix <- if (isTRUE(replay)) index + 1000L else index
  sprintf("%08d-0000-4000-8000-%012d", suffix, suffix)
}

snapshot_from_latest_capture <- function(label) {
  if (is.null(latest_capture)) {
    stop(sprintf("%s did not publish an observable live capture", label), call. = FALSE)
  }
  snapshot <- get("snapshot", envir = latest_capture, inherits = FALSE)
  if (!is.data.frame(snapshot)) {
    stop(sprintf("%s published a capture without a dataframe snapshot", label), call. = FALSE)
  }
  unserialize(serialize(snapshot, NULL, version = 3L))
}

frame_bytes <- function(frame) {
  canonical <- unserialize(serialize(frame, NULL, version = 3L))
  if (inherits(canonical, "data.table")) attr(canonical, ".internal.selfref") <- NULL
  serialize(canonical, NULL, version = 3L)
}

assert_frame_identical <- function(actual, expected, message) {
  if (!identical(frame_bytes(actual), frame_bytes(expected))) {
    comparison <- all.equal(actual, expected, check.attributes = TRUE)
    stop(sprintf("%s\n%s", message, paste(comparison, collapse = "\n")), call. = FALSE)
  }
}

column_reference <- function(frame, name) {
  position <- match(name, names(frame))
  if (is.na(position)) stop(sprintf("fixture has no column named %s", name), call. = FALSE)
  list(id = sprintf("r:c:%d", position - 1L), name = name)
}

set_column_element_names <- function(frame, position, element_names, label) {
  if (length(element_names) != nrow(frame)) {
    stop(sprintf("%s element-name fixture has the wrong length", label), call. = FALSE)
  }
  data.table::setattr(.subset2(frame, position), "names", element_names)
  if (!identical(attr(.subset2(frame, position), "names", exact = TRUE), element_names)) {
    stop(sprintf("%s element-name fixture was stripped", label), call. = FALSE)
  }
  frame
}

schema_ids <- function(response) {
  vapply(response$page$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
}

catalog_source <- function() {
  category <- ordered(
    c("zeta", "alpha", "alpha", NA_character_, "zeta", "beta"),
    levels = c("alpha", "beta", "zeta", "unused")
  )
  frame <- data.frame(
    group = c("b", "a", "a", "b", "c", "c"),
    text = c(" Alpha-1 ", "BETA-2", "gamma-3", NA_character_, " Delta-4 ", "beta-2"),
    tags = c("red|blue", "blue", "red|green", "", NA_character_, "green|blue"),
    number = c(1.25, 2.75, 2.75, NA_real_, -1.2, 5.5),
    whole = c(1L, 2L, 2L, NA_integer_, 4L, 5L),
    fallback = c(9L, 8L, 7L, 6L, 5L, 4L),
    day = as.Date("2026-01-01") + 0:5,
    moment = as.POSIXct("2026-01-01 12:00:00", tz = "UTC") + (0:5 * 3600),
    elapsed = as.difftime(1:6, units = "hours"),
    wide = bit64::as.integer64(c("9007199254740993", "2", "2", NA, "4", "5")),
    flag = c(TRUE, FALSE, TRUE, NA, FALSE, TRUE),
    duplicate = c("u", "v", "v", "w", "x", "x"),
    word = c("aLPHA", "bETA", "gAMMA", NA_character_, "dELTA", "ePSILON"),
    category = category,
    check.names = FALSE,
    stringsAsFactors = FALSE,
    row.names = paste0("catalog-row-", 1:6)
  )
  frame <- set_column_element_names(frame, 5L, paste0("whole-element-", 1:6), "catalog whole")
  frame <- set_column_element_names(frame, 10L, paste0("wide-element-", 1:6), "catalog wide")
  frame <- set_column_element_names(frame, 14L, paste0("factor-element-", 1:6), "catalog factor")
  frame
}

step_with <- function(id, kind, params) list(id = id, kind = kind, params = params)

text_step <- function(frame, id, kind, new_column = NULL, ...) {
  params <- list(column = column_reference(frame, "word"), ...)
  if (!is.null(new_column)) params$newColumn <- new_column
  step_with(id, kind, params)
}

catalog_kinds <- c(
  "sortRows", "filterRows", "dropMissingRows", "fillMissingValues", "dropDuplicates",
  "selectColumns", "dropColumns", "renameColumn", "cloneColumn", "castColumn", "formula",
  "textLength", "oneHotEncode", "multiLabelBinarize", "findReplace", "stripText", "splitText", "splitTextColumns",
  "extractRegexGroup", "capitalizeText", "lowerText", "upperText", "minMaxScale", "roundNumber", "floorNumber",
  "ceilNumber", "formatDatetime", "pivotLonger", "groupBy", "byExample", "customCode"
)

catalog_cases <- list(
  sortRows = list(
    step = function(frame, id) step_with(id, "sortRows", list(rules = I(list(list(
      column = column_reference(frame, "number"), direction = "desc", nulls = "last"
    ))))),
    verify = function(output, input) assert_identical(
      row.names(output), row.names(input)[c(6L, 2L, 3L, 1L, 5L, 4L)],
      "Sort Rows returned the wrong stable order"
    )
  ),
  filterRows = list(
    step = function(frame, id) step_with(id, "filterRows", list(filterModel = list(
      logic = "and",
      filters = I(list(list(
        column = column_reference(frame, "group"), type = "string",
        predicates = I(list(list(kind = "predicate", operator = "equals", value = "a")))
      ))),
      sort = I(list())
    ))),
    verify = function(output, input) assert_identical(
      output$group, c("a", "a"), "Filter Rows returned the wrong rows"
    )
  ),
  dropMissingRows = list(
    step = function(frame, id) step_with(id, "dropMissingRows", list(
      columns = I(list(column_reference(frame, "number"))), how = "any"
    )),
    verify = function(output, input) assert_true(
      !anyNA(output$number) && nrow(output) == 5L, "Drop Missing Rows retained a missing value"
    )
  ),
  fillMissingValues = list(
    step = function(frame, id) step_with(id, "fillMissingValues", list(
      column = column_reference(frame, "whole"), replacement = list(kind = "integer", value = "99")
    )),
    verify = function(output, input) assert_identical(
      unname(output$whole), c(1L, 2L, 2L, 99L, 4L, 5L), "Fill Missing Values changed values"
    )
  ),
  dropDuplicates = list(
    step = function(frame, id) step_with(id, "dropDuplicates", list(
      columns = I(list(column_reference(frame, "duplicate"))), keep = "first"
    )),
    verify = function(output, input) assert_identical(
      output$duplicate, c("u", "v", "w", "x"), "Drop Duplicates kept the wrong rows"
    )
  ),
  selectColumns = list(
    step = function(frame, id) step_with(id, "selectColumns", list(columns = I(list(
      column_reference(frame, "moment"), column_reference(frame, "category")
    )))),
    verify = function(output, input) assert_identical(
      names(output), c("moment", "category"), "Select Columns changed its requested order"
    )
  ),
  dropColumns = list(
    step = function(frame, id) step_with(id, "dropColumns", list(
      columns = I(list(column_reference(frame, "tags")))
    )),
    verify = function(output, input) assert_true(
      !"tags" %in% names(output) && ncol(output) == ncol(input) - 1L, "Drop Columns retained its target"
    )
  ),
  renameColumn = list(
    step = function(frame, id) step_with(id, "renameColumn", list(
      column = column_reference(frame, "text"), newName = "renamed text"
    )),
    verify = function(output, input) assert_identical(
      names(output)[[2L]], "renamed text", "Rename Column lost its new name"
    )
  ),
  cloneColumn = list(
    step = function(frame, id) step_with(id, "cloneColumn", list(
      column = column_reference(frame, "category"), newName = "category copy"
    )),
    verify = function(output, input) assert_identical(
      output[["category copy"]], input$category, "Clone Column lost factor values or attributes"
    )
  ),
  castColumn = list(
    step = function(frame, id) step_with(id, "castColumn", list(
      column = column_reference(frame, "whole"), dtype = "float"
    )),
    verify = function(output, input) {
      assert_true(is.double(output$whole), "Convert Type did not create double storage")
      assert_identical(unname(output$whole), as.double(unname(input$whole)), "Convert Type changed numeric values")
    }
  ),
  formula = list(
    step = function(frame, id) step_with(id, "formula", list(
      leftColumn = column_reference(frame, "number"), operator = "add",
      newColumn = "number plus two", value = 2L
    )),
    verify = function(output, input) assert_identical(
      unname(output[["number plus two"]]), unname(input$number) + 2, "Formula returned the wrong values"
    )
  ),
  textLength = list(
    step = function(frame, id) step_with(id, "textLength", list(
      column = column_reference(frame, "word"), newColumn = "word length"
    )),
    verify = function(output, input) assert_identical(
      output[["word length"]], c(5L, 4L, 5L, NA_integer_, 5L, 7L), "Text Length changed counts"
    )
  ),
  oneHotEncode = list(
    step = function(frame, id) step_with(id, "oneHotEncode", list(
      columns = I(list(column_reference(frame, "group"))), prefixSeparator = "_", dropOriginal = FALSE
    )),
    verify = function(output, input) {
      assert_true(all(c("group_a", "group_b", "group_c") %in% names(output)), "One-hot Encode omitted indicators")
      assert_identical(output$group_a, c(0L, 1L, 1L, 0L, 0L, 0L), "One-hot Encode changed values")
    }
  ),
  multiLabelBinarize = list(
    step = function(frame, id) step_with(id, "multiLabelBinarize", list(
      column = column_reference(frame, "tags"), delimiter = "|", prefix = "tag_", dropOriginal = FALSE
    )),
    verify = function(output, input) {
      assert_true(all(c("tag_blue", "tag_green", "tag_red") %in% names(output)), "Multi-label Binarize omitted indicators")
      assert_identical(output$tag_red, c(1L, 0L, 1L, 0L, 0L, 0L), "Multi-label Binarize changed tokens")
    }
  ),
  findReplace = list(
    step = function(frame, id) step_with(id, "findReplace", list(
      column = column_reference(frame, "text"), find = "-", replacement = ":", regex = FALSE,
      newColumn = "replaced text"
    )),
    verify = function(output, input) assert_identical(
      output[["replaced text"]][[1L]], " Alpha:1 ", "Find and Replace changed literal semantics"
    )
  ),
  stripText = list(
    step = function(frame, id) step_with(id, "stripText", list(
      column = column_reference(frame, "text"), newColumn = "stripped text"
    )),
    verify = function(output, input) assert_identical(
      output[["stripped text"]][c(1L, 5L)], c("Alpha-1", "Delta-4"), "Strip Text changed trimming"
    )
  ),
  splitText = list(
    step = function(frame, id) step_with(id, "splitText", list(
      column = column_reference(frame, "text"), delimiter = "-", index = 1L, newColumn = "text suffix"
    )),
    verify = function(output, input) assert_identical(
      output[["text suffix"]][c(2L, 3L, 6L)], c("2", "3", "2"), "Split Text changed zero-based parts"
    )
  ),
  splitTextColumns = list(
    step = function(frame, id) step_with(id, "splitTextColumns", list(
      column = column_reference(frame, "text"), delimiter = "-", newColumns = list("text first", "text second")
    )),
    verify = function(output, input) {
      assert_identical(output[["text first"]][c(1L, 4L)], c(" Alpha", NA_character_), "Split Text into Columns changed first parts")
      assert_identical(output[["text second"]][c(2L, 3L, 6L)], c("2", "3", "2"), "Split Text into Columns changed second parts")
    }
  ),
  extractRegexGroup = list(
    step = function(frame, id) step_with(id, "extractRegexGroup", list(
      column = column_reference(frame, "text"), pattern = "([A-Za-z]+)-([0-9]{1})", group = 1L,
      newColumn = "regex word"
    )),
    verify = function(output, input) assert_identical(
      output[["regex word"]], c("Alpha", "BETA", "gamma", NA_character_, "Delta", "beta"),
      "Regex extraction changed first-match capture or null semantics"
    )
  ),
  capitalizeText = list(
    step = function(frame, id) text_step(frame, id, "capitalizeText", "capitalized word"),
    verify = function(output, input) assert_identical(
      output[["capitalized word"]][1:3], c("Alpha", "Beta", "Gamma"), "Capitalize changed values"
    )
  ),
  lowerText = list(
    step = function(frame, id) text_step(frame, id, "lowerText", "lower word"),
    verify = function(output, input) assert_identical(
      output[["lower word"]][1:3], c("alpha", "beta", "gamma"), "Lowercase changed values"
    )
  ),
  upperText = list(
    step = function(frame, id) text_step(frame, id, "upperText", "upper word"),
    verify = function(output, input) assert_identical(
      output[["upper word"]][1:3], c("ALPHA", "BETA", "GAMMA"), "Uppercase changed values"
    )
  ),
  minMaxScale = list(
    step = function(frame, id) step_with(id, "minMaxScale", list(
      column = column_reference(frame, "number"), newColumn = "scaled number"
    )),
    verify = function(output, input) assert_identical(
      range(output[["scaled number"]], na.rm = TRUE), c(0, 1), "Min-max Scale returned the wrong range"
    )
  ),
  roundNumber = list(
    step = function(frame, id) step_with(id, "roundNumber", list(
      column = column_reference(frame, "number"), decimals = 1L, newColumn = "rounded number"
    )),
    verify = function(output, input) assert_identical(
      unname(output[["rounded number"]]), round(unname(input$number), 1L), "Round changed values"
    )
  ),
  floorNumber = list(
    step = function(frame, id) step_with(id, "floorNumber", list(
      column = column_reference(frame, "number"), newColumn = "floored number"
    )),
    verify = function(output, input) assert_identical(
      unname(output[["floored number"]]), floor(unname(input$number)), "Floor changed values"
    )
  ),
  ceilNumber = list(
    step = function(frame, id) step_with(id, "ceilNumber", list(
      column = column_reference(frame, "number"), newColumn = "ceiling number"
    )),
    verify = function(output, input) assert_identical(
      unname(output[["ceiling number"]]), ceiling(unname(input$number)), "Ceiling changed values"
    )
  ),
  formatDatetime = list(
    step = function(frame, id) step_with(id, "formatDatetime", list(
      column = column_reference(frame, "day"), format = "%d/%m/%Y", newColumn = "formatted day"
    )),
    verify = function(output, input) assert_identical(
      output[["formatted day"]], format(input$day, "%d/%m/%Y"), "Format Datetime changed values"
    )
  ),
  pivotLonger = list(
    step = function(frame, id) step_with(id, "pivotLonger", list(
      columns = I(list(column_reference(frame, "whole"), column_reference(frame, "fallback"))),
      labelColumn = "measure",
      valueColumn = "reading"
    )),
    verify = function(output, input) {
      assert_identical(names(output), c(setdiff(names(input), c("whole", "fallback")), "measure", "reading"), "Pivot longer returned the wrong schema")
      assert_identical(output$measure, rep(c("whole", "fallback"), each = nrow(input)), "Pivot longer changed selected-column-major order")
      assert_identical(output$reading, unname(c(input$whole, input$fallback)), "Pivot longer changed scalar values")
      assert_identical(.row_names_info(output, type = 1L), -nrow(output), "Pivot longer did not publish positional row names")
    }
  ),
  groupBy = list(
    step = function(frame, id) step_with(id, "groupBy", list(
      keys = I(list(column_reference(frame, "group"))),
      aggregations = I(list(list(
        column = column_reference(frame, "number"), operation = "sum", alias = "number sum"
      )))
    )),
    verify = function(output, input) {
      assert_identical(names(output), c("group", "number sum"), "Group By returned the wrong schema")
      assert_identical(sort(output$group), c("a", "b", "c"), "Group By returned the wrong groups")
    }
  ),
  byExample = list(
    step = function(frame, id) step_with(id, "byExample", list(
      sourceColumns = I(list(column_reference(frame, "whole"))),
      newColumn = "whole plus ten",
      examples = I(list(
        list(inputs = I(list(1L)), output = 11L),
        list(inputs = I(list(2L)), output = 12L)
      ))
    )),
    verify = function(output, input) assert_identical(
      as.double(output[["whole plus ten"]]), as.double(input$whole) + 10,
      "Transform by Example changed arithmetic values"
    )
  ),
  customCode = list(
    step = function(frame, id) step_with(id, "customCode", list(code = paste(
      "result <- df[df$group != \"c\", c(\"group\", \"whole\", \"category\"), drop = FALSE]",
      "result$custom_value <- result$whole * 3L",
      sep = "\n"
    ))),
    verify = function(output, input) {
      assert_identical(names(output), c("group", "whole", "category", "custom_value"), "Custom Code returned the wrong schema")
      assert_identical(nrow(output), 4L, "Custom Code returned the wrong row count")
      assert_identical(unname(output$custom_value), c(3L, 6L, 6L, NA_integer_), "Custom Code changed values")
    }
  )
)

assert_identical(names(catalog_cases), catalog_kinds, "the complete R catalog owner is not in canonical order")
assert_identical(length(catalog_cases), 31L, "the complete R catalog owner does not contain 31 operations")

catalog_generated_code <- setNames(vector("list", length(catalog_cases)), names(catalog_cases))

run_catalog_case <- function(case, kind, index) {
  variable_name <- "catalog_frame"
  input <- catalog_source()
  assign(variable_name, input, envir = source_environment)
  source_before <- serialize(get(variable_name, envir = source_environment), NULL, version = 3L)
  step <- case$step(input, paste0("complete-catalog-", kind))
  assert_identical(step$kind, kind, sprintf("the %s case constructed the wrong operation", kind))

  original_session <- session_id(index)
  opened <- dispatch("openSession", list(
    sessionId = original_session, variableName = variable_name, page = page_window()
  ))
  assert_identical(opened$kind, "page", sprintf("%s did not open", kind))
  latest_capture <<- NULL
  preview <- dispatch("previewStep", list(
    sessionId = original_session, revision = 0L, step = step, page = page_window()
  ))
  assert_identical(
    preview$kind,
    "stepPreview",
    sprintf("%s did not preview: %s", kind, if (is.null(preview$message)) "no diagnostic" else preview$message)
  )
  assert_true(is.character(preview$code) && length(preview$code) == 1L, sprintf("%s omitted generated code", kind))
  assert_true(length(parse(text = preview$code, keep.source = FALSE)) > 0L, sprintf("%s emitted unparsable code", kind))
  live_output <- snapshot_from_latest_capture(paste(kind, "preview"))
  case$verify(live_output, input)
  applied <- dispatch("applyDraft", list(
    sessionId = original_session, revision = preview$revision, page = page_window()
  ))
  assert_identical(applied$action, "apply", sprintf("%s did not apply", kind))
  assert_identical(applied$code, preview$code, sprintf("%s changed generated code at apply", kind))
  assert_identical(
    serialize(get(variable_name, envir = source_environment), NULL, version = 3L),
    source_before,
    sprintf("live %s mutated its immutable source", kind)
  )
  saved_step <- if (identical(kind, "byExample")) preview$retainedStep else step
  assert_true(!is.null(saved_step), sprintf("%s did not retain a replayable step", kind))
  assert_identical(dispatch("closeSession", list(sessionId = original_session))$kind, "closed", sprintf("%s did not close", kind))

  replay_session <- session_id(index, replay = TRUE)
  replay_open <- dispatch("openSession", list(
    sessionId = replay_session, variableName = variable_name, page = page_window()
  ))
  assert_identical(replay_open$kind, "page", sprintf("saved %s did not reopen", kind))
  latest_capture <<- NULL
  replay_preview <- dispatch("previewStep", list(
    sessionId = replay_session, revision = 0L, step = saved_step, page = page_window()
  ))
  assert_identical(
    replay_preview$kind,
    "stepPreview",
    sprintf("saved %s did not replay: %s", kind, if (is.null(replay_preview$message)) "no diagnostic" else replay_preview$message)
  )
  replay_output <- snapshot_from_latest_capture(paste("saved", kind, "replay"))
  replay_applied <- dispatch("applyDraft", list(
    sessionId = replay_session, revision = replay_preview$revision, page = page_window()
  ))
  assert_identical(replay_applied$action, "apply", sprintf("saved %s did not reapply", kind))
  assert_frame_identical(replay_output, live_output, sprintf("saved %s replay changed the live frame", kind))
  assert_identical(replay_applied$page, applied$page, sprintf("saved %s replay changed schema or row identities", kind))
  assert_identical(replay_applied$code, applied$code, sprintf("saved %s replay changed generated code", kind))
  assert_identical(
    serialize(get(variable_name, envir = source_environment), NULL, version = 3L),
    source_before,
    sprintf("saved live %s replay mutated its source", kind)
  )
  assert_identical(dispatch("closeSession", list(sessionId = replay_session))$kind, "closed", sprintf("saved %s did not close", kind))

  generated_environment <- new.env(parent = baseenv())
  assign(variable_name, unserialize(source_before), envir = generated_environment)
  generated_source_before <- serialize(get(variable_name, envir = generated_environment), NULL, version = 3L)
  eval(parse(text = applied$code, keep.source = FALSE), envir = generated_environment)
  assert_true(
    exists("open_wrangler_result", envir = generated_environment, inherits = FALSE),
    sprintf("generated %s did not publish a result", kind)
  )
  generated_output <- get("open_wrangler_result", envir = generated_environment, inherits = FALSE)
  assert_frame_identical(generated_output, live_output, sprintf("generated %s diverged from live output", kind))
  case$verify(generated_output, input)
  assert_identical(
    serialize(get(variable_name, envir = generated_environment), NULL, version = 3L),
    generated_source_before,
    sprintf("generated %s mutated its immutable source", kind)
  )
  catalog_generated_code[[kind]] <<- applied$code
  remove(list = variable_name, envir = source_environment)
}

for (index in seq_along(catalog_cases)) {
  kind <- names(catalog_cases)[[index]]
  tryCatch(
    run_catalog_case(catalog_cases[[index]], kind, index),
    error = function(error) {
      stop(sprintf("the %s complete-catalog case failed: %s", kind, conditionMessage(error)), call. = FALSE)
    }
  )
}

assert_true(
  all(vapply(catalog_generated_code, function(code) {
    is.character(code) && length(code) == 1L && nchar(code, type = "bytes") > 0L
  }, logical(1L))),
  "one or more catalog operations lacked executable generated code"
)

assert_true(
  grepl("base::intToUtf8(c(", catalog_generated_code$stripText, fixed = TRUE) &&
    grepl("multiple = FALSE", catalog_generated_code$stripText, fixed = TRUE),
  "generated default Strip Text did not use its parse-safe Unicode-scalar representation"
)

# R rejects one source literal that mixes octal/hex escapes with Unicode
# escapes. Prove the same scalar-vector representation for an explicit set
# spanning a C0 separator and Unicode next-line, not only the default set.
mixed_strip_characters <- intToUtf8(c(0x1cL, 0x85L))
source_environment$complete_mixed_strip <- data.frame(
  text = c(
    paste0(mixed_strip_characters, "alpha", mixed_strip_characters),
    paste0("beta", intToUtf8(0x1cL)),
    NA_character_
  ),
  check.names = FALSE,
  row.names = c("mixed-a", "mixed-b", "mixed-c")
)
mixed_strip_before <- serialize(source_environment$complete_mixed_strip, NULL, version = 3L)
mixed_strip_session <- "00001999-1999-4199-8199-000000001999"
invisible(dispatch("openSession", list(
  sessionId = mixed_strip_session,
  variableName = "complete_mixed_strip",
  page = page_window()
)))
latest_capture <- NULL
mixed_strip_preview <- dispatch("previewStep", list(
  sessionId = mixed_strip_session,
  revision = 0L,
  step = step_with("complete-mixed-strip", "stripText", list(
    column = list(id = "r:c:0", name = "text"),
    characters = mixed_strip_characters,
    newColumn = "stripped"
  )),
  page = page_window()
))
assert_identical(mixed_strip_preview$kind, "stepPreview", "explicit mixed-control Strip Text did not preview")
mixed_strip_live <- snapshot_from_latest_capture("explicit mixed-control Strip Text")
assert_identical(
  mixed_strip_live$stripped,
  c("alpha", "beta", NA_character_),
  "live explicit mixed-control Strip Text changed code-point semantics"
)
mixed_strip_apply <- dispatch("applyDraft", list(
  sessionId = mixed_strip_session,
  revision = mixed_strip_preview$revision,
  page = page_window()
))
assert_true(
  grepl("base::intToUtf8(c(28L, 133L), multiple = FALSE)", mixed_strip_apply$code, fixed = TRUE),
  "generated explicit mixed-control Strip Text did not emit exact code points"
)
mixed_strip_generated_environment <- new.env(parent = baseenv())
mixed_strip_generated_environment$complete_mixed_strip <- unserialize(mixed_strip_before)
eval(parse(text = mixed_strip_apply$code, keep.source = FALSE), envir = mixed_strip_generated_environment)
assert_frame_identical(
  mixed_strip_generated_environment$open_wrangler_result,
  mixed_strip_live,
  "generated explicit mixed-control Strip Text diverged from live"
)
assert_identical(
  serialize(source_environment$complete_mixed_strip, NULL, version = 3L),
  mixed_strip_before,
  "live explicit mixed-control Strip Text mutated source"
)
assert_identical(
  serialize(mixed_strip_generated_environment$complete_mixed_strip, NULL, version = 3L),
  mixed_strip_before,
  "generated explicit mixed-control Strip Text mutated source"
)
assert_identical(
  dispatch("closeSession", list(sessionId = mixed_strip_session))$kind,
  "closed",
  "the explicit mixed-control Strip Text session did not close"
)
remove("complete_mixed_strip", envir = source_environment)

# Six canonical dataframe families, supported column attributes, explicit row
# names, data.table keys, and per-element names must survive both execution
# paths. collapse q* constructors intentionally canonicalize to the same three
# public flavors, so exact classes also guard family normalization.
flavor_base <- function() {
  value <- data.frame(
    id = c(2L, 1L, 3L),
    value = c(20L, 10L, 30L),
    category = ordered(c("high", "low", "high"), levels = c("low", "high", "unused")),
    day = as.Date(c("2026-04-02", "2026-04-01", "2026-04-03")),
    moment = as.POSIXct(
      c("2026-04-02 12:00:00", "2026-04-01 12:00:00", "2026-04-03 12:00:00"),
      tz = "UTC"
    ),
    elapsed = as.difftime(c(2, 1, 3), units = "hours"),
    wide = bit64::as.integer64(c("9007199254740993", "1", "3")),
    check.names = FALSE,
    row.names = c("flavor-two", "flavor-one", "flavor-three")
  )
  value <- set_column_element_names(
    value, 2L, c("value-two", "value-one", "value-three"), "base flavor value"
  )
  value <- set_column_element_names(
    value, 3L, c("category-two", "category-one", "category-three"), "base flavor category"
  )
  value
}

base_flavor_source <- flavor_base()
tibble_flavor_source <- tibble::as_tibble(flavor_base(), .name_repair = "minimal")
tibble_flavor_source <- set_column_element_names(
  tibble_flavor_source, 2L, c("value-two", "value-one", "value-three"), "tibble flavor value"
)
tibble_flavor_source <- set_column_element_names(
  tibble_flavor_source, 3L, c("category-two", "category-one", "category-three"), "tibble flavor category"
)
table_flavor_source <- data.table::as.data.table(flavor_base())
data.table::setkey(table_flavor_source, id)
table_flavor_source <- set_column_element_names(
  table_flavor_source, 2L, c("value-one", "value-two", "value-three"), "data.table flavor value"
)
table_flavor_source <- set_column_element_names(
  table_flavor_source, 3L, c("category-one", "category-two", "category-three"), "data.table flavor category"
)
qdf_flavor_source <- collapse::qDF(flavor_base())
qdf_flavor_source <- set_column_element_names(
  qdf_flavor_source, 2L, c("value-two", "value-one", "value-three"), "qDF flavor value"
)
qdf_flavor_source <- set_column_element_names(
  qdf_flavor_source, 3L, c("category-two", "category-one", "category-three"), "qDF flavor category"
)
qtbl_flavor_source <- collapse::qTBL(flavor_base())
qtbl_flavor_source <- set_column_element_names(
  qtbl_flavor_source, 2L, c("value-two", "value-one", "value-three"), "qTBL flavor value"
)
qtbl_flavor_source <- set_column_element_names(
  qtbl_flavor_source, 3L, c("category-two", "category-one", "category-three"), "qTBL flavor category"
)
qdt_flavor_source <- collapse::qDT(flavor_base())
data.table::setkey(qdt_flavor_source, id)
qdt_flavor_source <- set_column_element_names(
  qdt_flavor_source, 2L, c("value-one", "value-two", "value-three"), "qDT flavor value"
)
qdt_flavor_source <- set_column_element_names(
  qdt_flavor_source, 3L, c("category-one", "category-two", "category-three"), "qDT flavor category"
)

flavor_cases <- list(
  list(label = "base data.frame", value = base_flavor_source, flavor = "r.data.frame", row_names = "explicit"),
  list(label = "tibble", value = tibble_flavor_source, flavor = "r.tibble", row_names = "positional"),
  list(label = "data.table", value = table_flavor_source, flavor = "r.data.table", row_names = "positional"),
  list(label = "collapse qDF", value = qdf_flavor_source, flavor = "r.data.frame", row_names = "explicit"),
  list(label = "collapse qTBL", value = qtbl_flavor_source, flavor = "r.tibble", row_names = "positional"),
  list(label = "collapse qDT", value = qdt_flavor_source, flavor = "r.data.table", row_names = "positional")
)

for (index in seq_along(flavor_cases)) {
  case <- flavor_cases[[index]]
  variable_name <- paste0("complete_flavor_", index)
  current_session <- sprintf("%08d-1111-4111-8111-%012d", index, index)
  if (identical(case$flavor, "r.data.table")) {
    expected_ids <- c(1L, 2L, 3L)
    expected_names <- c("value-one", "value-two", "value-three")
    expected_category_names <- c("category-one", "category-two", "category-three")
  } else {
    expected_ids <- c(2L, 1L, 3L)
    expected_names <- c("value-two", "value-one", "value-three")
    expected_category_names <- c("category-two", "category-one", "category-three")
  }
  assert_identical(case$value$id, expected_ids, paste(case$label, "fixture changed row order before dispatch"))
  assert_identical(
    attr(.subset2(case$value, 2L), "names", exact = TRUE),
    expected_names,
    paste(case$label, "value fixture lost exact element names before dispatch")
  )
  assert_identical(
    attr(.subset2(case$value, 3L), "names", exact = TRUE),
    expected_category_names,
    paste(case$label, "category fixture lost exact element names before dispatch")
  )
  assign(variable_name, case$value, envir = source_environment)
  source_before <- serialize(case$value, NULL, version = 3L)
  opened <- dispatch("openSession", list(
    sessionId = current_session,
    variableName = variable_name,
    page = page_window()
  ))
  assert_identical(opened$page$dataframeFlavor, case$flavor, paste(case$label, "opened with the wrong flavor"))
  assert_identical(opened$page$frameSemantics$rowNames, case$row_names, paste(case$label, "changed row-name semantics"))
  expected_names_code <- paste(deparse(expected_names), collapse = "")
  expected_category_names_code <- paste(deparse(expected_category_names), collapse = "")
  code <- paste(
    ".ow_input_names <- base::attr(base::.subset2(df, 2L), \"names\", exact = TRUE)",
    ".ow_category_names <- base::attr(base::.subset2(df, 3L), \"names\", exact = TRUE)",
    sprintf("if (!base::identical(.ow_input_names, %s)) base::stop(\"live flavor input lost element names\")", expected_names_code),
    sprintf(
      "if (!base::identical(.ow_category_names, %s)) base::stop(\"live flavor input lost category element names\")",
      expected_category_names_code
    ),
    "result <- df",
    "result$value_plus_one <- result$value + 1L",
    "if (base::inherits(result, \"data.table\")) data.table::setattr(base::.subset2(result, 2L), \"names\", .ow_input_names)",
    "if (base::inherits(result, \"data.table\")) data.table::setattr(base::.subset2(result, 3L), \"names\", .ow_category_names)",
    sep = "\n"
  )
  step <- step_with(paste0("complete-flavor-step-", index), "customCode", list(code = code))
  latest_capture <- NULL
  preview <- dispatch("previewStep", list(
    sessionId = current_session,
    revision = 0L,
    step = step,
    page = page_window()
  ))
  assert_identical(
    preview$kind,
    "stepPreview",
    paste(case$label, "Custom Code did not preview:", if (is.null(preview$message)) "no diagnostic" else preview$message)
  )
  live_output <- snapshot_from_latest_capture(paste(case$label, "Custom Code"))
  assert_identical(class(live_output), class(case$value), paste(case$label, "changed its canonical classes"))
  assert_identical(
    attr(.subset2(live_output, 2L), "names", exact = TRUE),
    expected_names,
    paste(case$label, "lost live element names")
  )
  assert_identical(class(live_output$category), c("ordered", "factor"), paste(case$label, "lost factor classes"))
  assert_identical(
    attr(live_output$category, "levels", exact = TRUE),
    c("low", "high", "unused"),
    paste(case$label, "lost factor levels")
  )
  assert_identical(
    attr(.subset2(live_output, 3L), "names", exact = TRUE),
    expected_category_names,
    paste(case$label, "lost category element names")
  )
  assert_identical(attr(live_output$moment, "tzone", exact = TRUE), "UTC", paste(case$label, "lost timezone metadata"))
  assert_identical(attr(live_output$elapsed, "units", exact = TRUE), "hours", paste(case$label, "lost duration units"))
  assert_identical(class(live_output$wide), "integer64", paste(case$label, "lost integer64 semantics"))
  if (identical(case$flavor, "r.data.table")) {
    assert_identical(data.table::key(live_output), "id", paste(case$label, "lost its data.table key"))
    assert_identical(preview$page$frameSemantics$keyColumnIds, list("r:c:0"), paste(case$label, "changed its key identity"))
  }
  applied <- dispatch("applyDraft", list(
    sessionId = current_session,
    revision = preview$revision,
    page = page_window()
  ))
  generated_environment <- new.env(parent = baseenv())
  assign(variable_name, unserialize(source_before), envir = generated_environment)
  generated_before <- serialize(get(variable_name, envir = generated_environment), NULL, version = 3L)
  eval(parse(text = applied$code, keep.source = FALSE), envir = generated_environment)
  generated_output <- get("open_wrangler_result", envir = generated_environment, inherits = FALSE)
  assert_frame_identical(generated_output, live_output, paste(case$label, "generated output diverged"))
  assert_identical(
    serialize(get(variable_name, envir = source_environment), NULL, version = 3L),
    source_before,
    paste(case$label, "live execution mutated its source")
  )
  assert_identical(
    serialize(get(variable_name, envir = generated_environment), NULL, version = 3L),
    generated_before,
    paste(case$label, "generated execution mutated its source")
  )
  assert_identical(
    dispatch("closeSession", list(sessionId = current_session))$kind,
    "closed",
    paste(case$label, "did not close")
  )
  remove(list = variable_name, envir = source_environment)
}

# Zero-row frames are editing inputs as long as one column remains. The
# generated program must preserve the complete empty schema.
source_environment$complete_zero <- data.frame(
  text = character(), value = integer(), check.names = FALSE, row.names = character()
)
zero_before <- serialize(source_environment$complete_zero, NULL, version = 3L)
zero_session <- "00002001-2001-4201-8201-000000002001"
invisible(dispatch("openSession", list(
  sessionId = zero_session,
  variableName = "complete_zero",
  page = page_window()
)))
latest_capture <- NULL
zero_preview <- dispatch("previewStep", list(
  sessionId = zero_session,
  revision = 0L,
  step = step_with("complete-zero-lower", "lowerText", list(
    column = list(id = "r:c:0", name = "text"), newColumn = "lower text"
  )),
  page = page_window()
))
assert_identical(zero_preview$kind, "stepPreview", "the zero-row operation did not preview")
zero_live <- snapshot_from_latest_capture("zero-row operation")
assert_identical(c(nrow(zero_live), ncol(zero_live)), c(0L, 3L), "the zero-row operation changed shape")
zero_apply <- dispatch("applyDraft", list(
  sessionId = zero_session,
  revision = zero_preview$revision,
  page = page_window()
))
zero_generated_environment <- new.env(parent = baseenv())
zero_generated_environment$complete_zero <- unserialize(zero_before)
zero_generated_before <- serialize(zero_generated_environment$complete_zero, NULL, version = 3L)
eval(parse(text = zero_apply$code, keep.source = FALSE), envir = zero_generated_environment)
assert_frame_identical(
  zero_generated_environment$open_wrangler_result,
  zero_live,
  "generated zero-row output diverged from live"
)
assert_identical(serialize(source_environment$complete_zero, NULL, version = 3L), zero_before, "live zero-row execution mutated source")
assert_identical(
  serialize(zero_generated_environment$complete_zero, NULL, version = 3L),
  zero_generated_before,
  "generated zero-row execution mutated source"
)
assert_identical(dispatch("closeSession", list(sessionId = zero_session))$kind, "closed", "the zero-row session did not close")
remove("complete_zero", envir = source_environment)

# A 1,025-row direct by-example program crosses the production 1,024-row
# chunk/page boundary. It must preserve attributed factor elements on both
# sides and publish the second page under stable row IDs.
chunk_count <- 1025L
chunk_factor <- ordered(
  rep(c("alpha", "beta"), length.out = chunk_count),
  levels = c("alpha", "beta", "unused")
)
source_environment$complete_chunk <- data.frame(
  token = chunk_factor,
  value = seq_len(chunk_count),
  check.names = FALSE,
  row.names = paste0("chunk-row-", seq_len(chunk_count))
)
source_environment$complete_chunk <- set_column_element_names(
  source_environment$complete_chunk,
  1L,
  paste0("chunk-element-", seq_len(chunk_count)),
  "chunk token"
)
assert_identical(
  attr(.subset2(source_environment$complete_chunk, 1L), "names", exact = TRUE),
  paste0("chunk-element-", seq_len(chunk_count)),
  "the chunk fixture lost element names before dispatch"
)
assert_identical(
  attr(.subset2(source_environment$complete_chunk, 1L), "names", exact = TRUE)[c(1024L, 1025L)],
  c("chunk-element-1024", "chunk-element-1025"),
  "the chunk fixture lost boundary element names before dispatch"
)
chunk_before <- serialize(source_environment$complete_chunk, NULL, version = 3L)
chunk_session <- "00002002-2002-4202-8202-000000002002"
chunk_open <- dispatch("openSession", list(
  sessionId = chunk_session,
  variableName = "complete_chunk",
  page = page_window(row_limit = 1000L, column_limit = 3L)
))
assert_identical(
  chunk_open$kind,
  "page",
  paste("the chunk session failed to open:", if (is.null(chunk_open$message)) "no diagnostic" else chunk_open$message)
)
chunk_step <- step_with("complete-chunk-by-example", "byExample", list(
  sourceColumns = I(list(list(id = "r:c:0", name = "token"))),
  newColumn = "token copy",
  examples = I(list(
    list(inputs = I(list("alpha")), output = "alpha"),
    list(inputs = I(list("beta")), output = "beta")
  ))
))
latest_capture <- NULL
chunk_preview <- dispatch("previewStep", list(
  sessionId = chunk_session,
  revision = 0L,
  step = chunk_step,
  page = page_window(row_limit = 1000L, column_limit = 3L)
))
assert_identical(
  chunk_preview$kind,
  "stepPreview",
  paste("the chunked preview failed:", if (is.null(chunk_preview$message)) "no diagnostic" else chunk_preview$message)
)
assert_identical(chunk_preview$page$page$totalRows, chunk_count, "the chunked preview changed total rows")
assert_identical(length(chunk_preview$page$page$rows), 1000L, "the first page did not contain 1,000 rows")
chunk_live <- snapshot_from_latest_capture("chunked by-example")
assert_identical(chunk_live[["token copy"]], chunk_live$token, "live chunked by-example lost factor attributes")
chunk_apply <- dispatch("applyDraft", list(
  sessionId = chunk_session,
  revision = chunk_preview$revision,
  page = page_window(row_limit = 1000L, column_limit = 3L)
))
chunk_tail <- dispatch("getPage", list(
  sessionId = chunk_session,
  page = page_window(row_offset = 1000L, row_limit = 25L, column_limit = 3L)
))
assert_identical(length(chunk_tail$page$page$rows), 25L, "the chunked tail page did not contain 25 rows")
assert_identical(chunk_tail$page$page$rows[[1L]]$id, "r:r:1000", "the chunked tail start identity changed")
assert_identical(chunk_tail$page$page$rows[[25L]]$id, "r:r:1024", "the chunked tail end identity changed")
assert_identical(chunk_tail$page$page$rows[[25L]]$rowLabel, "chunk-row-1025", "the chunked tail row name changed")
chunk_generated_environment <- new.env(parent = baseenv())
chunk_generated_environment$complete_chunk <- unserialize(chunk_before)
eval(parse(text = chunk_apply$code, keep.source = FALSE), envir = chunk_generated_environment)
chunk_generated <- chunk_generated_environment$open_wrangler_result
assert_frame_identical(chunk_generated, chunk_live, "generated >1024-row output diverged from live")
assert_identical(
  attr(chunk_generated[["token copy"]], "names", exact = TRUE)[c(1024L, 1025L)],
  c("chunk-element-1024", "chunk-element-1025"),
  "generated chunking lost boundary element names"
)
assert_identical(serialize(source_environment$complete_chunk, NULL, version = 3L), chunk_before, "live chunking mutated source")
assert_identical(
  serialize(chunk_generated_environment$complete_chunk, NULL, version = 3L),
  chunk_before,
  "generated chunking mutated source"
)
assert_identical(dispatch("closeSession", list(sessionId = chunk_session))$kind, "closed", "the chunk session did not close")
remove("complete_chunk", envir = source_environment)

# A saved multi-step plan with two distinct cardinality changes proves dynamic
# schema binding, prefix inspection, full-plan replay, generated composition,
# and undo against the immutable original.
composition_rows <- 12L
source_environment$complete_composition <- data.frame(
  group = rep(c("keep-a", "keep-b", "drop"), each = 4L),
  value = seq_len(composition_rows),
  label = ordered(
    rep(c("low", "high"), length.out = composition_rows),
    levels = c("low", "high")
  ),
  check.names = FALSE,
  row.names = paste0("composition-row-", seq_len(composition_rows))
)
source_environment$complete_composition <- set_column_element_names(
  source_environment$complete_composition,
  3L,
  paste0("composition-element-", seq_len(composition_rows)),
  "composition label"
)
assert_identical(
  attr(.subset2(source_environment$complete_composition, 3L), "names", exact = TRUE),
  paste0("composition-element-", seq_len(composition_rows)),
  "the composition fixture lost element names before dispatch"
)
composition_before <- serialize(source_environment$complete_composition, NULL, version = 3L)
composition_session <- "00002003-2003-4203-8203-000000002003"
invisible(dispatch("openSession", list(
  sessionId = composition_session,
  variableName = "complete_composition",
  page = page_window()
)))
composition_steps <- list(
  step_with("complete-compose-filter", "filterRows", list(filterModel = list(
    logic = "and",
    filters = I(list(list(
      column = list(id = "r:c:0", name = "group"),
      type = "string",
      predicates = I(list(list(kind = "predicate", operator = "notEquals", value = "drop")))
    ))),
    sort = I(list())
  ))),
  step_with("complete-compose-group", "groupBy", list(
    keys = I(list(list(id = "r:c:0", name = "group"))),
    aggregations = I(list(list(
      column = list(id = "r:c:1", name = "value"),
      operation = "sum",
      alias = "total"
    )))
  )),
  step_with("complete-compose-formula", "formula", list(
    leftColumn = list(id = "c:step:complete-compose-group:0", name = "total"),
    operator = "add",
    newColumn = "total plus one",
    value = 1L
  ))
)

composition_revision <- 0L
composition_responses <- vector("list", length(composition_steps))
composition_outputs <- vector("list", length(composition_steps))
for (index in seq_along(composition_steps)) {
  latest_capture <- NULL
  preview <- dispatch("previewStep", list(
    sessionId = composition_session,
    revision = composition_revision,
    step = composition_steps[[index]],
    page = page_window()
  ))
  assert_identical(preview$kind, "stepPreview", sprintf("composition step %d did not preview", index))
  composition_outputs[[index]] <- snapshot_from_latest_capture(sprintf("composition step %d", index))
  applied <- dispatch("applyDraft", list(
    sessionId = composition_session,
    revision = preview$revision,
    page = page_window()
  ))
  assert_identical(applied$action, "apply", sprintf("composition step %d did not apply", index))
  composition_revision <- applied$revision
  composition_responses[[index]] <- applied
}
assert_identical(nrow(composition_outputs[[1L]]), 8L, "the composition filter changed cardinality incorrectly")
assert_identical(
  attr(.subset2(composition_outputs[[1L]], 3L), "names", exact = TRUE),
  paste0("composition-element-", 1:8),
  "the composition filter lost surviving element names"
)
assert_identical(nrow(composition_outputs[[2L]]), 2L, "the composition group changed cardinality incorrectly")
assert_identical(
  names(composition_outputs[[3L]]),
  c("group", "total", "total plus one"),
  "the composition lost dynamic schema"
)
assert_identical(
  schema_ids(composition_responses[[3L]]),
  c("r:c:0", "c:step:complete-compose-group:0", "c:step:complete-compose-formula:0"),
  "the composition returned unstable derived identities"
)

inspection_info <- dispatch("inspectStepInfo", list(
  sessionId = composition_session,
  revision = composition_revision,
  stepId = "complete-compose-group"
))
inspection_input <- dispatch("inspectStepPage", list(
  sessionId = composition_session,
  revision = composition_revision,
  stepId = "complete-compose-group",
  side = "input",
  page = page_window()
))
inspection_output <- dispatch("inspectStepPage", list(
  sessionId = composition_session,
  revision = composition_revision,
  stepId = "complete-compose-group",
  side = "output",
  page = page_window()
))
assert_identical(inspection_info$kind, "stepInspectionInfo", "the composition step was not inspectable")
assert_identical(inspection_info$stepIndex, 1L, "inspection returned the wrong composition prefix")
assert_identical(inspection_input$page$page$totalRows, 8L, "inspection returned the wrong group input")
assert_identical(inspection_output$page$page$totalRows, 2L, "inspection returned the wrong group output")
assert_identical(inspection_input$page$schema, NULL, "inspection duplicated the input schema")
assert_identical(inspection_output$page$schema, NULL, "inspection duplicated the output schema")
assert_true(
  grepl("complete-compose-group", inspection_info$code, fixed = TRUE),
  "inspection code omitted the selected plan prefix"
)

composition_generated_environment <- new.env(parent = baseenv())
composition_generated_environment$complete_composition <- unserialize(composition_before)
final_composition_code <- composition_responses[[3L]]$code
eval(parse(text = final_composition_code, keep.source = FALSE), envir = composition_generated_environment)
assert_frame_identical(
  composition_generated_environment$open_wrangler_result,
  composition_outputs[[3L]],
  "generated cardinality-changing composition diverged from live"
)
assert_identical(
  serialize(composition_generated_environment$complete_composition, NULL, version = 3L),
  composition_before,
  "generated cardinality-changing composition mutated source"
)

composition_replay_session <- "00002004-2004-4204-8204-000000002004"
invisible(dispatch("openSession", list(
  sessionId = composition_replay_session,
  variableName = "complete_composition",
  page = page_window()
)))
replay_revision <- 0L
replay_final <- NULL
replay_applied <- NULL
for (index in seq_along(composition_steps)) {
  latest_capture <- NULL
  replay_preview <- dispatch("previewStep", list(
    sessionId = composition_replay_session,
    revision = replay_revision,
    step = composition_steps[[index]],
    page = page_window()
  ))
  assert_identical(replay_preview$kind, "stepPreview", sprintf("saved composition step %d did not replay", index))
  replay_final <- snapshot_from_latest_capture(sprintf("saved composition step %d", index))
  replay_applied <- dispatch("applyDraft", list(
    sessionId = composition_replay_session,
    revision = replay_preview$revision,
    page = page_window()
  ))
  replay_revision <- replay_applied$revision
}
assert_frame_identical(replay_final, composition_outputs[[3L]], "saved full-plan replay changed composition output")
assert_identical(replay_applied$page, composition_responses[[3L]]$page, "saved full-plan replay changed identities")
assert_identical(replay_applied$code, final_composition_code, "saved full-plan replay changed generated code")
assert_identical(
  dispatch("closeSession", list(sessionId = composition_replay_session))$kind,
  "closed",
  "the composition replay session did not close"
)

latest_capture <- NULL
undo_formula <- dispatch("undoStep", list(
  sessionId = composition_session,
  revision = composition_revision,
  page = page_window()
))
assert_identical(undo_formula$action, "undo", "the composition formula did not undo")
assert_identical(undo_formula$page$page$totalRows, 2L, "undoing formula changed grouped cardinality")
assert_identical(
  schema_ids(undo_formula),
  c("r:c:0", "c:step:complete-compose-group:0"),
  "undoing formula changed grouped schema"
)
undo_group <- dispatch("undoStep", list(
  sessionId = composition_session,
  revision = undo_formula$revision,
  page = page_window()
))
assert_identical(undo_group$action, "undo", "the composition group did not undo")
assert_identical(undo_group$page$page$totalRows, 8L, "undoing group did not restore filtered rows")
assert_identical(schema_ids(undo_group), paste0("r:c:", 0:2), "undoing group did not restore source schema")
assert_identical(
  serialize(source_environment$complete_composition, NULL, version = 3L),
  composition_before,
  "live replay, inspection, or undo mutated the composition source"
)
assert_identical(
  dispatch("closeSession", list(sessionId = composition_session))$kind,
  "closed",
  "the composition session did not close"
)
remove("complete_composition", envir = source_environment)

agent$dispose()
cat(paste0(
  "complete native-R catalog contract passed: 31 live/generated/replayed operations; ",
  "inspection, undo, flavors, attributes, zero-row, >1024 chunk, and cardinality composition\n"
))
