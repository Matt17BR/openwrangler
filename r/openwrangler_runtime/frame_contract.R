openwrangler_r_frame_contract <- local({
  contract_version <- 5L
  maximum_rows <- .Machine$integer.max
  maximum_columns <- 2048L
  maximum_page_rows <- 1000L
  maximum_page_columns <- 256L
  maximum_page_cells <- 100000L
  maximum_filters <- 64L
  maximum_predicates_per_filter <- 64L
  maximum_selected_values_per_filter <- 10000L
  maximum_sort_rules <- 64L
  maximum_fill_fallback_columns <- 64L
  maximum_fill_directional_gap <- 1000000L
  maximum_profile_columns <- 64L
  maximum_profile_sample_rows <- 100000L
  maximum_profile_chunk_rows <- 65536L
  maximum_dataset_duplicate_sample_rows <- 100000L
  maximum_dataset_duplicate_sample_cells <- 5000000L
  maximum_column_value_distinct_matches <- maximum_selected_values_per_filter
  maximum_column_value_distinct_key_bytes <- 16L * 1024L * 1024L
  maximum_top_values <- 10L
  maximum_histogram_bins <- 20L
  maximum_cached_sort_columns <- 4L
  maximum_sort_cache_bytes <- 32L * 1024L * 1024L
  maximum_factor_levels <- 100000L
  maximum_text_bytes <- 8192L
  maximum_operation_output_bytes <- 64L * 1024L * 1024L
  maximum_operation_output_chunk_rows <- 1024L
  character_vector_slot_bytes <- 8L
  default_strip_characters <- paste0(
    " \t\n\r\v\f",
    "\u001c\u001d\u001e\u001f",
    "\u0085\u00a0\u1680",
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a",
    "\u2028\u2029\u202f\u205f\u3000"
  )
  maximum_name_bytes <- 1024L
  maximum_step_id_bytes <- 1024L
  maximum_column_id_bytes <- 2048L
  maximum_payload_bytes <- 16L * 1024L * 1024L
  private_row_id_prefix <- "__open_wrangler_internal_row_id_"
  metadata_base_bytes <- 1024L
  column_fixed_bytes <- 512L
  page_base_bytes <- 1024L
  row_fixed_bytes <- 96L
  cell_fixed_bytes <- 96L
  summary_fixed_bytes <- 1024L
  minimum_nanoparquet_version <- "0.5.1"

  storage_length <- function(value) {
    length(unclass(value))
  }

  plain_metadata_storage <- function(value) {
    result <- unclass(value)
    attributes(result) <- NULL
    result
  }

  integer64_formula_bindings <- function() {
    if (!requireNamespace("bit64", quietly = TRUE)) {
      abort("missing-package", "bit64 is required for integer64 Formula")
    }
    namespace <- asNamespace("bit64")
    binding_names <- c(
      as_integer = "C_as_integer64_integer",
      as_double = "C_as_double_integer64",
      as_character = "C_as_character_integer64",
      is_na = "C_isna_integer64",
      add = "C_plus_integer64",
      subtract = "C_minus_integer64",
      multiply = "C_times_integer64_integer64",
      modulo = "C_mod_integer64"
    )
    parameter_counts <- c(
      as_integer = 2L,
      as_double = 2L,
      as_character = 2L,
      is_na = 2L,
      add = 3L,
      subtract = 3L,
      multiply = 3L,
      modulo = 3L
    )
    namespace_dlls <- getNamespaceInfo(namespace, "DLLs")
    namespace_routines <- getNamespaceInfo(namespace, "nativeRoutines")
    if (
      !is.list(namespace_dlls) || length(namespace_dlls) != 1L ||
        !is.list(namespace_routines) || length(namespace_routines) != 1L
    ) {
      abort("runtime-error", "bit64 has invalid integer64 Formula native registration metadata")
    }
    dll <- namespace_dlls[[1L]]
    routine_map <- namespace_routines[[1L]]
    dll_fields <- unclass(dll)
    if (
      !inherits(dll, "DLLInfo") || !identical(.subset2(dll_fields, "name"), "bit64") ||
        !identical(.subset2(dll_fields, "dynamicLookup"), FALSE) || !identical(.subset2(dll_fields, "forceSymbols"), TRUE) ||
        !is.character(routine_map) || is.null(names(routine_map))
    ) {
      abort("runtime-error", "bit64 has invalid integer64 Formula native registration metadata")
    }
    all_native_binding_names <- names(routine_map)
    registrations <- lapply(names(binding_names), function(key) {
      binding_name <- binding_names[[key]]
      native_name <- sub("^C_", "", binding_name)
      if (
        !exists(binding_name, envir = namespace, inherits = FALSE) ||
          bindingIsActive(binding_name, namespace) ||
          !bindingIsLocked(binding_name, namespace)
      ) {
        abort("runtime-error", "bit64 has unavailable or mutable integer64 Formula primitives")
      }
      registration <- get(binding_name, envir = namespace, inherits = FALSE)
      canonical_address <- tryCatch(
        getNativeSymbolInfo(native_name, PACKAGE = .subset2(dll_fields, "info"), withRegistrationInfo = FALSE),
        error = function(error) NULL
      )
      if (
        !identical(.subset2(routine_map, binding_name), native_name) ||
          !identical(class(registration), c("CallRoutine", "NativeSymbolInfo")) ||
          !identical(attr(registration, "names", exact = TRUE), c("name", "address", "dll", "numParameters")) ||
          !identical(.subset2(unclass(registration), "name"), native_name) ||
          !identical(.subset2(unclass(registration), "numParameters"), parameter_counts[[key]]) ||
          !inherits(.subset2(unclass(registration), "address"), "RegisteredNativeSymbol") ||
          !identical(.subset2(unclass(registration), "dll"), dll) ||
          is.null(canonical_address) ||
          !identical(class(canonical_address), c("CallRoutine", "NativeSymbolInfo")) ||
          !identical(.subset2(unclass(canonical_address), "name"), native_name) ||
          !identical(.subset2(unclass(canonical_address), "numParameters"), parameter_counts[[key]]) ||
          !identical(.subset2(unclass(canonical_address), "dll"), dll) ||
          !inherits(.subset2(unclass(canonical_address), "address"), "NativeSymbol")
      ) {
        abort("runtime-error", "bit64 has invalid integer64 Formula primitives")
      }
      for (other_binding_name in all_native_binding_names) {
        if (
          identical(other_binding_name, binding_name) ||
            !exists(other_binding_name, envir = namespace, inherits = FALSE) ||
            bindingIsActive(other_binding_name, namespace)
        ) {
          next
        }
        other_registration <- get(other_binding_name, envir = namespace, inherits = FALSE)
        if (
          is.list(other_registration) &&
            !is.null(.subset2(unclass(other_registration), "address")) &&
            identical(.subset2(unclass(registration), "address"), .subset2(unclass(other_registration), "address"))
        ) {
          abort("runtime-error", "bit64 has replaced integer64 Formula primitive addresses")
        }
      }
      canonical_address
    })
    names(registrations) <- names(binding_names)
    registrations
  }

  integer64_from_integer <- function(values, bindings) {
    result <- .Call(bindings$as_integer, values, double(storage_length(values)))
    value_names <- attr(values, "names", exact = TRUE)
    attributes(result) <- if (is.null(value_names)) {
      list(class = "integer64")
    } else {
      list(class = "integer64", names = value_names)
    }
    result
  }

  integer64_binary <- function(operator, left, right, bindings) {
    left <- if (inherits(left, "integer64")) left else integer64_from_integer(left, bindings)
    right <- if (inherits(right, "integer64")) right else integer64_from_integer(right, bindings)
    left_length <- storage_length(left)
    right_length <- storage_length(right)
    output_length <- if (left_length == 0L || right_length == 0L) 0L else max(left_length, right_length)
    result <- .Call(bindings[[operator]], left, right, double(output_length))
    output_names <- if (left_length == output_length && !is.null(attr(left, "names", exact = TRUE))) {
      attr(left, "names", exact = TRUE)
    } else if (right_length == output_length && !is.null(attr(right, "names", exact = TRUE))) {
      attr(right, "names", exact = TRUE)
    } else {
      NULL
    }
    attributes(result) <- if (is.null(output_names)) {
      list(class = "integer64")
    } else {
      list(class = "integer64", names = output_names)
    }
    result
  }

  integer64_as_double <- function(values, bindings) {
    result <- .Call(bindings$as_double, values, double(storage_length(values)))
    value_names <- attr(values, "names", exact = TRUE)
    if (!is.null(value_names)) attr(result, "names") <- value_names
    result
  }

  integer64_as_character <- function(values, bindings = NULL) {
    if (is.null(bindings)) bindings <- ensure_integer64_bindings()
    .Call(bindings$as_character, values, rep.int(NA_character_, storage_length(values)))
  }

  integer64_subset <- function(values, indices) {
    storage <- unclass(values)
    subset <- storage[indices]
    attributes(subset) <- list(class = "integer64")
    subset
  }

  integer64_missing <- function(bindings) {
    integer64_from_integer(NA_integer_, bindings)
  }

  integer64_force_missing <- function(values, missing, bindings) {
    storage <- unclass(values)
    storage[missing] <- unclass(integer64_missing(bindings))[[1L]]
    value_names <- attr(values, "names", exact = TRUE)
    attributes(storage) <- if (is.null(value_names)) {
      list(class = "integer64")
    } else {
      list(class = "integer64", names = value_names)
    }
    storage
  }

  ensure_integer64_bindings <- function() {
    bindings <- integer64_formula_bindings()
    if (storage_length(integer64_missing(bindings)) != 1L) {
      abort("runtime-error", "bit64 has an invalid integer64 missing value")
    }
    bindings
  }

  integer64_missing_mask <- function(values, bindings = NULL) {
    if (is.null(bindings)) bindings <- integer64_formula_bindings()
    .Call(bindings$is_na, values, logical(storage_length(values)))
  }

  data_table_alloccol_binding <- function() {
    if (!requireNamespace("data.table", quietly = TRUE)) {
      abort("missing-package", "data.table is required")
    }
    namespace <- asNamespace("data.table")
    binding_name <- "Calloccolwrapper"
    native_name <- "Calloccolwrapper"
    namespace_dlls <- getNamespaceInfo(namespace, "DLLs")
    namespace_routines <- getNamespaceInfo(namespace, "nativeRoutines")
    if (
      !is.list(namespace_dlls) || length(namespace_dlls) != 1L ||
        !is.list(namespace_routines) || length(namespace_routines) != 1L ||
        !exists(binding_name, envir = namespace, inherits = FALSE) ||
        bindingIsActive(binding_name, namespace) ||
        !bindingIsLocked(binding_name, namespace)
    ) {
      abort("runtime-error", "data.table has unavailable or mutable append primitives")
    }
    dll <- namespace_dlls[[1L]]
    routine_map <- namespace_routines[[1L]]
    binding <- get(binding_name, envir = namespace, inherits = FALSE)
    dll_fields <- unclass(dll)
    canonical <- tryCatch(
      getNativeSymbolInfo(native_name, PACKAGE = .subset2(dll_fields, "info"), withRegistrationInfo = FALSE),
      error = function(error) NULL
    )
    if (
      !inherits(dll, "DLLInfo") || !identical(.subset2(dll_fields, "name"), "data_table") ||
        !identical(.subset2(dll_fields, "dynamicLookup"), FALSE) ||
        !is.character(routine_map) || !identical(.subset2(routine_map, binding_name), native_name) ||
        !identical(class(binding), c("CallRoutine", "NativeSymbolInfo")) ||
        !identical(attr(binding, "names", exact = TRUE), c("name", "address", "dll", "numParameters")) ||
        !identical(.subset2(unclass(binding), "name"), native_name) || !identical(.subset2(unclass(binding), "numParameters"), -1L) ||
        !identical(.subset2(unclass(binding), "dll"), dll) || !inherits(.subset2(unclass(binding), "address"), "RegisteredNativeSymbol") ||
        is.null(canonical) || !identical(.subset2(unclass(canonical), "name"), native_name) ||
        !identical(.subset2(unclass(canonical), "numParameters"), -1L) || !identical(.subset2(unclass(canonical), "dll"), dll) ||
        !inherits(.subset2(unclass(canonical), "address"), "NativeSymbol")
    ) {
      abort("runtime-error", "data.table has invalid append primitives")
    }
    canonical
  }

  repair_data_table_self_reference <- function(value) {
    .Call(data_table_alloccol_binding(), value, 1024L, FALSE)
  }

  abort <- function(code, message) {
    condition <- structure(
      list(message = message, call = NULL, code = code),
      class = c("openwrangler_r_frame_error", "error", "condition")
    )
    stop(condition)
  }

  json_array <- function(value) {
    I(unname(value))
  }

  new_payload_budget <- function(used = 0) {
    budget <- new.env(parent = emptyenv())
    budget$used <- as.double(used)
    budget
  }

  spend_payload_budget <- function(budget, bytes, label) {
    next_used <- budget$used + as.double(bytes)
    if (!is.finite(next_used) || next_used > maximum_payload_bytes) {
      abort("payload-too-large", sprintf("%s exceeds the %d-byte encoded payload budget", label, maximum_payload_bytes))
    }
    budget$used <- next_used
  }

  spend_operation_output_budget <- function(budget, bytes, label) {
    next_used <- budget$used + as.double(bytes)
    if (!is.finite(next_used) || next_used > maximum_operation_output_bytes) {
      abort(
        "operation-output-too-large",
        sprintf("%s exceeds the %d-byte R operation output budget", label, maximum_operation_output_bytes)
      )
    }
    budget$used <- next_used
  }

  json_string_bytes <- function(value) {
    bytes <- as.integer(charToRaw(value))
    html_slash <- logical(length(bytes))
    if (length(bytes) > 1L) {
      html_slash[-1L] <- bytes[-1L] == 47L & bytes[-length(bytes)] == 60L
    }
    escaped <- sum(ifelse(
      bytes %in% c(8L, 9L, 10L, 12L, 13L, 34L, 92L) | html_slash,
      2L,
      ifelse(bytes < 32L, 6L, 1L)
    ))
    as.double(escaped + 2L)
  }

  spend_json_string <- function(budget, value, label, copies = 1L) {
    spend_payload_budget(budget, json_string_bytes(value) * copies, label)
  }

  bounded_utf8 <- function(value, label, maximum_bytes = maximum_text_bytes) {
    if (typeof(value) != "character" || storage_length(value) != 1L) {
      abort("invalid-text", sprintf("%s must be one non-missing string", label))
    }
    value <- .subset2(value, 1L)
    if (is.na(value)) {
      abort("invalid-text", sprintf("%s must be one non-missing string", label))
    }
    encoding <- Encoding(value)
    if (identical(encoding, "bytes")) {
      abort("invalid-text", sprintf("%s uses the bytes encoding", label))
    }
    source_encoding <- if (identical(encoding, "latin1")) "latin1" else "UTF-8"
    converted <- iconv(value, from = source_encoding, to = "UTF-8", sub = NA_character_)
    if (is.na(converted)) {
      abort("invalid-text", sprintf("%s is not valid UTF-8", label))
    }
    if (nchar(converted, type = "bytes") > maximum_bytes) {
      abort("text-too-large", sprintf("%s exceeds %d UTF-8 bytes", label, maximum_bytes))
    }
    converted
  }

  bounded_operation_output <- function(value, operation_name) {
    if (!is.character(value) || length(value) != 1L || is.na(value)) {
      abort("internal-error", sprintf("%s returned an invalid R text result", operation_name))
    }
    encoding <- Encoding(value)
    if (identical(encoding, "bytes")) {
      abort("invalid-view-query", sprintf("%s produced invalid UTF-8 text", operation_name))
    }
    source_encoding <- if (identical(encoding, "latin1")) "latin1" else "UTF-8"
    converted <- iconv(value, from = source_encoding, to = "UTF-8", sub = NA_character_)
    if (is.na(converted)) {
      abort("invalid-view-query", sprintf("%s produced invalid UTF-8 text", operation_name))
    }
    if (nchar(converted, type = "bytes") > maximum_text_bytes) {
      abort(
        "operation-output-too-large",
        sprintf("%s would produce text longer than %d UTF-8 bytes", operation_name, maximum_text_bytes)
      )
    }
    converted
  }

  is_canonical_column_id <- function(value) {
    source_match <- regexec("^r:c:(0|[1-9][0-9]*)$", value, perl = TRUE)
    source_parts <- regmatches(value, source_match)[[1L]]
    if (length(source_parts) != 0L) {
      ordinal <- suppressWarnings(as.double(source_parts[[2L]]))
      return(is.finite(ordinal) && ordinal < maximum_columns)
    }

    derived_match <- regexec(
      "^c:step:([^\\x00]+):(0|[1-9][0-9]*)$",
      value,
      perl = TRUE
    )
    derived_parts <- regmatches(value, derived_match)[[1L]]
    if (length(derived_parts) == 0L) return(FALSE)
    ordinal <- suppressWarnings(as.double(derived_parts[[3L]]))
    nchar(derived_parts[[2L]], type = "bytes") <= maximum_step_id_bytes &&
      is.finite(ordinal) &&
      ordinal < maximum_columns
  }

  bounded_text_array <- function(values, label, maximum_bytes = maximum_text_bytes, budget = NULL) {
    if (typeof(values) != "character") {
      abort("invalid-text", sprintf("%s must be a character vector", label))
    }
    converted <- vapply(seq_len(storage_length(values)), function(index) {
      item_label <- sprintf("%s[%d]", label, index)
      item <- bounded_utf8(.subset2(values, index), item_label, maximum_bytes)
      if (!is.null(budget)) {
        spend_json_string(budget, item, item_label)
        spend_payload_budget(budget, 1L, label)
      }
      item
    }, character(1L), USE.NAMES = FALSE)
    json_array(converted)
  }

  without_values <- function(values, removed) {
    matched <- base::match(values, removed, nomatch = 0L)
    .subset(values, base::which(matched == 0L))
  }

  anyDuplicated <- function(value) {
    base::anyDuplicated.default(value)
  }

  assert_attributes <- function(column, allowed, label) {
    attribute_names <- names(attributes(column)) %||% character()
    if (anyNA(attribute_names) || any(attribute_names == "") || anyDuplicated(attribute_names)) {
      abort("unsupported-column-attributes", sprintf("%s has malformed attribute names", label))
    }
    if ("names" %in% attribute_names) {
      column_names <- attr(column, "names", exact = TRUE)
      if (
        !is.character(column_names) ||
          is.object(column_names) ||
          !is.null(attributes(column_names)) ||
          length(column_names) != storage_length(column)
      ) {
        abort("unsupported-column-attributes", sprintf("%s has a malformed names attribute", label))
      }
      attribute_names <- without_values(attribute_names, "names")
    }
    extras <- without_values(attribute_names, allowed)
    if (length(extras) != 0L) {
      abort(
        "unsupported-column-attributes",
        sprintf("%s has unsupported attributes: %s", label, paste(extras, collapse = ", "))
      )
    }
  }

  `%||%` <- function(value, fallback) {
    if (is.null(value)) fallback else value
  }

  assert_frame_attributes <- function(value, flavor) {
    allowed <- c("names", "row.names", "class")
    if (flavor == "r.data.table") {
      allowed <- c(allowed, ".internal.selfref", "sorted")
    }
    attribute_names <- names(attributes(value)) %||% character()
    if (anyNA(attribute_names) || any(attribute_names == "") || anyDuplicated(attribute_names)) {
      abort("unsupported-frame-attributes", "the dataframe has malformed attribute names")
    }
    extras <- without_values(attribute_names, allowed)
    if (length(extras) != 0L) {
      abort(
        "unsupported-frame-attributes",
        sprintf("the dataframe has unsupported attributes: %s", paste(extras, collapse = ", "))
      )
    }
    if (flavor == "r.data.table") {
      self_reference <- attr(value, ".internal.selfref", exact = TRUE)
      if (!is.null(self_reference) && typeof(self_reference) != "externalptr") {
        abort("unsupported-frame-attributes", "the data.table has an invalid internal self-reference")
      }
      sorted <- attr(value, "sorted", exact = TRUE)
      if (!is.null(sorted)) {
        if (typeof(sorted) != "character") {
          abort("unsupported-frame-attributes", "the data.table has invalid key metadata")
        }
        sorted <- plain_metadata_storage(sorted)
        if (anyNA(sorted) || any(sorted == "") || anyDuplicated(sorted)) {
          abort("unsupported-frame-attributes", "the data.table has invalid key metadata")
        }
      }
    }
  }

  data_table_key_names <- function(value) {
    keys <- attr(value, "sorted", exact = TRUE)
    if (is.null(keys)) character() else plain_metadata_storage(keys)
  }

  whole_number <- function(value, label, maximum) {
    if (
      length(value) != 1L ||
        !is.numeric(value) ||
        is.na(value) ||
        !is.finite(value) ||
        value < 0 ||
        value > maximum ||
        value != floor(value)
    ) {
      abort("invalid-range", sprintf("%s must be a whole number from 0 through %s", label, format(maximum)))
    }
    as.double(value)
  }

  signed_whole_number <- function(value, label, maximum) {
    if (
      length(value) != 1L ||
        !is.numeric(value) ||
        is.na(value) ||
        !is.finite(value) ||
        abs(value) > maximum ||
        value != floor(value)
    ) {
      abort("invalid-view-query", sprintf("%s is outside its supported range", label))
    }
    as.double(value)
  }

  exact_double <- function(value) {
    sprintf("%.17g", as.double(value))
  }

  canonical_double_key <- function(value) {
    numeric_value <- as.double(value)
    exact_double(if (!is.na(numeric_value) && numeric_value == 0) 0 else numeric_value)
  }

  display_double <- function(value) {
    base::format.default(value, digits = 15L, trim = TRUE, scientific = FALSE, decimal.mark = ".")
  }

  indexed_value_label <- function(label, index, count) {
    if (count == 1L) label else sprintf("%s[%d]", label, index)
  }

  display_date_values <- function(values, label) {
    displays <- tryCatch(
      base::format.Date(values, format = "%Y-%m-%d"),
      error = function(error) NULL
    )
    value_count <- storage_length(values)
    invalid <- if (!is.character(displays) || length(displays) != value_count) {
      1L
    } else {
      which(is.na(displays) | !grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", displays))
    }
    if (length(invalid) != 0L) {
      abort(
        "unsupported-cell",
        sprintf(
          "%s is outside the supported ISO date range",
          indexed_value_label(label, invalid[[1L]], value_count)
        )
      )
    }
    unname(displays)
  }

  display_datetime_values <- function(values, timezone, label) {
    display_timezone <- timezone
    if (is.null(display_timezone) || identical(display_timezone, "")) display_timezone <- "UTC"
    displays <- tryCatch(
      base::format.POSIXct(
        values,
        tz = display_timezone,
        format = "%Y-%m-%dT%H:%M:%OS6",
        usetz = FALSE
      ),
      error = function(error) NULL
    )
    value_count <- storage_length(values)
    if (!is.character(displays) || length(displays) != value_count || anyNA(displays)) {
      invalid <- if (is.character(displays) && length(displays) == value_count && anyNA(displays)) {
        which(is.na(displays))[[1L]]
      } else {
        1L
      }
      abort(
        "unsupported-cell",
        sprintf(
          "%s is outside the supported datetime range",
          indexed_value_label(label, invalid, value_count)
        )
      )
    }
    vapply(seq_along(displays), function(index) {
      bounded_utf8(displays[[index]], indexed_value_label(label, index, value_count))
    }, character(1L), USE.NAMES = FALSE)
  }

  cell_missing <- function() {
    list(kind = "null", raw = NULL, display = "NA", isNull = TRUE, isNaN = FALSE)
  }

  cell_nan <- function() {
    list(kind = "nan", raw = NULL, display = "NaN", isNull = FALSE, isNaN = TRUE)
  }

  cell_infinity <- function(value) {
    list(
      kind = "infinity",
      raw = NULL,
      display = if (value < 0) "-Inf" else "Inf",
      isNull = FALSE,
      isNaN = FALSE,
      sign = if (value < 0) -1L else 1L
    )
  }

  ordinary_cell <- function(kind, raw, display) {
    list(kind = kind, raw = raw, display = display, isNull = FALSE, isNaN = FALSE)
  }

  column_semantics <- function(column, label, budget, validate_values = TRUE) {
    if (is.matrix(column) || is.array(column)) {
      abort("unsupported-column", sprintf("%s is a matrix or array column", label))
    }
    if (is.list(column)) {
      abort("unsupported-column", sprintf("%s is a list column", label))
    }
    if (is.raw(column) || is.complex(column)) {
      abort("unsupported-column", sprintf("%s uses an unsupported atomic type", label))
    }

    classes <- class(column)
    common <- function(kind, storage_mode, expected_classes) {
      if (!identical(classes, expected_classes)) {
        abort("unsupported-column-class", sprintf("%s has unsupported classes", label))
      }
      if (!identical(typeof(column), storage_mode)) {
        abort("unsupported-column-storage", sprintf("%s has storage incompatible with its classes", label))
      }
      list(
        kind = kind,
        storageMode = storage_mode,
        classes = bounded_text_array(classes, paste0(label, ".classes"), budget = budget)
      )
    }

    if (inherits(column, "integer64")) {
      ensure_integer64_bindings()
      assert_attributes(column, "class", label)
      return(common("integer64", "double", "integer64"))
    }
    if (inherits(column, "Date")) {
      assert_attributes(column, "class", label)
      return(common("date", "double", "Date"))
    }
    if (inherits(column, "POSIXct")) {
      assert_attributes(column, c("class", "tzone"), label)
      semantics <- common("datetime", "double", c("POSIXct", "POSIXt"))
      timezone <- attr(column, "tzone", exact = TRUE)
      if (!is.null(timezone)) {
        if (typeof(timezone) != "character" || storage_length(timezone) != 1L) {
          abort("unsupported-timezone", sprintf("%s has an unsupported tzone attribute", label))
        }
        timezone <- .subset2(timezone, 1L)
        if (is.na(timezone)) {
          abort("unsupported-timezone", sprintf("%s has an unsupported tzone attribute", label))
        }
        timezone <- bounded_utf8(timezone, paste0(label, ".timezone"), maximum_name_bytes)
        spend_json_string(budget, timezone, paste0(label, ".timezone"))
      }
      semantics["timezone"] <- list(timezone)
      return(semantics)
    }
    if (inherits(column, "difftime")) {
      assert_attributes(column, c("class", "units"), label)
      semantics <- common("difftime", "double", "difftime")
      units <- attr(column, "units", exact = TRUE)
      allowed_units <- c("secs", "mins", "hours", "days", "weeks")
      if (typeof(units) != "character" || storage_length(units) != 1L) {
        abort("unsupported-duration-units", sprintf("%s has unsupported difftime units", label))
      }
      units <- .subset2(units, 1L)
      if (is.na(units) || !units %in% allowed_units) {
        abort("unsupported-duration-units", sprintf("%s has unsupported difftime units", label))
      }
      spend_json_string(budget, units, paste0(label, ".units"))
      semantics$units <- units
      return(semantics)
    }
    if (is.factor(column)) {
      assert_attributes(column, c("levels", "class"), label)
      ordered <- is.ordered(column)
      expected_classes <- if (ordered) c("ordered", "factor") else "factor"
      semantics <- common("factor", "integer", expected_classes)
      levels <- plain_metadata_storage(attr(column, "levels", exact = TRUE))
      if (anyDuplicated(levels)) {
        abort("invalid-factor", sprintf("%s has duplicate factor levels", label))
      }
      if (length(levels) > maximum_factor_levels) {
        abort(
          "factor-levels-too-large",
          sprintf("%s has more than %d factor levels", label, maximum_factor_levels)
        )
      }
      semantics$levels <- bounded_text_array(levels, paste0(label, ".levels"), budget = budget)
      semantics$ordered <- ordered
      if (isTRUE(validate_values)) {
        codes <- unclass(column)
        if (any(!is.na(codes) & (codes < 1L | codes > length(levels)))) {
          abort("invalid-factor", sprintf("%s contains an invalid factor code", label))
        }
      }
      return(semantics)
    }
    if (is.logical(column)) {
      assert_attributes(column, character(), label)
      return(common("logical", "logical", "logical"))
    }
    if (is.integer(column)) {
      assert_attributes(column, character(), label)
      return(common("integer", "integer", "integer"))
    }
    if (is.double(column)) {
      assert_attributes(column, character(), label)
      return(common("double", "double", "numeric"))
    }
    if (is.character(column)) {
      assert_attributes(column, character(), label)
      return(common("character", "character", "character"))
    }
    abort("unsupported-column", sprintf("%s has an unsupported R type", label))
  }

  public_column_type <- function(kind) {
    switch(
      kind,
      logical = "boolean",
      integer = "integer",
      double = "float",
      character = "string",
      factor = "string",
      date = "date",
      datetime = "datetime",
      difftime = "duration",
      integer64 = "integer",
      abort("internal-error", "unknown R column kind")
    )
  }

  raw_column_type <- function(semantics) {
    switch(
      semantics$kind,
      logical = "logical",
      integer = "integer",
      double = "double",
      character = "character",
      factor = if (semantics$ordered) "ordered factor" else "factor",
      date = "Date",
      datetime = "POSIXct",
      difftime = "difftime",
      integer64 = "integer64",
      abort("internal-error", "unknown R column kind")
    )
  }

  column_has_missing <- function(column, semantics) {
    kind <- semantics$kind
    if (kind == "integer64") {
      return(any(integer64_missing_mask(column, ensure_integer64_bindings())))
    }
    if (kind %in% c("factor", "date", "datetime", "difftime")) {
      return(anyNA(unclass(column)))
    }
    anyNA(column)
  }

  encode_value <- function(column, semantics, index, label, budget, integer64_bindings = NULL) {
    spend_payload_budget(budget, cell_fixed_bytes, label)
    kind <- semantics$kind

    if (kind == "integer64") {
      if (is.null(integer64_bindings)) integer64_bindings <- ensure_integer64_bindings()
      value <- integer64_subset(column, index)
      if (integer64_missing_mask(value, integer64_bindings)[[1L]]) return(cell_missing())
      exact <- integer64_as_character(value, integer64_bindings)[[1L]]
      spend_json_string(budget, exact, label, copies = 2L)
      return(ordinary_cell("integer", exact, exact))
    }

    if (kind %in% c("date", "datetime", "difftime")) {
      numeric_value <- unclass(column)[[index]]
      if (is.nan(numeric_value)) {
        abort("unsupported-cell", sprintf("%s is a classed NaN", label))
      }
      if (is.na(numeric_value)) return(cell_missing())
      if (!is.finite(numeric_value)) {
        abort("unsupported-cell", sprintf("%s is not finite", label))
      }
      if (kind == "date" && numeric_value != floor(numeric_value)) {
        abort("unsupported-cell", sprintf("%s is a fractional Date", label))
      }
      value <- if (kind == "date") {
        structure(numeric_value, class = "Date")
      } else if (kind == "datetime") {
        timezone <- semantics$timezone
        attributes(numeric_value) <- if (is.null(timezone)) {
          list(class = c("POSIXct", "POSIXt"))
        } else {
          list(class = c("POSIXct", "POSIXt"), tzone = timezone)
        }
        numeric_value
      } else {
        structure(numeric_value, class = "difftime", units = semantics$units)
      }
    } else if (kind == "factor") {
      code <- unclass(column)[[index]]
      if (is.na(code)) return(cell_missing())
      factor_levels <- plain_metadata_storage(semantics$levels)
      if (code < 1L || code > length(factor_levels)) {
        abort("invalid-factor", sprintf("%s contains an invalid factor code", label))
      }
      text <- bounded_utf8(.subset2(factor_levels, code), label)
      spend_json_string(budget, text, label, copies = 2L)
      return(ordinary_cell("string", text, text))
    } else {
      value <- unname(column[index])
    }
    if (kind == "double" && is.nan(value)) return(cell_nan())
    # Temporal missingness was already decided from the unclassed scalar
    # above. Rechecking the reconstructed Date/POSIXct/difftime object through
    # is.na() would reopen caller-registered S3 dispatch while materializing a
    # preview page.
    if (!(kind %in% c("date", "datetime", "difftime")) && is.na(value)) return(cell_missing())
    if (kind == "double" && is.infinite(value)) return(cell_infinity(value))

    if (kind == "logical") {
      return(ordinary_cell("boolean", isTRUE(value), if (isTRUE(value)) "TRUE" else "FALSE"))
    }
    if (kind == "integer") {
      exact <- as.character(value)
      spend_json_string(budget, exact, label, copies = 2L)
      return(ordinary_cell("integer", exact, exact))
    }
    if (kind == "double") {
      exact <- exact_double(value)
      display <- display_double(value)
      spend_json_string(budget, exact, label)
      spend_json_string(budget, display, label)
      return(ordinary_cell("number", exact, display))
    }
    if (kind == "character") {
      text <- bounded_utf8(value, label)
      spend_json_string(budget, text, label, copies = 2L)
      return(ordinary_cell("string", text, text))
    }
    if (kind == "date") {
      text <- display_date_values(value, label)[[1L]]
      spend_json_string(budget, text, label, copies = 2L)
      return(ordinary_cell("date", text, text))
    }
    if (kind == "datetime") {
      exact <- exact_double(unclass(value))
      display <- display_datetime_values(value, semantics$timezone, label)[[1L]]
      spend_json_string(budget, exact, label)
      spend_json_string(budget, display, label)
      return(ordinary_cell("datetime", exact, display))
    }
    if (kind == "difftime") {
      exact <- exact_double(numeric_value)
      display <- paste(exact, semantics$units)
      spend_json_string(budget, exact, label)
      spend_json_string(budget, display, label)
      return(ordinary_cell("duration", exact, display))
    }
    abort("internal-error", "unknown R column kind")
  }

  frame_flavor <- function(value) {
    classes <- class(value)
    if (inherits(value, "grouped_df") || inherits(value, "rowwise_df")) {
      abort("unsupported-frame-class", "grouped and rowwise tibbles are not yet supported")
    }
    if (inherits(value, "data.table")) {
      if (!identical(classes, c("data.table", "data.frame"))) {
        abort("unsupported-frame-class", "the data.table has unsupported subclasses")
      }
      return("r.data.table")
    }
    if (inherits(value, "tbl_df")) {
      if (
        !identical(classes, c("tbl_df", "tbl", "data.frame")) &&
          !identical(classes, c("spec_tbl_df", "tbl_df", "tbl", "data.frame"))
      ) {
        abort("unsupported-frame-class", "the tibble has unsupported subclasses")
      }
      return("r.tibble")
    }
    if (identical(classes, "data.frame")) return("r.data.frame")
    abort("unsupported-frame-class", "the value must be a base data.frame, tibble, or data.table")
  }

  normalize_supported_frame <- function(value) {
    frame_flavor(value)
    if (identical(class(value), c("spec_tbl_df", "tbl_df", "tbl", "data.frame"))) {
      normalized <- value
      attr(normalized, "spec") <- NULL
      attr(normalized, "problems") <- NULL
      class(normalized) <- c("tbl_df", "tbl", "data.frame")
      return(normalized)
    }
    value
  }

  validate_frame_structure <- function(value) {
    row_names <- tryCatch(.row_names_info(value, type = 0L), error = function(error) error)
    if (inherits(row_names, "error") || (!is.integer(row_names) && !is.character(row_names))) {
      abort("unsupported-frame", "the dataframe has malformed row names")
    }
    row_names <- if (is.character(row_names)) {
      vapply(seq_along(row_names), function(index) .subset2(row_names, index), character(1L), USE.NAMES = FALSE)
    } else {
      vapply(seq_along(row_names), function(index) .subset2(row_names, index), integer(1L), USE.NAMES = FALSE)
    }
    compact <- is.integer(row_names) && length(row_names) == 2L && is.na(row_names[[1L]])
    if (compact) {
      if (is.na(row_names[[2L]]) || row_names[[2L]] == 0L) {
        abort("unsupported-frame", "the dataframe has malformed row names")
      }
      row_count <- abs(as.double(row_names[[2L]]))
    } else {
      row_count <- as.double(length(row_names))
      if (anyNA(row_names) || anyDuplicated(row_names)) {
        abort("unsupported-frame", "the dataframe has malformed row names")
      }
    }
    if (!is.finite(row_count) || row_count != floor(row_count) || row_count > maximum_rows) {
      abort("unsupported-frame", "the dataframe has malformed row names")
    }
    columns <- unclass(value)
    if (!is.list(columns) || length(columns) != storage_length(value)) {
      abort("unsupported-frame", "the dataframe has a malformed column payload")
    }
    for (index in seq_along(columns)) {
      # Matrix/array columns are rejected by the column contract below. Their
      # vector length includes every cell, so leave that established diagnostic
      # intact while rejecting malformed ordinary columns here.
      if (is.null(dim(columns[[index]])) && storage_length(columns[[index]]) != row_count) {
        abort(
          "unsupported-frame",
          sprintf("dataframe column %d does not match the row count", index)
        )
      }
    }
    invisible(row_count)
  }

  isolated_snapshot <- function(value, flavor) {
    if (flavor == "r.data.table") {
      if (!requireNamespace("data.table", quietly = TRUE)) {
        abort("missing-package", "data.table is required to copy a data.table")
      }
      return(data.table::copy(value))
    }
    unserialize(serialize(value, NULL, version = 3L))
  }

  key_column_ids <- function(snapshot, flavor, names, budget) {
    if (flavor != "r.data.table") return(json_array(character()))
    keys <- data_table_key_names(snapshot)
    ids <- vapply(keys, function(key) {
      positions <- which(names == key)
      if (length(positions) != 1L) {
        abort("invalid-data-table-key", "a data.table key does not identify exactly one column")
      }
      sprintf("r:c:%d", positions[[1L]] - 1L)
    }, character(1L), USE.NAMES = FALSE)
    for (index in seq_along(ids)) {
      spend_json_string(budget, ids[[index]], sprintf("key column %d", index))
      spend_payload_budget(budget, 1L, "data.table key metadata")
    }
    json_array(ids)
  }

  exact_named_list <- function(value, fields, label) {
    if (!is.list(value) || is.object(value)) {
      abort("invalid-view-query", sprintf("%s must be a plain named list", label))
    }
    attribute_names <- names(attributes(value)) %||% character()
    if (!identical(attribute_names, "names")) {
      abort("invalid-view-query", sprintf("%s has unsupported attributes", label))
    }
    field_names <- names(value)
    if (
      length(field_names) != length(fields) ||
        anyNA(field_names) ||
        any(field_names == "") ||
        anyDuplicated(field_names) ||
        !setequal(field_names, fields)
    ) {
      abort("invalid-view-query", sprintf("%s has missing or unknown fields", label))
    }
    value
  }

  scalar_choice <- function(value, choices, label) {
    if (!is.character(value) || length(value) != 1L || is.na(value) || !value %in% choices) {
      abort("invalid-view-query", sprintf("%s must be one of: %s", label, paste(choices, collapse = ", ")))
    }
    value
  }

  resolve_sort_rules <- function(sort_rules, descriptor) {
    maximum_rules_for_frame <- min(maximum_sort_rules, descriptor$shape$columns)
    if (
      !is.list(sort_rules) ||
        is.object(sort_rules) ||
        !is.null(attributes(sort_rules)) ||
        length(sort_rules) > maximum_rules_for_frame
    ) {
      abort(
        "invalid-view-query",
        sprintf("sort_rules must be an unnamed list of no more than %d rules", maximum_rules_for_frame)
      )
    }

    resolved <- lapply(seq_along(sort_rules), function(index) {
      label <- sprintf("sort_rules[[%d]]", index)
      rule <- exact_named_list(sort_rules[[index]], c("column", "direction", "nulls"), label)
      reference <- exact_named_list(rule$column, c("id", "name"), paste0(label, "$column"))
      column_id <- bounded_utf8(reference$id, paste0(label, "$column$id"), maximum_column_id_bytes)
      column_name <- bounded_utf8(reference$name, paste0(label, "$column$name"), maximum_name_bytes)
      schema_ids <- vapply(descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
      position <- match(column_id, schema_ids)
      if (is.na(position) || !identical(descriptor$schema[[position]]$name, column_name)) {
        abort("stale-column", sprintf("%s does not match the captured schema", paste0(label, "$column")))
      }
      list(
        position = position,
        columnId = column_id,
        direction = scalar_choice(rule$direction, c("asc", "desc"), paste0(label, "$direction")),
        nulls = scalar_choice(rule$nulls, c("first", "last"), paste0(label, "$nulls"))
      )
    })
    column_ids <- vapply(resolved, `[[`, character(1L), "columnId", USE.NAMES = FALSE)
    if (anyDuplicated(column_ids)) {
      abort("invalid-view-query", "sort_rules may address each column only once")
    }
    resolved
  }

  exact_named_list_optional <- function(value, required, optional, label) {
    if (!is.list(value) || is.object(value)) {
      abort("invalid-view-query", sprintf("%s must be a plain named list", label))
    }
    attribute_names <- names(attributes(value)) %||% character()
    if (!identical(attribute_names, "names")) {
      abort("invalid-view-query", sprintf("%s has unsupported attributes", label))
    }
    field_names <- names(value)
    if (
      anyNA(field_names) ||
        any(field_names == "") ||
        anyDuplicated(field_names) ||
        !all(required %in% field_names) ||
        any(!field_names %in% c(required, optional))
    ) {
      abort("invalid-view-query", sprintf("%s has missing or unknown fields", label))
    }
    value
  }

  resolve_column_reference <- function(reference, descriptor, label) {
    reference <- exact_named_list(reference, c("id", "name"), label)
    column_id <- bounded_utf8(reference$id, paste0(label, "$id"), maximum_column_id_bytes)
    column_name <- bounded_utf8(reference$name, paste0(label, "$name"), maximum_name_bytes)
    schema_ids <- vapply(descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    position <- match(column_id, schema_ids)
    if (is.na(position) || !identical(descriptor$schema[[position]]$name, column_name)) {
      abort("stale-column", sprintf("%s does not match the captured schema", label))
    }
    list(position = position, columnId = column_id, name = column_name)
  }

  is_private_column_name <- function(value) {
    folded <- chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", value)
    startsWith(folded, private_row_id_prefix)
  }

  predicate_operators <- list(
    string = c(
      "contains", "startsWith", "endsWith", "equals", "notEquals", "gt", "gte", "lt", "lte", "between",
      "isNull", "isNotNull"
    ),
    integer = c("equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"),
    float = c(
      "equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull", "isNaN",
      "isNotNaN"
    ),
    boolean = c("equals", "notEquals", "isNull", "isNotNull"),
    datetime = c("equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"),
    date = c("equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"),
    duration = c("equals", "notEquals", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull")
  )

  normalize_integer_text <- function(value, label) {
    text <- if (is.character(value) && length(value) == 1L && !is.na(value)) {
      value
    } else if (is.numeric(value) && length(value) == 1L && is.finite(value) && value == floor(value)) {
      format(value, scientific = FALSE, trim = TRUE)
    } else {
      abort("invalid-view-value", sprintf("%s must be a decimal integer", label))
    }
    if (!grepl("^[+-]?[0-9]+$", text, perl = TRUE)) {
      abort("invalid-view-value", sprintf("%s must be a decimal integer", label))
    }
    negative <- startsWith(text, "-")
    digits <- sub("^[+-]", "", text)
    digits <- sub("^0+(?=[0-9])", "", digits, perl = TRUE)
    if (identical(digits, "0")) negative <- FALSE
    paste0(if (negative) "-" else "", digits)
  }

  integer_text_compare <- function(left, right) {
    left_negative <- startsWith(left, "-")
    right_negative <- startsWith(right, "-")
    if (left_negative != right_negative) return(if (left_negative) -1L else 1L)
    left_digits <- if (left_negative) substring(left, 2L) else left
    right_digits <- if (right_negative) substring(right, 2L) else right
    magnitude <- if (nchar(left_digits, type = "bytes") != nchar(right_digits, type = "bytes")) {
      if (nchar(left_digits, type = "bytes") < nchar(right_digits, type = "bytes")) -1L else 1L
    } else if (identical(left_digits, right_digits)) {
      0L
    } else if (left_digits < right_digits) {
      -1L
    } else {
      1L
    }
    if (left_negative) -magnitude else magnitude
  }

  validate_integer64_text <- function(text, label) {
    if (
      integer_text_compare(text, "-9223372036854775808") < 0L ||
        integer_text_compare(text, "9223372036854775807") > 0L
    ) {
      abort("invalid-view-value", sprintf("%s is outside the signed 64-bit range", label))
    }
    text
  }

  parse_finite_number <- function(value, label, allow_infinity = FALSE) {
    text <- if (is.character(value) && length(value) == 1L && !is.na(value)) {
      value
    } else if (is.numeric(value) && length(value) == 1L && !is.na(value)) {
      as.character(value)
    } else {
      abort("invalid-view-value", sprintf("%s must be a decimal number", label))
    }
    if (allow_infinity && grepl("^[+-]?Infinity$", text, perl = TRUE)) {
      return(if (startsWith(text, "-")) -Inf else Inf)
    }
    if (!grepl("^[+-]?(?:(?:[0-9]+(?:\\.[0-9]*)?)|(?:\\.[0-9]+))(?:[eE][+-]?[0-9]+)?$", text, perl = TRUE)) {
      abort("invalid-view-value", sprintf("%s must be a decimal number", label))
    }
    number <- suppressWarnings(as.double(text))
    if (!is.finite(number)) abort("invalid-view-value", sprintf("%s is outside the finite numeric range", label))
    number
  }

  parse_boolean <- function(value, label) {
    if (is.logical(value) && length(value) == 1L && !is.na(value)) return(value)
    if (!is.character(value) || length(value) != 1L || is.na(value)) {
      abort("invalid-view-value", sprintf("%s must be true or false", label))
    }
    normalized <- tolower(trimws(value))
    if (!normalized %in% c("true", "false")) {
      abort("invalid-view-value", sprintf("%s must be true or false", label))
    }
    identical(normalized, "true")
  }

  parse_date_key <- function(value, label) {
    text <- bounded_utf8(as.character(value), label)
    if (!grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", text, perl = TRUE)) {
      abort("invalid-view-value", sprintf("%s must use YYYY-MM-DD", label))
    }
    if (identical(substring(text, 1L, 4L), "0000")) {
      abort("invalid-view-value", sprintf("%s is outside the supported date range", label))
    }
    parsed <- suppressWarnings(as.Date(text, format = "%Y-%m-%d"))
    if (is.na(parsed)) abort("invalid-view-value", sprintf("%s is not a valid date", label))
    exact_double(as.double(parsed))
  }

  parse_datetime_key <- function(value, semantics, label) {
    text <- bounded_utf8(as.character(value), label)
    match <- regexec(
      "^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$",
      text,
      perl = TRUE
    )
    parts <- regmatches(text, match)[[1L]]
    if (length(parts) == 0L) {
      abort("invalid-view-value", sprintf("%s must be an ISO datetime", label))
    }
    if (identical(substring(parts[[2L]], 1L, 4L), "0000")) {
      abort("invalid-view-value", sprintf("%s is outside the supported datetime range", label))
    }
    hours <- as.integer(parts[[3L]])
    minutes <- as.integer(parts[[4L]])
    seconds <- if (identical(parts[[5L]], "")) 0L else as.integer(parts[[5L]])
    zone <- parts[[7L]]
    if (hours > 23L || minutes > 59L || seconds > 59L) {
      abort("invalid-view-value", sprintf("%s has invalid time fields", label))
    }
    has_zone <- !identical(zone, "")
    if (has_zone && !identical(zone, "Z")) {
      zone_digits <- gsub(":", "", substring(zone, 2L), fixed = TRUE)
      if (as.integer(substring(zone_digits, 1L, 2L)) > 23L || as.integer(substring(zone_digits, 3L, 4L)) > 59L) {
        abort("invalid-view-value", sprintf("%s has invalid timezone fields", label))
      }
    }
    timezone <- if (has_zone) "UTC" else (semantics$timezone %||% "UTC")
    if (identical(timezone, "")) timezone <- "UTC"
    fraction <- parts[[6L]]
    normalized_zone <- if (!has_zone) "" else if (identical(zone, "Z")) "+0000" else gsub(":", "", zone, fixed = TRUE)
    normalized <- sprintf(
      "%sT%02d:%02d:%02d%s%s",
      parts[[2L]],
      hours,
      minutes,
      seconds,
      fraction,
      normalized_zone
    )
    format <- if (has_zone) "%Y-%m-%dT%H:%M:%OS%z" else "%Y-%m-%dT%H:%M:%OS"
    parsed <- suppressWarnings(as.POSIXct(strptime(normalized, format = format, tz = timezone)))
    if (length(parsed) != 1L || is.na(parsed)) {
      abort("invalid-view-value", sprintf("%s is not a valid datetime", label))
    }
    if (!has_zone) {
      local <- as.POSIXlt(parsed, tz = timezone)
      expected_seconds <- seconds + if (identical(fraction, "")) 0 else as.double(fraction)
      expected_date <- as.integer(strsplit(parts[[2L]], "-", fixed = TRUE)[[1L]])
      if (
        local$year + 1900L != expected_date[[1L]] ||
          local$mon + 1L != expected_date[[2L]] ||
          local$mday != expected_date[[3L]] ||
          local$hour != hours ||
          local$min != minutes ||
          abs(local$sec - expected_seconds) > 1e-6
      ) {
        abort("invalid-view-value", sprintf("%s is not a valid local datetime in %s", label, timezone))
      }
    }
    exact_double(as.double(parsed))
  }

  duration_microseconds_text <- function(text) {
    negative <- startsWith(text, "-")
    unsigned <- sub("^[+-]", "", text)
    parts <- strsplit(unsigned, ".", fixed = TRUE)[[1L]]
    whole <- if (length(parts) == 0L || identical(parts[[1L]], "")) "0" else parts[[1L]]
    fraction <- if (length(parts) < 2L) "" else parts[[2L]]
    fraction <- paste0(fraction, strrep("0", 6L - nchar(fraction, type = "bytes")))
    digits <- paste0(whole, fraction)
    digits <- sub("^0+(?=[0-9])", "", digits, perl = TRUE)
    if (negative && !identical(digits, "0")) paste0("-", digits) else digits
  }

  validate_duration_microseconds <- function(text, label) {
    microseconds <- duration_microseconds_text(text)
    if (
      integer_text_compare(microseconds, "-86399999913600000000") < 0L ||
        integer_text_compare(microseconds, "86399999999999999999") > 0L
    ) {
      abort("invalid-view-value", sprintf("%s is outside the supported duration range", label))
    }
    invisible(NULL)
  }

  parse_duration_seconds <- function(value, label) {
    text <- bounded_utf8(as.character(value), label)
    if (grepl("^[+-]?(?:[0-9]+(?:\\.[0-9]{0,6})?|\\.[0-9]{1,6})$", text, perl = TRUE)) {
      validate_duration_microseconds(text, label)
      return(parse_finite_number(text, label))
    }
    match <- regexec("^(?:(-?[0-9]+) days?, )?([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]{1,6}))?$", text, perl = TRUE)
    parts <- regmatches(text, match)[[1L]]
    if (length(parts) == 0L) abort("invalid-view-value", sprintf("%s is not a valid duration", label))
    hours <- as.integer(parts[[3L]])
    minutes <- as.integer(parts[[4L]])
    seconds <- as.integer(parts[[5L]])
    if (hours > 23L || minutes > 59L || seconds > 59L) {
      abort("invalid-view-value", sprintf("%s has invalid duration fields", label))
    }
    days_text <- if (identical(parts[[2L]], "")) "0" else normalize_integer_text(parts[[2L]], label)
    if (
      integer_text_compare(days_text, "-999999999") < 0L ||
        integer_text_compare(days_text, "999999999") > 0L
    ) {
      abort("invalid-view-value", sprintf("%s is outside the supported duration range", label))
    }
    days <- as.double(days_text)
    fraction <- if (length(parts) < 6L || identical(parts[[6L]], "")) 0 else as.double(paste0("0.", parts[[6L]]))
    days * 86400 + hours * 3600 + minutes * 60 + seconds + fraction
  }

  duration_unit_seconds <- c(secs = 1, mins = 60, hours = 3600, days = 86400, weeks = 604800)

  primitive_view_key <- function(value, descriptor, label) {
    semantics <- descriptor$semantics
    type <- descriptor$type
    if (type == "string") return(bounded_utf8(as.character(value), label))
    if (type == "integer") {
      text <- normalize_integer_text(value, label)
      if (semantics$kind == "integer64") return(validate_integer64_text(text, label))
      number <- suppressWarnings(as.double(text))
      if (!is.finite(number) || number < -2147483647 || number > 2147483647) {
        abort("invalid-view-value", sprintf("%s is outside the R integer range", label))
      }
      return(as.character(as.integer(number)))
    }
    if (type == "float") return(canonical_double_key(parse_finite_number(value, label, allow_infinity = TRUE)))
    if (type == "boolean") return(if (parse_boolean(value, label)) "TRUE" else "FALSE")
    if (type == "date") return(parse_date_key(value, label))
    if (type == "datetime") return(parse_datetime_key(value, semantics, label))
    if (type == "duration") {
      seconds <- parse_duration_seconds(value, label)
      return(exact_double(seconds / duration_unit_seconds[[semantics$units]]))
    }
    abort("invalid-view-value", sprintf("%s targets an unsupported R column type", label))
  }

  typed_selection_key <- function(token, descriptor, label) {
    token <- exact_named_list(token, c("kind", "version", "columnType", "cell"), label)
    if (!identical(token$kind, "typedSelection") || !identical(token$version, 1L)) {
      abort("invalid-view-value", sprintf("%s is not a versioned typed selection", label))
    }
    if (!identical(token$columnType, descriptor$type)) {
      abort("invalid-view-value", sprintf("%s does not match the R column type", label))
    }
    cell <- exact_named_list_optional(
      token$cell,
      c("kind", "raw", "display", "isNull", "isNaN"),
      "sign",
      paste0(label, "$cell")
    )
    if (!identical(cell$isNull, FALSE) || !identical(cell$isNaN, FALSE)) {
      abort("invalid-view-value", sprintf("%s must represent a present scalar", label))
    }
    expected_kind <- switch(
      descriptor$semantics$kind,
      logical = "boolean",
      integer = "integer",
      integer64 = "integer",
      double = c("number", "infinity"),
      character = "string",
      factor = "string",
      date = "date",
      datetime = "datetime",
      difftime = "duration"
    )
    if (!cell$kind %in% expected_kind) abort("invalid-view-value", sprintf("%s has an incompatible cell kind", label))
    if (identical(cell$kind, "infinity")) {
      if (!is.null(cell$raw) || !cell$sign %in% c(-1L, 1L)) {
        abort("invalid-view-value", sprintf("%s has invalid infinity data", label))
      }
      return(if (cell$sign < 0L) "-Inf" else "Inf")
    }
    if (descriptor$semantics$kind == "datetime") {
      return(exact_double(parse_finite_number(cell$raw, label)))
    }
    if (descriptor$semantics$kind == "difftime") {
      return(exact_double(parse_finite_number(cell$raw, label)))
    }
    primitive_view_key(cell$raw, descriptor, label)
  }

  view_value_key <- function(value, descriptor, label) {
    if (is.list(value) && !is.null(names(value))) return(typed_selection_key(value, descriptor, label))
    primitive_view_key(value, descriptor, label)
  }

  resolve_view_query <- function(view_query, descriptor) {
    view_query <- exact_named_list_optional(view_query, c("filters", "sorts"), "logic", "view_query")
    logic <- if ("logic" %in% names(view_query)) {
      scalar_choice(view_query$logic, c("and", "or"), "view_query$logic")
    } else {
      "and"
    }
    if (
      !is.list(view_query$filters) || is.object(view_query$filters) || !is.null(attributes(view_query$filters)) ||
        length(view_query$filters) > maximum_filters
    ) {
      abort("invalid-view-query", sprintf("view_query$filters may contain at most %d filters", maximum_filters))
    }
    filters <- lapply(seq_along(view_query$filters), function(index) {
      label <- sprintf("view_query$filters[[%d]]", index)
      filter <- exact_named_list_optional(
        view_query$filters[[index]],
        c("column", "type", "predicates"),
        c("logic", "valueFilter"),
        label
      )
      resolved <- resolve_column_reference(filter$column, descriptor, paste0(label, "$column"))
      column_descriptor <- descriptor$schema[[resolved$position]]
      if (!identical(filter$type, column_descriptor$type)) {
        abort("invalid-view-query", sprintf("%s$type does not match the captured schema", label))
      }
      filter_logic <- if ("logic" %in% names(filter)) {
        scalar_choice(filter$logic, c("and", "or"), paste0(label, "$logic"))
      } else {
        "and"
      }
      if (
        !is.list(filter$predicates) || is.object(filter$predicates) || !is.null(attributes(filter$predicates)) ||
          length(filter$predicates) > maximum_predicates_per_filter
      ) {
        abort("invalid-view-query", sprintf("%s$predicates is too large", label))
      }
      predicates <- lapply(seq_along(filter$predicates), function(predicate_index) {
        predicate_label <- sprintf("%s$predicates[[%d]]", label, predicate_index)
        predicate <- exact_named_list_optional(
          filter$predicates[[predicate_index]],
          c("kind", "operator"),
          c("value", "secondValue"),
          predicate_label
        )
        if (!identical(predicate$kind, "predicate") || !predicate$operator %in% predicate_operators[[filter$type]]) {
          abort("invalid-view-query", sprintf("%s has an unsupported operator", predicate_label))
        }
        nullary <- predicate$operator %in% c("isNull", "isNotNull", "isNaN", "isNotNaN")
        if (!nullary && !"value" %in% names(predicate)) {
          abort("invalid-view-query", sprintf("%s requires value", predicate_label))
        }
        if (identical(predicate$operator, "between") && !"secondValue" %in% names(predicate)) {
          abort("invalid-view-query", sprintf("%s requires secondValue", predicate_label))
        }
        if ("value" %in% names(predicate)) {
          predicate$valueKey <- view_value_key(predicate$value, column_descriptor, paste0(predicate_label, "$value"))
        }
        if ("secondValue" %in% names(predicate)) {
          predicate$secondValueKey <- view_value_key(
            predicate$secondValue,
            column_descriptor,
            paste0(predicate_label, "$secondValue")
          )
        }
        predicate
      })
      value_filter <- NULL
      if ("valueFilter" %in% names(filter)) {
        value_filter <- exact_named_list_optional(
          filter$valueFilter,
          c("kind", "selectedValues", "includeNulls", "includeNaN"),
          "search",
          paste0(label, "$valueFilter")
        )
        if (!identical(value_filter$kind, "values")) {
          abort("invalid-view-query", sprintf("%s$valueFilter has an invalid kind", label))
        }
        if (
          !is.list(value_filter$selectedValues) || is.object(value_filter$selectedValues) ||
            !is.null(attributes(value_filter$selectedValues)) ||
            length(value_filter$selectedValues) > maximum_selected_values_per_filter ||
            !is.logical(value_filter$includeNulls) || length(value_filter$includeNulls) != 1L ||
            !is.logical(value_filter$includeNaN) || length(value_filter$includeNaN) != 1L
        ) {
          abort("invalid-view-query", sprintf("%s$valueFilter is invalid", label))
        }
        value_filter$selectedKeys <- vapply(
          seq_along(value_filter$selectedValues),
          function(value_index) view_value_key(
            value_filter$selectedValues[[value_index]],
            column_descriptor,
            sprintf("%s$valueFilter$selectedValues[[%d]]", label, value_index)
          ),
          character(1L),
          USE.NAMES = FALSE
        )
      }
      list(
        position = resolved$position,
        columnId = resolved$columnId,
        logic = filter_logic,
        predicates = predicates,
        valueFilter = value_filter
      )
    })
    list(logic = logic, filters = filters, sorts = resolve_sort_rules(view_query$sorts, descriptor))
  }

  ascii_fold <- function(value) {
    chartr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", value)
  }

  compare_integer_keys <- function(keys, target, operator) {
    comparisons <- vapply(keys, integer_text_compare, integer(1L), right = target, USE.NAMES = FALSE)
    switch(
      operator,
      equals = comparisons == 0L,
      notEquals = comparisons != 0L,
      gt = comparisons > 0L,
      gte = comparisons >= 0L,
      lt = comparisons < 0L,
      lte = comparisons <= 0L
    )
  }

  predicate_mask <- function(column, descriptor, predicate) {
    semantics <- descriptor$semantics
    missing <- profile_missing_masks(column, semantics)
    operator <- predicate$operator
    if (identical(operator, "isNull")) return(missing$null)
    if (identical(operator, "isNotNull")) return(!missing$null)
    if (identical(operator, "isNaN")) return(missing$nan)
    if (identical(operator, "isNotNaN")) return(!missing$nan)

    present <- !missing$null & !missing$nan
    keys <- rep("", storage_length(column))
    present_indices <- which(present)
    keys[present_indices] <- profile_value_keys(column, semantics, present_indices)
    result <- rep(FALSE, storage_length(column))
    if (length(present_indices) == 0L) return(result)
    if (operator %in% c("contains", "startsWith", "endsWith")) {
      values <- if (semantics$kind == "factor") as.character(column[present_indices]) else column[present_indices]
      target <- predicate$valueKey
      result[present_indices] <- if (identical(operator, "contains")) {
        grepl(ascii_fold(target), ascii_fold(values), fixed = TRUE)
      } else if (identical(operator, "startsWith")) {
        startsWith(values, target)
      } else {
        endsWith(values, target)
      }
      return(result)
    }
    compare <- function(target, comparison_operator) {
      if (semantics$kind == "integer64") {
        compare_integer_keys(keys[present_indices], target, comparison_operator)
      } else if (descriptor$type %in% c("integer", "float", "date", "datetime", "duration")) {
        left <- suppressWarnings(as.double(keys[present_indices]))
        right <- suppressWarnings(as.double(target))
        switch(
          comparison_operator,
          equals = left == right,
          notEquals = left != right,
          gt = left > right,
          gte = left >= right,
          lt = left < right,
          lte = left <= right
        )
      } else {
        switch(
          comparison_operator,
          equals = keys[present_indices] == target,
          notEquals = keys[present_indices] != target,
          gt = keys[present_indices] > target,
          gte = keys[present_indices] >= target,
          lt = keys[present_indices] < target,
          lte = keys[present_indices] <= target
        )
      }
    }
    result[present_indices] <- if (identical(operator, "between")) {
      compare(predicate$valueKey, "gte") & compare(predicate$secondValueKey, "lte")
    } else {
      compare(predicate$valueKey, operator)
    }
    result
  }

  filter_row_positions <- function(frame, descriptor, resolved) {
    row_count <- descriptor$shape$rows
    column_masks <- list()
    for (filter in resolved$filters) {
      column <- frame[[filter$position]]
      semantics <- descriptor$schema[[filter$position]]$semantics
      missing <- profile_missing_masks(column, semantics)
      conditions <- list()
      value_filter <- filter$valueFilter
      if (!is.null(value_filter) && (
        length(value_filter$selectedKeys) > 0L || isTRUE(value_filter$includeNulls) || isTRUE(value_filter$includeNaN)
      )) {
        current <- rep(FALSE, row_count)
        present_indices <- which(!missing$null & !missing$nan)
        if (length(value_filter$selectedKeys) > 0L && length(present_indices) > 0L) {
          keys <- profile_value_keys(column, semantics, present_indices)
          current[present_indices] <- keys %in% value_filter$selectedKeys
        }
        if (isTRUE(value_filter$includeNulls)) current <- current | missing$null
        if (isTRUE(value_filter$includeNaN)) current <- current | missing$nan
        conditions[[length(conditions) + 1L]] <- current
      }
      for (predicate in filter$predicates) {
        conditions[[length(conditions) + 1L]] <- predicate_mask(
          column,
          descriptor$schema[[filter$position]],
          predicate
        )
      }
      if (length(conditions) > 0L) {
        combined <- conditions[[1L]]
        if (length(conditions) > 1L) {
          for (index in 2:length(conditions)) {
            combined <- if (identical(filter$logic, "or")) combined | conditions[[index]] else combined & conditions[[index]]
          }
        }
        column_masks[[length(column_masks) + 1L]] <- combined
      }
    }
    if (length(column_masks) == 0L) return(seq_len(row_count))
    combined <- column_masks[[1L]]
    if (length(column_masks) > 1L) {
      for (index in 2:length(column_masks)) {
        combined <- if (identical(resolved$logic, "or")) combined | column_masks[[index]] else combined & column_masks[[index]]
      }
    }
    which(combined)
  }

  resolve_profile_columns <- function(column_references, descriptor) {
    maximum_columns_for_frame <- min(maximum_profile_columns, descriptor$shape$columns)
    if (
      !is.list(column_references) ||
        is.object(column_references) ||
        !is.null(attributes(column_references)) ||
        length(column_references) == 0L ||
        length(column_references) > maximum_columns_for_frame
    ) {
      abort(
        "profile-too-large",
        sprintf("column_references must contain 1 through %d columns", maximum_columns_for_frame)
      )
    }

    schema_ids <- vapply(descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    resolved <- lapply(seq_along(column_references), function(index) {
      label <- sprintf("column_references[[%d]]", index)
      reference <- exact_named_list(column_references[[index]], c("id", "name"), label)
      column_id <- bounded_utf8(reference$id, paste0(label, "$id"), maximum_column_id_bytes)
      column_name <- bounded_utf8(reference$name, paste0(label, "$name"), maximum_name_bytes)
      position <- match(column_id, schema_ids)
      if (is.na(position) || !identical(descriptor$schema[[position]]$name, column_name)) {
        abort("stale-column", sprintf("%s does not match the captured schema", label))
      }
      list(position = position, columnId = column_id)
    })
    column_ids <- vapply(resolved, `[[`, character(1L), "columnId", USE.NAMES = FALSE)
    if (anyDuplicated(column_ids)) {
      abort("invalid-view-query", "column_references may address each column only once")
    }
    resolved
  }

  validate_profile_column <- function(column, semantics, label) {
    validated <- column_semantics(column, label, new_payload_budget(), validate_values = TRUE)
    if (!identical(validated, semantics)) source_changed()
    kind <- semantics$kind
    if (kind %in% c("date", "datetime", "difftime")) {
      values <- unclass(column)
      if (any(is.nan(values))) {
        abort("unsupported-cell", sprintf("%s contains a classed NaN", label))
      }
      if (any(!is.na(values) & !is.finite(values))) {
        abort("unsupported-cell", sprintf("%s contains a non-finite classed value", label))
      }
      if (kind == "date" && any(!is.na(values) & values != floor(values))) {
        abort("unsupported-cell", sprintf("%s contains a fractional Date", label))
      }
    }
    invisible(NULL)
  }

  profile_missing_masks <- function(column, semantics) {
    if (identical(semantics$kind, "double")) {
      nan <- is.nan(column)
      return(list(null = is.na(column) & !nan, nan = nan))
    }
    if (identical(semantics$kind, "integer64")) {
      return(list(
        null = integer64_missing_mask(column, ensure_integer64_bindings()),
        nan = rep(FALSE, storage_length(column))
      ))
    }
    if (semantics$kind %in% c("date", "datetime", "difftime")) {
      values <- unclass(column)
      return(list(null = is.na(values), nan = rep(FALSE, length(values))))
    }
    list(null = is.na(column), nan = rep(FALSE, storage_length(column)))
  }

  profile_value_keys <- function(column, semantics, indices) {
    if (length(indices) == 0L) return(character())
    kind <- semantics$kind
    if (kind == "integer64") {
      bindings <- ensure_integer64_bindings()
      return(integer64_as_character(integer64_subset(column, indices), bindings))
    }
    values <- column[indices]
    if (kind == "logical") return(ifelse(values, "TRUE", "FALSE"))
    if (kind == "integer") return(as.character(values))
    if (kind == "double") {
      return(vapply(values, canonical_double_key, character(1L)))
    }
    if (kind == "character") {
      return(vapply(
        seq_along(values),
        function(index) bounded_utf8(values[[index]], sprintf("profile value %d", indices[[index]])),
        character(1L),
        USE.NAMES = FALSE
      ))
    }
    if (kind == "factor") return(as.character(values))
    numeric_values <- if (kind == "difftime") {
      as.double(values, units = semantics$units)
    } else {
      as.double(values)
    }
    vapply(numeric_values, exact_double, character(1L), USE.NAMES = FALSE)
  }

  profile_value_displays <- function(column, semantics, indices, keys = NULL) {
    if (length(indices) == 0L) return(character())
    kind <- semantics$kind
    if (kind %in% c("logical", "integer", "integer64", "character", "factor")) {
      return(keys %||% profile_value_keys(column, semantics, indices))
    }
    values <- column[indices]
    if (kind == "double") {
      return(vapply(values, display_double, character(1L), USE.NAMES = FALSE))
    }
    if (kind == "date") {
      return(display_date_values(values, "column values"))
    }
    if (kind == "datetime") {
      return(display_datetime_values(values, semantics$timezone, "column values"))
    }
    if (kind == "difftime") {
      exact <- vapply(as.double(values, units = semantics$units), exact_double, character(1L), USE.NAMES = FALSE)
      return(paste(exact, semantics$units))
    }
    abort("internal-error", "unknown R column kind")
  }

  chunked_searched_value_counts <- function(column, semantics, row_positions, row_count, search) {
    counts_by_key <- new.env(hash = TRUE, parent = emptyenv())
    key_batches <- list()
    source_batches <- list()
    batch_count <- 0L
    distinct_count <- 0L
    distinct_key_bytes <- 0
    folded_search <- ascii_fold(search)
    start <- 1
    while (start <= row_count) {
      count <- min(maximum_profile_chunk_rows, row_count - start + 1)
      source_positions <- profile_chunk_source_positions(row_positions, start, count)
      chunk <- column[source_positions]
      validate_profile_column(chunk, semantics, "column values")
      missing <- profile_missing_masks(chunk, semantics)
      present_indices <- which(!missing$null & !missing$nan)
      if (length(present_indices) != 0L) {
        keys <- profile_value_keys(chunk, semantics, present_indices)
        displays <- profile_value_displays(chunk, semantics, present_indices, keys)
        keep <- grepl(folded_search, ascii_fold(displays), fixed = TRUE)
        if (any(keep)) {
          matching_indices <- present_indices[keep]
          matching_keys <- keys[keep]
          first <- !duplicated(matching_keys)
          unique_keys <- matching_keys[first]
          first_sources <- source_positions[matching_indices[first]]
          chunk_counts <- tabulate(match(matching_keys, unique_keys), nbins = length(unique_keys))
          new_keys <- character(length(unique_keys))
          new_sources <- integer(length(unique_keys))
          new_count <- 0L
          for (index in seq_along(unique_keys)) {
            key <- unique_keys[[index]]
            environment_key <- paste0(":", key)
            if (exists(environment_key, envir = counts_by_key, inherits = FALSE)) {
              assign(
                environment_key,
                get(environment_key, envir = counts_by_key, inherits = FALSE) + chunk_counts[[index]],
                envir = counts_by_key
              )
            } else {
              next_key_bytes <- distinct_key_bytes + as.double(nchar(key, type = "bytes"))
              if (
                distinct_count >= maximum_column_value_distinct_matches ||
                  next_key_bytes > maximum_column_value_distinct_key_bytes
              ) {
                abort(
                  "profile-too-large",
                  sprintf(
                    paste0(
                      "The requested R column-value search exceeds the distinct-match state limit of ",
                      "%d values and %d UTF-8 key bytes; narrow the search and try again"
                    ),
                    maximum_column_value_distinct_matches,
                    maximum_column_value_distinct_key_bytes
                  )
                )
              }
              assign(environment_key, as.double(chunk_counts[[index]]), envir = counts_by_key)
              distinct_count <- distinct_count + 1L
              distinct_key_bytes <- next_key_bytes
              new_count <- new_count + 1L
              new_keys[[new_count]] <- key
              new_sources[[new_count]] <- first_sources[[index]]
            }
          }
          if (new_count != 0L) {
            batch_count <- batch_count + 1L
            key_batches[[batch_count]] <- new_keys[seq_len(new_count)]
            source_batches[[batch_count]] <- new_sources[seq_len(new_count)]
          }
        }
      }
      start <- start + count
    }
    if (batch_count == 0L) {
      return(list(keys = character(), firstSources = integer(), counts = numeric()))
    }
    keys <- unlist(key_batches, use.names = FALSE)
    list(
      keys = keys,
      firstSources = unlist(source_batches, use.names = FALSE),
      counts = vapply(
        paste0(":", keys),
        get,
        numeric(1L),
        envir = counts_by_key,
        inherits = FALSE,
        USE.NAMES = FALSE
      )
    )
  }

  profile_value_counts <- function(column, semantics, present_indices, budget, label) {
    if (length(present_indices) == 0L) {
      return(list(distinctCount = 0L, topValues = json_array(list()), keys = character()))
    }
    keys <- profile_value_keys(column, semantics, present_indices)
    first <- !duplicated(keys)
    unique_keys <- keys[first]
    first_indices <- present_indices[first]
    counts <- tabulate(match(keys, unique_keys), nbins = length(unique_keys))
    priority <- base::order(-counts, seq_along(counts), method = "radix")
    selected <- utils::head(priority, maximum_top_values)
    top_values <- lapply(seq_along(selected), function(result_index) {
      source_index <- first_indices[[selected[[result_index]]]]
      encoded <- encode_value(
        column,
        semantics,
        source_index,
        sprintf("%s top value %d", label, result_index),
        budget
      )
      list(value = encoded$display, count = as.integer(counts[[selected[[result_index]]]]))
    })
    list(
      distinctCount = as.integer(length(unique_keys)),
      topValues = json_array(top_values),
      keys = keys
    )
  }

  finite_statistic <- function(value) {
    if (length(value) != 1L || is.na(value) || !is.finite(value)) NULL else as.double(value)
  }

  numeric_profile_values <- function(column, semantics, present_indices) {
    if (semantics$kind == "integer64") {
      bindings <- ensure_integer64_bindings()
      return(suppressWarnings(integer64_as_double(integer64_subset(column, present_indices), bindings)))
    }
    values <- column[present_indices]
    if (semantics$kind == "difftime") return(as.double(values, units = semantics$units))
    as.double(values)
  }

  exact_profile_integer_text_cell <- function(exact, budget, label) {
    spend_json_string(budget, exact, label)
    digits <- if (startsWith(exact, "-")) substring(exact, 2L) else exact
    safe_limit <- "9007199254740991"
    safely_numeric <- nchar(digits, type = "bytes") < nchar(safe_limit) ||
      (nchar(digits, type = "bytes") == nchar(safe_limit) && digits <= safe_limit)
    raw <- if (safely_numeric) as.double(exact) else exact
    ordinary_cell("integer", raw, exact)
  }

  exact_profile_integer_cell <- function(column, semantics, index, budget, label) {
    exact <- if (identical(semantics$kind, "integer64")) {
      integer64_as_character(integer64_subset(column, index), ensure_integer64_bindings())[[1L]]
    } else {
      as.character(unname(column[index]))
    }
    exact_profile_integer_text_cell(exact, budget, label)
  }

  exact_integer_extrema <- function(column, semantics, present_indices, budget, label) {
    if (length(present_indices) == 0L || !semantics$kind %in% c("integer", "integer64")) return(list())
    if (semantics$kind == "integer64") {
      values <- integer64_subset(column, present_indices)
      ascending <- order_integer64(values, FALSE)
      minimum_index <- present_indices[[ascending[[1L]]]]
      maximum_index <- present_indices[[ascending[[length(ascending)]]]]
    } else {
      values <- column[present_indices]
      minimum_index <- present_indices[[which.min(values)]]
      maximum_index <- present_indices[[which.max(values)]]
    }
    list(
      exactMin = exact_profile_integer_cell(column, semantics, minimum_index, budget, paste0(label, " minimum")),
      exactMax = exact_profile_integer_cell(column, semantics, maximum_index, budget, paste0(label, " maximum"))
    )
  }

  numeric_histogram <- function(values, distinct_count) {
    finite_values <- values[is.finite(values)]
    if (length(finite_values) == 0L || distinct_count == 0L) return(NULL)
    minimum <- min(finite_values)
    maximum <- max(finite_values)
    bin_count <- min(maximum_histogram_bins, length(finite_values), distinct_count)
    if (minimum == maximum) {
      return(list(
        kind = "numeric",
        bins = json_array(list(list(min = as.double(minimum), max = as.double(maximum), count = length(finite_values))))
      ))
    }
    fractions <- seq_len(bin_count - 1L) / bin_count
    interior_edges <- vapply(
      fractions,
      function(fraction) minimum * (1 - fraction) + maximum * fraction,
      double(1L)
    )
    edges <- c(minimum, interior_edges, maximum)
    edges <- cummax(pmin(maximum, pmax(minimum, edges)))
    if (any(!is.finite(edges))) return(NULL)
    bin_indices <- findInterval(finite_values, edges, rightmost.closed = TRUE, all.inside = TRUE)
    counts <- tabulate(bin_indices, nbins = bin_count)
    edges[[1L]] <- minimum
    edges[[length(edges)]] <- maximum
    bins <- lapply(seq_len(bin_count), function(index) {
      list(min = as.double(edges[[index]]), max = as.double(edges[[index + 1L]]), count = as.integer(counts[[index]]))
    })
    list(kind = "numeric", bins = json_array(bins))
  }

  numeric_profile <- function(column, semantics, present_indices, value_keys, budget, label) {
    values <- numeric_profile_values(column, semantics, present_indices)
    numeric <- list()
    if (semantics$kind %in% c("integer", "integer64")) {
      exact_sum <- exact_integer_sum_text(column[present_indices], semantics$kind)
      numeric$exactSum <- exact_profile_integer_text_cell(exact_sum, budget, paste0(label, " sum"))
      sum_value <- finite_statistic(suppressWarnings(as.double(exact_sum)))
    } else {
      sum_value <- finite_statistic(suppressWarnings(sum(values)))
    }
    if (!is.null(sum_value)) numeric$sum <- sum_value
    candidates <- list(
      min = if (length(values) == 0L) NULL else suppressWarnings(min(values)),
      max = if (length(values) == 0L) NULL else suppressWarnings(max(values)),
      mean = if (length(values) == 0L) NULL else suppressWarnings(mean(values)),
      median = if (length(values) == 0L) NULL else suppressWarnings(stats::median(values)),
      std = if (length(values) < 2L) NULL else suppressWarnings(stats::sd(values))
    )
    for (name in names(candidates)) {
      statistic <- finite_statistic(candidates[[name]])
      if (!is.null(statistic)) numeric[[name]] <- statistic
    }
    numeric <- c(numeric, exact_integer_extrema(column, semantics, present_indices, budget, label))

    finite_keys <- value_keys[is.finite(values)]
    visualization <- numeric_histogram(values, length(unique(finite_keys)))
    list(
      numeric = if (length(numeric) == 0L) NULL else numeric,
      visualization = visualization
    )
  }

  text_profile <- function(column, semantics, present_indices) {
    if (length(present_indices) == 0L) return(list(emptyCount = 0L))
    values <- if (semantics$kind == "factor") as.character(column[present_indices]) else column[present_indices]
    values <- vapply(
      seq_along(values),
      function(index) bounded_utf8(values[[index]], sprintf("profile text %d", present_indices[[index]])),
      character(1L),
      USE.NAMES = FALSE
    )
    lengths <- nchar(values, type = "chars", allowNA = FALSE, keepNA = FALSE)
    list(
      emptyCount = as.integer(sum(lengths == 0L)),
      minLength = as.integer(min(lengths)),
      maxLength = as.integer(max(lengths)),
      meanLength = as.double(mean(lengths))
    )
  }

  datetime_profile <- function(column, semantics, present_indices, budget, label) {
    if (length(present_indices) == 0L) return(list(kind = "datetime"))
    values <- as.double(column[present_indices])
    minimum_index <- present_indices[[which.min(values)]]
    maximum_index <- present_indices[[which.max(values)]]
    list(
      kind = "datetime",
      min = encode_value(column, semantics, minimum_index, paste0(label, " minimum"), budget)$display,
      max = encode_value(column, semantics, maximum_index, paste0(label, " maximum"), budget)$display
    )
  }

  column_summary <- function(capture, column, resolved, budget) {
    position <- resolved$position
    descriptor <- capture$descriptor$schema[[position]]
    semantics <- descriptor$semantics
    label <- sprintf("column %d profile", position)
    validate_profile_column(column, semantics, label)
    spend_payload_budget(budget, summary_fixed_bytes, label)
    spend_json_string(budget, descriptor$id, paste0(label, " ID"))
    spend_json_string(budget, descriptor$name, paste0(label, " name"))
    spend_json_string(budget, descriptor$rawType, paste0(label, " type"))

    missing <- profile_missing_masks(column, semantics)
    present_indices <- which(!missing$null & !missing$nan)
    counts <- profile_value_counts(column, semantics, present_indices, budget, label)
    summary <- list(
      columnId = descriptor$id,
      column = descriptor$name,
      type = descriptor$type,
      rawType = descriptor$rawType,
      totalCount = storage_length(column),
      nullCount = as.integer(sum(missing$null)),
      nanCount = as.integer(sum(missing$nan)),
      distinctCount = counts$distinctCount,
      topValues = counts$topValues
    )

    if (semantics$kind %in% c("integer", "integer64", "double", "difftime")) {
      profile <- numeric_profile(column, semantics, present_indices, counts$keys, budget, label)
      if (!is.null(profile$numeric)) summary$numeric <- profile$numeric
      if (!is.null(profile$visualization)) summary$visualization <- profile$visualization
    } else if (semantics$kind == "logical") {
      values <- column[present_indices]
      summary$visualization <- list(
        kind = "boolean",
        trueCount = as.integer(sum(values)),
        falseCount = as.integer(sum(!values))
      )
    } else if (semantics$kind %in% c("date", "datetime")) {
      summary$visualization <- datetime_profile(column, semantics, present_indices, budget, label)
    } else if (semantics$kind %in% c("character", "factor")) {
      summary$text <- text_profile(column, semantics, present_indices)
      summary$visualization <- list(
        kind = "categorical",
        categories = counts$topValues,
        otherCount = as.integer(length(present_indices) - sum(vapply(counts$topValues, `[[`, integer(1L), "count")))
      )
    }
    summary
  }

  order_integer64 <- function(values, decreasing) {
    text <- integer64_as_character(values, ensure_integer64_bindings())
    negative <- startsWith(text, "-")
    digits <- ifelse(negative, substring(text, 2L), text)
    negative_positions <- which(negative)
    nonnegative_positions <- which(!negative)

    order_group <- function(positions, reverse_magnitude) {
      if (length(positions) == 0L) return(integer())
      positions[base::order(
        nchar(digits[positions], type = "bytes"),
        digits[positions],
        decreasing = reverse_magnitude,
        method = "radix"
      )]
    }

    if (decreasing) {
      c(order_group(nonnegative_positions, TRUE), order_group(negative_positions, FALSE))
    } else {
      c(order_group(negative_positions, TRUE), order_group(nonnegative_positions, FALSE))
    }
  }

  order_present_values <- function(values, semantics, decreasing) {
    if (semantics$kind == "integer64") return(order_integer64(values, decreasing))
    base::order(values, decreasing = decreasing, method = "radix", na.last = NA)
  }

  deterministic_sample_positions <- function(total, maximum) {
    if (total <= 0 || maximum <= 0) return(integer())
    count <- as.integer(min(as.double(total), as.double(maximum)))
    if (count == total) return(seq_len(count))

    had_random_seed <- base::exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
    if (had_random_seed) previous_random_seed <- base::get(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
    previous_rng_kind <- base::RNGkind()
    on.exit({
      base::suppressWarnings(base::do.call(base::RNGkind, base::as.list(previous_rng_kind)))
      if (had_random_seed) {
        base::assign(".Random.seed", previous_random_seed, envir = .GlobalEnv)
      } else if (base::exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) {
        base::rm(".Random.seed", envir = .GlobalEnv)
      }
    }, add = TRUE)

    base::RNGkind(kind = "Mersenne-Twister", normal.kind = "Inversion", sample.kind = "Rejection")
    base::set.seed(104729L)
    base::sort(base::sample.int(
      as.double(total),
      count,
      replace = FALSE,
      useHash = count <= total / 2 && total > 1000000
    ))
  }

  profile_chunk_source_positions <- function(row_positions, start, count) {
    logical_positions <- seq.int(as.integer(start), length.out = as.integer(count))
    if (is.null(row_positions)) logical_positions else row_positions[logical_positions]
  }

  compare_integer_text <- function(left, right) {
    if (identical(left, right)) return(0L)
    left_negative <- startsWith(left, "-")
    right_negative <- startsWith(right, "-")
    if (left_negative != right_negative) return(if (left_negative) -1L else 1L)
    left_digits <- if (left_negative) substring(left, 2L) else left
    right_digits <- if (right_negative) substring(right, 2L) else right
    left_length <- nchar(left_digits, type = "bytes")
    right_length <- nchar(right_digits, type = "bytes")
    if (left_length != right_length) {
      magnitude <- if (left_length < right_length) -1L else 1L
      return(if (left_negative) -magnitude else magnitude)
    }
    left_codes <- utf8ToInt(left_digits)
    right_codes <- utf8ToInt(right_digits)
    first_difference <- which(left_codes != right_codes)[[1L]]
    magnitude <- if (left_codes[[first_difference]] < right_codes[[first_difference]]) -1L else 1L
    if (left_negative) -magnitude else magnitude
  }

  chunked_column_summary <- function(capture, frame, resolved, row_positions, row_count, budget) {
    position <- resolved$position
    descriptor <- capture$descriptor$schema[[position]]
    column <- frame[[position]]
    semantics <- descriptor$semantics
    kind <- semantics$kind
    label <- sprintf("column %d profile", position)
    spend_payload_budget(budget, summary_fixed_bytes, label)
    spend_json_string(budget, descriptor$id, paste0(label, " ID"))
    spend_json_string(budget, descriptor$name, paste0(label, " name"))
    spend_json_string(budget, descriptor$rawType, paste0(label, " type"))

    null_count <- 0
    nan_count <- 0
    present_count <- 0
    true_count <- 0
    false_count <- 0
    first_true <- NULL
    first_false <- NULL
    text_empty_count <- 0
    text_min_length <- Inf
    text_max_length <- -Inf
    text_total_length <- 0
    numeric_minimum <- NULL
    numeric_maximum <- NULL
    numeric_finite_count <- 0
    numeric_mean <- 0
    numeric_m2 <- 0
    numeric_sum <- 0
    numeric_has_nonfinite <- FALSE
    exact_sum <- "0"
    exact_minimum <- NULL
    exact_maximum <- NULL
    datetime_minimum <- NULL
    datetime_maximum <- NULL
    datetime_minimum_source <- NULL
    datetime_maximum_source <- NULL

    start <- 1
    while (start <= row_count) {
      count <- min(maximum_profile_chunk_rows, row_count - start + 1)
      source_positions <- profile_chunk_source_positions(row_positions, start, count)
      chunk <- column[source_positions]
      validate_profile_column(chunk, semantics, label)
      missing <- profile_missing_masks(chunk, semantics)
      null_count <- null_count + sum(missing$null)
      nan_count <- nan_count + sum(missing$nan)
      present_indices <- which(!missing$null & !missing$nan)
      chunk_present_count <- length(present_indices)
      present_count <- present_count + chunk_present_count

      if (chunk_present_count != 0L) {
        present <- chunk[present_indices]
        visible_positions <- seq.int(as.integer(start), length.out = as.integer(count))[present_indices]
        present_sources <- source_positions[present_indices]

        if (kind == "logical") {
          chunk_true <- sum(present)
          chunk_false <- chunk_present_count - chunk_true
          if (is.null(first_true) && chunk_true > 0) first_true <- visible_positions[[which(present)[[1L]]]]
          if (is.null(first_false) && chunk_false > 0) first_false <- visible_positions[[which(!present)[[1L]]]]
          true_count <- true_count + chunk_true
          false_count <- false_count + chunk_false
        } else if (kind %in% c("character", "factor")) {
          text_values <- if (kind == "factor") as.character(present) else present
          text_values <- vapply(
            seq_along(text_values),
            function(index) bounded_utf8(text_values[[index]], sprintf("profile value %d", visible_positions[[index]])),
            character(1L),
            USE.NAMES = FALSE
          )
          lengths <- nchar(text_values, type = "chars", allowNA = FALSE, keepNA = FALSE)
          text_empty_count <- text_empty_count + sum(lengths == 0L)
          text_min_length <- min(text_min_length, min(lengths))
          text_max_length <- max(text_max_length, max(lengths))
          text_total_length <- text_total_length + sum(as.double(lengths))
        } else if (kind %in% c("date", "datetime")) {
          values <- as.double(present)
          chunk_minimum <- which.min(values)
          chunk_maximum <- which.max(values)
          if (is.null(datetime_minimum) || values[[chunk_minimum]] < datetime_minimum) {
            datetime_minimum <- values[[chunk_minimum]]
            datetime_minimum_source <- present_sources[[chunk_minimum]]
          }
          if (is.null(datetime_maximum) || values[[chunk_maximum]] > datetime_maximum) {
            datetime_maximum <- values[[chunk_maximum]]
            datetime_maximum_source <- present_sources[[chunk_maximum]]
          }
        } else if (kind %in% c("integer", "integer64", "double", "difftime")) {
          values <- numeric_profile_values(chunk, semantics, present_indices)
          chunk_minimum <- suppressWarnings(min(values))
          chunk_maximum <- suppressWarnings(max(values))
          if (is.null(numeric_minimum) || chunk_minimum < numeric_minimum) numeric_minimum <- chunk_minimum
          if (is.null(numeric_maximum) || chunk_maximum > numeric_maximum) numeric_maximum <- chunk_maximum
          finite_values <- values[is.finite(values)]
          numeric_has_nonfinite <- numeric_has_nonfinite || length(finite_values) != length(values)
          if (length(finite_values) != 0L) {
            numeric_sum <- numeric_sum + sum(finite_values)
            chunk_finite_count <- length(finite_values)
            chunk_mean <- mean(finite_values)
            chunk_m2 <- sum((finite_values - chunk_mean)^2)
            if (numeric_finite_count == 0) {
              numeric_mean <- chunk_mean
              numeric_m2 <- chunk_m2
            } else {
              combined_count <- numeric_finite_count + chunk_finite_count
              delta <- chunk_mean - numeric_mean
              numeric_mean <- numeric_mean + delta * chunk_finite_count / combined_count
              numeric_m2 <- numeric_m2 + chunk_m2 + delta^2 * numeric_finite_count * chunk_finite_count / combined_count
            }
            numeric_finite_count <- numeric_finite_count + chunk_finite_count
          }
          if (kind %in% c("integer", "integer64")) {
            exact_sum <- add_signed_decimal(exact_sum, exact_integer_sum_text(present, kind))
            if (kind == "integer64") {
              ascending <- order_integer64(present, FALSE)
              candidate_minimum <- as.character(unname(present[ascending[[1L]]]))
              candidate_maximum <- as.character(unname(present[ascending[[length(ascending)]]]))
            } else {
              candidate_minimum <- as.character(min(present))
              candidate_maximum <- as.character(max(present))
            }
            if (is.null(exact_minimum) || compare_integer_text(candidate_minimum, exact_minimum) < 0L) {
              exact_minimum <- candidate_minimum
            }
            if (is.null(exact_maximum) || compare_integer_text(candidate_maximum, exact_maximum) > 0L) {
              exact_maximum <- candidate_maximum
            }
          }
        }
      }
      start <- start + count
    }

    distribution_sampled <- present_count > maximum_profile_sample_rows
    sample_size <- if (kind == "logical" || (distribution_sampled && kind %in% c("date", "datetime"))) {
      0L
    } else {
      as.integer(min(as.double(present_count), as.double(maximum_profile_sample_rows)))
    }
    sample_sources <- integer(sample_size)
    if (sample_size != 0L) {
      sample_ranks <- deterministic_sample_positions(present_count, sample_size)
      sampled <- 0L
      seen_present <- 0
      start <- 1
      while (start <= row_count && sampled < sample_size) {
        count <- min(maximum_profile_chunk_rows, row_count - start + 1)
        source_positions <- profile_chunk_source_positions(row_positions, start, count)
        chunk <- column[source_positions]
        missing <- profile_missing_masks(chunk, semantics)
        present_sources <- source_positions[which(!missing$null & !missing$nan)]
        next_seen <- seen_present + length(present_sources)
        first_target <- findInterval(seen_present, sample_ranks) + 1L
        last_target <- findInterval(next_seen, sample_ranks)
        if (first_target <= last_target) {
          targets <- sample_ranks[seq.int(first_target, last_target)]
          selected <- present_sources[as.integer(targets - seen_present)]
          destination <- seq.int(sampled + 1L, length.out = length(selected))
          sample_sources[destination] <- selected
          sampled <- sampled + length(selected)
        }
        seen_present <- next_seen
        start <- start + count
      }
      if (sampled != sample_size) abort("internal-error", "the R profile sample is incomplete")
    }

    sample_column <- column[sample_sources]
    sample_indices <- seq_len(sample_size)
    if (kind == "logical") {
      entries <- list()
      if (true_count > 0) entries[[length(entries) + 1L]] <- list(value = "TRUE", count = true_count, first = first_true)
      if (false_count > 0) entries[[length(entries) + 1L]] <- list(value = "FALSE", count = false_count, first = first_false)
      if (length(entries) != 0L) {
        priority <- base::order(
          -vapply(entries, `[[`, double(1L), "count"),
          vapply(entries, `[[`, double(1L), "first"),
          method = "radix"
        )
        entries <- lapply(entries[priority], function(entry) {
          spend_json_string(budget, entry$value, paste0(label, " top value"))
          list(value = entry$value, count = as.integer(entry$count))
        })
      }
      counts <- list(
        distinctCount = as.integer((true_count > 0) + (false_count > 0)),
        topValues = json_array(entries),
        keys = character()
      )
    } else if (distribution_sampled && kind %in% c("date", "datetime")) {
      counts <- list(distinctCount = NULL, topValues = json_array(list()), keys = character())
    } else {
      counts <- profile_value_counts(sample_column, semantics, sample_indices, budget, label)
    }

    summary <- list(
      columnId = descriptor$id,
      column = descriptor$name,
      type = descriptor$type,
      rawType = descriptor$rawType,
      totalCount = as.double(row_count),
      nullCount = as.integer(null_count),
      nanCount = as.integer(nan_count),
      topValues = if (distribution_sampled && kind %in% c("integer", "integer64", "double", "difftime")) {
        json_array(list())
      } else {
        counts$topValues
      }
    )
    if (!distribution_sampled || kind == "logical") summary$distinctCount <- counts$distinctCount

    if (kind %in% c("integer", "integer64", "double", "difftime")) {
      numeric <- list()
      if (kind %in% c("integer", "integer64")) {
        numeric$exactSum <- exact_profile_integer_text_cell(exact_sum, budget, paste0(label, " sum"))
        sum_value <- finite_statistic(suppressWarnings(as.double(exact_sum)))
      } else if (!numeric_has_nonfinite) {
        sum_value <- finite_statistic(numeric_sum)
      } else {
        sum_value <- NULL
      }
      if (!is.null(sum_value)) numeric$sum <- sum_value
      minimum <- finite_statistic(numeric_minimum)
      maximum <- finite_statistic(numeric_maximum)
      if (!is.null(minimum)) numeric$min <- minimum
      if (!is.null(maximum)) numeric$max <- maximum
      if (!numeric_has_nonfinite && numeric_finite_count != 0) {
        mean_value <- finite_statistic(numeric_mean)
        if (!is.null(mean_value)) numeric$mean <- mean_value
        if (numeric_finite_count >= 2) {
          standard_deviation <- finite_statistic(sqrt(numeric_m2 / (numeric_finite_count - 1)))
          if (!is.null(standard_deviation)) numeric$std <- standard_deviation
        }
      }
      sample_values <- numeric_profile_values(sample_column, semantics, sample_indices)
      if (!distribution_sampled && length(sample_values) != 0L) {
        median_value <- finite_statistic(suppressWarnings(stats::median(sample_values)))
        if (!is.null(median_value)) numeric$median <- median_value
      }
      if (!is.null(exact_minimum) && !is.null(exact_maximum)) {
        numeric$exactMin <- exact_profile_integer_text_cell(exact_minimum, budget, paste0(label, " minimum"))
        numeric$exactMax <- exact_profile_integer_text_cell(exact_maximum, budget, paste0(label, " maximum"))
      }
      if (length(numeric) != 0L) summary$numeric <- numeric
      finite_keys <- counts$keys[is.finite(sample_values)]
      visualization <- numeric_histogram(sample_values, length(unique(finite_keys)))
      if (!is.null(visualization)) {
        if (distribution_sampled) visualization$sampled <- TRUE
        summary$visualization <- visualization
      }
    } else if (kind == "logical") {
      summary$visualization <- list(
        kind = "boolean",
        trueCount = as.integer(true_count),
        falseCount = as.integer(false_count)
      )
    } else if (kind %in% c("date", "datetime")) {
      summary$visualization <- if (present_count == 0) {
        list(kind = "datetime")
      } else {
        list(
          kind = "datetime",
          min = encode_value(column, semantics, datetime_minimum_source, paste0(label, " minimum"), budget)$display,
          max = encode_value(column, semantics, datetime_maximum_source, paste0(label, " maximum"), budget)$display
        )
      }
    } else if (kind %in% c("character", "factor")) {
      summary$text <- if (present_count == 0) {
        list(emptyCount = 0L)
      } else {
        list(
          emptyCount = as.integer(text_empty_count),
          minLength = as.integer(text_min_length),
          maxLength = as.integer(text_max_length),
          meanLength = as.double(text_total_length / present_count)
        )
      }
      visualization <- list(
        kind = "categorical",
        categories = counts$topValues,
        otherCount = as.integer(sample_size - sum(vapply(counts$topValues, `[[`, integer(1L), "count")))
      )
      if (distribution_sampled) visualization$sampled <- TRUE
      summary$visualization <- visualization
    }
    summary
  }

  new_capture_metrics <- function() {
    metrics <- new.env(parent = emptyenv())
    metrics$nullableScans <- 0
    metrics$sourceReads <- 0
    metrics$directPageSlices <- 0
    metrics$directRowPositions <- 0
    metrics$sortOrderBuilds <- 0
    metrics$sortOrderRows <- 0
    metrics$sortColumnSnapshots <- 0
    metrics$profileColumns <- 0
    metrics$datasetProfiles <- 0
    metrics
  }

  add_metric <- function(metrics, name, amount = 1) {
    metrics[[name]] <- metrics[[name]] + as.double(amount)
  }

  inspect_frame <- function(value, conservative_nullable, validate_values, metrics) {
    if (!is.data.frame(value)) {
      abort("unsupported-frame", "the value is not an R dataframe")
    }
    row_count <- as.integer(validate_frame_structure(value))
    value <- normalize_supported_frame(value)
    flavor <- frame_flavor(value)
    assert_frame_attributes(value, flavor)
    column_count <- storage_length(value)
    whole_number(row_count, "row count", maximum_rows)
    whole_number(column_count, "column count", maximum_columns)
    metadata_budget <- new_payload_budget()
    spend_payload_budget(metadata_budget, metadata_base_bytes, "R frame metadata")
    column_names <- attr(value, "names", exact = TRUE)
    if (!is.character(column_names) || storage_length(column_names) != column_count) {
      abort("invalid-schema", "the dataframe does not have one name per column")
    }
    column_names <- plain_metadata_storage(column_names)
    column_names <- vapply(
      seq_along(column_names),
      function(index) bounded_utf8(
        .subset2(column_names, index),
        sprintf("column name %d", index),
        maximum_name_bytes
      ),
      character(1L),
      USE.NAMES = FALSE
    )
    for (index in seq_along(column_names)) {
      spend_json_string(
        metadata_budget,
        .subset2(column_names, index),
        sprintf("column name %d", index)
      )
    }

    schema <- lapply(seq_len(column_count), function(index) {
      spend_payload_budget(metadata_budget, column_fixed_bytes, sprintf("column %d metadata", index))
      semantics <- column_semantics(
        .subset2(value, index),
        sprintf("column %d", index),
        metadata_budget,
        validate_values = validate_values
      )
      nullable <- if (isTRUE(conservative_nullable)) {
        TRUE
      } else {
        add_metric(metrics, "nullableScans")
        column_has_missing(.subset2(value, index), semantics)
      }
      list(
        id = sprintf("r:c:%d", index - 1L),
        name = .subset2(column_names, index),
        position = index - 1L,
        rawType = raw_column_type(semantics),
        type = public_column_type(semantics$kind),
        nullable = nullable,
        semantics = semantics
      )
    })

    descriptor <- list(
      contractVersion = contract_version,
      dataframeFlavor = flavor,
      shape = list(rows = row_count, columns = column_count),
      frameSemantics = list(
        classes = bounded_text_array(class(value), "frame classes", maximum_name_bytes, metadata_budget),
        rowNames = if (.row_names_info(value, type = 1L) > 0L) "explicit" else "positional",
        keyColumnIds = key_column_ids(value, flavor, column_names, metadata_budget)
      ),
      schema = json_array(schema)
    )
    list(descriptor = descriptor, metadataBytes = metadata_budget$used, flavor = flavor)
  }

  new_sort_cache <- function() {
    cache <- new.env(parent = emptyenv())
    cache$valid <- FALSE
    cache$rules <- list()
    cache$rowPositions <- integer()
    cache$columns <- list()
    cache$bytes <- 0
    cache
  }

  clear_sort_cache <- function(cache) {
    cache$valid <- FALSE
    cache$rules <- list()
    cache$rowPositions <- integer()
    cache$columns <- list()
    cache$bytes <- 0
    invisible(NULL)
  }

  set_sequential_row_origins <- function(capture, row_count, row_identity_domain, offset = 0L) {
    if (
      !is.numeric(row_count) || !is.null(attributes(row_count)) ||
        length(row_count) != 1L || is.na(row_count) ||
        !is.finite(row_count) || row_count < 0 || row_count != floor(row_count) ||
        !is.numeric(row_identity_domain) || length(row_identity_domain) != 1L ||
        !is.null(attributes(row_identity_domain)) ||
        is.na(row_identity_domain) || !is.finite(row_identity_domain) ||
        row_identity_domain < row_count || row_identity_domain != floor(row_identity_domain) ||
        !is.numeric(offset) || !is.null(attributes(offset)) ||
        length(offset) != 1L || is.na(offset) ||
        !is.finite(offset) || offset < 0 || offset != floor(offset) ||
        as.double(offset) + as.double(row_count) > as.double(row_identity_domain)
    ) {
      abort("internal-error", "an R capture has invalid sequential row identities")
    }
    capture$rowOriginKind <- "sequential"
    capture$rowOriginOffset <- offset
    capture$rowOrigins <- numeric()
    capture$rowIdentityDomain <- row_identity_domain
    invisible(NULL)
  }

  set_row_origins <- function(capture, row_origins, row_identity_domain, row_count) {
    if (
      !is.numeric(row_count) || !is.null(attributes(row_count)) ||
        length(row_count) != 1L || is.na(row_count) || !is.finite(row_count) ||
        row_count < 0 || row_count != floor(row_count) ||
        !is.numeric(row_origins) || !is.null(attributes(row_origins)) ||
        !is.numeric(row_identity_domain) || length(row_identity_domain) != 1L ||
        !is.null(attributes(row_identity_domain)) ||
        is.na(row_identity_domain) || !is.finite(row_identity_domain) ||
        row_identity_domain < row_count || row_identity_domain != floor(row_identity_domain) ||
        length(row_origins) != row_count || anyNA(row_origins) ||
        any(!is.finite(row_origins)) || any(row_origins != floor(row_origins)) ||
        any(row_origins < 1L) || any(row_origins > row_identity_domain) ||
        anyDuplicated(row_origins)
    ) {
      abort("internal-error", "an R capture has invalid stable row identities")
    }
    if (row_count == 0L) {
      set_sequential_row_origins(capture, row_count, row_identity_domain)
      return(invisible(NULL))
    }
    offset <- if (is.integer(row_origins)) row_origins[[1L]] - 1L else row_origins[[1L]] - 1
    expected <- seq.int(offset + 1, length.out = row_count)
    sequential <- if (is.integer(row_origins)) {
      identical(row_origins, expected)
    } else {
      identical(row_origins, as.double(expected))
    }
    if (sequential) {
      set_sequential_row_origins(capture, row_count, row_identity_domain, offset)
      return(invisible(NULL))
    }
    capture$rowOriginKind <- "mapped"
    capture$rowOriginOffset <- 0
    capture$rowOrigins <- row_origins
    capture$rowIdentityDomain <- row_identity_domain
    invisible(NULL)
  }

  capture_row_origins_at <- function(capture, positions) {
    if (identical(capture$rowOriginKind, "sequential")) {
      return(capture$rowOriginOffset + positions)
    }
    capture$rowOrigins[positions]
  }

  capture_row_origin_at <- function(capture, position) {
    if (identical(capture$rowOriginKind, "sequential")) {
      return(capture$rowOriginOffset + position)
    }
    capture$rowOrigins[[position]]
  }

  finish_capture <- function(capture) {
    class(capture) <- "openwrangler_r_frame_capture"
    lockEnvironment(capture, bindings = TRUE)
    capture
  }

  capture_frame <- function(
    value,
    nullability_source = NULL,
    source_positions = NULL,
    source_row_positions = NULL,
    output_ids = NULL,
    categorical_positions = NULL,
    by_example_positions = NULL,
    by_example_kinds = NULL,
    formula_positions = NULL,
    formula_right_source_positions = NULL,
    text_length_positions = NULL,
    text_transform_positions = NULL,
    numeric_transform_positions = NULL,
    min_max_scale_positions = NULL,
    datetime_format_positions = NULL,
    fill_missing_positions = NULL,
    fallback_fill_positions = NULL,
    cast_positions = NULL,
    cast_dtypes = NULL,
    preserve_data_table_element_names = FALSE
  ) {
    if (!is.data.frame(value)) {
      abort("unsupported-frame", "the value is not an R dataframe")
    }
    validate_frame_structure(value)
    if (
      !is.logical(preserve_data_table_element_names) ||
        length(preserve_data_table_element_names) != 1L ||
        is.na(preserve_data_table_element_names)
    ) {
      abort("internal-error", "the data.table element-name preservation flag is invalid")
    }
    if (!is.null(nullability_source)) validate_capture(nullability_source)
    if (
      is.null(nullability_source) &&
        (
          !is.null(source_positions) ||
            !is.null(source_row_positions) ||
            !is.null(output_ids) ||
            !is.null(categorical_positions) ||
            !is.null(by_example_positions) ||
            !is.null(by_example_kinds) ||
            !is.null(formula_positions) ||
            !is.null(formula_right_source_positions) ||
            !is.null(text_length_positions) ||
            !is.null(text_transform_positions) ||
            !is.null(numeric_transform_positions) ||
            !is.null(min_max_scale_positions) ||
            !is.null(datetime_format_positions) ||
            !is.null(fill_missing_positions) ||
            !is.null(fallback_fill_positions) ||
            !is.null(cast_positions) ||
            !is.null(cast_dtypes)
        )
    ) {
      abort("internal-error", "derived R column mappings require a source R capture")
    }
    if (!is.null(output_ids) && is.null(source_positions)) {
      abort("internal-error", "explicit R output IDs require a source-column mapping")
    }
    if (!is.null(categorical_positions) && (is.null(source_positions) || is.null(output_ids))) {
      abort("internal-error", "R categorical outputs require explicit source mappings and identities")
    }
    if (xor(is.null(by_example_positions), is.null(by_example_kinds))) {
      abort("internal-error", "R by-example outputs require positions and semantic kinds together")
    }
    if (!is.null(by_example_positions) && (is.null(source_positions) || is.null(output_ids))) {
      abort("internal-error", "R by-example outputs require explicit source mappings and identities")
    }
    if (!is.null(formula_positions) && (is.null(source_positions) || is.null(output_ids))) {
      abort("internal-error", "R formula outputs require explicit source mappings and identities")
    }
    if (!is.null(formula_right_source_positions) && is.null(formula_positions)) {
      abort("internal-error", "R formula right operands require formula output positions")
    }
    if (!is.null(text_length_positions) && (is.null(source_positions) || is.null(output_ids))) {
      abort("internal-error", "R text-length outputs require explicit source mappings and identities")
    }
    if (!is.null(text_transform_positions) && is.null(source_positions)) {
      abort("internal-error", "R text-transform outputs require explicit source mappings")
    }
    if (!is.null(numeric_transform_positions) && is.null(source_positions)) {
      abort("internal-error", "R numeric-transform outputs require explicit source mappings")
    }
    if (!is.null(min_max_scale_positions) && is.null(source_positions)) {
      abort("internal-error", "R min-max scale outputs require explicit source mappings")
    }
    if (!is.null(datetime_format_positions) && is.null(source_positions)) {
      abort("internal-error", "R datetime-format outputs require explicit source mappings")
    }
    if (!is.null(fill_missing_positions) && is.null(source_positions)) {
      abort("internal-error", "R fill-missing outputs require explicit source mappings")
    }
    if (!is.null(fallback_fill_positions) && is.null(source_positions)) {
      abort("internal-error", "R fallback-fill outputs require explicit source mappings")
    }
    if (xor(is.null(cast_positions), is.null(cast_dtypes))) {
      abort("internal-error", "R cast outputs require positions and target dtypes together")
    }
    if (!is.null(cast_positions) && is.null(source_positions)) {
      abort("internal-error", "R cast outputs require explicit source mappings")
    }
    value <- normalize_supported_frame(value)
    flavor <- frame_flavor(value)
    source_element_names <- if (
      isTRUE(preserve_data_table_element_names) &&
        identical(flavor, "r.data.table")
    ) {
      lapply(seq_len(storage_length(value)), function(position) {
        attr(.subset2(value, position), "names", exact = TRUE)
      })
    } else {
      NULL
    }
    snapshot <- isolated_snapshot(value, flavor)
    if (!is.null(source_element_names)) {
      for (position in seq_along(source_element_names)) {
        if (!is.null(source_element_names[[position]])) {
          data.table::setattr(.subset2(snapshot, position), "names", source_element_names[[position]])
        }
      }
    }
    assert_frame_attributes(snapshot, flavor)
    metrics <- new_capture_metrics()
    inspected <- inspect_frame(
      snapshot,
      conservative_nullable = !is.null(nullability_source),
      validate_values = TRUE,
      metrics = metrics
    )
    row_count <- inspected$descriptor$shape$rows
    if (!is.null(nullability_source) && row_count == 0L) {
      # An empty derived base data.frame has no row.names payload from which R
      # can recover whether the source used automatic or explicit row names.
      # The source capture remains authoritative until rows exist again.
      inspected$descriptor$frameSemantics$rowNames <-
        nullability_source$descriptor$frameSemantics$rowNames
    }
    row_identity_domain <- if (is.null(nullability_source)) {
      row_count
    } else {
      nullability_source$rowIdentityDomain
    }
    row_origins <- if (is.null(nullability_source)) {
      NULL
    } else {
      source_row_count <- nullability_source$descriptor$shape$rows
      if (is.null(source_row_positions)) {
        if (row_count != source_row_count) {
          abort("internal-error", "a derived R frame changed height without a source-row mapping")
        }
        source_row_positions <- seq_len(source_row_count)
      }
      if (
        !is.numeric(source_row_positions) ||
          anyNA(source_row_positions) ||
          any(!is.finite(source_row_positions)) ||
          any(source_row_positions != floor(source_row_positions)) ||
          length(source_row_positions) != row_count ||
          any(source_row_positions < 1L) ||
          any(source_row_positions > source_row_count) ||
          anyDuplicated(source_row_positions)
      ) {
        abort("internal-error", "a derived R frame has an invalid source-row mapping")
      }
      capture_row_origins_at(nullability_source, as.integer(source_row_positions))
    }
    if (!is.null(nullability_source)) {
      source_schema <- plain_metadata_storage(nullability_source$descriptor$schema)
      output_schema <- plain_metadata_storage(inspected$descriptor$schema)
      if (is.null(source_positions)) {
        if (length(source_schema) != length(output_schema)) {
          abort("internal-error", "a derived R frame changed width without a source-column mapping")
        }
        source_positions <- seq_along(source_schema)
      }
      if (
        !is.numeric(source_positions) ||
          anyNA(source_positions) ||
          any(!is.finite(source_positions)) ||
          any(source_positions != floor(source_positions)) ||
          length(source_positions) != length(output_schema) ||
          any(source_positions < 1L) ||
          any(source_positions > length(source_schema)) ||
          (is.null(output_ids) && anyDuplicated(source_positions))
      ) {
        abort("internal-error", "a derived R frame has an invalid source-column mapping")
      }
      source_positions <- as.integer(source_positions)
      if (is.null(categorical_positions)) {
        categorical_positions <- integer()
      } else {
        if (
          !is.numeric(categorical_positions) ||
            anyNA(categorical_positions) ||
            any(!is.finite(categorical_positions)) ||
            any(categorical_positions != floor(categorical_positions)) ||
            any(categorical_positions < 1L) ||
            any(categorical_positions > length(output_schema)) ||
            anyDuplicated(categorical_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid categorical output positions")
        }
        categorical_positions <- as.integer(categorical_positions)
      }
      if (is.null(by_example_positions)) {
        by_example_positions <- integer()
        by_example_kinds <- character()
      } else {
        if (
          !is.numeric(by_example_positions) ||
            anyNA(by_example_positions) ||
            any(!is.finite(by_example_positions)) ||
            any(by_example_positions != floor(by_example_positions)) ||
            any(by_example_positions < 1L) ||
            any(by_example_positions > length(output_schema)) ||
            anyDuplicated(by_example_positions) ||
            !is.character(by_example_kinds) ||
            anyNA(by_example_kinds) ||
            length(by_example_kinds) != length(by_example_positions) ||
            any(!by_example_kinds %in% c(
              "character",
              "factor",
              "integer",
              "integer64",
              "double",
              "logical",
              "date",
              "datetime",
              "difftime"
            ))
        ) {
          abort("internal-error", "a derived R frame has invalid by-example output metadata")
        }
        by_example_positions <- as.integer(by_example_positions)
      }
      if (is.null(formula_positions)) {
        formula_positions <- integer()
      } else {
        if (
          !is.numeric(formula_positions) ||
            anyNA(formula_positions) ||
            any(!is.finite(formula_positions)) ||
            any(formula_positions != floor(formula_positions)) ||
            any(formula_positions < 1L) ||
            any(formula_positions > length(output_schema)) ||
            anyDuplicated(formula_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid formula output positions")
        }
        formula_positions <- as.integer(formula_positions)
      }
      if (is.null(formula_right_source_positions)) {
        formula_right_source_positions <- rep.int(0L, length(formula_positions))
      } else {
        if (
          !is.numeric(formula_right_source_positions) ||
            anyNA(formula_right_source_positions) ||
            any(!is.finite(formula_right_source_positions)) ||
            any(formula_right_source_positions != floor(formula_right_source_positions)) ||
            length(formula_right_source_positions) != length(formula_positions) ||
            any(formula_right_source_positions < 0L) ||
            any(formula_right_source_positions > length(source_schema))
        ) {
          abort("internal-error", "a derived R frame has invalid formula right-operand mappings")
        }
        formula_right_source_positions <- as.integer(formula_right_source_positions)
      }
      if (is.null(text_length_positions)) {
        text_length_positions <- integer()
      } else {
        if (
          !is.numeric(text_length_positions) ||
            anyNA(text_length_positions) ||
            any(!is.finite(text_length_positions)) ||
            any(text_length_positions != floor(text_length_positions)) ||
            any(text_length_positions < 1L) ||
            any(text_length_positions > length(output_schema)) ||
            anyDuplicated(text_length_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid text-length output positions")
        }
        text_length_positions <- as.integer(text_length_positions)
      }
      if (is.null(text_transform_positions)) {
        text_transform_positions <- integer()
      } else {
        if (
          !is.numeric(text_transform_positions) ||
            anyNA(text_transform_positions) ||
            any(!is.finite(text_transform_positions)) ||
            any(text_transform_positions != floor(text_transform_positions)) ||
            any(text_transform_positions < 1L) ||
            any(text_transform_positions > length(output_schema)) ||
            anyDuplicated(text_transform_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid text-transform output positions")
        }
        text_transform_positions <- as.integer(text_transform_positions)
      }
      if (is.null(numeric_transform_positions)) {
        numeric_transform_positions <- integer()
      } else {
        if (
          !is.numeric(numeric_transform_positions) ||
            anyNA(numeric_transform_positions) ||
            any(!is.finite(numeric_transform_positions)) ||
            any(numeric_transform_positions != floor(numeric_transform_positions)) ||
            any(numeric_transform_positions < 1L) ||
            any(numeric_transform_positions > length(output_schema)) ||
            anyDuplicated(numeric_transform_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid numeric-transform output positions")
        }
        numeric_transform_positions <- as.integer(numeric_transform_positions)
      }
      if (is.null(min_max_scale_positions)) {
        min_max_scale_positions <- integer()
      } else {
        if (
          !is.numeric(min_max_scale_positions) ||
            anyNA(min_max_scale_positions) ||
            any(!is.finite(min_max_scale_positions)) ||
            any(min_max_scale_positions != floor(min_max_scale_positions)) ||
            any(min_max_scale_positions < 1L) ||
            any(min_max_scale_positions > length(output_schema)) ||
            anyDuplicated(min_max_scale_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid min-max scale output positions")
        }
        min_max_scale_positions <- as.integer(min_max_scale_positions)
      }
      if (is.null(datetime_format_positions)) {
        datetime_format_positions <- integer()
      } else {
        if (
          !is.numeric(datetime_format_positions) ||
            anyNA(datetime_format_positions) ||
            any(!is.finite(datetime_format_positions)) ||
            any(datetime_format_positions != floor(datetime_format_positions)) ||
            any(datetime_format_positions < 1L) ||
            any(datetime_format_positions > length(output_schema)) ||
            anyDuplicated(datetime_format_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid datetime-format output positions")
        }
        datetime_format_positions <- as.integer(datetime_format_positions)
      }
      if (is.null(cast_positions)) {
        cast_positions <- integer()
        cast_dtypes <- character()
      } else {
        if (
          !is.numeric(cast_positions) ||
            anyNA(cast_positions) ||
            any(!is.finite(cast_positions)) ||
            any(cast_positions != floor(cast_positions)) ||
            any(cast_positions < 1L) ||
            any(cast_positions > length(output_schema)) ||
            anyDuplicated(cast_positions) ||
            !is.character(cast_dtypes) ||
            anyNA(cast_dtypes) ||
            length(cast_dtypes) != length(cast_positions) ||
            any(!cast_dtypes %in% c("string", "integer", "float", "boolean", "date", "datetime"))
        ) {
          abort("internal-error", "a derived R frame has invalid cast output metadata")
        }
        cast_positions <- as.integer(cast_positions)
      }
      if (is.null(fill_missing_positions)) {
        fill_missing_positions <- integer()
      } else {
        if (
          !is.numeric(fill_missing_positions) ||
            anyNA(fill_missing_positions) ||
            any(!is.finite(fill_missing_positions)) ||
            any(fill_missing_positions != floor(fill_missing_positions)) ||
            any(fill_missing_positions < 1L) ||
            any(fill_missing_positions > length(output_schema)) ||
            anyDuplicated(fill_missing_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid fill-missing output positions")
        }
        fill_missing_positions <- as.integer(fill_missing_positions)
      }
      if (is.null(fallback_fill_positions)) {
        fallback_fill_positions <- integer()
      } else {
        if (
          !is.numeric(fallback_fill_positions) ||
            anyNA(fallback_fill_positions) ||
            any(!is.finite(fallback_fill_positions)) ||
            any(fallback_fill_positions != floor(fallback_fill_positions)) ||
            any(fallback_fill_positions < 1L) ||
            any(fallback_fill_positions > length(output_schema)) ||
            anyDuplicated(fallback_fill_positions)
        ) {
          abort("internal-error", "a derived R frame has invalid fallback-fill output positions")
        }
        fallback_fill_positions <- as.integer(fallback_fill_positions)
      }
      transformed_positions <- c(
        categorical_positions,
        by_example_positions,
        formula_positions,
        text_length_positions,
        text_transform_positions,
        numeric_transform_positions,
        min_max_scale_positions,
        datetime_format_positions,
        fill_missing_positions,
        fallback_fill_positions,
        cast_positions
      )
      if (anyDuplicated(transformed_positions)) {
        abort("internal-error", "an R output cannot have more than one transformed-column mapping")
      }
      source_nullable <- vapply(source_positions, function(position) {
        value <- source_schema[[position]]$nullable
        if (length(value) != 1L || !is.logical(value) || is.na(value)) {
          abort("internal-error", "an R capture retained invalid nullability metadata")
        }
        value
      }, logical(1L), USE.NAMES = FALSE)

      generated_ids <- vapply(output_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
      mapped_source_ids <- vapply(source_positions, function(position) {
        source_schema[[position]]$id
      }, character(1L), USE.NAMES = FALSE)
      if (is.null(output_ids)) {
        output_ids <- mapped_source_ids
      } else {
        if (!is.character(output_ids) || length(output_ids) != length(output_schema) || anyNA(output_ids)) {
          abort("internal-error", "a derived R frame has invalid explicit output identities")
        }
        output_ids <- vapply(seq_along(output_ids), function(index) {
          bounded_utf8(output_ids[[index]], sprintf("output_ids[[%d]]", index), maximum_column_id_bytes)
        }, character(1L), USE.NAMES = FALSE)
        if (
          any(output_ids == "") ||
            anyDuplicated(output_ids) ||
            !all(vapply(output_ids, is_canonical_column_id, logical(1L), USE.NAMES = FALSE))
        ) {
          abort("internal-error", "a derived R frame has invalid explicit output identities")
        }
        source_ids <- vapply(source_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
        for (index in seq_along(output_ids)) {
          existing_position <- match(output_ids[[index]], source_ids)
          if (!is.na(existing_position) && existing_position != source_positions[[index]]) {
            abort("internal-error", "a derived R frame remapped an existing column identity")
          }
        }
        for (index in seq_along(output_ids)) {
          source_position <- source_positions[[index]]
          source_id <- source_ids[[source_position]]
          if (!identical(output_ids[[index]], source_id)) {
            if (index %in% categorical_positions) next
            prior_indices <- seq_len(index - 1L)
            if (
              length(prior_indices) == 0L ||
                !any(
                  source_positions[prior_indices] == source_position &
                    output_ids[prior_indices] == source_id
                )
            ) {
              abort("internal-error", "a derived R frame replaced a retained source identity")
            }
          }
        }
      }
      for (index in seq_along(output_schema)) {
        source_column <- source_schema[[source_positions[[index]]]]
        output_column <- output_schema[[index]]
        if (index %in% categorical_positions) {
          output_values <- snapshot[[index]]
          if (
            !identical(output_column$semantics$kind, "integer") ||
              identical(output_ids[[index]], mapped_source_ids[[index]]) ||
              anyNA(output_values) ||
              any(!output_values %in% c(0L, 1L))
          ) {
            abort("internal-error", "a derived R frame has an invalid categorical output")
          }
        } else if (index %in% by_example_positions) {
          by_example_index <- match(index, by_example_positions)
          if (
            identical(output_ids[[index]], mapped_source_ids[[index]]) ||
              !identical(output_column$semantics$kind, by_example_kinds[[by_example_index]])
          ) {
            abort("internal-error", "a derived R frame has an invalid by-example output")
          }
        } else if (index %in% formula_positions) {
          formula_index <- match(index, formula_positions)
          formula_right_position <- formula_right_source_positions[[formula_index]]
          formula_right_column <- if (formula_right_position == 0L) {
            NULL
          } else {
            source_schema[[formula_right_position]]
          }
          source_frame <- read_capture_frame(nullability_source, validated = TRUE)
          left_values <- source_frame[[source_positions[[index]]]]
          right_values <- if (formula_right_position == 0L) NULL else source_frame[[formula_right_position]]
          output_values <- snapshot[[index]]
          output_nan <- if (inherits(output_values, "integer64")) {
            rep.int(FALSE, storage_length(output_values))
          } else {
            is.nan(output_values)
          }
          output_infinite <- if (inherits(output_values, "integer64")) {
            rep.int(FALSE, storage_length(output_values))
          } else {
            is.infinite(output_values)
          }
          input_nan <- if (inherits(left_values, "integer64")) {
            rep.int(FALSE, storage_length(left_values))
          } else {
            is.nan(left_values)
          }
          input_infinite <- if (inherits(left_values, "integer64")) {
            rep.int(FALSE, storage_length(left_values))
          } else {
            is.infinite(left_values)
          }
          input_missing <- if (inherits(left_values, "integer64")) {
            integer64_missing_mask(left_values)
          } else {
            is.na(left_values) & !input_nan
          }
          if (!is.null(right_values)) {
            right_nan <- if (inherits(right_values, "integer64")) {
              rep.int(FALSE, storage_length(right_values))
            } else {
              is.nan(right_values)
            }
            right_infinite <- if (inherits(right_values, "integer64")) {
              rep.int(FALSE, storage_length(right_values))
            } else {
              is.infinite(right_values)
            }
            input_nan <- input_nan | right_nan
            input_infinite <- input_infinite | right_infinite
            input_missing <- input_missing | if (inherits(right_values, "integer64")) {
              integer64_missing_mask(right_values)
            } else {
              is.na(right_values) & !right_nan
            }
          }
          output_missing <- if (inherits(output_values, "integer64")) {
            integer64_missing_mask(output_values)
          } else {
            is.na(output_values) & !output_nan
          }
          if (
            !source_column$semantics$kind %in% c("integer", "double", "integer64") ||
              (!is.null(formula_right_column) &&
                !formula_right_column$semantics$kind %in% c("integer", "double", "integer64")) ||
              !output_column$semantics$kind %in% c("integer", "double", "integer64") ||
              identical(output_ids[[index]], mapped_source_ids[[index]]) ||
              any(output_nan & !input_nan) ||
              any(output_infinite & !input_infinite) ||
              any(output_missing & !input_missing)
          ) {
            abort("internal-error", "a derived R frame has an invalid formula output")
          }
        } else if (index %in% text_length_positions) {
          if (
            !source_column$semantics$kind %in% c("character", "factor") ||
              !identical(output_column$semantics$kind, "integer") ||
              identical(output_ids[[index]], mapped_source_ids[[index]])
          ) {
            abort("internal-error", "a derived R frame has an invalid text-length output")
          }
        } else if (index %in% text_transform_positions) {
          if (
            !source_column$semantics$kind %in% c("character", "factor") ||
              !identical(output_column$semantics$kind, "character")
          ) {
            abort("internal-error", "a derived R frame has an invalid text-transform output")
          }
        } else if (index %in% numeric_transform_positions) {
          expected_kind <- if (identical(source_column$semantics$kind, "integer64")) {
            "integer64"
          } else {
            "double"
          }
          if (
            !source_column$semantics$kind %in% c("integer", "double", "integer64") ||
              !identical(output_column$semantics$kind, expected_kind)
          ) {
            abort("internal-error", "a derived R frame has an invalid numeric-transform output")
          }
        } else if (index %in% min_max_scale_positions) {
          if (
            !source_column$semantics$kind %in% c("integer", "double", "integer64") ||
              !identical(output_column$semantics$kind, "double")
          ) {
            abort("internal-error", "a derived R frame has an invalid min-max scale output")
          }
        } else if (index %in% datetime_format_positions) {
          if (
            !source_column$semantics$kind %in% c("date", "datetime") ||
              !identical(output_column$semantics$kind, "character")
          ) {
            abort("internal-error", "a derived R frame has an invalid datetime-format output")
          }
        } else if (index %in% cast_positions) {
          cast_index <- match(index, cast_positions)
          dtype <- cast_dtypes[[cast_index]]
          expected_kind <- switch(
            dtype,
            string = "character",
            integer = if (identical(source_column$semantics$kind, "integer64")) "integer64" else "integer",
            float = "double",
            boolean = "logical",
            date = "date",
            datetime = "datetime"
          )
          if (
            !identical(output_ids[[index]], mapped_source_ids[[index]]) ||
              !identical(output_column$semantics$kind, expected_kind) ||
              (identical(dtype, "datetime") &&
                !identical(output_column$semantics$timezone, "UTC"))
          ) {
            abort("internal-error", "a derived R frame has an invalid cast output")
          }
        } else if (index %in% c(fill_missing_positions, fallback_fill_positions)) {
          source_semantics <- source_column$semantics
          output_semantics <- output_column$semantics
          factor_semantics_match <- FALSE
          if (
            identical(source_semantics$kind, "factor") &&
              identical(output_semantics$kind, "factor")
          ) {
            source_levels <- source_semantics$levels
            output_levels <- output_semantics$levels
            source_without_levels <- source_semantics
            output_without_levels <- output_semantics
            source_without_levels$levels <- NULL
            output_without_levels$levels <- NULL
            factor_semantics_match <-
              identical(source_without_levels, output_without_levels) &&
                length(output_levels) >= length(source_levels) &&
                (
                  index %in% fallback_fill_positions ||
                    length(output_levels) <= length(source_levels) + 1L
                ) &&
                identical(output_levels[seq_along(source_levels)], source_levels)
          }
          if (
            !identical(output_ids[[index]], mapped_source_ids[[index]]) ||
              !identical(output_column$rawType, source_column$rawType) ||
              !identical(output_column$type, source_column$type) ||
              (!identical(output_semantics, source_semantics) && !factor_semantics_match)
          ) {
            abort("internal-error", "a derived R frame has an invalid fill-missing output")
          }
        } else {
          if (
            !identical(output_column$rawType, source_column$rawType) ||
              !identical(output_column$type, source_column$type) ||
              !identical(output_column$semantics, source_column$semantics)
          ) {
            abort("internal-error", "a derived R frame changed retained column type metadata")
          }
        }
        output_schema[[index]]$id <- output_ids[[index]]
        output_schema[[index]]$nullable <- if (index %in% categorical_positions) {
          FALSE
        } else if (index %in% by_example_positions) {
          column_has_missing(snapshot[[index]], output_column$semantics)
        } else if (index %in% formula_positions) {
          formula_index <- match(index, formula_positions)
          formula_right_position <- formula_right_source_positions[[formula_index]]
          isTRUE(source_nullable[[index]]) ||
            (formula_right_position != 0L && isTRUE(source_schema[[formula_right_position]]$nullable)) ||
            column_has_missing(snapshot[[index]], output_column$semantics)
        } else if (index %in% fill_missing_positions) {
          FALSE
        } else if (index %in% fallback_fill_positions) {
          column_has_missing(snapshot[[index]], output_column$semantics)
        } else if (index %in% cast_positions) {
          isTRUE(source_nullable[[index]]) || column_has_missing(snapshot[[index]], output_column$semantics)
        } else if (index %in% text_transform_positions) {
          isTRUE(source_nullable[[index]]) || column_has_missing(snapshot[[index]], output_column$semantics)
        } else if (index %in% numeric_transform_positions) {
          isTRUE(source_nullable[[index]]) || column_has_missing(snapshot[[index]], output_column$semantics)
        } else if (index %in% min_max_scale_positions) {
          TRUE
        } else if (index %in% datetime_format_positions) {
          isTRUE(source_nullable[[index]]) || column_has_missing(snapshot[[index]], output_column$semantics)
        } else {
          source_nullable[[index]]
        }
      }
      inspected$descriptor$schema <- json_array(output_schema)

      old_id_bytes <- sum(vapply(generated_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
      new_id_bytes <- sum(vapply(output_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
      if (new_id_bytes > old_id_bytes) {
        budget <- new_payload_budget(inspected$metadataBytes)
        spend_payload_budget(budget, new_id_bytes - old_id_bytes, "derived R column identities")
        inspected$metadataBytes <- budget$used
      }

      generated_key_ids <- plain_metadata_storage(inspected$descriptor$frameSemantics$keyColumnIds)
      if (length(generated_key_ids) != 0L) {
        key_positions <- match(generated_key_ids, generated_ids)
        if (anyNA(key_positions)) {
          abort("internal-error", "a derived R frame retained an invalid data.table key")
        }
        retained_key_ids <- output_ids[key_positions]
        old_key_bytes <- sum(vapply(generated_key_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
        new_key_bytes <- sum(vapply(retained_key_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
        if (new_key_bytes > old_key_bytes) {
          budget <- new_payload_budget(inspected$metadataBytes)
          spend_payload_budget(budget, new_key_bytes - old_key_bytes, "derived data.table key metadata")
          inspected$metadataBytes <- budget$used
        }
        inspected$descriptor$frameSemantics$keyColumnIds <- json_array(retained_key_ids)
      }
    }
    capture <- new.env(parent = emptyenv())
    capture$mode <- "isolated"
    capture$snapshot <- snapshot
    capture$sourceReader <- NULL
    capture$descriptor <- inspected$descriptor
    if (is.null(row_origins)) {
      set_sequential_row_origins(capture, row_count, row_identity_domain)
    } else {
      set_row_origins(capture, row_origins, row_identity_domain, row_count)
    }
    capture$metadataBytes <- inspected$metadataBytes
    capture$metrics <- metrics
    capture$sortCache <- new_sort_cache()
    finish_capture(capture)
  }

  validate_categorical_result <- function(result, source_capture) {
    validate_capture(source_capture)
    expected_fields <- base::sort.int(c(
      "categoricalPositions",
      "generatedNames",
      "guard",
      "sourcePositions",
      "sourceSignature",
      "value"
    ), method = "radix")
    if (
      !is.environment(result) ||
        !identical(class(result), "openwrangler_r_categorical_result") ||
        !environmentIsLocked(result) ||
        !identical(parent.env(result), emptyenv()) ||
        !identical(base::sort.int(ls(envir = result, all.names = TRUE), method = "radix"), expected_fields) ||
        any(vapply(expected_fields, bindingIsActive, logical(1L), env = result)) ||
        !identical(result$guard, categorical_result_guard)
    ) {
      abort("internal-error", "capture_categorical_result received an invalid categorical result")
    }
    if (!is.data.frame(result$value)) {
      abort("internal-error", "an R categorical result has an invalid output frame")
    }
    validate_frame_structure(result$value)
    output_count <- storage_length(result$value)
    source_count <- source_capture$descriptor$shape$columns
    source_positions <- result$sourcePositions
    categorical_positions <- result$categoricalPositions
    generated_names <- result$generatedNames
    if (
      !is.integer(source_positions) ||
        !is.null(attributes(source_positions)) ||
        length(source_positions) != output_count ||
        anyNA(source_positions) ||
        any(source_positions < 1L) ||
        any(source_positions > source_count)
    ) {
      abort("internal-error", "an R categorical result has invalid source-column mappings")
    }
    if (
      !is.integer(categorical_positions) ||
        !is.null(attributes(categorical_positions)) ||
        length(categorical_positions) == 0L ||
        anyNA(categorical_positions) ||
        any(categorical_positions < 1L) ||
        any(categorical_positions > output_count) ||
        anyDuplicated(categorical_positions)
    ) {
      abort("internal-error", "an R categorical result has invalid generated-column positions")
    }
    expected_categorical_positions <- if (length(categorical_positions) == 0L) {
      integer()
    } else {
      seq.int(output_count - length(categorical_positions) + 1L, output_count)
    }
    if (!identical(categorical_positions, as.integer(expected_categorical_positions))) {
      abort("internal-error", "an R categorical result did not append its generated columns")
    }
    if (
      !is.character(generated_names) ||
        !is.null(attributes(generated_names)) ||
        anyNA(generated_names) ||
        length(generated_names) != length(categorical_positions)
    ) {
      abort("internal-error", "an R categorical result has invalid generated-column names")
    }
    generated_names <- vapply(seq_along(generated_names), function(index) {
      bounded_utf8(
        generated_names[[index]],
        sprintf("categorical generated name %d", index),
        maximum_name_bytes
      )
    }, character(1L), USE.NAMES = FALSE)
    output_names <- attr(result$value, "names", exact = TRUE)
    if (
      !identical(.subset(output_names, categorical_positions), generated_names) ||
        any(generated_names == "") ||
        anyDuplicated(generated_names) ||
        any(vapply(generated_names, is_private_column_name, logical(1L), USE.NAMES = FALSE)) ||
        !identical(categorical_utf8_order(generated_names), seq_along(generated_names))
    ) {
      abort("internal-error", "an R categorical result has inconsistent generated-column names")
    }
    retained_positions <- without_values(seq_len(output_count), categorical_positions)
    if (
      anyDuplicated(source_positions[retained_positions]) ||
        any(generated_names %in% output_names[retained_positions])
    ) {
      abort("internal-error", "an R categorical result has conflicting output mappings")
    }
    source_schema <- plain_metadata_storage(source_capture$descriptor$schema)
    for (output_position in retained_positions) {
      source_position <- source_positions[[output_position]]
      if (!identical(output_names[[output_position]], source_schema[[source_position]]$name)) {
        abort("internal-error", "an R categorical result changed a retained source-column name")
      }
    }
    if (!identical(result$sourceSignature, categorical_source_signature(source_capture$descriptor))) {
      abort("internal-error", "an R categorical result does not match its source capture")
    }
    invisible(result)
  }

  capture_categorical_result <- function(result, source_capture, output_ids) {
    validate_categorical_result(result, source_capture)
    capture_frame(
      result$value,
      nullability_source = source_capture,
      source_positions = result$sourcePositions,
      output_ids = output_ids,
      categorical_positions = result$categoricalPositions
    )
  }

  capture_live_frame <- function(source_reader) {
    if (!is.function(source_reader)) {
      abort("invalid-source-reader", "source_reader must be a function")
    }
    metrics <- new_capture_metrics()
    value <- normalize_supported_frame(source_reader())
    add_metric(metrics, "sourceReads")
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = metrics
    )
    capture <- new.env(parent = emptyenv())
    capture$mode <- "live"
    capture$snapshot <- NULL
    capture$sourceReader <- source_reader
    capture$liveState <- new.env(parent = emptyenv())
    capture$liveState$hasInitialFrame <- TRUE
    capture$liveState$initialFrame <- value
    capture$descriptor <- inspected$descriptor
    set_sequential_row_origins(
      capture,
      inspected$descriptor$shape$rows,
      inspected$descriptor$shape$rows
    )
    capture$metadataBytes <- inspected$metadataBytes
    capture$metrics <- metrics
    capture$sortCache <- new_sort_cache()
    finish_capture(capture)
  }

  isolate_capture <- function(capture) {
    capture_frame(
      read_capture_frame(capture),
      nullability_source = capture,
      preserve_data_table_element_names = TRUE
    )
  }

  isolate_custom_code_input <- function(capture) {
    validate_capture(capture)
    source <- read_capture_frame(capture, validated = TRUE)
    flavor <- capture$descriptor$dataframeFlavor
    element_names <- if (identical(flavor, "r.data.table")) {
      lapply(seq_len(storage_length(source)), function(position) {
        attr(.subset2(source, position), "names", exact = TRUE)
      })
    } else {
      NULL
    }
    result <- isolated_snapshot(source, flavor)
    if (!is.null(element_names)) {
      for (position in seq_along(element_names)) {
        if (!is.null(element_names[[position]])) {
          data.table::setattr(.subset2(result, position), "names", element_names[[position]])
        }
      }
    }
    result
  }

  rename_column_at <- function(value, position, old_name, new_name) {
    metrics <- new_capture_metrics()
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = metrics
    )
    position <- whole_number(position, "column position", inspected$descriptor$shape$columns)
    if (position < 1L || position > inspected$descriptor$shape$columns) {
      abort("stale-column", "the rename column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    if (!identical(inspected$descriptor$schema[[position]]$name, old_name)) {
      abort("stale-column", "the rename column name no longer matches the R dataframe")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, "")) {
      abort("invalid-column-name", "new_name must not be empty")
    }
    if (is_private_column_name(old_name) || is_private_column_name(new_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }

    column_names <- names(value)
    collisions <- which(column_names == new_name & seq_along(column_names) != position)
    if (length(collisions) != 0L) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::setnames(result, old = position, new = new_name)
    } else {
      result_names <- names(result)
      result_names[[position]] <- new_name
      names(result) <- result_names
    }

    renamed <- inspect_frame(
      result,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    source_ids <- vapply(inspected$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    renamed_ids <- vapply(renamed$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    if (!identical(source_ids, renamed_ids)) {
      abort("internal-error", "renaming a column changed its stable identity")
    }
    result
  }

  rename_column <- function(value, column_reference, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    rename_column_at(value, resolved$position, resolved$name, new_name)
  }

  clone_column_at <- function(value, position, old_name, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the clone column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    inspected_schema <- unclass(inspected$descriptor$schema)
    attributes(inspected_schema) <- NULL
    inspected_column <- .subset2(inspected_schema, position)
    if (!identical(.subset2(inspected_column, "name"), old_name)) {
      abort("stale-column", "the clone column name no longer matches the R dataframe")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, "")) {
      abort("invalid-column-name", "new_name must not be empty")
    }
    if (is_private_column_name(old_name) || is_private_column_name(new_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    frame_names <- unclass(attr(value, "names", exact = TRUE))
    attributes(frame_names) <- NULL
    if (any(frame_names == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (column_count >= maximum_columns) {
      abort("invalid-view-query", "cloneColumn exceeds the supported R column limit")
    }

    source_element_names <- if (identical(inspected$flavor, "r.data.table")) {
      lapply(seq_len(column_count), function(source_position) {
        attr(.subset2(value, source_position), "names", exact = TRUE)
      })
    } else {
      NULL
    }
    result <- isolated_snapshot(value, inspected$flavor)
    if (!is.null(source_element_names)) {
      for (source_position in seq_along(source_element_names)) {
        if (!is.null(source_element_names[[source_position]])) {
          data.table::setattr(
            .subset2(result, source_position),
            "names",
            source_element_names[[source_position]]
          )
        }
      }
    }
    cloned_element_names <- attr(.subset2(result, position), "names", exact = TRUE)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::setattr(result, "names", frame_names)
      data.table::set(result, j = new_name, value = .subset2(result, position))
      if (!is.null(cloned_element_names)) {
        data.table::setattr(.subset2(result, storage_length(result)), "names", cloned_element_names)
      }
    } else {
      frame_attributes <- attributes(result)
      columns <- unclass(result)
      columns[[storage_length(columns) + 1L]] <- .subset2(columns, position)
      frame_attributes[["names"]] <- c(frame_names, new_name)
      attributes(columns) <- frame_attributes
      result <- columns
    }
    result
  }

  clone_column <- function(value, column_reference, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolver_descriptor <- inspected$descriptor
    resolver_schema <- unclass(resolver_descriptor$schema)
    attributes(resolver_schema) <- NULL
    resolver_descriptor$schema <- resolver_schema
    resolved <- resolve_column_reference(column_reference, resolver_descriptor, "column_reference")
    clone_column_at(value, resolved$position, resolved$name, new_name)
  }

  by_example_column_at <- function(value, positions, expected_names, new_name, result_kind, evaluator) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    row_count <- inspected$descriptor$shape$rows
    if (
      !is.numeric(positions) ||
        anyNA(positions) ||
        any(!is.finite(positions)) ||
        any(positions != floor(positions)) ||
        length(positions) == 0L ||
        length(positions) > 16L ||
        any(positions < 1L) ||
        any(positions > column_count) ||
        anyDuplicated(positions)
    ) {
      abort("stale-column", "the by-example source positions no longer match the R dataframe")
    }
    positions <- as.integer(positions)
    if (
      !is.character(expected_names) ||
        anyNA(expected_names) ||
        length(expected_names) != length(positions)
    ) {
      abort("stale-column", "the by-example source names no longer match the R dataframe")
    }
    expected_names <- vapply(seq_along(expected_names), function(index) {
      bounded_utf8(expected_names[[index]], sprintf("expected_names[[%d]]", index), maximum_name_bytes)
    }, character(1L), USE.NAMES = FALSE)
    source_schema <- plain_metadata_storage(inspected$descriptor$schema)
    source_names <- vapply(source_schema, `[[`, character(1L), "name", USE.NAMES = FALSE)
    actual_names <- source_names[positions]
    if (!identical(actual_names, expected_names)) {
      abort("stale-column", "the by-example source names no longer match the R dataframe")
    }
    if (any(vapply(expected_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, "")) abort("invalid-column-name", "new_name must not be empty")
    if (is_private_column_name(new_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (new_name %in% source_names) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (column_count >= maximum_columns) {
      abort("invalid-view-query", "byExample exceeds the supported R column limit")
    }
    if (
      !is.character(result_kind) || length(result_kind) != 1L || is.na(result_kind) ||
        !result_kind %in% c(
          "character", "factor", "integer", "integer64", "double", "logical",
          "date", "datetime", "difftime"
        )
    ) {
      abort("internal-error", "the by-example result kind is invalid")
    }
    if (!is.function(evaluator)) abort("internal-error", "the by-example evaluator must be a function")

    element_bytes <- if (result_kind %in% c("factor", "integer", "logical")) 4 else 8
    operation_budget <- new_payload_budget()
    spend_operation_output_budget(
      operation_budget,
      as.double(row_count) * element_bytes,
      "byExample output column"
    )

    source_element_names <- if (identical(inspected$flavor, "r.data.table")) {
      lapply(seq_len(column_count), function(position) {
        attr(.subset2(value, position), "names", exact = TRUE)
      })
    } else {
      NULL
    }
    result <- isolated_snapshot(value, inspected$flavor)
    if (!is.null(source_element_names)) {
      for (position in seq_len(column_count)) {
        if (!is.null(source_element_names[[position]])) {
          data.table::setattr(.subset2(result, position), "names", source_element_names[[position]])
        }
      }
    }
    source_chunk <- function(position, row_positions) {
      source <- .subset2(result, position)
      source_attributes <- attributes(source)
      source_names <- source_attributes$names
      chunk <- .subset(unclass(source), row_positions)
      if (!is.null(source_attributes)) {
        source_attributes$names <- if (is.null(source_names)) NULL else .subset(source_names, row_positions)
        attributes(chunk) <- source_attributes
      }
      chunk
    }
    output_matches_kind <- function(output) {
      switch(
        result_kind,
        character = is.character(output) && !is.object(output),
        factor = typeof(output) == "integer" &&
          (identical(class(output), "factor") || identical(class(output), c("ordered", "factor"))),
        integer = is.integer(output) && !is.object(output),
        integer64 = typeof(output) == "double" && identical(class(output), "integer64"),
        double = is.double(output) && !is.object(output),
        logical = is.logical(output) && !is.object(output),
        date = typeof(output) == "double" && identical(class(output), "Date"),
        datetime = typeof(output) == "double" && identical(class(output), c("POSIXct", "POSIXt")),
        difftime = typeof(output) == "double" && identical(class(output), "difftime"),
        FALSE
      )
    }
    output_attributes_are_bounded <- function(output_attributes) {
      fields <- names(output_attributes)
      switch(
        result_kind,
        factor = length(fields) == 2L && all(fields %in% c("levels", "class")),
        integer64 = identical(fields, "class"),
        date = identical(fields, "class"),
        datetime = identical(fields, "class") ||
          (length(fields) == 2L && all(fields %in% c("class", "tzone"))),
        difftime = length(fields) == 2L && all(fields %in% c("class", "units")),
        character = length(fields) == 0L,
        integer = length(fields) == 0L,
        double = length(fields) == 0L,
        logical = length(fields) == 0L,
        FALSE
      )
    }
    charge_metadata_text <- function(value, label, maximum_bytes, allow_asis = FALSE) {
      metadata_attributes <- attributes(value)
      if (!is.null(metadata_attributes)) {
        if (
          !isTRUE(allow_asis) ||
            !identical(names(metadata_attributes), "class") ||
            !identical(metadata_attributes$class, "AsIs") ||
            !is.null(attributes(metadata_attributes$class))
        ) {
          abort("invalid-view-query", sprintf("%s has unsupported nested attributes", label))
        }
        spend_operation_output_budget(
          operation_budget,
          character_vector_slot_bytes + nchar("AsIs", type = "bytes"),
          label
        )
      }
      plain <- plain_metadata_storage(value)
      if (!is.character(plain) || anyNA(plain)) {
        abort("invalid-view-query", sprintf("%s must contain non-missing text", label))
      }
      spend_operation_output_budget(
        operation_budget,
        as.double(storage_length(plain)) * character_vector_slot_bytes,
        label
      )
      for (index in seq_along(plain)) {
        item <- bounded_utf8(plain[[index]], sprintf("%s %d", label, index), maximum_bytes)
        spend_operation_output_budget(operation_budget, nchar(item, type = "bytes"), label)
      }
      plain
    }
    transformed_storage <- switch(
      result_kind,
      character = rep.int(NA_character_, row_count),
      factor = rep.int(NA_integer_, row_count),
      integer = rep.int(NA_integer_, row_count),
      logical = rep.int(NA, row_count),
      rep.int(NA_real_, row_count)
    )
    transformed_attributes <- NULL
    transformed_names <- NULL
    output_has_names <- NULL
    ranges <- if (row_count == 0L) {
      list(integer())
    } else {
      starts <- seq.int(1L, row_count, by = maximum_operation_output_chunk_rows)
      lapply(starts, function(start) {
        seq.int(start, min(row_count, start + maximum_operation_output_chunk_rows - 1L))
      })
    }
    for (row_positions in ranges) {
      selected <- lapply(positions, source_chunk, row_positions = row_positions)
      transformed_chunk <- tryCatch(
        evaluator(selected),
        openwrangler_r_frame_error = function(error) stop(error),
        error = function(error) abort("invalid-view-query", "the by-example program could not be evaluated")
      )
      if (
        is.null(transformed_chunk) ||
          is.data.frame(transformed_chunk) ||
          is.list(transformed_chunk) ||
          is.matrix(transformed_chunk) ||
          !is.atomic(transformed_chunk) ||
          storage_length(transformed_chunk) != length(row_positions) ||
          is.raw(transformed_chunk) ||
          is.complex(transformed_chunk) ||
          !output_matches_kind(transformed_chunk)
      ) {
        abort("invalid-view-query", "the by-example program returned an invalid R column")
      }
      chunk_attributes <- attributes(transformed_chunk)
      chunk_names <- plain_metadata_storage(chunk_attributes$names)
      if (!is.null(chunk_attributes)) chunk_attributes$names <- NULL
      if (!output_attributes_are_bounded(chunk_attributes %||% list())) {
        abort("invalid-view-query", "the by-example program returned unsupported R column attributes")
      }
      if (
        is.null(transformed_attributes) &&
          result_kind %in% c("factor", "integer64", "date", "datetime", "difftime")
      ) {
        output_class <- charge_metadata_text(
          attr(transformed_chunk, "class", exact = TRUE),
          "byExample output class",
          maximum_name_bytes
        )
        if (!identical(output_class, class(transformed_chunk))) {
          abort("invalid-view-query", "the by-example program returned invalid class metadata")
        }
      }
      if (identical(result_kind, "factor")) {
        raw_factor_levels <- attr(transformed_chunk, "levels", exact = TRUE)
        factor_levels <- plain_metadata_storage(raw_factor_levels)
        factor_codes <- unclass(transformed_chunk)
        if (
          !is.integer(factor_codes) ||
            any(!is.na(factor_codes) & (factor_codes < 1L | factor_codes > length(factor_levels)))
        ) {
          abort("invalid-view-query", "the by-example program returned invalid factor codes")
        }
        if (is.null(transformed_attributes)) {
          factor_levels <- charge_metadata_text(
            raw_factor_levels,
            "byExample factor levels",
            maximum_text_bytes,
            allow_asis = TRUE
          )
          if (
            !is.character(factor_levels) || anyNA(factor_levels) ||
              anyDuplicated(factor_levels) || length(factor_levels) > maximum_factor_levels
          ) {
            abort("invalid-view-query", "the by-example program returned invalid factor levels")
          }
        }
      }
      if (is.null(transformed_attributes) && identical(result_kind, "datetime")) {
        raw_timezone <- attr(transformed_chunk, "tzone", exact = TRUE)
        if (!is.null(raw_timezone)) {
          timezone <- charge_metadata_text(
            raw_timezone,
            "byExample datetime timezone",
            maximum_name_bytes,
            allow_asis = TRUE
          )
          if (storage_length(timezone) != 1L) {
            abort("invalid-view-query", "the by-example program returned an invalid datetime timezone")
          }
        }
      }
      if (is.null(transformed_attributes) && identical(result_kind, "difftime")) {
        units <- charge_metadata_text(
          attr(transformed_chunk, "units", exact = TRUE),
          "byExample difftime units",
          maximum_name_bytes,
          allow_asis = TRUE
        )
        if (
          storage_length(units) != 1L ||
            !units[[1L]] %in% c("secs", "mins", "hours", "days", "weeks")
        ) {
          abort("invalid-view-query", "the by-example program returned invalid difftime units")
        }
      }
      if (is.null(transformed_attributes)) {
        transformed_attributes <- chunk_attributes %||% list()
        output_has_names <- !is.null(chunk_names)
        if (isTRUE(output_has_names)) {
          spend_operation_output_budget(
            operation_budget,
            as.double(row_count) * character_vector_slot_bytes,
            "byExample output names"
          )
          transformed_names <- rep.int(NA_character_, row_count)
        }
      } else if (
        !identical(transformed_attributes, chunk_attributes %||% list()) ||
          !identical(output_has_names, !is.null(chunk_names))
      ) {
        abort("invalid-view-query", "the by-example program returned inconsistent chunk attributes")
      }
      if (isTRUE(output_has_names)) {
        if (!is.character(chunk_names) || length(chunk_names) != length(row_positions)) {
          abort("invalid-view-query", "the by-example program returned invalid output names")
        }
        transformed_names[row_positions] <- vapply(seq_along(chunk_names), function(index) {
          if (is.na(chunk_names[[index]])) return(NA_character_)
          item <- bounded_utf8(
            chunk_names[[index]],
            sprintf("byExample output name row %d", row_positions[[index]]),
            maximum_text_bytes
          )
          spend_operation_output_budget(
            operation_budget,
            nchar(item, type = "bytes"),
            "byExample output names"
          )
          item
        }, character(1L), USE.NAMES = FALSE)
      }
      if (identical(result_kind, "character")) {
        transformed_chunk <- vapply(seq_along(transformed_chunk), function(index) {
          item <- transformed_chunk[[index]]
          if (is.na(item)) return(NA_character_)
          bounded <- bounded_utf8(
            item,
            sprintf("byExample output row %d", row_positions[[index]]),
            maximum_text_bytes
          )
          spend_operation_output_budget(
            operation_budget,
            nchar(bounded, type = "bytes"),
            "byExample text output"
          )
          bounded
        }, character(1L), USE.NAMES = FALSE)
      }
      transformed_storage[row_positions] <- unclass(transformed_chunk)
    }
    transformed <- transformed_storage
    final_attributes <- transformed_attributes %||% list()
    if (isTRUE(output_has_names)) final_attributes$names <- transformed_names
    if (length(final_attributes) > 0L) attributes(transformed) <- final_attributes

    transformed_names <- attr(transformed, "names", exact = TRUE)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = new_name, value = transformed)
      result <- repair_data_table_self_reference(result)
      for (position in seq_len(column_count)) {
        if (!is.null(source_element_names[[position]])) {
          data.table::setattr(.subset2(result, position), "names", source_element_names[[position]])
        }
      }
      if (!is.null(transformed_names)) {
        data.table::setattr(.subset2(result, column_count + 1L), "names", transformed_names)
      }
    } else {
      result_classes <- class(result)
      class(result) <- NULL
      result[[storage_length(result) + 1L]] <- transformed
      attr(result, "names") <- c(source_names, new_name)
      if (!is.null(transformed_names)) attr(result[[storage_length(result)]], "names") <- transformed_names
      class(result) <- result_classes
    }

    appended <- inspect_frame(
      result,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    retained_schema <- plain_metadata_storage(appended$descriptor$schema)[seq_len(column_count)]
    if (
      !identical(appended$flavor, inspected$flavor) ||
        appended$descriptor$shape$rows != row_count ||
        appended$descriptor$shape$columns != column_count + 1L ||
        !identical(retained_schema, source_schema) ||
        !identical(
          plain_metadata_storage(appended$descriptor$frameSemantics$classes),
          plain_metadata_storage(inspected$descriptor$frameSemantics$classes)
        ) ||
        !identical(
          appended$descriptor$frameSemantics$rowNames,
          inspected$descriptor$frameSemantics$rowNames
        ) ||
        !identical(
          plain_metadata_storage(appended$descriptor$frameSemantics$keyColumnIds),
          plain_metadata_storage(inspected$descriptor$frameSemantics$keyColumnIds)
        )
    ) {
      abort("internal-error", "the by-example transform changed retained R frame semantics")
    }
    result
  }

  categorical_result_guard <- new.env(parent = emptyenv())
  lockEnvironment(categorical_result_guard, bindings = TRUE)

  categorical_source_signature <- function(descriptor) {
    schema <- plain_metadata_storage(descriptor$schema)
    schema_ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    key_ids <- plain_metadata_storage(descriptor$frameSemantics$keyColumnIds)
    key_positions <- match(key_ids, schema_ids)
    if (anyNA(key_positions)) {
      abort("internal-error", "an R categorical source has invalid data.table key metadata")
    }
    frame_classes <- unclass(descriptor$frameSemantics$classes)
    attributes(frame_classes) <- NULL
    list(
      dataframeFlavor = descriptor$dataframeFlavor,
      shape = descriptor$shape,
      frameClasses = frame_classes,
      rowNames = descriptor$frameSemantics$rowNames,
      keyPositions = as.integer(key_positions),
      columns = lapply(schema, function(column) {
        list(
          name = column$name,
          rawType = column$rawType,
          type = column$type,
          semantics = column$semantics
        )
      })
    )
  }

  new_categorical_result <- function(
    value,
    source_positions,
    categorical_positions,
    generated_names,
    source_descriptor
  ) {
    result <- new.env(parent = emptyenv())
    result$value <- value
    result$sourcePositions <- as.integer(source_positions)
    result$categoricalPositions <- as.integer(categorical_positions)
    result$generatedNames <- unname(generated_names)
    result$sourceSignature <- categorical_source_signature(source_descriptor)
    result$guard <- categorical_result_guard
    class(result) <- "openwrangler_r_categorical_result"
    lockEnvironment(result, bindings = TRUE)
    result
  }

  plain_atomic_storage <- function(value) {
    result <- unclass(value)
    attributes(result) <- NULL
    result
  }

  categorical_utf8_order <- function(values) {
    if (length(values) == 0L) return(integer())
    keys <- vapply(values, function(value) {
      paste(sprintf("%02x", as.integer(charToRaw(value))), collapse = "")
    }, character(1L), USE.NAMES = FALSE)
    base::order(keys, seq_along(keys), method = "radix")
  }

  validate_categorical_flags <- function(drop_original, operation) {
    if (!is.logical(drop_original) || length(drop_original) != 1L || is.na(drop_original)) {
      abort("invalid-view-query", sprintf("%s.dropOriginal must be TRUE or FALSE", operation))
    }
    drop_original
  }

  resolve_categorical_columns_at <- function(value, positions, expected_names, operation) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = TRUE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    if (
      !is.numeric(positions) ||
        anyNA(positions) ||
        any(!is.finite(positions)) ||
        any(positions != floor(positions)) ||
        length(positions) == 0L ||
        any(positions < 1L) ||
        any(positions > column_count) ||
        anyDuplicated(positions)
    ) {
      abort("stale-column", sprintf("the %s column positions no longer match the R dataframe", operation))
    }
    positions <- as.integer(positions)
    if (!is.character(expected_names) || anyNA(expected_names) || length(expected_names) != length(positions)) {
      abort("stale-column", sprintf("the %s column names no longer match the R dataframe", operation))
    }
    expected_names <- vapply(seq_along(expected_names), function(index) {
      bounded_utf8(.subset2(expected_names, index), sprintf("old_names[[%d]]", index), maximum_name_bytes)
    }, character(1L), USE.NAMES = FALSE)
    if (!identical(attr(value, "names", exact = TRUE)[positions], expected_names)) {
      abort("stale-column", sprintf("the %s column names no longer match the R dataframe", operation))
    }
    if (any(vapply(expected_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    list(inspected = inspected, positions = positions, names = expected_names)
  }

  one_hot_domain <- function(column, semantics, label) {
    kind <- semantics$kind
    value_count <- storage_length(column)
    if (identical(kind, "integer64")) {
      missing <- integer64_missing_mask(column, ensure_integer64_bindings())
      storage <- integer64_as_character(column)
      attributes(storage) <- NULL
      categories <- base::unique.default(.subset(storage, which(!missing)))
      return(list(storage = storage, missing = missing, categories = categories, labels = categories))
    }

    if (identical(kind, "character")) {
      storage <- vapply(seq_len(value_count), function(index) {
        source <- .subset2(column, index)
        if (is.na(source)) return(NA_character_)
        bounded_utf8(source, indexed_value_label(label, index, value_count))
      }, character(1L), USE.NAMES = FALSE)
      missing <- is.na(storage)
      categories <- base::unique.default(.subset(storage, which(!missing)))
      labels <- categories
    } else if (identical(kind, "factor")) {
      storage <- plain_atomic_storage(column)
      missing <- is.na(storage)
      categories <- base::unique.default(.subset(storage, which(!missing)))
      source_levels <- plain_metadata_storage(attr(column, "levels", exact = TRUE))
      labels <- vapply(seq_along(categories), function(index) {
        bounded_utf8(
          .subset2(source_levels, categories[[index]]),
          sprintf("%s level %d", label, categories[[index]])
        )
      }, character(1L), USE.NAMES = FALSE)
    } else {
      storage <- plain_atomic_storage(column)
      if (kind %in% c("date", "datetime", "difftime")) {
        nan <- is.nan(storage)
        if (any(nan)) {
          abort("unsupported-cell", sprintf("%s contains a classed NaN", label))
        }
        missing <- is.na(storage)
        invalid <- which(!missing & !is.finite(storage))
        if (length(invalid) != 0L) {
          abort("unsupported-cell", sprintf("%s[%d] is not finite", label, invalid[[1L]]))
        }
        if (identical(kind, "date")) {
          fractional <- which(!missing & storage != floor(storage))
          if (length(fractional) != 0L) {
            abort("unsupported-cell", sprintf("%s[%d] is a fractional Date", label, fractional[[1L]]))
          }
        }
      } else {
        missing <- is.na(storage)
      }
      categories <- base::unique.default(.subset(storage, which(!missing)))
      labels <- switch(
        kind,
        logical = ifelse(categories, "TRUE", "FALSE"),
        integer = sprintf("%d", categories),
        double = vapply(categories, display_double, character(1L), USE.NAMES = FALSE),
        date = display_date_values(structure(categories, class = "Date"), label),
        datetime = {
          datetime_values <- categories
          attributes(datetime_values) <- if (is.null(semantics$timezone)) {
            list(class = c("POSIXct", "POSIXt"))
          } else {
            list(class = c("POSIXct", "POSIXt"), tzone = semantics$timezone)
          }
          display_datetime_values(datetime_values, semantics$timezone, label)
        },
        difftime = paste(
          vapply(categories, exact_double, character(1L), USE.NAMES = FALSE),
          semantics$units
        ),
        abort("internal-error", "oneHotEncode received an unsupported R scalar kind")
      )
    }

    labels <- vapply(seq_along(labels), function(index) {
      bounded_utf8(labels[[index]], sprintf("%s category %d", label, index))
    }, character(1L), USE.NAMES = FALSE)
    keep <- labels != ""
    list(
      storage = storage,
      missing = missing,
      categories = .subset(categories, which(keep)),
      labels = .subset(labels, which(keep))
    )
  }

  one_hot_indicator <- function(domain, category) {
    matches <- !domain$missing & domain$storage == category
    matches[is.na(matches)] <- FALSE
    as.integer(matches)
  }

  categorical_text_storage <- function(column, semantics, label) {
    value_count <- storage_length(column)
    if (identical(semantics$kind, "character")) {
      return(vapply(seq_len(value_count), function(index) {
        source <- .subset2(column, index)
        if (is.na(source)) return(NA_character_)
        bounded_utf8(source, indexed_value_label(label, index, value_count))
      }, character(1L), USE.NAMES = FALSE))
    }
    if (!identical(semantics$kind, "factor")) {
      abort("invalid-view-query", "multiLabelBinarize requires a character or factor column")
    }
    codes <- plain_atomic_storage(column)
    source_levels <- plain_metadata_storage(attr(column, "levels", exact = TRUE))
    levels <- vapply(seq_len(storage_length(source_levels)), function(index) {
      bounded_utf8(.subset2(source_levels, index), sprintf("%s level %d", label, index))
    }, character(1L), USE.NAMES = FALSE)
    result <- rep.int(NA_character_, value_count)
    present <- which(!is.na(codes))
    if (length(present) != 0L) result[present] <- levels[codes[present]]
    result
  }

  validate_generated_categorical_names <- function(generated_names, retained_names, operation, budget) {
    generated_names <- vapply(seq_along(generated_names), function(index) {
      name <- bounded_utf8(
        generated_names[[index]],
        sprintf("%s generated column %d", operation, index),
        maximum_name_bytes
      )
      spend_payload_budget(budget, column_fixed_bytes, sprintf("%s generated column %d", operation, index))
      spend_json_string(budget, name, sprintf("%s generated column %d", operation, index))
      name
    }, character(1L), USE.NAMES = FALSE)
    if (any(generated_names == "")) {
      abort("invalid-column-name", sprintf("%s would create an empty column name", operation))
    }
    if (any(vapply(generated_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort(
        "reserved-column-name",
        sprintf("%s would create Open Wrangler's reserved private row-identity column", operation)
      )
    }
    collisions <- base::unique.default(c(
      generated_names[base::duplicated.default(generated_names)],
      generated_names[generated_names %in% retained_names]
    ))
    if (length(collisions) != 0L) {
      collisions <- collisions[categorical_utf8_order(collisions)]
      abort(
        "column-name-collision",
        sprintf("%s would create duplicate column names: %s", operation, paste(collisions, collapse = ", "))
      )
    }
    generated_names
  }

  assemble_categorical_frame <- function(
    value,
    inspected,
    retained_positions,
    generated_names,
    generated_columns
  ) {
    generated_count <- length(generated_names)
    if (generated_count != length(generated_columns)) {
      abort("internal-error", "an R categorical operation produced inconsistent generated columns")
    }
    if (generated_count == 0L) {
      abort("invalid-view-query", "an R categorical encoder must produce at least one indicator column")
    }
    result_names <- c(
      .subset(attr(value, "names", exact = TRUE), retained_positions),
      generated_names
    )
    expected_columns <- length(retained_positions) + generated_count
    if (identical(inspected$flavor, "r.data.table")) {
      result <- isolated_snapshot(value, inspected$flavor)
      dropped <- without_values(seq_len(inspected$descriptor$shape$columns), retained_positions)
      if (length(dropped) != 0L) data.table::set(result, j = dropped, value = NULL)
      result_classes <- class(result)
      class(result) <- NULL
      retained_names <- attr(result, "names", exact = TRUE)
      for (index in seq_along(generated_names)) {
        result[[storage_length(result) + 1L]] <- generated_columns[[index]]
      }
      attr(result, "names") <- c(retained_names, generated_names)
      class(result) <- result_classes
      if (!identical(attr(result, "names", exact = TRUE), result_names)) {
        abort("internal-error", "an R data.table categorical operation changed output order")
      }
      source_keys <- data_table_key_names(value)
      retained_names <- .subset(attr(value, "names", exact = TRUE), retained_positions)
      retained_key_count <- 0L
      for (key in source_keys) {
        if (!key %in% retained_names) break
        retained_key_count <- retained_key_count + 1L
      }
      expected_keys <- if (retained_key_count == 0L) {
        character()
      } else {
        .subset(source_keys, seq_len(retained_key_count))
      }
      data.table::setattr(result, "sorted", if (retained_key_count == 0L) NULL else expected_keys)
      result <- repair_data_table_self_reference(result)
      if (!identical(data_table_key_names(result), expected_keys)) {
        abort("internal-error", "an R categorical operation changed a retained data.table key")
      }
      return(result)
    }

    snapshot <- isolated_snapshot(value, inspected$flavor)
    retained_columns <- lapply(retained_positions, function(position) .subset2(snapshot, position))
    result <- c(retained_columns, generated_columns)
    attr(result, "names") <- result_names
    attr(result, "row.names") <- attr(snapshot, "row.names", exact = TRUE)
    attr(result, "class") <- class(snapshot)
    result
  }

  build_categorical_result <- function(
    value,
    inspected,
    selected_positions,
    generated_source_positions,
    generated_names,
    generated_columns,
    drop_original
  ) {
    retained_positions <- if (drop_original) {
      without_values(seq_len(inspected$descriptor$shape$columns), selected_positions)
    } else {
      seq_len(inspected$descriptor$shape$columns)
    }
    result_value <- assemble_categorical_frame(
      value,
      inspected,
      retained_positions,
      generated_names,
      generated_columns
    )
    categorical_positions <- if (length(generated_names) == 0L) {
      integer()
    } else {
      seq.int(length(retained_positions) + 1L, length(retained_positions) + length(generated_names))
    }
    new_categorical_result(
      result_value,
      c(retained_positions, generated_source_positions),
      categorical_positions,
      generated_names,
      inspected$descriptor
    )
  }

  one_hot_encode_columns_at <- function(
    value,
    positions,
    old_names,
    prefix_separator = "_",
    drop_original = TRUE
  ) {
    resolved <- resolve_categorical_columns_at(value, positions, old_names, "oneHotEncode")
    positions <- resolved$positions
    old_names <- resolved$names
    inspected <- resolved$inspected
    prefix_separator <- bounded_utf8(prefix_separator, "prefix_separator")
    drop_original <- validate_categorical_flags(drop_original, "oneHotEncode")
    retained_count <- inspected$descriptor$shape$columns - if (drop_original) length(positions) else 0L
    maximum_generated <- maximum_columns - retained_count
    domains <- lapply(seq_along(positions), function(index) {
      position <- positions[[index]]
      one_hot_domain(
        .subset2(value, position),
        .subset2(inspected$descriptor$schema, position)$semantics,
        sprintf("oneHotEncode column %d", position)
      )
    })
    generated <- list()
    for (source_index in seq_along(domains)) {
      domain <- domains[[source_index]]
      for (category_index in seq_along(domain$categories)) {
        if (length(generated) >= maximum_generated) {
          abort(
            "operation-output-too-large",
            sprintf("oneHotEncode may produce at most %d R columns", maximum_columns)
          )
        }
        generated[[length(generated) + 1L]] <- list(
          sourceIndex = source_index,
          categoryIndex = category_index,
          sourcePosition = positions[[source_index]],
          name = paste0(old_names[[source_index]], prefix_separator, domain$labels[[category_index]])
        )
      }
    }
    generated_names <- vapply(generated, `[[`, character(1L), "name", USE.NAMES = FALSE)
    retained_positions <- if (drop_original) without_values(seq_len(inspected$descriptor$shape$columns), positions) else {
      seq_len(inspected$descriptor$shape$columns)
    }
    metadata_budget <- new_payload_budget()
    generated_names <- validate_generated_categorical_names(
      generated_names,
      .subset(attr(value, "names", exact = TRUE), retained_positions),
      "One-hot encoding",
      metadata_budget
    )
    if (length(generated) != 0L) {
      generated_order <- categorical_utf8_order(generated_names)
      generated <- generated[generated_order]
      generated_names <- generated_names[generated_order]
    }
    operation_budget <- new_payload_budget()
    spend_operation_output_budget(
      operation_budget,
      as.double(inspected$descriptor$shape$rows) * length(generated) * 4,
      "oneHotEncode indicator columns"
    )
    generated_columns <- lapply(generated, function(item) {
      one_hot_indicator(domains[[item$sourceIndex]], domains[[item$sourceIndex]]$categories[[item$categoryIndex]])
    })
    build_categorical_result(
      value,
      inspected,
      positions,
      vapply(generated, `[[`, integer(1L), "sourcePosition", USE.NAMES = FALSE),
      generated_names,
      generated_columns,
      drop_original
    )
  }

  one_hot_encode_columns <- function(
    value,
    column_references,
    prefix_separator = "_",
    drop_original = TRUE
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    if (
      !is.list(column_references) ||
        is.object(column_references) ||
        !is.null(attributes(column_references)) ||
        length(column_references) == 0L
    ) {
      abort("invalid-view-query", "column_references must be a non-empty unnamed list")
    }
    resolved <- lapply(seq_along(column_references), function(index) {
      resolve_column_reference(
        column_references[[index]],
        inspected$descriptor,
        sprintf("column_references[[%d]]", index)
      )
    })
    ids <- vapply(resolved, `[[`, character(1L), "columnId", USE.NAMES = FALSE)
    if (anyDuplicated(ids)) {
      abort("invalid-view-query", "column_references may address each column only once")
    }
    one_hot_encode_columns_at(
      value,
      vapply(resolved, `[[`, integer(1L), "position", USE.NAMES = FALSE),
      vapply(resolved, `[[`, character(1L), "name", USE.NAMES = FALSE),
      prefix_separator,
      drop_original
    )
  }

  multi_label_binarize_column_at <- function(
    value,
    position,
    old_name,
    delimiter,
    prefix = NULL,
    drop_original = FALSE
  ) {
    resolved <- resolve_categorical_columns_at(value, position, old_name, "multiLabelBinarize")
    position <- resolved$positions[[1L]]
    old_name <- resolved$names[[1L]]
    inspected <- resolved$inspected
    semantics <- .subset2(inspected$descriptor$schema, position)$semantics
    if (!semantics$kind %in% c("character", "factor")) {
      abort("invalid-view-query", "multiLabelBinarize requires a character or factor column")
    }
    delimiter <- bounded_utf8(delimiter, "delimiter")
    if (identical(delimiter, "")) {
      abort("invalid-view-query", "multiLabelBinarize.delimiter must be a non-empty string")
    }
    if (is.null(prefix)) {
      prefix <- paste0(old_name, "_")
    } else {
      prefix <- bounded_utf8(prefix, "prefix")
    }
    drop_original <- validate_categorical_flags(drop_original, "multiLabelBinarize")
    source_values <- categorical_text_storage(
      .subset2(value, position),
      semantics,
      sprintf("multiLabelBinarize column %d", position)
    )
    row_count <- length(source_values)
    operation_budget <- new_payload_budget()
    spend_operation_output_budget(
      operation_budget,
      as.double(row_count) * character_vector_slot_bytes,
      "multiLabelBinarize row-token index"
    )
    tokens_by_row <- vector("list", row_count)
    labels <- character()
    retained_count <- inspected$descriptor$shape$columns - if (drop_original) 1L else 0L
    maximum_generated <- maximum_columns - retained_count
    for (row_index in seq_len(row_count)) {
      source <- source_values[[row_index]]
      if (is.na(source) || identical(source, "")) next
      parts <- base::strsplit(source, delimiter, fixed = TRUE, useBytes = FALSE)[[1L]]
      if (length(parts) == 0L) next
      parts <- parts[parts != ""]
      if (length(parts) == 0L) next
      parts <- base::unique.default(parts)
      for (part_index in seq_along(parts)) {
        parts[[part_index]] <- bounded_utf8(
          parts[[part_index]],
          sprintf("multiLabelBinarize row %d token %d", row_index, part_index)
        )
        spend_operation_output_budget(
          operation_budget,
          nchar(parts[[part_index]], type = "bytes") + character_vector_slot_bytes,
          "multiLabelBinarize tokens"
        )
      }
      tokens_by_row[[row_index]] <- parts
      unseen <- parts[is.na(match(parts, labels))]
      if (length(unseen) != 0L) labels <- c(labels, unseen)
      if (length(labels) > maximum_generated) {
        abort(
          "operation-output-too-large",
          sprintf("multiLabelBinarize may produce at most %d R columns", maximum_columns)
        )
      }
    }
    generated_names <- if (length(labels) == 0L) character() else paste0(prefix, labels)
    retained_positions <- if (drop_original) {
      without_values(seq_len(inspected$descriptor$shape$columns), position)
    } else {
      seq_len(inspected$descriptor$shape$columns)
    }
    metadata_budget <- new_payload_budget()
    generated_names <- validate_generated_categorical_names(
      generated_names,
      .subset(attr(value, "names", exact = TRUE), retained_positions),
      "Multi-label binarization",
      metadata_budget
    )
    if (length(labels) != 0L) {
      generated_order <- categorical_utf8_order(generated_names)
      labels <- labels[generated_order]
      generated_names <- generated_names[generated_order]
    }
    spend_operation_output_budget(
      operation_budget,
      as.double(row_count) * length(labels) * 4,
      "multiLabelBinarize indicator columns"
    )
    generated_columns <- lapply(labels, function(label) {
      as.integer(vapply(tokens_by_row, function(tokens) {
        length(tokens) != 0L && label %in% tokens
      }, logical(1L), USE.NAMES = FALSE))
    })
    build_categorical_result(
      value,
      inspected,
      position,
      rep.int(position, length(labels)),
      generated_names,
      generated_columns,
      drop_original
    )
  }

  multi_label_binarize_column <- function(
    value,
    column_reference,
    delimiter,
    prefix = NULL,
    drop_original = FALSE
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    multi_label_binarize_column_at(
      value,
      resolved$position,
      resolved$name,
      delimiter,
      prefix,
      drop_original
    )
  }

  formula_column_at <- function(
    value,
    left_position,
    left_name,
    operator,
    new_name,
    right_position = NULL,
    right_name = NULL,
    right_value = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    left_position <- whole_number(left_position, "left column position", column_count)
    if (left_position < 1L || left_position > column_count) {
      abort("stale-column", "the formula left-column position no longer matches the R dataframe")
    }
    left_position <- as.integer(left_position)
    left_name <- bounded_utf8(left_name, "left_name", maximum_name_bytes)
    left_column <- inspected$descriptor$schema[[left_position]]
    if (!identical(left_column$name, left_name)) {
      abort("stale-column", "the formula left-column name no longer matches the R dataframe")
    }
    if (is_private_column_name(left_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (!left_column$semantics$kind %in% c("integer", "double", "integer64")) {
      abort("invalid-view-query", "formula requires numeric R columns")
    }

    operator <- bounded_utf8(operator, "operator", maximum_name_bytes)
    if (!operator %in% c("add", "subtract", "multiply", "divide", "modulo", "power")) {
      abort("invalid-view-query", "formula.operator is not supported")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, "")) {
      abort("invalid-column-name", "new_name must not be empty")
    }
    if (is_private_column_name(new_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (any(attr(value, "names", exact = TRUE) == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (column_count >= maximum_columns) {
      abort("invalid-view-query", "formula exceeds the supported R column limit")
    }

    has_right_column <- !is.null(right_position) || !is.null(right_name)
    has_right_value <- !is.null(right_value)
    if (has_right_column == has_right_value) {
      abort("invalid-view-query", "formula requires exactly one of a right column or numeric value")
    }

    right_column <- NULL
    if (has_right_column) {
      if (is.null(right_position) || is.null(right_name)) {
        abort("invalid-view-query", "formula right-column position and name must be provided together")
      }
      right_position <- whole_number(right_position, "right column position", column_count)
      if (right_position < 1L || right_position > column_count) {
        abort("stale-column", "the formula right-column position no longer matches the R dataframe")
      }
      right_position <- as.integer(right_position)
      right_name <- bounded_utf8(right_name, "right_name", maximum_name_bytes)
      right_column <- inspected$descriptor$schema[[right_position]]
      if (!identical(right_column$name, right_name)) {
        abort("stale-column", "the formula right-column name no longer matches the R dataframe")
      }
      if (is_private_column_name(right_name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      if (!right_column$semantics$kind %in% c("integer", "double", "integer64")) {
        abort("invalid-view-query", "formula requires numeric R columns")
      }
    } else if (
      !is.numeric(right_value) ||
        is.object(right_value) ||
        length(right_value) != 1L ||
        is.na(right_value) ||
        !is.finite(right_value)
    ) {
      abort("invalid-view-query", "formula numeric value must be one finite scalar")
    }

    result <- isolated_snapshot(value, inspected$flavor)
    left_values <- result[[left_position]]
    right_values <- if (has_right_column) result[[right_position]] else right_value
    left_length <- storage_length(left_values)
    left_nan <- if (inherits(left_values, "integer64")) rep.int(FALSE, left_length) else is.nan(left_values)
    left_infinite <- if (inherits(left_values, "integer64")) {
      rep.int(FALSE, left_length)
    } else {
      is.infinite(left_values)
    }
    integer64_bindings <- if (identical(left_column$semantics$kind, "integer64") ||
      (!is.null(right_column) && identical(right_column$semantics$kind, "integer64"))) {
      ensure_integer64_bindings()
    } else {
      NULL
    }
    left_missing <- if (inherits(left_values, "integer64")) {
      integer64_missing_mask(left_values, integer64_bindings)
    } else {
      is.na(left_values) & !left_nan
    }
    right_nan <- if (!has_right_column || inherits(right_values, "integer64")) {
      rep.int(FALSE, left_length)
    } else {
      is.nan(right_values)
    }
    right_infinite <- if (!has_right_column || inherits(right_values, "integer64")) {
      rep.int(FALSE, left_length)
    } else {
      is.infinite(right_values)
    }
    right_missing <- if (has_right_column) {
      if (inherits(right_values, "integer64")) {
        integer64_missing_mask(right_values, integer64_bindings)
      } else {
        is.na(right_values) & !right_nan
      }
    } else {
      rep.int(FALSE, left_length)
    }
    left_kind <- left_column$semantics$kind
    right_kind <- if (has_right_column) {
      right_column$semantics$kind
    } else if (is.integer(right_value)) {
      "integer"
    } else {
      "double"
    }
    has_integer64 <- identical(left_kind, "integer64") || identical(right_kind, "integer64")
    has_double <- identical(left_kind, "double") || identical(right_kind, "double")
    force_double <- operator %in% c("divide", "power") || (has_integer64 && has_double)
    if (force_double) {
      if (identical(left_kind, "integer64")) {
        left_values <- suppressWarnings(integer64_as_double(left_values, integer64_bindings))
      }
      if (identical(right_kind, "integer64")) {
        right_values <- suppressWarnings(integer64_as_double(right_values, integer64_bindings))
      }
    }

    transformed <- tryCatch(
      withCallingHandlers(
        if (has_integer64 && !force_double) {
          integer64_binary(operator, left_values, right_values, integer64_bindings)
        } else switch(
          operator,
          add = left_values + right_values,
          subtract = left_values - right_values,
          multiply = left_values * right_values,
          divide = left_values / right_values,
          modulo = left_values %% right_values,
          power = left_values ^ right_values
        ),
        warning = function(warning) invokeRestart("muffleWarning")
      ),
      error = function(error) {
        abort("invalid-view-query", "formula could not apply the requested numeric operation")
      }
    )
    input_missing <- left_missing | right_missing
    if (any(input_missing)) {
      if (inherits(transformed, "integer64")) {
        transformed <- integer64_force_missing(transformed, input_missing, integer64_bindings)
      } else if (is.integer(transformed)) {
        transformed[input_missing] <- NA_integer_
      } else {
        transformed[input_missing] <- NA_real_
      }
    }
    if (
      storage_length(transformed) != inspected$descriptor$shape$rows ||
        !(is.integer(transformed) || is.double(transformed) || inherits(transformed, "integer64"))
    ) {
      abort("internal-error", "formula returned an invalid R numeric result")
    }
    output_nan <- if (inherits(transformed, "integer64")) {
      rep.int(FALSE, storage_length(transformed))
    } else {
      is.nan(transformed)
    }
    output_infinite <- if (inherits(transformed, "integer64")) {
      rep.int(FALSE, storage_length(transformed))
    } else {
      is.infinite(transformed)
    }
    output_missing <- if (inherits(transformed, "integer64")) {
      integer64_missing_mask(transformed, integer64_bindings)
    } else {
      is.na(transformed) & !output_nan
    }
    if (
      any(output_nan & !(left_nan | right_nan)) ||
        any(output_infinite & !(left_infinite | right_infinite)) ||
        any(output_missing & !(left_missing | right_missing))
    ) {
      abort("operation-output-too-large", "formula produced a non-finite or overflowing numeric result")
    }

    transformed_names <- attr(transformed, "names", exact = TRUE)
    if (identical(inspected$flavor, "r.data.table")) {
      result_classes <- class(result)
      class(result) <- NULL
      result_names <- attr(result, "names", exact = TRUE)
      result[[storage_length(result) + 1L]] <- transformed
      attr(result, "names") <- c(result_names, new_name)
      if (!is.null(transformed_names)) attr(result[[storage_length(result)]], "names") <- transformed_names
      class(result) <- result_classes
      result <- repair_data_table_self_reference(result)
    } else {
      result_classes <- class(result)
      class(result) <- NULL
      original_names <- attr(result, "names", exact = TRUE)
      result[[storage_length(result) + 1L]] <- transformed
      attr(result, "names") <- c(original_names, new_name)
      if (!is.null(transformed_names)) attr(result[[storage_length(result)]], "names") <- transformed_names
      class(result) <- result_classes
    }
    result
  }

  formula_column <- function(
    value,
    left_column_reference,
    operator,
    new_name,
    right_column_reference = NULL,
    right_value = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    left <- resolve_column_reference(left_column_reference, inspected$descriptor, "left_column_reference")
    right <- if (is.null(right_column_reference)) {
      NULL
    } else {
      resolve_column_reference(right_column_reference, inspected$descriptor, "right_column_reference")
    }
    formula_column_at(
      value,
      left$position,
      left$name,
      operator,
      new_name,
      if (is.null(right)) NULL else right$position,
      if (is.null(right)) NULL else right$name,
      right_value
    )
  }

  text_length_column_at <- function(value, position, old_name, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the text length column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    source_column <- inspected$descriptor$schema[[position]]
    if (!identical(source_column$name, old_name)) {
      abort("stale-column", "the text length column name no longer matches the R dataframe")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, "")) {
      abort("invalid-column-name", "new_name must not be empty")
    }
    if (is_private_column_name(old_name) || is_private_column_name(new_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (!source_column$semantics$kind %in% c("character", "factor")) {
      abort("invalid-view-query", "textLength requires a character or factor column")
    }
    if (any(names(value) == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (column_count >= maximum_columns) {
      abort("invalid-view-query", "textLength exceeds the supported R column limit")
    }

    result <- isolated_snapshot(value, inspected$flavor)
    lengths <- nchar(
      as.character(result[[position]]),
      type = "chars",
      allowNA = FALSE,
      keepNA = TRUE
    )
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = new_name, value = lengths)
    } else {
      original_names <- names(result)
      result[[length(result) + 1L]] <- lengths
      names(result) <- c(original_names, new_name)
    }
    result
  }

  text_length_column <- function(value, column_reference, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    text_length_column_at(value, resolved$position, resolved$name, new_name)
  }

  transform_text_column_at <- function(value, position, old_name, new_name, operation, transform) {
    operation_name <- switch(
      operation,
      lowerText = "Lowercase",
      upperText = "Uppercase",
      capitalizeText = "Capitalize",
      stripText = "Strip text",
      splitText = "Split text",
      findReplace = "Find and Replace",
      abort("internal-error", "the R text transform is unsupported")
    )
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", sprintf("the %s column position no longer matches the R dataframe", operation))
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    source_column <- inspected$descriptor$schema[[position]]
    if (!identical(source_column$name, old_name)) {
      abort("stale-column", sprintf("the %s column name no longer matches the R dataframe", operation))
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (!source_column$semantics$kind %in% c("character", "factor")) {
      abort("invalid-view-query", sprintf("%s requires a character or factor column", operation))
    }

    in_place <- is.null(new_name)
    if (!in_place) {
      new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
      if (identical(new_name, "")) {
        abort("invalid-column-name", "new_name must not be empty")
      }
      if (is_private_column_name(new_name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      in_place <- identical(new_name, old_name)
    }
    if (!in_place && any(attr(value, "names", exact = TRUE) == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (!in_place && column_count >= maximum_columns) {
      abort("invalid-view-query", sprintf("%s exceeds the supported R column limit", operation))
    }
    if (
      in_place &&
        identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort(
        "invalid-view-query",
        sprintf("%s cannot replace a data.table key column; choose a new output column", operation)
      )
    }

    result <- isolated_snapshot(value, inspected$flavor)
    source_values <- as.character(result[[position]])
    transformed <- vapply(seq_along(source_values), function(index) {
      if (is.na(source_values[[index]])) return(NA_character_)
      source_value <- bounded_utf8(source_values[[index]], sprintf("%s value %d", operation, index))
      output <- transform(source_value)
      if (
        identical(operation, "splitText") &&
          is.character(output) &&
          length(output) == 1L &&
          is.na(output)
      ) {
        return(NA_character_)
      }
      bounded_operation_output(output, operation_name)
    }, character(1L), USE.NAMES = FALSE)
    if (in_place) {
      if (identical(inspected$flavor, "r.data.table")) {
        data.table::set(result, j = position, value = transformed)
      } else {
        result[[position]] <- transformed
      }
    } else if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = new_name, value = transformed)
    } else {
      original_names <- names(result)
      result[[length(result) + 1L]] <- transformed
      names(result) <- c(original_names, new_name)
    }
    result
  }

  lower_text_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_text_column_at(value, position, old_name, new_name, "lowerText", tolower)
  }

  lower_text_column <- function(value, column_reference, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    lower_text_column_at(value, resolved$position, resolved$name, new_name)
  }

  upper_text_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_text_column_at(value, position, old_name, new_name, "upperText", toupper)
  }

  upper_text_column <- function(value, column_reference, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    upper_text_column_at(value, resolved$position, resolved$name, new_name)
  }

  capitalize_text_value <- function(value) {
    characters <- strsplit(value, "", fixed = TRUE)[[1L]]
    if (length(characters) == 0L) return("")
    paste0(
      toupper(characters[[1L]]),
      if (length(characters) == 1L) "" else tolower(paste0(characters[-1L], collapse = ""))
    )
  }

  capitalize_text_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_text_column_at(value, position, old_name, new_name, "capitalizeText", capitalize_text_value)
  }

  capitalize_text_column <- function(value, column_reference, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    capitalize_text_column_at(value, resolved$position, resolved$name, new_name)
  }

  strip_text_column_at <- function(value, position, old_name, characters = NULL, new_name = NULL) {
    if (is.null(characters)) {
      characters <- default_strip_characters
    } else {
      characters <- bounded_utf8(characters, "characters")
      if (identical(characters, "")) {
        abort("invalid-view-query", "stripText.characters must be a non-empty string or null")
      }
    }
    strip_characters <- unique(strsplit(characters, "", fixed = TRUE)[[1L]])
    strip_value <- function(source) {
      source_characters <- strsplit(source, "", fixed = TRUE)[[1L]]
      retained <- which(!source_characters %in% strip_characters)
      if (length(retained) == 0L) return("")
      paste0(source_characters[seq.int(retained[[1L]], retained[[length(retained)]])], collapse = "")
    }
    transform_text_column_at(value, position, old_name, new_name, "stripText", strip_value)
  }

  strip_text_column <- function(value, column_reference, characters = NULL, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    strip_text_column_at(value, resolved$position, resolved$name, characters, new_name)
  }

  split_text_value <- function(value, delimiter, index) {
    matches <- gregexpr(delimiter, value, fixed = TRUE)[[1L]]
    if (length(matches) == 1L && identical(as.integer(matches[[1L]]), -1L)) {
      return(if (identical(index, 0)) value else NA_character_)
    }
    part_count <- length(matches) + 1L
    if (index >= part_count) return(NA_character_)
    part <- as.integer(index) + 1L
    match_lengths <- attr(matches, "match.length", exact = TRUE)
    start <- if (part == 1L) 1L else matches[[part - 1L]] + match_lengths[[part - 1L]]
    end <- if (part <= length(matches)) matches[[part]] - 1L else nchar(value, type = "chars")
    if (start > end) "" else substr(value, start, end)
  }

  split_text_column_at <- function(value, position, old_name, delimiter, index, new_name) {
    delimiter <- bounded_utf8(delimiter, "delimiter")
    if (identical(delimiter, "")) {
      abort("invalid-view-query", "splitText.delimiter must be a non-empty string")
    }
    index <- whole_number(index, "index", .Machine$integer.max)
    if (is.null(new_name)) {
      abort("invalid-column-name", "splitText requires a new output column")
    }
    new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
    if (identical(new_name, old_name)) {
      abort("invalid-column-name", "splitText requires a new output column")
    }
    transform_text_column_at(
      value,
      position,
      old_name,
      new_name,
      "splitText",
      function(source) split_text_value(source, delimiter, index)
    )
  }

  split_text_column <- function(value, column_reference, delimiter, index, new_name) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    split_text_column_at(value, resolved$position, resolved$name, delimiter, index, new_name)
  }

  find_replace_column_at <- function(
    value,
    position,
    old_name,
    find,
    replacement,
    regex = FALSE,
    new_name = NULL
  ) {
    find <- bounded_utf8(find, "find")
    replacement <- bounded_utf8(replacement, "replacement")
    if (!is.logical(regex) || length(regex) != 1L || is.na(regex)) {
      abort("invalid-view-query", "findReplace.regex must be TRUE or FALSE")
    }
    operation_name <- "Find and Replace"
    reject_oversized_output <- function() {
      abort(
        "operation-output-too-large",
        sprintf("%s would produce text longer than %d UTF-8 bytes", operation_name, maximum_text_bytes)
      )
    }
    require_bounded_size <- function(bytes) {
      if (!is.finite(bytes) || bytes > maximum_text_bytes) reject_oversized_output()
    }
    checked_regex <- function(expression) {
      tryCatch(
        withCallingHandlers(
          force(expression),
          warning = function(warning) stop("regex evaluation failed", call. = FALSE)
        ),
        error = function(error) {
          abort("invalid-view-query", "Find and Replace could not apply the requested regular expression")
        }
      )
    }
    parse_regex_replacement <- function(value) {
      characters <- strsplit(value, "", fixed = TRUE)[[1L]]
      plain_literal_bytes <- 0
      case_literal_bytes <- 0
      plain_references <- integer(9L)
      case_references <- integer(9L)
      case_conversion <- FALSE
      add_literal <- function(character) {
        bytes <- as.double(nchar(character, type = "bytes"))
        if (case_conversion) {
          case_literal_bytes <<- case_literal_bytes + bytes
        } else {
          plain_literal_bytes <<- plain_literal_bytes + bytes
        }
      }
      index <- 1L
      while (index <= length(characters)) {
        character <- characters[[index]]
        if (!identical(character, "\\")) {
          add_literal(character)
          index <- index + 1L
          next
        }
        if (index == length(characters)) {
          add_literal("\\")
          break
        }
        escaped <- characters[[index + 1L]]
        if (identical(escaped, "\\")) {
          add_literal("\\")
        } else if (escaped %in% as.character(seq_len(9L))) {
          reference <- as.integer(escaped)
          if (case_conversion) {
            case_references[[reference]] <- case_references[[reference]] + 1L
          } else {
            plain_references[[reference]] <- plain_references[[reference]] + 1L
          }
        } else if (escaped %in% c("U", "L")) {
          case_conversion <- TRUE
        } else if (identical(escaped, "E")) {
          case_conversion <- FALSE
        } else {
          add_literal("\\")
          add_literal(escaped)
        }
        index <- index + 2L
      }
      list(
        plainLiteralBytes = plain_literal_bytes,
        caseLiteralBytes = case_literal_bytes,
        plainReferences = plain_references,
        caseReferences = case_references
      )
    }
    capture_bytes <- function(match_vector, capture_index, byte_prefix) {
      starts <- attr(match_vector, "capture.start", exact = TRUE)
      lengths <- attr(match_vector, "capture.length", exact = TRUE)
      if (
        is.null(starts) ||
          is.null(lengths) ||
          !is.matrix(starts) ||
          !is.matrix(lengths) ||
          ncol(starts) < capture_index ||
          ncol(lengths) < capture_index
      ) {
        return(0)
      }
      capture_starts <- starts[, capture_index]
      capture_lengths <- lengths[, capture_index]
      if (isTRUE(attr(match_vector, "useBytes", exact = TRUE))) {
        return(sum(as.double(capture_lengths[capture_starts >= 0L & capture_lengths > 0L])))
      }
      sum(vapply(seq_along(capture_starts), function(index) {
        start <- capture_starts[[index]]
        capture_length <- capture_lengths[[index]]
        if (start < 0L || capture_length <= 0L) return(0)
        end <- start + capture_length
        if (start < 1L || end > length(byte_prefix)) return(as.double(maximum_text_bytes))
        byte_prefix[[end]] - byte_prefix[[start]]
      }, numeric(1L), USE.NAMES = FALSE))
    }
    parsed_regex_replacement <- if (isTRUE(regex)) parse_regex_replacement(replacement) else NULL
    replace_value <- function(value) {
      input_bytes <- as.double(nchar(value, type = "bytes"))
      replacement_bytes <- as.double(nchar(replacement, type = "bytes"))
      if (isTRUE(regex)) {
        matches <- checked_regex(gregexpr(find, value, perl = TRUE))
        positions <- matches[[1L]]
        if (length(positions) == 1L && identical(as.integer(positions[[1L]]), -1L)) return(value)
        matched_values <- regmatches(value, matches)[[1L]]
        matched_bytes <- sum(as.double(nchar(matched_values, type = "bytes")))
        capture_byte_prefix <- if (isTRUE(attr(positions, "useBytes", exact = TRUE))) {
          NULL
        } else {
          c(0, cumsum(as.double(nchar(strsplit(value, "", fixed = TRUE)[[1L]], type = "bytes"))))
        }
        replacement_bound <- length(matched_values) * (
          parsed_regex_replacement$plainLiteralBytes +
            parsed_regex_replacement$caseLiteralBytes * 16
        )
        for (capture_index in seq_len(9L)) {
          capture_size <- capture_bytes(positions, capture_index, capture_byte_prefix)
          replacement_bound <- replacement_bound +
            parsed_regex_replacement$plainReferences[[capture_index]] * capture_size +
            parsed_regex_replacement$caseReferences[[capture_index]] * capture_size * 16
        }
        require_bounded_size(input_bytes - matched_bytes + replacement_bound)
        return(checked_regex(gsub(find, replacement, value, perl = TRUE)))
      }
      if (identical(find, "")) {
        require_bounded_size(input_bytes + (nchar(value, type = "chars") + 1) * replacement_bytes)
        literal_replacement <- gsub("\\", "\\\\", replacement, fixed = TRUE)
        return(gsub("", literal_replacement, value, perl = TRUE))
      }
      matches <- gregexpr(find, value, fixed = TRUE)[[1L]]
      match_count <- if (
        length(matches) == 1L && identical(as.integer(matches[[1L]]), -1L)
      ) 0 else length(matches)
      require_bounded_size(
        input_bytes + match_count * (replacement_bytes - nchar(find, type = "bytes"))
      )
      if (match_count == 0L) return(value)
      gsub(find, replacement, value, fixed = TRUE)
    }
    transform_text_column_at(
      value,
      position,
      old_name,
      new_name,
      "findReplace",
      replace_value
    )
  }

  find_replace_column <- function(
    value,
    column_reference,
    find,
    replacement,
    regex = FALSE,
    new_name = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    find_replace_column_at(
      value,
      resolved$position,
      resolved$name,
      find,
      replacement,
      regex,
      new_name
    )
  }

  round_integer64_values <- function(values, digits) {
    if (!requireNamespace("bit64", quietly = TRUE)) {
      abort("missing-package", "bit64 is required to round an integer64 column")
    }
    if (digits >= 0) return(values)

    places <- -digits
    present <- !is.na(values)
    if (!any(present)) return(values)
    zero <- bit64::as.integer64(0L)
    magnitude <- abs(values[present])
    if (places > 19) {
      rounded <- rep(zero, length(magnitude))
    } else if (places == 19) {
      half <- bit64::as.integer64("5000000000000000000")
      if (any(magnitude > half)) {
        abort("operation-output-too-large", "Round would produce a value outside the integer64 range")
      }
      rounded <- rep(zero, length(magnitude))
    } else {
      unit <- bit64::as.integer64(paste0("1", strrep("0", as.integer(places))))
      quotient <- magnitude %/% unit
      remainder <- magnitude %% unit
      half <- unit %/% bit64::as.integer64(2L)
      round_up <- remainder > half |
        (remainder == half & quotient %% bit64::as.integer64(2L) == bit64::as.integer64(1L))
      maximum_quotient <- bit64::as.integer64("9223372036854775807") %/% unit
      if (any(round_up & quotient >= maximum_quotient)) {
        abort("operation-output-too-large", "Round would produce a value outside the integer64 range")
      }
      quotient[round_up] <- quotient[round_up] + bit64::as.integer64(1L)
      rounded <- quotient * unit
    }
    rounded[values[present] < zero] <- -rounded[values[present] < zero]
    if (anyNA(rounded)) {
      abort("operation-output-too-large", "Round would produce a value outside the integer64 range")
    }
    result <- values
    result[present] <- rounded
    result
  }

  min_max_scale_values <- function(values) {
    if (inherits(values, "integer64")) {
      present <- !is.na(values)
      scaled <- rep.int(NA_real_, length(values))
      if (!any(present)) return(scaled)

      present_values <- values[present]
      minimum <- min(present_values)
      maximum <- max(present_values)
      if (isTRUE(minimum == maximum)) {
        scaled[present] <- 0
        return(scaled)
      }

      # A 2^32 limb keeps every quotient and remainder exactly representable
      # as a double. The final addition is therefore the only rounding step.
      limb_base_double <- 4294967296
      limb_base <- bit64::as.integer64("4294967296")
      quotients <- present_values %/% limb_base
      remainders <- present_values %% limb_base
      minimum_quotient <- minimum %/% limb_base
      minimum_remainder <- minimum %% limb_base
      maximum_quotient <- maximum %/% limb_base
      maximum_remainder <- maximum %% limb_base
      deltas <-
        (as.double(quotients) - as.double(minimum_quotient)) * limb_base_double +
        (as.double(remainders) - as.double(minimum_remainder))
      span <-
        (as.double(maximum_quotient) - as.double(minimum_quotient)) * limb_base_double +
        (as.double(maximum_remainder) - as.double(minimum_remainder))
      if (!is.finite(span) || span <= 0) {
        abort("internal-error", "R integer64 min-max scaling produced an invalid range")
      }
      present_scaled <- pmin(1, pmax(0, deltas / span))
      present_scaled[present_values == minimum] <- 0
      present_scaled[present_values == maximum] <- 1
      scaled[present] <- present_scaled
      return(scaled)
    }

    numeric_values <- suppressWarnings(as.double(values))
    finite <- is.finite(numeric_values)
    scaled <- rep.int(NA_real_, length(numeric_values))
    if (!any(finite)) return(scaled)

    finite_values <- numeric_values[finite]
    minimum <- min(finite_values)
    maximum <- max(finite_values)
    if (maximum == minimum) {
      scaled[finite] <- 0
    } else {
      scaled[finite] <- (finite_values - minimum) / (maximum - minimum)
    }
    scaled[!is.finite(scaled)] <- NA_real_
    scaled
  }

  transform_numeric_column_at <- function(
    value,
    position,
    old_name,
    operation,
    digits = 0,
    new_name = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the numeric column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    source_column <- inspected$descriptor$schema[[position]]
    if (!identical(source_column$name, old_name)) {
      abort("stale-column", "the numeric column name no longer matches the R dataframe")
    }
    if (!source_column$semantics$kind %in% c("integer", "double", "integer64")) {
      abort("invalid-view-query", sprintf("%s requires a numeric R column", operation))
    }
    if (!operation %in% c("minMaxScale", "roundNumber", "floorNumber", "ceilNumber")) {
      abort("internal-error", "the R numeric transform is unsupported")
    }
    digits <- signed_whole_number(digits, "digits", .Machine$integer.max)
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (!is.null(new_name)) {
      new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
      if (identical(new_name, "")) abort("invalid-column-name", "new_name must not be empty")
      if (is_private_column_name(new_name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
    }
    in_place <- is.null(new_name) || identical(new_name, old_name)
    if (!in_place && any(names(value) == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (!in_place && column_count >= maximum_columns) {
      abort("invalid-view-query", sprintf("%s exceeds the supported R column limit", operation))
    }
    source_key <- if (identical(inspected$flavor, "r.data.table")) {
      data.table::key(value) %||% character()
    } else {
      character()
    }
    if (in_place && old_name %in% source_key) {
      abort(
        "invalid-view-query",
        sprintf("%s cannot replace a data.table key column; choose a new output column", operation)
      )
    }

    result <- isolated_snapshot(value, inspected$flavor)
    source_values <- result[[position]]
    transformed <- if (identical(operation, "minMaxScale")) {
      min_max_scale_values(source_values)
    } else if (identical(source_column$semantics$kind, "integer64")) {
      if (identical(operation, "roundNumber")) round_integer64_values(source_values, digits) else source_values
    } else {
      switch(
        operation,
        roundNumber = base::round(source_values, digits = digits),
        floorNumber = base::floor(source_values),
        ceilNumber = base::ceiling(source_values)
      )
    }
    if (in_place) {
      if (identical(inspected$flavor, "r.data.table")) {
        data.table::set(result, j = position, value = transformed)
      } else {
        result[[position]] <- transformed
      }
    } else if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = new_name, value = transformed)
    } else {
      original_names <- names(result)
      result[[length(result) + 1L]] <- transformed
      names(result) <- c(original_names, new_name)
    }
    result
  }

  round_number_column_at <- function(value, position, old_name, digits = 0, new_name = NULL) {
    transform_numeric_column_at(value, position, old_name, "roundNumber", digits, new_name)
  }

  min_max_scale_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_numeric_column_at(value, position, old_name, "minMaxScale", 0, new_name)
  }

  floor_number_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_numeric_column_at(value, position, old_name, "floorNumber", 0, new_name)
  }

  ceil_number_column_at <- function(value, position, old_name, new_name = NULL) {
    transform_numeric_column_at(value, position, old_name, "ceilNumber", 0, new_name)
  }

  format_datetime_column_at <- function(value, position, old_name, format, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the formatDatetime column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    source_column <- inspected$descriptor$schema[[position]]
    if (!identical(source_column$name, old_name)) {
      abort("stale-column", "the formatDatetime column name no longer matches the R dataframe")
    }
    if (!source_column$semantics$kind %in% c("date", "datetime")) {
      abort("invalid-view-query", "formatDatetime requires a Date or POSIXct R column")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    format <- bounded_utf8(format, "format")
    if (identical(format, "")) {
      abort("invalid-view-query", "formatDatetime.format must be a non-empty string")
    }

    if (!is.null(new_name)) {
      new_name <- bounded_utf8(new_name, "new_name", maximum_name_bytes)
      if (identical(new_name, "")) abort("invalid-column-name", "new_name must not be empty")
      if (is_private_column_name(new_name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
    }
    in_place <- is.null(new_name) || identical(new_name, old_name)
    if (!in_place && any(attr(value, "names", exact = TRUE) == new_name)) {
      abort("column-name-collision", sprintf("new_name collides with an existing column: %s", new_name))
    }
    if (!in_place && column_count >= maximum_columns) {
      abort("invalid-view-query", "formatDatetime exceeds the supported R column limit")
    }
    if (
      in_place &&
        identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort(
        "invalid-view-query",
        "formatDatetime cannot replace a data.table key column; choose a new output column"
      )
    }

    row_count <- inspected$descriptor$shape$rows
    output_bytes <- as.double(row_count) * character_vector_slot_bytes
    if (!is.finite(output_bytes) || output_bytes > maximum_operation_output_bytes) {
      abort(
        "operation-output-too-large",
        sprintf(
          "formatDatetime exceeds the %d-byte aggregate output budget",
          maximum_operation_output_bytes
        )
      )
    }
    result <- isolated_snapshot(value, inspected$flavor)
    source_values <- result[[position]]
    source_storage <- unclass(source_values)
    transformed <- rep.int(NA_character_, row_count)
    start <- 1L
    while (start <= row_count) {
      end <- min(row_count, start + maximum_operation_output_chunk_rows - 1L)
      positions <- seq.int(start, end)
      numeric_chunk <- source_storage[positions]
      source_chunk <- if (identical(source_column$semantics$kind, "date")) {
        structure(numeric_chunk, class = "Date")
      } else {
        timezone <- source_column$semantics$timezone
        attributes(numeric_chunk) <- if (is.null(timezone)) {
          list(class = c("POSIXct", "POSIXt"))
        } else {
          list(class = c("POSIXct", "POSIXt"), tzone = timezone)
        }
        numeric_chunk
      }
      if (any(is.nan(numeric_chunk)) || any(!is.na(numeric_chunk) & !is.finite(numeric_chunk))) {
        abort("unsupported-cell", "formatDatetime cannot format a non-finite Date or POSIXct value")
      }
      present <- !is.na(numeric_chunk)
      if (
        identical(source_column$semantics$kind, "date") &&
          any(present & numeric_chunk != floor(numeric_chunk))
      ) {
        abort("unsupported-cell", "formatDatetime cannot format a fractional Date")
      }
      if (any(present)) {
        present_numeric <- numeric_chunk[present]
        present_source <- if (identical(source_column$semantics$kind, "date")) {
          structure(present_numeric, class = "Date")
        } else {
          timezone <- source_column$semantics$timezone
          attributes(present_numeric) <- if (is.null(timezone)) {
            list(class = c("POSIXct", "POSIXt"))
          } else {
            list(class = c("POSIXct", "POSIXt"), tzone = timezone)
          }
          present_numeric
        }
        if (identical(source_column$semantics$kind, "date")) {
          invisible(display_date_values(present_source, "formatDatetime source"))
        } else {
          invisible(
            display_datetime_values(
              present_source,
              source_column$semantics$timezone,
              "formatDatetime source"
            )
          )
        }
      }
      transformed_chunk <- tryCatch(
        if (identical(source_column$semantics$kind, "date")) {
          base::format.Date(source_chunk, format = format)
        } else {
          timezone <- source_column$semantics$timezone
          if (is.null(timezone) || identical(timezone, "")) timezone <- "UTC"
          base::format.POSIXct(source_chunk, format = format, tz = timezone, usetz = FALSE)
        },
        error = function(error) {
          abort("invalid-view-query", "formatDatetime could not apply the requested strftime format")
        }
      )
      if (!is.character(transformed_chunk) || length(transformed_chunk) != storage_length(source_chunk)) {
        abort("internal-error", "formatDatetime returned an invalid R text result")
      }
      transformed_chunk <- vapply(seq_along(transformed_chunk), function(index) {
        if (is.na(numeric_chunk[[index]])) return(NA_character_)
        if (is.na(transformed_chunk[[index]])) {
          abort("invalid-view-query", "formatDatetime returned a missing result for a present datetime")
        }
        bounded_operation_output(transformed_chunk[[index]], "Format datetime")
      }, character(1L), USE.NAMES = FALSE)
      chunk_text_bytes <- sum(as.double(nchar(
        transformed_chunk[!is.na(transformed_chunk)],
        type = "bytes"
      )))
      next_output_bytes <- output_bytes + chunk_text_bytes
      if (!is.finite(next_output_bytes) || next_output_bytes > maximum_operation_output_bytes) {
        abort(
          "operation-output-too-large",
          sprintf(
            "formatDatetime exceeds the %d-byte aggregate output budget",
            maximum_operation_output_bytes
          )
        )
      }
      output_bytes <- next_output_bytes
      transformed[positions] <- transformed_chunk
      start <- end + 1L
    }

    if (in_place) {
      if (identical(inspected$flavor, "r.data.table")) {
        data.table::set(result, j = position, value = transformed)
      } else {
        result[[position]] <- transformed
      }
    } else if (identical(inspected$flavor, "r.data.table")) {
      result_classes <- class(result)
      class(result) <- NULL
      result_names <- attr(result, "names", exact = TRUE)
      result[[storage_length(result) + 1L]] <- transformed
      attr(result, "names") <- c(result_names, new_name)
      class(result) <- result_classes
      result <- repair_data_table_self_reference(result)
    } else {
      original_names <- attr(result, "names", exact = TRUE)
      result[[storage_length(result) + 1L]] <- transformed
      attr(result, "names") <- c(original_names, new_name)
    }
    result
  }

  format_datetime_column <- function(value, column_reference, format, new_name = NULL) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    format_datetime_column_at(value, resolved$position, resolved$name, format, new_name)
  }

  integer64_fill_value <- function(text, label) {
    if (!requireNamespace("bit64", quietly = TRUE)) {
      abort("missing-package", "bit64 is required to fill an integer64 column")
    }
    parsed <- suppressWarnings(bit64::as.integer64(validate_integer64_text(text, label)))
    if (is.na(parsed)) {
      abort("invalid-view-value", sprintf("%s is not representable by bit64", label))
    }
    parsed
  }

  exact_integer64_median <- function(values) {
    if (!requireNamespace("bit64", quietly = TRUE)) {
      abort("missing-package", "bit64 is required to calculate an integer64 median")
    }
    ordered <- sort(values)
    count <- length(ordered)
    lower <- ordered[[(count + 1L) %/% 2L]]
    upper <- ordered[[(count + 2L) %/% 2L]]
    if (count %% 2L == 1L) return(lower)
    zero <- bit64::as.integer64(0L)
    two <- bit64::as.integer64(2L)
    midpoint <- if ((lower < zero && upper < zero) || (lower >= zero && upper >= zero)) {
      difference <- upper - lower
      if (!identical(as.character(difference %% two), "0")) {
        abort("invalid-view-value", "the integer64 median is not an integer")
      }
      lower + difference %/% two
    } else {
      total <- lower + upper
      if (!identical(as.character(total %% two), "0")) {
        abort("invalid-view-value", "the integer64 median is not an integer")
      }
      total %/% two
    }
    if (is.na(midpoint)) abort("invalid-view-value", "the integer64 median is outside the supported range")
    midpoint
  }

  safe_float_midpoint <- function(lower, upper) {
    if (lower == upper) return(lower)
    if (is.finite(lower) && is.finite(upper)) {
      if ((lower < 0) == (upper < 0)) return(lower + ((upper - lower) / 2))
      return((lower / 2) + (upper / 2))
    }
    (lower + upper) / 2
  }

  fill_missing_value <- function(column, descriptor, replacement) {
    replacement <- exact_named_list_optional(
      replacement,
      "kind",
      "value",
      "replacement"
    )
    kind <- scalar_choice(
      replacement$kind,
      c("mean", "median", "mostFrequent", "string", "integer", "float", "decimal", "boolean", "date", "datetime"),
      "replacement$kind"
    )
    if (kind %in% c("mean", "median", "mostFrequent")) {
      if (!identical(names(replacement), "kind")) {
        abort("invalid-view-query", "a calculated replacement may not contain a value")
      }
    } else if (!setequal(names(replacement), c("kind", "value"))) {
      abort("invalid-view-query", "a typed replacement requires exactly one value")
    }

    semantic_kind <- descriptor$semantics$kind
    compatible <- switch(
      semantic_kind,
      character = kind %in% c("mostFrequent", "string"),
      factor = kind %in% c("mostFrequent", "string"),
      integer = kind %in% c("median", "integer"),
      integer64 = kind %in% c("median", "integer"),
      double = kind %in% c("mean", "median", "integer", "float"),
      logical = kind %in% c("mostFrequent", "boolean"),
      date = identical(kind, "date"),
      datetime = identical(kind, "datetime"),
      FALSE
    )
    if (!compatible) {
      abort("invalid-view-query", "the replacement is incompatible with the selected R column")
    }

    missing <- is.na(column)
    if (kind %in% c("mean", "median", "mostFrequent") && !any(missing)) {
      return(list(column = column, addedFactorLevel = FALSE))
    }
    if (identical(kind, "mean")) {
      present <- column[!missing]
      if (length(present) == 0L) {
        abort("invalid-view-value", "the mean is unavailable because the selected column has no present values")
      }
      has_positive_infinity <- any(is.infinite(present) & present > 0)
      has_negative_infinity <- any(is.infinite(present) & present < 0)
      if (has_positive_infinity && has_negative_infinity) {
        abort("invalid-view-value", "the selected column has no usable numeric mean")
      }
      if (has_positive_infinity) {
        fill <- Inf
      } else if (has_negative_infinity) {
        fill <- -Inf
      } else {
        scale <- max(abs(present))
        fill <- if (scale == 0) {
          0
        } else {
          max(-1, min(1, mean(present / scale))) * scale
        }
      }
      result <- column
      result[missing] <- fill
      return(list(column = result, addedFactorLevel = FALSE))
    }
    if (identical(kind, "median")) {
      present <- column[!missing]
      if (length(present) == 0L) {
        abort("invalid-view-value", "the median is unavailable because the selected column has no present values")
      }
      fill <- if (identical(semantic_kind, "integer64")) {
        exact_integer64_median(present)
      } else {
        ordered <- sort(present)
        count <- length(ordered)
        lower <- ordered[[(count + 1L) %/% 2L]]
        upper <- ordered[[(count + 2L) %/% 2L]]
        midpoint <- lower / 2 + upper / 2
        if (is.nan(midpoint)) {
          abort("invalid-view-value", "the selected column has no usable numeric median")
        }
        if (identical(semantic_kind, "integer")) {
          if (!is.finite(midpoint) || midpoint != floor(midpoint)) {
            abort("invalid-view-value", "the integer median is not an integer")
          }
          midpoint <- as.integer(midpoint)
          if (is.na(midpoint)) abort("invalid-view-value", "the integer median is outside the R integer range")
        }
        midpoint
      }
      result <- column
      result[missing] <- fill
      return(list(column = result, addedFactorLevel = FALSE))
    }
    if (identical(kind, "mostFrequent")) {
      present <- column[!missing]
      if (length(present) == 0L) {
        abort(
          "invalid-view-value",
          "This column has no non-missing values. Choose a specific value."
        )
      }
      candidates <- unique(present)
      counts <- tabulate(match(present, candidates), nbins = length(candidates))
      winners <- which(counts == max(counts))
      if (length(winners) != 1L) {
        abort(
          "invalid-view-value",
          sprintf(
            "This column has no single most common value: %d values are tied. Choose a specific value.",
            length(winners)
          )
        )
      }
      result <- column
      result[missing] <- candidates[[winners[[1L]]]]
      return(list(column = result, addedFactorLevel = FALSE))
    }

    value <- replacement$value
    if (identical(semantic_kind, "character")) {
      fill <- bounded_utf8(value, "replacement$value")
      result <- column
      result[missing] <- fill
      return(list(column = result, addedFactorLevel = FALSE))
    }
    if (identical(semantic_kind, "factor")) {
      fill <- bounded_utf8(value, "replacement$value")
      if (!any(missing)) return(list(column = column, addedFactorLevel = FALSE))
      source_levels <- levels(column)
      added <- !fill %in% source_levels
      target_levels <- if (added) c(source_levels, fill) else source_levels
      result <- factor(as.character(column), levels = target_levels, ordered = is.ordered(column))
      result[missing] <- fill
      return(list(column = result, addedFactorLevel = added))
    }
    if (identical(semantic_kind, "integer")) {
      text <- normalize_integer_text(value, "replacement$value")
      numeric_value <- suppressWarnings(as.double(text))
      if (!is.finite(numeric_value) || numeric_value < -2147483647 || numeric_value > 2147483647) {
        abort("invalid-view-value", "replacement$value is outside the R integer range")
      }
      fill <- as.integer(numeric_value)
    } else if (identical(semantic_kind, "integer64")) {
      text <- normalize_integer_text(value, "replacement$value")
      fill <- integer64_fill_value(text, "replacement$value")
    } else if (identical(semantic_kind, "double")) {
      fill <- parse_finite_number(value, "replacement$value")
    } else if (identical(semantic_kind, "logical")) {
      fill <- parse_boolean(value, "replacement$value")
    } else if (identical(semantic_kind, "date")) {
      fill <- as.Date(as.double(parse_date_key(value, "replacement$value")), origin = "1970-01-01")
    } else if (identical(semantic_kind, "datetime")) {
      fill <- as.double(parse_datetime_key(value, descriptor$semantics, "replacement$value"))
    } else {
      abort("invalid-view-query", "the selected R column cannot be filled")
    }
    result <- column
    result[missing] <- fill
    list(column = result, addedFactorLevel = FALSE)
  }

  fill_missing_column_at <- function(value, position, old_name, replacement) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    descriptor <- inspected$descriptor$schema[[position]]
    if (!identical(descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    filled <- fill_missing_value(value[[position]], descriptor, replacement)
    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = filled$column)
    } else {
      result[[position]] <- filled$column
    }
    result
  }

  fill_missing_column <- function(value, column_reference, replacement) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    fill_missing_column_at(value, resolved$position, resolved$name, replacement)
  }

  fill_missing_from_fallback_columns_at <- function(
    value,
    position,
    old_name,
    fallback_positions,
    fallback_names
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    target_descriptor <- inspected$descriptor$schema[[position]]
    if (!identical(target_descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    if (
      !is.numeric(fallback_positions) ||
        anyNA(fallback_positions) ||
        any(!is.finite(fallback_positions)) ||
        any(fallback_positions != floor(fallback_positions)) ||
        length(fallback_positions) == 0L ||
        length(fallback_positions) > maximum_fill_fallback_columns ||
        any(fallback_positions < 1L) ||
        any(fallback_positions > column_count) ||
        anyDuplicated(fallback_positions) ||
        any(fallback_positions == position) ||
        !is.character(fallback_names) ||
        anyNA(fallback_names) ||
        length(fallback_names) != length(fallback_positions)
    ) {
      abort("invalid-view-query", "the fallback-column selection is invalid")
    }
    fallback_positions <- as.integer(fallback_positions)
    fallback_names <- vapply(seq_along(fallback_names), function(index) {
      name <- bounded_utf8(fallback_names[[index]], sprintf("fallback_names[[%d]]", index), maximum_name_bytes)
      if (is_private_column_name(name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      if (!identical(inspected$descriptor$schema[[fallback_positions[[index]]]]$name, name)) {
        abort("stale-column", "a fallback column name no longer matches the R dataframe")
      }
      name
    }, character(1L), USE.NAMES = FALSE)

    target_kind <- target_descriptor$semantics$kind
    compatible_fallback_kind <- function(fallback_kind) {
      if (target_kind %in% c("character", "factor")) return(fallback_kind %in% c("character", "factor"))
      if (target_kind %in% c("integer", "integer64")) return(fallback_kind %in% c("integer", "integer64"))
      identical(fallback_kind, target_kind) && target_kind %in% c("double", "logical", "date", "datetime")
    }
    fallback_descriptors <- lapply(fallback_positions, function(fallback_position) {
      descriptor <- inspected$descriptor$schema[[fallback_position]]
      if (!compatible_fallback_kind(descriptor$semantics$kind)) {
        abort(
          "invalid-view-query",
          sprintf("fallback column %s is incompatible with the selected R column", descriptor$name)
        )
      }
      descriptor
    })

    result_values <- value[[position]]
    if (identical(target_kind, "factor")) {
      result_text <- as.character(result_values)
      target_levels <- levels(result_values)
      for (index in seq_along(fallback_positions)) {
        fallback_text <- as.character(value[[fallback_positions[[index]]]])
        use <- is.na(result_text) & !is.na(fallback_text)
        if (!any(use)) next
        additions <- unique(fallback_text[use])
        additions <- additions[!additions %in% target_levels]
        if (length(target_levels) + length(additions) > maximum_factor_levels) {
          abort("factor-levels-too-large", sprintf("the filled factor has more than %d levels", maximum_factor_levels))
        }
        target_levels <- c(target_levels, additions)
        result_text[use] <- fallback_text[use]
      }
      result_values <- factor(result_text, levels = target_levels, ordered = is.ordered(result_values))
    } else {
      for (index in seq_along(fallback_positions)) {
        fallback_values <- value[[fallback_positions[[index]]]]
        use <- is.na(result_values) & !is.na(fallback_values)
        if (!any(use)) next
        fallback_kind <- fallback_descriptors[[index]]$semantics$kind
        converted <- if (identical(target_kind, "character")) {
          as.character(fallback_values[use])
        } else if (identical(target_kind, "integer") && identical(fallback_kind, "integer64")) {
          if (!requireNamespace("bit64", quietly = TRUE)) {
            abort("missing-package", "bit64 is required to fill an integer column from integer64")
          }
          selected <- fallback_values[use]
          minimum <- bit64::as.integer64("-2147483647")
          maximum <- bit64::as.integer64("2147483647")
          if (any(selected < minimum | selected > maximum)) {
            abort("invalid-view-value", "a fallback integer64 value is outside the R integer range")
          }
          as.integer(as.character(selected))
        } else if (identical(target_kind, "integer64") && identical(fallback_kind, "integer")) {
          if (!requireNamespace("bit64", quietly = TRUE)) {
            abort("missing-package", "bit64 is required to fill an integer64 column")
          }
          bit64::as.integer64(fallback_values[use])
        } else {
          fallback_values[use]
        }
        result_values[use] <- converted
      }
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = result_values)
    } else {
      result[[position]] <- result_values
    }
    result
  }

  fill_missing_directional_at <- function(
    value,
    position,
    old_name,
    order_positions,
    order_names,
    order_directions,
    order_nulls,
    direction,
    max_gap = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    target_descriptor <- inspected$descriptor$schema[[position]]
    if (!identical(target_descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    if (
      !is.numeric(order_positions) ||
        anyNA(order_positions) ||
        any(!is.finite(order_positions)) ||
        any(order_positions != floor(order_positions)) ||
        length(order_positions) == 0L ||
        length(order_positions) > min(maximum_sort_rules, column_count) ||
        any(order_positions < 1L) ||
        any(order_positions > column_count) ||
        anyDuplicated(order_positions) ||
        any(order_positions == position) ||
        !is.character(order_names) ||
        anyNA(order_names) ||
        length(order_names) != length(order_positions) ||
        !is.character(order_directions) ||
        anyNA(order_directions) ||
        length(order_directions) != length(order_positions) ||
        any(!order_directions %in% c("asc", "desc")) ||
        !is.character(order_nulls) ||
        anyNA(order_nulls) ||
        length(order_nulls) != length(order_positions) ||
        any(!order_nulls %in% c("first", "last"))
    ) {
      abort("invalid-view-query", "the directional ordering selection is invalid")
    }
    order_positions <- as.integer(order_positions)
    order_names <- vapply(seq_along(order_names), function(index) {
      name <- bounded_utf8(order_names[[index]], sprintf("order_names[[%d]]", index), maximum_name_bytes)
      if (!identical(inspected$descriptor$schema[[order_positions[[index]]]]$name, name)) {
        abort("stale-column", "a directional ordering column no longer matches the R dataframe")
      }
      name
    }, character(1L), USE.NAMES = FALSE)
    direction <- scalar_choice(direction, c("forward", "backward"), "direction")
    if (!is.null(max_gap)) {
      max_gap <- whole_number(max_gap, "max_gap", maximum_fill_directional_gap)
      if (max_gap < 1L) abort("invalid-range", "max_gap must be positive")
      max_gap <- as.integer(max_gap)
    }

    row_positions <- seq_len(inspected$descriptor$shape$rows)
    for (rule_index in rev(seq_along(order_positions))) {
      rule_position <- order_positions[[rule_index]]
      column <- value[[rule_position]][row_positions]
      missing <- is.na(column)
      missing_positions <- row_positions[missing]
      present_positions <- which(!missing)
      present_order <- order_present_values(
        column[present_positions],
        inspected$descriptor$schema[[rule_position]]$semantics,
        identical(order_directions[[rule_index]], "desc")
      )
      ordered_present <- row_positions[present_positions[present_order]]
      row_positions <- if (identical(order_nulls[[rule_index]], "first")) {
        c(missing_positions, ordered_present)
      } else {
        c(ordered_present, missing_positions)
      }
    }

    result_values <- value[[position]]
    ordered_missing <- is.na(result_values[row_positions])
    if (length(ordered_missing) > 0L && any(ordered_missing)) {
      runs <- rle(ordered_missing)
      run_ends <- cumsum(runs$lengths)
      run_starts <- run_ends - runs$lengths + 1L
      missing_runs <- which(runs$values)
      for (run_index in missing_runs) {
        run_length <- runs$lengths[[run_index]]
        if (!is.null(max_gap) && run_length > max_gap) next
        start <- run_starts[[run_index]]
        end <- run_ends[[run_index]]
        donor <- if (identical(direction, "forward")) start - 1L else end + 1L
        if (donor < 1L || donor > length(row_positions)) next
        donor_position <- row_positions[[donor]]
        if (is.na(result_values[donor_position])) next
        result_values[row_positions[start:end]] <- result_values[donor_position]
      }
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = result_values)
    } else {
      result[[position]] <- result_values
    }
    result
  }

  fill_missing_linear_interpolation_at <- function(
    value,
    position,
    old_name,
    coordinate_position,
    coordinate_name,
    max_gap = NULL
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    coordinate_position <- whole_number(coordinate_position, "coordinate column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    if (coordinate_position < 1L || coordinate_position > column_count) {
      abort("stale-column", "the interpolation coordinate position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    coordinate_position <- as.integer(coordinate_position)
    if (identical(position, coordinate_position)) {
      abort("invalid-view-query", "the fill target cannot also be the interpolation coordinate")
    }
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    coordinate_name <- bounded_utf8(coordinate_name, "coordinate_name", maximum_name_bytes)
    target_descriptor <- inspected$descriptor$schema[[position]]
    coordinate_descriptor <- inspected$descriptor$schema[[coordinate_position]]
    if (!identical(target_descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (!identical(coordinate_descriptor$name, coordinate_name)) {
      abort("stale-column", "the interpolation coordinate name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name) || is_private_column_name(coordinate_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    if (!identical(target_descriptor$semantics$kind, "double")) {
      abort("invalid-view-query", "linear interpolation requires a floating-point R target column")
    }
    coordinate_kind <- coordinate_descriptor$semantics$kind
    if (!coordinate_kind %in% c("integer", "double", "date", "datetime")) {
      abort("invalid-view-query", "linear interpolation requires a numeric, Date, or POSIXct coordinate column")
    }
    if (!is.null(max_gap)) {
      max_gap <- whole_number(max_gap, "max_gap", maximum_fill_directional_gap)
      if (max_gap < 1L) abort("invalid-range", "max_gap must be positive")
      max_gap <- as.integer(max_gap)
    }

    coordinate_values <- as.double(value[[coordinate_position]])
    if (anyNA(coordinate_values) || any(!is.finite(coordinate_values))) {
      abort("invalid-view-value", "every interpolation coordinate must be present and finite")
    }
    if (anyDuplicated(coordinate_values)) {
      abort("invalid-view-value", "interpolation coordinates must be unique")
    }
    row_positions <- order(coordinate_values, method = "radix")
    result_values <- value[[position]]
    ordered_values <- result_values[row_positions]
    ordered_missing <- is.na(ordered_values)
    if (length(ordered_missing) > 0L && any(ordered_missing)) {
      runs <- rle(ordered_missing)
      run_ends <- cumsum(runs$lengths)
      run_starts <- run_ends - runs$lengths + 1L
      for (run_index in which(runs$values)) {
        run_length <- runs$lengths[[run_index]]
        if (!is.null(max_gap) && run_length > max_gap) next
        start <- run_starts[[run_index]]
        end <- run_ends[[run_index]]
        left <- start - 1L
        right <- end + 1L
        if (left < 1L || right > length(row_positions)) next
        left_value <- ordered_values[[left]]
        right_value <- ordered_values[[right]]
        if (!is.finite(left_value) || !is.finite(right_value)) next

        left_coordinate <- coordinate_values[[row_positions[[left]]]]
        right_coordinate <- coordinate_values[[row_positions[[right]]]]
        coordinate_width <- right_coordinate - left_coordinate
        scaled <- !is.finite(coordinate_width)
        if (scaled) {
          coordinate_scale <- max(abs(left_coordinate), abs(right_coordinate))
          scaled_left <- left_coordinate / coordinate_scale
          scaled_right <- right_coordinate / coordinate_scale
          coordinate_width <- scaled_right - scaled_left
        }
        if (!is.finite(coordinate_width) || coordinate_width <= 0) {
          abort("invalid-view-value", "interpolation coordinates cannot be represented safely")
        }
        for (ordered_index in start:end) {
          coordinate <- coordinate_values[[row_positions[[ordered_index]]]]
          weight <- if (scaled) {
            (coordinate / coordinate_scale - scaled_left) / coordinate_width
          } else {
            (coordinate - left_coordinate) / coordinate_width
          }
          if (!is.finite(weight) || weight <= 0 || weight >= 1) {
            abort("invalid-view-value", "interpolation coordinates cannot be represented safely")
          }
          interpolated <- if (sign(left_value) == sign(right_value)) {
            left_value + (right_value - left_value) * weight
          } else {
            left_value * (1 - weight) + right_value * weight
          }
          if (!is.finite(interpolated)) {
            abort("invalid-view-value", "linear interpolation produced a non-finite value")
          }
          result_values[[row_positions[[ordered_index]]]] <- interpolated
        }
      }
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = result_values)
    } else {
      result[[position]] <- result_values
    }
    result
  }

  fill_missing_grouped_statistic_at <- function(
    value,
    position,
    old_name,
    key_positions,
    key_names,
    statistic
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the fill-missing column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    target_descriptor <- inspected$descriptor$schema[[position]]
    if (!identical(target_descriptor$name, old_name)) {
      abort("stale-column", "the fill-missing column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      identical(inspected$flavor, "r.data.table") &&
        old_name %in% (data.table::key(value) %||% character())
    ) {
      abort("invalid-view-query", "Fill Missing Values cannot replace a data.table key column")
    }
    if (
      !is.numeric(key_positions) ||
        anyNA(key_positions) ||
        any(!is.finite(key_positions)) ||
        any(key_positions != floor(key_positions)) ||
        length(key_positions) == 0L ||
        length(key_positions) > column_count ||
        any(key_positions < 1L) ||
        any(key_positions > column_count) ||
        anyDuplicated(key_positions) ||
        any(key_positions == position) ||
        !is.character(key_names) ||
        anyNA(key_names) ||
        length(key_names) != length(key_positions)
    ) {
      abort("invalid-view-query", "the grouped-fill key selection is invalid")
    }
    key_positions <- as.integer(key_positions)
    supported_key_kinds <- c(
      "character", "factor", "integer", "integer64", "double", "logical", "date", "datetime", "difftime"
    )
    key_names <- vapply(seq_along(key_names), function(index) {
      name <- bounded_utf8(key_names[[index]], sprintf("key_names[[%d]]", index), maximum_name_bytes)
      if (is_private_column_name(name)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      descriptor <- inspected$descriptor$schema[[key_positions[[index]]]]
      if (!identical(descriptor$name, name)) {
        abort("stale-column", "a grouped-fill key no longer matches the R dataframe")
      }
      if (!descriptor$semantics$kind %in% supported_key_kinds) {
        abort("invalid-view-query", sprintf("R %s columns cannot be used as grouped-fill keys", descriptor$semantics$kind))
      }
      name
    }, character(1L), USE.NAMES = FALSE)
    statistic <- scalar_choice(statistic, c("median", "mean", "mostFrequent"), "statistic")
    target_kind <- target_descriptor$semantics$kind
    compatible <- switch(
      statistic,
      mean = identical(target_kind, "double"),
      median = target_kind %in% c("integer", "integer64", "double"),
      mostFrequent = target_kind %in% c("character", "factor", "logical"),
      FALSE
    )
    if (!compatible) {
      abort("invalid-view-query", "the grouped statistic is incompatible with the selected R column")
    }

    row_positions <- seq_len(inspected$descriptor$shape$rows)
    for (key_index in rev(seq_along(key_positions))) {
      key_position <- key_positions[[key_index]]
      key_values <- value[[key_position]][row_positions]
      key_missing <- is.na(key_values)
      present_positions <- which(!key_missing)
      present_order <- order_present_values(
        key_values[present_positions],
        inspected$descriptor$schema[[key_position]]$semantics,
        FALSE
      )
      row_positions <- c(row_positions[key_missing], row_positions[present_positions[present_order]])
    }

    result_values <- value[[position]]
    row_count <- length(row_positions)
    if (row_count > 0L && anyNA(result_values)) {
      same_group <- rep(TRUE, max(0L, row_count - 1L))
      if (row_count > 1L) {
        left_rows <- row_positions[-row_count]
        right_rows <- row_positions[-1L]
        for (key_position in key_positions) {
          left <- value[[key_position]][left_rows]
          right <- value[[key_position]][right_rows]
          left_missing <- is.na(left)
          right_missing <- is.na(right)
          equal <- (left_missing & right_missing) | (!left_missing & !right_missing & left == right)
          equal[is.na(equal)] <- FALSE
          same_group <- same_group & equal
        }
      }
      group_starts <- c(1L, which(!same_group) + 1L)
      group_ends <- c(group_starts[-1L] - 1L, row_count)
      for (group_index in seq_along(group_starts)) {
        group_rows <- row_positions[group_starts[[group_index]]:group_ends[[group_index]]]
        missing_rows <- group_rows[is.na(result_values[group_rows])]
        if (length(missing_rows) == 0L) next
        present <- result_values[group_rows[!is.na(result_values[group_rows])]]
        if (length(present) == 0L) next

        fill <- NULL
        if (identical(statistic, "mean")) {
          has_positive_infinity <- any(is.infinite(present) & present > 0)
          has_negative_infinity <- any(is.infinite(present) & present < 0)
          if (has_positive_infinity && has_negative_infinity) next
          if (has_positive_infinity) {
            fill <- Inf
          } else if (has_negative_infinity) {
            fill <- -Inf
          } else {
            scale <- max(abs(present))
            fill <- if (scale == 0) 0 else max(-1, min(1, mean(present / scale))) * scale
          }
        } else if (identical(statistic, "median")) {
          fill <- if (identical(target_kind, "integer64")) {
            exact_integer64_median(present)
          } else {
            ordered <- sort(present)
            count <- length(ordered)
            lower <- ordered[[(count + 1L) %/% 2L]]
            upper <- ordered[[(count + 2L) %/% 2L]]
            midpoint <- if (count %% 2L == 1L) {
              lower
            } else if (identical(target_kind, "double")) {
              safe_float_midpoint(lower, upper)
            } else {
              lower / 2 + upper / 2
            }
            if (is.nan(midpoint)) next
            if (identical(target_kind, "integer")) {
              if (!is.finite(midpoint) || midpoint != floor(midpoint)) {
                abort("invalid-view-value", "a grouped integer median is not an integer")
              }
              midpoint <- as.integer(midpoint)
              if (is.na(midpoint)) {
                abort("invalid-view-value", "a grouped integer median is outside the R integer range")
              }
            }
            midpoint
          }
        } else {
          candidates <- unique(present)
          counts <- tabulate(match(present, candidates), nbins = length(candidates))
          winners <- which(counts == max(counts))
          if (length(winners) != 1L) next
          fill <- candidates[[winners[[1L]]]]
        }
        result_values[missing_rows] <- fill
      }
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = result_values)
    } else {
      result[[position]] <- result_values
    }
    result
  }

  cast_text_source <- function(column, kind, label) {
    values <- if (identical(kind, "factor")) as.character(column) else column
    if (!is.character(values)) {
      abort("internal-error", sprintf("%s did not resolve to text", label))
    }
    vapply(seq_along(values), function(index) {
      value <- values[[index]]
      if (is.na(value)) return(NA_character_)
      bounded_utf8(value, sprintf("%s value %d", label, index))
    }, character(1L), USE.NAMES = FALSE)
  }

  cast_string_values <- function(column, semantics, label) {
    kind <- semantics$kind
    values <- if (kind %in% c("character", "factor")) {
      cast_text_source(column, kind, label)
    } else if (identical(kind, "logical")) {
      ifelse(is.na(column), NA_character_, ifelse(column, "TRUE", "FALSE"))
    } else if (identical(kind, "integer")) {
      as.character(column)
    } else if (identical(kind, "integer64")) {
      as.character(column)
    } else if (identical(kind, "double")) {
      vapply(seq_along(column), function(index) {
        value <- column[[index]]
        if (is.nan(value)) return("NaN")
        if (is.na(value)) return(NA_character_)
        if (is.infinite(value)) return(if (value < 0) "-Inf" else "Inf")
        exact_double(value)
      }, character(1L), USE.NAMES = FALSE)
    } else if (identical(kind, "date")) {
      format(column, format = "%Y-%m-%d")
    } else if (identical(kind, "datetime")) {
      format(column, tz = "UTC", format = "%Y-%m-%dT%H:%M:%OS6Z", usetz = FALSE)
    } else if (identical(kind, "difftime")) {
      units <- semantics$units
      numeric_values <- as.double(column, units = units)
      vapply(seq_along(numeric_values), function(index) {
        value <- numeric_values[[index]]
        if (is.na(value)) return(NA_character_)
        paste(exact_double(value), units)
      }, character(1L), USE.NAMES = FALSE)
    } else {
      abort("internal-error", "castColumn encountered an unknown R source kind")
    }
    vapply(seq_along(values), function(index) {
      value <- values[[index]]
      if (is.na(value)) return(NA_character_)
      bounded_utf8(value, sprintf("%s result %d", label, index))
    }, character(1L), USE.NAMES = FALSE)
  }

  cast_date_text <- function(values) {
    result <- structure(rep(NA_real_, length(values)), class = "Date")
    valid <- !is.na(values) & grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", values, perl = TRUE)
    if (any(valid)) {
      result[valid] <- suppressWarnings(as.Date(values[valid], format = "%Y-%m-%d"))
    }
    cast_canonical_dates(result)
  }

  cast_canonical_dates <- function(values) {
    result <- values
    present <- !is.na(result)
    if (!any(present)) return(result)
    rendered <- format(result[present], format = "%Y-%m-%d")
    canonical <- grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", rendered, perl = TRUE) &
      !startsWith(rendered, "0000-")
    if (any(canonical)) {
      reparsed <- suppressWarnings(as.Date(rendered[canonical], format = "%Y-%m-%d"))
      canonical[canonical] <- !is.na(reparsed) & reparsed == result[present][canonical]
    }
    result[which(present)[!canonical]] <- as.Date(NA_character_)
    result
  }

  cast_canonical_datetimes <- function(values) {
    result <- values
    present <- !is.na(result)
    if (!any(present)) return(result)
    rendered <- format(result[present], tz = "UTC", format = "%Y-%m-%dT%H:%M:%OS6", usetz = FALSE)
    canonical <- grepl(
      "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}$",
      rendered,
      perl = TRUE
    ) & !startsWith(rendered, "0000-")
    result[which(present)[!canonical]] <- as.POSIXct(NA_real_, origin = "1970-01-01", tz = "UTC")
    result
  }

  cast_datetime_text <- function(values) {
    result <- structure(
      rep(NA_real_, length(values)),
      class = c("POSIXct", "POSIXt"),
      tzone = "UTC"
    )
    date_values <- !is.na(values) & grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", values, perl = TRUE)
    if (any(date_values)) {
      parsed_dates <- suppressWarnings(as.Date(values[date_values], format = "%Y-%m-%d"))
      result[date_values] <- as.POSIXct(parsed_dates, tz = "UTC")
    }
    datetime_values <- !is.na(values) & grepl(
      "^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z?$",
      values,
      perl = TRUE
    )
    if (any(datetime_values)) {
      normalized <- sub(" ", "T", values[datetime_values], fixed = TRUE)
      normalized <- sub("Z$", "", normalized, perl = TRUE)
      parsed <- suppressWarnings(strptime(normalized, format = "%Y-%m-%dT%H:%M:%OS", tz = "UTC"))
      result[datetime_values] <- as.POSIXct(parsed, tz = "UTC")
    }
    cast_canonical_datetimes(result)
  }

  cast_column_values <- function(column, semantics, raw_type, dtype, label) {
    source_kind <- semantics$kind
    supported_sources <- switch(
      dtype,
      string = c("logical", "integer", "double", "character", "factor", "date", "datetime", "difftime", "integer64"),
      integer = c("logical", "integer", "double", "character", "factor", "integer64"),
      float = c("logical", "integer", "double", "character", "factor"),
      boolean = c("logical", "integer", "double", "character", "factor"),
      date = c("character", "factor", "date", "datetime"),
      datetime = c("character", "factor", "date", "datetime")
    )
    if (!source_kind %in% supported_sources) {
      abort(
        "invalid-view-query",
        sprintf("castColumn cannot convert an R %s column to %s", raw_type, dtype)
      )
    }

    if (identical(dtype, "string")) return(cast_string_values(column, semantics, label))
    if (identical(dtype, "integer")) {
      if (identical(source_kind, "integer64") || identical(source_kind, "integer")) return(column)
      if (identical(source_kind, "logical") || identical(source_kind, "double")) {
        return(suppressWarnings(as.integer(column)))
      }
      text <- cast_text_source(column, source_kind, label)
      return(suppressWarnings(as.integer(trimws(text))))
    }
    if (identical(dtype, "float")) {
      if (identical(source_kind, "double")) return(column)
      if (source_kind %in% c("logical", "integer")) return(as.double(column))
      text <- cast_text_source(column, source_kind, label)
      return(suppressWarnings(as.double(trimws(text))))
    }
    if (identical(dtype, "boolean")) {
      if (identical(source_kind, "logical")) return(column)
      if (source_kind %in% c("integer", "double")) return(suppressWarnings(as.logical(column)))
      text <- cast_text_source(column, source_kind, label)
      return(suppressWarnings(as.logical(trimws(text))))
    }
    if (identical(dtype, "date")) {
      if (identical(source_kind, "date")) return(cast_canonical_dates(column))
      if (identical(source_kind, "datetime")) return(cast_canonical_dates(as.Date(column, tz = "UTC")))
      return(cast_date_text(cast_text_source(column, source_kind, label)))
    }
    if (identical(dtype, "datetime")) {
      if (identical(source_kind, "datetime")) {
        return(cast_canonical_datetimes(
          structure(as.double(column), class = c("POSIXct", "POSIXt"), tzone = "UTC")
        ))
      }
      if (identical(source_kind, "date")) {
        return(cast_canonical_datetimes(as.POSIXct(cast_canonical_dates(column), tz = "UTC")))
      }
      return(cast_datetime_text(cast_text_source(column, source_kind, label)))
    }
    abort("internal-error", "castColumn encountered an unknown target dtype")
  }

  cast_column_at <- function(value, position, old_name, dtype) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    position <- whole_number(position, "column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the cast column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    old_name <- bounded_utf8(old_name, "old_name", maximum_name_bytes)
    source_column <- inspected$descriptor$schema[[position]]
    if (!identical(source_column$name, old_name)) {
      abort("stale-column", "the cast column name no longer matches the R dataframe")
    }
    if (is_private_column_name(old_name)) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (
      !is.character(dtype) ||
        length(dtype) != 1L ||
        is.na(dtype) ||
        !dtype %in% c("string", "integer", "float", "boolean", "date", "datetime")
    ) {
      abort("invalid-view-query", "dtype must be one of: boolean, date, datetime, float, integer, string")
    }
    source_key <- if (identical(inspected$flavor, "r.data.table")) {
      data.table::key(value) %||% character()
    } else {
      character()
    }
    if (old_name %in% source_key) {
      abort(
        "invalid-view-query",
        "castColumn cannot replace a data.table key column; clone the column before casting it"
      )
    }

    result <- isolated_snapshot(value, inspected$flavor)
    converted <- cast_column_values(
      result[[position]],
      source_column$semantics,
      source_column$rawType,
      dtype,
      "castColumn"
    )
    if (identical(inspected$flavor, "r.data.table")) {
      data.table::set(result, j = position, value = converted)
      if (!identical(data.table::key(result) %||% character(), source_key)) {
        abort("internal-error", "castColumn changed a retained data.table key")
      }
    } else {
      result[[position]] <- converted
    }
    result
  }

  cast_column <- function(value, column_reference, dtype) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    resolved <- resolve_column_reference(column_reference, inspected$descriptor, "column_reference")
    cast_column_at(value, resolved$position, resolved$name, dtype)
  }

  drop_columns_at <- function(value, positions, expected_names) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    if (
      !is.numeric(positions) ||
        anyNA(positions) ||
        any(!is.finite(positions)) ||
        any(positions != floor(positions)) ||
        length(positions) == 0L ||
        any(positions < 1L) ||
        any(positions > column_count) ||
        anyDuplicated(positions)
    ) {
      abort("stale-column", "the drop column positions no longer match the R dataframe")
    }
    positions <- as.integer(positions)
    if (!is.character(expected_names) || length(expected_names) != length(positions) || anyNA(expected_names)) {
      abort("stale-column", "the drop column names no longer match the R dataframe")
    }
    expected_names <- vapply(seq_along(expected_names), function(index) {
      bounded_utf8(expected_names[[index]], sprintf("expected_names[[%d]]", index), maximum_name_bytes)
    }, character(1L), USE.NAMES = FALSE)
    if (!identical(names(value)[positions], expected_names)) {
      abort("stale-column", "the drop column names no longer match the R dataframe")
    }
    if (any(vapply(expected_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    if (length(positions) >= column_count) {
      abort("invalid-view-query", "dropColumns must leave at least one visible column")
    }

    keep_positions <- without_values(seq_len(column_count), positions)
    if (identical(inspected$flavor, "r.data.table")) {
      result <- isolated_snapshot(value, inspected$flavor)[, keep_positions, with = FALSE]
    } else {
      result <- isolated_snapshot(value, inspected$flavor)
      for (position in sort(positions, decreasing = TRUE)) result[[position]] <- NULL
    }
    result
  }

  drop_columns <- function(value, column_references) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    if (
      !is.list(column_references) ||
        is.object(column_references) ||
        !is.null(attributes(column_references)) ||
        length(column_references) == 0L
    ) {
      abort("invalid-view-query", "column_references must be a non-empty unnamed list")
    }
    resolved <- lapply(seq_along(column_references), function(index) {
      resolve_column_reference(
        column_references[[index]],
        inspected$descriptor,
        sprintf("column_references[[%d]]", index)
      )
    })
    column_ids <- vapply(resolved, `[[`, character(1L), "columnId", USE.NAMES = FALSE)
    if (anyDuplicated(column_ids)) {
      abort("invalid-view-query", "column_references may address each column only once")
    }
    positions <- vapply(resolved, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    expected_names <- vapply(resolved, `[[`, character(1L), "name", USE.NAMES = FALSE)
    drop_columns_at(value, positions, expected_names)
  }

  select_columns_at <- function(value, positions, expected_names) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    if (
      !is.numeric(positions) ||
        anyNA(positions) ||
        any(!is.finite(positions)) ||
        any(positions != floor(positions)) ||
        length(positions) == 0L ||
        any(positions < 1L) ||
        any(positions > column_count) ||
        anyDuplicated(positions)
    ) {
      abort("stale-column", "the selected column positions no longer match the R dataframe")
    }
    positions <- as.integer(positions)
    if (!is.character(expected_names) || length(expected_names) != length(positions) || anyNA(expected_names)) {
      abort("stale-column", "the selected column names no longer match the R dataframe")
    }
    expected_names <- vapply(seq_along(expected_names), function(index) {
      bounded_utf8(expected_names[[index]], sprintf("expected_names[[%d]]", index), maximum_name_bytes)
    }, character(1L), USE.NAMES = FALSE)
    if (!identical(names(value)[positions], expected_names)) {
      abort("stale-column", "the selected column names no longer match the R dataframe")
    }
    if (any(vapply(expected_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }

    result <- isolated_snapshot(value, inspected$flavor)
    if (identical(inspected$flavor, "r.data.table")) {
      result <- result[, positions, with = FALSE]
    } else {
      result <- result[positions]
      names(result) <- expected_names
    }
    result
  }

  select_columns <- function(value, column_references) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    if (
      !is.list(column_references) ||
        is.object(column_references) ||
        !is.null(attributes(column_references)) ||
        length(column_references) == 0L
    ) {
      abort("invalid-view-query", "column_references must be a non-empty unnamed list")
    }
    resolved <- lapply(seq_along(column_references), function(index) {
      resolve_column_reference(
        column_references[[index]],
        inspected$descriptor,
        sprintf("column_references[[%d]]", index)
      )
    })
    column_ids <- vapply(resolved, `[[`, character(1L), "columnId", USE.NAMES = FALSE)
    if (anyDuplicated(column_ids)) {
      abort("invalid-view-query", "column_references may address each column only once")
    }
    positions <- vapply(resolved, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    expected_names <- vapply(resolved, `[[`, character(1L), "name", USE.NAMES = FALSE)
    select_columns_at(value, positions, expected_names)
  }

  compare_unsigned_decimal <- function(left, right) {
    left <- sub("^0+(?=.)", "", left, perl = TRUE)
    right <- sub("^0+(?=.)", "", right, perl = TRUE)
    if (nchar(left, type = "bytes") != nchar(right, type = "bytes")) {
      return(sign(nchar(left, type = "bytes") - nchar(right, type = "bytes")))
    }
    if (identical(left, right)) return(0L)
    if (left < right) -1L else 1L
  }

  add_unsigned_decimal <- function(left, right) {
    left_digits <- rev(utf8ToInt(left) - utf8ToInt("0"))
    right_digits <- rev(utf8ToInt(right) - utf8ToInt("0"))
    width <- max(length(left_digits), length(right_digits))
    length(left_digits) <- width
    length(right_digits) <- width
    left_digits[is.na(left_digits)] <- 0L
    right_digits[is.na(right_digits)] <- 0L
    output <- integer(width + 1L)
    carry <- 0L
    for (index in seq_len(width)) {
      total <- left_digits[[index]] + right_digits[[index]] + carry
      output[[index]] <- total %% 10L
      carry <- total %/% 10L
    }
    output[[width + 1L]] <- carry
    while (length(output) > 1L && output[[length(output)]] == 0L) {
      output <- output[-length(output)]
    }
    intToUtf8(rev(output) + utf8ToInt("0"), multiple = FALSE)
  }

  subtract_unsigned_decimal <- function(left, right) {
    if (compare_unsigned_decimal(left, right) < 0L) {
      abort("internal-error", "unsigned decimal subtraction underflowed")
    }
    left_digits <- rev(utf8ToInt(left) - utf8ToInt("0"))
    right_digits <- rev(utf8ToInt(right) - utf8ToInt("0"))
    length(right_digits) <- length(left_digits)
    right_digits[is.na(right_digits)] <- 0L
    output <- integer(length(left_digits))
    borrow <- 0L
    for (index in seq_along(left_digits)) {
      digit <- left_digits[[index]] - right_digits[[index]] - borrow
      if (digit < 0L) {
        digit <- digit + 10L
        borrow <- 1L
      } else {
        borrow <- 0L
      }
      output[[index]] <- digit
    }
    if (borrow != 0L) abort("internal-error", "unsigned decimal subtraction underflowed")
    while (length(output) > 1L && output[[length(output)]] == 0L) {
      output <- output[-length(output)]
    }
    intToUtf8(rev(output) + utf8ToInt("0"), multiple = FALSE)
  }

  add_signed_decimal <- function(left, right) {
    split_sign <- function(value) {
      negative <- startsWith(value, "-")
      magnitude <- if (negative) substring(value, 2L) else value
      magnitude <- sub("^0+(?=.)", "", magnitude, perl = TRUE)
      list(negative = negative && !identical(magnitude, "0"), magnitude = magnitude)
    }
    left_parts <- split_sign(left)
    right_parts <- split_sign(right)
    if (identical(left_parts$negative, right_parts$negative)) {
      magnitude <- add_unsigned_decimal(left_parts$magnitude, right_parts$magnitude)
      return(if (left_parts$negative && !identical(magnitude, "0")) paste0("-", magnitude) else magnitude)
    }
    comparison <- compare_unsigned_decimal(left_parts$magnitude, right_parts$magnitude)
    if (comparison == 0L) return("0")
    if (comparison > 0L) {
      magnitude <- subtract_unsigned_decimal(left_parts$magnitude, right_parts$magnitude)
      negative <- left_parts$negative
    } else {
      magnitude <- subtract_unsigned_decimal(right_parts$magnitude, left_parts$magnitude)
      negative <- right_parts$negative
    }
    if (negative) paste0("-", magnitude) else magnitude
  }

  exact_integer_sum_text <- function(values, kind) {
    total <- "0"
    if (length(values) == 0L) return(total)
    if (identical(kind, "integer")) {
      # Each batch stays below 2^53, so its double sum is still an exact
      # integer. Only the small set of batch totals needs decimal folding.
      batch_size <- 1000000L
      starts <- seq.int(1L, length(values), by = batch_size)
      for (start in starts) {
        end <- min(length(values), start + batch_size - 1L)
        batch <- sum(as.double(values[start:end]))
        total <- add_signed_decimal(total, sprintf("%.0f", batch))
      }
      return(total)
    }
    for (value in as.character(values)) total <- add_signed_decimal(total, value)
    total
  }

  signed_decimal_in_range <- function(value, minimum, maximum) {
    if (startsWith(value, "-")) {
      compare_unsigned_decimal(substring(value, 2L), substring(minimum, 2L)) <= 0L
    } else {
      compare_unsigned_decimal(value, maximum) <= 0L
    }
  }

  group_rows <- function(value, key_positions, key_semantics) {
    row_positions <- seq_len(nrow(value))
    if (length(row_positions) == 0L) return(list())
    for (key_index in rev(seq_along(key_positions))) {
      key_position <- key_positions[[key_index]]
      key_values <- value[[key_position]][row_positions]
      missing <- is.na(key_values)
      present_positions <- which(!missing)
      present_order <- order_present_values(
        key_values[present_positions],
        key_semantics[[key_index]],
        FALSE
      )
      row_positions <- c(row_positions[missing], row_positions[present_positions[present_order]])
    }

    same_group <- rep(TRUE, max(0L, length(row_positions) - 1L))
    if (length(row_positions) > 1L) {
      left_rows <- row_positions[-length(row_positions)]
      right_rows <- row_positions[-1L]
      for (key_position in key_positions) {
        left <- value[[key_position]][left_rows]
        right <- value[[key_position]][right_rows]
        left_missing <- is.na(left)
        right_missing <- is.na(right)
        equal <- (left_missing & right_missing) | (!left_missing & !right_missing & left == right)
        equal[is.na(equal)] <- FALSE
        same_group <- same_group & equal
      }
    }
    starts <- c(1L, which(!same_group) + 1L)
    ends <- c(starts[-1L] - 1L, length(row_positions))
    groups <- lapply(seq_along(starts), function(index) {
      sort(row_positions[starts[[index]]:ends[[index]]], method = "radix")
    })
    first_rows <- vapply(groups, `[[`, integer(1L), 1L, USE.NAMES = FALSE)
    groups[order(first_rows, method = "radix")]
  }

  safe_group_mean <- function(values, semantics) {
    if (identical(semantics$kind, "integer64")) {
      total <- exact_integer_sum_text(values, semantics$kind)
      return(suppressWarnings(as.double(total)) / length(values))
    }
    values <- suppressWarnings(as.double(values))
    positive_infinity <- any(is.infinite(values) & values > 0)
    negative_infinity <- any(is.infinite(values) & values < 0)
    if (positive_infinity && negative_infinity) return(NaN)
    if (positive_infinity) return(Inf)
    if (negative_infinity) return(-Inf)
    scale <- max(abs(values))
    if (scale == 0) return(0)
    max(-1, min(1, mean(values / scale))) * scale
  }

  safe_group_median <- function(values, semantics) {
    if (identical(semantics$kind, "integer64")) {
      ordered <- values[order_integer64(values, FALSE)]
      count <- length(ordered)
      lower <- suppressWarnings(as.double(ordered[[(count + 1L) %/% 2L]]))
      if (count %% 2L == 1L) return(lower)
      total <- exact_integer_sum_text(
        ordered[c((count + 1L) %/% 2L, (count + 2L) %/% 2L)],
        semantics$kind
      )
      return(suppressWarnings(as.double(total)) / 2)
    }
    ordered <- sort(as.double(values), method = "radix")
    count <- length(ordered)
    lower <- ordered[[(count + 1L) %/% 2L]]
    if (count %% 2L == 1L) return(lower)
    safe_float_midpoint(lower, ordered[[(count + 2L) %/% 2L]])
  }

  aggregate_group_column <- function(column, semantics, groups, operation, alias) {
    group_count <- length(groups)
    output <- if (operation %in% c("count", "nUnique")) {
      integer(group_count)
    } else if (operation %in% c("mean", "median")) {
      rep(NA_real_, group_count)
    } else if (operation %in% c("min", "max") && identical(semantics$kind, "factor") && !semantics$ordered) {
      rep(NA_character_, group_count)
    } else if (identical(operation, "sum") && identical(semantics$kind, "integer")) {
      integer(group_count)
    } else if (identical(operation, "sum") && identical(semantics$kind, "integer64")) {
      if (!requireNamespace("bit64", quietly = TRUE)) {
        abort("missing-package", "bit64 is required to sum an integer64 column")
      }
      rep(bit64::as.integer64(0L), group_count)
    } else if (identical(operation, "sum")) {
      numeric(group_count)
    } else {
      column[rep(NA_integer_, group_count)]
    }

    for (group_index in seq_along(groups)) {
      rows <- groups[[group_index]]
      present_rows <- rows[!is.na(column[rows])]
      if (identical(operation, "count")) {
        output[[group_index]] <- as.integer(length(present_rows))
        next
      }
      if (identical(operation, "nUnique")) {
        output[[group_index]] <- as.integer(length(unique(column[present_rows])))
        next
      }
      if (length(present_rows) == 0L) {
        if (identical(operation, "sum")) {
          if (identical(semantics$kind, "integer64")) {
            output[[group_index]] <- bit64::as.integer64(0L)
          } else if (identical(semantics$kind, "integer")) {
            output[[group_index]] <- 0L
          } else {
            output[[group_index]] <- 0
          }
        }
        next
      }
      present <- column[present_rows]
      if (identical(operation, "sum")) {
        if (identical(semantics$kind, "integer")) {
          total <- exact_integer_sum_text(present, semantics$kind)
          if (!signed_decimal_in_range(total, "-2147483647", "2147483647")) {
            abort(
              "operation-output-too-large",
              sprintf("Group By sum for %s is outside R's integer range", alias)
            )
          }
          output[[group_index]] <- as.integer(total)
        } else if (identical(semantics$kind, "integer64")) {
          total <- exact_integer_sum_text(present, semantics$kind)
          if (!signed_decimal_in_range(total, "-9223372036854775807", "9223372036854775807")) {
            abort(
              "operation-output-too-large",
              sprintf("Group By sum for %s is outside the integer64 range", alias)
            )
          }
          output[[group_index]] <- bit64::as.integer64(total)
        } else {
          output[[group_index]] <- sum(present)
        }
      } else if (identical(operation, "mean")) {
        output[[group_index]] <- safe_group_mean(present, semantics)
      } else if (identical(operation, "median")) {
        output[[group_index]] <- safe_group_median(present, semantics)
      } else if (operation %in% c("min", "max")) {
        if (identical(semantics$kind, "factor") && !semantics$ordered) {
          reducer <- if (identical(operation, "min")) base::min else base::max
          output[[group_index]] <- reducer(as.character(present))
        } else if (identical(semantics$kind, "logical")) {
          reducer <- if (identical(operation, "min")) base::min else base::max
          output[[group_index]] <- as.logical(reducer(present))
        } else if (identical(semantics$kind, "integer64")) {
          ordered <- present[order_integer64(present, identical(operation, "max"))]
          output[[group_index]] <- ordered[[1L]]
        } else {
          reducer <- if (identical(operation, "min")) base::min else base::max
          output[[group_index]] <- reducer(present)
        }
      } else if (identical(operation, "first")) {
        output[[group_index]] <- present[[1L]]
      } else if (identical(operation, "last")) {
        output[[group_index]] <- present[[length(present)]]
      } else {
        abort("internal-error", "unknown R Group By aggregation")
      }
    }
    output
  }

  group_by_at <- function(
    value,
    key_positions,
    key_names,
    aggregation_positions,
    aggregation_names,
    operations,
    aliases
  ) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    valid_positions <- function(positions, allow_duplicates) {
      is.numeric(positions) &&
        !anyNA(positions) &&
        all(is.finite(positions)) &&
        all(positions == floor(positions)) &&
        length(positions) > 0L &&
        all(positions >= 1L) &&
        all(positions <= column_count) &&
        (allow_duplicates || !anyDuplicated(positions))
    }
    if (!valid_positions(key_positions, FALSE)) {
      abort("stale-column", "the Group By key positions no longer match the R dataframe")
    }
    if (!valid_positions(aggregation_positions, TRUE)) {
      abort("stale-column", "the Group By aggregation positions no longer match the R dataframe")
    }
    key_positions <- as.integer(key_positions)
    aggregation_positions <- as.integer(aggregation_positions)
    validate_names <- function(values, positions, label) {
      if (!is.character(values) || anyNA(values) || length(values) != length(positions)) {
        abort("stale-column", sprintf("the Group By %s names no longer match the R dataframe", label))
      }
      values <- vapply(seq_along(values), function(index) {
        bounded_utf8(values[[index]], sprintf("%s_names[[%d]]", label, index), maximum_name_bytes)
      }, character(1L), USE.NAMES = FALSE)
      if (!identical(names(value)[positions], values)) {
        abort("stale-column", sprintf("the Group By %s names no longer match the R dataframe", label))
      }
      if (any(vapply(values, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      values
    }
    key_names <- validate_names(key_names, key_positions, "key")
    aggregation_names <- validate_names(aggregation_names, aggregation_positions, "aggregation")
    allowed_operations <- c("sum", "mean", "median", "min", "max", "count", "nUnique", "first", "last")
    if (
      !is.character(operations) ||
        anyNA(operations) ||
        length(operations) != length(aggregation_positions) ||
        any(!operations %in% allowed_operations)
    ) {
      abort("invalid-view-query", "the Group By aggregation operations are invalid")
    }
    if (!is.character(aliases) || anyNA(aliases) || length(aliases) != length(aggregation_positions)) {
      abort("invalid-view-query", "the Group By aliases are invalid")
    }
    aliases <- vapply(seq_along(aliases), function(index) {
      alias <- bounded_utf8(aliases[[index]], sprintf("aliases[[%d]]", index), maximum_name_bytes)
      if (identical(alias, "")) abort("invalid-column-name", "Group By aliases must not be empty")
      if (is_private_column_name(alias)) {
        abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
      }
      alias
    }, character(1L), USE.NAMES = FALSE)
    if (anyDuplicated(aliases) || any(aliases %in% key_names)) {
      abort("column-name-collision", "Group By aliases must be unique and must not collide with key columns")
    }
    if (length(key_positions) + length(aggregation_positions) > maximum_columns) {
      abort("operation-output-too-large", sprintf("Group By may produce at most %d columns", maximum_columns))
    }

    supported_kinds <- c("character", "factor", "integer", "integer64", "double", "logical", "date", "datetime", "difftime")
    key_semantics <- lapply(key_positions, function(position) inspected$descriptor$schema[[position]]$semantics)
    if (any(!vapply(key_semantics, function(semantics) semantics$kind %in% supported_kinds, logical(1L)))) {
      abort("invalid-view-query", "an R Group By key uses an unsupported type")
    }
    aggregation_semantics <- lapply(
      aggregation_positions,
      function(position) inspected$descriptor$schema[[position]]$semantics
    )
    for (index in seq_along(aggregation_semantics)) {
      kind <- aggregation_semantics[[index]]$kind
      operation <- operations[[index]]
      compatible <- kind %in% supported_kinds && (
        operation %in% c("count", "nUnique", "first", "last", "min", "max") ||
          (operation %in% c("sum", "mean", "median") && kind %in% c("integer", "integer64", "double"))
      )
      if (!compatible) {
        abort(
          "invalid-view-query",
          sprintf("R %s columns do not support the %s Group By aggregation", kind, operation)
        )
      }
    }

    groups <- group_rows(value, key_positions, key_semantics)
    first_rows <- if (length(groups) == 0L) integer() else {
      vapply(groups, `[[`, integer(1L), 1L, USE.NAMES = FALSE)
    }
    key_columns <- lapply(key_positions, function(position) {
      column <- value[[position]][first_rows]
      if (is.double(column) && !is.object(column)) column[is.na(column)] <- NA_real_
      column
    })
    aggregation_columns <- lapply(seq_along(aggregation_positions), function(index) {
      aggregate_group_column(
        value[[aggregation_positions[[index]]]],
        aggregation_semantics[[index]],
        groups,
        operations[[index]],
        aliases[[index]]
      )
    })
    result_columns <- c(key_columns, aggregation_columns)
    result_names <- c(key_names, aliases)
    names(result_columns) <- result_names
    result <- as.data.frame(result_columns, optional = TRUE, stringsAsFactors = FALSE)
    names(result) <- result_names
    row.names(result) <- NULL
    if (identical(inspected$flavor, "r.tibble")) {
      if (!requireNamespace("tibble", quietly = TRUE)) {
        abort("missing-package", "tibble is required to preserve an R tibble")
      }
      result <- tibble::as_tibble(result, .name_repair = "minimal")
    } else if (identical(inspected$flavor, "r.data.table")) {
      if (!requireNamespace("data.table", quietly = TRUE)) {
        abort("missing-package", "data.table is required to preserve an R data.table")
      }
      result <- data.table::as.data.table(result)
      data.table::setkeyv(result, NULL)
    }
    result
  }

  capture_group_result <- function(
    value,
    source_capture,
    key_positions,
    aggregation_positions,
    aggregation_operations,
    output_ids
  ) {
    validate_capture(source_capture)
    source_schema <- source_capture$descriptor$schema
    source_column_count <- length(source_schema)
    validate_positions <- function(positions, allow_duplicates, label) {
      if (
        !is.numeric(positions) ||
          anyNA(positions) ||
          any(!is.finite(positions)) ||
          any(positions != floor(positions)) ||
          length(positions) == 0L ||
          any(positions < 1L) ||
          any(positions > source_column_count) ||
          (!allow_duplicates && anyDuplicated(positions))
      ) {
        abort("internal-error", sprintf("a grouped R frame has invalid %s positions", label))
      }
      as.integer(positions)
    }
    key_positions <- validate_positions(key_positions, FALSE, "key")
    aggregation_positions <- validate_positions(aggregation_positions, TRUE, "aggregation")
    if (
      !is.character(aggregation_operations) ||
        anyNA(aggregation_operations) ||
        length(aggregation_operations) != length(aggregation_positions) ||
        any(!aggregation_operations %in% c("sum", "mean", "median", "min", "max", "count", "nUnique", "first", "last"))
    ) {
      abort("internal-error", "a grouped R frame has invalid aggregation operations")
    }
    expected_columns <- length(key_positions) + length(aggregation_positions)
    if (!is.character(output_ids) || anyNA(output_ids) || length(output_ids) != expected_columns) {
      abort("internal-error", "a grouped R frame has invalid output identities")
    }
    output_ids <- vapply(seq_along(output_ids), function(index) {
      bounded_utf8(output_ids[[index]], sprintf("output_ids[[%d]]", index), maximum_column_id_bytes)
    }, character(1L), USE.NAMES = FALSE)
    if (
      any(output_ids == "") ||
        anyDuplicated(output_ids) ||
        !all(vapply(output_ids, is_canonical_column_id, logical(1L), USE.NAMES = FALSE))
    ) {
      abort("internal-error", "a grouped R frame has invalid output identities")
    }
    expected_key_ids <- vapply(key_positions, function(position) source_schema[[position]]$id, character(1L))
    if (!identical(output_ids[seq_along(key_positions)], expected_key_ids)) {
      abort("internal-error", "a grouped R frame changed a key column identity")
    }
    source_ids <- vapply(source_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    aggregation_ids <- output_ids[length(key_positions) + seq_along(aggregation_positions)]
    if (any(aggregation_ids %in% source_ids)) {
      abort("internal-error", "a grouped R frame reused a source identity for an aggregation")
    }

    captured <- capture_frame(value)
    if (
      !identical(captured$descriptor$dataframeFlavor, source_capture$descriptor$dataframeFlavor) ||
        captured$descriptor$shape$columns != expected_columns
    ) {
      abort("internal-error", "a grouped R frame changed dataframe family or width")
    }
    output_schema <- captured$descriptor$schema
    expected_key_names <- vapply(key_positions, function(position) source_schema[[position]]$name, character(1L))
    if (!identical(vapply(output_schema[seq_along(key_positions)], `[[`, character(1L), "name"), expected_key_names)) {
      abort("internal-error", "a grouped R frame changed a key column name")
    }
    for (index in seq_along(key_positions)) {
      source_column <- source_schema[[key_positions[[index]]]]
      output_column <- output_schema[[index]]
      if (
        !identical(output_column$rawType, source_column$rawType) ||
          !identical(output_column$type, source_column$type) ||
          !identical(output_column$semantics, source_column$semantics)
      ) {
        abort("internal-error", "a grouped R frame changed key column type metadata")
      }
      output_schema[[index]]$nullable <- source_column$nullable
    }
    for (aggregation_index in seq_along(aggregation_positions)) {
      output_index <- length(key_positions) + aggregation_index
      source_column <- source_schema[[aggregation_positions[[aggregation_index]]]]
      output_column <- output_schema[[output_index]]
      operation <- aggregation_operations[[aggregation_index]]
      expected_kind <- if (operation %in% c("count", "nUnique")) {
        "integer"
      } else if (operation %in% c("mean", "median")) {
        "double"
      } else if (
        operation %in% c("min", "max") &&
          identical(source_column$semantics$kind, "factor") &&
          !source_column$semantics$ordered
      ) {
        "character"
      } else {
        source_column$semantics$kind
      }
      if (!identical(output_column$semantics$kind, expected_kind)) {
        abort("internal-error", "a grouped R frame produced an invalid aggregation type")
      }
      if (
        expected_kind == source_column$semantics$kind &&
          !identical(output_column$semantics, source_column$semantics)
      ) {
        abort("internal-error", "a grouped R frame changed aggregation type metadata")
      }
      output_schema[[output_index]]$nullable <- if (operation %in% c("sum", "count", "nUnique")) {
        FALSE
      } else {
        source_column$nullable
      }
    }
    generated_ids <- vapply(output_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    for (index in seq_along(output_schema)) {
      output_schema[[index]]$id <- output_ids[[index]]
      output_schema[[index]]$position <- index - 1L
    }
    descriptor <- captured$descriptor
    descriptor$schema <- json_array(output_schema)
    descriptor$frameSemantics$keyColumnIds <- json_array(character())
    old_id_bytes <- sum(vapply(generated_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
    new_id_bytes <- sum(vapply(output_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
    metadata_bytes <- captured$metadataBytes
    if (new_id_bytes > old_id_bytes) {
      budget <- new_payload_budget(metadata_bytes)
      spend_payload_budget(budget, new_id_bytes - old_id_bytes, "grouped R column identities")
      metadata_bytes <- budget$used
    }

    group_count <- as.double(descriptor$shape$rows)
    source_identity_domain <- as.double(source_capture$rowIdentityDomain)
    row_identity_domain <- source_identity_domain + group_count
    if (!is.finite(row_identity_domain) || row_identity_domain > maximum_rows) {
      abort(
        "operation-output-too-large",
        sprintf("Group By cannot expand the R row-identity domain beyond %s rows", format(maximum_rows))
      )
    }
    result <- new.env(parent = emptyenv())
    result$mode <- "isolated"
    result$snapshot <- captured$snapshot
    result$sourceReader <- NULL
    result$descriptor <- descriptor
    set_sequential_row_origins(result, group_count, row_identity_domain, source_identity_domain)
    result$metadataBytes <- metadata_bytes
    result$metrics <- captured$metrics
    result$sortCache <- new_sort_cache()
    finish_capture(result)
  }

  validate_custom_code_output_budget <- function(frame, descriptor) {
    schema <- plain_metadata_storage(descriptor$schema)
    row_count <- as.double(descriptor$shape$rows)
    budget <- new_payload_budget()

    validate_nested_metadata <- function(value, label, allow_asis = FALSE) {
      nested <- attributes(value)
      if (is.null(nested)) return(invisible(NULL))
      if (
        !isTRUE(allow_asis) ||
          !identical(names(nested), "class") ||
          !identical(plain_metadata_storage(nested$class), "AsIs") ||
          !is.null(attributes(nested$class))
      ) {
        abort("invalid-view-query", sprintf("%s has unsupported nested attributes", label))
      }
      spend_operation_output_budget(
        budget,
        character_vector_slot_bytes + nchar("AsIs", type = "bytes"),
        label
      )
      invisible(NULL)
    }

    charge_text <- function(
      values,
      label,
      maximum_bytes = maximum_text_bytes,
      charge_slots = TRUE
    ) {
      if (!is.character(values)) {
        abort("invalid-view-query", sprintf("%s must be text", label))
      }
      plain <- plain_metadata_storage(values)
      if (isTRUE(charge_slots)) {
        spend_operation_output_budget(
          budget,
          as.double(storage_length(plain)) * character_vector_slot_bytes,
          label
        )
      }
      for (index in seq_along(plain)) {
        item <- .subset2(plain, index)
        if (is.na(item)) next
        item <- bounded_utf8(item, sprintf("%s %d", label, index), maximum_bytes)
        spend_operation_output_budget(budget, nchar(item, type = "bytes"), label)
      }
      invisible(NULL)
    }

    spend_operation_output_budget(
      budget,
      metadata_base_bytes + as.double(length(schema)) * column_fixed_bytes,
      "custom-code frame metadata"
    )
    validate_nested_metadata(attr(frame, "names", exact = TRUE), "custom-code column names", TRUE)
    charge_text(
      vapply(schema, `[[`, character(1L), "name", USE.NAMES = FALSE),
      "custom-code column names",
      maximum_name_bytes
    )
    charge_text(
      plain_metadata_storage(descriptor$frameSemantics$classes),
      "custom-code frame classes",
      maximum_name_bytes
    )
    if (identical(descriptor$dataframeFlavor, "r.data.table")) {
      validate_nested_metadata(attr(frame, "sorted", exact = TRUE), "custom-code data.table key", TRUE)
      charge_text(
        data_table_key_names(frame),
        "custom-code data.table key",
        maximum_name_bytes
      )
    }

    raw_frame_row_names <- attr(frame, "row.names", exact = TRUE)
    validate_nested_metadata(raw_frame_row_names, "custom-code row names")
    frame_row_names <- tryCatch(
      .row_names_info(frame, type = 0L),
      error = function(error) error
    )
    if (
      inherits(frame_row_names, "error") ||
        (!is.integer(frame_row_names) && !is.character(frame_row_names))
    ) {
      abort("invalid-view-query", "custom-code row names are malformed")
    }
    validate_nested_metadata(frame_row_names, "custom-code canonical row names")
    if (is.character(frame_row_names)) {
      charge_text(frame_row_names, "custom-code row names", maximum_name_bytes)
    } else {
      spend_operation_output_budget(
        budget,
        as.double(storage_length(frame_row_names)) * 4,
        "custom-code row names"
      )
    }

    for (position in seq_along(schema)) {
      column <- .subset2(frame, position)
      semantics <- schema[[position]]$semantics
      kind <- semantics$kind
      raw_classes <- attr(column, "class", exact = TRUE)
      if (!is.null(raw_classes)) {
        validate_nested_metadata(raw_classes, sprintf("custom-code column %d classes", position), TRUE)
        charge_text(
          raw_classes,
          sprintf("custom-code column %d classes", position),
          maximum_name_bytes
        )
      }
      element_bytes <- if (kind %in% c("logical", "integer", "factor")) 4 else 8
      spend_operation_output_budget(
        budget,
        row_count * element_bytes,
        sprintf("custom-code column %d", position)
      )

      element_names <- attr(column, "names", exact = TRUE)
      if (!is.null(element_names)) {
        charge_text(element_names, sprintf("custom-code column %d names", position))
      }
      if (identical(kind, "character")) {
        charge_text(
          column,
          sprintf("custom-code column %d values", position),
          charge_slots = FALSE
        )
      } else if (identical(kind, "factor")) {
        validate_nested_metadata(
          attr(column, "levels", exact = TRUE),
          sprintf("custom-code column %d factor levels", position),
          TRUE
        )
        charge_text(
          attr(column, "levels", exact = TRUE),
          sprintf("custom-code column %d factor levels", position)
        )
      } else if (kind %in% c("date", "datetime", "difftime")) {
        storage <- unclass(column)
        if (any(is.nan(storage)) || any(!is.na(storage) & !is.finite(storage))) {
          abort("invalid-view-query", sprintf("custom-code column %d contains non-finite classed values", position))
        }
        if (identical(kind, "date") && any(!is.na(storage) & storage != floor(storage))) {
          abort("invalid-view-query", sprintf("custom-code column %d contains a fractional Date", position))
        }
        if (identical(kind, "datetime") && !is.null(attr(column, "tzone", exact = TRUE))) {
          validate_nested_metadata(
            attr(column, "tzone", exact = TRUE),
            sprintf("custom-code column %d timezone", position),
            TRUE
          )
          charge_text(
            attr(column, "tzone", exact = TRUE),
            sprintf("custom-code column %d timezone", position),
            maximum_name_bytes
          )
        }
        if (identical(kind, "difftime")) {
          validate_nested_metadata(
            attr(column, "units", exact = TRUE),
            sprintf("custom-code column %d duration units", position),
            TRUE
          )
          charge_text(
            attr(column, "units", exact = TRUE),
            sprintf("custom-code column %d duration units", position),
            maximum_name_bytes
          )
        }
      }
    }
    invisible(NULL)
  }

  preflight_custom_code_output_storage <- function(frame) {
    raw_row_names <- attr(frame, "row.names", exact = TRUE)
    if (!is.integer(raw_row_names) && !is.character(raw_row_names)) {
      abort("unsupported-frame", "the dataframe has malformed row names")
    }
    if (!is.null(attributes(raw_row_names))) {
      abort("unsupported-frame", "the dataframe row names have unsupported nested attributes")
    }
    canonical_row_names <- tryCatch(
      .row_names_info(frame, type = 0L),
      error = function(error) error
    )
    if (
      inherits(canonical_row_names, "error") ||
        (!is.integer(canonical_row_names) && !is.character(canonical_row_names)) ||
        !is.null(attributes(canonical_row_names))
    ) {
      abort("unsupported-frame", "the dataframe has malformed row names")
    }
    row_names <- plain_metadata_storage(canonical_row_names)
    compact <- is.integer(row_names) &&
      length(row_names) == 2L &&
      is.na(.subset2(row_names, 1L))
    if (compact) {
      terminal <- .subset2(row_names, 2L)
      if (is.na(terminal) || terminal == 0L) {
        abort("unsupported-frame", "the dataframe has malformed row names")
      }
      row_count <- abs(as.double(terminal))
    } else {
      row_count <- as.double(length(row_names))
    }
    if (!is.finite(row_count) || row_count != floor(row_count) || row_count > maximum_rows) {
      abort("unsupported-frame", "the dataframe has malformed row names")
    }
    columns <- unclass(frame)
    column_count <- as.double(length(columns))
    lower_bound <- metadata_base_bytes + column_count * column_fixed_bytes

    add_vector_slots <- function(value, width = character_vector_slot_bytes) {
      if (is.null(value)) return(invisible(NULL))
      lower_bound <<- lower_bound + as.double(storage_length(value)) * width
      if (!is.null(attributes(value))) lower_bound <<- lower_bound + character_vector_slot_bytes + 4
      if (!is.finite(lower_bound) || lower_bound > maximum_operation_output_bytes) {
        abort(
          "operation-output-too-large",
          sprintf(
            "Custom Code exceeds the %d-byte R operation output budget before value inspection",
            maximum_operation_output_bytes
          )
        )
      }
      invisible(NULL)
    }

    add_vector_slots(attr(frame, "names", exact = TRUE))
    add_vector_slots(attr(frame, "class", exact = TRUE))
    add_vector_slots(row_names, if (is.character(row_names)) character_vector_slot_bytes else 4)
    add_vector_slots(attr(frame, "sorted", exact = TRUE))
    for (position in seq_along(columns)) {
      column <- .subset2(columns, position)
      element_bytes <- if (typeof(column) %in% c("logical", "integer")) 4 else 8
      lower_bound <- lower_bound + row_count * element_bytes
      add_vector_slots(attr(column, "names", exact = TRUE))
      add_vector_slots(attr(column, "class", exact = TRUE))
      add_vector_slots(attr(column, "levels", exact = TRUE))
      add_vector_slots(attr(column, "tzone", exact = TRUE))
      add_vector_slots(attr(column, "units", exact = TRUE))
      if (!is.finite(lower_bound) || lower_bound > maximum_operation_output_bytes) {
        abort(
          "operation-output-too-large",
          sprintf(
            "Custom Code exceeds the %d-byte R operation output budget before value inspection",
            maximum_operation_output_bytes
          )
        )
      }
    }
    validate_frame_structure(frame)
    invisible(NULL)
  }

  capture_custom_code_result <- function(value, source_capture, step_id) {
    validate_capture(source_capture)
    step_id <- bounded_utf8(step_id, "custom-code step identity", maximum_step_id_bytes)
    if (identical(step_id, "")) {
      abort("invalid-view-query", "custom-code step identity must not be empty")
    }
    if (!is.data.frame(value)) {
      abort("invalid-view-query", "Custom Code must assign an R dataframe to result")
    }

    normalized <- normalize_supported_frame(value)
    preflight_custom_code_output_storage(normalized)
    preflight_metrics <- new_capture_metrics()
    preflight <- inspect_frame(
      normalized,
      conservative_nullable = FALSE,
      validate_values = TRUE,
      metrics = preflight_metrics
    )
    if (!identical(
      preflight$descriptor$dataframeFlavor,
      source_capture$descriptor$dataframeFlavor
    )) {
      abort("invalid-view-query", "Custom Code must return the same R dataframe flavor as its input")
    }
    if (preflight$descriptor$shape$columns < 1L) {
      abort("invalid-view-query", "Custom Code must return at least one column")
    }
    validate_custom_code_output_budget(normalized, preflight$descriptor)

    captured <- capture_frame(normalized, preserve_data_table_element_names = TRUE)
    if (!identical(captured$descriptor, preflight$descriptor)) {
      abort("internal-error", "Custom Code output changed while it was captured")
    }

    source_schema <- plain_metadata_storage(source_capture$descriptor$schema)
    output_schema <- plain_metadata_storage(captured$descriptor$schema)
    source_names <- vapply(source_schema, `[[`, character(1L), "name", USE.NAMES = FALSE)
    source_ids <- vapply(source_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    output_names <- vapply(output_schema, `[[`, character(1L), "name", USE.NAMES = FALSE)
    if (any(output_names == "")) {
      abort("invalid-view-query", "Custom Code must return non-empty column names")
    }
    if (any(vapply(output_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }

    consumed <- logical(length(source_schema))
    created_ordinal <- 0L
    output_ids <- vapply(seq_along(output_schema), function(position) {
      matches <- which(!consumed & source_names == output_names[[position]])
      if (length(matches) != 0L) {
        matched <- matches[[1L]]
        consumed[[matched]] <<- TRUE
        return(source_ids[[matched]])
      }
      result <- bounded_utf8(
        paste0("c:step:", step_id, ":", created_ordinal),
        sprintf("custom-code output identity %d", position),
        maximum_column_id_bytes
      )
      created_ordinal <<- created_ordinal + 1L
      result
    }, character(1L), USE.NAMES = FALSE)
    if (
      anyDuplicated(output_ids) ||
        !all(vapply(output_ids, is_canonical_column_id, logical(1L), USE.NAMES = FALSE))
    ) {
      abort("internal-error", "Custom Code produced conflicting output identities")
    }

    generated_ids <- vapply(output_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    for (position in seq_along(output_schema)) {
      output_schema[[position]]$id <- output_ids[[position]]
      output_schema[[position]]$position <- position - 1L
    }
    descriptor <- captured$descriptor
    descriptor$schema <- json_array(output_schema)
    generated_key_ids <- plain_metadata_storage(descriptor$frameSemantics$keyColumnIds)
    if (length(generated_key_ids) != 0L) {
      key_positions <- match(generated_key_ids, generated_ids)
      if (anyNA(key_positions)) {
        abort("internal-error", "Custom Code returned invalid data.table key metadata")
      }
      descriptor$frameSemantics$keyColumnIds <- json_array(output_ids[key_positions])
    }

    metadata_bytes <- captured$metadataBytes
    old_identity_bytes <- sum(vapply(generated_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
    new_identity_bytes <- sum(vapply(output_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
    old_key_bytes <- sum(vapply(generated_key_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
    new_key_ids <- plain_metadata_storage(descriptor$frameSemantics$keyColumnIds)
    new_key_bytes <- sum(vapply(new_key_ids, json_string_bytes, double(1L), USE.NAMES = FALSE))
    additional_bytes <- max(0, new_identity_bytes - old_identity_bytes) + max(0, new_key_bytes - old_key_bytes)
    if (additional_bytes != 0) {
      metadata_budget <- new_payload_budget(metadata_bytes)
      spend_payload_budget(metadata_budget, additional_bytes, "custom-code output identities")
      metadata_bytes <- metadata_budget$used
    }

    output_rows <- as.double(descriptor$shape$rows)
    source_domain <- as.double(source_capture$rowIdentityDomain)
    row_identity_domain <- source_domain + output_rows
    if (!is.finite(row_identity_domain) || row_identity_domain > maximum_rows) {
      abort(
        "operation-output-too-large",
        sprintf("Custom Code cannot expand the R row-identity domain beyond %s rows", format(maximum_rows))
      )
    }
    result <- new.env(parent = emptyenv())
    result$mode <- "isolated"
    result$snapshot <- captured$snapshot
    result$sourceReader <- NULL
    result$descriptor <- descriptor
    set_sequential_row_origins(result, output_rows, row_identity_domain, source_domain)
    result$metadataBytes <- metadata_bytes
    result$metrics <- captured$metrics
    result$sortCache <- new_sort_cache()
    finish_capture(result)
  }

  resolve_row_operation_columns <- function(value, positions, expected_names, operation) {
    inspected <- inspect_frame(
      value,
      conservative_nullable = TRUE,
      validate_values = FALSE,
      metrics = new_capture_metrics()
    )
    column_count <- inspected$descriptor$shape$columns
    if (
      !is.numeric(positions) ||
        anyNA(positions) ||
        any(!is.finite(positions)) ||
        any(positions != floor(positions)) ||
        any(positions < 1L) ||
        any(positions > column_count) ||
        anyDuplicated(positions)
    ) {
      abort("stale-column", sprintf("the %s column positions no longer match the R dataframe", operation))
    }
    positions <- as.integer(positions)
    if (!is.character(expected_names) || length(expected_names) != length(positions) || anyNA(expected_names)) {
      abort("stale-column", sprintf("the %s column names no longer match the R dataframe", operation))
    }
    expected_names <- vapply(seq_along(expected_names), function(index) {
      bounded_utf8(expected_names[[index]], sprintf("expected_names[[%d]]", index), maximum_name_bytes)
    }, character(1L), USE.NAMES = FALSE)
    if (!identical(names(value)[positions], expected_names)) {
      abort("stale-column", sprintf("the %s column names no longer match the R dataframe", operation))
    }
    if (any(vapply(expected_names, is_private_column_name, logical(1L), USE.NAMES = FALSE))) {
      abort("reserved-column-name", "Open Wrangler's private row-identity prefix is reserved")
    }
    list(inspected = inspected, positions = positions)
  }

  subset_rows_at <- function(value, inspected, row_positions) {
    row_count <- inspected$descriptor$shape$rows
    if (
      !is.numeric(row_positions) ||
        anyNA(row_positions) ||
        any(!is.finite(row_positions)) ||
        any(row_positions != floor(row_positions)) ||
        any(row_positions < 1L) ||
        any(row_positions > row_count) ||
        anyDuplicated(row_positions)
    ) {
      abort("internal-error", "an R row operation produced invalid source positions")
    }
    row_positions <- as.integer(row_positions)
    snapshot <- isolated_snapshot(value, inspected$flavor)
    result <- if (identical(inspected$flavor, "r.data.table")) {
      snapshot[row_positions]
    } else {
      snapshot[row_positions, , drop = FALSE]
    }
    list(frame = result, sourcePositions = row_positions)
  }

  drop_missing_rows_at <- function(value, positions, expected_names, how = "any") {
    resolved <- resolve_row_operation_columns(value, positions, expected_names, "drop-missing")
    if (!is.character(how) || length(how) != 1L || is.na(how) || !how %in% c("any", "all")) {
      abort("invalid-view-query", "dropMissingRows how must be any or all")
    }
    if (length(resolved$positions) == 0L) {
      return(subset_rows_at(value, resolved$inspected, seq_len(resolved$inspected$descriptor$shape$rows)))
    }
    present <- lapply(resolved$positions, function(position) !is.na(value[[position]]))
    keep <- if (identical(how, "all")) Reduce(`|`, present) else Reduce(`&`, present)
    subset_rows_at(value, resolved$inspected, which(keep))
  }

  drop_duplicate_rows_at <- function(value, positions, expected_names, keep = "first") {
    resolved <- resolve_row_operation_columns(value, positions, expected_names, "drop-duplicates")
    if (!is.character(keep) || length(keep) != 1L || is.na(keep) || !keep %in% c("first", "last", "none")) {
      abort("invalid-view-query", "dropDuplicates keep must be first, last, or none")
    }
    if (length(resolved$positions) == 0L) {
      return(subset_rows_at(value, resolved$inspected, seq_len(resolved$inspected$descriptor$shape$rows)))
    }
    compared <- if (identical(resolved$inspected$flavor, "r.data.table")) {
      value[, resolved$positions, with = FALSE]
    } else {
      value[resolved$positions]
    }
    duplicates <- if (identical(keep, "first")) {
      duplicated(compared)
    } else if (identical(keep, "last")) {
      duplicated(compared, fromLast = TRUE)
    } else {
      duplicated(compared) | duplicated(compared, fromLast = TRUE)
    }
    subset_rows_at(value, resolved$inspected, which(!duplicates))
  }

  validate_capture <- function(capture) {
    if (!is.environment(capture) || !identical(class(capture), "openwrangler_r_frame_capture")) {
      abort("invalid-capture", "capture must come from capture_frame or capture_live_frame")
    }
    actual_fields <- base::sort.int(ls(envir = capture, all.names = TRUE), method = "radix")
    if (
      !environmentIsLocked(capture) ||
        !identical(parent.env(capture), emptyenv()) ||
        length(actual_fields) < 11L || length(actual_fields) > 12L ||
        any(vapply(actual_fields, bindingIsActive, logical(1L), env = capture)) ||
        !all(vapply(actual_fields, bindingIsLocked, logical(1L), env = capture))
    ) {
      abort("invalid-capture", "capture must come from capture_frame or capture_live_frame")
    }
    mode <- if ("mode" %in% actual_fields) capture$mode else NULL
    expected_fields <- c(
      "descriptor",
      if (identical(mode, "live")) "liveState",
      "metadataBytes",
      "metrics",
      "mode",
      "rowIdentityDomain",
      "rowOriginKind",
      "rowOriginOffset",
      "rowOrigins",
      "snapshot",
      "sortCache",
      "sourceReader"
    )
    if (
      !identical(actual_fields, base::sort.int(expected_fields, method = "radix")) ||
        !(identical(mode, "isolated") || identical(mode, "live")) ||
        !is.list(capture$descriptor) || !is.list(capture$descriptor$shape) ||
        !is.numeric(capture$descriptor$shape$rows) ||
        !is.null(attributes(capture$descriptor$shape$rows)) ||
        length(capture$descriptor$shape$rows) != 1L ||
        is.na(capture$descriptor$shape$rows) ||
        !is.finite(capture$descriptor$shape$rows) ||
        capture$descriptor$shape$rows < 0 ||
        capture$descriptor$shape$rows != floor(capture$descriptor$shape$rows) ||
        !is.numeric(capture$rowOrigins) || !is.null(attributes(capture$rowOrigins)) ||
        !is.numeric(capture$rowIdentityDomain) ||
        !is.null(attributes(capture$rowIdentityDomain)) ||
        length(capture$rowIdentityDomain) != 1L ||
        is.na(capture$rowIdentityDomain) ||
        !is.finite(capture$rowIdentityDomain) ||
        capture$rowIdentityDomain < capture$descriptor$shape$rows ||
        capture$rowIdentityDomain != floor(capture$rowIdentityDomain) ||
        !is.numeric(capture$rowOriginOffset) ||
        !is.null(attributes(capture$rowOriginOffset)) ||
        length(capture$rowOriginOffset) != 1L ||
        is.na(capture$rowOriginOffset) ||
        !is.finite(capture$rowOriginOffset) ||
        capture$rowOriginOffset < 0 ||
        capture$rowOriginOffset != floor(capture$rowOriginOffset) ||
        !(identical(capture$rowOriginKind, "sequential") || identical(capture$rowOriginKind, "mapped"))
    ) {
      abort("invalid-capture", "capture must come from capture_frame or capture_live_frame")
    }
    row_count <- capture$descriptor$shape$rows
    if (identical(capture$rowOriginKind, "sequential")) {
      if (
        length(capture$rowOrigins) != 0L ||
          as.double(capture$rowOriginOffset) + as.double(row_count) >
            as.double(capture$rowIdentityDomain) ||
          (identical(mode, "live") &&
            (capture$rowOriginOffset != 0 || capture$rowIdentityDomain != row_count))
      ) {
        abort("invalid-capture", "capture must come from capture_frame or capture_live_frame")
      }
    } else if (
      capture$rowOriginOffset != 0 ||
        length(capture$rowOrigins) != row_count ||
        anyNA(capture$rowOrigins) ||
        any(!is.finite(capture$rowOrigins)) ||
        any(capture$rowOrigins != floor(capture$rowOrigins)) ||
        any(capture$rowOrigins < 1L) ||
        any(capture$rowOrigins > capture$rowIdentityDomain) ||
        anyDuplicated(capture$rowOrigins) ||
        identical(mode, "live")
    ) {
      abort("invalid-capture", "capture must come from capture_frame or capture_live_frame")
    }
  }

  source_changed <- function() {
    abort(
      "source-changed",
      "The selected R dataframe changed shape or schema. Reopen it in Open Wrangler."
    )
  }

  live_capture_receipt <- function(capture) {
    binding_fields <- c(
      "descriptor",
      "liveState",
      "metadataBytes",
      "metrics",
      "mode",
      "rowIdentityDomain",
      "rowOriginKind",
      "rowOriginOffset",
      "rowOrigins",
      "snapshot",
      "sortCache",
      "sourceReader"
    )
    environment_receipt <- function(environment, fields) {
      if (!is.environment(environment)) {
        abort("invalid-capture", "capture must come from capture_frame or capture_live_frame")
      }
      actual_fields <- base::sort.int(ls(envir = environment, all.names = TRUE), method = "radix")
      expected_fields <- base::sort.int(fields, method = "radix")
      if (
        !identical(parent.env(environment), emptyenv()) ||
          !identical(actual_fields, expected_fields) ||
          any(vapply(actual_fields, bindingIsActive, logical(1L), env = environment))
      ) {
        abort("invalid-capture", "capture must come from capture_frame or capture_live_frame")
      }
      values <- lapply(fields, function(field) get(field, envir = environment, inherits = FALSE))
      names(values) <- fields
      values
    }
    bindings <- lapply(
      binding_fields,
      function(field) get(field, envir = capture, inherits = FALSE)
    )
    names(bindings) <- binding_fields
    list(
      bindings = bindings,
      liveState = environment_receipt(capture$liveState, c("hasInitialFrame", "initialFrame")),
      sortCache = environment_receipt(
        capture$sortCache,
        c("valid", "rules", "rowPositions", "columns", "bytes")
      )
    )
  }

  validate_live_capture_receipt <- function(capture, receipt) {
    validate_capture(capture)
    bindings_unchanged <- vapply(
      names(receipt$bindings),
      function(field) identical(get(field, envir = capture, inherits = FALSE), receipt$bindings[[field]]),
      logical(1L)
    )
    environment_unchanged <- function(environment, expected) {
      if (!is.environment(environment)) return(FALSE)
      actual_fields <- base::sort.int(ls(envir = environment, all.names = TRUE), method = "radix")
      expected_fields <- base::sort.int(names(expected), method = "radix")
      if (
        !identical(parent.env(environment), emptyenv()) ||
          !identical(actual_fields, expected_fields) ||
          any(vapply(actual_fields, bindingIsActive, logical(1L), env = environment))
      ) {
        return(FALSE)
      }
      all(vapply(
        names(expected),
        function(field) identical(get(field, envir = environment, inherits = FALSE), expected[[field]]),
        logical(1L)
      ))
    }
    if (
      !all(bindings_unchanged) ||
        !environment_unchanged(capture$liveState, receipt$liveState) ||
        !environment_unchanged(capture$sortCache, receipt$sortCache)
    ) {
      abort("invalid-capture", "capture must come from capture_frame or capture_live_frame")
    }
    invisible(NULL)
  }

  read_capture_frame <- function(capture, validated = FALSE) {
    if (!isTRUE(validated)) validate_capture(capture)
    if (identical(capture$mode, "isolated")) return(capture$snapshot)

    live_state <- capture$liveState
    if (isTRUE(live_state$hasInitialFrame)) {
      value <- live_state$initialFrame
      live_state$initialFrame <- NULL
      live_state$hasInitialFrame <- FALSE
      return(value)
    }

    add_metric(capture$metrics, "sourceReads")
    receipt <- live_capture_receipt(capture)
    value <- tryCatch(receipt$bindings$sourceReader(), error = function(error) source_changed())
    validate_live_capture_receipt(capture, receipt)
    value <- tryCatch(normalize_supported_frame(value), error = function(error) source_changed())
    inspected <- tryCatch(
      inspect_frame(
        value,
        conservative_nullable = TRUE,
        validate_values = FALSE,
        metrics = capture$metrics
      ),
      openwrangler_r_frame_error = function(error) {
        if (identical(error$code, "source-changed")) stop(error)
        source_changed()
      }
    )
    if (!identical(inspected$descriptor, capture$descriptor)) source_changed()
    value
  }

  nanoparquet_version_supported <- function(version) {
    if (is.null(version)) return(FALSE)
    parsed <- tryCatch(
      base::package_version(as.character(version)),
      error = function(error) NULL
    )
    !is.null(parsed) && length(parsed) == 1L && !is.na(parsed) &&
      parsed >= base::package_version(minimum_nanoparquet_version)
  }

  parquet_export_available <- function() {
    if (!requireNamespace("nanoparquet", quietly = TRUE)) return(FALSE)
    version <- tryCatch(utils::packageVersion("nanoparquet"), error = function(error) NULL)
    nanoparquet_version_supported(version)
  }

  export_formats <- function() {
    formats <- "csv"
    if (parquet_export_available()) formats <- c(formats, "parquet")
    unname(formats)
  }

  normalize_export_options <- function(options, format = NULL) {
    if (is.null(format)) {
      if (
        !is.list(options) ||
          is.object(options) ||
          is.null(names(options)) ||
          !"format" %in% names(options) ||
          !is.character(options$format) ||
          length(options$format) != 1L ||
          is.na(options$format) ||
          !options$format %in% c("csv", "parquet")
      ) {
        abort("invalid-export-options", "export options must identify CSV or Parquet")
      }
      format <- options$format
    }
    defaults <- if (identical(format, "csv")) {
      list(format = "csv", delimiter = ",", quoteChar = "\"", encoding = "utf-8", header = TRUE)
    } else {
      list(format = "parquet")
    }
    if (missing(options) || is.null(options)) options <- defaults
    required <- names(defaults)
    if (
      !is.list(options) ||
        is.object(options) ||
        is.null(names(options)) ||
        anyNA(names(options)) ||
        any(!nzchar(names(options))) ||
        anyDuplicated(names(options)) ||
        !setequal(names(options), required)
    ) {
      abort("invalid-export-options", sprintf("%s export options must contain exactly %s", format, paste(required, collapse = ", ")))
    }
    if (!is.character(options$format) || length(options$format) != 1L || !identical(options$format, format)) {
      abort("invalid-export-options", sprintf("export format must be %s", format))
    }
    if (identical(format, "parquet")) return(list(format = "parquet"))

    for (field in c("delimiter", "quoteChar", "encoding")) {
      if (!is.character(options[[field]]) || length(options[[field]]) != 1L || is.na(options[[field]])) {
        abort("invalid-export-options", sprintf("CSV export %s must be text", field))
      }
    }
    delimiter <- bounded_utf8(options$delimiter, "export delimiter", 8L)
    quote_char <- bounded_utf8(options$quoteChar, "export quoteChar", 8L)
    encoding <- bounded_utf8(options$encoding, "export encoding", 64L)
    if (
      nchar(delimiter, type = "chars", allowNA = FALSE, keepNA = FALSE) != 1L ||
        delimiter %in% c("\r", "\n")
    ) {
      abort("invalid-export-options", "CSV export delimiter must contain one non-line-break Unicode code point")
    }
    if (
      nchar(quote_char, type = "chars", allowNA = FALSE, keepNA = FALSE) != 1L ||
        quote_char %in% c("\r", "\n")
    ) {
      abort("invalid-export-options", "CSV export quoteChar must contain one non-line-break Unicode code point")
    }
    if (identical(delimiter, quote_char)) {
      abort("invalid-export-options", "CSV export delimiter and quoteChar must differ")
    }
    normalized_encoding <- tolower(gsub("_", "-", encoding, fixed = TRUE))
    if (!(normalized_encoding %in% c("utf-8", "utf8"))) {
      abort("invalid-export-options", "R CSV export supports UTF-8 encoding only")
    }
    if (!identical(quote_char, "\"")) {
      abort("invalid-export-options", "R CSV export supports the double-quote character only")
    }
    if (!is.logical(options$header) || length(options$header) != 1L || is.na(options$header)) {
      abort("invalid-export-options", "CSV export header must be true or false")
    }
    list(
      format = "csv",
      delimiter = delimiter,
      quoteChar = quote_char,
      encoding = "utf-8",
      header = options$header
    )
  }

  validate_export_target <- function(target_path) {
    target_path <- bounded_utf8(target_path, "target_path", 32768L)
    if (
      identical(target_path, "") ||
        !(
          startsWith(target_path, "/") ||
            startsWith(target_path, "\\\\") ||
            grepl("^[A-Za-z]:[/\\\\]", target_path, perl = TRUE)
        )
    ) {
      abort("invalid-export-target", "target_path must be absolute")
    }
    if (file.exists(target_path)) {
      abort("export-target-changed", "the private R export artifact already exists")
    }
    target_path
  }

  write_csv <- function(capture, target_path, options = NULL) {
    validate_capture(capture)
    options <- normalize_export_options(options, "csv")
    if (capture$descriptor$shape$columns == 0L) {
      abort(
        "export-write-failed",
        "CSV export requires at least one column because CSV cannot preserve a zero-column dataframe's row count"
      )
    }
    target_path <- validate_export_target(target_path)

    frame <- read_capture_frame(capture, validated = TRUE)
    connection <- NULL
    created <- FALSE
    completed <- FALSE
    on.exit({
      if (!is.null(connection)) try(close(connection), silent = TRUE)
      if (created && !completed && file.exists(target_path)) try(unlink(target_path, force = TRUE), silent = TRUE)
    }, add = TRUE)
    tryCatch(
      {
        connection <- file(target_path, open = "wx", encoding = "UTF-8")
        created <- TRUE
        utils::write.table(
          frame,
          file = connection,
          sep = options$delimiter,
          eol = "\n",
          na = "",
          dec = ".",
          row.names = FALSE,
          col.names = options$header,
          quote = TRUE,
          qmethod = "double"
        )
        flush(connection)
        close(connection)
        connection <- NULL
      },
      openwrangler_r_frame_error = function(error) stop(error),
      error = function(error) {
        abort("export-write-failed", "the R dataframe could not be written as CSV")
      }
    )

    invisible(read_capture_frame(capture, validated = TRUE))
    details <- file.info(target_path)
    if (
      nrow(details) != 1L ||
        is.na(details$size[[1L]]) ||
        !is.finite(details$size[[1L]]) ||
        details$size[[1L]] < 0 ||
        isTRUE(details$isdir[[1L]])
    ) {
      abort("export-target-changed", "the private R export artifact could not be verified")
    }
    completed <- TRUE
    list(
      rows = capture$descriptor$shape$rows,
      columns = capture$descriptor$shape$columns,
      bytes = as.double(details$size[[1L]])
    )
  }

  write_parquet <- function(capture, target_path, options = NULL) {
    validate_capture(capture)
    options <- normalize_export_options(options, "parquet")
    target_path <- validate_export_target(target_path)
    if (!parquet_export_available()) {
      abort(
        "missing-package",
        sprintf("Parquet export requires nanoparquet %s or newer in the selected R runtime", minimum_nanoparquet_version)
      )
    }

    frame <- read_capture_frame(capture, validated = TRUE)
    completed <- FALSE
    connection <- NULL
    on.exit({
      if (!is.null(connection)) try(close(connection), silent = TRUE)
      if (!completed && file.exists(target_path)) try(unlink(target_path, force = TRUE), silent = TRUE)
    }, add = TRUE)
    tryCatch(
      nanoparquet::write_parquet(frame, target_path),
      openwrangler_r_frame_error = function(error) stop(error),
      error = function(error) {
        abort("export-write-failed", "the R dataframe could not be written as Parquet")
      }
    )

    invisible(read_capture_frame(capture, validated = TRUE))
    details <- file.info(target_path)
    if (
      nrow(details) != 1L ||
        is.na(details$size[[1L]]) ||
        !is.finite(details$size[[1L]]) ||
        details$size[[1L]] < 8L ||
        isTRUE(details$isdir[[1L]])
    ) {
      abort("export-target-changed", "the private R Parquet artifact could not be verified")
    }
    connection <- file(target_path, open = "rb")
    prefix <- readBin(connection, what = "raw", n = 4L)
    seek(connection, where = -4L, origin = "end", rw = "read")
    suffix <- readBin(connection, what = "raw", n = 4L)
    close(connection)
    connection <- NULL
    parquet_magic <- charToRaw("PAR1")
    if (!identical(prefix, parquet_magic) || !identical(suffix, parquet_magic)) {
      abort("export-target-changed", "the private R Parquet artifact has invalid file markers")
    }
    completed <- TRUE
    list(
      rows = capture$descriptor$shape$rows,
      columns = capture$descriptor$shape$columns,
      bytes = as.double(details$size[[1L]])
    )
  }

  resolve_page_window <- function(
    descriptor,
    row_offset,
    row_limit,
    column_offset,
    column_limit,
    visible_rows = descriptor$shape$rows
  ) {
    total_rows <- whole_number(visible_rows, "visible row count", descriptor$shape$rows)
    total_columns <- descriptor$shape$columns
    row_offset <- whole_number(row_offset, "row_offset", total_rows)
    row_limit <- whole_number(row_limit, "row_limit", maximum_page_rows)
    column_offset <- min(whole_number(column_offset, "column_offset", maximum_columns), total_columns)
    column_limit <- whole_number(column_limit, "column_limit", maximum_page_columns)
    row_count <- min(row_limit, total_rows - row_offset)
    column_count <- min(column_limit, total_columns - column_offset)
    if (row_count * column_count > maximum_page_cells) {
      abort("page-too-large", sprintf("a page may contain at most %d cells", maximum_page_cells))
    }
    list(
      rowOffset = row_offset,
      rowLimit = row_limit,
      rowCount = as.integer(row_count),
      columnOffset = column_offset,
      columnLimit = column_limit,
      columnCount = as.integer(column_count)
    )
  }

  direct_row_positions <- function(capture, window) {
    add_metric(capture$metrics, "directPageSlices")
    add_metric(capture$metrics, "directRowPositions", window$rowCount)
    if (window$rowCount == 0L) return(integer())
    seq.int(as.integer(window$rowOffset) + 1L, length.out = window$rowCount)
  }

  referenced_sort_columns <- function(frame, resolved) {
    lapply(resolved, function(rule) frame[[rule$position]])
  }

  snapshot_sort_columns <- function(capture, frame, resolved) {
    add_metric(capture$metrics, "sortColumnSnapshots", length(resolved))
    lapply(resolved, function(rule) frame[[rule$position]][])
  }

  estimated_row_order_bytes <- function(row_count) {
    # Integer row positions use four bytes per row. Keep a small allowance for
    # the vector header rather than allocating a probe vector merely to size it.
    64 + as.double(row_count) * 4
  }

  estimated_sort_cache_bytes <- function(capture, frame, resolved) {
    bytes <- estimated_row_order_bytes(capture$descriptor$shape$rows)
    if (!identical(capture$mode, "live")) return(bytes)

    for (rule in resolved) {
      bytes <- bytes + as.double(utils::object.size(frame[[rule$position]]))
      if (!is.finite(bytes) || bytes > maximum_sort_cache_bytes) return(Inf)
    }
    bytes
  }

  cached_sort_values_match <- function(cache, frame, resolved) {
    if (length(cache$columns) != length(resolved)) return(FALSE)
    all(vapply(
      seq_along(resolved),
      function(index) identical(frame[[resolved[[index]]$position]], cache$columns[[index]]),
      logical(1L)
    ))
  }

  build_sorted_row_positions <- function(capture, sort_columns, resolved, row_positions = NULL) {
    descriptor <- capture$descriptor
    if (is.null(row_positions)) row_positions <- seq_len(descriptor$shape$rows)
    add_metric(capture$metrics, "sortOrderBuilds")
    add_metric(capture$metrics, "sortOrderRows", length(row_positions))

    for (rule_index in rev(seq_along(resolved))) {
      rule <- resolved[[rule_index]]
      column <- sort_columns[[rule_index]][row_positions]
      missing <- is.na(column)
      missing_positions <- row_positions[missing]
      present_positions <- which(!missing)
      present_order <- order_present_values(
        column[present_positions],
        descriptor$schema[[rule$position]]$semantics,
        identical(rule$direction, "desc")
      )
      ordered_present <- row_positions[present_positions[present_order]]
      row_positions <- if (identical(rule$nulls, "first")) {
        c(missing_positions, ordered_present)
      } else {
        c(ordered_present, missing_positions)
      }
    }
    row_positions
  }

  cached_sorted_row_positions <- function(capture, frame, resolved) {
    cache <- capture$sortCache
    if (
      isTRUE(cache$valid) &&
        identical(cache$rules, resolved) &&
        (
          identical(capture$mode, "isolated") ||
            cached_sort_values_match(cache, frame, resolved)
        )
    ) {
      return(cache$rowPositions)
    }

    # A small live cache keeps copies of the active sort columns so same-schema
    # notebook mutations, including data.table updates, cannot reuse stale order.
    # Check the original vectors first: an uncacheable sort must not transiently
    # duplicate every key merely to discover that it exceeds the cache budget.
    cache_candidate <-
      length(resolved) <= maximum_cached_sort_columns &&
        estimated_sort_cache_bytes(capture, frame, resolved) <= maximum_sort_cache_bytes
    sort_columns <- if (cache_candidate && identical(capture$mode, "live")) {
      snapshot_sort_columns(capture, frame, resolved)
    } else {
      referenced_sort_columns(frame, resolved)
    }
    row_positions <- build_sorted_row_positions(capture, sort_columns, resolved)
    retained_columns <- if (cache_candidate && identical(capture$mode, "live")) sort_columns else list()
    cache_bytes <- as.double(utils::object.size(row_positions)) + as.double(utils::object.size(retained_columns))
    if (cache_candidate && cache_bytes <= maximum_sort_cache_bytes) {
      cache$rules <- resolved
      cache$rowPositions <- row_positions
      cache$columns <- retained_columns
      cache$bytes <- cache_bytes
      cache$valid <- TRUE
    } else {
      clear_sort_cache(cache)
    }
    row_positions
  }

  view_row_positions <- function(capture, frame, view_query, apply_sorts) {
    resolved <- resolve_view_query(view_query, capture$descriptor)
    if (length(resolved$filters) == 0L && (!isTRUE(apply_sorts) || length(resolved$sorts) == 0L)) {
      if (length(resolved$sorts) == 0L) clear_sort_cache(capture$sortCache)
      return(list(rows = NULL, totalRows = capture$descriptor$shape$rows, resolved = resolved))
    }
    row_positions <- filter_row_positions(frame, capture$descriptor, resolved)
    if (!isTRUE(apply_sorts) || length(resolved$sorts) == 0L || length(row_positions) == 0L) {
      if (length(resolved$sorts) == 0L) clear_sort_cache(capture$sortCache)
      return(list(rows = row_positions, totalRows = length(row_positions), resolved = resolved))
    }
    if (length(resolved$filters) == 0L) {
      row_positions <- cached_sorted_row_positions(capture, frame, resolved$sorts)
    } else {
      clear_sort_cache(capture$sortCache)
      row_positions <- build_sorted_row_positions(
        capture,
        referenced_sort_columns(frame, resolved$sorts),
        resolved$sorts,
        row_positions
      )
    }
    list(rows = row_positions, totalRows = length(row_positions), resolved = resolved)
  }

  transform_rows <- function(capture, view_query) {
    validate_capture(capture)
    frame <- read_capture_frame(capture, validated = TRUE)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = TRUE)
    source_positions <- if (is.null(view$rows)) seq_len(capture$descriptor$shape$rows) else view$rows
    result <- if (identical(capture$descriptor$dataframeFlavor, "r.data.table")) {
      subset <- frame[source_positions]
      if (length(view$resolved$sorts) != 0L) data.table::setkey(subset, NULL)
      subset
    } else {
      frame[source_positions, , drop = FALSE]
    }
    list(
      frame = result,
      sourcePositions = source_positions,
      resolved = view$resolved
    )
  }

  materialize_rows <- function(
    capture,
    frame,
    row_positions,
    window,
    total_rows = capture$descriptor$shape$rows,
    validated = FALSE
  ) {
    if (!isTRUE(validated)) validate_capture(capture)
    descriptor <- capture$descriptor
    plain_schema <- plain_metadata_storage(descriptor$schema)
    source_rows <- descriptor$shape$rows
    if (length(row_positions) != window$rowCount) {
      abort("internal-error", "the R page row window is inconsistent")
    }
    column_positions <- if (window$columnCount == 0L) {
      integer()
    } else {
      seq.int(as.integer(window$columnOffset) + 1L, length.out = window$columnCount)
    }
    selected_schema <- .subset(plain_schema, column_positions)
    column_ids <- vapply(selected_schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    page_integer64_bindings <- if (any(vapply(
      selected_schema,
      function(column) identical(column$semantics$kind, "integer64"),
      logical(1L)
    ))) {
      ensure_integer64_bindings()
    } else {
      NULL
    }
    page_budget <- new_payload_budget(capture$metadataBytes)
    spend_payload_budget(page_budget, page_base_bytes, "R frame page")
    for (index in seq_along(column_ids)) {
      spend_json_string(page_budget, column_ids[[index]], sprintf("page column ID %d", index))
      spend_payload_budget(page_budget, 1L, "R frame page projection")
    }
    explicit_row_names <- if (identical(descriptor$frameSemantics$rowNames, "explicit")) {
      stored <- attr(frame, "row.names", exact = TRUE)
      if (length(stored) != source_rows) source_changed()
      stored
    } else {
      NULL
    }

    rows <- lapply(seq_along(row_positions), function(row_index) {
      source_row <- row_positions[[row_index]]
      spend_payload_budget(page_budget, row_fixed_bytes, sprintf("row %d", source_row))
      values <- lapply(seq_along(column_positions), function(column_index) {
        source_column <- column_positions[[column_index]]
        encode_value(
          .subset2(frame, source_column),
          .subset2(.subset2(plain_schema, source_column), "semantics"),
          source_row,
          sprintf("cell[%d,%d]", source_row, source_column),
          page_budget,
          page_integer64_bindings
        )
      })
      row <- list(
        id = sprintf("r:r:%.0f", capture_row_origin_at(capture, source_row) - 1),
        rowNumber = as.integer(window$rowOffset) + row_index - 1L,
        values = json_array(values)
      )
      if (!is.null(explicit_row_names)) {
        row_label <- bounded_utf8(
          as.character(explicit_row_names[[source_row]]),
          sprintf("row label %d", source_row),
          maximum_name_bytes
        )
        spend_json_string(page_budget, row_label, sprintf("row label %d", source_row))
        row$rowLabel <- row_label
      }
      row
    })

    published_descriptor <- descriptor
    published_descriptor$shape$rows <- capture$rowIdentityDomain
    c(
      published_descriptor,
      list(page = list(
        offset = window$rowOffset,
        limit = window$rowLimit,
        totalRows = total_rows,
        columnOffset = window$columnOffset,
        columnLimit = window$columnLimit,
        columnIds = json_array(column_ids),
        rows = json_array(rows)
      ))
    )
  }

  count_missing_at <- function(capture, position, expected_name) {
    validate_capture(capture)
    column_count <- capture$descriptor$shape$columns
    position <- whole_number(position, "missing-count column position", column_count)
    if (position < 1L || position > column_count) {
      abort("stale-column", "the missing-count column position no longer matches the R dataframe")
    }
    position <- as.integer(position)
    expected_name <- bounded_utf8(expected_name, "missing-count column name", maximum_name_bytes)
    if (!identical(capture$descriptor$schema[[position]]$name, expected_name)) {
      abort("stale-column", "the missing-count column name no longer matches the R dataframe")
    }
    frame <- read_capture_frame(capture, validated = TRUE)
    as.integer(sum(is.na(frame[[position]])))
  }

  materialize_summaries <- function(
    capture,
    column_references,
    view_query = list(filters = list(), sorts = list())
  ) {
    validate_capture(capture)
    resolved <- resolve_profile_columns(column_references, capture$descriptor)
    frame <- read_capture_frame(capture, validated = TRUE)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = FALSE)
    add_metric(capture$metrics, "profileColumns", length(resolved))
    budget <- new_payload_budget(capture$metadataBytes)
    summaries <- lapply(resolved, function(column) {
      if (view$totalRows <= maximum_profile_sample_rows) {
        values <- frame[[column$position]]
        if (!is.null(view$rows)) values <- values[view$rows]
        column_summary(capture, values, column, budget)
      } else {
        chunked_column_summary(capture, frame, column, view$rows, view$totalRows, budget)
      }
    })
    json_array(summaries)
  }

  materialize_dataset_stats <- function(
    capture,
    view_query = list(filters = list(), sorts = list())
  ) {
    validate_capture(capture)
    descriptor <- capture$descriptor
    column_count <- descriptor$shape$columns
    frame <- read_capture_frame(capture, validated = TRUE)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = FALSE)
    row_count <- view$totalRows
    add_metric(capture$metrics, "datasetProfiles")
    budget <- new_payload_budget(capture$metadataBytes)
    spend_payload_budget(budget, summary_fixed_bytes, "R dataset profile")
    missing_counts <- integer(column_count)
    missing_rows <- 0L
    start <- 1
    while (start <= row_count) {
      count <- min(maximum_profile_chunk_rows, row_count - start + 1)
      source_positions <- profile_chunk_source_positions(view$rows, start, count)
      row_missing <- rep(FALSE, count)
      for (position in seq_len(column_count)) {
        column <- frame[[position]][source_positions]
        schema <- descriptor$schema[[position]]
        validate_profile_column(column, schema$semantics, sprintf("column %d dataset profile", position))
        missing <- is.na(column)
        missing_counts[[position]] <- missing_counts[[position]] + sum(missing)
        row_missing <- row_missing | missing
      }
      missing_rows <- missing_rows + sum(row_missing)
      start <- start + count
    }
    missing_by_column <- lapply(seq_len(column_count), function(position) {
      schema <- descriptor$schema[[position]]
      spend_json_string(budget, schema$name, sprintf("column %d missing-value name", position))
      spend_payload_budget(budget, 96L, sprintf("column %d missing-value count", position))
      list(column = schema$name, count = missing_counts[[position]])
    })
    duplicate_sample_size <- row_count
    duplicate_rows <- if (row_count <= 1L) {
      0L
    } else if (column_count == 0L) {
      as.integer(row_count - 1L)
    } else {
      duplicate_sample_size <- min(
        row_count,
        maximum_dataset_duplicate_sample_rows,
        floor(maximum_dataset_duplicate_sample_cells / column_count)
      )
      logical_positions <- deterministic_sample_positions(row_count, duplicate_sample_size)
      source_positions <- if (is.null(view$rows)) logical_positions else view$rows[logical_positions]
      sampled_frame <- if (identical(capture$descriptor$dataframeFlavor, "r.data.table")) {
        frame[source_positions]
      } else {
        frame[source_positions, , drop = FALSE]
      }
      as.integer(sum(duplicated(sampled_frame)))
    }
    stats <- list(
      missingCells = as.double(sum(as.double(missing_counts))),
      missingRows = missing_rows,
      duplicateRows = duplicate_rows,
      missingValuesByColumn = json_array(missing_by_column)
    )
    if (duplicate_sample_size < row_count) {
      stats$duplicateRowsSampleSize <- as.integer(duplicate_sample_size)
    }
    list(
      totalRows = as.double(row_count),
      stats = stats
    )
  }

  materialize_column_values <- function(
    capture,
    column_reference,
    view_query = list(filters = list(), sorts = list()),
    search = NULL,
    limit = 100L
  ) {
    validate_capture(capture)
    descriptor <- capture$descriptor
    resolved_column <- resolve_column_reference(column_reference, descriptor, "column_reference")
    limit <- whole_number(limit, "limit", maximum_selected_values_per_filter)
    if (limit < 1L) abort("invalid-view-query", "limit must be positive")
    if (!is.null(search)) search <- bounded_utf8(search, "search", maximum_text_bytes)
    frame <- read_capture_frame(capture, validated = TRUE)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = FALSE)
    source_column <- frame[[resolved_column$position]]
    column_descriptor <- descriptor$schema[[resolved_column$position]]
    semantics <- column_descriptor$semantics
    initial_discovery <- is.null(search) || identical(search, "")
    sampled <- initial_discovery && view$totalRows > maximum_profile_sample_rows
    budget <- new_payload_budget(capture$metadataBytes)
    spend_payload_budget(budget, summary_fixed_bytes, "R column values")
    finish <- function(values, has_more, sample_size = NULL) {
      result <- list(
        column = column_descriptor$name,
        values = values,
        hasMore = isTRUE(has_more) || sampled
      )
      if (!is.null(sample_size)) result$sampleSize <- sample_size
      result
    }

    if (!initial_discovery) {
      searched <- chunked_searched_value_counts(
        source_column,
        semantics,
        view$rows,
        view$totalRows,
        search
      )
      value_column <- source_column
      unique_keys <- searched$keys
      first_indices <- searched$firstSources
      counts <- searched$counts
    } else if (sampled) {
      logical_positions <- deterministic_sample_positions(view$totalRows, maximum_profile_sample_rows)
      source_positions <- if (is.null(view$rows)) logical_positions else view$rows[logical_positions]
      column <- source_column[source_positions]
    } else {
      column <- if (is.null(view$rows)) source_column else source_column[view$rows]
    }
    if (initial_discovery) {
      validate_profile_column(column, semantics, "column values")
      missing <- profile_missing_masks(column, semantics)
      present_indices <- which(!missing$null & !missing$nan)
      if (length(present_indices) == 0L) {
        return(finish(json_array(list()), FALSE, if (sampled) storage_length(column) else NULL))
      }
      keys <- profile_value_keys(column, semantics, present_indices)
      first <- !duplicated(keys)
      unique_keys <- keys[first]
      first_indices <- present_indices[first]
      counts <- tabulate(match(keys, unique_keys), nbins = length(unique_keys))
      value_column <- column
    }
    if (length(first_indices) == 0L) {
      return(finish(json_array(list()), FALSE))
    }
    displays <- profile_value_displays(value_column, semantics, first_indices, unique_keys)
    priority <- base::order(-counts, displays, seq_along(counts), method = "radix")
    selected <- utils::head(priority, limit)
    values <- lapply(seq_along(selected), function(result_index) {
      source_index <- first_indices[[selected[[result_index]]]]
      encoded <- encode_value(value_column, semantics, source_index, sprintf("column value %d", result_index), budget)
      if (identical(semantics$kind, "double") && identical(unique_keys[[selected[[result_index]]]], "0")) {
        encoded <- ordinary_cell("number", "0", "0")
      }
      selection_cell <- encoded
      if (identical(semantics$kind, "double") && identical(encoded$kind, "number")) {
        selection_cell$raw <- as.double(encoded$raw)
      }
      list(
        value = encoded$display,
        count = as.integer(counts[[selected[[result_index]]]]),
        selectionValue = list(
          kind = "typedSelection",
          version = 1L,
          columnType = column_descriptor$type,
          cell = selection_cell
        )
      )
    })
    finish(json_array(values), length(priority) > limit, if (sampled) storage_length(column) else NULL)
  }

  materialize_page <- function(
    capture,
    row_offset = 0L,
    row_limit = 100L,
    column_offset = 0L,
    column_limit = 100L
  ) {
    validate_capture(capture)
    frame <- read_capture_frame(capture, validated = TRUE)
    window <- resolve_page_window(
      capture$descriptor,
      row_offset,
      row_limit,
      column_offset,
      column_limit
    )
    materialize_rows(
      capture,
      frame,
      direct_row_positions(capture, window),
      window,
      validated = TRUE
    )
  }

  materialize_view_page <- function(
    capture,
    view_query = list(filters = list(), sorts = list()),
    row_offset = 0L,
    row_limit = 100L,
    column_offset = 0L,
    column_limit = 100L
  ) {
    validate_capture(capture)
    frame <- read_capture_frame(capture, validated = TRUE)
    view <- view_row_positions(capture, frame, view_query, apply_sorts = TRUE)
    total_rows <- view$totalRows
    window <- resolve_page_window(
      capture$descriptor,
      row_offset,
      row_limit,
      column_offset,
      column_limit,
      visible_rows = total_rows
    )
    row_positions <- if (window$rowCount == 0L) {
      integer()
    } else if (is.null(view$rows)) {
      direct_row_positions(capture, window)
    } else {
      logical_rows <- seq.int(as.integer(window$rowOffset) + 1L, length.out = window$rowCount)
      view$rows[logical_rows]
    }
    materialize_rows(capture, frame, row_positions, window, total_rows, validated = TRUE)
  }

  capture_metrics <- function(capture) {
    validate_capture(capture)
    metrics <- capture$metrics
    list(
      nullableScans = metrics$nullableScans,
      sourceReads = metrics$sourceReads,
      directPageSlices = metrics$directPageSlices,
      directRowPositions = metrics$directRowPositions,
      sortOrderBuilds = metrics$sortOrderBuilds,
      sortOrderRows = metrics$sortOrderRows,
      sortColumnSnapshots = metrics$sortColumnSnapshots,
      profileColumns = metrics$profileColumns,
      datasetProfiles = metrics$datasetProfiles,
      cachedSortRows = length(capture$sortCache$rowPositions),
      cachedSortColumns = length(capture$sortCache$columns),
      cachedSortBytes = capture$sortCache$bytes
    )
  }

  encode_contract <- function(value) {
    if (!requireNamespace("jsonlite", quietly = TRUE)) {
      abort("missing-package", "jsonlite is required to encode an R frame page")
    }
    payload <- jsonlite::toJSON(
      value,
      auto_unbox = TRUE,
      digits = NA,
      na = "null",
      null = "null",
      pretty = FALSE
    )
    if (nchar(payload, type = "bytes") > maximum_payload_bytes) {
      abort("payload-too-large", sprintf("the encoded page exceeds %d bytes", maximum_payload_bytes))
    }
    enc2utf8(as.character(payload))
  }

  encode_page <- function(...) {
    encode_contract(materialize_page(...))
  }

  encode_view_page <- function(...) {
    encode_contract(materialize_view_page(...))
  }

  list(
    capture_frame = capture_frame,
    capture_categorical_result = capture_categorical_result,
    capture_custom_code_result = capture_custom_code_result,
    capture_live_frame = capture_live_frame,
    isolate_capture = isolate_capture,
    isolate_custom_code_input = isolate_custom_code_input,
    rename_column = rename_column,
    rename_column_at = rename_column_at,
    clone_column = clone_column,
    clone_column_at = clone_column_at,
    by_example_column_at = by_example_column_at,
    one_hot_encode_columns = one_hot_encode_columns,
    one_hot_encode_columns_at = one_hot_encode_columns_at,
    multi_label_binarize_column = multi_label_binarize_column,
    multi_label_binarize_column_at = multi_label_binarize_column_at,
    formula_column = formula_column,
    formula_column_at = formula_column_at,
    text_length_column = text_length_column,
    text_length_column_at = text_length_column_at,
    lower_text_column = lower_text_column,
    lower_text_column_at = lower_text_column_at,
    upper_text_column = upper_text_column,
    upper_text_column_at = upper_text_column_at,
    capitalize_text_column = capitalize_text_column,
    capitalize_text_column_at = capitalize_text_column_at,
    strip_text_column = strip_text_column,
    strip_text_column_at = strip_text_column_at,
    split_text_column = split_text_column,
    split_text_column_at = split_text_column_at,
    find_replace_column = find_replace_column,
    find_replace_column_at = find_replace_column_at,
    min_max_scale_column_at = min_max_scale_column_at,
    round_number_column_at = round_number_column_at,
    floor_number_column_at = floor_number_column_at,
    ceil_number_column_at = ceil_number_column_at,
    format_datetime_column = format_datetime_column,
    format_datetime_column_at = format_datetime_column_at,
    fill_missing_column = fill_missing_column,
    fill_missing_column_at = fill_missing_column_at,
    fill_missing_from_fallback_columns_at = fill_missing_from_fallback_columns_at,
    fill_missing_directional_at = fill_missing_directional_at,
    fill_missing_linear_interpolation_at = fill_missing_linear_interpolation_at,
    fill_missing_grouped_statistic_at = fill_missing_grouped_statistic_at,
    cast_column = cast_column,
    cast_column_at = cast_column_at,
    drop_columns = drop_columns,
    drop_columns_at = drop_columns_at,
    select_columns = select_columns,
    select_columns_at = select_columns_at,
    group_by_at = group_by_at,
    capture_group_result = capture_group_result,
    drop_missing_rows_at = drop_missing_rows_at,
    drop_duplicate_rows_at = drop_duplicate_rows_at,
    transform_rows = transform_rows,
    nanoparquet_version_supported = nanoparquet_version_supported,
    parquet_export_available = parquet_export_available,
    export_formats = export_formats,
    normalize_export_options = normalize_export_options,
    write_csv = write_csv,
    write_parquet = write_parquet,
    capture_metrics = capture_metrics,
    materialize_page = materialize_page,
    materialize_view_page = materialize_view_page,
    count_missing_at = count_missing_at,
    materialize_summaries = materialize_summaries,
    materialize_dataset_stats = materialize_dataset_stats,
    materialize_column_values = materialize_column_values,
    encode_page = encode_page,
    encode_view_page = encode_view_page,
    limits = list(
      rows = maximum_rows,
      columns = maximum_columns,
      pageRows = maximum_page_rows,
      pageColumns = maximum_page_columns,
      pageCells = maximum_page_cells,
      filters = maximum_filters,
      predicatesPerFilter = maximum_predicates_per_filter,
      selectedValuesPerFilter = maximum_selected_values_per_filter,
      sortRules = maximum_sort_rules,
      fillFallbackColumns = maximum_fill_fallback_columns,
      profileColumns = maximum_profile_columns,
      profileSampleRows = maximum_profile_sample_rows,
      profileChunkRows = maximum_profile_chunk_rows,
      datasetDuplicateSampleRows = maximum_dataset_duplicate_sample_rows,
      datasetDuplicateSampleCells = maximum_dataset_duplicate_sample_cells,
      columnValueDistinctMatches = maximum_column_value_distinct_matches,
      columnValueDistinctKeyBytes = maximum_column_value_distinct_key_bytes,
      topValues = maximum_top_values,
      histogramBins = maximum_histogram_bins,
      cachedSortColumns = maximum_cached_sort_columns,
      sortCacheBytes = maximum_sort_cache_bytes,
      factorLevels = maximum_factor_levels,
      textBytes = maximum_text_bytes,
      operationOutputBytes = maximum_operation_output_bytes,
      nameBytes = maximum_name_bytes,
      columnIdBytes = maximum_column_id_bytes,
      payloadBytes = maximum_payload_bytes
    )
  )
})
