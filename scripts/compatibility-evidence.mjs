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
const ARCHITECTURE_CURRENT_OWNERS_START = "<!-- open-wrangler-current-compatibility-owners:start -->";
const ARCHITECTURE_CURRENT_OWNERS_END = "<!-- open-wrangler-current-compatibility-owners:end -->";
const CI_CURRENT_OWNERS_START = "<!-- open-wrangler-ci-compatibility-owners:start -->";
const CI_CURRENT_OWNERS_END = "<!-- open-wrangler-ci-compatibility-owners:end -->";
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const MAX_WORKFLOW_JOBS = 64;
const MAX_WORKFLOW_STEPS = 128;
const MAX_ENVIRONMENT_MEMBERS = 64;
const MAX_WORKFLOW_NODES = 50_000;
const MAX_WORKFLOW_DEPTH = 64;
const MAX_WORKFLOW_MEMBERS = 512;
const MAX_SHELL_BYTES = 64 * 1024;
const MAX_SHELL_TOKENS = 2_048;
const MAX_SHELL_TOKEN_BYTES = 4 * 1024;
const MAX_SHELL_COMMANDS = 512;
const MAX_VISIBLE_HTML_TAGS = 4_096;
const MAX_INLINE_HTML_ATTRIBUTE_BYTES = 16 * 1024;
const MAX_CSS_DECLARATIONS = 64;
const MAX_CSS_DECLARATION_BYTES = 2 * 1024;
const EDITOR_VERSION_ENVIRONMENT_KEY = "VSCODE_TEST_VERSION";
const MOVING_EDITOR_VERSION = "stable";
const NON_VISIBLE_HTML_CONTAINERS = new Set([
  "details",
  "head",
  "iframe",
  "noscript",
  "object",
  "pre",
  "code",
  "script",
  "style",
  "template",
  "textarea",
  "title"
]);
const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);
const INLINE_HTML_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "del",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var"
]);
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
const EXPECTED_OWNER_JOB_CONDITIONS = new Map([
  ["candidate-acceptance.yml#contract", undefined],
  ["candidate-acceptance.yml#platform", undefined],
  ["candidate-acceptance.yml#r_platform", undefined],
  ["candidate-acceptance.yml#linux", undefined],
  ["candidate-acceptance.yml#performance", undefined],
  ["candidate-acceptance.yml#jupyter", undefined],
  ["candidate-acceptance.yml#r_local", undefined],
  ["candidate-acceptance.yml#acceptance", "${{ always() }}"],
  [
    "ci.yml#canonical-editor",
    "${{ !cancelled() && github.event_name == 'pull_request' && (needs.classify.result != 'success' || needs.classify.outputs.canonical_editor_required != 'false') }}"
  ]
]);
const EXPECTED_NATIVE_R_SOURCE_JOB_CONDITIONS = new Map([
  [
    "ci.yml#r-contract-kernel",
    "${{ !cancelled() && github.event_name == 'pull_request' && (needs.classify.result != 'success' || needs.classify.outputs.r_contract_required != 'false') }}"
  ],
  [
    "ci.yml#r-contract-protocol",
    "${{ !cancelled() && github.event_name == 'pull_request' && (needs.classify.result != 'success' || needs.classify.outputs.r_contract_required != 'false') }}"
  ],
  ["cross-platform.yml#r-4-4-scheduled-qualification", "${{ !cancelled() }}"]
]);
const EXPECTED_NATIVE_R_SOURCE_COMMANDS = new Map([
  ["ci.yml#r-contract-kernel", "npm run test:r-contract -- --shard kernel-agent"],
  ["ci.yml#r-contract-protocol", "npm run test:r-contract:protocol"],
  ["cross-platform.yml#r-4-4-scheduled-qualification", "npm run test:r-contract"]
]);
const EXPECTED_CI_RESULT_FAN_IN = Object.freeze({
  R_CONTRACT_REQUIRED: "${{ needs.classify.outputs.r_contract_required }}",
  CANONICAL_EDITOR_REQUIRED: "${{ needs.classify.outputs.canonical_editor_required }}",
  VISUAL_ACCESSIBILITY_REQUIRED: "${{ needs.classify.outputs.visual_accessibility_required }}",
  WINDOWS_UNIQUE_REQUIRED: "${{ needs.classify.outputs.windows_unique_required }}",
  CLASSIFY_RESULT: "${{ needs.classify.result }}",
  INVARIANT_CORE_RESULT: "${{ needs.invariant-core.result }}",
  R_CONTRACT_KERNEL_RESULT: "${{ needs.r-contract-kernel.result }}",
  R_CONTRACT_PROTOCOL_RESULT: "${{ needs.r-contract-protocol.result }}",
  CANONICAL_EDITOR_RESULT: "${{ needs.canonical-editor.result }}",
  VISUAL_ACCESSIBILITY_RESULT: "${{ needs.visual-accessibility.result }}",
  WINDOWS_UNIQUE_RESULT: "${{ needs.windows-unique.result }}"
});
const EXPECTED_RUNNER_FAN_IN_ENVIRONMENTS = new Map([
  [
    "r_platform",
    Object.freeze({
      CORE_OUTCOME: "${{ steps.packaged_editor_r_core.outcome }}",
      NATIVE_OUTCOME: "${{ steps.packaged_editor_r_native.outcome }}",
      RESTART_OUTCOME: "${{ steps.packaged_editor_r_restart.outcome }}"
    })
  ],
  [
    "r_local",
    Object.freeze({
      SHARD: "${{ matrix.shard }}",
      CORE_OUTCOME: "${{ steps.packaged_editor_r_core.outcome }}",
      RESTART_OUTCOME: "${{ steps.packaged_editor_r_restart.outcome }}",
      INTERACTIVE_OUTCOME: "${{ steps.packaged_editor_r_interactive.outcome }}",
      LITERATE_OUTCOME: "${{ steps.packaged_editor_r_literate.outcome }}",
      NATIVE_OUTCOME: "${{ steps.packaged_editor_r_native.outcome }}",
      VALUES_OUTCOME: "${{ steps.packaged_editor_r_values.outcome }}",
      CATEGORICAL_OUTCOME: "${{ steps.packaged_editor_r_categorical.outcome }}"
    })
  ]
]);
const EXPECTED_RUNNER_CONDITIONS = new Map([
  ["platform#packaged_editor", undefined],
  ["r_platform#packaged_editor_r_core", "${{ always() && steps.canonical_r_core.outcome == 'success' }}"],
  ["r_platform#packaged_editor_r_native", "${{ always() && steps.canonical_r_native.outcome == 'success' }}"],
  ["r_platform#packaged_editor_r_restart", "${{ always() && steps.canonical_r_restart.outcome == 'success' }}"],
  ["linux#packaged_vscode", undefined],
  ["linux#packaged_cursor", undefined],
  ["performance#installed_performance", undefined],
  ["jupyter#packaged_editor", "${{ matrix.phase == 'python' }}"],
  ["jupyter#packaged_editor_r_remote", "${{ matrix.phase == 'r-remote' }}"],
  [
    "r_local#packaged_editor_r_core",
    "${{ always() && matrix.shard == 'lifecycle' && steps.canonical_r_core.outcome == 'success' }}"
  ],
  [
    "r_local#packaged_editor_r_restart",
    "${{ always() && matrix.shard == 'lifecycle' && steps.canonical_r_restart.outcome == 'success' }}"
  ],
  [
    "r_local#packaged_editor_r_interactive",
    "${{ always() && matrix.shard == 'lifecycle' && steps.canonical_r_interactive.outcome == 'success' }}"
  ],
  [
    "r_local#packaged_editor_r_literate",
    "${{ always() && matrix.shard == 'lifecycle' && steps.canonical_r_literate.outcome == 'success' }}"
  ],
  [
    "r_local#packaged_editor_r_native",
    "${{ always() && matrix.shard == 'editing' && steps.canonical_r_native.outcome == 'success' }}"
  ],
  [
    "r_local#packaged_editor_r_values",
    "${{ always() && matrix.shard == 'editing' && steps.canonical_r_values.outcome == 'success' }}"
  ],
  [
    "r_local#packaged_editor_r_categorical",
    "${{ always() && matrix.shard == 'editing' && steps.canonical_r_categorical.outcome == 'success' }}"
  ],
  ["canonical-editor#packaged_editor", undefined]
]);
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
const STRUCTURED_PUBLIC_RECORDS = Object.freeze([
  {
    source: "architectureSource",
    start: ARCHITECTURE_CURRENT_OWNERS_START,
    end: ARCHITECTURE_CURRENT_OWNERS_END,
    text: [
      "VS Code owns the one full generic packaged journey. Linux Cursor and the generic macOS/Windows VS Code cells run",
      "the focused `platform-smoke` compatibility seam without rerunning extension-host suites or R setup. Separate",
      "`r_platform` cells prepare R once per OS and run freshly verified VS Code-only `core-operations`, `native-frames`, then",
      "`kernel-restart`. The candidate `r_platform` matrix runs installed-artifact VS Code journeys with R 4.4.3 on Ubuntu, R 4.5.2 on macOS, and R 4.5.2 on Windows.",
      "Enabled scheduled/manual Cross owns the direct R 4.4 source qualification, while protected pull-request CI's required `validate` fan-in owns the direct R 4.5 source contracts."
    ].join("\n"),
    label: "docs/architecture.md current compatibility ownership record"
  },
  {
    source: "ciDocumentationSource",
    start: CI_CURRENT_OWNERS_START,
    end: CI_CURRENT_OWNERS_END,
    text: [
      "- focused packaged VS Code `platform-smoke` OS compatibility on macOS and Windows, without native-R setup or",
      "  execution, while one pinned Linux Cursor smoke owns the lifecycle/renderer-replacement/narrow-grid/reveal-state",
      "  fork-compatibility seam;",
      "- native-R platform acceptance in a separate Ubuntu, macOS, and Windows matrix: R 4.4.3 on Ubuntu and R 4.5.2 on macOS and Windows, with fresh VS Code-only core, native-frame, and kernel-restart phases;",
      "- released Jupyter in fixed parallel Python, Linux local-R-shard, and remote-R jobs uses VS Code only for complete",
      "  local and remote Python and R coverage; Cursor owns no Jupyter or R phase, and the complete value and categorical",
      "  catalogs are owned once by Linux VS Code;",
      "- native-R installed-artifact compatibility in the local and platform cells; protected pull-request CI's required",
      "  `validate` fan-in owns the R 4.5 source contracts, while enabled scheduled/manual Cross owns the R 4.4 source",
      "  qualification;",
      "- Remote SSH;",
      "- installed performance in pinned VS Code, gated on first-grid timing, cache residency, scrolling, outstanding-work",
      "  responsiveness, cancellation, and cleanup rather than whole-process-tree RSS sampling; Cursor performance remains",
      "  historical evidence only;",
      "- one full generic packaged journey in Linux VS Code, a focused Linux Cursor `platform-smoke`, exact-artifact",
      "  platform/package checks, live public-metadata and security audits, and the strict runtime benchmark;",
      "  protected pull-request CI remains the sole owner of source, coverage, extension-host, browser-baseline, and",
      "  accessibility suites."
    ].join("\n"),
    label: "docs/ci.md current compatibility ownership record"
  }
]);
const ALLOWLISTED_OUTSIDE_CLAIMS = Object.freeze([
  {
    source: "releasingSource",
    text: "A first-attempt dispatch from protected `main` validates stable metadata, packages one canonical triple, and reuses its numeric artifact ID across VS Code, one pinned Cursor lifecycle/responsive-grid seam, Python/Jupyter, R 4.4 and 4.5 compatibility, installed performance, and Remote SSH"
  },
  {
    source: "releasingSource",
    text: "Protected pull-request CI owns the direct R 4.5 contract, while scheduled/manual Cross retains direct R 4.4 evidence"
  },
  {
    source: "releasingSource",
    text: "Candidate editor coverage keeps one complete installed Clone lifecycle, targeted value/categorical catalogs, one comprehensive Linux VS Code native-frame owner, representative macOS/Windows R seams, and exactly one Cursor lifecycle/responsive-grid/reveal-state seam"
  },
  {
    source: "releasingSource",
    text: "Cursor runs exactly one pinned Linux lifecycle/responsive-grid/reveal-state seam and owns no operation catalog, Jupyter, R catalog, performance, or operating-system matrix"
  },
  {
    source: "featureParitySource",
    text: "macOS/Windows VS Code gate | Preview release | | Exact active R-terminal transport | 1.99 preview | Partial | Zero-command vscode-R hints, explicit PID-checked bootstrap, native callback tests, and packaged VS Code/Cursor journey | Preview release | | Cursor-owned `.Rmd` and `.qmd` R/Python chunk | 1.99 preview | Partial | Executor-aware mixed-fence and exact-origin tests"
  },
  {
    source: "featureParitySource",
    text: "This slice closes the released command-argument mismatch, and the local packaged run recorded below closes the released-Jupyter functional gate for VS Code 1.130.0 and Cursor 3.13.10"
  },
  {
    source: "featureParitySource",
    text: "candidate gate now also requires Cursor | Preview release | | Cleaned-data export | R notebook/document CSV/Parquet | Partial | Native writers, bounded transfer, atomic save, installed notebook/document run | Preview release | | Active R-terminal cleaned-data export | 1.99 preview | Partial | Real-R streaming and atomic-save tests"
  },
  {
    source: "featureParitySource",
    text: "## PySpark live-notebook viewer Open Wrangler supports viewing local PySpark 4.2.x Classic and Connect batch DataFrames from live Jupyter notebooks in VS Code and Cursor"
  },
  {
    source: "testingSource",
    text: "A local packaged run on 2026-07-26 passed both released-Jupyter phases and the complete ordinary packaged phases in VS Code 1.130.0 and Cursor 3.13.10"
  },
  {
    source: "testingSource",
    text: "the default `linux-all` lane keeps the broader VS Code, Cursor, Python, active R terminal, and remote-Jupyter coverage"
  },
  {
    source: "testingSource",
    text: "Before DuckDB can move beyond preview, add its full semantic edge matrix, installed VS Code/Cursor Jupyter evidence, large mixed/nested fixtures, cross-platform CI evidence, and repeated full-size performance reports"
  },
  {
    source: "testingSource",
    text: "On a fresh run, Open Wrangler sends one empty selection to create the source-routed Interactive Window without user code, waits for that exact sole-open window's marked Jupyter system cell or canonical auto-selected Python metadata, and explicitly reveals that same captured notebook when Cursor has not published a stable visible editor"
  },
  {
    source: "testingSource",
    text: "candidate selectors prove only the installed editor seams and do not repeat that catalog through Cursor or performance"
  },
  {
    source: "testingSource",
    text: "It runs only the five existing remote R Docker phases and does not prepare hosted R, a local R or Python kernel environment, Cursor, or native R/Quarto tooling"
  },
  {
    source: "testingSource",
    text: "On a supported Linux host, run the released-Jupyter phases in both editors on a prepared private Xvfb display: On Linux, run VS Code without creating a window or touching the current desktop: Cursor uses the same isolated profiles but currently requires the explicit invisible Xvfb compatibility mode on this reference host: Xvfb here is a deterministic test compositor, not a claim that production Linux desktops use X11"
  },
  {
    source: "testingSource",
    text: "These timings cover native-R runtime and owned stdin/stdout request boundaries, not IRkernel, VS Code, Cursor, webview, editor first paint, filesystem-cold reads, or cross-language comparison"
  },
  {
    source: "testingSource",
    text: "They prove every consumer uses the numeric artifact ID, candidate jobs remain read-only, VS Code owns semantic acceptance, Cursor runs exactly one generic Linux lifecycle seam, R 4.4 and 4.5 platform evidence remains present, performance emits one digest-bound report, and no current candidate path publishes"
  },
  {
    source: "ciDocumentationSource",
    text: "The dedicated Linux restart phase passed in both VS Code and Cursor, value and categorical editing passed, and both native-R platform journeys passed with their then-embedded restart coverage"
  },
  {
    source: "ciDocumentationSource",
    text: "The R 4.5 source contract stays in protected pull-request CI and the R 4.4 source contract stays in scheduled/manual Cross rather than running inside or beside either packaged-editor shard"
  },
  {
    source: "ciDocumentationSource",
    text: "macOS/Windows packaged VS Code, Cursor, and released-Jupyter journeys already run again against the exact release candidate"
  }
]);
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
    text: "protected pull-request CI's required\n  `validate` fan-in owns the R 4.5 source contracts, while enabled scheduled/manual Cross owns the R 4.4 source\n  qualification",
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
    text: "Enabled scheduled/manual Cross owns the direct R 4.4 source qualification, while protected pull-request CI's required `validate` fan-in owns the direct R 4.5 source contracts.",
    label: "docs/architecture.md Native R source ownership record"
  },
  {
    source: "architectureSource",
    text: "Linux, macOS, and Windows run both selectors in VS Code; Cursor owns only its focused Linux `platform-smoke`.",
    label: "docs/architecture.md selector ownership record"
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

function continueOnErrorIsDisabled(owner) {
  return record(owner) && (!Object.hasOwn(owner, "continue-on-error") || owner["continue-on-error"] === false);
}

function emptyEnvironment(environment) {
  return environment === undefined || exactKeys(environment, []);
}

function exactEffectiveFanInEnvironment(workflow, job, step, expected) {
  const expectedKeys = Object.keys(expected);
  const stepEnvironmentIsExact =
    expectedKeys.length === 0
      ? emptyEnvironment(step?.env)
      : exactKeys(step?.env, expectedKeys) && Object.entries(expected).every(([key, value]) => step.env[key] === value);
  return emptyEnvironment(workflow?.env) && emptyEnvironment(job?.env) && stepEnvironmentIsExact;
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

function boundedShellTokens(command) {
  if (typeof command !== "string" || Buffer.byteLength(command, "utf8") > MAX_SHELL_BYTES) {
    return { commands: [], error: "command text is not bounded" };
  }
  const commands = [];
  const controls = [];
  let tokens = [];
  let token = "";
  let quote;
  let retainedTokens = 0;
  const retainToken = () => {
    if (token.length === 0) return true;
    if (Buffer.byteLength(token, "utf8") > MAX_SHELL_TOKEN_BYTES || retainedTokens >= MAX_SHELL_TOKENS) {
      return false;
    }
    tokens.push(token);
    retainedTokens += 1;
    token = "";
    return true;
  };
  const retainCommand = () => {
    if (!retainToken()) return false;
    if (tokens.length === 0) return true;
    if (commands.length >= MAX_SHELL_COMMANDS) return false;
    commands.push(tokens);
    tokens = [];
    return true;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        index += 1;
        if (index >= command.length) return { commands: [], error: "command ends with an escape" };
        token += command[index];
      } else {
        token += character;
      }
      continue;
    }
    if (character === "'") {
      quote = "single";
    } else if (character === '"') {
      quote = "double";
    } else if (character === "\\") {
      index += 1;
      if (index >= command.length) return { commands: [], error: "command ends with an escape" };
      if (command[index] !== "\n") token += command[index];
    } else if (character === "`" || (character === "$" && command[index + 1] === "(")) {
      return { commands: [], error: "command substitution is outside the evidence grammar" };
    } else if (character === "#" && token.length === 0) {
      while (index < command.length && command[index] !== "\n") index += 1;
      if (!retainCommand()) return { commands: [], error: "command structure exceeds its bounds" };
    } else if (/\s/u.test(character)) {
      if (!retainToken()) return { commands: [], error: "command structure exceeds its bounds" };
      if (character === "\n" && !retainCommand()) {
        return { commands: [], error: "command structure exceeds its bounds" };
      }
    } else if (character === ";" || character === "|" || character === "&") {
      if (!retainCommand()) return { commands: [], error: "command structure exceeds its bounds" };
      if (command[index + 1] === character) {
        controls.push(`${character}${character}`);
        index += 1;
      } else {
        controls.push(character);
      }
    } else {
      token += character;
    }
  }
  if (quote !== undefined) return { commands: [], error: "command contains an unterminated quote" };
  if (!retainCommand()) return { commands: [], error: "command structure exceeds its bounds" };
  return { commands, controls, error: undefined };
}

