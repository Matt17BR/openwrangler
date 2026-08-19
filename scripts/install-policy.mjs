import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";

const INSTALL = "npm ci --ignore-scripts";
const PREFIXED_INSTALL = "npm ci --ignore-scripts --prefix release-source";
const SHIM_PATHS = Object.freeze({
  "@vscode/vsce-sign": "scripts/npm-shims/vsce-sign",
  fsevents: "scripts/npm-shims/fsevents",
  keytar: "scripts/npm-shims/keytar"
});
const PLATFORM_SIGN_PACKAGES = Object.freeze([
  "@vscode/vsce-sign-alpine-arm64",
  "@vscode/vsce-sign-alpine-x64",
  "@vscode/vsce-sign-darwin-arm64",
  "@vscode/vsce-sign-darwin-x64",
  "@vscode/vsce-sign-linux-arm",
  "@vscode/vsce-sign-linux-arm64",
  "@vscode/vsce-sign-linux-x64",
  "@vscode/vsce-sign-win32-arm64",
  "@vscode/vsce-sign-win32-x64"
]);

export const WORKFLOW_INSTALL_OWNERS = Object.freeze([
  [".github/workflows/candidate-acceptance.yml", "platform", [INSTALL]],
  [".github/workflows/candidate-acceptance.yml", "r_platform", [INSTALL]],
  [".github/workflows/candidate-acceptance.yml", "linux", [INSTALL]],
  [".github/workflows/candidate-acceptance.yml", "performance", [INSTALL]],
  [".github/workflows/candidate-acceptance.yml", "jupyter", [INSTALL]],
  [".github/workflows/candidate-acceptance.yml", "r_local", [INSTALL]],
  [".github/workflows/ci.yml", "invariant-core", [INSTALL]],
  [".github/workflows/ci.yml", "r-contract-kernel", [INSTALL]],
  [".github/workflows/ci.yml", "r-contract-protocol", [INSTALL]],
  [".github/workflows/ci.yml", "canonical-editor", [INSTALL]],
  [".github/workflows/ci.yml", "visual-accessibility", [INSTALL]],
  [".github/workflows/ci.yml", "windows-unique", [INSTALL]],
  [".github/workflows/cross-platform.yml", "runtime", [INSTALL]],
  [".github/workflows/cross-platform.yml", "r-4-4-scheduled-qualification", [INSTALL]],
  [".github/workflows/daily-preview.yml", "build", [INSTALL]],
  [".github/workflows/daily-preview.yml", "representative-editor", [INSTALL]],
  [".github/workflows/open-vsx-promotion.yml", "promote", [INSTALL, PREFIXED_INSTALL]],
  [".github/workflows/release-candidate.yml", "package", [INSTALL]],
  [".github/workflows/release-candidate.yml", "remote-ssh", [INSTALL]],
  [".github/workflows/release-candidate.yml", "qualify", [INSTALL]],
  [".github/workflows/released-jupyter.yml", "vscode", [INSTALL]],
  [".github/workflows/released-jupyter.yml", "macos-r", [INSTALL]],
  [".github/workflows/released-jupyter.yml", "windows-r", [INSTALL]],
  [".github/workflows/stable-release.yml", "select", [INSTALL]],
  [".github/workflows/stable-release.yml", "promote", [INSTALL]]
]);

