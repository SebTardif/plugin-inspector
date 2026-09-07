import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export const defaultProfileTimeoutMs = 30_000;
export const defaultProfileMaxOutputBytes = 1024 * 1024;

export async function runProfiledProcess(options) {
  const start = performance.now();
  const heapStartMb = heapUsedMb();
  let firstRssKb = 0;
  let peakRssKb = 0;
  let peakCpuPercent = 0;
  let statSampleCount = 0;
  let rssSampleCount = 0;
  let cpuSampleCount = 0;
  const cpuSamples = [];
  let pollInFlight = false;
  const pendingStats = new Set();
  const timeoutMs = resolveProfileTimeoutMs(options);
  const maxOutputBytes = resolveProfileMaxOutputBytes(options);
  let timedOut = false;
  let poll;
  let timeoutId;
  let forceKillId;

  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  const stdout = createCappedCollector(maxOutputBytes);
  const stderr = createCappedCollector(maxOutputBytes);
  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr?.on("data", (chunk) => stderr.push(chunk));

  const recordStats = (stats) => {
    if (stats.rssAvailable || stats.cpuAvailable) {
      statSampleCount += 1;
    }
    if (stats.rssAvailable) {
      rssSampleCount += 1;
    }
    if (stats.cpuAvailable) {
      cpuSampleCount += 1;
    }
    if (stats.rssAvailable && stats.rssKb > 0 && firstRssKb === 0) {
      firstRssKb = stats.rssKb;
    }
    if (stats.rssAvailable) {
      peakRssKb = Math.max(peakRssKb, stats.rssKb);
    }
    if (stats.cpuAvailable) {
      peakCpuPercent = Math.max(peakCpuPercent, stats.cpuPercent);
      cpuSamples.push(stats.cpuPercent);
    }
  };

  const sampleStats = () => {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;
    const pending = readProcessStats(child.pid)
      .then(recordStats)
      .finally(() => {
        pollInFlight = false;
        pendingStats.delete(pending);
      });
    pendingStats.add(pending);
  };

  const stopWatching = () => {
    if (poll !== undefined) {
      clearInterval(poll);
      poll = undefined;
    }
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (forceKillId !== undefined) {
      clearTimeout(forceKillId);
      forceKillId = undefined;
    }
  };

  sampleStats();
  poll = setInterval(sampleStats, options.pollMs ?? 25);

  try {
    const exitCode = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn) => {
        if (settled) {
          return;
        }
        settled = true;
        stopWatching();
        fn();
      };
      child.on("error", (error) => finish(() => reject(error)));
      child.on("exit", (code) => finish(() => resolve(code ?? 1)));
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKillId = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, options.killGraceMs ?? 1000);
        }, timeoutMs);
      }
    });
    await Promise.allSettled([...pendingStats]);

    const finalStats = await readProcessStats(child.pid);
    recordStats(finalStats);

    const wallMs = Math.round(performance.now() - start);
    const averageCpuPercent =
      cpuSamples.length > 0
        ? cpuSamples.reduce((sum, value) => sum + value, 0) / cpuSamples.length
        : 0;
    const cpuPercentForEstimate =
      options.roundAverageCpuPercent === true
        ? Math.round(averageCpuPercent * 10) / 10
        : averageCpuPercent;

    return {
      wallMs,
      peakRssMb: Math.round((peakRssKb / 1024) * 10) / 10,
      rssDeltaMb: Math.round(((peakRssKb - firstRssKb) / 1024) * 10) / 10,
      peakCpuPercent: Math.round(peakCpuPercent * 10) / 10,
      cpuMsEstimate: Math.round((wallMs * cpuPercentForEstimate) / 100),
      harnessHeapDeltaMb: Math.round((heapUsedMb() - heapStartMb) * 10) / 10,
      statSampleCount,
      rssSampleCount,
      cpuSampleCount,
      exitCode,
      timedOut,
      pid: child.pid,
      stdoutPreview: previewLines(stdout.chunks),
      stderrPreview: previewLines(stderr.chunks),
    };
  } finally {
    stopWatching();
  }
}

export function resolveProfileTimeoutMs(options = {}) {
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0) {
    return options.timeoutMs;
  }
  const fromEnv = Number.parseInt(String(options.env?.PLUGIN_INSPECTOR_PROFILE_TIMEOUT_MS ?? process.env.PLUGIN_INSPECTOR_PROFILE_TIMEOUT_MS ?? ""), 10);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return defaultProfileTimeoutMs;
}

export function resolveProfileMaxOutputBytes(options = {}) {
  if (Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes >= 0) {
    return options.maxOutputBytes;
  }
  return defaultProfileMaxOutputBytes;
}

function createCappedCollector(maxBytes) {
  const chunks = [];
  let size = 0;
  return {
    chunks,
    push(chunk) {
      if (size >= maxBytes) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = maxBytes - size;
      chunks.push(buffer.length > room ? buffer.subarray(0, room) : buffer);
      size += Math.min(buffer.length, room);
    },
  };
}

async function readProcessStats(pid) {
  if (!pid || process.platform === "win32") {
    return { rssAvailable: false, rssKb: 0, cpuAvailable: false, cpuPercent: 0 };
  }
  return new Promise((resolve) => {
    const ps = spawn("ps", ["-o", "rss=", "-o", "%cpu=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    ps.stdout.on("data", (chunk) => chunks.push(chunk));
    ps.on("error", () => resolve({ rssAvailable: false, rssKb: 0, cpuAvailable: false, cpuPercent: 0 }));
    ps.on("exit", () => {
      const [rssRaw, cpuRaw] = Buffer.concat(chunks).toString("utf8").trim().split(/\s+/);
      const rssKb = Number.parseInt(rssRaw, 10);
      const cpuPercent = Number.parseFloat(cpuRaw);
      const rssAvailable = Number.isFinite(rssKb);
      const cpuAvailable = Number.isFinite(cpuPercent);
      resolve({
        rssAvailable,
        rssKb: rssAvailable ? rssKb : 0,
        cpuAvailable,
        cpuPercent: cpuAvailable ? cpuPercent : 0,
      });
    });
  });
}

function heapUsedMb() {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

function previewLines(chunks) {
  return Buffer.concat(chunks).toString("utf8").trim().split("\n").slice(-2).join("\n");
}
