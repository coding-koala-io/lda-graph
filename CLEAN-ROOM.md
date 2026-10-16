# How this software was built (clean-room record)

LDA Local Graph is published by Coding Koalas Pty Ltd (ACN 668 775 433).

This document records how the compatible behaviour in this repository was worked out and written, so anyone can see that it was created independently.

## 1. Sources of knowledge
Behaviour was worked out from three sources only:
1. **Public documentation** published by Optimizely and others (developer docs, public SDK documentation, public API references).
2. **Observed network traffic** between Optimizely CMS 13 sites that the author ran locally, from NuGet packages, under the author's own licence and development setup, and local recording endpoints. The author confirmed on 2026-10-16 that no customer's or client's site, account, subscription, credentials or data was used, and no partner-portal, early-access or NDA material was used. The research ran under the author's own Optimizely CMS development setup.
3. **Private interoperability analysis** of Optimizely NuGet package assemblies held under that licence. This was done only to find out how the CMS talks to these services, and only where that information was not available from sources 1–2. It relies on the interoperability exceptions in law (for example s 47D of the Copyright Act 1968 (Cth); article 6 of Directive 2009/24/EC).

## 2. Separation between research and code
- Research notes, decompiled output and traffic captures are kept in private folders outside every repository. They have never been committed, published or shared.
- From that research the author wrote **functional specifications** in his own words: endpoints, fields, status codes and behaviour needed for a CMS 13 site to work. Specifications do not contain decompiled code or copied text beyond the short identifiers needed to interoperate (for example header names, field names and path segments).
- The code was then written from those specifications by AI coding agents and the author, who were given the specification, not the decompiled code or captures. A different model reviewed each build.
- Error messages, page text and documentation are original wording, except for short protocol tokens that have to match exactly.

## 3. What this repository does and does not contain
Contains: original code, original documentation, synthetic test data.
Does not contain: Optimizely source or decompiled code, binaries, assemblies, NuGet packages, user interface, images, logos, documentation text, recorded traffic, customer content, or names of test sites.

## 4. Audits
Before each public release, the full git history is checked for decompiled code, traffic captures, customer or test-site names and long verbatim vendor text. Record of audits:

| Date | Commit range | Checked by | Result |
|---|---|---|---|
| 2026-10-16 | all commits in the published history | independent AI reviewer | clean |

Public repositories are published with a fresh history that starts at the first release.

## 5. Retention of private research
Governed by the internal research-handling policy. In short: decompiled output and raw captures are deleted once the specifications are final and verified. Only the specifications and a list of where each fact came from are kept, privately, as evidence of independent creation.

## 6. Questions
legal@codingkoala.io
