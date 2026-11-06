export const MAX_PRODUCT_IMAGE_SIZE = 5 * 1024 * 1024;
export const MAX_PRODUCT_IMAGE_REQUEST_SIZE = MAX_PRODUCT_IMAGE_SIZE + 64 * 1024;

const IMAGE_TYPES = {
  "image/jpeg": { extension: "jpg", signature: [0xff, 0xd8, 0xff] },
  "image/png": {
    extension: "png",
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  "image/gif": { extension: "gif", signatures: ["GIF87a", "GIF89a"] },
  "image/webp": { extension: "webp", signature: "WEBP", offset: 8 },
} as const;

export type ProductImageMimeType = keyof typeof IMAGE_TYPES;

export function getProductImageExtension(
  bytes: Uint8Array,
  declaredType: string
): string | null {
  if (!Object.hasOwn(IMAGE_TYPES, declaredType)) return null;

  const imageType = IMAGE_TYPES[declaredType as ProductImageMimeType];
  if ("signatures" in imageType) {
    const header = String.fromCharCode(...bytes.subarray(0, 6));
    return imageType.signatures.some((signature) => signature === header)
      ? imageType.extension
      : null;
  }

  if (typeof imageType.signature === "string") {
    const signature = new TextEncoder().encode(imageType.signature);
    const riffHeader = [0x52, 0x49, 0x46, 0x46];
    return (
      imageType.offset + signature.length <= bytes.length &&
      riffHeader.every((byte, index) => bytes[index] === byte) &&
      signature.every((byte, index) => bytes[imageType.offset + index] === byte)
    )
      ? imageType.extension
      : null;
  }

  return imageType.signature.every((byte, index) => bytes[index] === byte)
    ? imageType.extension
    : null;
}
