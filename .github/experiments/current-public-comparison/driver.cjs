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
          ? [{ role: element.getAttribute("role") || element.tagName.toLowerCase(), name }]
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
  assert(["ow", "dw"].includes(request.product) && [100000, 1000000].includes(request.rows));
  assert.equal(request.mode, "pilot", "Temporary grid diagnostic rejects study");
  assert.equal(request.product, "dw");
  assert.equal(request.rows, 100000);
  assert.notEqual(process.env.OPEN_WRANGLER_EXTENSION_TESTS, "1");
  const { chromium } = createRequire(path.join(request.repo, "package.json"))("playwright-core");
  const owner = await import(pathToFileURL(path.join(request.repo, "scripts/editor-acceptance.mjs")).href);
  const receipt = { purpose: "public-grid-diagnostic", id: request.id, setup: {}, samples: [], status: "pending" };
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

    const grid = async () => {
      await consent();
      const matches = [];
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
      assert(candidates.length <= 64, "DIAGNOSTIC_GATE:incomplete-frame-discovery");
      if (receipt.purpose === "public-grid-diagnostic" && request.product === "dw") {
        const handles = [];
        let selected;
        try {
          for (const frame of candidates) {
            const roots = await frame.locator('[role="grid"]').elementHandles();
            handles.push(...roots);
            receipt.gridDiscovery.maximumRootCount = Math.max(receipt.gridDiscovery.maximumRootCount, roots.length);
            assert(roots.length <= 8, "DIAGNOSTIC_GATE:incomplete-grid-discovery");
            for (const root of roots) {
              const state = await root.evaluate((element) => ({
                connected: element.isConnected,
                visible: element.checkVisibility({ checkVisibilityCSS: true }),
                busy: element.getAttribute("aria-busy") === "true",
                columns: element.getAttribute("aria-colcount")
              }));
              if (state.connected && state.visible && !state.busy && ["20", "21"].includes(state.columns))
                matches.push({ frame, root });
            }
          }
          receipt.gridDiscovery.complete = true;
          assert(matches.length <= 1, "DIAGNOSTIC_GATE:ambiguous-product-grid");
          selected = matches[0]?.root;
          return matches[0] || false;
        } finally {
          for (const handle of handles) if (handle !== selected) await handle.dispose();
        }
      }
      for (const frame of candidates) {
        const roots = frame.locator('[role="grid"]');
        const count = await roots.count();
        receipt.gridDiscovery.maximumRootCount = Math.max(receipt.gridDiscovery.maximumRootCount, count);
        assert(count <= 8, "DIAGNOSTIC_GATE:incomplete-grid-discovery");
        for (let i = 0; i < count; i++) {
          const root = roots.nth(i);
          if (!(await root.isVisible()) || (await root.getAttribute("aria-busy")) === "true") continue;
          const columns = await root.getAttribute("aria-colcount");
          if (["20", "21"].includes(columns)) matches.push({ frame, root });
        }
      }
      receipt.gridDiscovery.complete = true;
      assert(matches.length <= 1, "DIAGNOSTIC_GATE:ambiguous-product-grid");
      return matches[0] || false;
    };
    const columnCell = (row, index) =>
      row.locator(`td[aria-colindex="${index}"],[role="gridcell"][aria-colindex="${index}"]`);
    const rowCells = async (root, wantedId, sentinelOnly = false) => {
      if (sentinelOnly) {
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
        if (first) return { first };
        await handle.dispose();
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
      const readMetadataMatches = (elements, { source, flags, limit = null }) => {
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
          if (typeof element.innerText !== "string") {
            result.unavailable++;
            continue;
          }
          const match = pattern.exec(element.innerText.trim());
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
        ["shape", new RegExp(`^(${number})\\s+rows?\\s*(?:[×x,·|]\\s*|\\s+)(${number})\\s+columns?$`, "i")]
      ];
      for (const [kind, pattern] of patterns) {
        const snapshot = await target.frame.getByText(pattern).evaluateAll(readMetadataMatches, {
          source: pattern.source,
          flags: pattern.flags,
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
    const metric = (text, labels) => {
      const match = new RegExp(`(?:${labels})\\s*[:=]?\\s*([\\d,.]+)\\s*([kmb]?)(?![%\\w])`, "i").exec(text);
      if (!match) return null;
      const number = match[1].replaceAll(",", ""),
        scale = { k: 1000, m: 1e6, b: 1e9 }[match[2].toLowerCase()] || 1;
      const tolerance = scale === 1 ? 0 : (scale * 10 ** -(number.split(".")[1]?.length || 0)) / 2;
      return { value: Number(number) * scale, tolerance };
    };
    const sameMetric = (text, labels, expected) => {
      const m = metric(text, labels);
      return m !== null && Math.abs(m.value - expected) <= m.tolerance;
    };
    const missingReady = (text, expected) => {
      if (request.product !== "ow") return sameMetric(text, "missing|null(?:s| values?)?", expected);
      const nulls = metric(text, "null"),
        nan = metric(text, "NaN");
      return (
        nulls !== null &&
        Math.abs(nulls.value + (nan?.value || 0) - expected) <= nulls.tolerance + (nan?.tolerance || 0)
      );
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
      if (sampleName === "same-session-reopen") {
        await replaceCell(
          2,
          "import pandas as pd\npd.testing.assert_frame_equal(comparison_frame, comparison_original, check_exact=True)\n" +
            "print('COMPARISON_RESET:' + json.dumps({'digest': comparison_helpers['digest'](comparison_frame), " +
            "'kernelIdentity': {'nonce': comparison_kernel_identity['nonce'], 'pid': os.getpid()}, 'runtime': comparison_helpers['runtime_identity']()}))"
        );
        const reset = await execute(2, "COMPARISON_RESET:");
        assert.equal(reset.digest, source.digest);
        assert.deepEqual(reset.kernelIdentity, source.kernelIdentity);
        assert.deepEqual(reset.runtime, request.runtimeIdentity);
      }
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
      sample.toolbarOverflowUsed = false;
      sample.metrics.pickerInteractionMs = 0;
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
          assert(sample.statusAction.notebooks <= 1, "DIAGNOSTIC_GATE:ambiguous-notebook");
          assert(sample.statusAction.cells <= 1, "DIAGNOSTIC_GATE:ambiguous-measured-cell");
          assert(sample.statusAction.exactActions <= 1, "DIAGNOSTIC_GATE:ambiguous-cell-status-action");
          return (await visible(item)) ? item : false;
        }, "public-cell-status-action");
        const element = await action.elementHandle();
        assert(element, "DIAGNOSTIC_GATE:missing-cell-status-element");
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
            "DIAGNOSTIC_GATE:cell-status-action-state"
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
      const target = await poll(grid, "diagnostic-product-grid", gridDeadline - performance.now());
      if (receipt.purpose === "public-grid-diagnostic") {
        sample.gridObservation = {
          firstSentinelObserved: null,
          laterRow: null,
          navigationAttempted: false,
          rowProgressObserved: null
        };
        const gridElement = target.root;
        assert(gridElement, "DIAGNOSTIC_GATE:missing-grid-element");
        let first;
        try {
          const observedTarget = { frame: target.frame, root: gridElement };
          const initialMetadata = {
            grid: await gridElement.evaluate(gridRows, request.rows),
            status: [],
            statusCounts: [],
            markers: {}
          };
          await captureEntryState("gridInitial", initialMetadata);
          assert(initialMetadata.grid.connected, "DIAGNOSTIC_GATE:captured-grid-detached");
          await gridMetadata(observedTarget, initialMetadata);
          await captureEntryState("gridInitial", initialMetadata);
          assert(
            initialMetadata.grid.minimumObservedRowIndex !== null &&
              initialMetadata.grid.maximumObservedRowIndex !== null,
            "DIAGNOSTIC_GATE:unusable-row-baseline"
          );
          const sourceRetained = () =>
            !notebook.isClosed &&
            vscode.window.tabGroups.all.some((group) => group.tabs.includes(notebookTab)) &&
            notebookTab.input instanceof vscode.TabInputNotebook &&
            notebookTab.input.uri.toString() === notebook.uri.toString() &&
            notebook.cellAt(1) === measuredCellOwner &&
            measuredCellOwner.document.getText() === "comparison_frame" &&
            measuredCellOwner.executionSummary?.executionOrder === measuredExecutionOrder &&
            measuredCellOwner.executionSummary?.success === true;
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
            sample.gridObservation.tab = {
              newTabs: newTabs.length,
              kind,
              active: candidate !== undefined && candidate === vscode.window.tabGroups.activeTabGroup.activeTab,
              sourceRetained: sourceRetained(),
              sourceResource: kind === "custom" && candidate.input.uri.toString() === notebook.uri.toString()
            };
            return candidate;
          };
          const productTab = await poll(
            () => {
              const candidate = readTabOwner();
              const state = sample.gridObservation.tab;
              assert(state.sourceRetained, "DIAGNOSTIC_GATE:source-owner-changed");
              assert(state.newTabs <= 1, "DIAGNOSTIC_GATE:ambiguous-new-product-tab");
              assert(
                !candidate || (["custom", "webview"].includes(state.kind) && !state.sourceResource),
                "DIAGNOSTIC_GATE:unsupported-product-tab"
              );
              return state.active ? candidate : false;
            },
            "diagnostic-product-tab",
            gridDeadline - performance.now()
          );
          const verifyNavigationOwner = async () => {
            const focus = await gridElement.evaluate((root) => ({
              connected: root.isConnected,
              documentFocused: root.ownerDocument.hasFocus(),
              gridFocused: root.contains(root.getRootNode().activeElement)
            }));
            const candidate = readTabOwner();
            const tab = sample.gridObservation.tab;
            sample.gridObservation.focus = focus;
            save();
            assert(
              candidate === productTab &&
                tab.active &&
                tab.sourceRetained &&
                !tab.sourceResource &&
                ["custom", "webview"].includes(tab.kind),
              "DIAGNOSTIC_GATE:product-owner-changed"
            );
            assert(focus.connected && focus.documentFocused && focus.gridFocused, "DIAGNOSTIC_GATE:product-grid-focus");
            assert(performance.now() < gridDeadline, "DIAGNOSTIC_GATE:grid-deadline");
          };
          try {
            first = await poll(
              () => rowCells(gridElement, 0, true),
              "diagnostic-first-c00",
              gridDeadline - performance.now()
            );
            sample.gridObservation.firstSentinelObserved = true;
          } catch (error) {
            sample.gridObservation.firstSentinelObserved = false;
            save();
            throw error;
          }
          checkpoint(`${sampleName}:diagnostic-navigation`);
          let afterEnd;
          let afterHome;
          try {
            assert(
              await first.first.evaluate(
                (cell, grid) =>
                  cell.isConnected &&
                  grid.isConnected &&
                  grid.contains(cell) &&
                  cell.innerText.replaceAll(",", "").trim() === "0",
                gridElement
              ),
              "DIAGNOSTIC_GATE:first-cell-changed"
            );
            assert(performance.now() < gridDeadline, "DIAGNOSTIC_GATE:grid-deadline");
            await first.first.click();
            initialMetadata.grid = await gridElement.evaluate(gridRows, request.rows);
            await captureEntryState("gridInitial", initialMetadata);
            assert(initialMetadata.grid.focused?.c00 === 0, "DIAGNOSTIC_GATE:focused-initial-c00");
            const before = initialMetadata.grid;
            await verifyNavigationOwner();
            sample.gridObservation.navigationAttempted = true;
            await page.keyboard.press("Control+End");
            try {
              await poll(
                async () => {
                  afterEnd = await gridElement.evaluate(gridRows, request.rows);
                  return (
                    afterEnd.connected &&
                    ((before.focused.rowIndex !== null && afterEnd.focused?.rowIndex > before.focused.rowIndex) ||
                      (afterEnd.minimumObservedRowIndex !== null &&
                        afterEnd.maximumObservedRowIndex !== null &&
                        (afterEnd.minimumObservedRowIndex !== before.minimumObservedRowIndex ||
                          afterEnd.maximumObservedRowIndex !== before.maximumObservedRowIndex)))
                  );
                },
                "diagnostic-row-progress",
                gridDeadline - performance.now()
              );
              sample.gridObservation.rowProgressObserved = true;
            } finally {
              if (afterEnd) await captureEntryState("gridAfterEnd", { grid: afterEnd });
            }
            await verifyNavigationOwner();
            await page.keyboard.press("Home");
            try {
              await poll(
                async () => {
                  afterHome = await gridElement.evaluate(gridRows, request.rows);
                  return afterHome.connected && afterHome.focused?.c00 > 0;
                },
                "diagnostic-later-c00",
                gridDeadline - performance.now()
              );
              await verifyNavigationOwner();
              sample.gridObservation.laterRow = afterHome.focused.c00;
            } finally {
              if (afterHome) await captureEntryState("gridAfterHome", { grid: afterHome });
            }
          } catch (error) {
            if (sample.gridObservation.navigationAttempted && sample.gridObservation.rowProgressObserved === null)
              sample.gridObservation.rowProgressObserved = false;
            save();
            throw error;
          }
          sample.metrics.observationsFromFirstInteractionMs = performance.now() - opened;
          throw new Error("GRID_DIAGNOSTIC:observations-complete; comparison not run");
        } finally {
          try {
            await first?.first.dispose();
          } finally {
            await gridElement.dispose();
          }
        }
      }
      const productTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert(
        productTab?.input instanceof vscode.TabInputWebview && productTab !== notebookTab,
        "Pilot gate: exact product webview tab"
      );
      const initial = await poll(() => rowCells(target.root, 0), "first-data-row");
      sample.metrics.firstRowMs = performance.now() - opened;
      sample.fullShapeVerified = true;
      const scrolled = performance.now();
      await initial.first.click();
      await page.keyboard.press("Control+End");
      // Wait for the keyboard navigation's page before moving horizontally on that row.
      const lastIndex = await target.root.getAttribute("aria-rowcount");
      await poll(
        () =>
          visible(target.root.locator(`tr[aria-rowindex="${lastIndex}"],[role="row"][aria-rowindex="${lastIndex}"]`)),
        "last-row-navigation"
      );
      // End reveals the last column too; Home keeps the row and reveals the first column.
      await page.keyboard.press("Home");
      await poll(() => rowCells(target.root, request.rows - 1), "last-row-sentinel");
      sample.metrics.laterRowMs = performance.now() - scrolled;
      sample.laterRowVerified = true;
      sample.metrics.usableGridMs = performance.now() - opened;
      await page.keyboard.press("Control+Home");
      await poll(() => rowCells(target.root, 0), "return-first-row");
      checkpoint(`${sampleName}:profiles`);
      const profiling = performance.now();
      try {
        if (request.product === "ow")
          await click(
            target.frame.getByRole("button", {
              name: "Column profiles and filters",
              exact: true
            }),
            "profile-drawer"
          );
        for (const expected of source.profiles) {
          let profile;
          if (request.product === "ow") {
            const search = target.frame.getByRole("combobox", {
              name: "Column",
              exact: true
            });
            await search.fill(expected.name);
            await click(
              target.frame.getByRole("option", {
                name: new RegExp(`^${expected.name},`)
              }),
              "profile-column"
            );
            profile = target.frame.getByRole("complementary", {
              name: "Column profiles and filters",
              exact: true
            });
            assert(
              await visible(
                profile.getByRole("heading", {
                  name: expected.name,
                  exact: true
                })
              )
            );
          } else {
            const header = target.frame.getByRole("columnheader", {
              name: new RegExp(`^${expected.name}\\b`)
            });
            await header.scrollIntoViewIfNeeded();
            await click(header, "profile-column");
            profile = header;
          }
          await poll(async () => {
            const text = (await profile.innerText()).replace(/\s+/g, " ");
            let distributionReady;
            if (expected.family === "boolean") {
              distributionReady =
                sameMetric(text, "true", expected.trueCount) && sameMetric(text, "false", expected.falseCount);
            } else if (expected.family === "datetime") {
              distributionReady =
                new RegExp(`\\bmin(?:imum)?\\s*[:=]?\\s*${expected.minimumDate}`, "i").test(text) &&
                new RegExp(`\\bmax(?:imum)?\\s*[:=]?\\s*${expected.maximumDate}`, "i").test(text);
            } else {
              const marks =
                request.product === "ow"
                  ? profile
                      .getByRole("region", {
                        name: /^(Distribution|Top values)$/
                      })
                      .locator("svg rect,meter")
                  : profile
                      .locator(
                        '[role="img"][aria-label*="distribution" i], [role="img"][aria-label*="histogram" i], [role="group"][aria-label*="distribution" i]'
                      )
                      .locator("svg rect,svg path,canvas,meter");
              distributionReady = false;
              for (let i = 0; i < Math.min(await marks.count(), 30); i++)
                distributionReady ||= await marks.nth(i).isVisible();
            }
            return (
              distributionReady &&
              text.includes(expected.name) &&
              !/loading|profiling|calculating|pending/i.test(text) &&
              missingReady(text, expected.missing) &&
              sameMetric(text, "distinct|unique", expected.distinct) &&
              (expected.minimum === undefined ||
                (sameMetric(text, "min(?:imum)?", expected.minimum) &&
                  sameMetric(text, "max(?:imum)?", expected.maximum)))
            );
          }, `complete-profile-${expected.name}`);
          const publicText = (await profile.innerText()).replace(/\s+/g, " ");
          const sampling = [];
          const notices = profile.locator('[title*="sampl" i]');
          for (let i = 0; i < Math.min(await notices.count(), 4); i++)
            if (await notices.nth(i).isVisible()) sampling.push((await notices.nth(i).getAttribute("title")) || "");
          const noticeText = [publicText, ...sampling].join(" ");
          const qualifications = [
            ...new Set(
              noticeText.match(
                /distribution based on a sample|sampled(?: numeric| boolean| categorical| datetime)? distribution|(?:based on|using|first|sample(?: of)?) [\d,]+ (?:rows|records)|approximate(?:d|ly)?(?: statistics| values)?/gi
              ) || []
            )
          ].slice(0, 4);
          sample.profileObservations.push({
            column: expected.name,
            family: expected.family,
            validated: [
              "missing",
              "distinct",
              ...(expected.family === "numeric"
                ? ["minimum", "maximum", "plot marks"]
                : expected.family === "boolean"
                  ? ["true", "false"]
                  : expected.family === "datetime"
                    ? ["minimum date", "maximum date"]
                    : ["plot marks"])
            ],
            visibleMetricLabels: [
              "missing",
              "null",
              "NaN",
              "distinct",
              "unique",
              "min",
              "max",
              "mean",
              "median",
              "sum",
              "true",
              "false"
            ].filter((label) => new RegExp(`\\b${label}\\b`, "i").test(publicText)),
            samplingQualifications: qualifications,
            computationScope: "unqualified-public-ui"
          });
          sample.completedProfiles++;
          checkpoint(`${sampleName}:profile-${expected.name}`);
        }
        sample.metrics.profileTraversalMs = performance.now() - profiling;
        sample.metrics.allProfilesMs = performance.now() - opened;
      } catch (error) {
        if (request.mode !== "pilot") throw error;
        sample.profileFailure = {
          stage,
          name: error.name,
          message: owner
            .sanitizeEditorAcceptanceDiagnostic(new Error(error.message), [workspace, request.repo])
            .slice(0, 1000)
        };
        sample.profileComparability = "incomparable";
        sample.metrics.profileAttemptMs = performance.now() - profiling;
        delete sample.metrics.allProfilesMs;
        delete sample.metrics.profileTraversalMs;
        save();
      }
      checkpoint(`${sampleName}:cleaning`);
      if (request.product === "ow") {
        const close = target.frame
          .getByRole("complementary", {
            name: "Column profiles and filters",
            exact: true
          })
          .getByRole("button", { name: "Close panel", exact: true });
        if (await visible(close)) await close.click();
        await poll(
          async () =>
            !(await visible(
              target.frame.getByRole("complementary", { name: "Column profiles and filters", exact: true })
            )),
          "profile-panel-closed"
        );
      }
      if (sample.profileFailure) {
        assert(
          !(await find("dialog", /.*/)) && !(await find("menu", /.*/)),
          "Pilot gate: cannot restore independent cleaning state"
        );
        await poll(grid, "restored-grid-after-profile-failure");
      }
      const modeStart = performance.now();
      const editing =
        request.product === "ow"
          ? target.frame.getByRole("button", {
              name: "Switch to Editing",
              exact: true
            })
          : await find("button", "Editing");
      if (editing && (await visible(editing))) await editing.click();
      if (request.product === "ow")
        await poll(
          () =>
            visible(
              target.frame.getByRole("button", {
                name: "Add step",
                exact: true
              })
            ),
          "editing-ready"
        );
      await poll(grid, "editing-grid");
      sample.metrics.editingModeMs = performance.now() - modeStart;
      const focus = target.root.locator('td[tabindex="0"],[role="gridcell"][tabindex="0"]');
      await click(focus, "grid-focus");
      await page.keyboard.press("Control+Home");
      await poll(() => rowCells(target.root, 0), "cleaning-first-row");
      const changedCell = async (column) => {
        const row = await rowCells(target.root, 0);
        if (!row) return false;
        const values = row.values;
        return column === "c01"
          ? Number(values[1].replaceAll(",", "").trim()) === source.median
          : values[3].trim() === "north";
      };
      for (const [title, column] of [
        ["Fill missing values", "c01"],
        ["Lowercase", "c03"]
      ]) {
        if (request.product === "ow") {
          await click(target.frame.getByRole("button", { name: "Add step", exact: true }), "add-step");
          const dialog = target.frame.getByRole("dialog", {
            name: "Add cleaning step",
            exact: true
          });
          await dialog.getByRole("textbox", { name: "Search operations", exact: true }).fill(title);
          await click(dialog.getByRole("button", { name: new RegExp(`^${title}\\b`) }), "operation");
          await dialog
            .getByRole("combobox", {
              name: column === "c01" ? "Column" : "Text column",
              exact: true
            })
            .selectOption({ label: column });
          if (column === "c01")
            await dialog.getByRole("combobox", { name: "Method", exact: true }).selectOption("median");
          const start = performance.now();
          await click(
            dialog.getByRole("button", {
              name: "Preview changes",
              exact: true
            }),
            "preview"
          );
          const apply = target.frame
            .getByRole("region", { name: "Draft review", exact: true })
            .getByRole("button", { name: "Apply step", exact: true });
          await poll(async () => (await visible(apply)) && (await apply.isEnabled()), "ready-preview");
          const previewMs = performance.now() - start,
            applied = performance.now();
          await apply.click();
          await poll(
            async () => !(await visible(apply)) && (await grid()) && (await changedCell(column)),
            "applied-grid"
          );
          sample.actions.push({
            title,
            previewMs,
            applyMs: performance.now() - applied
          });
        } else {
          // Public names below are pilot gates, not assertions that current selectors are established.
          const name = column === "c01" ? "Fill missing values" : "Convert text to lowercase";
          const operation = await poll(() => find("button", new RegExp(`^${name}$`, "i")), `dw-${name}`);
          await operation.click();
          const selectedColumn = await poll(() => find("combobox", /^Column$/i), "dw-column");
          let start = performance.now();
          await selectedColumn.selectOption({ label: column });
          if (column === "c01") {
            const method = await poll(() => find("combobox", /^(Method|Fill with)$/i), "dw-method");
            start = performance.now();
            await method.selectOption({ label: "Median" });
          }
          const apply = await poll(async () => {
            const control = await find("button", /^Apply$/i);
            return control && (await control.isEnabled()) && (await changedCell(column)) ? control : false;
          }, "dw-preview-ready");
          assert(await apply.isEnabled());
          const previewMs = performance.now() - start,
            applied = performance.now();
          await apply.click();
          await poll(
            async () => (await grid()) && (await changedCell(column)) && !(await visible(apply)),
            "dw-applied-grid"
          );
          sample.actions.push({
            title,
            previewMs,
            applyMs: performance.now() - applied
          });
        }
        checkpoint(`${sampleName}:applied-${column}`);
        save();
      }
      sample.renderedResultVerified = (await changedCell("c01")) && (await changedCell("c03"));
      assert(sample.renderedResultVerified);
      await vscode.env.clipboard.writeText("PUBLIC_COMPARISON_EMPTY");
      if (request.product === "ow") await vscode.commands.executeCommand("openWrangler.copyCode");
      else {
        const exportButton = await poll(() => find("button", /^Export$/i), "dw-export");
        await exportButton.click();
        const copy = await poll(() => find("menuitem", /^Copy code to clipboard$/i), "dw-copy-code");
        await copy.click();
      }
      const code = await poll(async () => {
        const text = await vscode.env.clipboard.readText();
        return text !== "PUBLIC_COMPARISON_EMPTY" && text.length > 0 && text.length < 262144 ? text : false;
      }, "exported-code");
      assert(await notebook.save());
      assert(
        vscode.window.tabGroups.all.some((g) => g.tabs.includes(notebookTab)),
        "Source notebook tab changed"
      );
      assert(await vscode.window.tabGroups.close(productTab, true), "Product tab did not close");
      assert(!notebook.isClosed);
      await vscode.window.showNotebookDocument(notebook);
      await replaceCell(
        2,
        `comparison_code = ${JSON.stringify(code)}\n` +
          "import pandas as pd\npd.testing.assert_frame_equal(comparison_frame, comparison_original, check_exact=True)\n" +
          "comparison_oracle = comparison_helpers['verify_code'](comparison_code, comparison_frame)\n" +
          "print('COMPARISON_VERIFIED:' + json.dumps({'oracle': comparison_oracle, 'kernelIdentity': " +
          "{'nonce': comparison_kernel_identity['nonce'], 'pid': os.getpid()}, 'runtime': comparison_helpers['runtime_identity']()}))"
      );
      const verified = await execute(2, "COMPARISON_VERIFIED:");
      assert.deepEqual(verified.kernelIdentity, source.kernelIdentity);
      assert.deepEqual(verified.runtime, request.runtimeIdentity);
      sample.kernelContinuityVerified = true;
      sample.oracle = verified.oracle;
      assert(sample.oracle.completeFrameEqual && sample.oracle.sourceUnchanged);
      sample.status = sample.profileFailure ? "failed" : "passed";
      checkpoint(`${sampleName}:verified`);
      save();
    }
    receipt.status = receipt.samples.every((sample) => sample.status === "passed") ? "passed" : "failed";
    save();
    assert.equal(receipt.status, "passed", "Pilot contains retained profile contract failures");
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
              .map((element) => ({
                role: element.getAttribute("role")?.slice(0, 32) || "table",
                ariaRowcount: element.getAttribute("aria-rowcount")?.slice(0, 32) ?? null,
                ariaColcount: element.getAttribute("aria-colcount")?.slice(0, 32) ?? null
              }))
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
                  !/^(?:Edit|View|Export|Copy|Apply|Preview|Cancel|Close|Fill|Convert|Median|Lowercase|Column|Method|Search|Back|Open|Operation|Cleaning|Switch|Allow|Deny|Select|More Actions|comparison_(?:frame|original)$|c\d\d$)/i.test(
                    label
                  )
                )
                  return [];
                return [
                  {
                    role: element.getAttribute("role") || element.tagName.toLowerCase(),
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
    receipt.failure = {
      stage,
      name: error.name,
      message: owner
        .sanitizeEditorAcceptanceDiagnostic(new Error(error.message), [
          workspace,
          request.repo,
          request.runtimeIdentity.prefix
        ])
        .slice(0, 1000)
    };
    save();
    throw new Error(`Public comparison failed at ${stage}`);
  } finally {
    await browser?.close().catch(() => {});
  }
};
