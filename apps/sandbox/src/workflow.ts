import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

import {
	DEFAULT_SANDBOX_IMAGE,
	WORKFLOW_HEALTHCHECK_COUNT,
	WORKFLOW_HEALTHCHECK_INTERVAL,
} from './constants';
import { ensureSchema, updateSessionStatus, upsertSession } from './db';
import type { AppError, SidecarHealthResponse, SpawnWorkflowParams, WorkerEnv } from './types';
import { nowIso } from './result';
import { resolveCredentials } from './secrets';
import { healthcheckSidecar, startSidecar } from './sidecar-rpc';

export class SandboxSpawnWorkflow extends WorkflowEntrypoint<WorkerEnv, SpawnWorkflowParams> {
	async run(event: Readonly<WorkflowEvent<SpawnWorkflowParams>>, step: WorkflowStep) {
		const params = event.payload;
		const startedAt = nowIso();
		const containerImage = this.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;

		try {
			const schemaResult = await ensureSchema(this.env.SESSIONS_DB);
			if (schemaResult.isErr()) {
				throw new Error(schemaResult.error.message);
			}

			const initialSessionResult = await upsertSession(this.env.SESSIONS_DB, {
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
			if (initialSessionResult.isErr()) {
				throw new Error(initialSessionResult.error.message);
			}

			const credentials = await step.do('resolve credentials from secrets-store', async () =>
				resolveCredentials(this.env).match(
					(result: Record<string, string>) => result,
					(error: AppError) => {
						throw new Error(error.message);
					},
				),
			);

			const start = await step.do('start sidecar container', async () =>
				startSidecar(this.env, params, credentials).match(
					(result: SidecarHealthResponse) => result,
					(error: AppError) => {
						throw new Error(error.message);
					},
				),
			);

			const runningSessionResult = await updateSessionStatus(
				this.env.SESSIONS_DB,
				params.sessionId,
				'running',
				{
					lastHealthStatus: start.running ? 'healthy' : 'unhealthy',
					lastHealthcheckAt: nowIso(),
					error: null,
				},
			);
			if (runningSessionResult.isErr()) {
				throw new Error(runningSessionResult.error.message);
			}

			for (let checkIndex = 0; checkIndex < WORKFLOW_HEALTHCHECK_COUNT; checkIndex += 1) {
				await step.sleep(
					`sleep before healthcheck #${checkIndex + 1}`,
					WORKFLOW_HEALTHCHECK_INTERVAL,
				);

				const health = await step.do(`healthcheck #${checkIndex + 1}`, async () =>
					healthcheckSidecar(this.env, params.sessionId).match(
						(result: SidecarHealthResponse) => result,
						(error: AppError) => {
							throw new Error(error.message);
						},
					),
				);

				const persist = await updateSessionStatus(
					this.env.SESSIONS_DB,
					params.sessionId,
					'waiting',
					{
						lastHealthStatus: health.running ? 'healthy' : 'unhealthy',
						lastHealthcheckAt: nowIso(),
						error: null,
					},
				);

				if (persist.isErr()) {
					throw new Error(persist.error.message);
				}

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
			const message = error instanceof Error ? error.message : 'Workflow failed';
			await updateSessionStatus(this.env.SESSIONS_DB, params.sessionId, 'errored', {
				lastHealthStatus: 'unhealthy',
				lastHealthcheckAt: nowIso(),
				error: message,
			});
			throw error;
		}
	}
}
