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
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { stringifyForInlineScript } from "./capture-screenshots-json.mjs";
import {
  captureWebviewScreenshot,
  createWebviewSelectorReadiness,
  createWebviewBrowserIsolation,
  preflightWebviewBrowser,
  resolveWebviewBrowserExecutable,
  WEBVIEW_BROWSER_PREREQUISITE_FAILURE
} from "./webview-browser.mjs";

const completedHeaderReadiness = () =>
  createWebviewSelectorReadiness({
    description: "test header profiles",
    selectors: [
      { selector: "th[data-grid-column]", count: 2 },
      { selector: "th[data-grid-column] > .columnInsight:not(.emptyInsight)", count: 2 },
      { selector: "th[data-grid-column] .emptyInsight", count: 0 }
    ],
    absentText: [{ selector: "th[data-grid-column] > .columnInsight", text: "Profiling…" }],
    emptyArrayGlobals: ["openWranglerHarnessErrors"]
  });

function readinessScope({
  headerCount = 2,
  completedCount = 2,
  emptyCount = 0,
  texts = ["Ready", "Ready"],
  errors = []
} = {}) {
  const elements = (count, textValues = []) =>
    Array.from({ length: count }, (_, index) => ({ textContent: textValues[index] ?? "" }));
  const selectorResults = new Map([
    ["th[data-grid-column]", elements(headerCount)],
    ["th[data-grid-column] > .columnInsight:not(.emptyInsight)", elements(completedCount)],
    ["th[data-grid-column] .emptyInsight", elements(emptyCount)],
    ["th[data-grid-column] > .columnInsight", elements(texts.length, texts)]
  ]);
  return {
    window: {
      document: {
        querySelectorAll(selector) {
          return selectorResults.get(selector) ?? [];
        }
      },
      openWranglerHarnessErrors: errors
    }
  };
}

function mockScreenshotCapture({ parent, onWaitForFunction, onReadinessConfirmation, clockAdvanceAfterInstall = 0 }) {
  const order = [];
  const timeouts = {};
  let clockInstallOptions;
  const outputPath = join(parent, "capture.png");
  let closeCalls = 0;
  let monotonicTime = 0;
  let clockTime = 0;
  const page = {
    clock: {
      async install(options) {
        clockInstallOptions = options;
        clockTime = options?.time ?? 0;
        clockTime += clockAdvanceAfterInstall;
        order.push("clock-install");
      },
      async setFixedTime(time) {
        assert.equal(time, 0);
        clockTime = time;
        order.push("clock-fix-time");
      },
      async pauseAt(time) {
        assert.equal(time, 0);
        assert.ok(time >= clockTime);
        clockTime = time;
        order.push("clock-pause");
      },
      async setSystemTime(time) {
        assert.equal(time, 0);
        clockTime = time;
        order.push("clock-reset-time");
      },
      async fastForward() {
        order.push("clock-fast-forward");
      },
      async resume() {
        order.push("clock-resume");
      }
    },
    async goto(_url, options) {
      timeouts.navigation = options.timeout;
      order.push("goto");
    },
    async waitForTimeout() {
      order.push("settle");
    },
    async waitForFunction(predicate, argument, options) {
      timeouts.readiness = options.timeout;
      order.push("readiness-wait");
      return onWaitForFunction?.(predicate, argument, options);
    },
    async evaluate(predicate, argument) {
      if (argument === undefined) {
        order.push("fonts");
        return undefined;
      }
      order.push("readiness-confirm");
      return onReadinessConfirmation?.(predicate, argument);
    },
    async screenshot({ path, timeout }) {
      timeouts.screenshot = timeout;
      order.push("screenshot");
      writeFileSync(path, "synthetic image");
    }
  };
  const context = {
    pages() {
      return [page];
    },
    async close() {
      closeCalls += 1;
      order.push("close");
    }
  };
  const chromium = {
    async launchPersistentContext(_profile, options) {
      timeouts.launch = options.timeout;
      order.push("launch");
      return context;
    }
  };
  return {
    chromium,
    outputPath,
    order,
    timeouts,
    clockInstallOptions: () => clockInstallOptions,
    closeCalls: () => closeCalls,
    options: {
      chromium,
      browser: { executablePath: process.execPath, explicitOverride: false },
      isolation: {
        workspaceTmp: parent,
        platform: process.platform,
        rootPrefix: "readiness-capture-",
        aliasPrefix: "ow-rdy-",
        shortTempParent: tmpdir()
      },
      url: "data:text/html,<title>readiness</title>",
      outputPath,
      monotonicNow() {
        monotonicTime += 100;
        return monotonicTime;
      }
    }
  };
}

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
              assert.ok(options.timeout > 0 && options.timeout <= 30_000);
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

