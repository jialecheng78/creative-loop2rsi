---
name: creative-loop2rsi
description: 引导 Codex 将创意写作及其他重主观创作流程，从创作立宪编译为可运行的单 Loop、有状态 Loop、嵌套多 Loop 与可验证自我改进系统，并生成领域 Skill、配置、评估集、候选和晋升证据。用于从零搭建写作工作流、把现有“生成—修改”流程系统化、增加恢复与评价、根据真实反馈迭代 Prompt、上下文或 Loop 图，或厘清重复运行、反馈 Loop 与 RSI 的边界。
---

# Creative Loop → RSI

## 坚守系统边界

- 把本 Skill 当作搭建器和教练，不把它当作某一种文体的写作模板。
- 把 Prompt 当作可修改部件之一，不把 Prompt 工程等同于整个 Loop 脚手架。
- 让领域 Skill 负责创作方法，让 `loopctl.py`、项目合同、状态和证据负责系统运行。
- 只把已实现且证据满足晋升门槛的能力称为当前成熟度；不要把重复运行、多个 Loop 或模型自评称为 RSI。
- 保留人的最终审美决定权。无法从材料推断核心偏好时，返回 `NEEDS_TASTE`，列出最小待选项，不替用户决定。
- 不要求 API key，不接入网络或模型服务，不自动发布，不训练或修改模型权重。
- 不覆盖非空目标目录，不改写用户原始素材，不删除历史 attempt、候选或晋升证据。
- 不允许候选修改创作宪法、原始素材、held-out 答案、许可证、晋升政策或人工审批边界。
- 把 L5 标为 `experimental / unvalidated`；始终保持 L5 产物为 `CANDIDATE`。

## 先确定当前任务

按以下顺序选择路径：

1. 用户尚无系统：从“收集五项输入”开始，只搭建 L0，再引导第一个 L1。
2. 用户已有草稿—修改流程：先把现状编译为合同，再用 `validate` 和 `audit` 判断实际成熟度。
3. 用户已有多个步骤：先梳理产物 owner、读写关系和失效传播，再决定是否达到 L3。
4. 用户想让系统自己变好：先确认已有至少三次独立真实 run 和结构化 finding；不足时停在 L2 或 L3 收集证据。
5. 用户要求系统改 Judge、学习策略或改进控制器：只建立 L5 实验候选，不晋升、不发布。

需要判断等级或解释术语时，先读 [concepts-and-maturity.md](references/concepts-and-maturity.md)。

## 收集五项自然语言输入

复用用户已经提供的信息，只追问无法可靠推断的部分。一次只呈现用户能回答的自然语言问题，不要求填写 Schema：

1. 想创作什么，给谁看？
2. 最小完整成品是什么？
3. 哪一条任务或素材最能代表日常创作？
4. 必须做到什么，绝对不能出现什么？
5. 喜欢与不喜欢哪些例子，原因是什么？

缺少示例时，允许先记录为“待补证据”，但不要凭空编造用户审美。若缺失会改变创作方向，返回：

```text
NEEDS_TASTE
需要你决定：<一个具体取舍>
请选择或补充：<不超过三个可比较选项>
决定后继续：<下一步>
```

## 完成 L0：创作立宪

把五项输入编译进 `creative-system/creative-charter.md`，至少写清：

- 创作目标与受众；
- 最小完整成品；
- 必须保留与禁止变化的内容；
- 可探索空间；
- 喜欢、不喜欢及其可观察原因；
- 硬合同与版权、事实、品牌等边界；
- 人的最终决定权；
- 当前未决的审美问题；
- 用户确认状态和日期。

先向用户展示立宪摘要和受保护项，再请求明确确认。确认前保持 L0 为 `NOT_READY`，不要替用户进入自动迭代。

创建新项目时，先确认目标路径不存在或为空，再运行：

```bash
python3 <skill-dir>/scripts/loopctl.py init <target-dir> \
  --project-name "<project-name>" \
  --creative-goal "<what-and-audience>" \
  --minimum-product "<minimum-complete-work>" \
  --representative-task "<representative-task>" \
  --constraints "<must-and-must-not>" \
  --taste "<likes-dislikes-and-reasons>" \
  --domain-skill "<domain-skill-slug>"
```

