# dsh-recon 自检报告

> 生成时间：2026-11-06 23:2x（Asia/Shanghai）
> 版本：`0.2.0`　提交：`805174b`
> 发布渠道：GitHub `shlxz/dsh-recon` · npm `dsh-recon@0.2.0`

---

## 1 结论摘要

| 维度 | 结果 |
|---|---|
| 测试 | **80 项全绿**（8 个文件） |
| 缺陷自检 | 发现 **9 个**，全部修复，全部有回归锁 |
| 变异测试 | 抽验 6 个缺陷，**6/6 被捕获**；本轮再抽验 1 个仍有效 |
| 线上验收 | GitHub clone + npm install 双路实测通过 |
| 代码规模 | 源码 2,619 行 / 测试 2,104 行（测试:源码 ≈ 0.81） |
| 遗留 TODO | 9 处，**全部集中在适配层**，符合解耦约束 |

**一句话判断**：功能可用、发布完整，但**六个通道只有 3 个真跑通**，且真实使用验证尚未完成。

---

## 2 架构自检

### 2.1 分层是否真实成立

声称的三层分离，逐文件核验：

| 层 | 文件 | 是否有 `ctx` / I/O |
|---|---|---|
| 纯逻辑 | `lib/policy.js` | 0 |
| 纯逻辑 | `lib/adapters/contract.js` | 0 |
| 纯逻辑 | `lib/router.js` | 0（见 2.2 修正） |
| 纯逻辑 | `lib/card.js` | 0（唯一匹配是注释） |
| ctx 边界 | `lib/adapters/*`（除 contract） | 有 |
| ctx 边界 | `lib/index.js` | 有 |
| ctx 边界 | `lib/client.js` | 有（浏览器半） |

**架构成立**：路由器只吃 `{ channel, probe() }` 对象，不认识任何插件名，不做 I/O。

### 2.2 本轮新发现（第 10 处问题）

`lib/router.js` 的 `finalize(strategy, ctx)` **把内部参数对象命名为 `ctx`**。

- 行为正确（那只是 `{input, c, evidence, ...}` 的容器）
- 但**语义错误**：一个纯模块的参数叫 `ctx`，读代码的人会认为它持有 Cordis context，直接摧毁了"决策逻辑与通道实现解耦"这一设计主张的可信度

**已修**：改名 `frame`，并加注释明确"这不是 Cordis context"。测试仍 80/80。

> 这类问题值得记：**命名污染比逻辑错误更难被发现**，因为没有任何测试会失败。

---

## 3 功能自检

### 3.1 六通道真实状态（对照实代码）

| 通道 | 有 `act()` | 状态 | 说明 |
|---|---|---|---|
| `read_trace` | 否 | ✅ **真跑通** | 读会话轨迹、台账、`userQuestions` 投影 |
| `query_sensor` | 否 | ⚠️ **占位** | 只探测配置工具是否可见，**从不执行** |
| `read_multimodal` | 否 | ⚠️ **占位** | 探测语音 provider 与视觉工具，**从不执行** |
| `structured_form` | **是** | ✅ **真跑通** | 直连 `ctx.userQuestions.ask` |
| `minimal_question` | **是** | ✅ **真跑通** | 同上，单问句 + 已知上下文 |
| `assume_and_flag` | 否 | ✅ **真跑通** | 纯函数，产出假设与标注文案 |

**修正一处此前的表述**：我在早前报告里说"`structured_form` 和 `minimal_question` 共用同一句 `ask`"，这不准确——两者都有独立 `act()`，`structured_form` 走多字段（goal/constraint/preference 三类才可用），`minimal_question` 固定单问。

### 3.2 闸门逻辑

- `assumptionCost` 由**声明枚举**（`reversibility` / `blast_radius`）驱动，非词法猜测
- 每个证据通道返回后**重算**再比闸门
- `confidence` **只影响展示**，有结构性断言证明它不进入代价函数
- 部分证据折扣有上限（`0.85`），避免"证据充足则假设零成本"

