# -*- coding: utf-8 -*-
"""唱歌链路一键跑：demucs 拆人声/伴奏 → RVC 换声 → ffmpeg 混成 mp3。

必须在 F:\\qqbot\\.models\\voice-sing-venv 的 python 下跑（要 torch/demucs/rvc_python）：

    F:\\qqbot\\.models\\voice-sing-venv\\Scripts\\python.exe scripts\\demo_pipeline.py ^
        --song F:\\qqbot\\tmp\\sing-demo2\\song.wav ^
        --voice luomi=F:\\qqbot\\.models\\rvc-voices\\sucrose-luomi\\sucrose_e100_s5400.pth^
               |=F:\\qqbot\\.models\\rvc-voices\\sucrose-luomi\\added_IVF902_Flat_nprobe_1_sucrose_v2.index ^
        --voice asa=F:\\qqbot\\.models\\rvc-voices\\raiden-asa\\ei_raiden_e110_s5060.pth ^
        --pitch luomi=0 --pitch asa=-2 ^
        --out-prefix F:\\qqbot\\tmp\\sing-demo

显存：6GB 卡上 demucs 与 RVC 都要吃显存，**先 `ollama stop` 掉常驻模型**再跑；
--segment 7 给 demucs 降峰值（RVC 本身显存占用很小）。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

FFMPEG = Path(r"F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe")
ASSETS = Path(r"F:\qqbot\.models\rvc-assets")


def run(args, log_path, timeout=5400):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    # RVC 的 faiss 索引 + torch 在 Windows 上会 OpenMP 死锁（表现为几十秒的音频跑十几分钟、
    # GPU 30% 空转）；把 OpenMP 线程限到 1 即可，实测 10s 音频 11s 出结果。
    env.setdefault("OMP_NUM_THREADS", "1")
    env.setdefault("MKL_NUM_THREADS", "1")
    env.setdefault("HF_HOME", r"F:\qqbot\tmp\hf-cache")
    # demucs 的权重默认下到 C:\Users\...\.cache\torch（沙箱不可写 → PermissionError），
    # 指到仓库内目录，权重用 scripts\dl.py 预先下好。
    env.setdefault("TORCH_HOME", r"F:\qqbot\tmp\torch-home")
    with open(log_path, "ab") as fh:
        fh.write(f"\n\n===== {' '.join(map(str, args))} =====\n".encode("utf-8"))
        fh.flush()
        cp = subprocess.run([str(a) for a in args], stdout=fh, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, env=env, timeout=timeout)
    print(f"  -> rc={cp.returncode} (log {log_path})", flush=True)
    return cp.returncode


def to_wav(src: Path, dst: Path, sr=44100, mono=True):
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vn",
           "-ar", str(sr)]
    if mono:
        cmd += ["-ac", "1"]
    cmd += ["-c:a", "pcm_s16le", dst]
    subprocess.run([str(c) for c in cmd], check=True, stdin=subprocess.DEVNULL)


def probe_seconds(path: Path) -> float:
    cp = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)],
                        capture_output=True, text=True, errors="replace")
    for line in (cp.stderr or "").splitlines():
        if "Duration:" in line:
            hh, mm, ss = line.split("Duration:")[1].split(",")[0].strip().split(":")
            return int(hh) * 3600 + int(mm) * 60 + float(ss)
    return 0.0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", required=True)
    ap.add_argument("--voice", action="append", default=[], help="名字=模型.pth[|索引.index]")
    ap.add_argument("--pitch", action="append", default=[], help="名字=半音")
    ap.add_argument("--out-prefix", default=r"F:\qqbot\tmp\sing-demo")
    ap.add_argument("--workdir", default=r"F:\qqbot\tmp\sing-demo-work")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--segment", type=int, default=7, help="demucs 分段长度（6GB 卡用 7）")
    ap.add_argument("--skip-demucs", action="store_true")
    args = ap.parse_args(argv)

    song = Path(args.song)
    work = Path(args.workdir)
    work.mkdir(parents=True, exist_ok=True)
    log = work / "pipeline.log"
    py = sys.executable

    # ---- 1. demucs 拆人声 ----
    stems = work / "htdemucs" / song.stem
    vocals = stems / "vocals.wav"
    inst = stems / "no_vocals.wav"
    if not args.skip_demucs or not vocals.exists():
        print("[1/3] demucs 拆人声 ...", flush=True)
        rc = run([py, "-m", "demucs", "-n", "htdemucs", "--two-stems", "vocals",
                  "--segment", str(args.segment), "-o", work, song], log)
        if rc != 0 or not vocals.exists():
            print("  demucs 失败，退化为整段当人声（伴奏为空）")
            vocals.parent.mkdir(parents=True, exist_ok=True)
            to_wav(song, vocals)
            inst = None
    print(f"  人声: {vocals} ({probe_seconds(vocals):.2f}s)", flush=True)
    if inst and inst.exists():
        print(f"  伴奏: {inst} ({probe_seconds(inst):.2f}s)", flush=True)

    # ---- 2. RVC 换声 ----
    pitches = dict(x.split("=", 1) for x in args.pitch)
    outs = []
    for spec in args.voice:
        name, rest = spec.split("=", 1)
        model, _, index = rest.partition("|")
        dst = work / f"conv-{name}.wav"
        pitch = pitches.get(name, "0")
        print(f"[2/3] RVC 换声 {name} (pitch={pitch}) ...", flush=True)
        cmd = [py, "-m", "rvc_python", "cli",
               "-i", str(vocals), "-o", str(dst), "-mp", model,
               "-de", args.device, "-me", "rmvpe", "-pi", pitch,
               "-ir", "0.6", "-fr", "3", "-rmr", "0.25", "-pr", "0.5"]
        if index:
            cmd += ["-ip", index]
        rc = run(cmd, log)
        if rc != 0 or not dst.exists():
            print(f"  {name} 换声失败，见日志 {log}")
            continue
        outs.append((name, dst))
        print(f"  -> {dst} ({probe_seconds(dst):.2f}s)", flush=True)

    # ---- 3. 混音 ----
    made = []
    for name, vocal in outs:
        out = Path(f"{args.out_prefix}-{name}.mp3")
        print(f"[3/3] 混音 {name} -> {out}", flush=True)
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", vocal]
        if inst and inst.exists():
            # 伴奏压到 -3dB 给人声让位；人声 mono 上抬成立体声，避免 amix 退化成单声道
            cmd += ["-i", inst, "-filter_complex",
                    "[0:a]aformat=channel_layouts=stereo,volume=1.0[v];"
                    "[1:a]aformat=channel_layouts=stereo,volume=0.7[i];"
                    "[v][i]amix=inputs=2:duration=shortest:normalize=0[out]",
                    "-map", "[out]"]
        else:
            cmd += ["-af", "aformat=channel_layouts=stereo"]
        cmd += ["-ar", "44100", "-b:a", "192k", str(out)]
        cp = subprocess.run([str(c) for c in cmd], stdin=subprocess.DEVNULL,
                            capture_output=True)
        if cp.returncode != 0:
            print("  混音失败:", cp.stderr.decode("utf-8", "replace")[-600:])
            continue
        made.append(out)
        print(f"  成品: {out} ({probe_seconds(out):.2f}s, "
              f"{out.stat().st_size / 1024:.0f}KB)", flush=True)

    print("\n产出:")
    for p in made:
        print(" ", p)
    return 0 if made else 1


if __name__ == "__main__":
    raise SystemExit(main())