export const AZURE_INSTALL_OWNERS = Object.freeze([
  ["azure-pipelines-marketplace.yml", "Promote", "Marketplace", [INSTALL, PREFIXED_INSTALL]]
]);
export const WORKFLOW_PATHS = Object.freeze([
  ".github/workflows/candidate-acceptance.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/cross-platform.yml",
  ".github/workflows/daily-preview.yml",
  ".github/workflows/open-vsx-promotion.yml",
  ".github/workflows/performance.yml",
  ".github/workflows/release-candidate.yml",
  ".github/workflows/released-jupyter.yml",
  ".github/workflows/stable-release.yml"
]);
const AZURE_PIPELINE_PATHS = Object.freeze(AZURE_INSTALL_OWNERS.map(([path]) => path));
const NPM_COMMAND = /\bnpm(?:\.cmd)?(?=\s|$|[%}"'])[^\n;&|]*/giu;
const NPM_COMMANDS = new Set([
  "access",
  "adduser",
  "audit",
  "bugs",
  "cache",
  "ci",
  "completion",
  "config",
  "dedupe",
  "deprecate",
  "diff",
  "dist-tag",
  "docs",
  "doctor",
  "edit",
  "exec",
  "explain",
  "explore",
  "find-dupes",
  "fund",
  "get",
  "help",
  "help-search",
  "hook",
  "init",
  "install",
  "install-ci-test",
  "install-test",
  "link",
  "ll",
  "login",
  "logout",
  "ls",
  "org",
  "outdated",
  "owner",
  "pack",
  "ping",
  "pkg",
  "prefix",
  "profile",
  "prune",
  "publish",
  "query",
  "rebuild",
  "repo",
  "restart",
  "root",
  "run-script",
  "sbom",
  "search",
  "set",
  "shrinkwrap",
  "star",
  "stars",
  "start",
  "stop",
  "team",
  "test",
  "token",
  "uninstall",
  "unpublish",
  "unstar",
  "update",
  "version",
  "view",
  "whoami"
]);
const NPM_ALIASES = Object.freeze({
  add: "install",
  "add-user": "adduser",
  author: "owner",
  c: "config",
  "clean-install": "ci",
  "clean-install-test": "install-ci-test",
  cit: "install-ci-test",
  create: "init",
  ddp: "dedupe",
  "dist-tags": "dist-tag",
  find: "search",
  hlep: "help",
  home: "docs",
  i: "install",
  ic: "ci",
  in: "install",
  info: "view",
  innit: "init",
  ins: "install",
  inst: "install",
  insta: "install",
  instal: "install",
  "install-clean": "ci",
  isnt: "install",
  isnta: "install",
  isntal: "install",
  isntall: "install",
  "isntall-clean": "ci",
  issues: "bugs",
  it: "install-test",
  la: "ll",
  list: "ls",
  ln: "link",
  ogr: "org",
  r: "uninstall",
  rb: "rebuild",
  remove: "uninstall",
  rm: "uninstall",
  rum: "run-script",
  run: "run-script",
  s: "search",
  se: "search",
  show: "view",
  sit: "install-ci-test",
  t: "test",
  tst: "test",
  udpate: "update",
  un: "uninstall",
  unlink: "uninstall",
  up: "update",
  upgrade: "update",
  urn: "run-script",
  v: "view",
  verison: "version",
  why: "explain",
  x: "exec"
});
const NPM_LIFECYCLE_COMMANDS = new Set(["ci", "install", "install-ci-test", "install-test", "rebuild"]);
const SCRIPT_CONTROL_COMMANDS = new Set(["c", "config"]);
const DIRECT_SCRIPT_CONTROL_COMMANDS = new Set(["set"]);
const SCRIPT_CONTROL_ACTIONS = new Set(["delete", "edit", "remove", "rm", "set", "unset"]);
const BYPASS_COMMAND =
  /(?:\bnpx\s+npm|\bcommand\s+npm|\bpnpm|\byarn|\bbun|\$(?:\{[^}\n]*NPM[^}\n]*\}|[A-Z_]*NPM[A-Z_]*))(?:(?![\n;&|]).)*\s(?:add|ci|cit|clean-install|clean-install-test|i|ic|in|ins|inst|insta|instal|install|install-ci-test|install-clean|install-test|isnt|isnta|isntal|isntall|isntall-clean|it|rb|rebuild|sit)(?=\s|$)/iu;
const ALTERNATE_PACKAGE_MANAGER = /\b(?:bun|pnpm|yarn|yarnpkg)\b/iu;
const WEAKENED_SCRIPT_CONTROL =
  /(?:--ignore-scripts(?:=|\s+)false\b|\bignore-scripts\s*=\s*false\b|\bnpm_config_ignore_scripts\b|--foreground-scripts\b)/iu;

function defaultReadText(path) {
  return readFileSync(path, "utf8");
}

