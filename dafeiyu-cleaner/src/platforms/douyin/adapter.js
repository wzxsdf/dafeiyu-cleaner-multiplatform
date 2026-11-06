/* Isolated-world DOM collection; no page-state, network interception or platform API. */
(function () {
  const D = globalThis.DFY, A = D.douyin, dom = A.comments;
  const bindings = new Map();
  let active = null, sink = null, observer = null, timer = 0, poll = 0, detach = null;
  let fingerprint = '', currentHost = null;
  function cleanup(b) {
    b.dead = true;
    for (const fn of b.cleanups) fn();
    for (const animation of b.animations) animation.cancel();
    for (const [property, value] of b.styles) if (b.el.style[property] === value.applied) b.el.style[property] = value.original;
    for (const node of b.nodes) node.remove();
    for (const [name, value] of b.attributes) if (b.host.getAttribute(name) === value.applied) {
      if (value.original == null) b.host.removeAttribute(name); else b.host.setAttribute(name, value.original);
    }
    delete b.el.dataset.dfyGone; delete b.el.dataset.dfyFolded; delete b.el.dataset.dfyAt;
    bindings.delete(b.el);
  }
  function binding(el) {
    if (!active || !el || !dom.isRenderer(el)) return null;
    const id = dom.identity(el), parts = dom.partsOf(el), account = dom.accountHref(el);
    if (!id || !parts) return null;
    const key = D.model.commentKey(A.id, active.pageKey, id);
    let b = bindings.get(el);
    if (b && (b.key !== key || b.root !== parts.root || b.account !== account || b.sessionId !== active.sessionId)) { cleanup(b); b = null; }
    if (!b) {
      b = { el, ...parts, body: parts.root, id, key, account, sessionId: active.sessionId, generation: Symbol(key), dead: false, nodes: new Set(), styles: new Map(), attributes: new Map(), animations: new Set(), cleanups: new Set() };
      b.valid = () => !b.dead && el.isConnected && active?.sessionId === b.sessionId && A.getPageContext().pageKey === active.pageKey && dom.identity(el) === b.id && dom.partsOf(el)?.root === b.root && dom.accountHref(el) === b.account;
      b.setStyle = (name, value) => { if (!b.valid()) return; const old = b.styles.get(name); b.styles.set(name, { original: old ? old.original : el.style[name], applied: value }); el.style[name] = value; };
      b.restoreStyle = name => { if (!b.valid()) return; const old = b.styles.get(name); if (old && el.style[name] === old.applied) el.style[name] = old.original; b.styles.delete(name); };
      b.setAttribute = (name, value) => { if (!b.valid()) return; const old = b.attributes.get(name); b.attributes.set(name, { original: old ? old.original : b.host.getAttribute(name), applied: String(value) }); b.host.setAttribute(name, String(value)); };
      b.restoreAttribute = name => { if (!b.valid()) return; const old = b.attributes.get(name); if (old && b.host.getAttribute(name) === old.applied) { if (old.original == null) b.host.removeAttribute(name); else b.host.setAttribute(name, old.original); } b.attributes.delete(name); };
      b.track = node => { b.nodes.add(node); return node; };
      bindings.set(el, b);
    }
    return b;
  }
  const each = dom.eachRenderer.bind(dom);
  dom.eachRenderer = cb => {
    const seen = new Set();
    each((el, reply) => { const b = binding(el); if (b) { seen.add(el); cb(el, reply); } });
    for (const [el, b] of bindings) if (!seen.has(el)) cleanup(b);
  };
  dom.binding = binding;
  dom.bindingKey = el => binding(el)?.key;
  A.getBinding = key => [...bindings.values()].find(b => b.key === key && b.valid()) || null;
  function scan() {
    if (!active || active.signal.aborted) return;
    if (A.getPageContext().pageKey !== active.pageKey) { D.checkRoute?.(); return; }
    const host = dom.host();
    if (host !== currentHost) { currentHost = host; fingerprint = ''; }
    const rows = [];
    dom.eachRenderer(el => { const row = dom.read(el, active.pageKey); if (row) rows.push(row); });
    const authors = new Set(rows.filter(r => r.comment.isAuthor && r.account?.id).map(r => r.account.id));
    const authorId = authors.size === 1 ? [...authors][0] : null;
    const state = !host ? 'waiting' : rows.length ? 'ready' : host.querySelector('[data-e2e="comment-item"]') ? 'limited' : 'waiting';
    D.platformStatus.state = state;
    const next = JSON.stringify(rows);
    if (next === fingerprint) { sink?.bindingsChanged?.(); return; }
    fingerprint = next;
    for (let i = 0; i < Math.max(1, rows.length); i += 500) {
      const chunk = rows.slice(i, i + 500);
      const batch = D.model.normalizeBatch({ protocolVersion: 2, platform: A.id, pageKey: active.pageKey, sessionId: active.sessionId, authorId, accounts: chunk.map(r => r.account).filter(Boolean), comments: chunk.map(r => r.comment) }, active);
      if (batch) sink?.comments?.(batch);
    }
    // The controller may set a generic ready/waiting state while receiving data.
    D.platformStatus.state = state;
  }
  function schedule() { if (!active || timer) return; timer = setTimeout(() => { timer = 0; scan(); }, 100); }
  A.start = (session, nextSink, signal) => {
    A.dispose(); active = session; sink = nextSink;
    observer = new MutationObserver(records => {
      // UI inserted by this extension must not trigger a collection/render loop.
      if (records.some(r => !r.target.closest?.('.dfy-b,dfy-host,dfy-note,dfy-report') && (r.type !== 'childList' || [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 3 || n.nodeType === 1 && !n.matches?.('.dfy-b,.dfy-lock,.dfy-fold,style[data-dfy],dfy-note,dfy-report,dfy-host'))))) schedule();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-e2e-vid', 'data-e2e', 'href', 'id'] });
    poll = setInterval(schedule, 1000);
    const stop = () => { if (active === session) A.dispose(); };
    signal.addEventListener('abort', stop, { once: true }); detach = () => signal.removeEventListener('abort', stop);
    scan();
  };
  A.rescan = () => { fingerprint = ''; schedule(); };
  A.dispose = () => {
    observer?.disconnect(); observer = null; clearTimeout(timer); clearInterval(poll); timer = 0; poll = 0;
    detach?.(); detach = null;
    for (const b of [...bindings.values()]) cleanup(b);
    active = null; sink = null; currentHost = null; fingerprint = '';
  };
})();
