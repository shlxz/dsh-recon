// Pure data contract shared by the router and every channel adapter.
// MUST NOT import ctx, any @deepseek-ai package, or any plugin name.

export const GAP_TYPES = ['goal', 'constraint', 'preference', 'environment', 'acceptance']

export const CHANNELS = [
  'read_trace',
  'query_sensor',
  'read_multimodal',
  'structured_form',
  'minimal_question',
  'assume_and_flag',
]

// Channels that only read existing traces: they may return evidence.
export const EVIDENCE_CHANNELS = ['read_trace', 'query_sensor', 'read_multimodal']
// Channels that interrupt the human: the gate must pass before entering them.
export const INTERRUPTING_CHANNELS = ['structured_form', 'minimal_question']

export const REVERSIBILITY = ['high', 'medium', 'low']
export const BLAST_RADIUS = ['local', 'module', 'system']

/** An assumption names a choice; past this it stops being a choice and becomes a brief. */
export const MAX_ASSUMED_VALUE_LENGTH = 160

// Phrases that mean "I did not decide". Matching one rejects the assumption,
// because storing it would render a deferral as if it were an answer — the exact
// defect `assumed_value` exists to remove.
const DEFERRAL_PATTERNS = [
  /待定/,
  /未定/,
  /待确认/,
  /取决于/,
  /看情况/,
  /视情况/,
  /你(来)?决定/,
  /由你/,
  /再讨论/,
  /待讨论/,
  /tbd/i,
  /to be (determined|decided)/i,
  /up to you/i,
  /it depends/i,
]

/**
 * Return the deferral phrase found in `text`, or null.
 *
 * Rejects three shapes, because each one asks a question rather than asserting
 * a default:
 *   - a question mark
 *   - an open choice ("还是" / "或者…哪")
 *   - interrogative particles with no question mark ("要音效吗", "是否…")
 */
export function findDeferral(text) {
  const t = String(text || '')
  if (/[?？]/.test(t)) return '问号'
  if (/还是|或是|或者(用|做)?哪/.test(t)) return '二选一未定'
  // Chinese often drops the question mark: "要音效吗" is a question even though
  // it ends in a particle. 吗/呢 are unambiguous; 是否 is interrogative by itself.
  if (/[吗呢][，。；、]?\s*$/.test(t) || /^\s*是否/.test(t) || /要不要|是否要|需不需要/.test(t)) {
    return '疑问语气'
  }
  for (const re of DEFERRAL_PATTERNS) {
    const m = t.match(re)
    if (m) return m[0]
  }
  return null
}

export class ReconError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReconError'
    this.code = code
  }
}

// Deterministic cue vocabulary. This is a *fallback* for recall of trace evidence,
// never the cost model (see policy.js: costs come from the declared enums).
const CUE = {
  goal: [
    '目标', '想要', '目的', '要什么', '做什么', '哪种', '哪个', '到底', '结果', '产物',
    'goal', 'objective', 'purpose', 'which', 'what exactly', 'deliverable',
  ],
  constraint: [
    '预算', '花多少', '时间', '期限', 'deadline', '多久', '权限', '必须用', '不能用',
    '限制', '约束', 'budget', 'constraint', 'limit', 'restriction', 'must use', 'no more than',
  ],
  preference: [
    '风格', '喜欢', '偏好', '习惯', '品味', '不要用', '别用', '统一', '改成', '换成', '简洁', '详细',
    'style', 'prefer', 'like', 'taste', 'convention', 'instead of', 'always', 'never',
  ],
  environment: [
    '文件', '端口', '服务', '进程', '路径', '目录', '依赖', '版本', '部署', '端口号',
    'file', 'port', 'service', 'process', 'path', 'directory', 'dependency', 'version',
  ],
  acceptance: [
    '验收', '算完成', '标准', '测试', '通过', '满足', '必须能', '才算', '检查',
    'acceptance', 'done when', 'criteria', 'pass', 'verify', 'definition of done',
  ],
}

export const CORRECTION_CUES = [
  '不对', '不是', '错了', '改一下', '其实', '纠正', '我说的是', '理解错', '不要这样',
  'wrong', 'not what', 'actually', 'instead', 'correction', 'misunderstood',
]

