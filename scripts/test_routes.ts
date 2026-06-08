/**
 * 路由烟雾测试 — Task 1
 * 启动一个 Express 实例，挂载 configAutomationRouter，调用新增的 PUT/DELETE 路由
 * 然后清理：删除测试创建的选择器，restore 原始 selectors.json
 *
 * NOTE: selectorStore 用 process.cwd() 定位 data/selectors.json。
 *       ES 模块的 import 会被 hoist，所以必须用 dynamic import() 让 chdir 先生效。
 */
import path from 'path';
import fs from 'fs';
import express from 'express';

const REAL_CWD = process.cwd();
const TS_API_DIR = path.resolve(__dirname, '../apps/ts-api-gateway');
process.chdir(TS_API_DIR);
const SELECTORS_FILE = path.resolve(TS_API_DIR, 'data/selectors.json');

// 注入 dummy OSS 凭据，避免 shared-config 在 import 时 fail 并 process.exit
process.env.OSS_ACCESS_KEY_ID = 'TEST_DUMMY';
process.env.OSS_ACCESS_KEY_SECRET = 'TEST_DUMMY';
process.env.NODE_ENV = 'test';

// 备份
const original = fs.readFileSync(SELECTORS_FILE, 'utf-8');
const backupPath = SELECTORS_FILE + '.bak.test';
fs.writeFileSync(backupPath, original);

