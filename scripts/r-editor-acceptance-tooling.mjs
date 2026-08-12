import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createEditorAcceptanceEnvironment, runBoundedEditorCommand } from "./editor-acceptance.mjs";

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAYS_MS = Object.freeze([2_000, 4_000]);
const DEFAULT_TIMER_OPERATIONS = Object.freeze({
  setTimeout,
  clearTimeout
});

export const R_EDITOR_ACCEPTANCE_TOOLING = Object.freeze({
  rSyntax: Object.freeze({
    id: "reditorsupport.r-syntax@0.1.4",
    fileName: "REditorSupport.r-syntax-0.1.4.vsix",
    url: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/REditorSupport/vsextensions/r-syntax/0.1.4/vspackage",
    bytes: 91_323,
    sha256: "ecc5f4d6688f6e239f9f15da08c834c802875ec05cc11518ba253dc93ccc1884"
  }),
  r: Object.freeze({
    id: "reditorsupport.r@2.8.8",
    fileName: "REditorSupport.r-2.8.8.vsix",
    url: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/REditorSupport/vsextensions/r/2.8.8/vspackage",
    bytes: 2_767_944,
    sha256: "9add9b7aceda1dc0072cc9e048b5bfcc8de4488ccd2802ea5fe834517a3ce2e2"
  }),
  quartoExtension: Object.freeze({
    id: "quarto.quarto@1.135.0",
    fileName: "quarto.quarto-1.135.0.vsix",
    url: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/quarto/vsextensions/quarto/1.135.0/vspackage",
    bytes: 9_519_967,
    sha256: "2b17625bf58540dee709986107bc27b4285cbfe555dc4f1de457c0ac2b7ed0a4"
  }),
  quartoCli: Object.freeze({
    version: "1.10.18",
    fileName: "quarto-1.10.18-linux-amd64.tar.gz",
    url: "https://github.com/quarto-dev/quarto-cli/releases/download/v1.10.18/quarto-1.10.18-linux-amd64.tar.gz",
    bytes: 147_010_003,
    sha256: "afad071b5bd22c02f2d300695743189d3650e0537a53073e654b630cff2b0c73",
    pandocRelativePath: "bin/tools/x86_64/pandoc"
  })
});

