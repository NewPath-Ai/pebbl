# Rerank label audit

Fixture: `test/fixtures/rerank-corpus.json` (47 entries). NOW = 2026-06-18T12:00:00.000Z.

Labels below are COMPUTED by `test/rerank-ground-truth.js`, not hand-picked.
Oracle rule: drop superseded (valid_to set), then order current entries on the
query topic by tier (foundation>component>detail>fleeting), then a coarse 3-way
usage band (high>=15, med>=5, low<5 access_count), then recency. Top 5 = the label.

A human should be able to scan each table and agree the top rows belong on top.
The "excluded (superseded)" note under each query lists rows the rule dropped, so
you can confirm a superseded row was meant to be hidden (not lost by accident).

## q-auth - topic: `auth`

Intent: what is our authentication model

Computed expected_top_k: [1, 3, 27, 43, 36]

| rank | id | message | tier | usage band (count) | age | state |
| ---- | -- | ------- | ---- | ------------------ | --- | ----- |
| 1 | 1 | Auth model: short-lived JWT access token plus rotating re... | foundation | high (41) | ~6.0mo | current |
| 2 | 3 | Refresh token rotation handled by an auth service module,... | component | high (18) | ~5.4mo | current |
| 3 | 27 | API auth via the same JWT access token; scopes carried as... | component | med (11) | ~3.0mo | current |
| 4 | 43 | Auth sessions list lets a user revoke a device; revocatio... | component | med (5) | ~5.9mo | current |
| 5 | 36 | Auth: failed login attempts rate-limited to 5 per 15 minu... | detail | med (7) | ~1.9mo | current |

Current but below top-5: #4 (detail, low); #5 (detail, low).

## q-realtime - topic: `realtime-sync`

Intent: how does realtime collaboration sync

Computed expected_top_k: [6, 8, 41, 10, 42]

| rank | id | message | tier | usage band (count) | age | state |
| ---- | -- | ------- | ---- | ------------------ | --- | ----- |
| 1 | 6 | Realtime sync uses CRDTs (Yjs) so concurrent edits merge ... | foundation | high (55) | ~6.2mo | current |
| 2 | 8 | Sync transport is a WebSocket relay; updates broadcast pe... | component | high (22) | ~4.9mo | current |
| 3 | 41 | Realtime-sync: server persists Yjs updates to the storage... | detail | med (9) | ~1.2mo | current |
| 4 | 10 | Sync reconnect uses exponential backoff capped at 10s | detail | med (6) | ~1.5mo | current |
| 5 | 42 | BUILD BROKEN: sync server crash-loops on a malformed Yjs ... | detail | low (2) | 3d (fresh) | current [TIME-SENSITIVE] |

Current but below top-5: #9 (detail, low).

## q-storage - topic: `storage`

Intent: where and how are board documents stored

Computed expected_top_k: [12, 14, 35, 41, 15]

| rank | id | message | tier | usage band (count) | age | state |
| ---- | -- | ------- | ---- | ------------------ | --- | ----- |
| 1 | 12 | Board documents stored in S3 as compacted CRDT snapshots;... | foundation | high (25) | 21d | current |
| 2 | 14 | Snapshot compaction runs inline on write once an update l... | component | med (14) | ~3.3mo | current |
| 3 | 35 | Storage: pointer rows carry a content hash for integrity ... | detail | med (6) | 19d | current |
| 4 | 41 | Realtime-sync: server persists Yjs updates to the storage... | detail | med (9) | ~1.2mo | current |
| 5 | 15 | S3 snapshot keys namespaced by boardId then version; life... | detail | med (5) | ~2.0mo | current |

Excluded as superseded: #11 (foundation, → superseded by #12); #13 (component, → superseded by #14).

## q-rendering - topic: `rendering`

Intent: how is the canvas rendered

Computed expected_top_k: [17, 18, 45, 19, 20]