function shellAssignment(token) {
  const match = /^(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/u.exec(token);
  return match ? { key: match.groups.key, value: match.groups.value } : undefined;
}

function executableShellCommands(command) {
  const parsed = boundedShellTokens(command);
  if (parsed.error) return { commands: [], controls: [], assignments: [], error: parsed.error };
  const commands = [];
  const assignments = [];
  const exported = new Map();
  for (const tokens of parsed.commands) {
    let index = 0;
    const local = new Map(exported);
    if (tokens[index] === "export") {
      index += 1;
      for (; index < tokens.length; index += 1) {
        const assignment = shellAssignment(tokens[index]);
        if (!assignment) {
          return {
            commands: [],
            controls: parsed.controls,
            assignments,
            error: "export must contain only literal assignments"
          };
        }
        assignments.push(assignment);
        exported.set(assignment.key, assignment.value);
      }
      continue;
    }
    while (index < tokens.length) {
      const assignment = shellAssignment(tokens[index]);
      if (!assignment) break;
      assignments.push(assignment);
      local.set(assignment.key, assignment.value);
      index += 1;
    }
    if (index === tokens.length) {
      for (const [key, value] of local) exported.set(key, value);
      continue;
    }
    if (tokens[index] === "env") {
      index += 1;
      if (tokens[index]?.startsWith("-") && tokens[index] !== "--") {
        return {
          commands: [],
          controls: parsed.controls,
          assignments,
          error: "env options are outside the evidence grammar"
        };
      }
      if (tokens[index] === "--") index += 1;
      while (index < tokens.length) {
        const assignment = shellAssignment(tokens[index]);
        if (!assignment) break;
        assignments.push(assignment);
        local.set(assignment.key, assignment.value);
        index += 1;
      }
    }
    if (index < tokens.length) {
      commands.push({ tokens: tokens.slice(index), environment: local });
    }
  }
  const foldedKeyReferences = command.replace(/["'\\]/gu, "").includes(EDITOR_VERSION_ENVIRONMENT_KEY);
  const hasClassifiedKey = assignments.some(({ key }) => key === EDITOR_VERSION_ENVIRONMENT_KEY);
  return {
    commands,
    controls: parsed.controls,
    assignments,
    error: foldedKeyReferences && !hasClassifiedKey ? "editor-version reference is not a literal assignment" : undefined
  };
}

function runnerKind(command) {
  let tokens = command.tokens;
  if (tokens[0] === "/usr/bin/dbus-run-session") {
    if (tokens[1] !== "--") return undefined;
    tokens = tokens.slice(2);
  }
  if (tokens[0] === "node" && tokens[1] === "scripts/run-packaged-editor-tests.mjs") return "packaged-editor";
  if (tokens[0] === "npm" && tokens[1] === "run" && tokens[2] === "benchmark:installed" && tokens[3] === "--") {
    return "installed-performance";
  }
  return undefined;
}

function analyzedRunner(step) {
  const analysis = executableShellCommands(step?.run);
  if (analysis.error || analysis.commands.length !== 1) return undefined;
  const command = analysis.commands[0];
  const kind = runnerKind(command);
  return kind ? { ...command, kind, assignments: analysis.assignments } : undefined;
}

function compatibilityRunner(step) {
  return analyzedRunner(step) !== undefined;
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

function inspectNativeRSourceOwnerReachability(ciWorkflow, crossWorkflow, problems) {
  if (!ciWorkflow || !crossWorkflow) return;
  const ciJobs = ciWorkflow.jobs;
  const crossJobs = crossWorkflow.jobs;
  const owners = new Map([
    ["ci.yml#r-contract-kernel", ciJobs["r-contract-kernel"]],
    ["ci.yml#r-contract-protocol", ciJobs["r-contract-protocol"]],
    ["cross-platform.yml#r-4-4-scheduled-qualification", crossJobs["r-4-4-scheduled-qualification"]]
  ]);
  const ownersReachable = [...owners].every(
    ([owner, job]) =>
      record(job) &&
      continueOnErrorIsDisabled(job) &&
      normalizedCondition(job.if) === EXPECTED_NATIVE_R_SOURCE_JOB_CONDITIONS.get(owner) &&
      Array.isArray(job.steps) &&
      job.steps.every(continueOnErrorIsDisabled) &&
      job.steps.some(
        (step) =>
          normalizedCondition(step.if) === undefined &&
          continueOnErrorIsDisabled(step) &&
          step.run === EXPECTED_NATIVE_R_SOURCE_COMMANDS.get(owner)
      )
  );
  const crossTriggers = crossWorkflow.on;
  const crossOwnerIsTriggered =
    record(crossTriggers) &&
    Object.hasOwn(crossTriggers, "workflow_dispatch") &&
    (crossTriggers.workflow_dispatch === null || record(crossTriggers.workflow_dispatch)) &&
    sameArray(crossTriggers.schedule, [{ cron: "17 4 * * 1" }]);
  const validate = ciJobs.validate;
  const resultOwner = validate?.steps?.find(
    (step) => normalizedCondition(step.if) === undefined && step.run === "node scripts/require-ci-results.mjs"
  );
  const hasRequiredFanIn =
    record(validate) &&
    continueOnErrorIsDisabled(validate) &&
    normalizedCondition(validate.if) === "${{ always() && github.event_name == 'pull_request' }}" &&
    Array.isArray(validate.needs) &&
    ["classify", "r-contract-kernel", "r-contract-protocol"].every((owner) => validate.needs.includes(owner)) &&
    Array.isArray(validate.steps) &&
    validate.steps.every(continueOnErrorIsDisabled) &&
    continueOnErrorIsDisabled(resultOwner) &&
    exactEffectiveFanInEnvironment(ciWorkflow, validate, resultOwner, EXPECTED_CI_RESULT_FAN_IN);
  if (!ownersReachable || !crossOwnerIsTriggered || !hasRequiredFanIn) {
    problems.push("Native R source ownership must retain enabled owners and the required CI success fan-in.");
  }
}

function normalizedCondition(condition) {
  return typeof condition === "string" ? condition.trim().replace(/\s+/gu, " ") : condition;
}

function inspectEffectiveEditorVersions(workflow, expectedVersions, workflowLabel, problems) {
  if (!workflow) return;
  const workflowAssignment = environmentValue(workflow.env, `${workflowLabel} workflow environment`, problems);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!expectedVersions.has(jobId)) continue;
    const expectedVersion = expectedVersions.get(jobId);
    const jobAssignment = environmentValue(job.env, `${workflowLabel} owner ${jobId} environment`, problems);
    const runners = (job.steps ?? []).filter(compatibilityRunner);
    if (expectedVersion !== undefined && runners.length === 0) {
      problems.push(`${workflowLabel} owner ${jobId} must retain an exact editor runner.`);
      continue;
    }
    for (const [stepIndex, step] of (job.steps ?? []).entries()) {
      const label = `${workflowLabel} owner ${jobId} step ${stepIndex + 1}`;
      const stepAssignment = environmentValue(step.env, `${label} environment`, problems);
      const inheritedAssignment = stepAssignment.present
        ? stepAssignment
        : jobAssignment.present
          ? jobAssignment
          : workflowAssignment;
      const commandAnalysis = executableShellCommands(step.run);
      if (
        commandAnalysis.error &&
        typeof step.run === "string" &&
        step.run.replace(/["'\\]/gu, "").includes(EDITOR_VERSION_ENVIRONMENT_KEY)
      ) {
        problems.push(`${label} has an unsupported command-level editor-version reference.`);
      }
      const commandValues = commandAnalysis.assignments
        .filter(({ key }) => key === EDITOR_VERSION_ENVIRONMENT_KEY)
        .map(({ value }) => value);
      if (
        (inheritedAssignment.present && inheritedAssignment.value !== expectedVersion) ||
        commandValues.some((value) => value !== expectedVersion)
      ) {
        problems.push(`${workflowLabel} owner ${jobId} has an invalid effective editor version.`);
      }
      const runner = analyzedRunner(step);
      if (runner) {
        const effectiveValue = runner.environment.get(EDITOR_VERSION_ENVIRONMENT_KEY) ?? inheritedAssignment.value;
        if (effectiveValue !== expectedVersion) {
          problems.push(`${workflowLabel} owner ${jobId} runner must use its exact effective editor version.`);
        }
      }
    }
  }
}

function runnerSteps(job) {
  return Array.isArray(job?.steps) ? job.steps.filter(compatibilityRunner) : [];
}

function runnerEnvironment(step, expected) {
  const runner = analyzedRunner(step);
  if (!runner || !record(step?.env)) return false;
  return Object.entries(expected).every(([key, value]) => {
    const effective = runner.environment.has(key) ? runner.environment.get(key) : step.env[key];
    return effective === value;
  });
}

function orderedRunnerEnvironmentValues(job, key) {
  return runnerSteps(job).map((step) => step.env?.[key]);
}

function containsTokenSequence(tokens, expected) {
  for (let index = 0; index <= tokens.length - expected.length; index += 1) {
    if (expected.every((token, offset) => tokens[index + offset] === token)) return true;
  }
  return false;
}

function oneRunnerCommand(job, expectedKind, sequences) {
  const runners = runnerSteps(job);
  if (runners.length !== 1) return false;
  const runner = analyzedRunner(runners[0]);
  return runner?.kind === expectedKind && sequences.every((sequence) => containsTokenSequence(runner.tokens, sequence));
}

function exactSuccessFanIn(step, environmentKeys) {
  const analysis = executableShellCommands(step?.run);
  return (
    !analysis.error &&
    analysis.assignments.length === 0 &&
    analysis.controls.every((control) => control === ";") &&
    analysis.commands.length === environmentKeys.length + 1 &&
    sameArray(analysis.commands[0]?.tokens, ["set", "-euo", "pipefail"]) &&
    environmentKeys.every((key, index) =>
      sameArray(analysis.commands[index + 1]?.tokens, ["test", `$${key}`, "=", "success"])
    )
  );
}

function exactLocalRShardSuccessFanIn(step) {
  const expectedRun = `set -euo pipefail
case "$SHARD" in
  lifecycle)
    test "$CORE_OUTCOME" = "success"
    test "$RESTART_OUTCOME" = "success"
    test "$INTERACTIVE_OUTCOME" = "success"
    test "$LITERATE_OUTCOME" = "success"
    ;;
  editing)
    test "$NATIVE_OUTCOME" = "success"
    test "$VALUES_OUTCOME" = "success"
    test "$CATEGORICAL_OUTCOME" = "success"
    ;;
  *) exit 1 ;;
esac`;
  return step.run?.trim() === expectedRun;
}

function runnerOutcomeIsOwned(workflow, jobId, job, runnerId) {
  return (job.steps ?? []).some((step) => {
    const condition = normalizedCondition(step.if);
    const commandAnalysis = executableShellCommands(step.run);
    const exactFailureExit =
      condition === `\${{ always() && steps.${runnerId}.outcome == 'failure' }}` &&
      continueOnErrorIsDisabled(step) &&
      exactEffectiveFanInEnvironment(workflow, job, step, {}) &&
      !commandAnalysis.error &&
      commandAnalysis.assignments.length === 0 &&
      commandAnalysis.controls.length === 0 &&
      commandAnalysis.commands.length === 1 &&
      sameArray(commandAnalysis.commands[0].tokens, ["exit", "1"]);
    const expectedEnvironment = EXPECTED_RUNNER_FAN_IN_ENVIRONMENTS.get(jobId);
    return (
      exactFailureExit ||
      (normalizedCondition(step.if) === "${{ always() }}" &&
        continueOnErrorIsDisabled(step) &&
        expectedEnvironment !== undefined &&
        Object.values(expectedEnvironment).includes(`\${{ steps.${runnerId}.outcome }}`) &&
        exactEffectiveFanInEnvironment(workflow, job, step, expectedEnvironment) &&
        (jobId === "r_local"
          ? exactLocalRShardSuccessFanIn(step)
          : exactSuccessFanIn(step, Object.keys(expectedEnvironment))))
    );
  });
}

function inspectOwnerConditions(workflow, workflowName, jobIds, problems) {
  if (!workflow) return;
  for (const jobId of jobIds) {
    const job = workflow.jobs[jobId];
    if (!job) continue;
    const owner = `${workflowName}#${jobId}`;
    if (!continueOnErrorIsDisabled(job) || normalizedCondition(job.if) !== EXPECTED_OWNER_JOB_CONDITIONS.get(owner)) {
      problems.push(`Compatibility owner ${owner} must retain its exact effective condition.`);
    }
    for (const step of runnerSteps(job)) {
      const conditionOwner = `${jobId}#${step.id}`;
      if (
        typeof step.id !== "string" ||
        !EXPECTED_RUNNER_CONDITIONS.has(conditionOwner) ||
        normalizedCondition(step.if) !== EXPECTED_RUNNER_CONDITIONS.get(conditionOwner)
      ) {
        problems.push(`Compatibility runner ${owner} must retain its exact effective condition.`);
      }
      if (workflowName === "candidate-acceptance.yml") {
        if (step["continue-on-error"] !== true || !runnerOutcomeIsOwned(workflow, jobId, job, step.id)) {
          problems.push(`Compatibility runner ${owner} must retain an executable success owner.`);
        }
      } else if (!continueOnErrorIsDisabled(step)) {
        problems.push(`Compatibility runner ${owner} may not suppress its result.`);
      }
    }
  }
}

function inspectSemanticCandidateClaims(workflow, problems) {
  if (!workflow) return;
  const jobs = workflow.jobs;
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
    !oneRunnerCommand(jobs.performance, "installed-performance", [
      ["npm", "run", "benchmark:installed", "--"],
      ["--pinned-editors"],
      ["--editors", "vscode"],
      ["--candidate-in", "canonical-release/openwrangler.vsix"]
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
    normalizedCondition(jobs.acceptance?.if) !== "${{ always() }}" ||
    !sameArray(jobs.acceptance?.needs, expectedNeeds) ||
    jobs.acceptance?.steps?.length !== 1 ||
    !continueOnErrorIsDisabled(jobs.acceptance) ||
    !continueOnErrorIsDisabled(acceptanceStep) ||
    !exactEffectiveFanInEnvironment(
      workflow,
      jobs.acceptance,
      acceptanceStep,
      Object.fromEntries(Object.entries(acceptanceResults).map(([key, job]) => [key, `\${{ needs.${job}.result }}`]))
    ) ||
    !exactSuccessFanIn(acceptanceStep, Object.keys(acceptanceResults))
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

function htmlTagPattern() {
  return /<(?<closing>\/)?(?<tag>[A-Za-z][A-Za-z0-9:-]*)\b(?<attributes>(?:[^"'<>]|"[^"]*"|'[^']*')*)>/gisu;
}

function cssDeclarationValue(value) {
  let normalized = value
    .trim()
    .replace(/\s*!\s*important\s*$/iu, "")
    .trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized.toLowerCase();
}

function styleHidesContainer(styleValue, label, problems) {
  if (Buffer.byteLength(styleValue, "utf8") > MAX_INLINE_HTML_ATTRIBUTE_BYTES) {
    problems.push(`${label} contains an oversized inline style declaration.`);
    return true;
  }
  const declarations = styleValue.split(";");
  if (declarations.length > MAX_CSS_DECLARATIONS) {
    problems.push(`${label} contains too many inline style declarations.`);
    return true;
  }
  for (const declaration of declarations) {
    if (Buffer.byteLength(declaration, "utf8") > MAX_CSS_DECLARATION_BYTES) {
      problems.push(`${label} contains an oversized inline style declaration.`);
      return true;
    }
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = cssDeclarationValue(declaration.slice(separator + 1));
    if ((property === "display" && value === "none") || (property === "visibility" && value === "hidden")) {
      return true;
    }
  }
  return false;
}

function hiddenHtmlContainer(tag, attributes, label, problems) {
  if (Buffer.byteLength(attributes, "utf8") > MAX_INLINE_HTML_ATTRIBUTE_BYTES) {
    problems.push(`${label} contains an oversized HTML attribute list.`);
    return true;
  }
  const style = /(?:^|\s)style\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s]+))/iu.exec(attributes);
  const styleValue = style?.groups?.double ?? style?.groups?.single ?? style?.groups?.bare ?? "";
  return (
    NON_VISIBLE_HTML_CONTAINERS.has(tag) ||
    /(?:^|\s)hidden(?:\s|=|$)/iu.test(attributes) ||
    /(?:^|\s)aria-hidden\s*=\s*(?:"true"|'true'|true)(?=\s|$)/iu.test(attributes) ||
    styleHidesContainer(styleValue, label, problems)
  );
}

function matchingHiddenContainerEnd(source, opening, state, label, problems) {
  const tag = opening.groups.tag.toLowerCase();
  const attributes = opening.groups.attributes;
  const openingEnd = opening.index + opening[0].length;
  if (VOID_HTML_TAGS.has(tag) || /\/\s*$/u.test(attributes)) return openingEnd;
  const pattern = htmlTagPattern();
  pattern.lastIndex = openingEnd;
  let depth = 1;
  for (const candidate of source.matchAll(pattern)) {
    state.tags += 1;
    if (state.tags > MAX_VISIBLE_HTML_TAGS) {
      problems.push(`${label} contains too many HTML tags for visible-record inspection.`);
      state.saturated = true;
      return source.length;
    }
    if (candidate.groups.tag.toLowerCase() !== tag) continue;
    if (candidate.groups.closing) {
      depth -= 1;
      if (depth === 0) return candidate.index + candidate[0].length;
    } else if (!VOID_HTML_TAGS.has(tag) && !/\/\s*$/u.test(candidate.groups.attributes)) {
      depth += 1;
    }
  }
  problems.push(`${label} contains an unterminated hidden or preformatted container.`);
  return source.length;
}

function visibleMarkdown(source, label, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024) {
    problems.push(`${label} must be bounded documentation text.`);
    return "";
  }
  const uncommented = [];
  let cursor = 0;
  while (cursor < source.length) {
    const commentStart = source.indexOf("<!--", cursor);
    if (commentStart < 0) {
      uncommented.push(source.slice(cursor));
      break;
    }
    uncommented.push(source.slice(cursor, commentStart));
    const commentEnd = source.indexOf("-->", commentStart + 4);
    if (commentEnd < 0) {
      problems.push(`${label} contains an unterminated HTML comment.`);
      return uncommented.join("");
    }
    uncommented.push("\n".repeat(source.slice(commentStart, commentEnd + 3).split("\n").length - 1));
    cursor = commentEnd + 3;
  }
  const renderableLines = [];
  let fence;
  for (const line of uncommented.join("").split("\n")) {
    const fenceMarker = /^ {0,3}(?<marker>`{3,}|~{3,})/u.exec(line)?.groups?.marker;
    if (fence) {
      const close = /^ {0,3}(?<marker>`{3,}|~{3,})\s*$/u.exec(line)?.groups?.marker;
      if (close?.[0] === fence.character && close.length >= fence.length) fence = undefined;
      renderableLines.push("");
      continue;
    }
    if (fenceMarker) {
      fence = { character: fenceMarker[0], length: fenceMarker.length };
      renderableLines.push("");
      continue;
    }
    if (/^(?: {4}|\t)/u.test(line)) {
      renderableLines.push("");
      continue;
    }
    renderableLines.push(line);
  }
  if (fence) problems.push(`${label} contains an unterminated fenced code block.`);
  const renderable = renderableLines.join("\n");
  const visible = [];
  const state = { tags: 0, saturated: false };
  const pattern = htmlTagPattern();
  let retainedCursor = 0;
  let candidate;
  while ((candidate = pattern.exec(renderable)) !== null) {
    state.tags += 1;
    if (state.tags > MAX_VISIBLE_HTML_TAGS) {
      problems.push(`${label} contains too many HTML tags for visible-record inspection.`);
      state.saturated = true;
      break;
    }
    if (
      candidate.groups.closing ||
      !hiddenHtmlContainer(candidate.groups.tag.toLowerCase(), candidate.groups.attributes, label, problems)
    ) {
      continue;
    }
    visible.push(renderable.slice(retainedCursor, candidate.index));
    const hiddenEnd = matchingHiddenContainerEnd(renderable, candidate, state, label, problems);
    visible.push("\n".repeat(renderable.slice(candidate.index, hiddenEnd).split("\n").length - 1));
    retainedCursor = hiddenEnd;
    pattern.lastIndex = hiddenEnd;
    if (state.saturated) break;
  }
  if (!state.saturated) visible.push(renderable.slice(retainedCursor));
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

function inspectStructuredPublicRecords(inputs, visibleSources, problems) {
  for (const record of STRUCTURED_PUBLIC_RECORDS) {
    const source = inputs[record.source];
    if (typeof source !== "string") {
      problems.push(`${record.label} must remain one exact top-level structured record.`);
      continue;
    }
    const startIndex = source.indexOf(record.start);
    const endIndex = source.indexOf(record.end);
    const body =
      startIndex >= 0 && endIndex > startIndex
        ? source.slice(startIndex + record.start.length, endIndex).trim()
        : undefined;
    if (
      countOccurrences(source, record.start) !== 1 ||
      countOccurrences(source, record.end) !== 1 ||
      body !== record.text ||
      countOccurrences(
        normalizedVisibleRecord(visibleSources.get(record.source)),
        normalizedVisibleRecord(record.text)
      ) !== 1
    ) {
      problems.push(`${record.label} must remain one exact top-level structured record.`);
    }
  }
}

function compatibilityClaimTexts(authority, source, problems) {
  const texts = [];
  const rendered = new Map([
    ["readmeSource", [renderCompatibilityReadmeTable(authority), renderLegacyReadmeSupportTable(authority)]],
    ["releasingSource", [renderCompatibilityReleaseSection(authority)]],
    ["architectureSource", [renderCompatibilityArchitectureParagraph(authority)]],
    ["featureParitySource", [renderCompatibilityParityReference(authority)]]
  ]);
  for (const text of rendered.get(source) ?? []) {
    texts.push(visibleMarkdown(text, `${source} canonical compatibility record`, problems));
  }
  texts.push(
    ...STRUCTURED_PUBLIC_RECORDS.filter((record) => record.source === source).map((record) => record.text),
    ...ALLOWLISTED_OUTSIDE_CLAIMS.filter((record) => record.source === source).map((record) => record.text),
    ...VISIBLE_PUBLIC_RECORDS.filter((record) => record.source === source).map((record) => record.text)
  );
  return texts.map(normalizedVisibleRecord).filter((text) => text.length > 0);
}

function claimTokens(claim) {
  return new Set(claim.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)*/gu) ?? []);
}

function decodeRenderedEntities(claim) {
  const named = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["gt", ">"],
    ["lt", "<"],
    ["lrm", "\u200e"],
    ["newline", "\n"],
    ["nbsp", " "],
    ["nobreak", "\u2060"],
    ["negativemediumspace", "\u200b"],
    ["negativethickspace", "\u200b"],
    ["negativethinspace", "\u200b"],
    ["negativeverythinspace", "\u200b"],
    ["quot", '"'],
    ["rlm", "\u200f"],
    ["shy", "\u00ad"],
    ["tab", "\t"],
    ["zerowidthspace", "\u200b"],
    ["zwj", "\u200d"],
    ["zwnj", "\u200c"]
  ]);
  return claim.replace(/&(?:#(?<decimal>[0-9]+)|#x(?<hex>[0-9a-f]+)|(?<named>[a-z]+));/giu, (entity, ...args) => {
    const groups = args.at(-1);
    if (groups.named) return named.get(groups.named.toLowerCase()) ?? "";
    const codePoint = Number.parseInt(groups.hex ?? groups.decimal, groups.hex ? 16 : 10);
    return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function renderedInlineHtml(claim) {
  const rendered = [];
  const pattern = htmlTagPattern();
  let cursor = 0;
  for (const candidate of claim.matchAll(pattern)) {
    rendered.push(claim.slice(cursor, candidate.index));
    const tag = candidate.groups.tag.toLowerCase();
    if (!INLINE_HTML_TAGS.has(tag)) rendered.push(" ");
    cursor = candidate.index + candidate[0].length;
  }
  rendered.push(claim.slice(cursor));
  return rendered.join("");
}

function renderedProseClaim(claim) {
  return decodeRenderedEntities(renderedInlineHtml(claim.replace(/(`+)[\s\S]*?\1/gu, " ")))
    .replace(/[*_~]+/gu, "")
    .replace(/[\u00ad\u200b-\u200f\u2060-\u2064\u206a-\u206f\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasTokenStem(tokens, stems) {
  return [...tokens].some((token) => stems.some((stem) => token.startsWith(stem)));
}

function hasNonCanonicalName(claim, canonical, pattern) {
  return [...claim.replace(/\s+/gu, " ").matchAll(pattern)].some((match) => match[0] !== canonical);
}

function structuredOwnershipViolation(claim) {
  const renderedClaim = renderedProseClaim(claim);
  const tokens = claimTokens(renderedClaim);
  const has = (...values) => values.every((value) => tokens.has(value));
  const ownsEvidence = hasTokenStem(tokens, [
    "own",
    "run",
    "execut",
    "qualif",
    "certif",
    "validat",
    "cover",
    "assign",
    "attribut",
    "responsib",
    "attest",
    "designat",
    "demonstrat",
    "establish",
    "eviden",
    "prov",
    "support"
  ]);
  const cursorRestrictedTarget =
    tokens.has("jupyter") ||
    has("native", "r") ||
    has("installed", "performance") ||
    (tokens.has("r") && ["phase", "journey", "coverage", "catalog"].some((value) => tokens.has(value)));
  const cursorProductContext =
    (ownsEvidence &&
      ((tokens.has("released") && tokens.has("jupyter")) ||
        has("native", "r") ||
        has("installed", "performance") ||
        tokens.has("fork"))) ||
    (tokens.has("pinned") && tokens.has("linux") && (tokens.has("compatibility") || tokens.has("smoke")));
  if (cursorProductContext && hasNonCanonicalName(renderedClaim, "Cursor", /(?<![./_-])\bcursor\b(?![./_-])/giu)) {
    return "named product and editor claims must retain exact canonical case";
  }
  if (
    ownsEvidence &&
    [
      ["VS Code", /\bvs code\b/giu],
      ["VS Code", /(?<![./_-])\bvscode\b(?![./_-])/giu],
      ["Open Wrangler", /\bopen wrangler\b/giu],
      ["Open Wrangler", /(?<![./_-])\bopenwrangler\b(?![./_-])/giu],
      ["Antigravity", /(?<![./_?=&-])\bantigravity\b(?![./_?=&-])/giu],
      ["Open VSX", /\bopen vsx\b/giu],
      ["Open VSX", /(?<![./_-])\bopenvsx\b(?![./_-])/giu]
    ].some(([canonical, pattern]) => hasNonCanonicalName(renderedClaim, canonical, pattern))
  ) {
    return "named product and editor claims must retain exact canonical case";
  }
  if (/\bCursor\b/u.test(renderedClaim) && cursorRestrictedTarget && ownsEvidence) {
    return "compatibility-sensitive Cursor ownership must remain inside its bounded canonical record";
  }
  if (
    tokens.has("r") &&
    tokens.has("4.4") &&
    ownsEvidence &&
    (has("protected", "pull", "request", "ci") || has("candidate", "acceptance"))
  ) {
    return "direct R 4.4 source qualification must remain owned by scheduled/manual Cross";
  }
  if (has("installed", "performance") && has("vs", "code") && (tokens.has("moving") || tokens.has("stable"))) {
    return "the exact installed-performance record may not be attributed to moving stable VS Code";
  }
  return undefined;
}

function inspectStructuredOwnershipClaims(authority, source, visible, problems) {
  let outside = normalizedVisibleRecord(visible);
  for (const record of compatibilityClaimTexts(authority, source, problems)) {
    outside = outside.replace(record, " ");
  }
  const claims = outside.split(/[!?;]\s+|\.(?=\s|$)/gu);
  if (claims.length > 4_096 || claims.some((claim) => Buffer.byteLength(claim, "utf8") > 16 * 1024)) {
    problems.push(`${source}: compatibility claim inspection exceeds its structural bounds.`);
    return;
  }
  for (const claim of claims) {
    const violation = structuredOwnershipViolation(claim);
    if (violation) problems.push(`${source}: ${violation}.`);
  }
}

function inspectVisiblePublicRecords(inputs, authority, problems) {
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
  for (const record of ALLOWLISTED_OUTSIDE_CLAIMS) {
    if (
      countOccurrences(
        normalizedVisibleRecord(visibleSources.get(record.source)),
        normalizedVisibleRecord(record.text)
      ) !== 1
    ) {
      problems.push(`${record.source} must retain each exact allowlisted compatibility claim once.`);
    }
  }
  inspectStructuredPublicRecords(inputs, visibleSources, problems);
  for (const [source, visible] of visibleSources) {
    inspectStructuredOwnershipClaims(authority, source, visible, problems);
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
  const candidateEditorVersions = new Map(
    vscode.workflowOwners.map((owner) => {
      const jobId = owner.slice(owner.indexOf("#") + 1);
      return [jobId, movingStableJobs.has(jobId) ? MOVING_EDITOR_VERSION : undefined];
    })
  );
  inspectEffectiveEditorVersions(candidateWorkflow, candidateEditorVersions, "candidate-acceptance.yml", problems);
  inspectEffectiveEditorVersions(
    ciWorkflow,
    new Map([["canonical-editor", MOVING_EDITOR_VERSION]]),
    "ci.yml",
    problems
  );
  inspectOwnerConditions(candidateWorkflow, "candidate-acceptance.yml", [...candidateEditorVersions.keys()], problems);
  inspectOwnerConditions(ciWorkflow, "ci.yml", ["canonical-editor"], problems);
  inspectSemanticCandidateClaims(candidateWorkflow, problems);
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
  inspectNativeRSourceOwnerReachability(ciWorkflow, crossWorkflow, problems);
  inspectVisiblePublicRecords(inputs, authority, problems);

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
