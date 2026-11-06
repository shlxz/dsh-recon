# dsh-recon

> 侦察已有痕迹，把提问留到最后。

一个**信息获取的决策层**，不是采集插件。它不实现表单、问卷、访谈面板，也不存记忆；
它只回答一个问题：**此刻该不该向用户获取信息、该从哪条已有通道取、取到什么粒度就够。**

## 它做什么

输入一次「信息缺口」，输出一个「获取策略」。六个通道，严格按序，前一条能解决就不进入下一条：

```
read_trace → query_sensor → read_multimodal
          → [闸门] → structured_form → minimal_question → assume_and_flag
```

**闸门**比较两笔账，并写进 rationale：

- `assumptionCost`：按默认假设执行的代价（由 `reversibility` / `blast_radius` 两个枚举 + gap 先验决定）
- `interruptCost`：现在打断用户的代价（由 `busy` / `recently_corrected` / `idle_seconds` 决定）

前者更低时**必须**走 `assume_and_flag`，禁止"为了完整"而提问。部分证据进来后会**重算** `assumptionCost` 再比闸门——不会出现"已经查到七成还要问"。

## 两个工具

| 工具 | 作用 |
|---|---|
| `route_info_gap` | 路由一个信息缺口，返回策略卡 + rationale + decision_id |
| `recon_strategy_stats` | 只读：策略分布与纠正率，用来核对验收标准 |

`route_info_gap` 默认 `mode: 'plan'`——**只给策略和理由，最终判断留给模型**。`act` 留给 v2：等策略卡被真实用过、知道模型会在什么情况下覆盖它，再决定哪些通道值得自动执行。

### `assumed_value`：假设必须说得出做什么

`assume_and_flag` 的语义是"**不问，直接做**"。所以调用时必须带上 `assumed_value`——那个具体的默认选择：

```json
{ "gap_type": "goal",
  "decision_at_stake": "贪吃蛇的实现形态",
  "assumed_value": "单文件 HTML，键盘操控，无音效，不做移动端" }
```

卡片就会显示 `**按此假设执行** 单文件 HTML，键盘操控，无音效，不做移动端`。

### 它读你的项目，而不只是读会话

`read_trace` 除了会话历史，还会读**工作区自身的约定**——这是"AI 做出来的东西不符合这个仓库"最常见的根因：

| 读什么 | 得到什么 |
|---|---|
| `package.json` 等 manifest | 模块系统（ESM/CommonJS）、测试运行器、是否有 TypeScript、包管理器、可用脚本 |
| `AGENTS.md` / `CONTRIBUTING.md` | 人写下来的约定，只取第一句有意义的（不摘要长文） |
| 顶层目录布局 | `src/` 还是 `lib/`、测试放 `tests/` 还是 `test/`、有没有 `docs/`、是否多包 |
| `.editorconfig` / `.prettierrc` | 存在即事实（不解析内容） |

**它从不读源码文件**。一个不能用 manifest、说明文件或目录名表达出来的"约定"，不是这个探针该猜的。

关掉：`config.readProjectConventions: false`。

> 这比问用户便宜得多。原来"不知道项目约定"只能靠问，现在多数情况能直接读到。

### 明显该假设时不侦察

如果闸门一看就定了（`assume ≤ interrupt × 0.5`），直接假设，**一次 probe 都不跑**。

之前的实测：一个"按钮用什么颜色"也要依次探测 `read_trace → query_sensor → read_multimodal`，全空后才假设——纯仪式。现在 0 次。

临界附近的决策仍然走侦察，因为证据可能真的翻转结果。阈值可调：`config.costModel.obviousAssumptionRatio`（设为 `0` 关闭）。

**不给 `assumed_value` 时，卡片不会编一句空话**，而是明说「尚无默认假设」并告诉模型怎么补。这条字段存在的原因：0.2.1 的卡片会说「按最小可逆的方案先做」，但**从不说方案是什么**——模型唯一诚实的做法只能是把问题原样退回，那就是"披着决定外衣的提问"。

校验会拒绝三类敷衍值：

