# 最小可验证自我改进 Computer Use 验收报告

> 状态：`STOPPED / MAX_PROGRAM_ITERATIONS_REACHED`
>
> 本文只记录已经发生且有证据支持的事实。五次程序迭代用尽后，本轮完成 1 个作品和 1 份反馈，未完成三个独立作品、候选评价、人工采用、第四个作品和回滚，因此结论是“最小 RSI 未跑通”。
>
> 版本说明：本文的模型结果属于历史 `max_tokens=16,384` epoch。当前实现已固定为 `32,768`，尚待新的实网复验；旧作品和 finding 保留为历史证据，但不能让新 epoch 的候选提前 ready。

## 一、验收目标与成功条件

本轮由一个没有源码、终端和历史实现上下文的 simulated-user task，通过 Computer Use 操作打包后的 macOS 应用。它不是身份认证过的真人，也不代表非程序员可用性测试。

固定验收路径：

1. 在同一创作系统中完成三个独立作品；
2. 对三个作品提交完全相同的明确反馈；
3. 系统只能在三个独立作品形成重复证据后建立方法候选；
4. 候选必须分别完成 targeted、regression、held-out 三类评价；
5. 用户只能在看到作品对比和代价说明后主动采用候选；
6. 第四个作品必须绑定新方法版本；
7. 一键回滚后恢复旧稳定版本，且历史证据仍保留。

固定反馈为：

> 开头进入冲突太慢；请在前两句建立异常和明确风险，同时保留结尾反转。

只有以上七项全部成立，才能把本轮称为“最小可验证自我改进闭环”。它仍不等于模型权重自改、完整自主 RSI 或仓库 L4 的正式验收。

## 二、测试身份与安全边界

- 操作者：独立 simulated-user task；公开报告不保存可导航的内部 task 标识。
- 操作方式：只允许 Computer Use；不读取源码、终端、API Key 或本地运行文件。
- 模型：`deepseek-v4-flash`。
- Key：只从既有安全存储读取；本轮修复、打包和离线 smoke 均未重新读取或输出 Key。
- 作品：只记录 ID、字节数、哈希和状态，不在报告中保存未发表正文。
- 程序迭代上限：5 次；当前已使用 5 次，不再保留程序修复额度。
- 断点原则：修复后从同一创作系统和已保存治理状态继续，不为凑证据重置系统。

## 三、首次运行与保留断点

simulated-user 首次输入固定创作方向并点击“开始创作”后，应用显示：

> 本次创作没有开始。操作没有完成，也没有改动已保存内容。请重试；若仍失败，请重启应用。

Controller 已建立但没有完成的治理记录：

| 证据 | 值 |
|---|---|
| run | `run-185c500a-3e0f-4f4d-9904-034d2da994d9` |
| work | `work-82c0a6be-c66e-442c-86ad-6d307dd3a32a` |
| attempt | `attempt-001` |
| execution | `RUNNING` |
| requested model | `deepseek-v4-flash` |
| Gateway requests | `0` |

这一组证据证明故障发生在模型请求之前；它不能被计为作品、反馈或候选证据。应用重启后明确展示“上次运行中断，本次会重新生成并保留关联，不会续写未完成模型推理”，没有把重新生成伪装成推理续跑。

## 四、程序迭代记录

### 第 1/5 次：补全打包应用中的 DSH 运行依赖

**现象**

- 源码与开发态测试通过；
- packaged smoke 只验证无模型启动；
- 真实点击创作时，Gateway request ledger 仍为 0。

**根因**

legacy `pnpm deploy` 在桌面应用中保留了 `runtime-dsh`，但遗漏其直接 `@deepseek-ai/*` 依赖链接。Main 在解析 SDK client 和 JSON-RPC runtime 时就失败，模型请求尚未创建。

**修复**

- 从受信的 `runtime-dsh/package.json` 读取允许列表；
- 只恢复 `@deepseek-ai/*` 声明依赖；
- 要求依赖版本精确匹配；
- 打包结束前真实执行 `require.resolve`；
- 将 `UNSUPPORTED_DSH` 映射成固定、可行动的中文错误。

