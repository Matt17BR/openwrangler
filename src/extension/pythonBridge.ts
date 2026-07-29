import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type {
  DataBackend,
  OpenWranglerRequest,
  OpenWranglerResponse,
  ErrorResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope,
  SessionSource
} from "../shared/protocol";
import { isSessionBoundRequest, PROTOCOL_VERSION } from "../shared/protocol";
import { isRuntimeResponseEnvelope } from "../shared/protocolValidation";
import type { BridgeRequestOptions, OpenWranglerBridge } from "./dataBridge";
import { getSetting, runtimeRequestTimeoutMs } from "./configuration";
import {
  DEPENDENCY_INSTALL_SHUTDOWN_WAIT_MS,
  DEPENDENCY_INSTALL_TIMEOUT_MS,
  DependencyGuardCommandError,
  DependencyGuardCommandTimeoutError,
  DependencyGuardProtocolError,
  type DependencyGuardStatus,
  type DependencyGuardValidation,
  type OwnedDependencyGuardCommand,
  type OwnedDependencyInstall,
  startDependencyGuardStatus,
  startDependencyGuardValidation,
  startDependencyInstall,
  waitForDependencyInstallExit
} from "./dependencyInstaller";
import {
  automaticBackends,
  PythonEnvironmentApiBroker,
  PythonEnvironmentResolutionCancelledError,
  PythonEnvironmentResolutionDisposedError,
  PythonEnvironmentResolutionSupersededError,
  isPythonEnvironmentResolutionTerminalError,
  probeDependencies,
  requiredDependencies,
  resolvePythonEnvironment,
  type PythonEnvironment,
  type PythonEnvironmentSelectionChangeEvent
} from "./pythonEnvironment";
import { backendImportCapabilityFailure, isFileDataBackend, type PythonDependency } from "./pythonEnvironmentModel";
import { isFullyQualifiedPythonPath } from "./pythonPath";
import { buildPythonProcessEnvironment } from "./pythonProcessEnvironment";
import { stopChildProcessGracefully } from "./processShutdown";
import { discoverExcelSheetNames } from "./files/excelSheetNames";

