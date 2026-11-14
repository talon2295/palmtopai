/// <reference path="./text-modules.d.ts" />
import guide from './guide.md' with { type: 'text' };

/**
 * Instructions for AI agents using `palmtop`, independent of the agent: printed by
 * `palmtop guide` and used as the body of the skills of Claude Code and Codex.
 */
export const AGENT_GUIDE: string = guide;

/** The tools of `palmtop mcp` that the guide must document (the CLI checks the list is the same). */
export const GUIDE_TOOLS = [
    'session_start',
    'session_list',
    'session_use',
    'session_title',
    'checklist_create',
    'checklist_rename',
    'checklist_remove',
    'item_add',
    'item_edit',
    'item_remove',
    'choice_create',
    'message_set',
    'show',
    'feedback',
    'people_list',
    'share',
    'share_list',
    'retest',
] as const;

/** Every agent-facing command the guide must document, for agents without the tools. */
export const GUIDE_COMMANDS = [
    'palmtop guide',
    'palmtop session start',
    'palmtop session list',
    'palmtop checklist create',
    'palmtop checklist rename',
    'palmtop checklist remove',
    'palmtop choice create',
    'palmtop add',
    'palmtop edit',
    'palmtop remove',
    'palmtop show',
    'palmtop feedback',
    'palmtop wait',
    'palmtop message',
    'palmtop people',
    'palmtop share',
    'palmtop retest',
] as const;
