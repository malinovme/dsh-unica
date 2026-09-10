---
name: test-authoring
description: "Проектирование тестов 1С и preview команд YaXUnit/Vanessa Automation. Используй когда нужно написать тест, подобрать сценарии или подготовить all/module запуск; applied-запуск идёт через `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: false` или долговременным заданием."
---

# Test Authoring

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_project_map_7cc63b822c1d`, `mcp__unica__unica_runtime_execute_0cd62fbc3716`, and the relevant `unica.*.info` tools.
- По INV-MCP-RUNTIME-RECEIPT и ADR-0074: `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: true`
показывает запланированную команду без побочных эффектов, а с `dryRun: false`
исполняет классифицированную операцию и отвечает её терминальным результатом в
том же вызове, приложив названную причину риска (`runtime_risk_*`)
предупреждением; неклассифицированная операция по-прежнему отказывает
`runtime_operation_unbounded` до обнаружения рабочего пространства. Preview
исполнением не является. Работу, которую вызов ждать не должен, запускай через
`mcp__unica__unica_runtime_job_start_64e0bb584ac4`. Не обходи контракт прямым runner-ом или через
`unica.build.*`.
- Use `mcp__unica__unica_standards_search_cab77e9c1bda` or `mcp__unica__unica_standards_explain_79d0ab30ea9c` only when test design depends on a `development-standard`. Expected platform API or mechanics require a `platform-help` source; if public MCP `unica` does not expose one, report the contract gap.
- Do not call internal runtime, analyzer, or package adapters directly. They are hidden behind MCP `unica`.

## Workflow

1. Define the behavior under test before choosing the framework: pure BSL unit, object lifecycle, form behavior, integration contract, or regression around a diagnostic.
2. Search existing tests and fixtures with `mcp__unica__unica_code_search_70af4c0986a7`; follow local naming, setup, teardown, and assertion style.
3. Prefer YaXUnit for module/unit-level BSL behavior and Vanessa Automation for UI/business scenarios that require a client.
4. Build the smallest stable fixture. Avoid dependence on production data unless the user explicitly requests an integration test.
5. Preview `mcp__unica__unica_runtime_execute_0cd62fbc3716` with `operation=syntax` after adding test code, then preview `operation=test` with `testRunner=yaxunit` or `testRunner=va`; neither call executes the test suite.
6. Report that runtime verification was not performed. If separate test evidence is supplied, report the exact failing test, expected/actual behavior, and whether the failure is test setup or product behavior.

## Verification gate

- For implementation plans, every stated behavior gets either an executable test,
  a syntax/diagnostic check, or an explicit residual risk.
- For public API, integration, release, or metadata behavior, include impact
  analysis evidence from the relevant `unica.*` tools before treating the test
  plan as complete.
- Do not call donor-specific check commands. Use `mcp__unica__unica_code_diagnostics_43785e27e86c` and
  focused `unica.*.info` tools for available static checks; use
  `mcp__unica__unica_runtime_execute_0cd62fbc3716` to preview the intended runtime request and, with `dryRun: false`, to run it.

## Scenario design

- Read `../../references/platform/integration-contracts.md` when tests verify HTTP/API/OData/JSON/XML/file-exchange behavior.
- Read `../../references/platform/runtime-diagnostics.md` when a test is meant to reproduce a user-facing runtime failure.
- Treat tests as executable debugging: one test should prove the intended user/API scenario, the failure mode, and the regression boundary.
- For API scenarios, cover success, validation error, auth error, duplicate/idempotent retry, remote timeout, and stable error semantics.
- For UI or web-client scenarios, preview `operation=test` for the 1C test suite. Hand a concrete autonomous URL to an external browser-testing tool only when that URL and its running environment were supplied independently.

## MCP examples

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_runtime_execute_0cd62fbc3716",
    "arguments": {
      "cwd": "<workspace>",
      "operation": "test",
      "testRunner": "yaxunit",
      "testScope": "module",
      "module": "ТестДокументаЗаказКлиента",
      "dryRun": true
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_runtime_execute_0cd62fbc3716",
    "arguments": {
      "cwd": "<workspace>",
      "operation": "test",
      "testRunner": "va",
      "dryRun": true
    }
  }
}
```
