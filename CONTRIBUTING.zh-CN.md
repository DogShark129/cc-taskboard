# 参与开发

[English](CONTRIBUTING.md) · 简体中文

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

## 多会话同时修改

可能有多个 Claude 会话同时改插件时，按这个协议来（曾经有两个会话互相覆盖过改动）：

1. 动源码前写锁文件 `<数据目录>/EDITING`，写上会话名、时间和工单；改完删掉。锁已存在时，先问持锁的会话。
2. 唯一的源码是加载插件的那个仓库目录，直接在那里改。任何暂存或热重载副本都从它同步过去，绝不反向。
3. 同步永远不用 `--delete`。先预演（`rsync -n`），并排除 `.claude-plugin/types/`、`web.log` 和 `.claude/`（后者是在该目录工作的会话的插件状态，在暂存副本里是旧的）。要查暂存期间源码有没有被改，用 `find <源码目录> -newer <数据目录>/EDITING`，不要拿复制出来的文件作参照（`rsync -a` 会保留 mtime）。
4. 同步前的保护检查不要写成 `set -e` 加 `test ... && echo`：这种写法检查失败时脚本照样往下跑。
