import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { type ElementHandle, type Frame, type Locator, type Page } from "playwright-core";
import {
  allEditorTabs,
  comparisonFrames,
  comparisonTabsOpenedAfter,
  comparisonWorkbenchReadiness,
  connectToEditorWorkbench,
  recordProgress,
  waitForGenericGridReadiness
} from "./dataWranglerComparison";
import {
  findExactActiveNotebookPreviewButton,
  findExactActiveNotebookRendererButton,
  observeGridScrollability,
  observeInlinePreviewReady
} from "./notebookRendererFrame";

export const COMPARISON_TRIAL_REQUEST_PROTOCOL = "openwrangler-comparison-trial-request-v1";
export const COMPARISON_TRIAL_RESULT_PROTOCOL = "openwrangler-comparison-trial-result-v1";

const CELL_IDS = ["pandas-csv", "pandas-parquet", "polars-csv", "polars-parquet"] as const;
const MILESTONE_NAMES = [
  "memory-settle-start",
  "run-cell-click",
  "inline-ready",
  "launch-click",
  "workbench-ready",
  "profile-click",
  "first-profile-ready",
  "profiles-complete"
] as const;
const FAILURE_STAGES = [
  "harness",
  "run-cell",
  "inline-preview",
  "workbench-open",
  "profile-first",
  "profile-all",
  "cleanup"
] as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const POLL_MS = 25;
const COMPARISON_KERNEL_LABEL = "Python 3.12 (Comparison)";
const COMPARISON_BOOTSTRAP_VARIABLE = "aaa_comparison_bootstrap";
const DATA_WRANGLER_VIEW_DATA_ACTION = "View data";
const KERNEL_ACCESS_DETAIL = "This allows the extension to execute code against Jupyter Kernels.";
const PRODUCT_EXTENSION_IDS = {
  "open-wrangler": "Matt17BR.openwrangler",
  "data-wrangler": "ms-toolsai.datawrangler"
} as const satisfies Record<Product, string>;
const COMPARISON_KERNEL_PROVIDER_ROUTES = ["Jupyter Kernel...", "Jupyter", "Local Kernel Specs..."];
const COMPARISON_KERNEL_ROUTES = ["Select Another Kernel...", ...COMPARISON_KERNEL_PROVIDER_ROUTES];

export function isComparisonKernelLabel(value: string): boolean {
  return (
    value === COMPARISON_KERNEL_LABEL || /^Python 3\.12 \(Comparison\) \(Python 3\.12\.(?:0|[1-9]\d*)\)$/u.test(value)
  );
}

type Product = "open-wrangler" | "data-wrangler";
type Engine = "pandas" | "polars";
type Format = "csv" | "parquet";
type TrialKind = "warm" | "cold";
type FailureStage = (typeof FAILURE_STAGES)[number];
type MilestoneName = (typeof MILESTONE_NAMES)[number];
type PromiseOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

interface ArtifactIdentity {
  readonly path: string;
  readonly version: string;
  readonly sha256: string;
}

export interface ComparisonTrialRequest {
  readonly protocol: typeof COMPARISON_TRIAL_REQUEST_PROTOCOL;
  readonly trialId: string;
  readonly product: Product;
  readonly kind: TrialKind;
  readonly order: number;
  readonly isolatedRoot: string;
  readonly notebookPath: string;
  readonly cell: {
    readonly id: (typeof CELL_IDS)[number];
    readonly engine: Engine;
    readonly format: Format;
    readonly rows: number;
    readonly columns: number;
    readonly source: string;
    readonly variableName: string;
  };
  readonly candidate: ArtifactIdentity;
  readonly dataWranglerVersion: "1.24.2";
  readonly preActionSettleMs: 10_000;
  readonly editor: ArtifactIdentity;
  readonly python: ArtifactIdentity;
  readonly timeoutsMs: {
    readonly preAction: number;
    readonly inlinePreview: number;
    readonly workbenchOpen: number;
    readonly completeProfile: number;
  };
}

export interface ComparisonTrialMilestone {
  readonly name: MilestoneName;
  readonly monotonicNs: string;
}

interface ActionEvidence {
  readonly accessibleName: string;
  readonly unique: true;
  readonly pointer: true;
}

export interface ComparisonTrialResult {
  readonly protocol: typeof COMPARISON_TRIAL_RESULT_PROTOCOL;
  readonly trialId: string;
  readonly product: Product;
  readonly engine: Engine;
  readonly format: Format;
  readonly kind: TrialKind;
  readonly order: number;
  readonly status: "success" | "failure" | "timeout";
  readonly failure: {
    readonly stage: FailureStage;
    readonly kind: "harness" | "product" | "timeout";
    readonly message: string;
  } | null;
  readonly metrics: {
    readonly inlinePreviewMs: number | null;
    readonly workbenchOpenMs: number | null;
    readonly firstProfileMs: number | null;
    readonly completeProfileMs: number | null;
  };
  readonly milestones: readonly ComparisonTrialMilestone[];
  readonly publicUi: {
    readonly runCell: ActionEvidence | null;
    readonly inline: (ActionEvidence & { readonly tableReady: true }) | null;
    readonly workbench: {
      readonly rootRole: "grid" | "table";
      readonly fullShape: "aria-counts" | "visible-label";
      readonly ariaRowCount: number | null;
      readonly ariaColumnCount: number | null;
      readonly verticalOverflow: number;
      readonly horizontalOverflow: number;
      readonly pointerUsable: true;
    } | null;
    readonly profiling:
      | (ActionEvidence & {
          readonly expectedColumns: number;
          readonly completedColumns: number;
        })
      | null;
  };
}

interface MutableEvidence {
  runCell: ActionEvidence | null;
  inline: (ActionEvidence & { readonly tableReady: true }) | null;
  workbench: ComparisonTrialResult["publicUi"]["workbench"];
  profiling: (ActionEvidence & { readonly expectedColumns: number; readonly completedColumns: number }) | null;
}

interface CapturedNotebook {
  readonly notebook: vscode.NotebookDocument;
  readonly editor: vscode.NotebookEditor;
  readonly setupCell: vscode.NotebookCell | null;
  readonly cell: vscode.NotebookCell;
  readonly sourceTab: vscode.Tab;
}

export interface ComparisonNotebookCellContract {
  readonly kind: "code" | "other";
  readonly tags: readonly string[];
  readonly source: string;
  readonly outputCount: number;
}

export interface ComparisonNotebookLayout {
  readonly setupIndex: number | null;
  readonly measuredIndex: number;
}

interface PointerTarget {
  readonly accessibleName: string;
  readonly page: Page;
  pointerReady(): Promise<boolean>;
  click(): Promise<void>;
  inlineReady(input: {
    readonly actionName: string;
    readonly firstColumn: "c00";
    readonly secondColumn: "c01";
  }): Promise<boolean>;
  dispose(): Promise<void>;
}

class JourneyTimeout extends Error {
  public constructor(
    public readonly stage: FailureStage,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "JourneyTimeout";
  }
}

function remainingPreActionMs(deadline: number, message: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new JourneyTimeout("run-cell", message);
  return remaining;
}

async function beforePreActionDeadline<Value>(
  operation: PromiseLike<Value>,
  deadline: number,
  message: string
): Promise<Value> {
  const remaining = remainingPreActionMs(deadline, message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new JourneyTimeout("run-cell", message)), remaining);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fail(message: string): never {
  throw new TypeError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function oneOf<Value extends string>(value: unknown, values: readonly Value[], label: string): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) fail(`${label} is invalid.`);
  return value as Value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid.`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/u.test(value)) {
    fail(`${label} must be one normalized absolute path.`);
  }
  return value;
}

function containedPath(root: string, value: unknown, label: string): string {
  const path = absolutePath(value, label);
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} must be below the isolated trial root.`);
  }
  return path;
}

function artifact(value: unknown, label: string): ArtifactIdentity {
  const item = record(value, label);
  exactKeys(item, ["path", "version", "sha256"], label);
  return Object.freeze({
    path: absolutePath(item.path, `${label}.path`),
    version: matchingString(item.version, VERSION, `${label}.version`),
    sha256: matchingString(item.sha256, SHA256, `${label}.sha256`)
  });
}

export function validateComparisonTrialRequest(value: unknown): ComparisonTrialRequest {
  const request = record(value, "Comparison request");
  exactKeys(
    request,
    [
      "protocol",
      "trialId",
      "product",
      "kind",
      "order",
      "isolatedRoot",
      "notebookPath",
      "cell",
      "candidate",
      "dataWranglerVersion",
      "preActionSettleMs",
      "editor",
      "python",
      "timeoutsMs"
    ],
    "Comparison request"
  );
  if (request.protocol !== COMPARISON_TRIAL_REQUEST_PROTOCOL) fail("Comparison request protocol is invalid.");
  const root = absolutePath(request.isolatedRoot, "Comparison request isolatedRoot");
  const cell = record(request.cell, "Comparison request cell");
  exactKeys(cell, ["id", "engine", "format", "rows", "columns", "source", "variableName"], "Comparison request cell");
  const id = oneOf(cell.id, CELL_IDS, "Comparison request cell.id");
  const engine = oneOf(cell.engine, ["pandas", "polars"] as const, "Comparison request cell.engine");
  const format = oneOf(cell.format, ["csv", "parquet"] as const, "Comparison request cell.format");
  if (id !== `${engine}-${format}`) fail("Comparison request cell identity does not match its engine and format.");
  const timeouts = record(request.timeoutsMs, "Comparison request timeoutsMs");
  exactKeys(
    timeouts,
    ["preAction", "inlinePreview", "workbenchOpen", "completeProfile"],
    "Comparison request timeoutsMs"
  );
  if (request.dataWranglerVersion !== "1.24.2") fail("The comparison baseline must be Data Wrangler 1.24.2.");
  return Object.freeze({
    protocol: COMPARISON_TRIAL_REQUEST_PROTOCOL,
    trialId: matchingString(request.trialId, ID, "Comparison request trialId"),
    product: oneOf(request.product, ["open-wrangler", "data-wrangler"] as const, "Comparison request product"),
    kind: oneOf(request.kind, ["warm", "cold"] as const, "Comparison request kind"),
    order: boundedInteger(request.order, 0, 255, "Comparison request order"),
    isolatedRoot: root,
    notebookPath: containedPath(root, request.notebookPath, "Comparison request notebookPath"),
    cell: Object.freeze({
      id,
      engine,
      format,
      rows: boundedInteger(cell.rows, 2, 100_000_000, "Comparison request cell.rows"),
      columns: boundedInteger(cell.columns, 2, 2_048, "Comparison request cell.columns"),
      source: containedPath(root, cell.source, "Comparison request cell.source"),
      variableName: matchingString(cell.variableName, VARIABLE, "Comparison request cell.variableName")
    }),
    candidate: artifact(request.candidate, "Comparison request candidate"),
    dataWranglerVersion: "1.24.2",
    preActionSettleMs: boundedInteger(
      request.preActionSettleMs,
      10_000,
      10_000,
      "Comparison request preActionSettleMs"
    ) as 10_000,
    editor: artifact(request.editor, "Comparison request editor"),
    python: artifact(request.python, "Comparison request python"),
    timeoutsMs: Object.freeze({
      preAction: boundedInteger(timeouts.preAction, 20_000, 120_000, "preAction timeout"),
      inlinePreview: boundedInteger(timeouts.inlinePreview, 5_000, 120_000, "inlinePreview timeout"),
      workbenchOpen: boundedInteger(timeouts.workbenchOpen, 5_000, 180_000, "workbenchOpen timeout"),
      completeProfile: boundedInteger(timeouts.completeProfile, 10_000, 600_000, "completeProfile timeout")
    })
  });
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3_600_000) {
    fail(`${label} must be null or one bounded duration.`);
  }
  return value;
}

