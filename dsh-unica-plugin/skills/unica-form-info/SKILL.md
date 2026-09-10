---
name: form-info
description: Анализ структуры управляемой формы 1С (Form.xml) — элементы, реквизиты, команды, события. Используй для понимания формы — при написании модуля формы, анализе обработчиков и элементов
argument-hint: <FormPath>
allowed-tools:
  - Bash
  - Read
  - Glob
---

# /form-info — Компактная сводка формы

## MCP routing

- Preferred path: use MCP `unica` tool `mcp__unica__unica_form_info_fd2902463286`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `mcp__unica__unica_form_info_fd2902463286`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Читает Form.xml и выводит дерево элементов, реквизиты с типами, команды, события. Заменяет чтение тысяч строк XML.

В выводе показывает `Поддержка` для объекта-владельца формы по `Ext/ParentConfigurations.bin`. Если форма принадлежит объекту поставщика на замке, сначала оцени CFE/release-support путь; сам `mcp__unica__unica_form_info_fd2902463286` только читает состояние.

## MCP вызов

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_form_info_fd2902463286",
    "arguments": {
      "cwd": "<workspace>",
      "FormPath": "src/Catalogs/Номенклатура/Forms/ФормаЭлемента"
    }
  }
}
```

## Параметры

| Параметр | Обязательный | Описание |
|----------|:------------:|----------|
| FormPath | один из двух | Путь к файлу Form.xml |
| sourceSet | один из двух | Имя набора исходников из `v8project.yaml` |
| metadataPath | один из двух | Логический адрес, например `Catalog.<Объект>.Form.<Форма>` |

`Expand`, `Limit` и `Offset` сняты (ADR-0048): дерево элементов приходит
типизированным в `data` целиком и не сворачивается, поэтому раскрывать и
листать нечего.

Селектор цели ровно один: либо `sourceSet` + `metadataPath`, либо `FormPath`.
Оба сразу отклоняются кодом `selector_conflict` (ADR-0049).

Вывод самодокументирован. `[Group:AH]`/`[Group:AV]` = AlwaysHorizontal/AlwaysVertical.

## Логический адрес вместо пути

`mcp__unica__unica_form_info_fd2902463286` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_form_info_fd2902463286",
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
