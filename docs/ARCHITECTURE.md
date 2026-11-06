# 架构说明

插件是 Chromium MV3 扩展，纯原生 JavaScript，没有构建步骤。插件本体在 `dafeiyu-cleaner/`，加载这个文件夹即可调试。第一版收口为 Edge/Chrome 的 B 站普通视频和抖音直接视频评论；文末 Firefox 方案保留为后续记录，尚未经浏览器验收。

多平台扩展的目标架构、接口约定与分期验收见 [多平台适配设计与分期计划](MULTI_PLATFORM_DESIGN.md)。当前已实现 B 站适配迁移和抖音桌面评论区最小闭环。抖音使用本地名单和手动处理，AI 判定留待后续专项。实现进展与待验收项目见 [改造进度](MULTI_PLATFORM_PROGRESS.md)。

## 目录

```
dafeiyu-cleaner/
├── manifest.json
├── src/
│   ├── core/models.js       跨平台协议、身份键和数据校验（适配底座）
│   ├── core/page-session.js 页面会话、切换与异步任务失效
│   ├── platform-registry.js 当前平台注册与页面上下文
│   ├── platforms/bilibili/shared.js B 站 URL、评论节点与头像规则
│   ├── platforms/bilibili/adapter.js 评论数据桥接、DOM 绑定与清理
│   ├── platforms/bilibili/main-world.js 主世界读取 .data 并输出统一协议
│   ├── platforms/douyin/shared.js 抖音作品上下文、DOM 字段与能力声明
│   ├── platforms/douyin/adapter.js 隔离世界 DOM 采集、监听与节点生命周期
│   ├── core/defaults.js / storage-engine.js 默认值、迁移与串行存储 owner
│   ├── core/list-codec.js 名单导入的统一身份校验
│   ├── detection/bilibili-legacy.js 旧规则的标准数据映射
│   ├── icons.js        线性 SVG 图标 DFY.icon(name)
│   ├── mascot.js       清道夫鲸鱼娘矢量形象 DFY.mascotSVG({face, pose}) 及其动画 CSS
│   ├── memes.js        台词库 DFY.say(key)
│   ├── storage.js      存储客户端、修订号重试、战绩、平台隔离的 DFY.memory
│   ├── detector.js     离线识别引擎
│   ├── fx.js           粒子画布、WebAudio 合成音效、评论退场动画
│   ├── actors.js       被赶走的迷你 DeepSeek 娘（动作图）、鲸鱼娘走位
│   ├── weapons.js      鲸鱼娘的武器
│   ├── ui.js           悬浮鲸鱼娘、对话框、思考框、菜单、通知、提示框、泡泡大炮
│   ├── comments.js     评论区：标记、靶心、赶走、折叠、响指清场、战报、DeepSeek 精判
│   ├── platforms/bilibili/profile.js 可选的空间主页鉴定与页面效果
│   ├── content.js      入口：读设置、挂载 UI、菜单、消息与路由监听
│   └── background.js   后台（Chrome 是 Service Worker，Firefox 是事件页）：DeepSeek 请求、快捷键
├── popup/              工具栏面板，同时作为设置页
├── assets/
│   ├── dfy-display.woff2   标题字体（得意黑子集）
│   ├── actors/*.webp       被赶走的大肥鱼的 8 个动作
│   └── weapons/*.webp      武器图
└── icons/
```

## 脚本加载

`content_scripts` 有两组：

1. `platforms/bilibili/main-world.js` 以 `world: "MAIN"`、`document_start` 注入，因为评论数据挂在 B 站自定义元素的 `.data` 属性上，隔离世界读不到。
2. 其余脚本按 manifest 中的顺序注入隔离世界，共用全局命名空间 `DFY`。**顺序就是依赖顺序**：`ui.js` 在加载时把 `actors.js`、`weapons.js`、`mascot.js` 的 CSS 拼进自己的 shadow DOM，所以它们必须排在 `ui.js` 前面。

页面上所有插件 UI 都在一个 `<dfy-host>` 元素的 shadow DOM 里，不受 B 站样式影响。标题字体的 `@font-face` 必须声明在主文档中（shadow DOM 里声明无效），由 `content.js` 注入。

## 评论区数据流

抖音直接在隔离世界读取已加载 DOM，经标准协议校验交给同一控制器，不注入 MAIN 脚本、不拦截请求。MutationObserver 与低频补扫负责新增评论、回复及节点重建。字段与验证范围见 [抖音接入说明](DOUYIN_ADAPTER.md)。下图中的 MAIN 桥接用于 B 站。

