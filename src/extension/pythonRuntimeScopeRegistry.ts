export interface PythonRuntimeScope {
  readonly key: string;
  readonly pendingIds: ReadonlySet<string>;
  readonly provisionalSessionIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
  readonly stoppingProcesses: ReadonlyMap<unknown, unknown>;
  leaseCount: number;
  process: unknown | undefined;
  processStart: unknown | undefined;
  processSelection: unknown | undefined;
  processStartSelection: unknown | undefined;
  processStop: unknown | undefined;
  runtimeExitError: unknown | undefined;
  stderrBuffer: string;
}

export interface PythonRuntimeScopeSelection {
  readonly key: string;
}

export interface PythonRuntimeScopeRegistryOptions<
  Runtime extends PythonRuntimeScope,
  Selection extends PythonRuntimeScopeSelection
> {
  readonly createRuntime: (key: string) => Runtime;
  readonly environmentSelections: Map<string, Selection>;
  readonly selectionEpochs: Map<string, number>;
  readonly activeMissingSelection: () => Selection | undefined;
  readonly abortSelection: (selection: Selection) => void;
  readonly hasExternalOwnership: (runtime: Runtime) => boolean;
  readonly maxRetainedInactiveScopes?: number;
  readonly slots?: Map<string, Runtime>;
  readonly recency?: Map<string, number>;
  readonly initialUseClock?: number;
}

// Repeated external-file opens may reuse inactive scope metadata, but arbitrary
// resource URIs must not grow these maps without bound. Live or explicitly
// leased scopes may temporarily exceed the cap; the next release trims them.
const DEFAULT_MAX_RETAINED_INACTIVE_SCOPES = 128;

export class PythonRuntimeScopeRegistry<
  Runtime extends PythonRuntimeScope,
  Selection extends PythonRuntimeScopeSelection
> {
  readonly slots: Map<string, Runtime>;
  readonly recency: Map<string, number>;
  private useClock: number;
  private readonly maxRetainedInactiveScopes: number;

  constructor(private readonly options: PythonRuntimeScopeRegistryOptions<Runtime, Selection>) {
    this.slots = options.slots ?? new Map();
    this.recency = options.recency ?? new Map();
    this.useClock = options.initialUseClock ?? 0;
    this.maxRetainedInactiveScopes = options.maxRetainedInactiveScopes ?? DEFAULT_MAX_RETAINED_INACTIVE_SCOPES;
    if (!Number.isSafeInteger(this.maxRetainedInactiveScopes) || this.maxRetainedInactiveScopes < 1) {
      throw new Error("Python runtime scope retention must be a positive safe integer.");
    }
  }

  runtime(key: string): Runtime {
    const existing = this.slots.get(key);
    if (existing) {
      this.markUsed(key);
      return existing;
    }
    const runtime = this.options.createRuntime(key);
    if (runtime.key !== key) throw new Error(`Python runtime scope factory returned the wrong key for ${key}.`);
    this.slots.set(key, runtime);
    this.markUsed(key);
    return runtime;
  }

  retain(runtime: Runtime): () => void {
    if (this.slots.get(runtime.key) !== runtime) {
      throw new Error(`Open Wrangler refused to lease detached Python scope ${runtime.key}.`);
    }
    runtime.leaseCount += 1;
    this.markUsed(runtime.key);
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      runtime.leaseCount = Math.max(0, runtime.leaseCount - 1);
      if (this.slots.get(runtime.key) === runtime) this.trimInactive();
    };
  }

  trimInactive(): void {
    let keys = this.retainedKeys();
    while (keys.size > this.maxRetainedInactiveScopes) {
      const ordered = [...keys].sort(
        (left, right) => (this.recency.get(left) ?? 0) - (this.recency.get(right) ?? 0) || left.localeCompare(right)
      );
      let evicted = false;
      for (const key of ordered) {
        const runtime = this.slots.get(key);
        if (runtime ? this.evictInactive(runtime) : this.evictOrphaned(key)) {
          evicted = true;
          break;
        }
      }
      if (!evicted) return;
      keys = this.retainedKeys();
    }
  }

  evictInactive(runtime: Runtime): boolean {
    if (this.slots.get(runtime.key) !== runtime || !this.isInactive(runtime)) return false;

    const selection = this.options.environmentSelections.get(runtime.key);
    const selectionEpoch = this.options.selectionEpochs.get(runtime.key);
    const recency = this.recency.get(runtime.key);
    if (!this.slots.delete(runtime.key)) return false;
    if (selection && this.options.environmentSelections.get(runtime.key) === selection) {
      this.options.abortSelection(selection);
      this.options.environmentSelections.delete(runtime.key);
    }
    if (this.options.selectionEpochs.get(runtime.key) === selectionEpoch) {
      this.options.selectionEpochs.delete(runtime.key);
    }
    if (this.recency.get(runtime.key) === recency) this.recency.delete(runtime.key);
    runtime.stderrBuffer = "";
    runtime.runtimeExitError = undefined;
    runtime.processSelection = undefined;
    runtime.processStartSelection = undefined;
    return true;
  }

  isInactive(runtime: Runtime): boolean {
    const selection = this.options.environmentSelections.get(runtime.key);
    const activeMissingSelection = this.options.activeMissingSelection();
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
      Boolean(activeMissingSelection && activeMissingSelection === selection)
    ) {
      return false;
    }
    return !this.options.hasExternalOwnership(runtime);
  }

  private markUsed(key: string): void {
    this.useClock += 1;
    this.recency.set(key, this.useClock);
  }

  private retainedKeys(): Set<string> {
    return new Set([
      ...this.slots.keys(),
      ...this.options.environmentSelections.keys(),
      ...this.options.selectionEpochs.keys(),
      ...this.recency.keys()
    ]);
  }

  private evictOrphaned(key: string): boolean {
    if (this.slots.has(key)) return false;
    // A selection without its owning slot may still be resolving. Fail closed
    // instead of guessing that it is safe to detach.
    if (this.options.environmentSelections.has(key)) return false;
    if (this.options.activeMissingSelection()?.key === key) return false;
    const selectionEpoch = this.options.selectionEpochs.get(key);
    const recency = this.recency.get(key);
    if (this.options.selectionEpochs.get(key) === selectionEpoch) {
      this.options.selectionEpochs.delete(key);
    }
    if (this.recency.get(key) === recency) this.recency.delete(key);
    return true;
  }
}
