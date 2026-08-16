# Creative RSI Studio v1 目标运行架构

本页描述 v1 完整目标，而不是当前 alpha 已完成清单。当前只接通 Production Worker 的首次创作链路；Candidate、Evaluator、应用内三类评价、晋升与回滚仍为 `PROPOSED`。实际进度以 [alpha.1 实施状态](../product/260815-alpha1-implementation-status.md) 为准。

## 进程拓扑

```text
Sandboxed Renderer
    ↓ 白名单 IPC
Electron Main / Trusted Supervisor
    ├── Credential Store（safeStorage 密文或 Main 内存会话）
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
- Key 只在用户录入的 Renderer 内存中短暂停留，提交后立即清空输入且不回显；Main 先通过官方 `/models` 校验，再按公开状态处理：`protected` 使用 safeStorage 加密持久保存，`session` 只保留在当前 Main 进程内存，`none` 表示没有可用 Key；
- 只有 safeStorage 不可用且 Renderer 明确提交 `allowSessionOnly=true` 时才允许 `session`；该路径不创建或修改凭证文件，删除连接与 Main shutdown 都先清除内存引用，会话值在重启后不得恢复；如果没有另一个可用的 `protected` 密文，公开状态必须回到 `none`。safeStorage 可用但加密或写入失败时不得自动 fallback；
- Main-owned Model Gateway 可以读取 `protected` 或 `session` Key；DSH、Controller 和候选永远拿不到明文 Key；
- Worker 只获得有角色、模型和预算限制的 capability handle；
- Main、Gateway 与受信 DSH Profile 对所有角色固定使用 `thinking=enabled`、`reasoning_effort=high` 和单次最多 `32,768` 个总输出 token；DSH 保持 `maxTokensAsSuccess=false`，达到上限必须归类为 `OUTPUT_TRUNCATED`，不得封存部分输出；
- Controller 继续只读识别旧版已封存证据中的 `max_tokens=16,384`。当前 Bridge 与 Controller 只在 `terminate_work` endpoint 接受这个旧值；endpoint 本身不验证 Main pending 文件来源，受信 Main 只能用它重放升级前已持久化的 `TERMINATION_REQUIRED` pending-work 及其幂等重试，以便收敛失败终态。`complete_work`、取消新写入、Builder、候选生成和评价仍只接受 `32,768`。输出预算变化属于方法基线参数变化，旧证据必须保留在原 epoch，旧观察只能展示且永远 `ready=false`，不能触发模型调用或与 `32,768` 的新作品合并计算改进；
- `reasoning_content` 只在需要的工具回合内存中保留；
- 所有出入站日志先脱敏，再进入 Evidence Sink。

流式创作不得用一个短的固定倒计时同时代表“模型尚未开始”“返回途中停滞”和“任务总体过长”。Production Worker 固定使用三条相互独立的时限：

- `firstEventTimeoutMs=120000`：从请求开始到首个合法 SSE event；响应头、裸字节和 keep-alive 注释都不算模型已经开始返回；
- `streamIdleTimeoutMs=90000`：首个合法 event 之后，任意两个合法 SSE event 之间允许的最长空闲时间；每个合法 event 重置该计时器；
- `totalTimeoutMs=600000`：从请求开始计算的绝对总时限，永不因流进展重置。

三类失败分别记录 `FIRST_EVENT_TIMEOUT / STREAM_IDLE_TIMEOUT / TOTAL_TIMEOUT`，并由 Main 以 loopback request ledger 作为最终类别来源再传给界面。DSH rc.6 会把首事件前耗尽的 HTTP 5xx 归一为 `SERVER`，因此 Runtime event 不是该类别的唯一事实源。只有在首个合法 event 之前发生的限流或服务端失败才允许按固定预算重试；一旦流已经开始，idle/total failure 不得自动重跑整条长请求，避免重复计费和重复生成。外部取消始终优先，所有 timer 在成功、失败或取消后都必须清理。

## Controller

Python Controller 是治理事实源。桌面应用通过 JSON stdin/stdout 和参数数组调用 PyInstaller `--onedir` sidecar，禁止 shell。原 Skill CLI 保持兼容，用同一 fixture 做源码、package 和 sidecar 差分。

## 取消、失败终态与恢复

`DispatchStallRecord` 只证明一个 dispatch 已停止且允许局部重派，不是失败 run 的终态。应用级 Worker 失败或用户取消必须再写不可变 `TerminatedAttempt` 作为失败侧 commit point。打开时写入的 `attempt.json` 与 `dispatch.json` 保持不可变；终态由 marker 以及 run/system 投影证明，不能回写 start facts 冒充历史。

`TerminatedAttempt` 区分两类事实：精确零输出的 runtime failure 绑定 stall 与 provenance，且不消耗内容 attempt；已经产生但尚未安全提交的输出绑定其 inventory 与哈希，标记不可发布、不可形成 finding。两类都必须令 run 收敛为 `BLOCK`、清空 `current_attempt`、禁止同 run 继续派发，并要求下一次创作使用新 run 与 `recovery_of` 关联。marker 写入后即使进程在投影前崩溃，Controller 也必须在读取快照或下一次写操作前幂等 roll-forward；全部 attempt mutator 还必须直接拒绝 marker，避免投影崩溃窗口继续写入或形成 `.sealed.json`。终态复核覆盖全部 dispatch，旧 stalled root 的晚写按 `LATE_WRITE_CONTAMINATION` 阻断；失败记录绝不能进入作品、反馈或重复 finding 计数。

用户取消或 Worker 崩溃时，Supervisor 终止当前 Worker并封存失败终态，然后从最后一个已封存边界创建新 run。新 run 会重新生成，只保留与旧 run 的治理关联；未封存的半成品不得被当作成功或自动续写依据，应用不得宣称恢复未完成的模型回合。若失败终态尚未确认写入，界面必须显示“失败记录尚未封存、重启后恢复”，并阻止把该 run 当成成功；Main 不得吞掉 Controller 终止错误。

Controller 快照若返回 `interrupted_run`，Main 创建下一条受治理 run 时必须把旧 `run_id` 写入 `begin_work.recovery_of`。Controller 无法验证旧 run 时必须阻止启动；Renderer 同时明确告诉用户“上次运行中断，但已封存作品仍在”，不能把它显示成普通空白起点。

Main 另在 Electron `userData/supervisor/pending-work.json` 维护一条本机 replay intent，用来跨越“Controller 已写入、但 Main 没收到响应”和“Controller 暂时不可用”的窗口。它不是第二套治理事实源：Controller 的作品、`TerminatedAttempt` 和投影始终优先。Main 必须在第一次 `begin_work` 前以原子替换写入 `LAUNCHING`，并保留到作品成功提交或失败终态被精确验证；文件只保存 exact begin payload、受治理标识和脱敏终止 provenance，不得包含 API Key、capability、Gateway URL、推理内容、环境变量、项目绝对路径，也不得进入日志或导出包。POSIX 上目录和文件权限分别固定为 `0700` 与 `0600`；symlink、未知字段、超限文件或 content hash 不一致必须 fail closed，不能自动覆盖证据。

若 `begin_work` 的响应丢失，Main 只能以完全相同 payload 幂等重试。只有得到合法 receipt，或快照精确证明同一 `run_id + work_id + dispatch_id` 已存在，才可把 intent 转为 `TERMINATION_REQUIRED`；Controller 不可达或 begin 尚未确认时必须保持 `LAUNCHING`，避免生成一条永远无法执行的 terminate。终止语义采用 first-writer-wins，取消、关闭和 runtime late event 不得相互覆写。重启时，所有新创作、模型切换、反馈和方法操作先串行 reconciliation：精确完成作品时 success wins；精确终止时清队列；否则先 replay begin、再 replay terminate。只有匹配 receipt 或精确快照 read-back 后才删除 intent；未收敛时返回 `workRecoveryState=retry-required` 并阻止新 work。

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
