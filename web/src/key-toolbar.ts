import type { TerminalInput } from "./input.js"
import { mapKey } from "./keys.js"

type Modifier = "shift" | "ctrl" | "alt"
const SHIFTED: Record<string, string> = {
  "0": ")",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
  "`": "~",
}
const EXTRA_KEY = "alma-herdr-web:extra-keys"
const BASE_KEYS: [string, string, string][] = [
  ["Tab", "tab", "Complete or indent"],
  ["Esc", "esc", "Cancel or leave the current mode"],
  ["Paste", "paste", "Paste from clipboard"],
  ["Shift+Tab", "shift+tab", "Previous completion or application mode"],
  ["↑", "up", "Previous command"],
  ["↓", "down", "Next command"],
  ["Ctrl+C", "ctrl+c", "Interrupt"],
]
const EXTRA_KEYS: [string, string, string][] = [
  ["Ctrl+W", "ctrl+w", "Delete previous word"],
  ["Ctrl+U", "ctrl+u", "Delete to line start"],
  ["Ctrl+A", "ctrl+a", "Line start"],
  ["Ctrl+E", "ctrl+e", "Line end"],
  ["←", "left", "Move left"],
  ["→", "right", "Move right"],
  ["Ctrl+R", "ctrl+r", "Search history"],
  ["Ctrl+K", "ctrl+k", "Delete to line end"],
  ["Ctrl+L", "ctrl+l", "Clear screen"],
  ["Ctrl+D", "ctrl+d", "EOF / exit"],
  ["`", "backtick", "Insert backtick"],
  ["Shift", "shift", "Modify the next key"],
  ["Ctrl", "ctrl", "Modify the next key"],
  ["Alt", "alt", "Modify the next key"],
  ["Enter", "enter", "Also available beside the input"],
  ["⌫", "backspace", "Backspace"],
]

export class KeyToolbar {
  private readonly addButton = document.createElement("button")
  private readonly modifiers = new Set<Modifier>()
  private readonly extra = new Set<string>()
  private readonly modifierButtons = new Map<Modifier, HTMLButtonElement>()
  private generation = 0
  private enabled = false

  constructor(
    private readonly row: HTMLElement,
    private readonly extraMenu: HTMLElement,
    private readonly modeLabel: HTMLElement,
    private readonly input: TerminalInput,
    field: HTMLInputElement,
    canvas: HTMLCanvasElement,
    private readonly status: (message: string, error: boolean) => void,
    private readonly openMenu: () => void = () => {},
  ) {
    try {
      const saved = JSON.parse(localStorage.getItem(EXTRA_KEY) ?? "[]")
      if (Array.isArray(saved)) {
        for (const key of saved) if (EXTRA_KEYS.some((item) => item[1] === key)) this.extra.add(key)
      }
    } catch {
      /* Storage is optional; the toolbar still works for this page. */
    }
    this.addButton.type = "button"
    this.addButton.className = "key-chip key-symbol keys-add"
    this.addButton.textContent = "+"
    this.addButton.dataset.addKeys = ""
    this.addButton.setAttribute("aria-label", "Customize extra keys")
    this.addButton.setAttribute("aria-controls", this.extraMenu.id)
    this.addButton.setAttribute("aria-expanded", "false")
    this.addButton.addEventListener("click", () => {
      const open = this.extraMenu.classList.toggle("hidden") === false
      if (open) this.openMenu()
      this.addButton.setAttribute("aria-expanded", String(open))
    })
    this.row.after(this.addButton)
    this.render()
    for (const target of [field, canvas] as HTMLElement[]) {
      target.addEventListener(
        "keydown",
        (event) => {
          if (!this.enabled || this.modifiers.size === 0 || event.metaKey || event.isComposing || event.keyCode === 229)
            return
          if (this.modifiedKey(event.key, event)) {
            event.preventDefault()
            event.stopImmediatePropagation()
          }
        },
        true,
      )
    }
    field.addEventListener("beforeinput", (event) => {
      if (!this.enabled || event.isComposing || event.inputType !== "insertText" || event.data === null) return
      if (this.modifiers.size > 0 && this.modifiedKey(event.data)) event.preventDefault()
    })
    field.addEventListener("compositionstart", () => this.clearModifiers())
    row.addEventListener("mousedown", (event) => event.preventDefault())
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.addButton.disabled = !enabled
    for (const button of this.row.querySelectorAll("button")) button.disabled = !enabled
    for (const control of this.extraMenu.querySelectorAll("input")) control.disabled = !enabled
  }

  submit(): void {
    this.clearModifiers()
    this.input.submit()
  }

  reset(): void {
    this.generation += 1
    this.clearModifiers()
    this.extraMenu.classList.add("hidden")
    this.addButton.setAttribute("aria-expanded", "false")
  }

  contains(target: Node): boolean {
    return this.row.contains(target) || this.addButton.contains(target) || this.extraMenu.contains(target)
  }

  closeMenu(): void {
    this.extraMenu.classList.add("hidden")
    this.addButton.setAttribute("aria-expanded", "false")
  }

