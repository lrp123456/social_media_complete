# RoxyBrowser CDP 调试指南

## 连接信息

| 字段 | 值 |
|------|-----|
| API Base URL | `http://localhost:54345` |
| API Key | `ae6bae688db2bfe0b4ee49195b08e377` |
| 团队 ID (workspaceId) | `ZOI0111819` |
| 窗口 ID (dirId) | `68a259626bb2c5905ffed8116e9a2a04` |

## 步骤 1: 获取 CDP 连接信息

```bash
curl -s -H "Authorization: Bearer ae6bae688db2bfe0b4ee49195b08e377" \
  "http://localhost:54345/browser/connection_info?dirIds=68a259626bb2c5905ffed8116e9a2a04"
```

返回示例：
```json
{
  "code": 0,
  "data": [{
    "ws": "ws://127.0.0.1:50642/devtools/browser/9020a0ef-...",
    "http": "127.0.0.1:50642",
    "coreVersion": "148",
    "pid": 44608,
    "dirId": "68a259626bb2c5905ffed8116e9a2a04"
  }]
}
```

## 步骤 2: 获取页面列表

```bash
curl -s "http://127.0.0.1:50642/json"
```

返回当前窗口中所有打开的标签页，每个页面有：
- `id` — 页面 ID
- `title` — 页面标题
- `url` — 当前 URL
- `webSocketDebuggerUrl` — 页面级 CDP WebSocket 地址

## 步骤 3: 通过 CDP 执行 JavaScript

使用 Node.js + WebSocket 连接页面级 CDP：

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:50642/devtools/page/<PAGE_ID>');

let msgId = 1;
function cdpEvaluate(expression) {
  return new Promise((resolve) => {
    const id = msgId++;
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true }
    }));
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        resolve(msg.result?.value);
      }
    };
    ws.on('message', handler);
  });
}

ws.on('open', async () => {
  // 示例：获取页面标题
  const title = await cdpEvaluate('document.title');
  console.log('Page title:', title);
  
  // 示例：获取元素数量
  const count = await cdpEvaluate('document.querySelectorAll(".video-item").length');
  console.log('Video items:', count);
  
  ws.close();
});
```

## 常用调试脚本

### 检查快手抽屉 DOM 结构

```bash
# 1. 先点击"选择视频"按钮打开抽屉
# 2. 然后执行：
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:50642/devtools/page/<PAGE_ID>');
let id = 1;
function send(expr) {
  return new Promise(r => {
    const mid = id++;
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    const h = d => { const m = JSON.parse(d.toString()); if (m.id === mid) { ws.removeListener('message', h); r(m.result?.value); } };
    ws.on('message', h);
  });
}
ws.on('open', async () => {
  const result = await send(\`
    (() => {
      const items = document.querySelectorAll('.video-item');
      return Array.from(items).slice(0, 5).map(item => ({
        title: item.querySelector('.video-info__content__title')?.textContent?.trim()?.substring(0, 40),
        date: item.querySelector('.video-info__content__date')?.textContent?.trim(),
        detail: item.querySelector('.video-info__content__detail')?.textContent?.trim()
      }));
    })()
  \`);
  console.log(JSON.stringify(result, null, 2));
  ws.close();
});
"
```

### 检查抽屉滚动容器

```javascript
// 查找滚动容器
const scrollInfo = await cdpEvaluate(`
  (() => {
    const container = document.querySelector('.auto-load-list');
    if (!container) return 'NOT FOUND';
    return {
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      scrollTop: container.scrollTop,
      canScroll: container.scrollHeight > container.clientHeight
    };
  })()
`);
```

### 检查快手评论管理页面状态

```javascript
const pageState = await cdpEvaluate(`
  (() => {
    const bodyText = document.body?.innerText?.substring(0, 1000);
    const hasCommentManage = bodyText.includes('评论管理');
    const hasSelectVideo = bodyText.includes('选择视频');
    const drawer = document.querySelector('.drawer.video-list');
    const videoItems = document.querySelectorAll('.video-item');
    return {
      hasCommentManage,
      hasSelectVideo,
      hasDrawer: !!drawer,
      drawerVisible: drawer ? getComputedStyle(drawer).display !== 'none' : false,
      videoItemCount: videoItems.length
    };
  })()
`);
```

## RoxyBrowser API 端点速查

| 端点 | 方法 | 描述 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/browser/workspace` | GET | 获取工作空间列表 |
| `/browser/list_v3` | GET | 获取窗口列表 |
| `/browser/detail` | GET | 获取窗口详情 |
| `/browser/open` | POST | 打开窗口（返回 CDP 连接信息） |
| `/browser/close` | POST | 关闭窗口 |
| `/browser/connection_info` | GET | 获取已打开窗口的 CDP 连接信息 |

## 注意事项

1. **窗口必须先打开**：`/browser/connection_info` 只返回已打开窗口的信息
2. **页面级 vs 浏览器级**：`/json` 返回页面级 WebSocket，`/browser/connection_info` 返回浏览器级
3. **RoxyBrowser API 地址**：默认 `http://localhost:54345`，可在 `.env` 中通过 `ROXY_BROWSER_URL` 配置
4. **页面 ID 会变化**：每次打开新标签页或刷新页面，页面 ID 会改变