export async function prepareREditorAcceptanceTooling(
  parent,
  {
    artifactPaths = {},
    fetchImpl = fetch,
    onArtifactAttempt,
    runCommand = runBoundedEditorCommand,
    environment = createEditorAcceptanceEnvironment()
  } = {}
) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Native R and Quarto editor acceptance currently supports Linux x64 only.");
  }
  if (onArtifactAttempt !== undefined && typeof onArtifactAttempt !== "function") {
    throw new Error("R editor tooling artifact attempt reporting must be a function.");
  }
  const canonicalParent = privateDirectory(parent);
  const root = join(canonicalParent, `r-editor-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  const extensionVsixes = [];
  for (const key of ["rSyntax", "r", "quartoExtension"]) {
    const pin = R_EDITOR_ACCEPTANCE_TOOLING[key];
    extensionVsixes.push(
      await acquireExactArtifact(root, key, pin, {
        fetchImpl,
        onAttempt: onArtifactAttempt,
        sourcePath: artifactPaths[key]
      })
    );
  }
  const quartoArchive = await acquireExactArtifact(root, "quartoCli", R_EDITOR_ACCEPTANCE_TOOLING.quartoCli, {
    fetchImpl,
    onAttempt: onArtifactAttempt,
    sourcePath: artifactPaths.quartoCli
  });
  const installRoot = join(root, "quarto");
  mkdirSync(installRoot, { mode: 0o700 });
  await runCommand(
    {
      executable: "tar",
      args: ["-xzf", quartoArchive, "-C", installRoot, "--no-same-owner", "--no-same-permissions"],
      environment,
      label: "Pinned Quarto CLI extraction"
    },
    { timeoutMs: 120_000 }
  );
  const quartoRoot = resolve(installRoot, `quarto-${R_EDITOR_ACCEPTANCE_TOOLING.quartoCli.version}`);
  const quartoExecutable = resolve(quartoRoot, "bin", "quarto");
  assertContainedExecutable(quartoExecutable, installRoot, "quarto");
  const pandocExecutable = resolve(quartoRoot, R_EDITOR_ACCEPTANCE_TOOLING.quartoCli.pandocRelativePath);
  assertContainedExecutable(pandocExecutable, installRoot, "pandoc");
  const version = await runCommand(
    {
      executable: quartoExecutable,
      args: ["--version"],
      environment,
      label: "Pinned Quarto CLI version probe"
    },
    { timeoutMs: 30_000 }
  );
  if (version.stdout.trim() !== R_EDITOR_ACCEPTANCE_TOOLING.quartoCli.version) {
    throw new Error("The pinned Quarto CLI reported an unexpected version.");
  }
  return Object.freeze({
    root,
    extensionVsixes: Object.freeze(extensionVsixes),
    quartoExecutable,
    pandocDirectory: resolve(pandocExecutable, "..")
  });
}

export async function acquireExactArtifact(
  root,
  key,
  pin,
  {
    fetchImpl = fetch,
    onAttempt,
    sourcePath,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    timersForTest = DEFAULT_TIMER_OPERATIONS,
    waitForRetryForTest = waitForRetry
  } = {}
) {
  if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(key)) {
    throw new Error("R editor tooling artifact acquisition requires a public artifact key.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOWNLOAD_TIMEOUT_MS) {
    throw new Error(`R editor tooling artifact timeout must be no larger than ${DOWNLOAD_TIMEOUT_MS} ms.`);
  }
  if (
    !timersForTest ||
    typeof timersForTest !== "object" ||
    typeof timersForTest.setTimeout !== "function" ||
    typeof timersForTest.clearTimeout !== "function" ||
    typeof waitForRetryForTest !== "function"
  ) {
    throw new Error("R editor tooling artifact acquisition requires bounded timer operations.");
  }
  if (onAttempt !== undefined && typeof onAttempt !== "function") {
    throw new Error("R editor tooling artifact attempt reporting must be a function.");
  }
  if (
    !pin ||
    typeof pin !== "object" ||
    typeof pin.fileName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(pin.fileName) ||
    pin.fileName === "." ||
    pin.fileName === ".." ||
    basename(pin.fileName) !== pin.fileName ||
    typeof pin.url !== "string" ||
    !isPublicArtifactUrl(pin.url) ||
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes <= 0 ||
    typeof pin.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(pin.sha256)
  ) {
    throw new Error("R editor tooling artifact acquisition requires one valid pinned artifact.");
  }
  const destination = join(privateDirectory(root), pin.fileName);
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) {
      throw new Error(`${pin.fileName} override must be an absolute path.`);
    }
    const source = resolve(sourcePath);
    if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile()) {
      throw new Error(`${pin.fileName} override must be a regular, non-symbolic file.`);
    }
    await writeVerifiedArtifact(createReadStream(source), destination, pin);
    return destination;
  }
  const deadlineController = new AbortController();
  let timer;
  try {
    try {
      timer = timersForTest.setTimeout(() => deadlineController.abort(), timeoutMs);
    } catch {
      throw artifactAttemptError(key, pin, 1, "could not schedule its aggregate download deadline");
    }
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
      if (deadlineController.signal.aborted) {
        throw artifactAttemptError(key, pin, attempt, "exceeded its aggregate download deadline");
      }
      try {
        onAttempt?.(
          Object.freeze({
            key,
            fileName: pin.fileName,
            attempt,
            maximumAttempts: MAX_DOWNLOAD_ATTEMPTS
          })
        );
      } catch {
        throw artifactAttemptError(key, pin, attempt, "could not publish its attempt checkpoint");
      }

      const attemptController = new AbortController();
      const detachDeadline = forwardAbort(deadlineController.signal, attemptController);
      let transportRejected = false;
      try {
        let responsePromise;
        try {
          responsePromise = fetchImpl(pin.url, {
            headers: { "User-Agent": "Open-Wrangler-release-acceptance" },
            redirect: "follow",
            signal: attemptController.signal
          });
        } catch {
          throw artifactAttemptError(key, pin, attempt, "could not start its fetch");
        }

        const fetchOutcome = await settleOperationBeforeAbort(() => responsePromise, deadlineController.signal);
        let response;
        if (fetchOutcome.outcome === "aborted") {
          throw artifactAttemptError(key, pin, attempt, "exceeded its aggregate download deadline");
        }
        if (fetchOutcome.outcome === "failed") {
          transportRejected = true;
        } else {
          response = fetchOutcome.value;
        }

        if (!transportRejected) {
          if (deadlineController.signal.aborted) {
            await disposeRejectedResponseBody(response?.body, key, pin, attempt, deadlineController.signal);
            throw artifactAttemptError(key, pin, attempt, "exceeded its aggregate download deadline");
          }
          if (!response || typeof response !== "object") {
            throw artifactAttemptError(key, pin, attempt, "returned an invalid response");
          }
          if (response.ok !== true) {
            await disposeRejectedResponseBody(response.body, key, pin, attempt, deadlineController.signal);
            if (deadlineController.signal.aborted) {
              throw artifactAttemptError(key, pin, attempt, "exceeded its aggregate download deadline");
            }
            throw artifactAttemptError(key, pin, attempt, "returned a non-success HTTP response");
          }
          if (!response.body) {
            throw artifactAttemptError(key, pin, attempt, "returned no response body");
          }

          let body;
          try {
            body = Readable.fromWeb(response.body);
          } catch {
            await disposeRejectedResponseBody(response.body, key, pin, attempt, deadlineController.signal);
            if (deadlineController.signal.aborted) {
              throw artifactAttemptError(key, pin, attempt, "exceeded its aggregate download deadline");
            }
            throw artifactAttemptError(key, pin, attempt, "returned an invalid response body");
          }
          try {
            await writeVerifiedArtifact(body, destination, pin, attemptController.signal);
          } catch {
            if (deadlineController.signal.aborted) {
              throw artifactAttemptError(key, pin, attempt, "exceeded its aggregate download deadline");
            }
            throw artifactAttemptError(key, pin, attempt, "failed exact response-body verification");
          }
          if (deadlineController.signal.aborted) {
            try {
              rmSync(destination, { force: true });
            } catch {
              throw artifactAttemptError(key, pin, attempt, "could not remove its expired response body");
            }
            throw artifactAttemptError(key, pin, attempt, "exceeded its aggregate download deadline");
          }
          return destination;
        }
      } finally {
        detachDeadline();
        attemptController.abort();
      }

      if (deadlineController.signal.aborted) {
        throw artifactAttemptError(key, pin, attempt, "exceeded its aggregate download deadline");
      }
      if (attempt === MAX_DOWNLOAD_ATTEMPTS) {
        throw artifactAttemptError(key, pin, attempt, "exhausted its fetch attempts");
      }
      const backoffOutcome = await settleOperationBeforeAbort(
        () => waitForRetryForTest(DOWNLOAD_RETRY_DELAYS_MS[attempt - 1], deadlineController.signal, timersForTest),
        deadlineController.signal
      );
      if (deadlineController.signal.aborted || backoffOutcome.outcome === "aborted") {
        throw artifactAttemptError(key, pin, attempt, "exceeded its aggregate download deadline");
      }
      if (backoffOutcome.outcome === "failed") {
        throw artifactAttemptError(key, pin, attempt, "could not complete its retry backoff");
      }
    }
  } finally {
    if (timer !== undefined) timersForTest.clearTimeout(timer);
    deadlineController.abort();
  }
}

function isPublicArtifactUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname.length > 0 &&
      parsed.pathname.startsWith("/") &&
      parsed.pathname.length > 1 &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function artifactAttemptError(key, pin, attempt, failure) {
  return new Error(
    `R editor tooling artifact ${key} (${pin.fileName}) attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS} ${failure}.`
  );
}

function forwardAbort(source, target) {
  if (source.aborted) {
    target.abort();
    return () => {};
  }
  const abort = () => target.abort();
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function disposeRejectedResponseBody(body, key, pin, attempt, signal) {
  if (!body) return;
  if (typeof body.cancel !== "function") {
    throw artifactAttemptError(key, pin, attempt, "could not dispose its rejected response body");
  }
  const outcome = await settleOperationBeforeAbort(() => body.cancel(), signal);
  if (outcome.outcome === "aborted") return;
  if (outcome.outcome === "failed") {
    throw artifactAttemptError(key, pin, attempt, "could not dispose its rejected response body");
  }
}

function settleOperationBeforeAbort(operation, signal) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (outcome, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolvePromise(Object.freeze({ outcome, value }));
    };
    const abort = () => finish("aborted");
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish("completed", value),
        () => finish("failed")
      );
    if (signal.aborted) abort();
  });
}

function waitForRetry(delayMs, signal, timers) {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(new Error("R editor tooling retry backoff was cancelled."));
      return;
    }
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(new Error("R editor tooling retry backoff was cancelled.")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      timer = timers.setTimeout(() => finish(resolvePromise), delayMs);
    } catch {
      finish(() => reject(new Error("R editor tooling retry backoff could not be scheduled.")));
      return;
    }
    if (settled && timer !== undefined) timers.clearTimeout(timer);
    if (signal.aborted) abort();
  });
}

async function writeVerifiedArtifact(source, destination, pin, signal) {
  const digest = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > pin.bytes) {
        callback(new Error(`${pin.fileName} exceeded its pinned size.`));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== pin.bytes || digest.digest("hex") !== pin.sha256) {
        callback(new Error(`${pin.fileName} did not match its pinned checksum.`));
        return;
      }
      callback();
    }
  });
  const writer = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  try {
    if (signal) {
      await pipeline(source, verifier, writer, { signal });
    } else {
      await pipeline(source, verifier, writer);
    }
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

function privateDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("R editor tooling requires an absolute private parent directory.");
  }
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("R editor tooling requires a regular private parent directory.");
  }
  return canonical;
}

function assertContainedExecutable(path, parent, expectedName) {
  const canonical = realpathSync(path);
  const canonicalParent = realpathSync(parent);
  const contained = relative(canonicalParent, canonical);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error("The Quarto executable escaped its private installation root.");
  }
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error("The extracted Quarto CLI is not an executable regular file.");
  }
  if (basename(canonical) !== expectedName || !existsSync(canonical)) {
    throw new Error(`The extracted Quarto ${expectedName} path is invalid.`);
  }
}
