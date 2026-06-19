// SVG → PNG on the worker, no browser. resvg is pure WASM (the rasterizer half of
// the @vercel/og stack); it needs font bytes supplied since workerd has no system
// fonts, so we embed the two we use. Used to turn an OG card SVG into a PNG that
// unfurls everywhere.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import hankenFont from "../../assets/fonts/HankenGrotesk.ttf";
import splineFont from "../../assets/fonts/SplineSansMono.ttf";

let initPromise: Promise<unknown> | null = null;
function ensureInit(): Promise<unknown> {
  // initWasm throws if called twice, so memoize the promise per isolate.
  if (!initPromise) initPromise = initWasm(resvgWasm as unknown as WebAssembly.Module).catch((e) => { initPromise = null; throw e; });
  return initPromise;
}

export async function svgToPng(svg: string): Promise<Uint8Array> {
  await ensureInit();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: {
      fontBuffers: [new Uint8Array(hankenFont), new Uint8Array(splineFont)],
      defaultFontFamily: "Hanken Grotesk",
      loadSystemFonts: false,
    },
  });
  return resvg.render().asPng();
}
