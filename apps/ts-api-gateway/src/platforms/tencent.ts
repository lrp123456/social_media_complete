// @ts-api-gateway/platforms/tencent.ts - 腾讯视频号发布器
// 参考文档: docs/视频号发布DOM操作手册.md
// 登录模式参考: crawlers/tencentCrawler.ts handleLogin()

import { Page } from 'patchright';
import { HumanActions } from '@social-media/browser-core';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher:tencent');

// 首页 URL（固定常量）
const HOME_URL = 'https://channels.weixin.qq.com/platform';

export class TencentPublisher extends BasePublisher {
  readonly platform: PlatformName = 'tencent';
  readonly creatorUrl = HOME_URL;

  // ============================================================
  // 登录 — 参照 tencentCrawler.handleLogin()
  // ============================================================

  protected async doLogin(ctx: LoginContext): Promise<void> {
    const { page, accountId } = ctx;

    // 检查当前 URL — 不用 page.goto()，避免页面重载
    const currentUrl = page.url();

    if (currentUrl.includes('/platform') && !currentUrl.includes('/login')) {
      // 已在 platform 下，直接返回（不需要回首页，goToPublishPage 会通过菜单导航）
      logger.info('[腾讯视频号] 已登录（Cookie有效），跳过登录');
      return;
    }

    // 不在 platform 下，需要导航到首页（首次进入才用 goto）
    if (!currentUrl.includes('channels.weixin.qq.com')) {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
      await HumanActions.wait(page, 2000, 3000);
    }

    // 再次检查登录状态
    const url = page.url();
    if (url.includes('/platform') && !url.includes('/login')) {
      logger.info('[腾讯视频号] 已登录（Cookie有效），跳过登录');
      return;
    }

    // 被重定向到登录页，需要扫码
    logger.info('[腾讯视频号] Session 已过期，需要扫码登录');

    // 通过企微推送二维码给用户
    let wechatUserid: string | undefined;
    if (accountId) {
      try {
        const { botManager } = await import('../services/wechatBotService');
        const user = await prisma.user.findUnique({
          where: { id: Number(accountId) },
          select: { wechatUserid: true },
        });
        if (user?.wechatUserid) {
          wechatUserid = user.wechatUserid;
          await this.captureAndSendQR(page, Number(accountId), wechatUserid, botManager);
          logger.info('[腾讯视频号] 二维码已推送到企微');
        } else {
          logger.warn('[腾讯视频号] 用户未绑定企微，无法推送二维码');
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[腾讯视频号] 企微推送二维码失败');
      }
    }

    // 轮询等待扫码（最长 120 秒）
    const maxWait = 120_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const currentUrl = page.url();
      if (currentUrl.includes('/platform') && !currentUrl.includes('/login')) {
        logger.info('[腾讯视频号] 扫码登录成功');
        // 确保回到首页，为后续菜单导航做准备
        if (!currentUrl.endsWith('/platform') && !currentUrl.endsWith('/platform/')) {
          await this.navigateToHome(page);
        }
        return;
      }

      // 检查二维码是否过期
      const bodyText = await HumanActions.cdpGetBodyText(page);
      if (bodyText.includes('已过期')) {
        logger.info('[腾讯视频号] 二维码已过期，尝试刷新');
        await HumanActions.cdpClick(page, '.qrcode-refresh-btn', { timeout: 5000 }).catch(() => {});
        await HumanActions.wait(page, 2000, 3000);
        // 刷新后重新推送二维码
        if (wechatUserid) {
          try {
            const { botManager } = await import('../services/wechatBotService');
            await this.captureAndSendQR(page, Number(accountId), wechatUserid, botManager);
            logger.info('[腾讯视频号] 已刷新并重新推送二维码');
          } catch {}
        }
      }

      await HumanActions.wait(page, 2000, 3000);
    }

    // 超时 — 抛出错误阻止后续流程
    throw new Error('[腾讯视频号] 登录超时（120秒），请扫码后重试');
  }

