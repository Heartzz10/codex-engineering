# 模型、总成本与目标理解检查

本目录全部为**离线合成夹具**，不是本轮实际模型调用、费用、语义评审或业务验收收据。能力清单只示范格式，实际调用前由现有能力核查入口核实。原用户决定继续存于已有 preferences/decisions 记录，原标准正文继续在 requirements/master-plan/Jev 标准中维护。

## 可运行入口

在公共包目录执行：

```powershell
node scripts/model-route.mjs --task examples/decision-controls/task.json --models examples/decision-controls/models.json
node scripts/model-route.mjs --cost-report examples/decision-controls/cost-report.json
node scripts/model-route.mjs --retry examples/decision-controls/retry.json
node scripts/understanding-check.mjs --input examples/decision-controls/understanding-bad.json
node scripts/understanding-check.mjs --input examples/decision-controls/understanding-good.json
```

前两项返回建议与费用缺项；retry 与 bad 返回退出码1；good 返回0。这些只核上述声明，不调用模型、不改变主对话设置、不执行项目检查。项目检查仍须经过既有 runner；`assessRetry` 的 `enforced:false` 明确提醒调用者实际停止需由 runner 实施。

## 导出与模型建议

`chooseCostPolicy(task, models)` 保留原接口。新控制字段：`errorConsequence: low|medium|high`、`automaticDetection:boolean`、`reversible:boolean`；缺失、格式错误或类别外输出 `route.action:investigate` 并留主代理。高后果/能力故障给 `escalate`，用户显式 `explicitModel`/`explicitEffort` 仍优先。无法支持时报告，不替换。`effectiveModel` 和 `effectiveEffort` 始终为空；原生子代理可采用建议，实际生效值只从真实调用收据读取。

`signals` 接受 policies/cost.json 已登记升级信号。当前 `risk` 是能力下限，不能压低已知错误后果。可程序检索的确定性搜索仍使用程序。

`assessRetry(attempts, nextAttempt)` 输入按时间先后排列的 `{fingerprint,status,evidenceRefs}`；下次尝试含 `{fingerprint,evidenceRefs?,userRequestRef?}`。输入或环境变更、新证据或明确用户重跑请求可返回 `run`；无变化的成功结果返回 `reuse`；无新证据的失败返回 `stop-and-investigate`。普通 `repeatReason` 文本不能证明新证据，函数不启动程序或绕过 runner。

## 合格交付总成本

`summarizeDeliveryCost({attempts,checks,humanWork,qualification})` 的格式见 cost-report.json。attempts 每项对应一次实际调用，`invocationReceipt:{sourceRef,model,effort}` 留原生收据引用；失败尝试和后续重试都计入。`retryOf:null` 表示独立首次调用，重试填写前一次实际尝试ID；缺失关系则 retryCount 为 null，不能把后续独立调用猜成重试。重复尝试ID或调用收据引用将其费用标未知，避免重复累计。各项 `cost:{amount,currency,sourceRef}` 与 `minutes:{value,sourceRef}` 只报实数，缺失为 null。模型费用、检查费用、人力费用及耗时分别返回；不从 Token 用量猜价格，不把多种币种相加。显式空列表表示该类没有已登记投入；缺整个列表不按零处理。

`knownByCurrency` 是有来源的小计；任一费用缺项时 `total.amount:null`、`complete:false`、`comparable:false`。检查/人工项必须有唯一 `sourceRef`；同一身份在同类或跨两类重复、或身份缺失时，其费用和分钟同时标未知，不能重复累计。资格引用仅返回 `reported-qualified` 且 `independentlyVerified:false`；需要现有验收入口核原件，不能凭这份费用汇总宣布交付合格。此接口不会证明账单或收据真伪；应传入真实收据来源而非代理建议。

## 结构化理解案例

`evaluateUnderstanding({caseId,decisions,proposal,semanticReview?})` 直接检查已加载决定引用；`checkUnderstanding({stateRoot,scope,decisionBindings,...})` 复用现有记录查询/索引。绑定格式为 `{'user-intent':'现有决定ID'}`，也可给 `{id,query:'已有记录关键词'}`。只接受当前 scope 可见的 active 决定，找不到精确ID就要求复核，不使用相似记录代替。

| caseId | proposal 的必填结构事实 |
|---|---|
| goal-preservation | optimizationTarget: fewer-errors-and-rework；few-components 为显式目标偏离；其他值需复核 |
| required-regression | deletedRequiredChecks: string[]；必要检查被删除即拒绝 |
| complete-maintenance | maintenanceCoverage: all-applicable/sample/affected-only；claimsCompleteMaintenance: boolean |
| authorized-small-change | alreadyAuthorized/smallReversibleChange/newDecisionRequired/asksForReapproval: boolean |
| public-project-boundary | publicLayerContainsBusinessRules: boolean |
| delivery-stages | claims: {implemented,verified,published:boolean}；stageEvidence:[{stage,sourceRef}] |
| undecided-product-choice | choices:[{id,critical:boolean,state:pending/selected/withdrawn,approvalBasis?,decisionId?}] |

`decisions` 每项含 `{key:'user-intent',id,kind:'decision|preference',status:'active',sourceRef}`。结构事实缺失、未知案例/枚举或缺有效决定返回 `requires-review`；明确违反返回 `rejected`；结构通过而没有语义收据返回 `semantic-review-required`。

语义审查由主代理或现有 Jev 有限类别流程完成，输入原用户决定和原方案。提供 `{reviewer:'main-agent|jev',status:'confirmed',sourceRef,decisionIds:[对应原决定ID]}` 后结构通过可返回 `accepted`，其含义是检查声明与外部审查记录一致；已绑定审查为 rejected 时返回 `rejected`，结构声明不能覆盖语义拒绝。`semanticsIndependentlyVerified:false` 明确程序没有理解自然语言。原文没有关键字扫描；未知/新产品选择不能以沉默或超时推定批准。重要选择若为 selected，必须绑定明确用户决定；pending 可以通过，不强迫代理替用户选择。

实现、程序验证、真实验收、发布是独立状态。这里的 accepted 不代表代码已实现、业务已验收或已发布。
