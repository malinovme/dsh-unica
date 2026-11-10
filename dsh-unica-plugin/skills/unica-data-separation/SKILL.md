---
name: data-separation
description: "Разделение данных 1С. Используй когда нужно проверить tenant-boundaries, разделители, безопасные запросы, RLS/права, фоновые задания, обмены или интеграции в разделенной базе."
---

# Data Separation

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_view_6f3a42290cc8 {}`, `mcp__unica__unica_search_a8644a757dff`, `mcp__unica__unica_view_6f3a42290cc8` on the object node, `mcp__unica__unica_view_6f3a42290cc8` on the role node, `mcp__unica__unica_check_6db7d2a7495f`, `mcp__unica__unica_docs_fd15d9ecf894`, and `mcp__unica__unica_run_189d01f64719`.
- Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
используй опубликованную `argsSchema`; при `support.state: limited`
разрешено только подмножество `support.supportedArgs`. Недоступной операции
в словаре нет. Для плановой операции сначала проверь результат
`dryRun: true`, затем исполняй запрос с `dryRun: false`. Preview
не фиксирует входы между вызовами. Не обходи контракт прямым runner-ом.
- Use `mcp__unica__unica_view_6f3a42290cc8` on the schema node when reports/DCS queries may bypass tenant filters.
- Do not call internal metadata, analyzer, standards, runtime, or package adapters directly. They are hidden behind MCP `unica`.

## References

- Read `../../references/platform/platform-mechanics.md` for tenant-boundaries, rights, temporary storage, background jobs, and exchange behavior.
- Read `../../references/platform/db-performance.md` when separated data changes query plans, indexes, locks, or virtual table filters.
- Read `../../references/platform/runtime-diagnostics.md` when the issue appears only in ЖР/ТЖ or runtime traces.

## Workflow

1. Identify separation model: separator values, tenant ownership, user/session context, rights/RLS, privileged code, and external ids.
2. Inspect metadata and roles with `mcp__unica__unica_view_6f3a42290cc8` on the object node and `mcp__unica__unica_view_6f3a42290cc8` on the role node; find risky code with `mcp__unica__unica_search_a8644a757dff`.
3. Trace tenant value through reads, writes, reports, background jobs, exchange messages, file batches, temp storage, and integration calls.
4. Review queries for missing tenant filters, unsafe privileged mode, broad virtual tables, and joins that cross boundaries.
5. Check syntax with `mcp__unica__unica_check_6db7d2a7495f` (test runs are outside the v0.13 surface); record runtime verification as unavailable and require separate evidence covering at least two tenant contexts.

## Red flags

- Code writes objects without setting separator attributes.
- Background job runs under a broad user context and processes all tenants.
- Exchange or integration payload omits tenant/external owner id.
- Report/DCS query uses privileged access without a documented reason.
- Temporary storage or files are shared across tenant/session boundaries.

## Contract gaps

If public MCP `unica` cannot expose separation metadata, role details, or runtime context required for the task, report a Unica MCP contract gap.
