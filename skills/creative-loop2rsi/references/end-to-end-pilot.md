# 端到端 L4 试点与晋升后迭代

## 目录

1. 适用请求
2. 两套计数器
3. 分阶段路线
4. 人工门的最小交互
5. 真实独立评价
6. 晋升后的每轮证据
7. 停止与失败处理
8. 交付口径

## 1. 适用请求

当用户要求“从零搭系统、做到可验证自我改进、然后再连续运行 N 轮”时使用本流程。不要把它压缩成一轮对话内的十次改稿，也不要在成熟度尚未成立时把普通反馈 Loop 称为 RSI。

先向用户解释一个最小区别：

```text
前置 run 用于证明系统可靠并通过晋升；只有 audit 已证明 L4 后开始的 run，才计入“系统实现后的 N 轮”。
```

不要要求用户理解 L0–L4 的 Schema。把这些等级翻译成“先定边界、再试写、校准检查者、拆分责任、验证规则候选、正式运行”。

## 2. 两套计数器

始终分开记录：

| 计数 | 用途 | 能否计入用户要求的 N 轮 |
|---|---|---|
| `bootstrap / calibration` | 证明 L1–L3，收集真实 finding，校准 Judge 和恢复 | 否 |
| `post-l4` | 使用已晋升 active version 进行正式自我改进运行 | 是 |

不要事后把 bootstrap run 重命名为 post-l4。`begin-run` 会把当时的 active version、可证明成熟度和计算出的阶段写入不可变 manifest；以该证据为准。

## 3. 分阶段路线

### A. L0：确认创作立宪

- 收集五项自然语言输入；
- 展示立宪摘要和受保护表面；
- 等用户明确确认；
- 默认先初始化未确认项目，把用户当前确认回复逐字保存到 `creative-system/approvals/charter-confirmations/evidence/`，再用 `confirm-charter` 生成内容寻址 receipt；
- 运行 `validate / audit`。不得手改 boolean 或从“继续运行”推断确认。

### B. L1：尽早建立人工认可

- 选择三个规模小、彼此不同、但能代表目标方向的完整任务；
- 每个任务都运行真实 produce → evaluate → decide；
- 在三个结果齐全后暂停，给用户一个批量对比包；
- 每个代表结果完成 Producer、Judge 与机械计数后先运行 `open-human-review`，冻结送审版本和机器方向；再请用户逐项给 `认可 / 不认可 / 需要调整审美`，至少两个明确认可后封存相应人工方向证据。

不要先完成整部长篇或全部 N 轮，最后才询问是否认可。固定顺序是 `produce/evaluate/measure → open-human-review → 展示冻结版本 → 用户反馈 → seal-attempt`。把原始反馈逐字放入 `creative-system/approvals/attempt-feedback/`，用 `HumanFeedbackReceipt` 绑定 by/at/claims/evidence snapshot 与先行 subject/anchor 后再封存。反馈不得早于 `review_available_at`；封存后不得补写或代签，送审后改稿必须重新走新 attempt。

### C. L2：校准真正独立的 Judge

- 把样本补足到至少五个；
- 让独立 Judge 在看不到 Producer 推理和用户选择的情况下先给 `PASS / BLOCK / WARN`；
- 再收集人的方向，记录一致与分歧原因；
- 保证硬合同无假通过；
- 演练一次局部恢复，并证明旧 attempt 与上游证据未改变。

### D. L3：只从真实瓶颈拆 Loop

- 根据前述 finding 拆出至少两个责任 Loop；
- 为产物设置唯一 owner 和显式 reads/writes；
- 重跑责任 Loop，证明已确认上游仍有效；
- 做一次端到端比较，确认不低于 L2 基线；
- 记录解决了哪个真实观察问题。

### E. L4：候选、独立评价与人工晋升

