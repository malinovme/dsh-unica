---
name: security-auth-crypto
description: "Безопасная аутентификация и криптография 1С. Используй когда нужно спроектировать или диагностировать OpenID, сертификаты, CryptoPro, TLS, роли, секреты и auth для интеграций."
---

# Security Auth Crypto

## MCP routing

- Preferred path: use MCP `unica` tools `mcp__unica__unica_project_map_7cc63b822c1d`, `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_meta_info_524a81764d16`, `mcp__unica__unica_role_info_7face3da6726`, `mcp__unica__unica_code_diagnostics_43785e27e86c`, `mcp__unica__unica_standards_search_cab77e9c1bda`, `mcp__unica__unica_standards_explain_79d0ab30ea9c`, and `mcp__unica__unica_runtime_execute_0cd62fbc3716`.
- По INV-MCP-RUNTIME-RECEIPT и ADR-0074: `mcp__unica__unica_runtime_execute_0cd62fbc3716` с `dryRun: true`
показывает запланированную команду без побочных эффектов, а с `dryRun: false`
исполняет классифицированную операцию и отвечает её терминальным результатом в
том же вызове, приложив названную причину риска (`runtime_risk_*`)
предупреждением; неклассифицированная операция по-прежнему отказывает
`runtime_operation_unbounded` до обнаружения рабочего пространства. Preview
исполнением не является. Работу, которую вызов ждать не должен, запускай через
`mcp__unica__unica_runtime_job_start_64e0bb584ac4`. Не обходи контракт прямым runner-ом или через
`unica.build.*`.
- Use integration and autonomous-server skills when auth behavior must be verified through HTTP service or web-client runtime.
- Do not call internal analyzer, standards, runtime, or package adapters directly. They are hidden behind MCP `unica`.

## References

- Read `../../references/platform/integration-contracts.md` for auth contract, secret handling, retry behavior, and error semantics.
- Read `../../references/platform/platform-mechanics.md` for client/server crypto boundary, rights, OpenID, certificates, and temporary secret handling.
- Read `../../references/platform/runtime-diagnostics.md` for startup/auth/runtime evidence.

## Workflow

1. Identify the trust boundary: user login, service account, external API, OpenID provider, certificate store, CryptoPro provider, TLS endpoint, or file/key storage.
2. Inspect existing auth and role paths with `mcp__unica__unica_code_search_70af4c0986a7`, `mcp__unica__unica_meta_info_524a81764d16`, and `mcp__unica__unica_role_info_7face3da6726`.
3. Define secret lifecycle: source, storage, rotation, masking, runtime process user, test fixture policy, and log redaction.
4. Define auth error semantics: missing credentials, expired token, invalid certificate, provider unavailable, denied rights, tenant mismatch, and remote auth failure.
5. Verify statically with `mcp__unica__unica_code_diagnostics_43785e27e86c`; use `mcp__unica__unica_runtime_execute_0cd62fbc3716` to preview typed syntax/test arguments and, with `dryRun: false`, to run them and report runtime behavior as unverified.

## Review checklist

- Secrets and private keys are not committed, logged, or echoed in final output.
- Certificate/OpenID/CryptoPro behavior states platform version, OS/process user, store location, and client/server boundary.
- Rights checks are explicit and audited with `mcp__unica__unica_role_info_7face3da6726` when metadata rights matter.
- Integration auth failures are distinguishable from validation and business failures.
- Temporary files with sensitive data have clear cleanup and access boundaries.

## Contract gaps

If public MCP `unica` cannot inspect the needed role, runtime, certificate, or auth artifact, report a Unica MCP contract gap instead of bypassing the public boundary.
