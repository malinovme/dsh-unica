---
name: bsp-patterns
description: "Поиск и применение паттернов БСП. Используй когда задача про длительные операции, профили групп доступа, безопасное хранение, дополнительные обработки, HTTP/файлы, уведомления или готовую функцию БСП."
---

# BSP Patterns

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_search_a8644a757dff`, `mcp__unica__unica_view_6f3a42290cc8` on the object node, `mcp__unica__unica_view_6f3a42290cc8` on the form and role nodes, `mcp__unica__unica_docs_fd15d9ecf894`, and `mcp__unica__unica_run_189d01f64719`.
- Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
при `implemented: true` используй опубликованную `argsSchema`; при
`support.state: limited` разрешено только подмножество `support.supportedArgs`.
При `support.state: unavailable` остановись; не выдумывай аргументов при
`argsSchema: null`. Для плановой операции сначала проверь результат `dryRun: true`,
затем исполняй запрос с `dryRun: false`. Preview не фиксирует входы между
вызовами. Не обходи контракт прямым runner-ом.
- Use `epf-bsp-init` and `epf-bsp-add-command` only for BSP external processing registration helpers.
- Do not call internal analyzer, standards, runtime, or package adapters directly. They are hidden behind MCP `unica`.

## Workflow

1. Identify the BSP subsystem or library pattern by intent, not by guessed module name.
2. Search existing project usage with `mcp__unica__unica_search_a8644a757dff` before writing new code. Prefer local project conventions over generic snippets.
3. Inspect affected metadata, forms, roles, and external processing registration with `mcp__unica__unica_view_6f3a42290cc8` at each object's logical address.
4. Use `mcp__unica__unica_docs_fd15d9ecf894` with `source: "development-standard"` only for a `development-standard` that constrains the pattern. Do not treat it as platform or BSP documentation. Exact platform mechanics require `mcp__unica__unica_docs_fd15d9ecf894` with `source: "platform-help"`. Treat local BSP code as corroborating implementation evidence, not as the platform contract.
5. Implement the smallest integration point; check syntax with `mcp__unica__unica_check_6db7d2a7495f` (test runs are outside the v0.13 surface), and do not claim runtime verification from a static check.

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
    "name": "mcp__unica__unica_search_a8644a757dff",
    "arguments": {
      "query": "СведенияОВнешнейОбработке",
      "scope": "<source-set-from-unica-view>:Configuration",
      "limit": 20
    }
  }
}
```
