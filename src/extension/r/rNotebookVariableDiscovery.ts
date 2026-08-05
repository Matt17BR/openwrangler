import { randomUUID } from "node:crypto";
import type { Jupyter, Kernel } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS } from "../configuration";
import { withKernelTimeout } from "../notebooks/kernelLifecycle";
import { isSoleOpenNotebookDocument } from "../notebooks/notebookProvenance";
import type { RDataframeFlavor } from "./rFrameContract";

const R_DISCOVERY_PROTOCOL_VERSION = 1;
const MAX_DISCOVERY_VARIABLES = 256;
const MAX_DISCOVERY_SCANNED_BINDINGS = 4_096;
const MAX_DISCOVERY_NAME_BYTES = 1_024;
const MAX_DISCOVERY_OUTPUT_BYTES = 64 * 1_024;
const MAX_DISCOVERY_PAYLOAD_BYTES = 60 * 1_024;
const MAX_DISCOVERY_ERROR_BYTES = 4 * 1_024;
const MAX_DISCOVERY_OUTPUTS = 128;
const MAX_DISCOVERY_OUTPUT_ITEMS = 256;

interface RNotebookVariableDiscoveryReceipt {
  readonly notebook: vscode.NotebookDocument;
  readonly jupyter: Jupyter;
  readonly kernel: Kernel;
}

const discoveryReceipts = new WeakMap<RNotebookVariableDiscovery, RNotebookVariableDiscoveryReceipt>();

export interface RNotebookVariableDescriptor {
  readonly name: string;
  readonly backend: "r";
  readonly dataframeFlavor: RDataframeFlavor;
}

export interface RNotebookVariableDiscovery {
  readonly variables: readonly RNotebookVariableDescriptor[];
  readonly truncated: boolean;
}

export class RNotebookVariableDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RNotebookVariableDiscoveryError";
  }
}

/**
 * Inspects only the exact R kernel selected for the captured notebook.
 * Discovery never cancels an execution because Jupyter implements token
 * cancellation as a whole-kernel interrupt.
 */
export async function discoverRNotebookVariables(
  notebook: vscode.NotebookDocument
): Promise<RNotebookVariableDiscovery> {
  try {
    const { jupyter, kernel } = await revalidateAfter(resolveRNotebookKernel(notebook), notebook);
    const discovery = await revalidateAfter(executeDiscovery(jupyter, kernel, notebook), notebook);
    discoveryReceipts.set(discovery, Object.freeze({ notebook, jupyter, kernel }));
    return discovery;
  } catch (error) {
    if (error instanceof RNotebookVariableDiscoveryError) throw error;
    throw new RNotebookVariableDiscoveryError(
      "Open Wrangler could not inspect dataframe variables in the selected R notebook kernel."
    );
  }
}

/**
 * Rechecks the exact kernel and variable selected from a completed discovery.
 * Call this after any user interaction that awaited a selection and before
 * dispatching work to the kernel.
 */
export async function verifyRNotebookVariableSelection(
  notebook: vscode.NotebookDocument,
  discovery: RNotebookVariableDiscovery,
  selected: RNotebookVariableDescriptor
): Promise<void> {
  const receipt = discoveryReceipts.get(discovery);
  const discovered = discovery.variables.find(
    (candidate) => candidate.name === selected.name && candidate.dataframeFlavor === selected.dataframeFlavor
  );
  if (!receipt || receipt.notebook !== notebook || !discovered || selected.backend !== "r") {
    throw new RNotebookVariableDiscoveryError(
      "The selected R dataframe no longer belongs to this variable list. Open the picker again."
    );
  }

  try {
    assertNotebookAccess(notebook);
    const current = await revalidateAfter(
      executeSelectionProbe(receipt.jupyter, receipt.kernel, notebook, discovered),
      notebook
    );
    const currentVariable = current.variables[0];
    if (
      current.variables.length !== 1 ||
      currentVariable?.name !== discovered.name ||
      currentVariable.dataframeFlavor !== discovered.dataframeFlavor
    ) {
      throw changedVariableSelection();
    }
  } catch (error) {
    if (error instanceof RNotebookVariableDiscoveryError) throw error;
    throw changedVariableSelection();
  }
}