export function validateComparisonTrialResult(value: unknown): ComparisonTrialResult {
  const result = record(value, "Comparison result");
  exactKeys(
    result,
    [
      "protocol",
      "trialId",
      "product",
      "engine",
      "format",
      "kind",
      "order",
      "status",
      "failure",
      "metrics",
      "milestones",
      "publicUi"
    ],
    "Comparison result"
  );
  if (result.protocol !== COMPARISON_TRIAL_RESULT_PROTOCOL) fail("Comparison result protocol is invalid.");
  const status = oneOf(result.status, ["success", "failure", "timeout"] as const, "Comparison result status");
  const milestones = validateMilestones(result.milestones);
  const metrics = record(result.metrics, "Comparison result metrics");
  exactKeys(
    metrics,
    ["inlinePreviewMs", "workbenchOpenMs", "firstProfileMs", "completeProfileMs"],
    "Comparison result metrics"
  );
  const metricValues = [
    optionalNumber(metrics.inlinePreviewMs, "inlinePreviewMs"),
    optionalNumber(metrics.workbenchOpenMs, "workbenchOpenMs"),
    optionalNumber(metrics.firstProfileMs, "firstProfileMs"),
    optionalNumber(metrics.completeProfileMs, "completeProfileMs")
  ];
  const publicUi = record(result.publicUi, "Comparison result publicUi");
  exactKeys(publicUi, ["runCell", "inline", "workbench", "profiling"], "Comparison result publicUi");
  const runCell = validateAction(publicUi.runCell, "Comparison result runCell");
  const inline = validateAction(publicUi.inline, "Comparison result inline", ["tableReady"]);
  if (inline && record(publicUi.inline, "Comparison result inline").tableReady !== true) {
    fail("Comparison result inline preview is not ready.");
  }
  const workbench = publicUi.workbench === null ? null : record(publicUi.workbench, "Comparison result workbench");
  if (workbench) {
    exactKeys(
      workbench,
      [
        "rootRole",
        "fullShape",
        "ariaRowCount",
        "ariaColumnCount",
        "verticalOverflow",
        "horizontalOverflow",
        "pointerUsable"
      ],
      "Comparison result workbench"
    );
    oneOf(workbench.rootRole, ["grid", "table"] as const, "Comparison result workbench rootRole");
    oneOf(workbench.fullShape, ["aria-counts", "visible-label"] as const, "Comparison result workbench fullShape");
    for (const [count, label] of [
      [workbench.ariaRowCount, "ariaRowCount"],
      [workbench.ariaColumnCount, "ariaColumnCount"]
    ] as const) {
      if (count !== null) boundedInteger(count, 1, 100_000_000, `Comparison result ${label}`);
    }
    boundedInteger(workbench.verticalOverflow, 1, 1_000_000_000, "Comparison result verticalOverflow");
    boundedInteger(workbench.horizontalOverflow, 1, 1_000_000_000, "Comparison result horizontalOverflow");
    if (workbench.pointerUsable !== true) fail("Comparison result workbench must be pointer-usable.");
  }
  const profiling = validateAction(publicUi.profiling, "Comparison result profiling", [
    "expectedColumns",
    "completedColumns"
  ]);
  if (profiling) {
    const profile = record(publicUi.profiling, "Comparison result profiling");
    const expected = boundedInteger(profile.expectedColumns, 2, 2_048, "Comparison result expectedColumns");
    const completed = boundedInteger(profile.completedColumns, 0, expected, "Comparison result completedColumns");
    if (status === "success" && completed !== expected) fail("A successful result must complete every profile.");
  }
  const failure = validateFailure(result.failure);
  if (status === "success" && (result.failure !== null || milestones.length !== MILESTONE_NAMES.length)) {
    fail("A successful comparison result must contain every milestone and no failure.");
  }
  if (
    status === "success" &&
    (metricValues.some((metric) => metric === null) || !runCell || !inline || !workbench || !profiling)
  ) {
    fail("A successful comparison result must contain all metrics and public UI evidence.");
  }
  if (status !== "success" && failure === null) fail("A failed comparison result must identify its failure.");
  if ((status === "timeout") !== (failure?.kind === "timeout"))
    fail("Comparison timeout status and failure kind disagree.");
  matchingString(result.trialId, ID, "Comparison result trialId");
  oneOf(result.product, ["open-wrangler", "data-wrangler"] as const, "Comparison result product");
  oneOf(result.engine, ["pandas", "polars"] as const, "Comparison result engine");
  oneOf(result.format, ["csv", "parquet"] as const, "Comparison result format");
  oneOf(result.kind, ["warm", "cold"] as const, "Comparison result kind");
  boundedInteger(result.order, 0, 255, "Comparison result order");
  return value as ComparisonTrialResult;
}

function validateAction(value: unknown, label: string, extraKeys: readonly string[] = []): ActionEvidence | null {
  if (value === null) return null;
  const action = record(value, label);
  exactKeys(action, ["accessibleName", "unique", "pointer", ...extraKeys], label);
  if (
    typeof action.accessibleName !== "string" ||
    action.accessibleName.length < 1 ||
    action.accessibleName.length > 256 ||
    action.unique !== true ||
    action.pointer !== true
  ) {
    fail(`${label} is invalid.`);
  }
  return action as unknown as ActionEvidence;
}

function validateFailure(value: unknown): ComparisonTrialResult["failure"] {
  if (value === null) return null;
  const failure = record(value, "Comparison result failure");
  exactKeys(failure, ["stage", "kind", "message"], "Comparison result failure");
  const stage = oneOf(failure.stage, FAILURE_STAGES, "Comparison result failure stage");
  const kind = oneOf(failure.kind, ["harness", "product", "timeout"] as const, "Comparison result failure kind");
  if (typeof failure.message !== "string" || failure.message.length < 1 || failure.message.length > 500) {
    fail("Comparison result failure message is invalid.");
  }
  return { stage, kind, message: failure.message };
}

function validateMilestones(value: unknown): readonly ComparisonTrialMilestone[] {
  if (!Array.isArray(value) || value.length > MILESTONE_NAMES.length) fail("Comparison result milestones are invalid.");
  let previous = 0n;
  return Object.freeze(
    value.map((raw, index) => {
      const item = record(raw, `Comparison milestone ${index}`);
      exactKeys(item, ["name", "monotonicNs"], `Comparison milestone ${index}`);
      if (item.name !== MILESTONE_NAMES[index]) fail("Comparison milestones must be one ordered prefix.");
      if (typeof item.monotonicNs !== "string" || !/^[1-9]\d{0,29}$/u.test(item.monotonicNs)) {
        fail("Comparison milestone timestamp is invalid.");
      }
      const timestamp = BigInt(item.monotonicNs);
      if (timestamp <= previous) fail("Comparison milestone timestamps must increase strictly.");
      previous = timestamp;
      return Object.freeze({ name: item.name as MilestoneName, monotonicNs: item.monotonicNs });
    })
  );
}

class Milestones {
  private readonly values: ComparisonTrialMilestone[] = [];

  public mark(name: MilestoneName): void {
    assert.equal(MILESTONE_NAMES[this.values.length], name, `Unexpected comparison milestone ${name}.`);
    const timestamp = process.hrtime.bigint();
    const previous = this.values.at(-1);
    assert.ok(!previous || timestamp > BigInt(previous.monotonicNs), "The monotonic comparison clock did not advance.");
    this.values.push(Object.freeze({ name, monotonicNs: timestamp.toString() }));
  }

  public snapshot(): readonly ComparisonTrialMilestone[] {
    return Object.freeze([...this.values]);
  }

  public duration(start: MilestoneName, end: MilestoneName): number | null {
    const left = this.values.find((item) => item.name === start);
    const right = this.values.find((item) => item.name === end);
    if (!left || !right) return null;
    return Math.round((Number(BigInt(right.monotonicNs) - BigInt(left.monotonicNs)) / 1_000_000) * 1_000) / 1_000;
  }
}

function readRequest(path: string): ComparisonTrialRequest {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < 2n ||
    metadata.size > BigInt(MAX_REQUEST_BYTES)
  ) {
    fail("Comparison request must be one bounded regular file.");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength !== Number(metadata.size)) fail("Comparison request changed while it was read.");
  return validateComparisonTrialRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) fail(`Missing required comparison environment ${name}.`);
  return absolutePath(value, `Comparison environment ${name}`);
}

