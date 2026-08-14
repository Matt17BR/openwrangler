import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { stringifyForInlineScript } from "./capture-screenshots-json.mjs";
import {
  createWebviewBrowserIsolation,
  preflightWebviewBrowser,
  resolveWebviewBrowserExecutable,
  WEBVIEW_BROWSER_PREREQUISITE_FAILURE
} from "./webview-browser.mjs";

test("inline-script JSON escapes HTML script boundaries without changing its value", () => {
  const payload = {
    message: "</ScRiPt><script>window.openWranglerEscaped = false;</script><!--&-->\u2028\u2029",
    nested: ["plain", { code: "before</script>after", value: 42 }],
    enabled: true,
    missing: null
  };

  const serialized = stringifyForInlineScript(payload);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/u);
  assert.doesNotMatch(serialized, /<\/script/iu);

  const harness = `<script>globalThis.payload = ${serialized};</script>`;
  assert.equal(harness.match(/<\/script>/giu)?.length, 1);
  assert.equal(JSON.stringify(runInNewContext(`(${serialized})`)), JSON.stringify(payload));
});

test("inline-script JSON retains ordinary JSON.stringify semantics", () => {
  assert.equal(stringifyForInlineScript(undefined), "undefined");
  assert.equal(stringifyForInlineScript(Number.NaN), "null");
  assert.equal(stringifyForInlineScript(-0), "0");
  assert.equal(stringifyForInlineScript('"quoted"'), '"\\"quoted\\""');
  assert.throws(() => stringifyForInlineScript(1n), /BigInt/u);
});

