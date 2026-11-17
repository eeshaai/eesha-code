# Eesha Code

A session with AI coding agents in a normal browser tab, served by a small server on your own machine. Claude, Copilot, Kiro and other agents, one session page for all of them, with nothing else to install or keep open.

## 1. Install

You need Node.js 20.19 or later (22.12 or later on Node 22).

```bash
npm install -g @eeshaai/code
```

This gives you the `eesha` command. No agent comes with it: it drives the ones you already have.

Tested on Windows. It installs on macOS and Linux too, but has not been tried there yet.

## 2. What each runtime needs

Each runtime needs its own program installed and on your PATH. Eesha Code does not sign you in to anything: each runtime uses the sign-in its program already has on this machine.

| Runtime | Program | Install it with |
|---|---|---|
| `claude` | `claude` (Claude Code) | `npm install -g @anthropic-ai/claude-code`, or Anthropic's installer. Or set `CLAUDE_CLI_PATH` to a copy you have. |
| `ghcp` | `copilot` (GitHub Copilot CLI) | `npm install -g @github/copilot`. Or set `COPILOT_CLI_PATH` to a copy you have. |
| `kiro-cli`, `kiro-cli-v3` | `kiro-cli` | Kiro's own installer |
| `copilot-cli` | `copilot` | Same as `ghcp` |
| `claude-cli` | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` |
| `gemini-cli` | `gemini` | Google's Gemini CLI |
| `codex-cli` | `codex-acp` | The Codex ACP adapter |
| `cursor-cli` | `cursor-agent` | Cursor's CLI |
| `opencode-cli` | `opencode` | OpenCode |

`claude` and `ghcp` drive Claude Code and the Copilot CLI through their makers' SDKs. The other runtimes talk to their program over ACP.

Run `eesha doctor` to see which of these programs are on your machine, and how to install the others. It does not check sign-in. Unless `ai.providers` in settings.json names the runtimes, the picker lists only the ones whose program is found, and a runtime you install later shows by itself. When none is found, it lists them all. The first `eesha start` on a machine with no settings.json prints the same thing in one line.

## 3. Use

1. `eesha start` - starts the server in the background and opens the page. `--no-open` only prints the link.
2. `eesha status` - says whether it runs, and prints the link again.
3. `eesha open` - opens the page.
4. `eesha stop` - stops it. A turn still running is stopped.
5. `eesha run` - runs it in this terminal instead, logging there too. Ctrl+C stops it.
6. `eesha doctor` - says which runtimes' programs are on this machine (see section 2).
7. `eesha connect ado` or `eesha connect github` - connects a connector from the terminal (see 3.6). It signs you in through `az` or `gh` first if needed. If nothing is saved for that connector yet, it puts in reach what this folder's git remotes point to, with every source on Read.
8. `eesha --version` - prints the version.

### 3.1 The page

The page is a chat with an agent, one session at a time. The chat is the page; everything else sits beside it and opens only when you ask.

1. **Window width.** Below 1024 px a message covers the page and asks for a wider window. From 1024 px to 1280 px the page stays 1280 px wide and the window scrolls sideways. From 1280 px up the page fits the window. (A 1920 px screen at 150% scale gives 1280 px.)
2. **The strip** at the far left, on every page but Settings, has one icon for now: **AI** (a chat bubble). Click it to open the session list beside the strip (3.2). Click it again to hide the panel. Ctrl+B does the same. Specs are not on the strip: they are in the **Spec explorer** on the right (3.3). The AI icon gets a red dot when another session waits for your answer, and a blue one when another session works, while its panel is hidden.
3. **Header**, from the left: the name Eesha Code (a link to the start page), Search, More (Keyboard shortcuts) and Settings.
4. **The session's row**, under the header: workspace › session name. A click on the workspace lists the other workspaces, each with its 3 newest sessions and New session, then Add a workspace and All sessions. Next to the name: a Working or Waiting for you label, and ⌄ (New session, up to 6 recent sessions in this folder, All sessions). Then the buttons **Session**, **Git**, **AI changes**, **File explorer**, **Spec explorer** (with SDD on), **Export** and **Logs**. Git and AI changes are off when the session has no folder.
5. **Footer:** the folder and its git branch, the port, and the Eesha Code version. Click the version to update Eesha Code (see 3.9).
6. **Addresses.** `/` is the start page, `/?chat=<id>` is a session, `/?chat=<id>&spec=<name>` is a session with a spec open as a tab beside it (3.3; `&specFolder=` follows when the spec is not in the main folder), `/workspace?workspace=<key>` is a workspace's page (it can carry `&spec=` too), `/settings/<section>` is a Settings section. An older spec link, `/sdd?workspace=<key>&spec=<name>`, still works: it goes on to the spec's newest phase chat, or to the workspace's page when the spec has no chat yet. Opening a list, a panel, a menu or a window does not change the address. Moving to another session loads the page again.
7. **A reload shows only the session's chat, full screen:** no panel beside the strip, no right panel, no editor, no tabs. Only the widths you dragged the edges to, and whether the Git panel shows its files as a tree, are kept in this browser. A spec tab is the one exception: the address carries it, so a reload opens it again.
8. **One tab per session.** A session shows in one browser tab at a time. Open it in a second tab and it moves there; the first tab says so and offers "Show it here instead". A session whose tab closed is kept on the server for 10 minutes, so a reload finds it, and a running turn keeps going. After that the runtime's session is let go, and opening it later reopens the conversation.

**The start page** (`/`) shows the sessions waiting for your answer, a box to start a session (with workspace, runtime, model and permission level pickers - "No workspace" is the last choice; Ctrl+Enter starts it), Resume last session, Search sessions, Add workspace, the 7 most recent sessions, and recent folders. Start session makes the session, opens it, and puts what you typed in its message box, not sent.

**The right panel** shows one of these at a time. Click the same button again to close it:

1. **Session** - what this session is made of and what it used, in sections that open and close:
   1. Runtime - the runtime, model, permission level, number of turns and when it started.
   2. Context - how full the context window is, as the runtime reports it, with a Compact button when the runtime can compact. Compact is off while a turn runs and until the context is over 50% full, because on a short conversation the summary can be bigger than the conversation. Compact uses a model call.
   3. Usage - one row per turn and a Total row: model calls, tokens in, cached tokens, tokens out and the charge. Cached is the part of "in" read from the prompt cache, which is cheaper. A column no runtime gave a figure for is left out (Kiro gives no call count and no cached count). Money shows only with the `sessionCost` flag on; tokens always show.
   4. Account - only on the `claude` runtime: who is signed in, the plan, and how much of each plan limit is used and when it resets (the same as Claude Code's `/status` and `/usage`). Asking costs no tokens. The last answer is kept in `usage.json`, so a new session shows it at once with its date until a fresh one comes. The limit rows use an SDK call that Anthropic says may change; if it goes away, only the limit rows go. `claude-cli` cannot ask, so it has no Account section.
   5. Folders - the working folder first, then the added ones, and Change folders.
   6. Tools - each tool the agent called and how many times, the tools turned off for this runtime, and a link to turn tools off in Settings › Runtimes.
   7. MCP servers - each server with connected, connecting, failed, needs sign-in or turned off, and its tool count. Kiro 3 sends this list. Claude and Copilot write their MCP status as a line in the log ("MCP: ado connected · github failed") instead; for them the section lists only the servers Eesha Code added itself and says the runtime does not report them.
   8. Connectors - each connector, connected or not, its access (read, or read + write) and the account it is signed in as.
   9. Steering - the session's instruction files (`.eesha/system.md`, and `kiro.md` on a Kiro runtime only).
2. **Git** (Ctrl+Shift+G) - see below.
3. **AI changes** - every turn that changed files, with This turn / Since the turn, Expand all and Collapse all. Undo works on one file of a finished turn; the running turn has no Undo.
4. **File explorer** (Ctrl+Shift+E) - see below.

**The editor** opens between the chat and the right panel when a file, a diff or Logs opens. The chat then shrinks to its own width. If the editor would get less than 640 px, the panel beside the strip closes by itself. × at the right of the tabs hides the editor and keeps its tabs; "Editor · N tabs" in the session's row brings it back. The button before × maximizes the editor: the chat (on a workspace page, the page), the panel beside the strip and the right panel all hide, and the editor takes the whole row. Press it again, or **Show the chat** (**Show the page**) in the row, to bring them back as they were. Pressing a panel's own button (the strip icon, Ctrl+B, Git, File explorer, Spec explorer and the others) also ends the maximize and shows that panel. Hiding the editor or closing its last tab ends it too, and a reload never keeps it. Logs (Ctrl+Shift+U) is a tab: every line of the session, including notices and errors the chat leaves out, with its filters inside the tab.

**Export** saves the session as `<session name>.md`, through the browser's own download. The text is the same as the file a Handover writes: what each side said, and each tool call with the first 30 lines of its output. It starts with "# Handover:" for that reason.

### 3.2 The session list

The AI icon on the strip opens the session list. It starts with the word SESSIONS and two icons at the right end: **Add workspace** and **New session**. Under it are the pinned sessions, then "Recent" - the 5 sessions you wrote in last (not pinned or archived ones), which stay in their workspaces too; a spec's phase chat shows here only once you typed in it - then every session grouped by its workspace (A to Z, "No workspace" last), newest first inside each. A session is in the workspace whose main folder is the session's first folder. A folder that sessions work in but that is not a workspace yet still gets its own group, named by the folder. "No workspace" holds the sessions with no folder at all. A row shows the session's name only; hover over it to see its folders. A spec's phase chats (3.3) fold under one row named after the spec, inside its workspace, newest first; the arrow on that row opens and closes them. Implementation's wave chats fold once more, under an **Implementation** row inside the spec's row. The spec's row and the Implementation row link to their newest chat, with the spec as a tab beside it. "Recent" opens and closes like a workspace and starts open. Each row is a link: a click loads that session's page, and a middle click or Ctrl+click opens it in a new tab. A turn running in the session you leave keeps going.

**Kiro's own sessions** show in the list too: sessions you started outside Eesha Code (the Kiro terminal, another editor) appear under their workspace with a "Kiro" tag, but only for workspaces and folders already in the list. Kiro sessions that SDD's phases used are never listed here. Click one and Eesha Code reads its messages back from Kiro and makes it a normal Eesha Code session; your next message carries on Kiro's conversation. Renaming or deleting an Eesha Code session that runs on Kiro v3 does the same in Kiro.

Click a workspace's name to open its own page. Click the arrow before the name to close or open its list of sessions. A folder that is not saved as a workspace, "No workspace" and "Recent" have no page: a click anywhere on their name closes or opens them.

A workspace's page (`/workspace?workspace=<key>`) stays on a reload. From top to bottom it shows: the workspace's name, its work item, folders and runtime, with **Edit workspace** and **Archive**; the sessions in it that wait for your answer; a box to start a session in it (no folder picker); the cards **Resume** (its last session), **New spec**, **Spec explorer** and **Next work item**; then its 5 most recently changed specs and its 7 newest sessions side by side. When it has more than 5 specs, **Show more** opens the Spec explorer on the right. The spec parts show only with SDD on. An archived workspace's page has no box and offers **Unarchive**.

A workspace never leaves the list because its sessions were pinned or archived: it stays, and says where they went ("No other sessions - 1 pinned."). When you delete the last session in a folder that is not a workspace (its own Delete, or Delete all sessions), the question has a box "Keep '<name>' in the list as a workspace, with no sessions", ticked to start. Leave it ticked and the folder becomes a workspace; untick it and it leaves the list. A closed workspace shows a dot when a session in it is working or waiting for you. Moving to a session with Alt+Up or Alt+Down opens its workspace. When the page loads, every workspace starts closed, except the one of a session that is working or waiting for your answer.

Drag the right edge of the panel to make it wider, up to 150 px more than it starts. The width is not kept: a reload starts it narrow again.

Hover over a workspace's name to see its icons on the right:

1. **Rename** (the label icon) - give the workspace a name of your own in the list. Not on "No workspace".
2. **New session** (the pencil icon) - starts a new session in it, with the workspace's folders, runtime and model.
3. **⋯** - Edit workspace (Save as workspace for a folder that is not a workspace yet), Delete all sessions (when it has sessions), and Remove from list (for a workspace with no sessions left).

A **workspace** is a named list of folders kept by Eesha Code, in `state.json` - not a file on disk. **Add workspace** and **Edit workspace** open the same window:

1. **Name** - the name the lists show. Empty means the main folder's name.
2. **Folders** - the first folder you add is the main folder (tagged "main folder"), where a new session starts; every one after it is an extra folder the agent may use too. When editing, the main folder stays first. SDD lists the specs of every folder of the workspace; New spec makes one in the main folder unless you pick another folder in the Spec explorer (3.3).
3. **Runtime** - "Server default" or one of the runtimes the picker offers.
4. **Model** - picked from the runtime's model list, or typed when no list is known yet. Empty means the runtime's own default.

The permission level is not in the workspace: it is set per runtime, for every session, in the compose box. A session already in the workspace keeps what it has; the runtime and model only apply to new sessions. A session can still add one-off extra folders of its own, outside its workspace. If a folder of the workspace no longer exists, its New session icon says so and makes no session - fix it with Edit workspace.

Each session's "⋯" button (it shows when the pointer is on the row) has Rename, Pin, Archive and Delete:

1. Pin - the session moves to "Pinned" at the top of the list. Unpin puts it back in its folder.
2. Archive - the session leaves the list and goes under "Archived (N)" at the foot, closed until you click it. Archiving a pinned session unpins it. Unarchive puts it back in its folder. A dot on "Archived" says when an archived session is working or waiting for you.
3. Pins and archives are kept in `state.json`, so they stay after a restart.

To search, click Search in the header, or press Ctrl+K. A window opens with a search box and the sessions found under it, newest first; the list on the left does not change. The box finds sessions by name and folder at once. From two letters on, it also searches what was said in each session: your messages and the agent's answers, not tool output or the agent's reasoning. A session found that way shows the matching line under its name, with the words marked. Pinned and archived sessions are found too, with an icon that says so. Up and Down move through the sessions found, Enter or a click opens one, and the X or Escape closes the window. The text you typed stays for the next time.

A dot at the right of a session's row says what it is doing. Hover over it to see the details:

1. Red - the agent asked something and is stopped until you answer. The hover text shows the question.
2. Blue - the agent is working.
3. Green - the agent finished while no tab showed this session. It goes when you open the session.
4. Red - the turn failed while no tab showed this session. It goes when you open the session. It looks the same as the waiting dot; the hover text tells them apart.

The green and red marks are kept only while the server runs. When you open the page, every session waiting for an answer also gets a notice with an Open button. So a question asked while no tab was open is not missed.

A new session has no folder: the agent works in the session's own scratch folder, `~/.eesha/scratch/<session id>`. The folder button in the compose box ("No folder" until you pick one) adds or removes folders, at any time:

1. Before the first answer, the first folder is where the agent starts, and the agent may use the others too.
2. After the first answer, the place the agent works in is fixed - the conversation started there. A session that started in a folder keeps that folder first. A session that started with no folder stays in scratch, and folders added later are extra places the agent may use.
3. After a turn, the bar above the compose box lists the files it changed in every folder of the session, with a diff, Undo and Keep. Files in the scratch folder are not listed. **Review all** in that bar shows every changed file's diff in one window, one under another, each with its own Undo. A file undone there or in the bar says "Undone".

<a id="specs"></a>

### 3.3 SDD

SDD (spec-driven development) always runs in a workspace. Turn it on with `"Feature-SDD": true` under `features` in settings.json. Then open the **Spec explorer** with its button in a session's row, or pick **Specs** on a workspace's "⋯" menu in the session list (that opens the workspace's page with the Spec explorer on the right).

1. **The Spec explorer** is a right panel, beside the File explorer. It lists every folder of the workspace (the main one is tagged "main"). Inside each folder the specs are grouped by kind - **Eesha**, **Kiro** and **Spec Kit** - each with the folder they are kept in (`.eesha/specs`, `.kiro/specs`, `specs`). A spec row shows its name, the phase waiting, a red dot when the agent waits for your answer and a blue dot while a phase works. A spec made in another workspace on the same folder says "other work item".
   1. **Phases and sessions.** The arrow on a spec shows its phases: a tick for done, a blue mark for the one to run now. The arrow on a phase shows its sessions, newest first ("#2 · Nov 18 09:12"; an earlier one says Read Only). Implementation's sessions are its wave chats. Idea says "no chat".
   2. **Clicks.** A click on a spec opens its newest phase chat, with the spec as a tab beside it. A click on a phase opens that phase's newest chat; a click on a session opens that chat. A spec with no chat yet opens as a tab on the workspace's page. Ctrl+click opens the same place in a new browser tab. The start page's and the workspace page's spec links go to the same places.
   3. **New spec.** The + in the heading makes a spec in the main folder; the + on a folder row makes one in that folder.
   4. **Sort.** The button beside + switches between A to Z and most recently changed first. Each workspace keeps its own choice.
   5. **"⋯" menu.** **Copy a style…** (the same window as the link in New spec, below). **Clear spec history…** throws away the old copies of spec documents that the "What changed" view compares against, for every spec in the main folder. It asks first. **Specs guide** opens this section of the README in a new browser tab.
2. **No specs in a folder:** its row says so, with New spec.
3. **New spec** first asks **How it runs**: an Eesha style, **Kiro** or **Spec Kit**.
   1. **Eesha style:** the kind ("[Custom] Feature" or "[Custom] Bug fix"), where it starts from (a line you type, an ADO work item, a GitHub issue, or files you already have, as full paths), and its name, which becomes the spec's folder name. **Create** writes `idea.md` with no AI and opens the spec as a tab on the workspace's page. No phase starts by itself: press Next yourself.
      1. For an ADO work item or a GitHub issue, type its number or link, or press **Pick…** to find it through your connectors, level by level, the same levels as `>` in the compose box (ADO starts at its work items, GitHub at its repos). The picked item's link goes into the box. `idea.md` records only which item it is; the first phase reads it through the connector tools.
      2. **Copy a built-in style** (a link in the window) opens **Copy a style**: pick the built-in style, where the copy goes (this workspace first, so it goes into git with the specs; or your profile, `~/.eesha/styles`, for this machine only), and its name. The window lists the files it copies. To offer the copy in New spec, add its name to `sdd.styles` in settings.json.
   2. **Kiro:** a description and a name. **Create** makes `.kiro/specs/<name>`, opens the spec and starts Requirements in Kiro's Spec mode with your description. Each later phase starts a new Kiro chat with "Continue working on the ... spec" and writes only its own document. Kiro must be in `ai.providers`.
   3. **Spec Kit:** a description only. **Open the chat** opens a new session with `/speckit.specify <your description>` in the box; press Send there. Spec Kit names the folder and makes the git branch. After that the spec is listed under Spec Kit, and its later steps (`/speckit.plan`, `/speckit.tasks`, `/speckit.implement`) run from Next. Before a step, the spec's branch must be the one checked out. The folder needs Spec Kit set up first (`specify init --here`).
   4. **Kiro and Spec Kit have no Idea step.** Only Eesha styles write `idea.md`.
4. **The spec tab and its phase chats.** A spec opens as a tab beside a session, like a file. The tab has the phase rail, the runtime and model every phase runs on, "Next: <phase>" beside the title, and the tabs Doc (or Tasks), Logs, Prompt, and Wave graph for a plan. Several spec tabs can be open; only the one in front follows the spec live, and one behind it is drawn again when you pick it.
   1. **A phase chat is a normal session.** Each phase runs in a chat of its own: the first draft in a clean session, every revise in the same chat. Implementation runs each wave in a chat of its own. A phase chat has Git, File explorer, Logs and Export like any session. A line at its top names the spec and the phase, with **Open spec**.
   2. **Next** starts the phase in a new chat and moves the page to it, with the spec tab beside it. For Implementation the page moves to the first wave's chat; the later waves run in their own chats. Nothing else changes the phase for you.
   3. **Typing in a phase chat** runs the turn on the spec's runtime and model. Its box shows them but cannot change the model, mode or effort; change them in the spec tab. The runtime word still opens Handover, as in any chat. While another phase or wave of the spec works, a message is not sent, and a notice says why. When the plan stopped at a wave chat - you pressed Stop, or its agent stopped with a box unticked - that chat shows **Resume**. Resume sends "continue" into the chat and carries the plan on from there; any message you type there does the same.
   4. **Open questions.** When a document has questions under `## Open Questions` with no `A:` line, the next phase is blocked and the Doc tab lists them, each with a box. Type the answer and press Enter or Save answer: it is written under the question as an `**A:**` line, and the block lifts.
