/* Storage client. Background migration finishes before any client reads or writes. */
(function () {
  const D = globalThis.DFY;
  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage?.local;
  const fallback = !hasChrome && D.createStorageEngine({
    async get() { const out = {}; for (let i=0; i<localStorage.length; i++) { const k=localStorage.key(i); if (k.startsWith('dfy-store-')) out[k.slice(10)] = JSON.parse(localStorage.getItem(k)); } return out; },
    async set(update) { for (const [k,v] of Object.entries(update)) localStorage.setItem('dfy-store-'+k,JSON.stringify(v)); D.store._emit(update); },
  });
  async function request(args) {
    if (!hasChrome) return fallback.request(args);
    const result = await new Promise((resolve,reject) => chrome.runtime.sendMessage({ type:'store', ...args }, value => {
      const error = chrome.runtime.lastError; error ? reject(new Error(error.message)) : resolve(value);
    }));
    if (!result || (!result.ok && !result.conflict)) throw new Error(result?.error || 'Storage owner is unavailable');
    return result;
  }
  D.accountKey = (id, platform = D.platform?.id || D.bilibili.id) => D.model.accountKey(platform,String(id));
  D.store = {
    async get(keys) { const list=Array.isArray(keys)?keys:[keys]; const {data}=await request({op:'read',keys:list}); return Array.isArray(keys)?data:data[keys]; },
    async transaction(fn) {
      for (let n=0;n<16;n++) {
        const {data,revision}=await request({op:'read'});
        const update=fn(data);
        const result=await request({op:'commit',revision,update});
        if(result.ok) return update;
      }
      throw new Error('Concurrent storage changes; retry this action');
    },
    set(update) { return this.transaction(() => structuredClone(update)); },
    async patch(key,fn) { const update=await this.transaction(data=>({[key]:fn(data[key])||data[key]})); return update[key]; },
    async listAction(key,entry,action) {
      if (!D.model.parseAccountKey(key)) throw new Error('Stable account ID required');
      return this.transaction(data=>{
        if(action==='block'){if(entry?.source!=='auto'||!data.whitelist[key]){data.blocklist[key]={...entry,...D.model.parseAccountKey(key)};delete data.whitelist[key];}}
        else if(action==='white'){data.whitelist[key]={...entry,...D.model.parseAccountKey(key)};delete data.blocklist[key];}
        else if(action==='unblock') delete data.blocklist[key];
        else if(action==='unwhite') delete data.whitelist[key];
        else throw new Error('Unknown list action');
        return {blocklist:data.blocklist,whitelist:data.whitelist};
      });
    },
    _subs:[],
    onChange(fn){this._subs.push(fn);return ()=>{this._subs=this._subs.filter(f=>f!==fn);};},
    _emit(update){for(const fn of this._subs)fn(update);},
  };
  if(hasChrome) chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='local') D.store._emit(Object.fromEntries(Object.entries(changes).filter(([k])=>k in D.DEFAULTS).map(([k,v])=>[k,v.newValue])));
  });
  D.effectiveSettings=(settings,platform)=>({...settings,...(platform!==D.bilibili.id?{mode:'mark',hideAtFish:false}:{}),...(settings.platforms?.[platform]||{})});
  const today=()=>{const d=new Date();return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;};
  D.recordKick=(count,chars,platform=D.session?.platform)=>D.store.patch('stats',s=>{
    if(s.day!==today()){s.day=today();s.today=0;}
    s.total=Math.max(0,s.total+count);s.today=Math.max(0,s.today+count);s.chars=Math.max(0,s.chars+(chars||0));
    if(platform){s.platforms||={};const p=s.platforms[platform]||={total:0,chars:0};p.total=Math.max(0,p.total+count);p.chars=Math.max(0,p.chars+(chars||0));}
  });
  D.bump=(field,n=1)=>D.store.patch('stats',s=>{if(typeof s[field]==='number')s[field]+=n;});
  D.memory={
    seen:{},llm:{},epoch:0,pending:{seen:{},llm:{}},timer:0,
    async load(){const r=await D.store.get(['seen','llmCache','memoryEpoch']);this.seen=r.seen;this.llm=r.llmCache;this.epoch=r.memoryEpoch;},
    page(){return D.platformContext?D.model.pageKey(D.platformContext.platform,D.platformContext.pageKey):null;},
    prior(key){const s=this.seen[key];return s?Math.max(0,s.c-(s.k.includes(this.page())?1:0)):0;},
    mark(key,name){
      const pg=this.page();if(!pg||!D.model.parseAccountKey(key))return;
      const old=this.seen[key]||{n:name,c:0,k:[],t:0};if(old.k.includes(pg))return;
      const next={...old,n:name||old.n,c:old.c+1,k:[pg,...old.k].slice(0,6),t:Date.now()};
      this.seen[key]=next;this.pending.seen[key]=next;this.save();
    },
    llmGet(key,version,digest){const c=this.llm[key];return c&&c.strategyVersion===version&&c.digest===digest&&Date.now()-c.t<7*86400000?c:null;},
    llmPut(key,ai,r,version,digest){const c={ai,r:String(r||'').slice(0,60),strategyVersion:version,digest,t:Date.now()};this.llm[key]=c;this.pending.llm[key]=c;this.save();},
    save(){clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush().catch(e=>console.warn('[DFY] Memory save failed',e)),2000);},
    async flush(){
      clearTimeout(this.timer);const pending=this.pending, epoch=this.epoch;this.pending={seen:{},llm:{}};
      if(!Object.keys(pending.seen).length&&!Object.keys(pending.llm).length)return;
      try{await request({op:'memory',epoch,...pending});}catch(e){if(epoch===this.epoch)this.pending={seen:{...pending.seen,...this.pending.seen},llm:{...pending.llm,...this.pending.llm}};throw e;}
    },
  };
  D.store.onChange(ch => {
    if ('memoryEpoch' in ch) { D.memory.epoch=ch.memoryEpoch; D.memory.pending={seen:{},llm:{}}; }
  });
})();
