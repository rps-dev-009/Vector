import limits from "../../../shared/labsImages.json";

export const IMAGE_LIMITS = limits;
export const IMAGE_ONLY_INSTRUCTION = "Describe the attached images. Do not edit the document unless I explicitly ask.";

export function validateImageFile(file) {
  if (!file || !limits.mediaTypes.includes(file.type)) throw new Error("Choose PNG, JPEG, or WebP images. SVG, GIF and HEIC are not supported.");
  if (!file.size) throw new Error("The image file is empty.");
  if (file.size > limits.maxSourceBytes) throw new Error("Each original image must be 10 MB or smaller.");
}

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("This image could not be read."));
    reader.onabort = () => reject(new Error("Image reading was cancelled."));
    reader.readAsDataURL(blob);
  });
}

/** Resize before sending, flatten transparency on white, strip camera metadata. */
export async function prepareImage(file) {
  validateImageFile(file);
  const source = await readDataUrl(file);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("This file is not a readable image. Try another PNG, JPEG, or WebP file."));
    image.src = source;
  });
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > limits.maxSourcePixels) {
    throw new Error("This image is too large to process safely. Resize it below 40 megapixels first.");
  }
  const scale = Math.min(1, limits.maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot prepare image attachments.");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const encode = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
  try {
    let blob = await encode(file.type === "image/png" ? "image/png" : "image/jpeg", .9);
    if (!blob || blob.size > limits.maxBytesPerImage) blob = await encode("image/jpeg", .8);
    if (!blob || blob.size > limits.maxBytesPerImage) throw new Error("This image is still too large after resizing. Crop it or choose a smaller file.");
    const preview = await readDataUrl(blob);
    return {
      id: crypto.randomUUID(), name: (file.name?.trim() || "Pasted image").slice(0, limits.maxNameChars),
      mediaType: blob.type, data: preview.slice(preview.indexOf(",") + 1), preview, bytes: blob.size,
      width: canvas.width, height: canvas.height
    };
  } finally { canvas.width = 0; canvas.height = 0; image.src = ""; }
}

export function imageForRequest({ id, name, mediaType, data }) { return { id, name, mediaType, data }; }
export function imageMetadata({ id, name }) { return { id, name }; }

/** The last four image bodies live in memory, never in localStorage projects. */
export function rememberImages(cache, images) {
  const next = new Map(cache);
  for (const image of images) { next.delete(image.id); next.set(image.id, image); }
  let total = [...next.values()].reduce((sum, image) => sum + image.bytes, 0);
  while (next.size > limits.maxCount || total > limits.maxTotalBytes) {
    const first = next.keys().next().value;
    total -= next.get(first).bytes;
    next.delete(first);
  }
  return next;
}

export function imageHistory(chat, cache, currentImages = []) {
  let count = currentImages.length;
  let total = currentImages.reduce((sum, image) => sum + image.bytes, 0);
  const used = new Set(currentImages.map(image => image.id));
  const history = chat.filter(m => m.role === "user" || m.role === "assistant").slice(-10);
  const result = [];
  for (const message of [...history].reverse()) {
    const included = [];
    const missing = [];
    for (const meta of message.role === "user" ? message.images || [] : []) {
      const image = cache.get(meta.id);
      if (image && !used.has(image.id) && count < limits.maxCount && total + image.bytes <= limits.maxTotalBytes) {
        included.push(imageForRequest(image));
        used.add(image.id); count++; total += image.bytes;
      } else missing.push(meta.name);
    }
    const note = missing.length ? `\n[Earlier image attachments not included in this message: ${JSON.stringify(missing)}. Do not assume you can see them; ask for reattachment if necessary.]` : "";
    result.push({ role: message.role, content: (message.text || "Image attachment") + note, ...(included.length ? { images: included } : {}) });
  }
  return result.reverse();
}
