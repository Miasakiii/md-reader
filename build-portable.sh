#!/bin/bash
# 构建便携版脚本
# 用法: ./build-portable.sh [平台]

set -e

echo "📦 构建 MD Reader..."

# 检查依赖
command -v node >/dev/null 2>&1 || { echo "❌ 需要安装 Node.js"; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "❌ 需要安装 Rust (https://rustup.rs)"; exit 1; }

# 安装前端依赖
echo "📥 安装前端依赖..."
npm install

# 构建
echo "🔨 构建应用..."
npm run tauri build

echo ""
echo "✅ 构建完成！"
echo ""
echo "📁 构建产物位置:"
echo "   Windows: src-tauri/target/release/bundle/nsis/ (安装版)"
echo "            src-tauri/target/release/md-reader.exe (可直接运行)"
echo "   macOS:   src-tauri/target/release/bundle/dmg/"
echo "   Linux:   src-tauri/target/release/bundle/appimage/"
echo ""
