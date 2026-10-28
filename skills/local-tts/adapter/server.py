#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
local-tts adapter v2 —— 多后端版。把本地 TTS 统一成 OpenAI 形状的
POST /v1/audio/speech，按 voice 名路由到不同上游，**输出一律真 mp3**。

后端（profiles.json 里每个 voice 指定走哪个）：
  gsv    -> GPT-SoVITS api_v2.py 的 POST /tts（JSON 参数式，返回 wav）
  breeze -> Breeze TTS 2 的 POST /v1/audio/speech（multipart 表单，返回 24kHz s16le PCM）

零第三方依赖（标准库）。mp3 编码：lameenc 优先，否则 ffmpeg **文件模式**（不碰管道）。

    python adapter/server.py --gsv http://127.0.0.1:9880 --breeze http://127.0.0.1:7860 --port 9881
    curl http://127.0.0.1:9881/health
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

VERSION = "2.2.0"
DEFAULT_GSV = "http://127.0.0.1:9880"
DEFAULT_BREEZE = "http://127.0.0.1:7860"
DEFAULT_INDEX = "http://127.0.0.1:9890"
DEFAULT_PORT = 9881
DEFAULT_BITRATE_KBPS = 48
MAX_BODY = 256 * 1024
MAX_TEXT = 2000
BREEZE_PCM_RATE = 24000

FFMPEG_CANDIDATES = [
    r"F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe",
    r"F:\qqbot\tools\ffmpeg\bin\ffmpeg.exe",
    r"C:\ffmpeg\bin\ffmpeg.exe",
]

# ──────── 统一口径：model → 后端（2026-10-26）────────
# 以前适配层**根本不看 model**，只按 voice 名推断后端，而 voice-config.json 里
# 写的是 gpt-sovits / 面板写的是 gsv —— 于是浮窗里"切语音模型"改了文件却什么
# 都没变（消费者以为切了，适配层照旧走老后端）。现在口径唯一：model 取值
# edge|gsv|breeze|index，非空时以它为准，空时才回落到 voice 自带的 backend。
# 旧写法（gpt-sovits / indextts / breeze-tts2 ...）作为别名继续认。
# edge 是在线 edge-tts，由插件/tts-core 直连，不经本进程 —— 传进来就明确报错，
# 免得静默回落到本地后端让人以为"切到在线了"。
MODEL_ALIASES = {
    "edge": "edge", "edge-tts": "edge", "edgetts": "edge", "microsoft-edge": "edge",
    "online": "edge",
    "gsv": "gsv", "gpt-sovits": "gsv", "gpt_sovits": "gsv", "gptsovits": "gsv",
    "sovits": "gsv", "gpt-sovits-local": "gsv",
    "breeze": "breeze", "breeze-tts2": "breeze", "breeze-tts-2": "breeze",
    "breeze_tts2": "breeze", "breezetts2": "breeze",
    "index": "index", "indextts": "index", "index-tts": "index", "indextts2": "index",
    "index-tts2": "index", "index-tts-2.5": "index", "indextts-2.5": "index",
}
MODEL_CANONICAL = ("edge", "gsv", "breeze", "index")

# 进程管理：{仓库根}/dshqqbot/.qqbot/tts/adapter.pid（浮窗「停止」靠它认人）
PID_FILE_ENV = "TTS_PID_FILE"


class ModelError(Exception):
    """model 字段不认识 / 是适配层管不了的档（比如 edge）。"""


def normalize_model(model: Any) -> str:
    m = str(model or "").strip().lower()
    if not m:
        return ""
    return MODEL_ALIASES.get(m, m)


def log(msg: str) -> None:
    print(f"[adapter {time.strftime('%H:%M:%S')}] {msg}", flush=True)
    # WMI/服务方式拉起时 stdout 会丢，落一份文件才能排障
    f = os.environ.get("TTS_ADAPTER_LOG")
    if f:
        try:
            with open(f, "a", encoding="utf-8", errors="replace") as fh:
                fh.write(f"[adapter {time.strftime('%m-%d %H:%M:%S')}] {msg}\n")
        except OSError:
            pass


# ─────────────────────────── 编码 / 容器 ───────────────────────────
def find_ffmpeg() -> Optional[str]:
    env = os.environ.get("TTS_FFMPEG")
    if env and os.path.isfile(env):
        return env
    try:
        import imageio_ffmpeg  # type: ignore

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:  # noqa: BLE001
        pass
    for p in FFMPEG_CANDIDATES:
        if os.path.isfile(p):
            return p
    which = shutil.which("ffmpeg")
    if which:
        return which
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for base, _d, files in os.walk(root):
        for f in files:
            if f.lower() in ("ffmpeg.exe", "ffmpeg"):
                return os.path.join(base, f)
    return None


def wav_info(wav_bytes: bytes) -> Tuple[int, int, int, int]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()


