import type { Reading } from '../types'

/**
 * Past this many tokens answers get noticeably less sharp whatever the window,
 * so a 1M-token window is scored against it rather than against its full size.
 */
export const WORK_BUDGET = 400_000

export type Zone = {
  id: 'fresh' | 'ok' | 'tired' | 'exhausted'
  from: number
  emoji: string
  title: string
  color: string
  /** The colored square the zone's cells take in the reply footer. */
  cell: string
  advice: string
  /** The advice as the reply footer says it, after a dash. */
  hint: string
}

export const ZONES: readonly Zone[] = [
  {
    id: 'fresh',
    from: 0,
    emoji: '🟢',
    title: 'Свежий',
    color: '#22c55e',
    cell: '🟩',
    advice: 'Полная концентрация — самое время для сложных задач.',
    hint: 'можно браться за сложные задачи',
  },
  {
    id: 'ok',
    from: 40,
    emoji: '🟡',
    title: 'Бодрый',
    color: '#eab308',
    cell: '🟨',
    advice: 'Всё хорошо. Новую большую задачу лучше начать в новом чате.',
    hint: 'новую большую задачу лучше начать в новом чате',
  },
  {
    id: 'tired',
    from: 60,
    emoji: '🟠',
    title: 'Устаю',
    color: '#f97316',
    cell: '🟧',
    advice: 'Доделай текущую задачу и переходи в новый чат.',
    hint: 'доделай текущую задачу и переходи в новый чат',
  },
  {
    id: 'exhausted',
    from: 80,
    emoji: '🔴',
    title: 'Пора в новый чат',
    color: '#ef4444',
    cell: '🟥',
    advice: 'Скоро автосжатие — детали начнут теряться. Открой новый чат.',
    hint: 'открой новый чат, скоро детали начнут теряться',
  },
]

const TIRED = ZONES.findIndex(zone => zone.id === 'tired')

export const COMPACTED_ADVICE =
  'Было сжатие контекста: ранние детали пересказаны кратко. Лучше продолжить в новом чате.'

const COMPACTED_HINT = 'было сжатие контекста, лучше продолжить в новом чате'

export type Fatigue = {
  /** 0–100: how full the working budget is. */
  percent: number
  /** Index into ZONES; never below «Устаю» once the chat was compacted. */
  level: number
  zone: Zone
  advice: string
  hint: string
  tokens: number
  budget: number
  compactions: number
}

export function zoneIndexAt(percent: number): number {
  let index = 0
  ZONES.forEach((zone, i) => {
    if (percent >= zone.from) index = i
  })

  return index
}

export function measure(reading: Reading | null, compactions: number): Fatigue {
  const tokens = reading?.tokens ?? 0
  const budget = Math.min(reading?.window ?? WORK_BUDGET, WORK_BUDGET)
  const percent = Math.min(100, Math.max(0, Math.round((tokens / budget) * 100)))
  const level = Math.max(zoneIndexAt(percent), compactions > 0 ? TIRED : 0)
  const zone = ZONES[level] ?? ZONES[0]!
  const isCompacted = compactions > 0 && zoneIndexAt(percent) < TIRED
  const advice = isCompacted ? COMPACTED_ADVICE : zone.advice
  const hint = isCompacted ? COMPACTED_HINT : zone.hint

  return { percent, level, zone, advice, hint, tokens, budget, compactions }
}

export type Segment = { text: string; color?: string }

/** The bar as runs of one color: filled cells take the color of the zone they sit in. */
export function barSegments(percent: number, cells: number): Segment[] {
  const filled = Math.round((percent / 100) * cells)
  const runs: Segment[] = []

  for (let i = 0; i < cells; i += 1) {
    const color = i < filled ? ZONES[zoneIndexAt(((i + 0.5) / cells) * 100)]!.color : undefined
    const glyph = i < filled ? '█' : '░'
    const last = runs[runs.length - 1]

    if (last && last.color === color) {
      last.text += glyph
    } else {
      runs.push({ text: glyph, color })
    }
  }

  return runs
}

/** The bar in colored squares, for a surface that draws only text (the app's transcript). */
export function squares(percent: number, cells = 10): string {
  const filled = Math.round((percent / 100) * cells)
  let bar = ''

  for (let i = 0; i < cells; i += 1) {
    bar += i < filled ? ZONES[zoneIndexAt(((i + 0.5) / cells) * 100)]!.cell : '⬜'
  }

  return bar
}

/** The line appended to the end of a reply where nothing draws the band. */
export function footer(fatigue: Fatigue): string {
  return `\n\n---\n${squares(fatigue.percent)} **Усталость ${fatigue.percent}% · ${fatigue.zone.title}** — ${fatigue.hint}`
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`

  return String(tokens)
}

export function statusLine(fatigue: Fatigue): string | undefined {
  if (fatigue.level < TIRED) return undefined

  return `${fatigue.zone.emoji} Усталость ${fatigue.percent}% — ${fatigue.advice}`
}

export function toastText(fatigue: Fatigue): string {
  return `${fatigue.zone.emoji} ${fatigue.zone.title} (усталость ${fatigue.percent}%). ${fatigue.advice}`
}

export function report(fatigue: Fatigue): string {
  const bar = squares(fatigue.percent)
  const legend = ZONES.map((zone, i) => {
    const to = (ZONES[i + 1]?.from ?? 101) - 1
    const mark = i === fatigue.level ? '  ← сейчас' : ''

    return `${zone.emoji} ${zone.from}–${to}%  ${zone.title}: ${zone.advice}${mark}`
  })
  const compacted =
    fatigue.compactions > 0 ? ` · сжатий контекста: ${fatigue.compactions}` : ''

  return [
    `${fatigue.zone.emoji} Усталость Claude: ${fatigue.percent}% — ${fatigue.zone.title}`,
    `${bar}  ${formatTokens(fatigue.tokens)} из ${formatTokens(fatigue.budget)} токенов${compacted}`,
    fatigue.advice,
    '',
    'Шкала:',
    ...legend,
  ].join('\n')
}
