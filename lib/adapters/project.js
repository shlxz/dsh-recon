// Project-convention probe: the part of read_trace that looks at the workspace
// rather than the conversation.
//
// WHY THIS EXISTS
// The failure this plugin actually exists to prevent is not "the AI asked too
// much" — it is "the AI produced something that did not match what the project
// already does". That mismatch almost always has the same cause: the agent
// never looked at the repository's own conventions and fell back to generic
// defaults (its own idea of indentation, module system, test layout, naming).
//
// Asking the user "which style?" is the expensive fix. Reading the answer that
// is already on disk is the cheap one. Six channels existed on paper; only one
// of them could see the workspace. This is that channel made real.
//
// SCOPE — deliberately narrow, because guessing wide is how a "recon" tool
// becomes an expensive一次性 scan:
//   * manifest files at the root (package.json, pyproject.toml, Cargo.toml, go.mod)
//   * the repository's own instruction files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md)
//   * top-level directory layout (to infer test/doc/source placement)
//   * the nearest lockfile/format config that pins style (prettier/eslint/editorconfig)
//
// It never reads source files. A convention that cannot be stated in a manifest,
// an instruction file, or a directory name is not one this probe should guess at.

import { makeEvidence } from './contract.js'

const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
]

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.editorconfig', '.prettierrc', '.prettierrc.json', 'tsconfig.json', 'ruff.toml', 'setup.cfg']

// Directories whose presence answers "where does this project put things".
const LAYOUT_SIGNALS = [
  { name: 'src', fact: '源码放在 src/' },
  { name: 'lib', fact: '源码放在 lib/' },
  { name: 'tests', fact: '测试放在 tests/' },
  { name: 'test', fact: '测试放在 test/' },
  { name: '__tests__', fact: '测试放在 __tests__/' },
  { name: 'docs', fact: '文档放在 docs/' },
  { name: 'scripts', fact: '脚本放在 scripts/' },
  { name: 'apps', fact: '多包结构（apps/）' },
  { name: 'packages', fact: '多包结构（packages/）' },
  { name: '.github', fact: '使用 GitHub Actions' },
]

const MAX_BYTES = 4096

/**
 * Describe what a package.json says about the project's own conventions.
 * PURE: takes the parsed object, returns facts. No I/O, so it is testable.
 */
export function conventionsFromManifest(manifest, fileName = 'package.json') {
  const facts = []
  if (!manifest || typeof manifest !== 'object') return facts

  if (typeof manifest.type === 'string') {
    facts.push(`模块系统: ${manifest.type === 'module' ? 'ESM（"type":"module"）' : 'CommonJS'}`)
  }
  if (typeof manifest.main === 'string') facts.push(`入口: ${manifest.main}`)

  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {}
  const named = Object.keys(scripts)
  if (named.length) {
    const notable = named.filter((n) => /^(test|lint|build|typecheck|check|format)$/.test(n))
    if (notable.length) facts.push(`可用脚本: ${notable.join(', ')}`)
  }

  // A test runner is a convention: "run the tests" means one specific command.
  const allDeps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) }
  for (const [dep, wording] of [
    ['vitest', '测试用 vitest'],
    ['jest', '测试用 jest'],
    ['mocha', '测试用 mocha'],
    ['node:test', '测试用 node:test'],
    ['typescript', '使用 TypeScript'],
    ['prettier', '格式化用 prettier'],
    ['eslint', 'lint 用 eslint'],
    ['biome', '格式化/lint 用 biome'],
  ]) {
    if (allDeps[dep]) facts.push(wording)
  }

  if (manifest.packageManager) facts.push(`包管理器: ${manifest.packageManager}`)
  // A manifest that says nothing about conventions yields no facts. Returning a
  // bare provenance line made "found nothing" look like "found one thing".
  if (!facts.length) return facts
  facts.push(`(来源: ${fileName})`)
  return facts
}

/** Facts from an AGENTS.md / CONTRIBUTING.md style file. PURE. */
export function conventionsFromInstructions(text, fileName) {
  const facts = []
  const body = String(text || '').trim()
  if (!body) return facts
  // Take the first meaningful line as a signal; do not summarize an essay.
  const firstLine = body
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find((l) => l.length > 8 && l.length < 160)
  if (firstLine) facts.push(`${fileName}: ${firstLine}`)
  return facts
}

