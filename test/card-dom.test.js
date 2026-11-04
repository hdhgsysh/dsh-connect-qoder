/**
 * Render the shipped card in a real DOM and assert on what the user sees.
 *
 * Run: node --test test/card-dom.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * `test/client-bundle.test.js` guards two pure functions it extracts from the
 * bundle text, and says plainly what that cannot cover: "Everything around the
 * gate — the JSX rendering, the clock interval, the fetch of the host route, the
 * settings write. Those need a browser." This file IS that browser, without
 * launching one: jsdom provides the DOM, real `react`/`react-dom` render the
 * component, and `fetch` is stubbed to answer the host's own routes.
 *
 * It drives `lib/client.js` — the artifact the host ships — through its own
 * loader contract (`window.__ModuleLoader__.load`) and its own client context
 * (`slots.register`), so a card that loses its roster in a rebuild fails here
 * even though every other test stays green.
 *
 * WHAT IT PINS
 *
 * - the card renders the models the route answers, with rates and off-peak
 *   badges;
 * - an off-peak promotion inside its window shows the countdown, and one that
 *   upstream switched off does not;
 * - the region strip, the usage panel and the check-in row are present;
 * - a save that the host endpoint refuses surfaces the reason instead of a
 *   "已保存" banner (issue 06).
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadCardBundle, renderCards, withFrozenClock } from './helpers/render-card.js'

/** The most recently mounted card, so `afterEach` can release its timers. */
let mountedRoot = null
afterEach(() => {
  mountedRoot?.unmount()
  mountedRoot = null
})

/** A row the host's models route would serve, mirroring `projectModelRow`. */
const model = (overrides) => ({
  id: 'qwen3-coder',
  region: 'qoder-cn',
  name: 'Qwen3 Coder',
  contextWindowLabel: '200K',
  priceFactor: 1.0,
  promotion: undefined,
  isVL: false,
  ...overrides,
})

const REGIONS = [
  { region: 'qoder-cn', regionName: 'Qoder CN', state: 'ok', source: 'env-pat', appName: 'Qoder', enabled: true, identity: { name: 'test@example.com', expiresAt: 0 } },
  { region: 'qoder', regionName: 'Qoder', state: 'ok', source: 'env-pat', appName: 'Qoder', enabled: true, identity: { name: 'test@example.com', expiresAt: 0 } },
]

/** A fetch stub answering the plugin's own routes from an in-memory model. */
function routeStub({ models = [model({})], accountRegions = REGIONS, usageRegions = [], usageCheckin, saveStatus = 200, imageOverrides = {} } = {}) {
  const calls = []
  const seen = (url) => { calls.push(String(url)); return calls }
  const json = (value) => ({
    ok: true,
    status: 200,
    json: async () => value,
  })
  const fetch = async (url, init) => {
    seen(url)
    const path = String(url)
    if (path.includes('/models')) {
      return json({
        models,
        imageOverrides,
        enabledModelIds: {},
        useMaximumContextWindow: false,
        refreshedAt: 1750000000000,
      })
    }
    if (path.includes('/account')) {
      return json({ regions: accountRegions, enabledRegions: Object.fromEntries(accountRegions.map((r) => [r.region, r.enabled !== false])) })
    }
    if (path.includes('/usage')) {
      // `usageCheckin` is the host's machine-identity hint, sent only when the
      // international edition's round is gated off (KNOWN_GAPS §8).
      return usageCheckin === undefined ? json({ regions: usageRegions }) : json({ regions: usageRegions, checkin: usageCheckin })
    }
    if (path.includes('/__save')) {
      return {
        ok: saveStatus >= 200 && saveStatus < 300,
        status: saveStatus,
        json: async () => (saveStatus < 300 ? { ok: true, value: init?.body } : { ok: false, errorName: 'SettingsSaveError', error: 'refused' }),
      }
    }
    throw new Error(`unexpected fetch: ${path}`)
  }
  fetch.calls = calls
  return fetch
}

/** Mount the card once per test with a fresh route stub. */
async function mount(options = {}) {
  const fetchImpl = options.fetch ?? routeStub(options)
  const loaded = await loadCardBundle({ fetchImpl, scopePersist: options.scopePersist })
  const rendered = await renderCards({ ...loaded, card: loaded.slots[0] })
  mountedRoot = rendered
  return { ...loaded, ...rendered }
}

