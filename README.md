# @deepseek-ai/dsh-memory-connect

> Cross-session memory plugin for DeepSeek Harness (DSH)  
> 跨会话记忆插件 — 让 AI Agent 拥有持久记忆

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-Compatible-brightgreen.svg)](https://github.com/deepseek-ai/dsh)

---

**English** | [中文](#中文)

## Overview

`dsh-memory-connect` is a cross-session memory sharing plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh). It automatically extracts, stores, and recalls memories across sessions, giving your AI agent persistent, intelligent memory.

**Zero-config** — works out of the box with SQLite FTS5 and DSH's built-in LLM.

## Features

| Feature | Description |
|---------|-------------|
| 🔍 **Auto Extraction** | Extracts facts, preferences, decisions, and context from conversations |
| 🧠 **Semantic Recall** | RRF (Reciprocal Rank Fusion) combines keyword and semantic search |
| ⏰ **Scheduled Maintenance** | Automatic periodic decay and consolidation via built-in scheduler |
| 🤖 **LLM Consolidation** | Automatic intelligent memory merging using DSH's built-in `ctx.llm` |
| 📉 **Memory Decay** | Old, unused memories naturally fade; frequently accessed ones persist |
| 🔧 **Zero Config** | Works with SQLite FTS5, no additional dependencies needed |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Memory Plugin Data Flow                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────┐    session/event    ┌──────────────────┐           │
│  │ Session  │ ──────────────────→ │ MemoryExtractor  │           │
│  │ Engine   │                     │ (Rule-based)     │           │
│  └──────────┘                     └────────┬─────────┘           │
│                                            │                     │
│                                            ▼                     │
│                                   ┌──────────────────┐           │
│                                   │  SQLite FTS5     │           │
│                                   │  memories        │           │
│                                   │  + memory_fts    │           │
│                                   └────────┬─────────┘           │
│                                            │                     │
│  ┌──────────┐   session/created   ┌────────▼─────────┐           │
│  │ New      │ ←────────────────── │ ContextInjector  │           │
│  │ Session  │                     │ (FTS5 + RRF)     │           │
│  └──────────┘                     └──────────────────┘           │
│                                                                   │
│  ┌──────────────────────┐  ┌─────────────────────┐              │
│  │   MemoryScheduler    │  │ SemanticConsolidator │              │
│  │  (setInterval)       │→ │ (Tag+Word+Temporal)  │              │
│  │  • Decay (1h)        │  │ + ctx.llm merge     │              │
│  │  • Consolidate (6h)  │  └─────────────────────┘              │
│  └──────────────────────┘                                        │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install @deepseek-ai/dsh-memory-connect
```

Add to your DSH composition:

```yaml
# agent.cordis.yml
- id: memory
  name: '@deepseek-ai/dsh-memory-connect'
  config:
    path: ~/.dsh/memory.db
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `path` | *(required)* | Path to SQLite memory database |
| `openAt` | `startup` | When to open: `startup`, `first-query`, `never` |
| `maxRecallCount` | `10` | Max memories to recall per session |
| `decayRate` | `0.02` | Decay constant (higher = faster decay) |
| `minRelevanceThreshold` | `0.3` | Min relevance score for recall |
| `journalMode` | `wal` | SQLite journal mode |
| `schedulerEnabled` | `true` | Enable periodic maintenance |
| `schedulerDecayIntervalMs` | `3600000` | Decay interval (ms), default 1h |
| `schedulerConsolidateIntervalMs` | `21600000` | Consolidation interval (ms), default 6h |
| `similarityThreshold` | `0.5` | Semantic similarity threshold (0-1) |

Full configuration example:

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory-connect'
  config:
    path: ~/.dsh/memory.db
    openAt: startup
    maxRecallCount: 10
    decayRate: 0.02
    journalMode: wal
    schedulerEnabled: true
    schedulerDecayIntervalMs: 3600000
    schedulerConsolidateIntervalMs: 21600000
    similarityThreshold: 0.5
```

## API

### Search Memories

```javascript
const memories = await ctx.crossSessionMemory.searchMemories({
  query: 'TypeScript configuration',
  types: ['fact', 'decision'],
  limit: 5,
})
```

### Recall for Session

```javascript
const memories = await ctx.crossSessionMemory.recallForSession(
  'session-123',
  'Setting up a new React project',
  10
)
```

### Store Memory

```javascript
await ctx.crossSessionMemory.storeMemory({
  type: 'preference',
  content: 'User prefers functional programming style',
  sessionId: 'session-123',
  tags: ['coding-style', 'preference'],
})
```

### Manual Maintenance

```javascript
// Trigger a full maintenance cycle (decay + consolidation)
const result = await ctx.crossSessionMemory.triggerMaintenance()

// Or run individually
await ctx.crossSessionMemory.runDecay()
await ctx.crossSessionMemory.consolidate()
```

### Inspect & Monitor

```javascript
// Scheduler status
const status = ctx.crossSessionMemory.getSchedulerStatus()

// Find similar memories (without merging)
const pairs = await ctx.crossSessionMemory.findSimilarMemories(0.6)

// Consolidation history
const log = await ctx.crossSessionMemory.getConsolidationLog(10)

// Statistics
const stats = await ctx.crossSessionMemory.getStats()
```

## Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `fact` | Objective information | "Project uses TypeScript 5.3" |
| `preference` | User preferences | "Prefers functional components" |
| `context` | Project context | "E-commerce platform migration" |
| `decision` | Decisions made | "Chose PostgreSQL over MySQL" |
| `skill` | Learned patterns | "How to configure ESLint" |

## Decay Formula

```
score = importance × e^(-λ × days) × log(access_count + 1)
```

## Semantic Consolidation

Multi-signal similarity scoring:

| Signal | Weight | Description |
|--------|--------|-------------|
| Tag overlap | 35% | Jaccard similarity of extracted tags |
| Content word overlap | 35% | Jaccard similarity of tokenized words |
| Type match | 10% | Same memory type |
| Temporal proximity | 20% | Decays over 90 days |

When similarity ≥ threshold (default 0.5), memories are automatically merged using LLM.

## Development

```bash
git clone https://github.com/Asher-2000/dsh-memory-connect.git
cd dsh-memory-connect
npm install
npm test
```

## License

MIT

---

# 中文

## 概述

`dsh-memory-connect` 是 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的跨会话记忆共享插件。它自动从对话中提取、存储和检索记忆，让 AI Agent 拥有持久化的智能记忆能力。

**零配置** — 基于 SQLite FTS5 和 DSH 内置 LLM，开箱即用。

## 核心功能

| 功能 | 说明 |
|------|------|
| 🔍 **自动提取** | 从对话中提取事实、偏好、决策和上下文 |
| 🧠 **语义召回** | RRF 融合关键词和语义搜索 |
| ⏰ **定时维护** | 内置调度器自动执行衰减和整合 |
| 🤖 **LLM 整合** | 使用 DSH 内置 LLM 智能合并相似记忆 |
| 📉 **记忆衰减** | 旧的、不常用的记忆自然消退 |
| 🔧 **零配置** | 基于 SQLite FTS5，无需额外依赖 |

## 工作原理

1. **监听** — 订阅 `session/event` 事件，实时捕获对话信息
2. **提取** — 基于规则的模式匹配，识别事实、偏好、决策等
3. **存储** — 写入 SQLite 数据库，建立 FTS5 全文索引
4. **召回** — 新会话创建时，自动检索相关历史记忆并注入
5. **维护** — 定期衰减旧记忆、整合重复记忆

## 快速开始

```bash
npm install @deepseek-ai/dsh-memory-connect
```

添加到 DSH 配置：

```yaml
# agent.cordis.yml
- id: memory
  name: '@deepseek-ai/dsh-memory-connect'
  config:
    path: ~/.dsh/memory.db
```

## API 示例

```javascript
// 搜索记忆
const memories = await ctx.crossSessionMemory.searchMemories({
  query: 'TypeScript 配置',
  types: ['fact'],
})

// 为新会话召回相关记忆
await ctx.crossSessionMemory.recallForSession('session-123', '搭建 React 项目')

// 手动触发维护
await ctx.crossSessionMemory.triggerMaintenance()

// 查看统计
const stats = await ctx.crossSessionMemory.getStats()
```

## 许可证

MIT


## Roadmap

- [ ] Add embedding-based semantic search
- [ ] Support for multi-user memory isolation
- [ ] Web UI for memory management
- [ ] Memory export/import functionality
