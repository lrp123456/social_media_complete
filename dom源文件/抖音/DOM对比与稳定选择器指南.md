# 抖音创作者中心 DOM 对比与稳定选择器指南

> 更新日期：2026-06-09
> 对比范围：旧版 DOM（2026-06-04 备份）vs 新版 DOM（2026-06-09 抓取）

---

## 一、总体变化概述

本次抖音创作者中心页面改版涉及以下几个方面：

1. **URL 路径变化**：数据中心页面路径从 `data/content-analysis` 改为 `data-center/content`
2. **组件库前缀分化**：不同模块使用不同的组件库前缀，导航用 `douyin-creator-master-*`，数据中心用 `douyin-creator-pc-*`，互动管理用 `douyin-creator-interactive-*`
3. **外层容器类名变化**：部分页面的外层包装类名发生变化（如内容管理页面去掉了 `card-container-onEptt`）
4. **功能区域调整**：高清发布页面移除了"未发布视频继续编辑"提示条和轮播 Banner；评论管理新增了"选择作品"侧边面板
5. **Hash 后缀类名**：大量类名带有哈希后缀（如 `header-hPdheQ`、`tab-container-DjaX1b`），这些哈希值在不同构建版本之间**可能发生变化**

### 各页面变化程度

| 页面 | 变化程度 | 说明 |
|------|---------|------|
| 菜单栏 | ⭐ 几乎无变化 | 所有 class、ID、文本内容完全一致 |
| 高清发布页面 | ⭐⭐ 中等变化 | 移除继续编辑提示和轮播组件，新增外层容器 |
| 内容管理-作品管理 | ⭐⭐ 中等变化 | 外层容器类名变化，核心视频卡片结构不变 |
| 数据中心-作品分析 | ⭐⭐⭐ 完全不同 | 旧文件仅捕获了导航栏，新文件包含实际页面内容 |
| 互动管理-评论管理 | ⭐⭐ 中等变化 | 组件内部类名简化，新增作品选择侧面板 |

---

## 二、各页面前后对比详情

### 2.1 菜单栏（最稳定）

**结论：DOM 结构完全一致，无任何变化。**

**类名对比**：29 个 `douyin-creator-master-*` 前缀类名完全一致，6 个哈希后缀类名也完全一致。

**ID 对比**：28 个导航 ID 完全一致，仅有一个动态生成的 popup ID（`aria-describedby`/`data-popupid`）不同，该值为运行时随机生成，不应作为选择器。

**稳定的 ID 列表**：

```
#douyin-creator-master-side-upload          ← 发布按钮
#douyin-creator-master-side-upload-wrap     ← 发布按钮外层
#douyin-creator-master-menu-nav-home        ← 首页
#douyin-creator-master-menu-nav-activity_management    ← 活动管理
#douyin-creator-master-menu-nav-content     ← 内容管理
#douyin-creator-master-menu-nav-work_manage ← 作品管理
#douyin-creator-master-menu-nav-collection_manage      ← 合集管理
#douyin-creator-master-menu-nav-cooperate_center       ← 共创中心
#douyin-creator-master-menu-nav-right_manage ← 原创保护中心
#douyin-creator-master-menu-nav-interaction  ← 互动管理
#douyin-creator-master-menu-nav-follow_manage ← 关注管理
#douyin-creator-master-menu-nav-fans_manage  ← 粉丝管理
#douyin-creator-master-menu-nav-comment_manage_new  ← 评论管理
#douyin-creator-master-menu-nav-danmaku_manage  ← 弹幕管理
#douyin-creator-master-menu-nav-message_manage  ← 私信管理
#douyin-creator-master-menu-nav-data-center   ← 数据中心
#douyin-creator-master-menu-nav-business_analysis  ← 账号总览
#douyin-creator-master-menu-nav-content_analysis   ← 作品分析
#douyin-creator-master-menu-nav-fans_characteristic  ← 粉丝分析
#douyin-creator-master-menu-nav-following      ← 重点关心
#douyin-creator-master-menu-nav-cash           ← 变现中心
#douyin-creator-master-menu-nav-cash_square    ← 变现广场
#douyin-creator-master-menu-nav-my_task        ← 我的任务
#douyin-creator-master-menu-nav-my_income      ← 我的收入
#douyin-creator-master-menu-nav-create         ← 创作中心
#douyin-creator-master-menu-nav-create_content ← 创作灵感
#douyin-creator-master-menu-nav-study_center   ← 学习中心
#douyin-creator-master-menu-nav-creator_count  ← 抖音指数
```