/** The visible text of a node, with its hidden parents filtered out. */
const text = (node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()

/** Run one React state update and let the resulting microtasks settle. */
async function update(react, action) {
  await react.act(async () => {
    action()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('the card renders the models the host route answers', async () => {
  const { container } = await mount({
    models: [
      model({ id: 'm1', name: 'Alpha', priceFactor: 0.5, isVL: false }),
      model({ id: 'm2', name: 'Beta', priceFactor: 0, isVL: true }),
    ],
  })

  const names = [...container.querySelectorAll('.dsm-qoder-name')].map((n) => n.textContent)
  assert.ok(names.includes('Alpha'), 'Alpha model row missing')
  assert.ok(names.includes('Beta'), 'Beta model row missing')

  const free = container.querySelector('.dsm-qoder-rate-free')
  assert.ok(free !== null, 'a zero-factor model must be labelled free')
  assert.equal(free.textContent, '免费')
})

test('the region strip lists every known region', async () => {
  const { container } = await mount()
  const tabs = [...container.querySelectorAll('.dsm-qoder-region-name')].map((n) => n.textContent)
  assert.deepEqual(tabs, ['Qoder CN', 'Qoder'])
})

test('the region strip sits ABOVE the account card, not inside it', async () => {
  const { container } = await mount()
  const body = container.querySelector('.dsm-qoder-body')
  assert.ok(body !== null, 'the card body is missing')
  const strip = body.querySelector(':scope > .dsm-qoder-region-tabs')
  const account = body.querySelector(':scope > .dsm-qoder-account')
  assert.ok(strip !== null, 'the strip is not a direct child of the body')
  assert.ok(account !== null, 'the account card is not a direct child of the body')
  // The strip switches the WHOLE body (account + usage + models), so it must
  // not be nested in the account frame — it renders directly above that card,
  // matching the WorkBuddy layout it was modelled on.
  assert.equal(account.contains(strip), false, 'the strip is still inside the account card')
  assert.equal(strip.nextElementSibling, account, 'the account card is not the strip\u2019s next sibling')
})

// The badge used to print a per-second HH:MM:SS countdown, which reset the
// row's visual anchor sixty times a minute to restate a fact nobody acts on
// second by second. It now names the BOUNDARY the rate flips at, and the
// precise countdown moved to the tooltip. Both halves are asserted here: the
// visible text must be stable (no seconds), and the exact count must still be
// one hover away — dropping it entirely would lose information.
test('a live off-peak promotion names the window boundary, with the countdown in its tooltip', async () => {
  // The window below (22:00–08:00 Asia/Shanghai) is only open at night, so
  // this test used to pass or fail on the wall clock of the machine running
  // it — red every morning, green at night, with no code changed. The clock
  // is frozen for the mount and the assertions (see
  // `test/helpers/render-card.js` `withFrozenClock`), and the root is released
  // BEFORE the clock is restored, so the per-second interval never ticks
  // against a clock that just flipped out-of-window.
  await withFrozenClock(async () => {
    const handle = await mount({
      models: [
        model({
          id: 'm1',
          promotion: {
            active: true,
            windowStart: '22:00',
            windowEnd: '08:00',
            timezone: 'Asia/Shanghai',
          },
        }),
      ],
    })
    try {
      const badge = handle.container.querySelector('.dsm-qoder-badge-offer')
      assert.ok(badge !== null, 'a live off-peak window must render the discount badge')
      const badgeText = badge.textContent ?? ''
      assert.ok(/至\s*08:00/.test(badgeText), `the badge must name the window end, got: ${badgeText}`)
      assert.equal(/\d{2}:\d{2}:\d{2}/.test(badgeText), false, 'the badge must not tick — no seconds on screen')
      assert.ok(
        /\d{2}:\d{2}:\d{2}/.test(badge.getAttribute('title') ?? ''),
        'the precise countdown must still be reachable in the tooltip',
      )
    } finally {
      handle.unmount()
    }
  })
})

test('a promotion Qoder has switched off never shows the discount', async () => {
  const { container } = await mount({
    models: [
      model({
        id: 'm1',
        promotion: {
          active: false,
          windowStart: '22:00',
          windowEnd: '08:00',
          timezone: 'Asia/Shanghai',
        },
      }),
    ],
  })
  const offer = container.querySelector('.dsm-qoder-badge-offer')
  assert.equal(offer, null, 'a switched-off promotion must not render the discount badge')
})

test('the usage panel renders the active region and the check-in card', async () => {
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        userQuota: { used: 10, total: 100, remaining: 90, percentage: 0.1, unit: 'credits' },
        addOnQuota: { used: 0, total: 1000, remaining: 1000, percentage: 0, unit: 'credits' },
        checkin: { active: true, todayCheckedIn: false, amount: 50 },
      },
    ],
  })
  const bars = container.querySelectorAll('.dsm-qoder-bar')
  assert.equal(bars.length, 2, 'expected the plan and the add-on quota bars')
  const figures = [...container.querySelectorAll('.dsm-qoder-usage-figures')].map((n) => text(n))
  assert.ok(
    figures.some((f) => f.startsWith('10 / 100')),
    `expected the plan quota figures, got ${JSON.stringify(figures)}`,
  )
  const checkinButton = [...container.querySelectorAll('.dsm-qoder-button')]
    .find((b) => /签到/.test(text(b)))
  assert.ok(checkinButton !== undefined, 'no check-in button rendered')
  assert.equal(checkinButton.disabled, false, 'an unclaimed round must offer the claim button')
})

test('the check-in is a card beside the usage panel, not a row inside it', async () => {
  // The regression this pins, twice over:
  //  1. the check-in used to be one more `.dsm-qoder-row` in the panel's
  //     stack, which spent an entire line on "每日签到" and one short button;
  //  2. a first attempt at the fix nested the card inside `.dsm-qoder-usage`,
  //     which put it beside the quota BARS but still inside the bordered
  //     panel. It belongs beside the PANEL, as its sibling.
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        addOnQuota: { used: 255, total: 1300, remaining: 1045, percentage: 0.2, unit: 'credits' },
        checkin: { active: true, todayCheckedIn: true, amount: 100 },
      },
    ],
  })

  const usage = container.querySelector('.dsm-qoder-usage')
  assert.ok(usage !== null, 'no usage panel rendered')
  assert.equal(
    usage.querySelector('.dsm-qoder-row'),
    null,
    'the check-in must not render as a full-width usage row',
  )

  const checkin = container.querySelector('.dsm-qoder-checkin')
  assert.ok(checkin !== null, 'no check-in card rendered')
  // The whole point: the card is a sibling of the panel, not a child of it.
  assert.equal(
    usage.contains(checkin),
    false,
    'the check-in card must not be nested inside the usage panel',
  )
  const row = container.querySelector('.dsm-qoder-usage-row')
  assert.ok(row !== null, 'the panel and the card must share a row')
  assert.equal(usage.parentElement, row, 'the usage panel must be a direct child of the row')
  assert.equal(checkin.parentElement, row, 'the check-in card must be a direct child of the row')

  // The bars stay in the panel, the button in the card.
  assert.equal(usage.querySelectorAll('.dsm-qoder-bar').length, 1, 'the bars belong to the panel')
  assert.equal(checkin.querySelectorAll('.dsm-qoder-bar').length, 0, 'the check-in card carries no bar')
  assert.ok(checkin.querySelector('button') !== null, 'the check-in card must own its button')

  // The amount the host resolved is the headline, and it stays visible after
  // the round is claimed — that is the whole point of the card.
  assert.equal(text(checkin.querySelector('.dsm-qoder-checkin-gain')), '+100 Credits')
  assert.equal(text(checkin.querySelector('button')), '今日已签到')
})

test('no check-in card is rendered when upstream has no round running', async () => {
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        addOnQuota: { used: 0, total: 100, remaining: 100, percentage: 0, unit: 'credits' },
        checkin: { active: false, todayCheckedIn: false },
      },
    ],
  })
  assert.equal(
    container.querySelector('.dsm-qoder-checkin'),
    null,
    'an inactive round must not leave a permanently grey card behind',
  )
  const usage = container.querySelector('.dsm-qoder-usage')
  assert.equal(
    usage.querySelectorAll('.dsm-qoder-bar').length,
    1,
    'the quota bar still renders without a check-in',
  )
})

test('a machine identity that cannot be read is named, not left as an empty panel', async () => {
  // The international edition's campaigns endpoint is gated on the desktop
  // app's umid machine identity. Without it upstream serves no claimable round,
  // so the check-in card is correctly absent — and its absence is
  // indistinguishable from "no round today", which is what this fixes
  // (KNOWN_GAPS §8, red line 1).
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        addOnQuota: { used: 0, total: 100, remaining: 100, percentage: 0, unit: 'credits' },
        checkin: { active: false, todayCheckedIn: false },
      },
    ],
    usageCheckin: { umidAvailable: false, reason: 'no matching version root' },
  })

  assert.equal(container.querySelector('.dsm-qoder-checkin'), null, 'there is genuinely no round to render')
  const note = [...container.querySelectorAll('p')].find((n) => /no matching version root/.test(text(n)))
  assert.ok(note !== null, `the reason must be visible; the panel said: ${text(container).slice(0, 500)}`)
  assert.ok(
    /签到|check-in/i.test(text(note)),
    `the note must read as a check-in explanation; got ${text(note)}`,
  )
})

