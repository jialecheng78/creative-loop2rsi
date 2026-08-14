# 隐私说明

`Creative RSI Studio` 是本地优先的桌面应用。它不要求注册应用账户，不接入遥测、广告、云同步或后台分析服务。

## 会离开本机的数据

只有在用户主动发起创作、评价或候选生成时，Main 进程中的 Model Gateway 才会把完成该任务所需的文本发送到 DeepSeek 官方 API：

- API 地址固定为 `https://api.deepseek.com`；
- 只使用 `/models` 与 `/chat/completions`；
- 不发送自定义 `user_id`；
- 不把 API Key、完整本机路径、应用日志或无关作品自动加入请求；
- 应用关闭后不继续调用模型。

DeepSeek 如何处理 API 请求由其公开政策和用户与 DeepSeek 之间的关系决定。本项目不能替 DeepSeek 作隐私保证。

## 保留在本机的数据

- 创作系统、作品、反馈、finding、候选、评价、晋升和回滚证据；
- 应用、Controller、DSH、Profile、模型和 `system_fingerprint` 等运行来源信息；
- 经操作系统安全存储加密后的 API Key 密文。

模型的 `reasoning_content` 只在需要完成当前工具调用回合时暂存在内存，回合封存后不写入作品、证据或导出包。

## API Key

- Key 只由 Electron Main 进程读取；
- Renderer、Preload 业务接口、DSH Worker、Python Controller 和候选都拿不到明文 Key；
- Key 不进入环境变量、命令行、日志、崩溃报告、Session、Git 或导出包；
- 删除 Key 会删除本地密文，但不会删除用户在 DeepSeek 平台创建的 Key；如怀疑泄露，仍应在 DeepSeek 平台撤销并轮换。

## 导出和删除

用户可以显式导出某个创作系统。导出前必须展示文件清单，并永远排除 API Key、内部日志、模型推理内容和 held-out 答案。

删除创作系统属于破坏性操作，应用必须列出目标并二次确认。删除本地数据不能撤回已经发送给第三方 API 的请求。

## 系统实验室

脚手架与代码级候选只生成可审查的 patch、测试计划和静态结果。v1 不执行模型生成的任意代码，也不自动上传候选或用户作品。
