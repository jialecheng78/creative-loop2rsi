# creative-loop2rsi 协作规范

## 项目目标

构建 `Creative RSI Studio`：一套中文优先、面向非程序员的本地桌面应用，帮助用户从第一次创作开始，逐步形成单 Loop、有状态 Loop、嵌套多 Loop 和可验证自我改进的个人创作系统。

现有 `creative-loop2rsi` Builder Skill 与 Python 治理控制器继续作为高级入口和治理事实源；桌面应用使用 DSH 作为默认执行运行时，但公共合同不得依赖 DSH。

## 公开边界

- 本仓库采用洁净室实现，不读取、复制或改写任何私有管线的 Prompt、Schema、脚本、样本、运行结果或内部术语。
- 示例必须为纯虚构内容，不使用真实未发表作品、客户材料、公司名称、内部域名、模型渠道、账号、密钥或本机绝对路径。
- 应用只允许通过受信任的 Model Gateway 访问 `https://api.deepseek.com` 的 `/models` 与 `/chat/completions`；不得支持自定义 Base URL、代理或其他模型供应商。
- API Key 只允许在用户录入时短暂存在于输入页内存，并立即通过一次性窄 IPC 交给桌面主进程；Renderer 不得持久化、回读或记录 Key。Key 的校验与操作系统安全存储只由主进程管理，且不得进入环境变量、命令行、DSH Session、Controller、作品目录、日志、崩溃报告、测试 fixture 或导出包。
- 操作系统安全存储不可用时，可以在用户主动提交且界面明确说明“仅本次打开有效”后使用 Main 进程内存会话 Key；该 fallback 不得创建或修改凭证文件，不得把 Key 转交 DSH 或 Controller，删除连接、正常关闭、崩溃或进程退出后必须失效。安全存储可用时仍必须使用原加密持久路径，不得静默降级为会话保存。
- DSH 受信 Profile 不得挂载持久 Session backend 或 checkpoint policy。固定 rc.6 会把 `reasoning` 分片无损写入 Session 日志，违反本项目“推理内容不落盘”的公开承诺；v1 只能从 Controller 已封存边界重新派发，不能宣称恢复未完成的模型回合。
- 不接入遥测、云同步、后台任务、自动训练、自动公开作品或自动发布候选。
- L0–L4 是实现目标；L5 必须标记为 `experimental / unvalidated`，且任何 L5 候选都不得自动晋升。
- 模型生成的任意 JS、Python、Shell 或 Cordis Plugin 不得在 v1 中执行；代码级候选只能导出供维护者审查。

## 目录约定

- `skills/creative-loop2rsi/`：Skill 主体；`SKILL.md` 只保留主流程和引用导航，不放仓库安装或贡献说明。
- `apps/desktop/`：Electron 主进程、Preload 与 Renderer；Renderer 必须启用 sandbox、context isolation，并禁用 Node integration。
- `packages/contracts/`：运行时无关的 JSON Schema、状态机和 TypeScript 类型。
- `packages/model-gateway/`：唯一被应用配置授权访问 DeepSeek 官方 API 的业务实现。alpha 的受信 DSH 子进程尚无 OS 级出网沙箱；Profile 只向模型提供 loopback Gateway，不等于从操作系统层禁止该进程自行联网。
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
- 应用的“最小可验证自我改进”与正式 L4 必须分层：最小闭环可以在三项独立作品出现同一条直接用户反馈后建立声明式方法候选，但不得因此改写正式成熟度；正式 L4 仍受 `loopctl.py` 的 L0–L3、独立 Judge、exact-three 与晋升合同约束。
- 最小方法候选只允许修改应用读取的声明式生产指导。候选 Builder 不得读取 held-out；评价固定为 targeted、regression、held-out 各一次盲比，由本地用户作最终审美选择。候选不得读取盲比映射、API Key、active method pointer 或回滚政策。
- 最小方法版本必须有独立的内容寻址注册表、人工采用凭证与回滚凭证；只有三组盲比门齐全且用户明确点击采用，才可改变应用的 active method version。该版本变化不得被描述为正式 L4 晋升。
- 新方法采用后的下一项作品必须把 active method version 与指导摘要绑定进 Controller provenance；否则不得声称系统已实际使用新方法。
- Git commit message 使用中文；未经用户明确要求，不执行 `git push` 或公开发布。

## 验证要求

变更后至少运行：

```bash
python3 -m unittest discover -s tests -v
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/creative-loop2rsi
pnpm install --frozen-lockfile
pnpm run check
python3 tools/audit_public_tree.py .
python3 tools/check_dco.py . --range HEAD
python3 tools/audit_release_archive.py . --treeish HEAD
```

所有由 `loopctl.py init` 生成的领域 Skill 也必须通过官方 `quick_validate.py`。若缺少真实非程序员测试、外部元评估或 live forward test，必须在 README 与交付说明中标为未验证，不得用自动测试替代。

GitHub CI 必须使用完整 commit SHA 固定第三方 Action，并保持 `contents: read`、`persist-credentials: false`、无 `pull_request_target` 和无仓库密钥。CI 只能使用 DeepSeek mock；真实 Pro/Flash 验收必须在本地以临时维护者 Key 完成且不落盘。Gitleaks 必须扫描完整 Git 历史，并先用合成泄漏证明扫描器会正确失败；发布归档必须直接从目标 commit 生成、审计并绑定 SHA256，不得用工作树检查替代。
