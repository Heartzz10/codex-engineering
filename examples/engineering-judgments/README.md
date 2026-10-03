# Jev 工程判断交付与证据

## 状态

可复用客户端、六类固定标准、预览/执行/评估入口已实现。结果始终为建议，保留原问题和原审查；不写业务pass，不批准、关闭或发布。private材料默认拒绝。

首轮实际调用由主代理在用户批准的18次、累计$0.05、仅合成材料范围内执行。调试6/6、保留9/12，未达固定12/12门槛；3条均是将材料不足错判为不支持，没有错误支持或误合并。原始材料、标准、回执、失败标签和阈值保留。

第二轮最小修复为标准1.0.1：先核必要证据和有效版本，只有具体反证才判unsupported；注入文字不作命令，自报pass不作证明。6条旧例回归与12条全新保留样本已冻结，离线回执验证不证明新标准模型质量。实际外发由主代理核对新增次数/预算授权后执行。

## 入口与返回契约

- `src/judgment.mjs`：`prepareJudgments(packet,{baseDir,readSource})`；`executeJudgments(bundle,{apiKey,approvedSha,budgetUsd,maxRequests,ledger,saveLedger,save,signal,timeoutMs,useCache,enabled,fetchImpl})`；`evaluateJudgments(dataset,runs,{costs})`。
- `scripts/engineering-judge.mjs`：`runJudgmentCommand(args)`返回结果，不打印、不设置退出码；`main(args)`是独立CLI包装。
- `skills/review-product-plan/scripts/jev-client.mjs`：固定传输、凭据引用、Choice验证、预算累计、缓存、取消/超时与文件锁。产品评审只依赖该skill内客户端与rubric，可独立安装。

```text
node scripts/engineering-judge.mjs prepare --input <packet.json> --out <新的preview.json>
node scripts/engineering-judge.mjs run --input <已核preview.json> --out <新的result.json> --approved-sha <SHA256> --budget-usd <累计授权上限> --max-requests <累计次数上限> --ledger <同一ledger.json> --key-config <已有凭据引用runtime.local.json>
node scripts/engineering-judge.mjs evaluate --input <result.json> --dataset <dataset.json> --out <新的evaluation.json>
```

prepare/evaluate离线。run不自动重试；同材料、标准、模型才可缓存，命中费用为零。未知费用保留单请求最大预留；在同一ledger中跨次累计，锁覆盖读、预留、调用、写回。`--cache off`强制实时；`--enabled false`停用并保留原审查。

输入含material_scope、context、带已核引文/行范围的evidence，以及judgments。每条judgment含id、kind、明确target、evidence_ids；method_selection另含候选id/description。只发送requests[*].body，不发送本地路径或人工预期答案。缺材料、无候选与失败分别保留，不能被自报pass覆盖。

## 验证

离线关键回归已经历红→绿：原实现提前取消仍返回completed、忽略abort的迟到响应仍采纳、跨次未知费用没有挡住新请求，共3条失败；共享客户端修复后通过。质量评估器原来相信改写的选择，现按原始回执重新解析；高confidence错误与缺答保留在分母。相关32项测试通过，包括独立复制产品评审的prepare操作。

第二轮18请求最大预留$0.049545216；加首轮实际报告输入用量估算$0.00075495，需累计预留$0.050300166，不能在原$0.05上限内开始第二轮。固定模型jev-1.13.0；价目由主代理2026-09-26复核，每百万输入$0.042、输出免费。估算不是账单，Codex用量与人工/材料/返工成本未据此补造。

## 便携发行必需文件

运行：`src/judgment.mjs`、`scripts/engineering-judge.mjs`、`policies/judgments.json`、`policies/judgments-1.0.0.json`、`policies/judgments-evaluation.json`、skill内`jev-client.mjs`/`jev-review.mjs`及原rubric。

相关测试：`tests/judgment.test.mjs`、`tests/judgment-client.test.mjs`、原`tests/review-product-plan.test.mjs`，两份无本机路径的`dataset.json`，以及`fixtures/first-round-receipts.json`。该fixture明确为provider_response_fixture，只证明历史解析，不算新在线证明。测试不依赖本机preview或实际provider回执；手动prepare可另分发source.md/packet.json。

## 尚不能宣称

没有原工作流同材料的实际调用/人工时间和完整总成本对照，不能宣称15%节省；当前基线是人工固定答案。小样本质量结果不能证明长期性能。第一轮不达标，第二轮质量以新增授权后的真实回执为准。真实业务操作和项目发布仍由原有工程入口承担。