- 只从至少三次独立真实 run 的重复 finding 创建候选；
- 写出实际 `changes/` 文件，不只写提案；
- Builder receipt 显式锁定 `finding-evidence / creative-charter / editable-surface / system-contract / evaluation-policy` 五类输入，禁止 `heldout-input / heldout-answer / mapping-table / producer-reasoning / version-identity`；
- 锁定 target、regression 和 held-out，用 `selection-safe exact-three` 每类恰好开启一次；
- 由未参与候选生成的独立评价者完成盲比；
- 把四门结果和回滚点展示给用户；
- 只有用户明确批准范围后执行 `promote`；
- 再运行 `validate / audit`，以 `provable_maturity=L4` 和 active version 的 `COMMITTED` 记录作为正式起点。

### F. 正式计数 N 轮

晋升后才把计数清零为 0。每次调用 `begin-run` 后，检查回执和最终 manifest 的：

```text
run_phase = post-l4
provable_maturity_at_start = L4
active_version_at_start = <已晋升版本>
```

任一不满足，该 run 不计入 N。

## 4. 人工门的最小交互

系统承担整理工作，用户只做不可替代的选择：

1. L0：确认立宪；
2. L1/L2：批量认可代表结果并标记方向；
3. L4：批准或拒绝候选晋升范围；
4. 最终：选择发布候选或保留基线。

每次最多展示三个可比较选项和直接证据路径。用户说“继续自动跑”不等于授权系统代签人工评价；到门点仍要暂停。

两类人工 receipt 都写 `identity_authentication=external-attestation-not-controller-verified`。这不是免责占位符：控制器只能验证依据、时间、对象和哈希，维护者必须能从 Codex 用户消息或外部审批记录回查确认者；没有外部反馈就保持 `NEEDS_TASTE`，不得生成格式正确但事实虚假的 receipt。

## 5. 真实独立评价

JSON 中写不同 `agent` 名称只是合同，不是执行证据。

Codex 能启动 subagent 或新任务时：

- 为 Producer、Judge、held-out evaluator 使用不同执行上下文；
- Judge 只读取立宪、rubric、候选作品和必要事实，不读取 Producer 推理、修改意图或版本身份；
- held-out evaluator 不读取答案、候选 proposal 或映射表；
- 建候选时保存 Builder role/context/task、外部 attestation 和显式 `input_boundary`；安全必需集合为 `finding-evidence / creative-charter / editable-surface / system-contract / evaluation-policy`，不得夹带 held-out、Producer reasoning 或 version identity；
- 候选可从本地 dispatch 记录冻结 finding 来源 Producer context；Producer task 只能标为 `external-attestation-required`，控制器不冒充已验证该 task 或身份真实性；
- 已知 Producer、Builder、evaluator、attester 的 role/context/task 出现禁止重合时立即拒绝；每个 evaluator 保存不同的外部 role/context/task、attester、输入边界、输出路径和时间；
- 用 `measure-artifact` 生成哈希、字节数和文本计数；Producer 的同名自报字段不作为 governing evidence；
- 用 `open-dispatch` 为每个执行上下文分配唯一 allowed-writes root；精确零文件时用 `record-dispatch-stall`，不推进内容 attempt；
- target、regression、held-out 分别用 `open-eval-run` 写入独立 no-clobber `EvalRunOpenAnchor`，绑定 preflight、execution receipt、`candidate_change_hashes`、`evaluation_run_index / max_evaluation_runs` 和 fresh empty root；
- v0.1 每个候选的控制器 ledger 必须恰好三条，targeted、regression、held-out 各一次，三条全 sealed 并与晋升 JSON 精确等集；任一已开启 run 失败就改建 successor candidate，不得同候选补跑或挑选；
- evaluator 完成后用 `seal-eval-run` 固定原始输出清单与哈希；seal 期间任何变化都写 `EVAL_CHANGED_DURING_SEAL` 永久 `TerminalEvalIncident`，sealed output 对包括 `measure-artifact` 在内的控制器也永久只读；
- eval 控制面与 run 路径拒绝 symlink；terminal-invalid output 和 sealed output 都对控制器永久只读；
- 已开启 eval 在 seal 时精确零输出或清单非法，写永久 `EVAL_EMPTY_OUTPUT / EVAL_OUTPUT_INVALID`，不得补写后在同一候选重封；
- 评价者完成后再由主执行者汇总，不修改其原始输出。

