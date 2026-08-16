# Creative RSI Studio v1 产品合同

## 产品承诺

Creative RSI Studio 帮助普通用户建立某一创意写作方向的、可验证自我改进的个人系统。它不绑定某一部作品，也不把多次重写或多个 Agent 误称为 RSI。

首发流程固定为：

```text
输入 DeepSeek API Key
→ 选择 V4 Pro / V4 Flash
→ 回答“你想创作什么？”
→ 立即生成第一个作品
```

首次创作是 Bootstrap，不宣称已形成个人方法。应用从用户的明确编辑、保留、拒绝、重写和文字反馈中逐步获得证据。

## 信息架构

应用只保留四个主入口：

- **创作**：主题、对话、编辑器和作品版本；
- **它学到了什么**：暂时观察与已采用原则分开；
- **新方式**：候选对比、继续观察、拒绝或采用；
- **版本**：当前方法、历史晋升和回滚。

设置页只允许更换/删除 Key、选择模型、导出/删除系统和暂停学习。不得展示 Base URL、Token、Temperature、Thinking、Agent、Prompt、DAG、DSH 或插件配置。

v1 的隐藏模型策略固定为 `thinking=enabled`、`reasoning_effort=high` 和单次最多 `32,768` 个总输出 token。达到该上限属于 `OUTPUT_TRUNCATED`，不是可封存的完整作品，也不能因为已有部分正文而转成成功。

## 用户对象模型

```text
CreativeSystem（一种创作方向）
├── ConstitutionEpoch（明确采用的原则）
├── WorkRecord（一部作品或一次任务）
├── HumanFeedbackReceipt（绑定冻结作品的反馈）
├── Finding（结构化问题）
├── SystemCandidate（方法候选）
├── EvaluationBundle（目标 / 回归 / held-out）
└── Release（当前与历史方法版本）
```

单部作品的问题默认只影响该作品。只有至少三个独立作品或任务出现同类问题，才允许建立系统候选。

## 晋升语义

```text
真实作品
→ 明确反馈
→ 跨作品重复问题
→ 隔离候选
→ targeted / regression / held-out
→ 普通话对比
→ 用户点击“采用新方式”
→ 新 release
```

- 模型、`system_fingerprint` 或 governing input 变化时，评价不能复用；
- 缺失、重复、旧结果污染、硬退化或 held-out 变差都必须阻断；
- 用户点击是晋升的必要条件，但不是电子签名或现实身份认证；
- 回滚恢复上一稳定版本，不删除候选、评价或人工回执。

## 双层 v1

生产层只允许声明式、可验证的创作系统变化：Prompt、上下文、非权威记忆、Loop 图、owner、恢复、预算和受信 Profile 组合。

系统实验室可以表示 Judge、学习策略、DSH Profile、Controller、Gateway 和应用脚手架候选，但代码级候选只能生成 patch、测试计划和静态结果，固定为 `CANDIDATE_ONLY`。v1 不运行模型生成代码。

## 能力口径

| 标签 | 含义 |
|---|---|
| `IMPLEMENTED` | 有代码和自动测试，不代表创作质量得到证明 |
| `FORWARD-TESTED` | 无历史上下文的真实流程验证并保留证据 |
| `PROPOSED` | 只有方案或接口 |
| `UNVALIDATED` | 明确未验证，不能作自动决策 |

无签名 `studio-v1.0.0-alpha.1` 是技术预览；签名、公证、跨平台安装和非程序员验收完成前不得标记为 stable。

当前实现进度与未完成门禁见 [alpha.1 实施状态](260815-alpha1-implementation-status.md)。该状态文档是发布口径的一部分：没有被标为已实现的能力，不得根据页面占位、接口名称或测试替代物推断为可用。