**提交**

`9126674 补全预览包 DSH 运行依赖`

**结果**

聚焦单测通过，但真实打包暴露了新的 peer-context 路径假设，未产生可运行预览包。

### 第 2/5 次：去掉 pnpm 虚拟存储目录名假设

**现象**

新打包在恢复 DSH 包时返回 `ENOENT`。工作区和 deploy 目录安装的是同一版本，但虚拟存储目录的 peer suffix 不同。

**根因**

实现把工作区 `.pnpm` 下的相对路径直接映射到 deploy `.pnpm`。pnpm 的 peer-context hash 不是跨部署稳定公共合同。

**修复**

- 不再复制虚拟存储目录名；
- 在 deploy 虚拟存储中按 package `name + version` 查找；
- 只接受唯一匹配；
- 新增“工作区和部署 peer suffix 不同”的回归用例。

**提交**

`35802ad 修复预览包依赖解析`

**结果**

聚焦单测通过；真实打包继续发现 `.pnpm` 根目录同时包含文件和目录。

### 第 3/5 次：过滤 pnpm 元数据文件

**现象**

依赖扫描将 `.pnpm/lock.yaml` 当成包目录，触发 `ENOTDIR`。

**根因**

扫描器没有先验证虚拟存储 entry 是常规目录。

**修复**

- 只遍历常规目录；
- 拒绝 symlink entry；
- 在合成 fixture 中加入 `lock.yaml`，防止同类回归。

**提交**

`0ad697a 过滤预览依赖元数据文件`

**结果**

真实打包、应用 smoke 和包内 DSH 解析全部通过。

### 第 4/5 次：修复 DSH 的传递 peer 依赖闭包

**现象**

第 3 次打包能从 `runtime-dsh` 解析 SDK client 和 JSON-RPC bin，但 simulated-user 再次点击创作后仍立即失败。新 run 的 Gateway ledger 仍为 0，Controller 将原因记为 `runtime-launch-failed-before-output`。

**根因**

前一轮只证明两个入口文件可解析，没有启动 Cordis plugin tree。legacy deploy 遗漏了更深层 peer 链接，例如 `dsh-app-boot → cordis-plugin-group`。因此“入口存在”是假阴性门，不能证明 DSH 能初始化。

**结果**

这一轮完成了根因定位并将门禁提升为真实 initialize→shutdown；修复实现进入第 5 次迭代。

### 第 5/5 次：复制可达依赖图与受控 hoist 视图

**修复**

- 以 fresh、frozen-lockfile 安装结果作为运行拓扑事实源；
- 从 Desktop 和三个 workspace package 的生产依赖出发，沿 pnpm symlink 构建可达闭包；
- 只复制闭包中的虚拟存储 entry，不复制全部开发依赖；
- 物化三个 workspace runtime package，并重建其直接依赖链接；
- 只复制闭包内的 pnpm hoist 链接，供 Cordis 按 Profile 名称解析插件；
- 所有链接必须留在部署树内；
- 打包过程中强制运行无 Key、无模型请求的 DSH initialize→shutdown probe。

**已取得的修复前置证据**

- 合成 peer-context/hoist fixture：`PASS`；
- 当前真实安装图闭包：540 个 entry；
- 真实 JSON-RPC runtime initialize→shutdown：`PASS`；
- Desktop：16 files / 103 tests `PASS`；
- TypeScript typecheck：`PASS`。

**状态**

代码进入最后一次迭代后，source-bound sidecar、标准应用包、打包 smoke 和包内 DSH initialize→shutdown 均通过。最终包绑定 source commit `db24d7ed162db3d829fc99cd40bdc77c39c9b977`，simulated-user 随后成功完成作品 1，但作品 2 连续三次触发 Gateway timeout。本轮依约停止，没有进行第 6 次修复。

## 五、最终打包证据

