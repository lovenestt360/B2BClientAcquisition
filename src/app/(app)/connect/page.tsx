import { headers } from "next/headers";
import QRCode from "qrcode";
import { env } from "@/lib/env";
import { lanAddresses } from "@/server/lan";
import { PageHeader } from "@/components/ui";

export default async function ConnectPage() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const port = Number(host.split(":")[1] ?? (proto === "https" ? 443 : 80));
  const onLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])/.test(host);
  // When already opened via a LAN/public address, that address is the one to share.
  const candidates = onLocalhost ? lanAddresses(port) : [{ name: "this address", address: host, url: `${proto}://${host}` }];
  const qrs = await Promise.all(candidates.map((c) => QRCode.toString(`${c.url}/login`, { type: "svg", margin: 1, width: 220 })));
  const e = env();
  const httpLan = candidates.some((c) => c.url.startsWith("http://"));

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Connect your phone" subtitle="Use the iPhone with your Telkom eSIM for SMS and calls. The laptop runs the platform." />

      {candidates.length === 0 ? (
        <p className="card text-sm">No Wi-Fi address found. Connect the laptop to Wi-Fi and start the app with <code>npm run laptop</code> (it listens on all interfaces).</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {candidates.map((c, i) => (
            <div key={c.url} className="card text-center" data-testid="connect-qr">
              <div className="mx-auto w-[220px] [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: qrs[i] }} />
              <p className="mt-2 break-all font-mono text-sm">{c.url}</p>
              <p className="text-xs text-slate-500">{c.name}</p>
            </div>
          ))}
        </div>
      )}

      <section className="card space-y-2 text-sm">
        <h2 className="font-semibold">On the iPhone</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Join the <strong>same Wi-Fi</strong> as this laptop.</li>
          <li>Open the <strong>Camera</strong>, point it at the QR code and tap the link (it opens in Safari).</li>
          <li>Sign in, then tap <strong>Share</strong> → <strong>Add to Home Screen</strong>. It opens full-screen like an app, starting on <em>Today</em>.</li>
          <li>Use the tabs at the bottom: <em>Today</em> for your work queue, <em>SMS</em>, <em>Calls</em>, <em>Contacts</em>.</li>
        </ol>
      </section>

      <section className="card space-y-1 text-sm">
        <h2 className="font-semibold">Good to know</h2>
        <ul className="list-disc space-y-1 pl-5 text-slate-700">
          <li>The phone only reaches the app while the laptop is on, awake and on this network.</li>
          {httpLan && e.COOKIE_SECURE && <li className="text-red-700">COOKIE_SECURE=true but this address is plain http: sign-in from the phone will not stick. Set COOKIE_SECURE=false for Wi-Fi use, or put HTTPS in front.</li>}
          {httpLan && <li>Over plain http the phone can&apos;t use the microphone or offline page. Run the AI voice sandbox in the laptop browser, or add HTTPS (docs/DEPLOYMENT.md).</li>}
          <li>Messages and calls go out from the iPhone&apos;s own apps and your airtime. The laptop never sends anything itself.</li>
        </ul>
      </section>
    </div>
  );
}
