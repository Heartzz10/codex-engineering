# 判断、模型选择和交付成本

本规范由2026-09-26已批准的P1/P2/P4/P5/P7工作包增补实施。复用项目已有决定、功能地图和原件，普通明确小改无需做理解访谈。

## 在项目里使用

1. 读当前交接，核对 `doctor --project <目录>` 的版本、绑定和入口。新项目用现有profile模板接入并从已批准需求建立地图；旧项目先复用地图。全局skill被相关任务匹配时指导Codex，工具只约束经过入口的操作，不全局拦截所有会话。
2. 需求新增、修改、拆分或撤回走 `feature init|change|impact`；来源、入口、条件、成功标准留在项目。已绑定决定可用 `records --scope project:ID --ids DEC-ID` 精确查询。
3. 目标可能被误解时用 `understand check --input FILE`。代表案例检查保留目标、保障、全部适用维护入口、授权范围、业务规则作用域及实现/验证/发布区别。结构声明不证明自然语言理解；主代理或Jev必须对绑定原决定做语义审查，拒绝与材料不足均不能变成通过。
4. 自然语言判断走已安装入口 `node <本Skill目录>/scripts/engineering.mjs judge review --input <已有packet或prepared bundle.json> --out <新回执.json> --approved-sha <已核请求指纹> --budget-usd <累计授权上限> --max-requests <累计请求上限> --ledger <同一账本.json>`。已有 packet 由程序按引用读取材料并 prepare；已有 bundle 在调用前后重核每条证据的来源绑定。旧 bundle 缺绑定时，用原 packet 重建。首次核外发内容或材料变更时，用同一入口 `judge prepare --input <packet.json> --out <新预览.json>`，检查预览中的 `requests[*].body`，再记录匹配的授权指纹。材料与授权不变时复用既有指纹和累计上限，不重复让用户批准。`judge run` 仍接受 prepared bundle；`judge evaluate` 用于独立评估。六类用途各自验收，未达质量要求的用途回原审查。不得凭概率自行关闭问题或发布。
5. 排错先用 `debug plan` 判断适用步骤并形成可证伪假设。同一失败无新证据时 `model retry` 返回停止调查建议；实际登记检查由runner约束。不把一句重试理由当新证据。
6. 页面按实际权限输入、点击、等待、核业务结果；用测量补查关键控件的遮挡、溢出、字体和布局。已知坏例必须能被回归检查拒绝；截图仅供目视，`visual assess` 不证明业务完成。完整维护用 `verify maintain` 覆盖全部适用目标，复用同轮有效原件。

## 判断边界

### 项目日常入口与专项验证

已有功能地图时优先 `judge project --profile <配置> --change <CHG-ID> --out <新回执.json>`；绑定项目也可用 `--project <目录>`，限定 AC 可用 `--ids AC-0001,AC-0002` 替代 change。默认 `--purpose daily`：程序直接读取已确认需求原文和实际候选文件；程序断言仅列为待执行引用，局部语义题按资格分流，整体审查及缺材料项保留给 Codex。当前公共资格为空，因此日常入口不读取凭据或账本、不调用 Jev，不增加一次无收益的模型等待。已有项目未补引用的部分继续正常审查。

只有专项质量对照用 `judge plan ... --purpose validation --out <预览.json>`，核 `prepared[*].bundle.requests[*].body` 和 `plan_sha256`，再运行 `judge project ... --purpose validation --approved-sha <plan_sha256> --budget-usd <累计上限> --max-requests <累计次数> --ledger <同一账本.json> --out <新回执.json>`。已授权材料和费用范围由代理核对，不重复要求用户批准。指纹绑定题目、选择范围、原文件、标准与用途；源文件变化必须重建计划。验证用途全部保留 Codex 复核，调用成功不自动取得资格。来源变化、材料不足和失败不视为通过。

