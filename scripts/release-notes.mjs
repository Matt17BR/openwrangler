import { execFileSync } from "node:child_process";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RELEASE_NOTES_MAX_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function validateReleaseNotes(releaseNotes) {
  if (
    typeof releaseNotes !== "string" ||
    releaseNotes.length === 0 ||
    releaseNotes.trim().length === 0 ||
    !releaseNotes.endsWith("\n") ||
    /[\0\r\ufeff]/u.test(releaseNotes) ||
    Buffer.byteLength(releaseNotes, "utf8") > RELEASE_NOTES_MAX_BYTES
  ) {
    throw new Error("Release notes must be non-empty UTF-8 Markdown with LF line endings and a final newline.");
  }
  return releaseNotes;
}

export function readReleaseNotesFromCommit({ commit, root, version }) {
  if (!FULL_COMMIT.test(commit) || !NUMERIC_VERSION.test(version)) {
    throw new Error("Release notes require one exact commit and numeric version.");
  }
  let bytes;
  try {
    bytes = execFileSync("git", ["show", `${commit}:docs/release-notes/${version}.md`], {
      cwd: root,
      maxBuffer: RELEASE_NOTES_MAX_BYTES + 1,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true
    });
  } catch (error) {
    throw new Error(`Commit ${commit} must contain release notes at docs/release-notes/${version}.md.`, {
      cause: error
    });
  }
  let releaseNotes;
  try {
    releaseNotes = utf8Decoder.decode(bytes);
  } catch (error) {
    throw new Error(`Release notes at docs/release-notes/${version}.md must be valid UTF-8.`, { cause: error });
  }
  if (!Buffer.from(releaseNotes, "utf8").equals(bytes)) {
    throw new Error(
      `Release notes at docs/release-notes/${version}.md must use canonical UTF-8 without a byte-order mark.`
    );
  }
  return validateReleaseNotes(releaseNotes);
}
