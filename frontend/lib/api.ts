// The backend is a separately-hosted service (Railway), not a Next.js API
// route, so every call needs the full base URL - a bare fetch('/api/...')
// would hit the Next.js server itself and 404.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${cleanPath}`;
}
