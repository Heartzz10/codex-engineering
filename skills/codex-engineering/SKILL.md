---
name: codex-engineering
description: 项目新增功能、方案/可行性或性能选择存在会改变决定的未知时，以及需求整理、交互/UI设计、代码实施、排错或真实验收时，按需接入已有方法、检查和证据。明确小改与有效旧决定走短路径；纯概念解释不启动工程工具。
---

# 项目工程协作

先辨别新增能力/方案、需求、设计、实施、排错或验收，定向读真实项目当前交接、相关原件与已定范围。用户只说“新增功能”“能否这样做”或“资料多了会不会慢”，也判断是否存在会改变决定的未知；有未知接选型方法，有有效旧决定则复用。纯概念解释、指定文件读取和明确小改保持短。明确任务在已有授权内持续完成；只处理尚未决定的产品、数据、权限或费用取舍，不重复整体确认。全局 AGENTS 保留协作底线，具体业务值留项目原文。

入口：`node <本Skill目录>/scripts/engineering.mjs <命令>`。绑定未知先 `doctor --project <目录>`；已知用 `--profile <配置>`。核实际 version/packageRoot 后从该包根定位资源，参数查 `--help`；无绑定不能代入别的项目。配置由程序读取，不默认加载完整目录或历史。已有有效证据按未变化范围复用。

只接当前必要方法：新增能力的条件与成功标准尚需形成时读 [requirements](references/requirements.md)；方案/可行性/性能选择有未知时读 [resource-reuse](references/resource-reuse.md)；新增入口或交互/布局读 [ui-design](references/ui-design.md)，页面实现/审查读 [ui](references/ui.md)；代码/数据/权限/接口读 [engineering](references/engineering.md)；检查与真实验收读 [verification](references/verification.md)；核历史或疑似故障是否仍存在、调查当前故障或修复时读 [operations](references/operations.md)，先按实际意图接既有 `task route`、适用时接 `debug plan/audit`，正常就不改源码、不造故障。不串行加载全部模块、完整评审 rubric 或全历史；轻量方案只读相关方法与项目原件。大段输出截断时定向补缺段，不重读全文。语义判断/模型/费用才读 [judgments](references/judgments.md)。

实施前留短清单：改变的用户结果、必需检查/真实入口、有效复用项与结束条件。常见规则按 [领域索引](references/rules.md) 选择；profile 已登记检查经 `run --profile FILE --check ID` 或 `rules prepare/run/assess --profile FILE --scope <领域>` 接原 checks/AC，先核有效回执，不绕过后再补跑一遍。独立副本约定了记录目录时，安装 wrapper 固定公共 stateRoot 不是绕过检查的理由；按 [operations](references/operations.md) 从实际安装 packageRoot 调同版本 CLI 并显式指定副本 stateRoot，沿用已有 runner/回执护栏。缺绑定、未执行、过期、unsupported 和待审不能算通过。工具默认摘要，必要时 `--output <项目内新文件.json>` 留完整证据；其他入口与运行边界按需读 operations。

优先复用项目组件、类型、校验、业务权限、日志及真实调用入口；公共工具不另建业务服务。工程运行授权不是业务权限，执行回执不是业务日志，模型推荐不是原生设置。外发范围及累计请求/费用必须有授权，Jev 只作建议；缺事实不编造默认决定。

确定性检查先验证错误会被拒绝、合法情况会通过。页面/业务须在实际入口、账号和配置下输入、点击/键盘、提交、等待并核业务读回；复用 UI prepare/source/assess 与已有 review，视觉和语义仍须有证据的审查。代码检查、截图、自报 pass、Web 通过均不能替代全部业务或原生平台验收。修复后同目标复测，源码/规则/环境变化核证据失效；同失败无新证据改变调查假设。

必需检查与本次实际验收通过后结束；扩检只留一行新事实及原件引用，没有新变更、失败、证据或未知影响不加波次。普通实施做一次，不默认复制 A/B/C 或另开多个评测代理。分别报告实现、验证、启用及边界。入口受阻继续独立工作；权限/费用保护失效暂停依赖操作。保留用户修改，发布和回退走项目既有机制；中断留短交接。投入按全部尝试统计，Codex用量、业务费用和人工时间分开，未知不记零。

Windows 读取文件前设置 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`；脚本路径相对本 Skill 解析，不能相对 shell 当前目录。

本次资料跨多个来源或需要中断接续时，按 [本地任务资料与接续](references/task-context.md) 使用 `context prepare|resume`，自动取得必读原件、可选资料、缺项和原待办。明确小改直接走原短流程，不强制生成资料包，不增加 Jev 调用。新相关性仅为独立验证用途，默认关闭，不继承普通文案资格。