export function buildRNotebookVariableDiscoveryCode(marker: string): string {
  if (!/^[a-f0-9]{32}$/u.test(marker)) {
    throw new Error("R notebook variable discovery marker must be 32 lowercase hexadecimal characters.");
  }

  return `
local({
  .ow_protocol_version <- ${R_DISCOVERY_PROTOCOL_VERSION}L
  .ow_max_variables <- ${MAX_DISCOVERY_VARIABLES}L
  .ow_max_scanned_bindings <- ${MAX_DISCOVERY_SCANNED_BINDINGS}L
  .ow_max_name_bytes <- ${MAX_DISCOVERY_NAME_BYTES}L
  .ow_max_payload_bytes <- ${MAX_DISCOVERY_PAYLOAD_BYTES}L
  .ow_source <- .GlobalEnv
  .ow_names <- sort(
    ls(envir = .ow_source, all.names = TRUE, sorted = FALSE),
    method = "radix"
  )
  .ow_truncated <- length(.ow_names) > .ow_max_scanned_bindings
  if (.ow_truncated) {
    .ow_names <- .ow_names[seq_len(.ow_max_scanned_bindings)]
  }
  .ow_variables <- list()
  .ow_failed_binding <- new.env(parent = emptyenv())

  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    cat("__OPEN_WRANGLER_R_VARIABLES_START_${marker}__\\n", sep = "")
    cat('{"protocolVersion":1,"error":"missing_jsonlite"}\\n', sep = "")
    cat("__OPEN_WRANGLER_R_VARIABLES_END_${marker}__\\n", sep = "")
    return(invisible(NULL))
  }
  if (!requireNamespace("rlang", quietly = TRUE)) {
    cat("__OPEN_WRANGLER_R_VARIABLES_START_${marker}__\\n", sep = "")
    cat('{"protocolVersion":1,"error":"missing_rlang"}\\n', sep = "")
    cat("__OPEN_WRANGLER_R_VARIABLES_END_${marker}__\\n", sep = "")
    return(invisible(NULL))
  }

  for (.ow_name in .ow_names) {
    if (bindingIsActive(.ow_name, .ow_source)) {
      next
    }
    .ow_is_lazy <- tryCatch(
      rlang::env_binding_are_lazy(.ow_source, .ow_name)[[1L]],
      error = function(.ow_error) TRUE
    )
    if (!identical(.ow_is_lazy, FALSE)) {
      next
    }
    .ow_utf8_name <- iconv(.ow_name, from = "", to = "UTF-8", sub = NA_character_)
    if (
      is.na(.ow_utf8_name) ||
        identical(.ow_utf8_name, "") ||
        nchar(.ow_utf8_name, type = "bytes") > .ow_max_name_bytes ||
        grepl("[[:cntrl:]]", .ow_utf8_name, perl = TRUE)
    ) {
      next
    }
    .ow_value <- tryCatch(
      get(.ow_name, envir = .ow_source, inherits = FALSE),
      error = function(.ow_error) .ow_failed_binding
    )
    if (identical(.ow_value, .ow_failed_binding)) {
      next
    }
    .ow_classes <- class(.ow_value)
    .ow_flavor <- if (identical(.ow_classes, c("data.table", "data.frame"))) {
      "r.data.table"
    } else if (identical(.ow_classes, c("tbl_df", "tbl", "data.frame"))) {
      "r.tibble"
    } else if (identical(.ow_classes, "data.frame")) {
      "r.data.frame"
    } else {
      NULL
    }
    if (is.null(.ow_flavor)) {
      next
    }
    if (length(.ow_variables) >= .ow_max_variables) {
      .ow_truncated <- TRUE
      break
    }
    .ow_variables[[length(.ow_variables) + 1L]] <- list(
      name = .ow_utf8_name,
      dataframeFlavor = .ow_flavor
    )
  }

  if (length(.ow_variables) > 1L) {
    .ow_order <- order(
      vapply(.ow_variables, function(.ow_item) .ow_item$name, character(1L), USE.NAMES = FALSE),
      method = "radix"
    )
    .ow_variables <- .ow_variables[.ow_order]
  }

  .ow_encode <- function() {
    as.character(jsonlite::toJSON(
      list(
        protocolVersion = .ow_protocol_version,
        truncated = .ow_truncated,
        variables = .ow_variables
      ),
      auto_unbox = TRUE,
      digits = NA,
      na = "null",
      null = "null",
      pretty = FALSE
    ))
  }
  .ow_payload <- .ow_encode()
  while (nchar(.ow_payload, type = "bytes") > .ow_max_payload_bytes && length(.ow_variables) > 0L) {
    .ow_truncated <- TRUE
    .ow_variables <- .ow_variables[-length(.ow_variables)]
    .ow_payload <- .ow_encode()
  }
  if (nchar(.ow_payload, type = "bytes") > .ow_max_payload_bytes) {
    stop("Open Wrangler R variable discovery exceeded its output limit.", call. = FALSE)
  }

  cat("__OPEN_WRANGLER_R_VARIABLES_START_${marker}__\\n", sep = "")
  cat(.ow_payload, "\\n", sep = "")
  cat("__OPEN_WRANGLER_R_VARIABLES_END_${marker}__\\n", sep = "")
})
`;
}