  /**
   * 截取二维码并通过企微发送（参照 tencentCrawler.captureAndSendQR）
   */
  private async captureAndSendQR(
    page: Page,
    userId: number,
    wechatUserid: string,
    botManager: any,
  ): Promise<void> {
    try {
      const selectors = [
        'iframe[src*="login-for-iframe"]',
        'img[src*="qrcode"]',
        'img[src*="qr"]',
        'canvas',
        '[class*="qrcode"] img',
      ];

      let buf: Buffer | undefined;
      const PADDING = 40;

      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.waitForElementState('visible', { timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(500);
            const box = await el.boundingBox();
            if (box && box.width > 50 && box.height > 50) {
              const clip = {
                x: Math.max(0, box.x - PADDING),
                y: Math.max(0, box.y - PADDING),
                width: box.width + PADDING * 2,
                height: box.height + PADDING * 2,
              };
              buf = await page.screenshot({ type: 'png', clip });
              logger.info({ selector: sel, width: clip.width, height: clip.height }, '[腾讯视频号] 二维码截图已捕获');
              break;
            }
          }
        } catch {}
      }

      if (!buf) {
        buf = await page.screenshot({ type: 'png' });
        logger.info('[腾讯视频号] 回退: 全页截图');
      }

      await botManager.sendLoginAlert(wechatUserid, 'tencent', userId, buf).catch(() => {});
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[腾讯视频号] 截取/发送二维码失败');
      await botManager.sendLoginAlert(wechatUserid, 'tencent', userId).catch(() => {});
    }
  }

  // ============================================================
  // 导航到发布页 — 通过菜单点击，不用 page.goto()
  // 流程: 首页 → 内容管理(展开) → 视频(视频列表) → 发表视频(发布表单)
  //
  // DOM 结构关键点（用户提供）:
  // - 展开后有两份子菜单: 内联 ul.finder-ui-desktop-sub-menu + popup ul.finder-ui-desktop-menu__icon_sub_menu
  // - 展开状态: 父级 <a> 有 class "finder-ui-desktop-menu__sub-unfold"
  // - 内联子菜单展开: <ul class="finder-ui-desktop-sub-menu" style="">
  // - 内联子菜单折叠: <ul class="finder-ui-desktop-sub-menu" style="display: none;">
  // ============================================================

  protected async goToPublishPage(page: Page): Promise<void> {
    const currentUrl = page.url();

    // 确保在 platform 首页
    if (!currentUrl.includes('/platform')) {
      logger.info('[腾讯视频号] 不在 platform 页面，先回到首页');
      await this.navigateToHome(page);
    }

    // Step 1: 展开「内容管理」菜单
    logger.info('[腾讯视频号] 展开「内容管理」菜单');
    await this.expandMenu(page, '内容管理');

    // Step 2: 点击内联子菜单中的「视频」
    // 关键: 必须点击内联子菜单 (.finder-ui-desktop-sub-menu) 中的项，
    //        而不是 popup (.finder-ui-desktop-menu__popup_menu) 中的隐藏项
    logger.info('[腾讯视频号] 点击「视频」子菜单');
    const videoClicked = await this.clickInlineSubMenuItem(page, '视频');
    if (videoClicked) {
      logger.info('[腾讯视频号] 视频菜单已点击');
      // 等待页面导航完成（检查 URL 变化）
      await this.waitForUrlChange(page, '/post/list', 8_000);
    } else {
      logger.warn('[腾讯视频号] 视频菜单点击失败');
    }

    logger.info(`[腾讯视频号] 当前 URL: ${page.url()}`);

    // Step 3: 点击「发表视频」按钮进入发布表单
    logger.info('[腾讯视频号] 点击「发表视频」按钮');
    try {
      const publishPageBtn = page.locator('button').filter({ hasText: '发表视频' }).first();
      await publishPageBtn.waitFor({ state: 'visible', timeout: 8_000 });
      await publishPageBtn.scrollIntoViewIfNeeded();
      await publishPageBtn.click();
      logger.info('[腾讯视频号] 「发表视频」按钮已点击 (Playwright)');
    } catch {
      // 回退：CDP 方式
      logger.warn('[腾讯视频号] Playwright 点击失败，尝试 CDP');
      const clicked = await this.clickVisibleByText(page, '发表视频');
      if (!clicked) throw new Error('[腾讯视频号] 无法点击「发表视频」按钮');
    }

    // 等待 URL 变为 /post/create（发布表单页）
    await this.waitForUrlChange(page, '/post/create', 10_000);
    logger.info(`[腾讯视频号] 已进入发布页: ${page.url()}`);
  }

  // ============================================================
  // 菜单操作辅助方法 — 全部通过 HumanActions CDP 拟人操作
  // ============================================================

  /**
   * 展开侧边栏一级菜单（CDP 拟人点击）
   */
  private async expandMenu(page: Page, menuText: string): Promise<void> {
    // 检查是否已展开（只读 DOM 查询，无注入风险）
    const alreadyExpanded = await this.isMenuExpanded(page, menuText);
    if (alreadyExpanded) {
      logger.info(`[腾讯视频号] 「${menuText}」菜单已展开，跳过`);
      return;
    }

    // CDP 拟人点击 — 通过坐标模拟鼠标事件
    logger.info(`[腾讯视频号] 点击展开「${menuText}」菜单`);
    await HumanActions.cdpClickByText(page, menuText, { timeout: 8000 });
    await HumanActions.wait(page, 1000, 2000);
  }

  /**
   * 点击内联子菜单中的项（CDP 拟人点击）
   * cdpClickByText 通过 CDP performSearch 查找文本，
   * 对 display:none 的元素 getBoxModel 返回 0 尺寸会自动跳过
   */
  private async clickInlineSubMenuItem(page: Page, itemText: string): Promise<boolean> {
    logger.info(`[腾讯视频号] 点击子菜单「${itemText}」`);
    return HumanActions.cdpClickByText(page, itemText, { timeout: 8000 });
  }

  /**
   * 点击页面中可见的文本元素（CDP 拟人点击）
   */
  private async clickVisibleByText(page: Page, text: string): Promise<boolean> {
    return HumanActions.cdpClickByText(page, text, { timeout: 8000 });
  }

  /**
   * 点击侧边栏「首页」菜单项（CDP 拟人点击）
   */
  private async navigateToHome(page: Page): Promise<void> {
    logger.info('[腾讯视频号] 点击「首页」菜单');
    await HumanActions.cdpClickByText(page, '首页', { timeout: 5000 });
    await HumanActions.wait(page, 2000, 3000);
    await HumanActions.pageLoadBehavior(page);
  }

  /**
   * 等待 URL 包含指定字符串（高效轮询，不调用 cdpGetBodyText）
   */
  private async waitForUrlChange(page: Page, urlPattern: string, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (page.url().includes(urlPattern)) return true;
      await HumanActions.wait(page, 300, 500);
    }
    logger.warn(`[腾讯视频号] URL 等待超时 (${timeoutMs}ms)，未检测到 "${urlPattern}"`);
    return false;
  }

  /**
   * 检查菜单是否已展开（CDP 安全操作，无 JS 注入）
   */
  private async isMenuExpanded(page: Page, menuText: string): Promise<boolean> {
    // 通过 CDP 检查父级 <a> 是否有 sub-unfold class
    // selector: .finder-ui-desktop-menu__sub__wrp 内含菜单文字的 <a> 标签
    const hasUnfold = await HumanActions.cdpHasClass(
      page,
      `.finder-ui-desktop-menu__sub__wrp .finder-ui-desktop-menu__sub__link`,
      'finder-ui-desktop-menu__sub-unfold',
    );
    return hasUnfold;
  }

  // ============================================================
  // 上传视频 — 参照 DOM 手册 Step 6-7
  // ============================================================

  protected async uploadVideo(ctx: UploadContext): Promise<void> {
    const { page, videoPath } = ctx;

    // 使用 cdpSetInputFiles 通过 CDP 协议设置文件（可穿透 shadow DOM）
    const setInputSuccess = await HumanActions.cdpSetInputFiles(page, videoPath, {
      clickSelector: 'input[type="file"][accept*="video"]',
      clickBeforeUpload: false,
    });

    if (!setInputSuccess) {
      const fallbackSuccess = await HumanActions.cdpSetInputFiles(page, videoPath, {
        clickSelector: 'input[type="file"]',
        clickBeforeUpload: false,
      });
      if (!fallbackSuccess) {
        throw new Error('[腾讯视频号] 未找到文件上传 input[type="file"]');
      }
    }

    logger.info('[腾讯视频号] 视频文件已设置，等待上传+转码完成');

    // 等待上传完成：检测"正在处理"/"上传中"/"转码中" 等提示消失
    // 同时检查进度条是否消失、视频封面是否出现
    const startTime = Date.now();
    const timeout = 180_000; // 大文件上传+转码可能需要较长时间
    let uploadComplete = false;
    let processingDetected = false;

    while (Date.now() - startTime < timeout) {
      try {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        const isProcessing = bodyText.includes('正在处理')
          || bodyText.includes('上传中')
          || bodyText.includes('转码中')
          || bodyText.includes('上传进度')
          || bodyText.includes('%');

        if (isProcessing) {
          processingDetected = true;
          // 仍在处理中，继续等待
          await HumanActions.wait(page, 2000, 3000);
          continue;
        }

        // 处理中文字消失 + 已等待至少 5 秒 + 之前检测到过处理状态
        if (processingDetected && Date.now() - startTime > 5000) {
          uploadComplete = true;
          break;
        }

        // 未检测到处理状态但已等待 10 秒 — 可能是小文件秒传
        if (!processingDetected && Date.now() - startTime > 10_000) {
          uploadComplete = true;
          break;
        }
      } catch {}

      await HumanActions.wait(page, 2000, 3000);
    }

    if (!uploadComplete) {
      logger.warn('[腾讯视频号] 上传等待超时（180s），继续尝试填写元数据');
    }

    // 额外等待确保 DOM 更新完成
    await HumanActions.wait(page, 3000, 5000);
    logger.info('[腾讯视频号] 视频上传完成');
  }

  // ============================================================
  // 填写元数据 — 参照 DOM 手册 Step 8-9
  // ============================================================

  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    const { page, metadata } = ctx;

    // Step 8: 填写视频描述
    // DOM: <div contenteditable="" data-placeholder="添加描述" class="input-editor"></div>
    // wujie shadow DOM 内部，CSS 选择器无法穿透
    // 使用 Playwright locator（自动穿透 shadow DOM）+ fill()
    if (metadata.title) {
      try {
        // Playwright locator 自动穿透 shadow DOM
        const descLocator = page.locator('[data-placeholder="添加描述"]').first();
        await descLocator.waitFor({ state: 'visible', timeout: 10_000 });
        await descLocator.fill(metadata.title);
        logger.info('[腾讯视频号] 视频描述已填写 (Playwright fill)');
      } catch (e1) {
        // 回退：尝试 contenteditable 选择器
        try {
          const editorLocator = page.locator('div.input-editor[contenteditable]').first();
          await editorLocator.waitFor({ state: 'visible', timeout: 5_000 });
          await editorLocator.fill(metadata.title);
          logger.info('[腾讯视频号] 视频描述已填写 (input-editor fallback)');
        } catch (e2) {
          // 回退：CDP 方式 — 通过 performSearch 找到文本再点击
          logger.warn('[腾讯视频号] Playwright locator 失败，尝试 CDP 方式');
          const clicked = await HumanActions.cdpClickByText(page, '添加描述', { timeout: 5000 });
          if (clicked) {
            await HumanActions.wait(page, 500, 800);
            await HumanActions.safeCDPType(page, metadata.title);
            logger.info('[腾讯视频号] 视频描述已填写 (CDP fallback)');
          } else {
            logger.warn('[腾讯视频号] 未找到视频描述输入框（所有方式均失败）');
          }
        }
      }
    }

    // Step 9: 填写话题标签（如果有）
    const tags = (metadata as any).tags || [];
    if (tags.length > 0) {
      try {
        // 话题输入通常在描述框下方，格式为 #话题
        for (const tag of tags.slice(0, 5)) { // 最多5个话题
          const tagText = tag.startsWith('#') ? tag : `#${tag}`;
          // 在描述框末尾输入话题
          const descLocator = page.locator('[data-placeholder="添加描述"]').first();
          await descLocator.click();
          await page.keyboard.press('End');
          await HumanActions.wait(page, 200, 400);
          await HumanActions.safeCDPType(page, ` ${tagText}`);
          await HumanActions.wait(page, 500, 1000);

          // 检查是否有话题下拉建议，选择第一个
          const suggestionClicked = await HumanActions.cdpClickByText(page, tag.slice(0, 6), { timeout: 2000 }).catch(() => false);
          if (!suggestionClicked) {
            // 没有建议，按空格确认
            await page.keyboard.press('Space');
          }
          await HumanActions.wait(page, 300, 600);
        }
        logger.info(`[腾讯视频号] 话题标签已填写: ${tags.join(', ')}`);
      } catch (e) {
        logger.warn({ err: (e as Error).message }, '[腾讯视频号] 话题标签填写失败');
      }
    }

    // Step 10: 填写短标题（可选）
    const shortTitle = (metadata as any).shortTitle;
    if (shortTitle) {
      try {
        const shortTitleLocator = page.locator('input[placeholder*="短标题"]').first();
        await shortTitleLocator.waitFor({ state: 'visible', timeout: 3_000 });
        await shortTitleLocator.fill(shortTitle);
        logger.info('[腾讯视频号] 短标题已填写');
      } catch {
        logger.warn('[腾讯视频号] 短标题输入框未找到');
      }
    }

    // 等待表单更新
    await HumanActions.wait(page, 1000, 2000);
    logger.info('[腾讯视频号] 元数据已填写');
  }

  // ============================================================
  // 提交发布 — 参照 DOM 手册 Step 12-13
  // ============================================================

  protected async submitPublish(page: Page): Promise<string> {
    // Step 12: 点击「发表」按钮
    // DOM: <button type="button" class="weui-desktop-btn weui-desktop-btn_primary">发表</button>
    // 注意: "发表视频" 是列表页按钮，"发表" 是表单提交按钮，文字不同
    // 使用 Playwright locator 自动穿透 shadow DOM + 自动滚动到可视区域

    const maxRetries = 10;
    let publishClicked = false;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // 检查风控
      if (page.url().includes('/login')) {
        throw new Error('[腾讯视频号] 提交前检测到重定向到登录页');
      }

      try {
        // Playwright locator: 找到精确匹配 "发表" 的 button（不是 "发表视频"）
        const publishBtn = page.locator('button.weui-desktop-btn_primary').filter({ hasText: /^发表$/ }).first();

        // 等待按钮可见（自动滚动）
        await publishBtn.waitFor({ state: 'visible', timeout: 15_000 });

        // 等待按钮变为可点击状态（非 disabled）
        // 视频上传/转码未完成时按钮是灰色的（disabled）
        const btnEnabledTimeout = 120_000; // 最长等 2 分钟
        const btnStartTime = Date.now();
        let btnEnabled = false;

        while (Date.now() - btnStartTime < btnEnabledTimeout) {
          const isDisabled = await publishBtn.isDisabled().catch(() => true);
          if (!isDisabled) {
            btnEnabled = true;
            break;
          }
          // 按钮仍 disabled，等待上传/转码完成
          const elapsed = Math.round((Date.now() - btnStartTime) / 1000);
          logger.info(`[腾讯视频号] 发布按钮仍为灰色(disabled)，等待上传完成... (${elapsed}s)`);
          await HumanActions.wait(page, 3000, 5000);
        }

        if (!btnEnabled) {
          logger.warn('[腾讯视频号] 发布按钮等待超时仍为灰色，尝试强制点击');
        }

        // 滚动到按钮确保在视口中央
        await publishBtn.scrollIntoViewIfNeeded();
        await HumanActions.wait(page, 500, 800);

        // 点击
        await publishBtn.click();
        logger.info(`[腾讯视频号] 发布按钮已点击 (${attempt + 1}/${maxRetries}, Playwright click)`);
        publishClicked = true;
      } catch (e) {
        // 回退：CDP 方式
        logger.warn(`[腾讯视频号] Playwright 点击失败，尝试 CDP 回退 (${attempt + 1}/${maxRetries})`);
        const clicked = await HumanActions.cdpClickByText(page, '发表', { timeout: 5000 });
        if (clicked) {
          logger.info(`[腾讯视频号] 发布按钮已点击 (${attempt + 1}/${maxRetries}, CDP fallback)`);
          publishClicked = true;
        } else {
          logger.warn(`[腾讯视频号] 发布按钮点击失败 (${attempt + 1}/${maxRetries})`);
          await HumanActions.wait(page, 2000, 4000);
          continue;
        }
      }

      // 等待点击后反应
      await HumanActions.wait(page, 2000, 3000);

      // 检查是否有弹窗需要处理（如"声明"弹窗）
      const bodyTextAfter = await HumanActions.cdpGetBodyText(page);
      if (bodyTextAfter.includes('未添加自主声明') || bodyTextAfter.includes('自主声明')) {
        logger.info('[腾讯视频号] 检测到声明弹窗，尝试处理');
        const confirmClicked = await HumanActions.cdpClickByText(page, '确认', { timeout: 5000 })
          || await HumanActions.cdpClickByText(page, '跳过', { timeout: 3000 })
          || await HumanActions.cdpClickByText(page, '继续', { timeout: 3000 });
        if (confirmClicked) {
          logger.info('[腾讯视频号] 声明弹窗已处理');
          await HumanActions.wait(page, 1000, 2000);
          // 弹窗处理后需要再次点击发表
          try {
            const btn2 = page.locator('button.weui-desktop-btn_primary').filter({ hasText: /^发表$/ }).first();
            await btn2.scrollIntoViewIfNeeded();
            await btn2.click();
            logger.info('[腾讯视频号] 弹窗后再次点击发表 (Playwright)');
          } catch {
            await HumanActions.cdpClickByText(page, '发表', { timeout: 8000 });
          }
        }
      }

      break;
    }

    if (!publishClicked) {
      throw new Error(`[腾讯视频号] 发布按钮点击失败（已重试 ${maxRetries} 次）`);
    }

    // Step 13: 验证发布结果
    const finalUrl = await this.waitForPublishResult(page);
    return finalUrl;
  }

  // ============================================================
  // 等待发布结果 — 参照 DOM 手册 Step 13
  // ============================================================

  private async waitForPublishResult(page: Page): Promise<string> {
    const waitMs = 20_000;
    const startTime = Date.now();

    while (Date.now() - startTime < waitMs) {
      const currentUrl = page.url();

      // 成功标志 1: URL 跳转回视频列表页（DOM 手册确认）
      if (currentUrl.includes('/post/list') && !currentUrl.includes('/post/create')) {
        logger.info(`[腾讯视频号] ✅ 发布成功（URL 已跳转到列表页: ${currentUrl}）`);
        return currentUrl;
      }

      // 成功标志 2: 页面出现成功提示
      const bodyText = await HumanActions.cdpGetBodyText(page);
      if (bodyText.includes('发布成功') || bodyText.includes('已发布')) {
        logger.info('[腾讯视频号] ✅ 发布成功（检测到成功提示文字）');
        return page.url();
      }

      // 失败标志: 被重定向到登录页
      if (currentUrl.includes('/login')) {
        throw new Error('[腾讯视频号] 发布后被重定向到登录页，Session 可能已过期');
      }

      await HumanActions.wait(page, 1000, 1500);
    }

    const finalUrl = page.url();
    logger.warn(`[腾讯视频号] ⚠️ 提交流程完成，但 ${waitMs}ms 内未检测到成功标志 (URL: ${finalUrl})`);
    return finalUrl;
  }

  // ============================================================
  // 辅助方法已移除 — wujie 闭合 shadow DOM 无法用 frame.$() 穿透
  // 所有元素操作改用 HumanActions.cdp* 方法（通过 CDP 协议穿透）
  // ============================================================
}
