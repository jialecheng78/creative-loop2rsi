# @creative-loop2rsi/controller-bridge

这是 Electron Main 到 Python Controller app-service sidecar 的结构化进程桥。它只接受固定白名单内的 app operation，把带固定 `protocol_version` 的单个 JSON request 写入 stdin，并把唯一 stdout JSON response 返回给调用方。旧 `loopctl` CLI 继续由 Python 自身兼容，不属于这个协议。

安全边界：

- sidecar 可执行文件、固定参数和工作目录只能由 Main 的安装配置提供，不能来自 Renderer；
- 使用固定参数数组和 `shell: false`，不拼接命令字符串；
- 只允许与 Python app-service 一致的固定 operation；其中 `resume_feedback` 只能提交受信项目路径与 `run_id`，不能从 Renderer 重传反馈或编辑原文；
- `complete_work` 只接受固定 Studio 模型策略的结构化 runtime provenance；`reasoning_content` 与凭据字段不得进入 Controller 证据层；
- request ID、operation、protocol version 和 response envelope 必须精确对应；
- 子进程只继承固定的编码、区域、时区和临时目录环境，不继承 Key、token 或其他凭证环境变量；
- stderr 不进入返回值，stdout 必须是单个、完整的 JSON 对象；
- 超时、取消、输出上限和协议错误都 fail closed；
- `ControllerRequest` 没有 Key 字段，运行时也会拒绝凭证形状的额外字段。

开发环境可以把 `file` 指向绝对 Python 路径，并用可信的 `fixedArguments` 启动 `creative_loop2rsi` module。发行包应直接指向 PyInstaller `--onedir` 中的 sidecar 可执行文件，终端用户无需安装 Python。
