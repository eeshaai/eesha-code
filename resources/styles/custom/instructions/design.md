# Design: <Feature Name>

<!-- Fill rules: cite acceptance criteria, never restate them. Omit anything the
repo can answer for itself (paths, signatures, field lists, payloads). A
decision nobody has made is an open question, not an omission. Target: 2 pages.

A requirement that cannot be satisfied as written is a blocker - raise it as an
open question, never design around it silently. A principles or standards file
attached to this phase wins over your own preferences. Research is context, not
an artifact: what you look up shapes the design and is cited inline next to the
decision it justifies - no `research.md`, no notes file; `code-findings.md` is the
only side file, and only for code facts.

Do not write this file until the pre-write gate is cleared: unknowns asked,
proposed deviations agreed. Silent assumptions are the failure mode, not slow
drafts. -->

**Requirements:** `requirements.md`

## Decisions Requiring Sign-off

<!-- The review. 3-7 decisions. Only decisions an architect could reasonably have
made differently. Driving factor precedence: NFR/steering > existing codebase
pattern > industry standard.

A feature shipping behind a flag records that as a Dec-<n> here, not in
requirements.md — a flag is a rollout mechanism, not behavior: record the key,
default state, and rollback. -->

### Dec-1: <short title>

- **Decision:** <one line>
- **Alternative rejected:** <one line>
- **Driving factor:** <NFR / pattern in `X` / standard>
- **Reversible after ship?:** <Yes / No — why>

## Proposed Deviations

<!-- Where the requested approach, or what the codebase does today, conflicts with
design standards or an NFR. Max 3, agreed with the requester before this file was
written. Cite the standard — a preference is not a deviation. Omit if none. -->

### Dev-1: <short title>

- **Proposal:** <one line>
- **Conflicts with:** <requested approach / existing pattern in `X`>
- **Standard/NFR cited:** <the standard or NFR>
- **Agreed?:** <Yes/No — by whom, when>

## Overview

<3-5 sentences: the approach, and which requirements it satisfies, cited as
[Requirements : 1, 2](requirements.md).>

**Non-goals:** <max 4 bullets. Adjacent work the implementer will be tempted to
pick up. Mark anything deferred-not-rejected and name the follow-up.>

## Non-Functional Requirements

<!-- One feature-specific fact per applicable category - performance, scale,
resilience/availability, security (including whether a security/threat review
is triggered), observability, cost, compatibility/legacy surfaces, operability,
code coverage, accessibility (any new UI surface), localization (translation
policy for changed strings), automation/test scope - never restated
methodology. Security, performance, and code coverage always get a line - no
feature is exempt from those three.

Every line traces to a source: an obligation the inputs state, or one a human
gives when asked. Part of the pre-write gate: ask - with your ask tool, in this
run - whether there are NFR obligations to add, inviting free-text; interpret
whatever comes back into the line shape below, write it here, and record it as
an answered question (who, when). A valid performance line is "no obligation
stated - none applies": never invent a target, bound, or measurement nobody
asked for. Consider the rest and omit any with nothing feature-specific to say.
How each obligation is met and verified belongs to the sections that follow -
this section records only the obligations. -->

- Security: <RBAC/tenant isolation/PII handling for this feature; any
  logging the criteria require masks personal data>
- Performance: <target, e.g. "p95 < 400ms at 200 concurrent requests" -
  or "no obligation stated - none applies">
- Code coverage: <delta vs. baseline for new/changed code>
- <other applicable category>: <the fact>

## Architecture

<Component diagram (`flowchart`), max 10 nodes: what is new, what is
modified, what is deliberately untouched.>

**Repo scope** — one line per repo, literal github name; state "single repo" if so:

- `<repo-name>` — <role in this feature>; <new module/service/package, or modified>

**Entry points:** <sync request / cron / queue consumer / user action — and what triggers it>

## Components and Interfaces

