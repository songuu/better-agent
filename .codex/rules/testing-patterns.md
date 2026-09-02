# Testing patterns

- 准入门 mutation 至少覆盖 missing、duplicate、reorder、extra、skip/todo、timeout、output overflow、cleanup failure、link identity 与 interpreter injection。
- CI 安全测试应解析 YAML 并验证闭集对象；正则只用于精确版式补充，不能承担语义解析。
- 数据库清理回归必须证明首次失败仍尝试所有目标、保留 registry、重试成功后才删除 registry。
- 语义 marker 回归必须成对覆盖合法 ANSI/Tab/多空格与非法跨行、嵌入前缀、相邻数字、错包名/计数；拒绝格式要包含 CRLF/LF/CR/VT/FF/NEL/LS/PS。
- 权限交集除代数律还要验证独立成员模型，并为每个精确授权轴提供双向冲突输入；内存变异能发现“正例和通配负例全绿，但 exact 比较已被移除”的缺口。
- 多维最低资源消耗要测联合可行性；input/output cap 可独立，但同时的 token minima 之和不得超过 total cap，覆盖等值、+1 和 safe-integer 求和边界。
- DAG 最长路径回归必须包含先访问的共享非叶子子图，并断言 canonical 访问顺序；只共享叶节点无法捕获 memoized height 被错误清零。用 32/33 等值与 +1 成对案例、独立边集合模型和只读内存变异共同验证。
- 语义 preimage 不仅测“哈希变化”，还要断言完整投影对象；对每类 Binding 使用非空有效配置并逐字段变异，防止整类字段被忽略而测试仍绿。共享 source/release refinements 用同一有效 fixture 的正反成对测试保护。
- 递归图测试分别变异 second case、loop body、else，保持其他路径有效；规范集合排序和 first-match case 保序分开断言。复杂度回归在 schema 层计数 leaf parse，公网 source API 仍必须拒绝 getter/Proxy。
