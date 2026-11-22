import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import type { SessionMessageInfo } from "@opencode/client"
import { discoveryOutputSchema, verificationOutputSchema, type Candidate } from "../contracts"
import { validateDiscoveryValue, validateVerificationValue } from "../phase-validation"
import type { OutputSubmissionTrace, PhaseValidation } from "./contracts"

const definitions = {
  discover: { name: "review_submit_discovery", schema: discoveryOutputSchema },
  verify: { name: "review_submit_verification", schema: verificationOutputSchema },
} as const

export type ReviewPhase = { name: "discover" } | { name: "verify"; candidates: Candidate[] }
type Binding = { phase: ReviewPhase; signal: AbortSignal; deadlineEpochMs: number }
type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>

export function reviewOutputTool(name: string): string | undefined {
  return name === "discover" || name === "verify" ? definitions[name].name : undefined
}

export function createReviewOutput(options: { validation: PhaseValidation; materialDirectory: string }) {
  const bindings = new Map<string, Binding & { submitted: boolean }>()
  const plugin = Plugin.define({
    id: "review.structured-output",
    async setup(ctx) {
      const registration = await ctx.tool.transform((editor) => {
        for (const [name, definition] of Object.entries(definitions)) {
          editor.add({
            name: definition.name,
            description: `Submit the final ${name} result. Exact snapshot evidence is validated. If rejected, correct the arguments before submitting again. After acceptance, end your turn.`,
            input: definition.schema,
            options: { codemode: false, permission: definition.name },
            async execute(input, context) {
              const binding = bindings.get(context.sessionID)
              if (!binding || binding.phase.name !== name) throw new Error("result submission does not belong to this review phase")
              const checkActive = () => {
                context.signal.throwIfAborted()
                binding.signal.throwIfAborted()
                if (bindings.get(context.sessionID) !== binding || Date.now() >= binding.deadlineEpochMs) {
                  throw new Error("review result validation exceeded its phase deadline")
                }
              }
              checkActive()
              if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new Error("review output exceeds the phase output limit")
              if (binding.phase.name === "discover") {
                await validateDiscoveryValue(input, options.validation, options.materialDirectory)
              } else {
                await validateVerificationValue(input, binding.phase.candidates, options.validation, options.materialDirectory)
              }
              checkActive()
              binding.submitted = true
              return { content: "Review result accepted. End your turn without another submission.", metadata: { reviewAccepted: true } }
            },
          })
        }
      })
      try {
        const requestHook = await ctx.session.hook("http.request", async (event) => {
          const binding = bindings.get(event.sessionID)
          if (event.kind !== "primary" || !binding) return
          const body = z.looseObject({ tools: z.array(z.unknown()).optional() }).parse(await event.request.clone().json())
          if (!body.tools?.length) return
          const headers = new Headers(event.request.headers)
          headers.delete("content-length")
          event.request = new Request(event.request, {
            headers, body: JSON.stringify({ ...body, tool_choice: binding.submitted ? "none" : "required" }),
          })
        })
        return async () => { await Promise.all([registration.dispose(), requestHook.dispose()]) }
      } catch (error) {
        await registration.dispose()
        throw error
      }
    },
  })
  return {
    plugin,
    bind(sessionID: string, binding: Binding): () => void {
      bindings.set(sessionID, { ...binding, submitted: false })
      return () => { bindings.delete(sessionID) }
    },
  }
}

export function collectReviewOutput(name: ReviewPhase["name"], assistants: Assistant[]) {
  const calls = assistants.flatMap((assistant) => assistant.content.flatMap((part) =>
    part.type === "tool" && Object.values(definitions).some((definition) => definition.name === part.name) ? [part] : []))
  const trace: OutputSubmissionTrace = {
    records: calls.slice(0, 24).map((call) => {
      const state = call.state
      const raw = "input" in state ? JSON.stringify(state.input) : ""
      return {
        callID: call.id.slice(0, 256), tool: call.name.slice(0, 256),
        status: state.status === "completed" && state.metadata?.reviewAccepted === true ? "accepted" : state.status === "error" ? "rejected" : "incomplete",
        rawText: raw.slice(0, 8 * 1024), truncated: raw.length > 8 * 1024,
        ...(state.status === "error" ? { error: state.error.message.slice(0, 2_000) } : {}),
      }
    }),
    omitted: Math.max(0, calls.length - 24),
  }
  const failed = (error: string, rawText?: string) => ({ kind: "failed" as const, error, trace, rawText })
  if (calls.some((call) => call.name !== definitions[name].name)) return failed("result submission does not belong to this review phase")
  const accepted = calls.filter((call) => call.state.status === "completed" && call.state.metadata?.reviewAccepted === true)
  if (accepted.length === 0) {
    const last = calls.at(-1)?.state
    return failed(last?.status === "error" ? last.error.message : "model returned no accepted review result submission",
      last && "input" in last ? JSON.stringify(last.input).slice(0, 256 * 1024) : undefined)
  }
  const outputs = new Set(accepted.map((call) => {
    if (call.state.status !== "completed") throw new Error("accepted result submission must be completed")
    return JSON.stringify(definitions[name].schema.parse(call.state.input))
  }))
  if (outputs.size !== 1) return failed("model submitted conflicting review results")
  const text = outputs.values().next().value
  if (!text || Buffer.byteLength(text) > 256 * 1024) return failed("review output exceeds the phase output limit")
  return { kind: "complete" as const, text, trace }
}