def pcm16_to_wav(pcm: bytes, rate: int = BREEZE_PCM_RATE, channels: int = 1) -> bytes:
    """裸 s16le PCM → 标准 wav 容器（Breeze 的流式接口就吐这个）。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def encode_mp3(wav_bytes: bytes, bitrate_kbps: int = DEFAULT_BITRATE_KBPS) -> Tuple[bytes, str]:
    try:
        import lameenc  # type: ignore

        rate, ch, sampwidth, _n = wav_info(wav_bytes)
        if sampwidth != 2:
            raise ValueError("lameenc 只吃 16bit PCM")
        with wave.open(io.BytesIO(wav_bytes), "rb") as w:
            pcm = w.readframes(w.getnframes())
        enc = lameenc.Encoder()
        try:
            enc.set_bit_rate(int(bitrate_kbps))     # lameenc 1.x 的方法名
        except AttributeError:
            enc.set_bitrate(int(bitrate_kbps))      # 老写法兜底
        enc.set_in_sample_rate(int(rate))
        enc.set_channels(int(ch))
        enc.set_quality(2)
        data = enc.encode(pcm) + enc.flush()
        if data and len(data) > 200:
            return data, "lameenc"
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        log(f"lameenc 失败({e})，改用 ffmpeg")

    exe = find_ffmpeg()
    if not exe:
        raise RuntimeError("没有可用 mp3 编码器：pip install lameenc 或设 TTS_FFMPEG 指向 ffmpeg.exe")
    tmpdir = tempfile.mkdtemp(prefix="tts-enc-")
    src, dst = os.path.join(tmpdir, "in.wav"), os.path.join(tmpdir, "out.mp3")
    try:
        with open(src, "wb") as f:
            f.write(wav_bytes)
        cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-i", src,
               "-codec:a", "libmp3lame", "-b:a", f"{int(bitrate_kbps)}k",
               "-ar", "24000", "-ac", "1", dst]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             timeout=120, check=False)
        if res.returncode != 0 or not os.path.isfile(dst):
            raise RuntimeError(f"ffmpeg 转码失败 rc={res.returncode}")
        with open(dst, "rb") as f:
            data = f.read()
        if len(data) < 200:
            raise RuntimeError("ffmpeg 产出的 mp3 过小")
        return data, "ffmpeg"
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ─────────────────────────── 参数：speed / pitch / temperature ───────────────────────────
def _fnum(v: Any, default: float) -> float:
    try:
        f = float(v)  # type: ignore[arg-type]
        return f if f == f and abs(f) != float("inf") else default   # NaN/inf 兜底
    except (TypeError, ValueError):
        return default


def resolve_params(prof: Dict[str, Any], speed: float = 1.0,
                   pitch_semitones: Optional[float] = None) -> Dict[str, Any]:
    """profile 自带参数 × 请求参数 → 本次真正用的 speed / pitch / temperature。

    口径（写进 SKILL.md，别改来改去）：
      · speed：profile.speed 是这个音色的**基准语速**（1.0 正常），请求里的 speed
        是插件的**全局倍率**（voice-config.json 的 1.08 这种），两者相乘、夹在
        0.5~2.0。这样调全局语速不会把音色自带的快慢抹平。
      · pitch：profile.pitch 单位是**半音**（±3 是正常范围，女声"更幼"约 +3~+5），
        用 ffmpeg 真搬音高（asetrate + atempo 补时长）。请求体里给的是 edge 档的
        Hz 偏移，语义不同，本地档只认 pitch_semitones。
      · temperature：只对 gsv（GPT-SoVITS api_v2 支持）和 breeze 有效，别的后端
        忽略并在响应头里如实回显 null。
    """
    base = _fnum(prof.get("speed"), 1.0) or 1.0
    req = _fnum(speed, 1.0) or 1.0
    eff = min(max(base * req, 0.5), 2.0)
    semis = _fnum(prof.get("pitch"), 0.0)
    if pitch_semitones is not None:
        semis += _fnum(pitch_semitones, 0.0)
    temp: Optional[float] = None
    if prof.get("temperature") is not None:
        temp = _fnum(prof.get("temperature"), 0.0) or None
    return {"speed": round(eff, 3), "base_speed": round(base, 3),
            "pitch": round(semis, 2), "temperature": temp}


def _ffmpeg_af(audio: bytes, kind: str, chain: str, tag: str) -> Tuple[bytes, str]:
    """跑一条 ffmpeg 音频滤镜链，返回 wav。

    ffmpeg **文件模式**（沙箱里不能管道抓 stdio）。统一 aresample 到 44.1k 再处理，
    免得 32k 的参考音被按 44.1k 套公式（那样 +4 半音会变成 +10）。
    """
    exe = find_ffmpeg()
    if not exe:
        raise RuntimeError(f"要做 {tag} 但没找到 ffmpeg（设 TTS_FFMPEG 指过去）")
    tmpdir = tempfile.mkdtemp(prefix="tts-af-")
    src = os.path.join(tmpdir, "in" + (".wav" if kind == "wav" else ".mp3"))
    dst = os.path.join(tmpdir, "out.wav")
    try:
        with open(src, "wb") as f:
            f.write(audio)
        cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-i", src,
               "-af", chain, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", dst]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             timeout=180, check=False)
        if res.returncode != 0 or not os.path.isfile(dst):
            raise RuntimeError(f"ffmpeg {tag} 失败 rc={res.returncode}")
        with open(dst, "rb") as f:
            return f.read(), "wav"
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def shift_pitch(audio: bytes, kind: str, semitones: float) -> Tuple[bytes, str]:
    """音高搬移 N 个半音：asetrate 改采样率（变速又变调）→ aresample 回来 → atempo 补时长。"""
    if abs(semitones) < 0.25:
        return audio, kind
    ratio = 2.0 ** (semitones / 12.0)
    chain = f"aresample=44100,asetrate={int(round(44100 * ratio))},aresample=44100"
    tempo = 1.0 / ratio
    if 0.5 <= tempo <= 2.0 and abs(tempo - 1.0) > 1e-4:   # atempo 只吃 0.5~2.0
        chain += f",atempo={tempo:.6f}"
    return _ffmpeg_af(audio, kind, chain, f"变调 {semitones:+.2f} 半音")


def change_tempo(audio: bytes, kind: str, speed: float) -> Tuple[bytes, str]:
    """纯变速不变调（给不支持 speed 参数的后端兜底）。"""
    if abs(speed - 1.0) < 0.01:
        return audio, kind
    chain = "aresample=44100"
    x = float(speed)
    while x > 2.0:            # atempo 上限 2.0，串两级
        chain += ",atempo=2.0"
        x /= 2.0
    while x < 0.5:
        chain += ",atempo=0.5"
        x /= 0.5
    chain += f",atempo={x:.6f}"
    return _ffmpeg_af(audio, kind, chain, f"变速 {speed:.3f}×")



# ─────────────────────────── profiles ───────────────────────────
def expand_custom_voices(voices: Dict[str, Any], custom: Dict[str, Any]) -> Dict[str, Any]:
    """profiles.json 的 custom 段：派生音色 = 别的音色 + 参数覆盖。

    以前想给某个音色换语速/音高，只能把整段参考音+参考文本复制一份，改一个数字，
    于是 profiles.json 里全是近似重复的块。现在写成：

        "custom": {
          "xiaolan_fast":  {"base": "xiaolan", "speed": 1.15, "temperature": 0.6},
          "xiaolan_cute5": {"base": "xiaolan_cute", "pitch": 5}
        }

    支持覆盖任意 profile 字段（speed / pitch / temperature / cfg_scale ...），
    也照旧可以写 "backend" 显式指定后端。base 不存在就跳过并记日志（不炸整个配置）。
    """
    out = dict(voices)
    for name, spec in (custom or {}).items():
        if name.startswith("_") or not isinstance(spec, dict):
            continue
        spec = dict(spec)
        base = str(spec.pop("base", "") or spec.pop("_base", "") or "")
        if not base or base not in voices:
            log(f"profiles: custom {name!r} 的 base {base!r} 不存在，跳过")
            continue
        merged = dict(voices[base])
        merged.update(spec)
        merged["_base"] = base
        out[name] = merged
    return out


def engine_default_voice(voices: Dict[str, Any], engines: Dict[str, Any],
                         backend: str, fallback: str) -> str:
    """某个后端该用的默认音色：先看 profiles.json 的 engines 段，再按 backend 字段扫。"""
    spec = engines.get(backend) or {}
    v = str(spec.get("default_voice") or "")
    if v and v in voices and (voices[v].get("backend") or "") == backend:
        return v
    for name, prof in voices.items():
        if (prof.get("backend") or "") == backend:
            return name
    return fallback


def load_profiles(path: Optional[str]) -> Dict[str, Any]:
    cfg: Dict[str, Any] = {"default": "default", "default_backend": "gsv", "voices": {
        "default": {"backend": "gsv", "ref_audio_path": "", "prompt_text": "",
                    "prompt_lang": "zh", "text_lang": "zh"}}, "engines": {}}
    if path and os.path.isfile(path):
        with open(path, "r", encoding="utf-8-sig") as f:
            raw = json.load(f)
        voices = {k: v for k, v in (raw.get("voices") or {}).items() if not k.startswith("_")}
        custom = {k: v for k, v in (raw.get("custom") or {}).items() if not k.startswith("_")}
        voices = expand_custom_voices(voices, custom)
        if voices:
            default_backend = raw.get("default_backend") or "gsv"
            cfg = {"default": raw.get("default") or next(iter(voices)),
                   "default_backend": default_backend,
                   "voices": voices,
                   "engines": {k: v for k, v in (raw.get("engines") or {}).items()
                               if not k.startswith("_")}}
            for be in ("gsv", "breeze", "index"):
                cfg["engines"].setdefault(be, {})
                cfg["engines"][be]["default_voice"] = engine_default_voice(
                    voices, cfg["engines"], be, cfg["default"])
    return cfg



class ProfilesStore:
    """profiles.json 热重载（2026-10-26）。

    原来 load_profiles() 只在 main() 启动时读一次，改 profiles.json / 加音色必须重启
    适配层才生效 —— 而重启会掐断正在合成的那条请求，还会把 GSV 的暖机状态丢掉
    （冷启动 10~40s），所以"换音色"变成了"要么不生效，要么等半分钟"。
    这里改成每次取用前 stat 一次 mtime：命中缓存不到 1ms，文件一动下次请求就是新配置。
    """

    def __init__(self, path: Optional[str], backend_override: str = "") -> None:
        self.path = path or ""
        self._lock = threading.Lock()
        self._override = backend_override or ""
        self._mtime = self._stat_mtime()
        self._cfg: Dict[str, Any] = self._load()
        self.reloads = 0

    def _stat_mtime(self) -> float:
        try:
            return os.stat(self.path).st_mtime if self.path else -1.0
        except OSError:
            return -1.0

    def _load(self) -> Dict[str, Any]:
        cfg = load_profiles(self.path)
        if self._override:
            cfg["default_backend"] = self._override
        return cfg

    @property
    def cfg(self) -> Dict[str, Any]:
        m = self._stat_mtime()
        if m != self._mtime:
            with self._lock:
                m = self._stat_mtime()
                if m != self._mtime:
                    try:
                        self._cfg = self._load()
                        self._mtime = m
                        self.reloads += 1
                        log("profiles: 检测到变更，已热重载 "
                            + json.dumps(sorted(self._cfg["voices"].keys()), ensure_ascii=False))
                    except Exception as e:  # noqa: BLE001
                        # 写坏了不能让语音整条挂掉：继续用上一份好配置
                        log(f"profiles: 重载失败（继续用旧配置）{e!r}")
                        self._mtime = m
        return self._cfg

    def force_reload(self) -> Dict[str, Any]:
        """POST /admin/reload 用：不管 mtime 变没变，强制重读。

        有些编辑器"先删后写"会让 mtime 看起来没变（或者改完又改回同一时间戳），
        这时候只靠 mtime 就漏了 —— 给一个能手动捶一下的接口。
        """
        with self._lock:
            self._cfg = self._load()
            self._mtime = self._stat_mtime()
            self.reloads += 1
        log("profiles: /admin/reload 强制重载 "
            + json.dumps(sorted(self._cfg["voices"].keys()), ensure_ascii=False))
        return self.info()

    def info(self) -> Dict[str, Any]:
        cfg = self.cfg
        return {"path": self.path, "mtime": self._mtime, "reloads": self.reloads,
                "version": self.reloads,            # 等价别名，浮窗显示"配置第几版"
                "voices": sorted(cfg["voices"].keys()),
                "custom": sorted(k for k, v in cfg["voices"].items() if v.get("_base")),
                "engines": cfg.get("engines") or {}}


def pick_profile(cfg: Dict[str, Any], voice: str) -> Tuple[str, Dict[str, Any]]:
    voices = cfg["voices"]
    if voice and voice in voices:
        return voice, voices[voice]
    for name in voices:
        if voice and voice.lower() in name.lower():
            return name, voices[name]
    d = cfg["default"]
    if d in voices:
        return d, voices[d]
    name = next(iter(voices))
    return name, voices[name]


# ─────────────────────────── HTTP 客户端 ───────────────────────────
class UpstreamError(Exception):
    def __init__(self, status: int, body: bytes, ctype: str, backend: str) -> None:
        self.status, self.body, self.ctype, self.backend = status, body, ctype, backend
        super().__init__(f"{backend} {status}")


def _open(req: urllib.request.Request, timeout: float) -> Tuple[int, bytes, str]:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), (e.headers.get("Content-Type", "") if e.headers else "")
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"连不上 {req.full_url}: {e}") from e


def http_get_json(url: str, timeout: float = 5.0) -> Tuple[int, Any]:
    req = urllib.request.Request(url, method="GET")
    st, body, _c = _open(req, timeout)
    try:
        return st, json.loads(body.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return st, body[:300]


def http_post_json(url: str, payload: Dict[str, Any], timeout: float) -> Tuple[int, bytes, str]:
    req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                method="POST", headers={"Content-Type": "application/json"})
    return _open(req, timeout)


def build_multipart(fields: Dict[str, Any],
                    files: Dict[str, Tuple[str, bytes, str]]) -> Tuple[bytes, str]:
    """手搓 multipart/form-data（标准库没有现成的）。files: name -> (filename, bytes, ctype)"""
    boundary = "----localtts" + uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        if v is None or v == "":
            continue
        out.write(f"--{boundary}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        out.write(str(v).encode("utf-8"))
        out.write(b"\r\n")
    for k, (fn, data, ctype) in files.items():
        out.write(f"--{boundary}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{k}"; filename="{fn}"\r\n'.encode())
        out.write(f"Content-Type: {ctype}\r\n\r\n".encode())
        out.write(data)
        out.write(b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def probe(base: str, timeout: float = 0.6) -> bool:
    u = urllib.parse.urlparse(base)
    try:
        with socket.create_connection((u.hostname or "127.0.0.1", u.port or 80), timeout=timeout):
            return True
    except OSError:
        return False


# ─────────────────────────── 后端 ───────────────────────────
class GsvBackend:
    name = "gsv"
    supports_speed = True          # api_v2 原生 speed_factor

    def __init__(self, base: str, timeout: float) -> None:
        self.base, self.timeout = base, timeout

    def health(self) -> Dict[str, Any]:
        return {"base": self.base, "reachable": probe(self.base)}

    def synth(self, text: str, prof: Dict[str, Any], speed: float) -> Tuple[bytes, str]:
        payload = {
            "text": text,
            "text_lang": prof.get("text_lang", "zh"),
            "ref_audio_path": prof.get("ref_audio_path") or prof.get("ref_audio", ""),
            "prompt_text": prof.get("prompt_text", ""),
            "prompt_lang": prof.get("prompt_lang", "zh"),
            "text_split_method": prof.get("text_split_method", "cut5"),
            "media_type": "wav",
            "speed_factor": float(speed),
            "streaming_mode": False,
            "batch_size": 1,
            "parallel_infer": True,
            "use_cuda_graph": True,
        }
        # 采样参数：api_v2 认 top_k / top_p / temperature / repetition_penalty，
        # 写在 profile 里（或用 custom 派生）就能逐音色调，不写就用它自己的默认。
        for k in ("top_k", "top_p", "temperature", "repetition_penalty"):
            if prof.get(k) is not None:
                try:
                    payload[k] = float(prof[k])
                except (TypeError, ValueError):
                    pass
        st, body, ctype = http_post_json(self.base.rstrip("/") + "/tts", payload, self.timeout)

        if st != 200:
            raise UpstreamError(st, body, ctype, self.name)
        if not (body[:4] == b"RIFF" and body[8:12] == b"WAVE"):
            raise UpstreamError(502, b'{"message":"gsv did not return wav"}',
                                "application/json", self.name)
        return body, "wav"


class BreezeBackend:
    """breeze-server（HoppouAI/Breeze-TTS-2.cpp）三条路：

    · 给了 voice_id（或能注册出来）→ **OpenAI JSON** 形状，response_format=mp3，
      服务端 shine 直接给 mp3，不用本地转码，还省掉每次 650ms 的参考音编码。
    · 只给了 ref_audio → 先 POST /v1/voices 注册成 cached voice，再走 JSON mp3。
    · 都没有 → 原生 multipart + instruction（voice design），返回裸 24k s16le PCM。
    """
    name = "breeze"
    supports_speed = False         # 原生不吃 speed；适配层用 ffmpeg atempo 补

    def __init__(self, base: str, timeout: float, pcm_rate: int = BREEZE_PCM_RATE) -> None:
        self.base, self.timeout, self.pcm_rate = base, timeout, pcm_rate
        self._voice_ids: Dict[str, str] = {}

    def health(self) -> Dict[str, Any]:
        up = probe(self.base)
        info: Any = None
        if up:
            try:
                st, info = http_get_json(self.base.rstrip("/") + "/health", timeout=10)
                if st != 200:
                    info = f"HTTP {st}"
            except Exception as e:  # noqa: BLE001
                info = f"probe failed: {e}"
        return {"base": self.base, "reachable": up, "health": info}

    def _register_voice(self, ref_path: str, ref_text: str, name: str) -> Optional[str]:
        key = f"{ref_path}|{ref_text}"
        if key in self._voice_ids:
            return self._voice_ids[key]
        with open(ref_path, "rb") as f:
            ref = f.read()
        body, ctype = build_multipart(
            {"ref_text": ref_text, "name": name, "description": "local-tts 克隆音色"},
            {"ref_audio": (os.path.basename(ref_path), ref, "audio/wav")},
        )
        req = urllib.request.Request(self.base.rstrip("/") + "/v1/voices", data=body,
                                     method="POST", headers={"Content-Type": ctype})
        st, data, rctype = _open(req, self.timeout)
        if st != 200:
            raise UpstreamError(st, data, rctype, self.name)
        vid = ""
        try:
            vid = str(json.loads(data.decode("utf-8")).get("id") or name)
        except Exception:  # noqa: BLE001
            vid = name
        log(f"breeze: 注册音色 {vid}（{os.path.basename(ref_path)}）")
        self._voice_ids[key] = vid
        return vid

    def _json_speech(self, text: str, prof: Dict[str, Any], fmt: str) -> Tuple[bytes, str]:
        payload: Dict[str, Any] = {
            "model": "tts-1",
            "input": text,
            "response_format": fmt,           # mp3 / wav / pcm（服务端 shine 编码）
            "seed": prof.get("seed", 42),
        }
        if prof.get("cfg_scale") is not None:
            payload["cfg_scale"] = float(prof.get("cfg_scale", 1.0))
        instr = prof.get("instruction") or ""
        if instr:
            payload["instructions"] = instr
        req = urllib.request.Request(
            self.base.rstrip("/") + "/v1/audio/speech",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json", "Accept": "audio/*"},
        )
        st, data, ctype = _open(req, self.timeout)
        if st != 200:
            raise UpstreamError(st, data, ctype, self.name)
        got = "mp3" if data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2") or data[:3] == b"ID3" \
            else ("wav" if data[:4] == b"RIFF" else fmt)
        return data, got

    def synth(self, text: str, prof: Dict[str, Any], speed: float,
              want: str = "mp3") -> Tuple[bytes, str]:
        voice_id = str(prof.get("voice_id") or "")
        ref_path = prof.get("ref_audio_path") or prof.get("ref_audio") or ""
        ref_text = prof.get("prompt_text") or ""
        if not voice_id and ref_path and os.path.isfile(ref_path):
            voice_id = self._register_voice(ref_path, ref_text,
                                            str(prof.get("voice_name") or "localtts")) or ""
        if voice_id:
            prof = dict(prof, voice_id=voice_id)
            payload = {"model": "tts-1", "input": text, "voice": voice_id,
                       "response_format": "mp3", "seed": prof.get("seed", 42)}
            if prof.get("instruction"):
                payload["instructions"] = prof["instruction"]
            req = urllib.request.Request(
                self.base.rstrip("/") + "/v1/audio/speech",
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                method="POST", headers={"Content-Type": "application/json"})
            st, data, ctype = _open(req, self.timeout)
            if st != 200:
                raise UpstreamError(st, data, ctype, self.name)
            if data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2") or data[:3] == b"ID3":
                return data, "mp3"
            if data[:4] == b"RIFF":
                return data, "wav"
            return pcm16_to_wav(data, self.pcm_rate), "wav"      # 兜底：当 PCM 处理

        # voice design：原生 multipart，返回裸 PCM
        fields: Dict[str, Any] = {
            "text": text,
            "instruction": prof.get("instruction") or "Speak clearly and naturally.",
            "cfg_scale": prof.get("cfg_scale", 1.0),
            "seed": prof.get("seed", 42),
        }
        body, ctype = build_multipart(fields, {})
        req = urllib.request.Request(self.base.rstrip("/") + "/v1/audio/speech", data=body,
                                     method="POST",
                                     headers={"Content-Type": ctype, "Accept": "audio/pcm"})
        st, data, rctype = _open(req, self.timeout)
        if st != 200:
            raise UpstreamError(st, data, rctype, self.name)
        if data[:4] == b"RIFF":
            return data, "wav"
        if len(data) < 4800:
            raise UpstreamError(502, b'{"message":"breeze pcm too short"}',
                                "application/json", self.name)
        return pcm16_to_wav(data, self.pcm_rate), "wav"


# ─────────────────────────── 管家：按需启停后端 ───────────────────────────
# ──────── 子进程：一律不用 PIPE ────────
# 2026-10-26 踩坑：DSH/Win 沙箱里 python `subprocess.run(..., capture_output=True)`
# 会因为打不开匿名管道而 EPERM / WinError 5，**而且是静默的** —— taskkill 看起来
# 执行了、日志还写"已停止"，进程其实活得好好的。这就是"python 服务关不掉"的一个隐形原因。
# 所以：要输出的落临时文件再读回来；不要输出的直接 DEVNULL（NUL 能开）。
def run_capture(cmd: List[str], timeout: float = 10.0) -> str:
    fd, path = tempfile.mkstemp(prefix="tts-run-", suffix=".txt")
    os.close(fd)
    try:
        with open(path, "wb") as f:
            subprocess.run(cmd, stdout=f, stderr=subprocess.DEVNULL, timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                           check=False)
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return ""
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def run_quiet(cmd: List[str], timeout: float = 15.0) -> int:
    """跑一条命令，丢掉所有输出，返回退出码（-1 = 起不来/超时）。"""
    try:
        return subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=timeout, check=False,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
                              ).returncode
    except Exception:  # noqa: BLE001
        return -1


class SupervisorError(Exception):

    """后端没能就绪（显存不足/启动失败）。消息直接给插件/用户看。"""


# 各后端启动所需的最小空闲显存（MB）：不到就不起，免得跟游戏抢到 OOM
# index（IndexTTS-2.5 bf16）跑起来要 ≈5GB+（CUDA context 另算）：门槛给 5300
# —— 2026-10-27 修：原来写 4600，结果"起得来、一合成就 OOM 断连"，
#    还把 GSV 要的显存堵死（free 4838→1190），全链路一起死。门槛必须给足。
DEFAULT_NEED_MB = {"gsv": 3400, "breeze": 4800, "index": 5300}
DEFAULT_WAIT_S = {"gsv": 150, "breeze": 240, "index": 420}


class Supervisor:
    """TTS 后端生命周期管家：懒启动 + 空闲自动关闭 + 显存预检。

    设计约束：适配层是常驻的（纯标准库、几 MB 内存、零显存），插件永远只指 9881；
    重的是 GSV / breeze-server，谁被用到才起谁，闲下来自动杀，把 6GB 显存还给游戏。
    """

    def __init__(self, root: str, log_dir: str, idle_minutes: float = 10.0,
                 min_free_mb: int = 0, need_mb: Optional[Dict[str, int]] = None,
                 wait_s: Optional[Dict[str, float]] = None, enabled: bool = True) -> None:
        self.root = root
        self.log_dir = log_dir
        self.ckpt_dir = os.path.join(root, ".models", "index-tts")   # IndexTTS 权重目录
        self.idle_minutes = max(0.0, float(idle_minutes))
        self.min_free_mb = int(min_free_mb)          # 全局门槛，0 = 用 DEFAULT_NEED_MB
        self.need_mb = need_mb or {}
        self.wait_s = wait_s or {}
        self.enabled = bool(enabled)                 # False = 老行为，只代理不管理
        self._locks = {"gsv": threading.Lock(), "breeze": threading.Lock(), "index": threading.Lock()}
        self._last_use = {"gsv": 0.0, "breeze": 0.0, "index": 0.0}
        self._inflight = {"gsv": 0, "breeze": 0, "index": 0}
        self._starting = {"gsv": 0.0, "breeze": 0.0, "index": 0.0}   # 起始时间戳（算冷启动耗时）
        self._spawning = {"gsv": False, "breeze": False, "index": False}  # 正在拉起中（回収线程别碰）
        self._popen: Dict[str, subprocess.Popen] = {}
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ── 对外 ──
    def touch(self, name: str) -> None:
        self._last_use[name] = time.time()

    def enter(self, name: str) -> None:
        self._inflight[name] = self._inflight.get(name, 0) + 1
        self.touch(name)

    def leave(self, name: str) -> None:
        self._inflight[name] = max(0, self._inflight.get(name, 0) - 1)
        self.touch(name)

    def ensure(self, name: str, base: str) -> Optional[str]:
        """确保后端在跑。返回 None = 就绪；返回字符串 = 给用户看的失败原因。"""
        if not self.enabled:
            return None
        if probe(base):
            self.touch(name)
            return None
        lock = self._locks.get(name)
        if lock is None:
            return None
        with lock:
            if probe(base):                    # 双检：别的线程刚拉起来了
                self.touch(name)
                return None
            self._starting[name] = time.time()
            self._spawning[name] = True
            log(f"supervisor: {name} 不在线，尝试拉起…")
            free = self.vram_free_mb()
            need = self.need_mb.get(name) or self.min_free_mb or DEFAULT_NEED_MB.get(name, 0)
            if need and free is not None and free < need:
                msg = (f"本地 TTS（{name}）没有启动：显存只剩 {free}MB，不够它要的 {need}MB。"
                       f"可能游戏/大模型正占着卡——要语音就先腾显存，或等我空闲时再试。")
                log(f"supervisor: 拒绝启动 {name}（free={free}MB < need={need}MB）")
                return msg
            try:
                self._spawn(name)
            except Exception as e:  # noqa: BLE001
                return f"本地 TTS（{name}）启动失败：{e}"
            wait = float(self.wait_s.get(name) or DEFAULT_WAIT_S.get(name, 120))
            try:
                if not self._wait_up(base, wait):
                    # 起失败了别留半死进程占着显存
                    self._kill(name, reason="启动超时，清理半死进程")
                    return (f"本地 TTS（{name}）启动超时（>{int(wait)}s），已放弃。"
                            f"看日志 {self.log_dir}\\tts-{name}.err")
            finally:
                self._spawning[name] = False
            took = time.time() - self._starting[name]
            log(f"supervisor: {name} 就绪（冷启动 {took:.0f}s，free={self.vram_free_mb()}MB）")
            self.touch(name)
            return None

    def status(self) -> Dict[str, Any]:
        now = time.time()
        out: Dict[str, Any] = {"enabled": self.enabled, "idle_minutes": self.idle_minutes,
                               "vram_free_mb": self.vram_free_mb()}
        for name in ("gsv", "breeze", "index"):
            last = self._last_use.get(name, 0.0)
            out[name] = {"running": self._popen.get(name) is not None and self._popen[name].poll() is None,
                         "inflight": self._inflight.get(name, 0),
                         "idle_sec": int(now - last) if last else None}
        return out

    def start_reaper(self) -> None:
        if not self.enabled or self.idle_minutes <= 0:
            return
        self._thread = threading.Thread(target=self._reaper_loop, daemon=True,
                                        name="tts-idle-reaper")
        self._thread.start()

    def shutdown(self) -> None:
        self._stop.set()

    # ── 内部 ──
    @staticmethod
    def vram_free_mb() -> Optional[int]:
        out = run_capture(["nvidia-smi", "--query-gpu=memory.free",
                           "--format=csv,noheader,nounits"], timeout=8)
        for line in out.splitlines():
            line = line.strip()
            if line.isdigit():
                return int(line)
        return None                      # 查不到就别拦（比如纯 CPU 机器）

    @staticmethod
    def _backend_env(root: str) -> Dict[str, str]:
        """给后端进程构造显式环境。适配层自身可能被 WMI/服务方式拉起，继承的环境
        是精简的（缺 conda PATH / 用户目录），GSV 的 conda python 没有这些会静默崩。"""
        env = dict(os.environ)
        extra = [
            r"E:\Anaconda",
            r"E:\Anaconda\Library\mingw-w64\bin",
            r"E:\Anaconda\Library\usr\bin",
            r"E:\Anaconda\Library\bin",
            r"E:\Anaconda\Scripts",
            os.path.join(root, ".models", "gpt-sovits", ".venv", "Scripts"),
        ]
        env["PATH"] = ";".join(extra) + ";" + str(env.get("PATH", ""))
        user = env.get("USERPROFILE") or r"C:\Users\Administrator"
        for k, v in (("USERPROFILE", user), ("HOMEDRIVE", "C:"),
                     ("HOMEPATH", "\\Users\\Administrator"),
                     ("APPDATA", os.path.join(user, "AppData", "Roaming")),
                     ("LOCALAPPDATA", os.path.join(user, "AppData", "Local")),
                     ("SYSTEMROOT", r"C:\Windows"), ("SYSTEMDRIVE", "C:")):
            env.setdefault(k, v)
        tmp = os.path.join(root, "tmp")
        if os.path.isdir(tmp):
            env.setdefault("TEMP", tmp)
            env.setdefault("TMP", tmp)
        hf = os.path.join(root, ".models", "hf-cache")
        if os.path.isdir(hf):
            env.setdefault("HF_HOME", hf)
        # 关键：不设这个，重定向到文件时 stdout 全缓冲，日志永远空、排不了障
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        return env

    def _spawn(self, name: str) -> None:
        os.makedirs(self.log_dir, exist_ok=True)
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        env = self._backend_env(self.root)
        out = open(os.path.join(self.log_dir, f"tts-{name}.log"), "ab")
        err = open(os.path.join(self.log_dir, f"tts-{name}.err"), "ab")
        if name == "gsv":
            py = os.path.join(self.root, ".models", "gpt-sovits", ".venv", "Scripts", "python.exe")
            if not os.path.isfile(py):
                py = sys.executable
            cwd = os.path.join(self.root, ".models", "gpt-sovits", "GPT-SoVITS-main")
            if not os.path.isdir(cwd):
                raise RuntimeError(f"没找到 GPT-SoVITS（{cwd}）")
            self._popen[name] = subprocess.Popen(
                [py, "api_v2.py", "-a", "127.0.0.1", "-p", "9880",
                 "-c", "GPT_SoVITS/configs/tts_infer.yaml"],
                cwd=cwd, env=env, stdout=out, stderr=err, creationflags=flags)
        elif name == "breeze":
            exe_dir = os.path.join(self.root, ".models", "breeze-tts2")
            hits = sorted(glob.glob(os.path.join(exe_dir, "*", "breeze-server.exe")))
            if not hits:
                raise RuntimeError(f"没找到 breeze-server.exe（{exe_dir}）")
            exe = hits[-1]               # 版本目录排序取最新
            model = os.path.join(exe_dir, "breeze-tts-2-q8_0.gguf")
            if not os.path.isfile(model):
                gg = sorted(glob.glob(os.path.join(exe_dir, "*.gguf")))
                if not gg:
                    raise RuntimeError(f"没找到 breeze 模型 gguf（{exe_dir}）")
                model = gg[-1]
            self._popen[name] = subprocess.Popen(
                [exe, model, "--host", "127.0.0.1", "--port", "7860",
                 "--voices-dir", os.path.join(self.root, "voices")],
                cwd=os.path.dirname(exe), env=env, stdout=out, stderr=err, creationflags=flags)
        elif name == "index":
            vpy = os.path.join(self.root, ".models", "index-tts-code", ".venv", "Scripts", "python.exe")
            if not os.path.isfile(vpy):
                raise RuntimeError(f"没找到 IndexTTS 的 uv 环境（{vpy}）——先 uv sync")
            srv = os.path.join(self.root, "skills", "local-tts", "adapter", "indextts_server.py")
            if not os.path.isdir(self.ckpt_dir):
                raise RuntimeError(f"没找到 IndexTTS 权重（{self.ckpt_dir}）")
            self._popen[name] = subprocess.Popen(
                [vpy, srv, "--port", "9890", "--ckpt", self.ckpt_dir],
                cwd=os.path.dirname(srv), env=env, stdout=out, stderr=err, creationflags=flags)
        else:
            raise RuntimeError(f"未知后端 {name}")
        self.touch(name)                     # spawn 即视为在用，防回收线程误杀新生儿
        log(f"supervisor: 已 spawn {name} pid={self._popen[name].pid}")
        return

    @staticmethod
    def _wait_up(base: str, seconds: float) -> bool:
        deadline = time.time() + seconds
        while time.time() < deadline:
            if probe(base, timeout=0.8):
                return True
            time.sleep(1.5)
        return False

    def _kill(self, name: str, reason: str = "", only_own: bool = False) -> None:
        """停掉某个后端。

        only_own=True 时只停**本进程 spawn 的**那个 —— 适配层以 --no-manage 手动模式
        退出时不该顺手把用户自己在别处起的 GSV 杀掉（端口探测会误伤同端口的常驻服务）。
        """
        ports = {"gsv": 9880, "breeze": 7860, "index": 9890}
        port = ports.get(name)
        p = self._popen.pop(name, None)
        pids: set = set()
        if p is not None:
            if p.poll() is None:
                pids.add(str(p.pid))
        if port and not only_own:
            pids |= self._pids_listening(port)     # 兜底：端口上谁都算
        if not pids:
            if p is not None:
                log(f"supervisor: {name} 本来就没在跑 {reason}")
            self._last_use[name] = 0.0
            return
        rc: Dict[str, int] = {}
        for pid in pids:
            # /T = 连子进程一起（GSV 的 venv 启动器会再生一个真身）
            rc[pid] = run_quiet(["taskkill", "/PID", pid, "/T", "/F"], timeout=15)
        dead = True
        if port:
            for _ in range(10):                    # 等端口真释放
                if not probe(base_url(port), timeout=0.4):
                    dead = True
                    break
                dead = False
                time.sleep(0.8)
        if dead:
            log(f"supervisor: {name} 已停止（{' '.join(sorted(pids))}）{reason}")
        else:
            # taskkill 被拒（权限/沙箱）是"关不掉"的经典成因，必须吼出来，别写"已停止"
            log(f"supervisor: WARN {name} 还占着 :{port}（taskkill 返回 "
                f"{ {k: v for k, v in rc.items()} }）{reason}")
        self._last_use[name] = 0.0

    @staticmethod
    def _pids_listening(port: int) -> set:
        """netstat 找出监听该端口的 PID（管不到自己 spawn 的进程时兜底用）。"""
        pids: set = set()
        for line in run_capture(["netstat", "-ano", "-p", "tcp"], timeout=10).splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[3].upper() == "LISTENING" \
                    and parts[1].rstrip().endswith(f":{port}"):
                pids.add(parts[4])
        return pids


    def _reaper_loop(self) -> None:
        idle_s = self.idle_minutes * 60.0
        while not self._stop.wait(30):
            now = time.time()
            for name in ("gsv", "breeze", "index"):
                if self._inflight.get(name, 0) > 0 or self._spawning.get(name):
                    continue               # 正在合成/正在拉起，别杀
                running = self._popen.get(name) is not None and self._popen[name].poll() is None
                if not running:
                    continue
                # last=0 表示不是我们管的（外部手工起的），也照关——管家语义就是"闲了就收"
                last = self._last_use.get(name, 0.0)
                if last and now - last < idle_s:
                    continue
                quiet = f"空闲 {self.idle_minutes} 分钟"
                log(f"supervisor: 回收 {name}（{quiet}，还显存给游戏）")
                try:
                    self._kill(name, reason=f"({quiet})")
                except Exception as e:  # noqa: BLE001
                    log(f"supervisor: 回收 {name} 失败：{e}")


def base_url(port: int) -> str:
    return f"http://127.0.0.1:{port}"


class IndexBackend:
    """IndexTTS-2.5（indextts_server.py，POST /tts JSON → wav）。情感/语速可选。"""

    name = "index"
    supports_speed = True          # duration = 1/speed（IndexTTS 的语速倒数）

    def __init__(self, base: str, timeout: float) -> None:
        self.base, self.timeout = base, timeout

    def health(self) -> Dict[str, Any]:
        up = probe(self.base)
        info: Any = None
        if up:
            try:
                st, info = http_get_json(self.base.rstrip("/") + "/health", timeout=10)
            except Exception as e:  # noqa: BLE001
                info = f"probe failed: {e}"
        return {"base": self.base, "reachable": up, "health": info}

    def synth(self, text: str, prof: Dict[str, Any], speed: float) -> Tuple[bytes, str]:
        ref = prof.get("ref_audio_path") or prof.get("ref_audio") or ""
        payload: Dict[str, Any] = {"text": text, "ref_audio": ref}
        for k in ("emo_vector", "emo_text", "use_emo_text", "duration"):
            if prof.get(k) is not None:
                payload[k] = prof[k]
        if speed != 1.0:
            payload["duration"] = round(1.0 / max(speed, 0.1), 3)   # IndexTTS 的 duration 是语速倒数
        st, body, ctype = http_post_json(self.base.rstrip("/") + "/tts", payload, self.timeout)
        if st != 200:
            raise UpstreamError(st, body, ctype, self.name)
        if not (body[:4] == b"RIFF" and body[8:12] == b"WAVE"):
            raise UpstreamError(502, b'{"message":"index did not return wav"}',
                                "application/json", self.name)
        return body, "wav"


# ─────────────────────────── 路由 ───────────────────────────
class Adapter:
    def __init__(self, backends: Dict[str, Any], profiles: Dict[str, Any],
                 timeout: float, bitrate: int,
                 supervisor: Optional["Supervisor"] = None,
                 store: Optional["ProfilesStore"] = None) -> None:
        self.backends = backends
        self._profiles = profiles
        self.store = store
        self.timeout, self.bitrate = timeout, bitrate
        self.supervisor = supervisor
        self.ffmpeg = find_ffmpeg()
        self.started_at = time.time()
        self.last: Dict[str, Any] = {}       # 最近一次合成的实参（/admin/status 里回显）
        self.pid_file = ""                   # main() 里填，写盘见 write_pid_file()
        # ── 梯队降级状态（2026-10-27）──
        # 用户："完全用不了的语音要直接标注并把模型自动划到下一梯队"。
        # 连续起不来的后端被降级一段时间（期间合成直接绕开它走下一梯队），
        # 状态在 /health 的 tiers 里回给面板，音色下拉据此标 "⛔ 降级中"。
        self._fails: Dict[str, List[float]] = {}
        self._demoted_until: Dict[str, float] = {}
        self._last_err: Dict[str, str] = {}

    # ── 梯队降级（坏引擎自动划到下一档）─────────────────────────────
    TIER_ORDER = ("gsv", "index", "breeze")   # 越省显存越靠前
    DEMOTE_WINDOW_S = 600.0   # 10 分钟窗口
    DEMOTE_HITS = 3           # 窗口内连败 3 次 → 降级
    DEMOTE_SOFT_S = 300.0     # 显存不够这类"暂时性"失败：降 5 分钟
    DEMOTE_HARD_S = 1800.0    # 启动超时/模型崩这类硬失败：降 30 分钟

    def mark_fail(self, name: str, why: str) -> None:
        now = time.time()
        lst = [t for t in self._fails.get(name, []) if now - t < self.DEMOTE_WINDOW_S]
        lst.append(now)
        self._fails[name] = lst
        self._last_err[name] = str(why)[:300]
        soft = ("显存" in str(why) or "不够" in str(why))   # 暂时性：等显空就能好
        dur = self.DEMOTE_SOFT_S if soft else self.DEMOTE_HARD_S
        if len(lst) >= self.DEMOTE_HITS:
            self._demoted_until[name] = now + dur
            log(f"tier: {name} 降级 {int(dur / 60)}min（{self.DEMOTE_WINDOW_S / 60:.0f}min 内第"
                f"{len(lst)}次失败）：{self._last_err[name]}")

    def demoted(self, name: str) -> bool:
        return self._demoted_until.get(name, 0.0) > time.time()

    def tier_status(self) -> Dict[str, Any]:
        now = time.time()
        out: Dict[str, Any] = {}
        for name in self.backends:
            fails = [t for t in self._fails.get(name, [])
                     if now - t < self.DEMOTE_WINDOW_S]
            d = self._demoted_until.get(name, 0.0)
            out[name] = {
                "demoted": d > now,
                "demoted_min_left": round((d - now) / 60, 1) if d > now else 0.0,
                "recent_fails": len(fails),
                "last_error": self._last_err.get(name, ""),
            }
        return out

    @property
    def profiles(self) -> Dict[str, Any]:
        """每次读都走 store（mtime 变了自动换新），改 profiles.json 不用重启。"""
        return self.store.cfg if self.store is not None else self._profiles

    def backend_for(self, prof: Dict[str, Any]) -> Any:
        name = prof.get("backend") or self.profiles.get("default_backend") or "gsv"
        be = self.backends.get(name)
        if be is None:
            raise RuntimeError(f"未配置后端 {name!r}（可用：{sorted(self.backends)}）")
        return be

    @staticmethod
    def _usable_for(prof: Dict[str, Any], backend: str) -> bool:
        """这段 profile 能不能直接喂给 target 后端（关键是参考音在不在）。

        三个本地后端都吃"参考音克隆"，所以 gsv 的音色切到 index 一般也能出声；
        但 breeze_design 只有 instruction、没有参考音，硬塞给 gsv 会空参报错 ——
        这种就退回该后端的 engines.default_voice。
        """
        ref = prof.get("ref_audio_path") or prof.get("ref_audio") or ""
        has_ref = bool(ref) and os.path.isfile(ref)
        if backend == "breeze":
            return has_ref or bool(prof.get("instruction"))
        return has_ref

    def _engine_default_prof(self, backend: str) -> Optional[Dict[str, Any]]:
        """换梯队时音色带不过去（没参考音/空 profile），就用该引擎的默认音色。"""
        cfg = self.profiles
        try:
            alt = engine_default_voice(cfg["voices"], cfg.get("engines") or {},
                                       backend, cfg["default"])
            if not alt or alt not in cfg["voices"]:
                return None
            prof3 = dict(cfg["voices"][alt])
            prof3["backend"] = backend
            return prof3
        except Exception:  # noqa: BLE001
            return None

    def resolve(self, voice: str, model: str = "") -> Tuple[str, Dict[str, Any], str]:
        """voice + model → (实际音色名, 合并后的 profile, 来源说明)。

        model 非空时**以它为准**（这就是"浮窗切模型真生效"那条），voice 只在
        它属于该后端、或它的参考音能复用时才保留；否则换成该后端的默认音色。
        """
        cfg = self.profiles
        eng = normalize_model(model)
        name, prof = pick_profile(cfg, voice)
        if not eng:
            return name, prof, "voice"
        if eng not in self.backends:
            raise ModelError(
                f"model={model!r} 适配层管不了（能用的：{sorted(self.backends)}；"
                f"edge 是在线 edge-tts，由插件直连，不经这里）")
        native = str(prof.get("backend") or cfg.get("default_backend") or "gsv")
        if native == eng:
            return name, dict(prof), "voice"
        if self._usable_for(prof, eng):
            prof2 = dict(prof)
            prof2["backend"] = eng
            return name, prof2, f"voice-reuse:{native}->{eng}"
        alt = engine_default_voice(cfg["voices"], cfg.get("engines") or {},
                                   eng, cfg["default"])
        prof3 = dict(cfg["voices"][alt])
        prof3["backend"] = eng
        return alt, prof3, f"engine-default:{eng}({name}@{native})"


    def synth(self, text: str, voice: str, speed: float, fmt: str = "mp3",
              model: str = "", pitch_semitones: Optional[float] = None
              ) -> Tuple[bytes, str, str, Dict[str, Any]]:
        name, prof, source = self.resolve(voice, model)
        params = resolve_params(prof, speed, pitch_semitones)
        sup = self.supervisor
        native = str(prof.get("backend") or self.profiles.get("default_backend") or "gsv")
        # ── 梯队链：原生引擎优先，然后按"越省显存越靠前"挨个接力。
        #   起不来/报错的后端记一笔失败并当场降级，下一请求直接绕开它。
        chain = [b for b in ([native] + [b for b in self.TIER_ORDER if b != native])
                 if b in self.backends]
        tier_tries: List[Dict[str, Any]] = []
        last_err = ""
        for i, be_name in enumerate(chain):
            if self.demoted(be_name):
                tier_tries.append({"backend": be_name, "skip": "demoted"})
                continue
            prof_i = dict(prof) if self._usable_for(prof, be_name) \
                else self._engine_default_prof(be_name)
            if prof_i is None:
                tier_tries.append({"backend": be_name, "skip": "no-usable-voice"})
                continue
            be = self.backends[be_name]
            if sup is not None:
                err = sup.ensure(be_name, be.base)
                if err:
                    self.mark_fail(be_name, err)
                    tier_tries.append({"backend": be_name, "fail": err})
                    last_err = err
                    continue
                sup.enter(be_name)
            ok = False
            try:
                t0 = time.time()
                tup = be.synth(text, prof_i, params["speed"])
                ok = True
            except Exception as e:  # noqa: BLE001
                self.mark_fail(be_name, str(e))
                tier_tries.append({"backend": be_name, "fail": str(e)[:200]})
                last_err = str(e)
            finally:
                if sup is not None:
                    sup.leave(be_name)
            if not ok:
                continue
            audio, kind = tup if isinstance(tup, tuple) else (tup, "wav")
            ms_up = int((time.time() - t0) * 1000)
            meta: Dict[str, Any] = {"voice": name, "backend": be.name,
                                    "model": normalize_model(model) or be.name,
                                    "voice_source": source,
                                    "speed": params["speed"], "base_speed": params["base_speed"],
                                    "speed_native": bool(getattr(be, "supports_speed", True)),
                                    "pitch": params["pitch"],
                                    "temperature": params["temperature"],
                                    "upstream_bytes": len(audio), "upstream_ms": ms_up,
                                    "upstream_kind": kind}
            if be_name != native:
                meta["fallback_from"] = native
                meta["tier_tries"] = tier_tries
            # 后端原生不吃 speed 的（breeze）用 ffmpeg 补；pitch 一律在这层做
            if not meta["speed_native"]:
                audio, kind = change_tempo(audio, kind, params["speed"])
            if params["pitch"]:
                audio, kind = shift_pitch(audio, kind, params["pitch"])
            _pf = str(prof_i.get("post_filter") or "").strip()
            if _pf:
                audio, kind = _ffmpeg_af(audio, kind, _pf, "音色后处理")
                meta["post_filter"] = _pf
            if kind == "wav":
                try:
                    rate, ch, _sw, n = wav_info(audio)
                    meta.update({"rate": rate, "channels": ch,
                                 "upstream_seconds": round(n / float(rate or 1), 3)})
                except Exception:  # noqa: BLE001
                    meta.update({"rate": 0, "channels": 0, "upstream_seconds": 0.0})
            if fmt == "wav":
                return (audio, "audio/wav", "passthrough", meta) if kind == "wav" else \
                    (audio, "audio/mpeg", "passthrough", meta)
            if kind == "mp3":
                meta.setdefault("rate", 24000)
                return audio, "audio/mpeg", "upstream-mp3", meta
            mp3, encoder = encode_mp3(audio, self.bitrate)
            return mp3, "audio/mpeg", encoder, meta
        raise SupervisorError(
            last_err or f"本地 TTS 全梯队都不可用（尝试顺序：{chain}）；"
            "降级状态看 /health 的 tiers 字段")



# ─────────────────────────── HTTP 层 ───────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = f"local-tts-adapter/{VERSION}"
    protocol_version = "HTTP/1.1"
    adapter: "Adapter"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        pass

    @staticmethod
    def _hdr(v: Any) -> str:
        """HTTP 头只能是 latin-1：音色名里带中文时直接 send_header 会抛 UnicodeEncodeError，
        连接被掐断（客户端看到的是 RemoteDisconnected，极难查）。这里统一转义。"""
        s = "" if v is None else str(v)
        try:
            s.encode("latin-1")
            return s
        except UnicodeEncodeError:
            return urllib.parse.quote(s, safe="")

    def _send(self, code: int, body: bytes, ctype: str,
              extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, self._hdr(v))
        self.end_headers()

        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code: int, obj: Dict[str, Any]) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    # ── admin 只认本机 ──────────────────────────────────────────────
    LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost")

    def _is_local(self) -> bool:
        ip = (self.client_address[0] if self.client_address else "") or ""
        return ip in self.LOOPBACK

    def _local_only(self, path: str) -> bool:
        """admin 接口是本机运维口（停进程 / 强重载），局域网里别的机器不该能戳。"""
        if self._is_local():
            return True
        log(f"403 admin {path} from {self.client_address}")
        self._json(403, {"error": {"message": "admin endpoints are 127.0.0.1 only",
                                   "from": str(self.client_address[0])}})
        return False

    def _status(self) -> Dict[str, Any]:
        ad = self.adapter
        sup = ad.supervisor
        return {
            "ok": True, "version": VERSION, "pid": os.getpid(),
            "uptime_s": round(time.time() - ad.started_at, 1),
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S",
                                        time.localtime(ad.started_at)),
            "pid_file": ad.pid_file,
            "port": self.server.server_address[1],  # type: ignore[attr-defined]
            "encoder": "lameenc" if _has_lameenc() else ("ffmpeg" if ad.ffmpeg else None),
            "ffmpeg": ad.ffmpeg,
            "profiles": ad.store.info() if ad.store is not None else None,
            "voices": {k: {"backend": v.get("backend") or ad.profiles.get("default_backend"),
                           "base": v.get("_base"),
                           "speed": v.get("speed"), "pitch": v.get("pitch"),
                           "temperature": v.get("temperature")}
                       for k, v in ad.profiles["voices"].items()},
            "engines": {name: {"base": be.base, "reachable": probe(be.base),
                               "default_voice": (ad.profiles.get("engines") or {})
                               .get(name, {}).get("default_voice")}
                        for name, be in ad.backends.items()},
            "supervisor": sup.status() if sup else None,
            "tiers": ad.tier_status(),
            "last": ad.last or None,
        }

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
        ad = self.adapter
        if path == "/admin/status":
            if not self._local_only(path):
                return
            self._json(200, self._status())
            return
        if path == "/health":
            _tiers = ad.tier_status()
            self._json(200, {
                "ok": True, "version": VERSION,
                "encoder": "lameenc" if _has_lameenc() else ("ffmpeg" if ad.ffmpeg else None),
                "ffmpeg": ad.ffmpeg, "bitrate_kbps": ad.bitrate,
                "backends": {k: v.health() for k, v in ad.backends.items()},
                "default_backend": ad.profiles.get("default_backend"),
                "voices": {k: {
                    "backend": v.get("backend") or ad.profiles.get("default_backend"),
                    # 音色可用性：原生引擎被降级 = 这个音色现在出不了声（面板标 ⛔）
                    "usable": not _tiers.get(
                        v.get("backend") or ad.profiles.get("default_backend") or "",
                        {}).get("demoted", False),
                } for k, v in ad.profiles["voices"].items()},
                "default_voice": ad.profiles["default"],
                "pid": os.getpid(),
                "profiles": ad.store.info() if ad.store is not None else None,
                "supervisor": ad.supervisor.status() if ad.supervisor else None,
                "tiers": _tiers,
            })
            return
        if path == "/voices":
            self._json(200, {"voices": sorted(ad.profiles["voices"].keys()),
                             "default": ad.profiles["default"],
                             "backends": sorted(ad.backends.keys()),
                             "engines": ad.profiles.get("engines") or {}})
            return
        self._json(404, {"error": {"message": f"no route {path}"}})

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
        # 2026-10-26: 优雅停机。浮窗「停止」先打这个接口 —— 适配层 finally 里会把
        # 自己拉起来的 GSV / IndexTTS 一并带走，不留孤儿（孤儿进程才是那个关不掉的黑窗）。
        if path in ("/admin/stop", "/shutdown"):
            if not self._local_only(path):
                return
            self._json(200, {"ok": True, "stopping": True, "pid": os.getpid()})
            try:
                t = threading.Timer(0.4, self.server.shutdown)  # type: ignore[attr-defined]
                t.daemon = True
                t.start()
            except Exception:  # noqa: BLE001
                pass
            return
        if path in ("/admin/reload", "/admin/reload-profiles"):
            if not self._local_only(path):
                return
            try:
                info = self.adapter.store.force_reload() if self.adapter.store else {}
                self._json(200, {"ok": True, "profiles": info})
            except Exception as e:  # noqa: BLE001
                # 新配置写坏了：store 里还留着上一份好的，别把服务搞死
                self._json(400, {"ok": False, "error": {"message": f"reload failed: {e}"},
                                 "profiles": self.adapter.store.info()
                                 if self.adapter.store else None})
            return
        if path not in ("/v1/audio/speech", "/audio/speech"):
            self._json(404, {"error": {"message": f"no route {path}"}})
            return
        t0 = time.time()
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                self._json(400, {"error": {"message": "bad Content-Length"}})
                return
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._json(400, {"error": {"message": f"invalid json: {e}"}})
            return

        text = (body.get("input") or body.get("text") or "").strip()
        voice = str(body.get("voice") or body.get("name") or "")
        model = str(body.get("model") or "")
        fmt = str(body.get("response_format") or body.get("format") or "mp3").lower()
        try:
            speed = float(body.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = min(max(speed, 0.5), 2.0)
        pitch_semitones: Optional[float] = None
        if body.get("pitch_semitones") is not None:
            try:
                pitch_semitones = float(body["pitch_semitones"])
            except (TypeError, ValueError):
                pitch_semitones = None

        if not text:
            self._json(400, {"error": {"message": "input/text is required"}})
            return
        if len(text) > MAX_TEXT:
            text = text[:MAX_TEXT]
        if fmt not in ("mp3", "wav"):
            self._json(400, {"error": {"message": f"unsupported response_format {fmt}"}})
            return

        try:
            data, ctype, encoder, meta = self.adapter.synth(text, voice, speed, fmt,
                                                           model=model,
                                                           pitch_semitones=pitch_semitones)
        except ModelError as e:
            log(f"400 POST {path} model={model!r}: {e}")
            self._json(400, {"error": {"message": str(e), "type": "model_not_local",
                                       "model": model,
                                       "available": sorted(self.adapter.backends)}})
            return
        except SupervisorError as e:
            log(f"503 POST {path} supervisor: {e}")
            self._json(503, {"error": {"message": str(e), "type": "tts_backend_unavailable"}})
            return
        except UpstreamError as e:
            log(f"{e.status} POST {path} backend={e.backend} upstream={e.status} "
                f"body={e.body[:200]!r}")
            self._send(e.status if 400 <= e.status < 600 else 502, e.body,
                       e.ctype or "application/json",
                       {"X-Error-Source": e.backend, "X-Upstream-Status": str(e.status)})
            return
        except Exception as e:  # noqa: BLE001
            log(f"502 POST {path} {e}")
            self._json(502, {"error": {"message": str(e)}})
            return

        ms = int((time.time() - t0) * 1000)
        meta["elapsed_ms"] = ms
        meta["text_chars"] = len(text)
        self.adapter.last = dict(meta, at=time.strftime("%H:%M:%S"))
        headers = {
            "X-Encoder": encoder, "X-Backend": str(meta.get("backend")),
            "X-Voice": str(meta.get("voice")),
            "X-Model": str(meta.get("model")),
            "X-Voice-Source": str(meta.get("voice_source")),
            "X-Speed": str(meta.get("speed")),
            "X-Pitch": str(meta.get("pitch")),
            "X-Temperature": str(meta.get("temperature")),
            "X-Upstream-Seconds": str(meta.get("upstream_seconds")),
            "X-Upstream-Ms": str(meta.get("upstream_ms")),
            "X-Elapsed-Ms": str(ms),
        }
        if fmt == "mp3":
            headers["X-Bitrate"] = f"{self.adapter.bitrate}k"
        self._send(200, data, ctype, headers)
        log(f"200 POST {path} backend={meta.get('backend')} model={meta.get('model')} "
            f"voice={meta.get('voice')} speed={meta.get('speed')} "
            f"pitch={meta.get('pitch')} src={meta.get('voice_source')} "
            f"chars={len(text)} bytes={len(data)} enc={encoder} "
            f"audio={meta.get('upstream_seconds')}s total={ms}ms")



def _has_lameenc() -> bool:
    try:
        import lameenc  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def write_pid_file(path: str, port: int, log_path: str = "") -> None:
    """启动就把自己的 pid 写下来，浮窗「停止」和 stop-services.ps1 靠它认人。

    内容刻意只放**一行纯数字** —— 消费者（lib/tts-core.mjs）是
    `writeFileSync(pidFile, String(p.pid))` 并直接 readFile(...).trim() 当 pid 用的，
    多写 JSON 会把老代码弄崩。要更多信息就看旁边的 .json 兄弟文件。
    """
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
        side = os.path.splitext(path)[0] + ".json"
        with open(side, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "port": port, "version": VERSION,
                       "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                       "log": log_path}, f, ensure_ascii=False)
        log(f"pid file: {path} ({os.getpid()})")
    except Exception as e:  # noqa: BLE001
        log(f"WARN 写 pid 文件失败 {path}: {e!r}")


def clear_pid_file(path: str) -> None:
    """退出时删掉 —— 但只删自己写的那个（别把别人新起的适配层的 pid 抹掉）。"""
    if not path:
        return
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                cur = f.read().strip()
            if cur == str(os.getpid()):
                os.remove(path)
                log(f"pid file removed: {path}")
        side = os.path.splitext(path)[0] + ".json"
        if os.path.isfile(side):
            os.remove(side)
    except Exception as e:  # noqa: BLE001
        log(f"WARN 删除 pid 文件失败 {path}: {e!r}")


def main(argv: Optional[List[str]] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass

    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="多后端 OpenAI 形状 TTS 适配层")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--gsv", default=os.environ.get("TTS_GSV", DEFAULT_GSV))
    ap.add_argument("--breeze", default=os.environ.get("TTS_BREEZE", DEFAULT_BREEZE))
    ap.add_argument("--index", default=os.environ.get("TTS_INDEX", DEFAULT_INDEX),
                    help="IndexTTS-2.5 服务地址（indextts_server.py :9890）")
    ap.add_argument("--backend", default="", help="默认后端 gsv|breeze")
    ap.add_argument("--profiles", default=os.path.join(here, "profiles.json"))
    ap.add_argument("--no-pid-file", action="store_true", default=False,
                    help="不写 pid 文件（临时起一个调试实例时用，免得顶掉正式的那个）")
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("TTS_TIMEOUT", "180")))
    ap.add_argument("--bitrate", type=int, default=DEFAULT_BITRATE_KBPS)
    ap.add_argument("--breeze-pcm-rate", type=int, default=BREEZE_PCM_RATE)
    # ── 管家（按需启停后端）──
    ap.add_argument("--manage", action="store_true", default=False,
                    help="启用管家：后端没起就拉起，空闲自动关闭，显存不够拒绝启动")
    ap.add_argument("--no-manage", dest="manage", action="store_false",
                    help="老行为：只代理，后端自己管自己")
    ap.add_argument("--idle-minutes", type=float,
                    default=float(os.environ.get("TTS_IDLE_MINUTES", "10")),
                    help="后端空闲多少分钟后自动关闭还显存（0=不自动关，默认 10）")
    ap.add_argument("--min-free-mb", type=int, default=int(os.environ.get("TTS_MIN_FREE_MB", "0")),
                    help="启动后端要求的最小空闲显存（0=按后端默认：gsv 3400 / breeze 4800）")
    ap.add_argument("--need-gsv-mb", type=int, default=0)
    ap.add_argument("--need-breeze-mb", type=int, default=0)
    ap.add_argument("--log-dir", default=os.environ.get(
        "TTS_LOG_DIR",
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.dirname(os.path.abspath(__file__))))), "tmp")),
                    help="后端启动日志目录（默认 <仓库根>/tmp）")
    a = ap.parse_args(argv)

    store = ProfilesStore(a.profiles, a.backend)
    profiles = store.cfg
    os.makedirs(a.log_dir, exist_ok=True)
    os.environ["TTS_ADAPTER_LOG"] = os.path.join(a.log_dir, "tts-adapter.log")
    backends: Dict[str, Any] = {
        "gsv": GsvBackend(a.gsv, a.timeout),
        "breeze": BreezeBackend(a.breeze, a.timeout, a.breeze_pcm_rate),
        "index": IndexBackend(a.index, a.timeout),
    }
    root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))   # server.py 在 <root>/skills/local-tts/adapter/
    sup = Supervisor(root, a.log_dir, idle_minutes=a.idle_minutes,
                     min_free_mb=a.min_free_mb,
                     need_mb={"gsv": a.need_gsv_mb or 0, "breeze": a.need_breeze_mb or 0},
                     enabled=a.manage)
    adapter = Adapter(backends, profiles, a.timeout, a.bitrate, supervisor=sup, store=store)
    Handler.adapter = adapter

    # pid 文件：默认 <仓库根>/dshqqbot/.qqbot/tts/adapter.pid（和插件 tts-core.mjs 对齐）
    pid_file = os.environ.get(PID_FILE_ENV) or os.path.join(
        root, "dshqqbot", ".qqbot", "tts", "adapter.pid")
    if a.no_pid_file:
        pid_file = ""
    adapter.pid_file = pid_file

    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    if pid_file:
        write_pid_file(pid_file, srv.server_address[1],
                       os.environ.get("TTS_ADAPTER_LOG", ""))
    log(f"listening http://{a.host}:{a.port}  gsv={a.gsv}  breeze={a.breeze}  "
        f"encoder={'lameenc' if _has_lameenc() else 'ffmpeg'}")
    if a.manage:
        log(f"supervisor: ON（空闲 {a.idle_minutes} 分钟自动关后端；"
            f"显存门槛 gsv={a.need_gsv_mb or DEFAULT_NEED_MB['gsv']}MB / "
            f"breeze={a.need_breeze_mb or DEFAULT_NEED_MB['breeze']}MB / "
            f"index={DEFAULT_NEED_MB['index']}MB；日志 {a.log_dir}）")
        sup.start_reaper()
    else:
        log("supervisor: off（老行为，后端自己管自己）")
    log("voices=" + json.dumps({k: v.get("backend") or profiles["default_backend"]
                                for k, v in profiles["voices"].items()}, ensure_ascii=False))
    for name, be in backends.items():
        if not probe(be.base):
            log(f"WARN {name} 上游 {be.base} 现在连不上（/health 里 reachable=false）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("bye")
    finally:
        sup.shutdown()
        # 适配层退出时把**自己拉起的**后端一并带走；--no-manage 手动模式下不动别人起的服务
        for name in ("gsv", "breeze", "index"):
            try:
                sup._kill(name, reason="(适配层退出)", only_own=not a.manage)
            except Exception as e:  # noqa: BLE001
                log(f"WARN 退出时停 {name} 失败: {e!r}")
        clear_pid_file(pid_file)
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
