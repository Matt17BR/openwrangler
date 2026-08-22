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
    documentElements: number;
    flowAnchorCandidates: number;
    flowAnchorNameCodeUnits: number;
    flowOwnerIdCandidates: number;
    flowOwnerIdCodeUnits: number;
    overlayElements: number;
  }>;
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
}

interface FakeElement {
  readonly children: FakeElement[];
  readonly classList: { contains(className: string): boolean };
  readonly dataset: { parentFlowToElementId?: string };
  readonly firstElementChild: FakeElement | null;
  readonly hasIdAttribute: boolean;
  readonly ownerDocument: FakeDocument;
  readonly nextElementSibling: FakeElement | null;
  readonly style: FakeStyle;
  readonly tagName: string;
  id: string;
  isConnected: boolean;
  parentElement: FakeElement | null;
  contains(target: unknown): boolean;
  getBoundingClientRect(): FakeRectangle;
  hasAttribute(name: string): boolean;
  setBoundingClientRect(rectangle: FakeRectangle): void;
}

const LIVE_ACTION_FUNCTION = "assertLiveCodePreviewActionOwnership";
const CAPTURE_OWNERSHIP_FUNCTION = "captureCodePreviewWorkbenchOwnership";
const CAPTURE_GENERATION_FUNCTION = "captureCodePreviewWorkbenchGeneration";
const LIVE_INVOCATION_FUNCTION = "invokeLiveCodePreviewActionWithOwnership";
const EDIT_LIVE_INVOCATION_FUNCTION = "editLiveCodePreviewAndInvoke";
const OWNERSHIP_ASSERTION_HELPER = "assertCodePreviewWorkbenchOwnershipReceipt";
const OWNERSHIP_INSPECTOR = "inspectCodePreviewWorkbenchOwnership";
const FLOW_ANCHOR_NAME = "--overlay-anchor-code-preview";

const SUPPORTED_WORKBENCH_CONTAINERS = [
  { className: "panel", id: "workbench.parts.panel" },
  { className: "auxiliarybar", id: "workbench.parts.auxiliarybar" },
  { className: "sidebar", id: "workbench.parts.sidebar" }
] as const;

function replaceExactlyOnce(source: string, from: string, to: string): string {
  nodeAssert.equal(source.split(from).length - 1, 1, `Expected exactly one source fragment: ${from}`);
  return source.replace(from, to);
}

