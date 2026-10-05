# 安装

[English](INSTALL.md) · 简体中文

仓库本身就是一个插件 marketplace。下面的步骤人可以照着做，Claude 也可以照着执行。

1. **打开 function-hook 插件。** 在 `~/.claude/settings.json` 的 `env` 里合并进这个键，保留原有的所有键：

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
   ```

2. **检查有没有从目录加载的副本。** 如果 `env` 里的 `CLAUDE_CODE_PLUGIN_DIRS` 指向某个 `cc-taskboard` 或 `weekly-board` 目录，先停下来问用户：加载两份会让每个会话被记两次。

3. **添加 marketplace 并安装插件：**

   ```sh
   claude plugin marketplace add DogShark129/cc-taskboard
   claude plugin install cc-taskboard@cc-taskboard
   ```

   在 Claude Code 会话里等价的写法是先 `/plugin marketplace add DogShark129/cc-taskboard`，再 `/plugin install cc-taskboard@cc-taskboard`。需要有这个 GitHub 仓库的读权限。

4. **检查 Deno、git 和 gh。** 网页版跑在 Deno 2.x 上。`command -v deno` 找不到时，先问用户，再用 `brew install deno` 安装（没有 Homebrew 就用 `curl -fsSL https://deno.land/install.sh | sh`）。没有 Deno 时，面板和 ticket 工具照常能用，只有网页用不了。缺 git 或 gh 时，告诉用户自动状态规则需要它们，不要替用户装。

5. **在当前会话里加载插件。** 请用户输入 `/reload-plugins`（Claude 不能执行斜杠命令）。装完之后新开的会话会自己加载；如果某个会话没有 `/reload-plugins`，就新开一个会话。

6. **初始化看板。** 插件加载后，运行 ticket 工具的 init 向导（`mcp__cc-taskboard__ticket`，`action: "init"`），或者由用户说「初始化看板」。向导写入前会先请用户确认。之后随时用 `/kanban` 打开看板。

## 更新

新版本只有在 `version` 变了时才会推给你。用 `claude plugin update cc-taskboard@cc-taskboard` 更新（或在 `/plugin` 的 **Installed** 页里更新），也可以在 `/plugin` → **Marketplaces** 里为这个 marketplace 打开自动更新。更新后在会话里输入 `/reload-plugins`，或者新开一个会话。

## 团队使用

想在团队共用的某个仓库里提供这个插件，在那个仓库的 `.claude/settings.json` 里加上：

```json
{
  "extraKnownMarketplaces": {
    "cc-taskboard": { "source": { "source": "github", "repo": "DogShark129/cc-taskboard" } }
  },
  "enabledPlugins": { "cc-taskboard@cc-taskboard": true }
}
```

每个队友仍然要做上面的第 1 步，并且要有仓库的读权限。

## 从克隆加载（开发用）

1. 把仓库克隆到一个固定位置：

   ```sh
   git clone https://github.com/DogShark129/cc-taskboard.git ~/code/cc-taskboard
   ```

2. 在 `~/.claude/settings.json` 的 `env` 里加上插件目录：

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/code/cc-taskboard",
       "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
       "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
     }
   }
   ```

   - `CLAUDE_CODE_PLUGIN_DIRS`：插件目录的绝对路径（可以用 `~`；多个用 `:` 分隔）。
   - `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`（可选）：长时间运行的会话（桌面 app、SDK）在插件文件变化时自动重载。交互式终端会话本来就会监视该目录。

   想先在单个终端会话里试：`claude --plugin-dir ~/code/cc-taskboard`（环境里要有 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）。

不要同时再从 marketplace 安装一份，否则两份都会追踪每个会话。

## 卸载

1. 运行 `claude plugin uninstall cc-taskboard@cc-taskboard`（再 `claude plugin marketplace remove cc-taskboard`）。如果是从克隆加载的：从 `~/.claude/settings.json` 的 `CLAUDE_CODE_PLUGIN_DIRS` 里去掉仓库路径。如果没有别的插件需要，也去掉 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` / `CLAUDE_CODE_PLUGIN_DIR_WATCH`。
2. 重启会话。
3. 停掉网页版：`pkill -f 'cc-taskboard.*/web/server.ts'`。
4. 可选：删除数据目录 `~/.claude/cc-taskboard/`（以及克隆的仓库）。

## 从 weekly-board 迁移

cc-taskboard 就是改了名的 weekly-board 插件。

- 数据：只要 `~/.claude/cc-taskboard/` 不存在而 `~/.claude/weekly-board/` 存在，插件和网页版都会继续用旧目录，什么都不用搬。想换成新名字：停掉网页版和所有会话，然后 `mv ~/.claude/weekly-board ~/.claude/cc-taskboard`。（网页版原来的 `WB_DATA` 变量仍然有效，`CC_TASKBOARD_DATA` 优先于它。）
- 工具名：`mcp__weekly-board__ticket` 改成了 `mcp__cc-taskboard__ticket`。提到旧工具名的提示或笔记要换成新名字。
- 设置：把 `CLAUDE_CODE_PLUGIN_DIRS` 指向 cc-taskboard 目录，而不是 weekly-board 目录。不要两个都加载，否则两份插件都会追踪每个会话。
- 重启正在运行的会话：会话在启动时注册工具，切换前启动的会话里仍是旧工具。停掉旧插件启动的网页版（`pkill -f weekly-board/web/server.ts`），新插件才能在 4790 端口启动自己的。
- 语言和主题的选择存在插件自己的 store 里，按插件名区分，可能需要重新选一次。
