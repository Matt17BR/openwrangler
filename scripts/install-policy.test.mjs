import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import {
  AZURE_INSTALL_OWNERS,
  COMPATIBILITY_INSTALL,
  WORKFLOW_PATHS,
  WORKFLOW_INSTALL_OWNERS,
  inspectInstallPolicy,
  installPolicyInventory,
  tokenizeShellCommand
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

function inspect(overrides = new Map(), options = {}) {
  return inspectInstallPolicy({
    readText(path) {
      return overrides.get(path) ?? baseline.get(path) ?? readFileSync(path, "utf8");
    },
    ...options
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
    installInvocations: 29,
    owners: 26,
    platformPackages: 9,
    workflowFiles: 11
  });
  assert.deepEqual(
    WORKFLOW_INSTALL_OWNERS.find(([path, job]) => path === ".github/workflows/ci.yml" && job === "invariant-core")?.at(
      -1
    ),
    ["npm ci --ignore-scripts", COMPATIBILITY_INSTALL]
  );
});

test("shell command tokenization preserves quoted and unmatched boundaries", () => {
  assert.deepEqual(tokenizeShellCommand(`npm exec "a b" 'c d' plain`), ["npm", "exec", "a b", "c d", "plain"]);
  assert.deepEqual(tokenizeShellCommand(`"a\\"b"tail`), [`a\\"b`, "tail"]);
  assert.deepEqual(tokenizeShellCommand(`'' ""`), ["", ""]);

  const unterminatedDoubleQuote = '"' + "\\!".repeat(30);
  assert.deepEqual(tokenizeShellCommand(unterminatedDoubleQuote), [unterminatedDoubleQuote]);
  assert.deepEqual(tokenizeShellCommand("'unterminated value"), ["'unterminated", "value"]);
});

