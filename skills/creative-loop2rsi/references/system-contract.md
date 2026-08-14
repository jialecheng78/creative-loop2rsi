# 系统公共合同

## 1. 设计原则

- 用 JSON 保存机器合同，用 Markdown 保存人的立宪与解释。
- 把用户作品和运行证据留在用户项目，不写入 Builder Skill。
- 所有标识符使用稳定的 `lower-kebab-case`，不要把时间戳当业务身份。
- 所有项目内引用使用相对路径；禁止依赖本机绝对路径。
- 每个产物恰好有一个写入 owner；可以有多个读取者。
- 把事实证据与解释分开。Finding 的 `evidence` 指向可检查产物，不把 Judge 结论本身当原始证据。
- 把成熟度视为审计结果，不允许用户配置直接宣告更高等级。
- `loopctl.py` 的结构化输出固定为 UTF-8 JSON，不依赖 Windows 或其他平台的本地控制台编码。
- Controller 生成的结构化文本固定使用 UTF-8/LF；生成项目必须用 `.gitattributes` 禁止 Git 对任何 tracked 文件做文本或换行转换，因为任意项目内文件都可能成为内容寻址证据。所有摘要以磁盘原始字节为准，跨 Git clone 必须保持原字节与哈希。

## 2. CreativeSystem

`creative-system/system.json` 作为系统入口，至少表达：

| 字段 | 含义 |
|---|---|
| `schema_version` | 合同版本，v0.1 使用固定公开版本 |
| `project` | 项目 id、名称、领域 Skill 和 active version |
| `kind` | 固定为 `CreativeSystem` |
| `charter` | 立宪路径，以及经内容寻址 `CharterConfirmation` 验证后的确认镜像 |
| `maturity` | 维护者当前声明和证据引用，不能代替 `audit` 结果 |
| `loops` | LoopSpec 文件引用列表 |
| `artifacts` | 产物 id、路径、owner 与保护属性 |
| `judges` | JudgeSpec 文件引用列表 |
| `memory` | 记忆分区、写入者和保留策略 |
| `recovery_policy` | 内容 attempt、运行 dispatch、机械证据和升级到人的条件 |
| `learning_policy` | finding 聚类、候选、评价和晋升规则 |
| `promotion_policy` | 人工批准、四类证据和 L5 禁止自动晋升规则 |
| `protected_surfaces` | 候选永远不得修改的表面 |
| `editable_surfaces` | 当前等级允许候选提出修改的表面 |
| `statuses` | 执行、质量与发布三条状态轴 |

最小示意：

```json
{
  "schema_version": "0.1",
  "kind": "CreativeSystem",
  "project": {
    "id": "fictional-story-lab",
    "name": "虚构故事实验",
    "domain_skill": "fictional-story-writer",
    "active_version": "baseline-v1"
  },
  "charter": {
    "path": "creative-system/creative-charter.md",
    "confirmed": true,
    "confirmed_by": "project-owner",
    "confirmed_at": "2026-01-01T00:00:00Z",
    "confirmation_receipt": "creative-system/approvals/charter-confirmations/confirmation-<sha256>.json",
    "confirmation_receipt_sha256": "<sha256>"
  },
  "maturity": {"declared": "L1"},
  "loops": ["creative-system/loops/draft-story.json"],
  "artifacts": [
    {"id": "story-draft", "path": "outputs/story-draft.md", "owner": "story-producer", "kind": "output", "protected": false}
  ],
  "judges": ["creative-system/judges/story-review.json"],
  "memory": {"partitions": []},
  "recovery_policy": {
    "max_attempts": 3,
    "runtime_dispatch_budget": {
      "max_zero_file_stalls": 2,
      "zero_output_consumes_content_attempt": false,
      "on_exhausted": "escalate"
    },
    "mechanical_evidence": {
      "governing_source": "loopctl.py measure-artifact",
      "producer_self_report": "non-governing"
    }
  },
  "learning_policy": {"minimum_independent_runs": 3},
  "promotion_policy": {"human_approval_required": true, "l5_auto_promotion": false},
  "protected_surfaces": [
    "creative-system/creative-charter.md",
    "creative-system/approvals/",
    "creative-system/evals/heldout/",
    "LICENSE",
    "promotion-policy",
    "human-approval-boundary"
  ],
  "editable_surfaces": ["prompts", "context"],
  "statuses": {
    "execution_status": "NOT_STARTED",
    "quality_status": "NOT_EVALUATED",
    "release_status": "NOT_READY"
  }
}
```

