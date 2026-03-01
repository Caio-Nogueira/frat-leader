import React, { useMemo, useState } from 'react';

type SpawnSessionResponse = {
	sessionId: string;
};

type SessionStatus = 'scheduled' | 'running' | 'waiting' | 'errored';

type SessionRow = {
	session_id: string;
	status: SessionStatus;
	error: string | null;
	updated_at: string;
};

type ChatMessage = {
	id: string;
	role: 'user' | 'assistant' | 'system';
	text: string;
};

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

const extractOpencodeSessionId = (payload: unknown): string | null => {
	if (!isRecord(payload)) {
		return null;
	}

	const direct = payload.id;
	if (typeof direct === 'string' && direct.length > 0) {
		return direct;
	}

	const session = payload.session;
	if (isRecord(session) && typeof session.id === 'string' && session.id.length > 0) {
		return session.id;
	}

	return null;
};

const collectText = (value: unknown): string[] => {
	if (typeof value === 'string') {
		return value.trim().length > 0 ? [value] : [];
	}

	if (Array.isArray(value)) {
		return value.flatMap((item) => collectText(item));
	}

	if (!isRecord(value)) {
		return [];
	}

	const current: string[] = [];
	if (typeof value.text === 'string' && value.text.trim().length > 0) {
		current.push(value.text);
	}

	if (typeof value.content === 'string' && value.content.trim().length > 0) {
		current.push(value.content);
	}

	for (const nested of Object.values(value)) {
		if (nested !== value.text && nested !== value.content) {
			current.push(...collectText(nested));
		}
	}

	return current;
};

const extractError = (payload: unknown) => {
	if (!isRecord(payload)) {
		return null;
	}

	if (typeof payload.error === 'string') {
		return payload.error;
	}

	if (isRecord(payload.error) && typeof payload.error.message === 'string') {
		return payload.error.message;
	}

	if (typeof payload.message === 'string') {
		return payload.message;
	}

	return null;
};

const parseJson = async (response: Response) => {
	try {
		return await response.json();
	} catch (_error) {
		return null;
	}
};

const statusLabel = (session: SessionRow | null) => (session ? session.status : 'No session');

