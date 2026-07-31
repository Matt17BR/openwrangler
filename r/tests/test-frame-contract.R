script_args <- commandArgs(trailingOnly = FALSE)
script_file <- sub("^--file=", "", script_args[grepl("^--file=", script_args)])
root <- normalizePath(file.path(dirname(script_file), "..", ".."), mustWork = TRUE)
source(file.path(root, "r", "openwrangler_runtime", "frame_contract.R"), local = TRUE)

expect_error <- function(expression) {
  failed <- FALSE
  tryCatch(expression, error = function(...) failed <<- TRUE)
  stopifnot(failed)
}

base_frame <- data.frame(
  integer = c(1L, NA_integer_, 3L, 4L, 5L),
  number = c(1.5, NA_real_, NaN, Inf, -Inf),
  logical = c(TRUE, FALSE, NA, TRUE, FALSE),
  factor = ordered(c("beta", NA, "alpha", "beta", "alpha"), levels = c("alpha", "beta")),
  date = as.Date(c("2025-01-01", NA, "2025-01-03", "2025-01-04", "2025-01-05")),
  instant = as.POSIXct(
    c("2025-01-01 10:00:00", NA, "2025-01-03 10:00:00", "2025-01-04 10:00:00", "2025-01-05 10:00:00"),
    tz = "Europe/Berlin"
  ),
  duration = as.difftime(c(1, NA, 3, 4, 5), units = "hours"),
  stringsAsFactors = FALSE,
  check.names = FALSE,
  row.names = paste0("row-", seq_len(5L))
)
base_frame[["list"]] <- I(list("one", NULL, NaN, list(nested = TRUE), NA_integer_))
names(base_frame)[2L] <- "integer"

before <- serialize(base_frame, NULL)
contract <- ow_r_frame_contract(
  base_frame,
  offset = 1L,
  limit = 3L,
  column_positions = c(0L, 1L, 3L, 4L, 5L, 6L, 7L),
  session_id = "native-r"
)
stopifnot(identical(before, serialize(base_frame, NULL)))
stopifnot(contract$contractVersion == 1L)
stopifnot(identical(contract$runtimeLanguage, "r"))
stopifnot(identical(contract$frameFlavor, "data.frame"))
stopifnot(is.null(contract$codeDialect))
stopifnot(identical(contract$shape, list(rows = 5L, columns = 8L)))
stopifnot(identical(vapply(contract$schema, `[[`, character(1), "name")[1:2], c("integer", "integer")))
stopifnot(identical(vapply(contract$schema, `[[`, integer(1), "position"), 0:7))
stopifnot(identical(contract$schema[[2L]]$type, "float"))
stopifnot(isTRUE(contract$schema[[2L]]$nullable))
stopifnot(identical(unlist(contract$columnMetadata[[4L]]$levels, use.names = FALSE), c("alpha", "beta")))
stopifnot(isTRUE(contract$columnMetadata[[4L]]$ordered))
stopifnot(identical(contract$columnMetadata[[6L]]$timezone, "Europe/Berlin"))
stopifnot(identical(contract$columnMetadata[[7L]]$durationUnits, "hours"))
stopifnot(identical(contract$page$offset, 1L))
stopifnot(identical(contract$page$limit, 3L))
stopifnot(length(contract$page$rows) == 3L)
stopifnot(identical(unlist(contract$rowNames, use.names = FALSE), c("row-2", "row-3", "row-4")))
stopifnot(identical(contract$page$rows[[1L]]$values[[1L]]$kind, "null"))
stopifnot(identical(contract$page$rows[[1L]]$values[[2L]]$kind, "null"))
stopifnot(identical(contract$page$rows[[2L]]$values[[2L]]$kind, "nan"))
stopifnot(identical(contract$page$rows[[3L]]$values[[2L]]$kind, "infinity"))
stopifnot(identical(contract$page$rows[[3L]]$values[[2L]]$sign, 1L))
stopifnot(identical(contract$page$rows[[1L]]$values[[3L]]$kind, "null"))
stopifnot(!contract$schema[[8L]]$nullable)
stopifnot(identical(contract$page$rows[[1L]]$values[[7L]]$kind, "list"))
stopifnot(identical(contract$page$rows[[1L]]$values[[7L]]$display, "<NULL>"))
stopifnot(identical(contract$page$rows[[2L]]$values[[7L]]$kind, "list"))
stopifnot(identical(contract$page$rows[[2L]]$values[[7L]]$display, "<double[1]: NaN>"))
stopifnot(grepl("T", contract$page$rows[[2L]]$values[[5L]]$display, fixed = TRUE))

nan_only <- ow_r_frame_contract(data.frame(value = NaN), limit = 1L)
stopifnot(!nan_only$schema[[1L]]$nullable)
stopifnot(identical(nan_only$page$rows[[1L]]$values[[1L]]$kind, "nan"))

