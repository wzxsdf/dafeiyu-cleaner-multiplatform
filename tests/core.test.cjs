const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '../dafeiyu-cleaner');
function runtime(extra = {}) {
  const context = vm.createContext({ URL, AbortController, DOMException, crypto: webcrypto, console, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, ...extra });
  const load = name => vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name });
  for (const name of ['src/core/models.js','src/core/page-session.js','src/platforms/bilibili/shared.js','src/core/defaults.js','src/core/storage-engine.js','src/detection/common.js']) load(name);
  return { context, load, D: context.DFY };
}
function memoryStorage(initial = {}) {
  let data = structuredClone(initial);
  return { get: async () => structuredClone(data), set: async update => { Object.assign(data, structuredClone(update)); }, data: () => structuredClone(data) };
}
const packet = (overrides = {}) => ({ protocolVersion: 2, platform: 'bilibili', pageKey: 'video:a', sessionId: 'one', accounts: [{ platform:'bilibili',id:'90071992547409931234',name:'同名',features:{} }], comments:[{platform:'bilibili',pageKey:'video:a',id:'comment',accountId:'90071992547409931234',text:'hello'}], ...overrides });
const context = { platform:'bilibili',pageKey:'video:a',sessionId:'one' };

test('identity keys isolate platforms and preserve long or encoded string IDs', () => {
  const {D} = runtime();
  for (const id of ['90071992547409931234','abc:/%鱼','__proto__']) {
    const key = D.model.accountKey('douyin',id);
    assert.equal(D.model.parseAccountKey(key).id,id);
    assert.notEqual(key,D.model.accountKey('bilibili',id));
  }
  assert.equal(D.model.parseAccountKey('douyin:%ZZ'),null);
  assert.throws(() => D.model.accountKey('douyin',123));
});

test('protocol rejects old sessions/pages and preserves missing feature semantics', () => {
  const {D} = runtime();
  assert.equal(D.model.normalizeBatch(packet({sessionId:'old'}),context),null);
  assert.equal(D.model.normalizeBatch(packet({pageKey:'video:b'}),context),null);
  assert.equal(D.model.normalizeBatch(packet({comments:Array(1001).fill({})}),context),null);
  const b = D.model.normalizeBatch(packet(),context);
  assert.equal(b.accounts[0].features.level,undefined);
  assert.equal(b.comments[0].accountKey,'bilibili:90071992547409931234');
  const anonymous = D.model.normalizeBatch(packet({comments:[{platform:'bilibili',pageKey:'video:a',id:'anon',text:'hello',accountId:null}]}),context);
  assert.equal(anonymous.comments[0].accountKey,null);
});

test('Bilibili context distinguishes video parts, profile and excluded hosts', () => {
  const {D} = runtime();
  assert.equal(D.platforms.match('https://evilbilibili.com'),null);
  assert.equal(D.platforms.match('https://live.bilibili.com'),null);
  assert.equal(D.bilibili.getPageContext(new URL('https://www.bilibili.com/video/BV1Ywn46EEyF?p=2')).pageKey,'video:BV1Ywn46EEyF:p2');
  assert.equal(D.bilibili.getPageContext(new URL('https://space.bilibili.com/123')).pageKey,'profile:123');
  assert.equal(D.bilibili.avatarUrl('https://example.org/img.jpg'),'https://example.org/img.jpg');
  assert.equal(D.bilibili.avatarUrl('https://i0.hdslb.com/a.jpg@100w.png','analysis'),'https://i0.hdslb.com/a.jpg@48w_48h.png');
});

