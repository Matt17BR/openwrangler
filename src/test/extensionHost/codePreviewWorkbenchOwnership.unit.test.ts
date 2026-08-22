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
  readonly assertReceipt: (receipt: Record<string, unknown>, description: string) => void;
  readonly containers: readonly WorkbenchContainerDescriptor[];
  readonly inspect: (container: unknown, options: Record<string, unknown>) => Record<string, unknown>;
  readonly select: (outerFrame: unknown, options: Record<string, unknown>) => unknown;
  readonly selector: string;
}

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

function loadAuthority(): WorkbenchContainerAuthority {
  const path = resolve(process.cwd(), "src/test/extensionHost/index.ts");
  const source = readFileSync(path, "utf8");
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const variables = new Set(["CODE_PREVIEW_WORKBENCH_CONTAINERS", "CODE_PREVIEW_WORKBENCH_CONTAINER_SELECTOR"]);
  const functions = new Set([
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
  expect(selected).toHaveLength(5);
  const compiled = ts.transpileModule(
    `${selected.map((statement) => statement.getText(syntax)).join("\n")}\n` +
      "globalThis.__openWranglerWorkbenchContainerAuthority = {" +
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
    connected?: boolean;
    duplicateContainer?: boolean;
    duplicateIframe?: boolean;
    hidden?: boolean;
    id?: string;
    intermediateAncestors?: number;
  }> = {}
) {
  const parts: FakeElement[] = [];
  const document = {
    defaultView: {
      innerHeight: 768,
      innerWidth: 1_024,
      getComputedStyle: (target: unknown) => (target as FakeElement).style
    },
    documentElement: undefined as unknown as FakeElement,
    querySelectorAll: (selector: string) => (selector === authority.selector ? parts : [])
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
      getBoundingClientRect: () => ({ bottom: 100, height: 100, left: 0, right: 100, top: 0, width: 100 }),
      querySelectorAll: (selector) => (selector === "iframe" ? frames : [])
    };
    Object.defineProperty(element, "__frames", { value: frames });
    return element;
  };
  const root = makeElement({ id: "workbench-root" });
  document.documentElement = root;
  const container = makeElement({
    classNames: ["part", options.className ?? "auxiliarybar"],
    connected: options.connected,
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
  let parent = container;
  for (let index = 0; index < (options.intermediateAncestors ?? 1); index += 1) {
    parent = makeElement({ parent });
  }
  const outerFrame = makeElement({ connected: options.connected, parent });
  const frames = (container as unknown as { __frames: FakeElement[] }).__frames;
  frames.push(outerFrame);
  if (options.duplicateIframe) frames.push(makeElement({ parent: container }));
  return { container, outerFrame, root };
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
  });

  it("rejects detached and hidden supported containers", () => {
    const detached = createFixture(authority, { connected: false });
    const hidden = createFixture(authority, { hidden: true });
    expect(authority.select(detached.outerFrame, selectionOptions(authority))).toBeNull();
    expect(authority.select(hidden.outerFrame, selectionOptions(authority))).toBeNull();
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
