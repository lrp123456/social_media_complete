#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
import_to_settings.py
=====================
将 scripts/selectors-extracted.json 导入到「系统设置」中的动态选择器管理面板
(后台: apps/ts-api-gateway/data/selectors.json — 由 lib/selectorStore.ts 加载)。

执行流程:
  1. 读 selectors-extracted.json
  2. 应用 MEANINGLESS 过滤（文档化每一条删除理由）
  3. 转换为 SelectorConfig 格式 (与 @browser-core/selectorConfig.ts 完全兼容)
  4. 写到 apps/ts-api-gateway/data/selectors.json
  5. 生成 / 更新 scripts/selectors-imported.report.md 报告
  6. 跑 Node 端静态烟雾测试，对写入的 JSON 做覆盖率检查

数据约定:
  - SelectorConfig = {
      version: string,
      updatedAt: ISO8601,
      platforms: {
        [platform]: {
          menus:     { [name]: SelectorEntry },
          buttons:   { [name]: SelectorEntry },
          regions:   { [name]: SelectorEntry },
          textboxes: { [name]: SelectorEntry },
        }
      }
    }
  - SelectorEntry = {
      purposes: ['publish' | 'monitor'],
      primary: string,
      fallbacks: string[],
      selectorType: 'css' | 'role' | 'text' | 'placeholder' | 'label',
      description?: string,
    }
