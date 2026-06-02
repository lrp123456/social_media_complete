# 阶段 5：Next.js 前端构建 - 设计文档

> **日期**: 2026-06-02
> **版本**: 1.0.0

---

## 一、目标

构建基于 Stitch UI 设计系统的 Next.js Admin Dashboard，实现 4 核心管理页面，全面对接 TS 后端真实 API。

---

## 二、产出物清单（17 文件）

### 项目骨架

| 文件 | 用途 |
|------|------|
| `package.json` | Next.js 14 + React 18 + shadcn 依赖 |
| `next.config.js` | standalone 输出模式 |
| `tsconfig.json` | TypeScript 严格模式 + path aliases |
| `tailwind.config.js` | Obsidian & Cobalt 设计系统 token |
| `postcss.config.js` | Tailwind + Autoprefixer |
| `Dockerfile` | Node.js 20 slim 容器 |

### 核心组件

| 文件 | 用途 |
|------|------|
| `src/components/Providers.tsx` | React Query + Zustand 全局 Provider |
| `src/components/layout/Sidebar.tsx` | 5 模块导航侧边栏 |
| `src/app/layout.tsx` | 根 Layout（Sidebar + Provider） |
| `src/app/globals.css` | 全局样式 + Tailwind 指令 |

### 页面（4 页）

| 路由 | 页面 | 功能 |
|------|------|------|
| `/` | 运营看板 | Dashboard 统计卡片 |
| `/settings` | 系统设置 | 平台配置 CRUD + LLM Keys |
| `/matrix` | 矩阵运营中心 | 评论监控用户列表 |
| `/publish` | 一键发布 | 多平台分发 + 元数据填写 |
| `/creation` | 智能创作 | AI 脚本生成 + 流水线状态 |

### 工具库

| 文件 | 用途 |
|------|------|
| `src/lib/api.ts` | Axios 实例 (X-Trace-Id 注入) |
| `src/lib/utils.ts` | cn() 工具函数 |
| `src/hooks/useApi.ts` | TanStack React Query hooks (对接 TS 后端真实 API) |

---

## 三、设计系统映射

基于 `stitch_ai_media_matrix_admin/obsidian_cobalt_modular_system/DESIGN.md`：

| Token | 值 |
|-------|-----|
| Primary | `#004ac6` |
| Primary Container | `#2563eb` |
| Surface | `#f8f9fa` |
| On-Surface | `#191c1d` |
| On-Surface Variant | `#434655` |
| Border Radius | `0.25rem` / `0.5rem` / `0.75rem` / `1rem` |
| Layout | 侧边栏 240px + 主内容区 flex-1 |
| Nav Modules | 运营看板 / 矩阵运营中心 / 智能创作 / 一键发布 / 系统设置 |

---

## 四、Mock 数据替换状态

| 页面 | 当前状态 | 对接 API |
|------|---------|---------|
| 运营看板 | 静态数据 | `GET /api/v1/status` |
| 系统设置 | ✅ 已对接真实 API | `GET/POST /api/v1/config` |
| 矩阵运营中心 | 静态 Mock (TODO) | `GET /api/v1/users` |
| 一键发布 | 表单已构建 (TODO) | `POST /api/v1/publish/video` |
| 智能创作 | 静态 Mock (TODO) | `POST /api/v1/tasks/render` |

---

## 五、全栈 5 阶段完成总结

| Phase | Commit | 文件 | 行数 | 核心交付 |
|-------|--------|------|------|---------|
| 1 | `9e4ae0d` | 12 | 1,234 | Monorepo + Prisma + Docker + Trace ID |
| 2 | `8c8849b` | 24 | 3,913 | browser-core + shared-config + selectors |
| 3 | `f680d30` | 26 | 2,173 | TS API Gateway + 7 平台发布器 + BullMQ |
| 4 | `fb95e21` | 15 | 819 | Python Worker (FastAPI + ARQ + FFmpeg) |
| 5 | 待提交 | 17 | ~600 | Next.js Admin Dashboard (4 页面) |
| **合计** | | **94** | **~8,740** | **全栈微服务架构** |

---

> **审查状态**: 等待用户评审