interface PendingRequest {
  readonly requestId: string;
  resolve: (response: OpenWranglerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  readonly runtime: RuntimeSlot;
  readonly request: OpenWranglerRequest;
  cancellation?: { dispose(): void };
  cancellationRequestId?: string;
  cancellationRequested: boolean;
  dispatched: boolean;
}

interface MissingDependencies {
  readonly environment: PythonEnvironment;
  readonly dependencies: readonly PythonDependency[];
  readonly requirements: readonly string[];
  readonly selection: EnvironmentSelection;
  readonly selectionEpoch: number;
}

interface EnvironmentSelection {
  readonly key: string;
  readonly epoch: number;
  readonly resource: vscode.Uri | undefined;
  readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
  readonly promise: Promise<PythonEnvironment>;
  readonly resolutionController: AbortController;
  readonly dependencyKeys: Set<string>;
  resolvedEnvironment?: PythonEnvironment;
}

interface ProcessSelection {
  readonly environment: PythonEnvironment;
  readonly selection: EnvironmentSelection;
}

interface StoppingRuntimeProcess {
  readonly packageEnvironmentKey: string | undefined;
  readonly shutdown: Promise<void>;
  readonly exit: Promise<void>;
}

interface RuntimeSlot {
  readonly key: string;
  readonly pendingIds: Set<string>;
  readonly provisionalSessionIds: Set<string>;
  readonly sessionIds: Set<string>;
  readonly stoppingProcesses: Map<ChildProcessWithoutNullStreams, StoppingRuntimeProcess>;
  leaseCount: number;
  process: ChildProcessWithoutNullStreams | undefined;
  processStart: Promise<ChildProcessWithoutNullStreams> | undefined;
  processSelection: ProcessSelection | undefined;
  processStartSelection: ProcessSelection | undefined;
  processStop: Promise<void> | undefined;
  runtimeExitError: Error | undefined;
  stderrBuffer: string;
  runtimeEpoch: number;
}

interface ProvisionalSessionReservation {
  readonly runtime: RuntimeSlot;
  readonly openRequestId: string;
  state: "pending" | "closing";
}

interface PreparedRequest {
  readonly request: OpenWranglerRequest | ErrorResponse;
  readonly processSelection?: ProcessSelection;
}

interface DependencyInstallOperation {
  phase: "confirming" | "quiescing" | "starting" | "ready" | "mutating" | "validating" | "uncertain" | "settled";
  promise?: Promise<boolean>;
  authorizationEpoch?: number;
  authorizationSelection?: EnvironmentSelection;
  runtime?: RuntimeSlot;
  releaseRuntime?: () => void;
  executable?: string;
  dependencies?: readonly PythonDependency[];
  requirements?: readonly string[];
  mutationKey?: string;
  process?: OwnedDependencyInstall;
  quiescence?: Promise<void>;
  uncertainty?: unknown;
}

interface DependencyProbeFlight {
  readonly key: string;
  readonly packageEnvironmentKey: string;
  detached: boolean;
  promise: Promise<DependencyProbeOutcome>;
}

interface DependencyProbeOutcome {
  readonly missing: string[];
  readonly flight?: DependencyProbeFlight;
}

interface DependencyGuardStatusFlight {
  readonly environmentIdentityKey: string;
  readonly promise: Promise<DependencyGuardStatus>;
}

interface DependencyRecoveryOperation {
  phase: "checking" | "confirming" | "quiescing" | "validating" | "uncertain" | "settled";
  promise?: Promise<boolean>;
  target?: DependencyRecoveryTarget;
  authorizationEpoch?: number;
  authorizationSelection?: EnvironmentSelection;
  mutation?: DependencyInstallOperation;
}

interface DependencyEnvironmentUncertainty {
  readonly environment: PythonEnvironment;
  readonly token?: string;
  readonly selection?: EnvironmentSelection;
  readonly selectionEpoch?: number;
  readonly selectionDetached?: boolean;
  readonly reason: string;
  readonly guidance: string;
}

type DependencyRecoveryTarget = DependencyEnvironmentUncertainty & {
  readonly token: string;
  readonly selection: EnvironmentSelection;
  readonly selectionEpoch: number;
};

class DetachedDependencyProbeError extends Error {
  constructor() {
    super("The Python dependency probe was invalidated before it completed.");
    this.name = "DetachedDependencyProbeError";
  }
}

class DependencyGuardCrossIdentityFlightError extends Error {
  constructor() {
    super("A dependency guard check for another executable identity in this package environment is still settling.");
    this.name = "DependencyGuardCrossIdentityFlightError";
  }
}

const PROCESS_SHUTDOWN_AGGREGATE_MESSAGE = "Open Wrangler encountered multiple Python runtime shutdown failures.";
// Inactive scopes are retained as a small LRU so repeated external-file opens can
// reuse dependency/environment work without allowing arbitrary resource URIs to
// grow the bridge maps forever. Live or explicitly leased scopes may temporarily
// exceed this bound; the next ownership release trims back to it.
const MAX_RETAINED_INACTIVE_SCOPES = 128;
const MAX_COMPLETED_DEPENDENCY_PROBES = 128;
const MAX_RETAINED_DEPENDENCY_UNCERTAINTIES = 128;

async function joinProcessStops(previous: Promise<void>, current: Promise<void>): Promise<void> {
  const results = await Promise.allSettled([previous, current]);
  const failures = results.flatMap((result) => {
    if (result.status === "fulfilled") return [];
    if (result.reason instanceof AggregateError && result.reason.message === PROCESS_SHUTDOWN_AGGREGATE_MESSAGE) {
      return [...result.reason.errors];
    }
    return [result.reason];
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, PROCESS_SHUTDOWN_AGGREGATE_MESSAGE);
}

export class PythonBridge implements OpenWranglerBridge, vscode.Disposable {
  private shutdownPromise: Promise<void> | undefined;
  private readonly runtimeSlots = new Map<string, RuntimeSlot>();
  private readonly sessionOwners = new Map<string, RuntimeSlot>();
  private readonly provisionalSessions = new Map<string, ProvisionalSessionReservation>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cancellationTargets = new Map<string, { targetRequestId: string; runtime: RuntimeSlot }>();
  private readonly output = vscode.window.createOutputChannel("Open Wrangler");
  private readonly spawnProcess = spawn;

  public runtimeEnvironmentForTesting():
    Readonly<Pick<PythonEnvironment, "executable" | "source" | "version">> | undefined {
    for (const runtime of this.runtimeSlots.values()) {
      const environment = runtime.processSelection?.environment;
      if (runtime.process && environment) {
        return Object.freeze({
          executable: environment.executable,
          source: environment.source,
          version: environment.version
        });
      }
    }
    return undefined;
  }
  private readonly launchDependencyInstall = startDependencyInstall;
  private readonly launchDependencyGuardStatus = startDependencyGuardStatus;
  private readonly launchDependencyGuardValidation = startDependencyGuardValidation;
  private readonly waitForDependencyInstallExit = waitForDependencyInstallExit;
  private readonly configurationSubscription: vscode.Disposable;
  private readonly environmentApiBroker: PythonEnvironmentApiBroker;
  private generation = 0;
  private scopeUseClock = 0;
  private readonly scopeRecency = new Map<string, number>();
  private selectionEpoch = 0;
  private dependencyAuthorizationEpoch = 0;
  private readonly selectionEpochs = new Map<string, number>();
  private disposed = false;
  private readonly environmentSelections = new Map<string, EnvironmentSelection>();
  private readonly dependencyCache = new Map<string, string[]>();
  private readonly dependencyProbes = new Map<string, DependencyProbeFlight>();
  private readonly dependencyProbeOwners = new Map<string, DependencyProbeFlight>();
  private readonly dependencyGuardStatusFlights = new Map<string, DependencyGuardStatusFlight>();
  private activeDependencyGuardCommands:
    Set<OwnedDependencyGuardCommand<DependencyGuardStatus | DependencyGuardValidation>> | undefined = new Set();
  private readonly dependencyEnvironmentUncertainty = new Map<string, DependencyEnvironmentUncertainty>();
  private lastMissingDependencies: MissingDependencies | undefined;
  private dependencyInstallOperation: DependencyInstallOperation | undefined;
  private dependencyRecoveryOperation: DependencyRecoveryOperation | undefined;
  private readonly dependencyMutations = new Map<string, DependencyInstallOperation>();
  private readonly excelSheetReads = new Set<AbortController>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.environmentApiBroker = new PythonEnvironmentApiBroker((event) =>
      this.handlePythonEnvironmentSelectionChange(event)
    );
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (this.disposed || !event.affectsConfiguration("openWrangler.pythonPath")) return;
      const authorizedSelection =
        this.dependencyInstallOperation?.authorizationSelection ??
        this.dependencyRecoveryOperation?.authorizationSelection;
      const affectsAuthorizedInstall = Boolean(
        authorizedSelection && event.affectsConfiguration("openWrangler.pythonPath", authorizedSelection.resource)
      );
      const affected = new Set(
        [...this.environmentSelections.values()]
          .filter((selection) => event.affectsConfiguration("openWrangler.pythonPath", selection.resource))
          .map((selection) => selection.key)
      );
      if (affectsAuthorizedInstall) this.dependencyAuthorizationEpoch += 1;
      if (affected.size > 0) {
        this.invalidateSelectionScopes(affected, "Python runtime selection changed.", true);
      }
    });
  }

  get runtimeGeneration(): number {
    return this.generation;
  }

  get runtimeRunning(): boolean {
    return [...this.runtimeSlots.values()].some((runtime) =>
      Boolean(runtime.process || runtime.processStart || runtime.processStop)
    );
  }

  async listExcelSheets(
    sessionId: string,
    source: SessionSource,
    backend: DataBackend,
    options: BridgeRequestOptions = {}
  ): Promise<readonly string[] | undefined> {
    if (
      this.disposed ||
      !vscode.workspace.isTrusted ||
      options.cancellation?.isCancellationRequested ||
      source.kind !== "file" ||
      !source.path ||
      ![".xls", ".xlsx"].includes(path.extname(source.path).toLowerCase()) ||
      (backend !== "pandas" && backend !== "polars")
    ) {
      return undefined;
    }
    const runtime = this.sessionOwners.get(sessionId);
    const processSelection = runtime?.processSelection;
    if (
      !runtime?.process ||
      !processSelection ||
      pythonSelectionScope(sourceResource(source)).key !== runtime.key ||
      !this.isCurrentEnvironmentSelection(processSelection.selection)
    ) {
      return undefined;
    }

    const release = this.retainRuntime(runtime);
    const controller = new AbortController();
    this.excelSheetReads.add(controller);
    const cancellation = options.cancellation?.onCancellationRequested(() =>
      controller.abort(new Error("Excel worksheet discovery was cancelled."))
    );
    try {
      const names = await discoverExcelSheetNames({
        pythonPath: processSelection.environment.executable,
        extensionPath: this.context.extensionPath,
        sourcePath: source.path,
        backend,
        signal: controller.signal
      });
      if (
        controller.signal.aborted ||
        this.disposed ||
        !vscode.workspace.isTrusted ||
        this.sessionOwners.get(sessionId) !== runtime ||
        runtime.processSelection !== processSelection ||
        !this.isCurrentEnvironmentSelection(processSelection.selection)
      ) {
        return undefined;
      }
      return names;
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        this.output.appendLine(
          `Could not list worksheets for ${source.label}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return undefined;
    } finally {
      cancellation?.dispose();
      this.excelSheetReads.delete(controller);
      release();
    }
  }

  async request(request: OpenWranglerRequest, options: BridgeRequestOptions = {}): Promise<OpenWranglerResponse> {
    if (this.disposed) {
      throw new Error("Open Wrangler runtime bridge has been disposed.");
    }
    if (options.cancellation?.isCancellationRequested) {
      return { kind: "cancelled", targetRequestId: "not-started" };
    }
    let runtimeRequest = request;
    let runtime: RuntimeSlot;
    let desired: ProcessSelection | undefined;
    let proc: ChildProcessWithoutNullStreams;
    let requestLease: (() => void) | undefined;
    const releaseRequestLease = (): void => {
      const release = requestLease;
      requestLease = undefined;
      release?.();
    };

    if (isSessionBoundRequest(request)) {
      const confirmedOwner = this.sessionOwners.get(request.sessionId);
      const provisional = request.kind === "closeSession" ? this.provisionalSessions.get(request.sessionId) : undefined;
      const owner = confirmedOwner ?? provisional?.runtime;
      if (!owner || (!owner.process && !owner.processStart)) {
        if (confirmedOwner) this.releaseSessionOwner(request.sessionId, confirmedOwner);
        if (provisional) {
          this.releaseProvisionalReservation(request.sessionId, provisional.openRequestId, provisional.runtime);
        }
        return this.unknownSessionError(request);
      }
      if (!confirmedOwner && provisional) provisional.state = "closing";
      runtime = owner;
      requestLease = this.retainRuntime(owner);
      try {
        proc = owner.process ?? (await owner.processStart!);
      } catch (error) {
        releaseRequestLease();
        throw error;
      }
    } else if (request.kind === "cancelRequest") {
      const target = this.pending.get(request.targetRequestId);
      if (!target || (!target.runtime.process && !target.runtime.processStart)) {
        return this.cancellationUnavailableError(request.targetRequestId);
      }
      runtime = target.runtime;
      requestLease = this.retainRuntime(runtime);
      try {
        proc = runtime.process ?? (await runtime.processStart!);
      } catch (error) {
        releaseRequestLease();
        throw error;
      }
    } else {
      const preparationScope = pythonSelectionScope(
        request.kind === "openSession" ? sourceResource(request.source) : undefined
      );
      const preparationRuntime = this.runtimeSlot(preparationScope.key);
      requestLease = this.retainRuntime(preparationRuntime);
      let leasedRuntime = preparationRuntime;
      let resolutionCancellationRequested = false;
      const cancelPendingResolution = (): void => {
        resolutionCancellationRequested = true;
        const selection = this.environmentSelections.get(preparationScope.key);
        if (selection) {
          this.abortEnvironmentSelection(selection, new PythonEnvironmentResolutionCancelledError());
        }
      };
      const existingPreparationSelection = this.environmentSelections.get(preparationScope.key);
      const resolutionCancellation =
        !existingPreparationSelection?.resolvedEnvironment && options.cancellation
          ? options.cancellation.onCancellationRequested(cancelPendingResolution)
          : undefined;
      try {
        let selectionRetryAvailable = request.kind === "openSession";
        const consumeSelectionRetry = (): boolean => {
          if (
            !selectionRetryAvailable ||
            resolutionCancellationRequested ||
            options.cancellation?.isCancellationRequested
          ) {
            return false;
          }
          selectionRetryAvailable = false;
          return true;
        };
        for (;;) {
          try {
            const preparation = this.prepareRequestForDispatch(request);
            if (resolutionCancellationRequested || options.cancellation?.isCancellationRequested) {
              cancelPendingResolution();
            }
            const prepared = await preparation;
            if (prepared.request.kind === "error") {
              if (prepared.request.code === "runtime_selection_changed" && consumeSelectionRetry()) continue;
              releaseRequestLease();
              return prepared.request;
            }
            if (options.cancellation?.isCancellationRequested) {
              releaseRequestLease();
              return { kind: "cancelled", targetRequestId: "not-started" };
            }
            runtimeRequest = prepared.request;
            desired = prepared.processSelection ?? (await this.processSelectionFor(runtimeRequest));
            if (!this.isCurrentEnvironmentSelection(desired.selection)) {
              if (consumeSelectionRetry()) continue;
              releaseRequestLease();
              return this.runtimeSelectionChangedError();
            }
            runtime = this.runtimeSlot(desired.selection.key);
            if (runtime !== leasedRuntime) {
              const desiredLease = this.retainRuntime(runtime);
              releaseRequestLease();
              requestLease = desiredLease;
              leasedRuntime = runtime;
            }
            try {
              proc = await this.ensureProcess(runtime, desired);
            } catch (error) {
              if (!this.isCurrentEnvironmentSelection(desired.selection)) {
                if (consumeSelectionRetry()) continue;
                releaseRequestLease();
                return this.runtimeSelectionChangedError();
              }
              throw error;
            }
            if (!this.isCurrentEnvironmentSelection(desired.selection)) {
              if (consumeSelectionRetry()) continue;
              releaseRequestLease();
              return this.runtimeSelectionChangedError();
            }
            break;
          } catch (error) {
            if (
              !(error instanceof PythonEnvironmentResolutionCancelledError) &&
              isPythonEnvironmentResolutionTerminalError(error) &&
              error.code !== "python_environment_resolution_timeout" &&
              error.code !== "python_environment_resolution_workspace_untrusted" &&
              consumeSelectionRetry()
            ) {
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        releaseRequestLease();
        if (error instanceof PythonEnvironmentResolutionCancelledError) {
          return options.cancellation?.isCancellationRequested
            ? { kind: "cancelled", targetRequestId: "not-started" }
            : this.runtimeSelectionChangedError();
        }
        if (
          isPythonEnvironmentResolutionTerminalError(error) &&
          error.code !== "python_environment_resolution_timeout" &&
          error.code !== "python_environment_resolution_workspace_untrusted"
        ) {
          return this.runtimeSelectionChangedError();
        }
        throw error;
      } finally {
        resolutionCancellation?.dispose();
      }
    }
    if (options.cancellation?.isCancellationRequested) {
      this.stopRuntimeIfIdle(runtime);
      releaseRequestLease();
      return { kind: "cancelled", targetRequestId: "not-started" };
    }

    const requestId = randomUUID();
    const provisionalError = this.reserveRequestedSession(runtimeRequest, runtime, requestId);
    if (provisionalError) {
      this.stopRuntimeIfIdle(runtime);
      releaseRequestLease();
      return provisionalError;
    }
    const envelope: RuntimeRequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      priority:
        options.priority ??
        (runtimeRequest.kind === "getSummary" || runtimeRequest.kind === "getDatasetStats"
          ? "background"
          : "interactive"),
      request: runtimeRequest
    };
    const timeoutMs = runtimeRequestTimeoutMs(runtimeRequest, options.timeoutMs);

    return new Promise<OpenWranglerResponse>((resolve, reject) => {
      if (runtime.runtimeExitError) {
        this.releaseProvisionalReservationForRequest(runtimeRequest, requestId, runtime);
        releaseRequestLease();
        reject(runtime.runtimeExitError);
        return;
      }
      if (proc.stdin.destroyed || !proc.stdin.writable) {
        this.releaseProvisionalReservationForRequest(runtimeRequest, requestId, runtime);
        releaseRequestLease();
        reject(this.runtimeUnavailableError(runtime));
        return;
      }

      const timer = setTimeout(() => {
        const pending = this.takePending(requestId);
        if (!pending) return;
        this.sendCancellation(runtime, requestId, false);
        pending.reject(
          new Error(`Open Wrangler runtime request ${runtimeRequest.kind} timed out after ${timeoutMs} ms.`)
        );
        if (runtimeRequest.kind === "openSession" || options.restartRuntimeOnTimeout !== false) {
          this.restartRuntime(runtime, "Runtime request timed out; restarting so sessions can be replayed.");
        } else {
          this.releasePendingProvisionalReservationForRequest(pending.request, pending.requestId, pending.runtime);
          this.stopRuntimeIfIdle(pending.runtime);
        }
      }, timeoutMs);
      const pending: PendingRequest = {
        requestId,
        resolve,
        reject,
        timer,
        runtime,
        request: runtimeRequest,
        cancellationRequested: false,
        dispatched: false
      };
      this.pending.set(requestId, pending);
      runtime.pendingIds.add(requestId);
      releaseRequestLease();
      const cancellation = options.cancellation?.onCancellationRequested(() => this.cancelRequest(requestId));
      pending.cancellation = cancellation;
      if (!this.pending.has(requestId)) cancellation?.dispose();
      if (options.cancellation?.isCancellationRequested) this.cancelRequest(requestId);
      if (!this.pending.has(requestId)) return;

      try {
        pending.dispatched = true;
        proc.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
          if (!error) return;
          const pending = this.takePending(requestId);
          if (pending) {
            this.releasePendingProvisionalReservationForRequest(pending.request, pending.requestId, runtime);
            pending.reject(this.runtimeUnavailableError(runtime, error));
          }
          this.stopRuntimeIfIdle(runtime);
        });
      } catch (error) {
        const pending = this.takePending(requestId);
        if (pending) {
          this.releasePendingProvisionalReservationForRequest(pending.request, pending.requestId, runtime);
          pending.reject(this.runtimeUnavailableError(runtime, error));
        }
        this.stopRuntimeIfIdle(runtime);
      }
    });
  }

  restart(reason = "Open Wrangler runtime restarted."): void {
    for (const runtime of this.runtimeSlots.values()) this.restartRuntime(runtime, reason);
  }

  reportDiagnostic(message: string): void {
    this.output.appendLine(message);
  }

  onIdle(): void {
    for (const runtime of this.runtimeSlots.values()) {
      if (runtime.process || runtime.processStart || runtime.sessionIds.size > 0) {
        this.stopRuntime(runtime, "Open Wrangler runtime stopped after its last session closed.");
      }
    }
  }

  clearRuntimeSelection(): void {
    if (
      this.dependencyInstallOperation?.authorizationSelection ||
      this.dependencyRecoveryOperation?.authorizationSelection
    ) {
      this.dependencyAuthorizationEpoch += 1;
    }
    this.invalidateRuntimeSelection("Python runtime selection changed.");
  }

  private invalidateRuntimeSelection(reason: string, force = false): void {
    const keys = new Set([
      ...this.environmentSelections.keys(),
      ...this.runtimeSlots.keys(),
      ...(this.lastMissingDependencies ? [this.lastMissingDependencies.selection.key] : [])
    ]);
    if (
      !force &&
      keys.size === 0 &&
      this.dependencyCache.size === 0 &&
      this.dependencyProbes.size === 0 &&
      this.dependencyProbeOwners.size === 0 &&
      !this.lastMissingDependencies
    ) {
      return;
    }
    this.invalidateAllDependencyProbes();
    this.invalidateSelectionScopes(keys, reason, force);
  }

  private invalidateAllDependencyProbes(): void {
    for (const flight of this.dependencyProbes.values()) flight.detached = true;
    for (const flight of this.dependencyProbeOwners.values()) flight.detached = true;
    this.dependencyCache.clear();
    this.dependencyProbes.clear();
    this.dependencyProbeOwners.clear();
  }

  private invalidateDependencyProbeKey(key: string): void {
    const inFlight = this.dependencyProbes.get(key);
    if (inFlight) inFlight.detached = true;
    const completed = this.dependencyProbeOwners.get(key);
    if (completed) completed.detached = true;
    this.dependencyCache.delete(key);
    this.dependencyProbes.delete(key);
    this.dependencyProbeOwners.delete(key);
  }

  private invalidateDependencyProbesForPackageEnvironment(packageEnvironmentKey: string): void {
    const prefix = pythonPackageEnvironmentDependencyPrefix(packageEnvironmentKey);
    const keys = new Set([
      ...this.dependencyCache.keys(),
      ...this.dependencyProbes.keys(),
      ...this.dependencyProbeOwners.keys()
    ]);
    for (const key of keys) if (key.startsWith(prefix)) this.invalidateDependencyProbeKey(key);
  }

  private getCompletedDependencyProbe(key: string): DependencyProbeOutcome | undefined {
    const missing = this.dependencyCache.get(key);
    if (missing === undefined) return undefined;
    this.dependencyCache.delete(key);
    this.dependencyCache.set(key, missing);
    return { missing, flight: this.dependencyProbeOwners.get(key) };
  }

  private publishCompletedDependencyProbe(
    key: string,
    missing: readonly string[],
    flight: DependencyProbeFlight
  ): DependencyProbeOutcome {
    const retained = [...missing];
    this.dependencyCache.delete(key);
    this.dependencyCache.set(key, retained);
    this.dependencyProbeOwners.set(key, flight);
    while (this.dependencyCache.size > MAX_COMPLETED_DEPENDENCY_PROBES) {
      const oldest = this.dependencyCache.keys().next().value;
      if (oldest === undefined) break;
      this.dependencyCache.delete(oldest);
      this.dependencyProbeOwners.delete(oldest);
    }
    return { missing: retained, flight };
  }

  private probeDependenciesForEnvironment(
    environment: PythonEnvironment,
    dependencies: readonly PythonDependency[]
  ): DependencyProbeOutcome | Promise<DependencyProbeOutcome> {
    const key = dependencyProbeKey(environment, dependencies);
    const completed = this.getCompletedDependencyProbe(key);
    if (completed !== undefined) return completed;
    return this.probeDependenciesSingleFlight(key, pythonPackageEnvironmentKey(environment), environment, dependencies);
  }

  private probeDependenciesSingleFlight(
    key: string,
    packageEnvironmentKey: string,
    environment: PythonEnvironment,
    dependencies: readonly PythonDependency[]
  ): Promise<DependencyProbeOutcome> {
    const existing = this.dependencyProbes.get(key);
    if (existing) return existing.promise;

    const flight = {
      key,
      packageEnvironmentKey,
      detached: false
    } as DependencyProbeFlight;
    const detached = (): boolean =>
      flight.detached ||
      this.dependencyProbes.get(flight.key) !== flight ||
      this.disposed ||
      this.dependencyMutations.has(flight.packageEnvironmentKey);
    const promise = Promise.resolve()
      .then(() => {
        if (detached()) throw new DetachedDependencyProbeError();
        return probeDependencies(environment.executable, dependencies);
      })
      .then(
        (result) => {
          const missing = [...result.missing];
          if (detached()) throw new DetachedDependencyProbeError();
          this.dependencyProbes.delete(flight.key);
          return this.publishCompletedDependencyProbe(flight.key, missing, flight);
        },
        (error: unknown) => {
          if (detached()) throw new DetachedDependencyProbeError();
          this.dependencyProbes.delete(flight.key);
          throw error;
        }
      );
    flight.promise = promise;
    this.dependencyProbes.set(key, flight);
    return promise;
  }

  private invalidateSelectionScopes(keys: ReadonlySet<string>, reason: string, force = false): void {
    const affected = [...keys].filter((key) => {
      const runtime = this.runtimeSlots.get(key);
      return (
        force ||
        this.environmentSelections.has(key) ||
        this.lastMissingDependencies?.selection.key === key ||
        Boolean(runtime && !this.isInactiveScope(runtime))
      );
    });
    if (affected.length === 0) return;

    this.selectionEpoch += 1;
    for (const key of affected) {
      this.selectionEpochs.set(key, (this.selectionEpochs.get(key) ?? 0) + 1);
      const selection = this.environmentSelections.get(key);
      const hadActiveMissingTarget = this.lastMissingDependencies?.selection === selection;
      if (selection) {
        this.abortEnvironmentSelection(selection, new PythonEnvironmentResolutionSupersededError());
        this.environmentSelections.delete(key);
        for (const dependencyKey of selection.dependencyKeys) {
          this.invalidateDependencyProbeKey(dependencyKey);
        }
      }
      if (this.lastMissingDependencies?.selection.key === key) this.lastMissingDependencies = undefined;
      const runtime = this.runtimeSlots.get(key);
      if (runtime && !this.disposed) {
        if (hadActiveMissingTarget || !this.isInactiveScope(runtime)) {
          this.stopRuntime(runtime, reason);
        } else {
          this.evictInactiveScope(runtime);
        }
      }
    }
    this.trimInactiveScopes();
  }

  async installMissingDependencies(): Promise<boolean> {
    return this.beginDependencyInstallation();
  }

  revalidateRuntimeDependencies(): Promise<boolean> {
    if (this.disposed) {
      return Promise.reject(
        new Error("Open Wrangler cannot revalidate dependencies after its runtime bridge disposed.")
      );
    }
    if (this.dependencyInstallOperation && this.dependencyInstallOperation.phase !== "settled") {
      return Promise.resolve(false);
    }
    const existing = this.dependencyRecoveryOperation;
    if (existing?.promise) return existing.promise;

    const operation: DependencyRecoveryOperation = { phase: "checking" };
    this.dependencyRecoveryOperation = operation;
    const recovery = this.revalidateRuntimeDependenciesWithDecision(operation);
    operation.promise = recovery;
    const finish = (): void => this.finishDependencyRecoveryOperation(operation);
    void recovery.then(finish, finish);
    return recovery;
  }

  async declineRuntimeDependencyRevalidationForTesting(): Promise<boolean> {
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS !== "1") {
      throw new Error("Dependency-revalidation decline is available only to the Open Wrangler test harness.");
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage("Trust this workspace before revalidating Python dependencies.");
    }
    return false;
  }

  async declineMissingDependencyInstallForTesting(): Promise<boolean> {
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS !== "1") {
      throw new Error("Dependency-install decline is available only to the Open Wrangler test harness.");
    }
    const missing = this.lastMissingDependencies;
    if (!missing || missing.requirements.length === 0) {
      void vscode.window.showInformationMessage("Open Wrangler has no unresolved runtime dependencies.");
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage("Trust this workspace before installing Python dependencies.");
    }
    return false;
  }

  private async revalidateRuntimeDependenciesWithDecision(operation: DependencyRecoveryOperation): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      if (!this.disposed) {
        void vscode.window.showErrorMessage("Trust this workspace before revalidating Python dependencies.");
      }
      return false;
    }
    const target = this.exactDependencyRecoveryTarget();
    if (!target) {
      if (!this.disposed) {
        void vscode.window.showInformationMessage(
          "Open Wrangler has no exact dependency recovery target. Reopen the affected source and try again."
        );
      }
      return false;
    }
    operation.target = target;

    const initialEnvironment = await this.freshDependencyRecoveryEnvironment(operation, true);
    if (!initialEnvironment) return false;
    const initialStatus = await this.readDependencyRecoveryStatus(operation, initialEnvironment);
    if (!initialStatus || !this.isCurrentDependencyRecoveryTarget(operation, true)) return false;
    if (!this.isSameDirtyDependencyRecoveryStatus(operation, initialStatus)) {
      this.retainChangedDependencyRecoveryStatus(operation, initialStatus);
      return false;
    }

    operation.phase = "confirming";
    const choice = await vscode.window.showWarningMessage(
      `Revalidate runtime dependencies in ${target.environment.executable}?`,
      {
        modal: true,
        detail:
          "Open Wrangler found an interrupted dependency change. Revalidation waits for any package writer to exit, imports and version-checks the recorded dependencies, and clears the retained recovery marker only if every check succeeds. It does not install, remove, or overwrite packages."
      },
      "Revalidate"
    );
    if (choice !== "Revalidate") return false;

    const confirmedEnvironment = await this.freshDependencyRecoveryEnvironment(operation, true);
    if (!confirmedEnvironment) return false;
    operation.authorizationEpoch = this.dependencyAuthorizationEpoch;
    operation.authorizationSelection = target.selection;
    const mutation: DependencyInstallOperation = {
      phase: "quiescing",
      authorizationEpoch: operation.authorizationEpoch,
      authorizationSelection: target.selection
    };
    operation.mutation = mutation;
    operation.phase = "quiescing";
    try {
      await this.beginDependencyMutation(mutation, confirmedEnvironment);
    } catch (error) {
      mutation.phase = "uncertain";
      mutation.uncertainty = error;
      operation.phase = "uncertain";
      this.retainDependencyRecoveryFailure(operation, error);
      if (!this.disposed) void vscode.window.showErrorMessage(dependencyGuardRecoveryGuidance(error));
      return false;
    }

    const quiescedEnvironment = await this.freshAuthorizedDependencyRecoveryEnvironment(operation);
    if (!quiescedEnvironment) return false;
    const quiescedStatus = await this.readDependencyRecoveryStatus(operation, quiescedEnvironment);
    if (!quiescedStatus || !this.isAuthorizedDependencyRecoveryOperation(operation, quiescedEnvironment)) {
      return false;
    }
    if (!this.isSameDirtyDependencyRecoveryStatus(operation, quiescedStatus)) {
      this.retainChangedDependencyRecoveryStatus(operation, quiescedStatus);
      return false;
    }

    operation.phase = "validating";
    mutation.phase = "validating";
    let validation;
    try {
      validation = await this.runDependencyGuardValidation(target.environment, target.token);
    } catch (error) {
      operation.phase = "uncertain";
      const report = this.isAuthorizedDependencyRecoveryOperation(operation, target.environment);
      this.retainDependencyRecoveryFailure(operation, error);
      if (!this.disposed && report) {
        void vscode.window.showErrorMessage(dependencyGuardRecoveryGuidance(error));
      }
      return false;
    }
    if (
      validation.token !== target.token ||
      !this.isAuthorizedDependencyRecoveryOperation(operation, target.environment)
    ) {
      return false;
    }
    if (!this.clearExactDependencyEnvironmentUncertainty(target)) return false;
    if (this.disposed) return false;
    void vscode.window.showInformationMessage("Open Wrangler runtime dependencies were revalidated.");
    return true;
  }

  private exactDependencyRecoveryTarget(): DependencyRecoveryTarget | undefined {
    const retained = [...this.dependencyEnvironmentUncertainty.values()].filter(
      (uncertainty): uncertainty is DependencyRecoveryTarget =>
        uncertainty.token !== undefined &&
        uncertainty.selection !== undefined &&
        uncertainty.selectionEpoch !== undefined
    );
    for (const target of retained.reverse()) {
      const currentSelection = this.environmentSelections.get(target.selection.key);
      if (
        this.dependencyEnvironmentUncertainty.get(pythonEnvironmentIdentityKey(target.environment)) === target &&
        (currentSelection === target.selection ||
          (target.selectionDetached === true && currentSelection === undefined)) &&
        target.selection.epoch === target.selectionEpoch &&
        target.selection.resolvedEnvironment !== undefined &&
        pythonEnvironmentIdentityKey(target.selection.resolvedEnvironment) ===
          pythonEnvironmentIdentityKey(target.environment)
      ) {
        return target;
      }
    }
    return undefined;
  }

  private isCurrentDependencyRecoveryTarget(
    operation: DependencyRecoveryOperation,
    requireCurrentSelection: boolean
  ): boolean {
    const target = operation.target;
    if (
      !target ||
      this.disposed ||
      !vscode.workspace.isTrusted ||
      this.dependencyRecoveryOperation !== operation ||
      target.selection.epoch !== target.selectionEpoch ||
      this.dependencyEnvironmentUncertainty.get(pythonEnvironmentIdentityKey(target.environment)) !== target ||
      target.selection.resolvedEnvironment === undefined ||
      pythonEnvironmentIdentityKey(target.selection.resolvedEnvironment) !==
        pythonEnvironmentIdentityKey(target.environment)
    ) {
      return false;
    }
    const currentSelection = this.environmentSelections.get(target.selection.key);
    return requireCurrentSelection
      ? currentSelection === target.selection || (target.selectionDetached === true && currentSelection === undefined)
      : currentSelection === undefined || currentSelection === target.selection;
  }

  private async freshDependencyRecoveryEnvironment(
    operation: DependencyRecoveryOperation,
    requireCurrentSelection: boolean
  ): Promise<PythonEnvironment | undefined> {
    const target = operation.target;
    if (!target || !this.isCurrentDependencyRecoveryTarget(operation, requireCurrentSelection)) return undefined;
    let environment: PythonEnvironment;
    try {
      environment = await resolvePythonEnvironment(this.context, target.selection.resource, this.environmentApiBroker, {
        isCurrent: () => this.isCurrentDependencyRecoveryTarget(operation, requireCurrentSelection),
        isTrusted: () => vscode.workspace.isTrusted
      });
    } catch {
      return undefined;
    }
    if (
      !this.isCurrentDependencyRecoveryTarget(operation, requireCurrentSelection) ||
      pythonEnvironmentIdentityKey(environment) !== pythonEnvironmentIdentityKey(target.environment)
    ) {
      return undefined;
    }
    return environment;
  }

  private isAuthorizedDependencyRecoveryOperation(
    operation: DependencyRecoveryOperation,
    environment: PythonEnvironment
  ): boolean {
    const target = operation.target;
    const mutation = operation.mutation;
    return (
      target !== undefined &&
      mutation !== undefined &&
      operation.authorizationEpoch !== undefined &&
      operation.authorizationSelection === target.selection &&
      this.dependencyAuthorizationEpoch === operation.authorizationEpoch &&
      this.isCurrentDependencyRecoveryTarget(operation, false) &&
      pythonEnvironmentIdentityKey(environment) === pythonEnvironmentIdentityKey(target.environment) &&
      mutation.mutationKey === pythonPackageEnvironmentKey(target.environment) &&
      this.dependencyMutations.get(mutation.mutationKey) === mutation
    );
  }

  private async freshAuthorizedDependencyRecoveryEnvironment(
    operation: DependencyRecoveryOperation
  ): Promise<PythonEnvironment | undefined> {
    const target = operation.target;
    if (!target || !this.isAuthorizedDependencyRecoveryOperation(operation, target.environment)) return undefined;
    let environment: PythonEnvironment;
    try {
      environment = await resolvePythonEnvironment(this.context, target.selection.resource, this.environmentApiBroker, {
        isCurrent: () => this.isAuthorizedDependencyRecoveryOperation(operation, target.environment),
        isTrusted: () => vscode.workspace.isTrusted
      });
    } catch {
      return undefined;
    }
    return this.isAuthorizedDependencyRecoveryOperation(operation, environment) ? environment : undefined;
  }

  private async readDependencyRecoveryStatus(
    operation: DependencyRecoveryOperation,
    environment: PythonEnvironment
  ): Promise<DependencyGuardStatus | undefined> {
    try {
      return await this.dependencyGuardStatusForEnvironment(environment);
    } catch (error) {
      const report =
        operation.authorizationEpoch === undefined
          ? this.isCurrentDependencyRecoveryTarget(operation, true)
          : this.isAuthorizedDependencyRecoveryOperation(operation, environment);
      if (report) this.retainDependencyRecoveryFailure(operation, error);
      if (report && !this.disposed) {
        void vscode.window.showErrorMessage(dependencyGuardRecoveryGuidance(error));
      }
      return undefined;
    }
  }

  private isSameDirtyDependencyRecoveryStatus(
    operation: DependencyRecoveryOperation,
    status: DependencyGuardStatus
  ): boolean {
    return Boolean(operation.target && status.state === "dirty" && status.token === operation.target.token);
  }

  private retainChangedDependencyRecoveryStatus(
    operation: DependencyRecoveryOperation,
    status: DependencyGuardStatus
  ): void {
    const target = operation.target;
    if (
      !target ||
      this.dependencyEnvironmentUncertainty.get(pythonEnvironmentIdentityKey(target.environment)) !== target
    ) {
      return;
    }
    if (status.state === "clean") {
      this.dependencyEnvironmentUncertainty.delete(pythonEnvironmentIdentityKey(target.environment));
      return;
    }
    if (status.token === target.token) return;
    this.markDependencyEnvironmentUncertain(
      target.environment,
      status.token,
      "The dependency recovery marker changed before validation.",
      target.selection,
      operation.authorizationEpoch !== undefined
    );
  }

  private retainDependencyRecoveryFailure(operation: DependencyRecoveryOperation, error: unknown): void {
    const target = operation.target;
    if (
      !target ||
      this.dependencyEnvironmentUncertainty.get(pythonEnvironmentIdentityKey(target.environment)) !== target
    ) {
      return;
    }
    this.markDependencyEnvironmentUncertain(
      target.environment,
      target.token,
      error,
      target.selection,
      operation.authorizationEpoch !== undefined
    );
  }

  private clearExactDependencyEnvironmentUncertainty(target: DependencyRecoveryTarget): boolean {
    const key = pythonEnvironmentIdentityKey(target.environment);
    if (this.dependencyEnvironmentUncertainty.get(key) !== target) return false;
    this.dependencyEnvironmentUncertainty.delete(key);
    return true;
  }

  private finishDependencyRecoveryOperation(operation: DependencyRecoveryOperation): void {
    if (operation.phase === "settled") return;
    const mutation = operation.mutation;
    const release = (): void => {
      if (mutation) this.releaseDependencyInstallOperation(mutation);
      operation.phase = "settled";
      if (this.dependencyRecoveryOperation === operation) this.dependencyRecoveryOperation = undefined;
    };
    if (mutation?.phase === "uncertain" && mutation.quiescence) {
      void mutation.quiescence.then(release);
      return;
    }
    release();
  }

  private beginDependencyInstallation(): Promise<boolean> {
    if (this.disposed) {
      return Promise.reject(new Error("Open Wrangler cannot install dependencies after its runtime bridge disposed."));
    }
    if (this.dependencyRecoveryOperation && this.dependencyRecoveryOperation.phase !== "settled") {
      return Promise.resolve(false);
    }
    const existing = this.dependencyInstallOperation;
    if (existing?.promise) return existing.promise;
    const operation: DependencyInstallOperation = { phase: "confirming" };
    this.dependencyInstallOperation = operation;
    const installation = this.installMissingDependenciesWithDecision(operation);
    operation.promise = installation;
    const finish = (): void => this.finishDependencyInstallOperation(operation);
    void installation.then(finish, finish);
    return installation;
  }

  private async installMissingDependenciesWithDecision(operation: DependencyInstallOperation): Promise<boolean> {
    const missing = this.lastMissingDependencies;
    if (!missing || missing.requirements.length === 0) {
      if (!this.disposed) {
        void vscode.window.showInformationMessage("Open Wrangler has no unresolved runtime dependencies.");
      }
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      if (!this.disposed) {
        void vscode.window.showErrorMessage("Trust this workspace before installing Python dependencies.");
      }
      return false;
    }
    const runtime = this.runtimeSlot(missing.selection.key);
    operation.runtime = runtime;
    operation.releaseRuntime = this.retainRuntime(runtime);
    const executable = missing.environment.executable;
    const dependencies = missing.dependencies.map((dependency) => ({ ...dependency }));
    const requirements = [...missing.requirements];
    operation.executable = executable;
    operation.dependencies = dependencies;
    operation.requirements = requirements;
    if (!this.isCurrentDependencyInstallTarget(missing, executable, requirements)) {
      this.reportInvalidDependencyInstallTarget();
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      `Install ${requirements.join(", ")} into ${executable}?`,
      { modal: true, detail: "Open Wrangler never installs packages without this confirmation." },
      "Install"
    );
    if (choice !== "Install") return false;
    if (!this.isCurrentDependencyInstallTarget(missing, executable, requirements)) {
      this.reportInvalidDependencyInstallTarget();
      return false;
    }

    let installationStarted = false;
    const completed = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing Open Wrangler dependencies" },
      async () => {
        if (!this.isCurrentDependencyInstallTarget(missing, executable, requirements)) return false;
        operation.authorizationEpoch = this.dependencyAuthorizationEpoch;
        operation.authorizationSelection = missing.selection;
        try {
          await this.beginDependencyMutation(operation, missing.environment);
        } catch (error) {
          if (!this.disposed) {
            operation.phase = "uncertain";
            operation.uncertainty = error;
          }
          throw error;
        }
        if (
          this.disposed ||
          !operation.mutationKey ||
          this.dependencyMutations.get(operation.mutationKey) !== operation
        ) {
          return false;
        }
        if (!(await this.revalidateDependencyInstallAuthorization(operation, missing, executable, requirements))) {
          return false;
        }

        operation.phase = "starting";
        const process = this.launchDependencyInstall(missing.environment, dependencies, {
          helperPath: this.dependencyGuardHelperPath()
        });
        operation.process = process;
        installationStarted = true;

        let writesAuthorized = false;
        let abortAttempted = false;
        const abortBeforeWrites = (): void => {
          if (writesAuthorized || abortAttempted) return;
          abortAttempted = true;
          try {
            process.abortBeforeWrites();
          } catch (error) {
            this.output.appendLine(
              `Dependency guard pre-write abort failed for ${executable}: ${dependencyGuardFailureReason(error)}`
            );
          }
        };
        try {
          const ready = await process.ready;
          operation.phase = "ready";
          if (ready.token !== process.token) {
            throw new Error("The dependency guard READY token did not match its owned install operation.");
          }
          if (!(await this.revalidateDependencyInstallAuthorization(operation, missing, executable, requirements))) {
            return false;
          }
          process.authorizeWrites();
          writesAuthorized = true;
          operation.phase = "mutating";
        } catch (error) {
          abortBeforeWrites();
          if (this.disposed) return false;
          throw error;
        } finally {
          abortBeforeWrites();
        }

        try {
          await this.waitForDependencyInstallExit(process, DEPENDENCY_INSTALL_TIMEOUT_MS);
        } catch (error) {
          operation.phase = "uncertain";
          operation.uncertainty ??= error;
          if (this.disposed) return false;
          throw operation.uncertainty;
        }
        try {
          await process.completion;
        } catch (error) {
          this.markDependencyEnvironmentUncertain(missing.environment, process.token, error, missing.selection, true);
          if (this.disposed) return false;
          throw error;
        }

        operation.phase = "validating";
        this.markDependencyEnvironmentUncertain(
          missing.environment,
          process.token,
          "The dependency install exited but its exact environment has not been validated yet.",
          missing.selection,
          true
        );
        if (this.disposed) return false;
        try {
          const validation = await this.runDependencyGuardValidation(missing.environment, process.token);
          if (validation.token !== process.token) {
            throw new Error("The dependency guard validation token did not match its owned install operation.");
          }
          this.clearDependencyEnvironmentUncertainty(missing.environment, process.token);
        } catch (error) {
          operation.phase = "uncertain";
          this.markDependencyEnvironmentUncertain(missing.environment, process.token, error, missing.selection, true);
          if (this.disposed) return false;
          throw error;
        }
        return !this.disposed;
      }
    );
    if (!installationStarted) {
      this.reportInvalidDependencyInstallTarget();
      return false;
    }
    if (!completed || this.disposed) return false;

    const currentTarget = this.lastMissingDependencies;
    this.releaseDependencyInstallOperation(operation);
    if (!currentTarget) {
      void vscode.window.showInformationMessage("Open Wrangler runtime dependencies were installed.");
    } else {
      void vscode.window.showInformationMessage(
        `Installed ${requirements.join(", ")} into ${executable}, but the dependency target changed before installation completed. Reopen the source to validate the current interpreter.`
      );
    }
    return true;
  }

  private async beginDependencyMutation(
    operation: DependencyInstallOperation,
    environment: PythonEnvironment
  ): Promise<void> {
    const mutationKey = pythonPackageEnvironmentKey(environment);
    const existing = this.dependencyMutations.get(mutationKey);
    if (existing && existing !== operation) {
      throw new Error(`Open Wrangler is already changing Python dependencies in ${environment.executable}.`);
    }
    operation.mutationKey = mutationKey;
    this.dependencyMutations.set(mutationKey, operation);
    operation.phase = "quiescing";

    const stops = this.invalidateDependencyStateForEnvironment(
      environment,
      "Python dependencies are changing; stopping the Open Wrangler runtime before package writes begin."
    );
    operation.quiescence = Promise.all(stops.map((stop) => stop.exit)).then(() => undefined);
    const results = await Promise.allSettled(stops.map((stop) => stop.shutdown));
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Open Wrangler could not confirm that every runtime using the selected Python environment stopped."
      );
    }
  }

  private invalidateDependencyStateForEnvironment(
    environment: PythonEnvironment,
    reason: string
  ): StoppingRuntimeProcess[] {
    const packageEnvironmentKey = pythonPackageEnvironmentKey(environment);
    this.invalidateDependencyProbesForPackageEnvironment(packageEnvironmentKey);
    const affected = new Set(
      [...this.environmentSelections.values()]
        .filter(
          (selection) =>
            selection.resolvedEnvironment &&
            pythonPackageEnvironmentKey(selection.resolvedEnvironment) === packageEnvironmentKey
        )
        .map((selection) => selection.key)
    );
    for (const activeRuntime of this.runtimeSlots.values()) {
      const runtimeEnvironment =
        activeRuntime.processSelection?.environment ?? activeRuntime.processStartSelection?.environment;
      if (runtimeEnvironment && pythonPackageEnvironmentKey(runtimeEnvironment) === packageEnvironmentKey) {
        affected.add(activeRuntime.key);
      }
      if (
        [...activeRuntime.stoppingProcesses.values()].some(
          (stopping) => stopping.packageEnvironmentKey === packageEnvironmentKey
        )
      ) {
        affected.add(activeRuntime.key);
      }
    }
    if (affected.size > 0) this.invalidateSelectionScopes(affected, reason, true);
    return [...this.runtimeSlots.values()].flatMap((runtime) =>
      [...runtime.stoppingProcesses.values()].filter(
        (stopping) => stopping.packageEnvironmentKey === packageEnvironmentKey
      )
    );
  }

  private finishDependencyInstallOperation(operation: DependencyInstallOperation): void {
    const confirmation =
      operation.process?.exit ?? (operation.phase === "uncertain" ? operation.quiescence : undefined);
    if (confirmation) {
      void confirmation.then(() => this.releaseDependencyInstallOperation(operation));
      return;
    }
    this.releaseDependencyInstallOperation(operation);
  }

  private releaseDependencyInstallOperation(operation: DependencyInstallOperation): void {
    if (operation.phase === "settled") return;
    operation.phase = "settled";
    if (operation.mutationKey && this.dependencyMutations.get(operation.mutationKey) === operation) {
      this.dependencyMutations.delete(operation.mutationKey);
    }
    const release = operation.releaseRuntime;
    operation.releaseRuntime = undefined;
    release?.();
    if (this.dependencyInstallOperation === operation) this.dependencyInstallOperation = undefined;
  }

  private isCurrentDependencyInstallTarget(
    missing: MissingDependencies,
    executable: string,
    requirements: readonly string[]
  ): boolean {
    return (
      !this.disposed &&
      vscode.workspace.isTrusted &&
      this.isCurrentEnvironmentSelection(missing.selection) &&
      missing.selectionEpoch === missing.selection.epoch &&
      this.lastMissingDependencies === missing &&
      missing.environment.executable === executable &&
      missing.dependencies.length === requirements.length &&
      missing.dependencies.every((dependency, index) => dependency.installSpec === requirements[index]) &&
      missing.requirements.length === requirements.length &&
      missing.requirements.every((requirement, index) => requirement === requirements[index])
    );
  }

  private async revalidateDependencyInstallAuthorization(
    operation: DependencyInstallOperation,
    missing: MissingDependencies,
    executable: string,
    requirements: readonly string[]
  ): Promise<boolean> {
    const authorizationEpoch = operation.authorizationEpoch;
    if (
      authorizationEpoch === undefined ||
      !this.isDependencyInstallOperationAuthorized(operation, executable, requirements, authorizationEpoch)
    ) {
      return false;
    }

    let currentEnvironment: PythonEnvironment;
    try {
      currentEnvironment = await resolvePythonEnvironment(
        this.context,
        missing.selection.resource,
        this.environmentApiBroker,
        {
          isCurrent: () =>
            authorizationEpoch !== undefined &&
            this.isDependencyInstallOperationAuthorized(operation, executable, requirements, authorizationEpoch),
          isTrusted: () => vscode.workspace.isTrusted
        }
      );
    } catch {
      return false;
    }
    return (
      this.isDependencyInstallOperationAuthorized(operation, executable, requirements, authorizationEpoch) &&
      pythonDependenciesEqual(operation.dependencies ?? [], missing.dependencies) &&
      pythonEnvironmentIdentityKey(currentEnvironment) === pythonEnvironmentIdentityKey(missing.environment) &&
      pythonPackageEnvironmentKey(currentEnvironment) === operation.mutationKey
    );
  }

  private isDependencyInstallOperationAuthorized(
    operation: DependencyInstallOperation,
    executable: string,
    requirements: readonly string[],
    authorizationEpoch: number
  ): boolean {
    return (
      !this.disposed &&
      vscode.workspace.isTrusted &&
      this.dependencyInstallOperation === operation &&
      operation.authorizationEpoch === authorizationEpoch &&
      this.dependencyAuthorizationEpoch === authorizationEpoch &&
      operation.executable === executable &&
      operation.dependencies !== undefined &&
      operation.requirements?.length === requirements.length &&
      operation.requirements.every((requirement, index) => requirement === requirements[index]) &&
      Boolean(operation.mutationKey) &&
      this.dependencyMutations.get(operation.mutationKey!) === operation
    );
  }

  private reportInvalidDependencyInstallTarget(): void {
    if (this.disposed) return;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage("Trust this workspace before installing Python dependencies.");
      return;
    }
    void vscode.window.showInformationMessage(
      "The selected Python runtime or its missing dependencies changed before installation. Run Install Runtime Dependencies again."
    );
  }

  dispose(): void {
    void this.shutdown().catch(() => undefined);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownBridge();
    return this.shutdownPromise;
  }

  private async shutdownBridge(): Promise<void> {
    this.disposed = true;
    for (const controller of this.excelSheetReads ?? []) {
      controller.abort(new Error("Open Wrangler runtime bridge disposed during Excel worksheet discovery."));
    }
    const dependencyInstall = this.dependencyInstallOperation;
    const failures: unknown[] = [];
    const dependencyGuardCommands = [...(this.activeDependencyGuardCommands ?? [])];
    for (const command of dependencyGuardCommands) {
      try {
        command.unref();
      } catch (error) {
        failures.push(error);
      }
    }
    const selectionKeys = new Set([
      ...this.environmentSelections.keys(),
      ...(this.lastMissingDependencies ? [this.lastMissingDependencies.selection.key] : [])
    ]);
    if (selectionKeys.size > 0) {
      this.selectionEpoch += 1;
      for (const key of selectionKeys) {
        this.selectionEpochs.set(key, (this.selectionEpochs.get(key) ?? 0) + 1);
      }
    }
    for (const selection of this.environmentSelections.values()) {
      this.abortEnvironmentSelection(selection, new PythonEnvironmentResolutionDisposedError());
    }
    this.environmentSelections.clear();
    this.invalidateAllDependencyProbes();
    this.lastMissingDependencies = undefined;

    try {
      this.configurationSubscription.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.environmentApiBroker?.dispose();
    } catch (error) {
      failures.push(error);
    }
    const runtimes = [...this.runtimeSlots.values()];
    const runtimeStartFailures: unknown[] = [];
    for (const runtime of runtimes) {
      try {
        this.stopRuntime(runtime, "Open Wrangler runtime stopped.");
      } catch (error) {
        runtimeStartFailures.push(error);
      }
    }

    let dependencyInstallExit: Promise<void> | undefined;
    if (dependencyInstall?.process) {
      if (!dependencyInstall.process.didAuthorize()) {
        try {
          dependencyInstall.process.abortBeforeWrites();
        } catch (error) {
          this.output.appendLine(
            `Dependency guard pre-write abort during shutdown failed: ${dependencyGuardFailureReason(error)}`
          );
        }
      }
      if (dependencyInstall.uncertainty) {
        dependencyInstallExit = Promise.reject(dependencyInstall.uncertainty);
      } else {
        dependencyInstallExit = this.waitForDependencyInstallExit(
          dependencyInstall.process,
          DEPENDENCY_INSTALL_SHUTDOWN_WAIT_MS
        ).catch((error: unknown) => {
          dependencyInstall.phase = "uncertain";
          dependencyInstall.uncertainty ??= error;
          throw dependencyInstall.uncertainty;
        });
      }
    }
    const [dependencyInstallResult, ...runtimeStopResults] = await Promise.allSettled([
      dependencyInstallExit ?? Promise.resolve(),
      ...runtimes.map((runtime) => runtime.processStop ?? Promise.resolve())
    ]);
    if (dependencyInstallResult.status === "rejected") failures.push(dependencyInstallResult.reason);
    failures.push(...runtimeStartFailures);
    for (const result of runtimeStopResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    try {
      this.output.dispose();
    } catch (error) {
      failures.push(error);
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Open Wrangler Python bridge shutdown encountered multiple failures.");
    }
  }

  private runtimeSlot(key: string): RuntimeSlot {
    const existing = this.runtimeSlots.get(key);
    if (existing) {
      this.markScopeUsed(key);
      return existing;
    }
    const runtime: RuntimeSlot = {
      key,
      pendingIds: new Set(),
      provisionalSessionIds: new Set(),
      sessionIds: new Set(),
      stoppingProcesses: new Map(),
      leaseCount: 0,
      process: undefined,
      processStart: undefined,
      processSelection: undefined,
      processStartSelection: undefined,
      processStop: undefined,
      runtimeExitError: undefined,
      stderrBuffer: "",
      runtimeEpoch: 0
    };
    this.runtimeSlots.set(key, runtime);
    this.markScopeUsed(key);
    return runtime;
  }

  private markScopeUsed(key: string): void {
    this.scopeUseClock += 1;
    this.scopeRecency.set(key, this.scopeUseClock);
  }

  private retainRuntime(runtime: RuntimeSlot): () => void {
    if (this.runtimeSlots.get(runtime.key) !== runtime) {
      throw new Error(`Open Wrangler refused to lease detached Python scope ${runtime.key}.`);
    }
    runtime.leaseCount += 1;
    this.markScopeUsed(runtime.key);
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      runtime.leaseCount = Math.max(0, runtime.leaseCount - 1);
      if (this.runtimeSlots.get(runtime.key) === runtime) this.trimInactiveScopes();
    };
  }

  private trimInactiveScopes(): void {
    const retainedKeys = (): Set<string> =>
      new Set([
        ...this.runtimeSlots.keys(),
        ...this.environmentSelections.keys(),
        ...this.selectionEpochs.keys(),
        ...this.scopeRecency.keys()
      ]);
    let keys = retainedKeys();
    while (keys.size > MAX_RETAINED_INACTIVE_SCOPES) {
      const ordered = [...keys].sort(
        (left, right) =>
          (this.scopeRecency.get(left) ?? 0) - (this.scopeRecency.get(right) ?? 0) || left.localeCompare(right)
      );
      let evicted = false;
      for (const key of ordered) {
        const runtime = this.runtimeSlots.get(key);
        if (runtime ? this.evictInactiveScope(runtime) : this.evictOrphanedScope(key)) {
          evicted = true;
          break;
        }
      }
      if (!evicted) return;
      keys = retainedKeys();
    }
  }

  private evictInactiveScope(runtime: RuntimeSlot): boolean {
    if (this.runtimeSlots.get(runtime.key) !== runtime || !this.isInactiveScope(runtime)) return false;

    const selection = this.environmentSelections.get(runtime.key);
    const selectionEpoch = this.selectionEpochs.get(runtime.key);
    const recency = this.scopeRecency.get(runtime.key);
    if (!this.runtimeSlots.delete(runtime.key)) return false;
    if (selection && this.environmentSelections.get(runtime.key) === selection) {
      this.abortEnvironmentSelection(selection, new PythonEnvironmentResolutionSupersededError());
      this.environmentSelections.delete(runtime.key);
    }
    if (this.selectionEpochs.get(runtime.key) === selectionEpoch) {
      this.selectionEpochs.delete(runtime.key);
    }
    if (this.scopeRecency.get(runtime.key) === recency) {
      this.scopeRecency.delete(runtime.key);
    }
    runtime.stderrBuffer = "";
    runtime.runtimeExitError = undefined;
    runtime.processSelection = undefined;
    runtime.processStartSelection = undefined;
    return true;
  }

  private evictOrphanedScope(key: string): boolean {
    if (this.runtimeSlots.has(key)) return false;
    const selection = this.environmentSelections.get(key);
    // A selection without its owning slot violates the scope-retention
    // invariant. Its promise may still be resolving, so fail closed rather than
    // guessing that it is safe to detach.
    if (selection) return false;
    if (this.lastMissingDependencies?.selection.key === key) return false;
    const selectionEpoch = this.selectionEpochs.get(key);
    const recency = this.scopeRecency.get(key);
    if (this.selectionEpochs.get(key) === selectionEpoch) {
      this.selectionEpochs.delete(key);
    }
    if (this.scopeRecency.get(key) === recency) {
      this.scopeRecency.delete(key);
    }
    return true;
  }

  private isInactiveScope(runtime: RuntimeSlot): boolean {
    const selection = this.environmentSelections.get(runtime.key);
    if (
      runtime.leaseCount > 0 ||
      runtime.process ||
      runtime.processStart ||
      runtime.processStop ||
      runtime.processSelection ||
      runtime.processStartSelection ||
      runtime.stoppingProcesses.size > 0 ||
      runtime.pendingIds.size > 0 ||
      runtime.provisionalSessionIds.size > 0 ||
      runtime.sessionIds.size > 0 ||
      Boolean(this.lastMissingDependencies && this.lastMissingDependencies.selection === selection)
    ) {
      return false;
    }
    for (const pending of this.pending.values()) {
      if (pending.runtime === runtime) return false;
    }
    for (const reservation of this.provisionalSessions.values()) {
      if (reservation.runtime === runtime) return false;
    }
    for (const owner of this.sessionOwners.values()) {
      if (owner === runtime) return false;
    }
    for (const target of this.cancellationTargets.values()) {
      if (target.runtime === runtime) return false;
    }
    return true;
  }

  private restartRuntime(runtime: RuntimeSlot, reason: string): void {
    this.stopRuntime(runtime, reason, 0);
  }

  private stopRuntime(runtime: RuntimeSlot, reason: string, gracefulTimeoutMs?: number): void {
    try {
      this.output.appendLine(`${reason} [Python scope: ${runtime.key}]`);
    } catch {
      // Lifecycle cleanup must continue even if the diagnostic channel is unavailable.
    }
    runtime.runtimeEpoch += 1;
    const proc = runtime.process;
    const packageEnvironmentKey = runtime.processSelection
      ? pythonPackageEnvironmentKey(runtime.processSelection.environment)
      : undefined;
    if (proc) this.trackProcessStop(runtime, proc, gracefulTimeoutMs, packageEnvironmentKey);
    runtime.process = undefined;
    runtime.processStart = undefined;
    runtime.processSelection = undefined;
    runtime.processStartSelection = undefined;
    runtime.runtimeExitError = undefined;
    this.releaseRuntimeSessionState(runtime);
    this.rejectRuntime(runtime, new Error(reason));
    this.trimInactiveScopes();
  }

  private stopRuntimeIfIdle(runtime: RuntimeSlot): void {
    if (runtime.sessionIds.size > 0 || runtime.provisionalSessionIds.size > 0 || runtime.pendingIds.size > 0) {
      return;
    }
    if (runtime.process || runtime.processStart) {
      this.stopRuntime(runtime, "Open Wrangler runtime stopped after its last session closed.");
    } else {
      this.trimInactiveScopes();
    }
  }

  private async ensureProcess(
    runtime: RuntimeSlot,
    desired: ProcessSelection
  ): Promise<ChildProcessWithoutNullStreams> {
    const release = this.retainRuntime(runtime);
    try {
      return await this.ensureProcessRetained(runtime, desired);
    } finally {
      release();
    }
  }

  private async ensureProcessRetained(
    runtime: RuntimeSlot,
    desired: ProcessSelection
  ): Promise<ChildProcessWithoutNullStreams> {
    this.assertDependencyEnvironmentAvailable(desired.environment);
    const initialEpoch = runtime.runtimeEpoch;
    const stopping = runtime.processStop;
    if (stopping && !runtime.process && !runtime.processStart) {
      try {
        await stopping;
      } catch (error) {
        throw new Error(
          `Open Wrangler could not confirm shutdown of its previous Python runtime: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (this.disposed || initialEpoch !== runtime.runtimeEpoch) {
        throw new Error("Open Wrangler runtime start was cancelled.");
      }
    }
    for (;;) {
      this.assertDependencyEnvironmentAvailable(desired.environment);
      if (!this.isCurrentEnvironmentSelection(desired.selection)) {
        throw new Error("Open Wrangler runtime selection changed before process startup.");
      }
      if (runtime.process) {
        if (
          runtime.processSelection?.selection === desired.selection &&
          samePythonExecutable(runtime.processSelection.environment.executable, desired.environment.executable)
        ) {
          return runtime.process;
        }
        this.stopRuntime(
          runtime,
          `Python environment changed from ${runtime.processSelection?.environment.executable ?? "unknown"} to ${desired.environment.executable}; rotating the Open Wrangler runtime.`
        );
      }
      const pendingStart = runtime.processStart;
      if (pendingStart) {
        try {
          const proc = await pendingStart;
          if (
            runtime.processStartSelection?.selection === desired.selection ||
            runtime.processSelection?.selection === desired.selection
          ) {
            return proc;
          }
        } catch (error) {
          if (!this.isCurrentEnvironmentSelection(desired.selection)) {
            throw new Error("Open Wrangler runtime selection changed while process startup was pending.");
          }
          throw error;
        }
        continue;
      }
      if (runtime.processStop) {
        try {
          await runtime.processStop;
        } catch (error) {
          throw new Error(
            `Open Wrangler could not confirm shutdown of its previous Python runtime: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        continue;
      }

      const epoch = runtime.runtimeEpoch;
      const start = this.startProcess(runtime, epoch, desired);
      runtime.processStart = start;
      runtime.processStartSelection = desired;
      try {
        return await start;
      } finally {
        if (runtime.processStart === start) {
          runtime.processStart = undefined;
          runtime.processStartSelection = undefined;
        }
      }
    }
  }

  private async startProcess(
    runtime: RuntimeSlot,
    epoch: number,
    processSelection: ProcessSelection
  ): Promise<ChildProcessWithoutNullStreams> {
    const release = this.retainRuntime(runtime);
    try {
      return await this.startProcessRetained(runtime, epoch, processSelection);
    } finally {
      release();
    }
  }

  private async startProcessRetained(
    runtime: RuntimeSlot,
    epoch: number,
    processSelection: ProcessSelection
  ): Promise<ChildProcessWithoutNullStreams> {
    this.assertDependencyEnvironmentAvailable(processSelection.environment);
    const stopping = runtime.processStop;
    if (stopping) {
      try {
        await stopping;
      } catch (error) {
        throw new Error(
          `Open Wrangler could not confirm shutdown of its previous Python runtime: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (stopping && (this.disposed || epoch !== runtime.runtimeEpoch)) {
      throw new Error("Open Wrangler runtime start was cancelled.");
    }
    if (
      runtime.process &&
      runtime.processSelection?.selection === processSelection.selection &&
      samePythonExecutable(runtime.processSelection.environment.executable, processSelection.environment.executable)
    ) {
      return runtime.process;
    }

    runtime.runtimeExitError = undefined;
    runtime.stderrBuffer = "";

    const environment = processSelection.environment;
    if (
      this.disposed ||
      epoch !== runtime.runtimeEpoch ||
      !this.isCurrentEnvironmentSelection(processSelection.selection)
    ) {
      throw new Error("Open Wrangler runtime start was cancelled.");
    }
    this.assertDependencyEnvironmentAvailable(environment);
    if (runtime.process) {
      if (
        runtime.processSelection?.selection === processSelection.selection &&
        samePythonExecutable(runtime.processSelection.environment.executable, environment.executable)
      ) {
        return runtime.process;
      }
      throw new Error("A different Open Wrangler Python runtime became active during process startup.");
    }
    const pythonPath = environment.executable;
    if (!isFullyQualifiedPythonPath(pythonPath)) {
      throw new Error("Open Wrangler runtime startup requires an absolute Python executable path.");
    }
    const runtimeRoot = path.join(this.context.extensionPath, "python");

    const proc = this.spawnProcess(pythonPath, ["-s", "-m", "openwrangler_runtime.server"], {
      cwd: this.context.extensionPath,
      env: {
        ...buildPythonProcessEnvironment(),
        PYTHONPATH: runtimeRoot
      },
      shell: false,
      windowsHide: true
    });
    this.generation += 1;
    this.output.appendLine(
      `Starting protocol v2 runtime with ${pythonPath} (Python ${environment.version}, ${environment.source}, generation ${this.generation}, scope ${runtime.key}).`
    );

    const reader = readline.createInterface({ input: proc.stdout });
    reader.on("line", (line) => this.handleRuntimeLine(runtime, proc, line));
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      runtime.stderrBuffer = `${runtime.stderrBuffer}${text}`.slice(-8000);
      this.output.append(text);
    });
    proc.on("error", (error) =>
      this.handleProcessFailure(runtime, proc, this.runtimeUnavailableError(runtime, error, pythonPath))
    );
    proc.on("exit", (code, signal) => {
      reader.close();
      this.handleProcessFailure(
        runtime,
        proc,
        this.runtimeUnavailableError(
          runtime,
          new Error(`Runtime exited with code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}.`),
          pythonPath
        )
      );
    });

    runtime.process = proc;
    runtime.processSelection = processSelection;
    return proc;
  }

  private trackProcessStop(
    runtime: RuntimeSlot,
    proc: ChildProcessWithoutNullStreams,
    gracefulTimeoutMs?: number,
    packageEnvironmentKey?: string
  ): void {
    const release = this.retainRuntime(runtime);
    const current = stopChildProcessGracefully(proc, gracefulTimeoutMs);
    const exactExit = waitForRuntimeProcessExit(proc);
    const previous = runtime.processStop;
    const stopping = previous ? joinProcessStops(previous, current) : current;
    runtime.stoppingProcesses.set(proc, { packageEnvironmentKey, shutdown: current, exit: exactExit });
    runtime.processStop = stopping;
    let owned = true;
    const releaseOwnedStop = (): void => {
      if (!owned) return;
      owned = false;
      runtime.stoppingProcesses.delete(proc);
      if (runtime.stoppingProcesses.size === 0) runtime.processStop = undefined;
      release();
    };
    void exactExit.then(releaseOwnedStop);
    void current.then(releaseOwnedStop, (error: unknown) => {
      try {
        this.output.appendLine(
          `Open Wrangler could not confirm Python runtime shutdown: ${error instanceof Error ? error.message : String(error)}`
        );
      } catch {
        // Disposal may close the output channel before a bounded shutdown settles.
      }
    });
    void stopping.catch(() => undefined);
  }

  private handleProcessFailure(runtime: RuntimeSlot, proc: ChildProcessWithoutNullStreams, error: Error): void {
    if (runtime.process !== proc) return;
    runtime.runtimeExitError = error;
    runtime.process = undefined;
    runtime.processSelection = undefined;
    this.releaseRuntimeSessionState(runtime);
    this.output.appendLine(error.message);
    this.rejectRuntime(runtime, error);
    this.trimInactiveScopes();
  }

  private handleRuntimeLine(runtime: RuntimeSlot, proc: ChildProcessWithoutNullStreams, line: string): void {
    if (runtime.process !== proc) return;
    let envelope: RuntimeResponseEnvelope;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRuntimeResponseEnvelope(parsed)) {
        throw new Error("Response does not match the protocol v2 envelope.");
      }
      envelope = parsed;
    } catch (error) {
      this.output.appendLine(`Invalid runtime response: ${line}`);
      this.output.appendLine(error instanceof Error ? error.message : String(error));
      return;
    }

    const cancellationTarget = this.cancellationTargets.get(envelope.requestId);
    if (cancellationTarget) {
      if (cancellationTarget.runtime !== runtime) {
        this.output.appendLine(
          `Ignored a cancellation response from Python scope ${runtime.key} owned by ${cancellationTarget.runtime.key}.`
        );
        return;
      }
      this.cancellationTargets.delete(envelope.requestId);
      const target = this.pending.get(cancellationTarget.targetRequestId);
      if (target?.cancellationRequestId === envelope.requestId) target.cancellationRequestId = undefined;
      if (
        envelope.response.kind === "cancelled" &&
        envelope.response.targetRequestId === cancellationTarget.targetRequestId
      ) {
        this.output.appendLine(
          `Open Wrangler runtime accepted cancellation for queued request ${cancellationTarget.targetRequestId}; waiting for that request's correlated response.`
        );
      } else if (envelope.response.kind !== "error" || envelope.response.code !== "cancellation_unavailable") {
        this.output.appendLine(
          `Open Wrangler runtime returned ${envelope.response.kind} while cancelling request ${cancellationTarget.targetRequestId}; waiting for the authoritative result.`
        );
      }
      return;
    }

    const owner = this.pending.get(envelope.requestId);
    if (owner && owner.runtime !== runtime) {
      this.output.appendLine(
        `Ignored a response from Python scope ${runtime.key} for a request owned by ${owner.runtime.key}.`
      );
      return;
    }
    const pending = this.takePending(envelope.requestId);
    if (!pending) return;
    const response = this.finalizeRuntimeResponse(pending, envelope.response);
    pending.resolve(response);
    this.stopRuntimeIfIdle(runtime);
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    pending.runtime.pendingIds.delete(requestId);
    clearTimeout(pending.timer);
    try {
      pending.cancellation?.dispose();
    } catch (error) {
      try {
        this.output.appendLine(
          `Open Wrangler could not dispose a runtime cancellation listener: ${error instanceof Error ? error.message : String(error)}`
        );
      } catch {
        // Pending ownership must still be released when diagnostics are unavailable.
      }
    }
    if (pending.cancellationRequestId) this.cancellationTargets.delete(pending.cancellationRequestId);
    return pending;
  }

  private rejectRuntime(runtime: RuntimeSlot, error: Error): void {
    for (const requestId of [...runtime.pendingIds]) {
      this.takePending(requestId)?.reject(error);
    }
    for (const [requestId, target] of this.cancellationTargets) {
      if (target.runtime === runtime) this.cancellationTargets.delete(requestId);
    }
  }

  private cancelRequest(targetRequestId: string): void {
    const pending = this.pending.get(targetRequestId);
    if (!pending || pending.cancellationRequested) return;
    pending.cancellationRequested = true;
    if (!pending.dispatched) {
      const cancelled = this.takePending(targetRequestId);
      if (cancelled) {
        this.releasePendingProvisionalReservationForRequest(cancelled.request, cancelled.requestId, cancelled.runtime);
        cancelled.resolve({ kind: "cancelled", targetRequestId: "not-started" });
        this.stopRuntimeIfIdle(cancelled.runtime);
      }
      return;
    }
    this.sendCancellation(pending.runtime, targetRequestId, true);
  }

  private sendCancellation(runtime: RuntimeSlot, targetRequestId: string, trackResponse: boolean): void {
    const proc = runtime.process;
    if (!proc?.stdin.writable) return;
    const requestId = randomUUID();
    const envelope: RuntimeRequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      priority: "interactive",
      request: { kind: "cancelRequest", targetRequestId }
    };
    if (trackResponse) {
      const pending = this.pending.get(targetRequestId);
      if (!pending || pending.runtime !== runtime) return;
      pending.cancellationRequestId = requestId;
      this.cancellationTargets.set(requestId, { targetRequestId, runtime });
    }
    try {
      proc.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (!error || !trackResponse) return;
        this.clearCancellationRequest(requestId, targetRequestId);
        this.output.appendLine(
          `Open Wrangler could not request cancellation for ${targetRequestId}: ${error.message}. Waiting for the authoritative result.`
        );
      });
    } catch (error) {
      if (!trackResponse) return;
      this.clearCancellationRequest(requestId, targetRequestId);
      this.output.appendLine(
        `Open Wrangler could not request cancellation for ${targetRequestId}: ${error instanceof Error ? error.message : String(error)}. Waiting for the authoritative result.`
      );
    }
  }

  private clearCancellationRequest(requestId: string, targetRequestId: string): void {
    this.cancellationTargets.delete(requestId);
    const pending = this.pending.get(targetRequestId);
    if (pending?.cancellationRequestId === requestId) pending.cancellationRequestId = undefined;
  }

  private reserveRequestedSession(
    request: OpenWranglerRequest,
    runtime: RuntimeSlot,
    openRequestId: string
  ): ErrorResponse | undefined {
    if (request.kind !== "openSession" || !request.requestedSessionId) return undefined;
    const confirmedOwner = this.sessionOwners.get(request.requestedSessionId);
    const provisional = this.provisionalSessions.get(request.requestedSessionId);
    if (confirmedOwner || provisional) {
      const owner = confirmedOwner ?? provisional!.runtime;
      return {
        kind: "error",
        code: "duplicate_runtime_session",
        message: `Open Wrangler runtime session ${request.requestedSessionId} is already owned or reserved by Python scope ${owner.key}.`,
        recoverable: true,
        sessionId: request.requestedSessionId
      };
    }
    this.provisionalSessions.set(request.requestedSessionId, {
      runtime,
      openRequestId,
      state: "pending"
    });
    runtime.provisionalSessionIds.add(request.requestedSessionId);
    return undefined;
  }

  private releaseProvisionalReservationForRequest(
    request: OpenWranglerRequest,
    openRequestId: string,
    runtime: RuntimeSlot
  ): void {
    if (request.kind === "openSession" && request.requestedSessionId) {
      this.releaseProvisionalReservation(request.requestedSessionId, openRequestId, runtime);
    }
  }

  private releasePendingProvisionalReservationForRequest(
    request: OpenWranglerRequest,
    openRequestId: string,
    runtime: RuntimeSlot
  ): void {
    if (request.kind !== "openSession" || !request.requestedSessionId) return;
    const reservation = this.provisionalSessions.get(request.requestedSessionId);
    if (reservation?.state !== "pending") return;
    this.releaseProvisionalReservation(request.requestedSessionId, openRequestId, runtime);
  }

  private releaseProvisionalReservation(sessionId: string, openRequestId: string, runtime: RuntimeSlot): void {
    const reservation = this.provisionalSessions.get(sessionId);
    if (reservation?.runtime !== runtime || reservation.openRequestId !== openRequestId) return;
    this.provisionalSessions.delete(sessionId);
    runtime.provisionalSessionIds.delete(sessionId);
  }

  private terminateProvisionalReservation(sessionId: string, runtime: RuntimeSlot): void {
    const reservation = this.provisionalSessions.get(sessionId);
    if (reservation?.runtime !== runtime) return;
    this.provisionalSessions.delete(sessionId);
    runtime.provisionalSessionIds.delete(sessionId);
  }

  private isExactProvisionalReservation(sessionId: string, openRequestId: string, runtime: RuntimeSlot): boolean {
    const reservation = this.provisionalSessions.get(sessionId);
    return (
      reservation?.runtime === runtime && reservation.openRequestId === openRequestId && reservation.state === "pending"
    );
  }

  private promoteProvisionalReservation(sessionId: string, openRequestId: string, runtime: RuntimeSlot): boolean {
    if (!this.isExactProvisionalReservation(sessionId, openRequestId, runtime)) return false;
    this.releaseProvisionalReservation(sessionId, openRequestId, runtime);
    if (this.sessionOwners.has(sessionId)) return false;
    this.bindSessionOwner(sessionId, runtime);
    return true;
  }

  private invalidTerminatedReservationResponse(sessionId: string, runtime: RuntimeSlot): ErrorResponse {
    this.restartRuntime(
      runtime,
      `Runtime opened session ${sessionId} after its exact candidate reservation ended; restarting the affected Python scope.`
    );
    return this.invalidRuntimeSessionResponse(
      `The runtime opened session ${sessionId} after its candidate reservation was no longer active.`,
      sessionId
    );
  }

  private duplicateSessionResponse(sessionId: string, runtime: RuntimeSlot): ErrorResponse {
    this.restartRuntime(
      runtime,
      `Runtime returned duplicate session ${sessionId}; restarting the affected Python scope.`
    );
    return this.invalidRuntimeSessionResponse(
      `The runtime returned duplicate session identity ${sessionId} from Python scope ${runtime.key}.`,
      sessionId
    );
  }

  private hasOtherSessionClaim(sessionId: string, runtime: RuntimeSlot, openRequestId?: string): boolean {
    if (this.sessionOwners.has(sessionId)) return true;
    const provisional = this.provisionalSessions.get(sessionId);
    return Boolean(
      provisional &&
      (provisional.runtime !== runtime || openRequestId === undefined || provisional.openRequestId !== openRequestId)
    );
  }

  private releaseOpenReservation(pending: PendingRequest): void {
    this.releaseProvisionalReservationForRequest(pending.request, pending.requestId, pending.runtime);
  }

  private finalizeOpenResponse(pending: PendingRequest, response: OpenWranglerResponse): OpenWranglerResponse {
    const { request, runtime } = pending;
    if (request.kind !== "openSession") return response;
    if (response.kind !== "sessionOpened") {
      this.releaseOpenReservation(pending);
      return response;
    }

    const actual = response.metadata.sessionId;
    const expected = request.requestedSessionId;
    if (!expected) {
      if (this.hasOtherSessionClaim(actual, runtime)) return this.duplicateSessionResponse(actual, runtime);
      this.bindSessionOwner(actual, runtime);
      return response;
    }
    if (actual !== expected) {
      this.releaseOpenReservation(pending);
      this.restartRuntime(
        runtime,
        `Runtime returned session ${actual} instead of requested session ${expected}; restarting the affected Python scope.`
      );
      return this.invalidRuntimeSessionResponse(
        `The runtime returned session ${actual} instead of requested session ${expected}.`,
        expected
      );
    }
    if (!this.isExactProvisionalReservation(expected, pending.requestId, runtime)) {
      return this.invalidTerminatedReservationResponse(expected, runtime);
    }
    if (this.hasOtherSessionClaim(expected, runtime, pending.requestId)) {
      this.releaseOpenReservation(pending);
      return this.duplicateSessionResponse(expected, runtime);
    }
    if (!this.promoteProvisionalReservation(expected, pending.requestId, runtime)) {
      return this.invalidTerminatedReservationResponse(expected, runtime);
    }
    return response;
  }

  private finalizeRuntimeResponse(pending: PendingRequest, response: OpenWranglerResponse): OpenWranglerResponse {
    const { request, runtime } = pending;
    if (request.kind === "openSession") {
      return this.finalizeOpenResponse(pending, response);
    }

    if (isSessionBoundRequest(request)) {
      const correlatedSessionId = runtimeResponseSessionId(response);
      if (correlatedSessionId && correlatedSessionId !== request.sessionId) {
        this.restartRuntime(
          runtime,
          `Runtime response named session ${correlatedSessionId} instead of ${request.sessionId}; restarting the affected Python scope.`
        );
        return this.invalidRuntimeSessionResponse(
          `The runtime response named session ${correlatedSessionId} instead of ${request.sessionId}.`,
          request.sessionId
        );
      }
      if (
        (request.kind === "closeSession" &&
          response.kind === "sessionClosed" &&
          response.sessionId === request.sessionId) ||
        isConfirmedUnknownSession(response, request.sessionId)
      ) {
        this.releaseSessionOwner(request.sessionId, runtime);
        this.terminateProvisionalReservation(request.sessionId, runtime);
      }
    }
    return response;
  }

  private invalidRuntimeSessionResponse(message: string, sessionId?: string): ErrorResponse {
    return {
      kind: "error",
      code: "invalid_runtime_response",
      message,
      recoverable: true,
      ...(sessionId ? { sessionId } : {})
    };
  }

  private bindSessionOwner(sessionId: string, runtime: RuntimeSlot): void {
    this.sessionOwners.set(sessionId, runtime);
    runtime.sessionIds.add(sessionId);
  }

  private releaseSessionOwner(sessionId: string, runtime: RuntimeSlot): void {
    if (this.sessionOwners.get(sessionId) === runtime) this.sessionOwners.delete(sessionId);
    runtime.sessionIds.delete(sessionId);
  }

  private releaseRuntimeSessionState(runtime: RuntimeSlot): void {
    for (const sessionId of runtime.sessionIds) {
      if (this.sessionOwners.get(sessionId) === runtime) this.sessionOwners.delete(sessionId);
    }
    runtime.sessionIds.clear();
    for (const sessionId of runtime.provisionalSessionIds) {
      if (this.provisionalSessions.get(sessionId)?.runtime === runtime) {
        this.provisionalSessions.delete(sessionId);
      }
    }
    runtime.provisionalSessionIds.clear();
  }

  private unknownSessionError(request: Extract<OpenWranglerRequest, { sessionId: string }>): ErrorResponse {
    return {
      kind: "error",
      code: "unknown_session",
      message: `Open Wrangler runtime session ${request.sessionId} is not available.`,
      recoverable: true,
      sessionId: request.sessionId,
      viewRequestId: "viewRequestId" in request ? request.viewRequestId : undefined
    };
  }

  private cancellationUnavailableError(targetRequestId: string): ErrorResponse {
    return {
      kind: "error",
      code: "cancellation_unavailable",
      message: `Open Wrangler runtime request ${targetRequestId} is not available for cancellation.`,
      recoverable: true
    };
  }

  private abortEnvironmentSelection(
    selection: EnvironmentSelection,
    reason:
      | PythonEnvironmentResolutionCancelledError
      | PythonEnvironmentResolutionDisposedError
      | PythonEnvironmentResolutionSupersededError
  ): boolean {
    if (selection.resolvedEnvironment || selection.resolutionController.signal.aborted) return false;
    selection.resolutionController.abort(reason);
    return true;
  }

  private environmentSelection(resource?: vscode.Uri): EnvironmentSelection {
    const scope = pythonSelectionScope(resource);
    const existing = this.environmentSelections.get(scope.key);
    if (existing) return existing;

    const resolutionController = new AbortController();
    const owner: { selection?: EnvironmentSelection } = {};
    let armed = false;
    const promise = resolvePythonEnvironment(this.context, resource, this.environmentApiBroker, {
      signal: resolutionController.signal,
      isCurrent: () =>
        !armed ||
        (!this.disposed &&
          this.environmentSelections.get(scope.key) === owner.selection &&
          owner.selection?.epoch === (this.selectionEpochs.get(scope.key) ?? 0)),
      isTrusted: () => vscode.workspace.isTrusted
    });
    const selection: EnvironmentSelection = {
      key: scope.key,
      epoch: this.selectionEpochs.get(scope.key) ?? 0,
      resource,
      workspaceFolder: scope.workspaceFolder,
      promise,
      resolutionController,
      dependencyKeys: new Set()
    };
    owner.selection = selection;
    this.environmentSelections.set(scope.key, selection);
    armed = true;
    void promise.then(
      (environment) => {
        if (!this.disposed && this.environmentSelections.get(scope.key) === selection) {
          selection.resolvedEnvironment = environment;
        }
      },
      () => {
        if (this.environmentSelections.get(scope.key) === selection) {
          this.environmentSelections.delete(scope.key);
          this.trimInactiveScopes();
        }
      }
    );
    return selection;
  }

  private async processSelectionFor(request: OpenWranglerRequest): Promise<ProcessSelection> {
    const resource = request.kind === "openSession" ? sourceResource(request.source) : undefined;
    const runtime = this.runtimeSlot(pythonSelectionScope(resource).key);
    const release = this.retainRuntime(runtime);
    try {
      const selection = this.environmentSelection(resource);
      return { selection, environment: await selection.promise };
    } finally {
      release();
    }
  }

  private isCurrentEnvironmentSelection(selection: EnvironmentSelection): boolean {
    return this.environmentSelections.get(selection.key) === selection;
  }

  private handlePythonEnvironmentSelectionChange(event: PythonEnvironmentSelectionChangeEvent): void {
    if (this.disposed) return;
    const authorizedSelection =
      this.dependencyInstallOperation?.authorizationSelection ??
      this.dependencyRecoveryOperation?.authorizationSelection;
    const affectsAuthorizedInstall = Boolean(
      authorizedSelection &&
      authorizedSelection.resolvedEnvironment?.source === "pythonExtension" &&
      getSetting("pythonPath", "", authorizedSelection.resource).trim().length === 0 &&
      pythonSelectionEventAffects(event, authorizedSelection)
    );
    const affected = new Set(
      [...this.environmentSelections.values()]
        .filter(
          (selection) =>
            pythonSelectionEventAffects(event, selection) &&
            getSetting("pythonPath", "", selection.resource).trim().length === 0
        )
        .map((selection) => selection.key)
    );
    if (affectsAuthorizedInstall) this.dependencyAuthorizationEpoch += 1;
    if (affected.size > 0) {
      this.invalidateSelectionScopes(
        affected,
        "The active Python extension environment changed; restarting Open Wrangler so sessions can replay safely.",
        true
      );
    }
  }

  private async prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse> {
    const runtime = this.runtimeSlot(
      pythonSelectionScope(request.kind === "openSession" ? sourceResource(request.source) : undefined).key
    );
    const release = this.retainRuntime(runtime);
    try {
      return (await this.prepareRequestForDispatch(request)).request;
    } finally {
      release();
    }
  }

  private async prepareRequestForDispatch(request: OpenWranglerRequest): Promise<PreparedRequest> {
    if (request.kind !== "openSession") return { request };
    if (request.backend) {
      if (!isFileDataBackend(request.backend)) {
        return {
          request: {
            kind: "error",
            code: "unsupported_backend",
            message: "PySpark sessions require a live variable from a Jupyter notebook kernel.",
            detail: "Open the dataframe from Jupyter's Variables view or use Open Wrangler: Open Notebook Variable.",
            recoverable: true
          }
        };
      }
      const capabilityFailure = backendImportCapabilityFailure(request.backend, request.source);
      if (capabilityFailure) {
        return {
          request: {
            kind: "error",
            code: "unsupported_import_options",
            message: capabilityFailure.message,
            detail: capabilityFailure.detail,
            recoverable: true
          }
        };
      }
    }
    const selection = this.environmentSelection(sourceResource(request.source));
    const environment = await selection.promise;
    if (!this.isCurrentEnvironmentSelection(selection)) return { request: this.runtimeSelectionChangedError() };
    const mutation = this.dependencyMutations.get(pythonPackageEnvironmentKey(environment));
    if (mutation) {
      return {
        request: {
          kind: "error",
          code: "runtime_selection_changed",
          message: `Open Wrangler is updating dependencies in ${environment.executable}.`,
          detail: "Wait for the confirmed install process to exit, then retry the request.",
          recoverable: true
        }
      };
    }
    const dependencyGuardError = await this.dependencyGuardErrorForEnvironment(environment, selection);
    if (dependencyGuardError) return { request: dependencyGuardError };
    if (!this.isCurrentEnvironmentSelection(selection)) return { request: this.runtimeSelectionChangedError() };
    if (this.dependencyMutations.has(pythonPackageEnvironmentKey(environment))) {
      return { request: this.runtimeSelectionChangedError() };
    }
    const processSelection = { selection, environment };
    if (request.source.kind !== "file") return { request, processSelection };

    const backends = request.backend ? [request.backend] : automaticBackends(request.source);
    const failures: Array<{ backend: DataBackend; missing: string[]; dependencies: readonly PythonDependency[] }> = [];
    for (const backend of backends) {
      if (!this.isCurrentEnvironmentSelection(selection)) return { request: this.runtimeSelectionChangedError() };
      const dependencies = requiredDependencies(backend, request.source);
      const packageEnvironmentKey = pythonPackageEnvironmentKey(environment);
      const key = dependencyProbeKey(environment, dependencies);
      selection.dependencyKeys.add(key);
      let missing: string[];
      try {
        const completedOrProbe = this.probeDependenciesForEnvironment(environment, dependencies);
        const outcome = completedOrProbe instanceof Promise ? await completedOrProbe : completedOrProbe;
        if (outcome.flight?.detached) return { request: this.runtimeSelectionChangedError() };
        missing = outcome.missing;
      } catch (error) {
        if (error instanceof DetachedDependencyProbeError) {
          return { request: this.runtimeSelectionChangedError() };
        }
        throw error;
      }
      if (!this.isCurrentEnvironmentSelection(selection)) return { request: this.runtimeSelectionChangedError() };
      if (this.dependencyMutations.has(packageEnvironmentKey)) {
        return { request: this.runtimeSelectionChangedError() };
      }
      if (missing.length === 0) {
        if (this.lastMissingDependencies?.selection.key === selection.key) {
          this.lastMissingDependencies = undefined;
        }
        return { request: { ...request, backend }, processSelection };
      }
      failures.push({ backend, missing, dependencies });
    }
    if (!this.isCurrentEnvironmentSelection(selection)) return { request: this.runtimeSelectionChangedError() };
    const selectedFailure = failures[0];
    const selectedRequirements = [...(selectedFailure?.missing ?? [])];
    const selectedRequirementSet = new Set(selectedRequirements);
    this.lastMissingDependencies = {
      environment,
      dependencies: (selectedFailure?.dependencies ?? [])
        .filter((dependency) => selectedRequirementSet.has(dependency.installSpec))
        .map((dependency) => ({ ...dependency })),
      requirements: selectedRequirements,
      selection,
      selectionEpoch: selection.epoch
    };
    return {
      request: {
        kind: "error",
        code: "missing_dependencies",
        message: `The selected Python ${environment.version} environment cannot open this source with ${backendDisplayName(selectedFailure?.backend)}. Missing: ${selectedRequirements.join(", ")}.`,
        detail:
          "Install the required dependency from this error, or run Open Wrangler: Install Runtime Dependencies, then review and confirm the exact environment change.",
        recoverable: true
      }
    };
  }

  private runtimeSelectionChangedError(): ErrorResponse {
    return {
      kind: "error",
      code: "runtime_selection_changed",
      message: "The selected Python runtime changed while its dependencies were being checked.",
      detail: "Retry the request with the current Open Wrangler runtime selection.",
      recoverable: true
    };
  }

  private dependencyGuardHelperPath(): string {
    return this.context.asAbsolutePath(path.join("python", "openwrangler_runtime", "dependency_guard.py"));
  }

  private activeDependencyGuardCommandSet(): Set<
    OwnedDependencyGuardCommand<DependencyGuardStatus | DependencyGuardValidation>
  > {
    return (this.activeDependencyGuardCommands ??= new Set());
  }

  private runOwnedDependencyGuardCommand<Result extends DependencyGuardStatus | DependencyGuardValidation>(
    launch: () => OwnedDependencyGuardCommand<Result>
  ): Promise<Result> {
    if (this.disposed) {
      return Promise.reject(new Error("Open Wrangler cannot launch a dependency guard after its bridge disposed."));
    }
    let command: OwnedDependencyGuardCommand<Result>;
    try {
      command = launch();
    } catch (error) {
      return Promise.reject(error);
    }
    const active = this.activeDependencyGuardCommandSet();
    active.add(command);
    const release = (): void => {
      active.delete(command);
    };
    void command.ownershipReleased.then(release);
    return command.completion;
  }

  private runDependencyGuardValidation(
    environment: PythonEnvironment,
    expectedToken: string
  ): Promise<DependencyGuardValidation> {
    return this.runOwnedDependencyGuardCommand(() =>
      this.launchDependencyGuardValidation(environment, expectedToken, {
        helperPath: this.dependencyGuardHelperPath()
      })
    );
  }

  private dependencyGuardStatusForEnvironment(environment: PythonEnvironment): Promise<DependencyGuardStatus> {
    const key = pythonPackageEnvironmentKey(environment);
    const environmentIdentityKey = pythonEnvironmentIdentityKey(environment);
    const existing = this.dependencyGuardStatusFlights.get(key);
    if (existing) {
      if (existing.environmentIdentityKey === environmentIdentityKey) return existing.promise;
      return existing.promise.then(
        () => Promise.reject(new DependencyGuardCrossIdentityFlightError()),
        () => Promise.reject(new DependencyGuardCrossIdentityFlightError())
      );
    }

    const promise = this.runOwnedDependencyGuardCommand(() =>
      this.launchDependencyGuardStatus(environment, { helperPath: this.dependencyGuardHelperPath() })
    );
    const flight = { environmentIdentityKey, promise };
    this.dependencyGuardStatusFlights.set(key, flight);
    const release = (): void => {
      if (this.dependencyGuardStatusFlights.get(key) === flight) {
        this.dependencyGuardStatusFlights.delete(key);
      }
    };
    void promise.then(release, release);
    return promise;
  }

  private async dependencyGuardErrorForEnvironment(
    environment: PythonEnvironment,
    selection: EnvironmentSelection
  ): Promise<ErrorResponse | undefined> {
    let status: DependencyGuardStatus;
    try {
      status = await this.dependencyGuardStatusForEnvironment(environment);
    } catch (error) {
      if (this.disposed) return this.runtimeSelectionChangedError();
      this.markDependencyEnvironmentUncertain(environment, undefined, error, selection);
      return this.dependencyEnvironmentUncertainError(this.dependencyEnvironmentBlocker(environment)!);
    }

    if (status.state === "dirty") {
      this.markDependencyEnvironmentUncertain(
        environment,
        status.token,
        "A durable dependency-mutation journal requires exact validation.",
        selection
      );
      return this.dependencyEnvironmentUncertainError(this.dependencyEnvironmentBlocker(environment)!);
    }

    this.dependencyEnvironmentUncertainty.delete(pythonEnvironmentIdentityKey(environment));
    const retained = this.dependencyEnvironmentBlocker(environment);
    if (retained) return this.dependencyEnvironmentUncertainError(retained);
    return undefined;
  }

  private markDependencyEnvironmentUncertain(
    environment: PythonEnvironment,
    token: string | undefined,
    reason: unknown,
    selection?: EnvironmentSelection,
    selectionDetached = false
  ): void {
    const key = pythonEnvironmentIdentityKey(environment);
    const retained = this.dependencyEnvironmentUncertainty.get(key);
    this.dependencyEnvironmentUncertainty.delete(key);
    this.dependencyEnvironmentUncertainty.set(key, {
      environment: {
        ...environment,
        executableIdentity: { ...environment.executableIdentity },
        packageRootIdentity: { ...environment.packageRootIdentity }
      },
      token: token ?? retained?.token,
      selection: selection ?? retained?.selection,
      selectionEpoch: selection?.epoch ?? retained?.selectionEpoch,
      selectionDetached: selection ? selectionDetached : retained?.selectionDetached,
      reason: dependencyGuardFailureReason(reason),
      guidance: dependencyGuardRecoveryGuidance(reason)
    });
    while (this.dependencyEnvironmentUncertainty.size > MAX_RETAINED_DEPENDENCY_UNCERTAINTIES) {
      const oldest = this.dependencyEnvironmentUncertainty.keys().next().value;
      if (oldest === undefined) break;
      this.dependencyEnvironmentUncertainty.delete(oldest);
    }
  }

  private clearDependencyEnvironmentUncertainty(environment: PythonEnvironment, token: string): void {
    const key = pythonEnvironmentIdentityKey(environment);
    const retained = this.dependencyEnvironmentUncertainty.get(key);
    if (retained?.token === token) {
      this.dependencyEnvironmentUncertainty.delete(key);
    }
  }

  private dependencyEnvironmentBlocker(environment: PythonEnvironment): DependencyEnvironmentUncertainty | undefined {
    const exactKey = pythonEnvironmentIdentityKey(environment);
    const exact = this.dependencyEnvironmentUncertainty.get(exactKey);
    if (exact?.token) {
      this.dependencyEnvironmentUncertainty.delete(exactKey);
      this.dependencyEnvironmentUncertainty.set(exactKey, exact);
      return exact;
    }
    const packageEnvironmentKey = pythonPackageEnvironmentKey(environment);
    const packageEntry = [...this.dependencyEnvironmentUncertainty.entries()].find(
      ([, uncertainty]) =>
        uncertainty.token !== undefined &&
        pythonPackageEnvironmentKey(uncertainty.environment) === packageEnvironmentKey
    );
    if (packageEntry) {
      const [key, uncertainty] = packageEntry;
      this.dependencyEnvironmentUncertainty.delete(key);
      this.dependencyEnvironmentUncertainty.set(key, uncertainty);
      return uncertainty;
    }
    if (exact) {
      this.dependencyEnvironmentUncertainty.delete(exactKey);
      this.dependencyEnvironmentUncertainty.set(exactKey, exact);
    }
    return exact;
  }

  private dependencyEnvironmentUncertainError(uncertainty: DependencyEnvironmentUncertainty): ErrorResponse {
    return {
      kind: "error",
      code: "dependency_environment_uncertain",
      message: `Open Wrangler cannot use ${uncertainty.environment.executable} because its dependency state is uncertain.`,
      detail: uncertainty.guidance,
      recoverable: true
    };
  }

  private assertDependencyEnvironmentAvailable(environment: PythonEnvironment): void {
    const key = pythonPackageEnvironmentKey(environment);
    if (!this.dependencyMutations.has(key) && !this.dependencyEnvironmentBlocker(environment)) return;
    throw new Error(
      `Open Wrangler cannot start or reuse ${environment.executable} while its Python dependencies are being changed or their state is uncertain.`
    );
  }

  private runtimeUnavailableError(runtime: RuntimeSlot, error?: unknown, pythonPath?: string): Error {
    const reason = error instanceof Error ? error.message : error ? String(error) : "runtime stream is not writable";
    const stderr = runtime.stderrBuffer.trim();
    const pathHint = pythonPath ? ` Python executable: ${pythonPath}.` : "";
    const stderrHint = stderr ? ` Runtime stderr: ${stderr}` : "";
    return new Error(
      `Open Wrangler could not talk to its Python runtime (${reason}).${pathHint}${stderrHint} ` +
        "Select a compatible Python 3.10-3.14 environment with the Open Wrangler: Change Runtime command."
    );
  }
}

