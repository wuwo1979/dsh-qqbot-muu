#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
sd_server.py — 本地文生图微服务（给 qqbot 的 draw 工具用）

两种模型都吃：
  · 单文件 SD1.5 动漫模型（.safetensors，Counterfeit / Anything / MeinaMix …）
    → from_single_file，20~26 步、CFG 7、DPM-Solver++，512px 约 2~4 秒，画质正常
  · 目录式 sd-turbo（fp16 diffusers 目录）
    → from_pretrained，2 步、CFG 0，糊但极快

为什么是"常驻小服务"而不是"每张图起一个进程"：
    diffusers 载模型要 10~20 秒（哪怕有 GPU），每张图重开进程太亏；
    常驻后第一张 = 载模型一次，之后每张 2~4 秒。

接口（只监听 127.0.0.1）：
    GET  /health → {"ok":true,"model":…,"kind":"single-file|pipeline","device":…,
                    "loaded":true,"steps":24,"cfg":7}
    POST /draw {"prompt":…,"negative":…,"width":512,"height":512,"steps":24,"cfg":7,
                "seed":0,"out":"D:/…/x.png"} → {"ok":true,"path":…,"ms":…,"seed":…}
    GET  /stop   → 进程退出

跑法：
    python sd_server.py --model F:/qqbot/.models/counterfeit3/Counterfeit-V3.0_fix_fp16.safetensors --port 7861
