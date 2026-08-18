import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  DataBackend,
  OpenWranglerRequest,
  OpenWranglerResponse,
  ErrorResponse,
  SessionSource
} from "../shared/protocol";
import { isSessionBoundRequest } from "../shared/protocol";
import type { BridgeRequestOptions, OpenWranglerBridge } from "./dataBridge";
import { getSetting } from "./configuration";
import {
  DEPENDENCY_INSTALL_SHUTDOWN_WAIT_MS,
  DEPENDENCY_INSTALL_TIMEOUT_MS,
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
  requiredDependencies,
  resolvePythonEnvironment,
  type PythonEnvironment,
  type PythonEnvironmentSelectionChangeEvent
} from "./pythonEnvironment";
import {
  backendImportCapabilityFailure,
  isFileDataBackend,
  trustedPickleConversionDependencies,
  type PythonDependency
} from "./pythonEnvironmentModel";
import { isFullyQualifiedPythonPath } from "./pythonPath";
import { buildPythonProcessEnvironment } from "./pythonProcessEnvironment";
import { stopChildProcessGracefully } from "./processShutdown";
import { discoverExcelSheetNames } from "./files/excelSheetNames";
import { exportPythonDataSafely, type SafePythonDataExportOptions } from "./files/safePythonDataExport";
import {
  DependencyGuardCrossIdentityFlightError,
  DetachedDependencyProbeError,
  PythonDependencyProbeRegistry,
  dependencyGuardFailureReason,
  dependencyGuardRecoveryGuidance,
  pythonDependenciesEqual,
  pythonEnvironmentIdentityKey,
  pythonPackageEnvironmentKey,
  samePythonExecutable
} from "./pythonDependencyState";
import { PythonSessionOwnership } from "./pythonSessionOwnership";
import { PythonRuntimeTransport } from "./pythonRuntimeTransport";
import { PythonRuntimeScopeRegistry } from "./pythonRuntimeScopeRegistry";
import { BoundedPythonStdoutLineFramer } from "./pythonStdoutLineFramer";

interface MissingDependencies {
  readonly environment: PythonEnvironment;
  readonly dependencies: readonly PythonDependency[];
  readonly requirements: readonly string[];
  readonly selection: EnvironmentSelection;
  readonly selectionEpoch: number;
}