| 拒绝 | 例子 |
|---|---|
| 待定类 | `待定` / `未定` / `取决于你` / `TBD` |
| 二选一未定 | `单文件还是桌面版` |
| 疑问语气 | `要音效吗` / `是否要做积分`（即使没有问号） |

**若确实给不出默认值**，就不该假设——改传 `override:{strategy:"minimal_question"}` 去问。

### 模型为什么会想起用它

只注册工具是不够的——**工具描述只在模型"正准备提问"时才有意义**，而常见的失败是模型直接凭经验开写，根本不会想到查。

所以插件注册一段 systemPrompt section（`dsh-recon:routing`，约 220 token），给出**具体触发条件**：

- 要做一个完整东西（页面/游戏/工具/脚本），但形态、规模、技术栈、完成标准没说死
- 用户只说"优化一下""改改""做个试试"
- 要动已有代码，但不知道约定（风格、命名、目录）
- 决策不可逆或影响面大，而关键约束不明
- 正要向用户提问，但还没试过从已有痕迹里查

同时明确**什么时候不该调**（任务已具体到可以动手、纯闲聊、纯查询），避免变成仪式。

> 这段是必要的，不是装饰：初次发布时没有它，用户让 AI 写贪吃蛇，全程**一次都没触发** `route_info_gap`。

入参除 `gap_type` / `decision_at_stake` 外，建议声明 `reversibility: high|medium|low` 与
`blast_radius: local|module|system`。不填时按措辞推断，但那条路径不可靠（中文尤其），
rationale 里会标注 `(inferred)`。

## 只读面板

右侧栏一个 `Recon` 标签，**只读**：没有任何覆盖/认领按钮，不做 Client→Host 写 RPC。

- **数据源**：复用 `lib/ledger.js` 的环形台账，不新建存储。Host 半把同一份台账以只读快照暴露在 `GET /api/dsh-recon/snapshot`（仅 loopback）。
- **客户端**：手写 `__ModuleLoader__` 工厂 + `React.createElement`，无构建步骤、无框架。
- **注册三步**，缺一不可 —— `sidebarRightTabs.register({id,kind})`（标签栏 chip）+ `sidebar.right.pane.tab`（内容，key 同 id）+ `sidebar.right.pane.tab.title`（标题，key 同 id）。`pane.tab` 是 **keyed** slot，只注册内容不会出现在标签栏。
- **降级**：任一步失败都静默，`route_info_gap` 不受影响；拉不到数据就显示空态。

快照形状：

```json
{ "ok": true,
  "snapshot": {
    "total": 12, "corrected": 2,
    "distribution": { "read_trace": 5, "assume_and_flag": 6, "structured_form": 1 },
    "decisions": [ { "decision_id": "rc_…", "gap_type": "goal", "strategy": "assume_and_flag",
                     "decision_at_stake": "…", "assumption_cost": 0.65, "interrupt_cost": 0.8,
                     "confidence": 0.65, "corrected": false, "prior_failures": 0 } ] } }
```

> **预览版注意**：`dsh.client` 的扫描发生在 Host 启动**构造时**。热挂载一个新 bundle 的 client 半**不会**进图，必须重启 DSH。实测：重启前 `pane.tab` occupants 里没有 `dsh-recon`，重启后出现且 `active`。Host 半（工具、路由）可热重载，client 半不行。

### 面板的三条设计裁决（已实现并有测试锁定）

| 项 | 裁决 | 实现 |
|---|---|---|
| 分布条 | 横向条、宽度 `count/total`、颜色只取 `--dsw-*` | 六种策略纵排六行，无图例；零值行保留但降到 25% 不透明；**绝无十六进制颜色** |
| 纠正标记 | `⚠ N`，不用点状 | 同一个图标在所有计数下不变；`N=1` 降饱和 + 常规字重 + `(未到阈值)`，`N>=2` 满强度 + 加粗 + `已下调置信度` |
| 文案 | 先硬编码中文 | 全部收进一个扁平 `STRINGS` 对象，渲染处只写 `STRINGS.x`；换成 `t()` 时不用碰渲染逻辑 |

### 视觉微调（二轮裁决，已实现并有测试锁定）