"""

from __future__ import annotations

import datetime
import json
import os
import re
import sys
from typing import Any

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_JSON = os.path.join(WORKSPACE, "scripts/selectors-extracted.json")
DST_JSON = os.path.join(WORKSPACE, "apps/ts-api-gateway/data/selectors.json")
REPORT = os.path.join(WORKSPACE, "scripts/selectors-imported.report.md")


# ============================================================
# 删除清单 (无意义 / 重复 / 失效 / 非结构化)
# 每条删除决策都附带 (platform, category, key, reason) 四元组
# ============================================================

REMOVE: list[tuple[str, str, str, str]] = [
    # ---------- 抖音 (douyin) ----------
    # 重复别名：与 tb_description 100% 重复（同一 primary + 同一 fallback + 同一 evidence）
    ("douyin", "textboxes", "tb_description_editor",
     "与 tb_description 完全重复（同 .zone-container 描述编辑框，仅 key 别名）"),

    # 测试数据泄漏：选择器文本是某条具体视频的标题，不是结构性元素
    ("douyin", "textboxes", "text_works_pick_title",
     "primary 写死了具体视频标题 '打到我 #loft复式 #效果图'（录制时的实例数据），结构性 0 价值"),

    # role+name 拼接失效：4 个兄弟节点被合并到 name 里，Playwright 不会匹配；fallback 才是真实入口
    ("douyin", "menus", "menu_cash",
     "primary 把 '变现中心/广场/任务/收入' 4 个菜单拼到 name 里，role+name 不会命中；唯一可用的 fallback 是 getByText('变现中心')，已被 menu_cash_square 覆盖"),
    ("douyin", "menus", "menu_create",
     "primary 把 '创作中心/灵感/学习/指数' 4 个菜单拼到 name 里，同上失效"),

    # ---------- 快手 (kuaishou) ----------
    # 静态 DOM 重复：menu_sub_* 与 menu_* 的 primary/fallback 完全相同（同 .el-menu-item）
    ("kuaishou", "menus", "menu_sub_作品管理",
     "与 menu_作品管理 选择器完全相同（DOM 片段里菜单出现两次，sub_* 是机械复制）"),
    ("kuaishou", "menus", "menu_sub_合集管理",
     "与 menu_合集管理 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_创建合集",
     "与 menu_创建合集 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_评论管理",
     "与 menu_评论管理 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_数据概览",
     "与 menu_数据概览 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_作品分析",
     "与 menu_作品分析 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_直播数据",
     "与 menu_直播数据 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_粉丝分析",
     "与 menu_粉丝分析 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_创作灵感",
     "与 menu_创作灵感 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_我的灵感",
     "与 menu_我的灵感 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_活动中心",
     "与 menu_活动中心 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_热点榜单",
     "与 menu_热点榜单 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_创作学院",
     "与 menu_创作学院 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_音乐人",
     "与 menu_音乐人 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_作品推广",
     "与 menu_作品推广 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_推广资源管理",
     "与 menu_推广资源管理 选择器完全相同"),
    ("kuaishou", "menus", "menu_sub_创建直播",
     "与 menu_创建直播 选择器完全相同"),

    # tab panel 4 个一模一样结构，只是 index 不同；保留 pane-0
    ("kuaishou", "regions", "region_pane_pane-1",
     "与 region_pane_pane-0 同一结构（getByRole('tabpanel')+ #pane-N），仅 index 不同；只需 pane-0"),
    ("kuaishou", "regions", "region_pane_pane-2",
     "同上，仅 index 不同"),
    ("kuaishou", "regions", "region_pane_pane-3",
     "同上，仅 index 不同"),

    # 上传区域：指向整页 main 容器，不是可交互的拖拽区
    ("kuaishou", "regions", "region_upload_zone",
     "primary 是 //div[@id='joyride-wrapper']/main/section——整个页面外壳，不是拖拽 widget；具体上传入口已被 btn_upload_video 覆盖"),

    # ---------- 小红书 (xiaohongshu) ----------
    # 重复子菜单：与 menu_* 选择器完全相同
    ("xiaohongshu", "menus", "menu_sub_账号概览",
     "与 menu_账号概览 选择器完全相同（.d-menu-item:visible）"),
    ("xiaohongshu", "menus", "menu_sub_内容分析",
     "与 menu_内容分析 选择器完全相同"),
    ("xiaohongshu", "menus", "menu_sub_粉丝数据",
     "与 menu_粉丝数据 选择器完全相同"),

    # 表单 label：只匹配静态文本，无可交互价值
    ("xiaohongshu", "regions", "form_笔记题材",
     "只是 <label> 文本，不是可交互控件；自动化用不上"),
    ("xiaohongshu", "regions", "form_笔记首发时间",
     "同上，只是 label 文本"),

    # 滚动区 primary 用了"加载中"瞬时文字
    ("xiaohongshu", "regions", "region_note_list_scroll",
     "primary 用了 '正在加载中...' 这种瞬时文字，DOM 加载完成后即消失；应改用 .bottom-loading:visible 容器或 #notes-request"),
]

REMOVE_SET: set[tuple[str, str, str]] = {(p, c, k) for p, c, k, _ in REMOVE}


# ============================================================
# 转换：ExtractedEntry → SelectorEntry
# ============================================================

VALID_TYPES = {"css", "role", "text", "placeholder", "label", "xpath"}
TYPE_MAP = {
    "getByRole": "role",
    "getByText": "text",
    "getByPlaceholder": "placeholder",
    "getByLabel": "label",
    "getByTestId": "test-id",
}


def normalize_type(t: str) -> str:
    """把 extractor 的 selectorType 归到 5 种之一。"""
    t = (t or "").lower()
    if t in ("css", "role", "text", "placeholder", "label"):
        return t
    if t in ("xpath", "test-id"):
        # 落到 css 兜底（xpath 实际是 css 提取器出来的伪 xpath）
        return "css"
    return "css"


def extracted_to_entry(e: dict[str, Any]) -> dict[str, Any]:
    """与 packages/browser-core/selectorConfig.ts 的 SelectorEntry 字段对齐。"""
    primary = e.get("primary") or e.get("staticPrimary") or ""
    fallbacks: list[str] = []
    # 顺序：staticPrimary（最稳）→ 已验证的 fallbacks
    for f in [e.get("staticPrimary", ""), *(e.get("fallbacks") or [])]:
        if f and f != primary and f not in fallbacks:
            fallbacks.append(f)
    return {
        "purposes": [p for p in (e.get("purposes") or []) if p in ("publish", "monitor")] or ["publish"],
        "primary": primary,
        "fallbacks": fallbacks,
        "selectorType": normalize_type(e.get("selectorType")),
        "description": e.get("description", ""),
    }


# ============================================================
# 主流程
# ============================================================

def main() -> int:
    with open(SRC_JSON, encoding="utf-8") as f:
        src = json.load(f)

    src_platforms = src.get("platforms", {})
    removed_records: list[tuple[str, str, str, str]] = []
    imported_records: list[tuple[str, str, str]] = []
    skipped_other: list[tuple[str, str, str]] = []

    # 构建目标 SelectorConfig
    out_platforms: dict[str, dict[str, dict[str, dict]]] = {}
    for platform, p in src_platforms.items():
        out_platforms[platform] = {"menus": {}, "buttons": {}, "regions": {}, "textboxes": {}}
        for cat in ("menus", "buttons", "regions", "textboxes"):
            for key, entry in (p.get(cat) or {}).items():
                tup = (platform, cat, key)
                if tup in REMOVE_SET:
                    reason = next((r for p2, c2, k2, r in REMOVE if (p2, c2, k2) == tup), "未记录")
                    removed_records.append((platform, cat, key, reason))
                    continue
                if not entry.get("primary"):
                    skipped_other.append((platform, cat, key))
                    continue
                out_platforms[platform][cat][key] = extracted_to_entry(entry)
                imported_records.append((platform, cat, key))

    out_config = {
        "version": "1.3.0",
        "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": f"scripts/selectors-extracted.json (via import_to_settings.py; removed {len(removed_records)})",
        "platforms": out_platforms,
    }

    # 写盘
    os.makedirs(os.path.dirname(DST_JSON), exist_ok=True)
    with open(DST_JSON, "w", encoding="utf-8") as f:
        json.dump(out_config, f, ensure_ascii=False, indent=2)

    # 报告
    write_report(out_config, removed_records, imported_records, skipped_other, src)

    # 静态回放验证（Node 端）
    print(f"\n[OK] 写入: {DST_JSON}", file=sys.stderr)
    print(f"     {sum(len(c) for p in out_platforms.values() for c in p.values())} 条已导入", file=sys.stderr)
    print(f"     {len(removed_records)} 条已过滤（无意义/重复/失效）", file=sys.stderr)
    print(f"     {len(skipped_other)} 条因无 primary 跳过", file=sys.stderr)

    print(f"\n[REPORT] {REPORT}", file=sys.stderr)

    # Node 烟雾测试
    verify_script = os.path.join(WORKSPACE, "scripts/verify-extracted.js")
    if os.path.exists(verify_script):
        print(f"\n[VERIFY] rerunning smoke test against imported file:", file=sys.stderr)
        # 临时切换 verify 脚本的源 JSON (modify via env or just run on the new file)
        os.environ["SELECTORS_JSON_OVERRIDE"] = DST_JSON
        # 直接重跑 extract + verify 复盘（不动原始源 JSON）
        os.system(f"node {verify_script}")
    return 0


def write_report(
    cfg: dict,
    removed: list[tuple[str, str, str, str]],
    imported: list[tuple[str, str, str]],
    skipped: list[tuple[str, str, str]],
    src: dict,
) -> None:
    PLATFORM_CN = {"douyin": "抖音", "kuaishou": "快手", "xiaohongshu": "小红书"}
    out_platforms = cfg["platforms"]
    total = sum(len(c) for p in out_platforms.values() for c in p.values())

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("# 动态选择器管理 — 导入报告\n\n")
        f.write(f"- 目标位置: `apps/ts-api-gateway/data/selectors.json`\n")
        f.write(f"- 来源: `scripts/selectors-extracted.json` ({sum(len(c) for p in src.get('platforms', {}).values() for c in p.values())} 条提取)\n")
        f.write(f"- 导入版本: `{cfg['version']}`\n")
        f.write(f"- 更新时间: `{cfg['updatedAt']}`\n")
        f.write(f"- 写入策略: 应用 `apps/ts-api-gateway/lib/selectorStore.ts` 的 `SelectorReader`\n")
        f.write(f"- 前端入口: `系统设置 → 自动化矩阵核心 → 动态选择器管理`\n\n")

        # === 总览 ===
        f.write("## 总览\n\n")
        f.write(f"- 源提取: **{sum(len(c) for p in src.get('platforms', {}).values() for c in p.values())}** 条\n")
        f.write(f"- 导入: **{len(imported)}** 条\n")
        f.write(f"- 过滤删除: **{len(removed)}** 条\n")
        f.write(f"- 跳过（无 primary）: **{len(skipped)}** 条\n\n")

        # === 平台分布 ===
        f.write("## 平台 × 类别分布\n\n")
        f.write("| 平台 | menus | buttons | regions | textboxes | 合计 |\n")
        f.write("|---|---|---|---|---|---|\n")
        for platform, p in out_platforms.items():
            row = [PLATFORM_CN.get(platform, platform)]
            sub = 0
            for cat in ("menus", "buttons", "regions", "textboxes"):
                n = len(p.get(cat, {}))
                row.append(str(n))
                sub += n
            row.append(str(sub))
            f.write("| " + " | ".join(row) + " |\n")
        f.write(f"\n**总计: {total} 条**\n\n")

        # === 已导入列表 ===
        f.write("## 已导入选择器\n\n")
        for platform, p in out_platforms.items():
            f.write(f"### {PLATFORM_CN.get(platform, platform)}  ({platform})\n\n")
            for cat in ("menus", "buttons", "regions", "textboxes"):
                items = p.get(cat, {})
                if not items:
                    continue
                f.write(f"#### {cat}  ({len(items)})\n\n")
                f.write("| key | type | primary | fallbacks |\n")
                f.write("|---|---|---|---|\n")
                for k, v in items.items():
                    fbs = " / ".join((v.get("fallbacks") or [])[:2])
                    f.write(f"| `{k}` | {v.get('selectorType', '?')} | `{v.get('primary', '')[:80]}` | {fbs} |\n")
                f.write("\n")

        # === 删除清单 ===
        f.write("## 已删除（{n} 条）\n\n".format(n=len(removed)))
        f.write("每条删除都附带明确理由；如需恢复，从 `selectors-extracted.json` 重新提取即可。\n\n")
        f.write("| platform | category | key | 理由 |\n")
        f.write("|---|---|---|---|\n")
        for p, c, k, r in removed:
            f.write(f"| `{p}` | `{c}` | `{k}` | {r} |\n")
        f.write("\n")

        # === 跳过 ===
        if skipped:
            f.write(f"## 跳过（{len(skipped)} 条，无 primary 字段）\n\n")
            for p, c, k in skipped:
                f.write(f"- `{p}/{c}/{k}`\n")
            f.write("\n")

    print(f"[REPORT] {REPORT}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