test('storage migration is idempotent, backed up and gives whitelist precedence', async () => {
  const {D} = runtime();
  const old = { blocklist:{'123':{n:'鱼'}}, whitelist:{'123':{n:'人'}}, seen:{'123':{c:7,k:['BV1Ywn46EEyF','12345'],t:1}}, llmCache:{'123':{ai:99,t:1}}, stats:{total:7},settings:{mode:'auto'} };
  const local=memoryStorage(old), engine=D.createStorageEngine(local);
  const first=await engine.request({op:'read'});
  assert.equal(first.data.blocklist['bilibili:123'],undefined);
  assert.equal(first.data.whitelist['bilibili:123'].n,'人');
  assert.equal(first.data.seen['bilibili:123'].c,1);
  assert.equal(first.data.llmCache['bilibili:123'].strategyVersion,'legacy-expired');
  assert.equal(first.data.stats.total,7);
  assert.equal(first.data.settings.mode,'auto');
  assert.deepEqual(local.data().legacyBackupV1.data.blocklist,old.blocklist);
  const restarted=await D.createStorageEngine(local).request({op:'read'});
  assert.equal(restarted.revision,first.revision);
  assert.equal(restarted.data.seen['bilibili:123'].k[0],first.data.seen['bilibili:123'].k[0]);
});

test('migration resumes after interrupted final commit without overwriting backup', async () => {
  const {D}=runtime(); const local=memoryStorage({blocklist:{'9':{n:'saved'}}}); let fail=true;
  const wrapped={get:local.get,set:async update=>{if(update.schemaVersion&&fail){fail=false;throw Error('disk failure');}await local.set(update);}};
  await assert.rejects(D.createStorageEngine(wrapped).request({op:'read'}),/disk failure/);
  const backup=local.data().legacyBackupV1;
  const result=await D.createStorageEngine(wrapped).request({op:'read'});
  assert.equal(result.data.blocklist['bilibili:9'].n,'saved');
  assert.deepEqual(local.data().legacyBackupV1,backup);
});

test('revision conflicts protect concurrent clients and memory updates merge', async () => {
  const {D}=runtime(); const local=memoryStorage(), engine=D.createStorageEngine(local);
  const [a,b]=await Promise.all([engine.request({op:'read'}),engine.request({op:'read'})]);
  assert.equal((await engine.request({op:'commit',revision:a.revision,update:{blocklist:{'bilibili:1':{n:'a'}}}})).ok,true);
  assert.equal((await engine.request({op:'commit',revision:b.revision,update:{blocklist:{'douyin:1':{n:'b'}}}})).conflict,true);
  const now=await engine.request({op:'read'});
  now.data.blocklist['douyin:1']={n:'b'};
  await engine.request({op:'commit',revision:now.revision,update:{blocklist:now.data.blocklist}});
  await Promise.all([engine.request({op:'memory',seen:{'bilibili:1':{k:['a'],c:1,t:1}}}),engine.request({op:'memory',seen:{'bilibili:1':{k:['b'],c:1,t:2}}})]);
  const result=await engine.request({op:'read'});
  assert.equal(Object.keys(result.data.blocklist).length,2);
  assert.equal(result.data.seen['bilibili:1'].k.length,2);
  assert.equal(result.data.seen['bilibili:1'].c,2);
});

test('storage client retries a concurrent mutation against current values', async () => {
  const {D,load,context}=runtime(); const local=memoryStorage(),engine=D.createStorageEngine(local);
  context.chrome={runtime:{id:'test',sendMessage(msg,callback){engine.request(msg).then(callback);}},storage:{local,onChanged:{addListener(){}}}};
  load('src/storage.js');
  await Promise.all([D.store.listAction('bilibili:1',{n:'a'},'block'),D.store.listAction('douyin:1',{n:'b'},'block')]);
  const list=await D.store.get('blocklist');assert.equal(Object.keys(list).length,2);
  await D.store.listAction('bilibili:1',{n:'human'},'white');
  const data=await D.store.get(['blocklist','whitelist']);assert.equal(data.blocklist['bilibili:1'],undefined);assert.equal(data.whitelist['bilibili:1'].n,'human');
  await D.store.listAction('bilibili:1',{n:'stale auto judgement',source:'auto'},'block');
  assert.ok((await D.store.get('whitelist'))['bilibili:1']);
});

test('session disposal cancels delayed work and rejects sleeps without reviving A after B', async () => {
  const {D}=runtime(); const a=D.createSession({},context), b=D.createSession({},context);let calls=0;
  assert.notEqual(a.sessionId,b.sessionId);
  a.later(()=>calls++,5);const pending=a.sleep(20);const rejected=assert.rejects(pending,{name:'AbortError'});a.dispose();await rejected;
  assert.equal(a.active(),false);assert.equal(b.active(),true);assert.equal(calls,0);b.dispose();
});

