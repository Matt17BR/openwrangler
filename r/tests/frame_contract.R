source("r/openwrangler_runtime/frame_contract.R", local = FALSE)

assert_true <- function(value, message) {
  if (!isTRUE(value)) stop(message, call. = FALSE)
}

assert_identical <- function(actual, expected, message) {
  if (!identical(actual, expected)) {
    stop(sprintf("%s\nExpected: %s\nActual: %s", message, deparse(expected), deparse(actual)), call. = FALSE)
  }
}

assert_error <- function(expression, pattern) {
  error <- tryCatch(
    {
      force(expression)
      NULL
    },
    error = identity
  )
  matches_code <- inherits(error, "openwrangler_r_frame_error") && identical(error$code, pattern)
  matches_message <- !is.null(error) && grepl(pattern, conditionMessage(error), fixed = TRUE)
  if (is.null(error) || (!matches_code && !matches_message)) {
    stop(sprintf("Expected an error containing %s", pattern), call. = FALSE)
  }
}

require_package <- function(package) {
  if (!requireNamespace(package, quietly = TRUE)) {
    stop(sprintf("The R frame contract test requires %s", package), call. = FALSE)
  }
}

require_package("jsonlite")
require_package("tibble")
require_package("data.table")
require_package("bit64")
require_package("collapse")
require_package("nanoparquet")

base_frame <- data.frame(
  duplicate = c(TRUE, NA, FALSE),
  duplicate = c(1L, NA_integer_, -2L),
  `non syntactic` = c(1.5, NaN, Inf),
  strings = c("alpha", NA_character_, "café"),
  category = factor(c("high", NA, "low"), levels = c("low", "high")),
  ordered = ordered(c("small", "large", NA), levels = c("small", "large")),
  date = as.Date(c("2026-01-01", NA, "2026-01-03")),
  instant = as.POSIXct(c("2026-01-01 12:00:00", NA, "2026-01-03 12:00:00"), tz = "Europe/Berlin"),
  elapsed = as.difftime(c(1, NA, 3), units = "hours"),
  wide = bit64::as.integer64(c("9223372036854775806", NA, "-9223372036854775807")),
  check.names = FALSE
)

base_capture <- openwrangler_r_frame_contract$capture_frame(base_frame)
base_page <- openwrangler_r_frame_contract$materialize_page(
  base_capture,
  row_offset = 0L,
  row_limit = 3L,
  column_offset = 0L,
  column_limit = 20L
)
assert_identical(base_page$dataframeFlavor, "r.data.frame", "base data.frame flavor changed")
assert_identical(base_page$contractVersion, 5L, "R frame contract version changed")
assert_identical(base_page$shape, list(rows = 3L, columns = 10L), "base frame shape changed")
assert_identical(base_page$frameSemantics$rowNames, "positional", "automatic row names were not positional")
assert_true(is.null(base_page$page$rows[[1L]]$rowLabel), "automatic row names leaked into the page")
assert_identical(vapply(base_page$schema, `[[`, character(1L), "id"), sprintf("r:c:%d", 0:9), "IDs are positional")
assert_identical(
  vapply(base_page$schema, `[[`, character(1L), "name"),
  c("duplicate", "duplicate", "non syntactic", "strings", "category", "ordered", "date", "instant", "elapsed", "wide"),
  "duplicate and non-syntactic names were not preserved"
)
assert_identical(base_page$schema[[5L]]$semantics$levels, I(c("low", "high")), "factor levels changed")
assert_identical(base_page$schema[[6L]]$semantics$ordered, TRUE, "ordered-factor metadata changed")
assert_identical(base_page$schema[[8L]]$semantics$timezone, "Europe/Berlin", "POSIXct timezone changed")
assert_identical(base_page$schema[[9L]]$semantics$units, "hours", "difftime units changed")
assert_identical(base_page$page$rows[[1L]]$values[[10L]]$raw, "9223372036854775806", "integer64 lost precision")
assert_identical(base_page$page$rows[[2L]]$values[[3L]]$kind, "nan", "NaN was not distinguished from NA")
assert_identical(base_page$page$rows[[2L]]$values[[2L]]$kind, "null", "NA was not represented as null")
assert_identical(base_page$page$rows[[3L]]$values[[3L]]$kind, "infinity", "infinity was not typed")
assert_identical(base_page$page$rows[[3L]]$values[[3L]]$sign, 1L, "infinity sign changed")
assert_true(jsonlite::validate(openwrangler_r_frame_contract$encode_page(base_capture, row_limit = 3L)), "JSON is invalid")

assert_true(
  !openwrangler_r_frame_contract$nanoparquet_version_supported(NULL) &&
    !openwrangler_r_frame_contract$nanoparquet_version_supported("not-a-version") &&
    !openwrangler_r_frame_contract$nanoparquet_version_supported("0.5.0") &&
    openwrangler_r_frame_contract$nanoparquet_version_supported("0.5.1") &&
    openwrangler_r_frame_contract$nanoparquet_version_supported("1.0.0"),
  "nanoparquet version gating changed"
)
assert_true(openwrangler_r_frame_contract$parquet_export_available(), "nanoparquet was not detected")
assert_identical(
  openwrangler_r_frame_contract$export_formats(),
  c("csv", "parquet"),
  "the R export format probe changed"
)

parquet_target <- tempfile(fileext = ".parquet")
parquet_details <- openwrangler_r_frame_contract$write_parquet(base_capture, parquet_target)
assert_identical(parquet_details$rows, 3L, "Parquet export changed the row count")
assert_identical(parquet_details$columns, 10L, "Parquet export changed the column count")
assert_true(parquet_details$bytes >= 8, "Parquet export reported an invalid byte count")
parquet_connection <- file(parquet_target, open = "rb")
parquet_prefix <- readBin(parquet_connection, what = "raw", n = 4L)
seek(parquet_connection, where = -4L, origin = "end", rw = "read")
parquet_suffix <- readBin(parquet_connection, what = "raw", n = 4L)
close(parquet_connection)
assert_identical(parquet_prefix, charToRaw("PAR1"), "Parquet export has an invalid header")
assert_identical(parquet_suffix, charToRaw("PAR1"), "Parquet export has an invalid footer")
parquet_frame <- nanoparquet::read_parquet(
  parquet_target,
  options = nanoparquet::parquet_options(class = "data.frame", read_int64_type = "integer64")
)
assert_identical(names(parquet_frame), names(base_frame), "Parquet export changed duplicate or non-syntactic names")
assert_identical(parquet_frame[[1L]], base_frame[[1L]], "Parquet export changed logical values")
assert_identical(parquet_frame[[2L]], base_frame[[2L]], "Parquet export changed integer values")
assert_identical(parquet_frame[[3L]], base_frame[[3L]], "Parquet export changed double, NaN, or infinity values")
assert_identical(parquet_frame[[4L]], base_frame[[4L]], "Parquet export changed UTF-8 text")
assert_identical(as.character(parquet_frame[[5L]]), as.character(base_frame[[5L]]), "Parquet export changed factor values")
assert_identical(levels(parquet_frame[[5L]]), levels(base_frame[[5L]]), "Parquet export changed factor levels")
assert_identical(as.character(parquet_frame[[6L]]), as.character(base_frame[[6L]]), "Parquet export changed ordered values")
assert_identical(as.numeric(parquet_frame[[7L]]), as.numeric(base_frame[[7L]]), "Parquet export changed Date values")
assert_identical(as.numeric(parquet_frame[[8L]]), as.numeric(base_frame[[8L]]), "Parquet export changed POSIXct instants")
assert_identical(as.numeric(parquet_frame[[9L]], units = "secs"), as.numeric(base_frame[[9L]], units = "secs"), "Parquet export changed difftime values")
assert_identical(as.character(parquet_frame[[10L]]), as.character(base_frame[[10L]]), "Parquet export lost integer64 precision")
unlink(parquet_target)

zero_column_frame <- data.frame(row.names = seq_len(3L))
zero_column_capture <- openwrangler_r_frame_contract$capture_frame(zero_column_frame)
zero_column_target <- tempfile(fileext = ".parquet")
zero_column_details <- openwrangler_r_frame_contract$write_parquet(zero_column_capture, zero_column_target)
zero_column_result <- nanoparquet::read_parquet(
  zero_column_target,
  options = nanoparquet::parquet_options(class = "data.frame")
)
assert_identical(zero_column_details$rows, 3L, "zero-column Parquet export changed the row count")
assert_identical(dim(zero_column_result), c(3L, 0L), "zero-column Parquet export did not round-trip")
unlink(zero_column_target)

existing_parquet_target <- tempfile(fileext = ".parquet")
writeBin(charToRaw("do not replace"), existing_parquet_target)
assert_error(
  openwrangler_r_frame_contract$write_parquet(base_capture, existing_parquet_target),
  "export-target-changed"
)
assert_identical(
  readBin(existing_parquet_target, what = "raw", n = file.info(existing_parquet_target)$size),
  charToRaw("do not replace"),
  "a rejected Parquet export changed an existing target"
)
unlink(existing_parquet_target)

ambient_frame <- data.frame(
  amount = 1234.5,
  instant = structure(0.25, class = c("POSIXct", "POSIXt")),
  empty_timezone_instant = structure(0.25, class = c("POSIXct", "POSIXt"), tzone = "")
)
ambient_capture <- openwrangler_r_frame_contract$capture_frame(ambient_frame)
original_out_dec <- getOption("OutDec")
original_tz <- Sys.getenv("TZ", unset = NA_character_)
options(OutDec = ",")
Sys.setenv(TZ = "America/New_York")
ambient_page_new_york <- openwrangler_r_frame_contract$materialize_page(
  ambient_capture,
  row_limit = 1L,
  column_limit = 3L
)
options(OutDec = ".")
Sys.setenv(TZ = "Asia/Tokyo")
ambient_page_tokyo <- openwrangler_r_frame_contract$materialize_page(
  ambient_capture,
  row_limit = 1L,
  column_limit = 3L
)
options(OutDec = original_out_dec)
if (is.na(original_tz)) {
  Sys.unsetenv("TZ")
} else {
  Sys.setenv(TZ = original_tz)
}
assert_identical(
  ambient_page_new_york$page$rows[[1L]]$values,
  ambient_page_tokyo$page$rows[[1L]]$values,
  "R cell display changed with ambient OutDec or TZ"
)
assert_identical(
  ambient_page_new_york$page$rows[[1L]]$values[[1L]]$display,
  "1234.5",
  "double display did not retain a JSON-safe decimal point"
)
assert_identical(
  ambient_page_new_york$page$rows[[1L]]$values[[2L]]$display,
  "1970-01-01T00:00:00.250000",
  "a timezone-less POSIXct value was not displayed in UTC"
)
assert_identical(
  ambient_page_new_york$schema[[3L]]$semantics$timezone,
  "",
  "an explicit empty POSIXct timezone was not retained in metadata"
)
assert_identical(
  ambient_page_new_york$page$rows[[1L]]$values[[3L]]$display,
  "1970-01-01T00:00:00.250000",
  "an empty-string POSIXct timezone was not displayed in UTC"
)

base_snapshot <- get("snapshot", envir = base_capture, inherits = FALSE)
base_snapshot[[1L]][1L] <- FALSE
assert_identical(base_frame[[1L]][1L], TRUE, "base snapshot mutation reached the source frame")

tibble_frame <- tibble::as_tibble(base_frame, .name_repair = "minimal")
tibble_capture <- openwrangler_r_frame_contract$capture_frame(tibble_frame)
tibble_page <- openwrangler_r_frame_contract$materialize_page(tibble_capture, row_limit = 1L, column_limit = 2L)
assert_identical(tibble_page$dataframeFlavor, "r.tibble", "tibble flavor changed")
assert_identical(tibble_page$frameSemantics$classes, I(c("tbl_df", "tbl", "data.frame")), "tibble classes changed")
tibble_snapshot <- get("snapshot", envir = tibble_capture, inherits = FALSE)
tibble_snapshot[[2L]][1L] <- 99L
assert_identical(tibble_frame[[2L]][1L], 1L, "tibble snapshot mutation reached the source frame")

table_frame <- data.table::data.table(primary_key = c(2L, 1L), value = c("b", "a"))
data.table::setkey(table_frame, primary_key)
table_before <- data.table::copy(table_frame)
table_capture <- openwrangler_r_frame_contract$capture_frame(table_frame)
table_page <- openwrangler_r_frame_contract$materialize_page(table_capture, row_limit = 2L, column_limit = 2L)
assert_identical(table_page$dataframeFlavor, "r.data.table", "data.table flavor changed")
assert_identical(table_page$frameSemantics$keyColumnIds, I("r:c:0"), "data.table key identity changed")
table_snapshot <- get("snapshot", envir = table_capture, inherits = FALSE)
table_snapshot[, value := "changed"]
assert_true(identical(table_frame, table_before), "data.table snapshot mutation reached the source frame")

collapse_source <- data.frame(
  row_id = 1:3,
  group = c("a", "a", "b"),
  value = c(3.5, 1.5, 2.5),
  stringsAsFactors = FALSE
)
collapse_cases <- list(
  list(frame = collapse::qDF(collapse_source), flavor = "r.data.frame", classes = "data.frame"),
  list(frame = collapse::qTBL(collapse_source), flavor = "r.tibble", classes = c("tbl_df", "tbl", "data.frame")),
  list(frame = collapse::qDT(collapse_source), flavor = "r.data.table", classes = c("data.table", "data.frame"))
)
for (case in collapse_cases) {
  assert_identical(class(case$frame), case$classes, "collapse quick conversion returned unexpected classes")
  capture <- openwrangler_r_frame_contract$capture_frame(case$frame)
  page <- openwrangler_r_frame_contract$materialize_page(capture, row_limit = 3L, column_limit = 3L)
  assert_identical(page$dataframeFlavor, case$flavor, "collapse quick conversion used the wrong dataframe flavor")
  assert_identical(page$shape, list(rows = 3L, columns = 3L), "collapse quick conversion changed shape")
  assert_identical(
    vapply(page$schema, `[[`, character(1L), "name"),
    c("row_id", "group", "value"),
    "collapse quick conversion changed column names"
  )
}

named_row_labels <- c("row-a", "row-b", "row-c")
named_atomic_column <- structure(c(3L, 1L, 2L), names = named_row_labels)
named_classed_column <- structure(
  as.Date(c("2026-01-03", "2026-01-01", "2026-01-02")),
  names = named_row_labels
)
named_factor_column <- structure(
  factor(c("high", "low", "high"), levels = c("low", "high")),
  names = named_row_labels
)
named_column_source <- structure(
  list(atomic = named_atomic_column, classed = named_classed_column, category = named_factor_column),
  class = "data.frame",
  row.names = named_row_labels
)
named_column_table <- data.table::as.data.table(named_column_source)
for (position in seq_len(ncol(named_column_table))) {
  data.table::setattr(named_column_table[[position]], "names", named_row_labels)
}
named_column_cases <- list(
  list(label = "base data.frame", frame = named_column_source, expectedNames = named_row_labels),
  list(label = "tibble", frame = tibble::as_tibble(named_column_source), expectedNames = named_row_labels),
  list(label = "data.table", frame = named_column_table, expectedNames = NULL),
  list(label = "collapse qDF", frame = collapse::qDF(named_column_source), expectedNames = named_row_labels),
  list(label = "collapse qTBL", frame = collapse::qTBL(named_column_source), expectedNames = named_row_labels),
  list(label = "collapse qDT", frame = collapse::qDT(named_column_source), expectedNames = NULL)
)
for (case in named_column_cases) {
  capture <- openwrangler_r_frame_contract$capture_frame(case$frame)
  page <- openwrangler_r_frame_contract$materialize_page(capture, row_limit = 3L, column_limit = 3L)
  assert_identical(page$shape, list(rows = 3L, columns = 3L), sprintf("%s named columns changed shape", case$label))
  assert_identical(
    page$page$rows[[1L]]$values[[1L]]$display,
    "3",
    sprintf("%s named atomic column changed values", case$label)
  )
  assert_identical(
    page$page$rows[[1L]]$values[[2L]]$display,
    "2026-01-03",
    sprintf("%s named classed column changed values", case$label)
  )
  snapshot <- get("snapshot", envir = capture, inherits = FALSE)
  assert_identical(
    attr(snapshot[[3L]], "names", exact = TRUE),
    case$expectedNames,
    sprintf("%s snapshot has unexpected aligned names metadata", case$label)
  )
}

