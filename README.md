# batchMASST Desk

*Batch spectral searches across biological domains.*

A portable Node.js service and a single, self-contained HTML frontend, ported from
[`wilhan-nunes/microbe_masst`, `fasst_api`](https://github.com/wilhan-nunes/microbe_masst/tree/fasst_api)
at `d9d797e936c630c656fed65e8ec50b4f99d3d59c`.

## Run on Windows, macOS, or Linux

For double-click startup, install **Node.js 22.13 or newer** (including npm), then open:

- **macOS:** `Launch batchMASST Desk.command`
- **Windows:** `Launch batchMASST Desk.bat`

The launcher installs missing dependencies, starts the server, and opens your
default browser once the server is listening. Keep the terminal window open;
press **Ctrl+C** to stop the app. Start only one copy at a time.
If macOS reports that the launcher is not executable, run
`chmod +x "Launch batchMASST Desk.command"` from the app folder once.
If macOS blocks folder access, move the app to `~/Projects/batchmasst-desk` or allow your
terminal access in System Settings → Privacy & Security → Files and Folders.

For command-line startup:

Install **Node.js 22.13 or newer** (including npm), copy this entire `batchmasst-desk`
folder anywhere, and run from that folder:

```text
npm ci
npm start
```

Open **http://127.0.0.1:3000**. Stop with Ctrl+C. Run checks with `npm test`.
The backend uses Node's built-in SQLite module; Node 22 may print an experimental
SQLite warning. Dependencies are JavaScript only, with no native compilation,
Python, Flask, database server, shell utilities, CDN, or frontend build step.

The app is standalone **as an application folder**, not as a double-clicked HTML
file or a bundled native executable. The Node service serves the page and its API
from the same origin. Opening the HTML with `file://` does not start the service.
Installation needs npm registry access; searches need FASST and first use of a
domain needs GitHub. Downloaded HTML tree reports work offline.

## Workflow

1. Drop an MGF, CSV/TSV of USIs, or text list; alternatively paste one USI or
   CCMSLIB accession per line. The example button loads a real search accession.
2. Set search parameters, public index/reference library, and selected domains.
   **Number of workers** controls parallel spectra (1–10, default 3). Increasing
   it above 3 displays a reminder to respect the shared FASST server's capacity.
3. Create the job. Inputs and results are stored by the Node service, even after
   the browser closes. Only spectra/USIs and search parameters go to FASST.
4. Inspect tables or interactive trees; download individual artifacts or a TAR
   archive of all completed outputs. Windows 11, macOS, and common Linux archive
   tools can open TAR archives.
   The job inspection panel shows its saved parameters. Running jobs show an
   approximate remaining time and completion date once spectra finish, based on
   throughput during the current run. Estimates reset on resume and exclude
   reference setup time; server load and spectrum size can affect accuracy.
5. After interruption, start the same service/data folder, open the saved job,
   and choose **Resume / retry failures**. Completed spectra are skipped.

The job panel displays a warning when FASST requests encounter connection errors,
server errors, or rate limits. It indicates automatic result-request retries and
clears each spectrum's warning when its request recovers. After retries stop or a
submission fails, it offers resume guidance. This reflects observed requests, not
a separate service health check; a local connection issue can trigger it too.

CSV/TSV defaults: `USI` and optional `Compound` columns, configurable in the UI.
Quoted cells and BOMs are supported. Blank/comment lines are skipped. Malformed
identifiers fail validation visibly. MGF supports PEPMASS, CHARGE, SCANS, TITLE,
and SPECTRUMID. Intensities normalize to 100, round to one decimal, and peaks below
0.1 are removed. Spectra below the minimum retained peak count are skipped and
reported with their scan identifiers and reasons in the job details. Empty scans,
missing/invalid PEPMASS, and incomplete spectrum blocks are also skipped so valid
scans can run. Invalid peak rows are ignored and reported separately. If no valid
scans remain, the import error lists the skip reasons. Duplicate names remain
independent spectra with distinct numeric directories.

**Build trees from matches TSV** accepts `USI`, `Cosine`, `Matching Peaks`, and
`Delta Mass` columns without submitting a search. An import is one query; its
filename without extension is the feature ID for quantification summaries.

## Feature mapping

| Source workflow | Standalone app |
| --- | --- |
| `masst_client.py`: USI/accession and spectrum queries | Pasted IDs, tables, MGF; asynchronous FASST submit/poll |
| `masst_batch_client.py`, `jobs.py`, `batch_job.py` | Persistent batch queue, 1–10 concurrent spectra, pause/resume, per-spectrum failures |
| `masst_utils.py` | Search parameters, peak normalization, mass/peak filtering, best match per file, analog mass bins |
| `masst_tree.py`, `json_ontology_extender.py` | Six domain metadata joins, counts, parent accumulation, fractions, combined trees |
| Existing-result draw mode | Upload matches TSV and produce trees without a new search |
| Tree visualizer and bundler | Offline HTML reports with SVG tree, collapse/expand, depth/zoom, node search, match links, node CSV/SVG/JSON downloads, library preview and search parameters |
| `masst_dataset_summary.py` | Per-domain feature matrices and optional MZmine binary/row-normalized sample summaries |
| Dataset/library tables | TSV downloads with filtered dataset frequencies and upstream titles; library annotations |

The viewer is a dependency-free implementation, not a pixel-identical copy of
D3/DataTables. Table and annotation previews are capped at 200 rows, and diagrams
at 200 visible nodes; downloads contain complete results. Raw JSON and filtering
are streamed/on disk, while individual reference/enriched trees and their matched
node lists are assembled in memory. Very large tree reports still need RAM.

R/Python notebooks for **maintaining upstream reference datasets**, statistics
experiments, and upstream data-generation scripts are not executed by this app;
it consumes their published outputs directly, as requested.

### Matching semantics

* Exact search: minimum matched peaks and absolute delta mass at or below the
  precursor tolerance, then highest cosine / matched-peak count per sample file.
* Analog search: no additional precursor-window filter locally (the upstream
  request supplies the window). `matches.tsv` retains the best hit per file across
  the analog window, matching this branch's behavior; it is **not exact-only**.
* `analog_matches.tsv` retains the best hit per file and rounded delta bin, using
  Python-compatible ties-to-even rounding. `unfiltered_matches.tsv` keeps all
  public-data matches. Library queries always use analog `No`.
* File USIs normalize to dataset plus filename stem, dropping path and scan.
  Metadata joins preserve multiple annotations of a file. Counts across ontology
  branches/domains can overlap, and analog bin counts can exceed sample counts.
* Empty successful results write header-only TSVs. Timeouts and errors are failed
  resumable work, never mislabeled as successful zero-hit spectra.
* Library searches run even for zero public-data hits. Dataset titles are retained.
  These intentionally fix omissions in the Python flow.

## Direct upstream trees

Nothing under upstream `data/` is bundled. The default source is:

```text
https://raw.githubusercontent.com/robinschmid/microbe_masst/master/data/
```

Each job downloads only selected `*_masst_tree.json` and `*_masst_table.csv` files
(`microbiome` uses TSV), directly from `robinschmid/microbe_masst`. The default
follows the latest files on its `master` branch at download time. The selected
source URL is saved in `job.json`. References are cached and indexed with SQLite
**once per job**, so later spectra do indexed joins instead of rescanning large
CSVs. The first run therefore takes longer.

Set `TREE_BASE_URL` to a raw data URL ending in `/` to override the source. For
reproducible downloads, replace `master` with a specific commit SHA; the live
branch can change between file downloads. Existing jobs retain their saved source
and cached files. Create a new job to use the updated default.

## Durable storage and recovery

Default storage is `batchmasst-desk/var/`, ignored by Git:

```text
var/jobs/<uuid>/
  job.json                    # atomic manifest: parameters, inputs, task IDs, status
  input                       # original upload
  reference/                  # downloaded trees/tables and their SQLite indexes
  000001/
    input.json                # normalized query
    data.json                 # complete, validated FASST response
    library.json              # complete, validated library response
    matches.sqlite            # disk-backed filtering and deduplication
    result_matches.tsv
    result_library.tsv
    result_datasets.tsv
    result_counts_<domain>.tsv
    result_<domain>.json
    result_<domain>.html
    result_<domain>.tree.json  # internal snapshot used for summaries
  summary/                    # generated feature/sample CSVs
```

API responses stream through backpressure-aware pipelines into `.part` files;
only complete JSON responses with a results array are promoted to reusable files.
Task IDs are checkpointed immediately after submission. Final outputs are written
atomically before a spectrum is marked complete. SQLite handles sorting and
best-hit selection without loading full match tables into RAM. A partial download
is re-fetched from the saved task; this is **task/spectrum resume, not HTTP byte-range
resume**. Successfully downloaded data/library phases are reused independently.

On server restart, running jobs become `interrupted` and wait for explicit Resume.
Polling timeouts retain IDs; expired (HTTP 404/410) or explicitly failed tasks are
cleared for resubmission on the next Resume. There is an unavoidable small window
between upstream accepting a POST and persisting its returned task ID: a crash
there may submit that task again, because the upstream API offers no idempotency
key. Local outputs remain isolated and are not appended twice.

One batch runs at a time, with bounded concurrency inside it. Pause aborts active
network calls; a local export already in progress finishes before pausing. Closing
the browser does not pause jobs. Keep free disk space available for responses,
indexes, and exports. A process lock prevents two normal server instances from
sharing a data directory. This is a single-user local service, with no login;
keep the default loopback binding unless providing your own authenticated proxy.

To move between machines: stop the server, copy the whole folder **including
`var/`** (or your custom `DATA_DIR`), install Node/dependencies, then start. SQLite
and JSON storage are portable. The output TAR is for sharing results, not a full
resume backup. If moving after a hard crash, remove a leftover `server.lock` only
after verifying the original server is stopped.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Listening address |
| `DATA_DIR` | `<app-folder>/var` | Persistent storage location |
| `FASST_API_URL` | `https://api.fasst.gnps2.org/` | Server-side search API; saved per job |
| `TREE_BASE_URL` | Latest upstream `master/data/` raw URL above | Source for new jobs |
| `MAX_UPLOAD_BYTES` | `2147483648` | Upload size limit (2 GiB) |

macOS/Linux:

```sh
DATA_DIR="$HOME/masst-data" PORT=3000 npm start
```

Windows PowerShell:

```powershell
$env:DATA_DIR = "$HOME\masst-data"
$env:PORT = "3000"
npm start
```

Optional container:

```text
docker compose up --build
```

Compose binds localhost port 3000 and uses a named persistent volume. Do not use
`docker compose down -v` if you want to retain jobs.

## NextGenWebApps integration

`templates/domain_masst.html` follows the starter's palette, cards, drop zone,
status banner, metadata tags, capped tables, and single-file frontend pattern.
There are no Jinja delimiters or runtime CDN dependencies. The explicit Node/disk
requirement supersedes the starter's browser-only computation rule: this page
requires the accompanying Node API. Merely copying it into NextGenWebApps or its
static sandbox is insufficient. For integration, serve `/api/` from this Node
service behind the same origin; do not add wildcard CORS.

## Verification and attribution

`npm test` covers parsing, exact/analog matching, tree outputs, empty results,
truncated downloads, timeout/terminal failure recovery, concurrent checkpoints,
pause, hard process crash recovery, HTTP uploads/downloads, quantification,
source escaping, and origin/path restrictions. Integration tests use a local mock
FASST server; they make no external search submissions.

Manual validation during this port on Linux/Node 22.23.4 included all six real
upstream datasets, a live FASST search, Chromium at 900px, output/tree browsing,
and JSON/TAR downloads. Windows/macOS execution has not been tested here.

Source-port license: MIT, Copyright (c) 2023 Robin Schmid; see `LICENSE`.
Please cite [microbeMASST](https://doi.org/10.1038/s41564-023-01575-9).
Implementation references: [Node SQLite](https://nodejs.org/api/sqlite.html),
[stream-json](https://github.com/uhop/stream-json), and
[csv-parse streaming API](https://csv.js.org/parse/api/async_iterator/).

## License and attribution

Distributed under the [MIT License](LICENSE). The original copyright notice
(Copyright © 2023 Robin Schmid) is preserved. This app was ported from the
`wilhan-nunes/microbe_masst` `fasst_api` branch at the commit linked above; the
feature mapping describes the corresponding source modules. Scientific citation
information is included in the app.

## Source folder

This folder contains the application source, tests, dependency lockfile, and
macOS/Windows launchers. Installed dependencies (`node_modules/`), local job data
(`var/`), caches, and temporary outputs are excluded from version control.
Use the default storage folder or keep custom `DATA_DIR` locations outside the
source folder. Install dependencies with `npm ci` or use a launcher.
