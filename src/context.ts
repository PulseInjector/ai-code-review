import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { parseSnapshot, relativePathSchema, type Snapshot } from "./contracts"

const limitsSchema = z.strictObject({
  maxChangedFiles: z.int().nonnegative(),
  maxPatchBytes: z.int().nonnegative(),
  maxSnapshotBytes: z.int().nonnegative(),
})

export type ReviewLimits = z.infer<typeof limitsSchema>
export type ReviewInput = { repo: string; base: string; head: string; out: string }
export type OmissionReason = "unsafe-path" | "excluded-path" | "non-text" | "non-regular" | "changed-file-limit" | "patch-limit" | "snapshot-limit"
export type FileEntry = {
  side: "merge-base" | "head"
  path: string
  mode: string
  oid: string
  bytes: number
  included: boolean
  reason?: OmissionReason
}
export type ChangeEntry = {
  status: string
  oldPath?: string
  newPath?: string
  included: boolean
  patch?: string
  reason?: OmissionReason
}
export type ContextManifest = {
  snapshot: Snapshot
  status: "complete" | "partial"
  limits: ReviewLimits
  files: FileEntry[]
  changes: ChangeEntry[]
  coverage: { includedPaths: string[]; omittedPaths: string[] }
  instructions?: { sourceSha: string; path: string; text: string }
}

type TreeFile = { mode: string; oid: string; bytes: number }
type Tree = Map<string, TreeFile>
type GitChange = { status: string; oldPath?: string; newPath?: string }

const decoder = new TextDecoder("utf-8", { fatal: true })
const pathSegment = (path: string) => path.split("/")
const comparePath = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const configPath = fileURLToPath(new URL("../review.config.json", import.meta.url))

function git(repo: string, args: string[]): Uint8Array {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    const message = new TextDecoder().decode(result.stderr).trim()
    throw new Error(`git ${args[0]} failed: ${message || `exit ${result.exitCode}`}`)
  }
  return result.stdout
}

function gitText(repo: string, args: string[]): string {
  return decoder.decode(git(repo, args)).trim()
}

function resolveCommit(repo: string, ref: string): string {
  if (!ref || ref.startsWith("-")) throw new Error("base and head must be Git revisions")
  return gitText(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
}

function nulFields(bytes: Uint8Array): string[] {
  const fields = decoder.decode(bytes).split("\0")
  if (fields.pop() !== "") throw new Error("invalid NUL-terminated Git output")
  return fields
}

function tree(repo: string, sha: string): Tree {
  const result: Tree = new Map()
  for (const row of nulFields(git(repo, ["ls-tree", "-r", "-l", "-z", "--full-tree", sha]))) {
    const tab = row.indexOf("\t")
    const match = /^(\d{6}) +(blob|commit) +([0-9a-f]{40,64}) +(\d+|-)$/u.exec(row.slice(0, tab))
    if (tab < 0 || !match) throw new Error("invalid Git tree entry")
    result.set(row.slice(tab + 1), { mode: match[1]!, oid: match[3]!, bytes: match[4] === "-" ? 0 : Number(match[4]) })
  }
  return result
}

function changes(repo: string, from: string, to: string): GitChange[] {
  const fields = nulFields(git(repo, ["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", from, to]))
  const result: GitChange[] = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!
    if (/^[RC]\d+$/u.test(status)) {
      result.push({ status, oldPath: fields[i++]!, newPath: fields[i++]! })
    } else if (status === "D") {
      result.push({ status, oldPath: fields[i++]! })
    } else if (/^[AMT]$/u.test(status)) {
      result.push({ status, newPath: fields[i++]! })
    } else {
      throw new Error(`unsupported Git change status: ${status}`)
    }
  }
  return result
}

function pathReason(path: string): OmissionReason | undefined {
  if (!relativePathSchema.safeParse(path).success || pathSegment(path).some((segment) => segment === ".git")) return "unsafe-path"
  const segments = pathSegment(path)
  if (segments.some((segment) => [".opencode", ".agents", ".claude", "node_modules", "runs"].includes(segment))) return "excluded-path"
  const name = basename(path).toLowerCase()
  if (name === "agents.md" || name === "review.md" || name === ".env" || name.startsWith(".env.") ||
    /(?:^|[._-])(secret|secrets|credential|credentials|token|private)(?:[._-]|$)/u.test(name) ||
    /\.(?:pem|key|p12|pfx|keystore|jks)$/u.test(name) || name === "id_rsa" || name === "id_ed25519") return "excluded-path"
  return undefined
}

