import { PiHistoryBuffer, piHistoryKey } from "./pi-history.js"

interface PiScreen {
  text: string
  vt?: boolean
  rows?: number
  cols?: number
}

interface PiHistoryRequest {
  read: () => Promise<PiScreen | null>
  send: (text: string) => Promise<string | null>
  current: () => boolean
  connected: () => boolean
  limit?: number
}

/** Read application history without replacing the document with each TUI page. */
export async function loadPiHistory(request: PiHistoryRequest): Promise<{
  buffer: PiHistoryBuffer
  latest: PiScreen
} | null> {
  const send = async (text: string): Promise<void> => {
    const error = await request.send(text)
    if (error !== null) throw new Error(error)
  }
  const screen = async (previous: string | null, valid = request.current): Promise<PiScreen | null> => {
    const deadline = Date.now() + 750
    let candidate: PiScreen | null = null
    let candidateKey: string | null = null
    do {
      await new Promise((resolve) => setTimeout(resolve, 75))
      if (!valid()) return null
      const read = await request.read()
      if (!valid()) return null
      if (read === null) throw new Error("the desktop did not return its screen")
      const key = piHistoryKey(read.text)
      if (read.vt || key === null) return null
      if (previous === null || key !== previous) {
        if (candidate !== null && key === candidateKey) return read
        candidate = read
        candidateKey = key
      }
    } while (Date.now() < deadline)
    return candidate
  }

  let navigated = false
  let frontier: string | null = null
  let result: { buffer: PiHistoryBuffer; latest: PiScreen } | null = null
  try {
    if (!request.current()) return null
    // Ctrl+End is pi's own return-to-latest action, not a prompt or command.
    const initial = await request.read()
    if (!request.current() || initial === null || initial.vt || piHistoryKey(initial.text) === null) return null
    navigated = true
    await send("\x1b[1;5F")
    const restored = await screen(piHistoryKey(initial.text))
    if (!request.current()) return null
    const latest = restored ?? (await request.read())
    if (!request.current() || latest === null || latest.vt) return null
    const buffer = new PiHistoryBuffer(latest.text, request.limit ?? 1000)
    if (!buffer.supported) return null
    let key = piHistoryKey(latest.text)
    frontier = key
    while (!buffer.full && request.current()) {
      await send("\x1b[5~")
      const older = await screen(key)
      if (older === null || !buffer.prepend(older.text)) break
      key = piHistoryKey(older.text)
      frontier = key
    }
    if (request.current()) result = { buffer, latest }
  } finally {
    // The Web document owns history scrolling; leave the actual pi live.
    if (navigated && request.connected()) {
      await send("\x1b[1;5F")
      const live = await screen(frontier, request.connected)
      if (result !== null && live !== null) {
        result.latest = live
        result.buffer.updateLatest(live.text)
      }
    }
  }
  return result
}
