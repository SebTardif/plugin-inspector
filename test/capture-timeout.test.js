import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { captureEntrypoint, classifyMockSdkCaptureError } from "../src/inspector.js";

const execFileAsync = promisify(execFile);

async function writeHangingRegisterPlugin(dir) {
  const entrypoint = path.join(dir, "index.mjs");
  await writeFile(
    entrypoint,
    [
      "export default {",
      "  async register() {",
      "    await new Promise(() => {",
      "      setInterval(() => {}, 1000);",
      "    });",
      "  }",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  return "index.mjs";
}

test("default mock-SDK capture timeout is a documented 30s budget", async () => {
  const { defaultCaptureTimeoutMs } = await import("../src/inspector.js");
  assert.equal(defaultCaptureTimeoutMs, 30_000);
});

test("classifyMockSdkCaptureError treats a killed child as a capture timeout", () => {
  const error = Object.assign(new Error("Command failed: node mock-sdk-capture-runner.js"), {
    killed: true,
    signal: "SIGTERM",
    code: null,
    stdout: "",
    stderr: "",
  });

  const classified = classifyMockSdkCaptureError(error);

  assert.equal(classified.failureClass, "capture-timeout");
  assert.match(classified.message, /timed out/i);
});

test(
  "mock capture escalates to SIGKILL when register() ignores SIGTERM",
  { timeout: 2500 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-inspector-capture-sigterm-"));
    const entrypoint = path.join(dir, "index.mjs");
    await writeFile(
      entrypoint,
      [
        "export default {",
        "  async register() {",
        "    process.on('SIGTERM', () => {});",
        "    await new Promise(() => {",
        "      setInterval(() => {}, 1000);",
        "    });",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await assert.rejects(
      () =>
        captureEntrypoint(entrypoint, {
          cwd: dir,
          pluginRoot: dir,
          mockSdk: true,
          timeoutMs: 200,
          killGraceMs: 50,
        }),
      (error) => {
        assert.equal(error.failureClass, "capture-timeout");
        assert.match(error.message, /timed out/i);
        return true;
      },
    );
  },
);

test(
  "mock capture fails closed when register() never settles",
  { timeout: 2500 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-inspector-capture-hang-"));
    const entrypoint = await writeHangingRegisterPlugin(dir);

    await assert.rejects(
      () =>
        captureEntrypoint(entrypoint, {
          cwd: dir,
          pluginRoot: dir,
          mockSdk: true,
          timeoutMs: 200,
        }),
      (error) => {
        assert.equal(error.failureClass, "capture-timeout");
        assert.match(error.message, /timed out/i);
        return true;
      },
    );
  },
);

test(
  "plugin-inspector capture --allow-execute prints complete JSON on the CLI pipe",
  { timeout: 4000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-inspector-capture-cli-ok-"));
    const entrypoint = path.join(dir, "index.mjs");
    await writeFile(
      entrypoint,
      [
        "export default {",
        "  register() {",
        "    return undefined;",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const cliPath = path.resolve("src/cli.js");

    const { stdout } = await execFileAsync(
      process.execPath,
      [cliPath, "capture", "index.mjs", "--allow-execute", "--mock-sdk"],
      { cwd: dir },
    );

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "captured");
    assert.equal(parsed.mockSdk, true);
    assert.ok(Array.isArray(parsed.captured));
  },
);

test(
  "plugin-inspector capture --allow-execute times out a register() that never settles",
  { timeout: 4000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-inspector-capture-cli-hang-"));
    const entrypoint = await writeHangingRegisterPlugin(dir);
    const cliPath = path.resolve("src/cli.js");

    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [cliPath, "capture", entrypoint, "--allow-execute", "--mock-sdk"], {
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
