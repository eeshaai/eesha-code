# Requirements Document
Feature : <Feature Name>

<!-- The H1 is the literal words `# Requirements Document`, never the
feature's name: tools that read this file match that line exactly.

Your source is `idea.md` when the spec has one: what was asked and
where it came from. Read what it points at before you draft - every file
it lists (they sit in the spec folder), and any work item or issue it
names, through the MCP server for that provider, comments included. A
description alone means that is all there is: work from it and the
repository, and invent nothing. Do not re-open the ask: idea settled
what is being asked; carry its own open questions forward where they
still block, and add no scope because the ask left room for it. Idea's
`type` shapes the framing - a `bug` states the wrong behaviour and the
right one, a `feature` states capability the system should gain - but
the sections, numbering and EARS forms are the same either way. -->

> Standalone template - everything needed to draft and record these
> requirements is in this file.
- **Approved by (PO):** <name - filled at approval>
- **Approved (UTC):** <datetime - filled at approval>

## Introduction

A few sentences on the feature, its purpose, and the problem it solves -
not a design summary or a restatement of the requirements below.

## Glossary

Only where artifacts genuinely name one thing differently. One line
per term: "Customer (canonical) - the mock-ups say 'Client'; the DB
table is `account`." When a field this feature writes is also
written by other flows, say so - a reader must not assume it holds
only this feature's value. A multi-word term is written with
underscores - `Scheduled_Appointment` - and then written that way
everywhere in this document, criteria included, so a defined term is
one greppable token. Omit the section when there's nothing to
record.

## Personas

Only when an audience beyond the user stories' own roles needs
distinct verification - an integration caller that authenticates
differently, a participant who sees data a requirement exposes. One
line per persona: who they are and what makes their path different.
Omit when the user stories' roles cover everyone.

- **<Persona>** - <what makes their path distinct>

## Requirements

Each requirement is one clear capability, stated as the PO would state
it: a user story plus the complete acceptance criteria that verify it.
Group by what a reader verifies together, never by system or repo - a
requirement is an outcome, not a component's work list. Requirements
are not deployment units: no requirement here carries release
mechanics or dependency ordering. A requirement that documents
existing behavior for verification only says so in one italic line
under its heading - it implies no new build work, only tests. Each
requirement must read on its own, criteria written out in full - no
resolving other documents to know what to build.

A requirement is one thing a PO can approve or reject whole. Where its
criteria fall into groups that need their own headings or labels to
stay readable, the cut is wrong and those groups are separate
requirements - a label inside the criteria list is the signal, never
the remedy, because a reader signs the requirement and nobody scans
dozens of criteria for the one that is missing.

Three cases go missing by default, so state or consciously exclude each
one per requirement: the identifier that resolves to nothing; the
multi-item operation where one item fails and the others must still
succeed; and the dependency that is unreachable rather than merely
returning an error. Where one genuinely does not apply, say so in the
test notes - an absence nobody explains reads as an oversight, and
usually is one.

### Requirement 1: <Short title>

**User Story:** As a <role>, I want <capability>, so that <benefit>.

#### Acceptance Criteria

State WHAT the system observably does - HOW it's built and
tested (repos, endpoints, test levels) belongs to design.md. Write
every line in the product's language the PO can sign: a line that
needs a service name, endpoint, header, transaction, or storage type
is carrying a design fact - move the fact to design.md and restate the
line in product terms. Include
at least one criterion that exercises a real boundary (a persisted
save, a call across a service, a full user action), not just
logic/validation. State when the action must NOT apply - the entity
states or conditions under which nothing is recorded or changed.
Every surface the changed data reaches - reports, exports, emails,
templates/merge fields, APIs - appears in some criterion. Name the
concrete limit where one exists; a testable number beats an
abstraction. Persona- or flag-specific behavior is its own
criterion (the WHERE form) - for flag-gated work, state the flag-OFF
behavior ("as today") as a criterion too, in product terms, never
naming the flag key: the key and rollout mechanics are design's
Dec-<n>. An NFR measurable as a single trigger/response (e.g. a
response-time target) is a numbered criterion here; cross-cutting NFR
facts belong to design's Non-Functional Requirements section - never
a section here.

1. WHEN <trigger> THEN THE SYSTEM SHALL <behaviour>.
2. IF <error/edge condition> THEN THE SYSTEM SHALL <behaviour>.
3. WHERE <context/persona/configuration> THE SYSTEM SHALL
   <behaviour>.

**Test notes** (optional) - only when there's something real to say:
data or situations worth testing, anything only checkable by hand and
why, or a persona whose path needs separate verification.

### Requirement 2: <Short title>

**User Story:** As a <role>, I want <capability>, so that <benefit>.

#### Acceptance Criteria

1. WHEN <trigger> THEN THE SYSTEM SHALL <behaviour>.
2. WHEN <trigger> THEN THE SYSTEM SHALL <behaviour>.

## Out of Scope

Concrete exclusions a reviewer could otherwise reasonably assume were
in scope - a functional variant, persona, legacy surface, or
integration. Ground each in the inputs - the PRD, the code, an
answered question - don't invent them here. State permanent boundary or
deferred phase - never ambiguous - and the consequence the product
lives with (e.g. "no criterion can be written for it, so there is no
test for it either").

- **<Excluded item, e.g. "Portal v1">** - <why>. <Permanent, or
  "planned for a future phase - <link or 'not yet scheduled'>">.
  <The consequence the product lives with.>

## Open Questions

Questions raised while drafting these requirements. Name the
requirement a question blocks, if any.

- **QN-1** <question>

## Answered Questions

- **QN-<n>** <question>
  **A:** <the decision>
  **By:** <name> - <datetime UTC>

## Assumptions

What you decided for yourself and proceeded on - a guess, said so.
Surviving PO sign-off makes it approved. Omit when empty.

- <assumption> - **if false:** <what changes>

## Sign-off

- **Approved by (PO):** <name> - <UTC>
