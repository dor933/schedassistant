import fs from "node:fs";
import { JWT } from "google-auth-library";
import { logger } from "../logger";

/**
 * Domain-wide delegation client.
 *
 * Loads the service-account JSON from `GOOGLE_SERVICE_ACCOUNT_PATH`
 * once, caches JWT instances per (subjectEmail, scopes) tuple, and exposes
 * `fetchAsSubject(subjectEmail, scopes, url, init)` for making authenticated
 * Google REST calls on that user's behalf.
 *
 * DWD requires the service account's client id (the "Unique ID" in GCP) to
 * be authorized with the matching OAuth scopes in the target Workspace's
 * Admin Console under Security → API controls → Domain-wide delegation.
 */

type ServiceAccount = {
  client_email: string;
  private_key: string;
};

let cachedKey: ServiceAccount | null = null;
let cacheFailureLogged = false;

function loadServiceAccount(): ServiceAccount | null {
  if (cachedKey) return cachedKey;
  const path = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  if (!path) {
    if (!cacheFailureLogged) {
      logger.warn("DWD: GOOGLE_SERVICE_ACCOUNT_PATH not set — Google tools will refuse calls");
      cacheFailureLogged = true;
    }
    return null;
  }
  try {
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) {
      logger.error("DWD: service-account JSON missing client_email or private_key", { path });
      return null;
    }
    cachedKey = parsed;
    return parsed;
  } catch (err: any) {
    if (!cacheFailureLogged) {
      logger.error("DWD: failed to read service-account JSON", {
        path,
        error: err?.message,
      });
      cacheFailureLogged = true;
    }
    return null;
  }
}

const jwtCache = new Map<string, JWT>();

function getImpersonatedClient(
  subjectEmail: string,
  scopes: string[],
): JWT | null {
  const sa = loadServiceAccount();
  if (!sa) return null;
  const key = `${subjectEmail}::${scopes.slice().sort().join(" ")}`;
  const existing = jwtCache.get(key);
  if (existing) return existing;
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes,
    subject: subjectEmail,
  });
  jwtCache.set(key, client);
  return client;
}

export class DWDNotConfiguredError extends Error {
  constructor() {
    super("Google domain-wide delegation is not configured on this server.");
    this.name = "DWDNotConfiguredError";
  }
}

/**
 * Authenticated fetch against a Google REST endpoint, impersonating
 * `subjectEmail`. Throws `DWDNotConfiguredError` if the service account
 * isn't set up, and a plain Error carrying the HTTP status + body on 4xx/5xx.
 */
export async function fetchAsSubject(
  subjectEmail: string,
  scopes: string[],
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const client = getImpersonatedClient(subjectEmail, scopes);
  if (!client) throw new DWDNotConfiguredError();

  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error(`DWD: failed to obtain access token for ${subjectEmail}`);
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(
      `Google API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
    );
    (err as any).status = res.status;
    throw err;
  }
  return res;
}
