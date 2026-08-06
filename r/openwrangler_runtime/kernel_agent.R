openwrangler_r_kernel_agent <- local({
  transport_version <- 2L
  maximum_identifier_bytes <- 128L
  maximum_variable_name_bytes <- 1024L
  maximum_step_id_bytes <- 1024L
  maximum_error_bytes <- 4096L
  maximum_response_bytes <- 17L * 1024L * 1024L
  maximum_generated_code_bytes <- 4L * 1024L * 1024L
  maximum_revision <- .Machine$integer.max
  identifier_pattern <- "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

  abort <- function(code, message, recoverable = FALSE) {
    condition <- structure(
      list(message = message, call = NULL, code = code, recoverable = recoverable),
      class = c("openwrangler_r_kernel_error", "error", "condition")
    )
    stop(condition)
  }

  diagnostic_message <- function(error, fallback) {
    message <- conditionMessage(error)
    if (!is.character(message) || length(message) != 1L || is.na(message) || Encoding(message) == "bytes") {
      return(fallback)
    }
    converted <- iconv(message, from = "", to = "UTF-8", sub = NA_character_)
    if (is.na(converted) || nchar(converted, type = "bytes") > maximum_error_bytes) fallback else converted
  }

  frame_diagnostic <- function(error) {
    source_code <- error$code
    if (!is.character(source_code) || length(source_code) != 1L || is.na(source_code)) {
      source_code <- ""
    }

    if (identical(source_code, "missing-package")) {
      code <- "missing_package"
      recoverable <- TRUE
    } else if (identical(source_code, "source-changed")) {
      code <- "runtime_error"
      recoverable <- TRUE
    } else if (identical(source_code, "stale-column")) {
      code <- "stale_column"
      recoverable <- TRUE
    } else if (identical(source_code, "profile-too-large")) {
      code <- "profile_too_large"
      recoverable <- TRUE
    } else if (source_code %in% c("page-too-large", "payload-too-large")) {
      code <- "page_too_large"
      recoverable <- TRUE
    } else if (
      startsWith(source_code, "unsupported-") ||
        source_code %in% c(
          "factor-levels-too-large",
          "invalid-data-table-key",
          "invalid-factor",
          "invalid-range",
          "invalid-schema",
          "invalid-text",
          "text-too-large"
        )
    ) {
      code <- "unsupported_frame"
      recoverable <- FALSE
    } else if (
      source_code %in% c(
        "column-name-collision",
        "invalid-column-name",
        "invalid-view-query",
        "invalid-view-value",
        "reserved-column-name"
      )
    ) {
      code <- "invalid_request"
      recoverable <- TRUE
    } else {
      code <- "runtime_error"
      recoverable <- FALSE
    }

    list(
      code = code,
      message = diagnostic_message(error, "The R dataframe could not be read"),
      recoverable = recoverable
    )
  }

  exact_record <- function(value, fields, label, optional_fields = character()) {
    if (!is.list(value) || is.object(value) || is.null(names(value))) {
      abort("invalid_request", sprintf("%s must be an object", label))
    }
    field_names <- names(value)
    if (
      anyNA(field_names) ||
        any(field_names == "") ||
        anyDuplicated(field_names) ||
        !all(fields %in% field_names) ||
        any(!field_names %in% c(fields, optional_fields))
    ) {
      abort("invalid_request", sprintf("%s has invalid fields", label))
    }
    value
  }

  decode_column_reference <- function(value, label, maximum_id_bytes) {
    reference <- exact_record(value, c("id", "name"), label)
    list(
      id = bounded_text(reference$id, paste0(label, ".id"), maximum_id_bytes),
      name = bounded_text(reference$name, paste0(label, ".name"), maximum_variable_name_bytes)
    )
  }

  bounded_text <- function(value, label, maximum_bytes) {
    if (!is.character(value) || length(value) != 1L || is.na(value) || Encoding(value) == "bytes") {
      abort("invalid_request", sprintf("%s must be one UTF-8 string", label))
    }
    converted <- iconv(value, from = "", to = "UTF-8", sub = NA_character_)
    if (is.na(converted) || nchar(converted, type = "bytes") > maximum_bytes) {
      abort("invalid_request", sprintf("%s is not a bounded UTF-8 string", label))
    }
    converted
  }

  identifier <- function(value, label) {
    value <- bounded_text(value, label, maximum_identifier_bytes)
    if (!grepl(identifier_pattern, value, perl = TRUE)) {
      abort("invalid_request", sprintf("%s must be a canonical UUID", label))
    }
    value
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
      abort("invalid_request", sprintf("%s is outside its supported range", label))
    }
    as.double(value)
  }

  decode_sort_rules <- function(value, limits) {
    if (!is.list(value) || is.object(value) || length(value) > limits$sortRules) {
      abort("invalid_request", "request.page.sorts must be a bounded array")
    }
    rules <- lapply(seq_along(value), function(index) {
      rule <- exact_record(value[[index]], c("column", "direction", "nulls"), sprintf("sort[%d]", index))
      column <- decode_column_reference(
        rule$column,
        sprintf("sort[%d].column", index),
        limits$columnIdBytes
      )
      if (!rule$direction %in% c("asc", "desc") || !rule$nulls %in% c("first", "last")) {
        abort("invalid_request", sprintf("sort[%d] has an unsupported order", index))
      }
      list(
        column = column,
        direction = rule$direction,
        nulls = rule$nulls
      )
    })
    ids <- vapply(rules, function(rule) rule$column$id, character(1L), USE.NAMES = FALSE)
    if (anyDuplicated(ids)) {
      abort("invalid_request", "request.page.sorts contains a repeated column identity")
    }
    rules
  }

  decode_view_value <- function(value, label) {
    if (is.null(value)) return(NULL)
    if (
      length(value) == 1L &&
        ((is.character(value) && !is.na(value)) || is.logical(value) || (is.numeric(value) && is.finite(value)))
    ) {
      if (is.character(value)) return(bounded_text(value, label, 65536L))
      return(value)
    }
    token <- exact_record(value, c("kind", "version", "columnType", "cell"), label)
    if (!identical(token$kind, "typedSelection") || !identical(token$version, 1L)) {
      abort("invalid_request", sprintf("%s is not a versioned typed selection", label))
    }
    token$columnType <- bounded_text(token$columnType, paste0(label, ".columnType"), 32L)
    if (!token$columnType %in% c("string", "integer", "float", "boolean", "datetime", "date", "duration")) {
      abort("invalid_request", sprintf("%s has an unsupported column type", label))
    }
    cell <- exact_record(
      token$cell,
      c("kind", "raw", "display", "isNull", "isNaN"),
      paste0(label, ".cell"),
      optional_fields = "sign"
    )
    cell$kind <- bounded_text(cell$kind, paste0(label, ".cell.kind"), 32L)
    cell$display <- bounded_text(cell$display, paste0(label, ".cell.display"), 8192L)
    if (!is.logical(cell$isNull) || length(cell$isNull) != 1L || !is.logical(cell$isNaN) || length(cell$isNaN) != 1L) {
      abort("invalid_request", sprintf("%s has invalid missing-value flags", label))
    }
    token$cell <- cell
    token
  }

  decode_predicates <- function(value, limits, filter_index) {
    if (!is.list(value) || is.object(value) || length(value) > limits$predicatesPerFilter) {
      abort("invalid_request", sprintf("view.filters[%d].predicates must be a bounded array", filter_index))
    }
    lapply(seq_along(value), function(index) {
      label <- sprintf("view.filters[%d].predicates[%d]", filter_index, index)
      predicate <- exact_record(
        value[[index]],
        c("kind", "operator"),
        label,
        optional_fields = c("value", "secondValue")
      )
      operators <- c(
        "equals", "notEquals", "contains", "startsWith", "endsWith", "gt", "gte", "lt", "lte",
        "between", "isNull", "isNotNull", "isNaN", "isNotNaN"
      )
      if (!identical(predicate$kind, "predicate") || !predicate$operator %in% operators) {
        abort("invalid_request", sprintf("%s has an unsupported operator", label))
      }
      nullary <- predicate$operator %in% c("isNull", "isNotNull", "isNaN", "isNotNaN")
      if (!nullary && !"value" %in% names(predicate)) {
        abort("invalid_request", sprintf("%s requires value", label))
      }
      if (identical(predicate$operator, "between") && !"secondValue" %in% names(predicate)) {
        abort("invalid_request", sprintf("%s requires secondValue", label))
      }
      if ("value" %in% names(predicate)) predicate$value <- decode_view_value(predicate$value, paste0(label, ".value"))
      if ("secondValue" %in% names(predicate)) {
        predicate$secondValue <- decode_view_value(predicate$secondValue, paste0(label, ".secondValue"))
      }
      predicate
    })
  }

  decode_value_filter <- function(value, limits, filter_index) {
    label <- sprintf("view.filters[%d].valueFilter", filter_index)
    filter <- exact_record(
      value,
      c("kind", "selectedValues", "includeNulls", "includeNaN"),
      label,
      optional_fields = "search"
    )
    if (!identical(filter$kind, "values")) abort("invalid_request", sprintf("%s has an invalid kind", label))
    if (
      !is.list(filter$selectedValues) ||
        is.object(filter$selectedValues) ||
        length(filter$selectedValues) > limits$selectedValuesPerFilter
    ) {
      abort("invalid_request", sprintf("%s.selectedValues must be a bounded array", label))
    }
    if (
      !is.logical(filter$includeNulls) || length(filter$includeNulls) != 1L || is.na(filter$includeNulls) ||
        !is.logical(filter$includeNaN) || length(filter$includeNaN) != 1L || is.na(filter$includeNaN)
    ) {
      abort("invalid_request", sprintf("%s has invalid missing-value switches", label))
    }
    filter$selectedValues <- lapply(seq_along(filter$selectedValues), function(index) {
      decode_view_value(filter$selectedValues[[index]], sprintf("%s.selectedValues[%d]", label, index))
    })
    if ("search" %in% names(filter)) {
      filter$search <- bounded_text(filter$search, paste0(label, ".search"), 8192L)
    }
    filter
  }

  decode_view <- function(value, limits) {
    view <- exact_record(value, c("filters", "sorts"), "request.view", optional_fields = "logic")
    if ("logic" %in% names(view) && !view$logic %in% c("and", "or")) {
      abort("invalid_request", "request.view.logic is unsupported")
    }
    if (!is.list(view$filters) || is.object(view$filters) || length(view$filters) > limits$filters) {
      abort("invalid_request", "request.view.filters must be a bounded array")
    }
    filters <- lapply(seq_along(view$filters), function(index) {
      label <- sprintf("view.filters[%d]", index)
      filter <- exact_record(
        view$filters[[index]],
        c("column", "type", "predicates"),
        label,
        optional_fields = c("logic", "valueFilter")
      )
      filter$column <- decode_column_reference(
        filter$column,
        paste0(label, ".column"),
        limits$columnIdBytes
      )
      filter$type <- bounded_text(filter$type, paste0(label, ".type"), 32L)
      if (!filter$type %in% c("string", "integer", "float", "boolean", "datetime", "date", "duration")) {
        abort("invalid_request", sprintf("%s.type is unsupported", label))
      }
      if ("logic" %in% names(filter) && !filter$logic %in% c("and", "or")) {
        abort("invalid_request", sprintf("%s.logic is unsupported", label))
      }
      filter$predicates <- decode_predicates(filter$predicates, limits, index)
      if ("valueFilter" %in% names(filter)) {
        filter$valueFilter <- decode_value_filter(filter$valueFilter, limits, index)
      }
      filter
    })
    list(
      logic = if ("logic" %in% names(view)) view$logic else "and",
      filters = filters,
      sorts = decode_sort_rules(view$sorts, limits)
    )
  }

  decode_page <- function(value, limits) {
    page <- exact_record(
      value,
      c("rowOffset", "rowLimit", "columnOffset", "columnLimit", "view"),
      "request.page"
    )
    list(
      row_offset = whole_number(page$rowOffset, "request.page.rowOffset", limits$rows),
      row_limit = whole_number(page$rowLimit, "request.page.rowLimit", limits$pageRows),
      column_offset = whole_number(page$columnOffset, "request.page.columnOffset", limits$columns),
      column_limit = whole_number(page$columnLimit, "request.page.columnLimit", limits$pageColumns),
      view = decode_view(page$view, limits)
    )
  }

  decode_column_references <- function(value, limits) {
    if (
      !is.list(value) ||
        is.object(value) ||
        length(value) == 0L ||
        length(value) > limits$profileColumns
    ) {
      abort("invalid_request", "request.payload.columns must be a bounded non-empty array")
    }
    references <- lapply(seq_along(value), function(index) {
      decode_column_reference(value[[index]], sprintf("columns[%d]", index), limits$columnIdBytes)
    })
    ids <- vapply(references, `[[`, character(1L), "id", USE.NAMES = FALSE)
    if (anyDuplicated(ids)) {
      abort("invalid_request", "request.payload.columns contains a repeated column identity")
    }
    references
  }

  validate_dataset_stats_result <- function(value, limits) {
    result_whole_number <- function(candidate, label, maximum) {
      if (
        length(candidate) != 1L ||
          !is.numeric(candidate) ||
          is.na(candidate) ||
          !is.finite(candidate) ||
          candidate < 0 ||
          candidate > maximum ||
          candidate != floor(candidate)
      ) {
        abort("runtime_error", sprintf("%s is outside its supported range", label))
      }
      as.double(candidate)
    }
    result <- exact_record(value, c("totalRows", "stats"), "dataset statistics result")
    total_rows <- result_whole_number(result$totalRows, "dataset statistics totalRows", limits$rows)
    stats <- exact_record(
      result$stats,
      c("missingCells", "missingRows", "duplicateRows", "missingValuesByColumn"),
      "dataset statistics"
    )
    missing_rows <- result_whole_number(stats$missingRows, "dataset statistics missingRows", total_rows)
    duplicate_rows <- result_whole_number(
      stats$duplicateRows,
      "dataset statistics duplicateRows",
      max(0, total_rows - 1)
    )
    entries <- stats$missingValuesByColumn
    if (!is.list(entries) || length(entries) > limits$columns) {
      abort("runtime_error", "dataset statistics have an invalid column projection")
    }
    entries <- unclass(entries)
    missing_cells <- 0
    for (index in seq_along(entries)) {
      entry <- exact_record(entries[[index]], c("column", "count"), sprintf("dataset statistics column %d", index))
      bounded_text(entry$column, sprintf("dataset statistics column %d name", index), limits$nameBytes)
      missing_cells <- missing_cells + result_whole_number(
        entry$count,
        sprintf("dataset statistics column %d count", index),
        total_rows
      )
    }
    declared_missing_cells <- result_whole_number(
      stats$missingCells,
      "dataset statistics missingCells",
      total_rows * length(entries)
    )
    if (declared_missing_cells != missing_cells) {
      abort("runtime_error", "dataset statistics have inconsistent missing-value totals")
    }
    result$totalRows <- total_rows
    result$stats$missingCells <- declared_missing_cells
    result$stats$missingRows <- missing_rows
    result$stats$duplicateRows <- duplicate_rows
    result
  }

  materialize <- function(frame_contract, capture, page) {
    frame_contract$materialize_view_page(
      capture,
      view_query = page$view,
      row_offset = page$row_offset,
      row_limit = page$row_limit,
      column_offset = page$column_offset,
      column_limit = page$column_limit
    )
  }

  active_capture <- function(session) {
    if (isTRUE(session$editing)) {
      if (is.null(session$draft)) session$committed else session$draft
    } else {
      session$source
    }
  }

  assert_revision <- function(session, revision) {
    revision <- whole_number(revision, "request.payload.revision", maximum_revision)
    if (!identical(as.double(session$revision), revision)) {
      abort(
        "stale_revision",
        sprintf("The R session revision is %d, not %d", session$revision, as.integer(revision)),
        TRUE
      )
    }
  }

  next_revision <- function(session) {
    if (session$revision >= maximum_revision) {
      abort("runtime_error", "The R session revision limit was reached")
    }
    as.integer(session$revision + 1L)
  }

  decode_transform_step <- function(value, limits) {
    step <- exact_record(value, c("id", "kind", "params"), "request.payload.step")
    step_id <- bounded_text(step$id, "request.payload.step.id", maximum_step_id_bytes)
    if (identical(step_id, "")) abort("invalid_request", "request.payload.step.id may not be empty")
    kind <- bounded_text(step$kind, "request.payload.step.kind", 64L)
    if (kind %in% c("renameColumn", "cloneColumn")) {
      params <- exact_record(step$params, c("column", "newName"), "request.payload.step.params")
      new_name <- bounded_text(params$newName, "request.payload.step.params.newName", maximum_variable_name_bytes)
      if (identical(new_name, "")) {
        abort("invalid_request", "request.payload.step.params.newName may not be empty")
      }
      decoded <- list(
        id = step_id,
        kind = kind,
        params = list(
          column = decode_column_reference(
            params$column,
            "request.payload.step.params.column",
            limits$columnIdBytes
          ),
          newName = new_name
        )
      )
      if (identical(kind, "cloneColumn")) {
        decoded$outputId <- bounded_text(
          paste0("c:step:", step_id, ":0"),
          "the derived R clone column identity",
          limits$columnIdBytes
        )
      }
      return(decoded)
    }
    if (identical(kind, "textLength")) {
      params <- exact_record(step$params, c("column", "newColumn"), "request.payload.step.params")
      new_column <- bounded_text(
        params$newColumn,
        "request.payload.step.params.newColumn",
        maximum_variable_name_bytes
      )
      if (identical(new_column, "")) {
        abort("invalid_request", "request.payload.step.params.newColumn may not be empty")
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(
          column = decode_column_reference(
            params$column,
            "request.payload.step.params.column",
            limits$columnIdBytes
          ),
          newColumn = new_column
        ),
        outputId = bounded_text(
          paste0("c:step:", step_id, ":0"),
          "the derived R text-length column identity",
          limits$columnIdBytes
        )
      ))
    }
    if (identical(kind, "lowerText")) {
      params <- exact_record(
        step$params,
        "column",
        "request.payload.step.params",
        optional_fields = "newColumn"
      )
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      new_column <- NULL
      if ("newColumn" %in% names(params)) {
        new_column <- bounded_text(
          params$newColumn,
          "request.payload.step.params.newColumn",
          maximum_variable_name_bytes
        )
        if (identical(new_column, "")) {
          abort("invalid_request", "request.payload.step.params.newColumn may not be empty")
        }
      }
      in_place <- is.null(new_column) || identical(new_column, column$name)
      return(list(
        id = step_id,
        kind = kind,
        params = list(column = column, newColumn = new_column),
        outputId = if (in_place) {
          column$id
        } else {
          bounded_text(
            paste0("c:step:", step_id, ":0"),
            "the derived R lowercase column identity",
            limits$columnIdBytes
          )
        }
      ))
    }
    if (identical(kind, "castColumn")) {
      params <- exact_record(step$params, c("column", "dtype"), "request.payload.step.params")
      column <- decode_column_reference(
        params$column,
        "request.payload.step.params.column",
        limits$columnIdBytes
      )
      dtype <- bounded_text(params$dtype, "request.payload.step.params.dtype", 32L)
      if (!dtype %in% c("string", "integer", "float", "boolean", "date", "datetime")) {
        abort("invalid_request", "request.payload.step.params.dtype is unsupported")
      }
      return(list(
        id = step_id,
        kind = kind,
        params = list(column = column, dtype = dtype)
      ))
    }
    if (kind %in% c("dropColumns", "selectColumns")) {
      params <- exact_record(step$params, "columns", "request.payload.step.params")
      columns <- params$columns
      if (
        !is.list(columns) ||
          is.object(columns) ||
          !is.null(names(columns)) ||
          length(columns) == 0L ||
          length(columns) > limits$columns
      ) {
        abort("invalid_request", "request.payload.step.params.columns must be a bounded non-empty array")
      }
      columns <- lapply(seq_along(columns), function(index) {
        decode_column_reference(
          columns[[index]],
          sprintf("request.payload.step.params.columns[%d]", index),
          limits$columnIdBytes
        )
      })
      column_ids <- vapply(columns, `[[`, character(1L), "id", USE.NAMES = FALSE)
      if (anyDuplicated(column_ids)) {
        abort("invalid_request", "request.payload.step.params.columns contains a repeated column identity")
      }
      return(list(id = step_id, kind = kind, params = list(columns = columns)))
    }
    if (!kind %in% c(
      "renameColumn",
      "cloneColumn",
      "dropColumns",
      "selectColumns",
      "textLength",
      "lowerText",
      "castColumn"
    )) {
      abort("unsupported_operation", sprintf("The native R runtime does not support %s", kind))
    }
    abort("unsupported_operation", sprintf("The native R runtime does not support %s", kind))
  }

  bind_rename_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The rename column reference no longer matches the active R dataframe", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = step$params$newName
    )
  }

  bind_clone_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The clone column reference no longer matches the active R dataframe", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = step$params$newName,
      outputId = step$outputId
    )
  }

  bind_text_length_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The text length column reference no longer matches the active R dataframe", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = step$params$newColumn,
      outputId = step$outputId
    )
  }

  bind_lower_text_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The lowercase column reference no longer matches the active R dataframe", TRUE)
    }
    in_place <- is.null(step$params$newColumn) || identical(step$params$newColumn, step$params$column$name)
    list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = if (in_place) step$params$column$name else step$params$newColumn,
      inPlace = in_place,
      outputId = step$outputId
    )
  }

  bind_cast_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    matches <- which(vapply(schema, function(column) identical(column$id, step$params$column$id), logical(1L)))
    if (
      length(matches) != 1L ||
        !identical(schema[[matches[[1L]]]]$name, step$params$column$name)
    ) {
      abort("stale_column", "The cast column reference no longer matches the active R dataframe", TRUE)
    }
    list(
      id = step$id,
      kind = step$kind,
      position = as.integer(matches[[1L]]),
      oldName = step$params$column$name,
      newName = step$params$column$name,
      inPlace = TRUE,
      outputId = step$params$column$id,
      dtype = step$params$dtype
    )
  }

  bind_drop_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    schema_ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    columns <- lapply(step$params$columns, function(reference) {
      matches <- which(schema_ids == reference$id)
      if (length(matches) != 1L || !identical(schema[[matches[[1L]]]]$name, reference$name)) {
        abort("stale_column", "A drop column reference no longer matches the active R dataframe", TRUE)
      }
      list(
        id = reference$id,
        position = as.integer(matches[[1L]]),
        name = reference$name
      )
    })
    if (length(columns) >= length(schema)) {
      abort("invalid_request", "dropColumns must leave at least one visible column", TRUE)
    }
    positions <- vapply(columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    columns <- columns[order(positions)]
    list(id = step$id, kind = step$kind, columns = columns)
  }

  bind_select_step <- function(capture, step) {
    schema <- capture$descriptor$schema
    schema_ids <- vapply(schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
    columns <- lapply(step$params$columns, function(reference) {
      matches <- which(schema_ids == reference$id)
      if (length(matches) != 1L || !identical(schema[[matches[[1L]]]]$name, reference$name)) {
        abort("stale_column", "A selected column reference no longer matches the active R dataframe", TRUE)
      }
      list(
        id = reference$id,
        position = as.integer(matches[[1L]]),
        name = reference$name
      )
    })
    selected_positions <- vapply(columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
    removed_names <- vapply(
      schema[setdiff(seq_along(schema), selected_positions)],
      `[[`,
      character(1L),
      "name",
      USE.NAMES = FALSE
    )
    list(id = step$id, kind = step$kind, columns = columns, removedNames = removed_names)
  }

  apply_step <- function(frame_contract, capture, step) {
    source <- get("snapshot", envir = capture, inherits = FALSE)
    if (identical(step$kind, "renameColumn")) {
      bound <- bind_rename_step(capture, step)
      result <- frame_contract$rename_column_at(source, bound$position, bound$oldName, bound$newName)
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = seq_along(capture$descriptor$schema)
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "cloneColumn")) {
      bound <- bind_clone_step(capture, step)
      result <- frame_contract$clone_column_at(source, bound$position, bound$oldName, bound$newName)
      source_positions <- c(seq_along(capture$descriptor$schema), bound$position)
      output_ids <- c(
        vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
        bound$outputId
      )
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = source_positions,
          output_ids = output_ids
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "textLength")) {
      bound <- bind_text_length_step(capture, step)
      result <- frame_contract$text_length_column_at(source, bound$position, bound$oldName, bound$newName)
      source_positions <- c(seq_along(capture$descriptor$schema), bound$position)
      output_ids <- c(
        vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
        bound$outputId
      )
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = source_positions,
          output_ids = output_ids,
          text_length_positions = length(output_ids)
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "lowerText")) {
      bound <- bind_lower_text_step(capture, step)
      result <- frame_contract$lower_text_column_at(
        source,
        bound$position,
        bound$oldName,
        if (isTRUE(bound$inPlace)) NULL else bound$newName
      )
      if (isTRUE(bound$inPlace)) {
        source_positions <- seq_along(capture$descriptor$schema)
        output_ids <- vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE)
        lower_position <- bound$position
      } else {
        source_positions <- c(seq_along(capture$descriptor$schema), bound$position)
        output_ids <- c(
          vapply(capture$descriptor$schema, `[[`, character(1L), "id", USE.NAMES = FALSE),
          bound$outputId
        )
        lower_position <- length(output_ids)
      }
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = source_positions,
          output_ids = output_ids,
          lower_text_positions = lower_position
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "castColumn")) {
      bound <- bind_cast_step(capture, step)
      result <- frame_contract$cast_column_at(source, bound$position, bound$oldName, bound$dtype)
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = seq_along(capture$descriptor$schema),
          cast_positions = bound$position,
          cast_dtypes = bound$dtype
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "dropColumns")) {
      bound <- bind_drop_step(capture, step)
      positions <- vapply(bound$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
      names <- vapply(bound$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
      result <- frame_contract$drop_columns_at(source, positions, names)
      keep_positions <- setdiff(seq_along(capture$descriptor$schema), positions)
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = keep_positions
        ),
        bound = bound
      ))
    }
    if (identical(step$kind, "selectColumns")) {
      bound <- bind_select_step(capture, step)
      positions <- vapply(bound$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
      names <- vapply(bound$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
      result <- frame_contract$select_columns_at(source, positions, names)
      return(list(
        capture = frame_contract$capture_frame(
          result,
          nullability_source = capture,
          source_positions = positions
        ),
        bound = bound
      ))
    }
    abort("unsupported_operation", sprintf("The native R runtime does not support %s", step$kind))
  }

  replay_plan <- function(frame_contract, original, plan) {
    capture <- original
    bound_plan <- vector("list", length(plan))
    if (length(plan) != 0L) {
      for (index in seq_along(plan)) {
        applied <- apply_step(frame_contract, capture, plan[[index]])
        capture <- applied$capture
        bound_plan[[index]] <- applied$bound
      }
    }
    list(capture = capture, boundPlan = bound_plan)
  }

  begin_editing <- function(frame_contract, session) {
    if (!is.null(session$original)) return(session)
    original <- frame_contract$isolate_capture(session$source)
    session$original <- original
    session$committed <- original
    session$editing <- TRUE
    session
  }

  r_string <- function(value) {
    encodeString(value, quote = "\"", justify = "none", na.encode = FALSE)
  }

  cast_code_helper_lines <- function() {
    c(
      "  .ow_cast_kind <- function(.ow_value) {",
      "    if (is.factor(.ow_value)) return(\"factor\")",
      "    if (inherits(.ow_value, \"integer64\")) return(\"integer64\")",
      "    if (inherits(.ow_value, \"POSIXct\")) return(\"POSIXct\")",
      "    if (inherits(.ow_value, \"Date\")) return(\"Date\")",
      "    if (inherits(.ow_value, \"difftime\")) return(\"difftime\")",
      "    if (is.logical(.ow_value)) return(\"logical\")",
      "    if (is.integer(.ow_value)) return(\"integer\")",
      "    if (is.double(.ow_value)) return(\"double\")",
      "    if (is.character(.ow_value)) return(\"character\")",
      "    stop(\"Open Wrangler Cast received an unsupported R column type\", call. = FALSE)",
      "  }",
      "  .ow_cast_raw_type <- function(.ow_value, .ow_kind) {",
      "    if (identical(.ow_kind, \"factor\") && is.ordered(.ow_value)) return(\"ordered factor\")",
      "    .ow_kind",
      "  }",
      "  .ow_cast_utf8 <- function(.ow_value) {",
      "    vapply(seq_along(.ow_value), function(.ow_index) {",
      "      .ow_text <- .ow_value[[.ow_index]]",
      "      if (is.na(.ow_text)) return(NA_character_)",
      "      if (identical(Encoding(.ow_text), \"bytes\")) stop(\"Open Wrangler Cast requires valid UTF-8 text\", call. = FALSE)",
      "      .ow_encoding <- Encoding(.ow_text)",
      "      .ow_from <- if (identical(.ow_encoding, \"latin1\")) \"latin1\" else \"UTF-8\"",
      "      .ow_utf8 <- iconv(.ow_text, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
      "      if (is.na(.ow_utf8) || nchar(.ow_utf8, type = \"bytes\") > 8192L) stop(\"Open Wrangler Cast requires bounded valid UTF-8 text\", call. = FALSE)",
      "      .ow_utf8",
      "    }, character(1L), USE.NAMES = FALSE)",
      "  }",
      "  .ow_cast_double_text <- function(.ow_value) {",
      "    vapply(seq_along(.ow_value), function(.ow_index) {",
      "      .ow_number <- .ow_value[[.ow_index]]",
      "      if (is.na(.ow_number) && !is.nan(.ow_number)) return(NA_character_)",
      "      sprintf(\"%.17g\", .ow_number)",
      "    }, character(1L), USE.NAMES = FALSE)",
      "  }",
      "  .ow_cast_canonical_dates <- function(.ow_value) {",
      "    .ow_result <- .ow_value",
      "    .ow_present <- !is.na(.ow_result)",
      "    if (!any(.ow_present)) return(.ow_result)",
      "    .ow_rendered <- format(.ow_result[.ow_present], format = \"%Y-%m-%d\")",
      "    .ow_canonical <- grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\", .ow_rendered) & !startsWith(.ow_rendered, \"0000-\")",
      "    if (any(.ow_canonical)) {",
      "      .ow_reparsed <- suppressWarnings(as.Date(.ow_rendered[.ow_canonical], format = \"%Y-%m-%d\"))",
      "      .ow_canonical[.ow_canonical] <- !is.na(.ow_reparsed) & .ow_reparsed == .ow_result[.ow_present][.ow_canonical]",
      "    }",
      "    .ow_result[which(.ow_present)[!.ow_canonical]] <- as.Date(NA_character_)",
      "    .ow_result",
      "  }",
      "  .ow_cast_canonical_datetimes <- function(.ow_value) {",
      "    .ow_result <- .ow_value",
      "    .ow_present <- !is.na(.ow_result)",
      "    if (!any(.ow_present)) return(.ow_result)",
      "    .ow_rendered <- format(.ow_result[.ow_present], tz = \"UTC\", format = \"%Y-%m-%dT%H:%M:%OS6\", usetz = FALSE)",
      "    .ow_canonical <- grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\\\.[0-9]{6}$\", .ow_rendered) & !startsWith(.ow_rendered, \"0000-\")",
      "    .ow_result[which(.ow_present)[!.ow_canonical]] <- as.POSIXct(NA_real_, origin = \"1970-01-01\", tz = \"UTC\")",
      "    .ow_result",
      "  }",
      "  .ow_cast_date_text <- function(.ow_value) {",
      "    .ow_output <- as.Date(rep(NA_character_, length(.ow_value)))",
      "    .ow_valid <- !is.na(.ow_value) & grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\", .ow_value)",
      "    .ow_output[.ow_valid] <- suppressWarnings(as.Date(.ow_value[.ow_valid], format = \"%Y-%m-%d\"))",
      "    .ow_cast_canonical_dates(.ow_output)",
      "  }",
      "  .ow_cast_datetime_text <- function(.ow_value) {",
      "    .ow_output <- as.POSIXct(rep(NA_real_, length(.ow_value)), origin = \"1970-01-01\", tz = \"UTC\")",
      "    .ow_date <- !is.na(.ow_value) & grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\", .ow_value)",
      "    .ow_datetime <- !is.na(.ow_value) & grepl(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\\\.[0-9]{1,6})?Z?$\", .ow_value)",
      "    .ow_output[.ow_date] <- suppressWarnings(as.POSIXct(.ow_value[.ow_date], format = \"%Y-%m-%d\", tz = \"UTC\"))",
      "    .ow_normalized <- sub(\"Z$\", \"\", gsub(\" \", \"T\", .ow_value[.ow_datetime], fixed = TRUE))",
      "    .ow_parsed <- suppressWarnings(strptime(.ow_normalized, format = \"%Y-%m-%dT%H:%M:%OS\", tz = \"UTC\"))",
      "    .ow_output[.ow_datetime] <- as.POSIXct(.ow_parsed, tz = \"UTC\")",
      "    .ow_cast_canonical_datetimes(.ow_output)",
      "  }",
      "  .ow_cast_values <- function(.ow_value, .ow_target) {",
      "    .ow_kind <- .ow_cast_kind(.ow_value)",
      "    .ow_allowed <- switch(.ow_target,",
      "      string = c(\"logical\", \"integer\", \"integer64\", \"double\", \"character\", \"factor\", \"Date\", \"POSIXct\", \"difftime\"),",
      "      integer = c(\"logical\", \"integer\", \"integer64\", \"double\", \"character\", \"factor\"),",
      "      float = c(\"logical\", \"integer\", \"double\", \"character\", \"factor\"),",
      "      boolean = c(\"logical\", \"integer\", \"double\", \"character\", \"factor\"),",
      "      date = c(\"character\", \"factor\", \"Date\", \"POSIXct\"),",
      "      datetime = c(\"character\", \"factor\", \"Date\", \"POSIXct\"),",
      "      stop(\"Open Wrangler Cast received an unsupported target type\", call. = FALSE)",
      "    )",
      "    if (!.ow_kind %in% .ow_allowed) stop(sprintf(\"castColumn cannot convert an R %s column to %s\", .ow_cast_raw_type(.ow_value, .ow_kind), .ow_target), call. = FALSE)",
      "    .ow_text <- if (.ow_kind %in% c(\"character\", \"factor\")) .ow_cast_utf8(as.character(.ow_value)) else NULL",
      "    if (identical(.ow_target, \"string\")) {",
      "      if (.ow_kind %in% c(\"character\", \"factor\")) return(.ow_text)",
      "      if (.ow_kind %in% c(\"logical\", \"integer\", \"integer64\")) return(as.character(.ow_value))",
      "      if (identical(.ow_kind, \"double\")) return(.ow_cast_double_text(.ow_value))",
      "      if (identical(.ow_kind, \"Date\")) return(format(.ow_value, \"%Y-%m-%d\"))",
      "      if (identical(.ow_kind, \"POSIXct\")) return(format(.ow_value, \"%Y-%m-%dT%H:%M:%OS6Z\", tz = \"UTC\"))",
      "      .ow_duration <- as.double(.ow_value, units = attr(.ow_value, \"units\"))",
      "      .ow_number <- .ow_cast_double_text(.ow_duration)",
      "      .ow_number[is.nan(.ow_duration)] <- NA_character_",
      "      return(ifelse(is.na(.ow_number), NA_character_, paste(.ow_number, attr(.ow_value, \"units\"))))",
      "    }",
      "    if (identical(.ow_target, \"integer\")) {",
      "      if (identical(.ow_kind, \"integer64\")) return(.ow_value)",
      "      if (identical(.ow_kind, \"integer\")) return(.ow_value)",
      "      if (identical(.ow_kind, \"logical\")) return(as.integer(.ow_value))",
      "      if (.ow_kind %in% c(\"character\", \"factor\")) return(suppressWarnings(as.integer(trimws(.ow_text))))",
      "      return(suppressWarnings(as.integer(.ow_value)))",
      "    }",
      "    if (identical(.ow_target, \"float\")) {",
      "      if (.ow_kind %in% c(\"character\", \"factor\")) return(suppressWarnings(as.double(trimws(.ow_text))))",
      "      return(as.double(.ow_value))",
      "    }",
      "    if (identical(.ow_target, \"boolean\")) {",
      "      if (.ow_kind %in% c(\"character\", \"factor\")) return(suppressWarnings(as.logical(trimws(.ow_text))))",
      "      return(suppressWarnings(as.logical(.ow_value)))",
      "    }",
      "    if (identical(.ow_target, \"date\")) {",
      "      if (identical(.ow_kind, \"Date\")) return(.ow_cast_canonical_dates(.ow_value))",
      "      if (identical(.ow_kind, \"POSIXct\")) return(.ow_cast_canonical_dates(as.Date(.ow_value, tz = \"UTC\")))",
      "      return(.ow_cast_date_text(.ow_text))",
      "    }",
      "    if (identical(.ow_kind, \"POSIXct\")) return(.ow_cast_canonical_datetimes(structure(as.double(.ow_value), class = c(\"POSIXct\", \"POSIXt\"), tzone = \"UTC\")))",
      "    if (identical(.ow_kind, \"Date\")) return(.ow_cast_canonical_datetimes(as.POSIXct(.ow_cast_canonical_dates(.ow_value), tz = \"UTC\")))",
      "    .ow_cast_datetime_text(.ow_text)",
      "  }"
    )
  }

  compile_plan <- function(variable_name, bound_plan, maximum_columns) {
    if (length(bound_plan) == 0L) return("")
    lines <- c(
      "open_wrangler_result <- local({",
      sprintf(
        "  .ow_source <- get(%s, envir = parent.env(environment()), inherits = FALSE)",
        r_string(variable_name)
      ),
      "  if (!is.data.frame(.ow_source)) stop(\"Open Wrangler expected an R dataframe\", call. = FALSE)",
      "  .ow_result <- if (inherits(.ow_source, \"data.table\")) {",
      "    if (!requireNamespace(\"data.table\", quietly = TRUE)) stop(\"data.table is required\", call. = FALSE)",
      "    data.table::copy(.ow_source)",
      "  } else {",
      "    unserialize(serialize(.ow_source, NULL, version = 3L))",
      "  }"
    )
    if (any(vapply(bound_plan, function(step) identical(step$kind, "castColumn"), logical(1L)))) {
      lines <- c(lines, cast_code_helper_lines())
    }
    for (step in bound_plan) {
      if (identical(step$kind, "renameColumn")) {
        lines <- c(
          lines,
          sprintf(
            "  if (ncol(.ow_result) < %dL || !identical(names(.ow_result)[[%dL]], %s)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
            step$position,
            step$position,
            r_string(step$oldName)
          ),
          sprintf(
            "  if (any(names(.ow_result)[-%dL] == %s)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
            step$position,
            r_string(step$newName)
          ),
          sprintf(
            "  if (inherits(.ow_result, \"data.table\")) data.table::setnames(.ow_result, old = %dL, new = %s) else names(.ow_result)[[%dL]] <- %s",
            step$position,
            r_string(step$newName),
            step$position,
            r_string(step$newName)
          )
        )
      } else if (identical(step$kind, "cloneColumn")) {
        lines <- c(
          lines,
          sprintf("  .ow_clone_position <- %dL", step$position),
          sprintf("  .ow_clone_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_clone_name <- %s", r_string(step$newName)),
          "  if (ncol(.ow_result) < .ow_clone_position || !identical(names(.ow_result)[[.ow_clone_position]], .ow_clone_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (.ow_clone_name == \"\" || any(names(.ow_result) == .ow_clone_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
          sprintf(
            "  if (ncol(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
            maximum_columns
          ),
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    data.table::set(.ow_result, j = .ow_clone_name, value = .ow_result[[.ow_clone_position]])",
          "  } else {",
          "    .ow_clone_existing_names <- names(.ow_result)",
          "    .ow_result[[ncol(.ow_result) + 1L]] <- .ow_result[[.ow_clone_position]]",
          "    names(.ow_result) <- c(.ow_clone_existing_names, .ow_clone_name)",
          "  }"
        )
      } else if (identical(step$kind, "textLength")) {
        lines <- c(
          lines,
          sprintf("  .ow_text_length_position <- %dL", step$position),
          sprintf("  .ow_text_length_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_text_length_name <- %s", r_string(step$newName)),
          "  if (ncol(.ow_result) < .ow_text_length_position || !identical(names(.ow_result)[[.ow_text_length_position]], .ow_text_length_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (!is.character(.ow_result[[.ow_text_length_position]]) && !is.factor(.ow_result[[.ow_text_length_position]])) stop(\"Open Wrangler Text Length requires a character or factor column\", call. = FALSE)",
          "  if (.ow_text_length_name == \"\" || any(names(.ow_result) == .ow_text_length_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
          sprintf(
            "  if (ncol(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
            maximum_columns
          ),
          "  .ow_text_lengths <- nchar(as.character(.ow_result[[.ow_text_length_position]]), type = \"chars\", allowNA = FALSE, keepNA = TRUE)",
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    data.table::set(.ow_result, j = .ow_text_length_name, value = .ow_text_lengths)",
          "  } else {",
          "    .ow_text_length_existing_names <- names(.ow_result)",
          "    .ow_result[[ncol(.ow_result) + 1L]] <- .ow_text_lengths",
          "    names(.ow_result) <- c(.ow_text_length_existing_names, .ow_text_length_name)",
          "  }"
        )
      } else if (identical(step$kind, "lowerText")) {
        lines <- c(
          lines,
          sprintf("  .ow_lower_position <- %dL", step$position),
          sprintf("  .ow_lower_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_lower_name <- %s", r_string(step$newName)),
          "  if (ncol(.ow_result) < .ow_lower_position || !identical(names(.ow_result)[[.ow_lower_position]], .ow_lower_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (!is.character(.ow_result[[.ow_lower_position]]) && !is.factor(.ow_result[[.ow_lower_position]])) stop(\"Open Wrangler Lowercase requires a character or factor column\", call. = FALSE)",
          "  .ow_lower_source <- as.character(.ow_result[[.ow_lower_position]])",
          "  .ow_lower_values <- vapply(seq_along(.ow_lower_source), function(.ow_index) {",
          "    .ow_value <- .ow_lower_source[[.ow_index]]",
          "    if (is.na(.ow_value)) return(NA_character_)",
          "    if (identical(Encoding(.ow_value), \"bytes\")) stop(\"Open Wrangler Lowercase requires valid UTF-8 text\", call. = FALSE)",
          "    .ow_encoding <- Encoding(.ow_value)",
          "    .ow_from <- if (identical(.ow_encoding, \"latin1\")) \"latin1\" else \"UTF-8\"",
          "    .ow_utf8 <- iconv(.ow_value, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
          "    if (is.na(.ow_utf8) || nchar(.ow_utf8, type = \"bytes\") > 8192L) stop(\"Open Wrangler Lowercase requires bounded valid UTF-8 text\", call. = FALSE)",
          "    .ow_utf8",
          "  }, character(1L), USE.NAMES = FALSE)",
          "  .ow_lower_values <- tolower(.ow_lower_values)",
          "  .ow_lower_values <- vapply(seq_along(.ow_lower_values), function(.ow_index) {",
          "    .ow_value <- .ow_lower_values[[.ow_index]]",
          "    if (is.na(.ow_value)) return(NA_character_)",
          "    if (identical(Encoding(.ow_value), \"bytes\")) stop(\"Open Wrangler Lowercase produced invalid UTF-8 text\", call. = FALSE)",
          "    .ow_encoding <- Encoding(.ow_value)",
          "    .ow_from <- if (identical(.ow_encoding, \"latin1\")) \"latin1\" else \"UTF-8\"",
          "    .ow_utf8 <- iconv(.ow_value, from = .ow_from, to = \"UTF-8\", sub = NA_character_)",
          "    if (is.na(.ow_utf8) || nchar(.ow_utf8, type = \"bytes\") > 8192L) stop(\"Open Wrangler Lowercase produced invalid or oversized UTF-8 text\", call. = FALSE)",
          "    .ow_utf8",
          "  }, character(1L), USE.NAMES = FALSE)"
        )
        if (isTRUE(step$inPlace)) {
          lines <- c(
            lines,
            "  if (inherits(.ow_result, \"data.table\") && !is.null(data.table::key(.ow_result)) && .ow_lower_source_name %in% data.table::key(.ow_result)) stop(\"Open Wrangler Lowercase cannot replace a data.table key column; choose a new output column\", call. = FALSE)",
            "  if (inherits(.ow_result, \"data.table\")) data.table::set(.ow_result, j = .ow_lower_position, value = .ow_lower_values) else .ow_result[[.ow_lower_position]] <- .ow_lower_values"
          )
        } else {
          lines <- c(
            lines,
            "  if (.ow_lower_name == \"\" || any(names(.ow_result) == .ow_lower_name)) stop(\"Open Wrangler column name already exists\", call. = FALSE)",
            sprintf(
              "  if (ncol(.ow_result) >= %dL) stop(\"Open Wrangler column limit reached\", call. = FALSE)",
              maximum_columns
            ),
            "  if (inherits(.ow_result, \"data.table\")) {",
            "    data.table::set(.ow_result, j = .ow_lower_name, value = .ow_lower_values)",
            "  } else {",
            "    .ow_lower_existing_names <- names(.ow_result)",
            "    .ow_result[[ncol(.ow_result) + 1L]] <- .ow_lower_values",
            "    names(.ow_result) <- c(.ow_lower_existing_names, .ow_lower_name)",
            "  }"
          )
        }
      } else if (identical(step$kind, "castColumn")) {
        lines <- c(
          lines,
          sprintf("  .ow_cast_position <- %dL", step$position),
          sprintf("  .ow_cast_source_name <- %s", r_string(step$oldName)),
          sprintf("  .ow_cast_dtype <- %s", r_string(step$dtype)),
          "  if (ncol(.ow_result) < .ow_cast_position || !identical(names(.ow_result)[[.ow_cast_position]], .ow_cast_source_name)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (inherits(.ow_result, \"data.table\") && !is.null(data.table::key(.ow_result)) && .ow_cast_source_name %in% data.table::key(.ow_result)) stop(\"castColumn cannot replace a data.table key column; clone the column before casting it\", call. = FALSE)",
          "  .ow_cast_result <- .ow_cast_values(.ow_result[[.ow_cast_position]], .ow_cast_dtype)",
          "  if (inherits(.ow_result, \"data.table\")) data.table::set(.ow_result, j = .ow_cast_position, value = .ow_cast_result) else .ow_result[[.ow_cast_position]] <- .ow_cast_result"
        )
      } else if (identical(step$kind, "dropColumns")) {
        positions <- vapply(step$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
        names <- vapply(step$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
        position_code <- paste(sprintf("%dL", positions), collapse = ", ")
        name_code <- paste(vapply(names, r_string, character(1L), USE.NAMES = FALSE), collapse = ", ")
        lines <- c(
          lines,
          sprintf("  .ow_drop_positions <- c(%s)", position_code),
          sprintf("  .ow_drop_names <- c(%s)", name_code),
          "  if (any(.ow_drop_positions > ncol(.ow_result)) || !identical(names(.ow_result)[.ow_drop_positions], .ow_drop_names)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  .ow_keep_positions <- setdiff(seq_len(ncol(.ow_result)), .ow_drop_positions)",
          "  if (length(.ow_keep_positions) == 0L) stop(\"Open Wrangler must keep at least one column\", call. = FALSE)",
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    .ow_result <- .ow_result[, .ow_keep_positions, with = FALSE]",
          "  } else {",
          "    for (.ow_position in sort(.ow_drop_positions, decreasing = TRUE)) .ow_result[[.ow_position]] <- NULL",
          "  }"
        )
      } else if (identical(step$kind, "selectColumns")) {
        positions <- vapply(step$columns, `[[`, integer(1L), "position", USE.NAMES = FALSE)
        names <- vapply(step$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
        position_code <- paste(sprintf("%dL", positions), collapse = ", ")
        name_code <- paste(vapply(names, r_string, character(1L), USE.NAMES = FALSE), collapse = ", ")
        lines <- c(
          lines,
          sprintf("  .ow_select_positions <- c(%s)", position_code),
          sprintf("  .ow_select_names <- c(%s)", name_code),
          "  if (length(.ow_select_positions) == 0L || any(.ow_select_positions > ncol(.ow_result)) || !identical(names(.ow_result)[.ow_select_positions], .ow_select_names)) stop(\"Open Wrangler column reference is stale\", call. = FALSE)",
          "  if (inherits(.ow_result, \"data.table\")) {",
          "    .ow_result <- .ow_result[, .ow_select_positions, with = FALSE]",
          "  } else {",
          "    .ow_result <- .ow_result[.ow_select_positions]",
          "    names(.ow_result) <- .ow_select_names",
          "  }"
        )
      } else {
        abort("runtime_error", "The R cleaning plan contains an unsupported operation")
      }
    }
    code <- paste(c(lines, "  .ow_result", "})", ""), collapse = "\n")
    if (nchar(code, type = "bytes") > maximum_generated_code_bytes) {
      abort("runtime_error", "The generated R cleaning code is too large")
    }
    code
  }

  step_diff <- function(
    bound,
    frame_contract = NULL,
    before = NULL,
    after = NULL,
    page = NULL,
    before_page = NULL,
    after_page = NULL
  ) {
    added_columns <- if (
      bound$kind %in% c("cloneColumn", "textLength") ||
        (identical(bound$kind, "lowerText") && !isTRUE(bound$inPlace))
    ) {
      bound$newName
    } else {
      character()
    }
    removed_columns <- if (identical(bound$kind, "dropColumns")) {
      vapply(bound$columns, `[[`, character(1L), "name", USE.NAMES = FALSE)
    } else if (identical(bound$kind, "selectColumns")) {
      bound$removedNames
    } else {
      character()
    }
    changed_cells <- 0L
    cells <- list()
    truncated <- FALSE
    if (bound$kind %in% c("lowerText", "castColumn") && isTRUE(bound$inPlace)) {
      if (is.null(frame_contract) || is.null(before) || is.null(after) || is.null(page)) {
        abort("runtime_error", "The R in-place transform diff is missing its bounded page context")
      }
      if (is.null(before_page)) before_page <- materialize(frame_contract, before, page)
      if (is.null(after_page)) after_page <- materialize(frame_contract, after, page)
      before_position <- match(bound$outputId, before_page$page$columnIds)
      after_position <- match(bound$outputId, after_page$page$columnIds)
      if (is.na(before_position) || is.na(after_position)) {
        truncated <- TRUE
      } else {
        before_rows <- before_page$page$rows
        before_row_ids <- vapply(before_rows, `[[`, character(1L), "id", USE.NAMES = FALSE)
        matched_before <- logical(length(before_rows))
        matched_after <- 0L
        for (after_row in after_page$page$rows) {
          before_index <- match(after_row$id, before_row_ids)
          if (is.na(before_index)) next
          matched_before[[before_index]] <- TRUE
          matched_after <- matched_after + 1L
          old <- before_rows[[before_index]]$values[[before_position]]
          new <- after_row$values[[after_position]]
          if (!identical(old, new)) {
            changed_cells <- changed_cells + 1L
            if (length(cells) < 500L) {
              cells[[length(cells) + 1L]] <- list(
                rowNumber = after_row$rowNumber,
                columnId = bound$outputId,
                column = bound$newName,
                before = old,
                after = new
              )
            }
          }
        }
        if (matched_after != length(after_page$page$rows) || sum(matched_before) != length(before_rows)) {
          truncated <- TRUE
        }
      }
      truncated <- truncated ||
        before_page$page$totalRows > length(before_page$page$rows) ||
        after_page$page$totalRows > length(after_page$page$rows) ||
        changed_cells > length(cells)
    }
    list(
      addedRows = 0L,
      removedRows = 0L,
      addedColumns = I(added_columns),
      removedColumns = I(removed_columns),
      changedCells = changed_cells,
      cells = I(cells),
      truncated = truncated
    )
  }

  encode_response <- function(response) {
    encoded <- jsonlite::toJSON(
      response,
      auto_unbox = TRUE,
      digits = NA,
      na = "null",
      null = "null",
      pretty = FALSE
    )
    if (nchar(encoded, type = "bytes") > maximum_response_bytes) {
      abort("runtime_error", "The R kernel response is too large")
    }
    enc2utf8(as.character(encoded))
  }

  preflight_response <- function(response) {
    encode_response(response)
    invisible(NULL)
  }

  plan_response <- function(request_id, session_id, action, session, page, frame_contract) {
    list(
      transportVersion = transport_version,
      requestId = request_id,
      kind = "planUpdated",
      sessionId = session_id,
      action = action,
      revision = session$revision,
      page = materialize(frame_contract, active_capture(session), page),
      code = compile_plan(session$variableName, session$boundPlan, frame_contract$limits$columns)
    )
  }

  new_agent <- function(frame_contract, source_environment = .GlobalEnv) {
    required_functions <- c(
      "capture_frame",
      "capture_live_frame",
      "isolate_capture",
      "rename_column",
      "rename_column_at",
      "clone_column_at",
      "text_length_column_at",
      "lower_text_column_at",
      "cast_column_at",
      "drop_columns_at",
      "select_columns_at",
      "materialize_view_page",
      "materialize_summaries",
      "materialize_dataset_stats",
      "materialize_column_values"
    )
    if (
      !is.list(frame_contract) ||
        !all(vapply(required_functions, function(name) is.function(frame_contract[[name]]), logical(1L))) ||
        !is.list(frame_contract$limits)
    ) {
      stop("Open Wrangler received an invalid R frame contract.", call. = FALSE)
    }
    if (!is.environment(source_environment)) {
      stop("Open Wrangler received an invalid R source environment.", call. = FALSE)
    }

    sessions <- new.env(hash = TRUE, parent = emptyenv())

    dispatch <- function(request) {
      request <- exact_record(request, c("transportVersion", "requestId", "kind", "payload"), "request")
      if (!identical(request$transportVersion, transport_version)) {
        abort("invalid_request", "request.transportVersion is unsupported")
      }
      request_id <- identifier(request$requestId, "request.requestId")
      kind <- bounded_text(request$kind, "request.kind", 32L)

      if (identical(kind, "openSession")) {
        payload <- exact_record(request$payload, c("sessionId", "variableName", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        variable_name <- bounded_text(
          payload$variableName,
          "request.payload.variableName",
          maximum_variable_name_bytes
        )
        if (identical(variable_name, "")) {
          abort("invalid_request", "request.payload.variableName may not be empty")
        }
        if (exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("duplicate_session", "The requested R session identity is already in use")
        }
        if (!exists(variable_name, envir = source_environment, inherits = FALSE)) {
          abort("unknown_variable", "The selected R dataframe variable no longer exists", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        source_reader <- local({
          source_name <- variable_name
          source <- source_environment
          function() {
            if (
              !exists(source_name, envir = source, inherits = FALSE) ||
                bindingIsActive(source_name, source)
            ) {
              return(NULL)
            }
            get(source_name, envir = source, inherits = FALSE)
          }
        })
        source_capture <- frame_contract$capture_live_frame(source_reader)
        result <- materialize(frame_contract, source_capture, page)
        session <- list(
          variableName = variable_name,
          source = source_capture,
          original = NULL,
          committed = NULL,
          draft = NULL,
          draftStep = NULL,
          draftBound = NULL,
          replaceStepId = NULL,
          plan = list(),
          boundPlan = list(),
          revision = 0L,
          editing = FALSE
        )
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "page",
          sessionId = session_id,
          page = result
        )
        preflight_response(response)
        assign(session_id, session, envir = sessions)
        return(response)
      }

      if (identical(kind, "getPage")) {
        payload <- exact_record(request$payload, c("sessionId", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        session <- get(session_id, envir = sessions, inherits = FALSE)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "page",
          sessionId = session_id,
          page = materialize(frame_contract, active_capture(session), page)
        ))
      }

      if (identical(kind, "getSummary")) {
        payload <- exact_record(request$payload, c("sessionId", "columns", "view"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        columns <- decode_column_references(payload$columns, frame_contract$limits)
        view <- decode_view(payload$view, frame_contract$limits)
        session <- get(session_id, envir = sessions, inherits = FALSE)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "summary",
          sessionId = session_id,
          summaries = frame_contract$materialize_summaries(active_capture(session), columns, view)
        ))
      }

      if (identical(kind, "getDatasetStats")) {
        payload <- exact_record(request$payload, c("sessionId", "view"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        view <- decode_view(payload$view, frame_contract$limits)
        result <- validate_dataset_stats_result(
          frame_contract$materialize_dataset_stats(active_capture(session), view),
          frame_contract$limits
        )
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "datasetStats",
          sessionId = session_id,
          totalRows = result$totalRows,
          stats = result$stats
        ))
      }

      if (identical(kind, "getColumnValues")) {
        payload <- exact_record(
          request$payload,
          c("sessionId", "column", "view", "search", "limit"),
          "request.payload"
        )
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        column <- decode_column_reference(
          payload$column,
          "request.payload.column",
          frame_contract$limits$columnIdBytes
        )
        view <- decode_view(payload$view, frame_contract$limits)
        search <- if (is.null(payload$search)) {
          NULL
        } else {
          bounded_text(payload$search, "request.payload.search", frame_contract$limits$textBytes)
        }
        limit <- whole_number(payload$limit, "request.payload.limit", 10000L)
        if (limit < 1L) abort("invalid_request", "request.payload.limit must be positive")
        session <- get(session_id, envir = sessions, inherits = FALSE)
        result <- frame_contract$materialize_column_values(active_capture(session), column, view, search, limit)
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "columnValues",
          sessionId = session_id,
          column = result$column,
          values = result$values,
          hasMore = result$hasMore
        ))
      }

      if (identical(kind, "previewStep")) {
        payload <- exact_record(
          request$payload,
          c("sessionId", "revision", "step", "page"),
          "request.payload",
          optional_fields = "replaceStepId"
        )
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        if (!is.null(session$draft)) {
          abort("invalid_request", "Apply or discard the current R draft before previewing another step", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        step <- decode_transform_step(payload$step, frame_contract$limits)
        replace_step_id <- if ("replaceStepId" %in% names(payload)) {
          value <- bounded_text(payload$replaceStepId, "request.payload.replaceStepId", maximum_step_id_bytes)
          if (identical(value, "")) abort("invalid_request", "request.payload.replaceStepId may not be empty")
          value
        } else {
          NULL
        }

        session <- begin_editing(frame_contract, session)

        retained_plan <- session$plan
        retained_bound_plan <- session$boundPlan
        base <- session$committed
        if (!is.null(replace_step_id)) {
          if (
            length(session$plan) == 0L ||
              !identical(session$plan[[length(session$plan)]]$id, replace_step_id)
          ) {
            abort("invalid_request", "Only the latest applied R step can be edited", TRUE)
          }
          if (!identical(step$id, replace_step_id)) {
            abort("invalid_request", "An edited R step must retain its applied step ID", TRUE)
          }
          retained_plan <- session$plan[-length(session$plan)]
          replayed <- replay_plan(frame_contract, session$original, retained_plan)
          base <- replayed$capture
          retained_bound_plan <- replayed$boundPlan
        }
        if (length(retained_plan) >= frame_contract$limits$columns) {
          abort("invalid_request", "The R cleaning plan has reached its supported step limit", TRUE)
        }
        if (any(vapply(retained_plan, function(applied) identical(applied$id, step$id), logical(1L)))) {
          abort("invalid_request", "Applied R step IDs must be unique", TRUE)
        }

        applied <- apply_step(frame_contract, base, step)
        candidate <- session
        candidate$draft <- applied$capture
        candidate$draftStep <- step
        candidate$draftBound <- applied$bound
        candidate$replaceStepId <- replace_step_id
        candidate$editing <- TRUE
        candidate$revision <- next_revision(session)
        candidate_bound_plan <- c(retained_bound_plan, list(applied$bound))
        draft_page <- materialize(frame_contract, candidate$draft, page)
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "stepPreview",
          sessionId = session_id,
          revision = candidate$revision,
          page = draft_page,
          diff = step_diff(
            applied$bound,
            frame_contract,
            base,
            applied$capture,
            page,
            after_page = draft_page
          ),
          code = compile_plan(
            candidate$variableName,
            candidate_bound_plan,
            frame_contract$limits$columns
          )
        )
        preflight_response(response)
        assign(session_id, candidate, envir = sessions)
        return(response)
      }

      if (kind %in% c("inspectStepInfo", "inspectStepPage")) {
        payload <- if (identical(kind, "inspectStepInfo")) {
          exact_record(request$payload, c("sessionId", "revision", "stepId"), "request.payload")
        } else {
          exact_record(
            request$payload,
            c("sessionId", "revision", "stepId", "side", "page"),
            "request.payload"
          )
        }
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        step_id <- bounded_text(payload$stepId, "request.payload.stepId", maximum_step_id_bytes)
        if (identical(step_id, "")) abort("invalid_request", "request.payload.stepId may not be empty")
        matches <- which(vapply(session$plan, function(step) identical(step$id, step_id), logical(1L)))
        if (length(matches) != 1L) {
          abort("invalid_request", sprintf("Unknown or repeated applied R step: %s", step_id), TRUE)
        }
        step_index <- matches[[1L]]
        if (identical(kind, "inspectStepInfo")) {
          return(list(
            transportVersion = transport_version,
            requestId = request_id,
            kind = "stepInspectionInfo",
            sessionId = session_id,
            revision = session$revision,
            stepId = step_id,
            stepIndex = as.integer(step_index - 1L),
            code = compile_plan(
              session$variableName,
              utils::head(session$boundPlan, step_index),
              frame_contract$limits$columns
            )
          ))
        }
        side <- bounded_text(payload$side, "request.payload.side", 6L)
        if (!side %in% c("input", "output")) {
          abort("invalid_request", "request.payload.side must be input or output")
        }
        page <- decode_page(payload$page, frame_contract$limits)
        inspected <- replay_plan(
          frame_contract,
          session$original,
          utils::head(session$plan, step_index - if (identical(side, "input")) 1L else 0L)
        )
        inspection_page <- materialize(
          frame_contract,
          inspected$capture,
          page
        )
        inspection_page$schema <- NULL
        return(list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "stepInspectionPage",
          sessionId = session_id,
          revision = session$revision,
          stepId = step_id,
          stepIndex = as.integer(step_index - 1L),
          side = side,
          page = inspection_page
        ))
      }

      if (identical(kind, "applyDraft")) {
        payload <- exact_record(request$payload, c("sessionId", "revision", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        if (is.null(session$draft) || is.null(session$draftStep) || is.null(session$draftBound)) {
          abort("invalid_request", "There is no R draft step to apply", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        candidate <- session
        if (is.null(session$replaceStepId)) {
          candidate$plan <- c(session$plan, list(session$draftStep))
          candidate$boundPlan <- c(session$boundPlan, list(session$draftBound))
        } else {
          candidate$plan[[length(candidate$plan)]] <- session$draftStep
          candidate$boundPlan[[length(candidate$boundPlan)]] <- session$draftBound
        }
        candidate$committed <- session$draft
        candidate$draft <- NULL
        candidate$draftStep <- NULL
        candidate$draftBound <- NULL
        candidate$replaceStepId <- NULL
        candidate$revision <- next_revision(session)
        response <- plan_response(request_id, session_id, "apply", candidate, page, frame_contract)
        preflight_response(response)
        assign(session_id, candidate, envir = sessions)
        return(response)
      }

      if (identical(kind, "discardDraft")) {
        payload <- exact_record(request$payload, c("sessionId", "revision", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        if (is.null(session$draft)) abort("invalid_request", "There is no R draft step to discard", TRUE)
        page <- decode_page(payload$page, frame_contract$limits)
        candidate <- session
        candidate$draft <- NULL
        candidate$draftStep <- NULL
        candidate$draftBound <- NULL
        candidate$replaceStepId <- NULL
        candidate$revision <- next_revision(session)
        response <- plan_response(request_id, session_id, "discard", candidate, page, frame_contract)
        preflight_response(response)
        assign(session_id, candidate, envir = sessions)
        return(response)
      }

      if (identical(kind, "undoStep")) {
        payload <- exact_record(request$payload, c("sessionId", "revision", "page"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is no longer available", TRUE)
        }
        session <- get(session_id, envir = sessions, inherits = FALSE)
        assert_revision(session, payload$revision)
        if (!is.null(session$draft)) {
          abort("invalid_request", "Discard the R draft before undoing an applied step", TRUE)
        }
        if (length(session$plan) == 0L) {
          abort("invalid_request", "There is no applied R step to undo", TRUE)
        }
        page <- decode_page(payload$page, frame_contract$limits)
        retained_plan <- session$plan[-length(session$plan)]
        replayed <- replay_plan(frame_contract, session$original, retained_plan)
        candidate <- session
        candidate$plan <- retained_plan
        candidate$boundPlan <- replayed$boundPlan
        candidate$committed <- replayed$capture
        candidate$editing <- TRUE
        candidate$revision <- next_revision(session)
        response <- plan_response(request_id, session_id, "undo", candidate, page, frame_contract)
        preflight_response(response)
        assign(session_id, candidate, envir = sessions)
        return(response)
      }

      if (identical(kind, "closeSession")) {
        payload <- exact_record(request$payload, c("sessionId"), "request.payload")
        session_id <- identifier(payload$sessionId, "request.payload.sessionId")
        if (!exists(session_id, envir = sessions, inherits = FALSE)) {
          abort("unknown_session", "The requested R session is already closed", TRUE)
        }
        response <- list(
          transportVersion = transport_version,
          requestId = request_id,
          kind = "closed",
          sessionId = session_id
        )
        preflight_response(response)
        rm(list = session_id, envir = sessions)
        return(response)
      }

      abort("invalid_request", "request.kind is unsupported")
    }

    dispatch_json <- function(payload) {
      request_id <- ""
      response <- tryCatch(
        {
          if (!requireNamespace("jsonlite", quietly = TRUE)) {
            abort("missing_package", "The selected R kernel requires the jsonlite package")
          }
          payload <- bounded_text(payload, "request JSON", maximum_response_bytes)
          request <- jsonlite::fromJSON(payload, simplifyVector = FALSE)
          if (is.list(request) && is.character(request$requestId) && length(request$requestId) == 1L) {
            request_id <- request$requestId
          }
          dispatch(request)
        },
        openwrangler_r_kernel_error = function(error) {
          message <- diagnostic_message(error, "The R runtime request failed")
          list(
            transportVersion = transport_version,
            requestId = request_id,
            kind = "error",
            code = error$code,
            message = message,
            recoverable = isTRUE(error$recoverable)
          )
        },
        openwrangler_r_frame_error = function(error) {
          diagnostic <- frame_diagnostic(error)
          list(
            transportVersion = transport_version,
            requestId = request_id,
            kind = "error",
            code = diagnostic$code,
            message = diagnostic$message,
            recoverable = diagnostic$recoverable
          )
        },
        error = function(error) {
          message <- diagnostic_message(error, "The R runtime request failed")
          list(
            transportVersion = transport_version,
            requestId = request_id,
            kind = "error",
            code = "runtime_error",
            message = message,
            recoverable = FALSE
          )
        }
      )
      encode_response(response)
    }

    environment(dispatch_json) <- environment()
    list(dispatch_json = dispatch_json)
  }

  list(new_agent = new_agent, transport_version = transport_version)
})