test("shell command tokenization remains bounded on a long adversarial quote", () => {
  const moduleUrl = pathToFileURL("scripts/install-policy.mjs").href;
  const program = `
    import { tokenizeShellCommand } from ${JSON.stringify(moduleUrl)};
    const input = '"' + "\\\\!".repeat(250_000);
    const tokens = tokenizeShellCommand(input);
    if (tokens.length !== 1 || tokens[0] !== input) process.exit(2);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    timeout: 2_000
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
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
  rejected(
    mutate("package-lock.json", (source) => {
      const lock = JSON.parse(source);
      lock.packages["node_modules/playwright-core"].bin["playwright-core"] = "dynamic-loader.js";
      return JSON.stringify(lock, null, 2) + "\n";
    }),
    /reviewed npx executable playwright-core/u
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
      source.replace(
        '"watch:extension": "npm run build:extension && tsc -w -p tsconfig.extension.json"',
        '"prewatch:extension": "npm run build:extension",\n    "watch:extension": "tsc -w -p tsconfig.extension.json"'
      )
    ),
    /implicit npm pre-hook/u
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

test("workflow and Azure inventories reject newly unowned automation files", () => {
  assert.match(
    inspect(new Map(), {
      listWorkflowPaths: () => [...WORKFLOW_PATHS, ".github/workflows/unowned.yml"].sort()
    }).join("\n"),
    /GitHub workflow inventory drifted/u
  );
  assert.match(
    inspect(new Map(), {
      listAzurePipelinePaths: () => ["azure-pipelines-marketplace.yml", "azure-pipelines-unowned.yml"]
    }).join("\n"),
    /Azure pipeline inventory drifted/u
  );
});

test("workflow owners reject npm option forms, aliases, and config weakening", () => {
  for (const command of [
    "npm --prefix release-source install",
    "npm --silent i",
    "npm add keytar",
    "npm clean-install",
    "npm install-ci-test",
    "npm cit",
    "npm clean-install-test",
    "npm sit",
    "npm install-test",
    "npm it",
    "npm rb keytar",
    "command npm --prefix release-source install"
  ]) {
    rejected(
      mutate(".github/workflows/ci.yml", (source) =>
        source.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts\n          " + command)
      ),
      /(?:unreviewed npm lifecycle commands|bypass alias)/u
    );
  }
  for (const command of [
    "npm exec --yes --package=@scope/unreviewed tool",
    "npm x --yes --package=@scope/unreviewed tool",
    "npm init @scope/unreviewed",
    "npm create @scope/unreviewed",
    "npm update",
    "npm audit fix",
    "npm uninstall keytar",
    "npm link keytar",
    "npm dedupe",
    "npm prune",
    "npx --yes @scope/unreviewed",
    "npx @scope/unreviewed",
    "npx --no-install @scope/unreviewed"
  ]) {
    rejected(
      mutate(".github/workflows/ci.yml", (source) =>
        source.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts\n          " + command)
      ),
      /(?:unreviewed npm lifecycle commands|bypass alias)/u
    );
  }
  for (const command of [
    "$SAFE_NPM exec --yes --package=@scope/unreviewed tool",
    "$SAFE_NPM x --yes --package=@scope/unreviewed tool",
    "$SAFE_NPX --yes @scope/unreviewed"
  ]) {
    rejected(
      mutate(".github/workflows/ci.yml", (source) =>
        source.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts\n          " + command)
      ),
      /bypass alias/u
    );
  }
  for (const command of [
    "n\\pm install keytar",
    "n'p'm install keytar",
    "n$''pm install keytar",
    "n$'p'x --yes @scope/unreviewed",
    "/usr/bin/n\\pm install keytar",
    '"$(command -v n\\pm)" install keytar'
  ]) {
    const workflow = parseYaml(baseline.get(".github/workflows/ci.yml"));
    workflow.jobs["invariant-core"].steps.push({ run: command });
    rejected(
      new Map([[".github/workflows/ci.yml", dumpYaml(workflow)]]),
      /(?:unreviewed npm lifecycle commands|bypass alias)/u
    );
  }
  for (const [shell, command] of [
    [undefined, "y\\arn install"],
    [undefined, "/usr/bin/pn\\pm install"],
    [undefined, "corepack y\\arn install"],
    [undefined, "pnpx @scope/unreviewed"],
    [undefined, "bunx @scope/unreviewed"],
    [undefined, "pn\\px @scope/unreviewed"],
    [undefined, "bu\\nx @scope/unreviewed"],
    [undefined, "$SAFE_YARN install"],
    [undefined, "$SAFE_PNPM install"],
    [undefined, "$SAFE_PNPX @scope/unreviewed"],
    [undefined, "$SAFE_NPM2 exec --yes --package=@scope/unreviewed tool"],
    [undefined, "$(SAFE_NPM) exec --yes --package=@scope/unreviewed tool"],
    [undefined, "$(SAFE_NPX) --yes @scope/unreviewed"],
    [undefined, "$(SAFE_PNPM2) install"],
    [undefined, "$(SAFE_NPM.V2) exec --yes --package=@scope/unreviewed tool"],
    [undefined, "$'\\x6e\\x70\\x6d' install keytar"],
    [undefined, "$'\\156\\160\\155' exec --yes --package=@scope/unreviewed tool"],
    ["pwsh", "& $env:SAFE_NPM exec --yes --package=@scope/unreviewed tool"],
    ["pwsh", "& $env:SAFE_NPX --yes @scope/unreviewed"],
    ["pwsh", "& $env:SAFE_NPX2 --yes @scope/unreviewed"],
    ["pwsh", "& ('n'+'pm') install keytar"],
    ["pwsh", "& ('n'+'px') --yes @scope/unreviewed"],
    ["pwsh", "& $('n'+'pm') install keytar"],
    ["pwsh", "& $('n'+'px') --yes @scope/unreviewed"],
    ["pwsh", "ya`rn install"],
    ["pwsh", "bu`n.exe install"],
    ["cmd", "ya^rn install"],
    ["cmd", "bu^n.exe install"],
    ["cmd", "pn^pm.exe install"],
    ["cmd", "n^pm.exe install keytar"],
    ["cmd", "%SAFE_BUNX2% @scope/unreviewed"]
  ]) {
    const workflow = parseYaml(baseline.get(".github/workflows/ci.yml"));
    workflow.jobs["windows-unique"].steps.push({ ...(shell === undefined ? {} : { shell }), run: command });
    rejected(
      new Map([[".github/workflows/ci.yml", dumpYaml(workflow)]]),
      /(?:unreviewed npm lifecycle commands|bypass alias)/u
    );
  }
  {
    const workflow = parseYaml(baseline.get(".github/workflows/ci.yml"));
    workflow.jobs["windows-unique"].steps.push({ run: "np`m install keytar" });
    workflow.jobs["windows-unique"].steps.push({ shell: "cmd", run: "np^m install keytar" });
    rejected(new Map([[".github/workflows/ci.yml", dumpYaml(workflow)]]), /unreviewed npm lifecycle commands/u);
  }
  for (const command of ["yarn", "yarn --frozen-lockfile", "pnpm install", "bun install"]) {
    rejected(
      mutate(".github/workflows/ci.yml", (source) =>
        source.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts\n          " + command)
      ),
      /bypass alias/u
    );
  }
  for (const command of [
    "npm config set ignore-scripts false",
    "npm c set ignore-scripts false",
    "npm set ignore-scripts false",
    "npm --silent config set ignore-scripts=false",
    "npm config delete ignore-scripts",
    "npm conf delete ignore-scripts --location=project",
    "npm config del ignore-scripts --location=project"
  ]) {
    rejected(
      mutate(".github/workflows/ci.yml", (source) =>
        source.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts\n          " + command)
      ),
      /weakens lifecycle-script suppression/u
    );
  }
  rejected(
    mutate(".github/workflows/ci.yml", (source) =>
      source.replace(
        "npm ci --ignore-scripts",
        "npm ci --ignore-scripts\n          npm conf delete ignore-scripts --location=project\n          npm install-cl"
      )
    ),
    /(?:weakens lifecycle-script suppression|unreviewed npm lifecycle commands)/u
  );
  for (const command of [
    '"$(command -v npm)" conf delete ignore-scripts --location=project\n' + '"$(command -v npm)" install-cl',
    '"`command -v npm`" conf delete ignore-scripts --location=project\n' + '"`command -v npm`" install-cl'
  ]) {
    rejected(
      mutate(".github/workflows/ci.yml", (source) =>
        source.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts\n          " + command)
      ),
      /(?:weakens lifecycle-script suppression|unreviewed npm lifecycle commands)/u
    );
  }
  for (const command of [
    "& (Get-Command npm) conf delete ignore-scripts --location=project\n" + "& (Get-Command npm) install-cl",
    "npm.ps1 conf delete ignore-scripts --location=project\n" + "npm.ps1 install-cl"
  ]) {
    const workflow = parseYaml(baseline.get(".github/workflows/ci.yml"));
    workflow.jobs["windows-unique"].steps.push({ run: command });
    rejected(
      new Map([[".github/workflows/ci.yml", dumpYaml(workflow)]]),
      /(?:weakens lifecycle-script suppression|unreviewed npm lifecycle commands)/u
    );
  }
  rejected(
    mutate(".github/workflows/ci.yml", (source) =>
      source.replace(
        "npm ci --ignore-scripts",
        "npm ci --ignore-scripts\n          npm \\\n            c delete ignore-scripts --location=project\n          npm \\\n            install-ci-test"
      )
    ),
    /(?:weakens lifecycle-script suppression|unreviewed npm lifecycle commands)/u
  );
  rejected(
    mutate(".github/workflows/ci.yml", (source) =>
      source.replace(
        "    steps:\n",
        "    steps:\n" +
          "      - run: >\n" +
          "          npm c set --location=project\n" +
          "          ignore-scripts false\n" +
          "      - run: >\n" +
          "          npm\n" +
          "          install-ci-test\n"
      )
    ),
    /(?:weakens lifecycle-script suppression|unreviewed npm lifecycle commands)/u
  );
  rejected(
    mutate(".github/workflows/ci.yml", (source) =>
      source.replace("    steps:\n", "    steps:\n      - run: >\n          yarn\n          install\n")
    ),
    /bypass alias/u
  );
  {
    const workflow = parseYaml(baseline.get(".github/workflows/ci.yml"));
    workflow.jobs["windows-unique"].steps.push({
      run: "npm `\r\n c delete ignore-scripts --location=project\r\n" + "npm `\r\n install-test keytar"
    });
    rejected(
      new Map([[".github/workflows/ci.yml", dumpYaml(workflow)]]),
      /(?:weakens lifecycle-script suppression|unreviewed npm lifecycle commands)/u
    );
  }
  {
    const workflow = parseYaml(baseline.get(".github/workflows/ci.yml"));
    workflow.jobs["windows-unique"].steps.push({
      shell: "cmd",
      run: "npm ^\r\n c delete ignore-scripts --location=project\r\n" + "npm ^\r\n install-test keytar"
    });
    rejected(
      new Map([[".github/workflows/ci.yml", dumpYaml(workflow)]]),
      /(?:weakens lifecycle-script suppression|unreviewed npm lifecycle commands)/u
    );
  }
  for (const command of [
    "NPM c delete ignore-scripts --location=project\nNPM install-test keytar",
    "%NPM% c delete ignore-scripts --location=project\n%NPM% install-test keytar",
    "$env:NPM c delete ignore-scripts --location=project\n$env:NPM install-test keytar"
  ]) {
    const workflow = parseYaml(baseline.get(".github/workflows/ci.yml"));
    workflow.jobs["windows-unique"].steps.push({ run: command });
    rejected(
      new Map([[".github/workflows/ci.yml", dumpYaml(workflow)]]),
      /(?:weakens lifecycle-script suppression|unreviewed npm lifecycle commands)/u
    );
  }
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
