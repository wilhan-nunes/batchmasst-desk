import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Jobs } from "../lib/jobs.mjs";
import { settings } from "../lib/input.mjs";
import { simpleUSI, roundEven } from "../lib/io.mjs";
import { makeApp } from "../server.mjs";

const hit = (file, scan, cosine, delta = 0, peaks = 5) => ({
  USI: `mzspec:MSV1:folder/${file}.mzML:scan:${scan}`,
  Cosine: cosine,
  "Delta Mass": delta,
  "Matching Peaks": peaks,
  Dataset: "MSV1",
  Status: "OK",
});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "masst-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let next = 0;
  const submitted = [],
    tasks = new Map();
  let pollStatus = 0, submissionStatus = 0;
  let pending = false,
    failDownload = false,
    terminal = false,
    empty = false;
  const tree = {
    name: "Root",
    children: [{ name: "Taxon", NCBI: "2", group_size: 2 }],
  };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/search" && submissionStatus) {
      res.writeHead(submissionStatus);
      res.end();
      return;
    }
    if (req.url === "/search") {
      let text = "";
      for await (const c of req) text += c;
      const p = JSON.parse(text),
        id = String(++next);
      submitted.push(p);
      tasks.set(id, p);
      res.end(JSON.stringify({ id }));
      return;
    }
    if (req.url.startsWith("/search/result/")) {
      if (pollStatus) {
        res.writeHead(pollStatus);
        res.end();
        return;
      }
      if (pending) {
        res.end(JSON.stringify({ status: "PENDING" }));
        return;
      }
      if (terminal) {
        res.end(JSON.stringify({ status: "FAILURE" }));
        return;
      }
      if (failDownload) {
        res.writeHead(200, { "Content-Length": 100000 });
        res.write('{"results":[');
        setTimeout(() => res.destroy(), 5);
        return;
      }
      const task = tasks.get(req.url.split("/").pop());
      const rows = empty
        ? []
        : task?.library === "gnpslibrary"
          ? [
              {
                ...hit("library", 1, 0.99),
                GNPSLibraryAccession: "CCMSLIB1",
                CompoundName: "Test",
              },
            ]
          : [
              hit("a", 1, 0.8),
              hit("a", 2, 0.9),
              hit("a", 3, 0.95, 2.5),
              hit("b", 1, 0.99, 0, 1),
              hit("b", 2, 0.7, 0.01),
            ];
      res.end(
        JSON.stringify({
          results: rows,
          grouped_by_dataset: [{ Dataset: "MSV1", title: "Dataset title" }],
        }),
      );
      return;
    }
    if (req.url.endsWith("_tree.json")) {
      res.end(JSON.stringify(tree));
      return;
    }
    if (req.url.endsWith("_table.csv")) {
      res.end("file_usi,Taxa_NCBI\nmzspec:MSV1:a,2\nmzspec:MSV1:b,2\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const url = `http://127.0.0.1:${upstream.address().port}/`;
  const config = { api: url, treeBase: url, pollMs: 10, pollLimit: 4 };
  const jobs = new Jobs(path.join(root, "jobs"), config);
  await jobs.init();
  async function create(
    options = {},
    text = "CCMSLIB00000001556\n",
    name = "input.txt",
  ) {
    const f = path.join(root, "upload-" + Math.random());
    await writeFile(f, text);
    return jobs.create(f, name, { domains: ["microbe"], ...options });
  }
  async function run(id) {
    await jobs.start(id);
    await jobs.active.get(id)?.promise;
    return jobs.get(id);
  }
  return {
    root,
    jobs,
    config,
    create,
    run,
    submitted,
    tasks,
    url,
    setPollStatus: (v) => (pollStatus = v),
    setSubmissionStatus: (v) => (submissionStatus = v),
    setPending: (v) => (pending = v),
    setBroken: (v) => (failDownload = v),
    setTerminal: (v) => (terminal = v),
    setEmpty: (v) => (empty = v),
  };
}
test("normalizes file USIs and Python-compatible analog bins", () => {
  assert.equal(
    simpleUSI("mzspec:MSV1:folder/sample.mzML:scan:42"),
    "mzspec:MSV1:sample",
  );
  assert.deepEqual([2.5, 3.5, -2.5, -3.5].map(roundEven), [2, 4, -2, -4]);
  assert.throws(() => settings({ concurrency: 0 }));
  assert.throws(() => settings({ domains: ["../../"] }));
});
test("job ETA uses current-run throughput and is unavailable before progress or when stopped", (t) => {
  t.mock.method(Date, "now", () => 160000);
  const jobs = new Jobs("unused");
  const job = {
    status: "running",
    processingStartedAt: 100000,
    processedThisRun: 2,
    queries: [
      { status: "complete" },
      { status: "complete" },
      { status: "failed" },
      { status: "running" },
      { status: "pending" },
    ],
  };
  // Includes current-run failures as processed work, but excludes previously
  // completed queries from the rate. Two pending spectra at 30 seconds each.
  assert.equal(jobs.summary(job).estimatedRemainingSeconds, 60);
  job.processedThisRun = 0;
  assert.equal(jobs.summary(job).estimatedRemainingSeconds, null);
  job.processedThisRun = 2;
  for (const status of ["paused", "interrupted", "complete", "failed", "ready"]) {
    job.status = status;
    assert.equal(jobs.summary(job).estimatedRemainingSeconds, null);
  }
  delete job.processingStartedAt;
  delete job.processedThisRun;
  job.status = "running";
  assert.equal(jobs.summary(job).estimatedRemainingSeconds, null);
});
test("MGF normalization, quoted CSV and invalid/empty input", async (t) => {
  const f = await fixture(t);
  const j = await f.create(
    {},
    "BEGIN IONS\nSCANS=42\nPEPMASS=183.07\nCHARGE=2-\n80 100\n90 10\n100 1\nEND IONS\n",
    "spectra.mgf",
  );
  const input = JSON.parse(
    await readFile(path.join(f.jobs.dir(j.id), "000001/input.json")),
  );
  assert.equal(input.name, "42");
  assert.equal(input.spectrum.precursor_charge, 2);
  assert.deepEqual(input.spectrum.peaks, [
    [80, 100],
    [90, 10],
    [100, 1],
  ]);
  const csv = await f.create(
    {},
    'USI,Compound\nCCMSLIB00000001556,"label, with comma"\n',
    "input.csv",
  );
  assert.equal(f.jobs.get(csv.id).queries[0].name, "label, with comma");
  await assert.rejects(f.create({}, "", "empty.mgf"), /No searchable/);
  await assert.rejects(
    f.create({}, "BEGIN IONS\nPEPMASS=10", "bad.mgf"),
    /Unterminated/,
  );
  await assert.rejects(f.create({}, "nonsense", "bad.txt"), /Expected a USI/);
});
test("MGF skips bad scans with persisted reasons and runs valid scans", async (t) => {
  const f = await fixture(t);
  const block = (name, body) => `BEGIN IONS\nSCANS=${name}\n${body}\nEND IONS\n`;
  const peaks = "80 100\n90 10\n100 1";
  const j = await f.create({ domains: [] },
    block("valid-before", `PEPMASS=183\n${peaks}`) +
    block("missing", peaks) +
    block("empty", "PEPMASS=183") +
    block("both", "") +
    block("infinite", `PEPMASS=Infinity\n${peaks}`) +
    block("zero", "PEPMASS=183\n80 0\n90 0\n100 0") +
    block("few", "PEPMASS=183\n80 100\n90 0.001\n100 0.001") +
    "BEGIN IONS\nTITLE=broken\nPEPMASS=183\n" +
    block("valid-after", `PEPMASS=183\ninvalid peak\n${peaks}`) +
    "BEGIN IONS\nSPECTRUMID=truncated\nPEPMASS=183\n",
    "mixed.mgf");
  assert.equal(j.total, 2);
  assert.equal(j.skipped, 9);
  const scans = j.skippedDetails.filter((item) => item.kind === "spectrum");
  assert.deepEqual(scans.map((item) => item.name),
    ["missing", "empty", "both", "infinite", "zero", "few", "broken", "truncated"]);
  assert.deepEqual(scans.map((item) => item.index), [2, 3, 4, 5, 6, 7, 8, 10]);
  assert.match(scans[0].reason, /PEPMASS/);
  assert.match(scans[1].reason, /Empty spectrum/);
  assert.match(scans[2].reason, /PEPMASS.*Empty spectrum/);
  assert.match(scans[3].reason, /finite positive/);
  assert.match(scans[4].reason, /positive-intensity/);
  assert.match(scans[5].reason, /1 \(minimum 3\)/);
  assert.match(scans[6].reason, /Missing END IONS/);
  assert.match(scans[7].reason, /Unterminated/);
  const done = await f.run(j.id);
  assert.equal(done.status, "complete");
  assert.equal(f.submitted.length, 4);
  assert.deepEqual(done.queries.map((q) => q.name), ["valid-before", "valid-after"]);
  const restored = new Jobs(path.join(f.root, "jobs"), f.config);
  await restored.init();
  assert.deepEqual(restored.get(j.id).skippedDetails, j.skippedDetails);
});
test("MGF with no usable scans reports identifiers and all reasons", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.create({}, "BEGIN IONS\nSCANS=42\nEND IONS\n", "empty-scans.mgf"),
    /No searchable.*Spectrum 1 \(42\).*PEPMASS.*Empty spectrum/,
  );
});
test("search exports filtered tables, annotations, trees and titles", async (t) => {
  const f = await fixture(t),
    j = await f.create(),
    done = await f.run(j.id);
  assert.equal(done.status, "complete", JSON.stringify(done));
  const dir = path.join(f.jobs.dir(j.id), "000001");
  const matches = await readFile(path.join(dir, "result_matches.tsv"), "utf8");
  assert.match(matches, /:scan:2/);
  assert.doesNotMatch(matches, /:scan:3/);
  assert.equal(matches.trim().split("\n").length, 3);
  assert.match(
    await readFile(path.join(dir, "result_datasets.tsv"), "utf8"),
    /Dataset title/,
  );
  const tree = JSON.parse(
    await readFile(path.join(dir, "result_microbe.json")),
  );
  assert.equal(tree.matched_size, 2);
  assert.equal(tree.group_size, 2);
  assert.match(
    await readFile(path.join(dir, "result_microbe.html"), "utf8"),
    /Download tree JSON/,
  );
  assert.equal(f.submitted.length, 2);
  await f.run(j.id);
  assert.equal(f.submitted.length, 2);
});
test("analog dedup keeps rounded mass bins and library stays exact", async (t) => {
  const f = await fixture(t),
    j = await f.create({ analog: true }),
    done = await f.run(j.id);
  assert.equal(done.status, "complete", JSON.stringify(done));
  const dir = path.join(f.jobs.dir(j.id), "000001");
  assert.equal(
    (await readFile(path.join(dir, "result_analog_matches.tsv"), "utf8"))
      .trim()
      .split("\n").length,
    4,
  );
  assert.equal(
    (await readFile(path.join(dir, "result_matches.tsv"), "utf8"))
      .trim()
      .split("\n").length,
    3,
  );
  assert.equal(f.submitted[0].analog, "Yes");
  assert.equal(f.submitted[1].analog, "No");
});
test("timeout resumes saved task without resubmission; no-domain and empty outputs", async (t) => {
  const f = await fixture(t);
  f.setPending(true);
  const j = await f.create({ domains: [] }),
    failed = await f.run(j.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.queries[0].tasks.data, "1");
  f.setPending(false);
  f.setEmpty(true);
  const restored = new Jobs(path.join(f.root, "jobs"), f.config);
  await restored.init();
  await restored.start(j.id);
  await restored.active.get(j.id).promise;
  assert.equal(restored.get(j.id).status, "complete");
  assert.equal(f.submitted.length, 2);
  assert.equal(restored.get(j.id).queries[0].counts.matches, 0);
  assert.deepEqual((await restored.files(j.id, "000001")).sort(), [
    "result_datasets.tsv",
    "result_library.tsv",
    "result_matches.tsv",
  ]);
});
test("truncated responses are not marked complete and terminal tasks retry", async (t) => {
  const f = await fixture(t);
  f.setBroken(true);
  const j = await f.create({ domains: [] });
  assert.equal((await f.run(j.id)).status, "failed");
  await assert.rejects(
    readFile(path.join(f.jobs.dir(j.id), "000001/data.json")),
  );
  f.setBroken(false);
  f.setTerminal(true);
  assert.equal((await f.run(j.id)).status, "failed");
  assert.equal(f.jobs.get(j.id).queries[0].tasks.data, undefined);
  f.setTerminal(false);
  assert.equal((await f.run(j.id)).status, "complete");
  assert.equal(f.submitted.length, 3);
});
test("existing matches import and quantification summaries via HTTP", async (t) => {
  const f = await fixture(t);
  const app = await makeApp({ root: path.join(f.root, "app"), ...f.config });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    await app.jobs.close();
    app.server.closeAllConnections();
    app.server.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(base + "/api/jobs?name=42.tsv", {
    method: "POST",
    headers: {
      "X-Masst-Options": encodeURIComponent(
        JSON.stringify({ mode: "draw", domains: ["microbe"] }),
      ),
    },
    body: "USI\tCosine\tMatching Peaks\tDelta Mass\nmzspec:MSV1:a.mzML:scan:2\t0.9\t5\t0\n",
  });
  assert.equal(response.status, 201);
  const j = await response.json();
  await app.jobs.start(j.id);
  await app.jobs.active.get(j.id).promise;
  assert.equal(app.jobs.get(j.id).status, "complete");
  assert.equal(f.submitted.length, 0);
  await fetch(base + "/api/jobs/" + j.id + "/quant", {
    method: "PUT",
    body: "row ID,A Peak area,B Peak area\n42,20,10\n",
  });
  const sum = await fetch(base + "/api/jobs/" + j.id + "/summary", {
    method: "POST",
    body: JSON.stringify({ minimum: 1, binary: true, useQuant: true }),
  });
  const data = await sum.json();
  assert.equal(sum.status, 200, JSON.stringify(data));
  assert.equal(data.files.length, 3);
  const output = await (
    await fetch(
      base +
        "/api/jobs/" +
        j.id +
        "/summary/microbe_samples_row_normalized.csv",
    )
  ).text();
  assert.match(output, /,100,50/);
  const preview = await (
    await fetch(
      base +
        "/api/jobs/" +
        j.id +
        "/queries/000001/files/result_matches.tsv?preview=1",
    )
  ).json();
  assert.equal(preview.length, 1);
  const archive = await fetch(base + "/api/jobs/" + j.id + "/archive");
  assert.equal(archive.status, 200);
  assert.ok((await archive.arrayBuffer()).byteLength > 1024);
  const cross = await fetch(base + "/api/jobs", {
    method: "POST",
    headers: { Origin: "https://evil.invalid" },
    body: "bad",
  });
  assert.equal(cross.status, 403);
  assert.equal(
    (
      await fetch(
        base + "/api/jobs/" + j.id + "/queries/000001/files/input.json",
      )
    ).status,
    404,
  );
  assert.equal((await fetch(base + "/")).status, 200);
});
test("hard process crash recovers persisted upstream task IDs", async (t) => {
  const f = await fixture(t);
  f.setPending(true);
  const root = path.join(f.root, "crash");
  // Seed a durable job, then run it in a separate process and kill without shutdown.
  const seed = new Jobs(path.join(root, "jobs"), f.config);
  await seed.init();
  const upload = path.join(f.root, "crash-upload");
  await writeFile(upload, "CCMSLIB00000001556");
  const j = await seed.create(upload, "input.txt", { domains: [] });
  const script = `import {Jobs} from ${JSON.stringify(new URL("../lib/jobs.mjs", import.meta.url).href)};const j=new Jobs(${JSON.stringify(path.join(root, "jobs"))},{api:${JSON.stringify(f.url)},treeBase:${JSON.stringify(f.url)},pollMs:100});await j.init();await j.start(${JSON.stringify(j.id)});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let snapshot;
  for (let i = 0; i < 100; i++) {
    snapshot = JSON.parse(
      await readFile(path.join(root, "jobs", j.id, "job.json")),
    );
    if (snapshot.queries[0].tasks.data) break;
    await delay(20);
  }
  assert.ok(snapshot.queries[0].tasks.data);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  f.setPending(false);
  const recovered = new Jobs(path.join(root, "jobs"), f.config);
  await recovered.init();
  assert.equal(recovered.get(j.id).status, "interrupted");
  await recovered.start(j.id);
  await recovered.active.get(j.id).promise;
  assert.equal(recovered.get(j.id).status, "complete");
  assert.equal(f.submitted.length, 2);
});
test("HTML has no Jinja delimiters and script parses", async () => {
  const html = await readFile(
    new URL("../templates/domain_masst.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(html, /\{\{|\{%|\{#/);
  for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
    new Function(js);
});
test("pause and concurrent duplicate names retain independent checkpoints", async (t) => {
  const f = await fixture(t);
  f.setPending(true);
  const j = await f.create(
    { domains: [], concurrency: 3 },
    "USI,Compound\nCCMSLIB00000001556,same\nCCMSLIB00000001556,same\nCCMSLIB00000001556,same\n",
    "batch.csv",
  );
  await f.jobs.start(j.id);
  for (let i = 0; i < 100 && f.submitted.length < 3; i++) await delay(5);
  const active = f.jobs.active.get(j.id);
  await f.jobs.pause(j.id);
  await active.promise;
  assert.equal(f.jobs.get(j.id).status, "paused");
  assert.equal(f.submitted.length, 3);
  f.setPending(false);
  assert.equal((await f.run(j.id)).status, "complete");
  assert.equal(f.submitted.length, 6);
  const saved = JSON.parse(
    await readFile(path.join(f.jobs.dir(j.id), "job.json")),
  );
  assert.ok(saved.queries.every((q) => q.status === "complete"));
  assert.equal(new Set(saved.queries.map((q) => q.id)).size, 3);
});
test("counts-only exports and report script escaping", async (t) => {
  const f = await fixture(t);
  const j = await f.create({ exportHtml: false, exportJson: false });
  assert.equal((await f.run(j.id)).status, "complete");
  const files = await f.jobs.files(j.id, "000001");
  assert.ok(files.includes("result_counts_microbe.tsv"));
  assert.ok(files.every((f) => f.endsWith(".tsv")));
  const { treeHtml } = await import("../lib/viewer.mjs");
  const html = treeHtml(
    {
      name: "</script><script>alert(1)</script>",
      group_size: 0,
      matched_size: 0,
      occurrence_fraction: 0,
    },
    "Injected </script>",
  );
  assert.equal((html.match(/<script>/g) || []).length, 1);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  new Function(script);
});

test("FASST banner reports retries, clears on recovery, and does not resubmit tasks", async (t) => {
  const f = await fixture(t);
  f.jobs.pollMs = 100;
  f.jobs.pollLimit = 20;
  f.setPollStatus(503);
  const j = await f.create({ domains: [] });
  await f.jobs.start(j.id);
  const active = f.jobs.active.get(j.id).promise;
  t.after(() => f.jobs.close());
  for (let i = 0; i < 100 && !f.jobs.summary(f.jobs.get(j.id)).fasstWarning; i++) await delay(10);
  const warning = f.jobs.summary(f.jobs.get(j.id)).fasstWarning;
  assert.deepEqual(warning, { retrying: true, affected: 1, rateLimited: false });
  f.setPollStatus(0);
  await active;
  assert.equal(f.jobs.get(j.id).status, "complete");
  assert.equal(f.jobs.summary(f.jobs.get(j.id)).fasstWarning, null);
  assert.equal(f.submitted.length, 2);
});

test("FASST banner distinguishes rate limits, exhausted retries, pause and submission errors", async (t) => {
  const f = await fixture(t);
  f.setPollStatus(429);
  const j = await f.create({ domains: [] });
  const failed = await f.run(j.id);
  assert.deepEqual(f.jobs.summary(failed).fasstWarning,
    { retrying: false, affected: 1, rateLimited: true });
  const restored = new Jobs(path.join(f.root, "jobs"), f.config);
  await restored.init();
  assert.deepEqual(restored.summary(restored.get(j.id)).fasstWarning, f.jobs.summary(failed).fasstWarning);
  failed.status = "paused";
  failed.queries[0].status = "running";
  failed.queries[0].fasstIssue.retrying = true;
  assert.equal(f.jobs.summary(failed).fasstWarning.retrying, false);
  f.setPollStatus(0);
  await f.run(j.id);
  assert.equal(f.jobs.summary(failed).fasstWarning, null);
  f.setSubmissionStatus(503);
  const submission = await f.create({ domains: [] });
  const submissionFailed = await f.run(submission.id);
  assert.deepEqual(f.jobs.summary(submissionFailed).fasstWarning,
    { retrying: false, affected: 1, rateLimited: false });
  f.setSubmissionStatus(400);
  await f.run(submission.id);
  assert.equal(f.jobs.summary(submissionFailed).fasstWarning, null);
});
