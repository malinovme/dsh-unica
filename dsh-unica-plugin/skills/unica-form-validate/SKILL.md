---
name: form-validate
description: Валидация управляемой формы 1С. Используй после создания или модификации формы для проверки корректности. При наличии BaseForm автоматически проверяет callType и ID расширений
argument-hint: <FormPath> [-Detailed] [-MaxErrors 30]
allowed-tools:
  - Bash
  - Read
  - Glob
---

# /form-validate — валидация управляемой формы 1С

## MCP routing

- Preferred path: use MCP `unica` tool `mcp__unica__unica_form_validate_b0ca1362ac11`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `mcp__unica__unica_form_validate_b0ca1362ac11`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Проверяет Form.xml на структурные ошибки: уникальность ID, наличие companion-элементов, корректность ссылок DataPath и команд. События формы и элементов проверяются по платформенной матрице с типом прямого главного реквизита; duplicate, пустой handler, неверный element/event и неподходящий контекст возвращают стабильные коды `FORM_EVENT_*`. `callType` допустим только в форме с прямым `BaseForm` и только со значениями `Before`, `After`, `Override`. Если у заимствованной формы нет доступного прямого главного реквизита ни в `Form`, ни в `BaseForm`, object-specific binding помечается предупреждением `FORM_EVENT_CONTEXT_UNKNOWN` как непроверенный; editor при добавлении такого binding остаётся консервативным и отклоняет изменение.

## Параметры

| Параметр  | Обяз. | Умолч. | Описание                                |
|-----------|:-----:|---------|-----------------------------------------|
| FormPath  | один из двух | —       | Путь к файлу Form.xml                   |
| sourceSet | один из двух | —       | Имя набора исходников из `v8project.yaml` |
| metadataPath | один из двух | —       | Логический адрес, например `Catalog.<Объект>.Form.<Форма>` |
| Detailed  | нет   | —       | Подробный вывод (все проверки, включая успешные) |
| MaxErrors | нет   | 30      | Остановиться после N ошибок              |

Селектор цели ровно один: либо `sourceSet` + `metadataPath`, либо `FormPath`.
Оба сразу отклоняются кодом `selector_conflict` (ADR-0049).

## MCP вызов

### Каталог формы

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_form_validate_b0ca1362ac11",
    "arguments": {
      "cwd": "<workspace>",
      "FormPath": "Catalogs/Номенклатура/Forms/ФормаЭлемента"
    }
  }
}
```

### Прямой путь к Form.xml

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_form_validate_b0ca1362ac11",
    "arguments": {
      "cwd": "<workspace>",
      "FormPath": "src/МояОбработка/Forms/Форма/Ext/Form.xml"
    }
  }
}
```

## Логический адрес вместо пути

`mcp__unica__unica_form_validate_b0ca1362ac11` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_form_validate_b0ca1362ac11",
    "arguments": {
      "cwd": "<workspace>",
      "sourceSet": "<имя набора>",
      "metadataPath": "Catalog.<Объект>.Form.<Форма>"
    }
  }
}
```

Имя набора даёт `mcp__unica__unica_project_map_7cc63b822c1d`, адрес — `mcp__unica__unica_source_resolve_bbc823735283`, а `mcp__unica__unica_source_locate_90d2dfe965b7` переводит
в адрес путь, найденный иначе. Файловый селектор сохраняется до
отдельного среза его снятия (ADR-0049).
