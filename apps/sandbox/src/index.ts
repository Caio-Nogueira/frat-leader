import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

type SessionStatus = 'scheduled' | 'running' | 'waiting' | 'errored';

type SpawnSessionRequest = {
	userId: string;
	prompt: string;
	repositoryUrl?: string;
	sessionId?: string;
};

type SpawnWorkflowParams = {
	sessionId: string;
	userId: string;
	prompt: string;
	repositoryUrl?: string;
};

type StartSidecarRequest = {
	sessionId: string;
	prompt: string;
	repositoryUrl?: string;
	credentials: Record<string, string>;
};

type SidecarHealthResponse = {
	running: boolean;
	startedAt: string | null;
};

type SessionRow = {
	session_id: string;
	user_id: string;
	workflow_instance_id: string;
	sidecar_name: string;
	status: SessionStatus;
	prompt: string;
	repository_url: string | null;
	container_image: string;
	last_health_status: string | null;
	last_healthcheck_at: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
};

interface WorkerEnv {
	SESSIONS_DB: D1Database;
	SANDBOX_SIDECAR: DurableObjectNamespace<SandboxContainerSidecar>;
	SANDBOX_SPAWN_WORKFLOW: Workflow<SpawnWorkflowParams>;
	OPENAI_API_KEY?: SecretsStoreSecret;
	ANTHROPIC_API_KEY?: SecretsStoreSecret;
	GITHUB_TOKEN?: SecretsStoreSecret;
	SANDBOX_IMAGE?: string;
}

const SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sandbox_sessions (
	session_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	workflow_instance_id TEXT NOT NULL,
	sidecar_name TEXT NOT NULL,
	status TEXT NOT NULL,
	prompt TEXT NOT NULL,
	repository_url TEXT,
	container_image TEXT NOT NULL,
	last_health_status TEXT,
	last_healthcheck_at TEXT,
	error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`;

const DEFAULT_SANDBOX_IMAGE = 'docker.io/library/node:22';
const SIDECAR_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const WORKFLOW_HEALTHCHECK_COUNT = 12;
const WORKFLOW_HEALTHCHECK_INTERVAL = '30 seconds';

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
		},
	});

const nowIso = (): string => new Date().toISOString();

const getSecret = async (secret?: SecretsStoreSecret): Promise<string | undefined> => {
	if (!secret) {
		return undefined;
	}

	try {
		return await secret.get();
	} catch {
		return undefined;
	}
};

const resolveCredentials = async (
	env: WorkerEnv,
): Promise<Record<string, string>> => {
	const [openAiKey, anthropicKey, githubToken] = await Promise.all([
		getSecret(env.OPENAI_API_KEY),
		getSecret(env.ANTHROPIC_API_KEY),
		getSecret(env.GITHUB_TOKEN),
	]);

	return {
		...(openAiKey ? { OPENAI_API_KEY: openAiKey } : {}),
		...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
		...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
	};
};

const ensureSchema = async (db: D1Database): Promise<void> => {
	await db.exec(SESSION_SCHEMA_SQL);
};

const upsertSession = async (db: D1Database, row: SessionRow): Promise<void> => {
	await db
		.prepare(
			`INSERT INTO sandbox_sessions (
				session_id,
				user_id,
				workflow_instance_id,
				sidecar_name,
				status,
				prompt,
				repository_url,
				container_image,
				last_health_status,
				last_healthcheck_at,
				error,
				created_at,
				updated_at
			)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
			ON CONFLICT(session_id)
			DO UPDATE SET
				workflow_instance_id = excluded.workflow_instance_id,
				sidecar_name = excluded.sidecar_name,
				status = excluded.status,
				prompt = excluded.prompt,
				repository_url = excluded.repository_url,
				container_image = excluded.container_image,
				last_health_status = excluded.last_health_status,
				last_healthcheck_at = excluded.last_healthcheck_at,
				error = excluded.error,
				updated_at = excluded.updated_at`,
		)
		.bind(
			row.session_id,
			row.user_id,
			row.workflow_instance_id,
			row.sidecar_name,
			row.status,
			row.prompt,
			row.repository_url,
			row.container_image,
			row.last_health_status,
			row.last_healthcheck_at,
			row.error,
			row.created_at,
			row.updated_at,
		)
		.run();
};

const updateSessionStatus = async (
	db: D1Database,
	sessionId: string,
	status: SessionStatus,
	patch: {
		lastHealthStatus?: string;
		lastHealthcheckAt?: string;
		error?: string | null;
	} = {},
): Promise<void> => {
	await db
		.prepare(
			`UPDATE sandbox_sessions
			SET status = ?2,
				last_health_status = COALESCE(?3, last_health_status),
				last_healthcheck_at = COALESCE(?4, last_healthcheck_at),
				error = ?5,
				updated_at = ?6
			WHERE session_id = ?1`,
		)
		.bind(
			sessionId,
			status,
			patch.lastHealthStatus ?? null,
			patch.lastHealthcheckAt ?? null,
			patch.error ?? null,
			nowIso(),
		)
		.run();
};

const readSession = async (db: D1Database, sessionId: string): Promise<SessionRow | null> => {
	const result = await db
		.prepare(
			`SELECT
				session_id,
				user_id,
				workflow_instance_id,
				sidecar_name,
				status,
				prompt,
				repository_url,
				container_image,
				last_health_status,
				last_healthcheck_at,
				error,
				created_at,
				updated_at
			FROM sandbox_sessions
			WHERE session_id = ?1`,
		)
		.bind(sessionId)
		.first<SessionRow>();

	return result ?? null;
};

const sidecarStub = (
	env: WorkerEnv,
	sessionId: string,
): DurableObjectStub<SandboxContainerSidecar> => {
	const id = env.SANDBOX_SIDECAR.idFromName(sessionId);
	return env.SANDBOX_SIDECAR.get(id);
};

const startSidecar = async (
	env: WorkerEnv,
	params: SpawnWorkflowParams,
	credentials: Record<string, string>,
): Promise<SidecarHealthResponse> => {
	const response = await sidecarStub(env, params.sessionId).fetch(
		new Request('https://sidecar.internal/start', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				sessionId: params.sessionId,
				prompt: params.prompt,
				repositoryUrl: params.repositoryUrl,
				credentials,
			} satisfies StartSidecarRequest),
		}),
	);

	if (!response.ok) {
		throw new Error(`Could not start sidecar for session "${params.sessionId}"`);
	}

	return (await response.json()) as SidecarHealthResponse;
};

const healthcheckSidecar = async (
	env: WorkerEnv,
	sessionId: string,
): Promise<SidecarHealthResponse> => {
	const response = await sidecarStub(env, sessionId).fetch(
		new Request('https://sidecar.internal/health', {
			method: 'GET',
		}),
	);

	if (!response.ok) {
		throw new Error(`Could not check sidecar health for session "${sessionId}"`);
	}

	return (await response.json()) as SidecarHealthResponse;
};

export class SandboxSpawnWorkflow extends WorkflowEntrypoint<WorkerEnv, SpawnWorkflowParams> {
	override async run(event: Readonly<WorkflowEvent<SpawnWorkflowParams>>, step: WorkflowStep) {
		const params = event.payload;
		const startedAt = nowIso();
		const containerImage = this.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;

		try {
			await step.do('ensure sessions schema', async () => {
				await ensureSchema(this.env.SESSIONS_DB);
			});

			await step.do('store scheduled metadata', async () => {
				await upsertSession(this.env.SESSIONS_DB, {
					session_id: params.sessionId,
					user_id: params.userId,
					workflow_instance_id: event.instanceId,
					sidecar_name: params.sessionId,
					status: 'scheduled',
					prompt: params.prompt,
					repository_url: params.repositoryUrl ?? null,
					container_image: containerImage,
					last_health_status: null,
					last_healthcheck_at: null,
					error: null,
					created_at: startedAt,
					updated_at: startedAt,
				});
			});

			const credentials = await step.do('resolve credentials from secrets-store', async () =>
				resolveCredentials(this.env),
			);

			const start = await step.do('start sidecar container', async () =>
				startSidecar(this.env, params, credentials),
			);

			await step.do('store running metadata', async () => {
				await updateSessionStatus(this.env.SESSIONS_DB, params.sessionId, 'running', {
					lastHealthStatus: start.running ? 'healthy' : 'unhealthy',
					lastHealthcheckAt: nowIso(),
				});
			});

			for (let checkIndex = 0; checkIndex < WORKFLOW_HEALTHCHECK_COUNT; checkIndex += 1) {
				await step.sleep(
					`sleep before healthcheck #${checkIndex + 1}`,
					WORKFLOW_HEALTHCHECK_INTERVAL,
				);

				const health = await step.do(`healthcheck #${checkIndex + 1}`, async () =>
					healthcheckSidecar(this.env, params.sessionId),
				);
				const checkedAt = nowIso();

				await step.do(`persist healthcheck #${checkIndex + 1}`, async () => {
					await updateSessionStatus(this.env.SESSIONS_DB, params.sessionId, 'waiting', {
						lastHealthStatus: health.running ? 'healthy' : 'unhealthy',
						lastHealthcheckAt: checkedAt,
					});
				});

				if (!health.running) {
					throw new Error('Container sidecar is no longer running');
				}
			}

			return {
				sessionId: params.sessionId,
				status: 'waiting',
				message: 'Container is running and workflow keepalive loop completed',
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'unknown workflow error';
			await updateSessionStatus(this.env.SESSIONS_DB, params.sessionId, 'errored', {
				lastHealthStatus: 'unhealthy',
				lastHealthcheckAt: nowIso(),
				error: message,
			});
			throw error;
		}
	}
}

