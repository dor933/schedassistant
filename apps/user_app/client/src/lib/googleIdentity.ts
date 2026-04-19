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
 * different page subscribes. `renderGoogleButton` chains behind the same
 * init promise so pills are never rendered before init completes.
 */

interface CredentialResponse {
  credential: string;
}

type Callback = (resp: CredentialResponse) => void;

let currentCallback: Callback | null = null;
let initPromise: Promise<void> | null = null;

function dispatch(resp: CredentialResponse) {
  currentCallback?.(resp);
}

/**
 * Wait for the async GIS script (loaded from index.html) to attach
 * `google.accounts.id` to `window`, then init GIS exactly once and resolve.
 * Subsequent calls reuse the same promise so rendering chains behind init.
 */
function ensureInitialized(): Promise<void> {
  if (!GOOGLE_CLIENT_ID) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = new Promise<void>((resolve) => {
    const tick = () => {
      const gsi = window.google?.accounts?.id;
      if (!gsi) {
        window.setTimeout(tick, 100);
        return;
      }
      gsi.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: dispatch,
        ux_mode: "popup",
      });
      resolve();
    };
    tick();
  });
  return initPromise;
}

/**
 * Registers `callback` as the GIS credential handler and kicks off lazy
 * init. Returns an unsubscribe that clears the callback iff it's still the
 * active one (so a later subscriber won't be stomped on unmount).
 */
export function registerGoogleIdentity(callback: Callback): () => void {
  if (!GOOGLE_CLIENT_ID) return () => {};
  currentCallback = callback;
  void ensureInitialized();
  return () => {
    if (currentCallback === callback) currentCallback = null;
  };
}

/**
 * Render a GIS Sign-In pill into `slot`. Waits for init to complete, then
 * clears existing contents so repeated calls (e.g. after unmount/remount)
 * don't stack duplicate buttons.
 */
export function renderGoogleButton(
  slot: HTMLElement,
  opts: Record<string, unknown>,
): void {
  if (!GOOGLE_CLIENT_ID) return;
  void ensureInitialized().then(() => {
    slot.innerHTML = "";
    window.google!.accounts.id.renderButton(slot, opts);
  });
}
