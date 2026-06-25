// scripts/anti-detection/isolated-world-poc.ts
// POC: 验证 CDP 隔离世界执行对主世界不可见。
// 用法1（wsEndpoint）: npx tsx scripts/anti-detection/isolated-world-poc.ts ws <wsEndpoint>
// 用法2（windowId + vendor）: npx tsx scripts/anti-detection/isolated-world-poc.ts auto <windowId> [vendor:roxybrowser|bitbrowser]

import { chromium } from 'patchright';

// --- 隔离世界 POC 核心逻辑 ---
async function runIsolatedWorldPOC(wsEndpoint: string): Promise<boolean> {
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  await page.goto('about:blank');

  const cdp = await page.context().newCDPSession(page);

  // 1. 主世界写一个标记
  await cdp.send('Runtime.evaluate', { expression: 'window.__poc_marker = "main-visible"' });

  // 2. 创建隔离世界
  const iso = await cdp.send('Page.createIsolatedWorld', {
    frameId: (await cdp.send('Page.getFrameTree')).frameTree.frame.id,
    worldName: 'poc_isolated',
  });
  const contextId = iso.executionContextId;

  // 3. 隔离世界读主世界标记 —— 应为 undefined（不可见）
  const r1 = await cdp.send('Runtime.evaluate', {
    expression: 'typeof window.__poc_marker',
    contextId,
    returnByValue: true,
  });
  console.log('隔离世界读主世界标记:', r1.result.value); // 期望 undefined

  // 4. 隔离世界写自己的标记，主世界读 —— 应为 undefined
  await cdp.send('Runtime.evaluate', {
    expression: 'window.__iso_marker = "iso-only"',
    contextId,
    returnByValue: true,
  });
  const r2 = await cdp.send('Runtime.evaluate', {
    expression: 'typeof window.__iso_marker',
    returnByValue: true,
  });
  console.log('主世界读隔离世界标记:', r2.result.value); // 期望 undefined

  // 5. 性能：首次创建 vs 缓存命中
  const t0 = Date.now();
  await cdp.send('Runtime.evaluate', { expression: '1+1', contextId, returnByValue: true });
  const t1 = Date.now();
  await cdp.send('Runtime.evaluate', { expression: '1+1', contextId, returnByValue: true });
  const t2 = Date.now();
  console.log(`首次执行 ${t1 - t0}ms，缓存命中 ${t2 - t1}ms`);

  const pass = r1.result.value === 'undefined' && r2.result.value === 'undefined';
  console.log(pass ? 'POC PASS' : 'POC FAIL');
  await browser.close();
  return pass;
}

// --- 通过项目内置 BrowserManager opener 自动获取 wsEndpoint ---
async function getWsFromOpener(windowId: string, vendor: string): Promise<string> {
  // 动态加载 BrowserManager 避免在非 workspace 环境因 import 路径崩溃
  const { BrowserManager } = await import('../../packages/browser-core/src/browserManager');
  const manager = new BrowserManager(50000, '');
  // 调用内部方法获取 ws
  const opener = (manager as any).getOpener(vendor);
  // 先检查是否已连接
  const existing = await opener.getConnectionInfo(windowId);
  if (existing) return existing;
  // 否则打开
  return opener.openWindow(windowId);
}

async function main() {
  const mode = process.argv[2];
  if (!mode) {
    console.error('用法:');
    console.error('  npx tsx scripts/anti-detection/isolated-world-poc.ts ws <wsEndpoint>');
    console.error('  npx tsx scripts/anti-detection/isolated-world-poc.ts auto <windowId> [vendor]');
    process.exit(1);
  }

  let wsEndpoint: string;

  if (mode === 'ws') {
    wsEndpoint = process.argv[3];
    if (!wsEndpoint) { console.error('缺少 wsEndpoint'); process.exit(1); }
  } else if (mode === 'auto') {
    const windowId = process.argv[3];
    const vendor = process.argv[4] || 'roxybrowser';
    if (!windowId) { console.error('缺少 windowId'); process.exit(1); }
    console.log(`通过 ${vendor} opener 获取 ${windowId} 的 wsEndpoint...`);
    wsEndpoint = await getWsFromOpener(windowId, vendor);
    console.log(`wsEndpoint: ${wsEndpoint}`);
  } else {
    console.error('未知模式，请使用 ws 或 auto');
    process.exit(1);
  }

  const pass = await runIsolatedWorldPOC(wsEndpoint);
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
