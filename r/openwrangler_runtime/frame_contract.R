# Native R dataframe contract spike for Open Wrangler 2.0.
#
# This file intentionally uses only base R. It returns ordinary R lists; an
# owning IRkernel or Rscript transport can encode those lists as strict JSON.
# Data remains in R throughout inspection and paging.

OW_R_FRAME_CONTRACT_VERSION <- 1L
OW_R_MAX_TEXT_BYTES <- 65536L
OW_R_MAX_TEXT_VECTOR_ITEMS <- 4096L
OW_R_MAX_TEXT_VECTOR_BYTES <- 1048576L
OW_R_MAX_PAGE_ROWS <- 10000L
OW_R_MAX_PAGE_CELLS <- 100000L
OW_R_MAX_CONTRACT_TEXT_BYTES <- 8388608L
OW_R_CODE_DIALECTS <- c("base-r", "dplyr", "data.table")

ow_r_frame_flavor <- function(frame) {
  classes <- class(frame)
  if (identical(classes, c("data.table", "data.frame"))) {
    return("data.table")
  }
  if (identical(classes, c("rowwise_df", "tbl_df", "tbl", "data.frame"))) {
    return("rowwise-tibble")
  }
  if (identical(classes, c("grouped_df", "tbl_df", "tbl", "data.frame"))) {
    return("grouped-tibble")
  }
  if (identical(classes, c("tbl_df", "tbl", "data.frame"))) {
    return("tibble")
  }
  if (identical(classes, "data.frame")) {
    return("data.frame")
  }
  stop("Open Wrangler supports only base data.frame, tibble, grouped/rowwise tibble, and data.table values.")
}

ow_r_frame_contract <- function(
  frame,
  offset = 0L,
  limit = 100L,
  column_positions = NULL,
  session_id = "r-probe",
  code_dialect = NULL
) {
  flavor <- ow_r_frame_flavor(frame)
  ow_r_validate_scalar_integer(offset, "offset", minimum = 0L)
  ow_r_validate_scalar_integer(limit, "limit", minimum = 1L)
  ow_r_validate_text(session_id, "session_id", allow_empty = FALSE)
  session_id_utf8 <- iconv(session_id, from = "", to = "UTF-8", sub = NA_character_)
  if (nchar(session_id_utf8, type = "bytes") > 256L) {
    stop("session_id exceeds the native R contract identity bound.")
  }
  if (limit > OW_R_MAX_PAGE_ROWS) {
    stop("limit exceeds the native R contract row bound.")
  }
  if (
    !is.null(code_dialect) &&
      (
        length(code_dialect) != 1L ||
          is.na(code_dialect) ||
          !is.character(code_dialect) ||
          !(code_dialect %in% OW_R_CODE_DIALECTS)
      )
  ) {
    stop("code_dialect must be NULL, base-r, dplyr, or data.table.")
  }

  row_count <- nrow(frame)
  column_count <- ncol(frame)
  if (!is.numeric(row_count) || !is.numeric(column_count) || row_count < 0 || column_count < 0) {
    stop("R dataframe dimensions must be finite non-negative integers.")
  }
  if (row_count > 2^53 - 1 || column_count > 2^53 - 1) {
    stop("R dataframe dimensions exceed the portable safe-integer range.")
  }
  column_names <- names(frame)
  if (!is.character(column_names) || length(column_names) != column_count || anyNA(column_names)) {
    stop("R dataframe columns must have non-missing character names.")
  }
  invisible(lapply(column_names, ow_r_validate_text, field = "column name", allow_empty = TRUE))

  if (is.null(column_positions)) {
    column_positions <- seq_len(column_count) - 1L
  }
  if (
    !is.integer(column_positions) ||
      anyNA(column_positions) ||
      any(column_positions < 0L) ||
      any(column_positions >= column_count) ||
      anyDuplicated(column_positions) ||
      is.unsorted(column_positions, strictly = TRUE)
  ) {
    stop("column_positions must be unique, increasing, zero-based positions in the dataframe schema.")
  }
  if (offset > row_count) {
    stop("offset cannot exceed the dataframe row count.")
  }
  if (
    length(column_positions) > 0L &&
      limit > floor(OW_R_MAX_PAGE_CELLS / length(column_positions))
  ) {
    stop("The requested R page exceeds the native R contract cell bound.")
  }

  schema <- vector("list", column_count)
  column_metadata <- vector("list", column_count)
  for (position in seq_len(column_count)) {
    column <- frame[[position]]
    if (
      !is.null(attr(column, "dim", exact = TRUE)) ||
        is.data.frame(column) ||
        length(unclass(column)) != row_count
    ) {
      stop("Matrix and array-valued dataframe columns are not supported by the first R contract.")
    }
    column_id <- paste0("r:c:", position - 1L)
    raw_type <- ow_r_raw_type(column)
    ow_r_validate_text(raw_type, "column raw type", allow_empty = FALSE)
    schema[[position]] <- list(
      id = column_id,
      name = column_names[[position]],
      position = position - 1L,
      rawType = raw_type,
      type = ow_r_semantic_type(column),
      nullable = ow_r_column_has_typed_na(column)
    )
    column_metadata[[position]] <- ow_r_column_metadata(column, column_id)
  }

  page_length <- min(limit, row_count - offset)
  rows <- vector("list", page_length)
  row_names <- character(page_length)
  projected_ids <- vapply(column_positions + 1L, function(position) schema[[position]]$id, character(1))
  if (page_length > 0L) {
    for (page_position in seq_len(page_length)) {
      frame_position <- offset + page_position
      values <- lapply(column_positions + 1L, function(position) ow_r_cell_at(frame[[position]], frame_position))
      rows[[page_position]] <- list(
        id = paste0(session_id, ":", frame_position - 1L),
        rowNumber = frame_position - 1L,
        values = values
      )
      row_names[[page_position]] <- ow_r_row_name_at(frame, frame_position)
    }
  }

  result <- list(
    contractVersion = OW_R_FRAME_CONTRACT_VERSION,
    runtimeLanguage = "r",
    frameFlavor = flavor,
    codeDialect = code_dialect,
    shape = list(rows = row_count, columns = column_count),
    schema = schema,
    columnMetadata = column_metadata,
    frameMetadata = ow_r_frame_metadata(frame, flavor),
    page = list(
      offset = offset,
      limit = limit,
      totalRows = row_count,
      columnIds = ow_r_json_array(projected_ids),
      rows = rows
    ),
    rowNames = ow_r_json_array(row_names)
  )
  if (ow_r_character_bytes(result) > OW_R_MAX_CONTRACT_TEXT_BYTES) {
    stop("The native R frame contract exceeds its bounded text payload.")
  }
  result
}

