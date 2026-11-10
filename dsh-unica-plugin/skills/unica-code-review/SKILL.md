---
name: code-review
description: "Код-ревью BSL и изменений 1С. Используй когда пользователь явно просит review, ревью diff/PR/модуля/изменения, поиск дефектов, регрессий, рисков или недостающих тестов."
---

# Code Review

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_search_a8644a757dff`, `mcp__unica__unica_check_6db7d2a7495f`, `mcp__unica__unica_view_6f3a42290cc8` on the object node, `mcp__unica__unica_docs_fd15d9ecf894`, `mcp__unica__unica_view_6f3a42290cc8 {}`, and `mcp__unica__unica_run_189d01f64719`.
- Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
используй опубликованную `argsSchema`; при `support.state: limited`
разрешено только подмножество `support.supportedArgs`. Недоступной операции
в словаре нет. Для плановой операции сначала проверь результат
`dryRun: true`, затем исполняй запрос с `dryRun: false`. Preview
не фиксирует входы между вызовами. Не обходи контракт прямым runner-ом.
- Use `mcp__unica__unica_view_6f3a42290cc8` at the object's logical address before reviewing code that depends on metadata shape, form structure, rights, DCS, or interfaces; a spreadsheet template is read by `mcp__unica__unica_view_6f3a42290cc8` at its template address.
- Do not call internal analyzer, standards, runtime, or package adapters directly. They are hidden behind MCP `unica`.

## Review stance

Lead with findings. Order them by severity and ground each finding in a file/line reference, reproducible path, or diagnostic output. Keep summaries secondary.

## Workflow

1. Identify the review scope: changed files, target source-set, affected metadata objects, public entry points.
2. Find changed exported methods and entry points with `mcp__unica__unica_search_a8644a757dff`; inspect large modules with `mcp__unica__unica_view_6f3a42290cc8` on the module node (its `Method` branch lists the methods).
3. Use `mcp__unica__unica_view_6f3a42290cc8` on the object node for affected metadata objects to connect the review scope with modules, roles, subscriptions, functional options, and predefined items.
4. Find callers and impact with `mcp__unica__unica_view_6f3a42290cc8` at `<method>.Caller` (callees at `<method>.Callee`); `mcp__unica__unica_search_a8644a757dff` by the method name covers handlers, literals, query fragments, and non-method tokens.
5. Inspect metadata with `mcp__unica__unica_view_6f3a42290cc8` on the object node when code depends on object structure.
6. Run `mcp__unica__unica_check_6db7d2a7495f {at}` on each touched module when the review includes BSL code; a whole-source-set analysis is not on the v0.13 surface, so check module by module. Use `mcp__unica__unica_resolve_55e2d51be222` first when the diff supplies only a file path. Use `mcp__unica__unica_docs_fd15d9ecf894` with `source: "development-standard"` for diagnostic codes or standards-sensitive claims.
7. Check high-risk 1C patterns: transaction boundaries, query-in-loop, server/client context, privileged mode, broad rights, background jobs, external calls, temporary files, and silent exception handling.
8. Check syntax with `mcp__unica__unica_check_6db7d2a7495f` (test runs are outside the v0.13 surface); always state the exact unverified runtime risk unless separate execution evidence is supplied.

## Output

- Findings first: severity, path, issue, impact, suggested fix.
- Then open questions or assumptions.
- Then brief change/test summary only if useful.

Do not rewrite the code during a review unless the user explicitly asks for fixes after the review.