function buildRNotebookVariableSelectionProbeCode(marker: string, selected: RNotebookVariableDescriptor): string {
  if (!/^[a-f0-9]{32}$/u.test(marker) || !isBoundedVariableName(selected.name)) {
    throw new Error("R notebook variable selection probe received invalid input.");
  }

  return `
local({
  .ow_protocol_version <- ${R_DISCOVERY_PROTOCOL_VERSION}L
  .ow_max_payload_bytes <- ${MAX_DISCOVERY_PAYLOAD_BYTES}L
  .ow_source <- .GlobalEnv
  .ow_name <- ${JSON.stringify(selected.name)}
  .ow_variables <- list()
  .ow_failed_binding <- new.env(parent = emptyenv())

  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    cat("__OPEN_WRANGLER_R_VARIABLES_START_${marker}__\\n", sep = "")
    cat('{"protocolVersion":1,"error":"missing_jsonlite"}\\n', sep = "")
    cat("__OPEN_WRANGLER_R_VARIABLES_END_${marker}__\\n", sep = "")
    return(invisible(NULL))
  }
  if (!requireNamespace("rlang", quietly = TRUE)) {
    cat("__OPEN_WRANGLER_R_VARIABLES_START_${marker}__\\n", sep = "")
    cat('{"protocolVersion":1,"error":"missing_rlang"}\\n', sep = "")
    cat("__OPEN_WRANGLER_R_VARIABLES_END_${marker}__\\n", sep = "")
    return(invisible(NULL))
  }

  if (
    exists(.ow_name, envir = .ow_source, inherits = FALSE) &&
      !bindingIsActive(.ow_name, .ow_source)
  ) {
    .ow_is_lazy <- tryCatch(
      rlang::env_binding_are_lazy(.ow_source, .ow_name)[[1L]],
      error = function(.ow_error) TRUE
    )
    if (identical(.ow_is_lazy, FALSE)) {
      .ow_value <- tryCatch(
        get(.ow_name, envir = .ow_source, inherits = FALSE),
        error = function(.ow_error) .ow_failed_binding
      )
      if (!identical(.ow_value, .ow_failed_binding)) {
        .ow_classes <- class(.ow_value)
        .ow_flavor <- if (identical(.ow_classes, c("data.table", "data.frame"))) {
          "r.data.table"
        } else if (identical(.ow_classes, c("tbl_df", "tbl", "data.frame"))) {
          "r.tibble"
        } else if (identical(.ow_classes, "data.frame")) {
          "r.data.frame"
        } else {
          NULL
        }
        if (!is.null(.ow_flavor)) {
          .ow_variables[[1L]] <- list(name = .ow_name, dataframeFlavor = .ow_flavor)
        }
      }
    }
  }

  .ow_payload <- as.character(jsonlite::toJSON(
    list(
      protocolVersion = .ow_protocol_version,
      truncated = FALSE,
      variables = .ow_variables
    ),
    auto_unbox = TRUE,
    digits = NA,
    na = "null",
    null = "null",
    pretty = FALSE
  ))
  if (nchar(.ow_payload, type = "bytes") > .ow_max_payload_bytes) {
    stop("Open Wrangler R variable selection probe exceeded its output limit.", call. = FALSE)
  }

  cat("__OPEN_WRANGLER_R_VARIABLES_START_${marker}__\\n", sep = "")
  cat(.ow_payload, "\\n", sep = "")
  cat("__OPEN_WRANGLER_R_VARIABLES_END_${marker}__\\n", sep = "")
})
`;
}

