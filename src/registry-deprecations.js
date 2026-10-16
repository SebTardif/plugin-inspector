import { collectRuntimeModuleImports } from "./runtime-imports.js";

// Names the retirement text tells an author to call. A packed npm target can
// be older than this snapshot, so those names have to exist in its
// declarations before the text is safe to show.
export function replacementExportNames(record) {
  const text = typeof record?.replacement === "string" ? record.replacement : "";
  const names = [];
  const seen = new Set();
  const add = (name) => {
    if (!name || name === "Async" || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*(?:Async|V\d+))\b/g)) add(match[1]);
  for (const match of text.matchAll(/\b(?:Await|Use)\s+([A-Za-z_$][\w$]*)/g)) {
    const name = match[1];
    if (/[a-z][A-Z]/.test(name) || /(?:Async|V\d+)$/.test(name)) add(name);
  }
  return names;
}

export function retirementRecordsForPackedTarget(records, declarationSource) {
  const source = declarationSource ?? "";
  return records.filter((record) => {
    const names = replacementExportNames(record);
    if (names.length === 0) return true;
    return names.every((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(source));
  });
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function parseSurface(api) {
  const sdk = /^(openclaw\/plugin-sdk(?:\/[\w-]+)?)(?:(?:\.|\s+)([\w$]+))?$/.exec(api);
  const symbol = /^[A-Za-z_$][\w$]*$/.test(api) ? api : null;
  const runtime = /^api\.runtime\.([\w$.]+)$/.exec(api);
  return { sdk, symbol, runtime };
}

function matchesSurface({ sdk, symbol, runtime }, entry) {
  return runtime ? entry.specifier === "api.runtime" && entry.names.has(runtime[1]) : sdk
    ? entry.specifier === sdk[1] && (!sdk[2] || entry.names.has(sdk[2]))
    : symbol !== null && /^openclaw\/plugin-sdk(?:\/|$)/.test(entry.specifier) && entry.names.has(symbol);
}

export function registryUsageDeprecationCodes(kind, identity, records = []) {
  let entry;
  if (kind === "sdk-module") entry = { specifier: identity, names: new Set() };
  if (kind === "sdk-export") {
    const [specifier, name] = identity.split("#");
    entry = { specifier, names: new Set([name]) };
  }
  if (kind === "runtime-member") entry = { specifier: "api.runtime", names: new Set([identity.replace(/^runtime\./, "")]) };
  return entry && records.some(record => record.status === "deprecated" &&
    (record.surfaces ?? []).some(surface => matchesSurface(parseSurface(surface), entry)))
    ? ["sdk-deprecated-api"] : [];
}

export function inspectRegistryDeprecations(text, filePath, records = []) {
  if (records.length === 0) return [];
  if (!text.includes("openclaw/plugin-sdk") && !text.includes("runtime")) return [];
  const imports = collectRuntimeModuleImports(text, { includeStaticMembers: true, includeRuntimeMembers: true });
  const findings = [];
  for (const record of records) {
    if (record.status !== "deprecated") continue;
    for (const api of record.surfaces ?? []) {
      // Qualified prose (such as "writable handles") describes conditional use,
      // not a blanket member deprecation. Do not guess from a matching import.
      const { sdk, symbol, runtime } = parseSurface(api);
      if (!sdk && !symbol && !runtime) continue;
      for (const entry of imports) {
        if (!matchesSurface({ sdk, symbol, runtime }, entry)) continue;
        const line = text.slice(0, entry.index).split("\n").length;
        const retirement = record.removeAfter ? ` retires on ${formatDate(record.removeAfter)};` : " is deprecated;";
        const replacement = record.replacement ?? "Consult the target OpenClaw migration guide.";
        findings.push({
          code: "sdk-deprecated-api",
          symbol: sdk?.[2] ?? symbol ?? api,
          surface: api,
          deprecatedApi: api,
          replacement,
          ...(record.removeAfter ? { removeAfter: record.removeAfter } : {}),
          ...(record.docsPath ? { docsPath: record.docsPath } : {}),
          compatRecord: record.code,
          ref: `${filePath}:${line}`,
          message: `${api}${retirement} ${replacement}`,
        });
      }
    }
  }
  return [...new Map(findings.map((finding) => [`${finding.compatRecord}:${finding.deprecatedApi}:${finding.ref}`, finding])).values()];
}

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}
