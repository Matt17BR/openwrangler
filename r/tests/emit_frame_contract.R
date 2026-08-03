args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L || !args[[1L]] %in% c("data.frame", "tibble", "data.table")) {
  stop("Usage: emit_frame_contract.R data.frame|tibble|data.table", call. = FALSE)
}

source("r/openwrangler_runtime/frame_contract.R", local = FALSE)

make_base <- function() {
  local_instant <- as.POSIXct(c("2026-02-01 08:00:00", "2026-02-02 08:00:00", NA), tz = "UTC")
  attr(local_instant, "tzone") <- NULL
  data.frame(
    duplicate = c(1L, NA_integer_, -2L),
    duplicate = c(1.25, NaN, -Inf),
    `account name` = c("Alpha", "Beta", "café"),
    category = factor(c("A", "B", NA), levels = c("A", "B")),
    ordered = ordered(c("low", "high", NA), levels = c("low", "high")),
    date = as.Date(c("2026-01-01", "2026-01-02", NA)),
    instant = as.POSIXct(c("2026-01-01 08:00:00", "2026-01-02 08:00:00", NA), tz = "UTC"),
    local_instant = local_instant,
    elapsed = as.difftime(c(1, 2, NA), units = "days"),
    wide = bit64::as.integer64(c("9223372036854775806", "-9223372036854775807", NA)),
    check.names = FALSE
  )
}

frame <- switch(
  args[[1L]],
  data.frame = make_base(),
  tibble = tibble::as_tibble(make_base(), .name_repair = "minimal"),
  data.table = {
    value <- data.table::data.table(primary_key = c(2L, 1L, 3L), amount = c(3.5, NaN, Inf), label = c("b", "a", NA))
    data.table::setkey(value, primary_key)
    value
  }
)

capture <- openwrangler_r_frame_contract$capture_frame(frame)
cat(openwrangler_r_frame_contract$encode_page(capture, row_limit = 3L, column_limit = 20L))
