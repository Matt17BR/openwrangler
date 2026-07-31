script_args <- commandArgs(trailingOnly = FALSE)
script_file <- sub("^--file=", "", script_args[grepl("^--file=", script_args)])
root <- normalizePath(file.path(dirname(script_file), "..", ".."), mustWork = TRUE)
source(file.path(root, "r", "openwrangler_runtime", "frame_contract.R"), local = TRUE)

if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("jsonlite is required for the native R-to-TypeScript contract gate.")
}

arguments <- commandArgs(trailingOnly = TRUE)
if (identical(arguments, "--latin1-boundary")) {
  latin1_character <- iconv("é", from = "UTF-8", to = "latin1")
  latin1_value <- strrep(latin1_character, 15000L)
  Encoding(latin1_value) <- "latin1"
  frame <- data.frame(value = rep(latin1_value, 100L), stringsAsFactors = FALSE)
  contract <- ow_r_frame_contract(frame, limit = 100L, session_id = "cross-language-latin1")
} else {
  if (length(arguments) != 0L) stop("Unknown native R contract fixture argument.")
  frame <- data.frame(
    metric = c(1.5, NaN, Inf),
    category = ordered(c("beta", NA, "alpha"), levels = c("alpha", "beta")),
    stringsAsFactors = FALSE,
    check.names = FALSE,
    row.names = c("r-one", "r-two", "r-three")
  )
  frame[["when"]] <- structure(c(as.numeric(as.Date("0969-12-31")), NaN, -Inf), class = "Date")
  frame[["nested"]] <- I(list(NULL, NA_integer_, NaN))
  names(frame)[2L] <- "metric"
  contract <- ow_r_frame_contract(frame, limit = 3L, session_id = "cross-language")
}
cat(jsonlite::toJSON(contract, auto_unbox = TRUE, null = "null", na = "null", digits = NA))
