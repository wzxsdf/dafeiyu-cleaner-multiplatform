/* 评论区：识别、标记、单条赶走、折叠、响指清场、DeepSeek 精判 */
(function () {
  const DFY = (globalThis.DFY = globalThis.DFY || {});
  DFY.createCommentController = function (session) {
  const C = {};
  const esc = (s) => DFY.esc(s);
  const keyOf = (key) => key;

  const items = new Map(); // comment key -> item
  const accounts = new Map(); // account key -> {acc, rpids:Set, verdict, llm}
  const gone = new Set(); // 已赶走的 rpid
  const peeked = new Set(); // 折叠后被“偷看”的 rpid
  const spared = new Set(); // 本页被用户「放回来」的 mid，自动清场不再赶它
  const byName = new Map(); // 本页昵称 -> mid
  const atHidden = new Set(); // 因为 @ 了大肥鱼被隐藏的 rpid
  let atPeek = false; // 用户点了「显示」，本页不再隐藏 @ 大肥鱼的评论
  const quiet = () => !!DFY.settings.quiet;
  const animateComments = () => session.adapter.getCapabilities?.().commentAnimation !== false;
  const policyOf = () => DFY.detection.get(session.platform)?.getPolicy?.({ threshold: DFY.settings.threshold }) || DFY.detection.common.policy();
  const canAutomate = () => policyOf().autoBlock === true;
  const cacheVersionOf = strategy => `${strategy.version}:${strategy.llmPromptVersion || 'offline'}:${DFY.settings.llmModel || ''}`;
  let upMid = '';
  let report = null;
  let lastFound = 0, lastFishCount = 0;

  /* Normalized adapter input. This controller does not read page messages directly. */
  C.receive = function (batch) {
    if (!DFY.settings?.enabled || !DFY.lists) return;
    if (!session?.active()) return;
    const strategy = DFY.detection.get(session.platform);
    const previousAuthor = upMid;
    upMid = batch.authorId ? DFY.model.accountKey(session.platform, batch.authorId) : '';
    const fresh = new Set();
    for (const account of batch.accounts) {
      let a = accounts.get(account.key);
      if (!a) {
        a = { acc: account, rpids: new Set(), verdict: null, llm: null, digest: '' };
        accounts.set(account.key, a);
        if (strategy?.avatar) strategy.avatar(account).then(b => {
          if (!session.active() || accounts.get(account.key) !== a) return;
          a.acc.avatarBlue = b; judge(a); C.render();
        });
      } else {
        a.acc = { ...a.acc, ...account, signature: account.signature ?? a.acc.signature, avatarUrl: account.avatarUrl || a.acc.avatarUrl, features: { ...a.acc.features,...account.features } };
      }
      fresh.add(account.key);
    }
    for (const it of batch.comments) {
      const previous = items.get(it.key);
      if (previous && previous.accountKey !== it.accountKey) accounts.get(previous.accountKey)?.rpids.delete(it.key);
      items.set(it.key,it);
      if (!it.accountKey) {
        it.accountKey = 'session:' + it.key;
        if (!accounts.has(it.accountKey)) accounts.set(it.accountKey, { acc: { key: it.accountKey, id: null, name: '', avatarUrl: null, signature: null, features: {} }, rpids: new Set(), verdict: DFY.detection.unassessed(), llm: null });
      }
      const a = accounts.get(it.accountKey);
      a.rpids.add(it.key);
      fresh.add(it.accountKey);
    }
    byName.clear();
    for (const a of accounts.values()) {
      if (!a.acc.name) continue;
      byName.set(a.acc.name, byName.has(a.acc.name) ? null : a.acc.key);
    }
    if (previousAuthor !== upMid) for (const key of accounts.keys()) fresh.add(key);
    for (const key of new Set([...fresh,...refreshCallouts()])) judge(accounts.get(key));
    DFY.platformStatus.state = batch.comments.length || items.size ? 'ready' : 'waiting';
    C.render(); queueLLM();
  };

  let callout = new Map(); // mid -> 被几个人点名是大肥鱼
  function refreshCallouts() {
    const strategy = DFY.detection.get(session.platform);
    const next = strategy?.callouts ? strategy.callouts([...items.values()].map(c => ({ ...c, name: accounts.get(c.accountKey)?.acc.name || '', rootKey: c.rootId ? DFY.model.commentKey(c.platform,c.pageKey,c.rootId) : null }))) : new Map();
    const changed = [...new Set([...next.keys(), ...callout.keys()])].filter(mid => callout.get(mid) !== next.get(mid));
    callout = next;
    return changed;
  }

  function textsOf(a) {
    return [...a.rpids].map((id) => items.get(id)).filter(Boolean);
  }

  function judge(a) {
    if (!a) return;
    const its = textsOf(a);
    const mid = a.acc.key;
    if (!a.acc.id) { a.verdict = DFY.detection.unassessed(); return; }
    if (DFY.lists.white[mid]) {
      a.verdict = { status: 'manual', score: null, level: 'human', reasons: [{ w: 0, why: '你已将此账号加入白名单' }] };
      return;
    }
    if (DFY.lists.block[mid]) {
      a.verdict = { status: 'manual', score: null, level: 'fish', reasons: [{ w: 0, why: '你已将此账号加入本地隐藏名单，名单不代表 AI 判定' }] };
      return;
    }
    const strategy = DFY.detection.get(session.platform);
    if (!strategy) {
      a.verdict = DFY.lists.block[mid] ? { status: 'manual', score: null, level: 'fish', reasons: [{ w: 0, why: '你已将此账号加入本地隐藏名单，尚未进行 AI 判定' }] } : DFY.detection.unassessed();
      return;
    }
    const judgeCtx = {
      upMid,
      topCount: its.filter((i) => !i.isReply).length,
      priorPages: DFY.memory.prior(keyOf(mid)),
      calledOut: callout.get(String(mid)) || 0,
      threshold: DFY.settings.threshold,
      pageKey: session.pageKey,
      platform: session.platform,
    };
    const digest = strategy.digest
      ? strategy.digest(a.acc, its, judgeCtx)
      : JSON.stringify([a.acc.name, a.acc.signature, a.acc.features, its.slice(0, 3).map(c => c.text.slice(0, 220))]);
    const cacheVersion = cacheVersionOf(strategy);
    if (a.digest !== digest || a.cacheVersion !== cacheVersion) {
      a.digest = digest;
      a.cacheVersion = cacheVersion;
      const cached = strategy.llm ? DFY.memory.llmGet(mid, cacheVersion, digest) : null;
      a.llm = cached ? { ai: cached.ai, reason: cached.r, cached: true } : null;
      llmDone.delete(mid);
    }
    const off = strategy.judge(a.acc, its, judgeCtx);
    const combined = strategy.combine ? strategy.combine(off, DFY.settings.llmEnabled ? a.llm : null, judgeCtx) : { score: off.score, reasons: off.reasons };
    let score = combined.score;
    const reasons = (combined.reasons || off.reasons || []).slice();
    let level = strategy.classify ? strategy.classify(score, off, judgeCtx) : DFY.levelOf(score, DFY.settings.threshold);
    const common = DFY.detection.common;
    a.verdict = {
      status: 'assessed', strategyVersion: strategy.version, score, offline: off.score, level,
      confidence: off.confidence || (level === 'unknown' ? 'insufficient' : level === 'fish' ? 'candidate' : 'weak'),
      evidence: common?.reasons(off.evidence || reasons, { source: `${session.platform}-offline` }) || reasons,
      availableFeatures: off.availableFeatures || null,
      missingFeatures: off.missingFeatures || null,
      reasons,
    };
    // 只凭当前页面的强证据才记历史；平台策略可以完全关闭历史。
    const remember = strategy.shouldRemember
      ? strategy.shouldRemember(off, judgeCtx)
      : (off.raw ?? off.score) >= DFY.settings.threshold;
    if (remember && (!a.llm || a.llm.ai >= 50)) DFY.memory.mark(keyOf(mid), a.acc.name);
  }
  C.rejudgeAll = function () {
    if (!session.active()) return;
    for (const a of accounts.values()) judge(a);
    C.render(); queueLLM();
  };
  /* ---------------- @ 大肥鱼的评论（召唤它来看视频、跟它聊天） ---------------- */
  function fishMid(mid) {
    if (DFY.lists.block[keyOf(mid)]) return true;
    const a = accounts.get(String(mid));
    return !!(a && a.verdict && a.verdict.level === 'fish');
  }
  /** 返回被 @ 的大肥鱼昵称，没有则返回空串 */
  function atFish(it, blockedNames) {
    const ats = new Map();
    for (const x of it.mentions || []) ats.set(x.name, x.accountId ? DFY.model.accountKey(it.platform,x.accountId) : '');
    for (const m of it.text.matchAll(/@([^\s@:：，,。！!?？]{1,24})/g)) if (!ats.has(m[1])) ats.set(m[1], byName.get(m[1]) || '');
    for (const [n, mid] of ats) {
      if (mid && DFY.lists.white[keyOf(mid)]) continue;
      if ((mid && fishMid(mid)) || blockedNames.has(n) || DFY.detection.get(session.platform)?.fishName?.(n)) return n;
    }
    return '';
  }
  function showAt(el) {
    delete el.dataset.dfyAt;
    setDisplay(el, '');
    atHidden.delete(bindingKey(el));
  }

  /* 极简模式的隐藏记录、被隐藏的 @ 大肥鱼评论：评论区上方一行小字，可以一键放回 */
  const note = {
    el: null,
    fish: [], // 极简模式下隐藏的大肥鱼评论元素
    added: [], // 因此新加入遣返名单的 mid
    chars: 0,
    addFish(els, mids, chars) {
      this.fish.push(...els);
      this.added.push(...mids);
      this.chars += chars;
      this.render();
    },
    render() {
      const bc = session.adapter.comments.host?.();
      const n = this.fish.length, m = atHidden.size;
      if (!bc || (!n && !m)) {
        if (this.el) this.el.remove();
        this.el = null;
        return;
      }
      if (!this.el || !this.el.isConnected) {
        this.el = document.createElement('dfy-note');
        this.el.attachShadow({ mode: 'open' });
        bc.before(this.el);
      }
      const parts = [];
      if (n) parts.push(`${n} 条已选评论`);
      if (m) parts.push(`${m} 条 @ 大肥鱼的评论`);
      const sig = parts.join('、');
      if (this.el.dataset.sig === sig) return;
      this.el.dataset.sig = sig;
      // 跟随 B 站自己的配色变量，浅色 / 深色主题都不突兀
      this.el.shadowRoot.innerHTML = `<style>
:host{display:block;margin:4px 0 10px}
.n{display:flex;align-items:center;gap:6px;font:13px/1.6 "PingFang SC","Microsoft YaHei",sans-serif;color:var(--text3,#9499a0)}
button{all:unset;cursor:pointer;color:var(--brand_blue,#00aeec)}
button:hover{text-decoration:underline}
</style><div class="n">${DFY.icon('hide', 14, 2)}<span>大肥鱼消除计划：已隐藏 ${sig}</span><button>显示</button></div>`;
      this.el.shadowRoot.querySelector('button').onclick = () => this.undo();
    },
    async undo() {
      const els = this.fish, added = this.added, chars = this.chars;
      this.fish = [];
      this.added = [];
      this.chars = 0;
      for (const b of els) {
        const id = b.key;
        gone.delete(id);
        peeked.add(id);
        const it = items.get(id);
        if (it) spared.add(it.accountKey);
        if (b.valid()) { b.restoreStyle('display'); delete b.el.dataset.dfyGone; }
      }
      if (added.length) {
        await session.wait(DFY.store.patch('blocklist', (b) => {
          for (const mid of added) delete b[keyOf(mid)];
        }));
        for (const mid of added) delete DFY.lists.block[keyOf(mid)];
      }
      if (els.length) await session.wait(DFY.recordKick(-els.length, -chars, session.platform));
      atPeek = true;
      eachRenderer((el) => el.dataset.dfyAt && showAt(el));
      C.rejudgeAll();
    },
  };

  /** 极简模式：不播动画，直接隐藏并记一笔 */
  async function quietHide(els, source = 'manual') {
    const captured = els.map(el => session.adapter.comments.binding(el)).filter(Boolean);
    const mids = new Set();
    let chars = 0;
    for (const el of els) {
      const id = bindingKey(el);
      gone.add(id);
      DFY.fx.collapse(el, 0);
      const it = items.get(id);
      if (it) {
        chars += it.text.length;
        mids.add(it.accountKey);
      }
    }
    const added = [];
    for (const mid of mids) {
      const a = accounts.get(mid);
      if (!a) continue;
      if (!DFY.lists.block[keyOf(mid)]) added.push(mid);
      await session.wait(addBlock(a, source));
    }
    await session.wait(DFY.recordKick(els.length, chars, session.platform));
    note.addFish(captured, added, chars);
    C.render();
  }

  const bindingKey = (el) => session.adapter.comments.bindingKey(el) || '';
  const setDisplay = (el,value) => { const b=session.adapter.comments.binding(el); if(value==='')b?.restoreStyle('display');else b?.setStyle('display',value); };
  /* ---------------- DOM 遍历 ---------------- */
  function eachRenderer(cb) {
    session.adapter.comments.eachRenderer(cb);
  }
  function partsOf(el, isReply) {
    return session.adapter.comments.binding(el, isReply) || null;
  }
  function accOfEl(el) {
    const id = bindingKey(el);
    const it = id && items.get(id);
    return it ? accounts.get(it.accountKey) : null;
  }
  DFY.isFishEl = (el) => {
    const a = accOfEl(el);
    return !!(a && a.verdict && a.verdict.level === 'fish');
  };

  const BADGE_CSS = `
.dfy-b{display:inline-flex;align-items:center;gap:6px;margin-left:8px;vertical-align:middle;font-family:"PingFang SC","Microsoft YaHei",sans-serif;--ink:#151a3d}
.dfy-b svg{flex:none;display:block}
.dfy-tag{display:inline-flex;align-items:center;gap:4px;font-family:"DFY Display","PingFang SC",sans-serif;font-size:13.5px;letter-spacing:.5px;padding:0 8px 0 6px;height:22px;border:2px solid var(--ink);border-radius:6px;cursor:help;white-space:nowrap;user-select:none;box-shadow:2px 2px 0 var(--ink)}
.dfy-b[data-l="fish"] .dfy-tag{background:#ff5d8a;color:#fff;transform:rotate(-3deg);animation:dfy-wiggle 2.6s ease-in-out infinite}
.dfy-b[data-l="suspect"] .dfy-tag{background:#ffe3a6;color:#8a5200}
.dfy-b[data-l="human"] .dfy-tag{background:#d9f5e7;color:#0f7a4e}
.dfy-tag .ai{font-family:sans-serif;font-size:9.5px;font-weight:900;background:#151a3d;color:#6fe0ff;border-radius:3px;padding:0 3px;margin-left:2px;line-height:14px}
.dfy-btn{all:unset;display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-family:"DFY Display","PingFang SC",sans-serif;font-size:13.5px;letter-spacing:.5px;height:22px;padding:0 9px;border:2px solid var(--ink);border-radius:6px;white-space:nowrap;transition:transform .1s,box-shadow .1s}
.dfy-btn:hover{transform:translate(-1px,-1px);box-shadow:3px 3px 0 var(--ink)}
.dfy-btn:active{transform:translate(1px,1px);box-shadow:none}
.dfy-kick{background:#2546b8;color:#fff;box-shadow:2px 2px 0 var(--ink)}
.dfy-ok{background:#fffaf2;color:#5b6378;border-style:dashed}
.dfy-llm{background:#e9efff;color:#2546b8}
.dfy-b.q .dfy-tag,.dfy-b.q .dfy-btn{animation:none;transform:none;box-shadow:none;border-width:1.5px;height:20px;font-size:12.5px}
.dfy-b.q .dfy-btn:hover{transform:none;box-shadow:none;filter:brightness(1.08)}
.dfy-lock{position:absolute;pointer-events:none;z-index:3;}
.dfy-lock svg{width:100%;height:100%;display:block;opacity:.5;animation:dfy-lockspin 5s linear infinite}
.dfy-lock.fire svg{opacity:.85}
.dfy-lock b{position:absolute;left:50%;top:-9px;transform:translateX(-50%);background:#ff2d55;color:#fff;font:900 8px/1 sans-serif;letter-spacing:1px;padding:2px 4px;border-radius:3px;white-space:nowrap}
.dfy-lock.in{animation:dfy-lockin .6s cubic-bezier(.2,1.3,.4,1) both}
.dfy-lock.fire svg{animation:dfy-lockspin .4s linear infinite}
.dfy-lock.fire b{background:#151a3d}
@keyframes dfy-lockin{0%{transform:scale(3.4) rotate(-120deg);opacity:0}55%{opacity:1}100%{transform:none;opacity:1}}
@keyframes dfy-lockspin{to{transform:rotate(360deg)}}
@keyframes dfy-wiggle{0%,88%,100%{transform:rotate(-3deg)}92%{transform:rotate(-9deg)}96%{transform:rotate(3deg)}}
`;

  function ensureStyle(root) {
    if (root.querySelector('style[data-dfy]')) return;
    const s = document.createElement('style');
    s.setAttribute('data-dfy', '');
    s.textContent = BADGE_CSS + (session.adapter.comments.highlightCSS || '');
    root.appendChild(s);
    eachRenderer(el => { const b=session.adapter.comments.binding(el); if(b?.root===root)b.track(s); });
  }

  const ICON = {
    get fish() { return DFY.icon('fish', 15, 2.4); },
    get bowl() { return DFY.icon('bowl', 15, 2.2); },
    get think() { return DFY.icon('question', 14, 2.4); },
    get ok() { return DFY.icon('check', 14, 2.8); },
    get brain() { return DFY.icon('brain', 14, 2.2); },
    get hide() { return DFY.icon('hide', 14, 2.2); },
  };

  function badgeHTML(a) {
    const v = a.verdict;
    const label = v.status === 'manual' ? (v.level === 'human' ? ICON.ok + '白名单' : ICON.hide + '名单账号') : v.status === 'unassessed' ? ICON.think + '暂未判定' : v.level === 'fish' ? ICON.fish + '疑似自动账号' : v.level === 'suspect' ? ICON.think + '待核实' : ICON.think + '证据不足';
    const ai = a.llm && DFY.settings.llmEnabled ? '<span class="ai">DS</span>' : '';
    const llmBtn = DFY.detection.get(session.platform)?.llm && v.status === 'assessed' && DFY.settings.llmEnabled && DFY.settings.llmKey && !a.llm ? '<button class="dfy-btn dfy-llm" data-act="llm">' + ICON.brain + ' 复核</button>' : '';
    const kickBtn = v.level !== 'human' ? '<button class="dfy-btn dfy-kick" data-act="kick">' + ICON.hide + '隐藏</button>' : '';
    const okBtn = a.acc.id && v.level !== 'human' ? '<button class="dfy-btn dfy-ok" data-act="ok">保留账号</button>' : '';
    return `<span class="dfy-tag">${label}${ai}</span>${kickBtn}${llmBtn}${okBtn}`;
  }

  function tipHTML(a) {
    const v = a.verdict;
    if (v.status === 'unassessed') return '<h4>暂未判定</h4><p>当前没有适用的识别策略或稳定账号 ID，可手动隐藏。</p>';
    if (v.status === 'manual') return v.level === 'human' ? '<h4>本地白名单</h4><p>你选择保留此账号的评论，此操作不代表已验证账号身份。</p>' : '<h4>本地隐藏名单</h4><p>你已选择隐藏此账号；名单操作不代表 AI 身份判定。</p>';
    const title = v.level === 'fish' ? '疑似自动运营账号' : v.level === 'suspect' ? '需要进一步核实' : '证据不足';
    const lis = v.reasons.slice(0, 7).map(r => `<li><span>${esc(r.why)}${r.kind === 'self_claimed' ? '（账号自述）' : ''}</span></li>`).join('');
    const llm = a.llm && DFY.settings.llmEnabled ? `<div class="llm"><i>${DFY.icon('brain', 14)}DeepSeek 复核${a.llm.cached ? ' · 使用近期缓存' : ''}</i>${esc(a.llm.reason || '')}</div>` : '';
    const missing = v.missingFeatures?.length ? '<p>部分账号资料未取得；未取得不等于真人。</p>' : '';
    return `<h4 class="${v.level}">${title}</h4><div class="who">@${esc(a.acc.name)}</div><ul>${lis || '<li><span>尚未观察到足够的自动运营证据</span></li>'}</ul>${missing}<p>规则与模型结论均为线索，不是身份验证。</p>${llm}`;
  }

  const RETICLE = '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="25" fill="none" stroke="#ff2d55" stroke-width="3.2" stroke-dasharray="9 5"/><circle cx="32" cy="32" r="17" fill="none" stroke="#ff2d55" stroke-width="2"/><path d="M32 1v13M32 50v13M1 32h13M50 32h13" stroke="#ff2d55" stroke-width="3.4" stroke-linecap="round"/></svg>';
  let lockQueue = 0;
  /** 红靶心锁定大肥鱼头像（第一次出现在视野里时播放锁定动画） */
  function lockOn(el, isReply, p) {
    if (p.root.querySelector('.dfy-lock')) return;
    const av = avatarOf(el);
    const body = p.body;
    if (!av || !body) return;
    const ar = av.getBoundingClientRect(), br = body.getBoundingClientRect();
    if (!ar.width) return;
    const position = body.style.position; body.style.position = 'relative';
    p.cleanups.add(() => { if (body.style.position === 'relative') body.style.position = position; });
    const size = Math.max(44, ar.width * 1.7);
    const lk = document.createElement('span');
    lk.className = 'dfy-lock';
    lk.innerHTML = RETICLE + '<b>LOCKED</b>';
    Object.assign(lk.style, { left: ar.left - br.left + ar.width / 2 - size / 2 + 'px', top: ar.top - br.top + ar.height / 2 - size / 2 + 'px', width: size + 'px', height: size + 'px' });
    body.appendChild(lk); p.track(lk);
    lk.style.opacity = '0';
    const play = () => {
      const delay = Math.min(1600, lockQueue++ * 110);
      session.later(() => lockQueue--, delay + 600);
      lk.style.opacity = '';
      lk.style.animationDelay = delay + 'ms';
      lk.classList.add('in');
      session.later(() => DFY.sfx.lock(), delay + 380);
    };
    // 滚到眼前的那一刻才播放锁定动画
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        play();
      }
    }, { threshold: 0.4 });
    io.observe(el); p.cleanups.add(() => io.disconnect());
  }

  function decorate(el, isReply, a) {
    const p = partsOf(el, isReply);
    if (!p) return;
    const v = a.verdict;
    const show = v.status === 'unassessed' || v.level !== 'human' || (a.llm && DFY.settings.llmEnabled);
    p.setAttribute('dfy-level', v.level || 'unassessed');
    if (quiet()) p.setAttribute('dfy-q',''); else p.restoreAttribute('dfy-q');
    if (v.level === 'fish' && !quiet() && animateComments()) {
      ensureStyle(p.root);
      lockOn(el, isReply, p);
    } else {
      const old = p.root.querySelector('.dfy-lock');
      old && old.remove();
    }
    let b = p.root.querySelector('.dfy-b');
    if (!show) {
      if (b) b.remove();
      return;
    }
    ensureStyle(p.root);
    const sig = `${v.status}|${v.level}|${v.score}|${!!a.llm}|${DFY.settings.llmEnabled}|${quiet()}`;
    if (b && b.dataset.sig === sig) return;
    if (!b) {
      const info = session.adapter.comments.userInfo?.(el, isReply);
      if (!info) return;
      b = document.createElement('span');
      b.className = 'dfy-b';
      info.after(b); p.track(b);
      b.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (!act) return;
        e.stopPropagation();
        e.preventDefault();
        const acc = accOfEl(el);
        if (act.dataset.act === 'kick') C.kick(el, acc);
        if (act.dataset.act === 'ok') C.markHuman(acc);
        if (act.dataset.act === 'llm') C.llmJudge([acc], true);
      });
      const tag = () => b.querySelector('.dfy-tag');
      b.addEventListener('mouseover', (e) => {
        if (e.target !== tag() && !tag().contains(e.target)) return;
        const r = tag().getBoundingClientRect();
        const acc = accOfEl(el);
        if (acc) DFY.ui.tip(true, r.left, r.bottom - 8, tipHTML(acc));
      });
      b.addEventListener('mouseout', () => DFY.ui.tip(false));
    }
    b.dataset.l = v.level || 'unassessed';
    b.dataset.sig = sig;
    b.classList.toggle('q', quiet() || !animateComments());
    b.innerHTML = badgeHTML(a);
  }

  function fold(el, a) {
    if (el.dataset.dfyFolded || peeked.has(bindingKey(el))) return;
    el.dataset.dfyFolded = '1';
    setDisplay(el, 'none');
    const ph = document.createElement('div');
    const binding = session.adapter.comments.binding(el);
    ph.className = 'dfy-fold'; binding?.track(ph);
    const reveal = () => {
      if (!session.active() || !binding?.valid()) return;
      peeked.add(binding.key);
      setDisplay(el, '');
      delete el.dataset.dfyFolded;
      ph.remove();
    };
    if (quiet() || !animateComments()) {
      ph.setAttribute('style', 'margin:4px 0 4px ' + (session.adapter.comments.isReply?.(el) ? '0' : (session.adapter.comments.foldIndent || '80px')) + ';font:13px/1.6 "PingFang SC","Microsoft YaHei",sans-serif;color:var(--text3,#9499a0)');
      ph.innerHTML = `已折叠 @${esc(a.acc.name)} 的${a.verdict.status === 'manual' ? '名单账号评论' : '疑似自动账号评论（待核实）'} <button style="all:unset;cursor:pointer;color:var(--brand_blue,#00aeec)">显示</button>`;
      ph.querySelector('button').onclick = reveal;
      el.before(ph);
      return;
    }
    ph.setAttribute(
      'style',
      'margin:6px 0 6px ' + (session.adapter.comments.isReply?.(el) ? '0' : (session.adapter.comments.foldIndent || '80px')) + ';padding:5px 12px 5px 8px;border-radius:10px;background:#f5eadd;border:2px dashed #151a3d;color:#151a3d;font:600 13px "PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;gap:8px'
    );
    const home = DFY.actors.src('home');
    const pic = home ? `<img src="${home}" alt="" style="width:38px;height:38px;margin:-6px 0;flex:none">` : `<span style="color:#2546b8;display:flex">${DFY.icon('bowl', 18, 2)}</span>`;
    ph.innerHTML = `${pic}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@${esc(a.acc.name)} 被装进白饭碗，回家吃饭去了（疑似自动账号）</span><button style="all:unset;cursor:pointer;flex:none;color:#2546b8;font:400 14px 'DFY Display','PingFang SC',sans-serif;letter-spacing:.5px;border:2px solid #151a3d;border-radius:6px;padding:0 8px;background:#fffaf2">偷看一眼</button>`;
    ph.querySelector('button').onclick = reveal;
    el.before(ph);
  }

  /* ---------------- 渲染 ---------------- */
  let renderQueued = false;
  C.render = function () {
    if (!session.active() || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!session.active()) return;
      doRender();
    });
  };
  function doRender() {
    if (!session.active() || !DFY.settings || !DFY.settings.enabled) return;
    const s = DFY.settings;
    let fishEls = 0;
    const fishMids = new Set();
    const autoKick = [];
    const atOn = canAutomate() && s.hideAtFish && !atPeek;
    const blockedNames = atOn ? new Set(Object.entries(DFY.lists.block).filter(([key]) => DFY.model.parseAccountKey(key)?.platform === session.platform).map(([,b]) => b.n)) : null;
    eachRenderer((el, isReply) => {
      const id = bindingKey(el);
      const it = id && items.get(id);
      if (!it) return;
      const a = accounts.get(it.accountKey);
      if (!a || !a.verdict) return;
      if (gone.has(id)) {
        if (el.style.display !== 'none') {
          setDisplay(el, 'none');
          el.dataset.dfyGone = '1';
        }
        const ph = el.previousElementSibling;
        if (ph && ph.classList && ph.classList.contains('dfy-fold')) ph.remove();
        return;
      }
      if (el.dataset.dfyGone) { setDisplay(el, ''); delete el.dataset.dfyGone; }
      decorate(el, isReply, a);
      const at = atOn && a.verdict.level !== 'fish' ? atFish(it, blockedNames) : '';
      if (at && !el.dataset.dfyAt) {
        el.dataset.dfyAt = at;
        setDisplay(el, 'none');
        atHidden.add(id);
      } else if (!at && el.dataset.dfyAt) showAt(el);
      if (a.verdict.level !== 'fish' && el.dataset.dfyFolded) {
        const ph = el.previousElementSibling;
        if (ph?.classList.contains('dfy-fold')) ph.remove();
        delete el.dataset.dfyFolded;
        if (!el.dataset.dfyAt) setDisplay(el, '');
      }
      if (a.verdict.level === 'fish') {
        if (!el.dataset.dfyFolded) fishEls++;
        fishMids.add(it.accountKey);
        if (spared.has(it.accountKey)) return;
        if (canAutomate() && s.mode === 'auto') autoKick.push({ el, a });
        else if (DFY.lists.block[keyOf(it.accountKey)] || canAutomate() && s.mode === 'fold') fold(el, a);
      }
    });
    C.fishCount = fishEls;
    DFY.ui.setCount(fishEls);
    if (s.mode !== 'auto' && fishEls > lastFishCount && Date.now() - lastFound > 9000 && !DFY.ui.cannonOn) {
      lastFound = Date.now();
      DFY.ui.say(DFY.say('found', { n: fishEls }), { face: 'angry', ms: 3200 });
    }
    lastFishCount = fishEls;
    if (autoKick.length) autoKickRun(autoKick);
    note.render();
  }

  /* ---------------- 自动清场 ----------------
   * 第一次看到评论区里的大肥鱼：鲸鱼娘走过去打一个完整的响指；
   * 之后翻页加载出来的新大肥鱼：直接被赶走（小鱼抱着白饭碗跑掉）。 */
  let autoSnapDone = false, autoTimer = 0, autoBusy = false;
  function commentsVisible() {
    const bc = session.adapter.comments.host?.();
    if (!bc) return false;
    const r = bc.getBoundingClientRect();
    return r.top < innerHeight * 0.85 && r.bottom > 0;
  }
  function autoKickRun(list) {
    if (autoBusy || snapping) return;
    list = list.map(item => ({ ...item, binding: session.adapter.comments.binding(item.el) }));
    if (quiet() || !animateComments()) {
      autoBusy = true;
      quietHide(list.map((x) => x.el), 'auto').catch(error => { if(error.name !== 'AbortError')console.warn('[DFY] Hide failed',error); }).finally(() => (autoBusy = false));
      return;
    }
    if (!autoSnapDone) {
      clearTimeout(autoTimer);
      autoTimer = session.later(() => {
        if (!commentsVisible()) return C.render();
        autoSnapDone = true;
        C.snap({ auto: true });
      }, 1200);
      return;
    }
    autoBusy = true;
    (async () => {
      let n = 0, chars = 0;
      for (const { el, a, binding } of list) {
        if (!binding?.valid()) continue;
        const id = bindingKey(el);
        if (gone.has(id)) continue;
        gone.add(id);
        chars += (items.get(id) || {}).text?.length || 0;
        n++;
        await session.wait(addBlock(a, 'auto'));
        if (!binding.valid()) continue;
        if (DFY.fx.inView(el)) {
          const p = avatarPoint(el);
          const f = DFY.actors.spawnFish(p.x, p.y, { mood: 'scared', size: 76 });
          await session.sleep(600);
          DFY.actors.flee(f);
          if (binding.valid()) DFY.fx.collapse(el, 320);
        } else DFY.fx.collapse(el, 0);
        await session.sleep(160);
      }
      if (n) {
        DFY.ui.say(`又有 ${n} 条大肥鱼游过来，已经赶走啦`, { face: 'smug' });
        DFY.recordKick(n, chars);
        report.add(n, chars);
      }
      autoBusy = false;
    })().catch(error => { if (error.name !== 'AbortError') console.warn('[DFY] Automatic action failed', error); }).finally(() => { autoBusy = false; });
  }

  function fire(el) {
    const p = partsOf(el, session.adapter.comments.isReply?.(el));
    const lk = p && p.root.querySelector('.dfy-lock');
    if (lk) {
      lk.classList.add('fire');
      lk.querySelector('b').textContent = 'FIRE';
    }
  }
  function avatarOf(el) {
    return session.adapter.comments.avatarOf(el, session.adapter.comments.isReply?.(el)) || null;
  }
  function avatarPoint(el) {
    const av = avatarOf(el);
    const r = (av || el).getBoundingClientRect();
    return av ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: r.left + 30, y: r.top + 24 };
  }

  /* ---------------- 动作 ---------------- */
  async function addBlock(a, source = 'manual') {
    session.assert();
    if (!a.acc.id) return;
    await DFY.store.listAction(a.acc.key, { n: a.acc.name, a: a.acc.avatarUrl, t: Date.now(), s: a.verdict?.score, source }, 'block');
    session.assert();
    DFY.lists.block[a.acc.key] = { n: a.acc.name, source, t: Date.now() };
    delete DFY.lists.white[a.acc.key];
    judge(a);
  }

  /** 赶走一条（以及同一账号在本页的其他评论）：鲸鱼娘走过去，把鱼赶回家 */
  C.kick = async function (el, a, style) {
    if (!a) return;
    const id = bindingKey(el);
    if (gone.has(id)) return;
    DFY.ui.tip(false);
    DFY.ui.menu(false);
    const all = [];
    eachRenderer((e2) => {
      const id2 = bindingKey(e2);
      const it2 = id2 && items.get(id2);
      if (it2 && it2.accountKey === a.acc.key && !gone.has(id2)) all.push(e2);
    });
    if (!animateComments() || quiet() && style !== 'bubblePop') return quietHide(all.length ? all : [el]);
    let chars = 0;
    for (const e2 of all) {
      const id2 = bindingKey(e2);
      gone.add(id2);
      chars += (items.get(id2) || {}).text?.length || 0;
    }
    const captured = all.map(e => session.adapter.comments.binding(e)).filter(Boolean);
    const targetBinding = session.adapter.comments.binding(el);
    const wasBlocked = !!DFY.lists.block[keyOf(a.acc.key)];
    const A = DFY.actors;
    DFY.ui.setBusy(true);
    if (style === 'bubblePop') {
      await session.wait(DFY.fx.bubblePop(el));
    } else {
      // 1. 鲸鱼娘走到这条评论的头像旁边
      DFY.ui.face('angry');
      fire(el);
      const p0 = avatarPoint(el);
      await session.wait(A.approachPoint(p0.x, p0.y));
      if (!targetBinding?.valid()) { DFY.ui.setBusy(false); return; }
      // 2. 大肥鱼从头像里冒出来：先被抓包，再嘴硬或求饶
      const p = avatarPoint(el);
      const fish = A.spawnFish(p.x, p.y - 4, { mood: 'caught' });
      A.alert(fish, '!?');
      A.say(fish, DFY.say('fishCaught'), 1400);
      DFY.sfx.bloop();
      await session.sleep(1150);
      A.react(fish);
      await session.sleep(1300);
      // 3. 抄家伙（巴掌 / 白饭加特林 / 扫帚 / 臭袜子 / 白饭投掷），被赶走的一律往左边走
      let gone1 = null;
      await DFY.weapons.run(DFY.weapons.pick(), fish, {
        onHit() {
          if (!session.active() || !targetBinding?.valid()) return;
          gone1 = DFY.fx.snapDust(el, { dur: 700 });
          for (const b of captured) if (b.valid() && b.el !== el) DFY.fx.collapse(b.el, 300);
        },
      });
      await session.wait(gone1);
      DFY.ui.face('happy', 1500);
      await session.wait(A.goHome());
    }
    DFY.ui.setBusy(false);
    await session.wait(addBlock(a));
    await session.wait(DFY.recordKick(all.length || 1, chars, session.platform));
    const undo = { label: '放回来', run: () => restore(captured, a, wasBlocked, chars) };
    if (all.length > 1) DFY.ui.toast({ icon: 'bowl', t1: 'CHAIN · 连坐处理', t2: `@${a.acc.name} 的 ${all.length} 条评论`, t3: '已一并赶回家吃白饭', ms: 5200, action: undo });
    else DFY.ui.toast({ icon: 'bowl', t1: 'SENT HOME · 已遣返', t2: `@${a.acc.name}`, t3: '以后它的评论会自动折叠', ms: 4200, action: undo });
    C.render();
  };

  /** 撤销单条赶走：评论放回来、移出遣返名单、战绩扣回去 */
  async function restore(els, a, wasBlocked, chars) {
    if (!session.active()) return;
    spared.add(a.acc.key);
    for (const b of els) {
      const id = b.key;
      gone.delete(id);
      peeked.add(id);
      if (b.valid()) { b.restoreStyle('display'); delete b.el.dataset.dfyGone; }
    }
    if (!wasBlocked) {
      await session.wait(DFY.store.patch('blocklist', (b) => {
        delete b[keyOf(a.acc.key)];
      }));
      delete DFY.lists.block[keyOf(a.acc.key)];
    }
    await session.wait(DFY.recordKick(-els.length, -chars, session.platform));
    DFY.ui.say(DFY.say('undo'), { face: 'smug' });
    C.rejudgeAll();
  }

  DFY.onCannonComment = function (el, isFish) {
    const a = accOfEl(el);
    if (isFish && a) return C.kick(el, a, 'bubblePop');
    const id = bindingKey(el);
    if (id) gone.add(id);
    return DFY.fx.bubblePop(el);
  };

  C.markHuman = async function (a) {
    if (!a?.acc.id) return;
    await session.wait(DFY.store.listAction(a.acc.key, { n: a.acc.name, t: Date.now(), source: 'manual' }, 'white'));
    DFY.lists.white[keyOf(a.acc.key)] = { n: a.acc.name };
    delete DFY.lists.block[keyOf(a.acc.key)];
    judge(a);
    DFY.ui.tip(false);
    DFY.ui.say(DFY.say('whitelist'), { face: 'cry', ms: 2200 });
    C.render();
  };

  /** 一键响指清场 */
  let snapping = false;
  C.snap = async function (opt = {}) {
    if (opt.auto && !canAutomate()) return;
    if (snapping) return;
    const targets = [];
    eachRenderer((el) => {
      const id = bindingKey(el);
      if (!id || gone.has(id)) return;
      if (el.style.display === 'none' && !el.dataset.dfyFolded) return;
      if (!DFY.isFishEl(el)) return;
      const a = accOfEl(el);
      if (a && spared.has(a.acc.key)) return;
      targets.push(el);
    });
    if (!targets.length) {
      if (!opt.auto) DFY.ui.say(DFY.say('snapNone'), { face: 'smug' });
      return;
    }
    if (quiet() || !animateComments()) {
      for (const el of targets) {
        if (!el.dataset.dfyFolded) continue;
        const ph = el.previousElementSibling;
        if (ph && ph.classList && ph.classList.contains('dfy-fold')) ph.remove();
        delete el.dataset.dfyFolded;
      }
      return quietHide(targets, opt.auto ? 'auto' : 'manual');
    }
    const targetBindings = new Map(targets.map(el => [el, session.adapter.comments.binding(el)]));
    snapping = true;
    const A = DFY.actors;
    const html = document.documentElement;
    const anchor = html.style.overflowAnchor;
    html.style.overflowAnchor = 'none'; // 评论一条条收起时页面不要乱跳
    const releaseAnchor = session.cleanup(() => { if (html.style.overflowAnchor === 'none') html.style.overflowAnchor = anchor; });
    DFY.ui.setBusy(true);
    DFY.ui.menu(false);
    // 1. 鲸鱼娘走到评论区上方正中
    const bc = session.adapter.comments.host?.();
    const br = bc ? bc.getBoundingClientRect() : { left: innerWidth / 3, width: innerWidth / 3 };
    DFY.ui.say(opt.auto ? '进门先清场，本鲸来了！' : DFY.say('snapStart'), { face: 'smug', ms: 2200 });
    await session.wait(A.walkTo(br.left + br.width / 2 - DFY.ui.size().w / 2, 70));
    // 2. 视野里的每条大肥鱼都冒出来，吓得发抖
    const visible = targets.filter((el) => targetBindings.get(el)?.valid() && DFY.fx.inView(el)).slice(0, 10);
    const fishes = [];
    for (const el of visible) {
      fire(el);
      const p = avatarPoint(el);
      const f = A.spawnFish(p.x, p.y - 4, { mood: 'scared', size: 78 });
      fishes.push(f);
      if (Math.random() < 0.5) A.alert(f, '!');
      DFY.sfx.bloop();
      await session.sleep(140);
    }
    fishes.forEach((f, i) => i % 3 === 0 && A.say(f, i === 0 ? '是、是灭霸鲸鱼娘！' : DFY.say('fishPlead'), 2600));
    await session.sleep(800);
    // 有几只扑通跪下求饶
    fishes.forEach((f, i) => {
      if (i % 3 !== 1) return;
      A.mood(f, 'beg');
      A.say(f, DFY.say('fishPlead'), 1800);
    });
    await session.sleep(1000);
    // 3. 响指（或者换成加特林挨个点射）
    let n = 0, chars = 0;
    const mids = new Set(), cleared = [], anims = [];
    const w = DFY.settings.weapon;
    const sweep = fishes.length > 0 && DFY.ui.mascotEl.style.display !== 'none' && (w === 'gatling' || (w === 'random' && Math.random() < 0.4));
    if (sweep) {
      DFY.ui.say(DFY.say('wSweep'), { face: 'angry', ms: 2200 });
      await session.sleep(500);
      await DFY.weapons.sweep(fishes, (i) => {
        if (!session.active()) return;
        anims.push(A.knock(fishes[i]));
        if (targetBindings.get(visible[i])?.valid()) anims.push(DFY.fx.snapDust(visible[i], { dur: 900 }));
      });
      session.assert();
      DFY.fx.shake(6);
    } else {
      DFY.ui.pose('snap');
      await session.sleep(300);
      DFY.sfx.snap();
      DFY.fx.flash('rgba(200,220,255,.85)', 450);
      DFY.fx.shake(8);
      await session.sleep(250);
    }
    for (const el of targets) {
      if (!targetBindings.get(el)?.valid()) continue;
      const id = targetBindings.get(el).key;
      if (gone.has(id)) continue;
      gone.add(id);
      const it = items.get(id);
      chars += (it && it.text.length) || 0;
      if (it) mids.add(it.accountKey);
      cleared.push(targetBindings.get(el));
      n++;
      DFY.ui.combo(n, sweep ? '条大肥鱼吃了一梭子白饭' : '条大肥鱼化成了泡沫');
      if (el.dataset.dfyFolded) {
        const ph = el.previousElementSibling;
        if (ph && ph.classList && ph.classList.contains('dfy-fold')) ph.remove();
        delete el.dataset.dfyFolded;
      }
      const vi = visible.indexOf(el);
      if (vi >= 0 && sweep) {
        await session.sleep(60);
      } else if (vi >= 0) {
        const f = fishes[vi];
        // 大多数化灰，少数抱着白饭碗逃跑
        anims.push(vi % 3 === 2 ? A.flee(f) : A.dust(f));
        anims.push(DFY.fx.snapDust(el, { dur: 1400 }));
        DFY.sfx.bloop();
        await session.sleep(280);
      } else {
        anims.push(DFY.fx.collapse(el, 0));
        await session.sleep(40);
      }
    }
    await session.wait(Promise.all(anims));
    const added = [];
    for (const mid of mids) {
      const a = accounts.get(mid);
      if (a && !DFY.lists.block[keyOf(mid)]) added.push(mid);
      if (a) await session.wait(addBlock(a, opt.auto ? 'auto' : 'manual'));
    }
    DFY.ui.pose('cheer', 2200);
    DFY.ui.face('happy', 2400);
    DFY.sfx.ding();
    DFY.fx.emit('confetti', innerWidth / 2, innerHeight * 0.3, 70);
    await session.wait(DFY.recordKick(n, chars, session.platform));
    await session.wait(DFY.bump('snaps'));
    DFY.ui.say(DFY.say('snapEnd'), { face: 'happy', ms: 3200 });
    html.style.overflowAnchor = anchor;
    releaseAnchor();
    report.show({ n, chars, accounts: mids.size, cleared, added, auto: !!opt.auto });
    await session.sleep(900);
    A.goHome();
    DFY.ui.setBusy(false);
    snapping = false;
    C.render();
  };

  /* ---------------- 清场战报：直接嵌在评论区上方，不弹窗 ---------------- */
  report = {
    el: null,
    data: null,
    show(d) {
      this.data = d;
      this.render(true);
    },
    add(n, chars) {
      if (!this.data) this.data = { n: 0, chars: 0, accounts: 0, cleared: [], added: [], auto: true };
      this.data.n += n;
      this.data.chars += chars;
      this.render(false);
    },
    render(fresh) {
      const bc = session.adapter.comments.host?.();
      if (!bc || !this.data) return;
      if (!this.el || !this.el.isConnected) {
        this.el = document.createElement('dfy-report');
        this.el.attachShadow({ mode: 'open' });
        bc.before(this.el);
      }
      const d = this.data;
      const tokens = Math.round(d.chars * 1.3);
      const auto = DFY.settings.mode === 'auto';
      this.el.shadowRoot.innerHTML = `<style>
:host{display:block;margin:10px 0 16px}
.r{position:relative;display:flex;align-items:center;gap:14px;padding:10px 16px 10px 8px;background:#f5eadd;border:2.5px solid #151a3d;border-radius:14px;box-shadow:4px 4px 0 #151a3d;font:13px/1.5 "PingFang SC","Microsoft YaHei",sans-serif;color:#151a3d;overflow:hidden}
.r:before{content:"";position:absolute;right:-30px;top:-30px;width:140px;height:140px;background:radial-gradient(#2f6fe0 1.5px,transparent 1.7px) 0 0/9px 9px;opacity:.2;border-radius:50%}
.w{width:70px;height:80px;flex:none;margin:-4px 0 -10px}
.tape{position:absolute;left:-26px;top:9px;transform:rotate(-28deg);background:#151a3d;color:#fffaf2;font:900 8.5px/1 sans-serif;letter-spacing:2px;padding:4px 30px}
h3{margin:0;font:400 22px "DFY Display","PingFang SC",sans-serif;letter-spacing:2px}
.s{display:flex;gap:16px;margin-top:2px;color:#5b5446}
.s b{font:400 20px "DFY Display",sans-serif;color:#2546b8;margin-right:3px}
.btns{margin-left:auto;display:flex;flex-direction:column;gap:6px;align-items:stretch;position:relative}
button{all:unset;cursor:pointer;text-align:center;font:400 14px "DFY Display","PingFang SC",sans-serif;letter-spacing:1px;padding:3px 12px;border:2px solid #151a3d;border-radius:8px;background:#fffaf2;box-shadow:2px 2px 0 #151a3d}
button.p{background:#2546b8;color:#fff}
button.on{background:#6fe0ff}
button:active{transform:translate(1px,1px);box-shadow:none}
${DFY.mascotCSS}
</style>
<div class="r">
  <div class="tape">${d.auto ? 'AUTO CLEAR' : 'MISSION CLEAR'}</div>
  <div class="w">${DFY.mascotSVG({ face: 'happy', pose: 'cheer' })}</div>
  <div>
    <h3>${d.auto ? '进门清场完毕' : '清场完毕'}！</h3>
    <div class="s"><span><b>${d.n}</b>条大肥鱼回家吃白饭</span><span><b>${tokens.toLocaleString()}</b>个 AI Token 不用看了</span></div>
  </div>
  <div class="btns">
    <button class="${auto ? 'on' : 'p'}" data-a="auto">${auto ? '已开启：进页面自动清场' : '以后进页面自动清场'}</button>
    <div style="display:flex;gap:6px"><button data-a="copy" style="flex:1">复制战绩</button><button data-a="undo" style="flex:1">全部放回</button></div>
  </div>
</div>`;
      const root = this.el.shadowRoot;
      root.querySelector('[data-a=copy]').onclick = () => {
        const t = `【大肥鱼消除计划】我在 ${DFY.platform.name}评论区打了个响指，${d.n} 条大肥鱼评论灰飞烟灭，省下 ${tokens} 个 Token！`;
        navigator.clipboard && navigator.clipboard.writeText(t).then(() => DFY.ui.say('战绩已复制，快去炫耀吧~', { face: 'happy' }));
      };
      root.querySelector('[data-a=auto]').onclick = async () => {
        const next = DFY.settings.mode === 'auto' ? 'mark' : 'auto';
        await DFY.store.patch('settings', (st) => {
          st.mode = next;
        });
        DFY.settings.mode = next;
        DFY.ui.say(next === 'auto' ? '好！以后一进页面本鲸就先清场' : '好的，以后先等你下令', { face: next === 'auto' ? 'smug' : 'happy' });
        this.render(false);
      };
      root.querySelector('[data-a=undo]').onclick = async () => {
        if (!session.active()) return;
        for (const b of d.cleared) {
          gone.delete(b.key);
          const it = items.get(b.key);
          if (it) spared.add(it.accountKey);
          if (b.valid()) { b.restoreStyle('display'); delete b.el.dataset.dfyGone; }
        }
        if (d.added.length)
          await DFY.store.patch('blocklist', (b) => {
            for (const mid of d.added) delete b[keyOf(mid)];
          });
        for (const mid of d.added) delete DFY.lists.block[keyOf(mid)];
        if (DFY.settings.mode === 'auto') {
          await DFY.store.patch('settings', (st) => {
            st.mode = 'mark';
          });
          DFY.settings.mode = 'mark';
        }
        this.el.remove();
        this.data = null;
        DFY.ui.say('都放回来了，这次先饶了它们', { face: 'cry' });
        C.rejudgeAll();
      };
      if (fresh) {
        this.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        this.el.animate([{ transform: 'translateY(-14px) scale(.96)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.3,1.5,.5,1)' });
      }
    },
  };

  C.rescan = function () {
    session.adapter.rescan?.();
    const th = DFY.ui.think(DFY.say('thinking'));
    const t0 = performance.now();
    session.later(() => {
      C.rejudgeAll();
      const n = C.fishCount || 0;
      th.done(((performance.now() - t0) / 1000).toFixed(1), 1800);
      const message = C.stats().unassessed || C.stats().unknown ? '已加载评论，部分账号证据不足，可手动隐藏' : n ? DFY.say('found', { n }) : DFY.say('clean');
      session.later(() => DFY.ui.say(message, { face: n ? 'angry' : 'happy', ms: 3000 }), 1900);
    }, 900);
  };

  /* ---------------- DeepSeek 精判 ---------------- */
  let llmTimer = 0;
  const llmDone = new Set();
  function queueLLM() {
    const s = DFY.settings;
    const strategy = DFY.detection.get(session.platform);
    if (!strategy?.llm) return;
    if (!s.llmEnabled || !s.llmKey || !s.llmAuto || !DFY.canLLM) return;
    clearTimeout(llmTimer);
    llmTimer = session.later(() => {
      const policy = policyOf();
      const list = [...accounts.values()].filter((a) => a.verdict && !a.llm && !llmDone.has(a.acc.key) && !DFY.lists.white[keyOf(a.acc.key)] && !DFY.lists.block[keyOf(a.acc.key)] && a.verdict.offline >= policy.llmMin && a.verdict.offline < policy.llmMax);
      if (list.length) C.llmJudge(list.slice(0, policy.batchSize), false);
    }, policyOf().delay);
  }

  C.llmJudge = async function (list, manual) {
    if (!DFY.detection.get(session.platform)?.llm) return;
    const requestSession = session;
    const s = DFY.settings;
    if (!s.llmEnabled || !s.llmKey || !DFY.canLLM) {
      DFY.ui.say(DFY.say('noKey'), { face: 'cry', ms: 3200 });
      return;
    }
    list = list.filter(a => a?.acc.id && a.verdict?.status === 'assessed' && !DFY.lists.white[a.acc.key] && !DFY.lists.block[a.acc.key]);
    if (!list.length) {
      DFY.ui.say('本页没有需要精判的可疑账号~', { face: 'happy' });
      return;
    }
    for (const a of list) llmDone.add(a.acc.key);
    const th = DFY.ui.think(DFY.say('thinking'));
    const strategy = DFY.detection.get(session.platform);
    const cacheVersion = cacheVersionOf(strategy);
    const payload = list.map((a) => strategy.payload ? strategy.payload(a.acc, textsOf(a), { platform: session.platform, pageKey: session.pageKey, upMid }) : ({
      id: a.acc.key,
      name: a.acc.name,
      level: a.acc.features.level,
      sign: (a.acc.signature || '').slice(0, 80),
      platform: session.platform,
      page: session.pageKey,
      offline: a.verdict ? a.verdict.offline : null,
      hints: a.verdict ? a.verdict.reasons.slice(0, 4).map((r) => r.why) : [],
      comments: textsOf(a)
        .slice(0, 3)
        .map((i) => ({ text: i.text.slice(0, 220), isReply: !!i.isReply, rootId: i.rootId || null, parentId: i.parentId || null, mentions: i.mentions || [] })),
    }));
    const digests = new Map(list.map(a => [a.acc.key, a.digest]));
    const res = await DFY.callBg({ type: 'llm-judge', platform: session.platform, items: payload, model: s.llmModel });
    if (DFY.session !== requestSession || !requestSession?.active() || cacheVersionOf(strategy) !== cacheVersion || DFY.detection.get(session.platform) !== strategy || !DFY.settings.llmEnabled) { th.close(); return; }
    if (!res || !res.ok) {
      th.close();
      DFY.ui.say(DFY.say('llmBusy'), { face: 'cry', ms: 3500 });
      return;
    }
    th.update(res.reasoning || '嗯，让本鲸看看这些评论……');
    th.done((res.ms / 1000).toFixed(1), 3000);
    let flipped = 0;
    for (const r of res.results || []) {
      const a = accounts.get(String(r.id));
      if (!a || !digests.has(a.acc.key) || a.digest !== digests.get(a.acc.key) || a.cacheVersion !== cacheVersion || typeof r.ai !== 'number' || !Number.isFinite(r.ai) || DFY.lists.white[a.acc.key] || DFY.lists.block[a.acc.key]) continue;
      const before = a.verdict && a.verdict.level;
      a.llm = { ai: Math.max(0, Math.min(100, r.ai)), reason: String(r.reason || '').slice(0, 160) };
      DFY.memory.llmPut(a.acc.key, a.llm.ai, a.llm.reason, cacheVersion, a.digest);
      judge(a);
      if (before !== a.verdict.level) flipped++;
    }
    DFY.bump('llmCalls');
    C.render();
    session.later(() => DFY.ui.say(`DeepSeek 精判了 ${list.length} 个账号${flipped ? `，改判 ${flipped} 个` : ''}~`, { face: 'smug', ms: 2800 }), 3200);
  };

  C.llmPage = function () {
    const policy = policyOf();
    const list = [...accounts.values()].filter((a) => a.verdict?.status === 'assessed' && !DFY.lists.white[a.acc.key] && !DFY.lists.block[a.acc.key] && a.verdict.offline >= policy.manualLlmMin).sort((x, y) => y.verdict.offline - x.verdict.offline);
    return C.llmJudge(list.slice(0, policy.manualBatchSize), true);
  };

  C.hasComments = () => !!session.adapter.comments.host?.();
  C.stats = () => {
    let suspect = 0;
    for (const a of accounts.values()) if (a.verdict && a.verdict.level === 'suspect') suspect++;
    let unassessed = 0; for (const a of accounts.values()) if (a.verdict?.status === 'unassessed') unassessed++;
    let unknown = 0, candidates = 0, listed = 0;
    for (const a of accounts.values()) { if (a.verdict?.level === 'unknown') unknown++; if (a.verdict?.level === 'fish') a.verdict.status === 'manual' ? listed++ : candidates++; }
    return { unassessed, unknown, candidates, listed, detectionVersion: DFY.detection.get(session.platform)?.version || null, automaticHandling: canAutomate(), accounts: accounts.size, items: items.size, fish: C.fishCount || 0, suspect, kicked: gone.size, atHidden: atHidden.size, quiet: quiet() };
  };

  session.cleanup(() => {
    clearTimeout(autoTimer); clearTimeout(llmTimer);
    note.el?.remove(); report.el?.remove();
    DFY.ui.tip(false); DFY.ui.setBusy(false); DFY.actors.clear();
    DFY.ui.cannon(false);
    DFY.ui.mascotEl?.classList.remove('walking', 'face-left');
    if (DFY.ui.mascotEl) DFY.ui.mascotEl.style.transition = '';
    items.clear(); accounts.clear(); gone.clear(); peeked.clear(); spared.clear(); byName.clear(); atHidden.clear();
  });
  for (const name of ['kick','snap','markHuman','llmJudge']) {
    const run = C[name];
    C[name] = (...args) => {
      if(!session.active()) return Promise.resolve();
      return Promise.resolve(run(...args)).catch(error => { if(error.name!=='AbortError'){ console.warn('[DFY] Comment operation failed',error); DFY.ui.setBusy(false); DFY.ui.say('操作未完成，请重试',{face:'cry'}); } });
    };
  }
  return C;
  };
})();
