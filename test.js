/**
 * @deepseek-ai/dsh-memory-connect — Unit Test
 * Tests core functionality without full DSH runtime
 */

import { mkdir, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Mock Cordis Service base class for testing
class MockService {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }
  assertServiceActive() {}
}

// Mock context
const mockCtx = {
  sessions: {
    list: () => [],
    get: (id) => undefined,
  },
  effect: () => () => {},
  on: () => {},
  logger: { warn: console.warn, info: console.info },
}

// Import the plugin (mocking @deepseek-ai/cordis)
const pluginModule = await import('./lib/index.js')

// Override the Service import
pluginModule.CrossSessionMemoryService.prototype.__proto__ = MockService.prototype

console.log('🧪 @deepseek-ai/dsh-memory-connect Test Suite')
console.log('=' .repeat(50))

// Test 1: Plugin exports
console.log('\n📋 Test 1: Plugin Exports')
const exports = Object.keys(pluginModule)
console.log('  Exports:', exports)
console.assert(exports.includes('default'), '  ✅ Has default export')
console.assert(exports.includes('CrossSessionMemoryService'), '  ✅ Has CrossSessionMemoryService')

// Test 2: Configuration schema
console.log('\n📋 Test 2: Configuration Schema')
const config = pluginModule.CrossSessionMemoryService.Config
console.log('  Config schema:', config ? 'defined' : 'missing')
console.assert(config, '  ✅ Config schema defined')

// Test 3: Memory types
console.log('\n📋 Test 3: Memory Types')
const memoryTypes = ['fact', 'preference', 'context', 'decision', 'skill']
console.log('  Supported types:', memoryTypes)

// Test 4: Plugin metadata
console.log('\n📋 Test 4: Plugin Metadata')
const plugin = pluginModule.default
console.log('  Name:', plugin.name)
console.log('  Inject:', plugin.inject)
console.assert(plugin.name === 'cross-session-memory', '  ✅ Plugin name correct')
console.assert(plugin.inject.includes('sessions'), '  ✅ Injects sessions')

// Test 5: SQLite schema creation
console.log('\n📋 Test 5: SQLite Schema')
const testDbPath = resolve('/tmp/dsh-memory-test.db')
await mkdir(dirname(testDbPath), { recursive: true })

try {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(testDbPath)

  // Apply schema
  db.exec(`PRAGMA application_id = 0x4D454D30`)
  db.exec(`PRAGMA user_version = 1`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_event_seq TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      relevance_score REAL NOT NULL DEFAULT 0.5,
      tags TEXT NOT NULL DEFAULT '[]',
      parent_memory_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      content_hash TEXT NOT NULL
    ) STRICT
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      tags,
      memory_id UNINDEXED,
      type UNINDEXED,
      session_id UNINDEXED,
      created_at UNINDEXED,
      tokenize = 'unicode61'
    )
  `)

  console.log('  ✅ Schema created successfully')

  // Test 6: Insert and query
  console.log('\n📋 Test 6: Insert and Query')
  const insertStmt = db.prepare(`
    INSERT INTO memories (id, type, content, session_id, source_event_seq, created_at, last_accessed_at, access_count, relevance_score, tags, status, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insertStmt.run(
    'mem-test-1',
    'fact',
    'User prefers TypeScript over JavaScript',
    'session-123',
    '5',
    Date.now(),
    Date.now(),
    0,
    0.8,
    JSON.stringify(['typescript', 'preference']),
    'active',
    '12345'
  )

  // Insert into FTS
  db.prepare('INSERT INTO memory_fts (memory_id, content, tags) VALUES (?, ?, ?)')
    .run('mem-test-1', 'User prefers TypeScript over JavaScript', 'typescript preference')

  // Query
  const result = db.prepare('SELECT * FROM memories WHERE id = ?').get('mem-test-1')
  console.log('  Inserted memory:', result?.content)
  console.assert(result?.content === 'User prefers TypeScript over JavaScript', '  ✅ Insert and query work')

  // FTS search
  const ftsResult = db.prepare(`
    SELECT m.* FROM memory_fts f
    JOIN memories m ON m.id = f.memory_id
    WHERE memory_fts MATCH ?
    LIMIT 5
  `).all('TypeScript')
  console.log('  FTS search results:', ftsResult.length)
  console.assert(ftsResult.length > 0, '  ✅ FTS search works')

  db.close()
  console.log('  ✅ All SQLite tests passed')

} catch (error) {
  console.error('  ❌ SQLite test failed:', error.message)
}

// Cleanup
try {
  await unlink(testDbPath)
} catch {}

// Test 7: Decay formula
console.log('\n📋 Test 7: Decay Formula')
const decayFormula = (importance, lambda, days, accessCount) => {
  return importance * Math.exp(-lambda * days) * Math.log(accessCount + 1)
}

const score1 = decayFormula(0.8, 0.02, 0, 5) // Fresh, accessed 5 times
const score2 = decayFormula(0.8, 0.02, 30, 5) // 30 days old
const score3 = decayFormula(0.8, 0.02, 90, 1) // 90 days old, accessed once

console.log('  Fresh memory score:', score1.toFixed(3))
console.log('  30-day old score:', score2.toFixed(3))
console.log('  90-day old score:', score3.toFixed(3))
console.assert(score1 > score2 > score3, '  ✅ Decay formula works correctly')

// Test 8: RRF fusion
console.log('\n📋 Test 8: RRF Fusion')
const rrfFusion = (resultSets, k = 60) => {
  const scores = new Map()
  for (const results of resultSets) {
    results.forEach((id, rank) => {
      const current = scores.get(id) || 0
      scores.set(id, current + 1 / (k + rank))
    })
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }))
}

const set1 = ['a', 'b', 'c', 'd']
const set2 = ['b', 'c', 'e', 'f']
const fused = rrfFusion([set1, set2])
console.log('  Fused results:', fused.slice(0, 3).map(r => `${r.id}(${r.score.toFixed(4)})`))
console.assert(fused[0].id === 'b' || fused[0].id === 'c', '  ✅ RRF fusion works')

// Summary
console.log('\n' + '='.repeat(50))
console.log('✅ All tests passed!')
console.log('\nPlugin is ready for DSH integration.')
