import { describe, expect, it } from "vitest";
import { releasedPySparkInstalledAcceptanceMode } from "./extensionHost/releasedPySparkJupyterJourney";

describe("released PySpark installed acceptance mode", () => {
  it.each(["4.2.0", "4.2.17", "04.02.000", "4.2.0+vendor.1"])(
    "classifies final release %s only as stable qualification",
    (version) => {
      expect(releasedPySparkInstalledAcceptanceMode(version)).toBe("stable-qualification");
    }
  );

  it.each(["4.2.0a1", "4.2.0b2", "4.2.0rc3", "4.2.0.dev5"])(
    "classifies installed prerelease %s only as denial evidence",
    (version) => {
      expect(releasedPySparkInstalledAcceptanceMode(version)).toBe("prerelease-denial");
    }
  );

  it.each(["4.1.9", "4.3.0", "4.2.0.post1", "4.2.0\n", "x".repeat(65)])(
    "rejects unqualified harness version %s without assigning an acceptance mode",
    (version) => {
      expect(() => releasedPySparkInstalledAcceptanceMode(version)).toThrow(/Released PySpark acceptance/u);
    }
  );
});