5. **Plan commands.** A plan task that is a command, and a plan row's command button, run in this machine's default shell in the spec's folder. A notice says when it starts and how it ended, with the last lines it printed when it failed. A task's exit code ticks its box or not.
6. **Addresses.** An open spec tab is in the address (`&spec=<name>`), so a reload opens it again. Old `/sdd?` links go on to the spec's newest phase chat (3.1, point 6).
7. **Permissions.** A phase chat's box has the same permission level picker as any chat; it is hidden while the agent waits for your answer to a question. The level is kept per runtime, so a level picked in a phase chat is the level every chat on that runtime uses, and the other way round. A permission card from a phase's agent shows in its chat and waits for your answer. "This session" answers belong to that chat.
8. **Listed with your sessions.** Phase chats are in the session list, folded under their spec (3.2), and in the Spec explorer under their phase. Only SDD starts a phase; a message typed in a phase chat never moves the spec to another phase.
9. **The fake runtime** (for trying SDD without spending anything): turn on `"fakeRuntime": true` under `features` and pick **fake** as the runtime. It calls no model. It writes sample drafts, asks one question on each first draft, writes a small plan in Tasks, and ticks the tasks it is given in Implementation.
10. **Plugins.** SDD loads plugins from each workspace folder's `.eesha/plugins`, then from `~/.eesha/plugins`. So `sdd.uses` in settings.json can name a plugin of your repository. If that plugin ships its own page (`ui` in its manifest, for the spec panel or both), the page is a tab after Prompt. The page can ask the plugin for things, keep its own data, and start a phase. Plugins run in their sandbox unless the profile's settings.json says `"debug": true`. A changed plugin is read again when Eesha Code restarts.
11. **Limits:**
    1. SDD cannot start a workflow.
    2. A file SDD opens shows as a read-only tab beside the editor, and only from inside the workspace's folders.

