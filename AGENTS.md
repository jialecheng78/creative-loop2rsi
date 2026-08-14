# creative-loop2rsi 协作规范

## 项目目标

构建 `Creative RSI Studio`：一套中文优先、面向非程序员的本地桌面应用，帮助用户从第一次创作开始，逐步形成单 Loop、有状态 Loop、嵌套多 Loop 和可验证自我改进的个人创作系统。

现有 `creative-loop2rsi` Builder Skill 与 Python 治理控制器继续作为高级入口和治理事实源；桌面应用使用 DSH 作为默认执行运行时，但公共合同不得依赖 DSH。

## 公开边界

- 本仓库采用洁净室实现，不读取、复制或改写任何私有管线的 Prompt、Schema、脚本、样本、运行结果或内部术语。
- 示例必须为纯虚构内容，不使用真实未发表作品、客户材料、公司名称、内部域名、模型渠道、账号、密钥或本机绝对路径。
- 应用只允许通过受信任的 Model Gateway 访问 `https://api.deepseek.com` 的 `/models` 与 `/chat/completions`；不得支持自定义 Base URL、代理或其他模型供应商。
- API Key 只能由桌面主进程通过操作系统安全存储管理，不得进入环境变量、命令行、Renderer、DSH Session、Controller、作品目录、日志、崩溃报告、测试 fixture 或导出包。
- 不接入遥测、云同步、后台任务、自动训练、自动公开作品或自动发布候选。
- L0–L4 是实现目标；L5 必须标记为 `experimental / unvalidated`，且任何 L5 候选都不得自动晋升。
- 模型生成的任意 JS、Python、Shell 或 Cordis Plugin 不得在 v1 中执行；代码级候选只能导出供维护者审查。

## 目录约定

- `skills/creative-loop2rsi/`：Skill 主体；`SKILL.md` 只保留主流程和引用导航，不放仓库安装或贡献说明。
- `apps/desktop/`：Electron 主进程、Preload 与 Renderer；Renderer 必须启用 sandbox、context isolation，并禁用 Node integration。
- `packages/contracts/`：运行时无关的 JSON Schema、状态机和 TypeScript 类型。
- `packages/model-gateway/`：唯一允许访问 DeepSeek 官方 API 的实现。
- `packages/runtime-dsh/`：DSH Adapter、受信 Profile 和 Worker；DSH 类型不得扩散到 UI 或治理合同。
- `packages/controller-bridge/`：桌面应用到 Python Controller 的结构化桥接，禁止 shell。
- `python/creative_loop2rsi/`：应用使用的 Python 治理包；原 Skill 脚本路径保留兼容 wrapper。
- `docs/`：产品、架构、隐私和公开研究文档。
- `skills/creative-loop2rsi/references/`：成熟度、合同、恢复、评价与 RSI 实验说明。
- `skills/creative-loop2rsi/scripts/`：Python 3.9+ 标准库运行工具。
- `skills/creative-loop2rsi/assets/`：starter project 与纯虚构示例。
- `tests/`：Python、合同、集成、安全和打包测试；自动测试不得访问真实模型 API。
- `tools/`：公开树审计等仓库维护工具。
- 用户生成内容、运行轨迹和未发表素材默认不入库。

## 实现规则

- 先修改规范或公共合同，再修改相应实现。
- Python 只使用标准库，兼容 Python 3.9+，不读取环境中的模型密钥。
- App sidecar 固定使用 CPython 3.11 与 PyInstaller `--onedir`；用户不需要安装 Python。
- Node 依赖必须精确固定并提交 lockfile；第三方许可证写入 `THIRD_PARTY_NOTICES.md`。
- Renderer 只可调用白名单业务 IPC，不能提交任意命令、URL 或绝对路径。
- DSH Production、Candidate 与 Evaluator 使用独立 Worker；候选不能读取 held-out、Key、晋升政策或 active release pointer。
- 所有模型请求必须记录 requested/returned model、`system_fingerprint`、参数摘要与运行时版本；模型基线变化时不得复用旧候选评价。
- 所有文件写入采用同目录临时文件加原子替换；初始化非空目录时拒绝覆盖。
- 已封存 attempt 不得修改；候选不得修改创作宪法、原始素材、held-out 答案、许可证、晋升政策或人工审批边界。
- Producer 与 Judge 分离；机器不得替用户决定核心审美，无法判断时返回 `NEEDS_TASTE`。
- 硬合同、软质量和人类立宪三类判断必须分开；结构 `PASS` 不得被描述为创作质量已通过。
- Git commit message 使用中文；未经用户明确要求，不执行 `git push` 或公开发布。

## 验证要求

变更后至少运行：

```bash
python3 -m unittest discover -s tests -v
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/creative-loop2rsi
corepack pnpm install --frozen-lockfile
corepack pnpm run check
python3 tools/audit_public_tree.py .
python3 tools/check_dco.py . --range HEAD
python3 tools/audit_release_archive.py . --treeish HEAD
```

所有由 `loopctl.py init` 生成的领域 Skill 也必须通过官方 `quick_validate.py`。若缺少真实非程序员测试、外部元评估或 live forward test，必须在 README 与交付说明中标为未验证，不得用自动测试替代。

GitHub CI 必须使用完整 commit SHA 固定第三方 Action，并保持 `contents: read`、`persist-credentials: false`、无 `pull_request_target` 和无仓库密钥。CI 只能使用 DeepSeek mock；真实 Pro/Flash 验收必须在本地以临时维护者 Key 完成且不落盘。Gitleaks 必须扫描完整 Git 历史，并先用合成泄漏证明扫描器会正确失败；发布归档必须直接从目标 commit 生成、审计并绑定 SHA256，不得用工作树检查替代。
