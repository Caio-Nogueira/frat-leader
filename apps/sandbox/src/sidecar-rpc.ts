import { ResultAsync } from 'neverthrow';

import type { SidecarHealthResponse, SpawnWorkflowParams, StartSidecarRequest, WorkerEnv } from './types';
import { appError, unknownToAppError } from './errors';

const sidecarStub = (env: WorkerEnv, sessionId: string) => {
	const id = env.SANDBOX_SIDECAR.idFromName(sessionId);
	return env.SANDBOX_SIDECAR.get(id);
};

export const startSidecar = (
	env: WorkerEnv,
	params: SpawnWorkflowParams,
	credentials: Record<string, string>,
) =>
	ResultAsync.fromPromise(
		(async () => {
			const response = await sidecarStub(env, params.sessionId).fetch(
				new Request('https://sidecar.internal/start', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						sessionId: params.sessionId,
						prompt: params.prompt,
						repositoryUrl: params.repositoryUrl,
						credentials,
					} satisfies StartSidecarRequest),
				}),
			);

			if (!response.ok) {
				throw appError(502, 'sidecar_start_failed', 'Sidecar returned non-OK response');
			}

			return (await response.json()) as SidecarHealthResponse;
		})(),
		(error: unknown) =>
			unknownToAppError(
				error,
				appError(502, 'sidecar_start_failed', 'Could not start sidecar'),
			),
	);

export const healthcheckSidecar = (env: WorkerEnv, sessionId: string) =>
	ResultAsync.fromPromise(
		(async () => {
			const response = await sidecarStub(env, sessionId).fetch(
				new Request('https://sidecar.internal/health', { method: 'GET' }),
			);

			if (!response.ok) {
				throw appError(
					502,
					'sidecar_health_failed',
					'Sidecar healthcheck returned non-OK response',
				);
			}

			return (await response.json()) as SidecarHealthResponse;
		})(),
		(error: unknown) =>
			unknownToAppError(
				error,
				appError(502, 'sidecar_health_failed', 'Could not check sidecar health'),
			),
	);
