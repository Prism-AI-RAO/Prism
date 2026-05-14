#!/bin/bash
# fix_agents_schema.command
# 修复手动导入的 Sub-Agent 数据库字段错误
# 问题：type='custom'（不在枚举中）+ accessible_paths=NULL（Zod 要求数组）
# 修复：type → 'generic'，accessible_paths → '[]'
# 双击运行，运行一次即可

DB_PRISMDEV="$HOME/Library/Application Support/PrismDev/Data/agents.db"
DB_PRISM="$HOME/Library/Application Support/Prism/Data/agents.db"
DB_DEV="$HOME/Library/Application Support/CherryStudioDev/Data/agents.db"
DB_PROD="$HOME/Library/Application Support/CherryStudio/Data/agents.db"

if [ -f "$DB_PRISMDEV" ]; then
    DB="$DB_PRISMDEV"
    echo "📦 使用 Dev 数据库: $DB_PRISMDEV"
elif [ -f "$DB_PRISM" ]; then
    DB="$DB_PRISM"
    echo "📦 使用 Prod 数据库: $DB_PRISM"
elif [ -f "$DB_DEV" ]; then
    DB="$DB_DEV"
    echo "📦 使用 Dev 数据库: $DB_DEV"
elif [ -f "$DB_PROD" ]; then
    DB="$DB_PROD"
    echo "📦 使用 Prod 数据库: $DB_PROD"
else
    echo "❌ 找不到 agents.db"
    echo "[Process completed]"
    exit 1
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

echo ""
echo "====================================================="
echo "  修复 Sub-Agent schema 字段"
echo "  时间：$NOW"
echo "====================================================="

echo ""
echo "修复前状态："
sqlite3 "$DB" "SELECT id, type, accessible_paths FROM agents WHERE id LIKE 'prism-dental-%' OR id LIKE 'prism-scout%' OR id LIKE 'prism-dataguardian%' OR id LIKE 'prism-sysengineer%';"

echo ""
echo "执行修复..."
sqlite3 "$DB" <<ENDSQL
UPDATE agents
SET
  type = 'generic',
  accessible_paths = '[]',
  updated_at = '${NOW}'
WHERE id IN (
  'prism-dental-ceo',
  'prism-scout',
  'prism-dataguardian',
  'prism-sysengineer'
);
ENDSQL

echo ""
echo "修复后状态："
sqlite3 "$DB" "SELECT id, type, accessible_paths, substr(updated_at,1,19) as updated FROM agents WHERE id LIKE 'prism-dental-%' OR id LIKE 'prism-scout%' OR id LIKE 'prism-dataguardian%' OR id LIKE 'prism-sysengineer%';"

echo ""
echo "====================================================="
echo "  ✅ 修复完成！"
echo "  重启 Prism (pnpm dev) 后 Agents 页面应正常显示。"
echo "====================================================="
echo ""
echo "[Process completed]"