**导航菜单文本**（完全一致）：首页、活动管理、内容管理（作品管理/合集管理/共创中心/原创保护中心）、互动管理（关注管理/粉丝管理/评论管理/弹幕管理/私信管理）、数据中心（账号总览/作品分析/粉丝分析/重点关心）、变现中心（变现广场/我的任务/我的收入）、创作中心（创作灵感/学习中心/抖音指数）

---

### 2.2 高清发布页面

**URL**：`https://creator.douyin.com/creator-micro/content/upload`（未变化）

#### 移除的元素

| 旧版元素 | 说明 |
|---------|------|
| `form-hint-qb3FwB` 容器 | "你还有上次未发布的视频，是否继续编辑？" 提示条 |
| `continue-s888XU` / `give-up-Tv8CCI` | "继续编辑" / "放弃" 按钮 |
| `container-drag-4k-tag-Et_EDe` | 上传区域的 4K 标签图片 |
| `tooltip-h0elDr` | HDR 视频画质提示 tooltip |
| `slick-*` 系列类名 | 轮播 Banner 组件（slick-slider、slick-list、slick-track 等） |
| `banner-image`、`dot-list-*`、`btn-fade-*` | 轮播 Banner 相关元素 |

#### 新增的元素

| 新版元素 | 说明 |
|---------|------|
| `card-container-creator-layout` | 新的外层容器包装类 |
| `micro-LlzqtC` | 微前端布局标识类 |
| `new-layout` | 新布局标记类 |

#### 保持不变的元素

- 四个 Tab 标签文本：发布视频、发布图文、发布全景视频、发布文章
- 上传拖拽区域：`container-drag-VAfIfu`、`container-drag-title-UafWje`、`container-drag-upload-tL99XD`
- 上传按钮文本："上传视频"、"点击上传 或直接将视频文件拖入此区域"
- 规则链接文本："了解上传规则详情"
- 三个说明卡片：视频大小和格式、视频画质、视频画幅
- Tab 容器哈希类：`tab-container-DjaX1b`、`tab-item-BcCLTS`、`active-i8Pu0m`

---

### 2.3 内容管理-作品管理

**URL**：`https://creator.douyin.com/creator-micro/content/manage`（未变化）

#### 移除的元素

| 旧版元素 | 说明 |
|---------|------|
| `card-container-onEptt` | 旧版外层卡片容器 |
| `card-gkf5WW` + `full-q_Xr0F` | 旧版卡片基类和全屏类 |
| `notpass-info-byomQd` | 审核未通过视频的样式类 |
| `video-card-new-disabled-ypEwV8` | 禁用状态视频卡片样式 |

#### 保持不变的元素（核心结构）

- 页面标题：`title-UUrMOP`（文本"作品管理"）
- 筛选标签：`tab-item-E7ebGh`（全部作品/已发布/审核中/未通过）
- 搜索框：`placeholder="搜索作品"`
- 视频卡片核心类：`video-card-zQ02ng`、`video-card-new-pWwRVu`
- 封面图：`video-card-cover-xx9wyS`
- 标题文本：`info-title-text-YTLo9y`
- 操作按钮区：`op-btns-zl6K1c`、`ghost-btn-xUV8J0`
- 数据指标：`metric-value-k4R5P_`、`metric-label-AX_5OF`
- 加载状态：`load-more-dkW_MA`（文本"加载中…"）
- 视频时长徽章：`badge-pcgoA6`

#### 操作按钮文本（稳定）

编辑作品、设置权限、作品置顶、删除作品

---

### 2.4 数据中心-作品分析

**URL 变化**：`data/content-analysis` → `data-center/content`（路径已更改！）

