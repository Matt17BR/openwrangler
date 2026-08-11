import { constants as fsConstants } from "node:fs";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import { R_KERNEL_MAX_REQUEST_BYTES } from "../extension/r/rKernelProtocol";
import { RInteractiveSessionTransport } from "../extension/r/rInteractiveSessionTransport";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("interactive R session transport", () => {
  it("serializes requests through a mode-0700 mailbox and removes it on disposal", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-unit-"));
    let active = 0;
    let maximumActive = 0;
    const requestKinds: string[] = [];
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection: async (code) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          const { requestPath, responsePath } = mailboxPaths(code);
          expect((await stat(dirname(dirname(requestPath)))).mode & 0o777).toBe(0o700);
          const requestHandle = await open(
            requestPath,
            fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)
          );
          let request: { requestId: string; kind: string };
          try {
            const requestMetadata = await requestHandle.stat();
            expect(requestMetadata.isFile()).toBe(true);
            expect(requestMetadata.mode & 0o777).toBe(0o600);
            expect(requestMetadata.size).toBeGreaterThan(0);
            expect(requestMetadata.size).toBeLessThanOrEqual(R_KERNEL_MAX_REQUEST_BYTES);
            request = JSON.parse(await requestHandle.readFile("utf8")) as { requestId: string; kind: string };
          } finally {
            await requestHandle.close();
          }
          requestKinds.push(request.kind);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
          await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
        } finally {
          active -= 1;
        }
      }
    });
    try {
      await Promise.all([transport.discoverVariables(), transport.discoverVariables()]);
      expect(maximumActive).toBe(1);
      expect((await readdir(temporaryParent)).length).toBe(1);
    } finally {
      await transport.dispose();
      expect(requestKinds).toEqual([
        "discoverInteractiveVariables",
        "discoverInteractiveVariables",
        "teardownInteractiveRuntime"
      ]);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("reads bounded dataframe descriptors published through its private mailbox", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-change-unit-"));
    let notificationPath: string | undefined;
    let notificationRequestId: string | undefined;
    let firstDispatch = true;
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection: async (code) => {
        notificationPath ??= mailboxNotificationPath(code);
        notificationRequestId ??= mailboxNotificationRequestId(code);
        const { requestPath, responsePath } = mailboxPaths(code);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string; kind: string };
        if (firstDispatch) {
          firstDispatch = false;
          await writeFile(notificationPath!, discoveryNotification(notificationRequestId!, "too_early"), {
            encoding: "utf8"
          });
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
        }
        await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
      }
    });
    const received: Array<{
      variables: readonly { name: string; backend: "r"; dataframeFlavor: "r.data.frame" }[];
      truncated: boolean;
    }> = [];
    let resolveChange!: (value: (typeof received)[number]) => void;
    const changed = new Promise<{
      variables: readonly { name: string; backend: "r"; dataframeFlavor: "r.data.frame" }[];
      truncated: boolean;
    }>((resolveChanged) => {
      resolveChange = resolveChanged;
    });
    const subscription = transport.onDidChangeVariables((value) => {
      received.push(value as (typeof received)[number]);
      resolveChange(value as (typeof received)[number]);
    });
    try {
      await transport.discoverVariables();
      expect(received).toEqual([]);
      expect(notificationPath).toBeDefined();
      expect(notificationRequestId).toBeDefined();
      await writeFile(notificationPath!, discoveryNotification(notificationRequestId!, "orders"), { encoding: "utf8" });
      await expect(changed).resolves.toEqual({
        variables: [{ name: "orders", backend: "r", dataframeFlavor: "r.data.frame" }],
        truncated: false
      });
    } finally {
      subscription.dispose();
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("retries the notification replacement window and coalesces rapid updates", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-replace-unit-"));
    let notificationPath: string | undefined;
    let notificationRequestId: string | undefined;
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection: async (code) => {
        notificationPath ??= mailboxNotificationPath(code);
        notificationRequestId ??= mailboxNotificationRequestId(code);
        const { requestPath, responsePath } = mailboxPaths(code);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string; kind: string };
        await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
      }
    });
    const received: string[] = [];
    const subscription = transport.onDidChangeVariables((value) => {
      const name = value.variables[0]?.name;
      if (name) received.push(name);
    });
    try {
      await transport.discoverVariables();
      const target = notificationPath!;
      const first = `${target}.first`;
      await writeFile(first, discoveryNotification(notificationRequestId!, "first"), { encoding: "utf8" });
      await unlink(target);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      await rename(first, target);

      const latest = `${target}.latest`;
      await writeFile(latest, discoveryNotification(notificationRequestId!, "latest"), { encoding: "utf8" });
      await unlink(target);
      await rename(latest, target);

      await vi.waitFor(() => expect(received.at(-1)).toBe("latest"));
      expect(received).not.toContain("first");
    } finally {
      subscription.dispose();
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("does not tear down an R terminal when the first public dispatch fails", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-failed-dispatch-unit-"));
    const runSelection = vi.fn(async () => {
      throw new Error("R command dispatch failed");
    });
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection
    });
    try {
      await expect(transport.discoverVariables()).rejects.toThrow("R command dispatch failed");
    } finally {
      await transport.dispose();
      expect(runSelection).toHaveBeenCalledTimes(1);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("evaluates a chunk and discovers its frames in one correlated terminal request", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-evaluate-unit-"));
    const requests: Array<{ requestId: string; kind: string; code?: string }> = [];
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection: async (dispatchCode) => {
        const { requestPath, responsePath } = mailboxPaths(dispatchCode);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as {
          requestId: string;
          kind: string;
          code?: string;
        };
        requests.push(request);
        await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
      }
    });
    try {
      await expect(transport.evaluateAndDiscoverVariables("orders <- data.frame(id = 1:3)\n")).resolves.toEqual({
        variables: [],
        truncated: false
      });
      expect(requests[0]).toMatchObject({
        kind: "evaluateAndDiscoverInteractiveVariables",
        code: "orders <- data.frame(id = 1:3)\n"
      });
      expect(requests.filter((request) => request.kind === "discoverInteractiveVariables")).toEqual([]);
    } finally {
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("rejects an oversized chunk before dispatching into R", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-evaluate-size-unit-"));
    const runSelection = vi.fn();
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection
    });
    try {
      await expect(transport.evaluateAndDiscoverVariables("x".repeat(1_024 * 1_024 + 1))).rejects.toThrow("1 MiB");
      expect(runSelection).not.toHaveBeenCalled();
    } finally {
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("detaches after dispatch and waits for the original R response", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-detach-unit-"));
    const token = new vscode.CancellationTokenSource();
    let release!: () => void;
    let dispatched!: () => void;
    const didDispatch = new Promise<void>((resolveDispatch) => {
      dispatched = resolveDispatch;
    });
    const allowResponse = new Promise<void>((resolveResponse) => {
      release = resolveResponse;
    });
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection: async (code) => {
        const { requestPath, responsePath } = mailboxPaths(code);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string; kind: string };
        dispatched();
        await allowResponse;
        await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
      }
    });
    try {
      const pending = transport.discoverVariables({ cancellation: token.token });
      await didDispatch;
      token.cancel();
      const detached = await pending.catch((error: unknown) => error);
      expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
      expect(detached).toMatchObject({ reason: "cancellation", dispatched: true });
      release();
      await (detached as DetachedBridgeRequestError).settlement;
    } finally {
      token.dispose();
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("cancels during request preparation without dispatching into R", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-prepare-cancel-unit-"));
    const token = new vscode.CancellationTokenSource();
    const terminalSend = vi.fn();
    const terminal = { name: "R Interactive", sendText: terminalSend } as unknown as vscode.Terminal;
    const windowRecord = vscode.window as unknown as Record<string, unknown>;
    const terminalDescriptors = new Map(
      ["terminals", "activeTerminal", "onDidCloseTerminal"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(windowRecord, key)
      ])
    );
    Object.defineProperties(windowRecord, {
      terminals: { configurable: true, get: () => [terminal] },
      activeTerminal: { configurable: true, get: () => terminal },
      onDidCloseTerminal: {
        configurable: true,
        value: () => ({ dispose: () => undefined })
      }
    });
    let releaseActivation!: () => void;
    let activationStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      activationStarted = resolveStarted;
    });
    const blocked = new Promise<void>((resolveBlocked) => {
      releaseActivation = resolveBlocked;
    });
    const extensionSpy = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => {
        activationStarted();
        await blocked;
      }
    } as unknown as vscode.Extension<unknown>);
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      terminal
    });
    try {
      const pending = transport.discoverVariables({ cancellation: token.token });
      await started;
      token.cancel();
      const cancelled = await pending.catch((error: unknown) => error);
      expect(cancelled).not.toBeInstanceOf(DetachedBridgeRequestError);
      releaseActivation();
      await transport.dispose();
      expect(terminalSend).not.toHaveBeenCalled();
    } finally {
      token.dispose();
      await transport.dispose();
      extensionSpy.mockRestore();
      for (const [key, descriptor] of terminalDescriptors) {
        if (descriptor) Object.defineProperty(windowRecord, key, descriptor);
        else Reflect.deleteProperty(windowRecord, key);
      }
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("pins dispatch to the exact official R terminal without revealing it", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-terminal-unit-"));
    let responseWrite = Promise.resolve();
    const submittedCode: string[] = [];
    const firstSendText = vi.fn((code: string) => {
      submittedCode.push(code);
      responseWrite = responseWrite.then(async () => {
        const { requestPath, responsePath } = mailboxPaths(code);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string; kind: string };
        await writeMockAttachment(code, 2_718);
        await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
      });
    });
    const secondSendText = vi.fn();
    const firstTerminal = {
      name: "R Interactive",
      processId: Promise.resolve(2_718),
      sendText: firstSendText
    } as unknown as vscode.Terminal;
    const secondTerminal = {
      name: "R",
      processId: Promise.resolve(3_141),
      sendText: secondSendText
    } as unknown as vscode.Terminal;
    const windowRecord = vscode.window as unknown as Record<string, unknown>;
    const terminalDescriptors = new Map(
      ["terminals", "activeTerminal", "onDidCloseTerminal"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(windowRecord, key)
      ])
    );
    let activeTerminal = firstTerminal;
    let includeFirstTerminal = true;
    Object.defineProperties(windowRecord, {
      terminals: {
        configurable: true,
        get: () => (includeFirstTerminal ? [firstTerminal, secondTerminal] : [secondTerminal])
      },
      activeTerminal: { configurable: true, get: () => activeTerminal },
      onDidCloseTerminal: {
        configurable: true,
        value: () => ({ dispose: () => undefined })
      }
    });
    const activate = vi.fn(async () => {
      activeTerminal = secondTerminal;
    });
    const extension = { activate } as unknown as vscode.Extension<unknown>;
    const extensionSpy = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue(extension);
    const commandSpy = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      terminal: firstTerminal
    });
    let invalidations = 0;
    const invalidation = transport.onDidInvalidateKernel(() => {
      invalidations += 1;
    });
    try {
      await transport.discoverVariables();
      expect(activate).toHaveBeenCalledOnce();
      expect(commandSpy).not.toHaveBeenCalled();
      expect(firstSendText).toHaveBeenCalledTimes(1);
      expect(secondSendText).not.toHaveBeenCalled();
      expect(submittedCode[0]).toContain("sys.source(");

      activeTerminal = secondTerminal;
      await transport.discoverVariables();
      expect(firstSendText).toHaveBeenCalledTimes(2);
      expect(secondSendText).not.toHaveBeenCalled();
      expect(submittedCode[1]).not.toContain("sys.source(");
      expect(submittedCode[1]!.length).toBeLessThan(submittedCode[0]!.length);

      includeFirstTerminal = false;
      await expect(transport.discoverVariables()).rejects.toThrow("The active R terminal changed");
      expect(invalidations).toBe(1);
    } finally {
      invalidation.dispose();
      await expect(transport.dispose()).rejects.toThrow("active R terminal changed");
      await responseWrite;
      includeFirstTerminal = true;
      activeTerminal = firstTerminal;
      commandSpy.mockRestore();
      extensionSpy.mockRestore();
      for (const [key, descriptor] of terminalDescriptors) {
        if (descriptor) Object.defineProperty(windowRecord, key, descriptor);
        else Reflect.deleteProperty(windowRecord, key);
      }
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("fails instead of guessing when more than one inactive R terminal exists", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-ambiguous-terminal-unit-"));
    const firstTerminal = { name: "R", sendText: vi.fn() } as unknown as vscode.Terminal;
    const secondTerminal = { name: "R Interactive", sendText: vi.fn() } as unknown as vscode.Terminal;
    const windowRecord = vscode.window as unknown as Record<string, unknown>;
    const terminalDescriptors = replaceWindowTerminals(windowRecord, [firstTerminal, secondTerminal], undefined);
    const extensionSpy = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => undefined
    } as unknown as vscode.Extension<unknown>);
    const commandSpy = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent
    });
    try {
      await expect(transport.discoverVariables()).rejects.toThrow("Select the R terminal that owns the dataframe");
      expect(commandSpy).not.toHaveBeenCalled();
      expect(firstTerminal.sendText).not.toHaveBeenCalled();
      expect(secondTerminal.sendText).not.toHaveBeenCalled();
    } finally {
      await transport.dispose();
      commandSpy.mockRestore();
      extensionSpy.mockRestore();
      restoreDescriptors(windowRecord, terminalDescriptors);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("binds discovery to the exact active R terminal when active-only mode is requested", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-active-only-unit-"));
    const firstSendText = vi.fn();
    let responseWrite = Promise.resolve();
    const secondSendText = vi.fn((code: string) => {
      responseWrite = responseWrite.then(async () => {
        const { requestPath, responsePath } = mailboxPaths(code);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string; kind: string };
        await writeMockAttachment(code, 3_141);
        await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
      });
    });
    const firstTerminal = {
      name: "R",
      processId: Promise.resolve(2_718),
      sendText: firstSendText
    } as unknown as vscode.Terminal;
    const secondTerminal = {
      name: "R Interactive",
      processId: Promise.resolve(3_141),
      sendText: secondSendText
    } as unknown as vscode.Terminal;
    const windowRecord = vscode.window as unknown as Record<string, unknown>;
    const terminalDescriptors = replaceWindowTerminals(windowRecord, [firstTerminal, secondTerminal], secondTerminal);
    const extensionSpy = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => undefined
    } as unknown as vscode.Extension<unknown>);
    const commandSpy = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      terminalMode: "active"
    });
    try {
      await expect(transport.discoverVariables()).resolves.toEqual({ variables: [], truncated: false });
      expect(firstSendText).not.toHaveBeenCalled();
      expect(secondSendText).toHaveBeenCalledTimes(1);
      expect(commandSpy).not.toHaveBeenCalled();
    } finally {
      await transport.dispose();
      await responseWrite;
      commandSpy.mockRestore();
      extensionSpy.mockRestore();
      restoreDescriptors(windowRecord, terminalDescriptors);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("does not fall back to or create an R terminal in active-only mode", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-active-only-missing-unit-"));
    const terminal = { name: "R", sendText: vi.fn() } as unknown as vscode.Terminal;
    const windowRecord = vscode.window as unknown as Record<string, unknown>;
    const terminalDescriptors = replaceWindowTerminals(windowRecord, [terminal], undefined);
    const extensionSpy = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => undefined
    } as unknown as vscode.Extension<unknown>);
    const commandSpy = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      terminalMode: "active"
    });
    try {
      await expect(transport.discoverVariables()).rejects.toThrow(
        "Select an active R terminal before refreshing Open Wrangler dataframes"
      );
      expect(terminal.sendText).not.toHaveBeenCalled();
      expect(commandSpy).not.toHaveBeenCalled();
    } finally {
      await transport.dispose();
      commandSpy.mockRestore();
      extensionSpy.mockRestore();
      restoreDescriptors(windowRecord, terminalDescriptors);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("starts one official R terminal for active-or-create discovery", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-create-terminal-unit-"));
    const requestKinds: string[] = [];
    let responseWrite = Promise.resolve();
    const sendText = vi.fn((code: string) => {
      responseWrite = responseWrite.then(async () => {
        const { requestPath, responsePath } = mailboxPaths(code);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string; kind: string };
        requestKinds.push(request.kind);
        await writeMockAttachment(code, 2_718);
        await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
      });
    });
    const createdTerminal = {
      name: "R Interactive",
      processId: Promise.resolve(2_718),
      sendText
    } as unknown as vscode.Terminal;
    let terminals: readonly vscode.Terminal[] = [];
    let activeTerminal: vscode.Terminal | undefined;
    const windowRecord = vscode.window as unknown as Record<string, unknown>;
    const terminalDescriptors = new Map(
      ["terminals", "activeTerminal", "onDidCloseTerminal"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(windowRecord, key)
      ])
    );
    Object.defineProperties(windowRecord, {
      terminals: { configurable: true, get: () => terminals },
      activeTerminal: { configurable: true, get: () => activeTerminal },
      onDidCloseTerminal: { configurable: true, value: () => ({ dispose: () => undefined }) }
    });
    const activate = vi.fn(async () => undefined);
    const extensionSpy = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate
    } as unknown as vscode.Extension<unknown>);
    const commandSpy = vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (command, ...args) => {
      expect(command).toBe("r.createRTerm");
      expect(args).toEqual([true]);
      terminals = [createdTerminal];
      activeTerminal = createdTerminal;
      return undefined;
    });
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent
    });
    try {
      await expect(transport.discoverVariables()).resolves.toEqual({ variables: [], truncated: false });
      expect(activate).toHaveBeenCalledOnce();
      expect(commandSpy).toHaveBeenCalledOnce();
      expect(sendText).toHaveBeenCalledOnce();
    } finally {
      await transport.dispose();
      await responseWrite;
      commandSpy.mockRestore();
      extensionSpy.mockRestore();
      restoreDescriptors(windowRecord, terminalDescriptors);
      expect(requestKinds).toEqual(["discoverInteractiveVariables", "teardownInteractiveRuntime"]);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("returns a bounded disposal diagnostic but finishes exact cleanup after a hung dispatch settles", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-deferred-dispose-unit-"));
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolveBlocked) => {
      release = resolveBlocked;
    });
    const dispatched = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    const requestKinds: string[] = [];
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      disposalSettlementMs: 20,
      runSelection: async (code) => {
        const { requestPath, responsePath } = mailboxPaths(code);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string; kind: string };
        requestKinds.push(request.kind);
        if (request.kind === "discoverInteractiveVariables") {
          started();
          await blocked;
        }
        await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
      }
    });
    const discovery = transport.discoverVariables();
    await dispatched;
    await expect(transport.dispose()).rejects.toThrow("will finish cleanup when that exact request returns");
    expect(await readdir(temporaryParent)).toHaveLength(1);

    release();
    await expect(discovery).resolves.toEqual({ variables: [], truncated: false });
    await vi.waitFor(async () => expect(await readdir(temporaryParent)).toEqual([]));
    expect(requestKinds).toEqual(["discoverInteractiveVariables", "teardownInteractiveRuntime"]);
    await rm(temporaryParent, { recursive: true, force: true });
  });

  it("returns an authoritative response before reporting response-artifact cleanup failure on disposal", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-live-cleanup-failure-unit-"));
    let failResponseRemoval = true;
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      removeFile: async (filePath) => {
        if (failResponseRemoval && filePath.includes("/responses/")) {
          failResponseRemoval = false;
          throw new Error("simulated response unlink failure");
        }
        await unlink(filePath);
      },
      runSelection: async (code) => {
        const { requestPath, responsePath } = mailboxPaths(code);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string; kind: string };
        await writeFile(responsePath, interactiveResponse(request), { flag: "wx", mode: 0o600 });
      }
    });
    await expect(transport.discoverVariables()).resolves.toEqual({ variables: [], truncated: false });
    await expect(transport.dispose()).rejects.toThrow("private interactive R response artifact");
    expect(await readdir(temporaryParent)).toEqual([]);
    await rm(temporaryParent, { recursive: true, force: true });
  });

  it.each(["malformed", "wrong-kind"] as const)(
    "invalidates a live session after an indeterminate %s mutation response",
    async (failure) => {
      const temporaryParent = await mkdtemp(resolve(tmpdir(), `ow-r-live-${failure}-mutation-unit-`));
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
        temporaryParent,
        runSelection: async (code) => {
          const { requestPath, responsePath } = mailboxPaths(code);
          const request = JSON.parse(await readFile(requestPath, "utf8")) as {
            requestId: string;
            kind: string;
            payload?: { sessionId?: string };
          };
          let response: string;
          if (request.kind === "openSession") response = openResponse(request.requestId, sessionId);
          else if (request.kind === "previewStep") {
            response = failure === "malformed" ? "{" : openResponse(request.requestId, sessionId, false);
          } else response = interactiveResponse(request);
          await writeFile(responsePath, response, { flag: "wx", mode: 0o600 });
        }
      });
      let invalidations = 0;
      const subscription = transport.onDidInvalidateKernel(() => {
        invalidations += 1;
      });
      try {
        const opened = await transport.open("orders", pageWindow(), { requestedSessionId: sessionId });
        await expect(
          transport.previewStep(
            sessionId,
            0,
            {
              id: "lower-value",
              kind: "lowerText",
              params: { column: { id: "r:c:0", name: "value" } }
            },
            pageWindow(),
            opened.page.schema
          )
        ).rejects.toThrow();
        expect(invalidations).toBe(1);
        expect(transport.isSessionMapped(sessionId)).toBe(false);
      } finally {
        subscription.dispose();
        await transport.dispose();
        expect(await readdir(temporaryParent)).toEqual([]);
        await rm(temporaryParent, { recursive: true, force: true });
      }
    }
  );
});

