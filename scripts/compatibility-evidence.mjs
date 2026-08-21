import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function workflowJobs(source, label, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) {
    problems.push(`${label} must be bounded workflow text.`);
    return new Map();
  }
  const jobsStart = source.indexOf("\njobs:\n");
  if (jobsStart < 0) {
    problems.push(`${label} must contain one jobs mapping.`);
    return new Map();
  }
  const body = source.slice(jobsStart + 1);
  const starts = [...body.matchAll(/^ {2}(?<id>[a-z][a-z0-9_-]*):\n/gmu)];
  const jobs = new Map();
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    const id = current.groups.id;
    if (jobs.has(id)) {
      problems.push(`${label} contains duplicate job ${id}.`);
      continue;
    }
    jobs.set(id, body.slice(current.index, starts[index + 1]?.index ?? body.length));
  }
  return jobs;
}

function requireMarkers(source, markers, label, problems) {
  for (const marker of markers) {
    if (!source.includes(marker)) problems.push(`${label} lost required source marker ${JSON.stringify(marker)}.`);
  }
}

function requireBoundedMarkers(source, markers, label, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024) {
    problems.push(`${label} must be bounded source text.`);
    return;
  }
  requireMarkers(source, markers, label, problems);
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
  if (source.split(start).length !== 2 || source.split(end).length !== 2 || !source.includes(expected)) {
    problems.push(`${label} compatibility claims differ from the generated authority.`);
  }
}