function writeResult(path: string, root: string, result: ComparisonTrialResult): void {
  containedPath(root, path, "Comparison result path");
  const serialized = `${JSON.stringify(validateComparisonTrialResult(result), null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) fail("Comparison result exceeded 64 KiB.");
  if (existsSync(path)) fail("Comparison result path already exists.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function notebookCellTags(cell: vscode.NotebookCell): readonly string[] {
  const wrapper = record(cell.metadata, "Comparison notebook cell metadata");
  const metadata =
    wrapper.metadata === undefined ? wrapper : record(wrapper.metadata, "Comparison notebook cell inner metadata");
  if (metadata.tags === undefined) return [];
  if (
    !Array.isArray(metadata.tags) ||
    metadata.tags.some((tag) => typeof tag !== "string" || tag.length === 0) ||
    new Set(metadata.tags).size !== metadata.tags.length
  ) {
    fail("Comparison notebook cell tags are invalid.");
  }
  return metadata.tags as readonly string[];
}

export function validateComparisonNotebookLayout(input: {
  readonly kind: TrialKind;
  readonly cellId: (typeof CELL_IDS)[number];
  readonly variableName: string;
  readonly cells: readonly ComparisonNotebookCellContract[];
}): ComparisonNotebookLayout {
  const measuredTag = `ow-comparison-cell:${input.cellId}`;
  const setupTag = `ow-comparison-setup:${input.cellId}`;
  const expectedCount = 2;
  if (input.cells.length !== expectedCount) {
    fail(`A ${input.kind} comparison notebook must contain exactly ${expectedCount} code cells.`);
  }
  const tagged = (tag: string): number[] =>
    input.cells.flatMap((cell, index) => (cell.tags.includes(tag) ? [index] : []));
  const measured = tagged(measuredTag);
  const setup = tagged(setupTag);
  if (measured.length !== 1) fail(`The comparison notebook must contain exactly one ${measuredTag} cell.`);
  if (setup.length !== 1) fail(`The comparison notebook must contain exactly one ${setupTag} cell.`);
  if (
    input.cells.some(
      (cell) =>
        cell.kind !== "code" ||
        cell.outputCount !== 0 ||
        cell.tags.some((tag) => tag.startsWith("ow-comparison-") && tag !== measuredTag && tag !== setupTag)
    )
  ) {
    fail("Comparison notebook cells must be fresh code cells with only their exact comparison tags.");
  }
  const measuredIndex = measured[0]!;
  const measuredSource = input.cells[measuredIndex]!.source.trim();
  if (
    (input.kind === "warm" && measuredSource !== input.variableName) ||
    (input.kind === "cold" && measuredSource.split(/\r?\n/u).at(-1)?.trim() !== input.variableName)
  ) {
    fail("The measured comparison cell must end by displaying its exact variable.");
  }
  const setupIndex = setup[0]!;
  const setupSource = input.cells[setupIndex]!.source;
  const assignsMeasuredVariable = setupSource.includes(`${input.variableName} =`);
  if (
    setupIndex !== 0 ||
    measuredIndex !== 1 ||
    !setupSource.includes(`${COMPARISON_BOOTSTRAP_VARIABLE} =`) ||
    assignsMeasuredVariable !== (input.kind === "warm")
  ) {
    fail(
      "The untimed setup must be first, create the bootstrap variable, and assign the measured variable only for a warm trial."
    );
  }
  return Object.freeze({ setupIndex, measuredIndex });
}

async function captureNotebook(request: ComparisonTrialRequest): Promise<CapturedNotebook> {
  const uri = vscode.Uri.file(request.notebookPath);
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  assert.equal(notebook.notebookType, "jupyter-notebook", "The comparison input must be a Jupyter notebook.");
  const editor = await vscode.window.showNotebookDocument(notebook, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false,
    preview: false
  });
  assert.equal(editor.notebook, notebook, "VS Code opened a different comparison notebook object.");
  const cells = Array.from({ length: notebook.cellCount }, (_unused, index) => notebook.cellAt(index));
  const layout = validateComparisonNotebookLayout({
    kind: request.kind,
    cellId: request.cell.id,
    variableName: request.cell.variableName,
    cells: cells.map((cell) => ({
      kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "other",
      tags: notebookCellTags(cell),
      source: cell.document.getText(),
      outputCount: cell.outputs.length
    }))
  });
  const setupCell = layout.setupIndex === null ? null : cells[layout.setupIndex]!;
  const cell = cells[layout.measuredIndex]!;
  const selection = new vscode.NotebookRange(cell.index, cell.index + 1);
  editor.selection = selection;
  editor.selections = [selection];
  editor.revealRange(selection, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
  const sourceTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(sourceTab?.input instanceof vscode.TabInputNotebook, "The measured notebook must own the selected tab.");
  assert.equal(sourceTab.input.uri.toString(), uri.toString(), "The selected notebook tab changed during capture.");
  return { notebook, editor, setupCell, cell, sourceTab };
}

async function visibleQuickInput(page: Page): Promise<Locator | undefined> {
  for (const frame of comparisonFrames(page).slice(0, 64)) {
    const quickInput = frame.locator(".quick-input-widget:visible").last();
    if ((await quickInput.count().catch(() => 0)) > 0 && (await quickInput.isVisible().catch(() => false))) {
      return quickInput;
    }
  }
  return undefined;
}

async function exactQuickPickRow(quickInput: Locator, label: string): Promise<Locator | undefined> {
  const labels = quickInput.locator(".quick-input-list [role='option'] .label-name:visible");
  const count = Math.min(await labels.count().catch(() => 0), 256);
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = labels.nth(index);
    if ((await candidate.innerText().catch(() => "")).trim() === label) {
      matches.push(candidate.locator("xpath=ancestor::*[@role='option'][1]"));
    }
  }
  assert.ok(matches.length < 2, `The kernel picker exposed duplicate ${JSON.stringify(label)} rows.`);
  return matches[0];
}

async function comparisonKernelQuickPickRow(quickInput: Locator): Promise<Locator | undefined> {
  const labels = quickInput.locator(".quick-input-list [role='option'] .label-name:visible");
  const count = Math.min(await labels.count().catch(() => 0), 256);
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = labels.nth(index);
    if (isComparisonKernelLabel((await candidate.innerText().catch(() => "")).trim())) {
      matches.push(candidate.locator("xpath=ancestor::*[@role='option'][1]"));
    }
  }
  assert.ok(matches.length < 2, "The kernel picker exposed duplicate comparison kernel rows.");
  return matches[0];
}

async function quickPickLabels(page: Page): Promise<readonly string[]> {
  const labels: string[] = [];
  for (const frame of comparisonFrames(page).slice(0, 64)) {
    const candidates = frame.locator(".quick-input-widget:visible [role='option'] .label-name:visible");
    const count = Math.min(await candidates.count().catch(() => 0), 32 - labels.length);
    for (let index = 0; index < count; index += 1) {
      labels.push(
        (
          await candidates
            .nth(index)
            .innerText()
            .catch(() => "")
        )
          .trim()
          .slice(0, 80)
      );
    }
    if (labels.length === 32) break;
  }
  return Object.freeze(labels);
}

async function waitForComparisonKernelLabel(page: Page, deadline: number): Promise<void> {
  do {
    let exactMatches = 0;
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      const labels = frame.locator(".kernel-action-view-item .kernel-label:visible");
      const count = Math.min(await labels.count().catch(() => 0), 16);
      for (let index = 0; index < count; index += 1) {
        const label = (
          await labels
            .nth(index)
            .innerText()
            .catch(() => "")
        ).trim();
        if (isComparisonKernelLabel(label)) {
          exactMatches += 1;
        }
      }
    }
    if (exactMatches === 1) return;
    assert.ok(exactMatches < 2, `The workbench exposed duplicate ${JSON.stringify(COMPARISON_KERNEL_LABEL)} labels.`);
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`The workbench did not confirm selected kernel ${JSON.stringify(COMPARISON_KERNEL_LABEL)}.`);
}

async function selectComparisonKernel(page: Page, captured: CapturedNotebook, deadline: number): Promise<void> {
  const jupyter = vscode.extensions.getExtension("ms-toolsai.jupyter");
  assert.ok(jupyter, "The pinned Jupyter extension is not installed for the comparison trial.");
  await beforePreActionDeadline(
    jupyter.activate(),
    deadline,
    `Timed out activating Jupyter before selecting ${JSON.stringify(COMPARISON_KERNEL_LABEL)}.`
  );
  assert.equal(captured.editor.notebook, captured.notebook, "Jupyter activation changed the measured notebook editor.");
  assert.equal(
    vscode.window.activeNotebookEditor,
    captured.editor,
    "The measured notebook is not active for kernel selection."
  );

  type SelectionState = { kind: "pending" } | { kind: "fulfilled" } | { kind: "rejected"; error: unknown };
  let selectionState: SelectionState = { kind: "pending" };
  const readSelectionState = (): SelectionState => selectionState;
  const selection = Promise.resolve(
    vscode.commands.executeCommand("notebook.selectKernel", { notebookEditor: captured.editor })
  ).then(
    () => (selectionState = { kind: "fulfilled" }),
    (error: unknown) => (selectionState = { kind: "rejected", error })
  );
  const traversed = new Set<string>();
  let filterForTarget = false;
  try {
    do {
      const currentSelectionState = readSelectionState();
      if (currentSelectionState.kind === "rejected") throw currentSelectionState.error;
      const quickInput = await visibleQuickInput(page);
      if (!quickInput) {
        if (currentSelectionState.kind === "fulfilled") {
          await waitForComparisonKernelLabel(page, deadline);
          recordProgress("comparison:kernel-selected");
          return;
        }
        await page.waitForTimeout(50);
        continue;
      }
      const target = await comparisonKernelQuickPickRow(quickInput);
      if (target) {
        await beforePreActionDeadline(
          target.click(),
          deadline,
          `Timed out selecting ${JSON.stringify(COMPARISON_KERNEL_LABEL)}.`
        );
        const outcome = await beforePreActionDeadline(
          selection,
          deadline,
          "Timed out applying the comparison kernel selection."
        );
        if (outcome.kind === "rejected") throw outcome.error;
        assert.equal(
          captured.editor.notebook,
          captured.notebook,
          "Kernel selection changed the measured notebook editor."
        );
        await waitForComparisonKernelLabel(page, deadline);
        recordProgress("comparison:kernel-selected");
        return;
      }

      if (filterForTarget) {
        const stillOnProviderRoute = await Promise.all(
          COMPARISON_KERNEL_PROVIDER_ROUTES.map((route) => exactQuickPickRow(quickInput, route))
        );
        if (!stillOnProviderRoute.some(Boolean)) {
          const input = quickInput.locator(".quick-input-box input:visible").first();
          if ((await input.count().catch(() => 0)) > 0) {
            await input.fill(COMPARISON_KERNEL_LABEL);
            filterForTarget = false;
            await page.waitForTimeout(100);
            continue;
          }
        }
      }

      let advanced = false;
      for (const route of COMPARISON_KERNEL_ROUTES) {
        if (traversed.has(route)) continue;
        const row = await exactQuickPickRow(quickInput, route);
        if (!row) continue;
        traversed.add(route);
        await row.click();
        filterForTarget = COMPARISON_KERNEL_PROVIDER_ROUTES.includes(route);
        await page.waitForTimeout(100);
        advanced = true;
        break;
      }
      if (!advanced) await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    throw new Error(
      `Timed out selecting ${COMPARISON_KERNEL_LABEL}. Visible options: ${JSON.stringify(await quickPickLabels(page))}`
    );
  } catch (error) {
    const quickInput = await visibleQuickInput(page);
    await quickInput?.press("Escape").catch(() => undefined);
    await Promise.race([selection, page.waitForTimeout(1_000)]);
    throw error;
  }
}

async function activateComparisonProduct(product: Product, deadline: number): Promise<void> {
  const extension = vscode.extensions.getExtension(PRODUCT_EXTENSION_IDS[product]);
  assert.ok(extension, `The ${product} comparison extension is not installed.`);
  await beforePreActionDeadline(
    extension.activate(),
    deadline,
    `Timed out activating the ${product} comparison extension.`
  );
}

function settlePromise<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );
}

function outcomeValue<T>(outcome: PromiseOutcome<T>): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function allowComparisonKernelAccess(
  page: Page,
  product: Product,
  signal: AbortSignal,
  deadline: number
): Promise<boolean> {
  const message =
    product === "open-wrangler"
      ? "Do you want to grant Kernel access to the extension Open Wrangler (Matt17BR.openwrangler)?"
      : "Do you want to grant Kernel access to the extension Data Wrangler (ms-toolsai.datawrangler)?";
  let match: { readonly dialog: Locator; readonly frame: Frame } | undefined;
  do {
    if (signal.aborted) {
      recordProgress(`comparison:kernel-access-not-requested:${product}`);
      return false;
    }
    const matches: Array<{ readonly dialog: Locator; readonly frame: Frame }> = [];
    let visibleDialogCount = 0;
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      visibleDialogCount += Math.min(
        await frame
          .locator(".monaco-dialog-box:visible")
          .count()
          .catch(() => 0),
        2
      );
      const dialogs = frame.locator(".monaco-dialog-box:visible").filter({ hasText: message });
      const count = Math.min(await dialogs.count().catch(() => 0), 2);
      for (let index = 0; index < count; index += 1) {
        const dialog = dialogs.nth(index);
        if (await dialog.isVisible().catch(() => false)) matches.push({ dialog, frame });
      }
    }
    assert.ok(matches.length < 2, "Jupyter displayed duplicate comparison kernel-access dialogs.");
    match = matches[0];
    if (match) break;
    assert.equal(visibleDialogCount, 0, "An unexpected dialog blocked the comparison notebook.");
    await page.waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  if (!match) {
    recordProgress(`comparison:kernel-access-not-requested:${product}`);
    return false;
  }
  if (signal.aborted) {
    recordProgress(`comparison:kernel-access-not-requested:${product}`);
    return false;
  }
  const text = (await match.dialog.innerText()).replace(/\s+/gu, " ").trim();
  assert.ok(text.includes(message), "The Jupyter kernel-access prompt did not name the expected product.");
  assert.ok(text.includes(KERNEL_ACCESS_DETAIL), "The Jupyter kernel-access prompt did not explain execution access.");
  for (const name of ["Deny", "Learn more", "Cancel", "Allow"]) {
    assert.equal(
      await match.dialog.getByRole("button", { name, exact: true }).count(),
      1,
      `The Jupyter kernel-access prompt must expose one ${name} action.`
    );
  }
  const allow = match.dialog.getByRole("button", { name: "Allow", exact: true });
  if (signal.aborted) {
    recordProgress(`comparison:kernel-access-not-requested:${product}`);
    return false;
  }
  await beforePreActionDeadline(
    clickTarget(locatorTarget(allow, match.frame, "Allow"), () => undefined),
    deadline,
    `Timed out allowing ${product} kernel access.`
  );
  do {
    if (!(await match.dialog.isVisible().catch(() => false))) {
      recordProgress(`comparison:kernel-access-allowed:${product}`);
      return true;
    }
    await page.waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  throw new Error(`Jupyter did not close the ${product} kernel-access prompt after Allow.`);
}

async function findDataWranglerViewDataAction(page: Page, deadline: number): Promise<PointerTarget> {
  const toolbarSelector =
    ".notebook-editor:visible .notebook-toolbar-container:visible, " +
    ".notebookOverlay:visible .notebook-toolbar-container:visible";
  let overflowOpened = false;
  do {
    const matches: PointerTarget[] = [];
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      const toolbars = frame.locator(toolbarSelector);
      const toolbarCount = Math.min(await toolbars.count().catch(() => 0), 4);
      for (let toolbarIndex = 0; toolbarIndex < toolbarCount; toolbarIndex += 1) {
        const actions = toolbars
          .nth(toolbarIndex)
          .getByRole("button", { name: DATA_WRANGLER_VIEW_DATA_ACTION, exact: true });
        const count = Math.min(await actions.count().catch(() => 0), 4);
        for (let index = 0; index < count; index += 1) {
          const action = actions.nth(index);
          if (!(await action.isVisible().catch(() => false))) continue;
          const candidate = locatorTarget(action, frame, DATA_WRANGLER_VIEW_DATA_ACTION);
          if (await candidate.pointerReady().catch(() => false)) matches.push(candidate);
        }
      }
    }
    assert.ok(matches.length < 2, "The active notebook exposed duplicate View data toolbar actions.");
    if (matches[0]) return matches[0];

    if (!overflowOpened) {
      const overflow: Array<{ readonly action: Locator; readonly frame: Frame }> = [];
      for (const frame of comparisonFrames(page).slice(0, 64)) {
        const actions = frame.locator(toolbarSelector).getByRole("button", { name: /^More Actions(?:\.\.\.)?$/u });
        const count = Math.min(await actions.count().catch(() => 0), 4);
        for (let index = 0; index < count; index += 1) {
          const action = actions.nth(index);
          if (await action.isVisible().catch(() => false)) overflow.push({ action, frame });
        }
      }
      assert.ok(overflow.length < 2, "The active notebook exposed duplicate toolbar overflow actions.");
      if (overflow[0]) {
        await clickTarget(
          locatorTarget(overflow[0].action, overflow[0].frame, await locatorName(overflow[0].action)),
          () => undefined
        );
        overflowOpened = true;
      }
    }

    if (overflowOpened) {
      const menuMatches: PointerTarget[] = [];
      for (const frame of comparisonFrames(page).slice(0, 64)) {
        const items = frame
          .locator(".context-view.monaco-menu-container:visible")
          .getByRole("menuitem", { name: DATA_WRANGLER_VIEW_DATA_ACTION, exact: true });
        const count = Math.min(await items.count().catch(() => 0), 4);
        for (let index = 0; index < count; index += 1) {
          const item = items.nth(index);
          if (!(await item.isVisible().catch(() => false))) continue;
          const candidate = locatorTarget(item, frame, DATA_WRANGLER_VIEW_DATA_ACTION);
          if (await candidate.pointerReady().catch(() => false)) menuMatches.push(candidate);
        }
      }
      assert.ok(menuMatches.length < 2, "The notebook overflow exposed duplicate View data menu actions.");
      if (menuMatches[0]) return menuMatches[0];
    }
    await page.waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  throw new Error("The notebook toolbar did not expose its public View data action.");
}

async function authorizeDataWranglerFromNotebookToolbar(
  page: Page,
  captured: CapturedNotebook,
  access: Promise<PromiseOutcome<boolean>>,
  deadline: number
): Promise<void> {
  assert.equal(vscode.window.activeNotebookEditor, captured.editor, "The comparison notebook is not active.");
  const target = await findDataWranglerViewDataAction(page, deadline);
  const baselineTabs = Object.freeze([...allEditorTabs()]);
  try {
    await beforePreActionDeadline(
      clickTarget(target, () => undefined),
      deadline,
      "Timed out opening Data Wrangler's variable picker."
    );
    assert.equal(
      outcomeValue(await beforePreActionDeadline(access, deadline, "Timed out granting Data Wrangler kernel access.")),
      true,
      "Data Wrangler did not receive first-use Jupyter kernel access."
    );
    do {
      const opened = comparisonTabsOpenedAfter(baselineTabs, allEditorTabs());
      assert.equal(opened.length, 0, "View data opened a product editor before a variable was selected.");
      const quickInput = await visibleQuickInput(page);
      if (quickInput) {
        const bootstrap = await exactQuickPickRow(quickInput, COMPARISON_BOOTSTRAP_VARIABLE);
        if (bootstrap) {
          const input = quickInput.locator(".quick-input-box input:visible");
          assert.equal(await input.count(), 1, "View data must expose one variable-picker input.");
          await input.press("Escape");
          while ((await visibleQuickInput(page)) && Date.now() < deadline) {
            await page.waitForTimeout(POLL_MS);
          }
          assert.equal(await visibleQuickInput(page), undefined, "The View data variable picker did not close.");
          assert.equal(
            vscode.window.activeNotebookEditor,
            captured.editor,
            "The View data permission setup replaced the comparison notebook editor."
          );
          selectNotebookCell(captured, captured.cell);
          return;
        }
      }
      await page.waitForTimeout(POLL_MS);
    } while (Date.now() < deadline);
    throw new Error(
      `View data did not expose the bootstrap variable picker. Visible options: ${JSON.stringify(
        await quickPickLabels(page)
      )}`
    );
  } finally {
    await target.dispose();
  }
}

async function locatorName(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelled = labelledBy
      ? labelledBy
          .split(/\s+/u)
          .map((id: string) => element.ownerDocument.getElementById(id)?.textContent ?? "")
          .join(" ")
      : "";
    return (
      element.getAttribute("aria-label") ||
      labelled ||
      element.textContent ||
      element.getAttribute("title") ||
      ""
    )
      .replace(/\s+/gu, " ")
      .trim();
  });
}

function locatorTarget(locator: Locator, frame: Frame, accessibleName: string): PointerTarget {
  return {
    accessibleName,
    page: frame.page(),
    pointerReady: async () => {
      if ((await locatorName(locator)) !== accessibleName) return false;
      await locator.click({ trial: true, timeout: 1_000 });
      return true;
    },
    click: () => locator.click({ timeout: 1_000 }),
    inlineReady: (input) => locator.evaluate(observeInlinePreviewReady, input),
    dispose: async () => undefined
  };
}

function elementTarget(element: ElementHandle<unknown>, frame: Frame, accessibleName: string): PointerTarget {
  return {
    accessibleName,
    page: frame.page(),
    pointerReady: () => element.evaluate(observePointerReady, accessibleName),
    click: async () => {
      const box = await element.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0, "Public renderer action lost its visible geometry.");
      await frame.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
    inlineReady: (input) => element.evaluate(observeInlinePreviewReady, input),
    dispose: () => element.dispose()
  };
}

/** Product-neutral stable pointer observation used through Playwright. */
export function observePointerReady(elementValue: unknown, expectedName: string): Promise<boolean> {
  type Candidate = {
    readonly isConnected: boolean;
    readonly disabled?: boolean;
    readonly ownerDocument: {
      readonly defaultView: {
        clearTimeout(handle: number): void;
        requestAnimationFrame(callback: () => void): number;
        setTimeout(callback: () => void, milliseconds: number): number;
        getComputedStyle(value: unknown): {
          readonly display: string;
          readonly visibility: string;
          readonly opacity: string;
        };
      } | null;
      elementFromPoint(x: number, y: number): unknown;
      getElementById(id: string): { readonly textContent: string | null } | null;
    };
    readonly parentElement: Candidate | null;
    readonly textContent: string | null;
    contains(value: unknown): boolean;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): {
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
    };
  };
  const element = elementValue as Candidate;
  const window_ = element?.ownerDocument?.defaultView;
  if (!element?.isConnected || !window_ || element.disabled || element.getAttribute("aria-disabled") === "true") {
    return Promise.resolve(false);
  }
  const ownerWindow = window_;
  const labelledBy = element.getAttribute("aria-labelledby");
  const labelled = labelledBy
    ? labelledBy
        .split(/\s+/u)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" ")
    : "";
  const name = (
    element.getAttribute("aria-label") ||
    labelled ||
    element.textContent ||
    element.getAttribute("title") ||
    ""
  )
    .replace(/\s+/gu, " ")
    .trim();
  if (name !== expectedName) return Promise.resolve(false);
  let ancestor: Candidate | null = element;
  while (ancestor) {
    const style = ownerWindow.getComputedStyle(ancestor);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
      return Promise.resolve(false);
    ancestor = ancestor.parentElement;
  }
  const before = element.getBoundingClientRect();
  if (before.width <= 0 || before.height <= 0) return Promise.resolve(false);
  const hit = element.ownerDocument.elementFromPoint(before.left + before.width / 2, before.top + before.height / 2);
  if (hit !== element && !element.contains(hit)) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let settled = false;
    const fallback = ownerWindow.setTimeout(finish, 100);
    function finish(): void {
      if (settled) return;
      settled = true;
      ownerWindow.clearTimeout(fallback);
      const after = element.getBoundingClientRect();
      resolvePromise(
        element.isConnected &&
          before.left === after.left &&
          before.top === after.top &&
          before.width === after.width &&
          before.height === after.height
      );
    }
    ownerWindow.requestAnimationFrame(() => {
      ownerWindow.requestAnimationFrame(() => {
        finish();
      });
    });
  });
}

export async function clickComparisonPointerTarget(
  target: Pick<PointerTarget, "accessibleName" | "pointerReady" | "click">,
  beforeClick: () => void
): Promise<ActionEvidence> {
  const ready = await target.pointerReady();
  assert.equal(ready, true, `Public action ${JSON.stringify(target.accessibleName)} was not pointer-ready.`);
  beforeClick();
  await target.click();
  return Object.freeze({ accessibleName: target.accessibleName, unique: true, pointer: true });
}

const clickTarget = clickComparisonPointerTarget;

function selectNotebookCell(captured: CapturedNotebook, cell: vscode.NotebookCell): void {
  assert.equal(cell.notebook, captured.notebook, "The comparison cell no longer belongs to its captured notebook.");
  const selection = new vscode.NotebookRange(cell.index, cell.index + 1);
  captured.editor.selection = selection;
  captured.editor.selections = [selection];
  captured.editor.revealRange(selection, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
}

function executionSummaryFingerprint(cell: vscode.NotebookCell): string {
  const summary = cell.executionSummary;
  if (!summary) return "none";
  return [
    summary.executionOrder ?? "",
    summary.success ?? "",
    summary.timing?.startTime ?? "",
    summary.timing?.endTime ?? ""
  ].join(":");
}

export function comparisonSetupExecutionOutcome(
  summary: Pick<vscode.NotebookCellExecutionSummary, "success" | "timing"> | undefined,
  changed: boolean
): "pending" | "success" | "failure" {
  if (!changed || !summary) return "pending";
  if (summary.success === false) return "failure";
  if (summary.success === true) return "success";
  const endTime = summary.timing?.endTime;
  return typeof endTime === "number" && Number.isFinite(endTime) ? "success" : "pending";
}

async function findRunCellTarget(
  page: Page,
  captured: CapturedNotebook,
  cell: vscode.NotebookCell,
  deadline: number
): Promise<PointerTarget> {
  const visibleEditors = vscode.window.visibleNotebookEditors;
  assert.equal(visibleEditors.length, 1, "The comparison trial must have exactly one visible notebook editor.");
  assert.equal(visibleEditors[0], captured.editor, "The comparison notebook changed its visible editor.");
  assert.equal(vscode.window.activeNotebookEditor, captured.editor, "The comparison notebook is not active.");
  selectNotebookCell(captured, cell);
  const expectedPosition = cell.index + 1;
  const markerName = `Cell ${expectedPosition} of ${captured.notebook.cellCount}`;
  const rowSelector =
    `.notebookOverlay .cell-list-container .monaco-list-rows > ` +
    `.monaco-list-row.code-cell-row[data-index="${cell.index}"]`;
  const executeCellName = /^Execute Cell(?: \([^\r\n]{1,64}\))?$/u;
  do {
    const rowMatches: Array<{ readonly row: Locator; readonly frame: Frame }> = [];
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      const rows = frame.locator(rowSelector);
      const count = Math.min(await rows.count().catch(() => 0), 4);
      for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        if (!(await row.isVisible().catch(() => false))) continue;
        rowMatches.push({ row, frame });
      }
    }
    assert.ok(rowMatches.length < 2, `The workbench exposed duplicate rows for ${JSON.stringify(markerName)}.`);
    const matches: PointerTarget[] = [];
    const rowMatch = rowMatches[0];
    if (rowMatch) {
      await rowMatch.row.scrollIntoViewIfNeeded();
      await rowMatch.row.hover({ force: true });
      const actions = rowMatch.row.locator(
        '.cell.code > .run-button-container button, .cell.code > .run-button-container [role="button"]'
      );
      const actionCount = Math.min(await actions.count().catch(() => 0), 4);
      for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
        const action = actions.nth(actionIndex);
        if (!(await action.isVisible().catch(() => false))) continue;
        const name = await locatorName(action);
        if (!executeCellName.test(name)) continue;
        matches.push(locatorTarget(action, rowMatch.frame, name));
      }
    }
    assert.ok(matches.length < 2, `The selected comparison cell exposed duplicate Execute Cell actions.`);
    if (rowMatches.length === 1 && matches.length === 1) {
      assert.equal(vscode.window.activeNotebookEditor, captured.editor, "The comparison notebook lost focus.");
      return matches[0]!;
    }
    await page.waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  let visibleRowCount = 0;
  let visibleRunActionCount = 0;
  let visibleDialogCount = 0;
  for (const frame of comparisonFrames(page).slice(0, 64)) {
    visibleDialogCount += Math.min(
      await frame
        .locator('[role="dialog"]:visible, .monaco-dialog-box:visible')
        .count()
        .catch(() => 0),
      4
    );
    visibleRowCount += Math.min(
      await frame
        .locator(`${rowSelector}:visible`)
        .count()
        .catch(() => 0),
      4
    );
    const actions = frame.locator(
      `${rowSelector} .cell.code > .run-button-container button:visible, ` +
        `${rowSelector} .cell.code > .run-button-container [role="button"]:visible`
    );
    const actionCount = Math.min(await actions.count().catch(() => 0), 4);
    for (let index = 0; index < actionCount; index += 1) {
      if (executeCellName.test(await locatorName(actions.nth(index)).catch(() => ""))) visibleRunActionCount += 1;
    }
  }
  throw new Error(
    `The selected comparison cell did not expose one public Execute Cell action. ` +
      `Expected ${JSON.stringify(markerName)} at row index ${cell.index}; observed ` +
      `${visibleRowCount} matching rows, ${visibleRunActionCount} matching run actions, and ${visibleDialogCount} dialogs.`
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function integerProfileTextReady(input: {
  readonly column: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly text: string;
}): boolean {
  if (!/^c\d{2}$/u.test(input.column) || !Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum)) {
    return false;
  }
  const text = input.text
    .replace(/\u2212/gu, "-")
    .replace(/[,_]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const displayedMetric = (label: "min" | "max", value: number): boolean => {
    const match = new RegExp(
      `\\b(?:${label}|${label === "min" ? "minimum" : "maximum"})\\s*[:=]?\\s*` +
        `([-+]?(?:(?:\\d(?:[\\d ]*\\d)?)(?:\\.\\d+)?|\\.\\d+)(?:e[-+]?\\d+)?)([kmb]?)(?![\\d.\\p{L}])`,
      "iu"
    ).exec(text);
    if (!match?.[1]) return false;
    const token = match[1].replace(/\s/gu, "");
    const suffix = (match[2] ?? "").toLowerCase();
    const scale = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
    const displayed = Number(token) * scale;
    if (!Number.isFinite(displayed)) return false;
    if (suffix === "") return displayed === value;
    const decimalPlaces = token.match(/\.(\d+)/u)?.[1]?.length ?? 0;
    return Math.abs(displayed - value) <= (scale / 2) * 10 ** -decimalPlaces;
  };
  return (
    new RegExp(`(?:^|\\b)${input.column}(?:\\b|[,;:()\\[\\]{}-])`, "u").test(text) &&
    !/\b(?:loading|profiling|calculating|pending)\b/iu.test(text) &&
    /\b(?:missing|null(?:s| values?)?)\s*[:=]?\s*0(?:\b|%)/iu.test(text) &&
    /\b(?:distinct|unique)\b/iu.test(text) &&
    displayedMetric("min", input.minimum) &&
    displayedMetric("max", input.maximum)
  );
}

async function discoverInlineTarget(page: Page, request: ComparisonTrialRequest): Promise<PointerTarget | undefined> {
  const matches: PointerTarget[] = [];
  if (request.product === "open-wrangler") {
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      let handle;
      try {
        handle = await frame.evaluateHandle(findExactActiveNotebookRendererButton, {
          expectedLabel: request.cell.variableName,
          expectedButtonName: "Open in Open Wrangler"
        });
        const element = handle.asElement() as ElementHandle<unknown> | null;
        if (!element) {
          await handle.dispose();
          continue;
        }
        const target = elementTarget(element, frame, "Open in Open Wrangler");
        if (
          (await target.pointerReady().catch(() => false)) &&
          (await target
            .inlineReady({
              actionName: target.accessibleName,
              firstColumn: "c00",
              secondColumn: "c01"
            })
            .catch(() => false))
        ) {
          matches.push(target);
        } else {
          await target.dispose();
        }
      } catch {
        await handle?.dispose().catch(() => undefined);
      }
    }
  } else {
    const actionPattern = /^Open(?: in)? Data Wrangler$/u;
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      let handle;
      try {
        handle = await frame.evaluateHandle(findExactActiveNotebookPreviewButton, {
          expectedButtonNames: ["Open Data Wrangler", "Open in Data Wrangler"],
          requiredLabels: ["c00", "c01", "0", "1"]
        });
        const element = handle.asElement() as ElementHandle<unknown> | null;
        if (!element) {
          await handle.dispose();
          continue;
        }
        const name = await element.evaluate((value) => {
          const element = value as {
            readonly ownerDocument: { getElementById(id: string): { readonly textContent: string | null } | null };
            readonly textContent: string | null;
            getAttribute(name: string): string | null;
          };
          const labelledBy = element.getAttribute("aria-labelledby");
          const labelled = labelledBy
            ? labelledBy
                .split(/\s+/u)
                .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
                .join(" ")
            : "";
          return (
            element.getAttribute("aria-label") ||
            labelled ||
            element.textContent ||
            element.getAttribute("title") ||
            ""
          )
            .replace(/\s+/gu, " ")
            .trim();
        });
        const target = elementTarget(element, frame, name);
        if (
          actionPattern.test(name) &&
          (await target.pointerReady().catch(() => false)) &&
          (await target.inlineReady({ actionName: name, firstColumn: "c00", secondColumn: "c01" }).catch(() => false))
        ) {
          matches.push(target);
          handle = undefined;
        } else {
          await target.dispose();
          handle = undefined;
        }
      } finally {
        await handle?.dispose().catch(() => undefined);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      await Promise.allSettled(matches.map((target) => target.dispose()));
      throw new Error("The measured output exposed more than one active renderer launch action.");
    }
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      const buttons = frame.locator('button:visible, [role="button"]:visible');
      const count = Math.min(await buttons.count().catch(() => 0), 128);
      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (!(await button.isVisible().catch(() => false))) continue;
        const name = await locatorName(button);
        if (!actionPattern.test(name)) continue;
        const target = locatorTarget(button, frame, name);
        if (
          (await target.pointerReady().catch(() => false)) &&
          (await target.inlineReady({ actionName: name, firstColumn: "c00", secondColumn: "c01" }).catch(() => false))
        ) {
          matches.push(target);
        }
      }
    }
  }
  if (matches.length > 1) {
    await Promise.allSettled(matches.map((target) => target.dispose()));
    throw new Error("The measured output exposed more than one matching public launch action.");
  }
  return matches[0];
}

async function waitForInlineTarget(
  page: Page,
  request: ComparisonTrialRequest,
  cell: vscode.NotebookCell,
  freshExecution: () => boolean,
  deadline: number
): Promise<PointerTarget> {
  do {
    if (freshExecution() && cell.executionSummary?.success === false) {
      throw new Error("The measured notebook cell failed.");
    }
    const target = await discoverInlineTarget(page, request);
    if (target && freshExecution() && cell.executionSummary?.success === true) return target;
    await target?.dispose();
    await page.waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  const mimeTypes = new Set(cell.outputs.flatMap((output) => output.items.map((item) => item.mime)));
  let wranglerActionCount = 0;
  let exactActionCount = 0;
  let genericActionCount = 0;
  let exactRoleCount = 0;
  let exactRoleVisibleCount = 0;
  let exactRolePointerCount = 0;
  let exactRoleInlineCount = 0;
  let exactCssPointerCount = 0;
  let exactCssInlineCount = 0;
  const wranglerActionSignatures: Array<readonly [number, number]> = [];
  const exactAction = /^Open(?: in)? Data Wrangler$/u;
  for (const frame of comparisonFrames(page).slice(0, 64)) {
    const buttons = frame.locator('button:visible, [role="button"]:visible');
    const count = Math.min(await buttons.count().catch(() => 0), 128);
    for (let index = 0; index < count; index += 1) {
      const name = await locatorName(buttons.nth(index)).catch(() => "");
      if (/wrangler/iu.test(name)) {
        wranglerActionCount += 1;
        if (wranglerActionSignatures.length < 16) {
          const bitmask =
            (/\bopen\b/iu.test(name) ? 1 : 0) |
            (/\bdata\b/iu.test(name) ? 2 : 0) |
            (/\bwrangler\b/iu.test(name) ? 4 : 0) |
            (/\bin\b/iu.test(name) ? 8 : 0) |
            (/\bview\b/iu.test(name) ? 16 : 0) |
            (name.includes(request.cell.variableName) ? 32 : 0) |
            (/['"‘’“”]/u.test(name) ? 64 : 0);
          wranglerActionSignatures.push([name.length, bitmask]);
        }
      }
      if (exactAction.test(name)) {
        exactActionCount += 1;
        const target = locatorTarget(buttons.nth(index), frame, name);
        if (await target.pointerReady().catch(() => false)) exactCssPointerCount += 1;
        if (
          await target.inlineReady({ actionName: name, firstColumn: "c00", secondColumn: "c01" }).catch(() => false)
        ) {
          exactCssInlineCount += 1;
        }
      }
      if (exactAction.test(name)) genericActionCount += 1;
    }
    const exactRoleButtons = frame.getByRole("button", { name: exactAction });
    const exactRoleButtonCount = Math.min(await exactRoleButtons.count().catch(() => 0), 8);
    exactRoleCount += exactRoleButtonCount;
    for (let index = 0; index < exactRoleButtonCount; index += 1) {
      const button = exactRoleButtons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      exactRoleVisibleCount += 1;
      const resolvedName = await locatorName(button).catch(() => "");
      const target = locatorTarget(button, frame, resolvedName);
      if (await target.pointerReady().catch(() => false)) exactRolePointerCount += 1;
      if (
        await target
          .inlineReady({ actionName: resolvedName, firstColumn: "c00", secondColumn: "c01" })
          .catch(() => false)
      ) {
        exactRoleInlineCount += 1;
      }
    }
  }
  throw new JourneyTimeout(
    "inline-preview",
    `Timed out waiting for the executed cell's public dataframe preview. ` +
      `Execution success ${String(cell.executionSummary?.success)} order ${String(cell.executionSummary?.executionOrder)}. ` +
      `Outputs ${cell.outputs.length} MIME types ${JSON.stringify([...mimeTypes].sort())} ` +
      `HTML ${String(mimeTypes.has("text/html"))} ` +
      `plain text ${String(mimeTypes.has("text/plain"))}. Wrangler actions ${wranglerActionCount} ` +
      `exact ${exactActionCount} generic ${genericActionCount} role ${exactRoleCount} visible ${exactRoleVisibleCount} ` +
      `pointer ${exactRolePointerCount} inline ${exactRoleInlineCount} cssPointer ${exactCssPointerCount} ` +
      `cssInline ${exactCssInlineCount} signatures ${JSON.stringify(wranglerActionSignatures)}.`
  );
}

