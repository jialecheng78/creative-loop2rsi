# creative-loop2rsi

`creative-loop2rsi` 是一个面向 Codex 的开源 Builder Skill。它不替你规定“什么才是好作品”，而是帮助你把自己的创作标准逐步变成一套可运行、可恢复、可审计、可验证改进的系统。

```text
创作立宪
  -> 单 Loop
  -> 有状态可恢复 Loop
  -> 嵌套多 Loop
  -> 可验证自我改进
  -> RSI 实验室（仅实验，不自动晋升）
```

当前目标版本为 `v0.1.0`，中文优先、仅面向 Codex。L0–L4 是本版本的正式实现范围；L5 始终标记为 `experimental / unvalidated`。本仓库不会训练或修改模型权重，也不会自动公开作品、修改创作宪法或替人决定核心审美。

## 它解决什么问题

创意写作中的难点通常不是“再写一条更长的 Prompt”，而是：

- 哪些标准必须由人定义，哪些约束可以机械检查；
- 一次失败后应该改作品、改评价器，还是改工作流程；
- 多个创作步骤怎样共享状态，又不因局部重做破坏已确认内容；
- 怎样证明一次“系统改进”解决了旧问题，而没有让其他能力退化。

这个 Skill 把答案落实为三个相互分工的部分：

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| Builder Skill | 用自然语言引导立宪、选择下一成熟度、解释阻塞原因 | 不保存运行事实，不代替控制器 |
| 领域 Skill | 承载使用者自己的创作方法、语境和交互方式 | 不自行改变受保护规则 |
| `loopctl.py` 与运行项目 | 保存合同、状态、证据、候选、晋升与回滚记录 | 不调用模型，不判断作品是否“有灵魂” |

因此，能跑通 Loop 的脚手架不是单靠 Prompt 工程。Prompt 会影响 Producer 和 Judge 的具体表现；Skill 负责把复杂流程变成可理解的交互；真正让 Loop 可恢复、可审计并能安全迭代的，是显式合同、持久状态、不可变证据和晋升门。三者缺一不可。

## 能力状态

以下标签有严格含义：

- `IMPLEMENTED`：仓库中已有实现和自动检查；不等于真实创作质量已得到证明。
- `FORWARD-TESTED`：由没有历史上下文的独立执行者按真实任务验证过，并保留结果。
- `PROPOSED`：只有可解释方案，尚不是可依赖能力。
- `UNVALIDATED`：明确未验证，不能据此作自动决策。

| 能力 | 当前状态 | 边界 |
|---|---|---|
| L0–L4 项目脚手架、合同和本地控制命令 | `IMPLEMENTED` | 自动测试只验证结构、状态和安全门，不证明内容质量 |
| 短故事、品牌文案、游戏任务三个虚构示例 | `IMPLEMENTED` | 示例是教学材料，不是外部基准 |
| 四类场景、每类两次的无历史上下文前向测试 | `FORWARD-TESTED` | 8/8 通过成熟度诚实性与保护边界；有一项非阻断交互方差，见 [FORWARD_TESTS.md](FORWARD_TESTS.md) |
| 三名非程序员在 20 分钟内完成 L0 与首个 L1 | `UNVALIDATED` | 尚未用真人测试，自动 Agent 测试不能替代 |
| L5 修改 Judge、学习策略或改进控制器 | `UNVALIDATED` | 只生成 `CANDIDATE`；禁止自动晋升 |
| 从 L0 到 L4、再证明晋升后运行 N 轮 | `IMPLEMENTED` | 分开 bootstrap 与 post-L4 计数；仍需真实人工门和独立评价者 |
| 模型供应商适配器、遥测、云服务和自动训练 | `PROPOSED` / 非 v0.1 范围 | 本版本不实现，也不要求 API key |

## 安装

下载或克隆仓库后，把 `skills/creative-loop2rsi/` 整个目录复制到 Codex 的个人 Skills 目录；也可以直接在本仓库中让 Codex 读取这个 Skill。

控制器要求 Python 3.9 或更高版本。安装前可运行官方校验器：

```bash
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/creative-loop2rsi
```

预期输出为 `Skill is valid!`。本项目没有第三方 Python 依赖，不需要填写 API key。

