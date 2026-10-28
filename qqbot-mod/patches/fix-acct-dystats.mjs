// tmp/fix-acct-dystats.mjs —— 抖音卡显示昵称/uid/粉丝·作品，登不上时不再只写"连接不上"
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
const C = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/.generations/live/zaofan+dsh-qqbot+1.10.39+a14f9025cf60/node_modules/@zaofan/dsh-qqbot/client/qqbot-settings.js'
const norm = (s) => s.replace(/\r\n/g, '\n')
const denorm = (s) => s.replace(/\n/g, '\r\n')
let s = norm(readFileSync(C, 'utf8'))

const anchor = `            + '<div style="font-size:11.5px;color:#667085;margin:4px 0 6px">' + esc(d.hint || '') + '</div>'
            + '<div style="font-size:11px;color:#475467;background:#f8f9fb;border:1px solid #eef0f3;border-radius:6px;padding:5px;margin:4px 0 6px;line-height:1.5">'`

const replaced = `            + '<div style="font-size:11.5px;color:#667085;margin:4px 0 6px">' + esc(d.hint || '') + '</div>'
            + (d.loggedIn === true
              ? '<div style="font-size:11.5px;color:#344054;margin:0 0 6px">👤 ' + esc(d.nickname || '（无昵称）')
                + (d.uniqueId ? '（抖音号 ' + esc(d.uniqueId) + '）' : '')
                + (d.stats ? '　粉丝 ' + d.stats.follower + ' · 关注 ' + d.stats.following + ' · 作品 ' + d.stats.aweme : '')
                + '</div>'
              : '')
            + '<div style="font-size:11px;color:#475467;background:#f8f9fb;border:1px solid #eef0f3;border-radius:6px;padding:5px;margin:4px 0 6px;line-height:1.5">'`

if (!s.includes(anchor)) { console.log('✗ 锚点未命中'); process.exit(1) }
s = s.replace(anchor, replaced)
copyFileSync(C, C + '.orig-muu-dystats')
writeFileSync(C, denorm(s), 'utf8')
console.log('✓ 抖音卡已加登录信息行')
