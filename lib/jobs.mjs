import {
  mkdir,
  readFile,
  readdir,
  rename,
  copyFile,
  access,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { inputs, settings } from "./input.mjs";
import { atomic, download, envelope } from "./io.mjs";
import { DEFAULT_TREE_BASE, loadDomain } from "./trees.mjs";
import { processResults } from "./results.mjs";
import { resolveReferenceVersion, referenceCacheKey } from "./references.mjs";

export class Jobs {
  constructor(root, config = {}) {
    this.root = root;
    this.api =
      config.api || process.env.FASST_API_URL || "https://api.fasst.gnps2.org/";
    this.treeBase =
      config.treeBase || process.env.TREE_BASE_URL || DEFAULT_TREE_BASE;
    this.pollMs = config.pollMs ?? 2000;
    this.pollLimit = config.pollLimit ?? 120;
    this.active = new Map();
    this.jobs = new Map();
    this.saves = new Map();
  }
  dir(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid job ID");
    return path.join(this.root, id);
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root)) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      try {
        const job = JSON.parse(
          await readFile(path.join(this.dir(name), "job.json"), "utf8"),
        );
        if (["running", "pausing"].includes(job.status)) {
          job.status = "interrupted";
          for (const q of job.queries)
            if (q.status === "running") q.status = "pending";
        }
        this.jobs.set(name, job);
        await this.save(job);
      } catch (error) {
        console.error(`Cannot restore job ${name}: ${error.message}`);
      }
    }
  }
  save(job) {
    job.updated = new Date().toISOString();
    const snapshot = JSON.stringify(job, null, 2);
    const previous = this.saves.get(job.id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => atomic(path.join(this.dir(job.id), "job.json"), snapshot));
    this.saves.set(job.id, next);
    return next;
  }
  get(id) {
    const job = this.jobs.get(id);
    if (!job) {
      const e = new Error("Job not found");
      e.status = 404;
      throw e;
    }
    return job;
  }
  summary(job) {
    const succeeded = job.queries.filter((q) => q.status === "complete").length,
      failed = job.queries.filter((q) => q.status === "failed").length;
    const pending = job.queries.length - succeeded - failed;
    const issues = job.queries.filter((q) => q.fasstIssue);
    const retrying = job.status === "running" && issues.some(
      (q) => q.status === "running" && q.fasstIssue.retrying,
    );
    const elapsed = Date.now() - (job.processingStartedAt || Date.now());
    const estimatedRemainingSeconds = job.status === "running" &&
      job.processedThisRun > 0 && elapsed > 0
      ? Math.ceil((elapsed / job.processedThisRun) * pending / 1000)
      : null;
    return {
      ...job,
      queries: undefined,
      total: job.queries.length,
      succeeded,
      failed,
      pending,
      estimatedRemainingSeconds,
      fasstWarning: issues.length ? {
        retrying,
        affected: issues.length,
        rateLimited: issues.every((q) => q.fasstIssue.status === 429),
      } : null,
    };
  }
  list() {
    return [...this.jobs.values()]
      .map((j) => this.summary(j))
      .sort((a, b) => b.created.localeCompare(a.created));
  }
  async create(upload, name, rawOptions, label) {
    const options = settings(rawOptions);
    const job = {
      id: randomUUID(),
      name: String(label || name).slice(0, 200),
      inputName: name,
      created: new Date().toISOString(),
      status: "ready",
      options,
      treeBase: this.treeBase,
      referenceCacheVersion: 1,
      api: this.api,
      queries: [],
      skipped: 0,
      skippedDetails: [],
    };
    const dir = this.dir(job.id);
    await mkdir(dir, { recursive: true });
    try {
      await rename(upload, path.join(dir, "input"));
      let index = 0;
      for await (const input of inputs(
        path.join(dir, "input"),
        name,
        options,
        (n, details) => {
          job.skipped = n;
          job.skippedDetails = details;
        },
      )) {
        const qid = String(++index).padStart(6, "0");
        const qdir = path.join(dir, qid);
        await mkdir(qdir);
        await atomic(path.join(qdir, "input.json"), JSON.stringify(input));
        if (input.imported)
          await copyFile(
            path.join(dir, "input"),
            path.join(qdir, "import.tsv"),
          );
        job.queries.push({
          id: qid,
          name: input.name,
          status: "pending",
          tasks: {},
        });
      }
      if (!job.queries.length)
        throw new Error(
          "No searchable spectra found. Check the input and minimum peak count." +
          (job.skippedDetails.length ? " Skipped: " + job.skippedDetails.map(
            (item) => `${item.kind === "spectrum" ? `Spectrum ${item.index} (${item.name})` : `Line ${item.line}`}: ${item.reason}`,
          ).join(" | ") : ""),
        );
      this.jobs.set(job.id, job);
      await this.save(job);
      return this.summary(job);
    } catch (error) {
      this.jobs.delete(job.id);
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  async start(id) {
    const job = this.get(id);
    if (this.active.has(id)) return this.summary(job);
    if (this.active.size) {
      const e = new Error("Pause the running job before starting another.");
      e.status = 409;
      throw e;
    }
    if (job.status === "complete") return this.summary(job);
    job.status = "running";
    delete job.processingStartedAt;
    job.processedThisRun = 0;
    delete job.error;
    for (const q of job.queries)
      if (q.status !== "complete") {
        q.status = "pending";
        delete q.error;
        delete q.fasstIssue;
      }
    const controller = new AbortController();
    this.active.set(id, { controller });
    await this.save(job);
    const promise = this.run(job, controller.signal)
      .catch(async (error) => {
        job.status = "failed";
        job.error = error.message;
        await this.save(job);
      })
      .finally(() => this.active.delete(id));
    this.active.get(id).promise = promise;
    return this.summary(job);
  }
  async pause(id) {
    const job = this.get(id),
      active = this.active.get(id);
    if (active) {
      job.status = "pausing";
      active.controller.abort(new Error("Paused by user"));
      await this.save(job);
    }
    return this.summary(job);
  }
  async close() {
    for (const item of this.active.values())
      item.controller.abort(new Error("Server stopping"));
    await Promise.all([...this.active.values()].map((a) => a.promise));
  }
  async run(job, signal) {
    const loaded = new Map();
    try {
      if (job.options.domains.length && job.referenceCacheVersion === 1 && !job.referenceVersion) {
        job.stage = "Checking reference data version";
        await this.save(job);
        const version = await resolveReferenceVersion(job.treeBase, signal);
        if (version) {
          job.referenceSource = job.treeBase;
          job.referenceVersion = version.commit;
          job.treeBase = version.base;
          // Persist the pin before downloading anything, including on interruption.
          await this.save(job);
        }
      }
      const referenceDir = job.referenceCacheVersion === 1 && job.referenceVersion
        ? path.join(this.root, ".reference-cache", referenceCacheKey(job.treeBase))
        : path.join(this.dir(job.id), "reference");
      for (const domain of job.options.domains) {
        job.stage = "Loading / caching " + domain + " references";
        await this.save(job);
        loaded.set(
          domain,
          await loadDomain(
            referenceDir,
            domain,
            job.treeBase,
            signal,
          ),
        );
      }
      job.stage = "Processing spectra";
      job.processingStartedAt = Date.now();
      await this.save(job);
      let position = 0;
      const worker = async () => {
        while (!signal.aborted && position < job.queries.length) {
          const q = job.queries[position++];
          if (q.status === "complete") continue;
          q.status = "running";
          await this.save(job);
          try {
            const dir = path.join(this.dir(job.id), q.id);
            const input = JSON.parse(
              await readFile(path.join(dir, "input.json"), "utf8"),
            );
            if (!input.imported)
              for (const phase of ["data", "library"]) {
                q.stage = "Searching " + phase;
                await this.save(job);
                await this.search(job, q, input, phase, signal);
              }
            signal.throwIfAborted();
            q.stage = "Writing tables and trees";
            await this.save(job);
            q.counts = await processResults(dir, input, job.options, loaded);
            // Only committed artifacts count as success. A crash before this checkpoint safely regenerates them.
            q.status = "complete";
            delete q.error;
            delete q.stage;
          } catch (error) {
            q.status = signal.aborted ? "pending" : "failed";
            q.error = error.message;
          }
          if (!signal.aborted) job.processedThisRun++;
          await this.save(job);
        }
      };
      await Promise.all(
        Array.from({ length: job.options.concurrency }, worker),
      );
      job.status = signal.aborted
        ? "paused"
        : job.queries.some((q) => q.status === "failed")
          ? "failed"
          : "complete";
    } catch (error) {
      job.status = signal.aborted ? "paused" : "failed";
      job.error = error.message;
    }
    delete job.stage;
    await this.save(job);
  }
  async search(job, q, input, phase, signal) {
    const dir = path.join(this.dir(job.id), q.id),
      output = path.join(dir, phase + ".json");
    try {
      await access(output);
      const info = await envelope(output);
      if (info.hasResults) return;
    } catch (error) {
      if (error.code !== "ENOENT") await rm(output, { force: true });
    }
    const p = job.options;
    const params = {
      library: phase === "data" ? p.database : p.library,
      analog: phase === "data" && p.analog ? "Yes" : "No",
      lower_delta: p.below,
      upper_delta: p.above,
      pm_tolerance: p.precursorTolerance,
      fragment_tolerance: p.fragmentTolerance,
      cosine_threshold: p.cosine,
    };
    if (input.usi) params.usi = input.usi;
    else params.query_spectrum = JSON.stringify(input.spectrum);
    const urlBase = job.api.endsWith("/") ? job.api : job.api + "/";
    if (!q.tasks[phase]) {
      let response;
      try {
        response = await fetch(new URL("search", urlBase), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });
      } catch (error) {
        if (!signal.aborted) {
          q.fasstIssue = { retrying: false };
          await this.save(job);
        }
        throw error;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 500 || response.status === 429) {
          q.fasstIssue = { retrying: false, status: response.status };
          await this.save(job);
        } else delete q.fasstIssue;
        throw new Error(`FASST submission HTTP ${response.status}`);
      }
      delete q.fasstIssue;
      const body = await response.json();
      if (typeof body.id !== "string" || !body.id)
        throw new Error("FASST did not return a task ID");
      q.tasks[phase] = body.id;
      await this.save(job);
    }
    const poll = path.join(dir, phase + ".poll.json");
    for (let attempt = 0; attempt < this.pollLimit; attempt++) {
      signal.throwIfAborted();
      try {
        await download(
          new URL(
            "search/result/" + encodeURIComponent(q.tasks[phase]),
            urlBase,
          ),
          poll,
          { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (error.status && error.status < 500 && error.status !== 429)
          delete q.fasstIssue;
        if (error.status === 404 || error.status === 410) {
          delete q.tasks[phase];
          await this.save(job);
          throw new Error("Upstream task expired. Resume to submit it again.");
        }
        if (
          signal.aborted ||
          (error.status && error.status < 500 && error.status !== 429)
        )
          throw error;
        q.fasstIssue = {
          retrying: attempt < this.pollLimit - 1,
          status: error.status || null,
        };
        await this.save(job);
        if (attempt === this.pollLimit - 1) throw error;
        await delay(this.pollMs, undefined, { signal });
        continue;
      }
      if (q.fasstIssue) {
        delete q.fasstIssue;
        await this.save(job);
      }
      const info = await envelope(poll);
      if (["PENDING", "RUNNING", "STARTED", "RETRY"].includes(info.status)) {
        await delay(this.pollMs, undefined, { signal });
        continue;
      }
      if (["FAILURE", "FAILED", "REVOKED", "ERROR"].includes(info.status)) {
        delete q.tasks[phase];
        await this.save(job);
        throw new Error(
          "FASST task failed: " + info.status + ". Resume to retry.",
        );
      }
      if (!info.hasResults)
        throw new Error("Unexpected FASST response: missing results array");
      await rename(poll, output);
      return;
    }
    throw new Error(
      "Timed out waiting for FASST. Resume will poll the saved task ID.",
    );
  }
  async files(id, qid) {
    const job = this.get(id);
    if (!job.queries.some((q) => q.id === qid))
      throw new Error("Unknown spectrum");
    return (await readdir(path.join(this.dir(id), qid)))
      .filter(
        (n) =>
          /^result_.*\.(tsv|json|html)$/.test(n) && !n.endsWith(".tree.json"),
      )
      .sort();
  }
}
