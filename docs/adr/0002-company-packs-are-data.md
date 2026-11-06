# 2. A company pack is data; tools and system interfaces live in core

**Status:** accepted, 2026-11-06 (ticket #5).

Tala's tools (`verify_identity`, `check_area_outage`, `end_call`, and the
fourteen to come) and the interfaces to the business systems they call
(`CustomerAccounts`, `NetworkOperations`, …) live in `@tala/core`. A company
pack such as `@tala/kidlat-fiber` holds data (its SOP, policy, persona,
company details and seed world) plus a few lines that read those files.
Core's `loadPack` checks all of it at boot. No pack code runs during a call.

The alternative was each pack shipping its own tools, which would let a
company bend a tool to its quirks. It was rejected because the spec's
portability claim (user story 48: "move Tala onto my own systems by writing
adapters and a company pack, so that her core doesn't change") only holds if
the code that enforces policy is shared. The account gate, the verification
lock and, later, the credit limits are enforced in tool handlers; if a pack
could replace a handler, it could replace the guarantee. A real ISP instead
writes adapters for the system interfaces, where Kidlat's demo uses the
in-memory world built from its seed.

**Consequences:** the policy schema and the SOP placeholders it renders are
core's too, so every pack states its limits in the same vocabulary. Anything a
company needs that the shared tools cannot express is a change to core, made
deliberately and tested once for every pack.
