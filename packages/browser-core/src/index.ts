// @social-media/browser-core - 核心浏览器工具链
// CDP 协议层 + 反检测 HumanActions 委托层

// Re-export logger
export { rootLogger } from '../logger';

export { CDPClient } from './cdpClient';
export { CDPDomNavigator } from './cdpDom';
export { CDPHumanMouse } from './cdpMouse';
export { CDPScroller } from './cdpScroller';
export { TrajectoryGenerator } from './trajectory';
export { BehaviorNoise } from './behaviorNoise';
export { HumanActions, FindResult, FallbackConfig } from './humanActions';
export { BrowserManager, BitWindowOpener } from './browserManager';
export type { WindowOpener } from './browserManager';
export {
  SelectorReader,
  DEFAULT_SELECTOR_CONFIG,
} from './selectorConfig';
export type {
  SelectorConfig,
  SelectorEntry,
  PlatformSelectors,
  SelectorType,
  SelectorPurpose,
  SelectorCategory,
  PublishFlowRules,
  DisabledCheckMethod,
  VisibilityCheckMethod,
  UrlMonitorEntry,
  ResponseExtraction,
  PaginationRule,
  HttpMethod,
} from './selectorConfig';
export { PageStateManager } from './pageStateManager';
export { RequestInterceptor } from './interceptor';
export { ExitStrategy, PageType } from './exitStrategy';

export { LoginTabRegistry } from './loginTabRegistry';

// Types
export * from './types';

export { MaintenanceProbe, PROBE_CHANNEL } from './maintenanceProbe';
export type { ProbeContext, SelectorOp, UrlInterceptOp, RedisPusher } from './maintenanceProbe';
export { createProxiedPage, PROXY_INTERCEPT_METHODS } from './pageProxy';
export { SelectorRegistry } from './selectorRegistry';
export type { ResolvedSelector } from './selectorRegistry';
export { sanitizeSnapshot } from './snapshotSanitizer';