/** Closure-free full-shape fallback for grids that omit ARIA counts. */
export function observeVisibleFullShape(input: { readonly rows: number; readonly columns: number }): boolean {
  const runtime = globalThis as unknown as {
    readonly document: {
      querySelectorAll(selector: string): ArrayLike<{
        readonly isConnected: boolean;
        readonly textContent: string | null;
        getAttribute(name: string): string | null;
        getBoundingClientRect(): { readonly width: number; readonly height: number };
      }>;
    };
  };
  const rows = String(input.rows);
  const columns = String(input.columns);
  return Array.from(runtime.document.querySelectorAll('[aria-label], [role="status"], [role="note"], header, footer'))
    .slice(0, 512)
    .some((element) => {
      const box = element.getBoundingClientRect();
      if (!element.isConnected || box.width <= 0 || box.height <= 0) return false;
      const text = (element.getAttribute("aria-label") || element.textContent || "")
        .replace(/[,_]/gu, "")
        .replace(/\s+/gu, " ")
        .toLowerCase();
      return (
        new RegExp(`\\b${rows} rows?\\b[\\s\\S]{0,80}\\b${columns} columns?\\b`, "u").test(text) ||
        new RegExp(`\\brows?\\s*[:=]?\\s*${rows}\\b[\\s\\S]{0,80}\\bcolumns?\\s*[:=]?\\s*${columns}\\b`, "u").test(text)
      );
    });
}

