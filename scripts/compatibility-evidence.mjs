import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import { parseStrictJson } from "./strict-json.mjs";

export const COMPATIBILITY_EVIDENCE_MAX_BYTES = 64 * 1024;
export const COMPATIBILITY_EVIDENCE_MAX_DIAGNOSTICS = 64;
export const COMPATIBILITY_EVIDENCE_MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_NODES = 256;
const MAX_DEPTH = 8;
const MAX_STRING_CHARACTERS = 512;
const MAX_STRING_BYTES = 2 * 1024;
const TIER_IDS = ["api-compatible", "smoke-tested", "focused-release-seam", "fully-qualified"];
const EDITOR_IDS = ["vscode", "cursor", "other-vscode-desktop-forks", "vscode-dev"];
const PLATFORM_LABELS = new Map([
  ["linux", "Linux"],
  ["macos", "macOS"],
  ["windows", "Windows"],
  ["distribution-specific", "Distribution-specific"],
  ["browser", "Browser"]
]);
const README_START = "<!-- open-wrangler-compatibility-evidence:start -->";
const README_END = "<!-- open-wrangler-compatibility-evidence:end -->";
const RELEASE_START = "<!-- open-wrangler-compatibility-tiers:start -->";
const RELEASE_END = "<!-- open-wrangler-compatibility-tiers:end -->";
const ARCHITECTURE_START = "<!-- open-wrangler-compatibility-owners:start -->";
const ARCHITECTURE_END = "<!-- open-wrangler-compatibility-owners:end -->";
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const MAX_WORKFLOW_JOBS = 64;
const MAX_WORKFLOW_STEPS = 128;
const MAX_ENVIRONMENT_MEMBERS = 64;
const MAX_WORKFLOW_NODES = 50_000;
const MAX_WORKFLOW_DEPTH = 64;
const MAX_WORKFLOW_MEMBERS = 512;
const EDITOR_VERSION_ENVIRONMENT_KEY = "VSCODE_TEST_VERSION";
const MOVING_EDITOR_VERSION = "stable";
const EXPECTED_EDITOR_OWNERS = new Map([
  [
    "vscode",
    [
      ".github/workflows/candidate-acceptance.yml#contract",
      ".github/workflows/candidate-acceptance.yml#platform",
      ".github/workflows/candidate-acceptance.yml#r_platform",
      ".github/workflows/candidate-acceptance.yml#linux",
      ".github/workflows/candidate-acceptance.yml#performance",
      ".github/workflows/candidate-acceptance.yml#jupyter",
      ".github/workflows/candidate-acceptance.yml#r_local",
      ".github/workflows/candidate-acceptance.yml#acceptance"
    ]
  ],
  ["cursor", [".github/workflows/candidate-acceptance.yml#linux"]],
  ["other-vscode-desktop-forks", [".github/workflows/ci.yml#canonical-editor"]],
  ["vscode-dev", []]
]);
const EXPECTED_VSCODE_EVIDENCE = Object.freeze({
  movingStableWorkflowOwners: [
    ".github/workflows/candidate-acceptance.yml#platform",
    ".github/workflows/candidate-acceptance.yml#r_platform",
    ".github/workflows/candidate-acceptance.yml#linux",
    ".github/workflows/candidate-acceptance.yml#jupyter",
    ".github/workflows/candidate-acceptance.yml#r_local"
  ],
  pinnedWorkflowOwners: [".github/workflows/candidate-acceptance.yml#performance"],
  fanInWorkflowOwners: [
    ".github/workflows/candidate-acceptance.yml#contract",
    ".github/workflows/candidate-acceptance.yml#acceptance"
  ]
});
const EXPECTED_EDITOR_FIELDS = new Map([
  [
    "vscode",
    {
      name: "VS Code",
      releaseVersion: "1.130.0",
      versionOwner: "scripts/remote-workspace-contract.mjs#PINNED_REMOTE_VSCODE_VERSION",
      platforms: ["linux", "macos", "windows"],
      tier: "fully-qualified",
      support: "Release-tested"
    }
  ],
  [
    "cursor",
    {
      name: "Cursor",
      releaseVersion: "3.13.10",
      versionOwner: "scripts/cursor-acquisition.mjs#PINNED_CURSOR_VERSION",
      platforms: ["linux"],
      tier: "focused-release-seam",
      support: "Release-tested"
    }
  ],
  [
    "other-vscode-desktop-forks",
    {
      name: "Other VS Code desktop forks",
      releaseVersion: null,
      versionOwner: "package.json#engines.vscode",
      platforms: ["distribution-specific"],
      tier: "api-compatible",
      support: "Experimental"
    }
  ],
  [
    "vscode-dev",
    {
      name: "Browser-hosted `vscode.dev`",
      releaseVersion: null,
      versionOwner: null,
      platforms: ["browser"],
      tier: null,
      support: "Unsupported"
    }
  ]
]);
const EXPECTED_FORK_SMOKE = Object.freeze({
  id: "antigravity-open-vsx-1.2.0-linux-x64",
  name: "Antigravity smoke",
  extensionVersion: "1.2.0",
  editorVersion: "1.107.0",
  editorCommit: "15487b3041e65228cae24980a3f796c905ef582c",
  platform: "linux-x64",
  architecture: "x64",
  registry: "Open VSX",
  installedExtension: "Matt17BR.openwrangler@1.2.0",
  activationCommand: "openWrangler.openFile",
  openedFormat: "semicolon CSV through native Polars",
  sourceImmutability: "source digest unchanged",
  cleanup: "zero sessions, runtime, and editor processes; archive and private roots removed",
  tier: "smoke-tested",
  support: "Experimental",
  evidenceOwner: "docs/testing.md#experimental-antigravity-smoke"
});
const EXPECTED_NATIVE_R_OWNERS = [
  ".github/workflows/candidate-acceptance.yml#r_platform",
  ".github/workflows/candidate-acceptance.yml#r_local"
];
const VISIBLE_PUBLIC_RECORDS = Object.freeze([
  {
    source: "testingSource",
    text: "Manual release-candidate qualification packages once and retains one canonical VSIX/checksum/provenance triple for 21\ndays. The reusable acceptance workflow consumes only its numeric artifact ID.",
    label: "docs/testing.md release ownership record"
  },
  {
    source: "testingSource",
    text: "Open Wrangler 1.2.0 passed one bounded, non-release-blocking Antigravity Linux x64 smoke",
    label: "canonical Antigravity smoke record"
  },
  {
    source: "testingSource",
    text: "The source digest was unchanged. Disposing the editor left zero Open Wrangler sessions, no running standalone\n  runtime, and no surviving editor process; the downloaded archive and private test roots were removed.",
    label: "canonical Antigravity smoke record"
  },
  {
    source: "testingSource",
    text: "The shipped product configuration selected Open VSX.",
    label: "canonical Antigravity smoke record"
  },
  {
    source: "testingSource",
    text: "The public `openWrangler.openFile` command activated the installed extension",
    label: "canonical Antigravity smoke record"
  },
  {
    source: "testingSource",
    text: "opened the exact schema through native Polars.",
    label: "canonical Antigravity smoke record"
  },
  {
    source: "testingSource",
    text: "the run acquires official VS Code 1.130.0 Linux x64",
    label: "canonical docs/testing.md pinned-editor record"
  },
  {
    source: "ciDocumentationSource",
    text: "native-R platform acceptance in a separate Ubuntu, macOS, and Windows matrix: R 4.4.3 on Ubuntu and R 4.5.2 on macOS and Windows, with fresh VS Code-only core, native-frame, and kernel-restart phases",
    label: "docs/ci.md installed Native R platform record"
  },
  {
    source: "ciDocumentationSource",
    text: "Cursor owns no Jupyter or R phase",
    label: "canonical docs/ci.md compatibility ownership record"
  },
  {
    source: "ciDocumentationSource",
    text: "protected pull-request CI owns the R 4.5 source contracts, while scheduled/manual Cross owns the R 4.4 source qualification",
    label: "docs/ci.md Native R source ownership record"
  },
  {
    source: "ciDocumentationSource",
    text: "Cursor performance remains historical evidence only",
    label: "canonical docs/ci.md compatibility ownership record"
  },
  {
    source: "ciDocumentationSource",
    text: "installed performance in pinned VS Code",
    label: "canonical docs/ci.md compatibility ownership record"
  },
  {
    source: "ciDocumentationSource",
    text: "one full generic packaged journey in Linux VS Code",
    label: "canonical docs/ci.md compatibility ownership record"
  },
  {
    source: "architectureSource",
    text: "Linux Cursor and the generic macOS/Windows VS Code cells run\nthe focused `platform-smoke` compatibility seam without rerunning extension-host suites or R setup.",
    label: "docs/architecture.md editor platform record"
  },
  {
    source: "architectureSource",
    text: "The candidate `r_platform` matrix runs installed-artifact VS Code journeys with R 4.4.3 on Ubuntu, R 4.5.2 on macOS, and R 4.5.2 on Windows.",
    label: "docs/architecture.md installed Native R matrix record"
  },
  {
    source: "architectureSource",
    text: "Scheduled/manual Cross owns the direct R 4.4 source qualification, while protected pull-request CI owns the direct R 4.5 source contracts.",
    label: "docs/architecture.md Native R source ownership record"
  },
  {
    source: "architectureSource",
    text: "Linux, macOS, and Windows run both selectors in VS Code; Cursor owns only its focused Linux `platform-smoke`.",
    label: "docs/architecture.md selector ownership record"
  }
]);
const PUBLIC_CONTRADICTIONS = Object.freeze([
  {
    pattern:
      /Cursor\s+(?:owns|runs|executes|qualifies)\s+(?!(?:no|only|one pinned)\b)[^.\n]{0,192}\b(?:Jupyter|Native R|R (?:phase|journey|coverage)|installed[- ]performance)\b/iu,
    label: "Cursor may not own Jupyter, Native R, or installed-performance evidence outside its focused Linux seam"
  },
  {
    pattern: /installed[- ]performance[^.\n]{0,128}\b(?:and|plus)\s+Cursor\b/iu,
    label: "installed performance must remain VS Code-only"
  },
  {
    pattern:
      /(?:protected pull-request CI|candidate acceptance)(?:\s+solely)?\s+owns(?:\s+the)?\s+(?:direct\s+)?R 4\.4\b/iu,
    label: "direct R 4.4 source qualification must remain owned by scheduled/manual Cross"
  },
  {
    pattern: /installed performance in moving stable VS Code/iu,
    label: "the exact installed-performance record may not be attributed to moving stable VS Code"
  }
]);
const PUBLIC_DOCUMENT_SOURCES = Object.freeze([
  "readmeSource",
  "releasingSource",
  "architectureSource",
  "featureParitySource",
  "testingSource",
  "ciDocumentationSource"
]);
const DIAGNOSTIC_LIMIT_MESSAGE = "Compatibility diagnostic retention limit reached.";

