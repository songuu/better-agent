# G0-08 final gate semantic-output parser debug journal

- **现象：** 六套 PostgreSQL 与 `pnpm check` 都退出 0，但聚合报告将 mutation、quality、postgres16 全部标记为 fail，错误为 `reported skipped or todo work`。
- **根因：** 首版语义判定在整个输出上扫描 `skip/todo` 单词；真实测试名称包含这些词，即使摘要是 `skipped 0 / todo 0` 也会误报。
- **失败迭代：** 改为全输出数字短语后，Turbo 前缀 TAP directive 与 plan-level `1..0 # SKIP` 会漏检，同时诊断文本中的 `1 skipped` 又会误报。
- **最终修复：** 去除 ANSI CSI 后逐行解析；先剥离可选 Turbo `*:test:` 前缀，只接受 TAP test-point directive、TAP plan skip、Node 摘要、Vitest/Jest 标题化摘要和独立计数摘要等闭集格式。runner 摘要必须以“计数 + 状态”起始，非零 skip/todo 后必须是摘要分隔符。
- **回归：** architecture gate tests 保持冻结的 26/26、skip=0、todo=0；独立 code-reviewer 的 18 个动态正反格式探针全通过，最终完整 disposable clean-checkout gate 三类结果均为 pass。
- **规则：** 对机器输出做语义判定时解析结构化行边界，不扫描自然语言 token；每种拒绝格式同时配一条相邻的通过反例，防止 fail-open 与误报互相摆动。
- **后续回归：** Turbo/Vitest 的 ANSI/横向空白使真实 API `80 passed` 不再依赖原始字节版式；Review 连续拒绝了通用 `includes`、不受控后缀、逻辑跨行和 PG 短 marker 代签。最终协议为 ANSI 去除、八类行终止符分行、仅空格/Tab 归一化、完整行相等；六个 PG suite 各自只在成功尾部输出唯一 machine marker。

## 2026-09-02 CI EPIPE 修复与部署暂停