export function comparisonAriaCountsMatch(input: {
  readonly rows: number;
  readonly columns: number;
  readonly ariaRowCount: number | null;
  readonly ariaColumnCount: number | null;
}): boolean {
  const rowMatches = input.ariaRowCount === input.rows || input.ariaRowCount === input.rows + 1;
  const columnMatches = input.ariaColumnCount === input.columns || input.ariaColumnCount === input.columns + 1;
  return rowMatches && columnMatches;
}

async function findExactButton(frame: Frame, name: string, deadline: number): Promise<PointerTarget> {
  do {
    const buttons = frame.getByRole("button", { name, exact: true });
    const matches: Locator[] = [];
    const count = Math.min(await buttons.count().catch(() => 0), 8);
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      if (
        (await button.isVisible().catch(() => false)) &&
        (await button.evaluate(observePointerReady, name).catch(() => false))
      ) {
        matches.push(button);
      }
    }
    assert.ok(matches.length <= 1, `The grid exposed duplicate ${JSON.stringify(name)} actions.`);
    if (matches[0]) return locatorTarget(matches[0], frame, name);
    await frame.page().waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  throw new Error(`The grid did not expose ${JSON.stringify(name)}.`);
}

async function visibleColumnHeader(frame: Frame, column: string): Promise<Locator | undefined> {
  const boundary = "[,;:()\\[\\]{}\\u2013\\u2014#|\\-]";
  const pattern = new RegExp(`(?:^|\\s|${boundary})${escapeRegex(column)}(?:$|\\s|${boundary})`, "u");
  const headers = frame.getByRole("columnheader", { name: pattern });
  const matches: Locator[] = [];
  const count = Math.min(await headers.count().catch(() => 0), 16);
  for (let index = 0; index < count; index += 1) {
    const header = headers.nth(index);
    if (!(await header.isVisible().catch(() => false))) continue;
    const name = await locatorName(header);
    if (await header.evaluate(observePointerReady, name).catch(() => false)) matches.push(header);
  }
  assert.ok(matches.length <= 1, `The grid exposed duplicate visible ${column} column headers.`);
  return matches[0];
}

