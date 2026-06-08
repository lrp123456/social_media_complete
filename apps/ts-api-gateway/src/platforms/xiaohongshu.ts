// @ts-api-gateway/platforms/xiaohongshu.ts - 小红书发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/xiaohongshu.py (713行)
// 严格遵守 project_rules.md: 所有操作通过 HumanActions

import { Page } from 'patchright';
import { SelectorReader, HumanActions } from '@social-media/browser-core';
import { getSelectorReader } from '../lib/selectorStore';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:xiaohongshu');

export class XiaohongshuPublisher extends BasePublisher {
  readonly platform: PlatformName = 'xiaohongshu';
  readonly creatorUrl = 'https://creator.xiaohongshu.com';
  protected override readonly publishUrl = 'https://creator.xiaohongshu.com/publish';

  private sel(): SelectorReader { return getSelectorReader(); }

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
    const qrArea = await HumanActions.cdpFindScrollContainer(page, this.sel().getSelectorListWithFallback('xiaohongshu', 'buttons', 'btn_qr_login', ['.qrcode-img:visible', '[class*=qrcode] img:visible', '[class*=login] img[src*=qr]']));
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
    await HumanActions.cdpClick(page, this.sel().getSelectorListWithFallback('xiaohongshu', 'menus', 'menu_note_manage', ['.d-new-menu__inner > .d-menu-item:nth-child(2)'])[0], {
      timeout: 8000,
    });
    await HumanActions.wait(page, 1000, 2000);

    // 点击"发布笔记"按钮（小红书 shadow DOM 环境）
    await HumanActions.cdpClick(page, this.sel().getSelectorListWithFallback('xiaohongshu', 'buttons', 'btn_goto_publish', ['text=发布笔记'])[0], { timeout: 8000 });
    await HumanActions.wait(page, 2000, 3000);

    // 选择"上传视频"
    const videoTab = await HumanActions.cdpFindScrollContainer(page, this.sel().getSelectorListWithFallback('xiaohongshu', 'buttons', 'btn_video_tab', ['text=上传视频', 'text=发布视频']));
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

    // 使用 CDP 安全文件注入（避免 OS 级 filechooser 检测）
    await HumanActions.cdpSetInputFiles(page, videoPath, {
      containerSelector: this.sel().getSelectorListWithFallback('xiaohongshu', 'regions', 'region_upload_zone', ['.upload-wrapper:visible', '[class*=upload]:visible', 'text=上传视频'])[0],
      clickBeforeUpload: true,
    });
    logger.info('[小红书] 视频文件已选择');

    // 等待上传完成（小红书有进度百分比）
    await HumanActions.wait(page, 8000, 12000);

    // 等待上传进度消失 — 使用 CDP 安全等待
    const progressSel = this.sel().getSelectorListWithFallback('xiaohongshu', 'regions', 'region_upload_progress', ['[class*=progress]:visible'])[0];
    await HumanActions.cdpWaitForSelector(page, progressSel, {
      state: 'hidden',
      timeout: 300_000,
    });

    logger.info('[小红书] 视频上传完成');
  }

  // ============================================================
  // 填写元数据
  // ============================================================

  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    const { page, metadata } = ctx;

    // 1. 填写标题（小红书限制20字）
    const titleSels = this.sel().getSelectorListWithFallback('xiaohongshu', 'textboxes', 'tb_title', ['input[placeholder*="标题"]:visible', '[class*=title] input:visible', '#title']);
    const title = metadata.title.slice(0, 20);
    const titleInput = await HumanActions.cdpFindElement(page, titleSels);
    if (titleInput) {
      await HumanActions.safeCDPType(page, title, titleInput.sel);
      logger.info('[小红书] 标题已填写');
    } else {
      logger.warn({ selectors: titleSels }, '[小红书] 标题输入框未找到，跳过标题填写');
    }

    // 2. 填写描述（小红书有富文本编辑器）
    const descSels = this.sel().getSelectorListWithFallback('xiaohongshu', 'textboxes', 'tb_description', ['[class*=desc] [contenteditable]', '[class*=content] [contenteditable]']);
    const descSelector = descSels[0];
    const descVisible = await HumanActions.cdpIsElementVisible(page, descSelector);
    if (descVisible) {
      await HumanActions.cdpClick(page, descSelector);
      await HumanActions.wait(page, 300, 600);
      await HumanActions.safeCDPType(page, metadata.description, descSelector);
      logger.info('[小红书] 描述已填写');
    } else {
      logger.warn({ selectors: descSels }, '[小红书] 描述输入框未找到或不可见，跳过描述填写');
    }

    // 3. 添加话题（小红书使用 #话题 格式）
    if (metadata.tags.length > 0) {
      const tagSels = this.sel().getSelectorListWithFallback('xiaohongshu', 'textboxes', 'tb_topic', ['[class*=topic] input:visible', 'input[placeholder*="话题"]']);
      const tagArea = await HumanActions.cdpFindElement(page, tagSels);
      if (tagArea) {
        const tagText = metadata.tags.map((t) => `#${t} `).join('');
        await HumanActions.safeCDPType(page, tagText, tagArea.sel);
        logger.info(`[小红书] ${metadata.tags.length} 个话题已添加`);
      } else {
        logger.warn({ count: metadata.tags.length, selectors: tagSels }, '[小红书] 话题输入框未找到，跳过话题添加');
      }
    }
  }

  // 提交发布继承 BasePublisher.submitPublish 默认实现 (走 selectors.json flowRules)
  // 默认 helper: submitPublishWithFlowRules → 滚动 → scope-scoped 找按钮 →
  //   多路 disabled 检测 → 点击 + URL 校验 → 弹窗处理 → 成功 toast/URL 命中
}
