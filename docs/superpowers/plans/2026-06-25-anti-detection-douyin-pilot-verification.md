# 抖音反检测收口验证清单

对应 spec 第 11 节成功标准。

## 1. 静态零直接调用（v2 分支）
- [ ] `npx tsx scripts/anti-detection/audit-blindspots.ts` 输出，v2 分支无裸调用
- [ ] legacy 分支裸调用保留（共存期允许，当前基线 68 处）

## 2. 运行时指标埋点
- [ ] 抖音三功能开启 debug 模式跑通后，查询 TaskExecutionStep.extra.antiDetection：
  - [ ] actionPath native-locator/safeEvaluate-isolated 占绝大多数
  - [ ] safeEvaluate-main 趋近 0（ESLint ≤3/文件）
  - [ ] cdpSessionCreated 仅首次 true
  - [ ] interceptorHit 高、fallbackToDom 低
  - [ ] interceptorOnlySuccess 采样指标有记录

## 3. 功能不回归
- [ ] `OSS_ACCESS_KEY_ID=dummy OSS_ACCESS_KEY_SECRET=dummy npx jest` 全绿（除预存的 videoIdUtils 问题）
- [ ] 抖音三功能端到端走通（legacy + v2 各一次）

## 4. 契约锁定
- [ ] HumanActions: readText/readAttribute/readAll/exists/click/fill/press/safeEvaluate 定义完成
- [ ] RequestInterceptor: waitForResponse(既有)/collectResponses/pollStatus 可用

## 5. 5 条铁律落地
- [ ] 铁律1: 原生 Locator 优先（readText 等用原生）
- [ ] 铁律2: CDP 仅 scroll/kbd（cdpSmartScroll 保留）
- [ ] 铁律3: 裸 page.evaluate 弃用（v2 走 safeEvaluate）
- [ ] 铁律4: cdpContexts 长连接无频繁重建
- [ ] 铁律5: 抖音所有操作经 HumanActions/Interceptor

## 6. 前置盲测通过（Phase 0）
- [ ] 隔离世界 POC PASS（主世界/隔离世界互不可见）
- [ ] 原生 Locator 盲测：B 组风控触发率不高于 A 组 5%（Phase 3 后运行）

## 7. 双路径共存
- [ ] ANTI_DETECTION_MODE=legacy|v2 可切换
- [ ] 回滚仅需改环境变量
