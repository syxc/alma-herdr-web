import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { tabDirectory } from "../agent/dist/directory.js"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "herdr-directory-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test("missing directory and ~ resolve to the desktop user home", async () => {
  const home = await realpath(homedir())
  for (const value of [undefined, null, "", "~"]) assert.equal(await tabDirectory(value), home)
})

test("an existing directory is resolved including symlinks in the parent path", async (t) => {
  const root = await fixture(t)
  const directory = join(root, "project with spaces")
  await mkdir(directory)
  assert.equal(await tabDirectory(directory), await realpath(directory))
})

test("missing directories and files are refused instead of using home", async (t) => {
  const root = await fixture(t)
  const file = join(root, "file")
  await writeFile(file, "fixture")
  for (const value of [join(root, "missing"), file]) {
    await assert.rejects(tabDirectory(value), /Working directory is not accessible on the desktop/)
  }
})

test("inaccessible directories are refused", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("requires Unix permissions without root")
  const root = await fixture(t)
  const directory = join(root, "denied")
  await mkdir(directory)
  await chmod(directory, 0)
  try {
    await assert.rejects(tabDirectory(directory), /Working directory is not accessible on the desktop/)
  } finally {
    await chmod(directory, 0o700)
  }
})

test("relative paths and malformed directory values are refused", async () => {
  await assert.rejects(tabDirectory("relative/project"), /absolute path or ~/)
  await assert.rejects(tabDirectory({ cwd: "~" }), /must be a path/)
})
