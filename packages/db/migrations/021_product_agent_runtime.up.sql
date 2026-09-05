-- Product-facing conversation and Run history bound to immutable Agent releases.
-- The runtime role can invoke only the bounded definer surface below.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.agent_product_conversations (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  agent_id uuid NOT NULL,
  release_version bigint NOT NULL CHECK (release_version > 0),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id, release_version)
    REFERENCES public.agent_product_releases(workspace_id, agent_id, version)
);

CREATE TABLE public.agent_product_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  input_text text NOT NULL CHECK (length(btrim(input_text)) BETWEEN 1 AND 8000),
  output_text text CHECK (output_text IS NULL OR length(btrim(output_text)) BETWEEN 1 AND 50000),
  model text NOT NULL CHECK (model IN ('gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-sol')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 200),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, conversation_id, sequence),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES public.agent_product_conversations(workspace_id, id),
  CHECK (
    (status = 'pending' AND output_text IS NULL AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'completed' AND output_text IS NOT NULL AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND output_text IS NULL AND completed_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX agent_product_runs_conversation_idx
  ON public.agent_product_runs (workspace_id, conversation_id, sequence);
CREATE INDEX agent_product_runs_recent_idx
  ON public.agent_product_runs (workspace_id, created_at DESC, id);

ALTER TABLE public.agent_product_conversations OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_runs OWNER TO ba_authorization_owner;
ALTER INDEX public.agent_product_runs_conversation_idx OWNER TO ba_authorization_owner;
ALTER INDEX public.agent_product_runs_recent_idx OWNER TO ba_authorization_owner;

ALTER TABLE public.agent_product_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_product_conversations_owner_only ON public.agent_product_conversations
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY agent_product_runs_owner_only ON public.agent_product_runs
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.agent_product_conversations, public.agent_product_runs FROM PUBLIC;
REVOKE ALL ON public.agent_product_conversations, public.agent_product_runs FROM ba_runtime;

CREATE FUNCTION app.create_agent_product_conversation(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_actor_id uuid
) RETURNS public.agent_product_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_release_version bigint;
  v_row public.agent_product_conversations;
BEGIN
  SELECT max(release.version) INTO v_release_version
  FROM public.agent_product_releases AS release
  WHERE release.workspace_id = p_workspace_id
    AND release.agent_id = p_agent_id;
  IF v_release_version IS NULL THEN
    RAISE EXCEPTION 'agent has no published release' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.agent_product_conversations (
    workspace_id, id, agent_id, release_version, actor_id
  ) VALUES (
    p_workspace_id, gen_random_uuid(), p_agent_id, v_release_version, p_actor_id
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.begin_agent_product_run(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_actor_id uuid,
  p_input_text text
) RETURNS TABLE (
  run_id uuid,
  conversation_id uuid,
  agent_id uuid,
  sequence bigint,
  instructions text,
  model text,
  input_text text,
  history jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_conversation public.agent_product_conversations;
  v_release public.agent_product_releases;
  v_run_id uuid := gen_random_uuid();
  v_sequence bigint;
  v_history jsonb;
BEGIN
  SELECT conversation.* INTO v_conversation
  FROM public.agent_product_conversations AS conversation
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
    AND conversation.actor_id = p_actor_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT release.* INTO STRICT v_release
  FROM public.agent_product_releases AS release
  WHERE release.workspace_id = v_conversation.workspace_id
    AND release.agent_id = v_conversation.agent_id
    AND release.version = v_conversation.release_version;
  SELECT COALESCE(max(run.sequence), 0) + 1 INTO v_sequence
  FROM public.agent_product_runs AS run
  WHERE run.workspace_id = p_workspace_id
    AND run.conversation_id = p_conversation_id;
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('user', run.input_text, 'assistant', run.output_text)
      ORDER BY run.sequence
    ),
    '[]'::jsonb
  ) INTO v_history
  FROM (
    SELECT previous.input_text, previous.output_text, previous.sequence
    FROM public.agent_product_runs AS previous
    WHERE previous.workspace_id = p_workspace_id
      AND previous.conversation_id = p_conversation_id
      AND previous.status = 'completed'
    ORDER BY previous.sequence DESC
    LIMIT 20
  ) AS run;
  INSERT INTO public.agent_product_runs (
    workspace_id, id, conversation_id, sequence, input_text, model
  ) VALUES (
    p_workspace_id, v_run_id, p_conversation_id, v_sequence, btrim(p_input_text), v_release.model
  );
  UPDATE public.agent_product_conversations
  SET updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_conversation_id;
  RETURN QUERY SELECT v_run_id, v_conversation.id, v_conversation.agent_id, v_sequence,
    v_release.instructions, v_release.model, btrim(p_input_text), v_history;
END;
$function$;

CREATE FUNCTION app.complete_agent_product_run(
  p_workspace_id uuid,
  p_run_id uuid,
  p_actor_id uuid,
  p_output_text text,
  p_provider_request_id text,
  p_input_tokens bigint,
  p_output_tokens bigint
) RETURNS public.agent_product_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_product_runs;
BEGIN
  UPDATE public.agent_product_runs
  SET status = 'completed',
      output_text = p_output_text,
      provider_request_id = p_provider_request_id,
      input_tokens = p_input_tokens,
      output_tokens = p_output_tokens,
      completed_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_run_id AND status = 'pending'
    AND EXISTS (
      SELECT 1 FROM public.agent_product_conversations AS conversation
      WHERE conversation.workspace_id = p_workspace_id
        AND conversation.id = agent_product_runs.conversation_id
        AND conversation.actor_id = p_actor_id
    )
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product Run terminal conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.fail_agent_product_run(
  p_workspace_id uuid,
  p_run_id uuid,
  p_actor_id uuid,
  p_error_code text
) RETURNS public.agent_product_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_product_runs;
BEGIN
  UPDATE public.agent_product_runs
  SET status = 'failed', error_code = p_error_code, completed_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_run_id AND status = 'pending'
    AND EXISTS (
      SELECT 1 FROM public.agent_product_conversations AS conversation
      WHERE conversation.workspace_id = p_workspace_id
        AND conversation.id = agent_product_runs.conversation_id
        AND conversation.actor_id = p_actor_id
    )
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product Run terminal conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.list_agent_product_runs(p_workspace_id uuid)
RETURNS SETOF public.agent_product_runs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT run.* FROM public.agent_product_runs AS run
  WHERE run.workspace_id = p_workspace_id
  ORDER BY run.created_at DESC, run.id
  LIMIT 200;
$function$;

ALTER FUNCTION app.create_agent_product_conversation(uuid, uuid, uuid)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.begin_agent_product_run(uuid, uuid, uuid, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.complete_agent_product_run(uuid, uuid, uuid, text, text, bigint, bigint)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.fail_agent_product_run(uuid, uuid, uuid, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_product_runs(uuid)
  OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.create_agent_product_conversation(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.begin_agent_product_run(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_agent_product_run(uuid, uuid, uuid, text, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_agent_product_run(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_agent_product_runs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_agent_product_conversation(uuid, uuid, uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.begin_agent_product_run(uuid, uuid, uuid, text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.complete_agent_product_run(uuid, uuid, uuid, text, text, bigint, bigint) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.fail_agent_product_run(uuid, uuid, uuid, text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.list_agent_product_runs(uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
