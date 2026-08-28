selected_case <- Sys.getenv("OPEN_WRANGLER_R_FRAME_CASE", unset = NA_character_)
if (length(selected_case) != 1L || !identical(selected_case, "interactive")) {
  stop("The interactive Native R contract requires its exact isolated case selection", call. = FALSE)
}

source("r/tests/frame_contract.R", local = FALSE)
source("r/openwrangler_runtime/interactive_agent.R", local = FALSE)

local({
  agent_environment <- environment(openwrangler_r_interactive_agent$register_transport)
  atomic_replace <- get("atomic_replace", envir = agent_environment, inherits = FALSE)
  test_directory <- tempfile("openwrangler-r-atomic-replace-")
  if (!dir.create(test_directory)) {
    stop("Could not create the atomic-replace contract directory", call. = FALSE)
  }
  on.exit(unlink(test_directory, recursive = TRUE, force = TRUE), add = TRUE)

  target <- file.path(test_directory, "notification.json")
  temporary <- paste0(target, ".tmp")
  previous_payload <- charToRaw("previous")
  replacement_payload <- charToRaw("replacement")

  writeBin(previous_payload, target)
  atomic_replace(target, "replacement")
  assert_identical(
    readBin(target, what = "raw", n = 64L),
    replacement_payload,
    "atomic replacement did not publish over an existing notification"
  )
  assert_true(!file.exists(temporary), "successful atomic replacement retained its private temporary file")

  writeBin(previous_payload, target)
  assert_true(
    !exists("file.rename", envir = agent_environment, inherits = FALSE),
    "the isolated interactive agent unexpectedly overrides file.rename"
  )
  rename_attempt <- NULL
  assign("file.rename", function(from, to) {
    rename_attempt <<- list(from = from, to = to, target_existed = file.exists(to))
    FALSE
  }, envir = agent_environment)
  on.exit({
    if (exists("file.rename", envir = agent_environment, inherits = FALSE)) {
      rm("file.rename", envir = agent_environment)
    }
  }, add = TRUE)

  failure <- tryCatch(atomic_replace(target, "replacement"), error = identity)
  assert_true(inherits(failure, "error"), "a failed atomic rename did not report publication failure")
  assert_identical(
    conditionMessage(failure),
    "Open Wrangler could not publish its interactive R discovery notification.",
    "a failed atomic rename reported the wrong publication failure"
  )
  assert_identical(
    rename_attempt,
    list(from = temporary, to = target, target_existed = TRUE),
    "atomic replacement removed or redirected the published notification before rename"
  )
  assert_true(file.exists(target), "a failed atomic rename removed the previously published notification")
  assert_identical(
    readBin(target, what = "raw", n = 64L),
    previous_payload,
    "a failed atomic rename destroyed the previously published notification"
  )
  assert_true(!file.exists(temporary), "a failed atomic rename retained its private temporary file")
})
