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

export const loginSchema = z.object({
  userName: z.string().min(1, "Username is required.").transform((v) => v.toLowerCase()),
  password: z.string().min(1, "Password is required."),
});
