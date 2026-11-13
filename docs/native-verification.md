# Проверка установки native-режима

Минимальный сценарий: **только то, что обязано пройти, если плагин установлен
правильно**. Ни одна проверка здесь не зависит от версии платформы 1С, лицензии
или содержимого проекта — только от самого моста, рантайма и профиля DSH.

Проверка делится на две части: **автоматическую** (пара минут, без DSH-сессии) и
**живую** (в DSH). Автоматика ловит поломки установки и рантайма, живая — то, что
она проверить не может: что мост берёт каталог именно из этой сессии.

Всё ниже пройдено на DSH Desktop 0.2.2-rc.3 (Windows), Unica 0.15.0-rc.5,
`v8-runner` 0.15.3 и порте `0.15.0.3`. Общая длина — около 10 минут, не считая
первого (холодного) запуска рантайма.

> Платформенные операции — сборка `.cf`/`.cfe`, загрузка в базу, формы, СКД,
> расширения, роли, перехватчики — сюда намеренно **не входят**: им нужна
> установленная 1С и подходящий проект. Это отдельный сценарий:
> [platform-verification.md](platform-verification.md).

---

## 0. Чек-лист

| # | Шаг | Где |
|---|---|---|
| 1 | `node host/selftest.js --cwd <проект>` → `ok: true`, `tools: 11` | терминал |
| 2 | `node install.mjs --verify --dsh-home <временный каталог>` → `native check : ok … 11 tools …` | терминал |
| 3 | `node tools/check-tool-names.mjs` → все ссылки резолвятся | терминал |
| 4 | В патче профиля `unica-native` есть, `mcp-unica` нет | файл профиля |
| 5 | `unica.view` по адресу `main:Configuration` — это проект сессии | DSH |
| 6 | Две сессии в разных каталогах → разные проекты и разные результаты `unica.search` | DSH |

Шесть зелёных — native-режим установлен и работает.

---

## 1. Автоматическая часть

Все команды — из каталога `dsh-unica-plugin/`.

### 1.1. Мост без DSH

```sh
node host/selftest.js --cwd /путь/к/проекту
```

Ожидаемый вывод (форма ответа этой ревизии):

```json
{
  "ok": true,
  "cwd": "/путь/к/проекту",
  "root": "/путь/к/проекту",
  "workspace": "matched",
  "tools": 11,
  "ms": 592,
  "server": { "name": "unica", "version": "0.15.0-rc.5" }
}
```

- `ok: true` — unica поднялась и отвечает каталогом;
- `tools: 11` — каталог инструментов на месте;
- `root` — `workspaceRoot`, который вернул `unica.view {}`; для каталога, который
  unica не принимает за проект (например, `C:\Windows\System32`), `root` может
  отсутствовать, а `workspace` будет `not reported` — это **не** дефект;
- `workspace: mismatched` — единственное плохое значение: мост поднял unica не в
  том каталоге;
- `ms` — время старта: сотни миллисекунд на тёплом кэше, секунды на холодном.

### 1.2. Два каталога одновременно

Мост не должен смешивать каталоги: у каждого процесса свой `root`.

```sh
# POSIX
node host/selftest.js --cwd /путь/к/проекту-А &
node host/selftest.js --cwd /путь/к/проекту-Б &
wait
```

```powershell
# Windows — из каталога плагина
Start-Job { Set-Location C:\путь\dsh-unica-plugin; node host/selftest.js --cwd C:\путь\проект-А }
Start-Job { Set-Location C:\путь\dsh-unica-plugin; node host/selftest.js --cwd C:\путь\проект-Б }
Get-Job | Wait-Job | Receive-Job
Get-Job | Remove-Job
```

У каждого — свой `root`, совпадающий со своим `cwd`.

### 1.3. Установщик

```sh
node install.mjs --dry-run                 # только план, ничего не пишет
node install.mjs --verify --dsh-home /tmp/dsh-check --verify-cwd /путь/к/проекту
```

Ожидаемо во втором:

```
  native check  :
    ok      serverInfo unica 0.15.0-rc.5, 11 tools in 3801 ms, workspace /путь/к/проекту
```

`--dsh-home` здесь важен: `--verify` **без** `--dry-run` переписывает патч профиля и
привязывает `pluginRoot` к тому каталогу, из которого запущен `install.mjs`. Для
повторной проверки уже установленного профиля берите одноразовый `--dsh-home`;
живой профиль трогайте только при установке (раздел 2).

Если `--verify` пишет `FAIL`, см. раздел 5.

### 1.4. Проверки самого порта

```sh
node tools/check-tool-names.mjs   # 679 ссылок в навыках, 11 имён, все резолвятся
node tools/ci-dryrun.mjs          # патч → композиция DSH → миграция → платформа
```

