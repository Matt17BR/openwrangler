# Native numeric representation contracts shared by canonical and platform qualification.

local({
  tiny <- 2^-1074
  sources <- new.env(parent = baseenv())
  sources$portable_interpolation <- data.frame(coordinate = c(0, 3, 4),
    quarter = c(-2 * tiny, NA_real_, 2 * tiny), zero = c(-tiny, NA_real_, 0),
    row.names = c("left", "gap", "right"))
  before <- serialize(sources$portable_interpolation, NULL, version = 3L)
  expected <- sources$portable_interpolation
  agent <- openwrangler_r_kernel_agent$new_agent(instrumented_frame_contract, sources)
  on.exit(agent$dispose(), add = TRUE)
  session <- "96969696-9696-4696-8696-969696969696"
  opened <- dispatch_with(agent, "openSession", list(
    sessionId = session, variableName = "portable_interpolation", page = page_window()))
  assert_identical(opened$kind, "page", "portable interpolation did not open")
  revision <- 0L
  for (position in 2:3) {
    name <- names(expected)[[position]]
    expected[[position]][[2L]] <- if (position == 2L) tiny else -abs(0)
    preview <- dispatch_with(agent, "previewStep", list(sessionId = session, revision = revision,
      step = fill_step(paste0("portable-", name), paste0("r:c:", position - 1L), name,
        list(kind = "linearInterpolation", coordinate = list(id = "r:c:0", name = "coordinate"))),
      page = page_window()))
    assert_identical(preview$kind, "stepPreview", "portable interpolation did not preview")
    live <- get("snapshot", envir = latest_full_capture, inherits = FALSE)
    assert_identical(writeBin(live[[position]], raw(), size = 8L),
      writeBin(expected[[position]], raw(), size = 8L), "portable interpolation lost live binary64 bits")
    applied <- dispatch_with(agent, "applyDraft", list(
      sessionId = session, revision = preview$revision, page = page_window()))
    assert_identical(applied$page, preview$page, "portable interpolation changed on Apply")
    declarations <- grep("^[[:space:]]*\\.ow_fill_[a-z_]+ <- function",
      strsplit(applied$code, "\n", fixed = TRUE)[[1L]], value = TRUE)
    assert_identical(sub(" <- function.*$", "", trimws(declarations)),
      c(".ow_fill_subnormal_units", ".ow_fill_linear"), "repeated interpolation duplicated or omitted helpers")
    copied <- new.env(parent = baseenv())
    copied$portable_interpolation <- unserialize(before)
    eval(parse(text = applied$code), envir = copied)
    assert_identical(copied$open_wrangler_result, expected, "generated interpolation changed values or metadata")
    compiled <- compiler::cmpfun(eval(parse(text = paste("function(portable_interpolation) {", applied$code,
      "open_wrangler_result\n}", sep = "\n")), envir = baseenv()))
    compiled_result <- compiled(copied$portable_interpolation)
    assert_identical(compiled_result, expected, "compiled interpolation changed values or metadata")
    assert_identical(writeBin(compiled_result[[position]], raw(), size = 8L),
      writeBin(expected[[position]], raw(), size = 8L), "compiled interpolation lost binary64 bits")
    assert_identical(serialize(copied$portable_interpolation, NULL, version = 3L), before,
      "compiled interpolation changed its source")
    revision <- applied$revision
  }
  for (iteration in 1:2) {
    undone <- dispatch_with(agent, "undoStep", list(sessionId = session, revision = revision, page = page_window()))
    revision <- undone$revision
  }
  assert_identical(undone$page, opened$page, "portable interpolation Undo changed source metadata or rows")
  assert_identical(serialize(sources$portable_interpolation, NULL, version = 3L), before,
    "portable interpolation changed source")
  invisible(dispatch_with(agent, "closeSession", list(sessionId = session)))
})

