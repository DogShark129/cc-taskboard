# cc-taskboard

English | [简体中文](README.zh-CN.md)

cc-taskboard is a Claude Code plugin that keeps one Jira-style task board across all of your Claude Code sessions. Every session writes what it works on to a shared, local event log; every session (and a small local web app) folds those logs into the same board. Claude gets a `ticket` tool to create and update tickets, and the plugin moves tickets on its own when Claude commits, opens or merges a PR, or asks you a question. You review, comment, drag and accept; your comments wake the session that owns the ticket.

Features:

- A Jira-style board across all Claude Code sessions, in a pane inside each session.
- A `ticket` tool for Claude (`mcp__cc-taskboard__ticket`): list, create, update, and an init wizard.
- Automatic status from git and GitHub (`git commit`, `gh pr create`, `gh pr merge`), from file edits, and from Claude's questions (`AskUserQuestion`).
- A review gate: Claude can move a ticket only as far as "In review"; only you accept it into "Done". Canceling is yours too: Claude can only propose it, with a reason.
- Comment wake-up: a comment you leave on a ticket is delivered to the session that owns it, which acts on it.
- A new session per ticket: "Do in a new session" (or dragging a ticket from To do to In progress) has Claude prepare a session for that ticket; spawned sessions keep their title in sync with the ticket's status.
- Per-project boards, matched by the session's working directory.
- History weeks: page back through earlier weeks, read-only.
- Bilingual UI (English / Chinese), switchable from the board; ticket titles and descriptions are stored in both languages.
- The theme follows the Claude desktop app (or is fixed to light / dark).
- A local web app on `127.0.0.1:4790` with the same board.

License: [MIT](LICENSE).

## Requirements

