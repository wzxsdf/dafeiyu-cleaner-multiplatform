# 离线识别评测

`tools/evaluate-detection.cjs` 在没有网络和模型调用的条件下，运行当前 B 站、抖音策略。它评测的是“账号是否由程序自动运营”的线索，不等同于判断某一条文本是否由 AI 生成。

## 样本格式

输入可以是 JSON 数组，也可以是 JSONL。每条样本至少包含 `id`、`platform` 和 `comments`；账号与页面标识必须使用字符串：

```json
{
  "id": "douyin-video-1",
  "platform": "douyin",
  "accountId": "account-pseudonym-1",
  "pageKey": "video-pseudonym-1",
  "name": "账号昵称",
  "signature": "账号签名",
  "label": "automatic",
  "labelSource": {
    "kind": "user-confirmed",
    "basis": "账号运营者确认该账号由脚本自动运营"
  },
  "split": "validation",
  "comments": [{"id": "comment-1", "text": "本账号由脚本自动运营。"}]
}
```

`label` 只能是 `automatic`、`human` 或 `unknown`。`automatic` 和 `human` 必须提供 `labelSource.kind` 与非空 `basis`；真实标注还必须提供 `accountId` 和 `pageKey`。支持的来源类型包括 `synthetic`、`user-confirmed`、`controlled-account`、`manual-review` 和 `documented`。脚本会拒绝格式错误、重复样本/评论 ID，以及同一平台的账号或页面跨 split 泄漏，不会静默跳过坏行。

## 运行

```sh
node tools/evaluate-detection.cjs samples.json
node tools/evaluate-detection.cjs samples.json --json
```

报告包含数据集摘要及 SHA-256、运行时和策略源码 SHA-256、版本与门槛、按平台/证据代码/split 的结果、每条样本的预测和错误列表。预测是 `fish`、`suspect` 或 `unknown`，其中后两者都不会被当成强确认。

报告使用 3×3 的真实标签 × 预测矩阵。`unknown` 标签会从精确率、召回率和误伤率分母排除；`abstainRate` 仍报告所有行中的拒判比例。`fishPrecision`/`fishRecall` 只把 `fish` 当作命中，`candidate*` 指标把 `fish` 与 `suspect` 合并。混淆矩阵中的 `tn` 仅表示真人标注没有被预测为 `fish`，不表示程序已经确认其为真人。证据分组可以重叠，不能把各组行数相加当作数据集大小。

仓库中的 `tests/fixtures/detection-synthetic.json` 只有 5 条构造样本，用于演示脚本和边界（其中抖音短回复故意展示漏判）；它不是线上观测。当前没有提交经过独立来源核验的真实 B 站/抖音标注集，因此不能据此宣称真实准确率。进入校准阶段时，应使用去标识化账号和页面 ID，按账号与页面隔离 split，并保留每条标签的确认依据。

