# Prism Install — 一键安装包构建系统

> [PRISM] 2026-05-14 — Sprint 14-B

## 概览

`prism-install/` 包含 Prism 跨平台安装包的所有构建脚本和静态资产。

## 快速开始

```bash
# macOS DMG（当前机器架构）
bash prism-install/build-mac.command

# Windows NSIS + Portable（需要 Wine）
bash prism-install/build-win.command

# 完整发布流程（版本管理 + 构建 + Changelog）
bash prism-install/release.command
```

或直接在 Finder 中**双击** `.command` 文件。

## 文件结构

```
prism-install/
├── README.md               ← 本文件
├── build-mac.command       ← macOS DMG + ZIP 一键构建
├── build-win.command       ← Windows NSIS + Portable 构建（需 Wine）
├── release.command         ← 完整发布流程（版本 + 构建 + tag）
└── assets/
    ├── dmg-background.png  ← DMG 窗口品牌背景（660×400）
    └── dmg-background@2x.png  ← Retina 版本（1320×800）
```

## 产物位置

构建产物统一输出到 `dist/`：

| 平台 | 产物 |
|------|------|
| macOS arm64 | `dist/Prism-0.2.0-arm64.dmg` |
| macOS arm64 | `dist/Prism-0.2.0-arm64.zip` |
| Windows x64 | `dist/Prism-0.2.0-x64-setup.exe` |
| Windows x64 | `dist/Prism-0.2.0-x64-portable.exe` |

## 发布流程（标准）

1. **双击** `release.command`
2. 选择版本类型（Patch / Minor / 手动）
3. 确认 → 自动构建 DMG
4. 在 GitHub 创建 Release（命令由脚本打印）:
   ```bash
   gh release create v0.2.0 dist/*.dmg dist/*.zip \
     --title 'Prism v0.2.0' \
     --notes-file CHANGELOG.md
   ```

## Windows 跨平台构建（macOS → Windows）

macOS 上构建 Windows 安装包需要 Wine：

```bash
brew install --cask wine-stable
bash prism-install/build-win.command
```

或在 GitHub Actions CI 中直接构建（推荐正式发布使用）。

## DMG 背景图

`assets/dmg-background.png` 是 660×400 深色品牌图，由 `build-background.py` 生成。
如需重新生成或修改样式：

```bash
python3 prism-install/build-background.py
```
