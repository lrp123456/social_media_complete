# 快手创作者中心 DOM 对比与稳定选择器指南

> 更新日期：2026-06-10
> 对比范围：旧版 DOM（2026-06-04 备份）vs 新版 DOM（2026-06-10 抓取）

---

## 一、总体变化概述

快手创作者中心（cp.kuaishou.com）的 DOM 结构在新旧版本间**高度一致**，未发生重大前端重构。所有核心 CSS 类名、BEM 命名规范、Vue `data-v-*` 作用域哈希、Element UI / Ant Design 组件类名、CSS Modules 哈希后缀均保持一致。

### 技术栈特征

- **Vue.js** 框架（`data-v-*` 作用域属性）
- **Element UI** 组件库（`el-menu`、`el-tabs`、`el-dialog` 等）
- **Ant Design**（发布页面的 `ant-tabs`）
- **CSS Modules**（发布页面和编辑表单使用 `_name_hash_N` 格式类名）

### 各页面变化程度

| 页面 | 变化程度 | 说明 |
|------|---------|------|
| 菜单栏 | ⭐ 完全一致 | 所有类名、文本、结构完全相同 |
| 发布作品页面 | ⭐ 完全一致 | CSS Modules 哈希值未变化 |
| 内容管理-作品管理 | ⭐ 完全一致 | 所有 BEM 类名和结构一致 |
| 数据中心-作品分析 | ⭐ 完全一致 | 类名和结构一致，旧文件有分页组件 |
| 互动管理-评论管理 | ⭐⭐ 小幅变化 | 新增"置顶"操作和排序选项 |

### URL 结构（未变化）

| 页面 | URL |
|------|-----|
| 首页 | `cp.kuaishou.com/profile` |
| 发布作品 | `cp.kuaishou.com/article/publish/video` |
| 作品管理 | `cp.kuaishou.com/article/manage/video` |
| 作品分析 | `cp.kuaishou.com/statistics/article` |
| 评论管理 | `cp.kuaishou.com/article/comment` |

---

## 二、各页面前后对比详情

### 2.1 菜单栏（完全一致）

**所有 CSS 类名、ID、文本内容在新旧版本间完全一致。**

**核心类名**：`sidebar`、`vertical-menu el-menu`、`publish-button`、`el-submenu`、`el-submenu__title`、`el-menu-item`、`el-menu--inline`、`side-bar-divider`、`icon-image`

**Vue 作用域哈希**：`data-v-08ce92df`（整个侧边栏共用）

**菜单结构**（一致）：
- 发布作品（顶部按钮）
- 首页
- 内容管理：作品管理、合集管理、创建合集（隐藏）
- 互动管理：评论管理
- 数据中心：数据概览、作品分析、直播数据、粉丝分析
- 成长中心
- 创作服务：创作灵感、我的灵感（隐藏）、活动中心、热点榜单、创作学院
- 其他服务：音乐人、作品推广、推广资源管理、创建直播

**图标 URL 模式**：`//p2-plat.wskwai.com/kos/nlav11104/static/ks-cp/img/icon_*_2025.*.svg`

### 2.2 发布作品页面（完全一致）

**微前端架构**：`article-publish-video-container` 内加载 `onvideo-cp` 微前端模块。

**CSS Modules 哈希值完全一致**（说明 CSS 模块未重新编译）：
- `_publish-container_1tgwe_7`
- `_dragger-container_1j3uy_39`
- `_upload-btn_1j3uy_87`
- `_draft-bar_1788x_12`
- `_onvideo-bar_1ltc5_12`
- 等（所有哈希后缀一致）

**Ant Design 类名一致**：`ant-tabs`、`ant-tabs-tab`、`ant-tabs-tab-active`、`ant-tabs-tabpane` 等。

**Tab 文本一致**：上传视频、上传图文、上传全景视频

**规则文本一致**：
- 视频大小：支持时长1小时以内，最大12GB
- 视频格式：支持常见视频格式，推荐使用mp4
- 视频分辨率：最高支持8K，推荐1080p及以上

**草稿提示一致**："还有上次未发布的视频，是否继续编辑？" + "继续编辑"/"放弃"

**文件 input accept 属性一致**：`video/*,.mp4,.mov,.flv,.f4v,.webm,.mkv,.rm,.rmvb,.m4v,.3gp,.3g2,.wmv,.avi,.asf,.mpg,.mpeg,.ts`

