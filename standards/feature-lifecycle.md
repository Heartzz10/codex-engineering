# 功能地图生命周期

唯一权威记录由 `profile.featureMapRef`（schemaVersion/path/historyDir/evidenceDir）绑定，路径均在项目根下。旧项目先将现状登记为 implemented，验收由证据推导，默认 not_run。迁移不复制历史原件，也不替换原产品文档。使用外部私有状态作为项目根时必须单独明确绑定，不自动分叉。

起草者使用 `templates/feature-map.example.json` 格式：requirements/features/acceptanceCriteria 的 key 为本次临时名称，关联用 `@key`，稳定 ID 在写锁内分配。每次 draft 必须有 sourceRef、recordedBy、change；来源用原任务稳定引用，宿主没有消息 ID 时使用带任务、时间和归属的 local_excerpt，不能编造 ID。proposed/needs_decision 不等于 accepted。

先 `feature init/change` 登记，再 `feature check` 判断是否存在关键待决。小改直接引用原 FEAT/AC 并追加 REQ/CHG。updates 用 `{entity,id,patch}`，不可改 ID/创建来源或删除实体。改变原意新建 REQ，用 supersedes 连接；勘误须 correction.kind=wording 及理由、来源。实质条件变化由程序升 AC.revision；标题变化不触发全图失效。

拆分/合并保留旧功能，通过 splitInto/mergedFrom 和 CHG.lineageTransfers 记录每条旧 REQ/AC 的 sourceId/sourceRevision、disposition、targets、reason、decisionRef。每个 targets 元素包含 featureId/requirementIds/acIds。旧 AC 不改归属，新 AC 带继承关系。撤回/废弃仍保留来源、依赖迁移及证据；恢复复用原 ID。

实际差异：`feature impact --diff FILE` 接收 files/sourceRef、业务补充 featureIds/acIds、unknownDependencies，以及有明确理由的 nonProduct。文件依赖只能提供机械线索，程序不知道全部业务语义。加 `--apply` 经同一事务登记影响和受影响证据失效。无关证据保留。关闭要求影响已解析、所有本次接受需求有实现、所有必需目标当前通过；延期须明确决定与理由。

扩大 `sourceScopes` 时，先运行 `feature continuity --profile PROFILE --output 项目内新文件.json`。只读报告分别按每条旧 CHG 登记时的原范围重算实际差异，列出新增范围、原基线与当前哈希、历史状态、影响登记和当前范围是否已有关闭的变更；`--output` 保存完整文件级差异。它不是验收通过。旧 CHG 的基线、差异、来源和未验收状态不得覆盖；新接续 CHG 应在新增实施前登记，关联受影响的全部功能及成功条件，再对当前完整范围运行检查与真实验收。若新增 CHG 建于实施之后而差异为空，报告中仍必须处理旧范围非空差异和旧记录。取消旧 CHG 须保留明确决定与理由，不能算通过；共用脚本要关联全部受影响功能。项目如某个已有原型存在旧 CHG 漏归属/未登记影响，应将阻断和当前业务验收继续保留，不以新基线消除。

扩大前核源码范围容量：快照上限100MiB、10000文件。只声明相关交付源码；大素材若不入同一快照，须用项目检查重算每个实际素材文件哈希并保留原件，不能只排除素材后声称完整覆盖。确需截图/trace的目标，开工先探测保存原件的能力，不删除原证据要求。

每个写命令携带 expectedRevision、expectedHash、requestId（CLI 对应带连字符参数）。初始化使用 0/absent。命令幂等哈希只包括命令、projectId、业务输入，不包括传输前提。相同请求不同输入拒绝。原子快照在替换地图前保存，map 文件刷新后同卷替换；进程锁不按超时删除。死进程遗留锁用 `feature recover-lock` 核验同宿主死 PID 后恢复。历史已有则检查内容，损坏不得覆盖。摘要可用 `feature project` 从地图重建。

崩溃后：地图仍旧版即同 requestId 重试；地图已提交即返回原 revision/IDs/result。读时重算 contentHash；手改未升版返回 external_edit_detected。所有写入（含证据、影响、关闭）共用事务。JSON 重复键、溢出数值拒绝；hash=SHA256(UTF8(递归排序对象键、保持数组顺序、剔除地图顶层contentHash的紧凑JSON))。排序使用 JavaScript UTF-16 字符序；数值采用 ECMAScript JSON 有限数表示，跨语言须遵循同一规则。验证向量在 templates/hash-vectors.json。

证据登记前先保存原件；原件丢失/变化不能继续复用。跨 AC 版本明确登记 carryForward，核对原目标契约、当前实现及环境，不能继承新增目标。可读投影含功能/入口/条件/步骤/预期/陷阱/证据；禁止单独编辑投影作为事实。

这些入口约束经过公共工具的记录。自然语言判断和编辑前触发仍依赖代理及宿主，没有全局编辑拦截器。