```text
平台注册与页面匹配 → 新页面会话 sessionId → adapter.start
  → B 站主世界读取组件 .data，标记 data-dfy-id
  → postMessage({protocolVersion: 2, platform, pageKey, sessionId, accounts, comments})
  → 隔离世界 adapter 校验协议、当前页面和会话
  → comments.js 按标准账号键归并 → 平台识别策略 → 绑定 DOM 后标记/隐藏
```

B 站采集器包装组件 `connectedCallback` / `updated`，另有 1.5 秒轮询；仅在收到当前会话 `init` 后采集，`stop` 后停止轮询。数据含 `mentions`、可缺失的账号特征及毫秒时间戳。页面消息不包含设置或 API Key。

账号键为 `platform:encodeURIComponent(id)`，评论键为 `[platform,pageKey,id]` 的 JSON 序列化。ID 保持字符串，缺少等级不作为 Lv0。没有稳定账号 ID 时，仅建立本会话的评论状态，不写持久名单、前科或模型缓存。

`content.js` 检测路由变化，创建新会话（A → B → A 也生成不同 ID）。旧会话取消延时、请求和 UI；异步模型结果同时检查会话与输入摘要。DOM 绑定校验评论 ID、节点代次、root 和连接状态；复用时取消动画、移除注入节点，并只恢复插件仍拥有的样式。恢复入口保留原绑定，不能恢复被复用的新评论。

### B 站评论 DOM

全部是 open shadow root：

```
bili-comments
  └─ #shadow-root
       └─ bili-comment-thread-renderer          （.data 是完整的评论 JSON）
            └─ #shadow-root
                 ├─ bili-comment-renderer
                 │    └─ #shadow-root → #body / bili-comment-user-info / #user-avatar
                 └─ bili-comment-replies-renderer
                      └─ #shadow-root → bili-comment-reply-renderer（楼中楼）
```

B 站改版时最先坏的就是这里，相关查询集中在 `platforms/bilibili/shared.js`，绑定与清理在 `adapter.js`，数据读取在同目录的 `main-world.js`。`comments.js` 不再含 B 站节点选择器。

### 空间主页

`platforms/bilibili/profile.js` 调用两个无需签名的公开接口：

- `api.bilibili.com/x/web-interface/card?mid=` 资料卡
- `api.bilibili.com/x/series/recArchivesByKeywords?mid=` 近期投稿（偶尔被风控时降级为只用资料卡）

页面效果依赖的选择器：`.upinfo-avatar`、`.upinfo .nickname`、`.bili-video-card` / `.items__item`。空间页是单页应用，`content.js` 每秒检查一次路由变化。

## 识别

### 离线规则（detector.js / detection/bilibili-legacy.js）

`DFY.detection` 按平台选择策略，B 站策略把标准账号与评论映射到原有规则。未注册策略的平台返回 `unassessed` 并显示“暂未判定”，不套用 B 站等级、头像或提示词，也不自动送模型。`DFY.judge(acc, texts, ctx)` 返回 `{score, raw, reasons}`：

- 账号分 `scoreAccount`：昵称、签名、等级、官方认证、大会员、头像鲸鱼蓝占比（`DFY.avatarBlue` 把头像缩到 32×32 统计色相）
- 评论分 `scoreText`：取该账号在本页最像 AI 的一条；包括自称、括号动作、@ 主人（`ownerLink` 比较 @ 对象和自己昵称的共同部分）、复述视频要点、Markdown 残留等；`isReply` 的评论不触发「开头 @ 人」规则
- 行为分：本页刷多条、每条一个味儿
- 上下文 `ctx`：`upMid`（UP 主本人减分）、`calledOut`（`DFY.callouts` 统计楼中楼里被几个人点名是鱼）、`priorPages`（前科）
- `raw` 不含前科加分；只有 `raw` 达到阈值时才记一笔前科，避免自我强化

`DFY.levelOf(score, threshold)`：`≥ threshold` 为 `fish`，`≥ max(25, threshold − 25)` 为 `suspect`，其余为 `human`。

### DeepSeek 精判（background.js）

- 评论区：离线分 20–85 的不确定账号，每批最多 8 个，附离线分和命中原因；最终分 = 离线 45% + DeepSeek 55%
- 空间页：最终分 = 离线 30% + DeepSeek 70%；deepseek-flash 可附带头像图片
- 请求只发往 `api.deepseek.com`，提示词要求中文思考，思维链（`reasoning_content`）展示在思考框里
- 结果写入 `DFY.memory.llmPut`，缓存 7 天；键包含平台，读取时必须匹配策略版本及输入摘要，旧版本缓存不复用

