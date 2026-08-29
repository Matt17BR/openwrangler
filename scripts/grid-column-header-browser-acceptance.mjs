import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyGridColumnHeaderBrowserAcceptance(browser, harnessDirectory) {
  const states = [
    { harness: "grid-zoom-0-8.html", label: "80% zoom", width: 1280 },
    { harness: "grid-view.html", label: "100% zoom", width: 1280 },
    { harness: "grid-zoom-1-5.html", label: "150% zoom", width: 1280 },
    { harness: "grid-zoom-2.html", label: "200% zoom", width: 1280 },
    { harness: "wide-view.html", label: "435px narrow", width: 435 },
    { forcedColors: true, harness: "grid-view.html", label: "forced colors", width: 1280 }
  ];

  for (const { forcedColors = false, harness, label, width } of states) {
    const page = await browser.newPage();
    await page.setViewportSize({ width, height: 760 });
    if (forcedColors) await page.emulateMedia({ forcedColors: "active" });
    await page.goto(pathToFileURL(resolve(harnessDirectory, harness)).href, { waitUntil: "load" });
    await page.locator(".columnResizeHandle").first().waitFor();

    const layout = await page.locator("table").evaluate(async (table) => {
      const epsilon = 0.6;
      const scroller = table.closest('[data-testid="data-grid-scroller"]');
      const scrollerBounds = scroller?.getBoundingClientRect();
      const headers = [...table.querySelectorAll("th[data-grid-column]")];
      const failures = [];
      const controls = [];
      let checkedHeaderCount = 0;
      for (const header of headers) {
        const headerBounds = header.getBoundingClientRect();
        if (
          !scrollerBounds ||
          headerBounds.left < scrollerBounds.left - epsilon ||
          headerBounds.right > scrollerBounds.right + epsilon
        ) {
          continue;
        }
        checkedHeaderCount += 1;
        const columnHeader = header.querySelector(".columnHeader");
        const title = header.querySelector(".columnTitle");
        const type = header.querySelector(".columnType");
        if (!columnHeader || !title || !type) {
          failures.push({ header: header.getAttribute("data-column"), reason: "missing-header-structure" });
          continue;
        }
        const scale =
          columnHeader.offsetWidth > 0 ? columnHeader.getBoundingClientRect().width / columnHeader.offsetWidth : 0;
        const target = Number.parseFloat(
          getComputedStyle(columnHeader).getPropertyValue("--column-header-control-target")
        );
        const minimum = target * scale;
        const titleBounds = title.getBoundingClientRect();
        const typeBounds = type.getBoundingClientRect();
        if (
          !Number.isFinite(minimum) ||
          minimum <= 0 ||
          titleBounds.width <= 0 ||
          titleBounds.height <= 0 ||
          typeBounds.width <= 0 ||
          typeBounds.height <= 0
        ) {
          failures.push({
            header: header.getAttribute("data-column"),
            minimum,
            reason: "hidden-header-name-or-type",
            title: { height: titleBounds.height, width: titleBounds.width },
            type: { height: typeBounds.height, width: typeBounds.width }
          });
        }

        const headerControls = [
          ...header.querySelectorAll(
            ".columnHeaderActions > button, .columnHeaderActions > .columnMenu > summary, .columnResizeHandle"
          )
        ];
        if (headerControls.length < 2) {
          failures.push({
            count: headerControls.length,
            header: header.getAttribute("data-column"),
            reason: "missing-header-controls"
          });
        }
        const rectangles = [];
        for (const control of headerControls) {
          const bounds = control.getBoundingClientRect();
          const centerTarget = document.elementFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2
          );
          const receipt = {
            bottom: bounds.bottom,
            height: bounds.height,
            label: control.getAttribute("aria-label"),
            left: bounds.left,
            minimum,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width
          };
          controls.push(receipt);
          if (
            bounds.width + epsilon < minimum ||
            bounds.height + epsilon < minimum ||
            bounds.left < headerBounds.left - epsilon ||
            bounds.right > headerBounds.right + epsilon ||
            bounds.top < headerBounds.top - epsilon ||
            bounds.bottom > headerBounds.bottom + epsilon ||
            !(centerTarget === control || control.contains(centerTarget))
          ) {
            failures.push({ header: header.getAttribute("data-column"), reason: "invalid-control-target", ...receipt });
          }
          control.focus();
          if (document.activeElement !== control) {
            failures.push({ header: header.getAttribute("data-column"), label: receipt.label, reason: "unfocusable" });
          }
          if (control.matches(".columnMenu > summary")) {
            const focusStyle = getComputedStyle(control);
            if (
              !control.matches(":focus-visible") ||
              focusStyle.outlineStyle !== "solid" ||
              focusStyle.outlineColor === "transparent" ||
              Number.parseFloat(focusStyle.outlineWidth) <= 0 ||
              focusStyle.backgroundColor === "transparent" ||
              focusStyle.backgroundColor === "rgba(0, 0, 0, 0)"
            ) {
              failures.push({
                backgroundColor: focusStyle.backgroundColor,
                focusVisible: control.matches(":focus-visible"),
                header: header.getAttribute("data-column"),
                outlineColor: focusStyle.outlineColor,
                outlineStyle: focusStyle.outlineStyle,
                outlineWidth: focusStyle.outlineWidth,
                reason: "imperceptible-menu-focus"
              });
            }
          }
          if (control.classList.contains("columnResizeHandle")) {
            const failedState = (code) => ({
              animationStates: [],
              focused: false,
              opacity: "unavailable",
              stateError: { code, type: "resize-opacity-transition-state" }
            });
            const opacitySettlement = await new Promise((resolveTransition) => {
              const startedAt = performance.now();
              let done = false;
              let frame;
              let timer;
              const readState = () => {
                try {
                  const Transition = globalThis.CSSTransition;
                  if (
                    typeof control.getAnimations !== "function" ||
                    typeof Transition !== "function" ||
                    !("transitionProperty" in Transition.prototype)
                  ) {
                    return failedState("transition-observation-unavailable");
                  }
                  const opacityTransitions = control
                    .getAnimations()
                    .filter(
                      (animation) =>
                        animation instanceof Transition &&
                        animation.effect?.target === control &&
                        animation.transitionProperty === "opacity"
                    );
                  return {
                    animationStates: opacityTransitions.map((animation) => ({
                      pending: animation.pending,
                      playState: animation.playState
                    })),
                    focused: document.activeElement === control,
                    opacity: getComputedStyle(control).opacity,
                    stateError: undefined
                  };
                } catch {
                  return failedState("transition-state-read-failed");
                }
              };
              const settle = (settled, state) => {
                if (done) return;
                done = true;
                let cleanupFailed = false;
                try {
                  if (frame !== undefined) cancelAnimationFrame(frame);
                } catch {
                  cleanupFailed = true;
                }
                try {
                  if (timer !== undefined) clearTimeout(timer);
                } catch {
                  cleanupFailed = true;
                }
                const finalState = cleanupFailed ? failedState("transition-wait-cleanup-failed") : state;
                resolveTransition({
                  elapsedMilliseconds: performance.now() - startedAt,
                  settled: settled && finalState.stateError === undefined,
                  ...finalState
                });
              };
              const sample = () => {
                if (done) return;
                frame = undefined;
                const state = readState();
                if (state.stateError !== undefined) {
                  settle(false, state);
                  return;
                }
                if (
                  state.focused &&
                  state.opacity === "1" &&
                  state.animationStates.every(
                    ({ pending, playState }) => !pending && (playState === "finished" || playState === "idle")
                  )
                ) {
                  settle(true, state);
                  return;
                }
                try {
                  frame = requestAnimationFrame(sample);
                } catch {
                  settle(false, failedState("animation-frame-scheduling-failed"));
                }
              };
              try {
                timer = setTimeout(() => {
                  if (done) return;
                  settle(false, readState());
                }, 500);
                frame = requestAnimationFrame(sample);
              } catch {
                settle(false, failedState("transition-wait-scheduling-failed"));
              }
            });
            let finalState = opacitySettlement;
            let gripperWidth = Number.NaN;
            if (finalState.stateError === undefined) {
              try {
                gripperWidth = Number.parseFloat(getComputedStyle(control, "::before").width);
                finalState = {
                  ...finalState,
                  focused: document.activeElement === control,
                  opacity: getComputedStyle(control).opacity
                };
              } catch {
                finalState = {
                  ...failedState("final-resize-state-read-failed"),
                  elapsedMilliseconds: opacitySettlement.elapsedMilliseconds,
                  settled: false
                };
              }
            }
            if (
              !finalState.settled ||
              !Number.isFinite(gripperWidth) ||
              gripperWidth <= 0 ||
              gripperWidth >= target ||
              finalState.opacity !== "1" ||
              !finalState.focused
            ) {
              failures.push({
                animationStates: finalState.animationStates,
                elapsedMilliseconds: finalState.elapsedMilliseconds,
                focused: finalState.focused,
                gripperWidth,
                header: header.getAttribute("data-column"),
                opacity: finalState.opacity,
                reason:
                  finalState.stateError !== undefined
                    ? "resize-opacity-transition-state-error"
                    : finalState.settled
                      ? "invalid-resize-gripper"
                      : "resize-opacity-transition-timeout",
                stateError: finalState.stateError,
                target
              });
            }
          }
          rectangles.push({ bounds, label: receipt.label });
        }
        const resize = header.querySelector(".columnResizeHandle")?.getBoundingClientRect();
        if (resize) {
          for (const [label, bounds] of [
            ["column title", titleBounds],
            ["column type", typeBounds]
          ]) {
            const overlapWidth = Math.min(resize.right, bounds.right) - Math.max(resize.left, bounds.left);
            const overlapHeight = Math.min(resize.bottom, bounds.bottom) - Math.max(resize.top, bounds.top);
            if (overlapWidth > epsilon && overlapHeight > epsilon) {
              failures.push({
                header: header.getAttribute("data-column"),
                label,
                overlapHeight,
                overlapWidth,
                reason: "resize-overlaps-header-content"
              });
            }
          }
        }
        for (let first = 0; first < rectangles.length; first += 1) {
          for (let second = first + 1; second < rectangles.length; second += 1) {
            const a = rectangles[first];
            const b = rectangles[second];
            const overlapWidth = Math.min(a.bounds.right, b.bounds.right) - Math.max(a.bounds.left, b.bounds.left);
            const overlapHeight = Math.min(a.bounds.bottom, b.bounds.bottom) - Math.max(a.bounds.top, b.bounds.top);
            if (overlapWidth > epsilon && overlapHeight > epsilon) {
              failures.push({
                first: a.label,
                header: header.getAttribute("data-column"),
                overlapHeight,
                overlapWidth,
                reason: "overlapping-control-targets",
                second: b.label
              });
            }
          }
        }
      }
      return {
        checkedHeaderCount,
        controls,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        failures,
        forcedColors: matchMedia("(forced-colors: active)").matches
      };
    });
    if (
      layout.checkedHeaderCount === 0 ||
      layout.failures.length > 0 ||
      layout.documentOverflow > 1 ||
      layout.forcedColors !== forcedColors
    ) {
      throw new Error(`${harness} (${label}) failed computed header-control layout: ${JSON.stringify(layout)}.`);
    }

    await verifyColumnHeaderMenuLayout(page, page.locator("th[data-grid-column]").nth(1), `${harness} (${label})`);

    if (label === "100% zoom") {
      const resizeHeader = page.locator("th[data-grid-column]").first();
      const resize = resizeHeader.locator(".columnResizeHandle");
      const before = await resizeHeader.evaluate((header) => header.getBoundingClientRect().width);
      await resize.focus();
      await page.keyboard.press("ArrowRight");
      const after = await resizeHeader.evaluate((header) => header.getBoundingClientRect().width);
      if (after < before + 9 || !(await resize.evaluate((element) => document.activeElement === element))) {
        throw new Error(`${harness} did not preserve exact focused keyboard resizing: ${before} -> ${after}.`);
      }
      await page.keyboard.press("ArrowLeft");
    }

    if (label === "435px narrow") {
      const firstHeader = page.locator('th[data-grid-column="0"]');
      await verifyColumnHeaderGeometry(firstHeader, `${harness} first header before Home`);
      await verifyColumnHeaderMenuLayout(page, firstHeader, `${harness} first header before Home`);
      const firstResize = firstHeader.locator(".columnResizeHandle");
      await firstResize.focus();
      await page.keyboard.press("Home");
      await page.waitForFunction(() => {
        const first = document.querySelector('th[data-grid-column="0"]');
        return first instanceof HTMLElement && first.offsetWidth <= 81;
      });
      await verifyColumnHeaderGeometry(firstHeader, `${harness} first header after Home`);
      await verifyColumnHeaderMenuLayout(page, firstHeader, `${harness} first header after Home`);

      const scroller = page.getByTestId("data-grid-scroller");
      await scroller.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await page.waitForTimeout(100);
      const lastColumn = await page.evaluate(() => {
        const payload = globalThis.openWranglerSessionPayload;
        return payload?.kind === "sessionOpened" ? payload.metadata.schema.length - 1 : -1;
      });
      const lastHeader = page.locator(`th[data-grid-column="${lastColumn}"]`);
      await lastHeader.waitFor();
      await verifyColumnHeaderGeometry(lastHeader, `${harness} last header at the right scroll edge`);
      await verifyColumnHeaderMenuLayout(page, lastHeader, `${harness} last header at the right scroll edge`);

      await scroller.evaluate((element) => {
        element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
      });
      await page.waitForTimeout(100);
      const middleEdgeColumn = await page.locator("th[data-grid-column]").evaluateAll((headers) => {
        const scroller = headers[0]?.closest('[data-testid="data-grid-scroller"]');
        const scrollerBounds = scroller?.getBoundingClientRect();
        if (!scrollerBounds) return null;
        return (
          headers
            .map((header) => ({
              bounds: header.getBoundingClientRect(),
              column: header.getAttribute("data-grid-column")
            }))
            .filter(({ bounds }) => bounds.left >= scrollerBounds.left && bounds.right <= scrollerBounds.right)
            .sort((first, second) => first.bounds.left - second.bounds.left)[0]?.column ?? null
        );
      });
      if (middleEdgeColumn === null) {
        throw new Error(`${harness} did not expose a complete header at the middle horizontal scroll edge.`);
      }
      const middleEdgeHeader = page.locator(`th[data-grid-column="${middleEdgeColumn}"]`);
      await verifyColumnHeaderGeometry(middleEdgeHeader, `${harness} middle horizontal scroll edge`);
      await verifyColumnHeaderMenuLayout(page, middleEdgeHeader, `${harness} middle horizontal scroll edge`);
    }
    await page.close();
  }
  console.log(
    "Computed column-header target size, separation, focus, resize, menu, zoom, narrow and forced colors verified."
  );
}