list_specials <- data.frame(row.names = seq_len(4L))
list_specials[["value"]] <- I(list(NULL, NA_integer_, NaN, Inf))
list_contract <- ow_r_frame_contract(list_specials, limit = 4L)
stopifnot(!list_contract$schema[[1L]]$nullable)
stopifnot(identical(
  vapply(list_contract$page$rows, function(row) row$values[[1L]]$kind, character(1)),
  rep("list", 4L)
))
stopifnot(identical(
  vapply(list_contract$page$rows, function(row) row$values[[1L]]$display, character(1)),
  c("<NULL>", "<integer[1]: NA>", "<double[1]: NaN>", "<double[1]: Infinity>")
))

temporal_specials <- data.frame(row.names = seq_len(4L))
temporal_specials[["date"]] <- structure(c(NA_real_, NaN, Inf, -Inf), class = "Date")
temporal_specials[["instant"]] <- structure(
  c(NA_real_, NaN, Inf, -Inf),
  class = c("POSIXct", "POSIXt"),
  tzone = "UTC"
)
temporal_specials[["duration"]] <- structure(
  c(NA_real_, NaN, Inf, -Inf),
  class = "difftime",
  units = "secs"
)
temporal_contract <- ow_r_frame_contract(temporal_specials, limit = 4L)
for (column_position in seq_len(3L)) {
  cells <- lapply(temporal_contract$page$rows, function(row) row$values[[column_position]])
  stopifnot(identical(vapply(cells, `[[`, character(1), "kind"), c("null", "nan", "infinity", "infinity")))
  stopifnot(identical(cells[[3L]]$sign, 1L))
  stopifnot(identical(cells[[4L]]$sign, -1L))
  stopifnot(isTRUE(temporal_contract$schema[[column_position]]$nullable))
}

if (requireNamespace("jsonlite", quietly = TRUE)) {
  encoded <- jsonlite::toJSON(contract, auto_unbox = TRUE, null = "null", na = "null", digits = NA)
  stopifnot(jsonlite::validate(encoded))
  stopifnot(grepl('"runtimeLanguage":"r"', encoded, fixed = TRUE))
  stopifnot(!grepl('"backend":"pandas"', encoded, fixed = TRUE))
  decoded <- jsonlite::fromJSON(encoded, simplifyVector = FALSE)
  stopifnot(is.list(decoded$schema))
  stopifnot(is.list(decoded$page$columnIds))
  stopifnot(is.list(decoded$rowNames))
}

explicit_dialect <- ow_r_frame_contract(base_frame, limit = 1L, code_dialect = "base-r")
stopifnot(identical(explicit_dialect$codeDialect, "base-r"))
expect_error(ow_r_frame_contract(base_frame, code_dialect = "reticulate"))
expect_error(ow_r_frame_contract(base_frame, code_dialect = c("base-r", "dplyr")))
expect_error(ow_r_frame_contract(base_frame, column_positions = c(1L, 0L)))
expect_error(ow_r_frame_contract(base_frame, limit = OW_R_MAX_PAGE_ROWS + 1L))
expect_error(ow_r_frame_contract(structure(base_frame, class = c("custom_frame", "data.frame"))))
expect_error(ow_r_frame_contract(data.frame(value = I(matrix(1, nrow = 1L, ncol = 1L)))))
expect_error(ow_r_frame_contract(data.frame(value = I(array(1, dim = c(1L, 1L, 1L))))))

for (malformed_class in list("integer64", "Date", c("POSIXct", "POSIXt"), "difftime")) {
  malformed_column <- structure(1L, class = malformed_class)
  if (identical(malformed_class, "difftime")) attr(malformed_column, "units") <- "secs"
  malformed_frame <- data.frame(value = 1L)
  malformed_frame[[1L]] <- malformed_column
  expect_error(ow_r_frame_contract(malformed_frame, limit = 1L))
}

duplicate_factor <- structure(c(1L, 2L), levels = c("same", "same"), class = "factor")
duplicate_factor_frame <- data.frame(value = 1:2)
duplicate_factor_frame[[1L]] <- duplicate_factor
expect_error(ow_r_frame_contract(duplicate_factor_frame, limit = 2L))

synthetic_groups <- data.frame(value = 1:2)
attr(synthetic_groups, "groups") <- data.frame(value = 1:2, .rows = I(list(1L, 2L)))
expect_error(ow_r_frame_contract(synthetic_groups, limit = 2L))

synthetic_key <- data.frame(value = 1:2)
attr(synthetic_key, "sorted") <- "value"
expect_error(ow_r_frame_contract(synthetic_key, limit = 2L))

malformed_grouped <- structure(data.frame(value = 1:2), class = c("grouped_df", "tbl_df", "tbl", "data.frame"))
expect_error(ow_r_frame_contract(malformed_grouped, limit = 2L))

