# Creative RSI Studio v1 目标运行架构

本页描述 v1 完整目标，而不是当前 alpha 已完成清单。当前只接通 Production Worker 的首次创作链路；Candidate、Evaluator、应用内三类评价、晋升与回滚仍为 `PROPOSED`。实际进度以 [alpha.1 实施状态](../product/260815-alpha1-implementation-status.md) 为准。

## 进程拓扑

```text
Sandboxed Renderer
    ↓ 白名单 IPC
Electron Main / Trusted Supervisor
    ├── Credential Store
    ├── Model Gateway
    ├── Evidence Sink
    ├── Python Controller sidecar
    ├── DSH Production utilityProcess
    ├── DSH Candidate utilityProcess（目标，尚未接入）
    └── DSH Evaluator utilityProcess（目标，尚未接入）
```

Renderer 不加载远程页面，不拥有 Node、网络、文件系统或通用 IPC。Main 是唯一持有 Key、被应用业务逻辑授权访问 DeepSeek 并更新生产指针的进程。当前 alpha 的 DSH Node 子进程属于受信依赖，尚未受到 OS 级出网沙箱约束；Profile 不向模型暴露网络工具，并把正常模型调用只配置到 loopback Gateway，但这不是对进程原始网络能力的强隔离。

## Runtime Adapter

公共系统合同不引用 DSH 类型。`RuntimeAdapter` 只暴露：

```text
startRun
resumeRun
cancelRun
streamEvents
dispose
```

DSH Adapter 当前负责 Production Worker 的运行事件与 runtime digest。Session、turn、tool、role、lineage 以及 Candidate/Evaluator 的完整 provenance 映射属于后续目标。如果固定 DSH 版本缺少所需接口，Adapter 必须 fail closed，不得把一次性 CLI 输出包装成长驻、可恢复的运行时事实。

v1 的受信 Profile 只保留进程内 Session，不挂载 DSH JSONL persistence 与 checkpoint policy。固定 rc.6 的持久化实现会无损写入 `reasoning-chunks`，与本项目的隐私合同冲突。`resumeRun` 只允许在同一活动 Worker 内继续已知 Session；进程退出后必须返回不可恢复，并由 Controller 从封存边界创建新 dispatch。

## Model Gateway

- 请求 host 固定为 `api.deepseek.com`；
- 只允许 `/models` 与 `/chat/completions`；
- 不跟随跨 origin 重定向；
- Key 只在用户录入的 Renderer 内存中短暂停留，提交后不回显、不持久化；Main 校验并加密保存，DSH、Controller 和候选永远拿不到明文 Key；
- Worker 只获得有角色、模型和预算限制的 capability handle；
- `reasoning_content` 只在需要的工具回合内存中保留；
- 所有出入站日志先脱敏，再进入 Evidence Sink。

## Controller

Python Controller 是治理事实源。桌面应用通过 JSON stdin/stdout 和参数数组调用 PyInstaller `--onedir` sidecar，禁止 shell。原 Skill CLI 保持兼容，用同一 fixture 做源码、package 和 sidecar 差分。

## 取消与恢复

用户取消或 Worker 崩溃时，Supervisor 终止当前 Worker，把 run 标记为 `INTERRUPTED`，并从最后一个已封存边界创建新 dispatch。新 dispatch 会重新生成，只保留与旧 run 的治理关联；未封存的半成品不得被当作成功或自动续写依据，应用不得宣称恢复未完成的模型回合。

Controller 快照若返回 `interrupted_run`，Main 创建下一条受治理 run 时必须把旧 `run_id` 写入 `begin_work.recovery_of`。Controller 无法验证旧 run 时必须阻止启动；Renderer 同时明确告诉用户“上次运行中断，但已封存作品仍在”，不能把它显示成普通空白起点。

反馈采用独立的事务恢复协议。若快照返回 `feedback_recovery_required`，Main 只能使用快照里的 `run_id` 调用 `resume_feedback`，由 Controller 从已经持久化的 transaction intent 恢复原 action、编辑正文和反馈；Renderer 不得重传这些原文。Main 在读取状态、启动作品和提交反馈前都会先尝试恢复：成功后展示已恢复，失败则保留恢复状态并阻止新作品和新反馈，避免不同内容覆盖原编辑。

## 版本来源

完整 v1 目标要求每次 run 至少记录；当前 alpha 只对已接通字段形成事实，不得用空字段冒充证据：

- app、Controller 和 contract schema 版本；
- DSH npm 版本、lockfile integrity 与 Profile digest；
- requested/returned model、`system_fingerprint`、参数摘要与 usage；
- Producer/Judge/Builder/Evaluator 的 role、context 和 task lineage；
- active release 与候选变更摘要。

DSH npm 制品版本与上游源码 commit 分别记录，不能在没有可复核映射时宣称二者等价。

## 尚未兑现的强隔离

稳定版若要宣称“只有 Main 能出网”，必须在 macOS 与 Windows 上增加可验证的 OS 级网络沙箱、AppContainer 或等价防火墙边界，并做负向联网测试。环境变量白名单和受信 Profile 只能减少正常执行路径，不能阻止 DSH 或其依赖代码直接调用 `fetch`、`http` 或 `net`。