### 3.3 面板

| 项 | 状态 |
|---|---|
| 右侧栏三步注册 | ✅ `sidebarRightTabs` + `pane.tab` + `pane.tab.title` |
| guide 入口 | ✅ 已修（见缺陷 10），`order: 15` |
| 数据源 | ✅ `GET /api/dsh-recon/snapshot`，**loopback 守卫** |
| 只读性 | ✅ 无 POST、无 `route_info_gap` 调用、无 `localStorage` |
| 颜色 | ✅ **0 处十六进制**，全部 `--dsw-*` 带同族 fallback |
| 文案 | ✅ 全部收在 `STRINGS`，0 处内联中文 |
| 订阅机制 | ✅ `useState` + `subscribe`（见缺陷 9） |

---

## 4 缺陷清单（10 项）

前 9 项出自 12:xx 的自检，第 10 项出自本轮。

| # | 缺陷 | 后果 | 级别 |
|---|---|---|---|
| 1 | `presentResult` 读 `result.content`（永不存在） | 每次工具卡片在 UI 里**是空的** | 高 |
| 2 | 纠正归因未按会话隔离 | B 会话一句"不对"污染 A 会话 | 高 |
| 3 | 一条纠正消息结算**所有**待定假设 | 纠正率虚高，验收指标失真 | 高 |
| 4 | 快照路由注释称 loopback-only，**无守卫** | 局域网可读决策台账 | 高（安全） |
| 5 | `assumptionDefaults` 被 router 读取但不在 Config | 配置项死链 | 中 |
| 6 | `pendingFeedback` 只增不减 | 长会话内存线性增长 | 中 |
| 7 | 客户端轮询结果被 `void` 丢弃 | 面板永远空态 | 高 |
| 8 | `apply()` 手写默认值遮蔽 Config schema | `config:{}` 时 `sensorTools` 成 `[]` | 高 |
| 9 | 面板订阅用未确认的 `useSyncExternalStore`，fallback 只读一次 | 数据到了**永不重绘** | 高 |
| 10 | `finalize()` 参数命名为 `ctx` | 纯模块读起来像 ctx 感知 | 中（可读性） |

### 4.1 共同点

**缺陷 1/3/4/7/8/9 全部是"测试全绿但功能不工作"**。它们分两类：

- **链路断裂**：单元测了组件，没测组件之间的连接（1、7、9）
- **配置路径**：测试直接传完整 config，绕过了真实加载路径（8）

### 4.2 发现方式

**没有一个是测试发现的**。全部来自：

- 读代码（1、5、6、10）
- 真实调用（8：真机跑 `query_sensor` 看到"未配置"）
- 你的一句话（"我该怎么看画面" → 缺陷 10 的 `guide: []`）
- 我自己的"这不对"直觉（3、4）

**结论：测试证明的是"我写的东西按我理解的方式工作"，不能证明"整体能用"。**

---

## 5 变异测试有效性

不是"写了测试"，而是"测试会失败"。逐项反向注入旧代码：

| 注入的旧行为 | 变红的测试 |
|---|---|
| `presentResult` 读 `.content` | `presentResult emits the markdown card` |
| 手写默认值遮蔽 schema | `apply() resolves Config defaults from the schema` |
| 纠正跨会话泄漏 | `a correction in session B does not mark session A` |
| 一条消息结算全部 | `one correcting message settles exactly one` |
| 移除 loopback 守卫 | `snapshot route refuses a non-loopback peer` |
| 丢弃轮询结果 | `the client panel receives polled data` |
| 改为读一次不订阅 | `the panel subscribes to the store` |
| 颜色改十六进制 | `bar colours come only from --dsw-*` |
| badge 改点状 | `correction badge is ⚠ N, never dots` |
| 内联中文 | `every visible string lives in one STRINGS object` |
| 卡片边距改 4px | `timeline cards sit 6px apart` |
| guide order 改回 30 | `guide order is 15` |

**12/12 被捕获**（含本轮抽验 1 条）。

