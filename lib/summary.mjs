import path from "node:path";
import { readFile, mkdir, rename, rm } from "node:fs/promises";
import { DOMAINS } from "./input.mjs";
import { csvRows, writeRows } from "./io.mjs";

export async function summaries(
  job,
  dir,
  { minimum = 1, binary = true, quantFile } = {},
) {
  if (!Number.isInteger(minimum) || minimum < 1)
    throw new Error("Minimum matches must be a positive integer");
  const staging = path.join(dir, "summary.part");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const quant = new Map();
  let samples = [];
  if (quantFile) {
    for await (const row of csvRows(quantFile, ",")) {
      if (!Object.hasOwn(row, "row ID"))
        throw new Error("Quantification CSV requires row ID");
      const cols = Object.keys(row).filter((k) => k.endsWith(" Peak area"));
      if (!cols.length)
        throw new Error(
          'Quantification CSV needs sample columns ending in " Peak area"',
        );
      samples = cols.map((k) => k.slice(0, -10));
      const values = cols.map((k) => Number(row[k]));
      if (values.some((v) => !Number.isFinite(v) || v < 0))
        throw new Error("Invalid peak area");
      const max = Math.max(...values);
      if (!quant.has(String(row["row ID"])))
        quant.set(
          String(row["row ID"]),
          values.map((v) => (max ? (v / max) * 100 : 0)),
        );
    }
  }
  const files = [],
    warnings = [];
  for (const domain of job.options.domains) {
    const config = DOMAINS[domain],
      rows = new Map(),
      features = [];
    for (const q of job.queries.filter((q) => q.status === "complete")) {
      const file = path.join(dir, q.id, `result_${domain}.tree.json`);
      const tree = JSON.parse(await readFile(file, "utf8"));
      const feature = q.id + ":" + q.name;
      features.push({ key: feature, id: q.name });
      function visit(n, level) {
        if (n.matched_size >= minimum) {
          const id = String(n[config.node] ?? n.name),
            key = JSON.stringify([id, n.name, n.Rank, n.group_size, level]);
          const row = rows.get(key) || {
            [config.node]: id,
            Name: n.name,
            Rank: n.Rank,
            group_size: n.group_size,
            Level: level,
          };
          row[feature] = binary ? 1 : n.matched_size;
          rows.set(key, row);
        }
        (n.children || []).forEach((c) => visit(c, level + 1));
      }
      (tree.children || []).forEach((c) => visit(c, 1));
    }
    const columns = [config.node, "Name", "Rank", "group_size", "Level"];
    for (const row of rows.values()) for (const f of features) row[f.key] ??= 0;
    const file = `${domain}_spectral_matches.csv`;
    await writeRows(
      path.join(staging, file),
      rows.values(),
      [...columns, ...features.map((f) => f.key)],
      ",",
    );
    files.push(file);
    if (quantFile) {
      const missing = features.filter((f) => !quant.has(f.id));
      if (missing.length)
        warnings.push(
          `${domain}: ${missing.length} spectrum names have no matching quantification row ID.`,
        );
      for (const presence of [true, false]) {
        function* sampleRows() {
          for (const row of rows.values()) {
            const out = Object.fromEntries(columns.map((k) => [k, row[k]]));
            samples.forEach((s) => (out[s] = 0));
            for (const f of features) {
              const areas = quant.get(f.id);
              if (areas)
                samples.forEach((s, i) => {
                  out[s] +=
                    row[f.key] *
                    (presence ? (areas[i] >= 0.01 ? 1 : 0) : areas[i]);
                });
            }
            yield out;
          }
        }
        const filename = `${domain}_samples_${presence ? "binary" : "row_normalized"}.csv`;
        await writeRows(
          path.join(staging, filename),
          sampleRows(),
          [...columns, ...samples],
          ",",
        );
        files.push(filename);
      }
    }
  }
  await rm(path.join(dir, "summary"), { recursive: true, force: true });
  await rename(staging, path.join(dir, "summary"));
  return { files, warnings };
}