| 项 | 值 | 测试 |
|---|---|---|
| 时间线卡片外边距 | **6px**（内部行距保持 4px） | `timeline cards sit 6px apart while inner lines stay 4px` |
| 分布标题右侧 | 灰色小字 `total: N`，N 是六条通道计数之和（与条形分母一致，非 `snapshot.total`） | `the distribution heading carries the total on the right` |
| 侧栏 guide order | **15**（原 30，靠前后者更易被发现） | `guide order is 15` |
| `⚠ N` 防换行 | 容器 `flexWrap:'nowrap'`；通道名 `ellipsis` 让位，badge `nowrap` | `the badge row cannot wrap` |

**语义色映射**（按裁决，但主题没有 info 系）：

| 通道 | token | 说明 |
|---|---|---|
| `assume_and_flag` | `--dsw-alias-state-warn-primary` | 警告系 |
| `minimal_question` | `--dsw-alias-brand-primary` | **主题无 info 系**（`Theme.listTokens` 只有 warn/success/error/idle），用品牌强调色代替 |
| `read_trace` / `query_sensor` / `read_multimodal` | `--dsw-alias-state-success-primary` | 成功系 |
| `structured_form` | `--dsw-alias-state-idle-primary` | neutral 系 |

每个 token 都带同族 fallback（如 `var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-primary))`），读不到时在主题内降级，**不回退到硬编码颜色**。

## 调闸门：`costModel`

闸门比较两笔账。所有权重都在 Config 里，**不需要改源码**：

```yaml
- id: dsh-recon
  config:
    costModel:
      interrupt:
        base: 0.5          # 问一句的基础成本
        busy: 0.55         # 用户在忙时追加
        recentlyCorrected: 0.35
        idleDiscount: 0.08 # 完全空闲时的最大减免（必须小于 base）
        idleSaturationSeconds: 900
        scale: 2.0         # 把打断账抬到与假设账同一区间
      maxAssumption: 3.0   # 假设成本上限；必须高于最贵的 base
      evidenceDiscount: 0.85
      reversibility: { high: 0, medium: 0.35, low: 0.8 }
      blastRadius: { local: 0.05, module: 0.3, system: 0.75 }
```

**调完怎么知道有没有效果**：调 `recon_strategy_stats`，它会按**当前模型**重放 18 种组合并输出分布：

```
闸门校准（当前 costModel）
  忙碌时选择假设: 8/9
  空闲时选择假设: 1/9
```

默认模型的含义：**忙碌时几乎总是不打扰**（只有最贵的决策才问），**空闲时也只对真正重要的决策开口**（"改个按钮颜色"不会问）。

> 两个参数有硬约束，调错会让闸门失效：
> - `maxAssumption` 必须高于最贵的 base（`low` 0.8 + `system` 0.75 + gapRisk 0.6 = 2.15），否则各种风险被压成同一个数字，**证据折扣完全失效**
> - `idleDiscount` 必须小于 `base`，否则"用户空闲"等于"问问题免费"

## 与其他插件的关系：协作，不是替代

| 已有生态 | dsh-recon 的位置 |
|---|---|
| **clarify**（`dsh-clarify-first` / `dsh-grill-first`） | 它们决定"怎么问、问几轮、要不要设门禁"。recon 在它们开工前回答"这一问值不值得"，并把 `structured_form` / `minimal_question` 交给平台原语 `ctx.userQuestions.ask`。 |
| **survey / form**（`dsh-better-choice` 等） | 不替换。`config.formTool` 默认空 = 走平台 `ask`；显式配置后才探测那个插件，失败即报告不可用，不猜测。 |
| **habit / taste**（`dsh-code-taste`、画像类） | 不建自己的记忆。偏好证据经 `read_trace` 读取；确认过的偏好写入仍由 habit 插件负责。 |
| **sentinel / monitor**（`dsh-monitor`、env-inspector） | 不自己监听文件或端口。`query_sensor` 只按配置探测工具名并通过 `ctx.tools.execute` 调用，未配置时明确返回"通道不可用"。 |

原则：**不硬编码任何现有插件的内部实现**，只通过 DSH 的工具调用机制（`ctx.tools.get` 探测、
`ctx.tools.execute` 调用）与平台原语对接。名字全部来自 config，找不到就降级。

