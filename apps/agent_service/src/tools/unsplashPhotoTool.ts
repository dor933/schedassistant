import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../logger";

const UNSPLASH_API_BASE_URL = "https://api.unsplash.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_UTM_SOURCE = "grahamy";

const orientationSchema = z.enum(["landscape", "portrait", "squarish"]);
const orderBySchema = z.enum(["relevant", "latest"]);
const contentFilterSchema = z.enum(["low", "high"]);
const imageSizeSchema = z.enum(["raw", "full", "regular", "small", "thumb"]);
const imageFitSchema = z.enum(["crop", "clip", "clamp", "facearea", "fill", "fillmax", "max", "min", "scale"]);
const imageCropSchema = z.enum(["top", "bottom", "left", "right", "faces", "entropy", "edges", "focalpoint"]);
const imageFormatSchema = z.enum(["jpg", "png", "webp", "gif", "avif"]);
const colorSchema = z.enum([
  "black_and_white",
  "black",
  "white",
  "yellow",
  "orange",
  "red",
  "purple",
  "magenta",
  "green",
  "teal",
  "blue",
]);

const unsplashSearchSchema = z.object({
  query: z.string().trim().min(1).describe("Photo search terms, for example 'modern office' or 'bull market'."),
  perPage: z.number().int().min(1).max(10).optional().describe(
    "Maximum number of matching photo results to return after optional local filtering. Defaults to 1.",
  ),
  candidateCount: z.number().int().min(1).max(30).optional().describe(
    "Number of Unsplash API candidates to fetch before local dimension/aspect filtering. " +
    "Maps to Unsplash per_page. Defaults to perPage when no local filters are set, otherwise 30.",
  ),
  page: z.number().int().min(1).optional().describe("Search page to retrieve. Defaults to 1."),
  orderBy: orderBySchema.optional().describe("Sort order. Defaults to relevant."),
  orientation: orientationSchema.optional().describe("Optional orientation filter."),
  contentFilter: contentFilterSchema.optional().describe("Content safety filter. Defaults to high."),
  color: colorSchema.optional().describe("Optional dominant color filter."),
  collections: z.string().trim().min(1).optional().describe(
    "Optional comma-separated Unsplash collection IDs to narrow the search.",
  ),
  imageSize: imageSizeSchema.optional().describe(
    "Which Unsplash hotlinked image URL to return. Defaults to regular.",
  ),
  lang: z.string().trim().min(2).max(12).optional().describe(
    "Optional beta Unsplash search language code, for example 'en' or 'es'. Requires beta access from Unsplash.",
  ),
  minWidth: z.number().int().positive().optional().describe(
    "Minimum source image width to accept, checked against each returned photo's width field.",
  ),
  minHeight: z.number().int().positive().optional().describe(
    "Minimum source image height to accept, checked against each returned photo's height field.",
  ),
  targetAspectRatio: z.number().positive().optional().describe(
    "Desired source aspect ratio as width / height, for example 2.4 for 1200x500 or 3.15 for 1200x380. " +
    "Unsplash does not support this as a search parameter, so the tool filters returned candidates locally.",
  ),
  aspectRatioTolerance: z.number().min(0).optional().describe(
    "Maximum allowed absolute difference from targetAspectRatio. Defaults to 0.2 when targetAspectRatio is set.",
  ),
  renderWidth: z.number().int().positive().optional().describe(
    "Optional output image width to request in the returned imageUrl using Unsplash's supported dynamic image URL parameter w.",
  ),
  renderHeight: z.number().int().positive().optional().describe(
    "Optional output image height to request in the returned imageUrl using Unsplash's supported dynamic image URL parameter h.",
  ),
  renderFit: imageFitSchema.optional().describe(
    "Optional dynamic image URL fit parameter. Defaults to crop when both renderWidth and renderHeight are provided.",
  ),
  renderCrop: imageCropSchema.optional().describe(
    "Optional dynamic image URL crop parameter. Defaults to entropy when renderFit is crop.",
  ),
  renderDpr: z.number().positive().max(5).optional().describe("Optional dynamic image URL dpr parameter."),
  renderQuality: z.number().int().min(1).max(100).optional().describe("Optional dynamic image URL q parameter."),
  renderFormat: imageFormatSchema.optional().describe("Optional dynamic image URL fm parameter."),
  autoFormat: z.boolean().optional().describe("When true, add auto=format to the returned rendered imageUrl."),
  trackDownload: z.boolean().optional().describe(
    "Set true only when every returned photo is being inserted, set, or otherwise used by the app. " +
    "For newsletter images that are selected for the actual send, this must be true. " +
    "This triggers Unsplash's download tracking endpoint for compliance.",
  ),
});

