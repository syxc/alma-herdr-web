import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, extname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const web = resolve(root, "web")
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
}
let failed = false
createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname
  const fixture =
    pathname === "/" ? "icon-font-browser.html" : pathname === "/terminal" ? "terminal-browser.html" : null
  const path = fixture === null ? resolve(web, `.${pathname}`) : resolve(root, "tests", fixture)
  if (fixture === null && !path.startsWith(web + sep)) {
    response.writeHead(404).end()
    return
  }
  // Exercise recovery from an actual failed request, once per server run.
  if (pathname.endsWith("/symbols-f1a.woff2") && !failed) {
    failed = true
    response.writeHead(503, { "Cache-Control": "no-store" }).end("Temporary font failure")
    return
  }
  try {
    const bytes = await readFile(path)
    response
      .writeHead(200, {
        "Content-Type": types[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-store",
      })
      .end(bytes)
  } catch {
    response.writeHead(404).end()
  }
}).listen(7342, "127.0.0.1", () => {
  console.log("Open http://127.0.0.1:7342/ in a browser. Restart this server before repeating the HTTP failure check.")
})
