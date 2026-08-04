# 评价、候选、晋升与回滚

## 1. 固定拆分三层评价

### 硬合同

评价格式、事实、版权来源、品牌禁区、必要字段和明确禁用内容。使用确定性检查优先；发现违反时允许 `BLOCK`。

硬合同只能证明“没有违反这条合同”，不能证明作品有吸引力。

### 软质量

评价吸引力、情绪、原创性、人物可信度、节奏、语言质感等。把 rubric 写成可观察现象，优先做基线/候选盲比，默认输出 `WARN`。

不要把软质量分数伪装成客观真值。报告标准、证据、置信度和分歧。

### 人类立宪

判断作品是否值得保留、哪种风格更符合用户意图，以及冲突偏好如何取舍。机器没有足够证据时输出 `NEEDS_TASTE`，由用户补充选择并更新确认偏好。

当人工认可或方向用于 L1/L2 成熟度时，必须先用 `open-human-review` 冻结作品、机械证据和机器方向，形成 `HumanReviewSubject / HumanReviewOpenAnchor`；再发生真实反馈，并以 `HumanFeedbackReceipt` 绑定用户消息依据、时间、冻结 subject 和 attempt 内快照。裸布尔不算人工校准，反馈前也不得事后改机器方向来制造一致率；本地控制器只验证 receipt 哈希，不认证身份字符串。

## 2. 隔离 Producer 与 Judge

- 使用不同角色标识和不同上下文构造；
- Judge 读取候选、合同、rubric 和必要证据，不读取 Producer 的隐藏推理；
- Judge 不读取“这个候选改了什么、希望解决什么”，除非执行目标问题诊断；
- held-out 盲评时隐藏候选/基线身份和版本顺序；
- 修改 Judge 的候选必须由外部 Judge 或人工元评估，禁止自证。

分离角色不等于必须使用不同模型供应商。关键是信息和责任隔离。

不同 role id 也不等于已经完成隔离执行。能够启动 subagent 或独立任务时，必须实际使用新的执行上下文，并保存 evaluator task/thread id、输入边界、原始输出路径和时间。`create-candidate` 冻结 Builder receipt 与 finding 来源 run 中控制器已记录的 Producer dispatch context；`open-eval-run` 用独立 no-clobber anchor 冻结 evaluator receipt、preflight 和候选 change 哈希。Builder、evaluator 与 orchestrator attester 不得命中控制器已知的 Producer/Builder/evaluator identity。控制器没有 Producer task receipt 时，只能验证 role 与已记录 context；它不能认证 task 或任何 identity id 的真实性，必须回查 Codex 任务或其他外部执行系统。只由同一执行者在同一上下文中“切换身份”，只能算自评。

## 3. 晋升 Judge 权限

让新 Judge 按顺序升级：

```text
shadow → 与人工判断校准 → WARN → 有污染证据后才可 BLOCK
```

### shadow

保存判断但不改变运行或发布。收集 false positive、false negative 和分歧原因。

### 人工校准

使用覆盖边界情况的校准集，比较方向而非追求虚假精确分数。默认以 `PASS/BLOCK` 方向一致率不低于 80% 作为 L2 起点，同时单独检查硬合同不能假通过。

### WARN

允许 Judge 提醒、建议重写或请求人判断，但不得独立阻断发布。

### BLOCK

只有硬合同或有真实证据证明“错误继续传播会污染系统”的有限软质量项才可阻断。记录授权范围、校准版本和撤销条件。

## 4. 构建三类评价集

| 集合 | 用途 | 候选能否读取答案 |
|---|---|---|
| target | 验证候选是否解决目标 finding | 可以读取任务与标准，不直接读取理想答案 |
| regression | 防止破坏既有能力与硬合同 | 不读取人工结论 |
| held-out | 检验未知样本泛化 | 禁止读取任务答案、偏好标签和排序 |

评价集条目至少包含输入、适用合同、来源/授权说明、人工判断（若有）、Judge 版本和脱敏状态。开发集与 held-out 使用不同目录和权限边界。

## 5. 从 finding 到候选

只对至少三次独立真实 run 中重复出现的问题创建 L4 候选：

1. 用稳定 code、category 和责任面聚类 finding；
2. 排除同一输入反复重跑造成的伪重复；
3. 写一个可证伪的根因假设；
4. 选择最小目标组件；
5. 列出候选改动与不允许改变的约束；
6. 锁定 target、regression、held-out 和人工评价矩阵；
7. 锁定运行预算和回滚点；
8. 创建隔离 `CANDIDATE`，不改 active version。

