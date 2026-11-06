// Discoverability: a registered tool nobody thinks to call is dead weight.
//
// Real report that motivated this file: a user installed the plugin, asked for
// a Snake game, and never saw `route_info_gap` fire. The tool was registered and
// callable; the model simply had no reason to reach for it, because its
// description only applies when the model is ALREADY about to ask a question.
//
// The prompt section is the missing trigger. These tests keep it registered,
// keep it cheap, and keep it honest about when NOT to fire.

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

function fakeCtx({ withSystemPrompt = true, withWebServer = true } = {}) {
  const registered = []
  const sections = []
  const warnings = []
  const services = new Map()
  services.set('tools', { get: () => undefined })

  const ctx = {
    get: (k) => services.get(k),
    on: () => () => {},
    effect: (fn) => {
      fn()
      return () => {}
    },
    inject: (deps, callback) => {
      // Mirror the real Loader: a callback runs only when EVERY requested
      // dependency is available. The context under test can be missing either.
      if (!withSystemPrompt && deps.includes('systemPrompt')) return undefined
      if (!withWebServer && deps.includes('webServer')) return undefined
      return callback(ctx)
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    webServer: {
      register() {
        return () => {}
      },
    },
    logger: () => ({ warn: (...a) => warnings.push(a.join(' ')) }),
    tools: {
      register(d) {
        registered.push(d)
        return () => {}
      },
    },
  }
  return { ctx, registered, sections, warnings }
}

test('a prompt section is registered so the model knows when to reach for the tool', () => {
  const { ctx, registered, sections } = fakeCtx()
  apply(ctx, {})

  assert.ok(registered.some((d) => d.name === 'route_info_gap'), 'the tool still registers')
  assert.equal(sections.length, 1, 'exactly one guidance section')

  const s = sections[0]
  assert.equal(s.name, 'dsh-recon:routing')
  assert.equal(typeof s.order, 'number')
  assert.equal(s.interpolate, false, 'static prose: nothing to interpolate')
  assert.equal(typeof s.text, 'function', 'text is a provider, as the service expects')
})

test('the guidance names the real triggers, not just the tool name', () => {
  const { ctx, sections } = fakeCtx()
  apply(ctx, {})
  const text = sections[0].text()

  // It must fire on the exact case that failed: a whole thing to build whose
  // shape was never pinned down.
  assert.match(text, /route_info_gap/, 'names the tool')
  assert.match(text, /完整东西|页面|游戏/, 'names the "build me a whole thing" trigger')
  assert.match(text, /没说死|没说|不明/, 'names the under-specification trigger')
  assert.match(text, /你正准备向用户提问/, 'covers the ask-first case')
})

test('the guidance also says when NOT to fire', () => {
  // A section that only says "use this" trains the model to use it everywhere,
  // which is worse than never using it: every trivial task pays a tool call.
  const { ctx, sections } = fakeCtx()
  apply(ctx, {})
  const text = sections[0].text()
  assert.match(text, /什么时候不该调|不该调/, 'explicitly bounds the trigger')
  assert.match(text, /别为了用它而用它/, 'warns against ritual use')
})

test('the guidance explains the output contract', () => {
  // The model must know that assume_and_flag means "proceed and label", not
  // "ask anyway" — otherwise the gate is pointless.
  const { ctx, sections } = fakeCtx()
  apply(ctx, {})
  const text = sections[0].text()
  assert.match(text, /assume_and_flag/, 'explains the proceed-and-label outcome')
  assert.match(text, /minimal_question|structured_form/, 'explains the ask outcomes')
})

test('the section stays small enough to belong in every request', () => {
  // It is re-sent on every model call. An essay here is a permanent tax on
  // every turn of every session that has this plugin installed.
  const { ctx, sections } = fakeCtx()
  apply(ctx, {})
  const text = sections[0].text()
  const approxTokens = Math.ceil(text.length / 2.5) // CJK ≈ 2.5 chars/token
  assert.ok(approxTokens < 400, `section is ~${approxTokens} tokens; keep it under 400`)
})

test('a build without systemPrompt still registers the tool', () => {
  // Discoverability is optional; the capability is not. Failing to inject the
  // prompt service must not take the tool down with it.
  const { ctx, registered, warnings } = fakeCtx({ withSystemPrompt: false })
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.ok(registered.some((d) => d.name === 'route_info_gap'))
  assert.equal(warnings.length, 0, 'a missing optional service is not a warning-worthy error')
})

test('disabled plugin registers neither the tool nor the section', () => {
  const { ctx, registered, sections } = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(registered.length, 0)
  assert.equal(sections.length, 0)
})
