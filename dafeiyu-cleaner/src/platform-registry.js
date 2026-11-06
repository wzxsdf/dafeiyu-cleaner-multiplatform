/* Platform registry and page context. Platform-specific selectors remain in adapters. */
(function () {
  const D = globalThis.DFY;
  const adapter = D.platforms.match(new URL(location.href));
  if (!adapter) return;
  D.platform = adapter;
  D.platformContext = adapter.getPageContext(new URL(location.href));
  D.platformStatus = { state: 'waiting', platform: adapter.id, capabilities: adapter.getCapabilities ? adapter.getCapabilities() : {} };
  D.refreshPlatformContext = function () {
    const next = adapter.getPageContext(new URL(location.href));
    const changed = !D.platformContext || next.pageKey !== D.platformContext.pageKey || next.type !== D.platformContext.type || next.authorId !== D.platformContext.authorId;
    if (changed) D.platformContext = next;
    return changed;
  };
})();
