"""
素材更新任务 - 切分/抽帧/LLM评级/分类落盘
工作流: 下载素材 → 按间隔抽帧 → LLM风格评级(可配提示词) → 风格命中落盘
支持两种入口:
  1. video_url (新): HTTP 直链下载 → 按间隔抽帧 → 评估 → 落盘
  2. oss_urls (旧): OSS 下载 → 场景切分 → 抽帧 → 评估 → 落盘 (向后兼容)
"""

import asyncio
import base64
import json
import os
import shutil
import tempfile
from app.middleware.logging import logger
from app.middleware.trace import get_trace_id, set_trace_id
from app.config import settings
from app.services.ffmpeg import download_from_oss, download_from_url
from app.services.llm_client import llm_client
from app.models import WebhookCallback
from app.services.webhook import callback_ts_webhook
import httpx


MATERIAL_BASE = os.path.join(os.path.expanduser("~"), "data", "materials")


async def process_material_update(ctx, task_data: dict) -> dict:
    """
    素材更新主流程（ARQ 任务函数，ctx 为 ARQ 上下文）
    入参分发: video_url → 新路径, oss_urls → 旧路径
    """
    task_id = task_data["task_id"]
    trace_id = task_data.get("trace_id", task_id)
    set_trace_id(trace_id)

    # 从入参读取可配参数（新字段）
    candidate_id = task_data.get("candidate_id")
    evaluate_prompt = task_data.get("evaluate_prompt")
    styles = task_data.get("styles", [])
    min_rating = task_data.get("min_rating", 4)
    frame_interval_ms = task_data.get("frame_interval_ms", 1000)
    platform = task_data.get("platform", "unknown")
    video_url = task_data.get("video_url")

    logger.info(f"🎬 素材更新开始: {task_id} (candidate={candidate_id})")

    temp_dir = tempfile.mkdtemp(prefix=f"material_{task_id}_")
    downloaded = []

    try:
        # 1. 下载素材（入参分发）
        if video_url:
            # 新路径: HTTP 直链下载
            local = os.path.join(temp_dir, f"source_video{_ext_from_url(video_url)}")
            await download_from_url(video_url, local)
            downloaded.append(local)
            logger.info(f"HTTP 直链下载: {os.path.basename(local)}")
        else:
            # 旧路径: OSS 下载（向后兼容）
            oss_urls = task_data.get("oss_urls", [task_data.get("oss_url")])
            for i, url in enumerate(oss_urls):
                if not url:
                    continue
                local = os.path.join(temp_dir, f"source_{i}{_ext_from_url(url)}")
                await download_from_oss(url, local)
                downloaded.append(local)
                logger.info(f"OSS 下载: {os.path.basename(local)}")

        # 2. 逐素材处理
        results = []
        for src_path in downloaded:
            is_image = src_path.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif'))

            if is_image:
                frames = [src_path]
            else:
                # 视频按间隔抽帧
                frames = await _extract_frames_by_interval(src_path, temp_dir, frame_interval_ms)

            if frames:
                result = await _rate_and_match(frames, evaluate_prompt, styles, min_rating)
            else:
                result = {"style": None, "rating": 0, "matched": False, "accepted": False}

            results.append(result)

        # 3. 分类落盘（仅 accepted 的素材）
        moved = await _classify_and_store(downloaded, results, platform, task_id, styles)

        # 4. 回调 TS
        primary_result = results[0] if results else {"style": None, "accepted": False}
        await _callback_material(
            candidate_id=candidate_id,
            task_id=task_id,
            status="completed",
            style=primary_result.get("style") if primary_result.get("accepted") else None,
            accepted=primary_result.get("accepted", False),
            total=len(downloaded),
            moved=moved,
        )

        logger.info(f"✅ 素材更新完成: {task_id} ({moved}/{len(downloaded)} 落盘)")
        return {"status": "completed", "task_id": task_id, "count": moved}

    except Exception as e:
        logger.error(f"❌ 素材更新失败: {task_id} - {e}")
        await _callback_material(
            candidate_id=candidate_id,
            task_id=task_id,
            status="failed",
            style=None,
            accepted=False,
            total=0,
            moved=0,
            error=str(e),
        )
        raise

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ============================================================
# 内部辅助函数
# ============================================================

async def _extract_frames_by_interval(video_path: str, output_dir: str, interval_ms: int) -> list:
    """
    按 fps filter 等间隔抽帧（替换旧的场景切分 + 每段 1 帧）。
    interval_ms 毫秒抽一帧。
    """
    fps = 1000.0 / interval_ms if interval_ms > 0 else 1.0
    output_pattern = os.path.join(output_dir, "frame_%04d.jpg")
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps={fps:.6f}",
        "-q:v", "2",
        "-y", output_pattern,
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.communicate(), timeout=300)
    except asyncio.TimeoutError:
        logger.warning(f"抽帧超时(300s)，使用已生成的帧")

    frames = sorted([
        os.path.join(output_dir, f) for f in os.listdir(output_dir)
        if f.startswith("frame_") and f.endswith(".jpg")
    ])
    logger.info(f"按间隔({interval_ms}ms)抽帧: {len(frames)} 帧")
    return frames


