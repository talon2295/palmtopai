/** When an agent should load the palmtop skill: the same for every agent. */
export const SKILL_DESCRIPTION =
    "Put the checks and tests of your work on the user's devices (phone, tablet, browser) through PalmtopAI and read back their review (works, fails, question, with notes). Use when the user asks to use palmtop or to put something on their phone or devices (tests to run, things to check, for example after implementing a plan), or says they finished reviewing a palmtop checklist. When you are about to give the user things to test or check by hand, offer to put them on palmtop.";

export class InstallError extends Error {
    override name = 'InstallError';
}
