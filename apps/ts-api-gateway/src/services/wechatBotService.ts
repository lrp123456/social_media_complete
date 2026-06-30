// @ts-api-gateway/services/wechatBotService.ts - 企业微信智能机器人长连接服务

import { getLoginHost } from '@social-media/browser-core';
import { createLogger } from '../lib/logger';
import { uploadBufferToOSS, OSS_DIRS } from '../lib/oss';

const logger = createLogger('wecom-bot');

// ============================================================
// 类型定义
// ============================================================

export interface BotConfig {
  botId: string;
  secret: string;
}

export interface BotStatus {
  connected: boolean;
  botId: string;
  connectedAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
}

export type MessageHandler = (msg: any) => Promise<void>;

// ============================================================
// Bot Manager (singleton)
// ============================================================

class WeChatBotManager {
  private client: any = null;
  private config: BotConfig | null = null;
  private status: BotStatus = {
    connected: false,
    botId: '',
    connectedAt: null,
    lastMessageAt: null,
    messageCount: 0,
  };
  private messageHandlers: MessageHandler[] = [];
  private pendingLinks = new Map<string, { resolve: (userid: string) => void; timeout: NodeJS.Timeout }>();
  private pendingReplies = new Map<string, {
    videoId: string;
    awemeId: string;
    userId: number;
    windowId: string;
    platform: string;
    timeout: NodeJS.Timeout;
  }>();
  private pendingNotifications = new Map<string, {
    videoIds: string[];
    timestamp: number;
  }>();
  private pendingAIGenerations = new Map<string, {
    commentCid: string;
    platform: string;
    userid: string;
    startTime: number;
    timeout: NodeJS.Timeout;
  }>();
  private pendingVerifyCodes = new Map<string, {
    userId: number;
    platform: string;
    windowId: string;
    timeout: NodeJS.Timeout;
  }>();

  // 自动重连状态
  private reconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 5000; // 5 秒
  private maxReconnectDelay = 60000; // 60 秒
  private reconnectTimer: NodeJS.Timeout | null = null;

  async start(config: BotConfig): Promise<BotStatus> {
    if (this.client && this.status.connected) {
      logger.warn('Bot already connected, stopping first...');
      await this.stop();
    }

    this.config = config;

    try {
      const { WSClient } = await import('@wecom/aibot-node-sdk');

      this.client = new WSClient({
        botId: config.botId,
        secret: config.secret,
      });

      // Listen for messages via EventEmitter
      this.client.on('message', async (msg: any) => {
        logger.info(`收到消息: from=${msg.body?.from?.userid}, type=${msg.body?.msgtype}, content=${msg.body?.text?.content}`);

        this.status.lastMessageAt = new Date().toISOString();
        this.status.messageCount++;

        const userid = msg.body?.from?.userid;
        const content = msg.body?.text?.content?.trim();

        // Check if this message matches a pending link request
        if (content && this.pendingLinks.has(content)) {
          const pending = this.pendingLinks.get(content)!;
          clearTimeout(pending.timeout);
          this.pendingLinks.delete(content);
          pending.resolve(userid);
          logger.info(`链接请求 ${content} 已匹配用户 ${userid}`);

          // Reply to user
          try {
            await this.client.reply(msg, {
              msgtype: 'markdown',
              markdown: { content: `✅ 已成功绑定用户ID: **${userid}**` },
            });
          } catch (err) {
            logger.error({ err: (err as Error).message }, '回复消息失败');
          }
          return;
        }

        // Call registered message handlers
        for (const handler of this.messageHandlers) {
          try {
            await handler(msg);
          } catch (err) {
            logger.error({ err: (err as Error).message }, '消息处理器异常');
          }
        }
      });

      this.client.on('connected', () => {
        logger.info('WebSocket 连接已建立');
      });

      this.client.on('authenticated', () => {
        this.status.connected = true;
        this.status.botId = config.botId;
        this.status.connectedAt = new Date().toISOString();
        logger.info(`🤖 企业微信机器人已认证: botId=${config.botId}`);
      });

      this.client.on('error', (err: Error) => {
        logger.error({ err: err.message }, 'WebSocket 错误');
        if (this.status.connected) this.scheduleReconnect();
      });

      this.client.on('disconnected', (reason: string) => {
        this.status.connected = false;
        logger.warn(`WebSocket 断开: ${reason}`);
        this.scheduleReconnect();
      });

            // Connect
      this.client.connect();

      return { ...this.status };
    } catch (err) {
      logger.error({ err: (err as Error).message }, '机器人连接失败');
      this.status.connected = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    // 主动停止时取消所有重连计划
    this.cancelReconnect();
    this.reconnectAttempts = 0;
    this.reconnecting = false;

    if (this.client) {
      try {
        this.client.disconnect();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '关闭连接时出错');
      }
      this.client = null;
    }

    for (const [code, pending] of this.pendingLinks) {
      clearTimeout(pending.timeout);
      pending.resolve('');
      logger.warn(`链接请求 ${code} 已取消（机器人断开）`);
    }
    this.pendingLinks.clear();

    for (const [commentCid, pending] of this.pendingAIGenerations) {
      clearTimeout(pending.timeout);
      logger.warn(`AI 生成任务 ${commentCid} 已取消（机器人断开）`);
    }
    this.pendingAIGenerations.clear();

    this.status.connected = false;
    this.status.botId = '';
    logger.info('🤖 企业微信机器人已断开');
  }

  /** 计划一次重连（指数退避，防重复） */
  private scheduleReconnect(): void {
    if (this.reconnecting || !this.config) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.warn(`已达到最大重连次数 (${this.maxReconnectAttempts})，停止自动重连`);
      return;
    }

    this.reconnecting = true;
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    const jitter = Math.floor(Math.random() * 1000);

