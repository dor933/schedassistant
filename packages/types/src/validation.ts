import { z } from "zod";

// ─── Username ────────────────────────────────────────────────────────────────

export const userNameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters.")
  .max(30, "Username must be at most 30 characters.")
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]*$/,
    "Username must start with a letter and contain only letters, numbers, and underscores.",
  )
  .transform((v) => v.toLowerCase());

// ─── Password ────────────────────────────────────────────────────────────────

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(128, "Password must be at most 128 characters.")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter.")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter.")
  .regex(/[0-9]/, "Password must contain at least one digit.")
  .regex(/[^a-zA-Z0-9]/, "Password must contain at least one special character.");

// ─── Display Name ────────────────────────────────────────────────────────────

export const displayNameSchema = z
  .string()
  .min(1, "Display name is required.")
  .max(100, "Display name must be at most 100 characters.")
  .trim();

// ─── Combined Schemas ────────────────────────────────────────────────────────

export const registerSchema = z.object({
  userName: userNameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  userIdentity: z
    .object({
      role: z.string().optional(),
      department: z.string().optional(),
      location: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
});

// ─── Onboarding (organization + admin + agents) ─────────────────────────────

export const webSearchChoiceSchema = z.enum(["gemini", "tavily"]);

export const registerOrganizationSchema = z
  .object({
    organization: z.object({
      name: z.string().min(1, "Organization name is required.").max(120).trim(),
      /** base64 data URL (client-resized); optional. */
      logo: z.string().max(500_000).optional(),
    }),
    /**
     * Password-based admin account. Mutually exclusive with
     * `googleBootstrapTicket` — exactly one of the two must be provided.
     */
    admin: z
      .object({
        userName: userNameSchema,
        displayName: displayNameSchema,
        password: passwordSchema,
      })
      .optional(),
    /**
     * Short-lived JWT minted by `POST /auth/google-bootstrap` after the admin
     * signs in with their Workspace Google account. Carries the verified
     * `{ sub, email, hd, name }` claims. When present, the org is created
     * with `googleWorkspaceDomain = hd`, and the admin user is persisted as
     * an SSO account (no password, auth_provider='google').
     */
    googleBootstrapTicket: z.string().min(1).optional(),
    agents: z
      .array(
        z.object({
          definition: z.string().min(1, "Agent definition is required.").max(120).trim(),
          description: z.string().max(1000).optional(),
          modelId: z.string().uuid().optional(),
        }),
      )
      .min(1, "At least one agent is required.")
      .max(5, "At most 5 agents at sign-up."),
    /**
     * The web-search system agent the new org wants active out of the box.
     * Defaults to the Gemini-powered `web_search` agent; the alternative
     * is `tavily` (backed by the Tavily search API via @langchain/tavily).
     * Exactly one of the two is active per org.
     */
    webSearchChoice: webSearchChoiceSchema.optional(),
  })
  .refine(
    (v) => (v.admin ? 1 : 0) + (v.googleBootstrapTicket ? 1 : 0) === 1,
    {
      message:
        "Provide either an admin password account OR a Google bootstrap ticket — exactly one.",
      path: ["admin"],
    },
  );

export type RegisterOrganizationInput = z.input<typeof registerOrganizationSchema>;

/**
 * Input for `POST /auth/google-bootstrap` — the pre-registration flow that
 * lets an admin sign in with Google Workspace BEFORE their org exists. The
 * server verifies the id token's signature + audience (env client ids only,
 * since there's no org yet) and returns a short-lived JWT ticket the client
 * carries through the rest of the onboarding wizard.
 */
export const googleBootstrapSchema = z.object({
  idToken: z.string().min(1, "Google id token is required."),
});

export type GoogleBootstrapInput = z.input<typeof googleBootstrapSchema>;

/**
 * Input for `POST /auth/google-verify-domain`. The client hands back the
 * unverified bootstrap ticket from `/auth/google-bootstrap`; the server
 * runs a live DNS TXT lookup on the admin's Workspace `hd` domain and —
 * if it finds the expected verification token — mints a new ticket with
 * the `verifiedDomain` flag set, which is what `/auth/register` then
 * requires. DNS is the proof-of-ownership signal: only someone with
 * registrar/DNS access to the root domain can publish that record.
 */
export const googleVerifyDomainSchema = z.object({
  ticket: z.string().min(1, "Bootstrap ticket is required."),
});

export type GoogleVerifyDomainInput = z.input<typeof googleVerifyDomainSchema>;

export const loginSchema = z.object({
  userName: z.string().min(1, "Username is required.").transform((v) => v.toLowerCase()),
  password: z.string().min(1, "Password is required."),
});

/**
 * Google Workspace SSO sign-in. The client obtains an id token via Google
 * Identity Services (the `credential` string from the "Sign in with Google"
 * button) and hands it off to the server for verification + JIT user
 * provisioning.
 */
export const googleLoginSchema = z.object({
  idToken: z.string().min(1, "Google id token is required."),
});

export type RegisterInput = z.input<typeof registerSchema>;
export type LoginInput = z.input<typeof loginSchema>;
export type GoogleLoginInput = z.input<typeof googleLoginSchema>;
