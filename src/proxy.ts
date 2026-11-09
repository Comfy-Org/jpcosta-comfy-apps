import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decidePublicRequest } from "@/lib/public-surface";

export function proxy(request: NextRequest) {
  const decision = decidePublicRequest(request.method, request.nextUrl.pathname);
  if (decision.action === "allow") return NextResponse.next();
  const response = NextResponse.redirect(new URL(decision.location, request.url), 307);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
