import type { StoredImage } from '@palmtopai/client';
import { createContext, useContext, useEffect, useState } from 'react';

/**
 * What the components need to attach screenshots to notes and to show them: given by the app,
 * which holds the connection to the computer. Absent in a view that has none (a preview).
 */
export interface ImagesApi {
    /**
     * A screenshot can be attached: the computer takes them (it was seen to) and is connected, or
     * is away, in which case the picture is kept on this device and sent when it is back.
     */
    enabled: boolean;
    /** The computer is connected now. */
    online: boolean;
    /** Why a screenshot cannot be attached, when `enabled` is false. */
    unavailable?: string;
    /** Prepares and sends a picture for the session; resolves with the id to put in the note. */
    send: (file: Blob) => Promise<string>;
    /** A screenshot of a note: from this device or the computer; `null` when there is none. */
    load: (imageId: string) => Promise<StoredImage | null>;
}

const ImagesContext = createContext<ImagesApi | null>(null);

export const ImagesProvider = ImagesContext.Provider;

export function useImages(): ImagesApi | null {
    return useContext(ImagesContext);
}

export type ImageState =
    | { status: 'loading' }
    | { status: 'ready'; url: string }
    | { status: 'missing' };

/** The picture as an address an `img` can show. A `data:` one: the page's policy allows no `blob:`. */
export function imageDataUrl(image: StoredImage): string {
    let text = '';
    for (let start = 0; start < image.bytes.length; start += 0x8000) {
        text += String.fromCharCode(...image.bytes.subarray(start, start + 0x8000));
    }
    return `data:${image.mime};base64,${btoa(text)}`;
}

/** The address of a screenshot to show in an `img`, loaded once for as long as it is shown. */
export function useImageUrl(imageId: string | null): ImageState {
    const images = useImages();
    const load = images?.load;
    // Asked again when the computer becomes reachable: it may have the picture this device lacks.
    const enabled = images?.online ?? false;
    const [state, setState] = useState<ImageState>({ status: 'loading' });

    // biome-ignore lint/correctness/useExhaustiveDependencies: `enabled` only triggers a new try
    useEffect(() => {
        if (!imageId || !load) {
            setState({ status: 'missing' });
            return;
        }
        setState((current) => (current.status === 'loading' ? current : { status: 'loading' }));
        let live = true;
        load(imageId)
            .then((image) => {
                if (!live) return;
                setState(
                    image ? { status: 'ready', url: imageDataUrl(image) } : { status: 'missing' },
                );
            })
            .catch(() => live && setState({ status: 'missing' }));
        return () => {
            live = false;
        };
    }, [imageId, load, enabled]);

    return state;
}
