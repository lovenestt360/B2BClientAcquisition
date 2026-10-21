/**
 * Asterisk ARI client for the FUTURE authorised SIP voice channel.
 *
 * Every call path goes through assertCanAutomate(): it throws unless ALLOW_AUTOMATED_OUTREACH
 * is on, the asterisk_sip_ai provider is enabled, and a carrier authorisation reference is
 * recorded. Use only with a business SIP trunk whose operator permits AI calling. Never point
 * this at a PBX holding a consumer SIM.
 *
 * Call flow (see docs/VOICE.md):
 *   originate PJSIP/<trunk>/<e164> into Stasis app  →  create mixing bridge
 *   → externalMedia channel (RTP slin16 to the media bridge)  →  add both to the bridge
 *   → media bridge: RTP in → streaming STT → ConversationEngine → TTS → RTP out
 *   → human takeover: add operator endpoint to the bridge, remove externalMedia
 *   → emergency hang-up: DELETE /channels/{id}
 */
import { assertCanAutomate } from "../../providers/gate";
import type { ProviderRuntimeConfig } from "../../providers/types";

export interface AriConfig {
  url: string; // http://asterisk:8088/ari
  user: string;
  password: string;
  app: string; // Stasis application name
  trunk: string; // PJSIP endpoint of the authorised trunk
  mediaHost: string; // host:port of the RTP media bridge
}

export class AriClient {
  constructor(
    private cfg: AriConfig,
    private provider: ProviderRuntimeConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async req<T>(method: string, path: string, query: Record<string, string> = {}): Promise<T> {
    assertCanAutomate(this.provider);
    const qs = new URLSearchParams(query).toString();
    const res = await this.fetchImpl(`${this.cfg.url}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${this.cfg.user}:${this.cfg.password}`).toString("base64")}` },
    });
    if (!res.ok) throw new Error(`ARI ${method} ${path} → ${res.status}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  originate(e164: string, callId: string) {
    return this.req<{ id: string }>("POST", "/channels", {
      endpoint: `PJSIP/${this.cfg.trunk}/${e164}`,
      app: this.cfg.app,
      appArgs: callId,
      timeout: "30",
    });
  }

  createBridge() {
    return this.req<{ id: string }>("POST", "/bridges", { type: "mixing" });
  }

  externalMedia(callId: string) {
    return this.req<{ id: string }>("POST", "/channels/externalMedia", {
      app: this.cfg.app,
      external_host: this.cfg.mediaHost,
      format: "slin16",
      encapsulation: "rtp",
      transport: "udp",
      direction: "both",
      data: callId,
    });
  }

  addToBridge(bridgeId: string, channelIds: string[]) {
    return this.req<void>("POST", `/bridges/${bridgeId}/addChannel`, { channel: channelIds.join(",") });
  }

  removeFromBridge(bridgeId: string, channelId: string) {
    return this.req<void>("POST", `/bridges/${bridgeId}/removeChannel`, { channel: channelId });
  }

  hangup(channelId: string) {
    return this.req<void>("DELETE", `/channels/${channelId}`);
  }
}
