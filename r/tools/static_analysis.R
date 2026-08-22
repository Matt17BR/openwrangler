openwrangler_r_static_analysis <- local({
  protocol <- "openwrangler-native-r-static-analysis-v2"
  codetools_version <- "0.2-20"
  pinned_ci_r_version <- "4.5.3"
  production_paths <- c(
    "r/openwrangler_runtime/frame_contract.R",
    "r/openwrangler_runtime/interactive_agent.R",
    "r/openwrangler_runtime/kernel_agent.R",
    "r/openwrangler_runtime/process_agent.R"
  )
  rule_names <- c(
    "undefined-symbol",
    "partial-argument",
    "global-assignment",
    "unqualified-call",
    "namespace-attachment",
    "unreachable-expression"
  )
  policy_fields <- c(
    "Protocol",
    "Codetools-Version",
    "Supported-R-Minors",
    "Pinned-CI-R-Version",
    "Production-Paths",
    "Maximum-Source-Bytes",
    "Maximum-Aggregate-Source-Bytes",
    "Maximum-AST-Nodes",
    "Maximum-AST-Depth",
    "Maximum-Diagnostics",
    "Maximum-Suppressions",
    "Maximum-Candidate-State-Work",
    "Maximum-Operation-Work",
    "Maximum-Span-Lookup-Work",
    "Maximum-Diagnostic-Bytes",
    "Maximum-Total-Work",
    "Ratchet-Undefined-Symbol",
    "Ratchet-Partial-Argument",
    "Ratchet-Global-Assignment",
    "Ratchet-Unqualified-Call",
    "Ratchet-Namespace-Attachment",
    "Ratchet-Unreachable-Expression"
  )
  ratchet_fields <- structure(
    c(
      "Ratchet-Undefined-Symbol",
      "Ratchet-Partial-Argument",
      "Ratchet-Global-Assignment",
      "Ratchet-Unqualified-Call",
      "Ratchet-Namespace-Attachment",
      "Ratchet-Unreachable-Expression"
    ),
    names = rule_names
  )

  fail <- function(message) {
    stop(sprintf("Native R static analysis: %s", message), call. = FALSE)
  }

  active_work_budget <- NULL
  active_scope_serial <- NULL

  optional_limit <- function(limits, name, fallback) {
    value <- limits[[name]]
    if (is.null(value)) value <- fallback
    if (length(value) != 1L || is.na(value) || !is.finite(value) || value < 1 ||
        value != floor(value) || value > .Machine$integer.max) {
      fail(sprintf("analysis %s bound is invalid", name))
    }
    as.integer(value)
  }

  make_work_budget <- function(limits) {
    ast_nodes <- as.double(limits$ast_nodes)
    defaults <- list(
      candidate_states = min(.Machine$integer.max, max(64, ast_nodes * 4)),
      operations = min(.Machine$integer.max, max(1024, ast_nodes * 64)),
      span_lookups = min(.Machine$integer.max, max(1024, ast_nodes * 16)),
      diagnostic_bytes = min(8388608, max(65536, as.double(limits$source_bytes) * 4)),
      total_work = min(.Machine$integer.max, max(4096, ast_nodes * 96))
    )
    maximum <- vapply(names(defaults), function(name) optional_limit(limits, name, defaults[[name]]), integer(1L))
    used <- structure(numeric(length(maximum)), names = names(maximum))
    charge <- function(name, amount = 1L) {
      if (!(name %in% names(maximum)) || length(amount) != 1L || is.na(amount) ||
          !is.finite(amount) || amount < 0 || amount != floor(amount)) {
        fail("an analyzer work charge is invalid")
      }
      if (identical(name, "total_work")) fail("total analyzer work cannot be charged directly")
      if (amount > maximum[[name]] - used[[name]]) {
        fail(sprintf(
          "analysis %s work exceeds its bound (%d + %d > %d)",
          gsub("_", " ", name, fixed = TRUE), used[[name]], amount, maximum[[name]]
        ))
      }
      if (amount > maximum[["total_work"]] - used[["total_work"]]) {
        fail(sprintf(
          "analysis total work exceeds its bound (%d + %d > %d)",
          used[["total_work"]], amount, maximum[["total_work"]]
        ))
      }
      used[[name]] <<- used[[name]] + amount
      used[["total_work"]] <<- used[["total_work"]] + amount
      invisible(NULL)
    }
    list(charge = charge, used = function() used, maximum = maximum)
  }

  charge_work <- function(name, amount = 1L) {
    if (!is.null(active_work_budget)) active_work_budget$charge(name, amount)
    invisible(NULL)
  }

  next_scope_state <- function() {
    if (is.null(active_scope_serial)) fail("analysis scope ownership is unavailable")
    if (active_scope_serial >= .Machine$integer.max) fail("analysis scope state exceeds its bound")
    charge_work("candidate_states")
    active_scope_serial <<- active_scope_serial + 1L
    active_scope_serial
  }

  new_scope <- function(bindings = list()) {
    state <- next_scope_state()
    attr(bindings, "openwrangler_scope_owner") <- state
    attr(bindings, "openwrangler_scope_state") <- state
    bindings
  }

  refresh_scope_state <- function(scope) {
    attr(scope, "openwrangler_scope_state") <- next_scope_state()
    scope
  }

  scalar_integer <- function(value, field, minimum = 0L) {
    if (length(value) != 1L || is.na(value) || !grepl("^(0|[1-9][0-9]*)$", value)) {
      fail(sprintf("policy field %s must be a canonical non-negative integer", field))
    }
    number <- suppressWarnings(as.double(value))
    if (!is.finite(number) || number < minimum || number > .Machine$integer.max) {
      fail(sprintf("policy field %s is outside its supported bound", field))
    }
    as.integer(number)
  }

  read_bounded_utf8 <- function(path, maximum_bytes, label) {
    info_before <- file.info(path, extra_cols = FALSE)
    if (nrow(info_before) != 1L || is.na(info_before$isdir) || info_before$isdir ||
        is.na(info_before$size) || info_before$size < 1 || info_before$size > maximum_bytes) {
      fail(sprintf("%s is missing, non-regular, empty, or exceeds %d bytes: %s", label, maximum_bytes, path))
    }
    link <- Sys.readlink(path)
    if (length(link) != 1L || is.na(link) || nzchar(link)) {
      fail(sprintf("%s must not be a symbolic link: %s", label, path))
    }
    connection <- file(path, open = "rb")
    on.exit(close(connection), add = TRUE)
    bytes <- readBin(connection, what = "raw", n = maximum_bytes + 1L)
    if (length(bytes) > maximum_bytes || length(bytes) != info_before$size) {
      fail(sprintf("%s changed or exceeded its byte bound while being read: %s", label, path))
    }
    info_after <- file.info(path, extra_cols = FALSE)
    if (!identical(info_before$size, info_after$size) || !identical(info_before$mtime, info_after$mtime)) {
      fail(sprintf("%s changed while being read: %s", label, path))
    }
    text <- iconv(rawToChar(bytes), from = "UTF-8", to = "UTF-8", sub = NA_character_)
    if (length(text) != 1L || is.na(text)) {
      fail(sprintf("%s is not strict UTF-8: %s", label, path))
    }
    text
  }

  read_policy <- function(root) {
    path <- file.path(root, "r/static-analysis-policy.dcf")
    text <- read_bounded_utf8(path, 16384L, "policy")
    parsed <- tryCatch(
      read.dcf(textConnection(text), all = TRUE),
      error = function(condition) fail(sprintf("policy is malformed: %s", conditionMessage(condition)))
    )
    if (nrow(parsed) != 1L || !identical(sort(colnames(parsed)), sort(policy_fields))) {
      fail("policy must contain exactly the supported fields")
    }
    field <- function(name) unname(parsed[1L, name])
    if (!identical(field("Protocol"), protocol)) fail("policy protocol does not match the analyzer")
    if (!identical(field("Codetools-Version"), codetools_version)) fail("policy codetools version does not match the analyzer")
    if (!identical(field("Pinned-CI-R-Version"), pinned_ci_r_version)) fail("policy pinned CI R version is not exact")
    current_minor <- paste(R.version$major, strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L], sep = ".")
    supported_minors <- strsplit(field("Supported-R-Minors"), ",", fixed = TRUE)[[1L]]
    if (!identical(supported_minors, c("4.4", "4.5")) || !(current_minor %in% supported_minors)) {
      fail(sprintf("R %s is outside the exact supported minor set", current_minor))
    }
    paths <- strsplit(field("Production-Paths"), ",", fixed = TRUE)[[1L]]
    if (!identical(paths, production_paths)) fail("policy production inventory is not exact")
    limits <- list(
      source_bytes = scalar_integer(field("Maximum-Source-Bytes"), "Maximum-Source-Bytes", 1L),
      aggregate_source_bytes = scalar_integer(field("Maximum-Aggregate-Source-Bytes"), "Maximum-Aggregate-Source-Bytes", 1L),
      ast_nodes = scalar_integer(field("Maximum-AST-Nodes"), "Maximum-AST-Nodes", 1L),
      ast_depth = scalar_integer(field("Maximum-AST-Depth"), "Maximum-AST-Depth", 1L),
      diagnostics = scalar_integer(field("Maximum-Diagnostics"), "Maximum-Diagnostics", 1L),
      suppressions = scalar_integer(field("Maximum-Suppressions"), "Maximum-Suppressions", 1L),
      candidate_states = scalar_integer(
        field("Maximum-Candidate-State-Work"), "Maximum-Candidate-State-Work", 1L
      ),
      operations = scalar_integer(field("Maximum-Operation-Work"), "Maximum-Operation-Work", 1L),
      span_lookups = scalar_integer(field("Maximum-Span-Lookup-Work"), "Maximum-Span-Lookup-Work", 1L),
      diagnostic_bytes = scalar_integer(field("Maximum-Diagnostic-Bytes"), "Maximum-Diagnostic-Bytes", 1L),
      total_work = scalar_integer(field("Maximum-Total-Work"), "Maximum-Total-Work", 1L)
    )
    ratchets <- vapply(
      ratchet_fields,
      function(name) scalar_integer(field(name), name),
      integer(1L)
    )
    list(paths = paths, limits = limits, ratchets = ratchets)
  }

  validate_inventory <- function(root, expected = production_paths) {
    runtime_root <- file.path(root, "r/openwrangler_runtime")
    actual <- list.files(
      runtime_root,
      pattern = "[.]R$",
      all.files = TRUE,
      full.names = FALSE,
      recursive = TRUE,
      include.dirs = FALSE,
      no.. = TRUE
    )
    actual <- sort(file.path("r/openwrangler_runtime", actual), method = "radix")
    if (!identical(actual, sort(expected, method = "radix"))) {
      fail(sprintf(
        "production inventory differs (expected: %s; actual: %s)",
        paste(expected, collapse = ", "),
        paste(actual, collapse = ", ")
      ))
    }
    invisible(actual)
  }

  ast_budget <- function(expressions, maximum_nodes, maximum_depth) {
    nodes <- 0L
    visit <- function(node, depth) {
      if (depth > maximum_depth) fail("AST nesting depth exceeds its policy bound")
      nodes <<- nodes + 1L
      if (nodes > maximum_nodes) fail("AST node count exceeds its policy bound")
      if (is.call(node) || is.expression(node) || is.pairlist(node)) {
        for (index in seq_along(node)) {
          if (!identical(node[[index]], quote(expr = ))) visit(node[[index]], depth + 1L)
        }
      }
      invisible(NULL)
    }
    visit(expressions, 0L)
    nodes
  }

  diagnostic_collector <- function(maximum) {
    values <- list()
    keys <- character()
    add <- function(path, line, rule, symbol, detail, operation = NULL) {
      if (is.null(operation)) operation <- sprintf("line:%d", as.integer(line))
      if (!(rule %in% rule_names) || length(path) != 1L || length(symbol) != 1L ||
          length(detail) != 1L || length(operation) != 1L || is.na(path) || is.na(symbol) ||
          is.na(detail) || is.na(operation) || !is.finite(line) || line < 1L ||
          !nzchar(symbol) || !grepl("^[A-Za-z0-9:.-]+$", operation) ||
          nchar(operation, type = "bytes") > 96L) {
        fail("an analyzer emitted an invalid diagnostic")
      }
      key <- paste(path, as.integer(line), operation, rule, symbol, sep = "\t")
      charge_work("operations", length(keys) + 1L)
      if (key %in% keys) return(invisible(NULL))
      retained_bytes <- sum(nchar(c(
        path, as.character(as.integer(line)), operation, rule, symbol, detail
      ), type = "bytes")) + 5L
      charge_work("diagnostic_bytes", retained_bytes)
      if (length(values) >= maximum) fail("diagnostic count exceeds its policy bound")
      keys <<- c(keys, key)
      values[[length(values) + 1L]] <<- list(
        path = path,
        line = as.integer(line),
        operation = operation,
        rule = rule,
        symbol = symbol,
        detail = detail,
        key = key
      )
      invisible(NULL)
    }
    list(add = add, values = function() values)
  }

  source_line <- function(node, fallback = 1L) {
    reference <- attr(node, "srcref", exact = TRUE)
    if (inherits(reference, "srcref") && length(reference) >= 1L && !is.na(reference[[1L]])) {
      return(as.integer(reference[[1L]]))
    }
    if (is.list(reference) && length(reference) >= 1L && inherits(reference[[1L]], "srcref") &&
        !is.na(reference[[1L]][[1L]])) {
      return(as.integer(reference[[1L]][[1L]]))
    }
    as.integer(fallback)
  }

  binding_candidate <- function(kind, formals = NULL, namespace = NULL, symbol = NULL,
                                terminal = FALSE, definition = NULL, definition_id = NULL,
                                definition_signature = NULL, environment = NULL, lexical_owner = NULL) {
    charge_work("candidate_states")
    list(
      kind = kind,
      formals = formals,
      namespace = namespace,
      symbol = symbol,
      terminal = terminal,
      definition = definition,
      definition_id = definition_id,
      definition_signature = definition_signature,
      environment = environment,
      lexical_owner = lexical_owner
    )
  }

  candidate_key <- function(candidate) {
    paste(
      candidate$kind,
      if (is.null(candidate$formals)) "" else paste(candidate$formals, collapse = "\034"),
      if (is.null(candidate$namespace)) "" else candidate$namespace,
      if (is.null(candidate$symbol)) "" else candidate$symbol,
      if (isTRUE(candidate$terminal)) "terminal" else "ordinary",
      if (is.null(candidate$definition_signature)) {
        if (is.null(candidate$definition_id)) "" else candidate$definition_id
      } else candidate$definition_signature,
      if (is.null(candidate$environment)) "" else candidate$environment,
      if (is.null(candidate$lexical_owner)) "" else candidate$lexical_owner,
      sep = "\035"
    )
  }

  unique_candidates <- function(candidates) {
    if (length(candidates) == 0L) return(candidates)
    charge_work("operations", length(candidates))
    keys <- vapply(candidates, candidate_key, character(1L))
    charge_work("operations", sum(nchar(keys, type = "bytes")) + 1L)
    candidates[!duplicated(keys)]
  }

  syntax_signature <- function(node) {
    charge_work("operations")
    if (identical(node, quote(expr = ))) return("missing")
    if (is.null(node)) return("null")
    if (is.symbol(node)) return(paste0("symbol:", encodeString(as.character(node), quote = '"')))
    if (is.call(node) || is.pairlist(node) || is.expression(node)) {
      kind <- if (is.call(node)) "call" else if (is.pairlist(node)) "pairlist" else "expression"
      values <- as.list(node)
      names <- names(values)
      if (is.null(names)) names <- rep("", length(values))
      parts <- vapply(seq_along(values), function(index) {
        element <- values[index]
        signature <- if (identical(element[[1L]], quote(expr = ))) "missing" else
          syntax_signature(element[[1L]])
        paste(encodeString(names[[index]], quote = '"'), signature, sep = "=")
      }, character(1L))
      return(paste0(kind, "(", paste(parts, collapse = ","), ")"))
    }
    values <- if (is.character(node)) encodeString(node, quote = '"') else
      if (is.double(node)) vapply(node, function(value) {
        if (is.nan(value)) "NaN" else if (is.na(value)) "NA" else
          if (is.infinite(value)) if (value > 0) "Inf" else "-Inf" else sprintf("%.17g", value)
      }, character(1L)) else as.character(node)
    paste(typeof(node), paste(values, collapse = ","), sep = ":")
  }

  bounded_syntax_signature <- function(node, maximum_nodes = 128L, maximum_bytes = 2048L) {
    nodes <- 0L
    count <- function(value) {
      nodes <<- nodes + 1L
      charge_work("operations")
      if (nodes > maximum_nodes) return(FALSE)
      if (is.call(value) || is.pairlist(value) || is.expression(value)) {
        values <- as.list(value)
        for (index in seq_along(values)) {
          element <- values[index]
          if (!identical(element[[1L]], quote(expr = )) && !count(element[[1L]])) return(FALSE)
        }
      }
      TRUE
    }
    if (!count(node)) return(NULL)
    text <- syntax_signature(node)
    bytes <- nchar(text, type = "bytes")
    charge_work("operations", min(bytes, maximum_bytes + 1L) + 1L)
    if (bytes > maximum_bytes) NULL else text
  }

  function_candidate <- function(formals, namespace = NULL, symbol = NULL, terminal = FALSE,
                                 definition = NULL, definition_id = NULL, lexical_owner = NULL) {
    definition_signature <- if (is.null(definition)) NULL else {
      bounded_syntax_signature(definition)
    }
    binding_candidate(
      "function",
      formals = formals,
      namespace = namespace,
      symbol = symbol,
      terminal = terminal,
      definition = definition,
      definition_id = definition_id,
      definition_signature = definition_signature,
      lexical_owner = lexical_owner
    )
  }

  absent_candidate <- function() binding_candidate("absent")
  mask_candidate <- function() binding_candidate("mask")
  global_environment_candidate <- function() binding_candidate("environment", environment = "global")
  current_environment_candidate <- function(owner) {
    binding_candidate("environment", environment = "current", lexical_owner = owner)
  }

  value_binding <- function(value, scopes, context = NULL) {
    if (is.call(value) && is.symbol(value[[1L]]) && identical(as.character(value[[1L]]), "function")) {
      lexical_owner <- attr(scopes[[1L]], "openwrangler_scope_owner", exact = TRUE)
      if (is.null(context)) return(list(function_candidate(names(value[[2L]]), lexical_owner = lexical_owner)))
      definition_id <- context$register_definition(value)
      candidate <- function_candidate(
        names(value[[2L]]),
        definition = value,
        definition_id = definition_id,
        lexical_owner = lexical_owner
      )
      context$bind_definition(definition_id, candidate)
      return(list(candidate))
    }
    reference <- call_identity(value)
    if (is.symbol(value)) {
      candidates <- lexical_candidates(as.character(value), scopes)
      if (length(candidates) > 0L) return(candidates)
    }
    if (!is.null(reference) && (
        (is.call(value) && is.symbol(value[[1L]]) && as.character(value[[1L]]) %in% c("::", ":::")))) {
      candidates <- callable_candidates(reference, scopes)
      if (length(candidates) > 0L) return(candidates)
    }
    if (is.call(value)) {
      identity <- call_identity(value[[1L]])
      candidates <- callable_candidates(identity, scopes)
      resolved_environment <- unique(vapply(candidates, function(candidate) {
        if (identical(candidate$namespace, "base") && candidate$symbol %in% c("globalenv", "environment")) {
          candidate$symbol
        } else ""
      }, character(1L)))
      resolved_environment <- resolved_environment[nzchar(resolved_environment)]
      if (length(resolved_environment) > 0L) {
        if ("globalenv" %in% resolved_environment) return(list(global_environment_candidate()))
        return(list(current_environment_candidate(
          attr(scopes[[1L]], "openwrangler_scope_owner", exact = TRUE)
        )))
      }
    }
    list(mask_candidate())
  }

  set_local_binding <- function(scopes, symbol, candidates) {
    scopes[[1L]][[symbol]] <- unique_candidates(candidates)
    scopes[[1L]] <- refresh_scope_state(scopes[[1L]])
    scopes
  }

  set_nonlocal_binding <- function(scopes, symbol, candidates) {
    if (length(scopes) < 2L) return(scopes)
    for (index in seq.int(2L, length(scopes))) {
      charge_work("operations")
      if (!is.null(scopes[[index]][[symbol]])) {
        scopes[[index]][[symbol]] <- unique_candidates(candidates)
        scopes[[index]] <- refresh_scope_state(scopes[[index]])
        return(scopes)
      }
    }
    scopes
  }

  base_callable_candidate <- function(symbol) {
    if (!exists(symbol, envir = baseenv(), mode = "function", inherits = FALSE)) return(list())
    callable <- get(symbol, envir = baseenv(), mode = "function", inherits = FALSE)
    list(function_candidate(
      names(formals(callable)),
      namespace = "base",
      symbol = symbol,
      terminal = symbol %in% c("stop", "quit", "return")
    ))
  }

  lexical_candidates <- function(symbol, scopes, start = 1L) {
    if (start <= length(scopes)) {
      for (index in seq.int(start, length(scopes))) {
        candidates <- scopes[[index]][[symbol]]
        if (is.null(candidates)) next
        absent <- vapply(candidates, function(candidate) identical(candidate$kind, "absent"), logical(1L))
        resolved <- candidates[!absent]
        if (any(absent)) resolved <- c(resolved, lexical_candidates(symbol, scopes, index + 1L))
        return(unique_candidates(resolved))
      }
    }
    if (identical(symbol, ".GlobalEnv")) return(list(global_environment_candidate()))
    base_callable_candidate(symbol)
  }

  callable_candidates <- function(identity, scopes) {
    if (is.null(identity)) return(list())
    if (is.null(identity$namespace)) return(lexical_candidates(identity$symbol, scopes))
    callable <- tryCatch(
      if (identity$internal) getFromNamespace(identity$symbol, identity$namespace) else
        getExportedValue(identity$namespace, identity$symbol),
      error = function(condition) NULL
    )
    if (!is.function(callable)) return(list())
    list(function_candidate(
      names(formals(callable)),
      namespace = identity$namespace,
      symbol = identity$symbol,
      terminal = identical(identity$namespace, "base") && identity$symbol %in% c("stop", "quit", "return")
    ))
  }

  callable_expression_candidates <- function(node, scopes, context = NULL) {
    if (is.symbol(node)) return(callable_candidates(call_identity(node), scopes))
    identity <- call_identity(node)
    if (!is.null(identity) && is.call(node) && is.symbol(node[[1L]]) &&
        as.character(node[[1L]]) %in% c("::", ":::")) {
      return(callable_candidates(identity, scopes))
    }
    if (!is.call(node)) return(list())
    head <- if (is.symbol(node[[1L]])) as.character(node[[1L]]) else NULL
    if (identical(head, "function")) return(value_binding(node, scopes, context))
    if (identical(head, "(") && length(node) == 2L) {
      return(callable_expression_candidates(node[[2L]], scopes, context))
    }
    if (identical(head, "{") && length(node) > 1L) {
      return(callable_expression_candidates(node[[length(node)]], scopes, context))
    }
    if (identical(head, "if") && length(node) >= 3L) {
      candidates <- callable_expression_candidates(node[[3L]], scopes, context)
      if (length(node) == 4L) {
        candidates <- c(candidates, callable_expression_candidates(node[[4L]], scopes, context))
      } else candidates <- c(candidates, list(mask_candidate()))
      return(unique_candidates(candidates))
    }
    list()
  }

  function_parameter_scope <- function(formals) {
    scope <- list()
    for (symbol in names(formals)) scope[[symbol]] <- list(mask_candidate())
    new_scope(scope)
  }

  merge_branch_scopes <- function(scopes, alternatives) {
    merged <- scopes
    symbol_lists <- lapply(c(list(scopes), alternatives), function(candidate_scopes) {
      names(candidate_scopes[[1L]])
    })
    symbol_count <- sum(vapply(symbol_lists, length, integer(1L)))
    charge_work("operations", length(alternatives) + symbol_count + 1L)
    symbols <- unique(unlist(symbol_lists, use.names = FALSE))
    for (symbol in symbols) {
      candidate_sizes <- vapply(alternatives, function(candidate_scopes) {
        value <- candidate_scopes[[1L]][[symbol]]
        if (is.null(value)) 1L else length(value)
      }, integer(1L))
      charge_work("operations", sum(candidate_sizes) + length(candidate_sizes) + 1L)
      candidates <- unlist(lapply(alternatives, function(candidate_scopes) {
        value <- candidate_scopes[[1L]][[symbol]]
        if (is.null(value)) list(absent_candidate()) else value
      }), recursive = FALSE)
      merged[[1L]][[symbol]] <- unique_candidates(candidates)
    }
    merged[[1L]] <- refresh_scope_state(merged[[1L]])
    merged
  }

  scope_binding_receipt <- function(scope) {
    symbols <- names(scope)
    if (is.null(symbols)) symbols <- character()
    symbols <- sort(symbols, method = "radix")
    charge_work("operations", length(symbols) + 1L)
    structure(lapply(symbols, function(symbol) {
      candidates <- scope[[symbol]]
      charge_work("operations", length(candidates) + 1L)
      sort(vapply(candidates, candidate_key, character(1L)), method = "radix")
    }), names = symbols)
  }

  same_scope_bindings <- function(left, right) {
    identical(scope_binding_receipt(left[[1L]]), scope_binding_receipt(right[[1L]]))
  }

  merge_exit_scope <- function(base, current, incoming) {
    if (is.null(incoming)) return(current)
    if (is.null(current)) return(incoming)
    merge_branch_scopes(base, list(current, incoming))
  }

  merge_result_exits <- function(base, exits, result) {
    for (name in c("break_scopes", "next_scopes", "terminal_scopes")) {
      exits[[name]] <- merge_exit_scope(base, exits[[name]], result[[name]])
    }
    exits
  }

  add_terminal_exit <- function(base, exits, terminal, scopes) {
    name <- if (identical(terminal, "break")) "break_scopes" else
      if (identical(terminal, "next")) "next_scopes" else "terminal_scopes"
    exits[[name]] <- merge_exit_scope(base, exits[[name]], scopes)
    exits
  }

  source_locator <- function(source_file) {
    data <- utils::getParseData(source_file, includeText = TRUE)
    row_count <- nrow(data)
    charge_work("span_lookups", row_count * 2L + 1L)
    maximum_id <- if (row_count == 0L) 0L else max(data$id)
    rows <- integer(maximum_id + 1L)
    if (row_count > 0L) rows[data$id + 1L] <- seq_len(row_count)
    charge_work("span_lookups", row_count * 3L + 1L)
    child_rows_by_parent <- if (row_count == 0L) list() else
      split(seq_len(row_count), as.character(data$parent), drop = TRUE)
    children_for <- function(id) {
      charge_work("span_lookups")
      children <- child_rows_by_parent[[as.character(as.integer(id))]]
      if (is.null(children)) integer() else children
    }
    spans <- if (row_count == 0L) character() else sprintf(
      "L%d:C%d-L%d:C%d",
      as.integer(data$line1), as.integer(data$col1),
      as.integer(data$line2), as.integer(data$col2)
    )
    row_for <- function(id) {
      charge_work("span_lookups")
      numeric_id <- suppressWarnings(as.integer(id))
      if (length(numeric_id) != 1L || is.na(numeric_id) || numeric_id < 0L || numeric_id > maximum_id) {
        return(NA_integer_)
      }
      row <- rows[[numeric_id + 1L]]
      if (row == 0L) NA_integer_ else row
    }
    operation_span <- function(id, fallback_line, fallback_column = 1L) {
      row <- row_for(id)
      if (is.na(row)) {
        return(sprintf("L%d:C%d-L%d:C%d", fallback_line, fallback_column, fallback_line, fallback_column))
      }
      spans[[row]]
    }
    call_expression_ids <- unique(data$parent[data$text == "(" & data$token == "'('"])
    is_call_expression <- logical(maximum_id + 1L)
    if (length(call_expression_ids) > 0L) is_call_expression[call_expression_ids + 1L] <- TRUE
    enclosing_call_cache <- rep.int(NA_integer_, maximum_id + 1L)
    enclosing_call <- function(id) {
      current <- as.integer(id)
      visited <- list()
      result <- 0L
      while (is.finite(current) && current > 0L) {
        charge_work("span_lookups")
        if (current > maximum_id) break
        cached <- enclosing_call_cache[[current + 1L]]
        if (!is.na(cached)) {
          result <- cached
          break
        }
        visited[[length(visited) + 1L]] <- current
        if (is_call_expression[[current + 1L]]) {
          result <- current
          break
        }
        row <- row_for(current)
        if (is.na(row)) break
        parent <- data$parent[[row]]
        if (is.na(parent) || parent == current) break
        current <- as.integer(parent)
      }
      if (length(visited) > 0L) {
        charge_work("span_lookups", length(visited))
        for (visited_id in visited) enclosing_call_cache[[visited_id + 1L]] <- result
      }
      if (result == 0L) NA_integer_ else result
    }
    argument_tokens <- data[data$token == "SYMBOL_SUB", , drop = FALSE]
    argument_rows_by_call <- list()
    if (nrow(argument_tokens) > 0L) {
      argument_owners <- vapply(argument_tokens$parent, enclosing_call, integer(1L))
      owned <- which(!is.na(argument_owners))
      if (length(owned) > 0L) argument_rows_by_call <- split(owned, as.character(argument_owners[owned]))
    }
    call_receipt <- function(call_id, symbol, line, column) {
      argument_rows <- argument_rows_by_call[[as.character(call_id)]]
      arguments <- if (is.null(argument_rows)) argument_tokens[0L, , drop = FALSE] else
        argument_tokens[argument_rows, , drop = FALSE]
      if (nrow(arguments) > 0L) arguments <- arguments[order(arguments$line1, arguments$col1), , drop = FALSE]
      list(
        id = as.integer(call_id),
        symbol = symbol,
        line = as.integer(line),
        column = as.integer(column),
        operation = operation_span(call_id, as.integer(line), as.integer(column)),
        argument_lines = as.integer(arguments$line1),
        argument_operations = if (nrow(arguments) == 0L) character() else
          vapply(seq_len(nrow(arguments)), function(argument_index) {
            operation_span(
              arguments$id[[argument_index]],
              as.integer(arguments$line1[[argument_index]]),
              as.integer(arguments$col1[[argument_index]])
            )
          }, character(1L))
      )
    }
    call_tokens <- data[data$token == "SYMBOL_FUNCTION_CALL", , drop = FALSE]
    if (nrow(call_tokens) > 0L) {
      head_text <- vapply(call_tokens$parent, function(parent) {
        row <- row_for(parent)
        if (is.na(row)) "" else data$text[[row]]
      }, character(1L))
      direct <- !grepl("$", head_text, fixed = TRUE) & !grepl("@", head_text, fixed = TRUE) &
        !grepl("[[", head_text, fixed = TRUE)
      call_tokens <- call_tokens[direct, , drop = FALSE]
    }
    call_records <- lapply(seq_len(nrow(call_tokens)), function(index) {
      token <- call_tokens[index, , drop = FALSE]
      call_id <- enclosing_call(token$parent)
      call_receipt(call_id, token$text, token$line1, token$col1)
    })
    call_records <- Filter(Negate(is.null), call_records)
    direct_call_ids <- vapply(call_records, `[[`, integer(1L), "id")
    computed_call_ids <- setdiff(call_expression_ids, direct_call_ids)
    computed_call_ids <- Filter(function(id) {
      children <- children_for(id)
      if (length(children) == 0L) return(FALSE)
      children <- children[order(data$line1[children], data$col1[children])]
      identical(data$token[[children[[1L]]]], "expr")
    }, computed_call_ids)
    computed_call_rows <- vapply(computed_call_ids, row_for, integer(1L))
    if (length(computed_call_rows) > 0L) {
      order_index <- order(
        data$line1[computed_call_rows], data$col1[computed_call_rows],
        -data$line2[computed_call_rows], -data$col2[computed_call_rows]
      )
      computed_call_ids <- computed_call_ids[order_index]
      computed_call_rows <- computed_call_rows[order_index]
    }
    computed_call_records <- lapply(seq_along(computed_call_ids), function(index) {
      row <- computed_call_rows[[index]]
      call_receipt(
        computed_call_ids[[index]], "<computed>", data$line1[[row]], data$col1[[row]]
      )
    })
    assignments <- data[data$token %in% c("LEFT_ASSIGN", "EQ_ASSIGN"), , drop = FALSE]
    assignments <- assignments[assignments$text %in% c("<-", "=", "<<-"), , drop = FALSE]
    assignment_records <- lapply(seq_len(nrow(assignments)), function(index) {
      token <- assignments[index, , drop = FALSE]
      list(
        line = as.integer(token$line1),
        column = as.integer(token$col1),
        operator = token$text,
        operation = operation_span(token$parent, as.integer(token$line1), as.integer(token$col1))
      )
    })
    assignment_records <- Filter(Negate(is.null), assignment_records)
    order_records <- function(records) {
      if (length(records) == 0L) return(records)
      records[order(
        vapply(records, `[[`, integer(1L), "line"),
        vapply(records, `[[`, integer(1L), "column")
      )]
    }
    call_records <- order_records(call_records)
    assignment_records <- order_records(assignment_records)
    quote_call_ids <- vapply(call_records, function(record) {
      if (record$symbol %in% c("quote", "substitute", "expression", "bquote")) {
        record$id
      } else NA_integer_
    }, integer(1L))
    quote_call_ids <- quote_call_ids[!is.na(quote_call_ids)]
    quoted_calls <- logical(maximum_id + 1L)
    if (length(quote_call_ids) > 0L) quoted_calls[quote_call_ids + 1L] <- TRUE
    is_descended_from_quoted_call <- function(id) {
      current <- as.integer(id)
      while (is.finite(current) && current > 0L && current <= maximum_id) {
        charge_work("span_lookups")
        if (quoted_calls[[current + 1L]]) return(TRUE)
        row <- row_for(current)
        if (is.na(row)) break
        parent <- as.integer(data$parent[[row]])
        if (parent == current) break
        current <- parent
      }
      FALSE
    }
    evaluated_call_records <- Filter(function(record) {
      record$id %in% quote_call_ids || !is_descended_from_quoted_call(record$id)
    }, call_records)
    is_member_name <- function(row) {
      parent_id <- as.integer(data$parent[[row]])
      parent_row <- row_for(parent_id)
      if (is.na(parent_row)) return(FALSE)
      siblings <- children_for(parent_id)
      operators <- siblings[data$token[siblings] %in% c("'$'", "'@'")]
      length(operators) > 0L && any(data$col1[[row]] > data$col1[operators])
    }
    symbol_rows <- which(data$token == "SYMBOL")
    make_symbol_record <- function(row) list(
        symbol = data$text[[row]],
        line = as.integer(data$line1[[row]]),
        column = as.integer(data$col1[[row]]),
        operation = operation_span(data$id[[row]], data$line1[[row]], data$col1[[row]])
      )
    quoted_symbol_records <- list()
    evaluated_symbol_records <- lapply(symbol_rows, function(row) {
      if (is_member_name(row)) return(NULL)
      if (is_descended_from_quoted_call(data$id[[row]])) {
        quoted_symbol_records[[length(quoted_symbol_records) + 1L]] <<- make_symbol_record(row)
        return(NULL)
      }
      make_symbol_record(row)
    })
    evaluated_symbol_records <- order_records(Filter(Negate(is.null), evaluated_symbol_records))
    quoted_symbol_records <- order_records(quoted_symbol_records)
    codetools_global_records <- list()
    codetools_cursors <- new.env(hash = TRUE, parent = emptyenv())
    codetools_operation <- function(rule, symbol, line) {
      matches <- if (identical(rule, "unqualified-call")) {
        records <- Filter(function(record) {
          identical(record$line, as.integer(line)) && identical(record$symbol, symbol)
        }, evaluated_call_records)
        if (length(records) == 0L) {
          indices <- which(
            data$line1 == as.integer(line) & data$text == symbol &
              data$token %in% c("SPECIAL", "LEFT_ASSIGN", "RIGHT_ASSIGN")
          )
          records <- lapply(indices, function(index) list(
            line = as.integer(data$line1[[index]]),
            column = as.integer(data$col1[[index]]),
            operation = operation_span(
              data$parent[[index]], as.integer(data$line1[[index]]), as.integer(data$col1[[index]])
            )
          ))
        }
        records
      } else if (identical(rule, "global-assignment")) {
        Filter(function(record) {
          identical(record$line, as.integer(line)) && identical(record$symbol, symbol)
        }, codetools_global_records)
      } else {
        records <- Filter(function(record) {
          identical(record$line, as.integer(line)) && identical(record$symbol, symbol)
        }, evaluated_symbol_records)
        if (length(records) == 0L) records <- Filter(function(record) {
          identical(record$line, as.integer(line)) && identical(record$symbol, symbol)
        }, quoted_symbol_records)
        records
      }
      matches <- order_records(matches)
      key <- paste(rule, symbol, as.integer(line), sep = "\t")
      index <- if (exists(key, envir = codetools_cursors, inherits = FALSE)) {
        get(key, envir = codetools_cursors, inherits = FALSE) + 1L
      } else 1L
      assign(key, index, envir = codetools_cursors)
      if (index <= length(matches)) return(matches[[index]]$operation)
      sprintf("line:%d:codetools:%d", as.integer(line), index)
    }
    annotate <- function(expressions) {
      call_index <- 1L
      computed_call_index <- 1L
      assignment_index <- 1L
      node_serial <- 0L
      visit <- function(node) {
        if (!(is.call(node) || is.pairlist(node))) return(node)
        if (is.call(node)) {
          node_serial <<- node_serial + 1L
          attr(node, "openwrangler_node_id") <- node_serial
          head <- node[[1L]]
          head_symbol <- if (is.symbol(head)) as.character(head) else NULL
          assignment <- !is.null(head_symbol) && head_symbol %in% c("<-", "=", "<<-") && length(node) == 3L
          special <- !is.null(head_symbol) && head_symbol %in% c(
            "function", "{", "if", "for", "while", "repeat", "break", "next"
          )
          identity <- call_identity(head)
          if (assignment && assignment_index <= length(assignment_records)) {
            assignment_receipt <- assignment_records[[assignment_index]]
            if (!identical(assignment_receipt$operator, head_symbol)) {
              fail("parse-data assignment order differs from the exact syntax tree")
            }
            attr(node, "openwrangler_assignment_receipt") <- assignment_receipt
            if (identical(head_symbol, "<<-") && is.symbol(node[[2L]])) {
              codetools_global_records[[length(codetools_global_records) + 1L]] <<- list(
                symbol = as.character(node[[2L]]),
                line = assignment_receipt$line,
                column = assignment_receipt$column,
                operation = assignment_receipt$operation
              )
            }
            assignment_index <<- assignment_index + 1L
          } else if (!special && !is.null(identity) && call_index <= length(call_records)) {
            if (identical(call_records[[call_index]]$symbol, identity$symbol)) {
              attr(node, "openwrangler_call_receipt") <- call_records[[call_index]]
              call_index <<- call_index + 1L
            } else if (identity$symbol %in% call_tokens$text) {
              fail(sprintf(
                "parse-data call order differs at %d (syntax %s at line %d; tree %s)",
                call_index,
                call_records[[call_index]]$symbol,
                call_records[[call_index]]$line,
                identity$symbol
              ))
            }
          } else if (!special && is.null(identity) && computed_call_index <= length(computed_call_records)) {
            attr(node, "openwrangler_call_receipt") <- computed_call_records[[computed_call_index]]
            computed_call_index <<- computed_call_index + 1L
          }
        }
        for (index in seq_along(node)) {
          element <- node[index]
          if (identical(as.character(element), "")) next
          node[index] <- list(visit(element[[1L]]))
        }
        node
      }
      for (index in seq_along(expressions)) expressions[[index]] <- visit(expressions[[index]])
      if (call_index != length(call_records) + 1L ||
          computed_call_index != length(computed_call_records) + 1L ||
          assignment_index != length(assignment_records) + 1L) {
        fail(sprintf(
          paste0(
            "parse-data locations could not be bound to the exact syntax tree ",
            "(calls %d/%d; computed calls %d/%d; assignments %d/%d; next call %s)"
          ),
          call_index - 1L,
          length(call_records),
          computed_call_index - 1L,
          length(computed_call_records),
          assignment_index - 1L,
          length(assignment_records),
          if (call_index <= length(call_records)) call_records[[call_index]]$symbol else "<none>"
        ))
      }
      expressions
    }
    list(
      annotate = annotate,
      call = function(node, fallback) {
        receipt <- attr(node, "openwrangler_call_receipt", exact = TRUE)
        if (is.null(receipt)) list(
          line = as.integer(fallback),
          operation = sprintf("line:%d", as.integer(fallback)),
          argument_lines = integer(),
          argument_operations = character()
        ) else receipt
      },
      argument = function(receipt, named_index, fallback) {
        if (named_index < 1L || named_index > length(receipt$argument_lines)) {
          return(list(line = as.integer(fallback), operation = receipt$operation))
        }
        list(
          line = receipt$argument_lines[[named_index]],
          operation = receipt$argument_operations[[named_index]]
        )
      },
      assignment = function(node, fallback) {
        receipt <- attr(node, "openwrangler_assignment_receipt", exact = TRUE)
        if (is.null(receipt)) list(
          line = as.integer(fallback),
          operation = sprintf("line:%d", as.integer(fallback))
        ) else receipt
      },
      codetools = codetools_operation
    )
  }

  call_identity <- function(head) {
    if (is.symbol(head)) {
      return(list(symbol = as.character(head), namespace = NULL, internal = FALSE))
    }
    if (is.call(head) && length(head) == 3L && is.symbol(head[[1L]]) &&
        as.character(head[[1L]]) %in% c("::", ":::") && is.symbol(head[[2L]]) && is.symbol(head[[3L]])) {
      return(list(
        symbol = as.character(head[[3L]]),
        namespace = as.character(head[[2L]]),
        internal = identical(as.character(head[[1L]]), ":::")
      ))
    }
    NULL
  }

  assignment_parts <- function(node) {
    if (!is.call(node) || length(node) != 3L || !is.symbol(node[[1L]]) ||
        !(as.character(node[[1L]]) %in% c("<-", "=")) || !is.symbol(node[[2L]])) return(NULL)
    list(symbol = as.character(node[[2L]]), value = node[[3L]])
  }

  apply_binding_effect <- function(statement, scopes) {
    if (!is.call(statement)) return(scopes)
    head <- if (is.symbol(statement[[1L]])) as.character(statement[[1L]]) else NULL
    assignment <- assignment_parts(statement)
    if (!is.null(assignment)) {
      return(set_local_binding(scopes, assignment$symbol, value_binding(assignment$value, scopes)))
    }
    if (identical(head, "{")) {
      current <- scopes
      for (child in as.list(statement)[-1L]) current <- apply_binding_effect(child, current)
      return(current)
    }
    if (identical(head, "if") && length(statement) >= 3L) {
      consequent <- apply_binding_effect(statement[[3L]], scopes)
      alternative <- if (length(statement) == 4L) apply_binding_effect(statement[[4L]], scopes) else scopes
      return(merge_branch_scopes(scopes, list(consequent, alternative)))
    }
    scopes
  }

  direct_terminal_symbol <- function(statement) {
    if (is.symbol(statement) && as.character(statement) %in% c("break", "next")) {
      return(as.character(statement))
    }
    if (is.call(statement) && is.symbol(statement[[1L]]) &&
        as.character(statement[[1L]]) %in% c("break", "next")) {
      return(as.character(statement[[1L]]))
    }
    NULL
  }

  terminal_expression <- function(statement, scopes) {
    direct <- direct_terminal_symbol(statement)
    if (!is.null(direct)) return(direct)
    if (!is.call(statement)) return(NULL)
    identity <- call_identity(statement[[1L]])
    if (!is.null(identity)) {
      candidates <- callable_candidates(identity, scopes)
      callable <- vapply(candidates, function(candidate) identical(candidate$kind, "function"), logical(1L))
      terminal <- vapply(candidates, function(candidate) isTRUE(candidate$terminal), logical(1L))
      if (length(candidates) > 0L && all(callable & terminal)) return(identity$symbol)
    }
    if (!is.symbol(statement[[1L]])) return(NULL)
    head <- as.character(statement[[1L]])
    if (identical(head, "{")) {
      current <- scopes
      for (child in as.list(statement)[-1L]) {
        terminal <- terminal_expression(child, current)
        if (!is.null(terminal)) return(terminal)
        current <- apply_binding_effect(child, current)
      }
      return(NULL)
    }
    if (identical(head, "if") && length(statement) == 4L) {
      consequent <- terminal_expression(statement[[3L]], scopes)
      alternative <- terminal_expression(statement[[4L]], scopes)
      if (!is.null(consequent) && !is.null(alternative)) return("if")
    }
    NULL
  }

  global_environment_expression <- function(node, scopes) {
    if (is.symbol(node)) {
      candidates <- lexical_candidates(as.character(node), scopes)
      return(any(vapply(candidates, function(candidate) {
        identical(candidate$kind, "environment") && identical(candidate$environment, "global")
      }, logical(1L))))
    }
    if (!is.call(node) || length(node) != 1L) return(FALSE)
    identity <- call_identity(node[[1L]])
    candidates <- callable_candidates(identity, scopes)
    !is.null(identity) &&
      any(vapply(candidates, function(candidate) {
        identical(candidate$namespace, "base") && identical(candidate$symbol, "globalenv")
      }, logical(1L)))
  }

  global_member_symbol <- function(node, scopes) {
    if (!is.call(node) || length(node) != 3L || !is.symbol(node[[1L]]) ||
        !(as.character(node[[1L]]) %in% c("$", "[[")) || !global_environment_expression(node[[2L]], scopes)) {
      return(NULL)
    }
    member <- node[[3L]]
    if (is.symbol(member) || (is.character(member) && length(member) == 1L && !is.na(member))) {
      return(paste0(".GlobalEnv$", as.character(member)))
    }
    ".GlobalEnv$<dynamic>"
  }

  named_argument <- function(node, name) {
    arguments <- as.list(node)[-1L]
    argument_names <- names(arguments)
    if (is.null(argument_names)) return(NULL)
    matches <- which(argument_names == name)
    if (length(matches) != 1L) return(NULL)
    arguments[[matches]]
  }

  matched_call_arguments <- function(node, formals) {
    arguments <- as.list(node)[-1L]
    argument_names <- names(arguments)
    if (is.null(argument_names)) argument_names <- rep("", length(arguments))
    matched <- rep(NA_character_, length(arguments))
    claimed <- character()
    dots <- match("...", formals, nomatch = 0L)
    positional_formals <- if (dots == 0L) formals else if (dots == 1L) character() else formals[seq_len(dots - 1L)]
    for (index in seq_along(arguments)) {
      name <- argument_names[[index]]
      if (nzchar(name) && name %in% formals && !(name %in% claimed)) {
        matched[[index]] <- name
        claimed <- c(claimed, name)
      }
    }
    for (index in seq_along(arguments)) {
      name <- argument_names[[index]]
      if (!nzchar(name) || !is.na(matched[[index]])) next
      targets <- setdiff(positional_formals[startsWith(positional_formals, name)], claimed)
      if (length(targets) == 1L) {
        matched[[index]] <- targets[[1L]]
        claimed <- c(claimed, targets[[1L]])
      }
    }
    remaining <- setdiff(positional_formals, claimed)
    for (index in seq_along(arguments)) {
      if (nzchar(argument_names[[index]]) || length(remaining) == 0L) next
      matched[[index]] <- remaining[[1L]]
      claimed <- c(claimed, remaining[[1L]])
      remaining <- remaining[-1L]
    }
    structure(arguments, names = matched)
  }

  executing_callback_contract <- function(symbol) {
    contracts <- list(
      "do.call" = list(formals = c("what", "args", "quote", "envir"), callback = "what"),
      lapply = list(formals = c("X", "FUN", "..."), callback = "FUN"),
      sapply = list(formals = c("X", "FUN", "...", "simplify", "USE.NAMES"), callback = "FUN"),
      vapply = list(formals = c("X", "FUN", "FUN.VALUE", "...", "USE.NAMES"), callback = "FUN"),
      Map = list(formals = c("f", "..."), callback = "f"),
      mapply = list(formals = c("FUN", "...", "MoreArgs", "SIMPLIFY", "USE.NAMES"), callback = "FUN"),
      Filter = list(formals = c("f", "x"), callback = "f"),
      Reduce = list(formals = c("f", "x", "init", "right", "accumulate", "simplify"), callback = "f"),
      apply = list(formals = c("X", "MARGIN", "FUN", "...", "simplify"), callback = "FUN"),
      forceAndCall = list(formals = c("n", "FUN", "..."), callback = "FUN")
    )
    contracts[[symbol]]
  }

  call_is <- function(node, symbol, namespace = NULL) {
    if (!is.call(node)) return(FALSE)
    identity <- call_identity(node[[1L]])
    !is.null(identity) && identical(identity$symbol, symbol) && identical(identity$namespace, namespace)
  }

  node_contains <- function(node, target) {
    if (identical(node, target)) return(TRUE)
    if (!(is.call(node) || is.expression(node) || is.pairlist(node))) return(FALSE)
    any(vapply(as.list(node), function(child) {
      !identical(child, quote(expr = )) && node_contains(child, target)
    }, logical(1L)))
  }

  single_statement <- function(node) {
    if (is.call(node) && is.symbol(node[[1L]]) && identical(as.character(node[[1L]]), "{")) {
      statements <- as.list(node)[-1L]
      if (length(statements) != 1L) return(NULL)
      return(statements[[1L]])
    }
    node
  }

  exact_seed_environment_call <- function(node, symbol, scopes) {
    if (!call_is(node, symbol, "base")) return(FALSE)
    arguments <- as.list(node)[-1L]
    argument_names <- names(arguments)
    length(arguments) == 3L && identical(argument_names, c("", "envir", "inherits")) &&
      is.character(arguments[[1L]]) && identical(arguments[[1L]], ".Random.seed") &&
      global_environment_expression(arguments[[2L]], scopes) && identical(arguments[[3L]], FALSE)
  }

  assigned_root_symbol <- function(node) {
    if (is.symbol(node)) return(as.character(node))
    if (!is.call(node) || length(node) < 2L) return(NULL)
    assigned_root_symbol(node[[2L]])
  }

  seed_snapshot_mutations <- function(statements) {
    protected <- c("had_random_seed", "previous_random_seed")
    node_key <- function(node, suffix) {
      id <- attr(node, "openwrangler_node_id", exact = TRUE)
      if (length(id) != 1L || is.na(id)) fail("a seed mutation has no exact syntax identity")
      paste(as.integer(id), suffix, sep = ":")
    }
    candidate <- function(kind, symbol = NULL, node = NULL) list(kind = kind, symbol = symbol, node = node)
    candidate_key <- function(value) {
      if (identical(value$kind, "closure")) return(node_key(value$node, "closure-candidate"))
      paste(value$kind, if (is.null(value$symbol)) "" else value$symbol, sep = ":")
    }
    unique_seed_candidates <- function(values) {
      charge_work("operations", length(values) + 1L)
      if (length(values) == 0L) return(values)
      keys <- vapply(values, candidate_key, character(1L))
      values[!duplicated(keys)]
    }
    empty_state <- function() list(bindings = list(), events = list(), active = character(), updates = list())
    add_event <- function(state, node, symbol) {
      key <- node_key(node, symbol)
      if (is.null(state$events[[key]])) state$events[[key]] <- symbol
      state
    }
    merge_states <- function(states) {
      states <- Filter(Negate(is.null), states)
      if (length(states) == 0L) return(NULL)
      symbol_count <- sum(vapply(states, function(state) length(state$bindings), integer(1L)))
      event_count <- sum(vapply(states, function(state) length(state$events), integer(1L)))
      active_count <- sum(vapply(states, function(state) length(state$active), integer(1L)))
      update_count <- sum(vapply(states, function(state) length(state$updates), integer(1L)))
      charge_work(
        "operations",
        length(states) + symbol_count + event_count + active_count + update_count + 1L
      )
      merged <- empty_state()
      symbol_index <- new.env(hash = TRUE, parent = emptyenv())
      for (state in states) for (name in names(state$bindings)) assign(name, TRUE, envir = symbol_index)
      binding_names <- ls(symbol_index, all.names = TRUE, sorted = TRUE)
      for (name in binding_names) {
        sizes <- vapply(states, function(state) {
          value <- state$bindings[[name]]
          if (is.null(value)) 1L else length(value)
        }, integer(1L))
        charge_work("operations", sum(sizes) + length(sizes) + 1L)
        values <- vector("list", sum(sizes))
        cursor <- 1L
        for (index in seq_along(states)) {
          source <- states[[index]]$bindings[[name]]
          if (is.null(source)) source <- list(candidate("absent", symbol = name))
          target <- seq.int(cursor, length.out = length(source))
          values[target] <- source
          cursor <- cursor + length(source)
        }
        merged$bindings[[name]] <- unique_seed_candidates(values)
      }
      for (state in states) {
        for (key in names(state$events)) if (is.null(merged$events[[key]])) {
          merged$events[[key]] <- state$events[[key]]
        }
        for (name in names(state$updates)) {
          prior <- merged$updates[[name]]
          merged$updates[[name]] <- unique_seed_candidates(c(prior, state$updates[[name]]))
        }
      }
      active_index <- new.env(hash = TRUE, parent = emptyenv())
      for (state in states) for (key in state$active) assign(key, TRUE, envir = active_index)
      merged$active <- ls(active_index, all.names = TRUE, sorted = TRUE)
      merged
    }
    state_receipt <- function(state) {
      if (is.null(state)) return("<terminal>")
      binding_names <- names(state$bindings)
      event_names <- names(state$events)
      update_names <- names(state$updates)
      if (is.null(binding_names)) binding_names <- character()
      if (is.null(event_names)) event_names <- character()
      if (is.null(update_names)) update_names <- character()
      binding_names <- sort(binding_names, method = "radix")
      charge_work("operations", length(binding_names) + length(event_names) + length(update_names) + 1L)
      bindings <- vapply(binding_names, function(name) {
        paste(sort(vapply(state$bindings[[name]], candidate_key, character(1L)), method = "radix"), collapse = "\034")
      }, character(1L))
      paste(
        paste(binding_names, bindings, sep = "="),
        paste(sort(event_names, method = "radix"), collapse = "\034"),
        paste(sort(update_names, method = "radix"), collapse = "\034"),
        sep = "\035",
        collapse = "\036"
      )
    }
    binding_candidates <- function(symbol, state) {
      values <- state$bindings[[symbol]]
      if (is.null(values)) list(candidate("absent", symbol = symbol)) else values
    }
    base_seed_callable <- function(symbol) {
      if (symbol %in% c(
        "assign", "rm", "remove", "environment", "return", "do.call",
        "lapply", "sapply", "vapply", "Map", "mapply", "Filter", "Reduce", "apply", "forceAndCall"
      )) list(candidate("builtin", symbol = symbol)) else list(candidate("unknown", symbol = symbol))
    }
    resolve_callable <- NULL
    resolve_value <- NULL
    resolve_callable <- function(node, state) {
      charge_work("operations")
      if (is.symbol(node)) {
        symbol <- as.character(node)
        values <- binding_candidates(symbol, state)
        expanded <- list()
        for (value in values) {
          if (identical(value$kind, "absent")) expanded <- c(expanded, base_seed_callable(symbol)) else
            expanded[[length(expanded) + 1L]] <- value
        }
        return(unique_seed_candidates(expanded))
      }
      identity <- call_identity(node)
      if (!is.null(identity) && is.call(node) && is.symbol(node[[1L]]) &&
          as.character(node[[1L]]) %in% c("::", ":::")) {
        if (identical(identity$namespace, "base")) return(list(candidate("builtin", identity$symbol)))
        return(list(candidate("unknown", identity$symbol)))
      }
      if (!is.call(node)) return(list(candidate("unknown")))
      head <- if (is.symbol(node[[1L]])) as.character(node[[1L]]) else NULL
      if (identical(head, "function")) return(list(candidate("closure", node = node)))
      if (identical(head, "(") && length(node) == 2L) return(resolve_callable(node[[2L]], state))
      if (identical(head, "{") && length(node) > 1L) return(resolve_callable(node[[length(node)]], state))
      if (identical(head, "if") && length(node) >= 3L) {
        values <- resolve_callable(node[[3L]], state)
        if (length(node) == 4L) values <- c(values, resolve_callable(node[[4L]], state)) else
          values <- c(values, list(candidate("unknown")))
        return(unique_seed_candidates(values))
      }
      list(candidate("unknown"))
    }
    resolve_value <- function(node, state) {
      charge_work("operations")
      if (is.symbol(node) || (is.call(node) && is.symbol(node[[1L]]) &&
          as.character(node[[1L]]) %in% c("::", ":::", "function", "(", "{", "if"))) {
        if (is.call(node) && is.symbol(node[[1L]]) &&
            as.character(node[[1L]]) %in% c("(", "{", "if")) {
          head <- as.character(node[[1L]])
          if (identical(head, "(")) return(resolve_value(node[[2L]], state))
          if (identical(head, "{")) return(resolve_value(node[[length(node)]], state))
          values <- resolve_value(node[[3L]], state)
          if (length(node) == 4L) values <- c(values, resolve_value(node[[4L]], state)) else
            values <- c(values, list(candidate("unknown")))
          return(unique_seed_candidates(values))
        }
        return(resolve_callable(node, state))
      }
      if (is.call(node)) {
        callables <- resolve_callable(node[[1L]], state)
        if (any(vapply(callables, function(value) {
              identical(value$kind, "builtin") && identical(value$symbol, "environment")
            }, logical(1L))) && length(node) == 1L) {
          values <- list(candidate("current-environment"))
          if (any(!vapply(callables, function(value) {
                identical(value$kind, "builtin") && identical(value$symbol, "environment")
              }, logical(1L)))) values <- c(values, list(candidate("unknown")))
          return(values)
        }
      }
      list(candidate("unknown"))
    }
    may_be_current_environment <- function(node, state) {
      any(vapply(resolve_value(node, state), function(value) {
        identical(value$kind, "current-environment")
      }, logical(1L)))
    }
    flow <- function(continuing = NULL, returns = NULL, breaks = NULL, nexts = NULL) {
      list(continuing = continuing, returns = returns, breaks = breaks, nexts = nexts)
    }
    merge_flows <- function(values) {
      list(
        continuing = merge_states(lapply(values, `[[`, "continuing")),
        returns = merge_states(lapply(values, `[[`, "returns")),
        breaks = merge_states(lapply(values, `[[`, "breaks")),
        nexts = merge_states(lapply(values, `[[`, "nexts"))
      )
    }
    append_exits <- function(target, source) {
      target$returns <- merge_states(list(target$returns, source$returns))
      target$breaks <- merge_states(list(target$breaks, source$breaks))
      target$nexts <- merge_states(list(target$nexts, source$nexts))
      target
    }
    flow_states <- function(value) Filter(Negate(is.null), unname(value))
    apply_binding <- function(state, symbol, values, nonlocal = FALSE) {
      state$bindings[[symbol]] <- unique_seed_candidates(values)
      if (nonlocal) state$updates[[symbol]] <- state$bindings[[symbol]]
      state
    }
    scan <- NULL
    scan_callable <- NULL
    scan_callable <- function(node, state, in_closure) {
      charge_work("operations")
      if (is.symbol(node) || !is.null(call_identity(node)) ||
          (is.call(node) && is.symbol(node[[1L]]) && identical(as.character(node[[1L]]), "function"))) {
        return(list(flow = flow(continuing = state), candidates = resolve_callable(node, state)))
      }
      if (!is.call(node)) {
        return(list(flow = flow(continuing = state), candidates = list(candidate("unknown"))))
      }
      head <- if (is.symbol(node[[1L]])) as.character(node[[1L]]) else NULL
      if (identical(head, "(") && length(node) == 2L) {
        return(scan_callable(node[[2L]], state, in_closure))
      }
      if (identical(head, "{") && length(node) > 1L) {
        expressions <- as.list(node)[-1L]
        result <- flow(continuing = state)
        if (length(expressions) > 1L) for (expression in expressions[-length(expressions)]) {
          if (is.null(result$continuing)) break
          child <- scan(expression, result$continuing, in_closure)
          result <- append_exits(result, child)
          result$continuing <- child$continuing
        }
        if (is.null(result$continuing)) return(list(flow = result, candidates = list()))
        final <- scan_callable(expressions[[length(expressions)]], result$continuing, in_closure)
        result <- append_exits(result, final$flow)
        result$continuing <- final$flow$continuing
        return(list(flow = result, candidates = final$candidates))
      }
      if (identical(head, "if") && length(node) >= 3L) {
        condition <- scan(node[[2L]], state, in_closure)
        if (is.null(condition$continuing)) return(list(flow = condition, candidates = list()))
        consequent <- scan_callable(node[[3L]], condition$continuing, in_closure)
        alternative <- if (length(node) == 4L) scan_callable(
          node[[4L]], condition$continuing, in_closure
        ) else list(flow = flow(continuing = condition$continuing), candidates = list(candidate("unknown")))
        result <- merge_flows(list(consequent$flow, alternative$flow))
        return(list(
          flow = append_exits(result, condition),
          candidates = unique_seed_candidates(c(consequent$candidates, alternative$candidates))
        ))
      }
      evaluated <- scan(node, state, in_closure)
      candidates <- if (is.null(evaluated$continuing)) list() else resolve_callable(node, evaluated$continuing)
      list(flow = evaluated, candidates = candidates)
    }
    scan <- function(node, state, in_closure = FALSE) {
      charge_work("operations")
      if (!is.call(node)) return(flow(continuing = state))
      head <- node[[1L]]
      head_symbol <- if (is.symbol(head)) as.character(head) else NULL
      if (identical(head_symbol, "function")) return(flow(continuing = state))
      if (identical(head_symbol, "{")) {
        result <- flow(continuing = state)
        for (statement in as.list(node)[-1L]) {
          if (is.null(result$continuing)) break
          child <- scan(statement, result$continuing, in_closure)
          result <- append_exits(result, child)
          result$continuing <- child$continuing
        }
        return(result)
      }
      if (identical(head_symbol, "if") && length(node) >= 3L) {
        condition <- scan(node[[2L]], state, in_closure)
        if (is.null(condition$continuing)) return(condition)
        consequent <- scan(node[[3L]], condition$continuing, in_closure)
        alternative <- if (length(node) == 4L) scan(node[[4L]], condition$continuing, in_closure) else
          flow(continuing = condition$continuing)
        result <- merge_flows(list(consequent, alternative))
        return(append_exits(result, condition))
      }
      if (!is.null(head_symbol) && head_symbol %in% c("for", "while", "repeat")) {
        body_index <- if (identical(head_symbol, "for")) 4L else if (identical(head_symbol, "while")) 3L else 2L
        prefix <- if (identical(head_symbol, "for")) scan(node[[3L]], state, in_closure) else
          if (identical(head_symbol, "while")) scan(node[[2L]], state, in_closure) else
            flow(continuing = state)
        if (is.null(prefix$continuing)) return(prefix)
        base <- prefix$continuing
        if (identical(head_symbol, "for") && is.symbol(node[[2L]])) {
          base <- apply_binding(base, as.character(node[[2L]]), list(candidate("unknown")))
        }
        loop_state <- base
        accumulated <- flow()
        last_body <- NULL
        repeat {
          last_body <- scan(node[[body_index]], loop_state, in_closure)
          accumulated <- append_exits(accumulated, last_body)
          carried <- merge_states(list(last_body$continuing, last_body$nexts))
          if (is.null(carried)) break
          next_state <- merge_states(list(base, carried))
          if (identical(state_receipt(next_state), state_receipt(loop_state))) break
          loop_state <- next_state
        }
        output <- if (identical(head_symbol, "repeat")) accumulated$breaks else
          merge_states(list(prefix$continuing, last_body$continuing, last_body$nexts, accumulated$breaks))
        return(flow(
          continuing = output,
          returns = merge_states(list(prefix$returns, accumulated$returns)),
          breaks = prefix$breaks,
          nexts = prefix$nexts
        ))
      }
      if (!is.null(head_symbol) && head_symbol %in% c("<-", "=", "<<-") && length(node) == 3L) {
        target <- node[[2L]]
        value <- node[[3L]]
        is_function <- is.call(value) && is.symbol(value[[1L]]) &&
          identical(as.character(value[[1L]]), "function")
        value_flow <- if (is_function) flow(continuing = state) else scan(value, state, in_closure)
        if (is.null(value_flow$continuing)) return(value_flow)
        state <- value_flow$continuing
        if (is.symbol(target)) {
          symbol <- as.character(target)
          if (identical(head_symbol, "<<-")) {
            if (symbol %in% protected) state <- add_event(state, node, symbol)
            state <- apply_binding(state, symbol, resolve_value(value, state), nonlocal = TRUE)
          } else {
            if (!in_closure && symbol %in% protected) state <- add_event(state, node, symbol)
            state <- apply_binding(state, symbol, resolve_value(value, state))
          }
          value_flow$continuing <- state
          return(value_flow)
        }
        root <- assigned_root_symbol(target)
        if ((!in_closure || identical(head_symbol, "<<-")) &&
            !is.null(root) && root %in% protected) state <- add_event(state, node, root)
        if (is.call(target) && length(target) == 3L && is.symbol(target[[1L]]) &&
            as.character(target[[1L]]) %in% c("$", "[[") &&
            may_be_current_environment(target[[2L]], state)) {
          member <- target[[3L]]
          symbol <- if (is.symbol(member) ||
            (is.character(member) && length(member) == 1L && !is.na(member))) {
            as.character(member)
          } else "<unknown-current-environment>"
          state <- add_event(state, node, symbol)
        }
        value_flow$continuing <- state
        return(value_flow)
      }
      callee <- scan_callable(head, state, in_closure)
      arguments <- as.list(node)[-1L]
      result <- callee$flow
      for (argument in arguments) if (!identical(argument, quote(expr = ))) {
        if (is.null(result$continuing)) break
        argument_flow <- scan(argument, result$continuing, in_closure)
        result <- append_exits(result, argument_flow)
        result$continuing <- argument_flow$continuing
      }
      if (is.null(result$continuing)) return(result)
      state <- result$continuing
      callables <- callee$candidates
      builtin <- function(symbol) any(vapply(callables, function(value) {
        identical(value$kind, "builtin") && identical(value$symbol, symbol)
      }, logical(1L)))
      mutation_symbols <- c("assign", "rm", "remove")
      matched_mutator <- mutation_symbols[vapply(mutation_symbols, builtin, logical(1L))]
      if (length(matched_mutator) > 0L) {
        mutation_symbol <- matched_mutator[[1L]]
        formals <- if (identical(mutation_symbol, "assign")) {
          c("x", "value", "pos", "envir", "inherits", "immediate")
        } else c("...", "list", "pos", "envir", "inherits")
        matched <- matched_call_arguments(node, formals)
        environment <- matched[["envir"]]
        position <- matched[["pos"]]
        current <- if (!is.null(environment)) may_be_current_environment(environment, state) else
          if (!is.null(position)) may_be_current_environment(position, state) else TRUE
        if (current) {
          target <- if (identical(mutation_symbol, "assign")) matched[["x"]] else matched[["list"]]
          if (is.null(target) && length(arguments) > 0L) target <- arguments[[1L]]
          symbol <- if (is.character(target) && length(target) == 1L && !is.na(target)) {
            as.character(target)
          } else "<unknown-current-environment>"
          state <- add_event(state, node, symbol)
        }
      }
      invoke_closures <- function(candidates, state) {
        alternatives <- list()
        uncertain <- FALSE
        for (value in candidates) {
          if (!identical(value$kind, "closure")) {
            if (!identical(value$kind, "builtin")) uncertain <- TRUE
            next
          }
          definition <- value$node
          key <- node_key(definition, "closure")
          if (key %in% state$active) next
          closure_state <- state
          closure_state$updates <- list()
          closure_state$active <- c(state$active, key)
          closure_flow <- scan(definition[[3L]], closure_state, in_closure = TRUE)
          ended <- merge_states(flow_states(closure_flow))
          if (is.null(ended)) next
          applied <- state
          applied$events <- merge_states(list(state, ended))$events
          for (name in names(ended$updates)) {
            applied$bindings[[name]] <- ended$updates[[name]]
            applied$updates[[name]] <- ended$updates[[name]]
          }
          alternatives[[length(alternatives) + 1L]] <- applied
        }
        if (uncertain || length(alternatives) == 0L) alternatives <- c(list(state), alternatives)
        merge_states(alternatives)
      }
      closure_candidates <- Filter(function(value) identical(value$kind, "closure"), callables)
      if (length(closure_candidates) > 0L) state <- invoke_closures(callables, state)
      if (any(vapply(callables, function(value) identical(value$kind, "unknown"), logical(1L)))) {
        for (argument in arguments) {
          possible_callback <- resolve_callable(argument, state)
          if (any(vapply(possible_callback, function(value) {
                identical(value$kind, "closure")
              }, logical(1L)))) state <- invoke_closures(possible_callback, state)
        }
      }
      callback_symbols <- Filter(function(name) builtin(name), c(
        "do.call", "lapply", "sapply", "vapply", "Map", "mapply",
        "Filter", "Reduce", "apply", "forceAndCall"
      ))
      for (callback_symbol in callback_symbols) {
        contract <- executing_callback_contract(callback_symbol)
        matched <- matched_call_arguments(node, contract$formals)
        callback <- matched[[contract$callback]]
        if (is.null(callback) || identical(callback, quote(expr = ))) {
          state <- add_event(state, node, "<unknown-current-environment>")
          next
        }
        dispatched <- resolve_callable(callback, state)
        has_closure <- any(vapply(dispatched, function(value) identical(value$kind, "closure"), logical(1L)))
        unsafe_dispatch <- any(vapply(dispatched, function(value) {
          !(value$kind %in% c("builtin", "closure")) ||
            (identical(value$kind, "builtin") && (
              value$symbol %in% c("assign", "rm", "remove") ||
                !is.null(executing_callback_contract(value$symbol))
            ))
        }, logical(1L)))
        if (unsafe_dispatch) state <- add_event(state, node, "<unknown-current-environment>")
        if (has_closure) state <- invoke_closures(dispatched, state)
      }
      if (builtin("return")) {
        non_return <- any(!vapply(callables, function(value) {
          identical(value$kind, "builtin") && identical(value$symbol, "return")
        }, logical(1L)))
        result$returns <- merge_states(list(result$returns, state))
        result$continuing <- if (non_return) state else NULL
        return(result)
      }
      result$continuing <- state
      result
    }
    state <- empty_state()
    result <- flow(continuing = state)
    for (statement in statements) {
      if (is.null(result$continuing)) break
      child <- scan(statement, result$continuing)
      result <- append_exits(result, child)
      result$continuing <- child$continuing
    }
    final_state <- merge_states(flow_states(result))
    if (is.null(final_state)) character() else unname(unlist(final_state$events, use.names = FALSE))
  }

  exact_random_seed_restoration <- function(node, ancestors, current_function, scopes) {
    if (is.null(current_function) || !call_is(node, "assign", "base")) return(FALSE)
    arguments <- as.list(node)[-1L]
    argument_names <- names(arguments)
    if (length(arguments) != 3L || !identical(argument_names, c("", "", "envir")) ||
        !is.character(arguments[[1L]]) || !identical(arguments[[1L]], ".Random.seed") ||
        !is.symbol(arguments[[2L]]) || !identical(as.character(arguments[[2L]]), "previous_random_seed") ||
        !global_environment_expression(arguments[[3L]], scopes)) return(FALSE)

    enclosing_if <- NULL
    enclosing_on_exit <- NULL
    for (ancestor in rev(ancestors)) {
      if (is.null(enclosing_if) && is.call(ancestor) && is.symbol(ancestor[[1L]]) &&
          identical(as.character(ancestor[[1L]]), "if") && node_contains(ancestor, node)) enclosing_if <- ancestor
      if (is.null(enclosing_on_exit) && call_is(ancestor, "on.exit") && node_contains(ancestor, node)) {
        enclosing_on_exit <- ancestor
      }
    }
    if (is.null(enclosing_if) || is.null(enclosing_on_exit) || length(enclosing_if) != 4L ||
        !is.symbol(enclosing_if[[2L]]) || !identical(as.character(enclosing_if[[2L]]), "had_random_seed") ||
        !identical(single_statement(enclosing_if[[3L]]), node)) return(FALSE)

    removal_if <- enclosing_if[[4L]]
    if (!is.call(removal_if) || !is.symbol(removal_if[[1L]]) ||
        !identical(as.character(removal_if[[1L]]), "if") || length(removal_if) != 3L ||
        !exact_seed_environment_call(removal_if[[2L]], "exists", scopes)) return(FALSE)
    removal <- single_statement(removal_if[[3L]])
    if (!call_is(removal, "rm", "base") || length(removal) != 3L ||
        !is.character(removal[[2L]]) || !identical(removal[[2L]], ".Random.seed") ||
        !identical(names(as.list(removal)[-1L]), c("", "envir")) ||
        !global_environment_expression(removal[[3L]], scopes)) return(FALSE)

    on_exit_arguments <- as.list(enclosing_on_exit)[-1L]
    if (length(on_exit_arguments) != 2L || !identical(names(on_exit_arguments), c("", "add")) ||
        !identical(on_exit_arguments[[2L]], TRUE)) return(FALSE)
    body <- current_function[[3L]]
    statements <- if (is.call(body) && is.symbol(body[[1L]]) && identical(as.character(body[[1L]]), "{")) {
      as.list(body)[-1L]
    } else list(body)
    on_exit_index <- which(vapply(statements, identical, logical(1L), y = enclosing_on_exit))
    if (length(on_exit_index) != 1L) return(FALSE)
    before <- statements[seq_len(on_exit_index - 1L)]
    has_presence_snapshot <- any(vapply(before, function(statement) {
      assignment <- assignment_parts(statement)
      !is.null(assignment) && identical(assignment$symbol, "had_random_seed") &&
        exact_seed_environment_call(assignment$value, "exists", scopes)
    }, logical(1L)))
    has_value_snapshot <- any(vapply(before, function(statement) {
      if (!is.call(statement) || !is.symbol(statement[[1L]]) ||
          !identical(as.character(statement[[1L]]), "if") || length(statement) != 3L ||
          !is.symbol(statement[[2L]]) || !identical(as.character(statement[[2L]]), "had_random_seed")) return(FALSE)
      assignment <- assignment_parts(single_statement(statement[[3L]]))
      !is.null(assignment) && identical(assignment$symbol, "previous_random_seed") &&
        exact_seed_environment_call(assignment$value, "get", scopes)
    }, logical(1L)))
    snapshot_mutations <- seed_snapshot_mutations(statements)
    has_presence_snapshot && has_value_snapshot &&
      sum(snapshot_mutations == "had_random_seed") == 1L &&
      sum(snapshot_mutations == "previous_random_seed") == 1L &&
      !("<unknown-current-environment>" %in% snapshot_mutations)
  }

  assign_global_environment <- function(node, identity, candidates, ancestors, current_function, scopes) {
    if (is.null(identity) || !any(vapply(candidates, function(candidate) {
          identical(candidate$namespace, "base") && identical(candidate$symbol, "assign")
        }, logical(1L)))) {
      return(FALSE)
    }
    if (exact_random_seed_restoration(node, ancestors, current_function, scopes)) return(FALSE)
    formals <- c("x", "value", "pos", "envir", "inherits", "immediate")
    arguments <- matched_call_arguments(node, formals)
    any(vapply(seq_along(arguments), function(index) {
      names(arguments)[[index]] %in% c("envir", "pos") &&
        global_environment_expression(arguments[[index]], scopes)
    }, logical(1L)))
  }

  partial_targets <- function(argument, candidates) {
    targets <- character()
    for (candidate in candidates) {
      if (!identical(candidate$kind, "function") || is.null(candidate$formals) || argument %in% candidate$formals) next
      dots <- match("...", candidate$formals, nomatch = 0L)
      matchable <- if (dots == 0L) candidate$formals else if (dots == 1L) character() else candidate$formals[seq_len(dots - 1L)]
      matches <- matchable[startsWith(matchable, argument)]
      if (length(matches) == 1L) targets <- c(targets, matches[[1L]])
    }
    unique(targets)
  }

  callable_expression_label <- function(node) {
    if (is.symbol(node)) return(as.character(node))
    identity <- call_identity(node)
    if (!is.null(identity)) return(identity$symbol)
    if (!is.call(node)) return("computed")
    head <- if (is.symbol(node[[1L]])) as.character(node[[1L]]) else NULL
    if (identical(head, "(") && length(node) == 2L) return(callable_expression_label(node[[2L]]))
    if (identical(head, "{") && length(node) > 1L) {
      return(callable_expression_label(node[[length(node)]]))
    }
    if (identical(head, "if") && length(node) >= 3L) {
      labels <- callable_expression_label(node[[3L]])
      if (length(node) == 4L) labels <- c(labels, callable_expression_label(node[[4L]]))
      labels <- unique(labels)
      if (length(labels) == 1L) return(labels[[1L]])
    }
    "computed"
  }

  collect_partial_arguments <- function(node, symbol, candidates, path, collector, locator, receipt, line) {
    arguments <- as.list(node)[-1L]
    argument_names <- names(arguments)
    if (length(arguments) == 0L || is.null(argument_names)) return(invisible(NULL))
    named_index <- 0L
    for (index in seq_along(arguments)) {
      argument <- argument_names[[index]]
      if (!nzchar(argument)) next
      named_index <- named_index + 1L
      targets <- partial_targets(argument, candidates)
      if (length(targets) == 0L) next
      argument_receipt <- locator$argument(receipt, named_index, line)
      collector$add(
        path,
        argument_receipt$line,
        "partial-argument",
        paste(symbol, argument, sep = ":"),
        sprintf("argument %s partially matches %s", argument, paste(targets, collapse = " or ")),
        argument_receipt$operation
      )
    }
    invisible(NULL)
  }

  make_analysis_context <- function() {
    state <- new.env(hash = FALSE, parent = emptyenv())
    state$serial <- 0L
    state$definitions <- list()
    state$frames <- list(character())
    state$called <- character()
    state$active <- character()
    state$analysis_keys <- new.env(hash = TRUE, parent = emptyenv())
    state$analysis_results <- new.env(hash = TRUE, parent = emptyenv())
    state$definition_nodes <- new.env(hash = TRUE, parent = emptyenv())
    register_definition <- function(node, deferred = TRUE) {
      node_id <- attr(node, "openwrangler_node_id", exact = TRUE)
      if (length(node_id) != 1L || is.na(node_id)) fail("a function definition has no exact syntax identity")
      node_key <- as.character(as.integer(node_id))
      if (exists(node_key, envir = state$definition_nodes, inherits = FALSE)) {
        return(get(node_key, envir = state$definition_nodes, inherits = FALSE))
      }
      state$serial <- state$serial + 1L
      id <- sprintf("function-%d", state$serial)
      state$definitions[[id]] <- list(node = node, candidate = NULL)
      assign(node_key, id, envir = state$definition_nodes)
      if (deferred) {
        index <- length(state$frames)
        state$frames[[index]] <- c(state$frames[[index]], id)
      }
      id
    }
    list(
      register_definition = register_definition,
      bind_definition = function(id, candidate) {
        state$definitions[[id]]$candidate <- candidate
        invisible(NULL)
      },
      definition = function(id) state$definitions[[id]],
      push_frame = function() {
        state$frames[[length(state$frames) + 1L]] <- character()
        invisible(NULL)
      },
      pop_frame = function() {
        index <- length(state$frames)
        ids <- state$frames[[index]]
        state$frames[[index]] <- NULL
        ids
      },
      root_frame = function() state$frames[[1L]],
      clear_root_frame = function() {
        state$frames[[1L]] <- character()
        invisible(NULL)
      },
      mark_called = function(id) {
        state$called <- unique(c(state$called, id))
        invisible(NULL)
      },
      was_called = function(id) id %in% state$called,
      claim_analysis = function(id, scopes) {
        scope_states <- vapply(scopes, function(scope) {
          value <- attr(scope, "openwrangler_scope_state", exact = TRUE)
          if (length(value) != 1L || is.na(value)) fail("an analysis scope has no exact state identity")
          as.integer(value)
        }, integer(1L))
        charge_work("operations", length(scope_states) + 1L)
        key <- paste(id, paste(scope_states, collapse = "-"), sep = "-")
        if (exists(key, envir = state$analysis_keys, inherits = FALSE)) {
          return(list(
            key = key,
            fresh = FALSE,
            result = if (exists(key, envir = state$analysis_results, inherits = FALSE)) {
              get(key, envir = state$analysis_results, inherits = FALSE)
            } else scopes
          ))
        }
        charge_work("candidate_states")
        assign(key, TRUE, envir = state$analysis_keys)
        list(key = key, fresh = TRUE, result = NULL)
      },
      store_analysis = function(key, scopes) {
        charge_work("candidate_states", length(scopes) + 1L)
        assign(key, scopes, envir = state$analysis_results)
        invisible(NULL)
      },
      enter = function(id) {
        if (id %in% state$active) return(FALSE)
        state$active <- c(state$active, id)
        TRUE
      },
      leave = function(id) {
        state$active <- state$active[state$active != id]
        invisible(NULL)
      }
    )
  }

  analyze_function_candidate <- function(candidate, path, collector, scopes, locator, ancestors, context,
                                         invoked = TRUE) {
    id <- candidate$definition_id
    if (is.null(id) || is.null(candidate$definition)) return(scopes)
    owners <- vapply(scopes, function(scope) {
      value <- attr(scope, "openwrangler_scope_owner", exact = TRUE)
      if (length(value) != 1L || is.na(value)) fail("an analysis scope has no exact lexical owner")
      as.integer(value)
    }, integer(1L))
    owner_index <- match(candidate$lexical_owner, owners, nomatch = 0L)
    if (owner_index == 0L) fail("a function candidate escaped its exact lexical owner")
    lexical_scopes <- scopes[seq.int(owner_index, length(scopes))]
    if (invoked) context$mark_called(id)
    claim <- context$claim_analysis(id, lexical_scopes)
    if (!claim$fresh) {
      scopes[seq.int(owner_index, length(scopes))] <- claim$result
      return(scopes)
    }
    if (!context$enter(id)) {
      context$store_analysis(claim$key, lexical_scopes)
      return(scopes)
    }
    on.exit(context$leave(id), add = TRUE)
    context$push_frame()
    definition <- candidate$definition
    child_scopes <- c(list(function_parameter_scope(definition[[2L]])), lexical_scopes)
    defaults <- as.list(definition[[2L]])
    for (index in seq_along(defaults)) {
      if (!identical(defaults[index][[1L]], quote(expr = ))) {
        child_scopes <- inspect_calls(
          defaults[[index]], path, collector, child_scopes, locator,
          c(ancestors, list(definition)), definition, context
        )$scopes
      }
    }
    result <- inspect_calls(
      definition[[3L]], path, collector, child_scopes, locator,
      c(ancestors, list(definition)), definition, context
    )
    nested <- context$pop_frame()
    flush_deferred_definitions(nested, path, collector, result$scopes, locator, ancestors, context)
    projected <- result$scopes[-1L]
    if (length(projected) != length(lexical_scopes)) fail("a closure effect escaped its lexical scope")
    context$store_analysis(claim$key, projected)
    scopes[seq.int(owner_index, length(scopes))] <- projected
    scopes
  }

  flush_deferred_definitions <- function(ids, path, collector, scopes, locator, ancestors, context) {
    if (length(ids) == 0L) return(invisible(NULL))
    charge_work("operations", length(ids))
    for (id in unique(ids)) {
      if (context$was_called(id)) next
      definition <- context$definition(id)
      if (is.null(definition$candidate)) fail("a deferred function candidate is incomplete")
      analyze_function_candidate(
        definition$candidate, path, collector, scopes, locator, ancestors, context, invoked = FALSE
      )
    }
    invisible(NULL)
  }

  apply_callable_effects <- function(candidates, path, collector, scopes, locator, ancestors, context) {
    alternatives <- list()
    unchanged <- FALSE
    for (candidate in candidates) {
      charge_work("operations")
      if (identical(candidate$kind, "function") && !is.null(candidate$definition)) {
        alternatives[[length(alternatives) + 1L]] <- analyze_function_candidate(
          candidate, path, collector, scopes, locator, ancestors, context
        )
      } else unchanged <- TRUE
    }
    if (unchanged || length(alternatives) == 0L) alternatives <- c(list(scopes), alternatives)
    if (length(alternatives) == 1L) alternatives[[1L]] else merge_branch_scopes(scopes, alternatives)
  }

  apply_callback_effects <- function(node, candidates, path, collector, scopes, locator, ancestors, context) {
    callback_symbols <- unique(vapply(candidates, function(candidate) {
      if (identical(candidate$namespace, "base") && !is.null(executing_callback_contract(candidate$symbol))) {
        candidate$symbol
      } else ""
    }, character(1L)))
    current <- scopes
    for (callback_symbol in callback_symbols[nzchar(callback_symbols)]) {
      contract <- executing_callback_contract(callback_symbol)
      matched <- matched_call_arguments(node, contract$formals)
      callback <- matched[[contract$callback]]
      if (is.null(callback) || identical(callback, quote(expr = ))) next
      dispatched <- callable_expression_candidates(callback, current, context)
      if (length(dispatched) == 0L) next
      current <- apply_callable_effects(
        dispatched, path, collector, current, locator, ancestors, context
      )
    }
    current
  }

  inspect_callable_expression <- function(node, path, collector, scopes, locator, ancestors,
                                          current_function, context) {
    charge_work("operations")
    if (is.symbol(node) || !is.null(call_identity(node)) ||
        (is.call(node) && is.symbol(node[[1L]]) && identical(as.character(node[[1L]]), "function"))) {
      return(list(
        candidates = callable_expression_candidates(node, scopes, context), scopes = scopes,
        terminal = NULL, break_scopes = NULL, next_scopes = NULL, terminal_scopes = NULL
      ))
    }
    if (!is.call(node)) return(list(
      candidates = list(), scopes = scopes, terminal = NULL,
      break_scopes = NULL, next_scopes = NULL, terminal_scopes = NULL
    ))
    head <- if (is.symbol(node[[1L]])) as.character(node[[1L]]) else NULL
    if (identical(head, "(") && length(node) == 2L) {
      return(inspect_callable_expression(
        node[[2L]], path, collector, scopes, locator, c(ancestors, list(node)), current_function, context
      ))
    }
    if (identical(head, "{") && length(node) > 1L) {
      expressions <- as.list(node)[-1L]
      current <- scopes
      exits <- list(break_scopes = NULL, next_scopes = NULL, terminal_scopes = NULL)
      if (length(expressions) > 1L) for (expression in expressions[-length(expressions)]) {
        before <- current
        result <- inspect_calls(
          expression, path, collector, current, locator,
          c(ancestors, list(node)), current_function, context
        )
        exits <- merge_result_exits(scopes, exits, result)
        terminal <- if (!is.null(result[["terminal"]])) result[["terminal"]] else
          terminal_expression(expression, before)
        if (!is.null(terminal)) {
          exits <- add_terminal_exit(scopes, exits, terminal, result$scopes)
          collector$add(
            path,
            if (is.null(result$line)) source_line(expression) else result$line,
            "unreachable-expression",
            terminal,
            "computed callable follows an unconditional terminal prelude"
          )
          return(c(list(candidates = list(), scopes = result$scopes, terminal = terminal), exits))
        }
        current <- result$scopes
      }
      final <- inspect_callable_expression(
        expressions[[length(expressions)]], path, collector, current, locator,
        c(ancestors, list(node)), current_function, context
      )
      exits <- merge_result_exits(scopes, exits, final)
      return(c(list(
        candidates = final$candidates,
        scopes = final$scopes,
        terminal = final$terminal
      ), exits))
    }
    if (identical(head, "if") && length(node) >= 3L) {
      condition <- inspect_calls(
        node[[2L]], path, collector, scopes, locator,
        c(ancestors, list(node)), current_function, context
      )
      consequent <- inspect_callable_expression(
        node[[3L]], path, collector, condition$scopes, locator,
        c(ancestors, list(node)), current_function, context
      )
      alternative <- if (length(node) == 4L) inspect_callable_expression(
        node[[4L]], path, collector, condition$scopes, locator,
        c(ancestors, list(node)), current_function, context
      ) else list(
        candidates = list(mask_candidate()), scopes = condition$scopes, terminal = NULL,
        break_scopes = NULL, next_scopes = NULL, terminal_scopes = NULL
      )
      exits <- list(break_scopes = NULL, next_scopes = NULL, terminal_scopes = NULL)
      exits <- merge_result_exits(condition$scopes, exits, condition)
      exits <- merge_result_exits(condition$scopes, exits, consequent)
      exits <- merge_result_exits(condition$scopes, exits, alternative)
      continuing <- Filter(function(result) is.null(result$terminal), list(consequent, alternative))
      candidates <- unique_candidates(unlist(lapply(continuing, `[[`, "candidates"), recursive = FALSE))
      continuing_scopes <- lapply(continuing, `[[`, "scopes")
      merged <- if (length(continuing_scopes) == 0L) condition$scopes else
        merge_branch_scopes(condition$scopes, continuing_scopes)
      return(c(list(
        candidates = candidates,
        scopes = merged,
        terminal = if (length(continuing) == 0L) "if" else NULL
      ), exits))
    }
    evaluated <- inspect_calls(
      node, path, collector, scopes, locator, c(ancestors, list(node)), current_function, context
    )
    c(list(
      candidates = callable_expression_candidates(node, evaluated$scopes, context),
      scopes = evaluated$scopes,
      terminal = evaluated[["terminal"]]
    ), list(
      break_scopes = evaluated[["break_scopes"]],
      next_scopes = evaluated[["next_scopes"]],
      terminal_scopes = evaluated[["terminal_scopes"]]
    ))
  }

  inspect_calls <- function(node, path, collector, scopes, locator, ancestors = list(), current_function = NULL,
                            context) {
    charge_work("operations")
    if (!is.call(node)) return(list(line = NULL, scopes = scopes))
    head <- node[[1L]]
    line <- source_line(node)
    if (is.symbol(head) && identical(as.character(head), "function")) {
      definition_id <- context$register_definition(node, deferred = FALSE)
      candidate <- function_candidate(
        names(node[[2L]]),
        definition = node,
        definition_id = definition_id,
        lexical_owner = attr(scopes[[1L]], "openwrangler_scope_owner", exact = TRUE)
      )
      context$bind_definition(definition_id, candidate)
      analyze_function_candidate(candidate, path, collector, scopes, locator, ancestors, context)
      return(list(line = line, scopes = scopes))
    }

    if (is.symbol(head) && identical(as.character(head), "{") && length(node) > 1L) {
      context$push_frame()
      current <- scopes
      exits <- list(break_scopes = NULL, next_scopes = NULL, terminal_scopes = NULL)
      pending_terminal <- NULL
      pending_line <- NULL
      for (statement in as.list(node)[-1L]) {
        reachable <- is.null(pending_terminal)
        if (!is.null(pending_terminal)) {
          collector$add(
            path, pending_line, "unreachable-expression", pending_terminal,
            "expression follows an unconditional terminal expression"
          )
        }
        before <- current
        result <- inspect_calls(
          statement, path, collector, current, locator, c(ancestors, list(node)), current_function, context
        )
        if (reachable) {
          exits <- merge_result_exits(scopes, exits, result)
          pending_terminal <- if (!is.null(result[["terminal"]])) result[["terminal"]] else
            terminal_expression(statement, before)
          if (!is.null(pending_terminal)) {
            exits <- add_terminal_exit(scopes, exits, pending_terminal, result$scopes)
          }
        }
        pending_line <- if (is.null(result$line)) line else result$line
        if (reachable) current <- result$scopes
      }
      deferred <- context$pop_frame()
      flush_deferred_definitions(deferred, path, collector, current, locator, ancestors, context)
      return(c(list(line = line, scopes = current, terminal = pending_terminal), exits))
    }

    if (is.symbol(head) && identical(as.character(head), "if") && length(node) >= 3L) {
      condition <- inspect_calls(
        node[[2L]], path, collector, scopes, locator, c(ancestors, list(node)), current_function, context
      )
      consequent <- inspect_calls(
        node[[3L]], path, collector, condition$scopes, locator, c(ancestors, list(node)), current_function, context
      )
      alternative <- if (length(node) == 4L) inspect_calls(
        node[[4L]], path, collector, condition$scopes, locator,
        c(ancestors, list(node)), current_function, context
      ) else list(scopes = condition$scopes)
      continuing <- list()
      exits <- list(break_scopes = NULL, next_scopes = NULL, terminal_scopes = NULL)
      exits <- merge_result_exits(condition$scopes, exits, consequent)
      exits <- merge_result_exits(condition$scopes, exits, alternative)
      consequent_terminal <- if (!is.null(consequent[["terminal"]])) consequent[["terminal"]] else
        terminal_expression(node[[3L]], condition$scopes)
      if (is.null(consequent_terminal)) {
        continuing <- c(continuing, list(consequent$scopes))
      } else {
        exits <- add_terminal_exit(condition$scopes, exits, consequent_terminal, consequent$scopes)
      }
      alternative_terminal <- if (length(node) == 4L) {
        if (!is.null(alternative[["terminal"]])) alternative[["terminal"]] else
          terminal_expression(node[[4L]], condition$scopes)
      } else NULL
      if (length(node) != 4L || is.null(alternative_terminal)) {
        continuing <- c(continuing, list(alternative$scopes))
      } else {
        exits <- add_terminal_exit(condition$scopes, exits, alternative_terminal, alternative$scopes)
      }
      merged <- if (length(continuing) == 0L) condition$scopes else
        merge_branch_scopes(condition$scopes, continuing)
      return(c(list(
        line = if (is.null(condition$line)) line else condition$line,
        scopes = merged,
        terminal = if (length(node) == 4L && !is.null(consequent_terminal) &&
          !is.null(alternative_terminal)) "if" else NULL
      ), exits))
    }

    if (is.symbol(head) && identical(as.character(head), "for") && length(node) == 4L) {
      sequence_result <- inspect_calls(
        node[[3L]], path, collector, scopes, locator, c(ancestors, list(node)), current_function, context
      )
      loop_scopes <- sequence_result$scopes
      if (is.symbol(node[[2L]])) {
        loop_scopes <- set_local_binding(loop_scopes, as.character(node[[2L]]), list(mask_candidate()))
      }
      body <- NULL
      break_scopes <- NULL
      terminal_scopes <- NULL
      repeat {
        body <- inspect_calls(
          node[[4L]], path, collector, loop_scopes, locator,
          c(ancestors, list(node)), current_function, context
        )
        break_scopes <- merge_exit_scope(sequence_result$scopes, break_scopes, body$break_scopes)
        terminal_scopes <- merge_exit_scope(sequence_result$scopes, terminal_scopes, body$terminal_scopes)
        iteration_alternatives <- list(sequence_result$scopes)
        body_terminal <- if (!is.null(body[["terminal"]])) body[["terminal"]] else
          terminal_expression(node[[4L]], loop_scopes)
        if (is.null(body_terminal)) {
          iteration_alternatives <- c(iteration_alternatives, list(body$scopes))
        }
        if (!is.null(body$next_scopes)) iteration_alternatives <- c(iteration_alternatives, list(body$next_scopes))
        next_scopes <- merge_branch_scopes(sequence_result$scopes, iteration_alternatives)
        if (is.symbol(node[[2L]])) {
          next_scopes <- set_local_binding(next_scopes, as.character(node[[2L]]), list(mask_candidate()))
        }
        if (same_scope_bindings(next_scopes, loop_scopes)) break
        loop_scopes <- next_scopes
      }
      output_alternatives <- list(sequence_result$scopes)
      body_terminal <- if (!is.null(body[["terminal"]])) body[["terminal"]] else
        terminal_expression(node[[4L]], loop_scopes)
      if (is.null(body_terminal)) {
        output_alternatives <- c(output_alternatives, list(body$scopes))
      }
      if (!is.null(body$next_scopes)) output_alternatives <- c(output_alternatives, list(body$next_scopes))
      if (!is.null(break_scopes)) output_alternatives <- c(output_alternatives, list(break_scopes))
      return(list(
        line = if (is.null(sequence_result$line)) line else sequence_result$line,
        scopes = merge_branch_scopes(sequence_result$scopes, output_alternatives),
        terminal_scopes = terminal_scopes
      ))
    }

    if (is.symbol(head) && identical(as.character(head), "while") && length(node) == 3L) {
      loop_scopes <- scopes
      condition <- NULL
      body <- NULL
      break_scopes <- NULL
      terminal_scopes <- NULL
      repeat {
        condition <- inspect_calls(
          node[[2L]], path, collector, loop_scopes, locator,
          c(ancestors, list(node)), current_function, context
        )
        body <- inspect_calls(
          node[[3L]], path, collector, condition$scopes, locator,
          c(ancestors, list(node)), current_function, context
        )
        break_scopes <- merge_exit_scope(scopes, break_scopes, body$break_scopes)
        terminal_scopes <- merge_exit_scope(scopes, terminal_scopes, body$terminal_scopes)
        iteration_alternatives <- list(condition$scopes)
        body_terminal <- if (!is.null(body[["terminal"]])) body[["terminal"]] else
          terminal_expression(node[[3L]], condition$scopes)
        if (is.null(body_terminal)) {
          iteration_alternatives <- c(iteration_alternatives, list(body$scopes))
        }
        if (!is.null(body$next_scopes)) iteration_alternatives <- c(iteration_alternatives, list(body$next_scopes))
        next_scopes <- merge_branch_scopes(scopes, iteration_alternatives)
        if (same_scope_bindings(next_scopes, loop_scopes)) break
        loop_scopes <- next_scopes
      }
      output_alternatives <- list(condition$scopes)
      if (!is.null(break_scopes)) output_alternatives <- c(output_alternatives, list(break_scopes))
      return(list(
        line = if (is.null(condition$line)) line else condition$line,
        scopes = merge_branch_scopes(condition$scopes, output_alternatives),
        terminal_scopes = terminal_scopes
      ))
    }

    if (is.symbol(head) && identical(as.character(head), "repeat") && length(node) == 2L) {
      loop_scopes <- scopes
      body <- NULL
      break_scopes <- NULL
      terminal_scopes <- NULL
      repeat {
        body <- inspect_calls(
          node[[2L]], path, collector, loop_scopes, locator,
          c(ancestors, list(node)), current_function, context
        )
        break_scopes <- merge_exit_scope(scopes, break_scopes, body$break_scopes)
        terminal_scopes <- merge_exit_scope(scopes, terminal_scopes, body$terminal_scopes)
        iteration_alternatives <- list()
        body_terminal <- if (!is.null(body[["terminal"]])) body[["terminal"]] else
          terminal_expression(node[[2L]], loop_scopes)
        if (is.null(body_terminal)) iteration_alternatives <- c(iteration_alternatives, list(body$scopes))
        if (!is.null(body$next_scopes)) iteration_alternatives <- c(iteration_alternatives, list(body$next_scopes))
        if (length(iteration_alternatives) == 0L) break
        next_scopes <- merge_branch_scopes(scopes, iteration_alternatives)
        if (same_scope_bindings(next_scopes, loop_scopes)) break
        loop_scopes <- next_scopes
      }
      output_scopes <- if (is.null(break_scopes)) loop_scopes else break_scopes
      return(list(
        line = if (is.null(body$line)) line else body$line,
        scopes = output_scopes,
        terminal_scopes = terminal_scopes,
        terminal = if (is.null(break_scopes)) "repeat" else NULL
      ))
    }

    if (is.symbol(head) && identical(as.character(head), "<<-") && length(node) == 3L) {
      assignment_receipt <- locator$assignment(node, line)
      binding <- if (is.symbol(node[[2L]])) value_binding(node[[3L]], scopes, context) else NULL
      result <- inspect_calls(
        node[[3L]], path, collector, scopes, locator, c(ancestors, list(node)), current_function, context
      )
      if (is.symbol(node[[2L]])) {
        result$scopes <- set_nonlocal_binding(result$scopes, as.character(node[[2L]]), binding)
      }
      result$line <- assignment_receipt$line
      return(result)
    }

    if (is.symbol(head) && as.character(head) %in% c("<-", "=") && length(node) == 3L) {
      assignment_receipt <- locator$assignment(node, line)
      line <- assignment_receipt$line
      assignment <- assignment_parts(node)
      binding <- NULL
      if (!is.null(assignment)) {
        binding <- value_binding(assignment$value, scopes, context)
      }
      is_deferred_function <- !is.null(assignment) && is.call(assignment$value) &&
        is.symbol(assignment$value[[1L]]) && identical(as.character(assignment$value[[1L]]), "function")
      result <- if (is_deferred_function) list(scopes = scopes) else inspect_calls(
        node[[3L]], path, collector, scopes, locator, c(ancestors, list(node)), current_function, context
      )
      if (is.null(terminal_expression(node[[3L]], scopes))) {
        member <- global_member_symbol(node[[2L]], result$scopes)
        if (!is.null(member)) {
          collector$add(
            path, line, "global-assignment", member, "direct assignment mutates .GlobalEnv",
            assignment_receipt$operation
          )
        }
      }
      if (!is.null(assignment)) result$scopes <- set_local_binding(result$scopes, assignment$symbol, binding)
      result$line <- line
      return(result)
    }

    identity <- call_identity(head)
    if (is.null(identity)) {
      callee <- inspect_callable_expression(
        head, path, collector, scopes, locator, c(ancestors, list(node)), current_function, context
      )
      if (!is.null(callee$terminal)) {
        return(list(
          line = line,
          scopes = callee$scopes,
          terminal = callee$terminal,
          break_scopes = callee$break_scopes,
          next_scopes = callee$next_scopes,
          terminal_scopes = callee$terminal_scopes
        ))
      }
      current <- callee$scopes
      receipt <- locator$call(node, line)
      collect_partial_arguments(
        node, callable_expression_label(head), callee$candidates,
        path, collector, locator, receipt, line
      )
      arguments <- as.list(node)[-1L]
      for (argument in arguments) if (!identical(argument, quote(expr = ))) {
        current <- inspect_calls(
          argument, path, collector, current, locator,
          c(ancestors, list(node)), current_function, context
        )$scopes
      }
      if (length(callee$candidates) > 0L) {
        current <- apply_callable_effects(
          callee$candidates, path, collector, current, locator,
          c(ancestors, list(node)), context
        )
        current <- apply_callback_effects(
          node, callee$candidates, path, collector, current, locator,
          c(ancestors, list(node)), context
        )
      }
      terminal_candidates <- vapply(callee$candidates, function(candidate) {
        identical(candidate$kind, "function") && isTRUE(candidate$terminal)
      }, logical(1L))
      any_terminal <- any(terminal_candidates)
      all_terminal <- length(terminal_candidates) > 0L && all(terminal_candidates)
      terminal_scopes <- callee$terminal_scopes
      if (any_terminal) terminal_scopes <- merge_exit_scope(current, terminal_scopes, current)
      return(list(
        line = receipt$line,
        scopes = current,
        terminal = if (all_terminal) callable_expression_label(head) else NULL,
        break_scopes = callee$break_scopes,
        next_scopes = callee$next_scopes,
        terminal_scopes = terminal_scopes
      ))
    }
    receipt <- locator$call(node, line)
    line <- receipt$line
    candidates <- callable_candidates(identity, scopes)
    if (assign_global_environment(node, identity, candidates, ancestors, current_function, scopes)) {
      collector$add(
        path, line, "global-assignment", "assign:.GlobalEnv", "base::assign mutates .GlobalEnv",
        receipt$operation
      )
    }
    symbol <- identity$symbol
    if (symbol %in% c("library", "require", "attach", "attachNamespace") &&
        any(vapply(candidates, function(candidate) identical(candidate$namespace, "base"), logical(1L)))) {
      collector$add(path, line, "namespace-attachment", symbol, "namespace attachment is forbidden")
    }
    arguments <- as.list(node)[-1L]
    collect_partial_arguments(node, symbol, candidates, path, collector, locator, receipt, line)

    current <- scopes
    for (index in seq_along(arguments)) {
      if (!identical(arguments[[index]], quote(expr = ))) {
        current <- inspect_calls(
          arguments[[index]], path, collector, current, locator, c(ancestors, list(node)), current_function, context
        )$scopes
      }
    }
    current <- apply_callable_effects(
      candidates, path, collector, current, locator, c(ancestors, list(node)), context
    )
    current <- apply_callback_effects(
      node, candidates, path, collector, current, locator, c(ancestors, list(node)), context
    )
    list(line = line, scopes = current)
  }

  inspect_codetools <- function(text, path, collector, locator, maximum_diagnostics) {
    wrapped_text <- paste("function() {", text, "}", sep = "\n")
    source_file <- srcfilecopy(path, wrapped_text, isFile = FALSE)
    wrapper <- parse(text = wrapped_text, srcfile = source_file, keep.source = TRUE)[[1L]]
    function_value <- eval(wrapper, envir = baseenv())
    old_options <- options(useFancyQuotes = FALSE)
    on.exit(options(old_options), add = TRUE)
    messages <- character()
    codetools::checkUsage(
      function_value,
      name = path,
      report = function(message) {
        if (length(messages) >= maximum_diagnostics) fail("codetools diagnostic count exceeds its policy bound")
        charge_work("operations", length(messages) + 1L)
        charge_work("diagnostic_bytes", nchar(message, type = "bytes"))
        messages <<- c(messages, message)
      }
    )
    for (message in messages) {
      if (grepl("Error while checking", message, fixed = TRUE)) {
        fail(sprintf("codetools could not analyze %s: %s", path, message))
      }
      message <- sub("[\\r\\n]+$", "", message)
      location <- regexec("\\((.*):([0-9]+)(?:-[0-9]+)?\\)$", message, perl = TRUE)
      match <- regmatches(message, location)[[1L]]
      if (length(match) != 3L) next
      line <- as.integer(match[[3L]]) - 1L
      body <- sub(" \\([^()]++:[0-9]+(?:-[0-9]+)?\\)$", "", message, perl = TRUE)
      patterns <- list(
        list(rule = "global-assignment", regex = "no visible binding for '<<-' assignment to '([^']+)'"),
        list(rule = "unqualified-call", regex = "no visible global function definition for '([^']+)'"),
        list(rule = "undefined-symbol", regex = "no visible binding for global variable '([^']+)'")
      )
      for (pattern in patterns) {
        result <- regexec(pattern$regex, body, perl = TRUE)
        captured <- regmatches(body, result)[[1L]]
        if (length(captured) == 2L) {
          collector$add(
            path, line, pattern$rule, captured[[2L]], body,
            locator$codetools(pattern$rule, captured[[2L]], line)
          )
          break
        }
      }
    }
    invisible(NULL)
  }

  analyze_text <- function(text, path, limits) {
    work <- make_work_budget(limits)
    previous_work_budget <- active_work_budget
    previous_scope_serial <- active_scope_serial
    active_work_budget <<- work
    active_scope_serial <<- 0L
    on.exit(active_work_budget <<- previous_work_budget, add = TRUE)
    on.exit(active_scope_serial <<- previous_scope_serial, add = TRUE)
    source_file <- srcfilecopy(path, text, isFile = FALSE)
    expressions <- tryCatch(
      parse(text = text, srcfile = source_file, keep.source = TRUE),
      error = function(condition) fail(sprintf("%s does not parse: %s", path, conditionMessage(condition)))
    )
    ast_budget(expressions, limits$ast_nodes, limits$ast_depth)
    collector <- diagnostic_collector(limits$diagnostics)
    scopes <- list(new_scope())
    locator <- source_locator(source_file)
    expressions <- locator$annotate(expressions)
    context <- make_analysis_context()
    for (expression in expressions) {
      scopes <- inspect_calls(expression, path, collector, scopes, locator, context = context)$scopes
    }
    deferred <- context$root_frame()
    context$clear_root_frame()
    flush_deferred_definitions(deferred, path, collector, scopes, locator, list(), context)
    inspect_codetools(text, path, collector, locator, limits$diagnostics)
    values <- collector$values()
    attr(values, "work") <- work$used()
    values
  }

  parse_suppressions <- function(root, policy) {
    path <- file.path(root, "r/static-analysis-suppressions.tsv")
    text <- read_bounded_utf8(path, 65536L, "suppression ledger")
    lines <- strsplit(text, "\n", fixed = TRUE)[[1L]]
    if (length(lines) > 0L && identical(lines[[length(lines)]], "")) lines <- lines[-length(lines)]
    if (length(lines) < 1L || !identical(
          lines[[1L]], "path\tline\toperation\trule\tsymbol\tjustification"
        )) {
      fail("suppression ledger header is not exact")
    }
    entries <- lines[-1L]
    if (length(entries) > policy$limits$suppressions) fail("suppression count exceeds its policy bound")
    parsed <- vector("list", length(entries))
    keys <- character()
    counts <- structure(integer(length(rule_names)), names = rule_names)
    for (index in seq_along(entries)) {
      fields <- strsplit(entries[[index]], "\t", fixed = TRUE)[[1L]]
      if (length(fields) != 6L || any(!nzchar(fields))) fail(sprintf("suppression row %d is malformed", index + 1L))
      names(fields) <- c("path", "line", "operation", "rule", "symbol", "justification")
      if (!(fields[["path"]] %in% policy$paths) || !(fields[["rule"]] %in% rule_names)) {
        fail(sprintf("suppression row %d has an unowned path or rule", index + 1L))
      }
      has_wildcard <- function(value) any(vapply(c("*", "?", "["), grepl, logical(1L), x = value, fixed = TRUE))
      if (has_wildcard(fields[["path"]]) || has_wildcard(fields[["rule"]]) ||
          has_wildcard(fields[["operation"]]) || has_wildcard(fields[["symbol"]])) {
        fail(sprintf("suppression row %d contains a wildcard", index + 1L))
      }
      line <- scalar_integer(fields[["line"]], sprintf("suppression row %d line", index + 1L), 1L)
      if (!grepl("^[A-Za-z0-9:.-]+$", fields[["operation"]]) ||
          nchar(fields[["operation"]], type = "bytes") > 96L ||
          nchar(fields[["symbol"]], type = "bytes") > 256L ||
          nchar(fields[["justification"]], type = "bytes") > 1024L ||
          !identical(fields[["justification"]], trimws(fields[["justification"]]))) {
        fail(sprintf("suppression row %d exceeds text bounds or has padded justification", index + 1L))
      }
      key <- paste(
        fields[["path"]], line, fields[["operation"]], fields[["rule"]], fields[["symbol"]], sep = "\t"
      )
      if (key %in% keys) fail(sprintf("suppression row %d duplicates an earlier entry", index + 1L))
      keys <- c(keys, key)
      counts[[fields[["rule"]]]] <- counts[[fields[["rule"]]]] + 1L
      parsed[[index]] <- list(
        path = fields[["path"]],
        line = line,
        operation = fields[["operation"]],
        rule = fields[["rule"]],
        symbol = fields[["symbol"]],
        justification = fields[["justification"]],
        key = key
      )
    }
    for (rule in rule_names) {
      if (counts[[rule]] > policy$ratchets[[rule]]) {
        fail(sprintf("suppression ratchet exceeded for %s", rule))
      }
    }
    parsed
  }

  apply_suppressions <- function(diagnostics, suppressions) {
    diagnostic_keys <- vapply(diagnostics, `[[`, character(1L), "key")
    suppression_keys <- vapply(suppressions, `[[`, character(1L), "key")
    unused <- setdiff(suppression_keys, diagnostic_keys)
    if (length(unused) > 0L) fail(sprintf("stale or unused suppression: %s", unused[[1L]]))
    diagnostics[!(diagnostic_keys %in% suppression_keys)]
  }

  run <- function(root = ".") {
    if (!requireNamespace("codetools", quietly = TRUE)) fail("codetools is unavailable")
    installed <- utils::packageDescription("codetools", fields = "Version")
    if (!identical(installed, codetools_version)) {
      fail(sprintf("codetools %s is required, found %s", codetools_version, installed))
    }
    policy <- read_policy(root)
    validate_inventory(root, policy$paths)
    aggregate <- 0
    diagnostics <- list()
    for (relative_path in policy$paths) {
      full_path <- file.path(root, relative_path)
      info <- file.info(full_path, extra_cols = FALSE)
      if (nrow(info) != 1L || is.na(info$size)) fail(sprintf("production source is unavailable: %s", relative_path))
      aggregate <- aggregate + info$size
      if (aggregate > policy$limits$aggregate_source_bytes) fail("aggregate production source bytes exceed the policy bound")
      text <- read_bounded_utf8(full_path, policy$limits$source_bytes, "production source")
      diagnostics <- c(diagnostics, analyze_text(text, relative_path, policy$limits))
      if (length(diagnostics) > policy$limits$diagnostics) fail("aggregate diagnostic count exceeds the policy bound")
    }
    suppressions <- parse_suppressions(root, policy)
    remaining <- apply_suppressions(diagnostics, suppressions)
    if (length(remaining) > 0L) {
      rendered <- vapply(
        remaining,
        function(item) sprintf("%s:%d [%s/%s] %s", item$path, item$line, item$rule, item$symbol, item$detail),
        character(1L)
      )
      fail(sprintf("unsuppressed diagnostics:\n%s", paste(rendered, collapse = "\n")))
    }
    invisible(list(
      protocol = protocol,
      paths = policy$paths,
      diagnostic_count = length(diagnostics),
      suppression_count = length(suppressions)
    ))
  }

  list(
    run = run,
    test = list(
      read_policy = read_policy,
      validate_inventory = validate_inventory,
      ast_budget = ast_budget,
      analyze_text = analyze_text,
      parse_suppressions = parse_suppressions,
      apply_suppressions = apply_suppressions,
      read_bounded_utf8 = read_bounded_utf8
    )
  )
})