`check-tool-names` должен закончиться `names: every reference resolves`,
`ci-dryrun` — `CI job dry-run passed: every installer step behaves as the workflow
expects`. В хвосте `ci-dryrun` печатается трейс от негативного теста
(`--platform freebsd`) — это ожидаемо, важен итоговый `passed`.

---

## 2. Установка в рабочий профиль

```sh
# DSH Desktop
node install.mjs --target preset --profile desktop --verify

# Web GUI / headless
node install.mjs --target both --verify
```

Установщик пишет в патч профиля строку `unica-native` с `file://`-URL на
`host/index.js` и удаляет легаси-строку `mcp-unica`, если она была.

Проверить содержимое патча (путь зависит от профиля):

```sh
grep -n "unica-native\|mcp-unica" ~/.dsh/profiles/desktop/cordis.patch.yml
grep -n "unica-native\|mcp-unica" ~/.dsh/profiles/headless/cordis.patch.yml
```

Ожидание: строки `unica-native` есть, `mcp-unica` — **нет** (иначе два источника
зарегистрируют одинаковые имена).

> `dsh --profile desktop --dump-config` намеренно отказывает («managed exclusively
> by the Electron application»), поэтому desktop-профиль проверяется по файлу и
> живой сессией. Для `web`/`headless` можно и так:
> `dsh --profile headless --dump-config | grep -A3 unica-native`.

**Перезапустите DSH** — патч профиля читается при старте — и откройте новую
сессию на пресете **«Unica 1C»**.

---

## 3. Живая проверка в DSH

### 3.1. Один проект

Откройте сессию в каталоге проекта (любого, где есть `v8project.yaml` и
`src/Configuration.xml`) и попросите:

> Вызови `unica.view` с `{"at": "main:Configuration"}` и покажи `data.props.name`.

Ожидание: `ok: true` и имя конфигурации **этого** проекта — не соседнего и не
`~/.dsh/profiles/...`. Если каталог сессии — не 1С-проект (нет `v8project.yaml` и
`src/Configuration.xml`), ответ будет `invalid_state: no PlatformXml source set is
admitted` — это верный ответ, а не поломка; для живой проверки нужен проект.

Полное доказательство каталога — вызов `unica.view {}` (`workspaceRoot`,
`workspaceRootOrigin.channel = launchCwd`, `requestedDirectory` = каталог сессии).
Он же выполняется в `selftest` из 1.1. В сессии не всякая сборка DSH умеет
отправить инструмент вообще без аргументов: тогда вызов приходит с `at: ""` и
отвечает `canonical invocation address argument 'at' is invalid`. Это ограничение
слоя инструментов, а не моста — для приёмки достаточно `unica.check` и `unica.view`
по адресу.

### 3.2. Два проекта — главная проверка

1. Создайте **две сессии** DSH в двух разных каталогах (проект А и проект Б).
2. В каждой выполните `unica.view {"at": "main:Configuration"}`.
3. Сравните `data.props.name`: у А — конфигурация А, у Б — конфигурация Б,
   одновременно.

Затем — поиск по своей кодовой базе. В каждой сессии:

> Вызови `unica.search` с `{"query": "<символ, который есть только в этом проекте>", "corpus": "text"}`
> (или `"corpus": "names"`, если искать по именам метаданных) и покажи, что нашлось.

Ожидание: в сессии А находятся только файлы А, в сессии Б — только Б. Если
символа в проекте нет вовсе, `corpus: "names"` может вернуть `approximate: true` с
пометкой `nearest:name` — это не совпадение по имени.

### 3.3. Инструменты, которые обязаны отвечать

| Вызов | Ожидание |
|---|---|
| `unica.check` на `main:Configuration` | `status: passed`, `validators: ["cf"]` (или реальные нарушения — это тоже ответ) |
| `unica.check` на модуле (`main:…Module.<Роль>`) | `validators: ["bsl"]`, `passed` или реальные нарушения |
| `unica.search` (`text` и `names`) | файлы и узлы **этого** проекта |
| `unica.docs` с любым вопросом | `ok: true`; может вернуть `task` → дочитать через `unica.task.result` |
| `unica.resolve` по пути из `grep` | логический адрес этого проекта |
| `unica.diff` двух узлов | `equal: false` и `changes` (для разных узлов) |

### 3.4. Запись: план → токен → публикация

Единственная операция записи в этом сценарии; она не требует платформы и
доказывает, что `unica.apply` работает целиком.

1. `unica.apply` с `{"at": "main:Configuration", "ops": [{"op": "object.create",
   "args": {"values": {"kind": "Catalog", "name": "<Имя>"}}}]}` — вернул
   `data.executionToken`, **на диске ничего не изменилось**.
