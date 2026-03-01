import { DurableObject } from 'cloudflare:workers';
import { ResultAsync } from 'neverthrow';

import { SIDECAR_INACTIVITY_TIMEOUT_MS } from './constants';
import { appError, toHttpErrorResponse, unknownToAppError } from './errors';
import { errAsync, nowIso, okAsync, parseJson } from './result';
import type { AppError, SidecarHealthResponse, StartSidecarRequest, WorkerEnv } from './types';

export class SandboxContainerSidecar extends DurableObject<WorkerEnv> {
	private monitorAttached = false;
	private static readonly opencodePort = 4096;
	private static readonly methodsWithoutBody = new Set(['GET', 'HEAD']);
	private static readonly startupRetryCount = 20;
	private static readonly startupRetryDelayMs = 250;

	private bumpCounter(key: string) {
		return ResultAsync.fromPromise(
			(async () => {
				const current = (await this.ctx.storage.get<number>(key)) ?? 0;
				const next = current + 1;
				await this.ctx.storage.put(key, next);
				return next;
			})(),
			(error: unknown) => unknownToAppError(error, appError(500, 'storage_write_failed', `Could not update sidecar counter: ${key}`))
		);
	}

	private refreshInactivityTimeout() {
		if (!this.ctx.container) {
			return okAsync(undefined);
		}

		return ResultAsync.fromPromise(this.ctx.container.setInactivityTimeout(SIDECAR_INACTIVITY_TIMEOUT_MS), (error: unknown) =>
			unknownToAppError(error, appError(500, 'container_timeout_failed', 'Could not refresh container inactivity timeout'))
		).map(() => undefined);
	}

	private startContainer(payload: StartSidecarRequest) {
		if (!this.ctx.container) {
			const err = appError(
				500,
				'container_unavailable',
				'Container binding is not available in sidecar (check wrangler dev.enable_containers and container configuration)'
			);
			console.error(err);
			return errAsync<SidecarHealthResponse>(err);
		}

		let didStartContainer = false;
		if (!this.ctx.container.running) {
			didStartContainer = true;
			this.ctx.container.start({
				enableInternet: true,
				env: {
					...payload.credentials,
					OPENCODE_TASK_PROMPT: payload.prompt,
					SESSION_ID: payload.sessionId,
					REPOSITORY_URL: payload.repositoryUrl ?? '',
					OPENCODE_PORT: `${SandboxContainerSidecar.opencodePort}`,
					OPENCODE_MODEL: 'zai/glm-4.7',
				},
				entrypoint: ['opencode', 'serve', '--hostname', '0.0.0.0', '--port', `${SandboxContainerSidecar.opencodePort}`, '--print-logs'],
			});
		}

		return (
			didStartContainer
				? ResultAsync.fromPromise(this.ctx.storage.put('startedAt', nowIso()), (error: unknown) =>
						unknownToAppError(error, appError(500, 'storage_write_failed', 'Could not persist sidecar start timestamp'))
					).andThen(() => this.bumpCounter('startCount').map(() => undefined))
				: okAsync(undefined)
		)
			.andThen(() => this.refreshInactivityTimeout())
			.andThen(() => {
				if (!this.monitorAttached && this.ctx.container) {
					this.monitorAttached = true;
					this.ctx.waitUntil(
						this.ctx.container.monitor().catch(async () => {
							await this.ctx.storage.put('stoppedAt', nowIso());
							await this.ctx.storage.put('stopCount', ((await this.ctx.storage.get<number>('stopCount')) ?? 0) + 1);
						})
					);
				}

				// TODO: use the sync `this.ctx.storage.kv.` apis instead
				return ResultAsync.fromPromise(
					Promise.all([
						this.ctx.storage.get<string>('startedAt'),
						this.ctx.storage.get<string>('stoppedAt'),
						this.ctx.storage.get<number>('startCount'),
						this.ctx.storage.get<number>('stopCount'),
					]),
					(error: unknown) => unknownToAppError(error, appError(500, 'storage_read_failed', 'Could not read sidecar start timestamp'))
				).map(([storedStartedAt, stoppedAt, startCount, stopCount]) => ({
					running: this.ctx.container?.running ?? false,
					startedAt: storedStartedAt ?? null,
					stoppedAt: stoppedAt ?? null,
					startCount: startCount ?? 0,
					stopCount: stopCount ?? 0,
				}));
			});
	}

