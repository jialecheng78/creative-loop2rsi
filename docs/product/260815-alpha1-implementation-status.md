# Creative RSI Studio alpha.1 实施状态

## 结论

当前仓库已经具备“从源码运行的首个创作闭环”和可复核的安全边界，但还不是可交付给普通用户下载安装的 v1。macOS arm64 的真实 Flash API、封存、重启恢复和 GUI operational PASS 均来自历史 `max_tokens=16,384` epoch；当前固定 `32,768` 策略尚待本轮实网复验，不能沿用旧 PASS。历史结果也不等于安装包、真人验收或文学质量证明。`alpha.1` 现在是开发里程碑名称，不是已经发布的安装包。

## 已实现

- Electron Renderer、Preload、Main 与 DSH utility worker 的分层骨架；Renderer 开启 sandbox 与 context isolation，不拥有 Node 或通用 IPC。
- `safeStorage` 凭据封装、仅允许 DeepSeek 官方地址的 Model Gateway、Pro/Flash 固定模型选择和请求预算。
- DSH rc.6 受信 Profile、公开 SDK JSON-RPC Adapter、loopback capability 与 Worker 取消/退出处理。
- Electron ESM 入口采用非阻塞 bootstrap；应用只允许单实例，重复实例聚焦已有窗口，关闭最多等待 15 秒。
- live harness 在打开 Key 前先运行无 Key、零模型 fetch、零模型 lease 的独立 Electron 预检。
- 历史 `16,384` epoch 的 Flash 实网验收已验证 requested/returned model、fingerprint、usage、SSE 完成、harness 固定测试修订封存与跨进程恢复；当前 `32,768` 策略尚未取得新的 live PASS。本次历史 app-state 扫描未发现 Key 原文、已知 Session 文件或 raw reasoning 字段。
- Python Controller 应用协议：初始意图、作品 dispatch、完成、取消、反馈、封存和系统快照。
- Key → 模型 → 创作方向 → 生成 → 编辑/保留/拒绝/重写反馈的界面与 Main 业务链路。
- sandboxed Preload 采用单文件 CommonJS bundle；真实 hidden BrowserWindow smoke 验证凭证页、窄 IPC、默认 Session 零 HTTP/HTTPS 请求和无 Node 全局暴露。
- Computer Use 曾在历史 `16,384` epoch 从 GUI 完成 Key 验证、Flash 选择、首次创作、直接编辑、反馈封存、四入口检查和跨进程恢复；当前 `32,768` 策略仍需复验，见 [GUI 验收报告](260815-Computer-Use-GUI验收报告.md)。
- 反馈事务中断后由 Main 依据 Controller 已保存的 intent 自动恢复；恢复失败时界面保留明确状态，并阻止新反馈和新作品覆盖原编辑。
- 三项独立作品出现规范化后完全相同的直接反馈时，应用会形成“暂时观察”；用户可生成声明式方法候选，完成 targeted、regression、held-out 三组 A/B/TIE 盲比，并明确采用、拒绝或回滚。
- 新方法采用后，下一项作品会把 method version、指导摘要和 context SHA256 绑定进 Controller 证据；该最小闭环不改写正式 L0–L5 成熟度。
- CPython 3.11 PyInstaller `--onedir` Controller sidecar 构建器，以及源码/sidecar 协议差分检查。
- Node/Python 自动测试、公开树审计、DCO、完整历史 Gitleaks、源码 archive、SBOM 与许可证清单预检。

`IMPLEMENTED` 只表示代码和本地自动验证存在，不表示真实创作质量、真实模型调用或普通用户安装已经通过。

## 安全取舍

固定 DSH rc.6 的 JSONL Session backend 会无损保存 `reasoning-chunks`。为满足“模型推理内容不落盘”，受信 Profile 不加载该 backend 或 checkpoint policy。

受信 Profile 也不会向模型提供 Web、Shell 或动态代码工具，正常模型请求只指向本机 Gateway；但 alpha 尚未给 DSH Node 子进程增加 OS 级出网沙箱。因此这只是受信配置边界，不能宣称 Main 是唯一拥有原始网络能力的进程。

因此：

