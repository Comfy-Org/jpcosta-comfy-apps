import { Studio } from "@/components/studio";
import { buildCatalog } from "@/lib/catalog";
import { hasApiKey, isMockMode, missingDedicatedKeyMessage } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const mock = isMockMode();
  return (
    <Studio
      apps={buildCatalog()}
      mock={mock}
      configured={hasApiKey()}
      notice={mock ? null : missingDedicatedKeyMessage()}
    />
  );
}
