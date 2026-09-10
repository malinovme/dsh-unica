---
name: mxl-validate
description: Валидация макета табличного документа (MXL). Используй после создания или модификации макета для проверки корректности
argument-hint: <TemplatePath> [-Detailed] [-MaxErrors 20]
allowed-tools:
  - Bash
  - Read
  - Glob
---

# /mxl-validate — валидация макета табличного документа (MXL)

## MCP routing

- Preferred path: use MCP `unica` tool `mcp__unica__unica_mxl_validate_5d3276e7f84b`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `mcp__unica__unica_mxl_validate_5d3276e7f84b`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Проверяет Template.xml на структурные ошибки: индексы, ссылки на палитры, диапазоны именованных областей и объединений.

## Параметры

| Параметр      | Обяз. | Умолч. | Описание                                 |
|---------------|:-----:|---------|--------------------------------------------|
| TemplatePath  | один из двух | —       | Путь к макету (директория или Template.xml) |
| sourceSet     | один из двух | —       | Имя набора исходников из `v8project.yaml`   |
| metadataPath  | один из двух | —       | Логический адрес, например `Report.<Отчёт>.Template.<Макет>` |
| Detailed      | нет   | —       | Подробный вывод (все проверки, включая успешные) |
| MaxErrors     | нет   | 20      | Остановиться после N ошибок                |

Селектор цели ровно один: либо `sourceSet` + `metadataPath`, либо
`TemplatePath`. Оба сразу отклоняются кодом `selector_conflict` (ADR-0049).

## MCP вызов

### Каталог макета

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_mxl_validate_5d3276e7f84b",
    "arguments": {
      "cwd": "<workspace>",
      "TemplatePath": "Catalogs/Номенклатура/Templates/Макет"
    }
  }
}
```

### Макет внешней обработки

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_mxl_validate_5d3276e7f84b",
    "arguments": {
      "cwd": "<workspace>",
      "TemplatePath": "src/МояОбработка/Templates/ПечатнаяФорма"
    }
  }
}
```

## Логический адрес вместо пути

`mcp__unica__unica_mxl_validate_5d3276e7f84b` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_mxl_validate_5d3276e7f84b",
    "arguments": {
      "cwd": "<workspace>",
      "sourceSet": "<имя набора>",
      "metadataPath": "Report.<Отчёт>.Template.<Макет>"
    }
  }
}
```

Имя набора даёт `mcp__unica__unica_project_map_7cc63b822c1d`, адрес — `mcp__unica__unica_source_resolve_bbc823735283`, а `mcp__unica__unica_source_locate_90d2dfe965b7` переводит
в адрес путь, найденный иначе. Файловый селектор сохраняется до
отдельного среза его снятия (ADR-0049).
