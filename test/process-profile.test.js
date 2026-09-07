import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildImportLoopProfile } from "../src/import-loop-profile.js";
import { runProfiledProcess } from "../src/process-profile.js";
import { buildRuntimeProfile } from "../src/runtime-profile.js";

function processExists(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("default profile timeout and output caps are documented", async () => {
  const { defaultProfileMaxOutputBytes, defaultProfileTimeoutMs } = await import("../src/process-profile.js");
  assert.equal(defaultProfileTimeoutMs, 30_000);
  assert.equal(defaultProfileMaxOutputBytes, 1024 * 1024);
});

test("profiled process that never exits is killed when the timeout expires", { timeout: 2500 }, async () => {
  const result = await runProfiledProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 200,
    pollMs: 25,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.wallMs >= 150);
  assert.ok(result.wallMs < 1500);
  assert.equal(processExists(result.pid), false);
});

test("profiled process caps stdout and stderr and still returns", { timeout: 2500 }, async () => {
  const result = await runProfiledProcess({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('x'.repeat(20000) + '\\nstdout-tail\\n'); process.stderr.write('y'.repeat(20000) + '\\nstderr-tail\\n');",
    ],
    timeoutMs: 2000,
    maxOutputBytes: 64,
  });

  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.byteLength(result.stdoutPreview) <= 64);
  assert.ok(Buffer.byteLength(result.stderrPreview) <= 64);
});

test(
  "buildRuntimeProfile times out a command that never exits",
  { timeout: 4000 },
  async () => {
    const profile = await buildRuntimeProfile({
      commands: [
        {
          id: "hang",
          label: "Hang",
          category: "baseline",
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
      ],
      generatedAt: "test",
      runs: 1,
      timeoutMs: 200,
    });

    const hang = profile.commands.find((command) => command.id === "hang");
    assert.ok(hang);
    assert.ok(hang.exitCodes.some((code) => code !== 0));
    assert.ok(hang.samples.every((sample) => sample.timedOut === true));
    assert.ok(hang.wallMs.max < 2000);
  },
);

test(
  "buildImportLoopProfile times out a capture subprocess that never exits",
  { timeout: 4000 },
  async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "plugin-inspector-import-loop-hang-"));
    const hangScript = path.join(rootDir, "hang.mjs");
    const entrypoint = path.join(rootDir, "fixture.mjs");
    await writeFile(hangScript, "setInterval(() => {}, 1000);\n", "utf8");
    await writeFile(
      entrypoint,
      [
        "export default {",
        "  register(api) {",
        "    api.registerTool({ name: 'fixture_tool', inputSchema: { type: 'object' }, run() {} });",
        "  }",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const profile = await buildImportLoopProfile({
      baseline: false,
      captureCommand: () => ({
        command: process.execPath,
        args: [hangScript],
      }),
      entrypoint,
      rootDir,
      runs: 1,
      timeoutMs: 200,
    });

    assert.ok(profile.summary.failCount > 0);
    assert.ok(profile.samples.every((sample) => sample.timedOut === true));
    assert.ok(profile.samples.every((sample) => sample.wallMs < 2000));
  },
);
