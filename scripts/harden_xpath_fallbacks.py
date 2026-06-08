#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
harden_xpath_fallbacks.py
=========================
为含 runtime-only xpath（带 /html/body, @id="root", joyride-wrapper）的条目
补上可在静态 DOM 中命中的 css / class 选择器，写到 fallbacks 数组最前面作为防御。

被强化的条目（按 platform/category/key）：
  1. douyin/regions/region_work_list_item
     primary: xpath=//*[@id="root"]/div/div            → 静态无 id="root"
     加 fallback: .card-gkf5WW                          (静态 1 hit，作品管理卡片)

  2. douyin/regions/region_works_pick_scroll
     primary: xpath=/html/body/div[14]/.../div[2]       → div[14] 仅在浏览器层
     加 fallback: .douyin-creator-interactive-sidesheet-body  (静态 1 hit，弹窗体)

  3. kuaishou/buttons/btn_继续编辑
     primary: getByRole("button", name="继续编辑")       OK
     xpath fallback 指向 joyride-wrapper；joyride 消失后失效
     保留 getByRole，移除 joyride-only xpath（可选），改用 :has-text 兜底

  4. kuaishou/buttons/btn_放弃
     同上

  5. kuaishou/buttons/btn_上传视频
     同上

  6. kuaishou/buttons/btn_立即体验
     同上
"""

from __future__ import annotations

import json
import os
import sys

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST_JSON = os.path.join(WORKSPACE, "apps/ts-api-gateway/data/selectors.json")
REPORT = os.path.join(WORKSPACE, "scripts/selectors-imported.report.md")


# ============================================================
# 强化规则
# key = (platform, category, key)
#   prepend:  list[str]   - 放到 fallbacks 数组最前面
#   remove_xpath_with: list[str]  - 删除含这些子串的 xpath fallback（joyride 专用等）
# ============================================================
HARDEN: dict[tuple[str, str, str], dict] = {
    ("douyin", "regions", "region_work_list_item"): {
        "prepend": [".card-gkf5WW"],
        "remove_xpath_with": [],   # 保留 ancestor xpath 作为后备
        "rationale": "在静态 DOM 中命中 .card-gkf5WW（作品管理卡壳），绕过 @id=\"root\" 找不到的问题",
    },
    ("douyin", "regions", "region_works_pick_scroll"): {
        "prepend": [".douyin-creator-interactive-sidesheet-body"],
        "remove_xpath_with": [],
        "rationale": "在静态 DOM 中命中 sidesheet-body（弹窗内容容器），绕过 /html/body/div[14] 索引问题",
    },
    # 4 个 kuaishou joyride 教程按钮：primary getByRole 已可靠，fallback 的 joyride xpath
    # 反而是误导（joyride 消失后失效）。改用通用的 :has-text 兜底（Playwright 语法）。
    ("kuaishou", "buttons", "btn_继续编辑"): {
        "prepend": ["button:has-text(\"继续编辑\")"],
        "remove_xpath_with": ["joyride-wrapper"],
        "rationale": "primary getByRole 可靠；joyride xpath 在教程消失后失效，改用通用文本选择器",
    },
    ("kuaishou", "buttons", "btn_放弃"): {
        "prepend": ["button:has-text(\"放弃\")"],
        "remove_xpath_with": ["joyride-wrapper"],
        "rationale": "同上",
    },
    ("kuaishou", "buttons", "btn_上传视频"): {
        "prepend": ["button:has-text(\"上传视频\")"],
        "remove_xpath_with": ["joyride-wrapper"],
        "rationale": "同上",
    },
    ("kuaishou", "buttons", "btn_立即体验"): {
        "prepend": ["button:has-text(\"立即体验\")"],
        "remove_xpath_with": ["joyride-wrapper"],
        "rationale": "同上",
    },
}


def main() -> int:
    with open(DST_JSON, encoding="utf-8") as f:
        cfg = json.load(f)

    platforms = cfg["platforms"]
    changes: list[dict] = []

    for (plat, cat, key), rule in HARDEN.items():
        if plat not in platforms or cat not in platforms[plat] or key not in platforms[plat][cat]:
            print(f"  ⚠ 跳过（不存在）: {plat}/{cat}/{key}", file=sys.stderr)
            continue
        entry = platforms[plat][cat][key]
        old_fallbacks = list(entry.get("fallbacks", []))
        # 1. 删 joyride xpath
        kept = [f for f in old_fallbacks if not any(m in f for m in rule["remove_xpath_with"])]
        # 2. 前置新 fallback（去重）
        new_fb: list[str] = []
        for f in rule["prepend"]:
            if f and f not in new_fb and f not in kept and f != entry.get("primary"):
                new_fb.append(f)
        for f in kept:
            if f not in new_fb and f != entry.get("primary"):
                new_fb.append(f)
        entry["fallbacks"] = new_fb
        changes.append({
            "key": f"{plat}/{cat}/{key}",
            "before": old_fallbacks,
            "after": new_fb,
            "rationale": rule["rationale"],
        })
        print(f"  ✓ {plat}/{cat}/{key}", file=sys.stderr)
        print(f"    before: {old_fallbacks}", file=sys.stderr)
        print(f"    after : {new_fb}", file=sys.stderr)

    cfg["version"] = "1.3.1"
    cfg["source"] = (
        f"scripts/selectors-extracted.json + apply_overrides.py + harden_xpath_fallbacks.py"
    )
    with open(DST_JSON, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print(f"\n[OK] 写入: {DST_JSON}", file=sys.stderr)
    print(f"     {len(changes)} 条已强化", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
