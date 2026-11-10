/**
 * hooks/pet-panel.mjs — 浮窗「🐋 陪玩」页的桌宠接口（2026-10-31 v2 双形态版）
 *
 *   GET  /api/qqbot-settings/pet-anim
 *        → 当前形态 + 两形态清单 + 当前形态动作表（浮窗渲染用）
 *          { ok, form:{id,label,emoji}, forms:[{id,label,emoji,active,petId}], anims:[{name,label,reply}] }
 *   POST /api/qqbot-settings/pet-anim
 *        {action:'random'}                    当前形态随机来一个（待机语义除外）
 *        {action:'switch-form',target:'muu'}  切形态（'muu' 大肥鱼 / 'xiaolan' 小蓝）
 *        {name:'小蓝-挥手'}                    触发当前形态的指定动画
 *
 * 实现全部委托给 lib/pet-anim.mjs（本地回环 HTTP → dsh-pet 插件）。
 * 硬约束（主人 2026-10-31）：只要动作，不要碎碎念 —— 零模型调用，
 * 不碰 LLM、不产生会话轮次；失败也不抛异常，把 {ok:false} 原样回给浮窗。
 */
import { FORMS, FORM_IDS, PET_ANIMS, PET_ID, petAnim, randomAnim, animByLabel, switchForm, currentForm, loadFormPreference, webEndpoint, ensurePetMenu, petVisibility, hideAllPets, showPet, stateAnim, stateList, formRev } from '../lib/pet-anim.mjs';
import { summary as outfitSummary, setOutfit, outfitInfo, previewPath as outfitPreviewPath } from '../lib/pet-outfits.mjs';
import { listBackgrounds, setBackground, addDir, removeDir, resolveImage, contentTypeOf } from '../lib/pet-backgrounds.mjs';
import { topFamiliarity } from '../lib/profile-core.mjs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openSync, readSync, fstatSync, closeSync, statSync, readFileSync } from 'node:fs';

/** 数据根：本文件在 {dataRoot}/.qqbot-extensions/hooks/ 下，上溯三级（file → hooks → .qqbot-extensions → dataRoot） */
const DATA_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** harness 日志位置：dsh-desktop/logs/harness.log（pet-anim 的 DSH_HOME 指到 harness/，取其父目录） */
function harnessLogPath() {
  const dsh = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness');
  return join(dirname(dsh), 'logs', 'harness.log');
}
/** 从 harness 日志尾部推断 QQ bot 在线状态（零新依赖，同进程内拿不到 session-registry 才走这路）。
 *  事件序：`[ts] … Bot ready!` → 在线；`Bot start failed / invalid appid or secret` → 离线；取时间最新者。 */
function botOnlineFromLog() {
  try {
    const p = harnessLogPath();
    let size = 0;
    try { size = statSync(p).size; } catch { return null; }
    const len = Math.min(size, 256 * 1024);
    const fh = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fh, buf, 0, len, size - len);
      const txt = buf.toString('utf8');
      const re = /\[([\d-]+T[\d:.]+Z)\][^\n]*(Bot ready!|Bot start failed|invalid appid or secret)/g;
      let m, last = null;
      while ((m = re.exec(txt))) last = { at: m[1], ok: m[2].indexOf('ready') >= 0 };
      return last;
    } finally { try { closeSync(fh); } catch { /* ignore */ } }
  } catch { return null; }
}

/** 事件驱动的在线状态（v5，2026-10-31）：gateway/bootstrap.js 在 ready/resumed/error/start-failed
 *  时落盘 {dataRoot}/.qqbot/bot-status.json —— 这才是准确来源。文件缺失或时间戳太旧(>12h) → null 走日志兜底。 */
function botStatusFromFile() {
  try {
    const j = JSON.parse(readFileSync(join(DATA_ROOT, '.qqbot', 'bot-status.json'), 'utf8'));
    if (typeof j.online !== 'boolean' || !j.at) return null;
    const ageMs = Date.now() - (Date.parse(j.at) || 0);
    if (!Number.isFinite(ageMs) || ageMs > 12 * 3600 * 1000) return null;
    return { online: j.online, at: j.at };
  } catch { return null; }
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); try { req.destroy(); } catch { /* ignore */ } return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const t = Buffer.concat(chunks).toString('utf8').trim();
        resolve(t ? JSON.parse(t) : {});
      } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  try {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
  } catch { /* 客户端断开等，忽略 */ }
}