# Hexadecimal inputs bind the Fraction oracles to the same binary64 values on every platform.
# These controls protect cancellation and final rounding, including signed zero.
local({
  raw_double <- function(value) writeBin(value, raw(), size = 8L, endian = "little")
  cases <- list(
    singleton_named_integer = list(values = c(donor = 17L), expected = "0x1.1000000000000p+4"),
    singleton_named_negative = list(values = c(donor = -7.5), expected = "-0x1.e000000000000p+2"),
    singleton_positive_zero = list(values = 0, expected = "0x0.0p+0"),
    singleton_negative_zero = list(values = -abs(0), expected = "0x0.0p+0"),
    singleton_negative_subnormal = list(values = -0x0.0000000000001p-1022, expected = "-0x0.0000000000001p-1022"),
    cancel_order_0 = list(values = c(-0x1.1ccf385ebc8a0p+1023, 0x1.1ccf385ebc8a0p+1023, 0x1.8000000000000p+1), expected = "0x1.0000000000000p+0"),
    ordinary_cancellation = list(values = c(0x1.1c37937e08000p+53, 0x1.0000000000000p+0, -0x1.1c37937e08000p+53), expected = "0x1.5555555555555p-2"),
    near_one_rounding_1 = list(values = c(0x1.ffffffffffff0p-1, 0x1.ffffffffffff0p-1, 0x1.ffffffffffff2p-1), expected = "0x1.ffffffffffff1p-1"),
    minimum_equal = list(values = c(0x0.0000000000001p-1022, 0x0.0000000000001p-1022, 0x0.0000000000001p-1022), expected = "0x0.0000000000001p-1022"),
    max_finite = list(values = c(0x1.fffffffffffffp+1023, 0x1.fffffffffffffp+1023, 0x1.fffffffffffffp+1023), expected = "0x1.fffffffffffffp+1023"),
    signed_zero = list(values = c(-0x0.0p+0, -0x0.0p+0, -0x0.0p+0), expected = "0x0.0p+0"),
    paired_zero = list(values = c(0x1.0000000000000p+1000, 0x0.0p+0, -0x1.0000000000000p+1000, 0x1.0000000000000p+2), expected = "0x1.0000000000000p+0"),
    paired_three = list(values = c(0x1.0000000000000p+1000, 0x1.8000000000000p+1, -0x1.0000000000000p+1000, 0x1.0000000000000p+2), expected = "0x1.c000000000000p+0"),
    paired_one = list(values = c(0x1.0000000000000p+1000, 0x1.0000000000000p+0, -0x1.0000000000000p+1000, 0x1.0000000000000p+2), expected = "0x1.4000000000000p+0"),
    scale_underflow = list(values = c(0x1.0000000000000p+1, -0x1.0000000000000p+1, 0x0.0000000000003p-1022), expected = "0x0.0000000000001p-1022"),
    small_compensation_lost = list(values = c(0x1.0000000000000p+1000, 0x1.0000000000000p+0, 0x1.0000000000000p-60, -0x1.0000000000000p+1000, -0x1.0000000000000p+0), expected = "0x1.999999999999ap-63"),
    positive_accumulation = list(values = c(1, rep.int(2^-64, 512L)), expected = "0x1.ff007fc01ff01p-10"),
    large53_small58 = list(values = c(0x1.0000000000000p+53, 0x1.0000000000000p+0, -0x1.0000000000000p+53, 0x1.0000000000000p-58, -0x1.0000000000000p+0), expected = "0x1.999999999999ap-61"),
    half_q = list(values = c(0x0.0000000000001p-1022, 0x0.0p+0), expected = "0x0.0p+0"),
    negative_half_q = list(values = c(-0x0.0000000000001p-1022, 0x0.0p+0), expected = "-0x0.0p+0"),
    three_half_q = list(values = c(0x0.0000000000001p-1022, 0x0.0000000000002p-1022), expected = "0x0.0000000000002p-1022"),
    below_half_q = list(values = c(0x0.0000000000001p-1022, 0x0.0p+0, 0x0.0p+0), expected = "0x0.0p+0"),
    above_half_q = list(values = c(0x0.0000000000001p-1022, 0x0.0000000000001p-1022, 0x0.0p+0), expected = "0x0.0000000000001p-1022"),
    subnormal_normal_carry = list(values = c(0x0.fffffffffffffp-1022, 0x1.0000000000000p-1022), expected = "0x1.0000000000000p-1022"),
    significand_carry = list(values = c(0x1.fffffffffffffp+0, 0x1.0000000000000p+1), expected = "0x1.0000000000000p+1"),
    normal_tie_even = list(values = c(0x1.0000000000000p+0, 0x1.0000000000001p+0), expected = "0x1.0000000000000p+0"),
    ordinary_rational_232_over_100 = list(values = rep(c(1, 2, 4), length.out = 100L), expected = "0x1.28f5c28f5c28fp+1"),
    prefix_one_decrement = list(values = c(0x1.0000000000000p+0, 0x0.0p+0, 0x0.0p+0), expected = "0x1.5555555555555p-2"),
    odd_divisor_tail_below_half = list(values = c(0x1.8000000000000p+1, 0x1.7ffffffffffffp-52, 0x0.0p+0), expected = "0x1.0000000000000p+0"),
    odd_divisor_tail_half_even = list(values = c(0x1.8000000000000p+1, 0x1.8000000000000p-52, 0x0.0p+0), expected = "0x1.0000000000000p+0"),
    odd_divisor_tail_above_half = list(values = c(0x1.8000000000000p+1, 0x1.8000000000001p-52, 0x0.0p+0), expected = "0x1.0000000000001p+0"),
    odd_divisor_tail_half_odd = list(values = c(0x1.8000000000000p+1, 0x1.2000000000000p-50, 0x0.0p+0), expected = "0x1.0000000000002p+0"),
    even_divisor_tail_positive = list(values = c(0x1.0000000000000p+0, 0x1.0000000000001p-53), expected = "0x1.0000000000001p-1"),
    normal_word_aligned = list(values = c(0x1.0000000000000p+2), expected = "0x1.0000000000000p+2"),
    difference = list(values = c(rep.int(-0x1.1ccf385ebc8a0p+1023, 65536L), rep.int(0x1.1ccf385ebc8a0p+1023, 34465L)), expected = "-0x1.61f81322a05d2p+1021"),
    product = list(values = c(rep.int(0, 65536L), rep.int(0x1.6c8e5ca239029p+1016, 34465L)), expected = "0x1.f6926f94af3a2p+1014"),
    maximum = list(values = rep.int(.Machine$double.xmax, 100001L), expected = "0x1.fffffffffffffp+1023"),
    cancellation_sign = list(values = c(rep.int(0x1.c7b1f3cac7433p+1019, 131072L), rep.int(-0x1.c7b3bb7e82c1bp+1020, 65535L)), expected = "0x1.d675f22750b7cp+963"),
    cancellation_zero = list(values = c(rep.int(0x1.1ccf385ebc8a0p+1023, 65536L), rep.int(-0x1.1cd0552f11b91p+1023, 65535L)), expected = "0x1.b910dc886e443p+966")
  )
  for (name in names(cases)) {
    case <- cases[[name]]
    frame <- data.frame(group = rep.int("g", length(case$values)), value = case$values)
    before <- serialize(frame, NULL, version = 3L)
    result <- openwrangler_r_frame_contract$group_by_at(frame, 1L, "group", 2L, "value", "mean", "average")
    expected <- raw_double(as.double(case$expected))
    assert_identical(raw_double(result$average), expected, paste(name, "Group By lost exact mean bits"))
    assert_identical(serialize(frame, NULL, version = 3L), before, paste(name, "Group By changed its source"))
    helpers <- openwrangler_r_frame_contract$exact_mean_helpers
    reversed_mean <- helpers$exact_binary64_mean(rev(case$values))
    assert_identical(typeof(reversed_mean), "double", paste(name, "mean changed its numeric type"))
    assert_identical(attributes(reversed_mean), NULL, paste(name, "mean retained source attributes"))
    assert_identical(raw_double(reversed_mean), expected,
      paste(name, "mean changed under permutation"))
    state <- helpers$exact_mean_new()
    size <- if (length(case$values) > 65536L) 32767L else 2L
    for (start in seq.int(1L, length(case$values), by = size)) {
      end <- min(length(case$values), start + size - 1L)
      state <- helpers$exact_mean_add(case$values[seq.int(start, end)], state)
    }
    assert_identical(raw_double(helpers$exact_mean_finish(state)), expected,
      paste(name, "mean changed across native update boundaries"))
  }
})

# Exact means use the full profile population, retaining native class and missing policies.
local({
  cases <- list(
    difference = list(values = c(rep.int(-0x1.1ccf385ebc8a0p+1023, 65536L), rep.int(0x1.1ccf385ebc8a0p+1023, 34465L)), expected = "-0x1.61f81322a05d2p+1021"),
    product = list(values = c(rep.int(0, 65536L), rep.int(0x1.6c8e5ca239029p+1016, 34465L)), expected = "0x1.f6926f94af3a2p+1014"),
    maximum = list(values = rep.int(.Machine$double.xmax, 100001L), expected = "0x1.fffffffffffffp+1023"),
    cancellation_sign = list(values = c(rep.int(0x1.c7b1f3cac7433p+1019, 131072L), rep.int(-0x1.c7b3bb7e82c1bp+1020, 65535L)), expected = "0x1.d675f22750b7cp+963"),
    cancellation_zero = list(values = c(rep.int(0x1.1ccf385ebc8a0p+1023, 65536L), rep.int(-0x1.1cd0552f11b91p+1023, 65535L)), expected = "0x1.b910dc886e443p+966"),
    small = list(values = c(2^1000, 0, -2^1000, 4), expected = "0x1p+0"),
    duration = list(values = as.difftime(c(rep.int(-0x1.6c8e5ca239029p+1016, 65536L), rep.int(0x1.6c8e5ca239029p+1016, 34465L)), units = "hours"),
      expected = "-0x1.c514935f8595fp+1014")
  )
  for (name in names(cases)) {
    case <- cases[[name]]
    frame <- data.frame(value = case$values)
    before <- serialize(frame, NULL, version = 3L)
    capture <- openwrangler_r_frame_contract$capture_frame(frame)
    summary <- openwrangler_r_frame_contract$materialize_summaries(capture, list(list(id = "r:c:0", name = "value")))[[1L]]
    assert_identical(summary$numeric$mean, as.double(case$expected), paste(name, "profile lost the exact finite mean"))
    assert_identical(serialize(frame, NULL, version = 3L), before, paste(name, "profile changed source storage or attributes"))
  }
})

