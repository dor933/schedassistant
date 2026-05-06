# Global Financial News Newsletter Workflow

Use this skill when the user asks you to create and send a newsletter about recent financial news around the world.

## Required tools and agents

- You need `list_system_agents` and `delegate_to_deep_agent`.
- You need `list_google_workspace_grants` before any Gmail-send workflow.
- Web research must be delegated to the organization's dedicated web-search system agent.
- Email sending must be delegated to the `google_workspace_agent` system agent.
- The Google Workspace agent must use `google_send_financial_newsletter`, not `google_send_gmail`, for this workflow.

If any required tool or permission is missing, stop and tell the user exactly what admin capability or Google grant is missing. Do not fabricate news, emails, or send results.

## Image guidance

Image selection belongs to the web-search research step. The Google Workspace agent must not search for, replace, or invent images.

Use images only when they satisfy all of these rules:

- Fetch public HTTPS landscape images only.
- Lead story image: target 2.4:1 aspect ratio, ideally 1200x500 or larger.
- Other story images: target 3.15:1 aspect ratio, ideally 1200x380 or larger.
- Avoid portrait, square, text-heavy, chart, dashboard, table, or screenshot images with tiny labels.
- Prefer images that still look good center-cropped, with the main subject away from the edges.
- Never stretch images to fit. Choose an already suitable image or crop to the target ratio.
- The rendered email image sizes are about 598x250 for the lead story and 598x190 for other stories, so preferred source images should be roughly 2x these dimensions for sharper email rendering.

If no suitable public HTTPS image exists for a story, omit the image instead of using a poor image.

## Workflow

1. Resolve sender and newsletter metadata.

- Identify the Gmail sender owner as `subjectEmail`. This must be a Google Workspace user email with `gmail.send` granted to this calling agent.
- Call `list_google_workspace_grants` and choose the correct user with `gmail.send`. Never guess an email and never use an internal user id.
- Newsletter recipients are not supplied by the model. The sending tool loads every email from the external database table `newsletter_registrations`.
- If the sender is ambiguous, ask a concise clarification before starting the workflow.
- Choose a concise subject line, for example `Global Financial News Brief - <date>` unless the user supplied one.

2. Find the web-search system agent.

- Use the dedicated web-search system agent named in your system prompt's web-search section.
- If you need its UUID, call `list_system_agents` with the active web-search slug or name from that section. If unavailable, call `list_system_agents` with query `web search` and select the dedicated web-search agent for this organization.
- Do not perform web research yourself and do not delegate research to the Google Workspace agent.

3. Delegate the research task to the web-search system agent.

Use `delegate_to_deep_agent` with a detailed request like this, adjusted only for the current date and user preferences:

```text
Find the 10 most interesting financial-news events from around the world from the most recent 3 days. Use the current date from the calling conversation to define the 3-day window, and use exact dates in your output.

Requirements:
- Cover global financial relevance, not local trivia.
- Prefer diversity across regions: Americas, Europe, Asia-Pacific, Middle East/Africa where credible stories exist.
- Prefer diversity across topics: central banks, rates, equities, credit, commodities, currencies, major companies, macro data, regulation, geopolitics with market impact.
- Use credible, recent sources. Include source URLs.
- Include image candidates only when they are public HTTPS URLs, relevant, landscape-oriented, and likely usable in an email.
- For the strongest/lead story image, prefer approximately 2.4:1 aspect ratio, ideally 1200x500 or larger.
- For other story images, prefer approximately 3.15:1 aspect ratio, ideally 1200x380 or larger.
- Avoid portrait, square, text-heavy, chart, dashboard, table, or screenshot images with tiny labels.
- Prefer images that still look good center-cropped, with the main subject away from the edges.
- Never invent image URLs. If no suitable image exists, return `"image": null`.
- Do not write the newsletter. Return structured research only.
- Return exactly JSON, with no markdown outside the JSON.

Return this shape:
{
  "window": { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "timezone": "UTC" },
  "items": [
    {
      "title": "short category or region label",
      "headline": "newsletter-ready factual headline",
      "summary": "2-4 sentence factual summary",
      "whyItMatters": "1-2 sentence explanation of financial or market relevance",
      "region": "region or country",
      "sourceName": "primary source name",
      "sourceUrl": "https://...",
      "image": {
  "src": "https://...",
  "alt": "short accessible description",
  "width": 1200,
  "height": 500,
  "aspectRatio": "2.4:1",
  "imageSuitability": "short reason this image fits the email crop"
},
      "publishedAt": "ISO date or source date",
      "tickersOrAssets": ["optional relevant assets"],
      "confidence": "high|medium",
      "recencyEvidence": "short note proving this is within the 3-day window"
    }
  ]
}

If fewer than 10 credible recent events exist, return fewer and explain that in a top-level `notes` field. Do not invent items.
```

