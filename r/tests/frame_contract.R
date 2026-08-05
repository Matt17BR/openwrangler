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
assert_identical(base_page$shape, list(rows = 3L, columns = 10L), "base frame shape changed")
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

sort_rule <- function(id, name, direction = "asc", nulls = "last") {
  list(column = list(id = id, name = name), direction = direction, nulls = nulls)
}

sort_frame <- data.frame(
  group = c("b", "a", "a", "b", NA, "a", "a"),
  score = c(2, 1, 1, 1, 9, NA, NaN),
  marker = seq_len(7L),
  stringsAsFactors = FALSE
)
sort_capture <- openwrangler_r_frame_contract$capture_frame(sort_frame)
sort_page <- openwrangler_r_frame_contract$materialize_view_page(
  sort_capture,
  sort_rules = list(
    sort_rule("r:c:0", "group", "asc", "last"),
    sort_rule("r:c:1", "score", "desc", "first")
  ),
  row_limit = 7L,
  column_limit = 3L
)
assert_identical(
  vapply(sort_page$page$rows, `[[`, integer(1L), "rowNumber"),
  c(5L, 6L, 1L, 2L, 0L, 3L, 4L),
  "native R multi-sort priority or stable tie ordering changed"
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
  list(sort_rule("r:c:1", "duplicate")),
  row_limit = 2L,
  column_limit = 2L
)
assert_identical(
  vapply(duplicate_sort_page$page$rows, `[[`, integer(1L), "rowNumber"),
  c(1L, 0L),
  "a duplicate column name was not resolved by positional ID"
)

sort_window <- openwrangler_r_frame_contract$materialize_view_page(
  sort_capture,
  sort_rules = list(sort_rule("r:c:0", "group")),
  row_offset = 1L,
  row_limit = 3L,
  column_offset = 2L,
  column_limit = 1L
)
assert_identical(sort_window$page$offset, 1, "sorted page offset changed")
assert_identical(sort_window$page$columnIds, I("r:c:2"), "sorted page projection changed")
assert_identical(
  vapply(sort_window$page$rows, `[[`, integer(1L), "rowNumber"),
  c(2L, 5L, 6L),
  "sorted pagination did not slice the logical order"
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
  list(sort_rule("r:c:0", "wide", "asc", "last")),
  row_limit = 7L,
  column_limit = 1L
)
assert_identical(
  vapply(wide_sort_ascending$page$rows, `[[`, integer(1L), "rowNumber"),
  c(1L, 3L, 2L, 4L, 0L, 5L, 6L),
  "integer64 ascending order lost precision or stability"
)
wide_sort_descending <- openwrangler_r_frame_contract$materialize_view_page(
  wide_sort_capture,
  list(sort_rule("r:c:0", "wide", "desc", "first")),
  row_limit = 7L,
  column_limit = 1L
)
assert_identical(
  vapply(wide_sort_descending$page$rows, `[[`, integer(1L), "rowNumber"),
  c(6L, 0L, 5L, 4L, 2L, 3L, 1L),
  "integer64 descending order lost precision, null placement, or stability"
)

assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    list(sort_rule("r:c:0", "stale name"))
  ),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    list(sort_rule("r:c:7", "group"))
  ),
  "stale-column"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    list(sort_rule("r:c:0", "group"), sort_rule("r:c:0", "group", "desc"))
  ),
  "each column only once"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    list(sort_rule("r:c:0", "group", "sideways"))
  ),
  "must be one of"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    list(c(sort_rule("r:c:0", "group"), list(extra = TRUE)))
  ),
  "missing or unknown fields"
)
assert_error(
  openwrangler_r_frame_contract$materialize_view_page(
    sort_capture,
    setNames(list(sort_rule("r:c:0", "group")), "named")
  ),
  "unnamed list"
)

explicit_names <- data.frame(value = 1:2, row.names = c("left", "right"))
assert_error(openwrangler_r_frame_contract$capture_frame(explicit_names), "unsupported-row-names")
numeric_explicit_names <- data.frame(value = 1:2, row.names = c("1", "2"))
assert_error(openwrangler_r_frame_contract$capture_frame(numeric_explicit_names), "unsupported-row-names")

grouped_tibble <- tibble::tibble(value = 1:2)
class(grouped_tibble) <- c("grouped_df", class(grouped_tibble))
assert_error(openwrangler_r_frame_contract$capture_frame(grouped_tibble), "unsupported-frame-class")

list_frame <- data.frame(value = I(list(1L, 2L)))
assert_error(openwrangler_r_frame_contract$capture_frame(list_frame), "unsupported-column")
matrix_frame <- data.frame(value = I(matrix(1:4, nrow = 2L)))
assert_error(openwrangler_r_frame_contract$capture_frame(matrix_frame), "unsupported-column")
complex_frame <- data.frame(value = I(c(1 + 2i, 3 + 4i)))
assert_error(openwrangler_r_frame_contract$capture_frame(complex_frame), "unsupported-column")

attributed_frame <- data.frame(value = 1:2)
attr(attributed_frame$value, "label") <- "meaning"
assert_error(openwrangler_r_frame_contract$capture_frame(attributed_frame), "unsupported-column-attributes")

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

message("R frame contract tests passed")
