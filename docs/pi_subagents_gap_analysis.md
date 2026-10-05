# Full picture: pi-subagents, pi-intercom, pi-messenger and visible Herdr workers

Assessment: 2026-10-03. **Finding out only.** No installation, configuration change,
migration, implementation, co-loading experiment or live messaging probe was
performed for this assessment. Existing multi-wait team work is separate.

This revision supersedes the initial pi-subagents-only verdict. Adding Intercom
materially changes the answer: existing **Pi peer conversation** is no longer a
reason by itself to retain our prompt/wait/read implementation.

## Clear verdict

**User-confirmed direction: pure Herdr + pi-subagent-herdr as a convenience
wrapper for agents' most-used Herdr commands.** This is the preferred approach
both pragmatically on its own and as an experimental foundation for the broader
deliberate-agent direction. The extension is not a separate orchestration system.
This supersedes the earlier preference for adding Intercom; it does not erase
the capabilities found below or prove parity with a correlated message broker.

Today's structure — Pi coordinating → Herdr → Pi executing — lets us experiment
with collaboration patterns before encoding proven lessons into POCE/GENIETABLE
or potentially BEAM/OTP. The user explicitly connects these structures; they are
not competing destinations. Keep the wrapper convenient and the patterns flexible,
without prematurely imposing the future system's architecture.

Distinguish execution/control from collaboration protocols, rather than choosing
by package feature count. A multiplexer provides panes and agent interaction;
worker profiles/runtime provide execution policy; agents and report conventions
provide task meaning. Herdr alone is not the policy guard or task scheduler.

- **Intercom is a strong fit for buddy/Firstmate conversation:** post messages,
  receive pushed updates, or ask and get a correlated reply directly. An ordinary
  conversation need not inspect terminal tails to discover its answer.
- **Messenger is useful shared-work coordination:** presence, direct/broadcast
  messages, file reservations, task claims and an activity feed. Its optional
  **Crew executor is a separate execution engine that starts hidden workers**;
  it must not be confused with messaging between already-visible peers.
- **pi-subagents is useful task orchestration:** managed runs, results, native
  controls, parallel workflows and completion notification. PR #2194 supplies
  actual visible execution for saved-machine runs, not default local children.
- **Herdr execution visibility and lifecycle remain separate requirements.**
  Neither a broker, a roster, a Crew progress overlay nor an inspector dashboard
  turns a hidden subprocess into an actual interactive worker pane.

**Preferred direction:** keep visible execution, inspection, prompt/wait and
lifecycle on Herdr. Use explicit task/report identity, text and permitted files
for collaboration. Preserve useful proven helpers rather than stripping them to
bare CLI parity. Do not build a second scheduler, hidden mailbox daemon, automatic
retry engine or persistent task registry under the name of “conventions.” Fewer
packages are not necessarily less total complexity.

Idle-peer agent prompting already provides push-and-wakeup; this is not exclusively
a polling architecture. File publication by itself does not wake a parent. Busy-
parent delivery, reply correlation, completion attribution and failure recovery
are separate concerns, not established by a successful idle-peer prompt. Current
readonly workers report through terminals and their allowlist excludes native
control tools; do not assume every worker can write reports or call back through
those tools. These are operational constraints, not security isolation guarantees
(`AGENTS.md`, `docs/tool_usage_review.md` implemented boundaries,
`docs/security.md`).

Reconsider Intercom for a concrete important need that this approach cannot meet
cleanly: correlated replies during active work, reliable busy-parent notifications,
or routing that materially reduces existing complexity. No arbitrary incident
count is a gate. Messenger coordination and pi-subagents execution remain optional
alternatives, not mandatory additions. No integration, adapter, migration or
implementation is authorized by this findings-only assessment.

## Evidence and pinned versions

| Component | Inspected revision | Role |
|---|---|---|
| pi-subagents | `ad56bf92fe01a2a5abd962938c619eb2a22ca47d`, 0.75.0; also PR #2194 merge `77c3eed` | Run/workflow engine; saved-machine visible execution |
| pi-intercom | `924917f189f5cf5f55ec8bc5be21ded99d252200`, 0.16.0 | Brokered direct session messaging and request/reply |
| pi-messenger | `09937ed647a1b07a3b595bf75943feacb80ff123`, 0.15.2 | File-based peer mesh; optional independent Crew/Team system |

