import { Studio } from "@/components/Studio";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="top">
        <div className="wordmark">
          <svg className="mark" viewBox="0 0 32 32" aria-hidden>
            <rect x="6" y="8" width="20" height="16" rx="2" fill="none" stroke="#1b1712" strokeWidth="1.6" />
            <path d="M6 12h20" stroke="#b08958" strokeWidth="1.6" />
            <path d="M16 8v16" stroke="#1b1712" strokeWidth="1.2" opacity="0.35" />
          </svg>
          Open <em>Unboxing</em>
        </div>
        <div className="meta">
          Comfy Cloud · MIT
          <br />
          Hands-only overhead ASMR
        </div>
      </header>

      <section className="hero">
        <h1>The box is the set. The product is the talent.</h1>
        <p className="lede">
          Upload five or more product-only stills, pick an unbranded mailer, and get a locked
          top-down unboxing — sealed, nested, lifted, rotated, on the table. Built as an open
          alternative to Higgsfield Marketing Studio Unboxing mode.
        </p>
      </section>

      <Studio />

      <footer className="foot">
        <span>Workflows in <code>workflows/</code> · Comfy Cloud only</span>
        <span>FLUX 3 · Qwen Image Edit 2511 · LTX 2.5 · MiniMax H3 · RIFE</span>
      </footer>
    </main>
  );
}
