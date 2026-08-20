import { randomBytes } from "node:crypto";

const SECURE_NONCE_BYTES = 16;
const SECURE_NONCE_PATTERN = /^[0-9a-f]{32}$/;

export type SecureNonceEntropySource = (size: number) => Buffer;

export function createSecureNonce(entropySource: SecureNonceEntropySource = randomBytes): string {
  if (typeof entropySource !== "function") {
    throw new TypeError("Secure nonce entropy source must be a function.");
  }

  const entropy = entropySource(SECURE_NONCE_BYTES);
  if (!Buffer.isBuffer(entropy) || entropy.byteLength !== SECURE_NONCE_BYTES) {
    throw new TypeError(`Secure nonce entropy source must return exactly ${SECURE_NONCE_BYTES} bytes.`);
  }

  const nonce = entropy.toString("hex");
  if (!SECURE_NONCE_PATTERN.test(nonce)) {
    throw new Error("Secure nonce encoding must be 32 lowercase hexadecimal characters.");
  }
  return nonce;
}
