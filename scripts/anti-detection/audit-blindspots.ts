// scripts/anti-detection/audit-blindspots.ts
// 审计各平台范围文件的裸调用盲区，按平台分别报告计数。
import { readFileSync } from 'fs';
import { join } from 'path';

const PATTERNS = [
  'page.evaluate(', 'frame.evaluate(', 'page.$eval(', 'page.$$eval(',
  'page.evaluateHandle(', 'page.locator(', 'page.$(', 'page.$$(',
  'page.keyboard.', 'createCDPSession', 'page.click', '.fill(',
  'page.mouse', 'page.waitForSelector(', 'page.waitForFunction(',
  'HumanActions.cdpClickByText(', 'HumanActions.queryElementsWithInfo(',
];

// 各平台范围文件（spec 2.3）
const PLATFORM_SCOPES: Record<string, string[]> = {
  douyin: [
    'apps/ts-api-gateway/src/crawlers/douyinCrawler.ts',
    'apps/ts-api-gateway/src/platforms/douyin.ts',
    'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
  ],
  tencent: [
    'apps/ts-api-gateway/src/crawlers/tencentCrawler.ts',
    'apps/ts-api-gateway/src/platforms/tencent.ts',
    'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
  ],
  kuaishou: [
    'apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts',
    'apps/ts-api-gateway/src/platforms/kuaishou.ts',
    'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
  ],
  xiaohongshu: [
    'apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts',
    'apps/ts-api-gateway/src/platforms/xiaohongshu.ts',
    'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
  ],
};

const ROOT = process.cwd();
const WORLD_MAIN_LIMIT = 3;

function countInFile(file: string): Record<string, number> {
  let content: string;
  try { content = readFileSync(join(ROOT, file), 'utf8'); } catch { return {}; }
  const result: Record<string, number> = {};
  for (const p of PATTERNS) {
    let count = 0, idx = content.indexOf(p);
    while (idx !== -1) { count++; idx = content.indexOf(p, idx + 1); }
    if (count > 0) result[p] = count;
  }
  return result;
}

// CLI: 可指定单平台或全部。node audit-blindspots.ts [tencent|kuaishou|...]
const target = process.argv[2];
const platforms = target ? [target] : Object.keys(PLATFORM_SCOPES);

let grandTotal = 0;
let worldMainViolations = 0;

for (const platform of platforms) {
  const files = PLATFORM_SCOPES[platform];
  if (!files) {
    console.log(`Unknown platform: ${target}`);
    console.log(`Available: ${Object.keys(PLATFORM_SCOPES).join(', ')}`);
    process.exit(1);
  }
  let platformTotal = 0;
  console.log(`\n########## 平台: ${platform} ##########`);
  for (const f of files) {
    const counts = countInFile(f);
    const fileTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    platformTotal += fileTotal;
    if (fileTotal > 0) {
      console.log(`\n=== ${f} (total ${fileTotal}) ===`);
      for (const [p, c] of Object.entries(counts)) console.log(`  ${p}: ${c}`);
    }
    // world:'main' 计数
    let content: string;
    try { content = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    const matches = (content.match(/world\s*:\s*["']main["']/g) || []).length;
    if (matches > WORLD_MAIN_LIMIT) {
      worldMainViolations++;
      console.log(`  ⚠️  ${f}: world:'main' ${matches} > ${WORLD_MAIN_LIMIT} VIOLATION`);
    } else if (matches > 0) {
      console.log(`  ${f}: world:'main' ${matches} ✓`);
    }
  }
  console.log(`\n=== ${platform} 裸调用总计: ${platformTotal} ===`);
  grandTotal += platformTotal;
}
console.log(`\n========== 全部平台裸调用总计: ${grandTotal} ==========`);
if (worldMainViolations > 0) console.log(`⚠️  ${worldMainViolations} 个文件超过 world:'main' 限制`);
process.exit(0); // 审计脚本始终退出 0，仅报告
