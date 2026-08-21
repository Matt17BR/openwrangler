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
  rules <- function(source) {
    diagnostics <- analyzer$test$analyze_text(source, "r/openwrangler_runtime/frame_contract.R", fixture_limits)
    vapply(diagnostics, `[[`, character(1L), "rule")
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
  assert_true("global-assignment" %in% rules("function() unsafe_target <<- 1"), "Unsafe global assignment was not detected")
  assert_true("unqualified-call" %in% rules("function() unowned_package_call()"), "Unqualified calls were not detected")
  assert_true("namespace-attachment" %in% rules("library(stats)"), "Namespace attachment was not detected")
  assert_true("namespace-attachment" %in% rules("base::library(stats)"), "Qualified namespace attachment was not detected")
  assert_true("unreachable-expression" %in% rules("function() { return(1); 2 }"), "Unreachable expressions were not detected")
  assert_true("unreachable-expression" %in% rules("function() { while (TRUE) { break; 2 } }"), "Unreachable loop expressions were not detected")

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
