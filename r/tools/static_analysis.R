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
      diagnostic_bytes = min(8388608, max(65536, as.double(limits$source_bytes) * 4))
    )
    maximum <- vapply(names(defaults), function(name) optional_limit(limits, name, defaults[[name]]), integer(1L))
    used <- structure(numeric(length(maximum)), names = names(maximum))
    charge <- function(name, amount = 1L) {
      if (!(name %in% names(maximum)) || length(amount) != 1L || is.na(amount) ||
          !is.finite(amount) || amount < 0 || amount != floor(amount)) {
        fail("an analyzer work charge is invalid")
      }
      if (amount > maximum[[name]] - used[[name]]) {
        fail(sprintf("analysis %s work exceeds its bound", gsub("_", " ", name, fixed = TRUE)))
      }
      used[[name]] <<- used[[name]] + amount
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
      suppressions = scalar_integer(field("Maximum-Suppressions"), "Maximum-Suppressions", 1L)
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
                                environment = NULL, lexical_owner = NULL) {
    charge_work("candidate_states")
    list(
      kind = kind,
      formals = formals,
      namespace = namespace,
      symbol = symbol,
      terminal = terminal,
      definition = definition,
      definition_id = definition_id,
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
      if (is.null(candidate$definition_id)) "" else candidate$definition_id,
      if (is.null(candidate$environment)) "" else candidate$environment,
      if (is.null(candidate$lexical_owner)) "" else candidate$lexical_owner,
      sep = "\035"
    )
  }

  unique_candidates <- function(candidates) {
    if (length(candidates) == 0L) return(candidates)
    charge_work("operations", length(candidates))
    keys <- vapply(candidates, candidate_key, character(1L))
    candidates[!duplicated(keys)]
  }

  function_candidate <- function(formals, namespace = NULL, symbol = NULL, terminal = FALSE,
                                 definition = NULL, definition_id = NULL, lexical_owner = NULL) {
    binding_candidate(
      "function",
      formals = formals,
      namespace = namespace,
      symbol = symbol,
      terminal = terminal,
      definition = definition,
      definition_id = definition_id,
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
    rows <- structure(seq_len(nrow(data)), names = as.character(data$id))
    parents <- structure(data$parent, names = as.character(data$id))
    operation_span <- function(id, fallback_line, fallback_column = 1L) {
      row <- rows[[as.character(id)]]
      if (is.null(row) || is.na(row)) {
        return(sprintf("L%d:C%d-L%d:C%d", fallback_line, fallback_column, fallback_line, fallback_column))
      }
      sprintf(
        "L%d:C%d-L%d:C%d",
        as.integer(data$line1[[row]]), as.integer(data$col1[[row]]),
        as.integer(data$line2[[row]]), as.integer(data$col2[[row]])
      )
    }
    call_expression_ids <- unique(data$parent[data$text == "(" & data$token == "'('"])
    call_expression_index <- new.env(hash = TRUE, parent = emptyenv())
    for (id in call_expression_ids) assign(as.character(id), TRUE, envir = call_expression_index)
    enclosing_call_cache <- new.env(hash = TRUE, parent = emptyenv())
    enclosing_call <- function(id) {
      current <- as.integer(id)
      visited <- character()
      result <- NA_integer_
      while (is.finite(current) && current > 0L) {
        key <- as.character(current)
        if (exists(key, envir = enclosing_call_cache, inherits = FALSE)) {
          result <- get(key, envir = enclosing_call_cache, inherits = FALSE)
          break
        }
        visited <- c(visited, key)
        if (exists(key, envir = call_expression_index, inherits = FALSE)) {
          result <- current
          break
        }
        parent <- parents[[key]]
        if (is.null(parent) || is.na(parent) || parent == current) break
        current <- as.integer(parent)
      }
      for (key in visited) assign(key, result, envir = enclosing_call_cache)
      result
    }
    argument_tokens <- data[data$token == "SYMBOL_SUB", , drop = FALSE]
    argument_rows_by_call <- list()
    if (nrow(argument_tokens) > 0L) {
      argument_owners <- vapply(argument_tokens$parent, enclosing_call, integer(1L))
      owned <- which(!is.na(argument_owners))
      if (length(owned) > 0L) argument_rows_by_call <- split(owned, as.character(argument_owners[owned]))
    }
    call_tokens <- data[data$token == "SYMBOL_FUNCTION_CALL", , drop = FALSE]
    if (nrow(call_tokens) > 0L) {
      head_text <- vapply(call_tokens$parent, function(parent) {
        row <- rows[[as.character(parent)]]
        if (is.null(row) || is.na(row)) "" else data$text[[row]]
      }, character(1L))
      direct <- !grepl("$", head_text, fixed = TRUE) & !grepl("@", head_text, fixed = TRUE) &
        !grepl("[[", head_text, fixed = TRUE)
      call_tokens <- call_tokens[direct, , drop = FALSE]
    }
    call_records <- lapply(seq_len(nrow(call_tokens)), function(index) {
      token <- call_tokens[index, , drop = FALSE]
      call_id <- enclosing_call(token$parent)
      argument_rows <- argument_rows_by_call[[as.character(call_id)]]
      arguments <- if (is.null(argument_rows)) argument_tokens[0L, , drop = FALSE] else
        argument_tokens[argument_rows, , drop = FALSE]
      if (nrow(arguments) > 0L) arguments <- arguments[order(arguments$line1, arguments$col1), , drop = FALSE]
      list(
        symbol = token$text,
        line = as.integer(token$line1),
        column = as.integer(token$col1),
        operation = operation_span(call_id, as.integer(token$line1), as.integer(token$col1)),
        argument_lines = as.integer(arguments$line1)
      )
    })
    call_records <- Filter(Negate(is.null), call_records)
    assignments <- data[data$token %in% c("LEFT_ASSIGN", "EQ_ASSIGN"), , drop = FALSE]
    assignments <- assignments[assignments$text %in% c("<-", "="), , drop = FALSE]
    assignment_records <- lapply(seq_len(nrow(assignments)), function(index) {
      token <- assignments[index, , drop = FALSE]
      list(
        line = as.integer(token$line1),
        column = as.integer(token$col1),
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
    annotate <- function(expressions) {
      call_index <- 1L
      assignment_index <- 1L
      node_serial <- 0L
      visit <- function(node) {
        if (!(is.call(node) || is.pairlist(node))) return(node)
        if (is.call(node)) {
          node_serial <<- node_serial + 1L
          attr(node, "openwrangler_node_id") <- node_serial
          head <- node[[1L]]
          head_symbol <- if (is.symbol(head)) as.character(head) else NULL
          assignment <- !is.null(head_symbol) && head_symbol %in% c("<-", "=") && length(node) == 3L
          special <- !is.null(head_symbol) && head_symbol %in% c(
            "function", "{", "if", "for", "while", "repeat", "break", "next"
          )
          identity <- call_identity(head)
          if (assignment && assignment_index <= length(assignment_records)) {
            attr(node, "openwrangler_assignment_receipt") <- assignment_records[[assignment_index]]
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
      if (call_index != length(call_records) + 1L || assignment_index != length(assignment_records) + 1L) {
        fail(sprintf(
          "parse-data locations could not be bound to the exact syntax tree (calls %d/%d; assignments %d/%d; next call %s)",
          call_index - 1L,
          length(call_records),
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
          argument_lines = integer()
        ) else receipt
      },
      argument = function(receipt, named_index, fallback) {
        if (named_index < 1L || named_index > length(receipt$argument_lines)) return(as.integer(fallback))
        receipt$argument_lines[[named_index]]
      },
      assignment = function(node, fallback) {
        receipt <- attr(node, "openwrangler_assignment_receipt", exact = TRUE)
        if (is.null(receipt)) list(
          line = as.integer(fallback),
          operation = sprintf("line:%d", as.integer(fallback))
        ) else receipt
      }
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

  current_environment_expression <- function(node, scopes) {
    owner <- attr(scopes[[1L]], "openwrangler_scope_owner", exact = TRUE)
    if (is.symbol(node)) {
      candidates <- lexical_candidates(as.character(node), scopes)
      return(any(vapply(candidates, function(candidate) {
        identical(candidate$kind, "environment") && identical(candidate$environment, "current") &&
          identical(candidate$lexical_owner, owner)
      }, logical(1L))))
    }
    if (!is.call(node) || length(node) != 1L) return(FALSE)
    identity <- call_identity(node[[1L]])
    candidates <- callable_candidates(identity, scopes)
    !is.null(identity) &&
      any(vapply(candidates, function(candidate) {
        identical(candidate$namespace, "base") && identical(candidate$symbol, "environment")
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

  local_binding_mutations <- function(node, scopes) {
    if (!is.call(node)) return(character())
    identity <- call_identity(node[[1L]])
    if (!is.null(identity) && identical(identity$symbol, "function") && is.null(identity$namespace)) {
      return(character())
    }
    mutations <- character()
    assignment <- assignment_parts(node)
    if (!is.null(assignment)) {
      mutations <- c(mutations, assignment$symbol)
    } else if (is.symbol(node[[1L]]) && as.character(node[[1L]]) %in% c("<-", "=", "<<-")) {
      target <- node[[2L]]
      if (is.call(target) && length(target) == 3L && is.symbol(target[[1L]]) &&
          as.character(target[[1L]]) %in% c("$", "[[") &&
          current_environment_expression(target[[2L]], scopes)) {
        member <- target[[3L]]
        if (is.symbol(member) || (is.character(member) && length(member) == 1L && !is.na(member))) {
          mutations <- c(mutations, as.character(member))
        }
      } else {
        root <- assigned_root_symbol(target)
        if (!is.null(root)) mutations <- c(mutations, root)
      }
    }
    if (!is.null(identity) && identity$symbol %in% c("assign", "rm", "remove")) {
      arguments <- as.list(node)[-1L]
      if (length(arguments) >= 1L && is.character(arguments[[1L]]) && length(arguments[[1L]]) == 1L &&
          !is.na(arguments[[1L]])) {
        mutations <- c(mutations, arguments[[1L]])
      }
    }
    children <- as.list(node)[-1L]
    for (index in seq_along(children)) {
      if (!identical(children[index][[1L]], quote(expr = ))) {
        mutations <- c(mutations, local_binding_mutations(children[[index]], scopes))
      }
    }
    mutations
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
    snapshot_mutations <- unlist(lapply(statements, local_binding_mutations, scopes = scopes), use.names = FALSE)
    has_presence_snapshot && has_value_snapshot &&
      sum(snapshot_mutations == "had_random_seed") == 1L &&
      sum(snapshot_mutations == "previous_random_seed") == 1L
  }

  assign_global_environment <- function(node, identity, candidates, ancestors, current_function, scopes) {
    if (is.null(identity) || !any(vapply(candidates, function(candidate) {
          identical(candidate$namespace, "base") && identical(candidate$symbol, "assign")
        }, logical(1L)))) {
      return(FALSE)
    }
    arguments <- as.list(node)[-1L]
    argument_names <- names(arguments)
    if (exact_random_seed_restoration(node, ancestors, current_function, scopes)) return(FALSE)
    if (is.null(argument_names)) argument_names <- rep("", length(arguments))
    formals <- c("x", "value", "pos", "envir", "inherits", "immediate")
    matched <- rep(NA_character_, length(arguments))
    claimed <- character()
    for (index in seq_along(arguments)) {
      name <- argument_names[[index]]
      if (nzchar(name) && name %in% formals) {
        matched[[index]] <- name
        claimed <- c(claimed, name)
      }
    }
    for (index in seq_along(arguments)) {
      name <- argument_names[[index]]
      if (!nzchar(name) || !is.na(matched[[index]])) next
      targets <- setdiff(formals[startsWith(formals, name)], claimed)
      if (length(targets) == 1L) {
        matched[[index]] <- targets[[1L]]
        claimed <- c(claimed, targets[[1L]])
      }
    }
    remaining <- setdiff(formals, claimed)
    for (index in seq_along(arguments)) {
      if (nzchar(argument_names[[index]])) next
      if (length(remaining) == 0L) break
      matched[[index]] <- remaining[[1L]]
      claimed <- c(claimed, remaining[[1L]])
      remaining <- remaining[-1L]
    }
    any(vapply(seq_along(arguments), function(index) {
      matched[[index]] %in% c("envir", "pos") && global_environment_expression(arguments[[index]], scopes)
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

  make_analysis_context <- function() {
    state <- new.env(hash = FALSE, parent = emptyenv())
    state$serial <- 0L
    state$definitions <- list()
    state$frames <- list(character())
    state$called <- character()
    state$active <- character()
    state$analysis_keys <- new.env(hash = TRUE, parent = emptyenv())
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
        if (exists(key, envir = state$analysis_keys, inherits = FALSE)) return(FALSE)
        charge_work("candidate_states")
        assign(key, TRUE, envir = state$analysis_keys)
        TRUE
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
    if (is.null(id) || is.null(candidate$definition)) return(invisible(NULL))
    owners <- vapply(scopes, function(scope) {
      value <- attr(scope, "openwrangler_scope_owner", exact = TRUE)
      if (length(value) != 1L || is.na(value)) fail("an analysis scope has no exact lexical owner")
      as.integer(value)
    }, integer(1L))
    owner_index <- match(candidate$lexical_owner, owners, nomatch = 0L)
    if (owner_index == 0L) fail("a function candidate escaped its exact lexical owner")
    lexical_scopes <- scopes[seq.int(owner_index, length(scopes))]
    if (invoked) context$mark_called(id)
    if (!context$claim_analysis(id, lexical_scopes)) return(invisible(NULL))
    if (!context$enter(id)) return(invisible(NULL))
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
    invisible(NULL)
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
          pending_terminal <- terminal_expression(statement, before)
          if (!is.null(pending_terminal)) {
            exits <- add_terminal_exit(scopes, exits, pending_terminal, result$scopes)
          }
        }
        pending_line <- if (is.null(result$line)) line else result$line
        if (reachable) current <- result$scopes
      }
      deferred <- context$pop_frame()
      flush_deferred_definitions(deferred, path, collector, current, locator, ancestors, context)
      return(c(list(line = line, scopes = current), exits))
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
      consequent_terminal <- terminal_expression(node[[3L]], condition$scopes)
      if (is.null(consequent_terminal)) {
        continuing <- c(continuing, list(consequent$scopes))
      } else {
        exits <- add_terminal_exit(condition$scopes, exits, consequent_terminal, consequent$scopes)
      }
      alternative_terminal <- if (length(node) == 4L) {
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
        scopes = merged
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
        if (is.null(terminal_expression(node[[4L]], loop_scopes))) {
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
      if (is.null(terminal_expression(node[[4L]], loop_scopes))) {
        output_alternatives <- c(output_alternatives, list(body$scopes))
      }
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
        if (is.null(terminal_expression(node[[3L]], condition$scopes))) {
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
        iteration_alternatives <- list(scopes)
        if (is.null(terminal_expression(node[[2L]], loop_scopes))) {
          iteration_alternatives <- c(iteration_alternatives, list(body$scopes))
        }
        if (!is.null(body$next_scopes)) iteration_alternatives <- c(iteration_alternatives, list(body$next_scopes))
        next_scopes <- merge_branch_scopes(scopes, iteration_alternatives)
        if (same_scope_bindings(next_scopes, loop_scopes)) break
        loop_scopes <- next_scopes
      }
      output_scopes <- if (is.null(break_scopes)) body$scopes else break_scopes
      return(list(
        line = if (is.null(body$line)) line else body$line,
        scopes = output_scopes,
        terminal_scopes = terminal_scopes
      ))
    }

    if (is.symbol(head) && as.character(head) %in% c("<-", "=") && length(node) == 3L) {
      assignment_receipt <- locator$assignment(node, line)
      line <- assignment_receipt$line
      member <- global_member_symbol(node[[2L]], scopes)
      if (!is.null(member)) {
        collector$add(
          path, line, "global-assignment", member, "direct assignment mutates .GlobalEnv",
          assignment_receipt$operation
        )
      }
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
      if (!is.null(assignment)) result$scopes <- set_local_binding(result$scopes, assignment$symbol, binding)
      result$line <- line
      return(result)
    }

    identity <- call_identity(head)
    if (is.null(identity)) {
      current <- scopes
      for (index in seq_along(node)) {
        if (!identical(node[[index]], quote(expr = ))) {
          current <- inspect_calls(
            node[[index]], path, collector, current, locator,
            c(ancestors, list(node)), current_function, context
          )$scopes
        }
      }
      return(list(line = line, scopes = current))
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
    argument_names <- names(arguments)
    if (length(arguments) > 0L && !is.null(argument_names)) {
      named_index <- 0L
      for (index in seq_along(arguments)) {
        candidate <- argument_names[[index]]
        if (!nzchar(candidate)) next
        named_index <- named_index + 1L
        targets <- partial_targets(candidate, candidates)
        if (length(targets) > 0L) {
          collector$add(
            path,
            locator$argument(receipt, named_index, line),
            "partial-argument",
            paste(symbol, candidate, sep = ":"),
            sprintf("argument %s partially matches %s", candidate, paste(targets, collapse = " or "))
          )
        }
      }
    }

    current <- scopes
    for (index in seq_along(arguments)) {
      if (!identical(arguments[[index]], quote(expr = ))) {
        current <- inspect_calls(
          arguments[[index]], path, collector, current, locator, c(ancestors, list(node)), current_function, context
        )$scopes
      }
    }
    for (candidate in candidates) {
      if (identical(candidate$kind, "function") && !is.null(candidate$definition)) {
        analyze_function_candidate(
          candidate, path, collector, current, locator, c(ancestors, list(node)), context
        )
      }
    }
    list(line = line, scopes = current)
  }

  inspect_codetools <- function(text, path, collector, maximum_diagnostics) {
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
          collector$add(path, line, pattern$rule, captured[[2L]], body)
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
    inspect_codetools(text, path, collector, limits$diagnostics)
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
