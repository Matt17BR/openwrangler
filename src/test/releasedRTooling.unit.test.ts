import { describe, expect, it, vi } from "vitest";
import {
  assertReleasedNativeREditorTooling,
  type ReleasedRToolingDependencies
} from "./extensionHost/releasedRTooling";

const versions = new Map([
  ["reditorsupport.r-syntax", "0.1.4"],
  ["reditorsupport.r", "2.8.8"],
  ["quarto.quarto", "1.135.0"]
]);

const commands = [
  "r.runSelection",
  "r.runSource",
  "r.knitRmdToHtml",
  "quarto.runCurrentCell",
  "quarto.renderDocument",
  "quarto.preview"
] as const;

interface FakeTooling {
  readonly dependencies: ReleasedRToolingDependencies;
  readonly activations: string[];
  readonly bounded: ReturnType<typeof vi.fn>;
  readonly configured: Map<string, unknown>;
}

function tooling(overrides: Partial<ReleasedRToolingDependencies> = {}): FakeTooling {
  const activations: string[] = [];
  const active = new Set<string>();
  const extensions = new Map(
    [...versions].map(([id, version]) => [
      id,
      {
        packageJSON: { version },
        get isActive(): boolean {
          return active.has(id);
        },
        activate: async () => {
          activations.push(id);
          active.add(id);
        }
      }
    ])
  );
  const configured = new Map<string, unknown>([
    ["quarto:path", "/private/quarto/bin/quarto"],
    ["quarto:render.previewType", "internal"],
    ["quarto:render.previewReveal", true]
  ]);
  const bounded = vi.fn();
  const withBoundedPromise: ReleasedRToolingDependencies["withBoundedPromise"] = async <T>(
    promise: PromiseLike<T>,
    timeoutMs: number,
    description: string
  ) => {
    bounded(promise, timeoutMs, description);
    return Promise.resolve(promise);
  };
  return {
    activations,
    bounded,
    configured,
    dependencies: {
      getExtension: (id) => extensions.get(id),
      getCommands: async () => commands,
      getConfiguration: <T>(section: string, key: string) => configured.get(`${section}:${key}`) as T | undefined,
      pathIsAbsolute: (candidate) => candidate.startsWith("/"),
      pathExists: (candidate) => candidate === "/private/quarto/bin/quarto",
      quartoVersion: () => "1.10.18",
      withBoundedPromise,
      ...overrides
    }
  };
}

describe("released R editor tooling", () => {
  it("returns false without probing commands or configuration when no tooling is installed", async () => {
    const getCommands = vi.fn(async () => commands);
    const configured = vi.fn();
    const fake = tooling({
      getExtension: () => undefined,
      getCommands,
      getConfiguration: <T>(section: string, key: string): T | undefined => {
        configured(section, key);
        return undefined;
      }
    });

    await expect(assertReleasedNativeREditorTooling(fake.dependencies)).resolves.toBe(false);
    expect(getCommands).not.toHaveBeenCalled();
    expect(configured).not.toHaveBeenCalled();
    expect(fake.activations).toEqual([]);
  });

  it("requires the complete exact extension set and versions", async () => {
    const missing = tooling({
      getExtension: (id) => (id === "reditorsupport.r-syntax" ? undefined : tooling().dependencies.getExtension(id))
    });
    await expect(assertReleasedNativeREditorTooling(missing.dependencies)).rejects.toThrow(
      "Packaged R acceptance requires reditorsupport.r-syntax@0.1.4."
    );

    const mismatchBase = tooling();
    const mismatch = tooling({
      getExtension: (id) =>
        id === "reditorsupport.r"
          ? { packageJSON: { version: "2.8.7" }, isActive: false, activate: async () => {} }
          : mismatchBase.dependencies.getExtension(id)
    });
    await expect(assertReleasedNativeREditorTooling(mismatch.dependencies)).rejects.toThrow(
      "Packaged R acceptance requires reditorsupport.r@2.8.8."
    );
  });

  it("activates the R and Quarto owners within the exact bound", async () => {
    const fake = tooling();
    await expect(assertReleasedNativeREditorTooling(fake.dependencies)).resolves.toBe(true);
    expect(fake.activations).toEqual(["reditorsupport.r", "quarto.quarto"]);
    expect(fake.bounded).toHaveBeenNthCalledWith(1, expect.any(Promise), 30_000, "activating reditorsupport.r");
    expect(fake.bounded).toHaveBeenNthCalledWith(2, expect.any(Promise), 30_000, "activating quarto.quarto");
  });

  it("requires every native R and Quarto command", async () => {
    const fake = tooling({ getCommands: async () => commands.filter((command) => command !== "quarto.preview") });
    await expect(assertReleasedNativeREditorTooling(fake.dependencies)).rejects.toThrow(
      "The native R/Quarto profile did not register quarto.preview."
    );
  });

  it("requires the pinned private Quarto path and internal revealed preview", async () => {
    await expect(assertReleasedNativeREditorTooling(tooling({ pathExists: () => false }).dependencies)).rejects.toThrow(
      "Quarto must use the pinned private CLI."
    );

    const previewType = tooling();
    previewType.configured.set("quarto:render.previewType", "external");
    await expect(assertReleasedNativeREditorTooling(previewType.dependencies)).rejects.toThrow(
      "The native editor journey must keep Quarto previews inside VS Code."
    );

    const previewReveal = tooling();
    previewReveal.configured.set("quarto:render.previewReveal", false);
    await expect(assertReleasedNativeREditorTooling(previewReveal.dependencies)).rejects.toThrow(
      "The native editor journey must reveal the Quarto preview."
    );
  });

  it("requires the exact Quarto CLI release", async () => {
    const fake = tooling({ quartoVersion: () => "1.10.17" });
    await expect(assertReleasedNativeREditorTooling(fake.dependencies)).rejects.toThrow(
      "The native editor journey must use Quarto 1.10.18."
    );
  });
});
