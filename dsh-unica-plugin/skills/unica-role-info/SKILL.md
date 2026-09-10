---
name: role-info
description: Компактная сводка прав роли 1С из Rights.xml — объекты, права, RLS, шаблоны ограничений. Используй для аудита прав — какие объекты и действия доступны, ограничения RLS
argument-hint: <RightsPath>
allowed-tools:
  - Bash
  - Read
---

# /role-info — анализ роли 1С

## MCP routing

- Preferred path: use MCP `unica` tool `mcp__unica__unica_role_info_7face3da6726`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `mcp__unica__unica_role_info_7face3da6726`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Парсит `Rights.xml` роли и возвращает права типизированными данными в `data`
(ADR-0023): объекты сгруппированы по виду, разрешённые и запрещённые права
приходят одинаково, без флага-переключателя.

## Использование

```
/role-info <RightsPath>
```

**RightsPath** — путь к файлу `Rights.xml` роли (обычно `Roles/ИмяРоли/Ext/Rights.xml`).

## MCP вызов

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_role_info_7face3da6726",
    "arguments": {
      "cwd": "<workspace>",
      "RightsPath": "<path>"
    }
  }
}
```

### Параметры

| Параметр | Обязательный | Описание |
|----------|:------------:|----------|
| `RightsPath` | один из двух | Путь к `Rights.xml` роли |
| `sourceSet`  | один из двух | Имя набора исходников из `v8project.yaml` |
| `metadataPath` | один из двух | Логический адрес, например `Role.<ИмяРоли>` |

Селектор цели ровно один: либо `sourceSet` + `metadataPath`, либо `RightsPath`.
Оба сразу отклоняются кодом `selector_conflict` (ADR-0049).

`ShowDenied`, `Limit` и `Offset` сняты: запрещённые права теперь приходят
всегда, а пагинация резала печатные строки, которых больше нет.

### Поля `data`

| Поле | Что содержит |
|------|--------------|
| `name`, `synonym` | Имя роли и синоним либо `null` |
| `support` | Поддержка роли: `notSupported`, `extension`, `removed` или `supported` со счётчиками объектов |
| `defaults` | Атрибуты корня: права новым объектам, реквизитам и независимость прав подчинённых |
| `allowed`, `denied` | Группы по виду объекта: `kind`, затем `objects` с именем и списком прав |
| `allowed[].objects[].rights[]` | `name` права и `restricted` — ограничено ли оно RLS |
| `totals` | Сколько прав разрешено и сколько запрещено |
| `restrictedObjects` | Объекты с ограничением на уровне записей |
| `templates` | Шаблоны ограничений роли |

Поддержка читается из `Ext/ParentConfigurations.bin`. Для роли поставщика на
замке сначала фиксируй release-support решение, а не меняй права напрямую.

### Аудит запрещённых прав

Запрещённые права лежат в `data.denied` рядом с разрешёнными, поэтому пустой
список означает «их нет», а не «их не запросили».

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_role_info_7face3da6726",
    "arguments": {
      "cwd": "<workspace>",
      "RightsPath": "<path>"
    }
  }
}
```

## Логический адрес вместо пути

`mcp__unica__unica_role_info_7face3da6726` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_role_info_7face3da6726",
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
