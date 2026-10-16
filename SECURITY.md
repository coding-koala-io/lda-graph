# Security policy

LDA Local Graph is a development-only tool, published by Coding Koalas Pty Ltd (ACN 668 775 433). It is meant to run on a single developer machine, bound to that machine (127.0.0.1, the default). Never expose it to a network others can reach, and never point a shared, staging or production site at it: it is not built to resist attackers.

## Reporting a vulnerability

Email **security@codingkoala.io** with "SECURITY" in the subject. Please include the version, what you found, how to reproduce it and its impact. Do not open a public GitHub issue for security problems.

We aim to acknowledge reports within 2 business days (Sydney time).

## Supported versions

Only the latest release receives fixes.

## Out of scope

Behaviour that only matters when the tool is exposed to other machines or used in production is out of scope, because both are unsupported. Reports about such setups are still welcome if the documentation makes them look safe.
