// scripts/anti-detection/audit-blindspots.ts
// 审计抖音范围文件的裸调用盲区，输出每文件计数。
import { readFileSync } from 'fs';
import { join } from 'path';

const PATTERNS = [
  'page.evaluate(', 'frame.evaluate(', 'page.$eval(', 'page.$$eval(',
  'page.evaluateHandle(', 'page.locator(', 'page.$(', 'page.$$(',
  'page.keyboard.', 'createCDPSession', 'page.click', '.fill(',
  'page.mouse', 'page.waitForSelector(', 'page.waitForFunction(',
  'HumanActions.cdpClickByText(', 'HumanActions.queryElementsWithInfo(',
];

// 抖音范围文件（spec 7.5）
const DOUYIN_FILES = [
  'apps/ts-api-gateway/src/crawlers/douyinCrawler.ts',
  'apps/ts-api-gateway/src/platforms/douyin.ts',
  'apps/ts-api-gateway/src/services/loginFlowHelpers.ts',
];

const ROOT = process.cwd();

function countInFile(file: string): Record<string, number> {
  let content: string;
  try {
    content = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return {};
  }
  const result: Record<string, number> = {};
  for (const p of PATTERNS) {
    let count = 0;
    let idx = content.indexOf(p);
    while (idx !== -1) { count++; idx = content.indexOf(p, idx + 1); }
    if (count > 0) result[p] = count;
  }
  return result;
}

let total = 0;
for (const f of DOUYIN_FILES) {
  const counts = countInFile(f);
  const fileTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  total += fileTotal;
  console.log(`\n=== ${f} (total ${fileTotal}) ===`);
  for (const [p, c] of Object.entries(counts)) console.log(`  ${p}: ${c}`);
}
console.log(`\n=== 抖音范围裸调用总计: ${total} ===`);
process.exit(0); // 审计脚本始终退出 0，仅报告