**注意**：旧版文件仅捕获了导航侧边栏，未包含实际页面内容。以下为新版页面内容分析。

#### 新版页面结构

**组件库前缀**：`douyin-creator-pc-*`（不同于导航的 `douyin-creator-master-*`）

**页面层级**：

```
投稿分析 / 投稿列表          ← 顶部 Tab（douyin-creator-pc-tabs）
├── 筛选区域
│   ├── 投稿分析 / 投稿列表    ← Radio 切换（douyin-creator-pc-radio-buttonRadioGroup）
│   ├── 体裁 下拉框           ← douyin-creator-pc-select
│   └── 发布时间 日期选择器    ← douyin-creator-pc-datepicker
├── 投稿概览（9 个指标卡片）
│   ├── 周期内投稿量
│   ├── 条均点击率
│   ├── 条均5s完播率
│   ├── 条均2s跳出率
│   ├── 条均播放时长
│   ├── 播放量中位数
│   ├── 条均点赞数
│   ├── 条均评论量
│   └── 条均分享量
└── 投稿表现（图表区域）
    └── 播放量 等指标图表
```

**关键稳定文本**：投稿分析、投稿列表、体裁、全部、发布时间、投稿概览、导出数据、投稿表现、播放量

**日期选择器占位符**：开始日期、结束日期

---

### 2.5 互动管理-评论管理

**URL**：`https://creator.douyin.com/creator-micro/interactive/comment`（未变化）

**组件库前缀**：`douyin-creator-interactive-*`

#### 移除的元素

| 旧版元素 | 说明 |
|---------|------|
| `douyin-creator-interactive-avatar-img` | 头像图片类（简化为只用 avatar 基类） |
| `douyin-creator-interactive-input-wrapper-*` 系列 | 输入框包装器的细粒度类 |
| `douyin-creator-interactive-select-*` 系列 | 下拉框的细粒度内部类 |
| `douyin-creator-interactive-spin-*` 系列 | 加载动画的细粒度类 |
| `lottie-heart-broken-l90TEM` | 空状态的 Lottie 动画 |
| `load-more-pDyh1o` / `loading-NTmKHl` | "加载更多"和"加载中"元素 |
| `btn-MFRja5` → `btn-MFRja1` | 表情按钮类名哈希变化 |

#### 新增的元素（侧面板）

新版将"选择作品"侧面板（sidesheet）集成到了评论管理页面 DOM 中：

```
douyin-creator-interactive-sidesheet          ← 侧面板容器
douyin-creator-interactive-sidesheet-header   ← 面板头部
douyin-creator-interactive-sidesheet-title    ← 面板标题"作品列表"
douyin-creator-interactive-sidesheet-body     ← 面板内容
douyin-creator-interactive-sidesheet-mask     ← 遮罩层
```

#### 保持不变的核心元素

- 页面标题：`title-V3HpNi`（文本"评论管理"）
- 选择作品按钮：文本"选择作品"
- 当前作品信息：`container-Fj4NxK`（含封面 `cover-WUCGcS`、标题 `title-iqC0Gj`）
- Tab 栏：`tabBar-qfUBd3`、`tabItem-aV5mwd`、`active-RCRuKb`
- 评论输入框：`placeholder="有爱评论，说点好听的~"`
- 搜索框：`placeholder="搜索评论关键词"`
- 筛选文本：全部评论、全部人群、最新发布
- 评论内容：`comment-content-text-JvmAKq`
- 用户名：`username-aLgaNB`
- 时间戳：`time-NRtTXO`
- 操作按钮文本：回复、删除、举报

---

## 三、稳定选择器策略

### 核心原则

> **不要使用带哈希后缀的 CSS 类名作为选择器**（如 `.header-hPdheQ`、`.tab-container-DjaX1b`），因为这些哈希值在每次构建部署时可能发生变化。应优先使用以下稳定策略。

### 策略优先级（从高到低）

#### 优先级 1：ID 选择器（最稳定）

导航菜单的所有元素都有稳定的 ID，这是最可靠的选择方式。