| rank | id | message | tier | usage band (count) | age | state |
| ---- | -- | ------- | ---- | ------------------ | --- | ----- |
| 1 | 17 | Canvas rendered on HTML5 canvas with a scene graph; no DO... | foundation | high (38) | ~5.7mo | current |
| 2 | 18 | Rendering split into a static layer and a live layer; onl... | component | high (16) | ~4.3mo | current |
| 3 | 45 | Rendering: viewport culling skips scene-graph nodes outsi... | component | med (13) | 29d | current |
| 4 | 19 | Dirty-rect tracking limits repaint to changed bounding boxes | detail | med (7) | ~3.5mo | current |
| 5 | 20 | BUILD BROKEN: rendering layer split landed a regression, ... | detail | low (1) | 1d (fresh) | current [TIME-SENSITIVE] |

Current but below top-5: #44 (detail, low).

## q-ci - topic: `ci`

Intent: how does CI gate merges

Computed expected_top_k: [21, 23, 20, 25, 24]

| rank | id | message | tier | usage band (count) | age | state |
| ---- | -- | ------- | ---- | ------------------ | --- | ----- |
| 1 | 21 | CI runs on GitHub Actions; merges to main gated on unit p... | foundation | high (33) | ~5.1mo | current |
| 2 | 23 | e2e suite sharded into 8 parallel jobs after flake rate r... | component | med (9) | 9d | current |
| 3 | 20 | BUILD BROKEN: rendering layer split landed a regression, ... | detail | low (1) | 1d (fresh) | current [TIME-SENSITIVE] |
| 4 | 25 | CI red: Playwright flake on the share-dialog test, retrie... | detail | low (1) | 31d | current |
| 5 | 24 | CI caches pnpm store keyed on lockfile hash | detail | low (3) | ~2.3mo | current |

Excluded as superseded: #22 (component, → superseded by #23).

## q-api - topic: `api`

Intent: what is the public API shape

Computed expected_top_k: [26, 3, 27, 46, 47]

| rank | id | message | tier | usage band (count) | age | state |
| ---- | -- | ------- | ---- | ------------------ | --- | ----- |
| 1 | 26 | Public API is REST under /v1 with cursor pagination; Grap... | foundation | high (28) | ~4.6mo | current |
| 2 | 3 | Refresh token rotation handled by an auth service module,... | component | high (18) | ~5.4mo | current |
| 3 | 27 | API auth via the same JWT access token; scopes carried as... | component | med (11) | ~3.0mo | current |
| 4 | 46 | API: error envelope is {error:{code,message,requestId}} a... | detail | med (6) | ~2.5mo | current |
| 5 | 47 | API: added an idempotency-key header on board-create POSTs | detail | low (2) | 7d | current |

Current but below top-5: #28 (detail, low).

## q-onboarding - topic: `onboarding`

Intent: what is the onboarding flow

Computed expected_top_k: [31, 34, 32]

| rank | id | message | tier | usage band (count) | age | state |
| ---- | -- | ------- | ---- | ------------------ | --- | ----- |
| 1 | 31 | Onboarding replaced with a single template-picker screen;... | foundation | med (13) | 17d | current |
| 2 | 34 | Onboarding tracks completion as a per-user flag in the me... | component | med (8) | ~1.6mo | current |
| 3 | 32 | Template picker offers 6 starter templates; selection dee... | detail | med (5) | ~2.8mo | current |

Excluded as superseded: #30 (foundation, → superseded by #31).

## q-architecture - topic: `architecture`

Intent: how is the codebase structured

Computed expected_top_k: [37, 38, 40]

| rank | id | message | tier | usage band (count) | age | state |
| ---- | -- | ------- | ---- | ------------------ | --- | ----- |
| 1 | 37 | Monorepo with pnpm workspaces; web client, sync server, a... | foundation | high (26) | ~5.5mo | current |
| 2 | 38 | Shared types package is the single source of truth for bo... | component | med (10) | ~3.2mo | current |
| 3 | 40 | Architecture: shared types published internally via works... | detail | low (3) | ~3.8mo | current |
