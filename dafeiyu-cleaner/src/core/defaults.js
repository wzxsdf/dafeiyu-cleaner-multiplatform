/* Shared defaults, loaded before either storage client or owner. */
(function () {
  const DFY = globalThis.DFY;
  DFY.DEFAULTS = {
    settings: {
      enabled: true,
      mode: 'mark', // mark 只标记 | fold 折叠进白饭碗 | auto 自动赶走
      weapon: 'random', // 赶走时用的武器：random | slap | gatling | broom | sock | rice
      threshold: 60, // 大于等于此分数判定为大肥鱼
      quiet: false, // 极简模式：不出场、不出声、不播动画，大肥鱼评论直接隐藏
      hideAtFish: false, // 连 @ 大肥鱼的评论一起隐藏
      showMascot: true,
      mascotSize: 100, // 页面上鲸鱼娘的大小（%）
      sound: true,
      llmEnabled: false,
      llmKey: '',
      llmModel: 'deepseek-flash',
      llmAuto: true, // 自动精判可疑账号
      llmVision: true, // 让 DeepSeek 看头像
      platforms: {},
    },
    stats: { total: 0, today: 0, day: '', chars: 0, snaps: 0, bubbles: 0, pets: 0, verdicts: 0, llmCalls: 0, platforms: {} },
    blocklist: {}, // platform:id -> {platform, id, n, a, t, s, source}
    whitelist: {}, // platform:id -> {platform, id, n, t, source}
    seen: {}, // platform:id -> {n, c: 被认出的页面数, k: 最近几个页面, t}
    llmCache: {}, // platform:id -> {ai, r, t, strategyVersion, digest}
    memoryEpoch: 0, // Clearing memory invalidates pending writes from other tabs.
    mascotPos: null,
    customMascot: '', // 用户自己上传的形象（dataURL，只存本机）
    schemaVersion: 2,
  };

})();
