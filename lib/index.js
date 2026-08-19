/**
 * @deepseek-ai/dsh-memory-connect
 *
 * Cross-session memory sharing plugin:
 * - Automatic memory extraction from conversations
 * - Semantic indexing with FTS5 + optional embedding support
 * - Intelligent recall with relevance scoring
 * - Memory lifecycle: extract → store → consolidate → decay
 * - Scheduled maintenance (decay + consolidation) with configurable intervals
 * - LLM-powered semantic consolidation for intelligent memory merging
 * - Context explosion prevention with token budget management
 *
 * @module @deepseek-ai/dsh-memory-connect
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// ─── Token Counter ──────────────────────────────────────────────

/**
 * Simple token counter for context budget management.
 * Uses character-based estimation (1 token ≈ 4 chars for English, 2 chars for CJK).
 */
class TokenCounter {
  /**
   * Estimate token count for text.
   * @param {string} text
   * @returns {number} Estimated tokens
   */
  static estimate(text) {
    if (!text) return 0
    let count = 0
    for (const char of text) {
      // CJK characters: ~1 token per 2 chars
      if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(char)) {
        count += 0.5
      }
      // Other characters: ~1 token per 4 chars
      else {
        count += 0.25
      }
    }
    return Math.ceil(count)
  }

  /**
   * Truncate text to fit within token budget.
   * @param {string} text
   * @param {number} maxTokens
   * @returns {string} Truncated text
   */
  static truncate(text, maxTokens) {
    if (!text || maxTokens <= 0) return ''
    const estimated = this.estimate(text)
    if (estimated <= maxTokens) return text
    
    // Truncate by character ratio
    const ratio = maxTokens / estimated
    const targetChars = Math.floor(text.length * ratio * 0.9) // 90% to be safe
    return text.slice(0, targetChars) + '...'
  }
}

// ─── Memory Types ───────────────────────────────────────────────

/**
 * @typedef {'fact' | 'preference' | 'context' | 'decision' | 'skill'} MemoryType
 *
 * - fact:          Objective information (names, dates, configs)
 * - preference:    User preferences (coding style, tools, formats)
 * - context:       Project context (goals, constraints, architecture)
 * - decision:      Decisions made and their rationale
 * - skill:         Learned patterns and how-to knowledge
 */

/**
 * @typedef {Object} Memory
 * @property {string}        id          - Unique memory identifier
 * @property {MemoryType}    type        - Memory category
 * @property {string}        content     - Extracted memory text
 * @property {string}        sessionId   - Source session id
 * @property {string}        sourceEventSeq - Source event sequence
 * @property {number}        createdAt   - Creation timestamp
 * @property {number}        lastAccessedAt - Last recall timestamp
 * @property {number}        accessCount - Number of times recalled
 * @property {number}        relevanceScore - Computed relevance (0-1)
 * @property {string[]}      tags        - Extracted tags for filtering
 * @property {string|null}   parentMemoryId - For consolidation chains
 * @property {'active' | 'consolidated' | 'decayed' | 'archived'} status
 */

// ─── Schema ─────────────────────────────────────────────────────

const MEMORY_SCHEMA_VERSION = 1

const MEMORY_APPLICATION_ID = 0x4D454D30 // "MEM0"

