/* Douyin desktop DOM contract, verified against the video modal and detail page. */
(function () {
  const D = globalThis.DFY;
  const ITEM = '[data-e2e="comment-item"]';
  const profileId = value => {
    try {
      const url = new URL(value, 'https://www.douyin.com');
      if (!['http:', 'https:'].includes(url.protocol) || !['www.douyin.com', 'douyin.com'].includes(url.hostname)) return null;
      return url.pathname.match(/^\/user\/([A-Za-z0-9_-]+)\/?$/)?.[1] || null;
    } catch { return null; }
  };
  const activeVideo = () => typeof document === 'undefined' ? null : document.querySelector('[data-e2e="feed-active-video"]');
  const own = (el, selector) => [...el.querySelectorAll(selector)].find(node => node.closest(ITEM) === el) || null;
  const infoOf = el => el ? own(el, '.comment-item-info-wrap') : null;
  const textOf = node => {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
    if (node.tagName === 'BR') return '\n';
    return [...node.childNodes].map(textOf).join('');
  };
  const A = D.douyin = {
    id: 'douyin', name: '抖音', homeUrl: 'https://www.douyin.com/',
    matches(url) { return ['www.douyin.com', 'douyin.com'].includes(url.hostname); },
    getCapabilities() { return { comments: true, replies: true, stableAccountId: true, stableCommentId: true, mentions: true, profileInspection: false, avatarAnalysis: false, commentAnimation: false }; },
    activeVideo,
    getPageContext(url = new URL(location.href)) {
      const modal = url.searchParams.get('modal_id');
      const direct = url.pathname.match(/^\/video\/(\d+)(?:\/|$)/)?.[1];
      const feed = activeVideo()?.getAttribute('data-e2e-vid');
      const video = /^\d+$/.test(modal || '') ? modal : direct || (/^\d+$/.test(feed || '') ? feed : null);
      return { platform: this.id, pageKey: video ? 'video:' + video : 'page:' + url.pathname, type: video ? 'video' : 'other', authorId: null };
    },
    resolveProfileUrl(account) {
      const id = typeof account === 'string' ? account : account?.id;
      return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) ? 'https://www.douyin.com/user/' + id : null;
    },
    resolveAvatarUrl(account) { return D.model.httpUrl(typeof account === 'string' ? account : account?.avatarUrl); },
    hitTestComment(target) { return this.comments.hitTest(target); },
  };
  A.comments = {
    host() {
      const video = activeVideo(), context = A.getPageContext();
      if (context.type !== 'video') return null;
      const mounted = video?.getAttribute('data-e2e-vid');
      if (mounted && 'video:' + mounted !== context.pageKey) return null;
      return (video || document).querySelector('[data-e2e="comment-list"]');
    },
    infoOf,
    identity(el) {
      const info = infoOf(el);
      const id = info?.querySelector('[data-e2e="video-comment-more"] [id^="tooltip_"]')?.id.match(/^tooltip_(\d+)$/)?.[1];
      return id || null;
    },
    read(el, pageKey) {
      const info = infoOf(el), id = this.identity(el);
      if (!info || !id) return null;
      const link = info.querySelector('a[href*="/user/"]');
      const uid = profileId(link?.getAttribute('href'));
      const nameNode = link?.querySelector?.('[data-click-from="title"]');
      const name = textOf(nameNode || link);
      const isAuthor = [...(link?.querySelectorAll?.('.comment-item-tag-text') || [])].some(node => textOf(node).trim() === '作者');
      let body = info.nextElementSibling;
      while (body?.matches('.dfy-b,.dfy-lock,style[data-dfy]')) body = body.nextElementSibling;
      if (!body || body.matches('.comment-item-stats-container') || body.contains(info)) return null;
      const avatar = own(el, '.comment-item-avatar img');
      const parent = el.parentElement?.closest(ITEM);
      const mentions = [...body.querySelectorAll('a[href*="/user/"]')].map(a => ({ accountId: profileId(a.getAttribute('href')), name: textOf(a).replace(/^@/, '') }));
      return {
        account: uid ? { platform: A.id, id: uid, name, avatarUrl: avatar?.getAttribute('src') || null, profileUrl: A.resolveProfileUrl(uid), signature: null, features: {} } : null,
        comment: { platform: A.id, pageKey, id, accountId: uid, text: textOf(body), rootId: parent ? this.identity(parent) : null, parentId: null, isReply: !!parent, isAuthor, mentions, createdAt: null },
      };
    },
    eachRenderer(cb) { for (const el of this.host()?.querySelectorAll(ITEM) || []) cb(el, this.isReply(el)); },
    partsOf(el) { const root = infoOf(el)?.parentElement; return root ? { root, host: root } : null; },
    userInfo(el) { return infoOf(el); },
    accountHref(el) { return infoOf(el)?.querySelector('a[href*="/user/"]')?.getAttribute('href') || ''; },
    foldIndent: '0',
    highlightCSS: '.dfy-b{display:flex;flex-wrap:wrap;margin:4px 0;gap:4px}.dfy-b[data-l="unassessed"] .dfy-tag{background:#e9efff;color:#2546b8}',
    avatarOf(el) { return el ? own(el, '.comment-item-avatar img') : null; },
    isReply(el) { return !!el?.parentElement?.closest(ITEM); },
    isRenderer(el) { return !!el?.matches?.(ITEM); },
    hitTest(target) { const el = target?.closest?.(ITEM); return el && this.host()?.contains(el) ? el : null; },
  };
  D.platforms.register(A);
})();
