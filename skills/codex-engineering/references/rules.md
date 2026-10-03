# 按领域接入工程规则基线

先以 doctor 核实际版本/packageRoot；0.4.0起提供 `rules prepare|run|assess --profile FILE [--scope 领域逗号列表] --output 项目内相对路径.json`。程序读取 profile.engineeringRulesRef、规则目录和原文引用，默认只打印状态/数量/原件位置。配置模板位于包根 templates/engineering-rules.example.json；规则 ID、目的、适用条件、执行、验证和例外在 catalog/engineering-rules.json。

| 本次涉及 | 按需读取（相对 doctor.packageRoot） |
|---|---|
| 页面、设计、文字 | standards/rules/ui.md；继续现有 UI 引用 |
| 提交、异步、弹窗、编辑 | standards/rules/interaction.md |
| 错误、恢复、结果未知 | standards/rules/errors.md |
| 业务事件、脱敏、保存管理 | standards/rules/logs.md |
| 角色、对象、撤权 | standards/rules/permissions.md |
| 字段、输入、接口、持久化 | standards/rules/data.md |
| 模块、公共入口、依赖 | standards/rules/architecture.md |
| AI、供应商、外发、预算 | standards/rules/external.md |

具体组件/数值/角色/期限/供应商/预算保留在项目原文。绑定只引用现有实现、决策、checkIds 与 acIds；全八领域都须声明 applicable/not_applicable/unknown 并有来源，未知不能自动不适用。同一领域内若只有某条规则不适用，在可选 `ruleApplicability` 中逐条说明依据（如无弹窗的 INT-3），不能把其他交互规则一起排除。缺必需检查/真实验收/具名审查分别保留缺口；配置字节、实现、决策及目录变化使旧回执过期。

run 顺序调用现有登记检查，不建立新调度；assess 复核现有回执及原功能地图 AC。已配置项目的原 accept assess、feature close、verify maintain 也拒绝基线缺口；原始 AC 回执仍仅表示该次业务观察。要求实际行为的规则不能由 baseline 方法代替；语义规则要求各目标有效断言含人工判断及原件。工程执行授权与业务权限、工程回执与业务日志分别处理。例外必须有来源、范围理由和到期时间，状态 deferred/exception_expired，不计通过。

项目可将 rules run 接入已有必需构建/交付命令，退出码2保留缺口；准备阶段先看 rules prepare 的逐条缺口。它仅约束经过该入口的范围；原业务权限/费用保护仍在实际执行端，不能由这层放行。针对单条非视觉规则的 AC 复核仍验证目标、入口、断言和原件；项目整体交付继续执行完整 UI 门槛。ui review 复用已发布能力，人工视觉/语义判断须记录场景、原件和审查人，不再实现一套。
