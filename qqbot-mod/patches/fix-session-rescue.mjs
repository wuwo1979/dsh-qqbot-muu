// fix-session-rescue.mjs — 修「每条消息都可能新开一个 DSH 会话」
//
// 病灶（dist/session/session-manager.js 的 getOrCreate）：
//   try { resume } catch {           <-- 裸 catch，真实原因被吞，一点线索都不留
//     await this.agents.create({sessionId})   <-- 同一个 id 再 create
//   }
// 宿主 sessions.prepare 遇到已在 store 里的 id 会抛 `session "xxx" already exists`，
// 这个错误冒到 transport/inbound.js 的 catch → 整条消息被吞（日志里一天出现 ~50 次），
// 再被上层用 forceNew 救回来 —— 而 forceNew 每次都轮换 sessionId，
// 于是 DSH 侧边栏一堆新会话、QQ 侧历史/记忆全断。
//
// 改成自愈阶梯：
//   ① warn 出真实的 resume 错误
//   ② 250ms / 800ms 各试一次：先看 agents.get 有没有活 agent（有就直接用），再试 resume
//   ③ 都失败才 create；create 撞 already exists → 记 warn + 轮换 id 递归一次（forceNew）
//   ④ 成功（resume 或 create）后把 sessionId 持久化，别让它每次重新派生
//
// 用法：node fix-session-rescue.mjs [--check] [--apply] [--revert]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN } from './plugin-dir.mjs';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;
const TT = String.fromCharCode(96); // 反引号

const FILE = join(PLUGIN, 'dist', 'session', 'session-manager.js');
const BAK = FILE + '.orig-sessionrescue';
const MARK = '[qqbot-mod] session-rescue';

const START = '            catch {' + EOL + '                const created = await this.agents.create({';
const END = EOL + '        }' + EOL + '        const record = {';

function buildReplacement() {
  const line = (s) => s + EOL;
  let out = '';
  out += line('            catch (resumeErr) {');
  out += line('                // ' + MARK + ' —— resume 失败别直接 create（同 id create 会撞 already exists）。');
  out += line('                this.logger.warn(' + TT + 'resume failed: key=${key} sessionId=${sessionId} err=${resumeErr?.message ?? resumeErr}' + TT + ');');
  out += line('                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));');
  out += line('                for (const waitMs of [250, 800]) {');
  out += line('                    await sleep(waitMs);');
  out += line('                    const again = this.agents.get(sessionId);');
  out += line('                    if (again) {');
  out += line('                        agent = again;');
  out += line('                        this.logger.warn(' + TT + 'resume 失败但发现活 agent，直接复用: key=${key}' + TT + ');');
  out += line('                        break;');
  out += line('                    }');
  out += line('                    try {');
  out += line('                        const rRoute = this.modelResolver.getResumeRoute(key, sessionId);');
  out += line('                        const retried = await this.agents.resume({');
  out += line('                            resumeSessionId: sessionId,');
  out += line('                            ...(rRoute ? { agentOptions: rRoute } : {}),');
  out += line('                            ...(composed.setup ? { setup: composed.setup } : {}),');
  out += line('                        });');
  out += line('                        agent = retried.agent;');
  out += line('                        handle = retried;');
  out += line('                        this.logger.warn(' + TT + 'resume 第 ${waitMs}ms 重试成功: key=${key}' + TT + ');');
  out += line('                        break;');
  out += line('                    }');
  out += line('                    catch (e2) {');
  out += line('                        this.logger.warn(' + TT + 'resume 第 ${waitMs}ms 重试仍失败: key=${key} err=${e2?.message ?? e2}' + TT + ');');
  out += line('                    }');
  out += line('                }');
  out += line('                if (!agent) {');
  out += line('                    try {');
  out += line('                        const created = await this.agents.create({');
  out += line('                            sessionId,');
  out += line('                            meta: {');
  out += line('                                cwd: this.config.cwd || process.cwd(),');
  out += line('                                ...(agentPreset ? { agentPreset } : {}),');
  out += line('                            },');
  out += line('                            ...(route ? { agentOptions: route } : {}),');
  out += line('                            ...(composed.setup ? { setup: composed.setup } : {}),');
  out += line('                        });');
  out += line('                        agent = created.agent;');
  out += line('                        handle = created;');
  out += line('                        this.logger.info(' + TT + 'created new session: key=${key} preset=${agentPreset ?? ' + String.fromCharCode(39) + 'none' + String.fromCharCode(39) + '}' + TT + ');');
  out += line('                    }');
  out += line('                    catch (createErr) {');
  out += line('                        const cmsg = String(createErr?.message ?? createErr);');
  out += line('                        if (!/already exists/i.test(cmsg))');
  out += line('                            throw createErr;');
  out += line('                        // 会话已在宿主 store 里（多半是 web 端打开过 / 上一轮 agent 还活着，但不是同一个对象）');
  out += line('                        // → 换一个新 id 重开一次；旧档文件原样保留，侧边栏可回看。');
  out += line('                        const rotated = SessionId(randomUUID());');
  out += line('                        this.logger.warn(' + TT + 'create 撞已存在会话 → 轮换 sessionId 重开: key=${key} old=${sessionId} new=${rotated}' + TT + ');');
  out += line('                        try {');
  out += line('                            this.modelResolver.setSessionId(key, rotated);');
  out += line('                        }');
  out += line('                        catch { /* ignore */ }');
  out += line('                        return this.getOrCreate(scope, peerId, senderId, replyTarget, { ...opts, forceNew: true });');
  out += line('                    }');
  out += line('                }');
  out += line('                try {');
  out += line('                    this.modelResolver.setSessionCfg(key, { cwd: wantCwd });');
  out += line('                }');
  out += line('                catch { /* ignore */ }');
  out += line('            }');
  return out;
}

