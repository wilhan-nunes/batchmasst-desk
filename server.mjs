import http from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  stat,
  readdir,
  open,
  rename,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import { Jobs } from "./lib/jobs.mjs";
import { summaries } from "./lib/summary.mjs";
import { csvRows } from "./lib/io.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1000000) throw new Error("Request too large");
  }
  return text ? JSON.parse(text) : {};
}
function send(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
async function serveFile(res, file, attachment = false) {
  const info = await stat(file);
  res.writeHead(200, {
    "Content-Type": types[path.extname(file)] || "application/octet-stream",
    "Content-Length": info.size,
    ...(attachment
      ? {
          "Content-Disposition": `attachment; filename="${path.basename(file)}"`,
        }
      : {}),
  });
  await pipeline(createReadStream(file), res);
}
async function upload(req, file, max) {
  let size = 0;
  await pipeline(
    req,
    new Transform({
      transform(chunk, enc, cb) {
        size += chunk.length;
        cb(
          size > max ? new Error("Upload exceeds configured limit") : null,
          chunk,
        );
      },
    }),
    createWriteStream(file),
  );
}
// Portable TAR generation with backpressure; no shell commands or archive buffering.
async function* tarFiles(dir, entries) {
  for (const entry of entries) {
    // Hold the opened inode while the manifest may be atomically replaced.
    const handle = await open(path.join(dir, entry), "r");
    try {
      const s = await handle.stat(),
        header = Buffer.alloc(512);
      header.write(entry, 0, 100, "utf8");
      header.write("0000644\0", 100);
      header.write("0000000\0", 108);
      header.write("0000000\0", 116);
      header.write(s.size.toString(8).padStart(11, "0") + "\0", 124);
      header.write(
        Math.floor(s.mtimeMs / 1000)
          .toString(8)
          .padStart(11, "0") + "\0",
        136,
      );
      header.fill(32, 148, 156);
      header.write("0", 156);
      header.write("ustar\0", 257);
      header.write("00", 263);
      const sum = header.reduce((a, b) => a + b, 0);
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      yield header;
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        yield chunk;
      if (s.size % 512) yield Buffer.alloc(512 - (s.size % 512));
    } finally {
      await handle.close();
    }
  }
  yield Buffer.alloc(1024);
}
export async function makeApp({
  root = process.env.DATA_DIR || path.join(here, "var"),
  ...config
} = {}) {
  root = path.resolve(root);
  await mkdir(root, { recursive: true });
  const jobs = new Jobs(path.join(root, "jobs"), config);
  await jobs.init();
  const summaryBusy = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(req.url, "http://localhost");
      if (
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      ) {
        send(res, { error: "Cross-origin requests are not allowed" }, 403);
        return;
      }
      if (req.headers["sec-fetch-site"] === "cross-site") {
        send(res, { error: "Cross-site requests are not allowed" }, 403);
        return;
      }
      if (
        req.method === "GET" &&
        ["/", "/domain_masst", "/domain_masst.html"].includes(url.pathname)
      ) {
        await serveFile(res, path.join(here, "templates/domain_masst.html"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        send(res, {
          treeBase: jobs.treeBase,
          api: jobs.api,
          dataDir: root,
          maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 2147483648),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/jobs") {
        send(res, jobs.list());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/jobs") {
        const tmp = path.join(root, randomUUID() + ".upload");
        try {
          const options = JSON.parse(
            decodeURIComponent(req.headers["x-masst-options"] || "%7B%7D"),
          );
          await upload(
            req,
            tmp,
            Number(process.env.MAX_UPLOAD_BYTES || 2147483648),
          );
          const result = await jobs.create(
            tmp,
            url.searchParams.get("name") || "input.txt",
            options,
            url.searchParams.get("label"),
          );
          send(res, result, 201);
        } finally {
          await rm(tmp, { force: true });
        }
        return;
      }
      const match = url.pathname.match(
        /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(.*))?$/,
      );
      if (!match) {
        send(res, { error: "Not found" }, 404);
        return;
      }
      const [, id, action = ""] = match,
        job = jobs.get(id),
        dir = jobs.dir(id);
      if (req.method === "GET" && action === "") {
        const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
        send(res, {
          ...jobs.summary(job),
          queries: job.queries.slice(offset, offset + 200),
          offset,
        });
        return;
      }
      if (req.method === "POST" && action === "resume") {
        if (summaryBusy.has(id)) {
          send(res, { error: "Wait for the summary to finish." }, 409);
          return;
        }
        send(res, await jobs.start(id));
        return;
      }
      if (req.method === "POST" && action === "pause") {
        send(res, await jobs.pause(id));
        return;
      }
      if (req.method === "POST" && action === "summary") {
        if (jobs.active.has(id) || summaryBusy.has(id)) {
          send(
            res,
            {
              error:
                "Wait for processing to finish or pause before summarizing.",
            },
            409,
          );
          return;
        }
        summaryBusy.add(id);
        try {
          const opts = await body(req);
          send(
            res,
            await summaries(job, dir, {
              minimum: opts.minimum,
              binary: opts.binary,
              quantFile: opts.useQuant
                ? path.join(dir, "quant.csv")
                : undefined,
            }),
          );
        } finally {
          summaryBusy.delete(id);
        }
        return;
      }
      if (req.method === "PUT" && action === "quant") {
        if (summaryBusy.has(id)) {
          send(res, { error: "Summary in progress" }, 409);
          return;
        }
        summaryBusy.add(id);
        try {
          await upload(
            req,
            path.join(dir, "quant.csv.part"),
            Number(process.env.MAX_UPLOAD_BYTES || 2147483648),
          );
          await rename(
            path.join(dir, "quant.csv.part"),
            path.join(dir, "quant.csv"),
          );
          send(res, { ok: true });
        } finally {
          summaryBusy.delete(id);
        }
        return;
      }
      if (req.method === "GET" && action === "archive") {
        const entries = ["job.json"];
        for (const q of job.queries.filter((q) => q.status === "complete"))
          for (const f of await jobs.files(id, q.id))
            entries.push(q.id + "/" + f);
        try {
          for (const f of await readdir(path.join(dir, "summary")))
            if (/\.csv$/.test(f)) entries.push("summary/" + f);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        res.writeHead(200, {
          "Content-Type": "application/x-tar",
          "Content-Disposition": `attachment; filename="masst-${id}.tar"`,
        });
        await pipeline(Readable.from(tarFiles(dir, entries)), res);
        return;
      }
      const files = action.match(/^queries\/(\d{6,})\/files(?:\/([^/]+))?$/);
      if (req.method === "GET" && files) {
        const list = await jobs.files(id, files[1]);
        if (!files[2]) send(res, list);
        else if (list.includes(files[2])) {
          const file = path.join(dir, files[1], files[2]);
          if (url.searchParams.has("preview") && files[2].endsWith(".tsv")) {
            const rows = [];
            for await (const row of csvRows(file, "\t")) {
              rows.push(row);
              if (rows.length >= 200) break;
            }
            send(res, rows);
          } else await serveFile(res, file, url.searchParams.has("download"));
        } else send(res, { error: "File not found" }, 404);
        return;
      }
      const summaryFile = action.match(/^summary\/([a-zA-Z_]+\.csv)$/);
      if (req.method === "GET" && summaryFile) {
        await serveFile(res, path.join(dir, "summary", summaryFile[1]), true);
        return;
      }
      send(res, { error: "Not found" }, 404);
    } catch (error) {
      if (!res.headersSent)
        send(
          res,
          { error: error.message },
          error.status || (error.code === "ENOENT" ? 404 : 400),
        );
      else res.destroy(error);
    }
  });
  return { server, jobs };
}
async function lock(root) {
  await mkdir(root, { recursive: true });
  const file = path.join(root, "server.lock");
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      const h = await open(file, "wx");
      await h.writeFile(String(process.pid));
      await h.close();
      return () => rm(file, { force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(await readFile(file, "utf8"));
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err.code === "ESRCH") {
          await rm(file);
          continue;
        }
        throw err;
      }
      throw new Error(
        "Another server owns this data directory (PID " + pid + ").",
      );
    }
  throw new Error("Could not acquire data directory lock");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(process.env.DATA_DIR || path.join(here, "var")),
    unlock = await lock(root);
  try {
    const { server, jobs } = await makeApp({ root });
    const port = Number(process.env.PORT || 3000),
      host = process.env.HOST || "127.0.0.1";
    server.listen(port, host, () => {
      const browserHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
      const url = `http://${browserHost.includes(":") ? `[${browserHost}]` : browserHost}:${server.address().port}`;
      console.log(`batchMASST Desk: ${url}\nData: ${root}\nKeep this window open. Stop with Ctrl+C.`);
      if (process.argv.includes("--open")) {
        const [command, args] = process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
            : ["xdg-open", [url]];
        execFile(command, args, (error) => {
          if (error) console.error(`Could not open your browser. Open ${url} manually.`);
        });
      }
    });
    server.on("error", async (error) => {
      console.error(error);
      await unlock();
      process.exit(1);
    });
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, async () => {
        if (closing) return;
        closing = true;
        server.close();
        await jobs.close();
        await unlock();
        process.exit(0);
      });
  } catch (e) {
    await unlock();
    throw e;
  }
}
