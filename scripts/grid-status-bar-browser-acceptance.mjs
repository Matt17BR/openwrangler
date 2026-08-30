import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyGridStatusBarBrowserAcceptance(browser, harnessDirectory) {
  for (const {
    harness,
    width,
    expectedDataGridWidth,
    range,
    previousDisabled,
    nextDisabled,
    expectSecondRow,
    openProfilesDrawer = false,
    visibleRowsOverride,
    expectSingleLine = true,
    expectVisibleClipboardLabels = expectedDataGridWidth > 480,
    expectWrappedFooter,
    expectSelectionStatusVisible
  } of [
    {
      harness: "grid-zoom-0-8.html",
      width: 1280,
      expectedDataGridWidth: 1600,
      range: "Rows 1\u20134 of 4",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: false
    },
    {
      harness: "grid-view.html",
      width: 1280,
      expectedDataGridWidth: 1280,
      range: "Rows 1\u20134 of 4",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: false
    },
    {
      harness: "grid-view.html",
      width: 800,
      expectedDataGridWidth: 800,
      range: "Rows 1\u20134 of 4",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: false
    },
    ...[481, 550, 640, 800, 840, 841].map((width) => ({
      harness: "grid-view.html",
      width,
      expectedDataGridWidth: width,
      range: "Rows 99,999,997\u2013100,000,000 of 100,000,000",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: false,
      visibleRowsOverride: "Rows 99,999,997\u2013100,000,000 of 100,000,000"
    })),
    ...[900, 901, 1048, 1049].map((width) => ({
      harness: "grid-view.html",
      width,
      expectedDataGridWidth: width,
      range: "Rows 99,999,997\u2013100,000,000 of 100,000,000",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: false,
      visibleRowsOverride: "Rows 99,999,997\u2013100,000,000 of 100,000,000",
      expectWrappedFooter: width === 900 ? undefined : width <= 1048,
      expectSelectionStatusVisible: width > 900
    })),
    {
      harness: "grid-zoom-1-5.html",
      width: 1280,
      expectedDataGridWidth: 853,
      range: "Rows 1\u20134 of 4",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: false
    },
    {
      harness: "grid-zoom-2.html",
      width: 1280,
      expectedDataGridWidth: 640,
      range: "Rows 1\u20134 of 4",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: false
    },
    {
      harness: "by-example-preview-dark-zoom-200.html",
      width: 1280,
      expectedDataGridWidth: 640,
      range: "Rows 1\u201310 of 10",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: false
    },
    {
      harness: "summary-families-dark-zoom-200.html",
      width: 1280,
      expectedDataGridWidth: 640,
      range: "Rows 1\u20134 of 6",
      previousDisabled: true,
      nextDisabled: false,
      expectSecondRow: false
    },
    {
      harness: "summary-families-dark-zoom-200.html",
      width: 1280,
      expectedDataGridWidth: 200,
      range: "Rows 1\u20134 of 6",
      previousDisabled: true,
      nextDisabled: false,
      expectSecondRow: true,
      openProfilesDrawer: true
    },
    {
      harness: "summary-families-dark-zoom-200.html",
      width: 1280,
      expectedDataGridWidth: 200,
      range: "Rows 99,999,997\u2013100,000,000 of 100,000,000",
      previousDisabled: true,
      nextDisabled: false,
      expectSecondRow: true,
      openProfilesDrawer: true,
      visibleRowsOverride: "Rows 99,999,997\u2013100,000,000 of 100,000,000",
      expectSingleLine: false
    },
    ...[241, 300, 312, 313, 314].map((width) => ({
      harness: "grid-view.html",
      width,
      expectedDataGridWidth: width,
      range: "Rows 1\u20134 of 4",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: true
    })),
    {
      harness: "grid-view.html",
      width: 265,
      expectedDataGridWidth: 265,
      range: "Rows 99,999,997\u2013100,000,000 of 100,000,000",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: true,
      visibleRowsOverride: "Rows 99,999,997\u2013100,000,000 of 100,000,000",
      expectSingleLine: false
    },
    {
      harness: "grid-view.html",
      width: 266,
      expectedDataGridWidth: 266,
      range: "Rows 99,999,997\u2013100,000,000 of 100,000,000",
      previousDisabled: true,
      nextDisabled: true,
      expectSecondRow: true,
      visibleRowsOverride: "Rows 99,999,997\u2013100,000,000 of 100,000,000"
    },
    {
      harness: "wide-view.html",
      width: 320,
      expectedDataGridWidth: 320,
      range: "Rows 1\u2013200 of 1,000",
      previousDisabled: true,
      nextDisabled: false,
      expectSecondRow: true
    },
    {
      harness: "grid-terminal-range-dark-320.html",
      width: 320,
      expectedDataGridWidth: 320,
      range: "Rows 99,999,801\u2013100,000,000 of 100,000,000",
      previousDisabled: false,
      nextDisabled: true,
      expectSecondRow: true
    },
    {
      harness: "grid-terminal-range-dark-320.html",
      width: 400,
      expectedDataGridWidth: 400,
      range: "Rows 99,999,801\u2013100,000,000 of 100,000,000",
      previousDisabled: false,
      nextDisabled: true,
      expectSecondRow: true
    },
    {
      harness: "grid-terminal-range-dark-zoom-200.html",
      width: 800,
      expectedDataGridWidth: 400,
      range: "Rows 99,999,801\u2013100,000,000 of 100,000,000",
      previousDisabled: false,
      nextDisabled: true,
      expectSecondRow: true
    }
  ]) {
    const page = await browser.newPage();
    await page.setViewportSize({ width, height: 760 });
    await page.goto(pathToFileURL(resolve(harnessDirectory, harness)).href, { waitUntil: "load" });
    if (openProfilesDrawer) {
      await page.getByRole("button", { name: "Column profiles and filters", exact: true }).click();
    }
    const statusBar = page.locator(".gridStatusBar");
    await statusBar.waitFor();
    const visibleRows = statusBar.getByRole("status", { name: "Visible rows" });
    if (visibleRowsOverride !== undefined) {
      await visibleRows.evaluate((status, text) => {
        status.textContent = text;
      }, visibleRowsOverride);
    }
    if ((await visibleRows.textContent())?.trim() !== range) {
      throw new Error(`${harness} did not expose the exact visible-row range ${JSON.stringify(range)}.`);
    }
    if (
      (await visibleRows.getAttribute("aria-live")) !== "polite" ||
      (await visibleRows.getAttribute("aria-atomic")) !== "true"
    ) {
      throw new Error(`${harness} did not keep the visible-row range as one polite, atomic status.`);
    }
    const previous = statusBar.getByRole("button", { name: "Previous block" });
    const next = statusBar.getByRole("button", { name: "Next block" });
    const actualPreviousDisabled = await previous.evaluate(
      (button) => button instanceof HTMLButtonElement && button.disabled
    );
    const actualNextDisabled = await next.evaluate((button) => button instanceof HTMLButtonElement && button.disabled);
    if (
      actualPreviousDisabled !== previousDisabled ||
      actualNextDisabled !== nextDisabled ||
      (await previous.getAttribute("aria-disabled")) !== null ||
      (await next.getAttribute("aria-disabled")) !== null
    ) {
      throw new Error(
        `${harness} did not preserve exact native disabled semantics for block navigation: ${JSON.stringify({
          actualPreviousDisabled,
          actualNextDisabled,
          previousDisabled,
          nextDisabled
        })}.`
      );
    }
    if ((await previous.locator(".codicon-chevron-left").count()) !== 1) {
      throw new Error(`${harness} did not render the Previous block Codicon.`);
    }
    if ((await next.locator(".codicon-chevron-right").count()) !== 1) {
      throw new Error(`${harness} did not render the Next block Codicon.`);
    }
    const headerProfiles = statusBar.getByRole("button", { name: "Header profiles", exact: true });
    if ((await headerProfiles.getAttribute("aria-pressed")) !== "true") {
      throw new Error(`${harness} did not expose the default pressed Header profiles state.`);
    }
    const layout = await statusBar.evaluate((bar) => {
      const epsilon = 0.6;
      const bounds = bar.getBoundingClientRect();
      const scroller = bar.previousElementSibling;
      const rangeStatus = bar.querySelector('[role="status"][aria-label="Visible rows"]');
      const headerProfiles = bar.querySelector(".headerProfilesButton");
      const selectionStatus = bar.querySelector(".gridClipboardSelectionStatus");
      const app = bar.closest(".app");
      const dataGrid = bar.closest(".dataGrid");
      const primaryActions = [...bar.querySelectorAll(".gridNavigationButton, .gridClipboardControls button")];
      const rangeBounds = rangeStatus?.getBoundingClientRect();
      const visibleRowTextBounds = (() => {
        if (!rangeStatus) return undefined;
        const textRange = document.createRange();
        textRange.selectNodeContents(rangeStatus);
        const textBounds = textRange.getBoundingClientRect();
        textRange.detach();
        return textBounds;
      })();
      const primaryActionBottom = Math.max(...primaryActions.map((action) => action.getBoundingClientRect().bottom));
      const headerProfilesBounds = headerProfiles?.getBoundingClientRect();
      const selectionStatusBounds = selectionStatus?.getBoundingClientRect();
      const selectionStatusStyle = selectionStatus ? getComputedStyle(selectionStatus) : undefined;
      const rangeStyle = rangeStatus ? getComputedStyle(rangeStatus) : undefined;
      const actionableDescendants = [
        ...bar.querySelectorAll("button, input, select, textarea, summary, a[href], [tabindex]")
      ]
        .filter((element) => {
          const elementBounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            elementBounds.width > epsilon &&
            elementBounds.height > epsilon &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        })
        .map((element) => {
          const elementBounds = element.getBoundingClientRect();
          return {
            bounds: {
              bottom: elementBounds.bottom,
              left: elementBounds.left,
              right: elementBounds.right,
              top: elementBounds.top
            },
            label:
              element.getAttribute("aria-label") ?? element.textContent?.replace(/\s+/g, " ").trim() ?? element.tagName
          };
        });
      const actionableDescendantFailures = actionableDescendants.flatMap((action, index) => {
        const failures = [];
        if (
          action.bounds.left < bounds.left - epsilon ||
          action.bounds.right > bounds.right + epsilon ||
          action.bounds.top < bounds.top - epsilon ||
          action.bounds.bottom > bounds.bottom + epsilon
        ) {
          failures.push({ action: action.label, reason: "outside-footer" });
        }
        for (let otherIndex = index + 1; otherIndex < actionableDescendants.length; otherIndex += 1) {
          const other = actionableDescendants[otherIndex];
          const overlapWidth =
            Math.min(action.bounds.right, other.bounds.right) - Math.max(action.bounds.left, other.bounds.left);
          const overlapHeight =
            Math.min(action.bounds.bottom, other.bounds.bottom) - Math.max(action.bounds.top, other.bounds.top);
          if (overlapWidth > epsilon && overlapHeight > epsilon) {
            failures.push({
              action: action.label,
              other: other.label,
              overlapHeight,
              overlapWidth,
              reason: "overlapping-footer-actions"
            });
          }
        }
        return failures;
      });
      const visibleRowStatusFailures = visibleRowTextBounds
        ? actionableDescendants.flatMap((action) => {
            const overlapWidth =
              Math.min(visibleRowTextBounds.right, action.bounds.right) -
              Math.max(visibleRowTextBounds.left, action.bounds.left);
            const overlapHeight =
              Math.min(visibleRowTextBounds.bottom, action.bounds.bottom) -
              Math.max(visibleRowTextBounds.top, action.bounds.top);
            return overlapWidth > epsilon && overlapHeight > epsilon
              ? [
                  {
                    action: action.label,
                    overlapHeight,
                    overlapWidth,
                    reason: "visible-row-status-overlap"
                  }
                ]
              : [];
          })
        : [{ reason: "missing-visible-row-status" }];
      const visibleClipboardLabels = [...bar.querySelectorAll(".gridClipboardButtonLabel")].flatMap((label) => {
        const labelBounds = label.getBoundingClientRect();
        const style = getComputedStyle(label);
        return labelBounds.width > epsilon &&
          labelBounds.height > epsilon &&
          style.display !== "none" &&
          style.visibility !== "hidden"
          ? [label.textContent?.trim() ?? ""]
          : [];
      });
      return {
        actionableDescendantCount: actionableDescendants.length,
        actionableDescendantFailures,
        visibleRowStatusFailures,
        footerWrap: getComputedStyle(bar).flexWrap,
        position: getComputedStyle(bar).position,
        followsScroller: scroller?.matches('[data-testid="data-grid-scroller"]') === true,
        overflow: bar.scrollWidth - bar.clientWidth,
        dataGridWidth: dataGrid?.clientWidth ?? Number.POSITIVE_INFINITY,
        appOverflow: app ? app.scrollWidth - app.clientWidth : Number.POSITIVE_INFINITY,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rangeClipped: rangeStatus
          ? rangeStatus.scrollWidth > rangeStatus.clientWidth + 1 ||
            rangeStatus.scrollHeight > rangeStatus.clientHeight + 1
          : true,
        rangeOnSecondRow: Boolean(rangeBounds && rangeBounds.top >= primaryActionBottom - 1),
        rangeSingleLine: Boolean(
          rangeStatus && rangeStyle && rangeStatus.clientHeight <= Number.parseFloat(rangeStyle.fontSize) * 1.5
        ),
        visibleClipboardLabels,
        selectionStatusVisible: Boolean(
          selectionStatusBounds &&
          selectionStatusStyle &&
          selectionStatusBounds.width > 1 &&
          selectionStatusBounds.height > 1 &&
          selectionStatusStyle.clipPath === "none" &&
          selectionStatusStyle.display !== "none" &&
          selectionStatusStyle.visibility !== "hidden"
        ),
        headerProfilesReachable: Boolean(
          headerProfilesBounds &&
          headerProfilesBounds.left >= bounds.left - 1 &&
          headerProfilesBounds.right <= bounds.right + 1 &&
          headerProfilesBounds.top >= bounds.top - 1 &&
          headerProfilesBounds.bottom <= bounds.bottom + 1
        ),
        headerProfilesBackground: headerProfiles ? getComputedStyle(headerProfiles).backgroundColor : "transparent",
        clippedChildren: [...bar.children].flatMap((child) => {
          const childBounds = child.getBoundingClientRect();
          return childBounds.left >= bounds.left - 1 && childBounds.right <= bounds.right + 1
            ? []
            : [child.getAttribute("aria-label") ?? child.textContent?.trim() ?? child.tagName];
        })
      };
    });
    if (
      layout.position === "sticky" ||
      layout.position === "fixed" ||
      !layout.followsScroller ||
      layout.overflow > 1 ||
      layout.dataGridWidth !== expectedDataGridWidth ||
      layout.appOverflow > 1 ||
      layout.documentOverflow > 1 ||
      layout.actionableDescendantCount < 6 ||
      layout.actionableDescendantFailures.length > 0 ||
      layout.visibleRowStatusFailures.length > 0 ||
      layout.rangeClipped ||
      layout.rangeOnSecondRow !== expectSecondRow ||
      layout.rangeSingleLine !== expectSingleLine ||
      (expectWrappedFooter !== undefined && layout.footerWrap !== (expectWrappedFooter ? "wrap" : "nowrap")) ||
      (expectSelectionStatusVisible !== undefined && layout.selectionStatusVisible !== expectSelectionStatusVisible) ||
      (expectVisibleClipboardLabels &&
        layout.visibleClipboardLabels.join("|") !== "Copy cell|Copy row|Copy range|Copy column") ||
      !layout.headerProfilesReachable ||
      layout.headerProfilesBackground === "transparent" ||
      layout.headerProfilesBackground === "rgba(0, 0, 0, 0)" ||
      layout.clippedChildren.length > 0
    ) {
      throw new Error(`${harness} clipped, moved, or made the grid status bar sticky: ${JSON.stringify(layout)}.`);
    }
    await headerProfiles.click();
    if ((await headerProfiles.getAttribute("aria-pressed")) !== "false") {
      throw new Error(`${harness} did not keep Header profiles reachable as a pressed toggle.`);
    }
    await page.close();
  }

  const forcedPage = await browser.newPage();
  await forcedPage.setViewportSize({ width: 300, height: 760 });
  await forcedPage.emulateMedia({ forcedColors: "active" });
  await forcedPage.goto(pathToFileURL(resolve(harnessDirectory, "grid-terminal-range-dark-320.html")).href, {
    waitUntil: "load"
  });
  const forcedStatusBar = forcedPage.locator(".gridStatusBar");
  await forcedStatusBar.waitFor();
  const forcedHeaderProfiles = forcedStatusBar.getByRole("button", { name: "Header profiles", exact: true });
  await forcedHeaderProfiles.focus();
  const forcedStyles = await forcedStatusBar.evaluate((bar) => {
    const bounds = bar.getBoundingClientRect();
    const app = bar.closest(".app");
    const navigation = [...bar.querySelectorAll(".gridNavigationButton")].map((button) => {
      const style = getComputedStyle(button);
      const iconBounds = button.querySelector(".codicon")?.getBoundingClientRect();
      return {
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        forcedColorAdjust: style.forcedColorAdjust,
        opacity: style.opacity,
        iconVisible: Boolean(iconBounds && iconBounds.width > 0 && iconBounds.height > 0)
      };
    });
    const header = bar.querySelector(".headerProfilesButton");
    const headerStyle = header ? getComputedStyle(header) : undefined;
    return {
      barOverflow: bar.scrollWidth - bar.clientWidth,
      appOverflow: app ? app.scrollWidth - app.clientWidth : Number.POSITIVE_INFINITY,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clippedChildren: [...bar.children].filter((child) => {
        const childBounds = child.getBoundingClientRect();
        return childBounds.left < bounds.left - 1 || childBounds.right > bounds.right + 1;
      }).length,
      navigation,
      header: headerStyle
        ? {
            backgroundColor: headerStyle.backgroundColor,
            color: headerStyle.color,
            forcedColorAdjust: headerStyle.forcedColorAdjust,
            outlineColor: headerStyle.outlineColor,
            outlineStyle: headerStyle.outlineStyle,
            outlineWidth: headerStyle.outlineWidth
          }
        : undefined
    };
  });
  if (
    forcedStyles.barOverflow > 1 ||
    forcedStyles.appOverflow > 1 ||
    forcedStyles.documentOverflow > 1 ||
    forcedStyles.clippedChildren > 0 ||
    forcedStyles.navigation.length !== 2 ||
    forcedStyles.navigation.some(
      ({ borderStyle, borderWidth, forcedColorAdjust, opacity, iconVisible }) =>
        borderStyle !== "solid" ||
        Number.parseFloat(borderWidth) < 1 ||
        forcedColorAdjust !== "none" ||
        opacity !== "1" ||
        !iconVisible
    ) ||
    !forcedStyles.header ||
    forcedStyles.header.backgroundColor === "transparent" ||
    forcedStyles.header.backgroundColor === "rgba(0, 0, 0, 0)" ||
    forcedStyles.header.color === forcedStyles.header.backgroundColor ||
    forcedStyles.header.forcedColorAdjust !== "none" ||
    forcedStyles.header.outlineColor === "transparent" ||
    forcedStyles.header.outlineStyle === "none" ||
    Number.parseFloat(forcedStyles.header.outlineWidth) < 1
  ) {
    throw new Error(`Forced colors did not preserve the grid status controls: ${JSON.stringify(forcedStyles)}.`);
  }

  await forcedPage.close();
  console.log("Bottom grid status, narrow/200%-zoom range visibility, Codicon navigation, and forced colors verified.");
}
