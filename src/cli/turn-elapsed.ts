import type { AgentEvent } from '../runtime/agent-session.ts'

const CLEAR_LINE = '\r\u001B[2K'
const REFRESH_INTERVAL_MS = 1_000

interface ScheduledRefresh {
  cancel: () => void
  unref?: () => void
}

export interface TurnElapsedDisplayOptions {
  enabled: boolean
  write: (text: string) => void
  now?: () => number
  schedule?: (callback: () => void, intervalMs: number) => ScheduledRefresh
}

export interface TurnElapsedDisplay {
  handle: (event: AgentEvent, renderEvent: () => void) => void
  interject: (renderOutput: () => void) => void
  close: () => void
}

/** Keeps a transient elapsed-time line below the active Turn trace in an interactive terminal. */
export function createTurnElapsedDisplay(options: TurnElapsedDisplayOptions): TurnElapsedDisplay {
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? scheduleRefresh
  let startedAt: number | undefined
  let refresh: ScheduledRefresh | undefined
  let streaming = false

  const clear = (): void => {
    if (startedAt !== undefined) options.write(CLEAR_LINE)
  }

  const render = (): void => {
    if (startedAt === undefined || streaming) return
    options.write(`${CLEAR_LINE}⏱ Elapsed ${formatElapsed(now() - startedAt)}`)
  }

  const stop = (): void => {
    refresh?.cancel()
    refresh = undefined
    startedAt = undefined
    streaming = false
  }

  const start = (): void => {
    stop()
    startedAt = now()
    refresh = schedule(render, REFRESH_INTERVAL_MS)
    refresh.unref?.()
  }

  return {
    handle(event, renderEvent) {
      if (!options.enabled) {
        renderEvent()
        return
      }

      if (event.type === 'model.delta') {
        if (!streaming) clear()
        streaming = true
        renderEvent()
        return
      }

      if (!streaming) clear()
      streaming = false
      if (event.type === 'turn.started' || event.type === 'turn.resumed') start()
      renderEvent()

      if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        stop()
        return
      }
      render()
    },
    interject(renderOutput) {
      if (!options.enabled) {
        renderOutput()
        return
      }
      if (!streaming) clear()
      renderOutput()
      streaming = false
      render()
    },
    close() {
      clear()
      stop()
    },
  }
}

export function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const shortTime = `${pad(minutes)}:${pad(seconds)}`
  return hours === 0 ? shortTime : `${hours}:${shortTime}`
}

function scheduleRefresh(callback: () => void, intervalMs: number): ScheduledRefresh {
  const timer = setInterval(callback, intervalMs)
  return {
    cancel: () => clearInterval(timer),
    unref: () => timer.unref(),
  }
}

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}
