/* Versioned list imports share the same identity validation as storage. */
(function () {
  const D = globalThis.DFY;
  D.normalizeList = function (x) {
    const out = {};
    const put = (mid, v) => {
      mid = String(mid || '').trim();
      const parsed = D.model.parseAccountKey(mid);
      const platform = typeof v === 'object' && v && v.platform ? String(v.platform) : parsed?.platform || D.bilibili.id;
      const rawId = typeof v === 'object' && v && (v.id || v.mid) ? String(v.id || v.mid) : parsed?.id || mid;
      if (!D.platforms.get(platform)) return;
      if (!parsed && !(v && v.platform) && !/^\d+$/.test(rawId)) return;
      if (parsed && (parsed.id !== rawId || parsed.platform !== platform)) return;
      let key;
      try { key = D.model.accountKey(platform, rawId); } catch (e) { return; }
      if (!key) return;
      out[key] = typeof v === 'object' && v ? { ...v, platform, id: rawId, n: String(v.n || v.name || v.uname || ''), a: String(v.a || v.avatar || ''), t: +v.t || Date.now() } : { platform, id: rawId, n: typeof v === 'string' ? v : '', t: Date.now() };
    };
    if (Array.isArray(x)) for (const it of x) typeof it === 'object' && it ? put(it.mid || it.id, it) : put(it, '');
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) put(k, v);
    return out;
  };
})();
