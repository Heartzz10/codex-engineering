# 相关性二元判断：有界验证入口

此入口复用 CE 的相关性消费者、Jev 客户端、带锁账本和原生会话窗口读取；它不启用日常自动判断。

先冻结 schema_version=1 协议，包含软件/标准/model/effort、资料范围、每份 packet 的 SHA256、独立参考及其 SHA256、独立输出目录、共享账本、阶段限额和完成规则。仅允许已经授权的 public/synthetic 资料。

```powershell
node examples/engineering-judgments/context-relevance-pilot/run.mjs prepare --protocol PROTOCOL.json --out PREPARED_DIR
node examples/engineering-judgments/context-relevance-pilot/run.mjs run --protocol PROTOCOL.json --out RUN_DIR --key-config LOCAL_CONFIG.json
node examples/engineering-judgments/context-relevance-pilot/run.mjs collect --protocol PROTOCOL.json --out COLLECTION_DIR
```

输出目录必须新建，并与冻结协议一致；不能覆盖旧结果。Q 固定八例，最多八次、USD 0.025；Q 原回执全部通过才进入 E，E 最多二十次、USD 0.06；共享账本累计最多二十八次、USD 0.085。自动重试为零。费用不确定或重要质量错误立即停止。供应商原始答案、来源身份、有效答案及低置信度回退均保留。fixture 回执不能通过真实 Q。

E 必须冻结两项独立来源任务及 A/B/C 阅读规则。B/C 同候选、起读五份，同一明确会话按新增资料接续；必读材料、必做检查、扩读和停止依据须列明。A 旧规则不一致时标记不可比。

可选 measurement_file 收集 preparation/extraction/provider/reading/failure/fallback/organization/summary 八阶段、完整窗口、原生日志的明确响应边界和阅读原件。模型/档位漂移、会话窗口重叠拒绝；缺阶段或窗口时完整成本为 null。父对话累计 token 不分摊给各实验臂，账单费用缺失保持 null。引文、ID、顺序和格式由本地校验，错误原件保留，不要求模型重答整批语义。

Q 的代理参考不是人工金标；此筛查不替代完整资格标定。没有完整各臂成本和独立质量审查时，不生成净收益结论，两种 Jev 日常用途分别保持关闭。
