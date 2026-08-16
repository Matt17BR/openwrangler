import { describe, expect, it, vi } from "vitest";
import {
  cleanupAcceptanceTemporaryDirectory,
  exerciseAcceptanceTemporaryDirectoryCleanupContract,
  resolveAcceptanceTemporaryDirectory,
  type AcceptanceTemporaryDirectoryDependencies
} from "./extensionHost/acceptanceTemporaryDirectory";

function dependencies(
  overrides: Partial<AcceptanceTemporaryDirectoryDependencies> = {}
): AcceptanceTemporaryDirectoryDependencies {
  return {
    platform: "linux",
    isolatedTempRoot: "/isolated/tmp",
    extensionTests: "1",
    lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    remove: vi.fn(),
    makeTemp: (prefix) => `${prefix}Ab12`,
    exists: () => false,
    ...overrides
  };
}

describe("acceptance temporary directory ownership", () => {
  it("resolves and removes only one real direct child on non-Windows hosts", () => {
    const remove = vi.fn();
    const owned = "/isolated/tmp/openwrangler-fixture-Ab12";
    const injected = dependencies({ remove });

    expect(resolveAcceptanceTemporaryDirectory(owned, injected)).toBe(owned);
    cleanupAcceptanceTemporaryDirectory(owned, injected);
    expect(remove).toHaveBeenCalledWith(owned, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  });

  it("rejects the temp root, descendants, escapes, files, and symlinks before removal", () => {
    const remove = vi.fn();
    const realDirectory = dependencies({ remove });
    for (const candidate of [
      "/isolated/tmp",
      "/isolated/tmp/openwrangler-fixture/nested",
      "/isolated/outside",
      "/outside/openwrangler-fixture"
    ]) {
      expect(() => cleanupAcceptanceTemporaryDirectory(candidate, realDirectory)).toThrowError(/direct children/u);
    }
    expect(() =>
      cleanupAcceptanceTemporaryDirectory(
        "/isolated/tmp/openwrangler-file",
        dependencies({ remove, lstat: () => ({ isDirectory: () => false, isSymbolicLink: () => false }) })
      )
    ).toThrowError(/real directory/u);
    expect(() =>
      cleanupAcceptanceTemporaryDirectory(
        "/isolated/tmp/openwrangler-link",
        dependencies({ remove, lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => true }) })
      )
    ).toThrowError(/real directory/u);
    expect(remove).not.toHaveBeenCalled();
  });

  it("defers a verified Windows fixture until the outer Job Object cleanup", () => {
    const remove = vi.fn();
    const injected = dependencies({
      platform: "win32",
      isolatedTempRoot: "/runner/ow/x-Ab12",
      extensionTests: "1",
      remove
    });

    cleanupAcceptanceTemporaryDirectory("/runner/ow/x-Ab12/openwrangler-fixture-Cd34", injected);
    expect(remove).not.toHaveBeenCalled();
  });

  it("fails closed on every incomplete Windows ownership proof", () => {
    const fixture = "/runner/ow/x-Ab12/openwrangler-fixture-Cd34";
    const cases: ReadonlyArray<readonly [Partial<AcceptanceTemporaryDirectoryDependencies>, string, RegExp]> = [
      [{ extensionTests: undefined }, fixture, /editor acceptance harness/u],
      [{ isolatedTempRoot: "/runner/not-ow/x-Ab12" }, "/runner/not-ow/x-Ab12/openwrangler-fixture", /temp parent/u],
      [{ isolatedTempRoot: "/runner/ow/shared" }, "/runner/ow/shared/openwrangler-fixture", /random temp root/u],
      [{}, "/runner/ow/x-Ab12/foreign-fixture", /Open Wrangler-owned random directory/u]
    ];
    for (const [overrides, candidate, message] of cases) {
      const remove = vi.fn();
      expect(() =>
        cleanupAcceptanceTemporaryDirectory(
          candidate,
          dependencies({
            platform: "win32",
            isolatedTempRoot: "/runner/ow/x-Ab12",
            extensionTests: "1",
            remove,
            ...overrides
          })
        )
      ).toThrowError(message);
      expect(remove).not.toHaveBeenCalled();
    }
  });

  it("exercises the real host cleanup contract without retaining its fixture", () => {
    expect(() => exerciseAcceptanceTemporaryDirectoryCleanupContract()).not.toThrow();
  });
});
