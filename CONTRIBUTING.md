# 贡献指南

感谢你帮助改进 `creative-loop2rsi`。本项目采用 Apache-2.0 和 Developer Certificate of Origin（DCO），不要求签署 CLA。

## 先确认贡献边界

可以贡献：

- 通用的创意写作 Loop 合同、恢复策略、评价方法和安全门；
- Python 3.9+ 标准库实现、测试、文档和纯虚构示例；
- Electron 应用、无障碍、中文交互、运行时 Adapter 和不访问真实 API 的测试；
- 能帮助非程序员减少输入和理解成本的交互改进。

不要贡献：

- 公司内部 Prompt、Schema、脚本、域名、模型渠道、运行结果或术语；
- 客户资料、未发表作品、真实账号、密钥、token、`.env` 或带隐私的截图；
- 通过复制私有项目再删减得到的内容；
- 绕过 Model Gateway、自定义模型地址、遥测、云同步或在 CI 中使用真实 API Key 的变更；
- 让 Renderer 回读或持久化 Key，或让 DSH Worker、Controller、候选直接读取 Key 的变更；
- 执行模型生成的任意代码、Shell 或动态插件的变更；
- 自动改写创作宪法、自动晋升 L5 候选或绕过人工审批的能力。

不确定材料是否有权公开时，请不要提交。用最小、纯虚构的例子复现问题。

## 开发流程

1. 先阅读根目录 `AGENTS.md` 和相关 Skill 引用文档。
2. 先更新公共合同或规范，再修改实现。
3. 一个 Pull Request 只解决一个可说明的问题，并写清对使用者的影响。
4. 新行为必须有失败用例和成功用例；修复不能靠删除安全门。
5. 不提交生成作品、运行轨迹、缓存、大文件或二进制文件。

本项目不要求特定分支名。Commit message 应简洁说明变更意图。

## 本地验证

```bash
python3 -B -m unittest discover -s tests -v
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/creative-loop2rsi
pnpm install --frozen-lockfile
pnpm run check
python3 tools/audit_public_tree.py . --mode full
python3 tools/check_dco.py . --range HEAD
python3 tools/audit_release_archive.py . --treeish HEAD
```

如果修改了生成器，还要初始化一个临时项目，并对生成出的领域 Skill 再运行官方 `quick_validate.py`。Pull Request 不得通过降低阈值、跳过测试或放宽受保护表面来获得通过。

## DCO 签署

每个 commit 都必须包含 `Signed-off-by`，表示你有权按本项目许可证提交该贡献，并同意 [Developer Certificate of Origin 1.1](https://developercertificate.org/)。

使用 Git 自动添加：

```bash
git commit -s -m "说明变更意图"
```

生成的尾注形式如下：

```text
Signed-off-by: Your Name <your.email@example.com>
```

这不是 CLA。项目不会要求你转让版权。

CI 会检查所选提交范围内每个 commit 至少有一条与 author 姓名和邮箱匹配的 `Signed-off-by`。托管仓库还必须启用 GitHub 的 `web_commit_signoff_required`，避免 squash 或 merge 在检查通过后新造未签署 commit；合并前应将 `DCO`、`policy`、`gitleaks-history`、`archive-audit` 和测试矩阵设为 required checks。

## 提交说明至少包含

- 要解决的用户问题；
- 为什么选择这个方案；
- 对已有项目、受保护表面和兼容性的影响；
- 运行过的测试及结果；
- 若涉及主观评价，哪些结论来自人、哪些来自规则或数据。

安全漏洞不要提交公开 issue，请按 [SECURITY.md](SECURITY.md) 报告。
