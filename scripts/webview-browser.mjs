import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const WEBVIEW_BROWSER_PREREQUISITE_FAILURE = "WEBVIEW_BROWSER_PREREQUISITE_FAILED";

export function resolveWebviewBrowserExecutable({ chromium, environment = process.env, platform = process.platform }) {
  const override = environment.CHROME_BIN;
  if (override !== undefined && (typeof override !== "string" || !isAbsolute(override))) {
    throw new Error("CHROME_BIN must be an absolute browser executable path when it is set.");
  }
  const executablePath = override ?? chromium.executablePath();
  try {
    if (!statSync(executablePath).isFile()) throw new Error("not a file");
    accessSync(executablePath, platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(
      override === undefined
        ? "The pinned Playwright Chromium executable is unavailable; run `npx playwright-core install chromium`."
        : "CHROME_BIN must identify one accessible executable file; no browser fallback is permitted."
    );
  }
  return Object.freeze({ executablePath, explicitOverride: override !== undefined });
}

export function webviewBrowserPrerequisiteFailure(cause) {
  if (cause instanceof Error && cause.code === WEBVIEW_BROWSER_PREREQUISITE_FAILURE) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`${WEBVIEW_BROWSER_PREREQUISITE_FAILURE}: ${detail}`, { cause });
  error.code = WEBVIEW_BROWSER_PREREQUISITE_FAILURE;
  return error;
}

export function createWebviewSelectorReadiness({ description, selectors, absentText = [], emptyArrayGlobals = [] }) {
  if (typeof description !== "string" || description.trim() === "" || description.length > 200) {
    throw new TypeError("Webview readiness requires a concise non-empty description.");
  }
  if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > 16) {
    throw new TypeError("Webview readiness requires between 1 and 16 selector counts.");
  }
  if (!Array.isArray(absentText) || absentText.length > 16) {
    throw new TypeError("Webview readiness accepts at most 16 absent-text checks.");
  }
  if (!Array.isArray(emptyArrayGlobals) || emptyArrayGlobals.length > 8) {
    throw new TypeError("Webview readiness accepts at most 8 empty-array checks.");
  }

  const normalizedSelectors = selectors.map(({ selector, count }) => {
    if (typeof selector !== "string" || selector.trim() === "" || selector.length > 500) {
      throw new TypeError("Webview readiness selectors must be concise non-empty strings.");
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("Webview readiness selector counts must be non-negative safe integers.");
    }
    return Object.freeze({ selector, count });
  });
  const normalizedAbsentText = absentText.map(({ selector, text }) => {
    if (typeof selector !== "string" || selector.trim() === "" || selector.length > 500) {
      throw new TypeError("Webview readiness text selectors must be concise non-empty strings.");
    }
    if (typeof text !== "string" || text === "" || text.length > 500) {
      throw new TypeError("Webview readiness forbidden text must be a concise non-empty string.");
    }
    return Object.freeze({ selector, text });
  });
  const normalizedEmptyArrays = emptyArrayGlobals.map((name) => {
    if (typeof name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/u.test(name)) {
      throw new TypeError("Webview readiness array checks must name bounded global properties.");
    }
    return name;
  });

  return Object.freeze({
    description,
    predicate: webviewSelectorReadinessSatisfied,
    argument: Object.freeze({
      selectors: Object.freeze(normalizedSelectors),
      absentText: Object.freeze(normalizedAbsentText),
      emptyArrayGlobals: Object.freeze(normalizedEmptyArrays)
    })
  });
}

