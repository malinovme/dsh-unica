# Сценарий приёмки порта на реальных операциях (Unica 0.13 → 0.15 + 1С 8.3.27)

Продолжение [port-check.md](port-check.md): там проверялся контракт поверхности,
здесь — порт на живых операциях: проект, база, метаданные, справка, поиск по коду,
юнит-тесты YaXUnit и сценарные тесты Vanessa. Сценарий писался под 0.13 и целиком
пройден на 0.15.0-rc.1; результат — в [platform-findings.md](platform-findings.md)
и [run-report.md](run-report.md).

Каждый шаг: что зовём, что должно прийти, критерий провала и **чей это гейт**.
Шаги, заблокированные тулчейном, помечены `BLOCKED-BY-TOOLCHAIN` — они проходят
только после того, как порт доставит артефакты движков (контракт вскрыт, §10;
реализация ещё не сделана).

---

## 0. Предусловия

| Что | Как проверить | Сейчас на машине |
|---|---|---|
| 1С:Предприятие 8.3.27 | `C:\Program Files\1cv8\8.3.27.2325\bin\1cv8.exe` | есть |
| `unica` рантайм 0.13.0 | `unica.view {}` отвечает `sourceSets` | есть |
| `bsl-analyzer` / `rlm-bsl-*` | `unica.search {role:"symbol"}` по известному символу | доставляются, см. §10 |
| `v8-runner` 0.14.0 | `unica.run {op:"infobase.create", args:{}, dryRun:true}` | доставляется, см. §10 |
| Лицензия 1С | первый `push` / `launch` | не проверялась |

Проверка движков — шаг 1.4. Пока `UNICA_ARTIFACT_CACHE` не выставлен (см. §10),
сценарий отвечает точным, но бесполезным для чтения текстом:

```json
{"code":"provider_unavailable","detailCode":"provider_absent",
 "message":"bundled_tool_missing: v8-runner is not on this machine for win-x64
 (expected at <runtime>/bin/win-x64/v8-runner); it is delivered by the next call
 that needs v8-runner; reinstall the Unica plugin if it never arrives"}
```

Адрес пространства: рабочее пространство берётся из каталога запуска MCP-сервера,
аргумента `cwd` нет. Если сервер перезапускается переподключением, каталог может
смениться на профиль — тогда нужен `UNICA_WORKSPACE_ROOT` (см. README порта).

---

## 1. Проект и допуск набора

**1.1 Каталог и `v8project.yaml`.** Инструмента создания проектного файла нет —
пишем файловыми средствами:

```yaml
workPath: 'build'
format: DESIGNER
source-set:
  - name: main
    type: CONFIGURATION
    path: 'src'
```

**1.2 Скелет конфигурации.** Тоже руками: `src/Configuration.xml` (с
`DefaultLanguage`, иначе `props.set` и `object.create` откажутся) и
`src/Languages/Русский.xml`.

**1.3 Допуск набора.**

```
unica.check {}
→ data.status: "passed", data.ready: true, data.sourceSets[0].name: "main"
```

Провал: `ok:false` + `invalid_state` про отсутствующий PlatformXml.
Замечание: вердикт `status:"passed"` приходит и рядом с диагностикой
`severity:"error"` (например, `git.inspection_incomplete`) — читать `diagnostics`,
а не только `status`.

**1.4 Детектор движков.** До любых операций с базой и BSL прогнать:

```
unica.check { at: "main:CommonModule.Тестовый" }            → BSL: passed | provider_unavailable
unica.run { op: "infobase.create", args: {}, dryRun: true } → v8-runner: plan | bundled_tool_missing
```

---

## 2. База 1С — `BLOCKED-BY-TOOLCHAIN`

**2.1 Создать базу.** `unica.run {op:"infobase.create", args:{}, dryRun:true}` —
превью плана, `dryRun:false` — создание. Файловая база создаётся с основной
конфигурацией проекта.

**2.2 Загрузить исходники.** `unica.run {op:"push", args:{}, dryRun:true}`, затем
`dryRun:false`. Перед загрузкой раннер сверяет поколение ИБ и отказывает
`non_fast_forward` / `no_memory` — `force:true` не ставить самовольно, это выбор
пользователя.

**2.3 Открыть конфигуратор.** `unica.run {op:"launch", args:{clientMode:"designer"}}`.

Критерий: после 2.2 в `build/` появилась файловая ИБ, `push` вернул
`loadedSets`, а `launch` открыл сеанс. Превью 2.1 проверено разведкой (§10):
с доставленным `v8-runner` приходит план `action:"create"`, `requiresPlatform:true`.
Полный прогон упирается только в нереализованную доставку артефактов в порте.

---

## 3. Метаданные

Все изменения — только `apply`: сначала план с `at`+`ops`, потом исполнение по
`executionToken`. Перед операцией полезно спросить словарь узла:

