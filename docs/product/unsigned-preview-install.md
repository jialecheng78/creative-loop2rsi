# 无签名技术预览安装说明（发布前草案）

当前仓库尚未生成或发布 DMG、EXE、portable ZIP，也没有 `studio-v1.0.0-alpha.1` GitHub Release。以下步骤只定义未来无签名预览包必须采用的图形化说明，不能据此声称已经有可安装版本。

`studio-v1.0.0-alpha.*` 是无签名技术预览，不是稳定版。请只从本仓库的 GitHub Release 下载，并先核对 Release 页面公布的 SHA256。

## macOS 13+ Apple Silicon

1. 下载标记为 `macOS-arm64` 的 `.dmg`；
2. 核对 SHA256 后，把应用拖入“应用程序”；
3. 首次打开若被 Gatekeeper 拦截，进入“系统设置 → 隐私与安全”，只对刚下载的 Creative RSI Studio 选择“仍要打开”；
4. 不要使用要求关闭 Gatekeeper、执行终端命令或安装根证书的第三方教程。

## Windows 10/11 x64

1. 下载标记为 `Windows-x64` 的 `.exe`；
2. 核对 SHA256；
3. SmartScreen 出现时，确认文件来源和哈希无误后选择“更多信息 → 仍要运行”；
4. 安装器不应要求关闭杀毒软件、导入证书或以脚本绕过系统安全设置。

## 预览边界

- 发布者身份尚未经过 Apple Developer ID 或 Windows Authenticode 验证；
- 应用不会后台静默更新；“检查更新”只打开公开 Release 页面；
- 如果实际文件名、哈希、平台或权限请求与 Release 说明不一致，请停止安装并提交安全报告；
- 稳定版必须完成签名、公证和无系统警告的真人安装验收。
