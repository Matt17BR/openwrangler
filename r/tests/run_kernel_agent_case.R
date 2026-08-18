arguments <- commandArgs(trailingOnly = TRUE)
if (length(arguments) != 1L || is.na(arguments[[1L]]) || nchar(arguments[[1L]], type = "bytes") > 32L) {
  stop("Pass exactly one bounded native R kernel-agent case name", call. = FALSE)
}

case_files <- c(
  full = "r/tests/kernel_agent.R",
  viewing = "r/tests/kernel_agent_viewing.R",
  `custom-code` = "r/tests/kernel_agent_custom_code.R",
  text = "r/tests/kernel_agent_text.R",
  rows = "r/tests/kernel_agent_rows.R"
)
case_name <- arguments[[1L]]
case_file <- unname(case_files[case_name])
if (length(case_file) != 1L || is.na(case_file)) {
  stop(sprintf("Unknown native R kernel-agent case: %s", case_name), call. = FALSE)
}

case_info <- file.info(case_file)
if (
  nrow(case_info) != 1L || is.na(case_info$size[[1L]]) ||
    isTRUE(case_info$isdir[[1L]]) || case_info$size[[1L]] < 1L || case_info$size[[1L]] > 1048576L
) {
  stop(sprintf("Native R kernel-agent case file is invalid: %s", case_name), call. = FALSE)
}

if (identical(case_name, "full")) {
  source(case_file, local = FALSE)
} else {
  source("r/tests/kernel_agent_support.R", local = FALSE)
  source(case_file, local = FALSE)
  agent$dispose()
  cat(sprintf("Native R kernel agent %s case passed.\n", case_name))
}
