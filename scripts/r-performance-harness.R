arguments <- commandArgs(trailingOnly = TRUE)

library_discovery_protocol <- "openwrangler-native-r-library-discovery-v1"

read_library_environment <- function(name, allow_empty = FALSE) {
  value <- Sys.getenv(name, unset = NA_character_)
  if (
    length(value) != 1L ||
      is.na(value) ||
      grepl("\r", value, fixed = TRUE) ||
      grepl("\n", value, fixed = TRUE)
  ) {
    stop("The native R performance library environment is missing or malformed", call. = FALSE)
  }
  if (!nzchar(value)) {
    if (allow_empty) return(character())
    stop("The native R performance library environment is empty", call. = FALSE)
  }
  values <- strsplit(value, .Platform$path.sep, fixed = TRUE)[[1L]]
  if (any(!nzchar(values)) || anyDuplicated(values)) {
    stop("The native R performance library environment has invalid entries", call. = FALSE)
  }
  values
}

if (!identical(Sys.getenv("OPEN_WRANGLER_R_PERFORMANCE_LIBRARY_PROTOCOL"), library_discovery_protocol)) {
  stop("The native R performance library-discovery protocol changed", call. = FALSE)
}
expected_libraries <- read_library_environment("OPEN_WRANGLER_R_PERFORMANCE_LIBRARIES")
expected_site_libraries <- read_library_environment(
  "OPEN_WRANGLER_R_PERFORMANCE_SITE_LIBRARIES",
  allow_empty = TRUE
)
expected_base_library <- read_library_environment("OPEN_WRANGLER_R_PERFORMANCE_BASE_LIBRARY")
if (length(expected_base_library) != 1L) {
  stop("The native R performance base-library environment is invalid", call. = FALSE)
}
assert_library_resolution <- function() {
  canonical_libraries <- normalizePath(.libPaths(), winslash = "/", mustWork = TRUE)
  canonical_site_libraries <- normalizePath(.Library.site, winslash = "/", mustWork = TRUE)
  canonical_base_library <- normalizePath(.Library, winslash = "/", mustWork = TRUE)
  if (
    !identical(canonical_libraries, expected_libraries) ||
      !identical(canonical_site_libraries, expected_site_libraries) ||
      !identical(canonical_base_library, expected_base_library)
  ) {
    stop("The measured R process did not use the exact probe-bound library configuration", call. = FALSE)
  }
  invisible(TRUE)
}
assert_library_resolution()

if (
  length(arguments) != 5L ||
    !arguments[[1L]] %in% c("direct", "kernel-fresh", "kernel-workload")
) {
  stop(
    paste(
      "usage: r-performance-harness.R",
      "direct|kernel-fresh|kernel-workload",
      "<frame_contract.R> <kernel_exports.R> <kernel_agent.R> <fixture.json>"
    ),
    call. = FALSE
  )
}

for (package in c("jsonlite", "data.table", "rlang", "bit64")) {
  if (!requireNamespace(package, quietly = TRUE)) {
    stop(sprintf("The native R performance harness requires %s", package), call. = FALSE)
  }
}

mode <- arguments[[1L]]
frame_contract_file <- arguments[[2L]]
kernel_exports_file <- arguments[[3L]]
kernel_agent_file <- arguments[[4L]]
fixture_file <- arguments[[5L]]

runtime_environment <- new.env(parent = baseenv())
sys.source(frame_contract_file, envir = runtime_environment, keep.source = FALSE)
sys.source(kernel_exports_file, envir = runtime_environment, keep.source = FALSE)
sys.source(kernel_agent_file, envir = runtime_environment, keep.source = FALSE)
if (
  !is.list(runtime_environment$openwrangler_r_frame_contract) ||
    !is.list(runtime_environment$openwrangler_r_kernel_exports) ||
    !is.list(runtime_environment$openwrangler_r_kernel_agent)
) {
  stop("The packaged native R runtime assets did not define their public contracts", call. = FALSE)
}

harness_protocol <- "openwrangler-native-r-performance-harness-v1"
fixture_protocol <- "openwrangler-native-r-performance-fixture-v1"
fresh_open_sample_count <- 5L
workload_sample_count <- 20L
profile_rows <- 1000001L

exact_record <- function(value, fields, label) {
  if (
    !is.list(value) ||
      is.null(names(value)) ||
      anyNA(names(value)) ||
      any(names(value) == "") ||
      anyDuplicated(names(value)) ||
      !setequal(names(value), fields)
  ) {
    stop(sprintf("%s has invalid fields", label), call. = FALSE)
  }
  value
}

