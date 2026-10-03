# 项目验证控制与完整维护

公共入口 `verify maintain` 调用 `maintainVerification(profile,map,options)`。它计划全范围覆盖、核验已有工具的原始回执、保存协调状态；不直接操作浏览器、不自由拼接 shell、不授予额外权限。执行者按项目已有工具操作，公共 CLI 不能把填写 `passed` 当作真实执行。

## 控制配置

`profile.controls.schemaVersion=1`，结构示例见 `templates/controls.example.json`。`launch.ref` 是已有启动工具，`readySignal` 是实际可观察的就绪信号；`doctor.ref` 为只读实例检查；`drive.ref` 和 `entrypointIds` 指向真实驱动；`evidence.ref` 指向证据捕获；`cleanup.ref` 只清理约定实例/数据且 `preservesEvidence=true`；`isolation` 指定实例/数据范围并要求会话独占；`sourceReview.inputs` 是全面发现入口的源码范围，不可只列一个已知页面。每个 ref 必须可从项目文档找到具体调用方式，不在公共配置复制账号、凭据或项目内容。

源码指纹覆盖 sourceReview 范围和地图所有实现引用。语义审查仍由执行者完成：逐个 implemented 功能读源码，核对全部入口与条件，并寻找新入口。新增入口必须先登记契约并实际验证，不能通过漏报入口或改成 planned 避免维护。真正尚未实现的 planned 功能保留状态、不列为不可达的已实现功能。

## 一次完整运行

1. 首次调用 `{runId}` 得到 `blocked`、全部覆盖目标、缺项、`runHash`。相同项目同一时间只允许一个维护 run 持有会话。取得执行权后才操作实例。
2. 按已有授权运行源码审查→Launch→Doctor→全部 Drive→Evidence→Cleanup→证据保留复核。初次建立控制能力至少完整实跑一个功能；完整维护则所有 implemented 功能、所有用户入口、所有 AC.requiredTargets 都必须实际覆盖，不能抽样。
3. 原始业务证据先保存到 profile.featureMapRef.evidenceDir，使用 `accept record` 登记，再提供维护 `evidence` 事件。必须是本 run 的证据，旧 run 的有效观察可用于日常增量验收，不能替代本轮完整维护实跑。
4. 恢复调用 `{runId,resume:runId,expectedRunHash:上次返回值,report:{requestId,events}}`。每次追加返回新 runHash；无 report 可以重新检查已记录证据是否仍存在。

所有事件公共字段：`type,projectId,runId,instanceId,instanceHash,observationSource,sourceRef,artifact`。`instanceHash` 为项目控制器实际采集的稳定实例身份（如项目、进程启动时间、实例目录、服务身份）确定性 JSON SHA-256，不能只对自己随意起的名字取哈希。`observationSource` 是 `tool_receipt` 或 `manual_attestation`，人工补录必须明确来源。`artifact:{path,sha256}` 指向不可变 JSON，正文必须逐字段等于该事件去掉 artifact 后的内容，sha256 为文件原始字节哈希。执行时间、原始工具回执引用、实例状态与必要脱敏上下文可作为附加字段保存。

| type | 附加字段/行为 |
|---|---|
| source_review | `featureId,reviewedPaths,discoveredEntrypointIds`，逐功能覆盖全部实现引用和已知入口；新发现未登记入口产生 drift |
| launch | `outcome:ready/failed`；保留真实就绪或失败输出 |
| doctor | `outcome:healthy/unhealthy`，必须已有就绪实例；失败阻止 Drive |
| drive | `acId,targetId,outcome:passed/failed/verified_unreachable`；failed 必须分类，产品问题带另建 CHG 的 changeRef；不可达带 reason |
| recover | `outcome:restored,reason`；若重启改变 instanceHash，携带 `priorInstanceHash`，逻辑 instanceId 必须相同；随后必须新 Doctor |
| evidence | `evidenceIds:[EVD-ID]`，对应本 run 且经真实验收评估有效的目标观察 |
| cleanup | `outcome:cleaned/failed,preservedEvidence:true`；允许清理启动失败留下的实例；不删除证据 |
| retention_check | `outcome:retained`，位于成功 Cleanup 之后；程序另行重读并核对全部回执/业务证据哈希 |
| correction | `classification:drift/driver_gap,reason,beforeRef,afterRef`，仅记录地图/控制修正；产品故障另建变更，不能顺手修产品以获得维护通过 |
| release | 仅从未启动的计划可以凭 reason 释放会话，仍是 blocked；已启动必须实际 Cleanup |

Drive 意外失败后会失去健康标记；即便之前 Doctor 成功，也必须重新 Doctor 或先恢复实例再 Doctor。预期权限拒绝只允许通过对应负向 AC，不能替代正向功能。`verified_unreachable` 保留观察但始终阻断该必需目标。

## 恢复、一致性与结果

运行 journal 位于 `evidenceDir/maintenance/journal.json`，在项目维护锁内整体原子替换，保存 run、会话持有者、请求幂等记录及内容哈希。锁带 PID，不按时间自动删除活锁。新文件写入、刷新、关闭后才替换；相同 requestId 相同内容返回原结果，不同内容拒绝；旧 runHash 拒绝覆盖。人工篡改 journal 哈希会报错。中断后先核对锁的进程确已退出、实例身份和证据，再由同一协调者恢复；不能开第二代理共享会话。

恢复比较契约、源码、控制/路由/入口、环境和实例身份。仅新增 evidence 与地图修订元数据允许继续，原地图哈希留在 baseline；契约或源码变化不能继续计为原运行有效覆盖。若运行中源码变化，仍允许仅追加 cleanup/retention_check（从未启动允许 release）来安全结束旧实例，但该 run 永久 blocked，之后创建新 run。不得因保护检查失败而跳过必要清理。

`clean`＝当前所有范围已实跑并有有效观察、源码和入口无漂移、清理及证据复核完成；`changed`＝同样全部通过且记录了经验证的地图/控制修正；`blocked`＝仍有任何必需缺项。每个目标与失败总数完整保存在 journal，CLI 摘要不能吞掉未覆盖项。

本模块证明控制流程约束、文件完整性、上下文和声明断言；它不验证工具来源的密码学真实性，也不能凭源码哈希证明语义发现完整。项目工具回执和宿主实际操作是事实来源；人工观察、不确定性及尚未执行的 UI/外部服务效果必须如实区分。单元测试不代表 pstack 所选效果或真实项目已完整验收。