test('comment strategy ignores missing levels and persona alone cannot confirm automation', () => {
  const {D,load}=runtime();load('src/detector.js');load('src/detection/bilibili-legacy.js');
  const missing=D.scoreAccount({uname:'普通人',verify:-1});const level2=D.scoreAccount({uname:'普通人',level:2,verify:-1});
  assert.equal(level2.score-missing.score,14);
  assert.equal(missing.reasons.some(r=>r.tag==='level'),false);
  assert.equal(D.detection.get('douyin'),null);
  const result=D.detection.get('bilibili').judge({key:'bilibili:1',name:'大肥鱼',features:{level:2}},[{text:'本鲸来给主人汇报',isReply:false}],{});
  assert.equal(D.detection.get('bilibili').classify(result.score,result), 'unknown');
});

test('manifest and popup load all referenced files in dependency order', () => {
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  for(const group of manifest.content_scripts)for(const file of group.js)assert.ok(fs.existsSync(path.join(root,file)),file);
  const isolated=manifest.content_scripts.find(g=>g.world!=='MAIN').js;
  assert.ok(isolated.indexOf('src/core/models.js')<isolated.indexOf('src/platforms/bilibili/adapter.js'));
  assert.ok(isolated.indexOf('src/core/defaults.js')<isolated.indexOf('src/storage.js'));
  const popup=fs.readFileSync(path.join(root,'popup/popup.html'),'utf8');
  for(const match of popup.matchAll(/<script src="([^"]+)"/g))assert.ok(fs.existsSync(path.resolve(root,'popup',match[1])),match[1]);
});

test('clearing memory prevents queued writes in another tab from restoring it', async () => {
  const {D}=runtime(), engine=D.createStorageEngine(memoryStorage());
  const first=await engine.request({op:'read'});
  await engine.request({op:'commit',revision:first.revision,update:{seen:{},llmCache:{}}});
  const stale=await engine.request({op:'memory',epoch:0,seen:{'bilibili:1':{k:['old'],c:1,t:Date.now()}}});
  assert.equal(stale.discarded,true);
  const current=await engine.request({op:'read'});
  assert.equal(Object.keys(current.data.seen).length,0);
  await engine.request({op:'memory',epoch:current.data.memoryEpoch,seen:{'bilibili:1':{k:['new'],c:1,t:Date.now()}}});
  assert.equal((await engine.request({op:'read'})).data.seen['bilibili:1'].k[0],'new');
});

test('list imports roundtrip namespaced IDs, accept legacy lists, reject mismatched identities', () => {
  const {D,load}=runtime();load('src/core/list-codec.js');
  D.platforms.register({id:'example',matches:()=>false});
  const key=D.model.accountKey('example','abc:/鱼');
  const exported=JSON.parse(JSON.stringify({[key]:{platform:'example',id:'abc:/鱼',n:'someone'}}));
  assert.equal(D.normalizeList(exported)[key].id,'abc:/鱼');
  assert.equal(D.normalizeList({'123':'legacy'})['bilibili:123'].n,'legacy');
  assert.equal(Object.keys(D.normalizeList({[key]:{platform:'bilibili',id:'123'}})).length,0);
  assert.equal(Object.keys(D.normalizeList(['not-an-id'])).length,0);
});