## 赶走流程

单条赶走（`comments.js` 的 `C.kick`）：

1. 鲸鱼娘走到头像右侧（`actors.approachPoint`）
2. `actors.spawnFish` 在头像位置生成迷你 DeepSeek 娘，`mood` 切换动作图：`caught` → `defiant` / `beg`
3. `weapons.run(weapons.pick(), fish, {onHit})`：武器在决定性一击时调用 `onHit`，评论在这时化灰收起
4. 加入遣返名单、记战绩，通知里提供「放回来」

响指清场（`C.snap`）对视野内最多 10 条播放完整动画，其余直接收起；`settings.weapon` 为 `gatling`（或随机命中）时改为 `weapons.sweep` 点射。

被赶走的一方一律往左边离场，所以鲸鱼娘总是站在目标右边。

### 极简模式（`settings.quiet`）

- `content.js` 不显示鲸鱼娘，空间页不自动跑鉴定
- `ui.say` / `ui.think` / `ui.combo` 和 `fx.emit` / `flash` / `shake`、音效全部静默，所以零散的调用点不用逐个判断
- `comments.js` 里单条赶走、响指、自动清场都改走 `quietHide`：直接收起、写遣返名单、记战绩，不生成动作图
- 标签加 `.q` 扁平样式、不画靶心；折叠条换成一行文字
- 隐藏记录显示在评论区上方的 `<dfy-note>`，颜色用 B 站自己的 CSS 变量（`--text3`、`--brand_blue`），深色主题下也协调；点「显示」会撤销本页的隐藏并把相关账号移出遣返名单

### 隐藏 @ 大肥鱼的评论（`settings.hideAtFish`）

`doRender` 对每条非大肥鱼的评论调用 `atFish`：被 @ 的人（`mentions` 加上正文里的 `@昵称`）满足任意一条即命中——本页判为大肥鱼、在当前平台遣返名单（按账号键或昵称）、有前科、或 `DFY.fishName(昵称)` 为真。白名单里的人不算。命中的评论打上 `data-dfy-at` 并隐藏，计入 `<dfy-note>`；被 @ 的人后来改判为人类时自动恢复。

`DFY.fishName` 只看名字：把「鱼京」还原成「鲸」后跑昵称规则，≥ 40 分或以「的鱼 / 的鲸」结尾即为真。

### 鲸鱼娘大小

`.mascot` 上的 CSS 变量 `--ms` 控制本体、气泡、菜单的尺寸和位置；JS 里需要尺寸的地方统一用 `DFY.ui.size()`，不要写死 132×153。

### 动作图与武器图

| 名字 | 用途 |
| --- | --- |
| `caught` | 刚冒出来被抓包 |
| `scared` | 响指清场时发抖 |
| `defiant` / `beg` | 嘴硬 / 求饶 |
| `flee` | 抱着白饭碗往左跑 |
| `knocked` | 被打飞 |
| `dust` | 响指化成泡沫 |
| `home` | 折叠条、空间页「已遣返」 |

武器：`gatling`、`broom`、`sock`、`rice`。图片都是 240×240 透明 WebP，通过 `chrome.runtime.getURL` 加载，需要在 `web_accessible_resources` 中声明。新增动作时保持同样的尺寸和角色占比，页面上的大小才一致。

## 存储（chrome.storage.local）

| 键 | 内容 |
| --- | --- |
| `settings` | 开关、处理方式 `mode`（mark / fold / auto）、阈值、武器、极简模式 `quiet`、隐藏 @ 大肥鱼 `hideAtFish`、鲸鱼娘大小 `mascotSize`（60–150）、DeepSeek 配置 |
| `stats` | 战绩 |
| `blocklist` | 遣返名单 `platform:id → {platform, id, n, a, t, s, source}` |
| `whitelist` | 人类白名单 `platform:id → {platform, id, n, t, source}` |
| `seen` | 前科记忆 `platform:id → {n, c, k, t}`，k 内页面键也含平台 |
| `llmCache` | 精判缓存 `platform:id → {ai, r, t, strategyVersion, digest}` |
| `mascotPos` | 鲸鱼娘位置（相对视口比例） |
| `customMascot` | 用户上传的形象（dataURL） |

后台 `core/storage-engine.js` 是唯一写入者，内容脚本和面板通过 `store` 消息读写。修改名单使用修订号比较与冲突重试；白名单优先，自动处理不能覆盖已加入白名单的账号。`DFY.memory` 合并本页新增条目，`memoryEpoch` 使用户清空前的待写入记忆失效。