function inspectExactText(source, expected, label, problems) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024 ||
    source.split(expected).length !== 2
  ) {
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

  const candidateJobs = workflowJobs(inputs.candidateWorkflowSource, "candidate-acceptance.yml", problems);
  const ciJobs = workflowJobs(inputs.ciWorkflowSource, "ci.yml", problems);
  const workflowSources = new Map([
    [".github/workflows/candidate-acceptance.yml", candidateJobs],
    [".github/workflows/ci.yml", ciJobs]
  ]);
  for (const target of [...authority.editors.filter((entry) => entry.support !== "Unsupported"), authority.nativeR]) {
    for (const owner of target.workflowOwners) {
      const match = /^(?<path>\.github\/workflows\/[a-z0-9-]+\.yml)#(?<job>[a-z][a-z0-9_-]*)$/u.exec(owner);
      if (!match || !workflowSources.get(match.groups.path)?.has(match.groups.job)) {
        problems.push(`Compatibility workflow owner ${JSON.stringify(owner)} is missing.`);
      }
    }
  }
  for (const owner of vscode.movingStableWorkflowOwners) {
    const job = owner.slice(owner.indexOf("#") + 1);
    if (!candidateJobs.get(job)?.includes("VSCODE_TEST_VERSION: stable")) {
      problems.push(`VS Code moving stable candidate lane ${owner} must retain VSCODE_TEST_VERSION: stable.`);
    }
  }
  requireMarkers(
    candidateJobs.get("platform") ?? "",
    [
      "- os: macos-latest",
      "- os: windows-latest",
      "OPEN_WRANGLER_PACKAGED_EDITORS: vscode",
      "OPEN_WRANGLER_PACKAGED_MODE: platform-smoke",
      "VSCODE_TEST_VERSION: stable"
    ],
    "VS Code platform owner",
    problems
  );
  requireMarkers(
    candidateJobs.get("linux") ?? "",
    [
      "OPEN_WRANGLER_PACKAGED_EDITORS: vscode",
      "OPEN_WRANGLER_PACKAGED_EDITORS: cursor",
      "OPEN_WRANGLER_PACKAGED_MODE: platform-smoke",
      "VSCODE_TEST_VERSION: stable"
    ],
    "Linux editor owner",
    problems
  );
  requireMarkers(
    candidateJobs.get("performance") ?? "",
    [
      "name: Installed performance in pinned editors",
      "/usr/bin/dbus-run-session -- npm run benchmark:installed --",
      "--pinned-editors",
      "--editors vscode",
      "--candidate-in canonical-release/openwrangler.vsix"
    ],
    "VS Code installed-performance owner",
    problems
  );
  requireMarkers(
    candidateJobs.get("jupyter") ?? "",
    [
      "matrix:\n        phase: [python, r-remote]",
      "OPEN_WRANGLER_PACKAGED_EDITORS: vscode",
      "OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE: candidate-one-owner",
      'OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1"',
      'OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1"',
      "VSCODE_TEST_VERSION: stable"
    ],
    "VS Code released-Jupyter owner",
    problems
  );
  requireMarkers(
    candidateJobs.get("acceptance") ?? "",
    [
      "needs: [contract, platform, r_platform, linux, performance, jupyter, r_local]",
      "CONTRACT_RESULT: ${{ needs.contract.result }}",
      "PLATFORM_RESULT: ${{ needs.platform.result }}",
      "R_PLATFORM_RESULT: ${{ needs.r_platform.result }}",
      "LINUX_RESULT: ${{ needs.linux.result }}",
      "PERFORMANCE_RESULT: ${{ needs.performance.result }}",
      "JUPYTER_RESULT: ${{ needs.jupyter.result }}",
      "R_LOCAL_RESULT: ${{ needs.r_local.result }}",
      'test "$PERFORMANCE_RESULT" = "success"',
      'test "$JUPYTER_RESULT" = "success"'
    ],
    "complete VS Code qualification fan-in",
    problems
  );
  requireMarkers(
    candidateJobs.get("r_platform") ?? "",
    [
      '- os: ubuntu-24.04\n            python: "3.12"\n            r: "4.4.3"',
      '- os: macos-latest\n            python: "3.12"\n            r: "4.5.2"',
      '- os: windows-latest\n            python: "3.14"\n            r: "4.5.2"',
      "OPEN_WRANGLER_PACKAGED_R_JOURNEY: core-operations",
      "OPEN_WRANGLER_PACKAGED_R_JOURNEY: native-frames",
      "OPEN_WRANGLER_PACKAGED_R_JOURNEY: kernel-restart"
    ],
    "Native R platform owner",
    problems
  );
  requireMarkers(
    candidateJobs.get("r_local") ?? "",
    ['r-version: "4.5.2"', "shard: [lifecycle, editing]"],
    "Native R Linux owner",
    problems
  );
  if (
    !sameArray(authority.nativeR.versions, [
      { version: "4.4.3", platforms: ["linux"] },
      { version: "4.5.2", platforms: ["linux", "macos", "windows"] }
    ]) ||
    authority.nativeR.tier !== "focused-release-seam"
  ) {
    problems.push("Native R versions, platforms, or current evidence tier differ from candidate workflow ownership.");
  }

  requireBoundedMarkers(
    inputs.testingSource,
    [
      "### Experimental Antigravity smoke",
      "On 2026-08-01, Open Wrangler 1.2.0 passed one bounded, non-release-blocking Antigravity Linux x64 smoke:",
      `version ${forkSmoke(authority).editorVersion}, commit \`${forkSmoke(authority).editorCommit}\`, and ${forkSmoke(authority).architecture} architecture.`,
      `\`${forkSmoke(authority).installedExtension}\` from that registry.`,
      "does not promote Antigravity to a first-class release target."
    ],
    "Antigravity smoke owner",
    problems
  );
  requireBoundedMarkers(
    inputs.testingSource,
    [
      "The shipped product configuration selected Open VSX.",
      "The public `openWrangler.openFile` command activated the installed extension",
      "opened the exact schema through native Polars."
    ],
    "Antigravity install, activation, and file-open properties",
    problems
  );
  requireBoundedMarkers(
    inputs.testingSource,
    ["The source digest was unchanged."],
    "Antigravity source immutability",
    problems
  );
  requireBoundedMarkers(
    inputs.testingSource,
    [
      "zero Open Wrangler sessions, no running standalone",
      "no surviving editor process; the downloaded archive and private test roots were removed."
    ],
    "Antigravity cleanup properties",
    problems
  );
  requireBoundedMarkers(
    inputs.testingSource,
    [
      "VS Code owns the semantic editor,\nPython/Jupyter, R, and installed-performance journeys;",
      `official VS Code ${vscode.releaseVersion} Linux x64`,
      "The run may not reuse a preinstalled editor, moving download channel"
    ],
    "docs/testing.md contradicts the pinned VS Code evidence",
    problems
  );
  requireBoundedMarkers(
    inputs.ciDocumentationSource,
    [
      "installed performance in pinned VS Code and Cursor",
      "one full generic packaged journey in Linux VS Code",
      "Generic macOS/Windows platform cells own\nonly the packaged VS Code `platform-smoke`",
      "Linux VS Code is the sole full generic packaged owner"
    ],
    "docs/ci.md contradicts the pinned VS Code evidence",
    problems
  );

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