fixture <- jsonlite::fromJSON(
  paste(readLines(fixture_file, warn = FALSE, encoding = "UTF-8"), collapse = "\n"),
  simplifyVector = FALSE
)
fixture <- exact_record(
  fixture,
  c(
    "protocol",
    "formulaVersion",
    "rows",
    "columns",
    "pageRows",
    "pageColumns",
    "workloadSamples",
    "columnOffsets",
    "columnDefinitions",
    "profileColumns",
    "expectedStats",
    "first",
    "last"
  ),
  "fixture"
)
if (
  !identical(fixture$protocol, fixture_protocol) ||
    !identical(fixture$formulaVersion, "mixed-base-v1") ||
    as.integer(fixture$rows) != 250000L ||
    as.integer(fixture$columns) != 20L ||
    as.integer(fixture$pageRows) != 200L ||
    as.integer(fixture$pageColumns) != 16L ||
    as.integer(fixture$workloadSamples) != workload_sample_count ||
    !identical(as.integer(unlist(fixture$columnOffsets, use.names = FALSE)), c(0L, 4L))
) {
  stop("The native R performance fixture descriptor is unsupported", call. = FALSE)
}

column_names <- c(
  "row_key",
  "group",
  "value",
  "text",
  "flag",
  "bucket",
  "missing_num",
  "label_factor",
  "ordered_factor",
  "date_value",
  "datetime_value",
  "duration_value",
  "wide_integer",
  "secondary_text",
  "sparse_flag",
  "measure_a",
  "measure_b",
  "measure_c",
  "category",
  "constant"
)
column_kinds <- c(
  "integer",
  "character",
  "double",
  "character",
  "logical",
  "integer",
  "double",
  "factor",
  "ordered",
  "date",
  "datetime",
  "duration",
  "integer64",
  "character",
  "logical",
  "double",
  "integer",
  "double",
  "character",
  "integer"
)
column_formulas <- c(
  "seq_len(rows)",
  "g plus row_key modulo 127",
  "centered modulo with NA NaN positive and negative infinity",
  "duplicate labels with periodic NA and Unicode sentinel",
  "alternating with periodic NA",
  "row_key modulo 997",
  "scaled row_key with periodic NA",
  "five deterministic levels",
  "four deterministic ordered levels",
  "2020-01-01 plus row_key modulo 1461 days",
  "UTC epoch plus row_key modulo 100000 seconds",
  "row_key modulo 7200 seconds",
  "9007199254740992 plus row_key",
  "secondary duplicate labels",
  "periodic true with periodic NA",
  "row_key modulo 4093 divided by 7",
  "row_key modulo 8191",
  "negative row_key modulo 1237",
  "category plus row_key modulo 23",
  "constant 7"
)
descriptor_names <- vapply(
  fixture$columnDefinitions,
  function(value) exact_record(value, c("name", "kind", "formula"), "column definition")$name,
  character(1L),
  USE.NAMES = FALSE
)
descriptor_kinds <- vapply(fixture$columnDefinitions, `[[`, character(1L), "kind", USE.NAMES = FALSE)
descriptor_formulas <- vapply(fixture$columnDefinitions, `[[`, character(1L), "formula", USE.NAMES = FALSE)
if (
  !identical(descriptor_names, column_names) ||
    !identical(descriptor_kinds, column_kinds) ||
    !identical(descriptor_formulas, column_formulas)
) {
  stop("The native R performance column descriptor changed", call. = FALSE)
}

profile_columns <- c(
  "value",
  "text",
  "flag",
  "label_factor",
  "date_value",
  "datetime_value",
  "duration_value",
  "wide_integer"
)
if (!identical(unlist(fixture$profileColumns, use.names = FALSE), profile_columns)) {
  stop("The native R performance profile-column descriptor changed", call. = FALSE)
}

fixture_rows <- as.integer(fixture$rows)
fixture_columns <- as.integer(fixture$columns)
page_rows <- as.integer(fixture$pageRows)
page_columns <- as.integer(fixture$pageColumns)

package_version_or_null <- function(package) {
  if (!requireNamespace(package, quietly = TRUE)) return(NULL)
  as.character(utils::packageVersion(package))
}

