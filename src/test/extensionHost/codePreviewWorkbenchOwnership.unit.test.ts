import * as nodeAssert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface WorkbenchContainerDescriptor {
  readonly className: string;
  readonly id: string;
}

interface WorkbenchOwnershipRelation {
  readonly anchorName?: string;
  readonly flowOwnerId?: string;
  readonly kind: "flow" | "parent";
}

interface WorkbenchOwnershipReceipt {
  readonly chain: readonly unknown[];
  readonly chainLength: number;
  readonly containerIndex: number;
  readonly flowLinkCount: number;
  readonly overlayChain: readonly unknown[];
  readonly overlayChainLength: number;
  readonly reason: string;
  readonly relations: readonly WorkbenchOwnershipRelation[];
}

interface WorkbenchOwnershipAuthority {
  readonly assertReceipt: (receipt: Pick<WorkbenchOwnershipReceipt, "reason">, description: string) => void;
  readonly containers: readonly WorkbenchContainerDescriptor[];
  readonly inspect: (element: unknown, options: Record<string, unknown>) => WorkbenchOwnershipReceipt;
  readonly limits: Readonly<{
    ancestors: number;
    flowAnchorCandidates: number;
    flowAnchorNameCodeUnits: number;
    flowOwnerIdCandidates: number;
    flowOwnerIdCodeUnits: number;
  }>;
  readonly selector: string;
}

interface FakeRectangle {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface FakeStyle {
  display: string;
  opacity: string;
  visibility: string;
  getPropertyValue(name: string): string;
  setProperty(name: string, value: string): void;
}

interface FakeDocument {
  readonly defaultView: {
    readonly innerHeight: number;
    readonly innerWidth: number;
    getComputedStyle(target: unknown): FakeStyle;
  };
  documentElement: FakeElement;
  getElementById(id: string): FakeElement | null;
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

interface FakeElement {
  readonly children: FakeElement[];
  readonly classList: { contains(className: string): boolean };
  readonly dataset: { parentFlowToElementId?: string };
  readonly hasIdAttribute: boolean;
  readonly ownerDocument: FakeDocument;
  readonly style: FakeStyle;
  readonly tagName: string;
  id: string;
  isConnected: boolean;
  parentElement: FakeElement | null;
  contains(target: unknown): boolean;
  getBoundingClientRect(): FakeRectangle;
  querySelectorAll(selector: string): ArrayLike<unknown>;
  setBoundingClientRect(rectangle: FakeRectangle): void;
}

const LIVE_ACTION_FUNCTION = "assertLiveCodePreviewActionOwnership";
const CAPTURE_OWNERSHIP_FUNCTION = "captureCodePreviewWorkbenchOwnership";
const CAPTURE_GENERATION_FUNCTION = "captureCodePreviewWorkbenchGeneration";
const OWNERSHIP_ASSERTION_HELPER = "assertCodePreviewWorkbenchOwnershipReceipt";
const OWNERSHIP_INSPECTOR = "inspectCodePreviewWorkbenchOwnership";
const FLOW_ANCHOR_NAME = "--overlay-anchor-code-preview";

const SUPPORTED_WORKBENCH_CONTAINERS = [
  { className: "panel", id: "workbench.parts.panel" },
  { className: "auxiliarybar", id: "workbench.parts.auxiliarybar" },
  { className: "sidebar", id: "workbench.parts.sidebar" }
] as const;
const SUPPORTED_WORKBENCH_CONTAINER_SELECTOR =
  '.part.panel[id="workbench.parts.panel"], .part.auxiliarybar[id="workbench.parts.auxiliarybar"], .part.sidebar[id="workbench.parts.sidebar"]';

function replaceExactlyOnce(source: string, from: string, to: string): string {
  nodeAssert.equal(source.split(from).length - 1, 1, `Expected exactly one source fragment: ${from}`);
  return source.replace(from, to);
}

function directVariable(
  statements: readonly ts.Statement[],
  name: string
): { readonly declaration: ts.VariableDeclaration; readonly statement: ts.VariableStatement } {
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return { declaration, statement };
    }
  }
  nodeAssert.fail(`Missing direct ${name} variable.`);
}

function descendantCalls(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate)) calls.push(candidate);
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return calls;
}