test('a healthy machine identity shows no such note', async () => {
  // Only a degraded machine may be told about it, or every panel on a
  // healthy machine grows a permanent warning nobody can act on.
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        addOnQuota: { used: 0, total: 100, remaining: 100, percentage: 0, unit: 'credits' },
        checkin: { active: false, todayCheckedIn: false },
      },
    ],
  })
  assert.equal([...container.querySelectorAll('p')].find((n) => /no matching version root/.test(text(n))), undefined)
})

// The campaigns read failing used to be swallowed host-side, which made "the
// endpoint is down" and "this account has no offers" render identically. The
// host now sends the reason with the region's usage block; the card must print
// it, or the host-side fix would still be invisible to the user (red line 1).
test('a failed campaigns read is named on the region it belongs to', async () => {
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        userQuota: { used: 25, total: 100, remaining: 75, percentage: 0.25, unit: 'credits' },
        campaigns: [],
        campaignsError: 'Qoder campaigns failed: HTTP 500',
      },
    ],
  })

  // The quota is the reason the panel exists, so it must survive the failure.
  assert.ok(
    container.querySelector('.dsm-qoder-bar') !== null,
    'the quota bar must still render when only the campaigns half failed',
  )
  const note = [...container.querySelectorAll('p')].find((n) => /HTTP 500/.test(text(n)))
  assert.ok(note !== null, `the reason must be visible; the panel said: ${text(container).slice(0, 500)}`)
  assert.ok(
    /活动|offer/i.test(text(note)),
    `the note must read as an offers explanation; got ${text(note)}`,
  )
})

test('an unreadable-by-shape usage block points at a plugin update, not the generic "cannot read"', async () => {
  // A renamed upstream envelope cannot be waited out or signed past: the only
  // remedy is updating the plugin. The generic "读不到用量" would offer a retry
  // the user cannot succeed at, which is the failure mode issue 10 exists for.
  const { container } = await mount({
    usageRegions: [{ region: 'qoder-cn', available: false, unavailableReason: 'protocol-shape-changed' }],
  })
  const copy = text(container)
  assert.match(copy, /插件|plugin/i, `the drift copy must name the plugin; got: ${copy.slice(0, 500)}`)
  assert.doesNotMatch(copy, /暂时读不到用量|usage is unavailable/i, 'the generic failure copy must not render instead')
})

test('an ordinary read failure keeps the generic copy and does not blame the plugin version', async () => {
  const { container } = await mount({
    usageRegions: [{ region: 'qoder-cn', available: false, unavailableReason: 'read-failed' }],
  })
  assert.doesNotMatch(text(container), /插件|plugin/i, 'a transport blip must not be reported as a stale plugin')
})

test('a campaigns shape change is named as an update, not echoed as a raw host diagnostic', async () => {
  // The campaigns failure used to be printed verbatim ("Qoder campaigns failed:
  // …"). That is right for a broken endpoint (the reason is actionable) but
  // wrong for a shape change: the fix is a plugin update, so the raw rejection
  // text would send the user chasing a network problem that is not there.
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        userQuota: { used: 25, total: 100, remaining: 75, percentage: 0.25, unit: 'credits' },
        campaigns: [],
        campaignsError: 'Qoder campaigns failed: no known campaigns field',
        campaignsShapeChanged: true,
      },
    ],
  })
  const note = [...container.querySelectorAll('p')].find(
    (n) => /活动|offer/i.test(text(n)) && /插件|plugin/i.test(text(n)),
  )
  assert.ok(note !== null, `the drift note must be visible; the panel said: ${text(container).slice(0, 500)}`)
  assert.doesNotMatch(text(note), /no known campaigns field/, 'the raw host diagnostic is not user copy')
})

test('a rendered campaign wins over the campaigns-error note', async () => {
  // The note explains an ABSENT list. If a campaign is present there is nothing
  // to explain, and printing both would contradict the row right above it.
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        userQuota: { used: 25, total: 100, remaining: 75, percentage: 0.25, unit: 'credits' },
        campaigns: [{ key: 'a', title: '每天领 100 Credits' }],
        campaignsError: 'Qoder campaigns failed: HTTP 500',
      },
    ],
  })
  assert.equal(
    [...container.querySelectorAll('p')].find((n) => /HTTP 500/.test(text(n))),
    undefined,
    'a present campaign list must not be contradicted by a failure note',
  )
  assert.equal(container.querySelectorAll('.dsm-qoder-usage-promo').length, 1, 'the campaign must print')
})

test('a live check-in card wins over the machine-identity note', async () => {
  // If a round IS running, the card is the answer; the note would contradict it
  // and is exactly the kind of permanent warning the previous test guards.
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        addOnQuota: { used: 0, total: 100, remaining: 100, percentage: 0, unit: 'credits' },
        checkin: { active: true, todayCheckedIn: false, amount: 100 },
      },
    ],
    usageCheckin: { umidAvailable: false, reason: 'no matching version root' },
  })
  assert.ok(container.querySelector('.dsm-qoder-checkin') !== null, 'the live round must render')
  assert.equal([...container.querySelectorAll('p')].find((n) => /no matching version root/.test(text(n))), undefined)
})

test('a machine-identity note with no reason is not shown', async () => {
  // A hint whose reason is missing would render as a warning explaining
  // nothing — a blank, which is the failure being fixed. Better silent.
  const { container } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        addOnQuota: { used: 0, total: 100, remaining: 100, percentage: 0, unit: 'credits' },
        checkin: { active: false, todayCheckedIn: false },
      },
    ],
    usageCheckin: { umidAvailable: false },
  })
  assert.equal([...container.querySelectorAll('p')].find((n) => /no matching version root/.test(text(n))), undefined)
})

test('a save the host endpoint refuses surfaces the reason, not a "saved" banner', async () => {
  // The 0.1.7 silent-failure mode: the host endpoint is refused (503) AND the
  // settings scope resolves without persisting. The card must report the
  // failure rather than trust a resolved `set()`.
  const { container, react } = await mount({ saveStatus: 503, scopePersist: false })

  // Toggle one model's picker checkbox: that is the minimal edit that makes the
  // card dirty and enables the save button.
  const first = container.querySelector('.dsm-qoder-pick input[type="checkbox"]')
  assert.ok(first !== null, 'no picker checkbox rendered')
  await update(react, () => first.click())

  const save = [...container.querySelectorAll('button')].find((b) => text(b) === '保存')
  assert.ok(save !== undefined, 'no save button')
  await update(react, () => save.click())
  // `save()` awaits three sequential writes; yield enough turns for the chain.
  for (let i = 0; i < 6; i++) await update(react, () => {})

  const states = [...container.querySelectorAll('.dsm-qoder-state')].map((n) => text(n))
  assert.ok(
    states.some((s) => s.startsWith('保存失败')),
    'a refused save must show a failure banner, not "已保存"',
  )
  assert.ok(
    !states.includes('已保存'),
    'the card must not claim a save that never persisted',
  )
})

