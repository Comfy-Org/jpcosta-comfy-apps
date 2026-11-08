import type { Metadata } from "next";
import { Studio } from "@/components/studio";
import { ViewportMenu, ViewportShell } from "@/components/viewport-shell";
import { buildPublicCatalog } from "@/lib/catalog";
import { apiKey, isMockMode, missingDedicatedKeyMessage } from "@/lib/env";
import "./viewport.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Reverse 3D",
  description: "Turn a final shot into a blocky playblast.",
};

export default function Reverse3dPage() {
  const mock = isMockMode();
  const ready = Boolean(apiKey("reverse-3d"));
  return (
    <ViewportShell>
      <Studio
        apps={buildPublicCatalog()}
        mock={mock}
        configured
        notice={mock || ready ? null : missingDedicatedKeyMessage("reverse-3d")}
        menu={<ViewportMenu />}
        brand="Reverse 3D"
        hero={false}
      />
    </ViewportShell>
  );
}