class BoundedDiagnostics {
  #messages = [];
  #bytes = 0;
  #saturated = false;

  get length() {
    return this.#messages.length;
  }

  push(...messages) {
    for (const message of messages) {
      if (this.#saturated) break;
      const text = String(message);
      const separatorBytes = this.#messages.length === 0 ? 0 : 1;
      const textBytes = Buffer.byteLength(text, "utf8");
      const retainedSentinelSeparatorBytes = 1;
      const directSentinelSeparatorBytes = this.#messages.length === 0 ? 0 : 1;
      const sentinelBytes = Buffer.byteLength(DIAGNOSTIC_LIMIT_MESSAGE, "utf8");
      const mustReserveSentinel =
        this.#messages.length >= COMPATIBILITY_EVIDENCE_MAX_DIAGNOSTICS - 1 ||
        this.#bytes + separatorBytes + textBytes + retainedSentinelSeparatorBytes + sentinelBytes >
          COMPATIBILITY_EVIDENCE_MAX_DIAGNOSTIC_BYTES;
      if (mustReserveSentinel) {
        if (
          this.#messages.length < COMPATIBILITY_EVIDENCE_MAX_DIAGNOSTICS &&
          this.#bytes + directSentinelSeparatorBytes + sentinelBytes <= COMPATIBILITY_EVIDENCE_MAX_DIAGNOSTIC_BYTES
        ) {
          this.#messages.push(DIAGNOSTIC_LIMIT_MESSAGE);
          this.#bytes += directSentinelSeparatorBytes + sentinelBytes;
        }
        this.#saturated = true;
        break;
      }
      this.#messages.push(text);
      this.#bytes += separatorBytes + textBytes;
    }
    return this.#messages.length;
  }

  toArray() {
    return [...this.#messages];
  }
}

function record(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function boundedValue(value, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) return false;
  if (typeof value === "string") {
    return [...value].length <= MAX_STRING_CHARACTERS && Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.length <= 16 && value.every((entry) => boundedValue(entry, depth + 1, state));
  }
  if (!record(value) || Object.keys(value).length > 16) return false;
  return Object.entries(value).every(
    ([key, entry]) => boundedValue(key, depth + 1, state) && boundedValue(entry, depth + 1, state)
  );
}

function oneCapture(source, pattern, label, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) {
    problems.push(`${label} must be bounded source text.`);
    return undefined;
  }
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0]?.groups?.value) {
    problems.push(`${label} must have one exact immutable source value.`);
    return undefined;
  }
  return matches[0].groups.value;
}

