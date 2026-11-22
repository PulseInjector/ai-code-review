-------------------- MODULE RequestPolicy --------------------
EXTENDS Naturals, TLC

CONSTANTS
  MaxAttempts,
  ExpectedAttemptLimit,
  AdmissionMs,
  InitialRemaining,
  RetryAfterValues,
  RetryDelay2,
  RetryDelay3,
  ExtraFourthDelay,
  RetryDelay4

ASSUME MaxAttempts \in 1..4
ASSUME ExpectedAttemptLimit = 3
ASSUME AdmissionMs = 2
ASSUME InitialRemaining \in 6..10
ASSUME RetryAfterValues = {0, 3}
ASSUME RetryDelay2 = 1
ASSUME RetryDelay3 = 2
ASSUME ExtraFourthDelay \in BOOLEAN
ASSUME RetryDelay4 = 3

Errors == {
  [kind |-> "provider.transport", status |-> 0],
  [kind |-> "provider.timeout", status |-> 0],
  [kind |-> "provider.rate-limit", status |-> 429],
  [kind |-> "provider.quota", status |-> 429],
  [kind |-> "provider.auth", status |-> 401],
  [kind |-> "provider.invalid-request", status |-> 400],
  [kind |-> "provider.content-filter", status |-> 0],
  [kind |-> "provider.internal", status |-> 500],
  [kind |-> "provider.internal", status |-> 404],
  [kind |-> "provider.unknown", status |-> 500],
  [kind |-> "provider.unknown", status |-> 404]
}
RetriableKinds == {"provider.transport", "provider.timeout", "provider.rate-limit"}
NonRetriableKinds == {
  "provider.auth", "provider.quota", "provider.free-limit", "provider.go-limit",
  "provider.budget-limit", "provider.model-budget-limit", "provider.chatgpt-limit",
  "provider.no-route", "provider.content-filter", "provider.invalid-output",
  "provider.invalid-request", "provider.unsupported-operation"
}
RetriableStatuses == {429, 500, 502, 503, 504, 529}
Phases == {"modelCall", "prepared", "inFlight", "retryHook", "done"}
Outcomes == {"none", "success", "failed", "timeout", "retry-exhausted", "retry-refused"}
NoError == [kind |-> "none", status |-> 0]

VARIABLES phase, lastAttempt, wireAttempts, retrying, approvals, remaining,
          pendingError, pendingRetryAfter, lastDelay, outcome
vars == <<phase, lastAttempt, wireAttempts, retrying, approvals, remaining,
          pendingError, pendingRetryAfter, lastDelay, outcome>>

Max(a, b) == IF a >= b THEN a ELSE b
NextAttempt == lastAttempt + 1
IsRetriable(error) ==
  /\ error.kind \notin NonRetriableKinds
  /\ (error.kind \in RetriableKinds \/ error.status \in RetriableStatuses)
DelayFor(attempt, retryAfter) ==
  IF attempt = 2 THEN Max(RetryDelay2, retryAfter)
  ELSE IF attempt = 3 THEN Max(RetryDelay3, retryAfter)
  ELSE IF ExtraFourthDelay THEN Max(RetryDelay4, retryAfter) ELSE 0
HasDelay(attempt) == attempt = 2 \/ attempt = 3 \/ (attempt = 4 /\ ExtraFourthDelay)

Init ==
  /\ phase = "modelCall"
  /\ lastAttempt = 0
  /\ wireAttempts = 0
  /\ retrying = FALSE
  /\ approvals = 0
  /\ remaining = InitialRemaining
  /\ pendingError = NoError
  /\ pendingRetryAfter = 0
  /\ lastDelay = 0
  /\ outcome = "none"

ModelRequest ==
  /\ phase = "modelCall"
  /\ phase' = "prepared"
  /\ IF retrying
       THEN /\ UNCHANGED lastAttempt
            /\ UNCHANGED retrying
       ELSE /\ lastAttempt' = 0
            /\ retrying' = FALSE
  /\ UNCHANGED <<wireAttempts, approvals, remaining, pendingError,
                 pendingRetryAfter, lastDelay, outcome>>

SendRequest ==
  /\ phase = "prepared"
  /\ NextAttempt <= MaxAttempts
  /\ remaining >= AdmissionMs
  /\ (NextAttempt = 1 \/ retrying)
  /\ phase' = "inFlight"
  /\ lastAttempt' = NextAttempt
  /\ wireAttempts' = wireAttempts + 1
  /\ retrying' = FALSE
  /\ pendingError' = NoError
  /\ pendingRetryAfter' = 0
  /\ UNCHANGED <<approvals, remaining, lastDelay, outcome>>

RejectRequestCap ==
  /\ phase = "prepared"
  /\ NextAttempt > MaxAttempts
  /\ phase' = "done"
  /\ outcome' = "retry-exhausted"
  /\ retrying' = FALSE
  /\ UNCHANGED <<lastAttempt, wireAttempts, approvals, remaining, pendingError,
                 pendingRetryAfter, lastDelay>>

RejectAdmission ==
  /\ phase = "prepared"
  /\ NextAttempt <= MaxAttempts
  /\ remaining < AdmissionMs
  /\ phase' = "done"
  /\ outcome' = "timeout"
  /\ retrying' = FALSE
  /\ UNCHANGED <<lastAttempt, wireAttempts, approvals, remaining, pendingError,
                 pendingRetryAfter, lastDelay>>

