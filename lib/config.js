import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().description('总开关').default(true),
  maxFormQuestions: z
    .number()
    .description('structured_form 一次最多几题（1-3）')
    .min(1)
    .max(3)
    .default(3),
  formTool: z
    .string()
    .description('可选：显式指定第三方表单工具名；留空则直连 ctx.userQuestions.ask')
    .default(''),
  sensorTools: z
    .array(z.string())
    .description('query_sensor 允许探测的工具名（不硬编码实现）')
    .default(['ops_glob', 'ops_bash', 'ops_grep', 'ops_inspect_local_file']),
  multimodalTools: z
    .array(z.string())
    .description('read_multimodal 允许探测的工具名')
    .default(['read_image', 'analyzeImage']),
  solveCoverage: z
    .number()
    .description('证据覆盖率达到多少即视为缺口已解决')
    .min(0.1)
    .max(1)
    .default(0.6),
  maxEvidenceItems: z.number().description('卡片与台账保留的证据条数').min(1).max(32).default(8),
  adaptiveConfidence: z
    .boolean()
    .description('同类缺口连续两次被纠正后下调展示置信度（不影响闸门）')
    .default(true),
  ledgerPersist: z
    .boolean()
    .description('把决策台账写到工作区（默认关，避免污染仓库）')
    .default(false),
  ledgerFile: z.string().description('台账文件名（工作区根）').default('dsh-recon-ledger.json'),
  askTimeoutMs: z.number().description('提问通道的等待上限').min(1000).max(600_000).default(90_000),
  assumptionDefaults: z
    .dict(z.string())
    .description('按 gap_type 覆盖默认假设文案（未命中的类型用内置兜底）')
    .default({}),

  readProjectConventions: z
    .boolean()
    .description(
      'read_trace 是否读工作区自身约定（manifest / AGENTS.md / 目录布局）。' +
      '关闭后只读会话历史与台账',
    )
    .default(true),

  // ---- cost model ------------------------------------------------------------
  //
  // The gate compares two ledgers that used to live only in policy.js. Every
  // weight here is exposed for ONE reason: the audit found that a plausible
  // weight set produced "interrupt" for 12 of 18 decision/state combinations —
  // the opposite of what the plugin is for. A user whose judgment differs must
  // be able to retune without editing source and restarting.
  //
  // Changing these does not change the code path; it changes what the router
  // considers cheap. `recon_strategy_stats` reports the resulting distribution.
  costModel: z
    .object({
      // How much a wrong assumption costs, by declared reversibility.
      reversibility: z
        .object({
          high: z.number().description('可逆：改回来几乎无成本').min(0).max(5).default(0),
          medium: z.number().description('中等：需要返工但可控').min(0).max(5).default(0.35),
          low: z.number().description('不可逆：改回来代价很高').min(0).max(5).default(0.8),
        })
        .default({ high: 0, medium: 0.35, low: 0.8 }),
      // How far a wrong assumption spreads.
      blastRadius: z
        .object({
          local: z.number().description('单点').min(0).max(5).default(0.05),
          module: z.number().description('一个模块').min(0).max(5).default(0.3),
          system: z.number().description('全局/生产').min(0).max(5).default(0.75),
        })
        .default({ local: 0.05, module: 0.3, system: 0.75 }),
      // Prior risk per gap type: how often a blind assumption on this class is wrong.
      gapRisk: z
        .object({
          goal: z.number().min(0).max(1).default(0.6),
          constraint: z.number().min(0).max(1).default(0.5),
          preference: z.number().min(0).max(1).default(0.55),
          environment: z.number().min(0).max(1).default(0.25),
          acceptance: z.number().min(0).max(1).default(0.45),
        })
        .default({ goal: 0.6, constraint: 0.5, preference: 0.55, environment: 0.25, acceptance: 0.45 }),
      // What an interruption costs right now.
      interrupt: z
        .object({
          base: z.number().description('问一句的基础成本').min(0).max(5).default(0.5),
          busy: z.number().description('用户在忙时追加').min(0).max(5).default(0.55),
          recentlyCorrected: z
            .number()
            .description('刚纠正过我，再问会更烦').min(0).max(5).default(0.35),
          idleDiscount: z
            .number()
            .description('完全空闲时的最大减免；必须小于 base，否则空闲等于免费')
            .min(0)
            .max(1)
            .default(0.08),
          idleSaturationSeconds: z
            .number()
            .description('空闲多少秒达到最大减免').min(60).max(86400).default(900),
          scale: z
            .number()
            .description('把打断账抬到与假设账同一区间（两账标度必须重叠）')
            .min(0.1)
            .max(10)
            .default(2.0),
        })
        .default({
          base: 0.5,
          busy: 0.55,
          recentlyCorrected: 0.35,
          idleDiscount: 0.08,
          idleSaturationSeconds: 900,
          scale: 2.0,
        }),
      // Ceiling on a bare assumption. MUST exceed the costliest base, or the
      // evidence discount stops mattering (verified: 1.0 flattened local/module/
      // system to one number and voided a 43% discount).
      maxAssumption: z
        .number()
        .description('单次假设成本上限；必须高于最贵的 base，否则证据折扣失效')
        .min(0.5)
        .max(20)
        .default(3.0),
      // How strongly verified evidence discounts the cost of the dimension it covers.
      evidenceDiscount: z
        .number()
        .description('已核实证据能抵掉多少假设成本（0-1）')
        .min(0)
        .max(1)
        .default(0.85),
    })
    .default({}),
})
