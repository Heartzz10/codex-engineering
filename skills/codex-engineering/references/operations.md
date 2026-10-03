# 入口与运行边界

所有命令由 `node <本Skill目录>/scripts/engineering.mjs` 调用；先 doctor 核版本与 packageRoot，用 --help 查实际可用参数。源码目录版本不能代表日常安装；包内示例从 doctor.packageRoot 定位。

用户要求核历史/疑似故障是否仍存在、当前故障、修复或取证时，按事实形成最小 task 输入，先 `task route --input FILE`，采用调查/修复/现场取证/trace 类别时再 `debug plan --input FILE`；只读返回的适用原文与依赖。例如只解释当前机制可用 `{ "outcome":"explanation", "taskScale":"bounded" }`；明确修复用 repair，实际现场诊断用 diagnosis 配 evidenceMode live/captured，不把历史担心自动当成已复现缺陷。正常就保留源码。既有 `debug audit --profile FILE --input FILE` 只核证据身份和完整性，不代表故障已复现或业务已通过。明确本地缺陷先看日志与代码，不自动展开全部协议或重新选型。

独立副本指定私有记录目录时，先从 doctor/runtime 核实际安装 packageRoot。安装 wrapper 会最后追加公共 `runtime.stateRoot`，不能用它假称隔离，也不能因而直接重跑已登记的 rule-check。使用 `node <实际packageRoot>/src/cli.mjs <命令> --profile <副本profile> --state-root <副本state>`，这是同一已安装版本的真实 CE CLI、runner 与规则入口，不是开发源码。先读有效回执；`repeat_requires_reason` 是复用提示（退出码2），无新事实不重跑。不得只读旧context全文后另跑相同检查。缺记录/来源变动时才沿登记入口执行；业务读回仍由实际 driver 完成。

doctor --profile FILE [--task FILE --models FILE]；run --profile FILE --check ID；usage --run SESSION_ID --file JSONL（可多份）；records --scope 范围 --query 关键词。doctor.startup 按本次任务适用性汇总缺入口、检查、源码范围、UI配置和验收路径，顶层 `needs_setup` 显示仍有接入缺项；缺失的权威文档也会列出，且其他运行命令仍拒绝缺文档配置。此状态不表示业务通过；纯文档任务不强制配置 UI。扩大源码范围先用 `feature continuity --profile FILE --output 新文件.json` 查看旧差异与未闭环状态。既有 task route、debug plan/audit、feature、accept、verify maintain、model route/cost/retry、understand check、visual assess、judge 和 ui 沿用原入口。旧版本没有新增入口时先核版本，不能凭文件存在称已安装。

项目命令的相对 `--output` 路径以项目根为基准；无项目命令以调用目录为基准。维护验收异常退出若遗留 `.lock`，先核对应进程确已退出，再用 `verify recover-lock --profile FILE`；该入口只接受本机可核的死亡 PID 和新格式锁，不删除正在使用或归属不明的锁，也不将中断验收标成通过。随后沿原 run ID 与哈希接续检查。

Pstack 仅调查、故障修复、现场取证、已有 trace 四类，其余 not_adopted。controls/acceptanceRoutes 是声明的驱动，须核现场；空 checks 不代表页面通过。featureMapDocument 复用项目原文；featureMapRef 用 feature show/check 查看。只有经过运行器的命令受它约束；pass 不是原生设置或真实业务结果。

profile 已登记检查先核有效回执，再走 `run --profile FILE --check ID` 或相应 `rules` 入口，保留原重复保护。受阻改用直接命令须留原因和原始回执，不先绕过再追加同目标检查。验证范围、复用与结束按 [verification](verification.md)，资料整理和中断接续按 [task-context](task-context.md)。

Jev 用既有客户端与判断标准；先生成检查最小材料预览，只发已授权范围，固定模型并执行累计请求和费用上限。私有材料默认拒绝，失败/冲突/材料不足回原审查；不能删除问题、关闭需求、批准费用或发布。详见 judgments.md。

模型按错误后果、自动发现能力和撤回难度选择；用户设置优先，推荐不等于切换主对话。明确小事直接完成；独立低风险工作可按当前支持选较轻子代理，限定文件与停止条件，复杂审校保留足够能力。投入记全部尝试/重试/检查/返工，原生回执为准；Codex用量、业务费与人工时间分开，未知不算零。

公共入口失败先核配置/版本/错误，在已有授权内可用项目原命令继续独立工作并保留证据。权限或费用保护失效暂停依赖操作；连续同一失败无新证据改变调查假设。中断留目标、版本、决定、有效证据及下一步。安装与回退沿用 release-upgrade 和 skill-snapshot，不覆盖用户后续修改。
