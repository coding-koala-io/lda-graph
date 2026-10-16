# HTTP protocol

This server receives type models and documents from CMS 13 clients and serves them through GraphQL. Credentials select a tenant; each tenant has separate types, documents, slots, journals, jobs, webhook registrations and request history. Paths below are relative to the gateway address.

## Client configuration and authentication

The client configures `Optimizely:ContentGraph` with `GatewayAddress`, `AppKey`, `Secret` and `SingleKey`. `GatewayAddress` is the server base URL. `Secret` is a raw password for Basic authentication and a Base64-encoded signing key for preview tokens; the CMS preview service requires valid Base64.

Push endpoints require `Authorization: Basic <base64(AppKey:Secret)>`. The server routes Basic credentials by AppKey and checks the raw secret. `og-job-id` associates requests with a synchronization job. In the default environment-only configuration, empty Basic settings accept any valid Basic credentials; configured AppKey and Secret must both be present.

GraphQL supports three authentication modes:

| Mode | Request | Visibility |
| --- | --- | --- |
| Basic | `Authorization: Basic <base64(AppKey:Secret)>` | Includes drafts and expired content. Optional ACL headers constrain access. Required for slot mutations. |
| Single | `Authorization: epi-single <SingleKey>` or `?auth=<SingleKey>` | Published, unexpired, undeleted content readable by Everyone. |
| Preview | `Authorization: Bearer <jwt>` | Drafts and other content allowed by the token's user and role ACLs. Cannot push content or execute slot mutations. |

Preview tokens use HS256 with the Base64-decoded tenant secret, `graph` issuer and audience, and an appKey claim matching the tenant. Token `sub` and `role` claims supply username and roles, overriding request ACL headers. Expired tokens are accepted and logged. An empty secret in the environment-only configuration skips signature verification. Unknown credentials return 401; tenant credentials grant no dashboard administration rights.

## Type models and startup

| Endpoint | Behavior |
| --- | --- |
| `GET /api/content/v3/types?id=<source>` | Returns that source's stored model or 404 when missing. Omitted `id` selects `default`. |
| `PUT /api/content/v3/types?id=<source>` | Replaces that source's type model and rebuilds the query schema. Omitted `id` selects `default`. Returns 200 with `{}`. |
| `POST /api/content/v3/types?id=<source>` | Merges a partial model into that source's existing model and rebuilds the schema. Omitted `id` selects `default`. Returns 200 with `{}`. |

The CMS checks the default model during startup and expects `contentTypes._Item`. If absent, the client uploads its full model. An unavailable gateway or rejected credentials can prevent CMS startup.

The JSON model describes `languages`, `links`, `contentTypes`, `propertyTypes`, `preset` and `useTypedFieldNames`. A content type has `abstract`, `contentType` base names and `properties`; a property defines its `type`, `searchable`, `index` and optional `ref`. Property types can extend a `base`. A language-only POST is valid.

Each slot stores independent models by content source ID. Its query schema starts with `default` and adds `contentTypes` and `propertyTypes` from every additional source. Without a default model, only the startup built-ins are available. On a type-name clash, the default definition wins; otherwise the first stored source defining the name wins. A warning summarizes clashes once per rebuild. Languages and links come from `default`. Source models remain unchanged when combined for the schema.

Additional sources index documents through the same `/_stream` endpoint. Their concrete types are queryable through `/content/v2` and can be selected by fragments on referenced `ContentReference.item` values. The tenant dashboard lists source IDs, content type counts and document counts by source types; the explorer lists concrete types across all sources with counts by `__typename`.

Built-in content families include `_Item`, `_AssetItem`, `_ImageItem`, `_Content`, `_Page`, `_Component`, `_Folder`, `_Media`, `_Image` and `_Video`. Concrete pages, blocks and media inherit the corresponding interfaces. An abstract type such as `_Content` exposes `_IContent`; a model reference such as `{ "type": "IData", "ref": { "type": "Data", "id": "_id" } }` resolves a document by its ID in the selected slot.