  private button(label: string, onClick: () => void, name = label): HTMLButtonElement {
    const button = document.createElement("button")
    button.type = "button"
    button.className = ["↑", "↓", "←", "→", "+", "⌫", String.fromCharCode(96)].includes(label)
      ? "key-chip key-symbol"
      : "key-chip"
    button.textContent = label
    button.setAttribute("aria-label", name)
    button.title = name
    button.addEventListener("click", onClick)
    this.row.append(button)
    return button
  }

  private render(): void {
    this.row.replaceChildren()
    this.modifierButtons.clear()
    for (const [label, key, hint] of BASE_KEYS) {
      if (key === "paste") this.button(label, () => void this.paste(), hint)
      else this.addKey(label, key, hint)
    }
    for (const [label, key, hint] of EXTRA_KEYS) {
      if (!this.extra.has(key)) continue
      if (["shift", "ctrl", "alt"].includes(key)) this.addModifier(key as Modifier, label)
      else this.addKey(label, key, hint)
    }
    this.extraMenu.replaceChildren()
    const legend = document.createElement("legend")
    legend.textContent = "Extra shortcuts"
    this.extraMenu.append(legend)
    for (const [label, key, hint] of EXTRA_KEYS) {
      const item = document.createElement("label")
      item.dataset.keyLabel = label
      const control = document.createElement("input")
      control.type = "checkbox"
      control.value = key
      control.checked = this.extra.has(key)
      control.addEventListener("change", () => {
        if (control.checked) this.extra.add(key)
        else {
          this.extra.delete(key)
          this.modifiers.delete(key as Modifier)
        }
        try {
          localStorage.setItem(EXTRA_KEY, JSON.stringify([...this.extra]))
        } catch {
          /* Keep the in-memory choice. */
        }
        const position = this.row.scrollLeft
        const menuPosition = this.extraMenu.scrollTop
        this.render()
        this.row.scrollLeft = position
        this.extraMenu.classList.remove("hidden")
        this.addButton.setAttribute("aria-expanded", "true")
        Array.from(this.extraMenu.querySelectorAll<HTMLInputElement>("input"))
          .find((item) => item.value === key)
          ?.focus({ preventScroll: true })
        this.extraMenu.scrollTop = menuPosition
      })
      const text = document.createElement("span")
      const title = document.createElement("span")
      title.textContent = label
      const description = document.createElement("small")
      description.textContent = hint
      text.append(title, description)
      item.append(control, text)
      this.extraMenu.append(item)
    }
    this.syncModifiers()
    this.setEnabled(this.enabled)
  }

  private addModifier(modifier: Modifier, label: string): void {
    const button = this.button(
      label,
      () => {
        if (this.modifiers.has(modifier)) this.modifiers.delete(modifier)
        else this.modifiers.add(modifier)
        this.syncModifiers()
      },
      `Use ${modifier} for the next key`,
    )
    button.setAttribute("aria-pressed", String(this.modifiers.has(modifier)))
    this.modifierButtons.set(modifier, button)
  }

  private addKey(label: string, key: string, hint = label): void {
    this.button(
      label,
      () => {
        if (key === "backtick") {
          if (!this.modifiedKey(String.fromCharCode(96))) this.input.type(String.fromCharCode(96))
        } else {
          const named: Record<string, string> = {
            esc: "Escape",
            tab: "Tab",
            enter: "Enter",
            backspace: "Backspace",
            up: "ArrowUp",
            down: "ArrowDown",
            left: "ArrowLeft",
            right: "ArrowRight",
          }
          if (!this.modifiedKey(named[key] ?? "")) {
            this.clearModifiers()
            this.input.sendSpecial([key])
          }
        }
      },
      key === "backspace" ? "Backspace" : `${label}: ${hint}`,
    )
  }

  private modifiedKey(key: string, event?: KeyboardEvent): boolean {
    if (this.modifiers.size === 0 || key.length === 0) return false
    if (this.modifiers.has("shift") && Array.from(key).length === 1) key = SHIFTED[key] ?? key.toUpperCase()
    const action = mapKey({
      key,
      ctrlKey: this.modifiers.has("ctrl") || event?.ctrlKey,
      altKey: this.modifiers.has("alt") || event?.altKey,
      shiftKey: this.modifiers.has("shift") || event?.shiftKey,
    } as KeyboardEvent)
    if (action === null) return false
    this.clearModifiers()
    if (action.kind === "text") this.input.type(action.text ?? "")
    else this.input.sendSpecial(action.keys ?? [])
    return true
  }

  private clearModifiers(): void {
    this.modifiers.clear()
    this.syncModifiers()
  }

  private syncModifiers(): void {
    for (const [key, button] of this.modifierButtons)
      button.setAttribute("aria-pressed", String(this.modifiers.has(key)))
    const label = [...this.modifiers].map((key) => key.charAt(0).toUpperCase() + key.slice(1)).join("+")
    this.modeLabel.textContent = label.length > 0 ? `Real-time input · ${label}` : "Real-time input"
  }

  private async paste(): Promise<void> {
    const generation = this.generation
    try {
      const text = await navigator.clipboard.readText()
      if (this.enabled && generation === this.generation) this.input.type(text)
    } catch {
      if (!this.enabled || generation !== this.generation) return
      this.status("Clipboard unavailable. Long-press the input field to paste.", true)
      this.input.focusField()
    }
  }
}
