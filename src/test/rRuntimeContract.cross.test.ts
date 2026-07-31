import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isRFramePageContract } from "../shared/rRuntimeContract";

const requireContract = process.env.OPEN_WRANGLER_REQUIRE_R_CONTRACT === "1";
const probe = spawnSync(
  "Rscript",
  ["--vanilla", "-e", 'quit(status = if (requireNamespace("jsonlite", quietly = TRUE)) 0 else 1)'],
  { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 }
);
const crossTest = requireContract || probe.status === 0 ? it : it.skip;

describe("native R to TypeScript contract", () => {
  crossTest("accepts the exact strict-JSON payload emitted by the bundled R producer", () => {
    for (const fixtureArguments of [[], ["--latin1-boundary"]]) {
      const result = spawnSync("Rscript", ["--vanilla", "r/tests/emit-frame-contract.R", ...fixtureArguments], {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const payload: unknown = JSON.parse(result.stdout);
      expect(isRFramePageContract(payload)).toBe(true);
    }
  });
});
