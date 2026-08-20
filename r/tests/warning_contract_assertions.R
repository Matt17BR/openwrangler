assert_no_warning <- function(expression, label) {
  withCallingHandlers(
    force(expression),
    warning = function(condition) {
      stop(
        sprintf(
          "%s emitted an unexpected R warning [%s]: %s",
          label,
          paste(class(condition), collapse = "/"),
          conditionMessage(condition)
        ),
        call. = FALSE
      )
    }
  )
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
