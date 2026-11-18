import { lstat, readdir, realpath } from "node:fs/promises"
import { userInfo } from "node:os"
import { basename, dirname, join } from "node:path"
import { isWithin } from "./context-limits"

const unsafeNames = new Set(["agents.md", ".opencode", ".agents", ".claude", ".git", "node_modules", ".env", "opencode.json", "opencode.jsonc"])

export function systemConfigurationPaths(platform: NodeJS.Platform, username: string): string[] {
  if (platform === "linux") return ["/etc/opencode"]
  if (platform === "darwin") return [
    "/Library/Application Support/opencode",
    join("/Library/Managed Preferences", username, "ai.opencode.managed.plist"),
    "/Library/Managed Preferences/ai.opencode.managed.plist",
  ]
  throw new Error("controlled runtime currently supports macOS and Linux")
}

export async function assertCleanSystemConfig(paths = systemConfigurationPaths(process.platform, userInfo().username)): Promise<void> {
  for (const path of paths) {
    let info
    try { info = await lstat(path) } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw new Error("cannot inspect system OpenCode configuration; use a clean runtime environment")
    }
    if (info.isDirectory() && (await readdir(path)).length === 0) continue
    throw new Error(`system OpenCode configuration detected; use a clean runtime environment: ${path}`)
  }
}

export async function validateMaterialDirectory(directory: string): Promise<string> {
  const root = await realpath(directory)
  async function walk(path: string): Promise<void> {
    const info = await lstat(path)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("runtime material must contain only regular files and directories")
    if (path !== root) {
      const name = basename(path).toLowerCase()
      if (unsafeNames.has(name) || name.startsWith(".env.")) throw new Error(`runtime material contains automatically loaded configuration: ${name}`)
    }
    if (info.isDirectory()) for (const entry of await readdir(path)) await walk(join(path, entry))
  }
  await walk(root)
  // The read tool may load nearby instructions even when project configuration is disabled.
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    for (const name of ["AGENTS.md", "agents.md"]) {
      try {
        await lstat(join(parent, name))
        throw new Error("runtime material must have no ancestor AGENTS.md; use a clean snapshot location")
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
        throw error
      }
    }
    if (dirname(parent) === parent) break
  }
  return root
}

export function assertSeparateDirectories(material: string, runtime: string): void {
  if (isWithin(material, runtime)) throw new Error("runtime configuration and results must be outside the searchable material directory")
}
