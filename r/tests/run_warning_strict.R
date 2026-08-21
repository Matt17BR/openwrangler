local({
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

  analysis_environment <- new.env(parent = baseenv())
  sys.source(
    "r/tools/static_analysis.R",
    envir = analysis_environment,
    keep.source = FALSE
  )
  analysis_environment$openwrangler_r_static_analysis$run(".")
  rm(analysis_environment)

  warning_state <- new.env(parent = emptyenv())
  warning_state$diagnostics <- character()
  unexpected_warning <- function(condition) {
    diagnostic <- sprintf(
      "Unexpected R warning [%s]: %s",
      paste(class(condition), collapse = "/"),
      conditionMessage(condition)
    )
    warning_state$diagnostics <- c(warning_state$diagnostics, diagnostic)
    tryInvokeRestart("muffleWarning")
  }
  globalCallingHandlers(warning = unexpected_warning)
  warning("warning contract probe", call. = FALSE)
  expected_probe <- "Unexpected R warning [simpleWarning/warning/condition]: warning contract probe"
  if (!identical(warning_state$diagnostics, expected_probe)) {
    stop("The Native R warning latch failed its deterministic probe", call. = FALSE)
  }

  warning_state$diagnostics <- character()

  source_error <- tryCatch(
    {
      source(target, local = FALSE)
      NULL
    },
    error = function(condition) condition
  )
  if (length(warning_state$diagnostics) > 0L) {
    failure <- paste(warning_state$diagnostics, collapse = "\n")
    if (!is.null(source_error) && !(conditionMessage(source_error) %in% warning_state$diagnostics)) {
      failure <- sprintf(
        "%s\nNative R source error [%s]: %s",
        failure,
        paste(class(source_error), collapse = "/"),
        conditionMessage(source_error)
      )
    }
    stop(failure, call. = FALSE)
  }
  if (!is.null(source_error)) {
    stop(source_error)
  }
})
