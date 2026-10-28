#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
local-tts stub —— 冒充真实 TTS 上游，让适配层在没有真模型时也能端到端验收。
两种模式：

  --mode gsv    （默认）冒充 GPT-SoVITS api_v2.py 的参数式接口
        GET/POST /tts?text=..&text_lang=zh&ref_audio_path=..&prompt_lang=zh&media_type=wav
        GET  /health
        返回 wav（真可播放的正弦波）

  --mode breeze 冒充 Breeze TTS 2 官方 runtime
        POST /v1/audio/speech    multipart/form-data（text/ref_text/cfg_scale/instruction/ref_audio）
                                 返回 **裸 24kHz s16le PCM**（故意不带容器，好验证适配层的 pcm→wav 包装）
        GET  /v1/model           返回 {"frame_rate":12.5,...}

故障注入：
  --fail               一律 400 {"message":...}
  --fail-after N       前 N 次成功
  --silent             等长静音
  --pcm-short          breeze 模式返回 100 字节残缺 PCM（验证 <4800B 守卫）
  --drop-ref           breeze 模式忽略 ref_audio（验证 voice design 分支）

    python adapter/stub.py --port 9880 --mode gsv
    python adapter/stub.py --port 7860 --mode breeze
"""
from __future__ import annotations

import argparse
import io
import json
import math
import struct
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

CFG: Dict[str, Any] = {}
STATE = {"calls": 0}
REQUIRED_GSV = ("text", "text_lang", "ref_audio_path", "prompt_lang")


def build_wav(seconds: float, freq: float, rate: int = 24000, silent: bool = False) -> bytes:
    n = max(1, int(seconds * rate))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(n):
            v = 0 if silent else int(12000 * math.sin(2 * math.pi * freq * i / rate))
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def build_pcm(seconds: float, freq: float, rate: int = 24000, silent: bool = False) -> bytes:
    n = max(1, int(seconds * rate))
    out = bytearray()
    for i in range(n):
        v = 0 if silent else int(12000 * math.sin(2 * math.pi * freq * i / rate))
        out += struct.pack("<h", v)
    return bytes(out)


def parse_multipart(body: bytes, ctype: str) -> Dict[str, Any]:
    """极简 multipart 解析：只取表单字段名和是否有文件，够验证用。"""
    fields: Dict[str, Any] = {}
    if "boundary=" not in ctype:
        return fields
    boundary = ctype.split("boundary=", 1)[1].strip().strip('"')
    for chunk in body.split(("--" + boundary).encode()):
        if not chunk.strip(b"--\r\n"):
            continue
        head, _, payload = chunk.partition(b"\r\n\r\n")
        head_txt = head.decode("utf-8", "replace")
        name = ""
        for line in head_txt.split("\r\n"):
            if "name=" in line:
                name = line.split('name="', 1)[1].split('"', 1)[0]
                break
        if not name:
            continue
        is_file = "filename=" in head_txt
        val = payload.rstrip(b"\r\n")
        fields[name] = {"file": is_file, "len": len(val),
                        "value": None if is_file else val.decode("utf-8", "replace")}
    return fields


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code: int, obj: Dict[str, Any]) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json")

    def _maybe_fail(self) -> bool:
        STATE["calls"] += 1
        if CFG["delay_ms"]:
            time.sleep(CFG["delay_ms"] / 1000.0)
        if CFG["fail"]:
            return True
        fa = CFG["fail_after"]
        if fa and STATE["calls"] > fa:
            return True
        return False

    # ── gsv ──────────────────────────────────────────────
    def _gsv(self, params: Dict[str, Any]) -> None:
        if self._maybe_fail():
            self._json(400, {"message": "tts failed",
                             "Exception": "stub: injected failure",
                             "Traceback": "stub.py"})
            print(f"[stub-gsv] 400 injected (call {STATE['calls']})", flush=True)
            return
        missing = [k for k in REQUIRED_GSV if not str(params.get(k) or "").strip()]
        if missing:
            self._json(400, {"message": f"missing {missing}"})
            print(f"[stub-gsv] 400 missing {missing}", flush=True)
            return
        wav = build_wav(CFG["seconds"], CFG["freq"], CFG["rate"], CFG["silent"])
        print(f"[stub-gsv] 200 wav {len(wav)}B text={str(params.get('text'))[:20]!r}",
              flush=True)
        self._send(200, wav, "audio/wav")

    # ── breeze ───────────────────────────────────────────
    def _breeze(self, body: bytes, ctype: str) -> None:
        if self._maybe_fail():
            self._json(500, {"detail": "stub: injected failure"})
            print(f"[stub-breeze] 500 injected (call {STATE['calls']})", flush=True)
            return
        f = parse_multipart(body, ctype)
        text = (f.get("text") or {}).get("value") or ""
        if not text.strip():
            self._json(422, {"detail": [{"loc": ["body", "text"], "msg": "field required"}]})
            print("[stub-breeze] 422 missing text", flush=True)
            return
        has_ref = "ref_audio" in f and (f["ref_audio"] or {}).get("file")
        has_ref_text = bool((f.get("ref_text") or {}).get("value"))
        if has_ref and not has_ref_text:
            self._json(422, {"detail": "ref_text is required with ref_audio"})
            print("[stub-breeze] 422 ref_text missing", flush=True)
            return
        if CFG["drop_ref"]:
            has_ref = False
        if CFG["pcm_short"]:
            pcm = b"\x00\x01" * 50
            print("[stub-breeze] 200 short pcm 100B", flush=True)
            self._send(200, pcm, "application/octet-stream")
            return
        pcm = build_pcm(CFG["seconds"], CFG["freq"], CFG["pcm_rate"], CFG["silent"])
        mode = "clone" if has_ref else "design"
        print(f"[stub-breeze] 200 pcm {len(pcm)}B mode={mode} "
              f"ref={ (f.get('ref_audio') or {}).get('len') }B "
              f"cfg={(f.get('cfg_scale') or {}).get('value')}", flush=True)
        self._send(200, pcm, "application/octet-stream")

    # ── routing ──────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if path == "/health":
            self._json(200, {"ok": True, "mode": CFG["mode"],
                             "calls": STATE["calls"], "rate": CFG["rate"],
                             "seconds": CFG["seconds"]})
            return
        if path == "/v1/model" and CFG["mode"] == "breeze":
            self._json(200, {"frame_rate": 12.5, "model_digest": "stub",
                             "max_new_tokens": 1500, "max_batch_texts": 128})
            return
        if path == "/tts" and CFG["mode"] == "gsv":
            params = {k: v[0] for k, v in parse_qs(u.query).items()}
            self._gsv(params)
            return
        self._json(404, {"message": f"no route {path}"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        ctype = self.headers.get("Content-Type", "")
        if path == "/tts" and CFG["mode"] == "gsv":
            try:
                params = json.loads(body.decode("utf-8")) if body else {}
            except Exception:  # noqa: BLE001
                params = {k: v[0] for k, v in parse_qs(body.decode("utf-8", "replace")).items()}
            self._gsv(params)
            return
        if path in ("/v1/audio/speech", "/audio/speech") and CFG["mode"] == "breeze":
            self._breeze(body, ctype)
            return
        self._json(404, {"message": f"no route {path}"})


def main(argv: Optional[list] = None) -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9880)
    ap.add_argument("--mode", choices=("gsv", "breeze"), default="gsv")
    ap.add_argument("--seconds", type=float, default=1.0)
    ap.add_argument("--freq", type=float, default=440.0)
    ap.add_argument("--rate", type=int, default=24000)
    ap.add_argument("--pcm-rate", type=int, default=24000)
    ap.add_argument("--delay-ms", type=int, default=0)
    ap.add_argument("--fail", action="store_true")
    ap.add_argument("--fail-after", type=int, default=0)
    ap.add_argument("--silent", action="store_true")
    ap.add_argument("--pcm-short", action="store_true")
    ap.add_argument("--drop-ref", action="store_true")
    a = ap.parse_args(argv)
    CFG.update(vars(a))
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"[stub] mode={a.mode} listening http://{a.host}:{a.port} "
          f"seconds={a.seconds} freq={a.freq}Hz", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
