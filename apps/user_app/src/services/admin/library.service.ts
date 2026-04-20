import { logger } from "../../logger";

/**
 * Admin-side proxy to the agent_service library API. Library files live on
 * the `agent_data` Docker volume mounted into the agent_service container —
 * only that service can read/write the on-disk files, so the user_app forwards
 * every request instead of duplicating storage.
 */

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export interface LibraryFile {
  fileName: string;
  size: number;
  updatedAt: string;
}

async function readError(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: string } | null;
    return body?.error ?? `Request failed (${resp.status})`;
  } catch {
    return `Request failed (${resp.status})`;
  }
}

export class LibraryService {
  async list(): Promise<LibraryFile[]> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/library`);
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    const data = (await resp.json()) as { files: LibraryFile[] };
    return data.files ?? [];
  }

  async upload(
    fileName: string,
    buffer: Buffer,
    mimetype: string | undefined,
  ): Promise<LibraryFile> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], {
      type: mimetype || "application/octet-stream",
    });
    form.append("file", blob, fileName);
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/library`, {
      method: "POST",
      body: form,
    });
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    const saved = (await resp.json()) as LibraryFile;
    logger.info("Library file uploaded", {
      fileName: saved.fileName,
      size: saved.size,
    });
    return saved;
  }

  async delete(fileName: string): Promise<void> {
    const resp = await fetch(
      `${AGENT_SERVICE_URL}/api/library/${encodeURIComponent(fileName)}`,
      { method: "DELETE" },
    );
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    logger.info("Library file deleted", { fileName });
  }
}
