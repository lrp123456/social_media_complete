// @ts-api-gateway/platforms/xiaohongshu.ts - 小红书发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/xiaohongshu.py (713行)
// 严格遵守 project_rules.md: 所有操作通过 HumanActions

import { Page } from 'patchright';
import { HumanActions } from '@social-media/browser-core';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:xiaohongshu');

export class XiaohongshuPublisher extends BasePublisher {
  readonly platform: PlatformName = 'xiaohongshu';
  readonly creatorUrl = 'https://creator.xiaohongshu.com';

  // ============================================================
  // 登录（QR 扫码）
  // ============================================================

  protected async doLogin(ctx: LoginContext): Promise<void> {
    const { page } = ctx;

    await page.goto(this.creatorUrl, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 4000);

    // 检测已登录
    if (page.url().includes('creator.xiaohongshu.com/new')) {
      logger.info('[小红书] 已登录状态');
      return;
    }

    // 等待 QR 码
    const qrArea = await HumanActions.cdpFindScrollContainer(page, [
      '.qrcode-img',
      '[class*="qrcode"] img',
      '[class*="login"] img[src*="qr"]',
    ]);
    if (qrArea) {
      logger.info('[小红书] QR 码已显示，等待扫码');
    }

    // 轮询等待登录
    const maxWait = 120_000;
    let elapsed = 0;
    while (elapsed < maxWait) {
      await HumanActions.wait(page, 3000, 4000);
      elapsed += 3500;
      if (page.url().includes('creator.xiaohongshu.com/new')) {
        logger.info('[小红书] QR 登录成功');
        break;
      }
    }
  }

  // ============================================================
  // 导航到发布页
  // ============================================================

  protected async goToPublishPage(page: Page): Promise<void> {
    // 点击"笔记管理"
    await HumanActions.cdpClick(page, '.d-new-menu__inner > .d-menu-item:nth-child(2)', {
      timeout: 8000,
    });
    await HumanActions.wait(page, 1000, 2000);

    // 点击"发布笔记"按钮（小红书 shadow DOM 环境）
    await HumanActions.cdpClick(page, 'text=发布笔记', { timeout: 8000 });
    await HumanActions.wait(page, 2000, 3000);

    // 选择"上传视频"
    const videoTab = await HumanActions.cdpFindScrollContainer(page, [
      'text=上传视频',
      'text=发布视频',
    ]);
    if (videoTab) {
      await HumanActions.cdpClick(page, videoTab.sel);
      await HumanActions.wait(page, 500, 1000);
    }

    logger.info('[小红书] 已进入视频发布页面');
  }

  // ============================================================
  // 上传视频
  // ============================================================

  protected async uploadVideo(ctx: UploadContext): Promise<void> {
    const { page, videoPath } = ctx;

    // 小红书使用 input[type='file'] 上传
    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 30000 });

    // 点击上传区域
    const uploadArea = await HumanActions.cdpFindScrollContainer(page, [
      '.upload-wrapper',
      '[class*="upload"]',
      'text=上传视频',
    ]);
    if (uploadArea) {
      await HumanActions.cdpClick(page, uploadArea.sel);
    }

    // 选择文件
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(videoPath);
    logger.info('[小红书] 视频文件已选择');

    // 等待上传完成（小红书有进度百分比）
    await HumanActions.wait(page, 8000, 12000);

    // 等待上传进度消���
    try {
      await page.waitForSelector('[class*="progress"]', {
        state: 'hidden',
        timeout: 300_000,
      });
    } catch {
      // 可能没有进度条
    }

    logger.info('[小红书] 视频上传完成');
  }

  // ============================================================
  // 填写元数据
  // ============================================================

  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    const { page, metadata } = ctx;

    // 1. 填写标题（小红书限制20字）
    const title = metadata.title.slice(0, 20);
    const titleInput = await HumanActions.cdpFindScrollContainer(page, [
      'input[placeholder*="标题"]',
      '[class*="title"] input',
      '#title',
    ]);
    if (titleInput) {
      await HumanActions.safeCDPType(page, title, titleInput.sel);
      logger.info('[小红书] 标题已填写');
    }

    // 2. 填写描述（小红书有富文本编辑器）
    const descSelector = '[class*="desc"] [contenteditable], [class*="content"] [contenteditable]';
    const descVisible = await HumanActions.cdpIsElementVisible(page, descSelector);
    if (descVisible) {
      await HumanActions.cdpClick(page, descSelector);
      await HumanActions.wait(page, 300, 600);
      await HumanActions.safeCDPType(page, metadata.description, descSelector);
      logger.info('[小红书] 描述已填写');
    }

    // 3. 添加话题（小红书使用 #话题 格式）
    if (metadata.tags.length > 0) {
      const tagArea = await HumanActions.cdpFindScrollContainer(page, [
        '[class*="topic"] input',
        'input[placeholder*="话题"]',
      ]);
      if (tagArea) {
        const tagText = metadata.tags.map((t) => `#${t} `).join('');
        await HumanActions.safeCDPType(page, tagText, tagArea.sel);
        logger.info(`[小红书] ${metadata.tags.length} 个话题已添加`);
      }
    }
  }

  // ============================================================
  // 提交发布
  // ============================================================

  protected async submitPublish(page: Page): Promise<string> {
    // 小红书发布按钮
    const publishBtn = await HumanActions.cdpFindScrollContainer(page, [
      'button:has-text("发布")',
      '.publish-btn',
      '[class*="publish"] button',
    ]);
    if (publishBtn) {
      await HumanActions.cdpClick(page, publishBtn.sel);
      logger.info('[小红书] 发布按钮已点击');
    }

    await HumanActions.wait(page, 3000, 5000);

    // 检测发布结果
    const successFlag = await HumanActions.cdpFindScrollContainer(page, [
      'text=发布成功',
      'text=笔记已发布',
    ]);
    if (successFlag) {
      logger.info('[小红书] ✅ 发布成功');
    }

    return 'https://www.xiaohongshu.com/user/profile/self';
  }
}