bytes_text <- rawToChar(as.raw(0xff))
Encoding(bytes_text) <- "bytes"
expect_error(ow_r_frame_contract(data.frame(value = bytes_text)))

latin1_character <- iconv("é", from = "UTF-8", to = "latin1")
latin1_value <- strrep(latin1_character, 30000L)
Encoding(latin1_value) <- "latin1"
expect_error(ow_r_frame_contract(data.frame(value = rep(latin1_value, 100L)), limit = 100L))

evil_column <- structure(c(1, 2), class = c("open_wrangler_evil", "numeric"))
evil_frame <- data.frame(value = c(1, 2))
evil_frame[[1L]] <- evil_column
`length.open_wrangler_evil` <- function(...) stop("custom length method must not run")
`[.open_wrangler_evil` <- function(...) stop("custom subset method must not run")
evil_contract <- ow_r_frame_contract(evil_frame, limit = 2L)
stopifnot(identical(evil_contract$schema[[1L]]$type, "unknown"))
stopifnot(identical(evil_contract$page$rows[[1L]]$values[[1L]]$kind, "unknown"))
rm(`length.open_wrangler_evil`, `[.open_wrangler_evil`)

zero_column <- data.frame(row.names = c("empty-a", "empty-b"))
zero_column_contract <- ow_r_frame_contract(zero_column, limit = 2L)
stopifnot(identical(zero_column_contract$shape, list(rows = 2L, columns = 0L)))
stopifnot(length(zero_column_contract$page$columnIds) == 0L)
stopifnot(length(zero_column_contract$page$rows[[1L]]$values) == 0L)
stopifnot(identical(unlist(zero_column_contract$rowNames, use.names = FALSE), c("empty-a", "empty-b")))

if (requireNamespace("tibble", quietly = TRUE)) {
  tibble_frame <- tibble::as_tibble(base_frame, .name_repair = "minimal")
  tibble_before <- serialize(tibble_frame, NULL)
  tibble_contract <- ow_r_frame_contract(tibble_frame, limit = 2L, code_dialect = "base-r")
  stopifnot(identical(tibble_before, serialize(tibble_frame, NULL)))
  stopifnot(identical(tibble_contract$frameFlavor, "tibble"))
  stopifnot(identical(tibble_contract$codeDialect, "base-r"))
}

if (requireNamespace("dplyr", quietly = TRUE) && requireNamespace("tibble", quietly = TRUE)) {
  grouped <- dplyr::group_by(tibble::tibble(group = c("a", "a", "b"), value = 1:3), group)
  grouped_before <- serialize(grouped, NULL)
  grouped_contract <- ow_r_frame_contract(grouped, limit = 2L)
  stopifnot(identical(grouped_before, serialize(grouped, NULL)))
  stopifnot(identical(grouped_contract$frameFlavor, "grouped-tibble"))
  stopifnot(identical(grouped_contract$frameMetadata$groupColumns[[1L]], list(id = "r:c:0", name = "group")))

  rowwise <- dplyr::rowwise(tibble::tibble(identifier = c("a", "b"), value = 1:2), identifier)
  rowwise_before <- serialize(rowwise, NULL)
  rowwise_contract <- ow_r_frame_contract(rowwise, limit = 2L)
  stopifnot(identical(rowwise_before, serialize(rowwise, NULL)))
  stopifnot(identical(rowwise_contract$frameFlavor, "rowwise-tibble"))
  stopifnot(identical(rowwise_contract$frameMetadata$groupColumns[[1L]], list(id = "r:c:0", name = "identifier")))
}

if (requireNamespace("data.table", quietly = TRUE)) {
  table_frame <- data.table::data.table(group_key = c("a", "b"), value = c(2L, 1L))
  data.table::setkey(table_frame, group_key)
  table_before <- serialize(table_frame, NULL)
  table_contract <- ow_r_frame_contract(table_frame, limit = 2L, code_dialect = "data.table")
  stopifnot(identical(table_before, serialize(table_frame, NULL)))
  stopifnot(identical(table_contract$frameFlavor, "data.table"))
  stopifnot(identical(table_contract$frameMetadata$keyColumns[[1L]], list(id = "r:c:0", name = "group_key")))
}

if (requireNamespace("bit64", quietly = TRUE)) {
  wide_frame <- data.frame(wide = bit64::as.integer64(c("9007199254740993", NA_character_)))
  wide_contract <- ow_r_frame_contract(wide_frame, limit = 2L)
  stopifnot(identical(wide_contract$schema[[1L]]$type, "integer"))
  stopifnot(identical(wide_contract$page$rows[[1L]]$values[[1L]]$raw, "9007199254740993"))
  stopifnot(identical(wide_contract$page$rows[[2L]]$values[[1L]]$kind, "null"))
}

cat("Native R frame contract tests passed.\n")