ow_r_validate_scalar_integer <- function(value, field, minimum) {
  if (
    length(value) != 1L ||
      is.na(value) ||
      !is.numeric(value) ||
      !is.finite(value) ||
      value != trunc(value) ||
      value < minimum ||
      value > 2^53 - 1
  ) {
    stop(paste0(field, " must be one finite portable integer at least ", minimum, "."))
  }
}

ow_r_validate_text <- function(value, field, allow_empty) {
  if (length(value) != 1L || is.na(value) || !is.character(value) || (!allow_empty && !nzchar(value))) {
    stop(paste0(field, " must be one non-missing character value."))
  }
  utf8_value <- if (identical(Encoding(value), "bytes")) NA_character_ else iconv(value, from = "", to = "UTF-8", sub = NA_character_)
  if (is.na(utf8_value)) {
    stop(paste0(field, " must be valid UTF-8 text."))
  }
  if (nchar(utf8_value, type = "bytes") > OW_R_MAX_TEXT_BYTES) {
    stop(paste0(field, " exceeds the native R contract text bound."))
  }
  invisible(value)
}

ow_r_validate_text_vector <- function(values, field, allow_empty = TRUE) {
  if (!is.character(values) || anyNA(values)) {
    stop(paste0(field, " must contain only non-missing character values."))
  }
  if (length(values) > OW_R_MAX_TEXT_VECTOR_ITEMS) {
    stop(paste0(field, " exceeds the native R contract item bound."))
  }
  invisible(lapply(values, ow_r_validate_text, field = field, allow_empty = allow_empty))
  utf8_values <- iconv(values, from = "", to = "UTF-8", sub = NA_character_)
  if (anyNA(utf8_values) || sum(nchar(utf8_values, type = "bytes")) > OW_R_MAX_TEXT_VECTOR_BYTES) {
    stop(paste0(field, " exceeds the native R contract aggregate text bound."))
  }
  invisible(values)
}

