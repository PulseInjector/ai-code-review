// Type-only module for the shared progress contract. Checkpoint 4 adds the sanitized Actions
// logging and the job-summary writer behind these types; the shapes are fixed by the design so
// review orchestration can emit through them now.
export type ProgressEvent = {
  runId: string
  sequence: number
  at: string
  phase: "capture" | "preparation" | "initialization" | "discovery" | "verification" | "cleanup" | "handoff" | "publish"
  event: "start" | "progress" | "end" | "failure"
  changedFilesIncluded: number | null
  changedFilesTotal: number | null
  candidatesDiscovered: number | null
  candidatesVerified: number | null
  remainingMs: number
  runUrl: string | null
}

export type ProgressSink = (event: ProgressEvent) => void
