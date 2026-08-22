selected_case <- Sys.getenv("OPEN_WRANGLER_R_FRAME_CASE", unset = NA_character_)
if (length(selected_case) != 1L || !identical(selected_case, "interactive")) {
  stop("The interactive Native R contract requires its exact isolated case selection", call. = FALSE)
}

source("r/tests/frame_contract.R", local = FALSE)
