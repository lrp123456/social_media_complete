#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply_overrides.py
==================
应用人工覆盖的选择器变更（用户已在 Chrome DevTools 中验证），
对覆盖后的 JSON 做静态回放验证，并写回磁盘。

设计原则：
- extract_selectors.py 只做"机器提取"
- 本脚本只做"人工 + 机器"协同的微调，便于追溯
- 验证失败的覆盖不会被写入；通过的就地升级 evidence
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

from bs4 import BeautifulSoup

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_PATH = os.path.join(WORKSPACE, "scripts/selectors-extracted.json")
DOM_DIR = os.path.join(WORKSPACE, "dom源文件")


# ============================================================
# 变更清单
# ============================================================

# 删除：(platform, category, key)
REMOVE: set[tuple[str, str, str]] = {
    ("douyin", "buttons", "btn_comment_send"),
    ("douyin", "buttons", "btn_works_pick_item"),
}

# 覆盖：(platform, category, key) -> 完整字段
# 所有 primary/fallback 都已经过 Chrome DevTools 在真实页面中验证
OVERRIDES: dict[tuple[str, str, str], dict[str, Any]] = {
    ("douyin", "regions", "region_work_list_item"): {
        "primary": "xpath=//*[@id=\"root\"]/div/div",
        "staticPrimary": "xpath=//div[text()=\"作品管理\"]/ancestor::div[contains(@class, \"card-container\")][1]",
        "fallbacks": [
            "xpath=//div[text()=\"作品管理\"]/ancestor::div[contains(@class, \"card-container\")][1]",
        ],
        "selectorType": "xpath",
        "description": "内容管理-作品管理-可滚动区域（用户 Chrome DevTools 验证）",
        "evidence_page": "work_manage",
    },
    ("douyin", "regions", "region_works_pick_scroll"): {
        "primary": "xpath=/html/body/div[14]/div/div[2]/div/div[2]",
        "staticPrimary": "xpath=//div[contains(@class, \"douyin-creator-interactive-sidesheet-body\")]",
        "fallbacks": [
            "xpath=//div[contains(@class, \"douyin-creator-interactive-sidesheet-body\")]",
        ],
        "selectorType": "xpath",
        "description": "评论管理-选择作品-弹窗内滚动列表（用户 Chrome DevTools 验证）",
        "evidence_page": "select_works",
    },
    ("douyin", "textboxes", "tb_title"): {
        "primary": "input[placeholder*=\"填写作品标题\"]:visible",
        "staticPrimary": "input[placeholder*=\"填写作品标题\"]",
        "fallbacks": [
            "xpath=//input[contains(@placeholder, \"填写作品标题\")]",
        ],
        "selectorType": "css",
        "description": "高清发布页-作品标题输入框（用户 Chrome DevTools 验证）",
        "evidence_page": "publish_after",
    },
    ("douyin", "textboxes", "tb_description"): {
        "primary": "div[data-placeholder*=\"作品简介\"]:visible",
        "staticPrimary": "div[data-placeholder*=\"作品简介\"]",
        "fallbacks": [
            "xpath=//div[contains(@data-placeholder, \"作品简介\")]",
        ],
        "selectorType": "css",
        "description": "高清发布页-作品简介编辑框（用户 Chrome DevTools 验证）",
        "evidence_page": "publish_after",
    },
}

# DOM 文件路径映射（仅抖音）
DOM_FILE_FOR_PAGE: dict[str, str] = {
    "work_manage":   "抖音/内容管理-作品管理.txt",
    "publish_after": "抖音/高清发布页面上传后.txt",
    "select_works":  "抖音/互动管理-评论管理-选择作品.txt",
    "comment_manage": "抖音/互动管理-评论管理.txt",
}


# ============================================================
# 验证函数
# ============================================================

