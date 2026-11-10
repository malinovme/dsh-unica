# Rights And Access

## When to use

Use this when the user needs to inspect, create, validate, or audit roles,
object rights, RLS restrictions, templates, or least-privilege access for code
that touches metadata objects.

Do not use this for OS/user administration or infobase authentication recovery.
Use `db-auth-check` only to classify already supplied credential/license
evidence; it does not probe the infobase.

- Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
используй опубликованную `argsSchema`; при `support.state: limited`
разрешено только подмножество `support.supportedArgs`. Недоступной операции
в словаре нет. Для плановой операции сначала проверь результат
`dryRun: true`, затем исполняй запрос с `dryRun: false`. Preview
не фиксирует входы между вызовами. Не обходи контракт прямым runner-ом.

## Primary path

Use the canonical role operations through MCP `unica` (skill `role-edit`):

- `mcp__unica__unica_view_6f3a42290cc8` on the role node and its `Right` branch
- `mcp__unica__unica_apply_8ba7af26408e` with `role.create` at `<set>:Configuration`, `right.add` on the
  role and `right.set` on a role entry; preview first, then execute the saved
  plan by `executionToken`
- `mcp__unica__unica_check_6db7d2a7495f` on the role node (validator `role`)

When code changes require new rights, inspect the touched metadata objects and
grant focused rights per object rather than broad typical sets.

## Related references

- `../specs/1c-role-spec.md`
- `../platform/development-standards.md`
