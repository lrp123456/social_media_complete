// @ts-api-gateway/platforms/BasePublisher.ts
// 多平台发布器抽象基类
// 严格遵守 project_rules.md 的反检测规则，所有浏览器操作通过 HumanActions
// CDP 模式：通过 chromium.connectOverCDP 连接已有指纹浏览器窗口

import { Browser, Page } from 'patchright';
import { HumanActions, BrowserManager, SelectorReader } from '@social-media/browser-core';
import type { PublishFlowRules } from '@social-media/browser-core';
import { uploadToOSS, ossKey } from '../lib/oss';
import { createLogger } from '../lib/logger';
import { getBrowserManager } from '../lib/browserManager';
import { getSelectorReader } from '../lib/selectorStore';
import type {
  PublishTask,
  PublishResult,
  PublisherState,
  LoginContext,
  UploadContext,
} from './types';
import { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publisher');

/**
 * BasePublisher - 所有平台发布器的抽象基类
 * 模板方法模式：publish() 编排流程，子类实现平台特有逻辑
 */
export abstract class BasePublisher {
  abstract readonly platform: PlatformName;
  abstract readonly creatorUrl: string;
  /**
   * 重新打开发布页时使用的 URL。默认 `${creatorUrl}/publish`。
   * 当平台发布页 URL 不符此模式 (如快手 cp.kuaishou.com/article/publish/video) 时由子类覆盖。
   */
  protected readonly publishUrl?: string;

  protected state: PublisherState = 'idle';
  protected browser: Browser | null = null;
  protected page: Page | null = null;

  // ============================================================
  // 抽象方法 - 子类必须实现
  // ============================================================

  /** 平台登录：QR扫码 / SMS / Cookie恢复 */
  protected abstract doLogin(ctx: LoginContext): Promise<void>;

  /** 导航到发布页面 */
  protected abstract goToPublishPage(page: Page): Promise<void>;

  /** 上传视频文件 */
  protected abstract uploadVideo(ctx: UploadContext): Promise<void>;

  /** 填写元数据（标题、描述、标签等） */
  protected abstract fillMetadata(ctx: UploadContext): Promise<void>;

  /**
   * 提交发布 — 默认实现已统一走 selectors.json 的 flowRules + btn_publish_submit 等条目。
   * 子类可覆盖此方法实现平台特有流程 (例如: 多步骤确认、特殊弹窗)。
   * 若子类不覆盖, 会用 submitPublishWithFlowRules 的标准实现。
   */
  protected async submitPublish(page: Page): Promise<string> {
    return this.submitPublishWithFlowRules(page, {
      platform: this.platform,
      publishBtnName: 'btn_publish_submit',
      successToastName: 'region_success_toast',
    });
  }

  // ============================================================
  // 模板方法 - 发布生命周期
  // ============================================================

  /**
   * 发布主流程（模板方法）
   *
   * 流程：
   * 1. 获取窗口互斥锁 (Redlock) — 可通过 skipLock=true 跳过（unifiedQueue 已获取）
   * 2. 下载 OSS 视频到本地临时目录
   * 3. 启动/连接指纹浏览器
   * 4. 平台登录
   * 5. 导航到发布页
   * 6. 上传视频
   * 7. 填写元数据
   * 8. 提交发布
   * 9. 清理资源 + 释放锁
   *
   * @param skipLock 跳过锁获取（调用方已持有锁时使用）
   */
  async publish(task: PublishTask, skipLock: boolean = false): Promise<PublishResult> {
    const startTime = Date.now();
    const localVideoPath = `/tmp/publish_${task.taskId}_${task.video.filename}`;

    try {
      this.state = 'idle';

      // Step 1: 获取窗口互斥锁（防止并发操控同一指纹浏览器）
      // 如果调用方（unifiedQueue）已持有锁，跳过
      if (!skipLock) {
        throw new Error('BasePublisher must be called with skipLock=true from unifiedQueue. Direct lock management is not supported.');
      }

      // Step 2: 初始化浏览器
      await this.initBrowser(task);

      // Step 3: 登录
      this.state = 'logging_in';
      await this.doLogin({
        page: this.page!,
        credentials: task.credentials,
        windowId: task.windowId,
        accountId: task.accountId,
      });

      // 登录后验证：如果页面仍在登录页，说明登录失败
      const postLoginUrl = this.page!.url();
      if (postLoginUrl.includes('/login')) {
        throw new Error(`[${task.platform}] 登录验证失败：页面仍在登录页 (${postLoginUrl})`);
      }
      logger.info(`[${task.platform}] 登录完成`);

      // Step 4: 导航到发布页
      await this.goToPublishPage(this.page!);
      logger.info(`[${task.platform}] 已导航到发布页`);

      // Step 5: 下载 OSS 视频到本地临时目录
      logger.info(`[${task.platform}] 下载视频: ${task.video.ossUrl} → ${localVideoPath}`);
      const { writeFile } = await import('fs/promises');
      const response = await fetch(task.video.ossUrl);
      if (!response.ok) throw new Error(`OSS 下载失败: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(localVideoPath, buffer);
      logger.info(`[${task.platform}] 视频已下载 (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

      // Step 6: 上传视频
      this.state = 'uploading';
      const uploadCtx: UploadContext = {
        page: this.page!,
        videoPath: localVideoPath,
        metadata: task.metadata,
        videoPayload: task.video,
      };
      await this.uploadVideo(uploadCtx);
      logger.info(`[${task.platform}] 视频上传完成`);

      // Step 7: 填写元数据
      await this.fillMetadata(uploadCtx);
      logger.info(`[${task.platform}] 元数据填写完成`);

      // Step 8: 提交发布
      this.state = 'publishing';
      const videoUrl = await this.submitPublish(this.page!);
      logger.info(`[${task.platform}] 发布提交完成: ${videoUrl}`);

      this.state = 'completed';

      return {
        success: true,
        taskId: task.taskId,
        platform: task.platform,
        videoUrl,
        duration: Date.now() - startTime,
      };
    } catch (err) {
      this.state = 'error';
      const errorMsg = (err as Error).message;
      logger.error(`[${task.platform}] 发布失败: ${errorMsg}`);
      return {
        success: false,
        taskId: task.taskId,
        platform: task.platform,
        error: errorMsg,
        duration: Date.now() - startTime,
      };
    } finally {
      // 清理临时视频文件
      const { unlink } = await import('fs/promises');
      await unlink(localVideoPath).catch(() => {});
      await this.cleanup();
    }
  }

  // ============================================================
  // 通用方法
  // ============================================================

  /** 获取发布器状态 */
  getState(): PublisherState {
    return this.state;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 初始化浏览器 — 通过 CDP 连接已有指纹浏览器窗口（不启动新 Chrome） */
  protected async initBrowser(task: PublishTask): Promise<void> {
    const bm = getBrowserManager();
    // 工作区间 ID 非必需（RoxyBrowser 内部通过 dirId 定位窗口）
    const { browser, page } = await bm.connect(task.windowId, '', task.platform as PlatformName);
    this.browser = browser;
    this.page = page;

    // 指纹浏览器窗口已有 viewport，只需模拟人类行为延迟
    await HumanActions.wait(this.page, 500, 1500);
  }

  /** 清理资源 — 只释放锁，不关闭浏览器（窗口由指纹浏览器管理） */
  protected async cleanup(): Promise<void> {
    // CDP 模式下不关闭浏览器 — 窗口属于 RoxyBrowser，保持打开供复用
    // 锁的释放由调用方（unifiedQueue）在 finally 中统一处理
    this.browser = null;
    this.page = null;
    this.state = 'idle';
  }

  // ============================================================
  // 通用发布提交 (v2.1+) — 加载 selectors.json 的 flowRules, 走
  //   1. 滚动到发布区底部
  //   2. 在父级 scope 内找发布按钮 (filterTag + filterText 排除 <a> 链接)
  //   3. 多路 disabled 检测 (按 rules.disabledCheckMethods)
  //   4. 点击 + URL 跳转校验 (按 rules.navRedirectUrlPatterns)
  //   5. 处理弹窗 (按 rules.declareModalMethod, 可选)
  //   6. 等待成功 (toast + URL 模式命中)
  // ============================================================
  protected async submitPublishWithFlowRules(
    page: Page,
    args: {
      platform: PlatformName;
      publishBtnName: string;
      successToastName: string;
      declareModalName?: string;
      declareConfirmName?: string;
    },
  ): Promise<string> {
    const sel = getSelectorReader();

    // 1. 加载流程规则 (缺省时回退到合理默认)
    const rules = sel.getFlowRulesWithFallback(args.platform, {
      scopeSelectors: ['form'],
      disabledCheckMethods: ['dom-property', 'attr-disabled', 'aria-disabled', 'pseudo-disabled', 'class-disabled', 'cursor', 'opacity'],
      visibilityCheckMethods: ['offset-size', 'rect', 'computed-style', 'viewport'],
      viewportInsetPx: 50,
      successUrlPatterns: ['/manage'],
      navRedirectUrlPatterns: ['/user/profile', '/user/self'],
      filterTag: 'BUTTON',
      publishWaitMs: 15000,
      publishMaxRetries: 10,
      disabledRetryDelayMs: [1500, 4000],
      notFoundBackoffMs: [800, 1500],
      scrollAmountPx: 600,
      postClickStabilizeMs: [1000, 2000],
      declareModalMethod: 'selector',
    });
    const platLabel = `[${args.platform}]`;

    // 2. 滚动到发布区底部 (按钮在 form 提交栏, 通常在视口下方)
    const publishRegion = sel.getSelectorListWithFallback(args.platform, 'regions', 'region_publish_area', ['body']);
    await HumanActions.cdpSmartScroll(page, publishRegion, rules.scrollAmountPx ?? 600, 'down');
    await HumanActions.wait(page, 500, 1000);

    // 3. 发布按钮候选 — 从 selectors.json 读
    const publishBtnSelectors = sel.getSelectorListWithFallback(args.platform, 'buttons', args.publishBtnName, [
      'button:has-text("发布")',
      'button[type="submit"]',
    ]);
    logger.info(`${platLabel} 发布按钮选择器 (${publishBtnSelectors.length}): ${publishBtnSelectors.join(' | ')}`);

    const scopeSelectors = rules.scopeSelectors ?? ['form'];
    const filterTag = rules.filterTag ?? 'BUTTON';
    const filterText = rules.filterText;
    const maxRetries = rules.publishMaxRetries ?? 10;
    const notFoundBackoff = rules.notFoundBackoffMs ?? [800, 1500];
    const disabledBackoff = rules.disabledRetryDelayMs ?? [1500, 4000];
    const postClickWait = rules.postClickStabilizeMs ?? [1000, 2000];

    let publishClicked = false;
    let lastClickResult: { attempt: number; sel: string; urlBefore: string; urlAfter: string } | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // 3a. scope-scoped 找发布按钮 (filterTag 自动排除 <a> 链接)
      let btn: { x: number; y: number; w: number; h: number; sel: string; tag: string } | null = null;
      for (const scopeSel of scopeSelectors) {
        btn = await HumanActions.cdpFindElementScoped(page, scopeSel, publishBtnSelectors, { filterTag, filterText });
        if (btn) {
          logger.info(`${platLabel} 发布按钮定位于 ${scopeSel} (via ${btn.sel})`);
          break;
        }
      }
      // 3b. scope 都找不到, 退回到全页搜索 (但仍 filterTag=约束)
      if (!btn) {
        btn = await HumanActions.cdpFindElement(page, publishBtnSelectors);
      }
      if (!btn) {
        if (attempt === 0 || attempt === Math.floor(maxRetries / 2) || attempt === maxRetries - 1) {
          logger.warn(`${platLabel} 发布按钮查找失败 (${attempt + 1}/${maxRetries}, scope=${scopeSelectors.length} 个) — 等待后重试`);
        }
        await HumanActions.wait(page, notFoundBackoff[0], notFoundBackoff[1]);
        continue;
      }

      // 3c. 多方法检测 disabled
      const isDisabled = await HumanActions.cdpIsElementDisabled(page, btn.sel, rules.disabledCheckMethods);
      if (isDisabled) {
        logger.debug(`${platLabel} 发布按钮 disabled (${attempt + 1}/${maxRetries}) — 等待 ${disabledBackoff[0]}-${disabledBackoff[1]}ms 后重试`);
        await HumanActions.wait(page, disabledBackoff[0], disabledBackoff[1]);
        continue;
      }

      // 3d. 记录点击前 URL, 点击
      const urlBefore = page.url();
      await HumanActions.cdpClick(page, btn.sel);
      await HumanActions.wait(page, postClickWait[0], postClickWait[1]);
      const urlAfter = page.url();
      lastClickResult = { attempt: attempt + 1, sel: btn.sel, urlBefore, urlAfter };

      // 3e. URL 校验: 跳到 navRedirectUrlPatterns 说明点到导航链接了
      const navPatterns = rules.navRedirectUrlPatterns ?? ['/user/self'];
      const navRedirected = navPatterns.some(
        (pat) => urlAfter.includes(pat) && !urlBefore.includes(pat),
      );
      if (navRedirected) {
        logger.warn(`${platLabel} 点击后 URL 异常跳转: ${urlBefore} → ${urlAfter} (via ${btn.sel}, 命中导航模式) — 重新打开发布页`);
        // 紧急恢复: 点击误触导航链接后强制回到发布页（唯一例外允许 goto）
        const publishUrl = this.publishUrl ?? `${this.creatorUrl.replace(/\/$/, '')}/publish`;
        await page.goto(publishUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await HumanActions.wait(page, 2000, 3000);
        logger.info(`${platLabel} 已返回发布页, 准备重填元数据`);
        throw new Error('NEEDS_REFILL_BEFORE_PUBLISH');
      }

      logger.info(`${platLabel} 发布按钮已点击 (${attempt + 1}/${maxRetries}, via ${btn.sel}, url: ${urlBefore} → ${urlAfter})`);
      publishClicked = true;

      // 4. 处理"声明"弹窗 (可选, 按 rules.declareModalMethod)
      if (args.declareModalName && args.declareConfirmName && rules.declareModalMethod !== undefined) {
        const declaredHandled = await this.handleDeclareModal(
          page, sel, args.platform, args.declareModalName, args.declareConfirmName, rules.declareModalMethod,
        );
        if (declaredHandled) {
          // 弹窗确认后需要再次点击发布按钮
          for (let r2 = 0; r2 < 3; r2++) {
            const btn2 = await HumanActions.cdpFindElement(page, publishBtnSelectors);
            if (btn2) {
              await HumanActions.cdpClick(page, btn2.sel);
              logger.info(`${platLabel} 弹窗后再次点击发布 (${r2 + 1}/3, via ${btn2.sel})`);
              break;
            }
            await HumanActions.wait(page, 500, 1000);
          }
        }
      }
      break;
    }

    if (!publishClicked) {
      throw new Error(`${platLabel} 发布按钮点击失败（已重试 ${maxRetries} 次, 最后尝试: ${lastClickResult?.sel ?? 'N/A'}）`);
    }

    // 5. 等待发布结果 — 成功 toast (用 cdpFindElement) + URL 模式命中
    let success = false;
    const successSelectors = sel.getSelectorListWithFallback(args.platform, 'regions', args.successToastName, [
      '[class*="toast"]:visible',
      'text=发布成功',
      'text=已发布',
    ]);
    const successPatterns = rules.successUrlPatterns ?? ['/manage'];
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
        logger.info(`${platLabel} URL 已跳转至管理页: ${currentUrl} (命中模式: ${successPatterns.join('|')})`);
        break;
      }
      await HumanActions.wait(page, 800, 1200);
    }

    if (success) {
      logger.info(`${platLabel} ✅ 发布成功`);
    } else {
      const finalUrl = page.url();
      logger.warn(`${platLabel} ⚠️ 提交流程完成, 但 ${waitMs}ms 内未检测到成功标志 (URL: ${finalUrl})`);
    }

    return page.url();
  }

  /**
   * 检测并处理"声明/弹窗" — 多路校验 (selector / page-text / both)
   * 子类可覆盖, 默认实现适用于抖音/小红书/快手常见的"未添加自主声明" / "需确认原创" 等弹窗
   */
  protected async handleDeclareModal(
    page: Page,
    sel: SelectorReader,
    platform: PlatformName,
    modalSelectorKey: string,
    confirmBtnKey: string,
    method: 'selector' | 'page-text' | 'both',
  ): Promise<boolean> {
    let modalVisible = false;
    if (method === 'selector' || method === 'both') {
      const declareRegion = sel.getSelectorListWithFallback(platform, 'regions', modalSelectorKey, [
        'div.semi-modal-content:has-text("未添加自主声明")',
      ]);
      if (declareRegion.length > 0) {
        modalVisible = await HumanActions.cdpIsElementVisible(page, declareRegion[0]);
      }
    }
    if (!modalVisible && (method === 'page-text' || method === 'both')) {
      const bodyText = await HumanActions.cdpGetBodyText(page);
      modalVisible = bodyText.includes('未添加自主声明') || bodyText.includes('自主声明') || bodyText.includes('原创声明');
    }
    if (!modalVisible) return false;

    const declareBtn = sel.getSelectorListWithFallback(platform, 'buttons', confirmBtnKey, [
      'button.semi-button-tertiary.semi-button-light',
    ]);
    if (declareBtn.length === 0) return false;

    await HumanActions.cdpClick(page, declareBtn[0]);
    logger.info(`[${platform}] 已处理"声明"弹窗 (method=${method})`);
    await HumanActions.wait(page, 800, 1500);
    return true;
  }
}