### CharterConfirmation

`charter.confirmed` 只是经验证镜像，不是确认事实源。默认先 `init`，再在用户当前交互中明确确认后运行 `confirm-charter`。人工原始回复必须保存在 `creative-system/approvals/charter-confirmations/evidence/`；不得从“继续运行”、旧偏好或任务目标推断确认，也不得只改 boolean。

```json
{
  "schema_version": "0.1",
  "kind": "CharterConfirmation",
  "confirmed_by": "project-owner",
  "confirmed_at": "2026-01-01T00:00:00Z",
  "recorded_at": "2026-01-01T00:00:01Z",
  "charter": {
    "path": "creative-system/creative-charter.md",
    "sha256": "<sha256>",
    "bytes": 1234
  },
  "evidence": {
    "path": "creative-system/approvals/charter-confirmations/evidence/initial-confirmation.md",
    "sha256": "<sha256>",
    "bytes": 96
  },
  "identity_authentication": "external-attestation-not-controller-verified"
}
```

receipt 文件名由宪法哈希、依据哈希、确认人和确认时间的 canonical JSON 摘要决定。默认重试复用当前语义匹配 receipt；人主动修改宪法后重新确认会生成新 receipt。全部磁盘 receipt 必须与 `CharterConfirmationLedger` 路径集合严格一致；`confirm-charter` 只会恢复唯一语义匹配的 orphan 或 ledger-ahead-system，歧义一律 BLOCK。人工原文默认不进 Git：clone 后缺失只产生 `LOCAL_CONFIRMATION_EVIDENCE_UNAVAILABLE` warning，存在时仍严格复核类型、哈希和字节数。receipt/ledger 证明已记录摘要，不能替代原文归档或认证 `confirmed_by` 背后一定是真人。

### 运行时成熟度快照

`begin-run` 在创建新 run 时计算并冻结以下字段，使用者不得通过参数自行声明：

| 字段 | 含义 |
|---|---|
| `active_version_at_start` | run 开始时经过验证的 active version |
| `provable_maturity_at_start` | run 开始时 `audit` 实际可证明的成熟度 |
| `run_phase` | `post-l4` 仅在上项为 L4 且 active version 非基线时成立；其余为 `bootstrap` |

三个字段同时写入 run、attempt 和封存 manifest。它们用于证明运行发生在晋升之前还是之后，不能靠文件名、用户声明或事后修改替代。`audit.evidence.post_l4_runs` 只统计封存 manifest 中真实的 `post-l4` run。

## 3. LoopSpec

每个 `creative-system/loops/<id>.json` 必须定义：

| 字段 | 约束 |
|---|---|
| `id` | 全项目唯一 |
| `goal` | 写可观察的完成结果，不写“提高质量” |
| `reads` | 读取的产物 id 列表 |
| `writes` | 写入的产物 id 列表；每项只属于一个 owner |
| `owner` | 对结果和恢复负责的单一 agent/role id |
| `trigger` | 首次运行或上游变化的触发条件 |
| `producer` | `{agent, separate_from_judges}`；生成角色不得与 Judge 共用身份 |
| `judges` | Judge id 列表 |
| `decision_policy` | `commit/revise/stop/escalate` 的判定顺序 |
| `memory_updates` | 可写入的记忆区；不允许隐式全局写入 |
| `retry_budget` | 内容修订预算，包含 `max_attempts`、`max_no_improvement` 和耗尽动作；不混入零输出 dispatch stall |
| `stop_conditions` | 至少包含预算耗尽和连续无改善 |
| `human_gate` | `{required, when}`，声明需要人确认的节点 |

