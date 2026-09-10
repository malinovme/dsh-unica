---
name: source-access
description: Найти логическую цель 1С, восстановить адрес по пути в исходнике и безопасно исследовать снимок ресурсов через MCP Unica
argument-hint: <sourceSet> [metadataPath|path] <resolve|inspect|locate>
allowed-tools:
  - Read
  - Glob
---

# /source-access — логическая навигация и чтение исходников

## MCP routing

- Preferred path: сначала выбери предметный writer MCP `unica`. Для точечной
  вставки BSL используй `mcp__unica__unica_code_patch_539ea6e2f208`; для формы, DCS, MXL, роли,
  подсистемы или метаданных — соответствующий `unica.*.edit` либо
  `unica.*.compile`.
- Для поиска цели используй `mcp__unica__unica_source_resolve_bbc823735283` или
  `mcp__unica__unica_source_children_adf91626cfe3`. Для исследования уже выбранной цели используй
  `mcp__unica__unica_source_resources_28044f5b01ae`, затем `mcp__unica__unica_source_read_6993a0a71af1`.
- Когда на руках физический путь — из `mcp__unica__unica_code_search_70af4c0986a7`, из диффа, из лога
  сборки — переведи его в логический адрес через `mcp__unica__unica_source_locate_90d2dfe965b7`, а не
  выводи адрес из раскладки каталогов вручную. `locate` отвечает и владельцем
  файла: для модуля это его объект метаданных, для содержимого формы — сама
  форма. Отказ типизирован: `outsideSourceSet`, `notAddressable` или
  `ownerUnproven`.
- Ресурсная группа доступна только на чтение. Изменение BSL выполняет
  `mcp__unica__unica_code_patch_539ea6e2f208`: `operation: "insert"` добавляет текст у селектора,
  `operation: "replace"` переписывает выбранный метод либо вхождение якоря.
  Он правит выбранный участок, а не переписывает модуль целиком, поэтому
  подходит и для модулей, которые не поместились бы в один запрос.
- Не вызывай внутренние MCP/CLI-адаптеры и не подменяй логическую цель
  физическим путём. Все операции идут через один MCP `unica`.

## Порядок работы

1. Выбери точный `sourceSet`. Разреши английский или русский запрос через
   `mcp__unica__unica_source_resolve_bbc823735283`; при исследовании дерева обойди один уровень через
   `mcp__unica__unica_source_children_adf91626cfe3`.
   - Вид цели задаёт число сегментов адреса: `Document.ЗаказКлиента` — объект,
     `Document.ЗаказКлиента.ObjectModule` — модуль. Прикладное имя, совпадающее
     с названием роли, объект в модуль не превращает.
   - Корень набора исходников адресуется отсутствием `metadataPath`, а корневые
     модули приложения — голым терминалом, например `ManagedApplicationModule`.
   - В `mode: "prefix"` неполным может быть только канонический английский
     токен: `Doc`, `Su` и `Man` работают, `Документ` работает целиком, а
     неполный псевдоним вроде `Док` отклоняется — у него нет единственной
     канонической формы.
2. Открой `mcp__unica__unica_source_resources_28044f5b01ae` с точным `sourceSet` и `metadataPath`, когда
   выбранная цель находится ниже корня набора исходников. Манифест сообщает
   роль, размер, хеш и профиль текста; `access` всегда содержит только `read`.
3. Читай ресурс через `mcp__unica__unica_source_read_6993a0a71af1` фрагментами до объявленного
   `limits.maxReadBytes`. Сохрани `snapshotId`, `resourceId`, полный `hash`,
   `bomPrefixBytes` и профиль EOL. Продвигайся на возвращённый `length`, а не
   на запрошенный `limit`: фрагмент текстового ресурса усекается до ближайшей
   границы UTF-8, поэтому он бывает короче лимита. `contentEncoding: "base64"`
   означает точные байты, а не текст, который можно молча перекодировать. У
   текстового ресурса он остаётся как минимум там, где лимит уже одного символа
   и где `offset` задан внутри многобайтового символа: `offset` адресует байты,
   а не символы. Всегда смотри на возвращённый `contentEncoding`, а не
   предполагай его.
4. Изменение вноси через `mcp__unica__unica_code_patch_539ea6e2f208` с `dryRun: true`, проверь diff,
   диапазоны и BSL-валидацию, и только затем повтори с `dryRun: false`.

## Предпросмотр правки

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "mcp__unica__unica_code_patch_539ea6e2f208",
    "arguments": {
      "cwd": "<workspace>",
      "sourceSet": "main",
      "metadataPath": "CommonModule.SourceAccessExample.Module",
      "operation": "replace",
      "selector": { "method": "BeforeReplacement" },
      "content": "Procedure BeforeReplacement()\n\t// новое тело\nEndProcedure",
      "dryRun": true
    }
  }
}
```

После подтверждения повтори те же аргументы с `dryRun: false`; изменение
селектора или содержимого требует нового предпросмотра.
