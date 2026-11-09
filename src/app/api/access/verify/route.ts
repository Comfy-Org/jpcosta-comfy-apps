import { finishEmailLogin, sessionCookie } from "@/lib/access";
import { AppError, errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Checks the code and signs the browser in with an HttpOnly cookie. */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { challenge?: unknown; code?: unknown } | null;
    if (!body) throw new AppError(400, "invalid_input", "Send the code as JSON.");
    const { token, email, used } = await finishEmailLogin(body.challenge, body.code);
    return Response.json({ email, used }, { headers: { "set-cookie": sessionCookie(token) } });
  } catch (error) {
    return errorResponse(error);
  }
}