function replaceTopLevelFunctionBody(source: string, name: string, replacement: string): string {
  const syntax = ts.createSourceFile("extensionHost/index.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const declaration = syntax.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  nodeAssert.ok(declaration?.body, `Missing ${name} function body.`);
  return `${source.slice(0, declaration.body.getStart(syntax))}${replacement}${source.slice(declaration.body.end)}`;
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
    ["expectedChain", "generation.ownershipElements"],
    ["expectedOuterFrame", "outerFrame"],
    ["expectedOverlayChain", "generation.overlayElements"],
    ["expectedRelations", "generation.ownershipRelations"],
    ["maximumAncestors", "MAX_CODE_PREVIEW_DOM_ANCESTORS"],
    ["maximumContainers", "CODE_PREVIEW_WORKBENCH_CONTAINERS.length"],
    ["maximumDocumentElements", "MAX_CODE_PREVIEW_WORKBENCH_DOCUMENT_ELEMENTS"],
    ["maximumFlowAnchorCandidates", "MAX_CODE_PREVIEW_FLOW_ANCHOR_CANDIDATES"],
    ["maximumFlowAnchorNameCodeUnits", "MAX_CODE_PREVIEW_FLOW_ANCHOR_NAME_CODE_UNITS"],
    ["maximumFlowOwnerIdCandidates", "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CANDIDATES"],
    ["maximumFlowOwnerIdCodeUnits", "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CODE_UNITS"],
    ["maximumOverlayElements", "MAX_CODE_PREVIEW_OVERLAY_ELEMENTS"],
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
    ["maximumAncestors", "MAX_CODE_PREVIEW_DOM_ANCESTORS"],
    ["maximumContainers", "CODE_PREVIEW_WORKBENCH_CONTAINERS.length"],
    ["maximumDocumentElements", "MAX_CODE_PREVIEW_WORKBENCH_DOCUMENT_ELEMENTS"],
    ["maximumFlowAnchorCandidates", "MAX_CODE_PREVIEW_FLOW_ANCHOR_CANDIDATES"],
    ["maximumFlowAnchorNameCodeUnits", "MAX_CODE_PREVIEW_FLOW_ANCHOR_NAME_CODE_UNITS"],
    ["maximumFlowOwnerIdCandidates", "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CANDIDATES"],
    ["maximumFlowOwnerIdCodeUnits", "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CODE_UNITS"],
    ["maximumOverlayElements", "MAX_CODE_PREVIEW_OVERLAY_ELEMENTS"],
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
  const soleOverlayCapture = findFunction("captureSoleCodePreviewOverlayFrameElement");
  const materializedInventories = descendantCalls(soleOverlayCapture.body!).filter(
    (call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "querySelectorAll"
  );
  nodeAssert.equal(
    materializedInventories.length,
    0,
    "Sole-overlay acquisition must not materialize an iframe candidate inventory."
  );
  const boundedCaptures = descendantCalls(soleOverlayCapture.body!).filter(
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === "overlayContent" &&
      call.expression.name.text === "evaluateHandle"
  );
  nodeAssert.equal(boundedCaptures.length, 1, "Sole-overlay acquisition must retain one bounded renderer operation.");
  const captureOptions = boundedCaptures[0].arguments[1];
  nodeAssert.ok(ts.isObjectLiteralExpression(captureOptions), "Sole-overlay acquisition bounds must remain explicit.");
  nodeAssert.deepEqual(
    captureOptions.properties.map((property) => property.getText(syntax)),
    ["expected: expectedOuterFrame", "maximumElements: MAX_CODE_PREVIEW_OVERLAY_ELEMENTS"],
    "Sole-overlay acquisition must bind its exact frame and element cap."
  );
}

function assertLiveInvocationBinding(source: string): void {
  const syntax = ts.createSourceFile("extensionHost/index.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const findFunction = (name: string): ts.FunctionDeclaration => {
    const declaration = syntax.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name
    );
    nodeAssert.ok(declaration?.body, `${name} must remain a top-level function with a body.`);
    return declaration;
  };

  const invocation = findFunction(LIVE_INVOCATION_FUNCTION);
  const invocationStatements = Array.from(invocation.body!.statements);
  nodeAssert.equal(invocationStatements.length, 2, "The live invocation must retain one final receipt and one action.");
  const receipt = directVariable(invocationStatements, "receipt").declaration;
  nodeAssert.ok(
    receipt.initializer &&
      ts.isAwaitExpression(receipt.initializer) &&
      ts.isCallExpression(receipt.initializer.expression),
    "The live invocation must await its authoritative action receipt before dispatch."
  );
  const receiptCall = receipt.initializer.expression;
  nodeAssert.ok(
    ts.isIdentifier(receiptCall.expression) && receiptCall.expression.text === LIVE_ACTION_FUNCTION,
    `The live invocation must obtain its receipt from ${LIVE_ACTION_FUNCTION}.`
  );
  nodeAssert.deepEqual(
    receiptCall.arguments.map((argument) => argument.getText(syntax)),
    ["workbench", "generation", "selectedFrame", "target", "selector", "currentReceipt", "bounded", "description"],
    "The live invocation must bind its final receipt to every exact generation and action owner."
  );
  const dispatchStatement = invocationStatements[1];
  nodeAssert.ok(
    ts.isReturnStatement(dispatchStatement) &&
      dispatchStatement.expression !== undefined &&
      ts.isCallExpression(dispatchStatement.expression),
    "The live invocation must immediately return one receipt-consuming dispatch."
  );
  const dispatch = dispatchStatement.expression;
  nodeAssert.ok(
    ts.isIdentifier(dispatch.expression) && dispatch.expression.text === "invokeCodePreviewActionAfterDispatchBoundary",
    "The live invocation must not bypass the receipt-consuming action boundary."
  );
  nodeAssert.equal(
    dispatch.arguments[0]?.getText(syntax),
    "receipt",
    "The dispatch must consume the exact live receipt."
  );
  nodeAssert.equal(
    dispatch.arguments[2]?.getText(syntax),
    "action",
    "The dispatch must invoke only the supplied action."
  );

  const editInvocation = findFunction(EDIT_LIVE_INVOCATION_FUNCTION);
  const callSites = descendantCalls(editInvocation.body!).filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === LIVE_INVOCATION_FUNCTION
  );
  nodeAssert.equal(callSites.length, 1, "The packaged edit path must retain exactly one live invocation call site.");
  const callSite = callSites[0];
  nodeAssert.deepEqual(
    callSite.arguments.slice(0, 7).map((argument) => argument.getText(syntax)),
    ["workbench", "selectedGeneration", "selectedFrame", "target", "selector", "replacementReceipt", "bounded"],
    "The packaged call site must pass every exact live generation owner."
  );
  nodeAssert.equal(
    callSite.arguments[7]?.getText(syntax),
    "`${description} authoritative final live action ownership`",
    "The packaged call site must preserve the final ownership diagnostic."
  );
  nodeAssert.ok(
    ts.isArrowFunction(callSite.arguments[8]),
    "The packaged call site must own one bounded action callback."
  );
  nodeAssert.ok(ts.isReturnStatement(callSite.parent), "The final live invocation must remain the returned action.");
  const actionBlock = callSite.parent.parent;
  nodeAssert.ok(ts.isBlock(actionBlock), "The final live invocation must remain inside the bounded execute block.");
  const callIndex = actionBlock.statements.indexOf(callSite.parent);
  const boundaryMutation = actionBlock.statements[callIndex - 1];
  nodeAssert.ok(
    boundaryMutation &&
      ts.isIfStatement(boundaryMutation) &&
      boundaryMutation.expression.getText(syntax) === "options.boundaryTestHook",
    "The final live invocation must immediately follow the optional action-boundary mutation."
  );
}

