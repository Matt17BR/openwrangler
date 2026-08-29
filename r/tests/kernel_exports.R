kernel_export_fail <- function(code, message, recoverable = FALSE) {
  stop(structure(
    list(message = message, call = NULL, code = code, recoverable = recoverable),
    class = c("openwrangler_r_kernel_export_test_error", "error", "condition")
  ))
}

expect_kernel_export_error <- function(expression, code, message) {
  caught <- tryCatch(expression, openwrangler_r_kernel_export_test_error = identity)
  if (!inherits(caught, "openwrangler_r_kernel_export_test_error")) {
    stop(sprintf("%s did not fail", message), call. = FALSE)
  }
  assert_identical(caught$code, code, message)
  invisible(caught)
}

last_kernel_export_path <- NULL
kernel_export_contract <- list(
  export_formats = function() "csv",
  normalize_export_options = function(options) {
    if (!is.list(options) || !identical(options$format, "csv")) stop("invalid options")
    list(format = "csv")
  },
  write_csv = function(capture, path, options) {
    last_kernel_export_path <<- path
    bytes <- charToRaw(capture)
    writeBin(bytes, path)
    list(rows = 1L, columns = 1L, bytes = length(bytes))
  },
  write_parquet = function(capture, path, options) stop("unexpected Parquet writer")
)

kernel_export_session <- "11111111-1111-4111-8111-111111111111"
kernel_export_other_session <- "22222222-2222-4222-8222-222222222222"
kernel_export_id <- "33333333-3333-4333-8333-333333333333"
kernel_export_second_id <- "44444444-4444-4444-8444-444444444444"

owned_lifecycle <- openwrangler_r_kernel_exports$new_lifecycle(
  kernel_export_contract,
  fail = kernel_export_fail
)
owned_result <- owned_lifecycle$create(
  kernel_export_session,
  4L,
  kernel_export_id,
  "alpha",
  list(format = "csv"),
  identity
)
owned_export_path <- last_kernel_export_path
assert_identical(
  owned_result,
  list(format = "csv", rows = 1L, columns = 1L, bytes = 5L),
  "the export lifecycle changed the writer result"
)
assert_identical(owned_lifecycle$formats(), "csv", "the export lifecycle changed its format contract")
expect_kernel_export_error(
  owned_lifecycle$create(
    kernel_export_session,
    4L,
    kernel_export_id,
    "duplicate",
    list(format = "csv"),
    identity
  ),
  "invalid_request",
  "the export lifecycle accepted a duplicate export identity"
)
expect_kernel_export_error(
  owned_lifecycle$read(kernel_export_other_session, 4L, kernel_export_id, 0L, 5L),
  "invalid_request",
  "the export lifecycle accepted another session"
)
expect_kernel_export_error(
  owned_lifecycle$read(kernel_export_session, 5L, kernel_export_id, 0L, 5L),
  "invalid_request",
  "the export lifecycle accepted another revision"
)
chunk <- owned_lifecycle$read(kernel_export_session, 4L, kernel_export_id, 1L, 3L)
assert_identical(chunk, list(offset = 1, bytes = 3L, data = "bHBo"), "the bounded export chunk changed")
oversized_chunk_error <- expect_kernel_export_error(
  owned_lifecycle$read(kernel_export_session, 4L, kernel_export_id, 0L, 1024L * 1024L + 1L),
  "invalid_request",
  "the export lifecycle accepted an oversized chunk"
)
assert_identical(
  oversized_chunk_error$recoverable,
  FALSE,
  "an out-of-range export chunk limit became recoverable"
)
invalid_offset_error <- expect_kernel_export_error(
  owned_lifecycle$read(kernel_export_session, 4L, kernel_export_id, -1L, 1L),
  "invalid_request",
  "the export lifecycle accepted a negative offset"
)
assert_identical(
  invalid_offset_error$recoverable,
  FALSE,
  "an out-of-range export chunk offset became recoverable"
)
owned_lifecycle$create(
  kernel_export_session,
  4L,
  kernel_export_second_id,
  "bravo",
  list(format = "csv"),
  identity
)
changed_identity_path <- last_kernel_export_path
Sys.chmod(changed_identity_path, mode = "0400")
expect_kernel_export_error(
  owned_lifecycle$read(kernel_export_session, 4L, kernel_export_second_id, 0L, 1L),
  "runtime_error",
  "the export lifecycle accepted a changed artifact identity"
)
unlink(changed_identity_path, force = TRUE)
writeBin(charToRaw("a"), owned_export_path)
expect_kernel_export_error(
  owned_lifecycle$read(kernel_export_session, 4L, kernel_export_id, 0L, 1L),
  "runtime_error",
  "the export lifecycle accepted a truncated artifact"
)
unlink(owned_export_path, force = TRUE)
owned_lifecycle$dispose()

rollback_lifecycle <- openwrangler_r_kernel_exports$new_lifecycle(
  kernel_export_contract,
  fail = kernel_export_fail
)
expect_kernel_export_error(
  rollback_lifecycle$create(
    kernel_export_session,
    6L,
    kernel_export_id,
    "rollback",
    list(format = "csv"),
    function(result) kernel_export_fail("runtime_error", "publication failed")
  ),
  "runtime_error",
  "the export lifecycle did not surface publication failure"
)
assert_identical(file.exists(last_kernel_export_path), FALSE, "publication failure retained a provisional export")
rollback_lifecycle$dispose()

cleanup_lifecycle <- openwrangler_r_kernel_exports$new_lifecycle(
  kernel_export_contract,
  fail = kernel_export_fail
)
cleanup_lifecycle$create(
  kernel_export_session,
  7L,
  kernel_export_id,
  "first",
  list(format = "csv"),
  identity
)
first_cleanup_path <- last_kernel_export_path
cleanup_lifecycle$create(
  kernel_export_session,
  7L,
  kernel_export_second_id,
  "second",
  list(format = "csv"),
  identity
)
second_cleanup_path <- last_kernel_export_path
cleanup_lifecycle$close(kernel_export_session, 7L, kernel_export_id)
assert_identical(file.exists(first_cleanup_path), FALSE, "closing an export retained its owned artifact")
cleanup_lifecycle$close_session(kernel_export_session)
assert_identical(file.exists(second_cleanup_path), FALSE, "closing a session retained its owned artifact")
cleanup_lifecycle$dispose()

supplied_root <- tempfile("openwrangler-r-export-test-")
dir.create(supplied_root, mode = "0700")
supplied_lifecycle <- openwrangler_r_kernel_exports$new_lifecycle(
  kernel_export_contract,
  supplied_root,
  kernel_export_fail
)
supplied_lifecycle$create(
  kernel_export_session,
  8L,
  kernel_export_id,
  "host-owned",
  list(format = "csv"),
  identity
)
supplied_path <- last_kernel_export_path
supplied_lifecycle$close(kernel_export_other_session, 999L, kernel_export_id)
expect_kernel_export_error(
  supplied_lifecycle$read(kernel_export_session, 8L, kernel_export_id, 0L, 4L),
  "invalid_request",
  "the kernel exposed a host-owned export through chunk reads"
)
supplied_lifecycle$close(kernel_export_session, 8L, kernel_export_id)
supplied_lifecycle$dispose()
assert_identical(file.exists(supplied_path), TRUE, "the kernel removed a host-owned export artifact")
assert_identical(dir.exists(supplied_root), TRUE, "the kernel removed a host-owned export root")
unlink(supplied_root, recursive = TRUE, force = TRUE)
