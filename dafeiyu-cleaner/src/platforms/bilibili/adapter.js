/* Isolated-world bridge and DOM bindings. Core code never traverses Bilibili DOM. */
(function () {
  const D = globalThis.DFY, A = D.bilibili, dom = A.comments;
  const bindings = new Map();
  let active = null, sink = null;
  const protocol = type => ({ source: 'dfy-iso', protocolVersion: 2, type, platform: A.id, pageKey: active?.pageKey, sessionId: active?.sessionId });
  function cleanup(b) {
    b.dead = true;
    for (const fn of b.cleanups) fn();
    for (const animation of b.animations) animation.cancel();
    b.animations.clear();
    for (const [property, value] of b.styles) if (b.el.style[property] === value.applied) b.el.style[property] = value.original;
    for (const node of b.nodes) node.remove();
    for (const [name, value] of b.attributes) {
      if (b.host.getAttribute(name) !== value.applied) continue;
      if (value.original == null) b.host.removeAttribute(name); else b.host.setAttribute(name,value.original);
    }
    delete b.el.dataset.dfyGone; delete b.el.dataset.dfyFolded; delete b.el.dataset.dfyAt;
    bindings.delete(b.el);
  }
  function binding(el, isReply = dom.isReply(el)) {
    if (!el) return null;
    const id = el.getAttribute('data-dfy-id'), parts = dom.partsOf(el,isReply);
    if (!id || !active || !parts?.root) return null;
    const key = D.model.commentKey(A.id,active.pageKey,id);
    let b = bindings.get(el);
    if (b && (b.key !== key || b.root !== parts.root || b.sessionId !== active.sessionId)) { cleanup(b); b = null; }
    if (!b) {
      b = { el, ...parts, body: parts.root.querySelector('#body') || parts.root.firstElementChild, key, id, isReply, sessionId: active.sessionId, dead: false, styles: new Map(), nodes: new Set(), attributes: new Map(), animations: new Set(), cleanups: new Set(), generation: Symbol(key) };
      b.valid = () => !b.dead && el.isConnected && active?.sessionId === b.sessionId && A.getPageContext().pageKey === active.pageKey && el.getAttribute('data-dfy-id') === b.id && dom.partsOf(el,b.isReply)?.root === b.root;
      b.setStyle = (property,value) => { if (!b.valid()) return; const old=b.styles.get(property); b.styles.set(property,{original:old?.original??el.style[property],applied:value});el.style[property]=value; };
      b.restoreStyle = property => { if (!b.valid()) return; const old=b.styles.get(property);if(old&&el.style[property]===old.applied)el.style[property]=old.original;b.styles.delete(property); };
      b.setAttribute = (name,value) => { if (!b.valid()) return; const old=b.attributes.get(name);b.attributes.set(name,{original:old?old.original:b.host.getAttribute(name),applied:String(value)});b.host.setAttribute(name,String(value)); };
      b.restoreAttribute = name => { if (!b.valid()) return; const old=b.attributes.get(name);if(!old)return;if(b.host.getAttribute(name)===old.applied){if(old.original==null)b.host.removeAttribute(name);else b.host.setAttribute(name,old.original);}b.attributes.delete(name); };
      b.track = node => {b.nodes.add(node);return node;};
      bindings.set(el,b);
    }
    return b;
  }
  const originalEach = dom.eachRenderer.bind(dom);
  dom.eachRenderer = cb => {
    const seen = new Set();
    originalEach((el,isReply) => { const b=binding(el,isReply);if(b){seen.add(el);cb(el,isReply);} });
    for(const [el,b]of bindings)if(!seen.has(el))cleanup(b);
  };
  dom.binding = binding;
  dom.bindingKey = el => binding(el)?.key;
  A.getBinding = key => [...bindings.values()].find(b=>b.key===key&&b.valid()) || null;
  A.start = function (context, nextSink, signal) {
    A.dispose(); active=context;sink=nextSink;
    let fingerprint = '';
    const listener=e=>{
      if(e.source!==window||e.data?.source!=='dfy-main'||e.data.type!=='comments'||!active)return;
      if(A.getPageContext().pageKey!==active.pageKey){D.checkRoute?.();return;}
      const batch=D.model.normalizeBatch(e.data,active);if(!batch)return;
      dom.eachRenderer(()=>{});
      const next = JSON.stringify(batch);
      if (next !== fingerprint) { fingerprint = next; sink?.comments?.(batch); }
      else sink?.bindingsChanged?.();
    };
    window.addEventListener('message',listener);
    const stop=()=>{window.removeEventListener('message',listener);if(active===context)A.dispose();};
    signal.addEventListener('abort',stop,{once:true});
    active.detach=()=>{window.removeEventListener('message',listener);signal.removeEventListener('abort',stop);};
    window.postMessage(protocol('init'),location.origin);
  };
  A.rescan=()=>{if(active)window.postMessage(protocol('rescan'),location.origin);};
  A.dispose=function(){
    if(active){window.postMessage(protocol('stop'),location.origin);active.detach?.();}
    for(const b of [...bindings.values()])cleanup(b);
    active=null;sink=null;
  };
})();
