import { LIMITS } from '@palmtopai/protocol';

/** The longest side of a screenshot once re-encoded, in pixels. */
export const MAX_SIDE = 1600;
/** Below this the picture is not worth sending: it could not be read. */
const MIN_SIDE = 480;
/** JPEG qualities tried at each size, best first. */
const QUALITIES = [0.82, 0.7, 0.58, 0.46];

export interface PreparedScreenshot {
    mime: 'image/jpeg';
    bytes: Uint8Array;
}

/** The size of `width` x `height` shrunk to fit `maxSide` on its longer side (never enlarged). */
export function fitWithin(
    width: number,
    height: number,
    maxSide: number,
): { width: number; height: number } {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

/** What makes a JPEG of a decoded picture: the browser's canvas in the app, a fake in tests. */
export interface ScreenshotCodec {
    /** Decodes the file; throws when it is not an image this browser can read. */
    decode(file: Blob): Promise<{ width: number; height: number }>;
    /** A JPEG of the decoded picture at this size and quality (on white: no transparency). */
    encode(width: number, height: number, quality: number): Promise<Uint8Array>;
}

export class ScreenshotError extends Error {
    override name = 'ScreenshotError';
}

/**
 * Re-encodes whatever the user picked as a JPEG small enough to send (`LIMITS.image`). It is
 * always re-encoded, never passed through: that drops the metadata of a photo (where it was
 * taken) and turns the formats a browser can read but the computer cannot (HEIC, PNG) into one
 * the computer accepts. Tries the best quality first, then lower, then a smaller picture.
 */
export async function prepareScreenshot(
    file: Blob,
    codec: ScreenshotCodec = browserCodec(),
    maxBytes: number = LIMITS.image,
): Promise<PreparedScreenshot> {
    let picture: { width: number; height: number };
    try {
        picture = await codec.decode(file);
    } catch {
        throw new ScreenshotError('This file is not a picture this device can read.');
    }
    let side = MAX_SIDE;
    for (;;) {
        const { width, height } = fitWithin(picture.width, picture.height, side);
        for (const quality of QUALITIES) {
            const bytes = await codec.encode(width, height, quality).catch(() => {
                throw new ScreenshotError('This device could not prepare the picture.');
            });
            if (bytes.length > 0 && bytes.length <= maxBytes) return { mime: 'image/jpeg', bytes };
        }
        const smaller = Math.round(Math.max(width, height) * 0.8);
        if (smaller < MIN_SIDE) {
            throw new ScreenshotError(
                'This picture is too detailed to be sent: try a smaller one.',
            );
        }
        side = smaller;
    }
}

/** The codec of the app: `createImageBitmap` and a canvas. */
export function browserCodec(): ScreenshotCodec {
    let bitmap: ImageBitmap | undefined;
    return {
        async decode(file) {
            bitmap?.close();
            bitmap = await createImageBitmap(file);
            return { width: bitmap.width, height: bitmap.height };
        },
        async encode(width, height, quality) {
            if (!bitmap) throw new Error('nothing decoded');
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('no canvas');
            context.fillStyle = '#fff';
            context.fillRect(0, 0, width, height);
            context.drawImage(bitmap, 0, 0, width, height);
            const blob = await new Promise<Blob | null>((resolve) =>
                canvas.toBlob(resolve, 'image/jpeg', quality),
            );
            // A browser that cannot make a JPEG answers with a PNG: never sent as one.
            if (blob?.type === 'image/jpeg') return new Uint8Array(await blob.arrayBuffer());
            throw new Error('no JPEG');
        },
    };
}
