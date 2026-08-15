# Creative RSI Studio：Computer Use GUI 真实验收报告

## 结论

限定范围内结论是 **`PASS`**：macOS arm64 当前本地源码 build 已通过一次由 Computer Use 模拟普通用户完成的真实 GUI 路径：输入并安全保存 DeepSeek Key、选择 V4 Flash、提交创作主题、取得作品、直接修改正文、提交文字反馈、封存版本，并在完整退出后的新 Electron 进程中恢复相同结果。

这不是“真人测试”或 `FORWARD-TESTED`。执行者是有项目上下文的自动化 Agent；本次也没有覆盖安装包、Windows、Pro Chat、非程序员理解成本、文学质量、Candidate/Evaluator 或应用内 RSI 闭环。

## 用户路径

```text
启动应用
  → 输入并验证 DeepSeek API Key
  → 选择 V4 Flash
  → 输入纯虚构创作主题
  → 等待作品生成
  → 在编辑器中修改结尾
  → 提交明确文字反馈
  → 封存用户修订稿
  → 依次检查四个主要入口
  → 完整退出并重启
  → 恢复同一修订稿与封存状态
```

Key 输入前取得了用户明确授权。Key 只粘贴到应用的密码输入框，粘贴后立即清空系统剪贴板；测试记录、截图、命令参数和本报告都不保存 Key 原文。

## 真实模型证据

| 项目 | 结果 |
|---|---|
| selected / requested / returned model | `deepseek-v4-flash` |
| HTTP | `200` |
| request | 1 completed / 0 failed |
| system fingerprint | `a26a7955944dc5c60445bff77fac9c8e` |
| response ID | 仅保存 SHA256：`adfedad512114d001b6620b8d3f6431029258e8990551a89e26bf2d6c3dfb432` |
| usage | prompt 248 / completion 255 / total 503 |
| cache | hit 128 / miss 120 |
| DSH | `0.1.0-rc.6` |
| reasoning persisted | `false` |

模型正文未进入报告。原始生成物为 378 UTF-8 bytes，SHA256 为 `1edec8f1ad3b7197e4e4287cbddfbce1a3be4e2e2d0f47533bde0ec754f7f29a`；Computer Use 在编辑器中修改结尾后，用户修订稿为 381 bytes，SHA256 为 `351d3e697232740e69d99aff8e4453fcb99d2e3f8116836b437b519e8c2b43ed`。

`quality_status=NOT_EVALUATED`。这次运行只证明产品流程、模型来源和证据封存，不证明作品写得好。

## GUI 与治理证据

- 应用先调用真实 `/models` 验证 Key，再显示 Pro / Flash 两张模型卡；本次明确选择 Flash。
- 作品在 GUI 中可见、可编辑；存在未提交修改时，主按钮显示“保存编辑并保留”。
- 提交后生成不可变用户修订稿、反馈 receipt、事务 intent / recorded / committed 和 sealed attempt。
- 运行来源文件 SHA256 为 `be9b491a9da155bfad99a531bfaa1b9f8f12f1df7eba8e4b2b2cb827c077c89a`。
- 封存后创作系统共有 44 个文件，整树 SHA256 为 `366aa72cc26c258148d5014c093818ab3a1d4e981e685199c85e2ee0bec0f4c6`。
- 完整退出并启动新 Electron 进程后，整树、运行来源、修订稿和加密凭证文件哈希全部不变；界面恢复 Flash、修订稿、已保存版本和已封存决定。
- 重启只出现 Electron GPU、NetworkService 与 Renderer 进程，没有启动 DSH Worker；创作系统文件树没有任何写入，因此可以证明没有新的 DSH 创作 run 或作品版本。本次 GUI 重启没有绑定 Gateway request counter，不能仅凭这些现象证明所有网络请求为 0。

四个入口均按当前能力诚实展示：

| 入口 | 实际展示 |
|---|---|
| 创作 | 已封存修订稿，可开始另一项创作 |
| 它学到了什么 | 只说明反馈已保存；暂时观察 0、已采用原则 0 |
| 新方式 | 证据不足，无候选；采用、观察、拒绝按钮禁用 |
| 版本 | 当前为 bootstrap 方法；历史变化 0，无可回退版本 |

系统没有把一次反馈伪装成“已经学习”，也没有把第一次作品伪装成 RSI。