## 配置

```yaml
- id: dsh-recon
  name: dsh-recon
  config:
    formTool: ''            # 空 = 直连 ctx.userQuestions.ask
    sensorTools: ['ops_glob', 'ops_bash']   # query_sensor 探测候选
    solveCoverage: 0.6
    ledgerPersist: false    # 默认纯内存；开了写 dsh-recon-ledger.json（请加进 .gitignore）
```

`ledgerPersist: true` 会在工作区根写台账文件。默认关，因为预览版的工作区路径语义与
storage-domain 形状都还没确认。

## 如何验证验收标准（打断下降、返工不上升）

1. 选 **5–10 个固定任务**（同一批，路由前后各跑一次），覆盖 goal / constraint / preference。
2. 每次修改前让模型调用 `route_info_gap`，然后**照策略卡执行**（不额外追问）。
3. 跑完后调 `recon_strategy_stats`，记录：
   - `distribution`：六条通道各占多少（`assume_and_flag` 与 `minimal_question` 之和 ≈ 打断次数）
   - `corrections` / `correction_rate`：后续 `user/message` 里出现"不对/其实/改成/wrong/actually"即计为纠正
4. 判据：**打断次数下降**，且 `correction_rate` 不高于基线。若某次路由导致纠正变多，视为路由失败——
   该条的 `rationale` 里带着两笔账的数值与 `decision_id`，可逐条追溯。

`mode:'plan'` 下 recon 自己不打断任何人；`corrections` 统计的是"照卡执行之后用户是否回头纠正"。

## 工程边界

- `lib/router.js`、`lib/policy.js`、`lib/card.js`、`lib/adapters/contract.js` 是**纯函数**：
  无 `ctx`、无插件名、无 I/O，可脱离 Harness 测试（`node --test`）。
- `lib/adapters/` 是唯一接触 `ctx` 的地方。所有未确认的接口集中标注 `TODO(adapter)`。
- 决策逻辑与通道实现解耦：router 只吃 `{ channel, probe() }` 对象。

### 已知未确认项（全部隔离在适配层）

- `sessionProjections.stateOf` 返回**裸 state**（不是包装对象），`userQuestions` 的 `{active, settled}`
  形状每次读取都做防御性判断。
- 第三方工具（sensor / multimodal）的参数契约未确认 → `query_sensor` / `read_multimodal` 当前为占位，
  返回"通道不可用"并列出已探测到的候选。
- `engines.dsh` 写 `>=0.2.1-rc.5 <0.3.0`：`^0.2.1-rc.5` 不匹配 `0.2.2-rc.x`，跨 rc 升级会被误判。

### 踩坑清单（DSH 0.2.1-rc.5 预览版实测）

四条都在真机复现过，改到任何插件都会撞上：

1. **`-0` 不是 lossless JSON。** `Math.round(-0.001 * 100) / 100` 得到 `-0`，
   `JSON.stringify` 丢符号，Host 校验直接拒整次调用。`policy.round()` 里 `Object.is(r, -0) ? 0 : r`。
   最容易出现在"扣减项"上：`idle_discount: -0`。
2. **JSON Schema 不接受 `type` 数组。** `{ type: ['string','null'] }` 让整行 entry 装载失败
   （`JsonSchemaError: unsupported JSON schema`）。可空字段改为**省略键**，不是 `type: null`。
3. **`inject` 不能省。** `export const inject = []` 会在取 `ctx.tools` 时抛
   `cannot get property "tools" without inject`；用到哪个服务就声明哪个。
4. **null 字段要在返回前剔除。** 声明为 `type: 'object'` 的输出若返回 `null`，校验报
   `must be an object`。`dropNulls()` 在 `execute` 末尾统一处理。

另两条语义坑：

5. **`sessionProjections.stateOf` 返回裸 state**，不是 `{value}` 包装；且随插件卸载消失。
6. **`ask()` 只认运行时 root**，子 agent 得到 `DELEGATED_CALLER`——必须当作"通道不可用"降级，否则永久挂起。

## 安装

**作为 DSH 插件**（推荐）：

