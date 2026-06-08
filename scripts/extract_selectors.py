#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_selectors.py
====================
从 dom源文件 目录读取三个平台（抖音 / 快手 / 小红书）的 DOM 文本片段，
按照 Patchwright / Playwright / CDP "防风控" 元素查找方案的 9 层降级顺序：

  1. role  + name          (page.get_by_role)
  2. text    exact         (page.get_by_text exact=True)
  3. label                 (page.get_by_label)
  4. placeholder           (page.get_by_placeholder)
  5. test-id (data-testid) (page.get_by_test_id)
  6. css  with :visible    (locator("css >> :visible"))
  7. css  by id (有 #id)   (locator("#id"))
  8. xpath                 (locator("xpath=..."))
  9. CDP DOM.performSearch (脚本末尾注释说明，不在静态 DOM 中执行)

按"视频发布 / 视频监控"两大流程，针对每个平台提取：
  - 一级菜单 (menus)
  - 二级菜单 (menus)
  - 高清发布 / 发布作品 / 发布笔记 (menus)
  - 上传区域 (regions)
  - 上传后各种文本框 (textboxes)
  - 互动管理-评论管理-选择作品按钮 (buttons)
  - 选择作品点击后的滚动区域 + 视频条目 (regions + buttons)
  - 数据中心-作品分析 / 数据看板-内容分析 中的切换 / 列表按钮 (buttons)
  - 内容管理-作品管理 / 笔记管理 的滚动区域 (regions)
  - 数据中心-作品分析-投稿列表的滚动区域 (regions)

对每个候选选择器回放到原始 DOM 中验证命中数量 (self-verification)，
最后输出 scripts/selectors-extracted.json，结构与 packages/browser-core/src/selectorConfig.ts
中的 SelectorConfig 完全兼容，可直接被热更新/loader 加载。
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Optional

from bs4 import BeautifulSoup, Tag


# ============================================================
# 路径 & 常量
# ============================================================

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOM_DIR = os.path.join(WORKSPACE, "dom源文件")
OUT_DIR = os.path.join(WORKSPACE, "scripts")
OUT_JSON = os.path.join(OUT_DIR, "selectors-extracted.json")
OUT_REPORT = os.path.join(OUT_DIR, "selectors-extracted.report.md")

# 各平台 DOM 文件清单（路径相对 DOM_DIR）
PLATFORM_FILES: dict[str, dict[str, str]] = {
    "douyin": {
        "menu":            "抖音/菜单栏.txt",
        "publish":         "抖音/高清发布页面.txt",
        "publish_after":   "抖音/高清发布页面上传后.txt",
        "work_manage":     "抖音/内容管理-作品管理.txt",
        "works_analysis":  "抖音/数据中心-作品分析-投稿列表.txt",
        "comment_manage":  "抖音/互动管理-评论管理.txt",
        "select_works":    "抖音/互动管理-评论管理-选择作品.txt",
    },
    "kuaishou": {
        "menu":            "快手/菜单栏.txt",
        "publish":         "快手/发布作品页面.txt",
        "publish_after":   "快手/发布作品页面(点击上传后).txt",
        "work_manage":     "快手/内容管理-作品管理.txt",
        "select_videos":   "快手/互动管理-评论管理-点击选择视频页面.txt",
        "comment_manage":  "快手/互动管理-评论管理内页面.txt",
        "data_analysis":   "快手/数据中心-作品分析.txt",
    },
    "xiaohongshu": {
        "menu":            "小红书/菜单栏.txt",
        "publish":         "小红书/发布笔记页面.txt",
        "publish_after":   "小红书/发布笔记页面(点击上传后).txt",
        "note_manage":     "小红书/笔记管理页面.txt",
        "data_board":      "小红书/数据看板-内容分析.txt",
    },
}

PLATFORM_CN = {
    "douyin":      "抖音",
    "kuaishou":    "快手",
    "xiaohongshu": "小红书",
}


# ============================================================
# 数据结构
# ============================================================

@dataclass
class SelectorCandidate:
    """一个语义化 UI 元素的所有候选定位方式（按安全优先级排序）。"""
    key: str
    category: str            # menus / buttons / regions / textboxes
    platform: str
    purposes: list[str]      # publish / monitor
    description: str
    primary: str = ""        # 最安全的选择器（首选）
    fallbacks: list[str] = field(default_factory=list)
    selector_type: str = "css"
    evidence: dict = field(default_factory=dict)   # 验证结果


@dataclass
class PageIndex:
    """缓存的页面对象（已解析）+ 简单 helper。"""
    platform: str
    page_key: str
    file_path: str
    soup: BeautifulSoup
    raw_len: int
    element_count: int


# ============================================================
# 解析阶段
# ============================================================

def safe_read(path: str) -> str:
    """读取 utf-8 / utf-8-sig / gbk 兼容的中文文本。"""
    for enc in ("utf-8", "utf-8-sig", "gb18030"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    # 兜底：bytes -> utf-8 replace
    with open(path, "rb") as f:
        return f.read().decode("utf-8", errors="replace")


def load_pages() -> dict[str, list[PageIndex]]:
    out: dict[str, list[PageIndex]] = defaultdict(list)
    for platform, files in PLATFORM_FILES.items():
        for page_key, rel in files.items():
            abs_path = os.path.join(DOM_DIR, rel)
            if not os.path.exists(abs_path):
                print(f"[WARN] missing {abs_path}", file=sys.stderr)
                continue
            raw = safe_read(abs_path)
            soup = BeautifulSoup(raw, "html.parser")
            out[platform].append(PageIndex(
                platform=platform,
                page_key=page_key,
                file_path=abs_path,
                soup=soup,
                raw_len=len(raw),
                element_count=len(soup.find_all()),
            ))
    return out


# ============================================================
# 选择器计算 & 验证
# ============================================================

def text_of(el: Tag) -> str:
    t = el.get_text(" ", strip=True)
    return re.sub(r"\s+", " ", t)


def direct_text_of(el: Tag) -> str:
    """只取直接子文本（不递归子元素），用于菜单项短名称。"""
    parts = []
    for child in el.children:
        if isinstance(child, str):
            s = child.strip()
            if s:
                parts.append(s)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def has_visible_marker(el: Tag) -> bool:
    """判断元素是否被风控隐藏（display:none / visibility:hidden / aria-hidden=true）。"""
    if el.get("aria-hidden", "").lower() == "true":
        return False
    style = (el.get("style") or "").lower()
    if "display:none" in style or "display: none" in style or "visibility:hidden" in style:
        return False
    cls = " ".join(el.get("class") or [])
    if re.search(r"\bhidden\b|\binvisible\b|\bhide\b", cls.lower()):
        return False
    return True


def css_id_selector(el: Tag) -> Optional[str]:
    _id = el.get("id")
    if _id and re.fullmatch(r"[A-Za-z][A-Za-z0-9_\-:.]*", _id):
        return f"#{_id}"
    return None


def css_class_selector(el: Tag) -> Optional[str]:
    """使用 class 中第一个 token 构造 css selector，附加 :visible 防风控。"""
    classes = el.get("class") or []
    if not classes:
        return None
    cls = classes[0]
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_\-]*", cls):
        return None
    return f".{cls}:visible"


def xpath_for(el: Tag, soup: BeautifulSoup) -> str:
    """生成简短但唯一的最优 XPath。"""
    parts: list[str] = []
    cur: Optional[Tag] = el
    while cur is not None and getattr(cur, "name", None):
        if cur.name == "[document]":
            break
        seg = cur.name
        if cur.get("id") and re.fullmatch(r"[A-Za-z][A-Za-z0-9_\-:.]*", cur["id"]):
            seg += f"[@id='{cur['id']}']"
            parts.append(seg)
            break
        # 用兄弟索引定位
        parent = cur.parent
        if parent is not None and getattr(parent, "name", None):
            siblings = [c for c in parent.children
                        if isinstance(c, Tag) and c.name == cur.name]
            if len(siblings) > 1:
                idx = siblings.index(cur) + 1
                seg += f"[{idx}]"
        parts.append(seg)
        cur = parent if isinstance(parent, Tag) else None
    return "//" + "/".join(reversed(parts))


def role_selector(el: Tag) -> Optional[tuple[str, Optional[str]]]:
    """返回 (role, name) 用于 get_by_role，name 取 aria-label 或内文。"""
    role = el.get("role")
    if not role:
        # 隐式 role：button/input/textarea/select -> button/textbox/combobox
        tag = el.name
        if tag == "button":
            role = "button"
        elif tag in ("input", "textarea"):
            t = (el.get("type") or "text").lower()
            role = "textbox" if t in ("text", "search", "url", "tel", "") else "button"
        elif tag == "a" and el.get("href"):
            role = "link"
        elif tag == "select":
            role = "combobox"
        elif tag == "li" and el.parent and el.parent.get("role") == "menu":
            role = "menuitem"
        else:
            return None
    # name 优先 aria-label；否则用"直接子文本"以避免把展开后的子菜单文本当成自己
    name = (el.get("aria-label") or direct_text_of(el) or text_of(el)).strip()
    name = re.sub(r"\s+", " ", name)
    if not name or len(name) > 20:
        # 过长：菜单项名称取 header/title 类短文本
        for sub in el.find_all(["span", "div"], class_=re.compile(
                r"navigation-item-text|menu-title|d-menu-item__title|sub-menu__header|"
                r"submenu__title|el-submenu__title|navigation-item__title|"
                r"d-menu__title|menu-title-wrapper")):
            txt = sub.get_text(" ", strip=True)
            if 1 <= len(txt) <= 16:
                name = txt
                break
    if not name or len(name) > 20:
        return role, None
    return role, name


def label_text_for_input(el: Tag) -> Optional[str]:
    if el.name != "input" and el.name != "textarea":
        return None
    # 1) aria-label
    if el.get("aria-label"):
        return el["aria-label"].strip()
    # 2) placeholder
    if el.get("placeholder"):
        return None  # 用 placeholder 走第 4 层
    # 3) 关联 <label for=id>
    _id = el.get("id")
    if _id:
        for lb in el.find_all_previous("label"):
            if lb.get("for") == _id and text_of(lb):
                return text_of(lb)
    return None


def placeholder_of(el: Tag) -> Optional[str]:
    p = el.get("placeholder")
    return p.strip() if p else None


def testid_of(el: Tag) -> Optional[str]:
    v = el.get("data-testid") or el.get("data-test-id")
    return v.strip() if v else None


def verify_css(soup: BeautifulSoup, sel: str) -> int:
    """用 bs4 的 CSS 选择器回放验证。:visible 不可在静态 DOM 中判定，验证时只做语法命中数。"""
    try:
        sel_clean = sel.replace(":visible", "").strip()
        # 去掉 playwright chain (>>)
        if ">>" in sel_clean:
            sel_clean = sel_clean.split(">>")[0].strip()
        return len(soup.select(sel_clean))
    except Exception:
        return -1


def verify_xpath(soup: BeautifulSoup, xp: str) -> int:
    """XPath 验证：尝试用 lxml 解析，否则用启发式把常见 xpath 语法降级为 CSS。"""
    xpath = xp.replace("xpath=", "").strip()
    # 简单 xpath -> css 转换（仅支持 [1] 索引 + @id / @class）
    import re
    css = xpath
    # /html/body -> 去掉
    css = re.sub(r"^/?(html/)?body/?", "", css)
    # // 开头
    if css.startswith("//"):
        css = " " + css[2:]
    # /  ->  >
    css = css.replace("/", " > ")
    # [N] -> :nth-of-type(N)
    css = re.sub(r"\[(\d+)\]", r":nth-of-type(\1)", css)
    # [@id='xxx']  ->  #xxx
    css = re.sub(r"\[@id='([^']+)'\]", r"#\1", css)
    # [@class='xxx'] -> .xxx
    css = re.sub(r"\[@class='([^']+)'\]", r".\1", css)
    # @class 包含
    css = re.sub(r"\[contains\(@class,\s*'([^']+)'\)\]", r".\1", css)
    css = css.strip()
    if not css:
        return -1
    try:
        return len(soup.select(css))
    except Exception:
        return -1


# ============================================================
# 元素打分：按"防风控" 9 层优先级构造候选列表
# ============================================================

def candidates_for(el: Tag, page: PageIndex) -> dict[str, Any]:
    """收集一个元素在 9 层定位方案中的可用性，输出首选 + 回退 + 类型。"""
    cands: list[tuple[str, str, str]] = []   # (priority, type, expr)
    # 1) role + name
    rn = role_selector(el)
    if rn:
        role, name = rn
        if name:
            expr = f'getByRole("{role}", name="{name}")'
            cands.append((1, "role", expr))
        else:
            expr = f'getByRole("{role}")'
            cands.append((2, "role", expr))
    # 2) text — 优先直接子文本；含 header/title 子元素时取它们的短文本
    txt = direct_text_of(el)
    if not txt or len(txt) > 30:
        for sub in el.find_all(["span", "div"], class_=re.compile(
                r"sub-menu__header|menu-item__title|menu-title|submenu__title|"
                r"navigation-item-text|el-submenu__title")):
            t = sub.get_text(" ", strip=True)
            if 1 <= len(t) <= 16:
                txt = t
                break
    if not txt:
        txt = text_of(el)
    if 1 <= len(txt) <= 30:
        cands.append((3, "text", f'getByText("{txt}", exact=True)'))
    # 3) label
    lbl = label_text_for_input(el)
    if lbl:
        cands.append((4, "label", f'getByLabel("{lbl}")'))
    # 4) placeholder
    ph = placeholder_of(el)
    if ph:
        cands.append((5, "placeholder", f'getByPlaceholder("{ph}")'))
    # 5) test-id
    tid = testid_of(el)
    if tid:
        cands.append((6, "testid", f'getByTestId("{tid}")'))
    # 6/7) css by id / class
    css_id = css_id_selector(el)
    if css_id:
        cands.append((7, "css", css_id + ":visible" if has_visible_marker(el) else css_id))
    css_cls = css_class_selector(el)
    if css_cls:
        cands.append((8, "css", css_cls))
    # 8) xpath
    xp = xpath_for(el, page.soup)
    cands.append((9, "xpath", "xpath=" + xp))

    # 分类：playwright-safe (getBy*) / static-verifiable (css/xpath)
    safe_exprs: list[tuple[str, str, str]] = []   # 优先使用
    static_exprs: list[tuple[str, str, str]] = []  # 用于静态 DOM 验证 & 冷启动
    for p, t, expr in sorted(cands, key=lambda x: x[0]):
        if expr.startswith("getBy") or expr.startswith("xpath="):
            (static_exprs if expr.startswith("xpath=") else safe_exprs).append((p, t, expr))
        else:
            static_exprs.append((p, t, expr))

    # 1) primary = 最安全的 getBy* 表达式
    primary = safe_exprs[0][2] if safe_exprs else (static_exprs[0][2] if static_exprs else "")
    sel_type = (safe_exprs[0][1] if safe_exprs else (static_exprs[0][1] if static_exprs else "css"))
    # 2) staticPrimary = 最稳定的 css/xpath（用于冷启动 / 静态验证）
    static_primary = static_exprs[0][2] if static_exprs else ""
    static_type = static_exprs[0][1] if static_exprs else "css"
    # 3) fallbacks：safe 其它 + static 其它，按优先级拼接、去重
    seen: set[str] = set()
    fallbacks: list[str] = []
    for _, _, expr in safe_exprs[1:] + static_exprs:
        if expr in seen or expr == primary:
            continue
        seen.add(expr)
        fallbacks.append(expr)
        if len(fallbacks) >= 5:
            break
    return {
        "primary": primary,
        "type": sel_type,
        "staticPrimary": static_primary,
        "staticType": static_type,
        "fallbacks": fallbacks,
    }


# ============================================================
# 平台级提取策略
# ============================================================

def page_lookup(pages: dict[str, list[PageIndex]], platform: str, key: str) -> Optional[PageIndex]:
    for p in pages.get(platform, []):
        if p.page_key == key:
            return p
    return None


def add(sc: SelectorCandidate, page: PageIndex) -> None:
    """把候选回放验证到 page 上，存入 evidence 字段。

    验证策略：优先验证 staticPrimary（css/xpath），其次回退到 primary。
    """
    soup = page.soup
    static_primary = getattr(sc, "_static_primary", "") or ""
    targets = [static_primary] if static_primary else []
    targets += [sc.primary] if sc.primary and sc.primary not in targets else []
    targets += [fb for fb in sc.fallbacks if fb not in targets][:3]

    verified = []
    for sel in targets:
        if sel.startswith("getBy"):
            verified.append((sel, None, "playwright-only"))
            continue
        if sel.startswith("xpath="):
            hits = verify_xpath(soup, sel)
        else:
            hits = verify_css(soup, sel)
        verified.append((sel, hits, "static"))

    sc.evidence = {
        "page": page.page_key,
        "checks": verified,
        "staticVerified": next((v for v in verified if v[2] == "static" and (v[1] or 0) > 0), None),
    }


# -------- 通用：菜单/子菜单/页签/带文本的按钮 --------

def harvest_menu_items(page: PageIndex, selector: str = "li, a, [role='menuitem']") -> list[Tag]:
    return [el for el in page.soup.select(selector) if 1 <= len(text_of(el)) <= 18 and has_visible_marker(el)]


def make_entry(page: PageIndex, key: str, category: str, platform: str,
               el: Tag, description: str, purposes: list[str]) -> SelectorCandidate:
    cs = candidates_for(el, page)
    sc = SelectorCandidate(
        key=key, category=category, platform=platform, purposes=purposes,
        description=description, primary=cs["primary"], fallbacks=cs["fallbacks"],
        selector_type=cs["type"],
    )
    sc._static_primary = cs["staticPrimary"]
    add(sc, page)
    return sc


# -------- 抖音 --------

def extract_douyin(pages: dict[str, list[PageIndex]]) -> list[SelectorCandidate]:
    out: list[SelectorCandidate] = []
    menu = page_lookup(pages, "douyin", "menu")
    pub = page_lookup(pages, "douyin", "publish")
    pub_a = page_lookup(pages, "douyin", "publish_after")
    wm = page_lookup(pages, "douyin", "work_manage")
    wa = page_lookup(pages, "douyin", "works_analysis")
    cm = page_lookup(pages, "douyin", "comment_manage")
    sw = page_lookup(pages, "douyin", "select_works")

    # 一级/二级菜单
    if menu:
        for el in menu.soup.select("[id^='douyin-creator-master-menu-nav-']"):
            mid = el.get("id", "")
            if not mid:
                continue
            label = text_of(el)
            # 一级菜单 (id 不带 sub-wrap)
            level = 1
            if "menu-nav-content" in mid or "menu-nav-interaction" in mid or "menu-nav-data-center" in mid \
               or "menu-nav-cash" in mid or "menu-nav-create" in mid:
                # 父菜单，可展开
                key = "menu_" + mid.split("menu-nav-")[-1]
                out.append(make_entry(menu, key, "menus", "douyin", el,
                                      f"侧边栏一级菜单（可展开）：{label}",
                                      ["publish", "monitor"]))
            else:
                key = "menu_" + mid.split("menu-nav-")[-1]
                out.append(make_entry(menu, key, "menus", "douyin", el,
                                      f"侧边栏菜单项：{label}",
                                      ["publish", "monitor"]))

        # 高清发布按钮
        for el in menu.soup.select("#douyin-creator-master-side-upload, #douyin-creator-master-side-upload-wrap button"):
            out.append(make_entry(menu, "menu_publish_hd", "menus", "douyin", el,
                                  "侧边栏顶部【高清发布】按钮", ["publish"]))

    # 上传视频页
    if pub:
        for el in pub.soup.select("button"):
            t = text_of(el)
            if t in ("上传视频",):
                out.append(make_entry(pub, "btn_upload_video", "buttons", "douyin", el,
                                      "高清发布页【上传视频】入口", ["publish"]))
        # 整页是上传区域
        for el in pub.soup.select("[class*='container-drag']"):
            out.append(make_entry(pub, "region_upload_zone", "regions", "douyin", el,
                                  "抖音视频上传拖拽/点击区", ["publish"]))

    # 上传后页面：发布按钮、暂存离开、各种文本框
    if pub_a:
        for el in pub_a.soup.select("button"):
            t = text_of(el)
            if t in ("发布", "暂存离开"):
                key = "btn_publish_submit" if t == "发布" else "btn_publish_save_draft"
                out.append(make_entry(pub_a, key, "buttons", "douyin", el,
                                      f"发布页按钮：{t}", ["publish"]))
        # 文本框
        for el in pub_a.soup.select("input[type='text'], textarea, [contenteditable='true']"):
            placeholder = el.get("placeholder") or el.get("aria-label") or ""
            cls = " ".join(el.get("class") or [])
            ce = el.get("contenteditable")
            if ce == "true" and "zone-container" in cls:
                out.append(make_entry(pub_a, "tb_description", "textboxes", "douyin", el,
                                      "视频描述（contenteditable）", ["publish"]))
            elif placeholder and ("标题" in placeholder or "title" in placeholder.lower()):
                out.append(make_entry(pub_a, "tb_title", "textboxes", "douyin", el,
                                      f"视频标题输入框（{placeholder}）", ["publish"]))
            elif placeholder and ("话题" in placeholder or "tag" in placeholder.lower()):
                out.append(make_entry(pub_a, "tb_topic", "textboxes", "douyin", el,
                                      f"话题标签输入框（{placeholder}）", ["publish"]))
            elif placeholder and ("@") in placeholder:
                out.append(make_entry(pub_a, "tb_mention", "textboxes", "douyin", el,
                                      f"@ 好友输入框（{placeholder}）", ["publish"]))
            elif el.name == "input" and el.get("type") == "text":
                out.append(make_entry(pub_a, "tb_text", "textboxes", "douyin", el,
                                      f"普通文本输入框（{placeholder}）", ["publish"]))
        # 视频标题
        for el in pub_a.soup.select(".zone-container[contenteditable='true']"):
            out.append(make_entry(pub_a, "tb_description_editor", "textboxes", "douyin", el,
                                  "视频描述编辑区 (contenteditable)", ["publish"]))

    # 内容管理-作品管理：滚动区域
    if wm:
        # 24 个 video-card 卡片，找到它们最近的稳定容器作为滚动区域
        for el in wm.soup.select(".video-card-zQ02ng"):
            parent = el.parent
            if parent and parent.name in ("div",):
                # 选第一个 video-card 父级中可能为滚动容器的候选
                out.append(make_entry(wm, "region_work_list_item", "regions", "douyin", el,
                                      "作品管理列表中的视频卡片（24 个）", ["monitor"]))
                break
        # 找 role=tree/list 容器
        for el in wm.soup.select("[role='list'], [role='listbox'], [role='tree'], [role='feed'], [role='grid']"):
            out.append(make_entry(wm, "region_work_list_scroll", "regions", "douyin", el,
                                  "作品管理列表滚动容器（aria role）", ["monitor"]))

    # 数据中心-作品分析-投稿列表
    if wa:
        for el in wa.soup.select("[role='tablist']"):
            out.append(make_entry(wa, "btn_tabs_works_live", "buttons", "douyin", el,
                                  "投稿作品/直播场次 tablist", ["monitor"]))
        for el in wa.soup.select("[role='tab']"):
            t = text_of(el)
            key = "btn_tab_" + (t or "tab").strip()
            out.append(make_entry(wa, key, "buttons", "douyin", el,
                                  f"作品分析 tab：{t}", ["monitor"]))
        for el in wa.soup.select("[class*='radio-addon']"):
            t = text_of(el)
            if t in ("投稿分析", "投稿列表"):
                out.append(make_entry(wa, f"btn_radio_{t}", "buttons", "douyin", el,
                                      f"作品分析页 radio：{t}", ["monitor"]))
        # 投稿列表滚动
        for el in wa.soup.select("[role='grid'], [role='table'], [role='treegrid'], [role='list']"):
            out.append(make_entry(wa, "region_works_analysis_scroll", "regions", "douyin", el,
                                  "作品分析-投稿列表 滚动容器", ["monitor"]))
        # 导出/刷新数据按钮
        for el in wa.soup.select("button"):
            t = text_of(el)
            if t in ("导出数据", "刷新数据"):
                out.append(make_entry(wa, f"btn_works_{t}", "buttons", "douyin", el,
                                      f"作品分析页按钮：{t}", ["monitor"]))

    # 评论管理-选择作品
    if cm:
        for el in cm.soup.select("button"):
            t = text_of(el)
            if t == "选择作品":
                out.append(make_entry(cm, "btn_select_works", "buttons", "douyin", el,
                                      "评论管理-选择作品按钮", ["monitor"]))
            elif t == "发送":
                out.append(make_entry(cm, "btn_comment_send", "buttons", "douyin", el,
                                      "评论发送按钮", ["monitor"]))

    if sw:
        # 视频项
        for el in sw.soup.select(".container-Lkxos9"):
            out.append(make_entry(sw, "btn_works_pick_item", "buttons", "douyin", el,
                                  "选择作品弹窗中可点击的视频条目", ["monitor"]))
            break
        # 滚动容器
        for el in sw.soup.select("[class*='sidesheet'], [class*='spin'], [class*='list-items']"):
            out.append(make_entry(sw, "region_works_pick_scroll", "regions", "douyin", el,
                                  "选择作品弹窗的滚动区域", ["monitor"]))
        # 视频标题
        for el in sw.soup.select(".title-LUOP3b"):
            out.append(make_entry(sw, "text_works_pick_title", "textboxes", "douyin", el,
                                  "选择作品-视频标题文本节点（用于 text 匹配）", ["monitor"]))
            break
    return out


# -------- 快手 --------

def extract_kuaishou(pages: dict[str, list[PageIndex]]) -> list[SelectorCandidate]:
    out: list[SelectorCandidate] = []
    menu = page_lookup(pages, "kuaishou", "menu")
    pub = page_lookup(pages, "kuaishou", "publish")
    pub_a = page_lookup(pages, "kuaishou", "publish_after")
    wm = page_lookup(pages, "kuaishou", "work_manage")
    sv = page_lookup(pages, "kuaishou", "select_videos")
    cm = page_lookup(pages, "kuaishou", "comment_manage")
    da = page_lookup(pages, "kuaishou", "data_analysis")

    if menu:
        # 一级菜单: 直接的 .el-menu-item
        for el in menu.soup.select(".el-menu > .el-menu-item, .el-menu > .el-submenu > .el-submenu__title"):
            t = text_of(el).strip()
            if not t:
                continue
            if "publish-button" in " ".join(el.get("class") or []):
                out.append(make_entry(menu, "menu_publish", "menus", "kuaishou", el,
                                      "侧边栏顶部【发布作品】按钮", ["publish"]))
                continue
            key = "menu_" + (t or "item")
            out.append(make_entry(menu, key, "menus", "kuaishou", el,
                                  f"侧边栏一级菜单：{t}", ["publish", "monitor"]))
        # 二级菜单
        for el in menu.soup.select(".el-menu .el-menu--inline > .el-menu-item"):
            t = text_of(el).strip()
            if not t:
                continue
            key = "menu_sub_" + re.sub(r"\W+", "_", t)
            out.append(make_entry(menu, key, "menus", "kuaishou", el,
                                  f"侧边栏二级菜单：{t}", ["publish", "monitor"]))

    if pub:
        # 上传视频 tab
        for el in pub.soup.select("[role='tab']"):
            t = text_of(el)
            out.append(make_entry(pub, f"tab_{t}", "buttons", "kuaishou", el,
                                  f"快手发布 tab：{t}", ["publish"]))
        for el in pub.soup.select("button"):
            t = text_of(el)
            if t in ("上传视频", "上传图文", "继续编辑", "放弃", "立即体验"):
                out.append(make_entry(pub, f"btn_{t}", "buttons", "kuaishou", el,
                                      f"快手发布页按钮：{t}", ["publish"]))
        for el in pub.soup.select("[class*='upload'], [class*='drag']"):
            out.append(make_entry(pub, "region_upload_zone", "regions", "kuaishou", el,
                                  "快手视频上传区域", ["publish"]))

    if pub_a:
        # 描述编辑区
        for el in pub_a.soup.select("#work-description-edit, [class*='description']"):
            out.append(make_entry(pub_a, "tb_description", "textboxes", "kuaishou", el,
                                  "快手视频描述编辑区", ["publish"]))
        for el in pub_a.soup.select("input[type='text'], textarea"):
            placeholder = el.get("placeholder") or el.get("aria-label") or ""
            if placeholder and ("标题" in placeholder or "title" in placeholder.lower()):
                out.append(make_entry(pub_a, "tb_title", "textboxes", "kuaishou", el,
                                      f"快手标题输入框（{placeholder}）", ["publish"]))
            elif placeholder:
                out.append(make_entry(pub_a, f"tb_{placeholder[:8]}", "textboxes", "kuaishou", el,
                                      f"快手输入框（{placeholder}）", ["publish"]))
        # 发布按钮
        for el in pub_a.soup.select("button"):
            t = text_of(el)
            if t in ("发布", "发布作品"):
                out.append(make_entry(pub_a, "btn_publish_submit", "buttons", "kuaishou", el,
                                      "快手发布按钮", ["publish"]))
        # 主题标签相关 (#ai-bar-container)
        for el in pub_a.soup.select("#ai-button, .ai-button"):
            out.append(make_entry(pub_a, "btn_ai_assistant", "buttons", "kuaishou", el,
                                  "快手 AI 助手按钮", ["publish"]))

    if wm:
        # tabs
        for el in wm.soup.select("[role='tab']"):
            t = text_of(el)
            if t in ("全部作品", "已发布", "待发布", "未通过"):
                out.append(make_entry(wm, f"tab_{t}", "buttons", "kuaishou", el,
                                      f"作品管理 tab：{t}", ["monitor"]))
        # 滚动列表 main-container-infinite-list
        for el in wm.soup.select(".main-container-infinite-list"):
            out.append(make_entry(wm, "region_work_list_scroll", "regions", "kuaishou", el,
                                  "快手作品管理无限滚动容器", ["monitor"]))
        # tab panes
        for el in wm.soup.select("[role='tabpanel']"):
            out.append(make_entry(wm, f"region_pane_{el.get('id', 'pane')}", "regions", "kuaishou", el,
                                  f"快手作品管理 tabpanel（{el.get('id','')}）", ["monitor"]))

    if sv:
        # 选择视频弹窗的视频项
        for el in sv.soup.select("[class*='item'], [class*='video-card']"):
            out.append(make_entry(sv, "btn_video_pick_item", "buttons", "kuaishou", el,
                                  "快手选择视频弹窗中的视频条目", ["monitor"]))
            break
        for el in sv.soup.select("[class*='list'], [class*='scroll']"):
            out.append(make_entry(sv, "region_video_pick_scroll", "regions", "kuaishou", el,
                                  "快手选择视频弹窗的滚动区域", ["monitor"]))
        for el in sv.soup.select("button"):
            t = text_of(el)
            if t in ("选择", "确定", "取消"):
                out.append(make_entry(sv, f"btn_{t}", "buttons", "kuaishou", el,
                                      f"选择视频弹窗按钮：{t}", ["monitor"]))

    if cm:
        # 评论管理内页：选择视频按钮
        for el in cm.soup.select("button"):
            t = text_of(el)
            if "选择视频" in t:
                out.append(make_entry(cm, "btn_select_videos", "buttons", "kuaishou", el,
                                      "评论管理-选择视频按钮", ["monitor"]))

    if da:
        # 数据中心-作品分析
        for el in da.soup.select("[class*='tab'], [role='tab']"):
            t = text_of(el)
            if t and len(t) < 12:
                out.append(make_entry(da, f"tab_{t}", "buttons", "kuaishou", el,
                                      f"快手作品分析 tab：{t}", ["monitor"]))
        for el in da.soup.select("[class*='list'], [class*='scroll']"):
            out.append(make_entry(da, "region_works_analysis_scroll", "regions", "kuaishou", el,
                                  "快手作品分析-滚动区域", ["monitor"]))
    return out


# -------- 小红书 --------

def extract_xiaohongshu(pages: dict[str, list[PageIndex]]) -> list[SelectorCandidate]:
    out: list[SelectorCandidate] = []
    menu = page_lookup(pages, "xiaohongshu", "menu")
    pub = page_lookup(pages, "xiaohongshu", "publish")
    pub_a = page_lookup(pages, "xiaohongshu", "publish_after")
    nm = page_lookup(pages, "xiaohongshu", "note_manage")
    db = page_lookup(pages, "xiaohongshu", "data_board")

    if menu:
        # 顶部发布笔记按钮
        for el in menu.soup.select(".btn-wrapper, .btn-inner"):
            out.append(make_entry(menu, "menu_publish", "menus", "xiaohongshu", el,
                                  "侧边栏顶部【发布笔记】按钮", ["publish"]))
        # 一级菜单
        for el in menu.soup.select(".d-menu-item.d-menu-horizontal-icon, .d-sub-menu"):
            # 优先取 header / d-menu-item__title 短文本
            t = (el.get("aria-label")
                 or direct_text_of(el)
                 or (el.select_one(".d-sub-menu__header").get_text(" ", strip=True)
                     if el.select_one(".d-sub-menu__header") else "")
                 or (el.select_one(".d-menu-item__title").get_text(" ", strip=True)
                     if el.select_one(".d-menu-item__title") else "")
                 or text_of(el)).strip()
            t = re.sub(r"\s+", " ", t)
            if not t or len(t) > 16:
                continue
            key = "menu_" + re.sub(r"\W+", "_", t)
            out.append(make_entry(menu, key, "menus", "xiaohongshu", el,
                                  f"侧边栏菜单：{t}", ["publish", "monitor"]))
        # 二级菜单
        for el in menu.soup.select(".d-sub-menu__content .d-menu-item"):
            t = direct_text_of(el) or text_of(el)
            t = re.sub(r"\s+", " ", t).strip()
            if not t or len(t) > 16:
                continue
            key = "menu_sub_" + re.sub(r"\W+", "_", t)
            out.append(make_entry(menu, key, "menus", "xiaohongshu", el,
                                  f"侧边栏二级菜单：{t}", ["publish", "monitor"]))

    if pub:
        for el in pub.soup.select("button"):
            t = text_of(el)
            if "上传视频" in t:
                out.append(make_entry(pub, "btn_upload_video", "buttons", "xiaohongshu", el,
                                      "小红书发布-上传视频入口", ["publish"]))
        for el in pub.soup.select("[class*='upload'], [class*='drag']"):
            out.append(make_entry(pub, "region_upload_zone", "regions", "xiaohongshu", el,
                                  "小红书发布-上传区域", ["publish"]))

    if pub_a:
        # 文本框/选择器
        # 标题
        for el in pub_a.soup.select("input[placeholder*='标题'], input[placeholder*='title']"):
            out.append(make_entry(pub_a, "tb_title", "textboxes", "xiaohongshu", el,
                                  f"小红书标题输入框（{el.get('placeholder')}）", ["publish"]))
        # 描述（contenteditable）
        for el in pub_a.soup.select("[contenteditable='true']"):
            out.append(make_entry(pub_a, "tb_description", "textboxes", "xiaohongshu", el,
                                  "小红书正文编辑区", ["publish"]))
        # 话题/用户/表情 按钮 (id: topicBtn, userBtn, emoticonsBtn)
        for el in pub_a.soup.select("#topicBtn, .contentBtn"):
            t = text_of(el)
            key = "btn_topic" if t == "话题" or el.get("id") == "topicBtn" else f"btn_{t}"
            out.append(make_entry(pub_a, key, "buttons", "xiaohongshu", el,
                                  f"小红书发布-插入工具按钮：{t or el.get('id')}", ["publish"]))
        # 各种 d-select：添加内容类型、添加地点、选择群聊、公开可见
        for el in pub_a.soup.select(".d-select-wrapper"):
            t = text_of(el).strip()
            if not t:
                continue
            key = "select_" + re.sub(r"\W+", "_", t)
            out.append(make_entry(pub_a, key, "buttons", "xiaohongshu", el,
                                  f"小红书发布-选择器：{t}", ["publish"]))
        # 发布按钮
        for el in pub_a.soup.select("button"):
            t = text_of(el)
            if t in ("发布", "发布笔记", "下一步", "提交"):
                out.append(make_entry(pub_a, f"btn_{t}", "buttons", "xiaohongshu", el,
                                      f"小红书发布按钮：{t}", ["publish"]))

    if nm:
        # 滚动区域
        for el in nm.soup.select("#notes-request, [class*='note-list'], [class*='scroll']"):
            out.append(make_entry(nm, "region_note_list_scroll", "regions", "xiaohongshu", el,
                                  "小红书笔记管理-滚动区域", ["monitor"]))
        # 笔记管理 tab
        for el in nm.soup.select("[role='tab'], [class*='tab']"):
            t = text_of(el).strip()
            if t and len(t) < 10:
                out.append(make_entry(nm, f"tab_{re.sub(r'\\W+','_',t)}", "buttons", "xiaohongshu", el,
                                      f"笔记管理 tab：{t}", ["monitor"]))

    if db:
        # 数据看板-内容分析：切换页面按钮
        for el in db.soup.select("button"):
            t = text_of(el)
            if t in ("导出数据", "刷新", "切换", "详情", "详情数据"):
                out.append(make_entry(db, f"btn_{re.sub(r'\\W+','_',t)}", "buttons", "xiaohongshu", el,
                                      f"数据看板按钮：{t}", ["monitor"]))
        # 表头切换 / 真 tab（role=tab 或 d-tabs 类名），过滤掉 d-table__cell 单元格
        for el in db.soup.select("[role='tab']"):
            t = text_of(el).strip()
            if t and len(t) < 16:
                out.append(make_entry(db, f"tab_{re.sub(r'\\W+','_',t)}", "buttons", "xiaohongshu", el,
                                      f"数据看板 tab：{t}", ["monitor"]))
        # 表单筛选
        for el in db.soup.select(".d-form-item__label, .d-form-item__title"):
            t = text_of(el).strip()
            if t:
                out.append(make_entry(db, f"form_{re.sub(r'\\W+','_',t)}", "regions", "xiaohongshu", el,
                                      f"数据看板筛选项：{t}", ["monitor"]))
        # 滚动
        for el in db.soup.select("[class*='scroll'], [class*='list'], [class*='table']"):
            cls = " ".join(el.get("class") or [])
            if "d-table__cell" in cls:  # 单元格不是滚动区
                continue
            out.append(make_entry(db, "region_data_board_scroll", "regions", "xiaohongshu", el,
                                  "数据看板-内容分析-滚动区域", ["monitor"]))
    return out


# ============================================================
# 主流程
# ============================================================

def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    pages = load_pages()
    print(f"[INFO] loaded {sum(len(v) for v in pages.values())} DOM files", file=sys.stderr)

    all_entries: list[SelectorCandidate] = []
    all_entries += extract_douyin(pages)
    all_entries += extract_kuaishou(pages)
    all_entries += extract_xiaohongshu(pages)

    # 去重：同 (platform, key) 保留第一个
    seen: set[tuple[str, str]] = set()
    unique: list[SelectorCandidate] = []
    for sc in all_entries:
        k = (sc.platform, sc.key)
        if k in seen:
            continue
        seen.add(k)
        unique.append(sc)

    # 输出 SelectorConfig 兼容结构
    config: dict[str, Any] = {
        "version": "1.1.0",
        "updatedAt": "auto-extracted",
        "source": "scripts/extract_selectors.py",
        "selectorStrategy": [
            "1. role + name (page.get_by_role)",
            "2. text exact  (page.get_by_text)",
            "3. label       (page.get_by_label)",
            "4. placeholder (page.get_by_placeholder)",
            "5. test-id     (page.get_by_test_id)",
            "6. css :visible+id",
            "7. css :visible+class",
            "8. xpath",
            "9. CDP DOM.performSearch (runtime, 静态 DOM 不可验证)"
        ],
        "platforms": {}
    }
    for sc in unique:
        ps = config["platforms"].setdefault(sc.platform, {"menus": {}, "buttons": {}, "regions": {}, "textboxes": {}})
        if sc.key in ps[sc.category]:
            continue
        ps[sc.category][sc.key] = {
            "purposes": sc.purposes,
            "primary": sc.primary,
            "staticPrimary": getattr(sc, "_static_primary", ""),
            "fallbacks": sc.fallbacks,
            "selectorType": sc.selector_type,
            "description": sc.description,
            "evidence": sc.evidence,
        }

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    print(f"[OK] {OUT_JSON}  ({len(unique)} entries)", file=sys.stderr)

    # 生成可读 report
    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        f.write("# 抖音/快手/小红书 平台选择器提取报告\n\n")
        f.write(f"- 共 {len(unique)} 条选择器\n")
        f.write(f"- 输出 JSON: `{os.path.relpath(OUT_JSON, WORKSPACE)}`\n\n")
        for platform, p in config["platforms"].items():
            f.write(f"## {PLATFORM_CN.get(platform, platform)}  ({platform})\n\n")
            for cat in ("menus", "buttons", "regions", "textboxes"):
                items = p[cat]
                if not items:
                    continue
                f.write(f"### {cat}  ({len(items)})\n\n")
                f.write("| key | primary | type | fallbacks | evidence |\n")
                f.write("|---|---|---|---|---|\n")
                for k, v in items.items():
                    fb = " / ".join(v["fallbacks"][:2])
                    ev = json.dumps(v["evidence"], ensure_ascii=False)
                    if len(ev) > 60:
                        ev = ev[:60] + "…"
                    f.write(f"| {k} | `{v['primary']}` | {v['selectorType']} | {fb} | {ev} |\n")
                f.write("\n")
    print(f"[OK] {OUT_REPORT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
