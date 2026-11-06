// Scenario walk: prints the three runnable channels end-to-end plus the
// strategy distribution, so the acceptance check has a concrete baseline.
// Run: node tools/scenarios.mjs

import { apply } from '../lib/index.js'

function fakeCtx({ sessionMessages = [], settledQuestions = [], askImpl = null } = {}) {
  const registered = []
  const services = new Map()
  const surfaceEvents = sessionMessages.map((text, i) => ({
    type: 'user/message',
    seq: i + 1,
    time: 0,
    data: { message: { role: 'user', content: [{ type: 'text', text }] } },
  }))
  services.set('sessionQuery', { async readSurface() { return { events: surfaceEvents } } })
  services.set('sessions', { get: (id) => (id === 's1' ? { id: 's1' } : undefined) })
  services.set('sessionProjections', {
    stateOf: () => ({ active: [], settled: settledQuestions }),
  })
  services.set('agents', { roots: () => [{ id: 's1' }], isOwnedBy: () => false })
  services.set('userQuestions', {
    async ask(r) { return askImpl ? askImpl(r) : { answers: [] } },
  })
  services.set('tools', { get: () => undefined })
  const ctx = {
    get: (k) => services.get(k),
    on: () => () => {},
    effect: () => {},
    logger: () => ({ warn() {} }),
    tools: { register(d) { registered.push(d); return () => {} } },
  }
  return { ctx, registered }
}

const scenarios = [
  ['read_trace', {
    gap_type: 'preference', decision_at_stake: '日期库选型',
    reversibility: 'high', blast_radius: 'local',
    user_state: { busy: false, idle_seconds: 600 },
  }, { sessionMessages: ['不要用 moment.js，改成 date-fns', '这个项目统一用 const'] }],
  ['structured_form', {
    gap_type: 'constraint', decision_at_stake: '发布到生产前的审批与时间预算',
    reversibility: 'low', blast_radius: 'system',
    user_state: { busy: false, idle_seconds: 3600 },
    known_evidence: [{ text: '仓库已有 CI 配置', channel: 'model_claimed' }],
  }, {}],
  ['assume_and_flag', {
    gap_type: 'goal', decision_at_stake: '这个按钮用哪个颜色',
    reversibility: 'high', blast_radius: 'local',
    user_state: { busy: true, idle_seconds: 0 },
  }, {}],
]

const results = []
for (const [label, args, env] of scenarios) {
  const { ctx, registered } = fakeCtx(env)
  apply(ctx, {})
  const def = registered.find((d) => d.name === 'route_info_gap')
  const r = await def.execute(args, { agent: { id: 's1' }, signal: AbortSignal.timeout(5000) })
  results.push(r)
  console.log(`\n${'='.repeat(60)}\n▶ ${label}\n${'='.repeat(60)}`)
  console.log(r.card)
  console.log(`\n[rationale]\n${r.rationale}`)
}

// one process-wide distribution across all three
const dist = {}
for (const r of results) dist[r.strategy] = (dist[r.strategy] || 0) + 1
console.log(`\n${'='.repeat(60)}\nstrategy 分布\n${'='.repeat(60)}`)
console.log(JSON.stringify(dist, null, 2))
