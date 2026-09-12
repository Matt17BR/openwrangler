// Temporary public UI pilot. Unestablished public selectors fail explicitly.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const vscode = require("vscode");

// Fixed public workbench metadata only; descriptions, cell values and output bytes are excluded.
function readPublicEntryDomState() {
  const all = (root, selector) => [...root.querySelectorAll(selector)];
  const shown = (element) => element.checkVisibility({ checkVisibilityCSS: true });
  const text = (element) => (element?.textContent || "").replace(/\s+/g, " ").trim();
  const scopes = (selector) => all(document, selector).filter(shown);
  const knownControls = (roots) =>
    roots
      .flatMap((root) => all(root, 'button,a,[role="button"],[role="menuitem"]'))
      .filter(shown)
      .flatMap((element) => {
        const name = element.getAttribute("aria-label") || text(element) || element.getAttribute("title") || "";
        return /^(?:View data|More Actions(?:\.\.\.)?)$/.test(name)
          ? [
              {
                role: ["button", "link", "menuitem"].includes(element.getAttribute("role"))
                  ? element.getAttribute("role")
                  : element.hasAttribute("role")
                    ? "other"
                    : element.tagName.toLowerCase(),
                name
              }
            ]
          : [];
      })
      .slice(0, 8);
  const toolbars = scopes(".notebook-editor .notebook-toolbar-container,.notebookOverlay .notebook-toolbar-container");
  const menus = scopes(".context-view.monaco-menu-container");
  const pickers = scopes(".quick-input-widget");
  const options = pickers.flatMap((picker) => all(picker, '[role="option"]'));
  const matching = options.slice(0, 64).flatMap((option) => {
    const labels = all(option, ".label-name"),
      name = text(labels[0]);
    if (!["comparison_frame", "comparison_original"].includes(name)) return [];
    const main = all(option, ".quick-input-list-row:first-child .label-name");
    return [
      {
        name,
        optionVisible: shown(option),
        labelCount: labels.length,
        visibleLabelCount: labels.filter(shown).length,
        matchingLabelCount: labels.filter((label) => text(label) === name).length,
        matchingVisibleLabelCount: labels.filter((label) => shown(label) && text(label) === name).length,
        mainLabelCount: main.length,
        mainVisibleLabelCount: main.filter(shown).length,
        mainExactNameCount: main.filter((label) => shown(label) && text(label) === name).length
      }
    ];
  });
  return {
    toolbar: { containers: toolbars.length, controls: knownControls(toolbars) },
    menu: {
      containers: menus.length,
      visibleRoleMenus: scopes('[role="menu"]').length,
      controls: knownControls(menus)
    },
    picker: {
      containers: pickers.length,
      domOptions: options.length,
      scannedOptions: Math.min(options.length, 64),
      matchingOptions: matching.length,
      matchingOptionsTruncated: matching.length > 8,
      options: matching.slice(0, 8)
    }
  };
}

