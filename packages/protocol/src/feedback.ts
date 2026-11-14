import { z } from 'zod';

/**
 * Feedback sent from the site and the app to the relay (`POST /feedback`, JSON), which keeps it
 * for the maintainers. The email is required: it is the only way to answer.
 */

export const FEEDBACK_PATH = '/feedback';
export const FEEDBACK_TYPES = ['bug', 'feature', 'other'] as const;
export const FEEDBACK_MESSAGE_MAX = 4000;
/** Whole request body, JSON included. */
export const FEEDBACK_BODY_MAX_BYTES = 16 * 1024;

export const feedbackTypeSchema = z.enum(FEEDBACK_TYPES);

export const feedbackSchema = z.object({
    type: feedbackTypeSchema,
    message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX),
    email: z.email().max(254),
    /** Path of the page it was sent from, e.g. `/` or `/app/`. */
    page: z.string().max(200),
    /** Hidden field left empty by people: anything in it marks the request as spam. */
    website: z.string().max(200).optional(),
});

export type FeedbackType = z.infer<typeof feedbackTypeSchema>;
export type FeedbackInput = z.input<typeof feedbackSchema>;

/** One stored feedback (a line of `feedback.jsonl` on the relay). */
export const feedbackEntrySchema = z.object({
    id: z.string(),
    at: z.string(),
    type: feedbackTypeSchema,
    message: z.string(),
    email: z.string(),
    page: z.string(),
});

export type FeedbackEntry = z.infer<typeof feedbackEntrySchema>;
