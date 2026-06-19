// 队列相关 TypeScript 类型

export type QueueTaskType = 'monitor' | 'publish' | 'reply';

export type QueueTaskStatus = 'running' | 'queued';

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskProgress {
  phase: string;
  step?: string;
  percent: number;
  detail?: string;
}

export interface QueueTask {
  executionId?: string;
  taskId: string;
  taskType: QueueTaskType;
  platform: string;
  windowId?: string;
  windowName?: string;
  status: QueueTaskStatus;
  phaseIndex?: number;
  totalPhases?: number;
  progress?: TaskProgress | null;
}

export interface ActiveQueueData {
  total: number;
  running: number;
  queued: number;
  tasks: QueueTask[];
}

export interface ExecutionHistoryItem {
  id: string;
  taskId: string;
  taskType: QueueTaskType;
  platform: string;
  windowId: string;
  windowName: string;
  userId: number | null;
  status: ExecutionStatus;
  currentPhase: string | null;
  phaseIndex: number | null;
  totalPhases: number | null;
  progressPercent: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  isDebugMode: boolean;
  createdAt: string;
}

export interface HistoryData {
  items: ExecutionHistoryItem[];
  total: number;
  page: number;
  limit: number;
}

export interface SelectorTry {
  selector: string;
  hit: boolean;
  isPrimary: boolean;
}

export interface ExecutionStep {
  id: string;
  executionId: string;
  phase: string;
  stepIndex: number;
  label: string;
  status: 'success' | 'failed' | 'fallback';
  durationMs: number | null;
  selectorTries: SelectorTry[] | null;
  mouseAction: string | null;
  extra: Record<string, any> | null;
  snapshotPath: string | null;
  createdAt: string;
}

export interface ExecutionDetail extends ExecutionHistoryItem {
  steps: ExecutionStep[];
}

// 任务类型对应的显示配置
export const TASK_TYPE_CONFIG: Record<QueueTaskType, { label: string; color: string; icon: string }> = {
  monitor: { label: '视频监控', color: '#10b981', icon: 'monitoring' },
  reply: { label: '回复评论', color: '#f59e0b', icon: 'message-square' },
  publish: { label: '视频发布', color: '#6366f1', icon: 'send' },
};

export const PHASE_LABELS: Record<string, string> = {
  reply: '准备 → 导航 → 定位视频 → 等待评论 → 执行回复 → 完成',
  monitor: 'Phase1 采集视频 → Phase2 采集评论 → Phase3 汇总',
  publish: '登录 → 上传 → 填写信息 → 发布确认',
};
