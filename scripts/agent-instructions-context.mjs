import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const ROOT_FILE_LIMIT_BYTES = 12 * 1_024;
const SCOPED_FILE_LIMIT_BYTES = 24 * 1_024;
const TOTAL_INSTRUCTION_LIMIT_BYTES = 96 * 1_024;
export const CONTEXT_LIMIT_BYTES = 32 * 1_024;
const MAX_INSTRUCTION_FILES = 16;
const MAX_ANCESTOR_DEPTH = 32;
const MAX_SCAN_DIRECTORIES = 4_096;
const MAX_SCAN_ENTRIES = 65_536;
const MAX_TRACKED_PATH_BYTES = 4_096;
const MAX_TRACKED_PATH_OUTPUT_BYTES = 128 * 1_024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function invariantIds(...numbers) {
  return numbers.map((number) => `I${String(number).padStart(2, "0")}`);
}

export const INSTRUCTION_MANIFEST = Object.freeze([
  Object.freeze({ path: "AGENTS.md", rules: invariantIds(2, 3, 4, 8), maxBytes: ROOT_FILE_LIMIT_BYTES }),
  Object.freeze({ path: ".github/AGENTS.md", rules: invariantIds(50), maxBytes: SCOPED_FILE_LIMIT_BYTES }),
  Object.freeze({ path: "docs/AGENTS.md", rules: invariantIds(9), maxBytes: SCOPED_FILE_LIMIT_BYTES }),
  Object.freeze({
    path: "python/AGENTS.md",
    rules: invariantIds(1, 10, 16, 17, 21, 23, 25, 53),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  }),
  Object.freeze({ path: "r/AGENTS.md", rules: invariantIds(54, 55, 56), maxBytes: SCOPED_FILE_LIMIT_BYTES }),
  Object.freeze({
    path: "scripts/AGENTS.md",
    rules: invariantIds(15, 37, 40, 41, 48, 49, 52, 58),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  }),
  Object.freeze({
    path: "src/extension/AGENTS.md",
    rules: invariantIds(6, 12, 14, 18, 19, 22, 24, 26, 27, 28, 34, 36, 38, 39, 42, 43, 45, 46, 47),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  }),
  Object.freeze({
    path: "src/shared/AGENTS.md",
    rules: invariantIds(5, 11, 29, 31, 32, 33, 35, 51, 57),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  }),
  Object.freeze({
    path: "src/webviews/AGENTS.md",
    rules: invariantIds(7, 13, 20, 30, 44),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  })
]);

export const EXPECTED_INSTRUCTION_FILES = Object.freeze(INSTRUCTION_MANIFEST.map((entry) => entry.path));
const MANIFEST_BY_PATH = new Map(INSTRUCTION_MANIFEST.map((entry) => [entry.path, entry]));
const EXPECTED_RULE_IDS = Object.freeze(invariantIds(...Array.from({ length: 58 }, (_, index) => index + 1)));

