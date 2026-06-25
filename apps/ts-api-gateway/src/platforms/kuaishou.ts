// @ts-api-gateway/platforms/kuaishou.ts - 快手发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/kuaishou.py (464行)
// 严格遵守 project_rules.md: 所有操作通过 HumanActions

import { Page } from 'patchright';
import { HumanActions, SelectorReader } from '@social-media/browser-core';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import { getSelectorReader } from '../lib/selectorStore';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:kuaishou');

export class KuaishouPublisher extends BasePublisher {
  readonly platform: PlatformName = 'kuaishou';
  readonly creatorUrl = 'https://cp.kuaishou.com';
  protected override readonly publishUrl = 'https://cp.kuaishou.com/article/publish/video';

  private sel(): SelectorReader { return getSelectorReader(); }

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
    const qrArea = await HumanActions.cdpFindScrollContainer(page, this.sel().getSelectorListWithFallback('kuaishou', 'buttons', 'btn_qr_login', ['.qrcode-img:visible', '[class*=qrcode] img:visible', '[class*=qr_code]:visible']));
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
    await HumanActions.cdpClick(page, this.sel().getSelectorListWithFallback('kuaishou', 'menus', 'menu_content_manage', ['#app .el-menu > .el-submenu:nth-of-type(1) > .el-submenu__title'])[0], {
      timeout: 8000,
    });
    await HumanActions.wait(page, 800, 1500);
    await HumanActions.cdpClick(page, this.sel().getSelectorListWithFallback('kuaishou', 'menus', 'menu_work_manage', ['#app .el-menu > .el-submenu:nth-of-type(1) .el-menu--inline > .el-menu-item:nth-of-type(1)'])[0], {
      timeout: 8000,
    });
    await HumanActions.wait(page, 1500, 2500);

    // 点击发布按钮
    await HumanActions.cdpClick(page, this.sel().getSelectorListWithFallback('kuaishou', 'buttons', 'btn_goto_publish', ['text=发布'])[0], { timeout: 8000 });
    await HumanActions.wait(page, 2000, 3000);

    // 关闭引导弹窗（快手有 joyride 引导）
    const joyrideClose = await HumanActions.cdpFindScrollContainer(page, this.sel().getSelectorListWithFallback('kuaishou', 'menus', 'menu_publish_guide_close', ['[class*=joyride] button:visible', '[class*=guide] .close', '[class*=tour] .skip']));
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

    // 使用 CDP 安全文件注入（避免 OS 级 filechooser 检测）
    await HumanActions.cdpSetInputFiles(page, videoPath, {
      containerSelector: this.sel().getSelectorListWithFallback('kuaishou', 'regions', 'region_upload_zone', ['[class*=upload-video]:visible', '[class*=upload]:visible', 'text=上传视频'])[0],
      clickBeforeUpload: true,
    });
    logger.info('[快手] 视频文件已选择');

    // 等待上传 + 转码完成
    await HumanActions.wait(page, 5000, 8000);

    // 等待转码进度消失（快手有转码过程）
    const transcodeSel = this.sel().getSelectorListWithFallback('kuaishou', 'regions', 'region_transcode_progress', ['[class*=transcode]:visible'])[0];
    const transcodeDone = await HumanActions.cdpWaitForSelector(page, transcodeSel, {
      state: 'hidden',
      timeout: 600_000, // 快手转码可能较慢
    });
    if (!transcodeDone) {
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
    const titleSels = this.sel().getSelectorListWithFallback('kuaishou', 'textboxes', 'tb_title', ['input[placeholder*="标题"]:visible', '[class*=title] input:visible']);
    const titleInput = await HumanActions.cdpFindElement(page, titleSels);
    if (titleInput) {
      await HumanActions.safeCDPType(page, metadata.title, titleInput.sel);
      logger.info('[快手] 标题已填写');
    } else {
      logger.warn({ selectors: titleSels }, '[快手] 标题输入框未找到，跳过标题填写');
    }

    // 2. 填写描述
    const descSels = this.sel().getSelectorListWithFallback('kuaishou', 'textboxes', 'tb_description', ['textarea[placeholder*="描述"]:visible', '[class*=desc] textarea:visible']);
    const descInput = await HumanActions.cdpFindElement(page, descSels);
    if (descInput) {
      await HumanActions.safeCDPType(page, metadata.description, descInput.sel);
      logger.info('[快手] 描述已填写');
    } else {
      logger.warn({ selectors: descSels }, '[快手] 描述输入框未找到，跳过描述填写');
    }

    // 3. 添加标签
    if (metadata.tags.length > 0) {
      await HumanActions.wait(page, 500, 1000);
      try {
        // 快手标签输入框选择器
        const tagSels = this.sel().getSelectorListWithFallback('kuaishou', 'textboxes', 'tb_tag', [
          'input[placeholder*="话题"]:visible',
          'input[placeholder*="标签"]:visible',
          '[class*=tag] input:visible',
          '[class*=topic] input:visible',
        ]);
        const tagInput = await HumanActions.cdpFindElement(page, tagSels);
        if (tagInput) {
          for (const tag of metadata.tags.slice(0, 5)) { // 最多5个标签
            const tagText = tag.startsWith('#') ? tag : `#${tag}`;
            await HumanActions.cdpClick(page, tagInput.sel);
            await HumanActions.wait(page, 200, 400);
            await HumanActions.safeCDPType(page, tagText, tagInput.sel);
            await HumanActions.wait(page, 300, 600);
            // 按回车确认标签
            await page.keyboard.press('Enter');
            await HumanActions.wait(page, 300, 500);
          }
          logger.info(`[快手] ${metadata.tags.length} 个标签已添加`);
        } else {
          // 回退：在描述框末尾添加标签
          if (descInput) {
            const tagText = ' ' + metadata.tags.map((t) => `#${t}`).join(' ');
            await HumanActions.safeCDPType(page, tagText, descInput.sel);
            logger.info(`[快手] ${metadata.tags.length} 个标签已添加到描述末尾`);
          } else {
            logger.warn({ count: metadata.tags.length, selectors: tagSels }, '[快手] 标签输入框未找到，跳过标签添加');
          }
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, '[快手] 标签添加失败');
      }
    }
  }

  // 提交发布继承 BasePublisher.submitPublish 默认实现 (走 selectors.json flowRules)
  // 默认 helper: submitPublishWithFlowRules → 滚动 → scope-scoped 找按钮 →
  //   多路 disabled 检测 → 点击 + URL 校验 → 弹窗处理 → 成功 toast/URL 命中
}