### 2.3 内容管理-作品管理（完全一致）

**所有 BEM 类名完全一致**。

**核心类名**：
- 页面容器：`works-manage`
- 筛选区：`main`、`label`、`day`、`day__num`、`search`、`search-input`
- 标签区：`works-manage__status`、`works-manage__status__count`
- 视频列表：`main-container-infinite-list`
- 视频卡片：`video-item`、`video-item--published`
- 封面：`video-item__cover`、`video-item__cover__img`、`video-item__cover__duration`
- 详情：`video-item__detail`、`video-item__detail__row`、`video-item__detail__row__title`、`video-item__detail__row__status`、`video-item__detail__row__date`、`video-item__detail__row__label`
- 操作：`video-item__controls`、`video-item__controls__operations`、`video-item__controls__operations__operation`

**Element UI 类名一致**：`el-tabs`、`el-tabs__item`、`el-date-editor`、`el-range-editor` 等。

**Placeholder 一致**：`placeholder="输入搜索关键词"`、`placeholder="开始日期"`、`placeholder="结束日期"`

**操作按钮文本一致**：作品置顶、查看数据、编辑作品、删除作品

**Tab 标签一致**：全部作品（`#tab-0`）、已发布（`#tab-1`）、待发布（`#tab-2`）、未通过（`#tab-3`）

### 2.4 数据中心-作品分析（完全一致）

**核心类名一致**：
- 页面容器：`statistics_article_list`
- 标题区：`title`、`text`、`desc`、`file_upload`
- 筛选区：`selector`、`sort_button`、`select_item`、`sort_img`、`tag_selector`、`option`
- 列表区：`list_container`、`list`、`article_item`
- 数据指标：`data_table`、`data_item`、`data_item_name`、`data_item_value`

**排序按钮文本一致**：时间、播放、点赞、评论

**标签筛选项一致**：公开作品、隐私作品、作品违规、现金激励、流量助推

**数据指标名称一致**（6项）：播放量、完播率、评论量、点赞量、收藏量、涨粉量

**旧版独有元素**（新版未捕获但不代表已删除）：
- `el-pagination` 分页组件
- `transmission-info` 传输信息类
- `help-desc`、`help-tag` 帮助提示类

### 2.5 互动管理-评论管理（小幅变化）

**核心类名一致**：
- 页面容器：`comment`
- 头部：`comment__header`、`comment__header__video-btn`
- 内容：`comment__content`
- 视频信息：`comment-home-video`、`video-info`、`video-info__cover`、`video-info__cover__duration`、`video-info__content`、`video-info__content__title`、`video-info__content__date`
- 评论列表：`comment-list`、`auto-load-list`
- 评论条目：`comment-item`、`comment-content`、`comment-content__username`、`comment-content__username__author-tag`、`comment-content__date`、`comment-content__detail`、`comment-content__btns`、`comment-content__btns__btn`
- 图标：`btn-icon`、`icon-like`、`icon-reply`、`icon-delete-comment`、`icon-report`
- 输入框：`comment-input`、`comment-input__wrapper`、`comment-input__wrapper__control`

**视频选择面板一致**：`drawer__content`、`video-list__header`、`count-tips`、`auto-load-list`、`video-item`、`video-item.is-active`

#### 新版变化

| 变化类型 | 具体内容 |
|---------|---------|
| **新增** | "置顶"操作按钮（`icon-topping`） |
| **新增** | 排序选项："按评论时间排序"、"按点赞量排序" |
| **新增** | `.drawer.video-list` 外层包装类 |
| **可能移除** | 表情选择器（`emoji-selector`）在新版简化 DOM 中未出现 |

---

## 三、稳定选择器策略

### 核心原则

快手创作者中心的 DOM 在版本间高度稳定，BEM 命名法和 Vue `data-v-*` 属性均不变。但 CSS Modules 哈希类名（`_name_hash_N`）和 `data-v-*` 哈希值理论上可能随构建变化。

### 选择器稳定性分级