## Bulk indexing

`POST /_stream` accepts `Content-Type: application/x-ndjson`. Each action occupies a JSON line. An `index` action is followed by its document; `delete_by_paths` is followed by a paths object; `delete` has no source line. A client can send multiple operations in one batch.

```json
{"index":{"_id":"10000000-0000-4000-8000-000000000001_en_Published","language_routing":"en","_snapshotTime":"2026-01-02T12:00:00Z"}}
{"__typename":"HomePage","_metadata":{"key":"10000000000040008000000000000001","locale":"en","version":"3","status":"Published","types":["HomePage","_Page","_Content","_Item"]},"_rbac":["r:Everyone:Read"],"Heading$$String___searchable":"Home"}
{"delete":{"_id":"10000000-0000-4000-8000-000000000002_en_Published","_hardDeleted":true,"_snapshotTime":"2026-01-02T12:00:01Z"}}
{"delete_by_paths":{"_hardDeleted":true,"_snapshotTime":"2026-01-02T12:00:01Z"}}
{"paths":[["_metadata.key","10000000000040008000000000000003"],["_metadata.version","3"],["_metadata.locale","en"]]}
```

The response is HTTP 200 with exactly `{ "journalId": "<id>" }`. Operations execute synchronously in order. Per-operation results and failures appear in the stream journal, rather than the indexing response. Malformed operations are recorded as failures while later valid operations can still execute.

The client forms document IDs from a dashed GUID, an optional work-version suffix for unpublished versions, locale, status and optional variation. Metadata keys use GUID text, and `_metadata.version` is a string. Different locales and work versions remain separate documents.

`_snapshotTime` prevents stale indexes and deletes from replacing newer state. Timestamped deletes retain tombstones, including documents matched by path deletion. An index older than a tombstone is a `noop`; a newer index can restore content. `_hardDeleted: false` marks an existing document as deleted; hard deletion removes it. Tombstones belong to their slot and persist across restarts.

Document bodies contain `__typename`, `_metadata`, `_rbac` and content properties. `_rbac` entries use `r:<role>:Read` or `u:<user>:Read`. Metadata describes key, locale, version, types, display name, status, dates, paths and URLs. Media can also carry `_assetMetadata`, `_imageMetadata` and searchable extracted text; pages can carry `_pageMetadata`.

The server recursively normalizes field names: `Heading$$String___searchable` becomes `Heading`. Type suffixes include String, Int, Float, Boolean, DateTime and JSON. `___searchable` marks fulltext content; `___skip` preserves values for reading while excluding them from filtering and fulltext. Rich text, references, URLs and embedded content use nested objects with the same naming rules. Raw documents remain available through the management endpoints.

## Individual document updates

`POST /_doc/{id}?language_routing=<locale>&version=<slot>` accepts a JSON document. The `SnapshotTime` header supplies its update timestamp. `version=new` selects the pending slot; otherwise the request uses its normal slot selection. The response is HTTP 200 with `{ "result": "created" }`, `updated` or `noop` as appropriate. CMS save and publish events can use this endpoint for individual versions.

## Journals and synchronization jobs

After indexing batches, the client registers the returned journal IDs:

```http
POST /journal/indexing
Content-Type: application/json

{"id":"20000000-0000-4000-8000-000000000001","details":[{"id":"<journalId>","status":"Processing"}]}
```

Registration returns HTTP 200 with `{}`. `GET /journal/indexing/{jobId}` returns the registered body. `GET /journal/indexing/{jobId}/status` returns:

```json
{"id":"<jobId>","status":"Success","failingJournals":[],"error":null,"totalJournalIds":1,"succeededJournalIds":1,"failedJournalIds":0,"queuedJournalIds":0}
```