export function parseRNotebookVariableDiscoveryOutput(output: string, marker: string): RNotebookVariableDiscovery {
  if (!/^[a-f0-9]{32}$/u.test(marker) || Buffer.byteLength(output, "utf8") > MAX_DISCOVERY_OUTPUT_BYTES) {
    throw oversizedDiscoveryResponse();
  }

  const start = `__OPEN_WRANGLER_R_VARIABLES_START_${marker}__`;
  const end = `__OPEN_WRANGLER_R_VARIABLES_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end);
  if (
    startIndex < 0 ||
    endIndex <= startIndex ||
    output.indexOf(start, startIndex + start.length) >= 0 ||
    output.indexOf(end, endIndex + end.length) >= 0
  ) {
    throw malformedDiscoveryResponse();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(startIndex + start.length, endIndex).trim()) as unknown;
  } catch {
    throw malformedDiscoveryResponse();
  }
  if (
    isPlainRecord(parsed) &&
    hasExactKeys(parsed, ["error", "protocolVersion"]) &&
    parsed.protocolVersion === R_DISCOVERY_PROTOCOL_VERSION
  ) {
    if (parsed.error === "missing_jsonlite") {
      throw missingRPackage("jsonlite");
    }
    if (parsed.error === "missing_rlang") {
      throw missingRPackage("rlang");
    }
    throw malformedDiscoveryResponse();
  }
  if (
    !isPlainRecord(parsed) ||
    !hasExactKeys(parsed, ["protocolVersion", "truncated", "variables"]) ||
    parsed.protocolVersion !== R_DISCOVERY_PROTOCOL_VERSION ||
    typeof parsed.truncated !== "boolean" ||
    !Array.isArray(parsed.variables) ||
    parsed.variables.length > MAX_DISCOVERY_VARIABLES
  ) {
    throw malformedDiscoveryResponse();
  }

  const names = new Set<string>();
  const variables = parsed.variables.map((candidate): RNotebookVariableDescriptor => {
    if (
      !isPlainRecord(candidate) ||
      !hasExactKeys(candidate, ["dataframeFlavor", "name"]) ||
      !isBoundedVariableName(candidate.name) ||
      !isRDataframeFlavor(candidate.dataframeFlavor) ||
      names.has(candidate.name)
    ) {
      throw malformedDiscoveryResponse();
    }
    names.add(candidate.name);
    return Object.freeze({
      name: candidate.name,
      backend: "r" as const,
      dataframeFlavor: candidate.dataframeFlavor
    });
  });
  variables.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return Object.freeze({ variables: Object.freeze(variables), truncated: parsed.truncated });
}

async function resolveRNotebookKernel(
  notebook: vscode.NotebookDocument
): Promise<{ readonly jupyter: Jupyter; readonly kernel: Kernel }> {
  assertNotebookAccess(notebook);

  const extension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  if (!extension) {
    throw new RNotebookVariableDiscoveryError(
      "Install or enable the VS Code Jupyter extension to inspect live R dataframes."
    );
  }
  const jupyter = await revalidateAfter(extension.activate(), notebook);
  if (!isJupyterApi(jupyter)) {
    throw new RNotebookVariableDiscoveryError("Open Wrangler could not access the public Jupyter kernel API.");
  }
  const kernel = await revalidateAfter(jupyter.kernels.getKernel(notebook.uri), notebook);
  if (!isKernel(kernel)) {
    throw new RNotebookVariableDiscoveryError(
      "Select or start an R kernel, run the cell that defines the dataframe, and try again."
    );
  }
  if (kernel.language.toLowerCase() !== "r") {
    throw new RNotebookVariableDiscoveryError(
      `Open Wrangler requires an R notebook kernel; the selected kernel uses ${kernel.language}.`
    );
  }
  return Object.freeze({ jupyter, kernel });
}

async function executeDiscovery(
  jupyter: Jupyter,
  kernel: Kernel,
  notebook: vscode.NotebookDocument
): Promise<RNotebookVariableDiscovery> {
  return executeProbe(jupyter, kernel, notebook, buildRNotebookVariableDiscoveryCode);
}

async function executeSelectionProbe(
  jupyter: Jupyter,
  kernel: Kernel,
  notebook: vscode.NotebookDocument,
  selected: RNotebookVariableDescriptor
): Promise<RNotebookVariableDiscovery> {
  return executeProbe(jupyter, kernel, notebook, (marker) =>
    buildRNotebookVariableSelectionProbeCode(marker, selected)
  );
}

async function executeProbe(
  jupyter: Jupyter,
  kernel: Kernel,
  notebook: vscode.NotebookDocument,
  buildCode: (marker: string) => string
): Promise<RNotebookVariableDiscovery> {
  const marker = randomUUID().replaceAll("-", "");
  const tokenSource = new vscode.CancellationTokenSource();
  const completion = (async () => {
    assertNotebookAccess(notebook);
    const selectedBeforeDispatch = await revalidateAfter(jupyter.kernels.getKernel(notebook.uri), notebook);
    assertSelectedKernel(selectedBeforeDispatch, kernel);
    const output = kernel.executeCode(buildCode(marker), tokenSource.token);
    const text = await revalidateAfter(collectBoundedKernelText(output, notebook), notebook);
    const selectedKernel = await revalidateAfter(jupyter.kernels.getKernel(notebook.uri), notebook);
    assertSelectedKernel(selectedKernel, kernel);
    return parseRNotebookVariableDiscoveryOutput(text, marker);
  })().finally(() => tokenSource.dispose());
  void completion.catch(() => undefined);
  return withKernelTimeout(completion, DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS, () => undefined);
}

async function collectBoundedKernelText(
  output: ReturnType<Kernel["executeCode"]>,
  notebook: vscode.NotebookDocument
): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  let outputCount = 0;
  let itemCount = 0;
  let firstFailure: { readonly error: unknown } | undefined;
  const iterator = output[Symbol.asyncIterator]();
  while (true) {
    let next: IteratorResult<unknown>;
    try {
      next = await iterator.next();
    } catch (error) {
      firstFailure ??= { error };
      break;
    }

    if (!firstFailure) {
      try {
        // Keep draining the dispatched iterator after a provenance failure,
        // but never inspect or retain output from a replacement document.
        assertNotebookAccess(notebook);
        if (!next.done) {
          outputCount += 1;
          if (outputCount > MAX_DISCOVERY_OUTPUTS || !isKernelOutput(next.value)) {
            throw oversizedOrMalformed(next.value);
          }
          itemCount += next.value.items.length;
          if (next.value.items.length > MAX_DISCOVERY_OUTPUT_ITEMS || itemCount > MAX_DISCOVERY_OUTPUT_ITEMS) {
            throw oversizedDiscoveryResponse();
          }
          for (const item of next.value.items) {
            if (!isKernelOutputItem(item)) throw malformedDiscoveryResponse();
            bytes += item.data.byteLength;
            if (bytes > MAX_DISCOVERY_OUTPUT_BYTES) throw oversizedDiscoveryResponse();
            if (item.mime === "application/vnd.code.notebook.error") {
              throw notebookKernelError(item.data);
            }
            if (!isKernelTextMime(item.mime)) continue;
            chunks.push(Buffer.from(item.data.buffer, item.data.byteOffset, item.data.byteLength).toString("utf8"));
          }
        }
      } catch (error) {
        firstFailure = { error };
        chunks.length = 0;
      }
    }
    if (next.done) break;
  }
  if (firstFailure) throw firstFailure.error;
  return chunks.join("");
}

function assertNotebookAccess(notebook: vscode.NotebookDocument): void {
  if (!vscode.workspace.isTrusted) {
    throw new RNotebookVariableDiscoveryError("Trust this workspace before Open Wrangler inspects an R kernel.");
  }
  if (!isSoleOpenNotebookDocument(notebook)) {
    throw new RNotebookVariableDiscoveryError("The originating notebook is no longer open. Reopen it and try again.");
  }
}

async function revalidateAfter<T>(value: PromiseLike<T>, notebook: vscode.NotebookDocument): Promise<T> {
  const result = await value;
  assertNotebookAccess(notebook);
  return result;
}

function assertSelectedKernel(selected: Kernel | undefined, expected: Kernel): void {
  if (selected !== expected) {
    throw new RNotebookVariableDiscoveryError(
      "The selected R notebook kernel changed while Open Wrangler inspected its variables. Try again."
    );
  }
}

function isJupyterApi(value: unknown): value is Jupyter {
  if (typeof value !== "object" || value === null) return false;
  const kernels = (value as { kernels?: unknown }).kernels;
  return (
    typeof kernels === "object" &&
    kernels !== null &&
    typeof (kernels as { getKernel?: unknown }).getKernel === "function"
  );
}

function isKernel(value: unknown): value is Kernel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { executeCode?: unknown; language?: unknown };
  return typeof candidate.executeCode === "function" && typeof candidate.language === "string";
}

function isKernelOutput(value: unknown): value is { readonly items: readonly unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items);
}

function isKernelOutputItem(value: unknown): value is { readonly mime: string; readonly data: Uint8Array } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { mime?: unknown; data?: unknown };
  return typeof candidate.mime === "string" && ArrayBuffer.isView(candidate.data);
}

function isKernelTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/x.notebook.stream.stdout" ||
    mime === "application/x.notebook.stream.stderr" ||
    mime === "application/vnd.code.notebook.stdout" ||
    mime === "application/vnd.code.notebook.stderr"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isBoundedVariableName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !hasControlCharacter(value) &&
    !hasUnpairedSurrogate(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_DISCOVERY_NAME_BYTES
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isRDataframeFlavor(value: unknown): value is RDataframeFlavor {
  return value === "r.data.frame" || value === "r.tibble" || value === "r.data.table";
}

function malformedDiscoveryResponse(): RNotebookVariableDiscoveryError {
  return new RNotebookVariableDiscoveryError(
    "Open Wrangler received a malformed R notebook variable discovery response."
  );
}

function oversizedDiscoveryResponse(): RNotebookVariableDiscoveryError {
  return new RNotebookVariableDiscoveryError(
    "Open Wrangler rejected an oversized R notebook variable discovery response."
  );
}

function oversizedOrMalformed(value: unknown): RNotebookVariableDiscoveryError {
  return isKernelOutput(value) ? oversizedDiscoveryResponse() : malformedDiscoveryResponse();
}

function notebookKernelError(data: Uint8Array): RNotebookVariableDiscoveryError {
  if (data.byteLength <= MAX_DISCOVERY_ERROR_BYTES) {
    const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      decoded = undefined;
    }
    if (isPlainRecord(decoded) && typeof decoded.message === "string") {
      const message = decoded.message.toLowerCase();
      if (message.includes("jsonlite") && isMissingPackageMessage(message)) {
        return missingRPackage("jsonlite");
      }
      if (message.includes("rlang") && isMissingPackageMessage(message)) {
        return missingRPackage("rlang");
      }
    }
  }
  return new RNotebookVariableDiscoveryError(
    "Open Wrangler could not inspect dataframe variables in the selected R notebook kernel."
  );
}

function isMissingPackageMessage(message: string): boolean {
  return (
    message.includes("no package called") ||
    message.includes("there is no package") ||
    message.includes("requires the") ||
    message.includes("package is required")
  );
}

function missingRPackage(packageName: "jsonlite" | "rlang"): RNotebookVariableDiscoveryError {
  return new RNotebookVariableDiscoveryError(
    `Run install.packages("${packageName}") in the selected R kernel, then try again.`
  );
}

function changedVariableSelection(): RNotebookVariableDiscoveryError {
  return new RNotebookVariableDiscoveryError(
    "The selected R dataframe changed while the picker was open. Open the picker again."
  );
}