function assertLiveOwnershipBinding(source: string): void {
  const syntax = ts.createSourceFile("extensionHost/index.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const liveAction = syntax.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === LIVE_ACTION_FUNCTION
  );
  nodeAssert.ok(liveAction?.body, `${LIVE_ACTION_FUNCTION} must remain a top-level function with a body.`);
  const statements = Array.from(liveAction.body.statements);

  const outerFrame = directVariable(statements, "outerFrame").declaration;
  nodeAssert.equal(
    outerFrame.initializer?.getText(syntax),
    "generation.frameElements[generation.frameElements.length - 1]",
    "The action guard must derive its outer iframe from the pinned generation."
  );

  const receiptBinding = directVariable(statements, "receipt");
  nodeAssert.ok(receiptBinding.declaration.initializer, "The live ownership receipt must have an initializer.");
  const receiptIndex = statements.indexOf(receiptBinding.statement);
  const immediateAssertion = statements[receiptIndex + 1];
  nodeAssert.ok(
    immediateAssertion &&
      ts.isExpressionStatement(immediateAssertion) &&
      ts.isCallExpression(immediateAssertion.expression),
    "The exact ownership assertion must immediately consume the complete live receipt."
  );
  const assertionCall = immediateAssertion.expression;
  nodeAssert.ok(
    ts.isIdentifier(assertionCall.expression) && assertionCall.expression.text === OWNERSHIP_ASSERTION_HELPER,
    `The live receipt must be consumed immediately by ${OWNERSHIP_ASSERTION_HELPER}.`
  );
  nodeAssert.deepEqual(
    assertionCall.arguments.map((argument) => argument.getText(syntax)),
    ["receipt.ownership", "description"],
    "The ownership assertion must retain the exact receipt and diagnostic owner."
  );
  const assertionCalls = descendantCalls(liveAction.body).filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === OWNERSHIP_ASSERTION_HELPER
  );
  nodeAssert.equal(assertionCalls.length, 1, "The exact live ownership assertion must run exactly once.");

  const inspectorCalls = descendantCalls(receiptBinding.declaration.initializer).filter(
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === "outerFrame" &&
      call.expression.name.text === "evaluate" &&
      ts.isIdentifier(call.arguments[0]) &&
      call.arguments[0].text === OWNERSHIP_INSPECTOR
  );
  nodeAssert.equal(
    inspectorCalls.length,
    1,
    "The complete receipt must contain exactly one exact-outer-frame ownership inspection."
  );
  const inspectorCall = inspectorCalls[0];
  nodeAssert.equal(
    inspectorCall.arguments.length,
    2,
    "The ownership inspection must receive one exact options object."
  );
  const options = inspectorCall.arguments[1];
  nodeAssert.ok(ts.isObjectLiteralExpression(options), "The ownership inspection options must remain explicit.");
  const actualOptions = new Map<string, string>();
  for (const property of options.properties) {
    nodeAssert.ok(ts.isPropertyAssignment(property), "Ownership options must use explicit property assignments.");
    const name = property.name.getText(syntax);
    nodeAssert.equal(actualOptions.has(name), false, `Ownership option ${name} must be unique.`);
    actualOptions.set(name, property.initializer.getText(syntax));
  }
  const expectedOptions = new Map<string, string>([
    ["containerSelector", "CODE_PREVIEW_WORKBENCH_CONTAINER_SELECTOR"],
    ["expectedChain", "generation.ownershipElements"],
    ["expectedOuterFrame", "outerFrame"],
    ["expectedOverlayChain", "generation.overlayElements"],
    ["expectedRelations", "generation.ownershipRelations"],
    ["maximumAncestors", "MAX_CODE_PREVIEW_DOM_ANCESTORS"],
    ["maximumContainers", "CODE_PREVIEW_WORKBENCH_CONTAINERS.length"],
    ["maximumFlowAnchorCandidates", "MAX_CODE_PREVIEW_FLOW_ANCHOR_CANDIDATES"],
    ["maximumFlowAnchorNameCodeUnits", "MAX_CODE_PREVIEW_FLOW_ANCHOR_NAME_CODE_UNITS"],
    ["maximumFlowOwnerIdCandidates", "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CANDIDATES"],
    ["maximumFlowOwnerIdCodeUnits", "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CODE_UNITS"],
    ["retainElements", "false"],
    ["supportedContainers", "CODE_PREVIEW_WORKBENCH_CONTAINERS"]
  ]);
  nodeAssert.deepEqual(
    Array.from(actualOptions.entries()).sort(([left], [right]) => left.localeCompare(right)),
    Array.from(expectedOptions.entries()).sort(([left], [right]) => left.localeCompare(right)),
    "The action guard must retain every exact generation, topology, and bound option."
  );
}