### 3.4 Files, Git and the editor tabs

1. **File explorer** - the session's folders as a tree: git colours and letters on changed files, a dot on folders that hold them, a purple mark on files the agent changed in this session, and git-ignored items dimmed. A title-row button shows only the files the agent changed. Open tabs at the top lists the open tabs. Right-click a file for Open, Open and keep the tab, Add to context, Copy Path, Copy Relative Path, Show in Git and Show what the agent changed. **Add to context** (the + on a row, or dragging it onto the compose box) puts a file in your next message; on a folder it sends the folder's path to the agent. Ctrl+P finds a file and opens it. The tree only reads: nothing is made, renamed or deleted there.
2. **Git** - the changes in the session's repositories. Every button is yours: the agent never uses this panel.
   1. **Which repositories.** Each session folder inside a git repository gives that repository. A folder that is not in one gives the repositories one level inside it. With several, a Repositories list at the top picks one.
   2. **Commit box.** Type the message, Ctrl+Enter commits. With nothing staged it asks to stage everything first. The AI button writes the message for you: a hidden session on this session's runtime and model looks at the repository, may only read files and run read-only git commands, puts its message in the box, and is then deleted. Press it again to stop it. Its "…" menu has Commit all, Amend last commit and Undo last commit.
   3. **Lists.** Merge conflicts, Staged and Changes, as a flat list or a tree. Stage, unstage and discard work on one file, a group or everything. Discard asks first: a tracked file goes back to the staged copy or the last commit, and your edits on disk are lost; a new file git does not track is moved to `~/.eesha/trash`. On a conflict: take ours, take theirs, or mark as resolved. When a merge or rebase stops, Continue and Abort show.
   4. **Graph** (closed at first) lists the commits with branch and tag badges. A commit's menu can copy its id, revert it, cherry-pick it, or check it out with no branch (asks first).
   5. **The "…" menu** has Fetch, Pull, Pull (rebase), Push, Sync, branches (switch, create, create from, rename, delete, merge into this one, rebase onto), Stash all changes and the stash list (apply, pop, drop), tags (create, delete, push), remotes (add, remove) and Undo last commit.
   6. The buttons that change things are off while the agent works; reading still works. The panel reads the repositories again by itself when files change and when a turn ends.
