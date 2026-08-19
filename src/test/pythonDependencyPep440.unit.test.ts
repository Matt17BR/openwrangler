import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { classifyDependencyProbe, probeDependencies } from "../extension/pythonEnvironment";
import type { PythonDependency } from "../extension/pythonEnvironmentModel";

const execFileAsync = promisify(execFile);

interface VersionContract {
  dependency: PythonDependency;
  cases: { name: string; version: string; supported: boolean }[];
}

describe("selected-interpreter PEP 440 dependency probing", () => {
  it("trusts only the selected interpreter's compatibility decision", () => {
    const dependency = contract().dependency;
    expect(classifyDependencyProbe([dependency], { [dependency.importModule]: { supported: true } })).toEqual({
      available: [dependency.importModule],
      missing: []
    });
    for (const observed of [
      {},
      { [dependency.importModule]: { supported: false } },
      { [dependency.importModule]: { supported: "true" } }
    ]) {
      expect(classifyDependencyProbe([dependency], observed)).toEqual({
        available: [],
        missing: [dependency.installSpec]
      });
    }
  });

  it("matches the post-install PEP 440 contract in a real isolated probe", async () => {
    const fixture = contract();
    const root = await mkdtemp(path.join(tmpdir(), "openwrangler-pep440-probe-"));
    try {
      const environment = path.join(root, "venv");
      await execFileAsync(selectedPython(), ["-m", "venv", environment], { timeout: 30_000 });
      const executable = path.join(
        environment,
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python"
      );
      const { stdout } = await execFileAsync(
        executable,
        ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
        { timeout: 10_000 }
      );
      const purelib = stdout.trim();
      await writeFile(path.join(purelib, `${fixture.dependency.importModule}.py`), "VALUE = 1\n", "utf8");
      const metadataRoot = path.join(purelib, `${fixture.dependency.importModule}-0.dist-info`);
      await mkdir(metadataRoot);

      for (const entry of fixture.cases) {
        await writeFile(
          path.join(metadataRoot, "METADATA"),
          ["Metadata-Version: 2.1", `Name: ${fixture.dependency.distribution}`, `Version: ${entry.version}`, ""].join(
            "\n"
          ),
          "utf8"
        );
        await expect(probeDependencies(executable, [fixture.dependency]), entry.name).resolves.toEqual(
          entry.supported
            ? { available: [fixture.dependency.importModule], missing: [] }
            : { available: [], missing: [fixture.dependency.installSpec] }
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function contract(): VersionContract {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "fixtures", "dependency-version-contract.json"), "utf8")
  ) as VersionContract;
}

function selectedPython(): string {
  return (
    process.env.OPEN_WRANGLER_TEST_PYTHON ??
    process.env.OPEN_WRANGLER_PYTHON ??
    (process.platform === "win32" ? "python" : "python3")
  );
}
