/** `after`: steps after Next, shown without a stage label. */
export type RoadmapStage = 'released' | 'next' | 'after' | 'later';

export interface RoadmapItem {
    title: string;
    summary: string;
}

/** One step of the timeline: a title with a summary, or a group of items. */
export interface RoadmapStep {
    stage: RoadmapStage;
    /** Versions for released steps, otherwise empty. */
    label: string;
    title?: string;
    summary?: string;
    items?: readonly RoadmapItem[];
}

/** Roadmap on the homepage (`/#roadmap`): no dates, in order. */
export const ROADMAP: readonly RoadmapStep[] = [
    {
        stage: 'released',
        label: '0.1',
        title: 'First preview',
        summary:
            'Checklists from your agent on your devices, live through the relay. Install with one prompt, update with palmtop update.',
    },
    {
        stage: 'released',
        label: '0.2 – 0.5',
        title: 'A fuller app',
        summary:
            'Delete sessions and projects, hide reviewed checks, computer names, checks and notes from your devices, messages from the agent.',
    },
    {
        stage: 'released',
        label: '0.6 – 0.7',
        title: 'Notifications and checks',
        summary:
            'Push notifications when the agent has something for you, and a guide focused on checking its work.',
    },
    {
        stage: 'released',
        label: '0.8 – 0.11',
        title: 'Computers, offline and a new app',
        summary:
            'Pair a computer once for all its projects, checklists that stay on your devices without a network, and a dashboard of your computers.',
    },
    {
        stage: 'released',
        label: '0.12 – 0.13',
        title: 'Codex and a one-line installer',
        summary:
            'A ready-made skill for Codex too, and one command that installs palmtop, sets up your agents and pairs your phone.',
    },
    {
        stage: 'released',
        label: '0.14 – 0.16',
        title: 'Feedback, pairing by code, and questions',
        summary:
            'Send feedback from the site and the app, pair the app on your Home Screen with a code, and answer the questions your agent asks: it sends the options, you choose one and it goes on.',
    },
    {
        stage: 'released',
        label: '0.18',
        title: 'End-to-end encryption',
        summary:
            "Checklists are encrypted between your computer and your devices: the relay forwards data it can't read. Each device has its own key, which can't be copied out of the browser and can be revoked on its own. The app moves to app.palmtop.mtwa.it.",
    },
    {
        stage: 'released',
        label: '0.19',
        title: 'Share with other people',
        summary:
            'Give a client, a colleague or a friend a copy of a checklist to check on their own device. They see only that; you see what each of them answered, and your agent puts the answers together.',
    },
    {
        stage: 'released',
        label: '0.20 – 0.22',
        title: 'Archive, tools for your agent, and Windows',
        summary:
            'Put sessions and projects away in an archive, let your agent use palmtop through tools that keep what it writes exactly as written, and run palmtop on Windows without WSL.',
    },
    {
        stage: 'released',
        label: '0.23',
        title: 'Links, notes and screenshots',
        summary:
            'Open the links in a note or a message, write the note for your agent as a list of elements, and attach screenshots to your notes, also when the computer is off.',
    },
    {
        stage: 'released',
        label: '0.24',
        title: 'Review done',
        summary:
            'Tap Review done when you finished checking, and an agent that can wait for you, like Claude Code, reads your review by itself.',
    },
    {
        stage: 'released',
        label: '0.25',
        title: 'Markdown and copy',
        summary:
            'Checks, questions and messages from your agent show formatted: a bold title, lists, links, and a copy button on every command or string.',
    },
    {
        stage: 'after',
        label: '',
        items: [
            {
                title: 'Approve plans',
                summary:
                    'The agent sends its plan to your devices and waits: read it, approve it or ask for changes before it writes any code.',
            },
            {
                title: 'Diff with comments',
                summary:
                    'The agent puts its changes on your devices: read the diff and comment on files and lines. Your comments come back with the review.',
            },
        ],
    },
    {
        stage: 'later',
        label: '',
        title: 'Accounts and Pro plan',
        summary: 'Accounts and a Pro plan. The free relay stays.',
    },
];

export const STAGE_LABEL: Record<RoadmapStage, string> = {
    released: 'Released',
    next: 'Next',
    after: '',
    later: 'Later',
};