function loadAuthority(): WorkbenchOwnershipAuthority {
  const path = resolve(process.cwd(), "src/test/extensionHost/index.ts");
  const source = readFileSync(path, "utf8");
  assertLiveOwnershipBinding(source);
  assertLiveInvocationBinding(source);
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const variables = new Set([
    "MAX_CODE_PREVIEW_DOM_ANCESTORS",
    "MAX_CODE_PREVIEW_WORKBENCH_DOCUMENT_ELEMENTS",
    "MAX_CODE_PREVIEW_OVERLAY_ELEMENTS",
    "MAX_CODE_PREVIEW_FLOW_ANCHOR_CANDIDATES",
    "MAX_CODE_PREVIEW_FLOW_ANCHOR_NAME_CODE_UNITS",
    "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CANDIDATES",
    "MAX_CODE_PREVIEW_FLOW_OWNER_ID_CODE_UNITS",
    "CODE_PREVIEW_WORKBENCH_CONTAINERS"
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
  expect(selected).toHaveLength(10);
  const compiled = ts.transpileModule(
    `${selected.map((statement) => statement.getText(syntax)).join("\n")}\n` +
      "globalThis.__openWranglerWorkbenchOwnershipAuthority = {" +
      "assertReceipt: assertCodePreviewWorkbenchOwnershipReceipt," +
      "containers: CODE_PREVIEW_WORKBENCH_CONTAINERS," +
      "inspect: inspectCodePreviewWorkbenchOwnership," +
      "limits: {" +
      "ancestors: MAX_CODE_PREVIEW_DOM_ANCESTORS," +
      "documentElements: MAX_CODE_PREVIEW_WORKBENCH_DOCUMENT_ELEMENTS," +
      "flowAnchorCandidates: MAX_CODE_PREVIEW_FLOW_ANCHOR_CANDIDATES," +
      "flowAnchorNameCodeUnits: MAX_CODE_PREVIEW_FLOW_ANCHOR_NAME_CODE_UNITS," +
      "flowOwnerIdCandidates: MAX_CODE_PREVIEW_FLOW_OWNER_ID_CANDIDATES," +
      "flowOwnerIdCodeUnits: MAX_CODE_PREVIEW_FLOW_OWNER_ID_CODE_UNITS," +
      "overlayElements: MAX_CODE_PREVIEW_OVERLAY_ELEMENTS" +
      "}" +
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
  const descriptor = options.descriptor ?? authority.containers[1];
  const traversalReads = new Map<FakeElement, number>();
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
    documentElement: undefined as unknown as FakeElement
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
      get firstElementChild() {
        traversalReads.set(element, (traversalReads.get(element) ?? 0) + 1);
        return element.children[0] ?? null;
      },
      hasIdAttribute: elementOptions.id !== undefined,
      id: elementOptions.id ?? "",
      isConnected: elementOptions.connected ?? true,
      ownerDocument: document,
      get nextElementSibling() {
        traversalReads.set(element, (traversalReads.get(element) ?? 0) + 1);
        const parent = element.parentElement;
        if (parent === null) return null;
        const index = parent.children.indexOf(element);
        return index >= 0 ? (parent.children[index + 1] ?? null) : null;
      },
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
      hasAttribute: (name) => name === "id" && element.hasIdAttribute,
      setBoundingClientRect: (nextBounds) => {
        bounds = nextBounds;
      }
    };
    setParent(element, elementOptions.parent ?? null);
    return element;
  };

  const documentRoot = makeElement({ rectangle: rectangle(0, 0, 1_280, 800), tagName: "HTML" });
  document.documentElement = documentRoot;
  const body = makeElement({ parent: documentRoot, rectangle: rectangle(0, 0, 1_280, 800), tagName: "BODY" });
  const root = makeElement({
    classNames: ["monaco-workbench"],
    id: "workbench-root",
    parent: body,
    rectangle: rectangle(0, 0, 1_280, 800)
  });
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
    body,
    container,
    document,
    documentRoot,
    makeElement,
    outerFrame,
    overlayContent,
    overlayRoot,
    root,
    setParent,
    traversalReads: (element: FakeElement) => traversalReads.get(element) ?? 0
  };
}