只有用户已明确确认立宪时才追加 `--charter-confirmed`。若命令接口与本地脚本不同，以 `python3 <skill-dir>/scripts/loopctl.py --help` 为准；不要自行重写运行器。初始化后，把确认过的立宪写入生成项目，不把用户素材塞进 Skill 本体。

## 完成 L1：跑通一个创作 Loop

只选一个最短且能交付完整成品的 Loop。定义：

```text
produce → evaluate → decide → revise / commit
```

为该 Loop 明确 goal、reads、writes、owner、producer、judges、decision policy、retry budget、stop conditions 和 human gate。把重试预算限制在 3 次以内，并规定连续两次没有可观察改善时停止。

至少准备三条代表任务。每次运行都保留输入、产物、评价、决定和用户反馈；不要只记录最终稿。至少两条得到用户认可、失败能定位且能停止后，再建议晋升 L2。

要查看完整字段和状态轴，读 [system-contract.md](references/system-contract.md)。

## 升级 L2：建立可靠的有状态 Loop

在 L1 真实问题的基础上增加以下能力，不因“看起来更完整”提前添加：

- 分离 Producer 与 Judge；不要让 Judge 读取 Producer 的推理或候选修改意图。
- 把每次 attempt 封存为不可变证据，给 manifest 和内容哈希。
- 把问题写成结构化 finding，明确证据、责任 owner 和最小建议动作。
- 把可复用事实、已确认偏好和失败教训写入不同记忆区，不把一次主观评分当永久真理。
- 只自动恢复传输或解析失败、确定性无语义修复，以及能定位到责任 Loop 的局部重生成。
- 增加发布门；结构通过不等于创作质量通过。

至少用五个样本校准。确保硬合同无假通过、人机 `PASS/BLOCK` 方向一致率默认不低于 80%，并成功演练一次局部恢复。

需要设计恢复、记忆或 attempt 时，读 [nested-loops-and-recovery.md](references/nested-loops-and-recovery.md)。

## 升级 L3：嵌套多个 Loop

只从真实观察到的瓶颈拆分 Loop。为每个产物指定唯一 owner，让多个 Loop 通过声明式 reads/writes 和证据共享状态，不通过隐含文件约定耦合。

在执行前检查：

- 依赖图是否有环；若有受控循环，是否存在预算和停止条件；
- 一个产物是否恰好有一个写入 owner；
- 上游变化会使哪些下游产物失效；
- 局部重跑是否保留已确认且仍有效的上游结果；
- 端到端发布判断是否同时读取执行、质量和发布三条状态轴。

至少解决一个真实观察到的问题，并证明单个 Loop 可重跑且不破坏已确认上游、端到端质量不低于 L2 基线后，再建议晋升 L4。

## 升级 L4：做可验证自我改进

只从至少三次独立真实 run 中重复出现的 finding 创建学习提案。按固定顺序执行：

```text
真实反馈 → 结构化 finding → 重复问题聚类 → 根因与责任面
→ 隔离候选 → 目标 eval → 全量回归 → held-out 盲评
→ 人工晋升 → 保留回滚点
```

允许候选修改 Prompt、上下文装配、Loop 图、记忆策略或恢复策略。为每个候选写明根因假设、目标组件、改动、受保护约束、评估矩阵、预算和回滚方案。不要让候选读取 held-out 答案，也不要让被修改的 Judge 单独证明自身改进。

只有目标问题改善、硬合同无退化、回归集无阻断性退化、held-out 不劣于基线且人工批准齐全时，才运行 `promote`。晋升后保留前一稳定版本；失败则维持基线并记录可解释原因。

需要设计 Judge、评价集、候选或晋升门时，读 [evaluation-and-promotion.md](references/evaluation-and-promotion.md)。

## 处理 L5：建立 RSI 实验室而非宣称完成 RSI

允许提出修改 Judge、学习策略或改进控制器本身的隔离候选，但始终：

- 把候选保存在独立分支档案中；
- 让外部、未参与候选生成的评价者做元评估；
- 保护创作立宪、held-out、晋升政策和人工边界；
- 禁止自动晋升与自动发布；
- 把结果标为 `experimental / unvalidated / CANDIDATE`。

需要进入系统级实验时，完整读取 [rsi-lab.md](references/rsi-lab.md)。若用户要求取消边界或直接发布，拒绝该部分请求，并给出可逆的候选实验方案。

