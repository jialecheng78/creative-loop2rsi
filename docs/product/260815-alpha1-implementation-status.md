# Creative RSI Studio alpha.1 实施状态

## 结论

当前仓库已经具备 macOS arm64 的 source-bound 打包应用、固定 `32,768` 策略的真实 Flash 路径和一次完整的最小应用级自我改进闭环。范围化结论为 **`OPERATIONAL-PASS`**：三项独立作品的相同直接反馈形成候选，三组人类盲比、明确采用、下一作品实际使用、回滚和重启恢复均已跑通。

这仍不是“稳定版已经完成”。Computer Use 操作者是 simulated-user，不是身份认证过的真人或真实非程序员；结果不证明文学质量、V4 Pro、Windows、签名、公证、自动更新或独立全新账户安装。`studio-v1.0.0-alpha.1` 仍是待发布的技术预览版本；本文不表示 GitHub Release 或 tag 已经存在。完整证据边界见 [32,768 打包应用与最小闭环验收报告](260817-32K打包应用与最小闭环验收报告.md)。

## 已实现

- Electron Renderer、Preload、Main 与 DSH utility worker 的分层骨架；Renderer 开启 sandbox 与 context isolation，不拥有 Node 或通用 IPC。
- `safeStorage` 凭据封装、仅允许 DeepSeek 官方地址的 Model Gateway、Pro/Flash 固定模型选择和请求预算。
- DSH rc.6 受信 Profile、公开 SDK JSON-RPC Adapter、loopback capability 与 Worker 取消/退出处理。
- Electron ESM 入口采用非阻塞 bootstrap；应用只允许单实例，重复实例聚焦已有窗口，关闭最多等待 15 秒。
- live harness 在打开 Key 前先运行无 Key、零模型 fetch、零模型 lease 的独立 Electron 预检。
- 当前 `32,768` epoch 已在 macOS arm64 打包应用中完成真实 Flash、requested/returned model、fingerprint、usage、作品封存和来源证据绑定；历史 `16,384` epoch 继续保留，但不与新 epoch 合并计数。
- Python Controller 应用协议：初始意图、作品 dispatch、完成、取消、反馈、封存和系统快照。
- Key → 模型 → 创作方向 → 生成 → 编辑/保留/拒绝/重写反馈的界面与 Main 业务链路。
- sandboxed Preload 采用单文件 CommonJS bundle；真实 hidden BrowserWindow smoke 验证凭证页、窄 IPC、默认 Session 零 HTTP/HTTPS 请求和无 Node 全局暴露。
- Computer Use 已在当前 `32,768` 打包应用中完成 Flash 创作、反馈聚合、候选、三组盲比、采用、下一作品生效、回滚与退出重启检查；simulated-user 不等于真人或文学质量评价。
- 反馈事务中断后由 Main 依据 Controller 已保存的 intent 自动恢复；恢复失败时界面保留明确状态，并阻止新反馈和新作品覆盖原编辑。
- 三项独立作品出现规范化后完全相同的直接反馈时，应用会形成“暂时观察”；当前打包应用已用三个 distinct run/work/task/feedback receipt 形成一次可复核观察，并生成声明式方法候选。
- targeted、regression、held-out 三组 A/B/TIE 盲比、明确采用、下一作品的 method/guidance 精确绑定、回滚和重启恢复均已通过一次 operational 验收；该最小闭环不改写正式 L0–L5 成熟度。
- CPython 3.11 PyInstaller `--onedir` Controller sidecar 构建器，以及源码/sidecar 协议差分检查。
- Node/Python 自动测试、公开树审计、DCO、完整历史 Gitleaks、源码 archive、SBOM 与许可证清单预检。

`IMPLEMENTED` 只表示代码和本地自动验证存在。`OPERATIONAL-PASS` 表示指定平台上的真实打包应用和/或真实模型路径已经跑通，也不表示真实创作质量、身份认证或普通用户安装体验已经通过。

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
| M2 安全运行骨架 | macOS arm64 `OPERATIONAL-PASS` | mock、真实 DSH 启停、无 Key且零模型 fetch/lease 的 Electron 预检、sandboxed Preload 与 source-bound packaged smoke 通过；Windows 与 DSH OS 级出网隔离未验证 |
| M3 首个可用闭环 | 当前 32,768 epoch `OPERATIONAL-PASS` | macOS arm64 打包应用的真实 Flash Chat、GUI、反馈和封存通过；Pro、Windows、供应商侧取消、真人体验与文学质量未验证，见 [本轮验收报告](260817-32K打包应用与最小闭环验收报告.md) |
| M4 个人创作系统 | 最小切片 `OPERATIONAL-PASS` | 三项独立作品的 exact-text 直接反馈聚类通过；同义反馈聚类、正式 L2/L3 校准仍未实现 |
| M5 可验证自我改进 | 最小应用闭环 `OPERATIONAL-PASS` | DSH Candidate、三组人类盲比、采用、下一作品生效、回滚和重启恢复通过；没有独立模型 Judge，不满足正式 L4 |
| M6 系统实验室 | 协议原型 | 只能建立 `CANDIDATE_ONLY` 治理记录；应用没有生成维护者 patch 包，也不运行模型生成代码 |
| M7 无开发者身份签名的预览发布 | 发布准备中 | macOS arm64 source-bound 打包应用和 packaged smoke 已通过；匿名 ad-hoc seal 只保证 bundle 一致性。公开合同固定为主 ZIP、`SHA256SUMS.txt` 与 evidence ZIP。GitHub Pre-release、Developer ID、公证和独立真人安装尚未完成 |

## 下一条最小发布路径

1. 从最终 release-prep commit 执行 frozen clean build，重新绑定 commit、tree、lockfile、工具链、sidecar 和最终 app inventory。
2. 对最终 App 执行匿名 ad-hoc seal，并要求 `codesign --verify --deep --strict` 通过；只有 `spctl --raw` 明确给出 `no usable signature` 才记为 `REJECTED_UNSIGNED_EXPECTED`，只返回裸 `rejected` 时记为 `REJECTED_ADHOC_UNATTRIBUTED`，不能伪称 Gatekeeper 已放行或猜测拒绝原因。
3. 生成 macOS-aware ZIP，解压后重新核对 manifest v2、symlink、mode、敏感路径和 packaged smoke；发布清单不得含本机绝对路径或用户状态。
4. Draft Release 只上传主 ZIP、`SHA256SUMS.txt` 和 evidence ZIP；从 Draft 重新下载后按标准 Gatekeeper “打开/仍要打开”路径验收，不提供 `xattr` 或关闭 Gatekeeper 的绕过方案。
5. Draft 下载验收通过后才能公开 Pre-release。Pro、Windows、Developer ID、公证、自动更新与独立真人测试继续标为未验证；单独全新 macOS 账户是非阻断缺口。

## 当前实施目标：最小闭环，不改写正式成熟度

当前实现切片遵循 [最小可验证自我改进闭环实施合同](260815-最小可验证自我改进闭环实施合同.md)：三项独立作品同一条直接反馈、声明式方法候选、三组人类盲比、明确采用、第 4 项作品实际使用、回滚和重启恢复已经由 `32,768` 打包应用实际跑通。该结果仍只是应用级最小闭环，不会绕过 `loopctl.py` 的 L3 前置门，也不会把项目标成正式 L4。