The server returns `Error` when a referenced journal reports errors and `Success` otherwise. Failure counters and `failingJournals` identify unsuccessful journals. The client sends `Processing` when registering and polls until `Success` or `Error`; nonterminal status values require further polling. Unknown jobs return 404.

`GET /journal/stream/{journalId}` returns `{ "took": 0, "errors": false, "status": "done", "items": [...] }`. Each item contains `index` with `Status`, `_id` and `Result`, including `created`, `updated`, `deleted`, `noop` or `not_found`; failed operations use error details and a failure status. The server also accepts the `stream/` prefix within a journal ID. Unknown journals return 404. Internal management timestamps and job bookkeeping are omitted from these wire responses. A tenant cannot retrieve another tenant's jobs or journals.

A full synchronization normally sends the type model, indexes content versions and registers the resulting journals. Delta synchronization sends changes and deletion operations. Type or language changes can use a partial model update.

## Media extraction and client logging

`POST /extract?cache=1s` accepts file bytes and returns HTTP 200 with `{ "type": "text/plain", "language": "", "text": "..." }`. The server detects UTF-8 text, PDF and Word `.docx` from the bytes. Unsupported formats, corrupt files, extraction failures, timeouts and image-only PDFs return empty text. The client can place returned text in a media document's searchable content field. The CMS applies its file-size limit before sending media.

`POST /clientlog` accepts client diagnostics and returns 204. It has no content-indexing effect.

## GraphQL queries

`POST /content/v2` accepts `{ "query": "...", "variables": {}, "operationName": "..." }`. Variables can also be a JSON string or null. `GET /content/v2?query=<encoded-query>&variables=<encoded-json>` executes a query. `?cache=false` is accepted.

Successful responses contain `data` and `extensions.correlationId` and omit `errors` entirely. GraphQL parse, validation or execution failures normally return HTTP 200 with `errors`. Malformed HTTP JSON returns 400. CMS consumers expect one root result per query and treat any `errors` property as failure. Metadata versions remain strings.

Content root fields expose `items`, singular `item`, `total(all: true)`, `cursor`, `facets` and `autocomplete`. Arguments include `where`, `locale`, `variation`, `limit`, `skip`, `cursor`, `orderBy`, `ids`, `pinned` and `track`. Locale values include configured cultures with hyphens mapped to underscores, `ALL` and `NEUTRAL`. Variations support ALL, SOME and NONE with optional original content. Cursors select subsequent pages.

Filters support nested fields, `_and`, `_or`, `_not`, fulltext and scalar comparisons. String `eq`, `notEq`, `in` and `notIn` are case-insensitive; GUID comparisons accept dashed and undashed forms. Text matching includes match, phrase, wildcard, fuzzy, startsWith, endsWith, contains and like. Ordering accepts nested fields and ranking inputs. Facet filters narrow result items and totals; each facet's counts apply the other fields' filters before applying its own filter. Numeric ranges are lower-inclusive and upper-exclusive. Autocomplete returns matching values. Synonyms and pinned collections are accepted without configured expansion or collections; semantic ranking uses local text relevance. `_track` returns null.

Basic queries can use URI-decoded `cg-roles` and `cg-username` for ACL checks, `cg-include-deleted: true` for soft deletions, and `cg-include-expired: false` to hide expired content. Missing or malformed ACLs are visible only to unconstrained Basic queries. Referenced documents obey the same slot, ACL, status, expiry and deletion rules as roots; inaccessible or missing references return null. Concrete content and fallback objects implement `IData` and the applicable content interfaces.

For public single-key queries (including unauthenticated queries when no single key is configured), a document with no `_metadata.status` is treated as Published for visibility when its type belongs to a non-default content source. Names owned by the default model do not gain this treatment from a conflicting definition. Everyone-read ACL, expiry and deletion checks still apply to roots and references. Explicit statuses retain their existing meaning. Basic and preview behavior is unchanged. This is a local approximation of the real service.

