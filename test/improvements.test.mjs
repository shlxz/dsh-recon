// Three improvements that came out of the "what does this actually do" review:
//
//   1. read_trace now reads the WORKSPACE's own conventions, because the real
//      failure is not "the AI asked too much" — it is "the AI built something
//      that did not match the repository". Asking the user is the expensive fix;
//      reading package.json / AGENTS.md / the directory layout is the cheap one.
//   2. An obviously cheap decision skips reconnaissance entirely. Three probes
//      before announcing arithmetic is ceremony, and the review measured it.
//   3. The prompt section shrank. It is re-sent every turn, so its size is a
//      permanent tax.

import assert from 'node:assert/strict'
import test from 'node:test'

import { conventionsFromManifest, conventionsFromInstructions, createProjectProbe } from '../lib/adapters/project.js'
import { route } from '../lib/router.js'
import { normalizeInput } from '../lib/adapters/contract.js'
import { apply } from '../lib/index.js'

// ---- 1. project conventions -----------------------------------------------------

test('conventionsFromManifest reports the stack, not the whole file', () => {
  const facts = conventionsFromManifest({
    type: 'module',
    main: 'lib/index.js',
    scripts: { test: 'node --test', build: 'tsc', start: 'node .' },
    devDependencies: { vitest: '^1', typescript: '^5', eslint: '^9' },
    packageManager: 'pnpm@9',
  })
  const text = facts.join('；')
  assert.match(text, /ESM/)
  assert.match(text, /vitest/)
  assert.match(text, /TypeScript/)
  assert.match(text, /eslint/)
  assert.match(text, /pnpm/)
  // `start` is not a convention this probe cares about.
  assert.doesNotMatch(text, /可用脚本: .*start/)
})

test('conventionsFromManifest says nothing when the manifest says nothing', () => {
  assert.deepEqual(conventionsFromManifest({}), [])
  assert.deepEqual(conventionsFromManifest(null), [])
})

test('conventionsFromInstructions quotes one line, not an essay', () => {
  const text = [
    '# 项目约定',
    '',
    '所有新增代码用 4 空格缩进，不要用 tab。',
    '测试放在 test/ 目录，文件名以 .test.mjs 结尾。',
    '这里是另外十行说明……',
  ].join('\n')
  const facts = conventionsFromInstructions(text, 'AGENTS.md')
  assert.equal(facts.length, 1, 'one quotable line per instruction file')
  assert.match(facts[0], /4 空格缩进/)
})

test('the project probe reads a fake workspace end to end', async () => {
  const tree = {
    'package.json': JSON.stringify({
      type: 'module',
      devDependencies: { vitest: '^1', typescript: '^5' },
      scripts: { test: 'node --test' },
    }),
    'AGENTS.md': '# 约定\n\n所有导出必须有 JSDoc 注释。\n',
  }
  const dirs = new Set(['src', 'tests', '.github'])

  const fs = {
    resolve: async (p) => ({ path: p }),
    // Real entries carry names without trailing slashes; `listDir` is not `ls -F`.
    listDir: async () => [...Object.keys(tree), ...dirs].map((name) => ({ name })),
    readText: async (target) => {
      const name = target.path.split('/').pop()
      if (tree[name] === undefined) throw new Error('not a file')
      return tree[name]
    },
  }
  const ctx = {
    get: (k) =>
      k === 'fs'
        ? fs
        : k === 'workingDirectory'
          ? { get: () => '/repo', defaultDirectory: '/repo' }
          : k === 'sessions'
            ? { get: () => ({ id: 's1' }) }
            : undefined,
  }

  const probe = await createProjectProbe({ ctx, agent: { id: 's1' } }).probe({})
  assert.ok(probe.evidence.length >= 2, 'manifest + instructions + layout should yield evidence')

  const joined = probe.evidence.map((e) => e.text).join(' | ')
  assert.match(joined, /ESM/, 'stack from the manifest')
  assert.match(joined, /src/, 'layout')
  assert.match(joined, /AGENTS\.md/, 'the instruction file is the strongest signal')
  for (const item of probe.evidence) {
    assert.equal(item.channel, 'read_trace')
    assert.ok(item.weight > 0, 'evidence must carry a weight')
  }
})

