# Testing patterns

- 准入门 mutation 至少覆盖 missing、duplicate、reorder、extra、skip/todo、timeout、output overflow、cleanup failure、link identity 与 interpreter injection。
- CI 安全测试应解析 YAML 并验证闭集对象；正则只用于精确版式补充，不能承担语义解析。
- 数据库清理回归必须证明首次失败仍尝试所有目标、保留 registry、重试成功后才删除 registry。
- 语义 marker 回归必须成对覆盖合法 ANSI/Tab/多空格与非法跨行、嵌入前缀、相邻数字、错包名/计数；拒绝格式要包含 CRLF/LF/CR/VT/FF/NEL/LS/PS。
