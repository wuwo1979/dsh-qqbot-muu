import { type MdMediaTarget } from './md-media.js';
/** 上一次重写的结果（供扩展/工具做回执；跨模块走 globalThis） */
export interface MediaRewriteResult {
    matched: number;
    converted: number;
    failed: number;
    hint?: string;
    at: number;
}
export declare function lastMediaRewrite(): MediaRewriteResult | undefined;
export declare function setMaterialTargetFactory(fn: (() => MdMediaTarget | undefined) | undefined): void;
/**
 * 扫描文本里的 markdown 图片；本地路径的替换成 QQ 引用。
 * @param explicitTarget 调用方自己的句柄（优先）；不传则用全局 factory
 */
export declare function rewriteLocalMarkdownImages(text: string, explicitTarget?: MdMediaTarget): Promise<string>;
//# sourceMappingURL=md-media-rewrite.d.ts.map