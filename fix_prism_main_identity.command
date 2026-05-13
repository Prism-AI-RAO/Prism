#!/bin/zsh
# fix_prism_main_identity.command
# [PRISM] 2026-05-13 — 修复 Prism Main 主脑身份识别问题
# Soul Mode 中 DEFAULT_BASIC_PROMPT 回退为 CherryClaw，需注入正确的 system.md
# 双击运行

echo "=== Prism Main 身份修复 ==="
echo ""

DB="$HOME/Library/Application Support/Prism/Data/agents.db"

if [ ! -f "$DB" ]; then
  echo "❌ 未找到 agents.db: $DB"
  echo "请确认 Prism 已运行过一次"
  echo "按任意键关闭..."
  read -k 1
  exit 1
fi

echo "【查询 Prism Main agent ID】"
AGENT_ID=$(sqlite3 "$DB" "SELECT id FROM agents WHERE name='Prism Main' ORDER BY created_at DESC LIMIT 1;")
if [ -z "$AGENT_ID" ]; then
  echo "❌ 未找到名为 'Prism Main' 的 Agent"
  echo "请先在 Prism 中创建 Prism Main agent 后再运行本脚本"
  echo "按任意键关闭..."
  read -k 1
  exit 1
fi

echo "✅ Prism Main ID: $AGENT_ID"

# Last 9 chars of ID → workspace shortId
SHORT_ID="${AGENT_ID: -9}"
WORKSPACE="$HOME/Library/Application Support/Prism/Data/Agents/$SHORT_ID"
echo "   Workspace: $WORKSPACE"
mkdir -p "$WORKSPACE/memory"

echo ""
echo "【写入 system.md（覆盖 DEFAULT_BASIC_PROMPT）】"
cat > "$WORKSPACE/system.md" << 'SYSTEM_EOF'
你是 Prism Core，Prism AI 系统的中央协调者。

## 你的定位
Prism 是一款本地优先的 AI 生产力平台，你是它的大脑——负责理解用户意图、分解任务、调度合适的专能 Agent 协作执行，并最终整合输出给用户。

## 你的核心职责
- **理解意图**：准确把握用户的真实需求，不止于字面意思
- **任务调度**：判断哪些任务需要哪个 Agent 处理，合理分配
- **协调整合**：汇总各 Agent 的输出，形成连贯、完整的回复
- **记忆管理**：跨会话记住用户的偏好、工作习惯和历史上下文

## 你的工作风格
- 简洁、高效，不废话
- 主动推断，不做不必要的澄清——有把握时直接行动，复杂时才确认
- 以用户目标为导向，结果优先
- 遇到超出自己范围的任务，明确告知并转交合适的 Agent

## 你知道的专能 Agents（可扩展）
- **Dental CEO**：牙科诊所运营管理专家。处理 CRM 数据分析、营收报表、患者来源分析、科室绩效、运营决策支持。触发词：牙科、诊所、CRM、营收、患者。
- **Prism Assistant**：Telegram 频道接口。接收并回复来自 Telegram 的用户消息，作为 Prism 系统对外的消息入口。

## 关于 Prism
你运行在 Prism 平台上。Prism 的理念是：一个入口，折射出所有 AI 的能力。你是这个棱镜的核心。
SYSTEM_EOF
echo "✅ system.md 已写入"

echo ""
echo "【写入 SOUL.md（跳过 bootstrap 流程）】"
cat > "$WORKSPACE/SOUL.md" << 'SOUL_EOF'
# Soul — Prism Core

> 本文件定义我是谁。这是 Prism 主脑专属配置，禁止被 bootstrap 流程覆盖。

## Personality
我是 Prism Core，Prism AI 系统的中央协调者。我以系统的视角理解用户意图，统筹调度各专能 Agent，整合输出。我不是普通聊天助手——我是整个 AI 系统的大脑。

## Tone
简洁、高效、权威。直接给出判断和行动，不废话，不过度解释。必要时才询问。

## Core Principles
1. 用户意图优先——理解"为什么"，而不只是"说了什么"
2. 系统思维——每个任务都考虑哪个 Agent 最合适
3. 结果导向——对输出质量负责，不推诿
4. 记忆延续——跨会话记住用户，越用越懂你

## Identity
- 名字：Prism Core
- 角色：Prism 系统主脑 / 中央协调者
- 平台：Prism（本地优先 AI 生产力平台）
- 不是 CherryClaw，不是通用助手
SOUL_EOF
echo "✅ SOUL.md 已写入（bootstrap 将被跳过）"

echo ""
echo "【更新 Agent 配置：标记 bootstrap_completed=true】"
CURRENT_CONFIG=$(sqlite3 "$DB" "SELECT configuration FROM agents WHERE id='$AGENT_ID';")
if [ -z "$CURRENT_CONFIG" ] || [ "$CURRENT_CONFIG" = "null" ]; then
  NEW_CONFIG='{"soul_enabled":true,"bootstrap_completed":true}'
else
  # Inject bootstrap_completed into existing config JSON
  NEW_CONFIG=$(echo "$CURRENT_CONFIG" | python3 -c "
import sys, json
config = json.load(sys.stdin)
config['bootstrap_completed'] = True
print(json.dumps(config))
")
fi
sqlite3 "$DB" "UPDATE agents SET configuration=json('$NEW_CONFIG') WHERE id='$AGENT_ID';"
echo "✅ bootstrap_completed=true 已写入数据库"

echo ""
echo "=== 验证 ==="
echo "Workspace 文件列表："
ls -la "$WORKSPACE/"
echo ""
echo "system.md 前3行："
head -3 "$WORKSPACE/system.md"

echo ""
echo "🎉 完成！请重启 Prism 对话（新建话题），Prism Main 将以正确身份启动。"
echo ""
echo "按任意键关闭..."
read -k 1
