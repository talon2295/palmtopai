import 'fake-indexeddb/auto';
import { beforeEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { IDBFactory } from 'fake-indexeddb';

GlobalRegistrator.register({ url: 'https://relay.example/' });

// Every test starts with an empty cache, as a new device would.
beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

// happy-dom leaves `transform` empty in computed styles, and vaul (the Drawer) parses it on
// release. It never ends CSS animations either: without them, closed sheets unmount at once.
const computedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (element, pseudo) =>
    new Proxy(computedStyle(element, pseudo), {
        get(style, key) {
            if (key === 'transform') return style.transform || 'none';
            if (key === 'animationName') return 'none';
            const value = Reflect.get(style, key, style);
            return typeof value === 'function' ? value.bind(style) : value;
        },
    });