export function createProjectProbe({ ctx, agent }) {
  function fsService() {
    const fs = ctx?.get?.('fs')
    // Only the three calls this probe actually makes. Requiring anything else
    // (e.g. `stat`) turns a working filesystem into "unavailable".
    return fs?.listDir && fs?.readText && fs?.resolve ? fs : null
  }

  async function workspaceRoot() {
    const wd = ctx?.get?.('workingDirectory')
    const sessions = ctx?.get?.('sessions')
    if (wd && agent?.id && sessions?.get) {
      const session = sessions.get(agent.id)
      if (session) {
        try {
          return wd.get(session)
        } catch {
          // fall through to the default
        }
      }
    }
    return wd?.defaultDirectory ?? null
  }

  return {
    /**
     * Read the workspace's own conventions.
     * Never throws: every failure becomes a note, because a probe that breaks
     * the router is worse than a probe that finds nothing.
     */
    async probe(input) {
      const evidence = []
      const notes = []
      const fs = fsService()
      if (!fs) {
        return { evidence, notes: ['fs service unavailable'] }
      }
      const root = await workspaceRoot()
      if (!root) {
        return { evidence, notes: ['workspace root unknown'] }
      }

      let entries = []
      try {
        const target = await fs.resolve(root)
        entries = (await fs.listDir(target)) || []
      } catch (error) {
        return { evidence, notes: [`listDir failed: ${error?.message || error}`] }
      }

      const present = new Map()
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry?.name
        if (name) present.set(name, entry)
      }

      // 1) Layout: which conventional directories exist.
      const layout = LAYOUT_SIGNALS.filter((s) => present.has(s.name))
      if (layout.length) {
        evidence.push(
          makeEvidence({
            channel: 'read_trace',
            plugin: 'workspace',
            tool: 'fs.listDir',
            ref: `${root}`,
            text: `项目布局: ${layout.map((s) => s.fact).join('；')}`,
            weight: 0.3,
          }),
        )
      }

      // 2) Manifest: the project's declared stack and commands.
      const manifestName = MANIFESTS.find((m) => present.has(m))
      if (manifestName) {
        try {
          const target = await fs.resolve(`${root}/${manifestName}`)
          const raw = await fs.readText(target)
          if (raw && raw.length <= MAX_BYTES * 4) {
            if (manifestName === 'package.json') {
              const parsed = JSON.parse(raw)
              const facts = conventionsFromManifest(parsed, manifestName)
              // Drop the trailing "(来源: …)" line; it is repeated in `ref`.
              const body = facts.filter((f) => !f.startsWith('(来源'))
              if (body.length) {
                evidence.push(
                  makeEvidence({
                    channel: 'read_trace',
                    plugin: 'workspace',
                    tool: 'fs.readText',
                    ref: `${root}/${manifestName}`,
                    text: `项目约定: ${body.join('；')}`,
                    weight: 0.45,
                  }),
                )
              }
            } else {
              // Non-JSON manifests: only the first meaningful line is safe to quote.
              const firstLine = String(raw)
                .split('\n')
                .map((l) => l.trim())
                .find((l) => l.length > 4 && !l.startsWith('#'))
              if (firstLine) {
                evidence.push(
                  makeEvidence({
                    channel: 'read_trace',
                    plugin: 'workspace',
                    tool: 'fs.readText',
                    ref: `${root}/${manifestName}`,
                    text: `${manifestName}: ${firstLine.slice(0, 120)}`,
                    weight: 0.3,
                  }),
                )
              }
            }
          }
        } catch (error) {
          notes.push(`${manifestName} unreadable: ${error?.message || error}`)
        }
      } else {
        notes.push('no manifest at the workspace root')
      }

      // 3) The repository's own instruction file — the strongest signal there is,
      //    because a human wrote it down for exactly this purpose.
      const instructionName = INSTRUCTION_FILES.find((f) => present.has(f))
      if (instructionName) {
        try {
          const target = await fs.resolve(`${root}/${instructionName}`)
          const raw = await fs.readText(target)
          if (raw) {
            if (instructionName.endsWith('.json') || instructionName === '.prettierrc') {
              // A config file: report existence only, its contents are not prose.
              evidence.push(
                makeEvidence({
                  channel: 'read_trace',
                  plugin: 'workspace',
                  tool: 'fs.readText',
                  ref: `${root}/${instructionName}`,
                  text: `存在风格配置: ${instructionName}`,
                  weight: 0.3,
                }),
              )
            } else {
              const facts = conventionsFromInstructions(raw, instructionName)
              for (const fact of facts) {
                evidence.push(
                  makeEvidence({
                    channel: 'read_trace',
                    plugin: 'workspace',
                    tool: 'fs.readText',
                    ref: `${root}/${instructionName}`,
                    text: fact,
                    weight: 0.5,
                  }),
                )
              }
            }
          }
        } catch (error) {
          notes.push(`${instructionName} unreadable: ${error?.message || error}`)
        }
      }

      if (!evidence.length) notes.push('workspace has no readable convention signal')
      return { evidence, notes }
    },
  }
}
