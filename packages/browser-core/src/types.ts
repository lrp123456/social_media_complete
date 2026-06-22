export type Platform = 'douyin' | 'kuaishou' | 'xiaohongshu';

export type CrawlMode = 'deep' | 'light';

export interface UserConfig {
  windowId: string;
  wechatUserId: string;
  platform: Platform;
}

export interface AppConfig {
  fingerprint: {
    spaceId: string;
    apiPort: number;
    apiKey: string;
  };
  wechat: {
    webhookUrl: string;
    secret: string;
    botId: string;
  };
  users: UserConfig[];
  monitor: {
    intervalActiveMin: number;
    intervalActiveMax: number;
    intervalIdleMin: number;
    intervalIdleMax: number;
    consecutiveChecks: number;
    maxMonitorVideos: number;
  };
  browser: {
    enableWarmup: boolean;
    maxTabReuse: number;
  };
  database: {
    path: string;
  };
  logging: {
    level: string;
  };
}

export enum UserStatus {
  INIT = 'init',
  WARMING_UP = 'warming_up',
  INITIALIZED = 'initialized',
  MONITORING = 'monitoring',
  BLOCKED = 'blocked',
  ERROR = 'error',
}

export interface UserRow {
  id: number;
  fingerprint_window_id: string;
  wechat_userid: string;
  platform: Platform;
  status: string;
  consecutive_no_update: number;
  monitoring_enabled: number;
  cooldown_until: number;
  created_at: string;
  updated_at: string;
}

export interface VideoInfo {
  aweme_id: string;
  description: string;
  create_time: number;
  comment_count: number;
  metrics: Record<string, number>;
}

export interface VideoRow {
  id: string;
  user_id: number;
  description: string;
  create_time: number;
  comment_count: number;
  metrics: string;
  created_at: string;
  updated_at: string;
}

export interface CommentInfo {
  cid: string;
  text: string;
  user_nickname: string;
  user_uid: string;
  digg_count: number;
  create_time: number;
  reply_id: string;
}

export interface MonitorState {
  consecutiveNoUpdate: number;
  lastCheckTime: number;
}

export interface RiskControlDetection {
  detected: boolean;
  type: 'captcha' | 'login_redirect' | 'security_verify' | 'unknown';
  evidence: string;
}

// ── 登录标签页注册表相关类型 ──

/**
 * 登录标签页内存注册表条目
 */
export interface LoginTabRecord {
  page: any; // Page (避免循环引用的 any 类型)
  targetId: string;
  domain: string;
  flowId: string;
  openedAt: number;
  userId: number;
}

/**
 * 来自 selectors.json 的 loginFlows 配置条目
 */
export interface LoginFlowConfig {
  domain: string;
  label: string;
  loginUrl: string;
  closeOnLoginSuccess: boolean;
  loggedOutIndicators: string[];
  loggedInIndicators: string[];
  qrSelectors: string[];
}

/** 登录检测结果 */
export type LoginState = 'logged_in' | 'logged_out' | 'unknown';
