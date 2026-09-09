#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedJsonArtifact, writeArtifacts } from "./artifacts.js";
import { resolveProcessLimits, startOwnedProcess } from "./process-profile.js";

const args = process.argv.slice(2);

try {
  await run(args);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function run(commandArgs) {
  const entrypoint = readFlag(commandArgs, "--entrypoint") ?? commandArgs.find((arg) => !arg.startsWith("-"));
  const outputPath = readFlag(commandArgs, "--output");
  const pluginRoot = readFlag(commandArgs, "--plugin-root");
  const includeLifecycle = commandArgs.includes("--include-lifecycle");
  const includeChannelRuntime = commandArgs.includes("--include-channel-runtime");
  const includeProviderCapabilities = commandArgs.includes("--include-provider-capabilities");
  const mockSdk = readMockSdkFlag(commandArgs) ?? true;

  if (!entrypoint) {
    throw new Error("synthetic probes require --entrypoint <path>");
  }
  if (process.env.PLUGIN_INSPECTOR_EXECUTE_ISOLATED !== "1") {
    throw new Error("synthetic probes import plugin code; rerun with PLUGIN_INSPECTOR_EXECUTE_ISOLATED=1 in an isolated workspace");
  }

  const results = await runInChild(entrypoint, {
    mockSdk,
    pluginRoot,
    apiOptions: { retainHandlers: true },
    includeLifecycle,
    includeChannelRuntime,
    includeProviderCapabilities,
  });
  const json = `${JSON.stringify(results, null, 2)}\n`;

  if (outputPath) {
    await writeArtifacts([{ path: outputPath, content: json }]);
  } else {
    process.stdout.write(json);
  }
}

async function runInChild(entrypoint, options) {
  const limits = resolveProcessLimits({}, "PROBE");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "plugin-inspector-synthetic-cli-"));
  const outputPath = path.join(workspace, "result.json");
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Synthetic probes cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const runnerPath = fileURLToPath(new URL("./mock-sdk-capture-runner.js", import.meta.url));
    const { result } = startOwnedProcess({
      command: process.execPath,
      args: [
        "--no-warnings",
        ...(options.mockSdk ? ["--preserve-symlinks"] : []),
        runnerPath,
        JSON.stringify({
          ...options, ...limits, entrypoint, outputPath,
          cwd: process.cwd(), syntheticProbes: true,
        }),
      ],
      ...limits,
      signal: controller.signal,
    }, "PROBE");
    const outcome = await result;
    if (outcome.exitCode !== 0 || outcome.outputTruncated) {
      const message = outcome.cancelled ? "Synthetic probes cancelled"
        : outcome.timedOut ? `Synthetic probes timed out after ${limits.timeoutMs}ms`
        : outcome.outputTruncated ? "Synthetic probe child output exceeded its byte limit"
        : outcome.stderr.trim() || outcome.error?.message || "Synthetic probe child failed";
      throw new Error(message);
    }
    controller.signal.throwIfAborted();
    // The report is separate from plugin stdout, including direct fd writes.
    // Only accept a fresh complete artifact after successful child cleanup.
    const results = await readBoundedJsonArtifact(outputPath, limits.maxOutputBytes);
    controller.signal.throwIfAborted();
    return results;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await rm(workspace, { recursive: true, force: true });
  }
}

function readFlag(commandArgs, name) {
  const index = commandArgs.indexOf(name);
  if (index === -1) {
    return null;
  }
  return commandArgs[index + 1] ?? null;
}

function readMockSdkFlag(commandArgs) {
  const sdk = readFlag(commandArgs, "--sdk");
  if (sdk === "mock") {
    return true;
  }
  if (sdk === "real") {
    return false;
  }
  if (sdk && !["mock", "real"].includes(sdk)) {
    throw new Error("--sdk must be mock or real");
  }
  if (commandArgs.includes("--mock-sdk")) {
    return true;
  }
  if (commandArgs.includes("--real-sdk")) {
    return false;
  }
  return undefined;
}
