/* 设置面板 & 战绩 */
(async function () {
  const DFY = globalThis.DFY;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const accountInfo = (key) => DFY.model?.parseAccountKey?.(key) || { platform: 'bilibili', id: String(key) };
  const profileHref = (key) => { const a = accountInfo(key); return DFY.platforms.get(a.platform)?.resolveProfileUrl?.(a) || '#'; };
  if (location.search.includes('page') || window.innerWidth > 500) document.body.classList.add('page');

  const style = document.createElement('style');
  style.textContent = DFY.mascotCSS;
  document.head.appendChild(style);
  for (const el of document.querySelectorAll('[data-ic]')) el.insertAdjacentHTML('afterbegin', DFY.icon(el.dataset.ic, 17, 2.2));
  document.querySelector('.hint.lock').insertAdjacentHTML('afterbegin', DFY.icon('lock', 14, 2.2));
  $('eye').innerHTML = DFY.icon('eye', 17, 2.2);
  $('test').insertAdjacentHTML('afterbegin', DFY.icon('bolt', 15, 2.4));
  $('cm-upload').insertAdjacentHTML('afterbegin', DFY.icon('image', 15, 2.4));
  $('cm-reset').insertAdjacentHTML('afterbegin', DFY.icon('undo', 15, 2.4));

  let S;
  try { S = await DFY.store.get(['settings', 'stats', 'blocklist', 'whitelist', 'customMascot', 'seen']); }
  catch (error) {
    document.body.textContent = '本地数据初始化失败，已停止操作以保留原数据。请查看扩展后台错误信息：' + error.message;
    console.error('[DFY] Storage initialization failed', error);
    return;
  }
  let settingsQueue = Promise.resolve();
  const pendingSettings = {};
  const storageError = () => {
    $('save-status').textContent = '保存失败，请重试；扩展重新加载后请关闭并重开此面板。';
  };
  // Save only edited fields against the latest data; never write an old panel snapshot.
  function save(...fields) {
    const patch = Object.fromEntries(fields.map(key => [key, S.settings[key]]));
    Object.assign(pendingSettings, patch);
    $('save-status').textContent = '正在保存…';
    const clearPending = () => {
      for (const [key, value] of Object.entries(patch)) if (pendingSettings[key] === value) delete pendingSettings[key];
    };
    settingsQueue = settingsQueue.then(async () => {
      try {
        const saved = await DFY.store.patch('settings', settings => Object.assign(settings, patch));
        clearPending();
        S.settings = { ...saved, ...pendingSettings };
        renderSettings();
        $('save-status').textContent = Object.keys(pendingSettings).length ? '正在保存…' : '设置已保存到本机';
        return true;
      } catch (error) {
        clearPending();
        try { S.settings = { ...await DFY.store.get('settings'), ...pendingSettings }; renderSettings(); } catch (_) {}
        storageError();
        return false;
      }
    });
    return settingsQueue;
  }
  async function listChange(action) {
    try {
      await action();
      Object.assign(S, await DFY.store.get(['blocklist', 'whitelist']));
      renderLists();
      return true;
    } catch (error) { storageError(); return false; }
  }
  const whale = () => $('whale').querySelector('.dfy-whale');

  /* ---------- 分页（记住上次停留的页） ---------- */
  function showTab(name) {
    for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === name);
    for (const p of document.querySelectorAll('.panel')) p.classList.toggle('on', p.dataset.panel === name);
    try {
      localStorage.setItem('dfy-tab', name);
    } catch (e) {}
  }
  $('tabs').onclick = (e) => e.target.dataset.tab && showTab(e.target.dataset.tab);
  let lastTab = 'detect';
  try {
    lastTab = localStorage.getItem('dfy-tab') || 'detect';
  } catch (e) {}
  showTab(lastTab);

  function say(t, face) {
    $('say').textContent = t;
    const w = whale();
    if (face && w) {
      w.setAttribute('data-face', face);
      setTimeout(() => w.setAttribute('data-face', 'normal'), 1800);
    }
  }
  $('whale').onclick = () => say(DFY.say('pet'), 'happy');

  const MODE_HINT = {
    mark: '只挂「大肥鱼」标签，赶不赶由你决定。点页面上的鲸鱼娘可以一键响指清场。',
    fold: '自动把大肥鱼装进白饭碗折叠起来，想看可以「偷看一眼」。',
    auto: '每次进入页面，评论区一出现，鲸鱼娘就自动走过去打响指清场；之后翻页加载出来的新大肥鱼也会被直接赶走。随时可以在战报里「全部放回」。',
  };
  const QUIET_MODE_HINT = {
    mark: '只在评论旁挂一个小标签，不打扰你。',
    fold: '大肥鱼评论折叠成一行小字，想看点「显示」。',
    auto: '大肥鱼评论直接隐藏，评论区上方留一行小字，点「显示」可以全部放回。',
  };
  const MODE_LABEL = { mark: '只标记', fold: '装进白饭碗', auto: '自动清场' };
  const QUIET_MODE_LABEL = { mark: '只标记', fold: '折叠', auto: '直接隐藏' };

  const WPN_HINT = {
    random: '每次随机换一种武器；响指清场时偶尔会换成加特林挨个点射。',
    slap: '一巴掌拍飞，或者让它抱着白饭碗哭着跑，再往它离场的地方补一碗。',
    gatling: '后撤一步架起白饭加特林，一梭子米粒子弹。响指清场也会改成加特林扫射。',
    broom: '扫帚连扫三下，把它扫地出门。',
    sock: '扔一只三天没洗的臭袜子，熏晕了再说。',
    rice: '让它自己走，一路朝它扔白饭，最后往它离场的地方再扔一碗。',
  };

  const TOGGLES = ['enabled', 'quiet', 'hideAtFish', 'showMascot', 'sound', 'llmEnabled', 'llmAuto', 'llmVision'];
  function renderSettings() {
    const s = S.settings;
    for (const id of TOGGLES) $(id).checked = !!s[id];
    document.querySelector('[data-panel=detect]').classList.toggle('quiet', !!s.quiet);
    if (document.activeElement !== $('mascotSize')) $('mascotSize').value = s.mascotSize || 100;
    $('ms-val').textContent = (s.mascotSize || 100) + '%';
    if (document.activeElement !== $('threshold')) $('threshold').value = s.threshold;
    $('th-val').textContent = Math.max(60, s.threshold) + '分';
    $('th-hint').textContent = `B 站线索分门槛 ${Math.max(60, s.threshold)}，且须有明确自述；抖音使用独立门槛。分数不代表 AI 概率。`;
    if (document.activeElement !== $('llmKey')) $('llmKey').value = s.llmKey || '';
    $('llmModel').value = s.llmModel;
    for (const b of $('mode').children) {
      b.classList.toggle('on', b.dataset.v === 'mark');
      b.disabled = b.dataset.v !== 'mark';
      b.textContent = (s.quiet ? QUIET_MODE_LABEL : MODE_LABEL)[b.dataset.v];
    }
    $('mode-hint').textContent = '当前新策略处于验证阶段，只标记并由你选择隐藏；已加入名单的账号仍会折叠。自动处理待准确性验证后开放。';
    $('hideAtFish').disabled = true;
    $('hideAtFish').checked = false;
    for (const b of $('weapon').children) b.classList.toggle('on', b.dataset.v === (s.weapon || 'random'));
    $('wpn-hint').textContent = WPN_HINT[s.weapon || 'random'];
    document.querySelector('.ds').classList.toggle('off', !s.llmEnabled);
  }

  function renderStats() {
    const st = S.stats;
    const d = new Date();
    const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    $('s-today').textContent = st.day === today ? st.today : 0;
    $('s-total').textContent = st.total;
    $('s-chars').textContent = st.chars >= 10000 ? (st.chars / 10000).toFixed(1) + '万' : st.chars;
  }

  function renderLists() {
    const all = Object.entries(S.blocklist).sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
    const q = $('bl-q').value.trim().toLowerCase();
    const bl = q ? all.filter(([mid, v]) => mid.includes(q) || String(v.n || '').toLowerCase().includes(q)) : all;
    $('bl-n').textContent = all.length;
    $('bl').innerHTML = bl.length
      ? bl
          .slice(0, 300)
          .map(
            ([mid, v]) =>
              `<li>${v.a ? `<img src="${esc(DFY.platforms.get(accountInfo(mid).platform)?.resolveAvatarUrl?.(v.a) || DFY.model.httpUrl(v.a) || '')}" referrerpolicy="no-referrer">` : '<img alt="">'}<a class="n" href="${esc(profileHref(mid))}" target="_blank">${esc(v.n || accountInfo(mid).id)}</a><span class="d">${accountInfo(mid).platform === 'douyin' ? '抖音' : 'B 站'} · ${v.t ? new Date(v.t).toLocaleDateString() : '导入'}</span><button data-un="${esc(mid)}">放回来</button></li>`
          )
          .join('')
      : `<li class="empty">${q ? '没有找到这条鱼' : '还没有赶走任何大肥鱼'}</li>`;
    const wl = Object.entries(S.whitelist).sort((a, b) => b[1].t - a[1].t);
    $('wl-n').textContent = wl.length;
    $('wl').innerHTML = wl.length
      ? wl.map(([mid, v]) => `<li><a class="n" href="${esc(profileHref(mid))}" target="_blank">${esc(v.n || accountInfo(mid).id)}</a><span class="d">${accountInfo(mid).platform === 'douyin' ? '抖音' : 'B 站'}</span><button data-unw="${esc(mid)}">移除</button></li>`).join('')
      : '<li class="empty">在评论旁点「保留账号」可加入白名单</li>';
  }

  function renderCustom() {
    $('cm-preview').innerHTML = S.customMascot ? `<img src="${S.customMascot}" alt="">` : DFY.mascotSVG({ face: 'normal' });
    $('whale').innerHTML = S.customMascot ? `<img class="custom" src="${S.customMascot}" alt="">` : DFY.mascotSVG({ face: 'happy' });
  }

  function greet() {
    const t = S.stats.total;
    if (!S.settings.enabled) return say('本鲸下班了，打开开关就回来', 'sleepy');
    if (t === 0) return say('还没赶走过大肥鱼，去 B 站逛逛吧', 'normal');
    if (t < 100) return say(`已经赶走 ${t} 条大肥鱼啦`, 'happy');
    return say(`${t} 条！你就是鱼塘管理员`, 'smug');
  }

  function renderSeen() {
    $('seen-n').textContent = Object.keys(S.seen || {}).length;
  }

  /* ---------- 本页状态：直接在面板里指挥鲸鱼娘 ---------- */
  const isPage = document.body.classList.contains('page');
  async function activeTab() {
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      return t;
    } catch (e) {
      return null;
    }
  }
  const ask = (tabId, msg) =>
    new Promise((ok) => {
      try {
        chrome.tabs.sendMessage(tabId, msg, (r) => {
          void chrome.runtime.lastError;
          ok(r || null);
        });
      } catch (e) {
        ok(null);
      }
    });
  let hereTab = null, hereSig = '';
  async function renderHere() {
    const tab = isPage ? null : await activeTab();
    const st = tab && tab.id != null ? await ask(tab.id, { dfy: 'status' }) : null;
    hereTab = tab;
    let t, s, cls = '', btns = [];
    if (!st) {
      t = isPage ? '设置页' : '当前页面尚未连接';
      s = isPage ? '在支持的平台页面点插件图标，可以直接指挥本鲸' : '支持 B 站与抖音网页版；已打开的页面请刷新后重试';
      if (!isPage) btns = [['open', '去 B 站', 'ghost']];
    } else if (!st.enabled) {
      t = '本鲸下班了';
      s = '打开右上角的开关，本鲸马上回来';
    } else if (st.platformStatus?.state === 'limited') {
      t = '评论结构暂不可读取';
      s = '已找到评论区，但当前布局缺少可识别字段';
      btns = [['rescan', '重新读取', 'ghost']];
    } else if (st.fish) {
      cls = 'fish';
      t = `本页 ${st.fish} 条候选/名单评论`;
      s = `巡逻 ${st.accounts} 个账号 · 可疑 ${st.suspect} · ${st.quiet ? '已隐藏' : '已赶走'} ${st.kicked}${st.atHidden ? ` · @ 大肥鱼 ${st.atHidden}` : ''}`;
      btns = st.quiet ? [['snap', '全部隐藏', '']] : [['snap', '响指清场', ''], ['cannon', '泡泡炮', 'ghost']];
    } else if (st.unassessed) {
      t = '部分评论暂未判定';
      s = `${st.unassessed} 条评论缺少稳定账号 ID 或适用识别策略，可手动隐藏评论`;
      btns = [['rescan', '重新读取', 'ghost']];
    } else if (st.comments && !st.accounts && st.platformStatus?.state === 'waiting') {
      t = '评论区正在加载';
      s = '评论加载完成后会读取已加载内容；也可以点击重新读取';
      btns = [['rescan', '重新读取', 'ghost']];
    } else if (st.comments && st.accounts) {
      t = st.suspect ? '部分账号待核实' : '已读取评论';
      s = `${st.accounts} 个账号 · 待核实 ${st.suspect} · 证据不足 ${st.unknown || 0} · 已隐藏 ${st.kicked}`;
      btns = st.quiet ? [] : [['rescan', '重新巡逻', 'ghost'], ['cannon', '泡泡炮', 'ghost']];
    } else if (st.space) {
      t = '空间主页';
      s = st.quiet ? '极简模式下不自动弹出鉴定报告' : '鉴定报告在页面右上角';
      btns = [['report', '鉴定报告', ''], ['cannon', '泡泡炮', 'ghost']];
    } else {
      t = '还没看到评论区';
      s = '滚到评论区，本鲸就开始巡逻';
      btns = [['cannon', '泡泡炮', 'ghost']];
    }
    if (st?.platformStatus?.capabilities?.commentAnimation === false) {
      btns = btns.filter(([action]) => action !== 'cannon').map(([action, label, cls]) => [action, action === 'snap' ? '全部隐藏' : label, cls]);
      s = s.replace('已赶走', '已隐藏');
    }
    if (st?.platform === 'douyin') {
      t = '抖音 · ' + t;
      if (st.enabled && st.platformStatus?.state !== 'limited') {
        if (st.comments && st.accounts) s = `${st.accounts} 个账号 · 疑似自动 ${st.candidates || 0} · 待核实 ${st.suspect} · 证据不足 ${st.unknown || 0} · 名单 ${st.listed || 0}`;
        else s = '打开视频评论面板后，插件会读取已加载评论';
      }
    }
    const sig = JSON.stringify([t, s, cls, btns]);
    if (sig === hereSig) return;
    hereSig = sig;
    $('here').className = 'here ' + cls;
    $('here-t').textContent = t;
    $('here-s').textContent = s;
    $('here-btns').innerHTML = btns.map(([a, l, c]) => `<button class="btn ${c}" data-here="${a}">${l}</button>`).join('');
  }
  $('here-btns').onclick = async (e) => {
    const a = e.target.closest('[data-here]')?.dataset.here;
    if (!a) return;
    if (a === 'open') return chrome.tabs.create({ url: 'https://www.bilibili.com/' });
    if (!hereTab) return;
    await ask(hereTab.id, { dfy: a });
    window.close();
  };

  /* ---------- 大肥鱼图鉴 ---------- */
  const DEX = [
    ['caught', '被抓包', 'fishCaught'],
    ['scared', '吓到发抖', 'fishPlead'],
    ['defiant', '嘴硬', 'fishSass'],
    ['beg', '求饶', 'fishPlead'],
    ['flee', '抱碗逃跑', 'fishFlee'],
    ['knocked', '被拍飞', 'fishFlee'],
    ['dust', '化成泡沫', 'fishFlee'],
    ['home', '回家吃白饭', 'fishFlee'],
  ];
  $('dex').innerHTML = DEX.map(([p, n]) => `<button data-p="${p}" title="${n}"><img src="../assets/actors/${p}.webp" alt="${n}"><span>${n}</span></button>`).join('');
  $('dex').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const [, n, line] = DEX.find((d) => d[0] === b.dataset.p);
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
    say(`${n}：「${DFY.say(line)}」`);
  };

  const ARMORY = [
    ['gatling', '白饭加特林', 'wGatling'],
    ['broom', '扫帚', 'wBroom'],
    ['sock', '臭袜子', 'wSock'],
    ['rice', '白饭', 'wRice'],
  ];
  $('armory').innerHTML = ARMORY.map(([p, n]) => `<button data-p="${p}" title="${n}"><img src="../assets/weapons/${p}.webp" alt="${n}"><span>${n}</span></button>`).join('');
  $('armory').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const [, , line] = ARMORY.find((d) => d[0] === b.dataset.p);
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
    say(DFY.say(line), 'angry');
  };

  renderCustom();
  renderSettings();
  renderStats();
  renderLists();
  renderSeen();
  greet();
  renderHere();
  setInterval(renderHere, 1500);

  /* ---------- 设置 ---------- */
  // Firefox 要求把网页内容发给第三方前取得用户授权，Chrome 不需要这一步
  function askConsent() {
    try {
      if (!chrome.runtime.getURL('').startsWith('moz-extension:')) return null;
      return chrome.permissions.request({ data_collection: ['websiteContent'] });
    } catch (e) {
      return null;
    }
  }
  for (const id of TOGGLES) {
    $(id).onchange = () => {
      S.settings[id] = $(id).checked;
      // Quiet changes presentation only; it never enables automatic handling.
      save(id);
      renderSettings();
      if (id === 'enabled') greet();
      if (id === 'quiet') say(S.settings.quiet ? '本鲸躲起来悄悄干活' : '本鲸回来啦！', S.settings.quiet ? 'smug' : 'happy');
      if (id === 'hideAtFish' && S.settings.hideAtFish) say('召唤大肥鱼的评论也一起藏起来', 'smug');
      if (id === 'llmEnabled' && S.settings.llmEnabled && !S.settings.llmKey) say('填一下 DeepSeek 密钥吧', 'normal');
      const consent = id === 'llmEnabled' && S.settings.llmEnabled && askConsent();
      if (consent)
        consent.then(
          (ok) => {
            if (ok) return;
            S.settings.llmEnabled = false;
            $(id).checked = false;
            save('llmEnabled');
            renderSettings();
            say('不授权的话，本鲸就只用离线规则啦', 'normal');
          },
          () => {}
        );
    };
  }
  $('mascotSize').oninput = () => {
    S.settings.mascotSize = +$('mascotSize').value;
    $('ms-val').textContent = S.settings.mascotSize + '%';
    save('mascotSize');
  };
  $('threshold').oninput = () => {
    S.settings.threshold = +$('threshold').value;
    renderSettings();
  };
  $('threshold').onchange = () => save('threshold');
  $('mode').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v || v !== 'mark') return;
    S.settings.mode = v;
    save('mode');
    renderSettings();
    say(v === 'auto' ? '以后进门先清场！' : v === 'fold' ? '白饭碗准备好了' : '本鲸只负责贴标签', 'smug');
  };
  $('weapon').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    S.settings.weapon = v;
    save('weapon');
    renderSettings();
    say({ random: '武器库全开，随机抽一件！', slap: '还是巴掌最顺手', gatling: '白饭加特林已上膛', broom: '扫帚已就位', sock: '袜子……本鲸捏着鼻子拿', rice: '白饭管够！' }[v], 'smug');
  };
  $('llmKey').onchange = () => {
    S.settings.llmKey = $('llmKey').value.trim();
    save('llmKey');
  };
  $('llmModel').onchange = () => {
    S.settings.llmModel = $('llmModel').value;
    save('llmModel');
  };
  $('eye').onclick = () => ($('llmKey').type = $('llmKey').type === 'password' ? 'text' : 'password');
  $('test').onclick = async () => {
    const key = $('llmKey').value.trim();
    const r = $('test-res');
    if (!key) {
      r.className = 'err';
      r.textContent = '先填密钥哦';
      return;
    }
    S.settings.llmKey = key;
    $('test').disabled = true;
    if (!await save('llmKey')) { $('test').disabled = false; return; }
    r.className = '';
    r.textContent = '咕噜咕噜，正在连接……';
    whale() && whale().setAttribute('data-face', 'smug');
    const res = await new Promise((ok) => chrome.runtime.sendMessage({ type: 'llm-test', key, model: S.settings.llmModel }, ok));
    $('test').disabled = false;
    if (res && res.ok) {
      r.className = 'ok';
      r.innerHTML = `${DFY.icon('check', 15, 2.8)}${esc(res.hi)}（${(res.ms / 1000).toFixed(1)}s）`;
      say(res.hi, 'happy');
    } else {
      r.className = 'err';
      r.innerHTML = DFY.icon('close', 15, 2.8) + esc((res && res.error) || '服务器繁忙，请稍后再试');
      say('服务器繁忙……（不是本鲸的错）', 'cry');
    }
  };

  /* ---------- 名单 ---------- */
  document.addEventListener('click', async (e) => {
    const un = e.target.dataset && e.target.dataset.un;
    const unw = e.target.dataset && e.target.dataset.unw;
    if (un) {
      if (await listChange(() => DFY.store.listAction(un, null, 'unblock'))) say('放回去了，希望它学乖点', 'smug');
    }
    if (unw) {
      await listChange(() => DFY.store.listAction(unw, null, 'unwhite'));
    }
  });
  /** 危险操作点两下才生效 */
  function confirm2(btn, fn) {
    const label = btn.textContent;
    btn.onclick = async () => {
      if (!btn.classList.contains('armed')) {
        btn.classList.add('armed');
        btn.textContent = '再点一下确认';
        clearTimeout(btn._t);
        btn._t = setTimeout(() => {
          btn.classList.remove('armed');
          btn.textContent = label;
        }, 2600);
        return;
      }
      clearTimeout(btn._t);
      btn.classList.remove('armed');
      btn.textContent = label;
      await fn();
    };
  }
  confirm2($('bl-clear'), async () => {
    if (await listChange(() => DFY.store.set({ blocklist: {} }))) say('全部放回鱼塘了', 'cry');
  });
  confirm2($('wl-clear'), async () => {
    await listChange(() => DFY.store.set({ whitelist: {} }));
  });
  confirm2($('seen-clear'), async () => {
    try {
      await DFY.store.set({ seen: {}, llmCache: {} });
      S.seen = {}; renderSeen();
      say('前科和精判缓存都忘光了', 'sleepy');
    } catch (error) { storageError(); }
  });
  $('bl-q').oninput = renderLists;

  /* ---------- 名单导入 / 导出（可以和朋友分享大肥鱼名单） ---------- */
  $('io-export').onclick = () => {
    const data = { app: 'dafeiyu-cleaner', v: 2, exported: new Date().toISOString(), blocklist: S.blocklist, whitelist: S.whitelist };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `大肥鱼名单-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    say(`导出了 ${Object.keys(S.blocklist).length} 条大肥鱼`, 'smug');
  };
  $('io-import').onchange = async () => {
    const f = $('io-import').files[0];
    $('io-import').value = '';
    if (!f) return;
    let j;
    try {
      j = JSON.parse(await f.text());
    } catch (e) {
      return say('这个文件本鲸看不懂（不是 JSON）', 'cry');
    }
    if (j?.app === 'dafeiyu-cleaner' && ![1, 2].includes(j.v)) return say('名单版本不兼容，请更新插件后再导入', 'cry');
    const bl = DFY.normalizeList(j && (j.blocklist || (j.whitelist ? null : j)));
    const wl = DFY.normalizeList(j && j.whitelist);
    let nb = 0, nw = 0;
    const imported = await listChange(() => DFY.store.transaction(data => {
      nb = 0; nw = 0;
      for (const [mid,v] of Object.entries(wl)) { if (!data.whitelist[mid]) { data.whitelist[mid]=v; nw++; } delete data.blocklist[mid]; }
      for (const [mid,v] of Object.entries(bl)) if (!data.blocklist[mid] && !data.whitelist[mid]) { data.blocklist[mid]=v; nb++; }
      return { blocklist: data.blocklist, whitelist: data.whitelist };
    }));
    if (!imported) return;
    say(nb || nw ? `导入了 ${nb} 条大肥鱼${nw ? `、${nw} 位人类` : ''}` : '都是老面孔，没有新鱼', nb ? 'smug' : 'normal');
  };

  /* ---------- 自定义形象 ---------- */
  $('cm-file').onchange = () => {
    const f = $('cm-file').files[0];
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) return say('图片太大啦，3MB 以内哦', 'shock');
    const rd = new FileReader();
    rd.onload = async () => {
      try {
        await DFY.store.set({ customMascot: rd.result });
        S.customMascot = rd.result; renderCustom();
        say('新形象已换上，去 B 站看看', 'happy');
      } catch (error) { storageError(); }
    };
    rd.readAsDataURL(f);
  };
  $('cm-reset').onclick = async () => {
    try {
      await DFY.store.set({ customMascot: '' });
      S.customMascot = ''; renderCustom();
      say('欢迎回来，原装本鲸', 'happy');
    } catch (error) { storageError(); }
  };

  DFY.store.onChange((ch) => {
    if (ch.settings) {
      S.settings = { ...DFY.DEFAULTS.settings, ...ch.settings, ...pendingSettings };
      renderSettings();
      greet();
    }
    if ('customMascot' in ch) { S.customMascot = ch.customMascot || ''; renderCustom(); }
    for (const k of ['stats', 'blocklist', 'whitelist']) if (ch[k]) S[k] = Object.assign({}, DFY.DEFAULTS[k], ch[k]);
    if ('seen' in ch) S.seen = ch.seen || {};
    if (ch.stats) renderStats();
    if (ch.blocklist || ch.whitelist) renderLists();
    if ('seen' in ch) renderSeen();
  });
})();