ow_r_raw_type <- function(column) {
  classes <- class(column)
  class_text <- if (length(classes) > 0L) paste(classes, collapse = "/") else "unclassed"
  paste0(typeof(column), "<", class_text, ">")
}

ow_r_semantic_type <- function(column) {
  classes <- class(column)
  storage_type <- typeof(column)
  if (identical(classes, "integer64")) {
    if (!identical(storage_type, "double")) stop("integer64 columns require double storage.")
    return("integer")
  }
  if (identical(classes, "factor") || identical(classes, c("ordered", "factor"))) {
    if (!identical(storage_type, "integer")) stop("factor columns require integer storage.")
    return("string")
  }
  if (identical(classes, "Date")) {
    if (!identical(storage_type, "double")) stop("Date columns require double storage.")
    return("date")
  }
  if (identical(classes, c("POSIXct", "POSIXt"))) {
    if (!identical(storage_type, "double")) stop("POSIXct columns require double storage.")
    return("datetime")
  }
  if (identical(classes, "difftime")) {
    if (!identical(storage_type, "double")) stop("difftime columns require double storage.")
    return("duration")
  }
  if (identical(classes, "logical") && is.logical(column)) return("boolean")
  if (identical(classes, "integer") && is.integer(column)) return("integer")
  if (identical(classes, "numeric") && is.double(column)) return("float")
  if (identical(classes, "character") && is.character(column)) return("string")
  if (identical(classes, "raw") && is.raw(column)) return("binary")
  if ((identical(classes, "list") || identical(classes, "AsIs")) && is.list(column)) return("list")
  "unknown"
}

ow_r_column_has_typed_na <- function(column) {
  semantic_type <- ow_r_semantic_type(column)
  if (identical(semantic_type, "unknown") || identical(semantic_type, "list")) return(FALSE)
  missing <- tryCatch(is.na(column), error = function(...) rep(FALSE, length(column)))
  if (length(missing) != length(column)) return(FALSE)
  nan <- if (semantic_type %in% c("float", "date", "datetime", "duration")) {
    tryCatch(is.nan(unclass(column)), error = function(...) rep(FALSE, length(column)))
  } else {
    rep(FALSE, length(column))
  }
  any(missing & !nan)
}

ow_r_column_metadata <- function(column, column_id) {
  classes <- as.character(class(column))
  ow_r_validate_text_vector(classes, "column class", allow_empty = FALSE)
  metadata <- list(
    columnId = column_id,
    classNames = ow_r_json_array(classes),
    storageType = typeof(column)
  )
  if (identical(ow_r_semantic_type(column), "string") && (identical(classes, "factor") || identical(classes, c("ordered", "factor")))) {
    factor_levels <- levels(column)
    ow_r_validate_text_vector(factor_levels, "factor level", allow_empty = TRUE)
    if (anyDuplicated(factor_levels)) stop("factor levels must be unique.")
    metadata$levels <- ow_r_json_array(factor_levels)
    metadata$ordered <- is.ordered(column)
  }
  if (identical(classes, c("POSIXct", "POSIXt"))) {
    timezone <- attr(column, "tzone", exact = TRUE)
    if (!is.null(timezone) && (!is.character(timezone) || length(timezone) != 1L || is.na(timezone))) {
      stop("POSIXct time zone metadata must be NULL or one non-missing character value.")
    }
    metadata$timezone <- if (is.null(timezone) || !nzchar(timezone)) "" else timezone
    ow_r_validate_text(metadata$timezone, "POSIXct time zone", allow_empty = TRUE)
  }
  if (identical(classes, "difftime")) {
    metadata$durationUnits <- attr(column, "units", exact = TRUE)
    ow_r_validate_text(metadata$durationUnits, "difftime units", allow_empty = FALSE)
  }
  metadata
}

