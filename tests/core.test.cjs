'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const p = require('../lib/probe.cjs');
const { createRunManager } = require('../lib/runs.cjs');
const { createApp } = require('../server.cjs');
const settings = (overrides = {}) => ({ mode:'direct',proxy:'',rounds:1,timeout:3,targets:['google','cloudflare'],speedTest:false,nodeLabel:'test',runMode:'count',duration:5,interval:0.5,...overrides });
async function settled(manager,id) { const until=Date.now()+4000; while(manager.get(id).status==='running') { assert.ok(Date.now()<until); await new Promise(r=>setTimeout(r,10)); } return manager.get(id); }
async function temp(t) {const dir=await fs.mkdtemp(path.join(__dirname,'tmp-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); return dir;}
test('proxy validation accepts HTTP and SOCKS remote DNS; rejects credentials and paths',()=>{
 assert.equal(p.normalizeProxy('127.0.0.1:7890'),'http://127.0.0.1:7890');
 assert.equal(p.normalizeProxy('socks5://127.0.0.1:1080'),'socks5h://127.0.0.1:1080');
 for(const value of ['', 'ftp://localhost:21', 'http://u:p@localhost:7890', 'http://localhost:7890/path', 'http://localhost:7890/?q=x', 'http://localhost:999999']) assert.throws(()=>p.normalizeProxy(value),{name:'InputError'});
});
test('registry chooses HTTPS proxy and PAC never silently falls back',()=>{
 assert.equal(p.parseSystemProxy({ProxyEnable:'0x1',ProxyServer:'http=127.0.0.1:8080;https=127.0.0.1:7890'}).proxy,'http://127.0.0.1:7890');
 assert.equal(p.parseSystemProxy({ProxyEnable:1,ProxyServer:'socks=127.0.0.1:1080'}).proxy,'socks5h://127.0.0.1:1080');
 const pac=p.parseSystemProxy({ProxyEnable:0,AutoConfigURL:'http://example.test/pac'}); assert.equal(pac.enabled,false); assert.match(pac.note,/PAC/);
});
test('settings bound traffic and fixed targets and snapshot system proxy',()=>{
 const good=p.validateSettings({}, {enabled:true,proxy:'127.0.0.1:7890'}); assert.equal(good.proxy,'http://127.0.0.1:7890'); assert.equal(good.speedTest,false); assert.equal(good.targets.length,4);
 assert.equal(p.validateSettings({mode:'direct',proxy:'ignored'}).proxy,'');
 for(const input of [null,[],{mode:'system'},{mode:'manual',proxy:''},{mode:'direct',rounds:1001},{mode:'direct',rounds:'3'},{mode:'direct',timeout:2},{mode:'direct',targets:[]},{mode:'direct',targets:['google','google']},{mode:'direct',targets:['http://localhost/admin']},{mode:'direct',speedTest:'false'},{mode:'direct',nodeLabel:'x'.repeat(61)}]) assert.throws(()=>p.validateSettings(input),{name:'InputError'});
});
test('HTTP challenge and rate limits differ from transport failures',()=>{
 for(const httpStatus of [200,204]) assert.equal(p.classifyResponse({exitCode:0,httpStatus}).status,'ok');
 for(const httpStatus of [401,403,407,429,451,302]) assert.equal(p.classifyResponse({exitCode:0,httpStatus}).status,'restricted');
 assert.equal(p.classifyResponse({exitCode:0,httpStatus:200,body:'<title>Just a moment...</title>'}).errorCode,'CHALLENGE');
 assert.equal(p.classifyResponse({exitCode:60,httpStatus:200}).errorCode,'CERTIFICATE');
 assert.equal(p.classifyResponse({exitCode:28}).errorCode,'TIMEOUT');
 assert.equal(p.classifyResponse({exitCode:'CANCELLED'}).status,'cancelled');
});
test('statistics use valid replies, exclude cancellation, and separate restriction from failure',()=>{
 assert.equal(p.aggregateSamples([]).latencyMs,null);
 const m=p.aggregateSamples([{status:'ok',httpStatus:204,ttfbMs:100,totalMs:120,dnsMs:5,connectMs:10,tlsMs:30},{status:'restricted',httpStatus:403,ttfbMs:180,totalMs:210,dnsMs:9,connectMs:20,tlsMs:40},{status:'error',httpStatus:0,ttfbMs:null,totalMs:3000},{status:'cancelled'}]);
 assert.deepEqual(m,{latencyMs:140,jitterMs:80,successRate:33,failureRate:33,dnsMs:7,connectMs:15,tlsMs:35,totalMs:165});
});
test('run completion persists local history and results',async t=>{
 const dataDir=await temp(t); const calls=[];
 const manager=createRunManager({dataDir,probeFn:async target=>{calls.push(target.id);return {status:'ok',httpStatus:204,ttfbMs:100,totalMs:120,message:'ok'};}});
 await manager.ready; const run=manager.start(settings()); const done=await settled(manager,run.id);
 assert.equal(done.status,'completed'); assert.deepEqual(calls.sort(),['cloudflare','google']); assert.equal(done.progress.completed,2); assert.equal(done.progress.total,2); assert.equal(done.results[0].metrics.successRate,100);
 let saved; for(let i=0;i<40;i++){saved=await fs.readFile(path.join(dataDir,'history.json'),'utf8').then(JSON.parse).catch(()=>null); if(saved)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(saved[0].id,run.id);const next=createRunManager({dataDir});await next.ready;assert.equal(next.getHistory()[0].settings.nodeLabel,'test');
});
test('cancellation reaches all probes and overlapping tests are refused',async t=>{
 const dataDir=await temp(t);let aborted=0;
 const manager=createRunManager({dataDir,probeFn:(target,options,{signal})=>new Promise(resolve=>{const done=()=>{aborted++;resolve({status:'cancelled'});};signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();})});
 await manager.ready;const run=manager.start(settings({rounds:3}));assert.throws(()=>manager.start(settings()),{statusCode:409});await new Promise(r=>setImmediate(r));assert.equal(manager.cancel(run.id),true);const done=await settled(manager,run.id);assert.equal(done.status,'cancelled');assert.equal(aborted,2);assert.equal(done.progress.completed,0);assert.ok(done.results.every(r=>r.status==='cancelled'));await new Promise(r=>setTimeout(r,40));
});
async function appFor(t){const dataDir=await temp(t);const app=createApp({dataDir,readSystemProxyFn:async()=>({enabled:true,proxy:'http://127.0.0.1:7890'})});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>{app.manager.stop();app.server.close(resolve);app.server.closeAllConnections();}));return {...app,url:`http://127.0.0.1:${app.server.address().port}`,headers:{'x-nodescope-token':app.token}};}
test('HTTP session authentication, malformed tokens, cross-origin and fixed-target defenses',async t=>{
 const app=await appFor(t);
 assert.equal((await fetch(app.url+'/api/history')).status,403);
 assert.equal((await fetch(app.url+'/api/history',{headers:{'x-nodescope-token':'é'.repeat(64)}})).status,403);
 assert.equal((await fetch(app.url+'/api/history',{headers:{...app.headers,origin:'https://evil.test'}})).status,403);
 assert.equal((await fetch(app.url+'/api/history',{headers:{...app.headers,'sec-fetch-site':'cross-site'}})).status,403);
 const good=await fetch(app.url+'/api/history',{headers:app.headers});assert.equal(good.status,200);assert.deepEqual(await good.json(),{runs:[]});
 const send=(body,type='application/json')=>fetch(app.url+'/api/runs',{method:'POST',headers:{...app.headers,'content-type':type},body});
 assert.equal((await send('{}','text/plain')).status,400);assert.equal((await send('{broken')).status,400);assert.equal((await send(JSON.stringify({mode:'direct',targets:['http://localhost/admin']}))).status,400);assert.equal((await send(JSON.stringify({mode:'direct',nodeLabel:'x'.repeat(17000)}))).status,413);assert.equal(app.manager.getActive(),null);
 const code=await new Promise((resolve,reject)=>{const req=http.get(app.url+'/api/history',{headers:{...app.headers,host:'evil.test:80'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(code,403);
 const missing=await fetch(app.url+'/server.cjs');assert.equal(missing.status,404);assert.equal(missing.headers.get('x-frame-options'),'DENY');assert.match(missing.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('ChatGPT auth failure stays visible while homepage measurements remain accurate',async t=>{
 const dataDir=await temp(t);const calls=[];
 const manager=createRunManager({dataDir,probeFn:async target=>{calls.push(target.id);return target.id==='chatgpt-auth'?{status:'error',httpStatus:0,ttfbMs:null,totalMs:210,errorCode:'TLS',message:'TLS handshake failed'}:{status:'ok',httpStatus:200,ttfbMs:85,totalMs:100,message:'ok'};}});
 await manager.ready;const run=manager.start(settings({targets:['chatgpt']}));const done=await settled(manager,run.id);const result=done.results[0];
 assert.equal(done.status,'completed');assert.deepEqual(calls.sort(),['chatgpt','chatgpt-auth','cloudflare']);assert.equal(done.progress.completed,1); assert.equal(done.progress.total,1);assert.equal(result.status,'restricted');assert.equal(result.samples.length,1);assert.equal(result.metrics.successRate,100);assert.equal(result.metrics.latencyMs,85);assert.equal(result.diagnostics.length,1);assert.equal(result.diagnostics[0].errorCode,'TLS');assert.equal(result.diagnostics[0].status,'error');assert.equal(result.diagnostics[0].url,'https://auth.openai.com/');assert.match(result.summary,/TLS handshake failed/);await new Promise(r=>setTimeout(r,40));
});
test('cancelling before download starts marks pending speed test cancelled without spending traffic',async t=>{
 const dataDir=await temp(t);let speedCalls=0;
 const manager=createRunManager({dataDir,probeFn:async()=>({status:'ok',httpStatus:204,ttfbMs:10,totalMs:15,message:'ok'}),speedFn:async()=>{speedCalls++;return {status:'ok',mbps:1,bytes:10485760,error:null};}});
 await manager.ready;const run=manager.start(settings({speedTest:true}));assert.equal(run.speed.status,'waiting');manager.cancel(run.id);const done=await settled(manager,run.id);assert.equal(done.status,'cancelled');assert.equal(done.speed.status,'cancelled');assert.equal(done.speed.mbps,null);assert.equal(done.speed.bytes,0);assert.equal(speedCalls,0);await new Promise(r=>setTimeout(r,40));
});
test('cancelling active download forwards abort and preserves cancelled speed result',async t=>{
 const dataDir=await temp(t);let entered;const started=new Promise(r=>{entered=r;});let receivedAbort=false;
 const manager=createRunManager({dataDir,probeFn:async()=>({status:'ok',httpStatus:204,ttfbMs:10,totalMs:15,message:'ok'}),speedFn:(options,{signal})=>new Promise(resolve=>{entered();const abort=()=>{receivedAbort=true;resolve({status:'cancelled',mbps:null,bytes:123,error:'cancelled'});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})});
 await manager.ready;const run=manager.start(settings({speedTest:true}));await started;assert.equal(run.speed.status,'running');manager.cancel(run.id);const done=await settled(manager,run.id);assert.equal(done.status,'cancelled');assert.equal(done.speed.status,'cancelled');assert.equal(receivedAbort,true);assert.equal(done.speed.bytes,123);await new Promise(r=>setTimeout(r,40));
});
