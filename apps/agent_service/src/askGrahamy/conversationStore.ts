import fs from "node:fs/promises";
import path from "node:path";
import type { Classification, ConversationContext, PublicResearchView, UiHints } from "./types";

type StoredFile = {
  conversations: Record<string, ConversationContext>;
};

const DEFAULT_STORE_PATH = "/tmp/ask-grahamy-conversations.json";

export class AskGrahamyConversationStore {
  private readonly storePath: string;
  private cache: StoredFile | null = null;

  constructor(storePath = process.env.ASK_GRAHAMY_CONVERSATION_STORE_PATH ?? DEFAULT_STORE_PATH) {
    this.storePath = storePath;
  }

  async load(conversationId: string | undefined | null, userId: number): Promise<ConversationContext | undefined> {
    if (!conversationId) return undefined;
    const store = await this.readStore();
    const context = store.conversations[conversationId];
    if (!context || context.userId !== userId) return undefined;
    return context;
  }

  async persistTurn(input: {
    conversationId: string;
    userId: number;
    classification: Classification;
    publicResearchView?: PublicResearchView;
    ui?: UiHints;
  }): Promise<ConversationContext> {
    const store = await this.readStore();
    const context: ConversationContext = {
      conversationId: input.conversationId,
      userId: input.userId,
      lastSymbols: input.classification.symbols,
      lastSectors: input.classification.sectors,
      lastIntent: input.classification.intent,
      lastPublicResearchSummary: summarizePublicResearch(input.publicResearchView),
      lastSuggestedFollowups: input.ui?.suggestedFollowups ?? [],
      updatedAt: new Date().toISOString(),
    };
    store.conversations[input.conversationId] = context;
    this.cache = store;
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(store, null, 2), "utf8");
    return context;
  }

  private async readStore(): Promise<StoredFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as StoredFile;
      this.cache = {
        conversations: parsed.conversations && typeof parsed.conversations === "object"
          ? parsed.conversations
          : {},
      };
      return this.cache;
    } catch {
      this.cache = { conversations: {} };
      return this.cache;
    }
  }
}

function summarizePublicResearch(view: PublicResearchView | undefined): string | undefined {
  if (!view) return undefined;
  const parts = [
    view.marketContext.regime ? `regime=${view.marketContext.regime}` : undefined,
    view.stockContext.symbols.length
      ? `symbols=${view.stockContext.symbols.map((item) => item.symbol).join(",")}`
      : undefined,
    view.sectorContext.sectors.length
      ? `sectors=${view.sectorContext.sectors.map((item) => item.sector).join(",")}`
      : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : undefined;
}

