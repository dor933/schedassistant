/**
 * URL prefix for this app on the host (must match Vite production `base` and nginx `location /claw/`).
 * Nginx strips this before proxying; Express still serves `/api` and Socket.IO at `/socket.io`.
 */
export const APP_URL_PREFIX = "/claw";
