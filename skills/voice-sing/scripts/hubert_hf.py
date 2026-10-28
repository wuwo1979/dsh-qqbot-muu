# -*- coding: utf-8 -*-
"""用 HF transformers 的 HubertModel 顶替 fairseq 载入 hubert_base.pt。

为什么需要：`rvc_python` 走 `fairseq.checkpoint_utils.load_model_ensemble_and_task`
载 hubert，而本机没有完整 MSVC + Windows SDK，fairseq 0.12.2 编不出 C++ 扩展。
HF 的 HubertModel 与 fairseq HuBERT 结构一一对应，把权重转过去即可（RVC 只需要
第 12 层（v2）/ 第 9 层（v1）的隐状态）。

用法（装完 transformers 后）：
    python scripts\\hubert_hf.py            # 转换并保存到 .models\\rvc-assets\\hubert-hf
    python scripts\\hubert_hf.py --check    # 只验证能加载 + 跑一段音频
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

CKPT = Path(r"F:\qqbot\.models\rvc-assets\hubert_base.pt")
OUT = Path(r"F:\qqbot\.models\rvc-assets\hubert-hf")


def _install_fairseq_shim() -> None:
    """torch.load 这个 ckpt 会 pick 出 fairseq 的类（fairseq.data.Dictionary 等）。

    本机没有真 fairseq，就用一个万能桩顶住：任何 fairseq.* 模块/属性都返回
    一个吃不死的占位类，unpickle 时不会炸。
    """
    import importlib.machinery
    import sys
    import types

    class _Anything:
        def __init__(self, *a, **k):
            pass

        def __setstate__(self, st):
            if isinstance(st, dict):
                self.__dict__.update(st)

    class _AnyModule(types.ModuleType):
        def __getattr__(self, item):
            if item.startswith("__"):
                raise AttributeError(item)
            return _Anything

    class _Finder:
        def find_spec(self, fullname, path=None, target=None):
            if fullname == "fairseq" or fullname.startswith("fairseq."):
                return importlib.machinery.ModuleSpec(fullname, self)
            return None

        def create_module(self, spec):
            mod = _AnyModule(spec.name)
            mod.__path__ = []  # 必须像包，否则 import fairseq.data 报 "not a package"
            return mod

        def exec_module(self, module):
            pass

    sys.meta_path.insert(0, _Finder())


def convert(ckpt: Path = CKPT, out: Path = OUT) -> Path:
    import torch
    from transformers import HubertConfig, HubertModel

    print(f"读 {ckpt} ...", flush=True)
    _install_fairseq_shim()
    state = torch.load(ckpt, map_location="cpu", weights_only=False)
    if "model" in state and isinstance(state["model"], dict):
        weights = state["model"]
    else:
        weights = state
    cfg_d = state.get("cfg", {}).get("model", {}) if isinstance(state, dict) else {}
    print("fairseq cfg keys:", sorted(cfg_d)[:12], flush=True)

    # HuBERT-base 的结构参数（与 fairseq hubert_base 一致）
    config = HubertConfig(
        hidden_size=768,
        num_hidden_layers=12,
        num_attention_heads=12,
        intermediate_size=3072,
        conv_dim=[512] * 7,
        conv_kernel=[10, 3, 3, 3, 3, 2, 2],
        conv_stride=[5, 2, 2, 2, 2, 2, 2],
        feat_extract_norm="group",
        do_stable_layer_norm=False,
        activation_dropout=0.1,
        layerdrop=0.0,
        final_dropout=0.1,
        num_conv_pos_embedding_groups=16,
        num_conv_pos_embeddings=128,
    )
    model = HubertModel(config)

    def remap(w):
        new = {}
        for k, v in w.items():
            key = k
            if key.startswith("model."):
                key = key[len("model."):]
            if key.startswith("label_embs_concat") or key.startswith("encoder.version"):
                continue
            # feature extractor: fairseq ConvFeatureExtractionModel -> HF
            if key.startswith("feature_extractor.conv_layers."):
                parts = key.split(".")
                # feature_extractor.conv_layers.0.0.weight -> conv_layers.0.conv.weight
                rest = parts[3:]
                idx = parts[2]
                if rest[:1] == ["0"]:
                    key = f"hubert.feature_extractor.conv_layers.{idx}.conv.{rest[-1]}"
                elif rest[:1] == ["2"]:
                    key = f"hubert.feature_extractor.conv_layers.{idx}.layer_norm.{rest[-1]}"
                else:
                    continue
            elif key == "post_extract_proj.weight" or key == "post_extract_proj.bias":
                key = "hubert.feature_projection.projection." + key.split(".")[-1]
            elif key == "layer_norm.weight" or key == "layer_norm.bias":
                key = "hubert.feature_projection.layer_norm." + key.split(".")[-1]
            elif key.startswith("encoder.pos_conv."):
                key = "hubert.encoder.pos_conv_embed.conv." + key.split(".")[-1]
            elif key == "encoder.layer_norm.weight" or key == "encoder.layer_norm.bias":
                key = "hubert.encoder.layer_norm." + key.split(".")[-1]
            elif key.startswith("encoder.layers."):
                p = key.split(".")
                i, field = p[2], p[3]
                tail = ".".join(p[4:])
                if field == "self_attn":
                    key = f"hubert.encoder.layers.{i}.attention.{tail}"
                elif field == "self_attn_layer_norm":
                    # 非 stable-layer-norm 的 HubertModel 里，这个 LN 对应 layer_norm
                    #（stable（large）版本才叫 attention_layer_norm）
                    key = f"hubert.encoder.layers.{i}.layer_norm.{tail}"
                elif field == "fc1":
                    key = f"hubert.encoder.layers.{i}.feed_forward.intermediate_dense.{tail}"
                elif field == "fc2":
                    key = f"hubert.encoder.layers.{i}.feed_forward.output_dense.{tail}"
                elif field == "final_layer_norm":
                    key = f"hubert.encoder.layers.{i}.final_layer_norm.{tail}"
                else:
                    continue
            elif key.startswith("final_proj."):
                key = "final_proj." + key.split(".")[-1]
            else:
                continue
            new[key] = v
        # load_state_dict 的目标就是 HubertModel 本身，键不能再带 "hubert." 前缀
        new = {(k[len("hubert."):] if k.startswith("hubert.") else k): v
               for k, v in new.items()}
        return new

    hf_state = remap(weights)
    missing, unexpected = model.load_state_dict(hf_state, strict=False)
    print(f"载入权重: {len(hf_state)} 项, missing={len(missing)}, "
          f"unexpected={len(unexpected)}", flush=True)
    if missing:
        print("  missing 示例:", missing[:6])
    if unexpected:
        print("  unexpected 示例:", unexpected[:6])
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out)
    print(f"已保存 HF hubert: {out}", flush=True)
    return out


class HubertHF:
    """模仿 fairseq HuBERT 的最小接口，供 patch 后的 load_hubert 使用。"""

    def __init__(self, path: Path = OUT, device: str = "cuda:0", half: bool = True):
        import torch
        from transformers import HubertModel

        self.torch = torch
        self.model = HubertModel.from_pretrained(str(path)).eval()
        self.device = device
        if half and device != "cpu":
            self.model = self.model.half()
        self.model = self.model.to(device)

    def to(self, device):
        self.device = device
        self.model = self.model.to(device)
        return self

    def half(self):
        self.model = self.model.half()
        return self

    def float(self):
        self.model = self.model.float()
        return self

    def eval(self):
        self.model.eval()
        return self

    def extract_features(self, source, padding_mask=None, output_layer=12,
                         mask=False, ret_conv=False):
        torch = self.torch
        with torch.no_grad():
            out = self.model(source, output_hidden_states=True)
        h = out.hidden_states[int(output_layer)]
        return (h, padding_mask)


def check() -> int:
    import numpy as np
    import torch

    if not (OUT / "config.json").exists():
        convert()
    hb = HubertHF(device="cpu", half=False)
    wav = np.sin(2 * np.pi * 220 * np.arange(16000 * 2) / 16000).astype("float32")
    src = torch.from_numpy(wav).view(1, -1)
    pm = torch.zeros(src.shape, dtype=torch.bool)
    feats, _ = hb.extract_features(source=src, padding_mask=pm, output_layer=12)
    print("feats:", tuple(feats.shape), feats.dtype, float(feats.abs().mean()))
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    sys.exit(check() if a.check else (convert() and 0) or 0)