```
unica.view { at: "main:Configuration", filter: { sections: ["can"] } }
```

**3.1 Справочник с реквизитами.**

```jsonc
unica.apply { at: "main:Configuration", ops: [
  { op: "object.create", args: { values: { kind: "Catalog", name: "Номенклатура" } } } ] }
// → plan: data.executionToken; затем unica.apply { executionToken }

unica.apply { at: "main:Catalog.Номенклатура", ops: [
  { op: "props.set", args: { values: { Comment: "Справочник номенклатуры" } } },
  { op: "attribute.add", args: { items: [
      { name: "Артикул",
        type: { variants: [ { kind: "string", length: 50, allowedLength: "variable" } ] } },
      { name: "Цена", type: { variants: [ { kind: "decimal", precision: 15, scale: 2 } ] } } ] } } ] }
```

Ожидание: `view` по справочнику даёт ветку `Attribute` с нужным `count`, а
`check` — `validators:["meta"]`, `status:"passed"`.

**3.2 Документ с движениями.** `object.create` `{kind:"Document", name:"ПоступлениеТоваров"}`,
затем `tabularSection.add` (товары), `attribute.add` (даты/суммы), и связь с
регистром через `relation.add`.

**3.3 Регистр накопления.** `object.create` `{kind:"AccumulationRegister", name:"ОстаткиТоваров"}`,
`dimension.add` (Номенклатура), `resource.add` (Количество, Сумма).

**3.4 Перечисление, роль, подсистема.** `Enum` + `enumValue.add`; `Role` +
`role.set` прав; `Subsystem` + включение объектов (`relation`/`props.set`).

**3.5 Форма и СКД.** `form.add` для справочника; `object.create` `{kind:"Report"}` +
`dcs`-операции для схемы компоновки (навыки `form-compile`, `dcs-compile`).

**3.6 Макет.** `template.add` + `mxl`-операции (навык `mxl-compile`).

Критерий всего раздела: после каждого цикла «план → токен» файл на диске
изменился, а `unica.view` по адресу показывает новое состояние. Провал —
план не принимается (`bad_value` с полем в `diagnostics[].message`) или `view`
не находит только что созданное.

---

## 4. Справка платформы

`unica.docs` — это **поиск по документации 1С** (platform-help, стандарты v8std,
kb.1ci), а не справочник контрактов инструментов.

**4.1 Асинхронный ответ.** Первый вызов может вернуть задачу:

```jsonc
unica.docs { query: "Справочник.Записать", limit: 3 }
→ data.task.taskId, next: [{ tool: "unica.task.result", args: { taskId, waitMs: 7000 } }]
unica.task.result { taskId: "...", waitMs: 7000 }   // повторять до status != "working"
```

**4.2 Что считать результатом.** `data.sections[]`: у каждой `provider`,
`status` (`ok` / `unavailable`), `matches.relation` и `hits[]`. Провайдер
`kb-1ci` на этой машине недоступен (таймаут `os error 10060`) — это норма для
закрытой сети, но вызов висит десятки секунд.

Критерий: пришёл хотя бы один `ok`-провайдер с непустыми `hits`; в поле
`searchComplete` честно отражено, полон ли поиск.

---

## 5. Поиск по коду и разбор

**5.1 Текстовый поиск — только BSL.**

```jsonc
unica.search { query: "Записать", corpus: "text" }          // модули
unica.search { query: "Записать", corpus: "text", role: "symbol" }   // индекс символов
unica.search { query: "Записать", corpus: "text", role: "semantic" } // по смыслу
```

Важно: имя реквизита (`Артикул`) в `corpus:"text"` **не находится** — это не BSL.
Для метаданных:

```jsonc
unica.search { query: "Номенклатура", corpus: "names", kind: "Catalog" }
→ matches: [{ at: "main:Catalog.Номенклатура", kind: "Catalog", title: "Номенклатура" }]
```

Критерий: попадания приходят с логическими адресами, `fileCoverage.complete`
описывает покрытие, а провайдер сообщает `freshness`.

**5.2 Сравнение узлов.**

```jsonc
unica.diff { left: "main:Catalog.Номенклатура", right: "main:Catalog.Архив" }
→ data.equal: false, changes: [{ path: "/props/synonym", left: ..., right: ... }]
```

---

## 6. Юнит-тесты YaXUnit

На поверхности v0.13 **нет операции запуска тестов** — есть только правка
исходников. Поэтому сценарий проверяет авторинг и доступность тестов в коде, а
исполнение остаётся отдельным шагом (клиент 1С / внешняя обработка).

**6.1 Модуль тестов.** Создать `CommonModule` `ЮТ_Тесты` (сервер, `ServerCall`,
без клиента) и пакет `ОбщиеМодули` в подсистеме, которую грузит YaXUnit.

