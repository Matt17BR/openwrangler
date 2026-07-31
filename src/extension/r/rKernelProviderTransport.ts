import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Kernel } from "@vscode/jupyter-extension";
import type { CancellationToken } from "vscode";
import { KernelRequestCancelledError } from "../notebooks/kernelLifecycle";
import {
  parseRProviderResponseJsonForDispatch,
  R_PROVIDER_LIMITS,
  R_PROVIDER_PROTOCOL_VERSION,
  type RProviderConfirmedSession,
  type RProviderDispatchContext,
  type RProviderRequest,
  type RProviderResponseEnvelope
} from "./rProviderProtocol";

const R_KERNEL_OUTPUT_OVERHEAD_BYTES = 1_048_576;
const R_KERNEL_MARKER_PATTERN = /^[A-Za-z0-9]{16,128}$/u;

export interface RKernelProviderBundle {
  readonly bootstrapCode: string;
  readonly disposeCode: string;
  readonly optionKey: string;
  readonly sourceId: string;
}

export interface FramedRKernelRequest {
  readonly code: string;
  readonly context: RProviderDispatchContext;
  readonly marker: string;
  readonly payload: string;
}

type RKernelExecutor = Pick<Kernel, "executeCode">;

/**
 * Owns the provider installed in one exact R kernel generation.
 *
 * Lifecycle/restart policy remains the responsibility of the future R notebook
 * bridge. This class deliberately cannot reacquire a kernel by URI: every
 * dispatch stays bound to the exact Kernel object supplied at construction.
 */
export class RKernelProviderTransport {
  private bootstrap: { readonly generation: number; readonly promise: Promise<void> } | undefined;
  private bootstrapped = false;
  private generation = 0;

  constructor(
    private readonly kernel: RKernelExecutor,
    private readonly bundle: RKernelProviderBundle,
    private readonly createRequestId: () => string = randomUUID
  ) {}

  async dispatch(
    request: RProviderRequest,
    token: CancellationToken,
    session?: RProviderConfirmedSession
  ): Promise<RProviderResponseEnvelope> {
    const generation = this.generation;
    assertNotCancelled(token);
    await this.ensureBootstrapped(token);
    this.assertGeneration(generation);
    assertNotCancelled(token);

    const requestId = this.createRequestId();
    const context = createRProviderDispatchContext(requestId, request, session);
    const framed = frameRKernelRequest(context, this.bundle.optionKey, requestId.replaceAll("-", ""));
    const responseLimit =
      request.kind === "discoverVariables"
        ? R_PROVIDER_LIMITS.maxDiscoveryResponseBytes
        : R_PROVIDER_LIMITS.maxResponseBytes;
    const output = await collectRKernelOutput(this.kernel.executeCode(framed.code, token), responseLimit);
    this.assertGeneration(generation);
    assertNotCancelled(token);
    return parseRKernelResponse(output, framed);
  }

  /** Clears all provider sessions and removes the private kernel option. */
  async dispose(token: CancellationToken): Promise<void> {
    if (!this.bootstrap && !this.bootstrapped) return;
    const generation = this.generation;
    try {
      await this.ensureBootstrapped(token);
      this.assertGeneration(generation);
      assertNotCancelled(token);
      await collectRKernelOutput(this.kernel.executeCode(this.bundle.disposeCode, token));
      this.assertGeneration(generation);
      assertNotCancelled(token);
    } finally {
      if (this.generation === generation) this.generation += 1;
      if (this.bootstrap?.generation === generation) this.bootstrap = undefined;
      if (this.generation !== generation) this.bootstrapped = false;
    }
  }

  /** Invalidates bootstrap state after the owning bridge observes a restart. */
  invalidate(): void {
    this.generation += 1;
    this.bootstrap = undefined;
    this.bootstrapped = false;
  }

  private async ensureBootstrapped(token: CancellationToken): Promise<void> {
    if (this.bootstrapped) return;
    const generation = this.generation;
    const pending =
      this.bootstrap?.generation === generation
        ? this.bootstrap.promise
        : (this.bootstrap = {
            generation,
            promise: (async () => {
              assertNotCancelled(token);
              await collectRKernelOutput(this.kernel.executeCode(this.bundle.bootstrapCode, token));
              assertNotCancelled(token);
              this.assertGeneration(generation);
              this.bootstrapped = true;
            })()
          }).promise;
    try {
      await pending;
    } catch (error) {
      if (this.bootstrap?.generation === generation && this.bootstrap.promise === pending) {
        this.bootstrap = undefined;
      }
      if (this.generation === generation) this.bootstrapped = false;
      throw error;
    }
  }