function boundedWorkflowDocument(root) {
  const pending = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop();
    nodes += 1;
    if (nodes > MAX_WORKFLOW_NODES || depth > MAX_WORKFLOW_DEPTH) return false;
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_WORKFLOW_BYTES) return false;
      continue;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") continue;
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_WORKFLOW_MEMBERS) return false;
      for (const entry of value) pending.push({ value: entry, depth: depth + 1 });
      continue;
    }
    if (!record(value)) return false;
    const entries = Object.entries(value);
    if (
      entries.length > MAX_WORKFLOW_MEMBERS ||
      entries.some(([key]) => ["__proto__", "constructor", "prototype"].includes(key))
    ) {
      return false;
    }
    for (const [key, entry] of entries) {
      pending.push({ value: key, depth: depth + 1 }, { value: entry, depth: depth + 1 });
    }
  }
  return true;
}

function parseWorkflowDocument(source, label, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
    problems.push(`${label} must be bounded workflow text.`);
    return undefined;
  }
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch {
    problems.push(`${label} must be valid semantic YAML without duplicate mapping keys.`);
    return undefined;
  }
  if (
    !boundedWorkflowDocument(workflow) ||
    !record(workflow) ||
    !record(workflow.jobs) ||
    Object.keys(workflow.jobs).length > MAX_WORKFLOW_JOBS
  ) {
    problems.push(`${label} must contain one bounded jobs mapping.`);
    return undefined;
  }
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(jobId) || !record(job)) {
      problems.push(`${label} contains an invalid job record.`);
      return undefined;
    }
    if (job.steps !== undefined && (!Array.isArray(job.steps) || job.steps.length > MAX_WORKFLOW_STEPS)) {
      problems.push(`${label} job ${jobId} has an invalid or unbounded step list.`);
      return undefined;
    }
    if (Array.isArray(job.steps) && job.steps.some((step) => !record(step))) {
      problems.push(`${label} job ${jobId} has an invalid step record.`);
      return undefined;
    }
  }
  return workflow;
}

function environmentValue(environment, label, problems) {
  if (environment === undefined) return { present: false, value: undefined };
  if (!record(environment) || Object.keys(environment).length > MAX_ENVIRONMENT_MEMBERS) {
    problems.push(`${label} must be a bounded environment mapping.`);
    return { present: true, value: undefined };
  }
  if (!Object.hasOwn(environment, EDITOR_VERSION_ENVIRONMENT_KEY)) {
    return { present: false, value: undefined };
  }
  const value = environment[EDITOR_VERSION_ENVIRONMENT_KEY];
  if (typeof value !== "string") {
    problems.push(`${label} must assign ${EDITOR_VERSION_ENVIRONMENT_KEY} one string value.`);
    return { present: true, value: undefined };
  }
  return { present: true, value };
}

function commandEditorVersionAssignments(command) {
  if (typeof command !== "string") return { values: [], unsupported: false };
  const assignment =
    /(?:^|[\s;&|])(?:export\s+|env\s+)?(?:VSCODE_TEST_VERSION|"VSCODE_TEST_VERSION"|'VSCODE_TEST_VERSION')\s*=\s*(?:"(?<double>[^"\n]*)"|'(?<single>[^'\n]*)'|(?<bare>[^\s;&|]+))/gmu;
  const matches = [...command.matchAll(assignment)];
  const values = matches.map((match) => match.groups.double ?? match.groups.single ?? match.groups.bare);
  return {
    values,
    unsupported: countOccurrences(command, EDITOR_VERSION_ENVIRONMENT_KEY) !== matches.length
  };
}

function compatibilityRunner(step) {
  return (
    typeof step?.run === "string" &&
    (step.run.includes("scripts/run-packaged-editor-tests.mjs") || step.run.includes("benchmark:installed"))
  );
}

function ownsRVersion(job, version) {
  return (
    Array.isArray(job?.steps) &&
    job.steps.some(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("r-lib/actions/setup-r@") &&
        step.with?.["r-version"] === version
    )
  );
}

function inspectEffectiveEditorVersions(workflow, movingStableJobs, problems) {
  if (!workflow) return;
  const workflowAssignment = environmentValue(workflow.env, "Candidate workflow environment", problems);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const jobAssignment = environmentValue(job.env, `Candidate lane ${jobId} environment`, problems);
    const runners = (job.steps ?? []).filter(compatibilityRunner);
    if (movingStableJobs.has(jobId) && runners.length === 0) {
      problems.push(`VS Code moving stable candidate lane ${jobId} must retain an exact editor runner.`);
      continue;
    }
    for (const [runnerIndex, step] of runners.entries()) {
      const label = `Candidate lane ${jobId} runner ${runnerIndex + 1}`;
      const stepAssignment = environmentValue(step.env, `${label} environment`, problems);
      const inheritedAssignment = stepAssignment.present
        ? stepAssignment
        : jobAssignment.present
          ? jobAssignment
          : workflowAssignment;
      const commandAssignments = commandEditorVersionAssignments(step.run);
      const effectiveValue = commandAssignments.values.at(-1) ?? inheritedAssignment.value;
      if (commandAssignments.unsupported) {
        problems.push(`${label} has an unsupported command-level editor-version reference.`);
      }
      if (movingStableJobs.has(jobId)) {
        if (
          effectiveValue !== MOVING_EDITOR_VERSION ||
          commandAssignments.values.some((value) => value !== MOVING_EDITOR_VERSION)
        ) {
          problems.push(
            `VS Code moving stable candidate lane ${jobId} must give every exact runner an effective editor version equal to stable.`
          );
        }
      } else if (inheritedAssignment.present || commandAssignments.values.length > 0) {
        problems.push(`Candidate lane ${jobId} has an unexpected effective editor-version assignment.`);
      }
    }
  }
}

