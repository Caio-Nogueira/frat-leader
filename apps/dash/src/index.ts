const SANDBOX_BASE_URL = 'https://sandbox.internal';
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)$/;
const SESSION_HEALTH_ROUTE = /^\/api\/sessions\/([^/]+)\/health$/;
const SESSION_OPENCODE_ROUTE = /^\/api\/sessions\/([^/]+)\/opencode(\/.*)?$/;

type DashEnv = {
	ASSETS: Fetcher;
	SANDBOX_API: Fetcher;
};

const hasRequestBody = (method: string) => method !== 'GET' && method !== 'HEAD';

const proxyToSandbox = async (request: Request, env: DashEnv, path: string) => {
	const url = new URL(request.url);
	const targetUrl = `${SANDBOX_BASE_URL}${path}${url.search}`;
	const body = hasRequestBody(request.method) ? await request.arrayBuffer() : undefined;
	return env.SANDBOX_API.fetch(
		new Request(targetUrl, {
			method: request.method,
			headers: new Headers(request.headers),
			body,
		}),
	);
};

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/api/health') {
			return proxyToSandbox(request, env, '/');
		}

		if (request.method === 'POST' && url.pathname === '/api/sessions') {
			return proxyToSandbox(request, env, '/sessions');
		}

		if (request.method === 'GET') {
			const sessionMatch = url.pathname.match(SESSION_ROUTE);
			if (sessionMatch?.[1]) {
				return proxyToSandbox(request, env, `/sessions/${decodeURIComponent(sessionMatch[1])}`);
			}

			const sessionHealthMatch = url.pathname.match(SESSION_HEALTH_ROUTE);
			if (sessionHealthMatch?.[1]) {
				return proxyToSandbox(request, env, `/sessions/${decodeURIComponent(sessionHealthMatch[1])}/health`);
			}
		}

		const sessionOpencodeMatch = url.pathname.match(SESSION_OPENCODE_ROUTE);
		if (sessionOpencodeMatch?.[1]) {
			const sessionId = decodeURIComponent(sessionOpencodeMatch[1]);
			const opencodePath = sessionOpencodeMatch[2] ?? '';
			return proxyToSandbox(request, env, `/sessions/${sessionId}/opencode${opencodePath}`);
		}

		if (!env.ASSETS) {
			return new Response('Not Found', { status: 404 });
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<DashEnv>;
