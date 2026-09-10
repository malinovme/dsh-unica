---
name: query-optimize
description: "Оптимизация запросов 1С и СКД. Используй когда нужно написать, проверить или ускорить запрос, СКД query, временные таблицы, виртуальные таблицы, отборы, соединения или проблемный SQL/DBMS trace."
---

# Query Optimize

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_code_outline_dc58fe5ade0e`, `mcp__unica__unica_code_graph_c09c4e5a3a83`, `mcp__unica__unica_code_diagnostics_43785e27e86c`, `mcp__unica__unica_dcs_info_e9d039200abc`, `mcp__unica__unica_meta_info_524a81764d16`, `mcp__unica__unica_standards_search_cab77e9c1bda`, `mcp__unica__unica_standards_explain_79d0ab30ea9c`, and `mcp__unica__unica_runtime_execute_0cd62fbc3716`.
- По INV-MCP-RUNTIME-RECEIPT и ADR-0074: `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: true`
показывает запланированную команду без побочных эффектов, а с `dryRun: false`
исполняет классифицированную операцию и отвечает её терминальным результатом в
том же вызове, приложив названную причину риска (`runtime_risk_*`)
предупреждением; неклассифицированная операция по-прежнему отказывает
`runtime_operation_unbounded` до обнаружения рабочего пространства. Preview
исполнением не является. Работу, которую вызов ждать не должен, запускай через
`mcp__unica__unica_runtime_job_start_64e0bb584ac4`. Не обходи контракт прямым runner-ом или через
`unica.build.*`.
- Use `mcp__unica__unica_project_map_7cc63b822c1d` if the source-set or format is unclear.
- Do not call internal analyzer, standards, runtime, or package adapters directly. They are hidden behind MCP `unica`.

## Workflow

1. Extract the exact query text with `mcp__unica__unica_code_search_70af4c0986a7` or `mcp__unica__unica_dcs_info_e9d039200abc`.
2. Inspect the execution context with `mcp__unica__unica_code_outline_dc58fe5ade0e`: module, exported entry point, region, temporary table chain, and caller loop.
3. Use `mcp__unica__unica_code_graph_c09c4e5a3a83` for callers/callees when the query is inside reusable API, background jobs, event handlers, or suspected query-in-loop flow.
4. Run `mcp__unica__unica_code_diagnostics_43785e27e86c` with `action=findings`, the exact `sourceSet`, and the containing module's logical `metadataPath` when analyzer diagnostics can reveal unreachable code, unresolved calls, or type issues around the query. Do not pass a DCS `TemplatePath` as a diagnostic target; locate the BSL module that executes the query.
5. Inspect `mcp__unica__unica_meta_info_524a81764d16` for both related modules, subscriptions, roles, functional options and the local registers, dimensions, resources, реквизиты, tabular sections, and indexes implied by the platform object type.
6. Inspect DCS with `mcp__unica__unica_dcs_info_e9d039200abc` when the query lives in a data composition schema.
7. Search `mcp__unica__unica_standards_search_cab77e9c1bda` only for `development-standard` query rules. Exact platform query semantics require a `platform-help` source; if public MCP `unica` does not expose one, report the contract gap before making a platform-dependent rewrite.
8. Read `../../references/platform/db-performance.md` when performance depends on DBMS behavior, locks, indexes, temp storage, WAL, TEMPDB, or large table statistics.
9. Optimize one cause at a time: filters before joins, virtual table parameters, temporary table materialization, repeated queries in loops, dot dereference expansion, unbounded selections, and unnecessary totals.
10. Use `mcp__unica__unica_runtime_execute_0cd62fbc3716` only to preview typed syntax arguments; report actual syntax as unverified and require real trace/log evidence when performance depends on data volume.

## DB-aware diagnostics

- Keep platform query text, generated SQL/DBMS evidence, table sizes, index usage, locks, deadlocks, and transaction boundaries together.
- Treat PostgreSQL, MS SQL Server, and file mode as different evidence models. Do not generalize a СУБД-specific conclusion without naming it.
- Do not recommend a new index without tying it to a predicate, join, sort, grouping, and write-cost tradeoff.
- For virtual tables, prefer precise parameters over broad reads followed by post-filtering.
- For блокировки, connect lock holder, waiter, transaction, module path, and user/API scenario before proposing a rewrite.

## Review checklist

- Virtual tables receive parameters instead of broad post-filtering.
- Temporary tables have the minimal fields needed by later stages.
- Repeated subqueries and query-in-loop patterns are removed or justified.
- Joins do not multiply rows silently; totals and grouping match business meaning.
- Date and organization filters are applied as early as the platform query allows.
- Query changes preserve rights semantics and do not replace `РАЗРЕШЕННЫЕ` blindly.

## MCP examples

```jsonc
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_dcs_info_e9d039200abc",
    "arguments": {
      "cwd": "<workspace>",
      "TemplatePath": "Reports/Продажи/Ext/Report/DataCompositionSchema.xml"
    }
  }
}
```

```jsonc
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_standards_search_cab77e9c1bda",
    "arguments": {
      "query": "оптимизация запросов 1С виртуальные таблицы",
      "limit": 5
    }
  }
}
```
