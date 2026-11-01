/**
 * msg-history.ts — 群消息历史台账（2026-10-20 主人定：独立台账 + 按会话分目录 + 一天一个文件）
 *
 * 目录结构（`{dataRoot}/.qqbot/msg-history/`）：
 *   group_<群openid>/2026-10-20.jsonl
 *   c2c_<对方openid>/2026-10-20.jsonl
 *
 * 设计要点（主人要求）：
 *   · **一会话一目录** → 群与群、群与私聊天然隔离，读的时候根本碰不到别人的文件；
 *   · **一天一个文件** → 不会反复读写同一个越滚越大的文件；
 *   · **默认只保留 7 天** → 启动时 + 每 200 次写顺手清掉过期日期文件；
 *   · 一行一条：`{"id":"message_id","s":"发送者","n":"昵称","t":毫秒,"k":"text|image|voice|video|file","x":"正文摘要","me":true?}`
 *
 * 用途：`group_recall`（撤某人最近一条）、`group_msg_search`（按关键词/类型搜）、
 *       `group_recall_batch`（批量撤 + 顺带禁言）。与引用补全用的 msg-content.jsonl **互不干扰**。
 */
import type { MsgKind } from './msg-recent.js';
/** 默认保留天数（主人定：7 天） */
export declare const KEEP_DAYS = 7;
export interface HistoryRec {
    /** QQ message_id */
    id: string;
    /** 发送者 openid（机器人自己发时 'self'） */
    s: string;
    /** 昵称 */
    n: string;
    /** 毫秒时间戳 */
    t: number;
    /** 类型 */
    k: MsgKind;
    /** 正文摘要 */
    x: string;
    /** 是否机器人自己发的 */
    me?: boolean;
}
/** 初始化（bootstrap 启动时调一次）：建目录 + 清过期 */
export declare function initMsgHistory(dataRoot: string): void;
/** 删掉超过 KEEP_DAYS 天的日期文件（顺带删空目录） */
export declare function pruneOld(): void;
/**
 * 在该会话目录里放一个「<群名>.txt」（主人要求：打开文件夹一眼认出是哪个群）。
 * 群名变了会顺手删掉旧名字文件；同时刷新根目录 _索引.txt。
 */
export declare function markSession(scope: 'group' | 'c2c', peerId: string): void;
/** 记一条（写入当天文件） */
export declare function appendMsgHistory(scope: 'group' | 'c2c', peerId: string, rec: Partial<HistoryRec> & {
    id: string;
}): void;
export interface HistoryQuery {
    /** 只看多少毫秒内（默认 7 天） */
    withinMs?: number;
    /** 最多几条（默认 20，上限 200） */
    limit?: number;
    /** 关键词（子串，忽略大小写） */
    keyword?: string;
    /** 类型筛选 */
    kind?: MsgKind;
    /** true=只机器人自己发的；false=只别人发的；不填=都算 */
    fromSelf?: boolean;
    /** 只看某个发送者 */
    senderId?: string;
}
/** 读该会话的历史（**只碰它自己的目录**），新→旧 */
export declare function readMsgHistory(scope: 'group' | 'c2c', peerId: string, q?: HistoryQuery): HistoryRec[];
/** 找「某人最近一条」/「最近一条」 */
export declare function latestMsgHistory(scope: 'group' | 'c2c', peerId: string, opts?: {
    senderId?: string;
    withinMs?: number;
    kind?: MsgKind;
}): HistoryRec | undefined;
/** 诊断：会话目录 + 今天文件行数 */
export declare function historyDebug(scope: 'group' | 'c2c', peerId: string): string;
/**
 * 最近有消息写入的群目录对应的 gid（2026-10-20）。
 * 用途：web 会话里拿不到群会话记录时的兜底 —— 一般就是"当前正在聊的群"。
 */
export declare function latestGroupId(): string;
//# sourceMappingURL=msg-history.d.ts.map