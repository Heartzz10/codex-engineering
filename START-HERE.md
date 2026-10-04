# 开始使用 CE

[English overview](README.en.md) · [使用案例](USE-CASES.md) · [常见问题](FAQ.md)

将 CE 接入 Codex 后，在项目里描述你想完成的事。CE 按任务选择需求、调查、设计、实施和验证方法。

## 让 Codex 帮你安装

复制下面整段，发给 Codex：

```text
请帮我安装 CE：https://github.com/Heartzz10/codex-engineering
先读取仓库的 START-HERE.md，检查 Node.js 22+ 和已有 CE 安装。
首次安装请把仓库获取到本机长期保留的目录，运行 scripts/install-ce.mjs，核对安装后的版本和入口。
已有 CE 时保留自定义规则、运行绑定、项目配置与历史，先备份并检查兼容，再沿原位置处理升级，避免重复安装同名 Skill。
只将运行绑定和记录保存在本机私有目录。完成后告诉我如何在项目中启用 CE。
```

Codex 会先核对环境，再获取 CE 和执行安装。你需要能使用的 Codex，以及 Node.js 22 或更新版本；缺少环境时可由 Codex 帮你处理。CE 的运行文件夹在安装后继续保留。

## 自己使用命令行安装

准备好 Git 和 Node.js 22+，在准备长期保留 CE 的位置执行：

```sh
git clone https://github.com/Heartzz10/codex-engineering.git
cd codex-engineering
node scripts/install-ce.mjs
```

这条路径用于首次安装。安装器核对公开文件清单，复制清单内的 CE Skill，在本机生成私有绑定，再运行入口核对版本。它无需 npm 安装或 Jev 密钥。

如果发现已有 CE，安装器会保留原文件并停止；把上述安装请求发给 Codex，让它按原位置备份、核兼容后升级。

## 使用下载链接

[下载 CE ZIP](https://github.com/Heartzz10/codex-engineering/archive/refs/heads/main.zip)，解压到准备长期保留的文件夹。然后将下面这段话发给 Codex，并补上你的解压路径：

```text
请从我解压的 CE 文件夹安装，路径是：<填入解压目录>。
读取该目录的 START-HERE.md，检查 Node.js 和已有 CE。
首次安装运行 scripts/install-ce.mjs；已有安装时保留自定义内容、配置和历史，备份后检查兼容再升级。
完成后核对版本与入口，告诉我如何启用 CE。
```

## 接入步骤（供 Codex 执行）

1. 读取 package.json，核 Node.js 22+，记录本包绝对路径；检查用户 `~/.agents/skills`、旧 `~/.codex/skills`、实际 CODEX_HOME 及当前客户端配置中的同名 Skill。
2. 新安装执行 `node scripts/install-ce.mjs`。默认 Skill 位于 `~/.agents/skills/codex-engineering`，状态位于 `~/.codex/ce-state`；设置 CODEX_HOME 时状态随该私有目录保存。安装器支持 `--home DIR` 在独立目录核验。
3. 已有安装沿用实际位置。先核版本、自定义修改、runtime 和绑定的项目配置，备份后按项目现有升级机制处理；不改其他 Skill、全局 AGENTS 或项目源码，不强制覆盖用户修改。
4. 核 runtime.json 的 packageRoot、stateRoot、packageVersion 与本次包匹配，运行安装后 Skill 的 `scripts/engineering.mjs --help`。文件夹来源、版本或配置不匹配时先修复。
5. 在新对话选择 `$codex-engineering`；需要时重启客户端。[Codex 官方目录说明](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)解释 Skill 发现方式。

接入的本机绑定不提交到仓库。核心流程使用本地文件与项目已有工具，Jev 日常用途保持默认关闭。

## 在你的项目中使用

打开你准备修改的项目，新建对话，发送：

> 使用 $codex-engineering 处理这个项目。先读当前约定和进度，沿用有效决定，完成这次需求及必要验证。

需要程序检查或真实验收时，Codex 读取项目已有文档、检查入口和实际环境，将项目配置放入私有状态目录的 profiles 下。配置结构参考 [project-profile.example.json](examples/project-profile.example.json)：使用真实项目根、文档、环境、检查命令与权限，以及本机实际可执行文件路径。

检查登记完成后，通过 `doctor --project 项目目录` 核对绑定；已有配置可用 `doctor --profile 配置文件`。然后选择本次登记检查和实际验收入口。

## 描述你要的结果

- 新增功能：“给资料库加搜索，比较现有能力和成熟方案，完成搜索链路。”
- 设计交互：“做一个预约页面，整理成功条件，设计表单和状态反馈。”
- 修复故障：“保存后重启内容丢失，复现并查原因，再修复和核对读回。”
- 小范围调整：“按钮改成‘保存’，检查受影响页面后结束。”
- 接续任务：“从上次记录继续，沿用完成项，处理剩余待办。”

## 查看完成结果

任务结束时，Codex 应说明改变了什么、实际验证了什么、沿用了哪些证据、当前运行状态，以及需要你决定的事项。页面和业务通过实际账号、实际入口操作，核对保存、查询等结果。

## 更新与恢复

更新时保留原 CE 文件夹、Skill 和 runtime 备份，核对项目配置兼容，再切换到新目录并检查入口。恢复时还原原 Skill 与 runtime，核对原版本；项目历史与业务数据继续保留。

[验证记录](PUBLIC-VALIDATION.md)列出已有环境与实测范围，[技术架构](ARCHITECTURE.md)说明工具和记录怎样配合。
