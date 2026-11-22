import { z } from "zod"

export const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/).brand<"GitSha">()
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/).brand<"Sha256">()
export const repositoryIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).brand<"RepositoryId">()
export const runIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).brand<"WorkflowRunId">()
export const attemptSchema = z.int().positive().max(1_000_000).brand<"RunAttempt">()
export const prNumberSchema = z.int().positive().max(2_147_483_647).brand<"PullRequestNumber">()
export const commentIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).brand<"CommentId">()
export const instantSchema = z.iso.datetime({ offset: true })
export const repositoryNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)

export type GitSha = z.infer<typeof gitShaSchema>
export type Sha256 = z.infer<typeof digestSchema>
export type RepositoryId = z.infer<typeof repositoryIdSchema>
export type WorkflowRunId = z.infer<typeof runIdSchema>
export type RunAttempt = z.infer<typeof attemptSchema>
export type PullRequestNumber = z.infer<typeof prNumberSchema>
export type CommentId = z.infer<typeof commentIdSchema>
export type Instant = z.infer<typeof instantSchema>
export type RepositoryName = z.infer<typeof repositoryNameSchema>

export const canonicalPrInputSchema = z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(prNumberSchema)