首次读取时迁移旧数据到 schemaVersion 2：先写 `legacyBackupV1`，再提交带平台的名单/记忆。历史纯数字账号归 B 站；无法辨认的视频历史不构造新证据；旧模型缓存标记为过期。迁移失败保留原数据并停止初始化，不静默覆盖。`storeRevision` 用于并发控制，`settings.platforms` 与 `stats.platforms` 保留平台覆盖和分项统计。

## 消息

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| 主世界 → 内容脚本 | `{source: 'dfy-main', type: 'comments', protocolVersion: 2, platform, pageKey, sessionId, accounts, comments}` | 统一评论数据 |
| 内容脚本 → 主世界 | `{source: 'dfy-iso', type: 'init' \| 'rescan' \| 'stop', protocolVersion: 2, platform, pageKey, sessionId}` | 要求重新扫描 |
| 内容脚本 / 面板 → 后台 | `store` | 迁移完成后的读取、事务提交、记忆合并 |
| 内容脚本 → 后台 | `llm-judge` / `llm-space` / `llm-test` / `open-options` | DeepSeek 请求、打开设置 |
| 面板 / 后台 → 内容脚本 | `{dfy: 'status' \| 'snap' \| 'cannon' \| 'rescan' \| 'llm' \| 'report'}` | 面板「本页」操作与快捷键 |

## Firefox 适配

代码里统一使用 `chrome.*` 回调写法，Firefox 原生支持，不需要 polyfill。Firefox 版只是把 `manifest.json` 换成下面的写法（其余字段相同），打包成 zip：

```json
{
  "background": {
    "scripts": [
      "src/core/models.js",
      "src/platforms/bilibili/shared.js",
      "src/core/defaults.js",
      "src/core/storage-engine.js",
      "src/background.js"
    ]
  },
  "browser_specific_settings": {
    "gecko": {
      "id": "dafeiyu-cleaner@liyupi.github.io",
      "strict_min_version": "140.0",
      "data_collection_permissions": { "required": ["none"], "optional": ["websiteContent"] }
    },
    "gecko_android": { "strict_min_version": "142.0" }
  }
}
```

- Firefox MV3 不支持 `background.service_worker`，改用 `background.scripts`（事件页）
- 内容脚本的 `world: "MAIN"` 需要 Firefox 128+，`data_collection_permissions` 需要 140+
- 扩展 ID 发布后不能再改
- 不直接改 Chrome 版的 manifest，避免 Chrome 报「无法识别的键」警告

代码里只有两处 Firefox 专属分支，Chrome 下都不会进入：

| 位置 | 原因 |
| --- | --- |
| `detector.js` 的 `DFY.avatarBlue` | Firefox 内容脚本里带 `crossOrigin` 的图片请求加不上 `Origin` 头，会被 CORS 拦下；改用 `fetch` 取图再 `createImageBitmap`。用 `window.wrappedJSObject` 是否存在判断 |
| `popup.js` 的精判开关、`background.js` 的 `consented()` | 把评论发给 DeepSeek 属于向第三方发送网页内容，Firefox 要求运行时取得 `websiteContent` 授权。打开开关时 `permissions.request`，发请求前 `permissions.contains` 检查。用扩展地址是否以 `moz-extension:` 开头判断 |

## 本地检查

需要 Node.js 22，无 npm 依赖。在仓库根目录运行 `node --test tests/core.test.cjs`。测试使用 Node VM 和 DOM 替身覆盖协议、存储迁移/并发、会话、节点复用、模型结果过期及后台加载；不等同于真实网页或 Firefox 验收。

新增平台的实际接口见 [适配器接入说明](PLATFORM_ADAPTER_GUIDE.md)。当前使用显式脚本顺序；完成真实站点验证后再扩展 manifest 的注入和资源域名。

## 约定

- 「赶走」只能是本地隐藏，不调用 B 站任何写接口（删除、举报、拉黑），不读 Cookie
- 不把任何 API Key 写进仓库
- 界面不用 Emoji，图标用 `DFY.icon(name)`
- 视觉风格是二次元设定集：粗描边 + 硬投影。配色 token 在 `ui.js` 的 `.wrap` 和 `popup.css` 的 `:root`：ink `#151a3d`、paper `#f5eadd`、blue `#2546b8`、cyan `#6fe0ff`、gold `#c9a24a`、pink `#ff5d8a`
- 标题字体是子集，只包含界面现有的汉字；新增的字会回退到系统字体
