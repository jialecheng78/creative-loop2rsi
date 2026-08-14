# `@creative-loop2rsi/contracts`

Creative RSI Studio 的运行时无关公共合同。这个包只包含可序列化 TypeScript 类型、JSON Schema 和纯函数状态机，不依赖 Electron、DSH、Python 或第三方包。

## 边界

- 三条状态轴互相独立；执行 `PASS` 不代表质量或发布已通过。
- App 候选状态固定为 `DRAFT → CANDIDATE → EVALUATING → READY_FOR_HUMAN → PROMOTED / REJECTED / BLOCKED`。
- L4 候选严格按 `targeted → regression → heldout` 各运行一次；任一失败进入不可逆 `BLOCKED`，人工拒绝进入独立 `REJECTED`。
- L5 始终是 `experimental / unvalidated`，状态机拒绝晋升。
- Model Gateway 元数据不得包含 API Key、`reasoning_content` 或完整请求正文。
- JSON Schema 用于跨进程/落盘边界；TypeScript 类型用于编译期约束。

## 治理事实与应用 DTO

- Python Controller 的 snake_case 落盘记录是治理事实源；`InitialIntentReceipt`、`RuntimeProvenance`、`SystemCandidate`、`EvaluationBundle`、`PromotionRecord` 与 `RollbackRecord` 保持 snake_case 镜像或原样 passthrough。
- Schema version 按记录族区分：App records（含 `InitialIntentReceipt`）使用 `1.0`；legacy `LearningProposal / PromotionRecord / RollbackRecord` 使用 `0.1`。
- `CreativeSystemAppViewModel` 与 `CandidateProposalAppViewModel` 仅供 App/IPC 展示和编辑，不能作为晋升证据。
- `ControllerResponse` 只属于 app-service/bridge 单 JSON 协议，不改变旧 `loopctl` stdout。
- `parsePythonGovernanceDocument` 明确拒绝把 camelCase App DTO 当作治理证据。

## 测试

```bash
npm run typecheck
npm test
npm run build
```