# Exact finite means retain group identity, null keys, standalone ownership, and repeated helper admission.
local({
  sources <- new.env(parent = baseenv())
  sources$exact_means <- data.frame(group = c(rep("b", 3L), rep("a", 4L), rep("c", 4L), NA, NA, "zero", "tiny"),
    value = c(-1e308, 1e308, 3, 2^1000, 0, -2^1000, 4, 2^1000, 3, -2^1000, 4, NA, NaN, -abs(0), -0x0.0000000000001p-1022))
  before <- serialize(sources$exact_means, NULL, version = 3L)
  expected <- data.frame(group = c("b", "a", "c", NA, "zero", "tiny"), average = c(1, 1, 1.75, NA, 0, -0x0.0000000000001p-1022))
  agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, sources)
  on.exit(agent$dispose(), add = TRUE)
  session <- "76767676-7676-4676-8676-767676767676"
  opened <- dispatch_with(agent, "openSession", list(sessionId = session, variableName = "exact_means", page = page_window()))
  assert_identical(opened$kind, "page", "the exact mean source did not open")
  revision <- 0L
  for (iteration in 1:2) {
    step <- list(id = paste0("exact-mean-", iteration), kind = "groupBy", params = list(
      keys = list(list(id = "r:c:0", name = "group")), aggregations = list(list(
        column = list(id = if (iteration == 1L) "r:c:1" else "c:step:exact-mean-1:0",
          name = if (iteration == 1L) "value" else "average"), operation = "mean", alias = "average"))))
    preview <- dispatch_with(agent, "previewStep", list(sessionId = session, revision = revision, step = step, page = page_window()))
    assert_identical(preview$kind, "stepPreview", "exact Group By did not preview")
    assert_identical(vapply(preview$page$page$rows[1:3], function(row) row$values[[2L]]$raw, character(1L)),
      c("1", "1", "1.75"), "public Group By rounded finite cancellation")
    applied <- dispatch_with(agent, "applyDraft", list(sessionId = session, revision = preview$revision, page = page_window()))
    assert_identical(applied$page, preview$page, "exact Group By changed on Apply")
    copied <- new.env(parent = baseenv())
    copied$exact_means <- unserialize(before)
    lines <- strsplit(applied$code, "\n", fixed = TRUE)[[1L]]
    for (name in names(openwrangler_r_frame_contract$exact_mean_helpers)) {
      header <- paste0("  ", name, " <-")
      assert_identical(sum(lines == header), 1L, paste("wrong shared mean definition count for", name))
      helper <- openwrangler_r_frame_contract$exact_mean_helpers[[name]]
      emitted <- paste(c(header, paste0("  ", deparse(helper, width.cutoff = 500L))), collapse = "\n")
      assert_identical(grepl(emitted, applied$code, fixed = TRUE), TRUE, paste("generated code changed the live", name))
      copied[[name]] <- function(...) stop("caller exact mean ran")
    }
    assert_no_warning(eval(parse(text = applied$code), envir = copied), "generated exact means")
    assert_identical(copied$open_wrangler_result, expected, "generated exact means changed values, types, order or missing keys")
    assert_identical(writeBin(copied$open_wrangler_result$average, raw(), size = 8L, endian = "little"),
      writeBin(expected$average, raw(), size = 8L, endian = "little"), "generated singleton means changed zero or subnormal bits")
    assert_identical(serialize(copied$exact_means, NULL, version = 3L), before, "generated means changed source storage")
    revision <- applied$revision
  }
  for (iteration in 1:2) {
    undone <- dispatch_with(agent, "undoStep", list(sessionId = session, revision = revision, page = page_window()))
    revision <- undone$revision
  }
  assert_identical(undone$page, opened$page, "exact mean Undo did not restore source metadata and rows")
  assert_identical(serialize(sources$exact_means, NULL, version = 3L), before, "exact mean mutated its source")
  invisible(dispatch_with(agent, "closeSession", list(sessionId = session)))
})

# Scalar and grouped Mean Fill share exact cancellation and one helper set across repeated steps.
local({
  sources <- new.env(parent = baseenv())
  sources$exact_fill <- data.frame(group = rep.int("g", 5L), value = c(-1e308, 1e308, 3, NA, NaN),
    row.names = paste0("exact-", 1:5))
  before <- serialize(sources$exact_fill, NULL, version = 3L)
  expected <- sources$exact_fill
  expected$value[4:5] <- 1
  agent <- openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, sources)
  on.exit(agent$dispose(), add = TRUE)
  session <- "77777777-7676-4676-8676-777777777777"
  for (grouped in c(FALSE, TRUE)) {
    opened <- dispatch_with(agent, "openSession", list(sessionId = session, variableName = "exact_fill", page = page_window()))
    revision <- 0L
    for (iteration in 1:2) {
      replacement <- if (grouped) list(kind = "groupedStatistic", statistic = "mean",
        keys = list(list(id = "r:c:0", name = "group"))) else list(kind = "mean")
      preview <- dispatch_with(agent, "previewStep", list(sessionId = session, revision = revision, page = page_window(),
        step = fill_step(paste0("exact-fill-", iteration), "r:c:1", "value", replacement)))
      assert_identical(preview$kind, "stepPreview", "exact Mean Fill did not preview")
      assert_identical(vapply(preview$page$page$rows[4:5], function(row) row$values[[2L]]$raw, character(1L)),
        c("1", "1"), "public Mean Fill lost finite cancellation")
      assert_identical(preview$diff$changedCells, if (iteration == 1L) 2L else 0L, "exact Mean Fill changed its diff")
      applied <- dispatch_with(agent, "applyDraft", list(sessionId = session, revision = preview$revision, page = page_window()))
      assert_identical(applied$page, preview$page, "exact Mean Fill changed on Apply")
      lines <- strsplit(applied$code, "\n", fixed = TRUE)[[1L]]
      for (name in names(openwrangler_r_frame_contract$exact_mean_helpers)) {
        assert_identical(sum(lines == paste0("  ", name, " <-")), 1L, paste("repeated Fill duplicated", name))
      }
      copied <- new.env(parent = baseenv())
      copied$exact_fill <- unserialize(before)
      copied$exact_binary64_mean <- function(...) stop("caller mean ran")
      eval(parse(text = applied$code), envir = copied)
      assert_identical(copied$open_wrangler_result, expected, "copied Mean Fill changed exact values, class or row names")
      assert_identical(serialize(copied$exact_fill, NULL, version = 3L), before, "copied Mean Fill changed source")
      revision <- applied$revision
    }
    for (donor in c(-abs(0), -0x0.0000000000001p-1022)) {
      copied$exact_fill <- unserialize(before)
      copied$exact_fill$value <- c(donor, NA, NA, NA, NaN)
      singleton_before <- serialize(copied$exact_fill, NULL, version = 3L)
      singleton_expected <- copied$exact_fill
      singleton_expected$value[2:5] <- if (donor == 0) 0 else donor
      singleton_live <- if (grouped) {
        openwrangler_r_frame_contract$fill_missing_grouped_statistic_at(copied$exact_fill, 2L, "value", 1L, "group", "mean")
      } else {
        openwrangler_r_frame_contract$fill_missing_column_at(copied$exact_fill, 2L, "value", list(kind = "mean"))
      }
      eval(parse(text = applied$code), envir = copied)
      assert_identical(singleton_live, singleton_expected, "single-donor Mean Fill changed values or metadata")
      assert_identical(copied$open_wrangler_result, singleton_expected, "copied single-donor Mean Fill changed values or metadata")
      for (result in list(singleton_live, copied$open_wrangler_result)) {
        assert_identical(writeBin(result$value, raw(), size = 8L, endian = "little"),
          writeBin(singleton_expected$value, raw(), size = 8L, endian = "little"),
          "single-donor Mean Fill changed zero or subnormal bits")
      }
      assert_identical(serialize(copied$exact_fill, NULL, version = 3L), singleton_before, "single-donor Mean Fill changed source")
    }
    for (iteration in 1:2) {
      undone <- dispatch_with(agent, "undoStep", list(sessionId = session, revision = revision, page = page_window()))
      revision <- undone$revision
    }
    assert_identical(undone$page, opened$page, "Mean Fill Undo did not restore source metadata and rows")
    assert_identical(serialize(sources$exact_fill, NULL, version = 3L), before, "Mean Fill changed source")
    invisible(dispatch_with(agent, "closeSession", list(sessionId = session)))
  }
})