export type UnsplashSearchInput = z.infer<typeof unsplashSearchSchema>;
export type ImageSize = z.infer<typeof imageSizeSchema>;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface UnsplashSearchOptions {
  accessKey?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  utmSource?: string;
  fetchImpl?: FetchLike;
}

export interface DownloadTrackingResult {
  attempted: boolean;
  ok: boolean;
  endpoint: string | null;
  status?: number;
  url?: string | null;
  error?: string;
}

export interface UnsplashPhotoResult {
  id: string;
  imageUrl: string;
  imageSize: ImageSize;
  baseImageUrl: string;
  renderedImageUrl: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  color: string | null;
  blurHash: string | null;
  description: string | null;
  altDescription: string | null;
  photoUrl: string | null;
  downloadLocation: string | null;
  photographer: {
    name: string;
    username: string | null;
    profileUrl: string | null;
  };
  attribution: {
    text: string;
    markdown: string;
    html: string;
    photographerUrl: string | null;
    unsplashUrl: string;
  };
  sourceRequirements: {
    minWidth: number | null;
    minHeight: number | null;
    targetAspectRatio: number | null;
    aspectRatioTolerance: number | null;
    aspectRatioDelta: number | null;
    matches: boolean;
    reasons: string[];
  };
  render: {
    width: number | null;
    height: number | null;
    fit: string | null;
    crop: string | null;
    dpr: number | null;
    quality: number | null;
    format: string | null;
    autoFormat: boolean;
  };
  downloadTracking: DownloadTrackingResult;
}

export interface UnsplashSearchResult {
  query: string;
  total: number | null;
  totalPages: number | null;
  page: number;
  perPage: number;
  apiPerPage: number;
  candidateCount: number;
  filteredOut: number;
  rateLimit: {
    limit: number | null;
    remaining: number | null;
  };
  photos: UnsplashPhotoResult[];
  filters: {
    nativeApiParams: string[];
    localFilters: string[];
    renderedUrlParams: string[];
  };
  compliance: {
    hotlinking: string;
    attribution: string;
    downloadTracking: string;
  };
}