Method: remote source/docs, public export inventory, secondmate discussion and
source reconciliation. No upstream test suite or live runtime was exercised.
PR validation claims are not independently reproduced acceptance. Baseline needs:
`REQUIREMENTS.md`, `docs/tool_usage_review.md`, `docs/multi_pane_wait.md`.
Identical tool names, exact parameter fields and an unchanged nine-tool count are
not replacement criteria.

## 1. Intercom: the missing conversational layer

### What it establishes

Intercom-enabled Pi sessions connect to a local IPC broker. Any registered peer
in the same broker/routing scope can be targeted by stable session ID or an
unambiguous name; launch ownership is not required. A cwd can be an additional
routing guard. This covers existing buddy and other-project Firstmate conversations
that the pi-subagents run API alone did not establish. [I1, I2]

- `send`: non-blocking notification/message; delivery is not task completion.
- `ask`: send and await a matching sender + `replyTo`; returns the authored reply
  as the tool result, not a terminal snapshot. Default timeout is ten minutes;
  only one pending ask per sending session is allowed.
- `reply` / `pending`: resolve an inbound ask, with exact targeting or explicit
  disambiguation. This is conversation correlation, not task acceptance.
- `cancel`, `supersedes`, `retryOf`: explicit lifecycle for messages. An already
  injected cancellation does not pretend to remove work from Pi's queues.
- Idle messages can trigger a turn. Busy interactive peers receive safe-boundary
  steering; optional human-first delivery defers peers behind human input.
  Compaction/held messages have delivery-state diagnostics. [I1–I3]

For a one-off question, **ask → reply → returned answer** is often the useful
workflow, rather than prompt → terminal-state wait → pane read. If literal console
output is required, an authored reply is not equivalent; keep explicit inspection
for that case. No automatic pane closure follows from messaging.

### Completion is not automatic

Intercom transports messages; it does not independently know that a peer finished
an assigned task. With ordinary visible peers, the worker must explicitly reply
or post a completion report. For pi-subagents-managed runs, final result/completion
notification belongs to that run engine; `contact_supervisor` is for decisions,
interviews and meaningful updates, **not routine final completion**. [I1, P3]

A delivered, received or injected message is not model compliance, a correct
artifact or a settled worker. Verify files/tests/other deliverables independently.

### Visibility support—and its limit

`send`/`ask` with `cwd` and `openProjectPaneIfMissing` can open an **actual local
Herdr pane**, launch Pi, await broker registration and then route the message.
This is a real visible-peer capability, not merely a dashboard. [I4]

The inspected launcher runs a plain configured Pi executable (`PI_INTERCOM_PI_BIN`,
then `PI_BIN`, then `pi`); it has no per-call readonly/editable role, tool ceiling,
model/profile or required-extension launch contract. It splits the current pane;
focus defaults true, with explicit false available. A late registration timeout
can leave a starting pane; it is not evidence that no process was created.

Multiple existing peers in the same cwd **are addressable** by exact ID or an
unambiguous name. Cwd alone refuses ambiguity. This must not be misreported as
an inability to message a team. However, opening missing project peers is not yet
a demonstrated role-controlled multi-worker launcher: it tries an existing peer
first, and a requested absent name is not automatically assigned by its bare Pi
launch. [I4]

### Reliability, locality and trust limits

- Peers must have Intercom enabled and registered. Its roster is not all panes
  or all Pi processes; non-Pi terminal agents are not broker peers.
- Broker/routing scope must match. `PI_CODING_AGENT_DIR` changes Intercom's
  runtime directory, so same-host sessions in different profiles are not
  automatically established to share a broker. Provisioning must be checked.
- Ask requires a connected recipient; non-blocking send can use a bounded
  in-memory mailbox for eligible disconnected named sessions. That mailbox is
  **not durable across broker restarts**. Session-history entries do not imply
  a durable pending-work queue.
- Duplicate message IDs are injected at most once per receiving session under
  the documented mechanism, not exactly once across arbitrary process restarts.
- Timeout is not cancellation. Never blindly resend after an ambiguous timeout.
- Native cross-machine `name@machine` send/handover uses explicitly selected
  Herdr saved machines and SSH. Version 1 does **not** support native cross-machine
  ask, `replyTo`, attachments, project-pane routing or lifecycle operations.
  Cross-machine origin metadata is SSH-asserted/unverified, not authenticated
  task authority. A CLI executed on a remote broker can ask locally there; that
  is a different integration, not proof of transparent cross-host ask. [I1]