优先修改最靠近根因的表面。若问题来自错误的上游事实，不要通过润色 Prompt 掩盖；若来自未决审美，不要自动改 Judge。

把候选实际文件放在 `creative-system/candidates/<candidate-id>/changes/`，并按项目相对路径镜像。例如，候选要修改 `skills/my-writer/references/production.md`，则保存为：

```text
creative-system/candidates/<candidate-id>/changes/skills/my-writer/references/production.md
```

实际文件必须在 proposal 的 `changed_paths` 中，且不得额外夹带未声明或受保护文件。一个只有提案文字、没有可复核 changes 文件的候选不得晋升。

## 6. 比较基线与候选

遵守固定顺序：

1. 先运行目标集，确认候选确实触达目标问题；
2. 再运行全量回归，检查硬合同和既有能力；
3. 最后做 held-out 盲评，隐藏版本身份和排列顺序；
4. 分开汇总硬合同、软质量与人工偏好；
5. 记录无结论和分歧，不用总分覆盖；
6. 检查预算、运行完整性和证据哈希。

若目标改善但 held-out 退化，保持候选状态；若硬合同退化，直接阻断晋升；若机器倾向候选但人无法决定，返回 `NEEDS_TASTE`。

### 6.1 先验收运行证据，再解释质量

- Producer 的输入和写入集合必须与锁定边界精确一致；额外读取或项目外写入会使该输出失格。
- 哈希、字节数、字数、allowed-writes 清单和预算计数使用控制器 facts；`producer_self_report_governing=false`，其自报机械字段只保留为 claim。
- 自报值与控制器值不一致时，保留原声明和差异记录。控制器值满足硬合同时，不因声明错误自动丢弃作品；控制器值不满足时才按硬合同处理。
- `ZERO_FILE_DISPATCH_STALL` 不进入盲比，也不算 content attempt、revision、no-improvement 或内容退化；按独立 `runtime_dispatch_budget` 恢复。
- v0.1 L4 使用 selection-safe exact-three：候选预算固定为 3，targeted、regression、held-out 各 `open` 一次，controller ledger 与晋升 JSON 的 run-id 集合必须精确相等，三条全部 sealed。失败、未封存或 terminal-invalid 后必须新建 successor candidate，不能在同一候选内补跑、丢弃失败 run 或挑选更好结果。
- 晋升证据若明确报告 `FAIL / WORSE / hard regression / STALE_OUTPUT_CONTAMINATION / fresh-root failure`，视为不可逆负面 attestation，立即写 candidate block-seal。后改同一 JSON 为 PASS 会破坏 block-seal evidence 哈希，不得恢复当前候选。
- 每次 `open-eval-run` 都冻结不同的外部 context/task、当前 candidate change 完整哈希、显式输入边界、预算序号和唯一 fresh empty root；open anchor 与 preflight 分开 no-clobber 保存。`seal-eval-run` 绑定两者和本轮原始输出。seal 期间变化写永久 terminal incident；sealed output 永久只读，包括 `measure-artifact` 在内的控制器命令也不能后写。发现 prior-run output 即 `STALE_OUTPUT_CONTAMINATION`，整轮失效。
- `evaluations/`、`control/`、anchor、terminal marker 与 eval run 路径拒绝 symlink；terminal-invalid output 和 sealed output 都对控制器永久只读。
- 已开启 eval 在 seal 时精确零输出或输出清单非法，写永久 `EVAL_EMPTY_OUTPUT / EVAL_OUTPUT_INVALID` 并要求 successor candidate；不得补文件后重封。

晋升证据的 `run_integrity` 至少包含 `fresh_output_roots_verified=true`、`all_evaluation_outputs_regenerated=true`、`prior_run_outputs_included=0`、`stale_output_contamination=false` 和独立证据路径。targeted、regression、held-out 各自提供不同且不重叠的 `run_id / output_root`；evidence 必须是对应 sealed output root 内的文件。控制器 open anchor 证明开跑 receipt、候选字节与预算位置，preflight 证明目录创建时为空，seal 证明最终文件集合与哈希；“文件没有从别处复制”仍由独立 evaluator 证明。

