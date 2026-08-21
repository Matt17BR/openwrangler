openwrangler_r_static_analysis <- local({
  protocol <- "openwrangler-native-r-static-analysis-v1"
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
    add <- function(path, line, rule, symbol, detail) {
      if (!(rule %in% rule_names) || length(path) != 1L || length(symbol) != 1L ||
          !is.finite(line) || line < 1L || !nzchar(symbol)) {
        fail("an analyzer emitted an invalid diagnostic")
      }
      key <- paste(path, as.integer(line), rule, symbol, sep = "\t")
      if (key %in% keys) return(invisible(NULL))
      if (length(values) >= maximum) fail("diagnostic count exceeds its policy bound")
      keys <<- c(keys, key)
      values[[length(values) + 1L]] <<- list(
        path = path,
        line = as.integer(line),
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

  function_definitions <- function(node) {
    definitions <- list()
    visit <- function(current) {
      if (is.call(current) && length(current) == 3L &&
          (identical(current[[1L]], as.name("<-")) || identical(current[[1L]], as.name("="))) &&
          is.symbol(current[[2L]]) && is.call(current[[3L]]) && identical(current[[3L]][[1L]], as.name("function"))) {
        definitions[[as.character(current[[2L]])]] <<- names(current[[3L]][[2L]])
        return(invisible(NULL))
      }
      if (is.call(current) && identical(current[[1L]], as.name("function"))) {
        return(invisible(NULL))
      }
      if (is.call(current) || is.expression(current) || is.pairlist(current)) {
        for (index in seq_along(current)) {
          if (!identical(current[[index]], quote(expr = ))) visit(current[[index]])
        }
      }
      invisible(NULL)
    }
    visit(node)
    definitions
  }

  callable_formals <- function(symbol, scopes, namespace = NULL, internal = FALSE) {
    if (!is.null(namespace)) {
      callable <- tryCatch(
        if (internal) getFromNamespace(symbol, namespace) else getExportedValue(namespace, symbol),
        error = function(condition) NULL
      )
      if (is.function(callable)) return(names(formals(callable)))
      return(NULL)
    }
    for (scope in scopes) {
      if (symbol %in% names(scope)) return(scope[[symbol]])
    }
    if (exists(symbol, envir = baseenv(), mode = "function", inherits = FALSE)) {
      return(names(formals(get(symbol, envir = baseenv(), mode = "function", inherits = FALSE))))
    }
    NULL
  }

  source_locator <- function(source_file) {
    data <- utils::getParseData(source_file, includeText = TRUE)
    selected <- data[data$token %in% c("LEFT_ASSIGN", "EQ_ASSIGN", "SYMBOL_FUNCTION_CALL", "SYMBOL_SUB"), , drop = FALSE]
    keys <- paste(selected$token, selected$text, sep = "\034")
    positions <- split(selected$line1, keys)
    counts <- new.env(hash = TRUE, parent = emptyenv())
    take <- function(token, text, fallback) {
      key <- paste(token, text, sep = "\034")
      values <- positions[[key]]
      if (is.null(values)) return(as.integer(fallback))
      index <- if (exists(key, envir = counts, inherits = FALSE)) get(key, envir = counts) + 1L else 1L
      assign(key, index, envir = counts)
      if (index > length(values)) return(as.integer(fallback))
      as.integer(values[[index]])
    }
    list(
      call = function(symbol, fallback) take("SYMBOL_FUNCTION_CALL", symbol, fallback),
      argument = function(symbol, fallback) take("SYMBOL_SUB", symbol, fallback),
      assignment = function(operator, fallback) {
        token <- if (identical(operator, "<-")) "LEFT_ASSIGN" else "EQ_ASSIGN"
        take(token, operator, fallback)
      }
    )
  }

  direct_terminal_symbol <- function(statement) {
    if (is.symbol(statement) && as.character(statement) %in% c("break", "next")) {
      return(as.character(statement))
    }
    if (is.call(statement) && is.symbol(statement[[1L]]) &&
        as.character(statement[[1L]]) %in% c("return", "stop", "quit", "break", "next")) {
      return(as.character(statement[[1L]]))
    }
    NULL
  }

  terminal_expression <- function(statement) {
    direct <- direct_terminal_symbol(statement)
    if (!is.null(direct)) return(direct)
    if (!is.call(statement) || !is.symbol(statement[[1L]])) return(NULL)
    head <- as.character(statement[[1L]])
    if (identical(head, "{")) {
      for (child in as.list(statement)[-1L]) {
        terminal <- terminal_expression(child)
        if (!is.null(terminal)) return(terminal)
      }
      return(NULL)
    }
    if (identical(head, "if") && length(statement) == 4L) {
      consequent <- terminal_expression(statement[[3L]])
      alternative <- terminal_expression(statement[[4L]])
      if (!is.null(consequent) && !is.null(alternative)) return("if")
    }
    NULL
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

  global_environment_expression <- function(node) {
    if (is.symbol(node) && identical(as.character(node), ".GlobalEnv")) return(TRUE)
    if (!is.call(node)) return(FALSE)
    identity <- call_identity(node[[1L]])
    !is.null(identity) && identical(identity$symbol, "globalenv") &&
      (is.null(identity$namespace) || identical(identity$namespace, "base")) && length(node) == 1L
  }

  global_member_symbol <- function(node) {
    if (!is.call(node) || length(node) != 3L || !is.symbol(node[[1L]]) ||
        !(as.character(node[[1L]]) %in% c("$", "[[")) || !global_environment_expression(node[[2L]])) {
      return(NULL)
    }
    member <- node[[3L]]
    if (is.symbol(member) || (is.character(member) && length(member) == 1L && !is.na(member))) {
      return(paste0(".GlobalEnv$", as.character(member)))
    }
    ".GlobalEnv$<dynamic>"
  }

  assign_global_environment <- function(node, identity, ancestors) {
    if (is.null(identity) || !identical(identity$symbol, "assign") ||
        !identical(identity$namespace, "base")) {
      return(FALSE)
    }
    arguments <- as.list(node)[-1L]
    argument_names <- names(arguments)
    restores_random_seed <- length(arguments) >= 2L &&
      is.character(arguments[[1L]]) && identical(arguments[[1L]], ".Random.seed") &&
      is.symbol(arguments[[2L]]) && identical(as.character(arguments[[2L]]), "previous_random_seed") &&
      all(c("if", "on.exit") %in% ancestors) &&
      !is.null(argument_names) && any(argument_names == "envir" & vapply(
        arguments,
        global_environment_expression,
        logical(1L)
      ))
    if (restores_random_seed) return(FALSE)
    if (!is.null(argument_names)) {
      for (index in seq_along(arguments)) {
        if (argument_names[[index]] %in% c("envir", "pos") &&
            global_environment_expression(arguments[[index]])) return(TRUE)
      }
    }
    (length(arguments) >= 3L && global_environment_expression(arguments[[3L]])) ||
      (length(arguments) >= 4L && global_environment_expression(arguments[[4L]]))
  }

  inspect_calls <- function(node, path, collector, scopes, locator, ancestors = character()) {
    if (!is.call(node)) return(invisible(NULL))
    head <- node[[1L]]
    line <- source_line(node)
    if (is.symbol(head) && identical(as.character(head), "function")) {
      child_scopes <- c(list(function_definitions(node[[3L]])), scopes)
      for (index in seq_along(node)[-1L]) {
        if (!identical(node[[index]], quote(expr = ))) {
          inspect_calls(node[[index]], path, collector, child_scopes, locator, c(ancestors, "function"))
        }
      }
      return(invisible(line))
    }
    identity <- call_identity(head)
    if (is.symbol(head) && as.character(head) %in% c("<-", "=") && length(node) == 3L) {
      line <- locator$assignment(as.character(head), line)
      member <- global_member_symbol(node[[2L]])
      if (!is.null(member)) {
        collector$add(path, line, "global-assignment", member, "direct assignment mutates .GlobalEnv")
      }
    }
    if (!is.null(identity)) line <- locator$call(identity$symbol, line)
    if (assign_global_environment(node, identity, ancestors)) {
      collector$add(path, line, "global-assignment", "assign:.GlobalEnv", "base::assign mutates .GlobalEnv")
    }
    if (!is.null(identity)) {
      symbol <- identity$symbol
      if (symbol %in% c("library", "require", "attach", "attachNamespace")) {
        collector$add(path, line, "namespace-attachment", symbol, "namespace attachment is forbidden")
      }
      formals <- callable_formals(symbol, scopes, identity$namespace, identity$internal)
      arguments <- as.list(node)[-1L]
      argument_names <- names(arguments)
      if (!is.null(formals) && length(arguments) > 0L && !is.null(argument_names)) {
        for (index in seq_along(arguments)) {
          candidate <- argument_names[[index]]
          if (!nzchar(candidate)) next
          argument_line <- locator$argument(candidate, line)
          if (candidate %in% formals) next
          matches <- formals[startsWith(formals, candidate)]
          if (length(matches) == 1L) {
            collector$add(
              path,
              argument_line,
              "partial-argument",
              paste(symbol, candidate, sep = ":"),
              sprintf("argument %s partially matches %s", candidate, matches[[1L]])
            )
          }
        }
      }
      if (is.symbol(head) && identical(symbol, "{") && length(node) > 2L) {
        statements <- as.list(node)[-1L]
        pending_terminal <- NULL
        pending_line <- NULL
        for (statement in statements) {
          if (!is.null(pending_terminal)) {
            collector$add(
              path,
              pending_line,
              "unreachable-expression",
              pending_terminal,
              "expression follows an unconditional terminal expression"
            )
          }
          statement_line <- inspect_calls(statement, path, collector, scopes, locator, c(ancestors, symbol))
          pending_terminal <- terminal_expression(statement)
          pending_line <- if (is.null(statement_line)) line else statement_line
        }
        return(invisible(line))
      }
    }
    child_ancestors <- if (is.null(identity)) ancestors else c(ancestors, identity$symbol)
    for (index in seq_along(node)) {
      if (!identical(node[[index]], quote(expr = ))) {
        inspect_calls(node[[index]], path, collector, scopes, locator, child_ancestors)
      }
    }
    invisible(line)
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
    source_file <- srcfilecopy(path, text, isFile = FALSE)
    expressions <- tryCatch(
      parse(text = text, srcfile = source_file, keep.source = TRUE),
      error = function(condition) fail(sprintf("%s does not parse: %s", path, conditionMessage(condition)))
    )
    ast_budget(expressions, limits$ast_nodes, limits$ast_depth)
    collector <- diagnostic_collector(limits$diagnostics)
    scopes <- list(function_definitions(expressions))
    locator <- source_locator(source_file)
    for (expression in expressions) inspect_calls(expression, path, collector, scopes, locator)
    inspect_codetools(text, path, collector, limits$diagnostics)
    collector$values()
  }

  parse_suppressions <- function(root, policy) {
    path <- file.path(root, "r/static-analysis-suppressions.tsv")
    text <- read_bounded_utf8(path, 65536L, "suppression ledger")
    lines <- strsplit(text, "\n", fixed = TRUE)[[1L]]
    if (length(lines) > 0L && identical(lines[[length(lines)]], "")) lines <- lines[-length(lines)]
    if (length(lines) < 1L || !identical(lines[[1L]], "path\tline\trule\tsymbol\tjustification")) {
      fail("suppression ledger header is not exact")
    }
    entries <- lines[-1L]
    if (length(entries) > policy$limits$suppressions) fail("suppression count exceeds its policy bound")
    parsed <- vector("list", length(entries))
    keys <- character()
    counts <- structure(integer(length(rule_names)), names = rule_names)
    for (index in seq_along(entries)) {
      fields <- strsplit(entries[[index]], "\t", fixed = TRUE)[[1L]]
      if (length(fields) != 5L || any(!nzchar(fields))) fail(sprintf("suppression row %d is malformed", index + 1L))
      names(fields) <- c("path", "line", "rule", "symbol", "justification")
      if (!(fields[["path"]] %in% policy$paths) || !(fields[["rule"]] %in% rule_names)) {
        fail(sprintf("suppression row %d has an unowned path or rule", index + 1L))
      }
      has_wildcard <- function(value) any(vapply(c("*", "?", "["), grepl, logical(1L), x = value, fixed = TRUE))
      if (has_wildcard(fields[["path"]]) || has_wildcard(fields[["rule"]]) ||
          has_wildcard(fields[["symbol"]])) {
        fail(sprintf("suppression row %d contains a wildcard", index + 1L))
      }
      line <- scalar_integer(fields[["line"]], sprintf("suppression row %d line", index + 1L), 1L)
      if (nchar(fields[["symbol"]], type = "bytes") > 256L ||
          nchar(fields[["justification"]], type = "bytes") > 1024L ||
          !identical(fields[["justification"]], trimws(fields[["justification"]]))) {
        fail(sprintf("suppression row %d exceeds text bounds or has padded justification", index + 1L))
      }
      key <- paste(fields[["path"]], line, fields[["rule"]], fields[["symbol"]], sep = "\t")
      if (key %in% keys) fail(sprintf("suppression row %d duplicates an earlier entry", index + 1L))
      keys <- c(keys, key)
      counts[[fields[["rule"]]]] <- counts[[fields[["rule"]]]] + 1L
      parsed[[index]] <- list(
        path = fields[["path"]],
        line = line,
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