RejectUnapprovedRetry ==
  /\ phase = "prepared"
  /\ NextAttempt > 1
  /\ ~retrying
  /\ NextAttempt <= MaxAttempts
  /\ remaining >= AdmissionMs
  /\ phase' = "done"
  /\ outcome' = "failed"
  /\ UNCHANGED <<lastAttempt, wireAttempts, retrying, approvals, remaining,
                 pendingError, pendingRetryAfter, lastDelay>>

ReturnSuccess ==
  /\ phase = "inFlight"
  /\ phase' = "done"
  /\ outcome' = "success"
  /\ UNCHANGED <<lastAttempt, wireAttempts, retrying, approvals, remaining,
                 pendingError, pendingRetryAfter, lastDelay>>

ReturnError(error, retryAfter) ==
  /\ phase = "inFlight"
  /\ error \in Errors
  /\ retryAfter \in RetryAfterValues
  /\ phase' = "retryHook"
  /\ pendingError' = error
  /\ pendingRetryAfter' = retryAfter
  /\ UNCHANGED <<lastAttempt, wireAttempts, retrying, approvals, remaining,
                 lastDelay, outcome>>

RejectNonRetriable ==
  /\ phase = "retryHook"
  /\ ~IsRetriable(pendingError)
  /\ phase' = "done"
  /\ outcome' = "failed"
  /\ retrying' = FALSE
  /\ UNCHANGED <<lastAttempt, wireAttempts, approvals, remaining, pendingError,
                 pendingRetryAfter, lastDelay>>

RejectRetryCap ==
  /\ phase = "retryHook"
  /\ IsRetriable(pendingError)
  /\ (NextAttempt > MaxAttempts \/ lastAttempt >= MaxAttempts)
  /\ phase' = "done"
  /\ outcome' = "retry-exhausted"
  /\ retrying' = FALSE
  /\ UNCHANGED <<lastAttempt, wireAttempts, approvals, remaining, pendingError,
                 pendingRetryAfter, lastDelay>>

RejectRetryDelay ==
  /\ phase = "retryHook"
  /\ IsRetriable(pendingError)
  /\ NextAttempt <= MaxAttempts
  /\ lastAttempt < MaxAttempts
  /\ ~HasDelay(NextAttempt)
  /\ phase' = "done"
  /\ outcome' = "retry-refused"
  /\ retrying' = FALSE
  /\ UNCHANGED <<lastAttempt, wireAttempts, approvals, remaining, pendingError,
                 pendingRetryAfter, lastDelay>>

RejectRetryDeadline ==
  /\ phase = "retryHook"
  /\ IsRetriable(pendingError)
  /\ NextAttempt <= MaxAttempts
  /\ lastAttempt < MaxAttempts
  /\ HasDelay(NextAttempt)
  /\ remaining < DelayFor(NextAttempt, pendingRetryAfter) + AdmissionMs
  /\ phase' = "done"
  /\ outcome' = "timeout"
  /\ retrying' = FALSE
  /\ UNCHANGED <<lastAttempt, wireAttempts, approvals, remaining, pendingError,
                 pendingRetryAfter, lastDelay>>

ApproveRetry ==
  /\ phase = "retryHook"
  /\ IsRetriable(pendingError)
  /\ NextAttempt <= MaxAttempts
  /\ lastAttempt < MaxAttempts
  /\ HasDelay(NextAttempt)
  /\ remaining >= DelayFor(NextAttempt, pendingRetryAfter) + AdmissionMs
  /\ phase' = "modelCall"
  /\ retrying' = TRUE
  /\ approvals' = approvals + 1
  /\ remaining' = remaining - DelayFor(NextAttempt, pendingRetryAfter)
  /\ lastDelay' = DelayFor(NextAttempt, pendingRetryAfter)
  /\ UNCHANGED <<lastAttempt, wireAttempts, pendingError, pendingRetryAfter, outcome>>

Done ==
  /\ phase = "done"
  /\ UNCHANGED vars

Next == ModelRequest \/ SendRequest \/ RejectRequestCap \/ RejectAdmission \/
        RejectUnapprovedRetry \/ ReturnSuccess \/
        (\E error \in Errors, retryAfter \in RetryAfterValues : ReturnError(error, retryAfter)) \/
        RejectNonRetriable \/
        RejectRetryCap \/ RejectRetryDelay \/ RejectRetryDeadline \/ ApproveRetry \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in Phases
  /\ lastAttempt \in 0..MaxAttempts
  /\ wireAttempts \in 0..(ExpectedAttemptLimit + 1)
  /\ retrying \in BOOLEAN
  /\ approvals \in Nat
  /\ remaining \in 0..InitialRemaining
  /\ pendingError \in Errors \cup {NoError}
  /\ pendingRetryAfter \in RetryAfterValues
  /\ lastDelay \in Nat
  /\ outcome \in Outcomes

AttemptLimit == wireAttempts <= ExpectedAttemptLimit
OnlyApprovedRetries == wireAttempts <= approvals + 1
AdmissionWindow == phase = "inFlight" => remaining >= AdmissionMs
RetryApprovalHasEvidence ==
  retrying =>
    /\ phase \in {"modelCall", "prepared"}
    /\ IsRetriable(pendingError)
    /\ remaining >= AdmissionMs
RetryDelayHonored ==
  retrying =>
    /\ lastDelay >= DelayFor(lastAttempt + 1, pendingRetryAfter)
    /\ lastDelay >= pendingRetryAfter
PolicyInvariant ==
  /\ AttemptLimit
  /\ OnlyApprovedRetries
  /\ AdmissionWindow
  /\ RetryApprovalHasEvidence
  /\ RetryDelayHonored

===============================================================