3. **File tabs** show the file in colour with bars by changed lines, a File / Git changes / AI changes switch, Find (Ctrl+F), Copy path and Add file to context. A Markdown file also has **Preview**: the file rendered. In a folder named exactly `spec` or `specs` (any case) the preview starts in **spec colours**: the EARS words (WHEN, WHILE, WHERE, IF, THEN THE, SHALL) and MUST / MUST NOT are coloured, as on the spec's Doc tab. A switch turns the colours off; the refresh button reads the file again. Lines you pick go into the message box as a code block with the path and line numbers.
4. **Diff tabs** show git's letter, +added and −removed counts, and an Inline / Side by side switch. A turn's diff can also switch between "What this turn did" and "Before the turn vs now".
5. One click opens a file or a diff in the preview tab (its name in italics); the next single click replaces it. Double-click the row or the tab to keep it open. Tabs are not kept after a reload.
6. **Find a file** (Ctrl+P, or the search button in the File explorer's title row) reads the names of every file in the session's folders each time it opens, up to 5,000 files. It skips `.git`, `node_modules` and everything git ignores. It finds by name first, then by path.

### 3.5 The chat

When a turn ends, or the agent asks you something, the page shows a desktop notification, even while you are looking at the session. The tab's title also gets "(Done)", "(Failed)" or "(Question)" in front until you click, type, or come back to the tab. Clicking the notification opens that session. The browser asks once whether the page may show notices, the first time you send a message. If you said no, only the title changes; allow it again in the browser's site settings for `127.0.0.1:7420`. A turn you stopped yourself gets no notice.

In the compose box, "/" is for commands, "@" is for files and "#" is for tools and MCP servers. Type "@" and part of a name to search the session's folders; a picked file becomes a chip and goes with the message. With the `steering` flag on in settings.json, type "@" and the name of a `manual` steering file (the file name without `.md`) and that file goes with that one message.

Type "/" as the very first character of a message to see the runtime's own slash commands. Picking one writes "/name " into the box; type what follows and send it. A "/" anywhere else is plain text. The list is never fetched: each runtime sends it when a session starts, and it is kept in `commands/<runtime>.json`, so a new session shows the last list at once. A runtime you have not started a session with yet shows no commands. Copilot through the SDK (`ghcp`) has no list. Commands that would let the agent run tools without asking, or reach other folders (for example `/permissions` or `/add-dir`), are left out of the list and refused if you type them. So are Copilot's `/share` (and `/export`), which can publish the session as a GitHub gist, and `/remote`, which lets the session be used from GitHub.com and GitHub Mobile.

Under each of your messages, while the agent is not working, are a pencil and a go-back arrow. The arrow, "Go back to here", removes that message and everything after it from the session. A dialog asks first. It lists the files changed since that message, with "Also put my files back" ticked, and says what happens to the agent's conversation. Only files in the session's git folders are listed; files git ignores and the scratch folder cannot be put back. The session as it was is kept in the list, named "<title> (before going back)". Afterwards the message is back in the compose box with its files. The pencil turns the message into a text box; Send asks the same way, goes back, then sends the new text with the message's files. On Claude (both runtimes) the agent's conversation is cut at the same point for free, so it forgets the later part. Copilot, Kiro, and Claude when the message cannot be found in its saved conversation (after a compact, say) start a new conversation instead. In that case what was said before goes with your next message as a file, the same file a Handover writes.

When the agent makes a plan, it shows above the compose box: "Plan: 2 of 5 done" and each step marked done, doing or not started. It is open while the agent works and folds to one line when the turn ends; click it to open or fold it. A reopened session shows its last plan. Claude (both runtimes) and Copilot (both runtimes) send plans; Kiro does not.

On Kiro v3, a message you send while the agent works joins the running turn. The thread says it is waiting, then that Kiro added it. A message with files or images attached goes as a second prompt instead, and waits for the turn to end.

A file link in the thread opens the file as a tab, but only a file inside the session's folders or its scratch folder, up to 2 MB, and text only.

**Run on a command block.** When the agent writes a shell command in a code block (bash, sh, shell, zsh, fish, powershell, pwsh, ps1, ps, cmd, bat or batch), the block's header has a shell list and Run beside Copy:

1. The block's language picks the shell it starts on: PowerShell for a powershell block, Command Prompt for cmd or bat, Git Bash (Windows) or bash (Mac, Linux) for bash or sh. The shell you picked last wins when it is of the same kind, and is kept in this browser.
2. Run starts the command once, in the session's folder. With several folders a window asks which one.
3. What it prints shows under the block as it comes, with Stop while it runs, and then the exit code and the time. Colour codes are taken out. Only the last 200,000 characters are kept.
4. Nobody can type into it. A program that asks a question gets "end of input", and full-screen programs (vim, top) do not work.
5. Nothing is kept. Opening another session or reloading the page stops a run still going. A run whose page closed stops 30 seconds later. On Windows, a program started from Git Bash may keep running after Stop; PowerShell and Command Prompt stop everything.

### 3.6 Connectors

Connectors let the agent read Azure DevOps and GitHub, and change them where you allow it. They belong to the whole machine, not to one folder or session. Open them in Settings › Connectors, or use `eesha connect` (section 3).

1. **Sign in.** Each card has Sign in, which runs the program's own sign-in: `az login` for Azure DevOps, `gh auth login --web` for GitHub. The browser opens, and GitHub's one-time code shows on the card. If you are already signed in, the card says who. If the program is not installed, the card says how to install it. Eesha Code never keeps a password; it asks `az` or `gh` for a short-lived token and keeps it in memory only.
2. **Connect (or Edit)** opens a window with two parts:
   1. **What is in reach.** It starts with what your folders' git remotes point to. Then GitHub lists your account and its organizations, each with its repos; tick an owner for all its repos, new ones too, or open it and tick only some. Azure DevOps lists each organization you belong to with its projects; ticking an organization ticks the projects it has now, not ones made later. You can add more by hand (`owner`, `owner/repo`, or `org/project`). Save needs at least one ticked.
   2. **Each source: Off, Read, or Read and write.** Azure DevOps: work items, saved queries, repos, pull requests, build pipelines, release pipelines, wiki and test plans. GitHub: repos, files and history, pull requests, issues, actions, releases, discussions and projects. Some are read only. GitHub Projects starts Off and needs `gh auth refresh -s read:project` first.
3. **`>` in the message box** points the agent at one item, one level at a time: `>ado>workitems>12345`, `>github>owner/repo>pulls>12`. `mine` right after `>ado>` or `>github>` lists your own items (assigned to you, opened by you, to review). On send, each path adds one line for the agent with what it is, its title, state and link; the agent reads the rest with its tools. The thread folds those lines under "Also sent to the agent".
4. **Every change asks you first,** in a window with Deny and Allow, whatever the permission level. With no tab showing the session, the change is refused.
5. **Only sessions started after connecting** get the connector tools.
6. **Kept lists.** Lists of projects, repos, pipelines and the like are kept for a while in `cache/connectors.json`, so the `>` menu fills at once. When a kept list was used, the last row says how old it is and fetches it again when picked. The kept lists for a connector go after any change it makes, after a sign-in, and on Disconnect.
7. **Disconnect** forgets the choices. The `az` or `gh` program stays signed in.

#### Memory

Memory is a connector too, with nothing to sign in to. It keeps short facts between sessions: a preference of yours, a decision and its reason, a fact about some code. It is Eesha Code's own, so Kiro, Claude and Copilot sessions all get the same memories.

1. **Three levels.** A global memory goes to every session. A workspace memory goes only to sessions of that workspace. A folder memory goes to any session that has that folder. A folder is known by its path on disk.
2. **What a session gets.** Every new session is told the titles of the memories it can use, and gets tools to list, search and read them, and to save, change and delete them. A session reaches only global, its own workspace and its own folders. A session with no folder reaches only global.
3. **Settings › Connectors › Memory** has three choices:
   1. What the agent may do: Off, Read, or Read and write. It starts on Read and write. Used from the next session start.
   2. Ask me before the agent saves, changes or deletes a memory. Off to start with: the agent does it and the session shows a short notice. On: a window with Deny and Allow, every time, and the change is refused when no tab shows the session.
   3. Claude's own memory is off in Eesha Code's sessions. Claude Code keeps a memory of its own, and two memories would not agree. While Eesha Code's memory is on, a Claude session starts only when this is on. The first message to Claude asks you, once. It is turned off only for sessions Eesha Code starts; Claude Code in your terminal is not changed. Set Eesha Code's memory to Off and Claude's own is left as it is.
4. **Settings › Memory** lists every memory in groups: Global, each workspace, each folder. Add a memory, Edit its text or move it to another level, or Delete it. A memory shows who wrote it: you, or an agent. "Folder moved…" on a folder group gives its memories to the folder it is now, after a move or a rename.
5. **`>memory` in the message box** puts one memory into a message: `>memory>global>12`, `>memory>workspace>7`, `>memory>folder>3`. The number is the memory's id.
6. **Where it is kept.** One database file, `memory.db`. Nothing is written into your folders, so git never sees a memory.
7. **Phases of a spec** get the memory tools, but are not told the titles: a phase runs with the spec's own instructions only.

### 3.7 Instructions for the agent and tools turned off

1. Put text in `.eesha/system.md` in a session's folder and every runtime gets it as extra instructions. `.eesha/kiro.md` beside it goes to Kiro runtimes only. With several folders, every folder's files are used. The text is read when a session starts or reopens.
2. Settings › Runtimes › Denied tools takes a runtime's own tools away (see 3.8). The agent is also told which tools are off.
3. Each runtime gets them its own way: Kiro v3 as a steering file that stays after a compact, Claude over ACP and both SDK runtimes added to their system prompt, and other ACP runtimes in front of the first message. Most runtimes really lose a turned-off tool; on Kiro v3 and other ACP runtimes it is refused when the agent asks to use it, with a row in the thread that says why.
4. The Session panel's Steering section lists the files the session uses.

### 3.8 Settings

**Settings**, the gear in the header, opens the settings page. It has a menu on its left; each item is its own address (`/settings/general`, `/settings/connectors`, `/settings/memory`, `/settings/runtimes`, `/settings/features`, `/settings/storage`), and `/settings` opens General. Each change is written to `settings.json` at once:

1. General:
   - **Look** - Dark, Light, or Follow the system. Every open tab changes at once, with no restart.
   - **Text size** - A- and A+ make the text and icons on every page one px smaller or bigger, from 11 px to 24 px (13 px to start with). The page changes at once; the size is written to `settings.json` when you stop pressing. Reset puts it back to 13 px. Every open tab changes too.
   - **Port** - used from the next start. The link changes with it. "Pick a free port" puts a port nothing uses now in the box; Save keeps it.
   - **settings.json** - the whole file as text, for everything else (MCP servers, your own ACP agents, env rules, settings per runtime). It is checked before it is saved; a file with a mistake is not saved, and the page says what is wrong. Revert and Save stay at the bottom of the window while the page scrolls.
2. Connectors - Azure DevOps and GitHub for the agent to read (and write, if you choose), and what the agent may do with the memory (see 3.6).
3. Memory - every saved memory, to add, edit, move and delete (see 3.6). The memories are not in `settings.json`.
4. Runtimes - one card per runtime, with everything set for it:
   - Whether its program was found (the same check as `eesha doctor`): a green dot and the path shortened (hover to see all of it), or a grey dot and "Not found on this machine". Runtimes not found are listed last, faded.
   - **Set as default** - the runtime a new session starts on (written as `ai."ai@1".provider`); a session already started stays on its own runtime. The default runtime's card has a green "Default" tag and a green left edge.
   - **Show in picker** - runtimes switched on show in the runtime picker. Until you change one, only the runtimes found are on. At least one stays on, and the default cannot be switched off - set another one as default first.
   - **Denied tools** - the runtime's own tools to take away, by name, separated by commas, for example `fs_write,fs_read` (`eesha.runtimes.<id>.toolsOff`). Copy a name from the log: each tool call's line shows it in brackets after the title. Used from the next session start or reopen. A runtime not found has the box only when tools are already denied for it.
   - **Add a runtime** takes an id, a command and its arguments. Before it is saved, the program is started once and sent ACP's first message; it is added only if it answers as an ACP agent within 20 seconds. It is stopped right after, and no session is opened. It is saved in `ai.acpAgents`. Environment values go in the settings.json text box.
   - Runtimes you added are tagged "Yours" and can be removed. Built-in ones cannot.
5. Features - a table of the feature flags that matter on this page, with what each one does: `Feature-SDD` (the SDD module, off by default), `handover`, `steering`, `toolResults`, `liveToolOutput`, `sessionCost` and `hideCopilotPremiumRequests`.
6. Storage - how many files are in `trash/`, with Empty trash, and how many scratch folders belong to deleted sessions, with Remove. Each asks first. Neither can be taken back.

A session on screen picks a change up at once; a turn already running keeps what it started with.

### 3.9 Updating Eesha Code

Click the version in the footer. It does one of two things:

1. **Installed from npm:** it asks npm for the newest version, using your own npm settings (so a work registry or proxy is used). If there is a newer one, the window shows **Upgrade to X**. On click the server stops, `npm install -g @eeshaai/code@X` runs, and Eesha Code starts again on the same port. If the install fails, the version npm left in place is started again and the page says so.
2. **Built from source** (also a copy made with `npm link`): one click runs `npm run build` in the Eesha Code folder and restarts the server. No window, no question. If the build fails, the old server keeps running and a notice shows the end of the build output. There is no `git pull`: it builds what is on disk.

Either way the update is refused while a session is working; stop it or let it finish first. The page reloads by itself when the server is back, and a notice says what happened. npm is only asked when you click; nothing is checked at startup.

### 3.10 Keyboard shortcuts

Cmd in place of Ctrl on a Mac. More › Keyboard shortcuts in the header, or Ctrl+/, lists them:

1. Ctrl+Shift+O - new session, in the current session's first folder.
2. Alt+↑ / Alt+↓ - the session above or below in the list. Archived sessions are skipped.
3. Ctrl+K - search sessions.
4. Ctrl+B - show or hide the panel beside the strip (the session list).
5. Ctrl+Shift+E - show or hide the File explorer panel.
6. Ctrl+Shift+G - show or hide the Git panel (needs a folder).
7. Ctrl+Shift+U - show or hide the Logs tab.
8. Ctrl+P - find a file in the session's folders and open it (needs a folder).
9. Enter sends the message; Shift+Enter is a new line.
10. Esc - close the open menu or window. With none open and the message box in focus, it stops the running turn.
11. Ctrl+Enter - commit, in the Git panel's message box.
12. Ctrl+/ - the list of shortcuts.
13. Typing a letter when nothing has the focus starts typing in the message box.

While the page has the focus, some of these replace a browser key, for example Ctrl+Shift+O (the bookmarks page), Ctrl+K (search from the address bar) and Ctrl+P (print).

## 4. Files

Everything is in `~/.eesha/`. Settings are read only from here, never from a folder you session in.

1. `settings.json` - optional. Its `ai` block lists the runtimes the picker offers (`providers`) and adds ACP agents of your own (`acpAgents`). Plus Eesha Code's own block:

   ```json
   {
     "eesha": {
       "port": 7420,
       "theme": "dark",
       "fontSize": 16,
       "workingFolders": ["C:\\src"],
       "runtimes": { "kiro-cli-v3": { "toolsOff": ["str_replace", "fs_write"] } },
       "connectors": {
         "ado": { "reach": [{ "org": "contoso", "project": "Web" }], "sources": { "workitems": "write", "builds": "read" } },
         "github": { "reach": ["octocat", "contoso/api"], "sources": { "pulls": "read", "repos": "read" } }
       },
       "memory": { "access": "write", "askOnSave": false, "claudeMemoryOff": true }
     }
   }
   ```

   1. `port` - a whole number from 1024 to 65535 (7420 when not set). A changed port takes effect on the next start.
   2. `theme` - `"dark"`, `"light"` or `"system"`.
   3. `fontSize` - the text size in px, a whole number from 11 to 24 (16 when not set). A theme or text size changed on the settings page shows at once; one changed by editing the file shows on the next start.
   4. `workingFolders` - full paths of the folders where you keep your code (Settings › General › Working folders). The folder browser shows them beside the drives. It also lists, under "Git repos", each working folder that is a git repo and each folder right inside one that is, the most recent git activity first. A repo you used before shows only under "Used before". The workspace window's folder list shows these repos after the folders used before.
   5. `runtimes.<id>.toolsOff` - the runtime's own tools to take away (Settings › Runtimes › Denied tools).
   6. `connectors` - what each connector may reach and do (Settings › Connectors). A connector with no entry is not connected. Sign-in is never kept here; it stays in `az` and `gh`.
   7. `memory` - the three memory choices (Settings › Connectors › Memory, see 3.6): `access` is `"off"`, `"read"` or `"write"`; `askOnSave` and `claudeMemoryOff` are `true` or `false`. With no entry, memory is on with `"write"` and both others are `false`.
2. `key` - the secret in the link. Delete it and restart to make a new one; old links and bookmarks then stop working.
3. `server.json` - the running server's process id and port. It goes when the server stops.
4. `permissions.json` - the answers you saved from permission cards ("this session", "this folder", "always").
5. `logs/` - one log file a day, kept 14 days. `server-output.txt` is the background process's own output. `upgrade-output.txt` is the npm upgrade's output, with the key hidden.
6. `usage.json` - the last Claude account and plan limits seen, so a new session shows them at once.
7. `upgrade.json` - written just before an update restarts the server, read and deleted by the new server to show what happened.
8. `cache/connectors.json` - connector lists kept between restarts (see 3.6). No token is in it.
9. `memory.db` - the memories (see 3.6), one SQLite database. Made the first time a session starts with memory on, or the Memory page is opened.
10. `plugins/` - your own plugins. Plugins are read only from here, never from a session's folder.
11. `sessions/`, `events/`, `state.json`, `models/`, `commands/`, `scratch/`, `trash/` - each session's folders, the chat history, saved picks (runtime, tools, names, pins, aliases, workspaces, SDD's saved values, permission levels), model lists, each runtime's slash commands, uploaded files and scratch work, and files an Undo or a Git discard removed.

## 5. Safety

It listens on 127.0.0.1 only. Every request needs the key (from the link, then a cookie), must name 127.0.0.1 or localhost as the host, and a request that changes something must come from the page itself.

## 6. Licence

Eesha Code is under the Functional Source License, FSL-1.1-ALv2. You may use it, read it and change it for anything except a product that competes with it. Two years after each release, that release also becomes Apache 2.0. The full terms are in [LICENSE.md](LICENSE.md). The compiled UI library inside the npm package is private and is not covered by the FSL: see part 2 of the licence. Third-party material is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The source is here so you can read and check it. Install from npm.

Pull requests are not accepted. Issues are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## 7. Building from source

The build needs the private UI library in `SubModules/ui-lib`, so only the author can build from source.

1. `npm ci`, then `npm run build`. This writes `dist/`.
2. `npm run typecheck` and `npm test` check the code.
3. `npm run test:e2e` builds, then runs the browser tests in `e2e/`. Each test file starts the server on a throwaway home folder with the fake runtime, so no model is called and your own `~/.eesha` is not touched. The first time, `npx playwright install chromium` gets the browser.
4. `npm link` once, and `eesha` runs the built copy in any terminal.
5. Source maps are written next to the built files for debugging. They are never in the npm package.
