#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export_selectors.py
===================
从 scripts/selectors-extracted.json 输出一份"人类/工具友好"的选择器清单 JSON，
每条选择器包含：
  - platform / category / key
  - selector: 主选择器原文
  - description: 用途描述
  - fallbacks: 多级回退列表，每级含
      - level (1 = primary, 2..N = fallback)
      - approach (role | text | label | placeholder | test-id | css | xpath | cdp)
      - term: 该回退使用的关键词 / 选择器 / 名字（依 approach 而定）
      - role: (仅 role 时) 角色名
      - selector: 回退的原始字符串

输出: scripts/selectors-export.json
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Optional

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(WORKSPACE, "scripts/selectors-extracted.json")
DST = os.path.join(WORKSPACE, "scripts/selectors-export.json")

# ============================================================
# 9 层策略
# ============================================================
APPROACH_ORDER = {
    "role": 1,
    "text": 2,
    "label": 3,
    "placeholder": 4,
    "test-id": 5,
    "css": 6,
    "xpath": 7,
    "cdp": 8,
}


# ============================================================
# 解析器
# ============================================================
def parse_selector(sel: str) -> dict[str, Any]:
    """
    把一条选择器字符串解析为 {approach, term, role, raw}。
    支持：
      - getByRole("role", name="X"[, exact=True])
      - getByText("X", exact=True)  / getByText("X")
      - getByPlaceholder("X")
      - getByLabel("X")
      - getByTestId("X") / getByTestId('X')
      - xpath=...
      - $('css')            (jQuery 风格)
      - $x('xpath')[0]      (Chrome DevTools 风格)
      - 纯 css / xpath 字符串
    """
    s = sel.strip()
    out: dict[str, Any] = {"raw": s}

    # getByRole
    m = re.match(
        r'getByRole\(\s*["\']([^"\']+)["\']\s*(?:,\s*name\s*=\s*["\']([^"\']*)["\']\s*)?'
        r'(?:,\s*exact\s*=\s*(True|False)\s*)?\)',
        s,
    )
    if m:
        out["approach"] = "role"
        out["role"] = m.group(1)
        out["term"] = m.group(2) or ""
        out["exact"] = (m.group(3) != "False")
        return out

    # getByText
    m = re.match(
        r'getByText\(\s*["\']([^"\']*)["\']\s*(?:,\s*exact\s*=\s*(True|False)\s*)?\)',
        s,
    )
    if m:
        out["approach"] = "text"
        out["term"] = m.group(1)
        out["exact"] = (m.group(2) != "False")
        return out

    # getByPlaceholder
    m = re.match(r'getByPlaceholder\(\s*["\']([^"\']*)["\']\s*\)', s)
    if m:
        out["approach"] = "placeholder"
        out["term"] = m.group(1)
        return out

    # getByLabel
    m = re.match(r'getByLabel\(\s*["\']([^"\']*)["\']\s*\)', s)
    if m:
        out["approach"] = "label"
        out["term"] = m.group(1)
        return out

    # getByTestId
    m = re.match(r'getByTestId\(\s*["\']([^"\']*)["\']\s*\)', s)
    if m:
        out["approach"] = "test-id"
        out["term"] = m.group(1)
        return out

    # $x('xpath')[0]  (Chrome DevTools 风格)
    m = re.match(r'\$x\(\s*["\'](.+?)["\']\s*\)(?:\[\d+\])?\s*$', s)
    if m:
        out["approach"] = "xpath"
        out["term"] = m.group(1)
        return out

    # $('css')  (jQuery 风格)
    m = re.match(r'\$x?\(\s*["\'](.+?)["\']\s*\)\s*$', s)
    if m:
        inner = m.group(1)
        out["approach"] = "css" if inner.startswith((".","#","[","a","div","span","input","button","ul","li","h1","h2","h3","h4","h5","h6","p","form","table","tr","td","th","img","svg","nav","main","section","header","footer","aside","article","*","html","body")) else "xpath"
        out["term"] = inner
        return out

    # xpath=... 显式
    if s.startswith("xpath="):
        out["approach"] = "xpath"
        out["term"] = s[len("xpath="):].strip()
        return out

    # 兜底：纯 css（最常见）
    out["approach"] = "css"
    out["term"] = s.replace(":visible", "").strip()
    return out


# ============================================================
# 主流程
# ============================================================
def main() -> int:
    with open(SRC, encoding="utf-8") as f:
        config = json.load(f)

    items: list[dict[str, Any]] = []
    summary: dict[str, int] = {"total": 0, "by_approach": {}, "by_platform": {}}

    for platform, p in config["platforms"].items():
        for cat in ("menus", "buttons", "regions", "textboxes"):
            for key, entry in (p.get(cat) or {}).items():
                # primary
                primary_parsed = parse_selector(entry.get("primary", ""))
                fallbacks_parsed = [parse_selector(f) for f in entry.get("fallbacks", [])]

                # 合并 primary + fallbacks 标 level
                levels: list[dict[str, Any]] = []
                primary_obj = dict(primary_parsed)
                primary_obj["level"] = 1
                primary_obj["selector"] = entry.get("primary", "")
                levels.append(primary_obj)
                for i, fb in enumerate(fallbacks_parsed, start=2):
                    fb_obj = dict(fb)
                    fb_obj["level"] = i
                    fb_obj["selector"] = entry.get("fallbacks", [])[i - 2]
                    levels.append(fb_obj)

                item = {
                    "platform": platform,
                    "category": cat,
                    "key": key,
                    "selector": entry.get("primary", ""),
                    "description": entry.get("description", ""),
                    "selectorType": entry.get("selectorType", primary_parsed.get("approach", "")),
                    "purposes": entry.get("purposes", []),
                    "fallbacks": levels,
                    "evidence": entry.get("evidence", {}),
                }
                items.append(item)

                # 统计
                summary["total"] += 1
                summary["by_approach"][primary_parsed.get("approach", "?")] = (
                    summary["by_approach"].get(primary_parsed.get("approach", "?"), 0) + 1
                )
                summary["by_platform"][platform] = (
                    summary["by_platform"].get(platform, 0) + 1
                )

    # 按 platform / category / key 排序
    cat_order = {"menus": 0, "buttons": 1, "regions": 2, "textboxes": 3}
    items.sort(key=lambda x: (x["platform"], cat_order.get(x["category"], 99), x["key"]))

    export = {
        "version": config.get("version", ""),
        "updatedAt": config.get("updatedAt", ""),
        "source": config.get("source", ""),
        "strategy": config.get("selectorStrategy", []),
        "summary": summary,
        "items": items,
    }

    with open(DST, "w", encoding="utf-8") as f:
        json.dump(export, f, ensure_ascii=False, indent=2)

    print(f"[OK] {DST}", file=sys.stderr)
    print(f"     {summary['total']} entries", file=sys.stderr)
    print(f"     by primary approach: {summary['by_approach']}", file=sys.stderr)
    print(f"     by platform: {summary['by_platform']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