2. `unica.diff` по `executionToken` — видно, какие файлы появятся.
3. `unica.apply` только с `executionToken` — публикация: появились
   `src/Catalogs/<Имя>.xml` и `src/Catalogs/<Имя>/Ext/ObjectModule.bsl`, объект
   виден в `unica.view` и в `<ChildObjects>` корня.
4. `unica.check` по объекту — `validators: ["meta"]`, `passed`.
5. Уберите объект: `unica.apply` с `{"at": "main:Catalog.<Имя>"}` и операцией
   `object.remove` — адрес объекта задаёт `at` самого вызова, у операции
   обязательных аргументов нет.

Перед незнакомой операцией читайте её контракт:
`unica.view {"at": "<узел>.Can.<операция>"}`. Схема типов в `rc.5` — например,
число: `{"kind": "number", "digits": 15, "fraction": 2, "sign": "any"}`.

### 3.5. Пул процессов (по желанию)

```sh
# POSIX (macOS: lsof вместо /proc)
pgrep -f "bootstrap/launch.mjs" | while read p; do
  printf "%s " "$p"; lsof -a -p "$p" -d cwd | tail -1 | awk '{print $NF}'
done
```

```powershell
# Windows: каталог процесса так не читается, но число процессов видно
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*launch.mjs*' } | Select-Object ProcessId
```

Ожидание: по процессу на каждый каталог, в котором реально работали; после
`idleMs` (10 минут) без вызовов процессы завершаются.

---

## 4. Критерии приёмки

| # | Проверка | Проходит, если |
|---|---|---|
| 1 | `host/selftest.js` | `ok: true`, `tools: 11`, `root === cwd`, `workspace !== mismatched` |
| 2 | `install.mjs --verify` | `native check : ok … 11 tools … workspace …` (для повторной проверки — с `--dsh-home`) |
| 3 | Патч профиля | `unica-native` есть, `mcp-unica` нет |
| 4 | Одна сессия | `unica.view` по адресу отдаёт конфигурацию этой сессии |
| 5 | Две сессии | разные проекты одновременно, разные результаты `unica.search` |
| 6 | `unica.check` | `passed` или реальные нарушения, но не ошибка транспорта |
| 7 | `unica.apply` | план без записи → токен → публикация → `["meta"]`, `passed` |
| 8 | Процессы | по процессу на каталог, простой завершается |

---

## 5. Диагностика

**Инструментов `mcp__unica__*` нет в сессии.**

1. `dsh --version` — нужен DSH 0.2.2-rc.1 или новее (мосту нужен сервис
   `ctx.workingDirectory`).
2. `grep -n "unica-native" ~/.dsh/profiles/<профиль>/cordis.patch.yml` — строка есть?
3. Запустите `node host/selftest.js --cwd /каталог` — если он падает, проблема не в
   DSH, а в рантайме/кэше.
4. Перезапустите DSH: патч профиля читается только при старте.

**`unica.view` возвращает чужой каталог.**

Сессия открыта не там, где вы думаете: выполните `pwd` инструментом `pwsh` (или
`bash`) в той же сессии. Мост берёт каталог из `ctx.workingDirectory` сессии, а не
из процесса DSH. Если `pwd` верный, а `unica.view` показывает другой проект —
проверьте, что в сессии не сделан `cd` в другой каталог (мост следует за сессией
и поднимает для нового каталога свой процесс).

**Дубли инструментов / два набора.**

В патче осталась строка `mcp-unica`. Удалите её (установщик `0.15.0.3` делает это
сам при установке) и перезапустите DSH.

**Правки в чекауте не видны в сессии.**

Профиль грузит **копию** плагина, записанную в `pluginRoot` патча (обычно
`~/AppData/Local/unica-plugin` на Windows или `~/.dsh/...`), а не текущий чекаут.
После изменений в репозитории переустановите плагин и перезапустите DSH.

**`open daemon provider state root: Not a directory (os error 20)`.**

Unica не принимает state root, в пути которого остался симлинк (классика — macOS
`/tmp` → `/private/tmp`), либо каталог недоступен. Установщик и мост
канонизируют пути; если ошибка осталась — перенесите кэш в реальный путь:
`node install.mjs --cache-dir ~/.dsh/unica-native-cache --verify`.

**`native check` падает на холодном кэше.**

Первый запуск скачивает рантайм; бюджет на холодный кэш — 30 минут. Повторите
`--verify`: скачанное сохраняется.

**`verify-install.mjs` падает на Desktop.**

Ревизия `0.15.0.3` находит чанк `dump-config-*` в `app.asar` по имени; если
падает — проверьте `dsh --version` и пересоберите установку из текущей ветки.
