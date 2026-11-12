import type { Theme } from "./terminal-theme.js"

export type Appearance = "system" | Theme
const KEY = "alma-herdr-web:appearance"
let system: MediaQueryList | null = null
let appearance: Appearance = "system"
let changed: (theme: Theme) => void = () => {}

function readAppearance(): Appearance {
  try {
    const stored = window.localStorage.getItem(KEY)
    if (stored === "light" || stored === "dark") return stored
  } catch {
    // The in-memory preference also works when browser storage is unavailable.
  }
  return "system"
}

function apply(): void {
  const theme = appearance === "system" ? (system?.matches ? "dark" : "light") : appearance
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.appearance = appearance
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#282c34" : "#ffffff")
  for (const select of document.querySelectorAll<HTMLSelectElement>("[data-appearance-select]")) {
    select.value = appearance
    const value = select.parentElement?.querySelector("[data-appearance-value]")
    if (value !== null && value !== undefined)
      value.textContent = appearance.charAt(0).toUpperCase() + appearance.slice(1)
  }
  changed(theme)
}

export function initAppearance(onChange: (theme: Theme) => void): void {
  changed = onChange
  appearance = readAppearance()
  system = window.matchMedia("(prefers-color-scheme: dark)")
  system.addEventListener("change", () => {
    if (appearance === "system") apply()
  })
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) {
      appearance = readAppearance()
      apply()
    }
  })
  apply()
}

export function appendAppearanceControl(container: HTMLElement): void {
  const label = document.createElement("label")
  label.className = "appearance-setting"
  label.append("Appearance")
  const select = document.createElement("select")
  select.dataset.appearanceSelect = ""
  for (const value of ["system", "light", "dark"] as const) {
    const option = document.createElement("option")
    option.value = value
    option.textContent = value.charAt(0).toUpperCase() + value.slice(1)
    select.append(option)
  }
  select.value = appearance
  select.addEventListener("change", () => {
    const value = select.value
    if (value !== "system" && value !== "light" && value !== "dark") return
    appearance = value
    try {
      window.localStorage.setItem(KEY, value)
    } catch {
      // A denied storage write must not prevent the visible change.
    }
    apply()
  })
  const control = document.createElement("span")
  control.className = "appearance-control"
  const value = document.createElement("span")
  value.className = "appearance-value"
  value.dataset.appearanceValue = ""
  value.setAttribute("aria-hidden", "true")
  value.textContent = appearance.charAt(0).toUpperCase() + appearance.slice(1)
  control.append(select, value)
  label.append(control)
  container.append(label)
}
