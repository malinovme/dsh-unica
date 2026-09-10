---
name: bsp-patterns
description: "Поиск и применение паттернов БСП. Используй когда задача про длительные операции, профили групп доступа, безопасное хранение, дополнительные обработки, HTTP/файлы, уведомления или готовую функцию БСП."
---

# BSP Patterns

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_meta_info_524a81764d16`, `mcp__unica__unica_form_info_fd2902463286`, `mcp__unica__unica_role_info_7face3da6726`, `mcp__unica__unica_standards_search_cab77e9c1bda`, `mcp__unica__unica_standards_explain_79d0ab30ea9c`, and `mcp__unica__unica_runtime_execute_0cd62fbc3716`.
- По INV-MCP-RUNTIME-RECEIPT и ADR-0074: `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: true`
показывает запланированную команду без побочных эффектов, а с `dryRun: false`
исполняет классифицированную операцию и отвечает её терминальным результатом в
том же вызове, приложив названную причину риска (`runtime_risk_*`)
предупреждением; неклассифицированная операция по-прежнему отказывает
`runtime_operation_unbounded` до обнаружения рабочего пространства. Preview
исполнением не является. Работу, которую вызов ждать не должен, запускай через
`mcp__unica__unica_runtime_job_start_64e0bb584ac4`. Не обходи контракт прямым runner-ом или через
`unica.build.*`.
- Use `epf-bsp-init` and `epf-bsp-add-command` only for BSP external processing registration helpers.
- Do not call internal analyzer, standards, runtime, or package adapters directly. They are hidden behind MCP `unica`.

## Workflow

1. Identify the BSP subsystem or library pattern by intent, not by guessed module name.
2. Search existing project usage with `mcp__unica__unica_code_search_70af4c0986a7` before writing new code. Prefer local project conventions over generic snippets.
3. Inspect affected metadata, forms, roles, and external processing registration with `unica.*.info` skills.
4. Use `mcp__unica__unica_standards_search_cab77e9c1bda` only for a `development-standard` that constrains the pattern. Do not treat it as platform or BSP documentation. Exact platform mechanics require a `platform-help` source; if public MCP `unica` does not expose one, report the contract gap. Treat local BSP code as corroborating implementation evidence, not as the platform contract.
5. Implement the smallest integration point; use `mcp__unica__unica_runtime_execute_0cd62fbc3716` to preview typed syntax/test arguments and, with `dryRun: false`, to run them, and do not claim runtime verification from that preview.

## References

- Read `../../references/platform/compatibility-modes.md` when BSP code gates
  behavior by a platform version or compatibility mode. Platform guidance
  remains the contract source; BSP code is corroborating implementation
  evidence that must be reconciled with that contract.

## Pattern hints

- Long operations: background job, progress feedback, cancellation, and idempotent restart.
- Access: role/profile interaction, privileged mode boundaries, and safe reads.
- External processing: `СведенияОВнешнейОбработке`, command descriptions, form opening, server command execution.
- Secure data: avoid plaintext secrets in modules, constants, logs, and versioned configs.
- Notifications/files: check cleanup and user-visible error path, not only happy path.

## MCP example

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_code_search_70af4c0986a7",
    "arguments": {
      "cwd": "<workspace>",
      "sourceSet": "<source-set-from-project-map>",
      "query": "СведенияОВнешнейОбработке",
      "limit": 20
    }
  }
}
```
