assert_no_warning <- function(expression, label) {
  diagnostics <- character()
  expression_error <- NULL
  result <- NULL
  tryCatch(
    {
      result <- withCallingHandlers(
        force(expression),
        warning = function(condition) {
          diagnostics <<- c(
            diagnostics,
            sprintf(
              "%s emitted an unexpected R warning [%s]: %s",
              label,
              paste(class(condition), collapse = "/"),
              conditionMessage(condition)
            )
          )
          tryInvokeRestart("muffleWarning")
        }
      )
    },
    error = function(condition) {
      expression_error <<- condition
    }
  )
  if (length(diagnostics) > 0L) {
    failure <- paste(diagnostics, collapse = "\n")
    if (!is.null(expression_error)) {
      failure <- sprintf(
        "%s\nR expression error [%s]: %s",
        failure,
        paste(class(expression_error), collapse = "/"),
        conditionMessage(expression_error)
      )
    }
    stop(failure, call. = FALSE)
  }
  if (!is.null(expression_error)) {
    stop(expression_error)
  }
  result
}

assert_exact_warning <- function(expression, expected_class, expected_message, label) {
  captured <- list()
  result <- withCallingHandlers(
    force(expression),
    warning = function(condition) {
      captured[[length(captured) + 1L]] <<- condition
      invokeRestart("muffleWarning")
    }
  )
  assert_identical(length(captured), 1L, sprintf("%s did not emit exactly one warning", label))
  assert_identical(class(captured[[1L]]), expected_class, sprintf("%s warning class changed", label))
  assert_identical(
    conditionMessage(captured[[1L]]),
    expected_message,
    sprintf("%s warning message changed", label)
  )
  result
}

warning_assertion_probe <- tryCatch(
  assert_no_warning(
    tryCatch(
      {
        warning("warning assertion probe", call. = FALSE)
        "continued"
      },
      error = function(condition) "caught"
    ),
    "the warning assertion probe"
  ),
  error = function(condition) condition
)
if (
  !identical(class(warning_assertion_probe), c("simpleError", "error", "condition")) ||
    !identical(
      conditionMessage(warning_assertion_probe),
      paste0(
        "the warning assertion probe emitted an unexpected R warning ",
        "[simpleWarning/warning/condition]: warning assertion probe"
      )
    )
) {
  stop("The Native R no-warning assertion failed its deterministic probe", call. = FALSE)
}
