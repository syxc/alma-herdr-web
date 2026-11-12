export type Theme = "light" | "dark"

export interface TerminalColors {
  foreground: string
  background: string
  palette: readonly string[]
}

// Alma 4.3 Android's built-in schemes; explicit RGB colours stay untouched.
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
