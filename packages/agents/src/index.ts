/**
 * @eutectic/agents — the agent-side logic that is NOT a model call.
 *
 * `packages/inference` owns providers and produces raw model text. This
 * package owns what happens to that text before anything is written: as of
 * P-05-BE, the structured-output validator that turns a turn into either a
 * validated `AgentTurnOutput` or a precise, machine-usable rejection
 * (D-031, D-039, DIRECTIVE-pre-M1 §6).
 *
 * Nothing here touches a database or a network. The M1 turn worker consumes
 * `ValidationResult`, drives rule 7's retry ≤3 → decline path, and persists
 * `self_check` into migration 0013's columns.
 *
 * Explicit named exports only — no barrel re-export (CLAUDE.md §4).
 */

export {
  BANNED_PHRASES,
  findBannedPhrase,
  normalisePhrase,
  type BannedPhrase,
  type BannedPhraseMatch,
} from "./turn-output/banned-phrases.js";

export {
  AGENT_TURN_ACTIONS,
  AGENT_TURN_CALL_KEYS,
  AGENT_TURN_OUTPUT_KEYS,
  AGENT_TURN_REF_KEYS,
  AGENT_TURN_SELF_CHECK_KEYS,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  HORIZON_DAYS_MIN,
  UUID_PATTERN,
  type AgentTurnCall,
  type AgentTurnOutput,
  type AgentTurnRef,
  type AgentTurnSelfCheck,
} from "./turn-output/schema.js";

export {
  REJECTION_REASONS,
  isMechanicalRejection,
  validateTurnOutput,
  validateTurnOutputValue,
  type RejectionKind,
  type RejectionReason,
  type ValidationAccepted,
  type ValidationRejected,
  type ValidationResult,
} from "./turn-output/validate.js";
