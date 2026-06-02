// @social-media/browser-core - 核心浏览器工具链
// CDP 协议层 + 反检测 HumanActions 委托层

export { CDPClient } from './cdpClient';
export { CDPDomNavigator } from './cdpDom';
export { CDPHumanMouse } from './cdpMouse';
export { CDPScroller } from './cdpScroller';
export { TrajectoryGenerator } from './trajectory';
export { BehaviorNoise } from './behaviorNoise';
export { HumanActions } from './humanActions';
export { BrowserManager } from './browserManager';
export { PageStateManager } from './pageStateManager';
export { RequestInterceptor } from './interceptor';
export { ExitStrategy } from './exitStrategy';

// Types
export * from './types';
