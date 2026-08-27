#!/usr/bin/env node
/**
 * test-embedding.js — semantic embedding integration test for dsh-memory-connect.
 *
 * Tests the real chain without Cordis:
 *   - embed_server.py HTTP service (bge-small-zh-v1.5, dim 512)
 *   - memory_embeddings schema (float32 BLOB storage)
 *   - cosine retrieval & semantic ranking (keyword-missing recall)
 *   - revise/supersede cleanup
 *
 * Requires the local embedding server on http://127.0.0.1:8765
 *   (scripts/embed_server.py with bge-small-zh-v1.5).
 *
 * Run: node test-embedding.js
 */
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const EMBED_URL = 'http://127.0.0.1:8765'
const MODEL = 'BAAI/bge-small-zh-v1.5'
const EXPECTED_DIM = 512

// ── minimal embedding client (same contract as lib's EmbeddingClient) ──
async function httpEmbed(texts) {
  const resp = await fetch(EMBED_URL + '/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return (await resp.json()).embeddings
}

// ── float32 BLOB helpers (mirror lib) ──
function vecToBlob(vec) {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}
function blobToVec(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  const out = new Array(buf.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

// ── schema (v3: memories + memory_embeddings + memory_fts) ──
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL,
      content TEXT NOT NULL, session_id TEXT NOT NULL,
      source_event_seq TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
      relevance_score REAL NOT NULL DEFAULT 0.5, tags TEXT NOT NULL DEFAULT '[]',
      parent_memory_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consolidated','decayed','archived','superseded')),
      content_hash TEXT NOT NULL, valid_from INTEGER, valid_until INTEGER, supersedes TEXT
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content, tags, memory_id UNINDEXED, type UNINDEXED,
      session_id UNINDEXED, created_at UNINDEXED, tokenize = 'unicode61'
    )
  `)
}

function insertMemory(db, mem) {
  db.prepare(`
    INSERT OR REPLACE INTO memories (
      id, type, content, session_id, source_event_seq, created_at,
      last_accessed_at, access_count, relevance_score, tags,
      parent_memory_id, status, content_hash, valid_from, valid_until, supersedes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    mem.id, mem.type, mem.content, mem.sessionId, '0', mem.createdAt,
    mem.createdAt, 0, 0.5, '[]', null, 'active', `h-${mem.id}`,
    mem.createdAt, null, null
  )
  db.prepare('INSERT INTO memory_fts (memory_id, content, tags) VALUES (?,?,?)')
    .run(mem.id, mem.content, '[]')
}

async function main() {
  // health check
  const health = await (await fetch(EMBED_URL + '/health')).json()
  assert.equal(health.dim, EXPECTED_DIM, `server dim == ${EXPECTED_DIM}`)
  console.log(`✅ 0. embed server healthy (model=${health.model}, dim=${health.dim})`)

  const dir = mkdtempSync(path.join(tmpdir(), 'mem-emb-'))
  const dbPath = path.join(dir, 'mem.db')
  const db = new Database(dbPath)
  ensureSchema(db)

  const now = Date.now()
  const mems = [
    { id: 'm1', type: 'fact', content: '付款前必须核验签约人授权委托书，确保代理事项、权限、期限覆盖合同内容', sessionId: 's-a', createdAt: now - 4000 },
    { id: 'm2', type: 'fact', content: '建设工程施工合同无效但验收合格的，可以参照合同约定折价补偿承包人', sessionId: 's-b', createdAt: now - 3000 },
    { id: 'm3', type: 'fact', content: '超过18个月除斥期间未主张优先受偿权的，丧失优先受偿权', sessionId: 's-c', createdAt: now - 2000 },
    { id: 'm4', type: 'fact', content: '在检验期间内未提出质量异议的，视为标的物质量符合约定', sessionId: 's-d', createdAt: now - 1000 },
  ]
  for (const m of mems) insertMemory(db, m)

  // 1. embed all + store as BLOB
  const vecs = await httpEmbed(mems.map(m => m.content))
  const store = db.prepare(
    'INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model, dim, updated_at) VALUES (?,?,?,?,?)'
  )
  for (let i = 0; i < mems.length; i++) {
    store.run(mems[i].id, vecToBlob(vecs[i]), MODEL, EXPECTED_DIM, now)
  }

  const rows = db.prepare('SELECT memory_id, dim, length(embedding) AS len FROM memory_embeddings').all()
  assert.equal(rows.length, 4, '4 embeddings stored')
  for (const r of rows) {
    assert.equal(r.dim, EXPECTED_DIM, `dim ${EXPECTED_DIM}`)
    assert.equal(r.len, EXPECTED_DIM * 4, `blob ${EXPECTED_DIM*4} bytes`)
  }
  console.log('✅ 1. stored 4 embeddings as float32 BLOBs (512-dim)')

  // 2. semantic ranking: query embedded, cosine over stored vectors
  const q = '什么时候会丧失优先受偿权'
  const [qVec] = await httpEmbed([q])
  const scored = mems.map((m, i) => {
    const blob = db.prepare('SELECT embedding FROM memory_embeddings WHERE memory_id = ?').get(m.id).embedding
    return { id: m.id, sim: cosine(qVec, blobToVec(blob)) }
  }).sort((a, b) => b.sim - a.sim)
  assert.equal(scored[0].id, 'm3', `top hit m3 (priority), got ${scored[0].id} sim=${scored[0].sim.toFixed(3)}`)
  console.log(`✅ 2. semantic top-1 = m3 (优先受偿权) sim=${scored[0].sim.toFixed(3)}`)

  // 3. keyword-missing semantic recall: "质量有问题怎么提异议" has no shared keyword with m4
  const [q2] = await httpEmbed(['质量有问题怎么提异议'])
  const scored2 = mems.map((m, i) => {
    const blob = db.prepare('SELECT embedding FROM memory_embeddings WHERE memory_id = ?').get(m.id).embedding
    return { id: m.id, sim: cosine(q2, blobToVec(blob)) }
  }).sort((a, b) => b.sim - a.sim)
  assert.equal(scored2[0].id, 'm4', `top hit m4 (检验期间), got ${scored2[0].id} sim=${scored2[0].sim.toFixed(3)}`)
  console.log(`✅ 3. keyword-missing semantic recall top-1 = m4 (检验期间) sim=${scored2[0].sim.toFixed(3)}`)

  // 4. revise/supersede: delete old embedding, add successor
  db.prepare("UPDATE memories SET status='superseded', valid_until=? WHERE id='m4'").run(now)
  db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run('m4')
  const m4v2 = { id: 'm4r', type: 'fact', content: '在检验期间内未提出质量异议的，视为标的物质量符合约定（修订：隐蔽瑕疵适用合理期间）', sessionId: 's-d', createdAt: now }
  insertMemory(db, m4v2)
  const [v2vec] = await httpEmbed([m4v2.content])
  store.run(m4v2.id, vecToBlob(v2vec), MODEL, EXPECTED_DIM, now)

  const oldEmb = db.prepare('SELECT 1 FROM memory_embeddings WHERE memory_id=?').get('m4')
  const newEmb = db.prepare('SELECT 1 FROM memory_embeddings WHERE memory_id=?').get('m4r')
  assert.equal(oldEmb, undefined, 'old embedding gone')
  assert.ok(newEmb, 'successor embedded')
  console.log('✅ 4. supersede cleanup: old embedding removed, successor stored')

  // 5. active-only recall: archived memory excluded
  db.prepare("UPDATE memories SET status='archived' WHERE id='m2'").run()
  db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?').run('m2')
  const [q3] = await httpEmbed(['合同无效的折价补偿'])
  // Only memory ids that still have embeddings (m4 was superseded to m4r).
  const liveIds = db.prepare('SELECT memory_id FROM memory_embeddings').all().map(r => r.memory_id)
  const scored3 = liveIds.map(id => {
    const blob = db.prepare('SELECT embedding FROM memory_embeddings WHERE memory_id = ?').get(id).embedding
    return { id, sim: cosine(q3, blobToVec(blob)) }
  }).sort((a, b) => b.sim - a.sim)
  assert.ok(!scored3.some(x => x.id === 'm2'), 'archived m2 excluded')
  assert.ok(scored3.some(x => x.id === 'm1' || x.id === 'm3' || x.id === 'm4r'), 'live memories still rankable')
  console.log('✅ 5. archived memory excluded from semantic recall')

  db.close()
  rmSync(dir, { recursive: true, force: true })
  console.log('\n🎉 全部 embedding 测试通过')
}

main().catch(err => {
  console.error('\n❌ 测试失败:', err)
  process.exit(1)
})
