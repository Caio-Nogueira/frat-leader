import { ResultAsync } from 'neverthrow';
import { D1QB } from 'workers-qb';

import type { SandboxSchema, SessionRow } from './types';
import { appError, unknownToAppError } from './errors';
import { nowIso } from './result';

const qb = (db: D1Database): D1QB<SandboxSchema> => new D1QB<SandboxSchema>(db);

export const ensureSchema = (db: D1Database) =>
	ResultAsync.fromPromise(
		qb(db)
			.createTable({
				tableName: 'sandbox_sessions',
				ifNotExists: true,
				schema: `
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
`,
			})
			.execute(),
		(error: unknown) =>
			unknownToAppError(error, appError(500, 'db_schema_failed', 'Could not ensure D1 schema')),
	);

export const upsertSession = (db: D1Database, row: SessionRow) =>
	ResultAsync.fromPromise(
		qb(db)
			.raw({
				query: `INSERT INTO sandbox_sessions (
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
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				args: [
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
				],
			})
			.execute(),
		(error: unknown) =>
			unknownToAppError(
				error,
				appError(500, 'db_write_failed', 'Could not persist sandbox session'),
			),
	);

export const updateSessionStatus = (
	db: D1Database,
	sessionId: string,
	status: SessionRow['status'],
	patch: {
		lastHealthStatus?: string;
		lastHealthcheckAt?: string;
		error?: string | null;
	} = {},
) =>
	ResultAsync.fromPromise(
		qb(db)
			.update({
				tableName: 'sandbox_sessions',
				data: {
					status,
					last_health_status: patch.lastHealthStatus ?? null,
					last_healthcheck_at: patch.lastHealthcheckAt ?? null,
					error: patch.error ?? null,
					updated_at: nowIso(),
				},
				where: {
					conditions: 'session_id = ?',
					params: sessionId,
				},
			})
			.execute(),
		(error: unknown) =>
			unknownToAppError(
				error,
				appError(500, 'db_update_failed', 'Could not update sandbox session'),
			),
	);

export const readSession = (db: D1Database, sessionId: string) =>
	ResultAsync.fromPromise(
		qb(db)
			.fetchOne<SessionRow>({
				tableName: 'sandbox_sessions',
				where: {
					conditions: 'session_id = ?',
					params: sessionId,
				},
			})
			.execute(),
		(error: unknown) =>
			unknownToAppError(error, appError(500, 'db_read_failed', 'Could not read sandbox session')),
	).map((result) => result.results ?? null);
