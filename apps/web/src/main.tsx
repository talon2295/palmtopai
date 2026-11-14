import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getDeviceId } from './lib/device';
import { captureInstallPrompt } from './lib/install';
import { consumeJoinLink } from './lib/join';
import { enableOffline } from './lib/offline';
import {
    loadPairings,
    pairingOfProject,
    saveActiveComputer,
    saveActiveProject,
} from './lib/pairings';
import { consumeOpenLink } from './lib/push';
import { enableSecureContextFeatures } from './lib/secure-context';
import './index.css';

// Before rendering: move a pairing key out of the URL as early as possible.
const join = consumeJoinLink(window.location, window.history);
// A tapped notification opens the app on its project.
const opened = consumeOpenLink(window.location, window.history);
if (opened) {
    saveActiveProject(opened);
    const owner = pairingOfProject(loadPairings(), opened);
    if (owner) saveActiveComputer(owner.computerId);
}
enableSecureContextFeatures(window);
// Chrome offers its install prompt once, early: keep it for the "Install" button.
captureInstallPrompt(window);
// Not during development: the dev server is not the app the worker would keep.
if (import.meta.env.PROD) void enableOffline(window, { paired: loadPairings().length > 0 });

const root = document.getElementById('root');
if (root) {
    createRoot(root).render(
        <StrictMode>
            <App deviceId={getDeviceId()} join={join} />
        </StrictMode>,
    );
}
