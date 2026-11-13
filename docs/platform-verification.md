# Проверка записи и платформенных операций

Расширенный сценарий: метаданные, формы, СКД, роли, перехватчики, сборка
артефактов и обмен с информационной базой. В отличие от
[native-verification.md](native-verification.md), здесь нужны:

- установленная платформа 1С (проверено на 8.3.27.2325, Windows, x64) и
  активированная лицензия — либо готовая файловая база;
- проект с исходниками в формате `DESIGNER` (`v8project.yaml` + `src/`);
- запас времени: первый платформенный вызов поднимает служебные каталоги
  `ibcmd` и занимает десятки секунд.

Проверка идёт по возрастанию цены: сначала то, что не трогает платформу, потом
сборка, потом база.

---

## 0. Подготовка проекта

`v8project.yaml` этой ревизии принимает только актуальные ключи:

```yaml
workPath: 'build'
format: DESIGNER
infobase:
  connection: 'File=build/ib'
source-set:
  - name: main
    type: CONFIGURATION
    path: 'src'
  - name: ext
    type: EXTENSION
    path: 'ext'
```

Ключи прежних ревизий отвергаются на первом же `unica.run` — по одному за вызов,
с `invalid_source` / `fixSource`:

| Ключ | Сообщение |
|---|---|
| `execution_timeout` | `not supported by v8-runner 0.15: a command has no overall deadline, only individual steps do` |
| `build.partialLoadThreshold` | `not supported by v8-runner 0.15: … a full load is requested with push full:true` |
| `builder` | `the executor is chosen per operation; name one with providers.<operation>` |

Диагностики точные, но проект, перенесённый со старой ревизии, придётся править
трижды — проверьте конфиг до прогона.

---

## 1. Запись метаданных

Платформа не нужна: это работа с исходниками.

1. `unica.apply` с `object.create` (например, `Catalog`) возвращает
   `data.executionToken`, **на диске ничего не меняется**.
2. `unica.diff` с этим токеном показывает точные байты до и после — без публикации.
3. Повторный `unica.apply` только с токеном публикует изменения: появляются
   `src/Catalogs/<Имя>.xml`, `Catalogs/<Имя>/Ext/ObjectModule.bsl`, запись в
   `<ChildObjects>` корня.
4. `unica.check` по объекту — `status: passed`, `validators: ["meta"]`.

**Контракт типов.** Схема `rc.5`: число —
`{"kind": "number", "digits": 15, "fraction": 2, "sign": "any"}`; вариант
`decimal` с `precision`/`scale` больше не принимается. Схему не угадывайте:
читайте `<узел>.Can.<операция>` — иначе ошибка будет `unsupported type kind` или
`` `digits` must be an unsigned 32-bit integer ``.

Второй реквизит в том же плане (`attribute.add`) добавляется одной транзакцией с
созданием объекта — адрес нового узла в том же вызове уже работает.

---

## 2. Формы

`form.add` на объекте-владельце создаёт форму и сам заводит главный реквизит
`Объект` (`CatalogObject.<Имя>`, `MainAttribute: true`), а также заполняет
`DefaultObjectForm` владельца, если слот пуст:

```json
{"op": "form.add", "args": {"items": [{"name": "ФормаЭлемента", "type": "ObjectForm"}]}}
```

`item.add` на адресе формы добавляет поля; `path` — путь от реквизита:

```json
{"op": "item.add", "args": {"items": [
  {"name": "Артикул", "type": "InputField", "path": "Объект.Артикул", "title": "Артикул"}]}}
```

Результат: `Catalog.<Имя>/Forms/ФормаЭлемента.xml`, `Ext/Form.xml`,
`Ext/Form/Module.bsl`; `unica.check` на форме — `validators: ["form"]`, `passed`.

---

## 3. СКД

Схема — макет отчёта вида `DataCompositionSchema`:

```json
{"op": "template.add", "args": {"items": [
  {"name": "ОсновнаяСхемаКомпоновкиДанных", "templateType": "DataCompositionSchema"}]}}
```

`template.add` создаёт локальный источник `ИсточникДанных1` и вариант настроек
«Основной». Набор данных — отдельной операцией:

```json
{"op": "dataSet.add", "args": {"items": [
  {"name": "НаборДанных1", "kind": "Query", "dataSource": "ИсточникДанных1",
   "query": "ВЫБРАТЬ 1 КАК Сумма"}]}}
```