async function verifyColumnHeaderGeometry(header, label) {
  const receipt = await header.evaluate((element) => {
    const boundsFor = (selector) => element.querySelector(selector)?.getBoundingClientRect();
    const overlap = (first, second) =>
      first && second
        ? {
            height: Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top)),
            width: Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
          }
        : null;
    const title = boundsFor(".columnTitle");
    const type = boundsFor(".columnType");
    const copy = boundsFor(".columnHeaderActions > button");
    const menu = boundsFor(".columnMenu > summary");
    const resize = boundsFor(".columnResizeHandle");
    return {
      copyResize: overlap(copy, resize),
      menuResize: overlap(menu, resize),
      resizeTitle: overlap(resize, title),
      resizeType: overlap(resize, type),
      title: title && { height: title.height, width: title.width },
      type: type && { height: type.height, width: type.width }
    };
  });
  const overlaps = [receipt.copyResize, receipt.menuResize, receipt.resizeTitle, receipt.resizeType];
  if (
    !receipt.title ||
    !receipt.type ||
    receipt.title.width <= 0 ||
    receipt.title.height <= 0 ||
    receipt.type.width <= 0 ||
    receipt.type.height <= 0 ||
    overlaps.some((overlap) => overlap && overlap.width > 0.6 && overlap.height > 0.6)
  ) {
    throw new Error(`${label} lost header content or overlapped the resize target: ${JSON.stringify(receipt)}.`);
  }
}