export async function searchUnsplashPhotos(
  input: UnsplashSearchInput,
  options: UnsplashSearchOptions = {},
): Promise<UnsplashSearchResult> {
  const accessKey = options.accessKey ?? process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    throw new Error("UNSPLASH_ACCESS_KEY is not set.");
  }

  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? UNSPLASH_API_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const utmSource = normalizeUtmSource(
    options.utmSource ??
      process.env.UNSPLASH_UTM_SOURCE ??
      DEFAULT_UTM_SOURCE,
  );

  const page = input.page ?? 1;
  const perPage = input.perPage ?? 1;
  const apiPerPage = input.candidateCount ?? (hasLocalFilters(input) ? 30 : perPage);
  const imageSize = input.imageSize ?? "regular";
  const contentFilter = input.contentFilter ?? "high";

  const params = new URLSearchParams({
    query: input.query,
    page: String(page),
    per_page: String(apiPerPage),
    order_by: input.orderBy ?? "relevant",
    content_filter: contentFilter,
  });
  if (input.orientation) params.set("orientation", input.orientation);
  if (input.color) params.set("color", input.color);
  if (input.collections) params.set("collections", input.collections);
  if (input.lang) params.set("lang", input.lang);

  const response = await fetchWithTimeout(
    fetchImpl,
    `${apiBaseUrl}/search/photos?${params.toString()}`,
    {
      method: "GET",
      headers: unsplashHeaders(accessKey),
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Unsplash search failed: ${response.status} ${await safeResponseText(response)}`);
  }

  const body = await response.json();
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error("Unsplash search returned an invalid payload.");
  }

  const photos: UnsplashPhotoResult[] = [];
  let filteredOut = 0;
  for (const rawPhoto of body.results) {
    if (!isRecord(rawPhoto)) continue;
    const photo = buildUnsplashPhotoResult(rawPhoto, {
      imageSize,
      utmSource,
      apiBaseUrl,
      constraints: input,
      render: input,
    });
    if (!photo) continue;
    if (!photo.sourceRequirements.matches) {
      filteredOut += 1;
      continue;
    }

    if (input.trackDownload) {
      photo.downloadTracking = await trackDownloadForPhoto(rawPhoto, {
        accessKey,
        apiBaseUrl,
        timeoutMs,
        fetchImpl,
      });
    }

    photos.push(photo);
    if (photos.length >= perPage) break;
  }

  return {
    query: input.query,
    total: numberOrNull(body.total),
    totalPages: numberOrNull(body.total_pages),
    page,
    perPage,
    apiPerPage,
    candidateCount: Array.isArray(body.results) ? body.results.length : 0,
    filteredOut,
    rateLimit: {
      limit: parseHeaderInt(response.headers.get("x-ratelimit-limit")),
      remaining: parseHeaderInt(response.headers.get("x-ratelimit-remaining")),
    },
    photos,
    filters: {
      nativeApiParams: activeNativeApiParams(input),
      localFilters: activeLocalFilters(input),
      renderedUrlParams: activeRenderedUrlParams(input),
    },
    compliance: {
      hotlinking: "Use imageUrl directly; do not copy the image to separate storage unless you have a separate Unsplash arrangement.",
      attribution: "Display attribution.text, attribution.markdown, or attribution.html with the image.",
      downloadTracking:
        "If a returned photo is later inserted, set as a header/background, or otherwise chosen for use, call the returned downloadLocation endpoint or rerun with trackDownload=true for the selected photo.",
    },
  };
}

export function buildUnsplashPhotoResult(
  photo: Record<string, unknown>,
  options: {
    imageSize?: ImageSize;
    utmSource?: string;
    apiBaseUrl?: string;
    constraints?: Pick<UnsplashSearchInput, "minWidth" | "minHeight" | "targetAspectRatio" | "aspectRatioTolerance">;
    render?: Pick<
      UnsplashSearchInput,
      | "renderWidth"
      | "renderHeight"
      | "renderFit"
      | "renderCrop"
      | "renderDpr"
      | "renderQuality"
      | "renderFormat"
      | "autoFormat"
    >;
  } = {},
): UnsplashPhotoResult | null {
  const imageSize = options.imageSize ?? "regular";
  const utmSource = normalizeUtmSource(options.utmSource ?? DEFAULT_UTM_SOURCE);
  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? UNSPLASH_API_BASE_URL);

  const id = stringOrNull(photo.id);
  const urls = recordOrNull(photo.urls);
  const baseImageUrl = urls ? stringOrNull(urls[imageSize]) : null;
  const rawImageUrl = urls ? stringOrNull(urls.raw) : null;
  if (!id || !baseImageUrl) return null;

  const user = recordOrNull(photo.user);
  const userLinks = user ? recordOrNull(user.links) : null;
  const photoLinks = recordOrNull(photo.links);
  const photographerName =
    (user ? stringOrNull(user.name) : null) ??
    (user ? stringOrNull(user.username) : null) ??
    "Unsplash photographer";
  const photographerUsername = user ? stringOrNull(user.username) : null;
  const photographerUrl = addUtmParams(
    userLinks ? stringOrNull(userLinks.html) : null,
    utmSource,
  );
  const unsplashUrl = addUtmParams("https://unsplash.com/", utmSource) ?? "https://unsplash.com/";
  const photoUrl = addUtmParams(photoLinks ? stringOrNull(photoLinks.html) : null, utmSource);
  const downloadLocation =
    (photoLinks ? stringOrNull(photoLinks.download_location) : null) ??
    `${apiBaseUrl}/photos/${encodeURIComponent(id)}/download`;
  const width = numberOrNull(photo.width);
  const height = numberOrNull(photo.height);
  const aspectRatio = width && height ? roundNumber(width / height, 4) : null;
  const renderedImageUrl = buildRenderedImageUrl(rawImageUrl, options.render);
  const renderFit = options.render?.renderFit ?? (options.render?.renderWidth && options.render?.renderHeight ? "crop" : null);
  const renderCrop = options.render?.renderCrop ?? (renderFit === "crop" ? "entropy" : null);

  return {
    id,
    imageUrl: renderedImageUrl ?? baseImageUrl,
    imageSize,
    baseImageUrl,
    renderedImageUrl,
    width,
    height,
    aspectRatio,
    color: stringOrNull(photo.color),
    blurHash: stringOrNull(photo.blur_hash),
    description: stringOrNull(photo.description),
    altDescription: stringOrNull(photo.alt_description),
    photoUrl,
    downloadLocation,
    photographer: {
      name: photographerName,
      username: photographerUsername,
      profileUrl: photographerUrl,
    },
    attribution: buildAttribution(photographerName, photographerUrl, unsplashUrl),
    sourceRequirements: evaluateSourceRequirements({ width, height, aspectRatio }, options.constraints),
    render: {
      width: options.render?.renderWidth ?? null,
      height: options.render?.renderHeight ?? null,
      fit: renderFit,
      crop: renderCrop,
      dpr: options.render?.renderDpr ?? null,
      quality: options.render?.renderQuality ?? null,
      format: options.render?.renderFormat ?? null,
      autoFormat: options.render?.autoFormat ?? false,
    },
    downloadTracking: {
      attempted: false,
      ok: false,
      endpoint: null,
    },
  };
}

export function UnsplashSearchPhotosTool() {
  if (!process.env.UNSPLASH_ACCESS_KEY) {
    logger.warn("UnsplashSearchPhotosTool: UNSPLASH_ACCESS_KEY is not set — calls will fail");
  }

  return tool(
    async (input) => {
      try {
        const result = await searchUnsplashPhotos(input);
        if (result.photos.length === 0) {
          return JSON.stringify({
            ...result,
            message: "No Unsplash photos matched the query.",
          });
        }
        return JSON.stringify(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("unsplash_search_photos tool error", { error: message });
        return `Error: ${message}`;
      }
    },
    {
      name: "unsplash_search_photos",
      description:
        "Search Unsplash photos by query and return hotlinked image URLs plus required credit/attribution data. " +
        "Returns JSON with photos[].imageUrl, photographer details, attribution.text/markdown/html, photoUrl, " +
        "downloadLocation, source size/aspect metadata, and optional rendered crop URLs. " +
        "Use minWidth/minHeight/targetAspectRatio to filter returned candidates locally; use renderWidth/renderHeight " +
        "to generate an email-ready crop via Unsplash's supported dynamic image URL parameters. " +
        "Use trackDownload=true when the returned photo(s) are actually being inserted, set as a header/background, " +
        "or otherwise chosen for use; for newsletter images selected for the actual send, trackDownload=true is required.",
      schema: unsplashSearchSchema,
    },
  );
}

async function trackDownloadForPhoto(
  photo: Record<string, unknown>,
  options: {
    accessKey: string;
    apiBaseUrl: string;
    timeoutMs: number;
    fetchImpl: FetchLike;
  },
): Promise<DownloadTrackingResult> {
  const id = stringOrNull(photo.id);
  const links = recordOrNull(photo.links);
  const endpoint =
    (links ? stringOrNull(links.download_location) : null) ??
    (id ? `${options.apiBaseUrl}/photos/${encodeURIComponent(id)}/download` : null);

  if (!endpoint) {
    return {
      attempted: false,
      ok: false,
      endpoint: null,
      error: "Photo did not include an id or download_location.",
    };
  }

  try {
    const response = await fetchWithTimeout(
      options.fetchImpl,
      endpoint,
      {
        method: "GET",
        headers: unsplashHeaders(options.accessKey),
      },
      options.timeoutMs,
    );

    if (!response.ok) {
      return {
        attempted: true,
        ok: false,
        endpoint,
        status: response.status,
        error: await safeResponseText(response),
      };
    }

    const body = await response.json().catch(() => null);
    return {
      attempted: true,
      ok: true,
      endpoint,
      status: response.status,
      url: isRecord(body) ? stringOrNull(body.url) : null,
    };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function unsplashHeaders(accessKey: string): Record<string, string> {
  return {
    Authorization: `Client-ID ${accessKey}`,
    "Accept-Version": "v1",
    Accept: "application/json",
  };
}

function buildAttribution(
  photographerName: string,
  photographerUrl: string | null,
  unsplashUrl: string,
): UnsplashPhotoResult["attribution"] {
  const text = `Photo by ${photographerName} on Unsplash`;
  const escapedName = escapeHtml(photographerName);
  const escapedUnsplashUrl = escapeHtml(unsplashUrl);

  if (!photographerUrl) {
    return {
      text,
      markdown: `Photo by ${escapeMarkdownLabel(photographerName)} on [Unsplash](${unsplashUrl})`,
      html: `Photo by ${escapedName} on <a href="${escapedUnsplashUrl}">Unsplash</a>`,
      photographerUrl: null,
      unsplashUrl,
    };
  }

  const escapedPhotographerUrl = escapeHtml(photographerUrl);
  return {
    text,
    markdown: `Photo by [${escapeMarkdownLabel(photographerName)}](${photographerUrl}) on [Unsplash](${unsplashUrl})`,
    html: `Photo by <a href="${escapedPhotographerUrl}">${escapedName}</a> on <a href="${escapedUnsplashUrl}">Unsplash</a>`,
    photographerUrl,
    unsplashUrl,
  };
}

function addUtmParams(rawUrl: string | null, utmSource: string): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("utm_source", utmSource);
    url.searchParams.set("utm_medium", "referral");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function buildRenderedImageUrl(
  rawUrl: string | null,
  render?: Pick<
    UnsplashSearchInput,
    | "renderWidth"
    | "renderHeight"
    | "renderFit"
    | "renderCrop"
    | "renderDpr"
    | "renderQuality"
    | "renderFormat"
    | "autoFormat"
  >,
): string | null {
  if (!rawUrl || !render || !hasRenderedUrlParams(render)) return null;

  try {
    const url = new URL(rawUrl);
    if (render.renderWidth) url.searchParams.set("w", String(render.renderWidth));
    if (render.renderHeight) url.searchParams.set("h", String(render.renderHeight));
    const fit = render.renderFit ?? (render.renderWidth && render.renderHeight ? "crop" : null);
    if (fit) url.searchParams.set("fit", fit);
    const crop = render.renderCrop ?? (fit === "crop" ? "entropy" : null);
    if (crop) url.searchParams.set("crop", crop);
    if (render.renderDpr) url.searchParams.set("dpr", String(render.renderDpr));
    if (render.renderQuality) url.searchParams.set("q", String(render.renderQuality));
    if (render.renderFormat) url.searchParams.set("fm", render.renderFormat);
    if (render.autoFormat) url.searchParams.set("auto", "format");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function evaluateSourceRequirements(
  source: { width: number | null; height: number | null; aspectRatio: number | null },
  constraints?: Pick<UnsplashSearchInput, "minWidth" | "minHeight" | "targetAspectRatio" | "aspectRatioTolerance">,
): UnsplashPhotoResult["sourceRequirements"] {
  const minWidth = constraints?.minWidth ?? null;
  const minHeight = constraints?.minHeight ?? null;
  const targetAspectRatio = constraints?.targetAspectRatio ?? null;
  const aspectRatioTolerance =
    targetAspectRatio === null
      ? null
      : constraints?.aspectRatioTolerance ?? 0.2;
  const aspectRatioDelta =
    targetAspectRatio !== null && source.aspectRatio !== null
      ? roundNumber(Math.abs(source.aspectRatio - targetAspectRatio), 4)
      : null;
  const reasons: string[] = [];

  if (minWidth !== null && (source.width === null || source.width < minWidth)) {
    reasons.push(`source width ${source.width ?? "unknown"} is below minWidth ${minWidth}`);
  }
  if (minHeight !== null && (source.height === null || source.height < minHeight)) {
    reasons.push(`source height ${source.height ?? "unknown"} is below minHeight ${minHeight}`);
  }
  if (
    targetAspectRatio !== null &&
    (aspectRatioDelta === null || aspectRatioTolerance === null || aspectRatioDelta > aspectRatioTolerance)
  ) {
    reasons.push(
      `source aspect ratio ${source.aspectRatio ?? "unknown"} is outside target ${targetAspectRatio} +/- ${aspectRatioTolerance}`,
    );
  }

  return {
    minWidth,
    minHeight,
    targetAspectRatio,
    aspectRatioTolerance,
    aspectRatioDelta,
    matches: reasons.length === 0,
    reasons,
  };
}

function hasLocalFilters(input: UnsplashSearchInput): boolean {
  return activeLocalFilters(input).length > 0;
}

function hasRenderedUrlParams(
  render: Pick<
    UnsplashSearchInput,
    | "renderWidth"
    | "renderHeight"
    | "renderFit"
    | "renderCrop"
    | "renderDpr"
    | "renderQuality"
    | "renderFormat"
    | "autoFormat"
  >,
): boolean {
  return activeRenderedUrlParams(render).length > 0;
}

function activeNativeApiParams(input: UnsplashSearchInput): string[] {
  const params = ["query", "page", "per_page", "order_by", "content_filter"];
  if (input.orientation) params.push("orientation");
  if (input.color) params.push("color");
  if (input.collections) params.push("collections");
  if (input.lang) params.push("lang");
  return params;
}

function activeLocalFilters(
  input: Pick<UnsplashSearchInput, "minWidth" | "minHeight" | "targetAspectRatio" | "aspectRatioTolerance">,
): string[] {
  const filters: string[] = [];
  if (input.minWidth !== undefined) filters.push("minWidth");
  if (input.minHeight !== undefined) filters.push("minHeight");
  if (input.targetAspectRatio !== undefined) filters.push("targetAspectRatio");
  if (input.aspectRatioTolerance !== undefined) filters.push("aspectRatioTolerance");
  return filters;
}

function activeRenderedUrlParams(
  input: Pick<
    UnsplashSearchInput,
    | "renderWidth"
    | "renderHeight"
    | "renderFit"
    | "renderCrop"
    | "renderDpr"
    | "renderQuality"
    | "renderFormat"
    | "autoFormat"
  >,
): string[] {
  const params: string[] = [];
  if (input.renderWidth !== undefined) params.push("w");
  if (input.renderHeight !== undefined) params.push("h");
  if (input.renderFit !== undefined || (input.renderWidth !== undefined && input.renderHeight !== undefined)) {
    params.push("fit");
  }
  if (input.renderCrop !== undefined || input.renderFit === "crop" || (input.renderWidth !== undefined && input.renderHeight !== undefined)) {
    params.push("crop");
  }
  if (input.renderDpr !== undefined) params.push("dpr");
  if (input.renderQuality !== undefined) params.push("q");
  if (input.renderFormat !== undefined) params.push("fm");
  if (input.autoFormat) params.push("auto");
  return params;
}

function normalizeUtmSource(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "_");
  return normalized || DEFAULT_UTM_SOURCE;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundNumber(value: number, places: number): number {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

async function safeResponseText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 500) || response.statusText || "Unknown error";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}
