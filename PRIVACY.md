# Privacy — LDA Local Graph

Published by Coding Koalas Pty Ltd (ACN 668 775 433). Last updated: 2026-10-16.

LDA Local Graph ("the tool") is a development-only local stand-in compatible with Optimizely Graph for CMS 13, part of Local Developer Accelerator for Optimizely by Coding Koala.

## Summary
- The tool runs on your own computer.
- It has no telemetry, analytics, crash reporting or tracking. Coding Koala receives no tool data.
- It stores copies of CMS content on your disk. Treat that folder as sensitive.

## Network connections

| When | Destination | What is sent |
|---|---|---|
| Installing as a Windows service (once) | github.com (WinSW release download) | A normal download request, including your IP address |
| Checking for updates through the LDA CLI (when requested or automatic checks enabled) | api.github.com / registry.npmjs.org | Your IP address and current version; the Graph server does not perform update checks |
| Opening the GraphiQL page | cdn.jsdelivr.net (browser loads the editor) | Your IP address and browser details |

Other runtime traffic is between your CMS site, browser and local Graph server. Keep it bound to loopback (127.0.0.1).

## What is stored

The Windows service defaults to `C:\ProgramData\Coding Koala\Local Developer Accelerator\Graph`. Source runs default to `./tenants.json`, `./data` and `./logs`, or configured `TENANTS_FILE`, `DATA_DIR` and `LOG_DIR` paths.

- CMS content and content types, **including drafts and unpublished content**, plus personal data that content contains.
- Tenant keys and secrets in `tenants.json`.
- Synchronization jobs, journals, webhooks and content-source metadata.
- Request logs that can contain request and response bodies. Authorization credentials and URL `auth` values are redacted; content in bodies is not. Set `LOG_BODIES=false` to omit bodies.

The service installer restricts runtime data to administrators, SYSTEM and the service account. Source runs inherit your folder permissions. Do not copy data to shared drives, tickets or source control.

## Your responsibility

If CMS content contains personal data, you (or your employer or client) remain responsible for it under applicable law, including the Privacy Act 1988 or GDPR where applicable. Coding Koala does not receive this local data or process it for you. Prefer synthetic test data.

## Deleting data

- One tenant: use Delete tenant in its dashboard and choose to remove its data and logs.
- Logs only: use Clear request log in the tenant dashboard.
- Everything: stop the server or service, then delete its configured tenant file, data and logs. The Windows service's `uninstall -RemoveData` option removes its runtime folder; uninstall without that option retains data.

## Contact

Privacy: privacy@codingkoala.io. Security: security@codingkoala.io. Legal: legal@codingkoala.io.