// The card's sharpest edge. The switch used to sit inside the region pill,
// eight pixels from the tab button, with no text of its own: the pill read as
// one control while its two halves did opposite things — the name switched the
// VIEW, the switch wrote a setting that drops the whole edition from DSH's
// model picker, and the only thing saying so was a tooltip. Both halves of
// that are pinned here: no switch in the tab strip, and the switch that does
// exist carries a visible label.
test('the region tab strip carries no switch, and the setting is labelled where it lives', async () => {
  const { container } = await mount()

  const strip = container.querySelector('.dsm-qoder-region-tabs')
  assert.ok(strip !== null, 'no region strip rendered')
  assert.equal(
    strip.querySelectorAll('input[type="checkbox"]').length,
    0,
    'a tab strip must not carry a control that writes a setting',
  )

  const account = container.querySelector('.dsm-qoder-account')
  const offer = account.querySelector('.dsm-qoder-offer-toggle')
  assert.ok(offer !== null, 'the provider switch belongs to the account card')
  assert.match(
    text(offer.closest('.dsm-qoder-switch')),
    /启用此版本/,
    'the switch must say what flipping it does, not rely on a tooltip',
  )
})

test('a provider switch the host refuses reverts and names the reason', async () => {
  // The account panel's region switch writes through the settings pipeline
  // (host endpoint first, scope mirror second) with the COMPLETE map. A
  // refused write — the endpoint answers 503 AND the scope mirror does not
  // persist — must leave the switch in its old position and SHOW the reason.
  // A silent no-op here is the "everything looks fine" reading the PLAN
  // forbids: the user flips the switch, sees it move, and believes the
  // region is (not) offered when it still is (isn't).
  const { container, react } = await mount({ saveStatus: 503, scopePersist: false })

  // The switch now lives in the account card and covers the SELECTED edition,
  // so there is one of them rather than one per region — selected by tab, not
  // by index. Flipping it still writes the complete map, so a sibling edition
  // cannot be lost either way.
  const qoder = container.querySelector('.dsm-qoder-offer-toggle')
  assert.ok(qoder !== null, 'no provider switch rendered')
  assert.equal(qoder.checked, true, 'the selected edition starts offered')

  await update(react, () => qoder.click())
  // The write is a two-hop chain (endpoint 503, then the scope read-back);
  // yield enough turns for the failure to settle and the switch to revert.
  for (let i = 0; i < 4; i++) await update(react, () => {})

  assert.equal(
    qoder.checked,
    true,
    'a refused write must leave the switch in its old position, not a stale new one',
  )
  const notes = [...container.querySelectorAll('.dsm-qoder-account-note-error')].map((n) => text(n))
  assert.ok(
    notes.some((n) => n.startsWith('保存「启用此版本」开关失败')),
    `the refusal must be shown with its reason, not swallowed; saw: ${JSON.stringify(notes)}`,
  )
})