| 优先级 | 类型 | 稳定性 | 示例 |
|--------|------|--------|------|
| 1 | 文本内容匹配 | 极高 | `findByText('span', '作品管理')` |
| 2 | Element UI / Ant Design 类名 | 极高 | `.el-menu-item`、`.ant-tabs-tab-active` |
| 3 | BEM 语义类名 | 极高 | `.video-item__detail__row__title` |
| 4 | ARIA 属性 | 高 | `[role="tab"][aria-selected="true"]` |
| 5 | placeholder 属性 | 高 | `input[placeholder="输入搜索关键词"]` |
| 6 | Tab ID | 高 | `#tab-0`、`#pane-0` |
| 7 | CSS Modules 哈希类名 | 中（构建间可能变） | `_publish-container_1tgwe_7` |
| 8 | data-v-* 哈希 | 中（构建间可能变） | `[data-v-08ce92df]` |
| - | 动态 ID | 不稳定 | `el-popover-4520` ❌ |

---

## 四、推荐选择器速查表

### 4.1 导航菜单

```javascript
// 点击"发布作品"按钮
document.querySelector('.publish-button').click();

// 点击一级菜单（通过文本）
findByText('span', '首页').click();
findByText('span', '成长中心').click();

// 展开子菜单
findByText('.el-submenu__title', '内容管理').click();

// 点击子菜单项（通过文本）
findByText('.el-menu-item', '作品管理').click();
findByText('.el-menu-item', '评论管理').click();
findByText('.el-menu-item', '作品分析').click();

// 获取当前选中菜单
document.querySelector('.el-menu-item.is-active');
```

### 4.2 发布作品页面

```javascript
// 切换 Tab
findByText('.ant-tabs-tab-btn', '上传图文').click();
findByText('.ant-tabs-tab-btn', '上传全景视频').click();

// 查找文件上传 input
document.querySelector('input[type="file"][accept*="video"]');

// 点击"上传视频"按钮
findByText('button', '上传视频').click();

// 获取拖拽上传区域
document.querySelector('[class*="dragger-container"]');

// 草稿提示操作
findByText('button', '继续编辑').click();
findByText('button', '放弃').click();

// 快手云剪
findByText('button', '立即体验').click();
```

### 4.3 内容管理-作品管理

```javascript
// 切换筛选标签
findByText('.el-tabs__item', '已发布').click();
findByText('.el-tabs__item', '待发布').click();
findByText('.el-tabs__item', '未通过').click();

// 搜索作品
const search = document.querySelector('.search-input');
search.value = '关键词';
search.dispatchEvent(new Event('input', { bubbles: true }));

// 日期范围
document.querySelector('input[placeholder="开始日期"]');
document.querySelector('input[placeholder="结束日期"]');

// 获取所有视频卡片
document.querySelectorAll('.video-item');

// 获取视频标题
document.querySelectorAll('.video-item__detail__row__title');

// 获取作品总数
document.querySelector('.works-manage__status__count').textContent;

// 操作某视频（需先 hover 显示操作按钮）
const card = document.querySelectorAll('.video-item')[0];
card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
findByText('.video-item__controls__operations__operation', '编辑作品').click();
```

### 4.4 数据中心-作品分析

```javascript
// 排序切换
findByText('.sort_button', '播放').click();
findByText('.sort_button', '点赞').click();

// 标签筛选
findByText('.tag_selector .name', '标签筛选').click();
findByText('.option', '隐私作品').click();

// 导出数据
findByText('.file_upload', '导出数据').click();

// 获取所有作品条目
document.querySelectorAll('.article_item');

// 获取某作品的数据指标
const item = document.querySelectorAll('.article_item')[0];
item.querySelectorAll('.data_item_name');  // 指标名称
item.querySelectorAll('.data_item_value'); // 指标值

// 查看某作品数据
const checkBtn = item.querySelector('.check_button');
checkBtn.click();
```

### 4.5 评论管理

