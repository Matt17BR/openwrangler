// One hosted discovery, public VS Code/notebook/DOM interfaces only. No product test API.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const vscode = require("vscode");

exports.run = async () => {
  assert.notEqual(process.env.OPEN_WRANGLER_EXTENSION_TESTS, "1");
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const request = JSON.parse(fs.readFileSync(path.join(workspace, "request.json"), "utf8"));
  const { chromium } = createRequire(path.join(request.repo, "package.json"))("playwright-core");
  const owner = await import(pathToFileURL(path.join(request.repo, "scripts/editor-acceptance.mjs")).href);
  const receipt = { purpose: "public-ui-control-discovery", product: "dw", input: "polars", rows: 100000, controls: [], status: "pending" };
  let browser, page, screenshotCaptured = false, stage = "connect";
  const save = () => {
    const json = JSON.stringify(receipt, null, 2) + "\n";
    assert(Buffer.byteLength(json) <= 32768);
    fs.writeFileSync(path.join(request.out, "discovery.json"), json, { mode: 0o600 });
  };
  const checkpoint = (next) => {
    stage = next;
    receipt.stage = next;
    save();
    owner.writeAcceptanceProgress(process.env.OPEN_WRANGLER_TEST_PROGRESS,
      owner.createAcceptanceProgressEnvelope(process.env.OPEN_WRANGLER_TEST_RUN_ID, process.env.OPEN_WRANGLER_TEST_PHASE, next));
  };
  const poll = async (predicate, label, ms = 15000) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const result = await predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`DISCOVERY_GATE:${label}`);
  };
  const visible = async (locator) => await locator.count() === 1 && await locator.isVisible();
  const click = async (locator, label) => {
    await poll(() => visible(locator), label);
    assert(await locator.isEnabled(), `DISCOVERY_GATE:disabled-${label}`);
    await locator.click({ timeout: 5000 });
  };
  const frames = () => {
    const all = browser.contexts().flatMap((context) => context.pages()).flatMap((p) => p.frames());
    assert(all.length <= 64, "DISCOVERY_GATE:frame-bound");
    return all;
  };
  const capture = async () => {
    // Only visible public controls on this synthetic notebook/product. No DOM dump or storage.
    const scopes = frames();
    const controls = [];
    for (const frame of scopes) {
      controls.push(...await frame.evaluate(() => {
        const roots = [document];
        for (let i = 0; i < roots.length; i++) {
          if (roots.length > 128) throw new Error("Control shadow-root bound");
          for (const element of roots[i].querySelectorAll("*")) if (element.shadowRoot) roots.push(element.shadowRoot);
        }
        return roots.flatMap((root) => Array.from(root.querySelectorAll(
        'button,[role="button"],[role="menuitem"],[role="treeitem"],[role="textbox"],[role="combobox"],[role="checkbox"],select,[role="option"],input'
      )).filter((e) => e.checkVisibility({ checkVisibilityCSS: true })).flatMap((e) => {
        const operationSearch = e.getAttribute("placeholder") === "Search for operations...";
        const label = (operationSearch ? "Search for operations..." : e.getAttribute("aria-label") || e.getAttribute("title") ||
          (e.tagName === "INPUT" ? e.getAttribute("placeholder") : e.textContent) || "").replace(/\s+/g, " ").trim();
        if (!/^(?:View data$|Select|Jupyter|Local Kernel|Python 3\.12 \(Public comparison\)|comparison_frame|Convert|Lowercase|Column|Choose|Apply|Export|Copy|Cancel|Discard|Preview|Editing$|Viewing$|Search|Operation|Cleaning|Find and replace|Format|Formulas|Numeric|Schema|Sort and filter|Custom operation|Group by|New column by example|Load data from variable|New operation|text$|id$)/i.test(label)) return [];
        return [{ role: e.getAttribute("role") || e.tagName.toLowerCase(), tag: e.tagName.toLowerCase(), label: label.slice(0, 160),
          disabled: e.matches(":disabled") || e.getAttribute("aria-disabled") === "true",
          ...(operationSearch && ["", "Lowercase"].includes(e.value) ? { value: e.value } : {}) }];
      }).slice(0, 32)).slice(0, 32);
      }).then((items) => items.map((item) => ({ ...item, surface: frame === page.mainFrame() ? "workbench" : "webview" }))));
    }
    receipt.controls.push({ stage, controls: controls.slice(0, 32) });
    assert(Buffer.byteLength(JSON.stringify(receipt.controls)) <= 16384, "DISCOVERY_GATE:control-byte-bound");
    save();
  };
  const screenshot = async () => {
    const bytes = await page.screenshot({ timeout: 5000 });
    assert(bytes.length <= 2 * 1024 * 1024);
    fs.writeFileSync(path.join(request.out, "synthetic-page.png"), bytes, { flag: "wx", mode: 0o600 });
    screenshotCaptured = true;
  };
  const rendered = async (expected) => {
    const matches = [];
    for (const frame of frames()) {
      const roots = frame.locator('[role="grid"]');
      const count = await roots.count();
      assert(count <= 8, "DISCOVERY_GATE:grid-bound");
      for (let i = 0; i < count; i++) {
        const root = roots.nth(i);
        const cells = await root.evaluate((grid) => {
          if (!grid.checkVisibility({ checkVisibilityCSS: true }) || grid.getAttribute("aria-busy") === "true") return null;
          const columns = Number(grid.getAttribute("aria-colcount"));
          if (![2, 3].includes(columns)) return null;
          const offset = columns === 3 ? 2 : 1;
          return Array.from(grid.querySelectorAll('tr,[role="row"]')).slice(0, 100).flatMap((row) => {
            const cell = (n) => row.querySelector(`td[aria-colindex="${n}"],[role="gridcell"][aria-colindex="${n}"]`);
            const id = cell(offset), text = cell(offset + 1);
            if (!id || !text || !id.checkVisibility({ checkVisibilityCSS: true }) || !text.checkVisibility({ checkVisibilityCSS: true })) return [];
            return [[id.innerText.trim(), text.innerText.trim()]];
          }).filter(([id]) => ["0", "1", "2", "3"].includes(id));
        });
        if (cells && JSON.stringify(cells) === JSON.stringify(expected)) matches.push(frame);
      }
    }
    assert(matches.length <= 1, "DISCOVERY_GATE:ambiguous-grid");
    return matches[0] || false;
  };
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OPEN_WRANGLER_EDITOR_CDP_PORT}`);
    page = await poll(() => browser.contexts().flatMap((c) => c.pages()).find((p) => /workbench/i.test(p.url())), "workbench");
    page.setDefaultTimeout(5000);
    await vscode.extensions.getExtension("ms-toolsai.jupyter").activate();
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(path.join(workspace, "comparison.ipynb")));
    const editor = await vscode.window.showNotebookDocument(notebook);
    checkpoint("kernel-selection");
    let selectionError;
    const selecting = vscode.commands.executeCommand("notebook.selectKernel", { notebookEditor: editor }).catch(() => { selectionError = true; });
    const traversed = new Set();
    await poll(async () => {
      assert(!selectionError, "DISCOVERY_GATE:kernel-selection");
      const picker = page.locator(".quick-input-widget:visible");
      if (!(await visible(picker))) return false;
      const kernel = picker.getByRole("option", { name: /Python 3\.12 \(Public comparison\)/ });
      if (await visible(kernel)) { await kernel.click(); return true; }
      // The retained pilot's successful public Jupyter kernel-picker hierarchy only.
      for (const name of ["Select Another Kernel...", "Jupyter Kernel...", "Jupyter", "Local Kernel Specs..."]) {
        const route = picker.getByRole("option", { name, exact: true });
        if (!traversed.has(name) && await visible(route)) { traversed.add(name); await route.click(); break; }
      }
      return false;
    }, "kernel", 30000);
    await selecting;
    const execute = async (index, marker) => {
      assert.equal(vscode.window.activeNotebookEditor?.notebook, notebook);
      const cell = notebook.cellAt(index), before = cell.executionSummary?.executionOrder;
      const execution = vscode.commands.executeCommand("notebook.cell.execute", { document: notebook.uri, ranges: [{ start: index, end: index + 1 }] });
      const result = await poll(() => {
        const summary = cell.executionSummary;
        if (!summary?.executionOrder || summary.executionOrder === before || summary.success === undefined) return false;
        assert.equal(summary.success, true, "DISCOVERY_GATE:synthetic-cell");
        const text = cell.outputs.flatMap((o) => o.items).filter((i) => ["text/plain", "application/vnd.code.notebook.stdout"].includes(i.mime)).map((i) => Buffer.from(i.data).toString("utf8")).join("\n");
        const line = text.split(/\r?\n/).find((s) => s.startsWith(marker));
        return line ? JSON.parse(line.slice(marker.length)) : false;
      }, "synthetic-cell", 30000);
      await execution;
      return result;
    };
    checkpoint("fixture");
    receipt.source = await execute(0, "DISCOVERY_READY:");
    assert.deepEqual(receipt.source.shape, [100000, 2]);
    assert.match(receipt.source.digest, /^[a-f0-9]{64}$/);
    const consent = async () => {
      const dialog = page.getByRole("dialog").filter({ hasText: "Do you want to grant Kernel access to the extension Data Wrangler (ms-toolsai.datawrangler)?" });
      if (!(await visible(dialog))) return;
      assert((await dialog.innerText()).includes("This allows the extension to execute code against Jupyter Kernels."));
      const started = performance.now();
      await dialog.getByRole("button", { name: "Allow", exact: true }).click({ timeout: 5000 });
      await poll(async () => !(await visible(dialog)), "kernel-consent");
      receipt.consentMs = (receipt.consentMs || 0) + performance.now() - started;
    };
    checkpoint("open");
    const openStarted = performance.now();
    // No dataframe rendering or user-side conversion before this public Open boundary.
    const toolbar = page.locator(".notebook-editor:visible .notebook-toolbar-container:visible,.notebookOverlay:visible .notebook-toolbar-container:visible");
    await click(toolbar.getByRole("button", { name: "View data", exact: true }), "view-data");
    const picker = page.locator(".quick-input-widget:visible");
    const variable = picker.getByRole("option").filter({ has: page.locator(".label-name").filter({ hasText: /^comparison_frame$/ }) });
    await poll(async () => { await consent(); return visible(variable); }, "exact-variable");
    await click(variable, "exact-variable");
    const original = [["0", "North"], ["1", "SOUTH"], ["2", "East"], ["3", "WEST"]];
    const gridFrame = await poll(async () => { await consent(); return rendered(original); }, "initial-grid");
    let operationsFrame, search;
    await poll(async () => {
      const matches = [];
      for (const frame of frames()) {
        const input = frame.locator('input[placeholder^="Search for operations"]:visible');
        assert(await input.count() <= 1, "DISCOVERY_GATE:ambiguous-operation-search");
        if (await visible(input)) matches.push({ frame, input });
      }
      assert(matches.length <= 1, "DISCOVERY_GATE:ambiguous-operation-search");
      if (!matches.length) return false;
      operationsFrame = matches[0].frame;
      search = matches[0].input;
      return true;
    }, "editing-search");
    receipt.openToEditingMs = performance.now() - openStarted;
    checkpoint("editing-controls");
    await capture();
    checkpoint("operation-search");
    await search.fill("Lowercase");
    const operation = operationsFrame.getByText(/^(?:Convert text to )?Lowercase$/i);
    await poll(() => visible(operation), "lowercase-result");
    await capture();
    await click(operation, "lowercase");
    checkpoint("target-columns");
    const targetColumns = operationsFrame.getByText("Select one or more target columns...", { exact: true });
    await click(targetColumns, "target-columns");
    const textOption = operationsFrame.getByText("text", { exact: true });
    await poll(() => visible(textOption), "text-option");
    await capture();
    await click(textOption, "text-option");
    await page.keyboard.press("Escape");
    const apply = operationsFrame.getByRole("button", { name: "Apply", exact: true });
    await poll(async () => await visible(apply) && await apply.isEnabled(), "apply-ready");
    checkpoint("apply-ready");
    await capture();
    await click(apply, "apply");
    const lower = original.map(([id, text]) => [id, text.toLowerCase()]);
    const copyCode = gridFrame.getByRole("menuitem", { name: "Copy all code", exact: true });
    await poll(async () => (await rendered(lower)) === gridFrame && await visible(copyCode) && await copyCode.isEnabled(), "applied-values");
    checkpoint("code-export");
    await capture();
    await vscode.env.clipboard.writeText("DISCOVERY_EMPTY_CLIPBOARD");
    await click(copyCode, "copy-all-code");
    const code = await poll(async () => {
      const value = await vscode.env.clipboard.readText();
      assert(Buffer.byteLength(value) <= 65536, "DISCOVERY_GATE:export-code-bound");
      return value !== "DISCOVERY_EMPTY_CLIPBOARD" && Buffer.byteLength(value) > 20 ? value : false;
    }, "export-code");
    fs.writeFileSync(path.join(request.out, "export.py"), code, { flag: "wx", mode: 0o600 });
    receipt.export = { bytes: Buffer.byteLength(code), sha256: createHash("sha256").update(code).digest("hex"), replay: "pending review of actual public export" };
    await screenshot();
    receipt.pending = ["complete cleaned-output replay", "paired timings"];
    await vscode.window.showNotebookDocument(notebook);
    checkpoint("source-check");
    receipt.sourceAfter = await execute(1, "DISCOVERY_UNCHANGED:");
    assert.deepEqual(receipt.sourceAfter, { digest: receipt.source.digest, shape: [100000, 2] });
    receipt.status = "code-exported";
  } catch (error) {
    receipt.status = "blocked";
    receipt.failure = { stage, category: /^DISCOVERY_GATE:[a-z-]+$/.test(error.message) ? error.message : "public-control-or-assertion" };
    throw new Error(`Public discovery stopped at ${stage}; see bounded discovery.json`);
  } finally {
    if (page) {
      try { await capture(); } catch { receipt.captureUnavailable = true; }
      try { if (!screenshotCaptured) await screenshot(); } catch { receipt.screenshotUnavailable = true; }
    }
    save();
    await browser?.close();
  }
};
