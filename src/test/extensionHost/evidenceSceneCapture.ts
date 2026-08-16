import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT, PACKAGED_PRODUCT_VIEWPORT } from "./screenshotEvidence";

export async function captureWorkbenchScreenshot(
  page: Page,
  destination: string,
  maximumHeight?: number
): Promise<void> {
  if (
    maximumHeight !== undefined &&
    (!Number.isSafeInteger(maximumHeight) || maximumHeight < 1 || maximumHeight > PACKAGED_PRODUCT_VIEWPORT.height)
  ) {
    throw new TypeError("A workbench screenshot maximum height must be one bounded positive integer.");
  }
  await page.bringToFront();
  const expectedPixelRatio = publicMediaPixelRatio();
  const viewport = await page.evaluate(() => {
    const pageWindow = globalThis as unknown as {
      innerWidth: number;
      innerHeight: number;
      devicePixelRatio: number;
    };
    return {
      width: pageWindow.innerWidth,
      height: pageWindow.innerHeight,
      scale: Math.max(1, pageWindow.devicePixelRatio)
    };
  });
  const workbenchOffsets: number[] = [];
  for (const selector of [".monaco-workbench", ".part.sidebar", ".part.editor", ".part.activitybar"]) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    const bounds = await locator.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (bounds && bounds.y > 0) workbenchOffsets.push(bounds.y);
  }
  const titleBarHeight = Math.ceil(Math.min(...workbenchOffsets, Number.POSITIVE_INFINITY));
  const logicalCaptureY =
    Number.isFinite(titleBarHeight) && titleBarHeight > 0 && titleBarHeight < viewport.height ? titleBarHeight : 0;
  const logicalCaptureWidth = viewport.width;
  const logicalCaptureHeight = Math.min(viewport.height - logicalCaptureY, maximumHeight ?? Number.POSITIVE_INFINITY);
  const requiresClip = logicalCaptureY > 0 || logicalCaptureHeight < viewport.height;
  const clip = requiresClip
    ? {
        x: 0,
        y: logicalCaptureY,
        width: logicalCaptureWidth,
        height: logicalCaptureHeight
      }
    : undefined;
  try {
    await capturePublicEditorPixels(page, destination, expectedPixelRatio, clip);
  } catch (error) {
    await page.bringToFront();
    await page.waitForTimeout(500);
    try {
      await capturePublicEditorPixels(page, destination, expectedPixelRatio, clip);
    } catch {
      throw error;
    }
  }
  assertCapturedPngDimensions(
    destination,
    logicalCaptureWidth * expectedPixelRatio,
    logicalCaptureHeight * expectedPixelRatio,
    "Public workbench media must retain twice its logical capture width.",
    "Public workbench media must retain twice its logical capture height."
  );
}

export async function captureNotebookWorkbenchScreenshot(
  page: Page,
  destination: string,
  expectedViewport: Readonly<{ width: number; height: number }> = PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT
): Promise<void> {
  await page.bringToFront();
  const expectedPixelRatio = publicMediaPixelRatio();
  const viewport = await page.evaluate(() => {
    const pageWindow = globalThis as unknown as {
      innerHeight: number;
      innerWidth: number;
      devicePixelRatio: number;
    };
    return {
      width: pageWindow.innerWidth,
      height: pageWindow.innerHeight,
      scale: Math.max(1, pageWindow.devicePixelRatio)
    };
  });
  assert.deepEqual(
    { width: viewport.width, height: viewport.height },
    expectedViewport,
    expectedViewport === PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT
      ? "A notebook workbench media scene requires the standard 1440 by 900 editor viewport."
      : "An aligned notebook workbench media scene requires its exact measured editor viewport."
  );
  assert.equal(viewport.scale >= 1, true, "The notebook workbench must expose one valid initial device-pixel ratio.");
  await capturePublicEditorPixels(page, destination, expectedPixelRatio);
  assertCapturedPngDimensions(
    destination,
    expectedViewport.width * expectedPixelRatio,
    expectedViewport.height * expectedPixelRatio,
    "A notebook workbench media scene must retain twice its logical editor width.",
    "A notebook workbench media scene must retain twice its logical editor height."
  );
}

