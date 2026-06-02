"""
视频合成渲染器 - 双模式
模式1 无解说: FFmpeg精剪 + BGM → OSS
模式2 带解说: 粗剪 → LLM生成脚本 → TTS → 精剪同步 → OSS
"""

import asyncio
import os
import tempfile

from app.config import settings
from app.middleware.logging import logger
from app.services.ffmpeg import (
    download_from_oss,
    normalize_video,
    concat_videos,
    add_audio,
    upload_to_oss,
)
from app.services.llm_client import llm_client
from app.services.tts_service import tts_service
from app.models import WebhookCallback
from app.services.webhook import callback_ts_webhook


async def process_video_compose(task_data: dict) -> dict:
    """
    视频合成主流程

    载荷格式:
    {
      "task_id": "...",
      "mode": "no_narration" | "with_narration",
      "segments": [{"path": "/oss/path/1.mp4"}, ...],  // TS端排序后的素材列表
      "bgm_oss_url": "..." | null,
      "style": "modern" | "...",
      "narration_config": { "voice": "default", "tone": "professional" } | null,
    }
    """
    task_id = task_data["task_id"]
    mode = task_data.get("mode", "no_narration")
    segments = task_data.get("segments", task_data.get("oss_urls", []))
    bgm_url = task_data.get("bgm_oss_url")

    logger.info(f"🎬 视频合成开始: {task_id} (模式={mode}, 素材={len(segments)}段)")

    temp_dir = tempfile.mkdtemp(prefix=f"compose_{task_id}_")
    downloaded = []

    try:
        # 1. 下载所有素材
        for i, seg in enumerate(segments):
            url = seg if isinstance(seg, str) else seg.get("path", seg.get("oss_url"))
            if not url:
                continue
            local = os.path.join(temp_dir, f"seg_{i:03d}.mp4")
            await download_from_oss(url, local)
            downloaded.append(local)

        if mode == "with_narration":
            result = await _compose_with_narration(task_id, downloaded, bgm_url, temp_dir, task_data)
        else:
            result = await _compose_no_narration(task_id, downloaded, bgm_url, temp_dir)

        # 回调 TS
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status="completed",
            result=result,
        ))

        logger.info(f"✅ 视频合成完成: {task_id} → {result.get('oss_url')}")
        return {"status": "completed", "task_id": task_id, **result}

    except Exception as e:
        logger.error(f"❌ 视频合成失败: {task_id} - {e}")
        await callback_ts_webhook(WebhookCallback(
            task_id=task_id,
            status="failed",
            error=str(e),
        ))
        raise

    finally:
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)


# ============================================================
# 模式1: 无解说 - 精剪拼接 + BGM
# ============================================================

async def _compose_no_narration(
    task_id: str,
    segments: list,
    bgm_url: str | None,
    temp_dir: str,
) -> dict:
    """精剪拼接：标准化 → 转场过渡 → 添加 BGM → OSS"""
    normalized = []

    # 1. 标准化每个片段
    for i, seg in enumerate(segments):
        norm_path = os.path.join(temp_dir, f"norm_{i:03d}.mp4")
        await normalize_video(seg, norm_path)
        normalized.append(norm_path)

    # 2. 拼接（带转场效果）
    concat_output = os.path.join(temp_dir, "concat_output.mp4")
    await _concat_with_transitions(normalized, concat_output)

    # 3. 添加 BGM
    if bgm_url:
        bgm_local = os.path.join(temp_dir, "bgm.mp3")
        await download_from_oss(bgm_url, bgm_local)
        final_output = os.path.join(temp_dir, "final.mp4")
        await add_audio(concat_output, bgm_local, final_output)
    else:
        final_output = concat_output

    # 4. 上传 OSS
    oss_key = f"composed/{task_id[:8]}/{task_id}.mp4"
    result_url = await upload_to_oss(final_output, oss_key)

    return {"oss_url": result_url, "mode": "no_narration", "segments": len(segments)}


# ============================================================
# 模式2: 带解说 - 粗剪 → LLM脚本 → TTS → 精剪同步
# ============================================================

