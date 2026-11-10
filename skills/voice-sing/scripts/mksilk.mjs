// 微信/QQ 语音条用的 silk 编码器。
//
// 为什么需要：平板 `/api/messages/voice` 那头的转码器是坏的——喂 mp3/wav/amr 进去，
// 微信收到的语音条全是噪音（实测 2026-11-09）。这里自己把 24k 单声道 PCM 编成
// 微信原生 silk（silk-wasm），再把 .silk 交给平板，实测能正常播放。
//
// 用法：node skills/voice-sing/scripts/mksilk.mjs <in.pcm> <out.silk> [sampleRate=24000]
// 前置：in.pcm 必须是 ffmpeg 的 `-f s16le -ar 24000 -ac 1` 裸流。
import { readFileSync, writeFileSync } from 'node:fs'
import silk from 'silk-wasm'

const [, , inp, outp, srArg] = process.argv
if (!inp || !outp) {
  console.error('用法：node mksilk.mjs <in.pcm> <out.silk> [sampleRate=24000]')
  process.exit(2)
}
const sampleRate = Number(srArg || 24000)
const pcm = readFileSync(inp)
const res = await silk.encode(pcm, sampleRate)
const buf = Buffer.from(res.data ?? res)
writeFileSync(outp, buf)
console.log(JSON.stringify({ ok: true, silk: outp, silkBytes: buf.length, pcmBytes: pcm.length, sampleRate, ms: res.duration ?? null }))
