import { Vendor } from "@scheduling-agent/database";

/** Extend when adding non-OpenAI embedding backends. */
import { EmbeddingProvider } from "../types/providers";
/**
 * Resolves the API key for an embedding provider (DB vendor row + env fallbacks).
 * Independent of the user-facing chat model (Anthropic, Google, etc.).
 */
export async function resolveEmbeddingProviderApiKey(
  provider: EmbeddingProvider,
): Promise<string | undefined> {
  switch (provider) {
    case "openai": {
      const row = await Vendor.findOne({
        where: { slug: "openai" },
        attributes: ["apiKey"],
      });
      const fromDb = row?.apiKey?.trim();
      if (fromDb) return fromDb;
      return process.env.OPENAI_API_KEY?.trim() || undefined;
    }
  }
}
