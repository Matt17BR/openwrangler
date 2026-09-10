import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { remoteJupyterFixtureDefinition, waitForJupyterStatus } from "./remote-jupyter-acceptance.mjs";

const baseUrl = "http://127.0.0.1:8888";
const token = "owr_test-authentication-must-not-appear-in-errors";
const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

function kernelspec(definition) {
  return {
    kernelspecs: {
      [definition.kernelName]: {
        name: definition.kernelName,
        spec: {
          argv:
            definition.language === "python"
              ? ["/python", "-Xfrozen_modules=off", "-m", "ipykernel_launcher", "-f", "{connection_file}"]
              : ["/R", "--slave", "-e", "IRkernel::main()", "--args", "{connection_file}"],
          display_name: definition.kernelLabel,
          language: definition.language
        }
      }
    }
  };
}

function readiness({ kind = "python", respond, timeoutMs = 60_000 } = {}) {
  const definition = remoteJupyterFixtureDefinition(kind);
  const requests = [];
  const sleeps = [];
  const progress = [];
  let time = 0;
  const options = {
    async fetchImpl(url, options) {
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.deepEqual(options.headers, { accept: "application/json", authorization: `token ${token}` });
      assert.equal(options.signal.aborted, false);
      const endpoint = url.slice(baseUrl.length);
      assert.ok(["/api/status", "/api/kernelspecs"].includes(endpoint));
      requests.push({ endpoint, signal: options.signal });
      const response = await respond?.(endpoint, requests.length, definition);
      return response ?? json(endpoint === "/api/status" ? { connections: 0, kernels: 0 } : kernelspec(definition));
    },
    now: () => time,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
    timeoutMs,
    progressIntervalMs: 200,
    onProgress: () => progress.push(time)
  };
  return { run: () => waitForJupyterStatus(baseUrl, token, definition, options), requests, sleeps, progress };
}

test("readiness accepts both fixed kernelspecs with one authenticated request per endpoint", async () => {
  for (const kind of ["python", "r"]) {
    const fixture = readiness({ kind });
    await fixture.run();
    assert.deepEqual(
      fixture.requests.map(({ endpoint }) => endpoint),
      ["/api/status", "/api/kernelspecs"]
    );
    assert.deepEqual(fixture.sleeps, []);
    assert.ok(fixture.requests.every(({ signal }) => signal.aborted));
  }
});

test("authentication refusal at either endpoint fails before another readiness attempt", async () => {
  for (const endpoint of ["/api/status", "/api/kernelspecs"]) {
    for (const status of [401, 403]) {
      const fixture = readiness({
        respond: (path) => (path === endpoint ? new Response(token, { status }) : undefined)
      });
      await assert.rejects(fixture.run(), { message: "Remote Jupyter authentication was rejected." });
      assert.equal(fixture.requests.length, endpoint === "/api/status" ? 1 : 2);
      assert.deepEqual(fixture.sleeps, []);
      assert.ok(fixture.requests.every(({ signal }) => signal.aborted));
    }
  }
});

test("completed malformed or invalid JSON responses are refused without polling", async () => {
  const cases = [
    { response: () => new Response(token), message: /did not return JSON/u },
    { response: () => new Response(token, { headers: { "content-type": "application/json" } }), message: /malformed/u },
    { response: () => json({ connections: -1, kernels: 0 }), message: /status was invalid/u },
    { response: () => json({ connections: 0, kernels: 0.5 }), message: /status was invalid/u },
    { response: () => json(null), message: /status was invalid/u },
    {
      response: () => new Response("", { headers: { "content-type": "application/json", "content-length": "16385" } }),
      message: /fixed response bound/u
    },
    {
      response: () => new Response(" ".repeat(16385), { headers: { "content-type": "application/json" } }),
      message: /fixed response bound/u
    },
    {
      response: () => new Response(null, { headers: { "content-type": "application/json" } }),
      message: /bounded response stream/u
    }
  ];
  for (const { response, message } of cases) {
    const fixture = readiness({ respond: response });
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, message);
      assert.equal(error.message.includes(token), false);
      return true;
    });
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.sleeps, []);
    assert.ok(fixture.requests[0].signal.aborted);
  }
});

test("completed missing or mismatching fixed kernelspecs are refused for both languages", async () => {
  for (const kind of ["python", "r"]) {
    for (const mismatch of ["missing", "argv", "label", "language"]) {
      const fixture = readiness({
        kind,
        respond: (endpoint, _attempt, definition) => {
          if (endpoint !== "/api/kernelspecs") return;
          const report = kernelspec(definition);
          const candidate = report.kernelspecs[definition.kernelName];
          if (mismatch === "missing") delete report.kernelspecs[definition.kernelName];
          if (mismatch === "argv") candidate.spec.argv[0] = "relative-interpreter";
          if (mismatch === "label") candidate.spec.display_name = token;
          if (mismatch === "language") candidate.spec.language = "unknown";
          return json(report);
        }
      });
      await assert.rejects(fixture.run(), { message: "Remote Jupyter kernelspec did not match its fixed fixture." });
      assert.equal(fixture.requests.length, 2);
      assert.deepEqual(fixture.sleeps, []);
      assert.ok(fixture.requests.every(({ signal }) => signal.aborted));
    }
  }
});

test("transport, interrupted body, abort and server startup failures remain retryable", async () => {
  for (const endpoint of ["/api/status", "/api/kernelspecs"]) {
    for (const failure of ["transport", "body", "abort", "503"]) {
      let interrupted = false;
      const fixture = readiness({
        respond: (path) => {
          if (path !== endpoint || interrupted) return;
          interrupted = true;
          if (failure === "transport") throw new TypeError(token);
          if (failure === "abort") throw new DOMException(token, "AbortError");
          if (failure === "503") return new Response(token, { status: 503 });
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError(token));
              }
            }),
            {
              headers: { "content-type": "application/json" }
            }
          );
        }
      });
      await fixture.run();
      assert.equal(fixture.requests.length, endpoint === "/api/status" ? 3 : 4);
      assert.deepEqual(fixture.sleeps, [100]);
      assert.ok(fixture.requests.every(({ signal }) => signal.aborted));
    }
  }
});

test("persistent transient failures retain the fixed readiness deadline and progress", async () => {
  const fixture = readiness({ respond: () => new Response(token, { status: 503 }), timeoutMs: 250 });
  await assert.rejects(fixture.run(), {
    message: "Remote Jupyter Server did not become ready within its fixed deadline."
  });
  assert.equal(fixture.requests.length, 4);
  assert.deepEqual(fixture.sleeps, [100, 100, 50]);
  assert.deepEqual(fixture.progress, [200]);
  assert.ok(fixture.requests.every(({ signal }) => signal.aborted));
});

test(
  "native fetch releases an unread startup response without server teardown",
  { timeout: 5_000 },
  async (context) => {
    const definition = remoteJupyterFixtureDefinition("python");
    let requests = 0;
    let rejectedResponseClosed;
    const closed = new Promise((resolve) => {
      rejectedResponseClosed = resolve;
    });
    const server = createServer((request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503);
        response.write("starting");
        response.once("close", rejectedResponseClosed);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(request.url === "/api/status" ? { connections: 0, kernels: 0 } : kernelspec(definition))
      );
    });
    context.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    let time = 0;
    await waitForJupyterStatus(`http://127.0.0.1:${server.address().port}`, token, definition, {
      fetchImpl: fetch,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
      timeoutMs: 1_000,
      progressIntervalMs: 1_000,
      onProgress: () => {}
    });
    await closed;
    assert.equal(requests, 3);
  }
);