function replaceWindowTerminals(
  windowRecord: Record<string, unknown>,
  terminals: readonly vscode.Terminal[],
  activeTerminal: vscode.Terminal | undefined
): Map<string, PropertyDescriptor | undefined> {
  const descriptors = new Map(
    ["terminals", "activeTerminal", "onDidCloseTerminal"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(windowRecord, key)
    ])
  );
  Object.defineProperties(windowRecord, {
    terminals: { configurable: true, get: () => terminals },
    activeTerminal: { configurable: true, get: () => activeTerminal },
    onDidCloseTerminal: { configurable: true, value: () => ({ dispose: () => undefined }) }
  });
  return descriptors;
}

function restoreDescriptors(
  target: Record<string, unknown>,
  descriptors: ReadonlyMap<string, PropertyDescriptor | undefined>
): void {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
}

function mailboxPaths(code: string): { requestPath: string; responsePath: string } {
  const encodedResponse = /\.__ow_response_path <- ("(?:\\.|[^"\\])*")/u.exec(code)?.[1];
  if (!encodedResponse) throw new Error("The R dispatcher did not contain its correlated response path.");
  const responsePath = JSON.parse(encodedResponse) as string;
  const requestPath = resolve(dirname(dirname(responsePath)), "requests", basename(responsePath));
  return { requestPath, responsePath };
}

