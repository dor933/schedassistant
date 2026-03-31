import { LangfuseClient } from "@langfuse/client";
import { CallbackHandler } from "@langfuse/langchain";
import {
  observe,
  startActiveObservation,
  getActiveTraceId,
  updateActiveObservation,
  getLangfuseTracerProvider,
  setLangfuseTracerProvider,
  type LangfuseSpan,
} from "@langfuse/tracing";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { UserId } from "@scheduling-agent/types";

let langfuseClient: LangfuseClient | null = null;
let tracerProvider: NodeTracerProvider | null = null;

function logInfo(message: string, meta?: Record<string, unknown>): void {
  console.log(`[langfuse] ${message}`, meta ?? "");
}

function logDebug(message: string, meta?: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== "production") {
    console.debug(`[langfuse] ${message}`, meta ?? "");
  }
}

function logWarn(message: string, meta?: Record<string, unknown>): void {
  console.warn(`[langfuse] ${message}`, meta ?? "");
}

function logError(message: string, meta?: Record<string, unknown>): void {
  console.error(`[langfuse] ${message}`, meta ?? "");
}

/** True when Langfuse keys are set (tracing + LangChain callbacks enabled). */
export function isLangfuseConfigured(): boolean {
  return !!(
    process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY
  );
}

export function initializeTracerProvider(): NodeTracerProvider {
  if (tracerProvider) {
    return tracerProvider;
  }

  if (!isLangfuseConfigured()) {
    throw new Error(
      "LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are required to initialize the tracer",
    );
  }

  try {
    const langfuseSpanProcessor = new LangfuseSpanProcessor();

    tracerProvider = new NodeTracerProvider({
      spanProcessors: [langfuseSpanProcessor],
    });

    setLangfuseTracerProvider(tracerProvider);

    logInfo("Langfuse OpenTelemetry tracer provider initialized", {
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    });

    return tracerProvider;
  } catch (error) {
    logError("Error initializing Langfuse tracer provider", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Failed to initialize tracer provider: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function initializeLangfuse(): LangfuseClient {
  if (!isLangfuseConfigured()) {
    throw new Error(
      "LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are required for observability",
    );
  }

  try {
    initializeTracerProvider();
    langfuseClient = new LangfuseClient();
    logInfo("Langfuse client initialized successfully");
    return langfuseClient;
  } catch (error) {
    logError("Error initializing Langfuse client", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Failed to initialize Langfuse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function getLangfuseClient(): LangfuseClient | null {
  if (!isLangfuseConfigured()) {
    return null;
  }
  if (!langfuseClient) {
    langfuseClient = initializeLangfuse();
  }
  return langfuseClient;
}

/**
 * LangChain callback handler for LLM / graph runs. Returns `null` when Langfuse is not configured.
 */
export function getLangfuseCallbackHandler(
  userId?: UserId,
  metadata?: Record<string, unknown>,
): CallbackHandler | null {
  if (!isLangfuseConfigured()) {
    return null;
  }

  try {
    const params: ConstructorParameters<typeof CallbackHandler>[0] = {};
    if (userId != null) params.userId = String(userId);
    if (metadata) params.traceMetadata = metadata;
    return new CallbackHandler(params);
  } catch (error) {
    logError("Error creating Langfuse CallbackHandler", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Failed to create CallbackHandler: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Flush pending Langfuse traces (OpenTelemetry provider + LangfuseClient).
 */
export async function flushLangfuse(): Promise<void> {
  if (!isLangfuseConfigured()) {
    return;
  }

  try {
    const provider = tracerProvider ?? getLangfuseTracerProvider();

    logDebug("Attempting to flush Langfuse traces", {
      hasTracerProvider: !!provider,
      tracerProviderType: provider?.constructor?.name,
    });

    const flushable = provider as unknown as {
      forceFlush?: () => Promise<void>;
    };
    if (provider && typeof flushable.forceFlush === "function") {
      await flushable.forceFlush();
      logDebug("OpenTelemetry tracer provider flushed successfully");
    } else {
      logWarn(
        "OpenTelemetry tracer provider does not have forceFlush method or is null",
      );
    }

    const client = getLangfuseClient();
    if (client && typeof client.flush === "function") {
      await client.flush();
      logDebug("LangfuseClient flushed successfully");
    }

    logDebug("Langfuse flush completed");
  } catch (error) {
    logError("Error flushing Langfuse traces", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Shutdown Langfuse gracefully — flushes and closes connections.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (!isLangfuseConfigured()) {
    return;
  }

  try {
    const provider = tracerProvider ?? getLangfuseTracerProvider();
    const shutdownable = provider as unknown as {
      shutdown?: () => Promise<void>;
    };
    if (provider && typeof shutdownable.shutdown === "function") {
      await shutdownable.shutdown();
      logInfo("OpenTelemetry tracer provider shutdown");
    }

    const client = getLangfuseClient();
    if (client && typeof client.shutdown === "function") {
      await client.shutdown();
      logInfo("LangfuseClient shutdown");
    }

    logInfo("Langfuse shutdown successfully");
  } catch (error) {
    logError("Error shutting down Langfuse", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function observeWithContext<T>(
  name: string,
  fn: (span: LangfuseSpan | null) => Promise<T>,
  input?: Record<string, unknown>,
): Promise<T> {
  if (!isLangfuseConfigured()) {
    return fn(null);
  }

  try {
    const result = await startActiveObservation(
      name,
      async (span: LangfuseSpan) => {
        if (input) {
          span.update({ input });
        }

        const output = await fn(span);

        try {
          const serializedOutput =
            typeof output === "object" && output !== null
              ? JSON.parse(JSON.stringify(output))
              : output;
          span.update({ output: serializedOutput });
        } catch {
          span.update({ output: { result: String(output) } });
        }

        return output;
      },
    );

    await flushLangfuse();
    return result;
  } catch (error) {
    await flushLangfuse();
    throw error;
  }
}

export function getTrace(): { id: string | undefined } {
  return {
    id: getActiveTraceId(),
  };
}

export {
  observe,
  startActiveObservation,
  getActiveTraceId,
  updateActiveObservation,
};