// chdir 之后再 dynamic import（CJS 不支持 top-level await，用 IIFE 包一层）
(async () => {
const { default: configAutomationRouter } = await import(
  '../apps/ts-api-gateway/src/routes/config-automation'
);

const app = express();
app.use(express.json());
app.use('/api/v1/config-automation', configAutomationRouter);

const server = app.listen(0, async () => {
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}/api/v1/config-automation`;
  let passed = 0;
  let failed = 0;
  const log = (ok: boolean, name: string, detail: string) => {
    if (ok) { passed++; console.log('  ✓', name, detail); }
    else { failed++; console.log('  ✗', name, detail); }
  };
  try {
    // 测试 1: GET /selectors 基础查询
    {
      const r = await fetch(base + '/selectors');
      const j = await r.json() as any;
      log(r.status === 200 && j.data, 'GET /selectors', `→ ${r.status} platforms=${Object.keys(j.data).join(',')}`);
    }

    // 测试 2: PUT 新条目
    {
      const newEntry = {
        primary: 'getByRole("button", { name: "测试按钮" })',
        fallbacks: ['button.test-class-xxx'],
        selectorType: 'role',
        purposes: ['publish', 'monitor'],
        description: 'runtime smoke test',
      };
      const r = await fetch(base + '/selectors/douyin/buttons:btn_test_smoke', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selector_value: JSON.stringify(newEntry) }),
      });
      const j = await r.json() as any;
      log(r.status === 200 && j.success, 'PUT new entry', `→ ${r.status} ${j.message ?? j.error}`);
    }

    // 测试 3: 验证写入 — 读文件
    {
      const written = JSON.parse(fs.readFileSync(SELECTORS_FILE, 'utf-8'));
      const btn = written.platforms.douyin.buttons.btn_test_smoke;
      log(!!btn && btn.selectorType === 'role' && btn.purposes.includes('publish'),
        'PUT persisted to file', btn ? `type=${btn.selectorType} pur=${btn.purposes.join('+')}` : 'missing');
    }

    // 测试 4: PUT 覆盖 (再次 PUT 同名)
    {
      const r = await fetch(base + '/selectors/douyin/buttons:btn_test_smoke', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selector_value: JSON.stringify({ primary: 'new', fallbacks: [], purposes: ['monitor'] }) }),
      });
      const j = await r.json() as any;
      const written = JSON.parse(fs.readFileSync(SELECTORS_FILE, 'utf-8'));
      const btn = written.platforms.douyin.buttons.btn_test_smoke;
      log(r.status === 200 && btn.primary === 'new' && btn.purposes.length === 1 && btn.purposes[0] === 'monitor',
        'PUT overwrites (purposes normalized)', `primary=${btn.primary} pur=${btn.purposes.join('+')}`);
    }

    // 测试 5: 错误 categoryKey
    {
      const r = await fetch(base + '/selectors/douyin/no_colon', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selector_value: '{}' }),
      });
      const j = await r.json() as any;
      log(r.status === 400 && j.error?.includes('categoryKey'), 'PUT bad categoryKey', `→ ${r.status} ${j.error?.slice(0, 50)}`);
    }

    // 测试 6: 错误 category
    {
      const r = await fetch(base + '/selectors/douyin/foobar:btn_x', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selector_value: '{}' }),
      });
      const j = await r.json() as any;
      log(r.status === 400, 'PUT bad category', `→ ${r.status} ${j.error?.slice(0, 50)}`);
    }

    // 测试 7: 错误 JSON
    {
      const r = await fetch(base + '/selectors/douyin/buttons:btn_x', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selector_value: 'not json' }),
      });
      const j = await r.json() as any;
      log(r.status === 400 && j.error?.includes('JSON'), 'PUT bad JSON', `→ ${r.status} ${j.error?.slice(0, 50)}`);
    }

    // 测试 8: 缺 primary
    {
      const r = await fetch(base + '/selectors/douyin/buttons:btn_x', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selector_value: JSON.stringify({ fallbacks: [] }) }),
      });
      const j = await r.json() as any;
      log(r.status === 400 && j.error?.includes('primary'), 'PUT missing primary', `→ ${r.status} ${j.error?.slice(0, 50)}`);
    }

    // 测试 9: selectorType 自动推断
    {
      const r = await fetch(base + '/selectors/douyin/buttons:btn_infer', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selector_value: JSON.stringify({ primary: 'getByText("提交")', fallbacks: [] }) }),
      });
      const written = JSON.parse(fs.readFileSync(SELECTORS_FILE, 'utf-8'));
      const btn = written.platforms.douyin.buttons.btn_infer;
      log(btn && btn.selectorType === 'text', 'PUT infers selectorType', `→ ${btn?.selectorType} (from getByText)`);
    }

    // 测试 10: 缺 selector_value
    {
      const r = await fetch(base + '/selectors/douyin/buttons:btn_x', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json() as any;
      log(r.status === 400 && j.error?.includes('selector_value'), 'PUT missing selector_value', `→ ${r.status} ${j.error?.slice(0, 50)}`);
    }

    // 测试 11: DELETE
    {
      const r = await fetch(base + '/selectors/douyin/buttons:btn_test_smoke', { method: 'DELETE' });
      const j = await r.json() as any;
      log(r.status === 200 && j.success, 'DELETE entry', `→ ${r.status} ${j.message ?? j.error}`);
    }

    // 测试 12: 验证删除
    {
      const written = JSON.parse(fs.readFileSync(SELECTORS_FILE, 'utf-8'));
      const btn = written.platforms.douyin.buttons.btn_test_smoke;
      log(!btn, 'DELETE removed from file', btn ? 'still there!' : 'gone');
    }

    // 测试 13: DELETE 不存在
    {
      const r = await fetch(base + '/selectors/douyin/buttons:btn_nope_xyz', { method: 'DELETE' });
      const j = await r.json() as any;
      log(r.status === 404, 'DELETE missing', `→ ${r.status} ${j.error?.slice(0, 50)}`);
    }

    // 测试 14: DELETE 错误 categoryKey
    {
      const r = await fetch(base + '/selectors/douyin/badkey', { method: 'DELETE' });
      const j = await r.json() as any;
      log(r.status === 400, 'DELETE bad key', `→ ${r.status} ${j.error?.slice(0, 50)}`);
    }

    // 清理: 删除测试创建的 btn_infer
    await fetch(base + '/selectors/douyin/buttons:btn_infer', { method: 'DELETE' });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
  } catch (err) {
    console.error('Test error:', err);
    failed++;
  } finally {
    // restore
    fs.writeFileSync(SELECTORS_FILE, original);
    fs.unlinkSync(backupPath);
    server.close();
    process.chdir(REAL_CWD);
    process.exit(failed > 0 ? 1 : 0);
  }
});
})().catch(err => { console.error('Top-level error:', err); process.exit(1); });
