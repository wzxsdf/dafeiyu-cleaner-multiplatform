/* Both worlds and the popup use the same platform URL and image rules. */
(function () {
  const D = globalThis.DFY;
  D.bilibili = {
    id: 'bilibili', name: 'B 站', homeUrl: 'https://www.bilibili.com/',
    getCapabilities() { return { comments: true, replies: true, stableAccountId: true, stableCommentId: true, mentions: true, profileInspection: true, avatarAnalysis: true, commentAnimation: true }; },
    matches(url) { return /(^|\.)bilibili\.com$/.test(url.hostname) && !/^(live|message|passport|member)\./.test(url.hostname); },
    profileId(url) { return url.hostname === 'space.bilibili.com' ? (url.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] || '') : ''; },
    getPageContext(url = new URL(location.href)) {
      const profile = this.profileId(url);
      const video = url.pathname.match(/(?:BV[\w]{10}|av\d+|ep\d+|ss\d+)/i)?.[0];
      const part = url.searchParams.get('p') || '1';
      return { platform: this.id, pageKey: profile ? 'profile:' + profile : video ? 'video:' + video + ':p' + part : 'page:' + url.hostname + url.pathname, type: profile ? 'profile' : video ? 'video' : 'other', authorId: null };
    },
    profileUrl(id) { return /^\d+$/.test(id) ? 'https://space.bilibili.com/' + id : null; },
    resolveProfileUrl(account) { return this.profileUrl(account?.id || account); },
    resolveAvatarUrl(account, purpose = 'badge') { return this.avatarUrl(account?.avatarUrl || account?.avatar || account, purpose); },
    hitTestComment(target) { return this.comments.hitTest(target); },
    avatarUrl(url, purpose = 'badge') {
      const safe = D.model.httpUrl(url);
      if (!safe) return null;
      const u = new URL(safe);
      if (/(^|\.)hdslb\.com$/.test(u.hostname)) {
        u.protocol = 'https:';
        u.pathname = u.pathname.split('@')[0] + (purpose === 'analysis' ? '@48w_48h.png' : purpose === 'vision' ? '@128w_128h.jpg' : '@52w_52h.webp');
      }
      return u.href;
    },
    legacyPage(page) {
      if (/^(?:BV\w{10}|av\d+|ep\d+|ss\d+)$/i.test(page)) return 'video:' + page + ':p1';
      return null; // Old numeric paths are ambiguous; do not invent history.
    },
  };
  D.bilibili.comments = {
    highlightCSS: `
:host([dfy-level="fish"]) #body{position:relative;border-radius:10px;background:radial-gradient(rgba(255,93,138,.16) 1.2px,transparent 1.4px) 0 0/8px 8px,linear-gradient(90deg,rgba(255,93,138,.10),rgba(255,93,138,0) 70%);box-shadow:inset 4px 0 0 #ff5d8a}
:host([dfy-level="suspect"]) #body{border-radius:10px;background:linear-gradient(90deg,rgba(232,154,28,.10),rgba(232,154,28,0) 60%);box-shadow:inset 4px 0 0 #f2b544}
:host([dfy-q][dfy-level]) #body{background:none}
`,
    host() { return document.querySelector('bili-comments'); },
    eachRenderer(cb) {
      for (const bc of document.querySelectorAll('bili-comments')) {
        if (!bc.shadowRoot) continue;
        for (const th of bc.shadowRoot.querySelectorAll('bili-comment-thread-renderer')) {
          cb(th, false);
          const rep = th.shadowRoot && th.shadowRoot.querySelector('bili-comment-replies-renderer');
          if (rep?.shadowRoot) for (const r of rep.shadowRoot.querySelectorAll('bili-comment-reply-renderer')) cb(r, true);
        }
      }
    },
    partsOf(el, isReply) {
      if (isReply) return { root: el.shadowRoot, host: el };
      const cr = el.shadowRoot?.querySelector('bili-comment-renderer');
      return cr?.shadowRoot ? { root: cr.shadowRoot, host: cr } : null;
    },
    avatarOf(el, isReply) {
      const p = this.partsOf(el, isReply); if (!p) return null;
      const ui = p.root.querySelector('bili-comment-user-info');
      return p.root.querySelector('#user-avatar') || (ui?.shadowRoot?.querySelector('#user-avatar')) || p.root.querySelector('bili-avatar');
    },
    userInfo(el, isReply) { return this.partsOf(el, isReply)?.root?.querySelector('bili-comment-user-info') || null; },
    isReply(el) { return el?.tagName === 'BILI-COMMENT-REPLY-RENDERER'; },
    isRenderer(el) { return !!el && /^(BILI-COMMENT-(THREAD|REPLY)-RENDERER)$/.test(el.tagName); },
    hitTest(el) {
      for (let p = el, i = 0; p && i < 40; p = p.parentElement || p.getRootNode?.().host, i++) if (this.isRenderer(p)) return p;
      return null;
    },
  };
  D.platforms.register(D.bilibili);
})();
