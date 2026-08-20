import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReleasedPySparkInstalledAcceptanceMode,
  releasedPySparkInstalledAcceptanceMode,
  RELEASED_PYSPARK_PRERELEASE_DENIAL_PRODUCT_VERSION
} from "./extensionHost/releasedPySparkJupyterJourney";

const PRERELEASE_DISTRIBUTION = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures", "pyspark-prerelease-distribution.json"), "utf8")
) as { readonly version: string };

describe("released PySpark installed acceptance mode", () => {
  it("delegates stable qualification to the generated policy without a second version grammar", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src", "test", "extensionHost", "releasedPySparkJupyterJourney.ts"),
      "utf8"
    );
    expect(source).toContain('if (isSupportedPySparkVersion(version)) return "stable-qualification";');
    expect(source).toContain("version === RELEASED_PYSPARK_PRERELEASE_DENIAL_PRODUCT_VERSION");
    expect(source).not.toContain("/^0*4\\.0*2\\.");
  });

  it.each(["4.2.0", "4.2.17", "04.02.000", "4.2.0+vendor.1"])(
    "classifies final release %s only as stable qualification",
    (version) => {
      expect(releasedPySparkInstalledAcceptanceMode(version)).toBe("stable-qualification");
    }
  );

  it("classifies only the repository receipt's exact product version as denial evidence", () => {
    expect(PRERELEASE_DISTRIBUTION.version).toBe(RELEASED_PYSPARK_PRERELEASE_DENIAL_PRODUCT_VERSION);
    expect(releasedPySparkInstalledAcceptanceMode(PRERELEASE_DISTRIBUTION.version)).toBe("prerelease-denial");
  });

  it.each([
    "4.2.0a1",
    "4.2.0b2",
    "4.2.0rc3",
    "4.2.0.dev4",
    "04.02.000.dev5",
    "4.1.9",
    "4.3.0",
    "4.2.0.post1",
    "4.2.0\n",
    "x".repeat(65)
  ])("rejects unqualified harness version %s without assigning an acceptance mode", (version) => {
    expect(() => releasedPySparkInstalledAcceptanceMode(version)).toThrow(/Released PySpark acceptance/u);
  });

  it("prevents the default stable journey and explicit denial journey from substituting for each other", () => {
    expect(() =>
      assertReleasedPySparkInstalledAcceptanceMode(
        RELEASED_PYSPARK_PRERELEASE_DENIAL_PRODUCT_VERSION,
        "stable-qualification"
      )
    ).toThrow(/expected stable-qualification but received prerelease-denial/u);
    expect(() => assertReleasedPySparkInstalledAcceptanceMode("4.2.0", "prerelease-denial")).toThrow(
      /expected prerelease-denial but received stable-qualification/u
    );
  });
});
