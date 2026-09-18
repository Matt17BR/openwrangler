export const R_DEPENDENCY_DIAGNOSTIC_PREFIX = "Open Wrangler Native R dependency check: ";
export const R_DEPENDENCY_FAILURE_CLASS = "openwrangler_native_r_dependency_error";

export type RDependencyEnvironment = "selected R kernel" | "active R session" | "selected Rscript";

export const R_DEPENDENCY_PACKAGE_NAMES = Object.freeze([
  "jsonlite",
  "rlang",
  "arrow",
  "nanoparquet",
  "clock",
  "bit64",
  "readxl",
  "data.table",
  "dplyr",
  "collapse"
] as const);

export interface RDependencyRequirement {
  readonly packageName: (typeof R_DEPENDENCY_PACKAGE_NAMES)[number];
  readonly minimumVersion?: string;
  readonly observedVersion?: string;
  readonly namespaceAvailable: boolean;
  readonly missingExports?: readonly string[];
}

export class RDependencyError extends Error {
  constructor(
    message: string,
    readonly requirements: readonly RDependencyRequirement[]
  ) {
    super(message);
    this.name = "RDependencyError";
  }
}

export function decodeRDependencyRequirements(value: unknown): readonly RDependencyRequirement[] {
  function fail(): never {
    throw new TypeError("Open Wrangler received malformed R dependency requirements.");
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > R_DEPENDENCY_PACKAGE_NAMES.length) fail();
  const packages = new Set<string>();
  const fields = ["packageName", "minimumVersion", "observedVersion", "namespaceAvailable", "missingExports"];
  return Object.freeze(
    value.map((candidate: unknown): RDependencyRequirement => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) fail();
      const record = candidate as Record<string, unknown>;
      if (
        Object.keys(record).some((field) => !fields.includes(field)) ||
        typeof record.packageName !== "string" ||
        !R_DEPENDENCY_PACKAGE_NAMES.some((name) => name === record.packageName) ||
        packages.has(record.packageName) ||
        typeof record.namespaceAvailable !== "boolean"
      )
        fail();
      packages.add(record.packageName);
      for (const key of ["minimumVersion", "observedVersion"] as const) {
        if (
          Object.hasOwn(record, key) &&
          (typeof record[key] !== "string" || !/^[0-9][0-9A-Za-z.+-]{0,63}$/u.test(record[key]))
        )
          fail();
      }
      let missingExports: readonly string[] | undefined;
      if (Object.hasOwn(record, "missingExports")) {
        const exports = record.missingExports;
        if (
          !Array.isArray(exports) ||
          exports.length < 1 ||
          exports.length > 32 ||
          exports.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z.][A-Za-z0-9._]{0,127}$/u.test(name)) ||
          new Set(exports).size !== exports.length
        )
          fail();
        missingExports = Object.freeze([...exports]);
      }
      return Object.freeze({
        packageName: record.packageName as RDependencyRequirement["packageName"],
        namespaceAvailable: record.namespaceAvailable,
        ...(record.minimumVersion === undefined ? {} : { minimumVersion: record.minimumVersion as string }),
        ...(record.observedVersion === undefined ? {} : { observedVersion: record.observedVersion as string }),
        ...(missingExports === undefined ? {} : { missingExports })
      });
    })
  );
}

export const R_CORE_DEPENDENCY_REQUIREMENTS = Object.freeze([
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

/** Startup failures and dependency probes must serialize before jsonlite is available. */
export function buildRDependencySerializationCode(): string {
  return String.raw`
.__ow_dependency_json_string <- function(value) {
  encoded <- base::vapply(base::utf8ToInt(base::enc2utf8(value)), function(code) {
    if (code == 34L) return('\\"')
    if (code == 92L) return('\\\\')
    if (code < 32L) return(base::sprintf("\\u%04x", code))
    base::intToUtf8(code)
  }, base::character(1L))
  base::paste0('"', base::paste(encoded, collapse = ""), '"')
}
.__ow_dependency_requirements_json <- function(requirements) {
  values <- base::vapply(requirements, function(requirement) {
    base::paste0(
      '{"packageName":', .__ow_dependency_json_string(requirement$packageName),
      ',"namespaceAvailable":', if (requirement$namespaceAvailable) "true" else "false",
      if (!base::is.null(requirement$minimumVersion)) base::paste0(
        ',"minimumVersion":', .__ow_dependency_json_string(requirement$minimumVersion)
      ) else "",
      if (!base::is.null(requirement$observedVersion)) base::paste0(
        ',"observedVersion":', .__ow_dependency_json_string(requirement$observedVersion)
      ) else "",
      if (!base::is.null(requirement$missingExports)) base::paste0(
        ',"missingExports":[', base::paste(base::vapply(requirement$missingExports,
          .__ow_dependency_json_string, base::character(1L)), collapse = ","), "]"
      ) else "",
      "}"
    )
  }, base::character(1L))
  base::paste0("[", base::paste(values, collapse = ","), "]")
}
`;
}

/** Defines the pure-R decision separately so version floors can be exercised without fake installed packages. */
export function buildRDependencyCheckFunctionCode(): string {
  return `
.__ow_dependency_fail <- function(.__ow_message, .__ow_requirement) {
  base::stop(base::structure(
    base::list(message = .__ow_message, call = NULL, requirements = base::list(.__ow_requirement)),
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

  .__ow_facts <- base::list(
    packageName = .__ow_requirement$package,
    minimumVersion = .__ow_requirement$minimum,
    namespaceAvailable = .__ow_namespace_available
  )
  if (!base::is.null(.__ow_observed)) .__ow_facts$observedVersion <- .__ow_observed
  if (base::length(.__ow_missing_exports) > 0L) .__ow_facts$missingExports <- .__ow_missing_exports

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
    ), .__ow_facts)
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
  ), .__ow_facts)
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
  const checks = R_CORE_DEPENDENCY_REQUIREMENTS.map(
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
