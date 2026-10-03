# 开始使用 CE

将 CE 接入 Codex 后，在项目里描述你想完成的事。CE 会按任务选择需求、调查、设计、实施和验证方法。

## 准备环境

你需要能够使用的 Codex，以及 Node.js 22 或更新版本。可以让 Codex先检查环境；Codex 服务使用你的现有账号方案。

[下载并解压 CE](https://github.com/Heartzz10/codex-engineering/archive/refs/heads/main.zip)。这个文件夹是 CE 的运行目录，安装后继续保留它。

## 交给 Codex 接入

在 Codex 中打开 CE 文件夹，发送：

> 请按 START-HERE.md 将 CE 接入我的 Codex。先检查 Node.js 和已有 CE 安装，保留现有规则、配置和项目文件；将运行绑定与记录留在本机私有目录。接入后核对版本与入口，并告诉我怎样在项目里开始使用。

Codex 按下面的步骤接入：

1. 读取本包 package.json，确认版本与 Node.js 要求，记录当前 CE 运行目录的绝对路径。
2. 核对已安装的同名 Skill；已有版本时沿用实际位置，先核版本与自定义修改，升级前备份该 Skill 和绑定。不重复安装同名入口，不改其他 Skill、全局 AGENTS 或项目源码。
3. 新安装将 `skills/codex-engineering` 放入用户 Skill 目录 `~/.agents/skills/codex-engineering`。Codex 的目录说明见[官方 Skill 文档](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)。
4. 选择本机私有状态目录，例如 `~/.codex/ce-state`；在安装后的 Skill 内生成 runtime.json，三个字段为：packageRoot（本包绝对路径）、stateRoot（私有状态绝对路径）、packageVersion（本包版本）。这些本机配置不提交到仓库。
5. 运行安装后 Skill 的 `scripts/engineering.mjs --help`，核对版本、packageRoot 与 stateRoot。Codex 自动发现 Skill；需要时重启客户端，再在新对话中选择 `$codex-engineering`。

接入过程只需公开 Skill 和本机绑定。Jev 默认关闭，核心流程不要求外部判断服务的密钥。

## 在你的项目中使用

打开你准备修改的项目，发送：

> 使用 $codex-engineering 处理这个项目。先读当前约定和进度，沿用有效决定，完成这次需求及必要验证。

需要程序检查或真实验收时，Codex 会读取项目已有文档、检查入口和实际环境，并将对应项目配置放入私有状态目录的 profiles 下。配置结构参考 [project-profile.example.json](examples/project-profile.example.json)：填写实际项目根、现有文档、当前环境、真实检查命令与权限；使用本机实际可执行文件路径。

检查登记完成后，通过 `doctor --project 项目目录` 核对绑定；已有明确配置也可用 `doctor --profile 配置文件`。然后按本次任务选择登记检查和实际验收入口。

新项目可以先从目标和最小方案开始。简单读取、文案修改和已有有效决定走短流程。

## 描述你要的结果

- 新增功能：“给资料库加搜索，比较现有能力和成熟方案，完成搜索链路。”
- 设计交互：“做一个预约页面，整理成功条件，设计表单和状态反馈。”
- 修复故障：“保存后重启内容丢失，复现并查原因，再修复和核对读回。”
- 小范围调整：“按钮改成‘保存’，检查受影响页面后结束。”
- 接续任务：“从上次记录继续，沿用完成项，处理剩余待办。”

## 查看完成结果

任务结束时，Codex 应说明改变了什么、实际验证了什么、沿用了哪些证据、当前运行状态，以及需要你决定的事项。涉及页面或业务时，通过实际账号和入口操作，并核对保存、查询或其他业务结果。

## 更新与恢复

更新时保留原 CE 运行目录、Skill 和 runtime.json 备份，核对项目配置兼容，再切换到新目录并检查入口。需要恢复时，还原原 Skill 和 runtime.json，并核对原版本；项目历史与业务数据继续保留。

[验证记录](PUBLIC-VALIDATION.md)列出已有环境与实测范围，[技术架构](ARCHITECTURE.md)说明工具和记录怎样配合。
