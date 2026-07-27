import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createInstalledResourceSampler,
  decodeLinuxDevice,
  isOpenWranglerRuntimeCommand,
  parseLinuxProcessStat,
  parseLinuxStatusRssBytes,
  readInstalledPlatformProvenance,
  readInstalledStorageProvenance,
  readLinuxProcessGroupSample
} from "./installed-performance-system.mjs";

test("platform and storage provenance are path-free and bounded", () => {
  const platform = readInstalledPlatformProvenance();
  assert.equal(typeof platform.operatingSystem, "string");
  assert.ok(platform.logicalCpuCount > 0);
  assert.ok(platform.totalMemoryBytes > 0);
  assert.ok(platform.cpuModel.length > 0);

  const storage = readInstalledStorageProvenance(process.cwd());
  assert.match(storage.filesystemType, /^(?:[a-z0-9-]+|linux-magic-0x[0-9a-f]+)$/u);
  assert.ok(storage.blockSizeBytes > 0);
  assert.equal(JSON.stringify(storage).includes(process.cwd()), false);
});

test("Linux device decoding preserves ordinary major and minor numbers", () => {
  const encoded = (259n << 8n) | 7n;
  assert.deepEqual(decodeLinuxDevice(encoded), { major: 259, minor: 7 });
});

test("Linux proc parsers reject malformed values and identify the runtime command", () => {
  assert.deepEqual(parseLinuxProcessStat(processStat(123, 77)), { pid: 123, processGroupId: 77 });
  assert.equal(parseLinuxProcessStat("not a stat"), undefined);
  assert.equal(parseLinuxStatusRssBytes("Name:\ttest\nVmRSS:\t123 kB\n"), 125_952);
  assert.equal(parseLinuxStatusRssBytes("VmRSS:\t0 kB\n"), undefined);
  assert.equal(isOpenWranglerRuntimeCommand(["python", "-s", "-m", "openwrangler_runtime.server"]), true);
  assert.equal(isOpenWranglerRuntimeCommand(["python", "-m", "other"]), false);
});

test("Linux process-group sampling totals the tree and isolates the Open Wrangler runtime", async () => {
  const procRoot = await mkdtemp(join(tmpdir(), "ow-installed-proc-"));
  try {
    await writeProcess(procRoot, 101, 77, 100, ["code", "--wait"]);
    await writeProcess(procRoot, 102, 77, 40, ["python", "-s", "-m", "openwrangler_runtime.server"]);
    await writeProcess(procRoot, 103, 88, 500, ["other"]);

    assert.deepEqual(readLinuxProcessGroupSample(77, { procRoot }), {
      editorTreeRssBytes: 140 * 1024,
      pythonRuntimeRssBytes: 40 * 1024
    });
  } finally {
    await rm(procRoot, { recursive: true, force: true });
  }
});

test("the resource sampler records bounded samples and requires a released process group", async () => {
  const procRoot = await mkdtemp(join(tmpdir(), "ow-installed-proc-"));
  try {
    await writeProcess(procRoot, 201, 177, 120, ["code", "--wait"]);
    await writeProcess(procRoot, 202, 177, 50, ["python", "-s", "-m", "openwrangler_runtime.server"]);
    const sampler = createInstalledResourceSampler({ procRoot, platform: "linux", intervalMs: 60_000 });
    sampler.begin("perf-grid-interaction", 177);
    await rm(join(procRoot, "201"), { recursive: true });
    await rm(join(procRoot, "202"), { recursive: true });
    sampler.end();

    assert.deepEqual(sampler.finish(), {
      supported: true,
      sampler: "linux-proc-process-group-v1",
      peakEditorTreeRssBytes: 170 * 1024,
      peakPythonRuntimeRssBytes: 50 * 1024,
      samples: [
        {
          stage: "perf-grid-interaction:0001",
          editorTreeRssBytes: 170 * 1024,
          pythonRuntimeRssBytes: 50 * 1024
        }
      ]
    });
  } finally {
    await rm(procRoot, { recursive: true, force: true });
  }
});

test("the resource sampler rejects a surviving process group", async () => {
  const procRoot = await mkdtemp(join(tmpdir(), "ow-installed-proc-"));
  try {
    await writeProcess(procRoot, 301, 277, 120, ["code", "--wait"]);
    const sampler = createInstalledResourceSampler({ procRoot, platform: "linux", intervalMs: 60_000 });
    sampler.begin("perf-csv-cold", 277);
    assert.throws(() => sampler.end(), /surviving editor process group/u);
  } finally {
    await rm(procRoot, { recursive: true, force: true });
  }
});

async function writeProcess(procRoot, pid, processGroupId, rssKibibytes, command) {
  const directory = join(procRoot, String(pid));
  await mkdir(directory);
  await writeFile(join(directory, "stat"), processStat(pid, processGroupId));
  await writeFile(join(directory, "status"), `Name:\ttest\nVmRSS:\t${rssKibibytes} kB\n`);
  await writeFile(join(directory, "cmdline"), `${command.join("\0")}\0`);
}

function processStat(pid, processGroupId) {
  const fields = ["S", "1", String(processGroupId), ...Array.from({ length: 18 }, () => "0"), "1"];
  return `${pid} (editor helper) ${fields.join(" ")}\n`;
}
