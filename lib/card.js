// Pure rendering: the "strategy card". Must fit one screen and never ask the user
// to fill a form. No I/O, no ctx.
//
// The card offers a STRUCTURED override (override: {strategy}) — never a natural
// language "pick line 1" instruction the model would have to parse.

import { round } from './adapters/contract.js'

const CHANNEL_LABEL = {
  read_trace: '读轨迹',
  query_sensor: '查传感器',
  read_multimodal: '看多模态痕迹',
  structured_form: '结构化表单',
  minimal_question: '最小追问',
  assume_and_flag: '先假设并标注',
}

const GAP_LABEL = {
  goal: '目标',
  constraint: '约束',
  preference: '偏好',
  environment: '环境',
  acceptance: '验收',
}

// What the model should try before falling back to the next channel.
const OVERRIDE_CANDIDATES = {
  read_trace: ['assume_and_flag', 'minimal_question'],
  query_sensor: ['read_trace', 'assume_and_flag'],
  read_multimodal: ['read_trace', 'assume_and_flag'],
  structured_form: ['minimal_question', 'assume_and_flag'],
  minimal_question: ['structured_form', 'assume_and_flag'],
  assume_and_flag: ['minimal_question', 'read_trace'],
}

export function confidenceBar(value) {
  const n = Math.max(0, Math.min(1, Number(value) || 0))
  const filled = Math.round(n * 10)
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${round(n, 2)}`
}

export function renderCard(result) {
  const lines = []
  lines.push(`### 🛰 dsh-recon · 策略卡`)
  lines.push(
    `**缺口** ${GAP_LABEL[result.gap_type] || result.gap_type || '—'} ｜ **建议通道** ` +
    `${CHANNEL_LABEL[result.strategy] || result.strategy}` +
    `${result.source_plugin ? `（${result.source_plugin}）` : ''}`,
  )
  lines.push(`**置信度** ${confidenceBar(result.confidence)}`)

  const ev = result.evidence || []
  if (ev.length) {
    lines.push(`**已有证据** ${ev.length} 条`)
    for (const e of ev.slice(-4)) {
      const src = [e.channel, e.plugin].filter(Boolean).join('/')
      const mark = e.verified ? '' : '（未核实）'
      lines.push(`- ${e.text.slice(0, 100)}${mark} — ${src}`)
    }
    if (ev.length > 4) lines.push(`- …另有 ${ev.length - 4} 条`)
  } else {
    lines.push(`**已有证据** 无`)
  }

  if (result.strategy === 'minimal_question' || result.strategy === 'structured_form') {
    const q = result.question_if_any
    lines.push(`**若必须问，就问这一句**`)
    lines.push(`> ${q?.ask || '—'}`)
    if (q?.known_context) lines.push(`> 上下文：${q.known_context}`)
  }

  if (result.strategy === 'assume_and_flag') {
    const a = result.assumption_if_any
    lines.push(`**按此假设执行** ${a?.text || '—'}`)
    lines.push(`**交付物里标注** ${a?.label || '—'}`)
  }

  if (result.skipped?.length) {
    const brief = result.skipped.map((s) => `${CHANNEL_LABEL[s.channel] || s.channel}✗`).join(' ')
    lines.push(`**未走** ${brief}`)
    // Why a channel that DID run found nothing: this is the audit trail.
    const ran = result.skipped.filter((s) => s.ran)
    for (const s of ran.slice(0, 2)) {
      lines.push(`  · ${CHANNEL_LABEL[s.channel] || s.channel}：${s.reason}`)
    }
  }

  // Structured override: one call, no prose parsing.
  const candidates = OVERRIDE_CANDIDATES[result.strategy] || ['assume_and_flag']
  const overrides = candidates
    .map((s) => `\`override:{strategy:"${s}"}\``)
    .join(' 或 ')
  lines.push(`**改道** 重调本工具并附 ${overrides}`)
  lines.push(`_decision_id: ${result.decision_id || '—'}_`)
  return lines.join('\n')
}
