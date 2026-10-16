# Changelog

All notable changes are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.

## [1.0.0] - 2026-10-16

### Changed
- Rebranded as LDA Local Graph, part of Local Developer Accelerator for Optimizely by Coding Koala.
- Adopted Business Source License 1.1 for non-production use, converting to Apache 2.0 on the Change Date.
- Renamed the Windows service and its default runtime folder.

### Added
- About, privacy, licence and legal notice pages with development-use banners and footers.
- Product, version and dataVersion fields in /health.
- Data version guard that refuses data from a newer format.
- Network exposure warning at startup.
- Release packaging with ZIP, SHA-256 sums, manifest and Windows CI/release workflows.
