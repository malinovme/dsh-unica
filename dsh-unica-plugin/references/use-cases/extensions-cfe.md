# Extensions CFE

## When to use

Use this when the user needs to create a configuration extension, validate it,
borrow configuration objects into it, inspect its differences, or generate a
method interceptor.

Do not use this for ordinary metadata object edits in the base configuration.
Use the metadata-modeling reference and `mcp__unica__unica_apply_8ba7af26408e` at the configuration's
addresses for that.

## Primary path

Work through MCP `unica`:

- Creating the extension root: no canonical operation exists; this is a
  contract gap. Write `Configuration.xml` and `Languages/` by the formats in
  the `cfe-init` skill, declare the directory as an `EXTENSION` source-set,
  then confirm admission with `mcp__unica__unica_check_6db7d2a7495f {}`.
- `mcp__unica__unica_check_6db7d2a7495f` on the extension root (`ext:Configuration`, validator `cfe`)
- `mcp__unica__unica_diff_14922c75f4c4` between the extension and configuration sets
- Borrowing a parent object: `mcp__unica__unica_apply_8ba7af26408e` with `object.borrow` at the
  extension root (`cfe-borrow` skill)
- Method interceptors: prepared BSL written by `mcp__unica__unica_apply_8ba7af26408e` with
  `code.insert` or `code.replace` (`cfe-patch-method` and `code-patch`
  skills); a borrowed module's `PropertyState` is updated in the same
  transaction

Runtime export or loading of `.cfe` artifacts goes through `mcp__unica__unica_run_189d01f64719`:
`download` with `extension` writes the `.cfe` from the infobase, and `make`
builds an artifact from sources; each operation is previewed first with
`dryRun: true` and executed with `dryRun: false`. Loading a `.cfe` file
(`upload`) and the separate `apply`/`reset` are unavailable until the runner
supports them ([#1246](https://github.com/IngvarConsulting/unica/issues/1246));
send extension sources with `push` instead.

Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
используй опубликованную `argsSchema`; при `support.state: limited`
разрешено только подмножество `support.supportedArgs`. Недоступной операции
в словаре нет. Для плановой операции сначала проверь результат
`dryRun: true`, затем исполняй запрос с `dryRun: false`. Preview
не фиксирует входы между вызовами. Не обходи контракт прямым runner-ом.

## Related references

- `../specs/1c-extension-spec.md`
- `workspace-runtime.md`
