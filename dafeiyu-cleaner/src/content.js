/* 入口：读取设置、挂载鲸鱼娘、按页面类型启动对应模块 */
(async function () {
  const DFY = globalThis.DFY;
  if (DFY.booted) return;
  if (window.top !== window || !DFY.platform) return;
  DFY.booted = true;

  const hasRuntime = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  DFY.session = null;
  DFY.canLLM = !!hasRuntime;
  DFY.callBg = function (msg) {
    if (!hasRuntime) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  };

  let st;
  try { [st] = await Promise.all([DFY.store.get(['settings', 'blocklist', 'whitelist']), DFY.memory.load()]); }
  catch (error) {
    DFY.platformStatus.state = 'error';
    console.error('[DFY] 本地数据初始化失败，已保留原数据并停止启动。', error);
    return;
  }
  DFY.settings = DFY.effectiveSettings(st.settings, DFY.platform.id);
  DFY.lists = { block: st.blocklist, white: st.whitelist };

  // 标题字体（得意黑子集，改名为 DFY Display）。@font-face 必须声明在文档里，shadow DOM 内无效
  if (hasRuntime && !document.getElementById('dfy-font')) {
    const f = document.createElement('style');
    f.id = 'dfy-font';
    f.textContent = `@font-face{font-family:"DFY Display";src:url("${chrome.runtime.getURL('assets/dfy-display.woff2')}") format("woff2");font-display:swap}`;
    (document.head || document.documentElement).appendChild(f);
  }
  DFY.ui.mount();
  DFY.store.get('customMascot').then((u) => u && DFY.ui.setCustom(u));
  const showMascot = (s) => s.enabled && s.showMascot && !s.quiet;
  DFY.ui.look(DFY.settings);
  DFY.ui.show(showMascot(DFY.settings));

  DFY.store.onChange((ch) => {
    if (ch.settings) {
      const prev = DFY.settings;
      DFY.settings = DFY.effectiveSettings(Object.assign({}, DFY.DEFAULTS.settings, ch.settings), DFY.platform.id);
      DFY.ui.look(DFY.settings);
      DFY.ui.show(showMascot(DFY.settings));
      if (prev.enabled !== DFY.settings.enabled) startSession();
      else if (['threshold', 'mode', 'llmEnabled', 'llmModel', 'llmVision', 'llmKey', 'quiet', 'hideAtFish'].some((k) => prev[k] !== DFY.settings[k])) {
        DFY.comments?.rejudgeAll();
        DFY.space?.rejudge();
      }
    }
    if ('customMascot' in ch) DFY.ui.setCustom(ch.customMascot || '');
    if (ch.blocklist) DFY.lists.block = ch.blocklist || {};
    if (ch.whitelist) DFY.lists.white = ch.whitelist || {};
    if ('seen' in ch) DFY.memory.seen = ch.seen || {};
    if ('llmCache' in ch) DFY.memory.llm = ch.llmCache || {};
    if (ch.blocklist || ch.whitelist) { DFY.comments?.rejudgeAll(); DFY.space?.rejudge(); }
  });

  // 插件面板查询本页状态 / 快捷键
  if (hasRuntime)
    chrome.runtime.onMessage.addListener((msg, sender, send) => {
      if (!msg || !msg.dfy) return;
      const C = DFY.comments;
      if (msg.dfy === 'status') send({ enabled: DFY.settings.enabled, platform: DFY.platform?.id || 'bilibili', page: DFY.platformContext, platformStatus: DFY.platformStatus, comments: C.hasComments(), space: isSpace(), ...C.stats() });
      else if (msg.dfy === 'snap') C.snap(), send({ ok: true });
      else if (msg.dfy === 'cannon') { const allowed = DFY.platform.getCapabilities().commentAnimation; if (allowed) DFY.ui.cannon(true); send({ ok: !!allowed }); }
      else if (msg.dfy === 'rescan') C.rescan(), send({ ok: true });
      else if (msg.dfy === 'llm') C.llmPage(), send({ ok: true });
      else if (msg.dfy === 'report') DFY.space?.show(), send({ ok: !!DFY.space });
    });

  const isSpace = () => DFY.platform.getCapabilities().profileInspection && !!DFY.space?.midFromUrl();

  const I = (n) => DFY.icon(n, 17, 2.2);
  DFY.menuItems = function () {
    const n = DFY.comments.fishCount || 0;
    const s = DFY.settings;
    const items = [];
    if (n) items.push({ label: `${I('snap')}响指清场 <span class="n">${n}</span>`, primary: true, run: () => DFY.comments.snap() });
    if (isSpace()) items.push({ label: I('report') + '鉴定报告', primary: !n, run: () => DFY.space.show() });
    if (DFY.platform.getCapabilities().commentAnimation) items.push({ label: I('bubble') + '泡泡大炮', run: () => DFY.ui.cannon(true) });
    if (DFY.comments.hasComments() && DFY.detection.get(DFY.platform.id)?.getPolicy?.({ threshold: s.threshold }).autoBlock)
      items.push({
        label: I('bolt') + (s.mode === 'auto' ? '自动清场：已开启' : '进页面自动清场'),
        run: async () => {
          const next = s.mode === 'auto' ? 'mark' : 'auto';
          await DFY.store.patch('settings', (st) => {
            st.mode = next;
          });
          DFY.settings.mode = next;
          DFY.ui.say(next === 'auto' ? '好！以后一进页面本鲸就先清场' : '自动清场关掉啦，等你下令', { face: next === 'auto' ? 'smug' : 'happy' });
          if (next === 'auto') DFY.comments.snap({ auto: true });
        },
      });
    if (DFY.comments.hasComments()) items.push({ label: I('search') + '重新巡逻', run: () => DFY.comments.rescan() });
    if (DFY.detection.get(DFY.platform.id)?.llm && s.llmEnabled && s.llmKey) {
      if (DFY.comments.hasComments()) items.push({ label: I('brain') + 'DeepSeek 精判本页', run: () => DFY.comments.llmPage() });
    } else if (DFY.detection.get(DFY.platform.id)?.llm) items.push({ label: I('brain') + '开启 DeepSeek 精判', run: () => DFY.callBg({ type: 'open-options' }) });
    items.push({ label: I('hide') + '先藏起来', run: () => DFY.ui.minimize() });
    items.push({ label: I('gear') + '设置', run: () => DFY.callBg({ type: 'open-options' }) });
    return items;
  };

  let suspended = false;
  function startSession() {
    if (suspended) return;
    DFY.session?.dispose();
    DFY.platform.dispose?.();
    DFY.space?.dispose?.();
    const session = DFY.createSession(DFY.platform, DFY.platformContext);
    DFY.session = session;
    DFY.space = DFY.platform.createProfile?.(session) || null;
    DFY.comments = DFY.createCommentController(session);
    DFY.platformStatus.state = 'waiting';
    DFY.ui.setCount(0);
    if (!DFY.settings.enabled) return;
    session.cleanup(() => DFY.platform.dispose());
    DFY.platform.start(session, { comments: batch => DFY.comments.receive(batch), bindingsChanged: () => DFY.comments.render() }, session.signal);
  }
  startSession();

  // 打招呼
  DFY.session.later(() => {
    if (!isSpace()) DFY.ui.say(DFY.say('hello'), { face: 'happy', ms: 2600 });
  }, 1200);

  // 空间主页鉴定（B 站空间是单页应用，路由变化时重新鉴定）
  let lastMid = '';
  const checkRoute = () => {
    if (suspended) return;
    if (DFY.refreshPlatformContext && DFY.refreshPlatformContext()) {
      startSession();
    }
    const mid = DFY.space?.midFromUrl() || '';
    const profileSession = DFY.session.sessionId;
    if (mid && profileSession !== lastMid && DFY.settings.enabled) {
      lastMid = profileSession;
      // 极简模式不自动弹鉴定报告，需要时从插件面板打开
      if (DFY.settings.enabled && !DFY.settings.quiet) DFY.session.later(() => DFY.space.run(), 900);
    }
    if (!mid) lastMid = '';
  };
  DFY.checkRoute = checkRoute;
  checkRoute();
  let routeTimer = setInterval(checkRoute, 1000);
  window.addEventListener('pagehide', () => {
    suspended = true;
    clearInterval(routeTimer);
    routeTimer = null;
    DFY.session?.dispose();
    DFY.memory.flush().catch(console.warn);
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !suspended) return;
    suspended = false;
    DFY.refreshPlatformContext?.();
    startSession();
    checkRoute();
    routeTimer = setInterval(checkRoute, 1000);
  });
})();
