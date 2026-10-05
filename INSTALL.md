# Install

English · [简体中文](INSTALL.zh-CN.md)

The repository is its own plugin marketplace. These steps work for a person or for Claude following them.

1. **Turn on function-hook plugins.** In `~/.claude/settings.json`, merge this key into the `env` block, keeping every key already there:

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
   ```

2. **Check for a copy loaded from a folder.** If the `env` block has `CLAUDE_CODE_PLUGIN_DIRS` pointing at a `cc-taskboard` or `weekly-board` folder, stop and ask the user: loading two copies tracks every session twice.

3. **Add the marketplace and install the plugin:**

   ```sh
   claude plugin marketplace add DogShark129/cc-taskboard
   claude plugin install cc-taskboard@cc-taskboard
   ```

   Inside a Claude Code session the same is `/plugin marketplace add DogShark129/cc-taskboard`, then `/plugin install cc-taskboard@cc-taskboard`. You need read access to the GitHub repository.

4. **Check Deno, git and gh.** The web page runs on Deno 2.x. If `command -v deno` finds nothing, ask the user first, then install it with `brew install deno` (without Homebrew: `curl -fsSL https://deno.land/install.sh | sh`). Without Deno the pane and the ticket tool still work; only the web page does not. If git or gh is missing, tell the user that the automatic status rules need them; do not install them for the user.

5. **Load the plugin in this session.** Ask the user to type `/reload-plugins` (Claude cannot run slash commands). Sessions started after the install load it on their own; if a session has no `/reload-plugins`, start a new one.

6. **Set up the boards.** Once the plugin is loaded, run the init wizard of the ticket tool (`mcp__cc-taskboard__ticket`, `action: "init"`), or the user says `set up the task board`. The wizard asks the user to confirm before it writes anything. Open the board any time with `/kanban`.

## Updates

A release reaches you when its `version` changes. Update with `claude plugin update cc-taskboard@cc-taskboard` (or from the **Installed** tab of `/plugin`), or turn on auto-update for the marketplace under `/plugin` → **Marketplaces**. Afterwards type `/reload-plugins` in a session, or start a new one.

## For a team

To offer the plugin in a repository your team shares, add this to that repository's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "cc-taskboard": { "source": { "source": "github", "repo": "DogShark129/cc-taskboard" } }
  },
  "enabledPlugins": { "cc-taskboard@cc-taskboard": true }
}
```

Each teammate still needs step 1 above and read access to the repository.

## From a clone (for development)

1. Clone the repository somewhere permanent:

   ```sh
   git clone https://github.com/DogShark129/cc-taskboard.git ~/code/cc-taskboard
   ```

2. Add the plugin folder to `~/.claude/settings.json`, in its `env` block:

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
   - `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` (optional): long-lived sessions (desktop app, SDK) reload the plugin when its files change. Interactive terminal sessions watch the folder anyway.

   To try it in a single terminal session first: `claude --plugin-dir ~/code/cc-taskboard` (with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment).

Do not also install it from the marketplace: both copies would track every session.

## Uninstall

1. Run `claude plugin uninstall cc-taskboard@cc-taskboard` (and `claude plugin marketplace remove cc-taskboard`). From a clone instead: remove the repository path from `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. Drop `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` / `CLAUDE_CODE_PLUGIN_DIR_WATCH` too if nothing else needs them.
2. Restart your sessions.
3. Stop the web app: `pkill -f 'cc-taskboard.*/web/server.ts'`.
4. Optionally delete the data directory `~/.claude/cc-taskboard/` (and the clone).

## Migrating from weekly-board

cc-taskboard is the renamed weekly-board plugin.

- Data: while `~/.claude/cc-taskboard/` does not exist and `~/.claude/weekly-board/` does, both the plugin and the web app keep using the old directory, so nothing has to move. To switch to the new name, stop the web app and all sessions, then `mv ~/.claude/weekly-board ~/.claude/cc-taskboard`. (The web app's old `WB_DATA` variable still works; `CC_TASKBOARD_DATA` wins over it.)
- Tool name: `mcp__weekly-board__ticket` is now `mcp__cc-taskboard__ticket`. Prompts or notes that name the old tool need the new name.
- Settings: point `CLAUDE_CODE_PLUGIN_DIRS` at the cc-taskboard folder instead of the weekly-board one. Do not load both: they would both track every session.
- Restart running sessions: a session registers the tool when it starts, so a session started before the switch still has the old tool. Stop a web app started by the old plugin (`pkill -f weekly-board/web/server.ts`) so the new one can start on port 4790.
- Your language and theme choices are kept in the plugin's own store, which is per plugin name; you may need to pick them again.
