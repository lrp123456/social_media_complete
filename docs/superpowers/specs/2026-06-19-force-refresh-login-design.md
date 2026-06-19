# Force Refresh Login Page — Design Spec

**Date:** 2026-06-19
**Status:** Approved
**Approach:** 方案 A — 卡片按钮 + 消息路由

## Problem

企业微信机器人发送登录卡片时，只有"✅ 已登录，继续监控"按钮。当登录页面崩溃（白屏、JS 错误、iframe 加载失败等）时，用户无法从企微侧触发恢复，只能手动干预服务器。需要一个"强制刷新登录页"功能：点击后重新导航到登录页并自动发送新的二维码卡片。

## Design

### 核心变更：登录卡片新增按钮 + 消息处理器

#### 1. 登录卡片按钮扩展

修改 `wechatBotService.ts` 的 `sendLoginAlert` 方法，在 `jump_list` 中新增一个 `type=3` 按钮：

```typescript
jump_list: [
  { type: 3, title: '✅ 已登录，继续监控', question: `继续监控 ${userId} ${platform}` },
  { type: 3, title: '🔄 强制刷新登录页', question: `强制刷新 ${userId} ${platform}` },  // 新增
],
```

按钮点击后，企微会发送 `强制刷新 <userId> <platform>` 文本消息给机器人。

#### 2. 消息处理器

在 `wechatBotService.ts` 的 `autoStartBot` → `onMessage` 回调中，新增匹配 `强制刷新 <userId> <platform>` 的处理逻辑：

```typescript
const forceRefreshSetup = content.match(/^强制刷新\s+(\d+)\s+(\S+)$/);
if (forceRefreshSetup) {
  const targetUserId = parseInt(forceRefreshSetup[1], 10);
  const targetPlatform = forceRefreshSetup[2];

  // 1. 获取用户的 fingerprintWindowId
  const { prisma } = await import('../lib/prisma');
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { fingerprintWindowId: true, wechatUserid: true },
  }).catch(() => null);

  if (!user) {
    await botManager.sendTextMessage([userid], '❌ 未找到用户');
    return;
  }

  // 2. 校验平台
  const loginUrls: Record<string, string> = {
    douyin: 'https://creator.douyin.com/creator-micro/home',
    kuaishou: 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api',
    xiaohongshu: 'https://creator.xiaohongshu.com/creator/home',
    tencent: 'https://channels.weixin.qq.com/platform',
  };
  const loginUrl = loginUrls[targetPlatform];
  if (!loginUrl) {
    await botManager.sendTextMessage([userid], `❌ 不支持的平台: ${targetPlatform}`);
    return;
  }

  // 3. 连接浏览器 → 导航 → 截取二维码（try...finally 确保 CDP 会话断开）
  const { getBrowserManager } = await import('../lib/browserManager');
  const bm = getBrowserManager();
  const windowId = String(user.fingerprintWindowId);

  try {
    const { page } = await bm.connect(windowId, '', targetPlatform);

    // 导航到平台登录页
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // 等待页面稳定/重定向到登录页

    // 截取二维码并发送新登录卡片（复用 monitorService 的 captureAndSendQR）
    const { captureAndSendQR } = await import('./monitorService');
    await captureAndSendQR(page, targetUserId, targetPlatform, user.wechatUserid || userid);

    await botManager.sendTextMessage([userid], `🔄 已刷新 ${targetPlatform} 登录页，新二维码已发送`);
  } catch (err: any) {
    logger.error({ targetUserId, targetPlatform, err }, '强制刷新登录页失败');
    await botManager.sendTextMessage([userid], `❌ 刷新登录页失败: ${err.message || '未知错误'}`);
  } finally {
    // 所有路径都断开 CDP 会话（保留浏览器窗口）
    await bm.disconnectSession(windowId, targetPlatform as any).catch(() => {});
  }
  return;
}
```

#### 3. captureAndSendQR 复用

`monitorService.ts` 中的 `captureAndSendQR` 函数已经处理了所有平台的二维码截取逻辑（包括视频号 iframe 穿透、刷新按钮点击、正方形裁剪等），直接复用即可。无需修改该函数。

需要将 `captureAndSendQR` 导出（当前是模块内私有函数）：

```typescript
// monitorService.ts
// 从 async function captureAndSendQR 改为
export async function captureAndSendQR(...): Promise<void> {
```

### 平台登录 URL 映射

| 平台 | 登录 URL | 说明 |
|------|----------|------|
| 抖音 (douyin) | `https://creator.douyin.com/creator-micro/home` | 创作者主页，未登录时重定向到登录页 |
| 快手 (kuaishou) | `https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api` | 直接登录页 |
| 小红书 (xiaohongshu) | `https://creator.xiaohongshu.com/creator/home` | 创作者主页，未登录时重定向到登录页 |
| 视频号 (tencent) | `https://channels.weixin.qq.com/platform` | 平台主页，未登录时重定向到 iframe 登录页 |

### 错误处理

| 场景 | 处理 |
|------|------|
| 用户未找到 | 发送 `❌ 未找到用户` |
| 不支持的平台 | 发送 `❌ 不支持的平台: {platform}` |
| 浏览器连接失败 | 发送 `❌ 连接浏览器失败: {错误信息}` |
| 页面导航失败 | 发送 `❌ 刷新登录页失败: {错误信息}` |
| 截取二维码失败 | `captureAndSendQR` 内部已有兜底逻辑（全页截图），最终由 `sendLoginAlert` 的 try-catch 处理 |

所有错误路径（浏览器连接失败、导航失败、截取二维码失败）都由 `try...finally` 中的 `finally` 块确保断开 CDP 会话（`bm.disconnectSession`），避免连接泄漏。

### 涉及文件

| 文件 | 修改内容 |
|------|----------|
| `apps/ts-api-gateway/src/services/wechatBotService.ts` | 1. `sendLoginAlert` 的 `jump_list` 新增按钮 2. `onMessage` 新增 `强制刷新` 消息处理 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | `captureAndSendQR` 改为 `export` |

### 不变的部分

- `sendLoginAlert` 的图片上传逻辑（OSS + 企微临时素材兜底）不变
- `captureAndSendQR` 的二维码截取逻辑不变
- "继续监控"按钮和消息处理逻辑不变
- 评论通知卡片逻辑不变

## 验收标准

1. 每次发送登录卡片时，卡片包含"🔄 强制刷新登录页"按钮
2. 点击按钮后，机器人收到 `强制刷新 <userId> <platform>` 消息
3. 消息处理器正确解析 userId 和 platform
4. 连接对应的指纹浏览器窗口
5. 导航到对应平台的登录页
6. 截取新的二维码并发送新的登录卡片
7. 用户收到 `🔄 已刷新 {platform} 登录页，新二维码已发送` 确认消息
8. 各错误场景有对应的错误提示
9. CDP 会话在所有路径下都正确断开