## 处理“从零做到 L4，再迭代 N 轮”的长程请求

当用户明确要求端到端搭建、达到可验证自我改进并在此后运行若干轮时，完整读取 [end-to-end-pilot.md](references/end-to-end-pilot.md)，先给出分阶段路线，再开始生产。

- 把 L0–L3 所需 run 标为 bootstrap / calibration，不计入用户要求的“L4 之后 N 轮”。
- 在最早可评价的三个代表结果后批量请求人工认可，不要先耗尽全部创作或迭代预算再发现 `human_accepted=0`。
- Producer/Judge 分离必须落实为真实独立执行上下文；只有不同 role id、不算独立评价。
- 先由 `audit` 证明 L4 且 active version 已通过晋升，再把后续 run 计为 `post-l4`。
- 每个 `post-l4` run 仍可 `commit / reject / rollback / stop`；不要求为凑数量强行改坏作品。
- 人工门可以合并成小批量选择，但不得代签。遇到 `NEEDS_TASTE` 时暂停该分支，不要用后续自动轮次掩盖。

## 分开评价三层结果

始终分别报告：

1. **硬合同**：格式、事实、来源、版权、品牌禁区等；可机械 `BLOCK`。
2. **软质量**：吸引力、情绪、原创性、可信度、节奏等；默认 `WARN` 或做基线/候选盲比。
3. **人类立宪**：什么值得保留；无法可靠判断时返回 `NEEDS_TASTE`。

不要用一个总分掩盖三层差异。让新 Judge 依次经历 `shadow → 人工校准 → WARN → 有污染证据后才可 BLOCK`。

## 使用运行工具

先用 `--help` 核对本地接口，再按需调用：

- `init`：生成项目骨架和领域 Skill；非空目录必须拒绝覆盖。
- `validate`：检查合同、引用、owner、依赖、预算、停止条件和受保护面。
- `audit`：报告当前可证明成熟度和下一级缺口。
- `begin-run`：建立 run 和首个 attempt 的证据位置。
- `seal-attempt`：封存 attempt、manifest 和哈希；封存后不得覆盖。
- `create-candidate`：从重复 finding 建立隔离候选及评估计划。
- `promote`：只在四类证据和人工批准齐全时更新 active version。
- `rollback`：切回上一稳定版本，不删除任何历史证据。

每次修改系统配置后运行：

```bash
python3 <skill-dir>/scripts/loopctl.py validate <project-dir>
python3 <skill-dir>/scripts/loopctl.py audit <project-dir>
```

把验证失败解释成用户能行动的下一步，不用 Schema 术语淹没用户。

## 只推进下一个成熟度

向用户展示以下最小回执：

```text
当前状态：PASS / WARN / BLOCK / NEEDS_TASTE / CANDIDATE
可证明成熟度：L<n>
本轮解决：<创作质量或流程问题>
证据：<项目内相对路径>
为何停在这里：<未满足的晋升条件>
最小下一步：<一项可执行动作>
```

不要一次铺开 L0–L5 的所有配置。先完成用户当前目标，再展示下一级的价值和缺口。

## 按需读取材料

- 判断 Loop、反馈、自改进与 RSI 的概念边界：读 [concepts-and-maturity.md](references/concepts-and-maturity.md)。
- 编写或审查 JSON 合同、状态与 finding：读 [system-contract.md](references/system-contract.md)。
- 设计多 Loop、attempt、记忆、失效传播与恢复：读 [nested-loops-and-recovery.md](references/nested-loops-and-recovery.md)。
- 设计三层评价、Judge 校准、候选比较、晋升与回滚：读 [evaluation-and-promotion.md](references/evaluation-and-promotion.md)。
- 执行从 L0 到 L4、并在晋升后继续指定轮数的完整试点：读 [end-to-end-pilot.md](references/end-to-end-pilot.md)。
- 讨论修改评价或改进机制本身：读 [rsi-lab.md](references/rsi-lab.md)。

需要示范时，只读取最接近用户方向的一个虚构案例：

- L1 短故事：`assets/examples/short-story/`
- L2 品牌文案：`assets/examples/brand-copy/`
- L3 游戏任务：`assets/examples/game-quest/`

借用案例的机制，不复制案例的审美结论；始终以用户确认的创作立宪为准。
