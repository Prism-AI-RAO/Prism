# Prism Control — 系统总控操作手册

> 本技能定义 Prism Main 的总控权限、API 操作规范和 Agent 创建完整流程。
> 触发条件：需要创建/管理 Agent、调用 Prism API、诊断系统状态时。

---

## 一、Prism API Server 基础

**地址**：`http://localhost:23333`（需在 Prism 设置 → API Server 先开启）

**认证**：所有请求需携带 API Key
```bash
# 从 RAO 获取当前 Key，或从设置页面查看
PRISM_KEY="your-api-key-here"
BASE="http://localhost:23333"
```

**连通性检查**：
```bash
curl -s $BASE/health
curl -s $BASE/ | head -5
```

---

## 二、Agent 完整操作

### 2.1 创建新 Agent

```bash
curl -s -X POST $BASE/v1/agents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PRISM_KEY" \
  -d '{
    "name": "Agent 名称",
    "description": "这个 Agent 的一句话介绍",
    "instructions": "完整的 System Prompt 内容...",
    "agentType": "claude-code",
    "model": "claude-sonnet-4-5-20251001",
    "modelId": "claude-sonnet-4-5-20251001",
    "providerId": "anthropic",
    "maxTurns": 100
  }' | python3 -m json.tool
```

**agentType 选择**：
- `claude-code`：支持工具调用（Read/Write/Bash），适合开发、运维、自动化任务
- `generic`：纯对话模式，适合咨询、分析、写作

**常用 providerId**：
- `anthropic` — Claude 系列（推荐）
- `deepseek` — DeepSeek 系列（国产，性价比高）
- `openai` — GPT 系列

### 2.2 查询所有 Agent

```bash
curl -s $BASE/v1/agents \
  -H "Authorization: Bearer $PRISM_KEY" | python3 -m json.tool
```

### 2.3 查询单个 Agent

```bash
curl -s $BASE/v1/agents/{agentId} \
  -H "Authorization: Bearer $PRISM_KEY" | python3 -m json.tool
```

### 2.4 更新 Agent

```bash
curl -s -X PATCH $BASE/v1/agents/{agentId} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PRISM_KEY" \
  -d '{"instructions": "更新后的 System Prompt..."}' | python3 -m json.tool
```

### 2.5 删除 Agent

```bash
curl -s -X DELETE $BASE/v1/agents/{agentId} \
  -H "Authorization: Bearer $PRISM_KEY"
```

---

## 三、Session 管理

### 3.1 为 Agent 创建 Session

```bash
curl -s -X POST $BASE/v1/agents/{agentId}/sessions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PRISM_KEY" \
  -d '{"name": "Session 名称（可选）"}' | python3 -m json.tool
```

### 3.2 列出 Agent 的所有 Session

```bash
curl -s $BASE/v1/agents/{agentId}/sessions \
  -H "Authorization: Bearer $PRISM_KEY" | python3 -m json.tool
```

### 3.3 向 Session 发送消息

```bash
curl -s -X POST $BASE/v1/agents/{agentId}/sessions/{sessionId}/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PRISM_KEY" \
  -d '{"content": "你好，请介绍一下你自己"}' | python3 -m json.tool
```

---

## 四、模型与 Provider

### 4.1 查询所有可用模型

```bash
curl -s $BASE/v1/models \
  -H "Authorization: Bearer $PRISM_KEY" | python3 -m json.tool
```

### 4.2 通过特定 Provider 发请求

```bash
# 路由到 anthropic provider
curl -s -X POST $BASE/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PRISM_KEY" \
  -d '{
    "model": "claude-sonnet-4-5-20251001",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## 五、系统状态诊断

```bash
# 1. API Server 是否运行
curl -s http://localhost:23333/health

# 2. Hermes Agent 是否运行
curl -s http://localhost:8642/v1/models | python3 -m json.tool

# 3. OpenClaw 状态（退役中）
curl -s http://localhost:18789/ | head -5

# 4. 主进程最新日志（最后 100 行）
tail -n 100 ~/Library/Logs/PrismDev/main.log

# 5. Agent 数据库
ls -lh ~/Library/Application\ Support/PrismDev/Data/agents.db

# 6. 所有 Agent workspace
ls ~/Library/Application\ Support/PrismDev/Agents/

# 7. Prism Main 的 workspace
ls ~/Library/Application\ Support/PrismDev/Agents/n-default/.claude/skills/

# 8. 全局技能
ls ~/Library/Application\ Support/PrismDev/Data/Skills/
```

---

## 六、创建新 Agent 的完整决策流程

```
RAO 提出新 Agent 需求
        ↓
1. 明确定位（5 个 W）
   - Who：目标用户是谁
   - What：核心职责是什么
   - Why：为什么需要这个 Agent
   - When：什么场景下触发
   - How：如何衡量成功

2. 设计 System Prompt
   结构参考 Prism Main 的八段式：
   - 定位与权限
   - 能力清单（工具/技能/API）
   - 核心职责（具体操作流程）
   - 系统知识（需要了解的架构）
   - 用户偏好
   - 记忆管理
   - 行为准则

3. 选择模型
   - 需要工具调用/写代码 → claude-code + Anthropic/DeepSeek
   - 纯对话/分析 → generic + 性价比模型

4. 执行创建（见第二章 API）

5. 配置技能
   - 在 Prism 设置 → Agents → 选中新 Agent → 技能 tab
   - 或通过 bash 在 workspace 中手动添加 skill 目录

6. 验证
   - 创建 Session，发送 "介绍一下你自己"
   - 确认 System Prompt 生效，工具可用
```

---

## 七、Skills 管理

```bash
# 查看 Prism Main 当前安装的技能
ls ~/Library/Application\ Support/PrismDev/Agents/n-default/.claude/skills/

# 全局技能（所有 Agent 共享）
ls ~/Library/Application\ Support/PrismDev/Data/Skills/

# 技能模板源码
ls /Users/raoshimin/Prism/resources/skills/
ls /Users/raoshimin/Prism/resources/builtin-agents/prism-main/.claude/skills/
```

---

## 八、注意事项

- **API Key 不写死**：每次对话中从 RAO 获取，或请 RAO 在 Prism 设置页面提供
- **创建 Agent 前先确认**：不要随意创建不必要的 Agent，保持系统整洁
- **删除前备份**：删除 Agent 会级联删除所有 Session 和消息历史
- **System Prompt 质量**：新 Agent 的能力上限由 System Prompt 决定，写好它
- **[PRISM] 注释**：所有源码改动必须标记 `// [PRISM] YYYY-MM-DD — 原因`
