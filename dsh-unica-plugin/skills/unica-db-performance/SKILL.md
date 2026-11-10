---
name: db-performance
description: "Производительность БД и запросов 1С. Используй когда нужно диагностировать slow query, SQL/DBMS trace, индексы, блокировки, deadlock, TEMPDB/WAL, размеры таблиц или СКД на больших данных."
---

# DB Performance

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_view_6f3a42290cc8 {}`, `mcp__unica__unica_search_a8644a757dff`, `mcp__unica__unica_view_6f3a42290cc8` on the object node, `mcp__unica__unica_view_6f3a42290cc8` on the schema node, `mcp__unica__unica_check_6db7d2a7495f`, `mcp__unica__unica_docs_fd15d9ecf894`, and `mcp__unica__unica_run_189d01f64719`.
- Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
используй опубликованную `argsSchema`; при `support.state: limited`
разрешено только подмножество `support.supportedArgs`. Недоступной операции
в словаре нет. Для плановой операции сначала проверь результат
`dryRun: true`, затем исполняй запрос с `dryRun: false`. Preview
не фиксирует входы между вызовами. Не обходи контракт прямым runner-ом.
- Use `mcp__unica__unica_view_6f3a42290cc8` on the role node when performance behavior depends on rights filters, RLS, or tenant boundaries.
- Do not call internal analyzer, runtime, standards, or package adapters directly. They are hidden behind MCP `unica`.

## References

- Read `../../references/platform/db-performance.md` for DB-aware workflow, indexes, virtual tables, locks, and DBMS evidence.
- Read `../../references/platform/runtime-diagnostics.md` when performance evidence comes from ЖР/ТЖ, process ids, sessions, or runtime timeline.
- Read `../../references/platform/transactions-locks.md` once evidence points at contention; this skill keeps the evidence side, that document owns the lock and transaction rules.

## Workflow

1. Name the slow scenario first: user action, API call, report, background job, exchange step, or posting.
2. Extract exact query/DCS text with `mcp__unica__unica_search_a8644a757dff` or `mcp__unica__unica_view_6f3a42290cc8` on the schema node; inspect large candidate modules with `mcp__unica__unica_view_6f3a42290cc8` on the module node (its `Method` branch lists the methods) before reading full bodies.
3. Find callers with `mcp__unica__unica_view_6f3a42290cc8` at `<method>.Caller` when the performance issue depends on execution path, query-in-loop risk, or impact of moving logic; `mcp__unica__unica_search_a8644a757dff` by the method name adds literal mentions.
4. Inspect `mcp__unica__unica_view_6f3a42290cc8` on the object node for both the local object structure and related modules, roles, subscriptions, functional options, or predefined items that can change the performance path.
5. Gather evidence: row counts, generated SQL, query plan, managed locks, lock order, lock/deadlock participants, long transaction boundaries, temp storage, TEMPDB or WAL pressure, and table/index names.
6. Separate causes: inefficient platform query, missing or harmful index, broad virtual table read, query-in-loop, lock contention, DBMS maintenance, or data growth.
7. Propose one measurable change at a time; check syntax with `mcp__unica__unica_check_6db7d2a7495f` (test runs are outside the v0.13 surface), and require separate runtime plus timing/DBMS evidence before calling the change verified.

## Stop rules

- Do not recommend indexes without a concrete predicate, join, sort, grouping, and write-cost tradeoff.
- Do not remove rights filters, tenant filters, or `РАЗРЕШЕННЫЕ` for performance without a named security decision.
- Do not claim a DBMS root cause without DBMS evidence. State missing evidence or Unica MCP contract gap.

## Output

- Scenario and evidence summary.
- Root cause ranked by likelihood.
- Minimal query/metadata/code change.
- Verification command or measurement.
- Residual risk for data volume, locks, or DBMS-specific behavior.
