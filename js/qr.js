// Leitura de QR Code com ZXing (WebAssembly, incluído no app — funciona offline).
// Muito mais robusto que jsQR para o QR denso e pequeno dos cupons de NFC-e.
import { prepareZXingModule, readBarcodes } from '../vendor/zxing/reader/index.js';

const WASM_URL = new URL('../vendor/zxing/zxing_reader.wasm', import.meta.url).href;
prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? WASM_URL : prefix + path) } });

const OPTIONS = { formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 1 };

let native = null;
async function nativeDetector() {
  if (native !== null) return native;
  native = false;
  try {
    if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      native = new window.BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch { native = false; }
  return native;
}

/** Recorta (sx,sy,sw,sh) da fonte e redimensiona para no máx. maxSide; devolve ImageData. */
function grab(source, sw0, sh0, { crop = 1, maxSide = 1280 } = {}) {
  const sw = Math.round(sw0 * crop); const sh = Math.round(sh0 * crop);
  const sx = Math.round((sw0 - sw) / 2); const sy = Math.round((sh0 - sh) / 2);
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function zxing(imageData) {
  const res = await readBarcodes(imageData, OPTIONS);
  return res.find((r) => r.isValid && r.text)?.text || null;
}

/**
 * Tenta ler um QR de um vídeo/imagem/canvas. `attempt` alterna entre o quadro
 * inteiro e um recorte central em resolução cheia (bom quando o QR está pequeno).
 */
export async function decodeFrame(source, width, height, attempt = 0) {
  const det = await nativeDetector();
  if (det) {
    try {
      const codes = await det.detect(source);
      if (codes.length && codes[0].rawValue) return codes[0].rawValue;
    } catch { /* segue com ZXing */ }
  }
  const variants = [{ crop: 1, maxSide: 1280 }, { crop: 0.6, maxSide: 1600 }, { crop: 0.4, maxSide: 1600 }];
  return zxing(grab(source, width, height, variants[attempt % variants.length]));
}

/** Lê o QR de uma foto tentando várias escalas e recortes. */
export async function decodeImage(bitmap) {
  const w = bitmap.width; const h = bitmap.height;
  const tries = [
    { crop: 1, maxSide: 2000 }, { crop: 1, maxSide: 1200 }, { crop: 1, maxSide: 800 },
    { crop: 0.6, maxSide: 2000 }, { crop: 0.4, maxSide: 2000 },
  ];
  const det = await nativeDetector();
  if (det) {
    try { const c = await det.detect(bitmap); if (c.length && c[0].rawValue) return c[0].rawValue; } catch { /* ZXing */ }
  }
  for (const t of tries) {
    const text = await zxing(grab(bitmap, w, h, t));
    if (text) return text;
  }
  return null;
}

/** Pré-carrega o WASM (chamado ao abrir a câmera, para o 1º quadro não demorar). */
export function warmUp() {
  return zxing(new ImageData(8, 8)).catch(() => null);
}
