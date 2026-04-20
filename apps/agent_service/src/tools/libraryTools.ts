import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  LibraryServiceError,
  listLibraryFiles,
  readLibraryFile,
} from "../services/library.service";

/**
 * Shared organisation library tools. Every agent in the system gets these
 * bound by default so they can discover and read reference documents that
 * admins have uploaded via the admin UI. The library is read-only from the
 * agent's perspective — only admins can upload or delete.
 */

export function ListLibraryFilesTool() {
  return tool(
    async () => {
      const files = listLibraryFiles();
      if (files.length === 0) {
        return "The shared organisation library is empty — no reference documents have been uploaded.";
      }
      const lines = files.map(
        (f) => `- ${f.fileName} (${f.size} bytes, updated ${f.updatedAt})`,
      );
      return "Shared organisation library files (readable by every agent):\n" + lines.join("\n");
    },
    {
      name: "list_library_files",
      description:
        "Lists all files in the shared organisation library — admin-curated " +
        "reference documents that every agent in the org can read. Use this " +
        "to discover what reference material is available before consulting it.",
      schema: z.object({}),
    },
  );
}

export function ReadLibraryFileTool() {
  return tool(
    async (input) => {
      try {
        const { fileName, content } = readLibraryFile(input.fileName);
        return `Contents of library file "${fileName}":\n\n${content}`;
      } catch (err) {
        if (err instanceof LibraryServiceError) return err.message;
        throw err;
      }
    },
    {
      name: "read_library_file",
      description:
        "Reads a file from the shared organisation library by file name. " +
        "Use `list_library_files` first to see which files are available.",
      schema: z.object({
        fileName: z
          .string()
          .min(1)
          .describe("The file name to read (as returned by list_library_files)."),
      }),
    },
  );
}

export function libraryTools() {
  return [ListLibraryFilesTool(), ReadLibraryFileTool()];
}
