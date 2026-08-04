# creative-loop2rsi 协作规范

## 项目目标

构建一套面向 Codex 的开源 Builder Skill，帮助非程序员从创作立宪开始，逐步搭建单 Loop、有状态 Loop、嵌套多 Loop和可验证自我改进系统。

## 公开边界

- 本仓库采用洁净室实现，不读取、复制或改写任何私有管线的 Prompt、Schema、脚本、样本、运行结果或内部术语。
- 示例必须为纯虚构内容，不使用真实未发表作品、客户材料、公司名称、内部域名、模型渠道、账号、密钥或本机绝对路径。
- v0.1 不接入模型 API、网络服务、遥测、云服务、自动训练或自动发布。
- L0–L4 是实现目标；L5 必须标记为 `experimental / unvalidated`，且任何 L5 候选都不得自动晋升。

## 目录约定

- `skills/creative-loop2rsi/`：Skill 主体；`SKILL.md` 只保留主流程和引用导航，不放仓库安装或贡献说明。
- `skills/creative-loop2rsi/references/`：成熟度、合同、恢复、评价与 RSI 实验说明。
- `skills/creative-loop2rsi/scripts/`：Python 3.9+ 标准库运行工具。
- `skills/creative-loop2rsi/assets/`：starter project 与纯虚构示例。
- `tests/`：不访问网络的自动测试。
- `tools/`：公开树审计等仓库维护工具。
- 用户生成内容、运行轨迹和未发表素材默认不入库。

## 实现规则

- 先修改规范或公共合同，再修改相应实现。
- Python 只使用标准库，兼容 Python 3.9+，不读取环境中的模型密钥。
- 所有文件写入采用同目录临时文件加原子替换；初始化非空目录时拒绝覆盖。
- 已封存 attempt 不得修改；候选不得修改创作宪法、原始素材、held-out 答案、许可证、晋升政策或人工审批边界。
- Producer 与 Judge 分离；机器不得替用户决定核心审美，无法判断时返回 `NEEDS_TASTE`。
- 硬合同、软质量和人类立宪三类判断必须分开；结构 `PASS` 不得被描述为创作质量已通过。
- Git commit message 使用中文；未经用户明确要求，不执行 `git push` 或公开发布。

## 验证要求

变更后至少运行：

```bash
python3 -m unittest discover -s tests -v
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/creative-loop2rsi
python3 tools/audit_public_tree.py .
```

所有由 `loopctl.py init` 生成的领域 Skill 也必须通过官方 `quick_validate.py`。若缺少真实非程序员测试、外部元评估或 live forward test，必须在 README 与交付说明中标为未验证，不得用自动测试替代。
