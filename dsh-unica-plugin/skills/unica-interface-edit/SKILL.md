---
name: interface-edit
description: Настройка командного интерфейса подсистемы 1С. Используй когда нужно скрыть или показать команды, разместить в группах, настроить порядок
argument-hint: <at> <ops>
allowed-tools:
  - Read
  - Glob
---

# /interface-edit — правка командного интерфейса

## MCP routing

- Preferred path: use MCP `unica` tool `mcp__unica__unica_apply_8ba7af26408e` с операциями
  `commandVisibility.set`, `commandPlacement.set`, `commandOrder.set`,
  `groupOrder.set` и `subsystemOrder.set`.
- Do not call internal MCP/CLI adapters directly. They are hidden behind
  `unica` and synchronized by the orchestrator.
- Интерфейс называет адрес: `args.at` вида
  `<набор>:Subsystem.<Имя>.Interface`, а порядок команд — адрес группы
  `…Interface.Group.<Группа>`. Имя группы с точкой (`CommandGroup.Цены`)
  пишется в адресе с `\.`: `…Group.CommandGroup\.Цены` (в JSON —
  `CommandGroup\\.Цены`); `mcp__unica__unica_view_6f3a42290cc8` ветви `Group` отдаёт готовые адреса.
  Пути к `CommandInterface.xml` наружу
  нет; путь из диффа или лога переводит в адрес аварийный `mcp__unica__unica_resolve_55e2d51be222`.
- Сначала вызови `mcp__unica__unica_apply_8ba7af26408e` с `at` и `ops`: это план без записи.
  Когда пользователь поручил внести эту правку, вызови `mcp__unica__unica_apply_8ba7af26408e` только
  с `executionToken` из `data.executionToken` успешного плана.

**Команда лежит в аргументах, а не в адресе.** Имя команды в интерфейсе — это
ссылка на команду, живущую в другом месте (`CommonCommand.Печать`,
`Catalog.Валюты.Command.Создать`). Адрес несёт интерфейс, потому что предмет
правки — место, которое подсистема команде отводит, а не сама команда.

## Операции

| Операция | `at` | `args` | Секция файла |
|---|---|---|---|
| `commandVisibility.set` | `…Subsystem.<Имя>.Interface` | `items: [{command, visible}]` | `CommandsVisibility` |
| `commandPlacement.set` | `…Subsystem.<Имя>.Interface` | `items: [{command, group?, placement?}]` | `CommandsPlacement` |
| `commandOrder.set` | `…Subsystem.<Имя>.Interface.Group.<Группа>` | `values: {commands: […]}` | `CommandsOrder` |
| `groupOrder.set` | `…Subsystem.<Имя>.Interface` | `values: {groups: […]}` | `GroupsOrder` |
| `subsystemOrder.set` | `<набор>:Configuration` | `values: {subsystems: […]}` | `SubsystemsOrder` |

Вложенная подсистема адресуется всей цепочкой:
`main:Subsystem.Администрирование.Subsystem.КонтрольРаботыПользователей.Interface`.
Одноимённая подсистема в другом месте целью не становится.

**Порядок подсистем верхнего уровня метит в корень конфигурации.** Корневой
документ несёт единственную секцию, поэтому узла у него нет — он описан
свойством корня. На интерфейсе подсистемы `subsystemOrder.set` отклоняется.

**Порядок — перестановка сохранённого состава.** Три операции порядка
принимают полную последовательность тех же элементов, что уже сохранены:
у `commandOrder.set` — команд группы адреса, у `groupOrder.set` — групп,
у `subsystemOrder.set` — подсистем. Пропуск, повтор или лишний элемент
отклоняются без записи: пропуск не удаляет настройку. Прочитай текущий
порядок в `mcp__unica__unica_view_6f3a42290cc8` и переставь его. Если порядка ещё нет, список
задаёт его впервые. Порядок других групп и остальные секции файла
не меняются. Прежний `values.group` отклоняется с `bad_value`, `next` ведёт
к адресу группы.

**Каждая операция правит свою секцию и ничью больше.** В частности, правка
видимости касается только общего значения: переопределения по ролям в том же
блоке остаются нетронутыми. Их число видно в чтении полем `roleOverrides` —
если оно не ноль, `visible` не вся правда о видимости команды.

## Порядок

1. Найди подсистему: `mcp__unica__unica_search_a8644a757dff {corpus: "names", kind: "Subsystem"}`.
2. Прочти интерфейс: `mcp__unica__unica_view_6f3a42290cc8 {at: "…Subsystem.<Имя>.Interface"}` — ветви
   `Command`, `Group` и `Subsystem` показывают команды, порядок групп и
   порядок дочерних подсистем.
3. Предпросмотр: `mcp__unica__unica_apply_8ba7af26408e` с `at` и `ops`; ответ несёт план и `data.executionToken`.
4. Применение: вызов только с `executionToken` из `data.executionToken` успешного плана.

## Примеры

### Скрыть одну команду и показать другую

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_apply_8ba7af26408e",
    "arguments": {
      "at": "main:Subsystem.Продажи",
      "ops": [
        {
          "op": "commandVisibility.set",
          "args": {
            "at": "main:Subsystem.Продажи.Interface",
            "items": [
              {"command": "Catalog.Товары.StandardCommand.OpenList", "visible": false},
              {"command": "Report.Продажи.Command.Отчёт", "visible": true}
            ]
          }
        }
      ]
    }
  }
}
```

### Разместить команду и задать порядок в группе

Пример задаёт порядок группы, у которой его ещё нет. Если порядок уже
сохранён, `commands` перечисляет ровно его команды в новом порядке:
только что размещённую команду в сохранённый порядок группы так не добавить,
такой список отклоняется.
Сначала получи план этого изменения:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_apply_8ba7af26408e",
    "arguments": {
      "at": "main:Subsystem.Продажи",
      "ops": [
        {
          "op": "commandPlacement.set",
          "args": {
            "at": "main:Subsystem.Продажи.Interface",
            "items": [
              {
                "command": "Report.Продажи.Command.Отчёт",
                "group": "NavigationPanelImportant"
              }
            ]
          }
        },
        {
          "op": "commandOrder.set",
          "args": {
            "at": "main:Subsystem.Продажи.Interface.Group.NavigationPanelImportant",
            "values": {
              "commands": [
                "Report.Продажи.Command.Отчёт",
                "Catalog.Товары.StandardCommand.OpenList"
              ]
            }
          }
        }
      ]
    }
  }
}
```

Для исполнения передай `data.executionToken` из этого успешного плана:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_apply_8ba7af26408e",
    "arguments": {
      "executionToken": "<data.executionToken из успешного плана>"
    }
  }
}
```

### Порядок подсистем верхнего уровня

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_apply_8ba7af26408e",
    "arguments": {
      "at": "main:Configuration",
      "ops": [
        {
          "op": "subsystemOrder.set",
          "args": {
            "at": "main:Configuration",
            "values": {"subsystems": ["Subsystem.Продажи", "Subsystem.Склад"]}
          }
        }
      ]
    }
  }
}
```
