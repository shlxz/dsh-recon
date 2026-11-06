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
})
