import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  Dir,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder, types as utilTypes } from "node:util";

const ROOT_FILE_LIMIT_BYTES = 12 * 1_024;
const SCOPED_FILE_LIMIT_BYTES = 24 * 1_024;
const TOTAL_INSTRUCTION_LIMIT_BYTES = 96 * 1_024;
export const CONTEXT_LIMIT_BYTES = 64 * 1_024;
const MAX_INSTRUCTION_FILES = 16;
const MAX_ANCESTOR_DEPTH = 32;
const MAX_SCAN_DIRECTORIES = 4_096;
const MAX_SCAN_ENTRIES = 65_536;
const MAX_TRACKED_PATH_BYTES = 4_096;
const MAX_TRACKED_PATH_OUTPUT_BYTES = 128 * 1_024;
const MAX_TRACKED_PREFIX_BYTES = MAX_TRACKED_PATH_OUTPUT_BYTES;
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

export const APPLICATION_DELIVERY_EVIDENCE = Object.freeze({
  actualCodexApplicationPathObserved: false,
  actualTruncationBehaviorObserved: false,
  publicationBlocked: true,
  requiredCanary: "a real application-path completion-marker canary"
});

const CANONICAL_INVARIANT_DIGESTS = Object.freeze({
  I01: "34fc798aa5cdf4abc207bfc9b5008b139d1f82110157cd935bff584c548b7f71",
  I02: "5f2f96f62971f7abd72b0b5b293ee20296d5330413e3e41fe25a91228f71d6fc",
  I03: "aedfc27be9428e7cbbc040be7cb5c0b112125463b1d2a74fd6fe59daf73f9963",
  I04: "4f43c86181c9f21b09c1c6b09f6a4f20ab85eb3a8ac2691365db023cd5f5757a",
  I05: "7dbeceb9b6ba15efa7946d4e84ac8de679aa52c93788b73443285e0eba05c416",
  I06: "75edcf3b3e01db48a3ac0e00cc3583be2919ea26b2286062cdc086e6a836e34a",
  I07: "1b87e008a430d46956c412640d04fdaf337ffe87c09f77288173f0c4389e7891",
  I08: "ea18bdee98b20ddd5cd19316e9c9b917e8cd69f81dd14c99d603aeb3a30b3c84",
  I09: "dc075aa72a0b36933569035b1bc0b5e9079609ecaa17d124878625dab17e3098",
  I10: "92112d1c1043c821a986fbff2da34d08187129e801c810b659486d7a8566d2d5",
  I11: "17ac7dcb6409e58089eb9f47a216868ea44c1a8ff665f6d496e3f4ea2fe2d8ab",
  I12: "afe26ca1d7dd70b204780d91e5cab16016199505b99d51bd4fd5a18340c53b31",
  I13: "43dba82b79164bba8cbf76a477214a5452d8ed9eb7f9df8674f433245d1be202",
  I14: "b70eb629935b1ba2889f1db322c753677530b257be553b82abd86a7971f4e596",
  I15: "8093bef8fb53055e1a40206e1c072bb67f8f5c62b63979c3a1d1d5933d857498",
  I16: "8bac3e7f0e9c7d32f711bcb3158b460e3ce391f70d16fd1a15b1fea620ec9306",
  I17: "9b3a7cc44904a45b7d5c7a068e90892fef80833a8eba12e8a58c16561c811d25",
  I18: "f158d138252dc6811f2fa70fcc78cea7511be22781d57122d889823ac8221095",
  I19: "cc15c7aab53eb09360a278a2f849f68b39e866b64bd418003acda6f4369c69af",
  I20: "959f3f3550356452a1aa19c8e952c3c0166d58b9e4a8c89b2b83d9584f076436",
  I21: "b46cb973722141001ddcc1134239b5d28edf91308d3c11d67664cdd8eed6ccf4",
  I22: "0cc5ef230e589fad227b3cad343b8c079f3dddf084faa08fde315edcec740d88",
  I23: "87a1da6d659bb575be10a530c6a18cab78915662b0aec302ce22993476ba8e5d",
  I24: "ca11260fa25e2a1002472fce82734c7ebd77152048f84f4f52070f3aefc15132",
  I25: "56c39d2265690345644b507ddc2ecff31356cd72f1bf691715807468e3961811",
  I26: "c5ab67a703eea113e08cce5385bd350ba130918e05449d4df2c952ea3949ff8e",
  I27: "9c8555258893f26125ac8137f872fef03269c2f2ff87c314ebcd74960dcbc907",
  I28: "95eb24a8b0d5a88e8a5818a1f98eabf2c5433146a439d560be5d7c8e74650f30",
  I29: "922fc2bb59543238fe616242f8ec97cb731220f2fa564d678209fd4052e1328b",
  I30: "88b3f670db2357916378f8bc9d684afcf6acda1b2234f46c05e8507d63907dbd",
  I31: "2d474686ce213f32b44dc4d14955449cb976fb8cc0cd4cdcbc2fae33ceef10c5",
  I32: "7d1a11f0a380b0ec8bf62a294f5f3874d8ba29cfc77800683424fa3a08f53e6f",
  I33: "5e9ad55c2ef7e7f68dedd0fb1616b7dd10e081420807aba8c582dd5e60c5a110",
  I34: "ed90eb521e27e6f65691f2bc8b0efe7d2b94b5823a9b7abc1c450bea80dbd6ef",
  I35: "fdafcab9bd7c9bdc917c935b9e5ef5a9c59e9f522a48e05fe7c60f87d0c1cac4",
  I36: "1c249f9cdc94ae6f8f47e75a1cc6249e9609eb94d77c1d8db4d0b5d7a847e605",
  I37: "a2bcdd00ff6ccecbfee5f8e72bba07919934a5eb8990eadf3776034639393d33",
  I38: "f4c566883f88d12a4db2b4c4f27cb57ff41de89ced6683befdf939324a530cbb",
  I39: "5c9b3866ca8d6affc76b198f5516db5b24c652b1cbfc3d9ff15ceca082acaeea",
  I40: "5fd1108a8348c9b0e221f4c843fbcbca8ca918f257eff59cc03ad29290053643",
  I41: "48dfd0f585feef41ce0bd4c2664281d22900a4c21170322a5fc5954f41638b7f",
  I42: "ed4b66c37fa5e8338e7e85ae39ea5d7d5897406c49ef16c63f0c46696cad896c",
  I43: "2324a3c9d39a0cf4e0f00f8978fc3a1763a2571761f5d87089a94380fafa892a",
  I44: "ab81f0c134c2febcef7aba45488c8231fdf1bcb2a7516d3ebe38c3c2fa568425",
  I45: "cf3e3e5de86488f5a3ed428a95bf1f046179a3ca25634b465d1da323d305536f",
  I46: "e73f3fdd8c47ddbbde035ab7e4365f2e09a64d9839e253bb522e3301ae7e371e",
  I47: "f479dadf1eadcded574e2a3b7fe191106490a04d23f251d79fef61920bdaabef",
  I48: "c716a766c09a19c8ed29df8cde3ad3b802029caf8f3ed40bb0266f745a9aaff5",
  I49: "f39c199273c404b762937a6d31154f23785ca1462cb49b816272f6cea513659d",
  I50: "f05b8625c1d30dec3fcdf0786c732be03aef8ac692289a79397016dca106838c",
  I51: "f2021f1b2ed72e16c040f5ca4a83808fe92256de49bb2d7ddf61863c0f82529e",
  I52: "a73626660cb24d8478015dbb0aa7410a26ccf338938e6c9b2ca9f86e0e6d54f7",
  I53: "4d0195bb8b6f34abf2c99b4d2f00f46962655b9009858b453e2e9c2391ec8ff3",
  I54: "cd1466b3207fd65daf610d38b4123109f14d59f25b258a5ef858f6af394d83e4",
  I55: "3f1b663056c8fa2449bcaaa3045506c45e6625edc290bbc7105401792a9b12ce",
  I56: "f7ed9b0113b2984c439d2e00691d8f1ef03eccbf049ababaa7dcae36cb23ee0e",
  I57: "956ccde4935b0c7156f32357ee5ba76006f289a49293e6fecb4611bdbd2d3589",
  I58: "d758926763928349c3c8d2a126bada576c579f4f018e4e9fe3fbc6c9bc3133ad"
});

