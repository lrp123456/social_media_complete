// @ts-api-gateway/services/wechatBotService.ts - 企业微信智能机器人长连接服务

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
        ],
        jump_list: [
          { type: 3, title: '✅ 已登录，继续监控', question: `继续监控 ${userId} ${platform} ${fid}` },
          { type: 3, title: '🔄 强制刷新登录页', question: `强制刷新 ${userId} ${platform} ${fid}` },
          { type: 3, title: '♻️ F5刷新QR码', question: `F5刷新 ${userId} ${platform} ${fid}` },
        ],
        card_action: { type: 1, url: 'https://work.weixin.qq.com' },
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
          const user = await prisma.user.findFirst({
            where: { wechatUserid: userid },
            select: { id: true },
          }).catch(() => null);

          if (!user) return;

          const window = await (prisma as any).browserWindow?.findFirst({
            where: { userId: user.id, platform },
            select: { fingerprintWindowId: true },
          }).catch(() => null);

          if (!window) {
            await botManager.sendTextMessage([userid], '❌ 未找到关联的浏览器窗口');
            return;
          }

          botManager.setPendingReply(commentCid, {
            videoId: awemeId, awemeId, userId: user.id, windowId: window.fingerprintWindowId, platform,
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
          const user = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { fingerprintWindowId: true, wechatUserid: true },
          }).catch(() => null);

          if (!user) { await botManager.sendTextMessage([userid], '❌ 未找到用户'); return; }

          const windowId = String(user.fingerprintWindowId);
          const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
          const { getBrowserManager } = await import('../lib/browserManager');
          const config = getLoginFlowConfig(targetPlatform, targetFlowId);
          if (!config) { await botManager.sendTextMessage([userid], '❌ 未找到登录配置'); return; }

          const bm = getBrowserManager();
          const browser = await bm.getBrowser(windowId);
          if (!browser) { await botManager.sendTextMessage([userid], '❌ 无法连接浏览器'); return; }

          const record = await loginTabRegistry.find(windowId, targetFlowId, browser, config.domain);
          if (!record) {
            // 登录标签页不存在，直接恢复（用户可能已在别处登录）
            await prisma.user.update({ where: { id: targetUserId }, data: { status: 'init', cooldownUntil: 0, monitoringEnabled: true } }).catch(() => null);
            const { platformQueue } = await import('./unifiedQueue');
            await platformQueue.add('monitor', { taskType: 'monitor', taskId: `manual_${Date.now()}_${targetUserId}`, userId: targetUserId, platform: targetPlatform as any, windowId, fingerprintWindowId: user.fingerprintWindowId });
            await botManager.sendTextMessage([userid], `✅ 已恢复 ${targetPlatform} 监控（直接触发）`);
            return;
          }

          const loginState = await loginTabRegistry.checkLoginState(record.page, config);
          if (loginState === 'logged_in') {
            if (config.closeOnLoginSuccess) {
              await loginTabRegistry.closeLoginTab(windowId, targetFlowId);
            } else {
              await loginTabRegistry.unregister(windowId, targetFlowId);
            }
            const { delFlowState } = await import('./monitorService');
            await delFlowState(targetUserId, targetFlowId);
            await prisma.user.update({ where: { id: targetUserId }, data: { status: 'init', cooldownUntil: 0, monitoringEnabled: true } }).catch(() => null);
            const { platformQueue } = await import('./unifiedQueue');
            await platformQueue.add('monitor', { taskType: 'monitor', taskId: `manual_${Date.now()}_${targetUserId}`, userId: targetUserId, platform: targetPlatform as any, windowId, fingerprintWindowId: user.fingerprintWindowId });
            await botManager.sendTextMessage([userid], `✅ ${targetPlatform} 登录成功，已恢复监控`);
          } else {
            await botManager.sendTextMessage([userid], `❌ 尚未检测到登录成功，请先扫码或点"刷新"`);
          }
          return;
        }

        // 匹配"强制刷新"意图: 格式 "强制刷新 <userId> <platform> [flowId]"（来自登录告警 jump_list）
        const forceRefreshSetup = content.match(/^强制刷新\s+(\d+)\s+(\S+)(?:\s+(\S+))?$/);
        if (forceRefreshSetup) {
          const targetUserId = parseInt(forceRefreshSetup[1], 10);
          const targetPlatform = forceRefreshSetup[2];
          const targetFlowId = forceRefreshSetup[3] || 'creator';

          const { prisma } = await import('../lib/prisma');
          const user = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { fingerprintWindowId: true, wechatUserid: true },
          }).catch(() => null);

          if (!user) { await botManager.sendTextMessage([userid], '❌ 未找到用户'); return; }

          const windowId = String(user.fingerprintWindowId);
          const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
          const { getBrowserManager } = await import('../lib/browserManager');
          const config = getLoginFlowConfig(targetPlatform, targetFlowId);
          if (!config) { await botManager.sendTextMessage([userid], '❌ 未找到登录配置'); return; }

          const bm = getBrowserManager();
          const browser = await bm.getBrowser(windowId);
          if (!browser) { await botManager.sendTextMessage([userid], '❌ 无法连接浏览器'); return; }

          try {
            let record = await loginTabRegistry.find(windowId, targetFlowId, browser, config.domain);
            if (!record) {
              record = await loginTabRegistry.openLoginTab(windowId, targetUserId, targetFlowId, browser, config);
            }
            if (record) {
              await record.page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await record.page.waitForTimeout(3000);
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
          const user = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { fingerprintWindowId: true, wechatUserid: true },
          }).catch(() => null);

          if (!user) { await botManager.sendTextMessage([userid], '❌ 未找到用户'); return; }

          const windowId = String(user.fingerprintWindowId);
          const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
          const { getBrowserManager } = await import('../lib/browserManager');
          const config = getLoginFlowConfig(targetPlatform, targetFlowId);
          if (!config) { await botManager.sendTextMessage([userid], '❌ 未找到登录配置'); return; }

          const bm = getBrowserManager();
          const browser = await bm.getBrowser(windowId);
          if (!browser) { await botManager.sendTextMessage([userid], '❌ 无法连接浏览器'); return; }

          try {
            let record = await loginTabRegistry.find(windowId, targetFlowId, browser, config.domain);
            if (!record) {
              record = await loginTabRegistry.openLoginTab(windowId, targetUserId, targetFlowId, browser, config);
            }
            if (record) {
              // F5 刷新：不重新导航，只刷新当前页面
              await record.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
              await record.page.waitForTimeout(3000);
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

        // 匹配 AI 生成回复: 格式 "ai生成 <platform> <commentCid>"（来自 jump_list type=3）
        const aiGenSetup = content.match(/^ai生成\s+(\S+)\s+(\S+)$/);
        if (aiGenSetup) {
          const genPlatform = aiGenSetup[1];
          const genCommentCid = aiGenSetup[2];

          const { prisma: prismaGen } = await import('../lib/prisma');
          const genComment = await prismaGen.comment.findUnique({
            where: { cid: genCommentCid },
            include: { video: { select: { description: true, userId: true } } },
          }).catch(() => null);

          if (!genComment) {
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

          const genUser = await prismaGen.user.findUnique({
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

          const genResult = await replyGenerator.generateReply(ctx);

          if (genResult.success && genResult.reply) {
            await genDb.updateCommentSuggestion(genComment.id, {
              suggestedReply: genResult.reply,
              suggestionStatus: 'ready',
              suggestionModel: genResult.model,
              suggestionLatencyMs: genResult.latencyMs,
            });
            const preview = genResult.reply.length > 80 ? genResult.reply.slice(0, 80) + '...' : genResult.reply;
            await botManager.sendTextMessage([userid], `🤖 AI 回复已生成:\n> ${preview}\n\n模型: ${genResult.model || 'unknown'} · ${genResult.latencyMs}ms\n\n点击 **发送 AI 回复** 按钮即可发送此回复到评论区`);
            logger.info({ commentCid: genCommentCid, commentId: genComment.id, model: genResult.model }, '企微触发的 AI 回复已生成');
          } else {
            await genDb.markSuggestionError(genComment.id, genResult.error || '未知错误');
            await botManager.sendTextMessage([userid], `❌ AI 回复生成失败: ${genResult.error || '未知错误'}`);
          }
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

            const sendUser = await prismaSend.user.findUnique({
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
          const sendUser = await prismaSend.user.findUnique({
            where: { id: sendComment.video.userId },
            select: { id: true, platform: true, fingerprintWindowId: true },
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
            windowId: sendUser.fingerprintWindowId,
            fingerprintWindowId: sendUser.fingerprintWindowId,
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
          const user = await prisma.user.findFirst({
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
              fingerprintWindowId: ctx.windowId,
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
