import assert from "node:assert/strict";
import test from "node:test";
import {
  PACKAGED_GRID_COLUMN_COPY_MODE,
  PACKAGED_GRID_COLUMN_COPY_PHASE,
  packagedGridColumnCopyEnvironment,
  resolvePackagedGridColumnCopySelection,
  runPackagedGridColumnCopySelector
} from "./packaged-grid-column-copy-selector.mjs";

test("selects one exact VS Code packaged phase", () => {
  assert.deepEqual(
    resolvePackagedGridColumnCopySelection({
      acceptanceMode: PACKAGED_GRID_COLUMN_COPY_MODE,
      requestedEditors: ["vscode"]
    }),
    { enabled: true, phase: PACKAGED_GRID_COLUMN_COPY_PHASE }
  );
  assert.deepEqual(resolvePackagedGridColumnCopySelection({ acceptanceMode: "full" }), {
    enabled: false,
    phase: undefined
  });
  for (const requestedEditors of [undefined, [], ["cursor"], ["vscode", "cursor"], ["vscode", "vscode"]]) {
    assert.throws(
      () =>
        resolvePackagedGridColumnCopySelection({
          acceptanceMode: PACKAGED_GRID_COLUMN_COPY_MODE,
          requestedEditors
        }),
      /requires exactly "vscode"/u
    );
  }
});

test("owns the mode and editor environment without replacing another lane", () => {
  assert.deepEqual(packagedGridColumnCopyEnvironment({ SENTINEL: "retained" }), {
    SENTINEL: "retained",
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
    OPEN_WRANGLER_PACKAGED_MODE: PACKAGED_GRID_COLUMN_COPY_MODE
  });
  assert.throws(
    () => packagedGridColumnCopyEnvironment({ OPEN_WRANGLER_PACKAGED_MODE: "platform-smoke" }),
    /cannot replace another acceptance mode/u
  );
  assert.throws(
    () => packagedGridColumnCopyEnvironment({ OPEN_WRANGLER_PACKAGED_EDITORS: "cursor" }),
    /requires exactly the pinned VS Code lane/u
  );
});

test("dispatches the runner once with bounded exact arguments", () => {
  const calls = [];
  runPackagedGridColumnCopySelector(["candidate.vsix"], {
    environment: { SENTINEL: "retained" },
    executable: "/node",
    execute: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0, signal: null };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "/node");
  assert.match(calls[0].args[0], /scripts[/\\]run-packaged-editor-tests\.mjs$/u);
  assert.deepEqual(calls[0].args.slice(1), ["candidate.vsix"]);
  assert.equal(calls[0].options.env.OPEN_WRANGLER_PACKAGED_MODE, PACKAGED_GRID_COLUMN_COPY_MODE);
  assert.equal(calls[0].options.env.OPEN_WRANGLER_PACKAGED_EDITORS, "vscode");
  assert.equal(calls[0].options.env.SENTINEL, "retained");
  assert.equal(calls[0].options.stdio, "inherit");
});

test("fails closed on invalid arguments and runner failure", () => {
  assert.throws(() => runPackagedGridColumnCopySelector(["bad\nargument"]), /invalid runner arguments/u);
  assert.throws(
    () =>
      runPackagedGridColumnCopySelector([], {
        execute: () => ({ status: 7, signal: null })
      }),
    /exit code 7/u
  );
});
