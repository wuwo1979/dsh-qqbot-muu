---
name: career-ai-dev
description: AI 技术岗与前后端（Python / Java）求职面试的高频考点与答题口径。当有人问 AI 岗/算法岗/大模型岗面试、后端八股（GIL、JVM、Spring、MySQL、Redis）、前端面试（事件循环、React、Vue3、Vite）时用。
---

# career-ai-dev — AI 岗与前后端岗位

完整笔记在 `docs/知识-AI与前后端岗位.md`。本文件是高频考点清单 + 答法原则。

**答法原则：先给一句话结论，再给机制，最后给一个「什么时候会翻车」的边界。** 只背名词不给机制，面试会被追穿。

## AI / 大模型岗

- 基础：过拟合与正则、偏差-方差、交叉验证、类别不平衡；梯度消失/爆炸与残差、归一化位置（Pre-LN vs Post-LN）。
- Transformer：自注意力 O(n²) 复杂度来源、位置编码、MHA、KV Cache 换显存的账。
- 预训练：BERT（双向、MLM）vs GPT（自回归、next token）；LoRA 的低秩分解与秩/alpha 选择。
- RAG：切分策略、embedding 召回 + rerank、上下文拼接顺序、幻觉治理（引用约束、拒答、self-check）。
- 评测：离线指标（准确率/召回/困惑度）+ 在线（人工评分、A/B）；LLM-as-judge 的偏差。
- 推理服务：vLLM 的 PagedAttention、TTFT / TPOT、连续批处理、量化（INT8/AWQ/GPTQ）代价。
- Agent：工具调用、ReAct/Plan-Execute、记忆与压缩、失败重试与沙箱。

## 后端（Python）

- GIL：CPython 同一进程同一时刻只有一个线程跑字节码 → CPU 密集用多进程，IO 密集用 asyncio/线程。
- asyncio：`await` 阻塞调用会卡死整个事件循环，必须用线程池/异步库。
- FastAPI：依赖注入（Depends）、Pydantic 校验、async 路由里别调同步阻塞。
- 常见追问：`__slots__`、生成器与协程区别、GIL 为什么还在（引用计数+C 扩展生态）。

## 后端（Java）

- 集合：HashMap 默认 16、负载因子 0.75、**2 倍扩容**、链表长度 ≥8 且容量 ≥64 转红黑树；
  ConcurrentHashMap 的分段/CAS+synchronized。
- JVM：堆分代、G1 的 Region 与停顿预测、GC  Roots、常见 OOM 类型；类加载双亲委派。
- 并发：`volatile` 保证可见性/有序不保证原子；`synchronized` 与 `ReentrantLock` 差异；线程池七参数与拒绝策略。
- Spring：Bean 生命周期、**三级缓存解决循环依赖**（为什么需要第三级：AOP 代理）、事务传播与失效场景（同类内部调用）。
- MyBatis：`#{}` 预编译 vs `${}` 拼接（SQL 注入）。

## 数据库 / 中间件（前后端通用）

- MySQL：InnoDB 聚簇索引、B+ 树为什么比 B 树矮、回表与覆盖索引、最左前缀、索引失效场景、
  MVCC（undo log + ReadView）、RR 下的幻读与间隙锁。
- Redis：缓存穿透（布隆/空值）、击穿（互斥/逻辑过期）、雪崩（随机 TTL）；持久化 RDB/AOF；分布式锁的坑。
- MQ：不丢（确认机制+持久化）、不重（幂等/去重表）、顺序（分区键）。

## 前端

- 事件循环：宏任务/微任务、`await` 后续进微任务、渲染时机。
- React：Hooks 依赖数组与闭包陷阱、`useEffect` 清理、fiber 与并发渲染、memo/useMemo 何时真有用。
- Vue3：Proxy 相比 defineProperty 的优势（新增属性/数组）、响应式原理、`ref` vs `reactive`。
- 工程化：Vite 的 ESM dev + Rollup 打包、Tree-shaking 条件、TS 的泛型与类型收窄。

## 禁忌

- 不要背「八股答案」却不给适用场景；面试官最爱问「你这个方案什么时候不成立」。
- 版本相关的细节（如 JDK 版本默认 GC）拿不准就明说要确认，别硬答。
