openwrangler_r_kernel_exports <- local({
  maximum_export_chunk_bytes <- 1L * 1024L * 1024L
  anyDuplicated <- function(value) base::anyDuplicated.default(value)

  canonical_base64 <- function(value) {
    encoded <- jsonlite::base64_enc(value)
    gsub("\r", "", gsub("\n", "", encoded, fixed = TRUE), fixed = TRUE)
  }

  validate_export_root <- function(export_root) {
    if (
      !is.character(export_root) ||
        length(export_root) != 1L ||
        is.na(export_root) ||
        identical(export_root, "") ||
        nchar(export_root, type = "bytes") > 32768L ||
        !(
          startsWith(export_root, "/") ||
            startsWith(export_root, "\\\\") ||
            grepl("^[A-Za-z]:[/\\\\]", export_root, perl = TRUE)
        )
    ) {
      stop("Open Wrangler received an invalid private R export directory.", call. = FALSE)
    }
    export_root <- tryCatch(
      normalizePath(export_root, winslash = "/", mustWork = TRUE),
      error = function(error) ""
    )
    export_info <- if (identical(export_root, "")) NULL else file.info(export_root)
    if (
      identical(export_root, "") ||
        is.null(export_info) ||
        nrow(export_info) != 1L ||
        !isTRUE(export_info$isdir[[1L]])
    ) {
      stop("Open Wrangler received an invalid private R export directory.", call. = FALSE)
    }
    export_root
  }

  artifact_receipt <- function(path, fail) {
    details <- file.info(path)
    if (
      nrow(details) != 1L ||
        is.na(details$size[[1L]]) ||
        !is.finite(details$size[[1L]]) ||
        details$size[[1L]] < 0 ||
        isTRUE(details$isdir[[1L]])
    ) {
      fail("runtime_error", "The private R export changed before it could be used")
    }
    list(
      size = as.double(details$size[[1L]]),
      mode = as.integer(details$mode[[1L]]),
      mtime = as.double(details$mtime[[1L]]),
      ctime = as.double(details$ctime[[1L]])
    )
  }

  artifact_matches <- function(path, receipt) {
    details <- file.info(path)
    nrow(details) == 1L &&
      !is.na(details$size[[1L]]) &&
      !isTRUE(details$isdir[[1L]]) &&
      identical(as.double(details$size[[1L]]), receipt$size) &&
      identical(as.integer(details$mode[[1L]]), receipt$mode) &&
      identical(as.double(details$mtime[[1L]]), receipt$mtime) &&
      identical(as.double(details$ctime[[1L]]), receipt$ctime)
  }

  whole_number <- function(value, label, maximum, fail) {
    if (
      length(value) != 1L ||
        !is.numeric(value) ||
        is.na(value) ||
        !is.finite(value) ||
        value < 0 ||
        value > maximum ||
        value != floor(value)
    ) {
      fail("invalid_request", sprintf("%s is outside its supported range", label))
    }
    as.double(value)
  }

  new_lifecycle <- function(frame_contract, export_root = NULL, fail) {
    if (
      !is.list(frame_contract) ||
        !is.function(fail)
    ) {
      stop("Open Wrangler received an invalid R export lifecycle contract.", call. = FALSE)
    }

    owns_export_root <- is.null(export_root)
    initialized_export_root <- FALSE
    construction_complete <- FALSE
    if (owns_export_root) {
      export_root <- tempfile("openwrangler-r-kernel-", tmpdir = tempdir())
      if (!dir.create(export_root, mode = "0700", showWarnings = FALSE)) {
        stop("Open Wrangler could not create its private R kernel export directory.", call. = FALSE)
      }
      initialized_export_root <- TRUE
    }
    on.exit({
      if (!construction_complete && owns_export_root && initialized_export_root && dir.exists(export_root)) {
        try(unlink(export_root, recursive = TRUE, force = TRUE), silent = TRUE)
      }
    }, add = TRUE)
    export_root <- validate_export_root(export_root)
    artifacts <- new.env(hash = TRUE, parent = emptyenv())

    formats <- function() {
      if (!is.function(frame_contract$export_formats)) {
        fail("runtime_error", "The R frame contract does not provide export capabilities")
      }
      available <- frame_contract$export_formats()
      if (
        !is.character(available) ||
          length(available) < 1L ||
          length(available) > 2L ||
          anyNA(available) ||
          anyDuplicated(available) ||
          !identical(available[[1L]], "csv") ||
          any(!available %in% c("csv", "parquet"))
      ) {
        fail("runtime_error", "The R frame contract returned invalid export capabilities")
      }
      unname(available)
    }

    remove_export <- function(export_id) {
      if (!exists(export_id, envir = artifacts, inherits = FALSE)) return(invisible(FALSE))
      artifact <- get(export_id, envir = artifacts, inherits = FALSE)
      if (isTRUE(artifact$managed) && file.exists(artifact$path)) {
        if (!artifact_matches(artifact$path, artifact$receipt)) {
          fail("runtime_error", "The private R export changed before it could be removed")
        }
        removed <- unlink(artifact$path, force = TRUE)
        if (!identical(removed, 0L) || file.exists(artifact$path)) {
          stop("Open Wrangler could not remove a private R kernel export.", call. = FALSE)
        }
      }
      rm(list = export_id, envir = artifacts)
      invisible(TRUE)
    }

    create <- function(session_id, revision, export_id, capture, options, publish) {
      if (!is.function(publish)) {
        stop("Open Wrangler received an invalid R export publication callback.", call. = FALSE)
      }
      if (exists(export_id, envir = artifacts, inherits = FALSE)) {
        fail("invalid_request", "The requested R export identity is already in use", TRUE)
      }
      if (!is.function(frame_contract$normalize_export_options)) {
        fail("runtime_error", "The R frame contract does not provide export options")
      }
      export_options <- tryCatch(
        frame_contract$normalize_export_options(options),
        openwrangler_r_frame_error = function(error) {
          fail("invalid_request", conditionMessage(error), TRUE)
        },
        error = function(error) {
          fail("invalid_request", "Native R data export options are invalid", TRUE)
        }
      )
      format <- export_options$format
      if (!format %in% formats()) {
        fail(
          "missing_package",
          "Parquet export requires nanoparquet 0.5.1 or newer in the selected R runtime",
          TRUE
        )
      }
      artifact_path <- file.path(
        export_root,
        paste0(export_id, if (identical(format, "csv")) ".csv" else ".parquet")
      )
      receipt <- NULL
      completed <- FALSE
      on.exit({
        if (
          !completed &&
            !is.null(receipt) &&
            file.exists(artifact_path) &&
            artifact_matches(artifact_path, receipt)
        ) {
          try(unlink(artifact_path, force = TRUE), silent = TRUE)
        }
      }, add = TRUE)
      writer <- if (identical(format, "csv")) frame_contract$write_csv else frame_contract$write_parquet
      if (!is.function(writer)) {
        fail("runtime_error", "The R frame contract does not provide the selected export writer")
      }
      exported <- writer(capture, artifact_path, export_options)
      receipt <- artifact_receipt(artifact_path, fail)
      if (!identical(receipt$size, as.double(exported$bytes))) {
        fail("runtime_error", "The private R export size changed after it was written")
      }
      result <- list(
        format = format,
        rows = exported$rows,
        columns = exported$columns,
        bytes = exported$bytes
      )
      response <- publish(result)
      if (owns_export_root) {
        assign(
          export_id,
          list(
            sessionId = session_id,
            revision = as.double(revision),
            path = artifact_path,
            bytes = as.double(exported$bytes),
            managed = TRUE,
            receipt = receipt
          ),
          envir = artifacts
        )
      }
      completed <- TRUE
      response
    }

    read <- function(session_id, revision, export_id, offset, limit) {
      if (!exists(export_id, envir = artifacts, inherits = FALSE)) {
        fail("invalid_request", "The requested R export is no longer available", TRUE)
      }
      artifact <- get(export_id, envir = artifacts, inherits = FALSE)
      if (!isTRUE(artifact$managed)) {
        fail("invalid_request", "The requested R export is no longer available", TRUE)
      }
      if (
        !identical(artifact$sessionId, session_id) ||
          !identical(artifact$revision, as.double(revision))
      ) {
        fail("invalid_request", "The requested R export belongs to a different session revision", TRUE)
      }
      offset <- whole_number(offset, "request.payload.offset", artifact$bytes, fail)
      limit <- whole_number(limit, "request.payload.limit", maximum_export_chunk_bytes, fail)
      if (limit < 1L) fail("invalid_request", "request.payload.limit must be positive", TRUE)
      if (!artifact_matches(artifact$path, artifact$receipt)) {
        fail("runtime_error", "The private R export changed before it could be read")
      }
      connection <- NULL
      on.exit({
        if (!is.null(connection)) try(close(connection), silent = TRUE)
      }, add = TRUE)
      chunk <- tryCatch(
        {
          connection <- file(artifact$path, open = "rb")
          seek(connection, where = offset, origin = "start", rw = "read")
          value <- readBin(connection, what = "raw", n = min(limit, artifact$bytes - offset))
          close(connection)
          connection <- NULL
          value
        },
        error = function(error) fail("runtime_error", "The private R export could not be read")
      )
      if (!is.null(connection)) close(connection)
      if (!artifact_matches(artifact$path, artifact$receipt)) {
        fail("runtime_error", "The private R export changed while it was read")
      }
      if (offset < artifact$bytes && length(chunk) == 0L) {
        fail("runtime_error", "The private R export ended before its recorded size")
      }
      list(offset = offset, bytes = length(chunk), data = canonical_base64(chunk))
    }

    close_export <- function(session_id, revision, export_id) {
      if (exists(export_id, envir = artifacts, inherits = FALSE)) {
        artifact <- get(export_id, envir = artifacts, inherits = FALSE)
        if (
          !identical(artifact$sessionId, session_id) ||
            !identical(artifact$revision, as.double(revision))
        ) {
          fail("invalid_request", "The requested R export belongs to a different session revision", TRUE)
        }
        remove_export(export_id)
      }
      invisible(NULL)
    }

    close_session <- function(session_id) {
      for (export_id in ls(envir = artifacts, all.names = TRUE)) {
        artifact <- get(export_id, envir = artifacts, inherits = FALSE)
        if (is.list(artifact) && identical(artifact$sessionId, session_id)) remove_export(export_id)
      }
      invisible(NULL)
    }

    dispose <- function() {
      for (export_id in ls(envir = artifacts, all.names = TRUE)) remove_export(export_id)
      if (owns_export_root && initialized_export_root && dir.exists(export_root)) {
        removed <- unlink(export_root, recursive = TRUE, force = TRUE)
        if (!identical(removed, 0L) || dir.exists(export_root)) {
          stop("Open Wrangler could not remove its private R kernel export directory.", call. = FALSE)
        }
      }
      initialized_export_root <<- FALSE
      invisible(NULL)
    }

    construction_complete <- TRUE
    list(
      formats = formats,
      create = create,
      read = read,
      close = close_export,
      close_session = close_session,
      dispose = dispose
    )
  }

  list(new_lifecycle = new_lifecycle)
})
