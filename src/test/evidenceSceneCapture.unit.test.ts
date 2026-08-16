import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureNotebookWorkbenchScreenshot,
  captureWorkbenchScreenshot,
  publicMediaPixelRatio
} from "./extensionHost/evidenceSceneCapture";

interface CdpCall {
  readonly method: string;
  readonly parameters: Record<string, unknown> | undefined;
}

interface FakePageReceipt {
  readonly page: Page;
  readonly bringToFrontCalls: number[];
  readonly waits: number[];
  readonly sessions: Array<{ readonly calls: CdpCall[]; detached: boolean }>;
}

const previousPixelRatio = process.env.OPEN_WRANGLER_PUBLIC_MEDIA_PIXEL_RATIO;

beforeEach(() => {
  process.env.OPEN_WRANGLER_PUBLIC_MEDIA_PIXEL_RATIO = "2";
});

afterEach(() => {
  if (previousPixelRatio === undefined) delete process.env.OPEN_WRANGLER_PUBLIC_MEDIA_PIXEL_RATIO;
  else process.env.OPEN_WRANGLER_PUBLIC_MEDIA_PIXEL_RATIO = previousPixelRatio;
});

describe("packaged evidence scene capture", () => {
  it("captures title-bar-free workbench pixels and restores the original metrics", async () => {
    await withDestination(async (destination) => {
      const viewport = { width: 1_440, height: 900, scale: 1.5 };
      const fake = fakePage({
        evaluations: [viewport, viewport, 2, undefined, viewport],
        titleBarHeight: 35
      });

      await captureWorkbenchScreenshot(fake.page, destination, 865);

      expect(readPngSize(destination)).toEqual({ width: 2_880, height: 1_730 });
      expect(fake.bringToFrontCalls).toHaveLength(1);
      expect(fake.sessions).toHaveLength(1);
      expect(fake.sessions[0]?.detached).toBe(true);
      expect(fake.sessions[0]?.calls).toEqual([
        {
          method: "Emulation.setDeviceMetricsOverride",
          parameters: {
            width: 1_440,
            height: 900,
            screenWidth: 1_440,
            screenHeight: 900,
            deviceScaleFactor: 2,
            mobile: false
          }
        },
        {
          method: "Page.captureScreenshot",
          parameters: {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
            clip: { x: 0, y: 35, width: 1_440, height: 865, scale: 1 }
          }
        },
        {
          method: "Emulation.setDeviceMetricsOverride",
          parameters: {
            width: 1_440,
            height: 900,
            screenWidth: 1_440,
            screenHeight: 900,
            deviceScaleFactor: 1.5,
            mobile: false
          }
        }
      ]);
    });
  });

  it("owns the exact notebook viewport and physical output contract", async () => {
    await withDestination(async (destination) => {
      const viewport = { width: 1_440, height: 900, scale: 1 };
      const fake = fakePage({ evaluations: [viewport, viewport, 2, undefined, viewport] });

      await captureNotebookWorkbenchScreenshot(fake.page, destination);

      expect(readPngSize(destination)).toEqual({ width: 2_880, height: 1_800 });
      expect(fake.sessions[0]?.calls[1]).toEqual({
        method: "Page.captureScreenshot",
        parameters: {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: 1_440, height: 900, scale: 1 }
        }
      });
    });

    await expect(
      withDestination((destination) =>
        captureNotebookWorkbenchScreenshot(
          fakePage({ evaluations: [{ width: 1_280, height: 700, scale: 1 }] }).page,
          destination
        )
      )
    ).rejects.toThrow(/standard 1440 by 900/u);
  });

  it("detaches a failed capture before one bounded foreground retry", async () => {
    await withDestination(async (destination) => {
      const viewport = { width: 1_440, height: 900, scale: 1 };
      const fake = fakePage({
        evaluations: [viewport, viewport, 2, undefined, viewport, viewport, 2, undefined, viewport],
        failedCaptures: 1
      });

      await captureWorkbenchScreenshot(fake.page, destination);

      expect(fake.bringToFrontCalls).toHaveLength(2);
      expect(fake.waits).toEqual([500]);
      expect(fake.sessions).toHaveLength(2);
      expect(fake.sessions.every(({ detached }) => detached)).toBe(true);
      expect(readPngSize(destination)).toEqual({ width: 2_880, height: 1_800 });
    });
  });

  it("rejects unowned pixel ratios and unbounded crop heights before capture", async () => {
    process.env.OPEN_WRANGLER_PUBLIC_MEDIA_PIXEL_RATIO = "1";
    expect(() => publicMediaPixelRatio()).toThrow(/shared 2×/u);
    const fake = fakePage({ evaluations: [] });
    await expect(captureWorkbenchScreenshot(fake.page, "/unused.png", 0)).rejects.toThrow(/bounded positive integer/u);
    expect(fake.sessions).toHaveLength(0);
  });
});

function fakePage(options: {
  readonly evaluations: readonly unknown[];
  readonly titleBarHeight?: number;
  readonly failedCaptures?: number;
}): FakePageReceipt {
  const evaluations = [...options.evaluations];
  const bringToFrontCalls: number[] = [];
  const waits: number[] = [];
  const sessions: Array<{ calls: CdpCall[]; detached: boolean }> = [];
  let remainingFailedCaptures = options.failedCaptures ?? 0;
  const page = {
    async bringToFront() {
      bringToFrontCalls.push(bringToFrontCalls.length + 1);
    },
    async waitForTimeout(milliseconds: number) {
      waits.push(milliseconds);
    },
    async evaluate() {
      if (evaluations.length === 0) throw new Error("Unexpected fake page evaluation.");
      return evaluations.shift();
    },
    locator() {
      return {
        first() {
          return {
            async count() {
              return options.titleBarHeight === undefined ? 0 : 1;
            },
            async boundingBox() {
              return options.titleBarHeight === undefined
                ? null
                : { x: 0, y: options.titleBarHeight, width: 100, height: 100 };
            }
          };
        }
      };
    },
    context() {
      return {
        async newCDPSession() {
          const receipt = { calls: [] as CdpCall[], detached: false };
          sessions.push(receipt);
          return {
            async send(method: string, parameters?: Record<string, unknown>) {
              receipt.calls.push({ method, parameters });
              if (method === "Page.captureScreenshot") {
                if (remainingFailedCaptures > 0) {
                  remainingFailedCaptures -= 1;
                  throw new Error("capture failed");
                }
                const clip = parameters?.clip as { width: number; height: number };
                return { data: png(clip.width * 2, clip.height * 2).toString("base64") };
              }
              return {};
            },
            async detach() {
              receipt.detached = true;
            }
          };
        }
      };
    }
  } as unknown as Page;
  return { page, bringToFrontCalls, waits, sessions };
}

async function withDestination(run: (destination: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "openwrangler-evidence-scene-"));
  try {
    await run(join(directory, "scene.png"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function png(width: number, height: number): Buffer {
  const result = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(result);
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  return result;
}

function readPngSize(path: string): { width: number; height: number } {
  const image = readFileSync(path);
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}