export function webviewSelectorReadinessSatisfied(configuration, scope = globalThis) {
  const pageGlobal = scope.window ?? scope;
  const pageDocument = pageGlobal.document ?? scope.document;
  if (!pageDocument || typeof pageDocument.querySelectorAll !== "function") {
    throw new Error("The webview readiness document is unavailable.");
  }
  for (const property of configuration.emptyArrayGlobals) {
    const value = pageGlobal[property];
    if (!Array.isArray(value)) throw new Error(`The webview readiness array ${property} is unavailable.`);
    if (value.length !== 0) throw new Error(`The webview readiness array ${property} reported an error.`);
  }
  for (const { selector, count } of configuration.selectors) {
    if (pageDocument.querySelectorAll(selector).length !== count) return false;
  }
  for (const { selector, text } of configuration.absentText) {
    const elements = pageDocument.querySelectorAll(selector);
    if (Array.from(elements).some((element) => element.textContent?.includes(text))) return false;
  }
  return true;
}

async function waitForWebviewReadiness(page, readiness, remainingTimeout) {
  if (readiness === undefined) return;
  if (
    !readiness ||
    typeof readiness !== "object" ||
    typeof readiness.description !== "string" ||
    readiness.description.trim() === "" ||
    typeof readiness.predicate !== "function"
  ) {
    throw new TypeError("Webview screenshot readiness must provide a description and predicate.");
  }
  try {
    await page.clock.resume();
    await page.waitForFunction(readiness.predicate, readiness.argument, {
      timeout: remainingTimeout("semantic readiness")
    });
  } catch (cause) {
    throw new Error(`Webview readiness failed for ${readiness.description}.`, { cause });
  }
  let remainsReady;
  try {
    remainingTimeout("readiness confirmation");
    remainsReady = await page.evaluate(readiness.predicate, readiness.argument);
  } catch (cause) {
    throw new Error(`Webview readiness could not be confirmed for ${readiness.description}.`, { cause });
  }
  if (remainsReady !== true) {
    throw new Error(`Webview readiness was lost before capture for ${readiness.description}.`);
  }
}

function createCaptureDeadline(timeout, monotonicNow) {
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new TypeError("Webview capture timeout must be a positive safe integer.");
  }
  if (typeof monotonicNow !== "function") throw new TypeError("Webview capture requires a monotonic clock.");
  const startedAt = monotonicNow();
  if (!Number.isFinite(startedAt)) throw new Error("The webview capture monotonic clock is unavailable.");
  const deadline = startedAt + timeout;
  let previous = startedAt;
  return (phase) => {
    const current = monotonicNow();
    if (!Number.isFinite(current) || current < previous) {
      throw new Error("The webview capture monotonic clock moved backwards.");
    }
    previous = current;
    const remaining = Math.floor(deadline - current);
    if (remaining < 1) throw new Error(`Webview capture deadline expired before ${phase}.`);
    return remaining;
  };
}

