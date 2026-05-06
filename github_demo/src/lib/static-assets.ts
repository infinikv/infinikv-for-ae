export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").trim().replace(/\/$/, "");

export function publicPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${normalizedPath}`;
}