group_identity_source <- data.frame(
  group = c("b", "a", "b"),
  value = c(1L, 2L, 3L),
  stringsAsFactors = FALSE,
  row.names = c("source-b-1", "source-a", "source-b-2")
)
group_identity_source_capture <- openwrangler_r_frame_contract$capture_frame(group_identity_source)
group_identity_result <- openwrangler_r_frame_contract$group_by_at(
  group_identity_source,
  1L,
  "group",
  2L,
  "value",
  "sum",
  "total"
)
group_identity_capture <- openwrangler_r_frame_contract$capture_group_result(
  group_identity_result,
  group_identity_source_capture,
  1L,
  2L,
  "sum",
  c("r:c:0", "c:step:group-identity:0")
)
group_identity_page <- openwrangler_r_frame_contract$materialize_page(
  group_identity_capture,
  row_limit = 10L,
  column_limit = 10L
)
assert_identical(
  group_identity_capture$descriptor$shape$rows,
  2L,
  "a grouped capture lost its actual row count"
)
assert_identical(
  group_identity_capture$rowOrigins,
  c(4L, 5L),
  "grouped rows reused identities from their source capture"
)
assert_identical(
  group_identity_capture$rowIdentityDomain,
  5,
  "a grouped capture did not expand the source identity domain"
)
assert_identical(
  group_identity_page$shape$rows,
  5,
  "a grouped page did not publish the expanded identity domain"
)
assert_identical(group_identity_page$page$totalRows, 2L, "a grouped page lost its actual visible row count")
assert_identical(
  group_identity_page$frameSemantics$rowNames,
  "positional",
  "a grouped result retained source row-name semantics"
)
assert_true(
  all(vapply(group_identity_page$page$rows, function(row) is.null(row$rowLabel), logical(1L))),
  "a grouped result retained source row labels"
)
assert_identical(
  vapply(group_identity_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:3", "r:r:4"),
  "a grouped page published overlapping row identities"
)

group_integer64_source <- data.frame(
  case = c("cancel", "cancel", "odd", "odd", "odd", "same", "same"),
  value = bit64::as.integer64(c(
    "9223372036854775806", "-9223372036854775805",
    "-9223372036854775805", "2", "9223372036854775806",
    "9223372036854775802", "9223372036854775806"
  )),
  stringsAsFactors = FALSE
)
group_integer64_before <- unserialize(serialize(group_integer64_source, NULL, version = 3L))
group_integer64_result <- openwrangler_r_frame_contract$group_by_at(
  group_integer64_source,
  1L,
  "case",
  c(2L, 2L),
  c("value", "value"),
  c("mean", "median"),
  c("value_mean", "value_median")
)
same_sign_midpoint <- suppressWarnings(as.double(bit64::as.integer64("9223372036854775804")))
assert_identical(
  group_integer64_result$value_mean,
  c(0.5, 1, same_sign_midpoint),
  "integer64 Group By mean lost cancellation, odd-count, or same-sign precision"
)
assert_identical(
  group_integer64_result$value_median,
  c(0.5, 2, same_sign_midpoint),
  "integer64 Group By median lost cancellation, odd-count, or same-sign precision"
)
assert_identical(
  group_integer64_source,
  group_integer64_before,
  "integer64 Group By mutated its source dataframe"
)

group_integer64_sum_source <- data.frame(
  group = c("cancel", "cancel"),
  value = bit64::as.integer64(c("9223372036854775807", "-9223372036854775807")),
  stringsAsFactors = FALSE
)
group_integer64_sum_result <- openwrangler_r_frame_contract$group_by_at(
  group_integer64_sum_source,
  1L,
  "group",
  2L,
  "value",
  "sum",
  "value_sum"
)
assert_identical(
  class(group_integer64_sum_result$value_sum),
  "integer64",
  "an exact R integer64 Group By sum changed output type"
)
assert_identical(
  as.character(group_integer64_sum_result$value_sum),
  "0",
  "an exact R integer64 Group By sum lost cancellation"
)
assert_error(
  openwrangler_r_frame_contract$group_by_at(
    data.frame(
      group = c("overflow", "overflow"),
      value = bit64::as.integer64(c("9223372036854775807", "1")),
      stringsAsFactors = FALSE
    ),
    1L,
    "group",
    2L,
    "value",
    "sum",
    "value_sum"
  ),
  "outside the integer64 range"
)

rename_frame <- data.frame(
  duplicate = c(1L, 2L),
  duplicate = c(3L, 4L),
  `non syntactic` = as.Date(c("2026-01-01", "2026-01-02")),
  check.names = FALSE,
  row.names = c("row-a", "row-b")
)
rename_before <- unserialize(serialize(rename_frame, NULL, version = 3L))
renamed_frame <- openwrangler_r_frame_contract$rename_column(
  rename_frame,
  list(id = "r:c:2", name = "non syntactic"),
  "event date"
)
renamed_capture <- openwrangler_r_frame_contract$capture_frame(renamed_frame)
assert_identical(class(renamed_frame), "data.frame", "renaming changed the base data.frame class")
assert_identical(
  names(renamed_frame),
  c("duplicate", "duplicate", "event date"),
  "renaming did not target the exact non-syntactic column position"
)
assert_identical(row.names(renamed_frame), row.names(rename_frame), "renaming changed explicit row names")
assert_identical(
  attributes(renamed_frame[[3L]]),
  attributes(rename_frame[[3L]]),
  "renaming changed column attributes"
)
assert_identical(
  renamed_capture$descriptor$schema[[3L]]$id,
  "r:c:2",
  "renaming changed the stable column identity"
)
assert_identical(rename_frame, rename_before, "renaming mutated the source data.frame")
renamed_frame[[1L]][[1L]] <- 99L
assert_identical(rename_frame[[1L]][[1L]], 1L, "the renamed data.frame shared column storage with its source")

rename_tibble <- tibble::as_tibble(rename_frame, .name_repair = "minimal")
rename_tibble_before <- unserialize(serialize(rename_tibble, NULL, version = 3L))
renamed_tibble <- openwrangler_r_frame_contract$rename_column(
  rename_tibble,
  list(id = "r:c:1", name = "duplicate"),
  "second duplicate"
)
assert_identical(
  class(renamed_tibble),
  c("tbl_df", "tbl", "data.frame"),
  "renaming changed the tibble class"
)
assert_identical(
  names(renamed_tibble),
  c("duplicate", "second duplicate", "non syntactic"),
  "tibble renaming did not resolve a duplicate name by stable position"
)
assert_identical(rename_tibble, rename_tibble_before, "renaming mutated the source tibble")

rename_table <- data.table::data.table(
  `primary key` = c(2L, 1L),
  occurred = as.Date(c("2026-01-02", "2026-01-01")),
  check.names = FALSE
)
data.table::setkeyv(rename_table, "primary key")
rename_table_before <- data.table::copy(rename_table)
renamed_table <- openwrangler_r_frame_contract$rename_column(
  rename_table,
  list(id = "r:c:0", name = "primary key"),
  "order key"
)
renamed_table_capture <- openwrangler_r_frame_contract$capture_frame(renamed_table)
assert_identical(
  class(renamed_table),
  c("data.table", "data.frame"),
  "renaming changed the data.table class"
)
assert_identical(data.table::key(renamed_table), "order key", "renaming did not preserve the data.table key")
assert_identical(
  renamed_table_capture$descriptor$frameSemantics$keyColumnIds,
  I("r:c:0"),
  "renaming changed the stable data.table key identity"
)
assert_identical(
  attributes(renamed_table$occurred),
  attributes(rename_table$occurred),
  "renaming changed data.table column attributes"
)
assert_true(identical(rename_table, rename_table_before), "renaming mutated the source data.table")
renamed_table[, occurred := as.Date("2030-01-01")]
assert_true(identical(rename_table, rename_table_before), "the renamed data.table shared storage with its source")

clone_frame <- data.frame(
  duplicate = c(1L, 2L),
  duplicate = c(3L, NA_integer_),
  `non syntactic` = as.Date(c("2026-05-01", "2026-05-02")),
  check.names = FALSE,
  row.names = c("row-a", "row-b")
)
clone_before <- unserialize(serialize(clone_frame, NULL, version = 3L))
clone_capture <- openwrangler_r_frame_contract$capture_frame(clone_frame)
cloned_frame <- openwrangler_r_frame_contract$clone_column(
  clone_frame,
  list(id = "r:c:1", name = "duplicate"),
  "duplicate copy"
)
clone_source_positions <- c(1L, 2L, 3L, 2L)
clone_output_ids <- c("r:c:0", "r:c:1", "r:c:2", "c:step:clone-step:0")
cloned_capture <- openwrangler_r_frame_contract$capture_frame(
  cloned_frame,
  nullability_source = clone_capture,
  source_positions = clone_source_positions,
  output_ids = clone_output_ids
)
assert_identical(class(cloned_frame), "data.frame", "cloning changed the base data.frame class")
assert_identical(
  names(cloned_frame),
  c("duplicate", "duplicate", "non syntactic", "duplicate copy"),
  "cloning repaired duplicate names or appended the copy in the wrong position"
)
assert_identical(row.names(cloned_frame), row.names(clone_frame), "cloning changed explicit row names")
assert_identical(cloned_frame[[4L]], clone_frame[[2L]], "cloning copied the wrong duplicate column")
assert_identical(
  attributes(cloned_frame[[4L]]),
  attributes(clone_frame[[2L]]),
  "cloning changed the source column attributes"
)
assert_identical(
  vapply(cloned_capture$descriptor$schema, `[[`, character(1L), "id"),
  clone_output_ids,
  "cloning did not publish the explicit derived identity"
)
assert_identical(
  vapply(cloned_capture$descriptor$schema, `[[`, integer(1L), "position"),
  0:3,
  "cloning did not keep contiguous public positions"
)
assert_identical(
  vapply(cloned_capture$descriptor$schema, `[[`, logical(1L), "nullable"),
  vapply(clone_capture$descriptor$schema[clone_source_positions], `[[`, logical(1L), "nullable"),
  "cloning changed source or derived nullability"
)
grammar_derived_id <- "c:step:clone:\nwith:colons:0"
grammar_capture <- openwrangler_r_frame_contract$capture_frame(
  cloned_frame,
  nullability_source = clone_capture,
  source_positions = clone_source_positions,
  output_ids = c("r:c:0", "r:c:1", "r:c:2", grammar_derived_id)
)
assert_identical(
  grammar_capture$descriptor$schema[[4L]]$id,
  grammar_derived_id,
  "the R producer rejected a valid colon/newline derived identity"
)
assert_identical(clone_frame, clone_before, "cloning mutated the source data.frame")
cloned_frame[[4L]][1L] <- 99L
assert_identical(clone_frame, clone_before, "the cloned data.frame shared storage with its source")

clone_tibble <- tibble::as_tibble(clone_frame, .name_repair = "minimal")
clone_tibble_before <- unserialize(serialize(clone_tibble, NULL, version = 3L))
cloned_tibble <- openwrangler_r_frame_contract$clone_column(
  clone_tibble,
  list(id = "r:c:2", name = "non syntactic"),
  "date copy"
)
assert_identical(
  class(cloned_tibble),
  c("tbl_df", "tbl", "data.frame"),
  "cloning changed the tibble class"
)
assert_identical(names(cloned_tibble)[[4L]], "date copy", "tibble cloning changed the requested output name")
assert_identical(cloned_tibble[[4L]], clone_tibble[[3L]], "tibble cloning copied the wrong column")
assert_identical(clone_tibble, clone_tibble_before, "cloning mutated the source tibble")

clone_table <- data.table::data.table(primary_key = c(2L, 1L), value = c("b", "a"))
data.table::setkey(clone_table, primary_key)
clone_table_before <- data.table::copy(clone_table)
clone_table_capture <- openwrangler_r_frame_contract$capture_frame(clone_table)
cloned_table <- openwrangler_r_frame_contract$clone_column(
  clone_table,
  list(id = "r:c:1", name = "value"),
  "value copy"
)
cloned_table_capture <- openwrangler_r_frame_contract$capture_frame(
  cloned_table,
  nullability_source = clone_table_capture,
  source_positions = c(1L, 2L, 2L),
  output_ids = c("r:c:0", "r:c:1", "c:step:table-clone:0")
)
assert_identical(class(cloned_table), c("data.table", "data.frame"), "cloning changed the data.table class")
assert_identical(data.table::key(cloned_table), "primary_key", "cloning changed the data.table key")
assert_identical(
  cloned_table_capture$descriptor$frameSemantics$keyColumnIds,
  I("r:c:0"),
  "cloning changed the stable data.table key identity"
)
assert_identical(cloned_table[[3L]], clone_table[[2L]], "data.table cloning copied the wrong column")
assert_identical(clone_table, clone_table_before, "cloning mutated the source data.table")
cloned_table[, `value copy` := "changed"]
assert_identical(clone_table, clone_table_before, "the cloned data.table shared storage with its source")

assert_error(
  openwrangler_r_frame_contract$clone_column(
    clone_frame,
    list(id = "r:c:1", name = "duplicate"),
    "duplicate"
  ),
  "column-name-collision"
)
assert_error(
  openwrangler_r_frame_contract$clone_column(clone_frame, list(id = "r:c:1", name = "duplicate"), ""),
  "invalid-column-name"
)
assert_error(
  openwrangler_r_frame_contract$clone_column(
    clone_frame,
    list(id = "r:c:1", name = "duplicate"),
    "__OPEN_WRANGLER_INTERNAL_ROW_ID_clone"
  ),
  "reserved-column-name"
)
assert_error(
  openwrangler_r_frame_contract$clone_column(
    clone_frame,
    list(id = "r:c:99", name = "duplicate"),
    "copy"
  ),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$clone_column(
    clone_frame,
    list(id = "r:c:1", name = "wrong"),
    "copy"
  ),
  "stale-column"
)
private_clone_frame <- data.frame(
  `__open_wrangler_internal_row_id_source` = 1L,
  public = 2L,
  check.names = FALSE
)
assert_error(
  openwrangler_r_frame_contract$clone_column(
    private_clone_frame,
    list(id = "r:c:0", name = "__open_wrangler_internal_row_id_source"),
    "copy"
  ),
  "reserved-column-name"
)
assert_error(
  openwrangler_r_frame_contract$capture_frame(
    cloned_frame,
    nullability_source = clone_capture,
    source_positions = clone_source_positions
  ),
  "invalid source-column mapping"
)
assert_error(
  openwrangler_r_frame_contract$capture_frame(
    cloned_frame,
    nullability_source = clone_capture,
    source_positions = clone_source_positions,
    output_ids = c("r:c:1", "r:c:0", "r:c:2", "c:step:clone-step:0")
  ),
  "remapped an existing column identity"
)
assert_error(
  openwrangler_r_frame_contract$capture_frame(
    cloned_frame,
    nullability_source = clone_capture,
    source_positions = clone_source_positions,
    output_ids = c("c:step:forged-retained:0", "r:c:1", "r:c:2", "c:step:clone-step:0")
  ),
  "replaced a retained source identity"
)
assert_error(
  openwrangler_r_frame_contract$capture_frame(
    cloned_frame,
    nullability_source = clone_capture,
    source_positions = clone_source_positions,
    output_ids = c("r:c:0", "c:step:forged-copy-a:0", "r:c:2", "c:step:forged-copy-b:0")
  ),
  "replaced a retained source identity"
)
assert_error(
  openwrangler_r_frame_contract$capture_frame(
    cloned_frame,
    nullability_source = clone_capture,
    source_positions = clone_source_positions,
    output_ids = c("r:c:0", "c:step:forged-first-copy:0", "r:c:2", "r:c:1")
  ),
  "replaced a retained source identity"
)
for (invalid_output_id in c(
  "not-a-stable-id",
  "c:step::0",
  "c:step:clone:00",
  "c:step:clone:2048",
  paste0("c:step:", strrep("x", 1025L), ":0")
)) {
  assert_error(
    openwrangler_r_frame_contract$capture_frame(
      cloned_frame,
      nullability_source = clone_capture,
      source_positions = clone_source_positions,
      output_ids = c("r:c:0", "r:c:1", "r:c:2", invalid_output_id)
    ),
    "invalid explicit output identities"
  )
}
assert_error(
  openwrangler_r_frame_contract$capture_frame(
    cloned_frame,
    nullability_source = clone_capture,
    source_positions = clone_source_positions,
    output_ids = c("r:c:0", "r:c:1", "r:c:2", paste0("c:step:", strrep("x", 2048L), ":0"))
  ),
  "exceeds 2048 UTF-8 bytes"
)
assert_identical(clone_frame, clone_before, "a failed clone mutated its source")

text_length_frame <- data.frame(
  duplicate = c("caf\u00e9", "\U0001F642", NA_character_),
  duplicate = factor(c("alpha", NA, "\u03b2eta"), levels = c("alpha", "\u03b2eta")),
  number = c(1L, 2L, 3L),
  check.names = FALSE,
  row.names = c("row-a", "row-b", "row-c")
)
text_length_before <- unserialize(serialize(text_length_frame, NULL, version = 3L))
text_length_capture <- openwrangler_r_frame_contract$capture_frame(text_length_frame)
text_length_result <- openwrangler_r_frame_contract$text_length_column(
  text_length_frame,
  list(id = "r:c:0", name = "duplicate"),
  "character count"
)
text_length_source_positions <- c(1L, 2L, 3L, 1L)
text_length_output_ids <- c("r:c:0", "r:c:1", "r:c:2", "c:step:text-length-step:0")
text_length_result_capture <- openwrangler_r_frame_contract$capture_frame(
  text_length_result,
  nullability_source = text_length_capture,
  source_positions = text_length_source_positions,
  output_ids = text_length_output_ids,
  text_length_positions = 4L
)
assert_identical(class(text_length_result), "data.frame", "text length changed the base data.frame class")
assert_identical(
  names(text_length_result),
  c("duplicate", "duplicate", "number", "character count"),
  "text length repaired duplicate or non-syntactic names"
)
assert_identical(row.names(text_length_result), row.names(text_length_frame), "text length changed explicit row names")
assert_identical(text_length_result[[4L]], c(4L, 1L, NA_integer_), "text length lost Unicode or NA semantics")
assert_identical(
  vapply(text_length_result_capture$descriptor$schema, `[[`, character(1L), "id"),
  text_length_output_ids,
  "text length changed stable column identities"
)
assert_identical(
  text_length_result_capture$descriptor$schema[[4L]]$type,
  "integer",
  "text length did not publish an integer output"
)
assert_identical(
  text_length_result_capture$descriptor$schema[[4L]]$nullable,
  text_length_capture$descriptor$schema[[1L]]$nullable,
  "text length changed source nullability"
)
assert_identical(text_length_frame, text_length_before, "text length mutated the source data.frame")
text_length_result[[4L]][1L] <- 99L
assert_identical(text_length_frame, text_length_before, "the text length result shared storage with its source")

text_length_tibble <- tibble::as_tibble(text_length_frame, .name_repair = "minimal")
text_length_tibble_before <- unserialize(serialize(text_length_tibble, NULL, version = 3L))
text_length_tibble_result <- openwrangler_r_frame_contract$text_length_column(
  text_length_tibble,
  list(id = "r:c:1", name = "duplicate"),
  "factor count"
)
assert_identical(
  class(text_length_tibble_result),
  c("tbl_df", "tbl", "data.frame"),
  "text length changed the tibble class"
)
assert_identical(
  text_length_tibble_result[[4L]],
  c(5L, NA_integer_, 4L),
  "tibble text length did not use factor labels"
)
assert_identical(text_length_tibble, text_length_tibble_before, "text length mutated the source tibble")

text_length_table <- data.table::data.table(primary_key = c(2L, 1L), value = c("\U0001F642", NA_character_))
data.table::setkey(text_length_table, primary_key)
text_length_table_before <- data.table::copy(text_length_table)
text_length_table_result <- openwrangler_r_frame_contract$text_length_column(
  text_length_table,
  list(id = "r:c:1", name = "value"),
  "value count"
)
assert_identical(
  class(text_length_table_result),
  c("data.table", "data.frame"),
  "text length changed the data.table class"
)
assert_identical(data.table::key(text_length_table_result), "primary_key", "text length changed the data.table key")
assert_identical(text_length_table_result[[3L]], c(NA_integer_, 1L), "data.table text length changed row order")
assert_identical(text_length_table, text_length_table_before, "text length mutated the source data.table")

for (invalid_text_length in list(
  list(reference = list(id = "r:c:2", name = "number"), new_name = "number count", code = "invalid-view-query"),
  list(reference = list(id = "r:c:99", name = "duplicate"), new_name = "count", code = "stale-column"),
  list(reference = list(id = "r:c:0", name = "wrong"), new_name = "count", code = "stale-column"),
  list(reference = list(id = "r:c:0", name = "duplicate"), new_name = "duplicate", code = "column-name-collision"),
  list(reference = list(id = "r:c:0", name = "duplicate"), new_name = "", code = "invalid-column-name"),
  list(
    reference = list(id = "r:c:0", name = "duplicate"),
    new_name = "__OPEN_WRANGLER_INTERNAL_ROW_ID_length",
    code = "reserved-column-name"
  )
)) {
  assert_error(
    openwrangler_r_frame_contract$text_length_column(
      text_length_frame,
      invalid_text_length$reference,
      invalid_text_length$new_name
    ),
    invalid_text_length$code
  )
}
private_text_length_frame <- data.frame(
  `__open_wrangler_internal_row_id_source` = "private",
  public = "public",
  check.names = FALSE
)
assert_error(
  openwrangler_r_frame_contract$text_length_column(
    private_text_length_frame,
    list(id = "r:c:0", name = "__open_wrangler_internal_row_id_source"),
    "count"
  ),
  "reserved-column-name"
)
invalid_bytes_text <- rawToChar(as.raw(0xff))
Encoding(invalid_bytes_text) <- "bytes"
invalid_bytes_frame <- data.frame(value = invalid_bytes_text, check.names = FALSE)
invalid_bytes_before <- unserialize(serialize(invalid_bytes_frame, NULL, version = 3L))
invalid_bytes_error <- tryCatch(
  {
    openwrangler_r_frame_contract$text_length_column(
      invalid_bytes_frame,
      list(id = "r:c:0", name = "value"),
      "count"
    )
    NULL
  },
  error = function(error) error
)
if (is.null(invalid_bytes_error)) {
  stop("R Text Length accepted a non-missing bytes-encoded string", call. = FALSE)
}
assert_identical(invalid_bytes_frame, invalid_bytes_before, "invalid text length input mutated its source")
wide_text_length_source <- as.data.frame(
  setNames(replicate(2048L, "x", simplify = FALSE), sprintf("wide_%04d", seq_len(2048L))),
  optional = TRUE
)
assert_error(
  openwrangler_r_frame_contract$text_length_column(
    wide_text_length_source,
    list(id = "r:c:0", name = "wide_0001"),
    "count"
  ),
  "invalid-view-query"
)
assert_error(
  openwrangler_r_frame_contract$capture_frame(
    text_length_result,
    nullability_source = text_length_capture,
    source_positions = text_length_source_positions,
    output_ids = text_length_output_ids,
    text_length_positions = 1L
  ),
  "invalid text-length output"
)
assert_identical(text_length_frame, text_length_before, "a failed text length operation mutated its source")

lower_frame <- data.frame(
  duplicate = c("CAF\u00c9", "MiXeD", NA_character_),
  duplicate = factor(c("ALPHA", NA, "B\u00c9TA"), levels = c("ALPHA", "B\u00c9TA")),
  number = 1:3,
  check.names = FALSE,
  row.names = c("row-a", "row-b", "row-c")
)
lower_before <- unserialize(serialize(lower_frame, NULL, version = 3L))
lower_capture <- openwrangler_r_frame_contract$capture_frame(lower_frame)
lower_derived <- openwrangler_r_frame_contract$lower_text_column(
  lower_frame,
  list(id = "r:c:0", name = "duplicate"),
  "lower copy"
)
lower_derived_capture <- openwrangler_r_frame_contract$capture_frame(
  lower_derived,
  nullability_source = lower_capture,
  source_positions = c(1L, 2L, 3L, 1L),
  output_ids = c("r:c:0", "r:c:1", "r:c:2", "c:step:lower-step:0"),
  text_transform_positions = 4L
)
assert_identical(
  lower_derived[[4L]],
  c("caf\u00e9", "mixed", NA_character_),
  "lowerText changed accent, ASCII, or NA behavior"
)
assert_identical(row.names(lower_derived), row.names(lower_frame), "lowerText changed explicit row names")
assert_identical(
  vapply(lower_derived_capture$descriptor$schema, `[[`, character(1L), "id"),
  c("r:c:0", "r:c:1", "r:c:2", "c:step:lower-step:0"),
  "derived lowerText changed stable identities"
)
assert_identical(lower_derived_capture$descriptor$schema[[4L]]$rawType, "character", "lowerText returned the wrong type")
assert_identical(
  lower_derived_capture$descriptor$schema[[4L]]$nullable,
  lower_capture$descriptor$schema[[1L]]$nullable,
  "derived lowerText changed nullability"
)

lower_tibble <- tibble::as_tibble(lower_frame, .name_repair = "minimal")
lower_tibble_before <- unserialize(serialize(lower_tibble, NULL, version = 3L))
lower_tibble_result <- openwrangler_r_frame_contract$lower_text_column(
  lower_tibble,
  list(id = "r:c:1", name = "duplicate")
)
lower_tibble_capture <- openwrangler_r_frame_contract$capture_frame(
  lower_tibble_result,
  nullability_source = openwrangler_r_frame_contract$capture_frame(lower_tibble),
  source_positions = 1:3,
  text_transform_positions = 2L
)
assert_identical(class(lower_tibble_result), c("tbl_df", "tbl", "data.frame"), "lowerText changed tibble class")
assert_identical(lower_tibble_result[[2L]], c("alpha", NA_character_, "b\u00e9ta"), "lowerText did not lower factor labels")
assert_identical(lower_tibble_capture$descriptor$schema[[2L]]$id, "r:c:1", "in-place lowerText changed lineage")
assert_identical(lower_tibble_capture$descriptor$schema[[2L]]$rawType, "character", "factor lowerText did not become character")
assert_identical(lower_tibble, lower_tibble_before, "lowerText mutated its source tibble")

lower_table <- data.table::data.table(
  primary_key = c("B", "a"),
  payload = c("SECOND", "FIRST"),
  row_marker = c("row-b", "row-a")
)
data.table::setkey(lower_table, primary_key)
lower_table_before <- data.table::copy(lower_table)
lower_table_append <- openwrangler_r_frame_contract$lower_text_column(
  lower_table,
  list(id = "r:c:0", name = "primary_key"),
  "lower key"
)
lower_table_replace <- openwrangler_r_frame_contract$lower_text_column(
  lower_table,
  list(id = "r:c:1", name = "payload")
)
for (result in list(lower_table_append, lower_table_replace)) {
  assert_identical(data.table::key(result), "primary_key", "lowerText changed a retained data.table key")
  assert_identical(result$row_marker, lower_table_before$row_marker, "lowerText changed physical data.table row order")
}
assert_identical(lower_table_append$`lower key`, c("b", "a"), "derived lowerText changed keyed source values")
assert_identical(lower_table_replace$payload, c("second", "first"), "in-place lowerText changed non-key values")
assert_error(
  openwrangler_r_frame_contract$lower_text_column(
    lower_table,
    list(id = "r:c:0", name = "primary_key")
  ),
  "choose a new output column"
)
assert_identical(lower_table, lower_table_before, "lowerText mutated its source data.table")

for (invalid_lower in list(
  list(reference = list(id = "r:c:2", name = "number"), new_name = NULL, code = "invalid-view-query"),
  list(reference = list(id = "r:c:99", name = "duplicate"), new_name = NULL, code = "stale-column"),
  list(reference = list(id = "r:c:0", name = "wrong"), new_name = NULL, code = "stale-column"),
  list(reference = list(id = "r:c:0", name = "duplicate"), new_name = "number", code = "column-name-collision"),
  list(reference = list(id = "r:c:0", name = "duplicate"), new_name = "", code = "invalid-column-name"),
  list(
    reference = list(id = "r:c:0", name = "duplicate"),
    new_name = "__OPEN_WRANGLER_INTERNAL_ROW_ID_lower",
    code = "reserved-column-name"
  )
)) {
  assert_error(
    openwrangler_r_frame_contract$lower_text_column(
      lower_frame,
      invalid_lower$reference,
      invalid_lower$new_name
    ),
    invalid_lower$code
  )
}
invalid_lower_text <- rawToChar(as.raw(0xff))
Encoding(invalid_lower_text) <- "bytes"
invalid_lower_frame <- data.frame(value = invalid_lower_text, check.names = FALSE)
invalid_lower_before <- unserialize(serialize(invalid_lower_frame, NULL, version = 3L))
assert_error(
  openwrangler_r_frame_contract$lower_text_column(
    invalid_lower_frame,
    list(id = "r:c:0", name = "value")
  ),
  "invalid-text"
)
assert_identical(invalid_lower_frame, invalid_lower_before, "failed lowerText mutated invalid source text")
assert_identical(lower_frame, lower_before, "lowerText mutated its source data.frame")

upper_result <- openwrangler_r_frame_contract$upper_text_column(
  lower_frame,
  list(id = "r:c:0", name = "duplicate"),
  "upper copy"
)
upper_capture <- openwrangler_r_frame_contract$capture_frame(
  upper_result,
  nullability_source = lower_capture,
  source_positions = c(1L, 2L, 3L, 1L),
  output_ids = c("r:c:0", "r:c:1", "r:c:2", "c:step:upper-step:0"),
  text_transform_positions = 4L
)
assert_identical(
  upper_result[[4L]],
  c("CAFÉ", "MIXED", NA_character_),
  "upperText changed Unicode or NA behavior"
)
assert_identical(row.names(upper_result), row.names(lower_frame), "upperText changed explicit row names")
assert_identical(upper_capture$descriptor$schema[[4L]]$id, "c:step:upper-step:0", "upperText lost output lineage")
assert_identical(upper_capture$descriptor$schema[[4L]]$rawType, "character", "upperText returned the wrong type")

text_tools_frame <- data.frame(
  text = c("  hÉLLO world  ", "..[MiXeD]..", "left||||right", "tail||", NA_character_),
  category = factor(c("fIRST", "sECOND", NA, "", "éLAN"), levels = c("fIRST", "sECOND", "", "éLAN")),
  row.names = paste0("tool-", seq_len(5L)),
  check.names = FALSE
)
text_tools_before <- unserialize(serialize(text_tools_frame, NULL, version = 3L))
capitalized <- openwrangler_r_frame_contract$capitalize_text_column(
  text_tools_frame,
  list(id = "r:c:1", name = "category"),
  "capitalized"
)
assert_identical(
  capitalized$capitalized,
  c("First", "Second", NA_character_, "", "Élan"),
  "capitalizeText changed Unicode, empty, factor, or NA behavior"
)
assert_identical(typeof(capitalized$capitalized), "character", "capitalizeText retained factor storage")
assert_identical(row.names(capitalized), row.names(text_tools_frame), "capitalizeText changed row names")

default_stripped <- openwrangler_r_frame_contract$strip_text_column(
  text_tools_frame,
  list(id = "r:c:0", name = "text")
)
assert_identical(
  default_stripped$text,
  c("hÉLLO world", "..[MiXeD]..", "left||||right", "tail||", NA_character_),
  "stripText changed the shared default whitespace behavior"
)
literal_stripped <- openwrangler_r_frame_contract$strip_text_column(
  text_tools_frame,
  list(id = "r:c:0", name = "text"),
  ".[]",
  "literal strip"
)
assert_identical(
  literal_stripped$`literal strip`,
  c("  hÉLLO world  ", "MiXeD", "left||||right", "tail||", NA_character_),
  "stripText treated regex metacharacters as an expression"
)

split_empty <- openwrangler_r_frame_contract$split_text_column(
  text_tools_frame,
  list(id = "r:c:0", name = "text"),
  "||",
  1L,
  "middle"
)
assert_identical(
  split_empty$middle,
  c(NA_character_, NA_character_, "", "", NA_character_),
  "splitText did not preserve empty fields or NA out-of-range values"
)
split_tail <- openwrangler_r_frame_contract$split_text_column(
  text_tools_frame,
  list(id = "r:c:0", name = "text"),
  "||",
  2L,
  "tail"
)
assert_identical(
  split_tail$tail,
  c(NA_character_, NA_character_, "right", NA_character_, NA_character_),
  "splitText changed literal multi-character delimiter behavior"
)
non_nullable_split_source <- data.frame(text = c("plain", "also plain"), check.names = FALSE)
non_nullable_split_capture <- openwrangler_r_frame_contract$capture_frame(non_nullable_split_source)
non_nullable_split_result <- openwrangler_r_frame_contract$split_text_column(
  non_nullable_split_source,
  list(id = "r:c:0", name = "text"),
  "||",
  1L,
  "part"
)
non_nullable_split_result_capture <- openwrangler_r_frame_contract$capture_frame(
  non_nullable_split_result,
  nullability_source = non_nullable_split_capture,
  source_positions = c(1L, 1L),
  output_ids = c("r:c:0", "c:step:split-nullable:0"),
  text_transform_positions = 2L
)
assert_identical(
  non_nullable_split_result_capture$descriptor$schema[[2L]]$nullable,
  TRUE,
  "splitText hid out-of-range NA values behind non-null source metadata"
)

text_tools_tibble <- tibble::as_tibble(text_tools_frame)
text_tools_tibble_before <- unserialize(serialize(text_tools_tibble, NULL, version = 3L))
text_tools_tibble_result <- openwrangler_r_frame_contract$capitalize_text_column(
  text_tools_tibble,
  list(id = "r:c:1", name = "category")
)
assert_identical(
  class(text_tools_tibble_result),
  c("tbl_df", "tbl", "data.frame"),
  "capitalizeText changed the tibble class"
)
assert_identical(text_tools_tibble_result[[2L]], c("First", "Second", NA_character_, "", "Élan"), "tibble capitalizeText changed values")
assert_identical(text_tools_tibble, text_tools_tibble_before, "text tools mutated their source tibble")

text_tools_table <- data.table::data.table(primary_key = c(" [B] ", " [a] "), payload = c("ONE||", "TWO||tail"))
data.table::setkey(text_tools_table, primary_key)
text_tools_table_before <- data.table::copy(text_tools_table)
assert_error(
  openwrangler_r_frame_contract$capitalize_text_column(
    text_tools_table,
    list(id = "r:c:0", name = "primary_key")
  ),
  "choose a new output column"
)
assert_error(
  openwrangler_r_frame_contract$strip_text_column(
    text_tools_table,
    list(id = "r:c:0", name = "primary_key")
  ),
  "choose a new output column"
)
text_tools_table_result <- openwrangler_r_frame_contract$split_text_column(
  text_tools_table,
  list(id = "r:c:1", name = "payload"),
  "||",
  1L,
  "suffix"
)
assert_identical(class(text_tools_table_result), c("data.table", "data.frame"), "splitText changed data.table class")
assert_identical(data.table::key(text_tools_table_result), "primary_key", "splitText lost the data.table key")
assert_identical(text_tools_table_result$suffix, c("", "tail"), "splitText changed keyed data.table row order")
assert_identical(text_tools_table, text_tools_table_before, "text tools mutated their source data.table")

for (invalid_text_tool in list(
  list(code = "invalid-view-query", run = function() openwrangler_r_frame_contract$strip_text_column(
    text_tools_frame,
    list(id = "r:c:0", name = "text"),
    ""
  )),
  list(code = "invalid-view-query", run = function() openwrangler_r_frame_contract$split_text_column(
    text_tools_frame,
    list(id = "r:c:0", name = "text"),
    "",
    0L,
    "part"
  )),
  list(code = "invalid-range", run = function() openwrangler_r_frame_contract$split_text_column(
    text_tools_frame,
    list(id = "r:c:0", name = "text"),
    "||",
    -1L,
    "part"
  )),
  list(code = "invalid-column-name", run = function() openwrangler_r_frame_contract$split_text_column(
    text_tools_frame,
    list(id = "r:c:0", name = "text"),
    "||",
    0L,
    "text"
  ))
)) {
  assert_error(invalid_text_tool$run(), invalid_text_tool$code)
}
assert_identical(text_tools_frame, text_tools_before, "text tools mutated their source data.frame")

text_cleanup_frame <- data.frame(
  text = c("alpha-12", "béta-34", NA_character_, ""),
  category = factor(c("alpha", NA, "béta", "alpha"), levels = c("alpha", "béta")),
  check.names = FALSE,
  row.names = c("row-a", "row-b", "row-c", "row-d")
)
text_cleanup_before <- unserialize(serialize(text_cleanup_frame, NULL, version = 3L))
literal_replaced <- openwrangler_r_frame_contract$find_replace_column(
  text_cleanup_frame,
  list(id = "r:c:0", name = "text"),
  "-",
  "/"
)
assert_identical(
  literal_replaced$text,
  c("alpha/12", "béta/34", NA_character_, ""),
  "literal findReplace returned the wrong values"
)
regex_replaced <- openwrangler_r_frame_contract$find_replace_column(
  text_cleanup_frame,
  list(id = "r:c:0", name = "text"),
  "^(.+)-([0-9]+)$",
  "\\2:\\1",
  TRUE,
  "regex result"
)
assert_identical(
  regex_replaced$`regex result`,
  c("12:alpha", "34:béta", NA_character_, ""),
  "regex findReplace lost captures, Unicode, or NA"
)
assert_identical(row.names(regex_replaced), row.names(text_cleanup_frame), "findReplace changed explicit row names")
factor_replaced <- openwrangler_r_frame_contract$find_replace_column(
  text_cleanup_frame,
  list(id = "r:c:1", name = "category"),
  "a",
  "A",
  FALSE,
  "category result"
)
assert_identical(
  factor_replaced$`category result`,
  c("AlphA", NA_character_, "bétA", "AlphA"),
  "findReplace did not convert factor labels to character"
)
assert_identical(typeof(factor_replaced$`category result`), "character", "findReplace retained factor storage")

blank_replaced <- openwrangler_r_frame_contract$find_replace_column(
  data.frame(text = c("ab", "", NA_character_)),
  list(id = "r:c:0", name = "text"),
  "",
  "\\1"
)
assert_identical(
  blank_replaced$text,
  c("\\1a\\1b\\1", "\\1", NA_character_),
  "literal blank findReplace did not preserve replacement text at character boundaries"
)
assert_error(
  openwrangler_r_frame_contract$find_replace_column(
    text_cleanup_frame,
    list(id = "r:c:0", name = "text"),
    "(",
    "x",
    TRUE
  ),
  "could not apply"
)
regex_warning_error <- tryCatch(
  withCallingHandlers(
    openwrangler_r_frame_contract$find_replace_column(
      data.frame(text = paste0(strrep("a", 100L), "b")),
      list(id = "r:c:0", name = "text"),
      "(*LIMIT_MATCH=1)(a+)+$",
      "x",
      TRUE
    ),
    warning = function(warning) stop("a raw regex warning escaped the R frame contract", call. = FALSE)
  ),
  error = identity
)
assert_identical(
  regex_warning_error$code,
  "invalid-view-query",
  "a regex resource warning did not fail the R draft as an invalid request"
)
assert_identical(
  conditionMessage(regex_warning_error),
  "Find and Replace could not apply the requested regular expression",
  "the R regex-warning diagnostic exposed engine details"
)
assert_error(
  openwrangler_r_frame_contract$find_replace_column(
    data.frame(text = paste(rep("x", 8192L), collapse = "")),
    list(id = "r:c:0", name = "text"),
    "",
    "x"
  ),
  "operation-output-too-large"
)
for (escaped_replacement in c("\\\\1", "\\\\U", "\\\\L")) {
  escaped_result <- openwrangler_r_frame_contract$find_replace_column(
    data.frame(text = strrep("a", 4000L)),
    list(id = "r:c:0", name = "text"),
    "(a)",
    escaped_replacement,
    TRUE
  )
  assert_identical(
    as.integer(nchar(escaped_result$text, type = "bytes")),
    8000L,
    "an escaped literal replacement was misclassified as a backreference or case directive"
  )
}
assert_error(
  openwrangler_r_frame_contract$find_replace_column(
    data.frame(text = strrep("a", 4096L)),
    list(id = "r:c:0", name = "text"),
    "a",
    "xxx"
  ),
  "operation-output-too-large"
)
assert_error(
  openwrangler_r_frame_contract$find_replace_column(
    data.frame(text = strrep("a", 2700L)),
    list(id = "r:c:0", name = "text"),
    "(?=(a+))",
    "\\1",
    TRUE
  ),
  "operation-output-too-large"
)
assert_error(
  openwrangler_r_frame_contract$find_replace_column(
    data.frame(text = strrep("a", 4096L)),
    list(id = "r:c:0", name = "text"),
    "(a)",
    "\\1\\1\\1",
    TRUE
  ),
  "operation-output-too-large"
)
assert_error(
  openwrangler_r_frame_contract$find_replace_column(
    text_cleanup_frame,
    list(id = "r:c:0", name = "text"),
    "alpha",
    "omega",
    FALSE,
    "category"
  ),
  "column-name-collision"
)

text_cleanup_table <- data.table::data.table(primary_key = c("b", "a"), payload = c("old-2", "old-1"))
data.table::setkey(text_cleanup_table, primary_key)
text_cleanup_table_before <- data.table::copy(text_cleanup_table)
assert_error(
  openwrangler_r_frame_contract$upper_text_column(
    text_cleanup_table,
    list(id = "r:c:0", name = "primary_key")
  ),
  "choose a new output column"
)
assert_error(
  openwrangler_r_frame_contract$find_replace_column(
    text_cleanup_table,
    list(id = "r:c:0", name = "primary_key"),
    "a",
    "A"
  ),
  "choose a new output column"
)
table_replaced <- openwrangler_r_frame_contract$find_replace_column(
  text_cleanup_table,
  list(id = "r:c:0", name = "primary_key"),
  "a",
  "A",
  FALSE,
  "clean key"
)
assert_identical(data.table::key(table_replaced), "primary_key", "derived findReplace lost a data.table key")
assert_identical(table_replaced$`clean key`, c("A", "b"), "derived findReplace changed keyed source order")
assert_identical(text_cleanup_table, text_cleanup_table_before, "text transforms mutated their source data.table")
assert_identical(text_cleanup_frame, text_cleanup_before, "text transforms mutated their source data.frame")

scale_frame <- data.frame(
  value = c(-2, 0, 2, NA_real_, NaN, Inf, -Inf),
  constant = c(5, NA_real_, 5, NaN, Inf, -Inf, 5),
  no_finite = c(NA_real_, NaN, Inf, -Inf, NA_real_, NaN, Inf),
  integer_value = c(-10L, 0L, 10L, NA_integer_, 5L, -5L, 2L),
  wide = bit64::as.integer64(c("0", "5", "10", NA, "2", "8", "1")),
  marker = letters[seq_len(7L)],
  check.names = FALSE,
  row.names = paste0("scale-", seq_len(7L))
)
scale_before <- unserialize(serialize(scale_frame, NULL, version = 3L))
scale_capture <- openwrangler_r_frame_contract$capture_frame(scale_frame)
scaled_copy <- openwrangler_r_frame_contract$min_max_scale_column_at(
  scale_frame,
  1L,
  "value",
  "scaled"
)
assert_identical(
  scaled_copy$scaled,
  c(0, 0.5, 1, NA_real_, NA_real_, NA_real_, NA_real_),
  "Min-max scale changed finite or non-finite values"
)
assert_identical(typeof(scaled_copy$scaled), "double", "Min-max scale did not return doubles")
assert_identical(row.names(scaled_copy), row.names(scale_frame), "Min-max scale changed explicit row names")
scaled_copy_capture <- openwrangler_r_frame_contract$capture_frame(
  scaled_copy,
  nullability_source = scale_capture,
  source_positions = c(seq_along(scale_frame), 1L),
  output_ids = c(
    vapply(scale_capture$descriptor$schema, `[[`, character(1L), "id"),
    "c:step:scale-contract:0"
  ),
  min_max_scale_positions = 7L
)
assert_identical(
  scaled_copy_capture$descriptor$schema[[7L]]$id,
  "c:step:scale-contract:0",
  "derived Min-max scale lost its stable identity"
)
assert_identical(
  scaled_copy_capture$descriptor$schema[[7L]]$rawType,
  "double",
  "derived Min-max scale published the wrong type"
)
assert_identical(
  scaled_copy_capture$descriptor$schema[[7L]]$nullable,
  TRUE,
  "derived Min-max scale hid newly introduced nulls"
)

constant_scaled <- withCallingHandlers(
  openwrangler_r_frame_contract$min_max_scale_column_at(scale_frame, 2L, "constant"),
  warning = function(warning) stop("Min-max scaling a constant column emitted a warning", call. = FALSE)
)
assert_identical(
  constant_scaled$constant,
  c(0, NA_real_, 0, NA_real_, NA_real_, NA_real_, 0),
  "Min-max scale did not map a constant finite range to zero"
)
no_finite_scaled <- withCallingHandlers(
  openwrangler_r_frame_contract$min_max_scale_column_at(scale_frame, 3L, "no_finite"),
  warning = function(warning) stop("Min-max scaling an all-non-finite column emitted a warning", call. = FALSE)
)
assert_identical(
  no_finite_scaled$no_finite,
  rep.int(NA_real_, nrow(scale_frame)),
  "Min-max scale did not return typed nulls for a column without finite values"
)
integer_scaled <- openwrangler_r_frame_contract$min_max_scale_column_at(
  scale_frame,
  4L,
  "integer_value"
)
assert_identical(typeof(integer_scaled$integer_value), "double", "Min-max scale did not widen integer input")
wide_scaled <- withCallingHandlers(
  openwrangler_r_frame_contract$min_max_scale_column_at(scale_frame, 5L, "wide"),
  warning = function(warning) stop("Min-max scaling integer64 emitted a warning", call. = FALSE)
)
assert_identical(
  wide_scaled$wide,
  c(0, 0.5, 1, NA_real_, 0.2, 0.8, 0.1),
  "Min-max scale changed integer64 values"
)
assert_identical(typeof(wide_scaled$wide), "double", "Min-max scale did not widen integer64 input")
wide_adjacent_cases <- list(
  positive = bit64::as.integer64(c("9223372036854775805", "9223372036854775806", "9223372036854775807")),
  negative = bit64::as.integer64(c("-9223372036854775807", "-9223372036854775806", "-9223372036854775805"))
)
for (case_name in names(wide_adjacent_cases)) {
  adjacent_source <- data.frame(value = wide_adjacent_cases[[case_name]], check.names = FALSE)
  adjacent_scaled <- openwrangler_r_frame_contract$min_max_scale_column_at(
    adjacent_source,
    1L,
    "value"
  )
  assert_identical(
    adjacent_scaled$value,
    c(0, 0.5, 1),
    sprintf("Min-max scale collapsed adjacent %s integer64 values", case_name)
  )
  assert_identical(
    adjacent_source$value,
    wide_adjacent_cases[[case_name]],
    sprintf("Min-max scale mutated adjacent %s integer64 values", case_name)
  )
}
signed_range_source <- data.frame(
  value = bit64::as.integer64(c("-9223372036854775807", "0", "9223372036854775807", NA)),
  check.names = FALSE
)
signed_range_scaled <- openwrangler_r_frame_contract$min_max_scale_column_at(
  signed_range_source,
  1L,
  "value"
)
assert_identical(signed_range_scaled$value[[1L]], 0, "Min-max scale changed the integer64 lower endpoint")
assert_true(
  abs(signed_range_scaled$value[[2L]] - 0.5) <= .Machine$double.eps,
  "Min-max scale lost the integer64 signed-range midpoint"
)
assert_identical(signed_range_scaled$value[[3L]], 1, "Min-max scale changed the integer64 upper endpoint")
assert_true(is.na(signed_range_scaled$value[[4L]]), "Min-max scale changed an integer64 NA")
signed_quartile_source <- data.frame(
  value = bit64::as.integer64(c(
    "-9223372036854775807",
    "-4611686018427387904",
    "0",
    "4611686018427387904",
    "9223372036854775807",
    NA
  )),
  check.names = FALSE
)
signed_quartile_scaled <- openwrangler_r_frame_contract$min_max_scale_column_at(
  signed_quartile_source,
  1L,
  "value"
)
assert_true(
  isTRUE(all.equal(
    signed_quartile_scaled$value,
    c(0, 0.25, 0.5, 0.75, 1, NA_real_),
    tolerance = .Machine$double.eps,
    check.attributes = FALSE
  )),
  "Min-max scale lost integer64 full-span quartiles"
)
skewed_signed_source <- data.frame(
  value = bit64::as.integer64(c("-1", "0", "9223372036854775807")),
  check.names = FALSE
)
skewed_signed_scaled <- openwrangler_r_frame_contract$min_max_scale_column_at(
  skewed_signed_source,
  1L,
  "value"
)
assert_identical(skewed_signed_scaled$value[[1L]], 0, "Min-max scale changed a skewed integer64 lower endpoint")
assert_identical(skewed_signed_scaled$value[[2L]], 2^-63, "Min-max scale collapsed a skewed integer64 interior value")
assert_identical(skewed_signed_scaled$value[[3L]], 1, "Min-max scale changed a skewed integer64 upper endpoint")
monotonic_source <- data.frame(
  value = bit64::as.integer64(c(
    "0",
    "8999999000001999999",
    "8999999000002000000",
    "9223372036854775807"
  )),
  check.names = FALSE
)
monotonic_scaled <- openwrangler_r_frame_contract$min_max_scale_column_at(
  monotonic_source,
  1L,
  "value"
)
assert_true(
  all(diff(monotonic_scaled$value) >= 0),
  "Min-max scale reversed adjacent integer64 values across an internal limb boundary"
)
assert_identical(scale_frame, scale_before, "Min-max scale mutated its source data.frame")

scale_flavors <- list(
  tibble::as_tibble(data.frame(value = c(10, 20, 30), marker = c("a", "b", "c"))),
  collapse::qDF(data.frame(value = c(10, 20, 30), marker = c("a", "b", "c"))),
  collapse::qTBL(data.frame(value = c(10, 20, 30), marker = c("a", "b", "c"))),
  collapse::qDT(data.frame(value = c(10, 20, 30), marker = c("a", "b", "c")))
)
for (scale_source in scale_flavors) {
  scale_source_before <- if (inherits(scale_source, "data.table")) {
    data.table::copy(scale_source)
  } else {
    unserialize(serialize(scale_source, NULL, version = 3L))
  }
  scale_result <- openwrangler_r_frame_contract$min_max_scale_column_at(
    scale_source,
    1L,
    "value",
    "scaled"
  )
  assert_identical(class(scale_result), class(scale_source), "Min-max scale changed R dataframe flavor")
  assert_identical(scale_result$scaled, c(0, 0.5, 1), "Min-max scale changed a flavor-specific result")
  assert_identical(scale_result$marker, scale_source$marker, "Min-max scale changed source row order")
  assert_identical(scale_source, scale_source_before, "Min-max scale mutated a flavor-specific source")
}

finite_scale_source <- data.frame(value = c(10, 20, 30), check.names = FALSE)
finite_scale_capture <- openwrangler_r_frame_contract$capture_frame(finite_scale_source)
finite_scaled_copy <- openwrangler_r_frame_contract$min_max_scale_column_at(
  finite_scale_source,
  1L,
  "value",
  "scaled"
)
finite_scaled_capture <- openwrangler_r_frame_contract$capture_frame(
  finite_scaled_copy,
  nullability_source = finite_scale_capture,
  source_positions = c(1L, 1L),
  output_ids = c("r:c:0", "c:step:finite-scale-contract:0"),
  min_max_scale_positions = 2L
)
assert_identical(
  finite_scaled_capture$descriptor$schema[[2L]]$nullable,
  TRUE,
  "Min-max scale did not advertise possible nulls for finite source data"
)

scale_table <- data.table::data.table(primary_key = c(2, 1), marker = c("second", "first"))
data.table::setkey(scale_table, primary_key)
scale_table_before <- data.table::copy(scale_table)
assert_error(
  openwrangler_r_frame_contract$min_max_scale_column_at(scale_table, 1L, "primary_key"),
  "choose a new output column"
)
scaled_table <- openwrangler_r_frame_contract$min_max_scale_column_at(
  scale_table,
  1L,
  "primary_key",
  "scaled key"
)
assert_identical(data.table::key(scaled_table), "primary_key", "derived Min-max scale lost a data.table key")
assert_identical(scaled_table$marker, scale_table_before$marker, "derived Min-max scale changed keyed row order")
assert_identical(scale_table, scale_table_before, "Min-max scale mutated its keyed data.table source")
assert_error(
  openwrangler_r_frame_contract$min_max_scale_column_at(
    data.frame(text = c("1", "2"), check.names = FALSE),
    1L,
    "text"
  ),
  "requires a numeric R column"
)
assert_error(
  openwrangler_r_frame_contract$capture_frame(
    wide_scaled,
    nullability_source = scale_capture,
    source_positions = seq_along(scale_frame),
    output_ids = vapply(scale_capture$descriptor$schema, `[[`, character(1L), "id"),
    numeric_transform_positions = 5L
  ),
  "invalid numeric-transform output"
)

fill_frame <- data.frame(
  duplicate = c(1L, NA_integer_, 3L),
  duplicate = c(1, NaN, NA_real_),
  label = ordered(c("high", NA, "low"), levels = c("low", "high")),
  enabled = c(TRUE, NA, FALSE),
  date = as.Date(c("2026-01-01", NA, "2026-01-03")),
  instant = as.POSIXct(c("2026-01-01 12:00:00", NA, "2026-01-03 12:00:00"), tz = "Europe/Berlin"),
  wide = bit64::as.integer64(c("9007199254740993", NA, "9007199254740995")),
  check.names = FALSE,
  row.names = c("row-a", "row-b", "row-c")
)
fill_before <- unserialize(serialize(fill_frame, NULL, version = 3L))
fill_capture <- openwrangler_r_frame_contract$capture_frame(fill_frame)
fill_cases <- list(
  list(position = 1L, name = "duplicate", replacement = list(kind = "median"), expected = c(1L, 2L, 3L)),
  list(position = 2L, name = "duplicate", replacement = list(kind = "float", value = "2.5"), expected = c(1, 2.5, 2.5)),
  list(
    position = 3L,
    name = "label",
    replacement = list(kind = "string", value = "unknown"),
    expected = ordered(c("high", "unknown", "low"), levels = c("low", "high", "unknown"))
  ),
  list(position = 4L, name = "enabled", replacement = list(kind = "boolean", value = TRUE), expected = c(TRUE, TRUE, FALSE)),
  list(
    position = 5L,
    name = "date",
    replacement = list(kind = "date", value = "2026-02-04"),
    expected = as.Date(c("2026-01-01", "2026-02-04", "2026-01-03"))
  ),
  list(
    position = 6L,
    name = "instant",
    replacement = list(kind = "datetime", value = "2026-02-04T05:06:07Z"),
    expected = as.POSIXct(c("2026-01-01 12:00:00", "2026-02-04 06:06:07", "2026-01-03 12:00:00"), tz = "Europe/Berlin")
  ),
  list(
    position = 7L,
    name = "wide",
    replacement = list(kind = "median"),
    expected = bit64::as.integer64(c("9007199254740993", "9007199254740994", "9007199254740995"))
  )
)
for (case in fill_cases) {
  result <- openwrangler_r_frame_contract$fill_missing_column_at(
    fill_frame,
    case$position,
    case$name,
    case$replacement
  )
  result_capture <- openwrangler_r_frame_contract$capture_frame(
    result,
    nullability_source = fill_capture,
    source_positions = seq_along(fill_capture$descriptor$schema),
    fill_missing_positions = case$position
  )
  assert_identical(result[[case$position]], case$expected, sprintf("Fill Missing Values returned the wrong %s values", case$name))
  assert_identical(result_capture$descriptor$schema[[case$position]]$nullable, FALSE, "a filled R column stayed nullable")
  assert_identical(result_capture$descriptor$schema[[case$position]]$id, sprintf("r:c:%d", case$position - 1L), "Fill Missing Values changed column identity")
  assert_identical(row.names(result), row.names(fill_frame), "Fill Missing Values changed explicit row names")
}
assert_identical(fill_frame, fill_before, "Fill Missing Values mutated its source data.frame")

most_frequent_frame <- data.frame(
  text = c("ready", NA, "ready", "later"),
  label = ordered(c("high", NA, "high", "low"), levels = c("low", "high")),
  enabled = c(TRUE, NA, TRUE, FALSE),
  check.names = FALSE
)
most_frequent_before <- unserialize(serialize(most_frequent_frame, NULL, version = 3L))
most_frequent_cases <- list(
  list(position = 1L, expected = c("ready", "ready", "ready", "later")),
  list(position = 2L, expected = ordered(c("high", "high", "high", "low"), levels = c("low", "high"))),
  list(position = 3L, expected = c(TRUE, TRUE, TRUE, FALSE))
)
for (case in most_frequent_cases) {
  result <- openwrangler_r_frame_contract$fill_missing_column_at(
    most_frequent_frame,
    case$position,
    names(most_frequent_frame)[[case$position]],
    list(kind = "mostFrequent")
  )
  assert_identical(
    result[[case$position]],
    case$expected,
    sprintf("Most common value returned the wrong %s values", names(most_frequent_frame)[[case$position]])
  )
}
assert_identical(
  most_frequent_frame,
  most_frequent_before,
  "Most common value mutated its source data.frame"
)

complete_factor <- data.frame(
  label = ordered(c("high", "low"), levels = c("low", "high"))
)
complete_factor_result <- openwrangler_r_frame_contract$fill_missing_column_at(
  complete_factor,
  1L,
  "label",
  list(kind = "string", value = "unused")
)
assert_identical(
  complete_factor_result,
  complete_factor,
  "Fill Missing Values added an unused level to a complete factor"
)
complete_factor_most_frequent <- openwrangler_r_frame_contract$fill_missing_column_at(
  complete_factor,
  1L,
  "label",
  list(kind = "mostFrequent")
)
assert_identical(
  complete_factor_most_frequent,
  complete_factor,
  "Most common value changed a complete factor or rejected its unused tie"
)

assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c("alpha", "beta", NA_character_)),
    1L,
    "value",
    list(kind = "mostFrequent")
  ),
  "2 values are tied"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c(NA_character_, NA_character_)),
    1L,
    "value",
    list(kind = "mostFrequent")
  ),
  "no non-missing values"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c("ready", NA_character_)),
    1L,
    "value",
    list(kind = "mostFrequent", value = "ready")
  ),
  "may not contain a value"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c(1, NA_real_)),
    1L,
    "value",
    list(kind = "mostFrequent")
  ),
  "incompatible"
)