function mailboxNotificationPath(code: string): string {
  const encodedPath = /notification_path = ("(?:\\.|[^"\\])*")/u.exec(code)?.[1];
  if (!encodedPath) throw new Error("The R dispatcher did not contain its workspace notification path.");
  return JSON.parse(encodedPath) as string;
}

function mailboxNotificationRequestId(code: string): string {
  const encoded = /notification_request_id = ("(?:\\.|[^"\\])*")/u.exec(code)?.[1];
  if (!encoded) throw new Error("The R dispatcher did not contain its workspace notification identity.");
  return JSON.parse(encoded) as string;
}

function discoveryNotification(requestId: string, variableName: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId,
    status: "ready",
    truncated: false,
    variables: [{ name: variableName, dataframeFlavor: "r.data.frame" }]
  });
}

async function writeMockAttachment(code: string, processId: number): Promise<void> {
  const encodedPath = /attachment_path = ("(?:\\.|[^"\\])*")/u.exec(code)?.[1];
  if (!encodedPath) return;
  const encodedNonce = /attachment_nonce = ("(?:\\.|[^"\\])*")/u.exec(code)?.[1];
  const encodedBundleId = /bundle_id = ("[a-f0-9]{16}")/u.exec(code)?.[1];
  if (!encodedNonce || !encodedBundleId)
    throw new Error("The R dispatcher did not contain its attachment receipt fields.");
  await writeFile(
    JSON.parse(encodedPath) as string,
    JSON.stringify({
      protocolVersion: 1,
      nonce: JSON.parse(encodedNonce) as string,
      bundleId: JSON.parse(encodedBundleId) as string,
      processId
    }),
    { encoding: "utf8" }
  );
}

