export function detectPlatform(): "ios" | "android" | "other" {
  if (typeof navigator === "undefined") return "ios";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "ios"; // the configured device is an iPhone; desktop testing uses the iOS URL form
}