dst_frame <- data.frame(
  instant = as.POSIXct(c("2026-03-28 12:00:00", NA), tz = "Europe/Berlin")
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    dst_frame,
    1L,
    "instant",
    list(kind = "datetime", value = "2026-03-29T02:30:00")
  ),
  "not a valid local datetime"
)

fill_tibble <- tibble::tibble(value = c(NA_character_, "ready"))
fill_tibble_result <- openwrangler_r_frame_contract$fill_missing_column_at(
  fill_tibble,
  1L,
  "value",
  list(kind = "string", value = "missing")
)
assert_identical(class(fill_tibble_result), c("tbl_df", "tbl", "data.frame"), "Fill Missing Values changed tibble class")
assert_identical(fill_tibble_result$value, c("missing", "ready"), "Fill Missing Values returned the wrong tibble values")

fill_table <- data.table::data.table(primary_key = c(1L, 2L), payload = c(NA_character_, "ready"))
data.table::setkey(fill_table, primary_key)
fill_table_before <- data.table::copy(fill_table)
fill_table_result <- openwrangler_r_frame_contract$fill_missing_column_at(
  fill_table,
  2L,
  "payload",
  list(kind = "string", value = "missing")
)
assert_identical(class(fill_table_result), c("data.table", "data.frame"), "Fill Missing Values changed data.table class")
assert_identical(data.table::key(fill_table_result), "primary_key", "Fill Missing Values dropped an unaffected data.table key")
assert_identical(fill_table_result$payload, c("missing", "ready"), "Fill Missing Values returned the wrong data.table values")
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    fill_table,
    1L,
    "primary_key",
    list(kind = "integer", value = "0")
  ),
  "key column"
)
assert_identical(fill_table, fill_table_before, "Fill Missing Values mutated its source data.table")

assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c(1L, NA_integer_, 2L)),
    1L,
    "value",
    list(kind = "median")
  ),
  "not an integer"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c(NA_real_, NaN)),
    1L,
    "value",
    list(kind = "median")
  ),
  "no present values"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c(NA_character_, "ready")),
    1L,
    "value",
    list(kind = "decimal", value = "1.0")
  ),
  "incompatible"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = as.Date(c(NA, "2026-01-01"))),
    1L,
    "value",
    list(kind = "date", value = "2026-02-30")
  ),
  "valid date"
)
empty_fill <- data.frame(value = character())
assert_identical(
  openwrangler_r_frame_contract$fill_missing_column_at(
    empty_fill,
    1L,
    "value",
    list(kind = "string", value = "unused")
  ),
  empty_fill,
  "Fill Missing Values changed an empty compatible frame"
)

fallback_fill_frame <- data.frame(
  target = ordered(c(NA, "high", NA, NA), levels = c("low", "high")),
  first = factor(c("medium", "ignored", "low", NA), levels = c("medium", "ignored", "low")),
  second = c("late", "ignored", "unused", NA),
  check.names = FALSE,
  row.names = paste0("fallback-", 1:4)
)
fallback_fill_before <- unserialize(serialize(fallback_fill_frame, NULL, version = 3L))
fallback_fill_capture <- openwrangler_r_frame_contract$capture_frame(fallback_fill_frame)
fallback_fill_result <- openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
  fallback_fill_frame,
  1L,
  "target",
  c(2L, 3L),
  c("first", "second")
)
assert_identical(
  fallback_fill_result$target,
  ordered(c("medium", "high", "low", NA), levels = c("low", "high", "medium")),
  "fallback columns lost their priority or changed ordered factor semantics"
)
assert_identical(
  row.names(fallback_fill_result),
  row.names(fallback_fill_frame),
  "fallback columns changed explicit row names"
)
fallback_fill_result_capture <- openwrangler_r_frame_contract$capture_frame(
  fallback_fill_result,
  nullability_source = fallback_fill_capture,
  source_positions = seq_along(fallback_fill_capture$descriptor$schema),
  fallback_fill_positions = 1L
)
assert_identical(
  fallback_fill_result_capture$descriptor$schema[[1L]]$nullable,
  TRUE,
  "an unresolved fallback fill was published as non-nullable"
)
fallback_fill_complete <- fallback_fill_frame
fallback_fill_complete$second[[4L]] <- "last"
fallback_fill_complete_result <- openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
  fallback_fill_complete,
  1L,
  "target",
  c(2L, 3L),
  c("first", "second")
)
fallback_fill_complete_capture <- openwrangler_r_frame_contract$capture_frame(
  fallback_fill_complete_result,
  nullability_source = openwrangler_r_frame_contract$capture_frame(fallback_fill_complete),
  source_positions = 1:3,
  fallback_fill_positions = 1L
)
assert_identical(
  fallback_fill_complete_capture$descriptor$schema[[1L]]$nullable,
  FALSE,
  "a complete fallback fill stayed nullable"
)
assert_identical(
  levels(fallback_fill_complete_result$target),
  c("low", "high", "medium", "last"),
  "fallback factor levels were not appended in first-use order"
)
assert_identical(fallback_fill_frame, fallback_fill_before, "fallback columns mutated their source data.frame")

fallback_tibble <- tibble::tibble(target = c(NA_character_, "ready"), fallback = c("backup", "unused"))
fallback_tibble_before <- unserialize(serialize(fallback_tibble, NULL, version = 3L))
fallback_tibble_result <- openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
  fallback_tibble,
  1L,
  "target",
  2L,
  "fallback"
)
assert_identical(
  class(fallback_tibble_result),
  c("tbl_df", "tbl", "data.frame"),
  "fallback columns changed tibble class"
)
assert_identical(fallback_tibble_result$target, c("backup", "ready"), "fallback columns changed tibble values")
assert_identical(fallback_tibble, fallback_tibble_before, "fallback columns mutated their source tibble")

fallback_numeric <- data.frame(
  integer = c(NA_integer_, 2L, NA_integer_),
  wide = bit64::as.integer64(c("7", NA, "9")),
  wide_source = bit64::as.integer64(c("4", "5", NA)),
  integer_source = c(1L, 6L, 3L),
  number = c(NaN, 2, NA_real_),
  number_source = c(1, NaN, NA_real_)
)
fallback_integer <- openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
  fallback_numeric,
  1L,
  "integer",
  3L,
  "wide_source"
)
assert_identical(fallback_integer$integer, c(4L, 2L, NA_integer_), "integer fallback conversion changed exact values")
fallback_wide <- openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
  fallback_numeric,
  2L,
  "wide",
  4L,
  "integer_source"
)
assert_identical(
  fallback_wide$wide,
  bit64::as.integer64(c("7", "6", "9")),
  "integer64 fallback conversion lost exact values"
)
fallback_number <- openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
  fallback_numeric,
  5L,
  "number",
  6L,
  "number_source"
)
assert_identical(
  fallback_number$number,
  c(1, 2, NA_real_),
  "fallback columns did not treat NA and NaN as missing in priority order"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
    data.frame(target = NA_integer_, fallback = bit64::as.integer64("2147483648")),
    1L,
    "target",
    2L,
    "fallback"
  ),
  "outside the R integer range"
)

fallback_temporal <- data.frame(
  date = as.Date(c(NA, "2026-01-02")),
  date_source = as.Date(c("2026-01-01", "2026-01-03")),
  instant = as.POSIXct(c(NA, "2026-01-02 12:00:00"), tz = "Europe/Berlin"),
  instant_source = as.POSIXct(c("2026-01-01 11:00:00", "2026-01-03 11:00:00"), tz = "UTC")
)
fallback_temporal <- openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
  fallback_temporal,
  1L,
  "date",
  2L,
  "date_source"
)
fallback_temporal <- openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
  fallback_temporal,
  3L,
  "instant",
  4L,
  "instant_source"
)
assert_identical(fallback_temporal$date, as.Date(c("2026-01-01", "2026-01-02")), "date fallback changed class")
assert_identical(attr(fallback_temporal$instant, "tzone"), "Europe/Berlin", "datetime fallback changed target timezone")
assert_identical(
  as.double(fallback_temporal$instant[[1L]]),
  as.double(as.POSIXct("2026-01-01 11:00:00", tz = "UTC")),
  "datetime fallback changed the represented instant"
)

fallback_table <- data.table::data.table(key_value = c("b", "a"), target = c(NA_character_, "ready"))
data.table::setkey(fallback_table, key_value)
fallback_table_before <- data.table::copy(fallback_table)
fallback_table_result <- openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
  fallback_table,
  2L,
  "target",
  1L,
  "key_value"
)
assert_identical(data.table::key(fallback_table_result), "key_value", "fallback fill dropped a data.table key")
assert_identical(fallback_table_result$target, c("ready", "b"), "a keyed fallback column was not usable")
assert_error(
  openwrangler_r_frame_contract$fill_missing_from_fallback_columns_at(
    fallback_table,
    1L,
    "key_value",
    2L,
    "target"
  ),
  "key column"
)
assert_identical(fallback_table, fallback_table_before, "fallback fill mutated its source data.table")

directional_frame <- data.frame(
  sequence = c(4L, 1L, 3L, 2L, 6L, 5L),
  target = ordered(c(NA, "start", NA, NA, NA, "end"), levels = c("start", "end")),
  row.names = paste0("directional-", 1:6),
  check.names = FALSE
)
directional_before <- unserialize(serialize(directional_frame, NULL, version = 3L))
directional_forward <- openwrangler_r_frame_contract$fill_missing_directional_at(
  directional_frame,
  2L,
  "target",
  1L,
  "sequence",
  "asc",
  "last",
  "forward"
)
assert_identical(
  directional_forward$target,
  ordered(c("start", "start", "start", "start", "end", "end"), levels = c("start", "end")),
  "forward directional fill ignored explicit order or failed to restore source row order"
)
assert_identical(
  row.names(directional_forward),
  row.names(directional_frame),
  "directional fill changed explicit row names"
)
assert_identical(levels(directional_forward$target), levels(directional_frame$target), "directional fill changed factor levels")

directional_limited <- openwrangler_r_frame_contract$fill_missing_directional_at(
  directional_frame,
  2L,
  "target",
  1L,
  "sequence",
  "asc",
  "last",
  "forward",
  2L
)
assert_identical(
  directional_limited$target,
  ordered(c(NA, "start", NA, NA, "end", "end"), levels = c("start", "end")),
  "max_gap partially filled a missing run that exceeded the whole-run threshold"
)

directional_boundaries <- data.frame(
  sequence = c(3L, 1L, 5L, 2L, 4L),
  target = c("middle", NA_character_, NA_character_, NA_character_, NA_character_),
  check.names = FALSE
)
directional_backward <- openwrangler_r_frame_contract$fill_missing_directional_at(
  directional_boundaries,
  2L,
  "target",
  1L,
  "sequence",
  "asc",
  "last",
  "backward",
  2L
)
assert_identical(
  directional_backward$target,
  c("middle", "middle", NA_character_, "middle", NA_character_),
  "backward directional fill did not fill the leading boundary or incorrectly filled the trailing boundary"
)

directional_table <- data.table::data.table(
  sequence = c(2L, 1L, 3L),
  target = as.POSIXct(c(NA, "2026-01-01 12:00:00", NA), tz = "Europe/Berlin")
)
data.table::setkey(directional_table, sequence)
directional_table_before <- data.table::copy(directional_table)
directional_table_result <- openwrangler_r_frame_contract$fill_missing_directional_at(
  directional_table,
  2L,
  "target",
  1L,
  "sequence",
  "asc",
  "last",
  "forward"
)
assert_identical(class(directional_table_result), c("data.table", "data.frame"), "directional fill changed data.table class")
assert_identical(data.table::key(directional_table_result), "sequence", "directional fill dropped an unaffected data.table key")
assert_identical(attr(directional_table_result$target, "tzone"), "Europe/Berlin", "directional fill changed timezone")
assert_true(!anyNA(directional_table_result$target), "directional fill did not fill ordered datetime gaps")
assert_identical(directional_table, directional_table_before, "directional fill mutated its source data.table")

directional_collapse <- collapse::qTBL(data.frame(sequence = 1:3, target = c(1L, NA_integer_, 3L)))
directional_collapse_result <- openwrangler_r_frame_contract$fill_missing_directional_at(
  directional_collapse,
  2L,
  "target",
  1L,
  "sequence",
  "asc",
  "last",
  "forward"
)
assert_identical(
  class(directional_collapse_result),
  c("tbl_df", "tbl", "data.frame"),
  "directional fill changed collapse tibble flavor"
)
assert_identical(directional_collapse_result$target, c(1L, 1L, 3L), "directional fill changed integer dtype")
assert_identical(directional_frame, directional_before, "directional fill mutated its source data.frame")

assert_error(
  openwrangler_r_frame_contract$fill_missing_directional_at(
    directional_frame,
    2L,
    "target",
    2L,
    "target",
    "asc",
    "last",
    "forward"
  ),
  "directional ordering selection"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_directional_at(
    directional_frame,
    2L,
    "target",
    1L,
    "sequence",
    "asc",
    "last",
    "forward",
    0L
  ),
  "max_gap must be positive"
)

interpolation_frame <- data.frame(
  coordinate = c(12, 0, 5, 20, 8, 30, 3),
  target = c(NA_real_, 0, NaN, Inf, 80, NA_real_, NA_real_),
  row.names = paste0("interpolation-", 1:7),
  check.names = FALSE
)
interpolation_before <- unserialize(serialize(interpolation_frame, NULL, version = 3L))
interpolation_result <- openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
  interpolation_frame,
  2L,
  "target",
  1L,
  "coordinate"
)
assert_identical(
  interpolation_result$target,
  c(NA_real_, 0, 50, Inf, 80, NA_real_, 30),
  "linear interpolation did not use coordinate distance or preserve unresolved gaps"
)
assert_identical(
  row.names(interpolation_result),
  row.names(interpolation_frame),
  "linear interpolation changed source row order or row names"
)
assert_identical(interpolation_frame, interpolation_before, "linear interpolation mutated its source data.frame")

empty_interpolation_frame <- data.frame(coordinate = integer(), target = double(), check.names = FALSE)
empty_interpolation_before <- unserialize(serialize(empty_interpolation_frame, NULL, version = 3L))
empty_interpolation_result <- openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
  empty_interpolation_frame,
  2L,
  "target",
  1L,
  "coordinate"
)
empty_interpolation_capture <- openwrangler_r_frame_contract$capture_frame(empty_interpolation_result)
assert_identical(class(empty_interpolation_result), "data.frame", "empty interpolation changed the base frame flavor")
assert_identical(typeof(empty_interpolation_result$target), "double", "empty interpolation changed target storage")
assert_identical(
  empty_interpolation_capture$descriptor$schema[[2L]]$type,
  "float",
  "empty interpolation published the wrong target type"
)
assert_identical(
  empty_interpolation_capture$descriptor$schema[[2L]]$rawType,
  "double",
  "empty interpolation published the wrong raw target type"
)
assert_identical(
  empty_interpolation_capture$descriptor$schema[[2L]]$semantics$kind,
  "double",
  "empty interpolation published the wrong target semantics"
)
assert_identical(empty_interpolation_frame, empty_interpolation_before, "empty interpolation mutated its source")

interpolation_limited <- openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
  interpolation_frame,
  2L,
  "target",
  1L,
  "coordinate",
  1L
)
assert_identical(
  interpolation_limited$target,
  interpolation_frame$target,
  "max_gap partially interpolated a run that exceeded the whole-run threshold"
)

interpolation_huge <- data.frame(
  coordinate = c(-.Machine$double.xmax, 0, .Machine$double.xmax),
  target = c(.Machine$double.xmax, NA_real_, -.Machine$double.xmax)
)
interpolation_huge_result <- openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
  interpolation_huge,
  2L,
  "target",
  1L,
  "coordinate"
)
assert_identical(
  interpolation_huge_result$target,
  c(.Machine$double.xmax, 0, -.Machine$double.xmax),
  "linear interpolation overflowed finite opposite-sign endpoints"
)

interpolation_date <- data.frame(
  coordinate = as.Date(c("2026-01-01", "2026-01-03", "2026-01-11")),
  target = c(0, NA_real_, 100)
)
interpolation_date_result <- openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
  interpolation_date,
  2L,
  "target",
  1L,
  "coordinate"
)
assert_identical(
  interpolation_date_result$target,
  c(0, 20, 100),
  "Date interpolation did not use elapsed days"
)

interpolation_instant <- data.frame(
  coordinate = as.POSIXct(
    c("2026-03-29 00:00:00", "2026-03-29 03:00:00", "2026-03-29 04:00:00"),
    tz = "Europe/Berlin"
  ),
  target = c(0, NA_real_, 30)
)
interpolation_instant_result <- openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
  interpolation_instant,
  2L,
  "target",
  1L,
  "coordinate"
)
assert_identical(
  interpolation_instant_result$target,
  c(0, 20, 30),
  "POSIXct interpolation did not use elapsed instants across DST"
)

interpolation_flavors <- list(
  list(frame = tibble::tibble(coordinate = c(0, 2, 4), target = c(0, NA_real_, 8))),
  list(frame = data.table::data.table(coordinate = c(0, 2, 4), target = c(0, NA_real_, 8))),
  list(frame = collapse::qDF(data.frame(coordinate = c(0, 2, 4), target = c(0, NA_real_, 8)))),
  list(frame = collapse::qTBL(data.frame(coordinate = c(0, 2, 4), target = c(0, NA_real_, 8)))),
  list(frame = collapse::qDT(data.frame(coordinate = c(0, 2, 4), target = c(0, NA_real_, 8))))
)
for (case in interpolation_flavors) {
  frame <- case$frame
  if (inherits(frame, "data.table")) data.table::setkey(frame, coordinate)
  before <- if (inherits(frame, "data.table")) data.table::copy(frame) else unserialize(serialize(frame, NULL, version = 3L))
  result <- openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
    frame,
    2L,
    "target",
    1L,
    "coordinate"
  )
  assert_identical(class(result), class(frame), "linear interpolation changed the R dataframe flavor")
  assert_identical(result$target, c(0, 4, 8), "linear interpolation changed floating-point target dtype")
  assert_identical(typeof(result$target), "double", "linear interpolation changed target storage")
  if (inherits(frame, "data.table")) {
    assert_identical(data.table::key(result), "coordinate", "linear interpolation dropped an unaffected data.table key")
  }
  assert_identical(frame, before, "linear interpolation mutated an R dataframe flavor source")
}

invalid_interpolation_coordinates <- list(
  data.frame(coordinate = c(0, NA_real_, 2), target = c(0, NA_real_, 2)),
  data.frame(coordinate = c(0, Inf, 2), target = c(0, NA_real_, 2)),
  data.frame(coordinate = c(0, 0, 2), target = c(0, NA_real_, 2)),
  data.frame(coordinate = c("a", "b", "c"), target = c(0, NA_real_, 2)),
  data.frame(coordinate = bit64::as.integer64(c(0, 1, 2)), target = c(0, NA_real_, 2))
)
for (invalid_frame in invalid_interpolation_coordinates) {
  assert_error(
    openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
      invalid_frame,
      2L,
      "target",
      1L,
      "coordinate"
    ),
    "interpolation"
  )
}
assert_error(
  openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
    data.frame(coordinate = c(0, 1, 2), target = c(0L, NA_integer_, 2L)),
    2L,
    "target",
    1L,
    "coordinate"
  ),
  "floating-point"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_linear_interpolation_at(
    interpolation_frame,
    2L,
    "target",
    2L,
    "target"
  ),
  "fill target"
)

grouped_mean_frame <- data.frame(
  group = c(NA_real_, NaN, 1, 1, 2, 2, 3, 3, 3),
  day = as.Date(rep("2026-01-01", 9L)),
  target = c(2, NA, 4, NaN, Inf, NA, Inf, -Inf, NA),
  row.names = paste0("grouped-", 1:9),
  check.names = FALSE
)
grouped_mean_before <- unserialize(serialize(grouped_mean_frame, NULL, version = 3L))
grouped_mean_result <- openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
  grouped_mean_frame,
  3L,
  "target",
  c(1L, 2L),
  c("group", "day"),
  "mean"
)
assert_identical(
  grouped_mean_result$target,
  c(2, 2, 4, 4, Inf, Inf, Inf, -Inf, NA),
  "grouped mean did not fill a target NaN, normalize NA/NaN keys, or preserve an unresolved null gap"
)
assert_identical(row.names(grouped_mean_result), row.names(grouped_mean_frame), "grouped mean changed row names")
assert_identical(grouped_mean_frame, grouped_mean_before, "grouped mean mutated its source data.frame")

smallest_positive_double <- 2^-1074
grouped_float_median <- data.frame(
  group = c("odd", "odd", "even", "even", "even"),
  target = c(
    smallest_positive_double,
    NA_real_,
    .Machine$double.xmax / 2,
    .Machine$double.xmax,
    NA_real_
  )
)
grouped_float_median_result <- openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
  grouped_float_median,
  2L,
  "target",
  1L,
  "group",
  "median"
)
assert_identical(
  grouped_float_median_result$target[[2L]],
  smallest_positive_double,
  "an odd grouped float median underflowed instead of returning its exact middle value"
)
assert_identical(
  grouped_float_median_result$target[[5L]],
  (.Machine$double.xmax / 2) + ((.Machine$double.xmax - (.Machine$double.xmax / 2)) / 2),
  "an even grouped float median did not use the safe same-sign midpoint"
)

grouped_integer <- data.frame(group = c("a", "a", "a", "b", "b"), target = c(1L, 3L, NA_integer_, NA_integer_, NA_integer_))
grouped_integer_result <- openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
  grouped_integer,
  2L,
  "target",
  1L,
  "group",
  "median"
)
assert_identical(
  grouped_integer_result$target,
  c(1L, 3L, 2L, NA_integer_, NA_integer_),
  "grouped integer median did not fill exact groups or leave all-missing groups unresolved"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
    data.frame(group = c("a", "a", "a"), target = c(1L, 2L, NA_integer_)),
    2L,
    "target",
    1L,
    "group",
    "median"
  ),
  "grouped integer median is not an integer"
)

grouped_wide <- data.frame(
  group = c("a", "a", "a"),
  target = bit64::as.integer64(c("9007199254740993", "9007199254740995", NA)),
  check.names = FALSE
)
grouped_wide_result <- openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
  grouped_wide,
  2L,
  "target",
  1L,
  "group",
  "median"
)
assert_identical(
  as.character(grouped_wide_result$target),
  c("9007199254740993", "9007199254740995", "9007199254740994"),
  "grouped integer64 median lost precision"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
    data.frame(group = c("a", "a", "a"), target = bit64::as.integer64(c("1", "2", NA))),
    2L,
    "target",
    1L,
    "group",
    "median"
  ),
  "integer64 median is not an integer"
)

grouped_wide_keys <- data.frame(
  group = bit64::as.integer64(c(
    "9007199254740993", "9007199254740993", "9007199254740994", "9007199254740994"
  )),
  target = c(10, NA, 20, NA),
  check.names = FALSE
)
grouped_wide_keys_result <- openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
  grouped_wide_keys,
  2L,
  "target",
  1L,
  "group",
  "mean"
)
assert_identical(
  grouped_wide_keys_result$target,
  c(10, 10, 20, 20),
  "grouped fill collapsed distinct integer64 keys"
)

grouped_mode <- data.frame(
  group = c("a", "a", "a", "b", "b", "b", "c"),
  target = factor(c("x", "x", NA, "x", "y", NA, NA), levels = c("x", "y", "unused")),
  check.names = FALSE
)
grouped_mode_result <- openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
  grouped_mode,
  2L,
  "target",
  1L,
  "group",
  "mostFrequent"
)
assert_identical(
  as.character(grouped_mode_result$target),
  c("x", "x", "x", "x", "y", NA_character_, NA_character_),
  "grouped mode filled a tied or all-missing group"
)
assert_identical(levels(grouped_mode_result$target), levels(grouped_mode$target), "grouped mode changed factor levels")

grouped_table <- data.table::data.table(group = c("a", "a", "b"), target = c(1, NA, NA))
data.table::setkey(grouped_table, group)
grouped_table_before <- data.table::copy(grouped_table)
grouped_table_result <- openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
  grouped_table,
  2L,
  "target",
  1L,
  "group",
  "mean"
)
assert_identical(class(grouped_table_result), c("data.table", "data.frame"), "grouped fill changed data.table flavor")
assert_identical(data.table::key(grouped_table_result), "group", "grouped fill dropped a compatible data.table key")
assert_identical(grouped_table_result$target, c(1, 1, NA_real_), "grouped fill changed keyed data.table values")
assert_identical(grouped_table, grouped_table_before, "grouped fill mutated its source data.table")

grouped_collapse <- collapse::qTBL(data.frame(group = c("a", "a", "b"), target = c(TRUE, NA, NA)))
grouped_collapse_result <- openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(
  grouped_collapse,
  2L,
  "target",
  1L,
  "group",
  "mostFrequent"
)
assert_identical(class(grouped_collapse_result), class(grouped_collapse), "grouped fill changed collapse frame flavor")
assert_identical(grouped_collapse_result$target, c(TRUE, TRUE, NA), "grouped fill changed collapse values")

