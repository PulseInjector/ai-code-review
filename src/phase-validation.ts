import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { parseDiscoveryOutput, parseVerificationOutput, splitLines, type Candidate, type CodeReference, type Verification } from "./contracts"
import type { PhaseValidation } from "./runtime/contracts"

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

export async function validateReferences(references: readonly CodeReference[], readSource: (reference: CodeReference) => Promise<string>): Promise<void> {
  for (const reference of references) {
    const lines = splitLines(await readSource(reference))
    if (reference.endLine > lines.length) throw new Error(`citation line range is outside ${reference.path}`)
    if (lines.slice(reference.startLine - 1, reference.endLine).join("\n").trim() !== reference.excerpt.trim()) {
      throw new Error(`citation excerpt does not match ${reference.path}:${reference.startLine}-${reference.endLine}`)
    }
  }
}

function materialReader(validation: PhaseValidation, materialDirectory: string): (reference: CodeReference) => Promise<string> {
  return async (reference) => {
    if (!validation.includedFiles.some((file) => file.side === reference.side && file.path === reference.path)) {
      throw new Error(`citation is not present in the prepared ${reference.side} snapshot: ${reference.path}`)
    }
    const root = resolve(materialDirectory)
    const path = resolve(root, reference.side, reference.path)
    if (!within(root, path)) throw new Error(`citation path escapes the prepared snapshot: ${reference.path}`)
    return readFile(path, "utf8")
  }
}

export async function validateDiscoveryText(text: string, validation: PhaseValidation, materialDirectory: string): Promise<Candidate[]> {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error("discovery output is not valid JSON") }
  const candidates = parseDiscoveryOutput(raw).candidates
  for (const candidate of candidates) {
    if (!validation.changedHeadPaths.includes(candidate.changeLocation.path)) {
      throw new Error(`candidate change location is not an included changed head file: ${candidate.changeLocation.path}`)
    }
    await validateReferences([candidate.changeLocation, ...candidate.citations], materialReader(validation, materialDirectory))
  }
  return candidates
}

export async function validateVerificationText(text: string, candidates: Candidate[], validation: PhaseValidation, materialDirectory: string): Promise<Verification[]> {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error("verification output is not valid JSON") }
  const verifications = parseVerificationOutput(raw).verifications
  const expected = new Set(candidates.map(({ id }) => id))
  const actual = new Set(verifications.map(({ candidateId }) => candidateId))
  const missing = [...expected].filter((id) => !actual.has(id))
  const unexpected = [...actual].filter((id) => !expected.has(id))
  if (missing.length || unexpected.length) {
    const details = [missing.length ? `missing ${missing.join(", ")}` : "", unexpected.length ? `unexpected ${unexpected.join(", ")}` : ""].filter(Boolean).join("; ")
    throw new Error(`verification candidate IDs do not match discovery output (${details})`)
  }
  await validateReferences(verifications.flatMap((verification) => verification.evidence), materialReader(validation, materialDirectory))
  return verifications
}