## 快速开始

### 对话式方式（推荐）

在 Codex 中输入：

```text
使用 $creative-loop2rsi，帮我搭建一个面向 8—10 岁读者的短故事创作 Loop。
```

首次只需要用自然语言回答五件事：

1. 想创作什么、给谁看；
2. 最小完整成品是什么；
3. 一条代表性任务或素材；
4. 必须做到什么、绝对不能出现什么；
5. 喜欢和不喜欢的例子，以及原因。

Skill 会先生成 `creative-charter.md` 供你确认。无法从证据推断的审美问题会返回 `NEEDS_TASTE`，不会替你选择。

### 本地控制器方式

`loopctl.py` 只管理文件、合同和证据，不访问网络：

```bash
python3 skills/creative-loop2rsi/scripts/loopctl.py init ./my-creative-project \
  --project-name "我的短故事系统" \
  --creative-goal "为 8—10 岁读者创作温暖但不说教的短故事" \
  --minimum-product "一篇有开端、转折和结尾的 1200 字短故事" \
  --representative-task "写一个孩子第一次独自照顾受伤小鸟的故事" \
  --constraints "不能美化危险行为；不能用梦醒来解决冲突" \
  --taste "喜欢克制的幽默和动作细节；不喜欢直接讲大道理" \
  --domain-skill short-story-loop

# 用户明确确认后，先把其原始回复保存到以下 evidence 目录，再执行：
python3 skills/creative-loop2rsi/scripts/loopctl.py confirm-charter ./my-creative-project \
  --confirmed-by "project-owner" \
  --evidence creative-system/approvals/charter-confirmations/evidence/initial-confirmation.md

python3 skills/creative-loop2rsi/scripts/loopctl.py validate ./my-creative-project
python3 skills/creative-loop2rsi/scripts/loopctl.py audit ./my-creative-project
```

`init` 遇到非空目标目录会拒绝覆盖。生成后的领域 Skill 也应使用官方 `quick_validate.py` 校验。完整命令和参数可运行：

```bash
python3 skills/creative-loop2rsi/scripts/loopctl.py --help
```

其余命令围绕证据流转，而不是替你写作：

| 命令 | 作用 |
|---|---|
| `confirm-charter` | 绑定宪法、外部人工确认依据、确认人和时间，生成内容寻址且不可覆盖的立宪 receipt |
| `measure-artifact` | 由控制器生成文本哈希、字节数和字数等 governing facts；改稿后写到新的 output 时自动串联旧 facts，并推导唯一 active facts |
| `begin-run` | 为指定 Loop 和任务创建一次可追踪 run |
| `open-dispatch` | 为一次 Producer 执行分配唯一 allowed-writes root，隔离迟到写入 |
| `record-dispatch-stall` | 记录精确零文件 stall；只消耗 runtime budget，不算内容 attempt |
| `open-human-review` | 在人工反馈前冻结成品清单、active facts 的路径/哈希/字节数及机器方向，生成 `HumanReviewSubject` 和独立 open anchor |
| `seal-attempt` | 封存状态、finding 和人工反馈 receipt；人工声明必须引用先于反馈冻结的送审版本，封存后不可覆盖 |
| `create-candidate` | 从多个独立 run 的重复 finding 建立隔离候选，冻结 Builder receipt、安全 input boundary、本地可证的 Producer context 和只能外部作证的 Producer task |
| `open-eval-run` / `seal-eval-run` | 写独立 no-clobber `EvalRunOpenAnchor`，绑定 preflight、evaluator receipt、`candidate_change_hashes`、预算序号、空输出根与封存哈希 |
| `block-candidate` | 为最终失格候选写不可覆盖的 block-seal；后续只能新建候选 |
| `promote` | 检查目标、回归、held-out 和人工批准证据后晋升 L4 候选 |
| `rollback` | 恢复上一稳定版本，但保留所有历史证据 |

人工认可的固定顺序是 `produce / evaluate / measure → open-human-review → 用户反馈 → seal-attempt`。机械计量发现问题时，先改稿，再把同一 source 测到新的 facts output；控制器会保留旧 facts、验哈并自动选择唯一 active facts，不要删除历史。先写“用户认可”、后补作品会被拒绝；送审后作品、active facts 或机器方向发生变化时，旧反馈也不能用于新版本。

