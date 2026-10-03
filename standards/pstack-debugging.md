# 任务分类与基于证据的排错

使用 `task route --input <JSON>` 校验类别或目标组合，`debug plan --input <JSON>` 取得适用协议及锁定原文路径。类别为锁定的 23 类；仅 investigation、bug-fix、runtime-forensics、trace-forensics 接入本协议，其他类别明确返回 `not_adopted` 和后续方式。自然语言语义由当前代理判断，程序不按“问题”等关键词擅自变成修复。

输入可用 `{"category":"bug-fix"}`，也可用 `{"outcome":"diagnosis","evidenceMode":"captured"}`。outcome 可为 explanation、repair、diagnosis；后者必须区分 live/captured。矛盾或信息不够时保持未选择，不运行错误流程。

`debug plan` 只加载相应协议、源文件与适用依赖目录，逐次核验 Git Blob SHA。按需读其返回的 `sourceRefs` 原文，不能只看精简步骤而省略依赖。how 处理结构和运行链路，why 处理历史及七类可得来源，保持事实、推断、假设和未知分开。

执行前将本轮适用步骤、条件分支与跳过原因随原件保存。后来补出的说明只能标为事后复核，不能回填历史执行。仅检查本轮实际适用的分支；19类未采用流程继续保持 `not_adopted`，不因本轮有它们的后续建议而扩大采用范围。

修复先关联 FEAT/AC/CHG、实际入口、角色和环境，保留失败重现、候选假设、运行时机制和成功复验。证据推翻假设后只撤销相关试改。确认机制后才修，查同类模式，重启问题先核持久状态。便宜明确回归先取得失败结果；昂贵或不明确则记录理由和最接近的可执行替代证据。错误入口、不确定结果、仅单元测试不算原故障已消失。

实时取证取得适用 CPU、堆或 UI trace，收敛热路径/保留链、运行中证实机制并映射源码。已有 trace 保留原始字节，先转可查询样本/帧/节点，再分析并解析符号；未配对时只能提出有界假设。只诊断不擅自改产品。工具、权限、符号或数据缺失，保留具体缺口和已完成证据。

`debug audit --profile <项目配置> --input <JSON>` 核验原始证据存在、SHA-256、所属项目、同入口条件及记录完整性。证据 `path` 相对项目的 `featureMapRef.evidenceDir`，不允许越界；每条有 id、kind、path、sha256、projectId。重现与复验另记 surface、environment、role、result。修复还需 links、hypotheses、regression；带试改的反驳假设需 scopedRevert 与 revertEvidenceIds。这个入口是只读证据预检，始终返回 `behaviorVerified:false`，不能凭标签证明因果或关闭实际验收。

依赖与采用对应见 `upstream/pstack/dependency-closure.json`。共享配置、实际项目驱动、Codex 子代理及可用模型替代 Cursor 载体；本协议不改模型设置、不安装供应商、不新增费用授权。验证原始动作与结果后，再经统一地图事务登记验收；不能由本协议另建地图事实源。

### 可重复的隔离验收

- `node examples/verification-sample/ui-driver.mjs` 复用笔记样例控制入口。每轮独立端口、数据目录与浏览器；先保存步骤和源码原字节，再测1280×900/360×1000布局、关键元素可读性/范围/五点命中。临时窄屏溢出与按钮遮挡必须被拒绝，恢复后从原按钮点击复验；随后真实输入保存/搜索、刷新、CLI及重启读回。截图供视觉审阅，几何测量与业务结果独立判断。
- `node examples/verification-sample/visual-verify.mjs <本样例evidence下的运行目录>` 只读重算视觉判定并核原件、5份源码快照、外部控制收据与磁盘笔记；不重新采集或用转录的 `passed` 替代测量。
- `node examples/forensics-sample/effect-session.mjs --trace-dir <已给定Chromium原件目录>` 新采现有Node合成CPU/heap并运行调用树/GC-root查询；显式给定的UI trace只读查询与配对复核，步骤、原始收据、完整诊断和原件哈希一同保存。不默认引用开发仓库历史目录；外部原件按manifest复制到隔离样例供现有只读解析器读取，前后核原文件与manifest字节，不重新采集。该配对验收需要原trace/profile/干预profile/诊断/事件与帧原件，不能在缺原件时宣称完成。堆快照没有分配栈时，分配行保留为源码推断；不得因源码有构造语句而升格为堆独立证据。
