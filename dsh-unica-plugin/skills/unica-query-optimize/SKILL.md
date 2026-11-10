---
name: query-optimize
description: "Оптимизация запросов 1С и СКД. Используй когда нужно написать, проверить или ускорить запрос, СКД query, временные таблицы, виртуальные таблицы, отборы, соединения или проблемный SQL/DBMS trace."
---

# Query Optimize

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_search_a8644a757dff`, `mcp__unica__unica_view_6f3a42290cc8`, `mcp__unica__unica_check_6db7d2a7495f`, `mcp__unica__unica_view_6f3a42290cc8` on the schema node, `mcp__unica__unica_view_6f3a42290cc8` on the object node, `mcp__unica__unica_docs_fd15d9ecf894`, and `mcp__unica__unica_run_189d01f64719`.
- Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
используй опубликованную `argsSchema`; при `support.state: limited`
разрешено только подмножество `support.supportedArgs`. Недоступной операции
в словаре нет. Для плановой операции сначала проверь результат
`dryRun: true`, затем исполняй запрос с `dryRun: false`. Preview
не фиксирует входы между вызовами. Не обходи контракт прямым runner-ом.
- Use `mcp__unica__unica_view_6f3a42290cc8 {}` if the source-set or format is unclear.
- Do not call internal analyzer, standards, runtime, or package adapters directly. They are hidden behind MCP `unica`.

## Workflow

1. Extract the exact query text with `mcp__unica__unica_search_a8644a757dff` or `mcp__unica__unica_view_6f3a42290cc8` on the schema node.
2. Inspect the execution context with `mcp__unica__unica_view_6f3a42290cc8` on the module node (its `Method` branch lists the methods): module, exported entry point, region, temporary table chain, and caller loop.
3. Find callers with `mcp__unica__unica_view_6f3a42290cc8` at `<method>.Caller` when the query is inside reusable API, background jobs, event handlers, or suspected query-in-loop flow; `mcp__unica__unica_search_a8644a757dff` by the method name adds literal mentions.
4. Run `mcp__unica__unica_check_6db7d2a7495f {at}` on the containing module when analyzer diagnostics can reveal unreachable code, unresolved calls, or type issues around the query. Do not pass a DCS `TemplatePath` as a diagnostic target; locate the BSL module that executes the query.
5. Inspect `mcp__unica__unica_view_6f3a42290cc8` on the object node for both related modules, subscriptions, roles, functional options and the local registers, dimensions, resources, реквизиты, tabular sections, and indexes implied by the platform object type.
6. Inspect DCS with `mcp__unica__unica_view_6f3a42290cc8` on the schema node when the query lives in a data composition schema.
7. Search `mcp__unica__unica_docs_fd15d9ecf894` with `source: "development-standard"` only for `development-standard` query rules. Exact platform query semantics require `mcp__unica__unica_docs_fd15d9ecf894` with `source: "platform-help"` before a platform-dependent rewrite.
8. Read `../../references/platform/db-performance.md` when performance depends on DBMS behavior, locks, indexes, temp storage, WAL, TEMPDB, or large table statistics.
9. Optimize one cause at a time: filters before joins, virtual table parameters, temporary table materialization, repeated queries in loops, dot dereference expansion, unbounded selections, and unnecessary totals.
10. Check syntax with `mcp__unica__unica_check_6db7d2a7495f`; require real trace/log evidence when performance depends on data volume.

## DB-aware diagnostics

- Keep platform query text, generated SQL/DBMS evidence, table sizes, index usage, locks, deadlocks, and transaction boundaries together.
- Treat PostgreSQL, MS SQL Server, and file mode as different evidence models. Do not generalize a СУБД-specific conclusion without naming it.
- Do not recommend a new index without tying it to a predicate, join, sort, grouping, and write-cost tradeoff.
- For virtual tables, prefer precise parameters over broad reads followed by post-filtering.
- For блокировки, connect lock holder, waiter, transaction, module path, and user/API scenario before proposing a rewrite.

## Query syntax guards

- Do not generate `ПЕРВЫЕ &Количество` or any parameter immediately after `ПЕРВЫЕ`: the 1C query parser expects a numeric constant there and reports `Ожидается константа`.
- For a dynamic row limit, use a controlled query template containing `ВЫБРАТЬ ПЕРВЫЕ 1` with LF immediately after `1`, without trailing spaces. In this template, the only occurrence of `"ПЕРВЫЕ 1" + Символы.ПС` must be the row-limit clause itself, not a comment or string literal. The example below checks the occurrence count; it does not parse arbitrary query text. The LF delimiter prevents matching the prefix of `ПЕРВЫЕ 10`; a different line ending or trailing spaces cause the check to refuse the template.
- Before substitution, require `Количество` to be a positive integer of type `Число` (Number). Reject nonnumeric, fractional, zero and negative values without implicit conversion or rounding. `Формат(Количество, "ЧГ=0")` removes digit grouping; it does not enforce these preconditions. For the controlled template above, check the value and substitute the limit before execution:

```bsl
Если ТипЗнч(Количество) <> Тип("Число") Тогда
	ВызватьИсключение "Количество должно иметь тип Число";
КонецЕсли;

Если Количество <= 0 Или Цел(Количество) <> Количество Тогда
	ВызватьИсключение "Количество должно быть положительным целым числом";
КонецЕсли;

МаркерОграничения = "ПЕРВЫЕ 1" + Символы.ПС;

Если СтрЧислоВхождений(Запрос.Текст, МаркерОграничения) <> 1 Тогда
	ВызватьИсключение "В тексте запроса ожидается один маркер ограничения";
КонецЕсли;

Запрос.Текст = СтрЗаменить(
	Запрос.Текст,
	МаркерОграничения,
	"ПЕРВЫЕ " + Формат(Количество, "ЧГ=0") + Символы.ПС);
```

## Review checklist

- Virtual tables receive parameters instead of broad post-filtering.
- Temporary tables have the minimal fields needed by later stages.
- Repeated subqueries and query-in-loop patterns are removed or justified.
- Joins do not multiply rows silently; totals and grouping match business meaning.
- Date and organization filters are applied as early as the platform query allows.
- `ПЕРВЫЕ` uses a numeric constant in the query text, not a query parameter.
- Query changes preserve rights semantics and do not replace `РАЗРЕШЕННЫЕ` blindly.

## MCP examples

```jsonc
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_view_6f3a42290cc8",
    "arguments": {
      "at": "main:Report.Продажи.Template.ОсновнаяСхемаКомпоновкиДанных.DataSet"
    }
  }
}
```

```jsonc
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_docs_fd15d9ecf894",
    "arguments": {
      "query": "оптимизация запросов 1С виртуальные таблицы",
      "source": "development-standard"
    }
  }
}
```
