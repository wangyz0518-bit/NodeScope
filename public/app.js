'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const fmt = (value, digits=0) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN',{maximumFractionDigits:digits}) : '—';
const clock = value => { if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); };
const seconds = ms => { if(!Number.isFinite(ms))return '—';const s=Math.max(0,Math.floor(ms/1000));return s>=60?`${Math.floor(s/60)}分${s%60}秒`:`${s}秒`; };
const token = document.querySelector('meta[name="nodescope-token"]')?.content || '';
const state = {bootstrap:null,settings:{mode:'system',proxy:'',rounds:3,timeout:12,runMode:'count',duration:60,interval:1,nodeLabel:'',speedTest:false},selected:new Set(),run:null,history:[],busy:false,disconnected:false,detailId:null,historyLoading:false,targetBusy:false};
let toastTimer;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},4500);}
async function api(path,options={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{const response=await fetch(path,{...options,signal:controller.signal,headers:{'Content-Type':'application/json','X-NodeScope-Token':token,...(options.headers||{})}});const data=await response.json();if(!response.ok)throw new Error(data.error||data.message||`请求失败（${response.status}）`);return data;}
  catch(error){if(error.name==='AbortError')throw new Error('本地服务响应超时，请重试连接。');throw error;}finally{clearTimeout(timer);}
}
function heartbeat(){api('/api/heartbeat',{method:'POST',body:'{}'}).catch(()=>{});}
heartbeat();setInterval(heartbeat,15000);
const running=()=>state.run?.status==='running';
const locked=()=>running()||state.busy||state.targetBusy||state.historyLoading;
const statusLabel=status=>({waiting:'等待检测',running:'检测中',ok:'正常',restricted:'受限 / 异常',error:'失败',cancelled:'已停止'}[status]||'等待检测');
function primaryStats(item){if(item?.stats)return item.stats;const samples=item?.samples||item?.results?.flatMap(r=>r.samples||[])||[];return {attempts:samples.length,successes:samples.filter(s=>s.status==='ok').length,restricted:samples.filter(s=>s.status==='restricted').length,failures:samples.filter(s=>s.status==='error').length};}
function findResult(id){return state.run?.results?.find(result=>result.id===id);}
function targets(){return state.bootstrap?.targets||[];}
function allRows(){const rows=[...targets()];for(const r of state.run?.results||[])if(!rows.some(t=>t.id===r.id))rows.push({...r,archived:true,custom:r.id.startsWith('custom-')});return rows;}
function persist(){try{localStorage.setItem('nodescope.compact.v2',JSON.stringify(state.settings));}catch{}}
function setControls(){const s=state.settings;$('run-mode').value=s.runMode;$('rounds-input').value=s.rounds;$('duration-input').value=s.duration;$('interval-input').value=s.interval;$('timeout-input').value=s.timeout;syncMode();}
function syncMode(){const duration=$('run-mode').value==='duration';$('rounds-field').hidden=duration;$('duration-field').hidden=!duration;$('speed-test').disabled=duration;$('speed-test').closest('label').classList.toggle('disabled',duration);$('speed-hint').textContent=duration?'持续检测不叠加下载测速，以免影响延迟。':'产生实际流量，仅在本次检测结束后执行一次。';if(duration)$('speed-test').checked=false;}
function collectSettings(){
  const s={...state.settings,runMode:$('run-mode').value,rounds:Number($('rounds-input').value),duration:Number($('duration-input').value),interval:Number($('interval-input').value),timeout:Number($('timeout-input').value)};
  if(!['count','duration'].includes(s.runMode))throw new Error('请选择检测方式。');
  if(s.runMode==='count'&&(!Number.isInteger(s.rounds)||s.rounds<1||s.rounds>1000))throw new Error('每站次数应为 1～1000 的整数。');
  if(s.runMode==='duration'&&(!Number.isInteger(s.duration)||s.duration<5||s.duration>3600))throw new Error('持续时长应为 5～3600 秒的整数。');
  if(!Number.isFinite(s.interval)||s.interval<0.5||s.interval>30)throw new Error('采样间隔应为 0.5～30 秒。');
  if(!Number.isInteger(s.timeout)||s.timeout<3||s.timeout>30)throw new Error('单次超时应为 3～30 秒的整数。');
  if(s.runMode==='duration'){s.speedTest=false;if(!Number.isInteger(s.rounds)||s.rounds<1||s.rounds>1000)s.rounds=3;}
  else if(!Number.isInteger(s.duration)||s.duration<5||s.duration>3600)s.duration=60;
  return s;
}
function renderConnection(){
  const s=state.settings,system=state.bootstrap?.systemProxy,okay=s.mode!=='system'||system?.enabled&&system?.proxy;
  $('connection-name').textContent=s.nodeLabel||({system:'系统代理',manual:'手动代理',direct:'直连 / TUN'}[s.mode]);
  $('connection-route').textContent=s.mode==='system'?(system?.proxy||system?.note||'未检测到系统代理'):s.mode==='manual'?s.proxy:'由系统网络路由，不显式指定代理';
  $('connection-route').title=$('connection-route').textContent;$('proxy-dot').className=`dot ${okay?'good':'warning'}`;
}
function renderStats(){
  const stats=primaryStats(state.run),attempts=stats.attempts||0;
  $('stat-success').innerHTML=`${attempts?fmt((stats.successes||0)/attempts*100,1):'—'}<small>%</small>`;
  $('stat-attempts').textContent=`${fmt(stats.successes||0)} 成功 / ${fmt(attempts)} 次请求`;
  let latency=state.run?.metrics?.latencyMs;
  if(latency==null&&!state.run?.stats){const responses=(state.run?.results||[]).flatMap(r=>r.samples||[]).filter(s=>s.httpStatus>0&&Number.isFinite(s.ttfbMs));latency=responses.length?responses.reduce((sum,s)=>sum+s.ttfbMs,0)/responses.length:null;}
  $('stat-latency').innerHTML=`${fmt(latency)}<small>ms</small>`;$('stat-failures').innerHTML=`${state.run?fmt(stats.failures||0):'—'}<small>次</small>`;$('stat-restricted').innerHTML=`${state.run?fmt(stats.restricted||0):'—'}<small>次</small>`;
}
function renderRows(){
  const disabled=locked(),rows=allRows();
  $('service-rows').innerHTML=rows.map(target=>{
    const result=findResult(target.id),stats=primaryStats(result),attempts=stats.attempts||0,latest=result?.samples?.at(-1),status=result?.status||'waiting',available=targets().some(t=>t.id===target.id),custom=target.custom===true;
    const summary=result?.summary||latest?.message||target.description||'';
    return `<tr><td class="select-column"><input class="target-checkbox" type="checkbox" data-target="${esc(target.id)}" aria-label="选择 ${esc(target.name)}" ${state.selected.has(target.id)?'checked':''} ${disabled||!available?'disabled':''}></td><td><div class="service-name">${esc(target.name)}${custom?'<span class="custom-tag">自定义</span>':''}${!available?'<span class="custom-tag">历史</span>':''}</div><div class="service-url" title="${esc(target.url)}">${esc(target.url)}</div></td><td><span class="status ${esc(status)}">${statusLabel(status)}</span><div class="service-message" title="${esc(summary)}">${esc(summary)}</div></td><td class="numeric"><span class="number">${fmt(result?.metrics?.latencyMs)}</span><div class="sample-count">${result?.metrics?.jitterMs!=null?`抖动 ${fmt(result.metrics.jitterMs)} ms`:'首字节响应'}</div></td><td class="numeric"><span class="number success-number">${attempts?`${fmt((stats.successes||0)/attempts*100,1)}%`:'—'}</span><div class="sample-count">${fmt(stats.successes||0)} / ${fmt(attempts)}${target.id==='chatgpt'?' · 首页':''}</div></td><td><div class="row-actions"><button class="icon-button" data-detail="${esc(target.id)}" title="查看检测详情" aria-label="查看 ${esc(target.name)} 详情" ${result?'':'disabled'}>${icon('chevron')}</button>${custom?`<button class="icon-button remove-target" data-remove="${esc(target.id)}" title="移除站点" aria-label="移除 ${esc(target.name)}" ${disabled||!available?'disabled':''}>${icon('delete')}</button>`:''}</div></td></tr>`;
  }).join('')||'<tr><td class="empty" colspan="6">暂无检测站点。</td></tr>';
  $('selection-count').textContent=`已选 ${state.selected.size} 项`;$('select-all').textContent=state.selected.size===targets().length?'取消全选':'全部选择';$('select-all').disabled=disabled;
}
function renderProgress(){
  const r=state.run,isRunning=running(),progress=r?.progress||{},count=progress.completed??primaryStats(r).attempts??0,total=progress.total;
  $('run-status').textContent=state.disconnected?'连接已中断':state.busy?'正在处理…':isRunning?'正在检测':r?.status==='cancelled'?'已停止':r?.status==='failed'?'检测中断':r?'检测完成':'准备就绪';
  $('run-progress').textContent=state.disconnected?'点击重新连接以恢复检测状态':r?`${fmt(count)} 次请求${Number.isFinite(total)?` / ${fmt(total)} 次计划`:''}`:'选择服务后开始检测';
  if(r){const elapsed=progress.elapsedMs??Math.max(0,new Date(r.finishedAt||Date.now()).getTime()-new Date(r.startedAt).getTime());$('run-time').textContent=`已运行 ${seconds(elapsed)}${isRunning&&r.settings?.runMode==='duration'&&Number.isFinite(progress.remainingMs)?` · 剩余 ${seconds(progress.remainingMs)}`:''}`;}else $('run-time').textContent='';
  $('progress-track').hidden=!isRunning;$('progress-track').classList.toggle('indeterminate',isRunning&&!Number.isFinite(total)&&!Number.isFinite(progress.remainingMs));
  const fraction=Number.isFinite(total)&&total>0?count/total:r?.settings?.duration&&Number.isFinite(progress.remainingMs)?1-progress.remainingMs/(r.settings.duration*1000):0;
  $('progress-fill').style.width=`${Math.min(100,Math.max(0,fraction*100))}%`;
}
function renderNetwork(){
  const e=state.run?.egress,speed=state.run?.speed;$('egress-ip').textContent=e?.ip||'—';$('egress-country').textContent=e?.country||'—';$('egress-colo').textContent=e?.colo||'—';$('egress-tls').textContent=e?.tls||'—';
  $('egress-speed').textContent=speed?.status==='ok'?`${fmt(speed.mbps,2)} Mbps`:speed?.status==='running'?'测速中':speed?.status==='waiting'?'等待':speed?.status==='cancelled'?'已停止':speed?.status==='error'?'未完成':'未开启';$('egress-speed').title=speed?.error||'Cloudflare 单次 10 MiB 下载参考值';
}
function renderEvents(){const events=state.run?.events||[];$('latest-event').textContent=events.at(-1)?.message||'尚未开始';$('event-list').innerHTML=events.slice(-30).reverse().map(e=>`<li class="${esc(e.level)}"><time>${clock(e.time)}</time><span>${esc(e.message)}</span></li>`).join('');}
function render(){
  renderConnection();renderStats();renderRows();renderProgress();renderNetwork();renderEvents();
  const disabled=locked();for(const id of ['run-mode','rounds-input','duration-input','interval-input','timeout-input','settings-button','edit-connection','add-target-button'])$(id).disabled=disabled;
  $('start-button').disabled=!state.bootstrap||state.busy||state.targetBusy||state.historyLoading||(!running()&&!state.selected.size);
  $('start-button').className=`button start-button ${state.disconnected?'':running()?'danger':'primary'}`;
  $('start-button').innerHTML=state.disconnected?`${icon('refresh')}重新连接`:running()?`${icon('stop')}停止检测`:`${icon('play')}${state.run?'再次检测':'开始检测'}`;
  $('export-button').disabled=!state.run||running();if(state.detailId&&$('detail-dialog').open)renderDetail(state.detailId);
}
function renderDiagnostics(result){
  if(result.id!=='chatgpt')return '';
  const diagnostics=result.diagnostics||[],body=diagnostics.length?diagnostics.map(d=>`<article class="diagnostic-card"><div class="diagnostic-heading"><strong>${esc(d.name||'登录认证站点')}</strong><span class="status ${esc(d.status)}">${statusLabel(d.status)}</span></div><p class="detail-url">${esc(d.url)}</p><dl class="diagnostic-metrics"><div><dt>HTTP 状态</dt><dd>${d.httpStatus?esc(d.httpStatus):'未收到'}</dd></div><div><dt>TLS / 隧道</dt><dd>${fmt(d.tlsMs)} ms</dd></div><div><dt>首字节响应</dt><dd>${fmt(d.ttfbMs)} ms</dd></div><div><dt>请求总耗时</dt><dd>${fmt(d.totalMs)} ms</dd></div></dl><p class="diagnostic-message">${esc(d.message||d.error||'暂无说明')}${d.errorCode?`（${esc(d.errorCode)}）`:''}</p>${d.error&&d.error!==d.message?`<p class="diagnostic-raw">${esc(d.error)}</p>`:''}</article>`).join(''):`<p class="detail-note">${running()?'认证站点尚未完成检测。':'这份记录不包含认证站点结果，可重新检测。'}</p>`;
  return `<section class="diagnostic-section"><h3>认证站点网络检测<span>不验证账号登录</span></h3><p class="detail-note">独立检测一次，不计入首页采样统计；首页可达时，认证链路仍可能受限。</p>${body}</section>`;
}
function renderDetail(id){
  const r=findResult(id);if(!r)return;const m=r.metrics||{},stats=primaryStats(r),samples=r.samples||[];
  const metric=(label,value,unit)=>`<div class="detail-metric"><span>${label}</span><strong>${fmt(value,1)}<small>${unit}</small></strong></div>`;
  $('detail-title').textContent=`${r.name} · 检测详情`;
  $('detail-content').innerHTML=`<p class="detail-url">${esc(r.url)}</p><div class="detail-summary"><span class="status ${esc(r.status)}">${statusLabel(r.status)}</span>${esc(r.summary||'等待检测结果')}</div><div class="detail-metrics">${metric(r.id==='chatgpt'?'首页累计成功率':'累计请求成功率',stats.attempts?stats.successes/stats.attempts*100:null,'%')}${metric('累计完成请求',stats.attempts,'次')}${metric('平均首字节响应',m.latencyMs,'ms')}${metric('平均响应抖动',m.jitterMs,'ms')}</div><p class="section-caption">累计 ${fmt(stats.successes||0)} 次成功 · ${fmt(stats.restricted||0)} 次受限 · ${fmt(stats.failures||0)} 次失败。下表仅保留最近 ${fmt(samples.length)} 个样本（最多 100 个）。</p><div class="sample-table-wrap"><table class="sample-table"><thead><tr><th>采样序号</th><th>HTTP</th><th>首字节</th><th>TCP</th><th>TLS / 隧道</th><th>完整请求</th><th>结果</th></tr></thead><tbody>${samples.slice().reverse().map(s=>`<tr title="${esc(s.message||s.error||'')}"><td>#${esc(s.index)}</td><td>${s.httpStatus?esc(s.httpStatus):'—'}</td><td>${fmt(s.ttfbMs)} ms</td><td>${fmt(s.connectMs)} ms</td><td>${fmt(s.tlsMs)} ms</td><td>${fmt(s.totalMs)} ms</td><td><span class="status ${esc(s.status)}">${statusLabel(s.status)}</span></td></tr>`).join('')||'<tr><td colspan="7">尚无完成的样本。</td></tr>'}</tbody></table></div>${samples.filter(s=>s.status!=='ok'&&(s.message||s.error)).slice(-4).map(s=>`<p class="detail-error">#${esc(s.index)} ${esc(s.message||s.error)}${s.errorCode?`（${esc(s.errorCode)}）`:''}</p>`).join('')}${renderDiagnostics(r)}<p class="detail-note">TTFB 是从开始请求到首字节的时间，非 ICMP Ping。TCP 可能仅到本地代理；TLS 时间可能包含代理隧道；远端 DNS 无法独立测量。到时或主动停止的未完成请求不计入累计统计。</p>`;
}
function showDetail(id){state.detailId=id;renderDetail(id);$('detail-dialog').showModal();}
async function refreshBootstrap(){state.bootstrap=await api('/api/bootstrap');return state.bootstrap;}
async function startRun(){
  if(state.disconnected)return reconnect();
  if(running()){state.busy=true;render();try{await api(`/api/runs/${encodeURIComponent(state.run.id)}/cancel`,{method:'POST',body:'{}'});}catch(error){toast(error.message);}finally{state.busy=false;render();}return;}
  if(locked()||!state.selected.size)return;
  let createdId;
  try{state.settings=collectSettings();persist();state.busy=true;render();await refreshBootstrap();state.selected=new Set([...state.selected].filter(id=>targets().some(t=>t.id===id)));if(!state.selected.size)throw new Error('请至少选择一个可用的检测站点。');const data=await api('/api/runs',{method:'POST',body:JSON.stringify({...state.settings,targets:[...state.selected]})});createdId=data.id;state.run=await api(`/api/runs/${encodeURIComponent(data.id)}`);state.disconnected=false;render();poll(data.id);}
  catch(error){if(createdId){state.run={id:createdId,status:'running',settings:{...state.settings,targets:[...state.selected]},results:[],events:[],stats:{attempts:0,successes:0,restricted:0,failures:0},progress:{completed:0,total:null},startedAt:new Date().toISOString()};state.disconnected=true;}toast(error.message);}
  finally{state.busy=false;render();}
}
async function poll(id){let failures=0;while(state.run?.id===id&&running()){await new Promise(resolve=>setTimeout(resolve,700));try{const run=await api(`/api/runs/${encodeURIComponent(id)}`);if(state.run?.id!==id)break;state.run=run;failures=0;render();}catch(error){failures++;if(failures===1)toast('读取进度失败，正在重试…');if(failures>=4){state.disconnected=true;render();toast('连接中断，点击重新连接可恢复状态。');break;}}}if(state.run?.id===id&&!running())refreshHistory().catch(()=>{});}
async function reconnect(){if(state.busy)return;state.busy=true;render();try{state.run=await api(`/api/runs/${encodeURIComponent(state.run.id)}`);state.disconnected=false;if(running())poll(state.run.id);else refreshHistory().catch(()=>{});}catch(error){toast(error.message);}finally{state.busy=false;render();}}
function openSettings(){if(locked())return;const s=state.settings;$('node-label').value=s.nodeLabel||'';$('proxy-mode').value=s.mode;$('proxy-address').value=s.proxy||'';$('speed-test').checked=s.speedTest&&$('run-mode').value!=='duration';$('settings-error').hidden=true;updateProxyHint();syncMode();$('settings-dialog').showModal();}
function updateProxyHint(){const mode=$('proxy-mode').value,system=state.bootstrap?.systemProxy;$('proxy-field').hidden=mode!=='manual';$('proxy-hint').textContent=mode==='system'?(system?.enabled&&system.proxy?`当前系统代理：${system.proxy}`:system?.note||'系统代理未启用，可手动填写代理端口。'):mode==='direct'?'不指定代理；TUN 模式可由代理客户端接管流量。':'支持 HTTP、HTTPS、SOCKS5；SOCKS5 使用远端 DNS，不支持账号密码。';}
function validateProxy(value){let text=value.trim();if(!text.includes('://'))text=`http://${text}`;let u;try{u=new URL(text);}catch{throw new Error('代理地址格式不正确。');}if(!['http:','https:','socks5:','socks5h:'].includes(u.protocol)||!u.hostname||u.username||u.password||u.pathname&&u.pathname!=='/'||u.search||u.hash)throw new Error('请输入有效代理地址，不支持账号密码或订阅链接。');return text;}
$('settings-form').addEventListener('submit',event=>{event.preventDefault();try{if(locked())return;const mode=$('proxy-mode').value,proxy=mode==='manual'?validateProxy($('proxy-address').value):state.settings.proxy;state.settings={...collectSettings(),mode,proxy,nodeLabel:$('node-label').value.trim(),speedTest:$('run-mode').value==='count'&&$('speed-test').checked};persist();$('settings-dialog').close();render();}catch(error){$('settings-error').textContent=error.message;$('settings-error').hidden=false;}});
function openAddTarget(){if(locked())return;$('target-name').value='';$('target-url').value='';$('target-error').hidden=true;$('add-target-dialog').showModal();}
$('add-target-form').addEventListener('submit',async event=>{event.preventDefault();if(locked())return;state.targetBusy=true;$('save-target-button').disabled=true;render();try{const data=await api('/api/targets',{method:'POST',body:JSON.stringify({name:$('target-name').value.trim(),url:$('target-url').value.trim()})});await refreshBootstrap();state.selected.add(data.target.id);$('add-target-dialog').close();toast('站点已添加。');}catch(error){$('target-error').textContent=error.message;$('target-error').hidden=false;}finally{state.targetBusy=false;$('save-target-button').disabled=false;render();}});
async function removeTarget(id){if(locked())return;state.targetBusy=true;render();try{await api(`/api/targets/${encodeURIComponent(id)}`,{method:'DELETE'});state.selected.delete(id);await refreshBootstrap();toast('站点已移除，历史记录仍可查看。');}catch(error){toast(error.message);}finally{state.targetBusy=false;render();}}
async function refreshHistory(){const data=await api('/api/history');state.history=data.runs||[];renderHistory();}
function renderHistory(){const disabled=locked();$('history-list').innerHTML=state.history.map(r=>{const stats=primaryStats(r),s=r.settings||{},label=s.nodeLabel||({system:'系统代理',manual:'手动代理',direct:'直连 / TUN'}[s.mode])||'节点检测';return `<article class="history-row"><div class="history-main"><strong>${esc(label)}</strong><p>${clock(r.startedAt)} · ${s.runMode==='duration'?`${fmt(s.duration)} 秒`:`每站 ${fmt(s.rounds)} 次`} · ${r.status==='cancelled'?'已停止':r.status==='failed'?'检测中断':'已完成'}</p></div><div class="history-stat">${stats.attempts?fmt(stats.successes/stats.attempts*100,1)+'%':'—'}<small>${fmt(stats.successes||0)} / ${fmt(stats.attempts||0)} 次请求</small></div><button class="button" data-history="${esc(r.id)}" ${disabled?'disabled':''}>查看</button></article>`;}).join('')||'<p class="empty">尚无检测记录。</p>';}
async function viewHistory(id){if(locked())return;state.historyLoading=true;render();try{state.run=await api(`/api/runs/${encodeURIComponent(id)}`);state.disconnected=false;$('history-dialog').close();render();}catch(error){toast(error.message);}finally{state.historyLoading=false;render();}}
function exportReport(){if(!state.run||running())return;const data={...state.run,exportedAt:new Date().toISOString(),measurement:'HTTP TTFB；累计统计覆盖整次检测，samples 仅保留最近100个。认证检测独立，不验证账号登录。'},blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`NodeScope-${state.run.id.replace(/[^a-zA-Z0-9_-]/g,'')}.json`;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('start-button').addEventListener('click',startRun);for(const id of ['settings-button','edit-connection'])$(id).addEventListener('click',openSettings);$('proxy-mode').addEventListener('change',updateProxyHint);
for(const id of ['run-mode','rounds-input','duration-input','interval-input','timeout-input'])$(id).addEventListener('change',()=>{syncMode();try{state.settings=collectSettings();persist();}catch{}render();});
$('select-all').addEventListener('click',()=>{if(locked())return;state.selected=new Set(state.selected.size===targets().length?[]:targets().map(t=>t.id));render();});
$('service-rows').addEventListener('change',event=>{const checkbox=event.target.closest('[data-target]');if(!checkbox||locked())return;checkbox.checked?state.selected.add(checkbox.dataset.target):state.selected.delete(checkbox.dataset.target);render();});
$('service-rows').addEventListener('click',event=>{const detail=event.target.closest('[data-detail]'),remove=event.target.closest('[data-remove]');if(detail&&!detail.disabled)showDetail(detail.dataset.detail);if(remove&&!remove.disabled)removeTarget(remove.dataset.remove);});
$('add-target-button').addEventListener('click',openAddTarget);$('history-button').addEventListener('click',()=>{renderHistory();$('history-dialog').showModal();refreshHistory().catch(error=>toast(error.message));});$('refresh-history').addEventListener('click',()=>refreshHistory().catch(error=>toast(error.message)));$('history-list').addEventListener('click',event=>{const b=event.target.closest('[data-history]');if(b&&!b.disabled)viewHistory(b.dataset.history);});$('export-button').addEventListener('click',exportReport);$('help-button').addEventListener('click',()=>$('help-dialog').showModal());
document.querySelectorAll('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));$('detail-dialog').addEventListener('close',()=>{state.detailId=null;});
function sanitizeSettings(input){const s={...state.settings,...input};if(!['system','manual','direct'].includes(s.mode))s.mode='system';if(!['count','duration'].includes(s.runMode))s.runMode='count';for(const [key,min,max,fallback]of[['rounds',1,1000,3],['duration',5,3600,60],['interval',.5,30,1],['timeout',3,30,12]])if(!Number.isFinite(s[key])||s[key]<min||s[key]>max||(key!=='interval'&&!Number.isInteger(s[key])))s[key]=fallback;s.nodeLabel=typeof s.nodeLabel==='string'?s.nodeLabel.slice(0,60):'';s.proxy=typeof s.proxy==='string'?s.proxy:'';s.speedTest=s.speedTest===true&&s.runMode==='count';return s;}
async function initialize(){try{const data=await refreshBootstrap();let saved={};try{saved=JSON.parse(localStorage.getItem('nodescope.compact.v2')||'{}');}catch{}state.settings=sanitizeSettings({...data.defaults,...saved});state.selected=new Set(targets().map(t=>t.id));const active=data.activeRun?.run||data.activeRun;if(active?.id&&active.status==='running'){state.run=active;state.selected=new Set(active.settings.targets);state.settings=sanitizeSettings(active.settings);}setControls();render();refreshHistory().catch(()=>{});if(running())poll(state.run.id);}catch(error){$('connection-name').textContent='本地服务连接失败';$('connection-route').textContent=error.message;$('proxy-dot').className='dot warning';toast(error.message);}}
initialize();