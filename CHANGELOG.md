# Changelog

Not affiliated with or endorsed by Optimizely.

All notable changes are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.

## [1.3.0] - 2026-11-18

### Added
- The README shows how to start Local Graph on Linux and macOS with the CLI (`lda run graph`).
- The repository includes full-page Local Graph screenshots at 360 and 720 pixels, taken from a running demo with made-up content.
- The release ZIP includes the security policy and instructions for reporting a vulnerability.

### Changed
- Standalone Local Graph pages show the Apache 2.0 licence and the affiliation disclaimer. They link to Coding Koala except on Privacy and Legal notice, which credit Coding Koala in plain text. About lists version, CMS compatibility, source and copyright details and links to the legal notice.
- The query editor inside the CMS has a simpler footer with the product version, a development-use notice and an About link. Its Tenants and About links open in a new tab.
- The standalone query editor’s Tenants, About, Privacy and Licence links now open in the same tab. They previously opened in new tabs.
- The README explains CMS compatibility, who builds Local Graph, what it connects to and how it is maintained. The package and Windows service descriptions also credit Coding Koala, and the startup message shows the version and listening address.

### Fixed
- On narrow screens, dashboard table rows stack with a label for each value, including after counts refresh.
- The standalone query editor stacks the query and its Variables and Headers controls above the response on narrow screens. The response grows to fit its contents.

## [1.2.3] - 2026-11-05

### Changed
- README: the 43-second demo (animated GIF near the top) and a link to the video on YouTube.

## [1.2.2] - 2026-11-04

### Changed
- README headline: a local development tool compatible with Optimizely CMS 13.

## [1.2.1] - 2026-11-04

### Changed
- README: "Our senior developer reviews and tests every change." (singular).

## [1.2.0] - 2026-11-04

### Changed
- Licence changed to Apache 2.0; earlier versions stay under the Business Source License 1.1. Versions up to and including 1.1.0 keep that licence. LICENSE.md is now the standard Apache License 2.0 text, and a NOTICE file ships with every release.
- Product name is now "Local Developer Accelerator (LDA), compatible with Optimizely CMS 13" in the documents, About page and page banner.
- Legal notice: production wording now reads "Not designed or tested for production use. Provided 'as is', without warranties, under sections 7 and 8 of the Apache License 2.0. Nothing here limits rights you have under law that cannot be excluded."
- README: new top section with a 2-minute quick start through the one-line installer, what it does not do, and the licence section for Apache 2.0.

## [1.1.0] - 2026-10-19

### Changed
- Add per-slot type, ID, key and URL indexes, compiled filters, full-text token caching and precomputed sort keys while retaining query results and order.
- Persist consistent snapshots under continuous pushes, replace soft-deleted records and skip redundant shutdown snapshots.
- Keep stores unloaded on the main dashboard and explorer picker; log first-load size and duration.
- Expire previous rebuild slots after 24 hours by default; configure retention with `PREVIOUS_SLOT_HOURS`.
- Add `MEMORY_RECYCLE_MB`, WinSW detection, connection draining, store flushing, exit 75 and a persisted hourly cooldown; expose status in admin health.
- Add query, memory, compatibility and shutdown benchmarks; document measured performance and configuration.

## [1.0.2] - 2026-10-16

### Fixed
- Release build on GitHub: the permission test no longer assumes a non-admin file owner. The 1.0.1 tag was never released; 1.0.2 contains all 1.0.1 fixes.

## [1.0.1] - 2026-10-16

### Fixed
- Windows service script: paths with 8.3 short names are canonicalised before comparison; Windows PowerShell 5.1 child processes no longer inherit PowerShell 7's module path.
- Re-applying permissions to an already locked folder no longer needs the audit privilege.

## [1.0.0] - 2026-10-16

### Changed
- Rebranded as LDA Local Graph, part of Local Developer Accelerator (LDA), compatible with Optimizely CMS 13. Built by Coding Koala.
- Adopted Business Source License 1.1 for non-production use, converting to Apache 2.0 on the Change Date.
- Renamed the Windows service and its default runtime folder.

### Added
- About, privacy, licence and legal notice pages with development-use banners and footers.
- Product, version and dataVersion fields in /health.
- Data version guard that refuses data from a newer format.
- Network exposure warning at startup.
- Release packaging with ZIP, SHA-256 sums, manifest and Windows CI/release workflows.
