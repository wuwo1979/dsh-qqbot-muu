---
name: h3-video
description: 本地跑 MiniMax H3 视频生成（FreeVideo 引擎，RTX 3060 6GB 可勉强跑 int8 + 权重流式）。安装器已下载到 F:/qqbot/.models/freevideo/FreeVideo.exe，首次需要用户双击完成 ComfyUI+模型安装；装好后小蓝可通过它的 Agent 接口自主生成/剪辑/导出视频，再走 bili_ops 投稿。
---

# h3-video —— MiniMax H3 本地视频生成（FreeVideo）

一句话：**装好后，"让小蓝自己生成一段视频并投稿 B 站"就有了一个纯本地的视频引擎**，
和现有三条渲染路子（截图拼帧/文字动画/程序化画画）互补——H3 负责真正的"画面生成"。

## 现状（2026-10-25）

- ✅ 安装器已就位：`F:/qqbot/.models/freevideo/FreeVideo.exe`（78,019,984 字节，GitHub 官方签名版）
- ✅ 硬件核查：RAM 16GB ✓ / 磁盘 524GB ✓ / RTX 30 系走 int8 ✓
  - 官方最低 **8GB 显存**；但 FreeVideo 明确适配 "6-16 GB cards"（权重流式 + 注意力分组），6GB 属"勉强档"
- ⬜ 待用户完成：**双击 FreeVideo.exe** → 选全新 ComfyUI（建议装到 `F:\qqbot\.models\freevideo\comfy`）→ 点「安装并启动」→ 它会自动下 ComfyUI + VDN-H3 int8 权重（约 10-20GB，支持断点）
- ⬜ 装好后：设置里开「局域网访问」可选；Agent 接口在 v0.4.0+ 内置（"连接 AI Agent，让它生成、剪辑和导出视频"）

## 与显存的相处之道（重要）

H3 生成时要吃满整张卡 + 内存/磁盘流式。规则：

1. **和 TTS/SD 互斥**：生成 H3 视频前，确认 TTS 管家空闲（它本来就自动关）；
   TTS 管家的显存守卫同样会拒绝在 H3 跑的时候拉起语音后端——天然互锁。
2. 生成时别开游戏。3060 6GB 的预期速度：5s 视频约 3-10 分钟（权重走盘会慢，SSD 很关键）。
3. 一次生成 5s 起；长视频用它的剪辑视图分段续接（每段接前一段，8 段上限）。

## 装好之后的接入路线（下一步）

1. 探活：ComfyUI 默认 `http://127.0.0.1:8188`（FreeVideo 面板也挂在这里面）。
2. Agent 桥：v0.4.0 的 Agent 连接入口在 FreeVideo 设置里开启后，
   适配方式是给 `bili_ops` 新增 `h3_video` 动作：提交 prompt/参考图 → 轮询 → 拿 mp4 →
   （可选 narrate_footage 配音）→ 走既有 `approve` 投稿流程。
3. 失败兜底：H3 不可用时回落现有 renderJob 三路子，不影响"读评论/做视频"主链路。

## 参考

- 仓库：https://github.com/FlashML-org/FreeVideo（Apache-2.0；模型权重另有 MiniMax H3 社区许可证，对地区/用途有限制，商用前自查）
- 论文：arXiv:2609.20744（Video DeltaNet 混合注意力）
- 离线包：夸克网盘 https://pan.quark.cn/s/c51235b84618（「视频模型」「文本编码器」「视频与音频解码器」「采样缓存」四包，直接拖进启动器）
