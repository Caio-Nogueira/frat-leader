import type { Context } from 'hono';
import { Hono } from 'hono';
import { ResultAsync } from 'neverthrow';

import { DEFAULT_SANDBOX_IMAGE } from './constants';
import { ensureSchema, readSession, upsertSession } from './db';
import { appError, unknownToAppError } from './errors';
import { nowIso, parseJson } from './result';
import { resolveCredentials } from './secrets';
import { SandboxContainerSidecar } from './sidecar';
import { healthcheckSidecar, proxySidecarOpencodeRequest, startSidecar } from './sidecar-rpc';
import type { SessionRow, SpawnSessionRequest, WorkerEnv } from './types';
import { SandboxSpawnWorkflow } from './workflow';

const app = new Hono<{ Bindings: WorkerEnv }>();

const parseCreateSessionRequest = (payload: Partial<SpawnSessionRequest>) => {
	if (!payload.userId || !payload.prompt) {
		return {
			ok: false as const,
			error: appError(400, 'invalid_payload', 'Invalid payload. `userId` and `prompt` are required.'),
		};
	}

	return {
		ok: true as const,
		value: {
			userId: payload.userId,
			prompt: payload.prompt,
			repositoryUrl: payload.repositoryUrl,
			sessionId: payload.sessionId,
		} satisfies SpawnSessionRequest,
	};
};

app.get('/', (c: Context<{ Bindings: WorkerEnv }>) =>
	c.json({
		name: 'sandbox worker-api',
		health: 'ok',
	})
);

app.post('/sessions', async (c: Context<{ Bindings: WorkerEnv }>) => {
	const jsonPayload = await parseJson<Partial<SpawnSessionRequest>>(c.req.raw, appError(400, 'invalid_json', 'Invalid JSON body'));

	if (jsonPayload.isErr()) {
		return c.json({ error: jsonPayload.error.message, code: jsonPayload.error.code }, jsonPayload.error.status as 400);
	}

	const parsedPayload = parseCreateSessionRequest(jsonPayload.value);
	if (!parsedPayload.ok) {
		return c.json({ error: parsedPayload.error.message, code: parsedPayload.error.code }, parsedPayload.error.status as 400);
	}

	const payload = parsedPayload.value;
	const sessionId = payload.sessionId ?? crypto.randomUUID();
	const now = nowIso();
	const env = c.env;

	const schemaResult = await ensureSchema(env.SESSIONS_DB);
	if (schemaResult.isErr()) {
		return c.json({ error: schemaResult.error.message, code: schemaResult.error.code }, schemaResult.error.status as 500);
	}

	const workflowResult = await ResultAsync.fromPromise(
		env.SANDBOX_SPAWN_WORKFLOW.create({
			id: `spawn-${sessionId}`,
			params: {
				sessionId,
				userId: payload.userId,
				prompt: payload.prompt,
				repositoryUrl: payload.repositoryUrl,
			},
		}),
		(error: unknown) => unknownToAppError(error, appError(502, 'workflow_create_failed', 'Could not schedule spawn workflow'))
	);
	if (workflowResult.isErr()) {
		return c.json({ error: workflowResult.error.message, code: workflowResult.error.code }, workflowResult.error.status as 502);
	}

	const workflow = workflowResult.value;
	const persisted = await upsertSession(env.SESSIONS_DB, {
		session_id: sessionId,
		user_id: payload.userId,
		workflow_instance_id: workflow.id,
		sidecar_name: sessionId,
		// TODO: this status doesn't do much
		// figure a better way of holding this information, or drop it
		status: 'scheduled', 
		prompt: payload.prompt,
		repository_url: payload.repositoryUrl ?? null,
		container_image: env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
		last_health_status: null,
		last_healthcheck_at: null,
		error: null,
		created_at: now,
		updated_at: now,
	});
	if (persisted.isErr()) {
		return c.json({ error: persisted.error.message, code: persisted.error.code }, persisted.error.status as 500);
	}

	return c.json(
		{
			sessionId,
			workflowInstanceId: workflow.id,
			status: 'scheduled',
		},
		202
	);
});

