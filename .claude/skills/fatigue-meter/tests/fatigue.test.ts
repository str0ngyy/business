import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { measure, report, slimBar, squares } from '../hooks/scale'

const HINT = {
  plugin: 'fatigue-meter',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  viewport: { columns: 100, rows: 30 },
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
  const seen = { toasts: [] as string[], status: 'old' as string | undefined }
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '? for shortcuts' }))
  on('command.run', () => ({ text: 'engine' }))

  return seen
}

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

function run(args: string) {
  return { command: 'fatigue', args, ...RUN }
}

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

  test('no reading yet reads as fresh', async () => {
    const fatigue = measure(null, 0)
    expect(fatigue.percent).toBe(0)
    expect(fatigue.zone.id).toBe('fresh')
  })

  test('the slim bar is ten cells, filled to the percent', async () => {
    expect(slimBar(45)).toEqual({ filled: '━━━━━', empty: '─────' })
    expect(slimBar(0)).toEqual({ filled: '', empty: '──────────' })
    expect(slimBar(100)).toEqual({ filled: '━━━━━━━━━━', empty: '' })
  })

  test('the report marks the current zone', async () => {
    const text = report(measure({ tokens: 130_000, window: 200_000 }, 0))
    expect(text).toMatch(/Усталость Claude: 65% — Устаю/)
    expect(text).toMatch(/🟠 60–79%.*← сейчас/)
  })

  test('the colored squares of /fatigue follow the zones', async () => {
    expect(squares(0)).toBe('⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜')
    expect(squares(100)).toBe('🟩🟩🟩🟩🟨🟨🟧🟧🟥🟥')
  })
})

describe('line under the prompt', () => {
  test('sits beside the engine hint, small, on every surface that has the hint line', async ($, on) => {
    engine(on)
    await $.session.measure(measured(130_000))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...HINT, surface })
      expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'усталость' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '━━━━━━━' })).toBeDefined()
      const percent = await ui.find({ type: 'Text', text: '65%' })
      expect(percent?.props.color).toBe('#f97316')
      expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('× hides it in this chat and leaves the engine hint', async ($, on) => {
    engine(on)
    await $.session.measure(measured(90_000))

    for (const surface of ['terminal', 'desktop'] as const) {
      await $.command.run(run('on'))
      const ui = await $.ui.mount({ ...HINT, surface })
      await ui.press({ key: 'hide' })
      expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('/fatigue off hides it, /fatigue on brings it back', async ($, on) => {
    engine(on)
    await $.session.measure(measured(90_000))

    const off = await $.command.run(run('off'))
    expect(off.text).toMatch(/скрыта/)
    let ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '45%' })).toBeUndefined()
    await ui.unmount()

    const back = await $.command.run(run('on'))
    expect(back.text).toMatch(/снова видна/)
    ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '45%' })).toBeDefined()
    await ui.unmount()
  })

  test('a narrow window drops the word and keeps the bar', async ($, on) => {
    engine(on)
    await $.session.measure(measured(20_000))

    const ui = await $.ui.mount({ ...HINT, surface: 'terminal', viewport: { columns: 50, rows: 30 } })
    expect(await ui.find({ type: 'Text', text: 'усталость' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '10%' })).toBeDefined()
    await ui.unmount()
  })
})

describe('command', () => {
  test('/fatigue answers the full scale', async ($, on) => {
    engine(on)
    await $.session.measure(measured(170_000))

    const result = await $.command.run(run(''))
    expect(result.text).toMatch(/Пора в новый чат/)
    expect(result.text).toMatch(/Шкала:/)
  })
})

describe('alerts', () => {
  test('a toast fires once per step up, and none while the line is hidden', async ($, on) => {
    const seen = engine(on)

    await $.session.measure(measured(20_000))
    expect(seen.toasts).toEqual([])

    await $.session.measure(measured(90_000))
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toMatch(/🟡 Бодрый/)

    await $.session.measure(measured(95_000))
    expect(seen.toasts.length).toBe(1)

    await $.command.run(run('off'))
    await $.session.measure(measured(130_000))
    expect(seen.toasts.length).toBe(1)
  })

  test('a chat that updates from an older version drops its pinned status line', async ($, on) => {
    const seen = engine(on)
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    expect(seen.status).toBeUndefined()
  })
})
