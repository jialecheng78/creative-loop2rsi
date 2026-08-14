# Creative RSI Studio v1 威胁模型

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
| Main Supervisor | 进程管理、凭证、Gateway、生产指针 | 执行模型生成代码 |
| Model Gateway | DeepSeek 白名单请求 | 自定义 URL、跨域重定向、日志 Key |
| DSH Production Worker | 受信 Profile 与模型能力句柄 | 明文 Key、原始网络、Shell、动态代码 |
| Candidate Worker | 候选副本与限额模型能力 | production、held-out、晋升与发布 |
| Evaluator Worker | 盲化输入和评价输出 | 候选修改意图、明文 Key、晋升操作 |
| Python Controller | 合同、证据、晋升、回滚 | 网络和凭证 |

## v1 明确不解决

- 已控制用户操作系统账户或 Electron Main 进程的恶意软件；
- DeepSeek、Electron、DSH 或操作系统自身的未知漏洞；
- 未签名 alpha 的发布者身份认证；
- 对模型输出文学价值、真实性或市场结果的保证；
- 任意不可信代码的安全执行。

## Fail-closed 规则

- 安全存储不可用时不保存 Key，也不启动模型调用；
- 模型或 `system_fingerprint` 跨评价变化时阻断候选晋升；
- Candidate、Evaluator 或 Renderer 请求越权能力时记录事件并终止该 Worker；
- 任何评价缺失、重复、旧结果污染或证据哈希变化都阻断晋升；
- 未检测到用户点击形成的人工回执时，active release pointer 不得变化。