```javascript
// 选择视频按钮
document.querySelector('.comment__header__video-btn').click();

// 视频选择面板 - 获取视频列表
document.querySelectorAll('.drawer .video-item');

// 视频选择面板 - 当前选中视频
document.querySelector('.drawer .video-item.is-active');

// 评论排序
findByText('.comment-list-tools', '按评论时间排序');
findByText('.comment-list-tools', '按点赞量排序');

// 获取所有评论
document.querySelectorAll('.comment-item');

// 获取评论用户名
document.querySelectorAll('.comment-content__username');

// 获取评论内容
document.querySelectorAll('.comment-content__detail');

// 评论操作（需定位到具体评论）
const comment = document.querySelectorAll('.comment-item')[0];
findByText('.comment-content__btns__btn', '回复', comment).click();
findByText('.comment-content__btns__btn', '删除', comment).click();
findByText('.comment-content__btns__btn', '举报', comment).click();
findByText('.comment-content__btns__btn', '置顶', comment).click();

// 回复输入框
const replyInput = comment.querySelector('.comment-input');
replyInput.textContent = '回复内容';
replyInput.dispatchEvent(new Event('input', { bubbles: true }));
```

---

## 五、不稳定选择器警告

### CSS Modules 哈希类名（可能随构建变化）

以下类名在两次抓取中保持一致，但理论上属于 CSS Modules 生成，构建后可能变化：

```
_publish-container_1tgwe_7
_dragger-container_1j3uy_39
_upload-btn_1j3uy_87
_draft-bar_1788x_12
_edit-btn_1788x_36
_onvideo-bar_1ltc5_12
_rule-container_1j3uy_129
```

**替代方案**：优先使用 Ant Design 类名（`ant-tabs-tab`）或文本匹配。

### data-v-* 作用域哈希（可能随 Vue 重编译变化）

```
data-v-08ce92df    ← 侧边栏
data-v-43a652e2    ← 作品管理
data-v-3bec8b5b    ← 筛选区域
data-v-273da6d7    ← 视频卡片
data-v-3932ae0a    ← 作品分析条目
data-v-306677a7    ← 评论管理
data-v-5b8d43d5    ← 评论内容
```

### 动态 ID

```
el-popover-*       ← Element UI Popover 动态 ID
el-tooltip-*       ← Element UI Tooltip 动态 ID
rc-tabs-*          ← Ant Design Tabs 动态 ID
```

---

## 六、通用辅助函数

```javascript
/**
 * 通过文本内容查找元素
 */
function findByText(selector, text, parent = document) {
  return [...parent.querySelectorAll(selector)].find(
    el => el.textContent.trim() === text
  ) || null;
}

/**
 * 通过文本模糊查找
 */
function findByTextContains(selector, text, parent = document) {
  return [...parent.querySelectorAll(selector)].find(
    el => el.textContent.includes(text)
  ) || null;
}

/**
 * 通过类名前缀查找（CSS Modules 备选）
 */
function findByClassPrefix(prefix, parent = document) {
  return parent.querySelector(`[class*="${prefix}"]`);
}

/**
 * 等待元素出现
 */
function waitForElement(selectorOrFn, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const check = typeof selectorOrFn === 'function'
      ? selectorOrFn : () => document.querySelector(selectorOrFn);
    const el = check();
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = check();
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); reject(new Error('Timeout')); }, timeout);
  });
}
```

---

## 七、CDN 与资源 URL 模式

| 用途 | URL 模式 |
|------|---------|
| 菜单图标 | `//p2-plat.wskwai.com/kos/nlav11104/static/ks-cp/img/icon_*_2025.*.svg` |
| 内容图标 | `//p66-plat.wskwai.com/kos/nlav11104/static/ks-cp/img/icon-*.svg` |
| 视频封面 | `//p4-plat-fdl.wsukwai.com/ksc2/...` |
| 用户头像 | `//p2-pro.a.yximgs.com/uhead/...` |

---

## 八、文件清单

| 文件名 | 页面 | URL | 更新时间 |
|--------|------|-----|---------|
| 菜单栏.txt | 导航菜单 | cp.kuaishou.com/profile | 2026-06-10 |
| 发布作品页面.txt | 发布视频 | cp.kuaishou.com/article/publish/video | 2026-06-10 |
| 内容管理-作品管理.txt | 作品管理 | cp.kuaishou.com/article/manage/video | 2026-06-10 |
| 数据中心-作品分析.txt | 作品分析 | cp.kuaishou.com/statistics/article | 2026-06-10 |
| 互动管理-评论管理.txt | 评论管理 | cp.kuaishou.com/article/comment | 2026-06-10 |
| DOM对比与稳定选择器指南.md | 本文档 | - | 2026-06-10 |

旧版文件备份位置：`backup_快手_dom/`（工作目录下，共 10 个文件）
