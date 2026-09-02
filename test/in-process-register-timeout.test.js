import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { captureEntrypoint } from "../src/inspector.js";

const execFileAsync = promisify(execFile);

async function writeHangingRegisterPlugin(dir) {
  const entrypoint = path.join(dir, "index.mjs");
  await writeFile(
    entrypoint,
    [
      "export default {",
      "  async register() {",
      "    await new Promise(() => {});",
      "  }",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  return "index.mjs";
}

test("default in-process capture timeout is a documented 30s budget", async () => {
  const { defaultCaptureTimeoutMs, resolveCaptureTimeoutMs } = await import("../src/inspector.js");
  assert.equal(defaultCaptureTimeoutMs, 30_000);
  assert.equal(resolveCaptureTimeoutMs({}), 30_000);
  assert.equal(resolveCaptureTimeoutMs({ timeoutMs: 50 }), 50);
  assert.equal(resolveCaptureTimeoutMs({ env: { PLUGIN_INSPECTOR_CAPTURE_TIMEOUT_MS: "75" } }), 75);
});

test("in-process capture fails closed when register() never settles", { timeout: 2500 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-inspector-in-process-hang-"));
  const entrypoint = await writeHangingRegisterPlugin(dir);

  await assert.rejects(
    () =>
      captureEntrypoint(entrypoint, {
        cwd: dir,
        pluginRoot: dir,
        mockSdk: false,
        timeoutMs: 200,
      }),
    (error) => {
      assert.equal(error.failureClass, "capture-timeout");
      assert.match(error.message, /timed out/i);
      return true;
    },
  );
});

test("in-process capture still records a register() that settles", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-inspector-in-process-ok-"));
  const entrypoint = path.join(dir, "index.mjs");
  await writeFile(
    entrypoint,
    [
      "export default {",
      "  register(api) {",
      "    api.registerTool({ name: 'fixture_tool', run() {} });",
      "  }",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await captureEntrypoint(entrypoint, {
    cwd: dir,
    pluginRoot: dir,
    mockSdk: false,
    timeoutMs: 1000,
  });

  assert.equal(result.status, "captured");
  assert.deepEqual(
    result.captured.map((item) => `${item.kind}:${item.name}`),
    ["registration:registerTool"],
  );
});

test(
  "plugin-inspector capture --real-sdk times out a register() that never settles",
  { timeout: 4000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-inspector-in-process-cli-hang-"));
    const entrypoint = await writeHangingRegisterPlugin(dir);
    const cliPath = path.resolve("src/cli.js");

    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [cliPath, "capture", entrypoint, "--allow-execute", "--real-sdk"], {
          cwd: dir,
          env: {
            ...process.env,
            PLUGIN_INSPECTOR_CAPTURE_TIMEOUT_MS: "200",
          },
          timeout: 3000,
        }),
      (error) => {
        assert.match(String(error.stderr ?? error.message), /timed out|capture-timeout/i);
        return true;
      },
    );
  },
);
