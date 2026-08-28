export const R_DEPENDENCY_DIAGNOSTIC_PREFIX = "Open Wrangler Native R dependency check: ";
export const R_DEPENDENCY_FAILURE_CLASS = "openwrangler_native_r_dependency_error";

export type RDependencyEnvironment = "selected R kernel" | "active R session" | "selected Rscript";

const requirements = Object.freeze([
  Object.freeze({
    packageName: "jsonlite",
    minimumVersion: "1.0",
    exports: Object.freeze(["toJSON", "fromJSON", "base64_enc", "base64_dec"])
  }),
  Object.freeze({
    packageName: "rlang",
    minimumVersion: "0.4.5",
    exports: Object.freeze(["env_binding_are_lazy"])
  })
]);

/** Defines the pure-R decision separately so version floors can be exercised without fake installed packages. */
export function buildRDependencyCheckFunctionCode(): string {
  return `
.__ow_dependency_fail <- function(.__ow_message) {
  base::stop(base::structure(
    base::list(message = .__ow_message, call = NULL),
    class = base::c("${R_DEPENDENCY_FAILURE_CLASS}", "error", "condition")
  ))
}
.__ow_validate_native_r_dependency <- function(
  .__ow_requirement,
  .__ow_environment,
  .__ow_namespace_available,
  .__ow_observed,
  .__ow_exports
) {
  .__ow_version_ok <- !base::is.null(.__ow_observed) && base::isTRUE(base::tryCatch(
    utils::compareVersion(.__ow_observed, .__ow_requirement$minimum) >= 0L,
    error = function(.__ow_error) FALSE
  ))
  .__ow_missing_exports <- if (.__ow_namespace_available) {
    base::setdiff(.__ow_requirement$exports, .__ow_exports)
  } else {
    base::character()
  }
  if (.__ow_namespace_available && .__ow_version_ok && base::length(.__ow_missing_exports) == 0L) {
    return(base::invisible(TRUE))
  }

  .__ow_required <- base::sprintf(
    "%s >= %s with exported %s",
    .__ow_requirement$package,
    .__ow_requirement$minimum,
    base::paste(.__ow_requirement$exports, collapse = ", ")
  )
  .__ow_repair <- base::sprintf("install.packages('%s')", .__ow_requirement$package)
  if (!.__ow_namespace_available && base::is.null(.__ow_observed)) {
    .__ow_dependency_fail(base::sprintf(
      "%s%s is not installed in %s. Required: %s. Install it with %s in that environment, then try again.",
      "${R_DEPENDENCY_DIAGNOSTIC_PREFIX}",
      .__ow_requirement$package,
      .__ow_environment,
      .__ow_required,
      .__ow_repair
    ))
  }

  .__ow_observed_text <- if (base::is.null(.__ow_observed)) "unavailable" else .__ow_observed
  .__ow_capability_text <- if (base::length(.__ow_missing_exports) == 0L) {
    ""
  } else {
    base::sprintf(" Missing exported: %s.", base::paste(.__ow_missing_exports, collapse = ", "))
  }
  .__ow_namespace_text <- if (.__ow_namespace_available) "" else " Its namespace could not be loaded."
  .__ow_dependency_fail(base::sprintf(
    "%s%s is installed but incompatible in %s. Observed version: %s. Required: %s.%s%s Install it with %s in that environment, then try again.",
    "${R_DEPENDENCY_DIAGNOSTIC_PREFIX}",
    .__ow_requirement$package,
    .__ow_environment,
    .__ow_observed_text,
    .__ow_required,
    .__ow_namespace_text,
    .__ow_capability_text,
    .__ow_repair
  ))
}
.__ow_check_native_r_dependency <- function(.__ow_requirement, .__ow_environment) {
  .__ow_namespace_available <- base::isTRUE(base::tryCatch(
    base::requireNamespace(.__ow_requirement$package, quietly = TRUE),
    error = function(.__ow_error) FALSE
  ))
  .__ow_observed <- if (.__ow_namespace_available) {
    base::tryCatch(
      base::as.character(base::getNamespaceVersion(.__ow_requirement$package)),
      error = function(.__ow_error) NULL
    )
  } else {
    base::tryCatch(
      base::as.character(utils::packageVersion(.__ow_requirement$package)),
      error = function(.__ow_error) NULL
    )
  }
  .__ow_exports <- if (.__ow_namespace_available) {
    base::tryCatch(
      base::getNamespaceExports(.__ow_requirement$package),
      error = function(.__ow_error) base::character()
    )
  } else {
    base::character()
  }
  .__ow_validate_native_r_dependency(
    .__ow_requirement,
    .__ow_environment,
    .__ow_namespace_available,
    .__ow_observed,
    .__ow_exports
  )
}
`;
}

export function buildRDependencyPreflightCode(environment: RDependencyEnvironment): string {
  const checks = requirements.map(
    (requirement) => `.__ow_check_native_r_dependency(
  base::list(
    package = ${JSON.stringify(requirement.packageName)},
    minimum = ${JSON.stringify(requirement.minimumVersion)},
    exports = base::c(${requirement.exports.map((name) => JSON.stringify(name)).join(", ")})
  ),
  .__ow_dependency_environment
)`
  );
  return `${buildRDependencyCheckFunctionCode()}
.__ow_dependency_environment <- base::sprintf(
  "the ${environment} environment (R %s at %s)",
  base::as.character(base::getRversion()),
  base::R.home()
)
.__ow_dependency_environment <- base::substr(
  base::gsub("[^ -~]", "?", .__ow_dependency_environment, perl = TRUE),
  1L,
  512L
)
${checks.join("\n")}
`;
}
