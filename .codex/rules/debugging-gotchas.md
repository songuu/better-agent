# Debugging gotchas

- Windows Docker Desktop 的陈旧 AF_UNIX socket 会表现为 backend 初始化崩溃；先核验日志与精确 runtime 目录，再采用可恢复的目录改名隔离，禁止 factory reset。
- pnpm 跨盘临时 checkout 必须显式传源仓库 store root；Windows 经 `cmd.exe` 时动态参数必须拒绝命令元字符。
- 证据文档若在最终 source digest 后回填会改变被验输入；最终运行证据应写入 runner 已排除的控制面 sidecar。
- 机器输出标记既不能按原始字节精确匹配（ANSI/空格会假阴性），也不能全文 `includes`（嵌入文本/数字前缀会假阳性）；先按 CRLF/LF/CR/VT/FF/NEL/LS/PS 分行，再只归一化横向空格并校验边界。
- Node 子进程提前关闭 stdin 时，`child.on('error')` 不能捕获流上的 EPIPE/EOF；单独监听 stdin error，等待 close 保留退出码和 stderr，零退出但输入写入失败仍须拒绝。回归使用超过管道缓冲区的大输入，并校验成功消费的字节数和摘要。
- authority readback 失败先核对实际数据库来源：相同 loopback 端口和库名不代表同一权威库，SSH 转发后的 mismatch 不能直接否定原本机 Receipt。旧状态记录、当前连接验证与当前源码的签署范围必须分别报告；禁止用导入本地 Receipt 的方式制造通过。
- Docker 恢复期间若日志出现外部 GUI reset 等状态变更，暂停运行时操作并协调；VHDX 文件仍在只能证明文件存在，不能证明容器/卷/数据库内容完整。仅凭 runtime 目录名称不能重命名整个目录，必须核对内容不含持久化数据并保存可恢复备份。
- 数字形状的属性名不一定是数组索引（如 `4294967295`）：闭集数组必须同时校验安全整数、`index < length` 与无空洞。结构反射前拒绝 Proxy，避免 trap 执行、伪造 length 和重入污染；只有 getter 测试不足以证明“校验无副作用”。
- 策略交集的两个输入都合法，不代表返回对象仍在字节预算内；host×path 组合会复制长字段。返回前重新验证完整输出，并回归“超限当次拒绝”和“合法结果可以继续组合”。
- JSON parser 接受键不代表后续 schema parser 会保留键；本次 Zod record 解析会丢弃 own `__proto__`。哈希前比较完整 raw/parsed canonical bytes，Agent 与 Flow 各自保留负例；这不是全局 prototype pollution 的证据。
- 递归 `z.union` 会在失败分支中重复解析嵌套 body；本次 condition loop 13 层触发数千次 leaf parse。改为按 mode/type 分派，并用可控 schema-only leaf 访问次数回归复杂度，避免以易抖动的毫秒阈值作正确性测试。
- 不要把 verified child-root `minimum_limits` 直接复制成 parent Flow/SubAgent Binding 的固有需求：父调用本身会增加 calls/depth/budget。应保留完整 requirement expression，用含显式 invocation demand 的 `nested_call` 编译 envelope；直接透传 child minima 会低估权限需求。
