---
name: background-jobs
description: "Фоновые и регламентные задания 1С. Используй когда нужно спроектировать, проверить или диагностировать background jobs, расписания, очереди, зависания, retry-логику и журналирование."
---

# Background Jobs

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_view_6f3a42290cc8 {}`, `mcp__unica__unica_search_a8644a757dff`, `mcp__unica__unica_view_6f3a42290cc8` on the object node, `mcp__unica__unica_check_6db7d2a7495f`, `mcp__unica__unica_docs_fd15d9ecf894`, and `mcp__unica__unica_run_189d01f64719`.
- Runtime идёт через `mcp__unica__unica_run_189d01f64719`: вызов без `op` отдаёт словарь операций и
контракт каждой — `argsSchema`, `execution`, `previewRequired`,
`dryRunRequired`. Контракт вызова бери оттуда, а не из этого текста;
при `implemented: true` используй опубликованную `argsSchema`; при
`support.state: limited` разрешено только подмножество `support.supportedArgs`.
При `support.state: unavailable` остановись; не выдумывай аргументов при
`argsSchema: null`. Для плановой операции сначала проверь результат `dryRun: true`,
затем исполняй запрос с `dryRun: false`. Preview не фиксирует входы между
вызовами. Не обходи контракт прямым runner-ом.
- Use `mcp__unica__unica_view_6f3a42290cc8` on the role node when job behavior depends on user context or permissions.
- Do not call internal runtime, analyzer, standards, or package adapters directly. They are hidden behind MCP `unica`.

## References

- Read `../../references/platform/platform-mechanics.md` for background job context, temporary storage, and security boundaries.
- Read `../../references/platform/transactions-locks.md` when the job reads and then writes shared state; this skill keeps only job restartability.
- Read `../../references/platform/runtime-diagnostics.md` when the task includes ЖР/ТЖ, hangs, retries, or process/session evidence.

## Workflow

1. Identify job type: scheduled job, background job launched from code, queue worker, exchange worker, or deferred integration retry.
2. Find entry points with `mcp__unica__unica_search_a8644a757dff`; inspect related metadata with `mcp__unica__unica_view_6f3a42290cc8` on the object node and project layout with `mcp__unica__unica_view_6f3a42290cc8 {}`.
3. Define execution contract: parameters, user context, transaction scope, idempotency key, lock strategy, timeout, retry count, and logging fields.
4. Check failure behavior before implementation: duplicate launch, partial write, stale lock, external service failure, session termination, and restart after crash.
5. Run `mcp__unica__unica_check_6db7d2a7495f` on the module node; launch a client through `mcp__unica__unica_run_189d01f64719` (`launch`) when the diagnosis needs one, and record runtime verification as unavailable unless separate evidence is supplied: test runs are outside the v0.13 surface.
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
