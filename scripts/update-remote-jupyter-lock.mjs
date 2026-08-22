import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  REMOTE_JUPYTER_INPUT_PATH,
  REMOTE_JUPYTER_LOCK_PATH,
  REMOTE_JUPYTER_LOCK_TOOL_VERSION,
  REMOTE_R_JUPYTER_INPUT_PATH,
  REMOTE_R_JUPYTER_LOCK_PATH,
  isRemoteJupyterLockToolVersionOutput,
  remoteJupyterCompileArguments,
  remoteRJupyterCompileArguments,
  validateRemoteJupyterLock,
  validateRemoteRJupyterLock
} from "./remote-jupyter-lock.mjs";
import {
  REMOTE_R_PACKAGE_LOCK_PATH,
  generateRemoteRPackageLock,
  validateRemoteRPackageLock
} from "./remote-r-package-lock.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const mode = process.argv[2];
if (!["--check", "--write"].includes(mode) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/update-remote-jupyter-lock.mjs --check|--write");
}

const version = spawnSync("uv", ["--version"], {
  cwd: REPOSITORY_ROOT,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
if (
  version.error ||
  version.status !== 0 ||
  version.signal !== null ||
  !isRemoteJupyterLockToolVersionOutput(version.stdout) ||
  version.stderr !== ""
) {
  throw new Error(`Remote Jupyter lock generation requires exactly uv ${REMOTE_JUPYTER_LOCK_TOOL_VERSION}.`);
}

const temporaryRoot = resolve(REPOSITORY_ROOT, "tmp");
await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
const workspace = await mkdtemp(join(temporaryRoot, "remote-jupyter-lock-"));
const fixtures = [
  {
    label: "Python",
    inputPath: REMOTE_JUPYTER_INPUT_PATH,
    lockPath: REMOTE_JUPYTER_LOCK_PATH,
    candidatePath: join(workspace, "requirements.txt"),
    compileArguments: remoteJupyterCompileArguments,
    validate: validateRemoteJupyterLock
  },
  {
    label: "R",
    inputPath: REMOTE_R_JUPYTER_INPUT_PATH,
    lockPath: REMOTE_R_JUPYTER_LOCK_PATH,
    candidatePath: join(workspace, "requirements.r.txt"),
    compileArguments: remoteRJupyterCompileArguments,
    validate: validateRemoteRJupyterLock
  }
];

try {
  const changed = [];
  for (const fixture of fixtures) {
    const generated = spawnSync("uv", fixture.compileArguments(fixture.candidatePath), {
      cwd: REPOSITORY_ROOT,
      env: controlledEnvironment(workspace),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024
    });
    if (generated.error || generated.status !== 0 || generated.signal !== null) {
      throw new Error(
        `Remote ${fixture.label} Jupyter lock generation failed: ${generated.error?.message ?? generated.stderr.trim()}`
      );
    }

    const [inputText, currentText, candidateText] = await Promise.all([
      readFile(fixture.inputPath, "utf8"),
      readFile(fixture.lockPath, "utf8"),
      readFile(fixture.candidatePath, "utf8")
    ]);
    fixture.validate(inputText, candidateText);
    if (candidateText !== currentText) changed.push({ fixture, candidateText });
  }

  const [currentRPackageLock, candidateRPackageLock] = await Promise.all([
    readFile(REMOTE_R_PACKAGE_LOCK_PATH, "utf8"),
    generateRemoteRPackageLock()
  ]);
  validateRemoteRPackageLock(candidateRPackageLock);
  if (candidateRPackageLock !== currentRPackageLock) {
    changed.push({
      fixture: { label: "R package", lockPath: REMOTE_R_PACKAGE_LOCK_PATH },
      candidateText: candidateRPackageLock
    });
  }

  if (changed.length === 0) {
    process.stdout.write("Remote Jupyter locks are reproducible and current.\n");
  } else if (mode === "--check") {
    throw new Error(
      "A remote Jupyter lock differs from clean deterministic regeneration; run npm run lock:remote-jupyter."
    );
  } else {
    for (const { fixture, candidateText } of changed) {
      await replaceLock(fixture.lockPath, candidateText);
    }
    process.stdout.write("Regenerated the remote Jupyter locks deterministically.\n");
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function controlledEnvironment(workspace) {
  const environment = {
    HOME: workspace,
    PATH: process.env.PATH ?? "",
    UV_CACHE_DIR: join(workspace, "cache"),
    UV_NO_PROGRESS: "1",
    NO_COLOR: "1"
  };
  for (const name of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SYSTEMROOT",
    "WINDIR"
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function replaceLock(lockPath, candidateText) {
  const sibling = join(dirname(lockPath), `.requirements-${randomUUID()}.tmp`);
  const handle = await open(sibling, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(candidateText, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(sibling, lockPath);
  } catch (error) {
    await rm(sibling, { force: true });
    throw error;
  }

  const published = await readFile(lockPath, "utf8");
  if (published !== candidateText) {
    throw new Error("Published remote Jupyter lock bytes changed after replacement.");
  }
}
