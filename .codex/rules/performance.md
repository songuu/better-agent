# Performance rules

- 批量校验不能用“每字段一个 worker”，否则最大 Flow 会放大启动与 deadline 成本。对独立 Schema 先做完整 aggregate 预算，再按 canonical bytes 去重到一个有界 worker；去重不得折叠字段证据。
- 增大批量吞吐量不能顺带放宽小请求的 worker-slot 占用。单项与批量保持相同 5 秒总 deadline，4 个恶意请求的最坏占槽时间不能因 batch API 成倍增加。
- 性能边界必须包含 unique payload；8194 个相同 Schema 只测试计数/返回 cardinality，不能证明实际编译吞吐或内存界限。