示意：

```json
{
  "id": "draft-story",
  "goal": "交付一篇有完整转折和结尾的短故事",
  "reads": ["story-brief"],
  "writes": ["story-draft"],
  "owner": "story-producer",
  "trigger": {"on": ["manual", "story-brief.changed"]},
  "producer": {"agent": "story-producer", "separate_from_judges": true},
  "judges": ["story-contract", "story-taste-review"],
  "decision_policy": ["hard-block", "needs-taste", "revise", "commit"],
  "memory_updates": ["confirmed-preferences", "run-lessons"],
  "retry_budget": {"max_attempts": 3, "max_no_improvement": 2, "on_budget_exhausted": "escalate"},
  "stop_conditions": ["retry-budget-exhausted", "no-improvement-twice"],
  "human_gate": {"required": true, "when": "before-release"}
}
```

### ControllerArtifactFacts

可机械复算的字段使用独立控制器证据：

```json
{
  "kind": "ControllerArtifactFacts",
  "source": {"path": "outputs/work.md", "sha256": "...", "bytes": 1234},
  "supersession": {
    "generation": 2,
    "predecessor": {"path": "creative-system/runs/run-1/attempts/attempt-001/controller-facts/work-v1.json", "sha256": "...", "bytes": 987}
  },
  "scope": "exclude-first-markdown-h1",
  "metrics": {
    "line_count": 20,
    "unicode_codepoint_count": 900,
    "unicode_han_count": 760,
    "unicode_han_metric_version": "unicode-han-v1"
  },
  "authority": {
    "mechanical_fields_governing": true,
    "producer_self_report_governing": false
  }
}
```

facts 必须绑定本次 selected artifact 的源文件哈希，并写入当前 attempt 的 `controller-facts/`；不得写入 Producer allowed-writes 或引用其他 run/宪法。第一次计量的 `generation=1 / predecessor=null`。同一 source 改稿或更换计量 scope 后，再次运行 `measure-artifact` 并指定一个新的 output；控制器自动让新 facts 绑定当前 active facts 的 path/sha256/bytes。旧文件保持不可变，活动态由“没有被后继引用的唯一链尾”推导，不靠改写旧文件的 boolean。链必须单根、无分叉、代次连续且前驱摘要可复核；任何 superseded facts 被篡改都会 BLOCK。

`seal-attempt` 只用唯一 active facts 治理当前源文件，但会把全部历史 facts 纳入 attempt 清单并验哈。Controller facts 至少治理期望/实际写入清单、文件数、路径、哈希、字节数、来源 run、预算计数与 seal 状态。`producer_report` 应分开保存：它可以声明输入边界与完成状态，但其机械计数不能覆盖控制器结果。Controller facts 只治理存在性、完整性、provenance 与硬合同，不替代 Judge 的创作质量判断。

### HumanReviewSubject 与 HumanReviewOpenAnchor

用于成熟度的人类反馈必须引用一份先于反馈存在的冻结送审对象。作品、Controller facts 和 Judge 方向准备完毕后运行：

```bash
python3 loopctl.py open-human-review <project> --run-id <run-id> \
  --machine-direction PASS
```

控制器在 attempt 内不可覆盖地写 `human-review/subject.json`，并在 run 的独立 control 面写 `HumanReviewOpenAnchor`。subject 绑定 selected dispatch、artifact root、精确文件清单、唯一 active facts 的 path/sha256/bytes、机器方向和 `artifact_subject_sha256`；`artifact_subject_sha256` 覆盖这些 facts 摘要。anchor 绑定 subject 路径、subject 哈希与 `review_available_at`。`review_available_at` 必须严格晚于 attempt 开始。人工反馈后若任何送审字节、active facts 的路径、scope、哈希或字节数、机器方向改变，`seal-attempt` 和 `validate` 都返回 `HUMAN_REVIEW_SUBJECT_STALE`，旧反馈不能迁移到新版本。

