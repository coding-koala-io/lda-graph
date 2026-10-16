# Legal rules for contributions

By opening a pull request you confirm all of the following.

## You must NOT submit
1. **Vendor code**: any source code, decompiled or disassembled code, IL, binaries, assemblies, NuGet packages or minified scripts from Optimizely or any other vendor, or code written by looking at such material.
2. **Captured traffic or data**: HTTP recordings, HAR files, logs, database dumps or screenshots from real sites, real Optimizely accounts, employers or clients, or anything containing personal information, credentials, keys, tokens or customer content. Tests must use synthetic data.
3. **Vendor text and design**: copied documentation, error-message text longer than a short protocol identifier, user-interface markup or styles, icons or images.
4. **Trademarks**: logos or brand assets of Optimizely or anyone else, or new names that put another company's mark first.
5. **Confidential information**: anything you received under an NDA, partner portal, early-access programme, employment or client agreement.
6. Anything that would make this project work in production or as a hosted service, or that gets around licence checks.

## Describing how you know a behaviour
In the pull request, say briefly where the behaviour comes from (for example "public docs URL", or "observed from my own local CMS 13 site using my own licence"). If it came from analysing vendor binaries, **do not submit code**. Open an issue describing the behaviour in your own words and a maintainer will handle it under the clean-room process.

## Developer Certificate of Origin

Every commit must be signed off (`git commit -s`), certifying the Developer Certificate of Origin 1.1 (https://developercertificate.org/): your contribution is original or you have the rights needed to submit it.

## Licence of contributions

Contributions are licensed to you and us under the same licence as this repository (Business Source License 1.1). By contributing you also grant Coding Koalas Pty Ltd a perpetual, worldwide, royalty-free licence to use, modify and relicense your contribution, including under other licence terms.

Publisher: Coding Koalas Pty Ltd (ACN 668 775 433). Legal questions: legal@codingkoala.io.

Maintainers may remove any contribution that breaks these rules.

## Tests and branches

Use Node.js 24 or later. Install dependencies with `npm ci`, then run `npm test`; all tests must pass before a pull request. Use synthetic data only.

Branch from `develop` with `feature/<name>` and open pull requests back to `develop`. Use `release/X.Y.Z` for release preparation and `hotfix/<name>` for urgent fixes from `main`; merge releases and hotfixes into both `main` and `develop`. See [docs/RELEASING.md](docs/RELEASING.md). Last updated: 2026-10-16.
