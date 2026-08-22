import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyPySparkVersion } from "../extension/notebooks/pysparkVersionPolicy.generated";
import {
  assertReleasedPySparkInstalledAcceptanceMode,
  releasedPySparkInstalledAcceptanceMode
} from "./extensionHost/releasedPySparkJupyterJourney";

const PRERELEASE_DISTRIBUTION = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures", "pyspark-prerelease-distribution.json"), "utf8")
) as { readonly version: string };
const VERSION_CONTRACT = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures", "pyspark-version-contract.json"), "utf8")
) as {
  readonly acceptancePrereleaseDenial: readonly string[];
  readonly acceptedFinal: readonly string[];
  readonly rejected: Readonly<Record<string, readonly string[]>>;
};

describe("released PySpark installed acceptance mode", () => {
  it("uses the generated complete policy as its only executable version classification", () => {
    expect(VERSION_CONTRACT.acceptancePrereleaseDenial).toEqual([PRERELEASE_DISTRIBUTION.version]);
    expect(
      VERSION_CONTRACT.acceptedFinal.every((version) => classifyPySparkVersion(version) === "supported-final")
    ).toBe(true);
    expect(
      VERSION_CONTRACT.acceptedFinal.every(
        (version) => releasedPySparkInstalledAcceptanceMode(version) === "stable-qualification"
      )
    ).toBe(true);
    expect(
      VERSION_CONTRACT.acceptancePrereleaseDenial.every(
        (version) => classifyPySparkVersion(version) === "acceptance-denial"
      )
    ).toBe(true);
    expect(
      VERSION_CONTRACT.acceptancePrereleaseDenial.every(
        (version) => releasedPySparkInstalledAcceptanceMode(version) === "prerelease-denial"
      )
    ).toBe(true);
    expect(
      Object.values(VERSION_CONTRACT.rejected)
        .flat()
        .every((version) => classifyPySparkVersion(version) === "unsupported")
    ).toBe(true);
    for (const version of Object.values(VERSION_CONTRACT.rejected).flat()) {
      expect(() => releasedPySparkInstalledAcceptanceMode(version)).toThrow(/Released PySpark acceptance/u);
    }
  });

  it.each(["4.2.0", "4.2.17", "04.02.000", "4.2.0+vendor.1"])(
    "classifies final release %s only as stable qualification",
    (version) => {
      expect(releasedPySparkInstalledAcceptanceMode(version)).toBe("stable-qualification");
    }
  );

  it("classifies only the repository receipt's exact product version as denial evidence", () => {
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
      assertReleasedPySparkInstalledAcceptanceMode(PRERELEASE_DISTRIBUTION.version, "stable-qualification")
    ).toThrow(/expected stable-qualification but received prerelease-denial/u);
    expect(() => assertReleasedPySparkInstalledAcceptanceMode("4.2.0", "prerelease-denial")).toThrow(
      /expected prerelease-denial but received stable-qualification/u
    );
  });
});
