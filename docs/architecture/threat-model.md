# Creative RSI Studio v1 威胁模型

本威胁模型同时覆盖当前 alpha 与完整 v1 目标。表中 Candidate/Evaluator Worker 尚未接入应用，相关隔离与终止规则当前为 `PROPOSED`，不能据此声称已经实现。

## 受保护资产

- DeepSeek API Key；
- 用户未发表作品、反馈与偏好；
- 创作宪法、held-out、晋升政策和人工决定；
- production active release pointer；
- 不可变 attempt、评价与晋升证据。

## 信任边界

| 组件 | 权限 | 禁止能力 |
|---|---|---|
| Sandboxed Renderer | 展示状态、提交白名单业务动作 | Node、文件系统、网络、Shell、任意 IPC |
| Preload | 参数校验与窄 IPC | 暴露 `ipcRenderer` 或通用 send |
| Main Supervisor | 进程管理、受保护或仅会话凭证、Gateway、生产指针 | 执行模型生成代码；把会话 Key 写入磁盘或交给 Worker |
| Model Gateway | DeepSeek 白名单请求 | 自定义 URL、跨域重定向、日志 Key |
| DSH Production Worker | 受信 Profile 与模型能力句柄；模型侧无网络/Shell/动态代码工具 | 明文 Key；alpha 尚未用 OS 沙箱禁止受信进程自身的原始网络 |
| Candidate Worker（目标） | 候选副本与限额模型能力 | production、held-out、晋升与发布 |
| Evaluator Worker（目标） | 盲化输入和评价输出 | 候选修改意图、明文 Key、晋升操作 |
| Python Controller | 合同、证据、晋升、回滚 | 网络和凭证 |

## v1 明确不解决

- 已控制用户操作系统账户或 Electron Main 进程的恶意软件；
- DeepSeek、Electron、DSH 或操作系统自身的未知漏洞；
- 未签名 alpha 的发布者身份认证；
- 对模型输出文学价值、真实性或市场结果的保证；
- 任意不可信代码的安全执行。
- alpha 阶段对受信 DSH Node 进程的 OS 级出网隔离；在完成前不得宣称 Main 是唯一具备原始网络能力的进程。

## Fail-closed 规则

- 安全存储不可用时不得创建或修改凭证文件；只有 Renderer 明确提交 `allowSessionOnly=true`，Main 才可在完成官方模型列表校验后把 Key 保留在当前进程内存，并把公开状态标为 `persistence=session`；关闭、崩溃、删除连接或进程退出后不可恢复；
- 安全存储可用时必须使用加密持久路径并标为 `persistence=protected`；加密或写入失败时不得静默降级为会话 Key；未配置时固定为 `persistence=none`；
- Renderer 只能提交 Key 与布尔型 `allowSessionOnly`，不能回读 Key 或指定存储路径；Main 的 Model Gateway 可以读取当前受保护或会话 Key，DSH、Controller、候选和评价者仍只能获得限权 capability；
- 模型或 `system_fingerprint` 跨评价变化时阻断候选晋升；
- 当前 Renderer 请求越权能力时拒绝调用；完整 v1 目标是在 Candidate 或 Evaluator 越权时记录事件并终止对应 Worker；
- 任何评价缺失、重复、旧结果污染或证据哈希变化都阻断晋升；
- 未检测到用户点击形成的人工回执时，active release pointer 不得变化。
