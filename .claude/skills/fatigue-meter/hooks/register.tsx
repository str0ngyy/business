import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, StateDollar, TurnStepChunk } from 'claude-code'

import type { Reading } from '../types'
import { barSegments, footer, formatTokens, measure, report, statusLine, toastText } from './scale'

const reading = atom({ plugin: 'fatigue-meter', key: 'reading' } as const, null)
const compactions = atom({ plugin: 'fatigue-meter', key: 'compactions' } as const, 0)
const announced = atom({ plugin: 'fatigue-meter', key: 'announced' } as const, 0)

async function current($: StateDollar) {
  return measure(await read($, reading), await read($, compactions))
}

/** Input tokens a response was answered over: uncached, cache-written and cache-read together. */
function inputTokens(usage: ModelUsage): number {
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
}

/**
 * The footer for the answer that just ended, its usage the freshest figure. A
 * failure only drops the line: a hook that throws mid-stream would cut the answer.
 */
async function footerAfter($: EngineInterface, usage: ModelUsage | null) {
  try {
    const { context } = await $.session.usage()
    const tokens = usage === null ? context.tokens : inputTokens(usage)
    const latest: Reading = { tokens, window: context.window }
    await update($, reading, () => latest)

    return footer(await current($))
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fatigue',
      description: 'Шкала усталости Claude: заполненность контекста и когда открыть новый чат',
      immediate: true,
    })

    try {
      const { context } = await $.session.usage()
      if (context.tokens !== undefined) {
        const seeded: Reading = { tokens: context.tokens, window: context.window }
        await update($, reading, () => seeded)
      }
    } catch {
      // No figures yet: the first measurement fills them in.
    }

    $.ui.status(statusLine(await current($)))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const latest: Reading = { tokens: e.context.tokens, window: e.context.window }
      await update($, reading, () => latest)

      const fatigue = await current($)
      const before = await read($, announced)
      if (fatigue.level > before) {
        $.ui.toast(toastText(fatigue), { timeoutMs: 10_000 })
      }
      await update($, announced, () => fatigue.level)
      $.ui.status(statusLine(fatigue))
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isSkipped = 'skip' in result && typeof result.skip === 'string'

    if (e.agentId === undefined && e.trigger !== 'precompute' && !isSkipped) {
      await update($, compactions, n => (n ?? 0) + 1)
      $.ui.status(statusLine(await current($)))
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, reading, () => null)
      await update($, compactions, () => 0)
      await update($, announced, () => 0)
      $.ui.status(undefined)
    }

    return next(e)
  })

  // Where no surface draws the band (a cloud session the Claude app follows, which
  // shows only the transcript), the scale rides at the end of the final answer.
  // Engine chunks after a text piece are held until the next chunk says whether
  // the answer ends there, so the line lands inside that last text block.
  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const isDrawn = (await $.session.surfaces()).length > 0
    const stream = next(e)

    if (!isMain || isDrawn) {
      return yield* stream
    }

    let lastText: number | undefined
    let held: TurnStepChunk[] = []

    for await (const chunk of stream) {
      if (chunk.kind === 'engine' && lastText !== undefined) {
        held.push(chunk)
        continue
      }

      if (chunk.kind === 'stop' && chunk.stopReason === 'end_turn' && lastText !== undefined) {
        const line = await footerAfter($, chunk.usage)
        if (line !== undefined) {
          yield { kind: 'text', index: lastText, text: line }
        }
      }

      yield* held
      held = []
      lastText = chunk.kind === 'text' ? chunk.index : chunk.kind === 'engine' ? lastText : undefined
      yield chunk
    }

    yield* held

    return await stream.result
  })

  on('command.run', { command: 'fatigue' }, async $ => ({ text: report(await current($)) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const fatigue = await current($)
    const { zone } = fatigue
    const columns = e.props.bodyColumns
    const showTokens = columns >= 72
    const label = `${zone.emoji} ${zone.title}  `
    const used = label.length + 7 + (showTokens ? 34 : 0)
    const cells = Math.max(10, Math.min(24, columns - used))
    const compacted = fatigue.compactions > 0 ? ` · сжатий: ${fatigue.compactions}` : ''

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={zone.color} bold>
            {label}
          </Text>
          {barSegments(fatigue.percent, cells).map(run =>
            run.color === undefined ? (
              <Text dimColor>{run.text}</Text>
            ) : (
              <Text color={run.color}>{run.text}</Text>
            ),
          )}
          <Text bold>{`  ${fatigue.percent}%`}</Text>
          {showTokens && (
            <Text dimColor>
              {`  · ${formatTokens(fatigue.tokens)} / ${formatTokens(fatigue.budget)} токенов${compacted}`}
            </Text>
          )}
        </Box>
        <Text dimColor wrap="truncate-end">
          {`Усталость Claude · ${fatigue.advice}`}
        </Text>
      </Box>
    )
  })
}
