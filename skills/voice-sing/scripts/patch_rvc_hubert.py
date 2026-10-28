# -*- coding: utf-8 -*-
"""给装好的 rvc_python 打补丁：hubert 载入先试 fairseq，失败自动退到 HF transformers。

背景：`rvc_python.modules.vc.utils.load_hubert` 硬依赖
`fairseq.checkpoint_utils.load_model_ensemble_and_task`，而本机 MSVC/SDK 不全，
fairseq 0.12.2 编不出 C++ 扩展。这里把它改成「fairseq 优先，HF 兜底」，
同时给 `rvc_python.lib.jit.get_hubert` 需要的最小 fairseq 模块做桩，避免 import 期就炸。

用法：python scripts\\patch_rvc_hubert.py [--venv <venv目录>]
可重复执行（幂等，第二次会覆盖回同一份内容）。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_VENV = Path(r"F:\qqbot\.models\voice-sing-venv")
HF_SCRIPT = Path(r"F:\qqbot\skills\voice-sing\scripts\hubert_hf.py")

UTILS_PATCHED = '''import os
import sys

# ---- 本机补丁：fairseq 装不上时用 HF transformers 的 HuBERT 顶替 ----
# 原始实现只认 fairseq.checkpoint_utils.load_model_ensemble_and_task。
_HF_FALLBACK = None


def _hf_hubert(config):
    global _HF_FALLBACK
    if _HF_FALLBACK is None:
        scripts = r"{hf_script_dir}"
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        from hubert_hf import HubertHF  # noqa: WPS433
        _HF_FALLBACK = HubertHF
    return _HF_FALLBACK(device=config.device, half=getattr(config, "is_half", False))


def get_index_path_from_model(sid):
    return next(
        (
            f
            for f in [
                os.path.join(root, name)
                for root, _, files in os.walk(os.getenv("index_root"), topdown=False)
                for name in files
                if name.endswith(".index") and "trained" not in name
            ]
            if sid.split(".")[0] in f
        ),
        "",
    )


def load_hubert(config, lib_dir):
    ckpt = f"{{lib_dir}}/base_model/hubert_base.pt"
    try:
        from fairseq import checkpoint_utils

        models, _, _ = checkpoint_utils.load_model_ensemble_and_task([ckpt], suffix="")
        hubert_model = models[0]
        hubert_model = hubert_model.to(config.device)
        if config.is_half:
            hubert_model = hubert_model.half()
        else:
            hubert_model = hubert_model.float()
        return hubert_model.eval()
    except Exception as exc:  # noqa: BLE001
        print(f"[voice-sing] fairseq 不可用({{exc!r}})，改用 HF HuBERT", flush=True)
        return _hf_hubert(config).eval()
'''

FAIRSEQ_STUB_INIT = '''"""最小 fairseq 桩：本机装不了 fairseq 0.12.2（无 MSVC/SDK）。

只提供 rvc_python 在 import 期需要的东西：
- fairseq.utils.index_put
- fairseq.checkpoint_utils.load_model_ensemble_and_task（调用即报错，提示走 HF 兜底）
"""
__all__ = ["utils", "checkpoint_utils"]
'''

FAIRSEQ_STUB_UTILS = '''import torch


def index_put(x, indices, vals):
    """fairseq.utils.index_put 的最小等价实现（只在 hubert 前向里用）。"""
    x = x.clone()
    x[indices] = vals
    return x
'''

FAIRSEQ_STUB_CKPT = '''def load_model_ensemble_and_task(filenames, arg_overrides=None, task=None, suffix=""):
    raise RuntimeError(
        "本机没有可用的 fairseq（缺 MSVC/SDK，0.12.2 无法编译）。"
        "请走 skills/voice-sing/scripts/hubert_hf.py 的 HF HuBERT 兜底路径。"
    )
'''


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == text:
        print(f"  已是目标内容: {path.name}")
        return
    path.write_text(text, encoding="utf-8")
    print(f"  已写: {path}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--venv", default=str(DEFAULT_VENV))
    a = ap.parse_args(argv)
    site = Path(a.venv) / "Lib" / "site-packages"
    pkg = site / "rvc_python"
    if not (pkg / "modules" / "vc" / "utils.py").exists():
        print(f"没找到 rvc_python: {pkg}，先 pip install rvc-python")
        return 2

    print("[1/2] 补丁 modules/vc/utils.py")
    write(pkg / "modules" / "vc" / "utils.py",
          UTILS_PATCHED.format(hf_script_dir=str(HF_SCRIPT.parent)))

    print("[2/2] 放 fairseq 桩（不让 import 期炸）")
    fs = site / "fairseq"
    write(fs / "__init__.py", FAIRSEQ_STUB_INIT)
    write(fs / "utils.py", FAIRSEQ_STUB_UTILS)
    write(fs / "checkpoint_utils.py", FAIRSEQ_STUB_CKPT)
    print("完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
