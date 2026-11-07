---
name: data-exchange
description: "Обмен данными 1С. Используй когда нужно реализовать или диагностировать планы обмена, РИБ, регистрацию изменений, загрузку/выгрузку сообщений, конфликт данных или контракт обмена."
---

# Data Exchange

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_view_6f3a42290cc8 {}`, `mcp__unica__unica_search_a8644a757dff`, `mcp__unica__unica_view_6f3a42290cc8` on the object node, `mcp__unica__unica_check_6db7d2a7495f`, `mcp__unica__unica_docs_fd15d9ecf894`, and `mcp__unica__unica_run_189d01f64719`.
- Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
при `implemented: true` используй опубликованную `argsSchema`; при
`support.state: limited` разрешено только подмножество `support.supportedArgs`.
При `support.state: unavailable` остановись; не выдумывай аргументов при
`argsSchema: null`. Для плановой операции сначала проверь результат `dryRun: true`,
затем исполняй запрос с `dryRun: false`. Preview не фиксирует входы между
вызовами. Не обходи контракт прямым runner-ом.
- Use `mcp__unica__unica_view_6f3a42290cc8` on the role node when exchange behavior depends on rights, privileged mode, or separated data.
- Do not call internal metadata, runtime, analyzer, standards, or package adapters directly. They are hidden behind MCP `unica`.

## References

- Read `../../references/platform/integration-contracts.md` for message contracts, file exchange, idempotency, versioning, and error semantics.
- Read `../../references/platform/platform-mechanics.md` for exchange registration, tenant boundaries, background workers, and temporary files.
- Read `../../references/platform/runtime-diagnostics.md` for ЖР/ТЖ timeline when exchange fails at runtime.

## Workflow

1. Identify the exchange model: plan exchange, РИБ, file batch, queue, direct API, or hybrid integration.
2. Inspect metadata and modules with `mcp__unica__unica_view_6f3a42290cc8` on the object node and `mcp__unica__unica_search_a8644a757dff`: plans, nodes, registration rules, message numbers, loading handlers, and conflict resolution.
3. Define the exchange contract: node identity, external ids, schema version, ordering, idempotency, retry behavior, duplicate detection, and compatibility rules.
4. Check change registration deliberately: keep регистрация изменений explicit, state which objects are registered, when registration is suppressed, how deletes are represented, and how retries avoid double writes.
5. Check syntax with `mcp__unica__unica_check_6db7d2a7495f` (test runs are outside the v0.13 surface) and report runtime verification as unavailable; for live failures, rely on supplied ЖР/ТЖ and correlate message id, node, user/session, and object ids.

## Review checklist

- Message processing is restartable and idempotent.
- Errors distinguish validation, duplicate, incompatible version, missing reference, and temporary transport failure.
- Conflict resolution is explicit and logged.
- Exchange does not bypass rights or tenant boundaries accidentally.
- File names, encoding, schema version, and partial-write behavior are validated before loading.

## Contract gaps

If public MCP `unica` cannot expose exchange runtime state, message queue state, or registration details required for the task, report a Unica MCP contract gap.
