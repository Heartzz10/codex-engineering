# pstack 锁定来源审计

采用锁定提交 `b42effe0aa50f59c693d7e2924714e015e00bf7c`，子树 `f66b1f3ed67364a915305457ee9099edc44f9333`。2026-09-23 实际读取的官方 main 正好也是该提交，因此差异为零；没有以浮动 main 替换锁定版本。

首次默认沙箱 HTTPS 连接失败；经自动审核批准的只读网络重试成功。通过 Git 对象读取原始字节，避免 Windows 检出换行改变 SHA。冻结清单的 34 个文件 Blob SHA 全部相符。保留 127 份文本/许可快照，其余资源仅列 Git 树；保存更多来源不等于采用更多执行工作流。

`upstream/pstack/source-lock.json` 记录来源、SHA、字节数、SHA-256、许可及主分支对比。`sources/pstack/LICENSE` 是未修改 MIT 许可，版权 `Copyright (c) 2026 Lauren Tan`，复制或改编时必须保留。上游正文作为审计数据保存，不改变本项目指令优先级或授权。

## 行为与分类边界

`effects.json` 在冻结 17 条概括要求之外，保存逐句/分号/编号条件拆分的 2526 个来源行；每行包含固定源文件、行号、原句、Blob SHA、触发、前提、分支、依赖、拟接入口、验收编号、实现引用及原始证据槽。该表保留例子、背景和输出模板上下文，不能把行数当行为完成率。`source-line-coverage.json` 对所选正文及必要/条件依赖的 2604 行逐行记录提取或结构性处置，代码示例原样保留在源文件，未静默丢失异常段落。

`route-catalog.json` 从锁定路由正文提取 23 类及各自样例。只采用 investigation、bug-fix、runtime-forensics、trace-forensics 四个执行流程；其他 19 类明确 `not_adopted`，交给适用的既有能力。Opening a PR 的交付支持行为可适配，不能据此声称整个独立 PR 工作流已采用。分类目录状态与执行效果状态分开。

## 依赖闭包

`dependency-closure.json` 分开记录 `required`、`adapted`、`not_adopted`。how 的两个提示模板、why 的调查/综合/认识论模板、七类数据源和事故历史全部保存并提取。fix-root-causes 的同类模式及重启持久状态也在表内。create/maintain 的正常、失败、清理、不可达、漂移和恢复分支都保留。

条件依赖包括跨函数修复时的 architect/arena，审查时的 interrogate，便宜明确回归的 tdd，可读写作与真实界面控制。来源可核验不代表运行时工具已接通。Cursor 模型名、Task/loop API、Cursor skill 路径和控制命令需用实际可用的 Codex 配置等效替换；不得假装已安装 control-notes，也不要求新增付费供应商。why 数据源不可用需报告具体类别缺口；不允许伪造检索或把日志读取等同于 CPU/堆/UI 取证。

审计未发现必须立即新增产品范围或费用上限的决定。实现时若某个必需效果确实缺工具、权限或数据，该效果保留 blocked，不得自免。上游自动开 PR、重置工作树或外发消息等字面流程服从本项目已有授权及用户修改保护，保存其可审查交付效果。

## 状态与复核

所有效果均为 `planned`，实现引用与证据为空。当前完成的是来源与提取审计，尚未证明任何 Codex 运行效果。统计在 `audit-summary.json`，不可用来源哈希通过替代 PS-01 至 PS-04 的真实验收。

离线重核：`python upstream/verify-pstack-audit.py`。重建仅对已取得的 Git 对象运行 `python upstream/build-pstack-audit.py`；其输入包含冻结清单，重建会重置效果表为 planned，后续实现状态应存独立证据/映射记录，不覆写来源提取。
