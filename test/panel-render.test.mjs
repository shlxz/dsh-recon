// Panel rendering contract — locks the three decisions the user ruled on.
//
//   1. distribution bars: horizontal, width = count/total, colours ONLY from
//      --dsw-* tokens, mapped by semantic family, never a hard-coded value.
//   2. correction badge: `⚠ N` (never dots), same glyph at every count; N >= 2
//      is visually distinct from N = 1 because that is the discount threshold.
//   3. text: hard-coded Chinese, but every string lives in one STRINGS object
//      referenced as STRINGS.x — the locale seam, not an i18n implementation.
//
// lib/client.js is a browser bundle, so these evaluate it against a fake
// __ModuleLoader__ and a minimal React stub.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

// Source assertions must run against CODE, not prose: a comment that names an
// API we deliberately avoid would otherwise read as a usage. (This exact false
// positive bit this suite twice on other symbols.)
const CODE_ONLY = SOURCE.replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1')

/** Load the bundle, run apply(), and return helpers to render the panel. */
function load({ snapshot = null } = {}) {
  const registrations = []
  const fetched = []

  // Minimal React stub that also keeps a hook slot so useSyncExternalStore works.
  const reactStub = {
    createElement(type, props, ...children) {
      // Function component: invoke it the way React would and return whatever it
      // produced. Wrapping the result in another element would leave the tree
      // stopping at the component reference (the panel composes
      // Panel → TimelineRow → CorrectionBadge → DistributionBars).
      if (typeof type === 'function') {
        const produced = type(props || {}, children)
        if (produced && typeof produced === 'object' && produced.type !== undefined) return produced
        return { type: 'fragment', props: {}, children: [produced] }
      }
      const flat = []
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child.flat(Infinity).filter((c) => c != null && c !== false))
        else if (child != null && child !== false) flat.push(child)
      }
      return { type, props: props || {}, children: flat }
    },
    Fragment: 'Fragment',
    // The production path uses these two, so the stub must provide them. Hooks
    // are no-ops here: render assertions pass a snapshot explicitly.
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useSyncExternalStore(subscribe, getSnapshot) {
      return getSnapshot()
    },
  }

  let exported = null
  const windowStub = {
    __ModuleLoader__: {
      load({ factory }) {
        exported = factory((name) => {
          if (name === 'react') return reactStub
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
  }

  const fetchStub = async (url, init) => {
    fetched.push({ url, init })
    return { ok: true, json: async () => ({ ok: true, snapshot }) }
  }

  const run = new Function(
    'window',
    'fetch',
    'AbortController',
    'console',
    `"use strict";\n${SOURCE}`,
  )
  run(windowStub, fetchStub, AbortController, console)
  assert.ok(exported, 'client bundle must export a module')

  const slots = {
    inject: (_name, callback) => callback(),
    register(meta, render) {
      registrations.push({ meta, render })
      return () => {}
    },
  }

  const tabTypes = []

  exported.apply({
    slots,
    inject: (deps, callback) =>
      callback({
        sidebarRightTabs: {
          register(def) {
            tabTypes.push(def)
            return () => {}
          },
        },
      }),
    effect: (fn) => {
      fn()
      return () => {}
    },
    logger: () => ({ warn() {} }),
  })

  const body = registrations.find((r) => r.meta.name === 'sidebar.right.pane.tab')
  assert.ok(body, 'tab body must register')
  // `render` returns h(Panel, props); render it directly for structural asserts.
  const Panel = exported.__test.Panel
  return { body, registrations, fetched, exported, Panel, tabTypes }
}

/** Render the panel component itself with a snapshot. */
function renderPanel(env, props = {}) {
  return env.Panel({ sessionId: 's1', ...props })
}

/** Walk a stub element tree and collect every style / prop value. */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

/**
 * Collect every text leaf in the subtree. `walk` visits only OBJECT nodes, so
 * string children never reach its visitor — collecting text through walk drops
 * anything nested one level deeper, which is exactly how heading labels are laid
 * out (label and total are sibling spans).
 */
function allText(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(allText).filter(Boolean).join(' ')
  if (!node || typeof node !== 'object') return ''
  return (node.children || []).map(allText).filter(Boolean).join(' ')
}

// ---- 1. distribution bars -------------------------------------------------------

test('distribution renders one horizontal bar per channel, width = count/total', async () => {
  const snapshot = {
    total: 4,
    corrected: 0,
    distribution: { read_trace: 2, assume_and_flag: 2 },
    decisions: [],
  }
  // decisions non-empty so the panel renders the full body, not the empty state
  snapshot.decisions = [{ decision_id: 'rc_1', gap_type: 'goal', strategy: 'read_trace', corrected: false }]

  const env = load({ snapshot })
  // The poll resolves asynchronously; drive the store directly instead.
  const panel = renderPanel(env, { snapshot })

  const bars = []
  walk(panel, (n) => {
    if (n.props && n.props['data-channel']) bars.push(n)
  })
  assert.equal(bars.length, 6, 'six channels, six bars — no legend needed')

  // Every channel is present even at zero.
  const channels = bars.map((b) => b.props['data-channel'])
  for (const key of ['read_trace', 'query_sensor', 'read_multimodal', 'structured_form', 'minimal_question', 'assume_and_flag']) {
    assert.ok(channels.includes(key), `missing bar for ${key}`)
  }

  // Width equals count/total: read_trace 2/4 = 50%.
  const readTrace = bars.find((b) => b.props['data-channel'] === 'read_trace')
  // The fill is the deepest node carrying a percentage width.
  let fill = null
  walk(readTrace, (n) => {
    const w = n.props?.style?.width
    if (typeof w === 'string' && w.endsWith('%')) fill = n
  })
  assert.ok(fill, 'the bar must contain a proportional fill')
  assert.equal(fill.props.style.width, '50%')
})

test('a channel with zero count still renders, at reduced opacity', () => {
  const snapshot = {
    total: 1,
    distribution: { read_trace: 1 },
    decisions: [{ decision_id: 'rc_1', gap_type: 'goal', strategy: 'read_trace', corrected: false }],
  }
  const env = load({ snapshot })
  const panel = renderPanel(env, { snapshot })

  const bars = []
  walk(panel, (n) => {
    if (n.props && n.props['data-channel']) bars.push(n)
  })
  const zero = bars.find((b) => b.props['data-channel'] === 'query_sensor')
  assert.ok(zero, 'a zero-count channel must still occupy its row')
  let fill = null
  walk(zero, (n) => {
    const w = n.props?.style?.width
    if (typeof w === 'string' && w.endsWith('%')) fill = n
  })
  assert.ok(fill)
  assert.equal(fill.props.style.width, '0%')
  assert.equal(fill.props.style.opacity, 0.25)
})

test('bar colours come only from --dsw-* tokens, never a hard-coded colour', () => {
  const snapshot = {
    total: 2,
    distribution: { read_trace: 1, assume_and_flag: 1 },
    decisions: [{ decision_id: 'rc_1', gap_type: 'goal', strategy: 'assume_and_flag', corrected: false }],
  }
  const env = load({ snapshot })
  const panel = renderPanel(env, { snapshot })

  const colours = []
  walk(panel, (n) => {
    const style = n.props && n.props.style
    if (!style) return
    for (const [k, v] of Object.entries(style)) {
      if (typeof v === 'string' && /#|rgb|hsl/i.test(v)) colours.push(`${k}=${v}`)
    }
  })
  assert.deepEqual(colours, [], `hard-coded colours found: ${colours.join(', ')}`)

  // And the token mapping itself must be present.
  const tokens = []
  walk(panel, (n) => {
    const style = n.props && n.props.style
    if (!style) return
    for (const v of Object.values(style)) {
      if (typeof v === 'string' && v.includes('--dsw-')) tokens.push(v)
    }
  })
  assert.ok(tokens.length > 0, 'colours must reference --dsw-* variables')
})

test('channel → semantic token mapping matches the ruling', () => {
  const snapshot = {
    total: 6,
    distribution: {},
    decisions: [],
  }
  const env = load({ snapshot })
  // Render one row of each strategy through the timeline.
  const decisions = [
    { decision_id: 'a', gap_type: 'goal', strategy: 'assume_and_flag', corrected: false, assumption_cost: 1, interrupt_cost: 0.5 },
    { decision_id: 'b', gap_type: 'goal', strategy: 'minimal_question', corrected: false, assumption_cost: 1, interrupt_cost: 0.5 },
    { decision_id: 'c', gap_type: 'goal', strategy: 'read_trace', corrected: false, assumption_cost: 1, interrupt_cost: 0.5 },
    { decision_id: 'd', gap_type: 'goal', strategy: 'structured_form', corrected: false, assumption_cost: 1, interrupt_cost: 0.5 },
  ]
  const panel = renderPanel(env, { snapshot: { total: 4, distribution: {}, decisions } })

  const borderFor = (strategy) => {
    let found = null
    walk(panel, (n) => {
      if (n.props && n.props['data-strategy'] === strategy) found = n
    })
    return found?.props?.style?.borderLeft || ''
  }

  // warn family for assumption, brand for the single question, success for trace,
  // neutral for the form. Assert the FAMILY, not an exact token name.
  assert.match(borderFor('assume_and_flag'), /state-warn/)
  assert.match(borderFor('minimal_question'), /brand/)
  assert.match(borderFor('read_trace'), /state-success/)
  assert.match(borderFor('structured_form'), /state-idle|label-secondary/)
})

// ---- 2. correction badge --------------------------------------------------------

test('correction badge is `⚠ N`, never dots', () => {
  const decisions = [
    { decision_id: 'a', gap_type: 'goal', strategy: 'assume_and_flag', corrected: true, prior_failures: 1, assumption_cost: 1, interrupt_cost: 0.5 },
    { decision_id: 'b', gap_type: 'goal', strategy: 'assume_and_flag', corrected: true, prior_failures: 2, assumption_cost: 1, interrupt_cost: 0.5 },
  ]
  const env = load()
  const panel = renderPanel(env, { snapshot: { total: 2, distribution: {}, decisions } })

  const badges = []
  walk(panel, (n) => {
    if (n.props && typeof n.props.className === 'string' && n.props.className.includes('dsh-recon-badge')) badges.push(n)
  })
  assert.equal(badges.length, 2, 'every corrected row carries a badge')

  for (const badge of badges) {
    const text = (badge.children || []).join(' ')
    assert.match(text, /⚠\s*\d/, `badge must show the count: got "${text}"`)
    assert.doesNotMatch(text, /^[•·▫▪.]$/, 'dots carry no quantity and must not be used')
  }

  // The number is the meaning: N=1 and N=2 must be distinguishable.
  // The panel renders newest-first, so the input order is reversed on screen.
  const texts = badges.map((b) => (b.children || []).join(' '))
  assert.ok(texts.some((t) => t.includes('1') && !t.includes('2')), `N=1 badge missing: ${texts.join(' | ')}`)
  assert.ok(texts.some((t) => t.includes('2')), `N=2 badge missing: ${texts.join(' | ')}`)
})

test('N=1 is visually distinct from N>=2 without changing the glyph', () => {
  const decisions = [
    { decision_id: 'a', gap_type: 'goal', strategy: 'assume_and_flag', corrected: true, prior_failures: 1, assumption_cost: 1, interrupt_cost: 0.5 },
    { decision_id: 'b', gap_type: 'goal', strategy: 'assume_and_flag', corrected: true, prior_failures: 2, assumption_cost: 1, interrupt_cost: 0.5 },
  ]
  const env = load()
  const panel = renderPanel(env, { snapshot: { total: 2, distribution: {}, decisions } })

  const badges = []
  walk(panel, (n) => {
    if (n.props && typeof n.props.className === 'string' && n.props.className.includes('dsh-recon-badge')) badges.push(n)
  })
  assert.equal(badges.length, 2)

  // Newest-first: prior_failures 2 is rendered before 1.
  const [atOrAbove, below] = badges.map((b) => b.props.style)
  // Below threshold: dimmed, regular weight. At threshold: full opacity, bold.
  assert.ok(below.opacity < 1, 'N=1 must be dimmed (below the discount threshold)')
  assert.equal(below.fontWeight, 400)
  assert.equal(atOrAbove.opacity, 1, 'N>=2 must be at full strength')
  assert.equal(atOrAbove.fontWeight, 600)

  // Same glyph in both cases — a symbol swap would cost the reader a re-learn.
  const glyphs = badges.map((b) => ((b.children || []).join(' ')).trim()[0])
  assert.equal(glyphs[0], glyphs[1], 'the glyph must not change with the count')
})

test('uncorrected rows carry no correction badge', () => {
  const decisions = [
    { decision_id: 'a', gap_type: 'goal', strategy: 'assume_and_flag', corrected: false, prior_failures: 0, assumption_cost: 1, interrupt_cost: 0.5 },
  ]
  const env = load()
  const panel = renderPanel(env, { snapshot: { total: 1, distribution: {}, decisions } })
  let badges = 0
  walk(panel, (n) => {
    if (n.props && typeof n.props.className === 'string' && n.props.className.includes('dsh-recon-badge')) badges += 1
  })
  assert.equal(badges, 0)
})

// ---- 3. strings seam ------------------------------------------------------------

test('every visible string lives in one STRINGS object (locale seam)', () => {
  // The panel code must reference STRINGS.x rather than inline literals.
  assert.match(SOURCE, /const STRINGS = \{/, 'a single flat STRINGS object must exist')

  // Extract the whole object: from `const STRINGS = {` to its matching closing
  // brace at the same indentation. A naive "first }" cut stops inside the object.
  const start = SOURCE.indexOf('const STRINGS = {')
  assert.ok(start > 0)
  let depth = 0
  let end = -1
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1
    else if (SOURCE[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  assert.ok(end > 0, 'STRINGS object must be balanced')
  const stringsBlock = SOURCE.slice(start, end)
  // The flat object holds the strings the panel shows.
  for (const key of ['title', 'emptied', 'timelineLabel', 'distributionLabel', 'correctedBadge', 'noDistribution']) {
    assert.match(stringsBlock, new RegExp(`${key}:`), `STRINGS must define ${key}`)
  }

  // Chinese prose must not be inlined in render functions: every CJK literal
  // outside the STRINGS / channel-label tables would break the seam.
  const outsideTables = SOURCE
    .replace(stringsBlock, '')
    .replace(/const CHANNEL_META = \{[\s\S]*?\n {4}\}/, '')
  const cjkLiterals = outsideTables.match(/'[^']*[\u4e00-\u9fff][^']*'/g) || []
  assert.deepEqual(cjkLiterals, [], `inlined CJK literals outside STRINGS: ${cjkLiterals.join(', ')}`)
})

test('empty snapshot renders the empty state, not a crash', () => {
  const env = load()
  const panel = renderPanel(env, { snapshot: null })
  assert.equal(panel.props['data-empty'], 'true')
  const text = allText(panel)
  assert.ok(text.includes('Recon'), 'the header is always visible')
})

test('rendering never fetches: data arrives by prop only', () => {
  const env = load()
  const before = env.fetched.length
  renderPanel(env, { snapshot: { total: 0, distribution: {}, decisions: [] } })
  renderPanel(env, { snapshot: { total: 1, distribution: {}, decisions: [{ decision_id: 'x', gap_type: 'goal', strategy: 'read_trace', corrected: false }] } })
  assert.equal(env.fetched.length, before, 'render must be pure: no fetch inside it')
})

// ---- 5. the four visual/config tweaks -------------------------------------------

test('timeline cards sit 6px apart while inner lines stay 4px', () => {
  const decisions = [
    { decision_id: 'a', gap_type: 'goal', strategy: 'read_trace', corrected: false, assumption_cost: 1, interrupt_cost: 0.5 },
  ]
  const env = load()
  const panel = renderPanel(env, { snapshot: { total: 1, distribution: { read_trace: 1 }, decisions } })

  let row = null
  walk(panel, (n) => {
    if (n.props && n.props['data-strategy'] === 'read_trace') row = n
  })
  assert.ok(row)
  assert.equal(row.props.style.marginBottom, 6, 'cards need 6px of breathing room')

  // Inner text lines: 4px each. Counting proves the two spacings stay distinct.
  const innerTops = []
  walk(row, (n) => {
    const mt = n.props?.style?.marginTop
    if (typeof mt === 'number' && mt > 0) innerTops.push(mt)
  })
  assert.ok(innerTops.length >= 2, 'the card stacks several inner lines')
  for (const mt of innerTops) {
    assert.equal(mt, 4, `inner line spacing must stay 4px, got ${mt}`)
  }
})

test('the distribution heading carries the total on the right', () => {
  const snapshot = {
    total: 3,
    distribution: { read_trace: 1, structured_form: 1, assume_and_flag: 1 },
    decisions: [{ decision_id: 'x', gap_type: 'goal', strategy: 'read_trace', corrected: false }],
  }
  const env = load()
  const panel = renderPanel(env, { snapshot })

  // Find the flex holder whose subtree mentions the label AND a total: that is
  // the heading row, not the inner span that carries the label alone.
  let heading = null
  walk(panel, (n) => {
    const text = allText(n)
    if (/策略分布/.test(text) && /total\s*\d/.test(text)) heading = n
  })
  assert.ok(heading, 'the distribution heading row must exist')
  assert.match(allText(heading), /策略分布/, 'the label')
  assert.match(allText(heading), /total\s*3/, 'the total count sits beside the label')

  // The number must be the same denominator the bars divide by.
  const sum = Object.values(snapshot.distribution).reduce((a, b) => a + b, 0)
  assert.equal(sum, 3)
})

test('guide order is 15 (near the top of the sidebar list)', () => {
  const { tabTypes } = load()
  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].guide[0].order, 15, 'a low order places the tab early')
})

test('the badge row cannot wrap: label ellipsises, badge stays put', () => {
  const decisions = [
    {
      decision_id: 'a',
      gap_type: 'goal',
      strategy: 'assume_and_flag',
      corrected: true,
      prior_failures: 2,
      assumption_cost: 1,
      interrupt_cost: 0.5,
    },
  ]
  const env = load()
  const panel = renderPanel(env, { snapshot: { total: 1, distribution: {}, decisions } })

  let row = null
  walk(panel, (n) => {
    if (n.props && n.props['data-strategy'] === 'assume_and_flag') row = n
  })
  assert.ok(row)

  // The flex holder of [label, badge] must be nowrap.
  let holder = null
  walk(row, (n) => {
    const s = n.props?.style
    if (s && s.display === 'flex' && s.justifyContent === 'space-between' && s.flexWrap === 'nowrap') holder = n
  })
  assert.ok(holder, 'the badge holder must be an explicit nowrap flex row')

  // The label is the flexible side: it truncates instead of pushing the badge.
  const labels = []
  walk(holder, (n) => {
    const s = n.props?.style
    if (s && s.whiteSpace === 'nowrap' && s.textOverflow === 'ellipsis') labels.push(n)
  })
  assert.ok(labels.length >= 1, 'the channel label must ellipsise, not wrap')

  // And the badge itself is nowrap (already true) — assert it here too so the
  // pair is covered by one test.
  let badge = null
  walk(row, (n) => {
    if (n.props && typeof n.props.className === 'string' && n.props.className.includes('dsh-recon-badge')) badge = n
  })
  assert.equal(badge.props.style.whiteSpace, 'nowrap')
})

test('the panel subscribes to the store instead of reading it once', () => {
  // The regression this guards: `typeof useSyncExternalStore === 'function'
  // ? … : store.getSnapshot()` reads the store ONCE with no subscription, so the
  // panel paints empty and never repaints when the poll finally delivers data.
  // That is indistinguishable from "no data" at runtime, so it must be asserted
  // at the source and at the mechanism level.
  assert.doesNotMatch(CODE_ONLY, /useSyncExternalStore/, 'do not depend on an unverified React API')
  assert.match(CODE_ONLY, /store\.subscribe\(/, 'the panel must subscribe to the store')
  assert.match(CODE_ONLY, /useState\(store\.getSnapshot\(\)\)/, 'seed from the live store')

  // Drive it for real: the store must notify its subscribers on change.
  const store = createStoreForTest()
  let notifications = 0
  const unsubscribe = store.subscribe(() => {
    notifications += 1
  })

  assert.equal(store.getSnapshot(), null, 'starts empty')
  store.set({
    total: 1,
    corrected: 0,
    distribution: { read_trace: 1 },
    decisions: [{ decision_id: 'rc_x', gap_type: 'goal', strategy: 'read_trace', corrected: false }],
  })
  assert.equal(notifications, 1, 'a delivered snapshot must notify the panel')
  assert.equal(store.getSnapshot().total, 1)

  // Identical payloads must not repaint: the panel polls every few seconds.
  store.set({
    total: 1,
    corrected: 0,
    distribution: { read_trace: 1 },
    decisions: [{ decision_id: 'rc_x', gap_type: 'goal', strategy: 'read_trace', corrected: false }],
  })
  assert.equal(notifications, 1, 'an unchanged snapshot must not notify')

  unsubscribe()
  store.set({ total: 2 })
  assert.equal(notifications, 1, 'unsubscribed listeners stay silent')
})

/** Extract createSnapshotStore from the bundle source and instantiate it. */
function createStoreForTest() {
  const start = SOURCE.indexOf('function createSnapshotStore()')
  const end = SOURCE.indexOf('function createSnapshotPanel')
  assert.ok(start > 0 && end > start, 'createSnapshotStore must precede createSnapshotPanel')
  const body = SOURCE.slice(start, end)
  const reactStub = { createElement: () => null }
  const requireStub = () => reactStub
  return new Function('require', `${body}\nreturn createSnapshotStore()`)(requireStub)
}
