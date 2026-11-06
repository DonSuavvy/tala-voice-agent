// @tala/evals: OpsPilot's deterministic eval machinery (the expectation
// schema, the scorer, run pinning and the regression diff), imported at
// 83b5414 and moved from one loop result to a whole call (#9): the case
// schema and its loader, the simulated caller that plays a case against Tala,
// and the adapter from a call's events to what the scorer reads. The advisory
// grader is #9 too.
export * from "./case";
export * from "./diff";
export * from "./load-cases";
export * from "./observe";
export * from "./pin";
export * from "./score";
export * from "./simulated-caller";
export * from "./types";
