const LOCAL_ORIGIN = "http://localhost:3000";

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

function isLocalOrigin(origin: string) {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
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
    if (configuredSiteOrigin && !isLocalOrigin(configuredSiteOrigin)) return configuredSiteOrigin;
    const productionOrigin = normalizeOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL);
    if (productionOrigin) return productionOrigin;
    if (vercelDeploymentOrigin) return vercelDeploymentOrigin;
  }

  const requestOrigin = normalizeOrigin(new URL(request.url).origin);
  if (requestOrigin) return requestOrigin;
  return configuredSiteOrigin ?? LOCAL_ORIGIN;
}

export function passwordResetRedirectUrl(request: Request) {
  const callback = new URL("/auth/callback", resolveApplicationOrigin(request));
  callback.searchParams.set("next", "/reset-password");
  return callback.toString();
}

