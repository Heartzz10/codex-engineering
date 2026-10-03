# 从既有需求生成判断任务

这是合成的 CLI 使用例子。`requirements.md` 是原要求，`copy.json` 模拟开发产生的文案，`feature-draft.json` 使用现有 `feature init` 登记。它没有业务通过或模型可靠性结论。

新增引用由代理在确认需求时随原功能地图维护，不要求用户填写另一份文档：

- REQ 的 `decisionEvidenceRefs` 指向原决定的 md/txt 行。内容继续只在原文维护；`openQuestions` 保留未决事项。
- AC 的 `expected` 保留通过条件。需要语义判断的既有 `manual` 断言可附 `semanticReview`，其中 `targetRef` 指向实际 md/txt 片段或 JSON 字符串字段。条件、引用或语义范围改变沿原 `feature change` 更新；断言变更继续触发 AC 修订和旧证据失效。
- `equals`、`equalsPath`、`includes` 留给原程序验收入口；这次计划不会替它们执行或写通过。未配置语义引用、未接受需求、未决事项、缺失原件和高影响事项交给 Codex。

在自己的合成隔离目录复制三个 JSON/文本文件，建立当前版本的项目 profile 并用现有 `feature init` 初始化后：

```text
node <skill>/scripts/engineering.mjs judge plan --profile <profile.json> --change CHG-0001 --out <plan.json>
node <skill>/scripts/engineering.mjs judge project --profile <profile.json> --change CHG-0001 --out <daily.json>
```

默认 `daily` 使用当前资格。无资格时零请求、零密钥读取，语义题回 Codex；输出的程序检查待办仍需按原验收入口完成。已绑定项目可用 `--project <目录>`；只选某些成功条件可用 `--ids AC-0001,AC-0002`，与 `--change` 二选一。

质量试验明确使用 `--purpose validation`：先运行 `plan` 核对原件及外发预览，再用其 `plan_sha256` 在 `project` 命令提供 `--approved-sha`、`--budget-usd`、`--max-requests` 与专用 `--ledger`。试验建议全部保留 Codex 复核，不形成生产资格。请求材料变化会产生不同指纹；不能把旧授权指纹用于新材料。

终端结果只提供共用标准、去重后的上下文和证据，以及任务引用。完整计划、来源绑定和回执在 `--out` 文件；不会靠缩短输出删除题目或把未执行的检查算通过。