cast_cases <- list(
  list(
    dtype = "string",
    input = factor(c("BETA", NA, "ALPHA"), levels = c("ALPHA", "BETA")),
    expected = c("BETA", NA_character_, "ALPHA")
  ),
  list(
    dtype = "integer",
    input = c("1.9", "-2.9", "2147483648", "bad"),
    expected = c(1L, -2L, NA_integer_, NA_integer_)
  ),
  list(
    dtype = "float",
    input = c("1.5", "Inf", "NaN", "bad"),
    expected = c(1.5, Inf, NaN, NA_real_)
  ),
  list(
    dtype = "boolean",
    input = factor(c("TRUE", "false", "T", "not-a-bool")),
    expected = c(TRUE, FALSE, TRUE, NA)
  ),
  list(
    dtype = "date",
    input = c("2026-01-02", "2026/01/03", "2026-02-30", NA_character_),
    expected = as.Date(c("2026-01-02", NA, NA, NA))
  ),
  list(
    dtype = "datetime",
    input = c("2026-01-02", "2026-01-02 03:04:05.125", "bad", NA_character_),
    expected = as.POSIXct(
      c("2026-01-02 00:00:00", "2026-01-02 03:04:05.125", NA, NA),
      tz = "UTC"
    )
  )
)

for (case in cast_cases) {
  source <- data.frame(value = case$input, check.names = FALSE)
  source_before <- unserialize(serialize(source, NULL, version = 3L))
  source_capture <- openwrangler_r_frame_contract$capture_frame(source)
  result <- openwrangler_r_frame_contract$cast_column(
    source,
    list(id = "r:c:0", name = "value"),
    case$dtype
  )
  result_capture <- openwrangler_r_frame_contract$capture_frame(
    result,
    nullability_source = source_capture,
    source_positions = 1L,
    cast_positions = 1L,
    cast_dtypes = case$dtype
  )
  assert_identical(result[[1L]], case$expected, sprintf("castColumn returned the wrong %s values", case$dtype))
  assert_identical(
    result_capture$descriptor$schema[[1L]]$id,
    "r:c:0",
    sprintf("castColumn changed the stable %s identity", case$dtype)
  )
  assert_identical(
    result_capture$descriptor$schema[[1L]]$nullable,
    source_capture$descriptor$schema[[1L]]$nullable || anyNA(case$expected),
    sprintf("castColumn returned the wrong %s nullability", case$dtype)
  )
  assert_identical(source, source_before, sprintf("castColumn mutated its %s source", case$dtype))
}

cast_nonnullable_source <- data.frame(value = c("1", "2"), check.names = FALSE)
cast_nonnullable_capture <- openwrangler_r_frame_contract$capture_frame(cast_nonnullable_source)
cast_nonnullable_result <- openwrangler_r_frame_contract$cast_column(
  cast_nonnullable_source,
  list(id = "r:c:0", name = "value"),
  "integer"
)
cast_nonnullable_result_capture <- openwrangler_r_frame_contract$capture_frame(
  cast_nonnullable_result,
  nullability_source = cast_nonnullable_capture,
  source_positions = 1L,
  cast_positions = 1L,
  cast_dtypes = "integer"
)
assert_identical(
  cast_nonnullable_result_capture$descriptor$schema[[1L]]$nullable,
  FALSE,
  "a valid non-nullable cast became nullable"
)
cast_nonnullable_result$value[[1L]] <- 99L
assert_identical(cast_nonnullable_source$value[[1L]], "1", "a cast result shared storage with its source")

cast_datetime_source <- data.frame(
  instant = as.POSIXct(c("2026-01-02 03:04:05", NA), tz = "Europe/Berlin"),
  check.names = FALSE
)
cast_datetime_string <- openwrangler_r_frame_contract$cast_column(
  cast_datetime_source,
  list(id = "r:c:0", name = "instant"),
  "string"
)
assert_identical(
  cast_datetime_string$instant,
  c("2026-01-02T02:04:05.000000Z", NA_character_),
  "castColumn did not format POSIXct values as explicit UTC ISO text"
)

cast_ancient_text <- data.frame(
  date = c("2024-02-29", "0001-01-01", "0000-01-01"),
  datetime = c("2024-02-29T12:00:00Z", "0001-01-01T00:00:00Z", "0000-01-01T00:00:00Z"),
  check.names = FALSE
)
cast_ancient_date <- openwrangler_r_frame_contract$cast_column(
  cast_ancient_text,
  list(id = "r:c:0", name = "date"),
  "date"
)
cast_ancient_datetime <- openwrangler_r_frame_contract$cast_column(
  cast_ancient_text,
  list(id = "r:c:1", name = "datetime"),
  "datetime"
)
assert_identical(
  cast_ancient_date$date,
  as.Date(c("2024-02-29", NA, NA)),
  "castColumn created a Date that the page contract cannot encode"
)
assert_identical(
  cast_ancient_datetime$datetime,
  as.POSIXct(c("2024-02-29 12:00:00", NA, NA), tz = "UTC"),
  "castColumn created a POSIXct value that the page contract cannot encode"
)
invisible(openwrangler_r_frame_contract$capture_frame(cast_ancient_date))
invisible(openwrangler_r_frame_contract$capture_frame(cast_ancient_datetime))

cast_ancient_posix <- data.frame(
  instant = as.POSIXct(c("2024-02-29 12:00:00", "0001-01-01 00:00:00"), tz = "UTC"),
  check.names = FALSE
)
cast_ancient_posix_date <- openwrangler_r_frame_contract$cast_column(
  cast_ancient_posix,
  list(id = "r:c:0", name = "instant"),
  "date"
)
assert_identical(
  cast_ancient_posix_date$instant,
  as.Date(c("2024-02-29", NA)),
  "POSIXct-to-Date cast created a value that the page contract cannot encode"
)
invisible(openwrangler_r_frame_contract$capture_frame(cast_ancient_posix_date))

cast_wide <- data.frame(
  wide = bit64::as.integer64(c("9223372036854775806", "-9223372036854775807", NA)),
  check.names = FALSE
)
cast_wide_before <- unserialize(serialize(cast_wide, NULL, version = 3L))
cast_wide_integer <- openwrangler_r_frame_contract$cast_column(
  cast_wide,
  list(id = "r:c:0", name = "wide"),
  "integer"
)
cast_wide_string <- openwrangler_r_frame_contract$cast_column(
  cast_wide,
  list(id = "r:c:0", name = "wide"),
  "string"
)
assert_identical(cast_wide_integer$wide, cast_wide$wide, "integer64 cast to integer lost precision")
assert_identical(
  cast_wide_string$wide,
  c("9223372036854775806", "-9223372036854775807", NA_character_),
  "integer64 cast to string lost precision"
)
for (dtype in c("float", "boolean", "date", "datetime")) {
  assert_error(
    openwrangler_r_frame_contract$cast_column(
      cast_wide,
      list(id = "r:c:0", name = "wide"),
      dtype
    ),
    "castColumn cannot convert"
  )
}
assert_identical(cast_wide, cast_wide_before, "failed integer64 casts mutated their source")

cast_matrix_sources <- list(
  logical = c(TRUE, FALSE, NA),
  integer = c(1L, 0L, NA_integer_),
  double = c(1.5, 0, NA_real_),
  character = c("1", "TRUE", "2026-01-02"),
  factor = factor(c("1", "TRUE", "2026-01-02")),
  date = as.Date(c("2026-01-01", "2026-01-02", NA)),
  datetime = as.POSIXct(c("2026-01-01", "2026-01-02", NA), tz = "Europe/Berlin"),
  difftime = as.difftime(c(1, 0, NA), units = "hours"),
  integer64 = bit64::as.integer64(c("1", "0", NA))
)
cast_source_matrix <- list(
  string = names(cast_matrix_sources),
  integer = c("logical", "integer", "double", "character", "factor", "integer64"),
  float = c("logical", "integer", "double", "character", "factor"),
  boolean = c("logical", "integer", "double", "character", "factor"),
  date = c("character", "factor", "date", "datetime"),
  datetime = c("character", "factor", "date", "datetime")
)
for (dtype in names(cast_source_matrix)) {
  for (source_kind in names(cast_matrix_sources)) {
    source <- data.frame(value = cast_matrix_sources[[source_kind]], check.names = FALSE)
    expression <- quote(openwrangler_r_frame_contract$cast_column(
      source,
      list(id = "r:c:0", name = "value"),
      dtype
    ))
    if (source_kind %in% cast_source_matrix[[dtype]]) {
      result <- eval(expression)
      assert_true(is.data.frame(result), sprintf("%s to %s cast did not return a dataframe", source_kind, dtype))
    } else {
      assert_error(eval(expression), "castColumn cannot convert")
    }
  }
}

cast_tibble <- tibble::tibble(id = 1:3, value = factor(c("1.9", "bad", NA)))
cast_tibble_before <- unserialize(serialize(cast_tibble, NULL, version = 3L))
cast_tibble_result <- openwrangler_r_frame_contract$cast_column(
  cast_tibble,
  list(id = "r:c:1", name = "value"),
  "integer"
)
assert_identical(class(cast_tibble_result), c("tbl_df", "tbl", "data.frame"), "castColumn changed tibble class")
assert_identical(cast_tibble_result$value, c(1L, NA_integer_, NA_integer_), "tibble cast used factor codes")
assert_identical(cast_tibble, cast_tibble_before, "castColumn mutated its source tibble")

cast_table <- data.table::data.table(
  primary_key = c(2L, 1L),
  value = c("2.9", "bad"),
  row_marker = c("row-b", "row-a")
)
data.table::setkey(cast_table, primary_key)
cast_table_before <- data.table::copy(cast_table)
cast_table_result <- openwrangler_r_frame_contract$cast_column(
  cast_table,
  list(id = "r:c:1", name = "value"),
  "integer"
)
assert_identical(data.table::key(cast_table_result), "primary_key", "castColumn changed a retained data.table key")
assert_identical(cast_table_result$row_marker, cast_table_before$row_marker, "castColumn changed data.table row order")
assert_identical(cast_table_result$value, c(NA_integer_, 2L), "castColumn changed non-key data.table values")
assert_error(
  openwrangler_r_frame_contract$cast_column(
    cast_table,
    list(id = "r:c:0", name = "primary_key"),
    "string"
  ),
  "clone the column before casting it"
)
assert_identical(cast_table, cast_table_before, "castColumn mutated its source data.table")

assert_error(
  openwrangler_r_frame_contract$cast_column(
    data.frame(value = 1L),
    list(id = "r:c:0", name = "value"),
    "decimal"
  ),
  "dtype must be one of"
)
assert_error(
  openwrangler_r_frame_contract$cast_column(
    data.frame(value = 1L),
    list(id = "r:c:0", name = "wrong"),
    "float"
  ),
  "stale-column"
)

drop_frame <- data.frame(
  duplicate = c(1L, 2L),
  duplicate = c(3L, 4L),
  `non syntactic` = as.Date(c("2026-02-01", "2026-02-02")),
  keep = c("alpha", NA_character_),
  check.names = FALSE,
  row.names = c("row-a", "row-b")
)
drop_before <- unserialize(serialize(drop_frame, NULL, version = 3L))
drop_capture <- openwrangler_r_frame_contract$capture_frame(drop_frame)
dropped_frame <- openwrangler_r_frame_contract$drop_columns(
  drop_frame,
  list(list(id = "r:c:1", name = "duplicate"))
)
dropped_capture <- openwrangler_r_frame_contract$capture_frame(
  dropped_frame,
  nullability_source = drop_capture,
  source_positions = c(1L, 3L, 4L)
)
assert_identical(class(dropped_frame), "data.frame", "dropping changed the base data.frame class")
assert_identical(
  names(dropped_frame),
  c("duplicate", "non syntactic", "keep"),
  "dropping did not target the exact duplicate column"
)
assert_identical(row.names(dropped_frame), row.names(drop_frame), "dropping changed explicit row names")
assert_identical(
  attributes(dropped_frame[[2L]]),
  attributes(drop_frame[[3L]]),
  "dropping changed retained column attributes"
)
assert_identical(
  vapply(dropped_capture$descriptor$schema, `[[`, character(1L), "id"),
  c("r:c:0", "r:c:2", "r:c:3"),
  "dropping renumbered retained column identities"
)
assert_identical(
  vapply(dropped_capture$descriptor$schema, `[[`, integer(1L), "position"),
  0:2,
  "dropping did not reindex public column positions"
)
assert_identical(
  vapply(dropped_capture$descriptor$schema, `[[`, logical(1L), "nullable"),
  vapply(drop_capture$descriptor$schema[c(1L, 3L, 4L)], `[[`, logical(1L), "nullable"),
  "dropping changed retained nullability"
)
assert_identical(drop_frame, drop_before, "dropping mutated the source data.frame")
dropped_frame[[1L]][1L] <- 99L
assert_identical(drop_frame[[1L]][1L], 1L, "the dropped data.frame shared column storage with its source")

kept_duplicates <- openwrangler_r_frame_contract$drop_columns(
  drop_frame,
  list(list(id = "r:c:2", name = "non syntactic"))
)
assert_identical(
  names(kept_duplicates),
  c("duplicate", "duplicate", "keep"),
  "dropping repaired surviving duplicate names"
)

drop_tibble <- tibble::as_tibble(drop_frame, .name_repair = "minimal")
drop_tibble_before <- unserialize(serialize(drop_tibble, NULL, version = 3L))
dropped_tibble <- openwrangler_r_frame_contract$drop_columns(
  drop_tibble,
  list(list(id = "r:c:1", name = "duplicate"))
)
assert_identical(
  class(dropped_tibble),
  c("tbl_df", "tbl", "data.frame"),
  "dropping changed the tibble class"
)
assert_identical(
  names(dropped_tibble),
  c("duplicate", "non syntactic", "keep"),
  "tibble dropping did not target the exact duplicate column"
)
assert_identical(drop_tibble, drop_tibble_before, "dropping mutated the source tibble")

drop_table <- data.table::data.table(k1 = c(1L, 1L), k2 = c(1L, 2L), value = c("a", "b"), other = 3:4)
data.table::setkey(drop_table, k1, k2)
drop_table_before <- data.table::copy(drop_table)
drop_table_capture <- openwrangler_r_frame_contract$capture_frame(drop_table)
drop_table_non_key <- openwrangler_r_frame_contract$drop_columns(
  drop_table,
  list(list(id = "r:c:3", name = "other"))
)
drop_table_non_key_capture <- openwrangler_r_frame_contract$capture_frame(
  drop_table_non_key,
  nullability_source = drop_table_capture,
  source_positions = c(1L, 2L, 3L)
)
assert_identical(data.table::key(drop_table_non_key), c("k1", "k2"), "dropping a non-key changed the data.table key")
assert_identical(
  drop_table_non_key_capture$descriptor$frameSemantics$keyColumnIds,
  I(c("r:c:0", "r:c:1")),
  "dropping a non-key changed stable data.table key identities"
)
drop_table_trailing_key <- openwrangler_r_frame_contract$drop_columns(
  drop_table,
  list(list(id = "r:c:1", name = "k2"))
)
drop_table_trailing_capture <- openwrangler_r_frame_contract$capture_frame(
  drop_table_trailing_key,
  nullability_source = drop_table_capture,
  source_positions = c(1L, 3L, 4L)
)
assert_identical(data.table::key(drop_table_trailing_key), "k1", "dropping a trailing key did not retain its key prefix")
assert_identical(
  drop_table_trailing_capture$descriptor$frameSemantics$keyColumnIds,
  I("r:c:0"),
  "dropping a trailing key changed the retained key identity"
)
drop_table_leading_key <- openwrangler_r_frame_contract$drop_columns(
  drop_table,
  list(list(id = "r:c:0", name = "k1"))
)
assert_identical(data.table::key(drop_table_leading_key), NULL, "dropping the first key did not clear the data.table key")
assert_true(identical(drop_table, drop_table_before), "dropping mutated the source data.table")

assert_error(
  openwrangler_r_frame_contract$drop_columns(
    drop_frame,
    list(list(id = "r:c:1", name = "duplicate"), list(id = "r:c:1", name = "duplicate"))
  ),
  "column_references may address each column only once"
)
assert_error(
  openwrangler_r_frame_contract$drop_columns(drop_frame, list(list(id = "r:c:99", name = "duplicate"))),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$drop_columns(drop_frame, list(list(id = "r:c:0", name = "wrong"))),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$drop_columns(
    drop_frame,
    lapply(seq_len(ncol(drop_frame)), function(position) {
      list(id = sprintf("r:c:%d", position - 1L), name = names(drop_frame)[[position]])
    })
  ),
  "dropColumns must leave at least one visible column"
)
assert_identical(drop_frame, drop_before, "a failed drop mutated its source")

select_frame <- data.frame(
  duplicate = c(1L, 2L),
  duplicate = c(3L, 4L),
  `non syntactic` = as.Date(c("2026-04-01", "2026-04-02")),
  keep = c("alpha", NA_character_),
  remove = c(TRUE, FALSE),
  check.names = FALSE,
  row.names = c("row-a", "row-b")
)
select_before <- unserialize(serialize(select_frame, NULL, version = 3L))
select_capture <- openwrangler_r_frame_contract$capture_frame(select_frame)
select_references <- list(
  list(id = "r:c:3", name = "keep"),
  list(id = "r:c:1", name = "duplicate"),
  list(id = "r:c:0", name = "duplicate"),
  list(id = "r:c:2", name = "non syntactic")
)
selected_frame <- openwrangler_r_frame_contract$select_columns(select_frame, select_references)
selected_capture <- openwrangler_r_frame_contract$capture_frame(
  selected_frame,
  nullability_source = select_capture,
  source_positions = c(4L, 2L, 1L, 3L)
)
assert_identical(class(selected_frame), "data.frame", "selecting changed the base data.frame class")
assert_identical(
  names(selected_frame),
  c("keep", "duplicate", "duplicate", "non syntactic"),
  "selecting did not retain user order and exact names"
)
assert_identical(row.names(selected_frame), row.names(select_frame), "selecting changed explicit row names")
assert_identical(
  attributes(selected_frame[[4L]]),
  attributes(select_frame[[3L]]),
  "selecting changed retained column attributes"
)
assert_identical(
  vapply(selected_capture$descriptor$schema, `[[`, character(1L), "id"),
  c("r:c:3", "r:c:1", "r:c:0", "r:c:2"),
  "selecting renumbered retained column identities"
)
assert_identical(
  vapply(selected_capture$descriptor$schema, `[[`, integer(1L), "position"),
  0:3,
  "selecting did not reindex public column positions"
)
assert_identical(
  vapply(selected_capture$descriptor$schema, `[[`, logical(1L), "nullable"),
  vapply(select_capture$descriptor$schema[c(4L, 2L, 1L, 3L)], `[[`, logical(1L), "nullable"),
  "selecting changed retained nullability"
)
assert_identical(select_frame, select_before, "selecting mutated the source data.frame")
selected_frame[[1L]][1L] <- "changed"
assert_identical(select_frame, select_before, "the selected data.frame shared storage with its source")

select_tibble <- tibble::as_tibble(select_frame, .name_repair = "minimal")
select_tibble_before <- unserialize(serialize(select_tibble, NULL, version = 3L))
selected_tibble <- openwrangler_r_frame_contract$select_columns(select_tibble, select_references)
assert_identical(
  class(selected_tibble),
  c("tbl_df", "tbl", "data.frame"),
  "selecting changed the tibble class"
)
assert_identical(
  names(selected_tibble),
  c("keep", "duplicate", "duplicate", "non syntactic"),
  "tibble selection repaired duplicate or non-syntactic names"
)
assert_identical(select_tibble, select_tibble_before, "selecting mutated the source tibble")

select_table <- data.table::data.table(k1 = c(1L, 1L), k2 = c(1L, 2L), value = c("a", "b"), other = 3:4)
data.table::setkey(select_table, k1, k2)
select_table_before <- data.table::copy(select_table)
select_table_capture <- openwrangler_r_frame_contract$capture_frame(select_table)
select_table_full_key <- openwrangler_r_frame_contract$select_columns(
  select_table,
  list(
    list(id = "r:c:3", name = "other"),
    list(id = "r:c:1", name = "k2"),
    list(id = "r:c:0", name = "k1")
  )
)
select_table_full_capture <- openwrangler_r_frame_contract$capture_frame(
  select_table_full_key,
  nullability_source = select_table_capture,
  source_positions = c(4L, 2L, 1L)
)
assert_identical(names(select_table_full_key), c("other", "k2", "k1"), "data.table selection lost user order")
assert_identical(
  data.table::key(select_table_full_key),
  c("k1", "k2"),
  "selecting both key columns did not retain the data.table key"
)
assert_identical(
  select_table_full_capture$descriptor$frameSemantics$keyColumnIds,
  I(c("r:c:0", "r:c:1")),
  "selecting reordered columns changed stable data.table key identities"
)
select_table_prefix <- openwrangler_r_frame_contract$select_columns(
  select_table,
  list(list(id = "r:c:3", name = "other"), list(id = "r:c:0", name = "k1"))
)
assert_identical(data.table::key(select_table_prefix), "k1", "selecting a key prefix did not retain it")
select_table_without_prefix <- openwrangler_r_frame_contract$select_columns(
  select_table,
  list(list(id = "r:c:1", name = "k2"), list(id = "r:c:3", name = "other"))
)
assert_identical(data.table::key(select_table_without_prefix), NULL, "selecting without the first key retained a stale key")
assert_identical(select_table, select_table_before, "selecting mutated the source data.table")
select_table_full_key[, other := 99L]
assert_identical(select_table, select_table_before, "the selected data.table shared storage with its source")

assert_error(
  openwrangler_r_frame_contract$select_columns(
    select_frame,
    list(list(id = "r:c:0", name = "duplicate"), list(id = "r:c:0", name = "duplicate"))
  ),
  "column_references may address each column only once"
)
assert_error(
  openwrangler_r_frame_contract$select_columns(select_frame, list(list(id = "r:c:99", name = "duplicate"))),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$select_columns(select_frame, list(list(id = "r:c:0", name = "wrong"))),
  "stale-column"
)
assert_error(openwrangler_r_frame_contract$select_columns(select_frame, list()), "non-empty unnamed list")
assert_error(
  openwrangler_r_frame_contract$select_columns(
    select_frame,
    list(named = list(id = "r:c:0", name = "duplicate"))
  ),
  "non-empty unnamed list"
)
private_select_frame <- data.frame(
  `__OPEN_WRANGLER_INTERNAL_ROW_ID_user` = 1L,
  public = 2L,
  check.names = FALSE
)
assert_error(
  openwrangler_r_frame_contract$select_columns(
    private_select_frame,
    list(list(id = "r:c:0", name = "__OPEN_WRANGLER_INTERNAL_ROW_ID_user"))
  ),
  "reserved-column-name"
)
assert_error(
  openwrangler_r_frame_contract$drop_columns(
    private_select_frame,
    list(list(id = "r:c:0", name = "__OPEN_WRANGLER_INTERNAL_ROW_ID_user"))
  ),
  "reserved-column-name"
)
assert_identical(select_frame, select_before, "a failed selection mutated its source")

collision_frame <- data.frame(first = 1L, second = 2L)
assert_error(
  openwrangler_r_frame_contract$rename_column(
    collision_frame,
    list(id = "r:c:0", name = "first"),
    "second"
  ),
  "column-name-collision"
)
assert_error(
  openwrangler_r_frame_contract$rename_column(
    collision_frame,
    list(id = "r:c:0", name = "first"),
    ""
  ),
  "invalid-column-name"
)
assert_error(
  openwrangler_r_frame_contract$rename_column(
    collision_frame,
    list(id = "r:c:99", name = "first"),
    "renamed"
  ),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$rename_column(
    collision_frame,
    list(id = "r:c:0", name = "second"),
    "renamed"
  ),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$rename_column(
    collision_frame,
    list(id = "r:c:0", name = "first"),
    "__OPEN_WRANGLER_INTERNAL_ROW_ID_user"
  ),
  "reserved-column-name"
)
private_frame <- data.frame(
  `__open_wrangler_internal_row_id_source` = 1L,
  check.names = FALSE
)
assert_error(
  openwrangler_r_frame_contract$rename_column(
    private_frame,
    list(id = "r:c:0", name = "__open_wrangler_internal_row_id_source"),
    "public"
  ),
  "reserved-column-name"
)
assert_identical(collision_frame, data.frame(first = 1L, second = 2L), "a failed rename mutated its source")

profile_reference <- function(capture, position) {
  schema <- capture$descriptor$schema[[position]]
  list(id = schema$id, name = schema$name)
}

