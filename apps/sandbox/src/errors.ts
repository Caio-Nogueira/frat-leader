import type { AppError } from './types';

export const appError = (status: number, code: string, message: string): AppError => ({
	status,
	code,
	message,
});

export const isAppError = (value: unknown): value is AppError =>
	typeof value === 'object' &&
	value !== null &&
	'status' in value &&
	'code' in value &&
	'message' in value;

export const unknownToAppError = (error: unknown, fallback: AppError): AppError => {
	if (isAppError(error)) {
		return error;
	}

	if (error instanceof Error) {
		return {
			...fallback,
			message: error.message,
		};
	}

	return fallback;
};

export const toHttpErrorResponse = (error: AppError): Response =>
	Response.json(
		{
			error: error.message,
			code: error.code,
		},
		{
			status: error.status,
		},
	);
