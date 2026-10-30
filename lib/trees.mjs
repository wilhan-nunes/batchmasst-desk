import { readFile, mkdir, access, rm, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { treeHtml } from "./viewer.mjs";
export { treeHtml } from "./viewer.mjs";
import { DOMAINS } from "./input.mjs";
import { download, csvRows, atomic, writeRows } from "./io.mjs";

export const DEFAULT_TREE_BASE =
  "https://raw.githubusercontent.com/wilhan-nunes/microbe_masst/d9d797e936c630c656fed65e8ec50b4f99d3d59c/data/";
export async function loadDomain(dir, domain, base, signal) {
  await mkdir(dir, { recursive: true });
  const config = DOMAINS[domain];
  const filenames = [
    `${domain}_masst_tree.json`,
    `${domain}_masst_table.${config.delimiter ? "tsv" : "csv"}`,
  ];
  for (const name of filenames) {
    const target = path.join(dir, name);
    try {
      await access(target);
    } catch {
      await download(new URL(name, base), target, { signal });
    }
  }
  const metadata = path.join(dir, filenames[1]),
    index = path.join(dir, domain + ".sqlite");
  try {
    await access(index);
  } catch {
    for (const suffix of [".part", ".part-journal", ".part-wal", ".part-shm"])
      await rm(index + suffix, { force: true });
    const db = new DatabaseSync(index + ".part");
    try {
      db.exec("CREATE TABLE meta(file TEXT,node TEXT,data TEXT);");
      const insert = db.prepare("INSERT INTO meta VALUES(?,?,?)");
      let count = 0;
      for await (const row of csvRows(metadata, config.delimiter || ",")) {
        if (count % 1000 === 0) {
          signal?.throwIfAborted();
          db.exec("BEGIN");
        }
        insert.run(
          row.file_usi || "",
          String(row[config.meta]),
          JSON.stringify(row),
        );
        count++;
        if (count % 1000 === 0) db.exec("COMMIT");
      }
      if (count % 1000) db.exec("COMMIT");
      db.exec("CREATE INDEX meta_file ON meta(file);");
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
    await rename(index + ".part", index);
  }
  const db = new DatabaseSync(index, { readOnly: true });
  let columns;
  try {
    const first = db.prepare("SELECT data FROM meta LIMIT 1").get();
    columns = first ? Object.keys(JSON.parse(first.data)) : [];
  } finally {
    db.close();
  }
  return {
    tree: JSON.parse(await readFile(path.join(dir, filenames[0]), "utf8")),
    metadata,
    index,
    columns,
    config,
  };
}
export function enrichTree(original, config, groups, domain) {
  const tree = structuredClone(original);
  let missingSize = false;
  function inspect(n) {
    if (n.group_size == null) missingSize = true;
    (n.children || []).forEach(inspect);
  }
  inspect(tree);
  function visit(n) {
    const direct = groups.get(String(n[config.node])) || [];
    n.matches = direct;
    n.matched_size = direct.length;
    let childSize = 0;
    for (const child of n.children || []) {
      visit(child);
      n.matched_size += child.matched_size;
      childSize += child.group_size;
    }
    n.group_size = Number(n.group_size || 0) + (missingSize ? childSize : 0);
    n.occurrence_fraction = n.group_size ? n.matched_size / n.group_size : 0;
    n.masst_type = domain;
    n.pie_data = [0, 1].map((index) => ({
      index,
      group_size: n.group_size,
      matched_size: n.matched_size,
      occurrence_fraction: index
        ? 1 - n.occurrence_fraction
        : n.occurrence_fraction,
      masst_type: domain,
    }));
  }
  visit(tree);
  return tree;
}
export function combine(trees) {
  const tree = {
    name: "All domains",
    children: trees.map((tree) => ({
      ...tree,
      name: tree.masst_type || tree.name,
    })),
    group_size: 0,
    matched_size: 0,
  };
  for (const child of trees) {
    tree.group_size += child.group_size;
    tree.matched_size += child.matched_size;
  }
  tree.occurrence_fraction = tree.group_size
    ? tree.matched_size / tree.group_size
    : 0;
  tree.pie_data = [0, 1].map((index) => ({
    index,
    group_size: tree.group_size,
    matched_size: tree.matched_size,
    occurrence_fraction: index
      ? 1 - tree.occurrence_fraction
      : tree.occurrence_fraction,
    masst_type: "combined",
  }));
  return tree;
}
export async function domainOutput({
  db,
  select,
  domain,
  loaded,
  prefix,
  options,
  title,
  context,
}) {
  const { config, tree, index } = loaded;
  const groups = new Map();
  db.prepare("ATTACH DATABASE ? AS reference").run(index);
  const countFile = `${prefix}_counts_${domain}.tsv`;
  function* joined() {
    for (const hit of db
      .prepare(
        `SELECT h.data AS hit,m.data AS metadata,m.node FROM (${select}) h JOIN reference.meta m ON h.file=m.file`,
      )
      .iterate()) {
      const row = JSON.parse(hit.hit),
        meta = JSON.parse(hit.metadata);
      const list = groups.get(hit.node) || [];
      list.push(
        Object.fromEntries(
          ["USI", "Cosine", "Matching Peaks", "Delta Mass"].map((k) => [
            k,
            row[k],
          ]),
        ),
      );
      groups.set(hit.node, list);
      yield { ...meta, ...row, file_usi: meta.file_usi };
    }
  }
  const columns = [
    ...new Set([
      ...loaded.columns,
      "USI",
      "Cosine",
      "Matching Peaks",
      "Delta Mass",
      "rounded_delta",
      "file_usi",
    ]),
  ];
  try {
    await writeRows(countFile, joined(), columns);
  } finally {
    db.exec("DETACH DATABASE reference");
  }
  const enriched = enrichTree(tree, config, groups, domain);
  await atomic(`${prefix}_${domain}.tree.json`, JSON.stringify(enriched)); // internal summaries survive disabled JSON exports
  if (options.exportJson)
    await atomic(`${prefix}_${domain}.json`, JSON.stringify(enriched));
  if (options.exportHtml)
    await atomic(
      `${prefix}_${domain}.html`,
      treeHtml(enriched, title, context),
    );
  return enriched;
}