**6.2 Тестовый метод.**

```bsl
Процедура ТестУдвоение() Экспорт
	Утверждения.Равно(2, Удвоить(1), "Удвоить(1)");
КонецПроцедуры
```

Правка модуля — `apply` с операциями кода (см. навык `code-patch`) либо
файловыми средствами с последующим `unica.check` на узле модуля.

**6.3 Конфигурация запуска.** В `src/` появляются служебные объекты YaXUnit
(`ОбщиеМодули`, `Обработки`-раннер, `ПланыОбмена` при необходимости) —
приемлемо только как внешние исходники, без генерации имён вручную.

Критерий: `unica.view` по модулю тестов показывает метод в ветке `Method`; для
поиска по тестовому коду работает `unica.search {role:"symbol"}` (проверено,
§10). `unica.check` по модулю работает: первый вызов после старта сервера может
вернуть «BSL analysis did not complete … Repeat the call» (прогрев индекса), а
повторный отдаёт настоящие диагностики `validators: ["bsl"]`. Написанный по
сценарию модуль получил `CommonModuleInvalidType` — серверному общему модулю
нужны `Server + ExternalConnection + Client (обычное)`; после `props.set`
проверка стала `passed` (подробности — в
[platform-findings.md](platform-findings.md)).

**6.4 Запуск (вне поверхности).** Варианты на будущее: `unica.run launch` с
`execute` внешней обработкой-раннером (`waitForExit`, `waitTimeoutMs`) —
требует доставленного `v8-runner` (контракт в §10) и лицензии 1С.

---

## 7. Сценарные тесты Vanessa

**7.1 Фича лежит в исходниках** как обычный файл (`features/`, `*.feature`) и в
git; MCP-операции её не создают.

**7.2 Шаги.** Vanessa-шаги — это экспортные процедуры в общем модуле; пишутся
тем же путём, что и 6.2, и проверяются `unica.check`.

**7.3 Запуск.** Через `unica.run launch` (`clientMode:"thin"`, `execute` = epf
Vanessa) — `BLOCKED-BY-TOOLCHAIN` до реализации доставки `v8-runner` в порте
(§10) и при наличии лицензии 1С.

Критерий приёмки (после доставки раннера): сеанс открывается, отчёт Vanessa
содержит `passed` по сценарию, `failed: 0`.

---

## 8. Матрица приёмки

| № | Шаг | Инструмент | Pass | Fail = |
|---|---|---|---|---|
| 1.3 | Допуск набора | `check {}` | `ready:true`, `sourceSets[0].name="main"` | `invalid_state` про PlatformXml |
| 3.1 | Справочник + 2 реквизита | `apply` + `view` | ветка `Attribute`, `count=2` | план отвергнут, узел не найден |
| 3.2–3.6 | Документ, регистр, роль, форма, макет | `apply` + `view` | файлы на диске, `view` видит узел | `bad_value` без поля |
| 4.2 | Справка | `docs` + `task.result` | ≥1 провайдер `ok` с `hits` | все `unavailable` |
| 5.1 | Поиск BSL | `search text` | попадания с адресами | пусто при заведомо существующем коде |
| 5.1 | Поиск метаданных | `search names` | `matches[].at` | пусто |
| 5.2 | Diff | `diff` | `equal:false` + `changes` | ошибка адреса |
| 6.3 | Модуль тестов | `view` + `search symbol` | метод виден, поиск находит | `provider_unavailable` в `check` (апстрим) |
| 2.x, 7.3 | База и запуск | `run` | план/сеанс | `bundled_tool_missing` (порт не доставил артефакты) |

---

## 9. Гигиена прогона

- Песочница: демон `unica` наследует файловую песочницу хоста. Каталог вне
  рабочего пространства недоступен — публикация падает `Отказано в доступе
  (os error 5)`.
- Временный каталог: часть проверок (`repository.ignore`) пишет в
  `%LOCALAPPDATA%\Temp` и при запрете даёт `git.inspection_incomplete` — не
  ошибка конфигурации, а ограничение окружения.
- `executionToken` не одноразовый: повтор возвращает сохранённый успех. В
  сценарии всегда планировать заново, а не повторять токен.
- Каждый шаг с записью заканчивать `check` и чтением узла — это ловит почти все
  расхождения формата.

---

## 10. Тулчейн: контракт вскрыт, осталась одна щель

**Ответ найден разведкой.** Доставку не делает рантайм, и она не требует бутстрапа.
Работает всё это вместе:

