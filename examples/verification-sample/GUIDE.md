> 公开副本中的 profile.template.json 是配置结构示例，不是可直接运行的配置。先运行 `node bootstrap.mjs`，由既有入口生成 profile.json、当前目录与 Node 绑定、登记 HTML 源检查。公开包不带维护者的 API/浏览器检查注册；指南中的业务操作仍需实际执行并登记结果。生成的本机配置不要上传。

# 隔离笔记验收样例

此样例只在 127.0.0.1 运行，使用 `.runtime/notes.json` 测试数据，不连接外部供应商，无付费调用。角色 sample-user，环境 isolated-loopback，数据范围 sample-only。它不提供生产安全能力。

## Rule checks

现有产品范围只有笔记输入/保存、列表和搜索；没有模态弹窗、登录/授权矩阵或外部AI服务。用户已于2026-09-28明确确认：**此隔离样例不要求业务日志**。可选事件回调与工程检查回执都不是业务日志；LOG-1～4在本样例中有依据不适用，其他项目须重新判断。`/api/notes` 是页面与CLI共用的内部JSON接口：创建只接收 `application/json`，正文必须是1–2000字字符串，非法请求不能写入。搜索以最近一次提交的查询为准；已返回的旧请求不能覆盖后提交的结果。

本隔离样例把一次保存尝试的 UUID 请求标识作为重试身份：同一标识与正文重放返回原笔记，不同正文返回冲突；保存成功后再次输入相同正文属于新的、允许的笔记。页面在请求进行中禁止重复提交；丢失响应时先按请求标识读回，无法确认时保留输入和标识、明确显示“结果暂时无法确认”，再次提交沿用标识。接口在同一数据文件内串行追加，独立并发请求都应保留；样例没有编辑旧笔记的冲突策略。这些是当前样例输入和持久化的最小保护，不构成其他项目的去重决定。

空白正文在输入框旁说明原因并聚焦该框，失败时保留原输入。普通网络异常只说请求未完成，不猜供应商或服务端原因；内部异常只返回安全提示和事件号。布局采用清晰的写入区与已保存列表区，保存和搜索共用按钮、焦点与状态样式；现有页面不提供折叠、弹窗、编辑旧笔记或临时搜索未保存警告。视觉一致性、文案可修正性和错误语义仍需对实际截图、操作和原件定向审查。长中文笔记应完整显示，不以无全文入口的省略代替正文。

`engineering-rules.json` 仅对本隔离样例声明适用条件。开发前用现有 `rules prepare` 看需读取的规则和缺口；`rules run/assess` 只执行所绑定的真实检查。`api-contracts` 启动独立回环服务，尝试错误格式、缺字段、超限、请求重放、并发和合法保存，核磁盘读回、dry-run不写、内部异常提示及事件号；`browser-flow` 使用原Chrome/Edge驱动复现乱序搜索、重复提交、断线重试、丢失响应、长中文及并发读回，保留原11目标与重启读回。两个检查只写隔离测试原件，需项目profile允许回环网络和测试原件；这不是业务角色权限。浏览器不具备时显示未运行或失败，不能以API检查代替。未绑定、人工审查、旧0→1及UI Q15/Q17缺口继续保留。

代码组织约束本样例内可以完整追踪的依赖方向：验收与控制脚本可调用 `server.mjs`，运行服务不能反向导入同目录验收/控制 `.mjs` 模块。`architecture-dependencies` 用现有 esbuild 解析样例模块的真实导入图；违规依赖失败、合法方向通过，所有参与边界判断的样例文件都纳入检查指纹，改动后旧回执过期。跨出样例目录的共享模块不是这条项目规则的检查对象；其他项目须定义自己的依赖方向。用户选择暂不决定支持浏览器/设备范围与性能目标，UI Q15/Q17 保持未完成。

现有地图已从无代码起点登记，勿重跑 `bootstrap.mjs --init`。`node driver.mjs launch` 启动，默认端口 43187；`node driver.mjs doctor` 为只读就绪检查。Doctor 比对 instanceId、PID、dataDir 和 server.mjs 源码指纹；源码变化后先 `cleanup` 再 `launch`，旧指针仍可用于核对后清理。`node driver.mjs cleanup` 仅停止核对过实例标识的本样例进程，保留数据、地图、证据。启动可用 `--port 0 --data-dir .runtime/<本次目录>` 分配隔离端口和数据目录；目录必须位于本样例 `.runtime` 内，实际 URL 与目录见 `.runtime/instance.json`。已有健康实例时，普通 `launch` 复用它；要换端口或数据目录，先 `cleanup`，显式再次启动会被拒绝以免覆盖旧实例的清理指针。

