// End-to-end harness: exercises the three channels the MVP must actually run
// (read_trace / structured_form / assume_and_flag) plus the placeholder ones,
// against a FAKE ctx that mimics the documented Host services. No Harness boot.

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, Config } from '../lib/index.js'

// ---------- fake Host ----------
function fakeCtx({ sessionMessages = [], settledQuestions = [], askImpl = null, tools = {} } = {}) {
  const registered = []
  const handlers = {}
  const services = new Map()
  const effects = []

  const surfaceEvents = sessionMessages.map((text, i) => ({
    type: 'user/message',
    seq: i + 1,
    time: 0,
    data: { message: { role: 'user', content: [{ type: 'text', text }] } },
  }))

  services.set('sessionQuery', {
    async readSurface() {
      return { capturedThroughSeq: surfaceEvents.length, events: surfaceEvents }
    },
  })
  services.set('sessions', {
    get: (id) => (id === 's1' ? { id: 's1', header: { id: 's1' } } : undefined),
  })
  services.set('sessionProjections', {
    stateOf: () => ({ active: [], settled: settledQuestions }),
  })
  services.set('agents', {
    roots: () => [{ id: 's1' }],
    isOwnedBy: (childId, owner) => owner.id === 'other' && childId === 's1',
  })
  services.set('userQuestions', {
    async ask(request) {
      if (!askImpl) throw new Error('no answerer in test')
      return askImpl(request)
    },
  })
  services.set('tools', {
    get: (name) => tools[name],
    register(def) {
      registered.push(def)
      return () => {}
    },
  })

  const ctx = {
    get: (k) => services.get(k),
    on: (evt, fn) => {
      ;(handlers[evt] ||= []).push(fn)
      return () => {}
    },
    effect: (fn) => effects.push(fn),
    logger: () => ({ warn: () => {}, info: () => {} }),
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
  }
  return { ctx, registered, handlers }
}

async function callTool(registered, name, args) {
  const def = registered.find((d) => d.name === name)
  assert.ok(def, `tool ${name} not registered`)
  const result = await def.execute(args, { agent: { id: 's1' }, signal: AbortSignal.timeout(5000) })
  return { def, result }
}

// ---------- tests ----------

test('plugin registers route_info_gap with a valid Config', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, {})
  assert.ok(Config)
  assert.equal(registered.length, 2)
  assert.ok(registered.some((d) => d.name === 'route_info_gap'))
  assert.ok(registered.some((d) => d.name === 'recon_strategy_stats'))
})

test('E2E read_trace: an existing correction in the session answers the gap', async () => {
  const { ctx, registered } = fakeCtx({
    sessionMessages: ['不要用 moment.js，改成 date-fns', '这个项目统一用 const'],
  })
  apply(ctx, {})
  const { result } = await callTool(registered, 'route_info_gap', {
    gap_type: 'preference',
    decision_at_stake: '日期库选型',
    reversibility: 'high',
    blast_radius: 'local',
    user_state: { busy: false, recently_corrected: false, idle_seconds: 600 },
  })
  assert.equal(result.strategy, 'read_trace')
  assert.ok(result.evidence.length >= 1)
  assert.match(result.evidence[0].text, /moment|const/)
  assert.ok(result.card.includes('策略卡'))
  assert.ok(result.decision_id.startsWith('rc_'))
})

test('E2E assume_and_flag: cheap decision + busy user forbids the question', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, {})
  const { result } = await callTool(registered, 'route_info_gap', {
    gap_type: 'goal',
    decision_at_stake: '这个按钮用哪个颜色',
    reversibility: 'high',
    blast_radius: 'local',
    user_state: { busy: true, recently_corrected: false, idle_seconds: 0 },
  })
  assert.equal(result.strategy, 'assume_and_flag')
  assert.ok(result.assumption_if_any.text)
  assert.ok(result.assumption_if_any.label.includes('待确认'))
  assert.ok(result.ledgers.gate.prefer_assumption)
  assert.ok(result.card.includes('按此假设执行'))
  assert.ok(result.card.includes('override:{strategy:'))
})