## 2. Messenger: coordination versus Crew execution

### Coordination between existing visible agents

Messenger supplies a shared peer roster, DMs/broadcast, file reservations, task
claims/completions and an activity feed. Joining existing Herdr-hosted Pi sessions
can add coordination **without changing how those sessions execute**. Registry
and inboxes are shared local files; feed and Crew data are project-scoped. [M1]

Message delivery is event-oriented: the receiver watches its inbox with `fs.watch`,
debounces events, reads pending files and calls
`pi.sendMessage(..., {triggerTurn:true, deliverAs:"steer"})`. A daemon is not needed.
This is not an LLM loop repeatedly reading a worker pane. [M2, M3]

File reservations are useful collision avoidance. The inspected enforcement hook
covers Pi `edit` and `write`; it does **not** cover every mutation through Bash,
custom tools, another process or Git metadata. It is not filesystem isolation,
a security sandbox or a transaction spanning arbitrary tools. [M3]

Source-level delivery caution: `processAllPendingMessages` deletes a message file
after successful delivery and also in its read/parse/delivery-exception path to
avoid repeated failures. Sending writes JSON directly into the target inbox.
This does not establish reliable durable/exactly-once delivery under races/crashes.
Failure behavior deserves testing before using the mesh as an authoritative
acceptance/approval bus. It is a source observation, not a reproduced message-loss
incident. [M2]

### Crew is an independent, optional scheduler

Crew plans a task graph, runs workers in dependency waves, performs review/retry
cycles and offers autonomous work. Optional Team adds roles, charter, memory and
risk/approval gates. These may be valuable for a different workflow, but are not
required merely to let visible peers talk. [M1]

Crucially, its source launches its own processes:

```text
pi --mode json --no-session -p ...
stdio: ignore / pipe / pipe
```

That is **headless Crew execution**, not pi-subagents' Herdr placed-run backend.
A progress overlay shows activity, not the actual interactive agent TUI. Crew
therefore reintroduces the user's hidden-agent objection if adopted unchanged.
Team's use of pi-subagents role markdown is metadata reuse, not execution-engine
integration; pi-messenger does not require/call pi-subagents to run Crew. [M1, M4]

Avoid two planners/schedulers/task registries owning the same work. Use Messenger
coordination without Crew when that is all the workflow needs. Installing another
communication layer also needs a concrete benefit: two rosters/inboxes/message
paths are not automatically better than one.

## 3. pi-subagents: orchestration and actual execution remain distinct

Upstream already provides parallel/rolling workflows, result artifacts, native
run steering/interruption, `bg_wait` first/all/exact-run, retained-child control,
and completion notifications. These are genuine reuse opportunities, not missing
features that our extension must rebuild. [P2, P3]

PR #2194 makes **saved-machine placed runs** execute in fresh no-focus Herdr panes.
SSH carries bounded RPC/ownership checks instead of owning headless SSH execution.
However, omitted `machine` still selects the local child factory: ordinary local
foreground/detached children are not placed into their own Herdr agent panes.
A Herdr inspector is a dashboard, not a literal attach to the executing child.
A project-owned local Pi peer is a separate facility. [P1, P4]

Native placed Pi has framed acceptance/settlement/queue/reconnect evidence and
acknowledged logical tool ceilings/read resources. It explicitly rejects richer
local extension/environment/permission/budget contracts, file-backed fork/resume,
and nested routes/fanout children/depth >1. These restrictions matter for our
visible controller→worker teams. Ordinary Intercom peers can converse recursively
without this child bridge; guaranteed nested **execution** is a different issue.
[P1]

Placed external CLI profiles are one-shot/stop-only and always return bounded
sanitized `partial` / `[best-effort/unverified]` evidence. Native Pi is not subject
to that same output model. Native normal disposal retains the pane; abort-related
disposal closes it. Successful external settlement closes; timeout/uncertainty
retains. A surviving native pane does not prove a public later follow-up works
through a disposed bridge. [P1, P5, P6]

Public integration seams exist: process-local run RPC, structured delegation,
workflow resources, project-pane APIs, inspectors, display-only external runs,
background-work provider registration and required-child-extension contracts.
No documented pluggable **local visible execution factory** was established in
inspected exports. Internal source exports are not a supported library contract.
[P4, P7]

