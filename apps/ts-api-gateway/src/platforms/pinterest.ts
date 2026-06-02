// @ts-api-gateway/platforms/pinterest.ts - Pinterest 素材采集爬虫
// 从 Python 端迁移至 TS，复用 HumanActions + patchright + Redlock
// 严格遵循 project_rules.md 反检测规则

import { Page } from 'patchright';
import { HumanActions, BrowserManager } from '@social-media/browser-core';
import { createLogger } from '../lib/logger';
import { WindowMutex } from '../lib/redlock';
import { prisma } from '../lib/prisma';
import { uploadToOSS, ossKey } from '../lib/oss';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:pinterest');

// ============================================================
// Pinterest 爬虫配置
// ============================================================

interface PinterestScrapeTask {
  taskId: string;
  traceId: string;
  windowId: string;
  query: string;
  maxPins: number;
  options?: {
    boardId?: string;
    minWidth?: number;
    saveImages?: boolean;
  };
}

interface PinterestPin {
  pinId: string;
  imageUrl: string;
  ossUrl?: string;
  title: string;
  description: string;
  width: number;
  height: number;
  sourceUrl?: string;
}

interface PinterestScrapeResult {
  success: boolean;
  taskId: string;
  pins: PinterestPin[];
  totalScraped: number;
  error?: string;
  duration: number;
}

// ============================================================
// Pinterest 爬虫类
// ============================================================

export class PinterestScraper {
  private readonly BASE_URL = 'https://www.pinterest.com';
  private browser: any = null;
  private page: any = null;
  private lock: any = null;

