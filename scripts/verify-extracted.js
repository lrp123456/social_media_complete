#!/usr/bin/env node
/**
 * scripts/verify-extracted.js
 * 重新加载 scripts/selectors-extracted.json，对每个 staticPrimary 跑静态回放校验，
 * 并打印一份易读的"覆盖率"摘要。可作为 CI 闸门。
 */
const path = require('node:path');
const fs = require('node:fs');

// 直接复用 @social-media/selectors 内置的 loader（要求已 build）
const { loadExtractedConfig } = require('../packages/selectors/dist/loader.js');

const ROOT = path.resolve(__dirname, '..');
const DOM_DIR = path.join(ROOT, 'dom源文件');

const PLATFORM_FILES = {
  douyin: {
    menu: '抖音/菜单栏.txt', publish: '抖音/高清发布页面.txt',
    publish_after: '抖音/高清发布页面上传后.txt', work_manage: '抖音/内容管理-作品管理.txt',
    works_analysis: '抖音/数据中心-作品分析-投稿列表.txt', comment_manage: '抖音/互动管理-评论管理.txt',
    select_works: '抖音/互动管理-评论管理-选择作品.txt',
  },
  kuaishou: {
    menu: '快手/菜单栏.txt', publish: '快手/发布作品页面.txt',
    publish_after: '快手/发布作品页面(点击上传后).txt', work_manage: '快手/内容管理-作品管理.txt',
    select_videos: '快手/互动管理-评论管理-点击选择视频页面.txt',
    comment_manage: '快手/互动管理-评论管理内页面.txt', data_analysis: '快手/数据中心-作品分析.txt',
  },
  xiaohongshu: {
    menu: '小红书/菜单栏.txt', publish: '小红书/发布笔记页面.txt',
    publish_after: '小红书/发布笔记页面(点击上传后).txt', note_manage: '小红书/笔记管理页面.txt',
    data_board: '小红书/数据看板-内容分析.txt',
  },
};

// 极简 HTML/CSS 解析器：与 extract_selectors.py 的 verify_css/verify_xpath 等价
// 这里用正则回放；复杂结构建议运行 extract_selectors.py 自身的覆盖率输出
function selectAll(html, css) {
  // 去掉 :visible 伪类与 >> chain
  css = css.replace(/:visible/g, '').split('>>')[0].trim();
  // 仅支持 #id, .class, tag, [attr] 与 *=
  if (/^#[\w\-:.]+$/.test(css)) {
    const re = new RegExp(`id=["']${css.slice(1)}["']`, 'g');
    return re.test(html) ? [1] : [];
  }
  if (/^\.[\w\-]+$/.test(css)) {
    const re = new RegExp(`class=["'][^"']*\\b${css.slice(1)}\\b[^"']*["']`, 'g');
    return html.match(re) || [];
  }
  // 复合选择器（id + class）：用 + 链接多个 token 匹配
  const tokens = css.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const allMatch = tokens.every(tok => {
      if (/^#[\w\-:.]+$/.test(tok)) {
        return new RegExp(`id=["']${tok.slice(1)}["']`).test(html);
      }
      if (/^\.[\w\-]+$/.test(tok)) {
        return new RegExp(`class=["'][^"']*\\b${tok.slice(1)}\\b`).test(html);
      }
      return false;
    });
    return allMatch ? [1] : [];
  }
  return [];
}

function xpathToCss(xp) {
  let s = xp.replace(/^xpath=/, '').trim();
  s = s.replace(/^\/?(html\/)?body\/?/, '');
  if (s.startsWith('//')) s = ' ' + s.slice(2);
  s = s.replace(/\//g, ' > ').replace(/\[(\d+)\]/g, ':nth-of-type($1)');
  s = s.replace(/\[@id='([^']+)'\]/g, '#$1');
  s = s.replace(/\[@class='([^']+)'\]/g, '.$1');
  s = s.replace(/\[contains\(@class,\s*'([^']+)'\)\]/g, '.$1');
  return s.trim();
}

const cfg = loadExtractedConfig();
const summary = {};
let totalEntries = 0, totalVerified = 0;

for (const [platform, cats] of Object.entries(cfg.platforms)) {
  summary[platform] = { menus: 0, buttons: 0, regions: 0, textboxes: 0 };
  for (const [catName, entries] of Object.entries(cats)) {
    for (const [key, e] of Object.entries(entries)) {
      totalEntries++;
      summary[platform][catName]++;
      const sp = e.staticPrimary || '';
      if (!sp) continue; // primary is safe (getBy*), no static evidence required
      const page = e.evidence && e.evidence.page;
      if (!page) continue;
      const filePath = path.join(DOM_DIR, PLATFORM_FILES[platform][page]);
      if (!fs.existsSync(filePath)) {
        console.warn(`[WARN] missing DOM: ${filePath}`);
        continue;
      }
      const html = fs.readFileSync(filePath, 'utf-8');
      const sel = sp.startsWith('xpath=') ? xpathToCss(sp) : sp;
      const hits = selectAll(html, sel).length;
      if (hits > 0) totalVerified++;
    }
  }
}

console.log('=========================================');
console.log(`  提取的选择器覆盖率 (${totalVerified}/${totalEntries} static verified)`);
console.log('=========================================');
for (const [p, cats] of Object.entries(summary)) {
  console.log(`  ${p.padEnd(12)} ${Object.values(cats).reduce((a, b) => a + b, 0)} entries`);
  for (const [c, n] of Object.entries(cats)) {
    if (n) console.log(`    - ${c.padEnd(10)} ${n}`);
  }
}

const coverage = totalVerified / totalEntries;
console.log('-------------------------------------');
console.log(`  coverage: ${(coverage * 100).toFixed(1)}%`);
if (coverage < 0.8) {
  console.error('[FAIL] coverage below 80%');
  process.exit(1);
}
console.log('[OK] selectors look good');
