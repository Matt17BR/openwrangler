import { inspectVsixArchive, packagedOpenWranglerIdentity, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";

export async function readPackagedEditorIdentity(
  vsixPath,
  { readSnapshot = readBoundedVsixFileSnapshot, inspectArchive = inspectVsixArchive } = {}
) {
  const snapshot = readSnapshot(vsixPath, { requireOwner: true });
  const archive = await inspectArchive(snapshot.bytes);
  return packagedOpenWranglerIdentity(archive.packagedPackageJson);
}
