import assert from "node:assert/strict"
import { test } from "node:test"
import { cellColors } from "../web/dist/terminal-theme.js"

function contrast(foreground, background) {
  const luminance = (color) => {
    const rgb = color.match(/[0-9a-f]{2}/gi).map((hex) => Number.parseInt(hex, 16) / 255)
    const linear = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

test("pi accents and muted text retain readable contrast on both neutral themes", () => {
  for (const theme of ["light", "dark"]) {
    for (const fg of ["#d7af5f", "#848891", "#a997df", "#e45649", "#50a14f"]) {
      for (const dim of [false, true]) {
        const colors = cellColors({ fg, bg: "", reverse: false, dim }, theme)
        const bg = colors.background || (theme === "light" ? "#ffffff" : "#282c34")
        assert.ok(contrast(colors.foreground, bg) >= 4.5, `${theme} ${fg} dim=${dim}: ${colors.foreground}`)
      }
    }
  }
  const yellow = cellColors({ fg: "#d7af5f", bg: "", reverse: false }, "light").foreground
  const rgb = yellow.match(/[0-9a-f]{2}/gi).map((hex) => Number.parseInt(hex, 16))
  assert.ok(rgb[0] > rgb[1] && rgb[1] > rgb[2], "yellow stays yellow after contrast adjustment")
})

test("readable RGB accents and explicit coloured pairs retain their original colours", () => {
  assert.equal(cellColors({ fg: "#0c2238", bg: "", reverse: false }, "light").foreground, "#0c2238")
  assert.deepEqual(cellColors({ fg: "#d77757", bg: "#000000", reverse: false }, "light"), {
    foreground: "#d77757",
    background: "#000000",
  })
  assert.deepEqual(cellColors({ fg: "#ffffff", bg: "#ab2b3f", reverse: false }, "light"), {
    foreground: "#ffffff",
    background: "#ab2b3f",
  })
})
