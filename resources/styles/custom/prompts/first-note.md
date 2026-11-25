# ${{ spec.stage }} for '${{ spec.name }}'

Your job: **write the file ${{ phase.target }}**. Writing that file is
the task. Chat is not the deliverable - the next phase starts a new
chat and can only see files on disk.

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
${{ phase.documents }}
${{ phase.references }}

The person who started this phase also wrote this:

${{ phase.note }}

Take it into account while you write. Where it conflicts with the
attached documents, it wins: it is newer. It does not replace **how** -
the document still follows the instructions for this phase.

When you are done, reply with one sentence: what you wrote, and what a
reviewer should look at first.
