import type { PromptImage } from '@/app/app-controller';

/** The longest edge a photo keeps in a prompt; larger ones are scaled down to it. */
export const MAX_IMAGE_EDGE = 2048;

/**
 * How much encoded image one message may carry. The Host's WebSocket takes messages up to 32 MiB;
 * this keeps a prompt well under that.
 */
export const MAX_PROMPT_IMAGE_BYTES = 12 * 1024 * 1024;

/** A size scaled to fit `max` on its longest edge, never up. */
export function scaledSize(width: number, height: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Encoded size, in bytes, of a message's images. */
export const imagesSize = (images: PromptImage[]) => images.reduce((total, { data }) => total + data.length, 0);

const base64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the photo."));
  reader.readAsDataURL(blob);
});

/** A photo from Photos or the camera, scaled down and re-encoded as JPEG for a prompt. */
export async function promptImage(file: File): Promise<PromptImage> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const { width, height } = scaledSize(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error("Couldn't prepare the photo.");
    // JPEG has no transparency: what was transparent goes white, not black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((encoded) => encoded ? resolve(encoded) : reject(new Error("Couldn't encode the photo.")), 'image/jpeg', 0.85));
    return { mimeType: 'image/jpeg', data: await base64(blob), ...(file.name ? { name: file.name } : {}) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