  private assertGeneration(generation: number): void {
    if (this.generation !== generation) {
      throw new Error("The native R kernel generation changed while a provider request was in flight.");
    }
  }
}

export function createRProviderDispatchContext(
  requestId: string,
  request: RProviderRequest,
  session?: RProviderConfirmedSession
): RProviderDispatchContext {
  if (request.kind === "getPage" || request.kind === "closeSession") {
    if (session === undefined) {
      throw new Error(`The native R ${request.kind} request requires its exact confirmed session.`);
    }
    return { requestId, request, session } as RProviderDispatchContext;
  }
  if (session !== undefined) {
    throw new Error(`The native R ${request.kind} request cannot carry unrelated session state.`);
  }
  return { requestId, request } as RProviderDispatchContext;
}

/**
 * Embeds the reviewed pure-R agent without referencing the extension host
 * filesystem, which may not exist beside a remote Jupyter kernel.
 */
export function buildRKernelProviderBundle(agentSource: string): RKernelProviderBundle {
  if (Buffer.byteLength(agentSource, "utf8") === 0) {
    throw new Error("The native R kernel provider source is empty.");
  }
  const sourceId = createHash("sha256").update(agentSource, "utf8").digest("hex").slice(0, 16);
  const optionKey = `openwrangler.r.provider.${sourceId}`;
  const sourcePayload = Buffer.from(agentSource, "utf8").toString("base64");
  const bootstrapCode = `
local({
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("The native R provider requires jsonlite. Open Wrangler must ask before installing it.", call. = FALSE)
  }
  .ow_option_key <- "${optionKey}"
  .ow_provider <- getOption(.ow_option_key, NULL)
  if (is.null(.ow_provider)) {
    .ow_agent_source <- rawToChar(jsonlite::base64_dec("${sourcePayload}"))
    .ow_agent_env <- new.env(parent = baseenv())
    .ow_agent_factory <- eval(parse(text = .ow_agent_source, keep.source = FALSE), envir = .ow_agent_env)
    if (!is.function(.ow_agent_factory) || length(ls(.ow_agent_env, all.names = TRUE)) != 0L) {
      stop("The native R provider bundle did not evaluate to one isolated factory.", call. = FALSE)
    }
    .ow_provider <- .ow_agent_factory(.GlobalEnv)
    do.call(options, setNames(list(.ow_provider), .ow_option_key))
  }
  if (
    !is.list(.ow_provider) ||
      !is.function(.ow_provider$dispatch_json) ||
      !is.function(.ow_provider$close)
  ) {
    stop("The selected R kernel contains an incompatible Open Wrangler provider binding.", call. = FALSE)
  }
})
`;
  const disposeCode = `
local({
  .ow_option_key <- "${optionKey}"
  .ow_provider <- getOption(.ow_option_key, NULL)
  if (!is.null(.ow_provider)) {
    on.exit(do.call(options, setNames(list(NULL), .ow_option_key)), add = TRUE)
    if (!is.list(.ow_provider) || !is.function(.ow_provider$close)) {
      stop("The selected R kernel contains an incompatible Open Wrangler provider binding.", call. = FALSE)
    }
    .ow_provider$close()
  }
})
`;
  return Object.freeze({ bootstrapCode, disposeCode, optionKey, sourceId });
}

export function readRKernelAgentSource(extensionPath: string): string {
  return readFileSync(path.join(extensionPath, "r", "openwrangler_runtime", "kernel_agent.R"), "utf8");
}