profile_source_before <- unserialize(serialize(base_frame, NULL, version = 3L))
base_summaries <- openwrangler_r_frame_contract$materialize_summaries(
  base_capture,
  lapply(seq_len(ncol(base_frame)), function(position) profile_reference(base_capture, position))
)
assert_identical(
  vapply(base_summaries, `[[`, character(1L), "columnId"),
  sprintf("r:c:%d", 0:9),
  "R profiles did not preserve stable positional column identities"
)
assert_identical(base_summaries[[1L]]$visualization$trueCount, 1L, "logical TRUE counts changed")
assert_identical(base_summaries[[1L]]$visualization$falseCount, 1L, "logical FALSE counts changed")
assert_identical(base_summaries[[3L]]$nullCount, 0L, "double NA was miscounted")
assert_identical(base_summaries[[3L]]$nanCount, 1L, "double NaN was not counted separately")
assert_identical(base_summaries[[4L]]$text$minLength, 4L, "UTF-8 text minimum length changed")
assert_identical(base_summaries[[4L]]$text$maxLength, 5L, "UTF-8 text maximum length changed")
assert_identical(base_summaries[[6L]]$rawType, "ordered factor", "ordered-factor profile metadata changed")
assert_identical(base_summaries[[7L]]$visualization$min, "2026-01-01", "Date profile minimum changed")
assert_identical(base_summaries[[7L]]$visualization$max, "2026-01-03", "Date profile maximum changed")
assert_identical(
  base_summaries[[8L]]$visualization$min,
  "2026-01-01T12:00:00.000000",
  "POSIXct profile minimum changed"
)
assert_identical(base_summaries[[9L]]$numeric$min, 1, "difftime profile minimum changed")
assert_identical(base_summaries[[9L]]$numeric$max, 3, "difftime profile maximum changed")
assert_identical(
  base_summaries[[10L]]$numeric$exactMin$raw,
  "-9223372036854775807",
  "integer64 profile minimum lost precision"
)
assert_identical(
  base_summaries[[10L]]$numeric$exactMax$raw,
  "9223372036854775806",
  "integer64 profile maximum lost precision"
)
assert_identical(base_frame, profile_source_before, "profiling mutated the source data.frame")

base_stats_result <- openwrangler_r_frame_contract$materialize_dataset_stats(base_capture)
assert_identical(base_stats_result$totalRows, 3, "dataset statistics lost their row-count binding")
base_stats <- base_stats_result$stats
assert_identical(base_stats$missingCells, 10, "dataset missing-cell count changed")
assert_identical(base_stats$missingRows, 2L, "dataset missing-row count changed")
assert_identical(base_stats$duplicateRows, 0L, "dataset duplicate-row count changed")
assert_identical(
  vapply(base_stats$missingValuesByColumn, `[[`, character(1L), "column"),
  names(base_frame),
  "dataset missing counts lost duplicate or non-syntactic names"
)

tibble_profile <- openwrangler_r_frame_contract$materialize_summaries(
  tibble_capture,
  list(profile_reference(tibble_capture, 4L))
)
assert_identical(tibble_profile[[1L]]$text$minLength, 4L, "tibble profiling changed text semantics")
table_profile <- openwrangler_r_frame_contract$materialize_summaries(
  table_capture,
  list(profile_reference(table_capture, 1L))
)
assert_identical(table_profile[[1L]]$distinctCount, 2L, "data.table profiling changed distinct values")
assert_true(identical(table_frame, table_before), "profiling mutated the source data.table")

empty_profile_frame <- data.frame(
  text = character(),
  amount = double(),
  all_missing = logical()
)
empty_profile_capture <- openwrangler_r_frame_contract$capture_frame(empty_profile_frame)
empty_summaries <- openwrangler_r_frame_contract$materialize_summaries(
  empty_profile_capture,
  lapply(seq_len(ncol(empty_profile_frame)), function(position) profile_reference(empty_profile_capture, position))
)
assert_identical(empty_summaries[[1L]]$text, list(emptyCount = 0L), "empty text profile invented bounds")
assert_identical(empty_summaries[[2L]]$topValues, I(list()), "empty numeric profile invented values")

duplicate_profile_frame <- data.frame(value = c(1L, 1L, NA_integer_), flag = c(TRUE, TRUE, NA))
duplicate_profile_capture <- openwrangler_r_frame_contract$capture_frame(duplicate_profile_frame)
duplicate_profile_stats <- openwrangler_r_frame_contract$materialize_dataset_stats(duplicate_profile_capture)$stats
assert_identical(duplicate_profile_stats$missingCells, 2, "all-null counts changed")
assert_identical(duplicate_profile_stats$missingRows, 1L, "all-null row count changed")
assert_identical(duplicate_profile_stats$duplicateRows, 1L, "duplicate-row count changed")
all_null_capture <- openwrangler_r_frame_contract$capture_frame(data.frame(value = c(NA_character_, NA_character_)))
all_null_summary <- openwrangler_r_frame_contract$materialize_summaries(
  all_null_capture,
  list(profile_reference(all_null_capture, 1L))
)[[1L]]
assert_identical(all_null_summary$nullCount, 2L, "all-null column count changed")
assert_identical(all_null_summary$distinctCount, 0L, "all-null column invented a distinct value")
assert_identical(all_null_summary$text, list(emptyCount = 0L), "all-null text profile invented length bounds")
bounded_profile_capture <- openwrangler_r_frame_contract$capture_frame(data.frame(value = seq_len(40L)))
bounded_profile <- openwrangler_r_frame_contract$materialize_summaries(
  bounded_profile_capture,
  list(profile_reference(bounded_profile_capture, 1L))
)[[1L]]
assert_identical(length(bounded_profile$topValues), 10L, "R profiles exceeded the top-value limit")
assert_identical(length(bounded_profile$visualization$bins), 20L, "R profiles exceeded the histogram-bin limit")
extreme_profile_capture <- openwrangler_r_frame_contract$capture_frame(
  data.frame(value = c(-1e308, 0, 1e308))
)
extreme_profile <- openwrangler_r_frame_contract$materialize_summaries(
  extreme_profile_capture,
  list(profile_reference(extreme_profile_capture, 1L))
)[[1L]]
assert_identical(length(extreme_profile$visualization$bins), 3L, "an extreme finite range lost its histogram")
assert_identical(
  sum(vapply(extreme_profile$visualization$bins, `[[`, integer(1L), "count")),
  3L,
  "an extreme finite histogram lost values"
)
too_wide_profile_frame <- as.data.frame(
  setNames(rep(list(1L), openwrangler_r_frame_contract$limits$profileColumns + 1L),
           sprintf("profile_%d", seq_len(openwrangler_r_frame_contract$limits$profileColumns + 1L))),
  optional = TRUE
)
too_wide_profile_capture <- openwrangler_r_frame_contract$capture_frame(too_wide_profile_frame)
assert_error(
  openwrangler_r_frame_contract$materialize_summaries(
    too_wide_profile_capture,
    lapply(seq_len(ncol(too_wide_profile_frame)), function(position) {
      profile_reference(too_wide_profile_capture, position)
    })
  ),
  "profile-too-large"
)
work_column_count <- 51L
work_row_count <- openwrangler_r_frame_contract$limits$profileSampleRows + 17L
shared_work_column <- rep(TRUE, work_row_count)
bounded_work_frame <- structure(
  c(
    list(number = as.double(seq_len(work_row_count)), category = rep(c("alpha", "beta"), length.out = work_row_count)),
    setNames(rep(list(shared_work_column), work_column_count - 2L), sprintf("work_%d", seq_len(work_column_count - 2L)))
  ),
  class = "data.frame",
  row.names = c(NA_integer_, -work_row_count)
)
bounded_work_capture <- openwrangler_r_frame_contract$capture_live_frame(function() bounded_work_frame)
bounded_work_references <- lapply(
  seq_len(work_column_count),
  function(position) profile_reference(bounded_work_capture, position)
)
bounded_work_summaries <- openwrangler_r_frame_contract$materialize_summaries(
  bounded_work_capture,
  bounded_work_references
)
assert_identical(length(bounded_work_summaries), work_column_count, "a profile above the former cell cap was refused")
assert_identical(bounded_work_summaries[[1L]]$totalCount, as.double(work_row_count), "large profile row count changed")
assert_identical(bounded_work_summaries[[1L]]$numeric$min, 1, "large numeric minimum was not exact")
assert_identical(
  bounded_work_summaries[[1L]]$numeric$max,
  as.double(work_row_count),
  "large numeric maximum was not exact"
)
assert_true(is.null(bounded_work_summaries[[1L]]$numeric$median), "a sampled profile mislabeled its median as exact")
assert_true(is.null(bounded_work_summaries[[1L]]$distinctCount), "a sampled profile invented an exact distinct count")
assert_identical(bounded_work_summaries[[1L]]$visualization$sampled, TRUE, "large histogram lacked a sample label")
assert_identical(
  sum(vapply(bounded_work_summaries[[1L]]$visualization$bins, `[[`, integer(1L), "count")),
  openwrangler_r_frame_contract$limits$profileSampleRows,
  "large histogram exceeded its sample"
)
assert_identical(bounded_work_summaries[[2L]]$text$minLength, 4L, "large exact text minimum changed")
assert_identical(bounded_work_summaries[[2L]]$text$maxLength, 5L, "large exact text maximum changed")
assert_identical(
  bounded_work_summaries[[2L]]$visualization$sampled,
  TRUE,
  "large categorical distribution lacked a sample label"
)
assert_identical(
  bounded_work_summaries[[3L]]$visualization$trueCount,
  work_row_count,
  "cheap large boolean counts were sampled"
)
assert_true(
  is.null(bounded_work_summaries[[3L]]$visualization$sampled),
  "an exact large boolean distribution was labeled sampled"
)
bounded_work_stats <- openwrangler_r_frame_contract$materialize_dataset_stats(bounded_work_capture)$stats
expected_duplicate_sample <- as.integer(floor(
  openwrangler_r_frame_contract$limits$datasetDuplicateSampleCells / work_column_count
))
assert_identical(bounded_work_stats$missingCells, 0, "large dataset missing cells were not exact")
assert_identical(bounded_work_stats$missingRows, 0L, "large dataset missing rows were not exact")
assert_identical(bounded_work_stats$duplicateRows, 0L, "large sampled duplicate rows changed")
assert_identical(
  bounded_work_stats$duplicateRowsSampleSize,
  expected_duplicate_sample,
  "large dataset duplicate sample ignored its cell budget"
)

periodic_row_count <- 150001L
periodic_periods <- c(2L, 3L, 5L, 7L)
periodic_frame <- structure(
  setNames(
    lapply(periodic_periods, function(period) rep(sprintf("value_%d", seq_len(period)), length.out = periodic_row_count)),
    sprintf("period_%d", periodic_periods)
  ),
  class = "data.frame",
  row.names = c(NA_integer_, -periodic_row_count)
)
periodic_capture <- openwrangler_r_frame_contract$capture_live_frame(function() periodic_frame)
invisible(local({
  sampler <- get(
    "deterministic_sample_positions",
    envir = environment(openwrangler_r_frame_contract$materialize_summaries),
    inherits = FALSE
  )
  previous_rng_kind <- RNGkind()
  had_random_seed <- exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  if (had_random_seed) previous_random_seed <- get(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  on.exit({
    suppressWarnings(do.call(RNGkind, as.list(previous_rng_kind)))
    if (had_random_seed) {
      assign(".Random.seed", previous_random_seed, envir = .GlobalEnv)
    } else if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) {
      rm(".Random.seed", envir = .GlobalEnv)
    }
  })

  suppressWarnings(RNGkind(kind = "L'Ecuyer-CMRG", normal.kind = "Box-Muller", sample.kind = "Rounding"))
  set.seed(937L)
  expected_rng_kind <- RNGkind()
  expected_random_seed <- .Random.seed
  maximum_positions <- sampler(.Machine$integer.max, openwrangler_r_frame_contract$limits$profileSampleRows)
  repeated_positions <- sampler(.Machine$integer.max, openwrangler_r_frame_contract$limits$profileSampleRows)
  assert_identical(RNGkind(), expected_rng_kind, "profile sampling changed a non-default R RNG kind")
  assert_identical(.Random.seed, expected_random_seed, "profile sampling changed a non-default R random seed")
  assert_identical(repeated_positions, maximum_positions, "profile sampling was not deterministic at the R row limit")
  assert_identical(
    length(maximum_positions),
    openwrangler_r_frame_contract$limits$profileSampleRows,
    "profile sampling changed size at the R row limit"
  )
  assert_true(
    all(diff(maximum_positions) > 0) && maximum_positions[[1L]] >= 1 &&
      maximum_positions[[length(maximum_positions)]] <= .Machine$integer.max,
    "profile sampling returned duplicate or out-of-range positions at the R row limit"
  )

  rm(".Random.seed", envir = .GlobalEnv)
  invisible(sampler(.Machine$integer.max, openwrangler_r_frame_contract$limits$profileSampleRows))
  assert_true(
    !exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE),
    "profile sampling created a user-visible R random seed"
  )
}))
set.seed(937L)
expected_random_value <- stats::runif(1L)
set.seed(937L)
periodic_summaries <- openwrangler_r_frame_contract$materialize_summaries(
  periodic_capture,
  lapply(seq_along(periodic_periods), function(position) profile_reference(periodic_capture, position))
)
assert_identical(stats::runif(1L), expected_random_value, "profile sampling changed the user's R random state")
for (index in seq_along(periodic_periods)) {
  period <- periodic_periods[[index]]
  counts <- vapply(periodic_summaries[[index]]$visualization$categories, `[[`, integer(1L), "count")
  expected_count <- openwrangler_r_frame_contract$limits$profileSampleRows / period
  assert_identical(
    sum(counts),
    openwrangler_r_frame_contract$limits$profileSampleRows,
    sprintf("the period-%d profile sample changed size", period)
  )
  assert_true(
    length(counts) == period && max(abs(counts - expected_count)) <= ceiling(expected_count * 0.03),
    sprintf("deterministic profile sampling aliased a period-%d column", period)
  )
}
periodic_stats <- openwrangler_r_frame_contract$materialize_dataset_stats(periodic_capture)$stats
assert_identical(
  periodic_stats$duplicateRowsSampleSize,
  openwrangler_r_frame_contract$limits$datasetDuplicateSampleRows,
  "periodic duplicate detection ignored its sample limit"
)
assert_identical(
  periodic_stats$duplicateRows,
  as.integer(openwrangler_r_frame_contract$limits$datasetDuplicateSampleRows - prod(periodic_periods)),
  "deterministic duplicate sampling aliased short-period columns"
)

former_row_limit <- 1000000L + 1L
too_tall_frame <- structure(
  list(value = rep(FALSE, former_row_limit)),
  class = "data.frame",
  row.names = c(NA_integer_, -former_row_limit)
)
too_tall_capture <- openwrangler_r_frame_contract$capture_live_frame(function() too_tall_frame)
too_tall_summary <- openwrangler_r_frame_contract$materialize_summaries(
  too_tall_capture,
  list(profile_reference(too_tall_capture, 1L))
)[[1L]]
assert_identical(too_tall_summary$totalCount, as.double(former_row_limit), "the former R profile row cap remained")
assert_identical(too_tall_summary$visualization$falseCount, former_row_limit, "large exact boolean count changed")
too_tall_stats <- openwrangler_r_frame_contract$materialize_dataset_stats(too_tall_capture)$stats
assert_identical(
  too_tall_stats$duplicateRowsSampleSize,
  openwrangler_r_frame_contract$limits$datasetDuplicateSampleRows,
  "large duplicate detection did not publish its row sample"
)
assert_identical(
  too_tall_stats$duplicateRows,
  openwrangler_r_frame_contract$limits$datasetDuplicateSampleRows - 1L,
  "large duplicate sample count changed"
)
value_boundary_row_count <- openwrangler_r_frame_contract$limits$profileSampleRows
value_boundary_frame <- data.frame(value = rep(TRUE, value_boundary_row_count))
value_boundary_capture <- openwrangler_r_frame_contract$capture_live_frame(function() value_boundary_frame)
value_boundary_discovery <- openwrangler_r_frame_contract$materialize_column_values(
  value_boundary_capture,
  profile_reference(value_boundary_capture, 1L)
)
assert_true(is.null(value_boundary_discovery$sampleSize), "the exact value-discovery boundary was sampled")
assert_identical(value_boundary_discovery$hasMore, FALSE, "the exact value-discovery boundary claimed truncation")
assert_identical(
  value_boundary_discovery$values[[1L]]$count,
  value_boundary_row_count,
  "the exact value-discovery boundary changed its count"
)
too_tall_values <- openwrangler_r_frame_contract$materialize_column_values(
  too_tall_capture,
  profile_reference(too_tall_capture, 1L)
)
assert_identical(
  too_tall_values$sampleSize,
  openwrangler_r_frame_contract$limits$profileSampleRows,
  "large initial value discovery did not publish its sample size"
)
assert_identical(too_tall_values$hasMore, TRUE, "large initial value discovery claimed to be exhaustive")
assert_identical(too_tall_values$values[[1L]]$value, "FALSE", "large initial value discovery changed its value")
assert_identical(
  too_tall_values$values[[1L]]$count,
  openwrangler_r_frame_contract$limits$profileSampleRows,
  "large initial value discovery counted outside its sample"
)
too_tall_search <- openwrangler_r_frame_contract$materialize_column_values(
  too_tall_capture,
  profile_reference(too_tall_capture, 1L),
  search = "false"
)
assert_true(is.null(too_tall_search$sampleSize), "an explicit large value search was labeled as sampled")
assert_identical(too_tall_search$hasMore, FALSE, "a complete large value search claimed truncation")
assert_identical(too_tall_search$values[[1L]]$value, "FALSE", "large exact value search changed its match")
assert_identical(
  too_tall_search$values[[1L]]$count,
  former_row_limit,
  "large exact value search did not count every matching row"
)

large_value_row_count <- 4000001L
large_value_frame <- data.frame(value = rep(c(TRUE, FALSE), length.out = large_value_row_count))
large_value_capture <- openwrangler_r_frame_contract$capture_live_frame(function() large_value_frame)
large_value_discovery <- openwrangler_r_frame_contract$materialize_column_values(
  large_value_capture,
  profile_reference(large_value_capture, 1L)
)
assert_identical(
  large_value_discovery$sampleSize,
  openwrangler_r_frame_contract$limits$profileSampleRows,
  "four-million-row value discovery exceeded its bounded sample"
)
assert_identical(
  sort(vapply(large_value_discovery$values, `[[`, character(1L), "value")),
  c("FALSE", "TRUE"),
  "four-million-row value discovery aliased an alternating column"
)
assert_identical(
  sum(vapply(large_value_discovery$values, `[[`, integer(1L), "count")),
  openwrangler_r_frame_contract$limits$profileSampleRows,
  "four-million-row value discovery counted outside its sample"
)
profile_metrics <- openwrangler_r_frame_contract$capture_metrics(base_capture)
assert_identical(profile_metrics$profileColumns, 10, "projected profile work scanned the wrong number of columns")
assert_identical(profile_metrics$datasetProfiles, 1, "dataset profiling ran an unexpected number of times")

sort_rule <- function(id, name, direction = "asc", nulls = "last") {
  list(column = list(id = id, name = name), direction = direction, nulls = nulls)
}

view_query <- function(filters = list(), sorts = list(), logic = NULL) {
  query <- list(filters = filters, sorts = sorts)
  if (!is.null(logic)) query$logic <- logic
  query
}

predicate <- function(operator, value = NULL, second_value = NULL) {
  result <- list(kind = "predicate", operator = operator)
  if (!is.null(value)) result$value <- value
  if (!is.null(second_value)) result$secondValue <- second_value
  result
}

column_filter <- function(id, name, type, predicates = list(), value_filter = NULL, logic = NULL) {
  result <- list(column = list(id = id, name = name), type = type, predicates = predicates)
  if (!is.null(value_filter)) result$valueFilter <- value_filter
  if (!is.null(logic)) result$logic <- logic
  result
}

filter_frame <- data.frame(
  text = c("Alpha", "beta", "Alpha", "CAFÉ", "alpha", NA_character_),
  amount = c(NA_real_, NaN, Inf, -Inf, 5.5, 5.5),
  wide = bit64::as.integer64(c(
    "-9223372036854775807", "0", "9223372036854775806", "10", "-10", "9007199254740993"
  )),
  date = as.Date(c("2026-01-01", "2026-01-02", "2026-01-03", NA, "2026-01-05", "2026-01-06")),
  when = as.POSIXct(
    c("2026-01-01 00:00:00", "2026-01-02 01:00:00", "2026-01-03 02:00:00", NA,
      "2026-01-05 04:00:00", "2026-01-06 05:00:00"),
    tz = "UTC"
  ),
  elapsed = as.difftime(c(1, 2, 3, NA, 5, 6), units = "hours"),
  flag = c(TRUE, FALSE, NA, TRUE, FALSE, TRUE),
  row.names = paste0("label-", seq_len(6L)),
  stringsAsFactors = FALSE
)
filter_before <- unserialize(serialize(filter_frame, NULL, version = 3L))
filter_capture <- openwrangler_r_frame_contract$capture_frame(filter_frame)

text_contains <- view_query(filters = list(column_filter(
  "r:c:0", "text", "string", list(predicate("contains", "ALP"))
)))
text_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  text_contains,
  row_limit = 10L,
  column_limit = 7L
)
assert_identical(text_page$page$totalRows, 3L, "ASCII-folded text filtering returned the wrong row count")
assert_identical(
  vapply(text_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:0", "r:r:2", "r:r:4"),
  "filtered pages lost stable source row identities"
)
assert_identical(
  vapply(text_page$page$rows, `[[`, character(1L), "rowLabel"),
  c("label-1", "label-3", "label-5"),
  "filtered pages lost explicit source row labels"
)
assert_identical(
  vapply(text_page$page$rows, `[[`, integer(1L), "rowNumber"),
  0:2,
  "filtered pages did not use logical row numbers"
)

null_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(filters = list(column_filter("r:c:1", "amount", "float", list(predicate("isNull"))))),
  column_limit = 7L
)
nan_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(filters = list(column_filter("r:c:1", "amount", "float", list(predicate("isNaN"))))),
  column_limit = 7L
)
assert_identical(null_page$page$rows[[1L]]$id, "r:r:0", "float NA was not filtered as null")
assert_identical(nan_page$page$rows[[1L]]$id, "r:r:1", "float NaN was not filtered separately from NA")

or_value_filter <- list(
  kind = "values",
  selectedValues = list(5.5),
  includeNulls = FALSE,
  includeNaN = FALSE
)
or_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(filters = list(column_filter(
    "r:c:1",
    "amount",
    "float",
    predicates = list(predicate("isNaN")),
    value_filter = or_value_filter,
    logic = "or"
  ))),
  column_limit = 7L
)
assert_identical(
  vapply(or_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:1", "r:r:4", "r:r:5"),
  "OR logic within one R column filter changed"
)

outer_or_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(
    filters = list(
      column_filter("r:c:0", "text", "string", list(predicate("equals", "beta"))),
      column_filter("r:c:6", "flag", "boolean", list(predicate("equals", TRUE)))
    ),
    logic = "or"
  ),
  column_limit = 7L
)
assert_identical(
  vapply(outer_or_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:0", "r:r:1", "r:r:3", "r:r:5"),
  "OR logic across R column filters changed"
)

wide_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(filters = list(column_filter(
    "r:c:2", "wide", "integer", list(predicate("gt", "9007199254740992"))
  ))),
  column_limit = 7L
)
assert_identical(
  vapply(wide_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:2", "r:r:5"),
  "integer64 filtering lost precision"
)

date_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(filters = list(column_filter(
    "r:c:3", "date", "date", list(predicate("between", "2026-01-02", "2026-01-05"))
  ))),
  column_limit = 7L
)
assert_identical(
  vapply(date_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:1", "r:r:2", "r:r:4"),
  "Date filtering changed inclusive bounds"
)

datetime_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(filters = list(column_filter(
    "r:c:4", "when", "datetime", list(predicate("gte", "2026-01-03T02:00:00Z"))
  ))),
  column_limit = 7L
)
assert_identical(
  vapply(datetime_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:2", "r:r:4", "r:r:5"),
  "POSIXct filtering changed absolute timestamps"
)
datetime_offset_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(filters = list(column_filter(
    "r:c:4", "when", "datetime", list(predicate("equals", "2026-01-03T04:00+02:00"))
  ))),
  column_limit = 7L
)
assert_identical(
  datetime_offset_page$page$rows[[1L]]$id,
  "r:r:2",
  "POSIXct filtering did not normalize an offset datetime without seconds"
)