`unica.check` на макете — `validators: ["dcs"]`, `passed`. Остальные операции
схемы видны в `can` макета: `dataSource.add`, `parameter.add`, `total.add`,
`calculatedField.add`, `variant.add`, `dataSetLink.*`.

Замечание по качеству вывода: генератор СКД пишет объявления `xmlns` на каждом
вложенном элементе (в прогоне — 16 объявлений на 10 элементов в 1,3 КБ). XML
корректен, платформа его принимает, но файл читается хуже выгрузки Конфигуратора.

---

## 4. Роли, перехватчики, атомарность

Это тоже чистая работа с исходниками; проверяется без базы.

**Роли.** `role.create` на корне конфигурации создаёт дескриптор, пустой
`Rights.xml` и запись в `ChildObjects`. Права — `right.add` на самой роли:

```json
{"op": "right.add", "args": {"items": [
  {"object": "Catalog.Номенклатура", "rights": {"Read": true, "View": true}}]}}
```

После исполнения `unica.view` показывает `totalallowed: 2` и ветвь `Right`,
`unica.check` — `validators: ["role"]`, `passed`. RLS ставится `right.set` на новую
запись тем же планом.

**Перехватчик расширения.** Порядок: процедура без параметров в модуле родителя →
`code.insert` по адресу `…Module.<Роль>.Body` с `&Перед("<Метод>")` в модуле
расширения.

- Вставка в заимствованный объект даёт **две** правки одной транзакцией: модуль
  расширения и `<xr:PropertyState>` с `<xr:Property>ObjectModule</xr:Property>` /
  `<xr:State>Extended</xr:State>` в дескрипторе объекта. Отдельно помечать модуль
  в XML не нужно.
- `unica.diff` с токеном плана показывает обе правки точными байтами.
- `unica.check` на модуле — `validators: ["bsl"]`, `passed`; на корне расширения —
  `validators: ["cfe"]`, `passed`.

**Атомарность.** План из двух операций, где вторая заведомо неверна (например,
`attribute.add` со строкой длиной 5000), отказывает целиком:
`bad_value` + `outcome: fixCall` с полем в сообщении
(`string length must be 0..=1024 and Fixed requires a positive length`).
Первая операция не публикуется — каталога нет ни на диске, ни в `ChildObjects`.

---

## 5. Платформенные операции

Все операции — через `unica.run`; для `previewApply` сначала `dryRun: true`
(план + `taskId`), затем `dryRun: false`. Ожидание задачи — `unica.task.result` by
`taskId`: ответ «Task is still working» штатный, повторять мутацию не нужно.

| Операция | Что делает | Проверено |
|---|---|---|
| `make` (`output: build/out/<Имя>.cf`) | сборка `.cf` из `main` | ok, 105 005 Б, `providerDispatched: true` |
| `infobase.create` | файловая база из исходников `main` | ok, `initializesSources: true` |
| `push` | загрузка наборов в базу | ok; `main` пропущен памятью раннера, `ext` загружен целиком |
| `extensions.list` | список установленных расширений | ok, `Расш1` + `namePrefix`/`purpose`/`active` |
| `make` (`{"extension": "ext"}`) | сборка `.cfe` | ok, 7 033 Б, проверен платформой |
| `download` (`state: database`) | выгрузка `.cf` из базы | **на Windows падает**, см. 5.1 |

`push` по новому набору расширения отказывает, только когда у рабочей копии нет
памяти об этой базе; после `infobase.create` из этой же копии память уже есть, и
`push` проходит без `{"force": true}`. `force: true` нужен, когда база менялась
мимо рабочей копии — он перезаписывает базу целиком.

### 5.1. Известная поломка: `download` на Windows

На 1С 8.3.27.2325 + `v8-runner` 0.15.3 (Windows) операция падает воспроизводимо:

```
platform export failed with exit code 1;
platform log: Файл не обнаружен
'file://\\?\C:\…\build\out\.infobase-config-stage-<pid>-<hash>.cf'.
2(0x00000002): Не удается найти указанный файл.
```

Раннер отдаёт платформе staging-путь в виде `file://\\?\…`, и 1С такую «URL» не
резолвит. Локализация: `make`, `infobase.create`, `push`, `extensions.list`
проходят, лицензия в порядке, а прямой
`1cv8 DESIGNER /F<база> /DumpConfigToFiles <обычный путь>` выгружает конфигурацию
без ошибок. То есть это дефект адаптера на win32, а не платформы и не моста:
выгрузку на Windows делайте Конфигуратором (6.2) либо ждите исправления.

