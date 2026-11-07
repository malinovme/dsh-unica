---
name: log-analysis
description: "Анализ журнала регистрации и технологического журнала 1С. Используй когда нужно разобрать ЖР, ТЖ, исключения, блокировки, SQL/DBMSSQL, deadlock, long call, фоновые задания, HTTP-сервис или связать записи журнала с кодом."
---

# Log Analysis

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_search_a8644a757dff`, `mcp__unica__unica_view_6f3a42290cc8` on the object node, `mcp__unica__unica_view_6f3a42290cc8 {}`, `mcp__unica__unica_check_6db7d2a7495f`, and `mcp__unica__unica_docs_fd15d9ecf894`.
- Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
при `implemented: true` используй опубликованную `argsSchema`; при
`support.state: limited` разрешено только подмножество `support.supportedArgs`.
При `support.state: unavailable` остановись; не выдумывай аргументов при
`argsSchema: null`. Для плановой операции сначала проверь результат `dryRun: true`,
затем исполняй запрос с `dryRun: false`. Preview не фиксирует входы между
вызовами. Не обходи контракт прямым runner-ом.
- Check syntax with `mcp__unica__unica_check_6db7d2a7495f` and launch a client through `mcp__unica__unica_run_189d01f64719` (`launch`); test runs are outside the v0.13 surface, and neither call is verification or a substitute for log evidence.
- Do not call internal runtime, analyzer, standards, or package adapters directly. They are hidden behind MCP `unica`.

## Inputs

Accept explicit journal registration exports, technological log files, copied log fragments, or paths provided by the user. Preserve timestamps, process/session ids, users, infobase, event kind, module/procedure, transaction id, SQL text, and correlation ids.

## References

- Read `../../references/platform/runtime-diagnostics.md` for ЖР/ТЖ timeline, startup, web-client, HTTP, background job, and process/session evidence.
- Read `../../references/platform/db-performance.md` when log fragments contain SQL, locks, deadlocks, waits, long queries, or DBMS-specific artifacts.

## Workflow

1. Classify the evidence: ЖР event, ТЖ event, platform exception, DBMS/SQL, lock/deadlock, long call, background job, HTTP service, web client request, or auth/session problem.
2. Build a timeline. Keep clock source and timezone explicit when several files are involved.
3. Extract module, procedure, metadata object, HTTP path, query text, user/session, and transaction identifiers.
4. Map log entries back to source with `mcp__unica__unica_search_a8644a757dff` and metadata with `mcp__unica__unica_view_6f3a42290cc8` on the object node.
5. Use `mcp__unica__unica_docs_fd15d9ecf894` with `source: "development-standard"` for diagnostic ids and `development-standard` recommendations. The exact meaning of a platform message requires `mcp__unica__unica_docs_fd15d9ecf894` with `source: "platform-help"`.
6. Separate root cause from consequences: the first exception/lock/timeout usually matters more than later rollback noise.
7. For DBMS evidence, preserve lock holder/waiter, SQL text, transaction boundary, process id, session id, wait event, table/index name, and elapsed time together.

## Output

- Root-cause hypothesis with evidence lines.
- Timeline of key events.
- Affected code and metadata paths.
- Recommended fix or next measurement.
- Missing evidence, if the log fragment cannot support a reliable conclusion.

## MCP example

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_search_a8644a757dff",
    "arguments": {
      "query": "ВыполнитьОбменСКонтрагентом",
      "scope": "<source-set-from-unica-view>:Configuration",
      "limit": 20
    }
  }
}
```
