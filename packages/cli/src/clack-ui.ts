import * as clack from '@clack/prompts';
import { type ColorDepth, green } from './banner';
import type { SetupUi } from './setup';

/** `palmtop setup` on a real terminal, drawn by @clack/prompts. */
export function clackUi(depth: ColorDepth): SetupUi {
    const answer = <T>(value: T | symbol): T | null =>
        clack.isCancel(value) ? null : (value as T);
    return {
        intro: (title) => clack.intro(title),
        step: (message) => clack.log.step(message),
        success: (message) => clack.log.success(message),
        info: (message) => clack.log.info(message),
        warn: (message) => clack.log.warn(message),
        confirm: async (message, initial) =>
            answer<boolean>(await clack.confirm({ message, initialValue: initial })),
        multiselect: async <V extends string>(
            message: string,
            options: { value: V; label: string; hint?: string; disabled?: boolean }[],
            initial: V[],
        ) =>
            answer<V[]>(
                await clack.multiselect<V>({
                    message,
                    // Clack's option type is conditional on V; the fields are the same.
                    options: options as clack.Option<V>[],
                    initialValues: initial,
                    required: false,
                }),
            ),
        spinner: () => {
            // palmtop green instead of clack's magenta, which reads as red in many themes.
            const spin = clack.spinner({ styleFrame: (frame) => green(frame, depth) });
            return {
                start: (message) => spin.start(message),
                stop: (message) => spin.stop(message),
            };
        },
        outro: (message) => clack.outro(message),
        cancel: (message) => clack.cancel(message),
    };
}