async function verifyColumnHeaderMenuLayout(page, header, label) {
  const toggle = header.locator(".columnMenu > summary");
  await toggle.focus();
  const focus = await toggle.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      active: document.activeElement === element,
      backgroundColor: style.backgroundColor,
      focusVisible: element.matches(":focus-visible"),
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth)
    };
  });
  if (
    !focus.active ||
    !focus.focusVisible ||
    focus.outlineStyle !== "solid" ||
    focus.outlineColor === "transparent" ||
    focus.outlineWidth <= 0 ||
    focus.backgroundColor === "transparent" ||
    focus.backgroundColor === "rgba(0, 0, 0, 0)"
  ) {
    throw new Error(`${label} lacks an explicit visible column-menu focus indicator: ${JSON.stringify(focus)}.`);
  }
  await page.keyboard.press("Enter");
  const menu = header.locator(".columnMenuContent");
  await menu.waitFor({ state: "visible" });
  const receipt = await menu.evaluate((content) => {
    const bounds = content.getBoundingClientRect();
    const summary = content.parentElement?.querySelector(":scope > summary");
    const summaryBounds = summary?.getBoundingClientRect();
    const scroller = content.closest('[data-testid="data-grid-scroller"]');
    const scrollerBounds = scroller?.getBoundingClientRect();
    const inset = 2;
    const samples = [
      [bounds.left + inset, bounds.top + inset],
      [bounds.right - inset, bounds.top + inset],
      [bounds.left + inset, bounds.bottom - inset],
      [bounds.right - inset, bounds.bottom - inset],
      [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2]
    ];
    return {
      anchored: Boolean(summaryBounds && Math.abs(bounds.top - summaryBounds.bottom) <= 1),
      clipped: samples.some(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !(hit === content || content.contains(hit));
      }),
      horizontalBounds: {
        left: Math.max(0, scrollerBounds?.left ?? 0),
        right: Math.min(innerWidth, scrollerBounds?.right ?? innerWidth)
      },
      menuBounds: { bottom: bounds.bottom, left: bounds.left, right: bounds.right, top: bounds.top },
      noContentOverflow:
        content.scrollWidth <= content.clientWidth + 1 && content.scrollHeight <= content.clientHeight + 1,
      viewportContained: bounds.top >= -1 && bounds.bottom <= innerHeight + 1
    };
  });
  if (
    !receipt.anchored ||
    receipt.clipped ||
    !receipt.noContentOverflow ||
    !receipt.viewportContained ||
    receipt.menuBounds.left < receipt.horizontalBounds.left - 1 ||
    receipt.menuBounds.right > receipt.horizontalBounds.right + 1
  ) {
    throw new Error(`${label} clipped or detached its open column menu: ${JSON.stringify(receipt)}.`);
  }
  await toggle.focus();
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "hidden" });
}
