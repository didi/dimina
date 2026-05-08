#!/bin/bash

# 同步 podspec 版本到 Xcode 项目
# 使用方法：在 Xcode Build Phases 中添加此脚本

PODSPEC_PATH="${SRCROOT}/../Dimina.podspec"
PROJECT_PATH="${SRCROOT}/dimina.xcodeproj/project.pbxproj"

if [ ! -f "$PODSPEC_PATH" ]; then
    echo "错误: 找不到 Dimina.podspec 文件"
    exit 0
fi

# 从 podspec 提取版本号
VERSION=$(grep "s.version" "$PODSPEC_PATH" | sed -E "s/.*'([0-9.]+)'.*/\1/")

if [ -z "$VERSION" ]; then
    echo "警告: 无法从 podspec 提取版本号"
    exit 0
fi

echo "从 Dimina.podspec 读取版本: $VERSION"

# 更新 project.pbxproj 中的 MARKETING_VERSION
if [ -f "$PROJECT_PATH" ]; then
    sed -i '' "s/MARKETING_VERSION = [^;]*/MARKETING_VERSION = $VERSION/" "$PROJECT_PATH"
    echo "已更新 MARKETING_VERSION 为: $VERSION"
else
    echo "警告: 找不到 project.pbxproj 文件"
fi
