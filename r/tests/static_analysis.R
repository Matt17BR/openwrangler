local({
  analysis_environment <- new.env(parent = baseenv())
  sys.source("r/tools/static_analysis.R", envir = analysis_environment, keep.source = FALSE)
  analyzer <- analysis_environment$openwrangler_r_static_analysis

  assert_true <- function(value, message) {
    if (!isTRUE(value)) stop(message, call. = FALSE)
  }
  expect_error <- function(expression, pattern) {
    condition <- tryCatch({
      force(expression)
      NULL
    }, error = function(error) error)
    assert_true(inherits(condition, "error"), sprintf("Expected failure matching %s", pattern))
    assert_true(
      grepl(pattern, conditionMessage(condition), fixed = TRUE),
      sprintf("Expected failure containing %s, received: %s", pattern, conditionMessage(condition))
    )
  }
  fixture_limits <- list(
    source_bytes = 4096L,
    aggregate_source_bytes = 8192L,
    ast_nodes = 128L,
    ast_depth = 16L,
    diagnostics = 16L,
    suppressions = 16L
  )
  diagnostics <- function(source) {
    analyzer$test$analyze_text(source, "r/openwrangler_runtime/frame_contract.R", fixture_limits)
  }
  rules <- function(source) vapply(diagnostics(source), `[[`, character(1L), "rule")
  diagnostic_symbols <- function(source, rule) {
    selected <- Filter(function(item) identical(item$rule, rule), diagnostics(source))
    vapply(selected, `[[`, character(1L), "symbol")
  }
  diagnostic_lines <- function(source, rule, symbol) {
    selected <- Filter(
      function(item) identical(item$rule, rule) && identical(item$symbol, symbol),
      diagnostics(source)
    )
    vapply(selected, `[[`, integer(1L), "line")
  }

  result <- analyzer$run(".")
  assert_true(identical(result$protocol, "openwrangler-native-r-static-analysis-v1"), "Analyzer protocol changed")
  assert_true(identical(result$diagnostic_count, 10L), "Production diagnostic count changed")
  assert_true(identical(result$suppression_count, 10L), "Production suppression count changed")

  assert_true("undefined-symbol" %in% rules("function() missing_symbol"), "Undefined symbols were not detected")
  assert_true(
    "partial-argument" %in% rules("local_call <- function(alpha, beta) alpha + beta\nlocal_call(al = 1, beta = 2)"),
    "Partial argument matching was not detected"
  )
  assert_true(
    "runif:ma" %in% diagnostic_symbols("stats::runif(n = 1, ma = 2)", "partial-argument"),
    "Namespaced partial argument matching was not detected"
  )
  assert_true(
    !("partial-argument" %in% rules("stats::runif(n = 1, max = 2)")),
    "An exact namespaced argument was reported as partial"
  )
  assert_true("global-assignment" %in% rules("function() unsafe_target <<- 1"), "Unsafe global assignment was not detected")
  assert_true(
    "assign:.GlobalEnv" %in% diagnostic_symbols("base::assign('unsafe_target', 1, envir = .GlobalEnv)", "global-assignment"),
    "Explicit base::assign mutation of .GlobalEnv was not detected"
  )
  assert_true(
    "assign:.GlobalEnv" %in% diagnostic_symbols("assign('unsafe_target', 1, envir = .GlobalEnv)", "global-assignment"),
    "Unqualified base assign mutation of .GlobalEnv was not detected"
  )
  assert_true(
    !("global-assignment" %in% rules(
      "function() { assign <- function(...) NULL; assign('unsafe_target', 1, envir = .GlobalEnv) }"
    )),
    "A locally shadowed assign call was treated as the base global mutator"
  )
  assert_true(
    "assign:.GlobalEnv" %in% diagnostic_symbols(
      "function(value = assign('unsafe_target', 1, envir = .GlobalEnv)) value",
      "global-assignment"
    ),
    "A global assignment in a default expression was not detected"
  )
  assert_true(
    ".GlobalEnv$unsafe_target" %in% diagnostic_symbols(".GlobalEnv$unsafe_target <- 1", "global-assignment"),
    "Direct .GlobalEnv member assignment was not detected"
  )
  assert_true(
    ".GlobalEnv$unsafe_target" %in% diagnostic_symbols(".GlobalEnv[['unsafe_target']] <- 1", "global-assignment"),
    "Direct indexed .GlobalEnv member assignment was not detected"
  )
  assert_true(
    !("global-assignment" %in% rules(paste(
      "function() {",
      "  had_random_seed <- base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
      "  if (had_random_seed) previous_random_seed <- base::get('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
      "  on.exit({",
      "    if (had_random_seed) {",
      "      base::assign('.Random.seed', previous_random_seed, envir = .GlobalEnv)",
      "    } else if (base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)) {",
      "      base::rm('.Random.seed', envir = .GlobalEnv)",
      "    }",
      "  }, add = TRUE)",
      "}",
      sep = "\n"
    ))),
    "The exact bounded random-seed restoration was reported as an unsafe global mutation"
  )
  assert_true(
    "global-assignment" %in% rules(
      "function() { on.exit({ if (had_random_seed) base::assign('.Random.seed', previous_random_seed, envir = .GlobalEnv) }, add = TRUE) }"
    ),
    "A spoofed random-seed restoration bypassed global assignment analysis"
  )
  assert_true(
    "global-assignment" %in% rules("on.exit({ if (had_random_seed) base::assign('.Random.seed', replacement_seed, envir = .GlobalEnv) }, add = TRUE)"),
    "An arbitrary random-seed mutation bypassed global assignment analysis"
  )
  assert_true(
    "global-assignment" %in% rules(paste(
      "function() {",
      "  had_random_seed <- base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
      "  if (had_random_seed) previous_random_seed <- base::get('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
      "  had_random_seed <- TRUE",
      "  on.exit({",
      "    if (had_random_seed) base::assign('.Random.seed', previous_random_seed, envir = .GlobalEnv)",
      "    else if (base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)) base::rm('.Random.seed', envir = .GlobalEnv)",
      "  }, add = TRUE)",
      "}",
      sep = "\n"
    )),
    "A rebound random-seed snapshot variable spoofed the exact restoration exemption"
  )
  assert_true(
    !("global-assignment" %in% rules("function() { local_environment <- new.env(); local_environment$target <- 1; base::assign('target', 1, envir = local_environment) }")),
    "Local environment assignment was reported as global"
  )
  assert_true("unqualified-call" %in% rules("function() unowned_package_call()"), "Unqualified calls were not detected")
  assert_true("namespace-attachment" %in% rules("library(stats)"), "Namespace attachment was not detected")
  assert_true("namespace-attachment" %in% rules("base::library(stats)"), "Qualified namespace attachment was not detected")
  assert_true("unreachable-expression" %in% rules("function() { return(1); 2 }"), "Unreachable expressions were not detected")
  assert_true("unreachable-expression" %in% rules("function() { while (TRUE) { break; 2 } }"), "Unreachable loop expressions were not detected")
  assert_true(
    "unreachable-expression" %in% rules("function(flag) { if (flag) { return(1) } else { stop('failed') }; 2 }"),
    "Expressions after an all-branch terminal conditional were not detected"
  )
  assert_true(
    !("unreachable-expression" %in% rules("function(flag) { if (flag) return(1); 2 }")),
    "A conditional without a terminal alternative was reported as unconditional"
  )
  assert_true(
    "unreachable-expression" %in% rules("function() { base::stop('failed'); 2 }"),
    "A qualified base terminal call did not make the following expression unreachable"
  )
  assert_true(
    "unreachable-expression" %in% rules("function() { base::quit(save = 'no'); 2 }"),
    "A qualified base quit call did not make the following expression unreachable"
  )
  assert_true(
    !("unreachable-expression" %in% rules("function() { stop <- function(...) NULL; stop('not terminal'); 2 }")),
    "A locally shadowed stop call was treated as terminal"
  )
  assert_true(
    !("unreachable-expression" %in% rules("function(stop) { stop('not terminal'); 2 }")),
    "A parameter-masked stop call was treated as terminal"
  )
  assert_true(
    !("unreachable-expression" %in% rules("function() { quit <- function(...) NULL; quit('not terminal'); 2 }")),
    "A locally shadowed quit call was treated as terminal"
  )
  assert_true(
    "unreachable-expression" %in% rules("function() { quit <- function(...) NULL; base::quit(save = 'no'); 2 }"),
    "A qualified base quit call was masked by an unrelated local binding"
  )
  assert_true(
    !("partial-argument" %in% rules("data.frame(row.n = 1)")),
    "A data.frame argument after dots was treated as partially matchable"
  )
  assert_true(
    !("partial-argument" %in% rules("stats::optim(par = 1, fn = function(value) value, meth = 'BFGS')")),
    "An optim argument after dots was treated as partially matchable"
  )

  lexical_false_negative <- paste(
    "function() {",
    "  target <- function(alpha, beta) alpha + beta",
    "  inner <- function() {",
    "    target <- function(gamma, delta) gamma + delta",
    "    target(gamma = 1, delta = 2)",
    "  }",
    "  target(al = 1, beta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:al" %in% diagnostic_symbols(lexical_false_negative, "partial-argument"),
    "The outer lexical function binding was not resolved"
  )
  lexical_false_positive <- paste(
    "function() {",
    "  target <- function(alpha, beta) alpha + beta",
    "  inner <- function() {",
    "    target <- function(apple, pear) apple + pear",
    "    target(apple = 1, pear = 2)",
    "  }",
    "  target(ap = 1, beta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    !("target:ap" %in% diagnostic_symbols(lexical_false_positive, "partial-argument")),
    "A nested same-name function leaked into its outer lexical scope"
  )

  ordered_redefinition <- paste(
    "function() {",
    "  target <- function(alpha, beta) alpha + beta",
    "  target(al = 1, beta = 2)",
    "  target <- function(apple, pear) apple + pear",
    "  target(apple = 1, pear = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:al" %in% diagnostic_symbols(ordered_redefinition, "partial-argument"),
    "A call before a same-scope redefinition did not use the earlier callable"
  )
  post_redefinition <- paste(
    "function() {",
    "  target <- function(alpha, beta) alpha + beta",
    "  target <- function(gamma, delta) gamma + delta",
    "  target(al = 1, delta = 2)",
    "  target(ga = 1, delta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    !("target:al" %in% diagnostic_symbols(post_redefinition, "partial-argument")) &&
      "target:ga" %in% diagnostic_symbols(post_redefinition, "partial-argument"),
    "A call after same-scope redefinition did not use only the replacement callable"
  )
  conditional_binding <- paste(
    "function(flag) {",
    "  if (flag) target <- function(alpha, beta) alpha + beta",
    "  else target <- function(apple, pear) apple + pear",
    "  target(al = 1, beta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:al" %in% diagnostic_symbols(conditional_binding, "partial-argument"),
    "A reachable conditional callable did not supply partial-match formals"
  )
  conditional_mask <- paste(
    "function(flag) {",
    "  if (flag) target <- function(alpha, beta) alpha + beta",
    "  else target <- 1",
    "  target(al = 1, beta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:al" %in% diagnostic_symbols(conditional_mask, "partial-argument"),
    "A branch-reachable callable was lost when another branch installed a non-function mask"
  )
  non_function_mask <- paste(
    "function() {",
    "  target <- function(alpha, beta) alpha + beta",
    "  inner <- function() {",
    "    target <- 1",
    "    target(al = 1, beta = 2)",
    "  }",
    "}",
    sep = "\n"
  )
  assert_true(
    !("target:al" %in% diagnostic_symbols(non_function_mask, "partial-argument")),
    "A non-function lexical mask leaked to an outer callable"
  )
  parameter_mask <- paste(
    "function() {",
    "  target <- function(alpha, beta) alpha + beta",
    "  inner <- function(target) target(al = 1, beta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    !("target:al" %in% diagnostic_symbols(parameter_mask, "partial-argument")),
    "A function parameter mask leaked to an outer callable"
  )

  shifted_location <- paste(
    "unknown(al = 1)",
    "target <- function(alpha, beta) alpha + beta",
    "target(al = 1, beta = 2)",
    sep = "\n"
  )
  assert_true(
    identical(diagnostic_lines(shifted_location, "partial-argument", "target:al"), 3L),
    "An unresolved earlier call shifted a later argument diagnostic"
  )

  expect_error(
    analyzer$test$ast_budget(quote(a(b(c()))), 128L, 2L),
    "AST nesting depth exceeds"
  )
  expect_error(
    analyzer$test$ast_budget(quote(a + b + c), 2L, 16L),
    "AST node count exceeds"
  )
  too_many_diagnostics <- paste(sprintf("function() missing_%d", seq_len(17L)), collapse = "\n")
  expect_error(analyzer$test$analyze_text(too_many_diagnostics, "fixture.R", fixture_limits), "diagnostic count exceeds")

  runner <- paste(readLines("r/tests/run_warning_strict.R", warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  hook <- regexpr("openwrangler_r_static_analysis\\$run", runner)
  warning_latch <- regexpr("warning_state <-", runner, fixed = TRUE)
  source_target <- regexpr("source(target", runner, fixed = TRUE)
  assert_true(hook[[1L]] > 0L && hook[[1L]] < warning_latch[[1L]] && warning_latch[[1L]] < source_target[[1L]], "Analyzer hook order changed")
  catalog <- paste(readLines("r/tests/complete_catalog_contract.R", warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  assert_true(grepl("generated", catalog, fixed = TRUE) && grepl("parse", catalog, fixed = TRUE), "Complete catalog generated-R coverage changed")

  temporary_root <- tempfile("ow-r-static-analysis-")
  dir.create(file.path(temporary_root, "r/openwrangler_runtime"), recursive = TRUE, mode = "0700")
  on.exit(unlink(temporary_root, recursive = TRUE, force = TRUE), add = TRUE)
  for (path in c(
    "frame_contract.R",
    "interactive_agent.R",
    "kernel_agent.R",
    "process_agent.R"
  )) file.create(file.path(temporary_root, "r/openwrangler_runtime", path))
  analyzer$test$validate_inventory(temporary_root)
  file.create(file.path(temporary_root, "r/openwrangler_runtime/unowned.R"))
  expect_error(analyzer$test$validate_inventory(temporary_root), "production inventory differs")
  unlink(file.path(temporary_root, "r/openwrangler_runtime/unowned.R"))
  unlink(file.path(temporary_root, "r/openwrangler_runtime/process_agent.R"))
  expect_error(analyzer$test$validate_inventory(temporary_root), "production inventory differs")

  policy <- analyzer$test$read_policy(".")
  policy_root <- tempfile("ow-r-static-policy-")
  dir.create(file.path(policy_root, "r"), recursive = TRUE, mode = "0700")
  on.exit(unlink(policy_root, recursive = TRUE, force = TRUE), add = TRUE)
  policy_text <- readLines("r/static-analysis-policy.dcf", warn = FALSE, encoding = "UTF-8")
  writeLines(
    sub("openwrangler-native-r-static-analysis-v1", "openwrangler-native-r-static-analysis-v2", policy_text, fixed = TRUE),
    file.path(policy_root, "r/static-analysis-policy.dcf"),
    useBytes = TRUE
  )
  expect_error(analyzer$test$read_policy(policy_root), "policy protocol does not match")
  writeLines(
    sub("Codetools-Version: 0.2-20", "Codetools-Version: 0.2-21", policy_text, fixed = TRUE),
    file.path(policy_root, "r/static-analysis-policy.dcf"),
    useBytes = TRUE
  )
  expect_error(analyzer$test$read_policy(policy_root), "policy codetools version does not match")

  suppression_root <- tempfile("ow-r-static-suppressions-")
  dir.create(file.path(suppression_root, "r"), recursive = TRUE, mode = "0700")
  on.exit(unlink(suppression_root, recursive = TRUE, force = TRUE), add = TRUE)
  suppression_path <- file.path(suppression_root, "r/static-analysis-suppressions.tsv")
  header <- "path\tline\trule\tsymbol\tjustification"
  valid <- "r/openwrangler_runtime/frame_contract.R\t1\tundefined-symbol\tmissing\tExact fixture justification."
  writeLines(c(header, valid, valid), suppression_path, useBytes = TRUE)
  expect_error(analyzer$test$parse_suppressions(suppression_root, policy), "duplicates an earlier entry")
  writeLines(c(header, sub("missing", "*", valid, fixed = TRUE)), suppression_path, useBytes = TRUE)
  expect_error(analyzer$test$parse_suppressions(suppression_root, policy), "contains a wildcard")
  writeLines(c(header, valid), suppression_path, useBytes = TRUE)
  parsed <- analyzer$test$parse_suppressions(suppression_root, policy)
  expect_error(analyzer$test$apply_suppressions(list(), parsed), "stale or unused suppression")
  second <- "r/openwrangler_runtime/frame_contract.R\t2\tundefined-symbol\tmissing_two\tExact fixture justification."
  one_suppression_policy <- policy
  one_suppression_policy$limits$suppressions <- 1L
  writeLines(c(header, valid, second), suppression_path, useBytes = TRUE)
  expect_error(analyzer$test$parse_suppressions(suppression_root, one_suppression_policy), "suppression count exceeds")
  overflow <- c(header, vapply(seq_len(5L), function(index) {
    sprintf("r/openwrangler_runtime/frame_contract.R\t%d\tundefined-symbol\tmissing_%d\tExact fixture justification.", index, index)
  }, character(1L)))
  writeLines(overflow, suppression_path, useBytes = TRUE)
  expect_error(analyzer$test$parse_suppressions(suppression_root, policy), "suppression ratchet exceeded")

  oversized_path <- file.path(suppression_root, "oversized.txt")
  writeChar("12345", oversized_path, eos = NULL, useBytes = TRUE)
  expect_error(analyzer$test$read_bounded_utf8(oversized_path, 4L, "fixture"), "exceeds 4 bytes")

  cat("Native R static analysis checks passed\n")
})
