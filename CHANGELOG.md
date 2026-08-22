# Changelog

## v0.4.0 (2026-08-22)

### 🐛 Critical Bug Fixes

- **Fix: plugin never activated** — `apply()` passed the *class* to `ctx.provide()`, but Cordis lazily instantiates services: without an instance the constructor never ran, so extraction/recall/soul were dead code. Now `apply()` creates a real instance, provides it, and triggers `Service.init()` for `openAt: startup`.
- **Fix: `this.config` undefined crash** — the constructor called `super(ctx, config)` where Cordis' `Service` treats the 2nd arg as a *name*, so the config object was never stored. `this.config = config` is now set explicitly before use.
- **Fix: recall was never injected** — the old code computed `session._memoryContext` on `session/created` using the working directory as the search query (e.g. `/home/sam`), which can never match real memory content — and the computed context had **no consumer**. The plugin now registers a `systemPrompt.context` provider that recalls relevant memories on every prompt assembly.
- **Fix: Node 24 import crash** — `existsSync`/`readFileSync` were imported from `node:fs/promises` (sync APIs only exist in `node:fs`), crashing module load. Imports corrected.
- **Fix: schemastery API incompatibility** — `z.string().optional()` was removed in the bundled schemastery; fields are optional by default. Removed the call.
- **Fix: optional `ctx.llm` probe crash** — `optionalInject` is not a Cordis standard, direct `ctx.llm` access throws. Availability probe is now guarded.

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
  name: '@deepseek-ai/dsh-memory-connect'
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
npm install @deepseek-ai/dsh-memory-connect
```

### Configuration
```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory-connect'
  config:
    path: ~/.dsh/memory.db
```