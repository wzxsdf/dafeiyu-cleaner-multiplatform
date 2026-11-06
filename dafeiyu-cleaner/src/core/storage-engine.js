/* Serialized background storage owner. Revision checks protect read/modify/write. */
(function () {
  const D = globalThis.DFY;
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const collections = ['blocklist', 'whitelist', 'seen', 'llmCache'];
  D.migrateStorage = function (raw) {
    if (raw.schemaVersion > 2) throw new Error('Data belongs to a newer extension version');
    if (raw.schemaVersion === 2) return null;
    const update = {};
    if (!raw.legacyBackupV1) update.legacyBackupV1 = { t: Date.now(), data: Object.fromEntries(Object.keys(D.DEFAULTS).filter(k => k in raw).map(k => [k, clone(raw[k])])) };
    for (const field of collections) {
      update[field] = {};
      for (const [key, v] of Object.entries(raw[field] || {})) {
        const parsed = D.model.parseAccountKey(key);
        if (!parsed && !/^\d+$/.test(key)) throw new Error('Unknown legacy identity; migration stopped');
        const identity = parsed || { platform: D.bilibili.id, id: key };
        const next = { ...v, ...identity };
        if (field === 'seen' && !parsed) {
          next.k = (v.k || []).map(p => D.bilibili.legacyPage(p)).filter(Boolean).map(p => D.model.pageKey(identity.platform, p));
          next.c = next.k.length;
        }
        if (field === 'llmCache') next.strategyVersion = 'legacy-expired';
        if (field === 'blocklist' || field === 'whitelist') next.source ||= 'legacy';
        update[field][D.model.accountKey(identity.platform, identity.id)] = next;
      }
    }
    for (const key of Object.keys(update.whitelist)) delete update.blocklist[key];
    return { ...update, schemaVersion: 2, storeRevision: (raw.storeRevision || 0) + 1 };
  };
  D.createStorageEngine = function (local) {
    let queue = Promise.resolve(), ready = false;
    const serialize = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
    async function ensure() {
      if (ready) return;
      const raw = await local.get(null), update = D.migrateStorage(raw);
      if (update) {
        if (update.legacyBackupV1) await local.set({ legacyBackupV1: update.legacyBackupV1 });
        await local.set(update);
      }
      ready = true;
    }
    function defaults(raw) {
      const out = {};
      for (const [k,v] of Object.entries(D.DEFAULTS)) out[k] = raw[k] == null ? clone(v) : v && typeof v === 'object' ? { ...clone(v), ...raw[k] } : raw[k];
      return out;
    }
    return { request(message) { return serialize(async () => {
      await ensure();
      const raw = await local.get(null), data = defaults(raw), revision = raw.storeRevision || 0;
      if (message.op === 'read') return { ok: true, data: message.keys ? Object.fromEntries(message.keys.filter(k => k in D.DEFAULTS).map(k => [k,data[k]])) : data, revision };
      if (message.op === 'commit') {
        if (revision !== message.revision) return { ok: false, conflict: true };
        const update = clone(message.update);
        if (!update || Object.keys(update).some(k => !(k in D.DEFAULTS) || k === 'schemaVersion')) throw new Error('Invalid storage keys');
        for (const k of collections) if (k in update) {
          if (!update[k] || Array.isArray(update[k]) || typeof update[k] !== 'object') throw new Error('Invalid collection');
          for (const [key,entry] of Object.entries(update[k])) {
            const identity = D.model.parseAccountKey(key);
            if (!identity || !entry || typeof entry !== 'object') throw new Error('Invalid account entry');
            update[k][key] = { ...entry, ...identity };
          }
        }
        if (update.whitelist || update.blocklist) {
          const white = update.whitelist || data.whitelist;
          update.blocklist = { ...(update.blocklist || data.blocklist) };
          for (const key of Object.keys(white)) delete update.blocklist[key];
        }
        if ('seen' in update || 'llmCache' in update) update.memoryEpoch = data.memoryEpoch + 1;
        await local.set({ ...update, storeRevision: revision + 1 });
        return { ok: true };
      }
      if (message.op === 'memory') {
        if ((message.epoch ?? 0) !== data.memoryEpoch) return { ok: true, discarded: true };
        for (const [key, v] of Object.entries(message.seen || {})) {
          if (!D.model.parseAccountKey(key) || !Array.isArray(v.k)) continue;
          const old = data.seen[key], pages = [...new Set([...v.k,...(old?.k || [])])].slice(0,6);
          data.seen[key] = { ...v, k: pages, c: Math.max(v.c || 0, old?.c || 0, pages.length) };
        }
        for (const [key, v] of Object.entries(message.llm || {})) if (D.model.parseAccountKey(key) && (!data.llmCache[key] || v.t >= data.llmCache[key].t)) data.llmCache[key] = v;
        const prune = (obj,max) => Object.fromEntries(Object.entries(obj).sort((a,b) => b[1].t - a[1].t).slice(0,max));
        data.llmCache = Object.fromEntries(Object.entries(data.llmCache).filter(([,v]) => Date.now() - v.t < 7*86400000));
        await local.set({ seen: prune(data.seen,6000), llmCache: prune(data.llmCache,3000), storeRevision: revision+1 });
        return { ok: true };
      }
      throw new Error('Unknown storage operation');
    }); } };
  };
})();
