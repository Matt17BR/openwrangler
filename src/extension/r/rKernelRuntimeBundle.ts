import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

export const R_KERNEL_RUNTIME_BINDING = ".openwrangler_r_kernel_runtime_872e5b61";
const runtimeOwnerToken = "openwrangler-native-r-runtime-v1";
const defaultTransportOwnerToken = "openwrangler-default-r-transport-v1";
const requiredRuntimeFiles = Object.freeze(["frame_contract.R", "kernel_agent.R"] as const);

export function readRRuntimeFiles(runtimeRoot: string): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      requiredRuntimeFiles.map((name) => [
        name,
        readFileSync(path.join(runtimeRoot, "openwrangler_runtime", name), "utf8")
      ])
    )
  );
}

export function buildRKernelBootstrapCode(
  files: Readonly<Record<string, string>>,
  ownerToken = defaultTransportOwnerToken
): string {
  validateOwnerToken(ownerToken);
  const { ordered, bundleId } = runtimeBundle(files);
  const evaluations = ordered
    .map(
      ([name, source]) => `
    .__ow_source <- rawToChar(jsonlite::base64_dec("${Buffer.from(source, "utf8").toString("base64")}"))
    tryCatch(
      eval(parse(text = .__ow_source, srcfile = NULL, keep.source = FALSE), envir = .__ow_runtime),
      error = function(.__ow_error) stop(sprintf("Open Wrangler could not load ${name}: %s", conditionMessage(.__ow_error)), call. = FALSE)
    )`
    )
    .join("\n");
  return `
local({
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("Open Wrangler requires the jsonlite package in the selected R kernel.", call. = FALSE)
  }
  .__ow_binding <- "${R_KERNEL_RUNTIME_BINDING}"
  .__ow_existing <- if (exists(.__ow_binding, envir = .GlobalEnv, inherits = FALSE)) {
    get(.__ow_binding, envir = .GlobalEnv, inherits = FALSE)
  } else {
    NULL
  }
  if (!is.null(.__ow_existing)) {
    if (!is.environment(.__ow_existing) || !identical(.__ow_existing$ownerToken, "${runtimeOwnerToken}")) {
      stop("Open Wrangler cannot reserve its private R kernel runtime binding.", call. = FALSE)
    }
    if (!identical(.__ow_existing$bundleId, "${bundleId}")) {
      stop("Restart the R kernel before loading this Open Wrangler runtime version.", call. = FALSE)
    }
    if (!is.environment(.__ow_existing$transportOwners)) {
      stop("Restart the R kernel before loading this Open Wrangler runtime version.", call. = FALSE)
    }
    assign("${ownerToken}", TRUE, envir = .__ow_existing$transportOwners)
  } else {
    .__ow_runtime <- new.env(parent = baseenv())
${evaluations}
    .__ow_runtime$agent <- .__ow_runtime$openwrangler_r_kernel_agent$new_agent(
      .__ow_runtime$openwrangler_r_frame_contract,
      .GlobalEnv
    )
    .__ow_runtime$ownerToken <- "${runtimeOwnerToken}"
    .__ow_runtime$bundleId <- "${bundleId}"
    .__ow_runtime$transportOwners <- new.env(parent = emptyenv())
    assign("${ownerToken}", TRUE, envir = .__ow_runtime$transportOwners)
    lockEnvironment(.__ow_runtime, bindings = TRUE)
    assign(.__ow_binding, .__ow_runtime, envir = .GlobalEnv)
  }
})
`;
}

export function buildRKernelTeardownCode(
  files: Readonly<Record<string, string>>,
  ownerToken = defaultTransportOwnerToken
): string {
  validateOwnerToken(ownerToken);
  const { bundleId } = runtimeBundle(files);
  return `
local({
  .__ow_binding <- "${R_KERNEL_RUNTIME_BINDING}"
  if (exists(.__ow_binding, envir = .GlobalEnv, inherits = FALSE)) {
    .__ow_existing <- get(.__ow_binding, envir = .GlobalEnv, inherits = FALSE)
    if (
      is.environment(.__ow_existing) &&
      identical(.__ow_existing$ownerToken, "${runtimeOwnerToken}") &&
      identical(.__ow_existing$bundleId, "${bundleId}") &&
      is.environment(.__ow_existing$transportOwners) &&
      exists("${ownerToken}", envir = .__ow_existing$transportOwners, inherits = FALSE)
    ) {
      if (length(ls(envir = .__ow_existing$transportOwners, all.names = TRUE)) == 1L) {
        if (!is.list(.__ow_existing$agent) || !is.function(.__ow_existing$agent$dispose)) {
          stop("Restart the R kernel before removing this Open Wrangler runtime version.", call. = FALSE)
        }
        .__ow_existing$agent$dispose()
        remove(list = "${ownerToken}", envir = .__ow_existing$transportOwners, inherits = FALSE)
        remove(list = .__ow_binding, envir = .GlobalEnv, inherits = FALSE)
      } else {
        remove(list = "${ownerToken}", envir = .__ow_existing$transportOwners, inherits = FALSE)
      }
    }
  }
})
`;
}

function runtimeBundle(files: Readonly<Record<string, string>>): {
  readonly ordered: readonly (readonly [string, string])[];
  readonly bundleId: string;
} {
  const keys = Object.keys(files).sort();
  if (keys.length !== requiredRuntimeFiles.length || requiredRuntimeFiles.some((name) => !keys.includes(name))) {
    throw new Error("The bundled R kernel runtime is incomplete.");
  }
  if (keys.some((name) => !/^[A-Za-z0-9_]+\.R$/u.test(name) || name.includes(".."))) {
    throw new Error("The bundled R kernel runtime contains an unsafe path.");
  }
  const ordered = requiredRuntimeFiles.map((name) => [name, files[name]!] as const);
  const serialized = JSON.stringify(Object.fromEntries(ordered));
  const bundleId = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  return Object.freeze({ ordered, bundleId });
}

function validateOwnerToken(ownerToken: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(ownerToken)) {
    throw new TypeError("The R kernel runtime owner token is invalid.");
  }
}

export function buildRKernelDispatchCode(payload: string, marker: string): string {
  if (!/^[a-f0-9]{32}$/u.test(marker)) throw new TypeError("R kernel marker must be 32 lowercase hex characters.");
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  return `
local({
  .__ow_runtime <- get("${R_KERNEL_RUNTIME_BINDING}", envir = .GlobalEnv, inherits = FALSE)
  .__ow_payload <- rawToChar(jsonlite::base64_dec("${encoded}"))
  .__ow_response <- .__ow_runtime$agent$dispatch_json(.__ow_payload)
  cat("__OPEN_WRANGLER_R_START_${marker}__\\n", sep = "")
  cat(.__ow_response, "\\n", sep = "")
  cat("__OPEN_WRANGLER_R_END_${marker}__\\n", sep = "")
})
`;
}