function runnerSteps(job) {
  return Array.isArray(job?.steps) ? job.steps.filter(compatibilityRunner) : [];
}

function runnerEnvironment(step, expected) {
  return record(step?.env) && Object.entries(expected).every(([key, value]) => step.env[key] === value);
}

function orderedRunnerEnvironmentValues(job, key) {
  return runnerSteps(job).map((step) => step.env?.[key]);
}

function oneRunnerCommand(job, markers) {
  const runners = runnerSteps(job);
  return (
    runners.length === 1 &&
    typeof runners[0].run === "string" &&
    markers.every((marker) => runners[0].run.includes(marker))
  );
}

function inspectSemanticCandidateClaims(jobs, problems) {
  const platformRunners = runnerSteps(jobs.platform);
  if (
    !sameArray(jobs.platform?.strategy?.matrix?.include, [
      { os: "macos-latest", python: "3.12" },
      { os: "windows-latest", python: "3.14" }
    ]) ||
    platformRunners.length !== 1 ||
    !runnerEnvironment(platformRunners[0], {
      OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
      OPEN_WRANGLER_PACKAGED_MODE: "platform-smoke"
    })
  ) {
    problems.push("VS Code platform owner must retain its exact semantic matrix and runner environment.");
  }

  const linuxRunners = runnerSteps(jobs.linux);
  if (
    linuxRunners.length !== 2 ||
    !runnerEnvironment(linuxRunners[0], { OPEN_WRANGLER_PACKAGED_EDITORS: "vscode" }) ||
    !runnerEnvironment(linuxRunners[1], {
      OPEN_WRANGLER_PACKAGED_EDITORS: "cursor",
      OPEN_WRANGLER_PACKAGED_MODE: "platform-smoke"
    })
  ) {
    problems.push("Linux editor owner must retain one VS Code runner and one focused Cursor runner.");
  }

  if (
    jobs.performance?.name !== "Installed performance in pinned editors" ||
    !oneRunnerCommand(jobs.performance, [
      "/usr/bin/dbus-run-session -- npm run benchmark:installed --",
      "--pinned-editors",
      "--editors vscode",
      "--candidate-in canonical-release/openwrangler.vsix"
    ])
  ) {
    problems.push("VS Code installed-performance owner must retain its exact pinned-editor command.");
  }

  const jupyterRunners = runnerSteps(jobs.jupyter);
  if (
    !sameArray(jobs.jupyter?.strategy?.matrix?.phase, ["python", "r-remote"]) ||
    jupyterRunners.length !== 2 ||
    jupyterRunners.some(
      (step) =>
        !runnerEnvironment(step, {
          OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
          OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
          OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1"
        })
    ) ||
    jupyterRunners[0]?.env?.OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE !== "candidate-one-owner"
  ) {
    problems.push("VS Code released-Jupyter owner must retain its exact semantic phases and runner environments.");
  }

  const expectedNeeds = ["contract", "platform", "r_platform", "linux", "performance", "jupyter", "r_local"];
  const acceptanceStep = jobs.acceptance?.steps?.[0];
  const acceptanceResults = Object.freeze({
    CONTRACT_RESULT: "contract",
    PLATFORM_RESULT: "platform",
    R_PLATFORM_RESULT: "r_platform",
    LINUX_RESULT: "linux",
    PERFORMANCE_RESULT: "performance",
    JUPYTER_RESULT: "jupyter",
    R_LOCAL_RESULT: "r_local"
  });
  if (
    !sameArray(jobs.acceptance?.needs, expectedNeeds) ||
    jobs.acceptance?.steps?.length !== 1 ||
    !record(acceptanceStep?.env) ||
    Object.entries(acceptanceResults).some(
      ([key, job]) =>
        acceptanceStep.env[key] !== `\${{ needs.${job}.result }}` ||
        !acceptanceStep.run?.includes(`test "$${key}" = "success"`)
    )
  ) {
    problems.push("complete VS Code qualification fan-in must retain every exact semantic owner result.");
  }

  const expectedRPlatform = [
    { os: "ubuntu-24.04", python: "3.12", r: "4.4.3" },
    { os: "macos-latest", python: "3.12", r: "4.5.2" },
    { os: "windows-latest", python: "3.14", r: "4.5.2" }
  ];
  if (
    !sameArray(jobs.r_platform?.strategy?.matrix?.include, expectedRPlatform) ||
    !sameArray(orderedRunnerEnvironmentValues(jobs.r_platform, "OPEN_WRANGLER_PACKAGED_R_JOURNEY"), [
      "core-operations",
      "native-frames",
      "kernel-restart"
    ]) ||
    runnerSteps(jobs.r_platform).some((step) => !runnerEnvironment(step, { OPEN_WRANGLER_PACKAGED_EDITORS: "vscode" }))
  ) {
    problems.push("Native R platform owner must retain its exact matrix and ordered VS Code journeys.");
  }

  const expectedLocalJourneys = [
    "core-operations",
    "kernel-restart",
    "interactive-terminal",
    "literate-documents",
    "native-frames",
    "value-operations",
    "categorical-operations"
  ];
  if (
    !sameArray(jobs.r_local?.strategy?.matrix?.shard, ["lifecycle", "editing"]) ||
    !ownsRVersion(jobs.r_local, "4.5.2") ||
    !sameArray(
      orderedRunnerEnvironmentValues(jobs.r_local, "OPEN_WRANGLER_PACKAGED_R_JOURNEY"),
      expectedLocalJourneys
    ) ||
    runnerSteps(jobs.r_local).some((step) => !runnerEnvironment(step, { OPEN_WRANGLER_PACKAGED_EDITORS: "vscode" }))
  ) {
    problems.push("Native R Linux owner must retain its exact shards, R version, and ordered VS Code journeys.");
  }
}

