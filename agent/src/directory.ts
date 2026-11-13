import { constants } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/** Resolve and validate on the desktop before herdr can silently fall back. */
export async function tabDirectory(value: unknown): Promise<string> {
  const requested = value == null || value === "" ? "~" : value
  if (typeof requested !== "string") throw new Error("Working directory must be a path on the desktop.")
  const cwd =
    requested === "~" ? homedir() : requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested
  if (!isAbsolute(cwd)) throw new Error("Working directory must be an absolute path or ~ on the desktop.")
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory")
    await access(cwd, constants.R_OK | constants.X_OK)
    return await realpath(cwd)
  } catch {
    throw new Error(`Working directory is not accessible on the desktop: ${requested}`)
  }
}
