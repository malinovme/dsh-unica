---
name: background-jobs
description: "Фоновые и регламентные задания 1С. Используй когда нужно спроектировать, проверить или диагностировать background jobs, расписания, очереди, зависания, retry-логику и журналирование."
---

# Background Jobs

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_project_map_7cc63b822c1d`, `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_meta_info_524a81764d16`, `mcp__unica__unica_code_diagnostics_43785e27e86c`, `mcp__unica__unica_standards_search_cab77e9c1bda`, `mcp__unica__unica_standards_explain_79d0ab30ea9c`, and `mcp__unica__unica_runtime_execute_0cd62fbc3716`.
- По INV-MCP-RUNTIME-RECEIPT и ADR-0074: `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: true`
показывает запланированную команду без побочных эффектов, а с `dryRun: false`
исполняет классифицированную операцию и отвечает её терминальным результатом в
том же вызове, приложив названную причину риска (`runtime_risk_*`)
предупреждением; неклассифицированная операция по-прежнему отказывает
`runtime_operation_unbounded` до обнаружения рабочего пространства. Preview
исполнением не является. Работу, которую вызов ждать не должен, запускай через
`mcp__unica__unica_runtime_job_start_64e0bb584ac4`. Не обходи контракт прямым runner-ом или через
`unica.build.*`.
- Use `mcp__unica__unica_role_info_7face3da6726` when job behavior depends on user context or permissions.
- Do not call internal runtime, analyzer, standards, or package adapters directly. They are hidden behind MCP `unica`.

## References

- Read `../../references/platform/platform-mechanics.md` for background job context, temporary storage, and security boundaries.
- Read `../../references/platform/transactions-locks.md` when the job reads and then writes shared state; this skill keeps only job restartability.
- Read `../../references/platform/runtime-diagnostics.md` when the task includes ЖР/ТЖ, hangs, retries, or process/session evidence.

## Workflow

1. Identify job type: scheduled job, background job launched from code, queue worker, exchange worker, or deferred integration retry.
2. Find entry points with `mcp__unica__unica_code_search_70af4c0986a7`; inspect related metadata with `mcp__unica__unica_meta_info_524a81764d16` and project layout with `mcp__unica__unica_project_map_7cc63b822c1d`.
3. Define execution contract: parameters, user context, transaction scope, idempotency key, lock strategy, timeout, retry count, and logging fields.
4. Check failure behavior before implementation: duplicate launch, partial write, stale lock, external service failure, session termination, and restart after crash.
5. Run `mcp__unica__unica_code_diagnostics_43785e27e86c`; use `mcp__unica__unica_runtime_execute_0cd62fbc3716` to preview typed syntax/test/launch arguments and, with `dryRun: false`, to run it, and record runtime verification as unavailable unless separate evidence is supplied.
6. For diagnosis, build a timeline from ЖР/ТЖ and map the first failure back to module code.

## Review checklist

- Job can be safely restarted or retried.
- Long work is split or checkpointed.
- Logs use structured logging fields: job id, parameters summary, correlation id,
  retry count, result, and sanitized error context, but no secrets.
- Shared state a job reads and then writes is handled per `transactions-locks`,
  and the lock does not block unrelated users or tenants.
- Failure paths distinguish retryable and permanent errors.

## Contract gaps

If public MCP `unica` cannot inspect schedules, active jobs, lock state, or runtime artifacts needed for the task, report a Unica MCP contract gap with the missing operation.