- Claude Code with function-hook plugins. It was built and tested on Claude Code 2.1.286.
- macOS for the desktop-app features: theme following, session titles, and the init wizard's scan of recent sessions all read the Claude desktop app's files under `~/Library/Application Support/Claude/`. The board itself works elsewhere.
- [Deno](https://deno.com) 2.x for the web app (optional; the in-session board does not need it).
- `git` and `gh` are optional; they feed the automatic status rules.

## Install

1. Clone the repository somewhere permanent:

   ```sh
   git clone <repo-url> ~/code/cc-taskboard
   ```

2. Add the plugin folder to `~/.claude/settings.json`, in its `env` block (merge with what is already there):

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/code/cc-taskboard",
       "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
       "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
     }
   }
   ```

   - `CLAUDE_CODE_PLUGIN_DIRS`: absolute path(s) to plugin folders (`~` is allowed; separate several with `:`).
   - `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`: turns on function-hook plugins.
   - `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` (optional): long-lived sessions (desktop app, SDK) reload the plugin when its files change. Interactive terminal sessions watch the folder anyway.

   To try it in a single terminal session first: `claude --plugin-dir ~/code/cc-taskboard` (with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment).

3. Restart your Claude Code sessions. The plugin loads at session start; sessions that were already open do not pick it up.

4. First run: open the board with `/kanban` (or `/taskboard`). A fresh install has no boards, and the board says so. Ask Claude, in any session, to set up the task board ("set up the task board" / "初始化看板"). Claude runs the init wizard: it scans your 50 most recent desktop sessions, proposes boards (one per project or repository) and tickets, shows you a preview, and writes nothing until you confirm.

## Usage

### The pane

The board docks itself in the session's pane sidebar on your first prompt. If you close it, it stays closed for that session; `/kanban` or `/taskboard` opens it again.

- Header: the board title and ISO week, the date range, days left in the week, and this week's counts (new, done, commits). Week navigation (previous / next / this week), a link to the web app, the theme button (Follow Claude / Light / Dark) and the language button (EN / 中文).
- Project tabs: one per board, with a red count of tickets waiting for your decision, plus "All", which shows every board as a lane.
- Filters: "Waiting on me" (the Decision column only) and "Live only" (tickets a session is working on right now); a search box for key, title or label; "Board" / "Feed" (the live activity feed).
- A "Working:" line lists the sessions that are busy and the ticket each is on.
- Cards show the title, key, priority, labels, blockers, due date, a "live" mark while a session works on the ticket, days in the current column (red after 7), the comment count and the PR.

### The ticket tool

Claude calls `mcp__cc-taskboard__ticket` with an `action`:

- `list`: open tickets, optionally filtered by `q` (key, title, labels).
- `create`: a new ticket. Takes `title` and `title_en` (both languages), and optionally `col`, `desc` / `desc_en`, `priority` (P0 to P3), `labels`, `due` (YYYY-MM-DD), `blockedBy`, `parent`, `note`, `comment`, `project`. `src: "me"` marks tickets you asked for ("add this to the board").
- `update`: change any of the above on `key`; `work: true` claims the ticket for the current session.
- `init`: the setup wizard. Without a plan it returns the scan; with a `plan` it returns a preview; with the same `plan` and `confirm: true` it writes.

Claude is told to look for an existing ticket before starting a piece of work, and to claim or create one. The tool's own description carries the rules, so you rarely need to mention it.

### Columns and the review gate

Decision (waiting for you), To do, In progress, Waiting (on others: PR review, a reply), In review, Done, and Canceled (shown only when it holds a ticket, and as a drop target while you drag a card).

Automatic moves for the session's current ticket:

- Claude edits a file while the ticket is in To do or Waiting: In progress.
- `gh pr create`: Waiting, with the PR number recorded. `git commit` records the commit on the ticket.
- `gh pr merge`: In review.
- Claude asks you a question: Decision, and back to where it was once you answer.

Claude can move a ticket to In review at most. A `done` from Claude lands in In review, unless you said in the chat that you accept it (the tool's `userAccepted`). On the board, "Accept" moves it to Done and "Send back" returns it to In progress.

Canceling works the same way. A `canceled` from Claude lands in Decision as a proposal and needs a reason (`comment` or `note`); the card, the preview and the detail then offer "Cancel it" and "Keep" (back to the column it came from). Claude cancels directly only when you said so in the chat (`userAccepted`). You can cancel any ticket from its preview or detail ("Cancel ticket", with an optional reason in the detail and on the web), or by dragging it to Canceled; the feed shows who canceled what and why. "Restore" on a canceled ticket returns it to the column it was in before.

In the pane, To do, Done and Canceled sit folded below the list; on the web board Done and Canceled fold behind an "Expand" toggle. Done and canceled tickets from earlier weeks are archived off the current board; a search still finds archived canceled ones.

### Pane, preview and detail

The pane is a focus list: Decision, In progress, In review and Waiting as sections of one-line rows, a status ribbon whose legend hides or shows a status, and To do, Done and Canceled folded below. Click a title for a preview (under its row in a narrow pane, a popup over the list in a wide one; the title again or × closes it): status and priority pickers, "Open details", cancel or restore, the description, the latest comments and a comment box. On the web board, drag a card to another column to move it. The detail view has status and priority pickers, labels and due date fields, relations (parent, subtasks, blocked by, blocks), linked sessions (with "Switch to it" in the desktop app), the description editor, comments, key points and the activity log.

### Comments wake the owning session

A comment you write on the board (pane, preview or web app) goes to the session that owns the ticket: the live session working on it, else the most recently seen live session that worked on it. That session gets the comment as a prompt as soon as it is idle, handles it, replies with a comment and moves the ticket to In review. Each comment is delivered once, by one session.

### A new session per ticket

"Do in a new session" in the detail view, or dragging a ticket from To do to In progress (when no session is already working on it), asks Claude in the current session to prepare a new session for that ticket with the desktop app's `spawn_task`. That leaves a chip in the conversation; you click it to open the session. It takes one click because a plugin cannot open a session itself: only Claude can call the app's session tools, and `spawn_task` offers a session rather than starting one, so you stay in control of what opens. The new session's first prompt claims the ticket, and its title follows the ticket's status (for example `【Oct 3 - in progress】APP-3 Login page`).

For a ticket you start from the web app, one live session (the ticket's owner, else the most recently active one) prepares the chip.

Other buttons in the detail view: "Continue in this session", "Ask <session> for progress" (sends a message to the session working on it) and "Verify actual state" (Claude checks commits, branches and PRs and updates the ticket).

### History weeks

Use the previous / next week buttons to see the board as it stood at the end of an earlier week. Past weeks are read-only.

### Language and theme

The language button switches the UI between English and Chinese; the choice is remembered. Ticket titles and descriptions are stored in both languages (Claude fills in the missing side). Prompts and tool text sent to Claude stay in Chinese.

The theme button cycles Follow Claude, Light and Dark. Follow Claude reads the desktop app's theme setting (`userThemeMode` in its `config.json`) and, when that is "system", the macOS appearance.

### The web app

`/kanban-web` starts the local web app if it is not running and replies with its address, `http://127.0.0.1:4790` (the header's web link opens `http://localhost:4790`). Every session also starts it at session start when nothing answers on that port. It shows the same board and lets you create tickets, drag, comment, edit descriptions and priorities, and accept or send back. It binds to 127.0.0.1 only and refuses cross-site writes.

To run it by hand from the repository:

```sh
deno run --allow-read --allow-write --allow-env --allow-net=127.0.0.1 --allow-run=claude,defaults web/server.ts
```

Stop it with `pkill -f cc-taskboard/web/server.ts`. Restart it after changing `hooks/core.ts`. `WB_PORT` sets another port for a manual run; the plugin always uses 4790.