### HumanFeedbackReceipt

`human_accepted` 或 `human_direction` 任一不是 unknown 时，必须先完成 `open-human-review`；随后 `seal-attempt` 同时取得 `--human-feedback-by / --human-feedback-at / --human-feedback-evidence`。依据只允许来自受保护的 `creative-system/approvals/attempt-feedback/`，并在封存前快照进当前 attempt 的 `human-feedback/evidence.txt`。

```json
{
  "schema_version": "0.1",
  "kind": "HumanFeedbackReceipt",
  "subject": {
    "run_id": "run-1",
    "attempt_id": "attempt-001",
    "loop_id": "main-loop",
    "review_subject_path": "creative-system/runs/run-1/attempts/attempt-001/human-review/subject.json",
    "review_subject_sha256": "<sha256>",
    "review_open_anchor_path": "creative-system/runs/run-1/control/human-review-open-anchors/attempt-001.json",
    "review_open_anchor_sha256": "<sha256>",
    "review_available_at": "2026-01-01T00:09:59.000000Z",
    "artifact_subject_sha256": "<sha256>"
  },
  "claims": {
    "human_accepted": true,
    "human_direction": "PASS"
  },
  "feedback_by": "project-owner",
  "feedback_at": "2026-01-01T00:10:00Z",
  "recorded_at": "2026-01-01T00:10:01Z",
  "source_evidence": {
    "path": "creative-system/approvals/attempt-feedback/run-1.md",
    "sha256": "<sha256>",
    "bytes": 88
  },
  "snapshot": {
    "path": "human-feedback/evidence.txt",
    "sha256": "<sha256>",
    "bytes": 88
  },
  "identity_authentication": "external-attestation-not-controller-verified",
  "controller_verification": {
    "evidence_hash_verified": true,
    "human_identity_verified": false
  }
}
```

receipt 绑定 run、attempt、Loop、冻结 subject/anchor、两项人工判断、时间与依据快照。时间必须满足 `attempt.opened_at < review_available_at <= feedback_at <= sealed_at`；manifest 的 `machine_direction` 必须等于反馈前冻结的方向。顶层人工字段只是查询缓存；`audit` 只统计通过 receipt 校验的判断。控制器不能认证身份字符串，Skill 必须回查真实用户消息，不能让执行 Agent 自写“用户已认可”。

### DispatchStallRecord

零文件恢复使用与内容 `retry_budget` 独立的记录：

```json
{
  "kind": "DispatchStallRecord",
  "reason_code": "ZERO_FILE_DISPATCH_STALL",
  "controller_facts": {
    "allowed_writes_root": "creative-system/runs/run-x/attempts/attempt-001/dispatches/producer-a/artifacts",
    "regular_file_count": 0,
    "mechanically_governing": true
  },
  "orchestrator_attestation": {
    "context_stopped": true,
    "mechanically_verified_by_loopctl": false
  },
  "content_attempt_consumed": false,
  "revision_consumed": false,
  "no_improvement_consumed": false
}
```

控制器只能机械证明 allowed-writes 精确零文件；执行上下文确已停止属于 orchestrator attestation，两层不得混写。每次 dispatch 使用 `open-dispatch` 分配的新目录；seal 后、run commit 前仍会复查完整 attempt。commit 窗口内若已 stall 目录或其他 attempt 文件变化，整个 attempt 写入单调 terminal incident，永久失效且不消耗 content attempt。

### EvalRunOpenAnchor / EvalRunPreflight / EvalRunManifest

`open-eval-run` 必须产生两份独立的 no-clobber 开跑证据：

1. `evaluations/<eval-run-id>/preflight.json` 记录 controller-verified fresh empty output root 和完整 execution receipt；
2. `control/eval-open-anchors/<eval-run-id>.json` 保存不随 eval run 目录重建而消失的 `EvalRunOpenAnchor`。

