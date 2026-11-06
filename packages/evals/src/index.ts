// @tala/evals: OpsPilot's deterministic eval machinery (the expectation
// schema, the scorer, run pinning and the regression diff), imported at
// 83b5414 and moved from one loop result to a whole call (#9): the case
// schema and its loader, the simulated caller that plays a case against Tala,
// the adapter from a call's events to what the scorer reads, the advisory
// grader shown beside the gate, and the pinned report and what prints it.
export * from "./case";
export * from "./diff";
export * from "./format";
export * from "./grader";
export * from "./load-cases";
export * from "./observe";
export * from "./pin";
export * from "./report";
export * from "./score";
export * from "./simulated-caller";
export * from "./transcript";
export * from "./types";
