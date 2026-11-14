import { Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface MenuAction {
    label: string;
    onSelect: () => void;
    destructive?: boolean;
    /** Something new to look at (a new version of the app): a yellow dot, also on the ⋯. */
    attention?: boolean;
}

/**
 * A ⋯ button opening a small list of actions; closes on Escape or a tap outside. Not modal: the
 * page stays usable while it is open, as a tap outside only closes it.
 */
export function Menu({
    label,
    actions,
    buttonClassName = 'border border-zinc-300 dark:border-zinc-700',
}: {
    label: string;
    actions: MenuAction[];
    buttonClassName?: string;
}) {
    const attention = actions.some((action) => action.attention);
    return (
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={label}
                    className={cn(
                        'relative shrink-0 text-zinc-700 dark:text-zinc-300',
                        buttonClassName,
                    )}
                >
                    <Ellipsis className="size-5" />
                    {attention && (
                        <span
                            data-testid="menu-attention"
                            aria-hidden="true"
                            className="absolute top-1 right-1 size-2 rounded-full bg-amber-400 ring-2 ring-white dark:ring-zinc-950"
                        />
                    )}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44 rounded-lg">
                {actions.map((action) => (
                    <DropdownMenuItem
                        key={action.label}
                        variant={action.destructive ? 'destructive' : 'default'}
                        onSelect={action.onSelect}
                        className="whitespace-nowrap"
                    >
                        {action.attention && (
                            <span
                                aria-hidden="true"
                                className="size-2 shrink-0 rounded-full bg-amber-400"
                            />
                        )}
                        {action.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
