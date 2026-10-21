/** Shared artwork for the generated app icons (no binary assets in the repo). */
export function IconArt({ size }: { size: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #1d4ed8 0%, #1e3a8a 100%)",
        color: "white",
        fontSize: size * 0.42,
        fontWeight: 700,
        fontFamily: "sans-serif",
        letterSpacing: -size * 0.01,
      }}
    >
      CA
    </div>
  );
}
