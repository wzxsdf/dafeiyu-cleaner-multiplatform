/* Bilibili MAIN-world collector. Only normalized comment data crosses the bridge. */
(function () {
  if (window.__dfyMainWorld) return;
  window.__dfyMainWorld = true;
  const D = globalThis.DFY;
  let context = null, timer = 0, poll = 0;
  const ids = value => typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : null;
  const rootId = d => ids(d.root_str) || ids(d.root);
  function authorId() {
    const s = window.__INITIAL_STATE__;
    return ids(s?.videoData?.owner?.mid) || ids(s?.upInfo?.mid) || ids(s?.mediaInfo?.up_info?.mid);
  }
  function row(el,isReply) {
    const d=el.data,m=d?.member;
    const cid=ids(d?.rpid_str)||ids(d?.rpid), uid=ids(m?.mid)||ids(d?.mid_str)||ids(d?.mid);
    if(!cid){el.removeAttribute('data-dfy-id');return null;}
    el.setAttribute('data-dfy-id',cid);
    const features={};
    if(Number.isFinite(m?.level_info?.current_level))features.level=m.level_info.current_level;
    if(m?.official_verify)features.verified=m.official_verify.type===0||m.official_verify.type===1;
    if(m?.vip)features.vip=m.vip.vipStatus>0;
    const account=uid?{platform:D.bilibili.id,id:uid,name:m?.uname||'',avatarUrl:m?.avatar||null,signature:m?.sign??null,profileUrl:D.bilibili.profileUrl(uid),features}:null;
    const mentions=[];
    for(const [name,id]of Object.entries(d.content?.at_name_to_mid||{}))mentions.push({name,accountId:ids(id)});
    for(const m of d.content?.members||[])if(m?.uname&&!mentions.some(a=>a.name===m.uname))mentions.push({name:m.uname,accountId:ids(m.mid)});
    const root=rootId(d);
    const comment={platform:D.bilibili.id,pageKey:context.pageKey,id:cid,accountId:uid,text:d.content?.message||'',rootId:root&&root!=='0'?root:null,parentId:ids(d.parent_str)||ids(d.parent),isReply,mentions,createdAt:Number.isFinite(d.ctime)?d.ctime*1000:null};
    return {account,comment};
  }
  function scan() {
    if(!context||D.bilibili.getPageContext().pageKey!==context.pageKey)return;
    const rows=[];
    D.bilibili.comments.eachRenderer((el,isReply)=>{const r=row(el,isReply);if(r)rows.push(r);});
    for(let i=0;i<Math.max(1,rows.length);i+=500){
      const chunk=rows.slice(i,i+500);
      window.postMessage({source:'dfy-main',type:'comments',protocolVersion:2,...context,authorId:authorId(),accounts:chunk.map(r=>r.account).filter(Boolean),comments:chunk.map(r=>r.comment)},location.origin);
    }
  }
  function schedule() {
    if(!context||timer)return;
    timer=setTimeout(()=>{timer=0;try{scan();}catch(e){console.warn('[DFY] Comment scan failed',e);}},80);
  }
  window.addEventListener('message',e=>{
    const m=e.data;
    if(e.source!==window||!m||m.source!=='dfy-iso'||m.protocolVersion!==2||m.platform!==D.bilibili.id)return;
    if(m.type==='stop'&&m.sessionId===context?.sessionId){context=null;clearInterval(poll);clearTimeout(timer);timer=0;return;}
    if(m.type!=='init'&&m.type!=='rescan')return;
    if(typeof m.sessionId!=='string'||m.sessionId.length>128||m.pageKey!==D.bilibili.getPageContext().pageKey)return;
    if(m.type==='init'){context={platform:m.platform,pageKey:m.pageKey,sessionId:m.sessionId};clearInterval(poll);poll=setInterval(schedule,1500);}
    if(m.sessionId===context?.sessionId)schedule();
  });
  for(const tag of ['bili-comment-thread-renderer','bili-comment-reply-renderer','bili-comment-renderer']){
    customElements.whenDefined(tag).then(()=>{
      const proto=customElements.get(tag).prototype;
      for(const fn of ['connectedCallback','updated']){
        const original=proto[fn];if(typeof original!=='function'||original.__dfy)continue;
        const wrapped=function(){const r=original.apply(this,arguments);schedule();return r;};wrapped.__dfy=true;proto[fn]=wrapped;
      }
    });
  }
  document.addEventListener('scroll',schedule,{passive:true,capture:true});
})();
