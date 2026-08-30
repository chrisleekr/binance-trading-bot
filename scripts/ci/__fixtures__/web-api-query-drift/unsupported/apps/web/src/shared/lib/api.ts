const apiDefault = (..._args: readonly unknown[]): Promise<unknown> => Promise.resolve();
export default apiDefault;
export const apiFetch = apiDefault;
