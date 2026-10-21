export interface ErrorDetails {
  error: string;
  errorName: string;
  errorCode?: string;
}

export function errorDetails(value: unknown): ErrorDetails {
  const error = value instanceof Error ? value : new Error(String(value));
  const code = (error as Error & { code?: unknown }).code;
  return {
    error: error.message,
    errorName: error.name,
    ...(typeof code === 'string' || typeof code === 'number'
      ? { errorCode: String(code) }
      : {})
  };
}
