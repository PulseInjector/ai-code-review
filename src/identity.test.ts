import { expect, test } from "bun:test"
import {
  attemptSchema, commentIdSchema, digestSchema, gitShaSchema, instantSchema,
  prNumberSchema, repositoryIdSchema, repositoryNameSchema, runIdSchema,
  type GitSha, type Sha256,
} from "./identity"

test("gitShaSchema accepts 40 lowercase hex characters only", () => {
  expect(gitShaSchema.parse("a".repeat(40))).toHaveLength(40)
  expect(() => gitShaSchema.parse("A".repeat(40))).toThrow()
  expect(() => gitShaSchema.parse("a".repeat(39))).toThrow()
  expect(() => gitShaSchema.parse("a".repeat(41))).toThrow()
  expect(() => gitShaSchema.parse("main")).toThrow()
})

test("digestSchema accepts 64 lowercase hex characters only", () => {
  expect(digestSchema.parse("0".repeat(64))).toHaveLength(64)
  expect(() => digestSchema.parse("0".repeat(63))).toThrow()
  expect(() => digestSchema.parse("g".repeat(64))).toThrow()
})

test("decimal ID schemas accept canonical positive integers without leading zeros", () => {
  const maximum = "9".repeat(20)
  expect(String(repositoryIdSchema.parse(maximum))).toBe(maximum)
  expect(String(runIdSchema.parse(maximum))).toBe(maximum)
  expect(String(commentIdSchema.parse(maximum))).toBe(maximum)
  expect(() => repositoryIdSchema.parse("0")).toThrow()
  expect(() => runIdSchema.parse("017")).toThrow()
  expect(() => commentIdSchema.parse("1".repeat(21))).toThrow()
  expect(() => repositoryIdSchema.parse("1.0")).toThrow()
  expect(() => commentIdSchema.parse(17)).toThrow()
})

test("attemptSchema and prNumberSchema bound positive integers", () => {
  expect(Number(attemptSchema.parse(1_000_000))).toBe(1_000_000)
  expect(() => attemptSchema.parse(0)).toThrow()
  expect(() => attemptSchema.parse(1_000_001)).toThrow()
  expect(() => attemptSchema.parse(1.5)).toThrow()
  expect(Number(prNumberSchema.parse(2_147_483_647))).toBe(2_147_483_647)
  expect(() => prNumberSchema.parse(2_147_483_648)).toThrow()
  expect(() => prNumberSchema.parse(-1)).toThrow()
})

test("instantSchema accepts offset timestamps and rejects naive ones", () => {
  expect(instantSchema.parse("2026-11-21T10:00:00.000Z")).toBe("2026-11-21T10:00:00.000Z")
  expect(instantSchema.parse("2026-11-21T23:59:59.999999999+14:00")).toHaveLength(35)
  expect(() => instantSchema.parse("2026-11-21T10:00:00")).toThrow()
  expect(() => instantSchema.parse("2026-11-21")).toThrow()
  expect(() => instantSchema.parse("2026-13-21T10:00:00.000Z")).toThrow()
})

test("repositoryNameSchema accepts the longest legal full name and rejects malformed ones", () => {
  const longest = `${"a".repeat(39)}/${"b".repeat(100)}`
  expect(repositoryNameSchema.parse(longest)).toBe(longest)
  expect(repositoryNameSchema.parse("PulseInjector/java-review")).toBe("PulseInjector/java-review")
  expect(() => repositoryNameSchema.parse(`${"a".repeat(40)}/repo`)).toThrow()
  expect(() => repositoryNameSchema.parse("owner/")).toThrow()
  expect(() => repositoryNameSchema.parse("-owner/repo")).toThrow()
  expect(() => repositoryNameSchema.parse("owner")).toThrow()
})

test("branded SHAs and digests do not interchange", () => {
  const sha = gitShaSchema.parse("a".repeat(40))
  const digest = digestSchema.parse("b".repeat(64))
  // @ts-expect-error a GitSha is not a Sha256
  const asDigest: Sha256 = sha
  // @ts-expect-error a Sha256 is not a GitSha
  const asSha: GitSha = digest
  expect(`${asDigest}${asSha}`).toHaveLength(104)
})