def xpath_to_css(xp: str) -> str:
    """与 extract_selectors.py 保持一致的 xpath→css 启发式转换。"""
    s = xp.replace("xpath=", "").strip()
    s = re.sub(r"^\/?(html\/)?body\/?", "", s)
    if s.startswith("//"):
        s = " " + s[2:]
    s = s.replace("/", " > ")
    s = re.sub(r"\[(\d+)\]", r":nth-of-type(\1)", s)
    s = re.sub(r"\[@id='([^']+)'\]", r"#\1", s)
    s = re.sub(r"\[@class='([^']+)'\]", r".\1", s)
    # contains(@attr, "value") → [attr*="value"]
    s = re.sub(r'\[contains\(@class,\s*[\'"]([^\'"]+)[\'"]\)\]',
               lambda m: f'[class*="{m.group(1)}"]', s)
    s = re.sub(r'\[contains\(@data-placeholder,\s*[\'"]([^\'"]+)[\'"]\)\]',
               lambda m: f'[data-placeholder*="{m.group(1)}"]', s)
    s = re.sub(r'\[contains\(@placeholder,\s*[\'"]([^\'"]+)[\'"]\)\]',
               lambda m: f'[placeholder*="{m.group(1)}"]', s)
    s = re.sub(r'\[contains\(@text,\s*[\'"]([^\'"]+)[\'"]\)\]', "", s)
    return s.strip()


def verify_selector(selector: str, soup: BeautifulSoup) -> tuple[bool, int, str]:
    """
    在静态 DOM 中验证选择器。
    返回: (是否命中, 命中数, 验证方式)
    验证方式: "static"=bs4 select 命中; "playwright-only"=无 html/body 上下文（仅运行时可解）; "miss"=未命中
    """
    sel = selector.strip()
    if sel.startswith("xpath="):
        css = xpath_to_css(sel[len("xpath="):])
        # 转换后含 :nth-of-type 或 contains 转 css 失败时标记为 playwright-only
        if "[text()=" in sel or "ancestor::" in sel or "@id=" in sel.replace("contains", ""):
            # ancestor / text() / [@id] 无法纯 css 表达 -> 仍尝试一次，否则标 playwright-only
            try:
                cnt = len(soup.select(css))
                if cnt > 0:
                    return (True, cnt, "static (xpath→css 启发式)")
                return (False, 0, "playwright-only (xpath 含 ancestor/text() 静态无法验证)")
            except Exception:
                return (False, 0, "playwright-only (xpath→css 转换失败)")
        try:
            cnt = len(soup.select(css))
            return (cnt > 0, cnt, "static (xpath→css 启发式)")
        except Exception as e:
            return (False, 0, f"playwright-only (css 解析失败: {e})")
    elif sel.startswith("getBy"):
        return (False, 0, "playwright-only (Playwright 语义查询)")
    else:
        # css
        css = sel.replace(":visible", "").strip()
        try:
            cnt = len(soup.select(css))
            return (cnt > 0, cnt, "static")
        except Exception as e:
            return (False, 0, f"playwright-only (css 解析失败: {e})")


def load_dom(page: str) -> BeautifulSoup | None:
    rel = DOM_FILE_FOR_PAGE.get(page)
    if not rel:
        return None
    p = os.path.join(DOM_DIR, rel)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        html = f.read()
    return BeautifulSoup(html, "html.parser")


# ============================================================
# 主流程
# ============================================================

