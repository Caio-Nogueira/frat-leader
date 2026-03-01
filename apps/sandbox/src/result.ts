import { ResultAsync } from 'neverthrow';

import type { AppError } from './types';
import { unknownToAppError } from './errors';

export const okAsync = <T>(value: T) =>
	ResultAsync.fromSafePromise(Promise.resolve(value));

export const errAsync = <T>(error: AppError) =>
	ResultAsync.fromPromise<T, AppError>(Promise.reject(error), () => error);

export const parseJson = <T>(request: Request, invalidJsonError: AppError) =>
	ResultAsync.fromPromise(
		request.json() as Promise<T>,
		(error: unknown) => unknownToAppError(error, invalidJsonError),
	);

export const nowIso = (): string => new Date().toISOString();
