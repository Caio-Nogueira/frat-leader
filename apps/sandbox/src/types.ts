export type SessionStatus = 'scheduled' | 'running' | 'waiting' | 'errored';

export type SpawnSessionRequest = {
	userId: string;
	prompt: string;
	repositoryUrl?: string;
	sessionId?: string;
};

export type SpawnWorkflowParams = {
	sessionId: string;
	userId: string;
	prompt: string;
	repositoryUrl?: string;
};

export type StartSidecarRequest = {
	sessionId: string;
	prompt: string;
	repositoryUrl?: string;
	credentials: Record<string, string>;
};

export type SidecarHealthResponse = {
	running: boolean;
	startedAt: string | null;
	stoppedAt?: string | null;
	startCount?: number;
	stopCount?: number;
};

export type SessionRow = {
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

export type SandboxSchema = {
	sandbox_sessions: SessionRow;
};

export type WorkerEnv = {
	SESSIONS_DB: D1Database;
	SANDBOX_SIDECAR: DurableObjectNamespace;
	SANDBOX_SPAWN_WORKFLOW: Workflow<SpawnWorkflowParams>;
	ZAI_API_KEY?: SecretsStoreSecret;
	SANDBOX_IMAGE?: string;
};

export type AppError = {
	code: string;
	message: string;
	status: number;
};
