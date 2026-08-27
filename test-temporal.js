/**
 * 专项测试：v0.5.0 新功能（时态图谱 + 信任模型 + turn 摘要）
 * 运行: node test-temporal.js
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// 用 sqlite 内存库直接测 schema + storeMemory + reviseMemory 逻辑
import Database from 'better-sqlite3'

// 复制 index.js 里的 schema 函数行为（简单重现）
const MEMORY_SCHEMA_VERSION = 2
const MEMORY_APPLICATION_ID = 0x4D454D30

function ensureMemorySchema(db) {
  db.exec(`PRAGMA application_id = ${MEMORY_APPLICATION_ID}`)
  db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id               TEXT PRIMARY KEY,
      type             TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'context', 'decision', 'skill', 'summary')),
      content          TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      source_event_seq TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count     INTEGER NOT NULL DEFAULT 0,
      relevance_score  REAL NOT NULL DEFAULT 0.5,
      tags             TEXT NOT NULL DEFAULT '[]',
      parent_memory_id TEXT,
      status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consolidated', 'decayed', 'archived', 'superseded')),
      content_hash     TEXT NOT NULL,
      valid_from       INTEGER,
      valid_until      INTEGER,
      supersedes       TEXT
    ) STRICT
  `)
  // 迁移列
  const cols = db.prepare(`PRAGMA table_info(memories)`).all().map(c => c.name)
  if (!cols.includes('valid_from')) db.exec(`ALTER TABLE memories ADD COLUMN valid_from INTEGER`)
  if (!cols.includes('valid_until')) db.exec(`ALTER TABLE memories ADD COLUMN valid_until INTEGER`)
  if (!cols.includes('supersedes')) db.exec(`ALTER TABLE memories ADD COLUMN supersedes TEXT`)
  db.exec(`UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL`)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content, tags, memory_id UNINDEXED, type UNINDEXED,
      session_id UNINDEXED, created_at UNINDEXED, tokenize = 'unicode61'
    )
  `)
}

let passed = 0, failed = 0
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}`) }
}

// ─── Test 1: schema v2 含时态列 ───
console.log('Test 1: Schema v2 时态列')
{
  const db = new Database(':memory:')
  ensureMemorySchema(db)
  const cols = db.prepare(`PRAGMA table_info(memories)`).all().map(c => c.name)
  assert(cols.includes('valid_from'), 'valid_from 列存在')
  assert(cols.includes('valid_until'), 'valid_until 列存在')
  assert(cols.includes('supersedes'), 'supersedes 列存在')
  const types = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memories'`).get().sql
  assert(types.includes('summary'), 'type 允许 summary')
  db.close()
}

// ─── Test 2: 旧库迁移（v1 表 + 加列）───
console.log('Test 2: v1 → v2 迁移')
{
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
      session_id TEXT NOT NULL, source_event_seq TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0, relevance_score REAL NOT NULL DEFAULT 0.5,
      tags TEXT NOT NULL DEFAULT '[]', parent_memory_id TEXT,
      status TEXT NOT NULL DEFAULT 'active', content_hash TEXT NOT NULL
    )
  `)
  db.prepare(`INSERT INTO memories (id, type, content, session_id, source_event_seq, created_at, last_accessed_at, content_hash)
    VALUES ('m1', 'fact', 'old memory', 's1', '0', 1000, 1000, 'h1')`).run()
  ensureMemorySchema(db)
  const row = db.prepare(`SELECT * FROM memories WHERE id='m1'`).get()
  assert(row.valid_from === 1000, `旧数据 backfill valid_from=${row.valid_from}`)
  assert(row.valid_until === null, 'valid_until 默认 null')
  db.close()
}

// ─── Test 3: supersede 逻辑（软废弃）───
console.log('Test 3: supersede 软废弃')
{
  const db = new Database(':memory:')
  ensureMemorySchema(db)
  const now = Date.now()
  // 旧记忆
  db.prepare(`INSERT INTO memories (id, type, content, session_id, source_event_seq, created_at, last_accessed_at, content_hash, valid_from)
    VALUES ('old', 'preference', 'likes coffee', 's1', '0', ?, ?, 'h1', ?)`).run(now, now, now)
  db.prepare(`INSERT INTO memory_fts (memory_id, content, tags) VALUES ('old', 'likes coffee', '[]')`).run()
  // 模拟 reviseMemory: supersede old + insert new
  db.prepare(`UPDATE memories SET status='superseded', valid_until=? WHERE id='old' AND status='active'`).run(now)
  const newId = 'new'
  db.prepare(`INSERT INTO memories (id, type, content, session_id, source_event_seq, created_at, last_accessed_at, content_hash, valid_from, supersedes)
    VALUES (?, 'preference', 'likes tea now', 's1', '0', ?, ?, 'h2', ?, 'old')`).run(newId, now, now, now)
  db.prepare(`INSERT INTO memory_fts (memory_id, content, tags) VALUES (?, 'likes tea now', '[]')`).run(newId)

  const oldRow = db.prepare(`SELECT * FROM memories WHERE id='old'`).get()
  assert(oldRow.status === 'superseded', '旧记忆 status=superseded')
  assert(oldRow.valid_until !== null, '旧记忆 valid_until 已设置')
  assert(oldRow.valid_until === now, `valid_until=${oldRow.valid_until} ≈ now=${now}`)

  const newRow = db.prepare(`SELECT * FROM memories WHERE id='new'`).get()
  assert(newRow.status === 'active', '新记忆 active')
  assert(newRow.supersedes === 'old', '新记忆 supersedes=old')
  assert(newRow.valid_until === null, '新记忆 valid_until=null（当前有效）')

  // 检索只返回 active + valid
  const active = db.prepare(`SELECT * FROM memories WHERE status='active' AND valid_until IS NULL`).all()
  assert(active.length === 1 && active[0].id === 'new', '检索只见最新有效记忆')
  db.close()
}

// ─── Test 4: turn summary 提取逻辑 ───
console.log('Test 4: turn/end 摘要提取')
{
  const db = new Database(':memory:')
  ensureMemorySchema(db)
  // 模拟 extractTurnSummary 的输出（规则：user 消息锚点）
  const userText = '帮我重构用户认证模块，把 JWT 换成 OAuth'
  const summary = `[turn summary] ${userText.slice(0, 280)}`
  db.prepare(`INSERT INTO memories (id, type, content, session_id, source_event_seq, created_at, last_accessed_at, content_hash, valid_from, tags)
    VALUES ('sum1', 'summary', ?, 's1', '0', ?, ?, 'h3', ?, '["turn-summary"]')`).run(summary, Date.now(), Date.now(), Date.now())
  db.prepare(`INSERT INTO memory_fts (memory_id, content, tags) VALUES ('sum1', ?, '["turn-summary"]')`).run(summary)
  const row = db.prepare(`SELECT * FROM memories WHERE id='sum1'`).get()
  assert(row.type === 'summary', 'type=summary')
  assert(row.content.startsWith('[turn summary]'), 'content 带 [turn summary] 前缀')
  assert(row.tags.includes('turn-summary'), 'tags 含 turn-summary')
  // FTS 能搜到
  const hits = db.prepare(`SELECT m.* FROM memory_fts f JOIN memories m ON m.id=f.memory_id WHERE memory_fts MATCH ?`).all('"OAuth"')
  assert(hits.length === 1, `FTS 搜到摘要 (OAuth): ${hits.length}`)
  db.close()
}

console.log(`\n${'='.repeat(40)}`)
console.log(`结果: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