async function gridRoot(frame: Frame): Promise<Locator> {
  const roots = frame.locator('[role="grid"], [role="table"], table');
  const matches: Locator[] = [];
  const count = Math.min(await roots.count().catch(() => 0), 64);
  for (let index = 0; index < count; index += 1) {
    const root = roots.nth(index);
    if (!(await root.isVisible().catch(() => false))) continue;
    const hasCanonicalHeaders = await root
      .evaluate((element) => {
        type Header = {
          readonly textContent: string | null;
          getAttribute(name: string): string | null;
          querySelectorAll(selector: string): ArrayLike<Header>;
        };
        const normalize = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
        const headers = Array.from(element.querySelectorAll('[role="columnheader"], th')) as Header[];
        const matches = (header: Header): boolean => {
          const boundary = "[,;:()\\[\\]{}\\u2013\\u2014#|+-]";
          const pattern = new RegExp(`(?:^|\\s|${boundary})c\\d{2}(?:$|\\s|${boundary})`, "u");
          if (
            pattern.test(normalize(header.getAttribute("aria-label"))) ||
            pattern.test(normalize(header.textContent))
          ) {
            return true;
          }
          return Array.from(header.querySelectorAll("*"))
            .slice(0, 256)
            .some((child) => /^c\d{2}$/u.test(normalize(child.textContent)));
        };
        return headers.some(matches);
      })
      .catch(() => false);
    if (hasCanonicalHeaders) matches.push(root);
  }
  assert.equal(matches.length, 1, "The product must expose one canonical dataframe grid.");
  return matches[0]!;
}