// ── P3 网页实时桌宠：任意设备浏览器可看（手机/平板/别的电脑，同局域网） ──
// 页面本身不带任何 token：动画素材经 /pet-media 服务端代理（token 只在宿主内存里）。
const PET_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>🐋 桌宠·实时</title>
<style>
 body{margin:0;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#eef4ff;color:#333;display:flex;flex-direction:column;align-items:center;min-height:100vh}
 h1{font-size:17px;margin:14px 0 4px} .pill{font-size:11px;color:#4a7;border:1px solid #9dc;padding:1px 8px;border-radius:99px;background:#eafff2}
 .pill.off{color:#c66;border-color:#dba;background:#fff2f0}.pill.ok{color:#2c8;border-color:#9dc;background:#eafff2}.pill.unk{color:#889;border-color:#ccd;background:#f4f6fa}
 .fam{width:min(92vw,520px);margin:6px auto 0;font-size:12px;background:#fff;border:1px solid #e3ecf7;border-radius:12px;padding:8px 12px}
 .fam h3{margin:0 0 6px;font-size:12px;color:#667;font-weight:600}
 .fam .fi{display:flex;align-items:center;gap:6px;margin:4px 0}
 .fam .fn{width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#445;flex:none}
 .fam .bar{flex:1;height:7px;background:#eef2f8;border-radius:99px;overflow:hidden}
 .fam .bar i{display:block;height:100%;background:linear-gradient(90deg,#f9a8d4,#f472b6);border-radius:99px}
 .fam .fl{width:76px;text-align:right;color:#99a;font-size:11px;flex:none}
 /* 背景层与立绘层拆开（2026-11-08 持续闪排查）：#stage 只做容器，不再挂渐变/动画；
    背景变化只改 #bg，视频逐帧合成只发生在 #petWrap，父层不会带着背景一起重绘。 */
 #stage{position:relative;width:min(72vw,300px);height:min(72vw,300px);margin:8px 0;border-radius:20px;overflow:hidden;
  background:#eef4ff;box-shadow:0 10px 30px #b9cbe733;transition:opacity .35s ease}
 #stage.fade{opacity:.25}
 #bg{position:absolute;inset:0;z-index:0;background:radial-gradient(circle at 50% 35%,#ffffff,#eef4ff 70%,#e3ecfa);
  background-size:cover;background-position:center;background-repeat:no-repeat;transform:translateZ(0);pointer-events:none}
 #petWrap{position:absolute;inset:0;z-index:1;transition:transform .18s ease-out;will-change:transform}
 .layer{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .32s ease;pointer-events:none}
 .layer.show{opacity:1}
 #fx{position:absolute;left:50%;top:10%;z-index:2;transform:translateX(-50%);font-size:28px;opacity:0;pointer-events:none;filter:drop-shadow(0 2px 6px #0002)}
 #fx.show{animation:fxpop 1.4s ease-out forwards}
 @keyframes fxpop{0%{opacity:0;transform:translate(-50%,12px) scale(.7)}25%{opacity:1;transform:translate(-50%,0) scale(1.05)}100%{opacity:0;transform:translate(-50%,-30px) scale(1.1)}}
 #stateLabel{font-size:12px;color:#5a7;margin-top:-2px;letter-spacing:.5px}
 #opv{width:min(42vw,168px);border-radius:14px;background:#f6f9ff;margin:2px 0 4px;display:none}
 .row{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:4px 10px;max-width:520px}
 button{border:1px solid #bcd;border-radius:99px;background:#fff;padding:6px 14px;font-size:13px;cursor:pointer}
 button.on{background:#3a7;font-weight:700;color:#fff;border-color:#3a7}
 button:active{transform:scale(.96)} #st{font-size:12px;color:#889;margin:8px 12px;text-align:center;line-height:1.6;min-height:38px}
 footer{font-size:11px;color:#aab;margin:10px 16px 18px;text-align:center;line-height:1.7}
</style></head><body>
<h1 id="title">🐋 桌宠·实时</h1><span class="pill" id="pill">零模型 · 纯动作</span> <span class="pill unk" id="botpill">QQ状态 查询中…</span>
<div id="stage"><div id="bg"></div><div id="petWrap"><video id="v0" class="layer" autoplay muted playsinline></video><video id="v1" class="layer" autoplay muted playsinline></video><div id="fx"></div></div></div>
<div id="stateLabel">待机中</div>
<div class="row" id="states"></div><div class="row" id="forms"></div>
<div class="row" id="backgrounds"></div>
<div class="row" id="outfits"></div>
<img id="opv" alt="皮肤预览">
<div class="row"><button id="rnd">🎲 逗逗TA</button></div>
<div id="st">连接中…</div>
<div class="fam" id="fam" style="display:none"></div>
<footer>同一局域网的手机/平板/电脑：直接开 <b>http://&lt;这台电脑的内网IP&gt;:43129/api/qqbot-settings/pet</b><br>
跨外网访问需自建隧道（默认不开，注意隐私）；按钮控制的是这台电脑桌面上的桌宠本体。<br>
<a href="/api/qqbot-settings/interview" target="_blank" style="color:#3a7;font-weight:700;text-decoration:none">教师面试陪练 · 小蓝通话页 →</a></footer>
<script>
var F=null,V0=document.getElementById('v0'),V1=document.getElementById('v1'),act=0,timer=null;
var FX={pet:'💗',talk:'💬',wave:'✨',point:'👉',pickup:'😵',idle:''};
function dirId(){if(F&&F.forms){for(var i=0;i<F.forms.length;i++){if(F.forms[i].active)return F.forms[i].id}}return (F&&F.form&&F.form.id)||'xiaolan'}
var VER=Date.now().toString(36);
function media(f,n){return '/api/qqbot-settings/pet-media?form='+encodeURIComponent(f)+'&name='+encodeURIComponent(n)+'&v='+VER}
function outfitImg(f,o){return '/api/qqbot-settings/pet-outfit-preview?form='+encodeURIComponent(f)+'&outfit='+encodeURIComponent(o)}
function post(b){return fetch('/api/qqbot-settings/pet-anim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()})}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function idleOf(){var ss=(F&&F.states)||[];for(var i=0;i<ss.length;i++){if(ss[i].state==='idle')return ss[i]}return ss[0]||null}
function labelOf(s){var ss=(F&&F.states)||[];for(var i=0;i<ss.length;i++){if(ss[i].state===s)return ss[i].label}return s}
// ── 背景（2026-11-08）：与形态/皮肤完全分开的一条状态线 ─────────────────
// 只改 #bg 的 background-image；不碰 <video>、不重设 src、不调 play()，立绘层零参与。
var BG={current:'none',rev:'',list:[]};
function bgPost(b){return fetch('/api/qqbot-settings/pet-background',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()})}
function bgPaint(id){
 var el=document.getElementById('bg');if(!el)return;
 var hit=null;for(var i=0;i<BG.list.length;i++){if(BG.list[i].id===id)hit=BG.list[i]}
 if(!hit||!hit.url){el.style.backgroundImage='';return}
 var im=new Image();im.decoding='async';
 im.onload=function(){if(BG.current===id)el.style.backgroundImage='url("'+hit.url+'")'};
 im.src=hit.url;
}
function renderBg(){
 var el=document.getElementById('backgrounds');if(!el)return;
 var h='';
 for(var i=0;i<BG.list.length;i++){var b=BG.list[i];h+='<button data-b="'+esc(b.id)+'" class="'+(b.id===BG.current?'on':'')+'">'+esc(b.name)+(b.id===BG.current?' ✓':'')+'</button>'}
 h+='<button id="bgadd" title="扫描电脑上的图片目录">📁 目录</button><button id="bgrescan" title="重新扫描背景">↻</button>';
 el.innerHTML=h;
 Array.prototype.forEach.call(el.querySelectorAll('[data-b]'),function(btn){btn.onclick=function(){
  bgPost({action:'switch',id:btn.dataset.b}).then(function(r){
   if(!r.ok)return st('换背景失败：'+(r.message||r.reason||''));
   BG.current=r.background.id;bgPaint(BG.current);renderBg();st('背景已换为「'+r.background.name+'」');
  });
 }});
 var add=document.getElementById('bgadd');if(add)add.onclick=function(){
  var dir=prompt('输入电脑上的图片目录（绝对路径，支持 png/jpg/webp/gif/svg）：');
  if(!dir)return;
  bgPost({action:'add-dir',dir:dir}).then(function(r){
   if(!r.ok)return st('添加目录失败：'+(r.message||r.reason||''));
   loadBg(true);st('已加入背景目录：'+dir);
  });
 };
 var rs=document.getElementById('bgrescan');if(rs)rs.onclick=function(){loadBg(true)};
}
function loadBg(force){
 fetch('/api/qqbot-settings/pet-background').then(function(r){return r.json()}).then(function(j){
  if(!j.ok)return;
  if(!force&&j.rev===BG.rev)return;
  BG.rev=j.rev;BG.current=j.current;BG.list=j.backgrounds||[];
  renderBg();bgPaint(BG.current);
 }).catch(function(){})}

function play(name,loop,fx){
 if(!name)return;
 var nxt=(act?V0:V1),cur=(act?V1:V0);
 nxt.loop=!!loop;nxt.muted=true;
 // 同一个动画不重设 src（旧版每次都换源 → 浏览器重载 → 闪）
 if(nxt.dataset.n!==name||!nxt.getAttribute('src')){nxt.dataset.n=name;nxt.src=media(dirId(),name)}
 nxt.classList.add('show');cur.classList.remove('show');act=1-act;
 try{nxt.play()}catch(e){}
 var f=document.getElementById('fx');f.textContent=fx||'';f.classList.remove('show');void f.offsetWidth;if(fx)f.classList.add('show');
}
function idleSoon(ms){if(timer)clearTimeout(timer);timer=setTimeout(function(){var i=idleOf();if(i){play(i.anim,true,'');var l=document.getElementById('stateLabel');if(l)l.textContent='待机中'}},ms)}
function render(){document.getElementById('title').textContent=F.formEmoji+' 桌宠·实时（'+esc(F.formLabel)+'）';
 var sh='';for(var i=0;i<F.states.length;i++){var s=F.states[i];sh+='<button data-s="'+esc(s.state)+'" data-a="'+esc(s.anim)+'">'+esc(s.label)+'</button>'}
 document.getElementById('states').innerHTML=sh;
 var fh='';for(var i2=0;i2<F.forms.length;i2++){var x=F.forms[i2];fh+='<button data-f="'+esc(x.id)+'" class="'+(x.active?'on':'')+'">'+esc(x.emoji+' '+x.label)+(x.active?' ✓':'')+'</button>'}
 document.getElementById('forms').innerHTML=fh;
 var outs=F.outfits||[];var oh='';var activeO=null;
 for(var k=0;k<outs.length;k++){var o=outs[k];if(o.active)activeO=o;oh+='<button data-o="'+esc(o.id)+'" class="'+(o.active?'on':'')+'">'+esc(o.name)+(o.active?' ✓':'')+'</button>'}
 document.getElementById('outfits').innerHTML=oh;
 var pv=document.getElementById('opv');
 if(activeO&&activeO.built){pv.src=outfitImg(dirId(),activeO.id);pv.style.display='block'}else{pv.style.display='none'}
 Array.prototype.forEach.call(document.getElementById('outfits').children,function(b){b.onclick=function(){st('换皮肤…');post({action:'switch-outfit',form:dirId(),outfit:b.dataset.o}).then(function(r){st(r.ok?('已换皮肤「'+(r.label||b.dataset.o)+'」'):'换皮肤失败');load()})}});
 Array.prototype.forEach.call(document.getElementById('states').children,function(b){b.onclick=function(){
  var s=b.dataset.s;st('她在'+labelOf(s)+'…');document.getElementById('stateLabel').textContent=labelOf(s);
  play(b.dataset.a,s==='idle',FX[s]||'');
  post({action:'state',state:s,form:dirId()}).then(function(r){if(!r.ok)st('触发失败：'+(r.message||r.reason||''))});
  if(s!=='idle')idleSoon(1900);
 }});
 Array.prototype.forEach.call(document.getElementById('forms').children,function(b){b.onclick=function(){
  st('换角中…');document.getElementById('stage').classList.add('fade');
  post({action:'switch-form',target:b.dataset.f}).then(function(r){
   st(r.ok?('已切换为『'+(r.label||b.dataset.f)+'』'):'切换失败');
   setTimeout(function(){document.getElementById('stage').classList.remove('fade');load(true)},r.ok?800:0);
  })}});
}
function st(t){var e=document.getElementById('st');var s=String(t==null?'':t);if(e.dataset.t===s)return;e.dataset.t=s;e.textContent=s}
function load(force){fetch('/api/qqbot-settings/pet-anim').then(function(r){return r.json()}).then(function(j){
 if(!j.ok)return st('桌宠接口没就绪');
 var same=!!F&&F.rev===j.rev;
 F={form:j.form,formLabel:j.form.label,formEmoji:j.form.emoji,forms:j.forms,states:j.states||[],anims:j.anims||[],outfits:j.outfits||[],rev:j.rev||''};
 if(!same)render();
 if(force||(!V0.dataset.n&&!V1.dataset.n)){var i=idleOf();if(i)play(i.anim,true,'')}
 st('当前形态：'+j.form.label+' · 自动同步（待机不重载）');
}).catch(function(){st('连不上桌宠服务（宿主没开？）')})}
document.getElementById('rnd').onclick=function(){st('随机来一个…');post({action:'random'}).then(function(r){
 if(r.ok){st('桌面已随机做动作');if(r.anim)play(r.anim,false,'✨');idleSoon(2400)}else st('触发失败');
})};
// ── 眼神跟随（2026-10-31 主人要求）：webm 是整段烘焙的视频，眼珠没法单独动，
//     用「身体朝光标微倾 + 平视跟随」模拟她在看你 —— 鼠标移到哪，她就往哪凑。
//     触屏设备没有 mousemove，自动无感跳过；真正的眼球级跟随要分层模型（见重绘方案）。
//     只倾立绘层（#petWrap）；#bg 保持静止，背景不跟着视频合成一起动。
(function(){var v=document.getElementById('petWrap');if(!v||!window.matchMedia||!window.matchMedia('(pointer:fine)').matches)return;
 document.addEventListener('mousemove',function(e){var r=v.getBoundingClientRect();if(!r.width)return;
  var dx=(e.clientX-(r.left+r.width/2))/Math.max(160,window.innerWidth/2),dy=(e.clientY-(r.top+r.height/2))/Math.max(160,window.innerHeight/2);
  dx=Math.max(-1,Math.min(1,dx));dy=Math.max(-1,Math.min(1,dy));
  v.style.transform='translate('+(dx*10).toFixed(1)+'px,'+(dy*7).toFixed(1)+'px) rotate('+(dx*3.5).toFixed(2)+'deg)';},{passive:true});
 document.addEventListener('mouseleave',function(){v.style.transform=''});})();
// ── QQ bot 在线状态 + 好感度榜（2026-10-31 主人要求）：10 秒轮询 pet-status
// 2026-11-08：轮询只在内容真变时才写 DOM —— 旧版每 10 秒无条件重写 #botpill/#fam，
// 会让舞台下方容器反复重排（父容器重排会把背景层带去重绘）。
function pillSet(p,cls,txt){var k=cls+'|'+txt;if(p.dataset.k===k)return;p.dataset.k=k;p.className=cls;p.textContent=txt}
function botpoll(){fetch('/api/qqbot-settings/pet-status').then(function(r){return r.json()}).then(function(j){
  var p=document.getElementById('botpill');if(!p)return;
  if(!j.ok){pillSet(p,'pill unk','QQ状态 未知')}
  else{var t=j.at?new Date(j.at).toLocaleTimeString('zh-CN',{hour12:false}):'';
   if(j.online){pillSet(p,'pill ok','🟢 QQ 在线'+(t?' · '+t:''))}
   else{pillSet(p,'pill off','🔴 QQ 离线'+(t?' · '+t:''))}}
  var fm=j.fam||[],fe=document.getElementById('fam');if(!fe)return;
  if(!fm.length){if(fe.dataset.k!=='none'){fe.dataset.k='none';fe.style.display='none'}return}
  var h='<h3>💗 好感度 · 累计分（不衰减 · 互动越多越亲）</h3>';
  for(var k=0;k<fm.length;k++){var x=fm[k];
   var nm=x.name?esc(x.name):('用户'+esc(String(x.id).slice(-4)));
   h+='<div class="fi" title="互动 '+x.talk+' 次'+(x.daysIdle>0?(' · 已 '+x.daysIdle+' 天没聊'):'')+'">'
    +'<span class="fn">'+nm+'</span>'
    +'<span class="bar"><i style="width:'+Math.max(3,Math.min(100,x.s))+'%"></i></span>'
    +'<span class="fl">'+esc(x.levelLabel)+' '+x.s+'</span></div>';}
  if(fe.dataset.k===h)return;
  fe.dataset.k=h;fe.style.display='';fe.innerHTML=h}).catch(function(){var p=document.getElementById('botpill');if(p)pillSet(p,'pill unk','QQ状态 未知')})}
botpoll();setInterval(botpoll,10000);
load();setInterval(load,5000);loadBg();

</script></body></html>`;

const PET_MEDIA_PETIDS = { xiaolan: 'xiaolan', classic: 'classic', de: 'de', muu: 'main' }; // 形态→dsh-pet petId 白名单

// ── 邀请共享（2026-11-01 主人要求：陪玩界面提供密钥/免密钥两个入口）──────────
const GATE_SEC = () => join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'pet-gate', 'secrets.json');
function readGateSecrets() {
  try {
    const j = JSON.parse(readFileSync(GATE_SEC(), 'utf8'));
    return j && j.cloudUrl ? j : null;
  } catch { return null; }
}
/** 云端管理通道（同 agent.mjs 的平台 cookie 引导）：adminKey 只在本机内存 */
async function cloudAdmin(sec, path, bodyObj) {
  // 2026-11-01 修 403：平台门要求每个请求都带 sharecode（否则「链接不完整」403）。
  // ① admin URL 直接拼 sharecode（根治）；② 引导请求 redirect:'manual'，接住 302 那一跳种的
  //    平台 cookie（原来默认跟随重定向，最终响应里没有 set-cookie，cookie 永远为空）。
  const base = String(sec.cloudUrl || '').split('?')[0];
  const sharecode = (String(sec.cloudUrl || '').split('sharecode=')[1] || '').split('&')[0];
  let cookie = '';
  try {
    const boot = await fetch(`${base}/?sharecode=${sharecode}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const sc = boot.headers.getSetCookie ? boot.headers.getSetCookie() : [];
    cookie = sc.map((c) => c.split(';')[0]).join('; ');
  } catch { /* 门没过就直连 */ }
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${base}${path}${sep}sharecode=${sharecode}`, {
    method: 'POST',
    headers: { 'x-admin-key': sec.adminKey, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(bodyObj || {}),
    signal: AbortSignal.timeout(15000),
  });
  return r.json().catch(() => ({ ok: false, message: `http-${r.status}` }));
}

function attach(serverCtx) {
  try {
    const ws = serverCtx && serverCtx.webServer;
    if (!ws || typeof ws.register !== 'function') {
      console.warn('[pet-panel] 宿主没有 webServer，浮窗陪玩页不可用');
      return;
    }
    const dispose = ws.register({
      kind: 'exact',
      path: '/api/qqbot-settings/pet-anim',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const form = (await currentForm().catch(() => 'xiaolan')) || 'xiaolan';
            const f = FORMS[form] || FORMS.xiaolan;
            const petOn = await petVisibility().catch(() => null);
            const outfits = outfitSummary(DATA_ROOT).filter((x) => x.form === form);
            return sendJson(res, 200, {
              ok: true,
              // key = 注册表键（xiaolan/classic/de/muu）；id = dsh-pet 的 petId（muu 是 main）
              form: { id: f.id, key: form, label: f.label, emoji: f.emoji },
              forms: FORM_IDS.map((id) => ({
                id,
                label: FORMS[id].label,
                emoji: FORMS[id].emoji,
                petId: FORMS[id].id,
                active: id === form,
              })),
              anims: f.anims,
              // 四态语义（前端按钮直接用；只有该形态真有素材的才出现）
              states: stateList(form),
              pool: (f.randomPool || []).map((x) => (typeof x === 'string' ? { name: x, label: x } : { name: x.name, label: x.label || x.name })),
              outfits,
              petOn,
              // 稳定快照：只有形态/开关/动作表/皮肤真变时才变 —— 前端据此跳过重绘
              rev: formRev({ form, petOn: petOn !== false, anims: f.anims, outfits }),
            });
          }
          if (req.method === 'POST') {
            let body = {};
            try { body = await readJsonBody(req); } catch { body = {}; }
            // 切形态
            if (body.action === 'switch-form') {
              const r = await switchForm(body.target);
              return sendJson(res, 200, r.ok ? { ...r } : r);
            }
            // 换皮肤：只影响形象卡/预览，不动桌宠本体动画，也不影响另一形态
            if (body.action === 'switch-outfit') {
              const form = String(body.form || body.target || 'xiaolan');
              const outfit = String(body.outfit || '');
              const r = setOutfit(DATA_ROOT, form, outfit);
              const meta = outfitInfo(form, outfit);
              return sendJson(res, 200, r.ok
                ? { ok: true, form, outfit, label: meta?.name || outfit, message: `皮肤已切换为「${meta?.name || outfit}」，形象卡下次生成生效` }
                : { ok: false, reason: r.reason || 'bad-outfit' });
            }
            // 桌宠显隐总开关（2026-11-01 主人要求：浮窗陪玩页可开/关桌宠）
            if (body.action === 'pet-display') {
              const on = body.on !== false;
              const r = on ? await showPet() : await hideAllPets();
              return sendJson(res, 200, on
                ? { ok: !!r.ok, label: r.label || '', message: r.ok ? `桌宠已开启（${r.label || '小蓝'}）` : (r.message || '开启失败') }
                : { ok: !!r.ok, message: r.ok ? '桌宠已关闭（随时可再开启）' : '关闭失败' });
            }
            // 四态语义：idle/pet/talk/wave → 当前形态对应素材（前端只认这四个状态）
            if (body.action === 'state') {
              const state = String(body.state || 'idle');
              const fid = String(body.form || (await currentForm()) || 'xiaolan');
              if (!FORMS[fid]) return sendJson(res, 200, { ok: false, reason: 'unknown-form', message: `不认识的形态: ${fid}` });
              const anim = stateAnim(fid, state);
              const r = await petAnim(anim, { form: fid });
              return sendJson(res, 200, r.ok ? { ...r, state, anim } : r);
            }
            // 随机 / 按动画名 / 按 label（浮窗按钮传 name，兼容 label）
            let target = null;
            if (body.action === 'random') {
              target = await randomAnim();
            } else if (body.name) {
              target = await animByLabel(String(body.name)) || { name: String(body.name) };
            }
            if (!target || !target.name) {
              return sendJson(res, 200, { ok: false, reason: 'bad-request', message: '需要 {name:"小蓝-挥手"} / {action:"random"} / {action:"switch-form",target:"muu"}' });
            }
            const r = await petAnim(target.name);
            return sendJson(res, 200, r.ok
              ? { ...r, anim: target.name }
              : r);
          }
          return sendJson(res, 200, { ok: false, reason: 'method-not-allowed', message: '只支持 GET/POST' });
        } catch (e) {
          return sendJson(res, 200, { ok: false, reason: 'internal', message: String((e && e.message) || e) });
        }
      },
    });
    // ── P3 网页实时桌宠（免认证前缀内；页面零 token，素材走服务端代理） ──
    try {
      ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/pet',
        handler: async (req, res) => {
          try {
            const buf = Buffer.from(PET_PAGE, 'utf8');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': buf.length });
            res.end(buf);
          } catch { /* 客户端断开等，忽略 */ }
        },
      });
      // 动画素材代理：dsh token 只留在宿主侧，任何客户端都看不到
      ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/pet-media',
        handler: async (req, res) => {
          const notFound = (msg) => {
            try {
              const b = Buffer.from(JSON.stringify({ ok: false, message: msg }), 'utf8');
              res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
              res.end(b);
            } catch { /* ignore */ }
          };
          try {
            const u = new URL(req.url, 'http://localhost');
            const form0 = u.searchParams.get('form') || 'xiaolan';
            const form = form0 === 'main' ? 'muu' : form0; // 兼容：旧页面把大肥鱼的 petId(main) 当 form 传
            const name = (u.searchParams.get('name') || '').trim();
            const petId = PET_MEDIA_PETIDS[form];
            if (!petId || !name || name.length > 80) return notFound('需要 form(xiaolan|classic|de|muu) 与 name');
            let ep = webEndpoint();
            if (!ep) return notFound('桌宿没启动');
            const call = (e2) => fetch(`http://127.0.0.1:${e2.port}/dsh-pet-7340/thumb/${encodeURIComponent(petId)}/${encodeURIComponent(name)}.webm?token=${encodeURIComponent(e2.token)}`, { signal: AbortSignal.timeout(10000) });
            let r = await call(ep);
            if (r.status === 401 || r.status === 403) {
              ep = webEndpoint(true);
              if (!ep) return notFound('token 刷新失败');
              r = await call(ep);
            }
            if (!r.ok) return notFound(`素材不存在（http-${r.status}）`);
            const buf = Buffer.from(await r.arrayBuffer());
            // 素材会被重新烘焙（同名换内容），长缓存会让页面继续播旧文件；短缓存 + 页面侧 v 参数即可拿到新素材
            res.writeHead(200, { 'content-type': 'video/webm', 'cache-control': 'private, max-age=60', 'content-length': buf.length });
            res.end(buf);
          } catch { return notFound('代理失败'); }
        },
      });
      // 皮肤预览图：只按 manifest 里的 form/outfit 取名，不接受任意路径
      ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/pet-outfit-preview',
        handler: async (req, res) => {
          const fail = (code, msg) => {
            try {
              const b = Buffer.from(JSON.stringify({ ok: false, message: msg }), 'utf8');
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
              res.end(b);
            } catch { /* ignore */ }
          };
          try {
            const u = new URL(req.url, 'http://localhost');
            const form = u.searchParams.get('form') || 'xiaolan';
            const outfit = u.searchParams.get('outfit') || 'default';
            if (!outfitInfo(form, outfit)) return fail(404, '没有这个皮肤');
            const file = outfitPreviewPath(form, outfit);
            const buf = readFileSync(file);
            // 2026-11-08：重烘焙后旧预览会在浏览器里缓存 1 小时（主人看到的还是鲸鱼图标）。
            // 缩到 1 分钟：重新生成皮肤后自动换新，不用让主人手动清缓存。
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=60', 'content-length': buf.length });
            return res.end(buf);
          } catch { return fail(404, '皮肤预览不存在'); }
        },
      });
      // 背景图清单/切换（2026-11-08）：状态落 data/pet-backgrounds.json，
      // 与形态（dsh-pet 配置）、皮肤（pet-outfits.json）互不影响。
      ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/pet-background',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              return sendJson(res, 200, { ok: true, ...listBackgrounds(DATA_ROOT) });
            }
            if (req.method === 'POST') {
              const body = await readJsonBody(req).catch(() => ({}));
              if (body.action === 'switch') {
                return sendJson(res, 200, setBackground(DATA_ROOT, body.id));
              }
              if (body.action === 'add-dir') {
                const r = addDir(DATA_ROOT, body.dir);
                return sendJson(res, 200, { ...r, ...listBackgrounds(DATA_ROOT) });
              }
              if (body.action === 'remove-dir') {
                const r = removeDir(DATA_ROOT, body.dir);
                return sendJson(res, 200, { ...r, ...listBackgrounds(DATA_ROOT) });
              }
              if (body.action === 'rescan') {
                return sendJson(res, 200, { ok: true, ...listBackgrounds(DATA_ROOT) });
              }
              return sendJson(res, 200, { ok: false, message: '需要 {action:"switch",id} / add-dir / remove-dir / rescan' });
            }
            return sendJson(res, 200, { ok: false, reason: 'method-not-allowed' });
          } catch (e) {
            return sendJson(res, 200, { ok: false, message: String((e && e.message) || e) });
          }
        },
      });
      // 背景图片本体：只认 listBackgrounds 生成的 id，且文件必须在允许目录内（防任意路径读取）
      ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/pet-background-image',
        handler: async (req, res) => {
          const fail = () => {
            try {
              const b = Buffer.from(JSON.stringify({ ok: false, message: '背景图不存在' }), 'utf8');
              res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
              res.end(b);
            } catch { /* ignore */ }
          };
          try {
            const u = new URL(req.url, 'http://localhost');
            const file = resolveImage(u.searchParams.get('id') || '', DATA_ROOT);
            if (!file) return fail();
            const buf = readFileSync(file);
            res.writeHead(200, { 'content-type': contentTypeOf(file), 'cache-control': 'private, max-age=60', 'content-length': buf.length });
            return res.end(buf);
          } catch { return fail(); }
        },
      });
      // QQ bot 在线状态（v5 2026-10-31 主人反馈"无效"）：首选 bootstrap 事件驱动落盘的
      // bot-status.json（ws ready/error 即写，不再猜日志）；日志扫尾只做文件缺失时的兜底。
      ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/pet-status',
        handler: async (_req, res) => {
          try {
            const fam = await topFamiliarity(DATA_ROOT, { limit: 6 }).catch(() => []);
            const st = botStatusFromFile();
            if (st) return sendJson(res, 200, { ok: true, online: st.online, at: st.at, stale: false, fam });
            const last = botOnlineFromLog();
            if (!last) return sendJson(res, 200, { ok: true, online: false, at: '', stale: true, fam });
            const ageMs = Date.now() - (Date.parse(last.at) || 0);
            // 日志里最后一次 ready 若太久远（>12h 且期间无任何新事件），标 stale 供前端显示"未知"
            const stale = last.ok && ageMs > 12 * 3600 * 1000;
            sendJson(res, 200, { ok: true, online: !!last.ok && !stale, at: last.at, stale, fam });
          } catch { sendJson(res, 200, { ok: false }); }
        },
      });
    } catch { /* 重复注册等，忽略 */ }

    // ── 邀请共享：陪玩页「🔗 邀请」卡接口（密钥显示 + 免密钥开关 + 重置席位）──
    try {
      ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/pet-share',
        handler: async (req, res) => {
          try {
            const sec = readGateSecrets();
            if (!sec) return sendJson(res, 200, { ok: false, message: 'pet-gate/secrets.json 不存在（网关还没部署过）' });
            if (req.method === 'GET') {
              // 云端实时状态（免密钥开关/席位占用）；拉不到就用本地 secrets 兜底
              const live = sec.adminKey ? await cloudAdmin(sec, '/admin/status', {}).catch(() => null) : null;
              return sendJson(res, 200, {
                ok: true,
                url: sec.cloudUrl || '',
                key: sec.accessKey || '',
                freeMode: live ? live.freeMode === true : sec.freeMode === true,
                seatsUsed: live ? live.seatsUsed : null,
                seatsMax: live ? live.seatsMax : (sec.seats || 1),
              });
            }
            if (req.method === 'POST') {
              const body = await readJsonBody(req).catch(() => ({}));
              if (body.action === 'free-mode') {
                const r = await cloudAdmin(sec, '/admin/free-mode', { on: body.on === true });
                return sendJson(res, 200, r);
              }
              if (body.action === 'reset-seat') {
                const r = await cloudAdmin(sec, '/admin/reset-seat', {});
                return sendJson(res, 200, r);
              }
              return sendJson(res, 200, { ok: false, message: '需要 action: free-mode / reset-seat' });
            }
            return sendJson(res, 200, { ok: false });
          } catch (e) {
            return sendJson(res, 200, { ok: false, message: String((e && e.message) || e) });
          }
        },
      });
    } catch { /* 重复注册等，忽略 */ }

    if (typeof dispose === 'function') console.log('[pet-panel] /api/qqbot-settings/pet-anim + /pet + /pet-media + /pet-status + /pet-share 已挂载（v6：邀请共享+四形态）');
    // 桌宠右键菜单「更多」里挂「变小蓝/变大肥鱼」（dsh-pet 官方第三方菜单扩展点，长轮询消费点击）
    ensurePetMenu();
  } catch (e) {
    console.warn('[pet-panel] 挂载失败:', String((e && e.message) || e));
  }
}