/** SQLite schema for the memory store. */
function ensureMemorySchema(db) {
  db.exec(`PRAGMA application_id = ${MEMORY_APPLICATION_ID}`)
  db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)

  // Memory metadata table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id               TEXT PRIMARY KEY,
      type             TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'context', 'decision', 'skill')),
      content          TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      source_event_seq TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count     INTEGER NOT NULL DEFAULT 0,
      relevance_score  REAL NOT NULL DEFAULT 0.5,
      tags             TEXT NOT NULL DEFAULT '[]',
      parent_memory_id TEXT,
      status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consolidated', 'decayed', 'archived')),
      content_hash     TEXT NOT NULL
    ) STRICT
  `)

  // FTS5 index for full-text search
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

  // Session-memory association (which memories are relevant to which sessions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_session_relevance (
      memory_id  TEXT NOT NULL,
      session_id TEXT NOT NULL,
      relevance  REAL NOT NULL DEFAULT 0.5,
      recalled_at INTEGER NOT NULL,
      PRIMARY KEY (memory_id, session_id)
    ) STRICT
  `)

  // Extraction state tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_state (
      session_id       TEXT PRIMARY KEY,
      last_extracted_seq INTEGER NOT NULL DEFAULT 0,
      extraction_status TEXT NOT NULL DEFAULT 'pending'
    ) STRICT
  `)
}

// ─── Memory Extractor ───────────────────────────────────────────

/**
 * Extracts memories from session events.
 * Uses rule-based extraction + optional LLM-powered extraction.
 */
class MemoryExtractor {
  constructor(config) {
    this.config = config
  }

  /**
   * Extract memories from a batch of events.
   * @param {import('@deepseek-ai/dsh-session').SessionEvent[]} events
   * @param {string} sessionId
   * @returns {Promise<Partial<Memory>[]>}
   */
  async extract(events, sessionId) {
    const memories = []

    for (const event of events) {
      const extracted = await this.extractFromEvent(event, sessionId)
      memories.push(...extracted)
    }

    return this.deduplicate(memories)
  }

  /**
   * Extract memories from a single event.
   */
  async extractFromEvent(event, sessionId) {
    const memories = []

    switch (event.type) {
      case 'user/message':
        memories.push(...this.extractUserMessage(event, sessionId))
        break
      case 'assistant/message':
        memories.push(...this.extractAssistantMessage(event, sessionId))
        break
      case 'tool/result':
        memories.push(...this.extractToolResult(event, sessionId))
        break
      case 'session/title':
        memories.push(...this.extractTitle(event, sessionId))
        break
      default:
        break
    }

    return memories
  }

  /**
   * Extract memories from user messages.
   * Looks for: preferences, facts, decisions, context declarations.
   */
  extractUserMessage(event, sessionId) {
    const memories = []
    const content = this.extractTextContent(event.data)
    if (!content) return memories

    // Preference patterns
    const preferencePatterns = [
      /(?:我(?:喜欢|偏好|希望|想要|习惯|用|要))\s*[：:]?\s*(.+)/gi,
      /(?:prefer|like|want|use|need)\s*[：:]?\s*(.+)/gi,
      /(?:请|please)\s*(?:用|使用|采用)\s*(.+)/gi,
    ]

    for (const pattern of preferencePatterns) {
      const match = content.match(pattern)
      if (match) {
        memories.push({
          type: 'preference',
          content: match[0].trim(),
          sessionId,
          sourceEventSeq: String(event.seq),
          tags: this.extractTags(match[0]),
        })
      }
    }

    // Decision patterns
    const decisionPatterns = [
      /(?:决定|选择了|确认|确定|采用|决定用)\s*[：:]?\s*(.+)/gi,
      /(?:decided|chosen|confirmed|settled)\s+(?:on|to)\s+(.+)/gi,
    ]

    for (const pattern of decisionPatterns) {
      const match = content.match(pattern)
      if (match) {
        memories.push({
          type: 'decision',
          content: match[0].trim(),
          sessionId,
          sourceEventSeq: String(event.seq),
          tags: this.extractTags(match[0]),
        })
      }
    }

    // Context declarations
    const contextPatterns = [
      /(?:项目|project)\s*[：:]\s*(.+)/gi,
      /(?:目标|goal)\s*[：:]\s*(.+)/gi,
      /(?:背景|context)\s*[：:]\s*(.+)/gi,
    ]

    for (const pattern of contextPatterns) {
      const match = content.match(pattern)
      if (match) {
        memories.push({
          type: 'context',
          content: match[0].trim(),
          sessionId,
          sourceEventSeq: String(event.seq),
          tags: this.extractTags(match[0]),
        })
      }
    }

    return memories
  }

  /**
   * Extract memories from assistant messages.
   * Looks for: facts, skills, knowledge.
   */
  extractAssistantMessage(event, sessionId) {
    const memories = []
    const content = this.extractTextContent(event.data)
    if (!content) return memories

    // Fact patterns (assertions, definitions)
    const factPatterns = [
      /(?:是|are|is|was|were)\s*[：:]?\s*(.+)/gi,
      /(?:包含|contains|includes)\s*[：:]?\s*(.+)/gi,
    ]

    for (const pattern of factPatterns) {
      const match = content.match(pattern)
      if (match && match[0].length > 10 && match[0].length < 200) {
        memories.push({
          type: 'fact',
          content: match[0].trim(),
          sessionId,
          sourceEventSeq: String(event.seq),
          tags: this.extractTags(match[0]),
        })
      }
    }

    return memories
  }

  /**
   * Extract memories from tool results.
   * Looks for: skills, knowledge, file information.
   */
  extractToolResult(event, sessionId) {
    const memories = []
    // Tool results are often informational - extract key findings
    if (event.data?.content && typeof event.data.content === 'string') {
      const content = event.data.content
      if (content.length > 20 && content.length < 500) {
        memories.push({
          type: 'skill',
          content: content.slice(0, 300),
          sessionId,
          sourceEventSeq: String(event.seq),
          tags: ['tool-result'],
        })
      }
    }
    return memories
  }

  /**
   * Extract memories from session titles.
   */
  extractTitle(event, sessionId) {
    if (!event.data?.title) return []
    return [{
      type: 'context',
      content: `Session topic: ${event.data.title}`,
      sessionId,
      sourceEventSeq: String(event.seq),
      tags: ['session-title'],
    }]
  }

  /**
   * Extract text content from event data.
   */
  extractTextContent(data) {
    if (typeof data === 'string') return data
    if (data?.content) {
      if (typeof data.content === 'string') return data.content
      if (Array.isArray(data.content)) {
        return data.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')
      }
    }
    if (data?.text) return data.text
    return null
  }

  /**
   * Extract tags from text content.
   */
  extractTags(text) {
    const tags = []
    // Common patterns
    if (/node\.?js|npm|yarn|pnpm/i.test(text)) tags.push('nodejs')
    if (/python|pip|conda/i.test(text)) tags.push('python')
    if (/docker|container|k8s/i.test(text)) tags.push('devops')
    if (/api|rest|graphql|endpoint/i.test(text)) tags.push('api')
    if (/database|sql|mongo|redis/i.test(text)) tags.push('database')
    if (/test|spec|jest|mocha/i.test(text)) tags.push('testing')
    if (/deploy|ci|cd|github|gitlab/i.test(text)) tags.push('ci-cd')
    return tags
  }

  /**
   * Deduplicate memories by content hash.
   */
  deduplicate(memories) {
    const seen = new Set()
    return memories.filter(m => {
      const hash = this.contentHash(m.content)
      if (seen.has(hash)) return false
      seen.add(hash)
      return true
    })
  }

  /**
   * Compute a content hash for deduplication.
   */
  contentHash(content) {
    // Simple hash - could use crypto.createHash for production
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash |= 0
    }
    return String(hash)
  }
}

// ─── Memory Service ─────────────────────────────────────────────

// ─── Memory Scheduler ───────────────────────────────────────────

/**
 * Periodic scheduler for memory maintenance tasks.
 * Runs decay and consolidation at configurable intervals.
 */
class MemoryScheduler {
  /** @type {ReturnType<typeof setInterval> | undefined} */
  _timer
  _running = false
  _lastRun = 0
  _service
  _config
  _logger

  /**
   * @param {CrossSessionMemoryService} service
   * @param {Object} config
   * @param {number} config.decayIntervalMs - Decay interval in ms (default: 1 hour)
   * @param {number} config.consolidateIntervalMs - Consolidation interval in ms (default: 6 hours)
   * @param {boolean} config.enabled - Enable/disable scheduler
   */
  constructor(service, config, logger) {
    this._service = service
    this._logger = logger
    this._config = {
      decayIntervalMs: config.decayIntervalMs || 60 * 60 * 1000,        // 1 hour
      consolidateIntervalMs: config.consolidateIntervalMs || 6 * 60 * 60 * 1000, // 6 hours
      enabled: config.enabled !== false,
    }
  }

  /**
   * Start the scheduler. Kicks off the first cycle immediately,
   * then repeats at configured intervals.
   */
  start() {
    if (!this._config.enabled) {
      this._logger?.info('[dsh-memory-scheduler] scheduler disabled by config')
      return
    }

    this._logger?.info(
      `[dsh-memory-scheduler] started — decay every ${Math.round(this._config.decayIntervalMs / 60000)}min, ` +
      `consolidate every ${Math.round(this._config.consolidateIntervalMs / 3600000)}h`
    )

    // Kick off first maintenance cycle after a short delay (let startup settle)
    const warmupMs = 30_000 // 30 seconds
    setTimeout(() => this._runMaintenanceCycle(), warmupMs)

    // Schedule periodic runs — decay runs more frequently than consolidation
    const intervalMs = Math.min(this._config.decayIntervalMs, this._config.consolidateIntervalMs)
    this._timer = setInterval(() => this._runMaintenanceCycle(), intervalMs)
  }

  /**
   * Stop the scheduler and clean up.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
      this._logger?.info('[dsh-memory-scheduler] stopped')
    }
  }

  /**
   * Run one maintenance cycle: decay → consolidation.
   * Deduplicates concurrent runs.
   */
  async _runMaintenanceCycle() {
    if (this._running) {
      this._logger?.info('[dsh-memory-scheduler] previous cycle still running, skipping')
      return
    }

    this._running = true
    const cycleStart = Date.now()

    try {
      const now = Date.now()
      const timeSinceLastDecay = now - this._lastRun

      // --- Decay (runs every cycle) ---
      if (timeSinceLastDecay >= this._config.decayIntervalMs) {
        this._logger?.info('[dsh-memory-scheduler] running decay…')
        const decayResult = await this._service.runDecay()
        this._logger?.info(
          `[dsh-memory-scheduler] decay done — ${decayResult.decayed} decayed, ${decayResult.archived} archived`
        )
      }

      // --- Consolidation (runs less frequently) ---
      const timeSinceLastConsolidate = now - (this._lastConsolidateRun || 0)
      if (timeSinceLastConsolidate >= this._config.consolidateIntervalMs) {
        this._logger?.info('[dsh-memory-scheduler] running consolidation…')
        const consResult = await this._service.consolidate()
        this._logger?.info(
          `[dsh-memory-scheduler] consolidation done — ${consResult.consolidated} merged`
        )
        this._lastConsolidateRun = now
      }

      this._lastRun = Date.now()
    } catch (error) {
      this._logger?.error(`[dsh-memory-scheduler] maintenance error: ${error.message}`)
    } finally {
      this._running = false
      const elapsed = Date.now() - cycleStart
      this._logger?.info(`[dsh-memory-scheduler] cycle completed in ${elapsed}ms`)
    }
  }

  /** Expose for manual trigger */
  triggerNow() {
    return this._runMaintenanceCycle()
  }
}

// ─── Semantic Consolidator ──────────────────────────────────────

/**
 * LLM-powered semantic consolidation.
 * Goes beyond content_hash deduplication to find and merge
 * semantically similar memories.
 *
 * In DSH runtime: automatically uses ctx.llm (zero-config).
 * Standalone: falls back to llmCallback or heuristic-only merging.
 */
class SemanticConsolidator {
  _db
  _ctx
  _llmCallback
  _logger
  _llmAvailable = false

  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {Object} options
   * @param {Object} [options.ctx] - DSH Context (provides ctx.llm automatically)
   * @param {Function} [options.llmCallback] - Fallback async fn(messages) => summary
   * @param {Object} [options.logger]
   */
  constructor(db, options = {}) {
    this._db = db
    this._ctx = options.ctx || null
    this._llmCallback = options.llmCallback || null
    this._logger = options.logger
    // Probe whether ctx.llm is available
    this._llmAvailable = !!(this._ctx?.llm?.stream)
  }

  /**
   * Find semantically similar memory pairs.
   * Uses a multi-signal scoring approach:
   *  1. Tag overlap (Jaccard similarity)
   *  2. Content word overlap (Jaccard similarity)
   *  3. Type match bonus
   *  4. Temporal proximity bonus
   *
   * @param {number} threshold - Minimum similarity score (0-1) to consider a pair
   * @returns {Array<{m1: Object, m2: Object, score: number}>}
   */
  findSimilarPairs(threshold = 0.5) {
    // Get active memories grouped by type for efficiency
    const memories = this._db.prepare(`
      SELECT id, type, content, session_id, tags, created_at, access_count, relevance_score
      FROM memories
      WHERE status = 'active'
      ORDER BY type, created_at
    `).all()

    const pairs = []
    const typeGroups = new Map()

    for (const mem of memories) {
      const tags = JSON.parse(mem.tags || '[]')
      const words = this._tokenize(mem.content)
      const enriched = { ...mem, tagsSet: new Set(tags), words }

      if (!typeGroups.has(mem.type)) typeGroups.set(mem.type, [])
      typeGroups.get(mem.type).push(enriched)
    }

    // Compare within same type (much more efficient)
    for (const [, group] of typeGroups) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const score = this._computeSimilarity(group[i], group[j])
          if (score >= threshold) {
            pairs.push({ m1: group[i], m2: group[j], score })
          }
        }
      }
    }

    // Sort by score descending, return top-N
    return pairs
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
  }

  /**
   * Compute similarity between two memories (0-1).
   */
  _computeSimilarity(a, b) {
    // 1. Tag overlap (Jaccard)
    const tagIntersection = new Set([...a.tagsSet].filter(t => b.tagsSet.has(t)))
    const tagUnion = new Set([...a.tagsSet, ...b.tagsSet])
    const tagSim = tagUnion.size > 0 ? tagIntersection.size / tagUnion.size : 0

    // 2. Content word overlap (Jaccard)
    const wordIntersection = new Set([...a.words].filter(w => b.words.has(w)))
    const wordUnion = new Set([...a.words, ...b.words])
    const wordSim = wordUnion.size > 0 ? wordIntersection.size / wordUnion.size : 0

    // 3. Type match bonus (always 1 since we group by type)
    const typeSim = 1

    // 4. Temporal proximity (closer = more similar)
    const dayDiff = Math.abs(a.created_at - b.created_at) / (24 * 60 * 60 * 1000)
    const temporalSim = Math.max(0, 1 - dayDiff / 90) // decay over 90 days

    // Weighted combination
    return (tagSim * 0.35) + (wordSim * 0.35) + (typeSim * 0.1) + (temporalSim * 0.2)
  }

  /**
   * Call LLM to merge two memory contents.
   * Priority: ctx.llm (DSH runtime) → llmCallback (standalone) → null
   *
   * @param {string} contentA
   * @param {string} contentB
   * @returns {Promise<string|null>}
   */
  async _callLLM(contentA, contentB) {
    const systemPrompt = 'You are a memory consolidation assistant. Merge these two related memories into one concise, comprehensive statement. Return ONLY the merged text, no explanation, no quotes.'
    const userPrompt = `Memory A: ${contentA}\n\nMemory B: ${contentB}`

    // Strategy 1: Use DSH's built-in LLM service (zero-config)
    if (this._llmAvailable) {
      try {
        const assembler = { _text: '', push(chunk) { if (chunk.type === 'text') this._text += chunk.text } }
        const options = {
          route: {}, // Use default model
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          maxTokens: 256,
        }
        for await (const chunk of this._ctx.llm.stream(options)) {
          assembler.push(chunk)
        }
        const result = assembler._text.trim()
        if (result.length > 0) return result
      } catch (error) {
        this._logger?.warn(`[dsh-memory-consolidator] ctx.llm.stream failed: ${error.message}`)
        // Fall through to callback
      }
    }

    // Strategy 2: Use provided llmCallback (standalone / custom)
    if (this._llmCallback) {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]
      const result = await this._llmCallback(messages)
      return typeof result === 'string' ? result : null
    }

    // Strategy 3: No LLM available
    return null
  }

  /**
   * Merge a pair of similar memories.
   * Keeps the higher-accessed memory, merges content.
   */
  async mergePair(pair) {
    const { m1, m2, score } = pair

    // Keep the one with higher access count or relevance
    const keepScore = m1.access_count * 1.5 + m1.relevance_score * 10
    const archiveScore = m2.access_count * 1.5 + m2.relevance_score * 10
    const [keep, archive] = keepScore >= archiveScore ? [m1, m2] : [m2, m1]

    // Use LLM to create a merged summary (automatic or fallback)
    let mergedContent = keep.content
    try {
      const summary = await this._callLLM(m1.content, m2.content)
      if (summary && summary.length > 5 && summary.length < 500) {
        mergedContent = summary
      }
    } catch (error) {
      this._logger?.warn(`[dsh-memory-consolidator] LLM merge failed, using heuristic: ${error.message}`)
      // Heuristic fallback: keep the longer content
      mergedContent = keep.content.length >= archive.content.length
        ? keep.content
        : archive.content
    }

    // Merge tags (union)
    const keepTags = JSON.parse(this._db.prepare('SELECT tags FROM memories WHERE id = ?').get(keep.id)?.tags || '[]')
    const archiveTags = JSON.parse(this._db.prepare('SELECT tags FROM memories WHERE id = ?').get(archive.id)?.tags || '[]')
    const mergedTags = [...new Set([...keepTags, ...archiveTags])]

    // Update the kept memory
    this._db.prepare(`
      UPDATE memories
      SET content = ?, tags = ?, access_count = MAX(access_count, ?),
          relevance_score = MAX(relevance_score, ?)
      WHERE id = ?
    `).run(mergedContent, JSON.stringify(mergedTags), archive.access_count, archive.relevance_score, keep.id)

    // Archive the other
    this._db.prepare(`
      UPDATE memories SET status = 'archived', parent_memory_id = ? WHERE id = ?
    `).run(keep.id, archive.id)

    // Update FTS for the kept memory
    this._db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(keep.id)
    this._db.prepare('INSERT INTO memory_fts (memory_id, content, tags) VALUES (?, ?, ?)')
      .run(keep.id, mergedContent, mergedTags.join(' '))

    // Log the consolidation
    this._db.prepare(`
      INSERT INTO memory_consolidation_log (source_memory_ids, target_memory_id, merge_score, merged_at)
      VALUES (?, ?, ?, ?)
    `).run(JSON.stringify([m1.id, m2.id]), keep.id, score, Date.now())

    return { kept: keep.id, archived: archive.id, score }
  }

  _tokenize(text) {
    return new Set(
      text.toLowerCase()
        .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1)
    )
  }
}

// ─── Memory Service ─────────────────────────────────────────────

/**
 * Cross-session memory service.
 * Provides memory extraction, storage, search, recall,
 * scheduled maintenance, and LLM-powered semantic consolidation.
 */
export class CrossSessionMemoryService extends Service {
  /**
   * 'sessions' is required; 'llm' is optional — when available the plugin
   * uses it for semantic consolidation, otherwise falls back to heuristic.
   */
  static inject = ['sessions']
  static optionalInject = ['llm']
  static Config = z.object({
    /** Path to the SQLite memory database */
    path: z.string().required(),
    /** Open SQLite at startup or first-query */
    openAt: z.union(['startup', 'first-query', 'never']).default('startup'),
    /** Maximum memories to recall per session */
    maxRecallCount: z.number().step(1).min(1).max(100).default(10),
    /** Memory decay rate (0 = no decay, 1 = immediate) */
    decayRate: z.number().min(0).max(1).default(0.01),
    /** Minimum relevance score for recall */
    minRelevanceThreshold: z.number().min(0).max(1).default(0.3),
    /** Maximum memories before consolidation */
    consolidationThreshold: z.number().step(1).min(10).default(500),
    /** Extraction batch size */
    extractionBatchSize: z.number().step(1).min(1).max(50).default(10),
    /** Journal mode for SQLite */
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist']).default('wal'),
    /** Scheduler: enable/disable periodic maintenance */
    schedulerEnabled: z.boolean().default(true),
    /** Scheduler: decay interval in milliseconds (default: 1 hour) */
    schedulerDecayIntervalMs: z.number().min(60_000).default(60 * 60 * 1000),
    /** Scheduler: consolidation interval in milliseconds (default: 6 hours) */
    schedulerConsolidateIntervalMs: z.number().min(300_000).default(6 * 60 * 60 * 1000),
    /** Semantic similarity threshold for consolidation (0-1) */
    similarityThreshold: z.number().min(0).max(1).default(0.5),
    /** Maximum tokens for memory context injection (prevents context explosion) */
    maxContextTokens: z.number().step(100).min(100).max(100000).default(4000),
    /** Token budget reserved for other context (system prompt, etc.) */
    reservedTokens: z.number().step(100).min(100).max(100000).default(8000),
    /** Enable smart prioritization (sort by relevance × recency) */
    smartPrioritization: z.boolean().default(true),
    /** Enable memory compression for old memories */
    enableCompression: z.boolean().default(true),
  })

  /** @type {import('node:sqlite').DatabaseSync | undefined} */
  _db
  _ready
  _closed = false
  _extractor
  /** @type {MemoryScheduler | undefined} */
  _scheduler
  /** @type {SemanticConsolidator | undefined} */
  _consolidator

  constructor(ctx, config) {
    super(ctx, config)
    this._extractor = new MemoryExtractor(config)

    // Subscribe to session lifecycle events
    ctx.on('session/event', (session, event) => {
      this._onEvent(session, event)
    })

    ctx.on('session/created', (session) => {
      this._onCreated(session)
    })

    ctx.on('session/disposed', (session) => {
      this._onDisposed(session)
    })

    ctx.on('session/flush', (session) => {
      this._onFlush(session)
    })

    // Register cleanup
    ctx.effect(() => async () => {
      await this.close()
    }, 'crossSessionMemory.close')
  }

  async [Service.init]() {
    if (this.config.openAt === 'startup') {
      await this._ensureReady()
    }
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Search memories across all sessions using RRF (Reciprocal Rank Fusion).
   * Combines FTS5 keyword search with optional semantic ranking.
   *
   * @param {Object} request
   * @param {string} request.query - Search query
   * @param {string[]} [request.types] - Filter by memory types
   * @param {string[]} [request.tags] - Filter by tags
   * @param {string} [request.excludeSessionId] - Exclude memories from this session
   * @param {number} [request.limit] - Max results
   * @returns {Promise<Memory[]>}
   */
  async searchMemories(request) {
    await this._ensureReady()
    const db = this._requireDb()
    const limit = request.limit ?? this.config.maxRecallCount

    // FTS search
    const ftsQuery = request.query
      .split(/\s+/)
      .filter(Boolean)
      .map(w => `"${w}"`)
      .join(' AND ')

    let ftsSql = `
      SELECT
        m.*,
        rank as fts_rank
      FROM memory_fts f
      JOIN memories m ON m.id = f.memory_id
      WHERE memory_fts MATCH ?
        AND m.status = 'active'
    `
    const ftsParams = [ftsQuery]

    if (request.types?.length) {
      ftsSql += ` AND m.type IN (${request.types.map(() => '?').join(',')})`
      ftsParams.push(...request.types)
    }

    if (request.excludeSessionId) {
      ftsSql += ` AND m.session_id != ?`
      ftsParams.push(request.excludeSessionId)
    }

    ftsSql += ` ORDER BY rank LIMIT ?`
    ftsParams.push(limit * 2) // Get more for fusion

    const ftsRows = db.prepare(ftsSql).all(...ftsParams)

    // Apply RRF fusion with decay scores
    const k = 60 // RRF constant
    const rrfScores = new Map()

    for (let i = 0; i < ftsRows.length; i++) {
      const row = ftsRows[i]
      const rrfScore = 1 / (k + i)
      const decayWeight = row.relevance_score || 0.5
      rrfScores.set(row.id, {
        memory: rowToMemory(row),
        score: rrfScore * decayWeight,
      })
    }

    // Sort by RRF score and return top-K
    return Array.from(rrfScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.memory)
  }

  /**
   * Recall memories relevant to a new session.
   * @param {string} sessionId - Current session id
   * @param {string} context - Context text for relevance matching
   * @param {number} [limit] - Max memories to recall
   * @returns {Promise<Memory[]>}
   */
  async recallForSession(sessionId, context, limit) {
    await this._ensureReady()
    const maxCount = limit ?? this.config.maxRecallCount

    // Search for relevant memories, excluding current session
    const memories = await this.searchMemories({
      query: context,
      excludeSessionId: sessionId,
      limit: maxCount,
    })

    // Update access metadata
    const db = this._requireDb()
    const now = Date.now()
    const updateAccess = db.prepare(`
      UPDATE memories
      SET last_accessed_at = ?, access_count = access_count + 1
      WHERE id = ?
    `)

    for (const memory of memories) {
      updateAccess.run(now, memory.id)
    }

    return memories
  }

  /**
   * Store a memory explicitly.
   * @param {Partial<Memory>} memory
   * @returns {Promise<Memory>}
   */
  async storeMemory(memory) {
    await this._ensureReady()
    const db = this._requireDb()

    const id = memory.id || `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO memories (
        id, type, content, session_id, source_event_seq,
        created_at, last_accessed_at, access_count, relevance_score,
        tags, parent_memory_id, status, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const contentHash = this._extractor.contentHash(memory.content || '')
    const tags = JSON.stringify(memory.tags || [])

    stmt.run(
      id,
      memory.type || 'fact',
      memory.content || '',
      memory.sessionId || '',
      memory.sourceEventSeq || '0',
      memory.createdAt || now,
      memory.lastAccessedAt || now,
      memory.accessCount || 0,
      memory.relevanceScore ?? 0.5,
      tags,
      memory.parentMemoryId || null,
      memory.status || 'active',
      contentHash
    )

    // Update FTS index
    this._upsertFts(id, memory.content || '', tags)

    return this.getMemory(id)
  }

  /**
   * Get a single memory by id.
   */
  async getMemory(id) {
    await this._ensureReady()
    const db = this._requireDb()
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    return row ? rowToMemory(row) : null
  }

  /**
   * Get memory statistics.
   */
  async getStats() {
    await this._ensureReady()
    const db = this._requireDb()

    const total = db.prepare('SELECT COUNT(*) as count FROM memories WHERE status = ?').get('active')
    const byType = db.prepare('SELECT type, COUNT(*) as count FROM memories WHERE status = ? GROUP BY type').all('active')
    const bySession = db.prepare('SELECT session_id, COUNT(*) as count FROM memories WHERE status = ? GROUP BY session_id ORDER BY count DESC LIMIT 10').all('active')

    return {
      totalMemories: total.count,
      byType: Object.fromEntries(byType.map(r => [r.type, r.count])),
      topSessions: bySession.map(r => ({ sessionId: r.session_id, count: r.count })),
    }
  }

  /**
   * Manually trigger a maintenance cycle (decay + consolidation).
   * Useful for testing or on-demand cleanup.
   */
  async triggerMaintenance() {
    if (this._scheduler) {
      await this._scheduler.triggerNow()
      return { triggered: true }
    }
    // Fallback: run directly without scheduler
    const decayResult = await this.runDecay()
    const consResult = await this.consolidate()
    return { triggered: true, decay: decayResult, consolidation: consResult }
  }

  /**
   * Get scheduler status and configuration.
   */
  getSchedulerStatus() {
    if (!this._scheduler) {
      return { enabled: false, running: false }
    }
    return {
      enabled: this.config.schedulerEnabled,
      decayIntervalMs: this.config.schedulerDecayIntervalMs,
      consolidateIntervalMs: this.config.schedulerConsolidateIntervalMs,
      lastRun: this._scheduler._lastRun || null,
    }
  }

  /**
   * Get consolidation log (recent merges).
   * @param {number} [limit=20]
   */
  async getConsolidationLog(limit = 20) {
    await this._ensureReady()
    const db = this._requireDb()
    return db.prepare(`
      SELECT * FROM memory_consolidation_log ORDER BY merged_at DESC LIMIT ?
    `).all(limit)
  }

  /**
   * Find semantic similarity pairs without merging (for inspection).
   * @param {number} [threshold]
   */
  async findSimilarMemories(threshold) {
    await this._ensureReady()
    if (!this._consolidator) return []
    return this._consolidator.findSimilarPairs(threshold ?? this.config.similarityThreshold)
  }

  /**
   * Consolidate similar memories using two strategies:
   *  1. Exact hash deduplication (fast, always runs)
   *  2. Semantic similarity merging (via SemanticConsolidator)
   */
  async consolidate() {
    await this._ensureReady()
    const db = this._requireDb()

    let consolidated = 0

    // ── Phase 1: Exact content-hash deduplication (fast) ──
    const exactCandidates = db.prepare(`
      SELECT m1.id as id1, m2.id as id2, m1.content as content1, m2.content as content2
      FROM memories m1
      JOIN memories m2 ON m1.id < m2.id
        AND m1.type = m2.type
        AND m1.status = 'active'
        AND m2.status = 'active'
      WHERE m1.content_hash = m2.content_hash
      LIMIT 100
    `).all()

    for (const pair of exactCandidates) {
      const m1 = db.prepare('SELECT * FROM memories WHERE id = ?').get(pair.id1)
      const m2 = db.prepare('SELECT * FROM memories WHERE id = ?').get(pair.id2)
      if (!m1 || !m2) continue

      const [keep, archive] = m1.access_count >= m2.access_count ? [m1, m2] : [m2, m1]
      db.prepare('UPDATE memories SET status = ?, parent_memory_id = ? WHERE id = ?')
        .run('archived', keep.id, archive.id)
      db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(archive.id)
      consolidated++
    }

    // ── Phase 2: Semantic similarity merging ──
    if (this._consolidator) {
      const similarPairs = this._consolidator.findSimilarPairs(this.config.similarityThreshold)
      for (const pair of similarPairs) {
        // Skip if either memory was already archived in Phase 1
        const still = db.prepare('SELECT status FROM memories WHERE id = ? AND status = ?')
        const s1 = still.get(pair.m1.id, 'active')
        const s2 = still.get(pair.m2.id, 'active')
        if (!s1 || !s2) continue

        try {
          await this._consolidator.mergePair(pair)
          consolidated++
        } catch (error) {
          // Semantic merge failures are non-fatal
          console.error(`[dsh-memory] semantic merge error: ${error.message}`)
        }
      }
    }

    return { consolidated }
  }

  /**
   * Run decay on old memories.
   * Uses formula: decay_score = importance × e^(-λ × days) × log(access_count + 1)
   * Where λ = decayRate (default 0.02)
   */
  async runDecay() {
    await this._ensureReady()
    const db = this._requireDb()

    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const lambda = this.config.decayRate

    // Get all active memories and compute decay
    const memories = db.prepare(`
      SELECT id, importance, last_accessed_at, access_count, status
      FROM memories
      WHERE status = 'active'
    `).all()

    let decayed = 0
    let archived = 0

    const updateScore = db.prepare(`
      UPDATE memories SET relevance_score = ?, status = ? WHERE id = ?
    `)

    for (const mem of memories) {
      const daysSinceAccess = (now - mem.last_accessed_at) / dayMs
      const decayScore = mem.importance *
        Math.exp(-lambda * daysSinceAccess) *
        Math.log(mem.access_count + 1)

      const newStatus = decayScore < 0.1 ? 'decayed' : 'active'
      updateScore.run(Math.max(0, Math.min(1, decayScore)), newStatus, mem.id)

      if (newStatus === 'decayed') decayed++
    }

    // Archive old decayed memories (older than 90 days)
    const archivedResult = db.prepare(`
      UPDATE memories
      SET status = 'archived'
      WHERE status = 'decayed'
        AND (now - last_accessed_at) > ? * 90
    `).run(dayMs)
    archived = archivedResult.changes

    return { decayed, archived }
  }

  // ─── Internal Methods ───────────────────────────────────────

  /**
   * Get formatted memory context for injection into a new session.
   * This is the key method that provides cross-session memory recall.
   * Includes context explosion prevention with token budget management.
   *
   * @param {string} sessionId - Current session id
   * @param {string} context - Initial context (e.g., first user message)
   * @returns {Promise<string>} Formatted memory context string
   */
  async getMemoryContext(sessionId, context) {
    if (!context || context.length < 5) return ''

    const memories = await this.recallForSession(sessionId, context)
    if (memories.length === 0) return ''

    // Smart prioritization: sort by relevance × recency if enabled
    let sortedMemories = memories
    if (this.config.smartPrioritization) {
      sortedMemories = this._prioritizeMemories(memories)
    }

    // Token budget management
    const maxTokens = this.config.maxContextTokens
    let usedTokens = 0
    const selectedMemories = []

    // Header tokens
    const header = '## Related Memories from Previous Sessions\n'
    usedTokens += TokenCounter.estimate(header)

    for (const mem of sortedMemories) {
      const age = this._formatAge(mem.createdAt)
      const score = (mem.relevanceScore * 100).toFixed(0)
      const line1 = `- [${mem.type}] ${mem.content}`
      const line2 = `  Source: Session ${mem.sessionId} | ${age} | Relevance: ${score}%`
      const memTokens = TokenCounter.estimate(line1 + '\n' + line2 + '\n')

      // Check if adding this memory would exceed budget
      if (usedTokens + memTokens > maxTokens) {
        // Try to compress the memory content
        if (this.config.enableCompression) {
          const remainingTokens = maxTokens - usedTokens - 50 // Reserve 50 tokens for header
          if (remainingTokens > 20) {
            const compressed = this._compressMemory(mem, remainingTokens)
            if (compressed) {
              selectedMemories.push(compressed)
              usedTokens += TokenCounter.estimate(compressed.text)
            }
          }
        }
        break // Stop adding more memories
      }

      selectedMemories.push({
        text: `${line1}\n${line2}`,
        tokens: memTokens
      })
      usedTokens += memTokens
    }

    if (selectedMemories.length === 0) return ''

    // Build final context with token budget info
    const lines = [header]
    for (const item of selectedMemories) {
      lines.push(item.text)
    }
    
    // Add budget summary
    lines.push(`\n> 💾 Memory: ${selectedMemories.length}/${memories.length} memories | ${usedTokens}/${maxTokens} tokens`)

    return lines.join('\n')
  }

  /**
   * Prioritize memories by relevance × recency score.
   * @param {Memory[]} memories
   * @returns {Memory[]} Sorted memories
   */
  _prioritizeMemories(memories) {
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000

    return memories
      .map(mem => {
        // Combined score: relevance (0-1) × recency factor (0-1) × access frequency
        const daysSinceAccess = (now - mem.lastAccessedAt) / dayMs
        const recencyFactor = Math.max(0, 1 - daysSinceAccess / 90) // Decays over 90 days
        const accessFactor = Math.min(1, Math.log(mem.accessCount + 1) / Math.log(10)) // Log scale
        const combinedScore = mem.relevanceScore * 0.5 + recencyFactor * 0.3 + accessFactor * 0.2
        
        return { ...mem, priorityScore: combinedScore }
      })
      .sort((a, b) => b.priorityScore - a.priorityScore)
  }

  /**
   * Compress a memory to fit within token budget.
   * @param {Memory} mem
   * @param {number} maxTokens
   * @returns {{ text: string, tokens: number } | null}
   */
  _compressMemory(mem, maxTokens) {
    const age = this._formatAge(mem.createdAt)
    const score = (mem.relevanceScore * 100).toFixed(0)
    
    // Try different compression levels
    const compressions = [
      // Level 1: Truncate content
      () => {
        const truncated = TokenCounter.truncate(mem.content, maxTokens - 30)
        const text = `- [${mem.type}] ${truncated} (${score}%)`
        return { text, tokens: TokenCounter.estimate(text) }
      },
      // Level 2: Summary only
      () => {
        const text = `- [${mem.type}] ${score}% relevant`
        return { text, tokens: TokenCounter.estimate(text) }
      },
    ]

    for (const compress of compressions) {
      const result = compress()
      if (result.tokens <= maxTokens) {
        return result
      }
    }

    return null
  }

  /**
   * Format age from timestamp to human readable.
   */
  _formatAge(timestamp) {
    const now = Date.now()
    const diffMs = now - timestamp
    const days = Math.floor(diffMs / (24 * 60 * 60 * 1000))
    if (days === 0) return 'today'
    if (days === 1) return 'yesterday'
    if (days < 7) return `${days} days ago`
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`
    return `${Math.floor(days / 30)} months ago`
  }

  async _onEvent(session, event) {
    if (this._closed) return
    if (!this._isExtractableEvent(event)) return

    try {
      const memories = await this._extractor.extract([event], session.header.id)
      for (const memory of memories) {
        if (memory.content && memory.content.length > 10) {
          await this.storeMemory({
            ...memory,
            sessionId: session.header.id,
            sourceEventSeq: String(event.seq),
          })
        }
      }
    } catch (error) {
      // Memory extraction errors should not break the session
      console.error(`[dsh-memory] extraction error: ${error.message}`)
    }
  }

  async _onCreated(session) {
    if (this._closed) return
    await this._ensureReady()
    const db = this._requireDb()

    db.prepare(`
      INSERT OR IGNORE INTO extraction_state (session_id, last_extracted_seq, extraction_status)
      VALUES (?, 0, 'pending')
    `).run(session.header.id)

    // Auto-inject relevant memories for the new session
    try {
      const cwd = session.header.cwd || ''
      if (cwd.length > 3) {
        const context = await this.getMemoryContext(session.header.id, cwd)
        if (context) {
          // Store for later injection into the session
          session._memoryContext = context
        }
      }
    } catch (error) {
      console.error(`[dsh-memory] context injection error: ${error.message}`)
    }
  }

  /**
   * Build initial index from persisted sessions.
   * Uses ctx.sessionPersistence.readFrom() for incremental indexing.
   */
  async buildIndexFromPersistence(sessionPersistence) {
    if (this._closed || !sessionPersistence) return

    await this._ensureReady()
    const db = this._requireDb()

    try {
      const storedSessions = await sessionPersistence.list()
      console.log(`[dsh-memory] indexing ${storedSessions.length} persisted sessions...`)

      for (const stored of storedSessions) {
        const state = db.prepare('SELECT * FROM extraction_state WHERE session_id = ?').get(stored.id)
        const lastSeq = state?.last_extracted_seq || 0

        // Incremental read from last indexed position
        const events = await sessionPersistence.readFrom(stored.id, lastSeq)
        if (events.length > 0) {
          const memories = await this._extractor.extract(events, stored.id)
          for (const memory of memories) {
            if (memory.content && memory.content.length > 10) {
              await this.storeMemory({
                ...memory,
                sessionId: stored.id,
                sourceEventSeq: String(memory.sourceEventSeq || '0'),
              })
            }
          }
          // Update extraction state
          const maxSeq = Math.max(...events.map(e => e.seq))
          db.prepare('UPDATE extraction_state SET last_extracted_seq = ?, extraction_status = ? WHERE session_id = ?')
            .run(maxSeq, 'indexed', stored.id)
        }
      }
      console.log(`[dsh-memory] index build complete`)
    } catch (error) {
      console.error(`[dsh-memory] index build error: ${error.message}`)
    }
  }

  async _onDisposed(session) {
    // Final extraction on session end
    if (this._closed) return
    // Could do a final comprehensive extraction here
  }

  async _onFlush(session) {
    // No-op - memories are written immediately
  }

  /**
   * High-value event types for memory extraction.
   * Based on DSH SessionEventMap analysis.
   */
  _isExtractableEvent(event) {
    const extractableTypes = [
      // Primary conversation events
      'user/message',
      'assistant/message',
      'tool/result',
      // Session metadata
      'session/title',
      // Compaction summaries (compressed conversation context)
      'compaction/summary',
      // Goal and task tracking
      'goal/change',
      'todo/write',
      // Turn boundaries (for context segmentation)
      'turn/end',
    ]
    return extractableTypes.includes(event.type)
  }

  _upsertFts(id, content, tags) {
    const db = this._requireDb()
    // Remove old entry
    db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(id)
    // Insert new entry
    db.prepare('INSERT INTO memory_fts (memory_id, content, tags) VALUES (?, ?, ?)')
      .run(id, content, tags)
  }

  async _ensureReady() {
    this._ready ??= this._open()
    await this._ready
  }

  async _open() {
    const path = this.config.path === ':memory:'
      ? ':memory:'
      : resolve(this.config.path)

    if (path !== ':memory:') {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      try {
        await (await open(path, 'wx', 0o600)).close()
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }

    const { DatabaseSync } = await import('node:sqlite')
    this._db = new DatabaseSync(path)

    ensureMemorySchema(this._db)
    this._ensureConsolidationLogSchema(this._db)
    this._db.exec(`PRAGMA journal_mode = ${this.config.journalMode.toUpperCase()}`)

    // Initialize semantic consolidator with DSH LLM integration
    this._consolidator = new SemanticConsolidator(this._db, {
      ctx: this.ctx,
      logger: this.ctx?.logger,
    })

    // Start the scheduler for periodic maintenance
    this._scheduler = new MemoryScheduler(this, {
      enabled: this.config.schedulerEnabled,
      decayIntervalMs: this.config.schedulerDecayIntervalMs,
      consolidateIntervalMs: this.config.schedulerConsolidateIntervalMs,
    }, this.ctx?.logger)
    this._scheduler.start()
  }

  _requireDb() {
    if (!this._db) throw new Error('memory store not initialized')
    return this._db
  }

  /**
   * Ensure the consolidation log table exists.
   */
  _ensureConsolidationLogSchema(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_consolidation_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        source_memory_ids TEXT NOT NULL,
        target_memory_id  TEXT NOT NULL,
        merge_score       REAL NOT NULL,
        merged_at         INTEGER NOT NULL
      ) STRICT
    `)
  }

  async close() {
    if (this._closed) return
    this._closed = true
    // Stop the scheduler first
    if (this._scheduler) {
      this._scheduler.stop()
      this._scheduler = undefined
    }
    if (this._db) {
      this._db.close()
      this._db = undefined
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function rowToMemory(row) {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    sessionId: row.session_id,
    sourceEventSeq: row.source_event_seq,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    relevanceScore: row.relevance_score,
    tags: JSON.parse(row.tags || '[]'),
    parentMemoryId: row.parent_memory_id,
    status: row.status,
  }
}

// ─── Cordis Plugin Export ───────────────────────────────────────

/**
 * DSH Memory Plugin.
 * Registers the crossSessionMemory service on the host plane.
 */
export default {
  name: 'cross-session-memory',
  inject: ['sessions'],
  apply(ctx, config) {
    ctx.provide('crossSessionMemory', CrossSessionMemoryService, config)
  },
}