- 已由 Controller 封存的作品、反馈和版本可以在应用重启后恢复；
- 正在生成但尚未封存的模型回合不能跨进程恢复；
- Worker 崩溃或用户取消后，从最后一个封存边界建立新 dispatch；
- 新 dispatch 通过 `recovery_of` 绑定被中断的旧 run；本次会重新生成而非续写未完成推理，Controller 无法验证关联来源时拒绝启动；
- 页面和文档不得把重新派发描述成“续跑原推理”。

## 尚未实现或尚未验证

| 里程碑 | 当前状态 | 缺口 |
|---|---|---|
| M0 规则与 Skill 基线 | 已完成 | 仍需在最终 commit 后重跑完整历史与 archive 审计 |
| M1 Monorepo 与治理拆包 | 已实现 | Python 采用 facade-first；旧 Skill 脚本仍是唯一治理实现，尚未反转成薄 wrapper |
| M2 安全运行骨架 | 已实现、部分未验证 | mock、真实 DSH 启停、无 Key且零模型 fetch/lease 的 Electron 预检和 sandboxed Preload 真实 smoke 通过；macOS/Windows 打包进程与 DSH OS 级出网隔离尚未验收 |
| M3 首个可用闭环 | 历史 16,384 epoch operational PASS；当前 32,768 待复验 | macOS arm64 的 Flash Chat、GUI 编辑反馈、封存和跨进程恢复 PASS 均属于旧 epoch；当前策略、Pro、Windows、packaged app 与非程序员体验未验证。取消只证明本地 lease revoke，不证明供应商侧在途或零计费，见 [Headless 验收](260815-Flash真实验收报告.md) 与 [GUI 验收](260815-Computer-Use-GUI验收报告.md) |
| M4 个人创作系统 | 已实现最小切片、未前向验收 | 初始意图、作品、直接反馈、跨作品 exact-text 聚类和用户可见原则已接通；同义反馈聚类、正式 L2/L3 校准仍未实现 |
| M5 可验证自我改进 | 已实现最小应用闭环、未前向验收 | DSH Candidate 生成、三组人类盲比、采用、下一作品生效和回滚已接通；没有独立模型 Judge，不满足正式 L4，也尚未由打包应用独立执行者验证 |
| M6 系统实验室 | 协议原型 | 只能建立 `CANDIDATE_ONLY` 治理记录；应用没有生成维护者 patch 包，也不运行模型生成代码 |
| M7 无签名预览发布 | 未完成 | 没有 DMG、EXE、portable ZIP、packaged smoke、GitHub Release 或真人安装测试 |

## 下一条最小发布路径

1. 先实现 fresh-build manifest，绑定 HEAD、lockfile、实际工具链与全部运行字节；再由无历史上下文的独立执行者复跑 Flash。在此之前保持 `IMPLEMENTED`，不升为 `FORWARD-TESTED`。
2. 单独验证 Pro；若没有通过，Pro 必须继续标为 `UNVALIDATED`。Key 与正文不得进入测试记录。
3. 在 macOS arm64 和 Windows x64 hosted runner 生成可运行的 unpacked app，并用打包 sidecar 做 smoke test。
4. 解决 installer 依赖供应链门禁后再生成 DMG、Windows 安装器与 portable ZIP；为每个产物绑定 SHA256、SBOM、许可证和来源 manifest。
5. 完成 5 名非程序员验收后，才发布无签名 alpha；签名、公证与无警告安装仍是 stable blocker。
6. 用打包应用和独立 `simulated-user` 完成三作品同反馈 → 候选 → exact-three 盲比 → 采用 → 第四作品生效 → 回滚；通过前仅标 `IMPLEMENTED`，不得升为 `FORWARD-TESTED`。

## 当前实施目标：最小闭环，不改写正式成熟度

当前实现切片遵循 [最小可验证自我改进闭环实施合同](260815-最小可验证自我改进闭环实施合同.md)：三项独立作品同一条直接反馈、声明式方法候选、三组人类盲比、明确采用、第 4 项作品实际使用和回滚已经接通自动测试。下一步是把源码与 sidecar 绑定到 clean commit，生成 macOS arm64 packaged preview，再交给独立 `simulated-user` 走完整 GUI；在此之前不会绕过 `loopctl.py` 的 L3 前置门，也不会把项目标成正式 L4。