duration_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(filters = list(column_filter(
    "r:c:5", "elapsed", "duration", list(predicate("between", "7200", "18000"))
  ))),
  column_limit = 7L
)
assert_identical(
  vapply(duration_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:1", "r:r:2", "r:r:4"),
  "difftime filtering did not interpret public values as seconds"
)

literal_contract <- jsonlite::fromJSON("fixtures/view-literal-contract.json", simplifyVector = FALSE)
literal_frame <- data.frame(
  date = as.Date("2024-01-01"),
  datetime = as.POSIXct("2024-01-01 00:00:00", tz = "UTC"),
  duration = as.difftime(0, units = "secs")
)
literal_capture <- openwrangler_r_frame_contract$capture_frame(literal_frame)
literal_columns <- list(
  date = list(id = "r:c:0", name = "date"),
  datetime = list(id = "r:c:1", name = "datetime"),
  duration = list(id = "r:c:2", name = "duration")
)
materialize_literal <- function(case) {
  column <- literal_columns[[case$type]]
  openwrangler_r_frame_contract$materialize_view_page(
    literal_capture,
    view_query(filters = list(column_filter(
      column$id,
      column$name,
      case$type,
      list(predicate("gte", case$value))
    ))),
    row_limit = 1L,
    column_limit = 3L
  )
}
for (case in literal_contract$accepted) {
  if (case$type %in% names(literal_columns)) {
    materialize_literal(case)
  }
}
for (case in literal_contract$rejected) {
  if (case$type %in% names(literal_columns)) {
    assert_error(materialize_literal(case), "invalid-view-value")
  }
}

signed_zero_capture <- openwrangler_r_frame_contract$capture_frame(data.frame(value = c(-0, 0, 1)))
signed_zero_values <- openwrangler_r_frame_contract$materialize_column_values(
  signed_zero_capture,
  list(id = "r:c:0", name = "value"),
  limit = 10L
)
zero_value_index <- match("0", vapply(signed_zero_values$values, `[[`, character(1L), "value"))
assert_true(!is.na(zero_value_index), "column values omitted the grouped zero value")
zero_value <- signed_zero_values$values[[zero_value_index]]
assert_identical(zero_value$count, 2L, "column values did not group signed zero")
assert_identical(zero_value$selectionValue$cell$raw, 0, "the grouped zero token retained a negative sign")
signed_zero_page <- openwrangler_r_frame_contract$materialize_view_page(
  signed_zero_capture,
  view_query(filters = list(column_filter(
    "r:c:0",
    "value",
    "float",
    value_filter = list(
      kind = "values",
      selectedValues = list(zero_value$selectionValue),
      includeNulls = FALSE,
      includeNaN = FALSE
    )
  ))),
  column_limit = 1L
)
assert_identical(
  vapply(signed_zero_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:0", "r:r:1"),
  "the grouped zero token did not select both signed zeros"
)

numeric_value_capture <- openwrangler_r_frame_contract$capture_frame(data.frame(score = c(1200, 8, 7)))
numeric_values <- openwrangler_r_frame_contract$materialize_column_values(
  numeric_value_capture,
  list(id = "r:c:0", name = "score"),
  search = "1200",
  limit = 10L
)
assert_identical(length(numeric_values$values), 1L, "numeric column-value search returned the wrong result count")
numeric_selection <- numeric_values$values[[1L]]$selectionValue
assert_identical(
  numeric_selection$cell$raw,
  1200,
  "finite numeric selections did not use a JSON-compatible numeric raw value"
)
numeric_selection_page <- openwrangler_r_frame_contract$materialize_view_page(
  numeric_value_capture,
  view_query(filters = list(column_filter(
    "r:c:0",
    "score",
    "float",
    value_filter = list(
      kind = "values",
      selectedValues = list(numeric_selection),
      includeNulls = FALSE,
      includeNaN = FALSE
    )
  ))),
  column_limit = 1L
)
assert_identical(
  vapply(numeric_selection_page$page$rows, `[[`, character(1L), "id"),
  "r:r:0",
  "finite numeric selections did not round-trip through a view filter"
)

amount_values <- openwrangler_r_frame_contract$materialize_column_values(
  filter_capture,
  list(id = "r:c:1", name = "amount"),
  limit = 10L
)
assert_identical(
  vapply(amount_values$values, `[[`, character(1L), "value"),
  c("5.5", "-Inf", "Inf"),
  "column values were not deterministically ordered by count and display"
)
assert_identical(
  vapply(amount_values$values, `[[`, integer(1L), "count"),
  c(2L, 1L, 1L),
  "column-value counts changed"
)
limited_amount_values <- openwrangler_r_frame_contract$materialize_column_values(
  filter_capture,
  list(id = "r:c:1", name = "amount"),
  limit = 2L
)
assert_identical(limited_amount_values$hasMore, TRUE, "bounded column values did not report truncation")
positive_infinity <- amount_values$values[[3L]]$selectionValue
infinity_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  view_query(filters = list(column_filter(
    "r:c:1",
    "amount",
    "float",
    value_filter = list(
      kind = "values",
      selectedValues = list(positive_infinity),
      includeNulls = FALSE,
      includeNaN = FALSE
    )
  ))),
  column_limit = 7L
)
assert_identical(infinity_page$page$rows[[1L]]$id, "r:r:2", "typed Infinity selection did not round-trip")

assert_typed_selection_round_trip <- function(column_id, column_name, column_type, display, expected_row_id) {
  values <- openwrangler_r_frame_contract$materialize_column_values(
    filter_capture,
    list(id = column_id, name = column_name),
    limit = 10L
  )
  match_index <- match(display, vapply(values$values, `[[`, character(1L), "value"))
  assert_true(!is.na(match_index), sprintf("column values did not contain %s", display))
  page <- openwrangler_r_frame_contract$materialize_view_page(
    filter_capture,
    view_query(filters = list(column_filter(
      column_id,
      column_name,
      column_type,
      value_filter = list(
        kind = "values",
        selectedValues = list(values$values[[match_index]]$selectionValue),
        includeNulls = FALSE,
        includeNaN = FALSE
      )
    ))),
    column_limit = 7L
  )
  assert_identical(
    vapply(page$page$rows, `[[`, character(1L), "id"),
    expected_row_id,
    sprintf("typed %s selection did not round-trip", column_type)
  )
}

assert_typed_selection_round_trip("r:c:2", "wide", "integer", "9223372036854775806", "r:r:2")
assert_typed_selection_round_trip("r:c:3", "date", "date", "2026-01-03", "r:r:2")
assert_typed_selection_round_trip(
  "r:c:4",
  "when",
  "datetime",
  "2026-01-03T02:00:00.000000",
  "r:r:2"
)
assert_typed_selection_round_trip("r:c:5", "elapsed", "duration", "3 hours", "r:r:2")

searched_values <- openwrangler_r_frame_contract$materialize_column_values(
  filter_capture,
  list(id = "r:c:0", name = "text"),
  search = "ALP",
  limit = 2L
)
assert_identical(
  vapply(searched_values$values, `[[`, character(1L), "value"),
  c("Alpha", "alpha"),
  "column-value search did not use portable ASCII folding"
)
assert_identical(searched_values$hasMore, FALSE, "column-value search reported a false truncation")
assert_true(is.null(searched_values$sampleSize), "an exact column-value search was labeled sampled")

combined_view <- view_query(
  filters = list(
    column_filter("r:c:0", "text", "string", list(predicate("contains", "alp"))),
    column_filter("r:c:6", "flag", "boolean", list(predicate("equals", TRUE)))
  ),
  sorts = list(sort_rule("r:c:2", "wide", "desc", "last"))
)
combined_page <- openwrangler_r_frame_contract$materialize_view_page(
  filter_capture,
  combined_view,
  row_limit = 10L,
  column_limit = 7L
)
assert_identical(
  vapply(combined_page$page$rows, `[[`, character(1L), "id"),
  "r:r:0",
  "compound filtering or post-filter sorting changed the visible rows"
)
filtered_summary <- openwrangler_r_frame_contract$materialize_summaries(
  filter_capture,
  list(profile_reference(filter_capture, 1L)),
  text_contains
)[[1L]]
assert_identical(filtered_summary$totalCount, 3L, "column profiles ignored the current filter")
filtered_stats_result <- openwrangler_r_frame_contract$materialize_dataset_stats(filter_capture, text_contains)
assert_identical(filtered_stats_result$totalRows, 3, "filtered dataset statistics lost their view row count")
filtered_stats <- filtered_stats_result$stats
assert_identical(filtered_stats$missingCells, 2, "dataset statistics ignored filtered rows")
assert_identical(filtered_stats$missingRows, 2L, "filtered missing-row counts changed")
assert_identical(filter_frame, filter_before, "native R viewing filters mutated the source dataframe")

table_filter_page <- openwrangler_r_frame_contract$materialize_view_page(
  table_capture,
  view_query(filters = list(column_filter(
    "r:c:0", "primary_key", "integer", list(predicate("gt", 1L))
  ))),
  column_limit = 2L
)
assert_identical(table_filter_page$page$rows[[1L]]$id, "r:r:1", "data.table filtering lost its source row ID")
assert_true(identical(table_frame, table_before), "view filtering mutated the source data.table")

sort_frame <- data.frame(
  group = c("b", "a", "a", "b", NA, "a", "a"),
  score = c(2, 1, 1, 1, 9, NA, NaN),
  marker = seq_len(7L),
  stringsAsFactors = FALSE
)
sort_capture <- openwrangler_r_frame_contract$capture_frame(sort_frame)
sort_page <- openwrangler_r_frame_contract$materialize_view_page(
  sort_capture,
  view_query = view_query(sorts = list(
      sort_rule("r:c:0", "group", "asc", "last"),
      sort_rule("r:c:1", "score", "desc", "first")
    )),
  row_limit = 7L,
  column_limit = 3L
)
assert_identical(
  vapply(sort_page$page$rows, `[[`, integer(1L), "rowNumber"),
  0:6,
  "sorted row numbers did not describe the logical view order"
)
assert_identical(
  vapply(sort_page$page$rows, `[[`, character(1L), "id"),
  sprintf("r:r:%d", c(5L, 6L, 1L, 2L, 0L, 3L, 4L)),
  "sorted pages did not preserve source row identities"
)
assert_identical(sort_frame$marker, seq_len(7L), "view sorting mutated the source frame")

duplicate_sort_frame <- data.frame(
  duplicate = c(1L, 2L),
  duplicate = c("z", "a"),
  check.names = FALSE
)
duplicate_sort_capture <- openwrangler_r_frame_contract$capture_frame(duplicate_sort_frame)
duplicate_sort_page <- openwrangler_r_frame_contract$materialize_view_page(
  duplicate_sort_capture,
  view_query(sorts = list(sort_rule("r:c:1", "duplicate"))),
  row_limit = 2L,
  column_limit = 2L
)
assert_identical(
  vapply(duplicate_sort_page$page$rows, `[[`, integer(1L), "rowNumber"),
  0:1,
  "duplicate-name sorting did not retain logical row numbers"
)
assert_identical(
  vapply(duplicate_sort_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:1", "r:r:0"),
  "a duplicate column name was not resolved by positional ID"
)

committed_row_frame <- data.frame(
  duplicate = c("b", "a", "a", "b", NA, "a", "a"),
  duplicate = c(2, 1, 1, 1, 9, NA, NaN),
  `non syntactic` = seq_len(7L),
  check.names = FALSE,
  stringsAsFactors = FALSE
)
committed_row_before <- unserialize(serialize(committed_row_frame, NULL, version = 3L))
committed_row_capture <- openwrangler_r_frame_contract$capture_frame(committed_row_frame)
committed_sort <- openwrangler_r_frame_contract$transform_rows(
  committed_row_capture,
  view_query(sorts = list(
    sort_rule("r:c:0", "duplicate", "asc", "last"),
    sort_rule("r:c:1", "duplicate", "desc", "first")
  ))
)
assert_identical(
  committed_sort$sourcePositions,
  c(6L, 7L, 2L, 3L, 1L, 4L, 5L),
  "committed multi-sort changed priority, missing placement, or stable ties"
)
assert_identical(
  committed_sort$frame[[3L]],
  c(6L, 7L, 2L, 3L, 1L, 4L, 5L),
  "committed multi-sort returned the wrong rows"
)
assert_identical(
  names(committed_sort$frame),
  c("duplicate", "duplicate", "non syntactic"),
  "committed sorting repaired duplicate or non-syntactic names"
)
committed_sort_capture <- openwrangler_r_frame_contract$capture_frame(
  committed_sort$frame,
  nullability_source = committed_row_capture,
  source_row_positions = committed_sort$sourcePositions
)
committed_sort_page <- openwrangler_r_frame_contract$materialize_page(
  committed_sort_capture,
  row_limit = 7L,
  column_limit = 3L
)
assert_identical(
  vapply(committed_sort_page$page$rows, `[[`, character(1L), "id"),
  sprintf("r:r:%d", c(5L, 6L, 1L, 2L, 0L, 3L, 4L)),
  "committed sorting regenerated row identities from output positions"
)
assert_identical(
  committed_sort_capture$descriptor$shape$rows,
  7L,
  "committed sorting changed the source row-identity domain"
)
assert_identical(committed_row_frame, committed_row_before, "committed sorting mutated its source dataframe")

committed_filter_model <- view_query(filters = list(column_filter(
  "r:c:0",
  "duplicate",
  "string",
  value_filter = list(
    kind = "values",
    selectedValues = list("a"),
    includeNulls = FALSE,
    includeNaN = FALSE
  )
)))
committed_filter <- openwrangler_r_frame_contract$transform_rows(
  committed_row_capture,
  committed_filter_model
)
assert_identical(
  committed_filter$sourcePositions,
  c(2L, 3L, 6L, 7L),
  "committed filtering changed non-float includeNaN=FALSE semantics"
)
committed_filter_capture <- openwrangler_r_frame_contract$capture_frame(
  committed_filter$frame,
  nullability_source = committed_row_capture,
  source_row_positions = committed_filter$sourcePositions
)
committed_filter_page <- openwrangler_r_frame_contract$materialize_page(
  committed_filter_capture,
  row_limit = 4L,
  column_limit = 3L
)
assert_identical(
  vapply(committed_filter_page$page$rows, `[[`, character(1L), "id"),
  sprintf("r:r:%d", c(1L, 2L, 5L, 6L)),
  "committed filtering regenerated surviving row identities"
)

empty_named_frame <- data.frame(value = 1:2, row.names = c("named-a", "named-b"))
empty_named_capture <- openwrangler_r_frame_contract$capture_frame(empty_named_frame)
empty_named_filter <- openwrangler_r_frame_contract$transform_rows(
  empty_named_capture,
  view_query(filters = list(column_filter(
    "r:c:0", "value", "integer", list(predicate("gt", 99L))
  )))
)
assert_identical(empty_named_filter$sourcePositions, integer(), "the empty R filter retained source rows")
empty_named_derived <- openwrangler_r_frame_contract$capture_frame(
  empty_named_filter$frame,
  nullability_source = empty_named_capture,
  source_row_positions = empty_named_filter$sourcePositions
)
assert_identical(
  empty_named_derived$descriptor$frameSemantics$rowNames,
  "explicit",
  "an empty derived frame lost the source explicit-row-name contract"
)
empty_named_page <- openwrangler_r_frame_contract$materialize_page(
  empty_named_derived,
  row_limit = 2L,
  column_limit = 1L
)
assert_identical(empty_named_page$page$totalRows, 0L, "the empty derived frame reported source rows")
assert_identical(empty_named_page$page$rows, I(list()), "the empty derived frame returned row payloads")
nonempty_automatic_rows <- data.frame(value = 1:2)
nonempty_mismatched_capture <- openwrangler_r_frame_contract$capture_frame(
  nonempty_automatic_rows,
  nullability_source = empty_named_capture,
  source_row_positions = 1:2
)
assert_identical(
  nonempty_mismatched_capture$descriptor$frameSemantics$rowNames,
  "positional",
  "derived row-name preservation was incorrectly extended to a non-empty frame"
)

committed_null <- openwrangler_r_frame_contract$transform_rows(
  committed_row_capture,
  view_query(filters = list(column_filter(
    "r:c:1", "duplicate", "float", list(predicate("isNull"))
  )))
)
committed_nan <- openwrangler_r_frame_contract$transform_rows(
  committed_row_capture,
  view_query(filters = list(column_filter(
    "r:c:1", "duplicate", "float", list(predicate("isNaN"))
  )))
)
assert_identical(committed_null$sourcePositions, 6L, "committed filtering did not keep float NA separate")
assert_identical(committed_nan$sourcePositions, 7L, "committed filtering did not keep float NaN separate")

committed_tibble <- tibble::as_tibble(committed_row_frame, .name_repair = "minimal")
committed_tibble_before <- unserialize(serialize(committed_tibble, NULL, version = 3L))
committed_tibble_filter <- openwrangler_r_frame_contract$transform_rows(
  openwrangler_r_frame_contract$capture_frame(committed_tibble),
  committed_filter_model
)
assert_identical(
  class(committed_tibble_filter$frame),
  c("tbl_df", "tbl", "data.frame"),
  "committed filtering changed the tibble class"
)
assert_identical(committed_tibble, committed_tibble_before, "committed filtering mutated its source tibble")

committed_table <- data.table::data.table(
  primary_key = c(1L, 1L, 2L, 2L),
  secondary_key = c(1L, 2L, 1L, 2L),
  score = c(2, NA, 3, 1)
)
data.table::setkey(committed_table, primary_key, secondary_key)
committed_table_before <- data.table::copy(committed_table)
committed_table_capture <- openwrangler_r_frame_contract$capture_frame(committed_table)
committed_table_filter <- openwrangler_r_frame_contract$transform_rows(
  committed_table_capture,
  view_query(filters = list(column_filter(
    "r:c:0", "primary_key", "integer", list(predicate("equals", 1L))
  )))
)
assert_identical(
  data.table::key(committed_table_filter$frame),
  c("primary_key", "secondary_key"),
  "committed filtering discarded a still-valid data.table key"
)
committed_table_sort <- openwrangler_r_frame_contract$transform_rows(
  committed_table_capture,
  view_query(sorts = list(sort_rule("r:c:2", "score", "desc", "last")))
)
assert_identical(data.table::key(committed_table_sort$frame), NULL, "committed sorting retained a stale data.table key")
assert_identical(
  committed_table_sort$sourcePositions,
  c(3L, 1L, 4L, 2L),
  "committed data.table sorting changed row order or missing placement"
)
assert_true(identical(committed_table, committed_table_before), "committed row operations mutated the source data.table")

row_reduction_frame <- data.frame(
  duplicate = c("a", "a", "b", "b", "c", NA, NA, "z"),
  duplicate = c(1, 1, NA, NA, 3, NA, NaN, Inf),
  `non syntactic` = seq_len(8L),
  row.names = paste0("source-", seq_len(8L)),
  check.names = FALSE,
  stringsAsFactors = FALSE
)
row_reduction_before <- unserialize(serialize(row_reduction_frame, NULL, version = 3L))
row_reduction_positions <- c(1L, 2L)
row_reduction_names <- c("duplicate", "duplicate")
drop_missing_any <- openwrangler_r_frame_contract$drop_missing_rows_at(
  row_reduction_frame,
  row_reduction_positions,
  row_reduction_names,
  "any"
)
assert_identical(
  drop_missing_any$sourcePositions,
  c(1L, 2L, 5L, 8L),
  "Drop Missing Rows any mode did not treat both NA and NaN as missing"
)
assert_identical(
  row.names(drop_missing_any$frame),
  paste0("source-", c(1L, 2L, 5L, 8L)),
  "Drop Missing Rows changed explicit row names"
)
assert_identical(
  names(drop_missing_any$frame),
  c("duplicate", "duplicate", "non syntactic"),
  "Drop Missing Rows repaired duplicate or non-syntactic names"
)
drop_missing_all <- openwrangler_r_frame_contract$drop_missing_rows_at(
  row_reduction_frame,
  row_reduction_positions,
  row_reduction_names,
  "all"
)
assert_identical(
  drop_missing_all$sourcePositions,
  c(1L, 2L, 3L, 4L, 5L, 8L),
  "Drop Missing Rows all mode did not require every selected value to be missing"
)

drop_duplicate_first <- openwrangler_r_frame_contract$drop_duplicate_rows_at(
  row_reduction_frame,
  row_reduction_positions,
  row_reduction_names,
  "first"
)
drop_duplicate_last <- openwrangler_r_frame_contract$drop_duplicate_rows_at(
  row_reduction_frame,
  row_reduction_positions,
  row_reduction_names,
  "last"
)
drop_duplicate_none <- openwrangler_r_frame_contract$drop_duplicate_rows_at(
  row_reduction_frame,
  row_reduction_positions,
  row_reduction_names,
  "none"
)
assert_identical(
  drop_duplicate_first$sourcePositions,
  c(1L, 3L, 5L, 6L, 7L, 8L),
  "Drop Duplicates first mode changed native NA/NaN equality or source order"
)
assert_identical(
  drop_duplicate_last$sourcePositions,
  c(2L, 4L, 5L, 6L, 7L, 8L),
  "Drop Duplicates last mode changed native NA/NaN equality or source order"
)
assert_identical(
  drop_duplicate_none$sourcePositions,
  c(5L, 6L, 7L, 8L),
  "Drop Duplicates none mode retained a repeated row"
)
assert_identical(row_reduction_frame, row_reduction_before, "R row reduction mutated its source dataframe")

drop_duplicate_capture <- openwrangler_r_frame_contract$capture_frame(
  drop_duplicate_first$frame,
  nullability_source = openwrangler_r_frame_contract$capture_frame(row_reduction_frame),
  source_row_positions = drop_duplicate_first$sourcePositions
)
drop_duplicate_page <- openwrangler_r_frame_contract$materialize_page(
  drop_duplicate_capture,
  row_limit = 8L,
  column_limit = 3L
)
assert_identical(
  vapply(drop_duplicate_page$page$rows, `[[`, character(1L), "id"),
  sprintf("r:r:%d", drop_duplicate_first$sourcePositions - 1L),
  "Drop Duplicates regenerated stable source-row identities"
)

row_reduction_tibble <- tibble::as_tibble(row_reduction_frame, .name_repair = "minimal")
row_reduction_tibble_before <- unserialize(serialize(row_reduction_tibble, NULL, version = 3L))
tibble_missing <- openwrangler_r_frame_contract$drop_missing_rows_at(
  row_reduction_tibble,
  row_reduction_positions,
  row_reduction_names,
  "any"
)
tibble_duplicates <- openwrangler_r_frame_contract$drop_duplicate_rows_at(
  row_reduction_tibble,
  row_reduction_positions,
  row_reduction_names,
  "none"
)
assert_identical(class(tibble_missing$frame), c("tbl_df", "tbl", "data.frame"), "Drop Missing Rows changed tibble class")
assert_identical(class(tibble_duplicates$frame), c("tbl_df", "tbl", "data.frame"), "Drop Duplicates changed tibble class")
assert_identical(row_reduction_tibble, row_reduction_tibble_before, "R row reduction mutated its source tibble")

row_reduction_table <- data.table::data.table(
  primary_key = c(1L, 1L, 2L, 2L, 3L),
  payload = c("a", "a", NA, NA, "z")
)
data.table::setkey(row_reduction_table, primary_key)
row_reduction_table_before <- data.table::copy(row_reduction_table)
table_missing <- openwrangler_r_frame_contract$drop_missing_rows_at(
  row_reduction_table,
  2L,
  "payload",
  "any"
)
table_duplicates <- openwrangler_r_frame_contract$drop_duplicate_rows_at(
  row_reduction_table,
  c(1L, 2L),
  c("primary_key", "payload"),
  "first"
)
assert_identical(data.table::key(table_missing$frame), "primary_key", "Drop Missing Rows discarded a compatible data.table key")
assert_identical(data.table::key(table_duplicates$frame), "primary_key", "Drop Duplicates discarded a compatible data.table key")
assert_identical(table_duplicates$sourcePositions, c(1L, 3L, 5L), "Drop Duplicates changed keyed data.table order")
assert_true(identical(row_reduction_table, row_reduction_table_before), "R row reduction mutated its source data.table")

zero_column_rows <- structure(list(), row.names = c(NA_integer_, -3L), class = "data.frame")
names(zero_column_rows) <- character()
zero_column_missing <- openwrangler_r_frame_contract$drop_missing_rows_at(
  zero_column_rows,
  integer(),
  character(),
  "any"
)
zero_column_duplicates <- openwrangler_r_frame_contract$drop_duplicate_rows_at(
  zero_column_rows,
  integer(),
  character(),
  "first"
)
assert_identical(zero_column_missing$sourcePositions, 1:3, "Drop Missing Rows changed a zero-column frame")
assert_identical(zero_column_duplicates$sourcePositions, 1:3, "Drop Duplicates changed a zero-column frame")

empty_named_reduction <- data.frame(value = c(NA_real_, NaN), row.names = c("missing", "nan"))
empty_named_reduction_capture <- openwrangler_r_frame_contract$capture_frame(empty_named_reduction)
empty_named_reduction_result <- openwrangler_r_frame_contract$drop_missing_rows_at(
  empty_named_reduction,
  1L,
  "value",
  "any"
)
empty_named_reduction_derived <- openwrangler_r_frame_contract$capture_frame(
  empty_named_reduction_result$frame,
  nullability_source = empty_named_reduction_capture,
  source_row_positions = empty_named_reduction_result$sourcePositions
)
assert_identical(
  empty_named_reduction_derived$descriptor$frameSemantics$rowNames,
  "explicit",
  "an empty row-reduction result lost explicit row-name semantics"
)
assert_error(
  openwrangler_r_frame_contract$drop_missing_rows_at(row_reduction_frame, 2L, "wrong", "any"),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$drop_duplicate_rows_at(row_reduction_frame, 2L, "duplicate", "invalid"),
  "invalid-view-query"
)

sort_window <- openwrangler_r_frame_contract$materialize_view_page(
  sort_capture,
  view_query = view_query(sorts = list(sort_rule("r:c:0", "group"))),
  row_offset = 1L,
  row_limit = 3L,
  column_offset = 2L,
  column_limit = 1L
)
assert_identical(sort_window$page$offset, 1, "sorted page offset changed")
assert_identical(sort_window$page$columnIds, I("r:c:2"), "sorted page projection changed")
assert_identical(
  vapply(sort_window$page$rows, `[[`, integer(1L), "rowNumber"),
  1:3,
  "sorted pagination did not number the logical page window"
)
assert_identical(
  vapply(sort_window$page$rows, `[[`, character(1L), "id"),
  sprintf("r:r:%d", c(2L, 5L, 6L)),
  "sorted pagination did not slice the logical order"
)

large_row_count <- 250000L
large_source <- new.env(parent = emptyenv())
large_source$frame <- data.frame(
  order_key = rev(seq_len(large_row_count)),
  payload = seq_len(large_row_count),
  bucket = seq_len(large_row_count) %% 17L
)
large_capture <- openwrangler_r_frame_contract$capture_live_frame(function() large_source$frame)
large_open_metrics <- openwrangler_r_frame_contract$capture_metrics(large_capture)
assert_true(is.null(large_capture$snapshot), "a live capture retained an isolated dataframe snapshot")
assert_identical(large_open_metrics$nullableScans, 0, "live capture scanned columns for missing values")
assert_true(
  all(vapply(large_capture$descriptor$schema, `[[`, logical(1L), "nullable")),
  "live capture metadata was not conservatively nullable"
)

large_direct_page <- openwrangler_r_frame_contract$materialize_view_page(
  large_capture,
  row_offset = large_row_count - 5L,
  row_limit = 5L,
  column_offset = 1L,
  column_limit = 2L
)
assert_identical(
  vapply(large_direct_page$page$rows, `[[`, integer(1L), "rowNumber"),
  (large_row_count - 5L):(large_row_count - 1L),
  "a large unsorted page did not slice the requested source rows directly"
)
large_direct_metrics <- openwrangler_r_frame_contract$capture_metrics(large_capture)
assert_identical(large_direct_metrics$directPageSlices, 1, "the unsorted page did not use the direct path")
assert_identical(large_direct_metrics$directRowPositions, 5, "the unsorted page built more than its five rows")
assert_identical(large_direct_metrics$sortOrderBuilds, 0, "the unsorted page built a full row order")
assert_identical(large_direct_metrics$cachedSortRows, 0L, "the unsorted page retained a full row order")

large_sort_ascending <- view_query(sorts = list(sort_rule("r:c:0", "order_key", "asc", "last")))
invisible(openwrangler_r_frame_contract$materialize_view_page(
  large_capture,
  large_sort_ascending,
  row_limit = 4L,
  column_offset = 0L,
  column_limit = 1L
))
invisible(openwrangler_r_frame_contract$materialize_view_page(
  large_capture,
  large_sort_ascending,
  row_limit = 4L,
  column_offset = 1L,
  column_limit = 1L
))
large_cached_metrics <- openwrangler_r_frame_contract$capture_metrics(large_capture)
assert_identical(large_cached_metrics$sortOrderBuilds, 1, "repeated column blocks rebuilt the same sort order")
assert_identical(
  large_cached_metrics$sortOrderRows,
  as.double(large_row_count),
  "the sorted path did not account for exactly one full order"
)
assert_identical(
  large_cached_metrics$cachedSortRows,
  large_row_count,
  "the sorted session did not retain exactly one complete order"
)
assert_identical(large_cached_metrics$cachedSortColumns, 1L, "the live sort cache retained the wrong columns")
assert_identical(large_cached_metrics$sortColumnSnapshots, 1, "the cacheable sort copied its key more than once")
assert_true(
  large_cached_metrics$cachedSortBytes <= openwrangler_r_frame_contract$limits$sortCacheBytes,
  "the live sort cache exceeded its byte limit"
)

cache_key_count <- openwrangler_r_frame_contract$limits$cachedSortColumns + 1L
bounded_cache_source <- new.env(parent = emptyenv())
bounded_cache_source$frame <- as.data.frame(setNames(
  lapply(seq_len(cache_key_count), function(index) rev(seq_len(32L)) + index),
  sprintf("key_%d", seq_len(cache_key_count))
))
bounded_cache_capture <- openwrangler_r_frame_contract$capture_live_frame(function() bounded_cache_source$frame)
bounded_cache_rules <- lapply(seq_len(cache_key_count), function(index) {
  sort_rule(sprintf("r:c:%d", index - 1L), sprintf("key_%d", index), "asc", "last")
})
invisible(openwrangler_r_frame_contract$materialize_view_page(
  bounded_cache_capture,
  view_query(sorts = bounded_cache_rules),
  row_limit = 1L,
  column_limit = 1L
))
bounded_cache_first <- openwrangler_r_frame_contract$capture_metrics(bounded_cache_capture)
assert_identical(bounded_cache_first$cachedSortRows, 0L, "too many sort keys were retained in the cache")
assert_identical(bounded_cache_first$cachedSortColumns, 0L, "an over-limit sort retained key columns")
assert_identical(bounded_cache_first$cachedSortBytes, 0, "an over-limit sort retained cache bytes")
assert_identical(
  bounded_cache_first$sortColumnSnapshots,
  0,
  "an over-limit sort copied key columns before rejecting the cache"
)
invisible(openwrangler_r_frame_contract$materialize_view_page(
  bounded_cache_capture,
  view_query(sorts = bounded_cache_rules),
  row_limit = 1L,
  column_limit = 1L
))
assert_identical(
  openwrangler_r_frame_contract$capture_metrics(bounded_cache_capture)$sortOrderBuilds,
  2,
  "an uncached sort reused a stale order"
)

invisible(openwrangler_r_frame_contract$materialize_view_page(
  large_capture,
  view_query(sorts = list(sort_rule("r:c:0", "order_key", "desc", "last"))),
  row_limit = 1L,
  column_limit = 1L
))
invisible(openwrangler_r_frame_contract$materialize_view_page(
  large_capture,
  large_sort_ascending,
  row_limit = 1L,
  column_limit = 1L
))
large_replaced_metrics <- openwrangler_r_frame_contract$capture_metrics(large_capture)
assert_identical(large_replaced_metrics$sortOrderBuilds, 3, "a changed sort model did not replace the cached order")
assert_identical(large_replaced_metrics$nullableScans, 0, "live pages scanned columns for missing values")
assert_identical(
  large_replaced_metrics$cachedSortRows,
  large_row_count,
  "changing sort priority retained more than the current order"
)

names(large_source$frame)[1L] <- "renamed_order_key"
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(large_capture, row_limit = 1L, column_limit = 1L),
  "source-changed"
)
names(large_source$frame)[1L] <- "order_key"
invisible(openwrangler_r_frame_contract$materialize_view_page(
  large_capture,
  row_limit = 1L,
  column_limit = 1L
))
large_source$frame <- large_source$frame[, c("order_key", "payload"), drop = FALSE]
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(large_capture, row_limit = 1L, column_limit = 1L),
  "source-changed"
)

