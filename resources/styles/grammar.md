# How to write a spec document

Write every spec document to the shapes below. Eesha Code reads
these shapes to give the reviewer an outline, linked requirement
citations, highlighted acceptance criteria, and a task list it can run.

Your phase prompt says *what* to write - which sections, and what goes
in them. This file says *how* to write it. Where the two disagree about
the shape of a line, follow this file.

---

## 1. Headings

- One `#` H1, the first line of the file (after frontmatter, where a
  document has any).
- `##` H2 for every section.
- `###` H3 for numbered items inside a section - a requirement, a
  component, a property.
- `####` H4 for `#### Acceptance Criteria`.

Put a space after the hashes on every heading. Headings inside a fenced
code block are ignored, so an example in a fence is safe.

## 2. Requirements and acceptance criteria

```markdown
### Requirement 3: Retry on timeout

**User Story:** As a (role), I want (capability), so that (benefit).

#### Acceptance Criteria

1. WHEN (trigger) THEN THE (component) SHALL (behaviour).
2. IF (condition) THEN THE (component) SHALL (behaviour).
```

- The heading carries a word followed by a number, then a colon and a
  short title. Number from 1. The word is `Requirement`, unless your
  prompt told you a `prefix:` for this phase - a stage whose `style.yml`
  names one is told so directly ("this phase's own numbered items are
  cited `Req-<n>`"), and that word replaces `Requirement` everywhere
  below: `### Req-3: Retry on timeout`.
- Put a literal `#### Acceptance Criteria` line above every criteria
  list. Nothing else on that line.
- Criteria are a numbered list directly beneath it: `1. `, `2. `.
- **A criterion's id is the requirement's id, a dot, then its own
  number** - `3.2` is requirement 3, criterion 2; with a declared prefix,
  `Req-3.2` is `Req-3`, criterion 2. Only the requirement half ever
  carries the word - a criterion is always a plain number. This is the
  id every other document cites.
- Keep the numbers you wrote. The number as written is the id.

**A document may declare ids of its own.** A gap analysis numbering
`GAP-1..GAP-11`, an ADR numbering `ADR-3` - put the id first in its own
heading, `### GAP-11: A renumbered requirement is silent`, and it
becomes citable like anything else. A stage with no `prefix:` follows
this rule for its requirements too - it is the same mechanism,
`Requirement` is only its default word.

Eight rules go with that, and they are the whole of it:

- **At least two letters before the number.** `FT-1`, `GAP-11`,
  `ADR-3` - never `F-1`, `G11`, `D3`. One letter does not tell a reader
  what the id points at.
- **An id of your own has no criteria under it.** `### FT-1: Login`
  declares `FT-1` and nothing more. A numbered list beneath it does not
  become `FT-1.1`, `FT-1.2` - those ids do not exist, and every citation
  of them reads as stale. Only a requirement heading (`Requirement 3`,
  or this phase's `prefix:` word) numbers its criteria. If an item needs
  parts that can be cited, give each part its own id at the start of its
  line: `- **FT-1.2**: WHEN ... THEN ...`.
- **One item per heading.** Two gaps are two headings, however closely
  they are related.
- **One id per heading, and it comes first.** `### GAP-7 + GAP-8 (QN-7, QN-8)`
  declares `GAP-7` and nothing else, so every citation of `GAP-8` reads
  as stale - the document is accused of drift it does not have.
- **Nothing before the id.** `### Gap GAP-7` and `### Feature flag (GAP-7)`
  declare nothing at all.
- **Unique per document.** One run of numbers per document - a second
  `GAP-7` is not a new item, it is the same id written twice.
- **Permanent.** A number is assigned once, in the order raised, and is
  never renumbered, reused, re-prefixed, or slotted in later. An item
  that is answered, retracted, or superseded keeps its number and its
  place - §9 says the same thing about a whole document; this is that
  rule holding for one item.
- **One token, everywhere.** Never write an id two ways. `GAP-7` and
  `Gap 7` are not the same citation, even inside the same document -
  pick the spelling and keep it.

Give an item that genuinely spans two concerns one id and say so in its
body. An id is a name for one thing; a heading that needs two names is
two items.

## 3. Citations between documents

A citation is an ordinary markdown link:

```markdown
    - [Requirements : 1.2, 3.1](requirements.md)
    - [Requirements : Req-1.2, Req-3.1](requirements.md)
    [checkout-prd : 3.2](../../docs/product/checkout-prd.md)
```

Write it exactly like this:

1. **A plain link.** No other syntax, and nothing to learn - a reader on
   GitHub gets a link that works.
2. **The path is relative to the file you are writing.** A document in
   the same spec folder is just `requirements.md`; a file elsewhere in
   the repository is `../../docs/product/checkout-prd.md`. Count the
   `../` from the folder your own document sits in.
3. **The target is a `.md` file.** Nothing else is a citation. A ticket,
   a wiki page or a PDF is worth linking to as ordinary prose, but it is
   not this.
4. **Nothing after `.md`** - no `#heading`, no line number. The ids in
   the brackets say where to land.
5. **Inside the brackets: a name, a space, a colon, then the ids**,
   separated by commas.
6. **The ids are the target document's own.** A requirements document
   with no declared prefix numbers `1` and `1.2`, so cite those; one
   with `prefix: Req` numbers `Req-1` and `Req-1.2` - cite the id whole,
   word and number together. A document that numbers itself some other
   way is cited that way too - `GAP-11` for the eleventh gap in a gap
   analysis, `FR-1` for a functional requirement. Copy the id as that
   document writes it; never translate it into a number, and never drop
   its word.
7. **The name** is the phase's label where you are citing a phase of
   this spec, and the file name without `.md` where you are citing
   anything else.
8. **Two lines are spelled differently, and only these two:** the
   `**Validates: …**` line of a correctness property in `design.md`
   (section 5) and the `_Requirements: …_` line of a task in `tasks.md`
   (section 6). Everywhere else, the link form above.

Cite only ids that exist in the target document.

**Point at the id, not at the position.** Prose refers to an item by its
id, never by "the entry above" or "see below" - a reorder or an insert
breaks a positional reference silently, and an id survives one by
construction.

**Cite backwards, never forwards.** Inside the spec you may cite any
document written before yours, and your own. A document a later phase
has not written yet cannot be cited - there is nothing there to point
at. A file outside the spec has no order, so it may be cited from
anywhere.

### Where a citation goes

- `tasks.md`: the **last detail line** of every task that implements
  behaviour, in italics: `_Requirements: 1.2, 3.1_`.
- `design.md`: the last line of every correctness property, in bold:
  `**Validates: Requirements 1.2, 2.4**`.

```markdown
    - _Requirements: 1.2, 3.1_

**Validates: Requirements 1.2, 2.4**
```

### Citing something outside the spec

A requirement that exists because of a PRD, or a design that follows an
ADR, cites it the same way - the only difference is the path:

```markdown
Traces to [checkout-prd : 3.2](../../docs/product/checkout-prd.md).
```

The numbers still mean requirement and criterion, so they only resolve
if that document numbers the way section 2 describes. When it does not,
write the citation anyway and say in prose what it refers to. A document
nobody can number is still worth pointing at.

### Pointing at code

A pointer at repository code is not a citation - a citation lands on an
id in a `.md` file, an anchor lands on a place in a codebase. Write an
anchor as the repo folder name, then the path from that repo's root,
then the symbol, key, or string inside the file:

```markdown
    - `<repo-folder>/<path from that repo's root>`, `<symbol or string>`
```

A long path stays on one line. It is an address, not prose - never
shortened, never elided to `.../`, never wrapped.

- **Whole path, from the repo root.** Never a fragment, never relative
  to a subfolder you happened to be standing in. `src/Auth/...` and
  `services/api/src/Auth/...` are not the same claim, and the shorter
  one resolves to nothing.
- **Never a line number.** Position rots between writing and execution;
  a name survives an edit.
- **Confirm both halves before writing the line.** The file exists at
  that path, *and* it contains the symbol named. A file that exists but
  does not carry the symbol is not the anchor - it is the wrong file,
  and a path-only check passes it every time.
- **A folder is an anchor too.** A test project, a source folder, a
  spec area - it carries no symbol, so the path is the whole of the
  claim and the path alone is what gets resolved. `test` and `tests`
  differ by one character and one of them is a directory that does not
  exist.
- **A build target named in prose is an anchor.** A solution, project,
  test project or suite named anywhere - a verification step included -
  is read from the repository's own project files, never recalled. A
  command that names a project nobody opened fails on the first run,
  which is the worst place to find out.
- **A count is an anchor.** Seventeen folders, eleven methods, thirty
  locales - derive it by listing them as the line is written. Where a
  count is corrected anywhere in this spec, every number derived from
  it is recomputed, not carried: a total that moves by one moves every
  arithmetic built on it.
- **Re-confirm an anchor taken from an earlier document.** A path read
  from `code-findings.md` or from a prior phase is a lead, not a
  warrant. One wrong path recorded early otherwise reaches every later
  phase unchallenged.
- **One anchor names one place.** A line that needs two files is two
  lines.

## 4. Acceptance criteria are written in EARS

Five forms, and no others:

| Form | Use it for |
|---|---|
| `WHEN (trigger) THEN THE (component) SHALL (behaviour).` | An event. |
| `IF (condition) THEN THE (component) SHALL (behaviour).` | A state that may or may not hold. |
| `WHERE (context) THE (component) SHALL (behaviour).` | A feature or configuration only sometimes present. |
| `WHILE (state) THE (component) SHALL (behaviour).` | The whole duration of a state. |
| `THE (component) SHALL (behaviour).` | An invariant, with no trigger. |

- Keywords are UPPERCASE: `WHEN`, `IF`, `WHILE`, `WHERE`, `THEN THE`,
  `THE`, `SHALL`, `SHALL NOT`.
- `SHALL` for an obligation, `SHALL NOT` for a prohibition. Not
  "should", "must" or "will".
- One criterion, one behaviour. Two `SHALL`s joined by "and" are two
  criteria.
- Name the actor at the level the phase works at: a requirements
  document writes `THE SYSTEM` - which component is responsible is
  design's decision; a design-level criterion names the component.

## 5. Correctness properties

```markdown
### Property 1: (short descriptive name)

*For any* (universally quantified input), THE (component) SHALL
(guaranteed outcome), regardless of (what does not matter).

**Validates: Requirements 1.2, 3.1**
```

- Number properties from 1.
- The `**Validates: Requirements 1.2, 3.1**` line is the last line of
  the property. One bold run: the word `Validates`, a colon, the word
  `Requirements`, then the ids separated by commas. No link - this is
  one of the two exceptions section 3 names.
- Every acceptance criterion should be named by at least one property.

## 6. The plan

Pick the dialect your style uses and keep to it. The spacing is exact.

### Hierarchical

```markdown
- [ ] 1. Group title
  - [ ] 1.1 An actionable, single-concern task
    - an implementation detail
    - Files: `src/thing/index.ts`, `src/thing/__tests__/index.test.ts`
    - _Requirements: 1.2, 3.1_
```

- Top level: `- [ ] N. Title` - dash, space, `[`, space, `]`, space,
  number, period, space, title.
- Sub-task: two spaces per level, then `- [ ] N.M Title`. No period
  after `N.M`. Nest as deep as the work needs - `1.1.1` under `1.1`,
  four spaces in - but no deeper than it needs: a level exists to hold
  several tasks, never one.
- A task with tasks under it is a **group**: a heading for them, not
  work of its own. A task with none is a **unit of work** - what an
  agent is handed. Depth decides nothing; what sits under a row does.
- Optional task: `- [ ]* N.M Title` - asterisk straight after the
  closing bracket, no space.
- Done is `- [x]`.
- Detail lines are four spaces, then `- `, then the text. Details never
  carry a checkbox.
- **Every unit of work names the files it touches** on one detail line:
  `- Files: ` then the paths in backticks, comma-separated, relative to
  the repository root. Second to last, just above the citation. Files it
  creates and files it edits alike; a task that touches none says
  `- Files: none`. The wave graph is built from this line, and the
  engine reads it before it lets two tasks run at once - a plan without
  it gets no safety check at all.
- **A task a person or a workflow does, not an agent, says so** on one
  more detail line, `- Run: `, straight after `Files:`. Three shapes and
  no other:
  `- Run: by hand` - a person does it and ticks the box.
  ``- Run: `git switch -c feature/4711` `` - one command in backticks; the
  panel runs it in the machine's default shell.
  `- Run: story-start story=4711` - a workflow under
  `.eesha/workflows/` by its file name without the file extension,
  then `key=value` pairs for its params, quoted when a value has spaces.
  Write `Run:` only for steps no agent should do - an environment to
  update, a branch to create, a review to get. Never on a task that
  changes code. A task with a `Run:` line is never handed to an agent,
  and its box is ticked by the person who did it.
- Give every task a unique id, and give every dotted id its parent -
  `1.2.3` needs a `1.2`, which needs a `1`.

### Flat

```markdown
## Phase 1: Setup

- [ ] T001 Add the module skeleton in `src/thing/index.ts`
- [ ] T002 [P] Add the config type in `src/thing/config.ts`
```

- `- [ ] T### Title`. Number from `T001` upward across the whole file;
  never restart per phase.
- `[P]` straight after the id marks a task that may run beside the other
  `[P]` tasks in its `##` phase. Mark it only where the task touches
  files no other `[P]` task in that phase touches.
- Group the work under `##` phase headings.
- Name the files a task touches, in backticks.

### The wave graph - hierarchical plans

End the file with a `## Task Dependency Graph` heading and one fenced
`json` block under it. Write the heading exactly - it is how the graph
is found:

```markdown
## Task Dependency Graph
```

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3"] },
    { "id": 1, "tasks": ["1.2", "3.1"] }
  ]
}
```

- `waves` is ordered, and each `id` is a number counting from 0.
  Tasks inside one wave run at the same time. By default waves run one
  after another: a wave starts only when every task of the wave before
  it is ticked.
- A wave may say which waves it waits for with `after`, a list of wave
  ids: `{ "id": 3, "tasks": ["4.1"], "after": [1] }` waits only for
  wave 1, not for wave 2. `"after": []` waits for nothing - a starting
  point. Two waves that do not wait for each other are branches: two
  people can work them at the same time, on the same git branch, from
  two laptops. Leave `after` out and the wave waits for the wave before
  it.
- `after` names only waves with a smaller id.
- Use `after` only when the work really does not need the waves you
  leave out - no code, type, table or contract from them. When in
  doubt, leave `after` out. Two branches whose tasks name the same path
  on their `Files:` lines will both edit that file; the panel warns, and
  the two people merge it by hand.
- Close the fence on a line of its own, with nothing after the
  backticks.
- Put every unit of work in exactly one wave. Groups go in none.
- Ids match the checkbox list exactly.
- A task goes in a later wave than another task only when it needs that
  task's work first - code it calls, a type it uses, a table it reads, a
  contract it consumes. Otherwise put it in the earliest wave it can go
  in. Work in different repositories that does not need each other
  shares a wave, so it runs at the same time instead of waiting.
- Two tasks share a wave only when their `Files:` lines have no path in
  common. When you cannot tell what a task touches, say so on its
  `Files:` line as best you can and give it its own wave.
- A task that commits, pushes or tags in git gets a wave of its own,
  with no other task in it. It saves the work of the waves before it,
  and a person often wants to run up to the commit and stop there -
  any other task beside it would be started with it.

## 7. Frontmatter

Write none. Where a document already has frontmatter, leave it as it is.

## 8. Diagrams

Fence a diagram as `mermaid`. Use `flowchart`, `sequenceDiagram`,
`stateDiagram-v2` or `erDiagram`. One diagram per section, around ten
nodes. `<br/>` for a line break inside a label.

A diagram that does not parse is worse than no diagram - the reader
gets an error box where the explanation should be. Every rule below is
a construct that breaks, or silently corrupts, a real renderer.

**Quote by diagram, never by habit.** Quoting is syntax in some places
and literal text in others, so one blanket rule cannot be right.

Quote here - the quotes are syntax and never reach the reader:

- flowchart node labels: `A["Caller runs greet.ps1"]`. Always, even
  when the text looks harmless - an unquoted `(` on its own is a parse
  error.
- flowchart edge labels: `B -->|"no"| C`.
- `stateDiagram-v2` state names: `state "In Progress" as ip`.
- `erDiagram` relationship labels and attribute comments:
  `ATTEMPT ||--o{ RESULT : "produces"`. Unquoted, such a label breaks on
  the first word the parser reserves - `to`, `one` and `many` are the
  ones that catch real sentences - so quote it every time.

Never quote here - the quotes are literal, and render as visible `"`
marks around the text:

- `sequenceDiagram` message text: `L->>P: Action outcome`, never
  `L->>P: "Action outcome"`.
- `sequenceDiagram` participant aliases: `participant L as lobby-service`.
- `sequenceDiagram` block labels: `alt capture fails`, and the same for
  `else`, `loop` and `opt`.
- `stateDiagram-v2` transition labels: `A --> B : starts now`.

**Two characters break `sequenceDiagram` text, and quoting stops
neither.** Both apply to message text, to `alt`/`else`/`loop`/`opt`
labels, and to `Note` lines:

- `;` ends the statement. What follows is parsed as a new one, and the
  diagram dies with `Expecting 'SOLID_ARROW' ... got 'NEWLINE'`. This
  is the house prose style walking into a diagram: the semicolon that
  joins two clauses everywhere else is a terminator here. Write a
  comma, an em dash, or a second message.
- `#` swallows the rest of the line. No error and no warning - the text
  after it simply never renders. Write the word instead of the symbol.

**Ids are not labels.**

- Node and state ids are short, alphanumeric and capitalised; the words
  go in the label.
- No hyphen in a `stateDiagram-v2` state id - `in_progress` parses,
  `in-progress` does not.
- Never a lowercase reserved word as a flowchart node id: `end`,
  `graph`, `class`, `style` and `subgraph` all fail. Capitalising is
  enough to make one safe - `End` parses.

**Inside a quoted label, use single quotes:**
`D["Write-Host 'Hello'"]`. A nested `"` is swallowed along with the
text it was meant to mark.

## 9. Revising a document

Requirement numbers, criterion numbers, property numbers, question ids
and task ids are what other documents cite.

- Keep the numbering. Add new requirements and new tasks at the end.
- Give a question an id once. Never reuse it, never renumber it, and
  keep it when the question moves from `## Open Questions` to
  `## Answered Questions`.
- Say in its body when a requirement is dead, and leave the gap.
- Improve titles freely - they are for readers.
- Keep the text and the id of a task that is still valid, so its tick
  survives.
- Give work that was done and is no longer wanted a compensating task.
- Rebuild the wave graph whenever the task list changes.

**Leave untouched lines untouched.** A reviewer's margin notes are
re-found by the text of the line they were written against, so rewording
a line nobody asked you to change loses the note attached to it. Change
the lines the pass is about and let the rest stand, word for word.

## 10. Questions and assumptions

Three sections, and where each one goes:

- `## Open Questions` - at the end, directly above
  `## Answered Questions`. Questions with no answer yet.
- `## Answered Questions` - next, beside `## Assumptions`. The same
  questions once someone has answered them.
- `## Assumptions` - last. What you decided for yourself and proceeded
  on.

An assumption is you guessing and saying so. An answered question is a
person deciding. They are not the same thing and they do not share a
section.

### Writing a question

One list item, a bold id, one clear question - never a table:

```markdown
## Open Questions

- **QN-1** Do we keep the device-code flow or the browser flow?
- **QN-2** Is the retry budget per request or per session?
```

Ids are `QN-1`, `QN-2` and so on, one run of numbers per document.
Never the one-letter `Q1` - §2 asks for two letters in every id. §9 says
they are allocated once and never renumbered. A question belongs to the
document that raised it: it is answered there, and no other document
renumbers or restates it.

Four rules go with that, and they are the whole of it:

- **One decision per question.** A question that takes two answers is
  two questions, however closely they are related - "what is the
  performance target, what authorizes the caller, and what do we log?"
  is three questions wearing one id. A compound question gets a partial
  answer, and the unanswered half is then invisible: the question has
  an `A:` line, so it counts as answered and stops blocking. §2 says
  the same thing about an item and its heading; this is that rule
  holding for a question.
- **Self-contained.** The question carries what its owner needs to
  decide it - what is true today, and what the decision changes. One
  that only makes sense beside the paragraph it was raised from cannot
  be answered anywhere else, and it is asked somewhere else by
  construction.
- **Name the real choice.** Write out the alternatives you can see and
  what each one costs. An open "what should we do here?" hands the
  thinking back to the person who asked you to do it. §10's asking
  rules still hold - the options are a shortcut to an answer, never a
  closed list.
- **Ask it in the phase that owns the decision.** A question this
  phase cannot act on is not this phase's question. Asked early it
  gets an answer to something adjacent - the person answers what they
  were shown, the phase that actually needs the decision asks again
  properly, and two answers to near-identical questions now sit in
  the record.

### An answer is an `A:` line

An answer goes on the next line, indented under its question. Who
decided and when (UTC) is a `**By:**` line of its own, directly under
the answer:

```markdown
- **QN-2** Is the retry budget per request or per session?
  **A:** Per session.
  **By:** R. Vos - 2026-03-04 09:12 UTC
```

A question with an `A:` line is answered. A question without one is not.
That is the whole test, and other things read it. `**A:**` is reserved
for answers: never start any other line with `**A:**`, anywhere in a
spec document.

### The decision cache

`decisions.md` in the spec folder preserves a person's answers when a
phase document is regenerated. It contains only question-and-answer
pairs, one current pair for each decision:

```markdown
- **Q:** Is the retry budget per request or per session?
  **A:** Per session.
```

Before asking a person, check it for the same question and reuse its
answer. When a person changes an answer, update that pair instead of
adding another. A person may edit or delete any pair directly; the file
is its current source of truth. Do not add ids, names, timestamps,
sign-offs, or commentary.

### Moving an answered question

When you next work on a document, move every question that has an `A:`
line out of `## Open Questions` and into `## Answered Questions`, id and
answer intact. Delete `## Open Questions` when nothing is left in it.

Never delete a question. Never delete an answer. They are the record of
what was decided and why the document says what it says.

### When to ask at all

Every question shown to a person has this by default:

- A **Keep open** choice, marked as the default. Choosing it records no
  answer: put or leave the question under `## Open Questions` and stop
  that phase at its gate.

Never make a choice compulsory when asking a person. A proposed option
may make answering quicker, but it is never the only valid answer.

In order:

1. **Can the code answer it?** Read the code. Do not ask.
2. **Is it about intent** - what this person wants, which of two ways
  they would rather have - ? **Ask now**, with your ask tool. Offer
  **Keep open** as the default and free-text input alongside any
  proposed options so that user can type the answer when he/she cannot select the options you provide.
3. **If they keep it open or do not answer**, write it under
  `## Open Questions`.

The split is what kind of question it is. Code tells you what exists. It
never tells you what someone wants.

A question you never asked is worse than a question you asked. And an
open question stops the next phase, so leave one behind only when you
truly could not get it answered.

## 11. Sign-offs

A sign-off is recorded only from explicit confirmation in
conversation - never on someone's behalf, never assumed, never
pre-filled. The line carries the name and the UTC datetime of that
confirmation:

```markdown
- **Approved by (PO):** R. Vos - 2026-03-04 09:12 UTC
```

Which roles sign which document is each phase's own rule; the shape
and the integrity rule are the same everywhere. Every timestamp in a
spec document - a sign-off, an answer, a stale stamp - is UTC, fetched
at the actual moment it is written, never guessed.

## 12. Hygiene

- UTF-8. LF or CRLF.
- No trailing whitespace.
- One blank line between sections.
- Pure markdown - no raw HTML.
- Tag every fenced code block with its language.
- Give every table its separator row: `|---|---|`.
- A template's instructional prose, writer checklists, and
  `<angle bracket>` fill slots never appear in output - generated
  documents contain content only.
- The document is the deliverable.

## 13. Scope: one document, nothing else

A phase that drafts a document writes exactly one file: the document
your prompt names, at the path it gives. Do not create or edit any
other file, and do not run terminal commands. Read-only tools are fine
at any time.

Reading the repository is part of every phase that the instructions
send to the code. Follow the conventions the code already sets,
including any instructions file near what you are writing about
(`CLAUDE.md`, `AGENTS.md`, or whatever this repository uses). A
document written against an imagined codebase describes a system nobody
has.

Five exceptions: clearing an earlier phase's gate before drafting -
recording an answer as its `**A:**` line, or a given approval in its
sign-off fields; stamping a `> STALE:` notice directly under the H1 of
a later-phase document when an earlier document's content changed;
regenerating a stale document in pipeline order when the process
requires it - rewritten whole, per its own template; and appending to
the spec folder's `code-findings.md`, the shared record of code facts a
later phase would otherwise re-mine; and creating or updating a
question-and-answer pair in `decisions.md`. Outside a regeneration,
nothing else in those documents changes.

## 14. What the ask asks for, on a revise

A `## What to change` section in the ask is what the person typed when
they asked for this pass. It is the specific thing they want done, and
it is about this run alone - everything else about the document still
holds around it, and nothing it does not mention is an invitation to
change something else. When there is no such section, the document's
own edits are the whole of the instruction.

## 15. Common item words

Four words name a kind of item across more than one team's style,
worth stating once rather than reinventing per style:

- **AC** - Acceptance Criterion. Already what §2's `Req-N.M` is; write
  `AC` in prose to name the concept, not as a second id for the same
  criterion. §2 decides the id; this is just its name.
- **OQ** - Open Question. Already what §10's `QN-n` is, the same concept
  under a longer name. The panel's own parser looks for `**QN-n**`
  specifically (§10), so an item written `**OQ-4**` still counts as a
  question and still blocks - it just carries no clean id. Use `QN-n` where you want the id to
  resolve.
- **DEC** - a decision requiring sign-off. Something `design.md`
  proposes that a person must approve before it stands - not every
  choice, only the ones nobody downstream should discover after the
  fact.
- **DEV** - a proposed deviation from a standard. A `design.md` item
  that departs from a convention this team otherwise holds to, named so
  the departure is visible rather than silent.

Neither `DEC` nor `DEV` has a shape of its own - no built-in style declares one. A style that wants them declares an id for each the
way §2 already allows any document to: `### Dec-1: Cache invalidation
moves to write-through`, cited like anything else once it has one.

---

## Before you finish

1. One H1 on the first line; every section `##`.
2. `### Requirement N: Title` for each requirement, numbered from 1.
3. A literal `#### Acceptance Criteria` line above every criteria list.
4. Criteria in EARS, keywords UPPERCASE, `SHALL` for every obligation.
5. Citations written as links to a `.md` file, path relative to the file
   you are writing, nothing after `.md`:
   `[Requirements : 1.2, 3.1](requirements.md)` - except a task's own
   `_Requirements: 1.2, 3.1_` line and a property's
   `**Validates: Requirements 1.2, 3.1**` line.
6. Checkbox lines spaced exactly as above; details carry no checkbox;
   nesting as deep as needed and no deeper; every unit of work carries
   a `Files:` line.
7. A `## Task Dependency Graph` heading, wave ids matching the checkbox
   list, no two tasks in a wave sharing a path on their `Files:`
   lines, and every `after` naming only waves with a smaller id.
8. Every question carries a `**QN-n**` id, and every question with an
   `A:` line sits under `## Answered Questions`, not under
   `## Open Questions`.
9. Answers and sign-offs carry a name and a UTC datetime, recorded
   only from explicit confirmation.
10. Walk the finished document and resolve every code anchor one by
    one - open the file or folder at that exact path, and find the
    symbol inside it. An anchor nobody opened is a guess, however
    plausible it reads.
11. A plan ends with Verification, Documentation and Pull requests as
    its final three groups, in that order, one task per repo touched
    in each.
12. Every criterion id in the requirements document appears in at
    least one task's citation line. An id that appears nowhere is
    dropped work, not a matter of style.
13. Every number this document states about the codebase was derived
    by listing, and every number derived from another was recomputed
    from the corrected one. Every solution, project or test suite it
    names was read from the repository, not recalled.
14. Every `mermaid` fence parses. No `;` and no `#` anywhere in a
    `sequenceDiagram`; quotes only where §8 calls them syntax; no
    lowercase reserved word as a node id.
