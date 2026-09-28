/**
 * Shared semantic terminal palette for the CLI presentation layer.
 *
 * Hierarchy rules:
 * - structure glyphs (`┌─`, `├─`, `└─`, `│`) are dimmed so they stop competing with content;
 * - markers are semantic: green success, red failure, yellow in-progress or advisory;
 * - subjects carry the message: bold cyan Turn/Step headers, bold green/red turn outcomes, cyan tool names;
 * - metadata (ids, counts, durations, targets) is dim;
 * - Final content stays in the default foreground so the answer remains the brightest anchor.
 */
export interface TraceColor {
  bold: (value: string) => string
  dim: (value: string) => string
  italic: (value: string) => string
  underline: (value: string) => string
  red: (value: string) => string
  green: (value: string) => string
  yellow: (value: string) => string
  magenta: (value: string) => string
  cyan: (value: string) => string
  boldRed: (value: string) => string
  boldGreen: (value: string) => string
  boldYellow: (value: string) => string
  boldMagenta: (value: string) => string
  boldCyan: (value: string) => string
  dimItalic: (value: string) => string
}

/** Wraps values in a single SGR sequence; all helpers degrade to identity when disabled. */
export function createColor(enabled: boolean): TraceColor {
  const wrap = (code: string) => (value: string) => enabled ? `\u001B[${code}m${value}\u001B[0m` : value
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    italic: wrap('3'),
    underline: wrap('4'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    magenta: wrap('35'),
    cyan: wrap('36'),
    boldRed: wrap('1;31'),
    boldGreen: wrap('1;32'),
    boldYellow: wrap('1;33'),
    boldMagenta: wrap('1;35'),
    boldCyan: wrap('1;36'),
    dimItalic: wrap('2;3'),
  }
}

/** Colors render only on an interactive stream and never when NO_COLOR is set. */
export function supportsColor(output: { isTTY?: boolean | undefined }): boolean {
  return output.isTTY === true && process.env.NO_COLOR === undefined
}