## Data

Everything is local; nothing leaves your machine. The data directory is `~/.claude/cc-taskboard/`, or the path in the environment variable `CC_TASKBOARD_DATA` (read by both the plugin and the web app):

- `events/<session-id>.jsonl`: one append-only event log per session; `events/web.jsonl` holds the web app's writes, `events/init-<date>.jsonl` one init wizard run.
- `sessions/<session-id>.json`: each session's state (current ticket, busy / idle, last seen).
- `projects.json`: the boards. A list of `{ "id": "APP", "name": "...", "name_en": "...", "match": "<regex on the session's cwd>", "root": "<default repo path>", "color": "#8394e6", "icon": "grid" }`; `id` is the ticket key prefix, the first board whose `match` fits a session's working directory owns it. Leave `id` out and the board gets a default prefix (its English name's initials, e.g. Board Dev → BD; a one-word name gives its first three letters), written back to the file. The init wizard writes this file; you can edit it by hand, or change every board's prefix and names on the web app's **Board settings** page: a new prefix rekeys that board's tickets with their numbers kept (WB-12 → KB-12), and the old keys still find them. Changing back to an earlier prefix is fine.
- `spawned.json`: sessions the board opened (their titles follow their ticket).
- `web.log`: the web app's output.

Back up: copy the directory. Reset: stop the web app, then move or delete the directory; the next session starts empty. To undo one init wizard run, delete its `events/init-<date>.jsonl`.

## Contributing / developing

Run the checks in the repository before you commit:

```sh
claude plugin validate .
claude plugin test .
deno test --allow-all web/
```

`claude plugin test .` runs `hooks/*.test.ts` against an in-memory file system and a fake `HOME`; no test touches your data or starts a server. `web/server_test.ts` uses temporary directories and its own ports.

Notes:

- `hooks/core.ts` is the pure logic shared by the plugin and the web app; the web app needs a restart after it changes.
- `.claude-plugin/types/` is generated by Claude Code for editor type-checking and is not committed (`tsconfig.json` extends it).
- A plugin copy under a path containing `/dev-mods/` never starts the web app.

### Editing from several sessions

When more than one Claude session may edit the plugin, follow this protocol (it exists because two sessions once overwrote each other's work):

1. Before touching the source, write a lock file `<data dir>/EDITING` with the session name, the time and the ticket; delete it when done. If a lock exists, ask the session holding it first.
2. There is one source of truth, the repository folder the plugin is loaded from. Edit there. Any staging or hot-reload copy is synced from it, never back.
3. Never sync with `--delete`. Dry-run first (`rsync -n`) and exclude `.claude-plugin/types/`, `web.log` and `.claude/` (the latter holds plugin state of sessions working in that folder, stale in a staging copy). To check whether the source changed while you were staging, use `find <source> -newer <data dir>/EDITING`, not the copied files (`rsync -a` preserves their mtimes).
4. Do not write the pre-sync guard as `set -e` plus `test ... && echo`: a failing check does not stop such a script.

## Uninstall

1. Remove the repository path from `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` / `CLAUDE_CODE_PLUGIN_DIR_WATCH` if nothing else needs them).
2. Restart your sessions.
3. Stop the web app: `pkill -f cc-taskboard/web/server.ts`.
4. Optionally delete the data directory `~/.claude/cc-taskboard/` and the repository.

## Migrating from weekly-board

cc-taskboard is the renamed weekly-board plugin.

- Data: while `~/.claude/cc-taskboard/` does not exist and `~/.claude/weekly-board/` does, both the plugin and the web app keep using the old directory, so nothing has to move. To switch to the new name, stop the web app and all sessions, then `mv ~/.claude/weekly-board ~/.claude/cc-taskboard`. (The web app's old `WB_DATA` variable still works; `CC_TASKBOARD_DATA` wins over it.)
- Tool name: `mcp__weekly-board__ticket` is now `mcp__cc-taskboard__ticket`. Prompts or notes that name the old tool need the new name.
- Settings: point `CLAUDE_CODE_PLUGIN_DIRS` at the cc-taskboard folder instead of the weekly-board one. Do not load both: they would both track every session.
- Restart running sessions: a session registers the tool when it starts, so a session started before the switch still has the old tool. Stop a web app started by the old plugin (`pkill -f weekly-board/web/server.ts`) so the new one can start on port 4790.
- Your language and theme choices are kept in the plugin's own store, which is per plugin name; you may need to pick them again.

## Acknowledgements

Special thanks to [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) by chuspeeism, a task board for Codex and DeepSeek Harness. Its idea of linking every task to the agent session that works on it, and of keeping the board as a panel of its own next to the sessions, inspired cc-taskboard. cc-taskboard shares no code with it.
