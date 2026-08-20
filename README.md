# @deepseek-ai/dsh-memory-connect

> 跨会话记忆插件 — 让 AI Agent 拥有持久记忆  
> Cross-session memory plugin for DeepSeek Harness (DSH)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-Compatible-brightgreen.svg)](https://github.com/deepseek-ai/dsh)
[![Version](https://img.shields.io/badge/version-0.2.0-orange.svg)](https://github.com/Asher-2000/dsh-memory-connect/releases)

---

**English** | [中文](#中文)

## Overview

`dsh-memory-connect` is a cross-session memory sharing plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh). It automatically extracts, stores, and recalls memories across sessions, giving your AI agent persistent, intelligent memory with **context explosion prevention**.

**Zero-config** — works out of the box with SQLite FTS5 and DSH's built-in LLM.

## Features

| Feature | Description |
|---------|-------------|
| 🔍 **Auto Extraction** | Extracts facts, preferences, decisions, and context from conversations |
| 🧠 **Semantic Recall** | RRF (Reciprocal Rank Fusion) combines keyword and semantic search |
| 🛡️ **Context Explosion Prevention** | Token budget management prevents context window overflow |
| ⏰ **Scheduled Maintenance** | Automatic periodic decay and consolidation via built-in scheduler |
| 🤖 **LLM Consolidation** | Intelligent memory merging using DSH's built-in `ctx.llm` (zero-config) |
| 📉 **Memory Decay** | Old, unused memories naturally fade; frequently accessed ones persist |
| 🎯 **Smart Prioritization** | Memory selection based on relevance × recency × frequency |
| 🧠 **Global Soul** | Persistent identity across all workspaces via ~/.dsh/soul.md |
| 🗜️ **Memory Compression** | Automatic compression when approaching token limits |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Memory Plugin Data Flow                                │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────┐    session/event    ┌──────────────────┐                   │
│  │ Session  │ ──────────────────→ │ MemoryExtractor  │                   │
│  │ Engine   │                     │ (Rule-based)     │                   │
│  └──────────┘                     └────────┬─────────┘                   │
│                                            │                             │
│                                            ▼                             │
│                                   ┌──────────────────┐                   │
│                                   │  SQLite FTS5     │                   │
│                                   │  memories        │                   │
│                                   │  + memory_fts    │                   │
│                                   └────────┬─────────┘                   │
│                                            │                             │
│  ┌──────────┐   session/created   ┌────────▼─────────┐                   │
│  │ New      │ ←────────────────── │ ContextInjector  │                   │
│  │ Session  │                     │ (Token Budget)   │                   │
│  └──────────┘                     └──────────────────┘                   │
│                                                                           │
│  ┌──────────────────────┐  ┌─────────────────────┐                      │
│  │   MemoryScheduler    │  │ SemanticConsolidator │                      │
│  │  (setInterval)       │→ │ (Tag+Word+Temporal)  │                      │
│  │  • Decay (1h)        │  │ + ctx.llm merge     │                      │
│  │  • Consolidate (6h)  │  └─────────────────────┘                      │
│  └──────────────────────┘                                                │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                    Context Explosion Prevention                     │  │
│  │  • TokenCounter: Estimate tokens (EN/CN/Mixed)                     │  │
│  │  • Smart Prioritization: Relevance × Recency × Frequency           │  │
│  │  • Budget Management: maxContextTokens limit                        │  │
│  │  • Memory Compression: Auto-truncate when approaching limits       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
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

### Basic Options

| Option | Default | Description |
|--------|---------|-------------|
| `path` | *(required)* | Path to SQLite memory database |
| `openAt` | `startup` | When to open: `startup`, `first-query`, `never` |
| `maxRecallCount` | `10` | Max memories to recall per session |
| `decayRate` | `0.02` | Decay constant (higher = faster decay) |
| `minRelevanceThreshold` | `0.3` | Min relevance score for recall |
| `journalMode` | `wal` | SQLite journal mode |

### Scheduler Options

| Option | Default | Description |
|--------|---------|-------------|
| `schedulerEnabled` | `true` | Enable periodic maintenance |
| `schedulerDecayIntervalMs` | `3600000` | Decay interval (ms), default 1h |
| `schedulerConsolidateIntervalMs` | `21600000` | Consolidation interval (ms), default 6h |

### Context Explosion Prevention Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxContextTokens` | `4000` | Max tokens for memory context injection |
| `reservedTokens` | `8000` | Tokens reserved for other context |
| `smartPrioritization` | `true` | Enable smart memory prioritization |
| `enableCompression` | `true` | Enable memory compression |

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
    maxContextTokens: 4000
    reservedTokens: 8000
    smartPrioritization: true
    enableCompression: true
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

## Context Explosion Prevention

### How It Works

1. **Token Counting** — Estimates tokens for English (1 token ≈ 4 chars), Chinese (1 token ≈ 2 chars), and mixed text
2. **Smart Prioritization** — Ranks memories by: `relevance × 50% + recency × 30% + frequency × 20%`
3. **Budget Management** — Enforces `maxContextTokens` limit (default: 4000)
4. **Memory Compression** — Automatically truncates or summarizes when approaching limits

### Output Example

```markdown
## Related Memories from Previous Sessions

- [preference] User prefers TypeScript
- [decision] Chose PostgreSQL over MySQL
- [fact] Project uses React 18

> 💾 Memory: 3/10 memories | 150/4000 tokens
```

### Token Budget Flow

```
Recall memories (up to maxRecallCount)
    ↓
Smart prioritization (relevance × recency × frequency)
    ↓
Token budget check
    ├── Under limit → Add directly
    └── Over limit → Compress then add
    ↓
Generate context with budget info
    ↓
Inject into session
```


## 🧠 Global Soul (Identity)

The Soul feature provides a **persistent identity** that follows you across all workspaces.

### How it works

1. Create `~/.dsh/soul.md` with your identity information
2. The plugin automatically loads and injects it into every session
3. Your preferences, tech stack, and coding style are always available

### Example Soul file

```markdown
# 🧠 Soul — Global Identity

## 👤 Identity
- GitHub: Asher-2000
- Role: DSH Plugin Developer

## 💻 Tech Stack
- TypeScript, React, Node.js, DSH/Cordis

## 🎨 Coding Style
- Functional programming
- ES Modules
- Zero-config preferred

## ⚠️ Preferences
- No class components
- No redundant comments
```

### Configuration

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory-connect'
  config:
    path: ~/.dsh/memory.db
    enableSoul: true  # Enable Soul injection (default: true)
```

---

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

`dsh-memory-connect` 是 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的跨会话记忆共享插件。它自动从对话中提取、存储和检索记忆，让 AI Agent 拥有持久化的智能记忆能力，并**防止上下文爆炸**。

**零配置** — 基于 SQLite FTS5 和 DSH 内置 LLM，开箱即用。

## 核心功能

| 功能 | 说明 |
|------|------|
| 🔍 **自动提取** | 从对话中提取事实、偏好、决策和上下文 |
| 🧠 **语义召回** | RRF 融合关键词和语义搜索 |
| 🛡️ **上下文爆炸防护** | Token 预算管理，防止上下文窗口溢出 |
| ⏰ **定时维护** | 内置调度器自动执行衰减和整合 |
| 🤖 **LLM 整合** | 使用 DSH 内置 LLM 智能合并相似记忆 |
| 📉 **记忆衰减** | 旧的、不常用的记忆自然消退 |
| 🎯 **智能优先级** | 基于相关性 × 时间 × 频率的记忆排序 |
| 🗜️ **记忆压缩** | 接近 token 限制时自动压缩 |

## 上下文爆炸防护

### 工作原理

1. **Token 计数** — 估算中英文混合文本的 token 数
2. **智能优先级** — 按 `相关性 × 50% + 时间衰减 × 30% + 访问频率 × 20%` 排序
3. **预算管理** — 强制执行 `maxContextTokens` 限制（默认 4000）
4. **记忆压缩** — 接近限制时自动截断或摘要

### 输出示例

```markdown
## 来自之前会话的相关记忆

- [偏好] 用户偏好 TypeScript
- [决策] 选择 PostgreSQL 而非 MySQL
- [事实] 项目使用 React 18

> 💾 记忆: 3/10 条 | 150/4000 tokens
```

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

## 配置示例

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory-connect'
  config:
    path: ~/.dsh/memory.db
    maxRecallCount: 10
    maxContextTokens: 4000
    smartPrioritization: true
    enableCompression: true
    schedulerEnabled: true
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