function assertAcquisitionOwnershipBinding(source: string): void {
  const syntax = ts.createSourceFile("extensionHost/index.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const findFunction = (name: string): ts.FunctionDeclaration => {
    const declaration = syntax.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name
    );
    nodeAssert.ok(declaration?.body, `${name} must remain a top-level function with a body.`);
    return declaration;
  };
  const captureOwnership = findFunction(CAPTURE_OWNERSHIP_FUNCTION);
  const ownershipInspections = descendantCalls(captureOwnership.body!).filter(
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === "outerFrame" &&
      call.expression.name.text === "evaluateHandle" &&
      ts.isIdentifier(call.arguments[0]) &&
      call.arguments[0].text === OWNERSHIP_INSPECTOR
  );
  nodeAssert.equal(
    ownershipInspections.length,
    1,
    "Generation acquisition must atomically retain exactly one inspector receipt from the exact outer iframe."
  );
  const inspection = ownershipInspections[0];
  nodeAssert.equal(inspection.arguments.length, 2, "Generation acquisition must pass one explicit options object.");
  const options = inspection.arguments[1];
  nodeAssert.ok(ts.isObjectLiteralExpression(options), "Generation acquisition options must remain explicit.");
  const actualOptions = new Map<string, string>();
  for (const property of options.properties) {
    nodeAssert.ok(ts.isPropertyAssignment(property), "Generation acquisition options must use explicit assignments.");
    const name = property.name.getText(syntax);
    nodeAssert.equal(actualOptions.has(name), false, `Generation acquisition option ${name} must be unique.`);
    actualOptions.set(name, property.initializer.getText(syntax));
  }
  const expectedOptions = new Map<string, string>([
    ["containerSelector", "CODE_PREVIEW_WORKBENCH_CONTAINER_SELECTOR"],
    ["maximumAncestors", "MAX_CODE_PREVIEW_DOM_ANCESTORS"],
    ["maximumContainers", "CODE_PREVIEW_WORKBENCH_CONTAINERS.length"],
    ["maximumFlowAnchorCandidates", "MAX_CODE_PREVIEW_FLOW_ANCHOR_CANDIDATES"],
    ["maximumFlowAnchorNameCodeUnits", "MAX_CODE_PREVIEW_FLOW_ANCHOR_NAME_CODE_UNITS"],
    ["maximumFlowOwnerIdCandidates", "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CANDIDATES"],
    ["maximumFlowOwnerIdCodeUnits", "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CODE_UNITS"],
    ["retainElements", "true"],
    ["supportedContainers", "CODE_PREVIEW_WORKBENCH_CONTAINERS"]
  ]);
  nodeAssert.deepEqual(
    Array.from(actualOptions.entries()).sort(([left], [right]) => left.localeCompare(right)),
    Array.from(expectedOptions.entries()).sort(([left], [right]) => left.localeCompare(right)),
    "Generation acquisition must retain the exact bounded split-topology options."
  );

  const captureGeneration = findFunction(CAPTURE_GENERATION_FUNCTION);
  const ownershipCaptures = descendantCalls(captureGeneration.body!).filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === CAPTURE_OWNERSHIP_FUNCTION
  );
  nodeAssert.equal(ownershipCaptures.length, 1, "A generation must capture exactly one workbench ownership receipt.");
  nodeAssert.deepEqual(
    ownershipCaptures[0].arguments.map((argument) => argument.getText(syntax)),
    ["outerFrame", "bounded", "deadline", "description"],
    "Generation capture must bind ownership to its exact outer iframe and deadline owner."
  );
  const soleOverlayFrames = descendantCalls(captureGeneration.body!).filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === "captureSoleCodePreviewOverlayFrameElement"
  );
  nodeAssert.equal(soleOverlayFrames.length, 1, "A generation must pin one exact sole overlay iframe authority.");
  nodeAssert.deepEqual(
    soleOverlayFrames[0].arguments.map((argument) => argument.getText(syntax)),
    ["overlayContent", "outerFrame", "bounded", "description"],
    "Sole-overlay cardinality must bind the exact captured content and outer iframe."
  );
}

function loadAuthority(): WorkbenchOwnershipAuthority {
  const path = resolve(process.cwd(), "src/test/extensionHost/index.ts");
  const source = readFileSync(path, "utf8");
  assertLiveOwnershipBinding(source);
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const variables = new Set([
    "MAX_CODE_PREVIEW_DOM_ANCESTORS",
    "MAX_CODE_PREVIEW_FLOW_ANCHOR_CANDIDATES",
    "MAX_CODE_PREVIEW_FLOW_ANCHOR_NAME_CODE_UNITS",
    "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CANDIDATES",
    "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CODE_UNITS",
    "CODE_PREVIEW_WORKBENCH_CONTAINERS",
    "CODE_PREVIEW_WORKBENCH_CONTAINER_SELECTOR"
  ]);
  const functions = new Set(["assertCodePreviewWorkbenchOwnershipReceipt", "inspectCodePreviewWorkbenchOwnership"]);
  const selected = syntax.statements.filter((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && variables.has(declaration.name.text)
      );
    }
    return ts.isFunctionDeclaration(statement) && statement.name !== undefined && functions.has(statement.name.text);
  });
  expect(selected).toHaveLength(9);
  const compiled = ts.transpileModule(
    `${selected.map((statement) => statement.getText(syntax)).join("\n")}\n` +
      "globalThis.__openWranglerWorkbenchOwnershipAuthority = {" +
      "assertReceipt: assertCodePreviewWorkbenchOwnershipReceipt," +
      "containers: CODE_PREVIEW_WORKBENCH_CONTAINERS," +
      "inspect: inspectCodePreviewWorkbenchOwnership," +
      "limits: {" +
      "ancestors: MAX_CODE_PREVIEW_DOM_ANCESTORS," +
      "flowAnchorCandidates: MAX_CODE_PREVIEW_FLOW_ANCHOR_CANDIDATES," +
      "flowAnchorNameCodeUnits: MAX_CODE_PREVIEW_FLOW_ANCHOR_NAME_CODE_UNITS," +
      "flowOwnerIdCandidates: MAX_CODE_PREVIEW_FLOW_OWNER_ID_CANDIDATES," +
      "flowOwnerIdCodeUnits: MAX_CODE_PREVIEW_FLOW_OWNER_ID_CODE_UNITS" +
      "}," +
      "selector: CODE_PREVIEW_WORKBENCH_CONTAINER_SELECTOR" +
      "};",
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const sandbox: {
    __openWranglerWorkbenchOwnershipAuthority?: WorkbenchOwnershipAuthority;
    assert: typeof nodeAssert;
  } = { assert: nodeAssert };
  runInNewContext(compiled, sandbox, { timeout: 1_000 });
  expect(sandbox.__openWranglerWorkbenchOwnershipAuthority).toBeDefined();
  return sandbox.__openWranglerWorkbenchOwnershipAuthority!;
}

