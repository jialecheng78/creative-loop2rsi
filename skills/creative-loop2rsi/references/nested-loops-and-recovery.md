# 嵌套 Loop、状态与恢复

## 1. 先用单 Loop，后按责任拆分

只有满足以下任一条件时才拆出新 Loop：

- 一个问题反复出现，却不属于当前 owner 能独立解决的责任面；
- 某个中间产物需要独立确认、复用或恢复；
- 不同评价层必须由不同角色和证据处理；
- 局部重跑能够显著避免破坏已确认内容。

不要因为创作有“构思、起草、润色”三个名词就机械创建三个 Loop。没有独立产物、owner、触发和停止条件的步骤不算独立 Loop。

## 2. 用产物图连接 Loop

把系统表示为 Loop 与产物的二部图：

```text
[世界约束 Loop] --writes--> world-bible
                                |
                              reads
                                v
[任务结构 Loop] --writes--> quest-outline
                                |
                              reads
                                v
[对白 Loop] ----writes----> quest-dialogue
```

遵守这些规则：

- 每个产物只有一个写入 owner；
- 下游只通过声明的 `reads` 获取上游，不扫描未知目录；
- 任何上游变更都生成新的版本或哈希，不原地伪装成旧结果；
- 发布门读取所有 governing 产物，而不是“最后一个文件存在”就通过；
- 同一内容需要多种表达时，指定一个事实源和多个派生产物，不设多个事实源。

## 3. 定义失效传播

上游产物变化时，按依赖图把相关下游标为 `STALE` 或 `NOT_READY`，不要立即删除或覆盖它们。

只传播与变更有关的失效：

| 变更 | 应失效 | 不应失效 |
|---|---|---|
| 角色目标改变 | 依赖该目标的情节与对白 | 无关的世界地理设定 |
| 品牌禁用词新增 | 包含该词的文案与发布判断 | 已确认的受众定义 |
| 输出文件解析失败 | 当前 attempt 的结构结果 | Producer 已生成的原文 |
| Judge rubric 改变 | 相关评价结果 | 被评价的原始候选 |

记录失效原因、触发产物、旧哈希、新哈希和需要重跑的最小 Loop 集合。

## 4. 封存不可变 attempt

每次尝试使用独立目录，例如：

```text
creative-system/runs/<run-id>/attempts/<attempt-id>/
├── input/
├── output/
├── evaluations/
├── human-feedback/evidence.txt
├── findings.json
└── manifest.json
```

`manifest.json` 至少记录：

- run id、attempt id、Loop id 和状态；
- 读取产物的相对路径与哈希；
- 写入产物的相对路径与哈希；
- 使用的系统版本和 Judge 版本；
- 开始、封存时间；
- 决定：`revise/commit/stop/escalate`；
- 若有人给出认可或方向判断，记录先行冻结的送审 subject/anchor，以及绑定时间、声明和依据快照的 `HumanFeedbackReceipt`；
- 封存清单的整体哈希。

封存后拒绝任何覆盖。需要修正解析或评价时，创建新 attempt 或追加独立、更正有来源的补充记录，不伪造原始历史。

人工反馈前先运行 `open-human-review`：控制器冻结 selected artifact、Controller facts 和机器方向，写入 `HumanReviewSubject` 与 run control 下的独立 anchor。把冻结版本交给用户后，再逐字保存真实反馈到受保护的 `creative-system/approvals/attempt-feedback/`。`seal-attempt` 将它快照进 attempt 并要求 subject/anchor、by/at/evidence 齐全；反馈不得早于 `review_available_at`，送审后改稿或后改机器方向都会 BLOCK。裸 `human_accepted / human_direction` 不进入成熟度统计。`external-attestation-not-controller-verified` 表示控制器只验证内容、对象、时间和哈希，真人身份仍需从用户消息或外部审批系统复核。

### 4.1 机械事实由控制器生成

Producer 只负责创作产物和输入边界声明，不负责决定哈希、字节数、字数、行数等可机械复算事实。对 UTF-8 文本运行：

```bash
python3 <skill-dir>/scripts/loopctl.py measure-artifact <project-dir> \
  --source <project-relative-work.md> \
  --output creative-system/runs/<run-id>/attempts/<attempt-id>/controller-facts/<work>.json \
  --exclude-first-markdown-h1
```