ow_r_frame_metadata <- function(frame, flavor) {
  classes <- as.character(class(frame))
  ow_r_validate_text_vector(classes, "frame class", allow_empty = FALSE)
  metadata <- list(classNames = ow_r_json_array(classes))
  groups <- attr(frame, "groups", exact = TRUE)
  grouped <- flavor %in% c("grouped-tibble", "rowwise-tibble")
  if (grouped) {
    if (
      !is.data.frame(groups) ||
        anyDuplicated(names(groups)) ||
        !identical(sum(names(groups) == ".rows"), 1L) ||
        !is.list(groups[[".rows"]])
    ) {
      stop("Grouped and rowwise tibbles require canonical groups metadata.")
    }
    group_columns <- setdiff(names(groups), ".rows")
    ow_r_validate_text_vector(group_columns, "group column", allow_empty = TRUE)
    metadata$groupColumns <- ow_r_column_references(frame, group_columns, "group column")
  } else if (!is.null(groups)) {
    stop("Only grouped and rowwise tibbles may carry groups metadata.")
  }
  key_columns <- attr(frame, "sorted", exact = TRUE)
  if (identical(flavor, "data.table")) {
    if (!is.null(key_columns)) {
      if (!is.character(key_columns)) stop("data.table key metadata must be character.")
      ow_r_validate_text_vector(key_columns, "data.table key column", allow_empty = TRUE)
      if (anyDuplicated(key_columns)) stop("data.table key metadata must not repeat a column.")
      metadata$keyColumns <- ow_r_column_references(frame, key_columns, "data.table key column")
    }
  } else if (!is.null(key_columns)) {
    stop("Only data.table values may carry key metadata.")
  }
  metadata
}

ow_r_cell_at <- function(column, position) {
  semantic_type <- ow_r_semantic_type(column)
  if (identical(semantic_type, "unknown")) {
    display <- paste0("<", paste(class(column), collapse = "/"), ">")
    return(list(kind = "unknown", raw = display, display = display, isNull = FALSE, isNaN = FALSE))
  }
  if (identical(semantic_type, "list")) {
    element <- unclass(column)[[position]]
    display <- ow_r_list_display(element)
    return(list(kind = "list", raw = display, display = display, isNull = FALSE, isNaN = FALSE))
  }

  value <- column[position]
  underlying <- unclass(value)
  numeric_special <- semantic_type %in% c("float", "date", "datetime", "duration") &&
    is.double(underlying) && length(underlying) == 1L
  is_nan <- numeric_special && isTRUE(is.nan(underlying))
  is_missing <- isTRUE(tryCatch(is.na(value), error = function(...) FALSE))
  if (is_nan) {
    return(list(kind = "nan", display = "NaN", isNull = FALSE, isNaN = TRUE))
  }
  if (is_missing) return(ow_r_missing_cell())
  if (numeric_special && is.infinite(underlying)) {
    sign <- if (underlying < 0) -1L else 1L
    return(list(
      kind = "infinity",
      display = if (sign < 0) "-Infinity" else "Infinity",
      isNull = FALSE,
      isNaN = FALSE,
      sign = sign
    ))
  }

  classes <- class(column)
  if (identical(classes, "integer64")) {
    display <- as.character(value)
    return(list(kind = "integer", raw = display, display = display, isNull = FALSE, isNaN = FALSE))
  }
  if (identical(classes, "factor") || identical(classes, c("ordered", "factor"))) {
    display <- as.character(value)
    ow_r_validate_text(display, "factor value", allow_empty = TRUE)
    return(list(kind = "string", raw = display, display = display, isNull = FALSE, isNaN = FALSE))
  }
  if (identical(classes, "Date")) {
    display <- format(value, "%Y-%m-%d")
    return(list(kind = "date", raw = display, display = display, isNull = FALSE, isNaN = FALSE))
  }
  if (identical(classes, c("POSIXct", "POSIXt"))) {
    timezone <- attr(column, "tzone", exact = TRUE)
    timezone <- if (is.null(timezone) || length(timezone) < 1L || !nzchar(timezone[[1L]])) "UTC" else timezone[[1L]]
    display <- format(value, "%Y-%m-%dT%H:%M:%OS6%z", tz = timezone)
    display <- sub("([+-][0-9]{2})([0-9]{2})$", "\\1:\\2", display)
    return(list(kind = "datetime", raw = display, display = display, isNull = FALSE, isNaN = FALSE))
  }
  if (identical(classes, "difftime")) {
    seconds <- as.numeric(value, units = "secs")
    display <- as.character(seconds)
    return(list(kind = "duration", raw = seconds, display = display, isNull = FALSE, isNaN = FALSE))
  }
  if (is.logical(column)) {
    scalar <- isTRUE(value)
    return(list(kind = "boolean", raw = scalar, display = if (scalar) "TRUE" else "FALSE", isNull = FALSE, isNaN = FALSE))
  }
  if (is.integer(column)) {
    scalar <- unname(as.integer(value))
    return(list(kind = "integer", raw = scalar, display = as.character(scalar), isNull = FALSE, isNaN = FALSE))
  }
  if (is.numeric(column)) {
    scalar <- unname(as.numeric(value))
    if (is.infinite(scalar)) {
      sign <- if (scalar < 0) -1L else 1L
      return(list(
        kind = "infinity",
        display = if (sign < 0) "-Infinity" else "Infinity",
        isNull = FALSE,
        isNaN = FALSE,
        sign = sign
      ))
    }
    return(list(kind = "number", raw = scalar, display = as.character(scalar), isNull = FALSE, isNaN = FALSE))
  }
  if (is.character(column)) {
    scalar <- unname(as.character(value))
    ow_r_validate_text(scalar, "character value", allow_empty = TRUE)
    return(list(kind = "string", raw = scalar, display = scalar, isNull = FALSE, isNaN = FALSE))
  }
  if (is.raw(column)) {
    display <- paste(format(value), collapse = "")
    return(list(kind = "binary", raw = display, display = display, isNull = FALSE, isNaN = FALSE))
  }

  stop("The native R contract could not encode a recognized column type.")
}