test('adapter rejects stale packets and cleans styles, badges and animations when a DOM node is reused', () => {
  const listeners=new Map(), posts=[];
  const window={addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:(k,f)=>{if(listeners.get(k)===f)listeners.delete(k);},postMessage:p=>posts.push(p)};
  const location=new URL('https://www.bilibili.com/video/BV1Ywn46EEyF');
  const {D,load}=runtime({window,location});
  const attrs=new Map([['data-dfy-id','one']]);
  const el={style:{display:'flex'},dataset:{},isConnected:true,getAttribute:k=>attrs.get(k)??null,setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)};
  el.root={querySelector:()=>null};
  const dom=D.bilibili.comments;
  dom.partsOf=node=>({root:node.root,host:node});dom.eachRenderer=cb=>cb(el,false);
  load('src/platforms/bilibili/adapter.js');
  const a=D.createSession(D.bilibili,D.bilibili.getPageContext());let received=0, unchanged=0;
  D.bilibili.start(a,{comments:()=>received++,bindingsChanged:()=>unchanged++},a.signal);
  assert.equal(dom.binding(null),null);
  const b=dom.binding(el);let removed=0,cancelled=0;
  b.setStyle('display','none');b.setAttribute('dfy-level','fish');b.track({remove:()=>removed++});b.animations.add({cancel:()=>cancelled++});
  const msg={...packet(),pageKey:a.pageKey,sessionId:a.sessionId,source:'dfy-main',type:'comments'};
  listeners.get('message')({source:window,data:{...msg,sessionId:'stale'}});assert.equal(received,0);
  listeners.get('message')({source:window,data:msg});listeners.get('message')({source:window,data:msg});
  assert.equal(received,1);assert.equal(unchanged,1);
  el.setAttribute('data-dfy-id','two');const next=dom.binding(el);
  assert.equal(b.valid(),false);assert.notEqual(b.generation,next.generation);
  assert.equal(el.style.display,'flex');assert.equal(attrs.has('dfy-level'),false);assert.equal(removed,1);assert.equal(cancelled,1);
  next.setStyle('display','none');el.style.display='grid';
  b.setAttribute('dfy-level','old');b.restoreAttribute('dfy-level');b.restoreStyle('display');b.setStyle('display','block');
  assert.equal(el.style.display,'grid');assert.equal(attrs.has('dfy-level'),false);
  next.setAttribute('dfy-level','fish');
  location.href='https://www.bilibili.com/video/BV1Ywn46EEyF?p=2';
  next.setAttribute('dfy-level','stale');next.restoreAttribute('dfy-level');
  assert.equal(attrs.get('dfy-level'),'fish');assert.equal(next.valid(),false);
  a.dispose();assert.equal(el.style.display,'grid');assert.equal(next.valid(),false);assert.equal(listeners.size,0);
  assert.equal(posts.at(-1).type,'stop');
});

test('Bilibili hit testing traverses nested shadow roots', () => {
  const {D}=runtime();const host={tagName:'BILI-COMMENT-THREAD-RENDERER'};
  const target={getRootNode:()=>({host:{getRootNode:()=>({host})}})};
  assert.equal(D.bilibili.hitTestComment(target),host);
});

test('MAIN collector only scans an active session and keeps long IDs and missing fields intact', () => {
  const listeners=new Map(), timers=new Map(), posts=[];let seq=0;
  const window={addEventListener:(k,f)=>listeners.set(k,f),postMessage:p=>posts.push(p)};
  const location=new URL('https://www.bilibili.com/video/BV1Ywn46EEyF');
  const {D,load}=runtime({window,location,document:{addEventListener(){}},customElements:{whenDefined:()=>new Promise(()=>{})},setTimeout:f=>{timers.set(++seq,f);return seq;},clearTimeout:id=>timers.delete(id),setInterval:()=>++seq,clearInterval(){}});
  const attrs={};const el={data:{rpid_str:'90071992547409931234',member:{mid:'90071992547409931235',uname:'somebody'},content:{message:'hello'}},setAttribute:(k,v)=>attrs[k]=v};
  D.bilibili.comments.eachRenderer=cb=>cb(el,false);load('src/platforms/bilibili/main-world.js');
  const send=m=>listeners.get('message')({source:window,data:{source:'dfy-iso',protocolVersion:2,platform:'bilibili',pageKey:D.bilibili.getPageContext().pageKey,...m}});
  const scan=()=>{for(const [id,f]of [...timers]){timers.delete(id);f();}};
  send({type:'rescan',sessionId:'missing'});scan();assert.equal(posts.length,0);
  send({type:'init',sessionId:'one'});scan();assert.equal(posts[0].accounts[0].id,'90071992547409931235');
  assert.equal(posts[0].accounts[0].features.level,undefined);assert.equal(attrs['data-dfy-id'],'90071992547409931234');
  send({type:'stop',sessionId:'one'});send({type:'rescan',sessionId:'one'});scan();assert.equal(posts.length,1);
  send({type:'init',sessionId:'two'});location.href='https://www.bilibili.com/video/BV1Ywn46EEyF?p=2';scan();assert.equal(posts.length,1);
});

