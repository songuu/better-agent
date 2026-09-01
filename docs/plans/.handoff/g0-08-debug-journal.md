# G0-08 final gate semantic-output parser debug journal

- **现象：** 六套 PostgreSQL 与 `pnpm check` 都退出 0，但聚合报告将 mutation、quality、postgres16 全部标记为 fail，错误为 `reported skipped or todo work`。
- **根因：** 首版语义判定在整个输出上扫描 `skip/todo` 单词；真实测试名称包含这些词，即使摘要是 `skipped 0 / todo 0` 也会误报。
- **失败迭代：** 改为全输出数字短语后，Turbo 前缀 TAP directive 与 plan-level `1..0 # SKIP` 会漏检，同时诊断文本中的 `1 skipped` 又会误报。
- **最终修复：** 去除 ANSI CSI 后逐行解析；先剥离可选 Turbo `*:test:` 前缀，只接受 TAP test-point directive、TAP plan skip、Node 摘要、Vitest/Jest 标题化摘要和独立计数摘要等闭集格式。runner 摘要必须以“计数 + 状态”起始，非零 skip/todo 后必须是摘要分隔符。
- **回归：** architecture gate tests 保持冻结的 26/26、skip=0、todo=0；独立 code-reviewer 的 18 个动态正反格式探针全通过，最终完整 disposable clean-checkout gate 三类结果均为 pass。
- **规则：** 对机器输出做语义判定时解析结构化行边界，不扫描自然语言 token；每种拒绝格式同时配一条相邻的通过反例，防止 fail-open 与误报互相摆动。
- **后续回归：** Turbo/Vitest 的 ANSI/横向空白使真实 API `80 passed` 不再依赖原始字节版式；Review 连续拒绝了通用 `includes`、不受控后缀、逻辑跨行和 PG 短 marker 代签。最终协议为 ANSI 去除、八类行终止符分行、仅空格/Tab 归一化、完整行相等；六个 PG suite 各自只在成功尾部输出唯一 machine marker。