## 4. Posting instead of polling: what the pattern actually buys

The user's observation is substantively right: **let the worker publish an update
or result rather than repeatedly ask whether its pane finished.**

| Layer | How work becomes visible to the parent | Important distinction |
|---|---|---|
| Herdr peer prompt | Explicit agent prompt wakes an idle peer; bounded wait/inspection can observe its response | No broker required; busy wait may reflect an earlier turn, not a correlated task result |
| Intercom conversation | Socket/pipe message arrival; explicit send/reply; correlated ask result | A peer-authored report, not automatic completion detection |
| Messenger messaging | Inbox-file event → Pi steering message | File-watch notification, not pane polling; delivery failures remain possible |
| pi-subagents runs | Run-owned completion/result notifications; optional explicit bg_wait | The runtime knows its managed run, not arbitrary peer tasks |
| Herdr lifecycle/diagnostics | Typed agent/pane state, reads and process/lifecycle observations | Useful for crash/timeout/cleanup and literal console needs, not an answer oracle |

This reduces routine status/read tool calls and lets a parent return control while
work runs. Progress should be meaningful, not a stream of token-costly messages.
Messages can trigger model turns, so posting is not automatically zero-cost.

“No polling” is not literal at every layer. Intercom has a liveness heartbeat
(default 30 seconds), held-message/name maintenance and startup roster polling;
Messenger has status/watcher recovery bookkeeping. These infrastructure checks
are distinct from an LLM repeatedly polling task output. [I2–I4, M2, M3]

A blocked request can still form a dependency cycle: for example, parent waits on
an ask while worker asks that same parent for a decision. Do not assume automatic
steering can always interrupt a blocking tool safely. Prefer send/returned control
when no answer is needed now; bounded asks for real dependencies; verify supervisor
escalation while parent tools are active. Existing ask timeouts prevent claiming
an unbounded wait, but do not fix the task-level dependency cycle.

If notification is lost, recover from known session identity, existing task/report
artifacts and explicit runtime diagnostics. Do not invent a second persistent
scheduler merely to compensate for an untested messaging path.

## 5. Revised gap matrix

| Original need | Combined-stack assessment | Remaining substantive gap |
|---|---|---|
| Existing Pi buddy / cross-project Firstmate | **Substantially covered by Intercom** without pane ownership | Both must share compatible broker/scope; turn delivery and profile setup need live proof. No longer a blanket replacement blocker. |
| One-off question → answer in one result | Intercom ask/reply is a more direct semantic fit | Explicit reply required; not literal console output or task acceptance; one pending ask/session. |
| Completion/progress without repeated reads | Intercom peer reports, Messenger messages and upstream run notifications | Different owners/signals; broker restart, crashes and busy delivery need recovery checks. |
| R-1 visible local readonly/editable launch | Intercom opens real project Pi peers; upstream placed execution visible for saved machines | **Still decisive:** same-cwd multiple role-controlled workers, provider/profile/guard/extension contract and nested visibility are not established by plain project-peer launch. |
| R-2 return early or wait | Intercom send/ask; upstream async/results/bg_wait | Adaptation rather than a fundamental missing capability. Waiting on replies differs from waiting on terminal state. |
| R-3/4 pane console and wait+console | Messaging usually removes the conversational need | Keep diagnostics/literal console reads when needed; do not equate reply text or result reference with pane read. |
| R-5 raw text+Enter | Neither Pi messaging interface is raw terminal injection | Small lifecycle/terminal companion candidate, especially shells/non-Pi panes. |
| R-6 Escape | Upstream native run interrupt; broker messages can request actions | Explicit Escape to arbitrary existing pane and same-process survival remain separate capabilities. |
| R-7/8 pane/space inventory | Intercom roster includes fresh Herdr location; Messenger presence; upstream fleet | Connected-session rosters are not all panes/workspaces, including crashed/unregistered/shell panes. |
| R-9 explicit close + absence proof | Upstream project-pane close exists; backend disposal policies differ | Arbitrary-pane cleanup/verified absence and review-before-close remain physical lifecycle work. Messaging does not close a pane. |
| R-10 pane-ID footer | Peer location/status displays already help observability | Exact executing-pane footer not established; cheap UI need, not an execution-engine justification. |
| Multi-pane first/all | Managed-run bg_wait/workflows; explicit result messages | May become unnecessary for routine conversations. Fresh arbitrary pane-set races are still a distinct optional capability, not automatically supplied by messages. |
| Shared-file coordination | Messenger reservations/tasks/feed | Optional useful addition; edit/write conflict blocking is not whole-filesystem confinement. |
| Non-Pi peers / cross-host | Upstream placed external CLI support; Intercom cross-host send | Pi broker is not a Claude/Codex/shell control plane; native cross-host correlated ask/lifecycle remains unsupported. |

