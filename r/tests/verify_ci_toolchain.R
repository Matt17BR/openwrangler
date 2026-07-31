expected_r_version <- "4.5.2"
expected_packages <- c(
  jsonlite = "2.0.0",
  tibble = "3.3.1",
  data.table = "1.18.2.1"
)

actual_r_version <- as.character(getRversion())
if (!identical(actual_r_version, expected_r_version)) {
  stop(
    sprintf("Expected R %s, received R %s.", expected_r_version, actual_r_version),
    call. = FALSE
  )
}

for (package_name in names(expected_packages)) {
  if (!requireNamespace(package_name, quietly = TRUE)) {
    stop(sprintf("Required R package %s is not installed.", package_name), call. = FALSE)
  }
  actual_version <- as.character(utils::packageVersion(package_name))
  expected_version <- unname(expected_packages[[package_name]])
  if (!identical(actual_version, expected_version)) {
    stop(
      sprintf(
        "Expected R package %s %s, received %s.",
        package_name,
        expected_version,
        actual_version
      ),
      call. = FALSE
    )
  }
}

cat("Pinned native R test toolchain verified.\n")