function backendDisplayName(backend: DataBackend | undefined): string {
  if (backend === "duckdb") return "DuckDB";
  if (backend === "pandas") return "Pandas";
  return "Polars";
}

function sourceResource(source: SessionSource): vscode.Uri | undefined {
  if (source.uri) {
    try {
      return vscode.Uri.parse(source.uri, true);
    } catch {
      // Malformed URI metadata can still fall back to its concrete file path.
    }
  }
  return source.path ? vscode.Uri.file(source.path) : undefined;
}

function pythonSelectionScope(resource?: vscode.Uri): {
  key: string;
  workspaceFolder: vscode.WorkspaceFolder | undefined;
} {
  const workspaceFolder = resource ? vscode.workspace.getWorkspaceFolder?.(resource) : undefined;
  const scope = workspaceFolder?.uri ?? resource;
  return {
    key: scope ? scope.toString(true) : "<workspace-default>",
    workspaceFolder
  };
}

function pythonSelectionEventAffects(
  event: PythonEnvironmentSelectionChangeEvent,
  selection: EnvironmentSelection
): boolean {
  if (!event.resource) return true;
  if (isWorkspaceFolder(event.resource)) {
    return Boolean(selection.workspaceFolder && sameUri(selection.workspaceFolder.uri, event.resource.uri));
  }
  if (selection.resource && sameUri(selection.resource, event.resource)) return true;
  const eventWorkspaceFolder = vscode.workspace.getWorkspaceFolder?.(event.resource);
  return Boolean(
    selection.workspaceFolder &&
    eventWorkspaceFolder &&
    sameUri(selection.workspaceFolder.uri, eventWorkspaceFolder.uri)
  );
}