runtime_provenance <- function() {
  assert_library_resolution()
  info <- Sys.info()
  list(
    rVersion = paste0(R.version$major, ".", R.version$minor),
    platform = as.character(R.version$platform),
    architecture = as.character(R.version$arch),
    operatingSystem = as.character(info[["sysname"]]),
    libraryResolution = list(
      protocol = library_discovery_protocol,
      directoryCount = length(expected_libraries),
      explicitDirectoriesVerified = TRUE
    ),
    packages = list(
      jsonlite = package_version_or_null("jsonlite"),
      dataTable = package_version_or_null("data.table"),
      rlang = package_version_or_null("rlang"),
      bit64 = package_version_or_null("bit64"),
      tibble = package_version_or_null("tibble"),
      nanoparquet = package_version_or_null("nanoparquet"),
      collapse = package_version_or_null("collapse")
    )
  )
}

build_fixture <- function() {
  row_key <- seq_len(fixture_rows)
  value <- as.double(((row_key * 17L) %% 10007L) - 5003L)
  value[row_key %% 1000L == 0L] <- NA_real_
  value[row_key %% 777L == 0L] <- NaN
  value[row_key %% 997L == 0L] <- Inf
  value[row_key %% 991L == 0L] <- -Inf

  text <- sprintf("row-%06d", ((row_key - 1L) %% 10000L) + 1L)
  text[row_key %% 503L == 0L] <- NA_character_
  text[[12345L]] <- "Grüße-Δ"
  text[[1L]] <- "row-000001"
  text[[fixture_rows]] <- "row-250000"

  flag <- row_key %% 2L == 0L
  flag[row_key %% 509L == 0L] <- NA
  missing_num <- as.double(row_key) / 10
  missing_num[row_key %% 101L == 0L] <- NA_real_
  sparse_flag <- row_key %% 11L == 0L
  sparse_flag[row_key %% 307L == 0L] <- NA

  output <- data.frame(
    row_key = row_key,
    group = sprintf("g%03d", row_key %% 127L),
    value = value,
    text = text,
    flag = flag,
    bucket = as.integer(row_key %% 997L),
    missing_num = missing_num,
    label_factor = factor(paste0("level-", row_key %% 5L), levels = paste0("level-", 0:4)),
    ordered_factor = ordered(paste0("rank-", row_key %% 4L), levels = paste0("rank-", 0:3)),
    date_value = as.Date("2020-01-01") + (row_key %% 1461L),
    datetime_value = as.POSIXct("2020-01-01 00:00:00", tz = "UTC") + (row_key %% 100000L),
    duration_value = as.difftime(row_key %% 7200L, units = "secs"),
    wide_integer = bit64::as.integer64("9007199254740992") + bit64::as.integer64(row_key),
    secondary_text = sprintf("secondary-%03d", row_key %% 211L),
    sparse_flag = sparse_flag,
    measure_a = as.double(row_key %% 4093L) / 7,
    measure_b = as.integer(row_key %% 8191L),
    measure_c = -as.double(row_key %% 1237L),
    category = sprintf("category-%02d", row_key %% 23L),
    constant = rep.int(7L, fixture_rows),
    stringsAsFactors = FALSE
  )
  output
}

build_large_profile_fixture <- function() {
  data.frame(value = as.double(seq_len(profile_rows) %% 1000L))
}

build_keyed_fixture <- function(value) {
  output <- data.table::as.data.table(lapply(value, identity))
  data.table::setkey(output, row_key)
  output
}

validate_supported_attributes <- function(value) {
  valid <-
    identical(class(.subset2(value, 8L)), "factor") &&
    identical(levels(.subset2(value, 8L)), paste0("level-", 0:4)) &&
    identical(class(.subset2(value, 9L)), c("ordered", "factor")) &&
    identical(levels(.subset2(value, 9L)), paste0("rank-", 0:3)) &&
    identical(class(.subset2(value, 10L)), "Date") &&
    identical(class(.subset2(value, 11L)), c("POSIXct", "POSIXt")) &&
    identical(attr(.subset2(value, 11L), "tzone", exact = TRUE), "UTC") &&
    identical(class(.subset2(value, 12L)), "difftime") &&
    identical(attr(.subset2(value, 12L), "units", exact = TRUE), "secs") &&
    identical(class(.subset2(value, 13L)), "integer64")
  if (!valid) stop("The mixed fixture lost supported S3 column attributes", call. = FALSE)
  invisible(TRUE)
}

encode <- function(value) {
  as.character(jsonlite::toJSON(
    value,
    auto_unbox = TRUE,
    digits = 17L,
    null = "null",
    na = "null",
    pretty = FALSE
  ))
}

decode <- function(value) jsonlite::fromJSON(value, simplifyVector = FALSE)

timed <- function(operation) {
  started <- proc.time()[["elapsed"]]
  value <- operation()
  list(
    durationMs = max(0, as.numeric(proc.time()[["elapsed"]] - started) * 1000),
    value = value
  )
}

