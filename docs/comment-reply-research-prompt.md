# 评论回复功能调研提示词

> 用于交给 qoderwork 进行平台回复评论操作流程的详细调研

---

## 调研目标

深入分析**快手**和**抖音**创作者平台的评论回复操作细节，包括：
- 完整的操作步骤流程
- 每一步的鼠标位置、点击目标、等待时间
- DOM 结构和选择器
- API 接口（如果有的话）

---

## 一、抖音平台回复评论调研

### 当前已知实现（仅供参考，需要验证）

```typescript
// 抖音回复流程（executeReplyAction in monitorService.ts:1286-1351）
1. 确保在创作者中心页面（creator.douyin.com）
2. 导航到评论管理页面
3. 打开作品选择抽屉
4. 找到并点击目标视频
5. 定位目标评论容器（[class*="container-sXKyMs"]）
6. 点击"回复"按钮（通过文本匹配）
7. 点击输入框（div[contenteditable="true"]）
8. 逐字输入回复文本
9. 点击发送按钮（[class*="submit"]）
```

### 调研任务清单

#### 1.1 回复按钮位置和样式
- [ ] 回复按钮在评论的哪个位置？（评论下方、右侧、hover后显示？）
- [ ] 回复按钮的 DOM 结构是什么？（button/div/span？）
- [ ] 回复按钮的 CSS 选择器是什么？
- [ ] 需要 hover 到评论上才会显示回复按钮吗？
- [ ] 回复按钮的文本内容是什么？（"回复"、"Reply"、图标？）

#### 1.2 回复输入框
- [ ] 点击回复按钮后，输入框出现在哪里？（评论下方、弹窗、抽屉？）
- [ ] 输入框的 DOM 结构是什么？（input/textarea/div[contenteditable]？）
- [ ] 输入框的 CSS 选择器是什么？
- [ ] 输入框有 placeholder 文本吗？内容是什么？
- [ ] 输入框有字数限制吗？

#### 1.3 发送按钮
- [ ] 发送按钮在输入框的哪个位置？（右侧、下方？）
- [ ] 发送按钮的 DOM 结构是什么？
- [ ] 发送按钮的 CSS 选择器是什么？
- [ ] 发送按钮的文本内容是什么？（"发送"、"发布"、"Send"？）
- [ ] 输入内容为空时，发送按钮是否禁用？

#### 1.4 操作时序
- [ ] 点击回复按钮后，多久出现输入框？（动画时间）
- [ ] 输入完成后，点击发送，多久完成回复？（网络请求时间）
- [ ] 回复成功后，页面有什么变化？（评论列表刷新、新评论出现？）
- [ ] 回复失败时，页面有什么提示？

#### 1.5 API 接口
- [ ] 回复评论时，浏览器发送了什么 API 请求？
- [ ] 请求的 URL、Method、Headers、Body 是什么？
- [ ] 响应的结构是什么？
- [ ] 有哪些必填参数？

#### 1.6 截图和 DOM 结构
- [ ] 截图：评论列表页面（显示回复按钮）
- [ ] 截图：点击回复按钮后的状态（显示输入框）
- [ ] 截图：输入回复内容后的状态
- [ ] 截图：回复成功后的状态
- [ ] DOM 结构：回复按钮的完整 DOM 路径
- [ ] DOM 结构：回复输入框的完整 DOM 路径
- [ ] DOM 结构：发送按钮的完整 DOM 路径

---

## 二、快手平台回复评论调研

### 当前状态

**快手回复功能尚未实现**，需要从零开始调研。

### 调研任务清单

#### 2.1 评论管理页面导航
- [ ] 快手创作者中心评论管理页面的 URL 是什么？
- [ ] 如何从首页导航到评论管理页面？（菜单路径）
- [ ] 评论管理页面的 DOM 结构是什么？
- [ ] 评论列表是如何展示的？（左侧视频列表 + 右侧评论？）

#### 2.2 视频选择
- [ ] 如何选择要查看评论的视频？（点击视频列表、下拉选择？）
- [ ] 视频选择的 DOM 结构是什么？
- [ ] 选择视频后，评论列表如何刷新？