async function revealColumnHeader(frame: Frame, column: string, deadline: number): Promise<Locator> {
  do {
    const header = await visibleColumnHeader(frame, column);
    if (header) return header;
    const root = await gridRoot(frame);
    const box = await root.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, "The dataframe grid lost its geometry.");
    await frame.page().mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120));
    await frame.page().mouse.wheel(Math.max(300, Math.round(box.width * 0.7)), 0);
    await frame.page().waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  throw new JourneyTimeout("profile-all", `Timed out revealing profile column ${column}.`);
}

async function clickColumnForProfile(
  frame: Frame,
  index: number,
  deadline: number,
  beforeClick?: () => void
): Promise<ActionEvidence> {
  const column = `c${String(index).padStart(2, "0")}`;
  const header = await revealColumnHeader(frame, column, deadline);
  const name = await locatorName(header);
  const evidence = await clickTarget(locatorTarget(header, frame, name), beforeClick ?? (() => undefined));
  return Object.freeze({ ...evidence, accessibleName: column });
}

async function selectOpenWranglerProfileColumn(frame: Frame, column: string, deadline: number): Promise<void> {
  const search = frame.getByRole("combobox", { name: "Column", exact: true });
  const optionName = new RegExp(`^${escapeRegex(column)}, [^,]{1,40} column$`, "u");
  do {
    if ((await search.count().catch(() => 0)) === 1 && (await search.isVisible().catch(() => false))) {
      await search.fill(column);
      const option = frame.getByRole("option", { name: optionName });
      if ((await option.count().catch(() => 0)) === 1 && (await option.isVisible().catch(() => false))) {
        await search.press("Enter");
        return;
      }
    }
    await frame.page().waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  throw new JourneyTimeout("profile-all", `Timed out selecting Open Wrangler profile column ${column}.`);
}

async function waitForProfile(
  page: Page,
  column: string,
  minimum: number,
  maximum: number,
  deadline: number,
  stage: FailureStage
): Promise<Frame> {
  do {
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      const header = await visibleColumnHeader(frame, column).catch(() => undefined);
      if (!header) continue;
      const [name, text] = await Promise.all([locatorName(header).catch(() => ""), header.innerText().catch(() => "")]);
      if (integerProfileTextReady({ column, minimum, maximum, text: `${name} ${text}` })) {
        return frame;
      }
    }
    await page.waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  throw new JourneyTimeout(stage, `Timed out waiting for the completed public profile for ${column}.`);
}

async function waitForOpenWranglerProfile(
  frame: Frame,
  column: string,
  deadline: number,
  stage: FailureStage
): Promise<void> {
  const drawer = frame.getByRole("complementary", { name: "Column profiles and filters", exact: true });
  do {
    if ((await drawer.count().catch(() => 0)) === 1 && (await drawer.isVisible().catch(() => false))) {
      const heading = drawer.getByRole("heading", { name: column, exact: true });
      const complete = await drawer
        .evaluate((element) => {
          const text = (element.textContent ?? "").replace(/\s+/gu, " ");
          return (
            !/Preparing column summary|Profiling selected column/iu.test(text) &&
            ["Exact statistics", "Rows", "Null", "Distinct", "Min", "Max"].every((label) => text.includes(label))
          );
        })
        .catch(() => false);
      if ((await heading.count().catch(() => 0)) === 1 && (await heading.isVisible().catch(() => false)) && complete) {
        return;
      }
    }
    await frame.page().waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  throw new JourneyTimeout(stage, `Timed out waiting for Open Wrangler's completed profile for ${column}.`);
}

export function boundedFailureMessage(error: unknown, request: ComparisonTrialRequest): string {
  const raw = (error instanceof Error ? error.message : String(error)).split(/\r?\n/u, 1)[0] ?? "Unknown failure.";
  return raw
    .replaceAll(request.isolatedRoot, "<isolated-root>")
    .replaceAll(request.notebookPath, "<notebook>")
    .replaceAll(request.cell.source, "<source>")
    .replaceAll(/\bfile:(?:\/+|\\+)[^\s:]+/giu, "<path>")
    .replaceAll(/(?:[A-Za-z]:)?[\\/][^\s:]+/gu, "<path>")
    .replaceAll(/(^|[^\p{L}\p{N}])~[^\s]*/gu, "$1<path>")
    .replaceAll(/(?:%[0-9A-Fa-f]{2})+[^\s]*/gu, "<encoded-path>")
    .replaceAll(/(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}\s]+\}|%[^%\s]+%)/gu, "<environment>")
    .replaceAll(/[\\/]/gu, "")
    .replaceAll(/[^\p{L}\p{N}\s,;()[\]{}'"+=-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function resultFromState(
  request: ComparisonTrialRequest,
  milestones: Milestones,
  evidence: MutableEvidence,
  failure: ComparisonTrialResult["failure"]
): ComparisonTrialResult {
  const status = failure === null ? "success" : failure.kind === "timeout" ? "timeout" : "failure";
  return Object.freeze({
    protocol: COMPARISON_TRIAL_RESULT_PROTOCOL,
    trialId: request.trialId,
    product: request.product,
    engine: request.cell.engine,
    format: request.cell.format,
    kind: request.kind,
    order: request.order,
    status,
    failure,
    metrics: Object.freeze({
      inlinePreviewMs: milestones.duration("run-cell-click", "inline-ready"),
      workbenchOpenMs: milestones.duration("launch-click", "workbench-ready"),
      firstProfileMs: milestones.duration("profile-click", "first-profile-ready"),
      completeProfileMs: milestones.duration("profile-click", "profiles-complete")
    }),
    milestones: milestones.snapshot(),
    publicUi: Object.freeze({ ...evidence })
  });
}

async function closeNewTabs(baselineTabs: readonly vscode.Tab[]): Promise<void> {
  const opened = comparisonTabsOpenedAfter(baselineTabs, allEditorTabs());
  if (opened.length > 0) await vscode.window.tabGroups.close([...opened], true);
}

async function executeWarmSetup(
  request: ComparisonTrialRequest,
  page: Page,
  captured: CapturedNotebook,
  deadline: number
): Promise<void> {
  assert.ok(captured.setupCell, "The comparison notebook omitted its untimed setup cell.");
  assert.equal(captured.editor.notebook, captured.notebook, "The untimed setup changed the captured notebook editor.");
  assert.equal(vscode.window.activeNotebookEditor, captured.editor, "The untimed setup notebook is not active.");
  const setupIndex = captured.setupCell.index;
  const measuredIndex = captured.cell.index;
  const setupSource = captured.setupCell.document.getText();
  const setupTags = notebookCellTags(captured.setupCell);
  const currentSetupCell = (): vscode.NotebookCell => {
    const cell = captured.notebook.cellAt(setupIndex);
    assert.equal(cell.index, setupIndex, "The untimed setup cell moved during the comparison journey.");
    assert.equal(
      cell.document.getText(),
      setupSource,
      "The untimed setup source changed during the comparison journey."
    );
    assert.deepEqual(
      notebookCellTags(cell),
      setupTags,
      "The untimed setup tags changed during the comparison journey."
    );
    return cell;
  };
  const setupCellBeforeDispatch = currentSetupCell();
  const summaryBeforeDispatch = executionSummaryFingerprint(setupCellBeforeDispatch);
  let freshExecution = false;
  let setupTarget: PointerTarget | undefined;
  const listener = vscode.workspace.onDidChangeNotebookDocument((event) => {
    if (event.notebook !== captured.notebook) return;
    if (event.cellChanges.some((change) => change.cell.index === setupIndex && change.executionSummary !== undefined)) {
      freshExecution = true;
    }
  });
  try {
    setupTarget = await findRunCellTarget(page, captured, setupCellBeforeDispatch, deadline);
    await beforePreActionDeadline(
      clickTarget(setupTarget, () => recordProgress(`comparison:${request.trialId}:warm-setup-dispatch`)),
      deadline,
      "Timed out clicking the untimed setup cell."
    );
    do {
      const setupCell = currentSetupCell();
      const executionChanged = freshExecution || executionSummaryFingerprint(setupCell) !== summaryBeforeDispatch;
      const outcome = comparisonSetupExecutionOutcome(setupCell.executionSummary, executionChanged);
      if (outcome === "success") {
        assert.equal(setupCell.outputs.length, 0, "The untimed setup cell must not publish dataframe output.");
        selectNotebookCell(captured, captured.notebook.cellAt(measuredIndex));
        recordProgress(`comparison:${request.trialId}:warm-setup-complete`);
        return;
      }
      if (outcome === "failure") {
        throw new Error("The untimed setup cell failed.");
      }
      await page.waitForTimeout(POLL_MS);
    } while (Date.now() < deadline);
    throw new JourneyTimeout("run-cell", "Timed out waiting for the untimed setup cell.");
  } finally {
    listener.dispose();
    await setupTarget?.dispose();
  }
}

async function executeJourney(
  request: ComparisonTrialRequest,
  page: Page,
  captured: CapturedNotebook,
  milestones: Milestones,
  evidence: MutableEvidence,
  preActionDeadline: number
): Promise<void> {
  const accessController = new AbortController();
  const access = settlePromise(
    allowComparisonKernelAccess(page, request.product, accessController.signal, preActionDeadline)
  );
  let runTarget: PointerTarget | undefined;
  let listener: vscode.Disposable | undefined;
  let inlineTarget: PointerTarget | undefined;
  let journeyError: unknown;
  let journeyFailed = false;
  try {
    await activateComparisonProduct(request.product, preActionDeadline);
    await executeWarmSetup(request, page, captured, preActionDeadline);
    if (request.product === "data-wrangler") {
      await authorizeDataWranglerFromNotebookToolbar(page, captured, access, preActionDeadline);
    } else {
      assert.equal(
        outcomeValue(
          await beforePreActionDeadline(access, preActionDeadline, "Timed out granting Open Wrangler kernel access.")
        ),
        true,
        "Open Wrangler did not receive first-use Jupyter kernel access."
      );
    }
    if (
      remainingPreActionMs(preActionDeadline, "Timed out before the memory settle window.") < request.preActionSettleMs
    ) {
      throw new JourneyTimeout("run-cell", "The shared pre-action budget cannot fit the memory settle window.");
    }
    milestones.mark("memory-settle-start");
    recordProgress(`comparison:${request.trialId}:memory-settle-start`);
    await page.waitForTimeout(request.preActionSettleMs);
    recordProgress(`comparison:${request.trialId}:memory-settle-complete`);
    const measuredCell = captured.notebook.cellAt(captured.cell.index);
    runTarget = await findRunCellTarget(page, captured, measuredCell, preActionDeadline);
    const summaryBeforeClick = executionSummaryFingerprint(measuredCell);
    let freshExecution = false;
    listener = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook !== captured.notebook) return;
      if (event.cellChanges.some((change) => change.cell === measuredCell && change.executionSummary !== undefined)) {
        freshExecution = true;
      }
    });
    evidence.runCell = await beforePreActionDeadline(
      clickTarget(runTarget, () => milestones.mark("run-cell-click")),
      preActionDeadline,
      "Timed out clicking Run Cell after setup."
    );
    recordProgress(`comparison:${request.trialId}:run-cell-click`);
    const inlineDeadline = Date.now() + request.timeoutsMs.inlinePreview;
    inlineTarget = await waitForInlineTarget(
      page,
      request,
      measuredCell,
      () => freshExecution || executionSummaryFingerprint(measuredCell) !== summaryBeforeClick,
      inlineDeadline
    );
    accessController.abort();
    outcomeValue(await access);
    milestones.mark("inline-ready");
    evidence.inline = Object.freeze({
      accessibleName: inlineTarget.accessibleName,
      unique: true,
      pointer: true,
      tableReady: true
    });
    recordProgress(`comparison:${request.trialId}:inline-ready`);

    const baselineTabs = Object.freeze([...allEditorTabs()]);
    const baselineFrames = new Set(comparisonFrames(page));
    const baselinePages = new Set([...baselineFrames].map((frame) => frame.page()));
    await clickTarget(inlineTarget, () => milestones.mark("launch-click"));
    recordProgress(`comparison:${request.trialId}:launch-click`);
    const workbenchDeadline = Date.now() + request.timeoutsMs.workbenchOpen;
    let targetSelected = false;
    do {
      const targetTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (
        targetTab !== undefined &&
        targetTab !== captured.sourceTab &&
        (targetTab.input instanceof vscode.TabInputCustom || targetTab.input instanceof vscode.TabInputWebview)
      ) {
        targetSelected = true;
        break;
      }
      await page.waitForTimeout(POLL_MS);
    } while (Date.now() < workbenchDeadline);
    if (!targetSelected) {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const opened = comparisonTabsOpenedAfter(baselineTabs, allEditorTabs());
      const inputType = (input: unknown): string =>
        input && typeof input === "object"
          ? ((input as { readonly constructor?: { readonly name?: string } }).constructor?.name ?? "object")
          : typeof input;
      throw new JourneyTimeout(
        "workbench-open",
        `The launch action did not select a custom or webview editor. Active ${activeTab ? inputType(activeTab.input) : "none"}; ` +
          `source ${String(activeTab === captured.sourceTab)}; opened ${JSON.stringify(
            opened.map((tab) => [inputType(tab.input), tab.isActive])
          )}.`
      );
    }
    let readiness;
    try {
      const discoveryBaselineFrames = request.product === "data-wrangler" ? new Set<Frame>() : baselineFrames;
      const discoveryBaselinePages = request.product === "data-wrangler" ? new Set<Page>() : baselinePages;
      readiness = await waitForGenericGridReadiness(
        page,
        discoveryBaselineFrames,
        discoveryBaselinePages,
        Math.max(1, workbenchDeadline - Date.now())
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new JourneyTimeout("workbench-open", `Timed out waiting for the full product grid. ${detail}`, {
        cause: error
      });
    }
    await comparisonWorkbenchReadiness(page, captured.sourceTab, readiness.rendererFramePointerUsable);
    const opened = comparisonTabsOpenedAfter(baselineTabs, allEditorTabs());
    assert.equal(opened.length, 1, "The public launch action must open exactly one product editor.");
    const fullShape = comparisonAriaCountsMatch({
      rows: request.cell.rows,
      columns: request.cell.columns,
      ariaRowCount: readiness.grid.ariaRowCount,
      ariaColumnCount: readiness.grid.ariaColumnCount
    })
      ? "aria-counts"
      : (await readiness.frame.evaluate(observeVisibleFullShape, {
            rows: request.cell.rows,
            columns: request.cell.columns
          }))
        ? "visible-label"
        : undefined;
    assert.ok(fullShape, "The product grid did not expose the full dataframe shape.");
    const scrollability = await readiness.frame.evaluate(observeGridScrollability);
    assert.ok(
      scrollability && scrollability.verticalOverflow > 0 && scrollability.horizontalOverflow > 0,
      `The full dataframe grid was not vertically and horizontally scrollable: ${JSON.stringify(scrollability)}.`
    );
    milestones.mark("workbench-ready");
    evidence.workbench = Object.freeze({
      rootRole: readiness.grid.rootRole,
      fullShape,
      ariaRowCount: readiness.grid.ariaRowCount,
      ariaColumnCount: readiness.grid.ariaColumnCount,
      ...scrollability
    });
    recordProgress(`comparison:${request.trialId}:workbench-ready`);

    const profileDeadline = Date.now() + request.timeoutsMs.completeProfile;
    let profileFrame = readiness.frame;
    let profileAction: ActionEvidence;
    if (request.product === "open-wrangler") {
      const target = await findExactButton(profileFrame, "Column profiles and filters", profileDeadline);
      profileAction = await clickTarget(target, () => milestones.mark("profile-click"));
    } else {
      profileAction = await clickColumnForProfile(profileFrame, 0, profileDeadline, () =>
        milestones.mark("profile-click")
      );
    }
    evidence.profiling = Object.freeze({
      ...profileAction,
      expectedColumns: request.cell.columns,
      completedColumns: 0
    });
    recordProgress(`comparison:${request.trialId}:profile-click`);

    for (let index = 0; index < request.cell.columns; index += 1) {
      const column = `c${String(index).padStart(2, "0")}`;
      if (request.product === "open-wrangler") {
        await selectOpenWranglerProfileColumn(profileFrame, column, profileDeadline);
      } else if (index > 0) {
        await clickColumnForProfile(profileFrame, index, profileDeadline);
      }
      const profileStage = index === 0 ? "profile-first" : "profile-all";
      if (request.product === "open-wrangler") {
        await waitForOpenWranglerProfile(profileFrame, column, profileDeadline, profileStage);
      } else {
        profileFrame = await waitForProfile(
          page,
          column,
          index,
          request.cell.rows - 1 + index,
          profileDeadline,
          profileStage
        );
      }
      if (index === 0) milestones.mark("first-profile-ready");
      evidence.profiling = Object.freeze({
        ...profileAction,
        expectedColumns: request.cell.columns,
        completedColumns: index + 1
      });
    }
    milestones.mark("profiles-complete");
    recordProgress(`comparison:${request.trialId}:profiles-complete`);
  } catch (error) {
    journeyFailed = true;
    journeyError = error;
  }
  accessController.abort();
  let cleanupError: unknown;
  try {
    listener?.dispose();
  } catch (error) {
    cleanupError = error;
  }
  for (const target of [inlineTarget, runTarget]) {
    try {
      await target?.dispose();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  const accessOutcome = await access;
  if (journeyFailed) throw journeyError;
  if (!accessOutcome.ok) throw accessOutcome.error;
  if (cleanupError !== undefined) throw cleanupError;
}

export async function run(): Promise<void> {
  const requestPath = requiredEnvironment("OPEN_WRANGLER_COMPARISON_REQUEST_PATH");
  const resultPath = requiredEnvironment("OPEN_WRANGLER_COMPARISON_RESULT_PATH");
  const request = readRequest(requestPath);
  containedPath(request.isolatedRoot, requestPath, "Comparison request path");
  containedPath(request.isolatedRoot, resultPath, "Comparison result path");
  assert.equal(vscode.env.language, "en", "The comparison journey requires VS Code launched with --locale=en.");
  const preActionDeadline = Date.now() + request.timeoutsMs.preAction;
  recordProgress(`comparison:${request.trialId}:connect`);
  const { page } = await beforePreActionDeadline(
    connectToEditorWorkbench(),
    preActionDeadline,
    "Timed out connecting to the comparison workbench."
  );
  const captured = await beforePreActionDeadline(
    captureNotebook(request),
    preActionDeadline,
    "Timed out capturing the comparison notebook."
  );
  await selectComparisonKernel(page, captured, preActionDeadline);
  const baselineTabs = Object.freeze([...allEditorTabs()]);
  const milestones = new Milestones();
  const evidence: MutableEvidence = { runCell: null, inline: null, workbench: null, profiling: null };
  let failure: ComparisonTrialResult["failure"] = null;
  let stage: FailureStage = "run-cell";
  try {
    await executeJourney(request, page, captured, milestones, evidence, preActionDeadline);
  } catch (error) {
    const observedMilestones = milestones.snapshot();
    const measuredActionStarted = observedMilestones.some((item) => item.name === "run-cell-click");
    if (!measuredActionStarted) stage = "harness";
    else if (error instanceof JourneyTimeout) stage = error.stage;
    else if (observedMilestones.some((item) => item.name === "profile-click")) {
      stage = evidence.profiling?.completedColumns === 0 ? "profile-first" : "profile-all";
    } else if (observedMilestones.some((item) => item.name === "launch-click")) stage = "workbench-open";
    else stage = "inline-preview";
    failure = Object.freeze({
      stage,
      kind: !measuredActionStarted ? "harness" : error instanceof JourneyTimeout ? "timeout" : "product",
      message: boundedFailureMessage(error, request)
    });
  }
  try {
    await closeNewTabs(baselineTabs);
  } catch (error) {
    if (failure === null) {
      failure = Object.freeze({ stage: "cleanup", kind: "harness", message: boundedFailureMessage(error, request) });
    }
  }
  const result = resultFromState(request, milestones, evidence, failure);
  writeResult(resultPath, request.isolatedRoot, result);
  recordProgress(`comparison:${request.trialId}:result`);
}
