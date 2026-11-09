/**
 * The studio serves every app in workflows/apps.config.json; the routes check that the app and its deployment exist.
 * Unrender's old page paths land on the studio home.
 */

const HOME = "/";
const OLD_PAGES = ["/unrender", "/reverse-3d"];

export function isPublicApp(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id);
}

export type PublicDecision = { action: "allow" } | { action: "redirect"; location: typeof HOME };

function normalizePath(pathname: string): string {
  const bare = pathname.split("?")[0]?.split("#")[0] ?? "/";
  if (bare.length > 1 && bare.endsWith("/")) return bare.slice(0, -1);
  return bare || "/";
}

export function decidePublicRequest(_method: string, pathname: string): PublicDecision {
  return OLD_PAGES.includes(normalizePath(pathname)) ? { action: "redirect", location: HOME } : { action: "allow" };
}