test('the project probe degrades instead of throwing when fs is absent', async () => {
  const probe = await createProjectProbe({ ctx: { get: () => undefined }, agent: { id: 's1' } }).probe({})
  assert.equal(probe.evidence.length, 0)
  assert.ok(probe.notes.length > 0, 'the reason must be recorded, not swallowed')
})

test('an empty workspace is a note, not a crash', async () => {
  const fs = {
    resolve: async (p) => ({ path: p }),
    listDir: async () => [],
    readText: async () => '',
  }
  const ctx = {
    get: (k) =>
      k === 'fs' ? fs : k === 'workingDirectory' ? { get: () => '/empty', defaultDirectory: '/empty' } : k === 'sessions' ? { get: () => ({ id: 's' }) } : undefined,
  }
  const probe = await createProjectProbe({ ctx, agent: { id: 's' } }).probe({})
  assert.equal(probe.evidence.length, 0)
  assert.match(probe.notes.join(' '), /no manifest|no readable convention/)
})

// ---- 2. obvious-assume skips reconnaissance -------------------------------------

function counting(available = false) {
  const calls = []
  const mk = (channel) => ({
    channel,
    async probe() {
      calls.push(channel)
      return available ? { available: true, evidence: [] } : { available: false, reason: 'n/a' }
    },
  })
  return {
    calls,
    adapters: [
      mk('read_trace'),
      mk('query_sensor'),
      mk('read_multimodal'),
      { channel: 'structured_form', async probe() { return { available: true } } },
      { channel: 'minimal_question', async probe() { return { available: true } } },
      { channel: 'assume_and_flag', async probe() { return { available: true } } },
    ],
  }
}

test('an obviously cheap decision probes nothing', async () => {
  const { calls, adapters } = counting()
  const r = await route(
    normalizeInput({
      gap_type: 'preference',
      decision_at_stake: '按钮颜色',
      reversibility: 'high',
      blast_radius: 'local',
      user_state: { busy: true, idle_seconds: 0 },
    }),
    adapters,
    null,
    {},
  )
  assert.equal(r.strategy, 'assume_and_flag')
  assert.equal(calls.length, 0, 'no reconnaissance for settled arithmetic')
  assert.match(r.rationale, /skip reconnaissance/)
})

test('a decision near the boundary still runs the evidence channels', async () => {
  const { calls, adapters } = counting()
  const r = await route(
    normalizeInput({
      gap_type: 'constraint',
      decision_at_stake: '发布流程',
      reversibility: 'low',
      blast_radius: 'system',
      user_state: { busy: false, idle_seconds: 3600 },
    }),
    adapters,
    null,
    {},
  )
  assert.ok(calls.length >= 3, `near-boundary decisions must still look (probed ${calls.join(',')})`)
  assert.ok(['structured_form', 'minimal_question', 'assume_and_flag', 'read_trace'].includes(r.strategy))
})

test('the shortcut is configurable, and 0 disables it', async () => {
  const { calls, adapters } = counting()
  const r = await route(
    normalizeInput({
      gap_type: 'preference',
      decision_at_stake: '按钮颜色',
      reversibility: 'high',
      blast_radius: 'local',
      user_state: { busy: true, idle_seconds: 0 },
    }),
    adapters,
    null,
    { policy: { obviousAssumptionRatio: 0 } },
  )
  // With the shortcut off, the old path runs: it probes, finds nothing, and
  // still ends up assuming — but the reasoning is recorded instead of skipped.
  assert.equal(r.strategy, 'assume_and_flag')
  assert.ok(calls.length >= 3, 'disabled shortcut must restore reconnaissance')
})

