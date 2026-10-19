const express = require("express");
const IMAGE_SPEC = require("../../shared/labsImages.json");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BASE64_CHARS = 4 * Math.ceil(IMAGE_SPEC.maxBytesPerImage / 3);

// Carry the request's budget across current images and retained user history.
// Errors never include caller-provided names, ids or encoded data.
function validateImages(images, { count = 0, totalBytes = 0 } = {}) {
  if (images === undefined) images = [];
  if (!Array.isArray(images)) {
    return { ok: false, error: "images must be an array of image attachments." };
  }
  if (count + images.length > IMAGE_SPEC.maxCount) {
    return { ok: false, tooLarge: true, error: `At most ${IMAGE_SPEC.maxCount} images are allowed across recent history and the current request.` };
  }
  const checked = [];
  for (const image of images) {
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      return { ok: false, error: "Each image must be an object with name, mediaType and base64 data." };
    }
    if (image.id !== undefined && typeof image.id !== "string") {
      return { ok: false, error: "Image id must be a string when supplied." };
    }
    if (typeof image.name !== "string" || !image.name.trim() || image.name.length > IMAGE_SPEC.maxNameChars) {
      return { ok: false, error: `Image name must be a non-empty string of at most ${IMAGE_SPEC.maxNameChars} characters.` };
    }
    if (!IMAGE_SPEC.mediaTypes.includes(image.mediaType)) {
      return { ok: false, error: "Image mediaType must be image/png, image/jpeg or image/webp." };
    }
    if (typeof image.data !== "string" || !image.data.length) {
      return { ok: false, error: "Image data must be raw canonical base64, not a URL or data URI." };
    }
    if (image.data.length > MAX_BASE64_CHARS) {
      return { ok: false, tooLarge: true, error: "Each image must be at most 2 MiB decoded." };
    }
    // Validate before decoding: Buffer.from otherwise accepts whitespace, URL-safe
    // alphabet, missing padding and junk. The round trip also checks padding bits.
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    const encoded = image.data.slice(0, image.data.length - padding);
    if (image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+$/.test(encoded)) {
      return { ok: false, error: "Image data must be raw canonical base64, not a URL or data URI." };
    }
    const byteLength = image.data.length / 4 * 3 - padding;
    if (byteLength > IMAGE_SPEC.maxBytesPerImage) {
      return { ok: false, tooLarge: true, error: "Each image must be at most 2 MiB decoded." };
    }
    if (totalBytes + byteLength > IMAGE_SPEC.maxTotalBytes) {
      return { ok: false, tooLarge: true, error: "Images across recent history and the current request must total at most 8 MiB decoded." };
    }
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.toString("base64") !== image.data) {
      return { ok: false, error: "Image data must use canonical base64 padding." };
    }
    const matches = image.mediaType === "image/png"
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      : image.mediaType === "image/jpeg"
        ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
    if (!matches) {
      return { ok: false, error: "Image bytes do not match the declared PNG, JPEG or WebP mediaType." };
    }
    checked.push({ ...(image.id !== undefined ? { id: image.id } : {}), name: image.name, mediaType: image.mediaType, data: image.data });
    totalBytes += bytes.length;
  }
  return { ok: true, images: checked, count: count + checked.length, totalBytes };
}

const parseJson = express.json({ limit: IMAGE_SPEC.jsonBodyLimit });
function labsJsonParser(req, res, next) {
  parseJson(req, res, (error) => {
    if (!error) return next();
    // Body-parser's syntax errors can quote the uploaded bytes. Do not send
    // them through Express's default HTML error response or server logging.
    const status = error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
    return res.status(status).json({ error: status === 413
      ? `Labs request body exceeds the ${IMAGE_SPEC.jsonBodyLimit} JSON limit.`
      : "Labs request body must be valid supported JSON." });
  });
}

module.exports = { IMAGE_SPEC, validateImages, labsJsonParser };
