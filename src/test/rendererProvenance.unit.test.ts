import { describe, expect, it } from "vitest";
import { createRendererProvenanceOrderContract } from "./extensionHost/rendererProvenance";

describe("renderer provenance order contract", () => {
  it("accepts reveal, active-document proof, discovery, click, and receipt exactly once", () => {
    const contract = createRendererProvenanceOrderContract();
    expect(contract.clickBoundaryWasEntered).toBe(false);
    contract.secondNotebookShown();
    contract.originRevealed();
    contract.secondNotebookActive();
    contract.actionDiscoveryStarted();
    expect(contract.clickBoundaryWasEntered).toBe(false);
    contract.clickBoundaryEntered();
    expect(contract.clickBoundaryWasEntered).toBe(true);
    contract.actionReceipted();
    expect(contract.clickBoundaryWasEntered).toBe(true);
  });

  it("rejects discovery before the origin is revealed and notebook B is re-proven active", () => {
    const beforeReveal = createRendererProvenanceOrderContract();
    beforeReveal.secondNotebookShown();
    expect(() => beforeReveal.actionDiscoveryStarted()).toThrowError(
      /expected second-notebook-active before action-discovery; observed second-notebook-shown/u
    );

    const beforeActiveProof = createRendererProvenanceOrderContract();
    beforeActiveProof.secondNotebookShown();
    beforeActiveProof.originRevealed();
    expect(() => beforeActiveProof.actionDiscoveryStarted()).toThrowError(
      /expected second-notebook-active before action-discovery; observed origin-revealed/u
    );
  });

  it("rejects a click or authoritative receipt before its exact prior boundary", () => {
    const beforeDiscovery = createRendererProvenanceOrderContract();
    beforeDiscovery.secondNotebookShown();
    beforeDiscovery.originRevealed();
    beforeDiscovery.secondNotebookActive();
    expect(() => beforeDiscovery.clickBoundaryEntered()).toThrowError(
      /expected action-discovery before click-boundary; observed second-notebook-active/u
    );

    const beforeClick = createRendererProvenanceOrderContract();
    beforeClick.secondNotebookShown();
    beforeClick.originRevealed();
    beforeClick.secondNotebookActive();
    beforeClick.actionDiscoveryStarted();
    expect(() => beforeClick.actionReceipted()).toThrowError(
      /expected click-boundary before receipted; observed action-discovery/u
    );
  });

  it("rejects duplicate checkpoints instead of silently weakening provenance", () => {
    const contract = createRendererProvenanceOrderContract();
    contract.secondNotebookShown();
    expect(() => contract.secondNotebookShown()).toThrowError(
      /expected initial before second-notebook-shown; observed second-notebook-shown/u
    );
  });
});
