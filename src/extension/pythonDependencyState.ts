import * as path from "node:path";
import {
  DependencyGuardCommandError,
  DependencyGuardCommandTimeoutError,
  DependencyGuardProtocolError
} from "./dependencyInstaller";
import { probeDependencies, type DependencyProbe, type PythonEnvironment } from "./pythonEnvironment";
import type { PythonDependency } from "./pythonEnvironmentModel";
import { isFullyQualifiedPythonPath } from "./pythonPath";

const MAX_COMPLETED_DEPENDENCY_PROBES = 128;

export class DetachedDependencyProbeError extends Error {
  constructor() {
    super("The Python dependency probe was invalidated before it completed.");
    this.name = "DetachedDependencyProbeError";
  }
}

export class DependencyGuardCrossIdentityFlightError extends Error {
  constructor() {
    super("A dependency guard check for another executable identity in this package environment is still settling.");
    this.name = "DependencyGuardCrossIdentityFlightError";
  }
}

interface DependencyProbeFlight {
  readonly key: string;
  readonly packageEnvironmentKey: string;
  detached: boolean;
  promise: Promise<DependencyProbeOutcome>;
}

export interface DependencyProbeOutcome {
  readonly missing: readonly string[];
  isCurrent(): boolean;
}

export interface DependencyProbeHandle {
  readonly key: string;
  readonly result: DependencyProbeOutcome | Promise<DependencyProbeOutcome>;
}

export interface DependencyProbeRegistryDiagnostics {
  readonly completedCount: number;
  readonly inFlightCount: number;
  readonly completedKeys: readonly string[];
}

type DependencyProbeLauncher = (
  executable: string,
  dependencies: readonly PythonDependency[]
) => Promise<DependencyProbe>;

export class PythonDependencyProbeRegistry {
  private readonly completed = new Map<string, string[]>();
  private readonly inFlight = new Map<string, DependencyProbeFlight>();
  private readonly completedOwners = new Map<string, DependencyProbeFlight>();

  constructor(
    private readonly unavailable: (packageEnvironmentKey: string) => boolean,
    private readonly launch: DependencyProbeLauncher = probeDependencies
  ) {}

  get isEmpty(): boolean {
    return this.completed.size === 0 && this.inFlight.size === 0 && this.completedOwners.size === 0;
  }

  diagnostics(): DependencyProbeRegistryDiagnostics {
    return Object.freeze({
      completedCount: this.completed.size,
      inFlightCount: this.inFlight.size,
      completedKeys: Object.freeze([...this.completed.keys()])
    });
  }

  completedMissing(key: string): readonly string[] | undefined {
    const missing = this.completed.get(key);
    return missing === undefined ? undefined : Object.freeze([...missing]);
  }

  probe(environment: PythonEnvironment, dependencies: readonly PythonDependency[]): DependencyProbeHandle {
    const key = dependencyProbeKey(environment, dependencies);
    const completed = this.completed.get(key);
    if (completed !== undefined) {
      this.completed.delete(key);
      this.completed.set(key, completed);
      const owner = this.completedOwners.get(key);
      return {
        key,
        result: this.outcome(key, completed, owner)
      };
    }
    return {
      key,
      result: this.probeSingleFlight(key, pythonPackageEnvironmentKey(environment), environment, dependencies)
    };
  }

  invalidateAll(): void {
    for (const flight of this.inFlight.values()) flight.detached = true;
    for (const flight of this.completedOwners.values()) flight.detached = true;
    this.completed.clear();
    this.inFlight.clear();
    this.completedOwners.clear();
  }

  invalidateKey(key: string): void {
    const active = this.inFlight.get(key);
    if (active) active.detached = true;
    const completed = this.completedOwners.get(key);
    if (completed) completed.detached = true;
    this.completed.delete(key);
    this.inFlight.delete(key);
    this.completedOwners.delete(key);
  }