```javascript
// ✅ 推荐：通过 ID 点击导航菜单
document.querySelector('#douyin-creator-master-menu-nav-content')        // 内容管理
document.querySelector('#douyin-creator-master-menu-nav-work_manage')    // 作品管理
document.querySelector('#douyin-creator-master-menu-nav-comment_manage_new') // 评论管理
document.querySelector('#douyin-creator-master-menu-nav-content_analysis')   // 作品分析
document.querySelector('#douyin-creator-master-menu-nav-data-center')        // 数据中心

// ✅ 推荐：通过 ID 点击发布按钮
document.querySelector('#douyin-creator-master-side-upload')
```

#### 优先级 2：文本内容匹配（非常稳定）

按钮文本、Tab 标签、菜单文字等用户可见文本极少改变，是最通用的稳定选择方式。

```javascript
// ✅ 推荐：通过文本查找按钮
function findByText(selector, text) {
  return [...document.querySelectorAll(selector)].find(
    el => el.textContent.trim() === text
  )
}

// 点击"投稿列表"单选按钮
findByText('span', '投稿列表')

// 点击"已发布"筛选标签
findByText('span', '已发布')

// 点击"编辑作品"操作按钮
findByText('span', '编辑作品')

// 点击"发送"按钮
findByText('button', '发送')

// 通过文本查找所有 Tab
const tabs = [...document.querySelectorAll('span')].filter(
  el => ['全部作品', '已发布', '审核中', '未通过'].includes(el.textContent.trim())
)
```

**各页面关键文本选择器**：

| 页面 | 查找目标 | 选择器方法 | 文本内容 |
|------|---------|-----------|---------|
| 菜单栏 | 导航菜单项 | `span` 文本匹配 | 首页/作品管理/评论管理/作品分析... |
| 发布页 | Tab 标签 | `span` 文本匹配 | 发布视频/发布图文/发布全景视频/发布文章 |
| 发布页 | 上传按钮 | `span` 文本匹配 | 上传视频 |
| 发布页 | 规则链接 | `a` 文本包含 | 了解上传规则详情 |
| 内容管理 | 筛选标签 | `span` 文本匹配 | 全部作品/已发布/审核中/未通过 |
| 内容管理 | 操作按钮 | `span` 文本匹配 | 编辑作品/设置权限/作品置顶/删除作品 |
| 内容管理 | 数据指标标签 | `span` 文本匹配 | 播放/点赞/评论/分享 |
| 数据中心 | 顶部 Tab | `span` 文本匹配 | 投稿分析/投稿列表 |
| 数据中心 | Radio 切换 | `span` 文本匹配 | 投稿分析/投稿列表 |
| 数据中心 | 指标卡片标题 | `span` 文本匹配 | 周期内投稿量/条均点击率/... |
| 数据中心 | 导出数据 | `span` 文本匹配 | 导出数据 |
| 数据中心 | 筛选标签 | `span` 文本匹配 | 体裁/全部/发布时间 |
| 评论管理 | 页面标题 | `h1`/`span` 文本匹配 | 评论管理 |
| 评论管理 | 选择作品按钮 | `span` 文本匹配 | 选择作品 |
| 评论管理 | 筛选下拉 | `span` 文本匹配 | 全部评论/全部人群/最新发布 |
| 评论管理 | 操作按钮 | `span` 文本匹配 | 回复/删除/举报 |

#### 优先级 3：placeholder 属性（稳定）

输入框的 placeholder 文本通常不会改变。

```javascript
// ✅ 推荐：通过 placeholder 查找输入框
document.querySelector('input[placeholder="搜索作品"]')        // 内容管理搜索
document.querySelector('input[placeholder="搜索评论关键词"]')   // 评论搜索
document.querySelector('[placeholder="有爱评论，说点好听的~"]') // 评论输入框
document.querySelector('input[placeholder="开始日期"]')         // 数据中心开始日期
document.querySelector('input[placeholder="结束日期"]')         // 数据中心结束日期
```

#### 优先级 4：组件库前缀类名（较稳定）

带语义化前缀的类名（不含哈希后缀的部分）在版本间保持稳定。

