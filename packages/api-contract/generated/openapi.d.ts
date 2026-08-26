// Generated from docs/api/openapi.yaml by @better-agent/api-contract.
// DO NOT EDIT: run `pnpm --filter @better-agent/api-contract generate`.

export type PublicRedactedPayloadValue = string | number | boolean | null | PublicRedactedPayloadValue[] | {
    [key: string]: PublicRedactedPayloadValue;
};
export type paths = {
    "/v1/oapi/agent/chat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 创建 Agent Chat 运行
         * @description response_mode=streaming 时总是返回 202 operation。
         *     response_mode=blocking 时仅在等待窗口内终态才返回 200，否则返回 202；
         *     HTTP 连接断开不会取消 durable Run。robot_id 与 conversation_id 必须在当前
         *     credential/browser-session workspace/principal 的同一 Agent 范围内。不可见 conversation 返回 404。
         *     带 Idempotency-Key 的重放先认证并确认原 Run 可读，再以稳定的公开客户端 intent 比较；命中总是返回
         *     保存的 canonical 202 acceptance receipt，不重放首次 blocking 连接的 200，也不重新解析当前 Deployment、Release、binding 或 Plan。
         *     只有幂等 miss 才在同一事务固定 active Deployment revision；每个新 Chat Run 都必须将其
         *     conversation_contract_hash 与 conversation 创建时保存的 hash 比较，相等后才能创建 Run、积分预留、
         *     run.accepted 或 outbox。不相等返回 409 CONVERSATION_REVISION_INCOMPATIBLE；G1 不做隐式迁移。
         */
        post: operations["createAgentChatRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/agent/conversation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 创建 Agent 会话
         * @description Chat 不会隐式创建会话。robot_id 必须与 credential/browser session 的稳定 Deployment binding 一致；
         *     创建的 conversation 固定属于当前 workspace、principal 和 deployment_id。每次 Run 准入再解析 active revision。
         *     G1 本端点不接受 Idempotency-Key，也不承诺网络重放去重。
         */
        post: operations["createAgentConversation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/agent/conversation/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 读取会话历史消息
         * @description 只返回当前 principal 可见、经过 schema 脱敏的 user/assistant 公共投影；内部 system prompt、Strategy/Instruction Skill、工具上下文和隐藏控制消息不属于本资源。
         */
        get: operations["listAgentConversationMessages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/agent/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出当前 Agent 可见会话 */
        get: operations["listAgentConversations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/browser/sessions/exchange": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 宿主后端为已验证最终用户换取短期 browser session
         * @description 仅宿主后端调用。稳定 Deployment publish credential 必须留在服务端，并与预配置 issuer
         *     签名的短期 subject_assertion 一起验证。服务端从 assertion 的 issuer/subject 映射平台 principal，
         *     不接受 principal_id，也不把 user.id 当作身份。返回的 Bearer token 固定 workspace、稳定 Deployment、
         *     channel、principal、exact origin、audience、expiry 与 session_epoch；G1 不签发匿名 session。
         */
        post: operations["exchangeBrowserSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/flow/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 创建已发布 Flow 的运行
         * @description 此 compatibility 路径的 body 不含 flow_id。Access-Key 必须是仅绑定一个已发布 Flow 的
         *     service_api credential；flow_invoke 仅为本 operation 的 purpose 标签，授权须命中
         *     flow:run:create scope 与 exactly-one-flow 的类型化 Flow Deployment entry grant；
         *     服务端在授权/接受事务中解析 flow_id 和已发布 flow_version_id，
         *     并将版本固定进 Run。多目标 credential 返回 409 FLOW_TARGET_AMBIGUOUS；inputs 必须满足
         *     该固定版本的 input schema。幂等重放先确认原 Run 可读，再以稳定公开 intent 比较；已解析目标/版本
         *     与 Plan 只保存在首次接受记录，命中时返回 canonical 202 acceptance receipt，绝不重新解析最新版本
         *     或当前 credential binding；公开 receipt 不返回 flow_version_id 或其他内部 pin。
         *     与 Agent Chat 共用 Run、幂等、计费、取消和 SSE 生命周期。
         */
        post: operations["createFlowRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/runs/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读取 Run 快照 */
        get: operations["getRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/runs/{run_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 请求取消非终态 Run
         * @description Idempotency-Key 可选：携带非空 key 时使用 keyed mutation 幂等并保存首次响应；省略时仍持久化取消意图，
         *     但不创建 mutation idempotency record，也不承诺网络重放去重。keyed intent_hash 使用路径模板
         *     `/v1/oapi/runs/{run_id}/cancel`、path parameter `run_id` 与规范化空 body `{}`；
         *     host、query、实际 URL 和 transport request_id 不参与比较。mutation 唯一范围不含目标 Run，
         *     因此同一 principal/key 跨 Run 复用会因 intent 不同返回 409。keyed hit 必须先读取历史目标；
         *     当前主体不可读时固定返回 404 RUN_NOT_FOUND，不比较 intent、也不回放 receipt。详见 SSE 契约 §2.4。
         */
        post: operations["requestRunCancellation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/runs/{run_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 订阅可重放的 Run 事件
         * @description 事件按 run 内 sequence 严格递增，SSE id 等于该 sequence；run_id 已由 URL 绑定。
         *     认证可使用 Access-Key + Workspace-Id，或同源 events session cookie。cursor 与 Last-Event-ID
         *     同时存在时必须相同；请求必须协商 Accept: text/event-stream。cursor 早于终态后至少 7 天的
         *     保留窗口返回 410，未来 cursor 返回 409。按 ID 不可见统一返回 typed 404，不以 403 暴露存在性。
         */
        get: operations["streamRunEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/runs/{run_id}/events/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 为同源浏览器创建 Run events cookie session
         * @description 浏览器 SDK 以 credentials: include 和 exchange 后的短期 Bearer session 调用此端点；稳定 publish credential
         *     不得出现在浏览器请求。成功只通过 Set-Cookie 交付不透明 capability，
         *     不返回 token body。cookie 名称必须以 __Secure- 开头、host-only 且不得含 Domain，并设置
         *     HttpOnly、Secure、SameSite=Strict、Max-Age 不超过 60 秒；仅授权指定 run_id，且 Path 限定至
         *     该 Run 的 events URL。Set-Cookie 是值唯一允许出现的位置，整个头不得进入日志/trace；响应 no-store。
         *     请求必须通过 session origin/current allowlist 校验；跨源 EventSource 不受支持。
         */
        post: operations["createBrowserRunEventSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oapi/runs/{run_id}/gates/{gate_id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 提交 Human Gate 输入或审批决策
         * @description 这是必带 Idempotency-Key 的持久 mutation。actor 只从认证 context 获得；请求不得提交
         *     workspace、approver、credential、Release、operation hash 或 resume token。缺少或空 key 返回 400。
         *     认证后先锁 workspace/principal/fixed route template/key：命中时先对历史目标执行 read gate，再比较
         *     run_id/gate_id/action/input 的 JCS intent；相同即重放保存的 202，不检查 Gate 当前状态、过期、active latest
         *     或当前授权，不同返回 409。只有 miss 才原子 claim gate，重新验证原 Plan/operation、actor policy、过期、
         *     credential/resource epoch 与预算，再保存 decision 和不可变首次 receipt。正向 decision 若仍有后续 cohort，
         *     只物化下一 Gate、写 run.waiting 并返回 NEXT_GATE_WAITING，不创建 run.resumed、attempt 或 Worker outbox；
         *     只有最后一个正向 decision 返回 RUN_RESUMED 并原子写 run.resumed、下一 attempt 与恢复 outbox；
         *     reject 返回 TERMINAL_INTENT_ACCEPTED，只写终态意图并唤醒唯一 finalizer，不写 run.resumed 或下一 attempt。
         *     恢复固定原 Deployment/Release/Plan，不解析 active latest。
         */
        post: operations["resumeHumanGate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        AgentChatRequest: {
            content: string;
            conversation_id: string;
            inputs: {
                [key: string]: unknown;
            };
            /**
             * @default blocking
             * @enum {string}
             */
            response_mode: "blocking" | "streaming";
            robot_id: string;
        };
        /**
         * @description 当前账务结算投影；PENDING 表示仍有预留/分配或结算工作，SETTLED 表示可展示最终费用/进入清理，NEEDS_ATTENTION 表示需人工对账并阻止清理。
         * @enum {string}
         */
        BillingState: "PENDING" | "SETTLED" | "NEEDS_ATTENTION";
        BlockingRunData: {
            /**
             * Format: uuid
             * @description 首次接受该 Run 的服务端 request_id；幂等重放时不变。
             */
            accepted_request_id: string;
            /**
             * @description G1 不可变 terminal-time compatibility snapshot；公开 child policy 只允许 join，因此固定为 false。G2 detach 必须通过后续版本 schema 表达，不得放宽本契约。
             * @constant
             */
            billing_pending: false;
            /**
             * Format: date-time
             * @description 仅 billing_state=SETTLED 时存在；这是当前结算投影，不属于不可变 terminal event。
             */
            billing_settled_at?: string;
            billing_state: components["schemas"]["BillingState"];
            duration_time: number;
            error?: components["schemas"]["ErrorDetail"];
            message?: string;
            /** @description 仅 SUCCEEDED 存在，读取 Run 上不可变终态公开结果快照。 */
            result?: components["schemas"]["PublicRedactedPayload"];
            /** Format: uuid */
            run_id: string;
            /** @enum {string} */
            status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
            tasks: components["schemas"]["Task"][];
            timestamp: number;
        } & (unknown & unknown & unknown & unknown & unknown & unknown);
        BlockingRunResponse: {
            /** @constant */
            code: 200;
            data: components["schemas"]["BlockingRunData"];
            message: string;
            now_time: number;
            /** Format: uuid */
            request_id: string;
            success: boolean;
        };
        BrowserSessionData: {
            /** @description 短期不透明 browser session token；宿主后端只通过自身已认证 bootstrap 交付，浏览器以内存态 Bearer 使用。 */
            readonly access_token: string;
            /** Format: date-time */
            expires_at: string;
            /** @description 秒；G1 上限 15 分钟。 */
            expires_in: number;
            /** @constant */
            token_type: "Bearer";
        };
        BrowserSessionExchangeRequest: {
            /**
             * @description G1 已认证浏览器渠道；匿名 public 渠道不在本契约内。
             * @enum {string}
             */
            channel: "WEB_SDK" | "DINGTALK_WEB";
            /**
             * Format: uri
             * @description exact browser origin（scheme、host、port；不得含 path/query/fragment），必须命中 Deployment allowlist。
             */
            origin: string;
            /** @description 稳定公开 Agent selector；必须与 publish credential 的唯一 Deployment binding 一致，不能选择 revision/Release。 */
            robot_id: string;
            /** @description compact JWS EdDSA v1；typ 固定 ba-subject-assertion+jwt，payload version 固定 subject-assertion/1，kid 使用本地固定 key version，TTL 不超过 300 秒且 clock skew 不超过 30 秒；claims 必须含 issuer_config_id/iss/sub/aud/nonce/iat/exp/origin/key_version。服务端验证并映射 principal 后，只保留安全摘要 DTO，不保存或记录 assertion 原文、sub、nonce、protected header 或签名。 */
            subject_assertion: string;
        };
        BrowserSessionResponse: {
            /** @constant */
            code: 201;
            data: components["schemas"]["BrowserSessionData"];
            message: string;
            now_time: number;
            /** Format: uuid */
            request_id: string;
            /** @constant */
            success: true;
        };
        ConflictErrorResponse: components["schemas"]["IdempotencyKeyReusedConflictErrorResponse"] | components["schemas"]["ConversationRevisionConflictErrorResponse"] | components["schemas"]["CursorOutOfRangeConflictErrorResponse"] | components["schemas"]["FlowTargetAmbiguousConflictErrorResponse"] | components["schemas"]["FlowTargetUnavailableConflictErrorResponse"] | components["schemas"]["GateAlreadyResolvedConflictErrorResponse"] | components["schemas"]["GateStaleConflictErrorResponse"];
        ConflictErrorResponseBase: components["schemas"]["ErrorResponse"] & {
            /** @constant */
            code?: 409;
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CONFLICT";
            };
        };
        Conversation: {
            /** @enum {string} */
            client_type?: "PC" | "MOBILE" | "DINGTALK_WEB" | "CLIENT";
            conversation_id: string;
            /** Format: date-time */
            created_at: string;
            robot_id: string;
            title?: string;
            /** Format: date-time */
            updated_at?: string;
        };
        ConversationCreateRequest: {
            /** @enum {string} */
            client_type?: "PC" | "MOBILE" | "DINGTALK_WEB" | "CLIENT";
            robot_id: string;
            title?: string;
            variables?: {
                [key: string]: unknown;
            };
        };
        ConversationListData: {
            items: components["schemas"]["Conversation"][];
            next_cursor?: string | null;
        };
        ConversationListResponse: {
            /** @constant */
            code: 200;
            data: components["schemas"]["ConversationListData"];
            message: string;
            now_time: number;
            /** Format: uuid */
            request_id: string;
            /** @constant */
            success: true;
        };
        ConversationMessage: {
            content?: components["schemas"]["PublicRedactedPayload"];
            message_id: string;
            /**
             * @description 公共 history 不返回内部 system/instruction/control 记录。
             * @enum {string}
             */
            role: "user" | "assistant";
            tasks?: components["schemas"]["Task"][];
            timestamp: number;
        };
        ConversationMessagesData: {
            items: components["schemas"]["ConversationMessage"][];
            next_cursor?: string | null;
        };
        ConversationMessagesResponse: {
            /** @constant */
            code: 200;
            data: components["schemas"]["ConversationMessagesData"];
            message: string;
            now_time: number;
            /** Format: uuid */
            request_id: string;
            /** @constant */
            success: true;
        };
        ConversationNotFoundErrorResponse: components["schemas"]["ErrorResponse"] & {
            /** @constant */
            code?: 404;
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "AUTHORIZATION";
                /** @constant */
                code?: "CONVERSATION_NOT_FOUND";
            };
        };
        ConversationResponse: {
            /** @constant */
            code: 201;
            data: components["schemas"]["Conversation"];
            message: string;
            now_time: number;
            /** Format: uuid */
            request_id: string;
            /** @constant */
            success: true;
        };
        ConversationRevisionConflictErrorResponse: components["schemas"]["ConflictErrorResponseBase"] & {
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CONFLICT";
                /** @constant */
                code?: "CONVERSATION_REVISION_INCOMPATIBLE";
            };
        };
        CreditsErrorResponse: components["schemas"]["ErrorResponse"] & {
            /** @constant */
            code?: 60001;
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CREDITS";
                /** @constant */
                code?: "CREDITS_INSUFFICIENT";
            };
        };
        CursorOutOfRangeConflictErrorResponse: components["schemas"]["ConflictErrorResponseBase"] & {
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CONFLICT";
                /** @constant */
                code?: "CURSOR_OUT_OF_RANGE";
            };
        };
        ErrorDetail: {
            /** @enum {string} */
            category: "VALIDATION" | "AUTH" | "AUTHORIZATION" | "CREDITS" | "CONFLICT" | "RATE_LIMIT" | "EXECUTION" | "INTERNAL" | "UPSTREAM";
            code: string;
            /**
             * @description Flow IR 原始分类；仅在安全且与 Flow 有关时返回。
             * @enum {string}
             */
            flow_category?: "VALIDATION" | "RESOLUTION" | "POLICY" | "CANCELLED" | "TIMEOUT" | "UPSTREAM_TRANSIENT" | "UPSTREAM_PERMANENT" | "SIDE_EFFECT_UNKNOWN" | "INTERNAL";
            /** @description true 表示内部 NEEDS_ATTENTION 已被投影为公开 FAILED，禁止客户端自动重试。 */
            requires_operator_action?: boolean;
            retryable: boolean;
        } & unknown;
        ErrorResponse: {
            code: number;
            data: null;
            error: components["schemas"]["ErrorDetail"];
            message: string;
            now_time: number;
            /** Format: uuid */
            request_id: string;
            /** @constant */
            success: false;
        };
        EventCursorExpiredData: {
            /**
             * Format: uri-reference
             * @description 选择有效 cursor 后重新订阅的 SSE 路径。
             */
            events_url: string;
            /** @description 当前 Run 已持久化的最大 sequence；来自 durable Run cursor，以十进制字符串输出，event retention 后不回退。 */
            last_sequence: string;
            /** @description 当前仍可重放的最小 run 内 sequence；当前全量 event retention 后为 last_sequence + 1。 */
            min_sequence: string;
            /**
             * Format: uri-reference
             * @description 查询 Run 快照和终态摘要的路径。
             */
            operation_url: string;
            /** Format: uuid */
            run_id: string;
        };
        EventCursorExpiredErrorResponse: {
            /** @constant */
            code: 410;
            data: components["schemas"]["EventCursorExpiredData"];
            error: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                code?: "EVENT_CURSOR_EXPIRED";
                /** @constant */
                retryable?: false;
            };
            message: string;
            now_time: number;
            /** Format: uuid */
            request_id: string;
            /** @constant */
            success: false;
        };
        FlowExecutionForbiddenErrorResponse: components["schemas"]["ErrorResponse"] & {
            /** @constant */
            code?: 403;
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "AUTHORIZATION";
                /** @constant */
                code?: "FLOW_EXECUTION_FORBIDDEN";
            };
        };
        /** @description flow_id 有意不在 body 中；flow_invoke 仅为 operation purpose，目标由 service_api credential 的 scope 与 exactly-one-flow 类型化 Flow Deployment entry grant 解析并固定。 */
        FlowRunRequest: {
            inputs: {
                [key: string]: unknown;
            };
            /**
             * @default blocking
             * @enum {string}
             */
            response_mode: "blocking" | "streaming";
        };
        FlowTargetAmbiguousConflictErrorResponse: components["schemas"]["ConflictErrorResponseBase"] & {
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CONFLICT";
                /** @constant */
                code?: "FLOW_TARGET_AMBIGUOUS";
            };
        };
        FlowTargetUnavailableConflictErrorResponse: components["schemas"]["ConflictErrorResponseBase"] & {
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CONFLICT";
                /** @constant */
                code?: "FLOW_TARGET_UNAVAILABLE";
            };
        };
        GateAlreadyResolvedConflictErrorResponse: components["schemas"]["ConflictErrorResponseBase"] & {
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CONFLICT";
                /** @constant */
                code?: "GATE_ALREADY_RESOLVED";
            };
        };
        GateExpiredErrorResponse: components["schemas"]["ErrorResponse"] & {
            /** @constant */
            code?: 410;
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CONFLICT";
                /** @constant */
                code?: "GATE_EXPIRED";
                /** @constant */
                retryable?: false;
            };
        };
        GateStaleConflictErrorResponse: components["schemas"]["ConflictErrorResponseBase"] & {
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CONFLICT";
                /** @constant */
                code?: "GATE_STALE";
            };
        };
        HumanGateApprovalResumeRequest: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            action: "approve" | "reject";
        };
        HumanGateInputResumeRequest: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            action: "submit";
            /** @description 必须满足该 input gate 的公开 JSON Schema；敏感值不进入 SSE、日志或幂等响应投影。 */
            input: {
                [key: string]: unknown;
            };
        };
        HumanGateMutationAcceptedResponse: {
            /** @constant */
            code: 202;
            data: components["schemas"]["HumanGateMutationData"];
            message: string;
            now_time: number;
            /**
             * Format: uuid
             * @description 当前 Gate mutation HTTP exchange 的 request_id；重放时重新生成。
             */
            request_id: string;
            /** @constant */
            success: true;
        };
        /** @description Human Gate 首次接受时保存的安全结果投影；相同 actor/key/intent 重放原 outcome，当前 Run 状态另由 operation_url 查询。 */
        HumanGateMutationData: {
            /**
             * Format: uuid
             * @description 原 Run 首次接受时的 request_id；Gate mutation 重放时不变。
             */
            accepted_request_id: string;
            /** Format: uri-reference */
            events_url: string;
            /** Format: uri-reference */
            operation_url: string;
            /**
             * @description NEXT_GATE_WAITING 表示仅物化下一 Gate；RUN_RESUMED 表示最后一个正向 decision 已创建恢复；TERMINAL_INTENT_ACCEPTED 表示 reject 只提交终态意图。
             * @enum {string}
             */
            outcome: "NEXT_GATE_WAITING" | "RUN_RESUMED" | "TERMINAL_INTENT_ACCEPTED";
            pending_action?: components["schemas"]["PendingHumanAction"];
            /** Format: uuid */
            run_id: string;
            /**
             * @description decision 提交事务结束时保存的公开 Run 状态；不表示 finalizer 或后续 attempt 已完成。
             * @constant
             */
            status: "RUNNING";
        } & ({
            /** @constant */
            outcome: "NEXT_GATE_WAITING";
        } | {
            /** @constant */
            outcome: "RUN_RESUMED";
        } | {
            /** @constant */
            outcome: "TERMINAL_INTENT_ACCEPTED";
        });
        HumanGateResumedEventData: {
            /**
             * @description 仅最后一个正向 Human Gate decision 产生 run.resumed；reject 不属于恢复事件。
             * @enum {string}
             */
            action: "submit" | "approve";
            /** Format: uuid */
            gate_id: string;
            /** Format: date-time */
            resumed_at: string;
        };
        HumanGateResumedRunEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["HumanGateResumedEventData"];
            /** @constant */
            type: "run.resumed";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "run.resumed";
        };
        HumanGateResumeRequest: components["schemas"]["HumanGateInputResumeRequest"] | components["schemas"]["HumanGateApprovalResumeRequest"];
        HumanGateWaitingEventData: {
            pending_action: components["schemas"]["PendingHumanAction"];
        };
        HumanGateWaitingRunEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["HumanGateWaitingEventData"];
            /** @constant */
            type: "run.waiting";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "run.waiting";
        };
        IdempotencyKeyReusedConflictErrorResponse: components["schemas"]["ConflictErrorResponseBase"] & {
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "CONFLICT";
                /** @constant */
                code?: "IDEMPOTENCY_KEY_REUSED";
            };
        };
        NodeCompletedEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["NodeCompletedEventData"];
            /** @constant */
            type: "node.completed";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "node.completed";
        };
        NodeCompletedEventData: {
            attempt: number;
            output?: components["schemas"]["PublicRedactedPayload"];
            usage?: components["schemas"]["PublicUsage"];
        };
        NodeFailedEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["NodeFailedEventData"];
            /** @constant */
            type: "node.failed";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "node.failed";
        };
        NodeFailedEventData: {
            attempt: number;
            error: components["schemas"]["ErrorDetail"];
            will_retry: boolean;
        };
        NodeStartedEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["NodeStartedEventData"];
            /** @constant */
            type: "node.started";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "node.started";
        };
        NodeStartedEventData: {
            attempt: number;
            timeout_ms: number;
        };
        OperationAcceptedResponse: {
            /** @constant */
            code: 202;
            data: components["schemas"]["OperationData"];
            /** @constant */
            message: "accepted";
            now_time: number;
            /**
             * Format: uuid
             * @description 当前 HTTP exchange 的 request_id；幂等重放时重新生成，不属于保存后逐字复用的 receipt data。
             */
            request_id: string;
            /** @constant */
            success: true;
        };
        OperationData: {
            /**
             * Format: uuid
             * @description 首次接受该 Run 的服务端 request_id；幂等重放时不变。
             */
            accepted_request_id: string;
            /** Format: uri-reference */
            cancel_url: string;
            /** @description 仅 Agent Chat compatibility receipt 可返回的既有公开会话 selector。 */
            conversation_id?: string;
            /** Format: uri-reference */
            events_url: string;
            /** Format: uri-reference */
            operation_url: string;
            /** Format: uuid */
            run_id: string;
            /**
             * @description canonical acceptance receipt 的接受时状态，不是当前 Run 状态；重放后应通过 operation_url 查询。
             * @constant
             */
            status: "QUEUED";
        };
        PendingHumanAction: components["schemas"]["PendingHumanInputAction"] | components["schemas"]["PendingHumanApprovalAction"];
        PendingHumanApprovalAction: {
            actions: ("approve" | "reject")[];
            /** Format: date-time */
            expires_at: string;
            /** Format: uuid */
            gate_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "approval";
        };
        PendingHumanInputAction: {
            actions: "submit"[];
            /** Format: date-time */
            expires_at: string;
            /** Format: uuid */
            gate_id: string;
            /** @description 经可见性和数据分类裁剪的公开表单 schema。 */
            schema: {
                [key: string]: unknown;
            };
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "input";
        };
        /** @description 由端点固定的业务 schema 完成可见性裁剪和字段脱敏后的 JSON 值；这是唯一允许承载用户/工具动态内容的显式叶节点，不得含内部版本 pin、Plan/closure hash、credential、secret reference、endpoint 或数据库资源 ID。 */
        PublicRedactedPayload: PublicRedactedPayloadValue;
        PublicRunNode: {
            key: string;
            /** @description 调用方可见的稳定节点投影 ID；不是内部 node/resource/version ID。 */
            node_id: string;
            type: string;
        };
        PublicTaskMetadata: {
            /**
             * @description 仅调用方获准知晓类型时出现。
             * @enum {string}
             */
            capability_kind?: "knowledge" | "flow" | "plugin" | "database" | "subagent" | "skill_pack";
            color?: string;
            /** Format: uri-reference */
            icon?: string;
            label?: string;
            redacted_fields?: string[];
        };
        PublicUsage: {
            input_units?: string;
            output_units?: string;
            total_units?: string;
            unit?: string;
        };
        RequestContextForbiddenErrorResponse: components["schemas"]["ErrorResponse"] & {
            /** @constant */
            code?: 403;
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "AUTHORIZATION";
                /** @enum {string} */
                code?: "WORKSPACE_FORBIDDEN" | "BROWSER_ORIGIN_FORBIDDEN" | "ENDPOINT_SCOPE_FORBIDDEN";
            };
        };
        RunAcceptedEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["RunAcceptedEventData"];
            /** @constant */
            type: "run.accepted";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "run.accepted";
        };
        RunAcceptedEventData: {
            /** @description 仅 Agent Chat 返回且已通过 principal 可见性检查。 */
            conversation_id?: string;
            /** @description 仅 Agent Chat 的稳定公开 selector；不得由此反查内部 Release。 */
            robot_id?: string;
            /** @constant */
            status: "QUEUED";
        };
        RunCancelRequestedEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["RunCancelRequestedEventData"];
            /** @constant */
            type: "run.cancel_requested";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "run.cancel_requested";
        };
        RunCancelRequestedEventData: {
            /** Format: date-time */
            requested_at: string;
        };
        RunEvent: components["schemas"]["RunAcceptedEvent"] | components["schemas"]["RunStartedEvent"] | components["schemas"]["NodeStartedEvent"] | components["schemas"]["TaskDeltaEvent"] | components["schemas"]["TaskCompletedEvent"] | components["schemas"]["NodeCompletedEvent"] | components["schemas"]["NodeFailedEvent"] | components["schemas"]["RunUsageEvent"] | components["schemas"]["HumanGateWaitingRunEvent"] | components["schemas"]["HumanGateResumedRunEvent"] | components["schemas"]["RunCancelRequestedEvent"] | components["schemas"]["RunTerminalEvent"];
        RunEventBase: {
            /** Format: uuid */
            accepted_request_id: string;
            /**
             * Format: uuid
             * @description run_events 的不可变记录身份；不是 SSE id/cursor。
             */
            event_id: string;
            node?: components["schemas"]["PublicRunNode"];
            /** Format: date-time */
            occurred_at: string;
            /** Format: uuid */
            run_id: string;
            /** @constant */
            schema_version: "run-event/1";
            /** @description 经公开投影后的稳定执行 scope；不得包含内部 Release/version/resource pin 或数据库 UUID。 */
            scope_path?: string;
            /** @description 数据库在锁定 Run 行后分配的严格递增序列；SSE id 与该十进制字符串相同。 */
            sequence: string;
        };
        RunMutationAcceptedResponse: {
            /** @constant */
            code: 202;
            data: components["schemas"]["RunMutationData"];
            message: string;
            now_time: number;
            /**
             * Format: uuid
             * @description 当前 mutation HTTP exchange 的 request_id；重放时重新生成。
             */
            request_id: string;
            /** @constant */
            success: true;
        };
        RunMutationData: {
            /**
             * Format: uuid
             * @description 原 Run 首次接受时的 request_id；mutation 重放时不变。
             */
            accepted_request_id: string;
            /** Format: uri-reference */
            events_url: string;
            /** Format: uri-reference */
            operation_url: string;
            /** Format: uuid */
            run_id: string;
            /**
             * @description mutation 首次提交时保存的公开状态投影；重放原样返回，当前状态另由 operation_url 查询。
             * @enum {string}
             */
            status: "QUEUED" | "RUNNING" | "CANCEL_REQUESTED";
        };
        RunNotFoundErrorResponse: components["schemas"]["ErrorResponse"] & {
            /** @constant */
            code?: 404;
            error?: components["schemas"]["ErrorDetail"] & {
                /** @constant */
                category?: "AUTHORIZATION";
                /** @constant */
                code?: "RUN_NOT_FOUND";
            };
        };
        RunSnapshot: {
            /**
             * Format: uuid
             * @description 首次接受该 Run 的服务端 request_id；不是当前 GET exchange 的 request_id。
             */
            accepted_request_id: string;
            /**
             * @description 仅终态存在，取自 G1 不可变 terminal-time snapshot；公开 child policy 只允许 join，因此固定为 false。G2 detach 必须通过后续版本 schema 表达。
             * @constant
             */
            billing_pending?: false;
            /**
             * Format: date-time
             * @description 仅 billing_state=SETTLED 时存在。客户端只以 billing_state 判断当前最终费用和清理资格，不以历史 billing_pending 推断。
             */
            billing_settled_at?: string;
            billing_state: components["schemas"]["BillingState"];
            error?: components["schemas"]["ErrorDetail"];
            /** @description Run 上持久化的单调最大 event cursor；以十进制字符串输出，event retention 后不从剩余事件重新聚合。 */
            last_sequence: string;
            /** @description 仅内部 WAITING 状态存在；兼容 status 保持 RUNNING，但 Worker lease 已释放。 */
            pending_action?: Omit<components["schemas"]["PendingHumanAction"], "type">;
            /** @description 经固定业务 schema 脱敏的公开结果；不得含内部 Release/version/generation pin、Plan/closure hash、credential binding 或 resource UUID。 */
            result?: components["schemas"]["PublicRedactedPayload"];
            /** Format: uuid */
            run_id: string;
            /** @enum {string} */
            status: "QUEUED" | "RUNNING" | "CANCEL_REQUESTED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
        } & (unknown & unknown & unknown & unknown & unknown & unknown & unknown & unknown & unknown);
        RunSnapshotResponse: {
            /** @constant */
            code: 200;
            data: components["schemas"]["RunSnapshot"];
            message: string;
            now_time: number;
            /** Format: uuid */
            request_id: string;
            /** @constant */
            success: true;
        };
        RunStartedEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["RunStartedEventData"];
            /** @constant */
            type: "run.started";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "run.started";
        };
        RunStartedEventData: {
            /** @constant */
            status: "RUNNING";
        };
        RunTerminalEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["RunTerminalEventData"];
            /** @constant */
            type: "run.terminal";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "run.terminal";
        };
        RunTerminalEventData: {
            /**
             * @description G1 不可变 terminal-time snapshot；公开 child policy 仅 join，因此固定为 false。本事件不携带可变 billing_state；G2 detach 必须通过后续版本 schema 表达。
             * @constant
             */
            billing_pending: false;
            duration_time: number;
            error?: components["schemas"]["ErrorDetail"];
            /** @description 该唯一 terminal event 的 Run cursor；以十进制字符串输出，并与终态 Run snapshot 相同。 */
            last_sequence: string;
            /** @description 经固定业务 schema 脱敏的公开终态结果；不得含内部 Release/version/generation pin、Plan/closure hash、credential binding 或 resource UUID。 */
            result?: components["schemas"]["PublicRedactedPayload"];
            /** @enum {string} */
            status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
        } & ({
            /** @constant */
            status?: "SUCCEEDED";
        } | {
            /** @enum {unknown} */
            status?: "FAILED" | "CANCELLED" | "TIMED_OUT";
        });
        RunUsageEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["RunUsageEventData"];
            /** @constant */
            type: "run.usage";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "run.usage";
        };
        RunUsageEventData: {
            consumed: string;
            currency: string;
            reserved: string;
        };
        Task: {
            content?: components["schemas"]["PublicRedactedPayload"];
            duration_time?: number;
            /** @description 可见性裁剪和 schema 脱敏后的白名单展示信息；不得含未获授权资源、版本 pin、连接、endpoint 或 secret reference。 */
            metadata?: components["schemas"]["PublicTaskMetadata"];
            name: string;
            /** @enum {string} */
            status: "STARTED" | "SUCCEEDED" | "FAILED";
            /** @description 仅限已授权观察者的稳定、公开能力投影 ID；不是数据库/资源/版本/endpoint 的原始 ID。 */
            tool_id?: string;
            /**
             * @description 兼容枚举不扩展：knowledge=dataset、flow=flow、plugin=plugin；database、subagent、skill_pack 均为 system。
             * @enum {string}
             */
            tool_type?: "dataset" | "flow" | "plugin" | "system";
            /** @enum {string} */
            type: "TEXT" | "FUNCTION" | "RELATED_QUESTIONS";
            upgrade_consume?: number;
        };
        TaskCompletedEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["TaskCompletedEventData"];
            /** @constant */
            type: "task.completed";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "task.completed";
        };
        TaskCompletedEventData: {
            task: components["schemas"]["Task"];
        };
        TaskDeltaEvent: components["schemas"]["RunEventBase"] & {
            data: components["schemas"]["TaskDeltaEventData"];
            /** @constant */
            type: "task.delta";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "task.delta";
        };
        TaskDeltaEventData: {
            /** @description 已经内容策略过滤的追加文本。 */
            delta: string;
            task: components["schemas"]["Task"];
        };
    };
    responses: {
        /** @description Chat 幂等键被不同 intent 复用，或幂等 miss 时当前 revision 与会话 contract 不兼容。 */
        AgentChatConflictError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["IdempotencyKeyReusedConflictErrorResponse"] | components["schemas"]["ConversationRevisionConflictErrorResponse"];
            };
        };
        /** @description 首次 Chat 的 Conversation 不存在/不可见时返回 CONVERSATION_NOT_FOUND；幂等命中但原 Run 不存在/当前不可见时固定返回 RUN_NOT_FOUND。两种情况均不得通过消息或时延泄漏目标是否存在。 */
        AgentChatNotFoundError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ConversationNotFoundErrorResponse"] | components["schemas"]["RunNotFoundErrorResponse"];
            };
        };
        /** @description credential/browser session/subject assertion 缺失、无效、过期、撤销或 session epoch 已失效。 */
        AuthenticationError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 不代表 Run 已取消。携带 Idempotency-Key 时，取消意图、首次安全响应投影与 keyed mutation idempotency record 已同事务持久化；相同 key/hash 重放首次 202 并返回 Idempotent-Replay。省略 key 时仍持久化取消意图并返回 202，但不创建 mutation idempotency record、不承诺网络重放去重，且 Idempotent-Replay 不出现或为 false。两种路径的 principal 均只由认证 context 派生；keyed 唯一 scope 不含 target，run_id 位于 intent。 */
        CancellationAccepted: {
            headers: {
                "Idempotent-Replay": components["headers"]["IdempotentReplay"];
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["RunMutationAcceptedResponse"];
            };
        };
        /** @description 幂等键复用、conversation revision 不兼容（error.code=CONVERSATION_REVISION_INCOMPATIBLE）、future cursor、Flow 目标歧义/不可用、Gate 已决/陈旧或其他状态冲突。 */
        ConflictError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ConflictErrorResponse"];
            };
        };
        /** @description 会话不存在或调用方不可见；两者统一使用字符串 error.code=CONVERSATION_NOT_FOUND。 */
        ConversationNotFoundError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ConversationNotFoundErrorResponse"];
            };
        };
        /** @description 余额不足；顶层兼容 code 为整数 60001，结构化 error.code 固定为字符串 CREDITS_INSUFFICIENT。 */
        CreditsError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CreditsErrorResponse"];
            };
        };
        /** @description cursor 大于当前 Run last_sequence；格式错误或 cursor/Last-Event-ID 不一致使用 400。 */
        EventCursorConflictError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CursorOutOfRangeConflictErrorResponse"];
            };
        };
        /** @description cursor 早于可重放窗口；data 精确给出 run_id、最小/最大 sequence 与 operation/events 恢复 URL。 */
        EventCursorExpiredError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["EventCursorExpiredErrorResponse"];
            };
        };
        /** @description credential 已认证，但不具备 Flow execution scope/binding；响应不得包含候选 Flow、版本或 binding 细节。 */
        FlowExecutionForbiddenError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["FlowExecutionForbiddenErrorResponse"];
            };
        };
        /** @description Flow Run 幂等键被不同 intent 复用，或 credential 的目标 Flow 歧义/当前不可用。 */
        FlowRunConflictError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["IdempotencyKeyReusedConflictErrorResponse"] | components["schemas"]["FlowTargetAmbiguousConflictErrorResponse"] | components["schemas"]["FlowTargetUnavailableConflictErrorResponse"];
            };
        };
        /** @description 请求上下文在目标查找前已失败：Workspace-Id 与 credential 不一致、browser Origin 不匹配，或缺少整个端点 scope。该响应不得用于表示某个 Run/Gate/Conversation ID 存在但不可见；ID 资源不可见统一 typed 404。 */
        ForbiddenError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["RequestContextForbiddenErrorResponse"];
            };
        };
        /**
         * @description Human Gate claim、重新授权、decision、mutation 与不可变首次 receipt 已原子提交；唯一 scope 不含 target，
         *     run_id/gate_id 位于 intent。outcome 为封闭三分支：NEXT_GATE_WAITING 只物化并返回下一 pending_action，
         *     保持 quiescent 且不写 run.resumed/attempt；RUN_RESUMED 仅表示最后一个正向 decision 已写 run.resumed、
         *     下一 attempt 与恢复 outbox；TERMINAL_INTENT_ACCEPTED 仅表示 reject 的终态意图已提交并唤醒唯一 finalizer，
         *     不写 run.resumed/attempt。三者都不表示后续执行或终态 finalization 已完成；相同 actor/key/hash 重放首次 outcome。
         */
        GateResumeAccepted: {
            headers: {
                "Idempotent-Replay": components["headers"]["IdempotentReplay"];
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["HumanGateMutationAcceptedResponse"];
            };
        };
        /** @description resume 幂等键被不同 intent 复用，或幂等 miss 时 Gate 已决/原准入事实已陈旧。 */
        GateResumeConflictError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["IdempotencyKeyReusedConflictErrorResponse"] | components["schemas"]["GateAlreadyResolvedConflictErrorResponse"] | components["schemas"]["GateStaleConflictErrorResponse"];
            };
        };
        /** @description Human Gate 已过期；error.code 固定为 GATE_EXPIRED。调用方应重新读取 Run，不能重放旧批准或假定操作仍有效。 */
        GoneError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["GateExpiredErrorResponse"];
            };
        };
        /** @description durable Run、canonical 202 acceptance receipt、积分预留和 run.accepted 事件已在同一事务中提交。相同 key/intent 的任何重放均返回该 receipt，而非首次 blocking 连接的 200 投影。 */
        OperationAccepted: {
            headers: {
                "Idempotent-Replay": components["headers"]["IdempotentReplay"];
                Location: components["headers"]["Location"];
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["OperationAcceptedResponse"];
            };
        };
        /** @description 超过 credential 或 resource 的限流阈值。 */
        RateLimitError: {
            headers: {
                "Retry-After"?: number;
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 取消请求的幂等键已被不同 Run 或不同 intent 复用。 */
        RunCancelConflictError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["IdempotencyKeyReusedConflictErrorResponse"];
            };
        };
        /** @description Run/Gate 不存在或调用方不可见；两者统一使用 error.code=RUN_NOT_FOUND，不得通过 403、消息或时延形成存在性 oracle。 */
        RunNotFoundError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["RunNotFoundErrorResponse"];
            };
        };
        /** @description Run 尚未被接受时，关键依赖或内部准入不可用；不得暗示已经创建 Run。 */
        ServiceUnavailableError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 请求、cursor 或输入 schema 无效。 */
        ValidationError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
    };
    parameters: {
        /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
        AccessKey: string;
        /** @description runEventSessionCookie 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
        BrowserEventOrigin: string;
        /** @description browserSessionBearer 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
        BrowserOrigin: string;
        /** @description events-session 是 browser-only 写操作；必须与 browser session 固定 origin 及当前 Deployment exact allowlist 相同，null/opaque/非规范 origin 被拒绝。 */
        BrowserOriginRequired: string;
        /** @description 可选调用方关联值。服务端仍为该 HTTP exchange 生成 UUIDv7 X-Request-Id。 */
        ClientRequestId: string;
        ConversationId: string;
        Cursor: string;
        GateId: string;
        /** @description 可省略；提供非空 key 时唯一范围为 workspace_id、principal_id、fixed route template、key。关联 Run 非终态时 key 永不释放；目标终态后默认 replay grace 至少 24 小时且记录保留覆盖该窗口。Run 创建重放按稳定公开 intent_hash 比较并总是返回 canonical 202 acceptance receipt，不含当前 binding、已解析目标/版本、授权决策或 Plan；这些仅作为首次 accepted_plan_hash 的事实保存。G1 conversation create 不使用本参数。 */
        IdempotencyKey: string;
        LastEventId: string;
        /** @description 会话或消息列表的服务器生成不透明 cursor。 */
        ListCursor: string;
        PageSize: number;
        /** @description Human Gate resume 必填；唯一范围为 workspace、认证 principal、fixed resume route template、key，不含 target。规范化 run_id、gate_id、action、input 位于 JCS intent；跨 Run/Gate 复用同 key 返回 409。命中先 read-gate/hash/replay，不能先检查 Gate 当前状态；关联 Run 非终态时 key 不释放，终态后至少保留 replay grace。 */
        RequiredIdempotencyKey: string;
        /** @description 兼容 Agent ID；服务端必须与 scoped credential 一起解析为唯一 active Deployment，不能由调用方选择 Release。 */
        RobotId: string;
        RunId: string;
        /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
        WorkspaceId: string;
    };
    requestBodies: never;
    headers: {
        /** @description true 表示本 HTTP exchange 重放了同一稳定 intent 的首次保存响应；当前 request_id 仍为新值。 */
        IdempotentReplay: boolean;
        /** @description 新建 Run 的资源地址。 */
        Location: string;
        /** @description 为不正确实现 Cache-Control 的旧代理提供兼容禁缓存指示。 */
        NoCache: "no-cache";
        /** @description 含 browser token 或 events cookie 的响应禁止缓存。 */
        NoStore: "no-store";
        /** @description 当前 HTTP exchange 由服务端生成的 UUIDv7 请求标识；错误响应也必须返回。 */
        RequestId: string;
        /** @description cookie 值唯一允许出现的交付位置；名称以 __Secure- 开头，host-only、不得有 Domain，且必须具有 HttpOnly、Secure、SameSite=Strict、Max-Age <= 60 和 events URL Path 属性。整个 Set-Cookie 头不得进入应用/代理日志、trace 或支持导出。 */
        RunEventSessionCookie: string;
    };
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    createAgentChatRun: {
        parameters: {
            query?: never;
            header?: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                /** @description 可省略；提供非空 key 时唯一范围为 workspace_id、principal_id、fixed route template、key。关联 Run 非终态时 key 永不释放；目标终态后默认 replay grace 至少 24 小时且记录保留覆盖该窗口。Run 创建重放按稳定公开 intent_hash 比较并总是返回 canonical 202 acceptance receipt，不含当前 binding、已解析目标/版本、授权决策或 Plan；这些仅作为首次 accepted_plan_hash 的事实保存。G1 conversation create 不使用本参数。 */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
                /** @description browserSessionBearer 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
                Origin?: components["parameters"]["BrowserOrigin"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
                /** @description 可选调用方关联值。服务端仍为该 HTTP exchange 生成 UUIDv7 X-Request-Id。 */
                "X-Client-Request-Id"?: components["parameters"]["ClientRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentChatRequest"];
            };
        };
        responses: {
            /** @description 仅首次 blocking 等待窗口内已终态的兼容响应；幂等重放不会返回此投影。 */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BlockingRunResponse"];
                };
            };
            202: components["responses"]["OperationAccepted"];
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            402: components["responses"]["CreditsError"];
            403: components["responses"]["ForbiddenError"];
            404: components["responses"]["AgentChatNotFoundError"];
            409: components["responses"]["AgentChatConflictError"];
            429: components["responses"]["RateLimitError"];
            503: components["responses"]["ServiceUnavailableError"];
        };
    };
    createAgentConversation: {
        parameters: {
            query?: never;
            header?: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                /** @description browserSessionBearer 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
                Origin?: components["parameters"]["BrowserOrigin"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
                /** @description 可选调用方关联值。服务端仍为该 HTTP exchange 生成 UUIDv7 X-Request-Id。 */
                "X-Client-Request-Id"?: components["parameters"]["ClientRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConversationCreateRequest"];
            };
        };
        responses: {
            /** @description 会话已创建 */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationResponse"];
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            403: components["responses"]["ForbiddenError"];
            429: components["responses"]["RateLimitError"];
            503: components["responses"]["ServiceUnavailableError"];
        };
    };
    listAgentConversationMessages: {
        parameters: {
            query: {
                conversation_id: components["parameters"]["ConversationId"];
                /** @description 会话或消息列表的服务器生成不透明 cursor。 */
                cursor?: components["parameters"]["ListCursor"];
                limit?: components["parameters"]["PageSize"];
            };
            header?: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                /** @description browserSessionBearer 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
                Origin?: components["parameters"]["BrowserOrigin"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 消息分页；不可见会话按不存在处理。 */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationMessagesResponse"];
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            403: components["responses"]["ForbiddenError"];
            404: components["responses"]["ConversationNotFoundError"];
        };
    };
    listAgentConversations: {
        parameters: {
            query: {
                /** @description 会话或消息列表的服务器生成不透明 cursor。 */
                cursor?: components["parameters"]["ListCursor"];
                limit?: components["parameters"]["PageSize"];
                /** @description 兼容 Agent ID；服务端必须与 scoped credential 一起解析为唯一 active Deployment，不能由调用方选择 Release。 */
                robot_id: components["parameters"]["RobotId"];
            };
            header?: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                /** @description browserSessionBearer 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
                Origin?: components["parameters"]["BrowserOrigin"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 会话分页；cursor 为不透明值，只能用于同一 Agent/credential 范围。 */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationListResponse"];
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            403: components["responses"]["ForbiddenError"];
        };
    };
    exchangeBrowserSession: {
        parameters: {
            query?: never;
            header?: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
                /** @description 可选调用方关联值。服务端仍为该 HTTP exchange 生成 UUIDv7 X-Request-Id。 */
                "X-Client-Request-Id"?: components["parameters"]["ClientRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrowserSessionExchangeRequest"];
            };
        };
        responses: {
            /** @description 已签发短期 browser session；宿主后端必须通过自身已认证 bootstrap 交给对应用户。 */
            201: {
                headers: {
                    "Cache-Control": components["headers"]["NoStore"];
                    Pragma: components["headers"]["NoCache"];
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BrowserSessionResponse"];
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            403: components["responses"]["ForbiddenError"];
            429: components["responses"]["RateLimitError"];
        };
    };
    createFlowRun: {
        parameters: {
            query?: never;
            header?: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                /** @description 可省略；提供非空 key 时唯一范围为 workspace_id、principal_id、fixed route template、key。关联 Run 非终态时 key 永不释放；目标终态后默认 replay grace 至少 24 小时且记录保留覆盖该窗口。Run 创建重放按稳定公开 intent_hash 比较并总是返回 canonical 202 acceptance receipt，不含当前 binding、已解析目标/版本、授权决策或 Plan；这些仅作为首次 accepted_plan_hash 的事实保存。G1 conversation create 不使用本参数。 */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
                /** @description 可选调用方关联值。服务端仍为该 HTTP exchange 生成 UUIDv7 X-Request-Id。 */
                "X-Client-Request-Id"?: components["parameters"]["ClientRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FlowRunRequest"];
            };
        };
        responses: {
            /** @description 仅首次 blocking 等待窗口内已终态的兼容响应；幂等重放不会返回此投影。 */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BlockingRunResponse"];
                };
            };
            202: components["responses"]["OperationAccepted"];
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            402: components["responses"]["CreditsError"];
            403: components["responses"]["FlowExecutionForbiddenError"];
            404: components["responses"]["RunNotFoundError"];
            409: components["responses"]["FlowRunConflictError"];
            503: components["responses"]["ServiceUnavailableError"];
        };
    };
    getRun: {
        parameters: {
            query?: never;
            header?: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                /** @description browserSessionBearer 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
                Origin?: components["parameters"]["BrowserOrigin"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
            };
            path: {
                run_id: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 当前或终态 Run 快照 */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunSnapshotResponse"];
                };
            };
            401: components["responses"]["AuthenticationError"];
            403: components["responses"]["ForbiddenError"];
            404: components["responses"]["RunNotFoundError"];
        };
    };
    requestRunCancellation: {
        parameters: {
            query?: never;
            header?: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                /** @description 可省略；提供非空 key 时唯一范围为 workspace_id、principal_id、fixed route template、key。关联 Run 非终态时 key 永不释放；目标终态后默认 replay grace 至少 24 小时且记录保留覆盖该窗口。Run 创建重放按稳定公开 intent_hash 比较并总是返回 canonical 202 acceptance receipt，不含当前 binding、已解析目标/版本、授权决策或 Plan；这些仅作为首次 accepted_plan_hash 的事实保存。G1 conversation create 不使用本参数。 */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
                /** @description browserSessionBearer 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
                Origin?: components["parameters"]["BrowserOrigin"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
                /** @description 可选调用方关联值。服务端仍为该 HTTP exchange 生成 UUIDv7 X-Request-Id。 */
                "X-Client-Request-Id"?: components["parameters"]["ClientRequestId"];
            };
            path: {
                run_id: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run 已是终态，返回原终态 */
            200: {
                headers: {
                    "Idempotent-Replay": components["headers"]["IdempotentReplay"];
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunSnapshotResponse"];
                };
            };
            202: components["responses"]["CancellationAccepted"];
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            403: components["responses"]["ForbiddenError"];
            404: components["responses"]["RunNotFoundError"];
            409: components["responses"]["RunCancelConflictError"];
        };
    };
    streamRunEvents: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
            };
            header?: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                "Last-Event-ID"?: components["parameters"]["LastEventId"];
                /** @description runEventSessionCookie 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
                Origin?: components["parameters"]["BrowserEventOrigin"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
            };
            path: {
                run_id: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description text/event-stream；业务事件的 id 等于 run 内 data.sequence，事件外形为 RunEvent。 */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            403: components["responses"]["ForbiddenError"];
            404: components["responses"]["RunNotFoundError"];
            409: components["responses"]["EventCursorConflictError"];
            410: components["responses"]["EventCursorExpiredError"];
        };
    };
    createBrowserRunEventSession: {
        parameters: {
            query?: never;
            header: {
                /** @description events-session 是 browser-only 写操作；必须与 browser session 固定 origin 及当前 Deployment exact allowlist 相同，null/opaque/非规范 origin 被拒绝。 */
                Origin: components["parameters"]["BrowserOriginRequired"];
                /** @description 可选调用方关联值。服务端仍为该 HTTP exchange 生成 UUIDv7 X-Request-Id。 */
                "X-Client-Request-Id"?: components["parameters"]["ClientRequestId"];
            };
            path: {
                run_id: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已设置短期单 Run events cookie session。 */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["NoStore"];
                    Pragma: components["headers"]["NoCache"];
                    "Set-Cookie": components["headers"]["RunEventSessionCookie"];
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            403: components["responses"]["ForbiddenError"];
            404: components["responses"]["RunNotFoundError"];
            429: components["responses"]["RateLimitError"];
        };
    };
    resumeHumanGate: {
        parameters: {
            query?: never;
            header: {
                /** @description 使用 workspaceAccessKey security alternative 时必须与 Workspace-Id 一起出现；browserSessionBearer alternative 必须省略。Studio 管理 API 不使用该凭据。 */
                "Access-Key"?: components["parameters"]["AccessKey"];
                /** @description Human Gate resume 必填；唯一范围为 workspace、认证 principal、fixed resume route template、key，不含 target。规范化 run_id、gate_id、action、input 位于 JCS intent；跨 Run/Gate 复用同 key 返回 409。命中先 read-gate/hash/replay，不能先检查 Gate 当前状态；关联 Run 非终态时 key 不释放，终态后至少保留 replay grace。 */
                "Idempotency-Key": components["parameters"]["RequiredIdempotencyKey"];
                /** @description browserSessionBearer 分支的 request origin。跨源请求必填并须为 RFC 6454 canonical origin；同源 GET/HEAD 合法省略时只能由受信任网关从外部 request target 推导。服务 credential 分支不得把该值当作身份。 */
                Origin?: components["parameters"]["BrowserOrigin"];
                /** @description 使用 workspaceAccessKey security alternative 时必填且必须与 credential 一致；browser principal 的 workspace 从 token 推导。 */
                "Workspace-Id"?: components["parameters"]["WorkspaceId"];
                /** @description 可选调用方关联值。服务端仍为该 HTTP exchange 生成 UUIDv7 X-Request-Id。 */
                "X-Client-Request-Id"?: components["parameters"]["ClientRequestId"];
            };
            path: {
                gate_id: components["parameters"]["GateId"];
                run_id: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HumanGateResumeRequest"];
            };
        };
        responses: {
            202: components["responses"]["GateResumeAccepted"];
            400: components["responses"]["ValidationError"];
            401: components["responses"]["AuthenticationError"];
            402: components["responses"]["CreditsError"];
            403: components["responses"]["ForbiddenError"];
            404: components["responses"]["RunNotFoundError"];
            409: components["responses"]["GateResumeConflictError"];
            410: components["responses"]["GoneError"];
            422: components["responses"]["ValidationError"];
        };
    };
}
