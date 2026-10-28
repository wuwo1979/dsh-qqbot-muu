#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IndexTTS-2.5 本地 HTTP 服务（stdlib，和 adapter 同款风格）。

    <index-tts-code 的 venv python> indextts_server.py --port 9890

    POST /tts      {"text": "...", "ref_audio": "F:/.../ref_zh.wav",
                    "emo_vector": [happy,angry,sad,afraid,disgusted,melancholic,surprised,calm]?,
                    "emo_text"?: "...", "use_emo_text"?: bool, "duration"?: 1.0}
                   -> audio/wav
    GET  /health   -> {ok, model_loaded, device}

模型载入约 30-60s（bf16，约 5-6GB 显存）。参考音频给 3-10s 干净人声，
小蓝沿用 F:/qqbot/.models/tts-ref/ref_zh.wav。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

DEFAULT_PORT = 9890
DEFAULT_CKPT = r"F:\qqbot\.models\index-tts"
MAX_BODY = 64 * 1024
MAX_TEXT = 1000

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass


def log(msg: str) -> None:
    print(f"[indextts {time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Engine:
    def __init__(self, ckpt: str) -> None:
        self.ckpt = ckpt
        self.tts = None
        self.device = ""
        self.failed = ""

    def load(self) -> None:
        t0 = time.time()
        try:
            # HF 小模型镜像（w2v-bert 等）：国内走 hf-mirror
            os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
            from indextts.infer_v2_5 import IndexTTS2  # type: ignore

            import torch  # type: ignore

            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            log(f"loading IndexTTS2 from {self.ckpt} (device={self.device}) …")
            self.tts = IndexTTS2(cfg_path=os.path.join(self.ckpt, "config.yaml"),
                                 model_dir=self.ckpt, use_bf16=(self.device == "cuda"))
            log(f"model ready in {time.time()-t0:.0f}s")
        except Exception as e:  # noqa: BLE001
            import traceback
            self.failed = f"{e}"
            log("LOAD FAILED: " + repr(e))
            traceback.print_exc()

    def synth(self, text: str, ref_audio: str, out: str,
              emo_vector: Optional[List[float]] = None,
              emo_text: str = "", use_emo_text: bool = False,
              duration: Optional[float] = None) -> Dict[str, Any]:
        if self.tts is None:
            return {"ok": False, "error": self.failed or "model not loaded"}
        kwargs: Dict[str, Any] = {}
        if emo_vector:
            v = list(emo_vector)[:8] + [0.0] * (8 - len(emo_vector))
            kwargs["emo_vector"] = [float(x) for x in v]
        if emo_text:
            kwargs["emo_text"] = str(emo_text)
            kwargs["use_emo_text"] = True
        elif use_emo_text:
            kwargs["use_emo_text"] = True
        if duration:
            kwargs["duration"] = float(min(max(duration, 0.5), 2.0))
        t0 = time.time()
        self.tts.infer(spk_audio_prompt=ref_audio, text=text, lang="ZH",
                       output_path=out, **kwargs)
        ms = int((time.time() - t0) * 1000)
        return {"ok": True, "ms": ms}


class Handler(BaseHTTPRequestHandler):
    server_version = "indextts-server/1.0"
    protocol_version = "HTTP/1.1"
    engine: Engine

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        pass

    def _json(self, code: int, obj: Dict[str, Any]) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
        if path == "/health":
            e = self.engine
            self._json(200, {"ok": e.tts is not None, "model_loaded": e.tts is not None,
                             "device": e.device, "failed": e.failed, "ckpt": e.ckpt})
            return
        self._json(404, {"error": f"no route {path}"})

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
        if path != "/tts":
            self._json(404, {"error": f"no route {path}"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                self._json(400, {"error": "bad Content-Length"})
                return
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._json(400, {"error": f"invalid json: {e}"})
            return
        text = str(body.get("text") or "").strip()
        if not text:
            self._json(400, {"error": "text is required"})
            return
        text = text[:MAX_TEXT]
        ref = str(body.get("ref_audio") or body.get("ref_audio_path") or "").strip()
        if not ref or not os.path.isfile(ref):
            self._json(400, {"error": f"ref_audio 不存在：{ref or '(空)'}"})
            return
        import tempfile
        out = os.path.join(tempfile.gettempdir(), f"indextts-{int(time.time()*1000)}.wav")
        try:
            r = self.engine.synth(text, ref, out,
                                  emo_vector=body.get("emo_vector"),
                                  emo_text=str(body.get("emo_text") or ""),
                                  use_emo_text=bool(body.get("use_emo_text")),
                                  duration=body.get("duration"))
        except Exception as e:  # noqa: BLE001
            log(f"synth error: {e!r}")
            self._json(500, {"error": f"synth failed: {e}"})
            return
        if not r.get("ok"):
            self._json(503, {"error": r.get("error") or "engine unavailable"})
            return
        with open(out, "rb") as f:
            wav = f.read()
        try:
            os.remove(out)
        except OSError:
            pass
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.send_header("X-Engine-Ms", str(r.get("ms")))
        self.end_headers()
        try:
            self.wfile.write(wav)
        except (BrokenPipeError, ConnectionResetError):
            pass
        log(f"200 /tts chars={len(text)} bytes={len(wav)} engine={r.get('ms')}ms")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--ckpt", default=os.environ.get("INDextts_CKPT", DEFAULT_CKPT))
    ap.add_argument("--lazy", action="store_true", help="先起 HTTP 再加载模型")
    a = ap.parse_args()

    eng = Engine(a.ckpt)
    Handler.engine = eng
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    log(f"listening http://{a.host}:{a.port} ckpt={a.ckpt}")
    if a.lazy:
        import threading
        threading.Thread(target=eng.load, daemon=True).start()
    else:
        eng.load()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("bye")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