项目入口默认输出的 `worklist.context_pool/evidence_pool` 按内容共享上下文和证据，逐题用 `context_ref/evidence_refs` 的数组索引引用，完整材料不截断；`program_tasks` 没有执行结果，必须接原有程序检查。完整计划、账本关联和供应商原始回执保存在 `--out` 中，日常只读紧凑清单即可。旧 `judge review/run/prepare/evaluate` 保持兼容，适用于现成 packet 或专项评估，不作为项目日常的额外前后流程。

先按问题分流：代码、测量和业务读回能确定的交程序及真实操作；跨材料取舍、整体UI、视觉、高影响后果或范围不明交Codex；只有现成原文与候选表达构成明确、有限且会重复的低影响语义题，才考虑Jev。首期仅普通状态/帮助文案的需求保真；从原项目决定和候选文案提取片段，不新建必填设计档案。准备材料比直接判断更费力、同题已由Codex判完、材料为private或没有有效资格时，直接沿原审查。选择性局部复用的条件和状态以当前工具结果为准，不代替程序检查、完整`ui review`、必要`understand check`及业务读回。

确需试首期范围时，packet 可加 `review_policy: {"mode":"selective","profile_id":"ordinary_ui_copy_fidelity_v2"}`，并在本地 `review_scope` 写明普通状态/帮助文案类别、低影响、原决定与复核者引用、已逐项排查的排除情形；人工仍需判断这些声明是否属实。先核 `prepare` 的逐题外发 body，再按既有授权运行；本地范围声明不外发。结果中的 `worklist.codex_tasks` 是直接待复核清单，含每题目标、相关材料和判断标准；按该清单逐题复核，完整原始回执在 `--out` 文件中，无须浏览全项目材料。`review_routing` 只对当前资格、原始回执、来源与抽查均有效的单项给 `reuse_supported`，其余为 `codex_review`；`review_fallback` 是零请求回原审查。新二元标准不继承v1资格或缓存结论，当前公共资格为空、模式默认关闭；现阶段原生 Codex 收据尚未接入资格核验，手填质量/省时 JSON 即使数字自洽也不能启用。若确认误放，先暂停此配置，再核原因和补验证；不改其他项目权限及业务验收。

Jev复用评审skill同一个固定模型客户端。活跃工程及相关性标准为2.0.0，每题一个明确命题，回答yes/no/unknown；按question_id消费全部题，以parent_id和显式组合规则汇总。模型未知、低信心、来源缺失/变化、传输失败分别记录，不用answers[0]替代全部。需求保真、变更影响、问题重复、验收覆盖、交付保真、方法选择都只给受限建议；多个适用方法保留multi_match，缺答或未知不能放行。保留不足、冲突、无匹配路径；查重不删原问题。私有材料默认拒绝，不自动向外发送项目源码、日志或用户决定。错误、超时、取消、迟到结果、持久化失败或质量门槛未达时回原审查，不自动重试。旧标准、请求、金标和评分保持原版本解释。

缓存绑定请求材料、标准和模型；费用累计保留未知在途预占。缓存命中与模拟接口只证明机制，不可计作新的供应商质量证明。供应商输出不是审批，不绕过项目权限和费用授权。

## 模型与成本

`model route --input task.json [--models capability.json]` 根据错误后果、自动检测能力、可撤回性及矛盾证据给建议。用户指定的模型/档位优先。子代理实际调用设置以原生调用回执为准，主对话模型不能由文字声称改变。

`model cost --input report.json` 统计全部尝试、明确重试关系、检查和人工投入。分别保留币种及时间来源，费用/耗时缺失记未知；不得用最低token价格推断合格交付更便宜。资格引用仍须实际业务验收复核。便携字段例子见 `examples/decision-controls/README.md`，判断例子见 `examples/engineering-judgments/README.md`。

版本发行需冻结白名单、源码回归、稳定快照校验、现有配置兼容预检、安装入口操作和回退演练。开发证据不进入公共发行包；历史缺口保留，不靠新记录伪造当时验证。
