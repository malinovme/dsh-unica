---
name: code-review
description: "Код-ревью BSL и изменений 1С. Используй когда пользователь явно просит review, ревью diff/PR/модуля/изменения, поиск дефектов, регрессий, рисков или недостающих тестов."
---

# Code Review

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_code_definition_3534a044b497`, `mcp__unica__unica_code_outline_dc58fe5ade0e`, `mcp__unica__unica_code_graph_c09c4e5a3a83`, `mcp__unica__unica_code_diagnostics_43785e27e86c`, `mcp__unica__unica_meta_info_524a81764d16`, `mcp__unica__unica_standards_explain_79d0ab30ea9c`, `mcp__unica__unica_standards_search_cab77e9c1bda`, `mcp__unica__unica_project_map_7cc63b822c1d`, and `mcp__unica__unica_runtime_execute_0cd62fbc3716`.
- По INV-MCP-RUNTIME-RECEIPT и ADR-0074: `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: true`
показывает запланированную команду без побочных эффектов, а с `dryRun: false`
исполняет классифицированную операцию и отвечает её терминальным результатом в
том же вызове, приложив названную причину риска (`runtime_risk_*`)
предупреждением; неклассифицированная операция по-прежнему отказывает
`runtime_operation_unbounded` до обнаружения рабочего пространства. Preview
исполнением не является. Работу, которую вызов ждать не должен, запускай через
`mcp__unica__unica_runtime_job_start_64e0bb584ac4`. Не обходи контракт прямым runner-ом или через
`unica.build.*`.
- Use `unica.*.info` tools before reviewing code that depends on metadata shape, form structure, rights, DCS, MXL, or interfaces.
- Do not call internal analyzer, standards, runtime, or package adapters directly. They are hidden behind MCP `unica`.

## Review stance

Lead with findings. Order them by severity and ground each finding in a file/line reference, reproducible path, or diagnostic output. Keep summaries secondary.

## Workflow

1. Identify the review scope: changed files, target source-set, affected metadata objects, public entry points.
2. Resolve changed exported methods and entry points with `mcp__unica__unica_code_definition_3534a044b497`; inspect large modules with `mcp__unica__unica_code_outline_dc58fe5ade0e`.
3. Use `mcp__unica__unica_meta_info_524a81764d16` for affected metadata objects to connect the review scope with modules, roles, subscriptions, functional options, and predefined items.
4. Use `mcp__unica__unica_code_graph_c09c4e5a3a83` for callers, callees, neighbors, and impact analysis when a changed method/node can be resolved. Use `mcp__unica__unica_code_search_70af4c0986a7` for handlers, literals, query fragments, and non-method tokens.
5. Inspect metadata with `unica.*.info` when code depends on object structure.
6. Run `mcp__unica__unica_code_diagnostics_43785e27e86c` when the review includes BSL code. Select the exact `sourceSet`; use `action=findings` with each touched module's logical `metadataPath`, or `action=analyze` for a broad source-set review. Use `mcp__unica__unica_source_locate_90d2dfe965b7` first when the diff supplies only a file path. Use `mcp__unica__unica_standards_explain_79d0ab30ea9c` for diagnostic codes or standards-sensitive claims.
7. Check high-risk 1C patterns: transaction boundaries, query-in-loop, server/client context, privileged mode, broad rights, background jobs, external calls, temporary files, and silent exception handling.
8. Use `mcp__unica__unica_runtime_execute_0cd62fbc3716` to preview typed syntax/test arguments and, with `dryRun: false`, to run them; always state the exact unverified runtime risk unless separate execution evidence is supplied.

## Output

- Findings first: severity, path, issue, impact, suggested fix.
- Then open questions or assumptions.
- Then brief change/test summary only if useful.

Do not rewrite the code during a review unless the user explicitly asks for fixes after the review.