	private proxyToOpencode(request: Request) {
		const container = this.ctx.container;
		if (!container || !container.running) {
			return errAsync<Response>(appError(409, 'container_not_running', 'Container is not running'));
		}

		return this.refreshInactivityTimeout().andThen(() =>
			ResultAsync.fromPromise(
				(async () => {
					const requestUrl = new URL(request.url);
					const opencodePath = requestUrl.pathname.slice('/opencode'.length) || '/';
					const upstreamUrl = new URL(opencodePath, 'http://sandbox.internal');
					upstreamUrl.search = requestUrl.search;
					const body = SandboxContainerSidecar.methodsWithoutBody.has(request.method) ? undefined : await request.arrayBuffer();
					const headers = new Headers(request.headers);

					let lastError: unknown = null;
					for (let attempt = 0; attempt < SandboxContainerSidecar.startupRetryCount; attempt += 1) {
						try {
							// TODO: extract this into a separate fetchRetrier method
							// it should receive a config - exponential backoff - and return a ResultAsync
							return await container.getTcpPort(SandboxContainerSidecar.opencodePort).fetch(
								new Request(upstreamUrl.toString(), {
									method: request.method,
									headers,
									body,
								})
							);
						} catch (error: unknown) {
							console.error('connection to opencode failed', error);
							lastError = error;
							const message = error instanceof Error ? error.message : String(error);
							// TODO: rely on the actual .retryable field exposed by workerd
							const retriable = message.includes('Connection refused') || message.includes('container port not found');

							if (!retriable || attempt === SandboxContainerSidecar.startupRetryCount - 1) {
								throw error;
							}

							await new Promise((resolve) => setTimeout(resolve, SandboxContainerSidecar.startupRetryDelayMs));
						}
					}

					throw lastError ?? new Error('Opencode container port is unavailable');
				})(),
				(error: unknown) => unknownToAppError(error, appError(502, 'opencode_proxy_failed', 'Could not proxy request to opencode server'))
			)
		);
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (request.method === 'POST' && pathname === '/start') {
			const body = await parseJson<StartSidecarRequest>(request, appError(400, 'invalid_sidecar_payload', 'Invalid sidecar start payload'));

			if (body.isErr()) {
				return toHttpErrorResponse(body.error);
			}

			const started = await this.startContainer(body.value);
			return started.match(
				(result: SidecarHealthResponse) => Response.json(result),
				(error: AppError) => toHttpErrorResponse(error)
			);
		}

		if (request.method === 'GET' && pathname === '/health') {
			const health = await this.refreshInactivityTimeout().andThen(() =>
				ResultAsync.fromPromise(
					Promise.all([
						this.ctx.storage.get<string>('startedAt'),
						this.ctx.storage.get<string>('stoppedAt'),
						this.ctx.storage.get<number>('startCount'),
						this.ctx.storage.get<number>('stopCount'),
					]),
					(error: unknown) => unknownToAppError(error, appError(500, 'storage_read_failed', 'Could not read sidecar health data'))
				).map(([startedAt, stoppedAt, startCount, stopCount]) => ({
					running: this.ctx.container?.running ?? false,
					startedAt: startedAt ?? null,
					stoppedAt: stoppedAt ?? null,
					startCount: startCount ?? 0,
					stopCount: stopCount ?? 0,
				}))
			);

			return health.match(
				(result: SidecarHealthResponse) => Response.json(result),
				(error: AppError) => toHttpErrorResponse(error)
			);
		}

		if (pathname === '/opencode' || pathname.startsWith('/opencode/')) {
			const proxied = await this.proxyToOpencode(request);
			return proxied.match(
				(response: Response) => response,
				(error: AppError) => toHttpErrorResponse(error)
			);
		}

		return Response.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
	}
}
