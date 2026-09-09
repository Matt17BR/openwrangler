import assert from "node:assert/strict";
import { writeFile } from "node:fs";
import { get, globalAgent } from "node:https";
import { registerHooks } from "node:module";
import { connect } from "node:net";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "@vscode/test-electron"
      ? { url: import.meta.url, shortCircuit: true }
      : nextResolve(specifier, context);
  }
});

export async function downloadAndUnzipVSCode() {
  globalAgent.createConnection = () =>
    connect({ host: "127.0.0.1", port: Number(process.env.EDITOR_DOWNLOAD_TEST_PORT) });
  await new Promise((resolve, reject) => {
    const request = get("https://download.test.invalid/", (response) => {
      assert.equal(response.statusCode, 503);
      resolve();
    });
    assert.equal(request.agent, globalAgent);
    request.on("error", reject);
  });
  // Natural exit must allow pending filesystem work to complete too.
  setImmediate(() => {
    writeFile(join(process.env.EDITOR_DOWNLOAD_TEST_DIRECTORY, "completed"), "complete\n", (error) => {
      if (error) throw error;
    });
  });
  if (process.env.EDITOR_DOWNLOAD_TEST_FAILURE === "true") {
    const error = new Error("Synthetic download failure");
    error.stack = error.message;
    throw error;
  }
  return join(process.env.EDITOR_DOWNLOAD_TEST_DIRECTORY, "code");
}
