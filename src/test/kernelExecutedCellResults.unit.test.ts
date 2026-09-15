import { spawnSync } from "node:child_process";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNotebookCellResultCode,
  buildNotebookCellResultProbeCode,
  fingerprintNotebookCellSource,
  inspectExecutedNotebookCellResult,
  observeExecutedNotebookCellResultKernel,
  parseNotebookCellResult,
  parseNotebookCellResultProbe
} from "../extension/notebooks/kernelBridge";
import {
  bootstrapKernelExecution,
  controllableKernel,
  createKernelBridge,
  deferred,
  emptyKernelExecution,
  mockKernel,
  notebookDocument,
  resetKernelBridgeTestState,
  resultBinding,
  setOpenNotebookDocuments,
  textKernelExecution
} from "./kernelBridge.testFixtures";

afterEach(resetKernelBridgeTestState);

describe("executed notebook cell results", () => {
  const marker = "0123456789abcdef0123456789abcdef";
  const source = "frame.tail()\n";
  const sourceFingerprint = fingerprintNotebookCellSource(source);

  it("builds an Out lookup without rerunning cell source or changing execution history", () => {
    const code = buildNotebookCellResultCode(marker, 17, sourceFingerprint);

    const result = spawnSync(process.env.OPEN_WRANGLER_TEST_PYTHON ?? "python3", ["-I", "-"], {
      encoding: "utf8",
      input: `
import builtins, contextlib, io, json, sys, types
source = object()
inputs = [""] * 17 + [${JSON.stringify(source)}]
history = {17: source}
shell = types.SimpleNamespace(user_ns={"Out": history}, history_manager=types.SimpleNamespace(input_hist_raw=inputs), execution_count=18)
links = []
package = types.ModuleType("openwrangler_runtime")
notebook = types.ModuleType("openwrangler_runtime.notebook")
def link(value, originating_shell):
    assert value is source and originating_shell is shell
    links.append(value)
    return {"protocolVersion": 1, "backend": "polars", "label": "DataFrame", "variableName": "__openwrangler_live_result_0123456789abcdef0123456789abcdef"}
notebook.link_live_result = link
package.notebook = notebook
sys.modules[package.__name__] = package
sys.modules[notebook.__name__] = notebook
sentinels = {name: object() for name in ("__ow_cell_hashlib", "__ow_cell_json", "__ow_cell_notebook", "__ow_cell_shell", "__ow_cell_namespace", "__ow_cell_history", "__ow_cell_history_manager", "__ow_cell_inputs", "__ow_cell_source", "__ow_cell_source_hash", "__ow_cell_result", "__ow_cell_link")}
def wrong_shell():
    raise AssertionError("cell capture ignored the shadowing user get_ipython")
for reason, lookup, seeded in ((None, "global", True), ("missing", "global", True), ("stale", "global", True), ("unsupported", "global", True), (None, "builtin", True), (None, "global", False)):
    builtins.get_ipython = (lambda: shell) if lookup == "builtin" else wrong_shell
    namespace = {**(sentinels if seeded else {}), "__builtins__": builtins}
    if lookup == "global":
        namespace["get_ipython"] = lambda: shell
    original = dict(namespace)
    notebook.link_live_result = link
    history.clear()
    if reason != "missing":
        history[17] = source
    inputs[17] = "changed source" if reason == "stale" else ${JSON.stringify(source)}
    if reason == "unsupported":
        def refuse(value, originating_shell):
            raise ValueError("synthetic unsupported value")
        notebook.link_live_result = refuse
    before_inputs, before_history = list(inputs), dict(history)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(${JSON.stringify(code)}, namespace)
    lines = output.getvalue().splitlines()
    assert lines[0] == "__OPEN_WRANGLER_CELL_RESULT_START_${marker}__"
    assert lines[2] == "__OPEN_WRANGLER_CELL_RESULT_END_${marker}__"
    result = json.loads(lines[1])
    if reason is None:
        assert result == {"ok": True, "protocolVersion": 1, "backend": "polars", "label": "DataFrame", "variableName": "__openwrangler_live_result_0123456789abcdef0123456789abcdef"}
    else:
        assert result == {"ok": False, "protocolVersion": 1, "reason": reason}
    assert namespace.keys() == original.keys() and all(namespace[name] is value for name, value in original.items()), "cell helpers changed user bindings"
    assert inputs == before_inputs and history == before_history and shell.execution_count == 18
assert links == [source, source, source]
`,
      maxBuffer: 128 * 1024,
      timeout: 30_000,
      windowsHide: true
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(() => buildNotebookCellResultCode(marker, 0, sourceFingerprint)).toThrow("positive safe integer");
    expect(() => buildNotebookCellResultCode(marker, 17, "invalid")).toThrow("64 lowercase hexadecimal");
    expect(fingerprintNotebookCellSource("a\r\nb\r")).toBe(fingerprintNotebookCellSource("a\nb\n"));
    expect(fingerprintNotebookCellSource("frame\n\n")).toBe(fingerprintNotebookCellSource("frame"));
  });

  it("builds and parses a history-neutral supported-result probe", () => {
    const code = buildNotebookCellResultProbeCode(marker, 17, sourceFingerprint);
    const marked = (value: unknown) =>
      [
        `__OPEN_WRANGLER_CELL_PROBE_START_${marker}__`,
        JSON.stringify(value),
        `__OPEN_WRANGLER_CELL_PROBE_END_${marker}__`
      ].join("\n");

    expect(code).toContain('__ow_cell_probe_namespace.get(\\"Out\\")');
    expect(code).toContain("__ow_cell_probe_history[17]");
    expect(code).toContain('\\"pandas\\", (\\"DataFrame\\", \\"Series\\")');
    expect(code).not.toContain("run_cell");
    expect(parseNotebookCellResultProbe(marked({ ok: true, protocolVersion: 1, backend: "duckdb" }), marker)).toBe(
      "duckdb"
    );
    expect(
      parseNotebookCellResultProbe(marked({ ok: false, protocolVersion: 1, reason: "unsupported" }), marker)
    ).toBeUndefined();
  });

  it("parses only bounded supported live-result links", () => {
    const marked = (value: unknown) =>
      [
        `__OPEN_WRANGLER_CELL_RESULT_START_${marker}__`,
        JSON.stringify(value),
        `__OPEN_WRANGLER_CELL_RESULT_END_${marker}__`
      ].join("\n");

    expect(
      parseNotebookCellResult(
        marked({
          ok: true,
          protocolVersion: 1,
          backend: "polars",
          label: "DataFrame",
          variableName: "__openwrangler_live_result_0123456789abcdef0123456789abcdef"
        }),
        marker
      )
    ).toEqual({
      backend: "polars",
      label: "DataFrame",
      variableName: "__openwrangler_live_result_0123456789abcdef0123456789abcdef"
    });
    expect(() => parseNotebookCellResult(marked({ ok: false, protocolVersion: 1, reason: "missing" }), marker)).toThrow(
      "no longer available"
    );
    expect(() => parseNotebookCellResult(marked({ ok: false, protocolVersion: 1, reason: "stale" }), marker)).toThrow(
      "does not belong to the currently selected kernel"
    );
    expect(() =>
      parseNotebookCellResult(marked({ ok: false, protocolVersion: 1, reason: "unsupported" }), marker)
    ).toThrow("did not return a supported");
    expect(() =>
      parseNotebookCellResult(
        marked({ ok: true, protocolVersion: 1, backend: "r", label: "frame", variableName: "frame" }),
        marker
      )
    ).toThrow("malformed live notebook result link");
  });

  it("captures the exact execution result on the selected notebook kernel", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    let resultLookups = 0;
    const controller = controllableKernel((code) => {
      if (!code.includes("__OPEN_WRANGLER_CELL_RESULT_START_")) return bootstrapKernelExecution(code);
      resultLookups += 1;
      const resultMarker = code.match(/__OPEN_WRANGLER_CELL_RESULT_START_([a-f0-9]{32})__/)?.[1];
      if (!resultMarker) throw new Error("Expected a cell-result marker.");
      return textKernelExecution(
        [
          `__OPEN_WRANGLER_CELL_RESULT_START_${resultMarker}__`,
          JSON.stringify({
            ok: true,
            protocolVersion: 1,
            backend: "pandas",
            label: "DataFrame",
            variableName: "__openwrangler_live_result_0123456789abcdef0123456789abcdef"
          }),
          `__OPEN_WRANGLER_CELL_RESULT_END_${resultMarker}__`
        ].join("\n")
      );
    });
    const getExtension = mockKernel(controller.kernel);
    const bridge = createKernelBridge(document);

    await expect(
      bridge.captureExecutedCellResult(7, sourceFingerprint, resultBinding(controller.kernel, "pandas"))
    ).resolves.toEqual({
      backend: "pandas",
      label: "DataFrame",
      variableName: "__openwrangler_live_result_0123456789abcdef0123456789abcdef"
    });

    expect(resultLookups).toBe(1);
    expect(getExtension).toHaveBeenCalledOnce();
    expect(controller.executionTokens()).toHaveLength(2);
  });

  it("inspects a supported Out result and binds it to the exact selected kernel", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const controller = controllableKernel((code) => {
      const resultMarker = code.match(/__OPEN_WRANGLER_CELL_PROBE_START_([a-f0-9]{32})__/)?.[1];
      if (!resultMarker) throw new Error("Expected a result-probe marker.");
      return textKernelExecution(
        [
          `__OPEN_WRANGLER_CELL_PROBE_START_${resultMarker}__`,
          JSON.stringify({ ok: true, protocolVersion: 1, backend: "polars" }),
          `__OPEN_WRANGLER_CELL_PROBE_END_${resultMarker}__`
        ].join("\n")
      );
    });
    mockKernel(controller.kernel);

    const observed = await observeExecutedNotebookCellResultKernel(document);
    if (!observed) throw new Error("Expected an observed kernel binding.");
    const binding = await inspectExecutedNotebookCellResult(document, 7, sourceFingerprint, observed);

    expect(binding?.backend).toBe("polars");
    expect(binding?.kernel).toBe(controller.kernel);
    expect(binding?.isValid()).toBe(true);
    expect(controller.executionTokens()).toHaveLength(1);
    expect(controller.statusListenerCount()).toBe(1);
    controller.setStatus("restarting");
    expect(binding?.isValid()).toBe(false);
    binding?.dispose();
    expect(controller.statusListenerCount()).toBe(0);
  });

  it("rejects a replacement selected after the producing kernel was observed", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const original = controllableKernel(() => emptyKernelExecution());
    const replacement = controllableKernel(() => emptyKernelExecution());
    let selected = original.kernel;
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel: async () => selected } })
    } as never);
    const observed = await observeExecutedNotebookCellResultKernel(document);
    if (!observed) throw new Error("Expected the original kernel to be observed.");
    selected = replacement.kernel;

    await expect(inspectExecutedNotebookCellResult(document, 7, sourceFingerprint, observed)).resolves.toBeUndefined();

    expect(original.executionTokens()).toHaveLength(0);
    expect(replacement.executionTokens()).toHaveLength(0);
    expect(original.statusListenerCount()).toBe(0);
  });

  it("disposes kernel anchors when observation or inspection setup rejects", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const controller = controllableKernel(() => emptyKernelExecution());
    const getKernel = vi
      .fn()
      .mockResolvedValueOnce(controller.kernel)
      .mockRejectedValueOnce(new Error("selection failed"));
    const extensionSpy = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel } })
    } as never);

    await expect(observeExecutedNotebookCellResultKernel(document)).resolves.toBeUndefined();
    expect(controller.statusListenerCount()).toBe(0);

    extensionSpy.mockReturnValue({
      activate: async () => ({ kernels: { getKernel: async () => controller.kernel } })
    } as never);
    const observed = await observeExecutedNotebookCellResultKernel(document);
    if (!observed) throw new Error("Expected a kernel observation.");
    extensionSpy.mockReturnValue({
      activate: async () => {
        throw new Error("activation failed");
      }
    } as never);

    await expect(inspectExecutedNotebookCellResult(document, 7, sourceFingerprint, observed)).rejects.toThrow(
      "activation failed"
    );
    expect(controller.statusListenerCount()).toBe(0);
  });

  it("detaches and disposes a notebook result probe without interrupting the kernel", async () => {
    vi.useFakeTimers();
    const release = deferred<void>();
    try {
      const document = notebookDocument();
      setOpenNotebookDocuments(document);
      const controller = controllableKernel(async function* () {
        await release.promise;
        yield* [];
      });
      mockKernel(controller.kernel);
      const observed = await observeExecutedNotebookCellResultKernel(document);
      if (!observed) throw new Error("Expected a kernel observation.");

      const inspection = inspectExecutedNotebookCellResult(document, 7, sourceFingerprint, observed);
      await vi.waitFor(() => expect(controller.executionTokens()).toHaveLength(1));
      const timedOut = expect(inspection).rejects.toThrow("timed out after 10000 ms");
      await vi.advanceTimersByTimeAsync(10_000);

      await timedOut;
      expect(controller.executionTokens()[0]?.isCancellationRequested).toBe(false);
      expect(observed.isGenerationValid()).toBe(false);
      expect(controller.statusListenerCount()).toBe(0);

      release.resolve();
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      expect(controller.executionTokens()[0]?.isCancellationRequested).toBe(false);
      expect(controller.statusListenerCount()).toBe(0);
    } finally {
      release.resolve();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it("never captures matching Out history from a replacement kernel", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const original = controllableKernel(() => emptyKernelExecution());
    const replacement = controllableKernel(() => emptyKernelExecution());
    mockKernel(replacement.kernel);

    await expect(
      createKernelBridge(document).captureExecutedCellResult(
        7,
        sourceFingerprint,
        resultBinding(original.kernel, "pandas")
      )
    ).rejects.toThrow("kernel changed after this cell result was produced");

    expect(original.executionTokens()).toHaveLength(0);
    expect(replacement.executionTokens()).toHaveLength(0);
  });
});