read_max_observed_rss_kib <- function() {
  lines <- readLines("/proc/self/status", warn = FALSE, encoding = "UTF-8")
  value <- lines[startsWith(lines, "VmHWM:")]
  if (length(value) != 1L) {
    stop("The native R performance harness requires exactly one Linux VmHWM receipt", call. = FALSE)
  }
  match <- regexec("^[^:]+:[[:space:]]*([0-9]+)[[:space:]]+kB$", value, perl = TRUE)
  fields <- regmatches(value, match)[[1L]]
  if (length(fields) != 2L || is.na(suppressWarnings(as.integer(fields[[2L]])))) {
    stop("The native R performance harness could not observe its Linux RSS", call. = FALSE)
  }
  as.integer(fields[[2L]])
}

page_request <- function(row_offset, column_offset, view = list(filters = list(), sorts = list())) {
  list(
    rowOffset = as.integer(row_offset),
    rowLimit = page_rows,
    columnOffset = as.integer(column_offset),
    columnLimit = page_columns,
    view = view
  )
}

empty_view <- function() list(filters = list(), sorts = list())

compound_filter_view <- function() {
  list(
    filters = list(
      list(
        column = list(id = "r:c:5", name = "bucket"),
        type = "integer",
        predicates = list(list(kind = "predicate", operator = "between", value = 100L, secondValue = 800L))
      ),
      list(
        column = list(id = "r:c:4", name = "flag"),
        type = "boolean",
        predicates = list(list(kind = "predicate", operator = "equals", value = TRUE))
      )
    ),
    sorts = list(),
    logic = "and"
  )
}

sort_view <- function() {
  list(
    filters = list(),
    sorts = list(
      list(column = list(id = "r:c:1", name = "group"), direction = "asc", nulls = "last"),
      list(column = list(id = "r:c:2", name = "value"), direction = "desc", nulls = "last")
    )
  )
}

profile_references <- function() {
  positions <- match(profile_columns, column_names)
  lapply(seq_along(profile_columns), function(index) {
    list(id = paste0("r:c:", positions[[index]] - 1L), name = profile_columns[[index]])
  })
}

workload_row_offset <- function(index, total_rows) {
  if (index == 1L) return(0L)
  if (index == 2L) return(as.integer(total_rows - page_rows))
  as.integer(((index - 1L) * 7919L) %% (total_rows - page_rows))
}

workload_column_offset <- function(index) if (index > 10L) 4L else 0L

schema_kind <- function(kind) {
  switch(kind, ordered = "factor", duration = "difftime", kind)
}

validate_full_descriptor <- function(value, flavor = "r.data.frame", key_ids = character()) {
  actual_key_ids <- unlist(value$frameSemantics$keyColumnIds, use.names = FALSE)
  if (is.null(actual_key_ids)) actual_key_ids <- character()
  if (
    !identical(value$contractVersion, 5L) ||
      !identical(value$dataframeFlavor, flavor) ||
      as.integer(value$shape$rows) != fixture_rows ||
      as.integer(value$shape$columns) != fixture_columns ||
      !identical(vapply(value$schema, `[[`, character(1L), "name", USE.NAMES = FALSE), column_names) ||
      !identical(vapply(value$schema, `[[`, character(1L), "id", USE.NAMES = FALSE), paste0("r:c:", 0:19)) ||
      !identical(vapply(value$schema, function(column) as.integer(column$position), integer(1L)), 0:19) ||
      !identical(
        vapply(value$schema, function(column) column$semantics$kind, character(1L), USE.NAMES = FALSE),
        vapply(column_kinds, schema_kind, character(1L), USE.NAMES = FALSE)
      ) ||
      !identical(actual_key_ids, key_ids)
  ) {
    stop("The packaged frame contract changed the deterministic fixture descriptor", call. = FALSE)
  }
}

