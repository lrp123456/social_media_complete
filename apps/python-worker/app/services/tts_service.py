"""
TTS 语音合成服务 - Qwen3 本地模型
将解说词文本转换为音频文件
"""

import asyncio
import os
import tempfile
import httpx
from app.config import settings
from app.middleware.logging import logger


class TTSService:
    """TTS 语音合成（Qwen3 / IndexTTS2）"""

    @staticmethod
    async def synthesize(text: str, output_path: str, voice: str = "default") -> str:
        """
        合成语音
        优先使用本地 Qwen3 TTS 容器，降级到 HTTP 服务
        """
        # 尝试本地 TTS HTTP 端点
        try:
            return await TTSService._synthesize_http(text, output_path, voice)
        except Exception as e:
            logger.warning(f"TTS HTTP 失败，尝试本地脚本: {e}")
            return await TTSService._synthesize_script(text, output_path, voice)

    @staticmethod
    async def _synthesize_http(text: str, output_path: str, voice: str) -> str:
        """通过 HTTP 调用 TTS 服务"""
        tts_url = getattr(settings, "tts_url", "http://localhost:8080")
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{tts_url}/synthesize",
                json={
                    "text": text,
                    "voice": voice,
                    "speed": 1.0,
                    "format": "mp3",
                },
            )
            response.raise_for_status()
            with open(output_path, "wb") as f:
                f.write(response.content)
        logger.info(f"TTS 合成完成: {output_path} ({len(text)} 字符)")
        return output_path

    @staticmethod
    async def _synthesize_script(text: str, output_path: str, voice: str) -> str:
        """通过子进程调用 TTS 脚本（降级方案）"""
        # 写入临时文本文件
        text_file = tempfile.mktemp(suffix=".txt")
        try:
            with open(text_file, "w", encoding="utf-8") as f:
                f.write(text)

            # 调用 TTS 脚本
            script_path = os.path.join(
                os.path.dirname(__file__), "..", "..", "..", "scripts", "tts_generator.py"
            )
            cmd = [
                "python3", script_path,
                "--text", text,
                "--output", output_path,
                "--voice", voice,
            ]
            proc = await asyncio.create_subprocess_exec(*cmd)
            await proc.communicate()

            if proc.returncode != 0:
                raise RuntimeError(f"TTS 脚本失败: {proc.returncode}")
        finally:
            if os.path.exists(text_file):
                os.unlink(text_file)

        logger.info(f"TTS 脚本合成完成: {output_path}")
        return output_path


tts_service = TTSService()
