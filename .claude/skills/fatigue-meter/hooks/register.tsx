import { atom, read, update } from 'claude-code'
import type { Register, StateDollar } from 'claude-code'

import type { Reading } from '../types'
import { measure, report, slimBar, toastText } from './scale'

const reading = atom({ plugin: 'fatigue-meter', key: 'reading' } as const, null)
const compactions = atom({ plugin: 'fatigue-meter', key: 'compactions' } as const, 0)
const announced = atom({ plugin: 'fatigue-meter', key: 'announced' } as const, 0)
const isHidden = atom({ plugin: 'fatigue-meter', key: 'isHidden' } as const, false)

async function current($: StateDollar) {
  return measure(await read($, reading), await read($, compactions))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fatigue',
      description: 'Шкала усталости Claude: отчёт; off — скрыть строку под полем ввода, on — вернуть',
      argumentHint: '[on|off]',
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

    // Versions before 0.4 pinned a status line; a chat that updates in place drops it.
    $.ui.status(undefined)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const latest: Reading = { tokens: e.context.tokens, window: e.context.window }
      await update($, reading, () => latest)

      const fatigue = await current($)
      const before = await read($, announced)
      if (fatigue.level > before && !(await read($, isHidden))) {
        $.ui.toast(toastText(fatigue), { timeoutMs: 10_000 })
      }
      await update($, announced, () => fatigue.level)
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isSkipped = 'skip' in result && typeof result.skip === 'string'

    if (e.agentId === undefined && e.trigger !== 'precompute' && !isSkipped) {
      await update($, compactions, n => (n ?? 0) + 1)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, reading, () => null)
      await update($, compactions, () => 0)
      await update($, announced, () => 0)
    }

    return next(e)
  })

  on('command.run', { command: 'fatigue' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off') {
      await update($, isHidden, () => true)

      return { text: 'Шкала под полем ввода скрыта в этом чате. Вернуть: /fatigue on' }
    }

    if (arg === 'on') {
      await update($, isHidden, () => false)

      return { text: 'Шкала под полем ввода снова видна в этом чате.' }
    }

    const hiddenNote = (await read($, isHidden)) ? '\n\nСтрока под полем ввода скрыта. Вернуть: /fatigue on' : ''

    return { text: report(await current($)) + hiddenNote }
  })

  // The slim line sits at the right of the hint line under the prompt; the
  // engine's own hint stays where it was, on the left.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)

    if (await read($, isHidden)) {
      return engineLine
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const fatigue = await current($)
    const { filled, empty } = slimBar(fatigue.percent)
    const isRoomy = (e.viewport?.columns ?? 80) >= 60

    return (
      <Box justifyContent="space-between">
        <Box flexGrow={1}>{engineLine}</Box>
        <Box key="fatigue" columnGap={1}>
          {isRoomy && <Text dimColor>усталость</Text>}
          <Box>
            <Text color={fatigue.zone.color}>{filled}</Text>
            <Text dimColor>{empty}</Text>
          </Box>
          <Text color={fatigue.zone.color}>{`${fatigue.percent}%`}</Text>
          <Button
            key="hide"
            role="dismiss"
            plain
            label="×"
            onPress={() => update($, isHidden, () => true)}
          />
        </Box>
      </Box>
    )
  })
}