```bash
dsh plugin --profile <你的profile> add dsh-recon
# 或在 DSH 插件页填 dsh-recon
```

装完**重启 DSH** —— `dsh.client` 的扫描只发生在 Host 启动构造时，热挂载的 client 半不进图（见下文「预览版注意」）。

**从源码开发**：

```bash
git clone https://github.com/shlxz/dsh-recon.git
cd dsh-recon
npm install        # 拉取 peer 依赖 @deepseek-ai/schemastery
npm test           # 128 项
```

> `@deepseek-ai/schemastery` 是 DSH 的共享包：运行时由宿主提供（所以它是 `peerDependencies`），开发时由 `devDependencies` 装一份本地副本供测试。裸 clone 不装依赖时 `lib/config.js` 会报 `ERR_MODULE_NOT_FOUND`，这是预期行为——先 `npm install`。

## 开发

```sh
npm test                        # 128 项
npm run scenarios               # 三条可跑通道的策略卡 + strategy 分布
```

测试分组：

| 文件 | 覆盖 |
|---|---|
| `test/router.test.mjs` | 六通道顺序、闸门、partial 重算、confidence 不反哺 |
| `test/correction-loop.test.mjs` | **跨调用状态机**：assume → 纠正 → prior_failures → confidence 下调且成本不变 |
| `test/ask-contract.test.mjs` | ask 答案 → Evidence 归一化 → 下一轮 known_evidence |
| `test/e2e.test.mjs` | 假 Host 上的工具注册与端到端 |
| `test/snapshot.test.mjs` | 面板数据源：三块数据、JSON 安全、只读路由 |
| `test/client-contract.test.mjs` | 右侧栏三步注册、缺依赖静默、只读源码守卫 |
| `test/audit-regressions.test.mjs` + `test/panel-render.test.mjs` | 自检发现的 9 个缺陷的回归锁 + 面板三条裁决 |

### 自检发现的缺陷（已修，均有回归测试）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `presentResult` 读 `result.content`（永不存在） | 每次工具卡片在 Web UI 里是空的 |
| 2 | 纠正归因未按会话隔离 | B 会话一句"不对"，把 A 会话的决定标成纠正 |
| 3 | 一条纠正消息结算**所有**待定假设 | 一次纠正污染整批，纠正率虚高 |
| 4 | 快照路由注释称 loopback-only，但无守卫 | 局域网内任一台机器可读决策台账 |
| 5 | `assumptionDefaults` 被读取但不在 Config | 配置项死链，永远走内置兜底 |
| 6 | `pendingFeedback` 只增不减 | 长会话内存随决定数线性增长 |
| 7 | 客户端轮询结果被丢弃 | 面板永远显示空态 |
| 8 | `apply()` 手写默认值遮蔽 Config schema | `config: {}` 时 `sensorTools` 成 `[]`，`query_sensor` 永远报"未配置" |
| 9 | 面板订阅用了未确认的 `useSyncExternalStore`，其 fallback 只读一次不订阅 | 若该 API 不存在，面板渲染一次后**永不重绘**，数据到了也显示空态 |

回归测试用**变异测试**验证过有效性：把旧代码改回去，对应测试逐项变红（8/8 被捕获）。

> 缺陷 7、9 是同一类：**数据到了，但上不了屏**。7 是源头丢弃结果，9 是到了却不订阅。两者在运行时都与"没数据"外观相同，只能靠源码级与机制级断言区分。

### 重启后实测确认

| 项 | 结果 |
|---|---|
| Host 半热重载 | ✅ 重新 install 后运行中的 Config schema 立即含 `assumptionDefaults` |
| client 半热重载 | ❌ **不进图**，必须重启 DSH |
| 重启后 `pane.tab` occupants | ✅ `dsh-recon` 出现且 `active`，排在首位 |
| 重启后 `pane.tab.title` occupants | ✅ 同上 |
| 快照路由 | ✅ loopback 200，台账随新进程重置为 `total:0` |
| 工具卡片内容 | ✅ 完整策略卡渲染（缺陷 1 修复可见） |
| `read_trace` 空态区分 | ✅ 显示 `scanned 5 events, none matched`，而非含糊的"没有相关消息" |

MIT
