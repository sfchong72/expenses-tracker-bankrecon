const LOCAL_ORIGIN = "http://localhost:3000";
const CANONICAL_PRODUCTION_ORIGIN = "https://interexcel-hub.vercel.app";

function normalizeOrigin(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate.startsWith("http://") || candidate.startsWith("https://") ? candidate : `https://${candidate}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveApplicationOrigin(request: Request) {
  const vercelDeploymentOrigin = normalizeOrigin(process.env.NEXT_PUBLIC_VERCEL_URL ?? process.env.VERCEL_URL);
  const configuredSiteOrigin = normalizeOrigin(
    process.env.NEXT_PUBLIC_SITE_URL
      ?? process.env.SITE_URL
      ?? process.env.APP_URL
      ?? process.env.NEXT_PUBLIC_APP_URL,
  );

  // Every Vercel Preview email must return to the deployment that requested it.
  if (process.env.VERCEL_ENV === "preview" && vercelDeploymentOrigin) return vercelDeploymentOrigin;

  if (process.env.VERCEL_ENV === "production") {
    if (configuredSiteOrigin === CANONICAL_PRODUCTION_ORIGIN) return configuredSiteOrigin;
    return CANONICAL_PRODUCTION_ORIGIN;
  }

  const requestOrigin = normalizeOrigin(new URL(request.url).origin);
  if (requestOrigin) return requestOrigin;
  return configuredSiteOrigin ?? LOCAL_ORIGIN;
}

export function passwordResetRedirectUrl(request: Request) {
  return new URL("/reset-password", resolveApplicationOrigin(request)).toString();
}
