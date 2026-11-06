// @tala/core: the framework-free brain.
//
// OpsPilot's engine (github.com/DonSuavvy/opspilot at 83b5414), made
// company-agnostic: the agent loop and its MessageCreator seam, the tool
// registry, the SOP compiler, the spend guard, cost accounting with rate
// cards, spans, the injection pre-scan and its guardrail. Voice extensions
// arrive in #6. No LiveKit, Next.js or database imports, ever.
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