local({
  sources <- new.env(parent = baseenv())
  sources$literal_fill <- data.frame(large = c(0.5, NA, NaN), maximum = c(0.5, NA, NaN),
    tiny = c(0.5, NA, NaN), zero = c(0.5, NA, NaN), integer_text = c(0.5, NA, NaN),
    label = c("keep", NA, "word"), row.names = c("present", "null", "nan"))
  before <- serialize(sources$literal_fill, NULL, version = 3L)
  expected <- sources$literal_fill
  agent <- openwrangler_r_kernel_agent$new_agent(instrumented_frame_contract, sources)
  on.exit(agent$dispose(), add = TRUE)
  session <- "86868686-8686-4686-8686-868686868686"
  opened <- dispatch_with(agent, "openSession", list(sessionId = session, variableName = "literal_fill", page = page_window()))
  revision <- 0L
  cases <- list(
    list(kind = "float", value = "1e308", expected = 0x1.1ccf385ebc8a0p+1023),
    list(kind = "float", value = "1.7976931348623157e308", expected = 0x1.fffffffffffffp+1023),
    list(kind = "float", value = "-4.9406564584124654e-324", expected = -0x0.0000000000001p-1022),
    list(kind = "float", value = "-0", expected = -abs(0)),
    list(kind = "integer", value = "9223372036854775807", expected = 0x1p+63),
    list(kind = "string", value = "1e308", expected = "1e308")
  )
  for (index in seq_along(cases)) {
    case <- cases[[index]]
    replacement <- case[c("kind", "value")]
    expected[[index]][is.na(expected[[index]])] <- case$expected
    latest_full_capture <<- NULL
    preview <- dispatch_with(agent, "previewStep", list(sessionId = session, revision = revision, page = page_window(),
      step = fill_step(paste0("literal-", index), paste0("r:c:", index - 1L), names(expected)[[index]], replacement)))
    assert_identical(preview$kind, "stepPreview", "an exact decimal Fill did not preview")
    assert_identical(serialize(get("snapshot", envir = latest_full_capture, inherits = FALSE), NULL, version = 3L),
      serialize(expected, NULL, version = 3L), "live decimal Fill changed bits, missing replacement or text")
    applied <- dispatch_with(agent, "applyDraft", list(sessionId = session, revision = preview$revision, page = page_window()))
    assert_identical(applied$page, preview$page, "applying decimal Fill changed its confirmed page")
    copied <- new.env(parent = baseenv()); copied$literal_fill <- unserialize(before)
    eval(parse(text = applied$code), envir = copied)
    assert_identical(serialize(copied$open_wrangler_result, NULL, version = 3L), serialize(expected, NULL, version = 3L),
      "complete generated decimal/text Fill changed native bits or types")
    compiled <- compiler::cmpfun(eval(parse(text = paste("function(literal_fill) {", applied$code,
      "open_wrangler_result\n}", sep = "\n")), envir = new.env(parent = baseenv())))
    assert_identical(serialize(compiled(unserialize(before)), NULL, version = 3L), serialize(expected, NULL, version = 3L),
      "compiled decimal/text Fill changed native bits or types")
    assert_identical(serialize(copied$literal_fill, NULL, version = 3L), before, "generated decimal Fill mutated its source")
    revision <- applied$revision
  }
  for (index in seq_along(cases)) {
    undone <- dispatch_with(agent, "undoStep", list(sessionId = session, revision = revision, page = page_window()))
    revision <- undone$revision
  }
  assert_identical(undone$page, opened$page, "decimal/text Fill Undo did not restore the original source view")
  assert_identical(serialize(sources$literal_fill, NULL, version = 3L), before, "decimal/text Fill mutated its source")
  invisible(dispatch_with(agent, "closeSession", list(sessionId = session)))
})

# Fixed input bytes keep the literal encoder's oracle independent of decimal parsing.
local({
  owner <- environment(openwrangler_r_kernel_agent$new_agent)
  encode_number <- get("r_number", envir = owner, inherits = FALSE)
  patterns <- c(
    "0000000000000000", "0000000000000080", "000000000000f03f", "000000000000f0bf",
    "010000000000f03f", "000000000000e03f", "9a9999999999b93f",
    "a0c8eb85f3cce17f", "30058ee42eff2b2b", "0100000000000000", "0100000000000080",
    "ffffffffffff0f00", "0000000000001000", "ffffffffffffef7f", "ffffffffffffefff"
  )
  for (pattern in patterns) {
    bytes <- as.raw(strtoi(substring(pattern, seq(1L, 15L, 2L), seq(2L, 16L, 2L)), 16L))
    value <- readBin(bytes, double(), n = 1L, size = 8L, endian = "little")
    expression <- parse(text = encode_number(value))[[1L]]
    compiled <- compiler::cmpfun(eval(call("function", pairlist(), expression), baseenv()))
    for (actual in list(eval(expression, baseenv()), compiled())) {
      assert_identical(writeBin(actual, raw(), size = 8L, endian = "little"), bytes,
        sprintf("generated R changed binary64 literal %s", pattern))
    }
  }
  capacity <- get("maximum_operation_output_bytes", envir = owner, inherits = FALSE)
  assert_identical(eval(parse(text = encode_number(capacity)), baseenv()), capacity,
    "generated R changed its integer output capacity")
})

