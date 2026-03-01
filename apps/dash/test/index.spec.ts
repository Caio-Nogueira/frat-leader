import { describe, expect, it, vi } from 'vitest';

import worker from '../src';

const withConnect = (fetch: (...args: unknown[]) => Promise<Response>) =>
	({
		fetch,
		connect: vi.fn(),
	}) as unknown as Fetcher;

describe('dash worker', () => {
	it('proxies /api/health to sandbox root', async () => {
		const sandboxFetch = vi.fn(async (..._args: unknown[]) => Response.json({ health: 'ok' }));
		const assetFetch = vi.fn(async (..._args: unknown[]) => new Response('asset'));
		const request = new Request('http://example.com/api/health') as Parameters<typeof worker.fetch>[0];

		const response = await worker.fetch(request, {
			SANDBOX_API: withConnect(sandboxFetch),
			ASSETS: withConnect(assetFetch),
		} satisfies Env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ health: 'ok' });
		expect(sandboxFetch).toHaveBeenCalledOnce();
		const requestArg = sandboxFetch.mock.calls[0]?.[0];
		expect(requestArg).toBeInstanceOf(Request);
		expect((requestArg as Request | undefined)?.url).toBe('https://sandbox.internal/');
		expect(assetFetch).not.toHaveBeenCalled();
	});

	it('falls back to assets for non-api requests', async () => {
		const sandboxFetch = vi.fn(async (..._args: unknown[]) => Response.json({ health: 'ok' }));
		const assetFetch = vi.fn(async (..._args: unknown[]) => new Response('<html></html>', { status: 200 }));
		const request = new Request('http://example.com/') as Parameters<typeof worker.fetch>[0];

		const response = await worker.fetch(request, {
			SANDBOX_API: withConnect(sandboxFetch),
			ASSETS: withConnect(assetFetch),
		} satisfies Env);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('<html></html>');
		expect(assetFetch).toHaveBeenCalledOnce();
		expect(sandboxFetch).not.toHaveBeenCalled();
	});
});
