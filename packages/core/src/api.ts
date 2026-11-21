/** Cursor-paginated list returned by the API. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Error body returned by the API. `code` is stable English; the UI maps it to Polish text. */
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