test('an explicit override is not affected by the shortcut', async () => {
  const { calls, adapters } = counting()
  const r = await route(
    normalizeInput({
      gap_type: 'preference',
      decision_at_stake: '按钮颜色',
      reversibility: 'high',
      blast_radius: 'local',
      user_state: { busy: true, idle_seconds: 0 },
      override: { strategy: 'read_trace', reason: 'forced' },
    }),
    adapters,
    null,
    {},
  )
  assert.equal(r.strategy, 'read_trace', 'the forced channel still runs')
  assert.ok(calls.includes('read_trace'))
})

// ---- 3. prompt size -------------------------------------------------------------

test('the prompt section stays under 200 estimated tokens', () => {
  // It is re-sent every model call of every turn, so its size is a permanent tax.
  // The review found it had grown to 286; the recognition value does not need that.
  const sections = []
  const services = new Map()
  services.set('tools', { get: () => undefined })
  const ctx = {
    get: (k) => services.get(k),
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    inject: (_deps, cb) => cb(ctx),
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    webServer: { register: () => () => {} },
    logger: () => ({ warn() {} }),
    tools: { register: () => () => {} },
  }
  apply(ctx, {})
  const text = sections[0].text()
  const approxTokens = Math.ceil(text.length / 2.5)
  assert.ok(approxTokens < 200, `section is ~${approxTokens} tokens; the budget is 200`)
})

test('the shortened section still carries every trigger and the contract', () => {
  const sections = []
  const services = new Map()
  services.set('tools', { get: () => undefined })
  const ctx = {
    get: (k) => services.get(k),
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    inject: (_deps, cb) => cb(ctx),
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    webServer: { register: () => () => {} },
    logger: () => ({ warn() {} }),
    tools: { register: () => () => {} },
  }
  apply(ctx, {})
  const text = sections[0].text()
  assert.match(text, /route_info_gap/)
  assert.match(text, /游戏/)
  assert.match(text, /assumed_value/)
  assert.match(text, /不必调/)
  assert.match(text, /assume_and_flag/)
})

test('read_trace actually surfaces workspace conventions end to end', async () => {
  // The unit tests above prove the probe works in isolation. This one proves the
  // probe is WIRED INTO the channel — without it, disabling the wiring silently
  // removed the only evidence source that can see the repository.
  const { createTraceAdapter } = await import('../lib/adapters/trace.js')

  const tree = {
    'package.json': JSON.stringify({
      type: 'module',
      devDependencies: { vitest: '^1' },
      scripts: { test: 'node --test' },
    }),
    'AGENTS.md': '# 约定\n\n新增代码用 4 空格缩进。\n',
  }
  const fs = {
    resolve: async (p) => ({ path: p }),
    listDir: async () => [...Object.keys(tree), 'src'].map((name) => ({ name })),
    readText: async (target) => {
      const name = target.path.split('/').pop()
      if (tree[name] === undefined) throw new Error('not a file')
      return tree[name]
    },
  }
  const ctx = {
    get: (k) =>
      k === 'fs'
        ? fs
        : k === 'workingDirectory'
          ? { get: () => '/repo', defaultDirectory: '/repo' }
          : k === 'sessions'
            ? { get: () => ({ id: 's1' }) }
            : undefined,
  }

  const adapter = createTraceAdapter({ ctx, agent: { id: 's1' }, config: {}, ledger: null })
  const probe = await adapter.probe(normalizeInput({ gap_type: 'preference', decision_at_stake: '代码风格' }))

  assert.equal(probe.available, true)
  const joined = probe.evidence.map((e) => e.text).join(' | ')
  assert.match(joined, /ESM|vitest/, 'manifest conventions must reach the channel')
  assert.match(joined, /4 空格缩进/, 'the instruction file must reach the channel')

  // And the opt-out must actually turn it off.
  const off = createTraceAdapter({
    ctx,
    agent: { id: 's1' },
    config: { readProjectConventions: false },
    ledger: null,
  })
  const suppressed = await off.probe(normalizeInput({ gap_type: 'preference', decision_at_stake: '代码风格' }))
  const after = suppressed.evidence.map((e) => e.text).join(' | ')
  assert.doesNotMatch(after, /4 空格缩进/, 'readProjectConventions:false must disable it')
})