function visibleMarkdown(source, label, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024) {
    problems.push(`${label} must be bounded documentation text.`);
    return "";
  }
  const visible = [];
  let cursor = 0;
  while (cursor < source.length) {
    const commentStart = source.indexOf("<!--", cursor);
    if (commentStart < 0) {
      visible.push(source.slice(cursor));
      break;
    }
    visible.push(source.slice(cursor, commentStart));
    const commentEnd = source.indexOf("-->", commentStart + 4);
    if (commentEnd < 0) {
      problems.push(`${label} contains an unterminated HTML comment.`);
      return visible.join("");
    }
    cursor = commentEnd + 3;
  }
  return visible.join("");
}

function countOccurrences(source, expected) {
  if (expected.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= source.length - expected.length) {
    const index = source.indexOf(expected, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + expected.length;
  }
  return count;
}

function normalizedVisibleRecord(source) {
  return source.trim().replace(/\s+/gu, " ");
}

function inspectVisiblePublicRecords(inputs, problems) {
  const visibleSources = new Map();
  for (const source of PUBLIC_DOCUMENT_SOURCES) {
    visibleSources.set(source, visibleMarkdown(inputs[source], source, problems));
  }
  for (const record of VISIBLE_PUBLIC_RECORDS) {
    if (
      countOccurrences(
        normalizedVisibleRecord(visibleSources.get(record.source)),
        normalizedVisibleRecord(record.text)
      ) !== 1
    ) {
      problems.push(`${record.label} must remain one exact visible compatibility record.`);
    }
  }
  for (const [source, visible] of visibleSources) {
    for (const contradiction of PUBLIC_CONTRADICTIONS) {
      if (contradiction.pattern.test(visible)) {
        problems.push(`${source}: ${contradiction.label}.`);
      }
    }
  }
}

function validateAuthority(authority, problems) {
  const initialProblemCount = problems.length;
  if (!boundedValue(authority)) {
    problems.push("Compatibility evidence exceeds its structural or text bounds.");
    return false;
  }
  if (
    !exactKeys(authority, ["schemaVersion", "tiers", "editors", "forkSmokes", "nativeR"]) ||
    authority.schemaVersion !== 3
  ) {
    problems.push("Compatibility evidence must contain only the versioned tier, editor, and Native R authority.");
    return false;
  }
  if (!Array.isArray(authority.tiers) || authority.tiers.length !== TIER_IDS.length) {
    problems.push("Compatibility evidence must contain the four ordered evidence tiers.");
    return false;
  }
  const tierIds = authority.tiers.map((entry) => entry?.id);
  if (!sameArray(tierIds, TIER_IDS) || new Set(tierIds).size !== tierIds.length) {
    problems.push("Compatibility evidence tiers must be known, unique, and ordered from API to full qualification.");
  }
  for (const entry of authority.tiers) {
    if (
      !exactKeys(entry, ["id", "label", "meaning"]) ||
      typeof entry.label !== "string" ||
      entry.label.length === 0 ||
      typeof entry.meaning !== "string" ||
      entry.meaning.length === 0
    ) {
      problems.push("Every compatibility tier must have one bounded label and meaning.");
    }
  }
  if (!Array.isArray(authority.editors) || authority.editors.length !== EDITOR_IDS.length) {
    problems.push("Compatibility evidence must contain the four ordered public editor rows.");
    return false;
  }
  const editorIds = authority.editors.map((entry) => entry?.id);
  if (!sameArray(editorIds, EDITOR_IDS) || new Set(editorIds).size !== editorIds.length) {
    problems.push("Compatibility editor entries must be known, unique, and ordered.");
  }
  for (const entry of authority.editors) {
    const editorKeys = [
      "id",
      "name",
      "apiVersion",
      "releaseVersion",
      "versionOwner",
      "platforms",
      "tier",
      "support",
      "workflowOwners"
    ];
    if (entry?.id === "vscode") {
      editorKeys.push("movingStableWorkflowOwners", "pinnedWorkflowOwners", "fanInWorkflowOwners");
    }
    if (
      !exactKeys(entry, editorKeys) ||
      typeof entry.name !== "string" ||
      !Array.isArray(entry.platforms) ||
      entry.platforms.length === 0 ||
      entry.platforms.some((platform) => !PLATFORM_LABELS.has(platform)) ||
      new Set(entry.platforms).size !== entry.platforms.length ||
      !Array.isArray(entry.workflowOwners) ||
      new Set(entry.workflowOwners).size !== entry.workflowOwners.length
    ) {
      problems.push(`Compatibility editor ${String(entry?.id)} is malformed or unbounded.`);
      continue;
    }
    if (!sameArray(entry.workflowOwners, EXPECTED_EDITOR_OWNERS.get(entry.id))) {
      problems.push(`Compatibility editor ${entry.id} workflow owners must be complete, unique, and ordered.`);
    }
    if (
      entry.id === "vscode" &&
      (!sameArray(entry.movingStableWorkflowOwners, EXPECTED_VSCODE_EVIDENCE.movingStableWorkflowOwners) ||
        !sameArray(entry.pinnedWorkflowOwners, EXPECTED_VSCODE_EVIDENCE.pinnedWorkflowOwners) ||
        !sameArray(entry.fanInWorkflowOwners, EXPECTED_VSCODE_EVIDENCE.fanInWorkflowOwners) ||
        new Set([...entry.movingStableWorkflowOwners, ...entry.pinnedWorkflowOwners, ...entry.fanInWorkflowOwners])
          .size !== entry.workflowOwners.length ||
        entry.workflowOwners.some(
          (owner) =>
            !entry.movingStableWorkflowOwners.includes(owner) &&
            !entry.pinnedWorkflowOwners.includes(owner) &&
            !entry.fanInWorkflowOwners.includes(owner)
        ))
    ) {
      problems.push("VS Code evidence lanes must distinguish moving stable, exact pinned, and fan-in owners.");
    }
    const expectedFields = EXPECTED_EDITOR_FIELDS.get(entry.id);
    if (
      !expectedFields ||
      entry.name !== expectedFields.name ||
      entry.releaseVersion !== expectedFields.releaseVersion ||
      entry.versionOwner !== expectedFields.versionOwner ||
      !sameArray(entry.platforms, expectedFields.platforms) ||
      entry.tier !== expectedFields.tier ||
      entry.support !== expectedFields.support
    ) {
      problems.push(
        `Compatibility editor ${entry.id} rendered version, platform, tier, or support fields are unpinned.`
      );
    }
    if (entry.support === "Unsupported") {
      if (
        entry.tier !== null ||
        entry.apiVersion !== null ||
        entry.releaseVersion !== null ||
        entry.workflowOwners.length !== 0
      ) {
        problems.push("An unsupported editor may not inherit a compatibility tier, version, or workflow owner.");
      }
    } else if (!TIER_IDS.includes(entry.tier) || entry.workflowOwners.length === 0) {
      problems.push(`Compatibility editor ${entry.id} must have a known tier and at least one workflow owner.`);
    }
  }
  if (
    !Array.isArray(authority.forkSmokes) ||
    authority.forkSmokes.length !== 1 ||
    !exactKeys(authority.forkSmokes[0], Object.keys(EXPECTED_FORK_SMOKE)) ||
    !sameArray(Object.entries(authority.forkSmokes[0]), Object.entries(EXPECTED_FORK_SMOKE))
  ) {
    problems.push("The Antigravity 1.2.0 Linux x64 smoke must remain one exact separate historical record.");
  }
  const nativeR = authority.nativeR;
  if (
    !exactKeys(nativeR, ["name", "status", "tier", "versions", "workflowOwners", "promotionIssue"]) ||
    nativeR.name !== "Native R preview" ||
    nativeR.status !== "Partial" ||
    !TIER_IDS.includes(nativeR.tier) ||
    !Array.isArray(nativeR.versions) ||
    nativeR.versions.length === 0 ||
    !Array.isArray(nativeR.workflowOwners) ||
    nativeR.workflowOwners.length === 0 ||
    new Set(nativeR.workflowOwners).size !== nativeR.workflowOwners.length ||
    !sameArray(nativeR.workflowOwners, EXPECTED_NATIVE_R_OWNERS) ||
    nativeR.promotionIssue !== "https://github.com/Matt17BR/openwrangler/issues/87"
  ) {
    problems.push("Native R compatibility evidence must stay Partial, bounded, owner-backed, and linked to issue #87.");
    return false;
  }
  for (const version of nativeR.versions) {
    if (
      !exactKeys(version, ["version", "platforms"]) ||
      typeof version.version !== "string" ||
      !Array.isArray(version.platforms) ||
      version.platforms.length === 0 ||
      version.platforms.some((platform) => !["linux", "macos", "windows"].includes(platform)) ||
      new Set(version.platforms).size !== version.platforms.length
    ) {
      problems.push("Every Native R version must have unique, ordered supported platforms.");
    }
  }
  return problems.length === initialProblemCount;
}

function tier(authority, id) {
  return authority.tiers.find((candidate) => candidate.id === id);
}

function editor(authority, id) {
  return authority.editors.find((candidate) => candidate.id === id);
}

function forkSmoke(authority) {
  return authority.forkSmokes[0];
}

function versionEvidence(target) {
  if (target.apiVersion === null) return "None";
  if (target.releaseVersion === null) return `API \`${target.apiVersion}\`; no release target`;
  if (target.id === "vscode") {
    return `API \`${target.apiVersion}\`; pinned performance \`${target.releaseVersion}\`; moving stable candidate lanes`;
  }
  return `API \`${target.apiVersion}\`; pinned release target \`${target.releaseVersion}\``;
}

function workflowJobNames(owners) {
  return owners.map((owner) => `\`${owner.slice(owner.indexOf("#") + 1)}\``).join(", ");
}

function platformLabels(platforms) {
  return platforms.map((platform) => PLATFORM_LABELS.get(platform)).join(", ");
}

function markdownTable(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => [...row[column]].length)));
  const formatRow = (row) => `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [formatRow(rows[0]), formatRow(widths.map((width) => "-".repeat(width))), ...rows.slice(1).map(formatRow)];
}

function renderLegacyReadmeSupportTable(authority) {
  return markdownTable([
    ["Editor", "Support"],
    ...authority.editors.map((target) => [target.name, target.support])
  ]).join("\n");
}

export function renderCompatibilityReadmeTable(authority) {
  const rows = authority.editors.map((target) => {
    const evidence = target.tier === null ? "—" : tier(authority, target.tier).label;
    return [target.name, versionEvidence(target), platformLabels(target.platforms), evidence, target.support];
  });
  const antigravity = forkSmoke(authority);
  rows.push([
    antigravity.name,
    `Open Wrangler \`${antigravity.extensionVersion}\`; editor \`${antigravity.editorVersion}\``,
    "Linux x64",
    tier(authority, antigravity.tier).label,
    antigravity.support
  ]);
  const nativePlatforms = [...new Set(authority.nativeR.versions.flatMap((entry) => entry.platforms))];
  rows.push([
    authority.nativeR.name,
    authority.nativeR.versions.map((entry) => `R ${entry.version} on ${platformLabels(entry.platforms)}`).join("; "),
    platformLabels(nativePlatforms),
    tier(authority, authority.nativeR.tier).label,
    authority.nativeR.status
  ]);
  return [
    README_START,
    "",
    ...markdownTable([["Target", "Current version evidence", "Platforms", "Evidence tier", "Support"], ...rows]),
    "",
    README_END
  ].join("\n");
}