export function clamp01(n) {
  const v = Number.isFinite(n) ? n : 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function round(n, digits = 2) {
  const p = 10 ** digits
  const r = Math.round(n * p) / p
  // `-0` is NOT lossless JSON (JSON.stringify loses the sign and the Host's
  // validator rejects it) — verified on 0.2.1-rc.5 with a tiny idle discount.
  return Object.is(r, -0) ? 0 : r
}

export function cueCount(text, gapType) {
  const t = String(text || '').toLowerCase()
  if (!t) return 0
  const cues = CUE[gapType] || []
  let n = 0
  for (const c of cues) if (t.includes(c.toLowerCase())) n += 1
  return n
}

export function hasCorrectionCue(text) {
  const t = String(text || '').toLowerCase()
  return CORRECTION_CUES.some((c) => t.includes(c.toLowerCase()))
}

/** One piece of evidence, always traceable back to its producer. */
export function makeEvidence({
  channel,
  plugin = null,
  tool = null,
  ref = null,
  text,
  weight = 0.2,
  verified = true,
}) {
  return {
    channel,
    plugin,
    tool,
    ref,
    text: String(text || '').slice(0, 240),
    weight: clamp01(weight),
    verified,
  }
}

/** Model-supplied evidence is admitted at lower weight: it is unverified summary. */
export function normalizeKnownEvidence(raw) {
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const item of list) {
    const text = typeof item === 'string' ? item : item?.text
    if (!text || !String(text).trim()) continue
    out.push(
      makeEvidence({
        channel: typeof item === 'object' && item?.channel ? item.channel : 'model_claimed',
        text,
        weight: typeof item === 'object' && item?.weight != null ? item.weight : 0.3,
        verified: false,
      }),
    )
  }
  return out
}

export function coverageOf(evidence) {
  let sum = 0
  for (const e of evidence || []) sum += clamp01(e.weight)
  return clamp01(sum)
}

