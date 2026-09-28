convert_type_contract <- jsonlite::fromJSON("fixtures/convert-type-contract.json", simplifyVector = FALSE)

convert_type_values <- function(values, type) {
  number <- function(value) {
    if (!is.character(value)) return(as.double(value))
    switch(value, "NaN" = NaN, "Infinity" = Inf, "-Infinity" = -Inf, "-0" = -0, stop("unknown fixture number"))
  }
  switch(type,
    string = vapply(values, function(value) if (is.null(value)) NA_character_ else value, character(1L)),
    boolean = vapply(values, function(value) if (is.null(value)) NA else value, logical(1L)),
    integer = vapply(values, function(value) if (is.null(value)) NA_integer_ else as.integer(value), integer(1L)),
    float = vapply(values, function(value) if (is.null(value)) NA_real_ else number(value), double(1L)),
    stop(sprintf("R has no %s column type", type))
  )
}

convert_type_r_cases <- Filter(function(case) !identical(case$source, "decimal"), convert_type_contract$cases)

convert_type_r_inputs <- function(case) {
  values <- convert_type_values(case$values, case$source)
  switch(case$source,
    string = list(values, factor(values)),
    integer = list(values, bit64::as.integer64(values)),
    list(values)
  )
}