- `controller-facts.json` 是机械字段的 governing evidence；Producer 自报值只作非治理提示。
- 两者不一致时，保留原始声明并记录差异，使用控制器值判断硬合同；不要仅因自报计数错误丢弃语义产物。
- 若控制器值本身违反长度等硬合同，再按硬合同处理。
- facts 只能写项目内新路径，拒绝覆盖、路径逃逸、符号链接和非 UTF-8 输入。
- attempt 内的 facts 只能写 `controller-facts/`，且 source 必须属于本次 selected artifact inventory；写进 Producer allowed-writes、引用其他 run/宪法或修改已封存 attempt 都会 `BLOCK`。

### 4.2 分离 dispatch stall 与内容修订

`ZERO_FILE_DISPATCH_STALL` 的机械定义只有一个：控制器统计本次 dispatch 在 Producer-owned `allowed-writes` root 内新增的普通文件，`output_file_count == 0`。`attempt.json`、日志、controller facts、audit 和 seal 文件不进入计数。0-byte 文件仍算 1 个内容文件；只要出现 1 个文件，就必须进入内容 attempt，再按合同判断完整或失格，不能改记为 runtime stall。

推荐命令顺序：

```bash
python3 <skill-dir>/scripts/loopctl.py open-dispatch <project-dir> \
  --run-id <run-id> --dispatch-id <dispatch-id> --context-id <context-id>
# Producer 只能写命令返回的 allowed_writes_root
python3 <skill-dir>/scripts/loopctl.py record-dispatch-stall <project-dir> \
  --run-id <run-id> --dispatch-id <dispatch-id> \
  --context-stopped --reason "执行上下文已停止且没有写文件"
```

文件数由控制器治理；`context_stopped` 是 orchestrator attestation，`loopctl.py` 不冒充已经机械观察到外部 Agent 状态。stall 后旧目录永久停用，新 dispatch 必须使用不同的 fresh write root。最终封存会在生成 seal 后、提交 run 状态前再次复核完整 attempt 清单、selected artifacts、controller facts 和所有 stalled root；旧 stalled root 后写记为 `LATE_WRITE_CONTAMINATION`，其他 commit 窗口变化记为 `ATTEMPT_CHANGED_DURING_COMMIT`。两者都写不可覆盖的 terminal incident，整个 attempt 永久失效且不消耗 content attempt。即使后来删除污染文件也不能重封。

stall 只减少 `runtime_dispatch_budget.max_zero_file_stalls`，不增加 `content_attempt_index`、`revision_index` 或 `max_no_improvement`。预算耗尽后 `stop/escalate`，不得伪装成创作质量退化。

`begin-run` 会把 runtime budget 冻结进 attempt；后改系统配置不能重新打开 `BUDGET_EXHAUSTED`。全部 mutation 命令共享项目级 fail-fast OS lock；不同 run、candidate、release 的写入也不能交叉覆盖 `system.json`。CLI `validate/audit` 获取同一锁读取一致快照；并发调用返回 `CONTROLLER_BUSY` 或读取到已提交终态。锁文件永久存在，进程崩溃时由操作系统自动释放。

promote 与 rollback 都先写 `creative-system/control/transactions/<id>/intent.json`，把 candidate status、registry 和 system 的 before/after 哈希及目标快照一次冻结。promote 还在同一事务中冻结 release bundle 清单、评价哈希、目标版本和批准人，并在 intent 落盘后才生成正式 release。未写 `committed.json` 前，`validate` 固定返回 `PENDING_CONTROLLER_TRANSACTION`；只有绑定参数一致的同操作重试才能按 intent roll-forward。恢复会先检查全部目标，若任一目标既非 before 也非 after 哈希，则返回 `TRANSACTION_DIVERGED`，不会先推进其他目标或覆盖外部改动。历史 committed transaction 只校验冻结快照和 receipt，不要求当前可变状态永远停在旧 after 状态。