Our readonly guard is not a security sandbox either (`docs/security.md`). Do not
require replacement of an isolation guarantee we do not currently possess.

## 6. Sustainable options—not an install-all prescription

### A. Herdr as the single operational basis — current default

Keep visible workers, supported agent prompts, bounded waits/inspection and
explicit cleanup in one place. Collaboration conventions can specify roles,
task/report identity, parent decisions, progress and file ownership without owning
another scheduler. Files are usable only where worker policy permits; readonly
reports remain terminal-only in the current runtime.

This is the user-confirmed pragmatic and experimental baseline, not a claim that
every concurrency pattern is verified. Agent prompting an idle peer is a real push path, while terminal
state and sequence are not a correlated task answer. An important busy-parent
notification or decision request must not disappear or create a circular wait.
Do not bypass tool allowlists or guards to obtain a callback path.

Conceptually another multiplexer could supply the foundation, but cmux/orca
lifecycle, readiness, agent state, quoting and delivery semantics are unverified.
Keep collaboration intent separable from transport; do not build adapters now.

### B. Visible peers + Intercom — conditional addition

Use a broker only when direct correlated asks, busy delivery or routing solve a
concrete need more cleanly than the baseline. Intercom's source-level features
are meaningful, but integration/profile provisioning and failure behavior need
live verification. A broker's package count and terminal polling overhead alone
do not establish either option's total complexity. Preserve the visible execution
owner and explicit review-before-close regardless of messaging choice.

### C. pi-subagents execution + Intercom

Attractive where supported execution is visibly acceptable (currently principally
saved-machine placement) or a supported local visible route becomes available.
One owner handles run outputs/scheduling; Intercom handles real peer conversation
and explicit supervisor escalation. A slim terminal companion can cover physical
controls not expressed by run APIs. Default local upstream execution still keeps
the original hidden-child objection, so this is not an established all-local
replacement today.

### D. Add Messenger coordination selectively

Add shared-file reservation/task/feed capability only where it solves a concrete
coordination problem. It can support already-visible peers without Crew. Do not
combine Messenger Crew and pi-subagents schedulers accidentally. Messenger alone
can also be the chosen peer mesh when shared-task/broadcast coordination matters
more than correlated one-off asks; that choice should replace redundant messaging,
not automatically add another inbox and another authority path.

Option A is the user-confirmed direction. Options B–D remain research alternatives,
not adopted architecture. This discussion does not authorize installation,
configuration, new adapters, runtime changes, code retirement or implementation
of the broader deliberate-agent system.

## 7. Discussion and critique reconciliation

The initial secondmate review supported messaging-first composition. After the
user clarified the single-basis preference, a further independent secondmate
review supports Herdr-only as the conditional default, with Intercom deferred
until a concrete protocol limitation justifies it. That review correctly points
out that an idle-peer prompt already wakes the peer; “push requires a broker”
would be false. It does not prove busy delivery, readonly callback availability
or task-result correlation. No measured claim that these needs are rare, arbitrary
two/three-incident threshold, or universal transport portability is adopted.

A stronger strategic critique also supports the conditional default. Reject its
unsupported claims that Herdr lacks busy steering, that polling necessarily
chokes the multiplexer, or that tmux screen scraping/new verification code is
needed: absence of live proof is not proof of absence, and implementation remains
outside scope. Accepted concerns are busy-input safety, readonly reporting limits
and the stale canonical recommendation, addressed in the verdict/options above.

### Broader deliberate-agent context — peer discussion, 2026-10-03

The user requested discussion with that repository's Firstmate. Its source and
concept status are reported by the peer, not independently inspected here; no
commands or edits were performed against its repository. The peer owns any
changes there. Current pane handles are not future routing authority.

The peer reports the user direction as POCE/GENIETABLE above ACP/Pi execution,
with BEAM/OTP likely for longer-term orchestration; its substrate decision remains
formally open. Our agreed interpretation, not a new user ruling:

