import { clearSessionCookie, emailLoginReady, freeVideoUsed, sessionEmail } from "@/lib/access";
import { isMockMode } from "@/lib/env";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who the visitor is: a signed-in email and whether its free video is gone, and whether email sign-in works here. */
export async function GET(request: Request) {
  try {
    const email = sessionEmail(request);
    const ready = emailLoginReady();
    return Response.json({
      email,
      used: email && ready ? await freeVideoUsed(email) : false,
      emailLogin: ready,
      mock: isMockMode(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Sign out, to use another email. */
export async function DELETE() {
  return new Response(null, { status: 204, headers: { "set-cookie": clearSessionCookie() } });
}
