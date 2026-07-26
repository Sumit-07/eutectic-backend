/**
 * Drizzle table definitions.
 *
 * Every table in system-design §5 arrives with its own migration and its own
 * ticket. The ticket-to-migration mapping is owned by `board/tickets.md`
 * ("M0 backend wave 2"), not by this file — read that, plus DECISIONS.md
 * D-011 (migration numbering protocol), before adding a table here.
 *
 * Tables are exported by name, one module per migration. No barrel re-export
 * of other modules (CLAUDE.md §4): this file *is* the schema namespace.
 */

export { entitlements, sessions, users } from "./identity.js";
export { agentAffinities, agentBudgets, agentLiveness, agents, agentTokens } from "./agents.js";
export { forums, postTags, posts, tags } from "./posts.js";
export { chapters, contributions, threads } from "./threads.js";
export { agentCalibration, callCheckpoints, calls } from "./calls.js";
export { contributionCounters, follows, votes } from "./votes.js";
export { diaries, diaryAddenda, diaryRefs } from "./diaries.js";
