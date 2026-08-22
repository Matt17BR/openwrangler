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

interface WorkbenchContainerAuthority {
  readonly assertActionReceipt: (
    receipt: Record<string, unknown>,
    expectedAncestorCount: number,
    description: string
  ) => void;
  readonly assertReceipt: (receipt: Record<string, unknown>, description: string) => void;
  readonly containers: readonly WorkbenchContainerDescriptor[];
  readonly inspect: (container: unknown, options: Record<string, unknown>) => Record<string, unknown>;
  readonly select: (outerFrame: unknown, options: Record<string, unknown>) => unknown;
  readonly selector: string;
}

const LIVE_ACTION_FUNCTION = "assertLiveCodePreviewActionOwnership";
const LIVE_PANEL_ASSERTION_HELPER = "assertCodePreviewWorkbenchContainerActionChain";

interface FakeElement {
  readonly classList: { contains(className: string): boolean };
  readonly id: string;
  isConnected: boolean;
  ownerDocument: FakeDocument;
  parentElement: FakeElement | null;
  style: { display: string; opacity: string; visibility: string };
  contains(target: unknown): boolean;
  getBoundingClientRect(): { bottom: number; height: number; left: number; right: number; top: number; width: number };
  querySelectorAll(selector: string): readonly FakeElement[];
}

interface FakeDocument {
  defaultView: {
    readonly innerHeight: number;
    readonly innerWidth: number;
    getComputedStyle(target: unknown): { display: string; opacity: string; visibility: string };
  };
  documentElement: FakeElement;
  querySelectorAll(selector: string): readonly FakeElement[];
}

const SUPPORTED_WORKBENCH_CONTAINERS = [
  { className: "panel", id: "workbench.parts.panel" },
  { className: "auxiliarybar", id: "workbench.parts.auxiliarybar" },
  { className: "sidebar", id: "workbench.parts.sidebar" }
] as const;
const SUPPORTED_WORKBENCH_CONTAINER_SELECTOR =
  '.part.panel[id="workbench.parts.panel"], .part.auxiliarybar[id="workbench.parts.auxiliarybar"], .part.sidebar[id="workbench.parts.sidebar"]';

function assertLivePanelAssertionBinding(source: string): void {
  const syntax = ts.createSourceFile("extensionHost/index.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const liveAction = syntax.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === LIVE_ACTION_FUNCTION
  );
  nodeAssert.ok(liveAction?.body, `${LIVE_ACTION_FUNCTION} must remain a top-level function with a body.`);
  const statements = Array.from(liveAction.body.statements);
  const receiptIndex = statements.findIndex(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "receipt"
      )
  );
  nodeAssert.notEqual(receiptIndex, -1, `${LIVE_ACTION_FUNCTION} must retain its complete live receipt.`);
  const assertion = statements[receiptIndex + 1];
  nodeAssert.ok(
    assertion && ts.isExpressionStatement(assertion) && ts.isCallExpression(assertion.expression),
    "The live panel assertion must immediately consume the complete live receipt."
  );
  const call = assertion.expression;
  nodeAssert.ok(
    ts.isIdentifier(call.expression) && call.expression.text === LIVE_PANEL_ASSERTION_HELPER,
    `The complete live receipt must be consumed by ${LIVE_PANEL_ASSERTION_HELPER}.`
  );
  nodeAssert.deepEqual(
    call.arguments.map((argument) => argument.getText(syntax)),
    ["receipt.panel", "generation.panelAncestors.length + 1", "description"],
    "The live panel assertion must retain the exact receipt, ancestor count, and diagnostic owner."
  );
  nodeAssert.equal(
    statements.filter(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.expression) &&
        statement.expression.expression.text === LIVE_PANEL_ASSERTION_HELPER
    ).length,
    1,
    "The complete live panel assertion must run exactly once."
  );
}

