// @ts-api-gateway/platforms/douyin.ts - 抖音发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/douyin.py (579行)
// 所有页面交互必须通过 HumanActions（防风控）
// 所有选择器通过 SelectorReader 读取（后台可动态修改）

import { Page } from 'patchright';
import { HumanActions, SelectorReader, DEFAULT_SELECTOR_CONFIG } from '@social-media/browser-core';
import { getSelectorReader } from '../lib/selectorStore';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:douyin');

// 发布页 URL（固定，不通过选择器管理）
const PUBLISH_URL = 'https://creator.douyin.com/creator-micro/content/upload';

export class DouyinPublisher extends BasePublisher {
  readonly platform: PlatformName = 'douyin';
  readonly creatorUrl = 'https://creator.douyin.com';

  private sel(): SelectorReader { return getSelectorReader(); }

  // ============================================================
  // 登录 — QR 扫码检测 + Cookie 已登录跳过
  // ============================================================

  protected async doLogin(ctx: LoginContext): Promise<void> {
    const { page } = ctx;

    await page.goto(this.creatorUrl, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 4000);

    const currentUrl = page.url();
    if (currentUrl.includes('creator.douyin.com/creator-micro')) {
      logger.info('[抖音] 已登录状态（Cookie有效），跳过登录');
      return;
    }

    await HumanActions.cdpClick(page, this.sel().getSelectorListWithFallback('douyin', 'buttons', 'btn_qr_login', ['[class*="qrcode"]:visible', '[class*="qr-code"]:visible', 'img[src*=qr]'])[0], { timeout: 15000 });
    logger.info('[抖音] QR 码已显示，等待扫码');

    const maxWait = 120_000;
    let elapsed = 0;
    while (elapsed < maxWait) {
      await HumanActions.wait(page, 3000, 4000);
      elapsed += 3000;
      if (page.url().includes('creator.douyin.com/creator-micro')) break;
      const smsInput = await HumanActions.cdpFindElement(page, this.sel().getSelectorListWithFallback('douyin', 'textboxes', 'tb_sms_code', ['input[placeholder*="验证码"]:visible', 'input[placeholder*="code"]']));
      if (smsInput) {
        logger.info('[抖音] 检测到 SMS 验证码弹窗，等待手动输入');
        await HumanActions.wait(page, 15000, 30000);
      }
    }
    logger.info('[抖音] 登录完成');
  }

  // ============================================================
  // 导航到发布页
  // ============================================================

  protected async goToPublishPage(page: Page): Promise<void> {
    // 优先点击侧边栏"高清发布"按钮（自然人操作，防风控）
    const publishBtns = this.sel().getSelectorListWithFallback('douyin', 'menus', 'menu_publish_hd', [
      '.douyin-creator-master-button:visible',
      'getByText("高清发布", exact=True)',
    ]);
    let clicked = false;
    for (const btn of publishBtns) {
      const success = await HumanActions.cdpClick(page, btn, { timeout: 8000 });
      if (success) {
        clicked = true;
        logger.info('[抖音] 通过点击"高清发布"按钮进入发布页');
        break;
      }
    }

    if (!clicked) {
      // 回退: 点击失败则直接跳转 URL（发布页 URL 是稳定常量，仅作保险）
      logger.warn('[抖音] 点击"高清发布"按钮失败，回退到 page.goto');
      await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded' });
    }

    await HumanActions.wait(page, 2000, 4000);

    // 从配置读取上传容器选择器
    const containerSels = this.sel().getSelectorListWithFallback('douyin', 'regions', 'region_upload_zone', ['div.container-drag-VAfIfu']);
    const containerSel = containerSels[0];
    logger.info(`[抖音] 上传容器选择器: ${containerSels.join(' | ')}`);

    const ready = await HumanActions.cdpWaitForSelector(page, containerSel, {
      state: 'visible', timeout: 15000,
    });
    if (ready) {
      logger.info(`[抖音] 发布页已就绪 (${containerSel})`);
    } else {
      logger.warn(`[抖音] 上传容器未在 15s 内出现 (尝试了 ${containerSel})`);
    }
  }

  // ============================================================
  // 上传视频
  // ============================================================