## 验收中发现并修复的问题

### 1. sandboxed Preload 白屏

第一次启动只显示空白页。Electron 报错表明 `sandbox=true` 的 Preload 被按受限 CommonJS 执行，而原构建产物是 ESM `index.js`，因此 `contextBridge` 从未生效。

修复：

- 保持 `sandbox=true / contextIsolation=true / nodeIntegration=false`；
- 用 esbuild 把 Preload 和共享 IPC 合并为单文件 CommonJS `index.cjs`；
- 构建时拒绝旧 `index.js`、符号链接、顶层 ESM import 和 `electron` 之外的运行时 require；
- 新增真实 hidden BrowserWindow smoke，验证凭证页可见、窄 IPC 往返、默认 Session 的 HTTP/HTTPS 请求为 0，以及 `window.require / process / ipcRenderer / studio` 均未暴露。

修复后 GUI 正常加载，并完成本报告中的真实 Flash 运行。

### 2. 反馈首次提交超时

首次点击“保存编辑并保留”时，应用 fail closed：界面没有宣称保存成功，也没有产生 feedback transaction。只读复核确认项目 mutation lock 无持有者，同一 payload 在项目副本中 0.31 秒通过。

根因是开发仓库位于 macOS 云同步目录，`python/creative_loop2rsi/__main__.py` 被卸载为 `compressed,dataless`；开发态 Controller 进程在进入 JSON handler 前即挂起。把该单文件按 Git HEAD 的完全相同 blob 重新物化后，exact `python -m creative_loop2rsi` probe 通过，GUI 重交同一编辑成功封存。

这不是反馈合同或治理锁缺陷。正式安装包计划使用 PyInstaller sidecar，因此不会依赖这条源码入口；但 packaged app 尚未运行验证，不能据此断言正式包已不受影响。源码开发路径仍应在启动前检测 `dataless`，并给出“把项目下载到本机或移到非云同步目录”的可行动提示。

## 隐私结果

本次结束后对 96 个隔离状态文件（约 1.8 MB）做 exact-value 扫描：

```text
Key plaintext matches: 0
raw reasoning_content fields: 0
session/checkpoint/transcript-like files: 0
current environment exact matches: 0
current process argv exact matches: 0
tracked repository Key matches: 0
untracked repository Key matches: 0
```

加密凭证文件权限为 `0600`。这不等于可以物理擦除 JavaScript 内存，也不改变 DSH 受信进程尚无 OS 级出网沙箱的事实。

## 状态边界

| 能力 | 本次状态 | 说明 |
|---|---|---|
| macOS arm64 源码 build 的 GUI Flash 首创作闭环 | operational PASS | 保持 `IMPLEMENTED`；不是独立执行、source-bound release 或真人验收 |
| Preload / Renderer / Main 窄 IPC | operational PASS | 真实 Electron smoke + Computer Use 路径通过 |
| GUI 编辑、反馈、封存与重启恢复 | operational PASS | 一次纯虚构任务通过；不证明长期稳定性 |
| Pro Chat | `UNVALIDATED` | 只在 `/models` 中发现，没有调用 Chat |
| Windows GUI 与安装包 | `UNVALIDATED` | 未生成或运行 EXE / portable ZIP |
| macOS 安装包 | `UNVALIDATED` | 本次从源码运行，不是 DMG / ZIP packaged app |
| 非程序员体验 | `UNVALIDATED` | Computer Use 不等于 5 名非程序员测试 |
| 文学质量 | `UNVALIDATED` | 没有独立 Judge 或真人审美评价 |
| 跨作品学习、候选、采用和回滚 | `PROPOSED` | 四个入口只有诚实空态，M4–M6 未升级 |

## 下一步

1. 建立 fresh-build manifest，把 HEAD、lockfile、实际工具链、Preload、Renderer、Main、DSH Profile 和 Controller sidecar 绑定到同一发布候选。
2. 在 macOS arm64 与 Windows x64 packaged app 中复跑无 Key preload smoke 和首次创作路径。
3. 单独调用一次 Pro；没有通过前保持 `UNVALIDATED`。
4. 进行 5 名非程序员安装与首创作测试，和本次 Computer Use 证据分开统计。
5. 之后再接跨作品 finding、候选三评估、用户采用和一键回滚；在那之前不宣称应用已实现 RSI 闭环。
