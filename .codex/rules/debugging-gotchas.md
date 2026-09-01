# Debugging gotchas

- Windows Docker Desktop 的陈旧 AF_UNIX socket 会表现为 backend 初始化崩溃；先核验日志与精确 runtime 目录，再采用可恢复的目录改名隔离，禁止 factory reset。
- pnpm 跨盘临时 checkout 必须显式传源仓库 store root；Windows 经 `cmd.exe` 时动态参数必须拒绝命令元字符。
- 证据文档若在最终 source digest 后回填会改变被验输入；最终运行证据应写入 runner 已排除的控制面 sidecar。
- 机器输出标记既不能按原始字节精确匹配（ANSI/空格会假阴性），也不能全文 `includes`（嵌入文本/数字前缀会假阳性）；先按 CRLF/LF/CR/VT/FF/NEL/LS/PS 分行，再只归一化横向空格并校验边界。
