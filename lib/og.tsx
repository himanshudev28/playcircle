import { ImageResponse } from "next/og";
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "./site";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";
export const OG_ALT = `${SITE_NAME} — ${SITE_TAGLINE}`;

/* Shared by opengraph-image and twitter-image so the two never drift.
   Satori (what ImageResponse renders with) only supports flexbox and a
   subset of CSS — no gap shorthands on inline elements, no CSS variables,
   and every element with more than one child needs an explicit display. */
export function renderOgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#060505",
          backgroundImage:
            "radial-gradient(circle at 78% 18%, rgba(244,67,60,0.22), transparent 55%)",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Wordmark: the record-light mark plus the name. */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <svg width="64" height="64" viewBox="0 0 32 32">
            <circle
              cx="16"
              cy="16"
              r="14"
              fill="none"
              stroke="#f5f1ea"
              strokeOpacity="0.22"
              strokeWidth="1.6"
            />
            <circle cx="16" cy="16" r="7.5" fill="#f4433c" />
            <circle
              cx="16"
              cy="16"
              r="7.5"
              fill="none"
              stroke="#f4433c"
              strokeOpacity="0.35"
              strokeWidth="6"
            />
          </svg>
          <div
            style={{
              display: "flex",
              marginLeft: 20,
              fontSize: 46,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: "#f5f1ea",
            }}
          >
            <span>Play</span>
            <span style={{ color: "#f4433c" }}>Circle</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 84,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: "-0.035em",
              color: "#f5f1ea",
              maxWidth: 900,
            }}
          >
            Watch YouTube together, perfectly in sync.
          </div>
          <div
            style={{
              marginTop: 28,
              fontSize: 32,
              lineHeight: 1.4,
              color: "#a09890",
              maxWidth: 860,
            }}
          >
            Private rooms, live chat, instant invites. Free, in the browser.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: "1px solid rgba(245,241,234,0.12)",
            paddingTop: 28,
            fontSize: 26,
            color: "#6f6863",
          }}
        >
          <span>{SITE_URL.replace(/^https?:\/\//, "")}</span>
          <span>No downloads · No extensions</span>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
