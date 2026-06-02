// @ts-api-gateway/platforms/kuaishou.ts - 快手发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/kuaishou.py (464行)
// 严格遵守 project_rules.md: 所有操作通过 HumanActions

import { Page } from 'patchright';
import { HumanActions } from '@social-media/browser-core';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:kuaishou');

export class KuaishouPublisher extends BasePublisher {
  readonly platform: PlatformName = 'kuaishou';
  readonly creatorUrl = 'https://cp.kuaishou.com';

  // ============================================================
  // 登录（QR 扫码）
  // ============================================================

  protected async doLogin(ctx: LoginContext): Promise<void> {
    const { page } = ctx;

    await page.goto(`${this.creatorUrl}/article/manage/video`, {
      waitUntil: 'domcontentloaded',
    });
    await HumanActions.wait(page, 2000, 4000);

    // 检测已登录
    if (page.url().includes('cp.kuaishou.com/article')) {
      logger.info('[快手] 已登录状态');
      return;
    }

    // 等待 QR 码（快手可能在 passport 页面）
    const qrSelector = '.qrcode-img, [class*="qrcode"] img, [class*="qr_code"]';
    const qrArea = await HumanActions.cdpFindScrollContainer(page, [qrSelector]);
    if (qrArea) {
      logger.info('[快手] QR 码已显示，等待扫码');
    }

    // 轮询等待登录
    const maxWait = 120_000;
    let elapsed = 0;
    while (elapsed < maxWait) {
      await HumanActions.wait(page, 3000, 4000);
      elapsed += 3500;
      if (page.url().includes('cp.kuaishou.com/article')) {
        logger.info('[快手] QR 登录成功');
        break;
      }
    }
  }

  // ============================================================
  // 导航到发布页
  // ============================================================

  protected async goToPublishPage(page: Page): Promise<void> {
    // 点击"内容管理" → "作品管理"
    await HumanActions.cdpClick(page, '#app .el-menu > .el-submenu:nth-of-type(1) > .el-submenu__title', {
      timeout: 8000,
    });
    await HumanActions.wait(page, 800, 1500);
    await HumanActions.cdpClick(page, '#app .el-menu > .el-submenu:nth-of-type(1) .el-menu--inline > .el-menu-item:nth-of-type(1)', {
      timeout: 8000,
    });
    await HumanActions.wait(page, 1500, 2500);

    // 点击发布按钮
    await HumanActions.cdpClick(page, 'text=发布', { timeout: 8000 });
    await HumanActions.wait(page, 2000, 3000);

    // 关闭引导弹窗（快手有 joyride 引导）
    const joyrideClose = await HumanActions.cdpFindScrollContainer(page, [
      '[class*="joyride"] button',
      '[class*="guide"] .close',
      '[class*="tour"] .skip',
    ]);
    if (joyrideClose) {
      await HumanActions.cdpClick(page, joyrideClose.sel);
      await HumanActions.wait(page, 500, 1000);
    }

    logger.info('[快手] 已进入发布页面');
  }

  // ============================================================
  // 上传视频
  // ============================================================

  protected async uploadVideo(ctx: UploadContext): Promise<void> {
    const { page, videoPath } = ctx;

    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 30000 });

    // 快手的上传区域
    const uploadArea = await HumanActions.cdpFindScrollContainer(page, [
      '[class*="upload-video"]',
      '[class*="upload"]',
      'text=上传视频',
    ]);
    if (uploadArea) {
      await HumanActions.cdpClick(page, uploadArea.sel);
    }

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(videoPath);
    logger.info('[快手] 视频文件已选择');

    // 等待上传 + 转码完成
    await HumanActions.wait(page, 5000, 8000);

    // 等待转码进度（快手有转码过程）
    try {
      await page.waitForSelector('[class*="transcode"]', {
        state: 'hidden',
        timeout: 600_000, // 快手转码可能较慢
      });
    } catch {
      await HumanActions.wait(page, 30000, 60000);
    }

    logger.info('[快手] 视频上传完成');
  }

  // ============================================================
  // 填写元数据
  // ============================================================

  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    const { page, metadata } = ctx;

    // 1. 填写标题
    const titleInput = await HumanActions.cdpFindScrollContainer(page, [
      'input[placeholder*="标题"]',
      '[class*="title"] input',
    ]);
    if (titleInput) {
      await HumanActions.safeCDPType(page, metadata.title, titleInput.sel);
      logger.info('[快手] 标题已填写');
    }

    // 2. 填写描述
    const descInput = await HumanActions.cdpFindScrollContainer(page, [
      'textarea[placeholder*="描述"]',
      '[class*="desc"] textarea',
    ]);
    if (descInput) {
      await HumanActions.safeCDPType(page, metadata.description, descInput.sel);
      logger.info('[快手] 描述已填写');
    }

    // 3. 添加标签
    if (metadata.tags.length > 0) {
      await HumanActions.wait(page, 500, 1000);
      // 快手标签通常是单独输入框
      logger.info(`[快手] ${metadata.tags.length} 个标签待添加（手动）`);
    }
  }

  // ============================================================
  // 提交发布
  // ============================================================

  protected async submitPublish(page: Page): Promise<string> {
    const publishBtn = await HumanActions.cdpFindScrollContainer(page, [
      'button:has-text("发布")',
      '[class*="publish"] button',
      '[class*="submit"] button',
    ]);
    if (publishBtn) {
      await HumanActions.cdpClick(page, publishBtn.sel);
      logger.info('[快手] 发布按钮已点击');
    }

    await HumanActions.wait(page, 3000, 5000);

    const successFlag = await HumanActions.cdpFindScrollContainer(page, [
      'text=发布成功',
      'text=已发布',
    ]);
    if (successFlag) {
      logger.info('[快手] ✅ 发布成功');
    }

    return 'https://www.kuaishou.com/profile/self';
  }
}