function isWorkspaceFolder(resource: vscode.Uri | vscode.WorkspaceFolder): resource is vscode.WorkspaceFolder {
  return "uri" in resource;
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString(true) === right.toString(true);
}

function runtimeResponseSessionId(response: OpenWranglerResponse): string | undefined {
  switch (response.kind) {
    case "sessionOpened":
    case "page":
    case "stepPreview":
    case "planUpdated":
      return response.metadata.sessionId;
    case "sessionClosed":
      return response.sessionId;
    case "error":
      return response.sessionId;
    default:
      return undefined;
  }
}

function isConfirmedUnknownSession(response: OpenWranglerResponse, sessionId: string): boolean {
  return (
    response.kind === "error" &&
    ((response.code === "unknown_session" && response.sessionId === sessionId) ||
      (response.code === "engine_error" &&
        response.message === `Unknown session: ${sessionId}` &&
        (response.sessionId === undefined || response.sessionId === sessionId)))
  );
}

function pythonExecutableKey(executable: string): string {
  const normalized = path.normalize(executable);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function pythonPackageEnvironmentKey(environment: Pick<PythonEnvironment, "packageRootIdentity">): string {
  return JSON.stringify([environment.packageRootIdentity.device, environment.packageRootIdentity.inode]);
}

function pythonEnvironmentIdentityKey(
  environment: Pick<
    PythonEnvironment,
    "executable" | "executableIdentity" | "packageRoot" | "packageRootIdentity" | "version"
  >
): string {
  return JSON.stringify([
    pythonPackageEnvironmentKey(environment),
    pythonExecutableKey(environment.executable),
    path.normalize(environment.packageRoot),
    environment.version,
    environment.executableIdentity.device,
    environment.executableIdentity.inode,
    environment.executableIdentity.size,
    environment.executableIdentity.mtimeNs,
    environment.executableIdentity.ctimeNs
  ]);
}

function dependencyProbeKey(
  environment: Pick<
    PythonEnvironment,
    "executable" | "executableIdentity" | "packageRoot" | "packageRootIdentity" | "version"
  >,
  dependencies: readonly PythonDependency[]
): string {
  if (!isFullyQualifiedPythonPath(environment.executable)) {
    throw new Error("Python dependency probing requires an absolute executable path.");
  }
  const packageEnvironmentKey = pythonPackageEnvironmentKey(environment);
  const descriptorKey = dependencies.map((dependency) => [
    dependency.importModule,
    dependency.distribution,
    dependency.installSpec,
    dependency.minimumVersion ?? null,
    dependency.maximumVersionExclusive ?? null
  ]);
  const probeIdentity = JSON.stringify([pythonEnvironmentIdentityKey(environment), descriptorKey]);
  return `${pythonPackageEnvironmentDependencyPrefix(packageEnvironmentKey)}${probeIdentity}`;
}

function pythonDependenciesEqual(left: readonly PythonDependency[], right: readonly PythonDependency[]): boolean {
  return (
    left.length === right.length &&
    left.every((dependency, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        dependency.importModule === candidate.importModule &&
        dependency.distribution === candidate.distribution &&
        dependency.installSpec === candidate.installSpec &&
        dependency.minimumVersion === candidate.minimumVersion &&
        dependency.maximumVersionExclusive === candidate.maximumVersionExclusive
      );
    })
  );
}

