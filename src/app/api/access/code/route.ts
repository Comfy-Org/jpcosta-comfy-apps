import { startEmailLogin } from "@/lib/access";
import { AppError, errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Emails a sign-in code. The browser keeps the challenge and sends it back with the code. */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
    if (!body) throw new AppError(400, "invalid_input", "Send your email as JSON.");
    return Response.json(await startEmailLogin(body.email));
  } catch (error) {
    return errorResponse(error);
  }
}
