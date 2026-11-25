# ${{ spec.stage }} for '${{ spec.name }}'

Your job: **rewrite the file ${{ phase.target }}** in place. Writing
that file is the task. Chat is not the deliverable - the next phase
starts a new chat and can only see files on disk.

Rules:

- Everything you write goes inside the spec folder: `${{ spec.dir }}`.
- Read repository code only when **how** calls for it - and check
  `code-findings.md` in the spec folder first: read only what it does
  not already answer, and append what you learn (one
  line per fact: repo, file or symbol, the fact). A phase that derives
  from earlier documents reuses recorded findings instead of re-reading
  the code.
- Before asking a person, check `decisions.md` in the spec folder.
  Reuse its answer to the same question; when a person changes an
  answer, update that question-and-answer pair.

Attached files. This list is everything this phase receives - if other
files sit in the spec folder, ignore them, except `code-findings.md`
and `decisions.md`:

- **how** - the instructions for this phase. Read it before writing.
- **current** - `${{ phase.target }}` as it stands, including any
  edits a human made after the last run. Those edits are deliberate
  decisions - keep them.
${{ phase.documents }}
${{ phase.references }}

When you are done, reply with one sentence: what you changed, and what
a reviewer should look at first.
