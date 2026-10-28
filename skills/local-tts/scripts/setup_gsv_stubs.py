#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地补丁：让 GPT-SoVITS 在"没有 Windows wheel + 没有 MSVC + 没有 G2PWModel"的机器上能跑中文。

做三件事（幂等，可重复执行）：
 1. 在 venv site-packages 放 pyopenjtalk 桩 —— 日文 G2P 依赖，PyPI 无 win wheel、本机无编译器。
    text/japanese.py 在 import 阶段就要 pyopenjtalk.OPEN_JTALK_DICT_DIR，缺它连中文都起不来。
    桩只保证"能导入"，中文链路用不到它；真的合成日文会抛 NotImplementedError。
 2. 放 jieba_fast 桩（转口到纯 python 的 jieba）—— PyPI 上 jieba-fast 没有 cp311 wheel，
    而 text/chinese2.py:20 是顶层 `import jieba_fast`。
 3. 把 text/chinese2.py:28 的 `is_g2pw = True` 改成 False（无 G2PWModel / 无 onnxruntime 时
    退回 polyphonic.rep + pypinyin。官方代码注释里本来就留了这条开关）。首次改动前存 .orig 备份。

    python scripts/setup_gsv_stubs.py --dry-run
    python scripts/setup_gsv_stubs.py
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys

GSV = r"F:\qqbot\.models\gpt-sovits\GPT-SoVITS-main"
VENV_SP = r"F:\qqbot\.models\gpt-sovits\.venv\Lib\site-packages"

PYOPENJTALK = '''# -*- coding: utf-8 -*-
"""pyopenjtalk 桩（local-tts 生成，非官方包）。

本机原因：PyPI 没有 Windows wheel，也没有 MSVC/cmake 可以源码编译。
中文/英文合成不会走到这里；只有 text_lang='ja' 才会调用，届时明确报错而不是静默出错。
真实安装方式：装 Visual Studio Build Tools + cmake 后 `pip install pyopenjtalk`。
"""
OPEN_JTALK_DICT_DIR = b"pyopenjtalk-stub"
__version__ = "0.0.0+localtts-stub"


def _unsupported(*_a, **_k):
    raise NotImplementedError(
        "pyopenjtalk 是本地桩：这台机器上没有编译好的 pyopenjtalk，"
        "日文合成不可用（中文/英文不受影响）。"
    )


mecab_dict_index = _unsupported
update_global_jtalk_with_user_dict = _unsupported
run_frontend = _unsupported
make_label = _unsupported
extract_fullcontext = _unsupported
tts = _unsupported


def g2p(text, kana=False, join=True):  # noqa: ARG001
    """japanese.py 里是 `pyopenjtalk.g2p(sentence)`，返回空串即可让 ja 走到空文本。"""
    return ""
'''

JIEBA_FAST_INIT = '''# -*- coding: utf-8 -*-
"""jieba_fast 桩（local-tts 生成）：PyPI 无 cp311 wheel，转口到纯 python 的 jieba。"""
import sys

import jieba as _jieba

from jieba import *  # noqa: F401,F403
from jieba import setLogLevel, cut, cut_for_search, lcut, initialize  # noqa: F401

sys.modules.setdefault(__name__ + ".posseg", __import__("jieba.posseg", fromlist=["*"]))
__version__ = "0.0.0+localtts-stub"
'''

JIEBA_FAST_POSSEG = '''# -*- coding: utf-8 -*-
"""jieba_fast.posseg 桩：直接用 jieba.posseg。"""
from jieba.posseg import *  # noqa: F401,F403
from jieba.posseg import cut, postokenize, dt, pair, POSTokenizer  # noqa: F401
'''

OLD_G2PW = "is_g2pw = True  # True if is_g2pw_str.lower() == 'true' else False"
NEW_G2PW = ("is_g2pw = False  # local-tts: 本机没有 G2PWModel/onnxruntime，"
            "退回 polyphonic.rep + pypinyin（要比原版 True 稍弱，但能跑）")


def write(path: str, content: str, dry: bool) -> str:
    exists = os.path.exists(path)
    if exists:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            cur = f.read()
        if cur == content:
            return f"skip（内容已一致） {path}"
    if dry:
        return f"would write ({len(content)}B) {path}"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    return f"{'覆盖' if exists else '新建'} {path}"


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--venv-sp", default=VENV_SP)
    ap.add_argument("--gsv", default=GSV)
    a = ap.parse_args(argv)
    dry = a.dry_run
    if not os.path.isdir(a.venv_sp):
        print(f"venv site-packages 不存在：{a.venv_sp}")
        return 2

    print(write(os.path.join(a.venv_sp, "pyopenjtalk.py"), PYOPENJTALK, dry))
    jf = os.path.join(a.venv_sp, "jieba_fast")
    print(write(os.path.join(jf, "__init__.py"), JIEBA_FAST_INIT, dry))
    print(write(os.path.join(jf, "posseg.py"), JIEBA_FAST_POSSEG, dry))

    target = os.path.join(a.gsv, "GPT_SoVITS", "text", "chinese2.py")
    if not os.path.isfile(target):
        print(f"找不到 {target}")
        return 2
    with open(target, "r", encoding="utf-8") as f:
        src = f.read()
    if NEW_G2PW.split("  #")[0] in src and "local-tts" in src:
        print(f"skip（已打过补丁） {target}")
    elif OLD_G2PW not in src:
        print(f"WARN 没找到预期的那一行，人工看一下 {target}:28")
        for i, line in enumerate(src.splitlines(), 1):
            if "is_g2pw" in line and "=" in line and not line.strip().startswith("#"):
                print(f"  {i}: {line.strip()}")
    else:
        if not dry and not os.path.exists(target + ".orig"):
            shutil.copy2(target, target + ".orig")
            print(f"备份 {target}.orig")
        new_src = src.replace(OLD_G2PW, NEW_G2PW, 1)
        if dry:
            print(f"would patch {target}:28 is_g2pw -> False")
        else:
            with open(target, "w", encoding="utf-8", newline="\n") as f:
                f.write(new_src)
            print(f"已打补丁 {target}:28 is_g2pw -> False")

    # 冒烟：这几个 import 过了才说明桩真的能用
    # 注意：沙箱里 spawn 子进程抓 stdout 会 EPERM，所以用**进程内** import 自检
    if not dry:
        print("--- 冒烟 import（本进程）---")
        venv_py = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(a.venv_sp))),
                               "Scripts", "python.exe")
        if os.path.normcase(os.path.abspath(sys.executable)) != os.path.normcase(
                os.path.abspath(venv_py)):
            print(f"（当前解释器不是 venv 的 python，跳过自检；请用 {venv_py} 再跑一次）")
            return 0
        try:
            import jieba_fast  # noqa: F401
            import jieba_fast.posseg as psg
            import pyopenjtalk

            print("pyopenjtalk", pyopenjtalk.OPEN_JTALK_DICT_DIR)
            print("jieba_fast cut", "".join(jieba_fast.cut("今天海边的风很轻")))
            print("posseg", [(w, f) for w, f in psg.cut("今天很好")][:6])
        except Exception as e:  # noqa: BLE001
            print(f"桩自检失败：{type(e).__name__}: {e}")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