```bash
# 建候选时由 orchestrator 冻结实际 Builder 的外部执行回执
python3 <skill-dir>/scripts/loopctl.py create-candidate <project-dir> \
  --candidate-id <candidate> --finding-code <CODE> \
  --root-cause "<可证伪假设>" --target-component prompts \
  --change-summary "<候选变化>" --changed-path <project-relative-path> --budget 3 \
  --builder-role-id <candidate-builder> \
  --builder-context-id <external-context-id> \
  --builder-task-id <external-task-or-thread-id> \
  --builder-attested-by <orchestrator-id> \
  --builder-input-boundary finding-evidence \
  --builder-input-boundary creative-charter \
  --builder-input-boundary editable-surface \
  --builder-input-boundary system-contract \
  --builder-input-boundary evaluation-policy

python3 <skill-dir>/scripts/loopctl.py open-eval-run <project-dir> \
  --candidate-id <candidate> --eval-run-id <run> --phase targeted \
  --evaluator-role-id <external-reviewer> \
  --evaluator-context-id <external-context-id> \
  --evaluator-task-id <external-task-or-thread-id> \
  --attested-by <orchestrator-id> \
  --input-boundary creative-charter --input-boundary rubric \
  --input-boundary baseline-output --input-boundary candidate-output
# evaluator 只写返回的 output_root
python3 <skill-dir>/scripts/loopctl.py seal-eval-run <project-dir> \
  --candidate-id <candidate> --eval-run-id <run>
```

晋升记录会保存 evaluation、所有引用证据和三个 eval seal 的哈希；`validate` 与 `audit` 会持续复算。晋升后篡改任一项都会让 active L4 变为 `BLOCK`。

## 7. 晋升门

L4 候选只有同时满足以下条件才能晋升：

- finding 来自至少三次独立真实 run；
- target 评价显示目标问题改善；
- 硬合同没有退化或假通过；
- regression 没有阻断性退化；
- held-out 不劣于基线；
- Judge 版本和运行证据固定可追踪；
- 人工批准明确，包含 `approved_by / approved_at / scope` 和证据路径；
- 回滚版本存在且可恢复。

任何缺失都保持 `CANDIDATE`，列出最小缺口。不要把“所有命令成功退出”当作内容改进证据。

### 7.1 封印只有一种含义

过程检查使用 `preflight`、`provisional-audit` 或 `incident`，不得提前命名为 `block-seal`。seal 状态只允许 `OPEN → BLOCK_SEALED`：只有候选最终失格时才运行 `block-candidate`；它会写入不可覆盖的 `block-seal.json`，并让 `promote` 永久拒绝该候选。一旦写入，它的 `promotion_eligible=false` 和后继候选要求不可被后写说明、控制器裁决或同一候选的新证据解封。同一 `scope_type + scope_id` 禁止 last-write-wins；需要继续时使用新候选或新 run id，并保留原封印。

## 8. 晋升记录

晋升记录至少包含：

```json
{
  "candidate_id": "candidate-pace-v2",
  "from_version": "baseline-v1",
  "to_version": "baseline-v2",
  "target_result": "PASS",
  "regression_result": "PASS",
  "heldout_result": "NON_INFERIOR",
  "hard_contract_regressions": 0,
  "human_approval": {
    "approved": true,
    "scope": "仅晋升情节节奏提示与上下文装配"
  },
  "rollback_to": "baseline-v1"
}
```

把实际证据路径和哈希放入完整记录；示意字段不能替代运行证据。

`promote` 不覆盖基线文件，而是保存候选文件哈希、写入晋升记录并原子更新 active version 指针。领域 Skill 运行时应读取 active version：基线时使用基线文件；候选版本时只使用与 `COMMITTED` 晋升记录匹配的 `changes/` 文件。指针、晋升记录或候选哈希不一致时返回 `BLOCK`，不能静默回退或混用版本。

## 9. 回滚

触发以下任一情况时回滚：

- 晋升后发现新的硬合同退化；
- 发布结果与晋升证据不一致；
- 新版本依赖缺失或无法复现；
- 人工撤销批准范围；
- 评价集污染被确认。

回滚只更新 active version 指针和发布状态：

- 不删除候选；
- 不删除晋升记录；
- 不覆盖新版本 run；
- 记录触发原因和证据；
- 把相关评价集标记为需复核；
- 重新审计当前成熟度。

## 10. 各等级的最小评价门

| 等级 | 最小评价证据 |
|---|---|
| L0 | 用户确认创作宪法 |
| L1 | 3 条代表任务，至少 2 条获用户认可，失败能停止 |
| L2 | 5 个样本，硬合同无假通过，方向一致率默认 ≥80%，恢复演练 |
| L3 | 局部重跑不破坏上游，端到端不低于 L2，解决真实问题 |
| L4 | 3 次独立真实 run 的 finding；target、regression、held-out、人工批准、回滚 |
| L5 | 外部元评估；v0.1 仍不可自动晋升 |
