import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DependencyProbe, PythonEnvironment } from "../extension/pythonEnvironment";
import {
  DetachedDependencyProbeError,
  PythonDependencyProbeRegistry,
  dependencyProbeKey,
  pythonEnvironmentIdentityKey,
  pythonPackageEnvironmentKey
} from "../extension/pythonDependencyState";
import type { PythonDependency } from "../extension/pythonEnvironmentModel";

const environment = testEnvironment("/env/bin/python", "/env", "3.12.4");
const dependency: PythonDependency = {
  importModule: "polars",
  distribution: "polars",
  installSpec: "polars"
};

describe("PythonDependencyProbeRegistry", () => {
  it("coalesces only an exact environment identity and ordered descriptor sequence", async () => {
    const pending = deferred<DependencyProbe>();
    const launch = vi.fn(() => pending.promise);
    const registry = new PythonDependencyProbeRegistry(() => false, launch);

    const first = registry.probe(environment, [dependency]);
    const second = registry.probe(environment, [dependency]);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());

    expect(first.key).toBe(second.key);
    expect(first.result).toBe(second.result);
    expect(registry.diagnostics()).toMatchObject({ completedCount: 0, inFlightCount: 1 });

    pending.resolve({ missing: [], available: ["polars"] });
    const [firstOutcome, secondOutcome] = await Promise.all([first.result, second.result]);
    expect(firstOutcome.missing).toEqual([]);
    expect(firstOutcome.isCurrent()).toBe(true);
    expect(secondOutcome.isCurrent()).toBe(true);
    expect(registry.diagnostics()).toMatchObject({ completedCount: 1, inFlightCount: 0 });
  });

  it("includes every dependency descriptor field, order, and executable identity field in its key", () => {
    const baseline: PythonDependency = {
      importModule: "engine",
      distribution: "engine-dist",
      installSpec: "shared-install-spec",
      minimumVersion: "1.0",
      maximumVersionExclusive: "2.0"
    };
    const descriptors: PythonDependency[] = [
      baseline,
      { ...baseline, importModule: "other-engine" },
      { ...baseline, distribution: "other-dist" },
      { ...baseline, installSpec: "other-install-spec" },
      { ...baseline, exactVersion: "1.0.0" },
      { ...baseline, minimumVersion: "1.1" },
      { ...baseline, maximumVersionExclusive: "2.1" }
    ];
    const keys = descriptors.map((candidate) => dependencyProbeKey(environment, [candidate]));
    expect(new Set(keys).size).toBe(descriptors.length);
    expect(dependencyProbeKey(environment, [baseline, dependency])).not.toBe(
      dependencyProbeKey(environment, [dependency, baseline])
    );

    for (const changed of [
      { ...environment, executable: executablePath("/env/bin/python3") },
      { ...environment, version: "3.13.1" },
      { ...environment, packageRoot: "/env/alias" },
      { ...environment, packageRootIdentity: identity("package-other") },
      { ...environment, executableIdentity: executableIdentity("executable-other") }
    ]) {
      expect(dependencyProbeKey(changed, [baseline])).not.toBe(dependencyProbeKey(environment, [baseline]));
    }
  });

  it.each(["success", "rejection"] as const)(
    "prevents a detached old-probe %s from deleting or publishing over its same-key replacement",
    async (completion) => {
      const stale = deferred<DependencyProbe>();
      const current = deferred<DependencyProbe>();
      const launch = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
      const registry = new PythonDependencyProbeRegistry(() => false, launch);

      const staleHandle = registry.probe(environment, [dependency]);
      const staleOutcome = Promise.resolve(staleHandle.result).catch((error: unknown) => error);
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      registry.invalidateKey(staleHandle.key);
      const currentHandle = registry.probe(environment, [dependency]);
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));

      if (completion === "success") stale.resolve({ missing: ["polars"], available: [] });
      else stale.reject(new Error("old probe failed"));
      await expect(staleOutcome).resolves.toBeInstanceOf(DetachedDependencyProbeError);
      expect(registry.diagnostics()).toMatchObject({ completedCount: 0, inFlightCount: 1 });

      current.resolve({ missing: [], available: ["polars"] });
      const outcome = await currentHandle.result;
      expect(outcome.missing).toEqual([]);
      expect(outcome.isCurrent()).toBe(true);
      expect(registry.completedMissing(currentHandle.key)).toEqual([]);
    }
  );

  it("rejects a deferred launch invalidated before the probe process begins", async () => {
    const launch = vi.fn(async () => ({ missing: [], available: ["polars"] }));
    const registry = new PythonDependencyProbeRegistry(() => false, launch);
    const handle = registry.probe(environment, [dependency]);

    registry.invalidateKey(handle.key);

    await expect(handle.result).rejects.toBeInstanceOf(DetachedDependencyProbeError);
    expect(launch).not.toHaveBeenCalled();
    expect(registry.isEmpty).toBe(true);
  });

  it("makes every joined consumer stale when invalidation follows publication", async () => {
    const pending = deferred<DependencyProbe>();
    const registry = new PythonDependencyProbeRegistry(
      () => false,
      () => pending.promise
    );
    const first = registry.probe(environment, [dependency]);
    const second = registry.probe(environment, [dependency]);

    pending.resolve({ missing: ["polars"], available: [] });
    const [firstOutcome, secondOutcome] = await Promise.all([first.result, second.result]);
    registry.invalidateKey(first.key);

    expect(firstOutcome.isCurrent()).toBe(false);
    expect(secondOutcome.isCurrent()).toBe(false);
    expect(registry.isEmpty).toBe(true);
  });

  it("detaches every executable identity owned by one mutating package root", async () => {
    const launches = [deferred<DependencyProbe>(), deferred<DependencyProbe>()];
    const launch = vi.fn().mockReturnValueOnce(launches[0]!.promise).mockReturnValueOnce(launches[1]!.promise);
    const registry = new PythonDependencyProbeRegistry(() => false, launch);
    const firstEnvironment = testEnvironment("/env/bin/python", "/env", "3.12.4");
    const secondEnvironment = testEnvironment("/env/bin/python3", "/env", "3.13.2");
    secondEnvironment.packageRootIdentity = firstEnvironment.packageRootIdentity;
    const first = registry.probe(firstEnvironment, [dependency]);
    const second = registry.probe(secondEnvironment, [dependency]);
    const outcomes = [first, second].map(({ result }) => Promise.resolve(result).catch((error: unknown) => error));
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));

    registry.invalidatePackageEnvironment(pythonPackageEnvironmentKey(firstEnvironment));
    launches[0]!.resolve({ missing: [], available: ["polars"] });
    launches[1]!.resolve({ missing: [], available: ["polars"] });

    await expect(Promise.all(outcomes)).resolves.toEqual([
      expect.any(DetachedDependencyProbeError),
      expect.any(DetachedDependencyProbeError)
    ]);
    expect(registry.isEmpty).toBe(true);
  });

  it("does not cache failures and permits the exact request to retry", async () => {
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("probe failed"))
      .mockResolvedValueOnce({ missing: [], available: ["polars"] });
    const registry = new PythonDependencyProbeRegistry(() => false, launch);

    await expect(registry.probe(environment, [dependency]).result).rejects.toThrow("probe failed");
    expect(registry.isEmpty).toBe(true);
    await expect(registry.probe(environment, [dependency]).result).resolves.toMatchObject({ missing: [] });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(registry.diagnostics().completedCount).toBe(1);
  });

  it("bounds completed results to 128 entries and refreshes recency on a cache hit", async () => {
    const registry = new PythonDependencyProbeRegistry(
      () => false,
      async () => ({ missing: [], available: ["engine"] })
    );
    const descriptor = (index: number): PythonDependency => ({
      importModule: `engine_${index}`,
      distribution: `engine-${index}`,
      installSpec: `engine-${index}`
    });
    for (let index = 0; index < 128; index += 1) await registry.probe(environment, [descriptor(index)]).result;
    const initial = registry.diagnostics().completedKeys;

    await registry.probe(environment, [descriptor(0)]).result;
    await registry.probe(environment, [descriptor(128)]).result;
    const completed = registry.diagnostics().completedKeys;

    expect(completed).toHaveLength(128);
    expect(completed).toContain(initial[0]);
    expect(completed).not.toContain(initial[1]);
    expect(completed).toContain(initial[2]);
    expect(completed.at(-1)).not.toBe(initial[0]);
  });

  it("fails before launch for a non-absolute executable", () => {
    const launch = vi.fn();
    const registry = new PythonDependencyProbeRegistry(() => false, launch);

    expect(() => registry.probe({ ...environment, executable: "python" }, [dependency])).toThrow(
      "absolute executable path"
    );
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("Python dependency environment identity", () => {
  it("normalizes executable aliases but retains package-root and file identity", () => {
    const alias = { ...environment, executable: executablePath("/env/bin/../bin/python") };
    expect(pythonEnvironmentIdentityKey(alias)).toBe(pythonEnvironmentIdentityKey(environment));
    expect(pythonEnvironmentIdentityKey({ ...alias, version: "3.13.0" })).not.toBe(
      pythonEnvironmentIdentityKey(environment)
    );
  });
});

function testEnvironment(executable: string, packageRoot: string, version: string): PythonEnvironment {
  return {
    executable: executablePath(executable),
    executableIdentity: executableIdentity(`executable:${executable}`),
    packageRoot,
    packageRootIdentity: identity(`package:${packageRoot}`),
    version,
    source: "configuration"
  };
}

function executablePath(posixPath: string): string {
  return process.platform === "win32" ? win32.join("C:\\", ...posixPath.split("/").filter(Boolean)) : posixPath;
}

function identity(value: string): { device: string; inode: string } {
  return { device: "1", inode: hash(value) };
}

function executableIdentity(value: string): PythonEnvironment["executableIdentity"] {
  const inode = hash(value);
  return {
    device: "2",
    inode,
    size: String(16_384 + (Number(inode) % 4096)),
    mtimeNs: String(1_700_000_000_000_000_000n + BigInt(inode)),
    ctimeNs: String(1_700_000_100_000_000_000n + BigInt(inode))
  };
}

function hash(value: string): string {
  let result = 2_166_136_261;
  for (const codePoint of value) {
    result ^= codePoint.codePointAt(0) ?? 0;
    result = Math.imul(result, 16_777_619);
  }
  return String(result >>> 0);
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