async def _rate_and_match(
    frames: list,
    evaluate_prompt: str | None,
    styles: list[dict],
    min_rating: int,
) -> dict:
    """
    LLM 评估 + 风格匹配。
    返回 {style, rating, matched, accepted, matched_style_dir}
    """
    prompt = evaluate_prompt or """分析这张视频截图，返回 JSON（只返回 JSON 不要其他内容）：
{
  "style": "风格分类名称",
  "rating": "品质评级 1-5 (1最低,5最高)",
  "description": "简短描述"
}"""

    # 取最多 3 帧评估
    ratings = []
    matched_styles = []
    for frame in frames[:3]:
        result = await _rate_image_with_llm(frame, prompt)
        if result:
            ratings.append(result)
            # 风格匹配
            style_name = result.get("style", "")
            for s in styles:
                s_name = s.get("name", "")
                s_keywords = s.get("keywords", [])
                if style_name == s_name or any(kw in style_name for kw in s_keywords):
                    matched_styles.append(s.get("dir", s_name))
                    break

    if not ratings:
        return {"style": None, "rating": 0, "matched": False, "accepted": False}

    # 取众数风格
    from collections import Counter
    style_counter = Counter(r.get("style", "") for r in ratings)
    primary_style = style_counter.most_common(1)[0][0] if style_counter else None

    # 平均评级
    avg_rating = round(sum(int(r.get("rating", 3)) for r in ratings) / len(ratings))

    # 风格命中 + 达标 → accepted
    matched = len(matched_styles) > 0
    accepted = matched and avg_rating >= min_rating
    matched_dir = matched_styles[0] if matched_styles else None

    return {
        "style": primary_style,
        "rating": avg_rating,
        "matched": matched,
        "accepted": accepted,
        "matched_style_dir": matched_dir,
    }


async def _rate_image_with_llm(image_path: str, prompt: str) -> dict | None:
    """
    发送图片 + prompt 到 LLM，返回解析后的 dict。
    使用 base64 编码图片，通过 multimodal 消息格式发送。
    """
    try:
        # 读取图片并 base64 编码
        with open(image_path, "rb") as f:
            image_b64 = base64.b64encode(f.read()).decode("utf-8")

        # 判断 MIME 类型
        ext = os.path.splitext(image_path)[1].lower()
        mime = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(ext, "image/jpeg")

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}"}},
                ],
            }
        ]

        text = await llm_client.get_content("gemini-2.0-flash", messages)
        cleaned = await _parse_json(text)
        return json.loads(cleaned)
    except Exception as e:
        logger.warning(f"LLM 评级降级: {e}")
        return None


async def _classify_and_store(
    sources: list,
    results: list,
    platform: str,
    task_id: str,
    styles: list[dict],
) -> int:
    """
    按风格命中落盘到 data/materials/{style_dir}/{platform}/
    仅 accepted 的素材才落盘。
    """
    moved = 0
    for src, result in zip(sources, results):
        if not result.get("accepted"):
            logger.info(f"跳过未达标素材: {os.path.basename(src)} (rating={result.get('rating')}, matched={result.get('matched')})")
            continue

        try:
            style_dir = result.get("matched_style_dir") or result.get("style") or "未分类"
            dest_dir = os.path.join(MATERIAL_BASE, style_dir, platform)
            os.makedirs(dest_dir, exist_ok=True)

            dest_path = os.path.join(dest_dir, os.path.basename(src))
            shutil.copy2(src, dest_path)
            moved += 1
            logger.info(f"归档: {os.path.relpath(dest_path, MATERIAL_BASE)}")
        except Exception as e:
            logger.warning(f"归档失败: {os.path.basename(src)} - {e}")
    return moved


async def _callback_material(
    candidate_id: str | None,
    task_id: str,
    status: str,
    style: str | None,
    accepted: bool,
    total: int,
    moved: int,
    error: str | None = None,
) -> None:
    """
    回调 TS 侧 /api/v1/material-update/webhook。
    带 candidate_id + style + status。
    """
    if not candidate_id:
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status=status,
            result={"total": total, "classified": moved, "style": style},
            error=error,
        ))
        return

    trace_id = get_trace_id()
    payload = {
        "candidate_id": candidate_id,
        "task_id": task_id,
        "status": status,
        "style": style if accepted else None,
        "result": {"total": total, "classified": moved, "accepted": accepted},
        "error": error,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                settings.ts_material_webhook_url,
                json=payload,
                headers={"X-Trace-Id": trace_id},
            )
            response.raise_for_status()
            logger.info(f"✅ Material webhook 回调成功: candidate={candidate_id}")
    except Exception as e:
        logger.error(f"❌ Material webhook 回调失败: candidate={candidate_id} - {e}")


def _ext_from_url(url: str) -> str:
    """从 URL 提取文件扩展名"""
    from urllib.parse import urlparse
    ext = os.path.splitext(urlparse(url).path)[1]
    return ext if ext else ".mp4"


async def _parse_json(text: str) -> str:
    """剥离 Markdown 代码块，返回纯 JSON 字符串"""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1])
    return text
