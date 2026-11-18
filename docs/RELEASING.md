# Releasing LDA Local Graph

Use Node.js 24 and git flow. Releases are published from `coding-koala-io/lda-graph`.

1. Run `git flow release start X.Y.Z` from `develop`.
2. Bump package.json and package-lock.json versions and date the CHANGELOG release entry. LICENSE.md is the standard Apache License 2.0 text with no version or date in it, so it is not changed for a release.
3. Run `npm test`, then `npm run release:build`. Unpack the ZIP into an empty folder and start `node src/server.js` with `PORT=0`; verify /health reports graph and the release version. Review dist/manifest.json and SHA256SUMS.
4. Run `npm run screenshots` against the same release checkout after packaging, before tagging. This is a required release step: it regenerates every UI image from the current server with made-up demo content. Use an installed Chromium-family browser; see [CONTRIBUTING.md](../CONTRIBUTING.md#screenshots). Include the regenerated `docs/media/screens/` files in the release. Save the command's added/changed/unchanged/removed file list in the release pull request. Have an independent reviewer check **each** image at its native 360 px or 720 px width for readable text, the whole screen including its footer, and no clipped content. Log the reviewer's name, file list and pass/fail result in that pull request; correct and regenerate any failed image before release. Keep the README demo GIFs unchanged. This documented gate keeps `npm test` and `npm run release:build` usable on machines without a browser.
5. Run `git flow release finish X.Y.Z`; ensure the tag is exactly `v` plus the package.json version.
6. Run `git push origin main develop --tags`. The Windows release workflow tests, packages and publishes the ZIP, SHA256SUMS and manifest with the matching CHANGELOG section.

The manifest records the source commit: LDA_RELEASE_COMMIT when set (the release workflow passes the tagged commit), otherwise the output of git rev-parse HEAD, otherwise null. Release notes come from the CHANGELOG section for the version, which must carry a YYYY-MM-DD date; a section still headed unreleased makes the release workflow fail.
