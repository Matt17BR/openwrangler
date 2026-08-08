openwrangler_r_interactive_agent <- local({
  protocol_version <- 1L
  kernel_transport_version <- 9L
  maximum_request_bytes <- 16L * 1024L * 1024L
  maximum_response_bytes <- 17L * 1024L * 1024L
  maximum_error_bytes <- 4096L
  maximum_discovery_bytes <- 64L * 1024L
  maximum_scanned_bindings <- 4096L
  maximum_variables <- 256L
  maximum_name_bytes <- 1024L
  runtime_binding <- ".openwrangler_r_kernel_runtime_872e5b61"
  terminal_binding <- ".openwrangler_r_interactive_terminal_872e5b61"
  dispatcher_binding <- ".openwrangler_r_interactive_dispatcher_872e5b61"
  runtime_owner <- "openwrangler-native-r-runtime-v1"
  identifier_pattern <- "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
  command_binding_pattern <- "^\\.openwrangler_r_request_[a-f0-9]{16}$"
  transport_contexts <- new.env(parent = emptyenv())

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
    ) fallback else converted
  }

  validate_path <- function(value, label, must_work) {
    if (!is.character(value) || length(value) != 1L || is.na(value) || !nzchar(value)) {
      stop(sprintf("Open Wrangler received an invalid %s.", label), call. = FALSE)
    }
    normalizePath(value, winslash = "/", mustWork = must_work)
  }

  validate_identifier <- function(value, label) {
    if (!is.character(value) || length(value) != 1L || is.na(value) || !grepl(identifier_pattern, value, perl = TRUE)) {
      stop(sprintf("Open Wrangler received an invalid %s.", label), call. = FALSE)
    }
    value
  }

  read_request_payload <- function(request_path) {
    connection <- file(request_path, open = "rb")
    bytes <- tryCatch(
      readBin(connection, what = "raw", n = maximum_request_bytes + 1L),
      finally = close(connection)
    )
    if (length(bytes) > maximum_request_bytes) {
      stop("Open Wrangler rejected an oversized interactive R request.", call. = FALSE)
    }
    payload <- rawToChar(bytes)
    Encoding(payload) <- "UTF-8"
    payload
  }

  extract_json_field <- function(payload, field, pattern) {
    match <- regexec(
      sprintf('"%s"[[:space:]]*:[[:space:]]*"(%s)"', field, pattern),
      payload,
      perl = TRUE
    )
    captures <- regmatches(payload, match)[[1L]]
    if (length(captures) == 2L) captures[[2L]] else ""
  }

  missing_jsonlite_response <- function(request_id) {
    sprintf(
      paste0(
        '{"transportVersion":%d,"requestId":"%s","kind":"error",',
        '"code":"missing_package","message":"Open Wrangler requires the jsonlite package ',
        "in the active R session. Install it with install.packages('jsonlite').",
        '","recoverable":true}'
      ),
      kernel_transport_version,
      request_id
    )
  }

  missing_jsonlite_teardown <- function(request_id) {
    sprintf(
      '{"protocolVersion":%d,"requestId":"%s","status":"closed"}',
      protocol_version,
      request_id
    )
  }

  atomic_write <- function(response_path, payload) {
    bytes <- charToRaw(enc2utf8(payload))
    if (length(bytes) > maximum_response_bytes) {
      stop("Open Wrangler rejected an oversized interactive R response.", call. = FALSE)
    }
    temporary <- paste0(response_path, ".tmp")
    connection <- NULL
    published <- FALSE
    on.exit({
      if (!is.null(connection)) try(close(connection), silent = TRUE)
      if (!published && file.exists(temporary)) try(unlink(temporary, force = TRUE), silent = TRUE)
    }, add = TRUE)
    connection <- file(temporary, open = "wb")
    writeBin(bytes, connection, useBytes = TRUE)
    flush(connection)
    close(connection)
    connection <- NULL
    if (!file.rename(temporary, response_path)) {
      stop("Open Wrangler could not publish its private interactive R response.", call. = FALSE)
    }
    published <- TRUE
    invisible(NULL)
  }

  encode_json <- function(value) {
    as.character(jsonlite::toJSON(
      value,
      auto_unbox = TRUE,
      digits = NA,
      na = "null",
      null = "null",
      pretty = FALSE
    ))
  }

  error_response <- function(request_id, error) {
    encode_json(list(
      transportVersion = kernel_transport_version,
      requestId = request_id,
      kind = "error",
      code = "runtime_error",
      message = bounded_message(error, "The interactive R request failed."),
      recoverable = FALSE
    ))
  }

  dataframe_flavor <- function(value) {
    classes <- class(value)
    if (identical(classes, c("data.table", "data.frame"))) {
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
  }

  discovery_response <- function(request_id, truncated, variables) {
    encode_json(list(
      protocolVersion = protocol_version,
      requestId = request_id,
      status = "ready",
      truncated = truncated,
      variables = variables
    ))
  }

  discover_variables <- function(request_id) {
    if (!requireNamespace("rlang", quietly = TRUE)) {
      stop("Open Wrangler requires the rlang package in the active R session.", call. = FALSE)
    }
    names <- sort(ls(envir = .GlobalEnv, all.names = TRUE, sorted = FALSE), method = "radix")
    truncated <- length(names) > maximum_scanned_bindings
    if (truncated) names <- names[seq_len(maximum_scanned_bindings)]
    variables <- list()
    failed_binding <- new.env(parent = emptyenv())
    for (name in names) {
      if (identical(name, runtime_binding) || bindingIsActive(name, .GlobalEnv)) next
      is_lazy <- tryCatch(
        rlang::env_binding_are_lazy(.GlobalEnv, name)[[1L]],
        error = function(error) TRUE
      )
      if (!identical(is_lazy, FALSE)) next
      utf8_name <- iconv(name, from = "", to = "UTF-8", sub = NA_character_)
      if (
        is.na(utf8_name) ||
          !nzchar(utf8_name) ||
          nchar(utf8_name, type = "bytes") > maximum_name_bytes ||
          grepl("[[:cntrl:]]", utf8_name, perl = TRUE)
      ) next
      value <- tryCatch(
        get(name, envir = .GlobalEnv, inherits = FALSE),
        error = function(error) failed_binding
      )
      if (identical(value, failed_binding)) next
      flavor <- dataframe_flavor(value)
      if (is.null(flavor)) next
      if (length(variables) >= maximum_variables) {
        truncated <- TRUE
        break
      }
      candidate <- c(variables, list(list(name = utf8_name, dataframeFlavor = flavor)))
      if (nchar(discovery_response(request_id, FALSE, candidate), type = "bytes") > maximum_discovery_bytes) {
        truncated <- TRUE
        break
      }
      variables <- candidate
    }
    discovery_response(request_id, truncated, variables)
  }

  ensure_runtime <- function(runtime_root, owner_token, bundle_id) {
    existing <- if (exists(runtime_binding, envir = .GlobalEnv, inherits = FALSE)) {
      get(runtime_binding, envir = .GlobalEnv, inherits = FALSE)
    } else {
      NULL
    }
    if (is.null(existing)) {
      runtime <- new.env(hash = TRUE, parent = baseenv())
      sys.source(file.path(runtime_root, "frame_contract.R"), envir = runtime, keep.source = FALSE)
      sys.source(file.path(runtime_root, "kernel_agent.R"), envir = runtime, keep.source = FALSE)
      runtime$agent <- runtime$openwrangler_r_kernel_agent$new_agent(
        runtime$openwrangler_r_frame_contract,
        .GlobalEnv
      )
      runtime$ownerToken <- runtime_owner
      runtime$bundleId <- bundle_id
      runtime$transportOwners <- new.env(parent = emptyenv())
      assign(owner_token, TRUE, envir = runtime$transportOwners)
      lockEnvironment(runtime, bindings = TRUE)
      assign(runtime_binding, runtime, envir = .GlobalEnv)
      return(runtime)
    }
    if (
      !is.environment(existing) ||
        !identical(existing$ownerToken, runtime_owner) ||
        !identical(existing$bundleId, bundle_id) ||
        !is.environment(existing$transportOwners)
    ) {
      stop("Restart the R session before loading this Open Wrangler runtime version.", call. = FALSE)
    }
    assign(owner_token, TRUE, envir = existing$transportOwners)
    existing
  }

  teardown_runtime <- function(request_id, owner_token, bundle_id) {
    if (exists(runtime_binding, envir = .GlobalEnv, inherits = FALSE)) {
      runtime <- get(runtime_binding, envir = .GlobalEnv, inherits = FALSE)
      if (
        is.environment(runtime) &&
          identical(runtime$ownerToken, runtime_owner) &&
          identical(runtime$bundleId, bundle_id) &&
          is.environment(runtime$transportOwners) &&
          exists(owner_token, envir = runtime$transportOwners, inherits = FALSE)
      ) {
        if (length(ls(envir = runtime$transportOwners, all.names = TRUE)) == 1L) {
          disposal_error <- tryCatch({
            runtime$agent$dispose()
            NULL
          }, error = function(error) error)
          remove(list = owner_token, envir = runtime$transportOwners, inherits = FALSE)
          remove(list = runtime_binding, envir = .GlobalEnv, inherits = FALSE)
          if (!is.null(disposal_error)) stop(disposal_error)
        } else {
          remove(list = owner_token, envir = runtime$transportOwners, inherits = FALSE)
        }
      }
    }
    encode_json(list(protocolVersion = protocol_version, requestId = request_id, status = "closed"))
  }

  claim_terminal <- function(owner_token, allow_claim) {
    claims <- if (exists(terminal_binding, envir = .GlobalEnv, inherits = FALSE)) {
      get(terminal_binding, envir = .GlobalEnv, inherits = FALSE)
    } else {
      NULL
    }
    if (is.null(claims)) {
      if (!identical(allow_claim, TRUE)) {
        stop("The active R terminal changed. Reopen the dataframe from its original R session.", call. = FALSE)
      }
      claims <- new.env(parent = emptyenv())
      assign(terminal_binding, claims, envir = .GlobalEnv)
    }
    if (!is.environment(claims)) {
      stop("Open Wrangler cannot reserve its private interactive R terminal binding.", call. = FALSE)
    }
    if (!exists(owner_token, envir = claims, inherits = FALSE)) {
      if (!identical(allow_claim, TRUE)) {
        stop("The active R terminal changed. Reopen the dataframe from its original R session.", call. = FALSE)
      }
      assign(owner_token, TRUE, envir = claims)
    }
    invisible(NULL)
  }

  release_terminal <- function(owner_token) {
    if (!exists(terminal_binding, envir = .GlobalEnv, inherits = FALSE)) return(invisible(NULL))
    claims <- get(terminal_binding, envir = .GlobalEnv, inherits = FALSE)
    if (!is.environment(claims) || !exists(owner_token, envir = claims, inherits = FALSE)) {
      return(invisible(NULL))
    }
    remove(list = owner_token, envir = claims, inherits = FALSE)
    if (length(ls(envir = claims, all.names = TRUE)) == 0L) {
      remove(list = terminal_binding, envir = .GlobalEnv, inherits = FALSE)
    }
    invisible(NULL)
  }

  release_transport_context <- function(owner_token, bundle_id) {
    if (!exists(owner_token, envir = transport_contexts, inherits = FALSE)) return(invisible(NULL))
    context <- get(owner_token, envir = transport_contexts, inherits = FALSE)
    if (!is.environment(context) || !identical(context$bundleId, bundle_id)) return(invisible(NULL))
    if (exists(context$commandBinding, envir = .GlobalEnv, inherits = FALSE)) {
      current <- get(context$commandBinding, envir = .GlobalEnv, inherits = FALSE)
      if (identical(current, context$command)) {
        remove(list = context$commandBinding, envir = .GlobalEnv, inherits = FALSE)
      }
    }
    remove(list = owner_token, envir = transport_contexts, inherits = FALSE)
    if (
      length(ls(envir = transport_contexts, all.names = TRUE)) == 0L &&
        !exists(terminal_binding, envir = .GlobalEnv, inherits = FALSE) &&
        exists(dispatcher_binding, envir = .GlobalEnv, inherits = FALSE)
    ) {
      dispatcher <- get(dispatcher_binding, envir = .GlobalEnv, inherits = FALSE)
      if (
        is.environment(dispatcher) &&
          identical(dispatcher$bundle_id, bundle_id) &&
          identical(dispatcher$openwrangler_r_interactive_agent, openwrangler_r_interactive_agent)
      ) {
        remove(list = dispatcher_binding, envir = .GlobalEnv, inherits = FALSE)
      }
    }
    invisible(NULL)
  }

  register_transport <- function(
    owner_token,
    runtime_root,
    bundle_id,
    request_directory,
    response_directory,
    command_binding
  ) {
    if (!grepl("^[A-Za-z0-9._:-]{1,128}$", owner_token, perl = TRUE)) {
      stop("Open Wrangler received an invalid runtime owner.", call. = FALSE)
    }
    if (!grepl("^[a-f0-9]{16}$", bundle_id, perl = TRUE)) {
      stop("Open Wrangler received an invalid runtime bundle identity.", call. = FALSE)
    }
    if (!grepl(command_binding_pattern, command_binding, perl = TRUE)) {
      stop("Open Wrangler received an invalid private R command binding.", call. = FALSE)
    }
    runtime_root <- validate_path(runtime_root, "runtime root", TRUE)
    request_directory <- validate_path(request_directory, "request directory", TRUE)
    response_directory <- validate_path(response_directory, "response directory", TRUE)
    if (exists(owner_token, envir = transport_contexts, inherits = FALSE)) {
      existing <- get(owner_token, envir = transport_contexts, inherits = FALSE)
      if (
        !is.environment(existing) ||
          !identical(existing$runtimeRoot, runtime_root) ||
          !identical(existing$bundleId, bundle_id) ||
          !identical(existing$requestDirectory, request_directory) ||
          !identical(existing$responseDirectory, response_directory) ||
          !identical(existing$commandBinding, command_binding)
      ) {
        stop("Restart R before reconnecting this Open Wrangler transport.", call. = FALSE)
      }
      return(invisible(NULL))
    }
    context <- new.env(parent = emptyenv())
    context$runtimeRoot <- runtime_root
    context$bundleId <- bundle_id
    context$requestDirectory <- request_directory
    context$responseDirectory <- response_directory
    context$commandBinding <- command_binding
    context$hasDispatched <- FALSE
    bound_owner <- owner_token
    context$command <- function(request_id) dispatch_registered(bound_owner, request_id)
    assign(command_binding, context$command, envir = .GlobalEnv)
    assign(owner_token, context, envir = transport_contexts)
    invisible(NULL)
  }

  dispatch_registered <- function(owner_token, request_id) {
    validate_identifier(request_id, "request identity")
    if (!exists(owner_token, envir = transport_contexts, inherits = FALSE)) {
      stop("Reopen the dataframe before sending another Open Wrangler request.", call. = FALSE)
    }
    context <- get(owner_token, envir = transport_contexts, inherits = FALSE)
    if (!is.environment(context)) {
      stop("Restart R before reconnecting this Open Wrangler transport.", call. = FALSE)
    }
    request_name <- paste0(request_id, ".json")
    allow_terminal_claim <- !identical(context$hasDispatched, TRUE)
    context$hasDispatched <- TRUE
    dispatch(
      request_path = file.path(context$requestDirectory, request_name),
      response_path = file.path(context$responseDirectory, request_name),
      runtime_root = context$runtimeRoot,
      owner_token = owner_token,
      bundle_id = context$bundleId,
      allow_terminal_claim = allow_terminal_claim
    )
  }

  dispatch <- function(request_path, response_path, runtime_root, owner_token, bundle_id, allow_terminal_claim) {
    request_path <- validate_path(request_path, "request path", TRUE)
    response_parent <- validate_path(dirname(response_path), "response directory", TRUE)
    response_path <- file.path(response_parent, basename(response_path))
    runtime_root <- validate_path(runtime_root, "runtime root", TRUE)
    if (!grepl("^[A-Za-z0-9._:-]{1,128}$", owner_token, perl = TRUE)) {
      stop("Open Wrangler received an invalid runtime owner.", call. = FALSE)
    }
    if (!grepl("^[a-f0-9]{16}$", bundle_id, perl = TRUE)) {
      stop("Open Wrangler received an invalid runtime bundle identity.", call. = FALSE)
    }
    if (!is.logical(allow_terminal_claim) || length(allow_terminal_claim) != 1L || is.na(allow_terminal_claim)) {
      stop("Open Wrangler received an invalid terminal claim state.", call. = FALSE)
    }
    request_payload <- read_request_payload(request_path)
    request_id <- extract_json_field(request_payload, "requestId", "[0-9a-f-]{36}")
    request_kind <- extract_json_field(request_payload, "kind", "[A-Za-z]+")
    if (!requireNamespace("jsonlite", quietly = TRUE)) {
      response <- if (identical(request_kind, "teardownInteractiveRuntime")) {
        release_terminal(owner_token)
        release_transport_context(owner_token, bundle_id)
        missing_jsonlite_teardown(request_id)
      } else {
        missing_jsonlite_response(request_id)
      }
      atomic_write(response_path, response)
      return(invisible(NULL))
    }
    request <- list(
      payload = request_payload,
      value = jsonlite::fromJSON(request_payload, simplifyVector = FALSE)
    )
    response <- tryCatch({
      validate_identifier(request_id, "request identity")
      claim_terminal(owner_token, allow_terminal_claim)
      if (identical(request$value$kind, "discoverInteractiveVariables")) {
        discover_variables(request_id)
      } else if (identical(request$value$kind, "teardownInteractiveRuntime")) {
        tryCatch(
          teardown_runtime(request_id, owner_token, bundle_id),
          finally = {
            release_terminal(owner_token)
            release_transport_context(owner_token, bundle_id)
          }
        )
      } else {
        runtime <- ensure_runtime(runtime_root, owner_token, bundle_id)
        runtime$agent$dispatch_json(request$payload)
      }
    }, error = function(error) error_response(request_id, error))
    if (nchar(response, type = "bytes") > maximum_response_bytes) {
      response <- error_response(request_id, simpleError("The interactive R response exceeded Open Wrangler's size limit."))
    }
    atomic_write(response_path, response)
    invisible(NULL)
  }

  list(
    dispatch = dispatch,
    dispatch_registered = dispatch_registered,
    register_transport = register_transport,
    protocol_version = protocol_version
  )
})
