---
name: cf-init
description: Создать пустую конфигурацию 1С (scaffold XML-исходников). Используй когда нужно начать новую конфигурацию с нуля
argument-hint: <Name> [-Synonym <name>] [-OutputDir src]
allowed-tools:
  - Bash
  - Read
  - Glob
---

# /cf-init — Создание пустой конфигурации 1С

## MCP routing

- **Канонической операции создания конфигурации на поверхности нет.** Словарь
  `mcp__unica__unica_apply_8ba7af26408e` правит существующий узел: `object.create` заводит объект
  метаданных **внутри** конфигурации, но самого корня `Configuration.xml` не
  создаёт.
- Не зови внутренние адаптеры напрямую: они спрятаны за MCP `unica`.
- Готовность проверяет `mcp__unica__unica_check_6db7d2a7495f`, результат читает `mcp__unica__unica_view_6f3a42290cc8` по адресу.

Поэтому корень новой конфигурации формируется файловыми средствами по формату
ниже — тем же порядком, каким заводится `v8project.yaml`
(`DEC.2026-09-09.PROJECT-CONFIG-IS-HANDWRITTEN`):

1. записать `Configuration.xml` и обязательные `Ext/`;
2. объявить набор в `v8project.yaml` и убедиться в допуске: `mcp__unica__unica_check_6db7d2a7495f {}`;
3. прочитать корень: `mcp__unica__unica_view_6f3a42290cc8 {at: "<набор>:Configuration"}`;
4. дальше объекты заводит `mcp__unica__unica_apply_8ba7af26408e` (`object.create`, `props.set`).

Если нужна именно операция создания корня — это пробел контракта Unica MCP;
сообщи о нём, а не подменяй его правкой чужой конфигурации.

## Примеры

### Базовая конфигурация

Поля, которые должен нести записанный файл:

```json
{
  "Name": "МояКонфигурация",
  "Synonym": "Моя конфигурация",
  "OutputDir": "test-tmp/cf"
}
```

### С версией и поставщиком

Поля, которые должен нести записанный файл:

```json
{
  "Name": "TestCfg",
  "Synonym": "Тестовая",
  "Version": "1.0.0.1",
  "Vendor": "Фирма 1С",
  "OutputDir": "test-tmp/cf2"
}
```

### Другой режим совместимости

Поля, которые должен нести записанный файл:

```json
{
  "Name": "TestCfg",
  "CompatibilityMode": "Version8_3_27",
  "OutputDir": "test-tmp/cf3"
}
```

## Верификация

После создания проверь каталог конфигурации через MCP `unica` read-only инструменты.

### Проверить созданную структуру

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_view_6f3a42290cc8",
    "arguments": {
      "at": "main:Configuration"
    }
  }
}
```

### Валидировать XML конфигурации

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_check_6db7d2a7495f",
    "arguments": {
      "at": "<sourceSet>:Configuration"
    }
  }
}
```
