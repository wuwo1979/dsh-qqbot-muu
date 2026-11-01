/**
 * pet-gate/gate-page.mjs — 网关的登录页与桌宠页（pet-panel v5 页面的公网适配版）
 * 差异：素材优先 /media/<form>/<名>.webm 静态直出（随包分发，快），404 自动回退中继。
 */

export function loginHtml(free) {
  const freeHint = free
    ? '<p style="color:#2c8;font-weight:600">当前为免密钥邀请模式，直接点「进入」即可</p>'
    : '<p>凭访问码进入（一人在线）。看她在桌面上卖萌、点按钮逗她；不用装任何东西。</p>';
  const input = free ? '' : '<input id="k" type="password" placeholder="访问码" autocomplete="off">';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🐋 桌宠 · 访问入口</title>
<style>
 body{margin:0;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#eef4ff;display:flex;align-items:center;justify-content:center;min-height:100vh}
 .card{background:#fff;border:1px solid #dfe8f5;border-radius:16px;padding:26px 24px;width:min(88vw,340px);box-shadow:0 6px 24px rgba(80,120,200,.08)}
 h1{font-size:17px;margin:0 0 6px} p{font-size:12px;color:#889;margin:0 0 14px;line-height:1.6}
 input{width:100%;box-sizing:border-box;border:1px solid #c9d6ea;border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:10px}
 button{width:100%;border:0;border-radius:10px;background:#3a7df0;color:#fff;padding:10px 0;font-size:14px;cursor:pointer}
 button:active{transform:scale(.98)} #msg{font-size:12px;color:#c66;margin-top:10px;min-height:16px;text-align:center}
</style></head><body><div class="card">
<h1>🐋 桌宠·实时</h1>${freeHint}
${input}
<button id="go">进入</button><div id="msg"></div>
</div><script>
document.getElementById('go').onclick=function(){var k=(document.getElementById('k')||{value:''}).value.trim();
 document.getElementById('msg').textContent='验证中…';
 fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})})
 .then(function(r){return r.json().then(function(j){return {s:r.status,j:j}})})
 .then(function(o){if(o.j&&o.j.ok){location.href='/watch?v=1101c2&t='+Date.now()}else{document.getElementById('msg').textContent=(o.j&&o.j.message)||('失败('+o.s+')')}})
 .catch(function(){document.getElementById('msg').textContent='网络异常，稍后再试'})};
var kEl=document.getElementById('k');if(kEl)kEl.addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('go').click()});
${free ? 'document.getElementById(\'go\').click();' : ''}
</script></body></html>`;
}
export const LOGIN_HTML = loginHtml(false); // 兼容旧引用；server 侧用 loginHtml(SEC.freeMode)

export const PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
<title>🐋 桌宠·实时</title>
<style>
 body{margin:0;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#eef4ff;color:#333;display:flex;flex-direction:column;align-items:center;min-height:100vh}
 h1{font-size:18px;margin:16px 0 6px} .pill{font-size:11px;color:#4a7;border:1px solid #9dc;padding:2px 10px;border-radius:99px;background:#eafff2;margin:0 3px}
 .pill.off{color:#c66;border-color:#dba;background:#fff2f0}.pill.ok{color:#2c8;border-color:#9dc;background:#eafff2}.pill.unk{color:#889;border-color:#ccd;background:#f4f6fa}
 .fam{width:min(92vw,520px);margin:6px auto 0;font-size:12px;background:#fff;border:1px solid #e3ecf7;border-radius:12px;padding:8px 12px}
 .fam h3{margin:0 0 6px;font-size:12px;color:#667;font-weight:600}
 .fam .fi{display:flex;align-items:center;gap:6px;margin:4px 0}
 .fam .fn{width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#445;flex:none}
 .fam .bar{flex:1;height:7px;background:#eef2f8;border-radius:99px;overflow:hidden}
 .fam .bar i{display:block;height:100%;background:linear-gradient(90deg,#f9a8d4,#f472b6);border-radius:99px}
 .fam .fl{width:76px;text-align:right;color:#99a;font-size:11px;flex:none}
 video{width:min(78vw,340px);height:min(78vw,340px);object-fit:contain;background:linear-gradient(160deg,#f6f9ff,#eaf2ff);border-radius:24px;margin:10px 0 6px;box-shadow:0 8px 28px rgba(90,130,220,.14);transition:transform .18s ease-out;will-change:transform}
 .row{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:4px 10px;max-width:520px}
 button{border:1px solid #bcd;border-radius:99px;background:#fff;padding:6px 14px;font-size:13px;cursor:pointer}
 button.on{background:#3a7;font-weight:700;color:#fff;border-color:#3a7}
 button:active{transform:scale(.96)} #st{font-size:12px;color:#889;margin:6px 12px;text-align:center;line-height:1.6;min-height:18px}
 footer{font-size:11px;color:#aab;margin:10px 16px 18px;text-align:center;line-height:1.7}
</style></head><body>
<h1 id="title">🐋 桌宠·实时</h1><span class="pill" id="pill">零模型 · 纯动作</span> <span class="pill unk" id="botpill">QQ状态 查询中…</span>
<video id="v" autoplay loop muted playsinline x5-playsinline webkit-playsinline preload="auto"></video>
<div class="row" id="forms"></div><div class="row" id="anims"></div><div class="row" id="pool"></div>
<div class="row"><button id="rnd">🎲 逗逗TA</button></div>
<div id="st">连接中…</div>
<div class="fam" id="fam" style="display:none"></div>
<footer style="opacity:.85">私享链接：访问码只给一个人，重置后旧会话立即失效。<br>她在那台电脑的桌面上同步做动作 · 按钮随时逗她</footer>
<script>
var F=null;var V=document.getElementById('v');
function dirId(){if(F&&F.forms){for(var i=0;i<F.forms.length;i++){if(F.forms[i].active)return F.forms[i].id}}return (F&&F.form&&F.form.id)||'xiaolan'}
var DRAG={muu:'被鼠标拖拽悬空反馈',xiaolan:'小蓝-被拎起',classic:'小蓝-被拎起'};
function allAnims(){return (F.anims||[]).concat(F.pool||[])}
function randPlay(tag){var a=allAnims();if(!a.length)return;var x=a[Math.floor(Math.random()*a.length)];useMedia(dirId(),x.name);try{V.currentTime=0}catch(e){}V.play&&V.play();post({name:x.name}).then(function(r){st(r.ok?((tag||'桌面已做')+'『'+(x.label||x.name)+'』'):(r.message||'触发失败'))})}
function media(f,n){var ok=false;try{ok=!!(V&&V.canPlayType&&String(V.canPlayType('video/webm; codecs="vp9"')).replace(/no/g,''))}catch(e){};var ext=ok?'webm':'mp4';return '/media/'+encodeURIComponent(f)+'/'+encodeURIComponent(n)+'.'+ext}
function relayMedia(f,n){return '/api/qqbot-settings/pet-media?form='+encodeURIComponent(f)+'&name='+encodeURIComponent(n)}
function useMedia(f,n){var u=media(f,n);if(V.dataset.src===u)return;V.dataset.src=u;V.dataset.n=n;
 V.onerror=function(){V.onerror=null;V.dataset.src='';st('⚠ 画面加载失败：'+u+(u.indexOf('.webm')>0?'（尝试 MP4 兑底）':'（中继也不行？）'));
  if(u.indexOf('.webm')>0){V.src=media(f,n).replace('.webm','.mp4')}else{V.src=relayMedia(f,n)}};V.src=u}
function post(b){return fetch('/api/qqbot-settings/pet-anim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){
 if(r.status===401){location.href='/';throw new Error('relogin')}return r.json()})}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function render(){var f=F.form||'xiaolan';document.getElementById('title').textContent=F.formEmoji+' 桌宠·实时（'+esc(F.formLabel)+'）';
 var fh='';for(var i=0;i<F.forms.length;i++){var x=F.forms[i];fh+='<button data-f="'+esc(x.id)+'" class="'+(x.active?'on':'')+'">'+esc(x.emoji+' '+x.label)+(x.active?' ✓':'')+'</button>'}
 document.getElementById('forms').innerHTML=fh;
 var ah='';for(var j=0;j<F.anims.length;j++){var a=F.anims[j];ah+='<button data-n="'+esc(a.name)+'">'+esc(a.label)+'</button>'}
 document.getElementById('anims').innerHTML=ah;
 var ph='';for(var k=0;k<(F.pool||[]).length;k++){var p2=F.pool[k];ph+='<button data-n="'+esc(p2.name)+'">✨ '+esc(p2.label||p2.name)+'</button>'}
 document.getElementById('pool').innerHTML=ph;
 if(!V.dataset.src)useMedia(dirId(),F.anims[0].name);
 Array.prototype.forEach.call(document.getElementById('forms').children,function(b){b.onclick=function(){st('切换中…');post({action:'switch-form',target:b.dataset.f}).then(function(r){st(r.ok?('已切换为『'+(r.label||b.dataset.f)+'』'):(r.message||'切换失败'));load()})}});
 Array.prototype.forEach.call(document.getElementById('anims').children,function(b){b.onclick=function(){st('做了动作：'+b.textContent);useMedia(dirId(),b.dataset.n);try{V.currentTime=0}catch(e){}V.play&&V.play();post({name:b.dataset.n}).then(function(r){st(r.ok?('桌面已做『'+b.textContent+'』'):(r.message||'触发失败'))})}});
 Array.prototype.forEach.call(document.getElementById('pool').children,function(b){b.onclick=function(){var lb=b.textContent.replace('✨ ','');st('做了动作：'+lb);useMedia(dirId(),b.dataset.n);try{V.currentTime=0}catch(e){}V.play&&V.play();post({name:b.dataset.n}).then(function(r){st(r.ok?('桌面已做『'+lb+'』'):(r.message||'触发失败'))})}});
}
function st(t){document.getElementById('st').textContent=t}
function load(){fetch('/api/qqbot-settings/pet-anim').then(function(r){if(r.status===401){location.href='/';throw new Error('relogin')}return r.json()}).then(function(j){if(!j.ok)return st(j.message||'桌宠接口没就绪（她可能关机了）');var changed=!F||F.form.id!==j.form.id;if(changed){F={form:j.form,formLabel:j.form.label,formEmoji:j.form.emoji,forms:j.forms,anims:j.anims,pool:j.pool||[]};V.dataset.src='';V.dataset.n='';V.removeAttribute('src');V.load&&V.load();render();}var base='当前形态：'+j.form.label+' · 每5秒自动同步';
  // 画面诊断（2026-11-01）：截图就能定位视频问题
  if(V.error&&V.error.code){st(base+'｜⚠ 视频解码失败 code='+V.error.code+' src='+V.dataset.src)}
  else if(V.dataset.src&&V.readyState>=2){st(base+'｜画面 OK（'+(V.dataset.src.split('.').pop())+'）')}
  else if(V.dataset.src){st(base+'｜画面加载中… '+V.dataset.src+'（超过 15 秒还空白就刷新重进）')}
  else{st(base)}
 }).catch(function(e){if(e.message!=='relogin')st('连不上桌宠服务（主人电脑没开？）')})}
document.getElementById('rnd').onclick=function(){st('随机来一个…');post({action:'random'}).then(function(r){st(r.ok?'桌面已随机做动作':(r.message||'触发失败'))})};
(function(){var v=document.getElementById('v');if(!v||!window.matchMedia||!window.matchMedia('(pointer:fine)').matches)return;
 document.addEventListener('mousemove',function(e){var r=v.getBoundingClientRect();if(!r.width)return;
  var dx=(e.clientX-(r.left+r.width/2))/Math.max(160,window.innerWidth/2),dy=(e.clientY-(r.top+r.height/2))/Math.max(160,window.innerHeight/2);
  dx=Math.max(-1,Math.min(1,dx));dy=Math.max(-1,Math.min(1,dy));
  v.style.transform='translate('+(dx*10).toFixed(1)+'px,'+(dy*7).toFixed(1)+'px) rotate('+(dx*3.5).toFixed(2)+'deg)';},{passive:true});
 document.addEventListener('mouseleave',function(){v.style.transform=''});})();
// ── 拎起交互（2026-11-01 主人要求：web 手感向 dsh-pet 看齐）──
// 按住她 = 拎起动画悬空；松手 = 随机整活（模拟 dsh-pet 的拎起/扔物理感）。触屏同样生效。
(function(){var v=document.getElementById('v');if(!v)return;var held=false;
 v.addEventListener('pointerdown',function(e){if(!F||!F.anims||!F.anims.length)return;held=true;try{v.setPointerCapture&&v.setPointerCapture(e.pointerId)}catch(eC){}
  var da=DRAG[dirId()];if(da){useMedia(dirId(),da);v.style.transform='translateY(-10px) scale(1.05)';post({name:da}).then(function(){})}});
 var up=function(){if(!held)return;held=false;v.style.transform='';setTimeout(randPlay,250)};
 v.addEventListener('pointerup',up);v.addEventListener('pointercancel',up);window.addEventListener('pointerup',up);})();
function botpoll(){fetch('/api/qqbot-settings/pet-status').then(function(r){if(r.status===401){location.href='/';throw new Error('relogin')}return r.json()}).then(function(j){
  var p=document.getElementById('botpill');if(!p)return;
  if(!j.ok){p.className='pill unk';p.textContent='QQ状态 未知'}
  else{var t=j.at?new Date(j.at).toLocaleTimeString('zh-CN',{hour12:false}):'';
   if(j.online){p.className='pill ok';p.textContent='🟢 QQ 在线'+(t?' · '+t:'')}
   else{p.className='pill off';p.textContent='🔴 QQ 离线'+(t?' · '+t:'')}}
  var fm=j.fam||[],fe=document.getElementById('fam');if(!fe)return;
  if(!fm.length){fe.style.display='none';return}
  var h='<h3>💗 好感度 · 累计分（不衰减 · 互动越多越亲）</h3>';
  for(var k=0;k<fm.length;k++){var x=fm[k];
   var nm=x.name?esc(x.name):('用户'+esc(String(x.id).slice(-4)));
   h+='<div class="fi" title="互动 '+x.talk+' 次'+(x.daysIdle>0?(' · 已 '+x.daysIdle+' 天没聊'):'')+'">'
    +'<span class="fn">'+nm+'</span>'
    +'<span class="bar"><i style="width:'+Math.max(3,Math.min(100,x.s))+'%"></i></span>'
    +'<span class="fl">'+esc(x.levelLabel)+' '+x.s+'</span></div>';}
  fe.innerHTML=h}).catch(function(){var p=document.getElementById('botpill');if(p){p.className='pill unk';p.textContent='QQ状态 未知'}})}
botpoll();setInterval(botpoll,10000);
load();setInterval(load,5000);
</script></body></html>`;
