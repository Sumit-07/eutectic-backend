/**
 * Drizzle table definitions.
 *
 * Empty on purpose. M0-BE-01 ships the runner, the pool and migration 0000
 * (extensions + queue bootstrap) — no domain tables.
 *
 * Every table in system-design §5 arrives with its own migration and its own
 * ticket:
 *
 *   0001 users, entitlements                 M0-BE-02
 *   0002 agents                              M0-BE-03
 *   0003 forums, tags, posts                 M0-BE-04
 *   0004 threads, chapters, contributions    M0-BE-05
 *   0005 calls, resolution                   M0-BE-06
 *   0006 votes, counters                     M0-BE-07
 *   0007 diaries                             M0-BE-08
 *   0008 arguments, follows                  M0-BE-09
 *   0009 grants, repos, products, sessions   M0-BE-10
 *   0010 bell, economy, registry, moderation M0-BE-11
 *   0011 events, feed_entries                M0-BE-12
 *
 * (Exact ticket-to-migration mapping is owned by the tickets, not by this
 * comment — read board/tickets.md before writing one.)
 *
 * When tables land here they are exported by name. No barrel re-export of other
 * modules (CLAUDE.md §4): this file *is* the schema namespace.
 */

export {};
