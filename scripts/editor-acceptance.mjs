import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function writeEditorAcceptanceHarness(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "package.json"),
    JSON.stringify({
      name: "data-explorer-packaged-test-harness",
      displayName: "Data Explorer packaged test harness",
      version: "0.0.0",
      publisher: "data-explorer-tests",
      engines: { vscode: "^1.105.0" },
      main: "./extension.js",
      activationEvents: ["*"]
    })
  );
  writeFileSync(
    resolve(directory, "extension.js"),
    `const fs = require("node:fs");
const vscode = require("vscode");

exports.activate = async function () {
  let outcome;
  try {
    await require(process.env.DATA_EXPLORER_TEST_MODULE).run();
    outcome = { ok: true };
  } catch (error) {
    console.error(error);
    outcome = { ok: false, error: error instanceof Error ? error.stack || error.message : String(error) };
  }
  fs.writeFileSync(process.env.DATA_EXPLORER_TEST_RESULT, JSON.stringify(outcome));
  setTimeout(() => void vscode.commands.executeCommand("workbench.action.quit"), 2_000);
  setTimeout(() => void vscode.commands.executeCommand("workbench.action.closeWindow"), 500);
};
`
  );
}

export async function runEditorAcceptancePhase({
  editor,
  workspace,
  userData,
  extensions,
  developmentPaths,
  testModule,
  python,
  phase,
  resultPath
}) {
  rmSync(resultPath, { force: true });
  const sandboxArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
  const sharedDataArgs = editor.sharedDataDir ? ["--shared-data-dir", resolve(userData, "shared-data")] : [];
  const child = spawn(
    editor.executable,
    [
      workspace,
      "--user-data-dir",
      userData,
      "--extensions-dir",
      extensions,
      ...sharedDataArgs,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
      "--wait",
      ...developmentPaths.map((value) => `--extensionDevelopmentPath=${value}`),
      ...sandboxArgs
    ],
    {
      env: {
        ...process.env,
        DATA_EXPLORER_EXTENSION_TESTS: "1",
        DATA_EXPLORER_TEST_PHASE: phase,
        DATA_EXPLORER_TEST_PYTHON: python,
        DATA_EXPLORER_TEST_MODULE: testModule,
        DATA_EXPLORER_TEST_RESULT: resultPath
      },
      encoding: "utf8",
      stdio: "inherit"
    }
  );

  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + 180_000;
  while (!existsSync(resultPath) && isRunning() && Date.now() < deadline) {
    await delay(100);
  }

  if (!existsSync(resultPath)) {
    if (isRunning()) child.kill("SIGTERM");
    throw new Error(`${editor.name} ${phase} acceptance exited without writing a result.`);
  }
  const outcome = JSON.parse(readFileSync(resultPath, "utf8"));

  const closedInApp = await Promise.race([exit.then(() => true), delay(3_500).then(() => false)]);
  if (!closedInApp && isRunning()) {
    child.kill("SIGTERM");
    const terminated = await Promise.race([exit.then(() => true), delay(10_000).then(() => false)]);
    if (!terminated && isRunning()) child.kill("SIGKILL");
  }

  if (!outcome.ok) {
    throw new Error(`${editor.name} ${phase} acceptance failed:\n${outcome.error ?? "Unknown error"}`);
  }
}
