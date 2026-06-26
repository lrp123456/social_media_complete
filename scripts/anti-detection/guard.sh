#!/usr/bin/env bash
# scripts/anti-detection/guard.sh
# 抖音反检测静态守卫：对比改造前后裸调用总数，确认 v2 收口使总数下降。
# 注意：双路径共存期 legacy 分支保留裸调用，故守卫目标为"v2 分支不新增裸调用"，
# 通过审计脚本输出 + 人工确认。完整 CI 强制零裸调用需待 legacy 路径删除（全平台收口后）。
set -e
cd "$(dirname "$0")/../.."
echo "=== 抖音范围裸调用审计 ==="
npx tsx scripts/anti-detection/audit-blindspots.ts | tee /tmp/audit-latest.txt
echo ""
echo "守卫说明：双路径共存期，审计输出仅供监控裸调用总数趋势。"
echo "v2 全量切换并删除 legacy 路径后，此脚本改为 exit 非零当总数 >0。"
