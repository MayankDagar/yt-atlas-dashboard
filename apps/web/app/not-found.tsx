import Link from "next/link";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="not-found-page">
      <div className="not-found-card">
        <span className="not-found-code">404</span>
        <h1>This page isn’t in your workspace.</h1>
        <p>The address may be outdated, or the page may have moved.</p>
        <Link className="button button-primary" href="/#overview">Return to YT Atlas</Link>
      </div>
      <span className="not-found-footer">© 2026 YT Atlas · Private analytics</span>
    </main>
  );
}
