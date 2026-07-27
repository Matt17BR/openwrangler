import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALLED_PERFORMANCE_ARTIFACT_RECEIPT_PROTOCOL,
  publishInstalledPerformanceFragment,
  sameInstalledPerformanceFragmentMetadata
} from "./extensionHost/fragmentPublication";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateDestination(): string {
  const root = mkdtempSync(join(tmpdir(), "ow-fragment-publication-"));
  roots.push(root);
  return join(root, "phase.json");
}

function expectedPayload(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function expectStableIdentityAcrossPublication(before: BigIntStats, after: BigIntStats): void {
  expect(after.dev).toBe(before.dev);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(after.birthtimeNs).toBe(before.birthtimeNs);
  expect(after.mode).toBe(before.mode);
  expect(after.uid).toBe(before.uid);
  expect(after.gid).toBe(before.gid);
}

describe("installed performance fragment publication", () => {
  it("returns a receipt for the descriptor-revalidated destination bytes", () => {
    const destination = privateDestination();
    const value = { protocol: 4, phase: "perf-parquet-warm", samples: [1, 2, 3] };
    const expected = expectedPayload(value);

    const receipt = publishInstalledPerformanceFragment(destination, value);

    expect(readFileSync(destination)).toEqual(expected);
    expect(receipt).toEqual({
      protocol: INSTALLED_PERFORMANCE_ARTIFACT_RECEIPT_PROTOCOL,
      bytes: expected.length,
      sha256: createHash("sha256").update(expected).digest("hex")
    });
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("treats ctime as transitional only at the hard-link commit boundaries", () => {
    const stable = {
      birthtimeNs: 1n,
      ctimeNs: 2n,
      dev: 3n,
      gid: 4n,
      ino: 5n,
      mode: 6n,
      mtimeNs: 7n,
      size: 8n,
      uid: 9n
    };
    const ctimeAdvanced = { ...stable, ctimeNs: 10n };

    expect(sameInstalledPerformanceFragmentMetadata(ctimeAdvanced, stable)).toBe(false);
    expect(sameInstalledPerformanceFragmentMetadata(ctimeAdvanced, stable, { compareCtime: false })).toBe(true);
    expect(
      sameInstalledPerformanceFragmentMetadata({ ...ctimeAdvanced, size: stable.size + 1n }, stable, {
        compareCtime: false
      })
    ).toBe(false);
  });

  it("uses a real atomic hard-link commit and retires only its temporary link", () => {
    const destination = privateDestination();
    const value = { protocol: 4, phase: "perf-csv-cold", samples: [11, 12] };
    let beforeLink: BigIntStats | undefined;
    let linkedTemporary: BigIntStats | undefined;
    let linkedDestination: BigIntStats | undefined;

    const receipt = publishInstalledPerformanceFragment(destination, value, {
      beforeLink(temporary) {
        beforeLink = lstatSync(temporary, { bigint: true });
      },
      afterLink(temporary, published) {
        linkedTemporary = lstatSync(temporary, { bigint: true });
        linkedDestination = lstatSync(published, { bigint: true });
      }
    });

    expect(beforeLink?.nlink).toBe(1n);
    expect(linkedTemporary?.nlink).toBe(2n);
    expect(linkedDestination?.nlink).toBe(2n);
    expectStableIdentityAcrossPublication(beforeLink as BigIntStats, linkedDestination as BigIntStats);
    expect(linkedTemporary?.dev).toBe(linkedDestination?.dev);
    expect(linkedTemporary?.ino).toBe(linkedDestination?.ino);
    expect(lstatSync(destination, { bigint: true }).nlink).toBe(1n);
    expect(receipt.bytes).toBe(expectedPayload(value).length);
    expect(readFileSync(destination)).toEqual(expectedPayload(value));
  });

  it("refuses a raced destination without changing its sentinel bytes", () => {
    const destination = privateDestination();
    const sentinel = Buffer.from("do not replace\n", "utf8");

    expect(() =>
      publishInstalledPerformanceFragment(
        destination,
        { protocol: 4, phase: "perf-csv-warm", samples: [13, 14] },
        {
          beforeLink(_temporary, published) {
            writeFileSync(published, sentinel, { flag: "wx", mode: 0o600 });
          }
        }
      )
    ).toThrow(/EEXIST|exist/u);

    expect(readFileSync(destination)).toEqual(sentinel);
    expect(readdirSync(dirname(destination))).toEqual(["phase.json"]);
  });

  it("rolls back both matching links when publication fails before temporary retirement", () => {
    const destination = privateDestination();

    expect(() =>
      publishInstalledPerformanceFragment(
        destination,
        { protocol: 4, phase: "perf-parquet-warm", samples: [15, 16] },
        {
          afterLink() {
            throw new Error("injected post-link failure");
          }
        }
      )
    ).toThrow(/injected post-link failure/u);

    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(dirname(destination))).toEqual([]);
  });

  it("rejects an in-place post-publication mutation and removes only the published inode", () => {
    const destination = privateDestination();
    const value = { protocol: 4, phase: "perf-grid-interaction", samples: [21, 22] };

    expect(() =>
      publishInstalledPerformanceFragment(destination, value, {
        afterPublishedOpen(published) {
          const bytes = readFileSync(published);
          bytes[bytes.length - 2] ^= 1;
          writeFileSync(published, bytes);
        }
      })
    ).toThrow(/changed while its published descriptor was read|destination bytes changed/u);

    expect(existsSync(destination)).toBe(false);
  });

  it("withholds cleanup if an unexpected hard link appears after temporary retirement", () => {
    const destination = privateDestination();
    const retained = `${destination}.retained`;

    expect(() =>
      publishInstalledPerformanceFragment(
        destination,
        { protocol: 4, phase: "perf-grid-interaction", samples: [23, 24] },
        {
          afterPublishedOpen(published) {
            linkSync(published, retained);
          }
        }
      )
    ).toThrow(/publication and identified-link cleanup both failed/u);

    expect(lstatSync(destination, { bigint: true }).nlink).toBe(2n);
    expect(lstatSync(retained, { bigint: true }).nlink).toBe(2n);
  });

  it.runIf(process.platform !== "win32")(
    "withholds post-publication cleanup when the destination path is substituted",
    () => {
      const destination = privateDestination();
      const retained = `${destination}.retained`;
      const replacement = Buffer.from('{"replacement":true}\\n', "utf8");

      expect(() =>
        publishInstalledPerformanceFragment(
          destination,
          { protocol: 4, phase: "perf-parquet-cold", samples: [31, 32] },
          {
            afterPublishedOpen(published) {
              renameSync(published, retained);
              writeFileSync(published, replacement, { flag: "wx", mode: 0o600 });
            }
          }
        )
      ).toThrow(/publication and identified-link cleanup both failed/u);

      expect(readFileSync(destination)).toEqual(replacement);
      expect(existsSync(retained)).toBe(true);
    }
  );
});
