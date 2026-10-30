import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { csvRows } from "./io.mjs";

export const DOMAINS = {
  microbe: { node: "NCBI", meta: "Taxa_NCBI" },
  plant: { node: "NCBI", meta: "Taxa_NCBI" },
  food: { node: "name", meta: "node_id" },
  tissue: { node: "ID", meta: "ID" },
  personalCareProduct: { node: "name", meta: "node_id" },
  microbiome: { node: "ID", meta: "ID", delimiter: "\t" },
};
export function settings(input = {}) {
  const out = {
    database: "metabolomicspanrepo_index_nightly",
    library: "gnpslibrary",
    precursorTolerance: 0.05,
    fragmentTolerance: 0.02,
    cosine: 0.7,
    minPeaks: 3,
    analog: false,
    below: 150,
    above: 200,
    concurrency: 3,
    domains: Object.keys(DOMAINS),
    exportHtml: true,
    exportJson: true,
    usiColumn: "USI",
    nameColumn: "Compound",
    mode: "search",
    delimiter: "auto",
  };
  for (const key of Object.keys(out))
    if (input[key] !== undefined) out[key] = input[key];
  for (const [key, min, max, integer] of [
    ["precursorTolerance", 0.000001, 100],
    ["fragmentTolerance", 0.000001, 100],
    ["cosine", 0, 1],
    ["minPeaks", 1, 10000, true],
    ["below", 0, 10000],
    ["above", 0, 10000],
    ["concurrency", 1, 10, true],
  ]) {
    if (
      typeof out[key] !== "number" ||
      !Number.isFinite(out[key]) ||
      out[key] < min ||
      out[key] > max ||
      (integer && !Number.isInteger(out[key]))
    )
      throw new Error("Invalid " + key);
  }
  for (const k of ["analog", "exportHtml", "exportJson"])
    if (typeof out[k] !== "boolean") throw new Error("Invalid " + k);
  for (const k of ["database", "library"])
    if (typeof out[k] !== "string" || !/^[a-zA-Z0-9_.-]{1,120}$/.test(out[k]))
      throw new Error("Invalid " + k);
  for (const k of ["usiColumn", "nameColumn"])
    if (typeof out[k] !== "string" || out[k].length > 200)
      throw new Error("Invalid column name");
  if (
    !Array.isArray(out.domains) ||
    out.domains.some((d) => !Object.hasOwn(DOMAINS, d))
  )
    throw new Error("Invalid domains");
  out.domains = [...new Set(out.domains)];
  if (!["search", "draw"].includes(out.mode)) throw new Error("Invalid mode");
  if (!["auto", ",", "\t", ";"].includes(out.delimiter))
    throw new Error("Invalid delimiter");
  return out;
}
export function ensureUSI(s) {
  s = String(s || "").trim();
  if (/^CCMSLIB\d+$/.test(s)) return "mzspec:GNPS:GNPS-LIBRARY:accession:" + s;
  if (/^mzspec:[^:]+:.+:(scan|index|accession|nativeId):.+$/.test(s)) return s;
  throw new Error("Expected a USI or CCMSLIB accession: " + s.slice(0, 100));
}
export async function* inputs(file, name, options, report) {
  if (options.mode === "draw") {
    yield { name: name.replace(/\.[^.]+$/, ""), imported: true };
    return;
  }
  let skipped = 0;
  const skippedDetails = [];
  if (/\.mgf$/i.test(name)) {
    let current, index = 0, lineNumber = 0;
    const scanName = () =>
      current.params.SCANS || current.params.SPECTRUMID ||
      current.params.TITLE || String(index);
    const skip = (reason, kind = "spectrum") => {
      skipped++;
      skippedDetails.push({
        kind,
        index: current ? index : null,
        name: current ? scanName() : "",
        line: kind === "spectrum" ? current.line : lineNumber,
        reason,
      });
    };
    for await (const raw of createInterface({
      input: createReadStream(file),
      crlfDelay: Infinity,
    })) {
      lineNumber++;
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      if (line.toUpperCase() === "BEGIN IONS") {
        if (current) skip("Missing END IONS before the next BEGIN IONS");
        index++;
        current = { peaks: [], params: {}, line: lineNumber };
        continue;
      }
      if (line.toUpperCase() === "END IONS") {
        if (!current) {
          skip("END IONS without BEGIN IONS", "line");
          continue;
        }
        const { peaks, params } = current;
        const precursor_mz = Number((params.PEPMASS || "").trim().split(/\s+/)[0]);
        const reasons = [];
        if (!Number.isFinite(precursor_mz) || precursor_mz <= 0)
          reasons.push("Missing or invalid PEPMASS (must be a finite positive number)");
        const max = peaks.reduce((m, p) => Math.max(m, p[1]), 0);
        const normalized = max > 0 ? peaks
          .map((p) => [
            Number(p[0].toFixed(5)),
            Number(((p[1] / max) * 100).toFixed(1)),
          ])
          .filter((p) => p[1] >= 0.1) : [];
        if (!peaks.length) reasons.push("Empty spectrum: no valid peaks");
        else if (!max) reasons.push("No positive-intensity peaks");
        else if (normalized.length < options.minPeaks)
          reasons.push(`Too few retained peaks: ${normalized.length} (minimum ${options.minPeaks})`);
        if (reasons.length) skip(reasons.join("; "));
        else
          yield {
            name: scanName(),
            spectrum: {
              peaks: normalized,
              n_peaks: normalized.length,
              precursor_mz,
              precursor_charge: Math.abs(parseInt(params.CHARGE || "1")) || 1,
            },
          };
        current = null;
        continue;
      }
      if (!current) {
        skip("Content outside a spectrum block", "line");
        continue;
      }
      const eq = line.indexOf("=");
      if (eq > 0)
        current.params[line.slice(0, eq).trim().toUpperCase()] = line.slice(eq + 1).trim();
      else {
        const p = line.split(/\s+/).map(Number);
        if (
          p.length >= 2 &&
          Number.isFinite(p[0]) &&
          p[0] > 0 &&
          Number.isFinite(p[1]) &&
          p[1] >= 0
        )
          current.peaks.push(p.slice(0, 2));
        else skip("Invalid peak row: expected positive m/z and nonnegative finite intensity", "line");
      }
    }
    if (current) skip("Unterminated MGF spectrum: missing END IONS");
  } else {
    const delimiter =
      options.delimiter === "auto"
        ? /\.csv$/i.test(name)
          ? ","
          : "\t"
        : options.delimiter;
    if (/\.(csv|tsv)$/i.test(name)) {
      let count = 0;
      for await (const row of csvRows(file, delimiter)) {
        if (!Object.hasOwn(row, options.usiColumn))
          throw new Error("Missing USI column: " + options.usiColumn);
        if (!row[options.usiColumn]) {
          skipped++;
          continue;
        }
        yield {
          usi: ensureUSI(row[options.usiColumn]),
          name: row[options.nameColumn] || String(++count),
        };
      }
    } else {
      for await (const raw of createInterface({
        input: createReadStream(file),
        crlfDelay: Infinity,
      })) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (/^(USI|Compound)$/i.test(line)) {
          skipped++;
          continue;
        }
        yield { usi: ensureUSI(line), name: line };
      }
    }
  }
  report(skipped, skippedDetails);
}
