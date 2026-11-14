import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const alertVariants = cva('relative w-full rounded-lg px-3 py-2 text-sm', {
    variants: {
        // The app's notices: tinted, no border.
        variant: {
            default: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
            warning: 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
            destructive: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
        },
    },
    defaultVariants: {
        variant: 'default',
    },
});

/** A notice; pass `role="alert"` for the ones that need attention now. */
function Alert({
    className,
    variant,
    ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
    return (
        <div data-slot="alert" className={cn(alertVariants({ variant }), className)} {...props} />
    );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="alert-title"
            className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)}
            {...props}
        />
    );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="alert-description"
            className={cn(
                'col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed',
                className,
            )}
            {...props}
        />
    );
}

export { Alert, AlertDescription, AlertTitle };
