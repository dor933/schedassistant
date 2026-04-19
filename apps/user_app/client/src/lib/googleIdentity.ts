import { GOOGLE_CLIENT_ID } from "../constants";

/**
 * Centralised Google Identity Services integration.
 *
 * `google.accounts.id.initialize(...)` mutates *global* GIS state — "last
 * init wins." Calling it from multiple React components (LoginPage,
 * OnboardingWizard) racing through StrictMode double-effects clobbers the
 * previous callback and leaves the popup state machine stuck, so clicking
 * the rendered button silently does nothing. GIS logs the symptom as
 * `[GSI_LOGGER]: google.accounts.id.initialize() is called multiple times`.
 *
 * The fix: init exactly once per page load. The actual credential handler
 * is stored in `currentCallback` and swapped (not re-initialised) when a
 * different page subscribes.
 */

interface CredentialResponse {
  credential: string;
}

type Callback = (resp: CredentialResponse) => void;

let initialized = false;
let currentCallback: Callback | null = null;

function dispatch(resp: CredentialResponse) {
  currentCallback?.(resp);
}

/**
 * Wait for the GIS script (loaded async from index.html) to attach
 * `google.accounts.id` to `window`, then run `cb`. Polls every 100 ms.
 */
function whenReady(cb: () => void): void {
  const tick = () => {
    if (window.google?.accounts?.id) {
      cb();
      return;
    }
    window.setTimeout(tick, 100);
  };
  tick();
}

/**
 * Registers `callback` as the GIS credential handler and lazily initialises
 * GIS exactly once. Returns an unsubscribe that clears the callback iff it's
 * still the active one (so a later subscriber won't be stomped on unmount).
 */
export function registerGoogleIdentity(callback: Callback): () => void {
  if (!GOOGLE_CLIENT_ID) return () => {};
  currentCallback = callback;
  whenReady(() => {
    if (initialized) return;
    window.google!.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: dispatch,
      ux_mode: "popup",
    });
    initialized = true;
  });
  return () => {
    if (currentCallback === callback) currentCallback = null;
  };
}

/**
 * Render a GIS Sign-In button into `slot`. Clears existing contents first so
 * repeated calls (e.g. after unmount/remount) don't stack duplicate buttons.
 */
export function renderGoogleButton(
  slot: HTMLElement,
  opts: Record<string, unknown>,
): void {
  whenReady(() => {
    slot.innerHTML = "";
    window.google!.accounts.id.renderButton(slot, opts);
  });
}
