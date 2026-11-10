/**
 * live/adapters/douyin.mjs — 抖音直播 adapter 占位
 *
 * 当前不实现具体逻辑，仅固定接口与事件映射位，后续替换内部实现即可接上。
 *
 * 已知约束（调研结论）：
 *   · 抖音直播弹幕长连走 webcast 私有协议，需要设备指纹、x-bogus/msToken 等签名；
 *   · 官方「直播小玩法 / 弹幕玩法」需要企业开发者入驻 + 白名单报备 + 玩法审核；
 *   · 没有面向个人开发者的公开弹幕开放接口。
 * 因此这里只保留接口位置与事件映射，不发起任何请求。
 */
import { EVENT_TYPES } from '../event-model.mjs';

export const DOUYIN_EVENT_MAP = {
  WebcastChatMessage: EVENT_TYPES.DANMAKU,
  WebcastGiftMessage: EVENT_TYPES.GIFT,
  WebcastMemberMessage: EVENT_TYPES.ENTER,
  WebcastSocialMessage: EVENT_TYPES.FOLLOW,
  WebcastLikeMessage: EVENT_TYPES.LIKE,
  WebcastRoomUserSeqMessage: EVENT_TYPES.WATCH,
  WebcastRoomStatsMessage: EVENT_TYPES.LIVE_START,
  WebcastControlMessage: EVENT_TYPES.LIVE_END,
  WebcastSubNotifyMessage: EVENT_TYPES.GUARD,
};

export class DouyinAdapter {
  constructor({ cfg, logger, redactor, onEvent, onStatus }) {
    this.cfg = cfg;
    this.logger = logger;
    this.redactor = redactor;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.state = 'placeholder';
  }

  snapshot() {
    return {
      state: 'placeholder',
      channel: 'douyin',
      room: null,
      note: '接口占位：抖音直播弹幕需要私有签名与企业开发者白名单，当前不实现。',
      eventMap: Object.keys(DOUYIN_EVENT_MAP),
    };
  }

  async start() {
    this.onStatus?.(this.snapshot());
    return { ok: false, placeholder: true, error: '抖音直播适配器未实现：缺少公开弹幕长连接与签名能力' };
  }

  async stop() { this.state = 'stopped'; }

  async send() { return { ok: false, error: '抖音直播发送未实现' }; }
}
