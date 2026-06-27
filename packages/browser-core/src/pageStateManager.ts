import { Page } from 'patchright';
import { Platform } from '../types';
import { DatabaseService } from '../db/database';
import { HumanActions } from './humanActions';
import { rootLogger } from '../logger';

const logger = rootLogger.child({ name: 'pageStateManager' });

const TARGET_PAGES: Record<Platform, { urls: string[]; types: Record<string, string> }> = {
  douyin: {
    urls: [
      'creator.douyin.com/creator-micro/data-center/content',
      'creator.douyin.com/creator-micro/content/manage',
    ],
    types: {
      'data-center/content': 'data_center',
      'content/manage': 'content_manage',
    },
  },
  kuaishou: {
    urls: [
      'cp.kuaishou.com/article/manage/video',
      'cp.kuaishou.com/statistics/article',
    ],
    types: {
      'article/manage/video': 'video_manage',
      'statistics/article': 'data_analysis',
    },
  },
  xiaohongshu: {
    urls: [
      'creator.xiaohongshu.com/statistics/data-analysis',
      'creator.xiaohongshu.com/new/note-manager',
    ],
    types: {
      'statistics/data-analysis': 'data_analysis',
      'new/note-manager': 'note_manage',
    },
  },
  bilibili: {
    urls: [
      'member.bilibili.com',
    ],
    types: {
      'member.bilibili.com': 'creator_home',
    },
  },
  baijiahao: {
    urls: [
      'baijiahao.baidu.com',
    ],
    types: {
      'baijiahao.baidu.com': 'creator_home',
    },
  },
  tencent: {
    urls: [
      'channels.weixin.qq.com/platform',
    ],
    types: {
      'channels.weixin.qq.com/platform': 'creator_home',
    },
  },
  tiktok: {
    urls: [
      'www.tiktok.com/creator-tools',
    ],
    types: {
      'www.tiktok.com/creator-tools': 'creator_home',
    },
  },
};

const MIN_REFRESH_INTERVAL_MS = 30_000;
const EXTENDED_REFRESH_INTERVAL_MS = 90_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_PAGE_READY_TIMEOUT_MS = 15_000;
const DOM_POLL_INTERVAL_MS = 500;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 5_000;

export class PageStateManager {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  isOnTargetPage(page: Page, platform: Platform): boolean {
    const url = page.url();
    const config = TARGET_PAGES[platform];
    if (!config) return false;
    return config.urls.some(target => url.includes(target));
  }

  getTargetPageType(page: Page, platform: Platform): string | null {
    const url = page.url();
    const config = TARGET_PAGES[platform];
    if (!config) return null;

    for (const [pathFragment, pageType] of Object.entries(config.types)) {
      if (url.includes(pathFragment)) {
        return pageType;
      }
    }
    return null;
  }

  async smartRefresh(page: Page, platform: Platform): Promise<boolean> {
    const platformKey = platform;
    const cache = this.db.getPageStateCache(platformKey);
    const consecutiveFailures = cache?.consecutive_failures ?? 0;

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.warn({ platform: platformKey, consecutiveFailures }, 'Too many consecutive failures, skipping refresh');
      return false;
    }

    const minInterval = consecutiveFailures >= 3 ? EXTENDED_REFRESH_INTERVAL_MS : MIN_REFRESH_INTERVAL_MS;
    if (!this.db.shouldRefreshPage(platformKey, minInterval)) {
      logger.debug({ platform: platformKey, minInterval }, 'Refresh cooldown not elapsed, skipping');
      return false;
    }

    const prevFingerprint = cache?.last_data_fingerprint ?? '';

    try {
      logger.info({ platform: platformKey }, 'Starting smart refresh');

      await HumanActions.cdpF5Refresh(page);
      HumanActions.clearCDPContext(page);

      const pageReady = await this.waitForPageReady(page);
      if (!pageReady) {
        logger.warn({ platform: platformKey }, 'Page did not reach ready state after refresh');
        this.recordFailure(platformKey);
        return false;
      }

      await HumanActions.wait(page, 1000, 2000);

      const fingerprint = await this.generateContentFingerprint(page);

      if (prevFingerprint && fingerprint === prevFingerprint) {
        logger.warn({ platform: platformKey }, 'Content fingerprint unchanged after refresh, page may not have reloaded');
        this.recordFailure(platformKey);
        return false;
      }

      const newRefreshCount = (cache?.refresh_count ?? 0) + 1;
      this.db.updatePageStateCache(platformKey, {
        last_refresh_at: Date.now(),
        last_data_fingerprint: fingerprint,
        refresh_count: newRefreshCount,
        consecutive_failures: 0,
      });

      logger.info({ platform: platformKey, fingerprint: fingerprint.substring(0, 32), refreshCount: newRefreshCount }, 'Smart refresh successful');
      return true;
    } catch (error: any) {
      logger.error({ platform: platformKey, error: error.message }, 'Smart refresh failed');
      this.recordFailure(platformKey);
      return false;
    }
  }

  async waitForPageReady(page: Page, timeoutMs: number = DEFAULT_PAGE_READY_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        if (bodyText && bodyText.length > 100) {
          return true;
        }
      } catch {}

      await page.waitForTimeout(DOM_POLL_INTERVAL_MS);
    }

    return false;
  }

  async generateContentFingerprint(page: Page): Promise<string> {
    try {
      const bodyText = await HumanActions.cdpGetBodyText(page);
      const textLen = bodyText.length;
      const prefix = bodyText.substring(0, 100);
      const raw = `${textLen}:${prefix}`;
      return this.simpleHash(raw);
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to generate content fingerprint');
      return '';
    }
  }

  async refreshWithRetry(page: Page, platform: Platform, maxRetries: number = MAX_RETRIES): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger.info({ platform, attempt, maxRetries }, 'Refresh attempt');

      const success = await this.smartRefresh(page, platform);
      if (success) {
        return true;
      }

      if (attempt < maxRetries) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.info({ platform, attempt, backoffMs: backoff }, 'Backing off before retry');
        await page.waitForTimeout(backoff);
      }
    }

    logger.error({ platform, maxRetries }, 'All refresh attempts failed');
    return false;
  }

  private recordFailure(platform: string): void {
    const cache = this.db.getPageStateCache(platform);
    const newFailures = (cache?.consecutive_failures ?? 0) + 1;

    this.db.updatePageStateCache(platform, {
      last_refresh_at: Date.now(),
      consecutive_failures: newFailures,
    });

    logger.warn({ platform, consecutiveFailures: newFailures }, 'Refresh failure recorded');
  }

  private simpleHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const ch = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }
}