<!-- One entry per component this feature adds or changes. A component is a service,
module, handler, client, job or UI surface — not a file, and not a class list: the
file-level breakdown belongs to tasks.md. Keep the heading and write "no new
component — existing ones change internally only" where that is true. -->

- **`<component>`** in `<repo>` — <new or modified>; <the operation it exposes or
  the behaviour it gains, in one line>; <who calls it>

## Runtime Flow

<`sequenceDiagram` of the primary flow per entry point — who calls whom, in
what order, sync vs async — including the failure branch that matters. More
than one entry point with genuinely different flows: one `###` per flow,
one diagram each. Omit the section only when the flow is a single
in-process call the Architecture diagram already shows.>

## Data Models

<!-- Omit only for UI-only features. "No schema change" is itself a decision — say it.
Add an `erDiagram` of created/altered entities and their relationships — omit it
for no schema change or a single added column. -->

- **Entities:** <created vs. altered, by real schema names>
- **Nature of change:** <new fields, repurposed fields, new relationships, changed
  constraints. Name a field only where its semantics drive the design.>
- **Nullability/defaults:** <only where a wrong choice changes behavior for existing rows>
- **Access patterns:** <the queries this must serve, and any index the design depends on>
- **Retention/PII:** <what is personal or regulated, and what that implies>

## Migration

<!-- Keep the heading and write "none — no schema change" where that is true. -->

- **Migration:** <none / additive / requires backfill> 
- **Order:** <migrate-then-deploy
  or deploy-then-migrate>
- **Rollback:** <can this be reverted after ship; if not, why>

## Consistency & Concurrency

<!-- Usually the section that catches the real bug. Do not skip; say "N/A — single
in-process write, no concurrent callers" if that is true. -->

- **Transaction boundary:** <what is atomic; what can end up half-applied>
- **Invariants:** <what must always hold, and which component enforces it>
- **Shared predicates:** <every term this feature branches on - "onsite", "final",
  "in scope", "eligible" - written once as a single predicate, with every component
  that evaluates it and the fields each one needs to do so. Two components deciding
  the same term by different tests is the defect this bullet exists to catch, so
  list the evaluation sites even where they agree, and name any field a site cannot
  read yet. "N/A - this feature branches on no shared term" if so>
- **Concurrent callers:** <what happens on simultaneous or duplicate requests>
- **Idempotency & ordering:** <required or not; the key used; whether ordering matters>
- **Work outliving its trigger:** <every call left unawaited, backgrounded, or
  fire-and-forget: the mechanism that keeps it alive past the request that
  started it, and what it does not survive — "unawaited" is not a mechanism.
  "N/A — nothing is backgrounded" if so>

## Cross-Boundary Contracts

<!-- Another repo, external customer, published SDK/CLI, webhook, emitted event.
Keep the heading and write "no cross-boundary surface" if none. Two cases need it:
more than one Target Code Repo calling across a boundary between them; or one repo
exposing a public API an external customer integration calls directly, alongside or
instead of a UI. The second applies to single-repo features too. -->

### `<capability>`

- **Producer → consumer(s):** `<repo>` → `<repo>` / External customer integration
- **Operation:** <semantic, one line — "consumer submits a batch and polls for completion">
- **Compatibility:** <additive / breaking — versioning, deprecation window, who is
  notified. Breaking an external customer contract needs explicit architect sign-off.>
- **Auth:** <which principal, which mechanism, what the producer authorizes>
- **Failure semantics:** <retryable vs. terminal for the consumer>
- **Rollout order:** <which side ships first; behavior between the two deploys>
- **Naming mismatch:** <both real names in one line, if the requirements glossary flagged one>

## Security & Authorization

- **Who may act:** <roles, permissions, scopes>
- **Enforcement point:** <which component checks; whether existing enforcement is relied on>
- **Tenancy isolation:** <how cross-tenant/org/user access is prevented>
- **Sensitive data:** <logged, masked, encrypted, or deliberately not persisted>

## Performance & Scale

