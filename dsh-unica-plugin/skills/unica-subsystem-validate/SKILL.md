---
name: subsystem-validate
description: Валидация подсистемы 1С. Используй после создания или модификации подсистемы для проверки корректности
argument-hint: <SubsystemPath> [-Detailed] [-MaxErrors 30]
allowed-tools:
  - Bash
  - Read
  - Glob
---

# /subsystem-validate — валидация подсистемы 1С

## MCP routing

- Preferred path: use MCP `unica` tool `mcp__unica__unica_subsystem_validate_eef1332c6507`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `mcp__unica__unica_subsystem_validate_eef1332c6507`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Проверяет структурную корректность XML-файла подсистемы из выгрузки конфигурации.

## Параметры

| Параметр      | Обяз. | Умолч. | Описание                                  |
|---------------|:-----:|---------|--------------------------------------------|
| SubsystemPath | один из двух | —       | Путь к XML-файлу подсистемы                |
| sourceSet     | один из двух | —       | Имя набора исходников из `v8project.yaml`  |
| metadataPath  | один из двух | —       | Логический адрес, например `Subsystem.<Подсистема>` |
| Detailed      | нет   | —       | Подробный вывод (все проверки, включая успешные) |
| MaxErrors     | нет   | 30      | Остановиться после N ошибок                |

Селектор цели ровно один: либо `sourceSet` + `metadataPath`, либо
`SubsystemPath`. Оба сразу отклоняются кодом `selector_conflict` (ADR-0049).

## MCP вызов

### Каталог подсистемы

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_subsystem_validate_eef1332c6507",
    "arguments": {
      "cwd": "<workspace>",
      "SubsystemPath": "Subsystems/Продажи"
    }
  }
}
```

### Прямой путь к XML подсистемы

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_subsystem_validate_eef1332c6507",
    "arguments": {
      "cwd": "<workspace>",
      "SubsystemPath": "Subsystems/Продажи.xml"
    }
  }
}
```

## Логический адрес вместо пути

`mcp__unica__unica_subsystem_validate_eef1332c6507` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_subsystem_validate_eef1332c6507",
    "arguments": {
      "cwd": "<workspace>",
      "sourceSet": "<имя набора>",
      "metadataPath": "Subsystem.<Подсистема>"
    }
  }
}
```

Имя набора даёт `mcp__unica__unica_project_map_7cc63b822c1d`, адрес — `mcp__unica__unica_source_resolve_bbc823735283`, а `mcp__unica__unica_source_locate_90d2dfe965b7` переводит
в адрес путь, найденный иначе. Файловый селектор сохраняется до
отдельного среза его снятия (ADR-0049).
