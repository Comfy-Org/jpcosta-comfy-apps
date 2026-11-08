import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decidePublicRequest } from "@/lib/public-surface";

export function proxy(request: NextRequest) {
  const decision = decidePublicRequest(request.method, request.nextUrl.pathname);
  if (decision.action === "allow") return NextResponse.next();
  if (decision.action === "redirect") {
    const response = NextResponse.redirect(new URL(decision.location, request.url), 307);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "not_found", message: decision.message } },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return new NextResponse(decision.message, {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