function rectangle(left: number, top: number, width: number, height: number): FakeRectangle {
  return { bottom: top + height, height, left, right: left + width, top, width };
}

function createFixture(
  authority: WorkbenchOwnershipAuthority,
  options: Readonly<{
    anchorId?: string;
    descriptor?: WorkbenchContainerDescriptor;
    flowOwnerId?: string;
  }> = {}
) {
  const descriptor = options.descriptor ?? SUPPORTED_WORKBENCH_CONTAINERS[1];
  const queryOverrides = new Map<string, ArrayLike<unknown>>();
  const elements: FakeElement[] = [];
  const document: FakeDocument = {
    defaultView: {
      innerHeight: 800,
      innerWidth: 1_280,
      getComputedStyle: (target: unknown) => {
        const element = target as FakeElement;
        let effectiveVisibility = element.style.visibility;
        let current = element.parentElement;
        while (effectiveVisibility === "visible" && current !== null) {
          if (current.style.visibility === "hidden" || current.style.visibility === "collapse") {
            effectiveVisibility = current.style.visibility;
          }
          current = current.parentElement;
        }
        return { ...element.style, visibility: effectiveVisibility };
      }
    },
    documentElement: undefined as unknown as FakeElement,
    getElementById: (id: string) =>
      elements.find(
        (candidate) => candidate.hasIdAttribute && candidate.id === id && document.documentElement.contains(candidate)
      ) ?? null,
    querySelectorAll: (selector: string): ArrayLike<unknown> => {
      const overridden = queryOverrides.get(selector);
      if (overridden !== undefined) return overridden;
      const attached = elements.filter((candidate) => document.documentElement.contains(candidate));
      if (selector === authority.selector) {
        return attached.filter(
          (candidate) =>
            candidate.classList.contains("part") &&
            authority.containers.some(
              (supported) => candidate.id === supported.id && candidate.classList.contains(supported.className)
            )
        );
      }
      if (selector === '[style*="anchor-name"]') {
        return attached.filter((candidate) => candidate.style.getPropertyValue("anchor-name").length > 0);
      }
      if (selector === "[id]") return attached.filter((candidate) => candidate.hasIdAttribute);
      return [];
    }
  };

  const setParent = (element: FakeElement, parent: FakeElement | null): void => {
    if (element.parentElement !== null) {
      const previousIndex = element.parentElement.children.indexOf(element);
      if (previousIndex >= 0) element.parentElement.children.splice(previousIndex, 1);
    }
    element.parentElement = parent;
    if (parent !== null && !parent.children.includes(element)) parent.children.push(element);
  };

  const makeElement = (
    elementOptions: Readonly<{
      classNames?: readonly string[];
      connected?: boolean;
      id?: string;
      parent?: FakeElement | null;
      rectangle?: FakeRectangle;
      styleProperties?: Readonly<Record<string, string>>;
      tagName?: string;
    }> = {}
  ): FakeElement => {
    const classNames = new Set(elementOptions.classNames ?? []);
    const styleProperties = new Map(Object.entries(elementOptions.styleProperties ?? {}));
    let bounds = elementOptions.rectangle ?? rectangle(20, 20, 100, 100);
    const style: FakeStyle = {
      display: "block",
      opacity: "1",
      visibility: "visible",
      getPropertyValue: (name) => styleProperties.get(name) ?? "",
      setProperty: (name, value) => {
        styleProperties.set(name, value);
      }
    };
    const element: FakeElement = {
      children: [],
      classList: { contains: (className) => classNames.has(className) },
      dataset: {},
      hasIdAttribute: elementOptions.id !== undefined,
      id: elementOptions.id ?? "",
      isConnected: elementOptions.connected ?? true,
      ownerDocument: document,
      parentElement: null,
      style,
      tagName: elementOptions.tagName ?? "DIV",
      contains(target) {
        let current = target as FakeElement | null;
        const visited = new Set<FakeElement>();
        while (current !== null && !visited.has(current)) {
          if (current === element) return true;
          visited.add(current);
          current = current.parentElement;
        }
        return false;
      },
      getBoundingClientRect: () => bounds,
      querySelectorAll: (selector) => {
        if (selector !== "iframe") return [];
        return elements.filter(
          (candidate) =>
            candidate !== element &&
            candidate.tagName === "IFRAME" &&
            element.contains(candidate) &&
            document.documentElement.contains(candidate)
        );
      },
      setBoundingClientRect: (nextBounds) => {
        bounds = nextBounds;
      }
    };
    elements.push(element);
    setParent(element, elementOptions.parent ?? null);
    return element;
  };

  const root = makeElement({ id: "workbench-root", rectangle: rectangle(0, 0, 1_280, 800) });
  document.documentElement = root;
  const containerRectangle =
    descriptor.className === "panel"
      ? rectangle(0, 560, 1_280, 240)
      : descriptor.className === "sidebar"
        ? rectangle(0, 0, 320, 800)
        : rectangle(960, 0, 320, 800);
  const contentRectangle =
    descriptor.className === "panel"
      ? rectangle(20, 580, 1_240, 200)
      : descriptor.className === "sidebar"
        ? rectangle(20, 20, 280, 760)
        : rectangle(980, 20, 280, 760);
  const container = makeElement({
    classNames: ["part", descriptor.className],
    id: descriptor.id,
    parent: root,
    rectangle: containerRectangle
  });
  const anchorParent = makeElement({
    classNames: ["pane-body"],
    parent: container,
    rectangle: contentRectangle
  });
  const anchor = makeElement({
    classNames: ["webview-view"],
    id: options.anchorId ?? "",
    parent: anchorParent,
    rectangle: contentRectangle,
    styleProperties: { "anchor-name": FLOW_ANCHOR_NAME }
  });

  // VS Code 1.134 mounts this physical overlay branch at the workbench root,
  // separately from the view-body anchor's supported workbench-part branch.
  const overlayRoot = makeElement({
    classNames: ["webview-overlay"],
    parent: root,
    rectangle: rectangle(0, 0, 1_280, 800)
  });
  const overlayContent = makeElement({
    classNames: ["webview-overlay-content"],
    parent: overlayRoot,
    rectangle: contentRectangle,
    styleProperties: { "position-anchor": FLOW_ANCHOR_NAME }
  });
  overlayContent.dataset.parentFlowToElementId = options.flowOwnerId ?? "";
  const outerFrame = makeElement({
    classNames: ["webview"],
    parent: overlayContent,
    rectangle: contentRectangle,
    tagName: "IFRAME"
  });

  return {
    anchor,
    anchorParent,
    container,
    document,
    makeElement,
    outerFrame,
    overlayContent,
    overlayRoot,
    overrideQuery: (selector: string, candidates: ArrayLike<unknown>) => queryOverrides.set(selector, candidates),
    root,
    setParent
  };
}

