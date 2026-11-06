/* One controller per page session. A -> B -> A always has three distinct IDs. */
(function () {
  const D = globalThis.DFY;
  D.createSession = function (adapter, context) {
    const abort = new AbortController(), timers = new Map(), cleanups = new Set();
    const session = {
      ...context, sessionId: globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random(), adapter, signal: abort.signal,
      active: () => !abort.signal.aborted,
      assert() { if (abort.signal.aborted) throw new DOMException('Page session ended', 'AbortError'); },
      async wait(value) { const result = await value; session.assert(); return result; },
      later(fn, ms) {
        if (!session.active()) return 0;
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (session.active()) Promise.resolve().then(() => { if (session.active()) return fn(); }).catch(error => { if(error.name !== 'AbortError') console.warn('[DFY] Scheduled action failed',error); });
        }, ms);
        timers.set(timer, null); return timer;
      },
      sleep(ms) {
        if (!session.active()) return Promise.reject(new DOMException('Page session ended', 'AbortError'));
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
          timers.set(timer, reject);
        });
      },
      cleanup(fn) { cleanups.add(fn); return () => cleanups.delete(fn); },
      dispose() {
        if (!session.active()) return;
        abort.abort();
        for (const [timer, reject] of timers) { clearTimeout(timer); reject?.(new DOMException('Page session ended', 'AbortError')); }
        timers.clear();
        for (const fn of cleanups) { try { fn(); } catch (e) { console.warn('[DFY] Cleanup failed', e); } }
        cleanups.clear();
      },
    };
    return session;
  };
})();
