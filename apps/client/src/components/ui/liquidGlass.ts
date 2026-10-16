"use client";

import { useEffect, type RefObject } from "react";

/**
 * Liquid glass lens.
 *
 * Builds an SVG filter that bends whatever is behind the element near its rounded edge, like light through a thick
 * piece of glass, with a slight colour split at the rim. The element picks it up through the `--lg-bf` custom
 * property, which its CSS feeds into `backdrop-filter`. Only Chromium can use an SVG filter as a backdrop filter, so
 * every other browser keeps the plain blur written as the CSS fallback.
 */

type Options = { scale?: number; bezel?: number; blur?: number; brightness?: number };

let next = 0;

function supportsLens(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (matchMedia("(prefers-reduced-transparency: reduce)").matches) return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return !!brands?.some((b) => /Chromium/i.test(b.brand));
}

/**
 * Displacement map: every pixel inside the bezel points toward the middle, strongest right at the edge.
 * Keep scale below about 1.3 x bezel, or the edge folds over and shows mirrored pieces of what is behind it.
 */
function lensMap(w: number, h: number, radius: number, bezel: number): HTMLCanvasElement | null {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  // Start every pixel at "no bend" (128, 128, 128), then work out only the band along the edge. The middle of a big
  // card never bends, so this keeps the work small.
  new Uint32Array(d.buffer).fill(new Uint32Array(new Uint8Array([128, 128, 128, 255]).buffer)[0]);
  const r = Math.max(1, Math.min(radius, h / 2, w / 2));
  const band = Math.ceil(Math.max(bezel, r)) + 1;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < band || y >= h - band;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x === band && w - band > band) x = w - band;
      const px = x + 0.5;
      const py = y + 0.5;
      const cx = Math.min(Math.max(px, r), w - r);
      const cy = Math.min(Math.max(py, r), h - r);
      let vx = px - cx;
      let vy = py - cy;
      let len = Math.hypot(vx, vy);
      let edge: number;
      if (len > 0) {
        edge = r - len;
        vx /= len;
        vy /= len;
      } else {
        const sides = [px, w - px, py, h - py];
        edge = Math.min(...sides);
        const k = sides.indexOf(edge);
        vx = k === 0 ? -1 : k === 1 ? 1 : 0;
        vy = k === 2 ? -1 : k === 3 ? 1 : 0;
        len = 1;
      }
      let dx = 0;
      let dy = 0;
      if (edge < bezel && edge >= 0) {
        const t = 1 - edge / bezel;
        const m = t * t * (3 - 2 * t);
        dx = -vx * m;
        dy = -vy * m;
      }
      const i = (y * w + x) * 4;
      d[i] = Math.round(128 + dx * 127);
      d[i + 1] = Math.round(128 + dy * 127);
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const CHANNELS = [
  { k: 1.03, m: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" },
  { k: 1, m: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" },
  { k: 0.97, m: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" },
];

function filterMarkup(w: number, h: number, map: string, scale: number): string {
  const passes = CHANNELS.map(
    (c, i) =>
      `<feDisplacementMap in="SourceGraphic" in2="map" scale="${(scale * c.k).toFixed(1)}" xChannelSelector="R" yChannelSelector="G" result="d${i}"/>` +
      `<feColorMatrix in="d${i}" type="matrix" values="${c.m}" result="c${i}"/>`,
  ).join("");
  return (
    `<feImage href="${map}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>` +
    passes +
    `<feBlend in="c0" in2="c1" mode="screen" result="rg"/>` +
    `<feBlend in="rg" in2="c2" mode="screen"/>`
  );
}

/**
 * Maps already drawn, by size and shape, so a card that scrolls back into view doesn't redraw its map. The map is
 * worked out at half size (the bend is smooth, so stretching it back loses nothing) and turned into an image off
 * the main thread, so scrolling never stutters while a map is made.
 */
const MAP_RES = 0.5;
const maps = new Map<string, Promise<string>>();
function mapFor(w: number, h: number, radius: number, bezel: number): Promise<string> {
  const key = `${w}x${h}r${radius}b${bezel}`;
  let url = maps.get(key);
  if (!url) {
    const mw = Math.max(1, Math.round(w * MAP_RES));
    const mh = Math.max(1, Math.round(h * MAP_RES));
    const small = lensMap(mw, mh, radius * MAP_RES, bezel * MAP_RES);
    // Chrome draws an feImage at its own size, so stretch the small map back to full size before handing it over.
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (small && ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(small, 0, 0, w, h);
    }
    url = new Promise<string>((done) => (small && ctx ? c.toBlob((b) => done(b ? URL.createObjectURL(b) : ""), "image/png") : done("")));
    maps.set(key, url);
    if (maps.size > 60) {
      const [oldKey, old] = maps.entries().next().value as [string, Promise<string>];
      maps.delete(oldKey);
      void old.then((u) => u && URL.revokeObjectURL(u));
    }
  }
  return url;
}

/** Puts the lens on one element and keeps it the right size. Returns the function that takes it off again. */
export function attachLiquidGlass(el: HTMLElement, { scale = 24, bezel = 20, blur = 1.6, brightness = 1.08 }: Options = {}): () => void {
  const id = `lg-${++next}`;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  const filter = document.createElementNS(NS, "filter");
  filter.setAttribute("id", id);
  filter.setAttribute("filterUnits", "userSpaceOnUse");
  filter.setAttribute("primitiveUnits", "userSpaceOnUse");
  filter.setAttribute("color-interpolation-filters", "sRGB");
  filter.setAttribute("x", "0");
  filter.setAttribute("y", "0");
  svg.appendChild(filter);
  document.body.appendChild(svg);

  let w = 0;
  let h = 0;
  let frame = 0;
  let live = true;
  const render = () => {
    frame = 0;
    const nw = el.offsetWidth;
    const nh = el.offsetHeight;
    if (!nw || !nh || (nw === w && nh === h)) return;
    w = nw;
    h = nh;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || h / 2;
    void mapFor(w, h, radius, bezel).then((map) => {
      if (!live || !map || w !== nw || h !== nh) return;
      filter.setAttribute("width", String(w));
      filter.setAttribute("height", String(h));
      filter.innerHTML = filterMarkup(w, h, map, scale);
      el.style.setProperty("--lg-bf", `url(#${id}) blur(${blur}px) saturate(165%) brightness(${brightness})`);
    });
  };
  const ro = new ResizeObserver(() => {
    if (!frame) frame = requestAnimationFrame(render);
  });
  ro.observe(el);
  render();

  return () => {
    live = false;
    ro.disconnect();
    if (frame) cancelAnimationFrame(frame);
    el.style.removeProperty("--lg-bf");
    svg.remove();
  };
}

export function useLiquidGlass(ref: RefObject<HTMLElement | null>, { scale = 24, bezel = 20, blur = 1.6, brightness = 1.08 }: Options = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !supportsLens()) return;
    return attachLiquidGlass(el, { scale, bezel, blur, brightness });
  }, [ref, scale, bezel, blur, brightness]);
}

