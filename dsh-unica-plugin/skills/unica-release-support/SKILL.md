---
name: release-support
description: "Поддержка поставки и обновлений 1С. Используй когда нужно проверить сравнение/объединение, поставку, поддержку, расширения, совместимость обновления, миграции данных и release readiness."
---

# Release Support

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_project_map_7cc63b822c1d`, `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_cf_info_3ee6cc7e118b`, `mcp__unica__unica_cfe_diff_3ee597825354`, `mcp__unica__unica_meta_info_524a81764d16`, `mcp__unica__unica_code_diagnostics_43785e27e86c`, `mcp__unica__unica_standards_search_cab77e9c1bda`, `mcp__unica__unica_standards_explain_79d0ab30ea9c`, and `mcp__unica__unica_runtime_execute_0cd62fbc3716`.
- По INV-MCP-RUNTIME-RECEIPT и ADR-0074: `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: true`
показывает запланированную команду без побочных эффектов, а с `dryRun: false`
исполняет классифицированную операцию и отвечает её терминальным результатом в
том же вызове, приложив названную причину риска (`runtime_risk_*`)
предупреждением; неклассифицированная операция по-прежнему отказывает
`runtime_operation_unbounded` до обнаружения рабочего пространства. Preview
исполнением не является. Работу, которую вызов ждать не должен, запускай через
`mcp__unica__unica_runtime_job_start_64e0bb584ac4`. Не обходи контракт прямым runner-ом или через
`unica.build.*`.
- Use `mcp__unica__unica_role_info_7face3da6726`, `mcp__unica__unica_dcs_info_e9d039200abc`, or form/meta tools when release risk is localized to rights, reports, forms, or metadata objects.
- Do not call internal package, metadata, analyzer, standards, or runtime adapters directly. They are hidden behind MCP `unica`.

Support-state checks come from `mcp__unica__unica_cf_info_3ee6cc7e118b` and object-level `mcp__unica__unica_meta_info_524a81764d16`/`mcp__unica__unica_form_info_fd2902463286`/`mcp__unica__unica_dcs_info_e9d039200abc`/`mcp__unica__unica_mxl_info_2bb8861a62b9`/`mcp__unica__unica_role_info_7face3da6726`/`mcp__unica__unica_subsystem_info_57da9ac52ecc`, which read `Ext/ParentConfigurations.bin` through Unica. Treat `Поддержка: на замке` or read-only as a release decision: prefer CFE or an explicit support-state change plan before direct mutation.

## References

- Read `../../references/platform/compatibility-modes.md` when an upgrade, migration,
  configuration, or extension change depends on a compatibility mode.
- Read `../../references/platform/platform-mechanics.md` for platform behavior that affects compatibility and runtime risk.
- Read `../../references/platform/integration-contracts.md` when release changes public integration/API behavior.
- Read `../../references/use-cases/code-quality-review.md` for Findings first review output.

## Workflow

1. Identify release scope: vendor update, extension change, merge branch, support-state change, hotfix, migration, or integration contract change.
2. Map source-sets with `mcp__unica__unica_project_map_7cc63b822c1d`; inspect configuration and extensions with `mcp__unica__unica_cf_info_3ee6cc7e118b`, `mcp__unica__unica_cfe_diff_3ee597825354`, `mcp__unica__unica_meta_info_524a81764d16`, and `mcp__unica__unica_code_search_70af4c0986a7`.
3. List compatibility risks: metadata rename/delete, changed roles, changed integration contracts, data migrations, scheduled jobs, query behavior, BSP hooks, and extension interceptors.
4. Run `mcp__unica__unica_code_diagnostics_43785e27e86c`; then use `mcp__unica__unica_runtime_execute_0cd62fbc3716` only to preview typed syntax/test/build/update arguments and record all runtime checks as unverified unless separate evidence is supplied.
5. Produce a release readiness note: blocking findings, migration steps, rollback boundary, manual checks, and Unica MCP contract gaps.

## Review checklist

- Поставка и поддержка are explicit release decisions, not hidden in generated churn.
- Public APIs and exchange contracts remain backward compatible or have a migration note.
- Extension interceptors still bind to borrowed methods after update.
- Data migrations are idempotent and restartable.
- Tests cover changed business paths, integration paths, and update-only paths.

## Stop rules

- Do not mark release ready when syntax/tests/update checks were not run; say exactly what is missing.
- Do not hide compatibility risk behind a generic code review. Lead with blocking release findings.
