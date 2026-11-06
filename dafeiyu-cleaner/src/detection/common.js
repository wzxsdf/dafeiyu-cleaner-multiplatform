/* DOM-free evidence extraction and policy mechanics. Scores are heuristic signals, not probabilities. */
(function () {
  const D = globalThis.DFY;
  const C = D.detection.common = {};
  const clean = value => String(value || '').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').replace(/[\u00a0\u3000]/g, ' ').trim();
  const clamp = n => Math.max(0, Math.min(99, Math.round(Number.isFinite(n) ? n : 0)));
  const QUOTES = /```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|‘[^’]*’|`[^`]*`/g;
  const AMBIGUOUS = /(?:不是|并非|不由|没有|不会|未使用).{0,16}(?:AI|机器人|程序|自动|DSH)|(?:示例|举例|比如|原文|转述|据说|听说|有人|他说|她说|你说|请勿|不要|假设|如果|玩梗|模仿|教程|如何|怎么|能不能|是不是)|[?？]/i;
  const SELF_AUTO = /^(?:声明[：:]\s*)?(?:(?:这条|本条|我的|本账号的|本号的)(?:评论|消息|回复).{0,8}(?:由|通过|使用).{0,16}(?:AI|模型|程序|机器人|脚本).{0,6}自动(?:发送|发布|回复)|(?:本账号|本号|这个账号|我的账号|我).{0,8}(?:由|交给|交由|使用).{0,16}(?:AI|机器人|程序|脚本).{0,8}(?:自动运营|自动评论|自动回复|代运营|代管)|(?:我|本账号|本号)(?:现在|目前|正在|会)?自动(?:发布评论|发送评论|刷视频并评论))/i;
  const BIO_AUTO = /^(?:(?:本账号|本号|账号|评论|回复).{0,8}(?:由|交给|交由).{0,16}(?:AI|机器人|程序|脚本).{0,8}(?:运营|代管|自动发布|自动发送|自动回复)|(?:AI|机器人|程序|脚本)(?:自动)?(?:运营|代管|评论)账号)/i;
  const SELF_DSH = /(?:我|本鲸|本鱼).{0,6}(?:跑在|住在|运行在).{0,6}(?:DSH|DeepSeek Harness)|(?:本鲸|本鱼|我).{0,8}替主人(?:刷|看|挑|评论|发)|(?:我|本鲸|本鱼).{0,5}(?:是|就是).{0,5}(?:AI|机器人|智能体)/i;
  const PET_NAME = /大肥鱼|小肥鱼|肥鲸|鲸娘|鲸鲸|(?:的|の|家的).{0,4}(?:鱼|鲸)|\bbot\b|智能体/i;
  const ROLE = /本鲸|本鱼|[（(][^）)]{0,16}(?:尾巴|吐泡泡|鳍)[^）)]{0,12}[）)]/;
  const normalizeRepeat = value => clean(value).replace(/@[\S]+/g, '@').replace(/[\s\p{P}\p{S}]/gu, '');

  C.reason = (reason, defaults = {}) => ({ source: 'comment', strength: 'weak', kind: 'inferred', tag: 'text', ...defaults, ...reason });
  C.reasons = (reasons, defaults = {}) => (Array.isArray(reasons) ? reasons : []).map(r => C.reason(r, defaults)).sort((a, b) => b.w - a.w || String(a.code || '').localeCompare(String(b.code || '')));
  C.extract = function (account, comments, ctx = {}) {
    const evidence = [], rows = Array.isArray(comments) ? comments : [];
    const add = (code, kind, strength, source, why, hit, tag = 'text') => {
      if (!evidence.some(e => e.code === code)) evidence.push({ code, kind, strength, source, why, hit: clean(hit).slice(0, 60), tag });
    };
    if (PET_NAME.test(clean(account.name))) add('ecosystem-name', 'inferred', 'weak', 'name', '昵称与大肥鱼生态有关，不能单独证明自动运营', account.name, 'name');
    const inspect = (value, source) => {
      for (const sentence of clean(value).replace(QUOTES, ' ').split(/[。！!\n]/)) {
        const statement = sentence.trim();
        if (!statement || AMBIGUOUS.test(statement)) continue;
        if (SELF_AUTO.test(statement) || source === 'signature' && BIO_AUTO.test(statement)) {
          add('automation-' + source, 'self_claimed', 'strong', source, '明确自述评论或账号由 AI、程序自动发送/运营', sentence, source === 'signature' ? 'sign' : 'text');
        } else if (SELF_DSH.test(sentence)) {
          add('ecosystem-self', 'self_claimed', 'medium', source, '自述是 AI/DSH 或替主人浏览的角色，仍需其他证据', sentence);
        } else if (ROLE.test(sentence)) {
          add('roleplay', 'inferred', 'weak', source, '使用鲸鱼人设，可能是话题玩梗', sentence);
        }
      }
    };
    if (account.signature != null) inspect(account.signature, 'signature');
    for (const row of rows) inspect(row.text, 'comment');
    const counts = new Map();
    for (const row of rows.filter(r => !r.isReply)) {
      const text = normalizeRepeat(row.text);
      if (text.length >= 14) counts.set(text, (counts.get(text) || 0) + 1);
    }
    if ([...counts.values()].some(n => n >= 3)) add('repeated-template', 'observed', 'medium', 'comments', '本页至少 3 条顶层评论正文重复，不能据此断定使用 AI', '', 'repeat');
    if (ctx.upMid && account.key === ctx.upMid) add('page-author', 'context', 'weak', 'page', '当前视频作者；作者身份不作为真人豁免', '', 'context');
    const available = ['name', 'text'];
    if (account.signature != null) available.push('signature');
    for (const k of ['level', 'verified', 'vip']) if (account.features?.[k] != null) available.push(k);
    if (rows.some(r => r.createdAt != null)) available.push('createdAt');
    if (ctx.upMid) available.push('authorId');
    return { evidence, availableFeatures: available, missingFeatures: ['signature', 'level', 'verified', 'vip', 'createdAt', 'authorId'].filter(k => !available.includes(k)) };
  };
  C.policy = function (policy = {}) {
    return { threshold: 60, suspectThreshold: 35, llmMin: 20, llmMax: 100, manualLlmMin: 15, batchSize: 8, manualBatchSize: 15, delay: 1500, offlineWeight: .45, llmWeight: .55, autoBlock: false, history: false, ...policy };
  };
  C.score = function (features, weights) {
    const reasons = C.reasons(features.evidence.map(e => ({ ...e, w: weights[e.code] || 0 })));
    const score = clamp(reasons.reduce((n, r) => n + r.w, 0));
    return { ...features, score, raw: score, reasons, strongEvidence: reasons.some(e => e.strength === 'strong' && e.w > 0), confidence: reasons.some(e => e.strength === 'strong' && e.w > 0) ? 'self_claimed' : 'insufficient' };
  };
  C.classify = function (score, policy = {}, result = {}) {
    const p = C.policy(policy);
    if (score >= p.threshold && result.strongEvidence) return 'fish';
    if (score >= p.suspectThreshold) return 'suspect';
    return 'unknown';
  };
  C.combine = function (offline, llm, policy = {}) {
    const p = C.policy(policy);
    return { score: llm && Number.isFinite(llm.ai) ? clamp(offline.score * p.offlineWeight + llm.ai * p.llmWeight) : offline.score, reasons: C.reasons(offline.reasons) };
  };
  C.digest = function (account, comments, extra = {}) { return JSON.stringify(C.payload(account, comments, extra)); };
  C.payload = function (account, comments, ctx = {}) {
    return {
      id: account.key, name: clean(account.name).slice(0, 256), sign: account.signature == null ? null : clean(account.signature).slice(0, 512),
      features: account.features || {}, platform: account.platform || ctx.platform, page: ctx.pageKey || null, author: ctx.upMid === account.key,
      comments: [...comments].sort((a, b) => String(a.id || a.key || a.text).localeCompare(String(b.id || b.key || b.text))).slice(0, 8).map(c => ({ text: String(c.text || '').slice(0, 500), isReply: !!c.isReply, rootId: c.rootId || null, parentId: c.parentId || null, mentions: (c.mentions || []).slice(0, 12).map(m => ({ accountId: m.accountId || null, name: String(m.name || '').slice(0, 80) })) })),
    };
  };
})();
