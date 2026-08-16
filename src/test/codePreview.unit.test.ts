import { describe, expect, it, vi } from "vitest";
import { releaseExactCodePreviewHandlesAfterFailure } from "./extensionHost/codePreview";

describe("exact Code Preview handle cleanup", () => {
  it("settles every owned handle and ignores absent optional handles", async () => {
    const first = { dispose: vi.fn(async () => undefined) };
    const second = { dispose: vi.fn(async () => undefined) };

    await expect(
      releaseExactCodePreviewHandlesAfterFailure([first, undefined, second], undefined, "cleanup failed")
    ).resolves.toBeUndefined();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("reports every cleanup failure after all handles settle", async () => {
    const firstFailure = new Error("preview cleanup failed");
    const secondFailure = new Error("scroller cleanup failed");
    const first = { dispose: vi.fn(async () => Promise.reject(firstFailure)) };
    const second = { dispose: vi.fn(async () => Promise.reject(secondFailure)) };

    const rejected = releaseExactCodePreviewHandlesAfterFailure([first, second], undefined, "cleanup failed");
    await expect(rejected).rejects.toMatchObject({
      name: "AggregateError",
      errors: [firstFailure, secondFailure]
    });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("retains both the operation and cleanup failures", async () => {
    const operationFailure = new Error("reveal failed");
    const cleanupFailure = new Error("line cleanup failed");

    await expect(
      releaseExactCodePreviewHandlesAfterFailure(
        [{ dispose: vi.fn(async () => Promise.reject(cleanupFailure)) }],
        { error: operationFailure },
        "reveal and cleanup failed"
      )
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: "reveal and cleanup failed",
      errors: [operationFailure, expect.objectContaining({ errors: [cleanupFailure] })]
    });
  });
});
