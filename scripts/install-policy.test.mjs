import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import {
  AZURE_INSTALL_OWNERS,
  WORKFLOW_INSTALL_OWNERS,
  inspectInstallPolicy,
  installPolicyInventory
} from "./install-policy.mjs";

const relevantPaths = new Set([
  ".npmrc",
  ".vscodeignore",
  "azure-pipelines-marketplace.yml",
  "CONTRIBUTING.md",
  "docs/releasing.md",
  "package-lock.json",
  "package.json",
  "scripts/release-documents.mjs",
  "scripts/npm-shims/fsevents/index.cjs",
  "scripts/npm-shims/fsevents/package.json",
  "scripts/npm-shims/keytar/index.cjs",
  "scripts/npm-shims/keytar/package.json",
  "scripts/npm-shims/vsce-sign/index.cjs",
  "scripts/npm-shims/vsce-sign/package.json",
  ...WORKFLOW_INSTALL_OWNERS.map(([path]) => path)
]);
const baseline = new Map([...relevantPaths].map((path) => [path, readFileSync(path, "utf8")]));

function inspect(overrides = new Map()) {
  return inspectInstallPolicy({
    readText(path) {
      return overrides.get(path) ?? baseline.get(path) ?? readFileSync(path, "utf8");
    }
  });
}

function mutate(path, transform) {
  return new Map([[path, transform(baseline.get(path))]]);
}

function rejected(overrides, pattern) {
  const problems = inspect(overrides);
  assert.ok(problems.length > 0);
  assert.match(problems.join("\n"), pattern);
}

test("install policy owns every script-free lockfile install and exact shim", () => {
  assert.deepEqual(inspect(), []);
  assert.deepEqual(installPolicyInventory(), {
    installInvocations: 28,
    owners: 26,
    platformPackages: 9,
    workflowFiles: 11
  });
});

test("install policy rejects every lifecycle-script lock entry and native downloader", () => {
  rejected(
    mutate("package-lock.json", (source) => {
      const lock = JSON.parse(source);
      lock.packages["node_modules/@vscode/vsce-sign-linux-x64"].hasInstallScript = true;
      return JSON.stringify(lock, null, 2) + "\n";
    }),
    /allowlist is empty/u
  );
  rejected(
    mutate("package-lock.json", (source) => {
      const lock = JSON.parse(source);
      lock.packages["node_modules/prebuild-install"] = {
        version: "7.1.3",
        resolved: "https://registry.npmjs.org/prebuild-install/-/prebuild-install-7.1.3.tgz"
      };
      return JSON.stringify(lock, null, 2) + "\n";
    }),
    /must not contain prebuild-install/u
  );
  rejected(
    mutate("package-lock.json", (source) =>
      source.replace(
        '"resolved": "scripts/npm-shims/keytar"',
        '"resolved": "https://registry.npmjs.org/keytar/-/keytar-7.9.0.tgz"'
      )
    ),
    /resolve keytar only/u
  );
});

test("install policy rejects default, manifest, override, and shim weakening", () => {
  rejected(new Map([[".npmrc", "ignore-scripts=false\n"]]), /disable dependency lifecycle scripts/u);
  rejected(
    mutate(".vscodeignore", (source) => source.replace(".npmrc\n", "")),
    /excluded from the VSIX/u
  );
  rejected(
    mutate("package.json", (source) =>
      source.replace('"clean": "node scripts/clean.mjs"', '"preinstall": "node setup.mjs"')
    ),
    /prohibited lifecycle script/u
  );
  rejected(
    mutate("package.json", (source) =>
      source.replace('"clean": "node scripts/clean.mjs"', '"clean": "npm rebuild keytar"')
    ),
    /may not install, rebuild/u
  );
  rejected(
    mutate(
      "scripts/npm-shims/vsce-sign/index.cjs",
      (source) => source + '\nfetch("https://registry.npmjs.org/dynamic");\n'
    ),
    /installed platform package/u
  );
  rejected(
    mutate("scripts/npm-shims/keytar/index.cjs", (source) => source.replace("throw new Error", "return new Error")),
    /credential shim/u
  );
  rejected(
    mutate("scripts/npm-shims/fsevents/package.json", (source) =>
      source.replace('"main": "index.cjs"', '"main": "index.cjs", "scripts": {"install": "node-gyp rebuild"}')
    ),
    /fsevents shim package metadata/u
  );
});

test("every workflow install owner rejects command and lifecycle-control drift", () => {
  for (const [path, jobName, expectedCommands] of WORKFLOW_INSTALL_OWNERS) {
    for (let commandIndex = 0; commandIndex < expectedCommands.length; commandIndex += 1) {
      const workflow = parseYaml(baseline.get(path));
      const steps = workflow.jobs[jobName].steps;
      for (const step of steps) {
        if (typeof step?.run !== "string" || !step.run.includes(expectedCommands[commandIndex])) continue;
        step.run = step.run.replace(expectedCommands[commandIndex], "npm ci");
        break;
      }
      rejected(new Map([[path, dumpYaml(workflow)]]), /unreviewed npm lifecycle commands/u);
    }
  }

  for (const [path, , , expectedCommands] of AZURE_INSTALL_OWNERS) {
    for (const command of expectedCommands) {
      rejected(
        mutate(path, (source) => source.replace(command, "npm ci")),
        /unreviewed Azure npm lifecycle owners/u
      );
    }
  }

  for (const command of [
    "npm ci --ignore-scripts=false",
    "npm install --ignore-scripts",
    "npm rebuild --ignore-scripts",
    "npx npm ci --ignore-scripts",
    "command npm ci --ignore-scripts",
    "$SAFE_NPM ci --ignore-scripts"
  ]) {
    rejected(
      mutate(".github/workflows/ci.yml", (source) => source.replace("npm ci --ignore-scripts", command)),
      /(?:unreviewed npm lifecycle commands|bypass alias|weakens lifecycle-script suppression)/u
    );
  }
});

test("VSCE signing bridge retains every authenticated platform package", () => {
  for (const packageName of [
    "@vscode/vsce-sign-alpine-arm64",
    "@vscode/vsce-sign-alpine-x64",
    "@vscode/vsce-sign-darwin-arm64",
    "@vscode/vsce-sign-darwin-x64",
    "@vscode/vsce-sign-linux-arm",
    "@vscode/vsce-sign-linux-arm64",
    "@vscode/vsce-sign-linux-x64",
    "@vscode/vsce-sign-win32-arm64",
    "@vscode/vsce-sign-win32-x64"
  ]) {
    rejected(
      mutate("package-lock.json", (source) => {
        const lock = JSON.parse(source);
        delete lock.packages["node_modules/" + packageName];
        return JSON.stringify(lock, null, 2) + "\n";
      }),
      /authenticated optional package/u
    );
  }
});