const CANONICAL_ACTIVE_POLICY_STRUCTURE_DIGESTS = Object.freeze({
  "AGENTS.md": "51b2877cf3711937bda36c384ec24e8c48c96b90798e0977c208fb40e7e9e9b0",
  ".github/AGENTS.md": "28a1066d9e914b3960795a0e554fa3d3b3bc9dc48539bff0d08ccdaf6d717631",
  "docs/AGENTS.md": "32ced510ade556374b0179716e5d19d6e0ab84b43fb54e5dc608d641da03aef9",
  "python/AGENTS.md": "cc2e9df594fc301d6505c88e596f94d93cc081e884408fe7382c872980a141db",
  "r/AGENTS.md": "8465f58fb453216c9d3f37081b8591c196a8e6a08f18d3a6d7e090b853901635",
  "scripts/AGENTS.md": "10ff5aebdb33164b67f14c7789c2bff137d06d66c097c36dd1d4bf4689a36002",
  "src/extension/AGENTS.md": "e725a3b44db0cfe002ed82461bcc8757539270daaf1a2df5fc34e724dfb1cfd4",
  "src/shared/AGENTS.md": "0863648107d71994284fd95615bf82624a6c98a0b4b8d2142e10c2311df6af5c",
  "src/webviews/AGENTS.md": "e8086d06779a811dc1705aa06de4f9c251bbf7541fcdce3a11a803fb681242d6"
});