`role/context/task` 的真实性来自 Codex 任务记录或其他外部执行系统。本地控制器可从 dispatch 证据冻结 finding 来源 Producer context，但 Producer task 只能标为 `external-attestation-required`。控制器只冻结 attestation、检查所有已知 Producer/Builder/evaluator/attester 身份冲突并持续验哈，不能认证字符串背后是否真是独立的人或 Agent。没有外部任务回执时，L4 独立评价条件不成立。

Builder receipt 必须显式声明 `finding-evidence / creative-charter / editable-surface / system-contract / evaluation-policy` 五类安全输入，且拒绝 `heldout-input / heldout-answer / mapping-table / producer-reasoning / version-identity`：

```bash
python3 skills/creative-loop2rsi/scripts/loopctl.py create-candidate ./my-creative-project \
  --candidate-id pace-fix-v2 \
  --finding-code PACE-MIDDLE-STALL \
  --root-cause "中段提示缺少可观察的行动升级" \
  --target-component prompts \
  --change-summary "只改中段行动升级提示" \
  --changed-path skills/short-story-loop/references/production.md \
  --budget 3 \
  --builder-role-id candidate-builder \
  --builder-context-id <external-context-id> \
  --builder-task-id <external-task-id> \
  --builder-attested-by <orchestrator-id> \
  --builder-input-boundary finding-evidence \
  --builder-input-boundary creative-charter \
  --builder-input-boundary editable-surface \
  --builder-input-boundary system-contract \
  --builder-input-boundary evaluation-policy
```

v0.1 的 L4 采用 `selection-safe exact-three`：每个候选只允许 targeted、regression、held-out 各写一个 `EvalRunOpenAnchor`，三条全部封存且与晋升 JSON 精确对应。任一已开启 run 失败后必须建 successor candidate，不能在同一候选内补跑或挑最好结果。

晋升证据一旦明确报告 `FAIL / WORSE / hard regression / STALE_OUTPUT_CONTAMINATION / fresh-root failure`，控制器立即写不可覆盖的 candidate block-seal。之后把同一评价 JSON 改成 PASS 只会触发证据篡改，不能洗白当前候选。

seal 期间输出、preflight、receipt、anchor 或候选字节发生变化时，控制器写入 `EVAL_CHANGED_DURING_SEAL` 永久 `TerminalEvalIncident`；清理迟到文件也不能恢复。sealed eval output 对包括 `measure-artifact` 在内的控制器也永久只读。新 eval run 发现 prior-run output 时写 `STALE_OUTPUT_CONTAMINATION`，整轮失效并建 successor candidate，禁止保留其他新输出继续晋升。

`evaluations/`、`control/`、anchor、terminal marker 与 eval run 路径都拒绝 symlink；terminal-invalid output 与 sealed output 同样进入控制器只读状态，不能再写 facts 掩盖现场。

对已开启 run 调用 `seal-eval-run` 时若输出精确为空，会写永久 `EVAL_EMPTY_OUTPUT`；之后补写文件也不能在同一候选重试。

当用户要求“先做到 L4，再自动迭代 N 轮”时，前置校准 run 不计入 N。`begin-run` 会把 run 开始时的 active version、可证明成熟度和 `bootstrap / post-l4` 阶段写入封存证据；只有 `audit` 已证明 L4 后开始的 `post-l4` run 才能计数。完整路线见 Skill 的 `references/end-to-end-pilot.md`。

默认使用 `init → 用户看立宪 → confirm-charter` 两步流程。裸 `--charter-confirmed` 会 fail closed；只有已经存在外部人工确认依据，并同时提供 `--charter-confirmed-by / --charter-confirmation-evidence` 时才可一步初始化。不要为了跳过 L0 伪造依据或代签。

