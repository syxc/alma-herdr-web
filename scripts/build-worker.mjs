import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, "web")
const output = join(root, "dist", "worker")

// This directory contains only rebuildable public assets, never the Node agent.
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
for (const file of ["index.html", "style.css"]) {
  await writeFile(join(output, file), await readFile(join(source, file)))
}

async function copyAssets(directory) {
  for (const entry of await readdir(join(source, directory), { withFileTypes: true })) {
    const relative = join(directory, entry.name)
    if (entry.isDirectory()) {
      await copyAssets(relative)
    } else if (
      entry.isFile() &&
      entry.name !== "symbols-nerd-font-mono.woff2" &&
      (/\.(js|wasm|woff2|css)$/.test(entry.name) || entry.name === "LICENSE")
    ) {
      // Public scripts do not point at source maps that are excluded from the upload.
      const data = entry.name.endsWith(".js")
        ? (await readFile(join(source, relative), "utf8")).replace(/^\/\/# sourceMappingURL=.*$/gm, "")
        : await readFile(join(source, relative))
      await mkdir(dirname(join(output, relative)), { recursive: true })
      await writeFile(join(output, relative), data)
    }
  }
}

await copyAssets("dist")
await copyAssets("vendor")
console.log("Workers static assets are ready in dist/worker")
