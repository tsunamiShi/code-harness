interface Keypress {
  ctrl?: boolean
  name?: string
}

interface KeypressInput {
  on: (event: 'keypress', listener: (text: string, key: Keypress) => void) => unknown
  off: (event: 'keypress', listener: (text: string, key: Keypress) => void) => unknown
}

export interface TraceModeShortcutOptions {
  enabled: boolean
  input: KeypressInput
  onToggle: () => void
}

/** Binds Ctrl+O without coupling terminal key events to Trace rendering. */
export function createTraceModeShortcut(
  options: TraceModeShortcutOptions,
): { close: () => void } {
  if (!options.enabled) return { close: () => undefined }

  const listener = (text: string, key: Keypress): void => {
    if ((key.ctrl === true && key.name === 'o') || text === '\u000F') options.onToggle()
  }
  options.input.on('keypress', listener)
  return {
    close: () => options.input.off('keypress', listener),
  }
}
