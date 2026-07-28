import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyOpenVsxReleaseOnce, waitForOpenVsxRelease } from "./verify-open-vsx-release.mjs";
import { verifyRegistryReleaseArtifactFromCheckout } from "./verify-registry-release-artifact.mjs";

async function runCli() {
  if (process.argv.length !== 4 || (process.argv[3] !== "--preflight" && process.argv[3] !== "--verify")) {
    throw new Error("Pass one downloaded release directory and either --preflight or --verify.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const prerelease =
    process.env.RELEASE_PRERELEASE === "true" ? true : process.env.RELEASE_PRERELEASE === "false" ? false : undefined;
  const receipt = await verifyRegistryReleaseArtifactFromCheckout({
    automationCommit: process.env.AUTOMATION_SHA,
    directory: process.argv[2],
    expectedCommit: process.env.EXPECTED_SHA,
    prerelease,
    releaseTag: process.env.RELEASE_TAG,
    root
  });
  const options = {
    candidateBytes: readFileSync(receipt.candidatePath),
    candidateSha256: receipt.candidateSha256,
    channel: receipt.prerelease ? "preview" : "stable",
    version: receipt.version
  };
  const channel = receipt.prerelease ? "preview" : "stable";
  if (process.argv[3] === "--preflight") {
    const result = await verifyOpenVsxReleaseOnce(options);
    if (result.status === "transient") {
      throw new Error("Open VSX preflight could not distinguish an absent release from a registry outage.");
    }
    console.log(
      result.status === "exact"
        ? `Open VSX already serves the exact ${channel} ${receipt.extensionId} ${receipt.version} VSIX.`
        : `Open VSX ${receipt.extensionId} ${receipt.version} is available for ${channel} publication.`
    );
    return;
  }
  const result = await waitForOpenVsxRelease(options);
  console.log(
    `Open VSX serves the exact ${channel} ${receipt.extensionId} ${result.version} VSIX from ${result.publishedBy}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
