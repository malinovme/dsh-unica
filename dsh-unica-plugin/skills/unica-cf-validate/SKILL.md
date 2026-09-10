---
name: cf-validate
description: Валидация конфигурации 1С. Используй после создания или модификации конфигурации для проверки корректности
argument-hint: <ConfigPath> [-Detailed] [-MaxErrors 30]
allowed-tools:
  - Bash
  - Read
  - Glob
---

# /cf-validate — валидация конфигурации 1С

## MCP routing

- Preferred path: use MCP `unica` tool `mcp__unica__unica_cf_validate_246a58ff9fac`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `mcp__unica__unica_cf_validate_246a58ff9fac`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Проверяет Configuration.xml на структурные ошибки: XML well-formedness, InternalInfo, свойства, enum-значения, ChildObjects, DefaultLanguage, файлы языков, каталоги объектов.

## Параметры

| Параметр   | Обяз. | Умолч. | Описание                                      |
|------------|:-----:|---------|-------------------------------------------------|
| ConfigPath | один из двух | —       | Путь к Configuration.xml или каталогу выгрузки  |
| sourceSet  | один из двух | —       | Имя набора исходников из `v8project.yaml`       |
| Detailed   | нет   | —       | Подробный вывод (все проверки, включая успешные) |
| MaxErrors  | нет   | 30      | Остановиться после N ошибок                     |

Селектор цели ровно один: либо `sourceSet`, либо `ConfigPath`. Оба сразу
отклоняются кодом `selector_conflict` (ADR-0049).

## MCP вызов

### Каталог выгрузки

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_cf_validate_246a58ff9fac",
    "arguments": {
      "cwd": "<workspace>",
      "ConfigPath": "upload/cfempty"
    }
  }
}
```

### Прямой путь к Configuration.xml

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_cf_validate_246a58ff9fac",
    "arguments": {
      "cwd": "<workspace>",
      "ConfigPath": "upload/cfempty/Configuration.xml"
    }
  }
}
```

## Логический адрес вместо пути

`mcp__unica__unica_cf_validate_246a58ff9fac` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_cf_validate_246a58ff9fac",
    "arguments": {
      "cwd": "<workspace>",
      "sourceSet": "<имя набора>"
    }
  }
}
```

Имя набора даёт `mcp__unica__unica_project_map_7cc63b822c1d`. Файловый селектор сохраняется до
отдельного среза его снятия (ADR-0049).
