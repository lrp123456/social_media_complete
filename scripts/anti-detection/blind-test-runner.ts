// scripts/anti-detection/blind-test-runner.ts
// 盲测：A 组旧 CDP 路径 vs B 组原生 Locator 路径，对比风控触发率。
// 手动运行：npx tsx scripts/anti-detection/blind-test-runner.ts <wsEndpoint> <group:A|B>
//
// 判定标准（spec 10.0）：B 组风控触发率不高于 A 组 5% → 通过。
// 风控触发判据：采集后检查 PlatformAccount.status 是否变为 risk_control/login_required，
//              或采集成功率下降。
//
// 注：此脚本依赖 Phase 3 完成后 ANTI_DETECTION_MODE 切换才能完整运行。
//     Phase 0 阶段仅产出脚本骨架与方案。

import { chromium } from 'patchright';

interface BlindTestConfig {
  group: 'A' | 'B';
  videoIds: string[]; // 10 个抖音视频 ID
  runsPerVideo: number; // 50
}

interface TestResult {
  videoId: string;
  run: number;
  success: boolean;
  riskTriggered: boolean;
  error?: string;
}

async function runBlindTest(wsEndpoint: string, cfg: BlindTestConfig): Promise<TestResult[]> {
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const results: TestResult[] = [];

  for (const videoId of cfg.videoIds) {
    for (let i = 0; i < cfg.runsPerVideo; i++) {
      // TODO-blinded: 调用 douyinCrawler 的采集，A 组走 legacy 路径，B 组走 v2 路径
      // 通过 ANTI_DETECTION_MODE 环境变量切换（Phase 3 实现）。
      // 此脚本在 Phase 3 完成后才能完整运行；Phase 0 先记录盲测方案与待办。
      const success = false; // 占位，Phase 3 后回填
      const riskTriggered = false; // 占位
      results.push({ videoId, run: i, success, riskTriggered });

      // 进度报告
      if ((i + 1) % 10 === 0) {
        const soFar = results.filter(r => r.success).length;
        const riskSoFar = results.filter(r => r.riskTriggered).length;
        console.log(`  [${cfg.group}] ${videoId}: ${i + 1}/${cfg.runsPerVideo} (成功=${soFar}, 风控=${riskSoFar})`);
      }
    }
  }

  const total = results.length;
  const successCount = results.filter(r => r.success).length;
  const riskCount = results.filter(r => r.riskTriggered).length;
  const riskRate = total > 0 ? riskCount / total : 0;
  const successRate = total > 0 ? successCount / total : 0;

  console.log(`\n=== 组 ${cfg.group} 结果 ===`);
  console.log(`  总次数: ${total}`);
  console.log(`  采集成功率: ${(successRate * 100).toFixed(2)}%`);
  console.log(`  风控触发率: ${(riskRate * 100).toFixed(2)}%`);

  await browser.close();
  return results;
}

async function main() {
  const wsEndpoint = process.argv[2];
  const group = process.argv[3] as 'A' | 'B';
  if (!wsEndpoint || !group) {
    console.error('用法: npx tsx scripts/anti-detection/blind-test-runner.ts <wsEndpoint> <A|B>');
    console.error('环境变量: BLIND_TEST_VIDEO_IDS=id1,id2,...,id10（10 个逗号分隔的抖音视频 ID）');
    process.exit(1);
  }

  if (group !== 'A' && group !== 'B') {
    console.error('组别必须为 A 或 B');
    process.exit(1);
  }

  // videoIds 由用户填入真实抖音视频 ID
  const videoIds = (process.env.BLIND_TEST_VIDEO_IDS || '').split(',').filter(Boolean);
  if (videoIds.length !== 10) {
    console.error(`需设置 BLIND_TEST_VIDEO_IDS 为 10 个逗号分隔的视频 ID（当前 ${videoIds.length} 个）`);
    process.exit(1);
  }

  console.log(`盲测配置: 组=${group}, 视频数=${videoIds.length}, 每视频次数=50`);
  console.log(`视频 ID: ${videoIds.join(', ')}`);

  await runBlindTest(wsEndpoint, { group, videoIds, runsPerVideo: 50 });
}

main().catch(e => { console.error(e); process.exit(1); });