---

## 6. Независимая проверка платформой

Валидаторы Unica не заменяют импорт в базу: сделать это стоит после правок форм и
схем.

### 6.1. `CheckConfig`

```powershell
& 'C:\Program Files\1cv8\8.3.27.2325\bin\1cv8.exe' DESIGNER "/F<база>" /CheckConfig "/Out<лог>"
Start-Sleep -Seconds 15          # лог пишется асинхронно
Get-Content <лог>                # ожидаемо: Ошибок не обнаружено
```

Код возврата бывает ненулевым при «Ошибок не обнаружено» — судите по логу.

### 6.2. `DumpConfigToFiles`

```powershell
& 'C:\...\1cv8.exe' DESIGNER "/F<база>" /DumpConfigToFiles <каталог> "/Out<лог>"
```

В выгрузке должны появиться все объекты исходников (`Catalogs\<Имя>.xml`,
`Reports\<Имя>.xml`, `Roles\<Имя>.xml` …). Это доказательство, что запись в
исходники доехала до базы, а не только до диска.

---

## 7. Лицензия

Признак, который легко принять за дефект порта: `push`/`download` отвечают
`credentials_rejected` («the designer agent rejected the infobase user … user ''»),
хотя база файловая и пользователей в ней нет. Настоящая причина — в `/Out`-логе
платформы:

```
Запуск системы выполнен без использования аппаратной лицензии (ключа защиты).
```

Диагностическое правило: `credentials_rejected` на файловой базе без
пользователей почти всегда означает лицензию, а не логин. После активации те же
вызовы проходят без изменений в проекте.

---

## 8. Расширения

**Корень.** Канонической операции создания корня нет — он пишется файловыми
средствами по навыку `cfe-init`, затем объявляется набором в `v8project.yaml`
(см. 0).

**Каталог расширения должен лежать вне корня родителя.** Вложенный набор
(`src/extension`) `unica.check {}` принимает, но `object.borrow` отвечает
`borrow parent must be a separate non-overlapping source root`. Рабочая
раскладка — `ext/` рядом с `src/`.

> На Windows имя `src/ext` совпадает с каталогом конфигурации `src/Ext`
> (регистронезависимая ФС), поэтому совет навыка «пишите в `src/ext`» на Windows
> опасен вдвойне: файлы попадут в модульный каталог конфигурации, а `borrow` всё
> равно откажет.

**Заимствование.** `object.borrow` на корне расширения с `from` — проверенный
адрес родителя. Ответ содержит `data.borrowing` (`parentUuid`,
`changedProperties`, `protectedOverrides`); после исполнения `unica.view`
показывает `belonging: "borrowed"`, `parentId`, `parentStatus: "resolved"` и
`extends: "main:<Вид>.<Имя>"`.

**Сборка и установка.** `unica.check` на `ext:Configuration` даёт валидатор
`cfe`; `unica.run make` с `{"extension": "ext"}` собирает `.cfe`; `push` ставит
расширение в базу; `unica.run extensions.list` подтверждает:

```json
{"name": "Расш1", "purpose": "customization", "active": true, "safeMode": true,
 "unsafeActionProtection": true, "namePrefix": "Расш1_", "scope": "infobase"}
```

---

## 9. Живучесть задач

`unica.run` создаёт durable Task в общем state root (`$DSH_HOME/unica/provider-state`).
Задача, созданная одним процессом моста, читается `unica.task.get` из другого
процесса и остаётся `completed`. То есть перезапуск DSH не теряет длинные
операции: достаточно сохранить `taskId`, повторять мутацию не нужно.

Полный сценарий с `SIGKILL` моста (проверен на ревизии `0.15.0.3` для macOS)
требует убить живой процесс вместе с сервером unica — на рабочей машине его лучше
не повторять.

---

## 10. Чего нет на поверхности

- **`upload` готового `.cf`/`.cfe`** недоступен в адаптере `v8-runner` 0.15
  (известный пробел
  [#1246](https://github.com/IngvarConsulting/unica/issues/1246)): расширение
  попадает в базу только через `push` источников.
- **Запуск тестов YaXUnit** на поверхности Unica не опубликован: авторинг тестов
  и поиск по ним есть, запуск — отдельный шаг вне инструментов.
