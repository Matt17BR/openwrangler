import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  instrumentedRuntimeMarkerImportLine,
  instrumentedRuntimeMarkers,
  instrumentedRuntimeStarts
} from "./extensionHost/instrumentedPythonEnvironment";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function markerDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-instrumented-python-"));
  roots.push(root);
  return root;
}

describe("instrumented Python environment", () => {
  it("builds one JSON-safe, once-only, runtime-root marker import", () => {
    const directory = '/fixture/runtime-starts-"quoted"';
    const source = instrumentedRuntimeMarkerImportLine(directory);

    expect(source).toContain("os.environ.get('PYTHONPATH', '').split(os.pathsep, 1)[0]");
    expect(source).toContain("'openwrangler_runtime', 'server.py'");
    expect(source).toContain("not hasattr(sys, '_openwrangler_acceptance_runtime_marked')");
    expect(source).toContain("setattr(sys, '_openwrangler_acceptance_runtime_marked', True)");
    expect(source).toContain(`os.path.join(${JSON.stringify(directory)}, `);
    expect(source).toContain("'runtime-' + uuid.uuid4().hex + '.marker'), 'x').close()");
  });

  it("counts only exact lowercase 32-hex runtime markers", () => {
    const directory = markerDirectory();
    for (const name of [
      "runtime-0123456789abcdef0123456789abcdef.marker",
      "runtime-ABCDEF0123456789ABCDEF0123456789.marker",
      "runtime-0123.marker",
      "foreign.marker"
    ]) {
      writeFileSync(join(directory, name), "");
    }
    const environment = { executable: "/fixture/python", runtimeMarkerDirectory: directory };

    expect(instrumentedRuntimeMarkers(environment)).toEqual(["runtime-0123456789abcdef0123456789abcdef.marker"]);
    expect(instrumentedRuntimeStarts(environment)).toBe(1);
  });

  it("fails closed before filtering an unbounded marker directory", () => {
    const directory = markerDirectory();
    for (let index = 0; index < 17; index += 1) writeFileSync(join(directory, `entry-${index}`), "");

    expect(() =>
      instrumentedRuntimeMarkers({ executable: "/fixture/python", runtimeMarkerDirectory: directory })
    ).toThrowError(/fixed bound/u);
  });
});