若当前环境不能启动独立执行者，明确把独立性标为未满足，停在相应成熟度。不要用“我切换了角色”替代独立上下文。`loopctl.py` 能冻结外部 attestation 并阻止 role/context/task 重合，但不能认证这些 id 是否真实；审计者必须能在 Codex 任务或其他外部系统中回查。

每个新 eval run 必须使用 fresh empty output root 并重新生成全部评价输出；prior-run output 不得引用、复制或补位。发现 `STALE_OUTPUT_CONTAMINATION` 时整轮失效，当前候选改建 successor candidate，不得保留其他新输出继续晋升。`provisional-audit` 不能冒充最终 `block-seal`，最终封印也不能被同 scope 的后写裁决覆盖。

## 6. 晋升后的每轮证据

每个 post-l4 run 至少保留：

- active version 与成熟度快照；
- 输入作品或任务及哈希；
- 独立 Judge 原始评价；
- 结构化 finding 与责任面；
- 隔离候选或明确的“不修改”决定；
- target / regression / held-out 适用结果；
- `commit / reject / rollback / stop` 决定；
- 与上一有效版本的可观察差异；
- attempt manifest 和 seal。

若该轮写入人工认可或方向，manifest 还必须包含通过验证的 `HumanFeedbackReceipt`，并绑定 `HumanReviewSubject / HumanReviewOpenAnchor`；没有人工判断的合法轮次保持 unknown，不为凑成熟度伪造判断。

一次 run 可以合法地拒绝候选。只要它检验了一个可证伪改进并按证据作出决定，就属于系统运行；但报告必须分开“运行轮数”和“有效晋升数”。

## 7. 停止与失败处理

- 同一改进方向连续两次无改善：停止该方向；
- 没有新的可证伪 finding：允许 `stop`，不能做无目标改写；
- 辅助命令缺失：优先使用 Python 标准库的确定性实现，不依赖 `shuf` 等非跨平台命令；
- 精确零文件 dispatch stall：记录并在独立 runtime budget 内换 fresh context；不算内容修订、改善或 comparison；
- 任一 controller-opened eval run 失败、未封存或 terminal-invalid：当前候选停止，建 successor candidate；不得在同一候选重启、补跑或从旧 run 挑选结果；
- eval seal 期间发生变化：写 `EVAL_CHANGED_DURING_SEAL` 永久 terminal incident；清理迟到文件也不能恢复；
- 任一 prior-run output 混入新 eval run：写 `STALE_OUTPUT_CONTAMINATION`，整轮失效并建 successor candidate；
- 晋升证据已明确报告失败、退化、污染或 fresh-root failure：写不可覆盖的 candidate block-seal；后改同一 JSON 为 PASS 不得洗白；
- Judge 与人分歧：返回 `NEEDS_TASTE`，冻结该候选；
- held-out 污染或身份泄露：该比较作废，重新建立未污染集合；
- active version、晋升记录或哈希不一致：立即 `BLOCK`。
- 最终 `block-seal` 已写入：同一候选永久失格，只能使用新候选 id；后写解释不能解封。

用户要求至少 N 轮与停止条件冲突时，如实报告已完成的有效试验数和停止证据；不能重复运行凑数。

## 8. 交付口径

最终同时交付：

- 创作成品与当前发布状态；
- bootstrap / calibration run 数；
- L4 晋升记录和回滚点；
- post-l4 请求轮数、实际轮数、接受/拒绝/回滚分布；
- 独立 Judge 和 held-out evaluator 证据；
- `validate / audit` 原始结果；
- 未完成或未验证项。

准确说法是“达到 L4 的可验证自我改进系统，并完成 N 次晋升后运行”。不要把 L4 说成完整自主 RSI；L5 仍是 `experimental / unvalidated / CANDIDATE only`。
