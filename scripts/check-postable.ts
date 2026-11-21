// Checks a draft issue or PR description before it posts. Template conformance and the
// project's writing rules, as mechanical checks. Exit 0 means postable, exit 1 prints every
// finding with its rule.
//
// Usage:
//   bun run scripts/check-postable.ts <draft.md> --kind bug|feature|improvement|pr [--title "<title>"]

import { readFile } from "node:fs/promises"

type Kind = "bug" | "feature" | "improvement" | "pr"

const ISSUE_KINDS: Record<Exclude<Kind, "pr">, { titlePrefix: string; sections: string[] }> = {
	bug: {
		titlePrefix: "[BUG] ",
		sections: ["Summary", "Expected vs actual behavior", "Steps to reproduce", "Can you reproduce it consistently?", "Operating system"],
	},
	feature: {
		titlePrefix: "[FEATURE] ",
		sections: ["Problem", "Proposed solution"],
	},
	improvement: {
		titlePrefix: "[IMPROVEMENT] ",
		sections: ["Current state", "Desired state"],
	},
}

const PR_SECTIONS = ["Why", "What Changed", "Verification"]

const BANNED_WORDS = [
	"additionally", "crucial", "delve", "enduring", "enhance", "fostering", "garner",
	"interplay", "intricate", "pivotal", "showcase", "tapestry", "testament", "underscore",
	"vibrant", "utilize", "leverage", "facilitate", "numerous", "in order to",
	"due to the fact that", "it is important to note that", "i hope this helps", "let me know if",
] as const

const META_COMMENTARY = [
	/records (only )?observed behavior/i,
	/no judgment attached/i,
	/no fix direction/i,
	/no design proposal/i,
	/design work happens in a separate/i,
	/this (issue|document|report) records/i,
] as const

const LOCAL_PATHS = [/\/Users\//u, /(^|\s)~\//u, /\.audit\//u, /\/var\/folders\//u, /\/private\/tmp\//u, /(^|\s)\/tmp\//u] as const

const SECRET_SHAPES = [/sk-[A-Za-z0-9_-]{20,}/u, /gh[oprs]_[A-Za-z0-9]{20,}/u, /github_pat_[A-Za-z0-9_]{20,}/u] as const

const findings: { rule: string; line: number; detail: string }[] = []
const report = (rule: string, line: number, detail: string): void => {
	findings.push({ rule, line, detail })
}

function parseArguments(argv: string[]): { file: string; kind: Kind; title: string | null } {
	const [file, ...rest] = argv
	if (file === undefined) throw new Error("usage: check-postable.ts <draft.md> --kind <bug|feature|improvement|pr> [--title <title>]")
	let kind: Kind | null = null
	let title: string | null = null
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index]
		const value = rest[index + 1]
		if (flag === "--kind" && value !== undefined) {
			kind = value as Kind
			index += 1
		} else if (flag === "--title") {
			title = value ?? null
			index += 1
		} else throw new Error(`unknown argument: ${flag ?? "missing value"}`)
	}
	if (kind === null || !["bug", "feature", "improvement", "pr"].includes(kind)) {
		throw new Error("--kind must be one of bug, feature, improvement, pr")
	}
	return { file, kind, title }
}

const { file, kind, title } = parseArguments(process.argv.slice(2))
const body = await readFile(file, "utf8")
const lines = body.split("\n")

// Template conformance: every required heading exists at its template level and has content
// under it, not another heading or a leftover template comment.
const requiredHeadings = kind === "pr" ? PR_SECTIONS : ISSUE_KINDS[kind].sections
const headingLevel = kind === "pr" ? "##" : "###"
for (const heading of requiredHeadings) {
	const index = lines.findIndex((line) => line.trim() === `${headingLevel} ${heading}`)
	if (index === -1) {
		report("template", 0, `missing required section "${headingLevel} ${heading}" for kind ${kind}`)
		continue
	}
	const next = lines.slice(index + 1).find((line) => line.trim() !== "")
	if (next === undefined || next.trim().startsWith("#") || next.trim().startsWith("<!--")) {
		report("template", index + 1, `section "${heading}" has no content`)
	}
}

if (kind !== "pr") {
	const expectedPrefix = ISSUE_KINDS[kind].titlePrefix
	if (title !== null && !title.startsWith(expectedPrefix)) {
		report("template", 0, `title must start with ${JSON.stringify(expectedPrefix)} for kind ${kind}`)
	}
}

for (const [index, line] of lines.entries()) {
	const position = index + 1
	if (/[—–]/u.test(line)) report("no-dashes", position, "em or en dash, use a period or comma")
	if (/[“”‘’]/u.test(line)) report("straight-quotes", position, "curly quote, use straight quotes")
	const lower = line.toLowerCase()
	for (const word of BANNED_WORDS) {
		if (lower.includes(word)) report("plain-words", position, `banned phrase "${word}"`)
	}
	for (const pattern of META_COMMENTARY) {
		if (pattern.test(line)) report("no-meta-commentary", position, "narrates the writing instead of the subject, delete it")
	}
	for (const pattern of LOCAL_PATHS) {
		if (pattern.test(line)) report("no-local-paths", position, "machine-local path, the reader cannot resolve it, use an in-repo pointer")
	}
	for (const pattern of SECRET_SHAPES) {
		if (pattern.test(line)) report("no-secrets", position, "token-shaped value, replace with *** before posting")
	}
	if (/^\*\*[^*]+\*\*:/.test(line.trim()) && !line.trim().startsWith("**Rule")) {
		report("no-bold-label-lists", position, "bold label with a colon, write the item as a sentence")
	}
	for (const character of line) {
		const code = character.codePointAt(0) ?? 0
		if ((code >= 0x1f300 && code <= 0x1faff) || (code >= 0x2600 && code <= 0x27bf)) {
			report("no-emoji", position, "decorative emoji")
			break
		}
	}
}

if (findings.length > 0) {
	process.stderr.write(`check-postable found ${findings.length} finding(s) in ${file}, kind ${kind}\n`)
	for (const finding of findings) {
		process.stderr.write(`  line ${String(finding.line).padStart(4)}  ${finding.rule.padEnd(20)}  ${finding.detail}\n`)
	}
	process.exit(1)
}
process.stdout.write(`check-postable passed for ${file}, kind ${kind}\n`)