<!-- When Non-Functional Requirements states no performance obligation,
Constraint is "none applies" and the other two lines are omitted - never
invent a measurement (a p95 comparison, a load test) nobody asked for; an
invented verification is scope creep, not rigor. -->

- **Constraint:** <the number to design against, citing the NFR — or "none applies", and why>
- **Impact:** <expected load, payload size, or latency delta this change introduces>
- **Decision & verification:** <what the design does about it, and how that is proven>

## Error Handling

<`stateDiagram-v2` when the feature introduces or changes an entity's status
lifecycle — states and legal transitions. Omit when no lifecycle changes.>

- **Failure modes:** <what can fail, and what the user or calling system sees for each>
- **Detection & recovery:** <how it surfaces and how it is recovered; cite the
  error-related criteria, e.g. [Requirements : 2.3](requirements.md)>
- **Blast radius:** <what else degrades if this is wrong>

## Observability

- **Instrumentation:** <max 5 bullets — what must be logged, metered, or traced for this
  to be operable, and any alert the design assumes exists>

## Correctness Properties

<!-- The design's invariants as numbered properties - deduplication, ordering,
bounds, never-blocks guarantees - not restated criteria. An invariant stated in
prose elsewhere in this document moves here and is cited from there by its id.
A property holds across every valid execution: if you cannot write "for any", it
is an example, not a property - it belongs in Testing Strategy. Name no
property-testing framework and no iteration count; how a property is verified is
Testing Strategy's business. -->

### Property 1: <short descriptive name>

*For any* <universally quantified input>, THE <component> SHALL
<guaranteed outcome>, regardless of <what does not matter>.

**Validates: Requirements 1.2, 2.4**

## Testing Strategy

<!-- Every acceptance criterion gets exactly one primary level. Cite criteria as
link citations grouped by level - never restate their text. Give a reason only
where the choice isn't obvious; Manual always gets its reason. This section is
what QA's sign-off covers. -->

- **Unit:** [Requirements : 1.4, 1.6](requirements.md) — <the pure logic covered here>
- **Integration:** [Requirements : 1.9](requirements.md) — <the real boundaries
  covered here; name any test infrastructure that must be built first>
- **E2E/automation:** [Requirements : 1.5](requirements.md) — <the few journeys
  worth automating end to end - not a re-run of what lower levels cover>
- **Manual:** [Requirements : 3.6](requirements.md) — <always with the reason it
  cannot be automated>
- **Pyramid check:** <every requirement has at least one criterion above unit
  level - name any that doesn't and why that's acceptable>
- **Existing tests affected:** <tests this change breaks or supersedes, and the
  decision for each: update, migrate, or retire>
- **Hard to test:** <what, why, and how it will be handled>
- **Load/perf testing:** <approach, if there is a performance NFR — else omit>
- **Configuration variants:** <where behavior is driven by configuration rather
  than a name or a type, the configured variants to verify - including at least
  one that must not change - else omit>
- **Persona scenarios needing dedicated cases:** <cited as
  [Requirements : 2.3](requirements.md)>

## Glossary

<!-- One line per system or term this design names. Requirements only ever say
THE SYSTEM, so this is where a PO or QA reader learns what each name is. Plain
words, no architecture. -->

- **<System/term>** - <what it is, in one plain sentence>

## Open Questions

<!-- Say what a question blocks (a criterion citation or a Dec-<n>) in the
question line. "None." if none. -->

- **QN-1** <question - what it blocks, who decides>

## Answered Questions

- **QN-<n>** <question>
  **A:** <the decision>
  **By:** <name> - <datetime UTC>

## Assumptions

<!-- Anything the author had to assume to finish. Surviving sign-off = approved. -->

- <assumption> — **if false:** <what changes>

## Sign-off

<!-- All three required before tasks.md. -->

- **Developer (peer review):** <name> — <UTC>
- **Lead:** <name> — <UTC>
- **QA:** <name> — <UTC>