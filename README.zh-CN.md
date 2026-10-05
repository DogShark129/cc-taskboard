# cc-taskboard

[English](README.md) | 简体中文

cc-taskboard 是一个 Claude Code 插件：在你所有的 Claude Code 会话之间维护同一块 Jira 风格的任务看板。每个会话把自己在做的事写进一份共享的本地事件日志；每个会话（以及一个本地网页版）都把这些日志折叠成同一块看板。Claude 拿到一个 `ticket` 工具来建票、改票；Claude 提交代码、开 PR、合并 PR 或向你提问时，插件会自己挪票。你负责审核、评论、拖拽和验收；你的评论会唤醒负责这张票的会话。

## 快速开始

**1. 打开 function-hook 插件**（只需一次）。把下面这段加进 `~/.claude/settings.json`，和已有内容合并：

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

也可以让 Claude 来改：在任意会话里说 *「在我的 ~/.claude/settings.json 的 env 里加上 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1」*。

**2. 安装。** 在任意 Claude Code 会话里（终端或桌面 app 的 Code tab）：

```
/plugin marketplace add DogShark129/cc-taskboard
/plugin install cc-taskboard@cc-taskboard
```

**3. 重启 Claude Code，然后建看板。** 在任意会话里说：

```
初始化看板
```

Claude 会扫描你最近的会话，提出看板划分（每个项目一个）和工单，你确认之前什么都不写。之后随时用 `/kanban` 打开看板。

## 功能

- 跨所有 Claude Code 会话的 Jira 风格看板，在每个会话里以面板形式显示。
- 给 Claude 的 `ticket` 工具（`mcp__cc-taskboard__ticket`）：list、create、update，以及初始化向导。
- 状态自动更新：来自 git 和 GitHub（`git commit`、`gh pr create`、`gh pr merge`）、来自改文件、来自 Claude 的提问（`AskUserQuestion`）。
- 审核关卡：Claude 最多只能把票推到「待审核」，只有你能验收进「已完成」。取消也由你决定：Claude 只能带理由提议取消。
- 评论唤醒：你在票上留的评论会送到负责这张票的会话，由它处理。
- 一票一会话：「开新会话做」（或把票从待开工拖到进行中）会让 Claude 为这张票准备一个新会话；看板开出来的会话标题会跟着票的状态变。
- 按项目分 board，按会话的工作目录归属。
- 历史周：往回翻看之前各周，只读。
- 双语界面（中文 / English），在看板上切换；工单标题和描述两种语言都存。
- 主题跟随 Claude 桌面 app（也可固定浅色 / 深色）。
- 本地网页版，地址 `127.0.0.1:4790`，同一块看板。

许可证：[MIT](LICENSE)。

## 环境要求