```json
{
  "kind": "EvalRunOpenAnchor",
  "state": "OPEN_ANCHORED",
  "candidate_id": "candidate-pace-v2",
  "eval_run_id": "heldout-v8",
  "phase": "heldout",
  "preflight_path": "creative-system/candidates/candidate-pace-v2/evaluations/heldout-v8/preflight.json",
  "preflight_sha256": "...",
  "execution_receipt_sha256": "...",
  "candidate_change_hashes": {"skills/story-writer/SKILL.md": "..."},
  "evaluation_run_index": 3,
  "max_evaluation_runs": 3
}
```

`EvalRunOpenAnchor` 必须与 preflight、execution receipt、当前 `candidate_change_hashes`、`evaluation_run_index / max_evaluation_runs` 双向验哈。它一旦写入就占用该预算序号；删除 preflight、输出或重建同名目录都不能退回预算、换 receipt 或换候选字节。

候选 proposal 先保存 Builder receipt 和 `producer_execution_boundary`。Builder receipt 的 `input_boundary` 必须恰好包含安全必需集合 `finding-evidence / creative-charter / editable-surface / system-contract / evaluation-policy`，并拒绝 `heldout-input / heldout-answer / mapping-table / producer-reasoning / version-identity`。Builder 与 evaluator receipt 都必须写 `identity_authentication=external-attestation-not-controller-verified`；该 boundary 只是控制器冻结的外部执行回执，不证明 Builder 身份或 task id 真实。

控制器可从 finding 来源 run 的本地 dispatch 记录冻结 `controller_recorded_context_ids`；Producer task 在 v0.1 没有本地事实源，因此 `controller_recorded_task_ids` 保持空数组，`task_identity_coverage` 必须是 `external-attestation-required`。不得把 Producer task 或任何身份 id 的真实性写成控制器已认证。

所有控制器已知身份都要做冲突检查：Producer role/context、Builder role/context/task/attester、三个 evaluator role/context/task/attester 和评价协调者之间出现禁止的重合时，拒绝创建候选、开启 eval run 或晋升。Builder attester 可以继续作为三个 evaluator 的共同外部 attester，但不得自己成为 evaluator role/context/task 或评价协调者。input boundary 禁止 candidate proposal、Producer reasoning、version identity、heldout answer 和 mapping table。未被本地冻结的 task/identity 仍需回查 Codex 任务或其他外部系统。

v0.1 L4 采用 `selection-safe exact-three`：`max_evaluation_runs=3`，targeted、regression、held-out 各允许一个 controller-opened run，三个 `EvalRunOpenAnchor` 与晋升 JSON 的 run-id 集合必须精确相等且全部 sealed。任一已开启 run 失败、未封存或 terminal-invalid，当前候选即失败，必须创建 successor candidate；禁止同候选补跑、丢弃失败 run、增加第四次评价或挑选组合。晋升证据一旦明确报告 `FAIL / WORSE / hard regression / STALE_OUTPUT_CONTAMINATION / fresh-root failure`，控制器写不可覆盖的 candidate block-seal；同一评价文件之后改成 PASS 只构成哈希篡改，不能逆转终态。

`seal-eval-run` 生成 `EvalRunManifest` 和 `SealedEvalRun`，绑定 anchor、preflight、receipt、candidate bytes 与完整输出清单。seal 期间任何变化都写不可覆盖的 `TerminalEvalIncident`，`reason_code=EVAL_CHANGED_DURING_SEAL`、`state=TERMINAL_INVALID`；删除迟到文件也不能恢复。sealed 或 terminal-invalid 后，整个 eval output 对 Producer、Judge 和包括 `measure-artifact` 在内的控制器永久只读，控制器只能复核。`evaluations/`、`control/`、anchor、terminal marker 与 eval run 路径都拒绝 symlink，防止控制面或输出逃逸项目根目录。

