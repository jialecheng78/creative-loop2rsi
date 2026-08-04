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
| 四类场景、每类两次的无历史上下文盲测 | 尚未声明 `FORWARD-TESTED` | 只有结果被记录并复核后才能更新此项 |
| 三名非程序员在 20 分钟内完成 L0 与首个 L1 | `UNVALIDATED` | 尚未用真人测试，自动 Agent 测试不能替代 |
| L5 修改 Judge、学习策略或改进控制器 | `UNVALIDATED` | 只生成 `CANDIDATE`；禁止自动晋升 |
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
| `begin-run` | 为指定 Loop 和任务创建一次可追踪 run |
| `seal-attempt` | 封存状态、finding 和人工接受结果；封存后不可覆盖 |
| `create-candidate` | 从多个独立 run 的重复 finding 建立隔离候选 |
| `promote` | 检查目标、回归、held-out 和人工批准证据后晋升 L4 候选 |
| `rollback` | 恢复上一稳定版本，但保留所有历史证据 |

`--charter-confirmed` 只应在使用者已经看过并明确确认创作宪法时传入。不要为了跳过 L0 而默认添加它。

## 生成的项目

```text
my-creative-project/
├── README.md
├── AGENTS.md
├── .gitignore
├── creative-system/
│   ├── creative-charter.md
│   ├── system.json
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

用户输入、输出和运行轨迹默认加入生成项目的 `.gitignore`。候选定义、晋升记录和经过脱敏的评估证据可以按需版本化。不要把未发表作品放进本仓库的 issue、测试或示例。

## 从 Loop 到 RSI 的成熟度

| 等级 | 公开名称 | 系统新增能力 | 晋升时最关键的证据 |
|---|---|---|---|
| L0 | 创作立宪 | 明确受众、最小成品、保留项、禁区、偏好和人的最终决定权 | 用户确认创作宪法 |
| L1 | 单创作 Loop | `produce -> evaluate -> decide -> revise/commit` | 代表任务可停止、失败可定位，至少 3 次试跑中 2 次获用户认可 |
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

## 隐私与威胁边界

- `loopctl.py` 使用 Python 标准库并且不访问网络；CI 也不需要模型密钥。
- 生成项目中的 `inputs/`、`outputs/`、`creative-system/runs/` 和未发表素材默认不入库。
- 哈希用于发现 attempt 被改写，不是加密、访问控制或恶意攻击防护。
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
```

`--mode full` 适合提交前查看整个工作目录，`--mode tracked` 只检查会进入 `git archive` 的版本化文件。可通过 `--denylist /private/path/denylist.txt` 加载不入库的私有敏感词表。发布前还应对完整 Git 历史运行 Gitleaks；本工具只审计当前工作树，不替代历史扫描。

GitHub Actions 仅使用 `contents: read`，不使用 `pull_request_target`，也不保存任何模型密钥。Release archive 应使用 `git archive` 生成，并单独计算 SHA256。

贡献方式、DCO 和洁净室边界见 [CONTRIBUTING.md](CONTRIBUTING.md)。本项目采用 [Apache License 2.0](LICENSE)。

## 研究来源与术语边界

这些公开资料影响了本项目对“反馈 Loop”“经验记忆”和“系统自改进”的区分；链接只用于说明设计依据，运行时不会访问它们：

- [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651)：展示反馈与迭代改写的价值，但这本身不等于 RSI。
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)：展示把反馈沉淀为语言记忆的路径。
- [Building self-improving agents with Codex](https://openai.com/index/building-self-improving-tax-agents-with-codex/)：把生产纠正转成 eval，再交给 Agent 处理有明确成功条件的改进任务。
- [Anthropic: Recursive self-improvement](https://www.anthropic.com/institute/recursive-self-improvement)：用于约束“RSI”这一术语，不把普通迭代包装为完整自主 RSI。
- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)：启发候选档案、经验评估和分支探索；本项目额外保留受保护表面与人工晋升。

这些引用是设计参照，不构成本仓库已复现论文结果的声明。
