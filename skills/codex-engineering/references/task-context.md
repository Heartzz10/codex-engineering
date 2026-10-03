# 本地任务资料与接续

适用于跨源资料反复整理或中断后恢复。代理读取已有任务与项目绑定，复用功能地图、有效决定、catalog、检查和原件引用；不要求用户另填资料表。明确小改且原件已在当前上下文时直接原短流程。

入口参数以安装包 `context --help` 为准：

```text
context prepare --profile FILE --task TASK_JSON [--change CHG_ID|--ids AC_IDS] --out NEW_CONTEXT_JSON
context resume --profile FILE --from SAVED_CONTEXT_JSON --out NEW_CONTEXT_JSON
```

资料分为必读、可选、缺口、接下来待办；包含原件位置、有效状态和全文身份。资料到位不等于检查执行或业务通过。坏引用、尚未确认、旧未验收与过期证据保持可见，沿既有 `feature`、`rules`、`ui`、`accept` 等入口处理；不覆盖地图、问题历史或原判断。

`verification` 投影本次 `required_checks`/`required_targets`、`reusable`、`pending`、`expansion_facts` 和 `completion`；它复用原检查/验收回执，不另判 pass。先核复用项的源码、规则、任务、环境、角色/配置、数据和来源身份；动态业务状态仍需当前事实审查。待执行的已登记检查走 `run/rules`，真实目标沿原 `accept` 与实际入口。扩检只补一行新事实及原件引用；必需检查、适用 UI 审查与真实目标完成才结束，预算耗尽不算通过。

接续先核项目、任务、当前地图与原件，变化则重新准备并保留失效原因。只复用身份、原始结果和来源仍有效的完成项；未开始项可以继续，已预占或未知收费不自动重发。接续摘要不是第二套验收或预算状态机；实际 Jev 执行仍使用既有账本、缓存与恢复机制。

新相关性层是独立、默认关闭的验证用途，不能继承普通文案资格。`context-relevance prepare --input PACKET --out BUNDLE` 生成完整外发预览；`run` 默认 daily，零外发。只有明确 `--purpose validation` 且完整 task/candidate 属于已允许的 public/synthetic 范围、指纹匹配并冻结累计次数和预算，才使用已有供应商。私有任务和业务日志留本地；公开候选不能证明私有查询允许发送。

新相关性问题逐项问是否提供本次具体问题的直接依据、操作或反证，以 `yes/no/unknown` 按 `question_id` 读取全部答案并按明确规则组合；缺答、冲突和 `unknown` 不放行、保持可见并可扩读。它只安排补充阅读，必读原件、适用检查、已知未决与业务验收不被删除。失败或来源变化回本地，不自动重试。旧四标签结果、缓存和资格不能解释为新合同结果或资格。关闭相关性后本地资料与原流程仍可运行。准确性、完整耗时和 Codex 原生用量分别达标之前，不能宣称工作替代或启用资格。