test("every screenshot harness inline payload uses the script-safe serializer", () => {
  const source = readFileSync(new URL("./capture-screenshots.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\$\{\s*JSON\.stringify/u);

  for (const expression of [
    "stringifyForInlineScript(sessionPayload)",
    "stringifyForInlineScript(columnValues)",
    "stringifyForInlineScript(suppliedPages)",
    "stringifyForInlineScript(stepInspections)",
    "stringifyForInlineScript(strictProjectedPages)",
    "stringifyForInlineScript(fetchColumnBlockSize)",
    "stringifyForInlineScript(editorAction)",
    "stringifyForInlineScript(appearance.followupMessage)",
    'stringifyForInlineScript(`th[data-column="${openColumnFilter}"]`)',
    "stringifyForInlineScript(payload)",
    "stringifyForInlineScript(code)"
  ]) {
    assert.ok(source.includes(expression), `Missing script-safe serialization for ${expression}.`);
  }
});

test("webview browser discovery permits only the pinned executable or an absolute override", () => {
  const environment = { HOME: "/original/home", XDG_CACHE_HOME: "/original/cache" };
  const snapshot = { ...environment };
  const pinned = resolveWebviewBrowserExecutable({
    chromium: { executablePath: () => process.execPath },
    environment,
    platform: process.platform
  });
  assert.deepEqual(pinned, { executablePath: process.execPath, explicitOverride: false });
  assert.deepEqual(environment, snapshot);

  const overridden = resolveWebviewBrowserExecutable({
    chromium: {
      executablePath() {
        throw new Error("An explicit browser must not fall back to Playwright discovery.");
      }
    },
    environment: { CHROME_BIN: process.execPath },
    platform: process.platform
  });
  assert.deepEqual(overridden, { executablePath: process.execPath, explicitOverride: true });
  assert.throws(
    () =>
      resolveWebviewBrowserExecutable({
        chromium: { executablePath: () => process.execPath },
        environment: { CHROME_BIN: "relative-browser" },
        platform: process.platform
      }),
    /must be an absolute/u
  );
});

test("webview browser isolation keeps ambient state untouched and removes its unique profiles", () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-webview-isolation-test-"));
  chmodSync(parent, 0o700);
  const environment = { HOME: "/inherited/home", XDG_CACHE_HOME: "/inherited/cache", SAFE_VALUE: "retained" };
  const snapshot = { ...environment };
  try {
    const isolation = createWebviewBrowserIsolation({
      workspaceTmp: parent,
      environment,
      platform: process.platform,
      rootPrefix: "browser-test-",
      aliasPrefix: "ow-browser-test-",
      shortTempParent: tmpdir()
    });
    const browserRoot = isolation.root;
    const aliasRoot = process.platform === "win32" ? undefined : dirname(isolation.childEnvironment.TMPDIR);
    assert.deepEqual(environment, snapshot);
    assert.equal(isolation.childEnvironment.SAFE_VALUE, "retained");
    assert.equal(isolation.childEnvironment.HOME.startsWith(browserRoot), true);
    assert.equal(isolation.childEnvironment.XDG_RUNTIME_DIR.startsWith(browserRoot), true);
    if (process.platform !== "win32") {
      assert.equal(realpathSync(isolation.childEnvironment.TMPDIR), realpathSync(join(browserRoot, "temp")));
      assert.equal(lstatSync(isolation.childEnvironment.TMPDIR).isSymbolicLink(), true);
      assert.equal(statSync(aliasRoot).mode & 0o777, 0o700);
    }
    const first = isolation.createProfile("first");
    const second = isolation.createProfile("second");
    assert.notEqual(first, second);
    assert.equal(first.startsWith(join(browserRoot, "profiles")), true);
    assert.equal(second.startsWith(join(browserRoot, "profiles")), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(browserRoot).mode & 0o777, 0o700);
    }
    isolation.cleanup();
    assert.equal(existsSync(browserRoot), false);
    if (aliasRoot) assert.equal(existsSync(aliasRoot), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("browser preflight timeout is single-attempt, classified, explicit-profile, and cleanup-bound", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-webview-launch-test-"));
  chmodSync(parent, 0o700);
  let calls = 0;
  let profile;
  try {
    await assert.rejects(
      () =>
        preflightWebviewBrowser({
          chromium: {
            executablePath() {
              throw new Error("The explicit override must bypass Playwright browser discovery.");
            },
            async launchPersistentContext(candidate, options) {
              calls += 1;
              profile = candidate;
              assert.equal(existsSync(profile), true);
              assert.equal(options.executablePath, process.execPath);
              assert.equal(options.env.HOME.includes("webview-browser-preflight-"), true);
              assert.equal(options.timeout, 30_000);
              throw Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" });
            }
          },
          cwd: parent,
          workspaceTmp: parent,
          environment: { CHROME_BIN: process.execPath },
          platform: process.platform,
          shortTempParent: tmpdir()
        }),
      (error) =>
        error.code === WEBVIEW_BROWSER_PREREQUISITE_FAILURE &&
        error.message === `${WEBVIEW_BROWSER_PREREQUISITE_FAILURE}: synthetic timeout`
    );
    assert.equal(calls, 1);
    assert.equal(existsSync(profile), false);
    assert.deepEqual(
      readdirSync(parent).filter((entry) => entry.startsWith("webview-browser-preflight-")),
      []
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("screenshot and accessibility consumers preserve browser isolation ordering", () => {
  const capture = readFileSync(new URL("./capture-screenshots.mjs", import.meta.url), "utf8");
  const accessibility = readFileSync(new URL("./test-webview-accessibility.mjs", import.meta.url), "utf8");
  const pythonPreflight = capture.indexOf("resolveAndPreflightAcceptancePython({");
  const preflight = capture.indexOf("preflightWebviewBrowser({", pythonPreflight);
  const payload = capture.indexOf("const payloads = JSON.parse(", preflight);
  assert.ok(pythonPreflight >= 0 && preflight > pythonPreflight && payload > preflight);
  assert.match(
    capture,
    /screenshotQueue = screenshotQueue\.then\(async \(\) => \{[\s\S]*await captureWebviewScreenshot\(/u
  );
  assert.match(capture, /await screenshotQueue;/u);
  assert.doesNotMatch(capture, /process\.env\.(?:HOME|XDG_[A-Z_]+|TMPDIR?)\s*=/u);

  const browserHelper = readFileSync(new URL("./webview-browser.mjs", import.meta.url), "utf8");
  assert.match(browserHelper, /chromium\.launchPersistentContext\(profile,/u);
  assert.doesNotMatch(browserHelper, /spawnSync|chromium_headless_shell|--headless=new/u);

  const acceptanceCommand = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).scripts[
    "test:webview-acceptance:run"
  ];
  assert.match(
    acceptanceCommand,
    /^node scripts\/packaged-python-preflight\.mjs visual && node scripts\/webview-browser\.mjs && npm run brand:render-check/u
  );

  const accessibilityDiscovery = accessibility.indexOf("resolveWebviewBrowserExecutable({ chromium })");
  const accessibilityIsolation = accessibility.indexOf("createWebviewBrowserIsolation({", accessibilityDiscovery);
  const accessibilityLaunch = accessibility.indexOf("chromium.launchPersistentContext(", accessibilityIsolation);
  const firstHarnessScan = accessibility.indexOf("for (const harness of harnesses)", accessibilityLaunch);
  assert.ok(
    accessibilityDiscovery >= 0 &&
      accessibilityIsolation > accessibilityDiscovery &&
      accessibilityLaunch > accessibilityIsolation &&
      firstHarnessScan > accessibilityLaunch
  );
  assert.match(
    accessibility,
    /browserExecutable\.explicitOverride \? \{ executablePath: browserExecutable\.executablePath \} : \{\}/u
  );
  assert.match(accessibility, /env: browserIsolation\.childEnvironment/u);
  assert.match(accessibility, /finally \{[\s\S]*browserIsolation\.cleanup\(\)/u);
  assert.doesNotMatch(accessibility, /process\.env\.(?:HOME|XDG_[A-Z_]+|TMPDIR?)\s*=/u);

  for (const file of ["generate-brand-assets.mjs", "verify-readme-responsive-render.mjs"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /resolveWebviewBrowserExecutable\(\{ chromium \}\)/u);
    assert.match(source, /chromium\.launchPersistentContext\(browserIsolation\.createProfile\(/u);
    assert.match(source, /env: browserIsolation\.childEnvironment/u);
    assert.match(source, /browserIsolation\.cleanup\(\)/u);
    assert.doesNotMatch(source, /chromium\.launch\(/u);
  }
});