export function renderCompatibilityReleaseSection(authority) {
  const vscode = editor(authority, "vscode");
  const cursor = editor(authority, "cursor");
  const antigravity = forkSmoke(authority);
  const nativeVersions = authority.nativeR.versions
    .map((entry) => `R ${entry.version} on ${platformLabels(entry.platforms)}`)
    .join("; ");
  return [
    RELEASE_START,
    "",
    "## Compatibility evidence tiers",
    "",
    "Compatibility claims use one ordered evidence vocabulary from `fixtures/compatibility-evidence.json`:",
    "",
    ...authority.tiers.map((entry) => `- **${entry.label}:** ${entry.meaning}`),
    "",
    `VS Code is **${tier(authority, vscode.tier).label}** on ${platformLabels(vscode.platforms)} through distinct evidence lanes: exact ${vscode.releaseVersion} installed-performance evidence from ${workflowJobNames(vscode.pinnedWorkflowOwners)}; moving stable candidate evidence from ${workflowJobNames(vscode.movingStableWorkflowOwners)}; and source/final fan-in from ${workflowJobNames(vscode.fanInWorkflowOwners)}. The exact pin is not attributed to the moving stable jobs. Cursor ${cursor.releaseVersion} on ${platformLabels(cursor.platforms)} remains a **${tier(authority, cursor.tier).label}**. Native R records ${nativeVersions} at the **${tier(authority, authority.nativeR.tier).label}** tier. A tier names the required evidence; an exact candidate earns it only when every listed workflow owner passes.`,
    "",
    `Separately, Open Wrangler ${antigravity.extensionVersion} retains one **${tier(authority, antigravity.tier).label}** Antigravity ${antigravity.editorVersion} Linux ${antigravity.architecture} record through ${antigravity.registry}. It verifies installation, activation through \`${antigravity.activationCommand}\`, one ${antigravity.openedFormat} open, ${antigravity.sourceImmutability}, and ${antigravity.cleanup}. It is historical, experimental, and does not raise the general desktop-fork category above API-compatible.`,
    "",
    `Native R remains **${authority.nativeR.status}**. Promotion to fully qualified support is tracked by [issue #87](${authority.nativeR.promotionIssue}); local implementation evidence cannot replace installed or cross-platform release qualification.`,
    RELEASE_END
  ].join("\n");
}

