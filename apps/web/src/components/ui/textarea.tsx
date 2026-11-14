import type * as React from 'react';
import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
    return (
        <textarea
            data-slot="textarea"
            className={cn(
                'block w-full resize-y rounded-lg border border-input bg-white px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-900',
                className,
            )}
            {...props}
        />
    );
}

export { Textarea };