  /**
   * 执行 Pinterest 素材采集
   */
  async scrape(task: PinterestScrapeTask): Promise<PinterestScrapeResult> {
    const startTime = Date.now();
    const pins: PinterestPin[] = [];

    try {
      // 1. 获取窗口互斥锁
      this.lock = await WindowMutex.acquireWithBackoff(task.windowId);
      logger.info(`[Pinterest] 🔒 窗口锁已获取: ${task.windowId}`);

      // 2. 初始化浏览器（连接指纹浏览器）
      const { chromium } = await import('patchright');
      this.browser = await chromium.launchChannel('chrome', {
        headless: false,
      });

      const context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      this.page = await context.newPage();

      // 3. 导航到 Pinterest 搜索页
      const searchUrl = `${this.BASE_URL}/search/pins/?q=${encodeURIComponent(task.query)}`;
      await this.page.goto(searchUrl, { waitUntil: 'networkidle' });
      await HumanActions.wait(this.page, 2000, 4000);

      // 注入人类行为噪声
      await HumanActions.randomBlankClick(this.page);

      // 4. 滚动加载素材
      const maxPins = task.maxPins || 50;
      await this.scrollAndCollect(pins, maxPins);

      // 5. 保存图片到 OSS（如果启用）
      if (task.options?.saveImages !== false) {
        await this.saveImagesToOSS(pins, task.taskId);
      }

      // 6. 写入数据库
      await this.saveToDatabase(pins, task.query);

      logger.info(`[Pinterest] ✅ 采集完成: ${pins.length} pins`);

      return {
        success: true,
        taskId: task.taskId,
        pins,
        totalScraped: pins.length,
        duration: Date.now() - startTime,
      };
    } catch (err) {
      logger.error(`[Pinterest] ❌ 采集失败: ${(err as Error).message}`);
      return {
        success: false,
        taskId: task.taskId,
        pins: [],
        totalScraped: 0,
        error: (err as Error).message,
        duration: Date.now() - startTime,
      };
    } finally {
      await this.cleanup();
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 滚动加载 + 收集 Pin 数据 */
  private async scrollAndCollect(pins: PinterestPin[], maxPins: number): Promise<void> {
    const pinSelector = '[data-test-id="pin"]';
    const seenIds = new Set<string>();

    while (pins.length < maxPins) {
      // 提取当前可见的 Pins
      const newPins = await this.extractVisiblePins(pinSelector, seenIds);
      pins.push(...newPins);

      if (newPins.length === 0) {
        logger.info('[Pinterest] 无更多素材，停止滚动');
        break;
      }

      // 人类滚动（分段 + 过冲回弹）
      await HumanActions.humanScroll(this.page, 800, {
        direction: 'down',
        segmentCount: { min: 3, max: 6 },
        pauseBetween: { min: 500, max: 1500 },
        overshootChance: 0.15,
      });

      await HumanActions.wait(this.page, 1500, 3000);

      // 随机空闲行为
      if (Math.random() < 0.3) {
        await HumanActions.randomBlankClick(this.page);
      }
    }
  }

  /** 提取当前可见的 Pin 数据（通过 CDP DOM 而非 page.evaluate） */
  private async extractVisiblePins(
    selector: string,
    seenIds: Set<string>,
  ): Promise<PinterestPin[]> {
    const pins: PinterestPin[] = [];

    try {
      // 使用 CDP DOM 查询所有 Pin 元素
      const container = await HumanActions.cdpFindScrollContainer(this.page, [selector]);
      if (!container) return pins;

      // 通过 CDP 获取每个 Pin 的数据
      // 实际实现中需要遍历 DOM 节点获取 img src, title 等
      const bodyText = await HumanActions.cdpGetBodyText(this.page);

      // 简化版：从页面中提取 image URLs
      const imgPattern = /https:\/\/i\.pinimg\.com\/\d+x\/[a-f0-9]+\/[a-f0-9]+\.(jpg|png)/gi;
      const matches = bodyText.match(imgPattern) || [];

      for (const imgUrl of matches) {
        // 提取唯一 ID
        const pinId = imgUrl.match(/\/([a-f0-9]+)\.(jpg|png)$/i)?.[1] || '';
        if (seenIds.has(pinId)) continue;
        seenIds.add(pinId);

        pins.push({
          pinId,
          imageUrl: imgUrl,
          title: '',
          description: '',
          width: 736,
          height: 1104,
        });
      }
    } catch (err) {
      logger.warn(`[Pinterest] 提取 Pin 数据异常: ${(err as Error).message}`);
    }

    return pins;
  }

  /** 保存图片到 OSS */
  private async saveImagesToOSS(pins: PinterestPin[], taskId: string): Promise<void> {
    const axios = (await import('axios')).default;
    const fs = (await import('fs')).promises;
    const path = (await import('path')).default;
    const os = (await import('os')).default;

    for (const pin of pins) {
      try {
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `pin_${pin.pinId}.jpg`);

        // 下载图片
        const response = await axios.get(pin.imageUrl, { responseType: 'arraybuffer' });
        await fs.writeFile(tmpFile, response.data);

        // 上传到 OSS
        const ossPath = ossKey(`pinterest/${taskId}`, `pin_${pin.pinId}.jpg`);
        pin.ossUrl = await uploadToOSS(tmpFile, ossPath);

        // 清理临时文件
        await fs.unlink(tmpFile);
      } catch (err) {
        logger.warn(`[Pinterest] 图片保存失败: ${pin.pinId}`);
      }
    }
  }

  /** 保存到数据库 */
  private async saveToDatabase(pins: PinterestPin[], query: string): Promise<void> {
    // 写入 platform_configs 或新建 pinterest_materials 表
    // 暂时记录到 operation_logs
    await prisma.operationLog.create({
      data: {
        action: 'pinterest_scrape',
        details: JSON.stringify({ query, pinCount: pins.length }),
        userId: 'system',
        userName: 'Pinterest Scraper',
        result: 'success',
        level: 'info',
      },
    });
  }

  /** 清理资源 */
  private async cleanup(): Promise<void> {
    if (this.lock) {
      try {
        await this.lock.release();
        logger.info('[Pinterest] 🔓 窗口锁已释放');
      } catch {}
      this.lock = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
      this.page = null;
    }
  }
}
