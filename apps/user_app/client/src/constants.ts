/**
 * URL prefix for this app (must match server `APP_URL_PREFIX` in index.ts).
 * Vite may override via `VITE_APP_URL_PREFIX`; default is always `/claw`.
 */
export const APP_URL_PREFIX = import.meta.env.VITE_APP_URL_PREFIX || "/claw";

/**
 * Google OAuth 2.0 Web Client ID used by Google Identity Services to mint
 * the id token the backend then verifies. Set `VITE_GOOGLE_CLIENT_ID` at
 * build time. When empty, the "Sign in with Google" button is hidden.
 */
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