validate_cell <- function(cell, column, position) {
  value <- column[[position]]
  nan <- is.double(value) && is.nan(value)
  missing <- is.na(value) && !nan
  if (missing) {
    if (!identical(cell$kind, "null") || !isTRUE(cell$isNull) || isTRUE(cell$isNaN) || !is.null(cell$raw)) {
      stop("The packaged frame contract changed a null cell sentinel", call. = FALSE)
    }
    return(invisible(TRUE))
  }
  if (nan) {
    if (!identical(cell$kind, "nan") || isTRUE(cell$isNull) || !isTRUE(cell$isNaN) || !is.null(cell$raw)) {
      stop("The packaged frame contract changed a NaN cell sentinel", call. = FALSE)
    }
    return(invisible(TRUE))
  }
  if (is.double(value) && is.infinite(value)) {
    if (
      !identical(cell$kind, "infinity") ||
        !is.null(cell$raw) ||
        as.integer(cell$sign) != if (value < 0) -1L else 1L
    ) {
      stop("The packaged frame contract changed an infinity cell sentinel", call. = FALSE)
    }
    return(invisible(TRUE))
  }

  if (inherits(column, "integer64")) {
    valid <- identical(cell$kind, "integer") && identical(cell$raw, as.character(value))
  } else if (inherits(column, "Date")) {
    valid <- identical(cell$kind, "date") && identical(cell$raw, format(value, "%Y-%m-%d"))
  } else if (inherits(column, "POSIXct")) {
    valid <- identical(cell$kind, "datetime") && identical(as.numeric(cell$raw), as.numeric(value))
  } else if (inherits(column, "difftime")) {
    valid <- identical(cell$kind, "duration") &&
      identical(as.numeric(cell$raw), as.numeric(value, units = "secs"))
  } else if (is.factor(column)) {
    valid <- identical(cell$kind, "string") && identical(cell$raw, as.character(value))
  } else if (is.character(column)) {
    valid <- identical(cell$kind, "string") && identical(cell$raw, value)
  } else if (is.logical(column)) {
    valid <- identical(cell$kind, "boolean") && identical(cell$raw, value)
  } else if (is.integer(column)) {
    valid <- identical(cell$kind, "integer") && identical(cell$raw, as.character(value))
  } else if (is.double(column)) {
    valid <- identical(cell$kind, "number") && identical(as.numeric(cell$raw), value)
  } else {
    valid <- FALSE
  }
  if (!isTRUE(valid) || !identical(cell$isNull, FALSE) || !identical(cell$isNaN, FALSE)) {
    stop("The packaged frame contract changed a deterministic mixed-type cell", call. = FALSE)
  }
  invisible(TRUE)
}

validate_page_rows <- function(
  value,
  source,
  expected_positions,
  row_offset,
  column_offset,
  total_rows,
  flavor = "r.data.frame",
  key_ids = character()
) {
  validate_full_descriptor(value, flavor, key_ids)
  page <- value$page
  expected_ids <- paste0("r:c:", column_offset + 0:(page_columns - 1L))
  expected_row_ids <- paste0("r:r:", expected_positions - 1L)
  if (
    as.integer(page$offset) != as.integer(row_offset) ||
      as.integer(page$limit) != page_rows ||
      as.integer(page$totalRows) != as.integer(total_rows) ||
      as.integer(page$columnOffset) != as.integer(column_offset) ||
      as.integer(page$columnLimit) != page_columns ||
      !identical(unlist(page$columnIds, use.names = FALSE), expected_ids) ||
      length(page$rows) != length(expected_positions) ||
      any(vapply(page$rows, function(row) length(row$values) != page_columns, logical(1L))) ||
      !identical(vapply(page$rows, `[[`, character(1L), "id", USE.NAMES = FALSE), expected_row_ids) ||
      !identical(
        vapply(page$rows, function(row) as.integer(row$rowNumber), integer(1L), USE.NAMES = FALSE),
        as.integer(row_offset) + seq_along(expected_positions) - 1L
      )
  ) {
    stop("The packaged frame contract changed an exact projected page", call. = FALSE)
  }
  for (row_index in unique(c(1L, length(expected_positions)))) {
    source_position <- expected_positions[[row_index]]
    for (column_index in seq_len(page_columns)) {
      source_column <- column_offset + column_index
      validate_cell(page$rows[[row_index]]$values[[column_index]], .subset2(source, source_column), source_position)
    }
  }
  invisible(TRUE)
}

