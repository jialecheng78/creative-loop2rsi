# Creative RSI Studio 无开发者身份签名的技术预览安装说明

`v1.0.0-alpha.1` 是面向 **macOS 13+ / Apple Silicon arm64** 的技术预览，不是稳定版。它没有 Apple Developer ID 签名，也没有经过 Apple 公证，因此首次打开会触发 Gatekeeper 警告。App 内含匿名 ad-hoc seal，只用于验证 bundle 内部一致性，不提供发布者身份或公证。

只有 GitHub Pre-release 页面同时提供以下三个附件时，才表示该版本已有公开下载；仓库中的版本号或本文本身不代表 Release 已经发布：

- `Creative-RSI-Studio-1.0.0-alpha.1-macos-arm64.zip`
- `SHA256SUMS.txt`
- `Creative-RSI-Studio-1.0.0-alpha.1-evidence.zip`

## 安装

1. 只从本仓库的 GitHub Pre-release 下载 macOS arm64 ZIP 和 `SHA256SUMS.txt`。
2. 核对主 ZIP 的 SHA256 与 `SHA256SUMS.txt` 完全一致；文件名、大小或哈希不一致时停止安装。
3. 双击 ZIP 解压，把 `Creative RSI Studio.app` 拖入“应用程序”。
4. 首次打开时，对该 App 按住 Control 点击并选择“打开”。如果系统仍然拦截，进入“系统设置 → 隐私与安全”，只对刚下载的 Creative RSI Studio 选择“仍要打开”。
5. App 不应要求关闭 Gatekeeper、执行 `xattr`、安装根证书、输入管理员密码或授予相机、麦克风、蓝牙等无关权限。出现这些要求，或系统提示“应用已损坏”时，停止使用并按 [SECURITY.md](../../SECURITY.md) 私下报告。

## 首次使用

- 用户需要自备 DeepSeek 官方 API Key 和可用额度；应用不赠送或代管模型额度。
- 当前只推荐已完成实网验收的 V4 Flash。V4 Pro 仍可见，但 `alpha.1` 尚未完成 Pro Chat 验收。**已知限制：当前选择页仍会预选并标注 Pro 为“推荐”；请在继续创作前主动改选 V4 Flash。**
- 每次创作通常会发起一次 Chat 请求；网络失败后的受控重试也可能产生调用和费用。
- 编辑正文、保存普通反馈、保留或拒绝作品、盲比选择、采用和回滚都在本地完成，不调用模型。
- 正常无重试的“准备新方式”会发起五次 Chat 请求：一次 Builder 请求，以及 targeted candidate、regression candidate、held-out baseline、held-out candidate 四份盲比内容生成。
- 候选不会自动采用。只有用户完成三组盲比并明确点击采用，active method 才会改变；用户仍可回滚。

## 数据与隐私

- 创作所需文本会发送到 DeepSeek 官方 API；应用不接入遥测、广告、云同步或后台生成。
- 用户输入 API Key 时，它会在密码输入页的 Renderer 内存中短暂停留，提交后立即清空；后续存储和读取只由桌面 Main 进程管理，不向 Renderer 回读，也不记录。系统安全存储可用时加密持久保存；不可用时只能由用户明确选择“仅本次打开有效”，完全退出应用（⌘Q）后失效。只关闭窗口不等于退出。
- 作品、反馈、finding、候选、评价、采用与回滚证据保存在本机。模型的原始推理内容不写入这些证据。
- 当前 alpha 的受信 DSH 子进程尚无 OS 级强制出网沙箱；受信 Profile 的工具限制不是物理网络隔离。
- 完整边界见 [PRIVACY.md](../../PRIVACY.md)。

## 卸载

卸载前先以 ⌘Q 完全退出 Creative RSI Studio。把 `Creative RSI Studio.app` 移到废纸篓只会删除应用本体，不会自动删除本地作品、反馈、证据或已加密凭证。

如需同时清除本地数据，请先备份需要保留的作品，然后在 Finder 选择“前往 → 前往文件夹”，打开 `~/Library/Application Support/Creative RSI Studio/`，确认目标无误后再移到废纸篓。这个操作不可恢复；删除本机数据也不能撤回已经发送给 DeepSeek 的请求。

## 当前不支持

- Windows 与 Intel Mac；
- DMG 或系统安装器；
- Apple Developer ID 签名与公证；
- 自动更新或后台检查更新；
- 无 Gatekeeper 警告安装。

新版本需要重新从 GitHub Release 下载。公开后不会替换同一版本的附件；任何修复都会使用新的版本号。