function dependencyGuardFailureReason(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : "Unknown dependency guard failure.";
}

function dependencyGuardRecoveryGuidance(reason: unknown): string {
  if (reason instanceof DependencyGuardCommandError) {
    switch (reason.code) {
      case "busy":
        return "Another dependency guard currently owns this environment. Wait for it to finish, then retry.";
      case "malformed_state":
      case "invalid_request":
      case "internal_error":
        return "The dependency recovery journal could not be verified. Inspect or restore the exact environment before retrying.";
      case "validation_failed":
      case "pip_failed":
        return "The selected environment did not satisfy the guarded dependency validation. Repair it, then retry.";
      case "environment_changed":
        return "The executable or package environment changed since the dependency operation began. Select the intended runtime again.";
      case "stale_or_missing_marker":
        return "The dependency recovery marker changed before validation. Retry so Open Wrangler can inspect the exact environment again.";
    }
  }
  if (reason instanceof DependencyGuardProtocolError || reason instanceof DependencyGuardCommandTimeoutError) {
    return "The dependency guard response could not be verified. Wait for any environment changes to finish, then retry.";
  }
  if (
    typeof reason === "string" &&
    (reason.includes("durable dependency-mutation journal") || reason.includes("has not been validated"))
  ) {
    return (
      "Open Wrangler found an unfinished dependency change. Run " +
      "Open Wrangler: Revalidate Runtime Dependencies before using the exact environment."
    );
  }
  if (reason instanceof DependencyGuardCrossIdentityFlightError) {
    return "Another executable identity in this package environment is being checked. Retry after that check settles.";
  }
  return "The exact Python environment must be recovered and validated before Open Wrangler can use it.";
}

function pythonPackageEnvironmentDependencyPrefix(packageEnvironmentKey: string): string {
  return `${packageEnvironmentKey.length}:${packageEnvironmentKey}:`;
}

function waitForRuntimeProcessExit(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once("exit", () => resolve());
  });
}

function samePythonExecutable(left: string | undefined, right: string): boolean {
  if (!left) return false;
  return pythonExecutableKey(left) === pythonExecutableKey(right);
}