#### 2.3 回复按钮位置和样式
- [ ] 回复按钮在评论的哪个位置？
- [ ] 回复按钮的 DOM 结构是什么？
- [ ] 回复按钮的 CSS 选择器是什么？
- [ ] 需要 hover 到评论上才会显示回复按钮吗？
- [ ] 回复按钮的文本内容是什么？

#### 2.4 回复输入框
- [ ] 点击回复按钮后，输入框出现在哪里？
- [ ] 输入框的 DOM 结构是什么？
- [ ] 输入框的 CSS 选择器是什么？
- [ ] 输入框有 placeholder 文本吗？
- [ ] 输入框有字数限制吗？

#### 2.5 发送按钮
- [ ] 发送按钮在输入框的哪个位置？
- [ ] 发送按钮的 DOM 结构是什么？
- [ ] 发送按钮的 CSS 选择器是什么？
- [ ] 发送按钮的文本内容是什么？

#### 2.6 操作时序
- [ ] 点击回复按钮后，多久出现输入框？
- [ ] 输入完成后，点击发送，多久完成回复？
- [ ] 回复成功后，页面有什么变化？
- [ ] 回复失败时，页面有什么提示？

#### 2.7 API 接口
- [ ] 回复评论时，浏览器发送了什么 API 请求？
- [ ] 请求的 URL、Method、Headers、Body 是什么？
- [ ] 响应的结构是什么？
- [ ] 有哪些必填参数？

#### 2.8 截图和 DOM 结构
- [ ] 截图：评论管理页面（显示视频列表和评论）
- [ ] 截图：选择视频后的评论列表
- [ ] 截图：hover 到评论上（显示回复按钮）
- [ ] 截图：点击回复按钮后的状态
- [ ] 截图：输入回复内容后的状态
- [ ] 截图：回复成功后的状态
- [ ] DOM 结构：回复按钮的完整 DOM 路径
- [ ] DOM 结构：回复输入框的完整 DOM 路径
- [ ] DOM 结构：发送按钮的完整 DOM 路径

---

## 三、输出格式要求

### 3.1 操作流程文档

```markdown
## [平台名称] 回复评论操作流程

### 前置条件
- 已登录创作者中心
- 已进入评论管理页面
- 目标视频已选择

### 操作步骤

#### 步骤 1：定位目标评论
- **鼠标位置**：移动到目标评论区域
- **等待时间**：500ms
- **截图**：[截图路径]

#### 步骤 2：点击回复按钮
- **鼠标位置**：hover 到评论上，回复按钮出现在 [位置描述]
- **点击目标**：[CSS 选择器] 或 [文本内容]
- **等待时间**：1000ms（等待输入框出现）
- **截图**：[截图路径]

#### 步骤 3：输入回复内容
- **鼠标位置**：点击输入框 [CSS 选择器]
- **输入方式**：逐字输入（模拟人类打字）
- **输入速度**：50-150ms/字
- **截图**：[截图路径]

#### 步骤 4：发送回复
- **鼠标位置**：点击发送按钮 [CSS 选择器]
- **等待时间**：2000ms（等待网络请求完成）
- **验证**：回复成功后，新评论出现在列表中
- **截图**：[截图路径]
```

### 3.2 选择器文档

```markdown
## [平台名称] 选择器配置

### 回复按钮
- **CSS 选择器**: `.reply-btn` / `button:has-text("回复")`
- **XPath**: `//button[contains(text(), "回复")]`
- **描述**: 评论下方的回复按钮，hover 后显示

### 回复输入框
- **CSS 选择器**: `.reply-input` / `textarea[placeholder*="回复"]`
- **XPath**: `//textarea[contains(@placeholder, "回复")]`
- **描述**: 点击回复按钮后出现的输入框

### 发送按钮
- **CSS 选择器**: `.send-btn` / `button:has-text("发送")`
- **XPath**: `//button[contains(text(), "发送")]`
- **描述**: 输入框旁边的发送按钮
```

### 3.3 API 文档

```markdown
## [平台名称] 回复评论 API

