import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { inspectVsixEntries } from "./vsix-contents.mjs";

const root = resolve(import.meta.dirname, "..");
const requested = process.argv[2];
if (!requested) {
  throw new Error("Pass the exact VSIX path to verify; implicit artifact selection is intentionally disabled.");
}
const vsix = resolve(root, requested);

if (!existsSync(vsix)) {
  throw new Error(`VSIX not found: ${requested}`);
}

const entries = execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
const { forbidden, missing } = inspectVsixEntries(entries);

if (forbidden.length > 0 || missing.length > 0) {
  throw new Error(
    [
      `Invalid ${basename(vsix)}.`,
      forbidden.length ? `Forbidden: ${forbidden.join(", ")}` : "",
      missing.length ? `Missing: ${missing.join(", ")}` : ""
    ]
      .filter(Boolean)
      .join(" ")
  );
}

console.log(`Verified ${basename(vsix)} (${entries.length} archive entries).`);