# Canonical integer text stays public text and binds only to an exact native scalar.
formula_literal_session <- "f9980000-0000-4000-8000-000000000001"
formula_max_integer_text <- paste0(
  "179769313486231570814527423731704356798070567525844996598917476803157260780028",
  "538760589558632766878171540458953514382464234321326889464182768467546703537516",
  "986049910576551282076245490090389328944075868508455133942304583236903222948165",
  "808559332123348274797826204144723168738177180919299881250404026184124858368"
)
formula_previous_max_integer_text <- paste0(
  "179769313486231550856124328384506240234343437157459335924404872448581845754556",
  "114388470639943126220321960804027157371570809852884964511743044087662767600909",
  "594331927728237078876188760579532563768698654064825262115771015791463983014857",
  "704008123419459386245141723703148097529108423358883457665451722744025579520"
)
formula_literal_cases <- list(
  list(value = "0", scalar = 0L),
  list(value = "2", scalar = 2L),
  list(value = "-2147483647", scalar = -2147483647L),
  list(value = "2147483647", scalar = 2147483647L, operator = "subtract"),
  list(value = "-2147483648", scalar = -2147483648),
  list(value = "2147483648", scalar = 2147483648),
  list(value = "1152921504606846976", scalar = 2^60),
  list(value = "-1152921504606846976", scalar = -2^60),
  list(value = "1267650600228229401496703205376", scalar = 2^100, compiled = TRUE),
  list(value = "-1267650600228229401496703205376", scalar = -2^100, compiled = TRUE),
  list(value = "1267650600228229260759214850048", scalar = 0x1.fffffffffffffp+99, compiled = TRUE),
  list(value = "1267650600228229682971679916032", scalar = 0x1.0000000000001p+100, compiled = TRUE),
  list(value = "9007199254740992", scalar = 0x1p+53, compiled = TRUE),
  list(value = "1000000000000000000", scalar = 0x1.bc16d674ec8p+59, compiled = TRUE),
  list(value = formula_max_integer_text, scalar = 0x1.fffffffffffffp+1023, compiled = TRUE),
  list(value = paste0("-", formula_max_integer_text), scalar = -0x1.fffffffffffffp+1023, compiled = TRUE),
  list(value = formula_previous_max_integer_text, scalar = 0x1.ffffffffffffep+1023, compiled = TRUE),
  list(value = "2", scalar = 2L, wide = TRUE),
  list(value = "1152921504606846976", scalar = 2^60, wide = TRUE),
  list(value = 2, scalar = 2L),
  list(value = 0.5, scalar = 0.5, compiled = TRUE),
  list(value = 2^60, scalar = 2^60),
  list(value = jsonlite::fromJSON("1e308"), scalar = jsonlite::fromJSON("1e308"), compiled = TRUE),
  list(value = jsonlite::fromJSON("1e-100"), scalar = jsonlite::fromJSON("1e-100"), compiled = TRUE)
)
for (literal in formula_literal_cases) {
  source_environment$formula_literal_frame <- data.frame(
    left = if (isTRUE(literal$wide)) bit64::as.integer64(c("0", "7", NA_character_)) else c(0L, 7L, NA_integer_),
    row.names = c("zero", "seven", "missing")
  )
  formula_literal_before <- serialize(source_environment$formula_literal_frame, NULL, version = 3L)
  literal_open <- dispatch("openSession", list(
    sessionId = formula_literal_session, variableName = "formula_literal_frame", page = page_window()
  ))
  assert_identical(literal_open$kind, "page", "the R Formula integer-text source did not open")
  literal_operator <- if (is.null(literal$operator)) "add" else literal$operator
  literal_step <- formula_step("formula-literal", literal_operator, "result", value = literal$value)
  literal_preview <- dispatch("previewStep", list(
    sessionId = formula_literal_session, revision = 0L, step = literal_step, page = page_window()
  ))
  assert_identical(
    literal_preview$kind, "stepPreview",
    sprintf("R Formula literal %s did not preview: %s", literal$value, literal_preview$message)
  )
  expected_left <- source_environment$formula_literal_frame$left
  if (isTRUE(literal$wide) && is.double(literal$scalar)) expected_left <- as.double(expected_left)
  expected <- if (identical(literal_operator, "subtract")) {
    expected_left - literal$scalar
  } else {
    expected_left + literal$scalar
  }
  expected_frame <- source_environment$formula_literal_frame
  expected_frame$result <- expected
  literal_live <- get("snapshot", envir = latest_full_capture, inherits = FALSE)
  assert_identical(literal_live, expected_frame, "live R Formula changed native values or frame metadata")
  if (is.double(expected) && !inherits(expected, "integer64")) {
    present <- !is.na(expected)
    assert_identical(writeBin(literal_live$result[present], raw(), size = 8L, endian = "little"),
      writeBin(expected[present], raw(), size = 8L, endian = "little"), "live R Formula changed exact finite scalar bits")
  }
  expected_page <- jsonlite::fromJSON(
    openwrangler_r_frame_contract$encode_page(
      openwrangler_r_frame_contract$capture_frame(expected_frame), row_limit = 3L, column_limit = 2L
    ),
    simplifyVector = FALSE
  )
  expected_cells <- lapply(expected_page$page$rows, `[[`, "values")
  assert_identical(lapply(literal_preview$page$page$rows, `[[`, "values"), expected_cells,
    "R Formula changed exact literal cells")
  assert_identical(
    literal_preview$page$schema[[2L]]$rawType,
    if (inherits(expected, "integer64")) "integer64" else typeof(expected),
    "R Formula changed its native scalar type"
  )
  generated_environment <- new.env(parent = baseenv())
  generated_environment$formula_literal_frame <- source_environment$formula_literal_frame
  eval(parse(text = literal_preview$code), envir = generated_environment)
  assert_identical(generated_environment$open_wrangler_result$result, expected, "generated R Formula changed an exact literal")
  if (isTRUE(literal$compiled)) {
    compiled <- compiler::cmpfun(eval(parse(text = paste(
      "function(formula_literal_frame) {", literal_preview$code,
      "list(result = open_wrangler_result, source = formula_literal_frame) }"
    )), envir = baseenv()))
    result <- compiled(unserialize(formula_literal_before))
    assert_identical(result$result, generated_environment$open_wrangler_result,
      "compiled generated R Formula changed its complete result")
    assert_identical(serialize(result$source, NULL, version = 3L), formula_literal_before,
      "compiled generated R Formula mutated its source")
  }
  assert_identical(
    serialize(generated_environment$formula_literal_frame, NULL, version = 3L),
    formula_literal_before, "generated R Formula mutated its source"
  )
  literal_applied <- dispatch("applyDraft", list(sessionId = formula_literal_session, revision = 1L, page = page_window()))
  assert_identical(literal_applied$action, "apply", "the exact R Formula draft did not apply")
  assert_identical(lapply(literal_applied$page$page$rows, `[[`, "values"), expected_cells,
    "applying R Formula changed the exact literal cells")
  if (identical(literal$value, "1152921504606846976")) {
    for (invalid_literal in list(
      "-0", "+2", "02", "2\n", " 2", "2.5", "1e2", "Infinity",
      paste(rep("9", 309L), collapse = ""), paste(rep("1", 310L), collapse = ""),
      "9007199254740993", "1152921504606847000", "1267650600228229401496703205377",
      "1267650600228229401522626226666", "-1267650600228229401522626226666",
      paste0(substr(formula_max_integer_text, 1L, nchar(formula_max_integer_text) - 1L), "7"),
      TRUE, Inf, NaN, list(2)
    )) {
      rejected <- dispatch("previewStep", list(
        sessionId = formula_literal_session, revision = 2L,
        step = formula_step("formula-rejected", "add", "rejected", value = invalid_literal), page = page_window()
      ))
      assert_identical(rejected$kind, "error", "R Formula accepted invalid or inexact integer text")
      assert_identical(rejected$code, "invalid_request", "R Formula integer text returned the wrong refusal")
      if (is.character(invalid_literal) && invalid_literal %in% c("9007199254740993", "1152921504606847000", "1267650600228229401496703205377",
        "1267650600228229401522626226666", "-1267650600228229401522626226666",
        paste0(substr(formula_max_integer_text, 1L, nchar(formula_max_integer_text) - 1L), "7"))) {
        assert_identical(
          grepl("represented exactly", rejected$message, fixed = TRUE), TRUE,
          "R Formula omitted its precision diagnostic"
        )
      }
    }
    literal_retained <- dispatch("getPage", list(sessionId = formula_literal_session, page = page_window()))
    assert_identical(literal_retained$kind, "page", "R Formula lost the committed page after rejecting integer text")
    assert_identical(literal_retained$page, literal_applied$page, "rejecting integer text changed the committed result")
  }
  literal_inspection <- inspect_step(formula_literal_session, 2L, "formula-literal", page_window())
  assert_identical(literal_inspection$kind, "stepInspection", "the retained R Formula literal did not replay")
  eval(parse(text = literal_inspection$code), envir = generated_environment)
  assert_identical(generated_environment$open_wrangler_result$result, expected, "replayed R Formula literal code changed")
  assert_identical(
    serialize(source_environment$formula_literal_frame, NULL, version = 3L),
    formula_literal_before,
    "R Formula literal requests mutated their source"
  )
  dispatch("closeSession", list(sessionId = formula_literal_session))
}

