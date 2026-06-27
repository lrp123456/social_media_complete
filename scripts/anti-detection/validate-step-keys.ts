// scripts/anti-detection/validate-step-keys.ts
// 验证 enterStep 调用的 step key 符合 <flow>.<platform>.<phase>.<step> 规范（spec 3.4）。
// flow/platform 小写，phase PascalCase (PhaseN)，step camelCase 动词开头。
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const PLATFORM_FILES: Record<string, string[]> = {
  douyin: ['apps/ts-api-gateway/src/crawlers/douyinCrawler.ts'],
  tencent: ['apps/ts-api-gateway/src/crawlers/tencentCrawler.ts'],
  kuaishou: ['apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts'],
  xiaohongshu: ['apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts'],
};

// 匹配 enterStep('monitor', 'tencent', 'Phase1', 'navigateToSidebar')
// 兼容 MaintenanceProbe.enterStep(...) 等前缀
const ENTER_STEP_RE = /\benterStep\(\s*['"]([a-z]+)['"]\s*,\s*['"]([a-z]+)['"]\s*,\s*['"](Phase\d+)['"]\s*,\s*['"]([a-zA-Z]+)['"]\s*\)/g;

const VALID_PLATFORMS = new Set(['douyin', 'tencent', 'kuaishou', 'xiaohongshu']);
const STEP_VERB_PREFIX = /^(navigate|fetch|process|submit|click|fill|scroll|wait|verify|open|select|parse)/;

let violations = 0;
const seenPerPhase = new Map<string, Set<string>>();

for (const [platform, files] of Object.entries(PLATFORM_FILES)) {
  for (const f of files) {
    let content: string;
    try { content = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    let m: RegExpExecArray | null;
    ENTER_STEP_RE.lastIndex = 0;
    while ((m = ENTER_STEP_RE.exec(content)) !== null) {
      const [_, flow, plat, phase, step] = m;
      if (!VALID_PLATFORMS.has(plat)) {
        console.log(`✗ ${f}: 未知平台 '${plat}'`);
        violations++;
      }
      if (!/^Phase\d+$/.test(phase)) {
        console.log(`✗ ${f}: phase '${phase}' 不符合 PhaseN`);
        violations++;
      }
      if (!/^[a-z][a-zA-Z]*$/.test(step)) {
        console.log(`✗ ${f}: step '${step}' 非 camelCase`);
        violations++;
      }
      if (!STEP_VERB_PREFIX.test(step)) {
        console.log(`✗ ${f}: step '${step}' 非动词开头`);
        violations++;
      }
      // 同 phase 下 step 唯一
      const key = `${plat}:${phase}`;
      if (!seenPerPhase.has(key)) seenPerPhase.set(key, new Set());
      if (seenPerPhase.get(key)!.has(step)) {
        console.log(`✗ ${f}: step '${step}' 在 ${key} 下重复`);
        violations++;
      }
      seenPerPhase.get(key)!.add(step);
    }
  }
}
if (violations === 0) console.log('✓ step key 命名规范全部通过');
else console.log(`⚠️  ${violations} 处 step key 规范违规`);
process.exit(violations === 0 ? 0 : 1);