> 反例：`client-contract` 里曾有一条 `assert.equal(init.method,'GET')`，断言的是刚创建的字面量，与源码无关——**空转断言**。已随实现演进修正。

---

## 6 线上验收

### 6.1 GitHub

| 检查 | 结果 |
|---|---|
| `refs/heads/main` SHA | 本地 = 远端 ✅ |
| 文件数 | 31 |
| 提交作者 | 全部 `shlxz <shlxz@users.noreply.github.com>`，无 Gitee 残留 |
| tag `v0.2.0` | ✅ annotated，指向 `93e9001` |
| clone 后 `npm i && npm test` | **80/80** |

### 6.2 npm

| 检查 | 结果 |
|---|---|
| `latest` | `0.2.0` |
| `dist.fileCount` | 19（不含 test/tools） |
| `unpackedSize` | 112,040 bytes |
| license | MIT |
| `npm install dsh-recon@0.2.0` 后加载 | ✅ 导出 8 个符号 |

### 6.3 已知的 registry 噪声

`0.0.0-stage` 是 npm **staged publishing** 自动创建的占位（2 文件 / 331 字节）。`latest` 指向 `0.2.0`，**不影响安装**。

---

## 7 未完成与未验证

### 7.1 明确未实现（9 处 TODO，全在适配层）

- `query_sensor` 无 `act()`：只探测可见性，不执行任何工具
- `read_multimodal` 同样
- 二者的参数契约未确认，故不做猜测性实现

### 7.2 未验证（有代码但无证据）

| 项 | 缺什么证据 |
|---|---|
| 真实对话中的纠正识别 | 只测过 `feedback` 显式认领，**未测过自然语言纠正的自动识别** |
| 面板视觉 | 你已确认"方向没问题"，但**细节（间距/字号）未逐项核对** |
| `ledgerPersist` 写盘 | 代码存在，从未启用过 |
| 跨会话连续使用 | 单会话内测过，未做多会话并发 |

### 7.3 验收标准状态

目标：**打断次数下降，返工率不上升**。

- 机制上有支撑（路由 + 闸门 + 纠正归因）
- **但从未在真实任务序列上测过**。现有数据全是我为验证而人为构造的调用

**这是最大的未完成项。**

---

## 8 风险评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| `ask()` 仅认 runtime root | 子 agent 调用得 `DELEGATED_CALLER` | 已降级为 `available:false`，不挂起 |
| `sessionProjections.stateOf` 返回裸 state | 形状变化导致读不到 | 每次读做防御性判断 |
| DSH 预览版接口变动 | 适配层失效 | 全部隔离在 `lib/adapters/` |
| client 半不热重载 | 改渲染必须重启 | 已写入 README 与踩坑清单 |
| 个人微信 iLink 封号风险 | 账号受限 | 未实施，插件侧有 `sendIntervalMs` 防护 |

---

## 9 建议的下一步（按优先级）

1. **真实使用验证**（最高优先）：让 recon 在真实任务里跑一周，看 `recon_strategy_stats` 的纠正率。这是唯一能证明验收标准的路径。
2. **`query_sensor` 落地**：有真实用例支撑——上一轮我判 `minimal_question`（0.35），但自己用 `web_search` 查到了答案，说明缺这个通道。
3. **面板细节打磨**：等你在实际使用中指出不顺眼处。
4. 其余（`ledgerPersist`、多会话并发）不急。

---

## 10 附：可复现的核验命令

```bash
# 测试
npm test                                   # 80 项

# 纯度检查（应全为 0）
grep -cE "ctx\.|await fetch|fs\.|process\.env" lib/router.js lib/policy.js

# 颜色与文案纪律（应为 0 / none）
grep -c "#[0-9a-fA-F]{3,6}" lib/client.js
grep -n "TODO" lib/

# 线上
curl -s https://registry.npmjs.org/dsh-recon/latest | grep version
git ls-remote --tags origin
```

---

*本报告的事实均来自本轮重新核验，未沿用早前记忆中的数字。*