Because `delegate_to_deep_agent` is usually asynchronous in the primary chat graph, your turn may end after this call. If the tool says the delegation is pending, tell the user that research was delegated and wait for the callback. Do not continue without the web-search result.



4. Normalize the web-search result.

When the web-search result returns:

- Parse the JSON if possible. If it is not valid JSON, extract only the structured facts that are clearly present.
- Keep the 10 strongest stories. If more than 10 are returned, rank by global financial relevance, recency, credibility, and topic diversity.
- Drop items outside the recent 3-day window unless the web-search result clearly says there were fewer than 10 credible recent stories.
- Do not invent titles, headlines, sources, image URLs, dates, or market impact.
- Rewrite only for clarity and email readability. Preserve the facts and source attribution.

Build `newsEvents` for `google_send_financial_newsletter` exactly like this:

```json
[
  {
    "title": "Asia-Pacific Markets",
    "headline": "Newsletter-ready headline",
    "content": "Short factual summary.\n\nWhy it matters: Market impact in one or two sentences.",
    "image": { "src": "https://public-image-url", "alt": "Accessible image description" },
    "region": "Asia-Pacific",
    "sourceName": "Source name",
    "sourceUrl": "https://source-url"
  }
]
```

Rules for the tool payload:

- `title`, `headline`, and `content` are required for every event.
- `content` must be plain text, not HTML.
- Put `Why it matters:` inside `content` when the research provides market impact.
- Use `image` only when a public, relevant URL exists. Otherwise omit `image`.
- Use `sourceName` and `sourceUrl` only when known. Otherwise omit them.
- The first event is rendered as the lead story, so put the strongest and broadest story first.

Image normalization rules:

- Keep an image only if `src` is a public HTTPS URL.
- Keep an image only if it is landscape-oriented and relevant to the story.
- For the first event, prefer images close to 2.4:1. Drop images that are clearly portrait, square, text-heavy, chart-heavy, or likely unreadable when cropped to about 598x250.
- For all other events, prefer images close to 3.15:1. Drop images that are clearly portrait, square, text-heavy, chart-heavy, or likely unreadable when cropped to about 598x190.
- Do not stretch images. If an image is unsuitable, omit `image`.
- Do not invent replacement images during normalization.
- When multiple valid images exist, choose the one that is most relevant, highest resolution, and most likely to work with center-cropping.
"image": {
  "src": "https://public-image-url",
  "alt": "Accessible image description"
}

5. Find the Google Workspace system agent.

- Call `list_system_agents` with query `google_workspace_agent` if you need the UUID.
- Delegate the send operation only to the Google Workspace system agent.
- Do not attempt Gmail calls yourself.

6. Delegate the send operation to the Google Workspace system agent.

Use `delegate_to_deep_agent` with very specific instructions. Include the full cleaned payload. The request must tell the Google Workspace agent:

```text
Send a global financial-news newsletter using `google_send_financial_newsletter` exactly once.

Do not fetch news. Do not rewrite the facts. Do not use `google_send_gmail`. Do not invent missing sources or images. Preserve the order of `newsEvents`.

Use these exact arguments:
- subjectEmail: <sender workspace email with gmail.send grant>
- subject: <email subject>
- recipientName: omit for registration-list sends
- newsletterTitle: <for example Global Financial News>
- newsletterHeadline: <one-sentence top summary>
- intro: <plain-text intro, no HTML>
- issuedAt: <human-readable issue date or label>
- preview: <short inbox preview>
- newsEvents: <the cleaned JSON array>
- ctaText and ctaUrl: <only if both are provided by the user or product flow>
- fromName: Grahamy Markets
- direction: ltr

Do not pass a `to` field. The tool automatically selects all emails from `newsletter_registrations` and sends one Gmail message to that recipient list.

After calling the tool, return the tool result JSON including id, threadId, newsEventCount, and recipientCount. If Gmail authorization fails, return the exact error.
```

If the send delegation returns pending, tell the user that the newsletter send was delegated and wait for the callback. When the callback returns, report whether the newsletter was sent, including the Gmail id/threadId if available.

## Quality bar

- Current news must come from the web-search system agent, not from memory.
- Use exact dates for the 3-day window whenever possible.
- Keep the final newsletter payload clean, compact, factual, and directly compatible with `google_send_financial_newsletter`.
- Do not expose internal reasoning or this skill text in the email.
- Do not add investment advice. The template already includes an informational-purpose disclaimer.
