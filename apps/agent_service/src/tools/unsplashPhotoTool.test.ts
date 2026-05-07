import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUnsplashPhotoResult,
  searchUnsplashPhotos,
} from "./unsplashPhotoTool";

const samplePhoto = {
  id: "photo-1",
  width: 1200,
  height: 800,
  color: "#ffffff",
  blur_hash: "abc123",
  description: "A bright workspace",
  alt_description: "Desk near a window",
  urls: {
    raw: "https://images.unsplash.com/photo-1?ixid=test",
    regular: "https://images.unsplash.com/photo-1?ixid=test&w=1080",
    small: "https://images.unsplash.com/photo-1?ixid=test&w=400",
  },
  links: {
    html: "https://unsplash.com/photos/photo-1",
    download_location: "https://api.unsplash.com/photos/photo-1/download?ixid=test",
  },
  user: {
    username: "photographer",
    name: "Example Photographer",
    links: {
      html: "https://unsplash.com/@photographer",
    },
  },
};

const widePhoto = {
  ...samplePhoto,
  id: "photo-wide",
  width: 2400,
  height: 1000,
  urls: {
    raw: "https://images.unsplash.com/photo-wide?ixid=test",
    regular: "https://images.unsplash.com/photo-wide?ixid=test&w=1080",
    small: "https://images.unsplash.com/photo-wide?ixid=test&w=400",
  },
  links: {
    html: "https://unsplash.com/photos/photo-wide",
    download_location: "https://api.unsplash.com/photos/photo-wide/download?ixid=test",
  },
};

test("builds Unsplash photo attribution with UTM links", () => {
  const photo = buildUnsplashPhotoResult(samplePhoto, {
    imageSize: "regular",
    utmSource: "schedassistant_test",
  });

  assert.ok(photo);
  assert.equal(photo.imageUrl, samplePhoto.urls.regular);
  assert.equal(photo.photographer.name, "Example Photographer");
  assert.equal(
    photo.photographer.profileUrl,
    "https://unsplash.com/@photographer?utm_source=schedassistant_test&utm_medium=referral",
  );
  assert.equal(
    photo.attribution.markdown,
    "Photo by [Example Photographer](https://unsplash.com/@photographer?utm_source=schedassistant_test&utm_medium=referral) on [Unsplash](https://unsplash.com/?utm_source=schedassistant_test&utm_medium=referral)",
  );
  assert.equal(
    photo.downloadLocation,
    "https://api.unsplash.com/photos/photo-1/download?ixid=test",
  );
});

test("searches Unsplash and can track selected photo download", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });

    if (url.includes("/search/photos")) {
      return new Response(
        JSON.stringify({
          total: 1,
          total_pages: 1,
          results: [samplePhoto],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "50",
            "x-ratelimit-remaining": "49",
          },
        },
      );
    }

    if (url.includes("/download")) {
      return new Response(JSON.stringify({ url: "https://images.unsplash.com/downloaded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  };

  const result = await searchUnsplashPhotos(
    {
      query: "workspace",
      perPage: 1,
      trackDownload: true,
      orientation: "landscape",
    },
    {
      accessKey: "test-access-key",
      fetchImpl,
      utmSource: "schedassistant_test",
    },
  );

  assert.equal(result.photos.length, 1);
  assert.equal(result.rateLimit.remaining, 49);
  assert.equal(result.photos[0].downloadTracking.ok, true);
  assert.equal(result.photos[0].downloadTracking.url, "https://images.unsplash.com/downloaded");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /query=workspace/);
  assert.match(calls[0].url, /content_filter=high/);
  assert.match(calls[0].url, /orientation=landscape/);
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Client-ID test-access-key",
  );
  assert.equal(
    (calls[1].init?.headers as Record<string, string>).Authorization,
    "Client-ID test-access-key",
  );
});

test("filters source dimensions and returns rendered crop URL", async () => {
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    assert.match(url, /per_page=30/);

    return new Response(
      JSON.stringify({
        total: 2,
        total_pages: 1,
        results: [samplePhoto, widePhoto],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const result = await searchUnsplashPhotos(
    {
      query: "markets",
      perPage: 1,
      orientation: "landscape",
      minWidth: 1200,
      minHeight: 500,
      targetAspectRatio: 2.4,
      aspectRatioTolerance: 0.05,
      renderWidth: 598,
      renderHeight: 250,
      renderQuality: 80,
      autoFormat: true,
    },
    {
      accessKey: "test-access-key",
      fetchImpl,
      utmSource: "schedassistant_test",
    },
  );

  assert.equal(result.photos.length, 1);
  assert.equal(result.filteredOut, 1);
  assert.deepEqual(result.filters.localFilters, [
    "minWidth",
    "minHeight",
    "targetAspectRatio",
    "aspectRatioTolerance",
  ]);
  assert.deepEqual(result.filters.renderedUrlParams, ["w", "h", "fit", "crop", "q", "auto"]);
  assert.equal(result.photos[0].id, "photo-wide");
  assert.equal(result.photos[0].aspectRatio, 2.4);
  assert.equal(result.photos[0].sourceRequirements.matches, true);
  assert.equal(result.photos[0].renderedImageUrl, result.photos[0].imageUrl);

  const renderedUrl = new URL(result.photos[0].imageUrl);
  assert.equal(renderedUrl.searchParams.get("ixid"), "test");
  assert.equal(renderedUrl.searchParams.get("w"), "598");
  assert.equal(renderedUrl.searchParams.get("h"), "250");
  assert.equal(renderedUrl.searchParams.get("fit"), "crop");
  assert.equal(renderedUrl.searchParams.get("crop"), "entropy");
  assert.equal(renderedUrl.searchParams.get("q"), "80");
  assert.equal(renderedUrl.searchParams.get("auto"), "format");
});
