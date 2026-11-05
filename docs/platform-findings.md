# Что дал прогон платформенной части (после победы над песочницей)

Дата: 05.11.2026. unica 0.15.0-rc.1, `v8-runner` 0.15.3, платформа 8.3.27.2325
(с установленными компонентами `CSClient` + `CSServer` и рабочей лицензией).

## Итог

- `unica.run {op:"infobase.create"}` — **работает**: база создана за 12 с,
  конфигурация импортирована из `src`, в `actions.log` — `succeeded`.
- `unica.run {op:"push"}` — возвращает `mode: "skipped"`: менять нечего, потому
  что `infobase.create` уже загрузил конфигурацию из исходников.
- Перед этим пришлось вылечить две ошибки **в исходниках проекта**, которые
  платформа считает критичными. Обе — про качество генерируемого XML.

## Дефект 1: в `Configuration.xml` не было `InternalInfo`

Платформа отказывалась импортировать конфигурацию:

```
[ERROR] Файл - …\src/Configuration.xml, узел - Configuration:
        Отсутствует внутренняя информация (узел InternalInfo) для объекта Configuration
```

Пустой `<InternalInfo/>` платформу не устраивает — нужен узел с содержимым:
несколько `<xr:ContainedObject>` с парами `<xr:ClassId>` / `<xr:ObjectId>`.

**Как лечить правильно.** Не писать корень конфигурации руками. Есть два
работающих способа получить корректный узел:

1. Снять дамп с пустой базы платформой и взять блок оттуда:

```powershell
& ibcmd.exe infobase --db-path <tmp>\ib create --force
& 1cv8.exe DESIGNER "/F<tmp>\ib" /DumpConfigToFiles <tmp>\src -Format Hierarchical
```

   В `<tmp>\src\Configuration.xml` будет готовый `InternalInfo`; `ObjectId`
   можно заменить на свежие `randomUUID()`.
2. Либо создавать корень инструментом unica (навык `cf-init`), а не вручную.

Скрипт, которым это применено: `.dsh-cache\probe\apply-internalinfo.mjs`.

## Дефект 2: табличная часть несовместима с режимом совместимости

После починки `InternalInfo` платформа отвергла документ:

```
[ERROR] Документ.ПоступлениеТоваров.ТабличнаяЧасть.Товары -
        В режиме совместимости 8.3.26 и ниже длина номера строки должна быть равна 5
```

Причина: `unica.apply` с `tabularSection.add` создаёт табличную часть без
`LineNumberLength`, а корень конфигурации, созданный по сценарию, объявляет
`<CompatibilityMode>Version8_3_24</CompatibilityMode>`. Платформа такое сочетание
считает критичной ошибкой импорта.

**Что делать.** Одно из двух:

- поднять режим совместимости до `Version8_3_27` (сделано в этом прогоне —
  импорт прошёл);
- либо задать табличной части `LineNumberLength = 5`.

Похоже на дефект инструмента: `tabularSection.add` должен либо сам ставить
`LineNumberLength=5`, либо сценарий не должен объявлять совместимость 8.3.26-.
Кандидат на issue в апстрим.

## Состояние проекта после правок

```
src\Configuration.xml        InternalInfo из дампа, CompatibilityMode=Version8_3_27
src\Documents\…\Товары       InternalInfo на месте (создан unica), LineNumberLength отсутствует
build\ib\1Cv8.1CD            существует, конфигурация загружена
build\СценарнаяКонфигурация.cf  собран и проверен (96 017 байт)
```

## Платформенная часть сценария пройдена через инструменты сессии

После рестарта DSH с кэшем вне рабочего каталога:

| Шаг | Результат |
|---|---|
| `unica.run {op:"infobase.create"}` | база создана за 12 с, конфигурация импортирована |
| `unica.run {op:"push"}` | `mode: "skipped"` — менять нечего после create |
| `unica.run {op:"make", args:{output:"build/СценарнаяКонфигурация.cf"}}` | CF собран и независимо проверен: 96 017 байт, sha256 `b4953e3d…` |
| `unica.run {op:"launch", args:{clientMode:"designer"}}` | pid 17428, окно «Конфигуратор - Сценарная конфигурация», платформа 8.3.27.2325 |

Это закрывает разделы сценария 2 (база), 3.5 (сборка) и 7.3 (запуск клиента).

## Vanessa Automation: прогон сценарного теста прошёл