# Public numeric tokens, live comparisons and complete programs share native values.
numeric_filter_environment <- new.env(parent = baseenv())
numeric_filter_environment$frame <- data.frame(value = c(0.5, 0x1.1ccf385ebc89cp+1023,
  0x1.1ccf385ebc89dp+1023, 0x1.1ccf385ebc8a0p+1023, -abs(0), 0,
  -0x0.0000000000001p-1022, NA_real_, NaN, Inf, -Inf), ordinal = 1L:11L)
temporal_filter_values <- c(0x1.0c6f7a0b5ed8dp-20, 0x1.0c6f7a0b5ed8ep-20, 0.5, rep(NA_real_, 8L))
numeric_filter_environment$frame$instant <- structure(temporal_filter_values, class = c("POSIXct", "POSIXt"), tzone = "Europe/Berlin")
numeric_filter_environment$frame$elapsed <- structure(temporal_filter_values, class = "difftime", units = "hours")
numeric_filter_before <- serialize(numeric_filter_environment$frame, NULL, version = 3L)
numeric_filter_agent <- openwrangler_r_kernel_agent$new_agent(instrumented_frame_contract, numeric_filter_environment)
numeric_filter_session <- "83838383-8383-4383-8383-838383838383"
numeric_filter_window <- page_window(row_limit = 11L)
numeric_filter_open <- dispatch_with(numeric_filter_agent, "openSession", list(
  sessionId = numeric_filter_session, variableName = "frame", page = numeric_filter_window))
numeric_filter_values <- dispatch_with(numeric_filter_agent, "getColumnValues", list(
  sessionId = numeric_filter_session, column = list(id = "r:c:0", name = "value"),
  view = numeric_filter_window$view, search = NULL, limit = 100L))
numeric_filter_tokens <- lapply(numeric_filter_values$values, `[[`, "selectionValue")
numeric_filter_token_values <- vapply(numeric_filter_tokens, function(token) {
  if (identical(token$cell$kind, "infinity")) token$cell$sign * Inf else token$cell$raw
}, double(1L))
assert_identical(sort(numeric_filter_token_values), sort(unique(numeric_filter_environment$frame$value[!is.na(numeric_filter_environment$frame$value)])),
  "public floating picker tokens changed a native source value")
