#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""fetch_song.py —— 按 BV 号 / 链接 / 关键词取一首歌的最高码率音轨，并落 sources.json（原曲出处）。

用法：
  python fetch_song.py --bvid BV13v411V7Da --out F:\\qqbot\\tmp\\sing\\wuli
  python fetch_song.py --search "雾里 姚六一" --out ... --pick 1
  python fetch_song.py --url https://www.bilibili.com/video/BV13v411V7Da --out ...

产物：
  <out>/song.m4a      原始音轨（不转码，交给 demucs）
  <out>/sources.json  出处台账（交付 cover 时必须带这条链接）

只用标准库（本机 curl / Invoke-WebRequest 的 TLS 是坏的，能不能发出去全看 urllib + 代理环境变量）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.bilibili.com"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
COOKIE_CANDIDATES = [
    Path("F:/qqbot/dshqqbot/bili-cookie.json"),
    Path("F:/qqbot/bili-cookie.json"),
]


def cookie_header() -> str:
    for p in COOKIE_CANDIDATES:
        if not p.is_file():
            continue
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        # 这个文件有两种形态：{cookies:{...}, name:'...'} 或平铺 —— name/mid 这些不是 cookie，别混进去
        jar = j.get("cookies") if isinstance(j.get("cookies"), dict) else j
        parts = []
        for k, v in (jar or {}).items():
            if k in ("savedAt", "name", "mid", "biliFingerprintAt"):
                continue
            if k.startswith("_") or v in (None, ""):
                continue
            if isinstance(v, (str, int)):
                parts.append(f"{k}={v}")
        if parts:
            return "; ".join(parts)
    return ""


def http_json(url: str, cookie: str, referer: str = "https://www.bilibili.com/") -> dict:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": referer,
        "Origin": "https://www.bilibili.com",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cookie": cookie,
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def parse_bvid(s: str) -> str:
    m = re.search(r"(BV[0-9A-Za-z]{10})", s or "")
    if not m:
        raise SystemExit(f"拿不到 BV 号: {s!r}")
    return m.group(1)


def resolve_short(url: str, cookie: str) -> str:
    """b23.tv 短链 → 真链接（走 302 的 Location）。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Cookie": cookie})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.geturl() or url
    except Exception:
        return url


def search_songs(keyword: str, cookie: str, limit: int = 8) -> list[dict]:
    q = urllib.parse.urlencode({"search_type": "video", "keyword": keyword, "page": 1}, quote_via=urllib.parse.quote)
    j = http_json(f"{API}/x/web-interface/search/type?{q}", cookie, referer="https://search.bilibili.com/")
    if j.get("code") != 0:
        raise SystemExit(f"搜索失败 code={j.get('code')} {j.get('message')}")
    out = []
    for it in (j.get("data") or {}).get("result") or []:
        if it.get("type") != "video":
            continue
        title = re.sub(r"<[^>]+>", "", it.get("title") or "")
        out.append({
            "bvid": it.get("bvid"),
            "title": title,
            "owner": it.get("author"),
            "duration": it.get("duration"),
            "play": it.get("play"),
            "url": f"https://www.bilibili.com/video/{it.get('bvid')}",
        })
        if len(out) >= limit:
            break
    return out


def video_info(bvid: str, cookie: str) -> dict:
    j = http_json(f"{API}/x/web-interface/view?bvid={bvid}", cookie, referer=f"https://www.bilibili.com/video/{bvid}")
    if j.get("code") != 0:
        raise SystemExit(f"取视频信息失败 code={j.get('code')} {j.get('message')}")
    v = j["data"]
    pages = v.get("pages") or []
    cid = (pages[0] if pages else {}).get("cid") or v.get("cid")
    return {
        "bvid": bvid,
        "aid": v.get("aid"),
        "cid": cid,
        "title": v.get("title"),
        "owner": (v.get("owner") or {}).get("name"),
        "duration_s": v.get("duration"),
        "url": f"https://www.bilibili.com/video/{bvid}",
        "pages": len(pages),
    }


def best_audio(info: dict, cookie: str) -> tuple[str, int, str]:
    q = urllib.parse.urlencode({"bvid": info["bvid"], "cid": info["cid"], "fnval": 16, "fourk": 0})
    j = http_json(f"{API}/x/player/playurl?{q}", cookie, referer=info["url"])
    if j.get("code") != 0:
        raise SystemExit(f"取播放地址失败 code={j.get('code')} {j.get('message')}（多试几次，-412 是风控）")
    dash = (j.get("data") or {}).get("dash") or {}
    cands = [a for a in (dash.get("audio") or []) if a.get("baseUrl") or a.get("base_url")]
    if not cands:
        raise SystemExit("这条视频没有 DASH 音轨（可能是直播回放/番剧，换一条）")
    best = max(cands, key=lambda a: int(a.get("bandwidth") or 0))
    url = best.get("baseUrl") or best.get("base_url")
    return url, int(best.get("bandwidth") or 0), best.get("codecs") or ""


def download(url: str, dst: Path, cookie: str) -> int:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
        "Cookie": cookie,
    })
    dst.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with urllib.request.urlopen(req, timeout=60) as r, dst.open("wb") as f:
        while True:
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            n += len(chunk)
    return n


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bvid", default="")
    ap.add_argument("--url", default="")
    ap.add_argument("--search", default="")
    ap.add_argument("--pick", type=int, default=1, help="搜索结果的第几条（1 起）")
    ap.add_argument("--out", required=True, help="产物目录")
    args = ap.parse_args(argv)

    cookie = cookie_header()
    if not cookie:
        print("[warn] 没找到 bili-cookie.json，裸跑大概率被风控（-412）", file=sys.stderr)

    picked = None
    if args.search and not (args.bvid or args.url):
        hits = search_songs(args.search, cookie)
        if not hits:
            raise SystemExit(f"搜不到: {args.search}")
        print(f"[search] {len(hits)} 条结果：")
        for i, h in enumerate(hits, 1):
            print(f"  {i}. {h['title']}  [{h['owner']}]  {h['duration']}  {h['bvid']}  play={h['play']}")
        picked = hits[min(max(args.pick, 1), len(hits)) - 1]
        print(f"[pick] {picked['title']} → {picked['url']}")

    raw = args.bvid or args.url or (picked or {}).get("bvid") or ""
    if not raw:
        raise SystemExit("要 --bvid / --url / --search 之一")
    if raw.startswith("http") and "b23.tv" in raw:
        raw = resolve_short(raw, cookie)
    bvid = parse_bvid(raw)

    info = video_info(bvid, cookie)
    print(f"[view] {info['title']} / {info['owner']} / {info['duration_s']}s / cid={info['cid']}")

    url, bw, codec = best_audio(info, cookie)
    print(f"[audio] bandwidth={bw} codec={codec}")
    out = Path(args.out)
    song = out / "song.m4a"
    size = download(url, song, cookie)
    print(f"[ok] {song}  {size} B")

    meta = {
        "cover": None,
        "song": info["title"],
        "artist": info["owner"],
        "source": {
            "platform": "bilibili",
            "bvid": bvid,
            "url": info["url"],
            "title": info["title"],
            "owner": info["owner"],
            "duration_s": info["duration_s"],
            "audio_bandwidth": bw,
            "audio_codec": codec,
            "audio_file": song.name,
            "audio_bytes": size,
        },
        "voice": None,
        "rvc_input_sr": 44100,
        "pitch_shift": None,
        "made_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    (out / "sources.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[sources] {out / 'sources.json'}")
    print(f"\n原曲出处：{info['url']}   （交付 cover 时必须带上这条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
