---
name: data-exchange
description: "Обмен данными 1С. Используй когда нужно реализовать или диагностировать планы обмена, РИБ, регистрацию изменений, загрузку/выгрузку сообщений, конфликт данных или контракт обмена."
---

# Data Exchange

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_project_map_7cc63b822c1d`, `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_meta_info_524a81764d16`, `mcp__unica__unica_code_diagnostics_43785e27e86c`, `mcp__unica__unica_standards_search_cab77e9c1bda`, `mcp__unica__unica_standards_explain_79d0ab30ea9c`, and `mcp__unica__unica_runtime_execute_0cd62fbc3716`.
- По INV-MCP-RUNTIME-RECEIPT и ADR-0074: `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: true`
показывает запланированную команду без побочных эффектов, а с `dryRun: false`
исполняет классифицированную операцию и отвечает её терминальным результатом в
том же вызове, приложив названную причину риска (`runtime_risk_*`)
предупреждением; неклассифицированная операция по-прежнему отказывает
`runtime_operation_unbounded` до обнаружения рабочего пространства. Preview
исполнением не является. Работу, которую вызов ждать не должен, запускай через
`mcp__unica__unica_runtime_job_start_64e0bb584ac4`. Не обходи контракт прямым runner-ом или через
`unica.build.*`.
- Use `mcp__unica__unica_role_info_7face3da6726` when exchange behavior depends on rights, privileged mode, or separated data.
- Do not call internal metadata, runtime, analyzer, standards, or package adapters directly. They are hidden behind MCP `unica`.

## References

- Read `../../references/platform/integration-contracts.md` for message contracts, file exchange, idempotency, versioning, and error semantics.
- Read `../../references/platform/platform-mechanics.md` for exchange registration, tenant boundaries, background workers, and temporary files.
- Read `../../references/platform/runtime-diagnostics.md` for ЖР/ТЖ timeline when exchange fails at runtime.

## Workflow

1. Identify the exchange model: plan exchange, РИБ, file batch, queue, direct API, or hybrid integration.
2. Inspect metadata and modules with `mcp__unica__unica_meta_info_524a81764d16` and `mcp__unica__unica_code_search_70af4c0986a7`: plans, nodes, registration rules, message numbers, loading handlers, and conflict resolution.
3. Define the exchange contract: node identity, external ids, schema version, ordering, idempotency, retry behavior, duplicate detection, and compatibility rules.
4. Check change registration deliberately: keep регистрация изменений explicit, state which objects are registered, when registration is suppressed, how deletes are represented, and how retries avoid double writes.
5. Use `mcp__unica__unica_runtime_execute_0cd62fbc3716` to preview typed syntax/test arguments and, with `dryRun: false`, to run them and report runtime verification as unavailable; for live failures, rely on supplied ЖР/ТЖ and correlate message id, node, user/session, and object ids.

## Review checklist

- Message processing is restartable and idempotent.
- Errors distinguish validation, duplicate, incompatible version, missing reference, and temporary transport failure.
- Conflict resolution is explicit and logged.
- Exchange does not bypass rights or tenant boundaries accidentally.
- File names, encoding, schema version, and partial-write behavior are validated before loading.

## Contract gaps

If public MCP `unica` cannot expose exchange runtime state, message queue state, or registration details required for the task, report a Unica MCP contract gap.
