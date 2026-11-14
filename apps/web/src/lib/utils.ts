import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names, the later Tailwind class winning over a conflicting earlier one. */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