ow_r_missing_cell <- function() {
  list(kind = "null", display = "", isNull = TRUE, isNaN = FALSE)
}

ow_r_row_name_at <- function(frame, position) {
  row_names <- attr(frame, "row.names", exact = TRUE)
  if (
    length(row_names) == 2L &&
      is.na(row_names[[1L]]) &&
      is.numeric(row_names[[2L]]) &&
      row_names[[2L]] < 0
  ) {
    return(as.character(position))
  }
  value <- as.character(row_names[[position]])
  ow_r_validate_text(value, "row name", allow_empty = TRUE)
  value
}

ow_r_json_array <- function(values) {
  unname(as.list(values))
}

ow_r_list_display <- function(element) {
  if (is.null(element)) return("<NULL>")
  classes <- class(element)
  supported_atomic <- any(vapply(
    list("logical", "integer", "numeric", "complex", "character", "raw"),
    function(class_name) identical(classes, class_name),
    logical(1)
  ))
  if (supported_atomic && is.atomic(element) && length(unclass(element)) == 1L) {
    underlying <- unclass(element)
    if (is.double(underlying) && isTRUE(is.nan(underlying))) return("<double[1]: NaN>")
    if (is.double(underlying) && isTRUE(is.infinite(underlying))) {
      return(if (underlying < 0) "<double[1]: -Infinity>" else "<double[1]: Infinity>")
    }
    if (isTRUE(is.na(underlying))) {
      return(paste0("<", typeof(element), "[1]: NA>"))
    }
  }
  paste0("<list-value:", typeof(element), ">")
}

ow_r_column_references <- function(frame, column_names, purpose) {
  frame_names <- names(frame)
  lapply(column_names, function(column_name) {
    positions <- which(frame_names == column_name)
    if (length(positions) != 1L) {
      stop(paste0(purpose, " metadata requires one unambiguous source column."))
    }
    list(id = paste0("r:c:", positions[[1L]] - 1L), name = column_name)
  })
}

ow_r_character_bytes <- function(value) {
  if (is.character(value)) {
    utf8_value <- iconv(value, from = "", to = "UTF-8", sub = NA_character_)
    if (anyNA(utf8_value)) stop("The native R frame contract contains invalid UTF-8 text.")
    return(sum(nchar(utf8_value, type = "bytes")))
  }
  if (!is.list(value)) return(0)
  sum(vapply(value, ow_r_character_bytes, numeric(1)))
}
