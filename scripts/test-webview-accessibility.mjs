import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const harnessDir = resolve(root, "tmp", "screenshots");
const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const executablePath = process.env.CHROME_BIN ?? findChrome();
const harnesses = readdirSync(harnessDir)
  .filter((file) => file.endsWith(".html"))
  .sort();

if (harnesses.length === 0) {
  throw new Error("No generated webview harnesses found. Run capture:screenshots first.");
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"]
});
const failures = [];

try {
  for (const harness of harnesses) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(async () => {
      return globalThis.axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
        }
      });
    });
    const violations = result.violations.filter((violation) => violation.impact !== "minor");
    if (violations.length === 0) {
      console.log(`Accessibility verified: ${harness}`);
    } else {
      failures.push({ harness, violations });
    }
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  const detail = failures
    .flatMap(({ harness, violations }) =>
      violations.map(
        (violation) =>
          `${harness}: [${violation.impact ?? "unknown"}] ${violation.id} — ${violation.help}\n` +
          violation.nodes
            .slice(0, 5)
            .map((node) => `  ${node.target.join(" ")}: ${node.failureSummary ?? "failed"}`)
            .join("\n")
      )
    )
    .join("\n");
  throw new Error(`Webview accessibility scan failed:\n${detail}`);
}

console.log(`Accessibility verified for ${harnesses.length} production webview harnesses.`);

function findChrome() {
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      return execFileSync(process.platform === "win32" ? "where" : "which", [name], {
        encoding: "utf8"
      })
        .split(/\r?\n/, 1)[0]
        .trim();
    } catch {
      // Try the next common browser executable.
    }
  }
  throw new Error("Chrome or Chromium is required for webview accessibility acceptance.");
}