test("selector readiness requires exact completed profiles without placeholders or harness errors", () => {
  const readiness = completedHeaderReadiness();
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(Object.isFrozen(readiness.argument.selectors), true);
  assert.equal(readiness.predicate(readiness.argument, readinessScope()), true);
  assert.equal(readiness.predicate(readiness.argument, readinessScope({ completedCount: 1 })), false);
  assert.equal(readiness.predicate(readiness.argument, readinessScope({ headerCount: 3 })), false);
  assert.equal(readiness.predicate(readiness.argument, readinessScope({ emptyCount: 1 })), false);
  assert.equal(readiness.predicate(readiness.argument, readinessScope({ texts: ["Ready", "Profiling…"] })), false);
  assert.throws(
    () => readiness.predicate(readiness.argument, readinessScope({ errors: ["synthetic harness error"] })),
    /openWranglerHarnessErrors reported an error/u
  );
});

test("screenshot capture waits for semantic readiness and confirms it before writing", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-readiness-wait-test-"));
  const readiness = completedHeaderReadiness();
  const capture = mockScreenshotCapture({
    parent,
    onWaitForFunction(predicate, argument, options) {
      assert.equal(predicate, readiness.predicate);
      assert.ok(options.timeout > 0 && options.timeout < 30_000);
      assert.equal(predicate(argument, readinessScope({ completedCount: 1, emptyCount: 1 })), false);
      assert.equal(predicate(argument, readinessScope()), true);
    },
    onReadinessConfirmation(predicate, argument) {
      return predicate(argument, readinessScope());
    }
  });
  try {
    const result = await captureWebviewScreenshot({ ...capture.options, readiness });
    assert.equal(result.outputPath, capture.outputPath);
    assert.deepEqual(Object.keys(capture.timeouts), ["launch", "navigation", "readiness", "screenshot"]);
    assert.ok(capture.timeouts.launch > capture.timeouts.navigation);
    assert.ok(capture.timeouts.navigation > capture.timeouts.readiness);
    assert.ok(capture.timeouts.readiness > capture.timeouts.screenshot);
    assert.deepEqual(capture.clockInstallOptions(), { time: 0 });
    assert.ok(capture.order.indexOf("clock-fix-time") < capture.order.indexOf("clock-pause"));
    assert.ok(capture.order.indexOf("clock-pause") < capture.order.indexOf("goto"));
    assert.ok(capture.order.indexOf("clock-reset-time") < capture.order.indexOf("goto"));
    assert.ok(capture.order.indexOf("clock-resume") < capture.order.indexOf("readiness-wait"));
    assert.ok(capture.order.indexOf("readiness-wait") < capture.order.indexOf("readiness-confirm"));
    assert.ok(capture.order.indexOf("readiness-confirm") < capture.order.indexOf("screenshot"));
    assert.equal(capture.closeCalls(), 1);
    assert.deepEqual(
      readdirSync(parent).filter((entry) => entry.startsWith("readiness-capture-")),
      []
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("readiness clock pauses safely after post-install real-time advancement", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-readiness-clock-race-test-"));
  const readiness = completedHeaderReadiness();
  const capture = mockScreenshotCapture({
    parent,
    clockAdvanceAfterInstall: 250,
    onWaitForFunction() {},
    onReadinessConfirmation(predicate, argument) {
      return predicate(argument, readinessScope());
    }
  });
  try {
    await captureWebviewScreenshot({ ...capture.options, readiness });
    assert.ok(capture.order.indexOf("clock-install") < capture.order.indexOf("clock-fix-time"));
    assert.ok(capture.order.indexOf("clock-fix-time") < capture.order.indexOf("clock-pause"));
    assert.ok(capture.order.indexOf("clock-pause") < capture.order.indexOf("clock-reset-time"));
    assert.ok(capture.order.indexOf("clock-reset-time") < capture.order.indexOf("goto"));
    assert.equal(capture.order.includes("screenshot"), true);
    assert.equal(capture.closeCalls(), 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("readiness timeout and lost readiness fail without taking a screenshot", async (context) => {
  await context.test("timeout", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ow-readiness-timeout-test-"));
    const readiness = completedHeaderReadiness();
    const capture = mockScreenshotCapture({
      parent,
      onWaitForFunction() {
        throw new Error("synthetic readiness timeout");
      }
    });
    try {
      await assert.rejects(
        () => captureWebviewScreenshot({ ...capture.options, readiness }),
        (error) =>
          error.message === "Webview readiness failed for test header profiles." &&
          error.cause?.message === "synthetic readiness timeout"
      );
      assert.equal(capture.order.includes("screenshot"), false);
      assert.equal(capture.closeCalls(), 1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  await context.test("predicate no longer holds", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ow-readiness-lost-test-"));
    const readiness = completedHeaderReadiness();
    const capture = mockScreenshotCapture({
      parent,
      onWaitForFunction() {},
      onReadinessConfirmation() {
        return false;
      }
    });
    try {
      await assert.rejects(
        () => captureWebviewScreenshot({ ...capture.options, readiness }),
        /Webview readiness was lost before capture for test header profiles\./u
      );
      assert.equal(capture.order.includes("screenshot"), false);
      assert.equal(capture.closeCalls(), 1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("screenshot capture does not add readiness work when the option is omitted", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-readiness-omitted-test-"));
  const capture = mockScreenshotCapture({
    parent,
    onWaitForFunction() {
      throw new Error("readiness must not be called");
    }
  });
  try {
    await captureWebviewScreenshot(capture.options);
    assert.equal(capture.order.includes("readiness-wait"), false);
    assert.equal(capture.order.includes("readiness-confirm"), false);
    assert.equal(capture.order.includes("clock-fix-time"), false);
    assert.equal(capture.order.includes("clock-pause"), false);
    assert.equal(capture.order.includes("clock-reset-time"), false);
    assert.equal(capture.order.includes("clock-resume"), false);
    assert.equal(capture.clockInstallOptions(), undefined);
    assert.equal(capture.order.includes("screenshot"), true);
    assert.equal(capture.closeCalls(), 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("capture deadline expiration prevents a readiness wait and screenshot", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-readiness-deadline-test-"));
  const readiness = completedHeaderReadiness();
  const capture = mockScreenshotCapture({ parent });
  const readings = [0, 1, 2, 30_000];
  let index = 0;
  try {
    await assert.rejects(
      () =>
        captureWebviewScreenshot({
          ...capture.options,
          readiness,
          monotonicNow() {
            return readings[index++] ?? readings.at(-1);
          }
        }),
      (error) =>
        error.message === "Webview readiness failed for test header profiles." &&
        error.cause?.message === "Webview capture deadline expired before semantic readiness."
    );
    assert.equal(capture.order.includes("readiness-wait"), false);
    assert.equal(capture.order.includes("screenshot"), false);
    assert.equal(capture.closeCalls(), 1);
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
  assert.equal((capture.match(/readiness: byExamplePreviewReadiness/gu) ?? []).length, 3);
  assert.match(capture, /byExampleHeaderCount !== 2/u);
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