mutable_source <- new.env(parent = emptyenv())
mutable_source$frame <- data.frame(order_key = c(3L, 1L, 2L), payload = letters[1:3])
mutable_capture <- openwrangler_r_frame_contract$capture_live_frame(function() mutable_source$frame)
mutable_rule <- view_query(sorts = list(sort_rule("r:c:0", "order_key", "asc", "last")))
mutable_first <- openwrangler_r_frame_contract$materialize_view_page(
  mutable_capture,
  mutable_rule,
  row_limit = 3L,
  column_limit = 1L
)
assert_identical(
  vapply(mutable_first$page$rows, function(row) row$values[[1L]]$display, character(1L)),
  c("1", "2", "3"),
  "the initial live sort order was incorrect"
)
mutable_source$frame$order_key <- c(0L, 10L, 5L)
mutable_second <- openwrangler_r_frame_contract$materialize_view_page(
  mutable_capture,
  mutable_rule,
  row_limit = 3L,
  column_limit = 1L
)
assert_identical(
  vapply(mutable_second$page$rows, function(row) row$values[[1L]]$display, character(1L)),
  c("0", "5", "10"),
  "a same-schema source mutation reused a stale sort order"
)
assert_identical(
  openwrangler_r_frame_contract$capture_metrics(mutable_capture)$sortOrderBuilds,
  2,
  "a changed live sort column did not rebuild its cached order"
)
invisible(openwrangler_r_frame_contract$materialize_view_page(
  mutable_capture,
  row_limit = 1L,
  column_limit = 1L
))
assert_identical(
  openwrangler_r_frame_contract$capture_metrics(mutable_capture)$cachedSortRows,
  0L,
  "clearing the live sort retained its row-order cache"
)

mutable_table_source <- new.env(parent = emptyenv())
mutable_table_source$frame <- data.table::data.table(order_key = c(3L, 1L, 2L), payload = letters[1:3])
mutable_table_capture <- openwrangler_r_frame_contract$capture_live_frame(function() mutable_table_source$frame)
invisible(openwrangler_r_frame_contract$materialize_view_page(
  mutable_table_capture,
  mutable_rule,
  row_limit = 3L,
  column_limit = 1L
))
mutable_table_source$frame[1L, order_key := 0L]
mutable_table_page <- openwrangler_r_frame_contract$materialize_view_page(
  mutable_table_capture,
  mutable_rule,
  row_limit = 3L,
  column_limit = 1L
)
assert_identical(
  vapply(mutable_table_page$page$rows, function(row) row$values[[1L]]$display, character(1L)),
  c("0", "1", "2"),
  "a by-reference data.table mutation reused a stale sort order"
)
assert_identical(
  openwrangler_r_frame_contract$capture_metrics(mutable_table_capture)$sortOrderBuilds,
  2,
  "a by-reference data.table mutation did not rebuild its cached order"
)

wide_sort_frame <- data.frame(
  wide = bit64::as.integer64(c(
    "9223372036854775807",
    "-9223372036854775807",
    "0",
    "-10",
    "10",
    "9223372036854775807",
    NA
  ))
)
wide_sort_capture <- openwrangler_r_frame_contract$capture_frame(wide_sort_frame)
wide_sort_ascending <- openwrangler_r_frame_contract$materialize_view_page(
  wide_sort_capture,
  view_query(sorts = list(sort_rule("r:c:0", "wide", "asc", "last"))),
  row_limit = 7L,
  column_limit = 1L
)
assert_identical(
  vapply(wide_sort_ascending$page$rows, `[[`, integer(1L), "rowNumber"),
  0:6,
  "integer64 ascending rows were not numbered in logical order"
)
assert_identical(
  vapply(wide_sort_ascending$page$rows, `[[`, character(1L), "id"),
  sprintf("r:r:%d", c(1L, 3L, 2L, 4L, 0L, 5L, 6L)),
  "integer64 ascending order lost precision or stability"
)
wide_sort_descending <- openwrangler_r_frame_contract$materialize_view_page(
  wide_sort_capture,
  view_query(sorts = list(sort_rule("r:c:0", "wide", "desc", "first"))),
  row_limit = 7L,
  column_limit = 1L
)
assert_identical(
  vapply(wide_sort_descending$page$rows, `[[`, integer(1L), "rowNumber"),
  0:6,
  "integer64 descending rows were not numbered in logical order"
)
assert_identical(
  vapply(wide_sort_descending$page$rows, `[[`, character(1L), "id"),
  sprintf("r:r:%d", c(6L, 0L, 5L, 4L, 2L, 3L, 1L)),
  "integer64 descending order lost precision, null placement, or stability"
)

assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    view_query(sorts = list(sort_rule("r:c:0", "stale name")))
  ),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    view_query(sorts = list(sort_rule("r:c:7", "group")))
  ),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    view_query(sorts = list(sort_rule("r:c:0", "group"), sort_rule("r:c:0", "group", "desc")))
  ),
  "each column only once"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    view_query(sorts = list(sort_rule("r:c:0", "group", "sideways")))
  ),
  "must be one of"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    view_query(sorts = list(c(sort_rule("r:c:0", "group"), list(extra = TRUE))))
  ),
  "missing or unknown fields"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    view_query(sorts = setNames(list(sort_rule("r:c:0", "group")), "named"))
  ),
  "unnamed list"
)

explicit_names <- data.frame(value = c(2L, 1L, 3L), row.names = c("left", "right", "tail"))
explicit_names_capture <- openwrangler_r_frame_contract$capture_frame(explicit_names)
assert_identical(
  explicit_names_capture$descriptor$frameSemantics$rowNames,
  "explicit",
  "explicit row names were not advertised"
)
explicit_names_page <- openwrangler_r_frame_contract$materialize_view_page(
  explicit_names_capture,
  view_query(sorts = list(sort_rule("r:c:0", "value", "asc", "last"))),
  row_offset = 1L,
  row_limit = 2L,
  column_limit = 1L
)
assert_identical(
  vapply(explicit_names_page$page$rows, `[[`, character(1L), "id"),
  c("r:r:0", "r:r:2"),
  "sorted explicit names lost their source row identities"
)
assert_identical(
  vapply(explicit_names_page$page$rows, `[[`, integer(1L), "rowNumber"),
  1:2,
  "sorted explicit names did not use logical row numbers"
)
assert_identical(
  vapply(explicit_names_page$page$rows, `[[`, character(1L), "rowLabel"),
  c("left", "tail"),
  "sorted explicit row labels did not follow their source rows"
)
stopifnot(identical(explicit_names_capture$snapshot$value, c(2L, 1L, 3L)))
numeric_explicit_names <- data.frame(value = 1:2, row.names = c("1", "2"))
numeric_explicit_names_capture <- openwrangler_r_frame_contract$capture_frame(numeric_explicit_names)
assert_identical(
  numeric_explicit_names_capture$descriptor$frameSemantics$rowNames,
  "explicit",
  "numeric-looking explicit row names were mistaken for automatic names"
)
numeric_explicit_names_page <- openwrangler_r_frame_contract$materialize_page(
  numeric_explicit_names_capture,
  row_limit = 2L,
  column_limit = 1L
)
assert_identical(
  vapply(numeric_explicit_names_page$page$rows, `[[`, character(1L), "rowLabel"),
  c("1", "2"),
  "numeric-looking explicit row labels changed"
)

oversized_row_name <- paste(rep("x", openwrangler_r_frame_contract$limits$nameBytes + 1L), collapse = "")
bounded_row_names <- data.frame(value = 1:2, row.names = c("small", oversized_row_name))
bounded_row_names_capture <- openwrangler_r_frame_contract$capture_frame(bounded_row_names)
bounded_row_names_first_page <- openwrangler_r_frame_contract$materialize_page(
  bounded_row_names_capture,
  row_limit = 1L,
  column_limit = 1L
)
assert_identical(
  bounded_row_names_first_page$page$rows[[1L]]$rowLabel,
  "small",
  "an unrequested row label affected a bounded page"
)
assert_error(
  openwrangler_r_frame_contract$materialize_page(
    bounded_row_names_capture,
    row_offset = 1L,
    row_limit = 1L,
    column_limit = 1L
  ),
  "text-too-large"
)

grouped_tibble <- tibble::tibble(value = 1:2)
class(grouped_tibble) <- c("grouped_df", class(grouped_tibble))
assert_error(openwrangler_r_frame_contract$capture_frame(grouped_tibble), "unsupported-frame-class")

collapse_grouped_frame <- collapse::fgroup_by(collapse_source, group)
assert_true(inherits(collapse_grouped_frame, "GRP_df"), "collapse did not create a grouped GRP_df")
assert_error(openwrangler_r_frame_contract$capture_frame(collapse_grouped_frame), "unsupported-frame-class")

collapse_indexed_frame <- collapse::findex_by(collapse_source, group, row_id)
assert_true(inherits(collapse_indexed_frame, "indexed_frame"), "collapse did not create an indexed_frame")
assert_error(openwrangler_r_frame_contract$capture_frame(collapse_indexed_frame), "unsupported-frame-class")

list_frame <- data.frame(value = I(list(1L, 2L)))
assert_error(openwrangler_r_frame_contract$capture_frame(list_frame), "unsupported-column")
matrix_frame <- data.frame(value = I(matrix(1:4, nrow = 2L)))
assert_error(openwrangler_r_frame_contract$capture_frame(matrix_frame), "unsupported-column")
complex_frame <- data.frame(value = I(c(1 + 2i, 3 + 4i)))
assert_error(openwrangler_r_frame_contract$capture_frame(complex_frame), "unsupported-column")

attributed_frame <- data.frame(value = 1:2)
attr(attributed_frame$value, "label") <- "meaning"
assert_error(openwrangler_r_frame_contract$capture_frame(attributed_frame), "unsupported-column-attributes")

malformed_named_column <- 1:2
attr(malformed_named_column, "names") <- structure(c("row-a", "row-b"), class = "AsIs")
malformed_named_frame <- structure(
  list(value = malformed_named_column),
  class = "data.frame",
  row.names = c("row-a", "row-b")
)
assert_error(
  openwrangler_r_frame_contract$capture_frame(malformed_named_frame),
  "unsupported-column-attributes"
)

attributed_frame <- data.frame(value = 1:2)
attr(attributed_frame, "origin") <- "test"
assert_error(openwrangler_r_frame_contract$capture_frame(attributed_frame), "unsupported-frame-attributes")

indexed_table <- data.table::data.table(value = 1:2)
data.table::setindex(indexed_table, value)
assert_error(openwrangler_r_frame_contract$capture_frame(indexed_table), "unsupported-frame-attributes")

invalid_key_table <- data.table::data.table(value = 1:2)
attr(invalid_key_table, "sorted") <- 1L
assert_error(openwrangler_r_frame_contract$capture_frame(invalid_key_table), "unsupported-frame-attributes")

duplicate_levels <- structure(c(1L, 2L), levels = c("same", "same"), class = "factor")
assert_error(openwrangler_r_frame_contract$capture_frame(data.frame(value = duplicate_levels)), "invalid-factor")

malformed_date <- data.frame(value = structure(1L, class = "Date"))
assert_error(openwrangler_r_frame_contract$capture_frame(malformed_date), "unsupported-column-storage")

infinite_datetime <- data.frame(value = structure(Inf, class = c("POSIXct", "POSIXt"), tzone = "UTC"))
infinite_datetime_capture <- openwrangler_r_frame_contract$capture_frame(infinite_datetime)
assert_error(openwrangler_r_frame_contract$materialize_page(infinite_datetime_capture), "unsupported-cell")

classed_nan_values <- list(
  structure(NaN, class = "Date"),
  structure(NaN, class = c("POSIXct", "POSIXt"), tzone = "UTC"),
  structure(NaN, class = "difftime", units = "secs")
)
for (value in classed_nan_values) {
  capture <- openwrangler_r_frame_contract$capture_frame(data.frame(value = value))
  assert_error(openwrangler_r_frame_contract$materialize_page(capture), "classed NaN")
}

fractional_date <- data.frame(value = as.Date("2026-01-01") + 0.5)
fractional_date_capture <- openwrangler_r_frame_contract$capture_frame(fractional_date)
assert_error(openwrangler_r_frame_contract$materialize_page(fractional_date_capture), "fractional Date")

assert_error(
  openwrangler_r_frame_contract$materialize_page(base_capture, row_limit = 1001L),
  "invalid-range"
)
assert_error(
  openwrangler_r_frame_contract$materialize_page(base_capture, column_limit = 257L),
  "invalid-range"
)

too_many_columns <- as.data.frame(
  setNames(rep(list(integer()), openwrangler_r_frame_contract$limits$columns + 1L), NULL),
  optional = TRUE
)
assert_error(openwrangler_r_frame_contract$capture_frame(too_many_columns), "invalid-range")

cell_limit_frame <- as.data.frame(
  setNames(rep(list(rep(1L, 1000L)), 256L), sprintf("column_%d", seq_len(256L))),
  optional = TRUE
)
cell_limit_capture <- openwrangler_r_frame_contract$capture_frame(cell_limit_frame)
assert_error(
  openwrangler_r_frame_contract$materialize_page(
    cell_limit_capture,
    row_limit = 1000L,
    column_limit = 256L
  ),
  "page-too-large"
)

oversized <- data.frame(value = paste(rep("x", openwrangler_r_frame_contract$limits$textBytes + 1L), collapse = ""))
oversized_capture <- openwrangler_r_frame_contract$capture_frame(oversized)
assert_error(openwrangler_r_frame_contract$materialize_page(oversized_capture), "text-too-large")

too_many_levels <- factor(
  character(),
  levels = sprintf("level_%d", seq_len(openwrangler_r_frame_contract$limits$factorLevels + 1L))
)
assert_error(
  openwrangler_r_frame_contract$capture_frame(data.frame(value = too_many_levels)),
  "factor-levels-too-large"
)

maximum_text <- paste(rep("x", openwrangler_r_frame_contract$limits$textBytes), collapse = "")
payload_frame <- as.data.frame(
  setNames(rep(list(rep(maximum_text, 9L)), 256L), sprintf("column_%d", seq_len(256L))),
  optional = TRUE
)
payload_capture <- openwrangler_r_frame_contract$capture_frame(payload_frame)
assert_error(
  openwrangler_r_frame_contract$materialize_page(payload_capture, row_limit = 9L, column_limit = 256L),
  "payload-too-large"
)

html_escape_text <- paste(rep("</", openwrangler_r_frame_contract$limits$textBytes / 2L), collapse = "")
html_escape_capture <- openwrangler_r_frame_contract$capture_frame(
  data.frame(value = rep(html_escape_text, 1000L))
)
assert_error(
  openwrangler_r_frame_contract$materialize_page(html_escape_capture, row_limit = 1000L, column_limit = 1L),
  "payload-too-large"
)

mean_frame <- data.frame(
  value = c(1, NA_real_, NaN, 5),
  row.names = c("mean-a", "mean-b", "mean-c", "mean-d")
)
mean_before <- unserialize(serialize(mean_frame, NULL, version = 3L))
mean_result <- openwrangler_r_frame_contract$fill_missing_column_at(
  mean_frame,
  1L,
  "value",
  list(kind = "mean")
)
assert_identical(mean_result$value, c(1, 3, 3, 5), "R mean fill did not ignore NA and NaN")
assert_identical(class(mean_result), "data.frame", "R mean fill changed the data.frame class")
assert_identical(row.names(mean_result), row.names(mean_before), "R mean fill changed row names")
assert_identical(mean_frame, mean_before, "R mean fill mutated its source data.frame")

mean_huge <- openwrangler_r_frame_contract$fill_missing_column_at(
  data.frame(value = c(1e308, 1e308, NA_real_, NaN)),
  1L,
  "value",
  list(kind = "mean")
)
assert_true(all(is.finite(mean_huge$value)), "R mean fill overflowed a finite mean")
assert_true(all(mean_huge$value == 1e308), "R mean fill changed a finite large mean")

mean_noop <- data.frame(value = c(Inf, -Inf))
assert_identical(
  openwrangler_r_frame_contract$fill_missing_column_at(mean_noop, 1L, "value", list(kind = "mean")),
  mean_noop,
  "R mean fill calculated an undefined mean for a complete column"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c(NA_real_, NaN)),
    1L,
    "value",
    list(kind = "mean")
  ),
  "no present values"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c(Inf, -Inf, NA_real_)),
    1L,
    "value",
    list(kind = "mean")
  ),
  "no usable numeric mean"
)
assert_error(
  openwrangler_r_frame_contract$fill_missing_column_at(
    data.frame(value = c(1L, NA_integer_, 3L)),
    1L,
    "value",
    list(kind = "mean")
  ),
  "incompatible"
)

mean_tibble <- tibble::tibble(value = c(1, NA_real_, 5))
mean_tibble_before <- unserialize(serialize(mean_tibble, NULL, version = 3L))
mean_tibble_result <- openwrangler_r_frame_contract$fill_missing_column_at(
  mean_tibble,
  1L,
  "value",
  list(kind = "mean")
)
assert_identical(class(mean_tibble_result), class(mean_tibble), "R mean fill changed the tibble class")
assert_identical(mean_tibble_result$value, c(1, 3, 5), "R mean fill changed the tibble result")
assert_identical(mean_tibble, mean_tibble_before, "R mean fill mutated its source tibble")

mean_table <- data.table::data.table(id = 1:3, value = c(1, NA_real_, 5))
data.table::setkey(mean_table, id)
mean_table_before <- data.table::copy(mean_table)
mean_table_result <- openwrangler_r_frame_contract$fill_missing_column_at(
  mean_table,
  2L,
  "value",
  list(kind = "mean")
)
assert_identical(class(mean_table_result), class(mean_table), "R mean fill changed the data.table class")
assert_identical(data.table::key(mean_table_result), "id", "R mean fill changed the data.table key")
assert_identical(mean_table_result$value, c(1, 3, 5), "R mean fill changed the data.table result")
assert_identical(mean_table, mean_table_before, "R mean fill mutated its source data.table")

message("R frame contract tests passed")
