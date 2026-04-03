/**
 * URL prefix for this app (must match server `APP_URL_PREFIX` in index.ts).
 * Vite may override via `VITE_APP_URL_PREFIX`; default is always `/claw`.
 */
export const APP_URL_PREFIX = import.meta.env.VITE_APP_URL_PREFIX || "/claw";