已开启 eval 在 `seal-eval-run` 时精确零输出，或输出根不能形成合法普通文件清单，分别写永久 `EVAL_EMPTY_OUTPUT` / `EVAL_OUTPUT_INVALID`。两者都消耗该 phase 的唯一机会并要求 successor candidate；不得补写、清理后在同一候选重封。

每个新 eval run 必须从 controller-verified fresh empty root 生成本轮全部输出。历史配置和输入可按固定哈希引用，prior-run output 不得引用、复制或补位；发现任一旧输出即 `STALE_OUTPUT_CONTAMINATION`，整个评价 run 失效，并按 exact-three 规则建 successor candidate，不得保留本轮其他新输出继续晋升。PromotionRecord 保存 evaluation、evidence、receipt、open anchor 与三个 seal 的哈希，active release 持续复算。

## 4. JudgeSpec

每个 `creative-system/judges/<id>.json` 至少定义：

| 字段 | 约束 |
|---|---|
| `schema_version` | 与系统支持的 Judge 合同版本一致 |
| `kind` | 固定为 `JudgeSpec` |
| `id` | 全项目唯一 |
| `type` | `deterministic`、`model` 或 `human` |
| `mode` | `shadow`、`warn` 或 `block` |
| `agent` | Judge 角色 id；不得与其评价的 Producer 相同 |
| `rubric` | 可观察标准；不要用“好看”“高级”等循环定义 |
| `evidence_requirements` | 判断必须引用的产物或字段 |
| `calibration` | 人工标注校准集的相对路径或空值 |
| `promotion_requirements` | 从 shadow 到 warn/block 的证据门槛 |

硬合同 Judge 可以 `block`；软质量 Judge 默认从 `shadow` 开始，经人工校准后到 `warn`。只有存在“错误继续传播会污染系统”的真实证据时，软 Judge 才能获得有限 `block` 权限。

## 5. Finding

每个 finding 都要可追踪、可聚类、可分配：

```json
{
  "code": "PACE-MIDDLE-STALL",
  "category": "soft-quality",
  "severity": "medium",
  "confidence": 0.8,
  "evidence": [
    {"path": "creative-system/runs/run-003/attempts/002/output.md", "note": "中段连续三段没有新行动"}
  ],
  "owner": "story-producer",
  "suggested_action": "在中点加入改变角色选择的新事件"
}
```

约束：

- `category` 区分 `hard-contract`、`soft-quality`、`human-charter`、`runtime`。
- `severity` 不代替发布状态。
- `confidence` 表示判断把握，不伪装成客观质量分。
- `suggested_action` 是建议，不得自动改写受保护表面。

## 6. LearningProposal

L4 及以上候选必须包含：

| 字段 | 含义 |
|---|---|
| `id` | 候选稳定 id |
| `builder_receipt` | Builder role/context/task、外部 attester、安全 `input_boundary`、记录时间和“身份未由控制器认证”边界 |
| `producer_execution_boundary` | 来源 run、本地可冻结的 Producer context，以及只能外部作证的 Producer task 覆盖边界 |
| `finding_cluster` | 来自至少三次独立 run 的问题集合 |
| `root_cause_hypothesis` | 可证伪的根因假设 |
| `target_component` | Prompt、上下文、Loop 图、记忆或恢复策略；L5 才可指向元机制 |
| `candidate_change` | 候选改动及版本化文件 |
| `protected_constraints` | 明确不允许改变的合同 |
| `evaluation_matrix` | 目标、回归、held-out 和人工评价 |
| `budget` | 运行与尝试上限 |
| `rollback_plan` | 前一稳定版本和恢复动作 |
| `status` | `DRAFT/CANDIDATE/REJECTED/PROMOTED/ROLLED_BACK` |

候选只描述系统改动，不把生成的某一篇新稿当作系统候选。

## 7. 三条状态轴

不要把不同问题压成一个状态：

- `execution_status`: `NOT_STARTED / RUNNING / PASS / BLOCK`
- `quality_status`: `NOT_EVALUATED / PASS / WARN / NEEDS_TASTE`
- `release_status`: `NOT_READY / CANDIDATE / PASS / BLOCK`

