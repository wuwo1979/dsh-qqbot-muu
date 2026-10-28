#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
local-tts 验收脚本 v2 —— 多后端真跑校验，任一失败退出码非 0。

    python scripts/verify.py                                    # 打默认端口 9881/9880/7860
    python scripts/verify.py --backends gsv                     # 只验 GPT-SoVITS
    python scripts/verify.py --backends breeze --require-breeze # 只验 Breeze，缺就 FAIL
    python scripts/verify.py --out F:\\qqbot\\tmp\\selftest --json

用例：
  [1] adapter GET /health        —— 服务活着、编码器可用、两后端的 reachable 字段齐全
  [2] 直连 gsv  POST /tts        —— 参数式接口真出 wav（RIFF/WAVE）
  [3] 直连 breeze POST /v1/audio/speech —— multipart 进、裸 PCM 出，按 24k/16bit 折时长
  [4] adapter → gsv voice        —— 200 + audio/mpeg，X-Backend 必须是 gsv
  [5] adapter → breeze voice     —— 200 + audio/mpeg，X-Backend 必须是 breeze（PCM→wav→mp3 全链）
  [6] mp3 体检                   —— >=2000B（插件 MIN_BYTES 门槛）、头是 ID3/帧头而不是 RIFF、时长对得上

只用标准库（urllib），不依赖 requests。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import wave
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(os.path.realpath(__file__)))
ADAPTER_DIR = os.path.abspath(os.path.join(HERE, "..", "adapter"))
sys.path.insert(0, ADAPTER_DIR)
sys.dont_write_bytecode = True   # 别在 skills 目录里留 __pycache__
try:
    import server as adapter_mod  # noqa: E402  （拿 find_ffmpeg / pcm16_to_wav）
except Exception:  # noqa: BLE001
    adapter_mod = None  # type: ignore

MIN_BYTES = 2000          # 对齐插件 dshqqbot/.qqbot-extensions/lib/tts-core.mjs:28
GOOD_BYTES = 6000
TEXT = "今天海边的风很轻，我想和你说点悄悄话。"
REF_TEXT_DEFAULT = "今天的风很轻，适合说点悄悄话。你听，海边的潮水正在慢慢退下去。"
BREEZE_PCM_RATE = 24000

RESULTS: List[Dict[str, Any]] = []
OUT = ""


def say(line: str) -> None:
    print(line, flush=True)


def rec(n: int, name: str, status: str, detail: str) -> None:
    RESULTS.append({"n": n, "name": name, "status": status, "detail": detail})
    say(f"  [{n}] {name:<28} {status:<5} {detail}")


def http(url: str, data: Optional[bytes] = None, headers: Optional[Dict[str, str]] = None,
         method: str = "GET", timeout: float = 180) -> Tuple[int, Dict[str, str], bytes]:
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()
    except Exception as e:  # noqa: BLE001
        return 0, {}, str(e).encode()