export function publicMediaPixelRatio(): number {
  const raw = process.env.OPEN_WRANGLER_PUBLIC_MEDIA_PIXEL_RATIO;
  if (raw !== "2") {
    throw new Error("Public media capture requires the shared 2× device-pixel ratio.");
  }
  return 2;
}

async function capturePublicEditorPixels(
  page: Page,
  destination: string,
  expectedPixelRatio: number,
  clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
): Promise<void> {
  const viewport = await page.evaluate(() => {
    const pageWindow = globalThis as unknown as {
      devicePixelRatio: number;
      innerHeight: number;
      innerWidth: number;
    };
    return {
      width: pageWindow.innerWidth,
      height: pageWindow.innerHeight,
      scale: pageWindow.devicePixelRatio
    };
  });
  const session = await page.context().newCDPSession(page);
  let metricsOverridden = false;
  let renderedPixelRatio = expectedPixelRatio;
  try {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      deviceScaleFactor: expectedPixelRatio,
      mobile: false
    });
    metricsOverridden = true;
    renderedPixelRatio = await page.evaluate(
      () => (globalThis as unknown as { readonly devicePixelRatio: number }).devicePixelRatio
    );
    assert.ok(
      renderedPixelRatio >= expectedPixelRatio,
      "Public editor media must render at no less than the runner-owned device-pixel ratio."
    );
    await page.evaluate(async () => {
      const pageGlobal = globalThis as unknown as {
        readonly document: { readonly fonts: { readonly ready: Promise<unknown> } };
        requestAnimationFrame(callback: () => void): number;
      };
      await pageGlobal.document.fonts.ready;
      await new Promise<void>((resolveFrame) => {
        pageGlobal.requestAnimationFrame(() => pageGlobal.requestAnimationFrame(() => resolveFrame()));
      });
    });
    const result = (await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: clip?.x ?? 0,
        y: clip?.y ?? 0,
        width: clip?.width ?? viewport.width,
        height: clip?.height ?? viewport.height,
        scale: 1
      }
    })) as { data: string };
    writeFileSync(destination, Buffer.from(result.data, "base64"));
  } finally {
    try {
      if (metricsOverridden) {
        const applicationZoomFactor = renderedPixelRatio / expectedPixelRatio;
        const restoreDeviceScaleFactor = viewport.scale / applicationZoomFactor;
        const restoreMetricsWidth = Math.ceil(viewport.width * applicationZoomFactor);
        const restoreMetricsHeight = Math.ceil(viewport.height * applicationZoomFactor);
        assert.ok(
          Number.isFinite(restoreDeviceScaleFactor) && restoreDeviceScaleFactor > 0,
          "Public media capture must derive one valid prior device scale."
        );
        await session.send("Emulation.setDeviceMetricsOverride", {
          width: restoreMetricsWidth,
          height: restoreMetricsHeight,
          screenWidth: restoreMetricsWidth,
          screenHeight: restoreMetricsHeight,
          deviceScaleFactor: restoreDeviceScaleFactor,
          mobile: false
        });
        const restoredViewport = await page.evaluate(() => {
          const pageWindow = globalThis as unknown as {
            devicePixelRatio: number;
            innerHeight: number;
            innerWidth: number;
          };
          return {
            width: pageWindow.innerWidth,
            height: pageWindow.innerHeight,
            scale: pageWindow.devicePixelRatio
          };
        });
        assert.deepEqual(
          { width: restoredViewport.width, height: restoredViewport.height },
          { width: viewport.width, height: viewport.height },
          "Public media capture must restore the exact logical editor viewport."
        );
        assert.ok(
          Math.abs(restoredViewport.scale - viewport.scale) < 0.01,
          "Public media capture must restore the editor's prior device-pixel ratio."
        );
      }
    } finally {
      await session.detach().catch(() => {});
    }
  }
}

function assertCapturedPngDimensions(
  destination: string,
  expectedWidth: number,
  expectedHeight: number,
  widthMessage: string,
  heightMessage: string
): void {
  const image = readFileSync(destination);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.readUInt32BE(16), expectedWidth, widthMessage);
  assert.equal(image.readUInt32BE(20), expectedHeight, heightMessage);
}