  protected async uploadVideo(ctx: UploadContext): Promise<void> {
    const { page, videoPath } = ctx;

    const uploadSelectors = this.sel().getSelectorListWithFallback('douyin', 'regions', 'region_upload_zone', ['div.container-drag-VAfIfu']);

    const uploaded = await HumanActions.cdpSetInputFiles(page, videoPath, {
      containerSelector: uploadSelectors[0],
      inputSelector: "input[type='file']",
      clickBeforeUpload: true,
      clickSelector: uploadSelectors[0],
      fallbackSelectors: uploadSelectors.slice(1),
    });

    if (!uploaded) throw new Error('[抖音] cdpSetInputFiles 所有回退均失败');
    logger.info(`[抖音] 视频已注入上传容器，等待上传完成 (container=${uploadSelectors[0]})`);

    await HumanActions.wait(page, 5000, 8000);
    const progressSels = this.sel().getSelectorListWithFallback('douyin', 'regions', 'region_upload_progress', ['[class*="progress"]']);
    const done = await HumanActions.cdpWaitForSelector(page, progressSels[0], {
      state: 'hidden', timeout: 300_000, pollInterval: 2000,
    });
    logger.info(done ? '[抖音] 上传完成（进度条消失）' : `[抖音] 上传等待结束 (progress=${progressSels[0]})`);
  }

  // ============================================================
  // 填写元数据 — 全部通过 SelectorReader 读取
  // ============================================================

  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    const { page, metadata } = ctx;
    const sel = this.sel();

    // 1. 标题
    const titleSelectors = sel.getSelectorListWithFallback('douyin', 'textboxes', 'tb_title', ['input[placeholder*="填写作品标题"]:visible', 'input[placeholder*="填写作品标题"]', 'input[type="text"]', 'input[placeholder*="标题"]']);
    if (titleSelectors.length === 0) {
      logger.warn('[抖音] 标题选择器列表为空 (配置缺失且无硬编码回退)');
    } else {
      const titleContainer = await HumanActions.cdpFindElement(page, titleSelectors);
      if (titleContainer) {
        const title = (metadata.title || '').slice(0, 30);
        await HumanActions.safeCDPType(page, title, titleContainer.sel);
        logger.info(`[抖音] 标题已填写: ${title} (via ${titleContainer.sel})`);
      } else {
        logger.warn(`[抖音] 标题输入框未找到 (尝试了 ${titleSelectors.length} 个选择器: ${titleSelectors.join(', ')})`);
      }
    }

    // 2. 描述
    const descSelectors = sel.getSelectorListWithFallback('douyin', 'textboxes', 'tb_description', ['div[data-placeholder*="作品简介"]:visible', 'div[data-placeholder*="作品简介"]', 'div[contenteditable="true"][data-placeholder]', 'div[contenteditable="true"]', '.zone-container[contenteditable="true"]', '[class*="desc"] [contenteditable="true"]']);
    if (descSelectors.length === 0) {
      logger.warn('[抖音] 描述选择器列表为空 (配置缺失且无硬编码回退)');
    } else {
      const descContainer = await HumanActions.cdpFindElement(page, descSelectors);
      if (descContainer) {
        const desc = (metadata.description || '').slice(0, 1000);
        await HumanActions.safeCDPType(page, desc, descContainer.sel);
        logger.info(`[抖音] 描述已填写 (via ${descContainer.sel})`);
      } else {
        logger.warn(`[抖音] 描述输入框未找到 (尝试了 ${descSelectors.length} 个选择器: ${descSelectors.join(', ')})`);
      }
    }