    logger.info(`将在 ${Math.round(delay / 1000)}s 后尝试重连 (第 ${this.reconnectAttempts + 1} 次)`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempts++;
      this.reconnecting = false;
      await this.reconnect();
    }, delay + jitter);
  }

  /** 取消待执行的重连 */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
  }

  /** 实际执行重连 */
  private async reconnect(): Promise<void> {
    if (!this.config) {
      logger.warn('重连失败：无配置信息');
      return;
    }

    try {
      logger.info(`尝试重连企业微信机器人 (botId=${this.config.botId})...`);
      // 清理旧客户端（不触发 stop 的重置逻辑）
      if (this.client) {
        try { this.client.disconnect(); } catch {}
        this.client = null;
      }

      const { WSClient } = await import('@wecom/aibot-node-sdk');

      this.client = new WSClient({
        botId: this.config.botId,
        secret: this.config.secret,
      });

      this.client.on('message', async (msg: any) => {
        logger.info(`收到消息: from=${msg.body?.from?.userid}, type=${msg.body?.msgtype}, content=${msg.body?.text?.content}`);
        this.status.lastMessageAt = new Date().toISOString();
        this.status.messageCount++;
        const userid = msg.body?.from?.userid;
        const content = msg.body?.text?.content?.trim();
        if (content && this.pendingLinks.has(content)) {
          const pending = this.pendingLinks.get(content)!;
          clearTimeout(pending.timeout);
          this.pendingLinks.delete(content);
          pending.resolve(userid);
          logger.info(`链接请求 ${content} 已匹配用户 ${userid}`);
          try {
            await this.client.reply(msg, {
              msgtype: 'markdown',
              markdown: { content: `✅ 已成功绑定用户ID: **${userid}**` },
            });
          } catch (err) {
            logger.error({ err: (err as Error).message }, '回复消息失败');
          }
          return;
        }
        for (const handler of this.messageHandlers) {
          try { await handler(msg); } catch (err) {
            logger.error({ err: (err as Error).message }, '消息处理器异常');
          }
        }
      });

      this.client.on('connected', () => {
        logger.info('WebSocket 连接已建立（重连）');
      });

      this.client.on('authenticated', () => {
        this.status.connected = true;
        this.status.botId = this.config!.botId;
        this.status.connectedAt = new Date().toISOString();
        this.reconnectAttempts = 0; // 认证成功，重置重连计数
        logger.info(`🤖 企业微信机器人已认证（重连成功）: botId=${this.config!.botId}`);
      });

      this.client.on('error', (err: Error) => {
        logger.error({ err: err.message }, 'WebSocket 错误（重连会话）');
        if (this.status.connected) this.scheduleReconnect();
      });

      this.client.on('disconnected', (reason: string) => {
        this.status.connected = false;
        logger.warn(`WebSocket 断开（重连会话）: ${reason}`);
        this.scheduleReconnect();
      });

      this.client.connect();
    } catch (err: any) {
      logger.error({ err: err.message }, '重连失败，将再次尝试');
      this.reconnecting = false; // 让 scheduleReconnect 可以再次调度
      this.scheduleReconnect();
    }
  }

  getStatus(): BotStatus & { reconnecting: boolean; reconnectAttempts: number; maxReconnectAttempts: number } {
    return {
      ...this.status,
      reconnecting: this.reconnecting,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
    };
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  setPendingReply(
    commentCid: string,
    context: { videoId: string; awemeId: string; userId: number; windowId: string; platform: string },
    timeoutMs = 300_000,
  ): void {
    const existing = this.pendingReplies.get(commentCid);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => {
      this.pendingReplies.delete(commentCid);
      logger.info({ commentCid }, '待回复上下文超时，已清除');
    }, timeoutMs);

    this.pendingReplies.set(commentCid, { ...context, timeout });
    logger.info({ commentCid, ...context }, '已设置待回复上下文');
  }

  getPendingReply(commentCid: string) {
    return this.pendingReplies.get(commentCid);
  }

  clearPendingReply(commentCid: string): void {
    const existing = this.pendingReplies.get(commentCid);
    if (existing) clearTimeout(existing.timeout);
    this.pendingReplies.delete(commentCid);
  }

  /** 检查是否正在生成 AI 回复 */
  isGeneratingAI(commentCid: string): boolean {
    return this.pendingAIGenerations.has(commentCid);
  }

  /** 设置 AI 生成状态 */
  setPendingAIGeneration(commentCid: string, context: { platform: string; userid: string }, timeoutMs = 300_000): void {
    const existing = this.pendingAIGenerations.get(commentCid);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      this.pendingAIGenerations.delete(commentCid);
      logger.info({ commentCid }, 'AI 生成超时，已清除');
    }, timeoutMs);

    this.pendingAIGenerations.set(commentCid, {
      commentCid,
      platform: context.platform,
      userid: context.userid,
      startTime: Date.now(),
      timeout,
    });
    logger.info({ commentCid, ...context }, '已设置 AI 生成状态');
  }

  /** 清除 AI 生成状态 */
  clearPendingAIGeneration(commentCid: string): void {
    const existing = this.pendingAIGenerations.get(commentCid);
    if (existing) {
      clearTimeout(existing.timeout);
    }
    this.pendingAIGenerations.delete(commentCid);
  }

  setPendingVerify(userid: string, userId: number, platform: string, windowId: string, timeoutMs = 300_000): void {
    const existing = this.pendingVerifyCodes.get(userid);
    if (existing) clearTimeout(existing.timeout);
    const timeout = setTimeout(() => {
      this.pendingVerifyCodes.delete(userid);
      logger.info({ userid }, '待验证码上下文超时，已清除');
    }, timeoutMs);
    this.pendingVerifyCodes.set(userid, { userId, platform, windowId, timeout });
    logger.info({ userid, userId, platform }, '已设置待验证码上下文');
  }

  getPendingVerify(userid: string) {
    return this.pendingVerifyCodes.get(userid);
  }

  clearPendingVerify(userid: string): void {
    const existing = this.pendingVerifyCodes.get(userid);
    if (existing) clearTimeout(existing.timeout);
    this.pendingVerifyCodes.delete(userid);
  }

  trackNotification(userid: string, videoIds: string[]): void {
    this.pendingNotifications.set(userid, { videoIds, timestamp: Date.now() });
    // Auto-expire after 24 hours
    setTimeout(() => {
      this.pendingNotifications.delete(userid);
    }, 24 * 60 * 60 * 1000);
    logger.info({ userid, videoIds }, '已跟踪评论通知，等待用户交互');
  }

  consumeNotification(userid: string): { videoIds: string[]; timestamp: number } | undefined {
    const pending = this.pendingNotifications.get(userid);
    if (pending) {
      this.pendingNotifications.delete(userid);
      return pending;
    }
    return undefined;
  }

  createLinkRequest(timeoutMs = 120_000): { code: string; promise: Promise<string> } {
    const code = String(Math.floor(100000 + Math.random() * 900000));

    const promise = new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingLinks.delete(code);
        resolve('');
        logger.warn(`链接请求 ${code} 超时`);
      }, timeoutMs);

      this.pendingLinks.set(code, { resolve, timeout });
    });

    logger.info(`创建链接请求: code=${code}, timeout=${timeoutMs}ms`);
    return { code, promise };
  }

  async sendTextMessage(userids: string[], content: string): Promise<void> {
    if (!this.client) throw new Error('机器人未连接');

    for (const userid of userids) {
      await this.client.sendMessage(userid, {
        msgtype: 'markdown',
        markdown: { content },
      });
    }

    logger.info(`发送消息给 ${userids.join(', ')}: ${content.substring(0, 50)}...`);
  }

  async sendTemplateCard(userids: string[], card: any): Promise<void> {
    if (!this.client) throw new Error('机器人未连接');

    for (const userid of userids) {
      await this.client.sendMessage(userid, {
        msgtype: 'template_card',
        template_card: card,
      });
    }

    logger.info(`发送模板卡片给 ${userids.join(', ')}`);
  }

  async replyMessage(frame: any, content: string): Promise<void> {
    if (!this.client) throw new Error('机器人未连接');

    await this.client.reply(frame, {
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  /**
   * 发送登录告警 — 上传截图到 OSS，嵌入图文卡片展示
   */
  async sendLoginAlert(userid: string, platform: string, userId: number, imageBuffer?: Buffer, flowId?: string): Promise<void> {
    const fid = flowId || 'creator';
    const platformNames: Record<string, string> = {
      douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', tencent: '视频号',
    };
    const label = platformNames[platform] || platform;

    // 查询窗口名称和操作员手机号，用于提示用户用哪台手机扫码
    let windowName = '';
    let phone = '';
    try {
      const { prisma } = await import('../lib/prisma');
      const acct = await prisma.platformAccount.findUnique({
        where: { id: userId },
        select: { window: { select: { externalId: true, windowName: true, boundOperatorId: true } } },
      }).catch(() => null);
      if (acct?.window) {
        windowName = acct.window.windowName || '';
        if (acct.window.boundOperatorId) {
          const op = await prisma.operator.findUnique({
            where: { id: acct.window.boundOperatorId },
            select: { phone: true },
          }).catch(() => null);
          if (op?.phone) phone = op.phone;
        }
      }
    } catch { /* 静默降级，不影响正常流程 */ }

    try {
      // 如果有截图，先尝试上传到 OSS
      let imageUrl: string | undefined;
      if (imageBuffer) {
        try {
          const filename = `login_qr_${platform}_${userId}_${Date.now()}.png`;
          const result = await uploadBufferToOSS(imageBuffer, `${OSS_DIRS.screenshots}/${filename}`, { mime: 'image/png' });
          imageUrl = result.ossUrl;
          logger.info({ userid, platform, imageUrl }, '登录截图已上传OSS');
        } catch (imgErr: any) {
          logger.warn({ userid, err: imgErr.message }, '上传截图到OSS失败，尝试企业微信临时素材');
          // OSS 失败时，上传到企业微信获取 media_id
          try {
            const mediaResult = await this.client.uploadMedia(imageBuffer, {
              msgtype: 'image',
              media: { filename: `login_qr_${platform}.png`, filelength: imageBuffer.length },
            });
            if (mediaResult.media_id) {
              // 发送图片消息
              await this.client.sendMessage(userid, {
                msgtype: 'image',
                image: { media_id: mediaResult.media_id },
              } as any);
              logger.info({ userid, platform, mediaId: mediaResult.media_id }, '登录截图已通过企业微信发送');
            }
          } catch (mediaErr: any) {
            logger.warn({ userid, err: mediaErr.message }, '企业微信上传临时素材也失败');
          }
        }
      }

      // 发送模板卡片（如果有图片URL则附带图片）
      const card: any = {
        card_type: 'news_notice',
        source: { desc: '监控系统', desc_color: 0 },
        main_title: { title: `🔐 ${label} 需要重新登录`, desc: '请用APP扫描二维码完成登录' },
        horizontal_content_list: [
          { keyname: '用户ID', value: String(userId) },
          { keyname: '平台', value: label },
          { keyname: '状态', value: '等待扫码登录' },
          ...(windowName ? [{ keyname: '窗口', value: windowName }] : []),
          ...(phone ? [{ keyname: '手机号', value: phone }] : []),
        ],
        jump_list: [
          { type: 3, title: '✅ 已登录，继续监控', question: `继续监控 ${userId} ${platform} ${fid}` },
          { type: 3, title: '🔄 强制刷新登录页', question: `强制刷新 ${userId} ${platform} ${fid}` },
          { type: 3, title: '♻️ F5刷新QR码', question: `F5刷新 ${userId} ${platform} ${fid}` },
        ],
        card_action: imageUrl ? { type: 1, url: imageUrl } : { type: 0 },
      };

      if (imageUrl) {
        card.card_image = { url: imageUrl, aspect_ratio: 1.0 };
      }

      await this.sendTemplateCard([userid], card);
    } catch (err: any) {
      logger.error({ userid, platform, userId, err }, '发送登录告警失败');
      await this.sendTextMessage([userid], `🔐 ${label} 需要登录\n用户ID: ${userId}\n登录后回复"继续监控 ${userId} ${platform}"恢复监控`);
    }
  }

  /**
   * 发送二次验证卡片 — 提示用户输入验证码
   */
  async sendVerifyCard(userid: string, platform: string, userId: number): Promise<void> {
    const platformNames: Record<string, string> = {
      douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', tencent: '视频号',
    };
    const label = platformNames[platform] || platform;

    // 查询窗口名和手机号
    let windowName = '';
    let phone = '';
    try {
      const { prisma } = await import('../lib/prisma');
      const acct = await prisma.platformAccount.findUnique({
        where: { id: userId },
        select: { window: { select: { externalId: true, windowName: true, boundOperatorId: true } } },
      }).catch(() => null);
      if (acct?.window) {
        windowName = acct.window.windowName || '';
        if (acct.window.boundOperatorId) {
          const op = await prisma.operator.findUnique({ where: { id: acct.window.boundOperatorId }, select: { phone: true } }).catch(() => null);
          if (op?.phone) phone = op.phone;
        }
      }
    } catch { /* 静默降级 */ }

    try {
      const card: any = {
        card_type: 'text_notice',
        source: { desc: '监控系统', desc_color: 0 },
        main_title: { title: `📱 ${label} 需要短信验证码`, desc: '已自动点击接收短信，请输入收到的验证码' },
        horizontal_content_list: [
          { keyname: '用户ID', value: String(userId) },
          { keyname: '平台', value: label },
          { keyname: '状态', value: '等待输入验证码' },
          ...(windowName ? [{ keyname: '窗口', value: windowName }] : []),
          ...(phone ? [{ keyname: '手机号', value: phone }] : []),
        ],
        jump_list: [
          { type: 3, title: '🔢 点击输入验证码', question: `验证码 ` },
        ],
        card_action: { type: 1, url: 'https://work.weixin.qq.com' },
      };
      await this.sendTemplateCard([userid], card);
    } catch (err: any) {
      logger.error({ userid, platform, userId, err }, '发送验证码卡片失败');
      await this.sendTextMessage([userid], `📱 ${label} 需要短信验证码\n请回复"验证码 <6位数字>"完成验证`);
    }
  }
}

// Singleton instance
export const botManager = new WeChatBotManager();

// 启动时自动从环境变量连接机器人
async function autoStartBot(): Promise<void> {
  const botId = process.env.WECOM_BOT_ID;
  const secret = process.env.WECOM_BOT_SECRET;

  if (botId && secret) {
    try {
      await botManager.start({ botId, secret });
      logger.info(`🤖 企业微信机器人自动连接成功: botId=${botId}`);

      // 注册评论回复消息处理器
      botManager.onMessage(async (msg: any) => {
        const userid = msg.body?.from?.userid;
        const content = (msg.body?.text?.content || '').trim();
        if (!userid || !content) return;

        // 匹配回复意图: 格式 "回复 <platform> <awemeId> <commentCid>"（来自 jump_list type=3）
        const replySetup = content.match(/^回复\s+(\S+)\s+(\S+)\s+(\S+)$/);
        if (replySetup) {
          const platform = replySetup[1];
          const awemeId = replySetup[2];
          const commentCid = replySetup[3];

          // 动态导入 prisma（避免循环依赖）
          const { prisma } = await import('../lib/prisma');
          const acct = await prisma.platformAccount.findFirst({
            where: { wechatUserid: userid, platform },
            select: { id: true, window: { select: { externalId: true } } },
          }).catch(() => null);

          if (!acct?.window?.externalId) {
            await botManager.sendTextMessage([userid], '❌ 未找到关联的浏览器窗口');
            return;
          }

          botManager.setPendingReply(commentCid, {
            videoId: awemeId, awemeId, userId: acct.id, windowId: acct.window.externalId, platform,
          });

          await botManager.sendTextMessage([userid], `💬 已选择回复评论，请直接发送回复内容（5分钟内有效）`);
          return;
        }

        // 匹配"继续监控"意图: 格式 "继续监控 <userId> <platform> [flowId]"（来自登录告警 jump_list）
        const resumeSetup = content.match(/^继续监控\s+(\d+)\s+(\S+)(?:\s+(\S+))?$/);
        if (resumeSetup) {
          const targetUserId = parseInt(resumeSetup[1], 10);
          const targetPlatform = resumeSetup[2];
          const targetFlowId = resumeSetup[3] || 'creator';

          const { prisma } = await import('../lib/prisma');
          const user = await prisma.platformAccount.findUnique({
            where: { id: targetUserId },
            select: { wechatUserid: true, window: { select: { externalId: true } } },
          }).catch(() => null);

          if (!user) { await botManager.sendTextMessage([userid], '❌ 未找到用户'); return; }

          const windowId = user?.window?.externalId ? String(user.window.externalId) : '';
          if (!windowId) { await botManager.sendTextMessage([userid], '❌ 未找到关联的浏览器窗口'); return; }
          const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
          const { getBrowserManager } = await import('../lib/browserManager');
          const config = getLoginFlowConfig(targetPlatform, targetFlowId);
          if (!config) { await botManager.sendTextMessage([userid], '❌ 未找到登录配置'); return; }

          const bm = getBrowserManager();
          const browser = await bm.getBrowser(windowId);
          if (!browser) { await botManager.sendTextMessage([userid], '❌ 无法连接浏览器'); return; }

          const loginHost = getLoginHost(config.loginUrl, config.domain);
          const record = await loginTabRegistry.find(windowId, targetPlatform, targetFlowId, browser, loginHost);
          if (record) {
            // 导航到快手 profile 页验证登录态（登录成功后右上角 .user-info-dpd 存在；失效会回退到登录页）
            // 其他平台仍用原 loginUrl 跳转后看是否仍在登录页
            let isStillOnLoginPage = false;
            try {
              const checkUrl = targetPlatform === 'kuaishou'
                ? 'https://cp.kuaishou.com/profile'
                : config.loginUrl;
              await record.page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
              await record.page.waitForTimeout(3000);
              if (targetPlatform === 'kuaishou') {
                // 快手：看右上角用户状态栏是否存在
                const { HumanActions } = await import('@social-media/browser-core');
                const isLoggedIn = await HumanActions.cdpIsElementVisible(record.page, '.user-info-dpd');
                isStillOnLoginPage = !isLoggedIn;
              } else {
                const tabUrl = record.page.url();
                isStillOnLoginPage = tabUrl.includes('login') || tabUrl.includes('passport');
              }
            } catch { /* navigation failed, assume still on login */ isStillOnLoginPage = true; }
            if (isStillOnLoginPage) {
              // 仍在登录页 → 设置 15min 自动重试
              const { enqueueMonitor } = await import('./unifiedQueue');
              const retryDelay = 15 * 60 * 1000;
              await prisma.platformAccount.update({
                where: { id: targetUserId },
                data: { status: 'login_required', cooldownUntil: BigInt(Date.now() + retryDelay) },
              }).catch(() => null);
              setTimeout(async () => {
                try {
                  await prisma.platformAccount.update({
                    where: { id: targetUserId },
                    data: { status: 'init', cooldownUntil: 0n, monitoringEnabled: true },
                  }).catch(() => null);
                  await enqueueMonitor({
                    taskId: `retry_${Date.now()}_${targetUserId}`,
                    userId: targetUserId, platform: targetPlatform as any,
                    windowId, windowExternalId: user.window.externalId,
                  });
                  logger.info({ targetUserId, targetPlatform }, '15min 自动重试监控已触发');
                } catch (err: any) {
                  logger.error({ targetUserId, err: err.message }, '自动重试监控失败');
                }
              }, retryDelay);
              await botManager.sendTextMessage([userid], `⏳ 尚未检测到登录成功，15分钟后将自动重试监控\n如已登录请稍等，或点"强制刷新"重新扫码`);
              return;
            }
            // 登录成功：关闭标签页（或仅取消注册）
            if (config.closeOnLoginSuccess) {
              await loginTabRegistry.closeLoginTab(windowId, targetPlatform, targetFlowId);
            } else {
              await loginTabRegistry.unregister(windowId, targetPlatform, targetFlowId);
            }
          }
          // 恢复监控
          const { delFlowState } = await import('./monitorService');
          await delFlowState(targetUserId, targetFlowId);
          await prisma.platformAccount.update({ where: { id: targetUserId }, data: { status: 'init', cooldownUntil: 0n, monitoringEnabled: true } }).catch(() => null);
          const { enqueueMonitor } = await import('./unifiedQueue');
          await enqueueMonitor({ taskId: `manual_${Date.now()}_${targetUserId}`, userId: targetUserId, platform: targetPlatform as any, windowId, windowExternalId: user.window.externalId });
          await botManager.sendTextMessage([userid], `✅ ${targetPlatform} 已恢复监控`);
          return;
        }

        // 匹配"强制刷新"意图: 格式 "强制刷新 <userId> <platform> [flowId]"（来自登录告警 jump_list）
        const forceRefreshSetup = content.match(/^强制刷新\s+(\d+)\s+(\S+)(?:\s+(\S+))?$/);
        if (forceRefreshSetup) {
          const targetUserId = parseInt(forceRefreshSetup[1], 10);
          const targetPlatform = forceRefreshSetup[2];
          const targetFlowId = forceRefreshSetup[3] || 'creator';

          const { prisma } = await import('../lib/prisma');
          const user = await prisma.platformAccount.findUnique({
            where: { id: targetUserId },
            select: { wechatUserid: true, window: { select: { externalId: true } } },
          }).catch(() => null);

          if (!user) { await botManager.sendTextMessage([userid], '❌ 未找到用户'); return; }

          const windowId = user?.window?.externalId ? String(user.window.externalId) : '';
          if (!windowId) { await botManager.sendTextMessage([userid], '❌ 未找到关联的浏览器窗口'); return; }
          const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
          const { getBrowserManager } = await import('../lib/browserManager');
          const config = getLoginFlowConfig(targetPlatform, targetFlowId);
          if (!config) { await botManager.sendTextMessage([userid], '❌ 未找到登录配置'); return; }

          const bm = getBrowserManager();
          const browser = await bm.getBrowser(windowId);
          if (!browser) { await botManager.sendTextMessage([userid], '❌ 无法连接浏览器'); return; }

          try {
            const { ensureLoginTab, activatePlatformQR } = await import('./loginFlowHelpers');
            const record = await ensureLoginTab(windowId, targetUserId, targetPlatform, targetFlowId);
            if (record) {
              // 二次导航冲掉了 ensureLoginTab 的 QR 激活，导航后必须重新激活
              try {
                await record.page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
              } catch (err: any) {
                logger.warn({ targetPlatform, err: err.message }, '强制刷新 goto 超时，继续尝试激活 QR');
              }
              await record.page.waitForTimeout(3000);
              await activatePlatformQR(record.page, targetPlatform, config);
              const qrBuf = await loginTabRegistry.captureQR(record.page, config);
              await botManager.sendLoginAlert(user.wechatUserid || userid, targetPlatform, targetUserId, qrBuf || undefined, targetFlowId);
              await botManager.sendTextMessage([userid], `🔄 已刷新 ${targetPlatform} 登录页，新二维码已发送`);
            } else {
              await botManager.sendTextMessage([userid], `❌ 无法创建登录标签页`);
            }
          } catch (err: any) {
            logger.error({ targetUserId, targetPlatform, err }, '强制刷新登录页失败');
            await botManager.sendTextMessage([userid], `❌ 刷新登录页失败: ${err.message || '未知错误'}`);
          }
          return;
        }

        // 匹配"F5刷新"意图: 格式 "F5刷新 <userId> <platform> [flowId]"（来自登录告警 jump_list）
        const f5RefreshSetup = content.match(/^F5刷新\s+(\d+)\s+(\S+)(?:\s+(\S+))?$/);
        if (f5RefreshSetup) {
          const targetUserId = parseInt(f5RefreshSetup[1], 10);
          const targetPlatform = f5RefreshSetup[2];
          const targetFlowId = f5RefreshSetup[3] || 'creator';

          const { prisma } = await import('../lib/prisma');
          const user = await prisma.platformAccount.findUnique({
            where: { id: targetUserId },
            select: { wechatUserid: true, window: { select: { externalId: true } } },
          }).catch(() => null);

          if (!user) { await botManager.sendTextMessage([userid], '❌ 未找到用户'); return; }

          const windowId = user?.window?.externalId ? String(user.window.externalId) : '';
          if (!windowId) { await botManager.sendTextMessage([userid], '❌ 未找到关联的浏览器窗口'); return; }
          const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
          const { getBrowserManager } = await import('../lib/browserManager');
          const config = getLoginFlowConfig(targetPlatform, targetFlowId);
          if (!config) { await botManager.sendTextMessage([userid], '❌ 未找到登录配置'); return; }

          const bm = getBrowserManager();
          const browser = await bm.getBrowser(windowId);
          if (!browser) { await botManager.sendTextMessage([userid], '❌ 无法连接浏览器'); return; }

          try {
            const { ensureLoginTab, activatePlatformQR } = await import('./loginFlowHelpers');
            const record = await ensureLoginTab(windowId, targetUserId, targetPlatform, targetFlowId);
            if (record) {
              // F5 刷新：不重新导航，只刷新当前页面
              try {
                await record.page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
              } catch (err: any) {
                logger.warn({ targetPlatform, err: err.message }, 'F5 reload 超时，继续尝试激活 QR');
              }
              await record.page.waitForTimeout(3000);
              await activatePlatformQR(record.page, targetPlatform, config);
              const qrBuf = await loginTabRegistry.captureQR(record.page, config);
              await botManager.sendLoginAlert(user.wechatUserid || userid, targetPlatform, targetUserId, qrBuf || undefined, targetFlowId);
              await botManager.sendTextMessage([userid], `♻️ 已F5刷新 ${targetPlatform} 页面，新二维码已发送`);
            } else {
              await botManager.sendTextMessage([userid], `❌ 无法创建登录标签页`);
            }
          } catch (err: any) {
            logger.error({ targetUserId, targetPlatform, err }, 'F5刷新页面失败');
            await botManager.sendTextMessage([userid], `❌ F5刷新失败: ${err.message || '未知错误'}`);
          }
          return;
        }

        // 匹配"验证码 <数字>" — 抖音二次验证码填入
        const verifyCodeMatch = content.match(/^验证码\s+(\d{4,8})$/);
        if (verifyCodeMatch) {
          const code = verifyCodeMatch[1];
          const pending = botManager.getPendingVerify(userid);
          if (!pending) {
            await botManager.sendTextMessage([userid], '❌ 没有待处理的验证码请求');
            return;
          }
          try {
            const { getBrowserManager } = await import('../lib/browserManager');
            const bm = getBrowserManager();
            const browser = await bm.getBrowser(pending.windowId);
            if (!browser) {
              await botManager.sendTextMessage([userid], '❌ 无法连接浏览器');
              botManager.clearPendingVerify(userid);
              return;
            }
            // 找到抖音验证页面
            const ctx = browser.contexts()[0];
            const pages = ctx.pages();
            let targetPage: any = null;
            for (const p of pages) {
              const url = p.url();
              if (url.includes('douyin') || url.includes('creator')) {
                const bodyText = await p.evaluate(() => document.body?.innerText?.substring(0, 500) || '').catch(() => '');
                if (bodyText.includes('身份验证') || bodyText.includes('验证码')) {
                  targetPage = p;
                  break;
                }
              }
            }
            if (!targetPage) {
              await botManager.sendTextMessage([userid], '❌ 未找到验证页面，请重试');
              return;
            }
            // 填入验证码并提交
            const { DouyinCrawler } = await import('../crawlers/douyinCrawler');
            const dy = new DouyinCrawler();
            const success = await dy.submitVerifyCode(targetPage, code);
            if (success) {
              botManager.clearPendingVerify(userid);
              await botManager.sendTextMessage([userid], `✅ 验证码已填入并提交，等待验证结果`);
              // 等待 5 秒检查是否验证成功
              await new Promise(r => setTimeout(r, 5000));
              const stillVerify = await targetPage.evaluate(() => document.body?.innerText?.includes('身份验证') || false).catch(() => false);
              if (!stillVerify) {
                await botManager.sendTextMessage([userid], `✅ ${pending.platform} 二次验证成功，正在恢复监控`);
                // 恢复监控
                const { prisma } = await import('../lib/prisma');
                await prisma.platformAccount.update({ where: { id: pending.userId }, data: { status: 'init', cooldownUntil: 0n, monitoringEnabled: true } }).catch(() => null);
                const { enqueueMonitor } = await import('./unifiedQueue');
                await enqueueMonitor({ taskId: `manual_${Date.now()}_${pending.userId}`, userId: pending.userId, platform: pending.platform as any, windowId: pending.windowId, windowExternalId: pending.windowId });
              } else {
                await botManager.sendTextMessage([userid], `⚠️ 验证页面仍在，可能验证码错误，请重新输入`);
                botManager.setPendingVerify(userid, pending.userId, pending.platform, pending.windowId);
              }
            } else {
              await botManager.sendTextMessage([userid], `❌ 验证码填入失败，请手动处理`);
              botManager.clearPendingVerify(userid);
            }
          } catch (err: any) {
            logger.error({ userid, err: err.message }, '验证码处理失败');
            await botManager.sendTextMessage([userid], `❌ 验证码处理失败: ${err.message}`);
            botManager.clearPendingVerify(userid);
          }
          return;
        }

        // 匹配 AI 生成回复: 格式 "ai生成 <platform> <commentCid>"（来自 jump_list type=3）
        const aiGenSetup = content.match(/^ai生成\s+(\S+)\s+(\S+)$/);
        if (aiGenSetup) {
          const genPlatform = aiGenSetup[1];
          const genCommentCid = aiGenSetup[2];

          // 检查是否正在生成中
          if (botManager.isGeneratingAI(genCommentCid)) {
            await botManager.sendTextMessage([userid], '⏳ 该评论正在生成 AI 回复，请稍候...');
            return;
          }

          // 立即设置 AI 生成状态，防止竞态条件
          botManager.setPendingAIGeneration(genCommentCid, { platform: genPlatform, userid });

          // 内容截断辅助函数
          const truncate = (text: string, maxLen: number) =>
            text.length > maxLen ? text.slice(0, maxLen) + '...' : text;

          const { prisma: prismaGen } = await import('../lib/prisma');
          const genComment = await prismaGen.comment.findUnique({
            where: { cid: genCommentCid },
            include: { video: { select: { description: true, userId: true } } },
          }).catch(() => null);

          if (!genComment) {
            botManager.clearPendingAIGeneration(genCommentCid);
            await botManager.sendTextMessage([userid], '❌ 未找到该评论，可能已被删除');
            return;
          }

          // 获取父评论/根评论文本（level 2 时）
          let genParentText: string | undefined;
          let genRootText: string | undefined;
          if (genComment.level === 2 && genComment.parentId) {
            const parent = await prismaGen.comment.findFirst({
              where: { cid: genComment.parentId }, select: { text: true },
            }).catch(() => null);
            genParentText = parent?.text;
          }
          if (genComment.level === 2 && genComment.rootId) {
            const root = await prismaGen.comment.findFirst({
              where: { cid: genComment.rootId }, select: { text: true },
            }).catch(() => null);
            genRootText = root?.text;
          }

          const genUser = await prismaGen.platformAccount.findUnique({
            where: { id: genComment.video.userId },
            select: { platform: true },
          }).catch(() => null);

          const { replyGenerator } = await import('./llmService');
          const genDb = await import('./monitorDatabaseService');

          const ctx = {
            text: genComment.text,
            commenterName: genComment.userNickname,
            platform: genUser?.platform || genPlatform,
            videoDescription: genComment.video.description,
            parentCommentText: genParentText,
            rootCommentText: genRootText,
          };

          // 标记 pending
          await genDb.updateCommentSuggestion(genComment.id, {
            suggestedReply: '',
            suggestionStatus: 'pending',
          });

          // 立即回复加载状态消息
          const loadingMsg = `⏳ 正在为评论「${truncate(genComment.text, 30)}」生成AI回复...\n视频ID: ${genComment.videoId}\n平台: ${genPlatform}\n预计等待: 10-30秒`;
          await botManager.sendTextMessage([userid], loadingMsg);

          // 异步调用 LLM 生成回复
          const genUserPlatform = genUser?.platform || genPlatform;
          replyGenerator.generateReply(ctx)
            .then(async (genResult) => {
              if (genResult.success && genResult.reply) {
                await genDb.updateCommentSuggestion(genComment.id, {
                  suggestedReply: genResult.reply,
                  suggestionStatus: 'ready',
                  suggestionModel: genResult.model,
                  suggestionLatencyMs: genResult.latencyMs,
                });

                // 发送结果卡片
                const truncatedReply = truncate(genResult.reply, 40);
                const truncatedComment = truncate(genComment.text, 80);
                const resultCard = {
                  card_type: 'text_notice' as const,
                  source: { desc: '🤖 AI 回复助手 · 最终结果', desc_color: 0 },
                  main_title: {
                    title: '✅ AI 回复已生成',
                    desc: `回复视频id:${genComment.videoId}的评论`,
                  },
                  emphasis_content: {
                    title: truncatedReply,
                    desc: 'AI 生成',
                  },
                  sub_title_text: '评论：' + truncatedComment,
                  horizontal_content_list: [
                    { keyname: '平台', value: genUserPlatform },
                    { keyname: '视频ID', value: genComment.videoId },
                    { keyname: '评论', value: truncatedComment },
                    { keyname: '模型', value: genResult.model || 'unknown' },
                  ],
                  jump_list: [
                    { type: 3 as const, title: '📋 复制完整回复', question: `复制回复 ${genUserPlatform} ${genCommentCid}` },
                    { type: 3 as const, title: '📤 直接发送', question: `ai发送 ${genUserPlatform} ${genCommentCid}` },
                  ],
                  card_action: { type: 1 as const, url: 'https://creator.douyin.com/creator-micro/interactive/comment' },
                };
                await botManager.sendTemplateCard([userid], resultCard);
                logger.info({ commentCid: genCommentCid, commentId: genComment.id, model: genResult.model }, '企微触发的 AI 回复已生成');
              } else {
                await genDb.markSuggestionError(genComment.id, genResult.error || '未知错误');
                await botManager.sendTextMessage([userid], `❌ AI 回复生成失败\n评论：${truncate(genComment.text, 50)}\n错误：${genResult.error || '未知错误'}\n请稍后重试，或手动回复`);
              }
            })
            .catch(async (err) => {
              logger.error({ commentCid: genCommentCid, err: err.message }, 'AI 回复生成异常');
              await genDb.markSuggestionError(genComment.id, err.message || '未知错误');
              await botManager.sendTextMessage([userid], `❌ AI 回复生成失败\n评论：${truncate(genComment.text, 50)}\n错误：${err.message || '未知错误'}\n请稍后重试，或手动回复`);
            })
            .finally(() => {
              botManager.clearPendingAIGeneration(genCommentCid);
            });

          return;
        }

        // 匹配复制回复: 格式 "复制回复 <platform> <commentCid>"（来自结果卡片 jump_list）
        const copyReplySetup = content.match(/^复制回复\s+(\S+)\s+(\S+)$/);
        if (copyReplySetup) {
          const copyCommentCid = copyReplySetup[2];

          const { prisma: prismaCopy } = await import('../lib/prisma');
          const copyComment = await prismaCopy.comment.findUnique({
            where: { cid: copyCommentCid },
            select: { suggestedReply: true, suggestionStatus: true },
          }).catch(() => null);

          if (!copyComment) {
            await botManager.sendTextMessage([userid], '❌ 未找到该评论，可能已被删除');
            return;
          }

          if (copyComment.suggestionStatus !== 'ready' || !copyComment.suggestedReply) {
            await botManager.sendTextMessage([userid], '❌ 该评论暂无可用的 AI 回复，请先生成');
            return;
          }

          // 发送回复内容供用户复制
          const replyText = `📋 AI 回复内容（可复制后修改）：\n\n${copyComment.suggestedReply}\n\n💡 你可以修改后直接发送给机器人，我会处理发送任务。`;
          await botManager.sendTextMessage([userid], replyText);
          return;
        }

        // 匹配 AI 发送回复: 格式 "ai发送 <platform> <commentCid>"（来自 jump_list type=3）
        const aiSendSetup = content.match(/^ai发送\s+(\S+)\s+(\S+)$/);
        if (aiSendSetup) {
          const sendPlatform = aiSendSetup[1];
          const sendCommentCid = aiSendSetup[2];

          const { prisma: prismaSend } = await import('../lib/prisma');
          const sendComment = await prismaSend.comment.findUnique({
            where: { cid: sendCommentCid },
            include: { video: { select: { description: true, userId: true } } },
          }).catch(() => null);

          if (!sendComment) {
            await botManager.sendTextMessage([userid], '❌ 未找到该评论，可能已被删除');
            return;
          }

          let suggestedReply = sendComment.suggestedReply;

          // 如果没有建议回复或之前生成失败，先自动生成
          if (!suggestedReply || sendComment.suggestionStatus === 'error') {
            await botManager.sendTextMessage([userid], '⏳ 尚未生成 AI 回复，正在自动生成…');

            let sendParentText: string | undefined;
            let sendRootText: string | undefined;
            if (sendComment.level === 2 && sendComment.parentId) {
              const parent = await prismaSend.comment.findFirst({
                where: { cid: sendComment.parentId }, select: { text: true },
              }).catch(() => null);
              sendParentText = parent?.text;
            }
            if (sendComment.level === 2 && sendComment.rootId) {
              const root = await prismaSend.comment.findFirst({
                where: { cid: sendComment.rootId }, select: { text: true },
              }).catch(() => null);
              sendRootText = root?.text;
            }

            const sendUser = await prismaSend.platformAccount.findUnique({
              where: { id: sendComment.video.userId },
              select: { platform: true },
            }).catch(() => null);

            const { replyGenerator: sendGenerator } = await import('./llmService');
            const sendDb = await import('./monitorDatabaseService');

            const ctx = {
              text: sendComment.text,
              commenterName: sendComment.userNickname,
              platform: sendUser?.platform || sendPlatform,
              videoDescription: sendComment.video.description,
              parentCommentText: sendParentText,
              rootCommentText: sendRootText,
            };

            const sendResult = await sendGenerator.generateReply(ctx);

            if (sendResult.success && sendResult.reply) {
              await sendDb.updateCommentSuggestion(sendComment.id, {
                suggestedReply: sendResult.reply,
                suggestionStatus: 'ready',
                suggestionModel: sendResult.model,
                suggestionLatencyMs: sendResult.latencyMs,
              });
              suggestedReply = sendResult.reply;
              logger.info({ commentCid: sendCommentCid, commentId: sendComment.id }, '企微 AI 发送前自动生成回复成功');
            } else {
              await sendDb.markSuggestionError(sendComment.id, sendResult.error || '未知错误');
              await botManager.sendTextMessage([userid], `❌ AI 回复生成失败: ${sendResult.error || '未知错误'}`);
              return;
            }
          }

          if (!suggestedReply) {
            await botManager.sendTextMessage([userid], '❌ 无法获取 AI 回复内容');
            return;
          }

          // 查找用户和窗口
          const sendUser = await prismaSend.platformAccount.findUnique({
            where: { id: sendComment.video.userId },
            select: { id: true, platform: true, window: { select: { externalId: true } } },
          }).catch(() => null);

          if (!sendUser) {
            await botManager.sendTextMessage([userid], '❌ 未找到关联的用户账户');
            return;
          }

          // 更新状态
          const sendDb2 = await import('./monitorDatabaseService');
          await sendDb2.updateCommentSuggestion(sendComment.id, {
            suggestedReply,
            suggestionStatus: 'accepted',
          });
          await sendDb2.updateReplyStatus(sendComment.id, 'pending');

          // 入队回复任务
          const { enqueueReply } = await import('./unifiedQueue');
          await enqueueReply({
            taskId: `reply_${Date.now()}_${sendCommentCid}`,
            userId: sendUser.id,
            platform: sendUser.platform as any,
            windowId: sendUser.window.externalId,
            windowExternalId: sendUser.window.externalId,
            replyData: {
              videoId: sendComment.videoId,
              commentCid: sendCommentCid,
              text: suggestedReply,
            },
          });

          const preview = suggestedReply.length > 50 ? suggestedReply.slice(0, 50) + '...' : suggestedReply;
          await botManager.sendTextMessage([userid], `✅ AI 回复已提交: "${preview}"`);
          logger.info({ commentCid: sendCommentCid, commentId: sendComment.id, platform: sendUser.platform }, '企微触发的 AI 回复已入队');
          return;
        }

        // 匹配实际回复文本（用户不在"回复"前缀模式下直接发送文本）
        for (const [commentCid, ctx] of botManager['pendingReplies']) {
          const { prisma } = await import('../lib/prisma');
          const user = await prisma.platformAccount.findFirst({
            where: { wechatUserid: userid },
            select: { id: true },
          }).catch(() => null);

          if (user && ctx.userId === user.id) {
            botManager.clearPendingReply(commentCid);

            // 入队回复任务
            const { enqueueReply } = await import('./unifiedQueue');
            await enqueueReply({
              taskId: `reply_${Date.now()}_${commentCid}`,
              userId: ctx.userId,
              platform: (ctx.platform || 'douyin') as any,
              windowId: ctx.windowId,
              windowExternalId: ctx.windowId,
              replyData: {
                videoId: ctx.videoId,
                commentCid,
                text: content,
              },
            });

            const preview = content.length > 50 ? content.slice(0, 50) + '...' : content;
            await botManager.sendTextMessage([userid], `✅ 回复已提交: "${preview}"`);
            return;
          }
        }

        // 用户发送任意消息 → 标记通知中的评论为已读
        const notification = botManager.consumeNotification(userid);
        if (notification) {
          try {
            const { prisma } = await import('../lib/prisma');
            let totalMarked = 0;
            for (const videoId of notification.videoIds) {
              const result = await prisma.comment.updateMany({
                where: { videoId, isNew: 1 },
                data: { isNew: 0 },
              });
              totalMarked += result.count;
            }
            logger.info({ userid, videoIds: notification.videoIds, totalMarked }, '用户已读通知中的评论');
          } catch (err) {
            logger.warn({ err: (err as Error).message, userid }, '标记通知评论已读失败');
          }
        }
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '企业微信机器人自动连接失败');
    }
  } else {
    logger.warn('未检测到企业微信机器人环境变量 (WECOM_BOT_ID / WECOM_BOT_SECRET)');
  }
}

setTimeout(() => { autoStartBot().catch(() => {}); }, 3000);