app.get('/sessions/:sessionId', async (c: Context<{ Bindings: WorkerEnv }>) => {
	const schemaResult = await ensureSchema(c.env.SESSIONS_DB);
	if (schemaResult.isErr()) {
		return c.json({ error: schemaResult.error.message, code: schemaResult.error.code }, schemaResult.error.status as 500);
	}

	const result = await readSession(c.env.SESSIONS_DB, c.req.param('sessionId'));

	return result.match(
		(session: SessionRow | null) => (session ? c.json(session) : c.json({ error: 'Session not found', code: 'session_not_found' }, 404)),
		(error) => c.json({ error: error.message, code: error.code }, error.status as 500)
	);
});

app.get('/sessions/:sessionId/health', async (c: Context<{ Bindings: WorkerEnv }>) => {
	const sessionId = c.req.param('sessionId');
	const schemaResult = await ensureSchema(c.env.SESSIONS_DB);
	if (schemaResult.isErr()) {
		return c.json({ error: schemaResult.error.message, code: schemaResult.error.code }, schemaResult.error.status as 500);
	}

	const sessionResult = await readSession(c.env.SESSIONS_DB, sessionId);
	if (sessionResult.isErr()) {
		return c.json({ error: sessionResult.error.message, code: sessionResult.error.code }, sessionResult.error.status as 500);
	}

	if (!sessionResult.value) {
		return c.json({ error: 'Session not found', code: 'session_not_found' }, 404);
	}

	const healthResult = await healthcheckSidecar(c.env, sessionId);
	return healthResult.match(
		(result) => c.json(result),
		(error) => c.json({ error: error.message, code: error.code }, error.status as 502)
	);
});

const proxyOpencodeRequest = async (c: Context<{ Bindings: WorkerEnv }>) => {
	const sessionId = c.req.param('sessionId');
	const schemaResult = await ensureSchema(c.env.SESSIONS_DB);
	if (schemaResult.isErr()) {
		return c.json({ error: schemaResult.error.message, code: schemaResult.error.code }, schemaResult.error.status as 500);
	}

	const sessionResult = await readSession(c.env.SESSIONS_DB, sessionId);
	if (sessionResult.isErr()) {
		return c.json({ error: sessionResult.error.message, code: sessionResult.error.code }, sessionResult.error.status as 500);
	}

	if (!sessionResult.value) {
		return c.json({ error: 'Session not found', code: 'session_not_found' }, 404);
	}
	const session = sessionResult.value;

	const healthResult = await healthcheckSidecar(c.env, sessionId);
	const sidecarIsRunning = healthResult.isOk() && healthResult.value.running;
	if (!sidecarIsRunning) {
		const credentialsResult = await resolveCredentials(c.env);
		if (credentialsResult.isErr()) {
			return c.json(
				{ error: credentialsResult.error.message, code: credentialsResult.error.code },
				credentialsResult.error.status as 500,
			);
		}

		if (!credentialsResult.value.ZAI_API_KEY) {
			return c.json(
				{ error: 'Missing credentials: configure ZAI_API_KEY in Secrets Store', code: 'missing_credentials' },
				500,
			);
		}

		const started = await startSidecar(
			c.env,
			{
				sessionId: session.session_id,
				userId: session.user_id,
				prompt: session.prompt,
				repositoryUrl: session.repository_url ?? undefined,
			},
			credentialsResult.value,
		);
		if (started.isErr()) {
			return c.json({ error: started.error.message, code: started.error.code }, started.error.status as 502);
		}
	}

	const requestUrl = new URL(c.req.url);
	const sidecarPathPrefix = `/sessions/${sessionId}`;
	const sidecarPath = requestUrl.pathname.startsWith(sidecarPathPrefix) ? requestUrl.pathname.slice(sidecarPathPrefix.length) : '/opencode';

	const target = `${sidecarPath}${requestUrl.search}`;
	const proxied = await proxySidecarOpencodeRequest(c.env, sessionId, c.req.raw, target);

	return proxied.match(
		(response: Response) => response,
		(error) => c.json({ error: error.message, code: error.code }, error.status as 502)
	);
};

app.all('/sessions/:sessionId/opencode', proxyOpencodeRequest);
app.all('/sessions/:sessionId/opencode/*', proxyOpencodeRequest);

export { SandboxContainerSidecar, SandboxSpawnWorkflow };
export default app;