Скачано с GitHub: [`Pr-Mex/vanessa-automation`](https://github.com/Pr-Mex/vanessa-automation),
релиз **1.2.043.47**, ассет `vanessa-automation.1.2.043.47.zip`. Развёрнуто в
`tools/` проекта (44 МБ): сам `VanessaAutomation.epf` (19,5 МБ) и весь комплект —
`locales/`, `lib/`, `features/`.

**Важно:** класть рядом с обработкой нужно **весь комплект**, а не только `.epf`.
С одним файлом Vanessa падает на открытии формы:

```
Не получилось выполнить помещение файлов: …/tools/locales/Steps.epf …
Каталог не обнаружен '…/tools/locales/Steps.epf'
```

### Как запускается

`launch` с `execute` запускает обработку, но сценарии не поедут, пока в
`VAParams` не будет профиля клиента тестирования и флага выполнения. Рабочий
`va-params.json`:

```json
{
  "КаталогФич": "<проект>/features",
  "ПутьКVanessaAutomation": "<проект>/tools/VanessaAutomation.epf",
  "КлиентыТестирования": [{
    "Имя": "Тестовый",
    "ПутьКИнфобазе": "/F<проект>/build/ib",
    "ТипКлиента": "Тонкий",
    "ИмяКомпьютера": "localhost",
    "ПортЗапускаТестКлиента": "1538"
  }],
  "ВыполнитьСценарии": true,
  "ЗавершитьРаботуСистемы": "Истина",
  "ВыгружатьСтатусВыполненияСценариевВФайл": "Истина",
  "ПутьКФайлуДляВыгрузкиСтатусаВыполненияСценариев": "<проект>/build/va-status.json",
  "ИмяФайлаЛогВыполненияСценариев": "<проект>/build/va-run.log"
}
```

Запуск через порт:

```json
{ "op": "launch", "args": {
    "clientMode": "thin",
    "execute": "tools/VanessaAutomation.epf",
    "applicationParameter": "StartFeaturePlayer;VAParams=<проект>/va-params.json",
    "waitForExit": true,
    "waitTimeoutMs": 180000
} }
```

Результат: `launch waited for a thin session; it exited with code 0`,
`build/va-status.json` = `0`, в `build/va-run.log` — выполненный сценарий.

### Что пришлось поправить в фичах

Заготовка `features/ПоступлениеТоваров.feature` (написана с собственными
формулировками шагов) валит прогон:

```
Pending: Не найдена процедура или функция для выполнения шага:
         Дано открыта форма списка номенклатуры
```

Она убрана в `features-draft/`. Рабочая фича `features/smoke.feature` использует
только встроенные шаги Vanessa, поэтому проходит без реализаций:

```gherkin
# language: ru
Функционал: Дымовой прогон Vanessa Automation на сценарной конфигурации

  Сценарий: Среда исполнения отвечает
    Дано текущее время в диапазоне от "00:00:00" до "23:59:59"
    И я удаляю все переменные
```

Чтобы вернуть содержательный тест, нужны `features/step_definitions/*.bsl` с
реализацией наших шагов (или переписать фичу на встроенные шаги Vanessa).

## `unica.check` по BSL: сначала казалось дефектом, оказалось нет

Первый вызов `unica.check` на модуле после старта сервера вернул:

```
BSL analysis did not complete, so the module is unproven:
bsl-analyzer: diagnostic provider did not produce a result for an unclassified reason.
Repeat the call; if the problem persists, report this reason.
```

Отсюда я сначала сделал вывод «апстрим сломан». Это неверно. Повторный вызов дал
настоящую диагностику:

```
validators: ["bsl"], diagnosticCount: 1
code: CommonModuleInvalidType, severity: error
message: Общий модуль должен быть одного из типов: Server, ServerCall, Client, ClientServer
```

То есть валидатор реализован и работает; первый вызов — это состояние прогрева
индекса (то же самое, что `unica.search` с `detailCode: "buildingIndex"`), и само
сообщение предлагает повторить вызов.

**И диагностика верная.** По стандарту 1С серверный общий модуль — это набор
`Server + ExternalConnection + Client (обычное приложение)`, а не один `Server`.
Наш модуль создавался через `unica.apply` с одним `Server: true`, платформа такое
съела при импорте, а `bsl-analyzer` поймал нарушение стандарта.

Исправлено тем же инструментом:

```json
{ "at": "main:CommonModule.ЮТ_Тесты", "ops": [
  { "op": "props.set", "args": { "values": {
      "Server": true, "ExternalConnection": true, "ClientOrdinaryApplication": true } } } ] }
```

После публикации: `unica.check` → `status: "passed"`, `validators: ["bsl"]`,
`diagnosticCount: 0`.

## Что осталось по сценарию

- YaXUnit: запуск тестов на поверхности 0.13/0.15 не опубликован; авторинг
  тестовой процедуры и её поиск проверены ранее.



