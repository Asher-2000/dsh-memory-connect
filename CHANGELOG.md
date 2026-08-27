# Changelog

## v0.6.1 (2026-08-27)

### 🐛 Bug Fix

- **Fix: `~` in `path` config never expanded** — `resolve()` in Node does not expand a leading `~`, so `path: ~/.dsh/memory.db` silently failed to create/open the database (the plugin default `resolve(homedir(), ...)` worked, but any user override with `~` broke storage). `_open()` now expands a leading `~/` to the home directory before resolving. Discovered while wiring up the plugin on a fresh local DSH install.

## v0.6.0 (2026-08-27)

### ✨ New Feature: Semantic Recall (语义召回)

- **🔎 Local embedding-based semantic retrieval** — optional vector recall that finds memories *by meaning* even when they share no keywords with the query. Powered by a tiny local embedding HTTP server (`scripts/embed_server.py`, BGE-small-zh-v1.5, 512-dim) and a new `memory_embeddings` table (float32 BLOB). Schema version bumped to 3 (auto-migrated).
- **🧬 RRF fusion with FTS** — `searchMemories()` now fuses keyword (FTS5) and semantic (cosine) rankings via reciprocal-rank fusion, so both exact matches and paraphrase matches surface.
- **⚙️ Opt-in config** (default off, zero breakage for existing installs):
  ```yaml
  # dsh-memory-connect
  embeddingEnabled: true
  embeddingUrl: http://127.0.0.1:8765
  embeddingModel: BAAI/bge-small-zh-v1.5
  embeddingWeight: 0.7
  ```
- **🔌 Zero-dependency design** — embeddings are computed in a separate Python process (sentence-transformers); the Node plugin talks HTTP with a 60s failure backoff and degrades gracefully to FTS-only when the server is down. Store writes never block on embedding.
- **🧹 Lifecycle cleanup** — superseded/archived memories have their embeddings removed so recall only sees active rows.

### 🧪 Tests

- Added `test-embedding.js` (6 assertions): server health, BLOB round-trip (512-dim float32), semantic top-1 for keyword-missing queries, supersede cleanup, active-only recall. All existing tests still pass.

### 📦 Packaging

- `scripts/embed_server.py` ships inside the npm package; start it with:
  ```bash
  python3 node_modules/@asherliner/dsh-memory-connect/scripts/embed_server.py --port 8765
  ```

## v0.5.0 (2026-08-27)

### ✨ New Features (inspired by dsh-opencontext)

- **🧠 Temporal Context Graph (时态图谱)** — memory rows now carry `valid_from` / `valid_until` / `supersedes`. Corrections are **append-only**: `reviseMemory()` soft-supersedes the old row (status=`superseded`, `valid_until`=now) and inserts a successor linked via `supersedes`. History stays queryable; recall only returns currently-valid rows (`valid_until IS NULL`). Schema version bumped to 2 with automatic migration (old rows backfilled `valid_from = created_at`).
- **🛡️ Trust Model (信任模型)** — recalled history is injected as an **untrusted reference**: the block is labeled `untrusted reference` with an explicit warning that it may be stale/poisoned and that the current user instruction always wins. Prevents memory poisoning and prompt conflicts.
- **📝 Turn-End Summarization (轮末自动摘要)** — `turn/end` events now produce a lightweight `summary` memory anchored on the last user message (new `summary` type + `turn-summary` tag, lower relevance so explicit facts stay prioritized).

### 🧪 Tests

- Added `test-temporal.js` (17 assertions): schema v2 columns, v1→v2 migration backfill, supersede soft-deprecation, valid-only recall, turn-summary extraction + FTS search. All existing tests still pass.

## v0.4.1 (2026-08-25)

### 🐛 Bug Fix

