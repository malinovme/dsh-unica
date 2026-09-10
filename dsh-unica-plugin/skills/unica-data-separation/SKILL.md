---
name: data-separation
description: "Разделение данных 1С. Используй когда нужно проверить tenant-boundaries, разделители, безопасные запросы, RLS/права, фоновые задания, обмены или интеграции в разделенной базе."
---

# Data Separation

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_project_map_7cc63b822c1d`, `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_meta_info_524a81764d16`, `mcp__unica__unica_role_info_7face3da6726`, `mcp__unica__unica_code_diagnostics_43785e27e86c`, `mcp__unica__unica_standards_search_cab77e9c1bda`, `mcp__unica__unica_standards_explain_79d0ab30ea9c`, and `mcp__unica__unica_runtime_execute_0cd62fbc3716`.
- По INV-MCP-RUNTIME-RECEIPT и ADR-0074: `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: true`
показывает запланированную команду без побочных эффектов, а с `dryRun: false`
исполняет классифицированную операцию и отвечает её терминальным результатом в
том же вызове, приложив названную причину риска (`runtime_risk_*`)
предупреждением; неклассифицированная операция по-прежнему отказывает
`runtime_operation_unbounded` до обнаружения рабочего пространства. Preview
исполнением не является. Работу, которую вызов ждать не должен, запускай через
`mcp__unica__unica_runtime_job_start_64e0bb584ac4`. Не обходи контракт прямым runner-ом или через
`unica.build.*`.
- Use `mcp__unica__unica_dcs_info_e9d039200abc` when reports/DCS queries may bypass tenant filters.
- Do not call internal metadata, analyzer, standards, runtime, or package adapters directly. They are hidden behind MCP `unica`.

## References

- Read `../../references/platform/platform-mechanics.md` for tenant-boundaries, rights, temporary storage, background jobs, and exchange behavior.
- Read `../../references/platform/db-performance.md` when separated data changes query plans, indexes, locks, or virtual table filters.
- Read `../../references/platform/runtime-diagnostics.md` when the issue appears only in ЖР/ТЖ or runtime traces.

## Workflow

1. Identify separation model: separator values, tenant ownership, user/session context, rights/RLS, privileged code, and external ids.
2. Inspect metadata and roles with `mcp__unica__unica_meta_info_524a81764d16` and `mcp__unica__unica_role_info_7face3da6726`; find risky code with `mcp__unica__unica_code_search_70af4c0986a7`.
3. Trace tenant value through reads, writes, reports, background jobs, exchange messages, file batches, temp storage, and integration calls.
4. Review queries for missing tenant filters, unsafe privileged mode, broad virtual tables, and joins that cross boundaries.
5. Use `mcp__unica__unica_runtime_execute_0cd62fbc3716` to preview typed syntax/test arguments and, with `dryRun: false`, to run them; record runtime verification as unavailable and require separate evidence covering at least two tenant contexts.

## Red flags

- Code writes objects without setting separator attributes.
- Background job runs under a broad user context and processes all tenants.
- Exchange or integration payload omits tenant/external owner id.
- Report/DCS query uses privileged access without a documented reason.
- Temporary storage or files are shared across tenant/session boundaries.

## Contract gaps

If public MCP `unica` cannot expose separation metadata, role details, or runtime context required for the task, report a Unica MCP contract gap.