export function renderCompatibilityArchitectureParagraph(authority) {
  const vscode = editor(authority, "vscode");
  const cursor = editor(authority, "cursor");
  const antigravity = forkSmoke(authority);
  const ownerSummary = [
    ["VS Code", editor(authority, "vscode").workflowOwners],
    ["Cursor", editor(authority, "cursor").workflowOwners],
    ["Native R", authority.nativeR.workflowOwners]
  ]
    .map(([name, owners]) => `${name}: ${owners.map((owner) => `\`${owner}\``).join(", ")}`)
    .join("; ");
  return [
    ARCHITECTURE_START,
    "",
    `Compatibility vocabulary, versions, platforms, and workflow ownership come from \`fixtures/compatibility-evidence.json\` and are checked by \`scripts/compatibility-evidence.mjs\`. VS Code ${vscode.releaseVersion} is pinned by \`${vscode.versionOwner}\` only for ${workflowJobNames(vscode.pinnedWorkflowOwners)}; ${workflowJobNames(vscode.movingStableWorkflowOwners)} intentionally exercise the moving stable channel, and ${workflowJobNames(vscode.fanInWorkflowOwners)} own source/final fan-in. Cursor ${cursor.releaseVersion} is pinned by \`${cursor.versionOwner}\`. The current workflow owners are ${ownerSummary}. The separate Antigravity ${antigravity.editorVersion} Linux ${antigravity.architecture} smoke remains bound to \`${antigravity.evidenceOwner}\`. API compatibility is a source contract; it never inherits installed or release qualification from a higher tier.`,
    ARCHITECTURE_END
  ].join("\n");
}

export function renderCompatibilityParityReference(authority) {
  const vscode = editor(authority, "vscode");
  const cursor = editor(authority, "cursor");
  const antigravity = forkSmoke(authority);
  const versions = authority.nativeR.versions.map((entry) => entry.version).join(" and ");
  return `The compatibility authority records VS Code on ${platformLabels(vscode.platforms)} at the **${tier(authority, vscode.tier).label}** tier through distinct exact ${vscode.releaseVersion} installed-performance and moving stable candidate lanes; the exact pin is not attributed to stable-channel jobs. Cursor ${cursor.releaseVersion} on ${platformLabels(cursor.platforms)} is a **${tier(authority, cursor.tier).label}**. Its separate Open Wrangler ${antigravity.extensionVersion}/Antigravity ${antigravity.editorVersion} Linux ${antigravity.architecture} record is **${tier(authority, antigravity.tier).label}** and does not promote other desktop forks above API-compatible. Native R ${versions} coverage is a **${tier(authority, authority.nativeR.tier).label}**, not full product qualification; its promotion remains tied to [issue #87](${authority.nativeR.promotionIssue}).`;
}

function inspectExactBlock(source, start, end, expected, label, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024) {
    problems.push(`${label} must be bounded documentation text.`);
    return;
  }
  const visibleSource = visibleMarkdown(source, label, problems);
  const visibleExpected = visibleMarkdown(expected, `${label} expected block`, problems).trim();
  if (
    source.split(start).length !== 2 ||
    source.split(end).length !== 2 ||
    !source.includes(expected) ||
    countOccurrences(visibleSource, visibleExpected) !== 1
  ) {
    problems.push(`${label} compatibility claims differ from the generated authority.`);
  }
}

function inspectExactText(source, expected, label, problems) {
  const visibleSource = visibleMarkdown(source, label, problems);
  const visibleExpected = visibleMarkdown(expected, `${label} expected text`, problems);
  if (countOccurrences(visibleSource, visibleExpected) !== 1) {
    problems.push(`${label} compatibility claims differ from the generated authority.`);
  }
}