validate_summary <- function(value) {
  expected_ids <- vapply(profile_references(), `[[`, character(1L), "id", USE.NAMES = FALSE)
  if (
    length(value) != length(profile_columns) ||
      !identical(vapply(value, `[[`, character(1L), "columnId", USE.NAMES = FALSE), expected_ids) ||
      any(vapply(value, function(summary) as.integer(summary$totalCount) != fixture_rows, logical(1L)))
  ) {
    stop("The packaged frame contract changed the eight-column summary shape", call. = FALSE)
  }
  by_name <- setNames(value, profile_columns)
  if (
    as.integer(by_name$value$nullCount) != 250L ||
      as.integer(by_name$value$nanCount) != 321L ||
      as.integer(by_name$text$nullCount) != 497L ||
      as.integer(by_name$text$text$minLength) != 7L ||
      as.integer(by_name$text$text$maxLength) != 10L ||
      as.integer(by_name$flag$nullCount) != 491L ||
      as.integer(by_name$flag$visualization$trueCount) != 124755L ||
      as.integer(by_name$flag$visualization$falseCount) != 124754L ||
      !identical(by_name$label_factor$type, "string") ||
      !identical(by_name$date_value$type, "date") ||
      !identical(by_name$date_value$visualization$min, "2020-01-01") ||
      !identical(by_name$date_value$visualization$max, "2023-12-31") ||
      !identical(by_name$datetime_value$type, "datetime") ||
      !identical(by_name$datetime_value$visualization$min, "2020-01-01T00:00:00.000000") ||
      !identical(by_name$datetime_value$visualization$max, "2020-01-02T03:46:39.000000") ||
      !identical(by_name$duration_value$type, "duration") ||
      as.integer(by_name$duration_value$numeric$min) != 0L ||
      as.integer(by_name$duration_value$numeric$max) != 7199L ||
      !identical(by_name$wide_integer$rawType, "integer64") ||
      !identical(by_name$wide_integer$numeric$exactMin$raw, "9007199254740993") ||
      !identical(by_name$wide_integer$numeric$exactMax$raw, "9007199254990992")
  ) {
    stop("The packaged frame contract changed mixed-type summary semantics", call. = FALSE)
  }
  invisible(TRUE)
}

validate_dataset_stats <- function(value) {
  expected <- fixture$expectedStats
  missing_by_column <- value$stats$missingValuesByColumn
  expected_missing <- as.integer(unlist(expected$missingValuesByColumn, use.names = FALSE))
  if (
    as.integer(value$totalRows) != fixture_rows ||
      as.integer(value$stats$missingCells) != as.integer(expected$missingCells) ||
      as.integer(value$stats$missingRows) != as.integer(expected$missingRows) ||
      as.integer(value$stats$duplicateRows) != as.integer(expected$duplicateRows) ||
      as.integer(value$stats$duplicateRowsSampleSize) != as.integer(expected$duplicateRowsSampleSize) ||
      length(missing_by_column) != fixture_columns ||
      !identical(vapply(missing_by_column, `[[`, character(1L), "column", USE.NAMES = FALSE), column_names) ||
      !identical(
        vapply(missing_by_column, function(entry) as.integer(entry$count), integer(1L), USE.NAMES = FALSE),
        expected_missing
      )
  ) {
    stop("The packaged frame contract changed exact dataset-statistics semantics", call. = FALSE)
  }
  invisible(TRUE)
}

validate_large_summary <- function(value) {
  if (
    length(value) != 1L ||
      as.integer(value[[1L]]$totalCount) != profile_rows ||
      !isTRUE(value[[1L]]$visualization$sampled) ||
      as.integer(value[[1L]]$numeric$min) != 0L ||
      as.integer(value[[1L]]$numeric$max) != 999L
  ) {
    stop("The packaged frame contract did not prove the million-row sampled summary", call. = FALSE)
  }
  invisible(TRUE)
}

validate_keyed_page <- function(value, source) {
  validate_page_rows(
    value,
    source,
    seq_len(page_rows),
    0L,
    0L,
    fixture_rows,
    flavor = "r.data.table",
    key_ids = "r:c:0"
  )
}

