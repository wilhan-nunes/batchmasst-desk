# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Planned version: **1.1.0**.

### Changed

- New jobs retrieve domain trees and metadata from the latest `master` branch of
  `robinschmid/microbe_masst`, replacing the pinned commit from
  `wilhan-nunes/microbe_masst`. Existing jobs retain their saved source and cached
  references. `TREE_BASE_URL` can still override the source or pin a commit for
  reproducible downloads.
- Updated the README to explain the live upstream source and reference caching.

### Added

- Job inspection banner for FASST connection failures, server errors, and rate
  limits. Shows when result requests are retrying, clears recovered warnings,
  and offers resume guidance when requests fail or the job stops.
- This changelog to track notable changes by release.

## [1.0.0] - 2026-10-30

Initial standalone application, recorded in the initial repository commit.

### Added

- Batch spectral searches from MGF files, USI tables, and pasted identifiers.
- Six domain outputs, interactive trees, and downloadable result tables.
- Persistent jobs with pause/resume, configurable workers, saved parameter
  summaries, and estimated completion times.
- Invalid MGF scan skipping with identifiers and reasons.
- Double-click launchers for macOS and Windows.

[Unreleased]: https://github.com/wilhan-nunes/batchmasst-desk/compare/925d708...HEAD
[1.0.0]: https://github.com/wilhan-nunes/batchmasst-desk/commit/925d708