function loadAuthority(): WorkbenchContainerAuthority {
  const path = resolve(process.cwd(), "src/test/extensionHost/index.ts");
  const source = readFileSync(path, "utf8");
  assertLivePanelAssertionBinding(source);
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const variables = new Set(["CODE_PREVIEW_WORKBENCH_CONTAINERS", "CODE_PREVIEW_WORKBENCH_CONTAINER_SELECTOR"]);
  const functions = new Set([
    "assertCodePreviewWorkbenchContainerActionChain",
    "assertVisibleCodePreviewWorkbenchOwnership",
    "selectVisibleCodePreviewWorkbenchContainer",
    "inspectCodePreviewWorkbenchContainer"
  ]);
  const selected = syntax.statements.filter((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && variables.has(declaration.name.text)
      );
    }
    return ts.isFunctionDeclaration(statement) && statement.name !== undefined && functions.has(statement.name.text);
  });
  expect(selected).toHaveLength(6);
  const compiled = ts.transpileModule(
    `${selected.map((statement) => statement.getText(syntax)).join("\n")}\n` +
      "globalThis.__openWranglerWorkbenchContainerAuthority = {" +
      "assertActionReceipt: assertCodePreviewWorkbenchContainerActionChain," +
      "assertReceipt: assertVisibleCodePreviewWorkbenchOwnership," +
      "containers: CODE_PREVIEW_WORKBENCH_CONTAINERS," +
      "inspect: inspectCodePreviewWorkbenchContainer," +
      "select: selectVisibleCodePreviewWorkbenchContainer," +
      "selector: CODE_PREVIEW_WORKBENCH_CONTAINER_SELECTOR" +
      "};",
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const sandbox: {
    __openWranglerWorkbenchContainerAuthority?: WorkbenchContainerAuthority;
    assert: typeof nodeAssert;
  } = { assert: nodeAssert };
  runInNewContext(compiled, sandbox, { timeout: 1_000 });
  expect(sandbox.__openWranglerWorkbenchContainerAuthority).toBeDefined();
  return sandbox.__openWranglerWorkbenchContainerAuthority!;
}

