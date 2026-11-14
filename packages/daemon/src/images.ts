import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type ImageMime, isId, LIMITS } from '@palmtopai/protocol';
import { ensurePrivateDir, isErrnoException, writeFileAtomic } from './fs-utils';

/** Screenshots a project keeps, and their bytes in all. */
export const MAX_PROJECT_IMAGES = 500;
export const MAX_PROJECT_IMAGE_BYTES = 64 * 1024 * 1024;

/** What a folder of screenshots may hold. */
export interface ImageLimits {
    images: number;
    bytes: number;
}

export const PROJECT_IMAGE_LIMITS: ImageLimits = {
    images: MAX_PROJECT_IMAGES,
    bytes: MAX_PROJECT_IMAGE_BYTES,
};
/** The copy of a checklist shared with a person holds far less than a project of the computer. */
export const GUEST_IMAGE_LIMITS: ImageLimits = { images: 30, bytes: 8 * 1024 * 1024 };
/** An image no note names yet is kept this long: the note often follows the image, not the reverse. */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

const EXTENSIONS: Record<ImageMime, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MIMES: Record<string, ImageMime> = { jpg: 'image/jpeg', webp: 'image/webp' };
const FILE_NAME = /^([0-9A-HJKMNP-TV-Z]{26})\.([0-9A-HJKMNP-TV-Z]{26})\.(jpg|webp)$/;

/** Why a screenshot was not stored: what is wrong with it (`type`, `size`) or the room (`quota`). */
export class ImageError extends Error {
    override name = 'ImageError';
    constructor(
        readonly reason: 'type' | 'size' | 'quota',
        message: string,
    ) {
        super(message);
    }
}

/** What the first bytes say the image is, whatever the device claimed. */
export function detectMime(bytes: Uint8Array): ImageMime | null {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    const riff = (offset: number, text: string) =>
        [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
    if (bytes.length >= 12 && riff(0, 'RIFF') && riff(8, 'WEBP')) return 'image/webp';
    return null;
}

export interface StoredImage {
    imageId: string;
    sessionId: string;
    mime: ImageMime;
    path: string;
    bytes: number;
    modifiedAt: number;
}

/**
 * The screenshots the user attached on a device, as files of this computer:
 * `images/<projectId>/<sessionId>.<imageId>.<jpg|webp>` (mode 600). They stay out of `data/`,
 * where the log and the state are, and out of the ops: a note names an image by its id.
 * An image lives as long as a note names it, and goes with its session and its project.
 */
export class ImageStore {
    readonly #root: string;
    readonly #locks = new Map<string, Promise<unknown>>();

    constructor(root: string) {
        this.#root = root;
    }

    /** One project at a time: the quota is checked against what the folder holds. */
    #withLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
        const run = (this.#locks.get(projectId) ?? Promise.resolve())
            .catch(() => undefined)
            .then(task);
        this.#locks.set(projectId, run);
        return run.finally(() => {
            if (this.#locks.get(projectId) === run) this.#locks.delete(projectId);
        });
    }

    #dir(projectId: string): string {
        if (!isId(projectId)) throw new Error(`invalid project id ${JSON.stringify(projectId)}`);
        return join(this.#root, projectId);
    }

    async put(
        projectId: string,
        sessionId: string,
        imageId: string,
        mime: ImageMime,
        bytes: Uint8Array,
        limits: ImageLimits = PROJECT_IMAGE_LIMITS,
    ): Promise<void> {
        if (!isId(sessionId) || !isId(imageId)) throw new Error('invalid image id');
        if (bytes.length === 0 || bytes.length > LIMITS.image) {
            throw new ImageError('size', `the image is larger than ${LIMITS.image} bytes`);
        }
        if (detectMime(bytes) !== mime) {
            throw new ImageError('type', 'the image is not a JPEG or WebP file');
        }
        await this.#withLock(projectId, async () => {
            const dir = this.#dir(projectId);
            await ensurePrivateDir(this.#root);
            await ensurePrivateDir(dir);
            const existing = await this.#list(projectId);
            const same = existing.get(imageId);
            const others = [...existing.values()].filter((image) => image.imageId !== imageId);
            const total = others.reduce((sum, image) => sum + image.bytes, bytes.length);
            if (others.length + 1 > limits.images || total > limits.bytes) {
                throw new ImageError('quota', 'this project holds as many screenshots as it can');
            }
            // The same id again replaces the file (a retry, or another type).
            const path = join(dir, `${sessionId}.${imageId}.${EXTENSIONS[mime]}`);
            await writeFileAtomic(path, bytes);
            if (same && same.path !== path) await rm(same.path, { force: true });
        });
    }

    /** Every image of a project, by id. */
    async #list(projectId: string): Promise<Map<string, StoredImage>> {
        const dir = this.#dir(projectId);
        let names: string[];
        try {
            names = await readdir(dir);
        } catch (error) {
            if (isErrnoException(error, 'ENOENT')) return new Map();
            throw error;
        }
        const images = new Map<string, StoredImage>();
        for (const name of names) {
            const match = FILE_NAME.exec(name);
            if (!match) continue;
            const [, sessionId, imageId, extension] = match as unknown as [
                string,
                string,
                string,
                string,
            ];
            const path = join(dir, name);
            try {
                const info = await stat(path);
                images.set(imageId, {
                    imageId,
                    sessionId,
                    mime: MIMES[extension] as ImageMime,
                    path,
                    bytes: info.size,
                    modifiedAt: info.mtimeMs,
                });
            } catch (error) {
                if (!isErrnoException(error, 'ENOENT')) throw error;
            }
        }
        return images;
    }

    /** Where the images of a project are, by id (one listing for a whole feedback). */
    index(projectId: string): Promise<Map<string, StoredImage>> {
        return this.#withLock(projectId, () => this.#list(projectId));
    }

    async read(
        projectId: string,
        imageId: string,
    ): Promise<{ mime: ImageMime; bytes: Buffer } | null> {
        if (!isId(imageId)) return null;
        const image = (await this.index(projectId)).get(imageId);
        if (!image) return null;
        try {
            return { mime: image.mime, bytes: await readFile(image.path) };
        } catch (error) {
            if (isErrnoException(error, 'ENOENT')) return null;
            throw error;
        }
    }

    async removeSession(projectId: string, sessionId: string): Promise<void> {
        await this.#withLock(projectId, async () => {
            for (const image of (await this.#list(projectId)).values()) {
                if (image.sessionId === sessionId) await rm(image.path, { force: true });
            }
        });
    }

    async removeProject(projectId: string): Promise<void> {
        await this.#withLock(projectId, () =>
            rm(this.#dir(projectId), { recursive: true, force: true }),
        );
    }

    /** Deletes the images no note names, once they are older than `graceMs`. */
    async sweep(
        projectId: string,
        named: ReadonlySet<string>,
        graceMs = ORPHAN_GRACE_MS,
        now = Date.now(),
    ): Promise<number> {
        return this.#withLock(projectId, async () => {
            let removed = 0;
            for (const image of (await this.#list(projectId)).values()) {
                if (named.has(image.imageId) || now - image.modifiedAt < graceMs) continue;
                await rm(image.path, { force: true });
                removed++;
            }
            return removed;
        });
    }
}
