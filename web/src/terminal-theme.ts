export type Theme = "light" | "dark"

export interface TerminalColors {
  foreground: string
  background: string
  palette: readonly string[]
}

// Alma 4.3 Android's built-in schemes; low-contrast text adapts on neutral surfaces.
export const TERMINAL_COLORS: Record<Theme, TerminalColors> = {
  light: {
    foreground: "#1a1a1a",
    background: "#ffffff",
    palette: [
      "#000000",
      "#e45649",
      "#50a14f",
      "#c18401",
      "#4078f2",
      "#a626a4",
      "#0184bc",
      "#1a1a1a",
      "#a0a1a7",
      "#e45649",
      "#50a14f",
      "#c18401",
      "#4078f2",
      "#a626a4",
      "#0184bc",
      "#1a1a1a",
    ],
  },
  dark: {
    foreground: "#dcdfe4",
    background: "#282c34",
    palette: [
      "#282c34",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#dcdfe4",
      "#5c6370",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#ffffff",
    ],
  },
}

const NEUTRAL_COLORS = {
  dark: { surface: "#2d313a", muted: "#9da2ae" },
  light: { surface: "#f0f2f5", muted: "#535964" },
}

function channels(color: string): number[] | null {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return null
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16))
}

function neutral(color: string): number[] | null {
  const values = channels(color)
  return values !== null && Math.max(...values) - Math.min(...values) <= 12 ? values : null
}

function luminance(color: string): number {
  const values = (channels(color) ?? [0, 0, 0]).map((value) => {
    const level = value / 255
    return level <= 0.04045 ? level / 12.92 : ((level + 0.055) / 1.055) ** 2.4
  })
  return (values[0] ?? 0) * 0.2126 + (values[1] ?? 0) * 0.7152 + (values[2] ?? 0) * 0.0722
}

function contrast(first: string, second: string): number {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function blend(first: string, second: string, amount: number): string {
  const a = channels(first) ?? [0, 0, 0]
  const b = channels(second) ?? [0, 0, 0]
  return `#${a
    .map((value, index) =>
      Math.round(value * amount + (b[index] ?? 0) * (1 - amount))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

function readable(foreground: string, background: string): string {
  if (contrast(foreground, background) >= 4.5) return foreground
  const target = contrast("#000000", background) > contrast("#ffffff", background) ? "#000000" : "#ffffff"
  let low = 0
  let high = 1
  for (let step = 0; step < 12; step += 1) {
    const amount = (low + high) / 2
    if (contrast(blend(foreground, target, amount), background) >= 4.5) low = amount
    else high = amount
  }
  return blend(foreground, target, low)
}

export function cellColors(
  style: { fg: string; bg: string; reverse: boolean; dim?: boolean },
  theme: Theme,
): { foreground: string; background: string } {
  const defaults = TERMINAL_COLORS[theme]
  const tones = NEUTRAL_COLORS[theme]
  let foreground = style.fg || defaults.foreground
  let background = style.bg
  const fg = neutral(style.fg)
  const bg = neutral(background)
  // Snapshots can bake a desktop app's light theme into RGB cells. Adapt neutral
  // text and surfaces locally, but preserve coloured highlights and logo pairs.
  const colorOnBlack = fg === null && style.fg !== "" && style.bg === "#000000"
  if (bg !== null && !colorOnBlack) {
    const light = bg.reduce((sum, value) => sum + value, 0) / 3 >= 128
    if (light !== (theme === "light")) background = tones.surface
  }
  const surface = background || defaults.background
  if (fg !== null && contrast(foreground, surface) < 4.5) {
    const level = fg.reduce((sum, value) => sum + value, 0) / 3
    const candidate = level < 64 || level > 192 ? defaults.foreground : tones.muted
    if (contrast(candidate, surface) > contrast(foreground, surface)) foreground = candidate
  }
  // Apply inverse before contrast adjustment so cursor polarity stays intact.
  const colors = style.reverse ? { foreground: surface, background: foreground } : { foreground, background }
  const actualBackground = colors.background || defaults.background
  if (style.dim) colors.foreground = blend(colors.foreground, actualBackground, 0.6)
  if (
    !colorOnBlack &&
    (actualBackground === defaults.background ||
      actualBackground === tones.surface ||
      neutral(actualBackground) !== null)
  ) {
    colors.foreground = readable(colors.foreground, actualBackground)
  }
  return colors
}