exports.run = async function () {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert(workspace, "Missing isolated workspace");
  const request = JSON.parse(fs.readFileSync(path.join(workspace, "request.json"), "utf8"));
  assert(request.product === "dw" && request.rows === 100000);
  assert(request.mode === "pilot", "Diagnostic rejects study");
  assert.notEqual(process.env.OPEN_WRANGLER_EXTENSION_TESTS, "1");
  const { chromium } = createRequire(path.join(request.repo, "package.json"))("playwright-core");
  const owner = await import(pathToFileURL(path.join(request.repo, "scripts/editor-acceptance.mjs")).href);
  const receipt = {
    purpose: "public-profile-controls-diagnostic",
    id: request.id,
    setup: {},
    samples: [],
    status: "pending"
  };
  let browser,
    opened,
    sourceNotebook,
    captureEntryState,
    publicFrames = () => [],
    stage = "connect";
  const checkpoint = (next) => {
    stage = next;
    owner.writeAcceptanceProgress(
      process.env.OPEN_WRANGLER_TEST_PROGRESS,
      owner.createAcceptanceProgressEnvelope(
        process.env.OPEN_WRANGLER_TEST_RUN_ID,
        process.env.OPEN_WRANGLER_TEST_PHASE,
        next
      )
    );
  };
  const save = () => fs.writeFileSync(path.join(workspace, "measurements.json"), JSON.stringify(receipt));
  const poll = async (predicate, name, milliseconds = 30000) => {
    const deadline = performance.now() + milliseconds;
    while (performance.now() < deadline) {
      const result = await predicate();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`PILOT_GATE:${name}`);
  };
  const visible = async (locator) => (await locator.count()) === 1 && (await locator.isVisible());
  const click = async (locator, name) => {
    await poll(() => visible(locator), name);
    assert(await locator.isEnabled(), `PILOT_GATE:disabled-${name}`);
    await locator.click({ timeout: 5000 });
  };
  try {
    const setupStart = performance.now();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OPEN_WRANGLER_EDITOR_CDP_PORT}`);
    const page = await poll(
      async () =>
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => /workbench/i.test(p.url())),
      "workbench"
    );
    page.setDefaultTimeout(5000);
    receipt.setup.workbenchGeometry = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      availableWidth: window.screen.availWidth,
      availableHeight: window.screen.availHeight,
      devicePixelRatio: window.devicePixelRatio
    }));
    assert(Object.values(receipt.setup.workbenchGeometry).every(Number.isFinite), "Invalid workbench geometry");
    const frames = (publicFrames = () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .flatMap((p) => p.frames())
        .slice(0, 64));
    captureEntryState = async (point, metadata) => {
      let state = metadata;
      if (!state) {
        state = await page.evaluate(readPublicEntryDomState);
        const picker = page.locator(".quick-input-widget:visible");
        state.picker.locatorCount = await picker.count();
        state.picker.locatorVisible = state.picker.locatorCount === 1 ? await picker.isVisible() : null;
        state.picker.accessibleOptions = await picker.getByRole("option").count();
        const menus = page.locator(".context-view.monaco-menu-container"),
          visibleMenus = page.locator(".context-view.monaco-menu-container:visible");
        state.menu.totalContainers = await menus.count();
        state.menu.visibleContainers = await visibleMenus.count();
        assert(
          state.picker.locatorCount <= 1 && state.menu.visibleContainers <= 1,
          "DIAGNOSTIC:ambiguous-workbench-scope"
        );
        state.menu.accessibleItems = await visibleMenus.getByRole("menuitem").count();
        state.menu.accessibleViewData = await visibleMenus
          .getByRole("menuitem", { name: "View data", exact: true })
          .count();
        const toolbar = page.locator(
          ".notebook-editor:visible .notebook-toolbar-container:visible, .notebookOverlay:visible .notebook-toolbar-container:visible"
        );
        state.toolbar.accessibleViewData = await toolbar
          .getByRole("button", { name: "View data", exact: true })
          .count();
        const overflow = toolbar.getByRole("button", { name: /^More Actions(?:\.\.\.)?$/ });
        const count = await overflow.count();
        state.toolbar.overflow = { count };
        if (count === 1) {
          const expanded = await overflow.getAttribute("aria-expanded");
          Object.assign(state.toolbar.overflow, {
            visible: await overflow.isVisible(),
            enabled: await overflow.isEnabled(),
            expanded: expanded === "true" ? true : expanded === "false" ? false : null
          });
        }
        // Only fixed accessible-name aggregates leave these retained workbench scopes.
        for (const [kind, scope, roles, limit] of [
          ["menu", visibleMenus, ["button", "link", "menuitem"], 32],
          ["picker", picker, ["option"], 64]
        ]) {
          const candidates = roles.map((role) => scope.getByRole(role)).reduce((left, right) => left.or(right));
          const count = await candidates.count();
          assert(count <= limit, "DIAGNOSTIC:workbench-control-bound");
          const names = { candidates: count, editingExact: 0, viewingExact: 0, editingMention: 0, viewingMention: 0 };
          for (const [key, pattern] of [
            ["editingExact", /^Editing$/i],
            ["viewingExact", /^Viewing$/i],
            ["editingMention", /\bEditing\b/i],
            ["viewingMention", /\bViewing\b/i]
          ]) {
            names[key] = await roles
              .map((role) => scope.getByRole(role, { name: pattern }))
              .reduce((left, right) => left.or(right))
              .count();
            assert(names[key] <= count, "DIAGNOSTIC:incomplete-workbench-controls");
          }
          const complete = await candidates.evaluateAll((elements) => ({
            count: elements.length,
            connected: elements.every((element) => element.isConnected && element.ownerDocument === document)
          }));
          assert(complete.connected && complete.count === count, "DIAGNOSTIC:incomplete-workbench-controls");
          assert((await scope.count()) <= 1, "DIAGNOSTIC:ambiguous-workbench-scope");
          state[kind].modeNames = names;
        }
      }
      state.millisecondsFromFirstInteraction = opened === undefined ? null : performance.now() - opened;
      const observations = { ...receipt.entryDiagnostics, [point]: state };
      assert(Buffer.byteLength(JSON.stringify(observations), "utf8") <= 8192, "Entry diagnostic exceeds 8192 bytes");
      receipt.entryDiagnostics = observations;
      save();
    };
    const find = async (role, name) => {
      const found = [];
      for (const frame of frames()) {
        const locator = frame.getByRole(role, {
          name,
          exact: typeof name === "string"
        });
        if (await visible(locator)) found.push(locator);
      }
      assert(found.length <= 1, `PILOT_GATE:ambiguous-${role}`);
      return found[0];
    };
    const consent = async () => {
      const identity =
        request.product === "ow" ? "Open Wrangler (Matt17BR.openwrangler)" : "Data Wrangler (ms-toolsai.datawrangler)";
      const dialog = page.getByRole("dialog").filter({
        hasText: `Do you want to grant Kernel access to the extension ${identity}?`
      });
      if (await visible(dialog)) {
        assert(
          (await dialog.innerText()).includes("This allows the extension to execute code against Jupyter Kernels.")
        );
        const started = performance.now();
        await click(dialog.getByRole("button", { name: "Allow", exact: true }), "explicit-kernel-consent");
        await poll(async () => !(await visible(dialog)), "kernel-consent-dismissed");
        const duration = performance.now() - started,
          active = receipt.samples.at(-1);
        if (active?.status === "pending") {
          const field = opened === undefined ? "preEntryConsentMs" : "afterEntryConsentMs";
          active[field] += duration;
        } else receipt.setup.consentMs = (receipt.setup.consentMs || 0) + duration;
        receipt.setup.consentAccepted = true;
      }
    };
    const jupyter = vscode.extensions.getExtension("ms-toolsai.jupyter");
    assert(jupyter && jupyter.packageJSON.version === "2025.9.1");
    await jupyter.activate();
    const notebook = await vscode.workspace.openNotebookDocument(
      vscode.Uri.file(path.join(workspace, "comparison.ipynb"))
    );
    sourceNotebook = notebook;
    const editor = await vscode.window.showNotebookDocument(notebook);
    const notebookTab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find(
        (tab) => tab.input instanceof vscode.TabInputNotebook && tab.input.uri.toString() === notebook.uri.toString()
      );
    assert(notebookTab, "Missing exact source notebook tab");
    checkpoint("kernel-selection");
    let selectionError;
    const selection = vscode.commands
      .executeCommand("notebook.selectKernel", { notebookEditor: editor })
      .catch((error) => {
        selectionError = error;
      });
    const traversed = new Set();
    await poll(async () => {
      if (selectionError) throw new Error("PILOT_GATE:kernel-command");
      const input = page.locator(".quick-input-widget:visible");
      if (!(await visible(input))) return false;
      const target = input.getByRole("option", {
        name: /Python 3\.12 \(Public comparison\)/
      });
      if (await visible(target)) {
        await target.click();
        return true;
      }
      for (const name of ["Select Another Kernel...", "Jupyter Kernel...", "Jupyter", "Local Kernel Specs..."]) {
        const route = input.getByRole("option", { name, exact: true });
        if (!traversed.has(name) && (await visible(route))) {
          traversed.add(name);
          await route.click();
          break;
        }
      }
      return false;
    }, "exact-kernel");
    await selection;
    const execute = async (index, marker) => {
      assert(!notebook.isClosed, "Source notebook was disposed");
      assert.equal(vscode.window.activeNotebookEditor?.notebook, notebook);
      const cell = notebook.cellAt(index),
        before = cell.executionSummary?.executionOrder;
      const completion = vscode.commands.executeCommand("notebook.cell.execute", {
        document: notebook.uri,
        ranges: [{ start: index, end: index + 1 }]
      });
      const result = await poll(
        async () => {
          await consent();
          const summary = cell.executionSummary;
          if (!summary?.executionOrder || summary.executionOrder === before || summary.success === undefined)
            return false;
          assert.equal(summary.success, true, `PILOT_GATE:cell-${index}-failed`);
          const text = cell.outputs
            .flatMap((o) => o.items)
            .filter((item) => ["text/plain", "application/vnd.code.notebook.stdout"].includes(item.mime))
            .map((item) => Buffer.from(item.data).toString("utf8"))
            .join("\n");
          if (!marker) return true;
          const line = text.split(/\r?\n/).find((value) => value.startsWith(marker));
          return line ? JSON.parse(line.slice(marker.length)) : false;
        },
        `cell-${index}-receipt`,
        60000
      );
      await completion;
      return result;
    };
    const replaceCell = async (index, code) => {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [
        vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, "python")
        ])
      ]);
      assert(await vscode.workspace.applyEdit(edit));
    };
    checkpoint("fixture-prepare");
    const source = await execute(0, "COMPARISON_READY:");
    receipt.setup.kernelRuntime = { python: source.runtime.python, packages: source.runtime.packages };
    assert.deepEqual(source.runtime, request.runtimeIdentity, "Kernel interpreter/environment mismatch");
    assert.equal(source.profiles.length, 20);
    assert.match(source.kernelIdentity.nonce, /^[a-f0-9]{32}$/);
    assert(Number.isSafeInteger(source.kernelIdentity.pid) && source.kernelIdentity.pid > 0);
    Object.assign(receipt.setup, {
      milliseconds: performance.now() - setupStart,
      sourceDigest: source.digest,
      kernelIdentityVerified: true
    });

    const grid = async (capture = false) => {
      await consent();
      const matches = [],
        handles = [];
      let selected;
      const candidates = browser
        .contexts()
        .flatMap((context) => context.pages())
        .flatMap((candidate) => candidate.frames());
      receipt.gridDiscovery = {
        frames: candidates.length,
        frameLimit: 64,
        rootLimit: 8,
        maximumRootCount: 0,
        complete: false
      };
      assert(candidates.length <= 64, "PILOT_GATE:incomplete-frame-discovery");
      try {
        for (const frame of candidates) {
          const roots = frame.locator('[role="grid"]');
          const elements = await roots.elementHandles();
          handles.push(...elements);
          receipt.gridDiscovery.maximumRootCount = Math.max(receipt.gridDiscovery.maximumRootCount, elements.length);
          assert(elements.length <= 8, "PILOT_GATE:incomplete-grid-discovery");
          for (const [index, element] of elements.entries()) {
            const state = await element.evaluate((root) => ({
              connected: root.isConnected,
              visible: root.checkVisibility({ checkVisibilityCSS: true }),
              busy: root.getAttribute("aria-busy") === "true",
              columns: root.getAttribute("aria-colcount")
            }));
            if (state.connected && state.visible && !state.busy && ["20", "21"].includes(state.columns))
              matches.push({ frame, root: roots.nth(index), element });
          }
        }
        receipt.gridDiscovery.complete = true;
        assert(matches.length <= 1, "PILOT_GATE:ambiguous-product-grid");
        const target = matches[0];
        if (!target) return false;
        if (capture) selected = target.element;
        return { frame: target.frame, root: target.root, ...(capture ? { element: selected } : {}) };
      } finally {
        for (const handle of handles) if (handle !== selected) await handle.dispose();
      }
    };
    const columnCell = (row, index) =>
      row.locator(`td[aria-colindex="${index}"],[role="gridcell"][aria-colindex="${index}"]`);
    const rowCells = async (root, wantedId, capture = false) => {
      if (capture) {
        const handle = await root.evaluateHandle((grid, wanted) => {
          if (!grid.isConnected) return null;
          const offset = grid.getAttribute("aria-colcount") === "21" ? 2 : 1;
          for (const row of [...grid.querySelectorAll('tr,[role="row"]')].slice(0, 100)) {
            const cells = row.querySelectorAll(
              `td[aria-colindex="${offset}"],[role="gridcell"][aria-colindex="${offset}"]`
            );
            if (cells.length !== 1) continue;
            const cell = cells[0];
            if (
              cell.checkVisibility({ checkVisibilityCSS: true }) &&
              cell.innerText.replaceAll(",", "").trim() === String(wanted)
            )
              return cell;
          }
          return null;
        }, wantedId);
        const first = handle.asElement();
        if (!first) {
          await handle.dispose();
          return false;
        }
        try {
          const values = await first.evaluate((cell, grid) => {
            if (!cell.isConnected || !grid.isConnected || !grid.contains(cell)) return null;
            const row = cell.closest('tr,[role="row"]');
            if (!row || !grid.contains(row)) return null;
            const offset = grid.getAttribute("aria-colcount") === "21" ? 2 : 1;
            const values = [];
            for (let index = offset; index < offset + 4; index++) {
              const cells = row.querySelectorAll(
                `td[aria-colindex="${index}"],[role="gridcell"][aria-colindex="${index}"]`
              );
              if (cells.length !== 1 || !cells[0].checkVisibility({ checkVisibilityCSS: true })) return null;
              values.push(cells[0].innerText);
            }
            return values;
          }, root);
          if (values?.length === 4 && values[0].replaceAll(",", "").trim() === String(wantedId))
            return { first, values };
        } catch (error) {
          await first.dispose();
          throw error;
        }
        await first.dispose();
        return false;
      }
      const offset = (await root.getAttribute("aria-colcount")) === "21" ? 2 : 1;
      const rows = root.locator('tr,[role="row"]');
      for (let i = 0; i < Math.min(await rows.count(), 100); i++) {
        const row = rows.nth(i),
          first = columnCell(row, offset);
        if (!(await visible(first))) continue;
        const id = (await first.innerText()).replaceAll(",", "").trim();
        if (wantedId !== undefined && id !== String(wantedId)) continue;
        const values = [];
        for (let j = 0; j < 4; j++) {
          const cell = columnCell(row, offset + j);
          if (!(await visible(cell))) break;
          values.push(await cell.innerText());
        }
        if (values.length === 4) return { values, first };
      }
      return false;
    };
    const gridRows = (root, sourceRows) => {
      const integer = (value) =>
        /^\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value)) ? Number(value) : null;
      const rows = [...root.querySelectorAll('tr,[role="row"]')];
      const scanned = rows.slice(0, 100);
      const indices = scanned.map((row) => integer(row.getAttribute("aria-rowindex")));
      const valid = indices.filter((value) => value !== null);
      const view = root.ownerDocument.defaultView;
      const offset = root.getAttribute("aria-colcount") === "21" ? 2 : 1;
      const c00Cells = (row) =>
        row.querySelectorAll(`td[aria-colindex="${offset}"],[role="gridcell"][aria-colindex="${offset}"]`);
      const intersectsViewport = (cell) => {
        const box = cell.getBoundingClientRect();
        const gridBox = root.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.right > Math.max(0, gridBox.left) &&
          box.left < Math.min(view.innerWidth, gridBox.right) &&
          box.bottom > Math.max(0, gridBox.top) &&
          box.top < Math.min(view.innerHeight, gridBox.bottom)
        );
      };
      const describe = (row, cell) => {
        const display = view.getComputedStyle(row).display;
        return {
          rowIndex: integer(row.getAttribute("aria-rowindex")),
          cellRowIndex: integer(cell.getAttribute("aria-rowindex")),
          cellColumnIndex: integer(cell.getAttribute("aria-colindex")),
          rowDisplay: ["contents", "none", "block", "table-row", "grid", "flex"].includes(display) ? display : "other",
          rowBoxes: row.getClientRects().length,
          rowVisible: row.checkVisibility({ checkVisibilityCSS: true }),
          cellVisible: cell.checkVisibility({ checkVisibilityCSS: true }),
          cellInViewport: intersectsViewport(cell)
        };
      };
      const examples = [];
      for (const row of scanned) {
        if (examples.length === 3) break;
        const cells = c00Cells(row);
        if (cells.length === 1) examples.push(describe(row, cells[0]));
      }
      const tree = root.getRootNode();
      const active = tree.activeElement;
      let focusedTarget = root.contains(active) ? active : null;
      const activeId = focusedTarget?.getAttribute("aria-activedescendant");
      if (activeId !== undefined && activeId !== null) {
        const declared = /^[^\s\p{Cc}]+$/u.test(activeId) ? tree.getElementById(activeId) : null;
        focusedTarget = declared?.isConnected && root.contains(declared) ? declared : null;
      }
      const focusedRow = focusedTarget?.closest('tr,[role="row"]');
      const focusedCell = focusedTarget?.closest("[aria-colindex]");
      let focused = null;
      if (focusedRow && scanned.includes(focusedRow)) {
        const cells = c00Cells(focusedRow);
        focused = {
          rowIndex: integer(focusedRow.getAttribute("aria-rowindex")),
          columnIndex: focusedRow.contains(focusedCell) ? integer(focusedCell.getAttribute("aria-colindex")) : null,
          c00: null
        };
        if (
          cells.length === 1 &&
          cells[0].checkVisibility({ checkVisibilityCSS: true }) &&
          intersectsViewport(cells[0])
        ) {
          const text = cells[0].innerText.trim();
          const value = /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(text) ? Number(text.replaceAll(",", "")) : null;
          if (Number.isSafeInteger(value) && value >= 0 && value < sourceRows) focused.c00 = value;
        }
      }
      return {
        connected: root.isConnected,
        ariaRowcount: integer(root.getAttribute("aria-rowcount")),
        ariaColcount: integer(root.getAttribute("aria-colcount")),
        renderedRows: rows.length,
        scannedRows: scanned.length,
        rowScanTruncated: rows.length > 100,
        visibleRows: scanned.filter((row) => row.checkVisibility({ checkVisibilityCSS: true })).length,
        missingOrInvalidIndices: indices.length - valid.length,
        minimumObservedRowIndex: valid.length ? Math.min(...valid) : null,
        maximumObservedRowIndex: valid.length ? Math.max(...valid) : null,
        examples,
        focused
      };
    };
    const gridMetadata = async (target, state) => {
      state ??= { grid: await target.root.evaluate(gridRows, request.rows), status: [], statusCounts: [], markers: {} };
      // Each family's matched nodes are read together; changing labels never re-resolve an old index.
      const readMetadataMatches = (elements, { source, flags, limit = null, attribute = null }) => {
        const excluded =
          '[role="grid"],pre,code,input,textarea,[contenteditable="true"],.monaco-editor,[role="complementary"],[role="region"][aria-label*="profile" i],[role="region"][aria-label*="summary" i]';
        const pattern = new RegExp(source, flags);
        const result = {
          candidates: elements.length,
          scanned: Math.min(elements.length, 32),
          unavailable: 0,
          observed: false,
          matching: 0,
          invalid: 0,
          values: []
        };
        for (const element of elements.slice(0, 32)) {
          if (!element.isConnected) {
            result.unavailable++;
            continue;
          }
          if (
            !element.checkVisibility({ checkVisibilityCSS: true }) ||
            element.closest(excluded) ||
            element.querySelector(excluded)
          )
            continue;
          const text = attribute === "aria-label" ? element.getAttribute(attribute) : element.innerText;
          if (typeof text !== "string") {
            result.unavailable++;
            continue;
          }
          const match = pattern.exec(text.trim());
          if (!match) continue;
          result.observed = true;
          if (limit === null) continue;
          const counts = match
            .slice(1)
            .filter((value) => value !== undefined)
            .map((value) => Number(value.replaceAll(",", "")));
          if (counts.some((value) => !Number.isSafeInteger(value))) {
            result.invalid++;
            continue;
          }
          result.matching++;
          if (result.values.length < limit) result.values.push(counts);
        }
        return result;
      };
      const number = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)";
      const patterns = [
        ["rows", new RegExp(`^(?:Rows?\\s*:?\\s*(${number})|(${number})\\s+rows?)$`, "i")],
        ["columns", new RegExp(`^(?:Columns?\\s*:?\\s*(${number})|(${number})\\s+columns?)$`, "i")],
        ["showing", new RegExp(`^Showing\\s+(${number})\\s*[-–]\\s*(${number})\\s+of\\s+(${number})\\s+rows?$`, "i")],
        ["shape", new RegExp(`^(${number})\\s+rows?\\s*(?:[×x,·|]\\s*|\\s+)(${number})\\s+columns?$`, "i")],
        ["shapeLabel", new RegExp(`^(${number})\\s+rows?\\s+by\\s+(${number})\\s+columns?$`, "i"), "aria-label"]
      ];
      for (const [kind, pattern, attribute] of patterns) {
        const locator = attribute ? target.frame.getByLabel(pattern) : target.frame.getByText(pattern);
        const snapshot = await locator.evaluateAll(readMetadataMatches, {
          source: pattern.source,
          flags: pattern.flags,
          attribute,
          limit: 8 - state.status.length
        });
        for (const counts of snapshot.values) state.status.push({ kind, counts });
        state.statusCounts.push({
          kind,
          candidates: snapshot.candidates,
          scanned: snapshot.scanned,
          unavailable: snapshot.unavailable,
          matching: snapshot.matching,
          invalid: snapshot.invalid,
          retained: snapshot.values.length,
          truncated: snapshot.candidates > 32 || snapshot.matching > snapshot.values.length
        });
      }
      for (const [kind, pattern] of [
        ["sample", /\bsampl(?:e|ed|ing)\b/i],
        ["truncate", /\btruncat(?:e|ed|ion)\b/i],
        ["loading", /\bloading\b/i]
      ]) {
        const snapshot = await target.frame.getByText(pattern).evaluateAll(readMetadataMatches, {
          source: pattern.source,
          flags: pattern.flags
        });
        state.markers[kind] = {
          observed: snapshot.observed,
          candidates: snapshot.candidates,
          scanned: snapshot.scanned,
          unavailable: snapshot.unavailable,
          truncated: snapshot.candidates > 32
        };
      }
      return state;
    };
    for (const sampleName of ["fresh-session-first-open"]) {
      opened = undefined;
      const sample = {
        name: sampleName,
        status: "pending",
        metrics: {},
        preEntryConsentMs: 0,
        afterEntryConsentMs: 0,
        completedProfiles: 0,
        profileObservations: [],
        actions: []
      };
      receipt.samples.push(sample);
      save();
      const activeEditor = await vscode.window.showNotebookDocument(notebook);
      checkpoint(`${sampleName}:source-output`);
      const measuredCell = new vscode.NotebookRange(1, 2);
      activeEditor.selection = measuredCell;
      activeEditor.selections = [measuredCell];
      activeEditor.revealRange(measuredCell, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
      const measuredCellOwner = notebook.cellAt(1);
      await execute(1);
      const measuredExecutionOrder = measuredCellOwner.executionSummary?.executionOrder;
      const preEntryTabs = new Set(vscode.window.tabGroups.all.flatMap((group) => group.tabs));
      sample.entryRoute = request.product === "ow" ? "inline-open" : "notebook-cell-status";
      if (request.product === "ow") {
        const action = await poll(async () => {
          await consent();
          return find("button", /^Open.*Open Wrangler$/);
        }, "public-open-button");
        checkpoint(`${sampleName}:open`);
        opened = performance.now();
        await action.click();
      } else {
        // The documented cell-status action need not expose role="button".
        const notebookView = page.locator(".notebookOverlay.notebook-editor:visible");
        const cell = notebookView.locator(
          '.cell-list-container > .monaco-list > .monaco-scrollable-element > .monaco-list-rows > .monaco-list-row[data-index="1"]'
        );
        const action = await poll(async () => {
          await consent();
          const item = cell.locator(
            `.cell-statusbar-container .cell-status-item-has-command[aria-label="Open 'comparison_frame' in Data Wrangler"]`
          );
          sample.statusAction = {
            notebooks: await notebookView.count(),
            cells: await cell.count(),
            exactActions: await item.count()
          };
          assert(sample.statusAction.notebooks <= 1, "PILOT_GATE:ambiguous-notebook");
          assert(sample.statusAction.cells <= 1, "PILOT_GATE:ambiguous-measured-cell");
          assert(sample.statusAction.exactActions <= 1, "PILOT_GATE:ambiguous-cell-status-action");
          return (await visible(item)) ? item : false;
        }, "public-cell-status-action");
        const element = await action.elementHandle();
        assert(element, "PILOT_GATE:missing-cell-status-element");
        try {
          Object.assign(
            sample.statusAction,
            await element.evaluate((item) => ({
              connected: item.isConnected,
              visible: item.checkVisibility({ checkVisibilityCSS: true }),
              exactLabel: item.getAttribute("aria-label") === "Open 'comparison_frame' in Data Wrangler",
              measuredCell: item.closest(".monaco-list-row")?.getAttribute("data-index") === "1",
              hasCommand: item.classList.contains("cell-status-item-has-command"),
              tabIndex: item.tabIndex,
              disabled: item.getAttribute("aria-disabled") === "true",
              role: ["button", "link"].includes(item.getAttribute("role"))
                ? item.getAttribute("role")
                : item.getAttribute("role")
                  ? "other"
                  : "none"
            }))
          );
          const state = sample.statusAction;
          assert(
            state.connected &&
              state.visible &&
              state.exactLabel &&
              state.measuredCell &&
              state.hasCommand &&
              state.tabIndex === 0 &&
              !state.disabled,
            "PILOT_GATE:cell-status-action-state"
          );
          assert(!notebook.isClosed);
          assert.equal(vscode.window.activeNotebookEditor?.notebook, notebook);
          assert.equal(notebook.uri.toString(), notebookTab.input.uri.toString());
          assert.equal(notebook.cellAt(1), measuredCellOwner);
          assert.equal(measuredCellOwner.document.getText(), "comparison_frame");
          assert.equal(measuredCellOwner.executionSummary?.executionOrder, measuredExecutionOrder);
          assert.equal(measuredCellOwner.executionSummary?.success, true);
          checkpoint(`${sampleName}:open`);
          opened = performance.now();
          sample.entryActivation = "cell-status-click";
          await element.click({ timeout: 5000 });
        } finally {
          await element.dispose();
        }
      }
      sample.metrics.entryInteractionMs = performance.now() - opened;
      checkpoint(`${sampleName}:grid`);
      const gridDeadline = performance.now() + 30000;
      let target = await poll(() => grid(true), "product-grid", gridDeadline - performance.now());
      const gridElement = target.element;
      assert(gridElement, "PILOT_GATE:missing-grid-element");
      sample.entryObservation = {};
      let first, productTab;
      const sourceRetained = () =>
        !notebook.isClosed &&
        vscode.window.tabGroups.all.some((group) => group.tabs.includes(notebookTab)) &&
        notebookTab.input instanceof vscode.TabInputNotebook &&
        notebookTab.input.uri.toString() === notebook.uri.toString() &&
        notebook.cellAt(1) === measuredCellOwner &&
        measuredCellOwner.document.getText() === "comparison_frame" &&
        measuredCellOwner.executionSummary?.executionOrder === measuredExecutionOrder &&
        measuredCellOwner.executionSummary?.success === true;
      try {
        const observedTarget = { frame: target.frame, root: gridElement };
        let initialMetadata = {
          grid: await gridElement.evaluate(gridRows, request.rows),
          status: [],
          statusCounts: [],
          markers: {}
        };
        await captureEntryState("gridInitial", initialMetadata);
        assert(initialMetadata.grid.connected, "PILOT_GATE:captured-grid-detached");
        const readTabOwner = () => {
          const newTabs = vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .filter((tab) => !preEntryTabs.has(tab));
          const candidate = newTabs.length === 1 ? newTabs[0] : undefined;
          const kind =
            candidate?.input instanceof vscode.TabInputWebview
              ? "webview"
              : candidate?.input instanceof vscode.TabInputCustom
                ? "custom"
                : candidate?.input instanceof vscode.TabInputNotebook
                  ? "notebook"
                  : candidate
                    ? "other"
                    : "none";
          sample.entryObservation.tab = {
            newTabs: newTabs.length,
            kind,
            active: candidate !== undefined && candidate === vscode.window.tabGroups.activeTabGroup.activeTab,
            sourceRetained: sourceRetained(),
            sourceResource: kind === "custom" && candidate.input.uri.toString() === notebook.uri.toString()
          };
          return candidate;
        };
        productTab = await poll(
          () => {
            const candidate = readTabOwner(),
              state = sample.entryObservation.tab;
            assert(state.sourceRetained, "PILOT_GATE:source-owner-changed");
            assert(state.newTabs <= 1, "PILOT_GATE:ambiguous-new-product-tab");
            assert(
              !candidate || (["custom", "webview"].includes(state.kind) && !state.sourceResource),
              "PILOT_GATE:unsupported-product-tab"
            );
            return state.active ? candidate : false;
          },
          "product-tab",
          gridDeadline - performance.now()
        );
        sample.entryObservation.reportedShape = await poll(
          async () => {
            initialMetadata = await gridMetadata(observedTarget);
            await captureEntryState("gridInitial", initialMetadata);
            assert(initialMetadata.grid.connected, "PILOT_GATE:captured-grid-detached");
            assert(
              initialMetadata.statusCounts.every(
                (family) => !family.truncated && !family.unavailable && !family.invalid
              ),
              "PILOT_GATE:incomplete-public-shape"
            );
            const shapes = initialMetadata.status.filter(({ kind }) => kind === "shape" || kind === "shapeLabel");
            assert(shapes.length <= 1, "PILOT_GATE:ambiguous-public-shape");
            if (shapes.length === 0) return false;
            const [rows, columns] = shapes[0].counts;
            assert(rows === request.rows && columns === 20, "PILOT_GATE:wrong-public-shape");
            assert(
              initialMetadata.status.every(({ kind, counts }) =>
                kind === "rows"
                  ? counts.length === 1 && counts[0] === rows
                  : kind === "columns"
                    ? counts.length === 1 && counts[0] === columns
                    : kind === "showing"
                      ? counts[2] === rows
                      : true
              ),
              "PILOT_GATE:conflicting-public-shape"
            );
            return { rows, columns, source: shapes[0].kind === "shapeLabel" ? "aria-label" : "text" };
          },
          "public-source-shape",
          gridDeadline - performance.now()
        );
        first = await poll(() => rowCells(gridElement, 0, true), "first-four-cells", gridDeadline - performance.now());
        assert(
          await first.first.evaluate((cell, grid) => {
            if (
              !cell.isConnected ||
              !grid.isConnected ||
              !grid.contains(cell) ||
              cell.innerText.replaceAll(",", "").trim() !== "0"
            )
              return false;
            const row = cell.closest('tr,[role="row"]');
            if (!row || !grid.contains(row)) return false;
            const offset = grid.getAttribute("aria-colcount") === "21" ? 2 : 1;
            for (let index = offset; index < offset + 4; index++) {
              const cells = row.querySelectorAll(
                `td[aria-colindex="${index}"],[role="gridcell"][aria-colindex="${index}"]`
              );
              if (cells.length !== 1 || !cells[0].checkVisibility({ checkVisibilityCSS: true })) return false;
            }
            return true;
          }, gridElement),
          "PILOT_GATE:first-cell-changed"
        );
        assert(performance.now() < gridDeadline, "PILOT_GATE:grid-deadline");
        await first.first.click({ timeout: Math.max(1, Math.min(5000, gridDeadline - performance.now())) });
        const focus = await gridElement.evaluate((root) => ({
          connected: root.isConnected,
          documentFocused: root.ownerDocument.hasFocus(),
          gridFocused: root.contains(root.getRootNode().activeElement)
        }));
        const candidate = readTabOwner(),
          tab = sample.entryObservation.tab;
        sample.entryObservation.focus = focus;
        assert(
          candidate === productTab && tab.active && tab.sourceRetained && !tab.sourceResource,
          "PILOT_GATE:product-owner-changed"
        );
        assert(focus.connected && focus.documentFocused && focus.gridFocused, "PILOT_GATE:product-grid-focus");
        const focusedGrid = await gridElement.evaluate(gridRows, request.rows);
        assert(focusedGrid.focused?.c00 === 0, "PILOT_GATE:focused-initial-c00");
        assert(performance.now() < gridDeadline, "PILOT_GATE:grid-deadline");
        Object.assign(sample.entryObservation, {
          grid: focusedGrid,
          firstC00: 0,
          renderedCellCount: first.values.length
        });
        sample.metrics.firstPageMs = performance.now() - opened;
        save();
      } finally {
        try {
          await first?.first.dispose();
        } finally {
          await gridElement.dispose();
        }
      }
      const productFrame = target.frame;
      const currentGrid = async (pending = false) => {
        const current = await grid();
        assert(
          sourceRetained() &&
            vscode.window.tabGroups.all.some((group) => group.tabs.includes(productTab)) &&
            vscode.window.tabGroups.activeTabGroup.activeTab === productTab,
          "PILOT_GATE:product-owner-changed"
        );
        assert(
          !productFrame.isDetached() && (!current || current.frame === productFrame),
          "PILOT_GATE:product-frame-changed"
        );
        if (!current && pending) return false;
        assert(current, "DIAGNOSTIC:missing-grid");
        target = current;
        return current;
      };
      checkpoint(`${sampleName}:profiles`);
      const observation = {
        header: { observed: false },
        quickInsights: { observed: false },
        dataSummary: { observed: false },
        mode: { viewingObserved: false, editingOffered: false, editingConfirmed: false },
        forms: [],
        computationScope: "unknown"
      };
      sample.observation = observation;
      const held = new Set();
      const saveObservation = () => {
        assert(Buffer.byteLength(JSON.stringify(observation), "utf8") <= 8192, "DIAGNOSTIC:observation-bound");
        save();
      };
      const capture = async (locator, label) => {
        await currentGrid();
        const handles = await locator.elementHandles();
        let selected;
        try {
          assert(handles.length <= 32, `DIAGNOSTIC:truncated-${label}`);
          const candidates = [];
          for (const handle of handles) {
            const state = await handle.evaluate((element) => ({
              connected: element.isConnected && element.ownerDocument === document,
              visible: element.checkVisibility({ checkVisibilityCSS: true })
            }));
            assert(state.connected, `DIAGNOSTIC:detached-${label}`);
            if (state.visible) candidates.push(handle);
          }
          assert(candidates.length <= 1, `DIAGNOSTIC:ambiguous-${label}`);
          selected = candidates[0];
          if (selected) held.add(selected);
          return selected;
        } finally {
          for (const handle of handles) if (handle !== selected) await handle.dispose();
        }
      };
      const absent = async (locator) => {
        await currentGrid();
        const state = await locator.evaluateAll((elements) => ({
          count: elements.length,
          detached: elements.some((element) => !element.isConnected),
          visible: elements.slice(0, 32).some((element) => element.checkVisibility({ checkVisibilityCSS: true }))
        }));
        assert(state.count <= 32 && !state.detached, "DIAGNOSTIC:incomplete-absence");
        return !state.visible;
      };
      const controlFacts = (element, expected) => ({
        role: ["button", "menuitem", "option", "treeitem", "combobox"].includes(element.getAttribute("role"))
          ? element.getAttribute("role")
          : element.getAttribute("role")
            ? "other"
            : "none",
        tag: ["BUTTON", "SELECT", "INPUT", "A", "DIV", "SPAN"].includes(element.tagName)
          ? element.tagName.toLowerCase()
          : "other",
        ariaNameMatches: (element.getAttribute("aria-label") || "").toLowerCase() === expected.toLowerCase(),
        textMatches: (element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === expected.toLowerCase()
      });
      const act = async (element, name) => {
        await currentGrid();
        assert(
          await element.evaluate((node, expected) => {
            const label = (node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim();
            return (
              node.isConnected &&
              node.ownerDocument === document &&
              node.checkVisibility({ checkVisibilityCSS: true }) &&
              label.toLowerCase() === expected.toLowerCase()
            );
          }, name),
          "DIAGNOSTIC:changed-action"
        );
        assert(await element.isEnabled(), "DIAGNOSTIC:disabled-action");
        await element.click({ timeout: 5000 });
        await poll(() => currentGrid(true), "action-grid");
      };
      // This fixed projection never returns header/profile text or arbitrary names.
      const readSurface = (element, expected) => {
        const role = element.getAttribute("role");
        const text = (element.innerText || "").replace(/\s+/g, " ").trim();
        const result = {
          observed: true,
          connected: element.isConnected && element.ownerDocument === document,
          role: ["columnheader", "region", "complementary", "heading", "row", "gridcell"].includes(role)
            ? role
            : role
              ? "other"
              : "none",
          tag: ["TH", "TD", "DIV", "SPAN", "SECTION", "ASIDE"].includes(element.tagName)
            ? element.tagName.toLowerCase()
            : "other",
          ariaNameExactColumn: element.getAttribute("aria-label") === "c00",
          ariaNameStartsColumn: /^c00\b/.test(element.getAttribute("aria-label") || ""),
          textStartsColumn: /^c00\b/.test(text),
          containsColumn: /\bc00\b/.test(text),
          truncated: text.length > 8192,
          includesExcludedContent: !!element.querySelector(
            'pre,code,input,textarea,[contenteditable="true"],[role="grid"],table'
          ),
          metrics: {},
          plotPresent: false,
          samplingMentioned: false
        };
        if (result.truncated || result.includesExcludedContent) return result;
        for (const [key, pattern, value] of [
          ["missing", "missing|null(?:s| values?)?", expected.missing],
          ["distinct", "distinct|unique", expected.distinct],
          ["minimum", "min(?:imum)?", expected.minimum],
          ["maximum", "max(?:imum)?", expected.maximum]
        ]) {
          const match = new RegExp(`(?:${pattern})\\s*[:=]?\\s*([\\d,.]+)\\s*([kmb]?)(?![%\\w])`, "i").exec(text);
          const scale = match ? { k: 1000, m: 1e6, b: 1e9 }[match[2].toLowerCase()] || 1 : 1;
          const number = match?.[1].replaceAll(",", "");
          const tolerance = scale === 1 ? 0 : (scale * 10 ** -(number.split(".")[1]?.length || 0)) / 2;
          result.metrics[key] = {
            labelPresent: new RegExp(`\\b(?:${pattern})\\b`, "i").test(text),
            expectedMatch: !!match && Math.abs(Number(number) * scale - value) <= tolerance
          };
        }
        const plots = element.querySelectorAll("svg,canvas,meter,[role=img]");
        result.truncated ||= plots.length > 32;
        result.plotPresent = [...plots].slice(0, 32).some((node) => node.checkVisibility({ checkVisibilityCSS: true }));
        result.samplingMentioned = /\bsampl(?:e|ed|ing)|\bapproximate/i.test(text);
        return result;
      };
      const readOwnedSurface = async (element) => {
        await currentGrid();
        const facts = await element.evaluate(readSurface, source.profiles[0]);
        assert(facts.connected && !facts.truncated, "DIAGNOSTIC:incomplete-surface");
        return facts;
      };
      const namedControl = (name) => {
        const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
        return ["button", "menuitem", "option", "treeitem"]
          .map((role) => target.frame.getByRole(role, { name: pattern }))
          .reduce((left, right) => left.or(right));
      };
      try {
        const column = await capture(target.root.getByText("c00", { exact: true }), "c00");
        if (column) {
          observation.header = await readOwnedSurface(column);
          const headerHandle = await column.evaluateHandle((node) => {
            const header = node.closest('th,[role="columnheader"]');
            return header && header.closest('[role="grid"]') === node.closest('[role="grid"]') ? header : null;
          });
          const header = headerHandle.asElement();
          try {
            if (header) observation.quickInsights = await readOwnedSurface(header);
          } finally {
            await headerHandle.dispose();
          }
          observation.header.rolePrefixMatches = await target.root
            .getByRole("columnheader", { name: /^c00\b/ })
            .count();
          assert(observation.header.rolePrefixMatches <= 32, "DIAGNOSTIC:header-name-bound");
          await act(column, "c00");
          observation.header.clicked = true;
        }
        // A named semantic surface is independent of the selected header. No parent guessing.
        const summary = await capture(
          target.frame
            .getByRole("complementary", { name: /^Data Summary$/i })
            .or(target.frame.getByRole("region", { name: /^Data Summary$/i })),
          "data-summary"
        );
        observation.dataSummary.headingObserved = !!(await capture(
          target.frame.getByText("Data Summary", { exact: true }),
          "summary-heading"
        ));
        if (summary)
          observation.dataSummary = {
            ...(await readOwnedSurface(summary)),
            headingObserved: observation.dataSummary.headingObserved
          };
        saveObservation();
        checkpoint(`${sampleName}:mode-observation`);
        const viewing = await capture(target.frame.getByRole("menuitem", { name: "Viewing", exact: true }), "viewing");
        observation.mode.viewingObserved = !!viewing;
        if (viewing) observation.mode.viewingControl = await viewing.evaluate(controlFacts, "Viewing");
        if (viewing) {
          await currentGrid();
          await captureEntryState("beforeViewing");
          await currentGrid();
          await act(viewing, "Viewing");
          let editing;
          try {
            editing = await poll(() => capture(namedControl("Editing"), "editing-option"), "editing-offer", 5000);
          } catch (error) {
            if (error?.message !== "PILOT_GATE:editing-offer") throw error;
          }
          if (!editing) {
            await currentGrid();
            await captureEntryState("unresolvedEditingOffer");
            await currentGrid();
          }
          observation.mode.editingOffered = !!editing;
          if (editing) observation.mode.editingControl = await editing.evaluate(controlFacts, "Editing");
          if (editing) {
            await act(editing, "Editing");
            observation.mode.editingConfirmed = await poll(async () => {
              if (!(await currentGrid(true))) return false;
              let mode, operations;
              try {
                mode = await capture(
                  target.frame.getByRole("menuitem", { name: "Editing", exact: true }),
                  "editing-mode"
                );
                operations = await capture(target.frame.getByText("Operations", { exact: true }), "operations");
                return !!mode && !!operations;
              } finally {
                for (const element of [mode, operations]) {
                  if (element) {
                    held.delete(element);
                    await element.dispose();
                  }
                }
              }
            }, "editing-not-confirmed");
          }
        }
        saveObservation();
        if (observation.mode.editingConfirmed) {
          for (const [title, columnName] of [
            ["Fill missing values", "c01"],
            ["Convert text to lowercase", "c03"]
          ]) {
            checkpoint(`${sampleName}:form-${columnName}`);
            const form = {
              operation: title,
              offered: false,
              columnOffered: false,
              medianOffered: false,
              cancelled: false
            };
            observation.forms.push(form);
            // An existing Apply/Cancel would make the next operation's ownership ambiguous.
            const priorCancel = await capture(namedControl("Cancel"), "prior-cancel");
            const priorApply = await capture(namedControl("Apply"), "prior-apply");
            assert(!priorCancel && !priorApply, "DIAGNOSTIC:prior-preview");
            const operation = await capture(namedControl(title), "operation");
            form.offered = !!operation;
            if (operation) form.operationControl = await operation.evaluate(controlFacts, title);
            if (!operation) {
              saveObservation();
              continue;
            }
            await act(operation, title);
            await poll(async () => {
              if (!(await currentGrid(true))) return false;
              return capture(namedControl("Cancel"), "cancel");
            }, "form-cancel");
            const columnControl = await capture(
              target.frame.getByRole("combobox", { name: /^Column$/i }),
              "column-field"
            );
            form.columnControlObserved = !!columnControl;
            if (columnControl) form.columnControl = await columnControl.evaluate(controlFacts, "Column");
            if (columnControl) {
              const native = await columnControl.evaluate(
                (node, expected) => ({
                  select: node instanceof HTMLSelectElement,
                  matching:
                    node instanceof HTMLSelectElement
                      ? [...node.options].filter((option) => option.label === expected).length
                      : 0,
                  truncated: node instanceof HTMLSelectElement && node.options.length > 64
                }),
                columnName
              );
              assert(!native.truncated && native.matching <= 1, "DIAGNOSTIC:column-options");
              form.columnOffered = native.select && native.matching === 1;
              if (form.columnOffered) {
                await currentGrid();
                await columnControl.selectOption({ label: columnName }, { timeout: 5000 });
                await poll(() => currentGrid(true), "action-grid");
                form.columnSelected = await columnControl.evaluate(
                  (node, expected) =>
                    node.isConnected && node.selectedOptions.length === 1 && node.selectedOptions[0].label === expected,
                  columnName
                );
                assert(form.columnSelected, "DIAGNOSTIC:column-selection");
              }
            }
            if (columnName === "c01" && form.columnOffered) {
              const method = await capture(
                target.frame.getByRole("combobox", { name: /^(Method|Fill with)$/i }),
                "method-field"
              );
              form.methodControlObserved = !!method;
              if (method) form.methodControl = await method.evaluate(controlFacts, "Method");
              if (method) {
                const native = await method.evaluate((node) => ({
                  select: node instanceof HTMLSelectElement,
                  matching:
                    node instanceof HTMLSelectElement
                      ? [...node.options].filter((option) => option.label === "Median").length
                      : 0,
                  truncated: node instanceof HTMLSelectElement && node.options.length > 32
                }));
                assert(!native.truncated && native.matching <= 1, "DIAGNOSTIC:method-options");
                form.medianOffered = native.select && native.matching === 1;
                if (form.medianOffered) {
                  await currentGrid();
                  await method.selectOption({ label: "Median" }, { timeout: 5000 });
                  await poll(() => currentGrid(true), "action-grid");
                  form.medianSelected = await method.evaluate(
                    (node) =>
                      node.isConnected &&
                      node.selectedOptions.length === 1 &&
                      node.selectedOptions[0].label === "Median"
                  );
                  assert(form.medianSelected, "DIAGNOSTIC:method-selection");
                }
              }
            }
            form.applyObserved = !!(await capture(namedControl("Apply"), "apply"));
            const cancel = await capture(namedControl("Cancel"), "cancel-current");
            assert(cancel, "DIAGNOSTIC:cancel-unavailable");
            form.cancelControl = await cancel.evaluate(controlFacts, "Cancel");
            await act(cancel, "Cancel");
            await poll(async () => {
              await currentGrid();
              return (
                (await absent(namedControl("Cancel"))) &&
                (await absent(namedControl("Apply"))) &&
                (await absent(target.frame.getByRole("combobox", { name: /^(Column|Method|Fill with)$/i })))
              );
            }, "cancelled-form");
            const original = await rowCells(target.root, 0);
            assert(
              original && original.values.every((value, index) => value === first.values[index]),
              "DIAGNOSTIC:preview-not-restored"
            );
            form.cancelled = true;
            saveObservation();
          }
        }
        observation.unresolved = [];
        if (!observation.header.clicked) observation.unresolved.push("c00-click");
        if (!observation.quickInsights.observed) observation.unresolved.push("quick-insights-owner");
        if (!observation.dataSummary.observed || observation.dataSummary.includesExcludedContent)
          observation.unresolved.push("data-summary-owner");
        if (!observation.mode.editingConfirmed) observation.unresolved.push("editing-route");
        for (const form of observation.forms) {
          if (
            !form.offered ||
            !form.columnSelected ||
            (form.operation === "Fill missing values" && !form.medianSelected)
          )
            observation.unresolved.push(form.operation);
        }
        saveObservation();
      } finally {
        for (const element of held) await element.dispose();
      }
      assert(sourceRetained(), "DIAGNOSTIC:source-owner-changed");
      assert(await vscode.window.tabGroups.close(productTab, true), "DIAGNOSTIC:product-close");
      assert(!notebook.isClosed && notebook.cellAt(1) === measuredCellOwner);
      await vscode.window.showNotebookDocument(notebook);
      await replaceCell(
        2,
        "import pandas as pd\npd.testing.assert_frame_equal(comparison_frame, comparison_original, check_exact=True)\n" +
          "print('COMPARISON_VERIFIED:' + json.dumps({'digest': comparison_helpers['digest'](comparison_frame), " +
          "'kernelIdentity': {'nonce': comparison_kernel_identity['nonce'], 'pid': os.getpid()}, 'runtime': comparison_helpers['runtime_identity']()}))"
      );
      const verified = await execute(2, "COMPARISON_VERIFIED:");
      assert.equal(verified.digest, source.digest);
      assert.deepEqual(verified.kernelIdentity, source.kernelIdentity);
      assert.deepEqual(verified.runtime, request.runtimeIdentity);
      sample.kernelContinuityVerified = true;
      sample.sourceUnchanged = true;
      sample.status = "completed";
      checkpoint(`${sampleName}:observed`);
      save();
    }
    receipt.status = "completed";
    save();
    return;
  } catch (error) {
    const active = receipt.samples.at(-1);
    if (active?.status === "pending") active.status = "failed";
    try {
      await captureEntryState?.("failure");
    } catch {
      receipt.entryDiagnosticReadFailed = true;
    }
    // Failure-only public control labels; never serialize package code, cells, profiles or clipboard text.
    const controls = [],
      gridShapes = [];
    try {
      if (sourceNotebook && !sourceNotebook.isClosed && sourceNotebook.cellCount > 1) {
        receipt.failureOutputMimes = [
          ...new Set(sourceNotebook.cellAt(1).outputs.flatMap((output) => output.items.map((item) => item.mime)))
        ]
          .filter((mime) => mime.length <= 160 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime))
          .slice(0, 16);
      }
      for (const frame of publicFrames()) {
        if (gridShapes.length < 8) {
          const observed = await frame.evaluate(() =>
            [...document.querySelectorAll('[role="grid"],table')]
              .filter((element) => element.checkVisibility())
              .slice(0, 8)
              .map((element) => {
                const count = (name) => {
                  const value = element.getAttribute(name);
                  return value !== null && /^(?:0|[1-9]\d{0,15})$/.test(value) && Number.isSafeInteger(Number(value))
                    ? Number(value)
                    : null;
                };
                return {
                  role: ["grid", "table"].includes(element.getAttribute("role"))
                    ? element.getAttribute("role")
                    : element.hasAttribute("role")
                      ? "other"
                      : "table",
                  ariaRowcount: count("aria-rowcount"),
                  ariaColcount: count("aria-colcount")
                };
              })
          );
          gridShapes.push(...observed.slice(0, 8 - gridShapes.length));
        }
        const hasProduct = await frame
          .getByText("c00", { exact: true })
          .first()
          .isVisible()
          .catch(() => false);
        const observed = await frame.evaluate(
          (includeProduct) =>
            [
              ...(includeProduct
                ? [document]
                : document.querySelectorAll(
                    ".notebook-toolbar-container,.quick-input-widget,.context-view.monaco-menu-container"
                  ))
            ]
              .flatMap((scope) => [
                ...scope.querySelectorAll(
                  'button,a,input,select,[role="button"],[role="link"],[role="combobox"],[role="menuitem"],[role="tab"],[role="option"]'
                )
              ])
              .slice(0, 200)
              .flatMap((element) => {
                if (
                  !element.checkVisibility() ||
                  element.closest('[role="grid"],table,[role="columnheader"],[role="complementary"]')
                )
                  return [];
                const pickerOption =
                  element.closest(".quick-input-widget") && element.getAttribute("role") === "option";
                const label = (
                  (pickerOption
                    ? element.querySelector(".label-name")?.textContent
                    : element.getAttribute("aria-label")) ||
                  (element instanceof HTMLInputElement || element instanceof HTMLSelectElement
                    ? element.labels?.[0]?.textContent
                    : pickerOption
                      ? ""
                      : element.textContent?.trim()) ||
                  element.getAttribute("title") ||
                  ""
                )
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 120);
                if (
                  !/^(?:Editing|Viewing|Export as file|Apply|Cancel|Fill missing values|Convert text to lowercase|Median|Column|Method|Fill with|Operations|Data Summary|c(?:0[0-9]|1[0-9]))$/i.test(
                    label
                  )
                )
                  return [];
                return [
                  {
                    role: ["button", "link", "combobox", "menuitem", "tab", "option"].includes(
                      element.getAttribute("role")
                    )
                      ? element.getAttribute("role")
                      : ["BUTTON", "A", "INPUT", "SELECT"].includes(element.tagName)
                        ? element.tagName.toLowerCase()
                        : "other",
                    surface: element.closest(".quick-input-widget")
                      ? "picker"
                      : element.closest(".notebook-toolbar-container")
                        ? "notebook-toolbar"
                        : element.closest(".context-view.monaco-menu-container")
                          ? "menu"
                          : "product",
                    label
                  }
                ];
              }),
          hasProduct
        );
        for (const value of observed) {
          value.label = owner.sanitizeEditorAcceptanceDiagnostic(value.label, [
            workspace,
            request.repo,
            request.runtimeIdentity.prefix
          ]);
          if (controls.length >= 32 || Buffer.byteLength(JSON.stringify([...controls, value])) > 8192) break;
          controls.push(value);
        }
      }
    } catch {
      /* Preserve the actual phase failure if its public frame is already gone. */
    }
    if (gridShapes.length) receipt.visibleFailureGridShapes = gridShapes;
    if (controls.length) receipt.visibleFailureControls = controls;
    receipt.status = "failed";
    // Only exact authored guards are classified; arbitrary locator/runtime text stays private.
    const guard = typeof error.message === "string" ? error.message : "";
    const captureGuard =
      /^DIAGNOSTIC:(ambiguous|truncated|detached)-(c00|data-summary|summary-heading|viewing|editing-option|editing-mode|operations|prior-cancel|prior-apply|operation|cancel|column-field|method-field|apply|cancel-current)$/.exec(
        guard
      );
    const refusalCategory =
      captureGuard?.[1] === "detached" ||
      [
        "DIAGNOSTIC:missing-grid",
        "DIAGNOSTIC:source-owner-changed",
        "PILOT_GATE:product-owner-changed",
        "PILOT_GATE:product-frame-changed"
      ].includes(guard)
        ? "owner-loss"
        : captureGuard?.[1] === "ambiguous" ||
            ["PILOT_GATE:ambiguous-product-grid", "DIAGNOSTIC:ambiguous-workbench-scope"].includes(guard)
          ? "ambiguous-control"
          : captureGuard?.[1] === "truncated" ||
              [
                "PILOT_GATE:incomplete-frame-discovery",
                "PILOT_GATE:incomplete-grid-discovery",
                "DIAGNOSTIC:workbench-control-bound",
                "DIAGNOSTIC:incomplete-workbench-controls",
                "DIAGNOSTIC:observation-bound",
                "DIAGNOSTIC:incomplete-absence",
                "DIAGNOSTIC:incomplete-surface",
                "DIAGNOSTIC:header-name-bound",
                "DIAGNOSTIC:column-options",
                "DIAGNOSTIC:method-options"
              ].includes(guard)
            ? "bounds"
            : [
                  "DIAGNOSTIC:changed-action",
                  "DIAGNOSTIC:disabled-action",
                  "PILOT_GATE:editing-not-confirmed",
                  "PILOT_GATE:action-grid",
                  "PILOT_GATE:form-cancel",
                  "DIAGNOSTIC:prior-preview",
                  "DIAGNOSTIC:cancel-unavailable",
                  "DIAGNOSTIC:column-selection",
                  "DIAGNOSTIC:method-selection",
                  "DIAGNOSTIC:preview-not-restored",
                  "DIAGNOSTIC:product-close",
                  "PILOT_GATE:cancelled-form"
                ].includes(guard)
              ? "action-or-cancellation"
              : "other";
    receipt.failure = {
      stage,
      category: refusalCategory,
      name: ["AssertionError", "TimeoutError", "Error"].includes(error.name) ? error.name : "Error",
      message: "Public control observation failed; no raw control or profile text retained."
    };
    save();
    throw new Error(`Public comparison failed at ${stage}`);
  } finally {
    await browser?.close().catch(() => {});
  }
};