function controllerRuntime(platform='bilibili') {
  const r=runtime({requestAnimationFrame:()=>0}), D=r.D;
  D.esc=String;D.settings={...D.DEFAULTS.settings,llmEnabled:true,llmKey:'test',llmAuto:false};D.lists={block:{},white:{}};
  D.platformStatus={};D.memory={prior:()=>0,mark(){},llmGet:()=>null,llmPut(){}};D.levelOf=s=>s>=60?'fish':s>=35?'suspect':'human';
  D.ui={tip(){},setBusy(){},cannon(){},say(){},think:()=>({close(){},done(){},update(){}})};D.actors={clear(){}};D.bump=()=>{};D.say=()=>'';D.canLLM=true;
  const adapter={id:platform,comments:{host:()=>null,eachRenderer(){}}};
  D.session=D.createSession(adapter,{platform,pageKey:'video:a'});D.platformContext=D.session;
  r.load('src/comments.js');r.C=D.createCommentController(D.session);r.render=r.C.render;r.C.render=()=>{};
  r.receive=(text='original')=>r.C.receive(D.model.normalizeBatch(packet({platform,sessionId:D.session.sessionId,accounts:[{platform,id:'1',name:'same',features:{}}],comments:[{platform,pageKey:'video:a',id:'c',accountId:'1',text}]}),D.session));
  return r;
}

test('a second platform works without a detection strategy and does not reuse Bilibili scores', () => {
  const {D,C,receive}=controllerRuntime('example');receive();
  assert.equal(C.stats().accounts,1);assert.equal(C.stats().unassessed,1);assert.equal(C.stats().fish,0);
  D.session.dispose();
});

test('Douyin list decisions stay platform-scoped and whitelist wins without calling LLM', async () => {
  const {D,C,receive}=controllerRuntime('douyin'); let calls=0;
  D.callBg=async()=>{calls++;return {ok:true};};
  D.lists.block['bilibili:1']={n:'same'};receive();assert.equal(C.stats().unassessed,1);
  D.lists.block['douyin:1']={n:'same'};C.rejudgeAll();assert.equal(C.stats().unassessed,0);
  D.lists.white['douyin:1']={n:'same'};C.rejudgeAll();assert.equal(C.stats().unassessed,0);
  await C.llmPage();assert.equal(calls,0);D.session.dispose();
});

test('manual hide on a non-animated platform can undo after the comment DOM remounts', async () => {
  const r=controllerRuntime('douyin'),{D,C,receive}=r;let restoreButton;
  const note={dataset:{},isConnected:true,attachShadow(){this.shadowRoot={querySelector:()=>restoreButton={}};},remove(){this.isConnected=false;}};
  r.context.document={createElement:()=>note};r.context.requestAnimationFrame=fn=>fn();
  D.icon=()=>'';D.ui.menu=()=>{};D.ui.setCount=()=>{};D.recordKick=async()=>{};
  D.store={listAction:async()=>{},patch:async(key,fn)=>fn(D.lists.block)};
  D.fx={collapse:el=>{el.style.display='none';el.dataset.dfyGone='1';}};
  const dom=D.session.adapter.comments,host={before(){}};
  D.session.adapter.getCapabilities=()=>({commentAnimation:false});
  const key=D.model.commentKey('douyin','video:a','c');
  let live;
  function mount(){const el={style:{display:''},dataset:{}};const b={el,key,root:{querySelector:()=>null},valid:()=>live===b,setAttribute(){},restoreAttribute(){},restoreStyle:k=>el.style[k]='',setStyle:(k,v)=>el.style[k]=v};live=b;return b;}
  const old=mount();
  Object.assign(dom,{host:()=>host,binding:()=>live,bindingKey:()=>live.key,eachRenderer:cb=>cb(live.el),isReply:()=>false});
  receive();await D.onCannonComment(old.el,true);
  assert.equal(old.el.style.display,'none');assert.equal(C.stats().kicked,1);assert.equal(D.lists.block['douyin:1'].source,'manual');
  assert.equal(C.stats().listed,1);
  const replacement=mount();replacement.el.dataset.dfyGone='1';replacement.el.style.display='none';
  // A white verdict keeps the view fixture small; gone must still be cleared by undo.
  D.lists.white['douyin:1']={n:'same'};C.render=r.render;
  await restoreButton.onclick();
  assert.equal(C.stats().kicked,0);assert.equal(D.lists.block['douyin:1'],undefined);
  assert.equal(replacement.el.style.display,'');assert.equal(replacement.el.dataset.dfyGone,undefined);
  D.session.dispose();
});

