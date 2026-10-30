# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Changed

- New jobs retrieve domain trees and metadata from the latest `master` branch of
  `robinschmid/microbe_masst`, replacing the pinned commit from
  `wilhan-nunes/microbe_masst`. Existing jobs retain their saved source and cached
  references. `TREE_BASE_URL` can still override the source or pin a commit for
  reproducible downloads.
- Updated the README to explain the live upstream source and reference caching.

### Added

- This changelog to track notable changes by release.