export async function run(env = {}) {
  const { ctx } = env;
  if (!ctx) return;
  // 首选：等宿主的 webServer 服务就绪再挂（与 llm-panel 同款纪律）
  try {
    ctx.inject(['webServer'], (serverCtx) => attach(serverCtx));
  } catch { /* inject 不可用就走兜底 */ }
  // 兜底：webServer 已经在了就直接挂（重复注册由宿主按路径去重/覆盖）
  try {
    if (ctx.webServer) attach(ctx);
  } catch { /* ignore */ }
  // 启动自校正：重启 harness 后配置层可能漂移（两形态都在/都不在），等 dsh-pet 起稳后
  // 按用户最后选的形态（偏好落盘）修正一次 —— 同一时刻桌面只显示一只的纪律不因重启而破。
  setTimeout(() => {
    (async () => {
      const pref = loadFormPreference();
      if (!pref) return;
      const cur = await currentForm({ force: true }).catch(() => null);
      if (cur && cur !== pref) {
        const r = await switchForm(pref).catch(() => null);
        console.log(`[pet-panel] 启动形态自校正: ${cur} → ${pref} ${r && r.ok ? '✔' : '✗'}`);
      }
    })().catch(() => { /* 自校正失败不打扰启动 */ });
  }, 8000);
}

export async function dispose() { /* 宿主随插件卸载，无需手动摘除 */ }
