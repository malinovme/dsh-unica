---
name: role-validate
description: Валидация роли 1С. Используй после создания или модификации роли для проверки корректности
argument-hint: <RightsPath> [-Detailed] [-MaxErrors 30]
allowed-tools:
  - Bash
  - Read
---

# /role-validate — валидация роли 1С

## MCP routing

- Preferred path: use MCP `unica` tool `mcp__unica__unica_role_validate_b7f8a919bffe`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `mcp__unica__unica_role_validate_b7f8a919bffe`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Проверяет корректность `Rights.xml` роли: формат XML, namespace, глобальные флаги, типы объектов, имена прав, RLS-ограничения, шаблоны. Опционально проверяет метаданные роли (UUID, имя, синоним).

## Параметры

| Параметр     | Обяз. | Умолч. | Описание                                        |
|--------------|:-----:|---------|-------------------------------------------------|
| RightsPath   | один из двух | —       | Путь к роли (директория или `Rights.xml`)        |
| sourceSet    | один из двух | —       | Имя набора исходников из `v8project.yaml`        |
| metadataPath | один из двух | —       | Логический адрес, например `Role.<ИмяРоли>`      |
| Detailed     | нет   | —       | Подробный вывод (все проверки, включая успешные)  |
| MaxErrors    | нет   | 30      | Макс. ошибок до остановки (по умолчанию 30)      |

Селектор цели ровно один: либо `sourceSet` + `metadataPath`, либо `RightsPath`.
Оба сразу отклоняются кодом `selector_conflict` (ADR-0049).

## MCP вызов

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_role_validate_b7f8a919bffe",
    "arguments": {
      "cwd": "<workspace>",
      "RightsPath": "src/Roles/ЧтениеНоменклатуры",
      "Detailed": true,
      "MaxErrors": 30
    }
  }
}
```

## Логический адрес вместо пути

`mcp__unica__unica_role_validate_b7f8a919bffe` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_role_validate_b7f8a919bffe",
    "arguments": {
      "cwd": "<workspace>",
      "sourceSet": "<имя набора>",
      "metadataPath": "Role.<ИмяРоли>"
    }
  }
}
```

Имя набора даёт `mcp__unica__unica_project_map_7cc63b822c1d`, адрес — `mcp__unica__unica_source_resolve_bbc823735283`, а `mcp__unica__unica_source_locate_90d2dfe965b7` переводит
в адрес путь, найденный иначе. Файловый селектор сохраняется до
отдельного среза его снятия (ADR-0049).
