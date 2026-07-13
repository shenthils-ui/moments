export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export class NetworkError extends Error {}

type Listener = () => void;
const authListeners = new Set<Listener>();

/** Fired when any request comes back 401 so the app can show the login screen. */
export function onAuthRequired(fn: Listener): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
    });
  } catch {
    throw new NetworkError("Can't reach the server");
  }
  if (res.status === 401) {
    authListeners.forEach((fn) => fn());
    throw new ApiError('authentication required', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `request failed (${res.status})`, res.status);
  return data as T;
}

export const thumbUrl = (id: string, size: 256 | 1024 = 256) => `/api/photos/${id}/thumb?size=${size}`;
export const originalUrl = (id: string) => `/api/photos/${id}/original`;
export const downloadUrl = (id: string) => `/api/photos/${id}/original?download`;
