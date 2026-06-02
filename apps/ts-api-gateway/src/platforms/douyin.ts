// @ts-api-gateway/platforms/douyin.ts - 抖音发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/douyin.py (579行)
// 严格遵守 project_rules.md: 所有操作通过 HumanActions

import { Page } from 'patchright';
import { HumanActions } from '@social-media/browser-core';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:douyin');

export class DouyinPublisher extends BasePublisher {
  readonly platform: PlatformName = 'douyin';
  readonly creatorUrl = 'https://creator.douyin.com';

  // ============================================================
  // 登录（QR 扫码 + SMS 验证码）
  // ============================================================

  protected async doLogin(ctx: LoginContext): Promise<void> {
    const { page } = ctx;

    // 1. 导航到创作者中心
    await page.goto(this.creatorUrl, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 4000);

    // 2. 检测是否已登录（检查页面是否跳转到创作者后台）
    const currentUrl = page.url();
    if (currentUrl.includes('creator.douyin.com/creator-micro')) {
      logger.info('[抖音] 已登录状态（Cookie有效），跳过登录');
      return;
    }

    // 3. 等待 QR 码出现
    const qrSelector = '[class*="qrcode"], [class*="qr-code"], img[src*="qr"]';
    await HumanActions.cdpClick(page, qrSelector, { timeout: 15000 });
    logger.info('[抖音] QR 码已显示，等待扫码');

    // 4. 轮询等待登录成功（最多 120s）
    const maxWait = 120_000;
    const pollInterval = 3_000;
    let elapsed = 0;

    while (elapsed < maxWait) {
      await HumanActions.wait(page, pollInterval, pollInterval + 1000);
      elapsed += pollInterval;

      const url = page.url();
      if (url.includes('creator.douyin.com/creator-micro')) {
        logger.info('[抖音] QR 登录成功');
        break;
      }

      // 检测 SMS 验证码弹窗
      const smsInput = await HumanActions.cdpFindScrollContainer(page, [
        'input[placeholder*="验证码"]',
        'input[placeholder*="code"]',
      ]);
      if (smsInput) {
        logger.info('[抖音] 检测到 SMS 验证码弹窗，等待手动输入');
        await HumanActions.wait(page, 15_000, 30_000);
      }
    }
  }

  // ============================================================
  // 导航到发布页
  // ============================================================

  protected async goToPublishPage(page: Page): Promise<void> {
    // 点击"内容管理" → "作品管理"
    await HumanActions.cdpClick(page, '#douyin-creator-master-menu-nav-content', { timeout: 8000 });
    await HumanActions.wait(page, 800, 1500);
    await HumanActions.cdpClick(page, '#douyin-creator-master-menu-nav-work_manage', { timeout: 8000 });
    await HumanActions.wait(page, 1500, 2500);

    // 点击"发布视频"按钮
    const publishBtn = await HumanActions.cdpFindScrollContainer(page, [
      'text=发布视频',
      'button:has-text("发布")',
      '[class*="publish"] button',
    ]);
    if (publishBtn) {
      await HumanActions.cdpClick(page, 'text=发布视频', { timeout: 8000 });
      logger.info('[抖音] 已进入发布页面');
    }

    await HumanActions.wait(page, 2000, 3000);
  }

  // ============================================================
  // 上传视频
  // ============================================================

  protected async uploadVideo(ctx: UploadContext): Promise<void> {
    const { page, videoPath } = ctx;

    // 1. 定位文件上传 input（隐藏的 file input）
    const fileInputSelector = 'input[type="file"][accept*="video"]';
    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 30000 });

    // 2. 点击上传区域触发文件选择器
    const uploadArea = await HumanActions.cdpFindScrollContainer(page, [
      '[class*="upload"]',
      '[class*="drag"]',
      'text=上传视频',
      'text=添加视频',
    ]);
    if (uploadArea) {
      await HumanActions.cdpClick(page, uploadArea.sel, { timeout: 8000 });
    }

    // 3. 选择文件
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(videoPath);
    logger.info('[抖音] 视频文件已选择，等待上传');

    // 4. 等待上传完成（检测进度条消失或成功状态）
    await HumanActions.wait(page, 5000, 8000);
    const progressGone = await HumanActions.cdpIsElementVisible(page, '[class*="progress"]');
    if (progressGone) {
      await page.waitForSelector('[class*="progress"]', { state: 'hidden', timeout: 300_000 });
    }
    logger.info('[抖音] 视频上传完成');
  }

  // ============================================================
  // 填写元数据
  // ============================================================

  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    const { page, metadata } = ctx;

    // 1. 填写标题
    const titleInput = await HumanActions.cdpFindScrollContainer(page, [
      'input[placeholder*="标题"]',
      'input[placeholder*="title"]',
      '#title-input',
    ]);
    if (titleInput) {
      await HumanActions.safeCDPType(page, metadata.title, titleInput.sel);
      logger.info('[抖音] 标题已填写');
    }

    // 2. 填写描述
    const descSelector = '[class*="desc"] [contenteditable="true"], textarea[placeholder*="描述"]';
    const descVisible = await HumanActions.cdpIsElementVisible(page, descSelector);
    if (descVisible) {
      await HumanActions.safeCDPType(page, metadata.description, descSelector);
      logger.info('[抖音] 描述已填写');
    }

    // 3. 添加标签（平台通常有标签输入框）
    // 抖音使用 # 话题形式，可能需要逐个添加
    if (metadata.tags.length > 0) {
      const tagInput = await HumanActions.cdpFindScrollContainer(page, [
        'input[placeholder*="话题"]',
        'input[placeholder*="tag"]',
      ]);
      if (tagInput) {
        const tagText = metadata.tags.map((t) => `#${t} `).join('');
        await HumanActions.safeCDPType(page, tagText, tagInput.sel);
        logger.info(`[抖音] ${metadata.tags.length} 个标签已添加`);
      }
    }
  }

  // ============================================================
  // 提交发布
  // ============================================================

  protected async submitPublish(page: Page): Promise<string> {
    // 1. 处理原创声明弹窗（如果出现）
    const declareBtn = await HumanActions.cdpFindScrollContainer(page, [
      'text=声明原创',
      'text=确认',
      '[class*="declare"] button',
    ]);
    if (declareBtn) {
      await HumanActions.cdpClick(page, declareBtn.sel);
      await HumanActions.wait(page, 500, 1000);
    }

    // 2. 点击发布按钮
    const publishBtn = await HumanActions.cdpFindScrollContainer(page, [
      'button:has-text("发布")',
      'text=提交',
      '[class*="publish"] button',
      '[class*="submit"] button',
    ]);
    if (publishBtn) {
      await HumanActions.cdpClick(page, publishBtn.sel);
      logger.info('[抖音] 发布按钮已点击');
    }

    // 3. 等待发布成功
    await HumanActions.wait(page, 3000, 5000);

    // 4. 检测发布结果
    const successFlag = await HumanActions.cdpFindScrollContainer(page, [
      'text=发布成功',
      'text=上传成功',
      '[class*="success"]',
    ]);

    if (successFlag) {
      logger.info('[抖音] ✅ 发布成功');
    }

    // 返回作品链接（由前端拼接或后续任务采集）
    return `https://www.douyin.com/user/self`;
  }
}