function inspectionOptions(
  authority: WorkbenchOwnershipAuthority,
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    containerSelector: authority.selector,
    maximumAncestors: authority.limits.ancestors,
    maximumContainers: authority.containers.length,
    maximumFlowAnchorCandidates: authority.limits.flowAnchorCandidates,
    maximumFlowAnchorNameCodeUnits: authority.limits.flowAnchorNameCodeUnits,
    maximumFlowOwnerIdCandidates: authority.limits.flowOwnerIdCandidates,
    maximumFlowOwnerIdCodeUnits: authority.limits.flowOwnerIdCodeUnits,
    retainElements: true,
    supportedContainers: authority.containers,
    ...overrides
  };
}

function captureOwnership(authority: WorkbenchOwnershipAuthority, fixture: ReturnType<typeof createFixture>) {
  const receipt = authority.inspect(fixture.outerFrame, inspectionOptions(authority));
  expect(receipt.reason).toBe("owned");
  return receipt;
}

function actionOptions(
  authority: WorkbenchOwnershipAuthority,
  fixture: ReturnType<typeof createFixture>,
  acquisition: WorkbenchOwnershipReceipt
): Record<string, unknown> {
  return inspectionOptions(authority, {
    expectedChain: acquisition.chain,
    expectedOuterFrame: fixture.outerFrame,
    expectedOverlayChain: acquisition.overlayChain,
    expectedRelations: acquisition.relations,
    retainElements: false
  });
}

function expectReason(
  authority: WorkbenchOwnershipAuthority,
  receipt: WorkbenchOwnershipReceipt,
  reason: string
): void {
  expect(receipt.reason).toBe(reason);
  expect(() => authority.assertReceipt(receipt, "adversarial ownership probe")).toThrow(
    `adversarial ownership probe rejects the bounded Code Preview workbench ownership receipt: ${reason}.`
  );
}

