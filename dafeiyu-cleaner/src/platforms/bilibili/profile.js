/* 空间主页报告：使用 B 站证据策略；资料不足时保留未知。 */
(function () {
  const DFY = (globalThis.DFY = globalThis.DFY || {});
  DFY.bilibili.createProfile = function (session) {
  const S = {};
  const esc = (s) => DFY.esc(s);
  const keyOf = mid => DFY.model.accountKey(session.platform,String(mid));
  const sleep = ms => session.sleep(ms);
  const strategy = DFY.detection.get(session.platform);
  const judgeContext = () => ({ threshold: DFY.settings.threshold, platform: session.platform, pageKey: session.pageKey });

  S.midFromUrl = function (u) {
    try {
      const url = new URL(u || location.href);
      if (url.hostname !== 'space.bilibili.com') return '';
      const m = url.pathname.match(/\/(\d{2,})(?:\/|$)/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  };

  async function getJSON(url) {
    try {
      const r = await fetch(url, { credentials: 'include', signal: session.signal });
      session.assert();
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  function daysAgo(t) {
    const d = Math.floor((Date.now() - t) / 86400000);
    return d <= 0 ? '今天' : d === 1 ? '昨天' : `${d} 天前`;
  }

  function fmtNum(n) {
    n = +n || 0;
    return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
  }

  /** 拉取资料并做离线鉴定 */
  S.inspect = async function (mid) {
    const [card, arc] = await Promise.all([
      getJSON(`https://api.bilibili.com/x/web-interface/card?mid=${mid}&photo=false`),
      getJSON(`https://api.bilibili.com/x/series/recArchivesByKeywords?mid=${mid}&keywords=&ps=30&pn=1&orderby=pubdate`),
    ]);
    const c = card && card.code === 0 && card.data ? card.data.card : null;
    if (!c) return null;
    const prof = {
      mid,
      uname: c.name,
      avatar: c.face,
      sign: c.sign || '',
      level: c.level_info?.current_level,
      verify: c.official_verify ? c.official_verify.type : -1,
      verifyDesc: (c.official_verify && c.official_verify.desc) || '',
      fans: card.data.follower || c.fans || 0,
      archives: card.data.archive_count || 0,
      videos: ((arc && arc.code === 0 && arc.data && arc.data.archives) || []).map((v) => ({ title: v.title, t: v.pubdate || v.ctime })),
    };
    session.assert();
    const account = { platform: session.platform, id: String(mid), key: keyOf(mid), name: prof.uname, signature: prof.sign, features: { level: prof.level } };
    const offlineResult = strategy.judge(account, [], judgeContext());
    return { ...offlineResult, prof, offline: offlineResult.score, offlineResult, reasons: offlineResult.reasons.slice() };
  };

  /* ---------------- 页面上的效果：印章盖在名字旁、大肥鱼趴在头像上 ---------------- */
  const page = {
    layer: null,
    fish: null,
    els: [],
    ensure() {
      if (!document.getElementById('dfy-page-style')) {
        const st = document.createElement('style');
        st.id = 'dfy-page-style';
        st.textContent = `${DFY.actors.CSS}
${DFY.mascotCSS}
.dfy-p-zoom{transition:transform .45s cubic-bezier(.3,1.5,.5,1)!important;transform:scale(1.7)!important;z-index:20!important;position:relative}
.dfy-p-bubble{position:absolute;white-space:nowrap;background:#fffaf2;border:2.5px solid #151a3d;border-radius:14px;padding:6px 14px;font:700 15px "PingFang SC","Microsoft YaHei",sans-serif;color:#151a3d;box-shadow:3px 3px 0 rgba(21,26,61,.3);pointer-events:none;z-index:21}
.dfy-p-bubble:after{content:"";position:absolute;left:-9px;bottom:10px;width:14px;height:14px;background:#fffaf2;border-left:2.5px solid #151a3d;border-bottom:2.5px solid #151a3d;transform:rotate(45deg)}
@font-face{font-family:"DFY Display";src:url("${typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id ? chrome.runtime.getURL('assets/dfy-display.woff2') : ''}") format("woff2")}
#dfy-page-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:1000;pointer-events:none}
#dfy-page-layer .dfy-actor{position:absolute}
.dfy-p-stamp{position:absolute;white-space:nowrap;padding:2px 12px;border:4px double currentColor;border-radius:9px;font:400 26px "DFY Display","PingFang SC",sans-serif;letter-spacing:4px;transform:rotate(-10deg);background:rgba(255,255,255,.7);pointer-events:none}
.dfy-p-stamp.fish{color:#e0264f}.dfy-p-stamp.human{color:#139a63}.dfy-p-stamp.suspect{color:#d98200}
.dfy-p-tape{position:absolute;white-space:nowrap;background:repeating-linear-gradient(-45deg,#151a3d 0 10px,#2546b8 10px 20px);color:#fffaf2;font:400 15px "DFY Display","PingFang SC",sans-serif;letter-spacing:3px;padding:4px 18px;border:2px solid #fffaf2;box-shadow:3px 3px 0 rgba(21,26,61,.35);transform:rotate(-4deg);pointer-events:none}
.dfy-p-gray{filter:grayscale(1) brightness(.85);transition:filter .6s}`;
        document.head.appendChild(st);
      }
      if (!this.layer || !this.layer.isConnected) {
        this.layer = document.createElement('div');
        this.layer.id = 'dfy-page-layer';
        document.body.appendChild(this.layer);
      }
    },
    avatar: () => document.querySelector('.upinfo-avatar .b-avatar, .upinfo-avatar img, .upinfo-avatar'),
    nick: () => document.querySelector('.upinfo .nickname, .nickname'),
    abs(el) {
      const r = el.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, r };
    },
    clear() {
      for (const e of this.els) e.remove();
      this.els = [];
      if (this.fish) this.fish.remove();
      this.fish = null;
      const av = this.avatar();
      av && av.classList.remove('dfy-p-gray');
      document.querySelectorAll('.dfy-p-zoom').forEach((e) => e.classList.remove('dfy-p-zoom'));
    },
    put(cls, html, x, y) {
      const d = document.createElement('div');
      d.className = cls;
      d.innerHTML = html;
      Object.assign(d.style, { left: x + 'px', top: y + 'px' });
      this.layer.appendChild(d);
      this.els.push(d);
      return d;
    },
    async apply(r, opt = {}) {
      const av = this.avatar(), nk = this.nick();
      if (!av || !nk) return;
      this.ensure();
      this.clear();
      const lv = levelInfo(r).lv;
      const blocked = !DFY.lists.white[keyOf(r.prof.mid)] && DFY.lists.block[keyOf(r.prof.mid)];
      const a = this.abs(av), n = this.abs(nk);
      const stamp = this.put(`dfy-p-stamp ${blocked ? 'fish' : lv}`, blocked ? '已隐藏' : levelInfo(r).stamp, n.x + Math.min(n.w, 300) + 18, n.y - 8);
      if (blocked) return this.sentHome(r, false);
      if (opt.slam !== false) {
        stamp.animate([{ transform: 'rotate(-10deg) scale(3.4)', opacity: 0 }, { opacity: 1, offset: 0.6 }, { transform: 'rotate(-10deg) scale(1)', opacity: 1 }], { duration: 450, easing: 'cubic-bezier(.2,1.6,.4,1)' });
        await sleep(400);
        const hd = document.querySelector('.header-upinfo, .upinfo');
        hd && hd.animate([0, 1, 2, 3, 4, 5].map((i) => ({ transform: i === 5 ? 'none' : `translate(${(Math.random() - 0.5) * 10}px,${(Math.random() - 0.5) * 6}px)` })), { duration: 320 });
        // 投稿卡片被震得跳一下
        [...document.querySelectorAll('.bili-video-card, .items__item')].slice(0, 12).forEach((c, i) =>
          c.animate([{ transform: 'none' }, { transform: `translateY(-10px) rotate(${i % 2 ? 2 : -2}deg)` }, { transform: 'none' }], { duration: 380, delay: i * 45, easing: 'ease-out' })
        );
        this.speak(lv === 'fish' ? '发现自动运营自述，仍需核实' : lv === 'human' ? '已按你的选择保留账号' : '现有资料不足以确认自动运营', 4200);
      }
    },
    /** 头像临时放大，旁边冒一个对话气泡；说完过几秒再恢复 */
    speak(text, ms = 4200) {
      const av = document.querySelector('.upinfo-avatar') || this.avatar();
      if (!av) return;
      av.classList.add('dfy-p-zoom');
      const r = this.abs(av);
      const b = this.put('dfy-p-bubble', DFY.esc(text), r.x + r.w * 1.45 + 10, r.y - r.h * 0.55);
      b.animate([{ transform: 'scale(.3)', transformOrigin: 'left bottom', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'none' }], { duration: 360, easing: 'ease-out' });
      clearTimeout(this._speakT);
      this._speakT = session.later(() => {
        b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 }).onfinish = () => b.remove();
        session.later(() => av.classList.remove('dfy-p-zoom'), 1500);
      }, ms);
    },
    /** 头像变灰 + 贴上「已遣返」胶带，旁边坐着一只在家吃白饭的大肥鱼 */
    sentHome(r, animate = true) {
      const av = this.avatar(), nk = this.nick();
      if (!av || !nk) return;
      av.classList.add('dfy-p-gray');
      const a = this.abs(av);
      const t = this.put('dfy-p-tape', '已遣返 · 回家吃白饭中', a.x - 20, a.y + a.h - 10);
      if (animate) t.animate([{ transform: 'rotate(-4deg) scaleX(0)', transformOrigin: 'left' }, { transform: 'rotate(-4deg) scaleX(1)', transformOrigin: 'left' }], { duration: 380, easing: 'ease-out' });
      if (DFY.actors.src('home')) {
        const size = Math.max(64, Math.min(96, a.h * 1.1));
        const home = DFY.actors.spawnFish(a.x - size * 0.4, a.y + a.h * 0.35, { mood: 'home', size, parent: this.layer, position: 'absolute' });
        home.title = '在家吃白饭中';
        this.els.push(home);
        if (!animate) home.getAnimations().forEach((x) => x.finish());
      }
    },
    /** 鲸鱼娘走到头像右边，把躲在头像里的大肥鱼赶回家 */
    async kick(r) {
      const av = this.avatar();
      const A = DFY.actors;
      if (!av) return;
      this.ensure();
      clearTimeout(this._speakT);
      document.querySelectorAll('.dfy-p-bubble').forEach((e) => e.remove());
      document.querySelectorAll('.dfy-p-zoom').forEach((e) => e.classList.remove('dfy-p-zoom'));
      av.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(350);
      DFY.ui.face('angry');
      const ar0 = av.getBoundingClientRect();
      await session.wait(A.approachPoint(ar0.right, ar0.top + ar0.height / 2));
      const ar = av.getBoundingClientRect();
      const fx = A.spawnFish(ar.left + ar.width / 2, ar.top + ar.height / 2 + 6, { mood: 'caught', size: 92 });
      A.alert(fx, '!?');
      A.say(fx, DFY.say('fishCaught'), 1400);
      DFY.sfx.bloop();
      await sleep(1150);
      A.react(fx);
      await sleep(1300);
      await DFY.weapons.run(DFY.weapons.pick(), fx, {
        onHit: () => {
          if (!session.active()) return;
          for (const e of this.els) if (e.classList.contains('dfy-p-stamp')) e.textContent = '已遣返';
          this.sentHome(r, true);
        },
      });
      session.assert();
      DFY.ui.face('happy', 1600);
      await A.goHome();
    },
  };
  S.page = page;

  /* ---------------- 报告卡片 ---------------- */
  let card = null, pill = null, current = null, running = false;
  let llmEpoch = 0, llmSettings = [];
  function syncLLMSettings() {
    const next = [...['llmEnabled', 'llmModel', 'llmVision', 'llmKey'].map(key => DFY.settings[key]), strategy.version, strategy.llmPromptVersion];
    if (next.some((value, index) => value !== llmSettings[index])) {
      llmSettings = next;
      llmEpoch++;
      if (current) { delete current.llm; current.llmPending = null; }
    }
    return llmEpoch;
  }
  function reviewFor(r) {
    syncLLMSettings();
    return DFY.settings.llmEnabled && r.llm?.epoch === llmEpoch ? r.llm : null;
  }

  function levelInfo(r) {
    const white = DFY.lists.white[keyOf(r.prof.mid)], blocked = !white && DFY.lists.block[keyOf(r.prof.mid)];
    const lv = white ? 'human' : blocked ? 'fish' : strategy.classify(r.score, r.offlineResult, judgeContext());
    return {
      lv,
      title: white ? '本地保留名单' : blocked ? '本地隐藏名单' : lv === 'fish' ? '疑似自动账号 · 自述待核实' : lv === 'suspect' ? '待核实' : '证据不足',
      stamp: white ? '保留账号' : blocked ? '已隐藏' : lv === 'fish' ? '疑似自动账号' : lv === 'suspect' ? '待核实' : '证据不足',
    };
  }

  function render(r, state = {}) {
    const p = r.prof;
    const info = levelInfo(r);
    const white = DFY.lists.white[keyOf(p.mid)];
    const blocked = !white && DFY.lists.block[keyOf(p.mid)];
    const ev = r.reasons
      .slice(0, 8)
      .map((x) => `<li><span>${esc(x.why)}</span><b class="${x.w < 0 ? 'neg' : ''}">${x.w ? (x.w > 0 ? '+' : '') + x.w : ''}</b></li>`)
      .join('');
    const canLLM = !white && !blocked && DFY.settings.llmEnabled && DFY.settings.llmKey && DFY.canLLM;
    const review = reviewFor(r);
    const llm = review
      ? `<div class="llm"><div class="t">${DFY.icon('brain', 14)}DeepSeek 复核意见（非身份认证）</div>${esc(review.reason)}</div>`
      : state.llmLoading
        ? `<div class="llm"><div class="t">${DFY.icon('brain', 14)}DeepSeek 正在深度思考……</div>咕噜咕噜，本鲸在翻 TA 的老底</div>`
        : '';
    const btns = [];
    if (blocked) btns.push('<button class="btn ghost" data-a="unblock">' + DFY.icon('undo') + '放它回来</button>');
    else if (info.lv !== 'human' || state.forceKick) btns.push('<button class="btn danger" data-a="block">' + DFY.icon('bowl') + '赶回家吃白饭</button>');
    if (canLLM && !review && !state.llmLoading) btns.push('<button class="btn primary" data-a="llm">' + DFY.icon('brain') + 'DeepSeek 精判</button>');
    if (!canLLM && !white && !blocked) btns.push('<button class="btn ghost" data-a="cfg">' + DFY.icon('brain') + '配置精判</button>');
    if (!white) btns.push('<button class="btn ghost" data-a="white">' + DFY.icon('check') + '保留账号</button>');
    if (white && !blocked) btns.push('<button class="btn ghost" data-a="block">' + DFY.icon('hide') + '手动隐藏</button>');
    return `
<div class="top"><div><b>${DFY.icon('search', 18, 2.4)}大肥鱼鉴定报告</b><small>CASE FILE No.${esc(p.mid)} · ${info.title}</small></div><div style="display:flex;gap:6px"><button data-a="min" title="收起">${DFY.icon('minus', 14, 2.6)}</button><button data-a="close" title="关闭">${DFY.icon('close', 14, 2.6)}</button></div></div>
<div class="body">
  ${blocked ? `<div class="notice">${DFY.icon('bowl', 16)}${daysAgo(blocked.t)}被你赶回家吃白饭了，TA 的评论会自动折叠</div>` : ''}
  <div class="who"><div class="polaroid"><img class="ava" src="${esc((p.avatar || '').replace(/^http:/, 'https:'))}@132w_132h.webp" referrerpolicy="no-referrer"></div><div><div class="name">${esc(p.uname)}</div><div class="meta">Lv${p.level} · ${fmtNum(p.fans)} 粉丝 · 投稿 ${p.archives}</div><div class="meta" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.sign || '这个人很懒，什么都没写')}</div><div class="stamp ${blocked ? 'fish' : info.lv} ${state.slam ? 'slam' : ''}">${blocked ? '已遣返' : info.stamp}</div></div></div>
  ${white || blocked ? '<div class="meta">本地名单是你的选择，不代表 AI 身份判定</div>' : `<div class="gauge"><i style="width:${state.slam ? 0 : r.score}%"></i><span>线索分 ${r.score} / 99（非概率）</span></div>`}
  <ul class="ev">${ev || '<li><span>现有资料不足以判断账号是否自动运营</span></li>'}</ul>
  ${llm}
  <div class="btns">${btns.join('')}</div>
</div>`;
  }

  function mountCard(r, state) {
    if (!card) {
      card = document.createElement('div');
      card.className = 'verdict';
      DFY.ui.root.querySelector('.wrap').appendChild(card);
      card.addEventListener('click', e => onClick(e).catch(error => { if(error.name !== 'AbortError') console.warn('[DFY] Profile operation failed',error); }));
    }
    card.className = 'verdict ' + levelInfo(r).lv;
    card.innerHTML = render(r, state);
    if (state && state.slam) {
      const targetCard = card;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (session.active() && targetCard === card) { const gauge = card.querySelector('.gauge i'); if (gauge) gauge.style.width = r.score + '%'; }
      }));
    }
  }

  function showPill(r) {
    if (!pill) {
      pill = document.createElement('button');
      pill.className = 'btn primary pill';
      DFY.ui.root.querySelector('.wrap').appendChild(pill);
      pill.onclick = () => {
        pill.style.display = 'none';
        card.style.display = '';
      };
    }
    const info = levelInfo(r);
    pill.innerHTML = `${DFY.icon('search', 16, 2.4)}${info.stamp}`;
    pill.style.display = '';
  }

  async function onClick(e) {
    const a = e.target.closest('[data-a]');
    if (!a || !current) return;
    const act = a.dataset.a;
    const p = current.prof;
    if (act === 'close') {
      card.style.display = 'none';
      showPill(current);
    } else if (act === 'min') {
      card.style.display = 'none';
      showPill(current);
    } else if (act === 'block') {
      await session.wait(DFY.store.listAction(keyOf(p.mid), { n:p.uname, a:p.avatar, t:Date.now(), s:current.score, source:'manual' }, 'block'));
      DFY.lists.block[keyOf(p.mid)] = { t: Date.now() };
      delete DFY.lists.white[keyOf(p.mid)];
      await session.wait(DFY.recordKick(1, 0, session.platform));
      mountCard(current, {});
      await session.wait(page.kick(current));
      DFY.ui.toast({ icon: 'bowl', t1: 'BLOCKLIST · 已加入遣返名单', t2: `@${p.uname}`, t3: 'TA 的评论以后会被自动装进白饭碗' });
    } else if (act === 'unblock') {
      await session.wait(DFY.store.patch('blocklist', (b) => {
        delete b[keyOf(p.mid)];
      }));
      delete DFY.lists.block[keyOf(p.mid)];
      DFY.ui.say('好吧，放你回来，下次别再刷屏了', { face: 'smug' });
      mountCard(current, {});
      applyPage(current, { slam: false });
    } else if (act === 'white') {
      await session.wait(DFY.store.listAction(keyOf(p.mid), { n:p.uname, t:Date.now(), source:'manual' }, 'white'));
      DFY.lists.white[keyOf(p.mid)] = { n: p.uname };
      delete DFY.lists.block[keyOf(p.mid)];
      DFY.ui.say(DFY.say('whitelist'), { face: 'cry' });
      mountCard(current, { slam: true });
      applyPage(current);
    } else if (act === 'llm') {
      S.llm(current);
    } else if (act === 'cfg') {
      DFY.callBg({ type: 'open-options' });
    }
  }

  S.llm = async function (r) {
    const epoch = syncLLMSettings();
    if (r !== current || r.llmPending || DFY.lists.white[keyOf(r.prof.mid)] || DFY.lists.block[keyOf(r.prof.mid)] || !DFY.settings.llmEnabled || !DFY.settings.llmKey || !DFY.canLLM) return;
    const request = {};
    r.llmPending = request;
    const requestModel = DFY.settings.llmModel, requestVision = DFY.settings.llmVision;
    mountCard(r, { llmLoading: true });
    const th = DFY.ui.think(`嗯，用户想知道「${r.prof.uname}」是不是大肥鱼，我先看看 TA 的签名和投稿……`);
    let res;
    try { res = await DFY.callBg({
      type: 'llm-space',
      platform: session.platform,
      model: requestModel,
      vision: requestVision,
      profile: {
        name: r.prof.uname,
        level: r.prof.level,
        sign: r.prof.sign,
        fans: r.prof.fans,
        archives: r.prof.archives,
        verify: r.prof.verifyDesc,
        recentTitles: r.prof.videos.slice(0, 12).map((v) => v.title),
        avatar: r.prof.avatar,
      },
    }); } catch (error) { th.close(); throw error; }
    finally { if (r.llmPending === request) r.llmPending = null; }
    syncLLMSettings();
    if (!session.active()) { th.close(); return; }
    session.assert();
    if (r !== current || epoch !== llmEpoch || !DFY.settings.llmEnabled || requestModel !== DFY.settings.llmModel || requestVision !== DFY.settings.llmVision || DFY.lists.white[keyOf(r.prof.mid)] || DFY.lists.block[keyOf(r.prof.mid)]) {
      th.close();
      if (r === current) mountCard(r, { llmLoading: !!r.llmPending });
      return;
    }
    if (!res?.ok || typeof res.result?.ai !== 'number' || !Number.isFinite(res.result.ai)) {
      th.close();
      DFY.ui.say(DFY.say('llmBusy'), { face: 'cry', ms: 3500 });
      mountCard(r, {});
      return;
    }
    th.update(res.reasoning || '嗯……');
    th.done((res.ms / 1000).toFixed(1), 3200);
    const j = res.result || {};
    r.llm = { epoch, model: requestModel, vision: requestVision, strategyVersion: strategy.version, ai: Math.max(0, Math.min(100, j.ai)), reason: typeof j.reason === 'string' ? j.reason.slice(0, 240) : '模型未提供证据说明' };
    const old = levelInfo(r).lv;
    r.score = strategy.combine(r.offlineResult, r.llm, judgeContext()).score;
    DFY.bump('llmCalls');
    await sleep(600);
    syncLLMSettings();
    if (r !== current || epoch !== llmEpoch) return;
    mountCard(r, { slam: old !== levelInfo(r).lv });
    if (old !== levelInfo(r).lv) {
      slamFx(r);
      applyPage(r);
    }
  };

  function slamFx(r) {
    const lv = levelInfo(r).lv;
    session.later(() => {
      DFY.sfx.boom();
      DFY.fx.shake(10);
      const st = card && card.querySelector('.stamp');
      if (st) {
        const b = st.getBoundingClientRect();
        DFY.fx.emit(lv === 'human' ? 'confetti' : 'star', b.left + b.width / 2, b.top + b.height / 2, lv === 'human' ? 40 : 18);
      }
      DFY.ui.say(lv === 'fish' ? '发现自动运营线索，仍需核实' : lv === 'human' ? '已按你的选择保留账号' : '现有资料不足以确认自动运营', { face: 'normal', ms: 3200 });
    }, 120);
  }

  S.run = async function (force) {
    const mid = S.midFromUrl();
    if (!mid || running) return;
    if (!force && current && current.prof.mid === mid) return;
    running = true;
    current = null;
    try {
      if (card) {
        card.remove();
        card = null;
      }
      page.clear();
      if (pill) pill.style.display = 'none';
      const th = DFY.ui.think('嗯，用户打开了一个空间主页，我需要鉴定一下这位是不是大肥鱼……');
      const t0 = performance.now();
      const r = await S.inspect(mid);
      session.assert();
      if (!r) {
        th.close();
        running = false;
        return;
      }
      th.update(`已读取「${r.prof.uname}」的公开资料。${r.reasons.slice(0, 3).map((x) => x.why).join('，') || '未发现足够的自动运营证据'}。昵称、等级和投稿频率不用于确认账号身份。`);
      th.done(((performance.now() - t0) / 1000 + 0.6).toFixed(1), 2200);
      await sleep(900);
      current = r;
      mountCard(r, { slam: true });
      slamFx(r);
      applyPage(r);
      DFY.bump('verdicts');
      if (DFY.lists.block[keyOf(mid)]) session.later(() => DFY.ui.say(DFY.say('spaceBlocked'), { face: 'smug' }), 3400);
      const s = DFY.settings;
      const policy = strategy.getPolicy(judgeContext());
      if (s.llmEnabled && s.llmKey && s.llmAuto && DFY.canLLM && r.score >= policy.llmMin && r.score < policy.llmMax && !DFY.lists.white[keyOf(mid)] && !DFY.lists.block[keyOf(mid)]) session.later(() => S.llm(r), 2600);
    } finally {
      running = false;
    }
  };

  S.show = function () {
    if (card) {
      card.style.display = '';
      if (pill) pill.style.display = 'none';
    } else S.run(true);
  };

  S.rejudge = function () {
    if (!current || !session.active()) return;
    current.score = strategy.combine(current.offlineResult, reviewFor(current), judgeContext()).score;
    mountCard(current, { llmLoading: !!current.llmPending });
    applyPage(current, { slam: false });
  };

  S.dispose = () => { card?.remove(); pill?.remove(); page.clear(); page.layer?.remove(); current=null; };
  function applyPage(...args) {
    page.apply(...args).catch(error => { if (error.name !== 'AbortError') console.warn('[DFY] Profile effect failed', error); });
  }
  session.cleanup(S.dispose);
  for (const name of ['run','llm']) {
    const operation=S[name];
    S[name]=(...args)=>!session.active()?Promise.resolve():operation(...args).catch(error=>{if(error.name!=='AbortError')console.warn('[DFY] Profile operation failed',error);});
  }
  return S;
  };
})();