1. **Кэш артефактов по стандартной раскладке** (её строит `unica-bootstrap prefetch`):

   ```
   <cache>/unica/<version>--<asset.sha256>/<target>/bin/win-x64/unica.exe
   <cache>/bsl-analyzer/0.2.86--<sha>/<target>/bsl-analyzer.exe
   <cache>/rlm-tools-bsl/1.42.0--<sha>/<target>/payload/…
   <cache>/v8-runner/0.14.0--<sha>/<target>/v8-runner-windows-x86_64/v8-runner.exe
   ```

2. **Переменная `UNICA_ARTIFACT_CACHE=<cache>`** — вот недостающее звено. Именно она
   переключает поиск движков с «внутри своего бандла» на кэш артефактов. Без неё
   любые ручные копии бесполезны, а текст ошибки врёт: он указывает на
   `<runtime>/bin/win-x64/v8-runner`, куда ничего класть не надо.

Доказательства прогоном (рантайм из официального префетча, чистый демон):

| Проверка | Без `UNICA_ARTIFACT_CACHE` | С ней |
|---|---|---|
| `unica.run {op:"infobase.create", dryRun:true}` | `bundled_tool_missing: v8-runner` | **`ok`, план: `action:"create"`, `requiresPlatform:true`** |
| `unica.search {query:"Удвоить", role:"symbol"}` | `provider_unavailable` | **`ok`: `CommonModule.Тестовый.Module`, строки 1–7, `indexFreshness`, `[L] semantic disabled`** |
| `unica.check` на модуле | `BSL analysis did not complete` | `BSL analysis did not complete` (в 0.13) |

**Про `check` на модуле: сначала показалось, что сломано.** В 0.13 первый вызов
отдавал generic `provider_unavailable` без `detailCode`, и это выглядело как
неотданный фикс (#1338/#1365). На 0.15.0-rc.1 сообщение стало другим —
`bsl-analyzer: diagnostic provider did not produce a result … Repeat the call
… report this reason`, — а **повторный вызов вернул настоящую диагностику**:

```
validators: ["bsl"], code: CommonModuleInvalidType
message: Общий модуль должен быть одного из типов: Server, ServerCall, Client, ClientServer
```

Значит валидатор реализован и работает, а первый вызов — прогрев индекса (то же,
что `search` с `detailCode: "buildingIndex"`). Диагностика оказалась верной:
серверному общему модулю нужны `Server + ExternalConnection + Client (обычное)`,
а не один `Server`. После `props.set` проверка стала `passed`. Подробности — в
[platform-findings.md](platform-findings.md).

История с #1365 при этом полезна как таковая: она объясняет, почему в 0.13
причина не называлась, но к текущему поведению уже не относится.


**Что уже сделано в порте** (проверено прогоном, не только кодом):

1. `runtime-manifest.json` переведён на `schemaVersion: 2` с секцией `artifacts`
   — не руками: `node tools/build-runtime-manifest.mjs` собирает его из
   `third-party/tools.lock.json`, а `--check` валит CI, если манифест отстал.
2. `bootstrap/launch.mjs` ставит ядро и движки в стандартную раскладку
   `<cache>/<name>/<version>--<assetSha>/<target>/`: скачивание, сверка SHA-256
   ассета, распаковка (zip через `tar`/`unzip`, tar.gz через `tar`), маркер
   `.ready.json`, публикация переименованием. Брошенные скретч-каталоги
   подчищаются на старте.
3. Серверу выставляется `UNICA_ARTIFACT_CACHE=<cache>` — то самое недостающее звено.
4. Ленивость: ядро и `v8-runner` доставляются сразу, остальные — фоном
   (`UNICA_ARTIFACT_DELIVERY=background|eager|off`), чтобы старт не ждал 150 МБ.
5. `tools/verify-bridge.mjs` получил кейсы «подпись не сошлась → отказ и пустой
   кэш», «ассета нет → отказ с URL», «каталог закреплён» и живой гейт движков
   (`UNICA_TEST_ENGINES=1`): `bsl-analyzer` отвечает на символьный поиск,
   `v8-runner` — на `infobase.create`.

Проверка одной командой (нужен кэш с доставленными движками):

```sh
UNICA_TEST_ENGINES=1 UNICA_TEST_WORKSPACE=<проект с BSL-модулем> node tools/verify-bridge.mjs
```

Доставка на этой машине заняла 25 с и 330 МБ кэша; повторные запуски её не
касаются.

**Почему это укладывается в инварианты порта.** Бинари не попадают в репозиторий и
в пакет: они скачиваются в кэш при первом запуске, как уже делает `prefetch`
апстрима. Значит AGPL у `v8-runner` и LGPL у `bsl-analyzer` не превращаются в
обязательства распространения — в отличие от варианта «вендорить бутстрап».

**Что осталось непроверенным.** Только запуск YaXUnit: операции, запускающей
тесты, на поверхности 0.13/0.15 нет. `push`, `launch` и BSL-диагностика
проверены — см. [platform-findings.md](platform-findings.md).
