import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Uri } from "vscode";
import { beginAtomicFileTransaction, createNodeAtomicExportFileSystem } from "../extension/files/safeFileExport";

const SOURCE_CONTENTS = "value\n1\n";
const PRIOR_DESTINATION_CONTENTS = "old destination";
const EXPORTED_CONTENTS = "value\n2\n";

describe("safe file export hard-link ownership", () => {
  let directory: string;
  let source: string;
  let destination: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "openwrangler-safe-export-hardlink-"));
    source = path.join(directory, "source.csv");
    destination = path.join(directory, "cleaned.csv");
    await writeFile(source, SOURCE_CONTENTS);
    await writeFile(destination, PRIOR_DESTINATION_CONTENTS);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses to publish or remove a worker target that gained a real hard-link alias", async () => {
    const alias = path.join(directory, "worker-target-alias");
    const transaction = await beginAtomicFileTransaction({
      destination: fileUri(destination),
      protectedSources: [fileUri(source)],
      createTemporaryId: () => "worker-hardlink"
    });
    const workerTarget = await transaction.prepareExternalWriter();
    await writeFile(workerTarget.path, EXPORTED_CONTENTS);
    await link(workerTarget.path, alias);

    await expect(transaction.commit()).rejects.toThrow(/temporary export file changed/u);
    await expect(transaction.rollback()).rejects.toThrow(/could not be rolled back completely/u);

    expect(await readFile(workerTarget.path, "utf8")).toBe(EXPORTED_CONTENTS);
    expect(await readFile(alias, "utf8")).toBe(EXPORTED_CONTENTS);
    expect((await stat(workerTarget.path, { bigint: true })).nlink).toBe(2n);
    await expectFixturePreserved();
  });

  it("uses the host-local stat receipt to reject an injected temporary link-count change", async () => {
    const base = createNodeAtomicExportFileSystem();
    let workerPrepared = false;
    let replaceCalls = 0;
    let removeCalls = 0;
    const transaction = await beginAtomicFileTransaction({
      destination: fileUri(destination),
      protectedSources: [fileUri(source)],
      fileSystem: {
        ...base,
        stat: async (target) => {
          const details = await base.stat(target);
          return workerPrepared && path.basename(target).startsWith(".openwrangler-")
            ? { ...details, nlink: 2n }
            : details;
        },
        replace: async () => {
          replaceCalls += 1;
        },
        remove: async () => {
          removeCalls += 1;
        }
      },
      createTemporaryId: () => "injected-hardlink"
    });
    await transaction.prepareExternalWriter();
    workerPrepared = true;

    await expect(transaction.commit()).rejects.toThrow(/temporary export file changed/u);
    await expect(transaction.rollback()).rejects.toThrow(/could not be rolled back completely/u);

    expect(replaceCalls).toBe(0);
    expect(removeCalls).toBe(0);
    await expectFixturePreserved();
  });

  async function expectFixturePreserved(): Promise<void> {
    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await readFile(destination, "utf8")).toBe(PRIOR_DESTINATION_CONTENTS);
  }
});

function fileUri(fsPath: string): Uri {
  return { scheme: "file", fsPath, authority: "" } as Uri;
}
