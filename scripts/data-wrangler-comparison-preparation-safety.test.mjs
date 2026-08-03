import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  executeIdentityPinnedPreparationInterpreter,
  readBoundedDataWranglerPreparationJson
} from "./data-wrangler-comparison-preparation.mjs";

function withRoot(t, prefix) {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("bounded preparation JSON rejects links, FIFOs, and oversized input without opening them", (t) => {
  const root = withRoot(t, "ow-preparation-json-types-");
  const source = resolve(root, "source.json");
  writeFileSync(source, "{}", { mode: 0o600 });
  const symbolic = resolve(root, "symbolic.json");
  symlinkSync(source, symbolic);
  assert.throws(
    () => readBoundedDataWranglerPreparationJson(symbolic, "Symbolic preparation JSON", 64),
    /owned, singly linked regular file/u
  );

  const hard = resolve(root, "hard.json");
  linkSync(source, hard);
  assert.throws(
    () => readBoundedDataWranglerPreparationJson(source, "Linked preparation JSON", 64),
    /owned, singly linked regular file/u
  );

  const fifo = resolve(root, "pipe.json");
  execFileSync("mkfifo", [fifo]);
  assert.throws(
    () => readBoundedDataWranglerPreparationJson(fifo, "FIFO preparation JSON", 64),
    /owned, singly linked regular file/u
  );

  const oversized = resolve(root, "oversized.json");
  writeFileSync(oversized, JSON.stringify({ value: "too large" }), { mode: 0o600 });
  assert.throws(
    () => readBoundedDataWranglerPreparationJson(oversized, "Oversized preparation JSON", 8),
    /within its byte bound/u
  );
});

test("bounded preparation JSON detects file and parent replacement after its descriptor opens", (t) => {
  const root = withRoot(t, "ow-preparation-json-swap-");
  const file = resolve(root, "value.json");
  writeFileSync(file, '{"value":1}', { mode: 0o600 });
  assert.throws(
    () =>
      readBoundedDataWranglerPreparationJson(file, "Swapped preparation JSON", 64, {
        afterOpen() {
          renameSync(file, resolve(root, "original.json"));
          writeFileSync(file, '{"value":2}', { mode: 0o600 });
        }
      }),
    /changed while it was read/u
  );

  const parent = resolve(root, "parent");
  mkdirSync(parent, { mode: 0o700 });
  const nested = resolve(parent, "value.json");
  writeFileSync(nested, '{"value":1}', { mode: 0o600 });
  assert.throws(
    () =>
      readBoundedDataWranglerPreparationJson(nested, "Reparented preparation JSON", 64, {
        afterOpen() {
          renameSync(parent, resolve(root, "original-parent"));
          mkdirSync(parent, { mode: 0o700 });
          writeFileSync(resolve(parent, "value.json"), '{"value":1}', { mode: 0o600 });
        }
      }),
    /or its parent changed while it was read/u
  );
});

test("the preparation interpreter executes its open descriptor and rejects named replacement", (t) => {
  const root = withRoot(t, "ow-preparation-interpreter-");
  const stable = resolve(root, "stable.sh");
  writeFileSync(stable, "#!/bin/sh\nprintf 'stable\\n'\n", { mode: 0o700 });
  chmodSync(stable, 0o700);
  assert.equal(executeIdentityPinnedPreparationInterpreter(stable, []), "stable\n");

  const replacing = resolve(root, "replacing.sh");
  const original = resolve(root, "replacing-original.sh");
  writeFileSync(
    replacing,
    `#!/bin/sh\nmv ${JSON.stringify(replacing)} ${JSON.stringify(original)}\nprintf '#!/bin/sh\\nprintf replacement\\n' > ${JSON.stringify(replacing)}\nchmod 700 ${JSON.stringify(replacing)}\nprintf 'descriptor\\n'\n`,
    { mode: 0o700 }
  );
  assert.throws(() => executeIdentityPinnedPreparationInterpreter(replacing, []), /changed while it executed/u);
});