"""
import argparse
import json
import os
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image

# ── HuggingFace 缓存重定向（必须在 diffusers / huggingface_hub 被 import 之前设置）──
# 沙箱拒绝写 C:\Users\…\.cache\huggingface，而且 from_single_file 会去拉 SD1.5 的
# 11 个 config/tokenizer 文件；默认路径不可写时会卡住直到超时（真机踩过）。
_HF_HOME = os.environ.get("QQBOT_HF_HOME") or "F:/qqbot/.hf"
os.environ.setdefault("HF_HOME", _HF_HOME)
os.environ.setdefault("HF_HUB_CACHE", os.path.join(_HF_HOME, "hub"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
if os.environ.get("QQBOT_HF_ONLINE") != "1":
    # 只认本地缓存，绝不联网（config 已经落在本地，见 --sd-config）
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

# 默认负面提示词：SD1.5 动漫模型不加这段，十指/眼睛/线条容易崩
DEFAULT_NEGATIVE = (
    "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, "
    "fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, "
    "signature, watermark, username, blurry, ugly, deformed, extra limbs"
)

STATE = {
    "pipe": None,
    "img2img": None,
    "model": "",
    "kind": "",
    "device": "cpu",
    "loaded": False,
    "error": "",
    "lock": threading.Lock(),
    "outdir": "",
    "steps": 24,
    "cfg": 7.0,
    "negative": DEFAULT_NEGATIVE,
    "loras": [],
    "vae": "",
    "lowvram": False,
}


def log(msg):
    sys.stderr.write("[sd] " + str(msg) + "\n")
    sys.stderr.flush()


def is_single_file(model_path):
    if os.path.isfile(model_path):
        return True
    if os.path.isdir(model_path):
        for name in os.listdir(model_path):
            if name.endswith(".safetensors") or name.endswith(".ckpt"):
                return True
        if os.path.exists(os.path.join(model_path, "model_index.json")):
            return False
    return False


def load_pipeline(model_path, device_pref="auto", sd_config="", vae_path="", lowvram=False, loras=None):
    import torch
    from diffusers import AutoPipelineForText2Image, AutoPipelineForImage2Image

    device = "cpu"
    dtype = torch.float32
    if device_pref in ("auto", "cuda") and torch.cuda.is_available():
        device = "cuda"
        dtype = torch.float16

    single = is_single_file(model_path)
    if single and os.path.isdir(model_path):
        # 目录里挑一个权重文件
        cands = [n for n in os.listdir(model_path) if n.endswith(".safetensors") or n.endswith(".ckpt")]
        cands.sort()
        model_path = os.path.join(model_path, cands[0])

    # turbo / lcm / lightning 这类蒸馏模型：步数少、CFG 0
    low = str(model_path).lower()
    turbo = ("turbo" in low) or ("lcm" in low) or ("lightning" in low)

    log("loading %s on %s (%s, single_file=%s, turbo=%s)" % (model_path, device, dtype, single, turbo))
    t0 = time.time()
    if single:
        # 单文件权重：不同 diffusers 版本挂 from_single_file 的类不一样
        # （0.41 里 AutoPipelineForText2Image 没有，StableDiffusionPipeline 有），逐个试。
        pipe = None
        errs = []
        for name in ("AutoPipelineForText2Image", "StableDiffusionPipeline", "StableDiffusionXLPipeline"):
            cls = globals().get(name)
            if cls is None:
                try:
                    import diffusers as _d
                    cls = getattr(_d, name, None)
                except Exception:
                    cls = None
            fn = getattr(cls, "from_single_file", None) if cls is not None else None
            if fn is None:
                continue
            try:
                kw = {"torch_dtype": dtype, "safety_checker": None}
                if sd_config and os.path.isdir(sd_config):
                    # 用本地 SD1.5 配置目录当模板，绝不联网（config 含 model_index/unet/vae/text_encoder/tokenizer）
                    kw["config"] = sd_config
                    kw["local_files_only"] = True
                pipe = fn(model_path, **kw)
                log("loaded single file via %s.from_single_file" % name)
                break
            except Exception as e:
                errs.append("%s: %r" % (name, e))
        if pipe is None:
            raise RuntimeError("没有可用的 from_single_file（失败：%s）" % "; ".join(errs[:3]))
    else:
        pipe = AutoPipelineForText2Image.from_pretrained(
            model_path,
            torch_dtype=dtype,
            variant=("fp16" if dtype == torch.float16 else None),
            safety_checker=None,
            local_files_only=True,
        )
    # 外挂 VAE / LoRA：6GB 卡上最划算的“画质升级”手段（不用换底座模型）
    if vae_path and os.path.isfile(vae_path):
        try:
            from diffusers import AutoencoderKL
            try:
                pipe.vae = AutoencoderKL.from_single_file(vae_path, torch_dtype=dtype)
                log("vae loaded (single file): %s" % vae_path)
            except Exception:
                pipe.vae = AutoencoderKL.from_pretrained(vae_path, torch_dtype=dtype, local_files_only=True)
                log("vae loaded (diffusers dir): %s" % vae_path)
        except Exception as e:
            log("vae load failed: %r" % (e,))

    for item in (loras or []):
        path = str(item.get("path") or "")
        weight = float(item.get("weight") or 0.8)
        if not path or not os.path.isfile(path):
            log("lora skipped (missing): %s" % path)
            continue
        try:
            name = "lora%d" % len(STATE["loras"])
            pipe.load_lora_weights(path, adapter_name=name)
            STATE["loras"].append({"name": name, "path": path, "weight": weight})
            log("lora loaded: %s @%.2f" % (path, weight))
        except Exception as e:
            log("lora load failed: %r" % (e,))
    if STATE["loras"]:
        try:
            pipe.set_adapters([x["name"] for x in STATE["loras"]], adapter_weights=[x["weight"] for x in STATE["loras"]])
        except Exception as e:
            log("set_adapters failed: %r" % (e,))

    if lowvram and device == "cuda":
        try:
            pipe.enable_model_cpu_offload()
            log("lowvram: enable_model_cpu_offload")
        except Exception as e:
            log("offload failed, fallback to .to(%s): %r" % (device, e))
            pipe = pipe.to(device)
    else:
        pipe = pipe.to(device)

    if not turbo:
        # 20 步左右就能到位的 DPM-Solver++（比默认 PNDM 快且稳）
        try:
            from diffusers import DPMSolverMultistepScheduler
            pipe.scheduler = DPMSolverMultistepScheduler.from_config(
                pipe.scheduler.config, use_karras_sigmas=True, algorithm_type="dpmsolver++"
            )
        except Exception as e:
            log("scheduler swap failed: %r" % (e,))

    try:
        pipe.set_progress_bar_config(disable=True)
    except Exception:
        pass
    try:
        pipe.unet.to(memory_format=torch.channels_last)
    except Exception:
        pass
    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass

    STATE["pipe"] = pipe
    STATE["model"] = model_path.replace("\\", "/")
    STATE["kind"] = "single-file" if single else "pipeline"
    STATE["device"] = device
    STATE["loaded"] = True
    STATE["steps"] = 2 if turbo else 24
    STATE["cfg"] = 0.0 if turbo else 7.0
    log("loaded in %.1fs (steps=%s cfg=%s)" % (time.time() - t0, STATE["steps"], STATE["cfg"]))
    return pipe


def do_draw(req):
    import torch

    pipe = STATE["pipe"]
    if pipe is None:
        raise RuntimeError("模型还没加载好")

    prompt = str(req.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt 为空")
    width = max(256, min(1024, int(req.get("width") or 512)))
    height = max(256, min(1024, int(req.get("height") or 512)))
    steps = max(1, min(40, int(req.get("steps") or STATE["steps"])))
    cfg = float(req.get("cfg") if req.get("cfg") is not None else STATE["cfg"])
    seed = int(req.get("seed") or 0)
    if seed <= 0:
        seed = random.randint(1, 2 ** 31 - 1)
    negative = str(req.get("negative") if req.get("negative") is not None else STATE["negative"])
    out = str(req.get("out") or "").strip()
    init_image = str(req.get("init_image") or "").strip()
    strength = max(0.1, min(0.95, float(req.get("strength") if req.get("strength") is not None else 0.6)))

    gen = torch.Generator(device="cpu").manual_seed(seed)
    t0 = time.time()
    with torch.inference_mode():
        if init_image and os.path.isfile(init_image):
            if STATE["img2img"] is None:
                from diffusers import AutoPipelineForImage2Image as _I2I
                STATE["img2img"] = _I2I.from_pipe(pipe)
            base_img = Image.open(init_image).convert("RGB").resize((width, height))
            img = STATE["img2img"](
                prompt=prompt,
                image=base_img,
                strength=strength,
                num_inference_steps=steps,
                guidance_scale=cfg,
                generator=gen,
                negative_prompt=(negative or None),
            ).images[0]
        else:
            img = pipe(
                prompt=prompt,
                width=width,
                height=height,
                num_inference_steps=steps,
                guidance_scale=cfg,
                generator=gen,
                negative_prompt=(negative or None),
            ).images[0]
    ms = int((time.time() - t0) * 1000)

    if not out:
        os.makedirs(STATE["outdir"], exist_ok=True)
        out = os.path.join(STATE["outdir"], "draw-%d-%d.png" % (int(time.time()), seed))
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    img.save(out, format="PNG")
    return {"ok": True, "path": out.replace("\\", "/"), "ms": ms, "seed": seed,
            "width": width, "height": height, "steps": steps, "cfg": cfg}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 静音默认访问日志
        pass

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {
                "ok": True,
                "model": STATE["model"],
                "kind": STATE["kind"],
                "device": STATE["device"],
                "loaded": STATE["loaded"],
                "error": STATE["error"],
                "steps": STATE["steps"],
                "cfg": STATE["cfg"],
                "vae": STATE["vae"],
                "lowvram": STATE["lowvram"],
                "loras": STATE["loras"],
            })
        if self.path.startswith("/stop"):
            self._send(200, {"ok": True})
            threading.Timer(0.3, lambda: os._exit(0)).start()
            return
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/draw"):
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            req = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            return self._send(400, {"ok": False, "error": "bad json: %s" % e})
        try:
            with STATE["lock"]:  # GPU 一次只画一张
                res = do_draw(req)
            return self._send(200, res)
        except Exception as e:
            log("draw failed: %r" % (e,))
            return self._send(500, {"ok": False, "error": str(e)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--port", type=int, default=7861)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--outdir", default="")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--sd-config", default=os.environ.get("QQBOT_SD_CONFIG", "F:/qqbot/.models/sd15-config"))
    ap.add_argument("--vae", default="")
    ap.add_argument("--lowvram", action="store_true")
    ap.add_argument("--lora", action="append", default=[], help="LoRA 路径[ @权重 ]，可重复")
    args = ap.parse_args()

    STATE["model"] = args.model
    STATE["outdir"] = args.outdir or os.path.join(os.path.dirname(args.model) or ".", "draws")
    STATE["vae"] = args.vae
    STATE["lowvram"] = bool(args.lowvram)
    loras = []
    for raw in (args.lora or []):
        text = str(raw).strip()
        if not text:
            continue
        if "@" in text:
            path, weight = text.rsplit("@", 1)
            try:
                weight = float(weight)
            except Exception:
                weight = 0.8
        else:
            path, weight = text, 0.8
        loras.append({"path": path.strip(), "weight": weight})

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log("listening on http://%s:%d" % (args.host, args.port))
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        load_pipeline(args.model, args.device, args.sd_config, args.vae, bool(args.lowvram), loras)
    except Exception as e:
        STATE["error"] = str(e)
        log("load failed: %r" % (e,))
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
