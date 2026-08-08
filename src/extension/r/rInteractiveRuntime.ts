import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { readRRuntimeFiles } from "./rKernelRuntimeBundle";

const R_INTERACTIVE_DISPATCHER_BINDING = ".openwrangler_r_interactive_dispatcher_872e5b61";

export interface RInteractiveDispatchContext {
  readonly runtimeRoot: string;
  readonly ownerToken: string;
  readonly bundleId: string;
  readonly requestPath: string;
  readonly responsePath: string;
  readonly bootstrapDispatcher: boolean;
}

export function rInteractiveRuntimeBundleId(runtimeRoot: string): string {
  const files = readRRuntimeFiles(runtimeRoot);
  const serialized = JSON.stringify({
    "frame_contract.R": files["frame_contract.R"],
    "kernel_agent.R": files["kernel_agent.R"],
    "interactive_agent.R": readFileSync(path.join(runtimeRoot, "openwrangler_runtime", "interactive_agent.R"), "utf8")
  });
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

/**
 * Builds the one-line command sent to the exact R terminal. The first command
 * installs a private dispatcher; later commands contain only a private binding,
 * request ID, and the correlated failure path.
 */
export function buildRInteractiveDispatchCode(context: RInteractiveDispatchContext): string {
  validateContext(context);
  const packagedRuntimeRoot = path.join(context.runtimeRoot, "openwrangler_runtime");
  const agentPath = path.join(packagedRuntimeRoot, "interactive_agent.R");
  const requestId = requestArtifactId(context.requestPath, context.responsePath);
  const ownerBinding = `.openwrangler_r_request_${createHash("sha256")
    .update(context.ownerToken)
    .digest("hex")
    .slice(0, 16)}`;
  const operation = context.bootstrapDispatcher
    ? [
        "base::local({",
        `.__ow_dispatcher_binding <- ${rString(R_INTERACTIVE_DISPATCHER_BINDING)};`,
        ".__ow_dispatcher <- if (base::exists(.__ow_dispatcher_binding, envir = base::globalenv(), inherits = FALSE)) base::get(.__ow_dispatcher_binding, envir = base::globalenv(), inherits = FALSE) else NULL;",
        "if (base::is.null(.__ow_dispatcher)) {",
        ".__ow_dispatcher <- base::new.env(hash = TRUE, parent = base::baseenv());",
        `base::sys.source(${rString(agentPath)}, envir = .__ow_dispatcher, keep.source = FALSE);`,
        `.__ow_dispatcher$bundle_id <- ${rString(context.bundleId)};`,
        "base::lockEnvironment(.__ow_dispatcher, bindings = TRUE);",
        "base::assign(.__ow_dispatcher_binding, .__ow_dispatcher, envir = base::globalenv());",
        "};",
        "if (!base::is.environment(.__ow_dispatcher) || !base::identical(.__ow_dispatcher$bundle_id,",
        `${rString(context.bundleId)})) base::stop("Restart the R session before loading this Open Wrangler runtime version.", call. = FALSE);`,
        ".__ow_dispatcher$openwrangler_r_interactive_agent$register_transport(",
        `owner_token = ${rString(context.ownerToken)},`,
        `runtime_root = ${rString(packagedRuntimeRoot)},`,
        `bundle_id = ${rString(context.bundleId)},`,
        `request_directory = ${rString(path.dirname(context.requestPath))},`,
        `response_directory = ${rString(path.dirname(context.responsePath))},`,
        `command_binding = ${rString(ownerBinding)}`,
        ");",
        `base::get(${rString(ownerBinding)}, envir = base::globalenv(), inherits = FALSE)(${rString(requestId)})`,
        "})"
      ].join("")
    : `base::get(${rString(ownerBinding)}, envir = base::globalenv(), inherits = FALSE)(${rString(requestId)})`;
  return wrapWithCorrelatedFailure(operation, requestId, context.responsePath);
}

function validateContext(context: RInteractiveDispatchContext): void {
  if (!path.isAbsolute(context.runtimeRoot)) throw new TypeError("The R runtime root must be absolute.");
  if (!path.isAbsolute(context.requestPath) || !path.isAbsolute(context.responsePath)) {
    throw new TypeError("R interactive mailbox paths must be absolute.");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(context.ownerToken)) {
    throw new TypeError("The R runtime owner token is invalid.");
  }
  if (!/^[a-f0-9]{16}$/u.test(context.bundleId)) {
    throw new TypeError("The R runtime bundle identity is invalid.");
  }
}

function requestArtifactId(requestPath: string, responsePath: string): string {
  const requestName = path.basename(requestPath);
  const responseName = path.basename(responsePath);
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u.exec(requestName);
  if (!match || responseName !== requestName) {
    throw new TypeError("R interactive mailbox artifacts have an invalid identity.");
  }
  return match[1]!;
}

function wrapWithCorrelatedFailure(operation: string, requestId: string, responsePath: string): string {
  const payload = JSON.stringify({
    transportVersion: 9,
    requestId,
    kind: "error",
    code: "runtime_error",
    message: "The interactive R dispatcher is unavailable. Restart R and reopen the dataframe.",
    recoverable: false
  });
  return [
    "base::tryCatch({",
    operation,
    "},error=function(.__ow_error)base::local({",
    `.__ow_response_path <- ${rString(responsePath)};`,
    '.__ow_temporary <- base::paste0(.__ow_response_path, ".tmp");',
    `base::writeLines(${rString(payload)}, .__ow_temporary, useBytes = TRUE);`,
    'if (!base::file.rename(.__ow_temporary, .__ow_response_path)) base::stop("Open Wrangler could not publish its interactive R dispatcher failure.", call. = FALSE)',
    "}));base::invisible(NULL)"
  ].join("");
}

function rString(value: string): string {
  if (value.includes("\0")) throw new TypeError("R code cannot contain a NUL path component.");
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}