    // 3. 标签 — 追加到描述末尾
    if (metadata.tags && metadata.tags.length > 0) {
      try {
        const tagText = ' ' + metadata.tags.map((t) => `#${t}`).join(' ');
        const descSel = descSelectors[0];
        await HumanActions.safeCDPType(page, tagText, descSel);
        logger.info(`[抖音] ${metadata.tags.length} 个标签已添加`);
      } catch (err: any) {
        logger.warn(`[抖音] 标签添加失败: ${err.message}`);
      }
    }
  }

  // ============================================================
  // 提交发布 — 所有可调参数 (scope / disabled 检测方式 / URL 模式 / 重试次数)
  // 都从 selectors.json 的 flowRules 读取, 不硬编码
  // ============================================================

  protected async submitPublish(page: Page): Promise<string> {
    const sel = this.sel();

    // 1. 加载流程规则 (缺省时回退到合理默认 — 但缺省会被日志告警)
    const rules = sel.getFlowRulesWithFallback('douyin', {
      scopeSelectors: ['form'],
      disabledCheckMethods: ['dom-property', 'attr-disabled', 'aria-disabled', 'pseudo-disabled', 'class-disabled', 'cursor', 'opacity'],
      visibilityCheckMethods: ['offset-size', 'rect', 'computed-style', 'viewport'],
      viewportInsetPx: 50,
      successUrlPatterns: ['/content/manage'],
      navRedirectUrlPatterns: ['/user/self'],
      filterTag: 'BUTTON',
      filterText: '发布',
      publishWaitMs: 15000,
      publishMaxRetries: 10,
      disabledRetryDelayMs: [1500, 4000],
      notFoundBackoffMs: [800, 1500],
      scrollAmountPx: 600,
      postClickStabilizeMs: [1000, 2000],
      declareModalMethod: 'both',
    });
    logger.info({ rules: { ...rules, /* 截断长数组日志 */ scopeSelectorsCount: rules.scopeSelectors?.length, disabledCheckMethodsCount: rules.disabledCheckMethods?.length } }, '[抖音] 流程规则已加载');

    // 2. 滚动到发布区底部 (按钮在 form 提交栏, 通常在视口下方)
    const publishRegion = sel.getSelectorListWithFallback('douyin', 'regions', 'region_publish_area', ['body']);
    await HumanActions.cdpSmartScroll(page, publishRegion, rules.scrollAmountPx ?? 600, 'down');
    await HumanActions.wait(page, 500, 1000);

    // 3. 发布按钮候选 — 从 selectors.json 读, primary + fallbacks
    const publishBtnSelectors = sel.getSelectorListWithFallback('douyin', 'buttons', 'btn_publish_submit', [
      'button.button-dhlUZE',
      'button[type="submit"]',
    ]);
    logger.info(`[抖音] 发布按钮选择器列表 (${publishBtnSelectors.length}): ${publishBtnSelectors.join(' | ')}`);

    const scopeSelectors = rules.scopeSelectors ?? ['form'];
    const filterTag = rules.filterTag ?? 'BUTTON';
    const filterText = rules.filterText;  // undefined = 不约束文本
    const maxRetries = rules.publishMaxRetries ?? 10;
    const notFoundBackoff = rules.notFoundBackoffMs ?? [800, 1500];
    const disabledBackoff = rules.disabledRetryDelayMs ?? [1500, 4000];
    const postClickWait = rules.postClickStabilizeMs ?? [1000, 2000];

    let publishClicked = false;
    let lastClickResult: { attempt: number; sel: string; urlBefore: string; urlAfter: string } | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // 3a. 在父级 scope 内找发布按钮 (filterTag 自动排除 <a> 链接)
      let btn: { x: number; y: number; w: number; h: number; sel: string; tag: string } | null = null;
      for (const scopeSel of scopeSelectors) {
        btn = await HumanActions.cdpFindElementScoped(page, scopeSel, publishBtnSelectors, { filterTag, filterText });
        if (btn) {
          logger.info(`[抖音] 发布按钮定位于 ${scopeSel} (via ${btn.sel})`);
          break;
        }
      }
      // 3b. scope 都找不到时, 退回到全页搜索 (但仍 filterTag=约束)
      if (!btn) {
        btn = await HumanActions.cdpFindElement(page, publishBtnSelectors);
      }
      if (!btn) {
        if (attempt === 0 || attempt === Math.floor(maxRetries / 2) || attempt === maxRetries - 1) {
          logger.warn(`[抖音] 发布按钮查找失败 (${attempt + 1}/${maxRetries}, scope=${scopeSelectors.length} 个) — 等待后重试`);
        }
        await HumanActions.wait(page, notFoundBackoff[0], notFoundBackoff[1]);
        continue;
      }

      // 3c. 多方法检测 disabled (按 rules.disabledCheckMethods 配置)
      const isDisabled = await HumanActions.cdpIsElementDisabled(page, btn.sel, rules.disabledCheckMethods);
      if (isDisabled) {
        logger.debug(`[抖音] 发布按钮 disabled (${attempt + 1}/${maxRetries}) — 等待 ${disabledBackoff[0]}-${disabledBackoff[1]}ms 后重试`);
        await HumanActions.wait(page, disabledBackoff[0], disabledBackoff[1]);
        continue;
      }

      // 3d. 记录点击前 URL, 点击
      const urlBefore = page.url();
      await HumanActions.cdpClick(page, btn.sel);
      await HumanActions.wait(page, postClickWait[0], postClickWait[1]);
      const urlAfter = page.url();
      lastClickResult = { attempt: attempt + 1, sel: btn.sel, urlBefore, urlAfter };

      // 3e. URL 校验: 点击后跳到 navRedirectUrlPatterns 中任一, 说明点到导航链接
      const navPatterns = rules.navRedirectUrlPatterns ?? ['/user/self'];
      const navRedirected = navPatterns.some(
        (pat) => urlAfter.includes(pat) && !urlBefore.includes(pat),
      );
      if (navRedirected) {
        logger.warn(`[抖音] 点击后 URL 异常跳转: ${urlBefore} → ${urlAfter} (via ${btn.sel}, 命中导航模式) — 重新打开发布页`);
        // 紧急恢复: 点击误触导航链接后强制回到发布页（唯一例外允许 goto）
        await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded' });
        await HumanActions.wait(page, 2000, 3000);
        logger.info('[抖音] 已返回发布页, 准备重填元数据');
        throw new Error('NEEDS_REFILL_BEFORE_PUBLISH');
      }

      logger.info(`[抖音] 发布按钮已点击 (${attempt + 1}/${maxRetries}, via ${btn.sel}, url: ${urlBefore} → ${urlAfter})`);
      publishClicked = true;

      // 4. 处理"未添加自主声明"弹窗 — 用 rules.declareModalMethod 决定检测方式
      if (rules.declareModalMethod !== undefined) {
        const declaredHandled = await this.handleDeclareModal(
          page, sel, this.platform, 'region_declare_modal', 'btn_declare_confirm', rules.declareModalMethod,
        );
        if (declaredHandled) {
          // 弹窗确认后需要再次点击发布按钮
          for (let r2 = 0; r2 < 3; r2++) {
            const btn2 = await HumanActions.cdpFindElement(page, publishBtnSelectors);
            if (btn2) {
              await HumanActions.cdpClick(page, btn2.sel);
              logger.info(`[抖音] 弹窗后再次点击发布 (${r2 + 1}/3, via ${btn2.sel})`);
              break;
            }
            await HumanActions.wait(page, 500, 1000);
          }
        }
      }
      break;
    }

    if (!publishClicked) {
      throw new Error(`[抖音] 发布按钮点击失败（已重试 ${maxRetries} 次, 最后尝试: ${lastClickResult?.sel ?? 'N/A'}）`);
    }

    // 5. 等待发布结果 — 成功 toast (用 cdpFindElement) + URL 模式命中
    let success = false;
    const successSelectors = sel.getSelectorListWithFallback('douyin', 'regions', 'region_success_toast', [
      '[class*="toast"]:visible',
      '[class*="success"]:visible',
      'text=发布成功',
      'text=上传成功',
    ]);
    const successPatterns = rules.successUrlPatterns ?? ['/content/manage'];
    const waitMs = rules.publishWaitMs ?? 15000;
    const pollInterval = 1000;
    const polls = Math.ceil(waitMs / pollInterval);
    for (let i = 0; i < polls; i++) {
      const toast = await HumanActions.cdpFindElement(page, successSelectors);
      if (toast) {
        success = true;
        break;
      }
      const currentUrl = page.url();
      if (successPatterns.some((pat) => currentUrl.includes(pat) && !currentUrl.includes('/upload'))) {
        success = true;
        logger.info(`[抖音] URL 已跳转至管理页: ${currentUrl} (命中模式: ${successPatterns.join('|')})`);
        break;
      }
      await HumanActions.wait(page, 800, 1200);
    }

    if (success) {
      logger.info('[抖音] ✅ 发布成功');
    } else {
      const finalUrl = page.url();
      logger.warn(`[抖音] ⚠️ 提交流程完成, 但 ${waitMs}ms 内未检测到成功标志 (URL: ${finalUrl})`);
    }

    return page.url();
  }

  // 注: handleDeclareModal 沿用 BasePublisher 默认实现 (见 @/platforms/BasePublisher.ts)
  // 默认已能正确处理抖音"未添加自主声明"弹窗, 无需平台特化
}
