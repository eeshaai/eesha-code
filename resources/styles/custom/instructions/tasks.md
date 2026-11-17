# Implementation Plan: <Feature Name>

## How to cut tasks

Applied when writing this file; never copied into the generated
document.

Tasks implement the approved requirements, in requirement order,
using the design's decisions. Nothing is decided here: a task that needs a
decision the design doesn't carry is a design gap - raise it, never
invent it. When the spec has no `design.md` (a bug fix), derive the
breakdown from the requirements alone and cite only those.

Only work that satisfies a requirement belongs in the plan - no
"nice to have" tasks nobody asked for. Only coding work belongs in the
plan: every task must be completable by writing, changing or testing
code, or by opening a pull request. User acceptance testing, gathering
feedback, deploying to an environment, collecting metrics, walking the
application by hand, training, user documentation and business process
changes are not tasks, however much the feature needs them - a plan that
carries one has a checkbox no agent can ever tick, and the ticked
checkbox is the only completion signal this pipeline has. Work that is
genuinely skippable is marked optional (`- [ ]* N.M`) and `## Notes`
says what skipping it costs.

Every task leaves the system runnable and testable: the build compiles,
every existing test still passes, and the behavior the task adds is
exercised by a test in the same task - tests travel with the code they
verify, never in a later task. Work in vertical increments behind the
flag: at any stopping point between tasks, flag-off behavior is exactly
today's, and a half-wired path is unreachable rather than broken. A
task that changes a contract updates every caller of that contract in
the same task.

A task is one sitting of work with one concern - a task that cannot
end green in one sitting is split before this file is signed,
scaffolding and test-infrastructure work included. Its detail lines
locate work by code anchor - repo, path from that repo's root, and the
symbol, key, or string inside the file - never by line number: position
rots between writing and execution, names survive edits, and an anchor
that no longer exists at execution time is a staleness signal to
re-check the design, never a licence to guess. A codebase fact a task
relies on - a cache, a constraint, an existing converter - cites the
design decision, or the `code-findings.md` line, that established it;
folklore doesn't ship. A task that says *every*, *all*, or *each* of a set of call
sites, endpoints, keys, or strings names the set in full and states how
many there are; the set comes from a search run while writing the task,
never from recall and never from a prose summary in an earlier document
- a summary naming three of something is a claim to re-run, not a list
to copy. A question
answered or an assumption made while cutting tasks is recorded in this
document, in the grammar's question and assumption sections - the
conversation does not survive, the document must; assumptions already
recorded in earlier documents are read from there, never restated
here. The second to last
detail line is `Files:` - the paths the task creates or edits, from the
design and from reading the code, written down rather than worked out
in your head, because the wave graph is built from it and the engine
reads it before letting two tasks run at once. A task no agent should
do - update an environment, create a branch, get a review - carries a
`Run:` detail line after `Files:` saying who does it instead: `by hand`,
one command in backticks, or a workflow's name with its params; the
grammar has the exact shapes, and a task that changes code never has
one. The last detail
line cites the criteria the task implements and the design ids it
follows. A group is one requirement, in the requirements' order.

On a revise, work already done that is no longer wanted gets a
compensating task - if 3.1 added `ISomething` and it is no longer
required, the task is "Remove `ISomething` and its implementations".
Never assume version control will revert anything.

Three closing groups follow the requirement groups, in this order. Verification
runs lint, build, and the test suites per repo and records real
outcomes; every suite it names is read from that repo's own solution or
project files rather than recalled, because a verification step that
names a project which does not exist fails on the first run; anything
unrunnable in the current environment is flagged for CI by name, never
assumed green. Documentation updates what this feature
actually changed and nothing else - a repo with nothing to update
records the reason, and a steering or team-doc addition is proposed with
its target file confirmed by a human before anything is written. Pull
requests open one per repo touched, each carrying the verification
outcomes recorded above, the flag key and its rollback, and anything
still blocked - opened for review, never merged. Rollout order is
expressed inside a group's task ordering and the wave graph, never by
reordering groups - the deploy sequence itself lives in design's
Cross-Boundary Contracts.

Where two parts of the work truly do not need each other - a backend
change and a UI change that meet only at the end, say - give their
waves an `after` list so they become two branches that two developers
can start at the same time, and let the wave that joins them wait for
both. The grammar has the shape. Where you are not sure, leave `after`
out: one wave after another is always safe.

**Before you stop, call the `check_plan` tool.** It reads the file you
wrote the way the implement phase will and lists every problem by
line - a row it cannot read, a task in no wave, two tasks of one wave
on the same file. Fix each one in the file and call it again, until it
reports no problems. A problem left in the plan is a task nobody will
run.

## Shape

One group per requirement, hierarchical dialect, `## Task Dependency Graph`
at the end - the grammar file owns all three shapes. The generated
document carries the headings below, in this order.

## Overview

<two or three sentences: the order the work is built in and why that
order, and anything a reader needs before the first task>

## Tasks

- [ ] 1. <Requirement 1 title>
  - [ ] 1.1 <task - one concern, ends green>
    - <implementation detail, located by code anchor>
    - [Design : Dec-1](design.md)
    - Files: `<repo-relative path>`, `<repo-relative path>`
    - _Requirements: 1.1, 1.2_
  - [ ] 1.2 <task>
    - <implementation detail, located by code anchor>
    - Files: `<repo-relative path>`
    - _Requirements: 1.5_

- [ ] 2. <Requirement 2 title>
  - [ ] 2.1 <task>
    - <implementation detail, located by code anchor>
    - [Design : Dec-6](design.md)
    - Files: `<repo-relative path>`
    - _Requirements: 3.1_

- [ ] 3. Verification
  - [ ] 3.1 <one task per repo touched: lint, build, unit and
    integration suites - the recorded result, pass or fail, per suite>

- [ ] 4. Documentation
  - [ ] 4.1 <one task per repo whose documented behavior changed - what
    to update, or the reason it needs nothing>
  - [ ] 4.2 <the steering or team-doc addition this feature earned,
    target file confirmed with a human first - or the reason there is
    none>

- [ ] 5. Pull requests
  - [ ] 5.1 <one task per repo touched: branch, the repo's own PR
    template, the recorded verification outcomes, the flag key and its
    rollback - opened for review, never merged>

## Notes

- <what holds across groups rather than inside one task: ordering that
  is load-bearing, anything optional and why, a convention every task
  follows>

## Sign-off

- **Lead:** <name> - <UTC>