v0.1 L4 的 controller eval ledger 固定只有三条：targeted、regression、held-out 各一次。每次 open 用独立 no-clobber anchor 冻结 evaluator role/context/task、外部 attester、当前 candidate change 哈希、允许输入类别、预算序号和预检为空的 fresh output root。输入边界至少包含创作宪法、rubric、盲化的 baseline/candidate output；held-out 另含 heldout input，但禁止 candidate proposal、Producer 推理、版本身份、heldout answer 和 mapping table。seal 绑定 anchor、preflight、输出清单与哈希；seal 期间变化写永久 terminal incident，封存后整个 eval output 永久只读。ledger 与晋升 JSON 必须精确等集且三条全 sealed；任何失败都建立 successor candidate，禁止在同一候选补跑或挑选组合。历史配置和输入可以按固定哈希引用，prior-run output 不得引用、复制或补位；发现任一旧输出即 `STALE_OUTPUT_CONTAMINATION`，整轮失效，禁止挑选复用未污染的局部结果。

当晋升证据明确报告失败、退化、污染或 fresh-root/全量重生失败时，控制器把该评价文件哈希写入不可覆盖的 candidate block-seal。之后清理输出或把同一 JSON 改成 PASS 都不能重新打开候选。

`evaluations/`、`control/`、anchor、terminal marker 与 eval run 路径一律拒绝 symlink。terminal-invalid output 与 sealed output 同样只允许复核，`measure-artifact` 等控制器命令也不得继续写入。

对已开启 eval 执行 seal 时若精确零输出或输出清单非法，分别写永久 `EVAL_EMPTY_OUTPUT / EVAL_OUTPUT_INVALID`。这不是可在同一候选补写的 runtime stall；exact-three 下必须建立 successor candidate。

## 5. 分区记忆

至少把记忆分成：

| 分区 | 可以写入 | 禁止写入 |
|---|---|---|
| `confirmed-facts` | 用户确认的世界、产品或事实 | 模型猜测 |
| `confirmed-preferences` | 用户明确偏好及来源 | 单次 Judge 分数 |
| `run-lessons` | 有 attempt 证据的局部教训 | held-out 答案 |
| `finding-index` | 结构化 finding 与聚类键 | 未保存证据的印象 |

为每条记忆保留来源、owner、作用域、写入时间和失效条件。上游事实撤回后，让依赖记忆失效；不要把旧偏好静默当作永久规则。

## 6. 自动恢复白名单

只自动执行：

1. 传输、文件读取或进程中断后的同输入重试；
2. JSON 缺逗号等能证明不改变创作语义的确定性修复；
3. 回退到已定位的责任 Loop，局部重生成其写入产物；
4. 恢复到前一稳定系统版本；
5. 达到预算或连续两次无改善时停止并升级给人。

禁止自动执行：

- 把未通过的创作内容悄悄改成 Judge 偏好的风格；
- 修改创作宪法或确认偏好以便“让测试通过”；
- 删除失败 attempt；
- 用新 Judge 重评历史后改写原判断；
- 读取 held-out 答案指导恢复；
- 无限重试直到偶然通过。

## 7. 选择责任 Loop

按证据定位最早的责任面：

1. 判断是运行故障、硬合同、软质量还是审美未决；
2. 找到首次产生问题的 governing 产物；
3. 找到该产物唯一 owner；
4. 重跑 owner Loop 及受其影响的最小下游集合；
5. 保留其他已确认且哈希未变的产物；
6. 重新计算端到端发布状态。

若无法把问题定位到唯一责任面，返回 `BLOCK` 或 `NEEDS_TASTE`，不要随机挑一个 Loop 重跑。

## 8. 受控循环

某些创作流程需要局部循环，例如“大纲—人物动机”互相修正。仅在以下条件齐全时允许：

- 明确循环入口和共同目标；
- 每轮产生不同版本和可比较证据；
- 指定总预算，而不是每个节点各自无限预算；
- 定义改善信号；
- 连续两轮没有改善时停止；
- 指定最终的人类 gate。

缺少任一项时，把循环判为配置错误，而不是运行时“再试一次”。

## 9. 局部恢复验收

演练一次可复核场景：

1. 完成一个端到端 run 并封存；
2. 人为制造一个明确、可恢复的下游解析失败；
3. 运行恢复；
4. 核对未受影响上游的路径和哈希不变；
5. 核对失败 attempt 仍存在；
6. 核对新 attempt 的 manifest 指向恢复原因；
7. 重新执行发布门。

只有“恢复成功且没有破坏证据”才满足 L2/L3 的恢复要求。
