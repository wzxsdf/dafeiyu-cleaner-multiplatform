# 平台适配器接入说明

本文描述已经落地的接口。真实平台实现包括 `src/platforms/bilibili/` 和 `src/platforms/douyin/`；抖音 DOM 证据与能力边界见 [抖音接入说明](DOUYIN_ADAPTER.md)。

## 1. 注册与加载

在平台文件中调用 `DFY.platforms.register(adapter)`，注册发生在 `platform-registry.js` 之前。匹配使用 URL 对象：

```js
DFY.platforms.register({
  id: 'example',
  matches(url) { return url.hostname === 'video.example.com'; },
  getPageContext(url = new URL(location.href)) {
    // 根据已验证的作品身份生成 pageKey，不能仅依赖 pathname。
    return { platform: 'example', pageKey: 'video:' + readVideoId(url), type: 'video', authorId: null };
  },
  getCapabilities() { /* 返回当前平台实际具备的能力 */ },
  start(session, sink, signal) { /* 安装监听，再发送初始标准数据 */ },
  rescan() { /* 重新采集，结果仍经 sink.comments 发送 */ },
  getBinding(commentKey) { /* 返回有效绑定或 null */ },
  dispose() { /* 幂等停止监听、清理绑定 */ },
  comments: { /* 下文的 DOM 接口 */ },
});
```

示例中的 `readVideoId` 需要平台实现；不能直接用作抖音采集器。`start` 收到的 session 含 platform、pageKey、唯一 sessionId、AbortSignal；页面改变后核心会废弃整个会话。适配器观察到同路径视频切换时，应调用 `DFY.checkRoute()` 触发上下文比较。

能力字段：`comments`、`replies`、`stableAccountId`、`stableCommentId`、`mentions`、`profileInspection`、`avatarAnalysis`、`commentAnimation`。主页能力可选，通过 `createProfile(session)` 提供，不能成为评论区启动的条件。

## 2. 数据与消息

原始批次必须包含以下信封，并通过 `DFY.model.normalizeBatch(packet, session)` 校验，再将返回值交给 `sink.comments(batch)`：

```js
{
  protocolVersion: 2,
  platform: session.platform,
  pageKey: session.pageKey,
  sessionId: session.sessionId,
  authorId: null,
  accounts: [{ platform: 'example', id: 'opaque-string', name: '昵称', features: {} }],
  comments: [{
    platform: 'example', pageKey: session.pageKey, id: 'comment-string',
    accountId: 'opaque-string', text: '正文', isReply: false,
    rootId: null, parentId: null, mentions: [], createdAt: null,
  }],
}
```

校验器生成账号 `key` 和评论 `key/accountKey`，过滤非法记录，并保留缺失字段语义。一批最多 1000 个账号及 1000 条评论。账号 ID 必须是不透明字符串，禁止把抖音长 ID 转成 JS Number；没有账号 ID 时使用 `accountId: null`，禁止用昵称代替。时间统一毫秒。

纯 DOM 采集可在隔离世界直接构造和校验批次；只有隔离世界确实无法读取数据时才增加 MAIN 脚本。MAIN 只发送评论数据，不接触设置或密钥。B 站实现还检查消息来源窗口、当前 URL 和会话，重复数据只触发 `sink.bindingsChanged()` 重新绑定 DOM。

## 3. DOM 接口

当前 `comments.js` 保留公共标记、折叠条和动画编排，通过 `adapter.comments` 操作节点：

| 接口 | 返回或职责 |
| --- | --- |
| `host()` | 当前评论区元素；未加载时 null，用于隐藏记录和战报挂载 |
| `eachRenderer(callback)` | 遍历已加载评论，调用 `(element, isReply)`；同时清理失效绑定 |
| `isReply(element)` / `isRenderer(element)` | 判断回复、评论容器 |
| `partsOf(element, isReply)` | 平台内部使用的 `{ root, host }` |
| `binding(element, isReply)` | 返回当前有效绑定；无节点/无身份时 null |
| `bindingKey(element)` | 统一评论键 |
| `userInfo(element, isReply)` | 标签插入到该元素之后；无挂载点返回 null |
| `avatarOf(element, isReply)` | 动画头像定位；无头像返回 null |
| `hitTest(target)` | 从普通节点或 Shadow DOM 内部命中评论容器 |
| `foldIndent` | 可选的顶层折叠条缩进，抖音为 `0` |
| `highlightCSS` | 可选的平台高亮 CSS；B 站的 `:host` / `#body` 规则在此处 |

绑定至少提供 `el/root/host/body/key/id/sessionId/generation`、`valid()`、`setStyle/restoreStyle`、`setAttribute/restoreAttribute`、`track(node)`，以及 `animations` 和 `cleanups` 集合。`root` 可以是 ShadowRoot 或普通元素，不要求新平台使用 Web Components；每条评论应有独立挂载作用域。

节点复用、root 替换、脱离文档或会话结束时，旧绑定必须失效。清理需要取消动画、执行观察器清理、移除注入节点、还原仍由插件控制的样式与属性。隐藏/撤销保存原绑定，不能根据同一个 DOM 节点临时找回新评论。按原评论键撤销逻辑状态；原节点失效时，由重新挂载的同键评论在渲染时恢复，禁止恢复已经承载其他评论的节点。两平台实现和回归测试可作参考。

另外提供 `resolveAvatarUrl(account,purpose)`、`resolveProfileUrl(account)` 以及 `hitTestComment(target)`；当前命中结果是评论元素。平台图片地址改写必须在适配器内完成。

## 4. 策略、设置与名单

不注册识别策略也可以完成采集、显示“暂未判定”、手动隐藏和恢复。需要判定时另行注册 `DFY.detection.register(platform,strategy)`，禁止把 B 站等级、昵称权重或后台提示词直接用于新平台。当前后台只接受 B 站模型请求。

名单通过 `store.listAction(account.key,entry,action)` 原子更新，action 为 block/white/unblock/unwhite。没有稳定账号 ID 的评论不能持久入名单。`settings.platforms[platform]` 可覆盖该平台设置；新平台默认只标记、关闭关联隐藏。`stats.platforms` 存放平台分项战绩。

## 5. 与目标设计的阶段差异

第 1 期继续保留 `comments.js`，尚未拆成 controller/view 两个文件；检测注册表位于 `core/models.js`。初始采集与重扫使用 `start/rescan`，尚未额外开放 `collectSnapshot()`；命中函数返回元素。公共视图当前需要上述 DOM 辅助接口。第 2 期已以抖音实测验证普通 DOM 可复用这一接口，后续可进一步收敛到设计中的挂载/隐藏方法。

manifest 的 `content_scripts`、资源 matches、面板脚本顺序需在接入新平台时同步调整；有实际需求才增加 host permission。变更后运行 `node --test tests/*.test.cjs`，并完成真实页面的切换、回复展开、面板重开、节点复用和隐藏/恢复验证。
