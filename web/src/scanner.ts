/**
 * Camera scanning of the pairing code.
 *
 * The phone opens this page and scans the QR code the desktop shows. Chrome
 * reads QR codes natively through BarcodeDetector; Safari has no such API,
 * so a vendored jsQR decodes the frames there.
 */

interface DetectedBarcode {
  rawValue: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
}

interface JsQrResult {
  data: string
}

type JsQr = (data: Uint8ClampedArray, width: number, height: number) => JsQrResult | null

/** Reads one QR code out of a camera frame, or null when there is none. */
interface FrameReader {
  read(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): Promise<string | null>
}

const SCAN_INTERVAL_MS = 150
const MAX_FRAME_WIDTH = 640

export interface ScannerHandle {
  stop(): void
}

/**
 * Starts the camera and reports every pairing code it sees.
 */
export async function startScanner(video: HTMLVideoElement, onCode: (code: string) => void): Promise<ScannerHandle> {
  if (navigator.mediaDevices === undefined || navigator.mediaDevices.getUserMedia === undefined) {
    throw new Error("this browser cannot open the camera here; open the page over https or paste the pairing link")
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
  })
  video.srcObject = stream
  video.setAttribute("playsinline", "true")
  await video.play()

  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (context === null) {
    stream.getTracks().forEach((track) => {
      track.stop()
    })
    throw new Error("this browser cannot read camera frames")
  }
  const reader = await createReader(canvas)

  let timer: number | null = null
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) {
      return
    }
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const width = video.videoWidth
      const height = video.videoHeight
      if (width > 0 && height > 0) {
        const scale = Math.min(1, MAX_FRAME_WIDTH / Math.max(width, height))
        canvas.width = Math.round(width * scale)
        canvas.height = Math.round(height * scale)
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const code = await reader.read(canvas, context)
        if (code !== null) {
          stopped = true
          onCode(code)
          return
        }
      }
    }
    timer = window.setTimeout(() => {
      void tick()
    }, SCAN_INTERVAL_MS)
  }
  void tick()

  return {
    stop(): void {
      stopped = true
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      stream.getTracks().forEach((track) => {
        track.stop()
      })
      video.srcObject = null
    },
  }
}

/**
 * Picks the decoder: the native one where it exists, jsQR otherwise.
 */
async function createReader(canvas: HTMLCanvasElement): Promise<FrameReader> {
  const detectorConstructor = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
  if (detectorConstructor !== undefined) {
    const detector = new detectorConstructor({ formats: ["qr_code"] })
    return {
      async read(): Promise<string | null> {
        const codes = await detector.detect(canvas)
        const first = codes[0]
        return first === undefined ? null : first.rawValue
      },
    }
  }
  const jsQr = await loadJsQr()
  return {
    async read(target: HTMLCanvasElement, targetContext: CanvasRenderingContext2D): Promise<string | null> {
      const image = targetContext.getImageData(0, 0, target.width, target.height)
      const result = jsQr(image.data, image.width, image.height)
      return result === null ? null : result.data
    },
  }
}

/**
 * Loads the vendored decoder.
 *
 * The path is relative to this module so it survives the relay prefix, where
 * the page is served from /c/<token>/.
 */
async function loadJsQr(): Promise<JsQr> {
  const url = new URL("../vendor/jsQR.js", import.meta.url).href
  await import(url)
  const decoder = (globalThis as { jsQR?: JsQr }).jsQR
  if (decoder === undefined) {
    throw new Error("the QR decoder is missing from this build")
  }
  return decoder
}
