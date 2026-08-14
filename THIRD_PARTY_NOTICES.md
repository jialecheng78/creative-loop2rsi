# Third-Party Notices

Creative RSI Studio 自有代码按根目录 [LICENSE](LICENSE) 中的 Apache-2.0 发布。安装包还会分发第三方依赖；完整传递依赖清单由锁文件和 Release SBOM 共同确定。

## DeepSeek Harness

- Package family: `@deepseek-ai/dsh*`
- Runtime baseline: `0.1.0-rc.6`，以 `pnpm-lock.yaml` 中的 registry integrity 为准
- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- License: MIT
- Copyright: `Copyright (c) 2026 DeepSeek`

完整许可证见 [third_party/licenses/deepseek-harness-MIT.txt](third_party/licenses/deepseek-harness-MIT.txt)。

本项目不是 DeepSeek 官方产品，也不暗示 DeepSeek 对本项目提供背书、审核或质量保证。

## Release requirement

每次预览或正式发布必须从实际 lockfile 生成依赖清单与 SBOM，复核安装包内所有许可证。本文不是传递依赖的静态穷举，不能替代 Release 产物审计。
