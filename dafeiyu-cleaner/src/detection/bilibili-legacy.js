/* Bilibili evidence policy, shared by comments and profile reports. */
(function () {
  const D = globalThis.DFY, C = D.detection.common;
  D.detection.register('bilibili', {
    version: 'bilibili-evidence-v1', llm: true, llmPromptVersion: 'comments-evidence-v1',
    getPolicy(ctx = {}) { return C.policy({ threshold: Number.isFinite(ctx.threshold) ? Math.max(60, ctx.threshold) : 60, suspectThreshold: 35 }); },
    digest(account, comments, ctx) { return C.digest(account, comments, ctx); },
    payload(account, comments, ctx) { return C.payload(account, comments, ctx); },
    judge(account, comments, ctx) {
      return C.score(C.extract(account, comments, ctx), { 'automation-comment': 70, 'automation-signature': 70, 'ecosystem-self': 40, 'ecosystem-name': 15, roleplay: 10, 'repeated-template': 15 });
    },
    classify(score, result, ctx) { return C.classify(score, this.getPolicy(ctx), result); },
    combine(result, llm, ctx) { return C.combine(result, llm, this.getPolicy(ctx)); },
    shouldRemember() { return false; },
  });
})();
