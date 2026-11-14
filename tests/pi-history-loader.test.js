import assert from "node:assert/strict"
import { test } from "node:test"
import { piHistoryKey } from "../web/dist/pi-history.js"
import { loadPiHistory } from "../web/dist/pi-history-loader.js"

const end = "\x1b[1;5F"
const up = "\x1b[5~"
const page = (body) => ({ text: `${body}\n────────\n❯\n────────\nsynthetic status`, rows: 5 })

function desktop(options = {}) {
  const latest = page("latest one\nlatest two")
  const older = page("older one\nolder two")
  let current = true
  let live = latest
  const sent = []
  return {
    sent,
    latest,
    get live() {
      return live
    },
    request: {
      current: () => current,
      connected: () => true,
      read: async () => {
        if (options.fail && live === older) throw new Error("read failed")
        return live
      },
      send: async (text) => {
        sent.push(text)
        live = text === end ? latest : older
        if (options.cancel && text === up) current = false
        return null
      },
    },
  }
}

test("preloaded pi pages form one document and leave the desktop live", async () => {
  const app = desktop()
  const result = await loadPiHistory(app.request)
  assert.deepEqual(JSON.parse(piHistoryKey(result.buffer.text)), ["older one", "older two", "latest one", "latest two"])
  assert.equal(app.live, app.latest)
  assert.equal(result.latest, app.latest)
  assert.equal(app.sent.at(-1), end)
})

test("cancelling history still waits for the desktop to return live", async () => {
  const app = desktop({ cancel: true })
  let restorationReads = 0
  const read = app.request.read
  app.request.read = async () => {
    if (app.sent.at(-1) === end && app.sent.includes(up)) restorationReads++
    return read()
  }
  assert.equal(await loadPiHistory(app.request), null)
  assert.equal(app.live, app.latest)
  assert.ok(restorationReads >= 2, "cancelled views must await stable live restoration before queued input")
})

test("a failed history read restores live before propagating the error", async () => {
  const app = desktop({ fail: true })
  await assert.rejects(loadPiHistory(app.request), /read failed/)
  assert.equal(app.live, app.latest)
  assert.equal(app.sent.at(-1), end)
})

test("cancellation during the initial read never navigates the old pane", async () => {
  const initial = Promise.withResolvers()
  let current = true
  const sent = []
  const loading = loadPiHistory({
    current: () => current,
    connected: () => current,
    read: () => initial.promise,
    send: async (text) => {
      sent.push(text)
      return null
    },
  })
  current = false
  initial.resolve(page("cancelled pane"))
  assert.equal(await loading, null)
  assert.deepEqual(sent, [])
})

test("disconnecting during a screen read skips fallback reads and further navigation", async () => {
  const reading = Promise.withResolvers()
  const painted = Promise.withResolvers()
  let current = true
  let reads = 0
  const sent = []
  const loading = loadPiHistory({
    current: () => current,
    connected: () => current,
    read: async () => {
      if (++reads === 1) return page("initial")
      reading.resolve()
      return painted.promise
    },
    send: async (text) => {
      sent.push(text)
      return null
    },
  })
  await reading.promise
  current = false
  painted.resolve(page("obsolete"))
  assert.equal(await loading, null)
  assert.equal(reads, 2, "the disconnected request cannot fall back to another read")
  assert.deepEqual(sent, [end])
})

test("a native VT repaint after returning live cannot start pi paging", async () => {
  const app = desktop()
  app.request.read = async () => (app.sent.length === 0 ? app.latest : { ...app.latest, vt: true })
  assert.equal(await loadPiHistory(app.request), null)
  assert.ok(!app.sent.includes(up), "a changed screen mode cannot receive pi PageUp")
})

test("unrecognized and native VT screens never receive pi navigation", async () => {
  for (const initial of [{ text: "ordinary shell" }, { ...page("native"), vt: true }]) {
    const app = desktop()
    app.request.read = async () => initial
    assert.equal(await loadPiHistory(app.request), null)
    assert.deepEqual(app.sent, [])
  }
})
