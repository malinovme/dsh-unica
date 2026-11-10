# Code Quality, Review, Refactoring, And Performance

## When to use

Use this when the user asks for code review, refactoring, error fixing,
performance optimization, or standards compliance in BSL code.
Use `api-design` for public API, service interface, overridable module,
versioning, or backward compatibility decisions.

Do not use this as a replacement for metadata or runtime tools. Use it together
with object-specific info tools, source search, syntax checks, and focused tests.

## Primary path

Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
используй опубликованную `argsSchema`; при `support.state: limited`
разрешено только подмножество `support.supportedArgs`. Недоступной операции
в словаре нет. Для плановой операции сначала проверь результат
`dryRun: true`, затем исполняй запрос с `dryRun: false`. Preview
не фиксирует входы между вызовами. Не обходи контракт прямым runner-ом.

- Inspect metadata shape with `mcp__unica__unica_view_6f3a42290cc8` on the object node before changing code that
  depends on objects, forms, roles, or reports.
- Use code search/analysis tools through MCP `unica` where available.
- Check syntax with `mcp__unica__unica_check_6db7d2a7495f`; test runs are outside the v0.13 surface,
  so never claim YaXUnit or Vanessa Automation results without separate
  execution evidence.
- Report findings first for reviews, ordered by severity and grounded in file
  references.

## Standards to apply

- Business logic belongs in common modules unless the form lifecycle requires a
  form module.
- Avoid query-in-loop, unnecessary server round trips, hidden broad rights, and
  unbounded selections.
- Keep refactors test-first: write a reproducing test and confirm that it fails
  for the defect before changing the code. Then map callers, make the smallest
  coherent fix, check syntax with `mcp__unica__unica_check_6db7d2a7495f` as a separate static check,
  and retain explicit residual runtime risk.

## Related references

- `../platform/development-standards.md`
- `../platform/platform-solutions.md`
- `forms-ui.md`
- `rights-access.md`