const CANONICAL_INVARIANT_DIGESTS = Object.freeze({
  I01: "8e72528721db4ab1e22e105887e21d8dbfb2aab1b0c804e975f2ddb694f547a9",
  I02: "45cd3d7d851c6e0fe759e29bca461a6f01d8d62fd52ab7d04a19c4c45e38fb34",
  I03: "7bde5dc808753e4448c5d362786552fe5dcb994f237cb3a582fff5197ea6da55",
  I04: "9c4039e08f2920dcb837b478708960b06fa5c101947b5ffa5fd8f26cce6a594a",
  I05: "18e418eb7d65bd71c149c8db641fe834b7808f14df14f8ec7f7edd78eb69e4d6",
  I06: "a22becccb8650fbef1f338ccc3af9af062920c22d83e5591443b4e54130de5c7",
  I07: "3e85afb7351a870051bf56c86bac1dac5a396faf0901d3dc8a668f3b5bec7d76",
  I08: "b2e21643fbd34a2e0373166e31b837abadb8996f708de5df469a1ca0da201252",
  I09: "7d884e00f8e7c7c9affcf1d75af0b51491f70c11ccbb6bbec3f31381012449a3",
  I10: "3cf94384bd4e7e6e521e03f6cfcd4083ae4d14ffbc0361e516e5366a45703e4b",
  I11: "71c4e6cc4a7918ea92268fb365a41df3f194933d76d140304d813c303e169bcc",
  I12: "d2d726fcb4864808508580a133cff13cc9f40682620c82bc7a56f5d9fffeac85",
  I13: "90fe38f15a27c754b4bbab1ea4a401013ae527950fafd354b64597c415f2dca7",
  I14: "7c9a205733a7323093996c3e23eee0b299e1735182ceb26ef9c35a1b93ee79c0",
  I15: "757cbf037f01fdf92ae8fc818910512196c416dd48094fe9be853857ed22a10b",
  I16: "6313ecd15e9adf89bcba68f58e4b9ec1d18a165875ad97fb224621c447fb641f",
  I17: "12067cabc4ca3b4af50683499ff40f6950b55d29bb062df16ed1abbfae08337d",
  I18: "1e559cf6aa4eafb3c8fcc1d0a43088063e8e2606345b4d50a6466c596d2c132e",
  I19: "9c6529a02a8c0519738969d0240451a95fe723235b9eb03bd4a3e307c65a4655",
  I20: "61afafaa23a78a5257da8843ef149f613055238b991a98600f2fc6d8ce6ff513",
  I21: "ed823e0d37c7f1575c90adf47b11b01951b3a866c573de570d9368f06d501b4f",
  I22: "b0daf74d7e640894cd605959a809ea5a1e94a2548ca9fe44f67c97bb9e4e9efc",
  I23: "414b2ad3aa777d027f2ddcde6c50c043c3a2b6ff9ad4deec28b00c9ad27ef9d1",
  I24: "c2e9b807bb56091496fa5f6f8cae8e2c221725e04bae8f3ef5b0fa71447c786c",
  I25: "493f05401bad5bdbcbaed15654f5e98376e0ca5e9da439facae3cb3c840e69c5",
  I26: "0609fe8d69320eed6bf4d00471d734328f1dd8b9b8b8bc15ff06a79a31e45bea",
  I27: "ea9c68be4a98678374abe2e2ef0b43408c4a455543f50335befa3697008c7631",
  I28: "4360da3caa640915ca0c1901f2b4ee7404c57315d01fa4de50bf028ebd3cf863",
  I29: "7bfd3f5f5242f187081a9c1b560c6b0925efb7f49f8ac968322adc08311fb535",
  I30: "4ce64dabfa8855ac8face48ac64a41ddc5fb2c3e8d0a2401fb6eb6a1cf085e9e",
  I31: "3131b901e72e3ae9731dad8f6a4b82705ad959aff4baf6dc9154ebc950903ba0",
  I32: "bbbfa09df098601834cc86b3cdbedda6b392cddca403f7dfd96c4fe3bdc96156",
  I33: "f0db19db6cb89e9e4e8a28c762985c9a4abc46309a7af16f4938d710d1ac40fe",
  I34: "8db8fc19058174f425da2d17fc9049ed769b7158672fb60e0bcba74f3c8d12df",
  I35: "8736efce7487f53753929bee59796f64183d01e3900f28cbf941510976a805f8",
  I36: "f97bc6174859b5951864d2d4b5937670575f4e2cb5ee5efedaab3c60b3f21fba",
  I37: "1b76772c379bbe6954e802ce33fd79cf13b84aa4a072016589472744548bb176",
  I38: "762353d53946587402e7675a96855d6766e26df21680589e924fa5d78bfadea1",
  I39: "38fa3e31c13b7a9729d12889064e0cb56f80746c9942714c61ea3de444efd3c4",
  I40: "a24c4916e5797309917c912f4e5ffdcf29ba18b24054685f9722db261b6a6eb2",
  I41: "365946925062ea0670b6115515e805905371595eecb934cb7ab23a0b72bd2e2e",
  I42: "d9d99f54f100111ef17307f763272c8f5fd8a04d1d14faeb5d8d7da8280c447f",
  I43: "60c9f487b5567214955cab6ccefc57d06bd91252fecf112bd3b4faa6d7e6ea4e",
  I44: "ce44b52105765b18481fcc1a70fe4062fb262c23902e9cbc535706be5ead5b85",
  I45: "93bf757d6291a72d2086eb461cccf1bd5496c2cf76d5f52d4b9b6ad8a53b5277",
  I46: "46820b8c8b489465163deba7badd0a806b02c32ef01b5c8ca1e3c0c056ad3477",
  I47: "5512bbd753ce3542daa5cba4cf274a18c574f6900a1c7ec7c63ff0b76d2d7d32",
  I48: "0a8fe23de9d4a29da0462a0bd8ab35200ff77955eecba3f7ef4963df88d2f6b7",
  I49: "1e74e042913ce641a573596a02bdfc24f98b07a7369adfeb8a016f91fc6ac3d3",
  I50: "2bb4cac84068ce312db5dc02d18bbd07856761e722cb6bcd5fa02a546a010cf8",
  I51: "e8297589cec37799e4b86f2b32963a5bf457ae490296f64e4da5e6aeb3c4d36b",
  I52: "a134a41159e867c205619e54dffb26095471587c8a8e960dc7606f26274d22df",
  I53: "e27c4b982ce6f4a0502bf2c4ff37e32d73f3df95d719ae5f830097b5b5901d6f",
  I54: "b2a7dd82681cf1ad5766352ebf5c8f07d8b64de407c2e9ca4b237d76b59072a5",
  I55: "98bb5eb5246eeecd46055b97bfdce0887a3c7efa242dc72f138d02753060871e",
  I56: "77405fb4b4faaae726feeec543628c69b65cb1d17638afed3ec326fb936c9568",
  I57: "1c8a7faaf14ce70513af3f0d7556363d313c3d45ed9409e6041abe0aaeb7bcf3",
  I58: "a0781a6b1974ac92c12bd5bb9eef3598187a5f229558a3a90496887fe411cb86"
});

