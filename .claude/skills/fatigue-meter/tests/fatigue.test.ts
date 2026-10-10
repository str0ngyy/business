import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { barSegments, measure, report, squares, statusLine, ZONES } from '../hooks/scale'

const BAND = {
  plugin: 'fatigue-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

function measured(tokens: number | undefined, window = 200_000) {
  return {
    context: { tokens, window, percent: tokens === undefined ? undefined : Math.round((tokens / window) * 100) },
    rateLimits: [],
    changed: ['context' as const],
  }
}

/** What the engine answers beneath the plugin; the test records toasts and the status line. */
function engine(on: On) {
  const seen = { toasts: [] as string[], status: undefined as string | undefined }
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))
  on('command.run', () => ({ text: 'engine' }))

  return seen
}

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

describe('scale', () => {
  test('zones follow the fill of a 200k window', async () => {
    expect(measure({ tokens: 20_000, window: 200_000 }, 0).zone.id).toBe('fresh')
    expect(measure({ tokens: 90_000, window: 200_000 }, 0).zone.id).toBe('ok')
    expect(measure({ tokens: 130_000, window: 200_000 }, 0).zone.id).toBe('tired')
    expect(measure({ tokens: 170_000, window: 200_000 }, 0).zone.id).toBe('exhausted')
  })

  test('a 1M window is scored against the working budget, not its full size', async () => {
    const fatigue = measure({ tokens: 340_000, window: 1_000_000 }, 0)
    expect(fatigue.percent).toBe(85)
    expect(fatigue.zone.id).toBe('exhausted')
  })

  test('a compacted chat is never shown as fresh', async () => {
    const fatigue = measure({ tokens: 30_000, window: 200_000 }, 1)
    expect(fatigue.zone.id).toBe('tired')
    expect(fatigue.advice).toMatch(/сжатие/)
  })

  test('no reading yet reads as fresh, with no status line', async () => {
    const fatigue = measure(null, 0)
    expect(fatigue.percent).toBe(0)
    expect(fatigue.zone.id).toBe('fresh')
    expect(statusLine(fatigue)).toBeUndefined()
  })

  test('the bar fills in the colors of the zones it crosses', async () => {
    const runs = barSegments(70, 20)
    expect(runs.map(run => run.text).join('')).toBe('██████████████░░░░░░')
    expect(runs.map(run => run.color)).toEqual([ZONES[0]!.color, ZONES[1]!.color, ZONES[2]!.color, undefined])
  })

  test('the report marks the current zone', async () => {
    const text = report(measure({ tokens: 130_000, window: 200_000 }, 0))
    expect(text).toMatch(/Усталость Claude: 65% — Устаю/)
    expect(text).toMatch(/🟠 60–79%.*← сейчас/)
  })
})

describe('band', () => {
  test('draws the zone, the bar and the percent on every surface that has the band', async ($, on) => {
    engine(on)
    await $.session.measure(measured(130_000))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /Устаю/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '65%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /130k \/ 200k/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a narrow band drops the token count but keeps the scale', async ($, on) => {
    engine(on)
    await $.session.measure(measured(20_000))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 50 } })
    expect(await ui.find({ type: 'Text', text: /Свежий/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /токенов/ })).toBeUndefined()
    await ui.unmount()
  })

  test('yields to a survey', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ type: 'Text', text: /Усталость/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  })
})

describe('command', () => {
  test('/fatigue answers the full scale', async ($, on) => {
    engine(on)
    await $.session.measure(measured(170_000))

    const result = await $.command.run({ command: 'fatigue', args: '', ...RUN })
    expect(result.text).toMatch(/Пора в новый чат/)
    expect(result.text).toMatch(/Шкала:/)
  })
})

describe('alerts', () => {
  test('a toast fires once per step up, and the status line pins from «Устаю»', async ($, on) => {
    const seen = engine(on)

    await $.session.measure(measured(20_000))
    expect(seen.toasts).toEqual([])
    expect(seen.status).toBeUndefined()

    await $.session.measure(measured(90_000))
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toMatch(/🟡 Бодрый/)

    await $.session.measure(measured(95_000))
    expect(seen.toasts.length).toBe(1)

    await $.session.measure(measured(130_000))
    expect(seen.toasts.length).toBe(2)
    expect(seen.status).toMatch(/🟠 Усталость 65%/)

    await $.session.measure(measured(170_000))
    expect(seen.toasts[2]).toMatch(/🔴 Пора в новый чат/)
    expect(seen.status).toMatch(/🔴/)
  })
})

describe('squares', () => {
  test('the colored squares of /fatigue follow the zones', async () => {
    expect(squares(0)).toBe('⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜')
    expect(squares(100)).toBe('🟩🟩🟩🟩🟨🟨🟧🟧🟥🟥')
  })
})
