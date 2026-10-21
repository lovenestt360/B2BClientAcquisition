import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import { lanAddresses } from "@/server/lan";
import { startOfLocalDay } from "@/server/today";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }) as NetworkInterfaceInfo;

describe("lanAddresses", () => {
  it("lists reachable Wi-Fi/LAN IPv4 addresses, skipping loopback, virtual and link-local", () => {
    const r = lanAddresses(3000, {
      lo: [v4("127.0.0.1", true)],
      docker0: [v4("172.17.0.1")],
      en0: [v4("192.168.1.20"), { ...v4("fe80::1"), family: "IPv6" } as NetworkInterfaceInfo],
      eth1: [v4("10.0.0.5")],
      wlan0: [v4("169.254.10.2")],
    });
    expect(r.map((a) => a.url)).toEqual(["http://192.168.1.20:3000", "http://10.0.0.5:3000"]);
  });
});

describe("startOfLocalDay", () => {
  it("returns SAST midnight as a UTC instant", () => {
    expect(startOfLocalDay(new Date("2026-10-21T08:00:00Z"), "Africa/Johannesburg").toISOString()).toBe("2026-10-20T22:00:00.000Z");
    // 23:30 UTC is already the next day in SAST
    expect(startOfLocalDay(new Date("2026-10-21T23:30:00Z"), "Africa/Johannesburg").toISOString()).toBe("2026-10-21T22:00:00.000Z");
  });
});