```javascript
// ✅ 推荐：通过组件库前缀类名查找
// 导航相关
document.querySelector('.douyin-creator-master-navigation-item-selected')  // 当前选中菜单
document.querySelector('.douyin-creator-master-navigation-sub-open')       // 展开的子菜单
document.querySelector('.douyin-creator-master-button-primary')            // 主按钮

// 数据中心相关
document.querySelector('.douyin-creator-pc-tabs-pane-active')              // 当前激活的 Tab
document.querySelector('.douyin-creator-pc-radio-checked')                 // 选中的 Radio
document.querySelector('.douyin-creator-pc-select')                        // 下拉选择框
document.querySelector('.douyin-creator-pc-datepicker')                    // 日期选择器

// 评论管理相关
document.querySelector('.douyin-creator-interactive-button-primary')       // 主按钮
document.querySelector('.douyin-creator-interactive-tabs-pane-active')     // 激活的 Tab
document.querySelector('.douyin-creator-interactive-sidesheet')            // 侧面板
document.querySelector('.douyin-creator-interactive-avatar')               // 用户头像

// Semi UI 框架（第三方库，极稳定）
document.querySelector('.semi-tabs-pane-active')                           // Semi Tab 激活态
document.querySelector('.semi-input')                                      // Semi 输入框
document.querySelector('.semi-button-primary')                             // Semi 主按钮
```

#### 优先级 5：ARIA 属性（稳定）

```javascript
// ✅ 推荐：通过 ARIA 属性查找
document.querySelector('[role="tab"][aria-selected="true"]')   // 当前选中的 Tab
document.querySelector('[role="tabpanel"]')                     // Tab 面板
document.querySelector('[contenteditable="true"]')              // 可编辑区域（评论输入）
```

#### 优先级 6：URL 路径匹配（用于页面检测）

```javascript
// ✅ 推荐：通过 URL 判断当前页面
const url = window.location.href
if (url.includes('/creator-micro/content/upload'))    { /* 发布页面 */ }
if (url.includes('/creator-micro/content/manage'))    { /* 作品管理 */ }
if (url.includes('/creator-micro/data-center/content')) { /* 作品分析 */ }
if (url.includes('/creator-micro/interactive/comment')) { /* 评论管理 */ }
```

**注意 URL 变化**：数据中心路径已从 `data/content-analysis` 变为 `data-center/content`。

---

## 四、不稳定选择器警告

### 绝对不要使用的选择器模式

#### ❌ 带哈希后缀的类名

```javascript
// ❌ 错误示范：这些哈希值会在部署时改变！
document.querySelector('.header-hPdheQ')              // 可能变成 header-XyZ123
document.querySelector('.tab-container-DjaX1b')        // 可能变成 tab-container-AbC456
document.querySelector('.video-card-zQ02ng')           // 可能变成 video-card-DeF789
document.querySelector('.container-AFENbv')            // 可能变成 container-GhI012
document.querySelector('.comment-content-text-JvmAKq') // 可能变成 comment-content-text-JkL345
```

#### ❌ 动态生成的 ID

```javascript
// ❌ 错误示范：运行时随机生成的 ID
document.querySelector('[data-popupid="wwyqmtj"]')     // 每次打开都不同
document.querySelector('[aria-describedby="jh7qnam"]') // 每次打开都不同
document.querySelector('#foz24ix')                      // 评论元素 ID，动态生成
```

#### ❌ Lottie 动画元素 ID

```javascript
// ❌ 错误示范：Lottie 内部元素 ID
document.querySelector('#__lottie_element_4')  // 动画内部元素，随时变化
```

### 已确认变化的哈希类名

| 旧版 | 新版 | 说明 |
|------|------|------|
| `btn-MFRja5` | `btn-MFRja1` | 评论输入区的表情按钮 |

### 已确认移除的功能区域

