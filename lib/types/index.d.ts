/**
 * @deepseek-ai/dsh-memory-connect
 *
 * Cross-session memory sharing plugin type declarations.
 *
 * @module @deepseek-ai/dsh-memory-connect
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

// ─── Memory Types ───────────────────────────────────────────────

/** Memory category classification */
export type MemoryType = 'fact' | 'preference' | 'context' | 'decision' | 'skill'

/** Memory lifecycle status */
export type MemoryStatus = 'active' | 'consolidated' | 'decayed' | 'archived'

/** A single memory entry */
export interface Memory {
  /** Unique memory identifier */
  id: string
  /** Memory category */
  type: MemoryType
  /** Extracted memory text content */
  content: string
  /** Source session id */
  sessionId: string
  /** Source event sequence number */
  sourceEventSeq: string
  /** Creation timestamp (ms since epoch) */
  createdAt: number
  /** Last recall timestamp */
  lastAccessedAt: number
  /** Number of times recalled */
  accessCount: number
  /** Computed relevance score (0-1) */
  relevanceScore: number
  /** Extracted tags for filtering */
  tags: string[]
  /** Parent memory id for consolidation chains */
  parentMemoryId: string | null
  /** Memory lifecycle status */
  status: MemoryStatus
}

/** Memory search request */
export interface MemorySearchRequest {
  /** Search query text */
  query: string
  /** Filter by memory types */
  types?: MemoryType[]
  /** Filter by tags */
  tags?: string[]
  /** Exclude memories from this session */
  excludeSessionId?: string
  /** Maximum results to return */
  limit?: number
}

/** Memory statistics */
export interface MemoryStats {
  totalMemories: number
  byType: Record<MemoryType, number>
  topSessions: Array<{ sessionId: string; count: number }>
}

/** Semantic similarity pair for inspection */
export interface SimilarityPair {
  m1: Memory
  m2: Memory
  score: number
}

/** Consolidation log entry */
export interface ConsolidationLogEntry {
  id: number
  source_memory_ids: string
  target_memory_id: string
  merge_score: number
  merged_at: number
}

/** Scheduler status */
export interface SchedulerStatus {
  enabled: boolean
  running?: boolean
  decayIntervalMs?: number
  consolidateIntervalMs?: number
  lastRun?: number | null
}

/** Plugin configuration */
export interface MemoryConfig {
  /** Path to SQLite memory database */
  path: string
  /** Open SQLite at startup or first-query */
  openAt?: 'startup' | 'first-query' | 'never'
  /** Maximum memories to recall per session */
  maxRecallCount?: number
  /** Memory decay rate (0 = no decay, 1 = immediate) */
  decayRate?: number
  /** Minimum relevance score for recall */
  minRelevanceThreshold?: number
  /** Maximum memories before consolidation */
  consolidationThreshold?: number
  /** Extraction batch size */
  extractionBatchSize?: number
  /** Journal mode for SQLite */
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'
  /** Enable/disable periodic maintenance scheduler */
  schedulerEnabled?: boolean
  /** Decay interval in milliseconds (default: 1 hour) */
  schedulerDecayIntervalMs?: number
  /** Consolidation interval in milliseconds (default: 6 hours) */
  schedulerConsolidateIntervalMs?: number
  /** Semantic similarity threshold for consolidation (0-1) */
  similarityThreshold?: number
}

// ─── Service Interface ──────────────────────────────────────────

/**
 * Cross-session memory service.
 * Provides memory extraction, storage, search, and recall.
 */
export class CrossSessionMemoryService extends Service {
  static inject: string[]
  static optionalInject: string[]
  static Config: z.ZodObject<any>

  /** Search memories across all sessions */
  searchMemories(request: MemorySearchRequest): Promise<Memory[]>

  /** Recall memories relevant to a new session */
  recallForSession(sessionId: string, context: string, limit?: number): Promise<Memory[]>

  /** Store a memory explicitly */
  storeMemory(memory: Partial<Memory>): Promise<Memory>

  /** Get a single memory by id */
  getMemory(id: string): Promise<Memory | null>

  /** Get memory statistics */
  getStats(): Promise<MemoryStats>

  /** Get formatted memory context for injection */
  getMemoryContext(sessionId: string, context: string): Promise<string>

  /** Consolidate similar memories (hash + semantic) */
  consolidate(): Promise<{ consolidated: number }>

  /** Run decay on old memories */
  runDecay(): Promise<{ decayed: number; archived: number }>

  /** Manually trigger a maintenance cycle (decay + consolidation) */
  triggerMaintenance(): Promise<{ triggered: boolean; decay?: { decayed: number; archived: number }; consolidation?: { consolidated: number } }>

  /** Get scheduler status and configuration */
  getSchedulerStatus(): SchedulerStatus

  /** Get recent consolidation log entries */
  getConsolidationLog(limit?: number): Promise<ConsolidationLogEntry[]>

  /** Find semantic similarity pairs without merging */
  findSimilarMemories(threshold?: number): Promise<SimilarityPair[]>

  /** Close the memory store */
  close(): Promise<void>
}

// ─── Context Extension ──────────────────────────────────────────

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-session memory service */
    crossSessionMemory: CrossSessionMemoryService
  }
}

// ─── Plugin Export ──────────────────────────────────────────────

/** DSH Memory Plugin */
declare const plugin: {
  name: 'cross-session-memory'
  inject: string[]
  optionalInject?: string[]
  apply(ctx: Context, config: MemoryConfig): void
}

export default plugin