Missing required model values remain nullable. The server coerces stored values to the model's output types, returning null for invalid numeric, boolean or object values. Scalar list values are wrapped in arrays; invalid elements are dropped and explicit null elements are preserved. JSON fields parse stored JSON strings. A warning is logged per document and field when values need repair.

Browser GraphQL GET, POST and OPTIONS use the configured CORS allowlist; permitted preflights return 204 before authentication. Cross-origin Basic requests and mutations return 403. Browser queries can use single keys or preview tokens. Push and administration endpoints reject cross-origin requests and OPTIONS, while server-side clients without Origin remain supported. Dashboard and playground HTML retain their administration and same-origin checks.

## Slots and smooth rebuild

Slot mutations use Basic authentication through `/content/v2?cache=false` and return `{ "data": { "<mutation>": "done" } }` on success. Language arguments are accepted; promotion swaps the whole pending slot.

| Mutation | Behavior |
| --- | --- |
| `deployNewAccountVersion` | Creates a fresh empty pending slot and retains any previous snapshot. |
| `useNewAccountVersion` | Promotes pending types, documents and tombstones to live; saves former live state as previous, replacing an earlier snapshot. |
| `useOldAccountVersion` | Restores previous live state and removes previous and pending slots. Without previous state, only discards pending. |
| `abandonSlot` | Discards pending and retains previous state for a later revert. |

`cg-deploy-new: true` directs type and content pushes to pending. A stream action's `version: "new"` also selects pending. Queries select pending with `cg-query-new: true` or compatibility header `cg-use-new: true`; true values are case-insensitive. Queries otherwise use live. An absent pending slot is empty. The previous slot persists across restarts and is available for revert, with no query schema of its own.

`GET /graphiql?tenant=<id>&slot=new` opens the selected tenant and slot. `GET /app/graphiql?auth=<SingleKey>` serves the CMS iframe playground, selects the tenant by public key and queries same-origin `/content/v2`. Unknown or missing iframe keys return 404 HTML. Its live/new toggle changes the query header. Request logs redact auth query values.

## Sources, deletion and reset

| Endpoint | Behavior |
| --- | --- |
| `GET /api/content/v3/sources` | Returns all sources with stored types as entries with id, label and description; `?id=<source>` returns that entry with 200, or 404 if its types are absent. |
| `DELETE /api/content/v3/sources?id=<source>&mode=types` | Removes only that source's type model and rebuilds the merged schema, preserving documents. |
| `DELETE /api/content/v3/sources?id=default&mode=reset` | Removes that source's type model, clears documents in the selected slot and removes previous state. |
| `DELETE /api/content/v3/sources?id=<non-default-source>&mode=reset` | Removes that source's types and documents whose `__typename` or `_metadata.types` belongs to its content types in the selected slot. Other documents and slots are preserved. |
| `DELETE /api/content/v2/data?id=default` | Clears documents in the selected slot and removes previous state. |
| `DELETE /account?language_routing=<locale>&softDelete=true` | Removes documents matching that locale in the selected slot. |

These operations return HTTP 200 with `{}`. Source and data deletion do not perform the full administration reset.

`POST /__debug/reset` is a compatibility administration endpoint available when exactly one tenant exists. Tenant management supports `POST /tenants/{id}/clear` with JSON `{ "what": ["content", "types", "jobs", "requests", "all"] }` and returns exact removal counts. Content clears remove live, pending and previous documents and tombstones while retaining live/pending types. Type clears remove all slot models. Job clears remove journals and jobs. Full resets additionally remove webhooks and pending/previous slots. Browser forms require CSRF and typed tenant confirmation; non-loopback administration requires independent ADMIN Basic credentials.

## Webhooks

`GET /api/webhooks` lists the tenant's registrations. `POST /api/webhooks` accepts a JSON object, stores it with a generated id and returns it with HTTP 200. `DELETE /api/webhooks/{id}` removes a registration and returns 200 with `{}`. The server stores registrations without delivering webhook events.
