import { startGoogleLogin } from "@/lib/access";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Opens Google's account picker (in the page's popup). */
export async function GET(request: Request) {
  try {
    const { location, cookie } = startGoogleLogin(new URL(request.url).origin);
    return new Response(null, { status: 302, headers: { location, "set-cookie": cookie, "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
