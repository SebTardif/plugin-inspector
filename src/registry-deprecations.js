import path from "node:path";
import { collectRuntimeModuleImports } from "./runtime-imports.js";

// replacementExports is the full list of calls a record tells the author to
// use. A packed package can be older than this snapshot, so every name has to
// be a public declaration export before that text is safe to show.
export function retirementRecordsForPackedTarget(records, { declarations = [], packageJson = {}, packageRoot = "" } = {}) {
  const available = publicReplacementNames(declarations, packageJson, packageRoot);
  return records.filter((record) => {
    const names = Array.isArray(record.replacementExports) ? record.replacementExports : [];
    if (names.length === 0) return true;
    return names.every((name) => available.has(name));
  });
}

function publicReplacementNames(declarations, packageJson, packageRoot) {
  const names = new Set();
  for (const declaration of declarations) {
    if (!isPublicSdkDeclaration(declaration.filePath, packageJson, packageRoot)) continue;
    for (const name of exportedDeclarationNames(declaration.source ?? "")) names.add(name);
  }
  return names;
}

function isPublicSdkDeclaration(filePath, packageJson, packageRoot) {
  const relativeFile = path.relative(packageRoot, filePath).split(path.sep).join("/");
  const declarationStem = relativeFile.replace(/\.d\.ts$/, "");
  return exportStems(packageJson).some((stem) => declarationStem === stem);
}

function exportStems(packageJson) {
  const stems = [];
  const visit = (value) => {
    if (typeof value === "string") {
      stems.push(value.replace(/^\.\//, "").replace(/\.(?:[cm]?js|d\.ts)$/, ""));
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(packageJson.exports ?? {});
  return stems;
}

function exportedDeclarationNames(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const names = new Set();
  for (const match of text.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(",")) {
      const alias = /([A-Za-z_$][\w$]*)\s*$/.exec(part.trim());
      if (alias) names.add(alias[1]);
    }
  }
  for (const match of text.matchAll(/\bexport\s+(?:declare\s+)?(?:interface|type)\s+[A-Za-z_$][\w$]*[^{=]*=?\s*\{([\s\S]*?)\n\}/g)) {
    for (const member of match[1].matchAll(/(?:^|\n)\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?(]/g)) {
      names.add(member[1]);
    }
  }
  return names;
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
