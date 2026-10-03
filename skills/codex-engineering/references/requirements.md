# 需求与范围

适用于新项目、新主流程、含糊目标、目标与方案冲突，或实施中出现会改变结果的重要假设。已确认的小改复用有效决定，直接检查受影响处。新项目和新增能力在主要实现前先查现有能力与适用约束；有真实选型缺口时按 [开发前调研与资源复用](resource-reuse.md) 定向调研。已有决定且有关条件未变时不重复搜索。

先说清用户要完成的事和减少的负担，区分结果与用户提出的某种实现。由代理起草简短场景：谁在何时触发、输入从哪来、系统自动处理到哪一步、用户何时决策、结果在哪里看、失败后如何恢复。优先查项目现状与已有约定；不把事实核查交给用户，也不把内部处理步骤逐项变成按钮。

辨明本次交付范围、排除项、成功判据，以及会影响体验、数据访问、外发、费用、可靠性和维护的前提。方案与目标不匹配时，指出具体后果并给出推荐；额外机会区分必要补齐、待决策范围和以后候选，不因提出建议而自动实施。

开始实施前用实际绑定运行 doctor，看 startup 的适用缺项；两份可运行初始材料为 `templates/feature-map.example.json` 和 `templates/hash-vectors.json`，引用模板不等于已接受业务决定。扩大 sourceScopes 时按 `standards/feature-lifecycle.md` 的接续流程保留旧差异、历史及未验收状态。

确认需求时复用功能地图：REQ 的 `intent/decision/decisionRef/openQuestions` 保留原决定与未决项，AC 的 `expected/preconditions/actions/assertions` 保留判据。适合重复语义判断的普通状态或帮助文案，可由代理给 REQ 补 `decisionEvidenceRefs`（项目内原文路径和行号），在既有 `manual` assertion 内补 `semanticReview`，引用实际候选文件的行号或 JSON pointer，并记录已核的范围、材料属性和排除情形。不要另写一份待审文案，不新增用户必填表格；不能凭空把私有材料改为 public。未确认、尚有疑问或引用缺失均保留给 Codex。

实现后按本次 change 或 AC 运行 `judge project --profile <配置> --change <CHG-ID> --out <新回执>`，程序从上述引用读原件并生成待审清单；无需人工逐题编 packet。没有引用的旧地图仍兼容，手工/整体验收继续保留。修改 assertions 中的判断约定沿现有 `feature change` 使受影响 AC 版本及验收证据失效，原材料变化也会阻止旧结果复用。详细入口见 [judgments](judgments.md)，可运行示例在安装包的 `examples/engineering-judgments/project-flow/`。

主流程、自动化边界、重要权限及费用和验收结果明确后，涉及新交互/布局的按 [UI 设计](ui-design.md) 形成足够支持实现的方案，再进入主要 UI 编码；其他实施及有效旧设计直接推进。只问影响关键取舍且无法自行查证的缺口，给出少量有实际差别的选项；已有授权不重复询问。重要未决项不能靠沉默或时间推定同意。实施中新证据推翻前提时，仅重评受影响部分，继续不依赖该决定的工作。
