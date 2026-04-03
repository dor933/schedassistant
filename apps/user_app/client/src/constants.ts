/**
 * URL prefix for this app on the host (must match Vite `base` and nginx `location`).
 * Set via VITE_APP_URL_PREFIX env variable (e.g. "/claw" in production, empty in dev).
 * Nginx strips this before proxying; Express still serves `/api` and Socket.IO at `/socket.io`.
 */
export const APP_URL_PREFIX = import.meta.env.VITE_APP_URL_PREFIX ?? "";
