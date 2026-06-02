# 阶段 2：公共包底座消减去重 - 设计文档

> **日期**: 2026-06-02
> **作者**: AI Orchestrator
> **版本**: 1.0.0

---

## 一、目标

提取 `my_folder` 项目的浏览器自动化核心代码到独立的公共包，消除代码重复，建立跨应用共享的类型和配置基础。

---

## 二、产出物清单

### packages/browser-core/

| 文件 | 来源 | 用途 |
|------|------|------|
| `src/cdpClient.ts` | my_folder | CDP 协议底层客户端 |
| `src/cdpDom.ts` | my_folder | 零 JS 执行 DOM 导航器 |
| `src/cdpMouse.ts` | my_folder | 贝塞尔轨迹 + 高斯偏移鼠标 |
| `src/cdpScroller.ts` | my_folder | 容器检测 + 惯性滚动 |
| `src/trajectory.ts` | my_folder | 贝塞尔曲线 + Fitts 定律 |
| `src/behaviorNoise.ts` | my_folder | 行为噪声注入 |
| `src/humanActions.ts` | my_folder | ★ 核心入口 - CDP 上下文管理 |
| `src/browserManager.ts` | my_folder | RoxyBrowser/BitBrowser 连接管理 |
| `src/pageStateManager.ts` | my_folder | 页面刷新指纹管理 |
| `src/interceptor.ts` | my_folder | CDP Network 响应拦截 |
| `src/exitStrategy.ts` | my_folder | 退出策略（随机导航） |
| `src/types.ts` | my_folder | 全局类型定义 |
| `src/index.ts` | 新建 | Barrel exports |

### packages/shared-config/

| 文件 | 用途 |
|------|------|
| `src/platforms.ts` | 7 平台元数据定义（名称、URL、颜色、浏览器需求） |
| `src/config.ts` | Zod 校验的环境变量加载器 |
| `src/index.ts` | Barrel exports |

### packages/selectors/

| 文件 | 用途 |
|------|------|
| `src/index.ts` | 选择器注册表（Prisma 持久化 + 三级降级：DB → Cache → Default） |

---

## 三、包依赖关系

```
browser-core
  ├── patchright (^1.59.0)
  └── [独立包 - 无内部依赖]

shared-config
  ├── dotenv (^16.4.0)
  ├── zod (^3.23.0)
  └── [独立包 - 无内部依赖]

selectors
  ├── @prisma/client (^6.0.0)
  └── @social-media/shared-config (PlatformName 类型)
```

---

## 四、选择器三级降级机制

```
DB 自定义选择器 (custom_selectors 表)
  ↓ 未命中
内存缓存 (Map<platform:key, SelectorDef>)
  ↓ 未命中
硬编码默认值 (DEFAULT_*_SELECTORS 常量)
```

---

## 五、下一步

进入 **阶段 3：TS 后端重构 + 发布器迁移**
- 初始化 `apps/ts-api-gateway/` 完整骨架
- 创建 `BasePublisher` 抽象基类
- 重写 7 平台发布器
- 注入 Redlock 分布式锁
- 实现 Webhook 接收端点

---

> **审查状态**: 等待用户评审
