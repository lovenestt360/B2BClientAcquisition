import { networkInterfaces } from "node:os";

export interface LanAddress {
  name: string;
  address: string;
  url: string;
}

const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tailscale|zt|lo)/i;

/** IPv4 addresses a phone on the same Wi-Fi can use to reach this laptop. */
export function lanAddresses(port: number, ifaces = networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || VIRTUAL.test(name)) continue;
    for (const a of list) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      out.push({ name, address: a.address, url: `http://${a.address}:${port}` });
    }
  }
  // Typical home/office Wi-Fi ranges first.
  const rank = (ip: string) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 2 : 3);
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}
