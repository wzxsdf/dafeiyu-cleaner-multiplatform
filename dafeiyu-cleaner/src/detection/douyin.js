/* Douyin policy: missing fields are unknown; video labels and personas are not account proof. */
(function () {
  const D = globalThis.DFY, C = D.detection.common;
  D.detection.register('douyin', {
    version: 'douyin-evidence-v1', llm: false,
    getPolicy() { return C.policy({ threshold: 80, suspectThreshold: 40 }); },
    digest(account, comments, ctx) { return C.digest(account, comments, ctx); },
    judge(account, comments, ctx) {
      return C.score(C.extract(account, comments, ctx), { 'automation-comment': 80, 'automation-signature': 80, 'ecosystem-self': 40, 'ecosystem-name': 12, roleplay: 8, 'repeated-template': 15 });
    },
    classify(score, result) { return C.classify(score, this.getPolicy(), result); },
    combine(result) { return { score: result.score, reasons: result.reasons }; },
    shouldRemember() { return false; },
  });
})();