/** Validate and normalize the model's arguments. Throws ReconError on bad input. */
export function normalizeInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ReconError('BAD_ARGUMENTS', 'arguments must be an object')
  }
  const allowed = new Set([
    'gap_type',
    'decision_at_stake',
    'assumed_value',
    'reversibility',
    'blast_radius',
    'user_state',
    'known_evidence',
    'mode',
    'override',
    'feedback',
  ])
  const unknown = Object.keys(args).filter((k) => !allowed.has(k))
  if (unknown.length) {
    throw new ReconError('UNKNOWN_ARGUMENT', `unknown argument(s): ${unknown.join(', ')}`)
  }

  const gapType = args.gap_type
  if (!GAP_TYPES.includes(gapType)) {
    throw new ReconError('BAD_GAP_TYPE', `gap_type must be one of ${GAP_TYPES.join(', ')}`)
  }

  const decision = args.decision_at_stake
  if (typeof decision !== 'string' || !decision.trim()) {
    throw new ReconError('BAD_DECISION', 'decision_at_stake is required and must be a non-empty string')
  }

  // `assumed_value` is what the card tells the user they will get.
  //
  // It exists because the router CANNOT invent a good default: it prices a
  // decision, it does not make one. The old card said "proceed on the most
  // reversible option" without naming any option, so the model's only honest
  // move was to repeat the question back — a question wearing a decision's
  // clothes. The model supplies the concrete default instead.
  //
  // The validation is the point: a deferred or interrogative value is exactly
  // the failure this field was added to remove, so it is rejected rather than
  // stored and rendered as if it were an answer.
  const assumedValue = args.assumed_value
  if (assumedValue != null) {
    if (typeof assumedValue !== 'string') {
      throw new ReconError('BAD_ASSUMED_VALUE', 'assumed_value must be a string')
    }
    const trimmed = assumedValue.trim()
    if (!trimmed) {
      throw new ReconError('BAD_ASSUMED_VALUE', 'assumed_value must not be empty')
    }
    if (trimmed.length > MAX_ASSUMED_VALUE_LENGTH) {
      throw new ReconError(
        'BAD_ASSUMED_VALUE',
        `assumed_value must be at most ${MAX_ASSUMED_VALUE_LENGTH} characters; summarize the choice, do not restate the whole brief`,
      )
    }
    const deferred = findDeferral(trimmed)
    if (deferred) {
      throw new ReconError(
        'BAD_ASSUMED_VALUE',
        `assumed_value looks deferred ("${deferred}"). An assumption must name the choice to make, ` +
          'not restate what is undecided. Example: "单文件 HTML，键盘操控，无音效".',
      )
    }
  }

  // A: cost comes from the two declared enums, not from lexical guesswork.
  //    Lexical scoring is used ONLY when the model left them out.
  const declReversibility = args.reversibility
  const declBlast = args.blast_radius
  if (declReversibility != null && !REVERSIBILITY.includes(declReversibility)) {
    throw new ReconError('BAD_REVERSIBILITY', `reversibility must be one of ${REVERSIBILITY.join(', ')}`)
  }
  if (declBlast != null && !BLAST_RADIUS.includes(declBlast)) {
    throw new ReconError('BAD_BLAST_RADIUS', `blast_radius must be one of ${BLAST_RADIUS.join(', ')}`)
  }
  const inferred = inferRiskFromText(decision)

  const st = args.user_state
  const userState = {
    busy: Boolean(st?.busy),
    recently_corrected: Boolean(st?.recently_corrected),
    idle_seconds: Math.max(0, Number(st?.idle_seconds ?? 0) || 0),
  }

  const mode = args.mode == null ? 'plan' : args.mode
  if (!['plan', 'act'].includes(mode)) {
    throw new ReconError('BAD_MODE', "mode must be 'plan' or 'act'")
  }

  let override = null
  if (args.override != null) {
    if (!CHANNELS.includes(args.override?.strategy)) {
      throw new ReconError('BAD_OVERRIDE', `override.strategy must be one of ${CHANNELS.join(', ')}`)
    }
    override = { strategy: args.override.strategy, reason: args.override.reason ?? null }
  }

  let feedback = null
  if (args.feedback != null) {
    if (typeof args.feedback?.decision_id !== 'string') {
      throw new ReconError('BAD_FEEDBACK', 'feedback.decision_id must be a string')
    }
    feedback = {
      decision_id: args.feedback.decision_id,
      corrected: Boolean(args.feedback.corrected),
    }
  }

  return {
    gap_type: gapType,
    decision_at_stake: decision.trim(),
    // null when the model did not supply a default; the router then falls back
    // to the generic template and says so, rather than inventing one.
    assumed_value: typeof assumedValue === 'string' ? assumedValue.trim() : null,
    reversibility: declReversibility ?? inferred.reversibility,
    blast_radius: declBlast ?? inferred.blast_radius,
    declared: { reversibility: declReversibility != null, blast_radius: declBlast != null },
    inferred,
    user_state: userState,
    known_evidence: normalizeKnownEvidence(args.known_evidence),
    mode,
    override,
    feedback,
  }
}

/** Lexical FALLBACK only. Exported so tests can pin its limits. */
export function inferRiskFromText(text) {
  const t = String(text || '').toLowerCase()
  const systemLevel = ['生产', '线上', '全仓', '全库', '所有', '整个', '架构', '迁移', '删库', '发布',
    'production', 'rollout', 'migrate', 'all users', 'schema'].some((w) => t.includes(w))
  const localLevel = ['这个文件', '这一行', '样式', '文案', '注释', '标题', '一个按钮', '单个',
    'this file', 'one line', 'css', 'comment', 'copy', 'single'].some((w) => t.includes(w))
  const irreversible = ['删除', '覆盖', '不可逆', '无法撤销', '发布', '上线', '合并', 'force push',
    'delete', 'overwrite', 'irreversible', 'publish', 'deploy'].some((w) => t.includes(w))

  return {
    reversibility: irreversible ? 'low' : localLevel ? 'high' : 'medium',
    blast_radius: systemLevel ? 'system' : localLevel ? 'local' : 'module',
  }
}
