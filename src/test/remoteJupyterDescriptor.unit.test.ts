import { describe, expect, it } from "vitest";
import { readReleasedRemoteJupyterDescriptorToken } from "./extensionHost/remoteJupyterDescriptor";

describe("released remote-Jupyter descriptor token", () => {
  it("accepts only the producer and redactor token contract", () => {
    const token = `owr_${"A".repeat(39)}`;

    expect(readReleasedRemoteJupyterDescriptorToken(token)).toBe(token);
    for (const malformed of [
      "A".repeat(43),
      `owr_${"A".repeat(38)}`,
      `owr_${"A".repeat(40)}`,
      `owr_${"A".repeat(38)}!`
    ]) {
      expect(() => readReleasedRemoteJupyterDescriptorToken(malformed)).toThrow(
        "The remote Jupyter descriptor token is malformed."
      );
    }
  });
});
