// @tala/core: the framework-free brain.
//
// OpsPilot's engine (github.com/DonSuavvy/opspilot at 83b5414), made
// company-agnostic: the agent loop and its MessageCreator seam, the tool
// registry, the SOP compiler, the spend guard, cost accounting with rate
// cards, spans, the injection pre-scan and its guardrail.
//
// On top of it, Tala (#5): the call session, which is the main seam; the
// tools and the business-system interfaces they call; the support policy;
// the company-pack loader; and the in-memory world a pack's seed becomes.
// Streaming and interruption (#6): the creator streams Tala's words and stops
// on an abort, the loop ends an interrupted turn cleanly, and the call
// session emits speech deltas and keeps only what the caller heard. No
// LiveKit, Next.js or database imports, ever.
export * from "./call/disposition";
export * from "./call/pin";
export * from "./call/session";
export * from "./pack/load-pack";
export * from "./policy/identity";
export * from "./policy/masking";
export * from "./policy/support-policy";
export * from "./systems/in-memory";
export * from "./systems/seed-world";
export * from "./systems/types";
export * from "./tools";
export * from "./agent/budget";
export * from "./agent/cache";
export * from "./agent/cost";
export * from "./agent/guardrails";
export * from "./agent/injection";
export * from "./agent/loop";
export * from "./agent/provider";
export * from "./agent/registry";
export * from "./agent/sop";
export * from "./agent/sop-draft";
export * from "./agent/streaming";
export * from "./agent/trace";