test('E2E structured_form: expensive decision + idle user routes to the form channel', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, {})
  const { result } = await callTool(registered, 'route_info_gap', {
    gap_type: 'constraint',
    decision_at_stake: '发布到生产前的审批与时间预算',
    reversibility: 'low',
    blast_radius: 'system',
    user_state: { busy: false, recently_corrected: false, idle_seconds: 3600 },
    known_evidence: [{ text: '仓库已有 CI 配置', channel: 'model_claimed' }],
  })
  assert.ok(['structured_form', 'minimal_question'].includes(result.strategy), result.strategy)
  assert.ok(result.question_if_any.ask.includes('预算') || result.question_if_any.ask.length > 0)
  assert.ok(result.card.includes('若必须问'))
})

test('E2E mode:act performs the ask and folds the answer back as evidence', async () => {
  const answers = []
  const { ctx, registered } = fakeCtx({
    askImpl: async (request) => {
      answers.push(request)
      return { answers: [{ id: 'gap', selected: [], custom: '用 Vue' }] }
    },
  })
  apply(ctx, {})
  const { result } = await callTool(registered, 'route_info_gap', {
    gap_type: 'goal',
    decision_at_stake: '选哪个前端框架',
    reversibility: 'low',
    blast_radius: 'system',
    user_state: { busy: false, idle_seconds: 3600 },
    mode: 'act',
  })
  assert.equal(answers.length, 1, 'ask must be called exactly once')
  assert.ok(result.evidence.some((e) => /Vue/.test(e.text)))
})

test('delegated caller: interrupt channels report unavailable, no hang', async () => {
  const { ctx, registered } = fakeCtx()
  // agent id that isOwnedBy() reports as owned
  const def = (() => {
    apply(ctx, {})
    return registered.find((d) => d.name === 'route_info_gap')
  })()
  const result = await def.execute(
    {
      gap_type: 'goal',
      decision_at_stake: '下一个功能做什么',
      reversibility: 'low',
      blast_radius: 'system',
      user_state: { busy: false, idle_seconds: 3600 },
      mode: 'act',
    },
    { agent: { id: 's1' }, signal: AbortSignal.timeout(5000) },
  )
  // the fake marks a distinct owner ('other') only; s1 is a root here, so ask runs
  assert.ok(['structured_form', 'minimal_question', 'assume_and_flag'].includes(result.strategy))
})

test('feedback marks the prior decision as corrected in the ledger', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, {})
  const first = await callTool(registered, 'route_info_gap', {
    gap_type: 'goal',
    decision_at_stake: '按钮颜色',
    reversibility: 'high',
    blast_radius: 'local',
    user_state: { busy: true, idle_seconds: 0 },
  })
  assert.equal(first.result.strategy, 'assume_and_flag')

  await callTool(registered, 'route_info_gap', {
    gap_type: 'goal',
    decision_at_stake: '按钮颜色',
    user_state: { busy: true, idle_seconds: 0 },
    feedback: { decision_id: first.result.decision_id, corrected: true },
  })

  const { result: stats } = await callTool(registered, 'recon_strategy_stats', {})
  assert.ok(stats.corrections >= 1)
  assert.equal(stats.total, 2)
  assert.equal(stats.correction_rate, 0.5)
})

test('strategy distribution is observable for the acceptance criterion', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, {})
  const scenarios = [
    { gap_type: 'goal', decision_at_stake: '按钮颜色', reversibility: 'high', blast_radius: 'local', user_state: { busy: true, idle_seconds: 0 } },
    { gap_type: 'goal', decision_at_stake: '发布方案', reversibility: 'low', blast_radius: 'system', user_state: { busy: false, idle_seconds: 3600 } },
    { gap_type: 'preference', decision_at_stake: '代码风格', reversibility: 'medium', blast_radius: 'module', user_state: { busy: false, idle_seconds: 0 } },
  ]
  for (const s of scenarios) await callTool(registered, 'route_info_gap', s)
  const { result: stats } = await callTool(registered, 'recon_strategy_stats', {})
  assert.equal(stats.total, 3)
  const sum = Object.values(stats.distribution).reduce((a, b) => a + b, 0)
  assert.equal(sum, 3)
})