### 请求信息
- **URL**: `/api/comment/reply`
- **Method**: POST
- **Content-Type**: application/json

### 请求参数
```json
{
  "commentId": "评论ID",
  "content": "回复内容",
  "videoId": "视频ID"
}
```

### 响应结构
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "commentId": "新评论ID",
    "createTime": 1234567890
  }
}
```
```

---

## 四、调研环境

### 抖音
- **URL**: https://creator.douyin.com/creator-micro/interactive/comment
- **登录方式**: 扫码登录或 Cookie
- **测试账号**: [需要提供]

### 快手
- **URL**: https://cp.kuaishou.com/comment
- **登录方式**: 扫码登录或 Cookie
- **测试账号**: [需要提供]

---

## 五、注意事项

1. **模拟人类行为**：所有操作都需要模拟人类行为，包括：
   - 鼠标移动速度：不要瞬间移动，要有轨迹
   - 点击前的 hover：先 hover 到目标位置，等待 200-500ms 再点击
   - 输入速度：逐字输入，每字 50-150ms
   - 操作间隔：每个操作之间等待 500-2000ms

2. **截图要求**：
   - 截图要包含完整的操作上下文
   - 截图要标注关键元素的位置
   - 截图分辨率至少 1920x1080

3. **DOM 结构**：
   - 记录完整的 DOM 路径（从 body 到目标元素）
   - 记录元素的 class、id、data-* 属性
   - 记录元素的文本内容

4. **API 接口**：
   - 使用浏览器开发者工具的 Network 面板
   - 记录完整的请求和响应
   - 注意请求头中的 Cookie 和 Token

---

## 六、交付物清单

### 抖音
- [ ] 抖音回复评论操作流程文档
- [ ] 抖音回复评论选择器配置
- [ ] 抖音回复评论 API 文档
- [ ] 抖音回复评论截图（至少 6 张）

### 快手
- [ ] 快手回复评论操作流程文档
- [ ] 快手回复评论选择器配置
- [ ] 快手回复评论 API 文档
- [ ] 快手回复评论截图（至少 8 张）
- [ ] 快手评论管理页面 DOM 结构分析

---

## 七、参考代码

### 当前抖音回复实现（需要验证）

```typescript
// 文件：apps/ts-api-gateway/src/services/monitorService.ts:1286-1351
async function executeReplyAction(task, replyData) {
  if (task.platform === 'douyin') {
    // 1. 导航到评论管理
    await douyinCrawler.navigateToCommentManage(page);
    
    // 2. 打开作品选择抽屉
    await douyinCrawler.openSelectWorkDrawer(page);
    
    // 3. 找到目标视频
    await douyinCrawler.findAndClickVideoInDrawer(page, replyData.videoId);
    
    // 4. 定位目标评论容器
    const containers = await HumanActions.queryElementsWithInfo(page, '[class*="container-sXKyMs"]');
    
    // 5. 点击"回复"按钮
    await HumanActions.cdpClickByText(page, '回复');
    
    // 6. 点击输入框并输入
    await HumanActions.cdpClick(page, 'div[contenteditable="true"]');
    for (const char of replyData.text) {
      await HumanActions.cdpKeyPress(page, char, char, char.charCodeAt(0));
      await HumanActions.wait(page, 50, 150);
    }
    
    // 7. 点击发送
    await HumanActions.cdpClick(page, '[class*="submit"]');
  }
}
```

### 当前快手回复实现

**尚未实现**，需要基于调研结果从零开发。

---

## 八、预期时间

- 抖音调研：2-3 小时
- 快手调研：3-4 小时
- 文档整理：1-2 小时
- **总计**：6-9 小时

---

## 九、参考资料

- 抖音创作者中心：https://creator.douyin.com
- 快手创作者中心：https://cp.kuaishou.com
- 当前选择器配置：`data/selectors.json`
- 当前爬虫代码：`apps/ts-api-gateway/src/crawlers/`
- 评论监控服务：`apps/ts-api-gateway/src/services/monitorService.ts`
