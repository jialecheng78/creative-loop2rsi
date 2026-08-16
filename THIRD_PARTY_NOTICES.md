# Third-Party Notices

Creative RSI Studio 自有代码按根目录 [LICENSE](LICENSE) 中的 Apache-2.0 发布。安装包还会分发第三方依赖；可复核的分发组件清单由最终 App 的实际物理闭包与 Release SBOM 共同确定，workspace 或 lockfile 不能替代最终分发树证据。

## DeepSeek Harness

- Package family: `@deepseek-ai/dsh*`
- Runtime baseline: `0.1.0-rc.6`，以 `pnpm-lock.yaml` 中的 registry integrity 为准
- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- License: MIT
- Copyright: `Copyright (c) 2026 DeepSeek`

完整许可证见 [third_party/licenses/deepseek-harness-MIT.txt](third_party/licenses/deepseek-harness-MIT.txt)。

本项目不是 DeepSeek 官方产品，也不暗示 DeepSeek 对本项目提供背书、审核或质量保证。

## Release requirement

每次预览或正式发布必须从最终 App 的实际 package roots、Electron runtime 与 Controller sidecar 生成组件清单和 SBOM，并复核安装包已携带的许可证与上游许可声明。`@img/sharp-libvips-darwin-arm64` 作为 aggregate 绑定其 `README.md` 的 29 条许可声明和 `versions.json` 的 28 个版本键；其中 `libnsgif` 只出现在 README，上游未在该 `versions.json` 声明版本。这只证明原包中的版本与上游声明，不代表 alpha 已提供每个内嵌库的完整许可证文本。该 component-level license completeness 为 alpha 已知非阻断缺口。本文不是传递依赖的静态穷举，不能替代 Release 产物审计。
