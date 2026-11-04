import { NextResponse } from "next/server";
import { BOX_PRESETS } from "@/lib/presets";

export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return NextResponse.json({ presets: BOX_PRESETS });
}
