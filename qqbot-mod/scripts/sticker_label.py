#!/usr/bin/env python
"""给表情库补标签：qwen2.5vl:3b 逐张看，写回 index.json。

为什么还要预处理：Ollama 的 qwen2.5vl 对带 ICC/EXIF 的 JPEG、以及边长 >512 的图
会退化成输出一串 `@`（实测 1264px JPEG 必现）。这里统一转 RGB、缩到 384、丢掉
元数据再发，稳定出中文标签。

用法：
  E:\\Anaconda\\python.exe sticker_label.py --limit 3            # 只看，不写
  E:\\Anaconda\\python.exe sticker_label.py --limit 3 --apply    # 写回（自动备份）
  ... --limit 0 --apply                                        # 全部未打标
"""
import argparse
import base64
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.request

from PIL import Image

PROMPT = (
    '这是一张QQ表情包。用4到8个中文词或短语描述：先写情绪（如开心/无语/震惊/委屈），'
    '再写画面主体和动作。只输出词，用中文逗号分隔，不要解释、不要编号、不要句号。'
)


def ask(img_bytes, base, model, timeout):
    body = {
        'model': model,
        'prompt': PROMPT,
        'images': [base64.b64encode(img_bytes).decode()],
        'stream': False,
        'options': {
            'temperature': 0.2,
            'repeat_penalty': 1.15,
            'num_predict': 100,
            'num_ctx': 8192,
        },
    }
    req = urllib.request.Request(
        base.rstrip('/') + '/api/generate',
        data=json.dumps(body).encode(),
        headers={'content-type': 'application/json'},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.loads(r.read().decode())
    return (j.get('response') or '').strip(), int((time.time() - t0) * 1000)


def clean_image(path, max_side=384):
    im = Image.open(path)
    if im.mode != 'RGB':
        im = im.convert('RGB')
    im.thumbnail((max_side, max_side), Image.LANCZOS)
    flat = Image.new('RGB', im.size, (255, 255, 255))
    flat.paste(im, (0, 0))
    flat.info.clear()
    buf = io.BytesIO()
    flat.save(buf, 'PNG')
    return buf.getvalue(), flat.size


def parse_tags(raw):
    if not raw or '@@@' in raw:
        return []
    parts = re.split(r'[，,、；;\n]+', raw)
    out = []
    for p in parts:
        p = p.strip(' \t\r\n。.!！?？；;：:')
        if 2 <= len(p) <= 12 and p not in out:
            out.append(p)
    return out[:8]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=r'F:/qqbot/dshqqbot')
    ap.add_argument('--base', default='http://127.0.0.1:11434')
    ap.add_argument('--model', default='qwen2.5vl:3b')
    ap.add_argument('--limit', type=int, default=3, help='0=全部未打标')
    ap.add_argument('--max-side', type=int, default=384)
    ap.add_argument('--timeout', type=int, default=180)
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    root = args.root.replace('\\', '/')
    idx_path = os.path.join(root, '表情包', 'index.json')
    idx = json.load(open(idx_path, encoding='utf-8'))
    items = idx.get('items') or []
    todo = [i for i in items if not (isinstance(i.get('tags'), list) and i['tags'])]
    if args.limit:
        todo = todo[: args.limit]
    print(f'items={len(items)} untagged={sum(1 for i in items if not i.get("tags"))} todo={len(todo)}')
    ok = 0
    for it in todo:
        p = os.path.join(root, '表情包', 'lib', str(it.get('layer') or 'candidate'),
                         f"{it['id']}.{it.get('ext') or 'jpg'}")
        if not os.path.exists(p):
            print('SKIP missing', it['id'], p)
            continue
        try:
            img, size = clean_image(p, args.max_side)
            raw, ms = ask(img, args.base, args.model, args.timeout)
            tags = parse_tags(raw)
            flag = 'OK' if len(tags) >= 1 else 'FAIL'
            print(f'{flag} {it["id"]} {size} {ms}ms tags={tags}')
            if tags:
                ok += 1
                if args.apply:
                    it['tags'] = tags
                    it['desc'] = raw[:300]
                    it['descZh'] = raw[:300]
                    it['needsDescribe'] = False
                    it['taggedAt'] = int(time.time() * 1000)
                    it['tagModel'] = args.model
        except Exception as e:
            print('ERR', it['id'], type(e).__name__, str(e)[:160])

    print(f'parsed={ok}/{len(todo)}')
    if args.apply and ok:
        bak = idx_path + time.strftime('.bak-%Y%m%d%H%M%S')
        shutil.copy2(idx_path, bak)
        idx['items'] = items
        json.dump(idx, open(idx_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print('written', idx_path, 'backup', bak)
    elif args.apply:
        print('no valid tags; nothing written')


if __name__ == '__main__':
    main()