export const App = () => {
	const [userId, setUserId] = useState('demo-user');
	const [setupPrompt, setSetupPrompt] = useState('Help me inside this sandbox session.');
	const [sessionId, setSessionId] = useState('');
	const [opencodeSessionId, setOpencodeSessionId] = useState('');
	const [session, setSession] = useState<SessionRow | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [draft, setDraft] = useState('');
	const [isBusy, setIsBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const canSend = useMemo(
		() => sessionId.trim().length > 0 && draft.trim().length > 0 && !isBusy,
		[sessionId, draft, isBusy],
	);

	const onInputChange =
		(setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
			setter(event.currentTarget.value);
		};

	const refreshSession = async (id: string) => {
		const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
		const json = await parseJson(response);

		if (!response.ok || !isRecord(json) || typeof json.session_id !== 'string') {
			throw new Error(extractError(json) ?? 'Could not load session');
		}

		setSession(json as SessionRow);
	};

	const createOpencodeSession = async (sandboxSessionId: string) => {
		const response = await fetch(`/api/sessions/${encodeURIComponent(sandboxSessionId)}/opencode/session`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({}),
		});
		const json = await parseJson(response);

		if (!response.ok) {
			throw new Error(extractError(json) ?? 'Could not create OpenCode session');
		}

		const id = extractOpencodeSessionId(json);
		if (!id) {
			throw new Error('OpenCode session id was not returned by server');
		}

		setOpencodeSessionId(id);
		return id;
	};

	const ensureOpencodeSession = async (sandboxSessionId: string) => {
		if (opencodeSessionId.trim().length > 0) {
			return opencodeSessionId.trim();
		}

		return createOpencodeSession(sandboxSessionId);
	};

	const createSession = async () => {
		setIsBusy(true);
		setError(null);

		try {
			const response = await fetch('/api/sessions', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
				},
				body: JSON.stringify({ userId, prompt: setupPrompt }),
			});
			const json = await parseJson(response);

			if (!response.ok || !isRecord(json) || typeof json.sessionId !== 'string') {
				throw new Error(extractError(json) ?? 'Could not create session');
			}

			setSessionId(json.sessionId);
			setOpencodeSessionId('');
			setMessages([]);
			await refreshSession(json.sessionId);
			await createOpencodeSession(json.sessionId);
		} catch (caught: unknown) {
			setError(caught instanceof Error ? caught.message : 'Failed to create session');
		} finally {
			setIsBusy(false);
		}
	};

	const connectSession = async () => {
		const id = sessionId.trim();
		if (!id) {
			setError('Enter a session id first.');
			return;
		}

		setIsBusy(true);
		setError(null);
		try {
			setOpencodeSessionId('');
			await refreshSession(id);
			await createOpencodeSession(id);
		} catch (caught: unknown) {
			setError(caught instanceof Error ? caught.message : 'Failed to connect session');
		} finally {
			setIsBusy(false);
		}
	};

	const sendMessage = async () => {
		const text = draft.trim();
		const sandboxSessionId = sessionId.trim();
		if (!sandboxSessionId || !text) {
			return;
		}

		const nextMessages: ChatMessage[] = [...messages, { id: makeId(), role: 'user', text }];
		setMessages(nextMessages);
		setDraft('');
		setIsBusy(true);
		setError(null);

		try {
			const ocSessionId = await ensureOpencodeSession(sandboxSessionId);
			const response = await fetch(
				`/api/sessions/${encodeURIComponent(sandboxSessionId)}/opencode/session/${encodeURIComponent(ocSessionId)}/message`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'zai/glm-4.7',
						parts: [{ type: 'text', text }],
					}),
				},
			);

			const json = await parseJson(response);
			if (!response.ok) {
				throw new Error(extractError(json) ?? 'OpenCode request failed');
			}

			const assistantText = collectText(json).join('\n').trim();
			setMessages((current) => [
				...current,
				{
					id: makeId(),
					role: 'assistant',
					text: assistantText.length > 0 ? assistantText : 'No assistant output returned.',
				},
			]);
		} catch (caught: unknown) {
			const message = caught instanceof Error ? caught.message : 'Failed to send message';
			setError(message);
			setMessages((current) => [...current, { id: makeId(), role: 'system', text: `Error: ${message}` }]);
		} finally {
			setIsBusy(false);
		}
	};

	return (
		<div className="chat-app">
			<header className="topbar">
				<h1>Sandbox Chat</h1>
				<span className={`status status-${session?.status ?? 'idle'}`}>{statusLabel(session)}</span>
			</header>

			<section className="session-controls">
				<label>
					<span>User</span>
					<input value={userId} onChange={onInputChange(setUserId)} placeholder="demo-user" />
				</label>
				<label>
					<span>Session Prompt</span>
					<input value={setupPrompt} onChange={onInputChange(setSetupPrompt)} placeholder="Initial sandbox objective" />
				</label>
				<div className="actions">
					<button onClick={createSession} disabled={isBusy}>New Session</button>
				</div>
				<label>
					<span>Session ID</span>
					<input value={sessionId} onChange={onInputChange(setSessionId)} placeholder="Paste existing session id" />
				</label>
				<div className="actions">
					<button onClick={connectSession} disabled={isBusy}>Connect</button>
				</div>
			</section>

			{opencodeSessionId ? <p className="hint">OpenCode session: {opencodeSessionId}</p> : null}
			{error ? <p className="error">{error}</p> : null}

			<section className="messages" aria-live="polite">
				{messages.length === 0 ? <p className="empty">Start chatting after creating or connecting a session.</p> : null}
				{messages.map((message) => (
					<article key={message.id} className={`bubble bubble-${message.role}`}>
						<header>{message.role}</header>
						<p>{message.text}</p>
					</article>
				))}
			</section>

			<form
				className="composer"
				onSubmit={(event) => {
					event.preventDefault();
					void sendMessage();
				}}
			>
				<input value={draft} onChange={onInputChange(setDraft)} placeholder="Type a message" disabled={isBusy || !sessionId.trim()} />
				<button type="submit" disabled={!canSend}>{isBusy ? 'Sending...' : 'Send'}</button>
			</form>
		</div>
	);
};