numeric_filter_cases <- list(
  list(operator = "equals", value = numeric_filter_environment$frame$value[[2L]], rows = 2L),
  list(operator = "lt", value = numeric_filter_environment$frame$value[[3L]], rows = c(1L, 2L, 5L, 6L, 7L, 11L)),
  list(operator = "gt", value = numeric_filter_environment$frame$value[[2L]], rows = c(3L, 4L, 10L)),
  list(operator = "between", value = numeric_filter_environment$frame$value[[2L]], secondValue = numeric_filter_environment$frame$value[[3L]], rows = 2L:3L),
  list(operator = "equals", value = numeric_filter_tokens[[which(numeric_filter_token_values == Inf)]], rows = 10L),
  list(operator = "values", rows = c(2L, 5L, 6L, 7L, 8L, 9L, 10L, 11L))
)
for (temporal_filter_column in 3L:4L) {
  temporal_filter_type <- if (temporal_filter_column == 3L) "datetime" else "duration"
  temporal_filter_values <- dispatch_with(numeric_filter_agent, "getColumnValues", list(sessionId = numeric_filter_session,
    column = list(id = paste0("r:c:", temporal_filter_column - 1L), name = names(numeric_filter_environment$frame)[[temporal_filter_column]]),
    view = numeric_filter_window$view, search = NULL, limit = 100L))
  temporal_filter_tokens <- lapply(temporal_filter_values$values, `[[`, "selectionValue")
  temporal_filter_tokens <- temporal_filter_tokens[match(c("9.9999999999999995e-07", "1.0000000000000002e-06"),
    vapply(temporal_filter_tokens, function(token) token$cell$raw, character(1L)))]
  for (index in 1L:2L) assert_identical(temporal_filter_tokens[[index]]$cell,
    numeric_filter_open$page$page$rows[[index]]$values[[temporal_filter_column]], "a temporal picker changed the exact wire cell")
  temporal_filter_cases <- list(
    list(operator = "values", selectedValues = list(temporal_filter_tokens[[1L]]), includeNulls = temporal_filter_column == 4L,
      rows = if (temporal_filter_column == 4L) c(1L, 4L:11L) else 1L),
    list(operator = "equals", value = temporal_filter_tokens[[1L]], rows = 1L),
    list(operator = if (temporal_filter_column == 3L) "lt" else "gt",
      value = temporal_filter_tokens[[if (temporal_filter_column == 3L) 2L else 1L]],
      rows = if (temporal_filter_column == 3L) 1L else 2L:3L),
    list(operator = "equals", value = if (temporal_filter_column == 3L) "1970-01-01T01:00:00.000001" else "0.0036", rows = 1L)
  )
  for (case in temporal_filter_cases) {
    case$column <- temporal_filter_column; case$type <- temporal_filter_type
    numeric_filter_cases[[length(numeric_filter_cases) + 1L]] <- case
  }
}
numeric_filter_revision <- 0L
for (numeric_filter_case in numeric_filter_cases) {
  numeric_filter_column <- if (is.null(numeric_filter_case$column)) 1L else numeric_filter_case$column
  numeric_filter_model <- list(column = list(id = paste0("r:c:", numeric_filter_column - 1L),
    name = names(numeric_filter_environment$frame)[[numeric_filter_column]]),
    type = if (is.null(numeric_filter_case$type)) "float" else numeric_filter_case$type, predicates = I(list()))
  if (identical(numeric_filter_case$operator, "values")) {
    numeric_filter_model$valueFilter <- if (is.null(numeric_filter_case$selectedValues)) list(kind = "values", selectedValues = I(numeric_filter_tokens[
      numeric_filter_token_values %in% c(numeric_filter_environment$frame$value[[2L]], 0, -0x0.0000000000001p-1022, Inf, -Inf)]),
      includeNulls = TRUE, includeNaN = TRUE) else list(kind = "values", selectedValues = I(numeric_filter_case$selectedValues),
      includeNulls = numeric_filter_case$includeNulls, includeNaN = FALSE)
  } else {
    numeric_filter_predicate <- numeric_filter_case[!names(numeric_filter_case) %in% c("rows", "column", "type")]
    numeric_filter_predicate$kind <- "predicate"
    numeric_filter_model$predicates <- I(list(numeric_filter_predicate))
  }
  numeric_filter_step <- list(id = "numeric-filter", kind = "filterRows", params = list(filterModel = list(
    logic = "and", filters = I(list(numeric_filter_model)), sort = I(list()))))
  latest_full_capture <<- NULL
  numeric_filter_preview <- dispatch_with(numeric_filter_agent, "previewStep", list(sessionId = numeric_filter_session,
    revision = numeric_filter_revision, step = numeric_filter_step, page = numeric_filter_window))
  assert_identical(numeric_filter_preview$kind, "stepPreview", "an exact numeric filter did not preview")
  numeric_filter_expected <- numeric_filter_environment$frame[numeric_filter_case$rows, , drop = FALSE]
  assert_identical(get("snapshot", envir = latest_full_capture, inherits = FALSE), numeric_filter_expected,
    "live numeric filtering changed exact values, missing kinds or row order")
  assert_identical(numeric_filter_preview$page$schema, numeric_filter_open$page$schema, "numeric filtering changed source schema")
  assert_identical(vapply(numeric_filter_preview$page$page$rows, `[[`, character(1L), "id"), paste0("r:r:", numeric_filter_case$rows - 1L),
    "numeric filtering changed retained source identities")
  numeric_filter_generated <- new.env(parent = baseenv()); numeric_filter_generated$frame <- unserialize(numeric_filter_before)
  eval(parse(text = numeric_filter_preview$code), envir = numeric_filter_generated)
  assert_identical(serialize(numeric_filter_generated$open_wrangler_result, NULL, version = 3L), serialize(numeric_filter_expected, NULL, version = 3L),
    "complete generated filtering disagreed with exact native values")
  assert_identical(serialize(numeric_filter_generated$frame, NULL, version = 3L), numeric_filter_before, "generated numeric filtering mutated its source")
  if (!is.null(numeric_filter_case$column)) {
    numeric_filter_compiled <- compiler::cmpfun(eval(parse(text = paste("function(frame) {", numeric_filter_preview$code,
      "open_wrangler_result\n}", sep = "\n")), envir = new.env(parent = baseenv())))
    assert_identical(serialize(numeric_filter_compiled(unserialize(numeric_filter_before)), NULL, version = 3L),
      serialize(numeric_filter_expected, NULL, version = 3L), "compiled temporal filtering changed exact values or metadata")
    if (numeric_filter_column == 4L && identical(numeric_filter_case$operator, "values")) {
      attr(numeric_filter_generated$frame$elapsed, "units") <- "secs"
      numeric_filter_stale_before <- serialize(numeric_filter_generated$frame, NULL, version = 3L)
      numeric_filter_stale <- tryCatch({ eval(parse(text = numeric_filter_preview$code), envir = numeric_filter_generated); NULL }, error = identity)
      assert_identical(inherits(numeric_filter_stale, "error") && grepl("duration units are stale", conditionMessage(numeric_filter_stale), fixed = TRUE),
        TRUE, "generated temporal filtering accepted stale duration units")
      assert_identical(serialize(numeric_filter_generated$frame, NULL, version = 3L), numeric_filter_stale_before,
        "refusing stale duration units changed the rebound source")
    }
  }
  numeric_filter_generated$frame <- numeric_filter_environment$frame[integer(), , drop = FALSE]
  eval(parse(text = numeric_filter_preview$code), envir = numeric_filter_generated)
  assert_identical(numeric_filter_generated$open_wrangler_result, numeric_filter_generated$frame, "generated numeric filtering changed an empty rebound source")
  numeric_filter_discard <- dispatch_with(numeric_filter_agent, "discardDraft", list(sessionId = numeric_filter_session,
    revision = numeric_filter_preview$revision, page = numeric_filter_window))
  assert_identical(numeric_filter_discard$page, numeric_filter_open$page, "discarding a numeric filter did not restore its source view")
  numeric_filter_revision <- numeric_filter_discard$revision
}
assert_identical(serialize(numeric_filter_environment$frame, NULL, version = 3L), numeric_filter_before, "native numeric filtering mutated its source")
invisible(dispatch_with(numeric_filter_agent, "closeSession", list(sessionId = numeric_filter_session)))
numeric_filter_agent$dispose()

local({
  parse_number <- get("parse_finite_number", environment(openwrangler_r_frame_contract$materialize_summaries), inherits = FALSE)
for (case in list(
  c("+0", "0000000000000000"), c("-0", "0000000000000080"), c("+1", "000000000000f03f"),
  c(".5", "000000000000e03f"), c("1.", "000000000000f03f"), c("0001.250", "000000000000f43f"),
  c("-000.5", "000000000000e0bf"), c("+0001.250e+2", "0000000000405f40"),
  c("4.9406564584124654e-324", "0100000000000000"), c("-4.9406564584124654e-324", "0100000000000080"),
  c("1.7976931348623157e308", "ffffffffffffef7f"), c("1e308", "a0c8eb85f3cce17f"),
  c("9223372036854775807", "000000000000e043"), c("-1e-9999", "0000000000000080"),
  c(".000", "0000000000000000"), c("01.e+03", "0000000000408f40")
)) {
  parsed <- parse_number(case[[1L]], "decimal control")
  assert_identical(paste(format(writeBin(parsed, raw(), size = 8L, endian = "little")), collapse = ""), case[[2L]],
    paste("decimal parsing changed the exact double for", case[[1L]]))
}
})

dst_frame <- data.frame(
  instant = as.POSIXct(c("2026-03-28 12:00:00", NA), tz = "Europe/Berlin")
)
dst_error <- tryCatch(
  {
    openwrangler_r_frame_contract$fill_missing_column_at(
      dst_frame,
      1L,
      "instant",
      list(kind = "datetime", value = "2026-03-29T02:30:00")
    )
    NULL
  },
  error = identity
)
# Native parsers may reject the gap directly or normalize it before the wall-time check.
if (
  !inherits(dst_error, "openwrangler_r_frame_error") ||
    !identical(dst_error$code, "invalid-view-value") ||
    !conditionMessage(dst_error) %in% c(
      "replacement$value is not a valid datetime",
      "replacement$value is not a valid local datetime in Europe/Berlin"
    )
) {
  stop(sprintf(
    "Expected an invalid-view-value DST datetime refusal; actual: %s",
    if (is.null(dst_error)) "<no error>" else substr(conditionMessage(dst_error), 1L, 256L)
  ), call. = FALSE)
}