## Browser

打开实际启动 URL。ui-create：输入唯一笔记正文，点击“保存笔记”，等待列表出现完整正文并显示保存状态，再刷新确认持久化。ui-search：输入刚保存笔记的片段，点击“搜索”，等待列表只展示匹配项；再查不匹配词核对“没有匹配笔记”；清空搜索并再次搜索恢复全部结果。输入空正文时保留明确错误提示。

`node ui-driver.mjs` 使用本机已安装的 Chromium、Chrome 或 Edge 和 CDP，在独立端口与数据目录完成 Launch→Doctor→真实浏览器输入、点击、等待、刷新和读回→同实例 CLI 全入口操作→清理并在同数据目录重启→页面和 CLI 读回→最终 Cleanup。已有健康实例时会拒绝接管。它逐值核对原11个适用目标、迟到搜索响应目标、空正文错误、保存与重启后的完整正文和 ID、命中/无结果/清空搜索、dry-run 文件哈希；原始 DOM、ARIA 树、截图、CLI 收据和哈希清单保存在新建的 `evidence/ui-driver-<run>/` 及对应 CLI 原件，失败也保留报告。浏览器受到沙箱限制时需按本机权限处理，不把未完成步骤记为通过。

手工浏览器操作的回执/截图由宿主浏览器工具留存，人工整理观察必须标 manual_attestation 并写来源与不确定项。不得仅因 HTTP 200、成功提示或截图就判定保存；须核对页面及磁盘读回。

## CLI

`node driver.mjs create "唯一内容"`、`list`、`search "片段"`、`dry-run "预演内容"` 均通过运行中的真实服务操作。dry-run 输出拟创建结果，数据文件哈希必须保持不变。启动→创建→清理→重启→列出用于验证进程重启后持久化。`node driver.mjs verify-cli` 实跑所有 CLI 入口并生成原始观测报告到 evidence；报告本身不自动写地图或代替 UI 观察。

当前地图的 CLI 断言逐项比较输入、写入和读回内容、查询分支以及 dry-run 前后文件哈希，不采用旧 `/verified=true` 结果。需要登记本次真实报告时，用 `node import-cli-evidence.mjs evidence/cli-observations-<文件名>.json <runId> <changeId>`；UI 浏览器操作结果先写有来源归属的 `evidence/ui-observations-*.json`，再用 `node import-ui-evidence.mjs <报告相对路径> <runId> <changeId>`。旧弱证据保留但已标失效。一次变更先登记实际源码影响，再复测并登记结果；新证据不得用旧 run 冒充完整维护。

## UI-quality

当前 profile 用 `uiQualityRef: "ui-quality.json"` 接入 Q01～Q18 项目配置；适用性来自 `ui-quality-facts.json` 和现有任务原文。`node ../../src/cli.mjs ui prepare --profile profile.json` 在编码前显示规则与缺口；`node ../../src/cli.mjs ui source --profile profile.json` 复用登记的 `ui-html-source` 检查，直接调用公共 `scripts/ui-source-check.mjs` 检查 `public/index.html`，不访问网络或业务数据。源码检查通过仅证明五类明确 HTML 规则。

`node bootstrap.mjs` 仅增量接入 UI 引用和检查，保留用户已有配置、地图、历史、草稿和证据。已有历史地图时 `--init` 明确拒绝，不能重新造 0→1 历史；导入 bootstrap 也不会写文件。

浏览器脚本同时输出实际业务结果和 `uiQuality` 覆盖。布局、文字、语义、焦点、输入、异步与恢复的本轮观测不能替代未登记的性能阈值或未执行的平台目标；当前完整 UI 质量仍为 `incomplete`，Q15/Q17 的缺口保持可见，原生/专用平台未实证。旧 0→1 的 CHG-0001～0003、A17 及未来同步保持原状态；新增接线不关闭它们，也不把业务 11 个目标通过称为全部 UI 覆盖通过。

全部已知用户入口是 ui-create/ui-search/cli-create/cli-list/cli-search/cli-dry-run。HTTP /api/notes 是 UI 和 CLI 共用内部传输，/health 是只读控制入口。未来同步保留 planned，不计作已实现功能。维护须逐一审查 server.mjs、driver.mjs、public/index.html、ui-driver.mjs 并记录新发现入口，逐目标操作；意外失败先 doctor，不顺手改产品结果。清理后重新计算证据文件哈希确认保留。CHG-0006 的登记、源码恢复顺序及本次原件见 `evidence/chg6-provenance-20260924.json`。