export function inspectCompatibilityEvidence(inputs) {
  const problems = new BoundedDiagnostics();
  let authority;
  try {
    authority = parseStrictJson(inputs.authoritySource, {
      maxBytes: COMPATIBILITY_EVIDENCE_MAX_BYTES,
      maxDepth: MAX_DEPTH
    });
  } catch {
    return ["Compatibility evidence must be bounded strict JSON without duplicate members."];
  }
  if (!validateAuthority(authority, problems)) return problems.toArray();

  let packageJson;
  try {
    packageJson = parseStrictJson(inputs.packageSource, { maxBytes: 1024 * 1024, maxDepth: 16 });
  } catch {
    problems.push("package.json must remain bounded strict JSON.");
  }
  const apiVersion = packageJson?.engines?.vscode;
  const vscodeVersion = oneCapture(
    inputs.remoteWorkspaceContractSource,
    /^export const PINNED_REMOTE_VSCODE_VERSION = "(?<value>[^"]+)";$/gmu,
    "Pinned VS Code version",
    problems
  );
  const cursorVersion = oneCapture(
    inputs.cursorAcquisitionSource,
    /^export const PINNED_CURSOR_VERSION = "(?<value>[^"]+)";$/gmu,
    "Pinned Cursor version",
    problems
  );
  const vscode = editor(authority, "vscode");
  const cursor = editor(authority, "cursor");
  const otherForks = editor(authority, "other-vscode-desktop-forks");
  if (apiVersion !== vscode.apiVersion || apiVersion !== cursor.apiVersion || apiVersion !== otherForks.apiVersion) {
    problems.push("Editor API compatibility claims must equal package.json engines.vscode.");
  }
  if (vscodeVersion !== vscode.releaseVersion || cursorVersion !== cursor.releaseVersion) {
    problems.push("Pinned editor release versions differ from the compatibility authority.");
  }
  if (
    !sameArray(vscode.platforms, ["linux", "macos", "windows"]) ||
    !sameArray(cursor.platforms, ["linux"]) ||
    !sameArray(otherForks.platforms, ["distribution-specific"])
  ) {
    problems.push("Editor compatibility platforms are unsupported or out of order.");
  }

  const candidateWorkflow = parseWorkflowDocument(inputs.candidateWorkflowSource, "candidate-acceptance.yml", problems);
  const ciWorkflow = parseWorkflowDocument(inputs.ciWorkflowSource, "ci.yml", problems);
  const crossWorkflow = parseWorkflowDocument(
    inputs.crossWorkflowSource ?? readFileSync(resolve(root, ".github/workflows/cross-platform.yml"), "utf8"),
    "cross-platform.yml",
    problems
  );
  const candidateJobs = candidateWorkflow?.jobs ?? Object.create(null);
  const ciJobs = ciWorkflow?.jobs ?? Object.create(null);
  const crossJobs = crossWorkflow?.jobs ?? Object.create(null);
  const workflowSources = new Map([
    [".github/workflows/candidate-acceptance.yml", candidateJobs],
    [".github/workflows/ci.yml", ciJobs]
  ]);
  for (const target of [...authority.editors.filter((entry) => entry.support !== "Unsupported"), authority.nativeR]) {
    for (const owner of target.workflowOwners) {
      const match = /^(?<path>\.github\/workflows\/[a-z0-9-]+\.yml)#(?<job>[a-z][a-z0-9_-]*)$/u.exec(owner);
      if (!match || !Object.hasOwn(workflowSources.get(match.groups.path) ?? {}, match.groups.job)) {
        problems.push(`Compatibility workflow owner ${JSON.stringify(owner)} is missing.`);
      }
    }
  }
  const movingStableJobs = new Set(
    vscode.movingStableWorkflowOwners.map((owner) => owner.slice(owner.indexOf("#") + 1))
  );
  inspectEffectiveEditorVersions(candidateWorkflow, movingStableJobs, problems);
  inspectSemanticCandidateClaims(candidateJobs, problems);
  if (
    !sameArray(authority.nativeR.versions, [
      { version: "4.4.3", platforms: ["linux"] },
      { version: "4.5.2", platforms: ["linux", "macos", "windows"] }
    ]) ||
    authority.nativeR.tier !== "focused-release-seam"
  ) {
    problems.push("Native R versions, platforms, or current evidence tier differ from candidate workflow ownership.");
  }

  if (
    !Object.hasOwn(ciJobs, "r-contract-kernel") ||
    !Object.hasOwn(ciJobs, "r-contract-protocol") ||
    !Object.hasOwn(crossJobs, "r-4-4-scheduled-qualification") ||
    !ownsRVersion(ciJobs["r-contract-kernel"], "4.5.3") ||
    !ownsRVersion(ciJobs["r-contract-protocol"], "4.5.3") ||
    !ownsRVersion(crossJobs["r-4-4-scheduled-qualification"], "4.4")
  ) {
    problems.push("Native R source ownership must retain the two protected R 4.5 jobs and scheduled R 4.4 job.");
  }
  inspectVisiblePublicRecords(inputs, problems);

  inspectExactBlock(
    inputs.readmeSource,
    README_START,
    README_END,
    renderCompatibilityReadmeTable(authority),
    "README.md",
    problems
  );
  inspectExactText(inputs.readmeSource, renderLegacyReadmeSupportTable(authority), "README.md", problems);
  inspectExactBlock(
    inputs.releasingSource,
    RELEASE_START,
    RELEASE_END,
    renderCompatibilityReleaseSection(authority),
    "docs/releasing.md",
    problems
  );
  inspectExactBlock(
    inputs.architectureSource,
    ARCHITECTURE_START,
    ARCHITECTURE_END,
    renderCompatibilityArchitectureParagraph(authority),
    "docs/architecture.md",
    problems
  );
  inspectExactText(
    inputs.featureParitySource,
    renderCompatibilityParityReference(authority),
    "docs/feature-parity.md",
    problems
  );
  return problems.toArray();
}

const root = resolve(import.meta.dirname, "..");

function repositoryInputs() {
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  return {
    authoritySource: read("fixtures/compatibility-evidence.json"),
    packageSource: read("package.json"),
    remoteWorkspaceContractSource: read("scripts/remote-workspace-contract.mjs"),
    cursorAcquisitionSource: read("scripts/cursor-acquisition.mjs"),
    candidateWorkflowSource: read(".github/workflows/candidate-acceptance.yml"),
    ciWorkflowSource: read(".github/workflows/ci.yml"),
    crossWorkflowSource: read(".github/workflows/cross-platform.yml"),
    readmeSource: read("README.md"),
    releasingSource: read("docs/releasing.md"),
    architectureSource: read("docs/architecture.md"),
    featureParitySource: read("docs/feature-parity.md"),
    testingSource: read("docs/testing.md"),
    ciDocumentationSource: read("docs/ci.md")
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "compatibility-evidence.mjs")) {
  const problems = inspectCompatibilityEvidence(repositoryInputs());
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
  }
}
