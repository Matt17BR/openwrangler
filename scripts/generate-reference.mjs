import { runReferenceGenerator } from "./generate-reference-core.mjs";

await runReferenceGenerator({ check: process.argv.includes("--check") });