def multipart(fields: Dict[str, Any], files: Dict[str, Tuple[str, bytes, str]]) -> Tuple[bytes, str]:
    b = "----verify" + uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        if v is None or v == "":
            continue
        out.write(f"--{b}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        out.write(str(v).encode("utf-8"))
        out.write(b"\r\n")
    for k, (fn, d, ct) in files.items():
        out.write(f"--{b}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{k}"; filename="{fn}"\r\n'.encode())
        out.write(f"Content-Type: {ct}\r\n\r\n".encode())
        out.write(d)
        out.write(b"\r\n")
    out.write(f"--{b}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={b}"


def ffmpeg_duration(data: bytes, suffix: str) -> Tuple[Optional[float], str]:
    """把字节写盘，用 ffmpeg -i 读时长（不碰管道，stderr 也落盘）。"""
    ff = None
    if adapter_mod is not None:
        ff = adapter_mod.find_ffmpeg()
    if not ff:
        return None, "no-ffmpeg"
    d = tempfile.mkdtemp(prefix="verify-dur-")
    p = os.path.join(d, "in" + suffix)
    err = os.path.join(d, "err.txt")
    with open(p, "wb") as f:
        f.write(data)
    with open(err, "wb") as ef:
        subprocess.run([ff, "-hide_banner", "-i", p], stdout=subprocess.DEVNULL,
                       stderr=ef, timeout=60, check=False)
    with open(err, "rb") as ef:
        txt = ef.read().decode("utf-8", "replace")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", txt)
    if not m:
        return None, txt[-200:]
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), "ok"


def mp3_header_ok(data: bytes) -> Tuple[bool, str]:
    if data[:4] == b"RIFF":
        return False, "RIFF/上游没转码"
    if data[:3] == b"ID3":
        return True, f"ID3(v2.{data[3]})"
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        frames = {"1": {1: "L1", 2: "L2", 3: "L3"}}
        return True, f"MPEG 帧头 {data[0]:02X} {data[1]:02X}"
    return False, f"头 {data[:4].hex()}"


def load_profiles(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def main(argv: Optional[List[str]] = None) -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default="http://127.0.0.1:9881")
    ap.add_argument("--gsv", default="http://127.0.0.1:9880")
    ap.add_argument("--breeze", default="http://127.0.0.1:7860")
    ap.add_argument("--backends", default="gsv,breeze")
    ap.add_argument("--voice-gsv", default="xiaolan")
    ap.add_argument("--voice-breeze", default="breeze")
    ap.add_argument("--text", default=TEXT)
    ap.add_argument("--profiles", default=os.path.join(ADAPTER_DIR, "profiles.json"))
    ap.add_argument("--out", default=os.path.join("F:\\qqbot\\tmp", "local-tts-verify"))
    ap.add_argument("--json", action="store_true", help="最后打一行机器可读 JSON")
    ap.add_argument("--require-gsv", action="store_true")
    ap.add_argument("--require-breeze", action="store_true")
    ap.add_argument("--timeout", type=float, default=300.0)
    a = ap.parse_args(argv)

    global OUT
    OUT = os.path.abspath(a.out)
    os.makedirs(OUT, exist_ok=True)
    want = [x.strip() for x in a.backends.split(",") if x.strip()]
    profs = load_profiles(a.profiles)
    voices = (profs.get("voices") or {})
    t_start = time.time()

    say(f"verify v2  adapter={a.adapter} gsv={a.gsv} breeze={a.breeze}")
    say(f"           out={OUT}  want={want}")
    say(f"           ffmpeg={(adapter_mod.find_ffmpeg() if adapter_mod else None)}")

    # ── [1] /health ────────────────────────────────────────────
    st, _h, body = http(a.adapter.rstrip("/") + "/health", timeout=20)
    if st != 200:
        rec(1, "adapter /health", "FAIL", f"HTTP {st} {body[:120]!r}")
        return finish(a, t_start, fatal=True)
    try:
        hl = json.loads(body)
    except Exception:  # noqa: BLE001
        rec(1, "adapter /health", "FAIL", "不是 JSON")
        return finish(a, t_start, fatal=True)
    enc = hl.get("encoder")
    bes = hl.get("backends") or {}
    detail = (f"v{hl.get('version')} encoder={enc} voices={len(hl.get('voices') or {})} "
              f"backends=" + ",".join(f"{k}:{v.get('reachable')}" for k, v in bes.items()))
    if not enc:
        rec(1, "adapter /health", "FAIL", detail + " ← 没有 mp3 编码器")
        return finish(a, t_start, fatal=True)
    rec(1, "adapter /health", "PASS", detail)

    # ── [2] 直连 gsv ───────────────────────────────────────────
    ref_path = (voices.get(a.voice_gsv) or {}).get("ref_audio_path") or ""
    if "gsv" not in want:
        rec(2, "直连 gsv POST /tts", "SKIP", "--backends 未包含 gsv")
    elif not (bes.get("gsv") or {}).get("reachable"):
        rec(2, "直连 gsv POST /tts", "FAIL" if a.require_gsv else "SKIP",
            f"{a.gsv} 无监听")
    else:
        payload = json.dumps({
            "text": a.text, "text_lang": "zh",
            "ref_audio_path": ref_path or "/tmp/ref.wav",
            "prompt_text": (voices.get(a.voice_gsv) or {}).get("prompt_text", REF_TEXT_DEFAULT),
            "prompt_lang": "zh", "text_split_method": "cut5",
            "media_type": "wav", "speed_factor": 1.0, "batch_size": 1,
            "parallel_infer": True, "streaming_mode": False,
        }, ensure_ascii=False).encode("utf-8")
        t0 = time.time()
        st, hd, body = http(a.gsv.rstrip("/") + "/tts", payload,
                            {"Content-Type": "application/json"}, "POST", a.timeout)
        ms = int((time.time() - t0) * 1000)
        ok = st == 200 and body[:4] == b"RIFF" and body[8:12] == b"WAVE"
        if ok:
            with open(os.path.join(OUT, "gsv-direct.wav"), "wb") as f:
                f.write(body)
            secs = 0.0
            try:
                with wave.open(io.BytesIO(body)) as w:
                    secs = w.getnframes() / float(w.getframerate() or 1)
            except Exception:  # noqa: BLE001
                pass
            rec(2, "直连 gsv POST /tts", "PASS",
                f"200 wav {len(body)}B {secs:.2f}s {ms}ms → gsv-direct.wav")
        else:
            rec(2, "直连 gsv POST /tts", "FAIL",
                f"HTTP {st} {ms}ms body={body[:120]!r}")

    # ── [3] 直连 breeze ────────────────────────────────────────
    bprof = voices.get(a.voice_breeze) or {}
    bref = bprof.get("ref_audio") or bprof.get("ref_audio_path") or ref_path
    if "breeze" not in want:
        rec(3, "直连 breeze /v1/audio/speech", "SKIP", "--backends 未包含 breeze")
    elif not (bes.get("breeze") or {}).get("reachable"):
        rec(3, "直连 breeze /v1/audio/speech", "FAIL" if a.require_breeze else "SKIP",
            f"{a.breeze} 无监听")
    else:
        fields: Dict[str, Any] = {
            "text": a.text, "cfg_scale": bprof.get("cfg_scale", 2.0),
            "seed": bprof.get("seed", 42),
            "ref_text": bprof.get("prompt_text", REF_TEXT_DEFAULT),
        }
        files: Dict[str, Tuple[str, bytes, str]] = {}
        if bref and os.path.isfile(bref):
            with open(bref, "rb") as f:
                files["ref_audio"] = (os.path.basename(bref), f.read(), "audio/wav")
        mbody, mct = multipart(fields, files)
        t0 = time.time()
        st, hd, body = http(a.breeze.rstrip("/") + "/v1/audio/speech", mbody,
                            {"Content-Type": mct, "Accept": "audio/pcm"}, "POST", a.timeout)
        ms = int((time.time() - t0) * 1000)
        if st == 200 and body[:4] == b"RIFF":
            with open(os.path.join(OUT, "breeze-direct.wav"), "wb") as f:
                f.write(body)
            rec(3, "直连 breeze /v1/audio/speech", "PASS",
                f"200 wav(服务器已给容器) {len(body)}B {ms}ms ref={'yes' if files else 'no'}")
        elif st == 200 and len(body) >= 4800:
            with open(os.path.join(OUT, "breeze-direct.pcm"), "wb") as f:
                f.write(body)
            secs = len(body) / 2.0 / BREEZE_PCM_RATE
            rec(3, "直连 breeze /v1/audio/speech", "PASS",
                f"200 pcm {len(body)}B ≈{secs:.2f}s@24k16bit {ms}ms "
                f"ref={'yes' if files else 'no'} → breeze-direct.pcm")
        else:
            rec(3, "直连 breeze /v1/audio/speech", "FAIL",
                f"HTTP {st} {ms}ms {len(body)}B body={body[:120]!r}")

    # ── [4] adapter → gsv ──────────────────────────────────────
    produced: List[Tuple[str, bytes, str]] = []

    def via_adapter(n: int, name: str, voice: str, backend: str) -> Optional[bytes]:
        if backend not in want:
            rec(n, name, "SKIP", f"--backends 未包含 {backend}")
            return None
        if not (bes.get(backend) or {}).get("reachable"):
            rec(n, name, "FAIL" if (a.require_gsv and backend == "gsv")
                or (a.require_breeze and backend == "breeze") else "SKIP",
                f"{backend} 上游无监听")
            return None
        payload = json.dumps({"model": "local-tts", "input": a.text, "voice": voice,
                              "response_format": "mp3", "speed": 1.0},
                             ensure_ascii=False).encode("utf-8")
        t0 = time.time()
        st, hd, body = http(a.adapter.rstrip("/") + "/v1/audio/speech", payload,
                            {"Content-Type": "application/json"}, "POST", a.timeout)
        ms = int((time.time() - t0) * 1000)
        got_be = hd.get("X-Backend", "?")
        ctype = hd.get("Content-Type", "")
        if st != 200:
            rec(n, name, "FAIL", f"HTTP {st} {ms}ms body={body[:120]!r}")
            return None
        if "audio/mpeg" not in ctype:
            rec(n, name, "FAIL", f"Content-Type={ctype!r} 不是 audio/mpeg")
            return None
        if got_be != backend:
            rec(n, name, "FAIL", f"X-Backend={got_be!r} 期望 {backend!r}")
            return None
        fn = f"adapter-{backend}.mp3"
        with open(os.path.join(OUT, fn), "wb") as f:
            f.write(body)
        produced.append((f"{backend}", body, fn))
        rec(n, name, "PASS", f"200 audio/mpeg {len(body)}B {ms}ms voice={voice} → {fn}")
        return body

    via_adapter(4, "adapter → gsv voice", a.voice_gsv, "gsv")
    # ── [5] adapter → breeze ───────────────────────────────────
    via_adapter(5, "adapter → breeze voice", a.voice_breeze, "breeze")

    # ── [6] mp3 体检 ───────────────────────────────────────────
    if not produced:
        rec(6, "mp3 体检", "FAIL" if (a.require_gsv or a.require_breeze) else "SKIP",
            "没有产出可查的 mp3")
    else:
        bad = []
        notes = []
        for tag, data, fn in produced:
            ok, why = mp3_header_ok(data)
            secs, dwhy = ffmpeg_duration(data, ".mp3")
            bitrate = (len(data) * 8 / 1000.0 / secs) if secs else 0
            notes.append(f"{tag}:{len(data)}B/{secs if secs else '?'}s/"
                         f"{bitrate:.0f}kbps/{why}")
            if not ok:
                bad.append(f"{tag} 头不对 {why}")
            if len(data) < MIN_BYTES:
                bad.append(f"{tag} {len(data)}B < 插件门槛 {MIN_BYTES}B")
            if secs and (secs < 0.2 or secs > 120):
                bad.append(f"{tag} 时长 {secs}s 不合理")
            if secs and not (8 <= bitrate <= 128):
                bad.append(f"{tag} 码率 {bitrate:.0f}kbps 不合理")
        if bad:
            rec(6, "mp3 体检", "FAIL", "; ".join(bad) + " | " + " | ".join(notes))
        else:
            rec(6, "mp3 体检", "PASS", " | ".join(notes))

    return finish(a, t_start, fatal=False)


def finish(a: Any, t_start: float, fatal: bool) -> int:
    npass = sum(1 for r in RESULTS if r["status"] == "PASS")
    nfail = sum(1 for r in RESULTS if r["status"] == "FAIL")
    nskip = sum(1 for r in RESULTS if r["status"] == "SKIP")
    secs = time.time() - t_start
    out = {"ok": nfail == 0 and not fatal, "exit": 1 if (nfail or fatal) else 0,
           "pass": npass, "fail": nfail, "skip": nskip,
           "seconds": round(secs, 2), "cases": RESULTS, "out": OUT}
    try:
        with open(os.path.join(OUT, "verify.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
    except Exception:  # noqa: BLE001
        pass
    say(f"总耗时 {secs:.2f}s  PASS={npass} FAIL={nfail} SKIP={nskip}  "
        f"exit={'1' if (nfail or fatal) else '0'}")
    say(f"产物目录 {OUT}")
    if a.json:
        say(json.dumps({"ok": out["ok"], "exit": out["exit"],
                        "statuses": [f"{r['n']}:{r['status']}" for r in RESULTS]}))
    return 1 if (nfail or fatal) else 0


if __name__ == "__main__":
    raise SystemExit(main())
