# -*- coding: utf-8 -*-
"""装 RVC 推理依赖（不用 PIPE：每步 stdout/stderr 直接写日志文件）。

用法: python install_rvc_deps.py [step ...]
步骤:
  torch      装本地 torch/torchaudio cu118 wheel（已下好）
  fairseq    试装 fairseq 0.12.2（无依赖），失败就记录原因
  deps       装 rvc-python / demucs 及其余依赖（清华源）
  verify     自检 torch.cuda / rvc_python 能否 import
"""
import os
import subprocess
import sys
from pathlib import Path

VENV = Path(r"F:\qqbot\.models\voice-sing-venv")
PY = VENV / "Scripts" / "python.exe"
WHEELS = Path(r"F:\qqbot\tmp\wheels")
LOGDIR = Path(r"F:\qqbot\tmp")
TUNA = "https://pypi.tuna.tsinghua.edu.cn/simple"


def run(args, log_name, timeout=3600, env_extra=None):
    log = LOGDIR / log_name
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    env.update(env_extra or {})
    with open(log, "ab") as fh:
        fh.write(f"\n\n===== {' '.join(map(str, args))} =====\n".encode("utf-8"))
        fh.flush()
        cp = subprocess.run([str(a) for a in args], stdout=fh, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, env=env, timeout=timeout)
    tail = ""
    try:
        raw = log.read_bytes().decode("utf-8", "replace").splitlines()
        tail = "\n".join(raw[-6:])
    except OSError:
        pass
    print(f"[{log_name}] rc={cp.returncode}\n{tail}", flush=True)
    return cp.returncode


def pip(*args, log, timeout=3600):
    return run([PY, "-m", "pip", "install", "--no-cache-dir", *args],
               log, timeout=timeout)


def step_torch():
    tw = next(WHEELS.glob("torch-2.1.1+cu118-cp311-cp311-win_amd64.whl"), None)
    aw = next(WHEELS.glob("torchaudio-2.1.1+cu118-cp311-cp311-win_amd64.whl"), None)
    if not tw or not aw:
        print("缺 wheel:", tw, aw)
        return 1
    rc = pip(str(tw), "--no-deps", log="rvc-torch-install.log")
    pip(str(aw), "--no-deps", log="rvc-torch-install.log")
    return rc


def step_fairseq():
    pip("Cython<3", "numpy==1.23.5", log="rvc-fairseq.log")
    rc = pip("fairseq==0.12.2", "--no-deps", "--no-build-isolation",
             log="rvc-fairseq.log", timeout=2400)
    return rc


def step_deps():
    # demucs 与 rvc-python 一起装；rvc-python 若因 fairseq 失败，允许 --no-deps
    rc = pip("demucs", "-i", TUNA, log="rvc-deps.log", timeout=3600)
    rc2 = pip("rvc-python", "-i", TUNA, log="rvc-deps.log", timeout=3600)
    if rc2 != 0:
        print("rvc-python 带依赖失败，退回 --no-deps + 手工依赖")
        pip("rvc-python", "--no-deps", "-i", TUNA, log="rvc-deps.log")
        pip("faiss-cpu==1.7.3", "torchcrepe", "praat-parselmouth", "soundfile", "av",
            "loguru", "omegaconf==2.0.6", "ffmpeg-python", "fastapi", "uvicorn",
            "pydantic", "requests", "tqdm", "pyworld", "torchaudio2", "-i", TUNA,
            log="rvc-deps2.log", timeout=3600)
    return rc2


def step_verify():
    code = (
        "import torch, torchaudio;"
        "print('torch', torch.__version__, torch.cuda.is_available(),"
        " torch.cuda.get_device_name(0) if torch.cuda.is_available() else '');"
        "print('torchaudio', torchaudio.__version__);"
        "import rvc_python; print('rvc_python ok', rvc_python.__file__);"
        "import demucs; print('demucs ok')"
    )
    return run([PY, "-c", code], "rvc-verify.log", timeout=600)


STEPS = {"torch": step_torch, "fairseq": step_fairseq, "deps": step_deps,
         "verify": step_verify}

if __name__ == "__main__":
    names = sys.argv[1:] or ["torch"]
    bad = 0
    for name in names:
        print(f"---- step {name} ----", flush=True)
        if STEPS[name]() != 0:
            bad += 1
    print("failed steps:", bad, flush=True)
    raise SystemExit(0)