function createFixture(
  authority: WorkbenchContainerAuthority,
  options: Readonly<{
    className?: string;
    containerConnected?: boolean;
    duplicateContainer?: boolean;
    duplicateIframe?: boolean;
    extraContainers?: number;
    hidden?: boolean;
    hiddenAncestor?: boolean;
    hiddenOuterFrame?: boolean;
    id?: string;
    intermediateAncestors?: number;
    outerFrameConnected?: boolean;
  }> = {}
) {
  const parts: FakeElement[] = [];
  let candidateDescriptorReads = 0;
  let candidateIndexReads = 0;
  const candidateList = new Proxy(parts, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/u.test(property)) candidateIndexReads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  const document = {
    defaultView: {
      innerHeight: 768,
      innerWidth: 1_024,
      getComputedStyle: (target: unknown) => (target as FakeElement).style
    },
    documentElement: undefined as unknown as FakeElement,
    querySelectorAll: (selector: string) => (selector === authority.selector ? candidateList : [])
  } satisfies FakeDocument;
  const makeElement = ({
    classNames = [],
    connected = true,
    id = "",
    parent = null,
    style = { display: "block", opacity: "1", visibility: "visible" }
  }: Readonly<{
    classNames?: readonly string[];
    connected?: boolean;
    id?: string;
    parent?: FakeElement | null;
    style?: FakeElement["style"];
  }>): FakeElement => {
    const frames: FakeElement[] = [];
    const element: FakeElement = {
      classList: { contains: (className) => classNames.includes(className) },
      id,
      isConnected: connected,
      ownerDocument: document,
      parentElement: parent,
      style,
      contains(target) {
        let current = target as FakeElement | null;
        while (current !== null) {
          if (current === element) return true;
          current = current.parentElement;
        }
        return false;
      },
      getBoundingClientRect: () => {
        let current: FakeElement | null = element;
        while (current !== null) {
          if (
            current.style.display === "none" ||
            current.style.visibility === "hidden" ||
            current.style.visibility === "collapse"
          ) {
            return { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
          }
          current = current.parentElement;
        }
        return { bottom: 100, height: 100, left: 0, right: 100, top: 0, width: 100 };
      },
      querySelectorAll: (selector) => (selector === "iframe" ? frames : [])
    };
    Object.defineProperty(element, "__frames", { value: frames });
    return element;
  };
  const root = makeElement({
    id: "workbench-root",
    style: options.hiddenAncestor
      ? { display: "block", opacity: "0", visibility: "visible" }
      : { display: "block", opacity: "1", visibility: "visible" }
  });
  document.documentElement = root;
  const container = makeElement({
    classNames: ["part", options.className ?? "auxiliarybar"],
    connected: options.containerConnected,
    id: options.id ?? "workbench.parts.auxiliarybar",
    parent: root,
    style: options.hidden
      ? { display: "none", opacity: "1", visibility: "visible" }
      : { display: "block", opacity: "1", visibility: "visible" }
  });
  parts.push(container);
  if (options.duplicateContainer) {
    parts.push(
      makeElement({
        classNames: ["part", options.className ?? "auxiliarybar"],
        id: options.id ?? "workbench.parts.auxiliarybar",
        parent: root
      })
    );
  }
  for (let index = 0; index < (options.extraContainers ?? 0); index += 1) {
    const candidate = makeElement({
      classNames: ["part", "panel"],
      id: "workbench.parts.panel",
      parent: root
    });
    parts.push(
      new Proxy(candidate, {
        get(target, property, receiver) {
          if (property === "classList" || property === "id") candidateDescriptorReads += 1;
          return Reflect.get(target, property, receiver);
        }
      })
    );
  }
  let parent = container;
  for (let index = 0; index < (options.intermediateAncestors ?? 1); index += 1) {
    parent = makeElement({ parent });
  }
  const outerFrame = makeElement({
    connected: options.outerFrameConnected,
    parent,
    style: options.hiddenOuterFrame
      ? { display: "none", opacity: "1", visibility: "visible" }
      : { display: "block", opacity: "1", visibility: "visible" }
  });
  const frames = (container as unknown as { __frames: FakeElement[] }).__frames;
  frames.push(outerFrame);
  if (options.duplicateIframe) frames.push(makeElement({ parent: container }));
  return {
    candidateDescriptorReads: () => candidateDescriptorReads,
    candidateIndexReads: () => candidateIndexReads,
    container,
    outerFrame,
    root
  };
}

function selectionOptions(authority: WorkbenchContainerAuthority) {
  return { maximumAncestors: 64, supportedContainers: authority.containers };
}

function inspectionOptions(authority: WorkbenchContainerAuthority, fixture: ReturnType<typeof createFixture>) {
  return {
    containerSelector: authority.selector,
    expectedAncestors: [fixture.root],
    expectedOuterFrame: fixture.outerFrame,
    maximumAncestors: 64,
    maximumContainers: authority.containers.length,
    supportedContainers: authority.containers
  };
}

function ownershipReceipt(inspected: Record<string, unknown>) {
  return {
    frameElementCount: 1,
    frameElementsConnected: true,
    frameElementsVisible: true,
    containerConnected: inspected.containerConnected,
    containerContainsOuterFrame: inspected.containerContainsOuterFrame,
    containerHasSoleOuterFrame: inspected.containerHasSoleOuterFrame,
    containerIsSupported: inspected.containerIsSupported,
    containerIsVisibleOwner: inspected.containerIsVisibleOwner,
    containerSharesOuterDocument: inspected.containerSharesOuterDocument,
    containerVisible: inspected.containerVisible,
    supportedContainerIdentitiesUnique: inspected.supportedContainerIdentitiesUnique,
    supportedContainerInventoryBounded: inspected.supportedContainerInventoryBounded,
    visibleOwningContainerCount: inspected.visibleOwningContainerCount
  };
}

describe("Code Preview workbench-container ownership", () => {
  const authority = loadAuthority();
  expect(Array.from(authority.containers)).toEqual(SUPPORTED_WORKBENCH_CONTAINERS);
  expect(authority.selector).toBe(SUPPORTED_WORKBENCH_CONTAINER_SELECTOR);

  it.each(SUPPORTED_WORKBENCH_CONTAINERS)("accepts the supported visible $className container", (descriptor) => {
    const fixture = createFixture(authority, descriptor);
    expect(authority.select(fixture.outerFrame, selectionOptions(authority))).toBe(fixture.container);
    const inspected = authority.inspect(fixture.container, inspectionOptions(authority, fixture));
    expect(inspected).toMatchObject({
      containerConnected: true,
      containerContainsOuterFrame: true,
      containerHasSoleOuterFrame: true,
      containerIsSupported: true,
      containerIsVisibleOwner: true,
      containerSharesOuterDocument: true,
      containerVisible: true,
      supportedContainerIdentitiesUnique: true,
      supportedContainerInventoryBounded: true,
      visibleOwningContainerCount: 1
    });
    expect(() => authority.assertReceipt(ownershipReceipt(inspected), "supported container")).not.toThrow();
    expect(() => authority.assertActionReceipt(inspected, 2, "supported container action")).not.toThrow();
  });

  it("rejects detached and hidden supported containers", () => {
    const detached = createFixture(authority, { containerConnected: false, outerFrameConnected: true });
    const hidden = createFixture(authority, { hidden: true });
    expect(detached.container.isConnected).toBe(false);
    expect(detached.outerFrame.isConnected).toBe(true);
    expect(authority.select(detached.outerFrame, selectionOptions(authority))).toBeNull();
    expect(authority.select(hidden.outerFrame, selectionOptions(authority))).toBeNull();
    const detachedReceipt = authority.inspect(detached.container, inspectionOptions(authority, detached));
    expect(detachedReceipt).toMatchObject({ containerConnected: false, outerConnected: true });
    expect(() => authority.assertReceipt(ownershipReceipt(detachedReceipt), "detached container")).toThrow(
      /requires a connected workbench container/u
    );
  });

  it("keeps hidden-container, outer-frame, and hidden-ancestor action failures ordered and independently reachable", () => {
    const hiddenContainer = createFixture(authority, { hidden: true });
    const hiddenAncestor = createFixture(authority, { hiddenAncestor: true });
    const hiddenOuterFrame = createFixture(authority, { hiddenOuterFrame: true });
    const hiddenContainerReceipt = authority.inspect(
      hiddenContainer.container,
      inspectionOptions(authority, hiddenContainer)
    );
    const hiddenAncestorReceipt = authority.inspect(
      hiddenAncestor.container,
      inspectionOptions(authority, hiddenAncestor)
    );
    const hiddenOuterFrameReceipt = authority.inspect(
      hiddenOuterFrame.container,
      inspectionOptions(authority, hiddenOuterFrame)
    );
    expect(hiddenContainerReceipt).toMatchObject({
      containerAncestorsConnectedAndVisible: true,
      containerAncestorsExact: true,
      containerVisible: false,
      outerVisible: false
    });
    expect(hiddenAncestorReceipt).toMatchObject({
      containerAncestorsConnectedAndVisible: false,
      containerAncestorsExact: true,
      containerVisible: true
    });
    expect(hiddenOuterFrameReceipt).toMatchObject({ containerVisible: true, outerVisible: false });
    expect(() => authority.assertActionReceipt(hiddenContainerReceipt, 2, "hidden exact container")).toThrow(
      /requires the exact workbench container to remain visible at action time/u
    );
    expect(() => authority.assertActionReceipt(hiddenAncestorReceipt, 2, "hidden container ancestor")).toThrow(
      /requires every bounded workbench-container ancestor to remain connected, laid out, and visible/u
    );
    expect(() => authority.assertActionReceipt(hiddenOuterFrameReceipt, 2, "hidden outer frame")).toThrow(
      /requires the exact outer iframe to remain visible at action time/u
    );
  });

  it("binds the exact live helper call to the complete receipt before later action assertions", () => {
    const path = resolve(process.cwd(), "src/test/extensionHost/index.ts");
    const source = readFileSync(path, "utf8");
    const exactCall =
      "assertCodePreviewWorkbenchContainerActionChain(receipt.panel, generation.panelAncestors.length + 1, description);";
    const nextAssertion = "assert.equal(\n    receipt.frameChain.every(";
    expect(() => assertLivePanelAssertionBinding(source)).not.toThrow();
    expect(source).toContain(`${exactCall}\n  ${nextAssertion}`);

    const movedCall = source
      .replace(`${exactCall}\n  ${nextAssertion}`, `${nextAssertion}`)
      .replace(
        "assert.equal(\n    receipt.generationCounts.reduce",
        `${exactCall}\n  assert.equal(\n    receipt.generationCounts.reduce`
      );
    expect(() => assertLivePanelAssertionBinding(movedCall)).toThrow(/complete live receipt/u);

    const omittedCall = source.replace(`  ${exactCall}\n`, "");
    expect(() => assertLivePanelAssertionBinding(omittedCall)).toThrow(/complete live receipt/u);

    const wrongArguments = source.replace(
      exactCall,
      "assertCodePreviewWorkbenchContainerActionChain(receipt.panel, generation.panelAncestors.length, description);"
    );
    expect(() => assertLivePanelAssertionBinding(wrongArguments)).toThrow(
      /retain the exact receipt, ancestor count, and diagnostic owner/u
    );
  });

  it("rejects an over-bound container inventory before candidate traversal", () => {
    const fixture = createFixture(authority, { extraContainers: authority.containers.length });
    const inspected = authority.inspect(fixture.container, inspectionOptions(authority, fixture));
    expect(inspected).toMatchObject({ supportedContainerInventoryBounded: false });
    expect(fixture.candidateIndexReads()).toBe(0);
    expect(fixture.candidateDescriptorReads()).toBe(0);
    expect(() => authority.assertReceipt(ownershipReceipt(inspected), "over-bound container inventory")).toThrow(
      /over-bound supported workbench-container inventory/u
    );
  });

  it("rejects the nearest wrong workbench part without walking through it", () => {
    const fixture = createFixture(authority, { className: "editor", id: "workbench.parts.editor" });
    expect(authority.select(fixture.outerFrame, selectionOptions(authority))).toBeNull();
  });

  it("rejects duplicate supported identities and duplicate iframe ownership", () => {
    const duplicateContainer = createFixture(authority, { duplicateContainer: true });
    const duplicateIframe = createFixture(authority, { duplicateIframe: true });
    const duplicateContainerReceipt = authority.inspect(
      duplicateContainer.container,
      inspectionOptions(authority, duplicateContainer)
    );
    const duplicateIframeReceipt = authority.inspect(
      duplicateIframe.container,
      inspectionOptions(authority, duplicateIframe)
    );
    expect(duplicateContainerReceipt).toMatchObject({ supportedContainerIdentitiesUnique: false });
    expect(duplicateIframeReceipt).toMatchObject({
      containerFrameElementCount: 2,
      containerHasSoleOuterFrame: false
    });
    expect(() => authority.assertReceipt(ownershipReceipt(duplicateContainerReceipt), "duplicate container")).toThrow(
      /duplicate supported workbench-container identities/u
    );
    expect(() => authority.assertReceipt(ownershipReceipt(duplicateIframeReceipt), "duplicate iframe")).toThrow(
      /own only the selected outer Code Preview iframe/u
    );
  });

  it("rejects an over-bound outer-frame-to-container ancestry", () => {
    const fixture = createFixture(authority, { intermediateAncestors: 64 });
    expect(authority.select(fixture.outerFrame, selectionOptions(authority))).toBeNull();
  });
});
