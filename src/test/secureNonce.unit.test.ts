import { describe, expect, it, vi } from "vitest";
import { createSecureNonce } from "../extension/secureNonce";

describe("createSecureNonce", () => {
  it("encodes exactly 128 injected entropy bits as lowercase hexadecimal", () => {
    const entropySource = vi.fn(() => Buffer.from(Array.from({ length: 16 }, (_, index) => index)));

    expect(createSecureNonce(entropySource)).toBe("000102030405060708090a0b0c0d0e0f");
    expect(entropySource).toHaveBeenCalledOnce();
    expect(entropySource).toHaveBeenCalledWith(16);
  });

  it("uses the production entropy source to create unique 128-bit nonces", () => {
    const nonces = Array.from({ length: 256 }, () => createSecureNonce());

    expect(nonces.every((nonce) => /^[0-9a-f]{32}$/u.test(nonce))).toBe(true);
    expect(new Set(nonces)).toHaveLength(nonces.length);
  });

  it("rejects injected entropy that is not exactly 128 bits", () => {
    expect(() => createSecureNonce(() => Buffer.alloc(15))).toThrow(
      "Secure nonce entropy source must return exactly 16 bytes."
    );
    expect(() => createSecureNonce(() => Buffer.alloc(17))).toThrow(
      "Secure nonce entropy source must return exactly 16 bytes."
    );
    expect(() => createSecureNonce((() => new Uint8Array(16)) as unknown as (size: number) => Buffer)).toThrow(
      "Secure nonce entropy source must return exactly 16 bytes."
    );
  });
});