| 项目 | 证据 |
|---|---|
| source commit | `db24d7ed162db3d829fc99cd40bdc77c39c9b977` |
| package tree SHA256 | `b86b875b1aac6f734fb393dc7bc880208451bfb4c1e7c651b14deff682d6cb5d` |
| manifest entries | `35,979` |
| app version | `1.0.0-alpha.1` |
| packaged smoke | `PASS` |
| preload API | status/configure/start/feedback 均可用 |
| Renderer Node globals | 不可见 |
| smoke model requests | `0`，离线 smoke 没有冒充实网调用 |
| DSH SDK client | 从 app bundle 内解析成功 |
| DSH JSON-RPC bin | 从 app bundle 内解析成功 |
| DSH plugin tree | 无 Key initialize→shutdown `PASS` |

Controller sidecar 已为同一 source commit 重建。旧 sidecar 和旧预览包只做可恢复归档，没有覆盖用户数据。

## 六、最终 simulated-user 结果

### 作品 1：成功并形成第一份真实 finding

| 证据 | 值 |
|---|---|
| run | `run-593326da-b7d9-4fd5-b929-2e9dadb75241` |
| work | `work-31802337-2a07-4a69-9a33-6dae1c7ebeeb` |
| attempt | `attempt-001`，已封存 |
| requested / returned model | `deepseek-v4-flash` / `deepseek-v4-flash` |
| system fingerprint | `a26a7955944dc5c60445bff77fac9c8e` |
| requests | 1 completed / 0 failed |
| usage | prompt 208 / completion 13,329 / total 13,537 |
| response ID SHA256 | `b6da820ce8f4d035722b2624685058cd11de2e123d0a4e458c1ea4e395850aef` |
| artifact | 1,782 bytes；SHA256 `f971d4cd60235e8e0a46b5e633090c6e760112ce26371606a0406ce4369fd146` |
| execution / quality | `PASS / WARN` |
| human decision | `BLOCK / revise`，没有伪装成机器质量 PASS |

simulated-user 逐字提交固定反馈：

> 开头进入冲突太慢；请在前两句建立异常和明确风险，同时保留结尾反转。

系统生成 `APP-FEEDBACK-79C72D29335B`，`normalized_feedback_sha256=79c72d29335beaec7fd3ab6f1e7d025ac03cd7bf51b935b171707a52559cceba`，并明确标记 `direct-user-feedback`。由于操作者是 simulated-user，Controller 诚实记录 `human_identity_verified=false`。

### 作品 2：三次 120 秒超时，未形成作品证据

| 证据 | 值 |
|---|---|
| run | `run-bd95d8d8-6499-4fb7-93f9-c67361149d91` |
| work | `work-89b8c69e-ff2f-4dca-8229-e3b036702040` |
| requested model | `deepseek-v4-flash` |
| Gateway requests | 3 failed / 0 completed |
| 每次持续时间 | 约 120 秒 |
| error | `DEEPSEEK_TIMEOUT` / HTTP 504 |
| fingerprint | 三次均为 `a26a7955944dc5c60445bff77fac9c8e` |
| response ID SHA256 | `5de38e…a0e8` / `51bc51…cd6d` / `41f9e2…0f32` |
| artifact files | 0 |
| Controller stall | `runtime-failed-before-commit` |

应用没有把部分流保存成完成作品，也没有把失败的作品 2 计为第二份独立证据。界面最终显示“本次创作没有完成”，simulated-user 依约停止，未点击重试。

### 保留状态

以下状态仍被保留：

- DeepSeek credential 已配置；
- 当前选择 `V4 Flash`；
- 原创作系统仍是 active system；
- 作品 1、封存 manifest、反馈 receipt 和 finding；
- 作品 2 的三次脱敏请求 ledger 与 zero-file stall；
- active method 仍为 `baseline-v1`；
- `candidates/` 和 `releases/` 只有占位文件，没有候选、晋升或回滚记录。

## 七、最终根因分析

### 直接阻断

作品 2 的三个请求都被 Studio Gateway 在 120 秒整附近终止。DeepSeek 已返回目标模型、fingerprint 和 response ID，说明 Key、路由、模型选择和网络连接均生效；但没有一条请求在 120 秒内完成，因此 DSH 最终返回失败。