function textBlob(repo: string, file: TreeFile): string | undefined {
  if (file.mode !== "100644" && file.mode !== "100755") return undefined
  const bytes = git(repo, ["cat-file", "blob", file.oid])
  if (bytes.includes(0)) return undefined
  try {
    const content = decoder.decode(bytes)
    return /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(content) ? undefined : content
  } catch { return undefined }
}

function patchText(repo: string, from: string, to: string, change: GitChange): string {
  const paths = [change.oldPath, change.newPath].filter((path): path is string => path !== undefined)
  const literalPaths = paths.map((path) => `:(literal)${path}`)
  return decoder.decode(git(repo, ["diff", "-M", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", from, to, "--", ...literalPaths]))
}

export async function loadReviewLimits(): Promise<ReviewLimits> {
  return limitsSchema.parse(JSON.parse(await readFile(configPath, "utf-8")))
}

export async function prepareContext(input: ReviewInput, requestedLimits?: ReviewLimits): Promise<ContextManifest> {
  const limits = limitsSchema.parse(requestedLimits ?? await loadReviewLimits())
  const repo = await realpath(input.repo)
  if (!(await stat(repo)).isDirectory()) throw new Error("repo must be a directory")
  const requestedOut = resolve(input.out)
  const out = join(await realpath(dirname(requestedOut)), basename(requestedOut))
  if (out === repo || out.startsWith(`${repo}${sep}`)) throw new Error("out must be outside the repository")
  if (await lstat(out).then(() => true, () => false)) throw new Error("out must be a new directory")
  const baseSha = resolveCommit(repo, input.base)
  const headSha = resolveCommit(repo, input.head)
  const mergeBaseSha = gitText(repo, ["merge-base", baseSha, headSha])
  const snapshot = parseSnapshot({ baseSha, headSha, mergeBaseSha })
  const baseTree = tree(repo, mergeBaseSha)
  const inputBaseTree = baseSha === mergeBaseSha ? baseTree : tree(repo, baseSha)
  const headTree = tree(repo, headSha)
  const changed = changes(repo, mergeBaseSha, headSha)
  const files: FileEntry[] = []
  const fileEntries = new Map<string, FileEntry>()
  for (const [side, source] of [["merge-base", baseTree], ["head", headTree]] as const) {
    for (const [path, blob] of source) {
      const entry: FileEntry = { side, path, mode: blob.mode, oid: blob.oid, bytes: blob.bytes, included: false }
      files.push(entry)
      fileEntries.set(`${side}\0${path}`, entry)
    }
  }
  files.sort((a, b) => comparePath(a.path, b.path) || comparePath(a.side, b.side))

  const staging = await mkdtemp(join(dirname(out), ".review-material-"))
  let committed = false
  try {
    const material = join(staging, "material")
    await mkdir(join(material, "merge-base"), { recursive: true })
    await mkdir(join(material, "head"), { recursive: true })
    await mkdir(join(material, "patches"), { recursive: true })
    let snapshotBytes = 0
    let patchBytes = 0
    let changedFiles = 0
    const included = new Set<string>()
    const omitted = new Set<string>()
    const written = new Set<string>()

    async function addFile(side: "merge-base" | "head", path: string, content: string): Promise<void> {
      const relative = `${side}/${path}`
      if (written.has(relative)) return
      const target = join(material, relative)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, { flag: "wx", mode: 0o444 })
      await chmod(target, 0o444)
      written.add(relative)
      fileEntries.get(`${side}\0${path}`)!.included = true
      snapshotBytes += Buffer.byteLength(content)
      included.add(path)
    }

    function assess(side: "merge-base" | "head", path: string): { content?: string; reason?: OmissionReason } {
      const excluded = pathReason(path)
      if (excluded) return { reason: excluded }
      const blob = (side === "merge-base" ? baseTree : headTree).get(path)!
      if (blob.mode !== "100644" && blob.mode !== "100755") return { reason: "non-regular" }
      if (blob.bytes > limits.maxSnapshotBytes) return { reason: "snapshot-limit" }
      const content = textBlob(repo, blob)
      if (content === undefined) return { reason: "non-text" }
      return { content }
    }

    const manifestChanges: ChangeEntry[] = []
    const changedPaths = new Set(changed.flatMap(({ oldPath, newPath }) => [oldPath, newPath].filter((path): path is string => !!path)))
    for (const [index, change] of changed.entries()) {
      const entry: ChangeEntry = { ...change, included: false }
      manifestChanges.push(entry)
      const sides = [
        ...(change.oldPath ? [{ side: "merge-base" as const, path: change.oldPath }] :
          change.status !== "A" && change.newPath ? [{ side: "merge-base" as const, path: change.newPath }] : []),
        ...(change.newPath ? [{ side: "head" as const, path: change.newPath }] : []),
      ].filter(({ side, path }) => fileEntries.has(`${side}\0${path}`))
      const assessed = sides.map(({ side, path }) => ({ side, path, ...assess(side, path) }))
      const reason = assessed.find((item) => item.reason)?.reason
      if (reason || changedFiles >= limits.maxChangedFiles) {
        entry.reason = reason ?? "changed-file-limit"
      } else {
        const patch = patchText(repo, mergeBaseSha, headSha, change)
        const bytes = Buffer.byteLength(patch)
        const additional = assessed.filter(({ side, path }) => !written.has(`${side}/${path}`))
          .reduce((total, item) => total + Buffer.byteLength(item.content!), 0)
        if (patchBytes + bytes > limits.maxPatchBytes) entry.reason = "patch-limit"
        else if (snapshotBytes + additional > limits.maxSnapshotBytes) entry.reason = "snapshot-limit"
        else {
          const patchName = `${String(index + 1).padStart(4, "0")}.patch`
          await writeFile(join(material, "patches", patchName), patch, { flag: "wx", mode: 0o444 })
          await chmod(join(material, "patches", patchName), 0o444)
          for (const item of assessed) await addFile(item.side, item.path, item.content!)
          entry.included = true
          entry.patch = `material/patches/${patchName}`
          patchBytes += bytes
          changedFiles++
        }
      }
      if (!entry.included) for (const item of assessed) {
        const file = fileEntries.get(`${item.side}\0${item.path}`)!
        file.reason = entry.reason
        omitted.add(item.path)
      }
    }

    const directories = new Set([...changedPaths].map((path) => dirname(path)))
    const supportingPaths = [...new Set([...baseTree.keys(), ...headTree.keys()])]
      .filter((path) => !changedPaths.has(path))
      .sort((a, b) => Number(directories.has(dirname(b))) - Number(directories.has(dirname(a))) || comparePath(a, b))
    for (const path of supportingPaths) {
      const assessed = (["merge-base", "head"] as const)
        .filter((side) => fileEntries.has(`${side}\0${path}`))
        .map((side) => ({ side, path, ...assess(side, path) }))
      const reason = assessed.find((item) => item.reason)?.reason
      if (reason) {
        for (const item of assessed) fileEntries.get(`${item.side}\0${path}`)!.reason = reason
        continue
      }
      const additional = assessed.reduce((total, item) => total + Buffer.byteLength(item.content!), 0)
      if (snapshotBytes + additional > limits.maxSnapshotBytes) {
        for (const item of assessed) fileEntries.get(`${item.side}\0${path}`)!.reason = "snapshot-limit"
        omitted.add(path)
        continue
      }
      for (const item of assessed) await addFile(item.side, path, item.content!)
    }

    let instructions: ContextManifest["instructions"]
    const reviewFile = inputBaseTree.get("REVIEW.md")
    if (reviewFile) {
      if (reviewFile.mode === "100644" && reviewFile.bytes <= 16 * 1024) {
        const text = textBlob(repo, reviewFile)
        if (text !== undefined) instructions = { sourceSha: baseSha, path: "REVIEW.md", text }
      }
      if (!instructions) omitted.add("REVIEW.md")
    }
    const manifest: ContextManifest = {
      snapshot,
      status: omitted.size ? "partial" : "complete",
      limits,
      files,
      changes: manifestChanges,
      coverage: { includedPaths: [...included].sort(comparePath), omittedPaths: [...omitted].sort(comparePath) },
      ...(instructions ? { instructions } : {}),
    }
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" })
    await rename(staging, out)
    committed = true
    return manifest
  } finally {
    if (!committed) await rm(staging, { recursive: true, force: true })
  }
}
