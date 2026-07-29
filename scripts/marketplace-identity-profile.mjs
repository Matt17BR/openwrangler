import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictJson } from "./strict-json.mjs";

export const AZURE_DEVOPS_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";
export const AZURE_DEVOPS_PROFILE_URL = "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1";

const ACCESS_TOKEN_MAX_BYTES = 32 * 1024;
const PROFILE_RESPONSE_MAX_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const AZURE_CLI_TOKEN_ARGUMENTS = Object.freeze([
  "account",
  "get-access-token",
  "--resource",
  AZURE_DEVOPS_RESOURCE_ID,
  "--query",
  "accessToken",
  "--output",
  "tsv",
  "--only-show-errors"
]);

function defaultRunAzureCli(command, arguments_, options) {
  try {
    return execFileSync(command, arguments_, options);
  } catch {
    throw new Error("Azure CLI could not acquire the Azure DevOps resource token.");
  }
}

function validateAccessToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  let containsControlOrSpace = false;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      containsControlOrSpace = true;
      break;
    }
  }
  if (token.length === 0 || Buffer.byteLength(token, "utf8") > ACCESS_TOKEN_MAX_BYTES || containsControlOrSpace) {
    throw new Error("Azure CLI returned an invalid Azure DevOps resource token.");
  }
  return token;
}

async function readBoundedResponse(response) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9]\d*)$/u.test(declaredLength) || BigInt(declaredLength) > BigInt(PROFILE_RESPONSE_MAX_BYTES))
  ) {
    throw new Error("Azure DevOps Profile API response exceeds its declared byte limit.");
  }
  if (response.body === null) {
    throw new Error("Azure DevOps Profile API returned no response body.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > PROFILE_RESPONSE_MAX_BYTES) {
        throw new Error("Azure DevOps Profile API response exceeds its byte limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export async function resolveMarketplaceIdentityProfile({
  fetchImpl = globalThis.fetch,
  runAzureCli = defaultRunAzureCli
} = {}) {
  if (typeof fetchImpl !== "function" || typeof runAzureCli !== "function") {
    throw new TypeError("Marketplace identity lookup requires Azure CLI and fetch implementations.");
  }
  const token = validateAccessToken(
    runAzureCli("az", AZURE_CLI_TOKEN_ARGUMENTS, {
      encoding: "utf8",
      maxBuffer: ACCESS_TOKEN_MAX_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REQUEST_TIMEOUT_MS,
      windowsHide: true
    })
  );
  let response;
  try {
    response = await fetchImpl(AZURE_DEVOPS_PROFILE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new Error("Azure DevOps Profile API request failed.");
  }
  if (response.status !== 200) {
    throw new Error("Azure DevOps Profile API did not accept the federated identity.");
  }
  let profile;
  try {
    const bytes = await readBoundedResponse(response);
    profile = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
      maxBytes: PROFILE_RESPONSE_MAX_BYTES
    });
  } catch {
    throw new Error("Azure DevOps Profile API returned an invalid bounded profile.");
  }
  if (
    typeof profile !== "object" ||
    profile === null ||
    Array.isArray(profile) ||
    typeof profile.id !== "string" ||
    !UUID.test(profile.id)
  ) {
    throw new Error("Azure DevOps Profile API did not return one UUID profile ID.");
  }
  return profile.id.toLowerCase();
}

export async function marketplaceIdentityProfileMain({
  fetchImpl = globalThis.fetch,
  runAzureCli = defaultRunAzureCli,
  stderr = process.stderr,
  stdout = process.stdout
} = {}) {
  try {
    const profileId = await resolveMarketplaceIdentityProfile({ fetchImpl, runAzureCli });
    stdout.write(`Marketplace identity profile ID: ${profileId}\n`);
    return 0;
  } catch {
    stderr.write("Marketplace identity profile lookup failed.\n");
    return 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await marketplaceIdentityProfileMain();
}
