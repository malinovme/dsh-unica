---
name: code-patch
description: Точечно вставить или заменить BSL-код в логически адресованном модуле XML-выгрузки Configuration или Extension 1С. Используй для одной проверяемой операции insert или replace.
argument-hint: <at> <insert|replace> <text>
allowed-tools:
  - Read
  - Glob
---

# /code-patch — безопасная вставка и замена BSL

## MCP routing

- Preferred path: use MCP `unica` tool `mcp__unica__unica_apply_8ba7af26408e` с операциями
  `code.insert` и `code.replace`.
- Do not call internal MCP/CLI adapters directly. They are hidden behind
  `unica` and synchronized by the orchestrator.
- Сначала вызови `mcp__unica__unica_apply_8ba7af26408e` с `at` и `ops`: это план без записи.
  Когда пользователь поручил внести эту правку, вызови `mcp__unica__unica_apply_8ba7af26408e` только
  с `executionToken` из `data.executionToken` успешного плана.

**Селектор — это адрес.** Отдельного `selector` с `method` или `anchor` нет:
что править, называет `args.at`. У объекта с несколькими модулями роль входит в
адрес: узел метода — `…Module.Object.Method.<Имя>`, тело модуля целиком —
`…Module.Object.Body`. Общий модуль сам себе модуль, и сегмента роли у него нет
вовсе: `CommonModule.<Имя>.Method.<Имя>` и `CommonModule.<Имя>.Body`. Адрес и
точнее селектора, и переживает переименование файла, и уже проверен чтением.

Правится модуль существующего объекта метаданных в допущенном наборе
исходников формата платформы. Физический путь к `*Module.bsl` остаётся
внутренней деталью: наружу его отдаёт только аварийный `mcp__unica__unica_resolve_55e2d51be222`, и в
обычном ходе работы он не нужен. Создать объект метаданных, удалить модуль
целиком, править EDT или внешние файлы, синхронизировать исходники с базой
этим путём нельзя.

Если правку нельзя выразить одной безопасной операцией, остановись: прочитай
предмет через `mcp__unica__unica_view_6f3a42290cc8 {at}` на узле модуля — ветвь `Method` перечисляет
методы, ветвь `Body` отдаёт строки парами `{line, text}` — и вернись с более
узкой операцией.

## Операции

| Операция | Что делает | `args` |
|---|---|---|
| `code.insert` | Вставляет текст в узел по адресу | `at`, `text` |
| `code.replace` | Заменяет содержимое узла по адресу | `at`, `text` |

Несколько операций одного вызова применяются как одна правка: либо все, либо
ни одной.

У заимствованного объекта расширения запись BSL также подключает модуль:
недостающее состояние `PropertyState` добавляется в дескриптор той же
транзакцией. Предпросмотр показывает обе правки. Уже установленное состояние
сохраняется; несовместимое состояние вызывает отказ до записи. После
применения проверь расширение через `mcp__unica__unica_check_6db7d2a7495f {at: "ext:Configuration"}`,
подставив имя своего набора исходников.

## Порядок

1. Найди адрес: `mcp__unica__unica_search_a8644a757dff {corpus: "names"}` по имени объекта, затем
   `mcp__unica__unica_view_6f3a42290cc8 {at}` вниз по ветвям `Module` и `Method`.
2. Прочти предмет: `mcp__unica__unica_view_6f3a42290cc8 {at}` на узле метода даёт подпись, контекст
   компиляции и собственные строки.
3. Предпросмотр: `mcp__unica__unica_apply_8ba7af26408e` с `at` и `ops`. Ответ несёт план правки и
   токен `data.executionToken`.
4. Применение: вызов только с `executionToken` из успешного плана.
   Исполнитель использует сохранённую транзакцию и проверяет её входы.
   После `stale_revision` получи новый план; изменение файла вне входов плана
   не мешает исполнению.
5. Проверка: `mcp__unica__unica_check_6db7d2a7495f {at}` на модуле. Новые находки важности `error`
   блокируют.

## MCP examples

### Предпросмотр замены тела метода

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_apply_8ba7af26408e",
    "arguments": {
      "at": "main:CommonModule.Пример",
      "ops": [
        {
          "op": "code.replace",
          "args": {
            "at": "main:CommonModule.Пример.Method.Выполнить.Body",
            "text": "    Возврат Истина;"
          }
        }
      ]
    }
  }
}
```

### Исполнение сохранённого плана

Сначала получи план этого изменения:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_apply_8ba7af26408e",
    "arguments": {
      "at": "main:CommonModule.Пример",
      "ops": [
        {
          "op": "code.insert",
          "args": {
            "at": "main:CommonModule.Пример.Body",
            "text": "Процедура Выполнить() Экспорт\nКонецПроцедуры"
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