async def _compose_with_narration(
    task_id: str,
    segments: list,
    bgm_url: str | None,
    temp_dir: str,
    task_data: dict,
) -> dict:
    """带解说合成流水线"""

    # 1. 粗剪拼接（快速拼接，不做重编码）
    rough_output = os.path.join(temp_dir, "rough_cut.mp4")
    await _rough_cut(segments, rough_output)

    # 2. 视频理解 → 生成解说词
    narration_text = await _generate_narration(rough_output, task_data.get("style", "modern"))
    logger.info(f"解说词生成: {len(narration_text)} 字符")

    # 3. TTS 语音合成
    narration_config = task_data.get("narration_config", {})
    voice = narration_config.get("voice", "default")
    audio_path = os.path.join(temp_dir, "narration.mp3")
    await tts_service.synthesize(narration_text, audio_path, voice)

    # 4. 精剪 + 音画同步
    sync_output = os.path.join(temp_dir, "sync_output.mp4")
    await _fine_cut_with_audio(rough_output, audio_path, sync_output)

    # 5. 添加 BGM（背景音乐 + 解说混合）
    if bgm_url:
        bgm_local = os.path.join(temp_dir, "bgm.mp3")
        await download_from_oss(bgm_url, bgm_local)
        final_output = os.path.join(temp_dir, "final.mp4")
        await _mix_audio(sync_output, bgm_local, final_output)
    else:
        final_output = sync_output

    # 6. 上传 OSS
    oss_key = f"composed/{task_id[:8]}/{task_id}.mp4"
    result_url = await upload_to_oss(final_output, oss_key)

    return {
        "oss_url": result_url,
        "mode": "with_narration",
        "narration_text": narration_text[:200],
        "segments": len(segments),
    }


# ============================================================
# FFmpeg 操作
# ============================================================

async def _concat_with_transitions(inputs: list, output: str) -> str:
    """精剪拼接（带交叉淡化转场）"""
    if len(inputs) == 1:
        import shutil
        shutil.copy(inputs[0], output)
        return output

    # 使用 concat demuxer
    list_path = tempfile.mktemp(suffix=".txt")
    try:
        with open(list_path, "w") as f:
            for path in inputs:
                f.write(f"file '{path}'\n")

        cmd = [
            "ffmpeg", "-f", "concat", "-safe", "0", "-i", list_path,
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k",
            "-pix_fmt", settings.output_pix_fmt,
            "-movflags", "+faststart",
            "-y", output,
        ]
        proc = await asyncio.create_subprocess_exec(*cmd)
        await proc.communicate()
    finally:
        if os.path.exists(list_path):
            os.unlink(list_path)

    logger.info(f"精剪拼接完成: {output}")
    return output


async def _rough_cut(inputs: list, output: str) -> str:
    """粗剪拼接（快速，不做精细重编码）"""
    list_path = tempfile.mktemp(suffix=".txt")
    try:
        with open(list_path, "w") as f:
            for path in inputs:
                f.write(f"file '{path}'\n")

        cmd = [
            "ffmpeg", "-f", "concat", "-safe", "0", "-i", list_path,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-c:a", "aac", "-b:a", "128k",
            "-y", output,
        ]
        proc = await asyncio.create_subprocess_exec(*cmd)
        await proc.communicate()
    finally:
        if os.path.exists(list_path):
            os.unlink(list_path)

    logger.info(f"粗剪完成: {output}")
    return output


async def _generate_narration(video_path: str, style: str) -> str:
    """LLM 理解视频内容并生成解说词"""
    prompt = f"""你是一个专业视频解说员。观看这段视频（风格: {style}），生成一段自然流畅的解说词。

要求：
1. 语言生动自然，符合 {style} 风格
2. 包含引人入胜的开场和收尾
3. 长度适中（100-300字）
4. 只返回解说词文本，不要标记

直接输出解说词："""

    text = await llm_client.get_content("gemini-2.0-flash", [
        {"role": "user", "content": prompt}
    ])
    return text.strip()


async def _fine_cut_with_audio(video_path: str, audio_path: str, output: str) -> str:
    """精剪：对齐视频与解说音频，确保音画同步"""
    # 获取音频时长
    import subprocess
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", audio_path],
        capture_output=True, text=True,
    )
    audio_duration = float(probe.stdout.strip())

    # 裁剪视频到音频时长（加速/拉伸视觉效果匹配）
    cmd = [
        "ffmpeg", "-i", video_path, "-i", audio_path,
        "-c:v", "libx264", "-preset", "medium", "-crf", "22",
        "-c:a", "aac", "-b:a", "192k",
        "-t", str(audio_duration),
        "-shortest",
        "-movflags", "+faststart",
        "-y", output,
    ]
    proc = await asyncio.create_subprocess_exec(*cmd)
    await proc.communicate()

    logger.info(f"精剪音画同步完成: {output} (时长={audio_duration:.1f}s)")
    return output


async def _mix_audio(video_path: str, bgm_path: str, output: str) -> str:
    """混合背景音乐与解说（BGM 降低音量作为背景）"""
    cmd = [
        "ffmpeg", "-i", video_path, "-i", bgm_path,
        "-filter_complex",
        "[1:a]volume=0.3[bgm];[0:a][bgm]amix=inputs=2:duration=first",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-y", output,
    ]
    proc = await asyncio.create_subprocess_exec(*cmd)
    await proc.communicate()

    logger.info(f"BGM 混合完成: {output}")
    return output