// 持久化 sessionId：插在 `}` (else 块结束) 与 `const record = {` 之间
const PIN_ANCHOR = END;
function buildPin() {
  let out = '';
  out += EOL + '        // ' + MARK + ' —— 把定下来的 sessionId 持久化，别下次又靠派生去猜';
  out += EOL + '        try {';
  out += EOL + '            this.modelResolver.setSessionId(key, sessionId);';
  out += EOL + '        }';
  out += EOL + '        catch { /* ignore */ }';
  return out;
}

function norm(src) {
  return src.split(CR).join('').split(LF).join(EOL);
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--apply') ? 'apply' : args.includes('--revert') ? 'revert' : 'check';
  if (!existsSync(FILE)) {
    console.log('找不到文件: ' + FILE);
    process.exit(2);
  }
  let src = readFileSync(FILE, 'utf8');
  const n = norm(src);

  if (mode === 'revert') {
    if (!existsSync(BAK)) {
      console.log('没有备份，无法回滚: ' + BAK);
      process.exit(2);
    }
    writeFileSync(FILE, readFileSync(BAK));
    console.log('已回滚: ' + FILE);
    return;
  }

  if (n.includes(MARK)) {
    console.log('已应用（检测到标记 ' + MARK + '），无需重复打补丁');
    return;
  }

  const iStart = n.indexOf(START);
  const iEnd = n.indexOf(END, iStart + 10);
  if (iStart < 0 || iEnd < 0) {
    console.log('❌ 锚点未匹配: start=' + iStart + ' end=' + iEnd);
    process.exit(1);
  }

  const before = n.slice(0, iStart);
  const CLOSE = '        }';
  const RECORD = '        const record = {';
  const rest = n.slice(iEnd + END.length); // END 末尾就是 'const record = {'
  let out = before + buildReplacement() + CLOSE + buildPin() + EOL + RECORD + rest;

  // 自检：关键片段都得在
  const must = ['resume failed:', 'resume 第 ${waitMs}ms 重试成功', 'already exists/i.test', '轮换 sessionId 重开', 'setSessionId(key, sessionId)'];
  const missing = must.filter((m) => !out.includes(m));
  if (missing.length) {
    console.log('❌ 自检失败，缺: ' + missing.join(' / '));
    process.exit(1);
  }

  if (mode === 'check') {
    console.log('✅ 锚点命中（可打）; 新文件 ' + out.length + ' 字符 / 原 ' + n.length);
    return;
  }

  if (!existsSync(BAK)) copyFileSync(FILE, BAK);
  writeFileSync(FILE, out);
  console.log('✅ 已应用: ' + FILE + ' (' + n.length + ' -> ' + out.length + ' 字符)');
  console.log('备份: ' + BAK);
}

main();
