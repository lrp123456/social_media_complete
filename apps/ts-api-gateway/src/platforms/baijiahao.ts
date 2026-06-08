// @ts-api-gateway/platforms/baijiahao.ts - 百家号发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/baijiahao.py (252行)

import { Page } from 'patchright';
import { HumanActions } from '@social-media/browser-core';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:baijiahao');

export class BaijiahaoPublisher extends BasePublisher {
  readonly platform: PlatformName = 'baijiahao';
  readonly creatorUrl = 'https://baijiahao.baidu.com';

  protected async doLogin(ctx: LoginContext): Promise<void> {
    const { page } = ctx;
    await page.goto(this.creatorUrl, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 4000);
    // 百家号使用百度账号登录（手动模式）
    logger.info('[百家号] 等待手动登录或 Cookie 恢复');
  }

  protected async goToPublishPage(page: Page): Promise<void> {
    await HumanActions.cdpClick(page, 'text=发布', { timeout: 8000 });
    await HumanActions.wait(page, 1000, 2000);
    await HumanActions.cdpClick(page, 'text=视频', { timeout: 8000 });
    await HumanActions.wait(page, 2000, 3000);
  }

  protected async uploadVideo(ctx: UploadContext): Promise<void> {
    await HumanActions.cdpSetInputFiles(ctx.page, ctx.videoPath, {
      clickSelector: 'text=上传视频',
      clickBeforeUpload: true,
    });
    await HumanActions.wait(ctx.page, 5000, 8000);
    logger.info('[百家号] 视频上传完成');
  }

  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    const titleInput = await HumanActions.cdpFindScrollContainer(ctx.page, ['input[placeholder*="标题"]']);
    if (titleInput) await HumanActions.safeCDPType(ctx.page, ctx.metadata.title, titleInput.sel);
    logger.info('[百家号] 元数据已填写');
  }

  protected async submitPublish(page: Page): Promise<string> {
    await HumanActions.cdpClick(page, 'text=发布', { timeout: 8000 });
    await HumanActions.wait(page, 3000, 5000);
    return 'https://baijiahao.baidu.com/user/self';
  }
}