示例：一次运行可以是 `execution=PASS`、`quality=WARN`、`release=NOT_READY`。这表示机器流程完成，但内容仍需修改，不能发布。

面对非技术用户只展示 `PASS / WARN / BLOCK / NEEDS_TASTE / CANDIDATE`，同时给出证据路径和最小下一步；完整三轴保留在机器记录中。

## 8. 全局不变量

`validate` 至少检查：

1. 所有相对引用存在且没有越出项目根目录；
2. Loop、Judge、产物 id 唯一；
3. 每个写入产物恰好有一个 owner；
4. Producer 与阻断 Judge 分离；
5. 循环依赖具有预算和停止条件；
6. retry budget 非负，L1 不超过 3；
7. 受保护表面完整且不与可修改表面重叠；
8. held-out 答案不进入 Producer、候选生成器或学习记忆；
9. L5 候选没有自动晋升路径；
10. `maturity.declared` 不高于已有合同能够支持的等级；
11. 机械硬合同读取 controller facts，不把 Producer 自报计数当 governing evidence。
12. `runtime_dispatch_budget` 与内容 `retry_budget` 独立，零文件记录不推进 content attempt、revision 或 no-improvement；
13. seal 状态单向为 `OPEN → BLOCK_SEALED`；`provisional-audit` 不是 seal，`block-candidate` 写入的最终封印使同一候选永久失去晋升资格，后写 `PASS` 不能解封；
14. 所有写命令与 CLI validate/audit 共用一个项目级 OS mutation lock；项目内 control、run、candidate、eval、release 和 transaction 路径逐组件拒绝 symlink；late-write terminal incident 与 `BUDGET_EXHAUSTED` 都是单调终态；
15. 每个新 eval run 都有独立 no-clobber `EvalRunOpenAnchor`，与 preflight、execution receipt、`candidate_change_hashes`、预算序号和 fresh empty root 一致；
16. v0.1 L4 满足 `selection-safe exact-three`：targeted、regression、held-out 各一次、三条全 sealed、ledger 与晋升 JSON 精确等集；任一失败都要求 successor candidate；
17. Builder receipt 的 `input_boundary` 恰好包含五类安全必需输入并拒绝 held-out、Producer reasoning 与 version identity；候选本地冻结 Producer context，Producer task 只使用 `external-attestation-required`；已知 Producer/Builder/evaluator/attester 身份冲突时拒绝；
18. seal 期间变化写 `EVAL_CHANGED_DURING_SEAL` 永久 `TerminalEvalIncident`；sealed eval output 对控制器也永久只读；
19. 出现 `STALE_OUTPUT_CONTAMINATION` 时整轮失效，不得挑选复用旧 run 输出，且当前候选必须改为 successor candidate；
20. active release 的 promotion、evaluation、引用证据、execution receipts、eval open anchors 和 seals 必须持续通过哈希复算；
21. registry 已提交而 system pointer 尚未提交的合法 partial promotion，必须先用完整 release bundle 做假设态验证，再幂等 roll-forward；普通 `validate` 仍报告 BLOCK；
22. 同一 governed source 的 Controller facts 构成不可变、单根、无分叉的 supersession chain；旧 facts 持续验哈、恰好一个链尾 active，送审对象冻结 active facts 的 path/sha256/bytes。
22. 用于成熟度的人类判断必须绑定 `HumanReviewSubject / HumanReviewOpenAnchor`，且满足冻结时间早于反馈、送审字节不变、机器方向未被事后对齐；
23. 全部 CharterConfirmation 都出现在哈希链 ledger 中；旧 receipt 或依据被改写时，即使不是 active confirmation 也必须 BLOCK；
24. rollback 先写 `ControllerTransactionIntent`，再按 after snapshot roll-forward；未出现 commit marker 时 `validate` 必须报告 `PENDING_CONTROLLER_TRANSACTION`，不得把 baseline pointer 当作一致状态。
