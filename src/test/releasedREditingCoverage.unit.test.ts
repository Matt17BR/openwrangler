import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { NotebookDocument } from "vscode";
import type { TestApi } from "./extensionHost/extensionHostTestApi";
import type { exerciseReleasedRCategoricalEditingJourney as exerciseReleasedRCategoricalEditingJourneyOwner } from "./extensionHost/releasedRCategoricalEditing";
import {
  RELEASED_R_CATEGORICAL_OPERATIONS_COVERAGE,
  RELEASED_R_COMPREHENSIVE_COVERAGE,
  RELEASED_R_REPRESENTATIVE_COVERAGE,
  RELEASED_R_VALUE_OPERATIONS_COVERAGE,
  type ReleasedRAcceptanceCoverageProfile
} from "./extensionHost/releasedRAcceptanceCoverage";
import { createReleasedREditingCoverage } from "./extensionHost/releasedREditingCoverage";

const testing = {} as TestApi;
const workbench = {} as Page;
const notebook = {} as NotebookDocument;
const base = { sessionId: "session-r" } as NonNullable<ReturnType<TestApi["activeSession"]>>;

function fixture() {
  const events: string[] = [];
  const exerciseReleasedREditingJourney = vi.fn(async (...args: unknown[]) => {
    events.push(`catalog:${String(args.at(-1))}`);
  });
  const exerciseReleasedRCategoricalEditingJourney = vi.fn(async () => {
    events.push("categorical");
  });
  const exerciseReleasedRRepresentativeEditingJourney = vi.fn(async () => {
    events.push("representative");
  });
  const exerciseReleasedRValueOperationsJourney = vi.fn(async () => {
    events.push("value");
  });
  const assertReleasedRRuntimeBinding = vi.fn(async () => {
    events.push("binding");
  });
  const disposePackagedSessionPanel = vi.fn(async () => {
    events.push("dispose");
  });
  const categoricalDependencies = {} as Parameters<typeof exerciseReleasedRCategoricalEditingJourneyOwner>[1];
  const owner = createReleasedREditingCoverage({
    assertReleasedRRuntimeBinding,
    categoricalDependencies,
    disposePackagedSessionPanel,
    exerciseReleasedREditingJourney,
    exerciseReleasedRCategoricalEditingJourney,
    exerciseReleasedRRepresentativeEditingJourney,
    exerciseReleasedRValueOperationsJourney,
    recordReleasedRAcceptanceSection: (_phase, _coverage, _section, boundary) => events.push(`section:${boundary}`)
  });
  return {
    assertReleasedRRuntimeBinding,
    categoricalDependencies,
    disposePackagedSessionPanel,
    events,
    exerciseReleasedRCategoricalEditingJourney,
    exerciseReleasedREditingJourney,
    exerciseReleasedRRepresentativeEditingJourney,
    exerciseReleasedRValueOperationsJourney,
    owner
  };
}

describe("released R editing coverage", () => {
  it.each([
    ["jupyter-r", RELEASED_R_COMPREHENSIVE_COVERAGE, ["section:start", "catalog:core-catalog"]],
    [
      "jupyter-r",
      { ...RELEASED_R_COMPREHENSIVE_COVERAGE, editing: "clone-lifecycle" },
      ["section:start", "catalog:clone-lifecycle"]
    ],
    ["jupyter-r", RELEASED_R_REPRESENTATIVE_COVERAGE, ["section:start", "representative"]],
    ["jupyter-r", RELEASED_R_CATEGORICAL_OPERATIONS_COVERAGE, ["section:start", "representative", "categorical"]],
    ["jupyter-r", RELEASED_R_VALUE_OPERATIONS_COVERAGE, ["section:start", "representative", "value"]],
    ["jupyter-r-remote", RELEASED_R_CATEGORICAL_OPERATIONS_COVERAGE, ["section:start", "representative"]]
  ] as const)("routes %s/%s through its exact editing owner", async (phase, coverage, journeyEvents) => {
    const test = fixture();

    await test.owner(
      testing,
      workbench,
      base,
      notebook,
      "/workspace/orders.ipynb",
      "/workspace/evidence",
      phase,
      coverage as ReleasedRAcceptanceCoverageProfile,
      "/workspace/evidence/editing.png"
    );

    expect(test.events).toEqual([...journeyEvents, "section:complete", "binding", "dispose"]);
    expect(test.assertReleasedRRuntimeBinding).toHaveBeenCalledExactlyOnceWith(
      notebook,
      true,
      `${phase}:source-after-editing-journey`
    );
    expect(test.disposePackagedSessionPanel).toHaveBeenCalledExactlyOnceWith(
      testing,
      "session-r",
      "the editable orders R data.frame session"
    );
    if (coverage.editing === "core-catalog" || coverage.editing === "clone-lifecycle") {
      expect(test.exerciseReleasedREditingJourney).toHaveBeenCalledExactlyOnceWith(
        testing,
        workbench,
        "session-r",
        notebook,
        "/workspace/orders.ipynb",
        "/workspace/evidence",
        phase,
        "/workspace/evidence/editing.png",
        coverage.editing
      );
      expect(test.exerciseReleasedRRepresentativeEditingJourney).not.toHaveBeenCalled();
    } else {
      expect(test.exerciseReleasedRRepresentativeEditingJourney).toHaveBeenCalledExactlyOnceWith(
        testing,
        workbench,
        "session-r",
        notebook,
        phase
      );
      expect(test.exerciseReleasedREditingJourney).not.toHaveBeenCalled();
    }
    if (phase === "jupyter-r" && coverage.focusedEditing === "categorical-operations") {
      expect(test.exerciseReleasedRCategoricalEditingJourney).toHaveBeenCalledExactlyOnceWith(
        { testing, workbench, sessionId: "session-r" },
        test.categoricalDependencies
      );
    } else {
      expect(test.exerciseReleasedRCategoricalEditingJourney).not.toHaveBeenCalled();
    }
    if (phase === "jupyter-r" && coverage.focusedEditing === "value-operations") {
      expect(test.exerciseReleasedRValueOperationsJourney).toHaveBeenCalledExactlyOnceWith(
        testing,
        workbench,
        "session-r",
        notebook,
        "/workspace/orders.ipynb",
        "/workspace/evidence",
        phase,
        "/workspace/evidence/editing.png"
      );
    } else {
      expect(test.exerciseReleasedRValueOperationsJourney).not.toHaveBeenCalled();
    }
  });
});
