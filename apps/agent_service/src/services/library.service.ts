import fs from "node:fs";
import path from "node:path";

/**
 * Shared organisation-wide "library" — flat folder of admin-uploaded reference
 * documents every agent can read. Lives at `${DATA_DIR}/library` in the
 * agent_service container (bound to the `agent_data` Docker volume).
 *
 * Files are stored by original basename; collisions overwrite.
 */

export interface LibraryFile {
  fileName: string;
  size: number;
  updatedAt: string;
}

export class LibraryServiceError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "LibraryServiceError";
  }
}

function libraryDir(): string {
  const dataDir = process.env.DATA_DIR ?? "/app/data";
  const dir = path.join(dataDir, "library");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Reject path traversal / empty names / absolute paths. */
function sanitizeFileName(raw: string): string {
  const name = path.basename(String(raw ?? "").trim());
  if (!name || name === "." || name === "..") {
    throw new LibraryServiceError("Invalid file name.", 400);
  }
  return name;
}

export function listLibraryFiles(): LibraryFile[] {
  const dir = libraryDir();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: LibraryFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    const stat = fs.statSync(full);
    files.push({
      fileName: e.name,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
  }
  files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return files;
}

export function saveLibraryFile(
  originalName: string,
  buffer: Buffer,
): LibraryFile {
  const fileName = sanitizeFileName(originalName);
  const dir = libraryDir();
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, buffer);
  const stat = fs.statSync(full);
  return {
    fileName,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

export function deleteLibraryFile(fileName: string): void {
  const name = sanitizeFileName(fileName);
  const dir = libraryDir();
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) {
    throw new LibraryServiceError(`File "${name}" not found.`, 404);
  }
  fs.unlinkSync(full);
}

export function readLibraryFile(fileName: string): {
  fileName: string;
  content: string;
} {
  const name = sanitizeFileName(fileName);
  const dir = libraryDir();
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) {
    throw new LibraryServiceError(`File "${name}" not found.`, 404);
  }
  const content = fs.readFileSync(full, "utf-8");
  return { fileName: name, content };
}

export function getLibraryPath(): string {
  return libraryDir();
}