作品 1 的成功请求耗时约 114 秒，距离 120 秒硬上限只有约 6 秒。这说明本报告当时的历史 `thinking=enabled + reasoning_effort=high + max_tokens=16384` epoch 与固定 120 秒总时限组合过于脆弱：同类短作品只要推理稍慢，就会被当作传输失败。

### 为什么三次重试没有解决

DSH 对 timeout 自动重试两次，加上初始请求共三次。三次都使用相同模型和同一 120 秒总时限，所以重试没有改变失败条件，只把等待时间和潜在费用放大到约 361 秒。

### 治理层仍暴露的问题

- Controller 正确保留 zero-file stall 和失败 request ledger；
- 但失败 run/attempt 仍显示 `RUNNING`、dispatch 仍为 `OPEN`，终态没有收敛为明确的 `BLOCK/INTERRUPTED`；
- UI 只显示通用失败文案，没有告诉普通用户这是超时、已经尝试三次以及下一步如何降低任务规模；
- retry 期间没有进度提示，用户只能看到持续生成。

### 不是根因的项目

- 不是 API Key 无效；作品 1 已真实完成；
- 不是模型选错；requested/returned 都是 Flash；
- 不是 DSH 包缺失；最终包已真实初始化 plugin tree；
- 不是 ScreenCaptureKit 临时错误；捕捉恢复后应用仍持续运行，最终失败来自应用自身的 timeout 证据；
- 不是候选或 RSI 逻辑错误；流程尚未走到候选形成阶段。

## 八、最终判断

| 判断 | 状态 | 说明 |
|---|---|---|
| 标准 macOS 预览包可启动 | `PASS` | packaged smoke 证明 |
| 包内 DSH Runtime 可解析 | `PASS` | 从 app bundle 真实 resolve |
| Flash 真实创作 | `PARTIAL PASS`（历史 16,384 epoch） | 作品 1 成功，作品 2 三次超时；不能外推为当前 32,768 策略已通过 |
| 三个独立作品 | `BLOCK` | 1/3 |
| 三份相同反馈 | `BLOCK` | 1/3 |
| 候选 exact-three 评价 | `NOT_STARTED` | 无候选 |
| 人工采用与第四个作品 | `NOT_STARTED` | 无晋升 |
| 回滚 | `NOT_STARTED` | 无可回滚晋升 |
| 最小自我改进闭环 | `FAIL / NOT_PROVEN` | 五次程序迭代已用尽，必须停止 |

## 九、下一轮计划

本轮不再修改程序。下一轮应重新建立独立的迭代预算，并按以下顺序处理：

1. 将模型超时拆成“首事件等待、流空闲、绝对总时限”三种，不再用 120 秒总时限截断仍有进展的 thinking stream；
2. 给前台创作配置更合理的总时限，并把 timeout/retry 次数与费用风险展示给用户；
3. 后续实现已选择继续使用 Flash `high` effort，并把固定总输出上限提高到 `32,768`；本报告不包含该新策略的实网 PASS，Builder、关键盲评与日常创作仍不得在后台偷偷换模型；
4. 只对真正的传输失败重试；一旦收到有效模型身份/流进展，优先恢复或给出可行动提示，避免三个完全相同的长请求；
5. 让失败 run/attempt/dispatch 原子收敛为 `BLOCK/INTERRUPTED`，不保留 `RUNNING/OPEN` 假象；
6. 为“作品 1 已封存、作品 2 超时”建立重启恢复回归测试；
7. 下一轮保留作品 1 和 finding 作为历史 `16,384` epoch 证据，不重新生成或重复计数；由于输出策略已变化，`32,768` 新 epoch 必须独立重新积累三个作品后才可形成候选；
8. 完成作品 2、作品 3 后，再检查候选 exact-three、采用、作品 4 和回滚。

## 十、尚不能外推的能力

未来某轮即使通过，也只能证明：macOS arm64 unsigned preview 在一个独立 simulated-user 场景中跑通最小应用级自我改进闭环。它不能证明：

- 真实非程序员可用性；
- Windows、Intel Mac 或已签名安装包；
- V4 Pro；
- 模型权重自改；
- L5 自主系统脚手架晋升；
- 文学质量普遍提升；
- 完整自主 RSI。