所有写命令共用一个项目级 mutation lock；`creative-system/control`、run、candidate、eval、release 与 transaction 路径都拒绝项目内 symlink。`promote` 与 `rollback` 都先冻结可恢复事务 intent，再写正式 release/receipt，并按 before/after 哈希 roll-forward candidate、registry 与 system，最后写 commit marker。中途崩溃时 `validate` 返回 `PENDING_CONTROLLER_TRANSACTION`；只有与原 candidate、目标版本、批准人和评价哈希一致的 promote 重试，或 reason/evidence 一致的 rollback 重试才能恢复。任一目标出现第三哈希时返回 `TRANSACTION_DIVERGED`，不会覆盖外部改动。

## 生成的项目

```text
my-creative-project/
├── README.md
├── AGENTS.md
├── .gitignore
├── creative-system/
│   ├── creative-charter.md
│   ├── system.json
│   ├── approvals/             # raw 人工消息默认本地忽略；receipt/ledger 可追踪
│   ├── control/               # 项目级 mutation lock 与可恢复事务
│   ├── loops/
│   ├── judges/
│   ├── evals/development/
│   ├── evals/heldout/
│   ├── memory/
│   ├── runs/
│   ├── candidates/
│   └── releases/
└── skills/<domain-skill>/
    ├── SKILL.md
    ├── agents/openai.yaml
    └── references/
```

用户输入、输出、运行轨迹和人工确认原文默认加入生成项目的 `.gitignore`，空目录用 `.gitkeep` 保证 clone 后仍可验证。内容寻址 receipt 与 ledger 会进入 Git；clone 缺少本地原文时 `validate` 返回 `PASS` 和 `LOCAL_CONFIRMATION_EVIDENCE_UNAVAILABLE`，恢复相同原文会清除 warning，出现同路径改写、目录或符号链接仍会 `BLOCK`。不要把未发表作品放进本仓库的 issue、测试或示例。

## 从 Loop 到 RSI 的成熟度

| 等级 | 公开名称 | 系统新增能力 | 晋升时最关键的证据 |
|---|---|---|---|
| L0 | 创作立宪 | 明确受众、最小成品、保留项、禁区、偏好和人的最终决定权 | 内容寻址的 `CharterConfirmation` 与外部用户确认依据 |
| L1 | 单创作 Loop | `produce -> evaluate -> decide -> revise/commit` | 代表任务可停止、失败可定位，至少 3 次试跑中 2 次具有人工反馈 receipt 的认可 |
| L2 | 可靠有状态 Loop | Producer/Judge 分离、不可变 attempt、finding、记忆、局部恢复和发布门 | 至少 5 个样本；硬合同无假通过；人机方向一致率默认不低于 80% |
| L3 | 嵌套多 Loop 系统 | 多 Loop 共享状态和证据，产物有唯一 owner，支持局部失效 | 局部重跑不破坏已确认上游，端到端不低于 L2 基线 |
| L4 | 可验证自我改进系统 | 从重复 finding 形成隔离候选，执行目标集、回归集和 held-out 比较 | 至少 3 次真实 run；无硬退化；held-out 不劣于基线；人工批准 |
| L5 | 系统级 RSI 实验室 | 候选可以触及 Judge、学习策略或改进控制器本身 | `experimental / unvalidated`；外部元评估和人工决定，永不自动晋升 |

“运行很多遍”不是 RSI，“拥有很多 Loop”也不是 RSI。只有系统开始基于真实证据修改并检验自己的改进机制，才进入 L5 的实验范围。

## 评价与安全门

创作评价固定拆成三层，避免把机器可检查的 `PASS` 误写成“作品已经优秀”：

1. **硬合同**：格式、事实、版权来源、品牌禁区等，可以机械 `BLOCK`；
2. **软质量**：吸引力、情绪、原创性、人物可信度和节奏，默认 `WARN` 或做基线/候选盲比；
3. **人类立宪**：什么值得保留、什么符合个人审美，分歧时返回 `NEEDS_TASTE`。

L4 的固定路径是：

```text
真实反馈 -> 结构化 finding -> 重复问题聚类 -> 根因与责任面
-> 隔离候选 -> 目标 eval -> 全量回归 -> held-out 盲评
-> 人工晋升 -> 保留回滚点
```

候选不能修改创作宪法、原始素材、held-out 答案、许可证、晋升政策或人工审批边界。`rollback` 恢复上一稳定版本，但不会删除历史证据。