| 移除元素 | 所属页面 | 说明 |
|---------|---------|------|
| 继续编辑提示条 (`form-hint-*`) | 高清发布 | "你还有上次未发布的视频"提示已移除 |
| 轮播 Banner (`slick-*`) | 高清发布 | 上传区域的轮播广告/提示已移除 |
| 4K 标签图 (`container-drag-4k-tag-*`) | 高清发布 | 拖拽区域的 4K 标签不再显示 |
| 审核未通过样式 (`notpass-info-*`) | 内容管理 | 未通过审核视频的特殊样式 |
| 禁用卡片样式 (`video-card-new-disabled-*`) | 内容管理 | 禁用态卡片的特殊样式 |
| 心碎动画 (`lottie-heart-broken-*`) | 评论管理 | 空评论状态的 Lottie 动画 |

---

## 五、推荐选择器速查表

### 5.1 导航操作

```javascript
// 点击"发布"按钮
document.querySelector('#douyin-creator-master-side-upload').click()

// 点击任意导航菜单（以"作品管理"为例）
document.querySelector('#douyin-creator-master-menu-nav-work_manage').click()

// 展开子菜单（以"内容管理"为例）
document.querySelector('#douyin-creator-master-menu-nav-content').click()

// 获取当前选中的菜单项
document.querySelector('.douyin-creator-master-navigation-item-selected')
  .querySelector('.douyin-creator-master-navigation-item-text').textContent
```

### 5.2 发布页面

```javascript
// 切换 Tab（以"发布图文"为例）
[...document.querySelectorAll('span')]
  .find(el => el.textContent.trim() === '发布图文').click()

// 查找文件上传 input
document.querySelector('input[type="file"][accept*="video"]')

// 点击"上传视频"按钮
[...document.querySelectorAll('span')]
  .find(el => el.textContent.trim() === '上传视频').click()

// 获取拖拽上传区域
document.querySelector('[class*="container-drag-"]')
```

### 5.3 内容管理

```javascript
// 切换筛选标签（以"已发布"为例）
[...document.querySelectorAll('span')]
  .find(el => el.textContent.trim() === '已发布').click()

// 搜索作品
const searchInput = document.querySelector('input[placeholder="搜索作品"]')
searchInput.value = '关键词'
searchInput.dispatchEvent(new Event('input', { bubbles: true }))

// 获取所有视频卡片
document.querySelectorAll('[class*="video-card-"]')

// 获取视频标题
document.querySelectorAll('[class*="info-title-text-"]')

// 获取作品总数（"共 N 个作品"）
[...document.querySelectorAll('span')]
  .find(el => el.textContent.includes('个作品')).textContent

// 点击某视频的操作按钮（以"编辑作品"为例，需先定位到具体卡片）
const card = document.querySelectorAll('[class*="video-card-"]')[0]
[...card.querySelectorAll('span')]
  .find(el => el.textContent.trim() === '编辑作品').click()
```

### 5.4 数据中心

```javascript
// 切换"投稿分析"/"投稿列表"
[...document.querySelectorAll('span')]
  .find(el => el.textContent.trim() === '投稿列表').click()

// 获取所有指标卡片的标题
[...document.querySelectorAll('[class*="title-"]')]
  .filter(el => ['周期内投稿量','条均点击率','条均5s完播率','条均2s跳出率',
    '条均播放时长','播放量中位数','条均点赞数','条均评论量','条均分享量']
    .includes(el.textContent.trim()))

// 点击"导出数据"
[...document.querySelectorAll('span')]
  .find(el => el.textContent.trim() === '导出数据').click()

// 获取"体裁"下拉框
document.querySelector('.douyin-creator-pc-select')

// 获取日期范围选择器
document.querySelectorAll('.douyin-creator-pc-datepicker-input')
```

### 5.5 评论管理

```javascript
// 点击"选择作品"按钮
[...document.querySelectorAll('span')]
  .find(el => el.textContent.trim() === '选择作品').click()

// 评论输入框输入
const commentInput = document.querySelector('[contenteditable="true"][placeholder]')
commentInput.textContent = '评论内容'
commentInput.dispatchEvent(new Event('input', { bubbles: true }))

// 点击"发送"按钮
[...document.querySelectorAll('button')]
  .find(el => el.textContent.trim() === '发送').click()

// 搜索评论
const searchInput = document.querySelector('input[placeholder="搜索评论关键词"]')

// 获取所有评论的用户名
document.querySelectorAll('[class*="username-"]')

// 获取所有评论的内容
document.querySelectorAll('[class*="comment-content-text-"]')

// 操作某条评论（以"回复"为例，需先定位到具体评论）
const comment = document.querySelectorAll('[class*="comment-content-text-"]')[0]
const commentParent = comment.closest('[class*="content-"]')
;[...commentParent.querySelectorAll('span')]
  .find(el => el.textContent.trim() === '回复').click()
```