- **Fix: Soul never injected in practice** — the per-turn context provider (`recallSync`) only queried the FTS5 memory table and never called `SoulManager.getContext()`. `enableSoul: true` (the default) and the README's "zero-config Soul" instructions did nothing on every-turn injection. `recallSync` now loads and injects Soul context the same way `getMemoryContext` does: Soul is placed first, and is still injected even when there are no memory rows (previously empty recall returned `''`). Reported in [issue #1](https://github.com/Asher-2000/dsh-memory-connect/issues/1).

## v0.4.0 (2026-08-22)

### 🐛 Critical Bug Fixes

- **Fix: plugin never activated** — `apply()` passed the *class* to `ctx.provide()`, but Cordis lazily instantiates services: without an instance the constructor never ran, so extraction/recall/soul were dead code. Now `apply()` creates a real instance, provides it, and triggers `Service.init()` for `openAt: startup`.
- **Fix: `this.config` undefined crash** — the constructor called `super(ctx, config)` where Cordis' `Service` treats the 2nd arg as a *name*, so the config object was never stored. `this.config = config` is now set explicitly before use.
- **Fix: recall was never injected** — the old code computed `session._memoryContext` on `session/created` using the working directory as the search query (e.g. `/home/sam`), which can never match real memory content — and the computed context had **no consumer**. The plugin now registers a `systemPrompt.context` provider that recalls relevant memories on every prompt assembly.
- **Fix: Node 24 import crash** — `existsSync`/`readFileSync` were imported from `node:fs/promises` (sync APIs only exist in `node:fs`), crashing module load. Imports corrected.
- **Fix: schemastery API incompatibility** — `z.string().optional()` was removed in the bundled schemastery; fields are optional by default. Removed the call.
- **Fix: optional `ctx.llm` probe crash** — `optionalInject` is not a Cordis standard, direct `ctx.llm` access throws. Availability probe is now guarded.
- **Fix: crash on zero-config install** — Cordis passes `undefined` as `config` when a bundle entry has no `config:` block. A bare `dsh plugin add` (no hand-written profile patch) crashed on `config.openAt`. `apply()` now normalizes `MEMORY_DEFAULTS` (DB at `~/.dsh/memory.db`, `openAt: startup`, and every documented default) before constructing the service — the plugin now runs with **zero configuration**.

### ✨ New Features

- **Real cross-session recall injection** — memories from previous sessions are injected into the system prompt as `## Related Memories from Previous Sessions` on every turn (FTS5 keyword recall when user text is available, recency fallback otherwise).
- `currentUserText(session)` — extracts the latest user message from dsh session logs (supports `{event: ...}` wrapping, `agent/inbox/spliced`, and bare events).
- `recallSync(sessionId, query)` — synchronous recall for system-prompt context providers (the DB is `node:sqlite` `DatabaseSync`, so no async needed).

### Breaking Changes

- `systemPrompt` service is now required: `inject: ['sessions', 'systemPrompt']`. Environments without the `systemPrompt` service (e.g. raw Cordis hosts) must provide it or patch out the injection.

### Installation

```bash
npm install github:Asher-2000/dsh-memory-connect#v0.4.0
# or: dsh plugin --profile <your-profile> add github:Asher-2000/dsh-memory-connect
```

### Configuration

```yaml
- id: memory
  name: '@asherliner/dsh-memory-connect'
  config:
    path: ~/.dsh/memory.db
```

### Verified

Tested on dsh v0.1.1-rc.2 (Node 24): extraction → SQLite FTS5 → system-prompt recall → model answers with cross-session facts.

---

## v0.1.0 (2026-08-19)

### Features
- Cross-session memory sharing for DSH
- Automatic memory extraction from conversations (facts, preferences, decisions)
- SQLite FTS5 semantic indexing with RRF recall
- Scheduled maintenance (decay + consolidation)
- LLM-powered semantic consolidation via ctx.llm
- Memory decay formula
- Bilingual documentation (EN/CN)

### Installation
```bash
npm install @asherliner/dsh-memory-connect
```

### Configuration
```yaml
- id: memory
  name: '@asherliner/dsh-memory-connect'
  config:
    path: ~/.dsh/memory.db
```