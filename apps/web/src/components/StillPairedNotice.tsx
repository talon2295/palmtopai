import { Alert } from '@/components/ui/alert';

/**
 * A computer removed from this device that did not confirm it revoked it (offline, or no answer
 * in time): it still accepts this device's key until it is removed there too.
 */
export function StillPairedNotice({
    computer,
    onDismiss,
}: {
    computer: string;
    onDismiss: () => void;
}) {
    return (
        <Alert role="alert" variant="warning" className="flex items-start gap-3 text-left">
            <p className="flex-1">
                &ldquo;{computer}&rdquo; was not reachable, so it still accepts this device. To
                revoke it, run <code className="font-mono">palmtop devices remove</code> there.
            </p>
            <button type="button" onClick={onDismiss} className="font-medium">
                Dismiss
            </button>
        </Alert>
    );
}
