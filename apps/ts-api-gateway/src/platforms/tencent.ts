// @ts-api-gateway/platforms/tencent.ts - 腾讯视频号发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/tencent.py (450行)

import { Page } from 'patchright';
import { HumanActions } from '@social-media/browser-core';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:tencent');

export class TencentPublisher extends BasePublisher {
  readonly platform: PlatformName = 'tencent';
  readonly creatorUrl = 'https://channels.weixin.qq.com';

  protected async doLogin(ctx: LoginContext): Promise<void> {
    const { page } = ctx;
    await page.goto(this.creatorUrl, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 4000);

    // 腾讯视频号使用微信扫码（iframe 内嵌）
    const qrInIframe = await HumanActions.cdpFindScrollContainer(page, [
      'iframe[src*="login"]',
      'iframe[src*="wx"]',
    ]);
    if (qrInIframe) {
      logger.info('[腾讯视频号] QR iframe 已加载，等待扫码');
    }
    logger.info('[腾讯视频号] 登录流程待实现（iframe QR）');
  }

  protected async goToPublishPage(page: Page): Promise<void> {
    await HumanActions.cdpClick(page, 'text=发表视频', { timeout: 8000 });
    await HumanActions.wait(page, 2000, 3000);
  }

  protected async uploadVideo(ctx: UploadContext): Promise<void> {
    const fileChooserPromise = ctx.page.waitForEvent('filechooser', { timeout: 30000 });
    await HumanActions.cdpClick(ctx.page, 'text=上传', { timeout: 8000 });
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(ctx.videoPath);
    await HumanActions.wait(ctx.page, 5000, 8000);
    logger.info('[腾讯视频号] 视频上传完成');
  }

  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    const titleInput = await HumanActions.cdpFindScrollContainer(ctx.page, ['input[placeholder*="标题"]']);
    if (titleInput) await HumanActions.safeCDPType(ctx.page, ctx.metadata.title, titleInput.sel);
    logger.info('[腾讯视频号] 元数据已填写');
  }

  protected async submitPublish(page: Page): Promise<string> {
    await HumanActions.cdpClick(page, 'text=发表', { timeout: 8000 });
    await HumanActions.wait(page, 3000, 5000);
    return 'https://channels.weixin.qq.com/user/self';
  }
}