- 支持 function-hook 插件的 Claude Code。本插件在 Claude Code 2.1.286 上开发和测试。
- 桌面 app 相关功能需要 macOS：主题跟随、会话标题、初始化向导扫描最近会话，都读 Claude 桌面 app 在 `~/Library/Application Support/Claude/` 下的文件。看板本身在别的系统上也能用。
- 网页版需要 [Deno](https://deno.com) 2.x（可选；会话里的看板不需要）。
- `git` 和 `gh` 可选，它们驱动自动状态规则。
- 有这个 GitHub 仓库的读权限。

## 使用

### 面板

看板会在你发出第一条消息时停靠到会话的面板侧栏。你手动关掉后，本会话内不再自动打开；`/kanban` 或 `/taskboard` 可以重新打开。

- 标题区：看板标题和 ISO 周数、日期范围、本周剩余天数、本周统计（新建、完成、提交）。周导航（上一周 / 下一周 / 回到本周）、网页版链接、主题按钮（跟随 Claude / 浅色 / 深色）和语言按钮（EN / 中文）。
- 项目页签：每个 board 一个，红色数字是等你拍板的工单数；另有「全部」，把所有 board 按泳道显示。
- 筛选：「只看等我的」（只看「等我拍板」列）和「正在做的」（有会话正在做的工单）；搜索框（编号、标题、标签）；「看板」/「动态」（实时动态流）。
- 「在做：」一行列出正忙的会话和各自在做的工单。
- 卡片显示标题、编号、优先级、标签、阻塞、截止日期、有会话在做时的「在做」标记、在当前列停留的天数（超过 7 天变红）、评论数和 PR。

### ticket 工具

Claude 调用 `mcp__cc-taskboard__ticket`，带一个 `action`：

- `list`：未完成的工单，可用 `q` 过滤（编号、标题、标签）。
- `create`：新建工单。要 `title` 和 `title_en`（两种语言），可选 `col`、`desc` / `desc_en`、`priority`（P0 到 P3）、`labels`、`due`（YYYY-MM-DD）、`blockedBy`、`parent`、`note`、`comment`、`project`。`src: "me"` 表示是你要求加的（「加到看板」）。
- `update`：修改 `key` 指定工单的上述字段；`work: true` 表示本会话认领这张票。
- `init`：初始化向导。不带 plan 返回扫描结果；带 `plan` 返回预览；带同一个 `plan` 加 `confirm: true` 才写入。

Claude 会被告知：开始一件具体的事之前先查有没有现成的票，再认领或新建。规则写在工具说明里，你一般不用提它。

### 列与审核关卡

等我拍板、待开工、进行中、待跟进（等别人：PR 评审、对方回复）、待审核、已完成，以及已取消（只在有票时显示；拖拽卡片时也作为放置目标出现）。

对会话当前工单的自动移动：

- 工单在待开工或待跟进时 Claude 改了文件：进行中。
- `gh pr create`：待跟进，并记下 PR 号。`git commit` 会把提交记到工单上。
- `gh pr merge`：待审核。
- Claude 向你提问：等我拍板，你回答后回到原来的列。

Claude 最多只能把票移到待审核。Claude 传 `done` 会落到待审核，除非你在对话里明确说验收通过（工具的 `userAccepted`）。在看板上，「验收通过」移到已完成，「打回」退回进行中。

取消也一样。Claude 传 `canceled` 会落到等我拍板，成为「建议取消」，而且必须带理由（`comment` 或 `note`）；卡片、预览和详情上会出现「确认取消」和「保留」（回到原来的列）。只有你在对话里明确说取消时（`userAccepted`），Claude 才能直接取消。任何工单你都可以在预览或详情里「取消工单」（详情和网页版可以选填理由），或拖到已取消；动态流会显示谁取消了什么、为什么。已取消的工单可以「恢复」，回到取消前所在的列。

面板里，待开工、已完成和已取消收起在清单下方；网页版的已完成和已取消收起在「展开」按钮后面。之前各周已完成和已取消的票会从当前看板归档；搜索仍能找到已归档的已取消工单。

### 面板、预览与详情

面板是一份清单：等我拍板、进行中、待审核、待跟进分节列出，一票一行；上面一条状态条，点图例可以隐藏或显示某个状态；待开工、已完成和已取消收起在下方。点一行的任意位置，预览展开在这一行下面（再点一次收起；手机上点标题）：状态和优先级选择、「打开详情」、「开新会话」、「跳到会话」、取消或恢复、描述、最近评论和评论框。网页版里把卡片拖到另一列即可移动；点卡片弹出的预览包含详情页的全部内容。详情页有状态和优先级选择、标签和截止日期输入（仅面板）、关系（父任务、子任务、被卡于、卡着）、关联会话（每个都有「切过去」）、「开新会话」、描述编辑、评论、要点和活动记录。网页上的「开新会话」和「切过去」通过桌面 app 的 `claude://` 链接打开，和面板用的是同一套链接。

### 评论唤醒负责的会话

你在看板上（面板、预览或网页版）写的评论会送到负责这张票的会话：正在做它的 live 会话，否则是最近活跃过、做过它的 live 会话。那个会话一空闲就会收到这条评论作为一条提示，处理后用评论回复，并把票移到待审核。每条评论只投递一次，只由一个会话处理。

### 一票一会话

详情页的「开新会话做」，或把票从待开工拖到进行中（且还没有会话在做它），会让当前会话的 Claude 用桌面 app 的 `spawn_task` 为这张票准备一个新会话。对话里会出现一张卡片，你点一下才打开那个会话。之所以要点一下：插件自己不能开会话，只有 Claude 能调用 app 的会话工具，而 `spawn_task` 只是提供一个会话入口、不会直接启动，所以开什么由你决定。新会话的第一句提示会认领这张票，它的标题会跟着票的状态变（例如 `【Oct 3 - in progress】APP-3 登录页改版`）。

在网页版上开工的票，由一个 live 会话（票的负责会话，否则是最近活跃的那个）来准备这张卡片。

详情页的其他按钮：「在本会话继续」、「问 <会话> 进度」（给正在做的会话发消息）和「核对实际状态」（Claude 核对提交、分支和 PR 后更新工单）。

### 历史周

用上一周 / 下一周按钮查看某一周结束时的看板。历史周只读。

### 语言与主题

语言按钮在中文和英文界面之间切换，选择会被记住。工单标题和描述两种语言都存（缺的一边由 Claude 补齐）。发给 Claude 的提示和工具说明保持中文。

主题按钮在跟随 Claude、浅色、深色之间循环。跟随 Claude 读桌面 app 的主题设置（其 `config.json` 里的 `userThemeMode`），设置为 system 时看 macOS 的外观。

### 网页版

`/kanban-web` 会在网页版没运行时启动它，并回复地址 `http://127.0.0.1:4790`（标题区的网页版链接打开 `http://localhost:4790`）。每个会话启动时，如果这个端口没有响应，也会自动启动它。网页版显示同一块看板，可以新建工单、拖拽、评论、改描述和优先级、验收或打回。它只监听 127.0.0.1，并拒绝跨站写入。

在仓库里手动运行：

```sh
deno run --allow-read --allow-write --allow-env --allow-net=127.0.0.1 --allow-run=claude,defaults web/server.ts
```

停止：`pkill -f cc-taskboard/web/server.ts`。改了 `hooks/core.ts` 之后要重启它。`WB_PORT` 可以给手动运行换端口；插件始终用 4790。

## 数据

一切都在本地，不会离开你的电脑。数据目录是 `~/.claude/cc-taskboard/`，或环境变量 `CC_TASKBOARD_DATA` 指定的路径（插件和网页版都读它）：

- `events/<会话 id>.jsonl`：每个会话一份只追加的事件日志；`events/web.jsonl` 是网页版的写入，`events/init-<日期>.jsonl` 是一次初始化向导的写入。
- `sessions/<会话 id>.json`：每个会话的状态（当前工单、忙 / 闲、最后活跃时间）。
- `projects.json`：board 配置。一个列表，每项形如 `{ "id": "APP", "name": "...", "name_en": "...", "match": "<匹配会话 cwd 的正则>", "root": "<默认仓库路径>", "color": "#8394e6", "icon": "grid" }`；`id` 是工单编号前缀，第一个 `match` 命中会话工作目录的 board 拥有该会话。不写 `id` 时自动给一个默认前缀（取英文名首字母，如 Board Dev → BD；名字只有一个词时取前三个字母），并写回文件。初始化向导会写这个文件，你也可以手改，或者在 web 版的**看板设置**页统一改所有看板的前缀和名称：改了前缀，这个看板的票会一起改编号、数字不变（WB-12 → KB-12），用旧编号还能找到；也可以改回以前的前缀。
- `spawned.json`：看板开出来的会话（它们的标题跟着工单走）。
- `web.log`：网页版的输出。

备份：复制整个目录。重置：先停网页版，再移走或删除这个目录，下一个会话从空看板开始。撤销某一次初始化向导：删掉它的 `events/init-<日期>.jsonl`。

## 参与开发

提交前在仓库里跑这些检查：

```sh
claude plugin validate .
claude plugin test .
deno test --allow-all web/
```

`claude plugin test .` 在内存文件系统和假的 `HOME` 下跑 `hooks/*.test.ts`，测试不会碰你的数据，也不会启动服务。`web/server_test.ts` 用临时目录和自己的端口。

说明：

- `hooks/core.ts` 是插件和网页版共用的纯逻辑；改了它要重启网页版。
- `.claude-plugin/types/` 由 Claude Code 生成，用于编辑器类型检查，不提交（`tsconfig.json` 继承它）。
- 路径里含 `/dev-mods/` 的插件副本永远不会启动网页版。
- 发布新版本时改 `.claude-plugin/plugin.json` 里的 `version`：已安装的副本只在它变化时才更新。

### 多会话同时修改

可能有多个 Claude 会话同时改插件时，按这个协议来（曾经有两个会话互相覆盖过改动）：

1. 动源码前写锁文件 `<数据目录>/EDITING`，写上会话名、时间和工单；改完删掉。锁已存在时，先问持锁的会话。
2. 唯一的源码是加载插件的那个仓库目录，直接在那里改。任何暂存或热重载副本都从它同步过去，绝不反向。
3. 同步永远不用 `--delete`。先预演（`rsync -n`），并排除 `.claude-plugin/types/`、`web.log` 和 `.claude/`（后者是在该目录工作的会话的插件状态，在暂存副本里是旧的）。要查暂存期间源码有没有被改，用 `find <源码目录> -newer <数据目录>/EDITING`，不要拿复制出来的文件作参照（`rsync -a` 会保留 mtime）。
4. 同步前的保护检查不要写成 `set -e` 加 `test ... && echo`：这种写法检查失败时脚本照样往下跑。

## 更多安装方式

### 在 shell 里安装

```sh
claude plugin marketplace add DogShark129/cc-taskboard
claude plugin install cc-taskboard@cc-taskboard
```

### 更新

新版本只有在 `version` 变了时才会推给你。用 `claude plugin update cc-taskboard@cc-taskboard` 更新（或在 `/plugin` 的 **Installed** 页里更新），也可以在 `/plugin` → **Marketplaces** 里为这个 marketplace 打开自动更新。更新后重启会话。

### 团队使用

想在团队共用的某个仓库里提供这个插件，在那个仓库的 `.claude/settings.json` 里加上：

```json
{
  "extraKnownMarketplaces": {
    "cc-taskboard": { "source": { "source": "github", "repo": "DogShark129/cc-taskboard" } }
  },
  "enabledPlugins": { "cc-taskboard@cc-taskboard": true }
}
```

每个队友仍然要做「快速开始」的第 1 步，并且要有仓库的读权限。

### 从克隆加载（开发用）

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

## 特别感谢

特别感谢 chuspeeism 的 [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)，一个支持 Codex 和 DeepSeek Harness 的任务面板。它把每个任务和处理它的 agent 会话关联起来、让看板作为独立面板放在会话旁边的思路，启发了 cc-taskboard。cc-taskboard 没有使用它的代码。