export function createWebviewBrowserIsolation({
  workspaceTmp,
  environment = process.env,
  platform = process.platform,
  rootPrefix,
  aliasPrefix,
  shortTempParent = "/tmp"
}) {
  if (!isAbsolute(workspaceTmp)) throw new Error("The browser workspace temp directory must be absolute.");
  mkdirSync(workspaceTmp, { recursive: true });
  let root;
  let aliasRoot;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (aliasRoot) rmSync(aliasRoot, { recursive: true, force: true });
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  };

  try {
    root = mkdtempSync(join(workspaceTmp, rootPrefix));
    chmodSync(root, 0o700);
    const paths = Object.fromEntries(
      ["home", "cache", "config", "data", "state", "runtime", "temp", "profiles"].map((name) => [
        name,
        join(root, name)
      ])
    );
    for (const path of Object.values(paths)) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
    }
    let temp = paths.temp;
    if (platform !== "win32") {
      aliasRoot = mkdtempSync(join(shortTempParent, aliasPrefix));
      chmodSync(aliasRoot, 0o700);
      temp = join(aliasRoot, "t");
      symlinkSync(paths.temp, temp, "dir");
      if (Buffer.byteLength(join(temp, "com.google.Chrome.XXXXXX", "SingletonSocket"), "utf8") >= 104) {
        throw new Error("The private Chrome temp alias is too long for a POSIX process-singleton socket.");
      }
    }
    const childEnvironment = Object.freeze({
      ...environment,
      HOME: paths.home,
      XDG_CACHE_HOME: paths.cache,
      XDG_CONFIG_HOME: paths.config,
      XDG_DATA_HOME: paths.data,
      XDG_STATE_HOME: paths.state,
      XDG_RUNTIME_DIR: paths.runtime,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp
    });
    return Object.freeze({
      root,
      childEnvironment,
      createProfile(label) {
        const profile = mkdtempSync(join(paths.profiles, `${label}-`));
        chmodSync(profile, 0o700);
        return profile;
      },
      cleanup
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function captureWebviewScreenshot({
  chromium,
  browser,
  isolation,
  url,
  outputPath,
  width = 1280,
  height = 760,
  pixelRatio = 1,
  virtualTime = 2500,
  timeout = 30_000,
  label = "capture",
  readiness,
  monotonicNow = performance.now.bind(performance)
}) {
  const remainingTimeout = createCaptureDeadline(timeout, monotonicNow);
  const lease = createWebviewBrowserIsolation(isolation);
  let context;
  try {
    const profile = lease.createProfile(label);
    context = await chromium.launchPersistentContext(profile, {
      ...(browser.explicitOverride ? { executablePath: browser.executablePath } : {}),
      headless: true,
      ignoreDefaultArgs: ["--hide-scrollbars"],
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--allow-file-access-from-files",
        ...(pixelRatio === 1 ? [] : [`--force-device-scale-factor=${pixelRatio}`])
      ],
      env: lease.childEnvironment,
      viewport: { width, height },
      deviceScaleFactor: pixelRatio,
      timeout: remainingTimeout("browser launch")
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.clock.install(readiness === undefined ? undefined : { time: 0 });
    if (readiness !== undefined) {
      await page.clock.setFixedTime(0);
      await page.clock.pauseAt(0);
      await page.clock.setSystemTime(0);
    }
    await page.goto(url, { waitUntil: "load", timeout: remainingTimeout("navigation") });
    await page.waitForTimeout(50);
    await page.clock.fastForward(virtualTime);
    await page.waitForTimeout(50);
    await page.evaluate(async () => document.fonts.ready);
    await waitForWebviewReadiness(page, readiness, remainingTimeout);
    const privateOutput = outputPath ?? join(lease.root, "capture.png");
    await page.screenshot({ path: privateOutput, timeout: remainingTimeout("screenshot") });
    const output = statSync(privateOutput);
    if (!output.isFile() || output.size === 0) throw new Error("The browser did not produce its requested image.");
    return Object.freeze({ outputPath: privateOutput, size: output.size });
  } finally {
    try {
      await context?.close();
    } finally {
      lease.cleanup();
    }
  }
}

export async function preflightWebviewBrowser({
  chromium,
  cwd = resolve(import.meta.dirname, ".."),
  workspaceTmp = resolve(cwd, "tmp"),
  environment = process.env,
  platform = process.platform,
  shortTempParent = "/tmp"
}) {
  try {
    const browser = resolveWebviewBrowserExecutable({ chromium, environment, platform });
    await captureWebviewScreenshot({
      chromium,
      browser,
      isolation: {
        workspaceTmp,
        environment,
        platform,
        rootPrefix: "webview-browser-preflight-",
        aliasPrefix: "ow-webview-",
        shortTempParent
      },
      label: "profile",
      timeout: 30_000,
      width: 16,
      height: 16,
      virtualTime: 100,
      url: "data:text/html,<title>Open%20Wrangler</title>"
    });
    return browser;
  } catch (error) {
    throw webviewBrowserPrerequisiteFailure(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("The webview browser preflight accepts no arguments.");
    const { chromium } = await import("playwright-core");
    await preflightWebviewBrowser({ chromium });
    console.log("Webview browser preflight passed.");
  } catch (error) {
    console.error(webviewBrowserPrerequisiteFailure(error).message);
    process.exitCode = 1;
  }
}
