import { clearOauthCookie, finishGoogleLogin, sessionCookie } from "@/lib/access";
import { AppError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Google sends the popup back here. Sets the session cookie, tells the page over a BroadcastChannel and closes
 * the popup. Opened without a popup, it goes back to the page instead.
 */
export async function GET(request: Request) {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  headers.append("set-cookie", clearOauthCookie());
  let message: { ok: boolean; error?: string };
  try {
    const { token } = await finishGoogleLogin(request, new URL(request.url).origin);
    headers.append("set-cookie", sessionCookie(token));
    message = { ok: true };
  } catch (error) {
    message = { ok: false, error: error instanceof AppError ? error.message : "Google sign-in failed. Try again." };
    if (!(error instanceof AppError)) console.warn("google callback", error);
  }
  const data = JSON.stringify(message).replace(/</g, "\\u003c");
  const text = message.ok ? "Signed in. You can close this window." : (message.error ?? "Sign-in failed.");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unrender</title><style>body{font:15px system-ui,sans-serif;color:#121318;background:#fff;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}</style></head><body><p id="t"></p><script>
var m=${data};document.getElementById("t").textContent=${JSON.stringify(text).replace(/</g, "\\u003c")};
try{new BroadcastChannel("unrender-access").postMessage(m)}catch(e){}
try{if(window.opener&&!window.opener.closed){window.opener.postMessage({unrenderAccess:m},location.origin)}}catch(e){}
setTimeout(function(){window.close();setTimeout(function(){if(!window.closed&&!window.opener)location.replace("/unrender")},400)},150);
</script></body></html>`;
  return new Response(html, { status: 200, headers });
}
