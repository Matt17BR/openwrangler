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
  diagnostics_with_limits <- function(source, limits = fixture_limits) {
    analyzer$test$analyze_text(source, "r/openwrangler_runtime/frame_contract.R", limits)
  }
  diagnostics <- function(source) diagnostics_with_limits(source)
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
  diagnostic_operations <- function(source, rule, symbol) {
    selected <- Filter(
      function(item) identical(item$rule, rule) && identical(item$symbol, symbol),
      diagnostics(source)
    )
    vapply(selected, `[[`, character(1L), "operation")
  }

  result <- analyzer$run(".")
  assert_true(identical(result$protocol, "openwrangler-native-r-static-analysis-v2"), "Analyzer protocol changed")
  assert_true(identical(result$diagnostic_count, 13L), "Production diagnostic count changed")
  assert_true(identical(result$suppression_count, 13L), "Production suppression count changed")

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
      "target_name <- 'unsafe_target'; base::assign(target_name, 1, envir = .GlobalEnv)",
      "global-assignment"
    ),
    "A dynamic target name bypassed resolved global assignment analysis"
  )
  assert_true(
    "assign:.GlobalEnv" %in% diagnostic_symbols(
      "mutate <- base::assign; mutate(target_name, 1, envir = .GlobalEnv)",
      "global-assignment"
    ),
    "An alias of base::assign bypassed resolved global assignment analysis"
  )
  assert_true(
    "assign:.GlobalEnv" %in% diagnostic_symbols(
      "function() { assign <- assign('unsafe_target', 1, envir = .GlobalEnv) }",
      "global-assignment"
    ),
    "An assignment RHS was analyzed after publishing its LHS binding"
  )
  assert_true(
    "assign:.GlobalEnv" %in% diagnostic_symbols(
      "global_environment <- base::globalenv(); base::assign(target_name, 1, envir = global_environment)",
      "global-assignment"
    ),
    "An alias of the global environment bypassed resolved global assignment analysis"
  )
  assert_true(
    "assign:.GlobalEnv" %in% diagnostic_symbols(
      "global_factory <- base::globalenv; base::assign(target_name, 1, en = global_factory())",
      "global-assignment"
    ),
    "A base globalenv callable alias or partial envir argument bypassed global assignment analysis"
  )
  assert_true(
    "assign:.GlobalEnv" %in% diagnostic_symbols(
      "global_environment <- .GlobalEnv; base::assign(target_name, 1, envir = global_environment)",
      "global-assignment"
    ),
    "A direct .GlobalEnv value alias bypassed global assignment analysis"
  )
  assert_true(
    !("global-assignment" %in% rules(
      "function() { local_environment <- new.env(); base::assign(envir = local_environment, x = 'target', value = .GlobalEnv) }"
    )),
    "A reordered .GlobalEnv value argument was mistaken for an environment argument"
  )
  assert_true(
    "assign:.GlobalEnv" %in% diagnostic_symbols(paste(
      "function(flag) {",
      "  if (flag) globalenv <- function() new.env(parent = emptyenv())",
      "  base::assign('unsafe_target', 1, envir = globalenv())",
      "}",
      sep = "\n"
    ), "global-assignment"),
    "A conditionally shadowed globalenv call was treated as certainly local"
  )
  assert_true(
    !("global-assignment" %in% rules(paste(
      "function() {",
      "  globalenv <- function() new.env(parent = emptyenv())",
      "  base::assign('local_target', 1, envir = globalenv())",
      "}",
      sep = "\n"
    ))),
    "A shadowed globalenv callable was treated as the global environment"
  )
  assert_true(
    !("global-assignment" %in% rules(paste(
      "function() {",
      "  assign <- function(...) NULL",
      "  mutate <- assign",
      "  mutate('local_target', 1, envir = .GlobalEnv)",
      "}",
      sep = "\n"
    ))),
    "An alias of a shadowed assign callable was treated as the base global mutator"
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
    "global-assignment" %in% rules(paste(
      "function() {",
      "  had_random_seed <- base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
      "  if (had_random_seed) previous_random_seed <- base::get('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
      "  previous_random_seed <- replacement_seed",
      "  on.exit({",
      "    if (had_random_seed) base::assign('.Random.seed', previous_random_seed, envir = .GlobalEnv)",
      "    else if (base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)) base::rm('.Random.seed', envir = .GlobalEnv)",
      "  }, add = TRUE)",
      "}",
      sep = "\n"
    )),
    "A rebound random-seed value snapshot spoofed the exact restoration exemption"
  )
  assert_true(
    "global-assignment" %in% rules(paste(
      "function() {",
      "  had_random_seed <- base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
      "  if (had_random_seed) previous_random_seed <- base::get('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
      "  had_random_seed[1L] <- TRUE",
      "  on.exit({",
      "    if (had_random_seed) base::assign('.Random.seed', previous_random_seed, envir = .GlobalEnv)",
      "    else if (base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)) base::rm('.Random.seed', envir = .GlobalEnv)",
      "  }, add = TRUE)",
      "}",
      sep = "\n"
    )),
    "A subassignment to a random-seed snapshot spoofed the exact restoration exemption"
  )
  seed_environment_alias_mutation <- paste(
    "function() {",
    "  had_random_seed <- base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
    "  if (had_random_seed) previous_random_seed <- base::get('.Random.seed', envir = .GlobalEnv, inherits = FALSE)",
    "  current_environment <- base::environment()",
    "  current_environment_alias <- current_environment",
    "  current_environment_alias$previous_random_seed <- replacement_seed",
    "  on.exit({",
    "    if (had_random_seed) base::assign('.Random.seed', previous_random_seed, envir = .GlobalEnv)",
    "    else if (base::exists('.Random.seed', envir = .GlobalEnv, inherits = FALSE)) base::rm('.Random.seed', envir = .GlobalEnv)",
    "  }, add = TRUE)",
    "}",
    sep = "\n"
  )
  assert_true(
    "global-assignment" %in% rules(seed_environment_alias_mutation),
    "A current-environment alias mutation spoofed the exact random-seed restoration exemption"
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
    !("unreachable-expression" %in% rules("function() { return <- function(...) NULL; return('not terminal'); 2 }")),
    "A locally shadowed return call was treated as terminal"
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

  live_lexical_false_positive <- paste(
    "function() {",
    "  target <- function(alpha, beta) alpha + beta",
    "  inner <- function() target(al = 1, beta = 2)",
    "  target <- function(apple, pear) apple + pear",
    "  inner()",
    "}",
    sep = "\n"
  )
  assert_true(
    !("target:al" %in% diagnostic_symbols(live_lexical_false_positive, "partial-argument")),
    "A nested function used a callable frozen at definition instead of its live lexical binding"
  )
  live_lexical_false_negative <- paste(
    "function() {",
    "  target <- function(apple, pear) apple + pear",
    "  inner <- function() target(al = 1, beta = 2)",
    "  target <- function(alpha, beta) alpha + beta",
    "  inner()",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:al" %in% diagnostic_symbols(live_lexical_false_negative, "partial-argument"),
    "A nested function missed a callable installed in its live lexical environment"
  )

  zero_iteration_for <- paste(
    "function(values) {",
    "  target <- function(alpha, beta) alpha + beta",
    "  for (target in values) invisible(target)",
    "  target(al = 1, beta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:al" %in% diagnostic_symbols(zero_iteration_for, "partial-argument"),
    "A zero-iteration for path discarded the prior callable binding"
  )
  assert_true(
    !("target:al" %in% diagnostic_symbols(
      "function(values) { target <- function(alpha, beta) 1; for (target in values) target(al = 1, beta = 2) }",
      "partial-argument"
    )),
    "A for-loop variable did not mask an outer callable inside the loop body"
  )
  zero_iteration_while <- paste(
    "function(flag) {",
    "  target <- function(alpha, beta) alpha + beta",
    "  while (flag) target <- function(apple, pear) apple + pear",
    "  target(al = 1, beta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:al" %in% diagnostic_symbols(zero_iteration_while, "partial-argument"),
    "A zero-iteration while path discarded the prior callable binding"
  )
  multiple_iteration_for <- paste(
    "function(values) {",
    "  target <- function(alpha, beta) alpha + beta",
    "  replacement <- function(gamma, delta) gamma + delta",
    "  for (value in values) { target(ga = 1, delta = 2); target <- replacement }",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:ga" %in% diagnostic_symbols(multiple_iteration_for, "partial-argument"),
    "A later for iteration did not observe a prior iteration binding"
  )
  multiple_iteration_while <- paste(
    "function(flag) {",
    "  target <- function(alpha, beta) alpha + beta",
    "  replacement <- function(gamma, delta) gamma + delta",
    "  while (flag) { target(ga = 1, delta = 2); target <- replacement }",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:ga" %in% diagnostic_symbols(multiple_iteration_while, "partial-argument"),
    "A later while iteration did not observe a prior iteration binding"
  )
  multiple_iteration_repeat <- paste(
    "function(flag) {",
    "  target <- function(alpha, beta) alpha + beta",
    "  replacement <- function(gamma, delta) gamma + delta",
    "  repeat { target(ga = 1, delta = 2); target <- replacement; if (flag) break }",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:ga" %in% diagnostic_symbols(multiple_iteration_repeat, "partial-argument"),
    "A later repeat iteration did not observe a prior iteration binding"
  )
  assert_true(
    !("target:al" %in% diagnostic_symbols(
      "function() { target <- function(alpha, beta) 1; repeat { target <- function(gamma, delta) 1; break }; target(al = 1, delta = 2) }",
      "partial-argument"
    )),
    "A repeat body was incorrectly treated as a zero-iteration path"
  )
  assert_true(
    "target:al" %in% diagnostic_symbols(
      "function(flag) { if (flag) target <- function(alpha, beta) 1 else base::stop('done'); target(al = 1, beta = 2) }",
      "partial-argument"
    ),
    "A terminal branch discarded the only continuing callable state"
  )
  break_exit_scope <- paste(
    "function(flag) {",
    "  target <- function(alpha, beta) alpha + beta",
    "  while (flag) {",
    "    if (flag) { target <- function(gamma, delta) gamma + delta; break }",
    "    else { target <- function(apple, pear) apple + pear; return(NULL) }",
    "  }",
    "  target(ga = 1, delta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:ga" %in% diagnostic_symbols(break_exit_scope, "partial-argument") &&
      !("target:ap" %in% diagnostic_symbols(break_exit_scope, "partial-argument")),
    "A reachable break exit was dropped or merged with a returning branch"
  )
  repeat_break_exit <- paste(
    "function() {",
    "  target <- function(alpha, beta) alpha + beta",
    "  repeat { target <- function(gamma, delta) gamma + delta; break }",
    "  target(ga = 1, delta = 2)",
    "}",
    sep = "\n"
  )
  assert_true(
    "target:ga" %in% diagnostic_symbols(repeat_break_exit, "partial-argument") &&
      !("target:al" %in% diagnostic_symbols(repeat_break_exit, "partial-argument")),
    "A repeat break exit did not become the sole reachable post-loop state"
  )

  same_line_writes <- paste(
    "base::assign('first', 1, envir = .GlobalEnv);",
    "base::assign('second', 2, envir = .GlobalEnv)"
  )
  write_operations <- diagnostic_operations(same_line_writes, "global-assignment", "assign:.GlobalEnv")
  assert_true(
    length(write_operations) == 2L && length(unique(write_operations)) == 2L,
    "Same-line same-symbol writes collapsed to one diagnostic identity"
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
  member_location <- paste(
    "object$target(al = 1)",
    "target <- function(alpha, beta) alpha + beta",
    "target(al = 1, beta = 2)",
    sep = "\n"
  )
  assert_true(
    identical(diagnostic_lines(member_location, "partial-argument", "target:al"), 3L),
    "A member call captured the exact later callable diagnostic location"
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

  work_probe <- paste(
    "target <- function(alpha, beta) alpha + beta",
    "if (flag) target <- function(apple, pear) apple + pear",
    "target(al = missing_value, beta = 2)",
    sep = "\n"
  )
  measured_work <- attr(diagnostics(work_probe), "work", exact = TRUE)
  assert_true(
    identical(names(measured_work), c("candidate_states", "operations", "diagnostic_bytes")) &&
      all(is.finite(measured_work)) && all(measured_work > 1),
    "Analyzer work receipts are incomplete"
  )
  exact_work_limits <- fixture_limits
  for (name in names(measured_work)) exact_work_limits[[name]] <- as.integer(measured_work[[name]])
  exact_work <- diagnostics_with_limits(work_probe, exact_work_limits)
  assert_true(
    identical(attr(exact_work, "work", exact = TRUE), measured_work),
    "Exact analyzer work bounds did not preserve the measured receipt"
  )
  for (name in names(measured_work)) {
    below <- exact_work_limits
    below[[name]] <- below[[name]] - 1L
    expect_error(
      diagnostics_with_limits(work_probe, below),
      sprintf("analysis %s work exceeds its bound", gsub("_", " ", name, fixed = TRUE))
    )
  }

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
  assert_true(
    identical(unname(policy$ratchets[["global-assignment"]]), 3L),
    "The intentional production global-assignment ratchet is not exact"
  )
  production_suppressions <- analyzer$test$parse_suppressions(".", policy)
  global_suppressions <- Filter(
    function(item) identical(item$rule, "global-assignment"),
    production_suppressions
  )
  assert_true(
    identical(
      vapply(global_suppressions, `[[`, character(1L), "key"),
      paste(
        "r/openwrangler_runtime/interactive_agent.R",
        c(311L, 368L, 601L),
        c("L311:C7-L311:C58", "L368:C7-L368:C58", "L601:C5-L601:C64"),
        "global-assignment",
        "assign:.GlobalEnv",
        sep = "\t"
      )
    ),
    "The intentional production global-write suppression ownership changed"
  )
  policy_root <- tempfile("ow-r-static-policy-")
  dir.create(file.path(policy_root, "r"), recursive = TRUE, mode = "0700")
  on.exit(unlink(policy_root, recursive = TRUE, force = TRUE), add = TRUE)
  policy_text <- readLines("r/static-analysis-policy.dcf", warn = FALSE, encoding = "UTF-8")
  writeLines(
    sub("openwrangler-native-r-static-analysis-v2", "openwrangler-native-r-static-analysis-v3", policy_text, fixed = TRUE),
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
  header <- "path\tline\toperation\trule\tsymbol\tjustification"
  valid <- "r/openwrangler_runtime/frame_contract.R\t1\tline:1\tundefined-symbol\tmissing\tExact fixture justification."
  writeLines(c(header, valid, valid), suppression_path, useBytes = TRUE)
  expect_error(analyzer$test$parse_suppressions(suppression_root, policy), "duplicates an earlier entry")
  writeLines(c(header, sub("missing", "*", valid, fixed = TRUE)), suppression_path, useBytes = TRUE)
  expect_error(analyzer$test$parse_suppressions(suppression_root, policy), "contains a wildcard")
  writeLines(c(header, valid), suppression_path, useBytes = TRUE)
  parsed <- analyzer$test$parse_suppressions(suppression_root, policy)
  expect_error(analyzer$test$apply_suppressions(list(), parsed), "stale or unused suppression")
  exact_write_suppression <- sprintf(
    "r/openwrangler_runtime/frame_contract.R\t1\t%s\tglobal-assignment\tassign:.GlobalEnv\tExact first write only.",
    write_operations[[1L]]
  )
  writeLines(c(header, exact_write_suppression), suppression_path, useBytes = TRUE)
  remaining_write <- analyzer$test$apply_suppressions(diagnostics(same_line_writes), analyzer$test$parse_suppressions(
    suppression_root, policy
  ))
  assert_true(
    length(remaining_write) == 1L && identical(remaining_write[[1L]]$operation, write_operations[[2L]]),
    "An exact same-line write suppression consumed a different source operation"
  )
  second <- "r/openwrangler_runtime/frame_contract.R\t2\tline:2\tundefined-symbol\tmissing_two\tExact fixture justification."
  one_suppression_policy <- policy
  one_suppression_policy$limits$suppressions <- 1L
  writeLines(c(header, valid, second), suppression_path, useBytes = TRUE)
  expect_error(analyzer$test$parse_suppressions(suppression_root, one_suppression_policy), "suppression count exceeds")
  overflow <- c(header, vapply(seq_len(5L), function(index) {
    sprintf("r/openwrangler_runtime/frame_contract.R\t%d\tline:%d\tundefined-symbol\tmissing_%d\tExact fixture justification.", index, index, index)
  }, character(1L)))
  writeLines(overflow, suppression_path, useBytes = TRUE)
  expect_error(analyzer$test$parse_suppressions(suppression_root, policy), "suppression ratchet exceeded")
  global_overflow <- c(header, vapply(seq_len(4L), function(index) {
    sprintf(
      "r/openwrangler_runtime/interactive_agent.R\t%d\tline:%d\tglobal-assignment\tassign:.GlobalEnv:%d\tExact fixture justification.",
      index,
      index,
      index
    )
  }, character(1L)))
  writeLines(global_overflow, suppression_path, useBytes = TRUE)
  expect_error(analyzer$test$parse_suppressions(suppression_root, policy), "suppression ratchet exceeded")

  oversized_path <- file.path(suppression_root, "oversized.txt")
  writeChar("12345", oversized_path, eos = NULL, useBytes = TRUE)
  expect_error(analyzer$test$read_bounded_utf8(oversized_path, 4L, "fixture"), "exceeds 4 bytes")

  cat("Native R static analysis checks passed\n")
})
