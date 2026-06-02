// @ts-api-gateway/platforms/BasePublisher.ts
// 多平台发布器抽象基类
// 严格遵守 project_rules.md 的反检测规则，所有浏览器操作通过 HumanActions

import { chromium, Browser, Page } from 'patchright';
import { HumanActions } from '@social-media/browser-core';
import { WindowMutex } from '../lib/redlock';
import { uploadToOSS, ossKey } from '../lib/oss';
import { createLogger } from '../lib/logger';
import type Redlock from 'redlock';
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

  protected state: PublisherState = 'idle';
  protected browser: Browser | null = null;
  protected page: Page | null = null;
  protected lock: Redlock.Lock | null = null;

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

  /** 提交发布 */
  protected abstract submitPublish(page: Page): Promise<string>;

  // ============================================================
  // 模板方法 - 发布生命周期
  // ============================================================

  /**
   * 发布主流程（模板方法）
   *
   * 流程：
   * 1. 获取窗口互斥锁 (Redlock)
   * 2. 下载 OSS 视频到本地临时目录
   * 3. 启动/连接指纹浏览器
   * 4. 平台登录
   * 5. 导航到发布页
   * 6. 上传视频
   * 7. 填写元数据
   * 8. 提交发布
   * 9. 清理资源 + 释放锁
   */
  async publish(task: PublishTask): Promise<PublishResult> {
    const startTime = Date.now();
    const localVideoPath = `/tmp/publish_${task.taskId}_${task.video.filename}`;

    try {
      this.state = 'idle';

      // Step 1: 获取窗口互斥锁（防止并发操控同一指纹浏览器）
      this.lock = await WindowMutex.acquireWithBackoff(task.windowId);

      // Step 2: 初始化浏览器
      await this.initBrowser(task);

      // Step 3: 登录
      this.state = 'logging_in';
      await this.doLogin({
        page: this.page!,
        credentials: task.credentials,
        windowId: task.windowId,
      });
      logger.info(`[${task.platform}] 登录完成`);

      // Step 4: 导航到发布页
      await this.goToPublishPage(this.page!);
      logger.info(`[${task.platform}] 已导航到发布页`);

      // Step 5: 上传视频
      this.state = 'uploading';
      const uploadCtx: UploadContext = {
        page: this.page!,
        videoPath: localVideoPath,
        metadata: task.metadata,
        videoPayload: task.video,
      };
      await this.uploadVideo(uploadCtx);
      logger.info(`[${task.platform}] 视频上传完成`);

      // Step 6: 填写元数据
      await this.fillMetadata(uploadCtx);
      logger.info(`[${task.platform}] 元数据填写完成`);

      // Step 7: 提交发布
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

  /** 释放互斥锁 */
  async releaseLock(): Promise<void> {
    if (this.lock && this.page) {
      // 获取 windowId 需要通过 browser context
      const windowId = this.page.context(); // 简化处理
      await WindowMutex.release(this.lock, windowId as any);
      this.lock = null;
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 初始化浏览器（连接指纹浏览器） */
  protected async initBrowser(task: PublishTask): Promise<void> {
    // TODO: 通过 BrowserManager 连接 RoxyBrowser/BitBrowser
    // 使用 windowId 连接到指定窗口

    // 临时实现：本地 patchright 启动
    this.browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    this.page = await context.newPage();

    // 注入页面加载后的人类行为模拟
    await HumanActions.wait(this.page, 500, 1500);
  }

  /** 清理资源 */
  protected async cleanup(): Promise<void> {
    // 释放锁
    if (this.lock) {
      try {
        await this.lock.release();
      } catch {
        // 锁可能已过期
      }
      this.lock = null;
    }

    // 关闭浏览器
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // 浏览器可能已关闭
      }
      this.browser = null;
      this.page = null;
    }

    this.state = 'idle';
  }
}
