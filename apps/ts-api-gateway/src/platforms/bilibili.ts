// @ts-api-gateway/platforms/bilibili.ts - B站发布器
// 参考 Python: n8n-backup/social-media-api/app/uploaders/bilibili.py (124行)
// B站使用 biliup CLI 工具（非浏览器自动化）

import { Page } from 'patchright';
import { HumanActions } from '@social-media/browser-core';
import { BasePublisher } from './BasePublisher';
import { createLogger } from '../lib/logger';
import type { LoginContext, UploadContext } from './types';
import type { PlatformName } from '@social-media/shared-config';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const logger = createLogger('publisher:bilibili');

export class BilibiliPublisher extends BasePublisher {
  readonly platform: PlatformName = 'bilibili';
  readonly creatorUrl = 'https://member.bilibili.com';

  /** B站不需要登录（使用 biliup CLI 内置 cookie） */
  protected async doLogin(ctx: LoginContext): Promise<void> {
    logger.info('[B站] 使用 biliup CLI，跳过浏览器登录');
  }

  /** B站不需要导航到发布页（CLI 直接上传） */
  protected async goToPublishPage(page: Page): Promise<void> {
    logger.info('[B站] CLI 模式，跳过浏览器导航');
  }

  /** 通过 biliup CLI 上传 */
  protected async uploadVideo(ctx: UploadContext): Promise<void> {
    const { videoPath, metadata } = ctx;

    const args = [
      'upload-video',
      '--file', videoPath,
      '--title', metadata.title,
      '--desc', metadata.description,
      '--tags', metadata.tags.join(','),
    ];

    if (metadata.category) {
      args.push('--tid', metadata.category);
    }

    logger.info(`[B站] 执行: biliup ${args.join(' ')}`);

    try {
      const { stdout, stderr } = await execAsync(`biliup ${args.join(' ')}`, {
        timeout: 600_000, // 10 分钟
      });
      logger.info(`[B站] biliup 输出: ${stdout}`);
      if (stderr) logger.warn(`[B站] biliup stderr: ${stderr}`);
    } catch (err) {
      logger.error(`[B站] biliup 执行失败: ${(err as Error).message}`);
      throw err;
    }
  }

  /** B站元数据通过 CLI 参数传递 */
  protected async fillMetadata(ctx: UploadContext): Promise<void> {
    logger.info('[B站] 元数据通过 CLI 参数传递，无需浏览器填写');
  }

  /** B站发布由 CLI 自动完成 */
  protected async submitPublish(page: Page): Promise<string> {
    logger.info('[B站] CLI 自动发布完成');
    return 'https://www.bilibili.com/video/uploaded';
  }
}