run_direct <- function() {
  source <- build_fixture()
  validate_supported_attributes(source)
  source_before <- serialize(source, NULL, version = 3L)
  frame_contract <- runtime_environment$openwrangler_r_frame_contract
  fresh_samples <- numeric(fresh_open_sample_count)
  capture <- NULL
  for (index in seq_len(fresh_open_sample_count)) {
    fresh_capture <- NULL
    result <- timed(function() {
      fresh_capture <<- frame_contract$capture_live_frame(function() source)
      frame_contract$encode_page(
        fresh_capture,
        row_offset = 0L,
        row_limit = page_rows,
        column_offset = 0L,
        column_limit = page_columns
      )
    })
    validate_page_rows(decode(result$value), source, seq_len(page_rows), 0L, 0L, fixture_rows)
    fresh_samples[[index]] <- result$durationMs
    capture <- fresh_capture
  }
  fresh_rss <- read_max_observed_rss_kib()

  projected_samples <- numeric(workload_sample_count)
  for (index in seq_len(workload_sample_count)) {
    row_offset <- workload_row_offset(index, fixture_rows)
    column_offset <- workload_column_offset(index)
    result <- timed(function() frame_contract$encode_page(
      capture,
      row_offset = row_offset,
      row_limit = page_rows,
      column_offset = column_offset,
      column_limit = page_columns
    ))
    validate_page_rows(
      decode(result$value),
      source,
      seq.int(row_offset + 1L, length.out = page_rows),
      row_offset,
      column_offset,
      fixture_rows
    )
    projected_samples[[index]] <- result$durationMs
  }
  projected_rss <- read_max_observed_rss_kib()

  filter_view <- compound_filter_view()
  filter_positions <- which(
    !is.na(source$bucket) & source$bucket >= 100L & source$bucket <= 800L &
      !is.na(source$flag) & source$flag
  )
  filter_samples <- numeric(workload_sample_count)
  for (index in seq_len(workload_sample_count)) {
    row_offset <- workload_row_offset(index, length(filter_positions))
    column_offset <- workload_column_offset(index)
    result <- timed(function() frame_contract$encode_view_page(
      capture,
      view_query = filter_view,
      row_offset = row_offset,
      row_limit = page_rows,
      column_offset = column_offset,
      column_limit = page_columns
    ))
    selected <- filter_positions[seq.int(row_offset + 1L, length.out = page_rows)]
    validate_page_rows(decode(result$value), source, selected, row_offset, column_offset, length(filter_positions))
    filter_samples[[index]] <- result$durationMs
  }
  filter_rss <- read_max_observed_rss_kib()

  sorted_positions <- order(source$group, -source$value, na.last = TRUE, method = "radix")
  first_sort <- timed(function() frame_contract$encode_view_page(
    capture,
    view_query = sort_view(),
    row_offset = 0L,
    row_limit = page_rows,
    column_offset = 0L,
    column_limit = page_columns
  ))
  validate_page_rows(decode(first_sort$value), source, sorted_positions[seq_len(page_rows)], 0L, 0L, fixture_rows)
  sort_samples <- numeric(workload_sample_count)
  for (index in seq_len(workload_sample_count)) {
    row_offset <- workload_row_offset(index, fixture_rows)
    column_offset <- workload_column_offset(index)
    result <- timed(function() frame_contract$encode_view_page(
      capture,
      view_query = sort_view(),
      row_offset = row_offset,
      row_limit = page_rows,
      column_offset = column_offset,
      column_limit = page_columns
    ))
    selected <- sorted_positions[seq.int(row_offset + 1L, length.out = page_rows)]
    validate_page_rows(decode(result$value), source, selected, row_offset, column_offset, fixture_rows)
    sort_samples[[index]] <- result$durationMs
  }
  sort_metrics <- frame_contract$capture_metrics(capture)
  if (as.integer(sort_metrics$sortOrderBuilds) != 1L || as.integer(sort_metrics$cachedSortRows) != fixture_rows) {
    stop("The packaged frame contract did not prove one stable cached sort build", call. = FALSE)
  }
  sort_rss <- read_max_observed_rss_kib()

  summary_samples <- numeric(workload_sample_count)
  for (index in seq_len(workload_sample_count)) {
    result <- timed(function() frame_contract$materialize_summaries(capture, profile_references(), empty_view()))
    validate_summary(result$value)
    summary_samples[[index]] <- result$durationMs
  }
  summary_rss <- read_max_observed_rss_kib()

  stats <- frame_contract$materialize_dataset_stats(capture, empty_view())
  validate_dataset_stats(stats)

  large_source <- build_large_profile_fixture()
  large_before <- serialize(large_source, NULL, version = 3L)
  large_capture <- frame_contract$capture_live_frame(function() large_source)
  large_summary <- frame_contract$materialize_summaries(
    large_capture,
    list(list(id = "r:c:0", name = "value")),
    empty_view()
  )
  validate_large_summary(large_summary)
  large_metrics <- frame_contract$capture_metrics(large_capture)
  if (as.integer(large_metrics$profileColumns) != 1L || !identical(large_before, serialize(large_source, NULL, version = 3L))) {
    stop("The million-row profile proof changed its source or skipped the production profile path", call. = FALSE)
  }

  keyed_source <- build_keyed_fixture(source)
  keyed_before <- serialize(keyed_source, NULL, version = 3L)
  keyed_capture <- frame_contract$capture_live_frame(function() keyed_source)
  keyed_page <- decode(frame_contract$encode_page(
    keyed_capture,
    row_offset = 0L,
    row_limit = page_rows,
    column_offset = 0L,
    column_limit = page_columns
  ))
  validate_keyed_page(keyed_page, keyed_source)
  if (
    !identical(class(keyed_source), c("data.table", "data.frame")) ||
      !identical(data.table::key(keyed_source), "row_key") ||
      !identical(keyed_before, serialize(keyed_source, NULL, version = 3L))
  ) {
    stop("The keyed data-table proof changed its class, key, attributes, or source bytes", call. = FALSE)
  }
  validate_supported_attributes(keyed_source)
  semantic_rss <- read_max_observed_rss_kib()

  if (!identical(source_before, serialize(source, NULL, version = 3L))) {
    stop("The direct packaged runtime changed the base source fixture", call. = FALSE)
  }
  process_rss <- read_max_observed_rss_kib()

  output <- list(
    protocol = harness_protocol,
    kind = "direct",
    runtime = runtime_provenance(),
    fixture = fixture,
    freshOpenSamplesMs = I(as.list(fresh_samples)),
    projectedPageSamplesMs = I(as.list(projected_samples)),
    compoundFilterPageSamplesMs = I(as.list(filter_samples)),
    stableMultiKeySortFirstUncachedMs = first_sort$durationMs,
    stableMultiKeySortPageSamplesMs = I(as.list(sort_samples)),
    eightColumnSummarySamplesMs = I(as.list(summary_samples)),
    resourceProof = list(
      processVmHwmKiB = process_rss,
      stageVmHwmKiB = list(
        freshOpen = fresh_rss,
        projectedPage = projected_rss,
        compoundFilterPage = filter_rss,
        stableMultiKeySortPage = sort_rss,
        eightColumnSummary = summary_rss,
        semanticProof = semantic_rss
      )
    ),
    semanticProof = list(
      passed = TRUE,
      sourceUnchanged = TRUE,
      freshPagesVerified = fresh_open_sample_count,
      projectedPagesVerified = workload_sample_count,
      compoundFilterPagesVerified = workload_sample_count,
      stableSortPagesVerified = workload_sample_count,
      summariesVerified = workload_sample_count,
      datasetStatsVerified = TRUE,
      millionRowSampledSummaryVerified = TRUE,
      keyedDataTableVerified = TRUE
    )
  )
  cat(encode(output), "\n", sep = "")
  flush.console()
}