function defaultListWorkflowPaths() {
  return readdirSync(".github/workflows", { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => ".github/workflows/" + entry.name)
    .sort();
}

function defaultListAzurePipelinePaths() {
  return readdirSync(".", { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^azure-pipelines.*\.ya?ml$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function normalizeCommand(command) {
  return command.trim().replace(/\s+/gu, " ");
}

function normalizeShellContinuations(source) {
  return source.replace(/[\\`^]\r?\n/gu, " ");
}

function hasBypassCommand(source) {
  const normalized = normalizeShellContinuations(source);
  return BYPASS_COMMAND.test(normalized) || ALTERNATE_PACKAGE_MANAGER.test(normalized);
}

function shellTokens(command) {
  return (command.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/gu) ?? []).map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function matchesCommandPrefix(token, commands) {
  const normalized = token.toLowerCase();
  return [...commands].some((command) => command === normalized || command.startsWith(normalized));
}

function resolveNpmCommand(token) {
  let normalized = token.replace(/([A-Z])/gu, (match) => "-" + match.toLowerCase()).toLowerCase();
  if (NPM_COMMANDS.has(normalized)) return normalized;
  if (NPM_ALIASES[normalized] !== undefined) return NPM_ALIASES[normalized];
  const candidates = [...NPM_COMMANDS, ...Object.keys(NPM_ALIASES)].filter((command) => command.startsWith(normalized));
  if (candidates.length !== 1) return undefined;
  normalized = candidates[0];
  return NPM_ALIASES[normalized] ?? normalized;
}

function npmInvocation(match) {
  const tokens = shellTokens(match).slice(1);
  if (tokens.length === 0) return { command: undefined, hasLeadingOption: false };
  if (tokens[0].startsWith("-")) return { command: undefined, hasLeadingOption: true };
  return { command: resolveNpmCommand(tokens[0]), hasLeadingOption: false, tokens };
}

function lifecycleCommands(source) {
  return [...normalizeShellContinuations(source).matchAll(NPM_COMMAND)]
    .filter((match) => {
      const invocation = npmInvocation(match[0]);
      return invocation.hasLeadingOption || NPM_LIFECYCLE_COMMANDS.has(invocation.command);
    })
    .map((match) => normalizeCommand(match[0]));
}

function npmScriptControlMutations(source) {
  return [...normalizeShellContinuations(source).matchAll(NPM_COMMAND)]
    .filter((match) => {
      const invocation = npmInvocation(match[0]);
      if (!SCRIPT_CONTROL_COMMANDS.has(invocation.command) && !DIRECT_SCRIPT_CONTROL_COMMANDS.has(invocation.command)) {
        return false;
      }
      const tail = invocation.tokens.slice(1);
      return (
        (DIRECT_SCRIPT_CONTROL_COMMANDS.has(invocation.command) ||
          tail.some((token) => matchesCommandPrefix(token, SCRIPT_CONTROL_ACTIONS))) &&
        tail.some((token) => /^(?:ignore-scripts|foreground-scripts)(?:=|$)/u.test(token))
      );
    })
    .map((match) => normalizeCommand(match[0]));
}

function exactObject(actual, expected) {
  return (
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

function checkWorkflows(readText, listWorkflowPaths, problems) {
  const actualPaths = listWorkflowPaths();
  if (JSON.stringify(actualPaths) !== JSON.stringify(WORKFLOW_PATHS)) {
    problems.push("GitHub workflow inventory drifted: " + JSON.stringify(actualPaths) + ".");
  }
  const expectedByOwner = new Map(
    WORKFLOW_INSTALL_OWNERS.map(([path, job, commands]) => [path + "\0" + job, commands])
  );
  const observedOwners = new Set();

  for (const path of WORKFLOW_PATHS) {
    const source = readText(path);
    if (hasBypassCommand(source)) problems.push(path + " contains an npm lifecycle bypass alias.");
    if (WEAKENED_SCRIPT_CONTROL.test(source) || npmScriptControlMutations(source).length > 0) {
      problems.push(path + " weakens lifecycle-script suppression.");
    }
    const workflow = parseYaml(source);
    for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
      const commands = (job?.steps ?? []).flatMap((step) => {
        if (typeof step?.run !== "string") return [];
        if (hasBypassCommand(step.run)) {
          problems.push(path + " job " + jobName + " contains an npm lifecycle bypass alias.");
        }
        if (WEAKENED_SCRIPT_CONTROL.test(step.run) || npmScriptControlMutations(step.run).length > 0) {
          problems.push(path + " job " + jobName + " weakens lifecycle-script suppression.");
        }
        return lifecycleCommands(step.run);
      });
      if (commands.length === 0) continue;
      const key = path + "\0" + jobName;
      observedOwners.add(key);
      const expected = expectedByOwner.get(key);
      if (expected === undefined || JSON.stringify(commands) !== JSON.stringify(expected)) {
        problems.push(
          path + " job " + jobName + " has unreviewed npm lifecycle commands: " + JSON.stringify(commands) + "."
        );
      }
    }
  }

  for (const [key] of expectedByOwner) {
    if (!observedOwners.has(key)) {
      const [path, job] = key.split("\0");
      problems.push(path + " job " + job + " lost its explicit script-free lockfile install.");
    }
  }
}

function checkAzurePipelines(readText, listAzurePipelinePaths, problems) {
  const actualPaths = listAzurePipelinePaths();
  if (JSON.stringify(actualPaths) !== JSON.stringify(AZURE_PIPELINE_PATHS)) {
    problems.push("Azure pipeline inventory drifted: " + JSON.stringify(actualPaths) + ".");
  }
  for (const [path, expectedStage, expectedJob, expectedCommands] of AZURE_INSTALL_OWNERS) {
    const source = readText(path);
    if (hasBypassCommand(source)) problems.push(path + " contains an npm lifecycle bypass alias.");
    if (WEAKENED_SCRIPT_CONTROL.test(source) || npmScriptControlMutations(source).length > 0) {
      problems.push(path + " weakens lifecycle-script suppression.");
    }
    const pipeline = parseYaml(source);
    const observed = [];
    for (const stage of pipeline?.stages ?? []) {
      for (const job of stage?.jobs ?? []) {
        const steps = job?.steps ?? job?.strategy?.runOnce?.deploy?.steps ?? [];
        const commands = steps.flatMap((step) => {
          if (typeof step?.script !== "string") return [];
          if (hasBypassCommand(step.script)) {
            problems.push(path + " contains an npm lifecycle bypass alias in parsed Azure script.");
          }
          if (WEAKENED_SCRIPT_CONTROL.test(step.script) || npmScriptControlMutations(step.script).length > 0) {
            problems.push(path + " weakens lifecycle-script suppression in parsed Azure script.");
          }
          return lifecycleCommands(step.script);
        });
        if (commands.length > 0) observed.push([stage.stage, job.job ?? job.deployment, commands]);
      }
    }
    if (
      observed.length !== 1 ||
      observed[0][0] !== expectedStage ||
      observed[0][1] !== expectedJob ||
      JSON.stringify(observed[0][2]) !== JSON.stringify(expectedCommands)
    ) {
      problems.push(path + " has unreviewed Azure npm lifecycle owners: " + JSON.stringify(observed) + ".");
    }
  }
}

function checkManifestAndLock(readText, problems) {
  const manifest = JSON.parse(readText("package.json"));
  const lock = JSON.parse(readText("package-lock.json"));
  const packageScripts = manifest.scripts ?? {};
  for (const lifecycleName of ["preinstall", "install", "postinstall"]) {
    if (packageScripts[lifecycleName] !== undefined) {
      problems.push("package.json defines prohibited lifecycle script " + lifecycleName + ".");
    }
  }
  const scriptSource = Object.values(packageScripts).join("\n");
  if (lifecycleCommands(scriptSource).length > 0 || hasBypassCommand(scriptSource)) {
    problems.push("package.json scripts may not install, rebuild, or alias npm dependencies.");
  }
  if (WEAKENED_SCRIPT_CONTROL.test(scriptSource) || npmScriptControlMutations(scriptSource).length > 0) {
    problems.push("package.json scripts may not weaken lifecycle-script suppression.");
  }
  if (packageScripts["check:install-policy"] !== "node scripts/install-policy.mjs") {
    problems.push("package.json must expose the authoritative install policy checker.");
  }
  for (const owner of ["check", "check:invariants"]) {
    if (!packageScripts[owner]?.includes("npm run check:install-policy")) {
      problems.push(owner + " must execute the install policy checker.");
    }
  }
  if (packageScripts["prewatch:extension"] !== undefined) {
    problems.push("watch:extension must not rely on an implicit npm pre-hook while scripts are disabled.");
  }
  if (packageScripts["watch:extension"] !== "npm run build:extension && tsc -w -p tsconfig.extension.json") {
    problems.push("watch:extension must explicitly build the extension before watching.");
  }

  const expectedOverrides = {
    "@vscode/vsce-sign": "$@vscode/vsce-sign",
    fsevents: "$fsevents",
    keytar: "$keytar"
  };
  if (!exactObject(manifest.overrides, expectedOverrides)) {
    problems.push("package.json overrides must bind exactly the three reviewed local shims.");
  }
  if (manifest.devDependencies?.["@vscode/vsce-sign"] !== "file:" + SHIM_PATHS["@vscode/vsce-sign"]) {
    problems.push("package.json must bind the script-free VSCE signing bridge.");
  }
  for (const name of ["fsevents", "keytar"]) {
    if (manifest.devDependencies?.[name] !== "file:" + SHIM_PATHS[name]) {
      problems.push("package.json must bind the script-free " + name + " shim.");
    }
  }

  if (lock.lockfileVersion !== 3) problems.push("package-lock.json must remain lockfileVersion 3.");
  const lockPackages = lock.packages ?? {};
  const scriptedPackages = Object.entries(lockPackages)
    .filter(([, metadata]) => metadata?.hasInstallScript === true)
    .map(([path]) => path);
  if (scriptedPackages.length > 0) {
    problems.push("The install-script allowlist is empty; found " + scriptedPackages.join(", ") + ".");
  }
  if (lockPackages["node_modules/prebuild-install"] !== undefined) {
    problems.push("package-lock.json must not contain prebuild-install.");
  }

  for (const [name, path] of Object.entries(SHIM_PATHS)) {
    const lockEntry = lockPackages["node_modules/" + name];
    if (!exactObject(lockEntry, { resolved: path, link: true })) {
      problems.push("package-lock.json must resolve " + name + " only to " + path + ".");
    }
  }
  const lockRoot = lockPackages[""] ?? {};
  if (lockRoot.devDependencies?.["@vscode/vsce-sign"] !== "file:" + SHIM_PATHS["@vscode/vsce-sign"]) {
    problems.push("package-lock.json lost the direct VSCE signing bridge.");
  }
  for (const name of ["fsevents", "keytar"]) {
    if (lockRoot.devDependencies?.[name] !== "file:" + SHIM_PATHS[name]) {
      problems.push("package-lock.json lost the direct " + name + " shim.");
    }
  }

  const signManifest = JSON.parse(readText(SHIM_PATHS["@vscode/vsce-sign"] + "/package.json"));
  if (
    signManifest.name !== "@vscode/vsce-sign" ||
    signManifest.version !== "2.0.9-openwrangler.1" ||
    signManifest.main !== "index.cjs" ||
    signManifest.scripts !== undefined
  ) {
    problems.push("The VSCE signing bridge package metadata changed.");
  }
  if (
    !exactObject(
      signManifest.optionalDependencies,
      Object.fromEntries(PLATFORM_SIGN_PACKAGES.map((name) => [name, "2.0.6"]))
    )
  ) {
    problems.push("The VSCE signing bridge must retain all nine exact platform packages.");
  }
  for (const name of PLATFORM_SIGN_PACKAGES) {
    const entry = lockPackages["node_modules/" + name];
    if (
      entry?.version !== "2.0.6" ||
      entry?.optional !== true ||
      entry?.resolved !== "https://registry.npmjs.org/" + name + "/-/" + name.replace("@vscode/", "") + "-2.0.6.tgz" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry?.integrity ?? "")
    ) {
      problems.push("package-lock.json lost the authenticated optional package " + name + "@2.0.6.");
    }
  }

  for (const [name, version] of [
    ["keytar", "7.9.0-openwrangler.1"],
    ["fsevents", "2.3.3-openwrangler.1"]
  ]) {
    const shim = JSON.parse(readText(SHIM_PATHS[name] + "/package.json"));
    if (shim.name !== name || shim.version !== version || shim.main !== "index.cjs" || shim.scripts !== undefined) {
      problems.push("The " + name + " shim package metadata changed.");
    }
  }

  const signingSource = readText(SHIM_PATHS["@vscode/vsce-sign"] + "/index.cjs");
  if (
    !signingSource.includes("require.resolve") ||
    !signingSource.includes("@vscode/vsce-sign-") ||
    !signingSource.includes("/bin/") ||
    /\b(?:https?|fetch|download|npm|install|prebuild)\b/iu.test(signingSource)
  ) {
    problems.push("The VSCE signing bridge must resolve only an installed platform package.");
  }
  const keytarSource = readText(SHIM_PATHS.keytar + "/index.cjs");
  if (
    !keytarSource.includes("Native VSCE credential storage is disabled") ||
    !keytarSource.includes("throw new Error") ||
    /\b(?:child_process|https?|fetch|download|npm|install|prebuild)\b/iu.test(keytarSource)
  ) {
    problems.push("The credential shim must remain fail closed and network free.");
  }
  const fseventsSource = readText(SHIM_PATHS.fsevents + "/index.cjs");
  if (
    !fseventsSource.includes("portable watcher backend") ||
    /\b(?:child_process|https?|fetch|download|npm|install|prebuild|node-gyp)\b/iu.test(fseventsSource)
  ) {
    problems.push("The fsevents shim must select the portable watcher without native setup.");
  }
}

function checkRepositoryDefaults(readText, problems) {
  if (readText(".npmrc") !== "ignore-scripts=true\n") {
    problems.push(".npmrc must disable dependency lifecycle scripts by default.");
  }
  if (!readText(".vscodeignore").split(/\r?\n/gu).includes(".npmrc")) {
    problems.push(".npmrc must remain repository-only and excluded from the VSIX.");
  }
  for (const path of ["CONTRIBUTING.md", "docs/releasing.md", "scripts/release-documents.mjs"]) {
    const source = readText(path);
    if (!source.includes(INSTALL) || /npm ci(?! --ignore-scripts)/u.test(source)) {
      problems.push(path + " must document only the explicit script-free install.");
    }
  }
}

export function inspectInstallPolicy({
  readText = defaultReadText,
  listWorkflowPaths = defaultListWorkflowPaths,
  listAzurePipelinePaths = defaultListAzurePipelinePaths
} = {}) {
  const problems = [];
  try {
    checkRepositoryDefaults(readText, problems);
    checkManifestAndLock(readText, problems);
    checkWorkflows(readText, listWorkflowPaths, problems);
    checkAzurePipelines(readText, listAzurePipelinePaths, problems);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

export function installPolicyInventory() {
  const allOwners = [...WORKFLOW_INSTALL_OWNERS, ...AZURE_INSTALL_OWNERS];
  return Object.freeze({
    installInvocations: allOwners.reduce((total, owner) => total + owner.at(-1).length, 0),
    owners: allOwners.length,
    platformPackages: PLATFORM_SIGN_PACKAGES.length,
    workflowFiles: WORKFLOW_PATHS.length + AZURE_INSTALL_OWNERS.length
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = inspectInstallPolicy();
  if (problems.length > 0) {
    for (const problem of problems) console.error("[install-policy] " + problem);
    process.exitCode = 1;
  } else {
    const inventory = installPolicyInventory();
    console.log(
      "[install-policy] " +
        inventory.installInvocations +
        " script-free installs across " +
        inventory.owners +
        " owners in " +
        inventory.workflowFiles +
        " automation files; " +
        inventory.platformPackages +
        " VSCE signing platform packages authenticated."
    );
  }
}