export interface PythonBridgeFileOperations {
  readonly beginTransaction?: SafePythonDataExportOptions["beginTransaction"];
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

export interface TrustedPicklePythonPreflight {
  readonly executable: string;
  readonly version: string;
  readonly source: PythonEnvironment["source"];
  readonly missing: readonly string[];
}

interface TrustedPicklePreflightOwner {
  readonly selection: EnvironmentSelection;
  readonly environment: PythonEnvironment;
  readonly missingTarget?: MissingDependencies;
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
  boundPicklePreflight?: TrustedPicklePythonPreflight;
  target?: MissingDependencies;
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

const PROCESS_SHUTDOWN_AGGREGATE_MESSAGE = "Open Wrangler encountered multiple Python runtime shutdown failures.";
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

function createRuntimeSlot(key: string): RuntimeSlot {
  return {
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
}

export class PythonBridge implements OpenWranglerBridge, vscode.Disposable {
  private shutdownPromise: Promise<void> | undefined;
  private readonly sessionOwnership = new PythonSessionOwnership<RuntimeSlot>((runtime, reason) =>
    this.restartRuntime(runtime, reason)
  );
  private readonly runtimeTransport: PythonRuntimeTransport<RuntimeSlot>;
  private readonly runtimeScopes: PythonRuntimeScopeRegistry<RuntimeSlot, EnvironmentSelection>;
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
  private selectionEpoch = 0;
  private dependencyAuthorizationEpoch = 0;
  private readonly selectionEpochs = new Map<string, number>();
  private disposed = false;
  private readonly environmentSelections = new Map<string, EnvironmentSelection>();
  private readonly trustedPicklePreflights = new WeakMap<TrustedPicklePythonPreflight, TrustedPicklePreflightOwner>();
  private readonly dependencyProbes = new PythonDependencyProbeRegistry(
    (packageEnvironmentKey) => this.disposed || this.dependencyMutations.has(packageEnvironmentKey)
  );
  private readonly dependencyGuardStatusFlights = new Map<string, DependencyGuardStatusFlight>();
  private activeDependencyGuardCommands:
    Set<OwnedDependencyGuardCommand<DependencyGuardStatus | DependencyGuardValidation>> | undefined = new Set();
  private readonly dependencyEnvironmentUncertainty = new Map<string, DependencyEnvironmentUncertainty>();
  private lastMissingDependencies: MissingDependencies | undefined;
  private dependencyInstallOperation: DependencyInstallOperation | undefined;
  private dependencyRecoveryOperation: DependencyRecoveryOperation | undefined;
  private readonly dependencyMutations = new Map<string, DependencyInstallOperation>();
  private readonly trustedPickleEnvironmentLeases = new Map<string, number>();
  private readonly excelSheetReads = new Set<AbortController>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fileOperations: PythonBridgeFileOperations = {}
  ) {
    this.runtimeTransport = new PythonRuntimeTransport({
      sessionOwnership: this.sessionOwnership,
      restartRuntime: (runtime, reason) => this.restartRuntime(runtime, reason),
      stopRuntimeIfIdle: (runtime) => this.stopRuntimeIfIdle(runtime),
      runtimeUnavailableError: (runtime, error) => this.runtimeUnavailableError(runtime, error),
      reportDiagnostic: (message) => this.output.appendLine(message)
    });
    this.runtimeScopes = new PythonRuntimeScopeRegistry({
      createRuntime: createRuntimeSlot,
      environmentSelections: this.environmentSelections,
      selectionEpochs: this.selectionEpochs,
      activeMissingSelection: () => this.lastMissingDependencies?.selection,
      abortSelection: (selection) => {
        this.abortEnvironmentSelection(selection, new PythonEnvironmentResolutionSupersededError());
      },
      hasExternalOwnership: (runtime) =>
        this.runtimeTransport.hasOwnership(runtime) || this.sessionOwnership.hasClaimsFor(runtime)
    });
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

  private get runtimeSlots(): Map<string, RuntimeSlot> {
    return this.runtimeScopes.slots;
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
    const runtime = this.sessionOwnership.confirmedOwner(sessionId);
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
        this.sessionOwnership.confirmedOwner(sessionId) !== runtime ||
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
    if (request.kind === "exportData") return this.exportData(request, options);
    return this.requestRuntime(request, options);
  }

  private async exportData(
    request: Extract<OpenWranglerRequest, { kind: "exportData" }>,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    if (this.disposed) throw new Error("Open Wrangler runtime bridge has been disposed.");
    if (options.cancellation?.isCancellationRequested) {
      return { kind: "cancelled", targetRequestId: "not-started" };
    }
    const session = this.sessionOwnership.confirmedSession(request.sessionId);
    if (!session) return this.unknownSessionError(request);
    return exportPythonDataSafely({
      request,
      source: session.source,
      beginTransaction: this.fileOperations.beginTransaction,
      dispatch: async (runtimeRequest) => {
        if (this.sessionOwnership.confirmedSession(request.sessionId) !== session) {
          return this.unknownSessionError(request);
        }
        const response = await this.requestRuntime(runtimeRequest, options);
        if (response.kind === "dataExported" && this.sessionOwnership.confirmedSession(request.sessionId) !== session) {
          throw new Error("The Python session closed or changed before cleaned data could be published.");
        }
        return response;
      }
    });
  }

  private async requestRuntime(
    request: OpenWranglerRequest,
    options: BridgeRequestOptions = {}
  ): Promise<OpenWranglerResponse> {
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
      const confirmedOwner = this.sessionOwnership.confirmedOwner(request.sessionId);
      const provisional =
        request.kind === "closeSession" ? this.sessionOwnership.provisionalClaim(request.sessionId) : undefined;
      const owner = confirmedOwner ?? provisional?.runtime;
      if (!owner || (!owner.process && !owner.processStart)) {
        if (confirmedOwner) this.sessionOwnership.releaseConfirmed(request.sessionId, confirmedOwner);
        if (provisional) this.sessionOwnership.terminateProvisional(request.sessionId, provisional.runtime);
        return this.unknownSessionError(request);
      }
      if (!confirmedOwner && provisional) this.sessionOwnership.markProvisionalClosing(request.sessionId, owner);
      runtime = owner;
      requestLease = this.retainRuntime(owner);
      try {
        proc = owner.process ?? (await owner.processStart!);
      } catch (error) {
        releaseRequestLease();
        throw error;
      }
    } else if (request.kind === "cancelRequest") {
      const targetRuntime = this.runtimeTransport.runtimeForCancellation(request.targetRequestId);
      if (!targetRuntime || (!targetRuntime.process && !targetRuntime.processStart)) {
        return this.runtimeTransport.cancellationUnavailable(request.targetRequestId);
      }
      runtime = targetRuntime;
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

    return this.runtimeTransport.dispatch(runtime, proc, runtimeRequest, options, releaseRequestLease);
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
    if (!force && keys.size === 0 && this.dependencyProbes.isEmpty && !this.lastMissingDependencies) {
      return;
    }
    this.dependencyProbes.invalidateAll();
    this.invalidateSelectionScopes(keys, reason, force);
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
          this.dependencyProbes.invalidateKey(dependencyKey);
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

  async installTrustedPickleDependencies(preflight: TrustedPicklePythonPreflight): Promise<boolean> {
    const owner = this.trustedPicklePreflights.get(preflight);
    if (!owner?.missingTarget || !this.isTrustedPicklePreflightOwnerCurrent(owner)) return false;
    return this.beginDependencyInstallation({ preflight, target: owner.missingTarget });
  }

  async preflightTrustedPickleConversion(
    resource: vscode.Uri,
    expected?: TrustedPicklePythonPreflight
  ): Promise<TrustedPicklePythonPreflight> {
    if (this.disposed) throw new Error("Open Wrangler cannot convert a pickle after its Python bridge disposed.");
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before converting a pickle.");
    const expectedOwner = expected ? this.trustedPicklePreflights.get(expected) : undefined;
    if (expected && (!expectedOwner || expectedOwner.selection.key !== pythonSelectionScope(resource).key)) {
      throw new Error("The trusted pickle conversion target is no longer available.");
    }

    const runtime = this.runtimeSlot(pythonSelectionScope(resource).key);
    const release = this.retainRuntime(runtime);
    try {
      const selection = this.environmentSelection(resource);
      const environment = await selection.promise;
      if (!this.isCurrentEnvironmentSelection(selection)) throw new PythonEnvironmentResolutionSupersededError();
      if (
        expectedOwner &&
        pythonEnvironmentIdentityKey(environment) !== pythonEnvironmentIdentityKey(expectedOwner.environment)
      ) {
        throw new PythonEnvironmentResolutionSupersededError();
      }
      if (this.dependencyMutations.has(pythonPackageEnvironmentKey(environment))) {
        throw new Error(`Open Wrangler is changing Python dependencies in ${environment.executable}.`);
      }
      const guardError = await this.dependencyGuardErrorForEnvironment(environment, selection);
      if (guardError) throw new Error([guardError.message, guardError.detail].filter(Boolean).join(" "));
      if (!this.isCurrentEnvironmentSelection(selection)) throw new PythonEnvironmentResolutionSupersededError();

      const dependencies = trustedPickleConversionDependencies();
      const probe = this.dependencyProbes.probe(environment, dependencies);
      selection.dependencyKeys.add(probe.key);
      const outcome = probe.result instanceof Promise ? await probe.result : probe.result;
      if (!outcome.isCurrent() || !this.isCurrentEnvironmentSelection(selection)) {
        throw new PythonEnvironmentResolutionSupersededError();
      }
      if (this.dependencyMutations.has(pythonPackageEnvironmentKey(environment))) {
        throw new PythonEnvironmentResolutionSupersededError();
      }

      const missing = [...outcome.missing];
      let missingTarget: MissingDependencies | undefined;
      if (missing.length > 0) {
        const missingSet = new Set(missing);
        missingTarget = {
          environment,
          dependencies: dependencies
            .filter((dependency) => missingSet.has(dependency.installSpec))
            .map((dependency) => ({ ...dependency })),
          requirements: missing,
          selection,
          selectionEpoch: selection.epoch
        };
      }

      const preflight = Object.freeze({
        executable: environment.executable,
        version: environment.version,
        source: environment.source,
        missing: Object.freeze(missing)
      });
      this.trustedPicklePreflights.set(preflight, { selection, environment, missingTarget });
      return preflight;
    } catch (error) {
      if (error instanceof DetachedDependencyProbeError) throw new PythonEnvironmentResolutionSupersededError();
      throw error;
    } finally {
      release();
    }
  }

  isTrustedPicklePreflightCurrent(preflight: TrustedPicklePythonPreflight): boolean {
    const owner = this.trustedPicklePreflights.get(preflight);
    return Boolean(owner && this.isTrustedPicklePreflightOwnerCurrent(owner));
  }

  async revalidateTrustedPicklePreflight(preflight: TrustedPicklePythonPreflight): Promise<boolean> {
    const owner = this.trustedPicklePreflights.get(preflight);
    if (!owner || !this.isTrustedPicklePreflightOwnerCurrent(owner)) return false;
    let current: PythonEnvironment;
    try {
      current = await resolvePythonEnvironment(this.context, owner.selection.resource, this.environmentApiBroker, {
        isCurrent: () => this.isTrustedPicklePreflightOwnerCurrent(owner),
        isTrusted: () => vscode.workspace.isTrusted
      });
    } catch {
      return false;
    }
    return (
      this.isTrustedPicklePreflightOwnerCurrent(owner) &&
      pythonEnvironmentIdentityKey(current) === pythonEnvironmentIdentityKey(owner.environment)
    );
  }

  withTrustedPicklePreflightLease<T>(preflight: TrustedPicklePythonPreflight, run: () => Promise<T>): Promise<T> {
    const owner = this.trustedPicklePreflights.get(preflight);
    if (!owner || !this.isTrustedPicklePreflightOwnerCurrent(owner)) {
      return Promise.reject(new Error("The selected Python runtime changed before pickle conversion started."));
    }
    const key = pythonPackageEnvironmentKey(owner.environment);
    if (this.dependencyMutations.has(key)) {
      return Promise.reject(
        new Error(`Open Wrangler is changing Python dependencies in ${owner.environment.executable}.`)
      );
    }
    this.trustedPickleEnvironmentLeases.set(key, (this.trustedPickleEnvironmentLeases.get(key) ?? 0) + 1);
    let task: Promise<T>;
    try {
      task = run();
    } catch (error) {
      this.releaseTrustedPickleEnvironmentLease(key);
      return Promise.reject(error);
    }
    return task.finally(() => this.releaseTrustedPickleEnvironmentLease(key));
  }

  private releaseTrustedPickleEnvironmentLease(key: string): void {
    const remaining = (this.trustedPickleEnvironmentLeases.get(key) ?? 1) - 1;
    if (remaining > 0) this.trustedPickleEnvironmentLeases.set(key, remaining);
    else this.trustedPickleEnvironmentLeases.delete(key);
  }

  private isTrustedPicklePreflightOwnerCurrent(owner: TrustedPicklePreflightOwner): boolean {
    return (
      !this.disposed &&
      vscode.workspace.isTrusted &&
      this.isCurrentEnvironmentSelection(owner.selection) &&
      owner.selection.resolvedEnvironment === owner.environment &&
      !this.dependencyMutations.has(pythonPackageEnvironmentKey(owner.environment))
    );
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

  private beginDependencyInstallation(bound?: {
    preflight: TrustedPicklePythonPreflight;
    target: MissingDependencies;
  }): Promise<boolean> {
    if (this.disposed) {
      return Promise.reject(new Error("Open Wrangler cannot install dependencies after its runtime bridge disposed."));
    }
    if (this.dependencyRecoveryOperation && this.dependencyRecoveryOperation.phase !== "settled") {
      return Promise.resolve(false);
    }
    const existing = this.dependencyInstallOperation;
    if (existing?.promise) {
      return !bound || existing.boundPicklePreflight === bound.preflight ? existing.promise : Promise.resolve(false);
    }
    const operation: DependencyInstallOperation = {
      phase: "confirming",
      boundPicklePreflight: bound?.preflight,
      target: bound?.target
    };
    this.dependencyInstallOperation = operation;
    const installation = this.installMissingDependenciesWithDecision(operation);
    operation.promise = installation;
    const finish = (): void => this.finishDependencyInstallOperation(operation);
    void installation.then(finish, finish);
    return installation;
  }

  private async installMissingDependenciesWithDecision(operation: DependencyInstallOperation): Promise<boolean> {
    const missing = operation.target ?? this.lastMissingDependencies;
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
    if (!this.isCurrentDependencyInstallTarget(operation, missing, executable, requirements)) {
      this.reportInvalidDependencyInstallTarget();
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      `Install ${requirements.join(", ")} into ${executable}?`,
      { modal: true, detail: "Open Wrangler never installs packages without this confirmation." },
      "Install"
    );
    if (choice !== "Install") return false;
    if (!this.isCurrentDependencyInstallTarget(operation, missing, executable, requirements)) {
      this.reportInvalidDependencyInstallTarget();
      return false;
    }

    let installationStarted = false;
    const completed = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing Open Wrangler dependencies" },
      async () => {
        if (!this.isCurrentDependencyInstallTarget(operation, missing, executable, requirements)) return false;
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

    const currentTarget = operation.boundPicklePreflight ? undefined : this.lastMissingDependencies;
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
    if ((this.trustedPickleEnvironmentLeases?.get(mutationKey) ?? 0) > 0) {
      throw new Error(`Open Wrangler cannot change Python dependencies while converting a trusted pickle.`);
    }
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
    this.dependencyProbes.invalidatePackageEnvironment(packageEnvironmentKey);
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
    operation: DependencyInstallOperation,
    missing: MissingDependencies,
    executable: string,
    requirements: readonly string[]
  ): boolean {
    const boundOwner = operation.boundPicklePreflight
      ? this.trustedPicklePreflights.get(operation.boundPicklePreflight)
      : undefined;
    const ownsTarget = operation.boundPicklePreflight
      ? Boolean(
          boundOwner && boundOwner.missingTarget === missing && this.isTrustedPicklePreflightOwnerCurrent(boundOwner)
        )
      : this.lastMissingDependencies === missing;
    return (
      !this.disposed &&
      vscode.workspace.isTrusted &&
      this.isCurrentEnvironmentSelection(missing.selection) &&
      missing.selectionEpoch === missing.selection.epoch &&
      ownsTarget &&
      (this.trustedPickleEnvironmentLeases?.get(pythonPackageEnvironmentKey(missing.environment)) ?? 0) === 0 &&
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
    this.dependencyProbes.invalidateAll();
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
    return this.runtimeScopes.runtime(key);
  }

  private retainRuntime(runtime: RuntimeSlot): () => void {
    return this.runtimeScopes.retain(runtime);
  }

  private trimInactiveScopes(): void {
    this.runtimeScopes.trimInactive();
  }

  private evictInactiveScope(runtime: RuntimeSlot): boolean {
    return this.runtimeScopes.evictInactive(runtime);
  }

  private isInactiveScope(runtime: RuntimeSlot): boolean {
    return this.runtimeScopes.isInactive(runtime);
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
    this.sessionOwnership.releaseRuntime(runtime);
    this.runtimeTransport.rejectRuntime(runtime, new Error(reason));
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

    const stdout = new BoundedPythonStdoutLineFramer({
      onLine: (line) => this.runtimeTransport.handleLine(runtime, proc, line),
      onFailure: (error) => {
        if (runtime.process === proc) this.restartRuntime(runtime, error.message);
      }
    });
    proc.stdout.on("data", (chunk: unknown) => stdout.accept(chunk));
    proc.stdout.on("end", () => {
      stdout.end();
      if (runtime.process === proc) {
        this.restartRuntime(runtime, "Open Wrangler Python runtime stdout ended unexpectedly.");
      }
    });
    proc.stdout.on("error", () => stdout.streamError());
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      runtime.stderrBuffer = `${runtime.stderrBuffer}${text}`.slice(-8000);
      this.output.append(text);
    });
    proc.on("error", (error) =>
      this.handleProcessFailure(runtime, proc, this.runtimeUnavailableError(runtime, error, pythonPath))
    );
    proc.on("exit", (code, signal) => {
      stdout.dispose();
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
    this.sessionOwnership.releaseRuntime(runtime);
    this.output.appendLine(error.message);
    this.runtimeTransport.rejectRuntime(runtime, error);
    this.trimInactiveScopes();
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
      const probe = this.dependencyProbes.probe(environment, dependencies);
      selection.dependencyKeys.add(probe.key);
      let missing: string[];
      try {
        const outcome = probe.result instanceof Promise ? await probe.result : probe.result;
        if (!outcome.isCurrent()) return { request: this.runtimeSelectionChangedError() };
        missing = [...outcome.missing];
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

function waitForRuntimeProcessExit(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once("exit", () => resolve());
  });
}
