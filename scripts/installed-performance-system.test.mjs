import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeLinuxDevice,
  readInstalledPlatformProvenance,
  readInstalledStorageProvenance
} from "./installed-performance-system.mjs";

test("platform and storage provenance are path-free and bounded", () => {
  const platform = readInstalledPlatformProvenance({ editorDisplayMode: "headless" });
  assert.equal(typeof platform.operatingSystem, "string");
  assert.equal(platform.editorDisplayMode, "headless");
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