test('LLM results are ignored after comment edits or page session disposal', async () => {
  for(const dispose of [false,true]) {
    const {D,C,receive}=controllerRuntime();let finish,writes=0;
    D.detection.register('bilibili',{version:'test-v1',llm:true,judge:()=>({score:40,raw:40,reasons:[]})});
    D.memory.llmPut=()=>writes++;D.callBg=()=>new Promise(resolve=>finish=resolve);
    receive();C.llmPage();assert.equal(typeof finish,'function');
    if(dispose)D.session.dispose();else receive('edited after request');
    finish({ok:true,results:[{id:'bilibili:1',ai:99}],ms:1});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,0);D.session.dispose();
  }
});

test('undo never reveals a different comment that reused the original DOM node', async () => {
  const {D,C,receive}=controllerRuntime();D.ui.menu=()=>{};let undo;
  D.ui.toast=o=>undo=o.action.run;D.recordKick=async()=>{};
  D.store={listAction:async()=>{},patch:async(k,fn)=>fn({})};
  const el={style:{display:''},dataset:{}};
  const key=D.model.commentKey('bilibili','video:a','c');
  const old={el,key,valid:()=>live===old,restoreStyle:()=>el.style.display='',setStyle:(k,v)=>el.style[k]=v};let live=old;
  Object.assign(D.session.adapter.comments,{binding:()=>live,bindingKey:()=>live.key,eachRenderer:cb=>cb(el)});
  D.fx={bubblePop:async()=>el.style.display='none'};
  receive();await D.onCannonComment(el,true);assert.equal(typeof undo,'function');
  live={...old,key:'other',valid:()=>true};el.style.display='none';
  await undo();assert.equal(el.style.display,'none');D.session.dispose();
});

test('background service worker imports dependencies and owns storage messages', async () => {
  const local=memoryStorage();let listener;
  const ctx=vm.createContext({URL,console,structuredClone,AbortController,setTimeout,clearTimeout,chrome:{storage:{local},runtime:{getURL:()=> 'chrome-extension://test/',onMessage:{addListener:f=>listener=f},onInstalled:{addListener(){}}},commands:{onCommand:{addListener(){}}}}});
  ctx.importScripts=(...files)=>{for(const file of files)vm.runInContext(fs.readFileSync(path.join(root,'src',file),'utf8'),ctx,{filename:file});};
  vm.runInContext(fs.readFileSync(path.join(root,'src/background.js'),'utf8'),ctx);
  const response=await new Promise(resolve=>assert.equal(listener({type:'store',op:'read',keys:['schemaVersion']},{},resolve),true));
  assert.equal(response.data.schemaVersion,2);
  const unsupported=await new Promise(resolve=>listener({type:'llm-judge',platform:'example'},{},resolve));
  assert.equal(unsupported.ok,false);
});

test('old thinking UI cannot close or overwrite the next session thinking UI', () => {
  const timers=new Map();let seq=0;
  const {D,load}=runtime({setTimeout:f=>{timers.set(++seq,f);return seq;},clearTimeout:id=>timers.delete(id),setInterval:()=>++seq,clearInterval(){}});
  load('src/ui.js');const classes=new Set();
  const node={classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},querySelector:()=>({textContent:''})};
  D.ui.root={querySelector:()=>node};D.ui.face=()=>{};
  D.session=D.createSession({},context);const old=D.ui.think('old');old.done('1');
  D.session.dispose();D.session=D.createSession({},context);const current=D.ui.think('current');
  old.close();assert.ok(classes.has('show'));assert.equal(timers.size,0);
  current.close();assert.equal(classes.has('show'),false);D.session.dispose();
});
