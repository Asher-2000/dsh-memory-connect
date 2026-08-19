# Changelog

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
