import { DurableObject } from 'cloudflare:workers';
import { ResultAsync } from 'neverthrow';

import { SIDECAR_INACTIVITY_TIMEOUT_MS } from './constants';
import { appError, toHttpErrorResponse, unknownToAppError } from './errors';
import { errAsync, nowIso, okAsync, parseJson } from './result';
import type { AppError, SidecarHealthResponse, StartSidecarRequest, WorkerEnv } from './types';

export class SandboxContainerSidecar extends DurableObject<WorkerEnv> {
	private monitorAttached = false;

	private refreshInactivityTimeout() {
		if (!this.ctx.container) {
			return okAsync(undefined);
		}

		return ResultAsync.fromPromise(
			this.ctx.container.setInactivityTimeout(SIDECAR_INACTIVITY_TIMEOUT_MS),
			(error: unknown) =>
				unknownToAppError(
					error,
					appError(
						500,
						'container_timeout_failed',
						'Could not refresh container inactivity timeout',
					),
				),
		).map(() => undefined);
	}

	private startContainer(payload: StartSidecarRequest) {
		if (!this.ctx.container) {
			return errAsync<SidecarHealthResponse>(
				appError(500, 'container_unavailable', 'Container binding is not available in sidecar'),
			);
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
		}

		const startedAt = nowIso();

		return ResultAsync.fromPromise(this.ctx.storage.put('startedAt', startedAt), (error: unknown) =>
			unknownToAppError(
				error,
				appError(500, 'storage_write_failed', 'Could not persist sidecar start timestamp'),
			),
		)
			.andThen(() => this.refreshInactivityTimeout())
			.andThen(() => {
				if (!this.monitorAttached && this.ctx.container) {
					this.monitorAttached = true;
					this.ctx.waitUntil(
						this.ctx.container.monitor().catch(async () => {
							await this.ctx.storage.put('stoppedAt', nowIso());
						}),
					);
				}

				return ResultAsync.fromPromise(this.ctx.storage.get<string>('startedAt'), (error: unknown) =>
					unknownToAppError(
						error,
						appError(500, 'storage_read_failed', 'Could not read sidecar start timestamp'),
					),
				).map((storedStartedAt: string | undefined) => ({
					running: this.ctx.container?.running ?? false,
					startedAt: storedStartedAt ?? null,
				}));
			});
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (request.method === 'POST' && pathname === '/start') {
			const body = await parseJson<StartSidecarRequest>(
				request,
				appError(400, 'invalid_sidecar_payload', 'Invalid sidecar start payload'),
			);

			if (body.isErr()) {
				return toHttpErrorResponse(body.error);
			}

			const started = await this.startContainer(body.value);
			return started.match(
				(result: SidecarHealthResponse) => Response.json(result),
				(error: AppError) => toHttpErrorResponse(error),
			);
		}

		if (request.method === 'GET' && pathname === '/health') {
			const health = await this.refreshInactivityTimeout().andThen(() =>
				ResultAsync.fromPromise(this.ctx.storage.get<string>('startedAt'), (error: unknown) =>
					unknownToAppError(
						error,
						appError(500, 'storage_read_failed', 'Could not read sidecar health data'),
					),
				).map((startedAt: string | undefined) => ({
					running: this.ctx.container?.running ?? false,
					startedAt: startedAt ?? null,
				})),
			);

			return health.match(
				(result: SidecarHealthResponse) => Response.json(result),
				(error: AppError) => toHttpErrorResponse(error),
			);
		}

		return Response.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
	}
}