  invalidatePackageEnvironment(packageEnvironmentKey: string): void {
    const prefix = pythonPackageEnvironmentDependencyPrefix(packageEnvironmentKey);
    const keys = new Set([...this.completed.keys(), ...this.inFlight.keys(), ...this.completedOwners.keys()]);
    for (const key of keys) if (key.startsWith(prefix)) this.invalidateKey(key);
  }

  private probeSingleFlight(
    key: string,
    packageEnvironmentKey: string,
    environment: PythonEnvironment,
    dependencies: readonly PythonDependency[]
  ): Promise<DependencyProbeOutcome> {
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;

    const flight = { key, packageEnvironmentKey, detached: false } as DependencyProbeFlight;
    const detached = (): boolean =>
      flight.detached || this.inFlight.get(flight.key) !== flight || this.unavailable(flight.packageEnvironmentKey);
    const promise = Promise.resolve()
      .then(() => {
        if (detached()) throw new DetachedDependencyProbeError();
        return this.launch(environment.executable, dependencies);
      })
      .then(
        (result) => {
          const missing = [...result.missing];
          if (detached()) throw new DetachedDependencyProbeError();
          this.inFlight.delete(flight.key);
          this.completed.delete(flight.key);
          this.completed.set(flight.key, missing);
          this.completedOwners.set(flight.key, flight);
          while (this.completed.size > MAX_COMPLETED_DEPENDENCY_PROBES) {
            const oldest = this.completed.keys().next().value;
            if (oldest === undefined) break;
            this.completed.delete(oldest);
            this.completedOwners.delete(oldest);
          }
          return this.outcome(flight.key, missing, flight);
        },
        (error: unknown) => {
          if (detached()) throw new DetachedDependencyProbeError();
          this.inFlight.delete(flight.key);
          throw error;
        }
      );
    flight.promise = promise;
    this.inFlight.set(key, flight);
    return promise;
  }

  private outcome(
    key: string,
    missing: readonly string[],
    owner: DependencyProbeFlight | undefined
  ): DependencyProbeOutcome {
    return Object.freeze({
      missing: Object.freeze([...missing]),
      isCurrent: () => owner === undefined || (!owner.detached && this.completedOwners.get(key) === owner)
    });
  }
}

export function pythonExecutableKey(executable: string): string {
  const normalized = path.normalize(executable);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function pythonPackageEnvironmentKey(environment: Pick<PythonEnvironment, "packageRootIdentity">): string {
  return JSON.stringify([environment.packageRootIdentity.device, environment.packageRootIdentity.inode]);
}

export function pythonEnvironmentIdentityKey(
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

export function dependencyProbeKey(
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
    dependency.exactVersion ?? null,
    dependency.minimumVersion ?? null,
    dependency.maximumVersionExclusive ?? null
  ]);
  const probeIdentity = JSON.stringify([pythonEnvironmentIdentityKey(environment), descriptorKey]);
  return `${pythonPackageEnvironmentDependencyPrefix(packageEnvironmentKey)}${probeIdentity}`;
}

export function pythonDependenciesEqual(
  left: readonly PythonDependency[],
  right: readonly PythonDependency[]
): boolean {
  return (
    left.length === right.length &&
    left.every((dependency, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        dependency.importModule === candidate.importModule &&
        dependency.distribution === candidate.distribution &&
        dependency.installSpec === candidate.installSpec &&
        dependency.exactVersion === candidate.exactVersion &&
        dependency.minimumVersion === candidate.minimumVersion &&
        dependency.maximumVersionExclusive === candidate.maximumVersionExclusive
      );
    })
  );
}

export function dependencyGuardFailureReason(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : "Unknown dependency guard failure.";
}

export function dependencyGuardRecoveryGuidance(reason: unknown): string {
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

export function samePythonExecutable(left: string | undefined, right: string): boolean {
  if (!left) return false;
  return pythonExecutableKey(left) === pythonExecutableKey(right);
}
