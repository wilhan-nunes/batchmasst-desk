import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, compose } from "node:stream";
import { parse } from "csv-parse";
import streamJson from "stream-json";
import pick from "stream-json/filters/Pick.js";
import streamArray from "stream-json/streamers/StreamArray.js";

export async function atomic(file, data) {
  const tmp = file + ".part";
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}
export async function writeRows(file, rows, columns, delimiter = "\t") {
  const cell = (value) => {
    const s = value == null ? "" : String(value);
    return /["\r\n\t,]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  async function* lines() {
    yield columns.map(cell).join(delimiter) + "\n";
    for await (const row of rows)
      yield columns.map((k) => cell(row[k])).join(delimiter) + "\n";
  }
  await pipeline(Readable.from(lines()), createWriteStream(file + ".part"));
  const h = await open(file + ".part", "r+");
  try {
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(file + ".part", file);
}
export function csvRows(file, delimiter = ",") {
  return compose(
    createReadStream(file),
    parse({
      columns: true,
      bom: true,
      delimiter,
      skip_empty_lines: true,
      trim: true,
      comment: "#",
      comment_no_infix: true,
    }),
  );
}
export function jsonRows(file, key = "results") {
  return compose(
    createReadStream(file),
    streamJson.parser(),
    pick.pick({ filter: key }),
    streamArray.streamArray(),
  );
}
// Validate the entire response without assembling the result array in memory.
export async function envelope(file) {
  let depth = 0,
    key,
    status,
    hasResults = false;
  for await (const t of compose(createReadStream(file), streamJson.parser())) {
    if (t.name === "keyValue" && depth === 1) key = t.value;
    if (t.name === "stringValue" && depth === 1 && key === "status")
      status = t.value;
    if (t.name === "startArray" && depth === 1 && key === "results")
      hasResults = true;
    if (t.name === "startObject" || t.name === "startArray") depth++;
    if (t.name === "endObject" || t.name === "endArray") depth--;
  }
  return { status, hasResults };
}
export async function download(url, file, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const e = new Error(
      `Upstream HTTP ${response.status} from ${new URL(url).host}`,
    );
    e.status = response.status;
    throw e;
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(file + ".part"),
    );
    const handle = await open(file + ".part", "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(file + ".part", file);
  } catch (error) {
    await rm(file + ".part", { force: true });
    throw error;
  }
}
export function simpleUSI(usi) {
  const p = String(usi).split(":");
  if (p[0] !== "mzspec" || p.length < 3)
    throw new Error("Invalid match USI: " + usi);
  return (
    p.slice(0, 2).join(":") +
    ":" +
    p[2]
      .split("/")
      .pop()
      .replace(/\.[^.]+$/, "")
  );
}
// Python's round(x, 0) uses ties-to-even, including negative deltas.
export function roundEven(n) {
  const f = Math.floor(n);
  return n - f === 0.5 ? (f % 2 ? f + 1 : f) : Math.round(n);
}
