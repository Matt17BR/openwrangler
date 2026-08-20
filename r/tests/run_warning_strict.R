strict_targets <- c(
  "r/tests/frame_contract.R",
  "r/tests/kernel_agent.R",
  "r/tests/complete_catalog_contract.R"
)
target <- Sys.getenv("OPEN_WRANGLER_R_CONTRACT_TEST", unset = NA_character_)
Sys.unsetenv("OPEN_WRANGLER_R_CONTRACT_TEST")
if (length(target) != 1L || is.na(target) || !(target %in% strict_targets)) {
  stop("The Native R warning contract target is missing or invalid", call. = FALSE)
}

unexpected_warning <- function(condition) {
  stop(
    sprintf(
      "Unexpected R warning [%s]: %s",
      paste(class(condition), collapse = "/"),
      conditionMessage(condition)
    ),
    call. = FALSE
  )
}
warning_probe <- tryCatch(
  unexpected_warning(simpleWarning("warning contract probe")),
  error = function(condition) condition
)
if (
  !identical(class(warning_probe), c("simpleError", "error", "condition")) ||
    !identical(
      conditionMessage(warning_probe),
      "Unexpected R warning [simpleWarning/warning/condition]: warning contract probe"
    )
) {
  stop("The Native R unexpected-warning handler failed its deterministic probe", call. = FALSE)
}

globalCallingHandlers(warning = unexpected_warning)

source(target, local = FALSE)
