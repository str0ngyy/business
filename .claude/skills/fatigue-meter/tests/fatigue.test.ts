import type { On, RenderSurface, TurnStepChunk, TurnStepResult } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { barSegments, footer, measure, report, squares, statusLine, ZONES } from '../hooks/scale'

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

const USAGE = {
  model: 'claude-test',
  input_tokens: 2,
  output_tokens: 300,
  cache_creation_input_tokens: 4_998,
  cache_read_input_tokens: 85_000,
}

const STEP = { turnId: 't1', index: 0, model: 'claude-test', messageCount: 3 }

/**
 * The engine beneath the plugin for one model request: its chunks, then its result.
 * A stand-in yields only the modeled kinds; engine chunks come from the real engine alone.
 */
function response(on: On, chunks: TurnStepChunk[], surfaces: RenderSurface[] = []) {
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 10_000, window: 200_000, percent: 5 }, rateLimits: [] },
  }))
  on('turn.step', async function* ($, e) {
    for (const chunk of chunks) yield chunk
    const result: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: USAGE,
    }

    return result
  })
}

async function drain(stream: AsyncGenerator<TurnStepChunk, TurnStepResult>) {
  const seen: TurnStepChunk[] = []
  for await (const chunk of stream) seen.push(chunk)

  return seen
}

const FINAL: TurnStepChunk[] = [
  { kind: 'text', index: 0, text: 'Готово, ' },
  { kind: 'text', index: 0, text: 'всё работает.' },
  { kind: 'stop', stopReason: 'end_turn', usage: USAGE },
]

describe('reply footer', () => {
  test('the final answer ends with the scale, inside its own text block', async ($, on) => {
    response(on, FINAL)
    const seen = await drain($.turn.step(STEP))

    const expected = footer(measure({ tokens: 90_000, window: 200_000 }, 0))
    expect(expected).toMatch(/🟩🟩🟩🟩🟨⬜⬜⬜⬜⬜ \*\*Усталость 45% · Бодрый\*\*/)
    expect(seen).toEqual([FINAL[0], FINAL[1], { kind: 'text', index: 0, text: expected }, FINAL[2]])
  })

  test('a response that goes on to call a tool passes through untouched', async ($, on) => {
    const chunks: TurnStepChunk[] = [
      { kind: 'text', index: 0, text: 'Сейчас проверю.' },
      { kind: 'tool', index: 1, id: 'toolu_1', name: 'Bash' },
      { kind: 'input', index: 1, json: '{}' },
      { kind: 'stop', stopReason: 'tool_use', usage: USAGE },
    ]
    response(on, chunks)

    expect(await drain($.turn.step(STEP))).toEqual(chunks)
  })

  test('thinking first, then the answer: the footer follows the answer', async ($, on) => {
    const chunks: TurnStepChunk[] = [
      { kind: 'thinking', index: 0, text: 'хм' },
      { kind: 'text', index: 1, text: 'Ответ.' },
      { kind: 'stop', stopReason: 'end_turn', usage: USAGE },
    ]
    response(on, chunks)
    const seen = await drain($.turn.step(STEP))

    expect(seen.length).toBe(chunks.length + 1)
    expect(seen[2]).toMatchObject({ kind: 'text', index: 1 })
    expect(seen[3]).toEqual(chunks[2])
  })

  test('where a surface draws the band, the answer is left as it came', async ($, on) => {
    response(on, FINAL, ['desktop'])

    expect(await drain($.turn.step(STEP))).toEqual(FINAL)
  })

  test("a subagent's answer is left as it came", async ($, on) => {
    response(on, FINAL)

    expect(await drain($.turn.step({ ...STEP, agentId: 'agent_1' }))).toEqual(FINAL)
  })

  test('the colored squares follow the zones', async () => {
    expect(squares(0)).toBe('⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜')
    expect(squares(100)).toBe('🟩🟩🟩🟩🟨🟨🟧🟧🟥🟥')
  })
})
