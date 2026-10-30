// Khareedo image generator — resumable background job.
// Usage: bun scripts/generate-images.ts
import ZAI from "z-ai-web-dev-sdk";
import fs from "fs";
import path from "path";
import { PRODUCTS } from "./catalog";

const ROOT = "/home/z/my-project/public/images";
const PRODUCT_DIR = path.join(ROOT, "products");
const BANNER_DIR = path.join(ROOT, "banners");

const LOG = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function genImage(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  prompt: string,
  outPath: string,
  size: string,
  retries = 3
): Promise<boolean> {
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
    LOG(`SKIP exists: ${path.basename(outPath)}`);
    return true;
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await zai.images.generations.create({ prompt, size });
      const b64 = response?.data?.[0]?.base64;
      if (!b64) throw new Error("empty response");
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 5000) throw new Error("suspiciously small image");
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf);
      LOG(`OK: ${path.basename(outPath)} (${Math.round(buf.length / 1024)}KB)`);
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      LOG(`FAIL(${attempt}/${retries}): ${path.basename(outPath)} — ${msg}`);
      if (attempt < retries) {
        // Longer backoff for 429 rate limits
        const is429 = msg.includes("429");
        await new Promise((r) => setTimeout(r, is429 ? 20000 * attempt : 1500 * attempt));
      }
    }
  }
  return false;
}

async function main() {
  // CLI: --max-seconds=SECONDS (time budget, then exit), --concurrency=N
  const args = process.argv.slice(2);
  const maxSeconds = Number(args.find((a) => a.startsWith("--max-seconds="))?.split("=")[1] ?? "0");
  const concurrency = Math.max(1, Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "5"));
  const deadline = maxSeconds > 0 ? Date.now() + maxSeconds * 1000 : Infinity;

  fs.mkdirSync(PRODUCT_DIR, { recursive: true });
  fs.mkdirSync(BANNER_DIR, { recursive: true });
  const zai = await ZAI.create();

  type Job = { prompt: string; out: string; size: string };
  const jobs: Job[] = [];
  for (const p of PRODUCTS) {
    jobs.push({ prompt: p.imagePrompt, out: path.join(PRODUCT_DIR, `${p.slug}.png`), size: "1024x1024" });
  }
  jobs.push(
    { prompt: "Wide studio still-life photograph: a silver wrist watch, white wireless earbuds in open case, tan leather handbag and a glass perfume bottle arranged on round beige stone podiums, green plant leaves softly blurred behind, warm cream seamless background, bright soft daylight, premium retail display, completely empty beige space on the left half of the frame, pure photography with zero text, zero letters, zero words, zero numbers, zero logos, zero labels", out: path.join(BANNER_DIR, "hero-1.png"), size: "1344x768" },
    { prompt: "Wide e-commerce hero banner photograph: premium smart watch and wireless black earbuds displayed on stone pedestals with dramatic soft lighting, dark green gradient background, empty space on left for headline text, premium tech advertising style, high quality, no text, no watermark", out: path.join(BANNER_DIR, "hero-2.png"), size: "1344x768" },
    { prompt: "Wide e-commerce sale hero banner photograph: assorted gift items — perfume bottle, gold jewellery, leather wallet and watch — with soft gift boxes and ribbons on a cream background, festive premium shopping mood, empty space on left for text, high quality, no text, no watermark", out: path.join(BANNER_DIR, "hero-3.png"), size: "1344x768" },
    { prompt: "Square product photograph: modern smart watch with black strap standing upright on a beige podium, soft green bokeh leaves in background, premium product advertising style, high quality, no text, no watermark", out: path.join(BANNER_DIR, "side-smartwatch.png"), size: "1024x1024" },
    { prompt: "Square product photograph: premium black wireless earbuds with open charging case on a warm beige surface with soft plant shadow, premium product advertising style, high quality, no text, no watermark", out: path.join(BANNER_DIR, "side-earbuds.png"), size: "1024x1024" }
  );

  const pending = jobs.filter((j) => !(fs.existsSync(j.out) && fs.statSync(j.out).size > 10000));
  LOG(`Queue: ${pending.length} of ${jobs.length} images pending (concurrency=${concurrency}${maxSeconds ? `, budget=${maxSeconds}s` : ""})`);

  let done = 0;
  let failed = 0;
  let index = 0;

  async function worker(id: number) {
    while (index < pending.length) {
      if (Date.now() > deadline) return;
      const job = pending[index++];
      const ok = await genImage(zai, job.prompt, job.out, job.size);
      if (ok) done++;
      else failed++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  const remaining = pending.length - done - failed;
  LOG(`CHUNK DONE. success=${done} failed=${failed} remaining=${Math.max(0, remaining)}`);
  if (Date.now() > deadline) LOG("Time budget reached — rerun to continue.");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
