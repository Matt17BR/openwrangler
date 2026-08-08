local({
args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 0L) {
  stop("Open Wrangler R process agent received invalid startup arguments.", call. = FALSE)
}

startup_names <- c(
  "OPEN_WRANGLER_R_RUNTIME_ROOT",
  "OPEN_WRANGLER_R_DOCUMENT_ROOT",
  "OPEN_WRANGLER_R_RESPONSE_ROOT",
  "OPEN_WRANGLER_R_EXPORT_ROOT"
)
startup_values <- Sys.getenv(startup_names, unset = NA_character_)
Sys.unsetenv(startup_names)
if (anyNA(startup_values) || any(!nzchar(startup_values))) {
  stop("Open Wrangler R process agent received incomplete startup metadata.", call. = FALSE)
}

runtime_root <- normalizePath(startup_values[[1L]], winslash = "/", mustWork = TRUE)
document_root <- normalizePath(startup_values[[2L]], winslash = "/", mustWork = TRUE)
response_root <- normalizePath(startup_values[[3L]], winslash = "/", mustWork = TRUE)
export_root <- normalizePath(startup_values[[4L]], winslash = "/", mustWork = TRUE)

protocol_version <- 1L
maximum_request_bytes <- 16L * 1024L * 1024L
maximum_response_bytes <- 17L * 1024L * 1024L
maximum_ready_bytes <- 64L * 1024L
maximum_source_bytes <- 64L * 1024L * 1024L
maximum_source_units <- 1024L
maximum_error_bytes <- 4096L
maximum_scanned_bindings <- 4096L
maximum_variables <- 256L
maximum_name_bytes <- 1024L
identifier_pattern <- "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

bounded_message <- function(error, fallback) {
  value <- conditionMessage(error)
  if (!is.character(value) || length(value) != 1L || is.na(value) || Encoding(value) == "bytes") {
    return(fallback)
  }
  converted <- iconv(value, from = "", to = "UTF-8", sub = NA_character_)
  converted <- gsub("[\\r\\n\\t]+", " ", converted, perl = TRUE)
  if (
    is.na(converted) ||
      grepl("[[:cntrl:]]", converted, perl = TRUE) ||
      nchar(converted, type = "bytes") > maximum_error_bytes
  ) {
    fallback
  } else {
    converted
  }
}

atomic_write_raw <- function(path, bytes) {
  if (!is.raw(bytes)) stop("Open Wrangler received a non-raw response payload.", call. = FALSE)
  temporary <- file.path(
    response_root,
    sprintf(".%s-%d-%08x.tmp", basename(path), Sys.getpid(), sample.int(.Machine$integer.max, 1L))
  )
  connection <- NULL
  completed <- FALSE
  on.exit({
    if (!is.null(connection)) try(close(connection), silent = TRUE)
    if (!completed && file.exists(temporary)) try(unlink(temporary, force = TRUE), silent = TRUE)
  }, add = TRUE)
  connection <- file(temporary, open = "wb")
  writeBin(bytes, connection, useBytes = TRUE)
  flush(connection)
  close(connection)
  connection <- NULL
  if (!file.rename(temporary, path)) {
    stop("Open Wrangler could not publish an R process response.", call. = FALSE)
  }
  completed <- TRUE
  invisible(NULL)
}

atomic_write_json <- function(path, value, maximum_bytes) {
  encoded <- as.character(jsonlite::toJSON(
    value,
    auto_unbox = TRUE,
    digits = NA,
    na = "null",
    null = "null",
    pretty = FALSE
  ))
  bytes <- charToRaw(enc2utf8(encoded))
  if (length(bytes) > maximum_bytes) {
    stop("Open Wrangler rejected an oversized R process response.", call. = FALSE)
  }
  atomic_write_raw(path, bytes)
}

ready_path <- file.path(response_root, "ready.json")

if (!requireNamespace("jsonlite", quietly = TRUE)) {
  atomic_write_raw(
    ready_path,
    charToRaw('{"protocolVersion":1,"status":"error","message":"Open Wrangler requires the jsonlite R package."}')
  )
  quit(save = "no", status = 1L, runLast = FALSE)
}

if (!requireNamespace("rlang", quietly = TRUE)) {
  atomic_write_raw(
    ready_path,
    charToRaw('{"protocolVersion":1,"status":"error","message":"Open Wrangler requires the rlang R package."}')
  )
  quit(save = "no", status = 1L, runLast = FALSE)
}

initialize <- function() {
  source_names <- sort(list.files(document_root, all.files = TRUE, no.. = TRUE), method = "radix")
  if (
    length(source_names) < 1L ||
      length(source_names) > maximum_source_units ||
      any(!grepl("^[0-9]{8}\\.R$", source_names, perl = TRUE))
  ) {
    stop("The R document contains an invalid set of source units.", call. = FALSE)
  }
  source_paths <- file.path(document_root, source_names)
  source_info <- file.info(source_paths)
  source_sizes <- source_info$size
  if (
    anyNA(source_sizes) ||
      any(!is.finite(source_sizes)) ||
      any(source_sizes < 0) ||
      any(source_info$isdir) ||
      sum(source_sizes) > maximum_source_bytes
  ) {
    stop("The R document is outside the supported 64 MiB source limit.", call. = FALSE)
  }

  source_expressions <- lapply(seq_along(source_paths), function(index) {
    source_connection <- file(source_paths[[index]], open = "rb")
    source_bytes <- tryCatch(
      readBin(source_connection, what = "raw", n = as.integer(source_sizes[[index]])),
      finally = close(source_connection)
    )
    if (length(source_bytes) != source_sizes[[index]]) {
      stop("Open Wrangler could not read a complete R source unit.", call. = FALSE)
    }
    source_text <- rawToChar(source_bytes)
    Encoding(source_text) <- "UTF-8"
    tryCatch(
      parse(text = source_text, srcfile = NULL, encoding = "UTF-8", keep.source = FALSE),
      error = function(error) {
        stop(
          sprintf("R cell %d could not be parsed: %s", index, bounded_message(error, "R parse failed.")),
          call. = FALSE
        )
      }
    )
  })

  # The file runs once in its own environment. Its parent is the process global
  # environment so ordinary package lookup behaves like source(local = TRUE),
  # while file bindings cannot overwrite the private transport runtime.
  document_environment <- new.env(hash = TRUE, parent = globalenv())
  for (expressions in source_expressions) eval(expressions, envir = document_environment)

  runtime_environment <- new.env(hash = TRUE, parent = baseenv())
  sys.source(file.path(runtime_root, "frame_contract.R"), envir = runtime_environment, keep.source = FALSE)
  sys.source(file.path(runtime_root, "kernel_agent.R"), envir = runtime_environment, keep.source = FALSE)

  frame_contract <- get("openwrangler_r_frame_contract", envir = runtime_environment, inherits = FALSE)
  kernel_agent <- get("openwrangler_r_kernel_agent", envir = runtime_environment, inherits = FALSE)
  agent <- kernel_agent$new_agent(frame_contract, document_environment, export_root)

  names <- sort(ls(envir = document_environment, all.names = TRUE, sorted = FALSE), method = "radix")
  truncated <- length(names) > maximum_scanned_bindings
  if (truncated) names <- names[seq_len(maximum_scanned_bindings)]
  variables <- list()
  failed_binding <- new.env(parent = emptyenv())

  for (name in names) {
    if (bindingIsActive(name, document_environment)) next
    is_lazy <- tryCatch(
      rlang::env_binding_are_lazy(document_environment, name)[[1L]],
      error = function(error) TRUE
    )
    if (!identical(is_lazy, FALSE)) next
    utf8_name <- iconv(name, from = "", to = "UTF-8", sub = NA_character_)
    if (
      is.na(utf8_name) ||
        identical(utf8_name, "") ||
        nchar(utf8_name, type = "bytes") > maximum_name_bytes ||
        grepl("[[:cntrl:]]", utf8_name, perl = TRUE)
    ) {
      next
    }
    value <- tryCatch(
      get(name, envir = document_environment, inherits = FALSE),
      error = function(error) failed_binding
    )
    if (identical(value, failed_binding)) next
    classes <- class(value)
    flavor <- if (identical(classes, c("data.table", "data.frame"))) {
      "r.data.table"
    } else if (
      identical(classes, c("tbl_df", "tbl", "data.frame")) ||
        identical(classes, c("spec_tbl_df", "tbl_df", "tbl", "data.frame"))
    ) {
      "r.tibble"
    } else if (identical(classes, "data.frame")) {
      "r.data.frame"
    } else {
      NULL
    }
    if (is.null(flavor)) next
    if (length(variables) >= maximum_variables) {
      truncated <- TRUE
      break
    }
    variables[[length(variables) + 1L]] <- list(name = utf8_name, dataframeFlavor = flavor)
  }

  list(agent = agent, variables = variables, truncated = truncated)
}

initialized <- tryCatch(
  initialize(),
  error = function(error) {
    atomic_write_json(
      ready_path,
      list(
        protocolVersion = protocol_version,
        status = "error",
        message = bounded_message(error, "Open Wrangler could not execute the R document.")
      ),
      maximum_ready_bytes
    )
    NULL
  }
)

if (is.null(initialized)) {
  quit(save = "no", status = 1L, runLast = FALSE)
}

ready_variables <- initialized$variables
ready_truncated <- initialized$truncated
repeat {
  ready_payload <- as.character(jsonlite::toJSON(
    list(
      protocolVersion = protocol_version,
      status = "ready",
      truncated = ready_truncated,
      variables = ready_variables
    ),
    auto_unbox = TRUE,
    digits = NA,
    na = "null",
    null = "null",
    pretty = FALSE
  ))
  ready_bytes <- charToRaw(enc2utf8(ready_payload))
  if (length(ready_bytes) <= maximum_ready_bytes) break
  if (length(ready_variables) == 0L) {
    stop("Open Wrangler could not encode bounded R process startup data.", call. = FALSE)
  }
  ready_variables <- ready_variables[-length(ready_variables)]
  ready_truncated <- TRUE
}
atomic_write_raw(ready_path, ready_bytes)

input <- file("stdin", open = "rb")
on.exit(close(input), add = TRUE)

repeat {
  frame_length <- readBin(input, what = "integer", n = 1L, size = 4L, signed = TRUE, endian = "big")
  if (length(frame_length) == 0L) break
  if (frame_length < 38L || frame_length > maximum_request_bytes + 37L) {
    stop("Open Wrangler rejected an invalid R process request frame.", call. = FALSE)
  }
  frame <- readBin(input, what = "raw", n = frame_length)
  if (length(frame) != frame_length) {
    stop("Open Wrangler received a truncated R process request frame.", call. = FALSE)
  }
  request_id <- rawToChar(frame[seq_len(36L)])
  if (
    !grepl(identifier_pattern, request_id, perl = TRUE) ||
      !identical(frame[[37L]], charToRaw("\n")[[1L]])
  ) {
    stop("Open Wrangler rejected an invalid R process request envelope.", call. = FALSE)
  }
  payload <- rawToChar(frame[seq.int(38L, length(frame))])
  Encoding(payload) <- "UTF-8"
  response <- initialized$agent$dispatch_json(payload)
  response_bytes <- charToRaw(enc2utf8(response))
  if (length(response_bytes) > maximum_response_bytes) {
    stop("Open Wrangler rejected an oversized R process response.", call. = FALSE)
  }
  atomic_write_raw(file.path(response_root, paste0(request_id, ".json")), response_bytes)
}
})
