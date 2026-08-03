import assert from "node:assert/strict";
import test from "node:test";
import { captureDataWranglerComparisonEnvironment } from "./data-wrangler-comparison-environment.mjs";

const fixturePath = "/study/fixtures/100000-50.csv";
const display = {
  mode: "headless-ozone",
  widthPx: 1920,
  heightPx: 1080,
  deviceScaleFactor: 1,
  colorDepth: 24
};
const zoom = {
  level: 0,
  theme: "Default Dark Modern",
  viewportWidthPx: 1920,
  viewportHeightPx: 1080,
  rowPageSize: 50,
  notebookLayoutSha256: "a".repeat(64)
};

function dependencies(overrides = {}) {
  const text = new Map([
    ["/etc/machine-id", "0123456789abcdef0123456789abcdef\n"],
    ["/etc/os-release", 'NAME="Example Linux"\nPRETTY_NAME="Example Linux 1"\n'],
    ["/proc/self/mountinfo", "36 25 8:1 / / rw,relatime - ext4 /dev/nvme0n1p1 rw,errors=remount-ro\n"],
    ["/sys/dev/block/8:1/device/model", "Example NVMe\n"],
    ["/sys/dev/block/8:1/queue/rotational", "0\n"]
  ]);
  return {
    captureGateProvenance: () => ({
      platform: "linux",
      architecture: "x64",
      kernelRelease: "6.8.0-example",
      cpu: {
        vendorId: "GenuineIntel",
        modelName: "Example CPU",
        logicalCpuCount: 8,
        onlineCpuList: "0-7",
        pinnedCpuIds: [2, 3]
      },
      power: {
        governors: [
          { cpuId: 2, governor: "performance" },
          { cpuId: 3, governor: "performance" }
        ]
      }
    }),
    memoryBytes: () => 16 * 1024 * 1024 * 1024,
    readText: (path) => {
      if (!text.has(path)) {
        const error = new Error(`Missing ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return text.get(path);
    },
    realpath: (path) => path,
    statFile: () => ({
      dev: 2049n,
      isFile: () => true,
      isSymbolicLink: () => false,
      nlink: 1n
    }),
    statFilesystem: () => ({ bsize: 4096n, blocks: 1_000_000n }),
    ...overrides
  };
}

test("environment capture binds the exact CPU, machine, and fixture volume without publishing paths", () => {
  const receipt = captureDataWranglerComparisonEnvironment(
    { cpuList: "2-3", fixturePath, display, zoom },
    dependencies()
  );
  assert.deepEqual(receipt.cpu.affinity, [2, 3]);
  assert.deepEqual(receipt.cpu.governors, [
    { processor: 2, governor: "performance" },
    { processor: 3, governor: "performance" }
  ]);
  assert.equal(receipt.machine.osRelease, "Example Linux 1");
  assert.equal(receipt.storage.deviceModel, "Example NVMe");
  assert.equal(receipt.storage.filesystemType, "ext4");
  assert.equal(receipt.storage.rotational, false);
  assert.match(receipt.machine.machineIdSha256, /^[0-9a-f]{64}$/u);
  assert.match(receipt.storage.fixtureVolumeIdentitySha256, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(receipt).includes(fixturePath), false);
});

test("environment capture fails closed on noncanonical affinity and unresolved storage provenance", () => {
  assert.throws(
    () => captureDataWranglerComparisonEnvironment({ cpuList: "2,3", fixturePath, display, zoom }, dependencies()),
    /canonical/u
  );
  assert.throws(
    () =>
      captureDataWranglerComparisonEnvironment(
        { cpuList: "2-3", fixturePath, display, zoom },
        dependencies({
          readText(path) {
            if (path === "/proc/self/mountinfo") return "36 25 8:2 / /other rw - ext4 /dev/other rw\n";
            return dependencies().readText(path);
          }
        })
      ),
    /absent from Linux mount information/u
  );
  assert.throws(
    () =>
      captureDataWranglerComparisonEnvironment(
        { cpuList: "2-3", fixturePath, display, zoom },
        dependencies({
          readText(path) {
            if (path === "/sys/dev/block/8:1/queue/rotational") {
              const error = new Error("missing");
              error.code = "ENOENT";
              throw error;
            }
            return dependencies().readText(path);
          }
        })
      ),
    /rotational state is unavailable/u
  );
});
