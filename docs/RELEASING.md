# Releasing LDA Local Graph

Use Node.js 24 and git flow. Releases are published from `coding-koala-io/lda-graph`.

1. Run `git flow release start X.Y.Z` from `develop`.
2. Bump package.json and package-lock.json versions, date the CHANGELOG release entry, and set LICENSE.md's Licensed Work version and Change Date (four years after release).
3. Run `npm test`, then `npm run release:build`. Unpack the ZIP into an empty folder and start `node src/server.js` with `PORT=0`; verify /health reports graph and the release version. Review dist/manifest.json and SHA256SUMS.
4. Run `git flow release finish X.Y.Z`; ensure the tag is exactly `v` plus the package.json version.
5. Run `git push origin main develop --tags`. The Windows release workflow tests, packages and publishes the ZIP, SHA256SUMS and manifest with the matching CHANGELOG section.

The manifest records the source commit: LDA_RELEASE_COMMIT when set (the release workflow passes the tagged commit), otherwise the output of git rev-parse HEAD, otherwise null. Release notes come from the CHANGELOG section for the version, which must carry a YYYY-MM-DD date; a section still headed unreleased makes the release workflow fail.