# The datetime parser retains its mixed-plan and rebound-timezone controls.
local({
  source_environment$fill_frame <- data.frame(
    amount = c(1L, NA_integer_, 3L),
    label = ordered(c("high", NA, "low"), levels = c("low", "high")),
    instant = as.POSIXct(c("2026-03-28 12:00:00", NA, "2026-03-30 12:00:00"), tz = "UTC"),
    row.names = c("fill-a", "fill-b", "fill-c")
  )
  fill_source_before <- unserialize(serialize(source_environment$fill_frame, NULL, version = 3L))
  opened <- dispatch("openSession", list(sessionId = fill_session_id, variableName = "fill_frame", page = page_window()))
  assert_identical(opened$kind, "page", "the datetime Fill source did not open")
  revision <- 0L
  for (step in list(fill_step("fill-amount", "r:c:0", "amount", list(kind = "median")),
                    fill_step("fill-label", "r:c:1", "label", list(kind = "string", value = "unknown")))) {
    preview <- dispatch("previewStep", list(sessionId = fill_session_id, revision = revision, step = step, page = page_window()))
    assert_identical(preview$kind, "stepPreview", "the datetime Fill prefix did not preview")
    applied <- dispatch("applyDraft", list(sessionId = fill_session_id, revision = preview$revision, page = page_window()))
    assert_identical(applied$action, "apply", "the datetime Fill prefix did not apply")
    revision <- applied$revision
  }
fill_datetime_preview <- dispatch(
  "previewStep",
  list(
    sessionId = fill_session_id,
    revision = 4L,
    step = fill_step(
      "fill-datetime",
      "r:c:2",
      "instant",
      list(kind = "datetime", value = "2026-03-29T02:30:00")
    ),
    page = page_window()
  )
)
assert_identical(fill_datetime_preview$kind, "stepPreview", "R datetime Fill Missing Values did not preview in UTC")
fill_datetime_environment <- new.env(parent = baseenv())
fill_datetime_environment$fill_frame <- fill_source_before
eval(parse(text = fill_datetime_preview$code), envir = fill_datetime_environment)
assert_identical(
  fill_datetime_environment$open_wrangler_result,
  get("snapshot", envir = latest_full_capture, inherits = FALSE),
  "generated scalar datetime fill lost its parser dependency or diverged from live"
)
assert_identical(fill_datetime_environment$fill_frame, fill_source_before, "generated datetime fill mutated its source")
fill_datetime_compiled <- compiler::cmpfun(eval(parse(text = paste("function(fill_frame) {", fill_datetime_preview$code,
  "open_wrangler_result\n}", sep = "\n")), envir = new.env(parent = baseenv())))
assert_identical(fill_datetime_compiled(fill_source_before), get("snapshot", envir = latest_full_capture, inherits = FALSE),
  "compiled datetime Fill changed the native parsed instant or frame metadata")
assert_identical(fill_datetime_environment$fill_frame, fill_source_before, "compiled datetime Fill mutated its source")
generated_dst_source <- fill_source_before
attr(generated_dst_source$instant, "tzone") <- "Europe/Berlin"
assign("fill_frame", generated_dst_source, envir = .GlobalEnv)
generated_dst_error <- tryCatch(
  {
    eval(parse(text = fill_datetime_preview$code), envir = .GlobalEnv)
    NULL
  },
  error = function(error) error
)
if (
  !inherits(generated_dst_error, "error") ||
    !conditionMessage(generated_dst_error) %in% c(
      "Open Wrangler expected a valid ISO datetime",
      "Open Wrangler received an invalid local datetime in Europe/Berlin"
    )
) {
  stop(sprintf(
    "generated R Fill Missing Values reused a stale timezone or normalized a DST gap; actual: %s",
    if (is.null(generated_dst_error)) "<no error>" else substr(conditionMessage(generated_dst_error), 1L, 256L)
  ), call. = FALSE)
}
assert_identical(
  get("fill_frame", envir = .GlobalEnv, inherits = FALSE),
  generated_dst_source,
  "the generated R datetime guard mutated its source"
)
rm("fill_frame", envir = .GlobalEnv)
if (exists("open_wrangler_result", envir = .GlobalEnv, inherits = FALSE)) {
  rm("open_wrangler_result", envir = .GlobalEnv)
}
fill_datetime_discard <- dispatch(
  "discardDraft",
  list(sessionId = fill_session_id, revision = 5L, page = page_window())
)
assert_identical(fill_datetime_discard$action, "discard", "R datetime fill draft did not discard")
  assert_identical(source_environment$fill_frame, fill_source_before, "datetime Fill mutated its source")
  closed <- dispatch("closeSession", list(sessionId = fill_session_id))
  assert_identical(closed$kind, "closed", "the datetime Fill session did not close")
})

# Precise By Example retains native, emitted and byte-compiled results.
local({
  source_environment$by_example_adversarial <- as.data.frame(setNames(
    replicate(17L, c("alpha", "beta"), simplify = FALSE), sprintf("source_%02d", seq_len(17L))),
    optional = TRUE, stringsAsFactors = FALSE)
  by_example_adversarial_before <- unserialize(serialize(source_environment$by_example_adversarial, NULL, version = 3L))
  by_example_adversarial_session <- "a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7"
  opened <- dispatch("openSession", list(sessionId = by_example_adversarial_session,
    variableName = "by_example_adversarial", page = page_window()))
  assert_identical(opened$kind, "page", "the precise By Example source did not open")
  adversarial_revision <- 0L
for (precise_text in c("1.2345678901234567", "1e-100", "0.5")) {
  precise_value <- jsonlite::fromJSON(precise_text)
  precise_step <- adversarial_valid_step("by-example-precise-double", "precise double")
  precise_step$params$examples <- I(list(
    list(inputs = I(list("alpha")), output = precise_value),
    list(inputs = I(list("beta")), output = precise_value)
  ))
  precise_preview <- dispatch(
    "previewStep",
    list(
      sessionId = by_example_adversarial_session,
      revision = adversarial_revision,
      step = precise_step,
      page = page_window()
    )
  )
  assert_identical(precise_preview$kind, "stepPreview", "the precise-double by-example did not preview")
  assert_identical(
    precise_preview$retainedStep$params$examples[[1L]]$output,
    precise_value,
    "protocol v14 changed a retained by-example double"
  )
  live <- get("snapshot", envir = latest_full_capture, inherits = FALSE)
  assert_identical(live$`precise double`, rep(precise_value, 2L), "live R changed a by-example double")
  generated_environment <- new.env(parent = baseenv())
  generated_environment$by_example_adversarial <- by_example_adversarial_before
  eval(parse(text = precise_preview$code), envir = generated_environment)
  assert_identical(generated_environment$open_wrangler_result, live,
    "generated R changed the complete by-example double result")
  compiled <- compiler::cmpfun(eval(parse(text = paste(
    "function(by_example_adversarial) {", precise_preview$code,
    "list(result = open_wrangler_result, source = by_example_adversarial) }"
  )), envir = baseenv()))
  result <- compiled(by_example_adversarial_before)
  assert_identical(result$result, live, "compiled generated R changed the complete by-example double result")
  for (source in list(generated_environment$by_example_adversarial, result$source,
                      source_environment$by_example_adversarial)) {
    assert_identical(serialize(source, NULL, version = 3L), serialize(by_example_adversarial_before, NULL, version = 3L),
      "R by-example double execution mutated its source")
  }
  precise_discard <- dispatch(
    "discardDraft",
    list(sessionId = by_example_adversarial_session, revision = precise_preview$revision, page = page_window())
  )
  adversarial_revision <- precise_discard$revision
}
  closed <- dispatch("closeSession", list(sessionId = by_example_adversarial_session))
  assert_identical(closed$kind, "closed", "the precise By Example session did not close")
})
