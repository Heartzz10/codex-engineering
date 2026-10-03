# 真实验收路由与证据

`accept plan` 只生成当前 CHG 的 AC/目标计划，不启动写入或付费调用。每个目标绑定入口、角色、环境、数据范围及场景；实际执行由项目已有浏览器、API、CLI 或后台控制工具完成。`driverRef` 指向可发现的控制说明或工具，不是可被公共 CLI 任意执行的命令。

项目 `acceptanceRoutes` 使用 `schemas/acceptance.schema.json#/$defs/route`。kind 为 baseline/ui/api/cli/background。`available` 与 `real` 均为 true 才有真实执行路线。`authorizationRef` 引用现有授权。业务写入须有现有权限与隔离保障引用；付费须有现有供应商预算保护引用。配置引用仅表达已经建立的项目保障，公共程序不据此声称已经实现供应商限额。

`unsupported_route` 表示没有适用可用驱动，可寻找同等已授权入口；`blocked_guard` 表示必要保障缺失，不得换入口逃避。基础 run 的成功只证明基础检查。已有项目入口可承担真实写入/付费验收，无需为了形式先扩建基础运行器或重新向用户确认已有授权。

AC 的 `actions` 是有顺序的必要动作，类型可为 input/click/submit/wait/observe 或项目定义动作。只列适用步骤；不适用说明保留在条件正文。`assertions` 支持 JSON Pointer 定位的 equals/includes，预期来自当前 AC，实际值来自原始执行回执。manual 断言须提供判断人、来源、依据、不确定项和判断结果；存在未消除不确定项时不能通过。预期权限拒绝可以验证负向目标，但不能替代正向角色。

执行者先把 JSON 回执和原始图片/日志保存在项目 `featureMapRef.evidenceDir` 下的独立运行路径，再计算每个文件 SHA-256，交给 `accept record`。禁止覆盖已登记文件。文件哈希、路径越界（包括链接）、项目/AC/版本/执行 ID、实现文件指纹、入口/角色/环境/数据范围、动作顺序、等待完成及断言逐项校验。引用执行回执用 `type: execution`；其格式见 Schema 的 receipt。多目标必须分别给出完整 observation；跨角色/环境/数据范围的 EVD 顶层对应字段使用 `multiple`，逐目标仍保存准确引用。

`validateEvidence` 忽略调用者的 passed 标签，重新读取文件和计算结果。真实工具回执标 `tool_receipt`；人工补录标 `manual_attestation` 并填写 attestation 来源，不能把人工回忆标为工具记录。JSON 回执不是密码学签名，程序不能鉴别蓄意伪造的工具身份，不能凭字段齐全自动证明业务语义完整。工具出处与自然语言条件的充分性仍需可信执行者核对；评估保留这个边界。

`assessCoverage(profile,map,acIds)` 返回逐条件/目标的 passed/failed/blocked/stale/not_run、证据 ID、失败原因和不确定项。每次重读原件；缺失、覆盖、范围变化使当前复用状态 stale，历史原始观察不改。最新有效执行优先，不能用旧成功隐藏新失败。所有必需目标通过才允许关闭；有断言失败为 failed，保障/不确定项为 blocked，缺观察为 not_run。

AC 升版不自动复用。`map.carryForward` 显式记录旧 EVD/AC/目标、新 AC/目标、等价依据、来源、记录者和当前指纹/环境/角色/数据核对。只有登记时保存的条件契约与新目标完全等价，旧原件仍可读取且当前指纹未变，才继承；新增/改变目标仍须实际执行。该版本保守拒绝改变入口的自动等价继承，可重新执行新入口。

证据登记本身由地图公共事务分配 EVD ID 并原子提交；验收模块不自行写地图。测试中的隔离文件与受控样例验证公共校验机制，不能称作任意真实业务已验收。全范围维护与日常变更范围分开，汇总不得截断隐藏失败和未覆盖数量。
