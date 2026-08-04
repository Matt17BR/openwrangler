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
import { findExactActiveNotebookRendererButton } from "./notebookRendererFrame";

export const COMPARISON_TRIAL_REQUEST_PROTOCOL = "openwrangler-comparison-trial-request-v1";
export const COMPARISON_TRIAL_RESULT_PROTOCOL = "openwrangler-comparison-trial-result-v1";

const CELL_IDS = ["pandas-csv", "pandas-parquet", "polars-csv", "polars-parquet"] as const;
const MILESTONE_NAMES = [
  "run-cell-click",
  "inline-ready",
  "launch-click",
  "workbench-ready",
  "profile-click",
  "first-profile-ready",
  "profiles-complete"
] as const;
const FAILURE_STAGES = [
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
const SETUP_TIMEOUT_MS = 20_000;
const KERNEL_ACCESS_SETTLE_MS = 750;
const POLL_MS = 25;
const COMPARISON_KERNEL_LABEL = "Python 3.12 (Comparison)";
const KERNEL_ACCESS_DETAIL = "This allows the extension to execute code against Jupyter Kernels.";
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
  readonly editor: ArtifactIdentity;
  readonly python: ArtifactIdentity;
  readonly timeoutsMs: {
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
    readonly kind: "product" | "timeout";
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
  boundingBox(): Promise<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null>;
  pointerReady(): Promise<boolean>;
  inlineReady(input: {
    readonly actionName: string;
    readonly firstColumn: "c00";
    readonly secondColumn: "c01";
  }): Promise<boolean>;
  dispose(): Promise<void>;
}

interface GridScrollability {
  readonly verticalOverflow: number;
  readonly horizontalOverflow: number;
  readonly pointerUsable: true;
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
  exactKeys(timeouts, ["inlinePreview", "workbenchOpen", "completeProfile"], "Comparison request timeoutsMs");
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
    editor: artifact(request.editor, "Comparison request editor"),
    python: artifact(request.python, "Comparison request python"),
    timeoutsMs: Object.freeze({
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
  const kind = oneOf(failure.kind, ["product", "timeout"] as const, "Comparison result failure kind");
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
  const expectedCount = input.kind === "warm" ? 2 : 1;
  if (input.cells.length !== expectedCount) {
    fail(
      `A ${input.kind} comparison notebook must contain exactly ${expectedCount} code cell${expectedCount === 1 ? "" : "s"}.`
    );
  }
  const tagged = (tag: string): number[] =>
    input.cells.flatMap((cell, index) => (cell.tags.includes(tag) ? [index] : []));
  const measured = tagged(measuredTag);
  const setup = tagged(setupTag);
  if (measured.length !== 1) fail(`The comparison notebook must contain exactly one ${measuredTag} cell.`);
  if (setup.length !== (input.kind === "warm" ? 1 : 0)) {
    fail(
      input.kind === "warm"
        ? `A warm comparison notebook must contain exactly one ${setupTag} cell.`
        : `A cold comparison notebook must not contain a ${setupTag} cell.`
    );
  }
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
  const setupIndex = setup[0] ?? null;
  if (setupIndex !== null) {
    const setupSource = input.cells[setupIndex]!.source;
    if (setupIndex !== 0 || measuredIndex !== 1 || !setupSource.includes(`${input.variableName} =`)) {
      fail(
        "The warm setup cell must be first, assign the measured variable, and immediately precede its display cell."
      );
    }
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

async function waitForComparisonKernelLabel(page: Page): Promise<void> {
  const deadline = Date.now() + 10_000;
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

async function selectComparisonKernel(page: Page, captured: CapturedNotebook): Promise<void> {
  const jupyter = vscode.extensions.getExtension("ms-toolsai.jupyter");
  assert.ok(jupyter, "The pinned Jupyter extension is not installed for the comparison trial.");
  await jupyter.activate();
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
  const deadline = Date.now() + 30_000;
  const traversed = new Set<string>();
  let filterForTarget = false;
  try {
    do {
      const currentSelectionState = readSelectionState();
      if (currentSelectionState.kind === "rejected") throw currentSelectionState.error;
      const quickInput = await visibleQuickInput(page);
      if (!quickInput) {
        if (currentSelectionState.kind === "fulfilled") {
          await waitForComparisonKernelLabel(page);
          recordProgress("comparison:kernel-selected");
          return;
        }
        await page.waitForTimeout(50);
        continue;
      }
      const target = await comparisonKernelQuickPickRow(quickInput);
      if (target) {
        await target.click();
        const outcome = await Promise.race([
          selection,
          page.waitForTimeout(30_000).then(() => {
            throw new Error("Timed out applying the comparison kernel selection.");
          })
        ]);
        if (outcome.kind === "rejected") throw outcome.error;
        assert.equal(
          captured.editor.notebook,
          captured.notebook,
          "Kernel selection changed the measured notebook editor."
        );
        await waitForComparisonKernelLabel(page);
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

async function allowComparisonKernelAccess(page: Page, product: Product): Promise<void> {
  const message =
    product === "open-wrangler"
      ? "Do you want to grant Kernel access to the extension Open Wrangler (Matt17BR.openwrangler)?"
      : "Do you want to grant Kernel access to the extension Data Wrangler (ms-toolsai.datawrangler)?";
  const settleDeadline = Date.now() + KERNEL_ACCESS_SETTLE_MS;
  let match: { readonly dialog: Locator; readonly frame: Frame } | undefined;
  do {
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
  } while (Date.now() < settleDeadline);
  if (!match) {
    recordProgress(`comparison:kernel-access-not-requested:${product}`);
    return;
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
  await clickTarget(locatorTarget(allow, match.frame, "Allow"), () => undefined);
  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  do {
    if (!(await match.dialog.isVisible().catch(() => false))) {
      recordProgress(`comparison:kernel-access-allowed:${product}`);
      return;
    }
    await page.waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  throw new Error(`Jupyter did not close the ${product} kernel-access prompt after Allow.`);
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
    boundingBox: () => locator.boundingBox(),
    pointerReady: () => locator.evaluate(observePointerReady, accessibleName),
    inlineReady: (input) => locator.evaluate(observeInlinePreviewReady, input),
    dispose: async () => undefined
  };
}

function elementTarget(element: ElementHandle<unknown>, frame: Frame, accessibleName: string): PointerTarget {
  return {
    accessibleName,
    page: frame.page(),
    boundingBox: () => element.boundingBox(),
    pointerReady: () => element.evaluate(observePointerReady, accessibleName),
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
        requestAnimationFrame(callback: () => void): number;
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
    const style = window_.getComputedStyle(ancestor);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
      return Promise.resolve(false);
    ancestor = ancestor.parentElement;
  }
  const before = element.getBoundingClientRect();
  if (before.width <= 0 || before.height <= 0) return Promise.resolve(false);
  const hit = element.ownerDocument.elementFromPoint(before.left + before.width / 2, before.top + before.height / 2);
  if (hit !== element && !element.contains(hit)) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    window_.requestAnimationFrame(() => {
      window_.requestAnimationFrame(() => {
        const after = element.getBoundingClientRect();
        resolvePromise(
          element.isConnected &&
            before.left === after.left &&
            before.top === after.top &&
            before.width === after.width &&
            before.height === after.height
        );
      });
    });
  });
}

async function clickTarget(target: PointerTarget, beforeClick: () => void): Promise<ActionEvidence> {
  const ready = await target.pointerReady();
  assert.equal(ready, true, `Public action ${JSON.stringify(target.accessibleName)} was not pointer-ready.`);
  const box = await target.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "Public action lost its visible geometry.");
  await target.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  beforeClick();
  await target.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return Object.freeze({ accessibleName: target.accessibleName, unique: true, pointer: true });
}

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

async function findRunCellTarget(
  page: Page,
  captured: CapturedNotebook,
  cell: vscode.NotebookCell
): Promise<PointerTarget> {
  const visibleEditors = vscode.window.visibleNotebookEditors;
  assert.equal(visibleEditors.length, 1, "The comparison trial must have exactly one visible notebook editor.");
  assert.equal(visibleEditors[0], captured.editor, "The comparison notebook changed its visible editor.");
  assert.equal(vscode.window.activeNotebookEditor, captured.editor, "The comparison notebook is not active.");
  selectNotebookCell(captured, cell);
  const expectedPosition = cell.index + 1;
  const markerName = `Cell ${expectedPosition} of ${captured.notebook.cellCount}`;
  const executeCellName = /^Execute Cell(?: \([^\r\n]{1,64}\))?$/u;
  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  let pointerDiagnostic = "no matching Execute Cell action";
  do {
    const markerMatches: Locator[] = [];
    const actionMatches: Array<{ readonly action: Locator; readonly frame: Frame; readonly name: string }> = [];
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      const markers = frame.getByRole("button", { name: markerName, exact: true });
      const markerCount = Math.min(await markers.count().catch(() => 0), 4);
      for (let markerIndex = 0; markerIndex < markerCount; markerIndex += 1) {
        const marker = markers.nth(markerIndex);
        if (await marker.isVisible().catch(() => false)) markerMatches.push(marker);
      }
      const actions = frame.getByRole("button", { name: executeCellName });
      const count = Math.min(await actions.count().catch(() => 0), 8);
      for (let index = 0; index < count; index += 1) {
        const action = actions.nth(index);
        if (!(await action.isVisible().catch(() => false))) continue;
        const name = await locatorName(action);
        if (!executeCellName.test(name)) continue;
        await action.hover({ force: true, timeout: 1_000 }).catch(() => undefined);
        if (await action.evaluate(observePointerReady, name).catch(() => false)) {
          actionMatches.push({ action, frame, name });
        } else {
          pointerDiagnostic = await action
            .evaluate((value, expectedName) => {
              type Candidate = {
                readonly isConnected: boolean;
                readonly disabled?: boolean;
                readonly ownerDocument: {
                  readonly defaultView: {
                    getComputedStyle(item: unknown): {
                      readonly display: string;
                      readonly visibility: string;
                      readonly opacity: string;
                    };
                  } | null;
                  elementFromPoint(x: number, y: number): Candidate | null;
                  getElementById(id: string): { readonly textContent: string | null } | null;
                };
                readonly parentElement: Candidate | null;
                readonly tagName: string;
                readonly textContent: string | null;
                contains(item: unknown): boolean;
                getAttribute(name: string): string | null;
                getBoundingClientRect(): {
                  readonly left: number;
                  readonly top: number;
                  readonly width: number;
                  readonly height: number;
                };
              };
              const element = value as Candidate;
              const window_ = element.ownerDocument.defaultView;
              const labelledBy = element.getAttribute("aria-labelledby");
              const name = (
                element.getAttribute("aria-label") ||
                (labelledBy
                  ? labelledBy
                      .split(/\s+/u)
                      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
                      .join(" ")
                  : "") ||
                element.textContent ||
                element.getAttribute("title") ||
                ""
              )
                .replace(/\s+/gu, " ")
                .trim();
              if (!element.isConnected || !window_) return "detached";
              if (element.disabled || element.getAttribute("aria-disabled") === "true") return "disabled";
              if (name !== expectedName) return `name:${JSON.stringify(name)}`;
              let current: Candidate | null = element;
              while (current) {
                const style = window_.getComputedStyle(current);
                if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
                  return `hidden:${current.tagName.toLowerCase()}:${(current.getAttribute("class") ?? "").slice(0, 80)}`;
                }
                current = current.parentElement;
              }
              const box = element.getBoundingClientRect();
              const hit = element.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
              return (
                `box:${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)};` +
                `hit:${hit?.tagName.toLowerCase() ?? "none"}:${hit?.getAttribute("role") ?? "none"}:` +
                `${(hit?.getAttribute("class") ?? "").slice(0, 80)};contained:${String(hit === element || element.contains(hit))}`
              );
            }, name)
            .catch(() => "pointer diagnostic failed");
        }
      }
    }
    assert.ok(markerMatches.length < 2, `The workbench exposed duplicate ${JSON.stringify(markerName)} markers.`);
    const positioned = await Promise.all(
      actionMatches.map(async (match) => ({ match, box: await match.action.boundingBox() }))
    );
    const physicalActions: typeof positioned = [];
    let validActionCount = 0;
    for (const item of positioned) {
      if (
        !item.box ||
        ![item.box.x, item.box.y, item.box.width, item.box.height].every(Number.isFinite) ||
        item.box.width <= 0 ||
        item.box.height <= 0
      ) {
        continue;
      }
      validActionCount += 1;
      const duplicate = physicalActions.some(
        (existing) =>
          existing.match.frame === item.match.frame &&
          existing.match.name === item.match.name &&
          existing.box!.x === item.box!.x &&
          existing.box!.y === item.box!.y &&
          existing.box!.width === item.box!.width &&
          existing.box!.height === item.box!.height
      );
      if (!duplicate) physicalActions.push(item);
    }
    pointerDiagnostic = `pointer-ready boxes ${JSON.stringify(
      positioned.map((item) =>
        item.box ? [item.match.name, item.box.x, item.box.y, item.box.width, item.box.height] : null
      )
    )}`;
    let selectedAction: (typeof actionMatches)[number] | undefined;
    if (positioned.length > 0 && validActionCount === positioned.length && physicalActions.length === 1) {
      selectedAction = physicalActions[0]!.match;
    } else if (
      validActionCount === positioned.length &&
      physicalActions.length === captured.notebook.cellCount &&
      physicalActions.every((item) => item.match.frame === physicalActions[0]!.match.frame)
    ) {
      physicalActions.sort((left, right) => left.box!.y - right.box!.y);
      const distinctRows = physicalActions.every(
        (item, index) =>
          index === 0 ||
          (physicalActions[index - 1]!.box!.y + physicalActions[index - 1]!.box!.height <= item.box!.y &&
            physicalActions[index - 1]!.box!.y + physicalActions[index - 1]!.box!.height / 2 <
              item.box!.y + item.box!.height / 2)
      );
      if (distinctRows) selectedAction = physicalActions[cell.index]?.match;
    }
    if (markerMatches.length === 1 && selectedAction) {
      assert.equal(vscode.window.activeNotebookEditor, captured.editor, "The comparison notebook lost focus.");
      return locatorTarget(selectedAction.action, selectedAction.frame, selectedAction.name);
    }
    await page.waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  const visibleActions: string[] = [];
  const visibleMarkers: string[] = [];
  const visibleDialogs: string[] = [];
  for (const frame of comparisonFrames(page).slice(0, 64)) {
    const dialogs = frame.locator('[role="dialog"]:visible, .monaco-dialog-box:visible');
    const dialogCount = Math.min(await dialogs.count().catch(() => 0), 4 - visibleDialogs.length);
    for (let index = 0; index < dialogCount; index += 1) {
      visibleDialogs.push(
        (
          await dialogs
            .nth(index)
            .innerText()
            .catch(() => "")
        )
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 300)
      );
    }
    const buttons = frame.locator('button:visible, [role="button"]:visible');
    const buttonCount = Math.min(await buttons.count().catch(() => 0), 128);
    for (let index = 0; index < buttonCount && visibleActions.length < 32; index += 1) {
      const name = await locatorName(buttons.nth(index)).catch(() => "");
      if (/\b(?:cell|execute|run)\b/iu.test(name)) visibleActions.push(name.slice(0, 100));
    }
    const markers = frame.getByRole("button", { name: /^Cell \d+ of \d+$/u });
    const markerCount = Math.min(await markers.count().catch(() => 0), 16 - visibleMarkers.length);
    for (let index = 0; index < markerCount; index += 1) {
      const marker = markers.nth(index);
      visibleMarkers.push((await locatorName(marker).catch(() => "")).slice(0, 100));
    }
  }
  throw new Error(
    `The selected comparison cell did not expose one public Execute Cell action. ` +
      `Expected: ${JSON.stringify(markerName)} Dialogs: ${JSON.stringify(visibleDialogs)} ` +
      `Pointer: ${pointerDiagnostic} Actions: ${JSON.stringify(visibleActions)} ` +
      `Markers: ${JSON.stringify(visibleMarkers)}`
  );
}

/** Verifies that the launch action and a deterministic dataframe preview share one visible document. */
export function observeInlinePreviewReady(
  elementValue: unknown,
  input: { readonly actionName: string; readonly firstColumn: "c00"; readonly secondColumn: "c01" }
): boolean {
  type Candidate = {
    readonly isConnected: boolean;
    readonly ownerDocument: {
      readonly defaultView: {
        getComputedStyle(value: unknown): {
          readonly display: string;
          readonly visibility: string;
          readonly opacity: string;
        };
      } | null;
      querySelectorAll(selector: string): ArrayLike<Candidate>;
    };
    readonly parentElement: Candidate | null;
    readonly textContent: string | null;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): { readonly width: number; readonly height: number };
    querySelectorAll(selector: string): ArrayLike<Candidate>;
  };
  const action = elementValue as Candidate;
  const window_ = action?.ownerDocument?.defaultView;
  if (!action?.isConnected || !window_) return false;
  const normalize = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
  const actionName = normalize(action.getAttribute("aria-label") || action.textContent || action.getAttribute("title"));
  if (actionName !== input.actionName) return false;
  const visible = (candidate: Candidate): boolean => {
    if (!candidate.isConnected) return false;
    const box = candidate.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    let current: Candidate | null = candidate;
    while (current) {
      const style = window_.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      current = current.parentElement;
    }
    return true;
  };
  const roots: Candidate[] = [];
  let current: Candidate | null = action;
  for (let depth = 0; current && depth < 12; depth += 1) {
    roots.push(current);
    current = current.parentElement;
  }
  roots.push(...Array.from(action.ownerDocument.querySelectorAll('[role="grid"], [role="table"], table')).slice(0, 64));
  return roots.some((root) => {
    const tables = [root, ...Array.from(root.querySelectorAll('[role="grid"], [role="table"], table')).slice(0, 64)];
    return tables.some((table) => {
      if (!visible(table)) return false;
      const headers = Array.from(table.querySelectorAll('[role="columnheader"], th')).map((item) =>
        normalize(item.textContent)
      );
      if (!headers.some((text) => text === input.firstColumn || text.startsWith(`${input.firstColumn} `))) return false;
      if (!headers.some((text) => text === input.secondColumn || text.startsWith(`${input.secondColumn} `)))
        return false;
      const text = normalize(table.textContent);
      return /(?:^|\s)0(?:\s|$)/u.test(text) && /(?:^|\s)1(?:\s|$)/u.test(text);
    });
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
    const actionPattern = new RegExp(`^Open ['"]${escapeRegex(request.cell.variableName)}['"] in Data Wrangler$`, "u");
    for (const frame of comparisonFrames(page).slice(0, 64)) {
      const buttons = frame.getByRole("button", { name: actionPattern });
      const count = Math.min(await buttons.count().catch(() => 0), 8);
      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (!(await button.isVisible().catch(() => false))) continue;
        const name = await locatorName(button);
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
  const wranglerActionSignatures: Array<readonly [number, number]> = [];
  const exactAction = new RegExp(`^Open ['"]${escapeRegex(request.cell.variableName)}['"] in Data Wrangler$`, "u");
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
      if (exactAction.test(name)) exactActionCount += 1;
      if (name === "Open in Data Wrangler") genericActionCount += 1;
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
      `Outputs ${cell.outputs.length} MIME count ${mimeTypes.size} HTML ${String(mimeTypes.has("text/html"))} ` +
      `plain text ${String(mimeTypes.has("text/plain"))}. Wrangler actions ${wranglerActionCount} ` +
      `exact ${exactActionCount} generic ${genericActionCount} role ${exactRoleCount} visible ${exactRoleVisibleCount} ` +
      `pointer ${exactRolePointerCount} inline ${exactRoleInlineCount} signatures ` +
      `${JSON.stringify(wranglerActionSignatures)} end.`
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

/** Product-neutral scrollability probe used only after the generic public grid is ready. */
export function observeGridScrollability(): GridScrollability | null {
  type Candidate = {
    readonly isConnected: boolean;
    readonly parentElement: Candidate | null;
    readonly textContent: string | null;
    readonly clientHeight: number;
    readonly clientWidth: number;
    readonly scrollHeight: number;
    readonly scrollWidth: number;
    contains(value: unknown): boolean;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): {
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
    };
    querySelectorAll(selector: string): ArrayLike<Candidate>;
  };
  const runtime = globalThis as unknown as {
    readonly document: {
      querySelectorAll(selector: string): ArrayLike<Candidate>;
      elementFromPoint(x: number, y: number): unknown;
    };
  };
  const normalize = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
  const roots = Array.from(runtime.document.querySelectorAll('[role="grid"], [role="table"], table')).slice(0, 64);
  for (const root of roots) {
    const headers = Array.from(root.querySelectorAll('[role="columnheader"], th')).map((item) =>
      normalize(item.textContent)
    );
    if (!headers.some((name) => /^c00(?:\b|\s)/u.test(name)) || !headers.some((name) => /^c01(?:\b|\s)/u.test(name)))
      continue;
    const candidates: Candidate[] = [root];
    let parent = root.parentElement;
    for (let depth = 0; parent && depth < 12; depth += 1) {
      candidates.push(parent);
      parent = parent.parentElement;
    }
    candidates.push(...Array.from(root.querySelectorAll("*")).slice(0, 4_096));
    const verticalOverflow = Math.max(...candidates.map((item) => Math.max(0, item.scrollHeight - item.clientHeight)));
    const horizontalOverflow = Math.max(...candidates.map((item) => Math.max(0, item.scrollWidth - item.clientWidth)));
    const box = root.getBoundingClientRect();
    const hit = runtime.document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (
      box.width > 0 &&
      box.height > 0 &&
      (hit === root || root.contains(hit)) &&
      verticalOverflow > 0 &&
      horizontalOverflow > 0
    ) {
      return { verticalOverflow, horizontalOverflow, pointerUsable: true };
    }
  }
  return null;
}

async function findExactButton(frame: Frame, name: string, timeoutMs = SETUP_TIMEOUT_MS): Promise<PointerTarget> {
  const deadline = Date.now() + timeoutMs;
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
  const pattern = new RegExp(`^${escapeRegex(column)}(?:\\b|[,;:()\\[\\]{}\\u2013\\u2014-])`, "u");
  const headers = frame.getByRole("columnheader", { name: pattern });
  const matches: Locator[] = [];
  const count = Math.min(await headers.count().catch(() => 0), 16);
  for (let index = 0; index < count; index += 1) {
    const header = headers.nth(index);
    if (await header.isVisible().catch(() => false)) matches.push(header);
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
        const names = Array.from(element.querySelectorAll('[role="columnheader"], th')).map((item) =>
          ((item as { readonly textContent: string | null }).textContent ?? "").trim()
        );
        return names.some((name) => /^c00(?:\b|\s)/u.test(name)) && names.some((name) => /^c01(?:\b|\s)/u.test(name));
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

/** Public-text profile oracle; it never returns row values. */
export function observeIntegerProfileReady(input: {
  readonly column: string;
  readonly minimum: number;
  readonly maximum: number;
}): boolean {
  type Candidate = {
    readonly isConnected: boolean;
    readonly parentElement: Candidate | null;
    readonly textContent: string | null;
    getBoundingClientRect(): { readonly width: number; readonly height: number };
  };
  const runtime = globalThis as unknown as {
    readonly document: { querySelectorAll(selector: string): ArrayLike<Candidate> };
  };
  if (!/^c\d{2}$/u.test(input.column) || !Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum))
    return false;
  const normalize = (value: string | null): string => (value ?? "").replace(/[,_]/gu, "").replace(/\s+/gu, " ").trim();
  return Array.from(
    runtime.document.querySelectorAll(
      'aside, [role="complementary"], [role="region"], section, [role="tabpanel"], [role="columnheader"]'
    )
  )
    .slice(0, 1_024)
    .some((candidate) => {
      const box = candidate.getBoundingClientRect();
      if (!candidate.isConnected || box.width <= 0 || box.height <= 0) return false;
      const text = normalize(candidate.textContent);
      if (!new RegExp(`(?:^|\\b)${input.column}(?:\\b|[,;:()\\[\\]{}-])`, "u").test(text)) return false;
      if (/\b(?:loading|profiling|calculating|pending)\b/iu.test(text)) return false;
      return (
        /\b(?:int64|integer|number|numeric)\b/iu.test(text) &&
        /\b(?:missing|null(?:s| values?)?)\s*[:=]?\s*0(?:\b|%)/iu.test(text) &&
        /\b(?:distinct|unique)\b/iu.test(text) &&
        new RegExp(`\\b(?:min|minimum)\\s*[:=]?\\s*${input.minimum}\\b`, "iu").test(text) &&
        new RegExp(`\\b(?:max|maximum)\\s*[:=]?\\s*${input.maximum}\\b`, "iu").test(text)
      );
    });
}

async function clickColumnForProfile(
  frame: Frame,
  product: Product,
  index: number,
  deadline: number,
  beforeClick?: () => void
): Promise<ActionEvidence> {
  const column = `c${String(index).padStart(2, "0")}`;
  const header = await revealColumnHeader(frame, column, deadline);
  if (product === "data-wrangler") {
    const name = await locatorName(header);
    return clickTarget(locatorTarget(header, frame, name), beforeClick ?? (() => undefined));
  }
  const ariaColumnIndex = (await header.getAttribute("aria-colindex")) ?? String(index + 2);
  const root = await gridRoot(frame);
  const cells = root.locator(
    `[role="gridcell"][aria-colindex="${ariaColumnIndex}"], [role="cell"][aria-colindex="${ariaColumnIndex}"]`
  );
  const count = Math.min(await cells.count().catch(() => 0), 64);
  for (let cellIndex = 0; cellIndex < count; cellIndex += 1) {
    const cell = cells.nth(cellIndex);
    if (!(await cell.isVisible().catch(() => false))) continue;
    return clickTarget(locatorTarget(cell, frame, await locatorName(cell)), beforeClick ?? (() => undefined));
  }
  throw new Error(`Open Wrangler did not expose one visible data cell for ${column}.`);
}

async function waitForProfile(
  frame: Frame,
  column: string,
  minimum: number,
  maximum: number,
  deadline: number,
  stage: FailureStage
): Promise<void> {
  do {
    if (await frame.evaluate(observeIntegerProfileReady, { column, minimum, maximum }).catch(() => false)) return;
    await frame.page().waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
  throw new JourneyTimeout(stage, `Timed out waiting for the completed public profile for ${column}.`);
}

function boundedFailureMessage(error: unknown, request: ComparisonTrialRequest): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replaceAll(request.isolatedRoot, "<isolated-root>")
    .replaceAll(request.notebookPath, "<notebook>")
    .replaceAll(request.cell.source, "<source>")
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
  captured: CapturedNotebook
): Promise<void> {
  if (captured.setupCell === null) return;
  assert.equal(request.kind, "warm", "Only a warm comparison trial may execute an untimed setup cell.");
  assert.equal(captured.editor.notebook, captured.notebook, "The warm setup changed the captured notebook editor.");
  assert.equal(vscode.window.activeNotebookEditor, captured.editor, "The warm setup notebook is not active.");
  const setupCell = captured.setupCell;
  const summaryBeforeDispatch = executionSummaryFingerprint(setupCell);
  let freshExecution = false;
  let commandError: unknown;
  const listener = vscode.workspace.onDidChangeNotebookDocument((event) => {
    if (event.notebook !== captured.notebook) return;
    if (event.cellChanges.some((change) => change.cell === setupCell && change.executionSummary !== undefined)) {
      freshExecution = true;
    }
  });
  try {
    const command = Promise.resolve(
      vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [{ start: setupCell.index, end: setupCell.index + 1 }],
        document: captured.notebook.uri
      })
    ).catch((error: unknown) => {
      commandError = error;
    });
    recordProgress(`comparison:${request.trialId}:warm-setup-dispatch`);
    const deadline = Date.now() + SETUP_TIMEOUT_MS;
    do {
      if (commandError) throw commandError;
      const executionChanged = freshExecution || executionSummaryFingerprint(setupCell) !== summaryBeforeDispatch;
      if (executionChanged && setupCell.executionSummary?.success === true) {
        await command;
        assert.equal(setupCell.outputs.length, 0, "The untimed warm setup cell must not publish dataframe output.");
        selectNotebookCell(captured, captured.cell);
        recordProgress(`comparison:${request.trialId}:warm-setup-complete`);
        return;
      }
      if (executionChanged && setupCell.executionSummary?.success === false) {
        throw new Error("The untimed warm setup cell failed.");
      }
      await page.waitForTimeout(POLL_MS);
    } while (Date.now() < deadline);
    throw new JourneyTimeout("run-cell", "Timed out waiting for the untimed warm setup cell.");
  } finally {
    listener.dispose();
  }
}

async function executeJourney(
  request: ComparisonTrialRequest,
  page: Page,
  captured: CapturedNotebook,
  milestones: Milestones,
  evidence: MutableEvidence
): Promise<void> {
  await allowComparisonKernelAccess(page, request.product);
  await executeWarmSetup(request, page, captured);
  await allowComparisonKernelAccess(page, request.product);
  const runTarget = await findRunCellTarget(page, captured, captured.cell);
  const summaryBeforeClick = executionSummaryFingerprint(captured.cell);
  let freshExecution = false;
  const listener = vscode.workspace.onDidChangeNotebookDocument((event) => {
    if (event.notebook !== captured.notebook) return;
    if (event.cellChanges.some((change) => change.cell === captured.cell && change.executionSummary !== undefined)) {
      freshExecution = true;
    }
  });
  let inlineTarget: PointerTarget | undefined;
  try {
    evidence.runCell = await clickTarget(runTarget, () => milestones.mark("run-cell-click"));
    recordProgress(`comparison:${request.trialId}:run-cell-click`);
    const inlineDeadline = Date.now() + request.timeoutsMs.inlinePreview;
    inlineTarget = await waitForInlineTarget(
      page,
      request,
      captured.cell,
      () => freshExecution || executionSummaryFingerprint(captured.cell) !== summaryBeforeClick,
      inlineDeadline
    );
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
    let readiness;
    try {
      readiness = await waitForGenericGridReadiness(
        page,
        baselineFrames,
        baselinePages,
        request.timeoutsMs.workbenchOpen
      );
    } catch (error) {
      throw new JourneyTimeout("workbench-open", "Timed out waiting for the full product grid.", { cause: error });
    }
    await comparisonWorkbenchReadiness(page, captured.sourceTab, true);
    const opened = comparisonTabsOpenedAfter(baselineTabs, allEditorTabs());
    assert.equal(opened.length, 1, "The public launch action must open exactly one product editor.");
    const fullShape =
      readiness.grid.ariaRowCount === request.cell.rows && readiness.grid.ariaColumnCount === request.cell.columns
        ? "aria-counts"
        : (await readiness.frame.evaluate(observeVisibleFullShape, {
              rows: request.cell.rows,
              columns: request.cell.columns
            }))
          ? "visible-label"
          : undefined;
    assert.ok(fullShape, "The product grid did not expose the full dataframe shape.");
    const scrollability = await readiness.frame.evaluate(observeGridScrollability);
    assert.ok(scrollability, "The full dataframe grid was not vertically and horizontally scrollable.");
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
    let profileAction: ActionEvidence;
    if (request.product === "open-wrangler") {
      const target = await findExactButton(readiness.frame, "Column profiles and filters");
      profileAction = await clickTarget(target, () => milestones.mark("profile-click"));
    } else {
      profileAction = await clickColumnForProfile(readiness.frame, request.product, 0, profileDeadline, () =>
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
      if (request.product === "open-wrangler" || index > 0) {
        await clickColumnForProfile(readiness.frame, request.product, index, profileDeadline);
      }
      await waitForProfile(
        readiness.frame,
        column,
        index,
        request.cell.rows - 1 + index,
        profileDeadline,
        index === 0 ? "profile-first" : "profile-all"
      );
      if (index === 0) milestones.mark("first-profile-ready");
      evidence.profiling = Object.freeze({
        ...profileAction,
        expectedColumns: request.cell.columns,
        completedColumns: index + 1
      });
    }
    milestones.mark("profiles-complete");
    recordProgress(`comparison:${request.trialId}:profiles-complete`);
  } finally {
    listener.dispose();
    await inlineTarget?.dispose();
    await runTarget.dispose();
  }
}

export async function run(): Promise<void> {
  const requestPath = requiredEnvironment("OPEN_WRANGLER_COMPARISON_REQUEST_PATH");
  const resultPath = requiredEnvironment("OPEN_WRANGLER_COMPARISON_RESULT_PATH");
  const request = readRequest(requestPath);
  containedPath(request.isolatedRoot, requestPath, "Comparison request path");
  containedPath(request.isolatedRoot, resultPath, "Comparison result path");
  assert.equal(vscode.env.language, "en", "The comparison journey requires VS Code launched with --locale=en.");
  recordProgress(`comparison:${request.trialId}:connect`);
  const { page } = await connectToEditorWorkbench();
  const captured = await captureNotebook(request);
  await selectComparisonKernel(page, captured);
  const baselineTabs = Object.freeze([...allEditorTabs()]);
  const milestones = new Milestones();
  const evidence: MutableEvidence = { runCell: null, inline: null, workbench: null, profiling: null };
  let failure: ComparisonTrialResult["failure"] = null;
  let stage: FailureStage = "run-cell";
  try {
    await executeJourney(request, page, captured, milestones, evidence);
  } catch (error) {
    if (error instanceof JourneyTimeout) stage = error.stage;
    else if (milestones.snapshot().some((item) => item.name === "profile-click")) {
      stage = evidence.profiling?.completedColumns === 0 ? "profile-first" : "profile-all";
    } else if (milestones.snapshot().some((item) => item.name === "launch-click")) stage = "workbench-open";
    else if (milestones.snapshot().some((item) => item.name === "run-cell-click")) stage = "inline-preview";
    failure = Object.freeze({
      stage,
      kind: error instanceof JourneyTimeout ? "timeout" : "product",
      message: boundedFailureMessage(error, request)
    });
  }
  try {
    await closeNewTabs(baselineTabs);
  } catch (error) {
    if (failure === null) {
      failure = Object.freeze({ stage: "cleanup", kind: "product", message: boundedFailureMessage(error, request) });
    }
  }
  const result = resultFromState(request, milestones, evidence, failure);
  writeResult(resultPath, request.isolatedRoot, result);
  recordProgress(`comparison:${request.trialId}:result`);
}