候选实际文件保存在 `creative-system/candidates/<candidate-id>/changes/`，按项目相对路径镜像。晋升不会覆盖基线文件，只会在证据齐全时写入 `COMMITTED` 记录并切换 active version；领域 Skill 依据该指针选择版本，因此仍可完整回滚。

## 隐私与威胁边界

- `loopctl.py` 使用 Python 标准库并且不访问网络；CI 也不需要模型密钥。
- 生成项目中的 `inputs/`、`outputs/`、`creative-system/runs/` 和未发表素材默认不入库。
- 哈希用于发现 attempt 被改写，不是加密、访问控制或恶意攻击防护。
- `confirmed_by / feedback_by / approved_by` 只记录谁被外部声明为确认者，不验证现实身份。控制器会绑定证据、时间、对象和哈希，并固定写出 `external-attestation-not-controller-verified`；高风险使用应接入仓库外的审批与权限系统，再把只读回执作为证据。
- Skill 和控制器不是操作系统沙箱。运行前仍应核对目标目录，不要把敏感素材复制进公开仓库。
- 候选不会自动发布，也不能绕过人工晋升。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发与发布检查

```bash
python3 -B -m unittest discover -s tests -v
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/creative-loop2rsi
python3 tools/audit_public_tree.py . --mode full
python3 tools/audit_public_tree.py . --mode tracked
python3 tools/check_dco.py . --range HEAD
python3 tools/audit_release_archive.py . --treeish HEAD
```

`--mode full` 适合提交前查看整个工作目录；`--mode tracked` 以 Git index 取得版本化路径，但读取当前工作树字节，因此只用于本地预检。真正的发布门使用 `audit_release_archive.py`：它从指定 commit 生成 `git archive`，比较 Git tree 与压缩包清单，审计压缩包内的实际字节，并绑定 commit、tree、逐文件哈希和 archive SHA256。可通过 `--denylist /private/path/denylist.txt` 加载不入库的私有敏感词表。

CI 提供五类 required-check 候选：9 格 Python 测试矩阵、`DCO`、`policy`、`gitleaks-history` 和 `archive-audit`。Gitleaks 固定版本、官方规则集和下载 SHA256，不接受仓库内 `.gitleaks.toml`、`.gitleaksignore` 或 `gitleaks:allow` 弱化门禁；它会先用合成泄漏验证扫描器确实失败，再扫描完整 Git 历史。`policy` 使用固定 OpenAI Codex commit 和文件哈希下载官方 `quick_validate.py`，同时校验 Builder Skill 与一次现场生成的领域 Skill。所有 GitHub Action 都固定到完整 commit SHA；工作流只使用 `contents: read`，不使用 `pull_request_target`、仓库密钥或持久化 checkout 凭据。

这些文件只定义门禁。正式发布前仍须在 GitHub private staging 实际跑绿所有 hosted-runner jobs，在仓库 ruleset 中把它们设为 required，并启用 `web_commit_signoff_required`，防止 GitHub 合并时生成未签署的新 commit；本地 PASS 不能替代 GitHub 状态检查。

贡献方式、DCO 和洁净室边界见 [CONTRIBUTING.md](CONTRIBUTING.md)。本项目采用 [Apache License 2.0](LICENSE)。

## 研究来源与术语边界

这些公开资料影响了本项目对“反馈 Loop”“经验记忆”和“系统自改进”的区分；链接只用于说明设计依据，运行时不会访问它们：

- [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651)：展示反馈与迭代改写的价值，但这本身不等于 RSI。
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)：展示把反馈沉淀为语言记忆的路径。
- [Building self-improving agents with Codex](https://openai.com/index/building-self-improving-tax-agents-with-codex/)：把生产纠正转成 eval，再交给 Agent 处理有明确成功条件的改进任务。
- [Anthropic: Recursive self-improvement](https://www.anthropic.com/institute/recursive-self-improvement)：用于约束“RSI”这一术语，不把普通迭代包装为完整自主 RSI。
- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)：启发候选档案、经验评估和分支探索；本项目额外保留受保护表面与人工晋升。

这些引用是设计参照，不构成本仓库已复现论文结果的声明。