---

## 六、通用辅助函数

```javascript
/**
 * 通过文本内容查找元素
 * @param {string} tag - HTML 标签名（如 'span', 'button', 'div'）
 * @param {string} text - 要匹配的文本内容
 * @param {Element} parent - 可选的父元素
 * @returns {Element|null}
 */
function findByText(tag, text, parent = document) {
  return [...parent.querySelectorAll(tag)].find(
    el => el.textContent.trim() === text
  ) || null
}

/**
 * 通过文本内容查找所有匹配元素
 */
function findAllByText(tag, text, parent = document) {
  return [...parent.querySelectorAll(tag)].filter(
    el => el.textContent.trim() === text
  )
}

/**
 * 通过文本内容模糊查找
 */
function findByTextContains(tag, text, parent = document) {
  return [...parent.querySelectorAll(tag)].find(
    el => el.textContent.includes(text)
  ) || null
}

/**
 * 通过哈希前缀查找元素（不依赖完整哈希值）
 * 注意：仅当没有更好选择器时使用
 */
function findByClassPrefix(prefix, parent = document) {
  return parent.querySelector(`[class*="${prefix}"]`)
}

/**
 * 等待元素出现
 */
function waitForElement(selectorOrFn, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const check = typeof selectorOrFn === 'function'
      ? selectorOrFn
      : () => document.querySelector(selectorOrFn)
    const el = check()
    if (el) return resolve(el)
    const observer = new MutationObserver(() => {
      const el = check()
      if (el) { observer.disconnect(); resolve(el) }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => { observer.disconnect(); reject(new Error('Timeout')) }, timeout)
  })
}
```

---

## 七、组件库前缀速查

| 前缀 | 所属模块 | 使用页面 | 稳定性 |
|------|---------|---------|--------|
| `douyin-creator-master-*` | 主导航/布局框架 | 菜单栏、所有页面 | ⭐⭐⭐ 极稳定 |
| `douyin-creator-interactive-*` | 互动管理模块 | 评论管理 | ⭐⭐⭐ 极稳定 |
| `douyin-creator-pc-*` | PC 数据中心模块 | 数据中心/作品分析 | ⭐⭐⭐ 极稳定 |
| `semi-*` | Semi Design UI 框架 | 发布页面、内容管理 | ⭐⭐⭐ 极稳定（第三方库） |
| `ant-carousel` | Ant Design 轮播 | 发布页面 | ⭐⭐⭐ 极稳定（第三方库） |
| `dux-icon*` | Dux 图标系统 | 评论管理 | ⭐⭐ 较稳定 |
| 带哈希后缀的类名 | 各模块 CSS-in-JS | 所有页面 | ❌ 不稳定 |

---

## 八、文件清单

当前 `dom源文件/抖音/` 目录下的文件：

| 文件名 | 页面 | URL | 更新时间 |
|--------|------|-----|---------|
| 菜单栏.txt | 导航菜单 | creator.douyin.com/creator-micro/home | 2026-06-09 |
| 高清发布页面.txt | 发布视频 | creator.douyin.com/creator-micro/content/upload | 2026-06-09 |
| 内容管理-作品管理.txt | 作品管理 | creator.douyin.com/creator-micro/content/manage | 2026-06-09 |
| 数据中心-作品分析.txt | 作品分析 | creator.douyin.com/creator-micro/data-center/content | 2026-06-09 |
| 互动管理-评论管理.txt | 评论管理 | creator.douyin.com/creator-micro/interactive/comment | 2026-06-09 |
| DOM对比与稳定选择器指南.md | 本文档 | - | 2026-06-09 |

旧版文件备份位置：`backup_抖音_dom/`（工作目录下）