function interactiveResponse(request: { requestId: string; kind: string }): string {
  if (request.kind === "teardownInteractiveRuntime") {
    return JSON.stringify({ protocolVersion: 1, requestId: request.requestId, status: "closed" });
  }
  if (request.kind === "closeSession") {
    const sessionId = (request as { payload?: { sessionId?: string } }).payload?.sessionId;
    return JSON.stringify({ transportVersion: 9, requestId: request.requestId, kind: "closed", sessionId });
  }
  return JSON.stringify({
    protocolVersion: 1,
    requestId: request.requestId,
    status: "ready",
    truncated: false,
    variables: []
  });
}

function pageWindow() {
  return { rowOffset: 0, rowLimit: 20, columnOffset: 0, columnLimit: 20, view: { filters: [], sorts: [] } };
}

function openResponse(requestId: string, sessionId: string, includeFormats = true): string {
  return JSON.stringify({
    transportVersion: 9,
    requestId,
    kind: "page",
    sessionId,
    ...(includeFormats ? { exportFormats: ["csv"] } : {}),
    page: {
      contractVersion: 5,
      dataframeFlavor: "r.data.frame",
      shape: { rows: 1, columns: 1 },
      frameSemantics: { classes: ["data.frame"], rowNames: "positional", keyColumnIds: [] },
      schema: [
        {
          id: "r:c:0",
          name: "value",
          position: 0,
          rawType: "character",
          type: "string",
          nullable: false,
          semantics: { kind: "character", storageMode: "character", classes: ["character"] }
        }
      ],
      page: {
        offset: 0,
        limit: 20,
        totalRows: 1,
        columnOffset: 0,
        columnLimit: 1,
        columnIds: ["r:c:0"],
        rows: [
          {
            id: "r:r:0",
            rowNumber: 0,
            values: [{ kind: "string", raw: "A", display: "A", isNull: false, isNaN: false }]
          }
        ]
      }
    }
  });
}
