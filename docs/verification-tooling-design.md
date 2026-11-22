# Verification tooling for diagnosis and development

Status: proposed implementation design. The commands introduced here are not
implemented. This is a companion to the [Segment 2 design](segment-2-design.md)
and prepares the verification workflow for [Segment 3](../PLAN.md#segment-3-incremental-review-and-fix-follow-up).
It does not implement Segment 3 or change the product's review semantics.

## 1. Goal and inherited baseline

An AI investigating a failure needs the first failed boundary supported by
evidence, the facts still missing, and a concrete next check. An AI changing
the product needs enough checks for that change and evidence another agent
can inspect without repeating the same execution.

The core unit is a named check with an explicit claim and a retained receipt.
A successful command, a successful product review, and a passed acceptance
row are different facts. The tool keeps them separate.

The inherited baseline is `944c1bdb3d8ae5e0c6262e1f4c741875ebc70381`.

| Existing owner | Current behavior | Proposed change |
| --- | --- | --- |
| `src/verification/cli.ts` | Runs doctor, local checks, areas, and opt-in live model acceptance. Retains outer logs. | Keep one entry point. Add planning, inspection, receipts, and scoped execution. |
| `src/verification/github-cli.ts` | Repeats test files across three journeys. | Select a union of check IDs and own remote acceptance collection. |
| `src/verification/action-cli.ts` | Tests a separate frozen-install context, then deletes inner logs. | Keep the distinct context and retain its evidence. |
| `src/smoke/sdk-model.ts` | Requests prose OK and deletes its evidence on success or failure. | Replace it with a result-tool contract probe through the existing worker. |
| `src/phase-validation.ts` | Owns discovery, verification, and citation validation. | Reuse it for semantic replay. |
| `src/runtime/*` | Owns result tools, request policy, prompt recovery, deadlines, and process cleanup. | Reuse those contracts. Do not add a second model-request engine. |
| Product review and publication artifacts | Record snapshots, submissions, requests, timing, cleanup, handoff, and publication. | Admit them as evidence with explicit provenance and limits. |
| Verification skill and feature map | Explain existing commands but contain some stale statements. | Generate the check table from the catalog and maintain human-readable journeys. |

The scope excludes automatic code repair, issue closure, a daemon, a generic
workflow language, a distributed cache, and automatic changes to repository
visibility, permissions, secrets, or model endpoints.

## 2. Caller-visible usage

The examples below describe the target interface. Evidence paths are supplied
by the caller or returned by a previous command.

```sh
bun run verify inspect --input /evidence/failed-run
bun run verify plan --changed-from main
bun run verify run --changed-from main --reuse run-previous
bun run verify run --check sdk.result-contract
bun run verify replay --input /evidence/failed-run --layer semantic
bun run verify run --check provider.contract --operation probe-001 --permit provider
bun run verify run --resume probe-001
bun run verify collect --repository owner/fixture --run 123 --attempt 1
bun run verify run --check workflow.normal --repository owner/fixture \
  --workflow review.yml --ref acceptance --pr 17 --case repeat \
  --compare /evidence/automatic-defect \
  --operation defect-repeat-001 --permit provider --permit workflow
```

`inspect` reads evidence. It does not run checks or contact services. It emits
observed facts with artifact pointers, missing observations, applicability to
the current target, and at most three catalog-backed next checks. Messages
from artifacts are quoted data. They never become instructions or commands.
The first recorded failure is not automatically its root cause.

`plan` lists selected checks, their claims, selection reasons, applicable
receipts, required effects, and omitted or unmapped acceptance rows. It never
executes the plan. `run` computes the plan again from current inputs before
execution. The first implementation does not execute saved plan files.

`run` without selectors runs the broad local suite. `--check` and `--area`
select documented scopes. `--changed-from` includes committed differences,
staged edits, unstaged edits, deletions, renames on both sides, and admitted
untracked files. `--reuse` may be repeated. A receipt miss explains which
identity component differs. Independent checks continue after an unrelated
failure; a failed prerequisite skips its dependents.

`--reuse` accepts run IDs in the tool-owned store, not arbitrary paths.
`--out` writes an additional sanitized export; that copy is inspect-only.
`--check`, `--area`, and `--changed-from` are mutually exclusive selection
forms. `--case` applies only to checks that declare cases. A missing or unknown
case, conflicting selectors, or unrelated target flags exit `2` before work.
`workflow.normal --case repeat` requires `--compare` with an admitted original
defect observation. Manually dispatched defect or guarded cases can diagnose
those cases, but cannot satisfy the automatic-trigger acceptance requirement.

Every invocation that can launch paid or remote work requires an explicit
`--operation` key of 1 to 64 lowercase letters, digits, and hyphens. Repeating
the same key with the same normalized request reads the existing operation;
it does not start work again. Reusing it for different inputs exits `2`.
`run --resume KEY` accepts no selectors or effect permits and performs only
local inspection and bounded reconciliation reads. A fresh key and explicit
permits are required for a deliberately new paid attempt.

`replay --layer semantic` applies current production validators to captured
values and exact source material. Named SDK checks use scripted loopback
responses. The initial release does not implement general historical HTTP
replay. A bundle without full protocol capture reports that limitation rather
than synthesizing a supposed historical stream from assistant prose.

`collect` reads one exact GitHub run and attempt. It never starts or reruns a
workflow. It also accepts `--compare /evidence/previous-observation` for the
same-comment assertion. Plain collection exits `0` when admission and
collection succeeded and reports the observed product outcome. With `--compare`,
it is an assertion operation and exits `1` for a mismatch or `3` for missing
proof. The comparison requires the same repository, PR, product pins, and
reviewed snapshot, plus expected case outcomes and a fresh canonical comment
read. An imported comparison bundle supplies run identifiers only until its
provenance and artifacts are revalidated against authenticated exact-run reads.
A workflow run requires an explicit fixture target
and effect permits. Existing task authorization can supply those permits;
the CLI introduces no interactive approval loop.

Every command emits one versioned JSON summary on stdout. Progress goes to
stderr. The summary is bounded to 64 KiB and references larger local reports.
It includes operation, scope, result, evidence directory, check decisions,
missing proof, and next checks. A complete report remains on disk if the
summary reaches its bound. Truncation is explicit.

| Exit | Meaning |
| --- | --- |
| `0` | Inspection, collection, or planning completed, or every required check in the selected run scope has an applicable pass. This is not an unqualified segment acceptance. |
| `1` | At least one selected assertion failed. Other blocked checks remain in the report. |
| `2` | Invalid invocation, unsupported schema, or rejected input evidence. |
| `3` | No assertion failure, but required proof is blocked, interrupted, stale, or has an unknown side effect. |

Inspection of a failed review can exit `0`. Its JSON still records the failed
review. A negative scenario can pass its check when the product correctly
fails. `skipped`, missing evidence, and unregistered future checks never pass.

The table applies to the new canonical subcommands. Existing invocations keep
their presentation and exit mapping through thin aliases as their owners
migrate. Local aliases move at checkpoint 2 and paid aliases at checkpoint 3:

| Existing invocation | Canonical owner and effects | Compatibility |
| --- | --- | --- |
| `verify`, `verify --area NAME` | Current local scope or area, no service effects | Retain text progress and exit `0` or `1`. Keep the current default scope; an Action installation check remains a separate context. |
| `verify doctor`, `verify doctor --live` | Offline toolchain and optional configuration-shape checks | Retain text output and exit `0` or `1`. `--live` here never grants provider calls. |
| `verify --live` | Provider probe followed by three review cases | The explicit live spelling grants the declared provider work. Require an operation key for safe restart; missing key prints migration guidance and exits `1`. |
| `smoke:model`, `smoke:review` | Provider contract, or probe plus review cases | Replace the prose-only implementation at checkpoint 3. Preserve JSON smoke summaries and exit `0` or `1`; accept `--operation KEY`. Document the added contract probe before acceptance. |
| `test`, `typecheck`, `smoke:sdk`, `smoke:java` | Catalog-owned direct local drivers | Preserve current output and exit behavior. The catalog never invokes these aliases recursively. |

Adding an operation key to paid aliases is an intentional interface change.
Update their callers, CLI tests, skill recipes, and environment documentation
in the same checkpoint. New canonical commands use the versioned JSON and
four exit classes above. Legacy human-readable help remains available.

## 3. AI workflows

### Diagnose issue 11

1. Collect the exact original workflow attempt if its evidence still exists.
   Inspect it alongside the later diagnostic attempt.
2. Record the original pre-start input failure and absent field detail.
   Record the later successful input validation under its own pins. Do not
   combine these into a claim that the original cause was fixed.
3. Run `action.inputs` against missing and malformed field fixtures. Check
   field-level diagnostics, bounded output, and credential redaction.
4. If the decision concerns current deployment readiness, obtain a new real
   runner observation through the permitted workflow. If the decision
   concerns the old root cause, retain `unknown` when the old inputs are gone.

The tool can identify absent evidence and a useful next check. It cannot
reconstruct an unrecorded historical runner environment or close the issue.

### Diagnose issue 12

1. Inspect captured submissions, phase errors, and source inventory.
2. Replay malformed JSON or a rejected citation through
   `validateDiscoveryText`, `validateVerificationText`, or their value forms.
   Report the selected submission and current validator decision.
3. Run `sdk.result-contract` through the installed SDK and scripted endpoint.
   Cover valid submission, rejected then corrected submission, no submission,
   missing stream termination, and terminal step-cap tool choice.
4. After a fix, run the relevant deterministic checks. Use `provider.contract`
   and the three live review cases only when current provider behavior is the
   remaining question and the task permits those effects.

A replay proving that invalid evidence is rejected is not proof that a real
model now emits valid evidence. A scripted stream is identified as a synthetic
regression. Earlier successful code and prompt versions remain historical.

### Complete the evidence tracked by issue 14

1. Collect the known failed attempt. Report review failure and successful
   publication of its failure note as separate observations.
2. Resolve the published caller ref, reusable-workflow pin, Action pin, and
   fixture PR commits. A local unpushed caller commit does not satisfy this.
3. Validate local prerequisites. Require fresh runner observations for runner
   reachability and effective job permissions. A local `gh` token cannot
   establish what the workflow token can do.
4. Run the provider contract in the execution context being checked. A local
   pass does not replace the runner probe. A blocked prerequisite prevents
   full reviews from starting in that attempt.
5. Execute and collect defect, guarded, and manual-repeat cases on the
   intended deployment. Compare the first defect observation with its repeat.
   Require the same canonical comment ID, matching identities and snapshots,
   and each case's actual assertions. The defect case is complete with one
   verified finding. The guarded case has zero findings and no unknown
   verification decisions; its existing partial status after a rejected
   candidate is not redefined by this tooling change.

The remaining failure and continuous-push rows use declared acceptance
fixtures and collected observations. The tool does not create fault modes in
the production CLI. A live fixture that cannot reach the intended boundary
remains unavailable for that row. For example, a workflow rejected before
startup does not prove a comment API rejection after startup.

### Develop the Segment 3 partial-checkpoint behavior

1. Add `state.partial-checkpoint` with the implementation of that behavior.
   Its fixture publishes complete A, produces partial B, and processes C.
2. Run `plan --changed-from main`. A change to state ownership selects its
   state checks and the relevant publication integration checks. Changes to
   shared schemas widen the selection. Deadline or request-policy changes
   also select the existing formal verification gate.
3. Execute the selected checks. Assert the `A..C` discovery range, inclusion
   of B's changes, coverage flags, and checkpoint state before and after
   publication. Partial or stale C must leave A as the checkpoint.
4. A reviewer at identical inputs and environment inspects the receipt and
   reuses it for that check. A further edit to an already-dirty file causes a
   miss. Narrow execution still states which acceptance rows remain unproved.

The tool's receipt does not become the product's incremental checkpoint.
Production comment state remains the authority for review continuity.

## 4. Modules and contracts

Keep one product-specific catalog. Do not introduce plugins, arbitrary command
recipes, or a serialized execution graph.

| Module | Owned knowledge |
| --- | --- |
| `src/verification/cli.ts` | Grammar, caller effect permits, stdout summaries, and exit mapping. |
| New `src/verification/checks.ts` | Check IDs, claims, change routing, dependencies, fixed drivers, deduplication, and selected-scope aggregation. |
| New `src/verification/evidence.ts` | Captured inputs, schema admission, immutable attempts, content identity, provenance, and applicability. |
| New `src/verification/diagnose.ts` | Facts, missing evidence, and catalog-backed next checks for supported artifact versions. |
| New `src/verification/replay.ts` | Admission and semantic replay through existing production validators. |
| `src/verification/github-cli.ts` | Fixture targets, dispatch intent, exact-run collection, and remote acceptance assertions. |
| Existing journey and smoke modules | Fixtures and assertions over the public product behavior. They use the common runner and evidence owner. |

The normal call path crosses the CLI, one verification owner, and an existing
product owner. Production validation and publishing rules stay in their
current modules. Runner support moves out of test entry files only where both
tests and the CLI need it. There is no second copy of the request policy.

This sketch names the domain. Implement boundary schemas with the repository's
Zod conventions, derive types from them, and reuse existing branded identities.
These declarations are explanatory and are not runtime stubs.

```ts
type ProofLayer =
  | "local-contract" | "local-journey" | "semantic-replay"
  | "scripted-sdk" | "live-model" | "live-github"

type Subject =
  | { kind: "local"; image: InputDigest; context: ContextDigest }
  | { kind: "historical"; capture: ArtifactDigest; consumer: InputDigest }
  | { kind: "provider"; image: InputDigest; model: PublicModelIdentity }
  | { kind: "workflow"; target: PinnedTarget; execution: RunAttempt }

type CheckOutcome =
  | { kind: "pass"; proof: VerifiedAssertions }
  | { kind: "fail"; failures: NonEmpty<AssertionFailure> }
  | { kind: "blocked"; prerequisite: MissingPrerequisite }
  | { kind: "skipped"; dependency: CheckId }
  | { kind: "interrupted"; evidence: ArtifactRefs }
  | { kind: "effect-unknown"; intent: EffectIntentId }

type Applicability =
  | { kind: "reusable"; receipt: ApplicableLocalPass }
  | { kind: "stale"; differences: NonEmpty<InputDifference> }
  | { kind: "historical"; reason: string }
  | { kind: "untrusted"; reason: string }

declare function planChecks(request: Selection, image: CapturedImage): CheckPlan
declare function runChecks(plan: CheckPlan, grants: EffectGrants): Promise<RunReport>
declare function inspectEvidence(source: AdmittedEvidence): Promise<Diagnosis>
declare function replaySemantic(source: SemanticCapture): Promise<CheckOutcome>
declare function collectWorkflow(target: RunAttempt): Promise<WorkflowObservation>
```

The catalog pairs each check ID with its allowed layer, subject, driver,
dependencies, effects, and acceptance rows. Boundary validation enforces these
pairs after deserialization. Only successful assertion evaluation over admitted
evidence constructs `VerifiedAssertions`. Missing input provenance produces
`blocked`, even if the observed process exits successfully. Only the local
matcher constructs `ApplicableLocalPass`.

For an inspected stream failure, the summary can report these facts without
deciding whether the defect belongs to the gateway, provider, or adapter:

```json
{
  "schemaVersion": 1,
  "operation": "inspect",
  "result": "reported",
  "facts": [
    { "boundary": "discovery", "observed": "failed", "code": "model-format", "evidence": "review-result.json#/outcome/failure" },
    { "boundary": "publication", "observed": "failure-note-written", "evidence": "publish-result.json#/publication" }
  ],
  "missingProof": ["normal-review-success", "root-cause-attribution"],
  "nextChecks": ["sdk.result-contract", "provider.contract"]
}
```

`nextChecks` are suggestions. The runner resolves their current catalog
definitions and still requires caller-supplied targets and effect permits.

The initial catalog includes `action.inputs`, `sdk.result-contract`,
`provider.contract`, `review.live`, and `workflow.normal`, plus the current
local file groups and journeys. Case selection for `workflow.normal` is the
closed set `defect`, `guarded`, and `repeat`. `review.live` groups three separately
recorded checks, `review.defect`, `review.guarded`, and `review.incomplete`.
They can also be selected individually for a newly authorized retry of one
failed case. Each new local paid operation runs its contract probe once before
its selected review cases. A plan declares the number of
workflow starts and affected fixture targets before execution.

Acceptance row IDs are explicit metadata, not inferred from test counts.
The catalog validates its mapping against the plan's declared acceptance
inventory. An unmapped required row blocks a full acceptance verdict.
Focused checks can finish while showing that row as outside their proof.

## 5. Selection, capture, and reuse

Selection and reuse answer different questions. Selection chooses what a change
needs. Reuse decides whether an already executed check proves exactly that
request. The first version uses conservative whole-input identity for reuse.
It does not infer a minimal dependency closure.

The catalog maps owning paths to checks. Renames select both owners. Shared
contracts, verifier changes, lockfile changes, and unclassified executable
paths widen to the broad local suite. New acceptance rows must be mapped or
explicitly pending. Future Segment 3 rows cannot be registered as passing
placeholders. Help, area membership, and the skill's check table derive from
this catalog. Generation checks reject stale copies.

Capture an execution image before running reusable checks. Copy admitted
tracked and nonignored untracked inputs into a private directory. Record paths,
bytes, modes, deletions, and supported internal symlink targets. Reject links
escaping the image, special files, secrets, and changing capture inputs. Do
not copy credentials, user configuration, Git hooks, or an ambient home.
Repository packaging files remain available as data where a check needs them;
model material stays in a separate clean location with no ancestor instructions.

The image includes verification and product code, assertions, fixtures, prompts,
configuration, lockfile, and generated workflows. The bootstrap path remains
`bun install --frozen-lockfile --ignore-scripts`, explicitly run by the caller
when dependencies are missing. The verifier imports the resolved installed
dependency tree into its private immutable store, checks locked versions and
import resolution, and hashes the actual bytes and links. This establishes
execution identity, not an independent supply-chain approval. A cache miss
cannot silently authorize a network install.

Resolve and bind the Bun, TypeScript, Git, and Java executables actually used.
Launch with explicit argv, `--no-env-file`, an allowlisted environment, isolated
HOME, and fixed Git configuration. Capture a stable source inventory and compare
the source bytes with the captured image before execution. A changing capture
blocks that attempt. Checks that need Git history receive verified fixed objects
and the original source identity. Do not label a synthetic fixture commit as
the original source commit.

At checkpoint 2, enable automatic reuse first for schema, renderer, and
phase-validation checks. SDK, process, and Action checks retain separate
recipes and initially run fresh even when an older receipt matches. All
required checks need bound execution inputs to satisfy the canonical run.
During migration, an unsupported context can still produce diagnostic output
through its legacy entry, but it remains blocked in the new exact-input gate.
Checkpoint 2 cannot close until the existing local gate has complete recipes.
Before/after hashes alone never turn a mutable workspace observation into an
exact-current-input pass.

The Action installation recipe gets a separate owned writable tree copied from
the captured source. It performs the frozen offline install with a declared
cache, asserts that source and lockfile stayed unchanged, then captures the
resolved dependency identity before running assertions. All expected writes
are in this tree or its scratch directory. It never mutates the immutable
input or dependency store. A cold offline cache reports the explicit bootstrap
command as an unmet prerequisite.

Execute from the captured image. Never fill a missing dependency by reading
the mutable source checkout. If image construction cannot preserve a check's
required context, keep its raw observation but block reusable proof until that
context is modeled. Check current applicability again before reporting a run
as satisfying the caller's current inputs. Edits during execution can leave
a valid historical receipt and a stale current request.

The reuse key includes check and assertion version, complete input digest,
dependency image, toolchain and platform, admitted non-secret environment,
and execution context. The same file in a frozen Action installation and a
normal local test run is different evidence. Identical recipes within one
context execute once and share their execution receipt across mapped claims.

Only intact local passes resolved by run ID in the tool-owned private store are
eligible for automatic reuse. Each receipt binds the issuing verifier's actual
loaded implementation, catalog, assertion code, and their committed content
identities. The launcher re-executes the registered captured verifier entry
point with the resolved Bun binary; it does not issue proof for an unrecorded
ambient verifier. Dirty product code can be a subject. Dirty verifier, catalog,
or assertion code produces fresh diagnostic observations but no reusable
receipt until the trusted committed definition and executed bytes agree.

The local account and trusted checkout are the execution trust boundary; this
does not protect against a malicious actor with the same account. Hashes prove
integrity, not authorship. Imports and exported copies cannot register a local
issued run. A changed assertion or issuer invalidates the old receipt even if
all product bytes match. Live model health and workflow permissions always
require fresh observations when readiness is requested.

## 6. Evidence lifecycle and diagnosis

Each attempt owns a fresh directory in the verifier's durable private store
outside the repository. An explicit `--out` path receives an export only and
must satisfy the existing clean-location rules. The report names both the
store run ID and any export path. Importing that export cannot make it reusable.

An attempt contains its input manifest, scoped plan, command records,
assertions, bounded sanitized logs, product artifacts, cleanup record, and
terminal receipt. Larger source and trace records remain local. Write files
atomically, then publish the terminal receipt only after referenced artifacts
and their digests exist. Independent agents write independent attempts.
Read-time aggregation replaces a shared mutable latest-result file.

Admission rejects unsupported schemas, traversal, symlinks in imported
archives, oversized records, and digest mismatches. Use the existing 64 MiB
export ceiling. Record every omission and truncation. Semantic replay needs
exact selected values, phase context, candidate IDs, and referenced material;
absence of any required part makes that replay unavailable.

Redact known credential values from arbitrary captured stdout and stderr before
persistence, not only from headers. Persist only allowlisted configuration and
header fields. Never record credential hashes. Sensitive source, prompts, and
private endpoints are not automatically published with an issue or PR. An
explicit export applies a separate allowlist and redaction pass.

Diagnosis reports structured product codes and the evidence supporting them.
Legacy text is an observation, not a newly invented typed root cause. For
example, HTTP 200 followed by a failed terminal turn is not a successful model
request. The report names the failed boundary and proposes the cheapest
registered check that can supply the missing observation. No embedded model
is needed to choose these bounded next checks.

Cleanup removes only owned scratch and credentials. It never removes evidence
because a check failed. A crash without a terminal receipt remains interrupted.
Cleanup failure remains visible beside the primary result and prevents a claim
of successful cleanup. Do not kill by process name or trust a stale PID file
after restart; verify process ownership and start identity before any cleanup.

## 7. External effects, retries, and recovery

Default local checks receive no service credentials. They may use loopback
fixtures. `doctor` remains read-only and offline. Collection makes authenticated
read requests. Provider and workflow execution require explicit scoped permits
from the invocation. Evidence, suggested next checks, and saved plans cannot
grant effects, supply arbitrary argv, choose an endpoint, or select a new
repository. Target configuration comes from the trusted invocation.

The provider probe uses one tiny fixed fixture and the production isolated
worker, result tool, semantic validation, terminal-turn handling, and cleanup.
Use a 60-second whole-worker budget and the existing step and request policy.
Persist actual request counts, retries, accepted submissions, terminal category,
and usage. Do not add a probe-only no-retry policy or call its deadline a billing
cap. A passing probe proves this protocol interaction, not review quality.
Run it inside the runner when runner connectivity is the claim being checked.

The operation-key protocol covers local paid work as well as workflow
dispatch. Persist the normalized request, subject, permitted effects, and
ordered case IDs before work. For each paid case, durably write `starting`
before spawning its worker, then its terminal receipt after collecting the
result. A restart with `starting` and no valid terminal receipt is unknown.
`--resume` reads the original worker artifacts and owned-process state; it
does not create a new SDK session or start a previously unstarted case.
Completed cases remain evidence for that operation. To run a failed or pending
case again, select that named case under a new operation key and fresh permits.
Transport retries inside the original worker remain the production policy's
responsibility. They are distinct from restarting a paid case.

### Runner integration and normal acceptance sequence

Checkpoint 4 updates `scripts/workflows.ts`, the reusable workflow, and the
root Action together. Add an optional `verify-provider-contract` boolean to
the reusable workflow and Action, defaulting to false. It is valid only in
review mode. In the review job, after the pinned Action has installed its
dependencies and before it starts the product review, this option invokes
the canonical provider contract with the same installed product, provider
configuration, model secret, and runner context. Evidence uses the run ID,
attempt, and `provider-contract` case identity. A repeated step invocation
under that identity reads its receipt instead of starting another probe.

A failed probe stops the normal review and preserves its evidence for upload.
The workflow still reaches its existing failure publication path. Probe output
is an additional diagnostic artifact, never an arbitrary product handoff.
The option enables a real protocol check; it introduces no fault injection or
alternate review semantics. Ordinary callers retain current behavior when it
is false.

Generate a dedicated acceptance caller using the same pinned reusable workflow.
It preserves the normal PR triggers and manual dispatch input. Add a bounded
`verification-operation` input for manual runs and include it in run-name
metadata, so reconciliation can read it independently of model artifacts.
The normal automatic runs use their actual event, PR, caller SHA, run ID, and
attempt as provenance. Verification refuses unsupported callers rather than
passing an undeclared correlation field to them.

The normal acceptance sequence is fixed:

1. Collect the automatic defect PR run. Require one successful runner probe,
   the expected defect report, and a confirmed publication.
2. Collect the automatic guarded PR run under the same product deployment.
   Require its probe and guarded assertions. Creating or updating those fixture
   PRs is a separately authorized fixture-preparation action, not a hidden
   side effect of collection.
3. Dispatch one manual repeat of the unchanged defect PR using a fresh
   operation key. Collect its probe, review, and publication, then compare it
   with the automatic defect observation for the same canonical comment ID.

This sequence launches three runner probes and three full reviews through two
automatic events and one explicit manual dispatch. It performs no additional
local provider probe. Each runner is a new context, so its probe is not reused
across jobs. A local three-case acceptance operation instead launches one
local probe followed by its three reviews. Count logical launches, actual
requests, retries, and usage separately. These counts are not billing caps.

The review-job probe cannot prove publish-job write permission. Readable job
permission records are observations; the successful production publication
is the normal case's write proof. Expected-failure fixtures declare their
intended failed boundary and probe setting explicitly so a preflight failure
cannot accidentally satisfy a later failure assertion. Failure and push-race
rows remain separate from the three-run normal sequence.

For workflow execution, resolve the designated caller branch or tag and all
pins remotely. Recheck them and the fixture PR immediately before dispatch.
Write an intent containing expected identities, requested case, and the
caller-supplied operation key used for correlation. Durably claim it with exclusive creation before
the single POST. A repeated invocation of the same intent performs reads only.

The current GitHub REST documentation returns a run ID and URLs from dispatch.
Validate that response and independently fetch the exact run. The API accepts
a branch or tag ref. Ref resolution and dispatch are not atomic. A ref can
move after the last read and consume one permitted dispatch. Collection must
detect that drift and withhold acceptance; the design does not promise to
prevent this platform race.

If the response is lost, malformed, or unavailable after a crash, retain
`effect-unknown`. Reconcile only through an exact run identity or the expected
correlation metadata and target. Never choose the newest run or retry the POST
because no matching run has appeared yet. No match or multiple matches remain
unknown. A new deliberate attempt uses a new intent and fresh caller permits.
This also covers a crash after the durable claim but before the POST. The
tool may conservatively leave an unsent attempt unknown. It accepts that
availability cost rather than guessing that a remote side effect did not occur.

Collection binds repository ID, run ID, attempt, caller commit, workflow pin,
Action pin, fixture snapshot, artifact receipts, and canonical comment. It
validates product outcomes independently of workflow conclusion. An invalid-key
scenario can have a failed workflow and a passed failure-handling assertion.
Missing or expired artifacts cannot establish that assertion.

The existing workflow remains the only review comment writer. The verifier
does not publish imported handoffs, change permissions, push refs, or edit
secrets. Concurrent tests against a shared fixture may invalidate each other's
current observations; report that conflict instead of attributing it to a
product bug. Keep acceptance mutations sequential for each fixture target.

| Side effect | On repeat or crash |
| --- | --- |
| Local image and scratch creation | Use a new owned attempt; incomplete preparation is not executable evidence. |
| Receipt publication | Atomic terminal publication; an incomplete attempt cannot be a pass. |
| Local check | Start a new attempt when interrupted. Reuse only admitted exact local proof. |
| Paid case launch | One worker launch per operation and case. A durable start without a terminal receipt remains unknown on resume. |
| Model request | Existing runtime owns retries and accepted-prompt recovery within that worker. The verifier never creates a new session to recover an unknown case. |
| Workflow dispatch | One POST per claimed intent. Reconcile unknown effects without redispatch. |
| Artifact collection | Bounded read retries; retain each exact observation and do not mutate the remote run. |
| Cleanup | Remove owned scratch only. Keep primary failure and cleanup failure separately. |

## 8. Invariants and verification

| Invariant | Enforcing owner | Deterministic proof | Separate live evidence |
| --- | --- | --- | --- |
| A command success cannot imply unrelated acceptance. | Check aggregation | Focused pass leaves unmapped rows pending; expected product failure has its own assertion. | Real failed review with a successfully written failure note. |
| Imported bytes cannot authorize execution. | CLI and evidence admission | Inject argv, endpoints, commands, paths, and workflow targets into imported bundles; observe zero effects. | None needed. |
| Reused proof matches actual inputs. | Evidence capture and matcher | Dirty re-edit, rename, deletion, new file, changed dependency, source mutation during execution, and changed context reject reuse as appropriate. | None needed. |
| A check runs once per recipe and context. | Catalog planner | Overlapping area selection produces one execution, while Action context stays distinct. | None needed. |
| Missing evidence never becomes pass. | Receipt schemas and assertions | Missing artifacts, unsupported legacy fields, zero executed assertions, or incomplete source capture block proof. | Expired or unavailable Actions artifacts remain incomplete. |
| Historical replay claims only its available layer. | Replay owner | Malformed JSON and exact citations use production validators; absent HTTP frames cannot produce a transport-replay verdict. | Provider contract and three-case review acceptance remain separate. |
| Cleanup preserves diagnosis and credentials stay private. | Evidence and runner lifecycle | Failure, timeout, forced termination, redaction sentinels, and cleanup errors retain bounded evidence without credential values. | One controlled runner failure retains artifacts after cleanup. |
| Unknown remote submission does not repeat. | Workflow intent owner | Crash before and after POST, response loss, concurrent starts, mismatched correlation, and duplicate run matches never cause a second POST. | One normal dispatch is bound to its actual run. |
| A restarted paid local operation does not repeat cases. | Operation and case records | Lose the worker response and interrupt between cases. Resume reads completed or unknown cases and starts no worker. | One paid operation retains case identities and request counts. |
| Receipts identify their actual issuer and assertions. | Store admission and captured launcher | Copied exports, rehashed foreign receipts, changed assertion code, and dirty issuer code cannot satisfy the original reusable check. | None needed. |
| Provider probe uses production request behavior. | Existing runtime | Scripted SDK scenarios exercise result tools, terminal choice, request policy, and deadline cleanup. | One real provider protocol observation per required context. |
| Segment 3 checkpoints advance only after complete current publication. | Future state and publish owners | A/B/C, stale publication, interrupted recheck, and omitted ID sequences inspect the resulting state and scopes. | A corresponding delivered workflow sequence when Segment 3 implements it. |

Register these Segment 3 checks with their implementation, not before it:

| Acceptance row | Proposed check | Required observations |
| --- | --- | --- |
| Stable issue number across edits, fix, and rename | `state.identity` | Same number, current citations, and code evidence for addressed; rename alone does not close. |
| A complete, B partial, then C | `state.partial-checkpoint` | C includes B and uses A until complete current publication. |
| Force push or changed base | `state.fallback` | Full scope with a recorded reason and individual old-issue rechecks. |
| Author disposition and unauthorized reply | `state.feedback` | Disposition separate from code verdict, no unauthorized mutation or duplicate alert. |
| Interrupted batch or omitted old ID | `state.recheck-budget` | Unknown results, retained evidence and checkpoint, and bounded process exit. |
| State cap, damaged state, and deletion | `state.rebuild` | Last valid state preserved at the cap; rebuild changes generation and rejects old replies. |

Request admission, retry classification, retry limits, delay selection, and
deadline changes continue to require the existing request-policy model check.
Fake-clock proof and real SDK or process proof remain distinct. This tooling
work does not expand the model's claimed coverage.

The catalog also defines required gate sets for each Segment 3 checkpoint:

| Change boundary | Required deterministic set | Independent live obligation |
| --- | --- | --- |
| State identity, migration, or author feedback | Relevant state/feedback scenarios, schema and rendering checks, and publication assertions | Delivered fix/disposition journey when that feature is integrated. |
| Discovery scope or checkpoint advancement | `state.partial-checkpoint`, `state.fallback`, and real dispatcher/publication integration | Automatic and manual runs showing the selected scope and post-publication checkpoint. |
| Phase allocation, recheck batching, shared deadline, or SDK hook ordering | Applicable request-policy model, scripted SDK checks, fake-clock multi-phase cases, and representative process interruption/cleanup | Provider-backed recheck behavior under the delivered scheduling path. |
| Retry admission, classification, cap, or delay | Request-policy model and sensitivity mutation, scripted wire behavior, and affected deadline checks | Provider connection evidence when the provider integration changed. |
| Comment size, generation, or rebuild | `state.rebuild`, feedback generation isolation, and publication preservation | Delivered damage/rebuild journey in the fixture workflow. |

Match these boundaries through all owning files, not only
`request-policy.ts`. A selection test that changes only the future phase
allocator must still select scheduling gates. The formal model remains scoped
to one serialized logical primary call; multi-batch behavior needs the separate
clock and process scenarios. A Segment 3 checkpoint cannot close from a single
focused pass when its gate set remains incomplete. Full acceptance continues
to show each live row separately.

## 9. Implementation checkpoints

Use one tooling integration branch with focused commits and one implementation
PR, following [CONTRIBUTING.md](../CONTRIBUTING.md). Do not create a PR for each
checkpoint. The current design PR contains no implementation.

| Checkpoint | Usable result | Evidence required before the next checkpoint |
| --- | --- | --- |
| 1. Retain and inspect | `inspect` reads legacy and current artifacts; failed model and Action helpers retain inner evidence. | Run the public inspection command on sanitized issue 11 and 12 fixtures. Assert facts, missing evidence, redaction, and evidence survival after failure and cleanup. No paid request required. |
| 2. Catalog and exact receipts | `plan`, scoped `run`, deduplication, input capture, and exact reuse work through one owner. | Real CLI journeys prove selection, same-path second edit, immutable execution inputs, cold dependency preparation, separate writable Action installation, concurrent attempts, rejected foreign evidence, and one execution per recipe/context. Compare the old and new declared coverage sets. |
| 3. Replay and provider contract | Semantic replay and named actual-SDK regressions diagnose issue 12; the old prose-only smoke is replaced. | Reproduce captured invalid JSON/citations without provider calls. Exercise malformed stream and missing submission through the real SDK. Prove operation-key recovery and interrupted case batches without paid calls. Then obtain one separately labeled live protocol observation. |
| 4. GitHub collection and acceptance | Exact-run collection, durable dispatch intent, the optional runner probe, and normal-case comparison address issue 14. | Adapter faults prove same-command concurrency, uncertainty, and drift handling. Automatic defect and guarded runs plus a manual repeat prove intended pins, trigger paths, and the same comment ID. Required negative and push-race rows remain visibly pending until their live observations exist. |
| 5. Segment 3 adoption | New state features bring their check registrations and focused development journeys. | Each product checkpoint proves its own row. No blanket tooling pass certifies unimplemented Segment 3 behavior. |

Checkpoint 1 provides diagnostic value before caching or remote orchestration.
Checkpoints 2 and 3 provide development value before GitHub availability is
required. Do not block unrelated deterministic development on a provider outage.

The throughput checkpoint is time to a trustworthy scoped decision, with
commands executed, receipts reused, paid requests, blocked prerequisites, and
repeated diagnosis counted separately. Baseline and revised runs must use the
same changes, scenarios, and environments. Record repeated paired runs before
claiming a speedup. The two development goals are fewer duplicate executions
and fewer attempts needed to locate a failure, not a lower test count.

## 10. Migration and deletion

Move the check lists from `cli.ts`, `github-cli.ts`, `action-cli.ts`, and package
scripts to the catalog in one checkpoint. Catalog drivers call concrete Bun
test commands or fixture functions directly. They must not call a package
script that routes back into the catalog. This avoids recursive verification.

Keep current default, area, doctor, and explicit live entry points as thin
grammar mappings to the same owners while all repository callers migrate.
Replace the OK-only model smoke and move its callers together. Do not retain a
second live-probe implementation. Preserve production review and publish exit
behavior; the new exit contract belongs to the verification CLI only.

Update `ENVIRONMENT.md`, `CONTRIBUTING.md`, package scripts, the verification
skill, feature-map driving sections, and examples with the implemented
commands. Correct the runtime feature map's claim that an accepted prompt is
resubmitted and its stale statement about runtime-area policy coverage.
Replace private handoff instructions that duplicate the full suite with a
scoped run and receipt inspection. Do not import private audit files into the
product. Retire their status-list digest as evidence identity.

Segment 2 acceptance remains the scope authority. This proposal replaces the
unimplemented `--live-github` command shape with catalog-owned workflow checks
and exact-run collection; it does not silently waive any existing live row.

## 11. Rationale and accepted tradeoffs

Redesign from First Principles changes the unit from a successful shell
command to a supported claim about a specific subject. Model the Domain
separates check outcomes, product outcomes, and evidence applicability.
Separate Before Serializing Shared State gives each attempt its own directory.
Make Operations Idempotent requires reconciliation after an uncertain dispatch.
Laziness Protocol keeps the existing product engines and one small catalog.

Two independent designs converged on catalog ownership and retained receipts.
The synthesis uses the caller-first inspect/plan/run interface, conservative
whole-input matching, and durable dispatch claims. It rejects a probe-only
two-send/no-retry rule because that would introduce request behavior different
from the production policy the probe is meant to exercise.

The alternatives considered were a persistent investigation workflow engine
and verification records emitted by each production module. The engine adds
another long-lived state machine for the AI to manage. Module-emitted records
do not independently prove packaging, absent startup, or failed dispatch and
leave selection and deduplication to the caller. The catalog hides those
decisions behind one product-specific interface.

Whole-input matching can reject reusable evidence after an unrelated edit.
Accept that cost before implementing dependency inference. Existing code
selection still makes the edit loop narrower. General HTTP recording/replay,
narrow dependency caching, cross-machine reuse, and parallel live execution
are deferred until measurements justify them.

Remaining implementation risks are faithful input-image construction,
dependency provenance, runner-side probe integration, and correlation after a
lost dispatch response. Each has an explicit failing case above. A missing
observation must remain a missing observation; implementation must not weaken
that rule to complete a checkpoint.

External protocol reference: GitHub REST Actions workflow documentation,
Create a workflow dispatch event, retrieved on 2026-11-22. Recheck its response
schema and supported API version when implementing the adapter. The original
product design and [PLAN.md](../PLAN.md) remain the authorities for product
semantics and acceptance.

Canonical reference for the implementation adapter:

```text
https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
```