export class SandboxContainerSidecar extends DurableObject<WorkerEnv> {
	private monitorAttached = false;

	private async refreshInactivityTimeout(): Promise<void> {
		if (!this.ctx.container) {
			return;
		}

		await this.ctx.container.setInactivityTimeout(SIDECAR_INACTIVITY_TIMEOUT_MS);
	}

	private async startContainer(payload: StartSidecarRequest): Promise<SidecarHealthResponse> {
		if (!this.ctx.container) {
			throw new Error('Container binding is not available in sidecar');
		}

		if (!this.ctx.container.running) {
			this.ctx.container.start({
				enableInternet: true,
				env: {
					...payload.credentials,
					OPENCODE_TASK_PROMPT: payload.prompt,
					SESSION_ID: payload.sessionId,
					REPOSITORY_URL: payload.repositoryUrl ?? '',
				},
				entrypoint: [
					'sh',
					'-lc',
					'node --version && if command -v opencode >/dev/null 2>&1; then opencode run "$OPENCODE_TASK_PROMPT"; fi && tail -f /dev/null',
				],
			});

			const startedAt = nowIso();
			await this.ctx.storage.put('startedAt', startedAt);
		}

		await this.refreshInactivityTimeout();

		if (!this.monitorAttached) {
			this.monitorAttached = true;
			this.ctx.waitUntil(
				this.ctx.container.monitor().catch(async () => {
					await this.ctx.storage.put('stoppedAt', nowIso());
				}),
			);
		}

		return {
			running: this.ctx.container.running,
			startedAt: (await this.ctx.storage.get<string>('startedAt')) ?? null,
		};
	}

	override async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (request.method === 'POST' && pathname === '/start') {
			const payload = (await request.json()) as StartSidecarRequest;
			const result = await this.startContainer(payload);
			return json(result);
		}

		if (request.method === 'GET' && pathname === '/health') {
			await this.refreshInactivityTimeout();
			return json({
				running: this.ctx.container?.running ?? false,
				startedAt: (await this.ctx.storage.get<string>('startedAt')) ?? null,
			} satisfies SidecarHealthResponse);
		}

		return json(
			{
				error: 'Not found',
			},
			404,
		);
	}
}

const parseCreateSessionRequest = async (
	request: Request,
): Promise<SpawnSessionRequest | null> => {
	const payload = (await request.json()) as Partial<SpawnSessionRequest>;

	if (!payload.userId || !payload.prompt) {
		return null;
	}

	return {
		userId: payload.userId,
		prompt: payload.prompt,
		repositoryUrl: payload.repositoryUrl,
		sessionId: payload.sessionId,
	};
};

const createSession = async (request: Request, env: WorkerEnv): Promise<Response> => {
	const payload = await parseCreateSessionRequest(request);
	if (!payload) {
		return json(
			{
				error: 'Invalid payload. `userId` and `prompt` are required.',
			},
			400,
		);
	}

	const sessionId = payload.sessionId ?? crypto.randomUUID();
	const now = nowIso();
	const workflow = await env.SANDBOX_SPAWN_WORKFLOW.create({
		id: `spawn-${sessionId}`,
		params: {
			sessionId,
			userId: payload.userId,
			prompt: payload.prompt,
			repositoryUrl: payload.repositoryUrl,
		},
	});

	await ensureSchema(env.SESSIONS_DB);
	await upsertSession(env.SESSIONS_DB, {
		session_id: sessionId,
		user_id: payload.userId,
		workflow_instance_id: workflow.id,
		sidecar_name: sessionId,
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

	return json(
		{
			sessionId,
			workflowInstanceId: workflow.id,
			status: 'scheduled',
		},
		202,
	);
};

const getSessionIdFromPath = (pathname: string): string | null => {
	const match = pathname.match(/^\/sessions\/([^/]+)$/);
	return match?.[1] ?? null;
};

const getSession = async (sessionId: string, env: WorkerEnv): Promise<Response> => {
	await ensureSchema(env.SESSIONS_DB);
	const session = await readSession(env.SESSIONS_DB, sessionId);
	if (!session) {
		return json(
			{
				error: 'Session not found',
			},
			404,
		);
	}

	return json(session);
};

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (request.method === 'GET' && pathname === '/') {
			return json({
				name: 'sandbox worker-api',
				health: 'ok',
			});
		}

		if (request.method === 'POST' && pathname === '/sessions') {
			return createSession(request, env);
		}

		if (request.method === 'GET') {
			const sessionId = getSessionIdFromPath(pathname);
			if (sessionId) {
				return getSession(sessionId, env);
			}
		}

		return json(
			{
				error: 'Not found',
			},
			404,
		);
	},
} satisfies ExportedHandler<WorkerEnv>;