- Herdr is today's visible execution/control basis, **not the owner of the resident
  deliberation loop**. Artifact-owned questions, judgement, briefs and durable
  decisions belong above the executor layer. Our extension should not recreate
  POCE, GENIETABLE or a competing supervision/workflow engine.
- A long-lived visible colleague and a disposable task child are distinct executor
  contracts. Preserve the former's human accessibility when considering the
  latter. ACP is a protocol; hidden execution is a deployment choice, not an
  inherent ACP property.
- Terminal liveness cannot supply a task wait graph by itself. Dependency edges
  must be observable: who waits on whom, for which result or decision. OTP process
  supervision does not automatically resolve logical cycles, restore model context
  or make tasks idempotent. The peer accepted these corrections.
- A broker is not inherently a conflicting “second truth”: pane lifecycle and
  application delivery can have different owners. Textual request identity is
  expressible without it; safe receiving/routing while a parent blocks is a
  separate mechanical guarantee. No broker need is established for today.

Suggested conceptual next step: reconstruct one past collaboration round on paper,
listing each wait's sender, target, expected result/decision and where that edge
was observable (file, terminal or nowhere). Missing edges identify the actual
protocol/probe gap. This is **not** authorization for a runtime ledger, adapter,
new scheduler, live test or BEAM implementation. No replay has been done here.

### Earlier ecosystem corrections

Revisions from the earlier assessment:

- Existing connected Pi-peer conversation is covered by Intercom; do not demand
  arbitrary pane ownership-free prompt APIs to solve an already-solved conversation.
- First/all waiting, native interruption and project-pane close exist upstream;
  scopes differ, not universal absence. Remote native tool ceilings also exist.
- Multiple same-cwd peers can be targeted explicitly; controlled multi-worker
  **creation**, not basic messaging ambiguity, remains the unresolved launch need.
- Intercom supervisor bridging is specific to managed children; ordinary visible
  peers can coordinate without that bridge. It does not prove all nested workers
  are visibly launched or share the proper permissions/profile.
- Correlated replies and notifications replace conversational polling, not TUI,
  lifecycle, artifact correctness or confinement evidence.

Independent strategic critique usefully highlighted worker-owned completion and
broker/profile provisioning. Do not adopt its proposed terminal-screen completion
oracle or new task registry as a solution. Its inbox-deletion concern belongs to
**Messenger**, not Intercom; Intercom source instead shows correlated bounded
waiters. These distinctions prevent merging different reliability models into a
misleading single “push is reliable” claim.

## 8. What remains to establish before migration

Future live checks require separate authorization; none were performed here.

1. **Actual local worker execution:** multiple distinct same-cwd readonly/editable
   peers, correct tools/profile/model/provider/guards, startup/delivery and visible
   descendants. Account for all processes; a dashboard is not a worker TUI.
2. **Broker provisioning:** compatible Intercom loaded in every relevant peer;
   same runtime/broker/scope across profiles; exact stable targeting; reload/resume
   and process replacement do not misroute work or inherit mail unexpectedly.
3. **Message-to-result contract:** explicit completion owner and task correlation;
   idle/busy/compaction/human-first delivery; concurrent asks, bounded timeout,
   cancellation and ambiguous late replies; decision requests while parent awaits.
4. **Recovery:** broker crash/restart, sender/worker exit, notification loss and
   retained artifact inspection. Message injection and registry presence are not
   successful task completion. Test Messenger delivery exceptions if selected.
5. **Lifecycle:** request vs actual Escape, same-pane follow-up, review before
   cleanup, explicit close and verified absence; crash/unregistered/non-Pi panes.
6. **Supported ownership/integration:** one execution scheduler, public APIs,
   compatible Pi 1.0.0 / Herdr 0.9.3 and co-loading behavior, clear source/update
   authority. Peer version declarations and matching names are not live proof.
7. **Scope beyond local Pi:** decide whether raw/non-Pi/cross-host controls are
   still needed; do not promise transparent cross-host ask from v1 send support.
   SSH loopback is not an assumed fix for local execution/nesting restrictions.

Confidence: strong source-level picture; runtime parity, delivery under failure,
performance, co-loading and migration cost are **unverified**. This assessment
supports reconsideration and a smaller custom responsibility, not immediate
replacement or retaining our extension unchanged by default.

