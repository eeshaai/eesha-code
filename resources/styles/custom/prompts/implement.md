# ${{ spec.stage }} for '${{ spec.name }}'

Spec folder: `${{ spec.dir }}`. This phase writes code, not a spec document. The work goes in the repository, where the design says it goes. You do not edit the plan: a task is ticked by calling the `task_done` tool with its id.

The grammar's scope rule - one document, no terminal commands - is for the phases that draft a document. It does not apply here: building, running tests and editing code are this phase's job.

**The repository is context too.** You are working in it - read the code these tasks touch, and follow the conventions it already sets, including any instructions file it carries near what you are changing (`CLAUDE.md`, `AGENTS.md`, or whatever this repository uses).

## Attached

Everything this phase was given. Other files may sit in the spec folder; nobody declared them for this phase.

- **how** - how to do this phase. Read it first.
${{ phase.documents }}
${{ phase.references }}

## Tasks to implement now

${{ phase.tasks }}

Exactly these, and nothing else. Each row is the task as the plan writes it - its `Files:`, its citations, its notes - and names the plan line it sits on, for anything around it. A row that names a wave was handed together with the other rows of that wave: the plan put them there because their `Files:` lines share no path, so they may be worked at the same time, the way **how** describes. Check that first - if two rows above share a path, work those two one after the other. Rows with no wave are worked one at a time, in this order.

## The ask

**Implement the tasks above.** For each one: build it, run its tests, call `task_done` with its id, then move on. A task you could not finish stays unticked - say what blocked you and stop there.

When you are done, end your reply with a `## Changed` section: one line per file you created or edited, repository-relative, in backticks, then one sentence on what a reviewer should look at first. The panel shows this reply, and that list is how a person sees what the wave touched without opening the chat.