function guardedArray(length: number): { readonly candidates: ArrayLike<unknown>; readonly indexReads: () => number } {
  let reads = 0;
  const candidates = new Proxy(new Array<unknown>(length), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/u.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  return { candidates, indexReads: () => reads };
}

describe("Code Preview split-overlay workbench ownership", () => {
  const authority = loadAuthority();
  expect(Array.from(authority.containers)).toEqual(SUPPORTED_WORKBENCH_CONTAINERS);
  expect(authority.selector).toBe(SUPPORTED_WORKBENCH_CONTAINER_SELECTOR);

  it("binds the exact live action to the pinned outer iframe, generation topology, bounds, and immediate assertion", () => {
    const source = readFileSync(resolve(process.cwd(), "src/test/extensionHost/index.ts"), "utf8");
    expect(() => assertLiveOwnershipBinding(source)).not.toThrow();
    expect(() => assertAcquisitionOwnershipBinding(source)).not.toThrow();

    const delayedAssertion = replaceExactlyOnce(
      source,
      "  assertCodePreviewWorkbenchOwnershipReceipt(receipt.ownership, description);",
      "  void receipt;\n  assertCodePreviewWorkbenchOwnershipReceipt(receipt.ownership, description);"
    );
    expect(() => assertLiveOwnershipBinding(delayedAssertion)).toThrow(/immediately consume/u);

    const omittedAssertion = replaceExactlyOnce(
      source,
      "  assertCodePreviewWorkbenchOwnershipReceipt(receipt.ownership, description);\n",
      ""
    );
    expect(() => assertLiveOwnershipBinding(omittedAssertion)).toThrow(/consumed immediately/u);

    const wrongAssertionOwner = replaceExactlyOnce(
      source,
      "assertCodePreviewWorkbenchOwnershipReceipt(receipt.ownership, description);",
      "assertCodePreviewWorkbenchOwnershipReceipt(receipt.editor, description);"
    );
    expect(() => assertLiveOwnershipBinding(wrongAssertionOwner)).toThrow(/exact receipt and diagnostic owner/u);

    const wrongEvaluator = replaceExactlyOnce(
      source,
      "const ownership = outerFrame.evaluate(inspectCodePreviewWorkbenchOwnership, {",
      "const ownership = generation.panel.evaluate(inspectCodePreviewWorkbenchOwnership, {"
    );
    expect(() => assertLiveOwnershipBinding(wrongEvaluator)).toThrow(/exact-outer-frame ownership inspection/u);

    const wrongGeneration = replaceExactlyOnce(
      source,
      "expectedChain: generation.ownershipElements,",
      "expectedChain: generation.panelAncestors,"
    );
    expect(() => assertLiveOwnershipBinding(wrongGeneration)).toThrow(/generation, topology, and bound option/u);

    const wrongOuterFrame = replaceExactlyOnce(
      source,
      "expectedOuterFrame: outerFrame,",
      "expectedOuterFrame: generation.panel,"
    );
    expect(() => assertLiveOwnershipBinding(wrongOuterFrame)).toThrow(/generation, topology, and bound option/u);

    const retainedActionElements = replaceExactlyOnce(
      source,
      "expectedRelations: generation.ownershipRelations,\n      maximumAncestors:",
      "expectedRelations: generation.ownershipRelations,\n      retainElements: true,\n      maximumAncestors:"
    );
    expect(() => assertLiveOwnershipBinding(retainedActionElements)).toThrow(/option retainElements must be unique/u);

    const wrongAcquisitionReceiver = replaceExactlyOnce(
      source,
      "outerFrame.evaluateHandle(inspectCodePreviewWorkbenchOwnership, {",
      "outerFrame.evaluate(inspectCodePreviewWorkbenchOwnership, {"
    );
    expect(() => assertAcquisitionOwnershipBinding(wrongAcquisitionReceiver)).toThrow(/atomically retain/u);

    const omittedGenerationCapture = replaceExactlyOnce(
      source,
      "captureCodePreviewWorkbenchOwnership(outerFrame, bounded, deadline, description)",
      "captureCodePreviewWorkbenchOwnershipFromPanel(outerFrame, bounded, deadline, description)"
    );
    expect(() => assertAcquisitionOwnershipBinding(omittedGenerationCapture)).toThrow(/capture exactly one/u);

    const wrongSoleFrame = replaceExactlyOnce(
      source,
      "      overlayContent,\n      outerFrame,\n      bounded,",
      "      overlayContent,\n      panel,\n      bounded,"
    );
    expect(() => assertAcquisitionOwnershipBinding(wrongSoleFrame)).toThrow(/exact captured content and outer iframe/u);
  });

  it.each(SUPPORTED_WORKBENCH_CONTAINERS)(
    "accepts the faithful workbench-root overlay and $className anchor branches",
    (descriptor) => {
      const fixture = createFixture(authority, { descriptor });
      expect(fixture.container.contains(fixture.anchor)).toBe(true);
      expect(fixture.container.contains(fixture.outerFrame)).toBe(false);
      expect(fixture.overlayRoot.contains(fixture.outerFrame)).toBe(true);
      expect(fixture.overlayRoot.parentElement).toBe(fixture.root);
      expect(fixture.container.parentElement).toBe(fixture.root);

      const receipt = captureOwnership(authority, fixture);
      expect(receipt).toMatchObject({
        chainLength: 5,
        containerIndex: 3,
        flowLinkCount: 1,
        overlayChainLength: 2,
        reason: "owned"
      });
      expect(Array.from(receipt.chain)).toEqual([
        fixture.overlayContent,
        fixture.anchor,
        fixture.anchorParent,
        fixture.container,
        fixture.root
      ]);
      expect(Array.from(receipt.overlayChain)).toEqual([fixture.overlayRoot, fixture.root]);
      expect(JSON.parse(JSON.stringify(receipt.relations))).toEqual([
        { kind: "parent" },
        { anchorName: FLOW_ANCHOR_NAME, flowOwnerId: "", kind: "flow" },
        { kind: "parent" },
        { kind: "parent" },
        { kind: "parent" }
      ]);
      expect(() => authority.assertReceipt(receipt, `${descriptor.className} acquisition`)).not.toThrow();

      const actionReceipt = authority.inspect(fixture.outerFrame, actionOptions(authority, fixture, receipt));
      expect(actionReceipt).toMatchObject({
        chain: [],
        chainLength: receipt.chainLength,
        containerIndex: receipt.containerIndex,
        overlayChain: [],
        overlayChainLength: receipt.overlayChainLength,
        reason: "owned"
      });
      expect(() => authority.assertReceipt(actionReceipt, `${descriptor.className} action`)).not.toThrow();
    }
  );

  it("accepts the exact non-empty flow owner only when its CSS anchor and DOM id resolve to one element", () => {
    const fixture = createFixture(authority, {
      anchorId: "workbench-view-code-preview",
      flowOwnerId: "workbench-view-code-preview"
    });
    const receipt = captureOwnership(authority, fixture);
    expect(receipt.relations[1]).toEqual({
      anchorName: FLOW_ANCHOR_NAME,
      flowOwnerId: "workbench-view-code-preview",
      kind: "flow"
    });

    const mismatch = createFixture(authority, {
      anchorId: "workbench-view-code-preview",
      flowOwnerId: "different-workbench-view"
    });
    const other = mismatch.makeElement({ id: "different-workbench-view", parent: mismatch.container });
    expect(other).not.toBe(mismatch.anchor);
    expectReason(
      authority,
      authority.inspect(mismatch.outerFrame, inspectionOptions(authority)),
      "flow-owner-anchor-mismatch"
    );
  });

  it("reports attachment, zero-layout, style visibility, overlay visibility, and nearest-part failures independently", () => {
    const detached = createFixture(authority);
    detached.outerFrame.isConnected = false;
    expectReason(
      authority,
      authority.inspect(detached.outerFrame, inspectionOptions(authority)),
      "outer-frame-detached"
    );

    const detachedContainer = createFixture(authority);
    detachedContainer.container.isConnected = false;
    expectReason(
      authority,
      authority.inspect(detachedContainer.outerFrame, inspectionOptions(authority)),
      "container-detached"
    );

    const zeroLayout = createFixture(authority);
    zeroLayout.outerFrame.setBoundingClientRect(rectangle(980, 20, 0, 760));
    expectReason(
      authority,
      authority.inspect(zeroLayout.outerFrame, inspectionOptions(authority)),
      "outer-frame-zero-layout"
    );

    const hiddenOuterFrame = createFixture(authority);
    hiddenOuterFrame.outerFrame.style.visibility = "hidden";
    expectReason(
      authority,
      authority.inspect(hiddenOuterFrame.outerFrame, inspectionOptions(authority)),
      "outer-frame-hidden"
    );

    const hiddenContainer = createFixture(authority);
    hiddenContainer.container.style.visibility = "hidden";
    expectReason(
      authority,
      authority.inspect(hiddenContainer.outerFrame, inspectionOptions(authority)),
      "container-hidden"
    );

    const hiddenOwnershipChain = createFixture(authority);
    hiddenOwnershipChain.anchorParent.style.opacity = "0";
    expectReason(
      authority,
      authority.inspect(hiddenOwnershipChain.outerFrame, inspectionOptions(authority)),
      "ownership-chain-hidden"
    );

    const hiddenWorkbenchAncestor = createFixture(authority);
    const workbenchAncestor = hiddenWorkbenchAncestor.makeElement({
      parent: hiddenWorkbenchAncestor.root,
      rectangle: rectangle(0, 0, 1_280, 800)
    });
    hiddenWorkbenchAncestor.setParent(hiddenWorkbenchAncestor.container, workbenchAncestor);
    workbenchAncestor.style.opacity = "0";
    expectReason(
      authority,
      authority.inspect(hiddenWorkbenchAncestor.outerFrame, inspectionOptions(authority)),
      "workbench-ancestor-hidden"
    );

    const hiddenOverlay = createFixture(authority);
    hiddenOverlay.overlayRoot.style.opacity = "0";
    expectReason(
      authority,
      authority.inspect(hiddenOverlay.outerFrame, inspectionOptions(authority)),
      "overlay-chain-hidden"
    );

    const unsupported = createFixture(authority);
    const editorPart = unsupported.makeElement({
      classNames: ["part", "editor"],
      id: "workbench.parts.editor",
      parent: unsupported.anchorParent,
      rectangle: rectangle(980, 20, 280, 760)
    });
    unsupported.setParent(unsupported.anchor, editorPart);
    expectReason(
      authority,
      authority.inspect(unsupported.outerFrame, inspectionOptions(authority)),
      "unsupported-nearest-workbench-part"
    );
  });

  it("fails closed for a second overlay iframe, duplicate CSS anchor, and ambiguous visible part owner", () => {
    const duplicateFrame = createFixture(authority);
    duplicateFrame.makeElement({
      parent: duplicateFrame.overlayContent,
      rectangle: rectangle(980, 20, 280, 760),
      tagName: "IFRAME"
    });
    expectReason(
      authority,
      authority.inspect(duplicateFrame.outerFrame, inspectionOptions(authority)),
      "overlay-outer-frame-not-exact"
    );

    const duplicateAnchor = createFixture(authority);
    duplicateAnchor.makeElement({
      parent: duplicateAnchor.anchorParent,
      rectangle: rectangle(980, 20, 280, 760),
      styleProperties: { "anchor-name": FLOW_ANCHOR_NAME }
    });
    expectReason(
      authority,
      authority.inspect(duplicateAnchor.outerFrame, inspectionOptions(authority)),
      "flow-anchor-not-unique"
    );

    const ambiguousOwner = createFixture(authority, { descriptor: SUPPORTED_WORKBENCH_CONTAINERS[0] });
    const sidebar = ambiguousOwner.makeElement({
      classNames: ["part", "sidebar"],
      id: "workbench.parts.sidebar",
      parent: ambiguousOwner.root,
      rectangle: rectangle(0, 0, 320, 800)
    });
    ambiguousOwner.setParent(ambiguousOwner.container, sidebar);
    expectReason(
      authority,
      authority.inspect(ambiguousOwner.outerFrame, inspectionOptions(authority)),
      "visible-container-owner-not-unique"
    );

    const duplicateContainer = createFixture(authority);
    duplicateContainer.makeElement({
      classNames: ["part", "auxiliarybar"],
      id: "workbench.parts.auxiliarybar",
      parent: duplicateContainer.root,
      rectangle: rectangle(960, 0, 320, 800)
    });
    expectReason(
      authority,
      authority.inspect(duplicateContainer.outerFrame, inspectionOptions(authority)),
      "supported-container-identity-duplicate"
    );
  });

  it("rejects anchor, physical overlay, generation, and link replacement against the acquired receipt", () => {
    const anchorReparented = createFixture(authority);
    const anchorAcquisition = captureOwnership(authority, anchorReparented);
    const anchorWrapper = anchorReparented.makeElement({
      parent: anchorReparented.anchorParent,
      rectangle: rectangle(980, 20, 280, 760)
    });
    anchorReparented.setParent(anchorReparented.anchor, anchorWrapper);
    expectReason(
      authority,
      authority.inspect(anchorReparented.outerFrame, actionOptions(authority, anchorReparented, anchorAcquisition)),
      "ownership-chain-replaced"
    );

    const overlayReparented = createFixture(authority);
    const overlayAcquisition = captureOwnership(authority, overlayReparented);
    const overlayWrapper = overlayReparented.makeElement({
      parent: overlayReparented.root,
      rectangle: rectangle(0, 0, 1_280, 800)
    });
    overlayReparented.setParent(overlayReparented.overlayRoot, overlayWrapper);
    expectReason(
      authority,
      authority.inspect(overlayReparented.outerFrame, actionOptions(authority, overlayReparented, overlayAcquisition)),
      "overlay-chain-replaced"
    );

    const replacedGeneration = createFixture(authority);
    const generationAcquisition = captureOwnership(authority, replacedGeneration);
    replacedGeneration.setParent(replacedGeneration.outerFrame, null);
    replacedGeneration.outerFrame.isConnected = false;
    const replacement = replacedGeneration.makeElement({
      parent: replacedGeneration.overlayContent,
      rectangle: rectangle(980, 20, 280, 760),
      tagName: "IFRAME"
    });
    expectReason(
      authority,
      authority.inspect(replacement, actionOptions(authority, replacedGeneration, generationAcquisition)),
      "outer-frame-replaced"
    );

    const changedLink = createFixture(authority);
    const linkAcquisition = captureOwnership(authority, changedLink);
    changedLink.anchor.id = "late-anchor-id";
    changedLink.overlayContent.dataset.parentFlowToElementId = "late-anchor-id";
    expectReason(
      authority,
      authority.inspect(changedLink.outerFrame, actionOptions(authority, changedLink, linkAcquisition)),
      "ownership-link-replaced"
    );
  });

  it("rejects bounded candidate inventories before reading candidate elements", () => {
    const anchorInventory = createFixture(authority);
    const excessiveAnchors = guardedArray(authority.limits.flowAnchorCandidates + 1);
    anchorInventory.overrideQuery('[style*="anchor-name"]', excessiveAnchors.candidates);
    expectReason(
      authority,
      authority.inspect(anchorInventory.outerFrame, inspectionOptions(authority)),
      "flow-anchor-inventory-over-bound"
    );
    expect(excessiveAnchors.indexReads()).toBe(0);

    const containerInventory = createFixture(authority);
    const excessiveContainers = guardedArray(authority.containers.length + 1);
    containerInventory.overrideQuery(authority.selector, excessiveContainers.candidates);
    expectReason(
      authority,
      authority.inspect(containerInventory.outerFrame, inspectionOptions(authority)),
      "supported-container-inventory-over-bound"
    );
    expect(excessiveContainers.indexReads()).toBe(0);

    const ownerIdInventory = createFixture(authority, { anchorId: "anchor", flowOwnerId: "anchor" });
    const excessiveOwnerIds = guardedArray(authority.limits.flowOwnerIdCandidates + 1);
    ownerIdInventory.overrideQuery("[id]", excessiveOwnerIds.candidates);
    expectReason(
      authority,
      authority.inspect(ownerIdInventory.outerFrame, inspectionOptions(authority)),
      "flow-owner-id-inventory-over-bound"
    );
    expect(excessiveOwnerIds.indexReads()).toBe(0);

    const excessiveOwnershipChain = createFixture(authority);
    let wrapperParent = excessiveOwnershipChain.container;
    for (let index = 0; index < authority.limits.ancestors; index += 1) {
      wrapperParent = excessiveOwnershipChain.makeElement({ parent: wrapperParent });
    }
    excessiveOwnershipChain.setParent(excessiveOwnershipChain.anchorParent, wrapperParent);
    expectReason(
      authority,
      authority.inspect(excessiveOwnershipChain.outerFrame, inspectionOptions(authority)),
      "ownership-chain-over-bound"
    );
  });
});