run_kernel <- function(workload) {
  source_environment <- new.env(parent = emptyenv())
  source_environment$frame <- build_fixture()
  validate_supported_attributes(source_environment$frame)
  source_snapshots <- list(frame = serialize(source_environment$frame, NULL, version = 3L))
  if (workload) {
    source_environment$large_profile <- build_large_profile_fixture()
    source_environment$keyed_frame <- build_keyed_fixture(source_environment$frame)
    validate_supported_attributes(source_environment$keyed_frame)
    source_snapshots$large_profile <- serialize(source_environment$large_profile, NULL, version = 3L)
    source_snapshots$keyed_frame <- serialize(source_environment$keyed_frame, NULL, version = 3L)
  }

  agent <- runtime_environment$openwrangler_r_kernel_agent$new_agent(
    runtime_environment$openwrangler_r_frame_contract,
    source_environment
  )
  disposed <- FALSE
  on.exit({ if (!disposed) agent$dispose() }, add = TRUE)

  ready <- list(
    protocol = harness_protocol,
    kind = "ready",
    runKind = if (workload) "workload" else "fresh",
    runtime = runtime_provenance(),
    fixture = fixture
  )
  cat(encode(ready), "\n", sep = "")
  flush.console()

  input <- file("stdin", open = "r", blocking = TRUE, encoding = "UTF-8")
  on.exit(close(input), add = TRUE)
  repeat {
    line <- readLines(input, n = 1L, warn = FALSE)
    if (length(line) == 0L) break
    if (length(line) != 1L || identical(line, "")) {
      stop("The native R performance kernel received an invalid input frame", call. = FALSE)
    }
    cat(agent$dispatch_json(line), "\n", sep = "")
    flush.console()
  }

  for (name in names(source_snapshots)) {
    if (!identical(source_snapshots[[name]], serialize(get(name, envir = source_environment), NULL, version = 3L))) {
      stop(sprintf("The packaged kernel changed the %s source fixture", name), call. = FALSE)
    }
  }
  if (workload) {
    keyed <- source_environment$keyed_frame
    if (
      !identical(class(keyed), c("data.table", "data.frame")) ||
        !identical(data.table::key(keyed), "row_key") ||
        !identical(source_snapshots$keyed_frame, serialize(keyed, NULL, version = 3L))
    ) {
      stop("The packaged kernel changed keyed data-table class, key, or attributes", call. = FALSE)
    }
    validate_supported_attributes(keyed)
  }
  assert_library_resolution()
  agent$dispose()
  disposed <- TRUE
}

if (identical(mode, "direct")) {
  run_direct()
} else {
  run_kernel(identical(mode, "kernel-workload"))
}