function inspectionOptions(
  authority: WorkbenchOwnershipAuthority,
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    maximumAncestors: authority.limits.ancestors,
    maximumContainers: authority.containers.length,
    maximumDocumentElements: authority.limits.documentElements,
    maximumFlowAnchorCandidates: authority.limits.flowAnchorCandidates,
    maximumFlowAnchorNameCodeUnits: authority.limits.flowAnchorNameCodeUnits,
    maximumFlowOwnerIdCandidates: authority.limits.flowOwnerIdCandidates,
    maximumFlowOwnerIdCodeUnits: authority.limits.flowOwnerIdCodeUnits,
    maximumOverlayElements: authority.limits.overlayElements,
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

describe("Code Preview split-overlay workbench ownership", () => {
  const authority = loadAuthority();
  expect(Array.from(authority.containers)).toEqual(SUPPORTED_WORKBENCH_CONTAINERS);

  it("binds the exact live action to the pinned outer iframe, generation topology, bounds, and immediate assertion", () => {
    const source = readFileSync(resolve(process.cwd(), "src/test/extensionHost/index.ts"), "utf8");
    expect(() => assertLiveOwnershipBinding(source)).not.toThrow();
    expect(() => assertAcquisitionOwnershipBinding(source)).not.toThrow();
    expect(() => assertLiveInvocationBinding(source)).not.toThrow();

    const directActionBypass = replaceTopLevelFunctionBody(
      source,
      LIVE_INVOCATION_FUNCTION,
      "{\n  return action();\n}"
    );
    expect(() => assertLiveInvocationBinding(directActionBypass)).toThrow(/receipt and one action/u);

    const movedCallSite = replaceExactlyOnce(
      source,
      "        await mutation.mutate();\n      }\n      return invokeLiveCodePreviewActionWithOwnership(",
      "        await mutation.mutate();\n      }\n      void target;\n      return invokeLiveCodePreviewActionWithOwnership("
    );
    expect(() => assertLiveInvocationBinding(movedCallSite)).toThrow(/immediately follow/u);

    const omittedCallSite = replaceExactlyOnce(
      source,
      "      return invokeLiveCodePreviewActionWithOwnership(",
      "      return invokeLiveCodePreviewActionWithoutOwnership("
    );
    expect(() => assertLiveInvocationBinding(omittedCallSite)).toThrow(/exactly one live invocation/u);

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

    const materializedSoleInventory = replaceExactlyOnce(
      source,
      "          const root = element as unknown as Candidate;",
      '          void (element as unknown as { querySelectorAll(selector: string): unknown }).querySelectorAll("iframe");\n' +
        "          const root = element as unknown as Candidate;"
    );
    expect(() => assertAcquisitionOwnershipBinding(materializedSoleInventory)).toThrow(/must not materialize/u);
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
      expect(fixture.root.classList.contains("monaco-workbench")).toBe(true);
      expect(fixture.root.parentElement).toBe(fixture.body);
      expect(fixture.body.parentElement).toBe(fixture.documentRoot);

      const receipt = captureOwnership(authority, fixture);
      expect(receipt).toMatchObject({
        chainLength: 7,
        containerIndex: 3,
        flowLinkCount: 1,
        overlayChainLength: 4,
        reason: "owned"
      });
      expect(Array.from(receipt.chain)).toEqual([
        fixture.overlayContent,
        fixture.anchor,
        fixture.anchorParent,
        fixture.container,
        fixture.root,
        fixture.body,
        fixture.documentRoot
      ]);
      expect(Array.from(receipt.overlayChain)).toEqual([
        fixture.overlayRoot,
        fixture.root,
        fixture.body,
        fixture.documentRoot
      ]);
      expect(JSON.parse(JSON.stringify(receipt.relations))).toEqual([
        { kind: "parent" },
        { anchorName: FLOW_ANCHOR_NAME, flowOwnerId: "", kind: "flow" },
        { kind: "parent" },
        { kind: "parent" },
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
      "overlay-root-hidden"
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

  it("requires one exact root-mounted workbench and overlay owner", () => {
    const decoy = createFixture(authority);
    const decoyRoot = decoy.makeElement({ parent: decoy.body, rectangle: rectangle(0, 0, 1_280, 800) });
    decoy.setParent(decoy.overlayRoot, decoyRoot);
    expectReason(
      authority,
      authority.inspect(decoy.outerFrame, inspectionOptions(authority)),
      "missing-monaco-workbench-root"
    );

    const duplicateWorkbench = createFixture(authority);
    duplicateWorkbench.makeElement({
      classNames: ["monaco-workbench"],
      parent: duplicateWorkbench.body,
      rectangle: rectangle(0, 0, 1_280, 800)
    });
    expectReason(
      authority,
      authority.inspect(duplicateWorkbench.outerFrame, inspectionOptions(authority)),
      "workbench-root-not-unique"
    );

    const wrongWorkbench = createFixture(authority);
    const unrelatedWorkbench = wrongWorkbench.makeElement({
      classNames: ["monaco-workbench"],
      parent: wrongWorkbench.body,
      rectangle: rectangle(0, 0, 1_280, 800)
    });
    wrongWorkbench.setParent(wrongWorkbench.overlayRoot, unrelatedWorkbench);
    expectReason(
      authority,
      authority.inspect(wrongWorkbench.outerFrame, inspectionOptions(authority)),
      "workbench-root-not-exact"
    );

    const duplicateOverlay = createFixture(authority);
    duplicateOverlay.makeElement({
      classNames: ["webview-overlay"],
      parent: duplicateOverlay.root,
      rectangle: rectangle(0, 0, 1_280, 800)
    });
    expectReason(
      authority,
      authority.inspect(duplicateOverlay.outerFrame, inspectionOptions(authority)),
      "webview-overlay-root-not-unique"
    );

    const detachedWorkbench = createFixture(authority);
    detachedWorkbench.root.isConnected = false;
    expectReason(
      authority,
      authority.inspect(detachedWorkbench.outerFrame, inspectionOptions(authority)),
      "workbench-root-detached"
    );

    const detachedOverlay = createFixture(authority);
    detachedOverlay.overlayRoot.isConnected = false;
    expectReason(
      authority,
      authority.inspect(detachedOverlay.outerFrame, inspectionOptions(authority)),
      "overlay-root-detached"
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
    const overlayReplacement = overlayReparented.makeElement({
      classNames: ["webview-overlay"],
      parent: overlayReparented.root,
      rectangle: rectangle(0, 0, 1_280, 800)
    });
    overlayReparented.setParent(overlayReparented.overlayRoot, null);
    overlayReparented.overlayRoot.isConnected = false;
    overlayReparented.setParent(overlayReparented.overlayContent, overlayReplacement);
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

  it("stops every ownership inventory at its exact cap before traversing later elements", () => {
    const anchorInventory = createFixture(authority);
    anchorInventory.makeElement({
      parent: anchorInventory.anchorParent,
      styleProperties: { "anchor-name": "--overlay-anchor-other-1" }
    });
    anchorInventory.makeElement({
      parent: anchorInventory.anchorParent,
      styleProperties: { "anchor-name": "--overlay-anchor-other-2" }
    });
    const anchorSentinel = anchorInventory.makeElement({ parent: anchorInventory.anchorParent });
    expectReason(
      authority,
      authority.inspect(anchorInventory.outerFrame, inspectionOptions(authority, { maximumFlowAnchorCandidates: 2 })),
      "flow-anchor-inventory-over-bound"
    );
    expect(anchorInventory.traversalReads(anchorSentinel)).toBe(0);

    const containerInventory = createFixture(authority);
    for (let index = 0; index < authority.containers.length; index += 1) {
      const descriptor = authority.containers[index];
      containerInventory.makeElement({
        classNames: ["part", descriptor.className],
        id: descriptor.id,
        parent: containerInventory.root
      });
    }
    const containerSentinel = containerInventory.makeElement({ parent: containerInventory.root });
    expectReason(
      authority,
      authority.inspect(containerInventory.outerFrame, inspectionOptions(authority)),
      "supported-container-inventory-over-bound"
    );
    expect(containerInventory.traversalReads(containerSentinel)).toBe(0);

    const ownerIdInventory = createFixture(authority, { anchorId: "anchor", flowOwnerId: "anchor" });
    ownerIdInventory.makeElement({ id: "other-1", parent: ownerIdInventory.anchorParent });
    ownerIdInventory.makeElement({ id: "other-2", parent: ownerIdInventory.anchorParent });
    const ownerIdSentinel = ownerIdInventory.makeElement({ parent: ownerIdInventory.anchorParent });
    expectReason(
      authority,
      authority.inspect(ownerIdInventory.outerFrame, inspectionOptions(authority, { maximumFlowOwnerIdCandidates: 4 })),
      "flow-owner-id-inventory-over-bound"
    );
    expect(ownerIdInventory.traversalReads(ownerIdSentinel)).toBe(0);

    const overlayInventory = createFixture(authority);
    overlayInventory.makeElement({ parent: overlayInventory.overlayContent });
    const overlaySentinel = overlayInventory.makeElement({ parent: overlayInventory.overlayContent });
    expectReason(
      authority,
      authority.inspect(overlayInventory.outerFrame, inspectionOptions(authority, { maximumOverlayElements: 2 })),
      "overlay-element-inventory-over-bound"
    );
    expect(overlayInventory.traversalReads(overlaySentinel)).toBe(0);

    const documentInventory = createFixture(authority);
    documentInventory.makeElement({ parent: documentInventory.root });
    const documentSentinel = documentInventory.makeElement({ parent: documentInventory.root });
    expectReason(
      authority,
      authority.inspect(documentInventory.outerFrame, inspectionOptions(authority, { maximumDocumentElements: 9 })),
      "document-element-inventory-over-bound"
    );
    expect(documentInventory.traversalReads(documentSentinel)).toBe(0);

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
