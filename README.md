# @deepseek-ai/dsh-memory-connect

> 跨会话记忆插件 — 让 AI Agent 拥有持久记忆和全局身份  
> Cross-session memory plugin for DeepSeek Harness (DSH)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-Compatible-brightgreen.svg)](https://github.com/deepseek-ai/dsh)
[![Version](https://img.shields.io/badge/version-0.4.0-orange.svg)](https://github.com/Asher-2000/dsh-memory-connect/releases)

---

**English** | [中文](#中文)

## Overview

`dsh-memory-connect` is a cross-session memory sharing plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh). It automatically extracts, stores, and recalls memories across sessions, giving your AI agent persistent, intelligent memory with **context explosion prevention** and **global Soul identity**.

**Zero-config** — works out of the box with SQLite FTS5 and DSH's built-in LLM.

> ### 🚨 v0.4.0 — The "it actually works now" release
>
> v0.3.0 registered the service but **never instantiated it** (Cordis lazily constructs services — passing the class to `ctx.provide()` means the constructor never runs), and the "recall" feature wrote a computed context to a field **no one ever read**. In practice the plugin did nothing.
>
> v0.4.0 fixes the activation chain and **wires recall into the system prompt**: a `systemPrompt.context` provider injects `## Related Memories from Previous Sessions` on every turn. Verified end-to-end on dsh v0.1.1-rc.2 / Node 24: tell session A "my cat is named Mimi", start a fresh session B and ask — the model answers correctly from memory.
>
> See [CHANGELOG.md](CHANGELOG.md) for the full breakdown.

## Features

| Feature | Description |
|---------|-------------|
| 🧠 **Global Soul** | Persistent identity across all workspaces via ~/.dsh/soul.md |
| 🔍 **Auto Extraction** | Extracts facts, preferences, decisions, and context from conversations |
| 🧠 **Cross-Session Recall** | FTS5 keyword recall injected into the system prompt **every turn** (recency fallback when no query text is available) |
| 🛡️ **Context Explosion Prevention** | Token budget management prevents context window overflow |
| ⏰ **Scheduled Maintenance** | Automatic periodic decay and consolidation via built-in scheduler |
| 🤖 **LLM Consolidation** | Intelligent memory merging using DSH's built-in `ctx.llm` (zero-config) |
| 📉 **Memory Decay** | Old, unused memories naturally fade; frequently accessed ones persist |
| 🎯 **Smart Prioritization** | Memory selection based on relevance × recency × frequency |
| 🗜️ **Memory Compression** | Automatic compression when approaching token limits |

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
- GitHub: your-username
- Role: Developer/Designer/Product Manager

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
    enableSoul: true  # Enable Soul injection (default: true)
```

> **v0.4.0 requirement**: the plugin now injects `systemPrompt` (used for the cross-session recall context provider). Any profile that loads this plugin needs the `systemPrompt` service available (standard in the dsh web/headless profiles).

## Configuration

### Basic Options

| Option | Default | Description |
|--------|---------|-------------|
| `path` | *(required)* | Path to SQLite memory database |
| `openAt` | `startup` | When to open: `startup`, `first-query`, `never` |
| `maxRecallCount` | `10` | Max memories to recall per session |
| `decayRate` | `0.02` | Decay constant (higher = faster decay) |
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
| `smartPrioritization` | `true` | Enable smart memory prioritization |
| `enableCompression` | `true` | Enable memory compression |

### Soul Options

| Option | Default | Description |
|--------|---------|-------------|
| `enableSoul` | `true` | Enable global Soul injection |
| `soulPath` | `~/.dsh/soul.md` | Custom Soul file path |

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
    maxContextTokens: 4000
    smartPrioritization: true
    enableCompression: true
    enableSoul: true
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

### Synchronous Recall (for system-prompt providers)

```javascript
// v0.4.0+ — sync API for prompt-context providers (node:sqlite is synchronous,
// so no async needed). Returns a formatted markdown block or ''.
const block = ctx.crossSessionMemory.recallSync('session-123', 'React project')
```

### Latest User Text (from dsh session logs)

```javascript
// v0.4.0+ — extracts the most recent user message text from a dsh Session
// (handles {event: ...} wrappers, agent/inbox/spliced, and bare events).
const query = ctx.crossSessionMemory.currentUserText(agent.session)
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

## Context Explosion Prevention

### How It Works

1. **Token Counting** — Estimates tokens for English, Chinese, and mixed text
2. **Smart Prioritization** — Ranks memories by: `relevance × 50% + recency × 30% + frequency × 20%`
3. **Budget Management** — Enforces `maxContextTokens` limit (default: 4000)
4. **Memory Compression** — Automatically truncates or summarizes when approaching limits

### Output Example

```markdown
## 🧠 Global Identity (Soul)

[Your Soul content here]

---

## Related Memories from Previous Sessions

- [preference] User prefers TypeScript
- [decision] Chose PostgreSQL over MySQL

> 💾 Memory: 2/10 memories + Soul | 250/4000 tokens
```

## Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `fact` | Objective information | "Project uses TypeScript 5.3" |
| `preference` | User preferences | "Prefers functional components" |
| `context` | Project context | "E-commerce platform migration" |
| `decision` | Decisions made | "Chose PostgreSQL over MySQL" |
| `skill` | Learned patterns | "How to configure ESLint" |

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

`dsh-memory-connect` 是 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的跨会话记忆共享插件。它自动从对话中提取、存储和检索记忆，让 AI Agent 拥有持久化的智能记忆能力，并**防止上下文爆炸**和**全局身份**。

**零配置** — 基于 SQLite FTS5 和 DSH 内置 LLM，开箱即用。

> ### 🚨 v0.4.0 — "这次真的能跑"版本
>
> v0.3.0 只注册了服务但**从未实例化**（Cordis 懒加载机制：把类传给 `ctx.provide()` 导致构造函数永远不执行），且"召回"功能把计算好的上下文写进了一个**无人读取**的字段——实际运行中插件什么都不做。
>
> v0.4.0 修复了启动链路，并**把召回真正接入了系统提示词**：通过 `systemPrompt.context` 提供者，每轮对话都注入 `## Related Memories from Previous Sessions`。已在 dsh v0.1.1-rc.2 / Node 24 上端到端验证：会话 A 说"我的猫叫咪咪"，开新会话 B 问它，模型能正确从记忆中回答。
>
> 详见 [CHANGELOG.md](CHANGELOG.md)。

## 核心功能

| 功能 | 说明 |
|------|------|
| 🧠 **全局身份 (Soul)** | 通过 ~/.dsh/soul.md 跨所有工作区持久化身份 |
| 🔍 **自动提取** | 从对话中提取事实、偏好、决策和上下文 |
| 🧠 **跨会话召回** | FTS5 关键词召回，**每轮**注入系统提示词（无查询文本时按最近记忆兜底） |
| 🛡️ **上下文爆炸防护** | Token 预算管理，防止上下文窗口溢出 |
| ⏰ **定时维护** | 内置调度器自动执行衰减和整合 |
| 🤖 **LLM 整合** | 使用 DSH 内置 LLM 智能合并相似记忆 |
| 📉 **记忆衰减** | 旧的、不常用的记忆自然消退 |
| 🎯 **智能优先级** | 基于相关性 × 时间 × 频率的记忆排序 |
| 🗜️ **记忆压缩** | 接近 token 限制时自动压缩 |

## 🧠 全局身份 (Soul)

Soul 功能提供**跨所有工作区的持久化身份**。

### 工作原理

1. 创建 `~/.dsh/soul.md` 包含你的身份信息
2. 插件自动加载并注入到每个会话
3. 你的偏好、技术栈和编码风格始终可用

### Soul 文件示例

```markdown
# 🧠 Soul — 全局身份

## 👤 身份
- GitHub: your-username
- 角色: 开发者/设计师/产品经理

## 💻 技术栈
- TypeScript, React, Node.js, DSH/Cordis

## 🎨 编码风格
- 函数式编程
- ES Modules
- 零配置优先

## ⚠️ 偏好
- 不用 class 组件
- 不写冗余注释
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
    enableSoul: true
```

> **v0.4.0 依赖**：插件现在注入 `systemPrompt` 服务（用于跨会话召回 context 提供者）。所在 profile 需要提供 `systemPrompt`（dsh web/headless profile 默认都有）。

## 许可证

MIT
