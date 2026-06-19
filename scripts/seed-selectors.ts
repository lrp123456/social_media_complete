#!/usr/bin/env npx tsx
// scripts/seed-selectors.ts
// 将 data/selectors.json 中的所有选择器持久化到 custom_selectors 数据库表
//
// 用法: npx tsx scripts/seed-selectors.ts
// 可选环境变量:
//   SELECTORS_JSON_PATH  — 自定义 selectors.json 路径 (默认: apps/ts-api-gateway/data/selectors.json)

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const prisma = new PrismaClient();

interface SelectorEntry {
  purposes: string[];
  primary: string;
  fallbacks: string[];
  selectorType: string;
  description?: string;
  enabled?: boolean;
  filterTag?: string;
  filterText?: string;
  scopeKey?: string;
  parent?: string;
  expandCheckCss?: string;
}

interface PlatformSelectors {
  menus: Record<string, SelectorEntry>;
  buttons: Record<string, SelectorEntry>;
  regions: Record<string, SelectorEntry>;
  textboxes: Record<string, SelectorEntry>;
  flowRules?: Record<string, unknown>;
  urlMonitors?: Record<string, unknown>;
}

interface SelectorConfig {
  version: string;
  updatedAt: string;
  platforms: Record<string, PlatformSelectors>;
}

const CATEGORIES = ['menus', 'buttons', 'regions', 'textboxes'] as const;

async function main() {
  const jsonPath = process.env.SELECTORS_JSON_PATH
    || resolve(__dirname, '..', 'apps', 'ts-api-gateway', 'data', 'selectors.json');

  console.log(`📖 读取选择器配置: ${jsonPath}`);
  const raw = readFileSync(jsonPath, 'utf-8');
  const config: SelectorConfig = JSON.parse(raw);

  const platforms = Object.keys(config.platforms);
  console.log(`📋 发现 ${platforms.length} 个平台: ${platforms.join(', ')}`);

  let totalUpserted = 0;
  let totalSkipped = 0;

  for (const [platform, pSelectors] of Object.entries(config.platforms)) {
    for (const cat of CATEGORIES) {
      const entries = pSelectors[cat] || {};
      for (const [name, entry] of Object.entries(entries)) {
        const selectorKey = `${cat}:${name}`;
        const selectorValue = JSON.stringify({
          purposes: entry.purposes,
          primary: entry.primary,
          fallbacks: entry.fallbacks || [],
          selectorType: entry.selectorType || 'css',
          description: entry.description || '',
          enabled: entry.enabled !== false,
          ...(entry.filterTag ? { filterTag: entry.filterTag } : {}),
          ...(entry.filterText ? { filterText: entry.filterText } : {}),
          ...(entry.scopeKey ? { scopeKey: entry.scopeKey } : {}),
          ...(entry.parent ? { parent: entry.parent } : {}),
          ...(entry.expandCheckCss ? { expandCheckCss: entry.expandCheckCss } : {}),
        });

        try {
          await prisma.customSelector.upsert({
            where: {
              platform_selectorKey: { platform, selectorKey },
            },
            create: {
              platform,
              selectorKey,
              selectorValue,
              description: entry.description || '',
              enabled: entry.enabled !== false,
            },
            update: {
              selectorValue,
              description: entry.description || '',
              enabled: entry.enabled !== false,
              version: { increment: 1 },
            },
          });
          totalUpserted++;
        } catch (err: any) {
          console.error(`  ❌ ${platform}/${selectorKey}: ${err.message}`);
          totalSkipped++;
        }
      }
    }

    // 同时持久化 flowRules（如果有）
    if (pSelectors.flowRules && Object.keys(pSelectors.flowRules).length > 0) {
      const selectorKey = 'flowRules:_default';
      const selectorValue = JSON.stringify(pSelectors.flowRules);
      try {
        await prisma.customSelector.upsert({
          where: {
            platform_selectorKey: { platform, selectorKey },
          },
          create: {
            platform,
            selectorKey,
            selectorValue,
            description: `${platform} 发布流程规则`,
            enabled: true,
          },
          update: {
            selectorValue,
            version: { increment: 1 },
          },
        });
        totalUpserted++;
        console.log(`  ✅ ${platform}/flowRules 已持久化`);
      } catch (err: any) {
        console.error(`  ❌ ${platform}/flowRules: ${err.message}`);
        totalSkipped++;
      }
    }

    // 统计该平台各类别数量
    const counts = CATEGORIES.map(c => `${c}=${Object.keys(pSelectors[c] || {}).length}`);
    console.log(`  ✅ ${platform}: ${counts.join(', ')}`);
  }

  console.log(`\n📊 完成: ${totalUpserted} 条已写入, ${totalSkipped} 条跳过`);
}

main()
  .catch((err) => {
    console.error('❌ 种子脚本失败:', err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
