// Client half contract test: the THREE registrations a right-sidebar tab needs.
//
// `sidebar.right.pane.tab` is KEYED on the tab type id, so a body registration
// alone never appears in the tab bar (verified against dsh-context and
// dsh-better-sidebar, both live on 0.2.1-rc.5):
//   1. sidebarRightTabs.register({id, kind, title})   → puts the chip in the bar
//   2. slots.register on 'sidebar.right.pane.tab'      → the tab body, key = id
//   3. slots.register on 'sidebar.right.pane.tab.title'→ the chip text, key = id
//
// lib/client.js is a browser bundle, so this test evaluates it against a fake
// __ModuleLoader__ / ctx instead of importing it.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_SOURCE = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

const TAB_ID = 'dsh-recon'

/**
 * Evaluate lib/client.js in a sandbox and run its apply().
 * @param {{tabService?: boolean, slots?: boolean}} options
 */
function loadClient({ tabService = true, slots = true } = {}) {
  const seen = { tabTypes: [], slotMeta: [], titleMeta: [], intervals: 0, cleanups: 0, fetched: [] }

  const slotsService = {
    inject(name, callback) {
      assert.ok(
        name === 'sidebar.right.pane.tab' || name === 'sidebar.right.pane.tab.title',
        `unexpected slot inject: ${name}`,
      )
      return callback()
    },
    register(meta, render) {
      if (meta.name === 'sidebar.right.pane.tab') seen.slotMeta.push({ ...meta, render })
      if (meta.name === 'sidebar.right.pane.tab.title') seen.titleMeta.push({ ...meta, render })
      return () => {}
    },
  }

  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    // The tab-body renderer mounts through these two; a stub without them makes
    // the contract test fail for the wrong reason (a missing hook, not a bad
    // registration). Behaviour is asserted in panel-render.test.mjs instead.
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }

  const sandboxWindow = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-recon', 'module id must equal the package name')
        seen.module = factory((name) => {
          if (name === 'react') return reactStub
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
    setInterval(fn) {
      seen.intervals += 1
      seen.poll = fn
      return 0
    },
    clearInterval() {},
  }

  const fetchStub = async (url, init) => {
    seen.fetched.push({ url, init })
    return { ok: false, json: async () => ({}) }
  }

  const run = new Function(
    'window',
    'fetch',
    'AbortController',
    'console',
    `"use strict";\n${CLIENT_SOURCE}`,
  )
  run(sandboxWindow, fetchStub, AbortController, console)

  assert.ok(seen.module, 'client.js must register a module')
  const exported = seen.module

  // The ctx the Host would hand to apply().
  const ctx = {
    slots: slots ? slotsService : undefined,
    inject(deps, callback) {
      assert.deepEqual(deps, ['sidebarRightTabs'], 'the tab-type service is optional-injected')
      if (!tabService) return undefined
      return callback({
        sidebarRightTabs: {
          register(definition) {
            seen.tabTypes.push(definition)
            return () => {}
          },
        },
      })
    },
    effect(fn) {
      const cleanup = fn()
      seen.cleanups += 1
      seen.cleanup = cleanup
      return () => {}
    },
    logger: () => ({ warn() {} }),
  }

  const dispose = exported.apply(ctx)
  return { exported, seen, dispose }
}

test('client module exports the loader contract', () => {
  const { exported } = loadClient()
  assert.equal(exported.name, 'dsh-recon')
  assert.deepEqual(exported.inject, ['slots'])
  assert.equal(typeof exported.apply, 'function')
})

test('registers exactly one tab TYPE with id/kind/title', () => {
  const { seen } = loadClient()
  assert.equal(seen.tabTypes.length, 1)
  const def = seen.tabTypes[0]
  assert.equal(def.id, TAB_ID)
  assert.equal(def.kind, TAB_ID, 'kind must equal the pane.tab dispatch key')
  assert.equal(typeof def.title, 'function')

  // `guide` is the OPENABLE-TAB LIST, not decoration. An empty array registers
  // the tab but leaves it unreachable from the right sidebar — the panel existed
  // and was active, yet there was no way to open it. Verified defect.
  assert.ok(Array.isArray(def.guide), 'guide must be an array')
  assert.equal(def.guide.length, 1, 'one entry is what makes the tab openable')
  const entry = def.guide[0]
  assert.equal(typeof entry.order, 'number', 'order places the entry in the list')
  assert.equal(typeof entry.title, 'function', 'title labels the entry')
  assert.equal(typeof entry.description, 'function', 'description explains the entry')
  assert.equal(typeof entry.icon, 'function', 'the entry carries an icon component')
})

test('body and title register under the SAME key as the tab type', () => {
  const { seen } = loadClient()
  assert.equal(seen.slotMeta.length, 1)
  assert.equal(seen.titleMeta.length, 1)
  assert.equal(seen.slotMeta[0].name, 'sidebar.right.pane.tab')
  assert.equal(seen.slotMeta[0].key, TAB_ID)
  assert.equal(seen.titleMeta[0].name, 'sidebar.right.pane.tab.title')
  assert.equal(seen.titleMeta[0].key, TAB_ID)
})

test('the body renderer is a function the host can call', () => {
  const { seen } = loadClient()
  assert.equal(typeof seen.slotMeta[0].render, 'function')
  const element = seen.slotMeta[0].render({ sessionId: 's1' })
  assert.ok(element, 'render must return an element even without a snapshot')
})

test('missing sidebarRightTabs degrades silently', () => {
  assert.doesNotThrow(() => loadClient({ tabService: false }))
  const { seen } = loadClient({ tabService: false })
  assert.equal(seen.tabTypes.length, 0, 'no chip without the optional service')
})

test('missing slots degrades silently', () => {
  assert.doesNotThrow(() => loadClient({ slots: false }))
})

test('polling is read-only GET and its cleanup is handed to the host', () => {
  const { seen } = loadClient()
  assert.equal(seen.intervals, 1, 'one poll interval')
  assert.equal(seen.cleanups, 1, 'one effect cleanup registered')
  assert.equal(typeof seen.cleanup, 'function')
  assert.doesNotThrow(() => seen.cleanup())

  // The panel refreshes once on mount and then on the interval.
  assert.equal(seen.fetched.length, 1, 'one immediate fetch')
  for (const call of seen.fetched) {
    assert.equal(call.init.method, 'GET', 'the only verb is GET')
    assert.equal(call.init.body, undefined, 'a read carries no body')
  }
})

test('client bundle performs no writes, no tool calls, no storage', () => {
  // Guard the read-only promise at the source level. Only CALL patterns are
  // matched: prose in comments is allowed to mention what the panel never does.
  assert.doesNotMatch(CLIENT_SOURCE, /method:\s*['"]POST['"]/)
  assert.doesNotMatch(CLIENT_SOURCE, /method:\s*['"]PUT['"]/)
  assert.doesNotMatch(CLIENT_SOURCE, /method:\s*['"]DELETE['"]/)
  assert.doesNotMatch(CLIENT_SOURCE, /route_info_gap\s*\(/)
  assert.doesNotMatch(CLIENT_SOURCE, /tools\.execute\s*\(/)
  assert.doesNotMatch(CLIENT_SOURCE, /localStorage/)
  assert.match(CLIENT_SOURCE, /method:\s*'GET'/, 'the only verb is GET')
})