- **最新已验收提交：** `a1ce87d133dfaa1edf482ab9935604b7e5a2bd5d`；[CI 33581446892](https://github.com/songuu/better-agent/actions/runs/33581446892) 全绿，31 项架构自测及六套真实 PG suite 均通过。解决方案详见 [[2026-09-02-postgres-stdin-epipe]]。
- **反馈环：** 8 MiB 输入加提前退出的真实 Node 子进程先复现未处理 EOF；增加 stdin error listener 后五项回归通过。独立审查补强正常大输入的字节数和摘要校验。
- **本机环境：** 全量本地 gate 到 PostgreSQL 阶段因 Docker Desktop Linux pipe 缺失失败；本地失败不作通过证据，以成功的 Linux CI 运行补齐。
- **发布包仅本地准备：** `C:/Users/Administrator/AppData/Local/Temp/better-agent-deploy-a1ce87d133dfaa1edf482ab9935604b7e5a2bd5d/better-agent-a1ce87d133dfaa1edf482ab9935604b7e5a2bd5d.tgz`，1,313,904 bytes，SHA-256 `49cf58abe696e4270f05680fa2da50723be53fa883d2badbf7182b432f4b0bfb`。来源为精确 Git commit 与重新构建的 db/dist，不包括这些后写本地记录。
- **服务器阻塞：** `47.253.230.197` 的 `/dev/vda3` ext4 根分区 39.8 GiB，df 可用为 0；块设备 `/dev/vda` 已为 50 GiB。约 10 GiB 尚未扩展到最后一个分区，不能跳过部署的 1 GiB 可用空间预检。
- **已请求新授权：** 备份分区表后在线扩容 `/dev/vda3` 和 ext4；尚未收到确认，未执行分区修改、服务器文件删除、新版上传、迁移或 current 切换。
- **既有部署未动：** `/opt/better-agent/current` 仍为 `better-agent-1b99fd602fc4ca6c818d29c8007d16c7c2e684b7`，独立 PostgreSQL 容器保持现有状态。允许扩容后须重新核验磁盘、当前 release、发布包摘要，再 up/status、原子切换、幂等复验并确认回滚 receipt。
- **Compound 降级：** 本项目没有 `scripts/sync-solution-index.js`，只按既有 index.jsonl 格式追加 canonical 摘要；未新增 renderer，也未手工修改 runtime 投影。

## 2026-09-02 songuu.top 访问目标核验

- 用户要求参考 `E:/project/ai/agent` 的部署方式，从 `songuu.top` 完整访问 Better Agent；foundation 只是已完成的实施切片，不是最终交付目标。
- 参考项目使用 VitePress 构建站点，线上 Nginx `/agent-build/` alias 指向 `/opt/agent-build/current/.vitepress/dist/`；发布采用 immutable release/current 模式。
- Better Agent 当前只有 `apps/api` 的契约/边界模块，没有 Web 应用、HTTP 启动入口或 start 脚本。既有实施计划将 API/SSE/browser 与运行闭环列入尚未实现的 G1。复制静态站部署配置不能生成这些业务能力。
- 服务器实际请求 `https://songuu.top/better-agent/` 返回 HTTP 404；现有 Nginx 没有 Better Agent location。根分区可用空间仍为 0。独立 Better Agent PostgreSQL 容器为 healthy。
- 浏览器核验未完成：agent-browser 命名会话 daemon 启动失败；内置 Chrome 新标签创建超时。不能据此声明页面或端到端业务通过。
- 未发布文档站/占位页面来替代业务系统，未改网关、Nginx、系统分区或其他项目。下一步依据既有完整应用设计继续实施业务前端/HTTP/运行时，并单独处理根分区在线扩容授权。

## 用户纠正：完整应用目标已经明确

- 用户明确说明当前项目对标 `ai.betteryeah.com`，目标是完整 Agent 应用。先前要求用户再次决定“文档站还是业务系统”属于理解偏差，已撤回该前提。
- 产品目标与部署参考必须分开：BetterYeah 决定产品设计参考，`E:/project/ai/agent` 只提供服务端部署方式参考。
- “完整产品设计”与“当前代码全部实现并已上线”需要分开报告。既有设计已经明确，实际实现及线上可用性仍按证据确认；不得反过来因实现缺口缩小目标。
- 纠正规则已写入 `.codex/rules/architecture.md`，后续不再以重复确认产品定位阻断正常实施。

## 2026-09-02 原验收数据库与 Docker 恢复调查

- `.handoff/active-sprint.json` 实际记录了 generation 3 的 host-attested passed Receipt，旧 README/计划正文中的 pending 描述已过时。历史 receipt hash 为 `sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668`，不能把它当作后续提交的新增宿主签署。
- 验证脚本的原权威库连接目标是本机 `127.0.0.1:55433/tech_persistence`。Docker 停止时回读失败为 ECONNREFUSED。临时 SSH 转发到服务器同端口后出现 authority readback mismatch；服务器库并未证明是原本机权威库，因此不能直接推断原 Receipt 失效。隧道已关闭，没有写入 authority row。
- Docker 启动日志依次报告 `Docker/run/dockerInference` 与 `docker-secrets-engine/engine.sock` 残留 AF_UNIX socket。确认 backend/Desktop 已停止并核对路径、链接和目录内容后，只将 runtime 目录保留重命名为 `run.stale-better-agent-20260902` 与 `docker-secrets-engine.stale-better-agent-20260902`；后者确认仅含一个 socket。没有删除数据库、卷、镜像或秘密文件。
- 10:48 左右 Docker 日志记录 GUI `Reset to factory defaults` 和 application reset；不是本任务执行的命令。已向用户询问并暂停 Docker 操作，防止并发恢复冲突。原 `Docker/wsl/disk/docker_data.vhdx` 仍存在，大小 8,609,857,536 bytes，文件时间为 2026-09-01 23:16:54 +08:00；不能仅凭文件存在断言库内容无损。
- release-core 基线测试 33/33 通过。G1-A1 细化计划写入 `docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md`，只完成规划，未越过原验收/PG 环境验证门开始业务实现，也未修改旧 Receipt、外部 broker 或生产部署。
- 当前工作树 `pnpm check` 成功退出 0，使用既有 Turbo 缓存，含非阻断 lint warning；没有把它等同于六套 PG 重跑或新宿主验收。Compound 新增了权威库来源辨别与 Docker 并发状态变更两条经验，没有把未解决的恢复问题写为已解决方案。
- 独立 quality/test review 纠正了草案的额外阻断：历史 G0 admission 不因本机 Docker 故障自动撤回，旧 G0 执行期的环境停止条件不能扩展为每次纯 G1 TDD 的重新准入。允许推进不触数据库的 T1–T5；新源码 PG 集成、完整门与新完成/合并/发布声明仍受真实验证约束。原库追溯核验和生产恢复单独保留，不伪造或改写旧 Receipt。
