// @ts-api-gateway/platforms/tiktok.ts - TikTok 发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/tiktok.py (84行, Stub)

import { Page } from 'patchright';
import { HumanActions } from '@social-media/browser-core';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:tiktok');

export class TiktokPublisher extends BasePublisher {
  readonly platform: PlatformName = 'tiktok';
  readonly creatorUrl = 'https://www.tiktok.com/creator-tools';

  /** TikTok 登录（Stub - 需要海外代理环境） */
  protected async doLogin(ctx: LoginContext): Promise<void> {
    const { page } = ctx;
    await page.goto(this.creatorUrl, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 4000);
    logger.warn('[TikTok] 登录流程待完整实现（需要海外网络环境）');
  }

  protected async goToPublishPage(page: Page): Promise<void> {
    await HumanActions.cdpClick(page, 'text=Upload', { timeout: 8000 });
    await HumanActions.wait(page, 2000, 3000);
  }

  protected async uploadVideo(ctx: UploadContext): Promise<void> {
    const fileChooserPromise = ctx.page.waitForEvent('filechooser', { timeout: 30000 });
    await HumanActions.cdpClick(ctx.page, 'text=Select video', { timeout: 8000 });
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(ctx.videoPath);
    await HumanActions.wait(ctx.page, 5000, 8000);
    logger.info('[TikTok] 视频上传完成（Stub）');
  }

  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    const captionInput = await HumanActions.cdpFindScrollContainer(ctx.page, [
      '[class*="caption"]',
      '[contenteditable="true"]',
    ]);
    if (captionInput) await HumanActions.safeCDPType(ctx.page, ctx.metadata.description, captionInput.sel);
    logger.info('[TikTok] 元数据已填写（Stub）');
  }

  protected async submitPublish(page: Page): Promise<string> {
    await HumanActions.cdpClick(page, 'text=Post', { timeout: 8000 });
    await HumanActions.wait(page, 3000, 5000);
    logger.warn('[TikTok] 发布完成（Stub - 待完整实现）');
    return 'https://www.tiktok.com/user/self';
  }
}
