import {
  assertRemoteWorkspaceResultLease,
  closeRemoteWorkspaceResultLease,
  openRemoteWorkspaceResultLeaseIfPresent,
  validateRemoteWorkspaceNamespaceAttestation
} from "./remote-workspace-contract.mjs";

export async function validateRemoteWorkspaceTerminal({ stdout, stderr, resultPath, expected, revalidate }) {
  if (typeof stderr !== "string" || stderr.length !== 0) {
    throw new Error("The Remote SSH terminal phase emitted an unexpected diagnostic stream.");
  }
  if (typeof revalidate !== "function") {
    throw new Error("The Remote SSH terminal revalidation boundary is malformed.");
  }
  const attestation = validateRemoteWorkspaceNamespaceAttestation(stdout, expected);
  const lease = openRemoteWorkspaceResultLeaseIfPresent(resultPath, { runId: expected?.runId });
  if (!lease) throw new Error("The Remote SSH terminal result disappeared before host validation.");

  let validationError;
  try {
    if (
      lease.outcome !== attestation.outcome ||
      lease.bytes !== attestation.resultBytes ||
      lease.sha256 !== attestation.resultSha256
    ) {
      throw new Error("The Remote SSH terminal attestation did not match its first-observed result.");
    }
    await revalidate();
    assertRemoteWorkspaceResultLease(lease);
  } catch (error) {
    validationError = error;
  }

  let closeError;
  try {
    closeRemoteWorkspaceResultLease(lease);
  } catch (error) {
    closeError = error;
  }
  if (validationError && closeError) {
    throw new AggregateError(
      [validationError, closeError],
      "The Remote SSH terminal boundary failed validation and result close."
    );
  }
  if (validationError) throw validationError;
  if (closeError) throw closeError;
  return Object.freeze({ attestation, result: lease.result });
}
