import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import {
  jsonRows,
  csvRows,
  simpleUSI,
  roundEven,
  writeRows,
  atomic,
} from "./io.mjs";
import { domainOutput, combine, treeHtml } from "./trees.mjs";

const MATCH = ["Delta Mass", "USI", "Cosine", "Matching Peaks", "Status"];
const LIBRARY = [
  "USI",
  "GNPSLibraryAccession",
  "Cosine",
  "Matching Peaks",
  "CompoundName",
  "Adduct",
  "Charge",
];
export function selectMatches(options, analogBins = false) {
  const where =
    `phase='data' AND peaks>=${options.minPeaks}` +
    (options.analog ? "" : ` AND abs(delta)<=${options.precursorTolerance}`);
  return `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY file${analogBins ? ",rounded" : ""} ORDER BY cosine DESC,peaks DESC,id) AS rank FROM hits WHERE ${where}) WHERE rank=1`;
}
export async function processResults(dir, query, options, loaded) {
  const prefix = dir + "/result";
  const db = new DatabaseSync(dir + "/matches.sqlite");
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS hits(id INTEGER PRIMARY KEY, phase TEXT, file TEXT, dataset TEXT, cosine REAL, peaks INTEGER, delta REAL, rounded INTEGER, data TEXT); DELETE FROM hits;",
  );
  const insert = db.prepare(
    "INSERT INTO hits(phase,file,dataset,cosine,peaks,delta,rounded,data) VALUES(?,?,?,?,?,?,?,?)",
  );
  try {
    for (const phase of ["data", "library"]) {
      if (query.imported && phase === "library") continue;
      const rows = query.imported
        ? csvRows(dir + "/import.tsv", "\t")
        : jsonRows(dir + "/" + phase + ".json");
      let count = 0;
      for await (const item of rows) {
        const row = query.imported ? item : item.value;
        if (!row || !row.USI) throw new Error("Result missing USI");
        const cosine = Number(row.Cosine),
          peaks = Number(row["Matching Peaks"]),
          delta = Number(row["Delta Mass"] || 0);
        if (![cosine, peaks, delta].every(Number.isFinite))
          throw new Error("Invalid numeric result fields");
        const file = simpleUSI(row.USI);
        row.file_usi = file;
        if (options.analog) row.rounded_delta = roundEven(delta);
        if (count % 1000 === 0) db.exec("BEGIN");
        insert.run(
          phase,
          file,
          row.Dataset || row.USI.split(":")[1],
          cosine,
          peaks,
          delta,
          roundEven(delta),
          JSON.stringify(row),
        );
        count++;
        if (count % 1000 === 0) db.exec("COMMIT");
      }
      if (count % 1000) db.exec("COMMIT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS hit_file ON hits(file);");
    function* rows(sql) {
      for (const hit of db.prepare(sql).iterate()) yield JSON.parse(hit.data);
    }
    db.exec(
      `DROP TABLE IF EXISTS selected; CREATE TABLE selected AS ${selectMatches(options)}; CREATE INDEX selected_file ON selected(file);`,
    );
    if (options.analog)
      db.exec(
        `DROP TABLE IF EXISTS analog_selected; CREATE TABLE analog_selected AS ${selectMatches(options, true)}; CREATE INDEX analog_selected_file ON analog_selected(file);`,
      );
    const selected = "SELECT * FROM selected";
    await writeRows(prefix + "_matches.tsv", rows(selected), MATCH);
    await writeRows(
      prefix + "_library.tsv",
      rows(
        "SELECT data FROM hits WHERE phase='library' ORDER BY cosine DESC,peaks DESC",
      ),
      LIBRARY,
    );
    const datasets = new Map();
    if (!query.imported)
      for await (const { value } of jsonRows(
        dir + "/data.json",
        "grouped_by_dataset",
      ))
        datasets.set(value.Dataset, value.title || "");
    const counts = db
      .prepare(
        `SELECT dataset AS Dataset,count(*) AS Frequency FROM (${selected}) GROUP BY dataset ORDER BY Frequency DESC`,
      )
      .all()
      .map((d) => ({ ...d, title: datasets.get(d.Dataset) || "" }));
    await writeRows(prefix + "_datasets.tsv", counts, [
      "Dataset",
      "Frequency",
      "title",
    ]);
    if (options.analog) {
      await writeRows(
        prefix + "_unfiltered_matches.tsv",
        rows(
          "SELECT data FROM hits WHERE phase='data' ORDER BY cosine DESC,peaks DESC",
        ),
        MATCH,
      );
      await writeRows(
        prefix + "_analog_matches.tsv",
        rows("SELECT * FROM analog_selected"),
        [...MATCH, "rounded_delta"],
      );
    }
    const context = {
      parameters: options,
      library: db
        .prepare(
          "SELECT data FROM hits WHERE phase='library' ORDER BY cosine DESC LIMIT 200",
        )
        .all()
        .map((r) => JSON.parse(r.data)),
    };
    for (const analog of options.analog ? [false, true] : [false]) {
      const trees = [],
        base = prefix + (analog ? "_analog" : "");
      for (const domain of options.domains)
        trees.push(
          await domainOutput({
            db,
            select: analog ? "SELECT * FROM analog_selected" : selected,
            domain,
            loaded: loaded.get(domain),
            prefix: base,
            options,
            context,
            title: query.name + (analog ? " · analog" : "") + " · " + domain,
          }),
        );
      if (trees.length > 1) {
        const combined = combine(trees);
        if (options.exportJson)
          await atomic(base + "_combined.json", JSON.stringify(combined));
        if (options.exportHtml)
          await atomic(
            base + "_combined.html",
            treeHtml(combined, query.name + " · all domains", context),
          );
      }
    }
    return {
      matches: db.prepare(`SELECT count(*) AS n FROM (${selected})`).get().n,
      library: db
        .prepare("SELECT count(*) AS n FROM hits WHERE phase='library'")
        .get().n,
    };
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}
