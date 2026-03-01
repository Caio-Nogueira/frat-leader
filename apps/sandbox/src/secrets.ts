import { ResultAsync } from 'neverthrow';

import type { WorkerEnv } from './types';
import { appError, unknownToAppError } from './errors';
import { okAsync } from './result';

const getSecretResult = (secret?: SecretsStoreSecret) => {
	if (!secret) {
		return okAsync<string | undefined>(undefined);
	}

	return ResultAsync.fromPromise(secret.get(), (error: unknown) =>
		unknownToAppError(
			error,
			appError(500, 'secret_read_failed', 'Could not read secret from Secrets Store'),
		),
	).map((value) => value as string | undefined);
};

export const resolveCredentials = (env: WorkerEnv) =>
	ResultAsync.combine([getSecretResult(env.ZAI_API_KEY)]).map(([zaiApiKey]) => ({
		...(zaiApiKey ? { ZAI_API_KEY: zaiApiKey } : {}),
	}));