/**
 * The lens on every element under `root` (the whole page when `root` is null) that matches `selector`, including
 * ones that appear later. Each one gets it only while it is on or near the screen, so a long page doesn't keep two
 * dozen filters running at once.
 */
export function useLiquidGlassAll(
  root: RefObject<HTMLElement | null> | null,
  selector: string,
  { scale = 24, bezel = 20, blur = 1.6, brightness = 1.08 }: Options = {},
) {
  useEffect(() => {
    if (!supportsLens()) return;
    const host = root ? root.current : document.body;
    if (!host) return;
    const off = new Map<Element, () => void>();
    const seen = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          if (e.isIntersecting && !off.has(el)) off.set(el, attachLiquidGlass(el, { scale, bezel, blur, brightness }));
          else if (!e.isIntersecting && off.has(el)) {
            off.get(el)!();
            off.delete(el);
          }
        }
      },
      { rootMargin: "300px 0px" },
    );
    let frame = 0;
    const scan = () => {
      frame = 0;
      for (const el of seen) {
        if (el.isConnected) continue;
        io.unobserve(el);
        off.get(el)?.();
        off.delete(el);
        seen.delete(el);
      }
      host.querySelectorAll(selector).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        io.observe(el);
      });
    };
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(scan);
    });
    mo.observe(host, { childList: true, subtree: true });
    scan();
    return () => {
      mo.disconnect();
      io.disconnect();
      if (frame) cancelAnimationFrame(frame);
      off.forEach((stop) => stop());
    };
  }, [root, selector, scale, bezel, blur, brightness]);
}