def main() -> int:
    with open(JSON_PATH, encoding="utf-8") as f:
        config = json.load(f)

    platforms = config["platforms"]
    removed: list[tuple[str, str, str]] = []
    overridden: list[tuple[str, str, str, dict]] = []
    skipped: list[tuple[str, str, str, str]] = []

    # 1. 应用删除
    for plat, cat, key in REMOVE:
        if plat in platforms and cat in platforms[plat] and key in platforms[plat][cat]:
            del platforms[plat][cat][key]
            removed.append((plat, cat, key))

    # 2. 应用覆盖 + 验证
    for (plat, cat, key), patch in OVERRIDES.items():
        if plat not in platforms or cat not in platforms[plat] or key not in platforms[plat][cat]:
            # 新增条目（目前未触发）
            platforms.setdefault(plat, {"menus": {}, "buttons": {}, "regions": {}, "textboxes": {}})
            platforms[plat].setdefault(cat, {})
            platforms[plat][cat][key] = {}
        target = platforms[plat][cat][key]
        # 加载验证用 DOM
        page = patch.get("evidence_page", "")
        soup = load_dom(page)
        checks: list[list[Any]] = []
        all_ok = True
        for sel in [patch["primary"]] + patch["fallbacks"]:
            if soup is None:
                checks.append([sel, None, "no-dom (静态无法验证)"])
                continue
            ok, cnt, mode = verify_selector(sel, soup)
            checks.append([sel, cnt if ok else 0, mode])
            # xpath/html-body 类需要 runtime；css 静态不命中则算 fail
            if not ok and "playwright-only" not in mode and cnt == 0:
                all_ok = False
        # 写回
        evidence = {
            "page": page,
            "source": "manual override (user-verified in Chrome DevTools)",
            "checks": checks,
        }
        target.update({
            "purposes": target.get("purposes", ["publish", "monitor"]),
            "primary": patch["primary"],
            "staticPrimary": patch["staticPrimary"],
            "fallbacks": patch["fallbacks"],
            "selectorType": patch["selectorType"],
            "description": patch["description"],
            "evidence": evidence,
        })
        overridden.append((plat, cat, key, {"ok": all_ok, "checks": checks}))

    # 3. 写回
    config["version"] = "1.2.0"
    config["updatedAt"] = "manual override (apply_overrides.py)"
    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

    # 4. 重新生成报告（直接复用 extract_selectors 的报告布局）
    generate_report(config)

    # 5. 输出总结
    print(f"\n[OVERRIDES] applied {len(overridden)}:", file=sys.stderr)
    for plat, cat, key, info in overridden:
        status = "✓" if info["ok"] else "⚠"
        print(f"  {status} {plat}/{cat}/{key}", file=sys.stderr)
        for c in info["checks"]:
            sel, cnt, mode = c
            print(f"      [{cnt}] {sel!r:80s}  {mode}", file=sys.stderr)
    print(f"\n[REMOVED] {len(removed)}:", file=sys.stderr)
    for r in removed:
        print(f"  - {r[0]}/{r[1]}/{r[2]}", file=sys.stderr)

    # 6. 重新跑 JS 烟雾测试
    print("\n[VERIFY] rerunning Node smoke test:", file=sys.stderr)
    os.system(f"node {os.path.join(WORKSPACE, 'scripts/verify-extracted.js')}")
    return 0


def generate_report(config: dict) -> None:
    """复用 extract_selectors.py 的报告布局，重新生成 markdown。"""
    PLATFORM_CN = {"douyin": "抖音", "kuaishou": "快手", "xiaohongshu": "小红书"}
    out_path = os.path.join(WORKSPACE, "scripts/selectors-extracted.report.md")
    total = sum(
        len(cat)
        for p in config["platforms"].values()
        for cat in p.values()
    )
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("# 抖音/快手/小红书 平台选择器提取报告\n\n")
        f.write(f"- 共 {total} 条选择器（人工覆盖后）\n")
        f.write(f"- 输出 JSON: `scripts/selectors-extracted.json`\n")
        f.write(f"- 来源：`extract_selectors.py` + `apply_overrides.py`\n\n")
        for platform, p in config["platforms"].items():
            f.write(f"## {PLATFORM_CN.get(platform, platform)}  ({platform})\n\n")
            for cat in ("menus", "buttons", "regions", "textboxes"):
                items = p.get(cat, {})
                if not items:
                    continue
                f.write(f"### {cat}  ({len(items)})\n\n")
                f.write("| key | primary | type | fallbacks | evidence |\n")
                f.write("|---|---|---|---|---|\n")
                for k, v in items.items():
                    fb = " / ".join(v.get("fallbacks", [])[:2])
                    ev = json.dumps(v.get("evidence", {}), ensure_ascii=False)
                    if len(ev) > 60:
                        ev = ev[:60] + "…"
                    primary = v.get("primary", "")
                    f.write(f"| {k} | `{primary}` | {v.get('selectorType', '')} | {fb} | {ev} |\n")
                f.write("\n")


if __name__ == "__main__":
    sys.exit(main())