export const REPRESENTATIVE_CONTEXTS = Object.freeze([
  Object.freeze({ target: "README.md", targetKind: "file", instructions: Object.freeze(["AGENTS.md"]) }),
  Object.freeze({
    target: ".github/workflows/ci.yml",
    targetKind: "file",
    instructions: Object.freeze(["AGENTS.md", ".github/AGENTS.md"])
  }),
  Object.freeze({
    target: "docs/architecture.md",
    targetKind: "file",
    instructions: Object.freeze(["AGENTS.md", "docs/AGENTS.md"])
  }),
  Object.freeze({
    target: "python/openwrangler_runtime/server.py",
    targetKind: "file",
    instructions: Object.freeze(["AGENTS.md", "python/AGENTS.md"])
  }),
  Object.freeze({
    target: "r/openwrangler_runtime/frame_contract.R",
    targetKind: "file",
    instructions: Object.freeze(["AGENTS.md", "r/AGENTS.md"])
  }),
  Object.freeze({
    target: "scripts/check-docs.mjs",
    targetKind: "file",
    instructions: Object.freeze(["AGENTS.md", "scripts/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/extension/nativeViews.ts",
    targetKind: "file",
    instructions: Object.freeze(["AGENTS.md", "src/extension/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/shared/protocol.ts",
    targetKind: "file",
    instructions: Object.freeze(["AGENTS.md", "src/shared/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/webviews/App.tsx",
    targetKind: "file",
    instructions: Object.freeze(["AGENTS.md", "src/webviews/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/test/protocol.unit.test.ts",
    targetKind: "file",
    routedInstructions: Object.freeze(["src/shared/AGENTS.md"]),
    instructions: Object.freeze(["AGENTS.md", "src/shared/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/test/sessionCoordinator.unit.test.ts",
    targetKind: "file",
    routedInstructions: Object.freeze(["src/extension/AGENTS.md"]),
    instructions: Object.freeze(["AGENTS.md", "src/extension/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/test/operationBuilder.component.test.tsx",
    targetKind: "file",
    routedInstructions: Object.freeze(["src/webviews/AGENTS.md"]),
    instructions: Object.freeze(["AGENTS.md", "src/webviews/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/test/extensionHost/index.ts",
    targetKind: "file",
    routedInstructions: Object.freeze(["scripts/AGENTS.md"]),
    instructions: Object.freeze(["AGENTS.md", "scripts/AGENTS.md"])
  })
]);

function instructionError(message) {
  const error = new Error(message);
  error.code = "AGENT_INSTRUCTIONS_INVALID";
  return error;
}

function portableRelativePath(path) {
  return path.split(sep).join("/");
}

function normalizedRepositoryPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_TRACKED_PATH_BYTES ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "." ||
    value.endsWith("/") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw instructionError(`${label} must be one exact normalized repository-relative path.`);
  }
  return value;
}

function containedRelativePath(root, candidate) {
  const value = relative(root, candidate);
  if (value === "") return "";
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) {
    throw instructionError("An agent-instruction path escaped the repository root.");
  }
  return portableRelativePath(value);
}

function exactStatIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function openVerifiedDirectory(absolutePath, label, openDirectory = openSync) {
  const pathSnapshot = lstatSync(absolutePath, { bigint: true });
  if (!pathSnapshot.isDirectory() || pathSnapshot.isSymbolicLink()) {
    throw instructionError(`${label} must be one real directory.`);
  }
  const descriptor = openDirectory(
    absolutePath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const openedSnapshot = fstatSync(descriptor, { bigint: true });
    if (!exactStatIdentity(pathSnapshot, openedSnapshot)) {
      throw instructionError(`${label} changed identity before its descriptor was bound.`);
    }
    return { absolutePath, descriptor, label, snapshot: openedSnapshot };
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      throw instructionError(`${label} could not close after descriptor binding failed.`);
    }
    throw error;
  }
}

function withVerifiedDirectoryChain(
  root,
  relativeDirectory,
  callback,
  { beforeAncestorRevalidation, openDirectory = openSync } = {}
) {
  const normalizedDirectory = relativeDirectory === "" ? "" : normalizedRepositoryPath(relativeDirectory, "Directory");
  const parts = normalizedDirectory === "" ? [] : normalizedDirectory.split("/");
  if (parts.length > MAX_ANCESTOR_DEPTH) throw instructionError("The instruction ancestor depth is too large.");
  const opened = [];
  let result;
  let failure;
  try {
    let current = root;
    opened.push(openVerifiedDirectory(current, "The repository root", openDirectory));
    for (const part of parts) {
      current = join(current, part);
      opened.push(
        openVerifiedDirectory(current, `Directory ${portableRelativePath(relative(root, current))}`, openDirectory)
      );
    }
    result = callback(Object.freeze([...opened]));
    beforeAncestorRevalidation?.();
    for (const directory of opened) {
      const descriptorSnapshot = fstatSync(directory.descriptor, { bigint: true });
      let pathSnapshot;
      try {
        pathSnapshot = lstatSync(directory.absolutePath, { bigint: true });
      } catch {
        throw instructionError(`${directory.label} disappeared before ancestor revalidation.`);
      }
      if (
        !pathSnapshot.isDirectory() ||
        pathSnapshot.isSymbolicLink() ||
        !exactStatIdentity(directory.snapshot, descriptorSnapshot) ||
        !exactStatIdentity(directory.snapshot, pathSnapshot)
      ) {
        throw instructionError(`${directory.label} changed during the descriptor-bound operation.`);
      }
    }
  } catch (error) {
    failure = error;
  }
  let closeFailure = false;
  for (const directory of opened.reverse()) {
    try {
      closeSync(directory.descriptor);
    } catch {
      closeFailure = true;
    }
  }
  if (failure) throw failure;
  if (closeFailure) throw instructionError("A verified ancestor directory descriptor did not close.");
  return result;
}

function verifyRegularPath(absolutePath, label, { privateFile = false, openFile = openSync } = {}) {
  const pathSnapshot = lstatSync(absolutePath, { bigint: true });
  if (!pathSnapshot.isFile() || pathSnapshot.isSymbolicLink() || (privateFile && pathSnapshot.nlink !== 1n)) {
    throw instructionError(`${label} must be one ${privateFile ? "private " : ""}regular file.`);
  }
  const descriptor = openFile(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let result;
  let failure;
  try {
    const openedSnapshot = fstatSync(descriptor, { bigint: true });
    if (!exactStatIdentity(pathSnapshot, openedSnapshot)) {
      throw instructionError(`${label} changed identity before its descriptor was bound.`);
    }
    result = openedSnapshot;
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(descriptor);
  } catch {
    failure ??= instructionError(`${label} could not close its verified descriptor.`);
  }
  if (failure) throw failure;
  return result;
}

export function readBoundedInstructionFile(
  repositoryRoot,
  relativePath,
  { maxBytes = SCOPED_FILE_LIMIT_BYTES, openFile = openSync, openDirectory = openSync, beforeAncestorRevalidation } = {}
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > TOTAL_INSTRUCTION_LIMIT_BYTES) {
    throw instructionError("The agent-instruction file limit is invalid.");
  }
  const normalizedPath = normalizedRepositoryPath(relativePath, "Agent-instruction path");
  const root = realpathSync(repositoryRoot);
  const absolutePath = resolve(root, normalizedPath);
  containedRelativePath(root, absolutePath);
  return withVerifiedDirectoryChain(
    root,
    posix.dirname(normalizedPath) === "." ? "" : posix.dirname(normalizedPath),
    () => {
      const pathSnapshot = lstatSync(absolutePath, { bigint: true });
      if (!pathSnapshot.isFile() || pathSnapshot.isSymbolicLink() || pathSnapshot.nlink !== 1n) {
        throw instructionError(`${relativePath} must be one private regular file.`);
      }
      if (pathSnapshot.size <= 0n || pathSnapshot.size > BigInt(maxBytes)) {
        throw instructionError(`${relativePath} exceeds its bounded instruction-file size.`);
      }
      const descriptor = openFile(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let result;
      let failure;
      try {
        const openedSnapshot = fstatSync(descriptor, { bigint: true });
        if (!exactStatIdentity(pathSnapshot, openedSnapshot)) {
          throw instructionError(`${relativePath} changed identity before its bounded read.`);
        }
        const bytes = Buffer.alloc(Number(pathSnapshot.size));
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
          if (count <= 0) throw instructionError(`${relativePath} ended before its recorded size.`);
          offset += count;
        }
        const finalSnapshot = fstatSync(descriptor, { bigint: true });
        if (!exactStatIdentity(openedSnapshot, finalSnapshot)) {
          throw instructionError(`${relativePath} changed during its bounded read.`);
        }
        let text;
        try {
          text = UTF8.decode(bytes);
        } catch {
          throw instructionError(`${relativePath} is not strict UTF-8.`);
        }
        if (text.includes("\0")) throw instructionError(`${relativePath} contains a NUL character.`);
        result = Object.freeze({ path: normalizedPath, bytes: bytes.length, text });
      } catch (error) {
        failure = error;
      }
      try {
        closeSync(descriptor);
      } catch {
        failure ??= instructionError(`${relativePath} could not close its verified descriptor.`);
      }
      if (failure) throw failure;
      return result;
    },
    { beforeAncestorRevalidation, openDirectory }
  );
}

function completionMarker(path, digest) {
  return `<!-- OW-INSTRUCTIONS:EOF path="${path}" sha256="${digest}" -->`;
}

function canonicalInvariantBody(rule, text) {
  const number = Number.parseInt(rule.slice(1), 10);
  const numberedPrefix = new RegExp(`^${number}\\.\\s*`, "u");
  const trimmed = text.trim();
  if (!numberedPrefix.test(trimmed)) {
    throw instructionError(`${rule} does not begin with its exact invariant number.`);
  }
  return trimmed.replace(numberedPrefix, "").trim().replace(/\s+/gu, " ");
}

function validateCanonicalInvariantBodies(path, body, expectedRules) {
  const blocks = [
    ...body.matchAll(/<!-- OW-RULE:(I\d{2}) -->\n([\s\S]*?)(?=\n<!-- OW-RULE:|\n## |\n<!-- OW-INSTRUCTIONS:EOF|$)/gu)
  ];
  const rules = blocks.map((match) => match[1]);
  if (rules.length !== expectedRules.length || rules.some((rule, index) => rule !== expectedRules[index])) {
    throw instructionError(`${path} does not own its exact ordered rule inventory.`);
  }
  for (const match of blocks) {
    const rule = match[1];
    const canonical = canonicalInvariantBody(rule, match[2]);
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    if (digest !== CANONICAL_INVARIANT_DIGESTS[rule]) {
      throw instructionError(`${path} changed the independently sealed canonical body for ${rule}.`);
    }
  }
  return Object.freeze(rules);
}

const ACTIVE_PROMPT_SLUDGE = Object.freeze([
  /^#{1,6}\s+(?:migration|delivery|issue|review|run|workflow|evidence|receipt|tracker)\s+(?:history|log|receipts?|tracker|status)\b/imu,
  /^(?:[-*]\s*)?(?:issue|pull request|pr)\s*#?\d+\b/imu,
  /^(?:[-*]\s*)?(?:issue|pr|pull request|review(?:er)?(?:\s+verdict)?|verdict|run(?:\s+(?:id|number|url|receipt))?|workflow(?:\s+(?:run|id|number|url|receipt))?|job(?:\s+(?:id|number|url|receipt))?|tracker|status|state|owner|assignee|blocker|next action|evidence|receipt|head|tree|commit)\s*(?:#\d+)?\s*:/imu,
  /(?:github\.com\/[^\s)]+\/(?:issues|pull|actions\/runs)\/\d+)/iu,
  /<\/?(?:codex_delegation|source_thread_id)>/iu,
  /^(?:[-*]\s*)?(?:exact\s+)?(?:head|tree|commit)\s*=\s*[0-9a-f]{7,40}\b/imu,
  /^(?:[-*]\s*)?(?:review|evidence|test|publication)\s+receipt\s*:/imu
]);

export function validateInstructionDocument(repositoryRoot, manifestEntry) {
  const document = readBoundedInstructionFile(repositoryRoot, manifestEntry.path, {
    maxBytes: manifestEntry.maxBytes
  });
  const markerPattern = /<!-- OW-INSTRUCTIONS:EOF path="([^"]+)" sha256="([0-9a-f]{64})" -->\n$/u;
  const markerMatch = markerPattern.exec(document.text);
  if (!markerMatch || markerMatch[1] !== manifestEntry.path) {
    throw instructionError(`${manifestEntry.path} is missing its exact path-bound completion marker.`);
  }
  const marker = completionMarker(markerMatch[1], markerMatch[2]);
  const markerIndex = document.text.lastIndexOf(marker);
  const body = document.text.slice(0, markerIndex);
  if (body.includes("OW-INSTRUCTIONS:EOF")) {
    throw instructionError(`${manifestEntry.path} contains more than one completion marker.`);
  }
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  if (digest !== markerMatch[2]) {
    throw instructionError(`${manifestEntry.path} does not match its completion checksum.`);
  }
  const rules = validateCanonicalInvariantBodies(manifestEntry.path, body, manifestEntry.rules);
  if (ACTIVE_PROMPT_SLUDGE.some((pattern) => pattern.test(body))) {
    throw instructionError(`${manifestEntry.path} contains issue, review, run, or tracker sludge in an active prompt.`);
  }
  return Object.freeze({ ...document, digest, marker, rules: Object.freeze(rules) });
}

export function discoverAgentInstructionPaths(
  repositoryRoot,
  targetPath,
  { targetKind, beforeAncestorRevalidation } = {}
) {
  const root = realpathSync(repositoryRoot);
  const normalizedTarget = normalizedRepositoryPath(targetPath, "Context target");
  if (targetKind !== "file" && targetKind !== "directory") {
    throw instructionError("The context target must declare exact file or directory semantics.");
  }
  const absoluteTarget = resolve(root, normalizedTarget);
  containedRelativePath(root, absoluteTarget);
  const targetDirectory = targetKind === "directory" ? normalizedTarget : posix.dirname(normalizedTarget);
  const relativeDirectory = targetDirectory === "." ? "" : targetDirectory;
  return withVerifiedDirectoryChain(
    root,
    relativeDirectory,
    (directories) => {
      if (targetKind === "file") {
        verifyRegularPath(absoluteTarget, `Context target ${normalizedTarget}`, { privateFile: true });
      }
      const discovered = [];
      for (const directory of directories) {
        const candidate = join(directory.absolutePath, "AGENTS.md");
        try {
          verifyRegularPath(candidate, "An ancestor AGENTS.md", { privateFile: true });
          discovered.push(containedRelativePath(root, candidate));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      if (discovered.length === 0 || discovered.length > MAX_INSTRUCTION_FILES) {
        throw instructionError("The context target has an invalid instruction-file count.");
      }
      return Object.freeze(discovered);
    },
    { beforeAncestorRevalidation }
  );
}

function trackedAgentInstructionPaths(repositoryRoot) {
  const root = realpathSync(repositoryRoot);
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
    delete environment[name];
  }
  let hasRepositoryMetadata = false;
  try {
    const metadata = lstatSync(join(root, ".git"), { bigint: true });
    hasRepositoryMetadata = metadata.isDirectory() || metadata.isFile();
  } catch (error) {
    if (error?.code !== "ENOENT") throw instructionError("The repository metadata path could not be inspected.");
  }
  if (hasRepositoryMetadata) {
    for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) {
      delete environment[name];
    }
  } else {
    if (!environment.GIT_DIR || !environment.GIT_WORK_TREE) {
      throw instructionError("The exact repository has no bound Git metadata overlay.");
    }
    try {
      if (realpathSync(environment.GIT_WORK_TREE) !== root) {
        throw instructionError("The Git metadata overlay belongs to another work tree.");
      }
    } catch (error) {
      if (error?.code === "AGENT_INSTRUCTIONS_INVALID") throw error;
      throw instructionError("The Git metadata overlay work tree could not be verified.");
    }
  }
  let topLevel;
  let output;
  try {
    topLevel = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: MAX_TRACKED_PATH_OUTPUT_BYTES,
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    output = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "AGENTS.md", ":(glob)**/AGENTS.md"], {
      encoding: "buffer",
      env: environment,
      maxBuffer: MAX_TRACKED_PATH_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
  } catch {
    throw instructionError("The tracked AGENTS.md inventory could not be read from the exact repository.");
  }
  if (realpathSync(topLevel) !== root) {
    throw instructionError("The Git work-tree root does not match the instruction repository root.");
  }
  const tracked = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    const segment = output.subarray(start, index);
    start = index + 1;
    if (segment.length === 0 || segment.length > MAX_TRACKED_PATH_BYTES) {
      throw instructionError("The tracked AGENTS.md inventory contains an invalid path length.");
    }
    let path;
    try {
      path = UTF8.decode(segment);
    } catch {
      throw instructionError("The tracked AGENTS.md inventory is not strict UTF-8.");
    }
    normalizedRepositoryPath(path, "Tracked AGENTS.md path");
    if (posix.basename(path) !== "AGENTS.md") {
      throw instructionError("The tracked instruction inventory contains a non-AGENTS.md path.");
    }
    if (tracked.length >= MAX_INSTRUCTION_FILES) {
      throw instructionError("Too many tracked AGENTS.md files were discovered.");
    }
    tracked.push(path);
  }
  if (start !== output.length) throw instructionError("The tracked AGENTS.md inventory is missing a NUL terminator.");
  tracked.sort();
  if (tracked.some((path, index) => index > 0 && tracked[index - 1] === path)) {
    throw instructionError("The tracked AGENTS.md inventory contains a duplicate path.");
  }
  return Object.freeze(tracked);
}

export function scanTrackedAgentInstructionPaths(
  repositoryRoot,
  trackedPaths,
  { maxDirectories = MAX_SCAN_DIRECTORIES, maxEntries = MAX_SCAN_ENTRIES, openDirectory = opendirSync } = {}
) {
  if (!Number.isSafeInteger(maxDirectories) || maxDirectories <= 0 || maxDirectories > MAX_SCAN_DIRECTORIES) {
    throw instructionError("The instruction directory-scan bound is invalid.");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > MAX_SCAN_ENTRIES) {
    throw instructionError("The instruction entry-scan bound is invalid.");
  }
  const root = realpathSync(repositoryRoot);
  const tracked = new Set();
  const directoryPrefixes = new Set([""]);
  for (const rawPath of trackedPaths) {
    const path = normalizedRepositoryPath(rawPath, "Tracked AGENTS.md path");
    if (posix.basename(path) !== "AGENTS.md" || tracked.has(path)) {
      throw instructionError("The tracked instruction inventory contains an invalid or duplicate path.");
    }
    if (tracked.size >= MAX_INSTRUCTION_FILES)
      throw instructionError("Too many tracked AGENTS.md files were discovered.");
    tracked.add(path);
    let directory = posix.dirname(path);
    while (directory !== ".") {
      directoryPrefixes.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const pending = [{ path: root, relativePath: "", depth: 0 }];
  const found = [];
  let directoryCount = 1;
  let entryCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const directory = openDirectory(current.path);
    let failure;
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        entryCount += 1;
        if (entryCount > maxEntries) {
          throw instructionError("The instruction scope scan exceeded its entry bound before retention.");
        }
        const relativePath = current.relativePath === "" ? entry.name : `${current.relativePath}/${entry.name}`;
        const absolutePath = join(current.path, entry.name);
        if (entry.name === "AGENTS.md" && tracked.has(relativePath)) {
          if (found.length >= MAX_INSTRUCTION_FILES) {
            throw instructionError("Too many active AGENTS.md files were discovered.");
          }
          found.push(containedRelativePath(root, absolutePath));
        }
        if (directoryPrefixes.has(relativePath)) {
          const snapshot = lstatSync(absolutePath, { bigint: true });
          if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
            throw instructionError("A tracked AGENTS.md ancestor is not one real directory.");
          }
          const nextDepth = current.depth + 1;
          directoryCount += 1;
          if (directoryCount > maxDirectories || nextDepth > MAX_ANCESTOR_DEPTH) {
            throw instructionError("The instruction scope scan exceeded its directory bound before retention.");
          }
          pending.push({ path: absolutePath, relativePath, depth: nextDepth });
        }
      }
    } catch (error) {
      failure = error;
    }
    try {
      directory.closeSync();
    } catch {
      failure ??= instructionError("An instruction-scan directory descriptor did not close.");
    }
    if (failure) throw failure;
  }
  found.sort();
  const expected = [...tracked].sort();
  if (found.length !== expected.length || found.some((path, index) => path !== expected[index])) {
    throw instructionError("A tracked AGENTS.md path was missing or replaced during the streamed scan.");
  }
  return Object.freeze(found);
}

export function validateDeliveredInstructionContext(delivery, documents, maxBytes = CONTEXT_LIMIT_BYTES) {
  if (Buffer.byteLength(delivery, "utf8") > maxBytes) {
    throw instructionError("The delivered instruction context exceeds its aggregate byte bound.");
  }
  const expected = documents.map((document) => document.text).join("\n");
  if (delivery !== expected) throw instructionError("The delivered instruction context changed content or order.");
  let previousMarker = -1;
  for (const document of documents) {
    const index = delivery.indexOf(document.marker);
    if (index <= previousMarker || delivery.indexOf(document.marker, index + 1) !== -1) {
      throw instructionError(
        "The delivered instruction context has a missing, duplicate, or reordered completion marker."
      );
    }
    previousMarker = index;
  }
  return true;
}

export function loadAgentInstructionContext(
  repositoryRoot,
  targetPath,
  { targetKind, routedInstructions = Object.freeze([]) } = {}
) {
  const ancestors = discoverAgentInstructionPaths(repositoryRoot, targetPath, { targetKind });
  const routed = [];
  for (const rawPath of routedInstructions) {
    const path = normalizedRepositoryPath(rawPath, "Routed instruction path");
    if (!MANIFEST_BY_PATH.has(path) || ancestors.includes(path) || routed.includes(path)) {
      throw instructionError(`The context target has an invalid or duplicate routed scope ${path}.`);
    }
    routed.push(path);
  }
  const paths = Object.freeze([...ancestors, ...routed]);
  const documents = paths.map((path) => {
    const entry = MANIFEST_BY_PATH.get(path);
    if (!entry) throw instructionError(`The context target discovered unregistered scope ${path}.`);
    return validateInstructionDocument(repositoryRoot, entry);
  });
  const totalBytes = documents.reduce((total, document) => total + document.bytes, 0) + documents.length - 1;
  if (totalBytes > CONTEXT_LIMIT_BYTES) {
    throw instructionError(`The ${targetPath} instruction context exceeds its aggregate byte bound.`);
  }
  const delivery = documents.map((document) => document.text).join("\n");
  validateDeliveredInstructionContext(delivery, documents);
  return Object.freeze({
    target: targetPath,
    paths,
    documents: Object.freeze(documents),
    delivery,
    bytes: Buffer.byteLength(delivery, "utf8")
  });
}

export function validateAgentInstructionContext(repositoryRoot) {
  const trackedFiles = trackedAgentInstructionPaths(repositoryRoot);
  const discoveredFiles = scanTrackedAgentInstructionPaths(repositoryRoot, trackedFiles);
  const expectedFiles = [...EXPECTED_INSTRUCTION_FILES].sort();
  if (
    discoveredFiles.length !== expectedFiles.length ||
    discoveredFiles.some((path, index) => path !== expectedFiles[index])
  ) {
    throw instructionError("The repository contains a missing or unregistered AGENTS.md scope.");
  }

  const documents = INSTRUCTION_MANIFEST.map((entry) => validateInstructionDocument(repositoryRoot, entry));
  const totalBytes = documents.reduce((total, document) => total + document.bytes, 0);
  if (totalBytes > TOTAL_INSTRUCTION_LIMIT_BYTES) {
    throw instructionError("The complete instruction set exceeds its aggregate byte bound.");
  }
  const owners = new Map();
  for (const document of documents) {
    for (const rule of document.rules) {
      if (owners.has(rule)) throw instructionError(`${rule} has duplicate owners.`);
      owners.set(rule, document.path);
    }
  }
  for (const rule of EXPECTED_RULE_IDS) {
    if (!owners.has(rule)) throw instructionError(`${rule} has no scoped owner.`);
  }
  if (owners.size !== EXPECTED_RULE_IDS.length) throw instructionError("The rule inventory contains an unknown owner.");

  const contexts = REPRESENTATIVE_CONTEXTS.map((representative) => {
    const context = loadAgentInstructionContext(repositoryRoot, representative.target, {
      targetKind: representative.targetKind,
      routedInstructions: representative.routedInstructions
    });
    if (
      context.paths.length !== representative.instructions.length ||
      context.paths.some((path, index) => path !== representative.instructions[index])
    ) {
      throw instructionError(`${representative.target} loaded the wrong instruction scopes or ancestor order.`);
    }
    return Object.freeze({ target: context.target, paths: context.paths, bytes: context.bytes });
  });
  return Object.freeze({
    files: documents.length,
    rules: owners.size,
    totalBytes,
    maximumContextBytes: Math.max(...contexts.map((context) => context.bytes)),
    contexts: Object.freeze(contexts)
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = validateAgentInstructionContext(repositoryRoot);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `Scoped agent instructions are invalid: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