export const REPRESENTATIVE_CONTEXTS = Object.freeze([
  Object.freeze({
    target: "README.md",
    targetKind: "file",
    routedInstructions: Object.freeze(["docs/AGENTS.md"]),
    instructions: Object.freeze(["AGENTS.md", "docs/AGENTS.md"])
  }),
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
    routedInstructions: Object.freeze(["src/shared/AGENTS.md", "src/extension/AGENTS.md"]),
    instructions: Object.freeze(["AGENTS.md", "src/shared/AGENTS.md", "src/extension/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/test/operationBuilder.component.test.tsx",
    targetKind: "file",
    routedInstructions: Object.freeze(["src/shared/AGENTS.md", "src/webviews/AGENTS.md"]),
    instructions: Object.freeze(["AGENTS.md", "src/shared/AGENTS.md", "src/webviews/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/test/extensionHost/index.ts",
    targetKind: "file",
    routedInstructions: Object.freeze([
      "src/shared/AGENTS.md",
      "src/extension/AGENTS.md",
      "src/webviews/AGENTS.md",
      "python/AGENTS.md",
      "r/AGENTS.md",
      "scripts/AGENTS.md"
    ]),
    instructions: Object.freeze([
      "AGENTS.md",
      "src/shared/AGENTS.md",
      "src/extension/AGENTS.md",
      "src/webviews/AGENTS.md",
      "python/AGENTS.md",
      "r/AGENTS.md",
      "scripts/AGENTS.md"
    ])
  })
]);

function instructionError(message, options) {
  const error = new Error(message, options);
  error.code = "AGENT_INSTRUCTIONS_INVALID";
  return error;
}

function instructionAggregateError(message, errors) {
  const error = new AggregateError(errors, message);
  error.code = "AGENT_INSTRUCTIONS_INVALID";
  return error;
}

function portableRelativePath(path) {
  return path.split(sep).join("/");
}

function isExactNormalizedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return value.normalize("NFC") === value;
}

function normalizedRepositoryPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isExactNormalizedUnicode(value) ||
    Buffer.byteLength(value, "utf8") > MAX_TRACKED_PATH_BYTES ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "." ||
    value.endsWith("/") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw instructionError(`${label} must be one exact normalized valid-Unicode repository-relative path.`);
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
  const numberedPrefix = `${number}. `;
  if (!text.startsWith(numberedPrefix)) {
    throw instructionError(`${rule} does not begin with its exact invariant number.`);
  }
  let fence;
  return text
    .slice(numberedPrefix.length)
    .split("\n")
    .map((line) => {
      if (/^[ \t]*$/u.test(line)) return "";
      const leading = /^[ \t]*/u.exec(line)?.[0] ?? "";
      const fenceMatch = leading.length <= 3 ? /^(`{3,}|~{3,})/u.exec(line.slice(leading.length)) : null;
      const isFenceBoundary = fenceMatch !== null;
      const wasInsideFence = fence !== undefined;
      if (isFenceBoundary) {
        const marker = fenceMatch[1];
        if (fence === undefined) fence = Object.freeze({ character: marker[0], length: marker.length });
        else if (marker[0] === fence.character && marker.length >= fence.length) fence = undefined;
      }
      if (wasInsideFence || isFenceBoundary) return line;
      const trailing = /[ \t]*$/u.exec(line)?.[0] ?? "";
      const contentEnd = trailing.length === 0 ? line.length : line.length - trailing.length;
      const content = line.slice(leading.length, contentEnd);
      const normalizedContent = content.replace(/[ \t]+/gu, " ");
      const markdownHardBreak = trailing.length >= 2 ? "  " : "";
      return `${leading}${normalizedContent}${markdownHardBreak}`;
    })
    .join("\n");
}

const nativeDirectoryPathGetter = Object.getOwnPropertyDescriptor(Dir.prototype, "path")?.get;

function claimNativeDirectory(directory) {
  if (utilTypes.isProxy(directory) || Object.getPrototypeOf(directory) !== Dir.prototype) {
    throw instructionError("An opened instruction-scan directory is not an owned native directory handle.");
  }
  return directory;
}

function bindNativeDirectory(directory) {
  if (
    typeof nativeDirectoryPathGetter !== "function" ||
    Object.hasOwn(directory, "path") ||
    Object.hasOwn(directory, "readSync") ||
    Object.hasOwn(directory, "closeSync")
  ) {
    throw instructionError("An opened instruction-scan directory overrides native directory methods.");
  }
  let path;
  try {
    path = nativeDirectoryPathGetter.call(directory);
  } catch {
    throw instructionError("An opened instruction-scan directory could not expose its owned native path.");
  }
  if (typeof path !== "string") {
    throw instructionError("An opened instruction-scan directory could not expose its owned native path.");
  }
  return Object.freeze({ directory, path });
}

function readNativeDirectory(directory) {
  return Dir.prototype.readSync.call(directory);
}

function closeNativeDirectory(directory) {
  return Dir.prototype.closeSync.call(directory);
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

function activePolicyStructureDigest(body) {
  const structure = body.replace(
    /<!-- OW-RULE:(I\d{2}) -->\n([\s\S]*?)(?=\n<!-- OW-RULE:|\n## |\n<!-- OW-INSTRUCTIONS:EOF|$)/gu,
    (_block, rule) => `<!-- OW-RULE:${rule} -->\n<canonical-active-rule>`
  );
  return createHash("sha256").update(structure, "utf8").digest("hex");
}

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
  if (activePolicyStructureDigest(body) !== CANONICAL_ACTIVE_POLICY_STRUCTURE_DIGESTS[manifestEntry.path]) {
    throw instructionError(`${manifestEntry.path} changed its independently sealed canonical active-policy structure.`);
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
      if (discovered[0] !== "AGENTS.md") {
        throw instructionError("The canonical root AGENTS.md policy is mandatory and must load first.");
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
  const directoryPrefixes = new Set();
  let prefixBytes = 0;
  const retainDirectoryPrefix = (prefix, depth) => {
    if (directoryPrefixes.has(prefix)) return;
    if (depth > MAX_ANCESTOR_DEPTH) {
      throw instructionError("The tracked instruction ancestor depth exceeded its bound before retention.");
    }
    if (directoryPrefixes.size >= maxDirectories) {
      throw instructionError("The tracked instruction directory count exceeded its bound before retention.");
    }
    const bytes = Buffer.byteLength(prefix, "utf8");
    if (bytes > MAX_TRACKED_PATH_BYTES || prefixBytes + bytes > MAX_TRACKED_PREFIX_BYTES) {
      throw instructionError("The tracked instruction prefix byte bound was exceeded before retention.");
    }
    prefixBytes += bytes;
    directoryPrefixes.add(prefix);
  };
  retainDirectoryPrefix("", 0);
  for (const rawPath of trackedPaths) {
    const path = normalizedRepositoryPath(rawPath, "Tracked AGENTS.md path");
    if (posix.basename(path) !== "AGENTS.md" || tracked.has(path)) {
      throw instructionError("The tracked instruction inventory contains an invalid or duplicate path.");
    }
    if (tracked.size >= MAX_INSTRUCTION_FILES)
      throw instructionError("Too many tracked AGENTS.md files were discovered.");
    tracked.add(path);
    const directory = posix.dirname(path);
    const depth = directory === "." ? 0 : 1 + [...directory].filter((character) => character === "/").length;
    if (depth > MAX_ANCESTOR_DEPTH) {
      throw instructionError("The tracked instruction ancestor depth exceeded its bound before retention.");
    }
    if (directory !== ".") {
      let prefix = "";
      let prefixDepth = 0;
      for (const part of directory.split("/")) {
        prefixDepth += 1;
        prefix = prefix === "" ? part : `${prefix}/${part}`;
        retainDirectoryPrefix(prefix, prefixDepth);
      }
    }
  }
  const rootSnapshot = lstatSync(root, { bigint: true });
  if (!rootSnapshot.isDirectory() || rootSnapshot.isSymbolicLink()) {
    throw instructionError("The instruction scope root is not one real directory.");
  }
  const pending = [{ path: root, relativePath: "", depth: 0, snapshot: rootSnapshot }];
  const found = [];
  let directoryCount = 1;
  let entryCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    let beforeOpen;
    try {
      beforeOpen = lstatSync(current.path, { bigint: true });
    } catch {
      throw instructionError("A queued tracked-scope directory disappeared before pathname reopen.");
    }
    if (!beforeOpen.isDirectory() || beforeOpen.isSymbolicLink() || !exactStatIdentity(current.snapshot, beforeOpen)) {
      throw instructionError("A queued tracked-scope directory changed identity before pathname reopen.");
    }
    const openedDirectory = openDirectory(current.path);
    let ownedDirectory;
    let nativeDirectory;
    let failure;
    try {
      ownedDirectory = claimNativeDirectory(openedDirectory);
      nativeDirectory = bindNativeDirectory(ownedDirectory);
      let handleSnapshot;
      try {
        const handlePath = realpathSync(nativeDirectory.path);
        handleSnapshot = lstatSync(handlePath, { bigint: true });
      } catch {
        throw instructionError("An opened instruction-scan directory handle could not be identity-bound.");
      }
      if (
        !handleSnapshot.isDirectory() ||
        handleSnapshot.isSymbolicLink() ||
        !exactStatIdentity(current.snapshot, handleSnapshot)
      ) {
        throw instructionError("An opened instruction-scan directory handle belongs to another directory identity.");
      }
      const afterOpen = lstatSync(current.path, { bigint: true });
      if (!afterOpen.isDirectory() || afterOpen.isSymbolicLink() || !exactStatIdentity(current.snapshot, afterOpen)) {
        throw instructionError("A queued tracked-scope directory changed identity before pathname reopen.");
      }
      for (
        let entry = readNativeDirectory(nativeDirectory.directory);
        entry !== null;
        entry = readNativeDirectory(nativeDirectory.directory)
      ) {
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
          pending.push({ path: absolutePath, relativePath, depth: nextDepth, snapshot });
        }
      }
      const afterScan = lstatSync(current.path, { bigint: true });
      let handleAfterScan;
      try {
        handleAfterScan = lstatSync(realpathSync(nativeDirectory.path), { bigint: true });
      } catch {
        throw instructionError("An opened instruction-scan directory handle lost its bound identity during scanning.");
      }
      if (
        !afterScan.isDirectory() ||
        afterScan.isSymbolicLink() ||
        !exactStatIdentity(current.snapshot, afterScan) ||
        !exactStatIdentity(current.snapshot, handleAfterScan)
      ) {
        throw instructionError("A queued tracked-scope directory changed during its bounded scan.");
      }
    } catch (error) {
      failure = error;
    }
    let closeFailure;
    if (ownedDirectory) {
      try {
        closeNativeDirectory(ownedDirectory);
      } catch (error) {
        closeFailure = instructionError("An instruction-scan directory descriptor did not close.", { cause: error });
      }
    }
    if (failure && closeFailure) {
      throw instructionAggregateError(
        "An instruction-scan directory failed and its owned descriptor also did not close.",
        [failure, closeFailure]
      );
    }
    if (failure) throw failure;
    if (closeFailure) throw closeFailure;
  }
  found.sort();
  const expected = [...tracked].sort();
  if (found.length !== expected.length || found.some((path, index) => path !== expected[index])) {
    throw instructionError("A tracked AGENTS.md path was missing or replaced during the streamed scan.");
  }
  return Object.freeze(found);
}

export function validateConstructedInstructionContext(contextText, documents, maxBytes = CONTEXT_LIMIT_BYTES) {
  if (Buffer.byteLength(contextText, "utf8") > maxBytes) {
    throw instructionError("The locally constructed instruction context exceeds its aggregate byte bound.");
  }
  const expected = documents.map((document) => document.text).join("\n");
  if (contextText !== expected)
    throw instructionError("The locally constructed instruction context changed content or order.");
  let previousMarker = -1;
  for (const document of documents) {
    const index = contextText.indexOf(document.marker);
    if (index <= previousMarker || contextText.indexOf(document.marker, index + 1) !== -1) {
      throw instructionError(
        "The locally constructed instruction context has a missing, duplicate, or reordered completion marker."
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
  const contextText = documents.map((document) => document.text).join("\n");
  validateConstructedInstructionContext(contextText, documents);
  return Object.freeze({
    target: targetPath,
    paths,
    documents: Object.freeze(documents),
    contextText,
    bytes: Buffer.byteLength(contextText, "utf8")
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
    contexts: Object.freeze(contexts),
    applicationDeliveryEvidence: APPLICATION_DELIVERY_EVIDENCE
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