## Pinned source index

### pi-intercom — 924917f189f5cf5f55ec8bc5be21ded99d252200

- **I1:** [README](https://github.com/nicobailon/pi-intercom/blob/924917f189f5cf5f55ec8bc5be21ded99d252200/README.md): 25–27 broker; 146 busy delivery; 235–247 send/ask/reply/reliability; 278–303 supervisor; 374–424 tool contract; 484–486 scope/profile runtime; 587–599 cross-host; 627–652 broker/heartbeat.
- **I2:** [broker/client.ts](https://github.com/nicobailon/pi-intercom/blob/924917f189f5cf5f55ec8bc5be21ded99d252200/broker/client.ts): 45–145 liveness; socket data handler around 280; exact sends/receipts.
- **I3:** [index.ts](https://github.com/nicobailon/pi-intercom/blob/924917f189f5cf5f55ec8bc5be21ded99d252200/index.ts): 757–790 reply waiter; 1260–1375 triggering/held/busy/reply matching; 2670–2779 correlated ask/send/result.
- **I4:** [project-agent.ts](https://github.com/nicobailon/pi-intercom/blob/924917f189f5cf5f55ec8bc5be21ded99d252200/project-agent.ts): 183–219 targeting; 222–247 actual pane/Pi launch; 250–291 startup roster polling. [index.ts 1622–1644](https://github.com/nicobailon/pi-intercom/blob/924917f189f5cf5f55ec8bc5be21ded99d252200/index.ts#L1622-L1644): reuse/open/registration routing.

### pi-messenger — 09937ed647a1b07a3b595bf75943feacb80ff123

- **M1:** [README](https://github.com/nicobailon/pi-messenger/blob/09937ed647a1b07a3b595bf75943feacb80ff123/README.md): 41–73 coordination; 92–127 Crew; 157–184 Team/role-metadata distinction; 407–415 mechanics and storage.
- **M2:** [store.ts](https://github.com/nicobailon/pi-messenger/blob/09937ed647a1b07a3b595bf75943feacb80ff123/store.ts): 951–1007 delivery/deletion; 1010–1033 send; 1040–1089 filesystem watch/recovery.
- **M3:** [index.ts](https://github.com/nicobailon/pi-messenger/blob/09937ed647a1b07a3b595bf75943feacb80ff123/index.ts): 189–190 receive trigger; 323–348 status heartbeat; 1183–1205 reservation edit/write hook.
- **M4:** [crew/agents.ts 210–268](https://github.com/nicobailon/pi-messenger/blob/09937ed647a1b07a3b595bf75943feacb80ff123/crew/agents.ts#L210-L268): independent headless Pi execution, role/model/tools and piped stdio.

### pi-subagents — ad56bf92fe01a2a5abd962938c619eb2a22ca47d

- **P0:** [PR #2194](https://github.com/nicobailon/pi-subagents/pull/2194), [merge tree](https://github.com/nicobailon/pi-subagents/tree/77c3eed).
- **P1:** [herdr-placed-run.ts](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/runs/shared/herdr-placed-run.ts): 89–101 serialization/limits; 164–165 cleanup; 207–213 native evidence/disposal; 241–258 startup/tool acknowledgment; 261–262 machine routing.
- **P2:** [docs/tool-reference.md](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/docs/tool-reference.md): 9–66 workflows; 159–178 retained children; 287–378 run control/steer/resume; 468–480 project peers.
- **P3:** [wait-tool.ts 17–28](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/runs/background/wait-tool.ts#L17-L28): native completion notification vs first/all/id waits, deadlines and references.
- **P4:** [docs/extension-api.md 443–578](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/docs/extension-api.md#L443-L578): inspector/dashboard versus project-peer APIs and trust/idle close gates.
- **P5:** [docs/agents.md 251–272](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/docs/agents.md#L251-L272), [herdr-external-adapters.ts](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/runs/shared/herdr-external-adapters.ts): saved-machine and external partial/stop-only/retention semantics.
- **P6:** [subagent-runner.ts 876–909](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/runs/background/subagent-runner.ts#L876-L909): external timeout/uncertainty/cleanup.
- **P7:** [docs/extension-api.md](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/docs/extension-api.md), [package exports](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/package.json#L9-L25): public run/event/delegation/provider/resource APIs, observation-only Fleet jobs and module-resolution caveats.