export function frameRKernelRequest(
  context: RProviderDispatchContext,
  optionKey: string,
  marker: string
): FramedRKernelRequest {
  if (!/^openwrangler\.r\.provider\.[0-9a-f]{16}$/u.test(optionKey)) {
    throw new Error("The native R provider option key is invalid.");
  }
  if (!R_KERNEL_MARKER_PATTERN.test(marker)) {
    throw new Error("The native R kernel response marker is invalid.");
  }
  const payload = JSON.stringify({
    protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
    requestId: context.requestId,
    request: context.request
  });
  if (Buffer.byteLength(payload, "utf8") > R_PROVIDER_LIMITS.maxRequestBytes) {
    throw new Error("The native R kernel request exceeds the bounded transport budget.");
  }
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64");
  return Object.freeze({
    context,
    marker,
    payload,
    code: `
local({
  .ow_provider <- getOption("${optionKey}", NULL)
  if (is.null(.ow_provider) || !is.list(.ow_provider) || !is.function(.ow_provider$dispatch_json)) {
    stop("Open Wrangler's native R provider is not available in this kernel generation.", call. = FALSE)
  }
  .ow_payload <- rawToChar(jsonlite::base64_dec("${encodedPayload}"))
  .ow_response <- .ow_provider$dispatch_json(.ow_payload)
  cat("__OPEN_WRANGLER_R_START_${marker}__\\n", sep = "")
  cat(.ow_response, sep = "")
  cat("\\n__OPEN_WRANGLER_R_END_${marker}__\\n", sep = "")
})
`
  });
}

export function parseRKernelResponse(
  output: string,
  framed: Pick<FramedRKernelRequest, "context" | "marker">
): RProviderResponseEnvelope {
  const payload = extractMarkedRKernelPayload(output, framed.marker);
  const response = parseRProviderResponseJsonForDispatch(payload, framed.context);
  if (response === undefined) {
    throw new Error("The native R kernel agent returned an invalid, stale, or contradictory protocol response.");
  }
  return response;
}

export async function collectRKernelOutput(
  output: ReturnType<Kernel["executeCode"]>,
  responseLimit: number = R_PROVIDER_LIMITS.maxResponseBytes
): Promise<string> {
  if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > R_PROVIDER_LIMITS.maxResponseBytes) {
    throw new Error("The native R kernel output limit is invalid.");
  }
  const chunks: string[] = [];
  let bytes = 0;
  for await (const item of output) {
    const chunk = rKernelOutputItemToText(item);
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > responseLimit + R_KERNEL_OUTPUT_OVERHEAD_BYTES) {
      throw new Error("The native R kernel output exceeded the bounded transport budget.");
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}

function extractMarkedRKernelPayload(output: string, marker: string): string {
  if (!R_KERNEL_MARKER_PATTERN.test(marker)) throw new Error("The native R kernel response marker is invalid.");
  const start = `__OPEN_WRANGLER_R_START_${marker}__`;
  const end = `__OPEN_WRANGLER_R_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end, startIndex + start.length);
  if (
    startIndex < 0 ||
    endIndex < startIndex + start.length ||
    output.indexOf(start, startIndex + start.length) >= 0 ||
    output.indexOf(end, endIndex + end.length) >= 0
  ) {
    throw new Error("Open Wrangler could not isolate exactly one native R kernel response.");
  }
  return output.slice(startIndex + start.length, endIndex).trim();
}

function rKernelOutputItemToText(item: unknown): string {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return "";
  const output = item as {
    text?: unknown;
    data?: Record<string, unknown>;
    items?: Array<{ mime?: string; data?: unknown }>;
  };
  if (output.text) return normalizeKernelText(output.text);
  if (output.data?.["text/plain"]) return normalizeKernelText(output.data["text/plain"]);
  const executionError = output.items?.find((candidate) => candidate.mime === "application/vnd.code.notebook.error");
  if (executionError) throw new Error(rKernelExecutionError(executionError.data));
  return (
    output.items
      ?.filter(
        (candidate) =>
          candidate.mime === "application/x.notebook.stream.stdout" ||
          candidate.mime === "application/vnd.code.notebook.stdout" ||
          candidate.mime === "text/plain"
      )
      .map((candidate) => normalizeKernelText(candidate.data))
      .join("") ?? ""
  );
}

function rKernelExecutionError(value: unknown): string {
  const encoded = normalizeKernelText(value);
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed === "object" && parsed !== null) {
      const error = parsed as { name?: unknown; message?: unknown };
      const name = typeof error.name === "string" ? error.name : "RKernelError";
      const message = typeof error.message === "string" ? error.message : encoded;
      return `Open Wrangler R kernel execution failed (${name}): ${message}`;
    }
  } catch {
    // Preserve the kernel's text when it is not JSON encoded.
  }
  return `Open Wrangler R kernel execution failed: ${encoded || "unknown kernel error"}`;
}

function normalizeKernelText(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalizeKernelText).join("");
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return typeof value === "string" ? value : "";
}

function assertNotCancelled(token: CancellationToken): void {
  if (token.isCancellationRequested) throw new KernelRequestCancelledError();
}
