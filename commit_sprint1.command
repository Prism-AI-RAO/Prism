#!/bin/bash
# [PRISM] Sprint 1 — OpenClaw 零配置集成 commit 脚本
# Double-click in Finder to run

cd /Users/raoshimin/Prism

echo "🔮 Prism — committing Sprint 1: OpenClaw 零配置集成..."

rm -f .git/index.lock
git config user.email "matrix.sunmoon@gmail.com"
git config user.name "RAO"

git add -A

git commit -m "feat: [PRISM] Sprint 1 — OpenClaw 零配置本地 AI 自动检测

新增文件：
- src/main/services/PrismAutoSetupService.ts
  并发探测本地端口 18789/18790/11434 的 OpenAI 兼容 API
  调用 /v1/models 获取模型列表，超时 2s 不阻塞启动

- src/renderer/src/components/PrismAutoSetup.tsx
  挂载 1.5s 后调用检测，自动 dispatch addProvider 到 Redux
  幂等：provider 已存在则跳过；新增时显示 toast 提示

修改文件：
- packages/shared/IpcChannel.ts: 添加 Prism_DetectLocalAI
- src/main/ipc.ts: 注册 IPC handler + import PrismAutoSetupService
- src/preload/index.ts: 暴露 window.api.prism.detectLocalAI()
- src/renderer/src/App.tsx: 挂载 <PrismAutoSetup />
- i18n/locales/zh-cn.json + en-us.json: 添加 prism.autoDetect.success

效果：Prism 启动 1.5s 后自动检测到 OpenClaw(18789)，
无需手动配置 Provider，直接可用所有本地模型。

Signed-off-by: RAO <matrix.sunmoon@gmail.com>"

echo ""
echo "✅ Committed! Pushing to GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Sprint 1 零配置集成已推送到 GitHub！"
else
    echo "❌ Push 失败，请检查网络或 SSH 配置"
fi

echo ""
read -p "按 Enter 关闭..."
