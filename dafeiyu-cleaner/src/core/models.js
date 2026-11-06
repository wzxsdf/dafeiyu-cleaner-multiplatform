/* Shared, DOM-free protocol and identity helpers. IDs are always opaque strings. */
(function () {
  const D = (globalThis.DFY = globalThis.DFY || {});
  const platforms = new Map();
  const text = (v, max = 4096) => typeof v === 'string' ? v.slice(0, max) : '';
  const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f]/.test(v) ? v : null;
  D.model = {
    protocol: 2,
    id,
    text,
    accountKey(platform, value) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(platform) || !id(value)) throw new Error('Invalid account identity');
      return platform + ':' + encodeURIComponent(value);
    },
    parseAccountKey(key) {
      if (typeof key !== 'string') return null;
      const at = key.indexOf(':');
      if (at < 1) return null;
      try {
        const platform = key.slice(0, at), value = decodeURIComponent(key.slice(at + 1));
        return this.accountKey(platform, value) === key ? { platform, id: value } : null;
      } catch (e) { return null; }
    },
    commentKey(platform, pageKey, value) { return JSON.stringify([platform, pageKey, value]); },
    pageKey(platform, page) { return JSON.stringify([platform, page]); },
    httpUrl(value) {
      try { const u = new URL(value); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch (e) { return null; }
    },
    normalizeBatch(packet, context) {
      if (!packet || packet.protocolVersion !== 2 || packet.platform !== context.platform || packet.pageKey !== context.pageKey || packet.sessionId !== context.sessionId || !Array.isArray(packet.comments) || !Array.isArray(packet.accounts)) return null;
      if (packet.comments.length > 1000 || packet.accounts.length > 1000) return null;
      const accounts = new Map();
      for (const a of packet.accounts) {
        if (!a || a.platform !== context.platform || !id(a.id)) continue;
        const features = {};
        if (Number.isFinite(a.features?.level)) features.level = a.features.level;
        if (typeof a.features?.verified === 'boolean') features.verified = a.features.verified;
        if (typeof a.features?.vip === 'boolean') features.vip = a.features.vip;
        accounts.set(a.id, { platform: context.platform, id: a.id, key: this.accountKey(context.platform, a.id), name: text(a.name, 256), avatarUrl: this.httpUrl(a.avatarUrl), profileUrl: this.httpUrl(a.profileUrl), signature: a.signature == null ? null : text(a.signature, 2048), features });
      }
      const comments = [];
      for (const c of packet.comments) {
        if (!c || !id(c.id) || c.platform !== context.platform || c.pageKey !== context.pageKey || typeof c.text !== 'string') continue;
        const accountId = id(c.accountId);
        comments.push({ platform: context.platform, pageKey: context.pageKey, id: c.id, key: this.commentKey(context.platform, context.pageKey, c.id), accountId, accountKey: accountId && accounts.has(accountId) ? this.accountKey(context.platform, accountId) : null, text: text(c.text, 20000), rootId: id(c.rootId), parentId: id(c.parentId), isReply: !!c.isReply, isAuthor: c.isAuthor === true, mentions: (Array.isArray(c.mentions) ? c.mentions : []).slice(0, 100).map(m => ({ accountId: id(m?.accountId), name: text(m?.name, 256) })), createdAt: Number.isFinite(c.createdAt) ? c.createdAt : null });
      }
      return { accounts: [...accounts.values()], comments, authorId: id(packet.authorId) };
    },
  };
  D.platforms = {
    register(adapter) {
      if (!adapter || platforms.has(adapter.id) || typeof adapter.matches !== 'function') throw new Error('Invalid or duplicate platform');
      platforms.set(adapter.id, adapter);
    },
    get(id) { return platforms.get(id) || null; },
    match(url) { const u = url instanceof URL ? url : new URL(url); return [...platforms.values()].find(a => a.matches(u)) || null; },
    all() { return [...platforms.values()]; },
  };
  D.detection = {
    strategies: new Map(),
    register(platform, strategy) { this.strategies.set(platform, strategy); },
    get(platform) { return this.strategies.get(platform) || null; },
    unassessed() { return { status: 'unassessed', score: null, level: null, reasons: [], strategyVersion: null }; },
  };
})();
