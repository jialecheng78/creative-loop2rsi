# 系统公共合同

## 1. 设计原则

- 用 JSON 保存机器合同，用 Markdown 保存人的立宪与解释。
- 把用户作品和运行证据留在用户项目，不写入 Builder Skill。
- 所有标识符使用稳定的 `lower-kebab-case`，不要把时间戳当业务身份。
- 所有项目内引用使用相对路径；禁止依赖本机绝对路径。
- 每个产物恰好有一个写入 owner；可以有多个读取者。
- 把事实证据与解释分开。Finding 的 `evidence` 指向可检查产物，不把 Judge 结论本身当原始证据。
- 把成熟度视为审计结果，不允许用户配置直接宣告更高等级。

## 2. CreativeSystem

`creative-system/system.json` 作为系统入口，至少表达：

| 字段 | 含义 |
|---|---|
| `schema_version` | 合同版本，v0.1 使用固定公开版本 |
| `project` | 项目 id、名称、领域 Skill 和 active version |
| `kind` | 固定为 `CreativeSystem` |
| `charter` | 立宪路径、确认状态与确认日期 |
| `maturity` | 维护者当前声明和证据引用，不能代替 `audit` 结果 |
| `loops` | LoopSpec 文件引用列表 |
| `artifacts` | 产物 id、路径、owner 与保护属性 |
| `judges` | JudgeSpec 文件引用列表 |
| `memory` | 记忆分区、写入者和保留策略 |
| `recovery_policy` | 可自动恢复范围、预算和升级到人的条件 |
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
    "confirmed_at": "2026-01-01"
  },
  "maturity": {"declared": "L1"},
  "loops": ["creative-system/loops/draft-story.json"],
  "artifacts": [
    {"id": "story-draft", "path": "outputs/story-draft.md", "owner": "story-producer", "kind": "output", "protected": false}
  ],
  "judges": ["creative-system/judges/story-review.json"],
  "memory": {"partitions": []},
  "recovery_policy": {"max_attempts": 3},
  "learning_policy": {"minimum_independent_runs": 3},
  "promotion_policy": {"human_approval_required": true, "l5_auto_promotion": false},
  "protected_surfaces": [
    "creative-system/creative-charter.md",
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
| `retry_budget` | 包含 `max_attempts`、`max_no_improvement` 和预算耗尽动作 |
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
10. `maturity.declared` 不高于已有合同能够支持的等级。
