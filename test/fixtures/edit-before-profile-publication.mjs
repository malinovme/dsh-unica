// Run only in the publisher, after the durable intent marker and before its
// final comparison. Simulate an editor saving the profile at that exact point.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const { FIXTURE_PROFILE: profile, FIXTURE_TRANSACTION: transaction, FIXTURE_EDIT: content } = process.env
if (process.argv.includes(profile) && existsSync(join(transaction, 'publishing-profile'))) {
  mkdirSync(dirname(profile), { recursive: true })
  writeFileSync(profile, content)
}
