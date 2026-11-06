// dsh-recon — browser half (read-only panel).
//
// Hand-written __ModuleLoader__ factory: no build step, no framework. The only
// external require is `react`, which the loader module table already seeds.
//
// This half is strictly READ-ONLY:
//   * it GETs /api/dsh-recon/snapshot (registered by the Host half),
//   * it renders that snapshot,
//   * it never POSTs, never calls route_info_gap, never mutates the ledger.
//
// Registration is three parts, all required for the tab to actually appear
// (verified against dsh-context and dsh-better-sidebar, both live on 0.2.1-rc.5):
//   1. ctx.inject(['sidebarRightTabs']) → tabs.register({ id, kind, title, guide })
//      — this is what puts a chip in the tab bar.
//   2. ctx.slots.inject('sidebar.right.pane.tab')  → the tab BODY.
//   3. ctx.slots.inject('sidebar.right.pane.tab.title') → the tab CHIP text.
// `sidebar.right.pane.tab` is a KEYED slot whose key is the tab type id, so the
// key here must equal the `id`/`kind` registered in step 1.
//
// Every failure path is silent: a broken panel must never affect route_info_gap.

window.__ModuleLoader__.load({
  id: 'dsh-recon',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const name = 'dsh-recon'
    // `slots` is the client extension surface; `sidebarRightTabs` is read through
    // ctx.inject below because it is optional (absent = no tab bar entry).
    const inject = ['slots']

    /** Tab type id. MUST equal the pane.tab key and the tabs.register id. */
    const TAB_ID = 'dsh-recon'
    const TAB_KIND = 'dsh-recon'
    const SNAPSHOT_URL = '/api/dsh-recon/snapshot'
    const POLL_MS = 5000

    // ---- data: one read-only GET, no writes ----
    //
    // A failed fetch resolves to null, never throws: the panel degrades to its
    // empty state and the tool keeps working.
    async function fetchSnapshot(signal) {
      try {
        const response = await fetch(SNAPSHOT_URL, { method: 'GET', signal, cache: 'no-store' })
        if (!response.ok) return null
        const body = await response.json()
        return body && body.ok ? body.snapshot : null
      } catch {
        return null
      }
    }

    // ---- rendering (LOGIC PENDING CONFIRMATION) ----
    //
    // ---- visible text ----------------------------------------------------------
    //
    // Hard-coded Chinese for now — this is a developer observation panel, and
    // binding the render layer to a preview-version locale API would contradict
    // the plugin's own rule of isolating unverified interfaces behind adapters.
    //
    // The cheap hedge: every visible string lives here and is referenced as
    // STRINGS.x. Swapping this object for a t() call later touches NOTHING else.
    // This is a seam, not i18n.
    const STRINGS = {
      title: 'Recon',
      guideDescription: '决策时间线、纠正标记与策略分布（只读）',
      emptied: '还没有决策记录',
      timelineLabel: '决策时间线',
      distributionLabel: '策略分布',
      totalLabel: 'total',
      gapLabel: '缺口',
      strategyLabel: '通道',
      assumeLabel: '假设',
      interruptLabel: '打断',
      correctedBadge: '⚠ {n}',
      correctedBelowThreshold: '⚠ {n} (未到阈值)',
      correctedAtThreshold: '⚠ {n} · 已下调置信度',
      correctedTip: '同类缺口连续被纠正的次数',
      noDistribution: '暂无统计',
    }

    // ---- theme tokens ---------------------------------------------------------
    //
    // Every colour is a --dsw-* CSS variable. No hex values anywhere: the preview
    // theme can change, and a self-chosen colour is the first thing to break when
    // dark mode flips. Each entry lists a same-family fallback so a missing token
    // degrades within the theme rather than to black.
    //
    // NOTE there is no "info" family in this theme (verified via Theme.listTokens:
    // only warn / success / error / idle). minimal_question therefore uses the
    // brand accent, which reads as "attention, not danger".
    const TOKEN = {
      warning: 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-primary))',
      brand: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))',
      success: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary))',
      neutral: 'var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary))',
      text: 'var(--dsw-alias-label-primary)',
      textMuted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      surface: 'var(--dsw-alias-bg-layer-1)',
    }

    // Six channels, semantic colour families (not fixed colours).
    const CHANNEL_META = {
      read_trace: { label: '读轨迹', token: TOKEN.success },
      query_sensor: { label: '查传感器', token: TOKEN.success },
      read_multimodal: { label: '多模态痕迹', token: TOKEN.success },
      structured_form: { label: '结构化表单', token: TOKEN.neutral },
      minimal_question: { label: '最小追问', token: TOKEN.brand },
      assume_and_flag: { label: '先假设并标注', token: TOKEN.warning },
    }

    const CHANNEL_ORDER = [
      'read_trace',
      'query_sensor',
      'read_multimodal',
      'structured_form',
      'minimal_question',
      'assume_and_flag',
    ]

    /** Two consecutive corrections of one gap type is the discount threshold. */
    const PRIOR_FAILURE_THRESHOLD = 2

    /**
     * The tab icon shown in the sidebar guide list. Rendered with
     * `fill: currentColor` so it inherits the theme's label colour and needs no
     * hard-coded palette: a filled dot with a ring reads as "observation", and
     * it stays legible at 16px.
     */
    function ReconIcon(props) {
      const size = (props && props.size) || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          xmlns: 'http://www.w3.org/2000/svg',
          style: { display: 'block' },
        },
        h('circle', {
          cx: 8,
          cy: 8,
          r: 6,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          opacity: 0.6,
        }),
        h('circle', { cx: 8, cy: 8, r: 2.6, fill: 'currentColor' }),
      )
    }

    function channelMeta(strategy) {
      return CHANNEL_META[strategy] || { label: strategy, token: TOKEN.neutral }
    }

    /**
     * One correction badge. Same glyph at every count — only saturation and the
     * trailing note change — so the eye can scan the column without re-learning
     * the symbol. `⚠ N` carries the number because the number IS the meaning
     * (N=2 is exactly the threshold).
     */
    function CorrectionBadge(props) {
      const n = Number(props.prior_failures) || 0
      const atThreshold = n >= PRIOR_FAILURE_THRESHOLD
      const text = atThreshold
        ? STRINGS.correctedAtThreshold.replace('{n}', n)
        : STRINGS.correctedBelowThreshold.replace('{n}', n)
      return h(
        'span',
        {
          className: 'dsh-recon-badge',
          title: STRINGS.correctedTip,
          style: {
            color: atThreshold ? TOKEN.warning : TOKEN.textMuted,
            opacity: atThreshold ? 1 : 0.6,
            fontWeight: atThreshold ? 600 : 400,
            whiteSpace: 'nowrap',
          },
        },
        text,
      )
    }

    /** One timeline row: gap / channel / both ledgers / correction mark. */
    function TimelineRow(props) {
      const d = props.decision
      const meta = channelMeta(d.strategy)
      const corrected = Boolean(d.corrected)
      const assume = d.assumption_cost
      const interrupt = d.interrupt_cost

      const rowStyle = {
        padding: '6px 8px',
        borderLeft: `3px solid ${corrected ? TOKEN.warning : meta.token}`,
        // 6px BETWEEN cards, 4px between the text lines inside one card: the
        // timeline needs air to separate decisions, but not inside a decision.
        marginBottom: 6,
        background: TOKEN.surface,
        opacity: corrected ? 1 : 0.92,
        // A flex/grid child defaults to min-width:auto, which would let a long
        // channel label push the badge out of the row instead of ellipsising.
        minWidth: 0,
        boxSizing: 'border-box',
      }

      return h(
        'div',
        { className: 'dsh-recon-row', 'data-strategy': d.strategy, style: rowStyle },
        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              gap: 6,
              alignItems: 'baseline',
              flexWrap: 'nowrap',
              minWidth: 0,
            },
          },
          // The label yields space before the badge does: the count is the meaning.
          h(
            'span',
            {
              style: {
                color: TOKEN.text,
                fontWeight: 600,
                fontSize: 12,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            meta.label,
          ),
          corrected ? h(CorrectionBadge, { prior_failures: d.prior_failures }) : null,
        ),
        h(
          'div',
          { style: { color: TOKEN.textMuted, fontSize: 11, marginTop: 4 } },
          `${STRINGS.gapLabel} ${d.gap_type || '—'}`,
        ),
        h(
          'div',
          {
            style: {
              color: TOKEN.textMuted,
              fontSize: 11,
              marginTop: 4,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            },
          },
          `${STRINGS.assumeLabel} ${fmt(assume)} · ${STRINGS.interruptLabel} ${fmt(interrupt)}`,
        ),
        d.decision_at_stake
          ? h(
              'div',
              {
                style: {
                  color: TOKEN.textMuted,
                  fontSize: 11,
                  marginTop: 4,
                  overflowWrap: 'anywhere',
                  lineHeight: 1.35,
                },
                title: d.decision_at_stake,
              },
              d.decision_at_stake,
            )
          : null,
      )
    }

    function fmt(value) {
      return typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : '—'
    }

    /**
     * Horizontal bars, one row per channel, width = count / total.
     * No legend and no chart library: in a narrow column six stacked rows read
     * faster than any plot, and there is nothing to decode.
     */
    function DistributionBars(props) {
      const distribution = props.distribution || {}
      const total = CHANNEL_ORDER.reduce((sum, key) => sum + (Number(distribution[key]) || 0), 0)
      if (total === 0) {
        return h('div', { style: { color: TOKEN.textMuted, fontSize: 11 } }, STRINGS.noDistribution)
      }
      return h(
        'div',
        { className: 'dsh-recon-dist' },
        CHANNEL_ORDER.map((key) => {
          const count = Number(distribution[key]) || 0
          const ratio = count / total
          const meta = channelMeta(key)
          return h(
            'div',
            {
              key,
              className: 'dsh-recon-bar',
              'data-channel': key,
              title: `${meta.label}: ${count}/${total}`,
              style: { marginBottom: 4 },
            },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  color: TOKEN.textMuted,
                },
              },
              h('span', null, meta.label),
              h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, String(count)),
            ),
            h(
              'div',
              {
                style: {
                  height: 4,
                  background: TOKEN.border,
                  borderRadius: 2,
                  marginTop: 2,
                  overflow: 'hidden',
                },
              },
              h('div', {
                style: {
                  width: `${Math.round(ratio * 100)}%`,
                  height: '100%',
                  background: meta.token,
                  opacity: count === 0 ? 0.25 : 1,
                },
              }),
            ),
          )
        }),
      )
    }

    // ---- panel -----------------------------------------------------------------
    function Panel(props) {
      // `snapshot` arrives as a prop: the tab body is re-rendered by the host
      // whenever the store changes. Data is never fetched inside render.
      const snapshot = props.snapshot
      const decisions = snapshot && Array.isArray(snapshot.decisions) ? snapshot.decisions : []
      const distribution = (snapshot && snapshot.distribution) || {}

      // The denominator the bars are drawn against: the six channels' counts,
      // not `snapshot.total`. They can differ when the ledger rings out, and the
      // bars divide by this one — the label must match what they sum to.
      const distributionTotal = CHANNEL_ORDER.reduce(
        (sum, key) => sum + (Number(distribution[key]) || 0),
        0,
      )

      const header = h(
        'div',
        {
          style: {
            color: TOKEN.text,
            fontSize: 12,
            fontWeight: 600,
            padding: '8px 8px 4px',
            borderBottom: `1px solid ${TOKEN.border}`,
          },
        },
        `${STRINGS.title}${snapshot ? ` · ${snapshot.total ?? decisions.length}` : ''}`,
      )

      if (decisions.length === 0) {
        return h(
          'div',
          { className: 'dsh-recon-panel', 'data-empty': 'true' },
          header,
          h(
            'div',
            { style: { color: TOKEN.textMuted, fontSize: 11, padding: '10px 8px' } },
            STRINGS.emptied,
          ),
        )
      }

      // Newest first: the panel's job is "what did I just decide", not an archive.
      const rows = decisions.slice().reverse()

      return h(
        'div',
        { className: 'dsh-recon-panel', 'data-count': decisions.length },
        header,
        h(
          'div',
          { style: { padding: '8px' } },
          h(
            'div',
            { style: { color: TOKEN.textMuted, fontSize: 11, marginBottom: 4 } },
            STRINGS.timelineLabel,
          ),
          rows.map((d) => h(TimelineRow, { key: d.decision_id, decision: d })),
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 6,
                margin: '10px 0 6px',
                flexWrap: 'nowrap',
              },
            },
            h('span', { style: { color: TOKEN.textMuted, fontSize: 11 } }, STRINGS.distributionLabel),
            // The denominator in one glance: bars read as ratios, this says of what.
            h(
              'span',
              {
                style: {
                  color: TOKEN.textMuted,
                  fontSize: 10,
                  opacity: 0.75,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                },
              },
              `${STRINGS.totalLabel} ${distributionTotal}`,
            ),
          ),
          h(DistributionBars, { distribution }),
        ),
      )
    }


    // ---- panel store: the poll writes here, the panel reads here ----
    //
    // A store, not component state: the body is mounted by the host inside the
    // tab, so `apply()` (which runs before any React tree exists) has no setter
    // to call. Same subscribe/getSnapshot/set shape as the shared store in
    // dsh-pet-live2d, minus its persistence.
    function createSnapshotStore() {
      let snapshot = null
      const listeners = new Set()
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => snapshot,
        set(next) {
          // Skip the notify when nothing changed: the panel polls every few
          // seconds and must not re-render on identical data.
          if (next === snapshot) return
          if (snapshot !== null && JSON.stringify(next) === JSON.stringify(snapshot)) return
          snapshot = next
          for (const listener of listeners) listener()
        },
      }
    }

    function createSnapshotPanel(store, props) {
      // Subscribe with useState + useEffect, NOT with useSyncExternalStore.
      //
      // Two reasons, both verified:
      //  1. The Client React surface exposes createElement / useState / useEffect;
      //     useSyncExternalStore is not guaranteed to exist.
      //  2. The obvious fallback (`typeof useSyncExternalStore === 'function' ? …
      //     : store.getSnapshot()`) reads the store ONCE with no subscription, so
      //     the panel would render empty and never repaint when the poll finally
      //     delivers data. A fallback that silently never updates is worse than
      //     no fallback at all.
      //
      // useState is seeded from the live store, so data that arrived before mount
      // is shown immediately instead of waiting for the next poll.
      const [snapshot, setSnapshot] = react.useState(store.getSnapshot())
      react.useEffect(() => {
        // Catch a value that landed between render and effect.
        setSnapshot(store.getSnapshot())
        return store.subscribe(() => setSnapshot(store.getSnapshot()))
      }, [])
      return h(Panel, { ...props, snapshot })
    }

    // ---- apply ----
    function apply(ctx) {
      const disposers = []
      const push = (fn) => {
        if (typeof fn === 'function') disposers.push(fn)
      }

      const store = createSnapshotStore()
      const pushSnapshot = (snapshot) => {
        try {
          store.set(snapshot)
        } catch {
          // a bad payload must not break the poll loop
        }
      }

      // Fetch once immediately, then on an interval. The result is PUSHED into
      // the store — a poll that discards its result shows nothing forever.
      const refresh = (signal) => {
        fetchSnapshot(signal)
          .then(pushSnapshot)
          .catch(() => {
            // network failure: keep the last good snapshot on screen
          })
      }

      // 1) tab type (optional service: absent means the tab bar has no chip, and
      //    the body/title registrations below are simply unused).
      try {
        ctx.inject(['sidebarRightTabs'], (scope) => {
          const tabs = scope.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return
          push(
            tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => STRINGS.title,
              // `guide` is the OPENABLE-TAB LIST: an empty array leaves the tab
              // registered but with no way to open it from the right sidebar.
              // (VDiag: the tab was active yet unreachable.) The shipped guide
              // lists its entries by order/title/description, so ours must carry
              // all three.
              guide: [
                {
                  // 15 places it ahead of most shipped entries; the guide list
                  // sorts ascending, so a low number is a near-top slot.
                  order: 15,
                  title: () => STRINGS.title,
                  description: () => STRINGS.guideDescription,
                  icon: ReconIcon,
                },
              ],
            }),
          )
        })
      } catch {
        // optional: never fatal
      }

      // 2) tab body — keyed slot, key === TAB_ID
      try {
        push(
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, (slotProps) =>
              createSnapshotPanel(store, slotProps),
            ),
          ),
        )
      } catch {
        // a missing slot means this build has no right sidebar: silent
      }

      // 3) tab chip title — same key
      try {
        push(
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () =>
              h('span', { className: 'dsh-recon-tab-title' }, 'Recon'),
            ),
          ),
        )
      } catch {
        // silent
      }

      // Read-only polling. Uses ctx.effect so the interval dies with the plugin.
      try {
        ctx.effect(() => {
          const controller = new AbortController()
          refresh(controller.signal)
          const timer = window.setInterval(() => {
            refresh(controller.signal)
          }, POLL_MS)
          return () => {
            window.clearInterval(timer)
            controller.abort()
          }
        })
      } catch {
        // silent
      }

      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose?.()
          } catch {
            // silent
          }
        }
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    // Exposed for the unit tests only: the Host never calls these. Rendering is
    // a pure function of props, so it can be asserted without a DOM.
    exports.__test = { Panel, TimelineRow, CorrectionBadge, DistributionBars, STRINGS, CHANNEL_META }
    return module.exports
  },
})