test('the name filter narrows the roster and counts what remains', async () => {
  const { container, react } = await mount({
    models: [model({ id: 'a1', name: 'Alpha' }), model({ id: 'b1', name: 'Beta' })],
  })

  const input = container.querySelector('.dsm-qoder-search')
  assert.ok(input !== null, 'no search box rendered')
  await update(react, () => {
    // `value` is the controlled input; set it the way the browser would.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'alpha')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  const names = [...container.querySelectorAll('.dsm-qoder-name')].map((n) => n.textContent)
  assert.deepEqual(names, ['Alpha'], 'the filter must hide Beta')

  const count = container.querySelector('.dsm-qoder-count')
  assert.match(count.textContent, /1 \/ 2/, 'the counter must report the filtered view')
})

test('a filter that matches nothing offers a one-click way back', async () => {
  const { container, react } = await mount({
    models: [model({ id: 'a1', name: 'Alpha' })],
  })

  const input = container.querySelector('.dsm-qoder-search')
  await update(react, () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'zzz-no-such-model')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  const empty = [...container.querySelectorAll('.dsm-qoder-state')]
    .find((n) => n.textContent.includes('没有匹配'))
  assert.ok(empty !== undefined, 'an empty result must say so')

  const clear = [...container.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '清除筛选')
  assert.ok(clear !== undefined, 'an empty result must offer to clear the filter')
  await update(react, () => clear.click())

  const names = [...container.querySelectorAll('.dsm-qoder-name')].map((n) => n.textContent)
  assert.deepEqual(names, ['Alpha'], 'clearing the filter must restore the roster')
})

test('a protocol-shape change is shown as "update the plugin", not "re-sign in"', async () => {
  const { container } = await mount({
    models: [
      model({ id: 'm1', promotion: { active: false, windowStart: '22:00', windowEnd: '08:00' } }),
    ],
    fetch: (() => {
      const json = (value) => ({ ok: true, status: 200, json: async () => value })
      const models = [
        { id: 'm1', region: 'qoder-cn', name: 'Alpha', isVL: false },
      ]
      return async (url) => {
        const path = String(url)
        if (path.includes('/models')) {
          return json({
            models,
            imageOverrides: {},
            enabledModelIds: {},
            useMaximumContextWindow: false,
            refreshedAt: 1750000000000,
            refreshFailures: [{ reason: 'protocol-shape-changed' }],
          })
        }
        if (path.includes('/account')) {
          return json({
            regions: [
              { region: 'qoder-cn', regionName: 'Qoder CN', state: 'ok', enabled: true },
            ],
            enabledRegions: { 'qoder-cn': true },
          })
        }
        if (path.includes('/usage')) return json({ regions: [] })
        throw new Error(`unexpected fetch: ${path}`)
      }
    })(),
  })

  const states = [...container.querySelectorAll('.dsm-qoder-state')].map((n) => text(n))
  const protocol = states.find((s) => s.includes('更新插件'))
  assert.ok(
    protocol !== undefined,
    `a protocol change must point at a plugin update, got ${JSON.stringify(states)}`,
  )
  // The copy also says "重新登录没有用" — that is the point. The assertion that
  // matters is the FIRST remedy named is the update, not a re-sign-in prompt.
  assert.ok(
    protocol.indexOf('更新插件') < protocol.indexOf('登录') || !protocol.includes('登录'),
    `the copy must lead with the update, got ${JSON.stringify(protocol)}`,
  )
})

test('a swallowed catalog write is shown as not-persisted, not as a fresh stamp', async () => {
  // The persist verdict's whole job: the rows on screen ARE the newest answer,
  // so the card must not stamp them "已更新（time）" (which would hide that a
  // restart reverts them) and must not mark them stale (which would send the
  // user to refresh a roster that is already current).
  const { container } = await mount({
    models: [
      model({ id: 'm1', promotion: { active: false, windowStart: '22:00', windowEnd: '08:00' } }),
    ],
    fetch: (() => {
      const json = (value) => ({ ok: true, status: 200, json: async () => value })
      const models = [
        { id: 'm1', region: 'qoder-cn', name: 'Alpha', isVL: false },
      ]
      return async (url) => {
        const path = String(url)
        if (path.includes('/models')) {
          return json({
            models,
            imageOverrides: {},
            enabledModelIds: {},
            useMaximumContextWindow: false,
            refreshedAt: 1750000000000,
            refreshFailures: [{ reason: 'persist', detail: 'EACCES: permission denied' }],
          })
        }
        if (path.includes('/account')) {
          return json({
            regions: [
              { region: 'qoder-cn', regionName: 'Qoder CN', state: 'ok', enabled: true },
            ],
            enabledRegions: { 'qoder-cn': true },
          })
        }
        if (path.includes('/usage')) return json({ regions: [] })
        throw new Error(`unexpected fetch: ${path}`)
      }
    })(),
  })

  const states = [...container.querySelectorAll('.dsm-qoder-state')].map((n) => text(n))
  const persist = states.find((s) => s.includes('写盘失败'))
  assert.ok(
    persist !== undefined,
    `a swallowed write must be named, got ${JSON.stringify(states)}`,
  )
  assert.ok(
    persist.includes('重启'),
    `the persist copy must name the restart consequence, got ${JSON.stringify(persist)}`,
  )
})

test('toggling the max-window switch does not erase the load-failure detail', async () => {
  // The models route refuses. The card must keep showing WHY the roster did not
  // load even after an unrelated view toggle: the banner renders
  // `请求失败: ${notice}`, and clearing `notice` here would leave an empty
  // detail after the colon — the user's only hint gone on a toggle that has
  // nothing to do with the load.
  const base = routeStub()
  const fetch = (url, init) => (
    String(url).includes('/models')
      ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
      : base(url, init)
  )
  const { container, react } = await mount({ fetch })

  // Yield enough turns for the models read to settle into the error state.
  for (let i = 0; i < 4; i++) await update(react, () => {})

  const error = container.querySelector('.dsm-qoder-error')
  assert.ok(error !== null, 'a refused models read must render the error banner')
  assert.ok(
    text(error).includes('HTTP 500'),
    `the banner must carry the reason before the toggle; saw: ${text(error)}`,
  )

  const maxWindow = container.querySelector('.dsm-qoder-switch input[type="checkbox"]')
  assert.ok(maxWindow !== null, 'no max-window switch rendered')
  await update(react, () => maxWindow.click())

  const errorAfter = container.querySelector('.dsm-qoder-error')
  assert.ok(errorAfter !== null, 'the error banner must survive the toggle')
  assert.ok(
    text(errorAfter).includes('HTTP 500'),
    `the failure reason must survive the toggle; saw: ${text(errorAfter)}`,
  )
})

// Fourteen rows each printing "跟随目录" — a value that means "nothing was
// set" — made that column the loudest thing on the card. The selects are now
// behind a view switch, and the switch must be able to bring them back.
test('the per-row image selects stay out of the way until they are asked for', async () => {
  const { container, react } = await mount({ models: [model({ id: 'm1', name: 'Alpha' })] })

  assert.equal(
    container.querySelectorAll('.dsm-qoder-select').length,
    0,
    'a default row must not print a select whose value says nothing was set',
  )

  const tuning = container.querySelector('input[aria-label="按模型微调图像输入"]')
  assert.ok(tuning !== null, 'the tuning switch is missing')
  await update(react, () => tuning.click())

  assert.equal(
    container.querySelectorAll('.dsm-qoder-select').length,
    1,
    'the tuning switch must reveal the per-row select',
  )
})

// The stronger half of the rule: the switch is a VIEW switch, so it must never
// be able to hide a value the user actually set. A model carrying an override
// keeps its select even with the switch off.
// Upstream ships several campaigns at once. Stacked, each took a full line
// with the same badge at the same weight, until the promo block was taller
// than the quota it sits under — and the badge carries no information of its
// own, since it is the same string on every line.
test('several campaigns collapse behind a count, and print one badge between them', async () => {
  const { container, react } = await mount({
    usageRegions: [
      {
        region: 'qoder-cn',
        available: true,
        campaigns: [
          { key: 'a', title: '每天领 100 Credits' },
          { key: 'b', title: '首月 Credits 翻倍' },
        ],
      },
    ],
  })
  for (let i = 0; i < 3; i++) await update(react, () => {})

  assert.equal(
    container.querySelectorAll('.dsm-qoder-usage-promo').length,
    0,
    'two campaigns must not both print by default',
  )

  const toggle = container.querySelector('.dsm-qoder-disclosure')
  assert.ok(toggle !== null, 'no campaign disclosure rendered')
  // The folded label keeps the offer wording: folding the campaigns away must
  // not also drop the signal that the account HAS offers.
  assert.equal(text(toggle), '限时特惠 · 2 个活动')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  await update(react, () => toggle.click())

  assert.equal(
    container.querySelectorAll('.dsm-qoder-usage-promo').length,
    2,
    'expanding must print every campaign',
  )
  assert.equal(
    container.querySelectorAll('.dsm-qoder-usage-badge-offer').length,
    1,
    'the identical badge must print once, not once per campaign',
  )
  assert.equal(
    container.querySelector('.dsm-qoder-disclosure').getAttribute('aria-expanded'),
    'true',
    'the collapse control must report the expanded state it offers',
  )
})

test('an image override the user set is never hidden by the view switch', async () => {
  const { container } = await mount({
    fetch: routeStub({ models: [model({ id: 'm1', name: 'Alpha' })], imageOverrides: { m1: 'on' } }),
  })

  const select = container.querySelector('.dsm-qoder-select')
  assert.ok(select !== null, 'a model with an override must keep its select with the switch off')
  assert.equal(select.value, 'on', `the saved override must be the selected value; saw: ${select.value}`)
})

// The save/discard row used to sit OUTSIDE the scrolling list, which handed its
// `position:sticky` to whichever ancestor the host happened to make the
// scrollport. In the live settings pane that pinned it to the page's scroll
// edge and painted it across the fourth model row — the roster read as two
// broken halves. Sharing the roster's own scroll box is what makes the pin
// deterministic, so the nesting is the contract, not an implementation detail.
test('the commit bar shares the roster scroll box instead of the host page', async () => {
  const { container } = await mount({ models: [model({ id: 'm1', name: 'Alpha' })] })

  const body = container.querySelector('.dsm-qoder-body')
  assert.ok(body !== null, 'the card body is missing')
  const roster = body.querySelector(':scope > .dsm-qoder-roster')
  assert.ok(roster !== null, 'the roster box is not a direct child of the body')
  assert.ok(
    roster.querySelector('.dsm-qoder-models') !== null,
    'the roster box must own the model list it scrolls',
  )
  assert.ok(
    roster.querySelector(':scope > .dsm-qoder-actions-save') !== null,
    'the commit bar must be a direct child of the roster box',
  )
  assert.equal(
    body.querySelectorAll(':scope > .dsm-qoder-actions-save').length,
    0,
    'the commit bar must not be a body-level sibling of the list — that is the ' +
      'shape whose sticky positioning the host page takes over',
  )
})

// "按最大上下文显示" is persisted state: it dirties the card, and the commit
// controls are now the roster's own footer. A setting a save would carry has to
// sit above the row that saves it, or a user flips the switch and the button
// that commits it is behind them.
test('every setting the commit bar saves renders above it', async () => {
  const { container } = await mount({ models: [model({ id: 'm1', name: 'Alpha' })] })

  const switches = container.querySelector('.dsm-qoder-switches')
  assert.ok(switches !== null, 'the roster-level switches are missing')
  assert.ok(
    switches.querySelector('input[aria-label="按最大上下文显示"]') !== null,
    'the persisted max-window switch must live in the roster-level switch row',
  )

  const bar = container.querySelector('.dsm-qoder-actions-save')
  assert.ok(bar !== null, 'the commit bar is missing')
  const all = [...container.querySelectorAll('*')]
  assert.ok(
    all.indexOf(switches) < all.indexOf(bar),
    'the persisted switch row must render above the commit bar, not below it',
  )
})


test('a failed provider registration is warned about on the roster that renders anyway', async () => {
  // docs/issues/20 stopped the roster route from 404-ing when the provider half
  // dies, which fixed the blank card but created a worse-looking state: a full,
  // tickable roster whose models the chat picker does not offer, with nothing on
  // screen explaining why. The warning is the explanation.
  const { container } = await mount({
    models: [model({ id: 'm1', promotion: { active: false, windowStart: '22:00', windowEnd: '08:00' } })],
    fetch: (() => {
      const json = (value) => ({ ok: true, status: 200, json: async () => value })
      return async (url) => {
        const path = String(url)
        if (path.includes('/models')) {
          return json({
            models: [{ id: 'm1', region: 'qoder-cn', name: 'Alpha', isVL: false }],
            imageOverrides: {},
            enabledModelIds: {},
            useMaximumContextWindow: false,
            refreshedAt: 1750000000000,
            refreshFailures: [],
            providerRegistration: { ok: false, errorName: 'TypeError' },
          })
        }
        if (path.includes('/account')) {
          return json({ regions: REGIONS, enabledRegions: { 'qoder-cn': true, qoder: true } })
        }
        if (path.includes('/usage')) return json({ regions: [] })
        throw new Error(`unexpected fetch: ${path}`)
      }
    })(),
  })

  const warning = container.querySelector('.dsm-qoder-error')
  assert.ok(warning !== null, 'a dead provider must be visible, not just logged')
  assert.match(text(warning), /TypeError/, 'the warning must name the failure, not just report one')
  assert.match(text(warning), /注册失败/)
  // The rows are STILL there — the warning explains the roster, it does not
  // replace it. Hiding the models would leave nothing to explain.
  assert.deepEqual([...container.querySelectorAll('.dsm-qoder-name')].map((n) => text(n)), ['Alpha'])
})

test('a registered provider produces no warning at all', async () => {
  // The false-alarm direction: warning on a healthy host would train people to
  // ignore the line, which is how the real one gets missed.
  const { container } = await mount({
    models: [model({ id: 'm1', promotion: { active: false, windowStart: '22:00', windowEnd: '08:00' } })],
    fetch: (() => {
      const json = (value) => ({ ok: true, status: 200, json: async () => value })
      return async (url) => {
        const path = String(url)
        if (path.includes('/models')) {
          return json({
            models: [{ id: 'm1', region: 'qoder-cn', name: 'Alpha', isVL: false }],
            imageOverrides: {},
            enabledModelIds: {},
            useMaximumContextWindow: false,
            refreshedAt: 1750000000000,
            refreshFailures: [],
            providerRegistration: { ok: true },
          })
        }
        if (path.includes('/account')) {
          return json({ regions: REGIONS, enabledRegions: { 'qoder-cn': true, qoder: true } })
        }
        if (path.includes('/usage')) return json({ regions: [] })
        throw new Error(`unexpected fetch: ${path}`)
      }
    })(),
  })

  assert.equal(container.querySelector('.dsm-qoder-error'), null)
})

// ---------------------------------------------------------------------------
// The plugin's OWN credential (`device-login-panel.tsx`).
//
// Every case below drives the block through the ACCOUNT route, because that is
// where the host reports it: `device` rides on each region entry, beside `state`
// and never merged into it. The block is absent from the rest of this file's
// fixtures on purpose — those carry no `device` at all, which is exactly the
// older-host case, and their passing is the compatibility half of this.
// ---------------------------------------------------------------------------

/** The region list with a `device` entry hung on the selected edition. */
const regionsWithDevice = (device) => [
  { ...REGIONS[0], device },
  { ...REGIONS[1] },
]

/** The rendered plugin-sign-in block, or null when it did not render. */
const deviceBlock = (container) => container.querySelector('.dsm-qoder-device')

/** The block's buttons, labelled by their visible text. */
const deviceButtons = (block) => [...block.querySelectorAll('button')].map((n) => text(n))

test('a stored plugin credential offers sign-out, and says it is signed in', async () => {
  const { container } = await mount({ accountRegions: regionsWithDevice({ state: 'ok' }) })

  const block = deviceBlock(container)
  assert.ok(block !== null, 'a host that reports a device credential must show the block')
  const body = text(block)
  assert.match(body, /插件自有登录/, 'the block must name itself')
  assert.match(body, /插件已登录/, 'the ok state must be stated, not left to the buttons')
  // Sign-out is the whole point of showing this: the token is on disk and the
  // user is the only one who can remove it.
  assert.ok(deviceButtons(block).includes('退出插件登录'), 'a stored token must be removable')
  // And the note says what the removal does NOT touch — the desktop sign-in, an
  // environment PAT, the other edition.
  assert.match(body, /只删除插件自己的令牌/)
})

test('a machine with no plugin credential offers the browser sign-in', async () => {
  const { container } = await mount({ accountRegions: regionsWithDevice({ state: 'none' }) })

  const block = deviceBlock(container)
  assert.ok(block !== null, 'the sign-in affordance is the reason this block exists')
  const body = text(block)
  assert.match(body, /本机没有插件自己的登录/)
  assert.ok(deviceButtons(block).includes('浏览器登录'), 'the way in must be offered')
  // Nothing to remove — offering it would be a button that does nothing.
  assert.equal(
    deviceButtons(block).some((label) => label.includes('退出插件登录')),
    false,
    'sign-out must not be offered when there is no token',
  )
})

test('a refused renewal shows the host reason, and keeps sign-out available', async () => {
  // The state where the plugin HAS a token that no longer works. Reporting only
  // "sign in again" would strand it: the file is still on disk, still the
  // credential the next request picks up, and the user can see no way to clear it.
  const { container } = await mount({
    accountRegions: regionsWithDevice({ state: 'refresh-failed', reason: 'the renewal was refused' }),
  })

  const block = deviceBlock(container)
  assert.ok(block !== null, 'a refused renewal is a state the user has to act on')
  assert.match(text(block), /the renewal was refused/, 'the host reason must reach the reader')
  assert.ok(deviceButtons(block).includes('退出插件登录'), 'a dead token must still be removable')
  // Rendered as a failure, not as a neutral note: this is the difference
  // between "worth reading" and "worth acting on".
  assert.ok(
    block.querySelector('.dsm-qoder-account-note-error') !== null,
    'a refused renewal must read as an error',
  )
})

test('a host that reports no device entry renders no block at all', async () => {
  // The older-host direction. Rendering "not signed in" here would be a claim
  // the card cannot make: the host never looked, so the honest answer is
  // silence — not a sign-in button for a route that does not exist.
  const { container } = await mount()

  assert.equal(deviceBlock(container), null, 'no device entry must render nothing')
})

test('an unrecognised device state is named, never rendered as fine', async () => {
  // A newer host that grew a state this build does not know must not be shown
  // as `ok` — that is the false-reassurance direction, and it is the one a
  // keyword lookup would get wrong by falling through to a default.
  const { container } = await mount({ accountRegions: regionsWithDevice({ state: 'some-new-state' }) })

  const block = deviceBlock(container)
  assert.ok(block !== null, 'an unknown state is still a state worth stating')
  assert.match(text(block), /状态未知/, 'an unknown state must say so')
})

// ---------------------------------------------------------------------------
// The remedies offered when the DESKTOP sign-in cannot be read.
//
// This is the macOS / Linux case: the client IS installed and signed in, the
// plugin just cannot read that platform's keychain, and the host says so —
// "this plugin can only read the Qoder sign-in on Windows; darwin has no
// supported keychain path yet". The old copy sent such a user to a PAT, which
// is a second-best path that needs a token minted in a web console first. The
// plugin's OWN browser sign-in is the one way in that holds on every platform,
// desktop client or not, so the copy leads with it.
//
// Two directions, because the button is not always there: a host that reports
// no `device` entry (an older build) renders no sign-in block at all, and a
// pointer at a button that is not on the screen is the same lie in a new shape.
// ---------------------------------------------------------------------------

/** The host's own wording for "this platform has no readable keychain". */
const PLATFORM_DETAIL =
  'this plugin can only read the Qoder sign-in on Windows; darwin has no supported keychain path yet'

/**
 * The region list with the desktop sign-in unreadable, with or without the
 * plugin's own credential reported beside it.
 *
 * `device: undefined` is dropped by the JSON round-trip, which is exactly what
 * an older host sends: no `device` key at all.
 */
const regionsNeedingApp = (device) => [
  { ...REGIONS[0], state: 'needs-app', detail: PLATFORM_DETAIL, device },
  { ...REGIONS[1] },
]

/** The account note that reports the unreadable desktop sign-in, or null. */
const unreadableNote = (container) =>
  [...container.querySelectorAll('.dsm-qoder-account-note-error')]
    .map((n) => text(n))
    .find((body) => body.includes(PLATFORM_DETAIL)) ?? null

test('an unreadable desktop sign-in points at the browser sign-in first', async () => {
  const { container } = await mount({
    accountRegions: regionsNeedingApp({ state: 'none' }),
  })

  const note = unreadableNote(container)
  assert.ok(note !== null, 'an unreadable sign-in must say so')
  assert.match(note, /浏览器登录/, 'the browser sign-in must be named')
  // It LEADS: a PAT first would send the user to mint a token for a path that
  // is not the easiest one, and the browser sign-in is the only one that works
  // on a machine whose desktop sign-in cannot be read at all.
  assert.ok(
    note.indexOf('浏览器登录') < note.indexOf('PAT'),
    `the browser sign-in must lead the remedies, got: ${note}`,
  )
  // The PAT stays as the second way in — it is still the only one that needs
  // no browser round-trip at all.
  assert.match(note, /PAT/, 'the PAT fallback must stay available')
  // And the button the copy points at is really on the card.
  const block = deviceBlock(container)
  assert.ok(block !== null, 'the sign-in block must be on the card')
  assert.ok(deviceButtons(block).includes('浏览器登录'), 'the way in must be offered')
})

test('an older host gets the PAT-only wording, never a pointer to a missing button', async () => {
  // The host that reports no `device` entry renders no sign-in block at all
  // (the block's own test above). Pointing at "Sign in with a browser" there
  // would be a dangling pointer, so that host keeps the remedy it does have.
  const { container } = await mount({
    accountRegions: regionsNeedingApp(undefined),
  })

  const note = unreadableNote(container)
  assert.ok(note !== null, 'an unreadable sign-in must say so')
  assert.match(note, /PAT/, 'the PAT fallback must be offered')
  assert.doesNotMatch(note, /浏览器登录/, 'no pointer to a button that is not there')
  assert.equal(deviceBlock(container), null, 'this host has no sign-in block at all')
})

// ---------------------------------------------------------------------------
// What a confirmation that could not run says.
//
// The host answers a confirmation it could not complete with `available: false`.
// It MAY carry a reason — a credential that threw while it was being read — and
// it MAY not: the machine simply has no sign-in to check. The card used to
// collapse both into one line, "Could not confirm: " plus whatever the host
// sent, which for the reason-less answer was a colon followed by nothing. That
// is the failure-that-does-not-say-why shape red line 1 names, and it hid the
// difference between "your credential broke" and "there is no credential".
// ---------------------------------------------------------------------------

/** A fetch stub whose confirmation route answers with the given payload. */
const confirmFetch = (answer) => {
  const base = routeStub({})
  const fetch = async (url, init) => {
    // Checked before the account route: the confirm path contains it.
    if (String(url).includes('/account/confirm')) {
      return { ok: true, status: 200, json: async () => answer }
    }
    return base(url, init)
  }
  return fetch
}

/** The note the confirmation left behind, or null. */
const confirmNote = (container) =>
  [...container.querySelectorAll('.dsm-qoder-account-note-error')]
    .map((n) => text(n))
    .find((body) => body.includes('校验')) ?? null

/** Press "confirm online" on the card and let the answer land. */
async function pressConfirm(container, react) {
  const button = [...container.querySelectorAll('button')].find((b) => text(b) === '在线校验登录')
  assert.ok(button !== undefined, 'the confirm button must be offered')
  await update(react, () => button.click())
  for (let i = 0; i < 4; i++) await update(react, () => {})
}

test('a confirmation the host refuses shows the host reason', async () => {
  const { container, react } = await mount({
    fetch: confirmFetch({ available: false, detail: 'the credential read threw: EPERM' }),
  })

  await pressConfirm(container, react)

  const note = confirmNote(container)
  assert.ok(note !== null, 'a refused confirmation must say so')
  assert.match(note, /EPERM/, 'the host reason must reach the reader')
  assert.doesNotMatch(note, /在线校验失败：\s*$/, 'a reason must not be dropped on the way')
})

test('a confirmation with no sign-in to check says so in its own words', async () => {
  // The host had nothing to check. That is a different failure from a broken
  // credential, and it must not be dressed up as one.
  const { container, react } = await mount({
    fetch: confirmFetch({ available: false }),
  })

  await pressConfirm(container, react)

  const note = confirmNote(container)
  assert.ok(note !== null, 'a confirmation that could not run must say so')
  assert.match(note, /没有可校验的登录/, 'the absence of a sign-in is the reason')
  assert.doesNotMatch(note, /在线校验失败：\s*$/, 'no empty tail after a colon')
})

test('an unreadable desktop sign-in claims no credential source', async () => {
  // The host reports the app DIRECTORY's name in the `needs-app` state: it
  // found Qoder installed and could not read a sign-in out of it. Printing
  // "from Qoder" beside that claim says the credential came from the app —
  // which is precisely what did not happen.
  const { container } = await mount({
    accountRegions: [
      { ...REGIONS[0], source: undefined, state: 'needs-app', detail: PLATFORM_DETAIL },
      { ...REGIONS[1] },
    ],
  })

  const meta = container.querySelector('.dsm-qoder-account-meta')
  assert.ok(
    meta === null || !text(meta).includes('来自 Qoder'),
    'an unreadable sign-in must not claim a credential source',
  )
})

// ---------------------------------------------------------------------------
// Which credential is actually SERVING a region.
//
// The host reports the desktop application's sign-in in `state` and the
// plugin's own credential in `device`, and it deliberately does not merge them
// (see `account-payload.ts`): two credentials, two lifetimes. But the card
// answers ONE question — "am I signed in for this edition?" — and on a machine
// that cannot read the desktop app's keychain the answer is yes whenever the
// plugin's own credential is there. Before this, the same card could say
// "Unreadable" in the state label and "Signed in to the plugin" two lines
// below, which is the contradiction this section exists to end.
// ---------------------------------------------------------------------------

/** The state the region strip shows for one region, as its tab tooltip. */
const regionStateLabel = (container, index = 0) =>
  container.querySelectorAll('.dsm-qoder-region-tab')[index]?.getAttribute('title') ?? ''

/** The tone of one region's status dot. */
const regionDotClass = (container, index = 0) =>
  container.querySelectorAll('.dsm-qoder-region-dot')[index]?.getAttribute('class') ?? ''

test('a region served by the plugin\'s own credential reads as signed in', async () => {
  // The macOS / Linux shape: the desktop application's sign-in cannot be read,
  // the plugin's own credential is there and is what actually serves the
  // region. The card must say so, and must not keep the "unreadable" complaint
  // next to a green dot.
  const { container } = await mount({
    accountRegions: [
      {
        ...REGIONS[0],
        state: 'needs-app',
        source: undefined,
        detail: PLATFORM_DETAIL,
        device: { state: 'ok' },
      },
      { ...REGIONS[1] },
    ],
  })

  const label = regionStateLabel(container, 0)
  assert.match(label, /已登录/, `the region must read as signed in, got: ${label}`)
  assert.doesNotMatch(label, /读不到/, 'a region that is signed in must not read as unreadable')
  assert.match(regionDotClass(container, 0), /dsm-qoder-region-dot-ok/, 'the dot must be the good one')

  // The complaint about the DESKTOP credential is not shown any more: it is
  // not this region's sign-in, and the remedy it offered (sign in with a
  // browser) is the state the region is already in.
  assert.equal(unreadableNote(container), null, 'the desktop complaint must not contradict the sign-in')

  // And the card says WHICH credential is serving, instead of the source the
  // host read (here: none — the desktop store was unreadable).
  const meta = container.querySelector('.dsm-qoder-account-meta')
  assert.ok(meta !== null, 'the serving credential must be named')
  assert.match(text(meta), /来自插件自有登录/, 'the plugin\'s own credential must be named as the one in use')
  assert.doesNotMatch(text(meta), /来自 Qoder/, 'the desktop application is not serving this region')
  assert.doesNotMatch(text(meta), /来自环境变量 PAT/, 'neither is the environment PAT')

  const notes = [...container.querySelectorAll('.dsm-qoder-account-note')].map((n) => text(n))
  assert.ok(
    notes.some((body) => body.includes('当前用的是插件自有登录')),
    'the card must say that the desktop client is not needed',
  )
})

test('the confirmation is offered for a region signed in only by the plugin', async () => {
  // The host reports the plugin's own credential BESIDE the region's sign-in,
  // not as its `source` — so a browser-only user had no way to check that
  // sign-in at all. The button must be there for exactly that case.
  const { container } = await mount({
    accountRegions: [
      { ...REGIONS[0], state: 'signed-out', source: undefined, appName: undefined, device: { state: 'ok' } },
      { ...REGIONS[1] },
    ],
  })

  const buttons = [...container.querySelectorAll('button')].map((n) => text(n))
  assert.ok(
    buttons.includes('在线校验登录'),
    'a region with a plugin credential must be able to check that credential',
  )
})

test('a desktop sign-in that is really serving keeps the card to itself', async () => {
  // The other direction: when the desktop application's credential is the one
  // in use, the plugin's own credential must not take over the card. It is a
  // separate account (the device block still shows it), but the account row
  // describes the credential serving THIS region.
  const { container } = await mount({
    accountRegions: [
      { ...REGIONS[0], state: 'ok', source: 'app', appName: 'Qoder', device: { state: 'ok' } },
      { ...REGIONS[1] },
    ],
  })

  const label = regionStateLabel(container, 0)
  assert.match(label, /正常/, `the desktop state must stand, got: ${label}`)
  assert.doesNotMatch(label, /已登录/, 'the plugin\'s own credential must not take over the state label')

  const meta = container.querySelector('.dsm-qoder-account-meta')
  assert.ok(meta !== null, 'the serving credential must be named')
  assert.match(text(meta), /来自 Qoder/, 'the desktop application must be named as the one in use')
  assert.doesNotMatch(text(meta), /来自插件自有登录/, 'only the credential in use is named')

  const notes = [...container.querySelectorAll('.dsm-qoder-account-note')].map((n) => text(n))
  assert.equal(
    notes.some((body) => body.includes('当前用的是插件自有登录')),
    false,
    'the desktop credential is serving, so the card must not claim otherwise',
  )
})
